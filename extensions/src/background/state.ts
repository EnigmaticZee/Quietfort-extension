// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Persistent settings, downloaded filter lists, and the in-memory engine.
// Filter lists are downloaded at runtime from their maintainers and kept only
// in this browser profile's extension storage — never shipped in the package.

import { B, PLATFORM, log } from './api.ts';
import { Engine } from '../shared/engine.ts';
import type { ListInput } from '../shared/engine.ts';
import { EXTENSION_ENV } from '../shared/parse.ts';
import { hostMatches } from '../shared/domain.ts';
import { pickerRuleLine } from '../shared/selectors.ts';
import type { PickerRule } from '../shared/selectors.ts';
import { CATALOGUE, COOKIE_LIST_ID, catalogueEntry, isListEnabled } from '../shared/catalogue.ts';
import type { CustomList, ListKind } from '../shared/catalogue.ts';
import { DEFAULT_PRIVACY } from '../shared/privacy.ts';
import type { PrivacySettings } from '../shared/privacy.ts';
import { downloadProtectionList, fpKey, pruneProtectionData } from './protection-store.ts';
import { idbKeys } from './idb.ts';
import type { ProtectionMeta } from './protection-store.ts';

export interface ListSource {
  id: string;
  url: string;
  /** 'protection' lists are hosts of malicious sites (warning page), not filter rules. */
  kind?: ListKind;
}

declare const __E2E_LISTS__: ListSource[] | null;

export { COOKIE_LIST_ID };
export const COOKIE_SOURCE: ListSource = { id: COOKIE_LIST_ID, url: catalogueEntry(COOKIE_LIST_ID)!.url };

/**
 * Test build only: catalogue lists come from the local e2e server
 * (`<e2e origin>/catalogue/<id>.txt`, or the URL given for that id), and
 * e2e lists with other ids are added as extra filter lists.
 */
function e2eUrl(id: string, url: string): string {
  if (!__E2E_LISTS__) return url;
  const hit = __E2E_LISTS__.find((s) => s.id === id);
  if (hit) return hit.url;
  return `${new URL(__E2E_LISTS__[0]!.url).origin}/catalogue/${id}.txt`;
}

export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

export interface Settings {
  disabledSites: string[];
  /** Advanced override of the list URLs (also used by the end-to-end tests). */
  listSources: ListSource[] | null;
  /** The user's own filter rules. */
  userFilters: string;
  /** Reject cookie banners automatically and hide leftovers (on by default). */
  cookieBanners: boolean;
  /** Catalogue choices: list id → on/off (missing: the list's default). */
  lists: Record<string, boolean>;
  /** User-added list URLs (https only). */
  customLists: CustomList[];
  /** Diagnostics / tests: catalogue id → alternative URL. */
  urlOverrides: Record<string, string>;
  privacy: PrivacySettings;
  ai: AiSettings;
  /** Blocking paused everywhere until this time (ms); 0 = not paused, PAUSE_FOREVER = until resumed. */
  pausedUntil: number;
}

export const PAUSE_FOREVER = 8.64e15;
/** In the effective disabled-site list: every site (blocking paused everywhere). */
export const ALL_SITES = '*';

/** On-device AI features: opt-in, local only. */
export interface AiSettings {
  sponsored: boolean;
  scam: boolean;
  cookiePlans: boolean;
}

export const DEFAULT_AI: AiSettings = { sponsored: false, scam: false, cookiePlans: false };

export interface StoredList {
  url: string;
  /** Filter lists only; protection lists are stored compiled (protection-store.ts). */
  text: string;
  fetchedAt: number;
  protection?: ProtectionMeta;
}

export interface ListStatus {
  url: string;
  fetchedAt: number | null;
  bytes: number;
  lastAttempt: number;
  error: string | null;
  kind?: ListKind;
  /** Protection lists: hosts parsed. */
  hosts?: number;
}

const DEFAULT_SETTINGS: Settings = {
  disabledSites: [], listSources: null, userFilters: '', cookieBanners: true,
  lists: {}, customLists: [], urlOverrides: {}, privacy: DEFAULT_PRIVACY, ai: DEFAULT_AI, pausedUntil: 0,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await B.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...((settings as Partial<Settings>) ?? {}) };
  s.privacy = { ...DEFAULT_PRIVACY, ...(s.privacy ?? {}) };
  s.ai = { ...DEFAULT_AI, ...(s.ai ?? {}) };
  return s;
}

