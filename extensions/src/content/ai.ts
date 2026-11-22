// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// On-device AI features in the page (isolated world), all opt-in. The top frame
// runs all three; a subframe runs only the cookie plans, and only when it is a
// large, visible consent dialog (Sourcepoint / iubenda iframes):
//   - sponsored-content filter: deterministic pre-filters nominate blocks;
//     clear cases are hidden, ambiguous ones are classified by the local model
//     (verdicts cached per site + selector), and kept when there is no model;
//   - scam / scareware warning: local heuristics (+ optional model check) →
//     a non-blocking banner with "Leave page";
//   - AI cookie click plans for consent banners autoconsent left behind.
// Snippets only go to the background, which hands them to the on-device model.
// Nothing is sent over the network.

import {
  ASK_THRESHOLD, attributeDiscloses, blockTooLarge, cacheSelector, decideBlock, disclosureStrength, growsTooMuch, isAdNetworkUrl, isAffiliateUrl, isDisplayCaption, mixedFeedContainer, ownSectionWithLabelOnly, proseWithInlineLinks,
  isProtectedElement, looksLikeNavigation, scoreBlock, sponsoredPrompt, tokenHint,
} from '../shared/sponsored.ts';
import type { BlockFeatures } from '../shared/sponsored.ts';
import { scamDecision, scamPrompt, scoreScam } from '../shared/scam.ts';
import type { ScamBehaviour } from '../shared/scam.ts';
import { cookiePrompt, frameQualifies, isNavigateText, isRejectText, looksLikeConsentText, MAX_STEPS, offerToModel, parentFrameVerdict, validateStep } from '../shared/clickplan.ts';
import type { Clickable, ParentFrameBox, PlanStep, Verdict } from '../shared/clickplan.ts';
import { cssEscape, isHashLike } from '../shared/selectors.ts';
import { queryAll } from './dom.ts';

type Api = typeof chrome;
declare const __E2E__: boolean;

interface AiInit {
  sponsored: boolean;
  scam: boolean;
  cookiePlans: boolean;
  model: string;
  sponsoredRules: Record<string, boolean>;
  cookiePlan: PlanStep[] | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function whenLoaded(): Promise<void> {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((r) => window.addEventListener('load', () => r(), { once: true }));
}

function whenReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((r) => document.addEventListener('DOMContentLoaded', () => r(), { once: true }));
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
}

function textOf(el: Element): string {
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function startAi(api: Api, frame = false): void {
  const send = <T>(msg: Record<string, unknown>): Promise<T | undefined> => api.runtime.sendMessage(msg).catch(() => undefined) as Promise<T | undefined>;
  const report = (patch: Record<string, unknown>) => void send({ type: 'cs:aiReport', patch });

  void send<AiInit>({ type: 'cs:aiInit' }).then((init) => {
    if (!init) return;
    // Sponsored filter and scam check: top frame only (the background never turns them on for a subframe either).
    if (!frame && init.sponsored) void sponsoredFilter(init, send, report);
    if (!frame && init.scam) void scamWatch(init, send, report);
    if (init.cookiePlans) void cookiePlans(init, send, report, frame);
  });
}

/**
 * Top frame: how the iframe elements of `origin` look in this page (asked by the
 * background before a consent iframe may act; it cannot see its own iframe element).
 */
export function frameBoxes(origin: string): 'visible' | 'hidden' | 'unknown' {
  const boxes: ParentFrameBox[] = [];
  for (const f of [...document.querySelectorAll('iframe')].slice(0, 200)) {
    let o = '';
    try {
      o = new URL((f as HTMLIFrameElement).src, location.href).origin;
    } catch {
      continue;
    }
    if (o !== origin) continue;
    const r = f.getBoundingClientRect();
    const cv = (f as Element & { checkVisibility?: (o: unknown) => boolean }).checkVisibility;
    const styleVisible = typeof cv === 'function' ? cv.call(f, { opacityProperty: true, visibilityProperty: true }) : visible(f) && ancestorsShown(f);
    boxes.push({ origin: o, width: r.width, height: r.height, inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth, styleVisible });
  }
  return parentFrameVerdict(boxes, origin);
}

function ancestorsShown(el: Element): boolean {
  for (let cur = el.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
    const cs = getComputedStyle(cur);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) return false;
  }
  return true;
}

