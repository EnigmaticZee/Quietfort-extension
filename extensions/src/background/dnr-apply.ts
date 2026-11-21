// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Installs compiled rules into declarativeNetRequest (Chrome, Safari).

import { B, PLATFORM, log } from './api.ts';
import { ALLOWLIST_RULE_ID, allowlistRule, compileToDnr, compileNetworkRule } from '../shared/dnr.ts';
import type { DnrLimits, DnrRule } from '../shared/dnr.ts';
import type { Engine } from '../shared/engine.ts';
import { disabledSites } from './state.ts';
import { OVERLAY_FIRST_ID, OVERLAY_SLOTS } from '../shared/exceptions.ts';
import { overlayDnrRules } from './sitefixes.ts';
import { getSettings, networkRuleTier } from './state.ts';
import { chromeMajor, PRIVACY_FIRST_ID, PRIVACY_SLOTS, privacyDnrRules } from '../shared/privacy.ts';
import { CONTINUE_FIRST_ID, CONTINUE_SLOTS, SAFARI_CONTINUE_SLOTS, GUARD_FIRST_ID, GUARD_REGEX_RULES, GUARD_SLOTS, PROTECTION_FIRST_ID, PROTECTION_SLOTS, protectionDnrRules } from '../shared/protection.ts';
import { getProtectionSet, setDnrProtectedLists, warningPageUrl } from './protection.ts';

/** Dynamic ids below this are reserved: 1 = user allowlist, then the site-exception overlay. */
export const RESERVED_DYNAMIC = OVERLAY_FIRST_ID + OVERLAY_SLOTS - 1;

type Dnr = typeof chrome.declarativeNetRequest;

export interface DnrStatus {
  version: string;
  appliedAt: number;
  limits: DnrLimits;
  stats: ReturnType<typeof compileToDnr>['stats'];
  droppedByReason: Record<string, number>;
  notInDnr: Record<string, number>;
  notes: Record<string, number>;
  droppedSample: Array<{ raw: string; reason: string }>;
  /** Rules not installed because the browser's own rule cap was reached (lowest priority first). */
  cappedByBrowser?: number;
  /** Rules the browser rejected at install time (validated one by one). */
  rejected: Array<{ id: number; error: string }>;
  installedDynamic: number;
  /** Dynamic rules compiled from the filter lists (without allowlist and overlay rules). */
  installedMain: number;
  installedSession: number;
  allowlistInstalled: boolean;
  /**
   * Malware/phishing/scam protection in DNR: hosts per list, DNR rules, and the
   * lists fully installed (the rest is covered by the hashed set + navigation guard).
   */
  protection?: { hosts: Record<string, number>; dropped: Record<string, number>; rules: number; regexRules: number; lists: string[] };
  /** Privacy header rules installed (GPC, Referrer-Policy, X-Client-Data). */
  privacyRules?: number;
  ms: number;
}

/** Dynamic ids of the main (filter-list) rules: above the reserved block, below the privacy/protection blocks. */
export function isMainRuleId(id: number): boolean {
  return id > RESERVED_DYNAMIC && id < PRIVACY_FIRST_ID;
}

export async function currentPrivacyRules(): Promise<DnrRule[]> {
  const s = await getSettings();
  return privacyDnrRules(s.privacy, { platform: PLATFORM === 'safari' ? 'safari' : 'chrome', chromeVersion: chromeMajor(navigator.userAgent) });
}

/** Re-install only the privacy header rules (settings toggled). */
export async function applyPrivacy(): Promise<number> {
  const rules = await currentPrivacyRules();
  const removeRuleIds = Array.from({ length: PRIVACY_SLOTS }, (_, i) => PRIVACY_FIRST_ID + i);
  try {
    await dnr().updateDynamicRules({ removeRuleIds, addRules: rules as chrome.declarativeNetRequest.Rule[] });
  } catch (err) {
    log('privacy rules rejected', String(err));
    const ok: DnrRule[] = [];
    for (const r of rules) {
      try {
        await dnr().updateDynamicRules({ addRules: [r as chrome.declarativeNetRequest.Rule] });
        ok.push(r);
      } catch (e) {
        log('privacy rule rejected', r.id, String(e));
      }
    }
    return ok.length;
  }
  return rules.length;
}

function dnr(): Dnr {
  return B.declarativeNetRequest;
}

