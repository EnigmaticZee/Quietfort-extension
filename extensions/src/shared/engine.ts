// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// In-extension filter engine (TypeScript port of the Rust filter engine, tag mac-app-final). Used for:
//   - Firefox: full network filtering via blocking webRequest;
//   - all browsers: $popup decisions, cosmetic filtering, scriptlet/procedural
//     selection, page-level exceptions;
//   - Chrome/Safari: the parsed rules feed the DNR compiler (dnr.ts).

import { activeLines, parseLine } from './parse.ts';
import { compilePattern, hostRange } from './pattern.ts';
import type { CompiledPattern } from './pattern.ts';
import { domainListMatches, entityKey, hostMatches, hostOf, isThirdParty, suffixes } from './domain.ts';
import { RT } from './types.ts';
import type { CosmeticRule, Modifier, NetworkRule, ParamMatch, Scriptlet } from './types.ts';

export interface Stats {
  network: number;
  cosmetic: number;
  scriptlets: number;
  procedural: number;
  styles: number;
  modifiers: number;
  popup: number;
  unsupported: number;
  ignored: number;
  badfiltered: number;
  unsupportedReasons: Record<string, number>;
}

/** A filter list's text; `trusted` enables trusted-only scriptlets. */
/** `$urlskip` steps (uBO syntax): the real destination inside a tracking link; null if it isn't a web URL. */
export function applyUrlSkip(steps: string[], url: string): string | null {
  let cur: string | null = url;
  for (const st of steps) {
    if (cur === null) return null;
    try {
      if (st.startsWith('?')) cur = new URL(cur).searchParams.get(st.slice(1));
      else if (st.startsWith('/') && st.endsWith('/') && st.length > 2) {
        const m: RegExpExecArray | null = new RegExp(st.slice(1, -1)).exec(cur);
        cur = m ? (m[1] ?? m[0]) : null;
      } else if (st === '-base64' || st === '-safebase64') cur = atob(st === '-safebase64' ? cur.replace(/-/g, '+').replace(/_/g, '/') : cur);
      else if (st === '-uricomponent') cur = decodeURIComponent(cur);
      else if (st === '+https') cur = cur.includes('://') ? cur : `https://${cur.replace(/^\/+/, '')}`;
    } catch {
      return null;
    }
  }
  return cur && /^https?:\/\/[^\s]+$/i.test(cur) ? cur : null;
}