type Send = <T>(msg: Record<string, unknown>) => Promise<T | undefined>;
type Report = (patch: Record<string, unknown>) => void;

// ---------- sponsored content ----------

function isProtected(el: Element): boolean {
  return isProtectedElement(el.tagName, el.getAttribute('role'));
}

function containsProtected(el: Element): boolean {
  return !!el.querySelector('main, article, [role="main"], [role="article"], body');
}

/**
 * Blocks never hidden on weak grounds (all seen on real sites):
 *  - menus, headers and footers: only an ad-network frame hides them, the model is not asked (a single
 *    rel="sponsored" partner link in a menu, as on USA Today, does not make the menu an ad);
 *  - a block pairing one of the site's own headlines with outside links (Taboola feed cards);
 *  - a section of the site's own links whose only evidence is a label (ask band);
 *  - article text whose only evidence is inline affiliate links (see proseWithInlineLinks).
 */
function mustKeep(el: Element, a: Analysed, decision: 'hide' | 'ask'): boolean {
  if (proseWithInlineLinks(a.features, el.tagName, a.textLen, a.linkTextLen)) return true;
  if (!a.features.adFrames && (a.navigation || inChrome(el))) return true;
  if (!a.features.adFrames && a.mixedFeed) return true;
  return decision === 'ask' && ownSectionWithLabelOnly(a.features, a.ownLinks, location.hostname);
}

/** Inside the page's navigation, header or footer. */
function inChrome(el: Element): boolean {
  return !!el.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]');
}

function bodyTextLength(): number {
  return (document.body?.textContent ?? '').length;
}

function tooLarge(el: Element, bodyText: number): boolean {
  const r = el.getBoundingClientRect();
  return blockTooLarge((el.textContent ?? '').length, bodyText, r.width * r.height, innerWidth * innerHeight);
}

function repeating(el: Element): boolean {
  const p = el.parentElement;
  if (!p) return false;
  if (el.tagName === 'LI') return true;
  const cls = [...el.classList];
  let same = 0;
  for (const s of p.children) {
    if (s === el || s.tagName !== el.tagName) continue;
    if (!cls.length || cls.some((c) => s.classList.contains(c))) same++;
  }
  return cls.length ? same >= 1 : same >= 2;
}

/** Text length without inline <style> / <script> content (ad slots often carry their own CSS). */
function ownTextLength(el: Element): number {
  let n = (el.textContent ?? '').trim().length;
  for (const s of el.querySelectorAll('style, script')) n -= (s.textContent ?? '').length;
  return Math.max(0, n);
}

/** The ad slot around a display-ad caption: the first sized / framed ancestor adding little text, else the caption's parent. */
function captionSlot(caption: Element, bodyText: number): Element | null {
  const capLen = ownTextLength(caption);
  let cur = caption.parentElement;
  for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
    if (isProtected(cur) || containsProtected(cur) || tooLarge(cur, bodyText) || ownTextLength(cur) > capLen + 30) break;
    const r = cur.getBoundingClientRect();
    if (cur.querySelector('iframe') || (r.width >= 120 && r.height >= 50)) return cur;
  }
  const p = caption.parentElement;
  return p && p !== document.body && !isProtected(p) && !containsProtected(p) && ownTextLength(p) <= capLen + 30 ? p : null;
}

