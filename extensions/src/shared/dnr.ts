// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Network filter → declarativeNetRequest compiler (Chrome, Safari).
//
// Priorities (DNR picks the highest; at equal priority allow > allowAllRequests
// > block > upgradeScheme > redirect):
//   10000  user allowlist (allowAllRequests)
//    3000  $important block      3001 $important redirect
//    2000  @@ exceptions (allow / allowAllRequests for $document)
//    1001  $redirect             1000 block, $removeparam (redirect+transform),
//                                     $csp / $removeheader (modifyHeaders)
//
// `||host^` rules sharing all other conditions are merged into one rule with a
// `requestDomains` list, which is what keeps EasyList+EasyPrivacy under
// Chrome's dynamic-rule limit.

import { modifierKey } from './engine.ts';
import { resourcePath } from './resources.ts';
import { toAsciiHost } from './domain.ts';
import { RT, RT_ALL_BUT_DOCUMENT } from './types.ts';
import type { NetworkRule } from './types.ts';

export type ResourceTypeName =
  | 'main_frame' | 'sub_frame' | 'stylesheet' | 'script' | 'image' | 'font' | 'object' | 'xmlhttprequest'
  | 'ping' | 'csp_report' | 'media' | 'websocket' | 'webtransport' | 'webbundle' | 'other';

export interface DnrCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  requestMethods?: string[];
  excludedRequestMethods?: string[];
  resourceTypes?: ResourceTypeName[];
  domainType?: 'firstParty' | 'thirdParty';
  /** Session rules only. */
  tabIds?: number[];
  /** Chrome ≥128: match on response headers. */
  responseHeaders?: DnrHeaderMatch[];
  excludedResponseHeaders?: DnrHeaderMatch[];
}

export interface DnrHeaderMatch {
  header: string;
  values?: string[];
  excludedValues?: string[];
}

export interface DnrHeaderOp {
  header: string;
  operation: 'append' | 'set' | 'remove';
  value?: string;
}

export interface DnrAction {
  type: 'block' | 'allow' | 'allowAllRequests' | 'redirect' | 'modifyHeaders' | 'upgradeScheme';
  redirect?: { extensionPath?: string; regexSubstitution?: string; url?: string; transform?: { query?: string; queryTransform?: { removeParams?: string[] } } };
  responseHeaders?: DnrHeaderOp[];
  requestHeaders?: DnrHeaderOp[];
}

export interface DnrRule {
  id: number;
  priority: number;
  action: DnrAction;
  condition: DnrCondition;
}

export type DnrRuleNoId = Omit<DnrRule, 'id'>;

export interface DnrLimits {
  /** All dynamic rules (Chrome ≥121: 30000). */
  dynamic: number;
  /** Dynamic rules that are not block/allow/allowAllRequests/upgradeScheme (Chrome: 5000). */
  dynamicUnsafe: number;
  session: number;
  sessionUnsafe: number;
  /** Regex rules across dynamic+session (Chrome: 1000). */
  regex: number;
}

export const CHROME_LIMITS: DnrLimits = { dynamic: 30000, dynamicUnsafe: 5000, session: 5000, sessionUnsafe: 5000, regex: 1000 };

export type Platform = 'chrome' | 'safari';

export interface CompileOptions {
  limits?: DnrLimits;
  platform?: Platform;
  /** Slots kept free in the dynamic ruleset (the user allowlist rule lives there). */
  reservedDynamic?: number;
  /** Runtime RE2 check (chrome.declarativeNetRequest.isRegexSupported results). */
  isRegexSupported?: (source: string, caseSensitive: boolean) => boolean;
  /** Max domains per merged rule. */
  mergeChunk?: number;
  /**
   * Install priority of a network rule (by its index in the input): tier 0 is
   * installed before tier 1, so when the browser's rule limit is reached the
   * primary lists (EasyList, EasyPrivacy, the user's own rules) are never
   * crowded out by optional lists. Exceptions always go first.
   */
  tierOf?: (ruleIndex: number) => number;
}

export type CompileOne =
  | { ok: true; rules: DnrRuleNoId[]; note?: string }
  | { ok: false; reason: string; notInDnr?: boolean };

export const PRIORITY = {
  ALLOWLIST: 10000,
  IMPORTANT: 3000,
  EXCEPTION: 2000,
  REDIRECT: 1001,
  BLOCK: 1000,
} as const;

