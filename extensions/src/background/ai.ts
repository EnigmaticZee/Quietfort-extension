// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// On-device AI (opt-in, local only): Chrome's built-in Prompt API
// (`LanguageModel`, Chrome's built-in model). Content scripts send pruned page snippets
// here; they go to the local model only — never over the network. When the
// model is unavailable (Firefox, Safari, unsupported hardware, not
// downloaded) every caller falls back to its deterministic mode.
//
// Tests may install a stub model (diagnostics handle / e2e relay); it answers
// from a fixed table and is never active unless set explicitly.

import { B, log } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import { readSponsoredAnswer, SPONSORED_SCHEMA, SPONSORED_SYSTEM } from '../shared/sponsored.ts';
import { readScamAnswer, SCAM_SCHEMA, SCAM_SYSTEM } from '../shared/scam.ts';
import { COOKIE_SYSTEM, CookieLocks, cookieSchema, validatePlan } from '../shared/clickplan.ts';
import type { Clickable, PlanStep } from '../shared/clickplan.ts';
import { disabledSites, getSettings, isDisabledIn, siteKey } from './state.ts';
import { DESCRIBE_SYSTEM, describePrompt, describeSchema, readDescribeAnswer } from '../shared/describe.ts';
import type { BlockSummary } from '../shared/describe.ts';

export type Task = 'sponsored' | 'scam' | 'cookie' | 'describe';
export type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api';

interface StubRule {
  task: Task;
  /** Prompt must contain this text (any when absent). */
  contains?: string;
  result: unknown;
}

export interface ModelStub {
  available: boolean;
  rules: StubRule[];
}

let stub: ModelStub | null = null;
export const modelCalls: Record<Task, number> = { sponsored: 0, scam: 0, cookie: 0, describe: 0 };
const lastPrompts: Array<{ task: Task; prompt: string; ms?: number; createMs?: number; out?: string; error?: string }> = [];

export function setModelStub(s: ModelStub | null): void {
  stub = s && typeof s === 'object' ? { available: s.available !== false, rules: Array.isArray(s.rules) ? s.rules : [] } : null;
  modelCalls.sponsored = modelCalls.scam = modelCalls.cookie = modelCalls.describe = 0;
  lastPrompts.length = 0;
}

export function modelDebug() {
  return { stub: !!stub, calls: { ...modelCalls }, lastPrompts: lastPrompts.slice(-10) };
}