/** A link to another page of this site ("Advertising" in a menu is a link, not a disclosure). */
function isSiteLink(el: Element): boolean {
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return false;
  const raw = (a.getAttribute('href') ?? '').trim();
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return false;
  try {
    return new URL(a.href).hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

/** The card-like block around a signal element (never main/article/body or anything containing them). */
function findBlock(signal: Element, bodyText: number): Element | null {
  // An "Advertisement" caption belongs to the ad slot right around it: hide the slot, never the column it sits in.
  if (isDisplayCaption((signal.textContent ?? '').trim())) return captionSlot(signal, bodyText);
  let cur: Element | null = signal;
  let best: Element | null = null;
  let bestText = 0;
  for (let i = 0; i < 8 && cur && cur !== document.body && cur !== document.documentElement; i++) {
    if (isProtected(cur) || containsProtected(cur) || tooLarge(cur, bodyText)) break;
    const text = ownTextLength(cur);
    if (best && growsTooMuch(bestText, text)) break;
    // An ad slot that reserves its space counts even while its creative is empty or not loaded yet.
    const r = cur.getBoundingClientRect();
    const substantial = text >= 40 || !!cur.querySelector('a, img, iframe') || (r.width >= 120 && r.height >= 50);
    if (substantial) {
      best = cur;
      bestText = text;
    }
    if (substantial && repeating(cur)) return cur;
    cur = cur.parentElement;
  }
  return best;
}

function blockSelector(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const cls = [...el.classList].filter((c) => !isHashLike(c) && c.length < 40).slice(0, 2);
  if (cls.length) return `${tag}${cls.map((c) => `.${cssEscape(c)}`).join('')}`;
  const tid = el.getAttribute('data-testid');
  if (tid && !isHashLike(tid)) return `${tag}[data-testid="${tid.replace(/["\\]/g, '')}"]`;
  return null;
}

interface Analysed {
  features: BlockFeatures;
  /** Menu / footer-like (many short links to the site itself). */
  navigation: boolean;
  /** Host of every link in the block (one entry per link). */
  ownLinks: string[];
  /** Feed container mixing the site's own headlines with outside links. */
  mixedFeed: boolean;
  frameHost?: string;
  affiliateHost?: string;
  linkHosts: string[];
  /** Length of the block's text, and of the text inside its links. */
  textLen: number;
  linkTextLen: number;
}

function analyse(block: Element): Analysed {
  const labels: BlockFeatures['labels'] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walker.nextNode(); t && n < 400; t = walker.nextNode(), n++) {
    const s = (t.nodeValue ?? '').trim();
    if (!s || s.length > 60) continue;
    // Whole text of the parent element must be the label (not a word in a sentence).
    const parentText = (t.parentElement?.textContent ?? '').trim();
    if (parentText.length > 60) continue;
    const st = t.parentElement && isSiteLink(t.parentElement) ? null : disclosureStrength(parentText);
    if (st && !labels.some((l) => l.text === parentText)) labels.push({ text: parentText, strength: st });
  }
  let attrDisclosures = 0;
  for (const el of [block, ...block.querySelectorAll('[aria-label], [title], [data-ad-label], [data-label]')].slice(0, 200)) {
    for (const a of ['aria-label', 'title', 'data-ad-label', 'data-label']) {
      const v = el.getAttribute(a);
      if (v && v.length < 80 && attributeDiscloses(v)) attrDisclosures++;
    }
  }
  const links = [...block.querySelectorAll('a[href]')].slice(0, 100) as HTMLAnchorElement[];
  const relSponsored = links.filter((a) => /(^|\s)sponsored(\s|$)/i.test(a.rel)).length;
  const aff = links.filter((a) => isAffiliateUrl(a.href));
  const frames = ([...block.querySelectorAll('iframe[src]')] as HTMLIFrameElement[]).filter((f) => isAdNetworkUrl(f.src));
  let tokenHints = 0;
  for (const el of [block, ...block.querySelectorAll('[class], [id]')].slice(0, 200)) {
    if (tokenHint(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`)) tokenHints++;
  }
  const host = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return '';
    }
  };
  return {
    ownLinks: links.map((a) => host(a.href)).filter(Boolean),
    mixedFeed: mixedFeedContainer(links.map((a) => ({ host: host(a.href), text: (a.textContent ?? '').replace(/\s+/g, ' ') })), location.hostname),
    navigation: looksLikeNavigation(links.map((a) => ({ host: host(a.href), text: (a.textContent ?? '').replace(/\s+/g, ' ') })), location.hostname),
    features: { labels, attrDisclosures, relSponsored, affiliateLinks: aff.length, adFrames: frames.length, tokenHints },
    frameHost: frames[0] ? host(frames[0].src) : undefined,
    affiliateHost: aff[0] ? host(aff[0].href) : undefined,
    linkHosts: [...new Set(links.map((a) => host(a.href)).filter(Boolean))],
    textLen: (block.textContent ?? '').replace(/\s+/g, ' ').trim().length,
    linkTextLen: links.reduce((n, a) => n + (a.textContent ?? '').replace(/\s+/g, ' ').trim().length, 0),
  };
}

/** Elements that may nominate a block. */
function signalElements(): Element[] {
  const out = new Set<Element>();
  const body = document.body;
  if (!body) return [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walker.nextNode(); t && n < 30000; t = walker.nextNode(), n++) {
    const s = t.nodeValue ?? '';
    if (s.length > 60 || !s.trim()) continue;
    const p = t.parentElement;
    if (!p || p.closest('script, style, noscript, template')) continue;
    if (disclosureStrength((p.textContent ?? '').trim()) && !isSiteLink(p)) out.add(p);
  }
  for (const a of body.querySelectorAll('a[rel~="sponsored" i]')) out.add(a);
  for (const a of [...body.querySelectorAll('a[href]')].slice(0, 3000)) if (isAffiliateUrl((a as HTMLAnchorElement).href)) out.add(a);
  for (const f of body.querySelectorAll('iframe[src]')) if (isAdNetworkUrl((f as HTMLIFrameElement).src)) out.add(f);
  for (const el of [...body.querySelectorAll('[aria-label]')].slice(0, 3000)) {
    const v = el.getAttribute('aria-label') ?? '';
    if (v.length < 80 && attributeDiscloses(v)) out.add(el);
  }
  return [...out];
}

function hide(el: Element): void {
  (el as HTMLElement).style?.setProperty('display', 'none', 'important');
}

async function sponsoredFilter(init: AiInit, send: Send, report: Report): Promise<void> {
  const modelAvailable = init.model === 'available';
  const rules = init.sponsoredRules ?? {};
  const done = new WeakSet<Element>();
  const stats = { hidden: 0, kept: 0, asked: 0, cached: 0, mode: modelAvailable ? 'model' : 'prefilter-only' };
  let askBudget = 8;
  const verdicts: Array<{ selector: string; hide: boolean }> = [];

  const scan = async () => {
    const bodyText = bodyTextLength();
    // Cached hide rules first (re-verified: the block must still carry a signal).
    for (const [sel, hideIt] of Object.entries(rules)) {
      if (!hideIt) continue;
      for (const el of queryAll(sel).slice(0, 50)) {
        if (done.has(el) || isProtected(el) || containsProtected(el) || tooLarge(el, bodyText)) continue;
        done.add(el);
        const a = analyse(el);
        // Same guards as a fresh decision: a cached "div.card:has(a[rel~=sponsored])" also matches feed
        // cards that pair a paid item with the site's own story (The Independent).
        if (scoreBlock(a.features).score < ASK_THRESHOLD || mustKeep(el, a, 'ask')) continue;
        hide(el);
        stats.hidden++;
        stats.cached++;
      }
    }
    const blocks = new Set<Element>();
    for (const s of signalElements()) {
      const b = findBlock(s, bodyText);
      if (b && !done.has(b)) blocks.add(b);
    }
    for (const b of blocks) {
      if (done.has(b) || [...blocks].some((o) => o !== b && o.contains(b) && !done.has(o))) continue;
      done.add(b);
      const a = analyse(b);
      const sc = scoreBlock(a.features);
      const bsel = blockSelector(b);
      const csel = bsel ? cacheSelector(bsel, a.features, a.frameHost, a.affiliateHost) : null;
      let decision = decideBlock(sc.score, modelAvailable);
      if (decision !== 'keep' && mustKeep(b, a, decision)) decision = 'keep';
      if (decision === 'ask' && csel && csel in rules) decision = rules[csel] ? 'hide' : 'keep';
      if (decision === 'ask') {
        if (askBudget-- <= 0) continue;
        stats.asked++;
        const verdict = await send<{ sponsored: boolean | null }>({ type: 'cs:aiSponsored', input: sponsoredPrompt(textOf(b), (a.features.labels.find((l) => l.strength === 'strong') ?? a.features.labels[0])?.text ?? null, a.linkHosts, location.hostname) });
        if (typeof verdict?.sponsored !== 'boolean') continue;
        decision = verdict.sponsored ? 'hide' : 'keep';
        if (csel) {
          rules[csel] = verdict.sponsored;
          verdicts.push({ selector: csel, hide: verdict.sponsored });
        }
      }
      if (decision === 'hide') {
        hide(b);
        stats.hidden++;
      } else stats.kept++;
    }
    if (verdicts.length) void send({ type: 'cs:aiSponsoredSave', verdicts: verdicts.splice(0) });
    report({ sponsored: { ...stats } });
  };

  await whenReady();
  await sleep(300);
  let running: Promise<void> | null = null;
  let again = false;
  let runs = 0;
  const trigger = () => {
    if (running) {
      again = true;
      return;
    }
    if (runs++ > 20) return;
    running = scan()
      .catch(() => undefined)
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          setTimeout(trigger, 800);
        }
      });
  };
  trigger();
  let timer: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      trigger();
    }, 800);
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('load', () => setTimeout(trigger, 300), { once: true });
}

// ---------- scam warning ----------

async function scamWatch(init: AiInit, send: Send, report: Report): Promise<void> {
  const behaviour: ScamBehaviour = { fullscreen: 0, beforeunload: 0, history: 0, dialogs: 0, inputLock: 0 };
  window.addEventListener('message', (ev) => {
    const m = ev.data as { __adbScamSig?: number; counts?: Partial<ScamBehaviour> } | null;
    if (ev.source !== window || !m || m.__adbScamSig !== 1 || !m.counts) return;
    for (const k of Object.keys(behaviour) as Array<keyof ScamBehaviour>) {
      const v = Number(m.counts[k]);
      if (Number.isFinite(v) && v > behaviour[k]) behaviour[k] = Math.min(v, 1000);
    }
    schedule(400);
  });
  let warned = false;
  let asked = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number) => {
    if (warned || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, ms);
  };
  const check = async () => {
    if (warned || !document.body) return;
    const features = { text: (document.body.innerText ?? '').slice(0, 20000), title: document.title, behaviour: { ...behaviour } };
    const r = scoreScam(features);
    let d = scamDecision(r.score, init.model === 'available');
    let modelReason = '';
    if (d === 'ask') {
      if (asked) return;
      asked = true;
      const v = await send<{ scam: boolean; reason: string } | null>({ type: 'cs:aiScam', input: scamPrompt(features, r, location.hostname) });
      if (v && v.scam) {
        d = 'warn';
        modelReason = v.reason;
      }
    }
    report({ scam: { score: r.score, categories: r.categories, decision: d, asked } });
    if (d !== 'warn') return;
    warned = true;
    showScamBanner(r.reasons, modelReason, send);
  };
  await whenReady();
  schedule(1200);
  await whenLoaded();
  schedule(1500);
  setTimeout(() => schedule(0), 6000);
}

function showScamBanner(reasons: string[], modelReason: string, send: Send): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  const host = document.createElement('adb-scam-warning');
  host.setAttribute('role', 'alert');
  const w = window as unknown as { __adbAiOpenShadow?: boolean };
  // Closed so the page can't read or alter it; the e2e build (or the extension's own
  // isolated world, for the Chrome test) may open it.
  const root = host.attachShadow({ mode: __E2E__ || w.__adbAiOpenShadow ? 'open' : 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; z-index: 2147483647 !important; display: block !important; }
    .bar { font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #b3261e; color: #fff; padding: 12px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .msg { flex: 1 1 320px; }
    strong { display: block; font-size: 16px; }
    button { font: inherit; border-radius: 6px; padding: 6px 12px; cursor: pointer; border: 1px solid #fff; }
    .leave { background: #fff; color: #b3261e; font-weight: 600; }
    .dismiss { background: transparent; color: #fff; }`;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const msg = document.createElement('div');
  msg.className = 'msg';
  const title = document.createElement('strong');
  title.textContent = 'This page looks like a scam';
  const why = document.createElement('span');
  why.className = 'why';
  why.textContent = `because ${reasons.join('; ')}${modelReason ? ` (on-device AI: ${modelReason})` : ''}. Do not call numbers, pay or install anything it asks for.`;
  msg.append(title, why);
  const leave = document.createElement('button');
  leave.className = 'leave';
  leave.textContent = 'Leave page';
  leave.addEventListener('click', () => void send({ type: 'cs:leavePage' }));
  const dismiss = document.createElement('button');
  dismiss.className = 'dismiss';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => {
    obs.disconnect();
    host.remove();
  });
  bar.append(msg, leave, dismiss);
  root.append(style, bar);
  document.documentElement.appendChild(host);
  // Scam pages may try to remove the warning: put it back.
  const obs = new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  });
  obs.observe(document.documentElement, { childList: true });
}

// ---------- AI cookie click plans ----------

const CLICKABLE = 'button, a, [role="button"], input[type="button"], input[type="submit"]';

function findBanner(frame = false): Element | null {
  const cands = new Set<Element>();
  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) cands.add(el);
  for (const el of document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="privacy" i], [class*="privacy" i]')) cands.add(el);
  // Fixed / sticky overlays near the top of the tree.
  const walk = (el: Element, depth: number) => {
    for (const c of el.children) {
      if (depth < 4) {
        const pos = getComputedStyle(c).position;
        if (pos === 'fixed' || pos === 'sticky') cands.add(c);
        walk(c, depth + 1);
      }
    }
  };
  if (document.body) walk(document.body, 0);
  // In a consent iframe the frame itself is the overlay: its body and top-level blocks are candidates too.
  if (frame && document.body) {
    cands.add(document.body);
    for (const c of document.body.children) cands.add(c);
  }
  // Prefer a candidate that holds a reject / necessary-only control (after "Settings", the preference
  // centre usually sits next to the first banner, which would otherwise win as the shorter text), then the shortest.
  // Rank: holds a reject control (2), else a settings opener (1), else neither (0); then the shortest
  // (Guardian's Sourcepoint frame: a purposes accordion with only expand buttons sits beside the real buttons).
  let best: Element | null = null;
  let bestLen = Infinity;
  let bestRank = -1;
  for (const el of cands) {
    if ((el === document.body && !frame) || el === document.documentElement || el.tagName === 'ADB-SCAM-WARNING') continue;
    if (!visible(el) || (!frame && isProtected(el)) || (!frame && !overlayish(el))) continue;
    const t = textOf(el);
    if (t.length < 20 || t.length > 5000 || !looksLikeConsentText(t)) continue;
    const buttons = [...el.querySelectorAll(CLICKABLE)].filter(visible);
    if (!buttons.length) continue;
    const label = (b: Element) => textOf(b) || b.getAttribute('aria-label') || (b as HTMLInputElement).value || '';
    const rank = buttons.some((b) => isRejectText(label(b))) ? 2 : buttons.some((b) => isNavigateText(label(b))) ? 1 : 0;
    if (rank > bestRank || (rank === bestRank && t.length < bestLen)) {
      best = el;
      bestLen = t.length;
      bestRank = rank;
    }
  }
  return best;
}

