// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Safari content blockers: the filter lists compiled to WebKit content-rule
// JSON. Safari's web-extension declarativeNetRequest is capped at about 15,700
// rules, far below what the default lists need; each content-blocker extension
// takes up to 150,000 rules, and the companion app ships several. The web
// extension keeps its DNR rules (redirects, removeparam, headers, and a
// fallback while the content blockers are off); the content blockers carry the
// full blocking set, popups included (DNR can't block popups at all).
//
// Translation goes through the DNR compiler (one network rule at a time), so
// the two stay in step: same domains, types, exceptions and priorities.
// WebKit's url-filter is a restricted regex (no `|`, no `{n}`, ASCII only) and
// one invalid rule fails a whole content blocker, so anything that can't be
// expressed exactly is left out and counted, never guessed.

import { compileNetworkRule, PRIORITY } from './dnr.ts';
import type { DnrCondition, DnrRuleNoId, ResourceTypeName } from './dnr.ts';
import { RT } from './types.ts';
import type { NetworkRule } from './types.ts';

export type CbResourceType = 'document' | 'image' | 'style-sheet' | 'script' | 'font' | 'raw' | 'svg-document' | 'media' | 'popup';

export interface CbTrigger {
  'url-filter': string;
  'url-filter-is-case-sensitive'?: boolean;
  'if-domain'?: string[];
  'unless-domain'?: string[];
  'if-top-url'?: string[];
  'resource-type'?: CbResourceType[];
  'load-type'?: Array<'first-party' | 'third-party'>;
  'load-context'?: Array<'top-frame' | 'child-frame'>;
}

export interface CbRule {
  trigger: CbTrigger;
  action: { type: 'block' | 'ignore-previous-rules' };
}

/**
 * A converted rule with its ordering information. `rules[0]` is the rule; any
 * further ones are its own exclusions (`$denyallow`, `domain=a|~b.a`), which
 * must directly follow it in the same content blocker.
 */
interface Entry {
  rules: CbRule[];
  priority: number;
  /** Tier of the source list (0 = primary): lower tiers fill the content blockers first. */
  tier: number;
  order: number;
}

/** WebKit content blockers accept up to 150,000 rules each; keep headroom. */
export const CB_RULES_PER_BLOCKER = 145_000;

const SEP = '[^a-zA-Z0-9_.%-]';
const SEP_OR_END = `(${SEP}.*)?$`;
const HOST_PREFIX = '^[^:]+:(//)?([^/]+\\.)?';
const META = new Set(['.', '+', '?', '(', ')', '[', ']', '{', '}', '\\', '$', '|', '*', '^']);

function escapeLiteral(s: string): string {
  let out = '';
  for (const ch of s) out += META.has(ch) ? `\\${ch}` : ch;
  return out;
}

/** DNR urlFilter syntax (`||`, `|`, `*`, `^`) → WebKit url-filter; null when not ASCII. */
export function urlFilterToRegex(filter: string): string | null {
  if (!/^[\x20-\x7e]*$/.test(filter)) return null;
  let f = filter;
  let prefix = '';
  if (f.startsWith('||')) {
    prefix = HOST_PREFIX;
    f = f.slice(2);
  } else if (f.startsWith('|')) {
    prefix = '^';
    f = f.slice(1);
  }
  let end = false;
  if (f.endsWith('|') && !f.endsWith('\\|')) {
    end = true;
    f = f.slice(0, -1);
  }
  let body = '';
  for (let i = 0; i < f.length; i++) {
    const ch = f[i]!;
    if (ch === '*') body += '.*';
    else if (ch === '^') body += i === f.length - 1 ? SEP_OR_END : SEP;
    else body += META.has(ch) ? `\\${ch}` : ch;
  }
  if (end && !body.endsWith('$')) body += '$';
  let re = prefix + body;
  // Leading/trailing `.*` add nothing to an unanchored match and slow WebKit's compiler.
  if (!prefix) re = re.replace(/^(\.\*)+/, '');
  if (!re.endsWith('$')) re = re.replace(/(\.\*)+$/, '');
  return re || '.*';
}

