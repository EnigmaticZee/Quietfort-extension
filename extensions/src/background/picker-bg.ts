// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Element picker, background side: injects the picker, validates and stores
// the picked selectors as site-specific user rules (primary + fallbacks), and
// switches a rule to a fallback when the content script reports that the
// primary stopped matching while a fallback still matches the same element.

import { B, log } from './api.ts';
import { now } from './clock.ts';
import { siteKey } from './state.ts';
import { getPickerRules, setPickerRules } from './sitefixes.ts';
import { insertCss, hidingCss } from './cosmetics.ts';
import { hostMatches, hostOf } from '../shared/domain.ts';
import { parseLine } from '../shared/parse.ts';
import { MAX_MATCHES, selectorStringProblem } from '../shared/selectors.ts';
import type { Fingerprint, PickerRule } from '../shared/selectors.ts';
import { bestByWords, shortlist } from '../shared/describe.ts';
import type { BlockSummary } from '../shared/describe.ts';
import { describeWithModel } from './ai.ts';

export async function startPicker(tabId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await B.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['picker.js'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function senderHost(sender: chrome.runtime.MessageSender): string | null {
  const url = sender.url ?? sender.tab?.url;
  return url && /^https?:/i.test(url) ? hostOf(url) : null;
}

/** Why `sel` can't be saved for `site`, or null. */
export function pickerSelectorProblem(site: string, sel: string): string | null {
  const p = selectorStringProblem(sel);
  if (p) return p;
  const parsed = parseLine(`${site}##${sel}`);
  if (parsed.kind !== 'cosmetic' && parsed.kind !== 'procedural') return `not a hiding rule (${parsed.kind})`;
  return null;
}

async function applyNow(tabId: number | undefined, frameId: number | undefined, sel: string): Promise<void> {
  if (tabId === undefined || sel.includes(':has-text(')) return;
  try {
    await insertCss(tabId, frameId ?? 0, hidingCss([sel]));
  } catch (err) {
    log('picker insertCSS failed', String(err));
  }
}

export async function savePicked(sender: chrome.runtime.MessageSender, msg: { selectors?: unknown; counts?: unknown; fingerprint?: unknown }): Promise<{ ok: boolean; rule?: PickerRule; error?: string }> {
  const host = senderHost(sender);
  if (!host) return { ok: false, error: 'not a web page' };
  const site = siteKey(host);
  const sels = Array.isArray(msg.selectors) ? msg.selectors.map(String).slice(0, 10) : [];
  const counts = Array.isArray(msg.counts) ? msg.counts.map(Number) : [];
  if (!sels.length) return { ok: false, error: 'no selector' };
  const keep: Array<[string, number]> = [];
  for (let i = 0; i < sels.length; i++) {
    const problem = pickerSelectorProblem(site, sels[i]!);
    const n = counts[i] ?? 1;
    if (i === 0 && problem) return { ok: false, error: `primary selector refused: ${problem}` };
    if (i === 0 && !(n >= 1 && n <= MAX_MATCHES)) return { ok: false, error: 'primary selector refused: match count' };
    if (!problem && n >= 1 && n <= MAX_MATCHES && !keep.some(([s]) => s === sels[i])) keep.push([sels[i]!, n]);
  }
  const fp = (msg.fingerprint ?? {}) as Partial<Fingerprint>;
  const fingerprint: Fingerprint = {
    tag: String(fp.tag ?? '').toLowerCase().slice(0, 20),
    text: String(fp.text ?? '').slice(0, 200),
    rect: fp.rect && typeof fp.rect === 'object' ? { x: Number(fp.rect.x) || 0, y: Number(fp.rect.y) || 0, w: Number(fp.rect.w) || 0, h: Number(fp.rect.h) || 0 } : null,
  };
  const rule: PickerRule = {
    id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    site,
    selectors: keep.map(([s]) => s),
    counts: keep.map(([, n]) => n),
    active: 0,
    fingerprint,
    createdAt: now(),
  };
  await setPickerRules([...(await getPickerRules()), rule]);
  await applyNow(sender.tab?.id, sender.frameId, rule.selectors[0]!);
  log('picker rule saved', `${site}##${rule.selectors[0]}`, 'fallbacks', rule.selectors.slice(1));
  return { ok: true, rule };
}

export async function switchPicked(sender: chrome.runtime.MessageSender, id: string, index: number): Promise<{ ok: boolean; error?: string }> {
  const host = senderHost(sender);
  const list = await getPickerRules();
  const r = list.find((x) => x.id === id);
  if (!r || !host || !hostMatches(host, r.site)) return { ok: false, error: 'unknown rule' };
  if (!Number.isInteger(index) || index < 0 || index >= r.selectors.length || index === r.active) return { ok: false, error: 'bad index' };
  const updated: PickerRule = { ...r, active: index, switchedAt: now() };
  await setPickerRules(list.map((x) => (x.id === id ? updated : x)));
  await applyNow(sender.tab?.id, sender.frameId, r.selectors[index]!);
  log('picker rule switched to fallback', r.site, r.selectors[r.active], '→', r.selectors[index]);
  return { ok: true };
}

export async function removePicked(id: string): Promise<boolean> {
  const list = await getPickerRules();
  await setPickerRules(list.filter((x) => x.id !== id));
  return list.some((x) => x.id === id);
}

// ---------- right-click "Hide this element" and "Describe it to hide it" ----------

type Marked = { __qfPickElement?: Element | null; __qfContextTarget?: Element | null; __qfDescribeEls?: Element[]; __qfDescribe?: unknown };

/** Opens the picker with the element the user right-clicked already selected (top frame), else the plain picker. */
export async function pickFromContext(tabId: number, frameId: number | undefined): Promise<{ ok: boolean; error?: string }> {
  if (!frameId) {
    try {
      await B.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          const w = window as unknown as Marked;
          w.__qfPickElement = w.__qfContextTarget ?? null;
        },
      } as chrome.scripting.ScriptInjection<[], void>);
    } catch (err) {
      log('context pick: could not mark the element', String(err));
    }
  }
  return startPicker(tabId);
}