const TYPE_NAMES: Array<[number, ResourceTypeName[]]> = [
  [RT.DOCUMENT, ['main_frame']],
  [RT.SUBDOCUMENT, ['sub_frame']],
  [RT.SCRIPT, ['script']],
  [RT.STYLESHEET, ['stylesheet']],
  [RT.IMAGE, ['image']],
  [RT.FONT, ['font']],
  [RT.MEDIA, ['media']],
  [RT.XHR, ['xmlhttprequest']],
  [RT.WEBSOCKET, ['websocket']],
  [RT.PING, ['ping']],
  [RT.OBJECT, ['object']],
  [RT.OTHER, ['other', 'csp_report', 'webtransport', 'webbundle']],
];

const SAFARI_UNSUPPORTED_TYPES = new Set<ResourceTypeName>(['object', 'csp_report', 'webtransport', 'webbundle']);

function resourceTypes(mask: number, platform: Platform): ResourceTypeName[] | null | undefined {
  const m = mask & ~RT.POPUP;
  if (m === RT_ALL_BUT_DOCUMENT && platform === 'chrome') return undefined; // DNR default
  const out: ResourceTypeName[] = [];
  for (const [bit, names] of TYPE_NAMES) if (m & bit) out.push(...names);
  const filtered = platform === 'safari' ? out.filter((t) => !SAFARI_UNSUPPORTED_TYPES.has(t)) : out;
  return filtered.length ? filtered : null;
}

