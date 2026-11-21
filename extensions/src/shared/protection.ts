// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Malware / phishing / scam protection from hosts-format lists (Block List
// Project). Top-level navigations to a listed host go to the extension's
// warning page (blocked.html); every other request to a listed host is blocked.
//
// Every protection list is compiled to a hashed host set (hostset.ts) kept in
// IndexedDB — no host limit (the full malware list has ~2.7 million hosts).
//
//   Firefox: the blocking webRequest listener checks the hashed set before any
//            request leaves the browser (warning page / cancel).
//   Chrome, Safari: lists small enough for declarativeNetRequest (up to
//            MAX_PROTECTION_HOSTS hosts in all, whole lists only) also become
//            DNR rules, so those hosts are never contacted:
//              redirect main_frame → blocked.html?list=<id>#<original URL>
//                                    (regexSubstitution; one regex rule per chunk)
//              block    everything else
//            The rest (the full malware list) is checked by the navigation
//            guard (webNavigation.onBeforeNavigate → warning page, plus a
//            session DNR rule for that host). Without blocking webRequest the
//            guard cannot hold the first request: the site may receive it,
//            but the page is replaced by the warning page.

import { toAsciiHost } from './domain.ts';
import { KEEP_LOCALHOST_HOSTS } from './test-hosts.ts';
import type { DnrRule, ResourceTypeName } from './dnr.ts';

/** DNR priority: above list exceptions (2000) and $important (3000), below "continue anyway" and the user allowlist. */
export const PROTECTION_PRIORITY = 5000;
export const CONTINUE_PRIORITY = 9000;

/** Dynamic rule ids for protection rules: [PROTECTION_FIRST_ID, PROTECTION_FIRST_ID + PROTECTION_SLOTS). */
export const PROTECTION_FIRST_ID = 4_000_100;
export const PROTECTION_SLOTS = 2000;
/** Session rule ids for "continue anyway" allow rules. */
export const CONTINUE_FIRST_ID = 4_100_000;
export const CONTINUE_SLOTS = 1000;
/**
 * On Safari these rules live among the dynamic rules, which share Safari's real
 * cap (~15,000) with the filter lists: only this many are reserved there (the
 * oldest "continue" is replaced when they are full).
 */
export const SAFARI_CONTINUE_SLOTS = 50;

/** Session rule ids for navigation-guard rules (hosts from lists not in DNR). Two rules per host. */
export const GUARD_FIRST_ID = 4_101_000;
export const GUARD_SLOTS = 100;
/** Regex rules the guard may use (one per host), reserved from the filter lists' regex budget. */
export const GUARD_REGEX_RULES = GUARD_SLOTS / 2;

/** Hosts per DNR rule. */
export const PROTECTION_CHUNK = 10_000;
/** At most this many hosts go into DNR rules (whole lists; the rest is covered by the hashed set). */
export const MAX_PROTECTION_HOSTS = 800_000;
/** Lists larger than this (bytes) are kept only as a hashed set, never as text / DNR rules. */
export const PROTECTION_TEXT_MAX = 16_000_000;

/**
 * Which protection lists become DNR rules: in priority order, whole lists
 * whose text is kept, while the total stays within `max` hosts.
 */
export function chooseDnrLists(lists: Array<{ id: string; hosts: number; text: boolean }>, max = MAX_PROTECTION_HOSTS): string[] {
  const out: string[] = [];
  let total = 0;
  for (const l of lists) {
    if (!l.text || !l.hosts || total + l.hosts > max) continue;
    out.push(l.id);
    total += l.hosts;
  }
  return out;
}

const ALL_BUT_MAIN: ResourceTypeName[] = ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
export const ALL_TYPES: ResourceTypeName[] = ['main_frame', ...ALL_BUT_MAIN];
const SAFARI_UNSUPPORTED = new Set<ResourceTypeName>(['object', 'csp_report', 'webtransport', 'webbundle']);