interface LMSession {
  prompt(input: string, opts?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
interface LMStatic {
  availability(opts?: unknown): Promise<string>;
  create(opts?: unknown): Promise<LMSession>;
}

const LM_OPTS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

function lm(): LMStatic | null {
  const g = globalThis as unknown as { LanguageModel?: LMStatic };
  return g.LanguageModel && typeof g.LanguageModel.availability === 'function' ? g.LanguageModel : null;
}

export async function modelAvailability(): Promise<Availability> {
  if (stub) return stub.available ? 'available' : 'unavailable';
  const api = lm();
  if (!api) return 'no-api';
  try {
    const a = await api.availability(LM_OPTS);
    return (['available', 'downloadable', 'downloading', 'unavailable'].includes(a) ? a : 'unavailable') as Availability;
  } catch (err) {
    log('LanguageModel.availability failed', String(err));
    return 'unavailable';
  }
}

const SYSTEM: Record<Task, string> = { sponsored: SPONSORED_SYSTEM, scam: SCAM_SYSTEM, cookie: COOKIE_SYSTEM, describe: DESCRIBE_SYSTEM };

let queue: Promise<unknown> = Promise.resolve();

/** One prompt, JSON-constrained, serialised; resolves to the parsed JSON or null. */
async function prompt(task: Task, input: string, schema: unknown): Promise<unknown> {
  modelCalls[task]++;
  const entry: (typeof lastPrompts)[number] = { task, prompt: input.slice(0, 2000) };
  lastPrompts.push(entry);
  if (lastPrompts.length > 30) lastPrompts.shift();
  if (stub) {
    if (!stub.available) return null;
    const r = stub.rules.find((x) => x.task === task && (!x.contains || input.includes(x.contains)));
    return r ? r.result : null;
  }
  const api = lm();
  if (!api || (await modelAvailability()) !== 'available') return null;
  const run = queue.then(async () => {
    const c0 = Date.now();
    const session = await api.create({ ...LM_OPTS, initialPrompts: [{ role: 'system', content: SYSTEM[task] }] });
    entry.createMs = Date.now() - c0;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    const t0 = Date.now();
    try {
      const out = await session.prompt(input, { responseConstraint: schema, signal: ctl.signal });
      entry.ms = Date.now() - t0;
      entry.out = out.slice(0, 300);
      return JSON.parse(out) as unknown;
    } finally {
      clearTimeout(timer);
      session.destroy();
    }
  });
  queue = run.catch(() => undefined);
  try {
    return await run;
  } catch (err) {
    entry.error = String(err).slice(0, 200);
    log(`model ${task} failed`, String(err));
    return null;
  }
}

// ---------- tasks ----------

export async function classifySponsored(input: string): Promise<boolean | null> {
  return readSponsoredAnswer(await prompt('sponsored', String(input).slice(0, 2500), SPONSORED_SCHEMA));
}

export async function confirmScam(input: string): Promise<{ scam: boolean; reason: string } | null> {
  return readScamAnswer(await prompt('scam', String(input).slice(0, 3000), SCAM_SCHEMA));
}

/** Next click for a consent banner: a selector from `offered`, or null. Validated by the caller too. */
export async function nextCookieClick(input: string, offered: Clickable[]): Promise<string | null> {
  const r = (await prompt('cookie', String(input).slice(0, 4000), cookieSchema(offered))) as { selector?: unknown } | null;
  if (!r || typeof r.selector !== 'string' || r.selector === 'none') return null;
  return r.selector;
}

/** "Describe it to hide it": the block the model picks for `description` (index into `blocks`), or -1 / null without a model. */
export async function describeWithModel(description: string, blocks: BlockSummary[], order: number[]): Promise<number | null> {
  if ((await modelAvailability()) !== 'available') return null;
  const r = await prompt('describe', describePrompt(description, blocks, order), describeSchema(order.length));
  return r === null ? null : readDescribeAnswer(r, order);
}

// ---------- per-site caches ----------

interface SiteAiCache {
  /** Sponsored-filter verdicts: cosmetic selector → hide (true) / keep (false). */
  sponsored: Record<string, boolean>;
  cookiePlan?: PlanStep[];
  /** Where the plan runs: '' = the top frame, else the consent iframe's host (plans are stored under the top-level site). */
  cookiePlanScope?: string;
  at: number;
}

const MAX_SITES = 500;
const MAX_RULES_PER_SITE = 200;

async function loadCache(): Promise<Record<string, SiteAiCache>> {
  const { aiCache = {} } = (await B.storage.local.get('aiCache')) as { aiCache?: Record<string, SiteAiCache> };
  return aiCache;
}

let writeChain: Promise<unknown> = Promise.resolve();
function updateCache(site: string, fn: (c: SiteAiCache) => void): Promise<void> {
  const run = writeChain.then(async () => {
    const all = await loadCache();
    const c = all[site] ?? { sponsored: {}, at: 0 };
    fn(c);
    c.at = Date.now();
    all[site] = c;
    const keys = Object.keys(all);
    if (keys.length > MAX_SITES) {
      keys.sort((a, b) => all[a]!.at - all[b]!.at).slice(0, keys.length - MAX_SITES).forEach((k) => delete all[k]);
    }
    await B.storage.local.set({ aiCache: all });
  });
  writeChain = run.catch(() => undefined);
  return run;
}

function senderSite(sender: chrome.runtime.MessageSender): string | null {
  if (sender.frameId !== 0 || !sender.url || !/^https?:/i.test(sender.url)) return null;
  const h = hostOf(sender.url);
  return h ? siteKey(h) : null;
}

/** A subframe's id, or null for the top frame / an unknown frame (Safari without frameId: fail closed). */
function subframeId(sender: chrome.runtime.MessageSender): number | null {
  return typeof sender.frameId === 'number' && sender.frameId > 0 && sender.tab?.id !== undefined ? sender.frameId : null;
}

/** Host of a subframe sender's own document. */
function frameHost(sender: chrome.runtime.MessageSender): string | null {
  return sender.url && /^https?:/i.test(sender.url) ? hostOf(sender.url) || null : null;
}

/**
 * The site the cookie flow belongs to: the TOP-level site, for the top frame and for
 * consent iframes alike (Sourcepoint / iubenda hosts are shared by many sites).
 */
async function cookieSite(sender: chrome.runtime.MessageSender): Promise<{ site: string; scope: string; frameHost: string | null } | null> {
  if (sender.frameId === 0) {
    const site = senderSite(sender);
    return site ? { site, scope: '', frameHost: null } : null;
  }
  const fid = subframeId(sender);
  const fh = frameHost(sender);
  if (fid === null || !fh) return null;
  let top = sender.tab?.url;
  if (!top) top = await B.tabs.get(sender.tab!.id!).then((t) => t.url, () => undefined);
  if (!top || !/^https?:/i.test(top)) return null;
  const th = hostOf(top);
  return th ? { site: siteKey(th), scope: fh, frameHost: fh } : null;
}

/** Cookie plans on, banners handling on, neither the top site nor the frame's host switched off. */
async function cookiePlansAllowed(c: { site: string; frameHost: string | null }): Promise<boolean> {
  const s = await getSettings();
  if (!s.ai.cookiePlans || s.cookieBanners === false) return false;
  const disabled = await disabledSites();
  return !isDisabledIn(disabled, c.site) && !(c.frameHost && isDisabledIn(disabled, c.frameHost));
}

/** Content script hello: which AI features run here, and this site's cache. Subframes only ever get the cookie-plan feature. */
export async function aiInit(sender: chrome.runtime.MessageSender) {
  const off = { sponsored: false, scam: false, cookiePlans: false, model: 'unavailable' as Availability, sponsoredRules: {}, cookiePlan: null };
  if (sender.frameId !== 0) {
    const c = await cookieSite(sender);
    if (!c || !(await cookiePlansAllowed(c))) return off;
    const cache = (await loadCache())[c.site];
    return { ...off, cookiePlans: true, model: await modelAvailability(), cookiePlan: cache?.cookiePlan && (cache.cookiePlanScope ?? '') === c.scope ? cache.cookiePlan : null };
  }
  const site = senderSite(sender);
  const s = await getSettings();
  if (!site || isDisabledIn(await disabledSites(), site)) return off;
  const ai = s.ai;
  if (!ai.sponsored && !ai.scam && !ai.cookiePlans) return off;
  const cache = (await loadCache())[site];
  return {
    sponsored: ai.sponsored,
    scam: ai.scam,
    cookiePlans: ai.cookiePlans && s.cookieBanners !== false,
    model: await modelAvailability(),
    sponsoredRules: cache?.sponsored ?? {},
    cookiePlan: cache?.cookiePlan && !cache.cookiePlanScope ? cache.cookiePlan : null,
  };
}

export async function saveSponsoredVerdicts(sender: chrome.runtime.MessageSender, verdicts: unknown): Promise<number> {
  const site = senderSite(sender);
  if (!site || !Array.isArray(verdicts)) return 0;
  const clean = verdicts
    .filter((v): v is { selector: string; hide: boolean } => !!v && typeof v.selector === 'string' && v.selector.length < 400 && typeof v.hide === 'boolean')
    .slice(0, 50);
  if (!clean.length) return 0;
  await updateCache(site, (c) => {
    for (const v of clean) c.sponsored[v.selector] = v.hide;
    const keys = Object.keys(c.sponsored);
    if (keys.length > MAX_RULES_PER_SITE) keys.slice(0, keys.length - MAX_RULES_PER_SITE).forEach((k) => delete c.sponsored[k]);
  });
  return clean.length;
}

/** Store a cookie plan that worked (re-validated here; the content script validated each step against the live page). */
export async function saveCookiePlan(sender: chrome.runtime.MessageSender, steps: unknown, offered: unknown): Promise<boolean> {
  const c = await cookieSite(sender);
  if (!c || !Array.isArray(offered)) return false;
  if (c.scope && !locks.holds(sender.tab!.id!, sender.frameId!, Date.now())) return false;
  return storePlan(c.site, c.scope, steps, offered as Clickable[][]);
}

async function storePlan(site: string, scope: string, steps: unknown, offered: Clickable[][]): Promise<boolean> {
  const v = validatePlan(steps, offered);
  if (!v.ok) {
    log('cookie plan refused', v.reason);
    return false;
  }
  await updateCache(site, (c) => {
    c.cookiePlan = v.steps;
    if (scope) c.cookiePlanScope = scope;
    else delete c.cookiePlanScope;
  });
  return true;
}

/** Drop this site's plan, but only one stored for the same frame (a frame's failed replay must not drop the top frame's plan). */
export async function forgetCookiePlan(sender: chrome.runtime.MessageSender): Promise<void> {
  const c = await cookieSite(sender);
  if (!c) return;
  await updateCache(c.site, (x) => {
    if ((x.cookiePlanScope ?? '') === c.scope) {
      delete x.cookiePlan;
      delete x.cookiePlanScope;
    }
  });
}

// ---------- one cookie flow per tab (top frame or one consent iframe) ----------

const locks = new CookieLocks();

interface PendingClick {
  frameId: number;
  site: string;
  scope: string;
  kind: 'reject' | 'navigate';
  /** The reject text reads as nothing but a reject (worth caching when the frame closes on it). */
  clear: boolean;
  steps: unknown;
  offered: unknown;
  texts: string[];
  at: number;
  /** Last message from that frame's content script. */
  seen: number;
}
const pendingClicks = new Map<number, PendingClick>();

/** Ask the top frame whether an iframe of this origin is large, on screen and not hidden by CSS. */
async function parentView(tabId: number, origin: string): Promise<'visible' | 'hidden' | 'unknown'> {
  try {
    const r = (await B.tabs.sendMessage(tabId, { type: 'bg:frameBoxes', origin }, { frameId: 0 })) as { verdict?: string } | undefined;
    return r?.verdict === 'visible' || r?.verdict === 'hidden' ? r.verdict : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Does the frame still hold the same document (it may have been removed or navigated by the click)? */
async function frameAlive(tabId: number, frameId: number, url: string): Promise<boolean | null> {
  try {
    const frames = await B.webNavigation.getAllFrames({ tabId });
    if (!frames) return null;
    const f = frames.find((x) => x.frameId === frameId);
    return !!f && f.url === url;
  } catch {
    return null;
  }
}

/**
 * Lock operations from a content script running the cookie flow:
 *   acquire — before the first click (re-checks the opt-in and per-site switches; for a
 *             subframe also asks the top frame whether that iframe is really visible);
 *   click   — right before each click (a consent iframe is usually removed by its own reject
 *             click, so the background finishes the flow when the frame goes away);
 *   release — flow ended without a reject; done — flow rejected (nobody else acts on this page).
 */
export async function cookieLock(sender: chrome.runtime.MessageSender, msg: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (tabId === undefined || typeof frameId !== 'number' || frameId < 0) return { ok: false, reason: 'no frame id' };
  const now = Date.now();
  const p = pendingClicks.get(tabId);
  if (p && p.frameId === frameId) p.seen = now;
  switch (msg.op) {
    case 'acquire': {
      const c = await cookieSite(sender);
      if (!c || !(await cookiePlansAllowed(c))) return { ok: false, reason: 'off' };
      if (frameId > 0) {
        const origin = (() => {
          try {
            return new URL(sender.url!).origin;
          } catch {
            return '';
          }
        })();
        if ((await parentView(tabId, origin)) === 'hidden') return { ok: false, reason: 'iframe hidden in the page' };
      }
      return locks.acquire(tabId, frameId, Date.now());
    }
    case 'renew':
      return locks.renew(tabId, frameId, now);
    case 'release':
      if (p?.frameId === frameId) pendingClicks.delete(tabId);
      return { ok: locks.release(tabId, frameId, now) };
    case 'done':
      if (p?.frameId === frameId) pendingClicks.delete(tabId);
      return { ok: locks.finish(tabId, frameId, now) };
    case 'click': {
      if (!locks.renew(tabId, frameId, now).ok) return { ok: false, reason: 'not-holder' };
      if (frameId === 0) return { ok: true };
      const c = await cookieSite(sender);
      if (!c) return { ok: false, reason: 'no site' };
      const texts = Array.isArray(msg.texts) ? (msg.texts as unknown[]).map((t) => String(t).slice(0, 80)).slice(0, 5) : [];
      pendingClicks.set(tabId, { frameId, site: c.site, scope: c.scope, kind: msg.kind === 'reject' ? 'reject' : 'navigate', clear: msg.clear === true, steps: msg.steps, offered: msg.offered, texts, at: now, seen: now });
      setTimeout(() => void settleFrameClick(tabId, frameId, sender.url ?? '', now), 2500);
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'bad op' };
  }
}

/** After a click in a consent iframe: if that frame's script went away, finish the flow on its behalf. */
async function settleFrameClick(tabId: number, frameId: number, url: string, clickAt: number, retry = 0): Promise<void> {
  const p = pendingClicks.get(tabId);
  if (!p || p.frameId !== frameId || p.at !== clickAt) return;
  if (p.seen > clickAt) return; // the frame's script is alive and reports itself
  const alive = await frameAlive(tabId, frameId, url);
  if (alive && (retry < 1 || locks.isBusy(tabId, frameId))) {
    setTimeout(() => void settleFrameClick(tabId, frameId, url, clickAt, retry + 1), 3000);
    return;
  }
  if (pendingClicks.get(tabId) !== p || p.seen > clickAt) return;
  pendingClicks.delete(tabId);
  const now = Date.now();
  if (alive) {
    // Still there but silent: give the flow up.
    locks.release(tabId, frameId, now);
    aiReport(tabId, { cookie: { banner: true, frame: true, steps: p.texts, result: 'frame-stalled' } }, frameId);
    return;
  }
  if (p.kind === 'reject') {
    // The consent iframe closed on a reject click: the banner is gone.
    const saved = p.clear ? await storePlan(p.site, p.scope, p.steps, (Array.isArray(p.offered) ? p.offered : []) as Clickable[][]).catch(() => false) : false;
    aiReport(tabId, { cookie: { banner: true, frame: true, steps: p.texts, result: 'rejected', frameClosed: true, saved } }, frameId);
    locks.finish(tabId, frameId, now);
  } else {
    // A settings opener replaced the frame (Sourcepoint opens its privacy manager in a new iframe): let the next frame continue.
    aiReport(tabId, { cookie: { banner: true, frame: true, steps: p.texts, result: 'frame-closed' } }, frameId);
    locks.release(tabId, frameId, now);
  }
}

/** Model call for the cookie flow: only for the frame holding this tab's lock. */
export async function cookieClickFor(sender: chrome.runtime.MessageSender, input: string, offered: Clickable[]): Promise<string | null> {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (tabId === undefined || typeof frameId !== 'number') return null;
  if (!locks.holds(tabId, frameId, Date.now())) return null;
  const p = pendingClicks.get(tabId);
  if (p && p.frameId === frameId) p.seen = Date.now();
  locks.busy(tabId, frameId, true, Date.now());
  try {
    return await nextCookieClick(input, offered);
  } finally {
    locks.busy(tabId, frameId, false, Date.now());
  }
}

/** May this sender report cookie status? The top frame always; a subframe while it holds (or held) the flow. */
export function mayReportCookie(sender: chrome.runtime.MessageSender): boolean {
  const tabId = sender.tab?.id;
  if (tabId === undefined || typeof sender.frameId !== 'number') return false;
  if (sender.frameId === 0) return true;
  return locks.owner(tabId, Date.now()) === sender.frameId;
}

export async function clearAiCache(): Promise<void> {
  await B.storage.local.remove('aiCache');
}

// ---------- scam-signal hook (page main world) ----------

/**
 * Counts browser-lock behaviour (fullscreen, beforeunload, history spam,
 * dialogs, keyboard/pointer lock) and posts the counts to the content script.
 * Only counts; changes nothing.
 */
function scamSignalHook(): void {
  const w = window as unknown as { __adbScamHook?: boolean };
  if (w.__adbScamHook) return;
  w.__adbScamHook = true;
  const c = { fullscreen: 0, beforeunload: 0, history: 0, dialogs: 0, inputLock: 0 };
  let timer = 0;
  const post = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      window.postMessage({ __adbScamSig: 1, counts: c }, '*');
    }, 50);
  };
  const wrap = <T extends object>(obj: T | undefined, name: string, key: keyof typeof c) => {
    if (!obj) return;
    const orig = (obj as Record<string, unknown>)[name];
    if (typeof orig !== 'function') return;
    (obj as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      c[key]++;
      post();
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  wrap(Element.prototype, 'requestFullscreen', 'fullscreen');
  wrap(Element.prototype, 'webkitRequestFullscreen', 'fullscreen');
  wrap(History.prototype, 'pushState', 'history');
  wrap(History.prototype, 'replaceState', 'history');
  wrap(window, 'alert', 'dialogs');
  wrap(window, 'confirm', 'dialogs');
  wrap(window, 'prompt', 'dialogs');
  wrap(Element.prototype, 'requestPointerLock', 'inputLock');
  const kb = (navigator as unknown as { keyboard?: object }).keyboard;
  if (kb) wrap(Object.getPrototypeOf(kb) as object, 'lock', 'inputLock');
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
    if (type === 'beforeunload' && this === window) {
      c.beforeunload++;
      post();
    }
    return (add as (...a: unknown[]) => void).call(this, type, ...rest);
  } as typeof add;
  const d = Object.getOwnPropertyDescriptor(Window.prototype, 'onbeforeunload') ?? Object.getOwnPropertyDescriptor(window, 'onbeforeunload');
  if (d?.set) {
    const set = d.set;
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true,
      get: d.get ? () => d.get!.call(window) : undefined,
      set(v) {
        if (v) {
          c.beforeunload++;
          post();
        }
        set.call(window, v);
      },
    });
  }
}

