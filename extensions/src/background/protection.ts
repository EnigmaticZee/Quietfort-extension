// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Malware / phishing / scam protection at runtime:
//  - the hashed host set of every enabled protection list (hostset.ts), built
//    from the per-list fingerprints in IndexedDB and cached there too, so a
//    restarted service worker reloads it in milliseconds instead of re-parsing;
//  - the DNR host set (Chrome, Safari): lists small enough for DNR rules
//    (installed by dnr-apply.ts);
//  - the navigation guard (Chrome, Safari) for hosts only in the hashed set;
//  - "continue anyway" from the warning page (blocked.html).
// Firefox checks the hashed set in its blocking webRequest listener.

import { B, E2E, PLATFORM, log } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import {
  buildProtectionSet, chooseDnrLists, CONTINUE_FIRST_ID, CONTINUE_SLOTS, SAFARI_CONTINUE_SLOTS, continueRule, GUARD_FIRST_ID, GUARD_SLOTS, guardRules, parseHostsList,
  warningUrl,
} from '../shared/protection.ts';
import type { ProtectionSet } from '../shared/protection.ts';
import { HostSet } from '../shared/hostset.ts';
import type { FingerprintList, HostSetData } from '../shared/hostset.ts';
import { disabledSites, isDisabledIn, onInvalidate, sources } from './state.ts';
import type { ListSource, StoredList } from './state.ts';
import { idbGet, idbSet } from './idb.ts';
import { loadFingerprints, textKey, USES_DNR } from './protection-store.ts';
import { addBlocked } from './counts.ts';
import { recordBlocked } from './tabdata.ts';

const SET_KEY = 'hostset';

interface StoredSet extends HostSetData {
  version: string;
}

export interface HostSetStats {
  /** Where the current set came from: built from fingerprints, or reloaded from IndexedDB. */
  source: 'built' | 'idb' | 'empty';
  ms: number;
  hosts: number;
  bytes: number;
  counts: Record<string, number>;
  /** Lists also installed as DNR rules (Chrome, Safari). */
  dnrLists: string[];
  at: number;
}

let hostSet: HostSet | null = null;
let hostSetPromise: Promise<HostSet> | null = null;
let stats: HostSetStats | null = null;
let setPromise: Promise<ProtectionSet> | null = null;

onInvalidate(() => {
  hostSet = null;
  hostSetPromise = null;
  setPromise = null;
});

interface Plan {
  srcs: ListSource[];
  records: Record<string, StoredList | undefined>;
  /** Hashed-set list order: DNR lists first (so a DNR-covered host always reports a DNR list). */
  order: string[];
  dnrLists: string[];
  version: string;
}

async function plan(): Promise<Plan> {
  const srcs = (await sources()).filter((s) => s.kind === 'protection');
  const stored = srcs.length ? await B.storage.local.get(srcs.map((s) => `list:${s.id}`)) : {};
  const records: Plan['records'] = {};
  for (const s of srcs) {
    const r = stored[`list:${s.id}`] as StoredList | undefined;
    records[s.id] = r?.protection && r.url === s.url ? r : undefined;
  }
  const dnrLists = USES_DNR
    ? chooseDnrLists(srcs.map((s) => ({ id: s.id, hosts: records[s.id]?.protection?.hosts ?? 0, text: !!records[s.id]?.protection?.text })))
    : [];
  const order = [...dnrLists, ...srcs.map((s) => s.id).filter((id) => !dnrLists.includes(id) && records[id])];
  const version = JSON.stringify(order.map((id) => [id, records[id]?.protection?.digest, records[id]?.protection?.bytes]));
  return { srcs, records, order, dnrLists, version };
}