/** RE2 (Chrome DNR) rejects lookaround and backreferences. */
export function regexLooksRe2Compatible(source: string): boolean {
  return !/\(\?[=!]|\(\?<[=!]|\\[1-9]|\\k</.test(source);
}

function asciiDomains(list: string[]): string[] | null {
  const out: string[] = [];
  for (const d of list) {
    const a = toAsciiHost(d);
    if (!a || !/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/.test(a)) return null;
    out.push(a);
  }
  return out;
}

/** Translate the URL pattern of one rule; null + reason when DNR can't express it. */
function patternCondition(rule: NetworkRule): DnrCondition | string {
  const p = rule.pattern;
  if (p.kind === 'regex') {
    if (!regexLooksRe2Compatible(p.source)) return 'regex-not-re2';
    if (!/^[\x00-\x7f]*$/.test(p.source)) return 'non-ascii';
    return { regexFilter: p.source, ...(rule.matchCase ? { isUrlFilterCaseSensitive: true } : {}) };
  }
  let { anchor, body } = p;
  if (rule.pureHost && !rule.matchCase) {
    const host = toAsciiHost(rule.pureHost);
    if (!host) return 'bad-host';
    return { requestDomains: [host] };
  }
  if (anchor === 'host' && body.startsWith('*')) {
    anchor = 'none';
    body = body.replace(/^\*+/, '');
  }
  if (anchor === 'host' && !body) return 'empty-host-pattern';
  if (!/^[\x00-\x7f]*$/.test(body)) {
    if (anchor !== 'host') return 'non-ascii';
    const m = /^([^/^:*?|]*)(.*)$/.exec(body)!;
    const host = toAsciiHost(m[1]!);
    if (!host || !/^[\x00-\x7f]*$/.test(m[2]!)) return 'non-ascii';
    body = host + m[2];
  }
  const filter = (anchor === 'host' ? '||' : anchor === 'start' ? '|' : '') + body + (p.endAnchor ? '|' : '');
  if (!filter || filter === '*') return {};
  return { urlFilter: filter, ...(rule.matchCase ? { isUrlFilterCaseSensitive: true } : {}) };
}

/** Compile one parsed network rule (not modifier exceptions, which need context). */
export function compileNetworkRule(rule: NetworkRule, platform: Platform = 'chrome'): CompileOne {
  if ((rule.types & ~RT.POPUP) === 0) return { ok: false, reason: 'popup-only', notInDnr: true };
  if (rule.exception && (rule.generichide || rule.elemhide) && rule.types === RT.DOCUMENT) {
    return { ok: false, reason: 'cosmetic-only', notInDnr: true };
  }
  if (rule.exception && rule.modifier) return { ok: false, reason: 'modifier-exception', notInDnr: true };

  const pc = patternCondition(rule);
  if (typeof pc === 'string') return { ok: false, reason: pc };
  const cond: DnrCondition = { ...pc };

  // $domain
  const inc = rule.includeDomains.filter((d) => !d.endsWith('.*'));
  if (rule.excludeDomains.some((d) => d.endsWith('.*'))) return { ok: false, reason: 'entity-domain' };
  if (rule.includeDomains.length && !inc.length) return { ok: false, reason: 'entity-domain' };
  if (inc.length) {
    const a = asciiDomains(inc);
    if (!a) return { ok: false, reason: 'bad-domain' };
    cond.initiatorDomains = a;
  }
  if (rule.excludeDomains.length) {
    const a = asciiDomains(rule.excludeDomains);
    if (!a) return { ok: false, reason: 'bad-domain' };
    cond.excludedInitiatorDomains = a;
  }
  if (rule.thirdParty !== null) cond.domainType = rule.thirdParty ? 'thirdParty' : 'firstParty';
  const x = rule.extra;
  if (x?.navigation || x?.genericblock) return { ok: false, reason: x.navigation ? 'navigation-rule' : 'genericblock', notInDnr: true };
  if (x?.redirectException) return { ok: false, reason: 'redirect-exception', notInDnr: true };
  if (x) {
    if (x.methods?.length) cond.requestMethods = x.methods.map((m) => m.toLowerCase());
    if (x.notMethods?.length) cond.excludedRequestMethods = x.notMethods.map((m) => m.toLowerCase());
    // DNR has no same-host test: `$strict1p` would over-match as firstParty.
    if (x.strictThirdParty === false) return { ok: false, reason: 'strict1p' };
    // `$strict3p` as thirdParty matches a subset (other sites only): safe.
    if (x.strictThirdParty === true && rule.thirdParty === null) cond.domainType = 'thirdParty';
    const not = [...x.denyallow, ...x.toExclude];
    if ([...not, ...x.toInclude].some((d) => d.endsWith('.*'))) return { ok: false, reason: 'entity-domain' };
    if (not.length) {
      const a = asciiDomains(not);
      if (!a) return { ok: false, reason: 'bad-domain' };
      cond.excludedRequestDomains = [...(cond.excludedRequestDomains ?? []), ...a];
    }
    if (x.toInclude.length) {
      if (cond.requestDomains) return { ok: false, reason: 'to-with-host' };
      const a = asciiDomains(x.toInclude);
      if (!a) return { ok: false, reason: 'bad-domain' };
      cond.requestDomains = a;
    }
  }

  const withTypes = (mask: number, c: DnrCondition): DnrCondition | null => {
    const rt = resourceTypes(mask, platform);
    if (rt === null) return null;
    return rt ? { ...c, resourceTypes: rt } : { ...c };
  };

  // Exceptions.
  if (rule.exception) {
    if (rule.redirect) return { ok: false, reason: 'redirect-exception' };
    const rules: DnrRuleNoId[] = [];
    const docMask = rule.types & (RT.DOCUMENT | RT.SUBDOCUMENT);
    if (rule.types & RT.DOCUMENT) {
      // Whole-page allowlisting: everything loaded by a matching page or frame.
      rules.push({
        priority: PRIORITY.EXCEPTION,
        action: { type: 'allowAllRequests' },
        condition: { ...cond, resourceTypes: ['main_frame', 'sub_frame'] },
      });
      const rest = rule.types & ~RT.POPUP & ~docMask;
      if (rest) {
        const c = withTypes(rest, cond);
        if (c) rules.push({ priority: PRIORITY.EXCEPTION, action: { type: 'allow' }, condition: c });
      }
    } else {
      const c = withTypes(rule.types, cond);
      if (!c) return { ok: false, reason: 'no-supported-types' };
      rules.push({ priority: PRIORITY.EXCEPTION, action: { type: 'allow' }, condition: c });
    }
    return { ok: true, rules };
  }

  const c = withTypes(rule.types, cond);
  if (!c) return { ok: false, reason: 'no-supported-types' };

  // Modifiers.
  if (rule.modifier) {
    const m = rule.modifier;
    if (m.kind === 'removeparam') {
      let redirect: DnrAction['redirect'];
      let filter: string;
      if (m.param.kind === 'name') {
        if (!/^[\x21-\x7e]+$/.test(m.param.name) || /[*^|]/.test(m.param.name)) return { ok: false, reason: 'removeparam-bad-name' };
        redirect = { transform: { queryTransform: { removeParams: [m.param.name] } } };
        filter = `^${m.param.name}=`;
      } else if (m.param.kind === 'all') {
        redirect = { transform: { query: '' } };
        filter = '?';
      } else return { ok: false, reason: `removeparam-${m.param.kind}` };
      // A redirect rule that matches every request would outrank lower-priority
      // modifyHeaders rules on all of them, so only match URLs that carry the
      // parameter (`^` matches the `?` / `&` before it). A rule that already has
      // a URL pattern keeps it (DNR has one urlFilter per rule).
      const cond = c.urlFilter || c.regexFilter ? c : { ...c, urlFilter: filter };
      return { ok: true, rules: [{ priority: PRIORITY.BLOCK, action: { type: 'redirect', redirect }, condition: cond }] };
    }
    if (m.kind === 'csp') {
      if (!m.value) return { ok: false, reason: 'csp-empty' };
      return {
        ok: true,
        rules: [{ priority: PRIORITY.BLOCK, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: m.value }] }, condition: c }],
      };
    }
    return {
      ok: true,
      rules: [{ priority: PRIORITY.BLOCK, action: { type: 'modifyHeaders', responseHeaders: [{ header: m.value, operation: 'remove' }] }, condition: c }],
    };
  }

  // Block / redirect.
  const base = rule.important ? PRIORITY.IMPORTANT : PRIORITY.BLOCK;
  if (rule.redirect) {
    if (rule.redirectRule) return { ok: false, reason: 'redirect-rule' };
    const path = resourcePath(rule.redirect);
    if (path) {
      return { ok: true, rules: [{ priority: base + 1, action: { type: 'redirect', redirect: { extensionPath: path } }, condition: c }] };
    }
    return { ok: true, rules: [{ priority: base, action: { type: 'block' }, condition: c }], note: 'redirect-unknown-as-block' };
  }
  return { ok: true, rules: [{ priority: base, action: { type: 'block' }, condition: c }] };
}

