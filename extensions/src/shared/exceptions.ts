// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Narrow, expiring site exceptions produced by "Fix this site".
//
// Every exception names exactly one site and one culprit rule:
//   network    @@||host^$domain=site            (host-only rules, non-ad hosts)
//              @@||host/path$domain=site        (host-only rules on known ad networks:
//                                                never the whole ad network)
//              @@<exact rule pattern>$<rule types>,domain=site   (pattern rules)
//   cosmetic   site#@#selector
//   scriptlet  site#@#+js(name, args...)        (the exact call, so other
//                                                scriptlets on the site keep running)
//
// The lines are applied as an overlay on the engine (Firefox webRequest,
// cosmetics, scriptlets) and compiled to a reserved block of dynamic DNR rules
// (Chrome / Safari) — see compileOverlayDnr.

import { looksLikeOptions, parseLine } from './parse.ts';
import { overlayLineProblem } from './engine.ts';
import { compileNetworkRule, PRIORITY } from './dnr.ts';
import type { DnrRule, Platform } from './dnr.ts';
import { hostOf } from './domain.ts';
import type { NetworkRule, Scriptlet } from './types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TTL_MS = 7 * DAY_MS;

export type ExceptionKind = 'network' | 'cosmetic' | 'scriptlet';

export interface SiteException {
  id: string;
  kind: ExceptionKind;
  /** Site the exception is scoped to (host without `www.`). */
  site: string;
  /** The filter rule that broke the site (provenance; what the user sees). */
  rule: string;
  /** Exception filter lines that neutralise `rule` on `site` only. */
  lines: string[];
  createdAt: number;
  /** null = made permanent by the user. */
  expiresAt: number | null;
  /** Why it was created (signals, answers). */
  reason: string;
  source: 'fix-this-site';
}

// ---------- line builders ----------

/** Escape one `+js()` argument (commas are the separator). */
function jsArg(a: string): string {
  return a.replace(/,/g, '\\,');
}

export function scriptletExceptionLine(site: string, s: Scriptlet): string {
  return `${site}#@#+js(${[s.name, ...s.args].map(jsArg).join(', ')})`;
}

export function cosmeticExceptionLine(site: string, selector: string): string {
  return `${site}#@#${selector}`;
}

/** Options of a block rule that are safe and meaningful to carry over to its exception. */
const KEEP_OPTIONS = new Set([
  'script', 'stylesheet', 'css', 'image', 'font', 'media', 'xmlhttprequest', 'xhr', 'websocket', 'ping', 'beacon',
  'object', 'object-subrequest', 'other', 'subdocument', 'frame',
  'third-party', '3p', 'first-party', '1p', 'match-case',
]);

function splitRaw(raw: string): [string, string[]] {
  const dollar = raw.lastIndexOf('$');
  if (dollar >= 0 && looksLikeOptions(raw.slice(dollar + 1))) return [raw.slice(0, dollar), raw.slice(dollar + 1).split(',')];
  return [raw, []];
}

function keptOptions(opts: string[]): string[] {
  return opts.filter((o) => KEEP_OPTIONS.has(o.replace(/^~/, '').toLowerCase()));
}

/** `||host/path` prefix for one URL, or null when the path can't be written as a filter. */
function urlPrefix(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname;
  if (!/^[\x21-\x7e]*$/.test(path) || /[*^|$]/.test(path)) return null;
  return `||${u.hostname}${path}`;
}

export interface NetworkExceptionInput {
  rule: NetworkRule;
  /** URLs this rule blocked on the page. */
  urls: string[];
  site: string;
  /** The blocked host belongs to a known ad network: never except the whole host. */
  adNetwork: boolean;
}

