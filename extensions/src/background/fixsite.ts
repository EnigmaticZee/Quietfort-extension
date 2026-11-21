// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// "Fix this site": collect the rules that acted on the page, rank them by
// breakage risk, bisect with reloads (asking the user, or deciding from the
// triggering JavaScript error), and turn the culprit(s) into narrow, expiring
// site exceptions. One session at a time; its state lives in storage.session
// so a service-worker restart between reloads does not lose it.

import { B, log } from './api.ts';
import { now } from './clock.ts';
import { getEngine, siteKey } from './state.ts';
import { addExceptions, setTrialLines } from './sitefixes.ts';
import { clearSignals, markOwnReload, recordExplicit, signalsFor, tabEvidence } from './tabdata.ts';
import { answer, newBisect, nextStep } from '../shared/bisect.ts';
import type { BisectPhase, BisectState, BisectStep } from '../shared/bisect.ts';
import { cosmeticExceptionLine, networkExceptionLines, newException, scriptletExceptionLine } from '../shared/exceptions.ts';
import type { SiteException } from '../shared/exceptions.ts';
import { networkTier, rankCandidates, TIER, TIER_NAMES } from '../shared/risk.ts';
import type { BreakageCandidate } from '../shared/risk.ts';
import { hostOf } from '../shared/domain.ts';
import { parseLine } from '../shared/parse.ts';
import { typeFromWebRequest } from '../shared/types.ts';
import type { NetworkRule } from '../shared/types.ts';

export type FixPhase = 'reloading' | 'question' | 'done' | 'failed' | 'cancelled';

export interface FixSession {
  tabId: number;
  url: string;
  host: string;
  site: string;
  mode: 'ask' | 'auto';
  /** Signature of the JavaScript error that triggered an automatic fix. */
  signature: string | null;
  candidates: BreakageCandidate[];
  bisect: BisectState;
  phase: FixPhase;
  disabled: number[];
  stepPhase: BisectPhase | null;
  reloadAt: number;
  startedAt: number;
  steps: Array<{ disabled: number; works: boolean; auto: boolean }>;
  result: SiteException[] | null;
  message: string | null;
}

/** Wait after `load` before judging the page (late scripts, error events). */
export const SETTLE_MS = 1200;
const RELOAD_TIMEOUT_MS = 15000;

let session: FixSession | null = null;
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  loaded ??= B.storage.session.get('fixSession').then((s) => {
    session ??= (s.fixSession as FixSession | undefined) ?? null;
  }, () => undefined);
  return loaded;
}

async function save(): Promise<void> {
  await B.storage.session.set({ fixSession: session });
}

const isRunning = (s: FixSession | null): s is FixSession => !!s && (s.phase === 'reloading' || s.phase === 'question');

// ---------- candidates ----------

async function presentSelectors(tabId: number, sels: string[]): Promise<Set<string> | null> {
  if (!sels.length) return new Set();
  try {
    const [res] = await B.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (list: string[]) => list.filter((s) => {
        try {
          return document.querySelector(s) !== null;
        } catch {
          return false;
        }
      }),
      args: [sels],
    } as chrome.scripting.ScriptInjection<[string[]], string[]>);
    return new Set((res?.result as string[] | undefined) ?? []);
  } catch (err) {
    log('selector probe failed', String(err));
    return null;
  }
}