/** Most URL-filter variants one regex may expand to (alternation). */
const MAX_REGEX_VARIANTS = 32;
/** Longest expansion of a counted repetition (`x{n,m}`). */
const MAX_REPEAT = 64;

/**
 * Expand `(a|b)` alternations (groups without nesting, and top-level `a|b`)
 * into separate patterns; WebKit has no alternation. null when the result
 * would be too large or the groups are nested.
 */
export function expandAlternation(src: string): string[] | null {
  // Top-level alternation.
  const top = splitTop(src);
  if (top === null) return null;
  if (top.length > 1) {
    const out: string[] = [];
    for (const t of top) {
      const e = expandAlternation(t);
      if (!e) return null;
      out.push(...e);
      if (out.length > MAX_REGEX_VARIANTS) return null;
    }
    return out;
  }
  // First group that contains `|`.
  let depth = 0;
  let inClass = false;
  let open = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { depth++; if (depth === 1) open = i; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0 && open >= 0) {
        const inner0 = src.slice(open + 1, i);
        const inner = inner0.startsWith('?:') ? inner0.slice(2) : inner0;
        if (inner.startsWith('?')) return null; // lookaround
        const parts = splitTop(inner);
        if (parts === null) return null;
        if (parts.length > 1) {
          if (parts.some((p) => p.includes('('))) return null;
          // A quantifier on the group applies to each alternative's group.
          const out: string[] = [];
          for (const p of parts) {
            const e = expandAlternation(src.slice(0, open) + '(' + p + ')' + src.slice(i + 1));
            if (!e) return null;
            out.push(...e);
            if (out.length > MAX_REGEX_VARIANTS) return null;
          }
          return out;
        }
        open = -1;
      }
    }
  }
  return [src];
}

/** Split on `|` outside groups and classes; null on unbalanced input. */
function splitTop(src: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let last = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return null; }
    else if (ch === '|' && depth === 0) { out.push(src.slice(last, i)); last = i + 1; }
  }
  if (depth !== 0 || inClass) return null;
  out.push(src.slice(last));
  return out;
}

/**
 * A filter-list regex → WebKit's subset (literals, `.`, `*`, `+`, `?`, classes,
 * groups, `^` at the start, `$` at the end): `\d` / `\w` rewritten, `x{n,m}`
 * spelled out, `(a|b)` expanded into several patterns. null when it can't be
 * expressed exactly (lookaround, `\b`, back-references, nested alternation...).
 */
export function regexToWebKitAll(src: string): string[] | null {
  if (!/^[\x20-\x7e]*$/.test(src)) return null;
  const alts = expandAlternation(src);
  if (!alts) return null;
  const out: string[] = [];
  for (const a of alts) {
    const r = regexToWebKit(a);
    if (!r) return null;
    out.push(r);
  }
  return [...new Set(out)];
}

/** One alternation-free regex → WebKit's subset (see regexToWebKitAll); null if not expressible. */
export function regexToWebKit(src: string): string | null {
  if (!/^[\x20-\x7e]*$/.test(src)) return null;
  // Tokens: each is one atom (with a possible quantifier appended later).
  const toks: string[] = [];
  let inClass = false;
  let cls = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') {
      const n = src[i + 1];
      if (n === undefined) return null;
      i++;
      let t: string;
      if (n === 'd') t = inClass ? '0-9' : '[0-9]';
      else if (n === 'w') t = inClass ? 'a-zA-Z0-9_' : '[a-zA-Z0-9_]';
      else if (/[A-Za-z0-9]/.test(n)) return null; // \b \s \D \1 \u ...: not in WebKit's subset
      else if (n === '/') t = '/';
      else t = `\\${n}`;
      if (inClass) cls += t;
      else toks.push(t);
      continue;
    }
    if (inClass) {
      cls += ch;
      if (ch === ']' && cls.length > 1 && !(cls === '[^]')) {
        inClass = false;
        toks.push(cls);
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      cls = '[';
      continue;
    }
    if (ch === '|') return null;
    if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!m) return null;
      const prev = toks.pop();
      if (prev === undefined || prev === ')' || /[*+?}]$/.test(prev) && !prev.startsWith('[') && !prev.startsWith('\\')) return null;
      const n = Number(m[1]);
      const max = m[2] === undefined ? n : m[3] === '' ? Infinity : Number(m[3]);
      if (max < n || n > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) return null;
      let rep = prev.repeat(n);
      if (max === Infinity) rep += n === 0 ? `${prev}*` : `${prev}*`;
      else rep += `${prev}?`.repeat(max - n);
      toks.push(rep);
      i += m[0].length - 1;
      continue;
    }
    if (ch === '}') return null;
    if (ch === '(') {
      if (src.startsWith('(?:', i)) {
        toks.push('(');
        i += 2;
        continue;
      }
      if (src[i + 1] === '?') return null;
    }
    if (ch === '^' && i !== 0) return null;
    if (ch === '$' && i !== src.length - 1) return null;
    toks.push(ch);
  }
  if (inClass) return null;
  const out = toks.join('');
  return out || null;
}