/** A dialog, or fixed / sticky positioned (itself or a close ancestor): banners overlay the page. */
function overlayish(el: Element): boolean {
  if (el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog')) return true;
  let cur: Element | null = el;
  for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
    const pos = getComputedStyle(cur).position;
    if (pos === 'fixed' || pos === 'sticky') return true;
  }
  return false;
}

function uniqueSelector(el: Element): string | null {
  if (el.id && !isHashLike(el.id)) {
    const s = `#${cssEscape(el.id)}`;
    if (document.querySelectorAll(s).length === 1) return s;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 12) {
    if (cur !== el && cur.id && !isHashLike(cur.id) && document.querySelectorAll(`#${cssEscape(cur.id)}`).length === 1) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    let i = 1;
    for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === cur.tagName) i++;
    parts.unshift(`${tag}:nth-of-type(${i})`);
    cur = cur.parentElement;
  }
  if (cur === document.body) parts.unshift('body');
  const sel = parts.join(' > ');
  try {
    const m = document.querySelectorAll(sel);
    return m.length === 1 && m[0] === el ? sel : null;
  } catch {
    return null;
  }
}

function clickables(banner: Element): Array<Clickable & { el: Element }> {
  const out: Array<Clickable & { el: Element }> = [];
  for (const el of [...banner.querySelectorAll(CLICKABLE)].slice(0, 60)) {
    if (!visible(el)) continue;
    const text = (textOf(el) || el.getAttribute('aria-label') || (el as HTMLInputElement).value || el.getAttribute('title') || '').trim().slice(0, 80);
    if (!text) continue;
    const selector = uniqueSelector(el);
    if (!selector) continue;
    out.push({ el, selector, text, tag: el.tagName.toLowerCase(), href: el.getAttribute('href'), type: el.getAttribute('type') });
    if (out.length >= 25) break;
  }
  return out;
}