export async function collectCandidates(tabId: number): Promise<{ host: string; site: string; url: string; candidates: BreakageCandidate[] } | null> {
  const tab = await B.tabs.get(tabId);
  const url = tab.url ?? '';
  if (!/^https?:/i.test(url)) return null;
  const host = hostOf(url);
  const site = siteKey(host);
  const engine = await getEngine();
  if (!engine) return { host, site, url, candidates: [] };
  const ev = await tabEvidence(tabId);
  const out: BreakageCandidate[] = [];

  for (const s of engine.scriptlets(host)) {
    const call = `+js(${[s.name, ...s.args].join(', ')})`;
    out.push({ id: `scriptlet:${call}`, kind: 'scriptlet', tier: TIER.SCRIPTLET, rule: `${site}##${call}`, lines: [scriptletExceptionLine(site, s)] });
  }

  const cos = engine.cosmeticsFor(host);
  const specific = cos?.specific ?? [];
  const generic = [...new Set([...(cos?.generic ?? []), ...ev.genericSelectors])];
  const present = await presentSelectors(tabId, [...specific, ...generic]);
  const shown = (sel: string) => present === null || present.has(sel);
  for (const sel of engine.procedural(host)) {
    out.push({ id: `cosmetic:${sel}`, kind: 'cosmetic', tier: TIER.COSMETIC_SPECIFIC, rule: `${site}##${sel}`, lines: [cosmeticExceptionLine(site, sel)] });
  }
  for (const sel of specific) {
    if (shown(sel)) out.push({ id: `cosmetic:${sel}`, kind: 'cosmetic', tier: TIER.COSMETIC_SPECIFIC, rule: `${site}##${sel}`, lines: [cosmeticExceptionLine(site, sel)] });
  }
  for (const sel of generic) {
    if (present?.has(sel)) out.push({ id: `cosmetic:${sel}`, kind: 'cosmetic', tier: TIER.COSMETIC_GENERIC, rule: `##${sel}`, lines: [cosmeticExceptionLine(site, sel)] });
  }

  const byRule = new Map<string, { urls: string[]; tier: number }>();
  for (const b of ev.blocked) {
    let raw = b.rule;
    if (!raw) {
      const v = engine.check({ url: b.url, sourceHost: b.src ?? host, type: typeFromWebRequest(b.type) });
      if (v.action !== 'block') continue;
      raw = v.rule;
    }
    const tier = networkTier(hostOf(b.url), host);
    const g = byRule.get(raw);
    if (g) {
      if (!g.urls.includes(b.url)) g.urls.push(b.url);
      g.tier = Math.min(g.tier, tier);
    } else byRule.set(raw, { urls: [b.url], tier });
  }
  for (const [raw, g] of byRule) {
    const p = parseLine(raw);
    if (p.kind !== 'network') continue;
    const lines = networkExceptionLines({ rule: p.rule as NetworkRule, urls: g.urls, site, adNetwork: g.tier === TIER.NETWORK_AD });
    out.push({ id: `network:${raw}`, kind: 'network', tier: g.tier, rule: raw, lines, detail: g.urls.slice(0, 3).join(' ') });
  }
  return { host, site, url, candidates: rankCandidates(out) };
}

// ---------- session ----------

function trialLines(s: FixSession): string[] {
  return s.disabled.flatMap((i) => s.candidates[i]?.lines ?? []);
}

function failureMessage(reason: string): string {
  switch (reason) {
    case 'no-candidates': return 'Nothing was blocked or hidden on this page, so blocking is not what broke it.';
    case 'not-caused-by-rules': return 'The page stays broken even with every rule that acted on it switched off, so blocking is not the cause. Nothing was changed.';
    case 'too-many-steps': return 'Could not narrow it down. Nothing was changed; you can pause blocking on this site instead.';
    case 'inconsistent-answers': return 'The answers contradicted each other, so nothing was changed. Try again when the page behaves consistently.';
    default: return 'Could not find the cause. Nothing was changed.';
  }
}

async function advance(step: BisectStep): Promise<void> {
  const s = session!;
  if (step.type === 'test') {
    s.disabled = step.disable;
    s.stepPhase = step.phase;
    s.phase = 'reloading';
    s.reloadAt = Date.now();
    await save();
    await setTrialLines(trialLines(s));
    markOwnReload(s.tabId);
    await B.tabs.reload(s.tabId, { bypassCache: true });
    return;
  }
  if (step.type === 'done') return finalize(step.culprits);
  s.phase = 'failed';
  s.message = failureMessage(step.reason);
  s.disabled = [];
  await save();
  await setTrialLines([]);
  markOwnReload(s.tabId);
  await B.tabs.reload(s.tabId).catch(() => undefined);
}

async function finalize(culprits: number[]): Promise<void> {
  const s = session!;
  const signals = [...new Set((await signalsFor(s.tabId, s.site)).map((x) => x.kind))];
  const t = now();
  const items = culprits.map((i) => s.candidates[i]!).map((c) => newException({
    kind: c.kind,
    site: s.site,
    rule: c.rule,
    lines: c.lines,
    reason: `Fix this site on ${s.url} (${s.mode === 'auto' ? 'decided automatically from the page error' : 'confirmed by you'}; ${s.steps.length} step${s.steps.length === 1 ? '' : 's'}; ${TIER_NAMES[c.tier]}; signals: ${signals.join(', ') || 'none'})`,
  }, t));
  // Exceptions first, then drop the trial: the page never loses the fix in between.
  await addExceptions(items);
  s.phase = 'done';
  s.result = items;
  s.disabled = [];
  s.message = null;
  await save();
  await setTrialLines([]);
  clearSignals(s.tabId, s.site);
  log('fix-this-site applied', items.map((e) => e.lines).flat());
}

