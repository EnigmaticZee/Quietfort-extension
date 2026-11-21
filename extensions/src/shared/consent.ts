// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Cookie-banner handling helpers shared by the background and the unit tests:
// trimming DuckDuckGo autoconsent's compact rule bundle to what one frame
// needs (same semantics as autoconsent's own frame filtering, and as the Mac
// proxy's consent.rs), and the consent-platform marker list
// (extensions/page-runtime/assets/consent-markers.txt).
//
// The rule bundle itself (@duckduckgo/autoconsent rules/compact-rules.json,
// MPL-2.0) is shipped unmodified next to the extension code and only read here.

/** One compact rule: [minStepVersion, name, cosmetic, urlPattern, runContext, prehide, detectCmp, detectPopup, optOut, test, extra]. */
export type CompactRule = [number, string, number, string, number, number[], Step[], Step[], Step[], Step[], Record<string, unknown>];

export interface Step {
  [k: string]: unknown;
}

export interface CompactRuleset {
  v: number;
  s: string[];
  r: CompactRule[];
}

export interface IndexedRuleset extends CompactRuleset {
  index: {
    genericRuleRange: [number, number];
    frameRuleRange: [number, number];
    specificRuleRange: [number, number];
    genericStringEnd: number;
    frameStringEnd: number;
  };
}

const STRING_KEYS = ['e', 'v', 'c', 'k', 'w', 'wv', 'h', 'cc'];

const compiled = new Map<string, RegExp | null>();

function urlMatches(pattern: string, url: string): boolean {
  if (!pattern) return true;
  let re = compiled.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    compiled.set(pattern, re);
  }
  return re ? re.test(url) : true; // null: autoconsent re-checks in the page
}

function shouldRun(rule: CompactRule, mainFrame: boolean, url: string): boolean {
  const ctx = rule[4];
  if (mainFrame && ctx === 1) return false;
  if (!mainFrame && (ctx === 10 || ctx === 12 || ctx === 20 || ctx === 22)) return false;
  return urlMatches(rule[3], url);
}

function withUsedStrings(all: string[], rules: CompactRule[], limit: number, v: number): CompactRuleset {
  const used = new Set<number>();
  const visit = (step: Step | undefined): void => {
    if (!step || typeof step !== 'object') return;
    for (const k of STRING_KEYS) if (typeof step[k] === 'number') used.add(step[k] as number);
    if (step.if) visit(step.if as Step);
    for (const k of ['then', 'else', 'any']) if (Array.isArray(step[k])) (step[k] as Step[]).forEach(visit);
  };
  for (const r of rules) {
    for (const slot of [6, 7, 8, 9] as const) (r[slot] as Step[]).forEach(visit);
    r[5].forEach((i) => used.add(i));
  }
  const end = Math.min(used.size ? Math.max(...used) + 1 : 0, limit, all.length);
  const s = new Array<string>(end);
  for (let i = 0; i < end; i++) s[i] = used.has(i) ? all[i]! : '';
  return { v, s, r: rules };
}

/** The part of the rule bundle that can apply to a frame at `url`. */
export function rulesFor(set: IndexedRuleset, url: string, mainFrame: boolean): CompactRuleset {
  const { v, s, r, index } = set;
  if (!mainFrame) {
    const picked = r.slice(index.frameRuleRange[0], index.frameRuleRange[1]).filter((x) => shouldRun(x, false, url));
    return withUsedStrings(s, picked, index.frameStringEnd, v);
  }
  const generic = r.slice(index.genericRuleRange[0], index.genericRuleRange[1]);
  const specific = r.slice(index.specificRuleRange[0], index.specificRuleRange[1]).filter((x) => shouldRun(x, true, url));
  if (!specific.length) return { v, s: s.slice(0, index.genericStringEnd), r: generic };
  return withUsedStrings(s, [...generic, ...specific], s.length, v);
}

/** Does an iframe at `url` have a frame rule written for its site? */
export function hasSiteFrameRule(set: IndexedRuleset, url: string): boolean {
  const { r, index } = set;
  return r.slice(index.frameRuleRange[0], index.frameRuleRange[1]).some((x) => !!x[3] && shouldRun(x, false, url));
}

/**
 * Sourcepoint's message iframe, which autoconsent's code rule
 * "Sourcepoint-frame" (the only built-in rule that acts inside iframes)
 * recognises by URL. Sites often serve it from their own subdomain
 * (e.g. sp-<site>.<site>), so the marker list alone would miss it.
 */
export function isSourcepointFrameUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname === 'ccpa-notice.sp-prod.net' || u.hostname === 'ccpa-pm.sp-prod.net') return true;
  return ['/index.html', '/privacy-manager/index.html', '/ccpa_pm/index.html', '/us_pm/index.html'].includes(u.pathname)
    && (u.searchParams.has('message_id') || u.searchParams.has('requestUUID') || u.searchParams.has('consentUUID'));
}

/** Parse consent-markers.txt into one case-insensitive matcher. */
export function markerMatcher(text: string): RegExp {
  const alts = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(alts.join('|'), 'i');
}