const strip = (c: Array<Clickable & { el: Element }>): Clickable[] => c.map(({ el: _el, ...rest }) => rest);

/** Area of `el` inside the top-level viewport (IntersectionObserver's implicit root works across origins). */
function visibleArea(el: Element): Promise<{ area: number; visible: number }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { area: number; visible: number }) => {
      if (done) return;
      done = true;
      io.disconnect();
      resolve(v);
    };
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1]!;
      finish({ area: e.boundingClientRect.width * e.boundingClientRect.height, visible: e.isIntersecting ? e.intersectionRect.width * e.intersectionRect.height : 0 });
    });
    io.observe(el);
    setTimeout(() => finish({ area: 0, visible: 0 }), 1500);
  });
}

/** Subframe gate: a large, visible frame whose document reads as a consent dialog, with a banner on screen. */
async function frameBanner(): Promise<{ banner: Element | null; verdict: Verdict }> {
  const view = { width: innerWidth, height: innerHeight, docHidden: document.visibilityState === 'hidden', text: textOf(document.body ?? document.documentElement).slice(0, 5000) };
  const pre = frameQualifies(view);
  if (!pre.ok) return { banner: null, verdict: pre };
  const banner = findBanner(true);
  if (!banner) return { banner: null, verdict: { ok: false, reason: 'no banner' } };
  const a = await visibleArea(banner);
  const v = frameQualifies({ ...view, text: textOf(banner), bannerArea: a.area, visibleArea: a.visible });
  return { banner: v.ok ? banner : null, verdict: v };
}