function hostRegex(host: string): string {
  return `${HOST_PREFIX}${escapeLiteral(host)}[:/]`;
}

const TYPE_MAP: Partial<Record<ResourceTypeName, CbResourceType[]>> = {
  script: ['script'],
  stylesheet: ['style-sheet'],
  image: ['image', 'svg-document'],
  font: ['font'],
  media: ['media'],
  xmlhttprequest: ['raw'],
  websocket: ['raw'],
  ping: ['raw'],
  other: ['raw'],
  object: ['raw'],
  csp_report: ['raw'],
};
const ALL_SUBRESOURCES: CbResourceType[] = ['image', 'svg-document', 'style-sheet', 'script', 'font', 'raw', 'media'];

/**
 * The trigger variants for a DNR resource-type list: subresources, and frames
 * as `document` (child frames; the top frame only for rules that name it, e.g.
 * `$document` blocks of ad landing pages). One variant per list.
 */
function typeVariants(types: ResourceTypeName[] | undefined): Array<Pick<CbTrigger, 'resource-type' | 'load-context'>> {
  if (!types) return [{ 'resource-type': ALL_SUBRESOURCES }, { 'resource-type': ['document'], 'load-context': ['child-frame'] }];
  const sub = new Set<CbResourceType>();
  for (const t of types) for (const c of TYPE_MAP[t] ?? []) sub.add(c);
  const out: Array<Pick<CbTrigger, 'resource-type' | 'load-context'>> = [];
  if (sub.size) out.push({ 'resource-type': ALL_SUBRESOURCES.filter((t) => sub.has(t)) });
  const top = types.includes('main_frame');
  const child = types.includes('sub_frame');
  if (top && child) out.push({ 'resource-type': ['document'] });
  else if (child) out.push({ 'resource-type': ['document'], 'load-context': ['child-frame'] });
  else if (top) out.push({ 'resource-type': ['document'], 'load-context': ['top-frame'] });
  return out;
}

const domainsFor = (list: string[]) => list.map((d) => `*${d}`);

/** URL-filter variants of a condition (one per request domain). null + reason when not expressible. */
function urlFilters(c: DnrCondition): { filters: string[]; caseSensitive: boolean } | string {
  const cs = !!c.isUrlFilterCaseSensitive;
  if (c.requestDomains?.length) {
    if (c.urlFilter || c.regexFilter) return 'request-domains-with-pattern';
    return { filters: c.requestDomains.map(hostRegex), caseSensitive: false };
  }
  if (c.regexFilter) {
    const res = regexToWebKitAll(c.regexFilter);
    return res ? { filters: res, caseSensitive: cs } : 'regex-unsupported';
  }
  if (c.urlFilter) {
    const re = urlFilterToRegex(c.urlFilter);
    return re ? { filters: [re], caseSensitive: cs } : 'non-ascii';
  }
  return { filters: ['.*'], caseSensitive: false };
}

export interface CbConvertStats {
  /** Network rules that produced content-blocker rules. */
  converted: number;
  /** Rules left to the web extension only (redirect transforms, headers...). */
  dnrOnly: number;
  /** Rules that can't be expressed, by reason. */
  skipped: Record<string, number>;
  popupRules: number;
  /** `$redirect` rules the web extension doesn't have installed, blocked outright instead. */
  redirectsBlocked?: number;
}