/** Browser languages (for regional list suggestions). */
export function browserLangs(): string[] {
  const out: string[] = [];
  try {
    out.push(...(navigator.languages ?? []));
  } catch {
    /* ignore */
  }
  try {
    out.push(B.i18n.getUILanguage());
  } catch {
    /* ignore */
  }
  return out.filter(Boolean);
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await B.storage.local.set({ settings: next });
  if ('disabledSites' in patch || 'pausedUntil' in patch) {
    disabledCache = next.disabledSites;
    pausedCache = next.pausedUntil || 0;
    await Promise.all(disabledHooks.map((fn) => fn().catch(() => undefined)));
  }
  if (['userFilters', 'listSources', 'cookieBanners', 'lists', 'customLists', 'urlOverrides'].some((k) => k in patch)) invalidateEngine();
  return next;
}

let disabledCache: string[] | null = null;
const disabledHooks: Array<() => Promise<void>> = [];

const overlayHooks: Array<() => Promise<void>> = [];

/** Called (and awaited) whenever the site-fix overlay (temporary exceptions) changes. */
export function onOverlayChange(fn: () => Promise<void>): void {
  overlayHooks.push(fn);
}

export async function overlayChanged(): Promise<void> {
  await Promise.all(overlayHooks.map((fn) => fn().catch(() => undefined)));
}

/** Called (and awaited) whenever the per-site switches change. */
export function onDisabledSitesChange(fn: () => Promise<void>): void {
  disabledHooks.push(fn);
}

let pausedCache = 0;

/** Paused everywhere right now? */
export function isPausedAt(pausedUntil: number, at = Date.now()): boolean {
  return pausedUntil > at;
}

function effective(list: string[]): string[] {
  return isPausedAt(pausedCache) ? [...list, ALL_SITES] : list;
}

/** Sites blocking is off on; contains ALL_SITES while blocking is paused everywhere. */
export async function disabledSites(): Promise<string[]> {
  if (!disabledCache) {
    const s = await getSettings();
    disabledCache = s.disabledSites;
    pausedCache = s.pausedUntil || 0;
  }
  return effective(disabledCache);
}

export function disabledSitesSync(): string[] {
  return effective(disabledCache ?? []);
}

/** The user's own per-site list (without the pause). */
export async function storedDisabledSites(): Promise<string[]> {
  return (await getSettings()).disabledSites;
}

export function isDisabledIn(list: string[], host: string | null): boolean {
  if (!host) return false;
  return list.some((d) => d === ALL_SITES || hostMatches(host, d));
}

/** Normalised site key for the per-site switch (`www.` dropped). */
export function siteKey(host: string): string {
  return host.replace(/^www\./, '');
}

/**
 * Lists to use. Normally the catalogue lists that are on plus enabled custom
 * lists; the cookie list only while cookie-banner handling is on. An explicit
 * `listSources` override (diagnostics / tests) replaces the catalogue (a
 * configured `easylist-cookie` entry overrides the cookie list's URL).
 */
export async function sources(): Promise<ListSource[]> {
  const settings = await getSettings();
  if (settings.listSources) {
    const base = settings.listSources;
    const rest = base.filter((s) => s.id !== COOKIE_LIST_ID);
    if (settings.cookieBanners === false) return rest;
    return [...rest, base.find((s) => s.id === COOKIE_LIST_ID) ?? COOKIE_SOURCE];
  }
  const langs = browserLangs();
  const out: ListSource[] = [];
  for (const e of CATALOGUE) {
    if (!isListEnabled(e, settings.lists, langs)) continue;
    if (e.id === COOKIE_LIST_ID && settings.cookieBanners === false) continue;
    out.push({ id: e.id, url: settings.urlOverrides[e.id] ?? e2eUrl(e.id, e.url), kind: e.kind });
  }
  if (__E2E_LISTS__) {
    for (const s of __E2E_LISTS__) if (!catalogueEntry(s.id)) out.push({ id: s.id, url: s.url, kind: s.kind ?? 'filters' });
  }
  for (const c of settings.customLists) if (c.enabled) out.push({ id: c.id, url: c.url, kind: c.kind });
  return out;
}