export function isUnsafe(r: DnrRuleNoId): boolean {
  return !['block', 'allow', 'allowAllRequests', 'upgradeScheme'].includes(r.action.type);
}

export interface DroppedRule {
  raw: string;
  reason: string;
}

export interface CompileResult {
  dynamic: DnrRule[];
  session: DnrRule[];
  dropped: DroppedRule[];
  droppedByReason: Record<string, number>;
  /** Rules handled outside DNR (popup-only → popup blocker, cosmetic-only → content script...). */
  notInDnr: Record<string, number>;
  notes: Record<string, number>;
  stats: {
    inputRules: number;
    compiledRules: number;
    mergedHostRules: number;
    regexRules: number;
    unsafeRules: number;
    dynamicRules: number;
    sessionRules: number;
  };
}

interface Candidate {
  rule: DnrRuleNoId;
  raws: string[];
  category: number;
  order: number;
  tier: number;
  source: NetworkRule | null;
}

function categoryOf(r: DnrRuleNoId): number {
  // Exceptions first (they prevent breakage), then $important, then the few
  // redirect/header rules, then merged host rules (most coverage per slot),
  // then everything else in list order.
  if (r.action.type === 'allow' || r.action.type === 'allowAllRequests') return 0;
  if (r.priority >= PRIORITY.IMPORTANT) return 1;
  if (isUnsafe(r)) return 2;
  if (r.condition.requestDomains && !r.condition.urlFilter && !r.condition.regexFilter) return 3;
  return 4;
}

function bump(map: Record<string, number>, k: string, n = 1): void {
  map[k] = (map[k] ?? 0) + n;
}