/**
 * Convert one compiled DNR rule into units (see Entry): each unit is a rule
 * followed by its own exclusions. `popup`: match popups (new windows) instead of loads.
 */
export function dnrRuleToCb(r: DnrRuleNoId, popup = false): CbRule[][] | string {
  const c = r.condition;
  if (c.requestMethods?.length || c.excludedRequestMethods?.length) return 'request-method';
  if (c.responseHeaders || c.excludedResponseHeaders) return 'response-headers';
  if (c.tabIds) return 'tab-ids';
  const act = r.action.type;

  if (act === 'allowAllRequests') {
    // Whole-page exception: everything on a page whose address matches (popups too).
    const base: CbTrigger = { 'url-filter': '.*', 'resource-type': [...ALL_SUBRESOURCES, 'document', 'popup'] };
    if (c.requestDomains?.length && !c.urlFilter && !c.regexFilter) {
      if (c.initiatorDomains || c.excludedInitiatorDomains) return 'document-exception-with-domains';
      return [[{ trigger: { ...base, 'if-domain': domainsFor(c.requestDomains) }, action: { type: 'ignore-previous-rules' } }]];
    }
    if (c.initiatorDomains || c.excludedInitiatorDomains || c.requestDomains) return 'document-exception-with-domains';
    const uf = urlFilters(c);
    if (typeof uf === 'string') return uf;
    if (uf.filters.length !== 1 || uf.filters[0] === '.*') return 'document-exception-everywhere';
    return [[{ trigger: { ...base, 'if-top-url': uf.filters, ...(uf.caseSensitive ? { 'url-filter-is-case-sensitive': true } : {}) }, action: { type: 'ignore-previous-rules' } }]];
  }

  let type: CbRule['action']['type'];
  if (act === 'block') type = 'block';
  else if (act === 'allow') type = 'ignore-previous-rules';
  else if (act === 'redirect' && r.action.redirect?.extensionPath) type = 'ignore-previous-rules'; // the web extension redirects it
  else return 'dnr-only';

  const uf = urlFilters(c);
  if (typeof uf === 'string') return uf;
  const variants = popup ? [{ 'resource-type': ['popup'] as CbResourceType[] }] : typeVariants(c.resourceTypes);
  if (!variants.length) return 'no-content-blocker-types';
  const loadType = c.domainType === 'firstParty' ? ['first-party' as const] : c.domainType === 'thirdParty' ? ['third-party' as const] : undefined;

  const out: CbRule[][] = [];
  for (const filter of uf.filters) {
    for (const v of variants) {
      const trigger: CbTrigger = { 'url-filter': filter, ...v };
      if (uf.caseSensitive) trigger['url-filter-is-case-sensitive'] = true;
      if (loadType) trigger['load-type'] = loadType;
      if (c.initiatorDomains?.length) trigger['if-domain'] = domainsFor(c.initiatorDomains);
      else if (c.excludedInitiatorDomains?.length) trigger['unless-domain'] = domainsFor(c.excludedInitiatorDomains);
      const unit: CbRule[] = [{ trigger, action: { type } }];
      out.push(unit);
      // WebKit allows if-domain or unless-domain, not both: the excluded sites
      // (usually subdomains of the included ones) get a following exception.
      if (c.initiatorDomains?.length && c.excludedInitiatorDomains?.length && type === 'block') {
        unit.push({ trigger: { ...trigger, 'if-domain': domainsFor(c.excludedInitiatorDomains) }, action: { type: 'ignore-previous-rules' } });
      }
      // Excluded request hosts (`$denyallow`, `$to=~x`): an exception right after.
      if (c.excludedRequestDomains?.length && type === 'block') {
        for (const h of c.excludedRequestDomains) {
          const t: CbTrigger = { ...trigger, 'url-filter': hostRegex(h) };
          delete t['url-filter-is-case-sensitive'];
          unit.push({ trigger: t, action: { type: 'ignore-previous-rules' } });
        }
      }
    }
  }
  return out;
}