/** A list may use trusted-only scriptlets: a trusted catalogue entry, downloaded from its own URL. */
export function isTrustedSource(src: ListSource, fetchedUrl: string): boolean {
  const e = catalogueEntry(src.id);
  return !!e?.trusted && fetchedUrl === e.url && src.url === e.url;
}

// ---------- engine ----------

let engine: Engine | null = null;
let enginePromise: Promise<Engine | null> | null = null;
let overlaySource: (() => Promise<string[]>) | null = null;

/** Where the engine gets its site-exception overlay from (sitefixes.ts). */
export function setOverlaySource(fn: () => Promise<string[]>): void {
  overlaySource = fn;
}

export function engineSync(): Engine | null {
  return engine;
}

const invalidateHooks: Array<() => void> = [];

/** Called whenever the lists or filters change (protection index, etc.). */
export function onInvalidate(fn: () => void): void {
  invalidateHooks.push(fn);
}

export function invalidateEngine(): void {
  engine = null;
  enginePromise = null;
  for (const fn of invalidateHooks) fn();
}

/** Only the protection lists changed: drop the protection caches, keep the engine. */
function invalidateProtection(): void {
  for (const fn of invalidateHooks) fn();
}

/** Which list each engine input came from (index = the engine's list index). */
const engineListIds = new WeakMap<Engine, string[]>();

/**
 * Lists whose network rules are installed first when the browser's rule limit
 * is reached: the primary lists and the user's own rules. Optional lists
 * (uBO, AdGuard, regional, custom) fill whatever room is left.
 */
export const PRIMARY_NETWORK_LISTS = new Set(['easylist', 'easyprivacy', 'easylist-cookie', 'user-filters', 'picker']);

/** Install tier of each engine network rule (0 = primary list, 1 = optional list). */
export function networkRuleTier(e: Engine): (ruleIndex: number) => number {
  const ids = engineListIds.get(e);
  if (!ids) return () => 0;
  return (i) => (PRIMARY_NETWORK_LISTS.has(ids[e.networkRuleList[i]!] ?? '') ? 0 : 1);
}

export function getEngine(): Promise<Engine | null> {
  if (engine) return Promise.resolve(engine);
  if (!enginePromise) {
    enginePromise = (async () => {
      await disabledSites(); // prime the sync cache used by blocking listeners
      const srcs = (await sources()).filter((s) => s.kind !== 'protection');
      const keys = srcs.map((s) => `list:${s.id}`);
      const stored = await B.storage.local.get(keys);
      const texts: ListInput[] = [];
      const ids: string[] = [];
      srcs.forEach((src, i) => {
        const l = stored[keys[i]!] as StoredList | undefined;
        // Trusted-only scriptlets: only catalogue lists marked trusted, and only
        // when fetched from the catalogue URL (not an override or custom list).
        if (l?.text) {
          texts.push({ text: l.text, trusted: isTrustedSource(src, l.url), remote: true });
          ids.push(src.id);
        }
      });
      const { userFilters } = await getSettings();
      const { pickerRules = [] } = (await B.storage.local.get('pickerRules')) as { pickerRules?: PickerRule[] };
      const pickerText = pickerRules.map(pickerRuleLine).join('\n');
      if (!texts.length && !userFilters && !pickerText) return null;
      const t0 = Date.now();
      const e = Engine.fromLists([...texts, userFilters, pickerText], EXTENSION_ENV[PLATFORM]);
      engineListIds.set(e, [...ids, 'user-filters', 'picker']);
      if (overlaySource) e.setOverlay(await overlaySource());
      log(`engine built in ${Date.now() - t0} ms`, e.stats.network, 'network rules');
      engine = e;
      return e;
    })().catch((err) => {
      log('engine build failed', err);
      enginePromise = null;
      return null;
    });
  }
  return enginePromise;
}

// ---------- list download ----------

/** Larger downloads are refused (the full Block List Project malware list is ~72 MB). */
const MAX_LIST_BYTES = 100 * 1024 * 1024;