export function limits(): DnrLimits {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = dnr() as any;
  const combined = d.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES as number | undefined;
  const dynamic = (d.MAX_NUMBER_OF_DYNAMIC_RULES as number | undefined) ?? combined ?? 5000;
  const hasSession = typeof d.updateSessionRules === 'function';
  const session = hasSession ? ((d.MAX_NUMBER_OF_SESSION_RULES as number | undefined) ?? (combined ? 0 : 5000)) : 0;
  return {
    dynamic,
    dynamicUnsafe: (d.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES as number | undefined) ?? Math.min(dynamic, 5000),
    session,
    sessionUnsafe: (d.MAX_NUMBER_OF_UNSAFE_SESSION_RULES as number | undefined) ?? Math.min(session, 5000),
    regex: (d.MAX_NUMBER_OF_REGEX_RULES as number | undefined) ?? 1000,
  };
}

async function regexSupport(engine: Engine): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const check = (dnr() as any).isRegexSupported as ((o: { regex: string; isCaseSensitive?: boolean }) => Promise<{ isSupported: boolean }>) | undefined;
  if (typeof check !== 'function') return out;
  for (const r of engine.networkRules) {
    if (r.pattern.kind !== 'regex') continue;
    const c = compileNetworkRule(r, PLATFORM === 'safari' ? 'safari' : 'chrome');
    if (!c.ok) continue;
    for (const rule of c.rules) {
      const re = rule.condition.regexFilter!;
      const cs = !!rule.condition.isUrlFilterCaseSensitive;
      const key = `${cs ? 1 : 0}${re}`;
      if (out.has(key)) continue;
      try {
        out.set(key, (await check({ regex: re, isCaseSensitive: cs })).isSupported);
      } catch {
        out.set(key, false);
      }
    }
  }
  return out;
}

type Kind = 'dynamic' | 'session';

async function getRules(kind: Kind): Promise<chrome.declarativeNetRequest.Rule[]> {
  return kind === 'dynamic' ? dnr().getDynamicRules() : dnr().getSessionRules();
}