/** The hashed set of all enabled protection lists. */
export function getHostSet(): Promise<HostSet> {
  if (hostSet) return Promise.resolve(hostSet);
  if (!hostSetPromise) {
    hostSetPromise = (async () => {
      const t0 = performance.now();
      const p = await plan();
      const cached = await idbGet<StoredSet>(SET_KEY).catch(() => undefined);
      let set: HostSet | null = null;
      let source: HostSetStats['source'] = 'idb';
      if (cached && cached.version === p.version) {
        try {
          set = new HostSet(cached);
        } catch (err) {
          log('stored host set unusable, rebuilding', String(err));
        }
      }
      if (!set) {
        const lists: Array<{ id: string; fp: FingerprintList }> = [];
        for (const id of p.order) {
          const fp = await loadFingerprints(id);
          if (fp) lists.push({ id, fp });
        }
        set = HostSet.build(lists);
        source = lists.length ? 'built' : 'empty';
        await idbSet(SET_KEY, { ...set.data(), version: p.version } satisfies StoredSet).catch((err) => log('host set not stored', String(err)));
      }
      const counts: Record<string, number> = {};
      set.ids.forEach((id, i) => (counts[id] = set!.counts[i] ?? 0));
      stats = { source, ms: Math.round(performance.now() - t0), hosts: set.size, bytes: set.bytes, counts, dnrLists: p.dnrLists, at: Date.now() };
      log(`protection: ${set.size} hosts (${(set.bytes / 1e6).toFixed(1)} MB) ${source === 'idb' ? 'reloaded' : 'built'} in ${stats.ms} ms`, counts);
      hostSet = set;
      return set;
    })().catch((err) => {
      hostSetPromise = null;
      throw err;
    });
  }
  return hostSetPromise;
}

/** Drop the in-memory set and load it again (IndexedDB): the cost of a service-worker restart. */
export async function reloadHostSet(): Promise<HostSetStats | null> {
  hostSet = null;
  hostSetPromise = null;
  await getHostSet();
  return stats;
}

export function hostSetSync(): HostSet | null {
  return hostSet;
}

export function hostSetStats(): HostSetStats | null {
  return stats;
}

/** Hosts of the lists that become DNR rules (Chrome, Safari; empty on Firefox). */
export function getProtectionSet(): Promise<ProtectionSet> {
  if (!setPromise) {
    setPromise = (async () => {
      const p = await plan();
      const keys = p.dnrLists.map(textKey);
      const stored = keys.length ? await B.storage.local.get(keys) : {};
      const t0 = Date.now();
      const lists = p.dnrLists.map((id) => ({ id, hosts: parseHostsList((stored[textKey(id)] as string | undefined) ?? '') }));
      const set = buildProtectionSet(lists);
      log(`protection DNR: ${set.total} hosts in ${Date.now() - t0} ms`, set.counts);
      return set;
    })().catch((err) => {
      setPromise = null;
      throw err;
    });
  }
  return setPromise;
}

export function warningPageUrl(): string {
  return B.runtime.getURL('blocked.html');
}

// ---------- continue anyway ----------

/** tabId → hosts the user chose to visit anyway (Firefox; cache of the session rules elsewhere). */
const allowedByTab = new Map<number, Set<string>>();

const hostIn = (host: string, h: string) => host === h || host.endsWith(`.${h}`);

export function isAllowedInTab(tabId: number, host: string): boolean {
  const s = allowedByTab.get(tabId);
  if (!s) return false;
  for (const h of s) if (hostIn(host, h)) return true;
  return false;
}

/**
 * Where "continue anyway" and navigation-guard rules live. Chrome: session rules.
 * Safari: dynamic rules, because Safari compiles each rule set into its own content
 * rule list and an allow rule in one list cannot override a block in another (the
 * protection blocks are dynamic rules). They are cleared on browser start.
 */
const IN_DYNAMIC = PLATFORM === 'safari';

/** Diagnostics (tests): continue / guard decisions. */
export const protDebug: Array<Record<string, unknown>> = [];
const dbg = (e: Record<string, unknown>) => {
  if (!E2E) return;
  protDebug.push({ at: Date.now(), ...e });
  if (protDebug.length > 60) protDebug.shift();
};

