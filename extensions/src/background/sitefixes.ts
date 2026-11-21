// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Storage of Fix-this-site exceptions and picker rules, and the overlay that
// makes exceptions (plus the rules a running fix is currently testing without)
// take effect: engine overlay for Firefox webRequest / cosmetics / scriptlets,
// reserved dynamic DNR rules for Chrome and Safari.

import { B, PLATFORM, log } from './api.ts';
import { loadClock, now } from './clock.ts';
import { getEngine, invalidateEngine, overlayChanged, setOverlaySource } from './state.ts';
import { activeLines, compileOverlayDnr, isOverlayId, makePermanent, nextExpiry, pruneExpired, removeException } from '../shared/exceptions.ts';
import type { SiteException } from '../shared/exceptions.ts';
import type { PickerRule } from '../shared/selectors.ts';

const USES_DNR = PLATFORM !== 'firefox';

// ---------- exceptions ----------

export async function getExceptions(): Promise<SiteException[]> {
  const { siteExceptions } = (await B.storage.local.get('siteExceptions')) as { siteExceptions?: SiteException[] };
  return siteExceptions ?? [];
}

async function setExceptions(list: SiteException[]): Promise<void> {
  await B.storage.local.set({ siteExceptions: list });
}

/** Lines a running fix is testing without (set by fixsite.ts). */
let trialLines: string[] = [];
let trialLoaded: Promise<void> | null = null;

function loadTrial(): Promise<void> {
  trialLoaded ??= B.storage.session.get('fixTrial').then((s) => {
    trialLines = Array.isArray(s.fixTrial) ? (s.fixTrial as string[]) : [];
  }, () => undefined);
  return trialLoaded;
}

export async function overlayLines(): Promise<string[]> {
  await Promise.all([loadClock(), loadTrial()]);
  const lines = new Set(activeLines(await getExceptions(), now()));
  trialLines.forEach((l) => lines.add(l));
  return [...lines];
}

setOverlaySource(overlayLines);

let chain: Promise<unknown> = Promise.resolve();

/** Recompute the overlay and push it to the engine and DNR. Serialised. */
export function refreshOverlay(): Promise<void> {
  const run = chain.then(async () => {
    const lines = await overlayLines();
    const engine = await getEngine();
    const res = engine?.setOverlay(lines);
    if (res?.rejected.length) log('overlay lines refused', res.rejected);
    await overlayChanged();
    if (USES_DNR) await applyOverlayDnr(lines);
  });
  chain = run.catch((err) => log('overlay refresh failed', String(err)));
  return run;
}

export async function applyOverlayDnr(lines: string[]): Promise<number> {
  const { rules, dropped } = compileOverlayDnr(lines, PLATFORM === 'safari' ? 'safari' : 'chrome');
  if (dropped.length) log('overlay DNR dropped', dropped);
  const existing = (await B.declarativeNetRequest.getDynamicRules()).filter((r) => isOverlayId(r.id)).map((r) => r.id);
  await B.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing, addRules: rules as chrome.declarativeNetRequest.Rule[] });
  return rules.length;
}

/** Overlay DNR rules for a full rule install (dnr-apply.ts). */
export async function overlayDnrRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
  return compileOverlayDnr(await overlayLines(), PLATFORM === 'safari' ? 'safari' : 'chrome').rules as chrome.declarativeNetRequest.Rule[];
}

export async function setTrialLines(lines: string[]): Promise<void> {
  await loadTrial();
  trialLines = [...lines];
  await B.storage.session.set({ fixTrial: trialLines });
  await refreshOverlay();
}

export async function addExceptions(items: SiteException[]): Promise<void> {
  await setExceptions([...(await getExceptions()), ...items]);
  await refreshOverlay();
  await scheduleExpiry();
}

export async function undoException(id: string): Promise<boolean> {
  const list = await getExceptions();
  const next = removeException(list, id);
  await setExceptions(next);
  await refreshOverlay();
  await scheduleExpiry();
  return next.length !== list.length;
}

export async function makeExceptionPermanent(id: string): Promise<void> {
  await setExceptions(makePermanent(await getExceptions(), id));
  await scheduleExpiry();
}

/** Drop expired exceptions; returns how many were removed. */
export async function pruneExceptions(): Promise<number> {
  await loadClock();
  const { kept, expired } = pruneExpired(await getExceptions(), now());
  if (expired.length) {
    await setExceptions(kept);
    log('expired site exceptions', expired.map((e) => `${e.site}: ${e.rule}`));
  }
  await refreshOverlay();
  await scheduleExpiry();
  return expired.length;
}

export const EXPIRY_ALARM = 'site-exception-expiry';

async function scheduleExpiry(): Promise<void> {
  await loadClock();
  const t = now();
  const next = nextExpiry(await getExceptions(), t);
  await B.alarms.clear(EXPIRY_ALARM);
  // Alarms run on the real clock; the test clock offset only shifts "now".
  if (next !== null) B.alarms.create(EXPIRY_ALARM, { when: Date.now() + Math.max(60_000, next - t + 1000), periodInMinutes: 60 });
}

// ---------- picker rules ----------

export async function getPickerRules(): Promise<PickerRule[]> {
  const { pickerRules } = (await B.storage.local.get('pickerRules')) as { pickerRules?: PickerRule[] };
  return pickerRules ?? [];
}

export async function setPickerRules(list: PickerRule[]): Promise<void> {
  await B.storage.local.set({ pickerRules: list });
  invalidateEngine();
}