/**
 * Endings an entity domain (`domain=yts.*`) is expanded to. WebKit's if-domain
 * has no wildcard ending; these cover where such sites actually live (mostly
 * pirate, streaming and adult sites that hop between endings).
 */
export const ENTITY_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'me', 'to', 'cc', 'tv', 'info', 'biz', 'xyz', 'top', 'site', 'online', 'live',
  'club', 'pro', 'ws', 'sx', 'si', 'li', 'lol', 'mx', 'nl', 'ru', 'de', 'fr', 'it', 'es', 'pl', 'se', 'ch', 'be',
  'at', 'cz', 'pt', 'uk', 'co.uk', 'eu', 'us', 'ca', 'in', 'br', 'com.br', 'ag', 'am', 'cx', 'is', 'la', 'lu',
  'ms', 'nu', 'pw', 'rs', 'su', 'tw', 'ug', 'vc', 'mov', 'fun', 'icu', 'cfd', 'sbs', 'cyou', 'bond', 'skin', 'click',
];

function expandEntity(list: string[]): string[] {
  const out: string[] = [];
  for (const d of list) {
    if (d.endsWith('.*')) for (const t of ENTITY_TLDS) out.push(`${d.slice(0, -2)}.${t}`);
    else out.push(d);
  }
  return out;
}

/** A rule whose `domain=` names entity domains (`site.*`), with them spelled out; else the rule itself. */
function withEntitiesExpanded(rule: NetworkRule): NetworkRule {
  const has = (l: string[]) => l.some((d) => d.endsWith('.*'));
  if (!has(rule.includeDomains) && !has(rule.excludeDomains)) return rule;
  return { ...rule, includeDomains: expandEntity(rule.includeDomains), excludeDomains: expandEntity(rule.excludeDomains) };
}

export interface CbBuildOptions {
  /** Number of content blockers to fill. */
  blockers: number;
  perBlocker?: number;
  tierOf?: (ruleIndex: number) => number;
  /** Extra DNR rules (the user's allowlist, site-fix overlay) applied on top. */
  extraDnr?: DnrRuleNoId[];
  /**
   * `redirectKeys` of the `$redirect` rules the web extension actually has installed.
   * A content blocker can't redirect, so it lets a redirect target through for the
   * web extension to swap in a stub; one the web extension doesn't have (Safari's
   * DNR cap) is blocked instead, or the real ad script would load. Undefined: every
   * redirect is assumed installed (tests).
   */
  dnrRedirects?: ReadonlySet<string>;
}

/**
 * Keys identifying a `$redirect` rule, one per request domain (DNR may merge
 * host-only rules into one rule with many `requestDomains`).
 */
export function redirectKeys(r: { action: { type: string; redirect?: { extensionPath?: string } }; condition: DnrCondition }): string[] {
  const path = r.action.redirect?.extensionPath;
  if (r.action.type !== 'redirect' || !path) return [];
  const c = r.condition;
  const sorted = (l?: string[]) => (l ?? []).slice().sort().join(',');
  const base = [c.urlFilter ?? '', c.regexFilter ?? '', path, sorted(c.initiatorDomains), sorted(c.excludedInitiatorDomains), c.domainType ?? ''];
  const hosts = c.requestDomains?.length ? c.requestDomains : [''];
  return hosts.map((h) => [...base, h].join('|'));
}

export interface CbBuildResult {
  lists: CbRule[][];
  stats: CbConvertStats & {
    blockRules: number;
    exceptionRules: number;
    /** Block rules that didn't fit in any content blocker (lowest tier first). */
    overflow: number;
  };
}