async function fetchText(url: string, timeoutMs = 60000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 20 || /^\s*</.test(text)) throw new Error('response is not a filter list');
    if (text.length > MAX_LIST_BYTES) throw new Error(`list too large (${text.length} bytes)`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Download every list that is missing or older than 24 h (all of them when
 * `force`). Serialised so concurrent triggers never interleave. Resolves to
 * true when any list text changed.
 */
export function refreshLists(force = false, onFiltersReady?: () => void): Promise<boolean> {
  const run = chain.then(() => doRefresh(force, onFiltersReady));
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Filter lists first, protection lists (one of them is 72 MB) after: when the
 * filter lists changed, the engine is rebuilt and `onFiltersReady` called
 * before the protection downloads start, so ad blocking never waits for them.
 */
async function doRefresh(force: boolean, onFiltersReady?: () => void): Promise<boolean> {
  const srcs = await sources();
  const { listStatus = {} } = (await B.storage.local.get('listStatus')) as { listStatus?: Record<string, ListStatus> };
  const now = Date.now();
  let changed = false;
  let protChanged = false;
  let engineDone = false;
  let fpKeys: string[] | undefined;
  const ordered = [...srcs.filter((s) => s.kind !== 'protection'), ...srcs.filter((s) => s.kind === 'protection')];
  for (const s of ordered) {
    if (s.kind === 'protection' && !engineDone) {
      engineDone = true;
      if (changed) {
        invalidateEngine();
        await B.storage.local.set({ listStatus });
        onFiltersReady?.();
      }
    }
    const key = `list:${s.id}`;
    const stored = (await B.storage.local.get(key))[key] as StoredList | undefined;
    const st = listStatus[s.id];
    let fresh = stored && stored.url === s.url && now - stored.fetchedAt < REFRESH_INTERVAL_MS;
    // A protection list is only fresh while its compiled data is still there.
    if (fresh && s.kind === 'protection') fresh = !!stored!.protection && (fpKeys ??= await idbKeys()).includes(fpKey(s.id));
    const backoff = st?.error && st.url === s.url && now - st.lastAttempt < RETRY_AFTER_FAILURE_MS;
    if (!force && (fresh || backoff)) continue;
    if (s.kind === 'protection') {
      try {
        const r = await downloadProtectionList(s.id, s.url, stored);
        if (r.changed || !stored || stored.url !== s.url) protChanged = true;
        await B.storage.local.set({ [key]: { url: s.url, text: '', fetchedAt: now, protection: r.meta } satisfies StoredList });
        listStatus[s.id] = { url: s.url, fetchedAt: now, bytes: r.meta.bytes, lastAttempt: now, error: null, kind: 'protection', hosts: r.meta.hosts };
      } catch (err) {
        listStatus[s.id] = { url: s.url, fetchedAt: stored?.fetchedAt ?? null, bytes: stored?.protection?.bytes ?? 0, lastAttempt: now, error: String(err), kind: 'protection', hosts: stored?.protection?.hosts };
        log(`list ${s.id} failed`, String(err));
      }
      continue;
    }
    try {
      const text = await fetchText(s.url);
      if (!stored || stored.text !== text || stored.url !== s.url) changed = true;
      await B.storage.local.set({ [key]: { url: s.url, text, fetchedAt: now } satisfies StoredList });
      listStatus[s.id] = { url: s.url, fetchedAt: now, bytes: text.length, lastAttempt: now, error: null, kind: s.kind ?? 'filters' };
      log(`list ${s.id}: ${text.length} bytes`);
    } catch (err) {
      listStatus[s.id] = { url: s.url, fetchedAt: stored?.fetchedAt ?? null, bytes: stored?.text.length ?? 0, lastAttempt: now, error: String(err), kind: s.kind ?? 'filters' };
      log(`list ${s.id} failed`, String(err));
    }
  }
  // Forget lists that are no longer configured.
  const all = await B.storage.local.get(null);
  const keep = new Set(srcs.map((s) => `list:${s.id}`));
  const stale = Object.keys(all).filter((k) => k.startsWith('list:') && !keep.has(k));
  if (stale.length) {
    await B.storage.local.remove(stale);
    changed = true;
    engineDone = false;
  }
  await pruneProtectionData(srcs.filter((s) => s.kind === 'protection').map((s) => s.id)).catch((err) => log('protection prune failed', String(err)));
  for (const id of Object.keys(listStatus)) if (!srcs.some((s) => s.id === id)) delete listStatus[id];
  await B.storage.local.set({ listStatus, lastRefreshCheck: now });
  if (changed && !engineDone) invalidateEngine();
  else if (protChanged) invalidateProtection();
  return changed || protChanged;
}