function applyUriTransform(nav: { re: string; flags: string; replacement: string }, url: string): string | null {
  const m = /^([a-z]+:\/\/[^/?#]*)(.*)$/i.exec(url);
  if (!m) return null;
  try {
    return m[1]! + m[2]!.replace(new RegExp(nav.re, nav.flags), nav.replacement);
  } catch {
    return null;
  }
}

export interface ListInput {
  text: string;
  trusted?: boolean;
}

export interface RequestInfo {
  /** Absolute URL, original case. */
  url: string;
  /** Host of the page (frame) that made the request; null if unknown. */
  sourceHost: string | null;
  type: number;
  /** Overrides the heuristic first/third-party decision (Firefox gives us one). */
  thirdParty?: boolean;
  /** HTTP method, when known (`$method` rules need it). */
  method?: string;
}

interface Req {
  url: string;
  lurl: string;
  host: string;
  sourceHost: string | null;
  type: number;
  thirdParty: boolean | null;
  hs: number;
  he: number;
  tokens: string[];
  method: string | null;
}

export type Verdict =
  | { action: 'allow' }
  | { action: 'block'; rule: string; redirect: string | null }
  | { action: 'excepted'; rule: string; exception: string };

interface Entry {
  rule: NetworkRule;
  pattern: CompiledPattern;
}

function urlTokens(lurl: string): string[] {
  const seen = new Set<string>();
  for (const t of lurl.split(/[^a-z0-9]+/)) if (t.length >= 2) seen.add(t);
  return [...seen];
}

function makeReq(info: RequestInfo): Req {
  const lurl = info.url.toLowerCase();
  const host = hostOf(lurl);
  const sourceHost = info.sourceHost ? info.sourceHost.replace(/\.+$/, '').toLowerCase() : null;
  const thirdParty = info.thirdParty ?? (sourceHost !== null ? isThirdParty(host, sourceHost) : null);
  const [hs, he] = hostRange(lurl);
  return { url: info.url, lurl, host, sourceHost, type: info.type, thirdParty, hs, he, tokens: urlTokens(lurl), method: info.method ? info.method.toUpperCase() : null };
}

function ruleApplies(e: Entry, req: Req): boolean {
  const r = e.rule;
  if ((r.types & req.type) === 0) return false;
  if (r.thirdParty !== null && req.thirdParty !== r.thirdParty) return false;
  if (r.includeDomains.length || r.excludeDomains.length) {
    const src = req.sourceHost;
    if (src === null) {
      if (r.includeDomains.length) return false;
    } else {
      if (r.excludeDomains.some((d) => domainListMatches(src, d))) return false;
      if (r.includeDomains.length && !r.includeDomains.some((d) => domainListMatches(src, d))) return false;
    }
  }
  const x = r.extra;
  if (x) {
    if (x.methods || x.notMethods) {
      if (!req.method) return false;
      if (x.notMethods?.includes(req.method) || (x.methods?.length && !x.methods.includes(req.method))) return false;
    }
    if (x.denyallow.some((d) => domainListMatches(req.host, d))) return false;
    if (x.toExclude.some((d) => domainListMatches(req.host, d))) return false;
    if (x.toInclude.length && !x.toInclude.some((d) => domainListMatches(req.host, d))) return false;
    if (x.strictThirdParty !== null && (req.sourceHost === null || (req.sourceHost !== req.host) !== x.strictThirdParty)) return false;
  }
  if (r.matchCase) {
    // Host part is case-insensitive in URLs; keep the original elsewhere.
    const u = req.url.slice(0, req.hs) + req.url.slice(req.hs, req.he).toLowerCase() + req.url.slice(req.he);
    return e.pattern.matches(u, req.hs, req.he);
  }
  return e.pattern.matches(req.lurl, req.hs, req.he);
}

class RuleSet {
  entries: Entry[] = [];
  buckets = new Map<string, number[]>();
  fallback: number[] = [];

  push(rule: NetworkRule): void {
    let pattern: CompiledPattern;
    try {
      pattern = compilePattern(rule.pattern, rule.matchCase);
    } catch {
      return;
    }
    const idx = this.entries.length;
    this.entries.push({ rule, pattern });
    if (rule.token) {
      let b = this.buckets.get(rule.token);
      if (!b) this.buckets.set(rule.token, (b = []));
      b.push(idx);
    } else this.fallback.push(idx);
  }

  find(req: Req, skip?: (r: NetworkRule) => boolean): NetworkRule | null {
    const ok = (i: number) => ruleApplies(this.entries[i]!, req) && !(skip && skip(this.entries[i]!.rule));
    for (const t of req.tokens) {
      const b = this.buckets.get(t);
      if (!b) continue;
      for (const i of b) if (ok(i)) return this.entries[i]!.rule;
    }
    for (const i of this.fallback) if (ok(i)) return this.entries[i]!.rule;
    return null;
  }

  findAll(req: Req): NetworkRule[] {
    const out: NetworkRule[] = [];
    const push = (i: number) => {
      if (ruleApplies(this.entries[i]!, req)) out.push(this.entries[i]!.rule);
    };
    for (const t of req.tokens) this.buckets.get(t)?.forEach(push);
    this.fallback.forEach(push);
    return out;
  }
}

/** Rules scoped to domains (scriptlets, procedural, styles). Port of domain_index.rs. */
class DomainIndex<T> {
  generic: Array<[T, string[]]> = [];
  specific = new Map<string, Array<[T, string[]]>>();
  exceptions = new Map<string, Set<string>>();
  disabled = new Set<string>();
  size = 0;

  add(include: string[], exclude: string[], item: T): void {
    this.size++;
    if (!include.length) this.generic.push([item, exclude]);
    else
      for (const d of include) {
        let l = this.specific.get(d);
        if (!l) this.specific.set(d, (l = []));
        l.push([item, exclude]);
      }
  }

  addException(include: string[], key: string | null): void {
    for (const d of include.length ? include : ['']) {
      if (key === null) this.disabled.add(d);
      else {
        let s = this.exceptions.get(d);
        if (!s) this.exceptions.set(d, (s = new Set()));
        s.add(key);
      }
    }
  }

  query(host: string, keyOf: (t: T) => string, extra?: Map<string, Set<string>>): T[] {
    const ent = entityKey(host);
    const keys = ['', ...suffixes(host), ...(ent ? [ent] : [])];
    if (keys.some((k) => this.disabled.has(k))) return [];
    const excepted = new Set<string>();
    for (const k of keys) this.exceptions.get(k)?.forEach((x) => excepted.add(x));
    if (extra) for (const k of keys) extra.get(k)?.forEach((x) => excepted.add(x));
    const seen = new Set<string>();
    const out: T[] = [];
    const consider = ([item, excl]: [T, string[]]) => {
      if (excl.some((d) => domainListMatches(host, d))) return;
      const key = keyOf(item);
      if (excepted.has(key) || seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };
    this.generic.forEach(consider);
    for (const k of keys) if (k) this.specific.get(k)?.forEach(consider);
    return out;
  }
}

/** `.ad-box > div` → `.ad-box`; `#banner` → `#banner`; otherwise null. */
export function selectorKey(sel: string): string | null {
  const first = sel[0];
  if ((first !== '.' && first !== '#') || sel.includes(',')) return null;
  const m = /^[A-Za-z0-9_-]+/.exec(sel.slice(1));
  return m ? first + m[0] : null;
}

/** Element hiding index. Port of cosmetic.rs. */
class CosmeticIndex {
  genericKeyed = new Map<string, string[]>();
  genericAlways: string[] = [];
  genericWithExclusions: Array<[string, string[]]> = [];
  specific = new Map<string, Array<[string, string[]]>>();
  exceptions = new Map<string, Set<string>>();
  size = 0;

  add(rule: CosmeticRule): void {
    if (rule.exception) {
      for (const d of rule.includeDomains.length ? rule.includeDomains : ['']) {
        let s = this.exceptions.get(d);
        if (!s) this.exceptions.set(d, (s = new Set()));
        s.add(rule.selector);
      }
      return;
    }
    this.size++;
    if (!rule.includeDomains.length) {
      if (rule.excludeDomains.length) {
        this.genericWithExclusions.push([rule.selector, rule.excludeDomains]);
        return;
      }
      const key = selectorKey(rule.selector);
      if (key) {
        let l = this.genericKeyed.get(key);
        if (!l) this.genericKeyed.set(key, (l = []));
        l.push(rule.selector);
      } else this.genericAlways.push(rule.selector);
      return;
    }
    for (const d of rule.includeDomains) {
      let l = this.specific.get(d);
      if (!l) this.specific.set(d, (l = []));
      l.push([rule.selector, rule.excludeDomains]);
    }
  }

  unhidden(host: string, extra?: Map<string, Set<string>>): Set<string> {
    const out = new Set<string>();
    const ent = entityKey(host);
    for (const k of ['', ...suffixes(host), ...(ent ? [ent] : [])]) {
      this.exceptions.get(k)?.forEach((s) => out.add(s));
      extra?.get(k)?.forEach((s) => out.add(s));
    }
    return out;
  }
}

export interface PageFlags {
  /** `@@||site^$document`: no filtering at all on this page. */
  document: boolean;
  generichide: boolean;
  elemhide: boolean;
}

export interface CosmeticsForPage {
  /** Site-specific selectors. */
  specific: string[];
  /** Generic selectors that must always be applied (not keyed by class/id). */
  generic: string[];
  /** `sel { declarations }` pairs. */
  styles: Array<[string, string]>;
  /** False when generic keyed lookups should be skipped ($generichide). */
  allowGeneric: boolean;
}

/**
 * Site-scoped exceptions layered on top of the filter lists without rebuilding
 * the engine (Fix-this-site trials and the exceptions they produce). Only
 * narrow exceptions are accepted: every line must name the site(s) it applies
 * to, and page-wide ($document / $generichide / $elemhide / `#@#+js()`) or
 * modifier exceptions are refused.
 */
export interface OverlayResult {
  accepted: number;
  rejected: Array<{ line: string; reason: string }>;
}

interface Overlay {
  exceptions: RuleSet;
  important: RuleSet;
  cosmetic: Map<string, Set<string>>;
  scriptlet: Map<string, Set<string>>;
  procedural: Map<string, Set<string>>;
}

function addKeyed(map: Map<string, Set<string>>, domains: string[], key: string): void {
  for (const d of domains) {
    let s = map.get(d);
    if (!s) map.set(d, (s = new Set()));
    s.add(key);
  }
}

/** Why an overlay line is refused, or null when it is a narrow site-scoped exception. */
export function overlayLineProblem(line: string): string | null {
  const p = parseLine(line);
  switch (p.kind) {
    case 'network': {
      const r = p.rule;
      if (!r.exception) return 'not-an-exception';
      if (r.modifier) return 'modifier-exception';
      if (r.types & RT.DOCUMENT || r.generichide || r.elemhide) return 'page-wide-exception';
      if (!r.includeDomains.length || r.excludeDomains.length) return 'not-site-scoped';
      if (r.includeDomains.some((d) => d.endsWith('.*'))) return 'not-site-scoped';
      return null;
    }
    case 'cosmetic': case 'procedural':
      if (!p.rule.exception) return 'not-an-exception';
      if (!p.rule.includeDomains.length || p.rule.excludeDomains.length) return 'not-site-scoped';
      return null;
    case 'scriptlet':
      if (!p.exception) return 'not-an-exception';
      if (!p.scriptlet) return 'page-wide-exception';
      if (!p.includeDomains.length || p.excludeDomains.length) return 'not-site-scoped';
      return null;
    default:
      return `unsupported:${p.kind}`;
  }
}

export function scriptletKey(s: Scriptlet): string {
  return `${s.name}\u0001${s.args.join('\u0001')}`;
}

function paramKey(p: ParamMatch): string {
  switch (p.kind) {
    case 'all': return '';
    case 'name': return p.name;
    case 'allExcept': return `~${p.name}`;
    case 'regex': return `/${p.source}/`;
  }
}

export function modifierKey(m: Modifier): [string, string] {
  switch (m.kind) {
    case 'removeparam': return ['removeparam', paramKey(m.param)];
    case 'csp': return ['csp', m.value];
    case 'removeheader': return ['removeheader', m.value];
  }
}

function paramMatches(p: ParamMatch, name: string, pair: string): boolean {
  switch (p.kind) {
    case 'all': return true;
    case 'name': return p.name === name;
    case 'allExcept': return p.name !== name;
    case 'regex': return p.re.test(pair);
  }
}

export class Engine {
  important = new RuleSet();
  block = new RuleSet();
  exceptions = new RuleSet();
  pageExceptions = new RuleSet();
  redirectRules = new RuleSet();
  /** `@@...$redirect(-rule)`: cancel redirects (blocking stays). */
  redirectExceptions = new RuleSet();
  /** `@@||site^$genericblock`. */
  genericblockPages = new RuleSet();
  /** `$urlskip` / `$uritransform` (top-level navigations). */
  navigationRules = new RuleSet();
  modifiers = new RuleSet();
  modifierExceptions = new RuleSet();
  cosmetics = new CosmeticIndex();
  scriptletIndex = new DomainIndex<Scriptlet>();
  proceduralIndex = new DomainIndex<string>();
  styleIndex = new DomainIndex<[string, string]>();
  private overlay: Overlay | null = null;
  /** Network rules after $badfilter, in list order (input of the DNR compiler). */
  networkRules: NetworkRule[] = [];
  /** Which list (index into the input array) each network rule came from. */
  networkRuleList: number[] = [];
  stats: Stats = {
    network: 0, cosmetic: 0, scriptlets: 0, procedural: 0, styles: 0, modifiers: 0, popup: 0,
    unsupported: 0, ignored: 0, badfiltered: 0, unsupportedReasons: {},
  };

  /**
   * Build from list texts. A list may be `{ text, trusted }`: trusted lists (the
   * uBO / AdGuard lists from their official URLs) may use trusted-only
   * scriptlets. `env` holds the true `!#if` tokens (see EXTENSION_ENV).
   */
  static fromLists(lists: Array<string | ListInput>, env: readonly string[] = []): Engine {
    const e = new Engine();
    const network: Array<[NetworkRule, number]> = [];
    const badfilters = new Set<string>();
    lists.forEach((input, listIdx) => {
      const { text: list, trusted = false } = typeof input === 'string' ? { text: input } : input;
      const lines = list.includes('!#if') ? activeLines(list, env) : list.split(/\r?\n/);
      for (const line of lines) {
        const p = parseLine(line, trusted);
        switch (p.kind) {
          case 'network': network.push([p.rule, listIdx]); break;
          case 'badfilter': badfilters.add(p.raw); break;
          case 'cosmetic': e.cosmetics.add(p.rule); e.stats.cosmetic++; break;
          case 'procedural':
            e.stats.procedural++;
            if (p.rule.exception) e.proceduralIndex.addException(p.rule.includeDomains, p.rule.selector);
            else e.proceduralIndex.add(p.rule.includeDomains, p.rule.excludeDomains, p.rule.selector);
            break;
          case 'style': {
            e.stats.styles++;
            const key = `${p.rule.selector}{${p.declarations}}`;
            if (p.rule.exception) e.styleIndex.addException(p.rule.includeDomains, key);
            else e.styleIndex.add(p.rule.includeDomains, p.rule.excludeDomains, [p.rule.selector, p.declarations]);
            break;
          }
          case 'scriptlet':
            e.stats.scriptlets++;
            if (p.exception) e.scriptletIndex.addException(p.includeDomains, p.scriptlet ? scriptletKey(p.scriptlet) : null);
            else if (p.scriptlet) e.scriptletIndex.add(p.includeDomains, p.excludeDomains, p.scriptlet);
            break;
          case 'ignored': e.stats.ignored++; break;
          case 'unsupported':
            e.stats.unsupported++;
            e.stats.unsupportedReasons[p.reason] = (e.stats.unsupportedReasons[p.reason] ?? 0) + 1;
            break;
        }
      }
    });
    for (const [r, listIdx] of network) {
      if (badfilters.has(r.raw)) {
        e.stats.badfiltered++;
        continue;
      }
      e.stats.network++;
      if (r.types & RT.POPUP) e.stats.popup++;
      e.networkRules.push(r);
      e.networkRuleList.push(listIdx);
      if (r.extra?.redirectException && r.exception) e.redirectExceptions.push(r);
      else if (r.extra?.genericblock) e.genericblockPages.push(r);
      else if (r.extra?.navigation) (r.exception ? e.redirectExceptions : e.navigationRules).push(r);
      else if (r.modifier) {
        e.stats.modifiers++;
        (r.exception ? e.modifierExceptions : e.modifiers).push(r);
      } else if (r.exception) {
        if ((r.types & RT.DOCUMENT) && (r.types === RT.DOCUMENT || r.generichide || r.elemhide)) e.pageExceptions.push(r);
        else e.exceptions.push(r);
      } else if (r.redirectRule) e.redirectRules.push(r);
      else if (r.important) e.important.push(r);
      else e.block.push(r);
    }
    return e;
  }

  /** Replace the site-exception overlay (see `overlayLineProblem`). */
  setOverlay(lines: string[]): OverlayResult {
    const o: Overlay = { exceptions: new RuleSet(), important: new RuleSet(), cosmetic: new Map(), scriptlet: new Map(), procedural: new Map() };
    const res: OverlayResult = { accepted: 0, rejected: [] };
    for (const line of lines) {
      const problem = overlayLineProblem(line);
      if (problem) {
        res.rejected.push({ line, reason: problem });
        continue;
      }
      const p = parseLine(line);
      if (p.kind === 'network') {
        o.exceptions.push(p.rule);
        if (p.rule.important) o.important.push(p.rule);
      } else if (p.kind === 'cosmetic') addKeyed(o.cosmetic, p.rule.includeDomains, p.rule.selector);
      else if (p.kind === 'procedural') addKeyed(o.procedural, p.rule.includeDomains, p.rule.selector);
      else if (p.kind === 'scriptlet') addKeyed(o.scriptlet, p.includeDomains, scriptletKey(p.scriptlet!));
      res.accepted++;
    }
    this.overlay = res.accepted ? o : null;
    return res;
  }

  /** Page-level exception flags for a page on `host`. */
  pageFlags(host: string): PageFlags {
    const h = host.replace(/\.+$/, '').toLowerCase();
    const req = makeReq({ url: `https://${h}/`, sourceHost: h, type: RT.DOCUMENT });
    const flags: PageFlags = { document: false, generichide: false, elemhide: false };
    for (const r of this.pageExceptions.findAll(req)) {
      if (r.generichide) flags.generichide = true;
      if (r.elemhide) flags.elemhide = true;
      if (!r.generichide && !r.elemhide) flags.document = true;
    }
    return flags;
  }

  check(info: RequestInfo): Verdict {
    const req = makeReq(info);
    const imp = this.important.find(req);
    if (imp) {
      const oi = this.overlay?.important.find(req);
      if (oi) return { action: 'excepted', rule: imp.raw, exception: oi.raw };
      return { action: 'block', rule: imp.raw, redirect: imp.redirect };
    }
    const noGeneric = !!req.sourceHost && this.genericblockPages.entries.length > 0
      && !!this.genericblockPages.find(makeReq({ url: `https://${req.sourceHost}/`, sourceHost: req.sourceHost, type: RT.DOCUMENT }));
    const block = this.block.find(req, noGeneric ? (r) => r.includeDomains.length === 0 : undefined);
    if (!block) return { action: 'allow' };
    if (req.sourceHost && this.pageFlags(req.sourceHost).document) {
      return { action: 'excepted', rule: block.raw, exception: `$document@${req.sourceHost}` };
    }
    const exc = this.exceptions.find(req) ?? this.overlay?.exceptions.find(req);
    if (exc) return { action: 'excepted', rule: block.raw, exception: exc.raw };
    let redirect = block.redirect;
    if (!redirect) redirect = this.redirectRules.find(req)?.redirect ?? null;
    if (redirect && this.redirectExceptions.entries.length) {
      const name = redirect;
      if (this.redirectExceptions.find(req, (x) => !!x.extra?.navigation || (!!x.redirect && x.redirect !== name))) redirect = null;
    }
    return { action: 'block', rule: block.raw, redirect };
  }

  /** `$urlskip` / `$uritransform`: where a top-level navigation to `url` should go instead (null = nowhere else). */
  navigationTarget(url: string, sourceHost: string | null = null): string | null {
    if (!this.navigationRules.entries.length || !/^https?:/i.test(url)) return null;
    const req = makeReq({ url, sourceHost, type: RT.DOCUMENT });
    const rule = this.navigationRules.find(req);
    const nav = rule?.extra?.navigation;
    if (!rule || !nav) return null;
    if (this.redirectExceptions.find(req, (x) => !x.extra?.navigation)) return null;
    const out = nav.kind === 'urlskip' ? applyUrlSkip(nav.steps, url) : applyUriTransform(nav, url);
    return out && out !== url ? out : null;
  }

  /** Should a new window/tab to `url`, opened by a page at `openerUrl`, be closed? */
  checkPopup(url: string, openerUrl: string | null): Verdict {
    const opener = openerUrl && /^https?:/i.test(openerUrl) ? hostOf(openerUrl) : null;
    return this.check({ url, sourceHost: opener, type: RT.POPUP });
  }

  /** Element hiding for a page on `host` (generic keyed rules come via `genericForTokens`). */
  cosmeticsFor(host: string): CosmeticsForPage | null {
    const h = host.replace(/\.+$/, '').toLowerCase();
    const flags = this.pageFlags(h);
    if (flags.document || flags.elemhide) return null;
    const idx = this.cosmetics;
    const unhidden = idx.unhidden(h, this.overlay?.cosmetic);
    const excluded = (excl: string[]) => excl.some((d) => domainListMatches(h, d));
    const specific = new Set<string>();
    const ent = entityKey(h);
    for (const k of [...suffixes(h), ...(ent ? [ent] : [])]) {
      for (const [sel, excl] of idx.specific.get(k) ?? []) if (!excluded(excl) && !unhidden.has(sel)) specific.add(sel);
    }
    const generic: string[] = [];
    if (!flags.generichide) {
      for (const sel of idx.genericAlways) if (!unhidden.has(sel)) generic.push(sel);
      for (const [sel, excl] of idx.genericWithExclusions) if (!excluded(excl) && !unhidden.has(sel)) generic.push(sel);
    }
    const styles = this.styleIndex.query(h, ([s, d]) => `${s}{${d}}`);
    return { specific: [...specific].sort(), generic, styles, allowGeneric: !flags.generichide };
  }

  /** Generic selectors keyed by `.class` / `#id` tokens present on the page. */
  genericForTokens(host: string, tokens: string[]): string[] {
    const h = host.replace(/\.+$/, '').toLowerCase();
    const flags = this.pageFlags(h);
    if (flags.document || flags.elemhide || flags.generichide) return [];
    const unhidden = this.cosmetics.unhidden(h, this.overlay?.cosmetic);
    const out: string[] = [];
    for (const t of tokens) for (const sel of this.cosmetics.genericKeyed.get(t) ?? []) if (!unhidden.has(sel)) out.push(sel);
    return out;
  }

  scriptlets(host: string): Scriptlet[] {
    const h = host.replace(/\.+$/, '').toLowerCase();
    if (this.pageFlags(h).document) return [];
    return this.scriptletIndex.query(h, scriptletKey, this.overlay?.scriptlet);
  }

  procedural(host: string): string[] {
    const h = host.replace(/\.+$/, '').toLowerCase();
    const f = this.pageFlags(h);
    if (f.document || f.elemhide) return [];
    return this.proceduralIndex.query(h, (s) => s, this.overlay?.procedural);
  }

  private activeModifiers(info: RequestInfo, kind: string): Modifier[] {
    const req = makeReq(info);
    const exc = new Set<string>();
    for (const r of this.modifierExceptions.findAll(req)) {
      const [k, v] = modifierKey(r.modifier!);
      if (k === kind) exc.add(v);
    }
    if (exc.has('')) return [];
    return this.modifiers
      .findAll(req)
      .map((r) => r.modifier!)
      .filter((m) => {
        const [k, v] = modifierKey(m);
        return k === kind && !exc.has(v);
      });
  }

  /** `$removeparam`: cleaned URL, or null if unchanged. */
  cleanUrl(info: RequestInfo): string | null {
    const url = info.url;
    const q = url.indexOf('?');
    if (q < 0) return null;
    const base = url.slice(0, q);
    let rest = url.slice(q + 1);
    let fragment: string | null = null;
    const hash = rest.indexOf('#');
    if (hash >= 0) {
      fragment = rest.slice(hash + 1);
      rest = rest.slice(0, hash);
    }
    const matchers = this.activeModifiers(info, 'removeparam').map((m) => (m as { kind: 'removeparam'; param: ParamMatch }).param);
    if (!matchers.length) return null;
    const pairs = rest.split('&').filter(Boolean);
    const kept = pairs.filter((pair) => {
      const name = pair.split('=')[0] ?? '';
      return !matchers.some((m) => paramMatches(m, name, pair));
    });
    if (kept.length === pairs.length) return null;
    let out = base;
    if (kept.length) out += `?${kept.join('&')}`;
    if (fragment !== null) out += `#${fragment}`;
    return out;
  }

  csp(info: RequestInfo): string[] {
    return this.activeModifiers(info, 'csp').map((m) => (m as { value: string }).value).filter(Boolean);
  }

  headersToRemove(info: RequestInfo): string[] {
    return this.activeModifiers(info, 'removeheader').map((m) => (m as { value: string }).value);
  }
}

export { hostMatches };