const HOST_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$/;

/**
 * Hosts in a hosts-format (`0.0.0.0 host`), plain-domain or `||host^` list.
 * Comments, localhost entries, IP addresses and malformed names are skipped.
 */
export function parseHostsList(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const n = text.length;
  while (start < n) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    let line = text.slice(start, end).trim();
    start = end + 1;
    if (!line || line[0] === '#' || line[0] === '!' || line[0] === '[') continue;
    const hash = line.indexOf('#');
    if (hash > 0) line = line.slice(0, hash).trim();
    let host: string;
    const m = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+(\S+)/.exec(line);
    if (m) host = m[1]!;
    else if (line.startsWith('||') && line.endsWith('^')) host = line.slice(2, -1);
    else if (!/\s/.test(line)) host = line;
    else continue;
    host = host.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host === '0.0.0.0' || (host.endsWith('.localhost') && !KEEP_LOCALHOST_HOSTS) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
    if (!HOST_RE.test(host)) {
      const a = toAsciiHost(host);
      if (!a || !HOST_RE.test(a)) continue;
      host = a;
    }
    out.push(host);
  }
  return out;
}

export interface ProtectionInput {
  id: string;
  hosts: string[];
}

export interface ProtectionSet {
  /** host → list id (first list wins); parents cover subdomains. */
  byList: Array<{ id: string; hosts: string[] }>;
  counts: Record<string, number>;
  dropped: Record<string, number>;
  total: number;
}

/** Deduplicate across lists, drop hosts covered by a listed parent, cap the total. */
export function buildProtectionSet(lists: ProtectionInput[], max = MAX_PROTECTION_HOSTS): ProtectionSet {
  const all = new Set<string>();
  for (const l of lists) for (const h of l.hosts) all.add(h);
  const covered = (h: string) => {
    let i = h.indexOf('.');
    while (i >= 0) {
      const p = h.slice(i + 1);
      if (p.includes('.') && all.has(p)) return true;
      i = h.indexOf('.', i + 1);
    }
    return false;
  };
  const seen = new Set<string>();
  const byList: ProtectionSet['byList'] = [];
  const counts: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  let total = 0;
  for (const l of lists) {
    const hosts: string[] = [];
    let drop = 0;
    for (const h of l.hosts) {
      if (seen.has(h) || covered(h)) continue;
      seen.add(h);
      if (total >= max) {
        drop++;
        continue;
      }
      hosts.push(h);
      total++;
    }
    hosts.sort();
    byList.push({ id: l.id, hosts });
    counts[l.id] = hosts.length;
    if (drop) dropped[l.id] = drop;
  }
  return { byList, counts, dropped, total };
}

export interface ProtectionDnr {
  rules: DnrRule[];
  regexRules: number;
  unsafeRules: number;
}

/**
 * DNR rules for a protection set. `pageUrl` is the extension's warning page
 * (e.g. chrome-extension://<id>/blocked.html).
 */
export function protectionDnrRules(set: ProtectionSet, pageUrl: string, platform: 'chrome' | 'safari' = 'chrome', chunk = PROTECTION_CHUNK): ProtectionDnr {
  const rules: DnrRule[] = [];
  let id = PROTECTION_FIRST_ID;
  let regexRules = 0;
  const others = platform === 'safari' ? ALL_BUT_MAIN.filter((t) => !SAFARI_UNSUPPORTED.has(t)) : ALL_BUT_MAIN;
  for (const l of set.byList) {
    for (let i = 0; i < l.hosts.length; i += chunk) {
      if (id + 2 > PROTECTION_FIRST_ID + PROTECTION_SLOTS) break;
      const requestDomains = l.hosts.slice(i, i + chunk);
      if (platform === 'safari') {
        // Safari ignores requestDomains on a regexFilter redirect rule (the rule then
        // redirects every page) and its regexes have no alternation, so main frames are
        // blocked here and sent to the warning page by the navigation guard instead.
        rules.push({ id: id++, priority: PROTECTION_PRIORITY, action: { type: 'block' }, condition: { requestDomains, resourceTypes: ['main_frame', ...others] } });
        continue;
      }
      rules.push({
        id: id++,
        priority: PROTECTION_PRIORITY,
        action: { type: 'redirect', redirect: { regexSubstitution: `${pageUrl}?list=${encodeURIComponent(l.id)}#\\0` } },
        condition: { regexFilter: '^.+$', requestDomains, resourceTypes: ['main_frame'] },
      });
      regexRules++;
      rules.push({ id: id++, priority: PROTECTION_PRIORITY, action: { type: 'block' }, condition: { requestDomains, resourceTypes: others } });
    }
  }
  return { rules, regexRules, unsafeRules: regexRules };
}

