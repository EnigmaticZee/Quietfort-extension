// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Safari only: keeps the companion app's content blockers in step with the
// filter lists. The rules are compiled here (shared/safari-cb.ts), compressed,
// and handed to the app's native extension handler over native messaging; it
// writes them to the app group container and reloads each content blocker.
// Only the compiled rules (from the public filter lists, the user's own
// rules and the sites the user turned blocking off on) are sent, and only to
// our own native handler; it sends nothing anywhere.

import { B, PLATFORM, log } from './api.ts';
import { allowlistRule } from '../shared/dnr.ts';
import type { DnrRuleNoId } from '../shared/dnr.ts';
import { buildContentBlockers, CB_EMPTY, dnrRuleToCb, redirectKeys } from '../shared/safari-cb.ts';
import type { CbBuildResult, CbRule } from '../shared/safari-cb.ts';
import { disabledSites, getEngine, networkRuleTier, onDisabledSitesChange, onOverlayChange } from './state.ts';
import { overlayDnrRules } from './sitefixes.ts';

/** Content-blocker extensions in the companion app (app.adblocker.companion.Blocker1...N). */
export const CB_COUNT = 3;
const APP_ID = 'app.adblocker.companion';
/** Base64 characters per native message. */
const PART_CHARS = 4 * 1024 * 1024;
const DEBOUNCE_MS = 3000;

export interface CbBlockerStatus {
  id: string;
  /** Turned on in Safari Settings → Extensions (null: unknown). */
  enabled: boolean | null;
  rules: number;
  /** Last reload error from Safari, if any. */
  error?: string;
  /** Rules the app removed because WebKit rejected them. */
  removed?: number;
}

export interface CbStatus {
  ok: boolean;
  hash?: string;
  /** Hash of the per-site switch rules the app has (see siteRulesText). */
  sitesHash?: string;
  /** cb:sites: the app has no filter-list rules to splice onto (first run after an update). */
  needsFull?: boolean;
  blockers: CbBlockerStatus[];
  /** Set by the extension: conversion statistics of the last push. */
  stats?: CbBuildResult['stats'];
  updatedAt?: number;
  error?: string;
}

async function native<T>(msg: Record<string, unknown>): Promise<T> {
  // Safari ignores the application id and always talks to the containing app's handler.
  return (await B.runtime.sendNativeMessage(APP_ID, msg)) as T;
}

export async function contentBlockerStatus(): Promise<CbStatus | null> {
  if (PLATFORM !== 'safari') return null;
  try {
    const s = await native<CbStatus>({ type: 'cb:status' });
    const { cbStatus } = (await B.storage.local.get('cbStatus')) as { cbStatus?: CbStatus };
    return { ...s, stats: cbStatus?.stats, updatedAt: cbStatus?.updatedAt };
  } catch (err) {
    return { ok: false, blockers: [], error: String(err) };
  }
}

async function sha256(parts: string[]): Promise<string> {
  const enc = new TextEncoder();
  const h = await crypto.subtle.digest('SHA-256', enc.encode(parts.join('\n')));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function deflateBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Rebuild the content blockers soon (several changes in a row make one rebuild). */
export function scheduleContentBlockers(reason: string, delayMs = DEBOUNCE_MS): void {
  if (PLATFORM !== 'safari') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    chain = chain.then(() => pushContentBlockers(reason)).catch((err) => log('content blockers: update failed', String(err)));
  }, delayMs);
}

/**
 * The per-site switches as content-blocker rules: one `ignore-previous-rules`
 * rule (whole page, popups included) for the sites the user turned blocking off
 * on. The app appends them to every content blocker, after the filter-list rules.
 */
export function siteRulesText(sites: string[]): string {
  if (sites.includes('*')) {
    // Paused everywhere: one rule that switches every list off on every page.
    return JSON.stringify([{ trigger: { 'url-filter': '.*', 'resource-type': ['image', 'svg-document', 'style-sheet', 'script', 'font', 'raw', 'media', 'document', 'popup'] }, action: { type: 'ignore-previous-rules' } }]);
  }
  const allow = allowlistRule(sites);
  const conv = allow ? dnrRuleToCb(allow) : [];
  const rules: CbRule[] = typeof conv === 'string' ? [] : conv.flat();
  if (typeof conv === 'string') log('content blockers: per-site rule not convertible', conv);
  return JSON.stringify(rules);
}