export function registerAi(): void {
  B.webNavigation?.onCommitted.addListener((d) => {
    if (d.frameId !== 0 || !/^https?:/i.test(d.url)) return;
    void (async () => {
      const s = await getSettings();
      if (!s.ai.scam) return;
      const h = hostOf(d.url);
      if (!h || isDisabledIn(await disabledSites(), h)) return;
      await B.scripting.executeScript({ target: { tabId: d.tabId, frameIds: [0] }, world: 'MAIN', injectImmediately: true, func: scamSignalHook } as chrome.scripting.ScriptInjection<[], void>);
    })().catch((err) => log('scam hook injection failed', String(err)));
  });
}

// ---------- per-tab status (popup / diagnostics) ----------

const tabStatus = new Map<number, Record<string, unknown>>();

/**
 * Merge a content script's status patch. Subframes (frameId > 0) may only report
 * `cookie`; a "no banner here" never overwrites a banner another frame is handling.
 */
export function aiReport(tabId: number, patch: unknown, frameId = 0): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const cur = tabStatus.get(tabId) ?? {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!['sponsored', 'scam', 'cookie'].includes(k) || !v || typeof v !== 'object') continue;
    if (frameId !== 0 && k !== 'cookie') continue;
    const j = JSON.stringify(frameId !== 0 ? { ...(v as object), frame: true } : v);
    if (j.length >= 4000) continue;
    const next = JSON.parse(j) as Record<string, unknown>;
    const prev = cur[k] as Record<string, unknown> | undefined;
    if (k === 'cookie' && next.banner === false && prev?.banner === true) continue;
    cur[k] = next;
  }
  tabStatus.set(tabId, cur);
  return true;
}

export function aiTabStatus(tabId: number): Record<string, unknown> | null {
  return tabStatus.get(tabId) ?? null;
}

export function resetAiTab(tabId: number): void {
  tabStatus.delete(tabId);
  locks.reset(tabId);
  pendingClicks.delete(tabId);
}
