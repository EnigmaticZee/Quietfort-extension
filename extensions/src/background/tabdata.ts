// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Per-tab evidence for Fix-this-site: requests blocked on the current page,
// generic selectors applied to it, relevant JavaScript errors, and breakage
// signals. Mirrored to storage.session so a service-worker restart in the
// middle of a fix keeps it. Nothing here leaves the browser.

import { B } from './api.ts';
import { hostOf, registrable } from '../shared/domain.ts';
import { classifyJsError, isQuickToggle, recordReload } from '../shared/signals.ts';
import type { JsErrorReport, Signal, SignalKind } from '../shared/signals.ts';

export interface BlockedRecord {
  url: string;
  /** webRequest type */
  type: string;
  /** Host of the document that made the request. */
  src: string | null;
  /** Rule that blocked it, when known (Firefox; filled lazily on Chrome). */
  rule?: string;
  at: number;
}

export interface ErrorRecord {
  signature: string;
  message: string;
  why: string;
  at: number;
}

interface TabData {
  url: string;
  host: string | null;
  committedAt: number;
  blocked: BlockedRecord[];
  genericSelectors: string[];
  errors: ErrorRecord[];
  signals: Signal[];
  reloads: Array<{ url: string; at: number }>;
}

let tabs: Record<string, TabData> = {};
/** site → time protection was switched off */
let toggledOff: Record<string, number> = {};
/** site → signals that are not tied to one tab (quick toggles) */
let siteSignals: Record<string, Signal[]> = {};
let loaded: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Tabs whose next reload is ours (Fix-this-site), not the user's. */
const ownReloads = new Set<number>();

function load(): Promise<void> {
  loaded ??= (async () => {
    try {
      const s = await B.storage.session.get('tabData');
      const d = (s.tabData ?? {}) as { tabs?: typeof tabs; toggledOff?: typeof toggledOff; siteSignals?: typeof siteSignals };
      tabs = { ...(d.tabs ?? {}), ...tabs };
      toggledOff = { ...(d.toggledOff ?? {}), ...toggledOff };
      siteSignals = { ...(d.siteSignals ?? {}), ...siteSignals };
    } catch {
      /* storage.session unavailable */
    }
  })();
  return loaded;
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    B.storage.session?.set({ tabData: { tabs, toggledOff, siteSignals } }).catch(() => undefined);
  }, 200);
}

function get(tabId: number): TabData {
  return (tabs[tabId] ??= { url: '', host: null, committedAt: 0, blocked: [], genericSelectors: [], errors: [], signals: [], reloads: [] });
}

function addSignal(d: TabData, kind: SignalKind, at: number, detail?: string): void {
  if (d.signals.some((s) => s.kind === kind && s.detail === detail && at - s.at < 5000)) return;
  d.signals.push({ kind, at, ...(detail ? { detail } : {}) });
  if (d.signals.length > 30) d.signals.splice(0, d.signals.length - 30);
}

export function markOwnReload(tabId: number): void {
  ownReloads.add(tabId);
}

/** Was this top-level commit caused by our own reload? (consumes the mark) */
export function consumeOwnReload(tabId: number): boolean {
  return ownReloads.delete(tabId);
}

/** Top-level navigation committed in `tabId`. */
export function onTopCommit(tabId: number, url: string, transitionType: string | undefined, at: number, own: boolean): void {
  void load().then(() => {
    const d = get(tabId);
    const base = url.split('#')[0]!;
    if (d.url !== base) {
      d.signals = [];
      d.reloads = [];
    }
    d.url = base;
    d.host = /^https?:/i.test(url) ? hostOf(url) : null;
    d.committedAt = at;
    // Keep what arrived for this document already (events of different APIs are not ordered).
    d.blocked = d.blocked.filter((b) => b.at >= at);
    d.errors = d.errors.filter((e) => e.at >= at);
    d.genericSelectors = [];
    if (transitionType === 'reload' && !own) {
      const r = recordReload(d.reloads, base, at);
      d.reloads = r.history;
      if (r.repeat) addSignal(d, 'reload-repeat', at);
    }
    save();
  });
}

export function recordBlocked(tabId: number, rec: BlockedRecord): void {
  if (tabId < 0) return;
  void load().then(() => {
    const d = get(tabId);
    if (d.blocked.length >= 300) return;
    d.blocked.push(rec);
    if (d.host && rec.type !== 'main_frame' && registrable(hostOf(rec.url)) === registrable(d.host)) {
      addSignal(d, 'first-party-blocked', rec.at, hostOf(rec.url));
    }
    save();
  });
}

export function recordGenericSelectors(tabId: number, sels: string[]): void {
  if (!sels.length) return;
  void load().then(() => {
    const d = get(tabId);
    for (const s of sels) if (d.genericSelectors.length < 2000 && !d.genericSelectors.includes(s)) d.genericSelectors.push(s);
    save();
  });
}

export async function recordJsError(tabId: number, e: JsErrorReport, at: number): Promise<boolean> {
  await load();
  const d = get(tabId);
  const c = classifyJsError(e, d.blocked.map((b) => b.url));
  if (!c.relevant || d.errors.length >= 50) return false;
  d.errors.push({ signature: c.signature, message: String(e.message).slice(0, 300), why: c.why!, at });
  addSignal(d, 'js-error', at, c.signature);
  save();
  return true;
}

export async function recordExplicit(tabId: number, at: number): Promise<void> {
  await load();
  addSignal(get(tabId), 'explicit', at);
  save();
}

/** Per-site switch changed; returns true when this was a quick off→on toggle. */
export async function recordToggle(site: string, enabled: boolean, at: number): Promise<boolean> {
  await load();
  let quick = false;
  if (!enabled) toggledOff[site] = at;
  else {
    quick = isQuickToggle(toggledOff[site], at);
    delete toggledOff[site];
    if (quick) {
      const list = (siteSignals[site] ??= []);
      list.push({ kind: 'toggle-quick', at });
      if (list.length > 10) list.shift();
    }
  }
  save();
  return quick;
}

export async function tabEvidence(tabId: number): Promise<{ url: string; host: string | null; blocked: BlockedRecord[]; genericSelectors: string[]; errors: ErrorRecord[]; signals: Signal[] }> {
  await load();
  const d = get(tabId);
  return { url: d.url, host: d.host, blocked: [...d.blocked], genericSelectors: [...d.genericSelectors], errors: [...d.errors], signals: [...d.signals] };
}

export async function signalsFor(tabId: number, site: string | null): Promise<Signal[]> {
  await load();
  const d = get(tabId);
  const s = [...d.signals];
  if (site) for (const [k, v] of Object.entries(siteSignals)) if (site === k || site.endsWith(`.${k}`)) s.push(...v);
  return s;
}

export function clearSignals(tabId: number, site: string | null): void {
  void load().then(() => {
    const d = get(tabId);
    d.signals = [];
    if (site) delete siteSignals[site];
    save();
  });
}

export function removeTabData(tabId: number): void {
  void load().then(() => {
    delete tabs[tabId];
    save();
  });
}