export interface DescribeResult {
  ok: boolean;
  /** A block matched: the picker is open on it. */
  found?: boolean;
  via?: 'model' | 'words';
  error?: string;
}

/**
 * Finds the block the user described and opens the picker on it (they confirm
 * with Hide there). The model decides when it is available; word matching otherwise.
 */
export async function describeHide(tabId: number, description: string): Promise<DescribeResult> {
  const text = String(description ?? '').trim().slice(0, 200);
  if (!text) return { ok: false, error: 'empty description' };
  type Page = { blocks: BlockSummary[]; vw: number; vh: number };
  let page = null as Page | null;
  try {
    await B.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['describe.js'] });
    const [res] = await B.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => (window as unknown as Marked).__qfDescribe ?? null,
    } as chrome.scripting.ScriptInjection<[], unknown>);
    page = (res?.result ?? null) as Page | null;
  } catch (err) {
    return { ok: false, error: `can't read this page (${String(err).slice(0, 120)})` };
  }
  if (!page || !page.blocks.length) return { ok: true, found: false };
  const viewport = { w: page.vw, h: page.vh };
  let idx = -1;
  let via: DescribeResult['via'] = 'words';
  const fromModel = await describeWithModel(text, page.blocks, shortlist(page.blocks, text, viewport));
  if (fromModel !== null && fromModel >= 0) {
    idx = fromModel;
    via = 'model';
  } else idx = bestByWords(page.blocks, text, viewport);
  if (idx < 0) return { ok: true, found: false, via };
  await B.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (i: number) => {
      const w = window as unknown as Marked;
      w.__qfPickElement = w.__qfDescribeEls?.[i] ?? null;
    },
    args: [idx],
  } as chrome.scripting.ScriptInjection<[number], void>);
  const started = await startPicker(tabId);
  return started.ok ? { ok: true, found: true, via } : { ok: false, error: started.error };
}

// ---------- zap mode (remove elements until the page is reloaded; nothing saved) ----------

/** Opens zap mode in the top frame; with `fromContext`, the right-clicked element is removed at once. */
export async function startZap(tabId: number, fromContext = false): Promise<{ ok: boolean; error?: string }> {
  try {
    if (fromContext) {
      await B.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          const w = window as unknown as Marked & { __qfZapElement?: Element | null };
          w.__qfZapElement = w.__qfContextTarget ?? null;
        },
      } as chrome.scripting.ScriptInjection<[], void>);
    }
    await B.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['zap.js'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