/** Exception lines for a network block rule; empty when no narrow exception can be written. */
export function networkExceptionLines({ rule, urls, site, adNetwork }: NetworkExceptionInput): string[] {
  if (rule.exception) return [];
  const [pattern, opts] = splitRaw(rule.raw);
  const kept = keptOptions(opts);
  const tail = (extra: string[] = []) => `$${[...kept, ...extra, ...(rule.important ? ['important'] : []), `domain=${site}`].join(',')}`;
  const out = new Set<string>();
  if (rule.pureHost && !rule.matchCase) {
    if (adNetwork) {
      // Only the exact resources the page needed, never the network.
      for (const url of urls.slice(0, 8)) {
        const p = urlPrefix(url);
        if (p && p.length > 3 + hostOf(url).length) out.add(`@@${p}${tail()}`);
      }
    } else {
      const hosts = new Set(urls.map((u) => hostOf(u)).filter(Boolean));
      if (!hosts.size) hosts.add(rule.pureHost);
      for (const h of hosts) out.add(`@@||${h}^${tail()}`);
    }
  } else {
    if (!pattern || pattern === '*') return [];
    out.add(`@@${pattern}${tail()}`);
  }
  return [...out].filter((l) => overlayLineProblem(l) === null);
}

// ---------- expiry ----------

export function isActive(e: SiteException, now: number): boolean {
  return e.expiresAt === null || e.expiresAt > now;
}

export function pruneExpired(list: SiteException[], now: number): { kept: SiteException[]; expired: SiteException[] } {
  const kept: SiteException[] = [];
  const expired: SiteException[] = [];
  for (const e of list) (isActive(e, now) ? kept : expired).push(e);
  return { kept, expired };
}

/** Overlay lines of the active exceptions (deduplicated, stable order). */
export function activeLines(list: SiteException[], now: number): string[] {
  const out = new Set<string>();
  for (const e of list) if (isActive(e, now)) e.lines.forEach((l) => out.add(l));
  return [...out];
}

export function makePermanent(list: SiteException[], id: string): SiteException[] {
  return list.map((e) => (e.id === id ? { ...e, expiresAt: null } : e));
}

export function removeException(list: SiteException[], id: string): SiteException[] {
  return list.filter((e) => e.id !== id);
}

export function newException(p: Omit<SiteException, 'id' | 'createdAt' | 'expiresAt' | 'source'>, now: number, ttlMs = DEFAULT_TTL_MS): SiteException {
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ...p,
    createdAt: now,
    expiresAt: now + ttlMs,
    source: 'fix-this-site',
  };
}

/** Next instant at which an active exception expires (for scheduling), or null. */
export function nextExpiry(list: SiteException[], now: number): number | null {
  let min: number | null = null;
  for (const e of list) if (e.expiresAt !== null && e.expiresAt > now && (min === null || e.expiresAt < min)) min = e.expiresAt;
  return min;
}

// ---------- DNR ----------

/** Dynamic rule ids reserved for overlay rules: [OVERLAY_FIRST_ID, OVERLAY_FIRST_ID + OVERLAY_SLOTS). */
export const OVERLAY_FIRST_ID = 2;
export const OVERLAY_SLOTS = 1000;

export function isOverlayId(id: number): boolean {
  return id >= OVERLAY_FIRST_ID && id < OVERLAY_FIRST_ID + OVERLAY_SLOTS;
}

export interface OverlayDnr {
  rules: DnrRule[];
  dropped: Array<{ line: string; reason: string }>;
}

/**
 * Network overlay lines → DNR `allow` rules. Exceptions that cancel an
 * `$important` block get a priority above PRIORITY.IMPORTANT (and its redirect
 * variant); the user's per-site switch (allowAllRequests at PRIORITY.ALLOWLIST)
 * stays on top. Non-network lines are ignored (handled by the content side).
 */
export function compileOverlayDnr(lines: string[], platform: Platform = 'chrome'): OverlayDnr {
  const rules: DnrRule[] = [];
  const dropped: Array<{ line: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const p = parseLine(line);
    if (p.kind !== 'network') continue;
    const problem = overlayLineProblem(line);
    if (problem) {
      dropped.push({ line, reason: problem });
      continue;
    }
    const c = compileNetworkRule(p.rule, platform);
    if (!c.ok) {
      dropped.push({ line, reason: c.reason });
      continue;
    }
    for (const r of c.rules) {
      const rule = { ...r, priority: p.rule.important ? PRIORITY.IMPORTANT + 100 : PRIORITY.EXCEPTION };
      const key = JSON.stringify(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      if (rules.length >= OVERLAY_SLOTS) {
        dropped.push({ line, reason: 'overlay-full' });
        continue;
      }
      rules.push({ id: OVERLAY_FIRST_ID + rules.length, ...rule });
    }
  }
  return { rules, dropped };
}