/** Warning-page URL for a blocked navigation. */
export function warningUrl(pageUrl: string, list: string, url: string): string {
  return `${pageUrl}?list=${encodeURIComponent(list)}#${url}`;
}

/**
 * Navigation-guard session rules for a listed domain found by the hashed set:
 * the same redirect + block pair as the DNR lists, for one domain (and its subdomains).
 */
export function guardRules(id: number, domain: string, list: string, pageUrl: string, platform: 'chrome' | 'safari' = 'chrome'): DnrRule[] {
  const others = platform === 'safari' ? ALL_BUT_MAIN.filter((t) => !SAFARI_UNSUPPORTED.has(t)) : ALL_BUT_MAIN;
  // Safari: no regexFilter redirect (see protectionDnrRules); the guard itself shows the warning page.
  if (platform === 'safari') return [{ id, priority: PROTECTION_PRIORITY, action: { type: 'block' }, condition: { requestDomains: [domain], resourceTypes: ['main_frame', ...others] } }];
  return [
    {
      id,
      priority: PROTECTION_PRIORITY,
      action: { type: 'redirect', redirect: { regexSubstitution: `${pageUrl}?list=${encodeURIComponent(list)}#\\0` } },
      condition: { regexFilter: '^.+$', requestDomains: [domain], resourceTypes: ['main_frame'] },
    },
    { id: id + 1, priority: PROTECTION_PRIORITY, action: { type: 'block' }, condition: { requestDomains: [domain], resourceTypes: others } },
  ];
}

/** Session allow rule for "continue anyway (this site, this time)" in one tab. */
export function continueRule(id: number, host: string, tabId: number, platform: 'chrome' | 'safari' = 'chrome'): DnrRule {
  return {
    id,
    priority: CONTINUE_PRIORITY,
    action: { type: 'allow' },
    // Safari compiles DNR rules into content rule lists, which are not per tab: a rule with
    // tabIds never matches there. Its allow rule covers the host in every tab; the
    // navigation guard still sends other tabs' navigations to the warning page.
    condition: platform === 'safari'
      ? { requestDomains: [host], resourceTypes: ALL_TYPES.filter((t) => !SAFARI_UNSUPPORTED.has(t)) }
      : { requestDomains: [host], tabIds: [tabId], resourceTypes: ALL_TYPES },
  };
}

/** The original URL and list id from a warning-page URL (blocked.html?list=x#<url>). */
export function parseBlockedPageUrl(href: string): { list: string | null; url: string | null } {
  const hash = href.indexOf('#');
  const q = href.indexOf('?');
  let list: string | null = null;
  if (q >= 0) {
    const qs = href.slice(q + 1, hash >= 0 ? hash : undefined);
    list = new URLSearchParams(qs).get('list');
  }
  let url: string | null = hash >= 0 ? href.slice(hash + 1) : null;
  if (url && !/^https?:\/\//i.test(url)) {
    try {
      url = decodeURIComponent(url);
    } catch {
      /* keep */
    }
  }
  if (url && !/^https?:\/\//i.test(url)) url = null;
  return { list, url };
}