/** Compile a whole rule set into dynamic + session rules within the limits. */
export function compileToDnr(rules: NetworkRule[], opts: CompileOptions = {}): CompileResult {
  const limits = opts.limits ?? CHROME_LIMITS;
  const platform = opts.platform ?? 'chrome';
  const reserved = opts.reservedDynamic ?? 1;
  const chunk = opts.mergeChunk ?? 1000;
  const dropped: DroppedRule[] = [];
  const droppedByReason: Record<string, number> = {};
  const notInDnr: Record<string, number> = {};
  const notes: Record<string, number> = {};
  const drop = (raw: string, reason: string) => {
    dropped.push({ raw, reason });
    bump(droppedByReason, reason);
  };

  let cands: Candidate[] = [];
  const modifierExceptions: NetworkRule[] = [];
  rules.forEach((rule, order) => {
    if (rule.exception && rule.modifier) {
      modifierExceptions.push(rule);
      return;
    }
    const res = compileNetworkRule(rule, platform);
    if (!res.ok) {
      if (res.notInDnr) bump(notInDnr, res.reason);
      else drop(rule.raw, res.reason);
      return;
    }
    if (res.note) bump(notes, res.note);
    for (const r of res.rules) {
      if (r.condition.regexFilter && opts.isRegexSupported && !opts.isRegexSupported(r.condition.regexFilter, !!r.condition.isUrlFilterCaseSensitive)) {
        drop(rule.raw, 'regex-unsupported');
        continue;
      }
      cands.push({ rule: r, raws: [rule.raw], category: categoryOf(r), order, tier: opts.tierOf?.(order) ?? 0, source: rule });
    }
  });

  // Modifier exceptions: fold into the modifier rules they cancel.
  for (const exc of modifierExceptions) {
    const [kind, value] = modifierKey(exc.modifier!);
    const targets = cands.filter((c) => {
      const m = c.source?.modifier;
      if (!m) return false;
      const [k, v] = modifierKey(m);
      return k === kind && (value === '' || v === value);
    });
    if (!targets.length) {
      bump(notInDnr, 'modifier-exception-without-target');
      continue;
    }
    const p = exc.pattern;
    const emptyPattern = p.kind === 'glob' && p.anchor === 'none' && !p.endAnchor && p.body === '';
    if (exc.pureHost && !exc.includeDomains.length && !exc.excludeDomains.length) {
      const host = toAsciiHost(exc.pureHost);
      if (!host) {
        drop(exc.raw, 'bad-host');
        continue;
      }
      for (const t of targets) {
        t.rule.condition.excludedRequestDomains = [...(t.rule.condition.excludedRequestDomains ?? []), host];
      }
    } else if (emptyPattern && exc.includeDomains.length && !exc.excludeDomains.length && exc.includeDomains.every((d) => !d.endsWith('.*'))) {
      const doms = asciiDomains(exc.includeDomains);
      if (!doms) {
        drop(exc.raw, 'bad-domain');
        continue;
      }
      for (const t of targets) {
        t.rule.condition.excludedInitiatorDomains = [...(t.rule.condition.excludedInitiatorDomains ?? []), ...doms];
      }
    } else if (emptyPattern && !exc.includeDomains.length && !exc.excludeDomains.length) {
      cands = cands.filter((c) => !targets.includes(c));
    } else {
      const same = targets.filter((t) => t.raws.includes(exc.raw.slice(2)));
      if (same.length) cands = cands.filter((c) => !same.includes(c));
      else drop(exc.raw, 'modifier-exception-unsupported');
    }
  }

  // Merge `requestDomains`-only rules with identical everything-else.
  const merged = new Map<string, Candidate>();
  const rest: Candidate[] = [];
  let mergedHostRules = 0;
  for (const c of cands) {
    const cond = c.rule.condition;
    if (cond.requestDomains && !cond.urlFilter && !cond.regexFilter) {
      const { requestDomains, ...others } = cond;
      const key = JSON.stringify([c.tier, c.rule.priority, c.rule.action, others]);
      const m = merged.get(key);
      mergedHostRules++;
      if (m) {
        m.rule.condition.requestDomains!.push(...requestDomains);
        m.raws.push(...c.raws);
        m.order = Math.min(m.order, c.order);
      } else {
        merged.set(key, { ...c, rule: { ...c.rule, condition: { ...cond, requestDomains: [...requestDomains] } }, raws: [...c.raws] });
      }
    } else rest.push(c);
  }
  const all: Candidate[] = [...rest];
  // Hosts a tier-0 merged rule already covers are left out of the same rule in later tiers.
  const coveredBy = new Map<string, Set<string>>();
  const baseKey = (m: Candidate) => {
    const { requestDomains: _d, ...others } = m.rule.condition;
    return JSON.stringify([m.rule.priority, m.rule.action, others]);
  };
  for (const m of [...merged.values()].sort((a, b) => a.tier - b.tier)) {
    const k = baseKey(m);
    const covered = coveredBy.get(k) ?? new Set<string>();
    coveredBy.set(k, covered);
    const doms = [...new Set(m.rule.condition.requestDomains!)].filter((d) => !covered.has(d)).sort();
    for (const d of doms) covered.add(d);
    // Drop subdomains already covered by a parent in the same rule.
    const set = new Set(doms);
    const minimal = doms.filter((d) => {
      let i = d.indexOf('.');
      while (i >= 0) {
        if (set.has(d.slice(i + 1))) return false;
        i = d.indexOf('.', i + 1);
      }
      return true;
    });
    for (let i = 0; i < minimal.length; i += chunk) {
      all.push({ ...m, rule: { ...m.rule, condition: { ...m.rule.condition, requestDomains: minimal.slice(i, i + chunk) } } });
    }
  }

  // Dedupe identical rules.
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const c of all) {
    const k = JSON.stringify(c.rule);
    if (seen.has(k)) {
      bump(notes, 'duplicate');
      continue;
    }
    seen.add(k);
    unique.push(c);
  }

  // Exceptions first (they prevent breakage), then by tier, then by category and list order.
  // Safari: the content blockers already block (and apply their own exceptions), and DNR
  // room is small (a few thousand rules), so what only DNR can do goes first: stub
  // redirects, then the exceptions, then other transforms, then blocks (a fallback for
  // when the content blockers are off). Redirects not installed are blocked by the
  // content blockers instead (safari-cb.ts `dnrRedirects`).
  const safariRank = (c: Candidate) => (c.rule.action.type === 'redirect' && c.rule.action.redirect?.extensionPath ? 0 : c.category === 0 ? 1 : isUnsafe(c.rule) ? 2 : 3 + c.tier);
  const rank = platform === 'safari' ? safariRank : (c: Candidate) => (c.category === 0 ? 0 : 1 + c.tier);
  unique.sort((a, b) => rank(a) - rank(b) || a.category - b.category || a.order - b.order);

  // Allocate within limits.
  const dynamic: DnrRuleNoId[] = [];
  const session: DnrRuleNoId[] = [];
  let dynUnsafe = 0;
  let sesUnsafe = 0;
  let regex = 0;
  const dynCap = Math.max(0, limits.dynamic - reserved);
  for (const c of unique) {
    const r = c.rule;
    const dropAll = (reason: string) => c.raws.forEach((raw) => drop(raw, reason));
    if (r.condition.regexFilter) {
      if (regex >= limits.regex) {
        dropAll('regex-limit');
        continue;
      }
    }
    const unsafe = isUnsafe(r);
    if (dynamic.length < dynCap && (!unsafe || dynUnsafe < limits.dynamicUnsafe)) {
      dynamic.push(r);
      if (unsafe) dynUnsafe++;
    } else if (session.length < limits.session && (!unsafe || sesUnsafe < limits.sessionUnsafe)) {
      session.push(r);
      if (unsafe) sesUnsafe++;
    } else {
      dropAll(unsafe ? 'unsafe-rule-limit' : 'rule-limit');
      continue;
    }
    if (r.condition.regexFilter) regex++;
  }

  const firstDynamicId = reserved + 1;
  return {
    dynamic: dynamic.map((r, i) => ({ id: firstDynamicId + i, ...r })),
    session: session.map((r, i) => ({ id: 1 + i, ...r })),
    dropped,
    droppedByReason,
    notInDnr,
    notes,
    stats: {
      inputRules: rules.length,
      compiledRules: unique.length,
      mergedHostRules,
      regexRules: regex,
      unsafeRules: dynUnsafe + sesUnsafe,
      dynamicRules: dynamic.length,
      sessionRules: session.length,
    },
  };
}

export const ALLOWLIST_RULE_ID = 1;

/** The user's "off on this site" list as one allowAllRequests rule. */
export function allowlistRule(sites: string[]): DnrRule | null {
  // '*': blocking paused everywhere: allow every page.
  if (sites.includes('*')) {
    return { id: ALLOWLIST_RULE_ID, priority: PRIORITY.ALLOWLIST, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame', 'sub_frame'] } };
  }
  const doms = asciiDomains(sites.filter(Boolean));
  if (!doms || !doms.length) return null;
  return {
    id: ALLOWLIST_RULE_ID,
    priority: PRIORITY.ALLOWLIST,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: doms, resourceTypes: ['main_frame', 'sub_frame'] },
  };
}