async function cookiePlans(init: AiInit, send: Send, report: Report, frame = false): Promise<void> {
  // Wait for autoconsent: its "done" message, or a few seconds after load.
  let consentDone = false;
  window.addEventListener('message', (ev) => {
    const m = ev.data as { __adbConsent?: number; type?: string } | null;
    if (ev.source === window && m?.__adbConsent === 1 && (m.type === 'autoconsentDone' || m.type === 'optOutResult')) consentDone = true;
  });
  await whenLoaded();
  const t0 = Date.now();
  while (Date.now() - t0 < 3500 && !consentDone) await sleep(250);
  await sleep(consentDone ? 1000 : 300);

  let banner: Element | null;
  if (frame) {
    // Only in a tab the user can see: a background tab's consent iframe waits until the tab is shown.
    if (document.visibilityState === 'hidden') {
      await new Promise<void>((r) => {
        const on = () => {
          if (document.visibilityState === 'hidden') return;
          document.removeEventListener('visibilitychange', on);
          r();
        };
        document.addEventListener('visibilitychange', on);
      });
      await sleep(500);
    }
    // Consent iframes often fill in (or are shown) a moment after they load: look a few times.
    banner = null;
    for (let i = 0; i < 8 && !banner; i++) {
      if (i) await sleep(1000);
      banner = (await frameBanner()).banner;
    }
    // A subframe never reports "no banner" (the top frame speaks for the page).
    if (!banner) return;
  } else {
    banner = findBanner();
    if (!banner) {
      report({ cookie: { banner: false } });
      return;
    }
  }
  const find = () => (frame ? findBanner(true) : findBanner());

  // One flow per tab: the one already in progress wins; a finished reject ends it for the page.
  let lock = await send<{ ok: boolean; reason?: string }>({ type: 'cs:aiCookieLock', op: 'acquire' });
  for (let waited = 0; lock && !lock.ok && lock.reason === 'busy' && waited < 25000; waited += 1000) {
    await sleep(1000);
    banner = frame ? (await frameBanner()).banner : findBanner();
    if (!banner) return;
    lock = await send<{ ok: boolean; reason?: string }>({ type: 'cs:aiCookieLock', op: 'acquire' });
  }
  if (!lock?.ok) return;
  let finished = false;
  const end = (rejected: boolean) => {
    finished = true;
    void send({ type: 'cs:aiCookieLock', op: rejected ? 'done' : 'release' });
  };
  // Tell the background before every click: a consent iframe is usually removed by its own reject click,
  // and then the background finishes the flow for it.
  const beforeClick = (kind: 'reject' | 'navigate', target: Clickable, steps: string[], offered: Clickable[][], texts: string[]) =>
    send({ type: 'cs:aiCookieLock', op: 'click', kind, clear: kind === 'reject' && !isNavigateText(target.text), steps, offered, texts });
  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

  try {
    const status: Record<string, unknown> = { banner: true, model: init.model, steps: [] as string[], ...(frame ? { frame: true } : {}) };
    const texts = status.steps as string[];

    // A plan that worked here before: re-validated against the live page at every step.
    if (init.cookiePlan?.length) {
      let ok = true;
      let started = false;
      const replayed: string[] = [];
      const offeredSoFar: Clickable[][] = [];
      for (let i = 0; i < init.cookiePlan.length && banner; i++) {
        const offered = clickables(banner);
        const v = validateStep(init.cookiePlan[i]!.selector, strip(offered), i);
        if (!v.ok) {
          ok = false;
          break;
        }
        started = true;
        replayed.push(v.target.selector);
        offeredSoFar.push(strip(offered));
        texts.push(v.target.text);
        await beforeClick(v.kind, v.target, replayed, offeredSoFar, texts);
        click(offered.find((c) => c.selector === v.target.selector)!.el);
        await sleep(800);
        banner = find();
      }
      if (ok && !banner) {
        report({ cookie: { ...status, result: 'rejected', cached: true } });
        end(true);
        return;
      }
      // In a frame, a plan that does not even start here may belong to another frame of the same flow
      // (Sourcepoint: first layer and privacy manager share a host): keep it.
      if (!frame || started) void send({ type: 'cs:aiCookieForget' });
      if (!banner) {
        end(false);
        return;
      }
    }
    if (init.model !== 'available') {
      report({ cookie: { ...status, result: 'no-model' } });
      end(false);
      return;
    }
    const steps: string[] = [];
    const offeredPerStep: Clickable[][] = [];
    for (let i = 0; i < MAX_STEPS && banner; i++) {
      const offered = clickables(banner);
      if (!offered.length) break;
      const plain = strip(offered);
      // The model only sees elements validation could accept; its answer is still validated against everything offered.
      // When a reject / necessary-only control is already on screen, opening settings is a wasted step: offer
      // only those (the real model sometimes chose "Einstellungen" over "Nur notwendige Cookies").
      // Otherwise offer only controls that open settings, never one already clicked (real sites: Marca's
      // "Configuración de Cookies" tab clicked again and again; links like "in questa lista" that validation refuses anyway).
      const allowed = plain.filter((c) => offerToModel(c) && !steps.includes(c.selector));
      const rejects = allowed.filter((c) => isRejectText(c.text));
      const forModel = rejects.length ? rejects : allowed.filter((c) => isNavigateText(c.text));
      if (!forModel.length) {
        report({ cookie: { ...status, result: 'refused', reason: 'no reject / settings control to offer' } });
        end(false);
        return;
      }
      const sel = await send<{ selector: string | null }>({ type: 'cs:aiCookie', input: cookiePrompt(textOf(banner), forModel, i), offered: forModel });
      const v = validateStep(sel?.selector ?? null, plain, i);
      if (!v.ok) {
        report({ cookie: { ...status, result: 'refused', reason: v.reason, proposed: sel?.selector ?? null } });
        end(false);
        return;
      }
      steps.push(v.target.selector);
      offeredPerStep.push(plain);
      texts.push(v.target.text);
      const ack = await beforeClick(v.kind, v.target, steps, offeredPerStep, texts) as { ok?: boolean } | undefined;
      if (!ack?.ok) {
        // Lost the lock (TTL ran out during a very slow step, or the page navigated): act no further.
        report({ cookie: { ...status, result: 'lock-lost' } });
        finished = true;
        return;
      }
      click(offered.find((c) => c.selector === v.target.selector)!.el);
      await sleep(900);
      banner = find();
      // A settings panel may take a moment to render (Sourcepoint swaps the frame's content).
      for (let k = 0; k < 4 && !banner && v.kind === 'navigate'; k++) {
        await sleep(750);
        banner = find();
      }
      if (!banner && v.kind === 'reject') {
        const saved = await send<{ ok: boolean }>({ type: 'cs:aiCookieSave', steps, offered: offeredPerStep });
        report({ cookie: { ...status, result: 'rejected', saved: !!saved?.ok } });
        end(true);
        return;
      }
      if (v.kind === 'reject') break;
    }
    report({ cookie: { ...status, result: banner ? 'banner-remains' : 'gone' } });
    end(false);
  } finally {
    if (!finished) end(false);
  }
}