async function sessionRules(first: number, slots: number): Promise<chrome.declarativeNetRequest.Rule[]> {
  const all = IN_DYNAMIC ? await B.declarativeNetRequest.getDynamicRules() : await B.declarativeNetRequest.getSessionRules();
  return all.filter((r) => r.id >= first && r.id < first + slots);
}

function updateTempRules(opts: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void> {
  return IN_DYNAMIC ? B.declarativeNetRequest.updateDynamicRules(opts) : B.declarativeNetRequest.updateSessionRules(opts);
}

const hasSessionRules = () => USES_DNR && (IN_DYNAMIC || typeof B.declarativeNetRequest?.updateSessionRules === 'function');

/** Safari, browser start: the previous session's continue / guard rules (dynamic rules persist). */
export async function clearTempProtectionRules(): Promise<void> {
  if (!IN_DYNAMIC) return;
  dbg({ ev: 'clearTemp' });
  const ids = [...(await sessionRules(CONTINUE_FIRST_ID, CONTINUE_SLOTS)), ...(await sessionRules(GUARD_FIRST_ID, GUARD_SLOTS))].map((r) => r.id);
  if (ids.length) await B.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  await B.storage.session.remove('continuedHosts').catch(() => undefined);
}

let continuedLoaded: Promise<void> | null = null;

/**
 * Safari: hosts the user continued to, for the rest of the browser session in every tab.
 * Safari's tab ids change when a tab moves between the extension's warning page and a web
 * page (and its background may be a fresh instance per event), so per-tab state cannot be
 * kept there. Read from storage.session on every check.
 */
async function safariContinuedHosts(): Promise<string[]> {
  try {
    return ((await B.storage.session.get('continuedHosts')).continuedHosts as string[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/** Also true after a service-worker restart: the session allow rules survive it and are read back once. */
async function isContinued(tabId: number, host: string): Promise<boolean> {
  if (IN_DYNAMIC) {
    if (isAllowedInTab(tabId, host)) return true;
    return (await safariContinuedHosts()).some((h) => hostIn(host, h));
  }
  if (hasSessionRules()) {
    continuedLoaded ??= sessionRules(CONTINUE_FIRST_ID, CONTINUE_SLOTS).then((rules) => {
      for (const r of rules) {
        for (const t of r.condition.tabIds ?? []) {
          if (!allowedByTab.has(t)) allowedByTab.set(t, new Set());
          for (const d of r.condition.requestDomains ?? []) allowedByTab.get(t)!.add(d);
        }
      }
    }).catch(() => undefined);
    await continuedLoaded;
  }
  return isAllowedInTab(tabId, host);
}

/** "Continue anyway (for this site, this time)": allow the host in this tab until it closes or the browser restarts. */
export async function allowContinue(tabId: number, url: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'not a web address' };
  const host = hostOf(url);
  if (!host || tabId < 0) return { ok: false, error: 'no host' };
  if (!allowedByTab.has(tabId)) allowedByTab.set(tabId, new Set());
  allowedByTab.get(tabId)!.add(host);
  dbg({ ev: 'continue', tabId, host });
  if (!hasSessionRules()) return { ok: true, url };
  const existing = await sessionRules(CONTINUE_FIRST_ID, CONTINUE_SLOTS);
  const used = new Set(existing.map((r) => r.id));
  const slots = PLATFORM === 'safari' ? SAFARI_CONTINUE_SLOTS : CONTINUE_SLOTS;
  let id = CONTINUE_FIRST_ID;
  while (used.has(id) && id < CONTINUE_FIRST_ID + slots) id++;
  const removeRuleIds = id >= CONTINUE_FIRST_ID + slots ? existing.slice(0, 1).map((r) => r.id) : [];
  if (removeRuleIds.length) id = removeRuleIds[0]!;
  await updateTempRules({
    removeRuleIds,
    addRules: [continueRule(id, host, tabId, PLATFORM === 'safari' ? 'safari' : 'chrome') as chrome.declarativeNetRequest.Rule],
  });
  if (IN_DYNAMIC) {
    const hosts = await safariContinuedHosts();
    if (!hosts.includes(host)) await B.storage.session.set({ continuedHosts: [...hosts, host].slice(-CONTINUE_SLOTS) }).catch(() => undefined);
  }
  return { ok: true, url };
}

export function registerProtectionCleanup(): void {
  B.tabs.onRemoved.addListener((tabId) => {
    allowedByTab.delete(tabId);
    if (!hasSessionRules()) return;
    // Safari's continue rules are not per tab (see safariContinuedHosts): they last until browser start.
    if (IN_DYNAMIC) return;
    void sessionRules(CONTINUE_FIRST_ID, CONTINUE_SLOTS)
      .then((rules) => {
        const ids = rules.filter((r) => r.condition.tabIds?.includes(tabId)).map((r) => r.id);
        if (ids.length) return updateTempRules({ removeRuleIds: ids });
        return undefined;
      })
      .catch((err) => log('continue-rule cleanup failed', String(err)));
  });
}

// ---------- navigation guard (Chrome, Safari) ----------

/** Lists whose DNR rules are actually installed (set by dnr-apply.ts after each install). */
let dnrInstalled: Set<string> | null = null;

export function setDnrProtectedLists(ids: string[]): void {
  dnrInstalled = new Set(ids);
}

async function dnrProtected(): Promise<Set<string>> {
  if (!dnrInstalled) {
    const { dnrStatus } = (await B.storage.local.get('dnrStatus')) as { dnrStatus?: { protection?: { lists?: string[] } } };
    dnrInstalled = new Set(dnrStatus?.protection?.lists ?? []);
  }
  return dnrInstalled;
}

/** Guard session rules are recycled oldest-first. */
let guardChain: Promise<unknown> = Promise.resolve();

function addGuardRule(domain: string, list: string): Promise<void> {
  if (!hasSessionRules()) return Promise.resolve();
  const run = guardChain.then(async () => {
    const existing = await sessionRules(GUARD_FIRST_ID, GUARD_SLOTS);
    if (existing.some((r) => r.condition.requestDomains?.[0] === domain)) return;
    const used = new Set(existing.map((r) => r.id));
    let id = GUARD_FIRST_ID;
    while (used.has(id) && id < GUARD_FIRST_ID + GUARD_SLOTS) id += 2;
    let removeRuleIds: number[] = [];
    if (id >= GUARD_FIRST_ID + GUARD_SLOTS) {
      id = GUARD_FIRST_ID + 2 * Math.floor(Math.random() * (GUARD_SLOTS / 2));
      removeRuleIds = [id, id + 1];
    }
    await updateTempRules({
      removeRuleIds,
      addRules: guardRules(id, domain, list, warningPageUrl(), PLATFORM === 'safari' ? 'safari' : 'chrome') as chrome.declarativeNetRequest.Rule[],
    });
  });
  guardChain = run.catch((err) => log('guard rule failed', String(err)));
  return guardChain as Promise<void>;
}

interface NavDetails {
  tabId: number;
  frameId: number;
  url: string;
  timeStamp: number;
  parentFrameId?: number;
  documentLifecycle?: string;
}

/** Hosts the guard sent to the warning page, for diagnostics / tests. */
const guardLog: Array<{ host: string; list: string; frameId: number; at: number; lookupUs: number; tabUpdateMs?: number; committed?: boolean }> = [];

export function guardHits(): typeof guardLog {
  return guardLog;
}

/** A listed host that DNR does not already handle, and the user has not allowed: returns the list. */
async function guardVerdict(d: NavDetails): Promise<{ list: string; host: string; lookupUs: number; inDnr: boolean } | null> {
  if (d.tabId < 0 || !/^https?:\/\//i.test(d.url)) return null;
  const host = hostOf(d.url);
  if (!host) return null;
  const set = hostSet ?? (await getHostSet());
  const t0 = performance.now();
  const idx = set.lookupIndex(host);
  const lookupUs = Math.round((performance.now() - t0) * 1000);
  if (idx < 0) return null;
  const list = set.ids[idx]!;
  // Chrome: DNR already redirects these. Safari's DNR only blocks them (no usable
  // redirect rule there), so the guard shows the warning page for every list.
  const inDnr = (await dnrProtected()).has(list);
  if (inDnr && PLATFORM !== 'safari') return null;
  // The per-site switch (allow-list): off for the top-level site.
  const top = d.frameId === 0 ? host : hostOf((await B.tabs.get(d.tabId).catch(() => null))?.url ?? '');
  if (isDisabledIn(await disabledSites(), top)) return null;
  const cont = await isContinued(d.tabId, host);
  dbg({ ev: 'verdict', tabId: d.tabId, frameId: d.frameId, host, list, cont, tabs: [...allowedByTab.keys()] });
  if (cont) return null;
  return { list, host, lookupUs, inDnr };
}

/** `${tabId} ${host}` → when the guard last sent that tab to the warning page. */
const recentlyGuarded = new Map<string, number>();

async function onBeforeNavigate(d: NavDetails): Promise<void> {
  const v = await guardVerdict(d);
  if (!v) return;
  recentlyGuarded.set(`${d.tabId} ${v.host}`, Date.now());
  if (recentlyGuarded.size > 200) recentlyGuarded.delete(recentlyGuarded.keys().next().value!);
  const domain = hostSet?.matchedDomain(v.host) ?? v.host;
  const entry: (typeof guardLog)[number] = { host: v.host, list: v.list, frameId: d.frameId, at: Date.now(), lookupUs: v.lookupUs };
  guardLog.push(entry);
  if (guardLog.length > 50) guardLog.shift();
  addBlocked(d.tabId, 1);
  recordBlocked(d.tabId, { url: d.url, type: d.frameId === 0 ? 'main_frame' : 'sub_frame', src: null, rule: `protection:${v.list}`, at: d.timeStamp });
  const t0 = Date.now();
  // Replace the navigation first (fastest), then make DNR block the host for the rest of the session.
  const nav = d.frameId === 0 && d.documentLifecycle !== 'prerender'
    ? B.tabs.update(d.tabId, { url: warningUrl(warningPageUrl(), v.list, d.url) }).then(() => (entry.tabUpdateMs = Date.now() - t0))
    : Promise.resolve();
  await Promise.all([nav.catch((err) => log('guard: tab update failed', String(err))), v.inDnr ? Promise.resolve() : addGuardRule(domain, v.list)]);
}

/** A frame (or a prerendered page) of a listed host that got through anyway: blank it / warn. */
async function onCommitted(d: NavDetails): Promise<void> {
  const v = await guardVerdict(d);
  if (!v) return;
  if (d.frameId === 0) {
    // The listed page committed before the warning page replaced it (no blocking webRequest here).
    const e = [...guardLog].reverse().find((x) => x.host === v.host && x.frameId === 0);
    if (e) e.committed = true;
    // Already on its way to the warning page.
    if (Date.now() - (recentlyGuarded.get(`${d.tabId} ${v.host}`) ?? 0) < 5000) return;
    await B.tabs.update(d.tabId, { url: warningUrl(warningPageUrl(), v.list, d.url) }).catch(() => undefined);
    return;
  }
  await B.scripting
    .executeScript({ target: { tabId: d.tabId, frameIds: [d.frameId] }, func: () => location.replace('about:blank') } as chrome.scripting.ScriptInjection<[], void>)
    .catch(() => undefined);
}

export function registerNavigationGuard(): void {
  if (!USES_DNR || !B.webNavigation) return;
  B.webNavigation.onBeforeNavigate.addListener((d) => {
    void onBeforeNavigate(d as NavDetails).catch((err) => log('guard failed', String(err)));
  });
  B.webNavigation.onCommitted.addListener((d) => {
    void onCommitted(d as NavDetails).catch((err) => log('guard (commit) failed', String(err)));
  });
  // Warm the set on every worker start so the first navigation does not wait for IndexedDB.
  void getHostSet().catch((err) => log('protection set failed', String(err)));
}