export async function pushContentBlockers(reason: string, force = false): Promise<CbStatus | null> {
  if (PLATFORM !== 'safari') return null;
  const t0 = Date.now();
  const engine = await getEngine();
  // The per-site switches are not part of these lists: they go separately (pushSites),
  // so turning a site off never rebuilds or resends the filter lists.
  const extra: DnrRuleNoId[] = [...((await overlayDnrRules()) as DnrRuleNoId[])];
  const dnrRedirects = await installedRedirects();
  const built = engine
    ? buildContentBlockers(engine.networkRules, { blockers: CB_COUNT, tierOf: networkRuleTier(engine), extraDnr: extra, dnrRedirects })
    : null;
  const lists = (built?.lists ?? []).map((l) => (l.some((r) => r.action.type === 'block') ? l : CB_EMPTY));
  while (lists.length < CB_COUNT) lists.push(CB_EMPTY);
  const texts = lists.map((l) => JSON.stringify(l));
  const hash = await sha256(texts);
  const sites = siteRulesText(await disabledSites());
  const sitesHash = await sha256([sites]);

  let current: CbStatus | null = null;
  try {
    current = await native<CbStatus>({ type: 'cb:status' });
  } catch (err) {
    log('content blockers: companion app not reachable', String(err));
    return null;
  }
  if (!force && current?.hash === hash && current.blockers.every((b) => !b.error)) {
    return current.sitesHash === sitesHash ? current : pushSitesNow('lists unchanged');
  }

  const gen = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await native({ type: 'cb:begin', gen, count: CB_COUNT });
  for (let i = 0; i < texts.length; i++) {
    const data = await deflateBase64(texts[i]!);
    for (let off = 0, seq = 0; off < data.length; off += PART_CHARS, seq++) {
      await native({ type: 'cb:part', gen, index: i, seq, data: data.slice(off, off + PART_CHARS) });
    }
  }
  const res = await native<CbStatus>({ type: 'cb:commit', gen, hash, sites, sitesHash, rules: lists.map((l) => l.length) });
  const status: CbStatus = { ...res, stats: built?.stats, updatedAt: Date.now() };
  await B.storage.local.set({ cbStatus: status });
  log(`content blockers (${reason}): ${lists.map((l) => l.length).join(' + ')} rules in ${Date.now() - t0} ms`, res.blockers.map((b) => b.error ?? 'ok'));
  return status;
}

/**
 * The stub redirects the web extension really has installed. Content blockers let
 * these through for the web extension to swap in a stub; every other redirect
 * target is blocked by the content blockers (Safari's DNR cap leaves some out).
 */
async function installedRedirects(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const dnr = B.declarativeNetRequest;
    const session = typeof dnr.getSessionRules === 'function' ? await dnr.getSessionRules() : [];
    for (const r of [...(await dnr.getDynamicRules()), ...session]) {
      for (const k of redirectKeys(r as unknown as Parameters<typeof redirectKeys>[0])) out.add(k);
    }
  } catch (err) {
    log('content blockers: could not read installed redirects', String(err));
  }
  return out;
}

/** Hands the app the current per-site switches; falls back to a full push if it has no lists yet. */
async function pushSitesNow(reason: string): Promise<CbStatus | null> {
  const t0 = Date.now();
  const rules = siteRulesText(await disabledSites());
  const hash = await sha256([rules]);
  let res: CbStatus;
  try {
    res = await native<CbStatus>({ type: 'cb:sites', rules, hash });
  } catch (err) {
    log('content blockers: companion app not reachable', String(err));
    return null;
  }
  if (res.needsFull) return pushContentBlockers(`${reason} (first full push)`, true);
  const { cbStatus } = (await B.storage.local.get('cbStatus')) as { cbStatus?: CbStatus };
  const status: CbStatus = { ...res, stats: cbStatus?.stats, updatedAt: Date.now() };
  await B.storage.local.set({ cbStatus: status });
  log(`content blockers (${reason}): per-site switches updated in ${Date.now() - t0} ms`, res.blockers.map((b) => b.error ?? 'ok'));
  return status;
}

/** A full push, queued behind any update in progress (two pushes must never interleave). */
export function pushContentBlockersQueued(reason: string, force = false): Promise<CbStatus | null> {
  if (PLATFORM !== 'safari') return Promise.resolve(null);
  const p = chain.then(() => pushContentBlockers(reason, force));
  chain = p.catch((err) => log('content blockers: update failed', String(err)));
  return p;
}

/**
 * The user switched blocking off or on for a site. Resolves once Safari has the
 * new rules, so the caller can reload the page and see the change.
 */
export function updateContentBlockerSites(reason: string): Promise<unknown> {
  if (PLATFORM !== 'safari') return Promise.resolve();
  const p = chain.then(() => pushSitesNow(reason));
  chain = p.catch((err) => log('content blockers: per-site update failed', String(err)));
  return p;
}

if (PLATFORM === 'safari') {
  onOverlayChange(async () => scheduleContentBlockers('site fixes'));
  // The user is waiting to reload the page: no batching, and the caller waits for Safari.
  onDisabledSitesChange(async () => {
    await updateContentBlockerSites('sites turned off/on');
  });
}

/** Worker start: rebuild only if the app lost the rules (reinstall) or the last push failed. */
export async function ensureContentBlockers(): Promise<void> {
  if (PLATFORM !== 'safari') return;
  const { cbStatus } = (await B.storage.local.get('cbStatus')) as { cbStatus?: CbStatus };
  let current: CbStatus;
  try {
    current = await native<CbStatus>({ type: 'cb:status' });
  } catch {
    return;
  }
  if (!cbStatus?.hash || current.hash !== cbStatus.hash || current.blockers.some((b) => b.error)) scheduleContentBlockers('startup check');
  else if (current.sitesHash !== (await sha256([siteRulesText(await disabledSites())]))) void updateContentBlockerSites('startup check');
}