/** Compile the engine's network rules into `blockers` content-blocker rule lists. */
export function buildContentBlockers(rules: NetworkRule[], opts: CbBuildOptions): CbBuildResult {
  const per = opts.perBlocker ?? CB_RULES_PER_BLOCKER;
  const stats: CbConvertStats = { converted: 0, dnrOnly: 0, skipped: {}, popupRules: 0 };
  const skip = (reason: string) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
  };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let order = 0;
  const add = (units: CbRule[][], priority: number, tier: number) => {
    for (const rules of units) {
      const key = `${priority}|${JSON.stringify(rules)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ rules, priority, tier, order: order++ });
    }
  };

  rules.forEach((rule0, i) => {
    const tier = opts.tierOf?.(i) ?? 0;
    const rule = withEntitiesExpanded(rule0);
    let any = false;
    let dnrOnly = false;
    if (rule.types & ~RT.POPUP) {
      const res = compileNetworkRule(rule, 'safari');
      if (res.ok) {
        for (const r0 of res.rules) {
          const r = opts.dnrRedirects && redirectKeys(r0).some((k) => !opts.dnrRedirects!.has(k)) ? { ...r0, action: { type: 'block' as const } } : r0;
          if (r !== r0) stats.redirectsBlocked = (stats.redirectsBlocked ?? 0) + 1;
          const cb = dnrRuleToCb(r);
          if (typeof cb === 'string') {
            if (cb === 'dnr-only') dnrOnly = true;
            else skip(cb);
          } else {
            add(cb, r.priority, tier);
            any = true;
          }
        }
      } else if (!res.notInDnr || res.reason !== 'popup-only') {
        skip(res.reason);
      }
    }
    // Popups: compiled as an ordinary subresource rule, then matched as a popup.
    if (rule.types & RT.POPUP && !rule.modifier) {
      const res = compileNetworkRule({ ...rule, types: RT.IMAGE }, 'safari');
      if (res.ok) {
        for (const r of res.rules) {
          if (r.action.type !== 'block' && r.action.type !== 'allow') continue;
          const cb = dnrRuleToCb(r, true);
          if (typeof cb === 'string') skip(`popup-${cb}`);
          else {
            add(cb, r.priority, tier);
            stats.popupRules++;
            any = true;
          }
        }
      } else skip(`popup-${res.reason}`);
    }
    if (any) stats.converted++;
    else if (dnrOnly) stats.dnrOnly++;
  });
  for (const r of opts.extraDnr ?? []) {
    const cb = dnrRuleToCb(r);
    if (typeof cb === 'string') skip(`extra-${cb}`);
    else add(cb, r.priority, -1);
  }

  // Exceptions go into every content blocker (each blocker is evaluated on its own);
  // block rules are shared out, primary lists first.
  const exceptions = entries.filter((e) => e.rules[0]!.action.type === 'ignore-previous-rules');
  const exceptionRules = exceptions.reduce((n, e) => n + e.rules.length, 0);
  const blocks = entries.filter((e) => e.rules[0]!.action.type === 'block').sort((a, b) => a.tier - b.tier || a.order - b.order);
  const room = Math.max(0, per - exceptionRules);
  const lists: CbRule[][] = [];
  let next = 0;
  let blockRules = 0;
  for (const e of blocks) blockRules += e.rules.length;
  let placed = 0;
  for (let b = 0; b < opts.blockers; b++) {
    const share: Entry[] = [];
    let size = 0;
    while (next < blocks.length && size + blocks[next]!.rules.length <= room) {
      size += blocks[next]!.rules.length;
      share.push(blocks[next++]!);
    }
    placed += size;
    const all = [...share, ...exceptions].sort((x, y) => x.priority - y.priority || rank(x) - rank(y) || x.order - y.order);
    lists.push(all.flatMap((e) => e.rules));
  }
  return {
    lists,
    stats: { ...stats, blockRules, exceptionRules, overflow: blockRules - placed },
  };
}

/**
 * Order within a priority: rules with their own exclusions first (so an
 * exclusion can't cancel an unrelated block placed before it), then other
 * blocks, then exceptions (which override blocks of the same priority).
 */
function rank(e: Entry): number {
  if (e.rules[0]!.action.type !== 'block') return 2;
  return e.rules.length > 1 ? 0 : 1;
}

/** A content blocker must hold at least one rule; this one never matches. */
export const CB_EMPTY: CbRule[] = [{ trigger: { 'url-filter': '^adblocker-empty-list:' }, action: { type: 'block' } }];

export { PRIORITY };