async function update(kind: Kind, opts: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void> {
  if (kind === 'dynamic') await dnr().updateDynamicRules(opts);
  else await dnr().updateSessionRules(opts);
}

/** The browser's own rule cap was hit (Safari enforces a lower cap than it reports). */
export function isRuleCapError(err: unknown): boolean {
  return /maximum number of .*rules exceeded/i.test(String(err));
}

/**
 * Add rules in order, isolating any the browser rejects by bisection. Once the
 * browser reports its rule cap, nothing after that point is tried again (the
 * rules are in install-priority order, so the most important ones are in).
 */
async function addBisect(kind: Kind, rules: DnrRule[], rejected: Array<{ id: number; error: string }>, capped = { hit: false, skipped: 0 }): Promise<typeof capped> {
  if (!rules.length) return capped;
  if (capped.hit) {
    capped.skipped += rules.length;
    return capped;
  }
  try {
    await update(kind, { addRules: rules as chrome.declarativeNetRequest.Rule[] });
  } catch (err) {
    if (rules.length === 1) {
      if (isRuleCapError(err)) {
        capped.hit = true;
        capped.skipped++;
      } else rejected.push({ id: rules[0]!.id, error: String(err) });
      return capped;
    }
    const mid = rules.length >> 1;
    await addBisect(kind, rules.slice(0, mid), rejected, capped);
    await addBisect(kind, rules.slice(mid), rejected, capped);
  }
  return capped;
}

/** "Continue anyway" and navigation-guard rules (session; dynamic on Safari) survive rule syncs. */
const keepSession = (id: number) => (id >= CONTINUE_FIRST_ID && id < CONTINUE_FIRST_ID + CONTINUE_SLOTS) || (id >= GUARD_FIRST_ID && id < GUARD_FIRST_ID + GUARD_SLOTS);

/** Rules per Safari update call (each call recompiles Safari's whole rule set). */
const SAFARI_BATCH = 2500;

/** Rules left out at the last sync because the browser's own cap was reached. */
const capSkipped: Record<Kind, number> = { dynamic: 0, session: 0 };

async function replaceAll(kind: Kind, rules: DnrRule[], rejected: Array<{ id: number; error: string }>): Promise<number> {
  if (kind === 'session' && typeof dnr().updateSessionRules !== 'function') return 0;
  // Continue / guard rules are session rules (Chrome) or dynamic rules (Safari): never replaced here.
  const removeRuleIds = (await getRules(kind)).map((r) => r.id).filter((id) => !keepSession(id));
  if (PLATFORM === 'safari') {
    // Safari recompiles its whole rule set on every update (seconds each), refuses some
    // rules, and has a lower real cap than it reports. Install in priority-ordered
    // batches; isolate refusals inside a batch only; stop at the cap.
    await update(kind, { removeRuleIds });
    const capped = { hit: false, skipped: 0 };
    let expected = 0;
    for (let i = 0; i < rules.length && !capped.hit; i += SAFARI_BATCH) {
      const batch = rules.slice(i, i + SAFARI_BATCH);
      const before = rejected.length;
      await addBisect(kind, batch, rejected, capped);
      expected += batch.length - (rejected.length - before) - capped.skipped;
      // Safari may also accept a batch and silently keep fewer rules: treat that as the cap.
      const have = (await getRules(kind)).filter((r) => !keepSession(r.id)).length;
      if (have < expected) {
        capped.hit = true;
        capped.skipped += Math.max(0, rules.length - i - batch.length);
        log(`${kind} rules: Safari silently kept ${have} of ${expected}`);
        break;
      }
    }
    if (capped.hit) {
      capSkipped[kind] = capped.skipped;
      log(`${kind} rules: browser rule cap reached, ${capped.skipped} lower-priority rules not installed`);
    }
    return (await getRules(kind)).filter((r) => !keepSession(r.id)).length;
  }
  try {
    await update(kind, { removeRuleIds, addRules: rules as chrome.declarativeNetRequest.Rule[] });
  } catch (err) {
    log(`${kind} rules: bulk update failed (${String(err)}), validating individually`);
    await update(kind, { removeRuleIds });
    const capped = await addBisect(kind, rules, rejected);
    if (capped.hit) {
      capSkipped[kind] = capped.skipped;
      log(`${kind} rules: browser rule cap reached, ${capped.skipped} lower-priority rules not installed`);
    }
  }
  return (await getRules(kind)).filter((r) => !keepSession(r.id)).length;
}

/**
 * Safari 27 reports 30,000 dynamic rules but refuses more than ~15,000. When a
 * sync hits the real cap, the number that fitted is remembered for this browser
 * version and used as the limit from then on (a browser update re-measures).
 */
const LEARNED_CAP_KEY = 'dnrLearnedCap';
/**
 * No browser caps dynamic rules this low (the DNR minimum is 5,000; Safari's real
 * cap is ~15,000). A smaller count means something else changed the rules during
 * the measurement, so it is never learned, and an already stored one is ignored.
 */
export const MIN_LEARNED_CAP = 5000;

async function learnedDynamicCap(): Promise<number | null> {
  const { [LEARNED_CAP_KEY]: v } = (await B.storage.local.get(LEARNED_CAP_KEY)) as { [LEARNED_CAP_KEY]?: { ua: string; dynamic: number } };
  return v && v.ua === navigator.userAgent && v.dynamic >= MIN_LEARNED_CAP ? v.dynamic : null;
}

export async function effectiveLimits(): Promise<DnrLimits> {
  const lim = limits();
  const cap = await learnedDynamicCap();
  return cap ? { ...lim, dynamic: Math.min(lim.dynamic, cap), dynamicUnsafe: Math.min(lim.dynamicUnsafe, cap) } : lim;
}

export async function applyDnr(engine: Engine, version: string, retry = true): Promise<DnrStatus> {
  const t0 = Date.now();
  const lim = await effectiveLimits();
  const support = await regexSupport(engine);
  const platform = PLATFORM === 'safari' ? 'safari' : 'chrome';
  // Privacy and protection rules first; the filter lists get what is left.
  const privacy = await currentPrivacyRules();
  let protSet: Awaited<ReturnType<typeof getProtectionSet>> | null = null;
  try {
    protSet = await getProtectionSet();
  } catch (err) {
    log('protection set failed', String(err));
  }
  const prot = protSet ? protectionDnrRules(protSet, warningPageUrl(), platform) : { rules: [], regexRules: 0, unsafeRules: 0 };
  if (prot.rules.length && prot.rules[prot.rules.length - 1]!.id >= PROTECTION_FIRST_ID + PROTECTION_SLOTS) throw new Error('protection rule ids overflow');
  const extra = [...privacy, ...prot.rules];
  const extraUnsafe = privacy.length + prot.unsafeRules;
  // The navigation guard may add up to GUARD_SLOTS session rules (half of them regex redirects).
  const guard = lim.session > 0;
  const mainLimits: DnrLimits = {
    ...lim,
    // Safari keeps continue / guard rules among the dynamic rules.
    dynamic: Math.max(0, lim.dynamic - extra.length - (platform === 'safari' ? SAFARI_CONTINUE_SLOTS + GUARD_SLOTS : 0)),
    dynamicUnsafe: Math.max(0, lim.dynamicUnsafe - extraUnsafe),
    session: Math.max(0, lim.session - (guard ? GUARD_SLOTS : 0)),
    sessionUnsafe: Math.max(0, lim.sessionUnsafe - (guard ? GUARD_REGEX_RULES : 0)),
    regex: Math.max(0, lim.regex - prot.regexRules - (guard ? GUARD_REGEX_RULES : 0)),
  };
  const result = compileToDnr(engine.networkRules, {
    limits: mainLimits,
    platform: PLATFORM === 'safari' ? 'safari' : 'chrome',
    reservedDynamic: RESERVED_DYNAMIC,
    isRegexSupported: (re, cs) => support.get(`${cs ? 1 : 0}${re}`) ?? true,
    tierOf: networkRuleTier(engine),
  });
  const allow = allowlistRule(await disabledSites());
  const rejected: Array<{ id: number; error: string }> = [];
  capSkipped.dynamic = 0;
  capSkipped.session = 0;
  const overlay = await overlayDnrRules();
  const installedDynamic = await replaceAll('dynamic', [...(allow ? [allow] : []), ...(overlay as DnrRule[]), ...extra, ...result.dynamic], rejected);
  const rejectedDynamic = rejected.length;
  // Safari can also accept an update and silently keep fewer rules than it was given.
  const attempted = (allow ? 1 : 0) + overlay.length + extra.length + result.dynamic.length;
  const silentlyMissing = Math.max(0, attempted - installedDynamic - capSkipped.dynamic - rejectedDynamic);
  if (capSkipped.dynamic || silentlyMissing) {
    // Remember the real cap (all dynamic rules, the kept continue/guard rules included).
    const total = (await getRules('dynamic')).length;
    if (total >= MIN_LEARNED_CAP) {
      await B.storage.local.set({ [LEARNED_CAP_KEY]: { ua: navigator.userAgent, dynamic: total } });
    } else {
      // Not a browser cap: the rules changed under us. Install once more; learn nothing.
      log(`dynamic rules: ${total} installed of ${attempted}; too few to be a browser cap, not learning it`);
      if (retry) return applyDnr(engine, version, false);
    }
    if (silentlyMissing && retry) {
      // Which rules the browser kept is unknown: compile again to the measured cap so the
      // install order (primary lists first) decides what is left out.
      log(`dynamic rules: browser kept ${installedDynamic} of ${attempted}; recompiling to its real cap (${total})`);
      return applyDnr(engine, version, false);
    }
  }
  const installedMain = (await getRules('dynamic')).filter((r) => isMainRuleId(r.id)).length;
  const installedSession = await replaceAll('session', result.session, rejected);
  // A list counts as DNR-protected only if all of its rules went in (else the guard covers it).
  const protRejected = rejected.some((r) => r.id >= PROTECTION_FIRST_ID && r.id < PROTECTION_FIRST_ID + PROTECTION_SLOTS);
  const protLists = protSet && !protRejected && !Object.keys(protSet.dropped).length ? protSet.byList.map((l) => l.id) : [];
  setDnrProtectedLists(protLists);
  const status: DnrStatus = {
    version,
    appliedAt: Date.now(),
    limits: lim,
    stats: result.stats,
    droppedByReason: result.droppedByReason,
    notInDnr: result.notInDnr,
    notes: result.notes,
    droppedSample: result.dropped.slice(0, 50),
    rejected: rejected.slice(0, 50),
    cappedByBrowser: capSkipped.dynamic + capSkipped.session,
    installedDynamic,
    installedMain,
    installedSession,
    allowlistInstalled: !!allow,
    protection: protSet ? { hosts: protSet.counts, dropped: protSet.dropped, rules: prot.rules.length, regexRules: prot.regexRules, lists: protLists } : undefined,
    privacyRules: privacy.length,
    ms: Date.now() - t0,
  };
  await B.storage.local.set({ dnrStatus: status });
  if (rejected.some((r) => r.id >= PRIVACY_FIRST_ID)) log('privacy/protection rules rejected', rejected.filter((r) => r.id >= PRIVACY_FIRST_ID));
  log(`DNR: ${installedDynamic} dynamic + ${installedSession} session rules in ${status.ms} ms; dropped`, result.droppedByReason);
  return status;
}

export async function applyAllowlist(): Promise<void> {
  const allow = allowlistRule(await disabledSites());
  await dnr().updateDynamicRules({ removeRuleIds: [ALLOWLIST_RULE_ID], addRules: allow ? [allow as chrome.declarativeNetRequest.Rule] : [] });
}