export async function startFix(tabId: number, opts: { mode?: 'ask' | 'auto' } = {}): Promise<FixStatus> {
  await load();
  if (isRunning(session)) await cancelFix(session.tabId, false);
  await recordExplicit(tabId, now());
  const c = await collectCandidates(tabId);
  if (!c) return { active: false, phase: 'failed', message: 'This page cannot be fixed (not a web page).' } as FixStatus;
  const ev = await tabEvidence(tabId);
  const lastError = ev.errors[ev.errors.length - 1];
  const mode = opts.mode ?? (lastError ? 'auto' : 'ask');
  session = {
    tabId, url: c.url, host: c.host, site: c.site, mode, signature: mode === 'auto' ? lastError?.signature ?? null : null,
    candidates: c.candidates, bisect: newBisect(c.candidates.length), phase: 'reloading', disabled: [], stepPhase: null,
    reloadAt: 0, startedAt: now(), steps: [], result: null, message: null,
  };
  if (session.mode === 'auto' && !session.signature) session.mode = 'ask';
  log('fix-this-site start', { tab: tabId, mode: session.mode, candidates: c.candidates.map((x) => `${x.tier} ${x.rule}`) });
  const first = nextStep(session.bisect);
  if (first.type === 'failed') {
    session.phase = 'failed';
    session.message = failureMessage(first.reason);
    await save();
    return fixStatus(tabId);
  }
  await advance(first);
  return fixStatus(tabId);
}

async function decide(works: boolean, auto: boolean): Promise<void> {
  const s = session!;
  s.steps.push({ disabled: s.disabled.length, works, auto });
  await advance(answer(s.bisect, works));
}

export async function answerFix(tabId: number, works: boolean): Promise<FixStatus> {
  await load();
  if (!session || session.tabId !== tabId || session.phase !== 'question') return { ...(await fixStatus(tabId)), error: 'no question pending' };
  await decide(works, false);
  return fixStatus(tabId);
}

export async function cancelFix(tabId: number, reload = true): Promise<FixStatus> {
  await load();
  if (isRunning(session) && session.tabId === tabId) {
    session.phase = 'cancelled';
    session.disabled = [];
    session.message = 'Cancelled. Nothing was changed.';
    await save();
    await setTrialLines([]);
    if (reload) {
      markOwnReload(tabId);
      await B.tabs.reload(tabId).catch(() => undefined);
    }
  }
  return fixStatus(tabId);
}

/** The tab finished loading. Judge a fix step once the page settles. */
export function onTopCompleted(tabId: number, at: number): void {
  void load().then(() => {
    const s = session;
    if (!isRunning(s) || s.tabId !== tabId || s.phase !== 'reloading' || at < s.reloadAt - 1000) return;
    const reloadAt = s.reloadAt;
    setTimeout(() => void settle(tabId, reloadAt), SETTLE_MS);
  });
}

async function settle(tabId: number, reloadAt: number): Promise<void> {
  await load();
  const s = session;
  if (!isRunning(s) || s.tabId !== tabId || s.phase !== 'reloading' || s.reloadAt !== reloadAt) return;
  const adCulprit = s.disabled.some((i) => s.candidates[i]?.tier === TIER.NETWORK_AD);
  if (s.mode === 'auto' && s.signature && !(s.stepPhase === 'confirm' && adCulprit)) {
    const errs = (await tabEvidence(tabId)).errors.filter((e) => e.at >= reloadAt);
    const works = !errs.some((e) => e.signature === s.signature);
    await decide(works, true);
    return;
  }
  s.phase = 'question';
  await save();
}

/** A navigation that is not ours ends a running fix (the trial must not stick). */
export function onTopCommitted(tabId: number, url: string, own: boolean): void {
  void load().then(async () => {
    const s = session;
    if (!isRunning(s) || s.tabId !== tabId || own) return;
    if (url.split('#')[0] !== s.url.split('#')[0]) await cancelFix(tabId, false);
  });
}

export function onTabRemoved(tabId: number): void {
  void load().then(async () => {
    if (isRunning(session) && session.tabId === tabId) await cancelFix(tabId, false);
  });
}

export interface FixStatus {
  active: boolean;
  phase: FixPhase | 'idle';
  mode?: 'ask' | 'auto';
  step?: number;
  total?: number;
  testing?: string[];
  question?: boolean;
  confirm?: boolean;
  result?: SiteException[] | null;
  message?: string | null;
  candidates?: Array<{ rule: string; tier: string }>;
  error?: string;
}

export async function fixStatus(tabId: number): Promise<FixStatus> {
  await load();
  const s = session;
  if (!s || s.tabId !== tabId) return { active: false, phase: 'idle' };
  if (s.phase === 'reloading' && Date.now() - s.reloadAt > RELOAD_TIMEOUT_MS) {
    // The load event never came (or was missed): ask instead of waiting forever.
    s.phase = 'question';
    await save();
  }
  return {
    active: isRunning(s),
    phase: s.phase,
    mode: s.mode,
    step: s.bisect.asked + 1,
    total: s.candidates.length,
    testing: s.disabled.map((i) => s.candidates[i]!.rule).slice(0, 20),
    question: s.phase === 'question',
    confirm: s.stepPhase === 'confirm',
    result: s.result,
    message: s.message,
    candidates: s.candidates.map((c) => ({ rule: c.rule, tier: TIER_NAMES[c.tier]! })),
  };
}

/** Is `tabId` in the middle of a fix (for the reload signal)? */
export async function fixRunningIn(tabId: number): Promise<boolean> {
  await load();
  return isRunning(session) && session.tabId === tabId;
}
