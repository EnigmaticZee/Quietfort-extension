// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Background entry point (Chrome service worker, Firefox event page, Safari).
// All listeners are registered synchronously at top level so the browser can
// wake us for them.

import { B, E2E, PLATFORM, log, recentLog } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import {
  disabledSites, getEngine, getSettings, invalidateEngine, isDisabledIn, refreshLists, siteKey, sources, updateSettings,
} from './state.ts';
import type { ListSource, ListStatus, StoredList } from './state.ts';
import { applyAllowlist, applyDnr, applyPrivacy, isMainRuleId, MIN_LEARNED_CAP } from './dnr-apply.ts';
import { contentBlockerStatus, ensureContentBlockers, pushContentBlockersQueued, scheduleContentBlockers } from './safari-cb.ts';
import type { DnrStatus } from './dnr-apply.ts';
import { onLinkOpen, registerPopupBlocker, recentlyBlocked } from './popup-blocker.ts';
import { registerNavigationRules } from './navigation.ts';
import { addBlocked, getCount, removeTab, resetTab } from './counts.ts';
import { onContentInit, onContentScriptlets, onContentTokens, registerScriptletInjection, waitingFixes } from './cosmetics.ts';
import { GATED, fullProtectionOn, startFullProtection } from './fullprotection.ts';
import { registerFirefoxWebRequest } from './webrequest-firefox.ts';
import { keepBackgroundAlive } from './keepalive.ts';
import { consumeOwnReload, onTopCommit, recordBlocked, recordJsError, recordToggle, removeTabData, signalsFor } from './tabdata.ts';
import { answerFix, cancelFix, fixStatus, onTabRemoved, onTopCommitted, onTopCompleted, startFix } from './fixsite.ts';
import { EXPIRY_ALARM, getExceptions, getPickerRules, makeExceptionPermanent, pruneExceptions, undoException } from './sitefixes.ts';
import { removePicked, savePicked, startPicker, switchPicked } from './picker-bg.ts';
import { advanceClock, loadClock, now } from './clock.ts';
import { shouldSuggestFix } from '../shared/signals.ts';
import { consentStatus, onConsentMessage, registerConsent } from './consent.ts';
import { hostMatches } from '../shared/domain.ts';
import { Engine } from '../shared/engine.ts';
import { CONTINUE_FIRST_ID } from '../shared/protection.ts';
import { CATALOGUE, MAX_CUSTOM_LISTS, customListId, customListUrlProblem, isListEnabled, suggestedFor } from '../shared/catalogue.ts';
import type { CustomList } from '../shared/catalogue.ts';
import { allowContinue, clearTempProtectionRules, protDebug, getHostSet, getProtectionSet, guardHits, hostSetStats, registerNavigationGuard, registerProtectionCleanup, reloadHostSet } from './protection.ts';
import type { HostSetStats } from './protection.ts';
import {
  aiInit, aiReport, aiTabStatus, classifySponsored, clearAiCache, confirmScam, cookieClickFor, cookieLock, forgetCookiePlan, mayReportCookie, modelAvailability, modelDebug, warmModel,
  registerAi, resetAiTab, saveCookiePlan, saveSponsoredVerdicts, setModelStub,
} from './ai.ts';
import type { ModelStub } from './ai.ts';
import type { Clickable } from '../shared/clickplan.ts';
import { browserLangs } from './state.ts';
import type { AiSettings, Settings } from './state.ts';
import { PAUSE_FOREVER, isPausedAt, storedDisabledSites } from './state.ts';
import { describeHide, pickFromContext, pickerSelectorProblem, startZap } from './picker-bg.ts';
import { tabEvidence } from './tabdata.ts';
import { setPickerRules, addExceptions } from './sitefixes.ts';
import { BACKUP_FORMAT, BACKUP_VERSION, MAX_USER_RULES_BYTES, checkRules, readBackup } from '../shared/backup.ts';
import type { Backup } from '../shared/backup.ts';
import { parseLine } from '../shared/parse.ts';
import type { PickerRule } from '../shared/selectors.ts';
import type { SiteException } from '../shared/exceptions.ts';
import type { PrivacySettings } from '../shared/privacy.ts';

const USES_DNR = PLATFORM !== 'firefox';

// ---------- rules lifecycle ----------

async function rulesVersion(): Promise<string> {
  const settings = await getSettings();
  const srcs = await sources();
  const all = await B.storage.local.get(null);
  const lists = Object.keys(all)
    .filter((k) => k.startsWith('list:'))
    .sort()
    .map((k) => `${k}@${(all[k] as StoredList).fetchedAt}`);
  let h = 0;
  for (const ch of settings.userFilters) h = (h * 31 + ch.charCodeAt(0)) | 0;
  // Redirect rules carry absolute extension URLs (the warning page); Safari gives the
  // extension a new base URL (safari-web-extension://<random>/) per launch, so a changed
  // base URL must reinstall the rules.
  return JSON.stringify([lists, srcs.map((s) => s.url), h, B.runtime.getURL('')]);
}

let syncChain: Promise<unknown> = Promise.resolve();

/** Make the installed rules match the stored lists (DNR browsers). */
function syncRules(force = false): Promise<unknown> {
  const run = syncChain.then(async () => {
    if (!USES_DNR) return;
    // No filter lists yet: still install privacy and protection rules.
    const engine = (await getEngine()) ?? Engine.fromLists([]);
    const version = await rulesVersion();
    const { dnrStatus } = (await B.storage.local.get('dnrStatus')) as { dnrStatus?: DnrStatus };
    // Re-apply when the lists changed, or when the browser lost our rules
    // (session rules after a restart; dynamic rules after a reinstall).
    let missing = false;
    if (dnrStatus) {
      const dyn = (await B.declarativeNetRequest.getDynamicRules()).filter((r) => isMainRuleId(r.id)).length;
      const expectedDyn = dnrStatus.installedMain ?? dnrStatus.installedDynamic - (dnrStatus.allowlistInstalled ? 1 : 0);
      missing = dyn < expectedDyn;
      // Installed under an impossibly small learned cap (see MIN_LEARNED_CAP): most rules were left out.
      if ((dnrStatus.limits?.dynamic ?? Infinity) < MIN_LEARNED_CAP) missing = true;
      if (dnrStatus.installedSession > 0 && typeof B.declarativeNetRequest.getSessionRules === 'function') {
        missing ||= (await B.declarativeNetRequest.getSessionRules()).filter((r) => r.id < CONTINUE_FIRST_ID).length < dnrStatus.installedSession;
      }
    }
    if (!force && dnrStatus?.version === version && !missing) return;
    await applyDnr(engine, version);
    scheduleContentBlockers('lists changed');
  });
  syncChain = run.catch((err) => log('rule sync failed', err));
  return run;
}

async function refreshAndSync(force: boolean): Promise<void> {
  await refreshLists(force, () => void syncRules());
  await syncRules();
}

B.runtime.onInstalled.addListener(() => {
  void refreshAndSync(true);
  B.alarms.create('refresh-lists', { periodInMinutes: 60, delayInMinutes: 60 });
});

B.runtime.onStartup.addListener(() => {
  void clearTempProtectionRules().catch((err) => log('clearing continue rules failed', String(err)));
  void refreshAndSync(false);
});

// Every worker start: cheap check that the installed rules are still there.
void syncRules();
void ensureContentBlockers().catch((err) => log('content blocker check failed', String(err)));

B.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refresh-lists') void refreshAndSync(false);
  if (a.name === 'pause-end') void setPause(0);
  if (a.name === EXPIRY_ALARM) void pruneExceptions();
});

// Every worker start: drop expired site exceptions and (re)apply the overlay.
void pruneExceptions().catch((err) => log('exception prune failed', String(err)));

// ---------- network ----------

/** E2E builds: the last webRequest errors, for diagnostics. */
const webRequestErrors: Array<{ error: string; url: string; type: string; tabId: number }> = [];

if (PLATFORM === 'firefox') {
  registerFirefoxWebRequest();
  keepBackgroundAlive();
} else if (B.webRequest?.onErrorOccurred) {
  // DNR does the blocking; observe outcomes to count them per tab.
  const own = B.runtime.getURL('');
  const initiatorHost = (d: { initiator?: string }) => (d.initiator && /^https?:/i.test(d.initiator) ? hostOf(d.initiator) : null);
  B.webRequest.onErrorOccurred.addListener(
    (d) => {
      if (E2E) {
        webRequestErrors.push({ error: d.error, url: d.url, type: d.type, tabId: d.tabId });
        if (webRequestErrors.length > 40) webRequestErrors.shift();
      }
      if (d.error === 'net::ERR_BLOCKED_BY_CLIENT' && d.tabId >= 0) {
        addBlocked(d.tabId, 1);
        recordBlocked(d.tabId, { url: d.url, type: d.type, src: initiatorHost(d), at: d.timeStamp });
      }
    },
    { urls: ['<all_urls>'] },
  );
  B.webRequest.onBeforeRedirect.addListener(
    (d) => {
      if (d.redirectUrl.startsWith(own) && d.tabId >= 0) {
        addBlocked(d.tabId, 1);
        recordBlocked(d.tabId, { url: d.url, type: d.type, src: initiatorHost(d), at: d.timeStamp });
      }
    },
    { urls: ['<all_urls>'] },
  );
}

B.webNavigation?.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  resetTab(d.tabId);
  const own = consumeOwnReload(d.tabId);
  onTopCommit(d.tabId, d.url, d.transitionType, d.timeStamp, own);
  onTopCommitted(d.tabId, d.url, own);
});
B.webNavigation?.onCompleted.addListener((d) => {
  if (d.frameId === 0) onTopCompleted(d.tabId, d.timeStamp);
});
B.tabs.onRemoved.addListener((tabId) => {
  removeTab(tabId);
  removeTabData(tabId);
  onTabRemoved(tabId);
});

registerPopupBlocker();
registerNavigationRules();
registerScriptletInjection();
registerConsent();
registerProtectionCleanup();
registerNavigationGuard();
registerAi();
B.webNavigation?.onCommitted.addListener((d) => {
  if (d.frameId === 0) resetAiTab(d.tabId);
});
B.tabs.onRemoved.addListener((tabId) => resetAiTab(tabId));

// ---------- Global Privacy Control (main-world navigator.globalPrivacyControl) ----------

const GPC_SCRIPT_ID = 'adb-gpc';

async function syncGpcScript(): Promise<void> {
  const on = (await getSettings()).privacy.gpc;
  let existing: Array<{ id: string }> = [];
  try {
    existing = await B.scripting.getRegisteredContentScripts({ ids: [GPC_SCRIPT_ID] });
  } catch {
    /* none */
  }
  if (on && !existing.length) {
    await B.scripting.registerContentScripts([
      { id: GPC_SCRIPT_ID, js: ['gpc.js'], matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: true } as chrome.scripting.RegisteredContentScript,
    ]);
  } else if (!on && existing.length) {
    await B.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] });
  }
}
void syncGpcScript().catch((err) => log('GPC script registration failed', String(err)));

// ---------- messages ----------

interface Msg {
  type: string;
  [k: string]: unknown;
}

async function siteState(tabId: number) {
  const tab = await B.tabs.get(tabId);
  const url = tab.url ?? '';
  const host = /^https?:/i.test(url) ? hostOf(url) : null;
  const disabled = await disabledSites();
  const counts = await getCount(tabId);
  // Safari: stays 0. Its webRequest does not report requests DNR blocked, and its
  // getMatchedRules() returns no rule ids (so blocks cannot be told from header rules).
  const { listStatus = {}, dnrStatus } = (await B.storage.local.get(['listStatus', 'dnrStatus'])) as {
    listStatus?: Record<string, ListStatus>;
    dnrStatus?: DnrStatus;
  };
  // Firefox (and Safari) let users withhold host access from MV3 extensions.
  let hostAccess = true;
  try {
    // Safari answers false for '<all_urls>' even when every website is allowed; it does
    // answer the equivalent http/https patterns correctly.
    hostAccess = (await B.permissions.contains({ origins: ['<all_urls>'] }))
      || (await B.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }));
  } catch {
    /* not supported */
  }
  const site = host ? siteKey(host) : null;
  await loadClock();
  const signals = await signalsFor(tabId, site);
  const exceptions = site ? (await getExceptions()).filter((e) => hostMatches(host!, e.site)) : [];
  const picker = site ? (await getPickerRules()).filter((r) => hostMatches(host!, r.site)) : [];
  return {
    platform: PLATFORM,
    hostAccess,
    host,
    site,
    signals,
    suggestFix: shouldSuggestFix(signals, Date.now()),
    exceptions,
    picker,
    fix: await fixStatus(tabId),
    now: now(),
    enabled: host ? !isDisabledIn(disabled, host) : false,
    pausedUntil: await getSettings().then((x) => (isPausedAt(x.pausedUntil) ? x.pausedUntil : 0)),
    cookieBanners: (await getSettings()).cookieBanners !== false,
    consent: consentStatus(tabId),
    ai: aiTabStatus(tabId),
    blocked: counts.requests,
    popupsBlocked: counts.popups,
    lists: listStatus,
    // Safari: which of the companion app's content blockers are on (the popup asks to turn the rest on).
    contentBlockers: PLATFORM === 'safari' ? await contentBlockerSummary() : null,
    dnr: dnrStatus
      ? { installed: dnrStatus.installedDynamic + dnrStatus.installedSession, dropped: Object.values(dnrStatus.droppedByReason).reduce((a, b) => a + b, 0), rejected: dnrStatus.rejected.length }
      : null,
  };
}

async function contentBlockerSummary(): Promise<{ on: number; total: number; error: boolean } | null> {
  const s = await contentBlockerStatus();
  if (!s || !s.ok) return null;
  return { on: s.blockers.filter((b) => b.enabled).length, total: s.blockers.length, error: s.blockers.some((b) => !!b.error) };
}

async function setSiteEnabled(site: string, enabled: boolean): Promise<void> {
  const key = siteKey(site.toLowerCase());
  const list = new Set(await storedDisabledSites());
  if (enabled) {
    for (const d of [...list]) if (d === key || key.endsWith(`.${d}`) || d.endsWith(`.${key}`)) list.delete(d);
  } else list.add(key);
  await updateSettings({ disabledSites: [...list].sort() });
  await applyAllowlistQueued();
  await recordToggle(key, enabled, Date.now());
}

/** Behind any rule sync in progress: a sync replaces all dynamic rules and would otherwise put back the allowlist rule it read before this change. */
async function applyAllowlistQueued(): Promise<void> {
  if (!USES_DNR) return;
  const run = syncChain.then(() => applyAllowlist());
  syncChain = run.catch((err) => log('allowlist update failed', String(err)));
  await run;
}

// ---------- pause everywhere ----------

const PAUSE_ALARM = 'pause-end';

/** minutes: 0 = resume, < 0 = until resumed, else for that long. */
async function setPause(minutes: number): Promise<{ pausedUntil: number }> {
  const until = !minutes ? 0 : minutes < 0 ? PAUSE_FOREVER : Date.now() + Math.min(minutes, 7 * 24 * 60) * 60000;
  await updateSettings({ pausedUntil: until });
  await B.alarms.clear(PAUSE_ALARM);
  if (until && until !== PAUSE_FOREVER) B.alarms.create(PAUSE_ALARM, { when: until });
  await applyAllowlistQueued();
  pauseBadge(until);
  log(until ? `paused everywhere until ${until === PAUSE_FOREVER ? 'resumed' : new Date(until).toISOString()}` : 'resumed');
  return { pausedUntil: until };
}

/** Amber "II" on the toolbar button while paused (amber means paused, nothing else). */
function pauseBadge(until: number): void {
  const on = isPausedAt(until);
  B.action.setBadgeText({ text: on ? 'II' : '' }).catch(() => undefined);
  if (on) B.action.setBadgeBackgroundColor({ color: '#B07A00' }).catch(() => undefined);
}

// Worker start: a pause that ended while we were asleep ends now; otherwise keep its badge.
void getSettings().then((s) => {
  if (s.pausedUntil && !isPausedAt(s.pausedUntil)) void setPause(0);
  else pauseBadge(s.pausedUntil);
});

// ---------- My Rules ----------

async function rulesView() {
  const text = (await getSettings()).userFilters;
  return { text, check: checkRules(text, (l) => parseLine(l) as { kind: string; reason?: string }) };
}

async function setRules(text: string): Promise<{ ok: boolean; error?: string; check?: ReturnType<typeof checkRules> }> {
  if (text.length > MAX_USER_RULES_BYTES) return { ok: false, error: 'My Rules is too large (2 MB at most).' };
  const clean = text.replace(/\r\n/g, '\n');
  await updateSettings({ userFilters: clean });
  void refreshAndSync(false).catch((err) => log('rules sync failed', String(err)));
  return { ok: true, check: checkRules(clean, (l) => parseLine(l) as { kind: string; reason?: string }) };
}

// ---------- trusted sites (blocking off) ----------

async function setTrustedSites(add: string[], remove: string[]): Promise<{ ok: boolean; sites: string[]; error?: string }> {
  const bad = add.find((h) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h));
  if (bad) return { ok: false, sites: await storedDisabledSites(), error: `“${bad}” is not a website address.` };
  for (const h of add) await setSiteEnabled(h, false);
  for (const h of remove) await setSiteEnabled(h, true);
  return { ok: true, sites: await storedDisabledSites() };
}

/** "example.com", "https://www.example.com/page" → "example.com" */
function siteFromInput(raw: unknown): string {
  let t = String(raw ?? '').trim().toLowerCase();
  if (!t) return '';
  try {
    if (/^[a-z]+:\/\//.test(t)) t = new URL(t).hostname;
  } catch {
    return t;
  }
  return siteKey(t.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, ''));
}

// ---------- what was blocked (log) ----------

async function logView(tabId: number) {
  const tabs = (await B.tabs.query({})).filter((t) => t.id !== undefined && /^https?:/i.test(t.url ?? ''));
  const ev = tabId >= 0 ? await tabEvidence(tabId).catch(() => null) : null;
  const counts = tabId >= 0 ? await getCount(tabId) : null;
  return {
    platform: PLATFORM,
    tabs: tabs.map((t) => ({ id: t.id!, title: (t.title ?? '').slice(0, 120), host: hostOf(t.url ?? ''), active: !!t.active })),
    url: ev?.url ?? null,
    blocked: ev?.blocked.slice(-300) ?? [],
    counts,
  };
}

// ---------- backup and restore ----------

async function exportBackup(): Promise<Backup> {
  const s = await getSettings();
  const { theme } = (await B.storage.local.get('theme')) as { theme?: string };
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: {
      disabledSites: s.disabledSites, userFilters: s.userFilters, cookieBanners: s.cookieBanners !== false,
      lists: s.lists, customLists: s.customLists, privacy: { ...s.privacy }, ai: { ...s.ai },
    },
    picker: (await getPickerRules()) as unknown as Backup['picker'],
    exceptions: (await getExceptions()).filter((e) => e.expiresAt === null) as unknown as Backup['exceptions'],
    theme: theme ?? 'light',
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function importBackup(text: string): Promise<{ ok: boolean; error?: string; skipped?: string[]; summary?: string }> {
  const { backup, skipped, error } = readBackup(text);
  if (!backup) return { ok: false, error };
  const b = backup.settings;
  const cur = await getSettings();
  await updateSettings({
    disabledSites: b.disabledSites,
    userFilters: b.userFilters,
    cookieBanners: b.cookieBanners,
    lists: b.lists,
    customLists: b.customLists,
    privacy: { ...cur.privacy, ...b.privacy },
    ai: { ...cur.ai, ...b.ai },
  });
  const picker = backup.picker.filter((r) => {
    const ok = r.selectors.every((sel) => !pickerSelectorProblem(r.site, sel));
    if (!ok) skipped.push(`hidden element on ${r.site}`);
    return ok;
  });
  const existing = await getPickerRules();
  const merged = [...existing.filter((e) => !picker.some((p) => p.id === e.id)), ...(picker as unknown as PickerRule[])];
  await setPickerRules(merged);
  const ex = await getExceptions();
  const newEx = backup.exceptions.filter((e) => !ex.some((x) => x.id === e.id || (x.site === e.site && x.rule === e.rule)));
  if (newEx.length) await addExceptions(newEx as unknown as SiteException[]);
  await B.storage.local.set({ theme: backup.theme });
  await applyAllowlistQueued();
  if (USES_DNR) await applyPrivacy().catch((err) => log('privacy rules failed', String(err)));
  await syncGpcScript().catch(() => undefined);
  void refreshAndSync(false).catch((err) => log('refresh after import failed', String(err)));
  return {
    ok: true,
    skipped,
    summary: [
      plural(b.disabledSites.length, 'trusted site'),
      plural(b.userFilters.split('\n').filter((l) => l.trim() && !l.trim().startsWith('!')).length, 'rule of your own', 'rules of your own'),
      plural(picker.length, 'hidden element'),
      plural(newEx.length, 'site fix', 'site fixes'),
    ].join(', '),
  };
}

// ---------- right-click menu and welcome page ----------

const MENU_HIDE = 'qf-hide-element';
const MENU_ZAP = 'qf-zap-element';

function registerMenus(): void {
  if (!B.contextMenus) return;
  B.contextMenus.removeAll(() => {
    void B.runtime.lastError;
    B.contextMenus.create({ id: MENU_HIDE, title: 'Hide this element', contexts: ['page', 'image', 'link', 'video', 'audio', 'frame', 'selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => void B.runtime.lastError);
    B.contextMenus.create({ id: MENU_ZAP, title: 'Remove until reload', contexts: ['page', 'image', 'link', 'video', 'audio', 'frame', 'selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => void B.runtime.lastError);
  });
}

B.contextMenus?.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  if (info.menuItemId === MENU_ZAP) {
    void startZap(tab.id, !info.frameId).catch((err) => log('context menu zap failed', String(err)));
    return;
  }
  if (info.menuItemId !== MENU_HIDE) return;
  void pickFromContext(tab.id, info.frameId).catch((err) => log('context menu pick failed', String(err)));
});

B.runtime.onInstalled.addListener((details) => {
  registerMenus();
  if (details.reason === 'install' && !E2E) void B.tabs.create({ url: B.runtime.getURL('welcome.html') });
});

interface GlobalSettingsView {
  cookieBanners: boolean;
  privacy: PrivacySettings;
  ai: AiSettings;
  model: string;
  platform: string;
}

/** Global settings changed from the popup / options page. */
async function setGlobalSettings(patch: { cookieBanners?: unknown; privacy?: unknown; ai?: unknown }): Promise<GlobalSettingsView> {
  const cur = await getSettings();
  const next: Partial<Settings> = {};
  if (typeof patch.cookieBanners === 'boolean' && patch.cookieBanners !== cur.cookieBanners) next.cookieBanners = patch.cookieBanners;
  if (patch.privacy && typeof patch.privacy === 'object') {
    const p = { ...cur.privacy };
    for (const k of ['gpc', 'trimReferrer', 'stripClientData'] as const) {
      const v = (patch.privacy as Record<string, unknown>)[k];
      if (typeof v === 'boolean') p[k] = v;
    }
    next.privacy = p;
  }
  if (patch.ai && typeof patch.ai === 'object') {
    const a = { ...cur.ai };
    for (const k of ['sponsored', 'scam', 'cookiePlans'] as const) {
      const v = (patch.ai as Record<string, unknown>)[k];
      if (typeof v === 'boolean') a[k] = v;
    }
    next.ai = a;
  }
  if (Object.keys(next).length) {
    await updateSettings(next);
    if ('cookieBanners' in next) {
      // The cookie list joins or leaves the list set.
      void refreshAndSync(false).catch((err) => log('refresh after settings change failed', String(err)));
    }
    if (next.privacy) {
      if (USES_DNR) await applyPrivacy().catch((err) => log('privacy rules failed', String(err)));
      await syncGpcScript().catch((err) => log('GPC script registration failed', String(err)));
    }
  }
  const s = await getSettings();
  return { cookieBanners: s.cookieBanners !== false, privacy: s.privacy, ai: s.ai, model: await modelAvailability(), platform: PLATFORM };
}

// ---------- filter-list chooser ----------

async function listsView() {
  const s = await getSettings();
  const langs = browserLangs();
  const suggested = suggestedFor(langs);
  const { listStatus = {}, dnrStatus } = (await B.storage.local.get(['listStatus', 'dnrStatus'])) as { listStatus?: Record<string, ListStatus>; dnrStatus?: DnrStatus };
  let protection: { hosts: Record<string, number>; total: number; bytes: number; dnrLists: string[]; dnrHosts: number; ms: number; source: HostSetStats['source'] } | null = null;
  try {
    const set = await getHostSet();
    const st = hostSetStats();
    const dnr = USES_DNR ? await getProtectionSet() : null;
    protection = { hosts: st?.counts ?? {}, total: set.size, bytes: set.bytes, dnrLists: st?.dnrLists ?? [], dnrHosts: dnr?.total ?? 0, ms: st?.ms ?? 0, source: st?.source ?? 'empty' };
  } catch {
    /* not built */
  }
  return {
    platform: PLATFORM,
    override: !!s.listSources,
    cookieBanners: s.cookieBanners !== false,
    langs,
    catalogue: CATALOGUE.map((e) => ({ ...e, enabled: isListEnabled(e, s.lists, langs), suggested: suggested.includes(e.id), status: listStatus[e.id] ?? null })),
    custom: s.customLists.map((c) => ({ ...c, status: listStatus[c.id] ?? null })),
    protection,
    dnr: dnrStatus
      ? {
        installedDynamic: dnrStatus.installedDynamic, installedSession: dnrStatus.installedSession, limits: dnrStatus.limits, stats: dnrStatus.stats,
        droppedByReason: dnrStatus.droppedByReason, rejected: dnrStatus.rejected.length, protection: dnrStatus.protection ?? null, privacyRules: dnrStatus.privacyRules ?? 0, appliedAt: dnrStatus.appliedAt,
      }
      : null,
  };
}

function afterListChange(): void {
  void refreshAndSync(false).catch((err) => log('refresh after list change failed', String(err)));
}

async function setListEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const s = await getSettings();
  if (CATALOGUE.some((e) => e.id === id)) {
    await updateSettings({ lists: { ...s.lists, [id]: enabled } });
  } else if (s.customLists.some((c) => c.id === id)) {
    await updateSettings({ customLists: s.customLists.map((c) => (c.id === id ? { ...c, enabled } : c)) });
  } else return { ok: false, error: 'unknown list' };
  afterListChange();
  return { ok: true };
}

async function addCustomList(url: string, kind: unknown): Promise<{ ok: boolean; error?: string; id?: string }> {
  const problem = customListUrlProblem(url);
  if (problem) return { ok: false, error: problem };
  const s = await getSettings();
  const clean = new URL(url.trim()).href;
  if (s.customLists.some((c) => c.url === clean) || CATALOGUE.some((e) => e.url === clean)) return { ok: false, error: 'this list is already in the list' };
  if (s.customLists.length >= MAX_CUSTOM_LISTS) return { ok: false, error: `at most ${MAX_CUSTOM_LISTS} custom lists` };
  const entry: CustomList = { id: customListId(clean), url: clean, name: new URL(clean).hostname + new URL(clean).pathname, enabled: true, kind: kind === 'protection' ? 'protection' : 'filters' };
  await updateSettings({ customLists: [...s.customLists, entry] });
  afterListChange();
  return { ok: true, id: entry.id };
}

async function removeCustomList(id: string): Promise<{ ok: boolean }> {
  const s = await getSettings();
  await updateSettings({ customLists: s.customLists.filter((c) => c.id !== id) });
  afterListChange();
  return { ok: true };
}

/** "Leave page" on a suspected scam: disarm its beforeunload trap, then navigate away. */
async function leavePage(tabId: number): Promise<{ ok: boolean }> {
  try {
    await B.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: () => {
        // At-target capture listeners run first: stop the page's own handlers.
        window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true);
        window.onbeforeunload = null;
        // And make any handler that still runs unable to ask for the prompt.
        const proto = BeforeUnloadEvent.prototype as unknown as Record<string, unknown>;
        Object.defineProperty(proto, 'returnValue', { configurable: true, get: () => '', set: () => undefined });
        proto.preventDefault = () => undefined;
      },
    } as chrome.scripting.ScriptInjection<[], void>);
  } catch (err) {
    log('leave page: could not disarm beforeunload', String(err));
  }
  await B.tabs.update(tabId, { url: B.runtime.getURL('blocked.html?mode=left') });
  return { ok: true };
}

/** Messages only our own extension pages (options, popup, warning page) may send. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return !!sender.url && sender.url.startsWith(B.runtime.getURL(''));
}

async function saveReport(tabId: number, note: string): Promise<{ id: string }> {
  // Stub: kept locally until the reporting backend exists.
  const tab = await B.tabs.get(tabId);
  const { reports = [] } = (await B.storage.local.get('reports')) as { reports?: unknown[] };
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const counts = await getCount(tabId);
  reports.push({ id, at: Date.now(), url: tab.url, note: String(note ?? '').slice(0, 2000), counts, platform: PLATFORM, version: B.runtime.getManifest().version });
  await B.storage.local.set({ reports: reports.slice(-50) });
  return { id };
}

/** Target tab of a popup message (the e2e relay may say "the tab I'm in"). */
/** e2e only: result of the last test:dnrProbe run. */
let probeResult: unknown = null;

function tabOf(msg: Msg, sender: chrome.runtime.MessageSender): number {
  return E2E && msg.tabId === 'sender' ? (sender.tab?.id ?? -1) : Number(msg.tabId);
}

B.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as Msg;
  // Only our own pages and content scripts talk to us.
  if (sender.id !== B.runtime.id) return false;
  let p: Promise<unknown> | null = null;
  switch (msg?.type) {
    case 'cs:jsError':
      if (sender.tab?.id === undefined || sender.frameId !== 0) return false;
      p = recordJsError(sender.tab.id, { message: String(msg.message ?? ''), filename: String(msg.filename ?? ''), stack: String(msg.stack ?? '') }, Date.now());
      break;
    case 'cs:pickerSwitch':
      p = switchPicked(sender, String(msg.id), Number(msg.index));
      break;
    case 'picker:save':
      p = savePicked(sender, msg as { selectors?: unknown; counts?: unknown; fingerprint?: unknown });
      break;
    case 'popup:pick':
      p = startPicker(tabOf(msg, sender));
      break;
    case 'popup:zap':
      // `context`: as the right-click menu does (removes the right-clicked element first).
      p = startZap(tabOf(msg, sender), msg.context === true);
      break;
    case 'fix:start':
      p = startFix(tabOf(msg, sender), msg.mode === 'ask' || msg.mode === 'auto' ? { mode: msg.mode } : {});
      break;
    case 'fix:answer':
      p = answerFix(tabOf(msg, sender), Boolean(msg.works));
      break;
    case 'fix:cancel':
      p = cancelFix(tabOf(msg, sender));
      break;
    case 'fix:status':
      p = fixStatus(tabOf(msg, sender));
      break;
    case 'fix:list':
      p = (async () => ({ exceptions: await getExceptions(), picker: await getPickerRules(), now: (await loadClock(), now()) }))();
      break;
    case 'fix:undo':
      p = undoException(String(msg.id)).then((ok) => ({ ok }));
      break;
    case 'fix:permanent':
      p = makeExceptionPermanent(String(msg.id)).then(() => ({ ok: true }));
      break;
    case 'picker:remove':
      p = removePicked(String(msg.id)).then((ok) => ({ ok }));
      break;
    case 'test:advanceClock':
      if (!E2E) return false;
      p = advanceClock(Number(msg.ms)).then((offset) => ({ offset }));
      break;
    case 'test:pruneExceptions':
      if (!E2E) return false;
      p = pruneExceptions().then((expired) => ({ expired }));
      break;
    case 'cs:init':
      p = onContentInit(sender);
      break;
    case 'cs:linkOpen':
      onLinkOpen(sender, msg.url);
      p = Promise.resolve({ ok: true });
      break;
    case 'cs:scriptlets':
      p = onContentScriptlets(sender);
      break;
    case 'cb:status':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = contentBlockerStatus();
      break;
    case 'cb:push':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = pushContentBlockersQueued('requested', msg.force !== false);
      break;
    case 'test:dnrMainOff':
      // Safari e2e: remove the filter-list DNR rules (privacy/protection/allowlist stay)
      // so that only the content blockers block; lists:refresh puts them back.
      if (!E2E) return false;
      p = (async () => {
        const ids = (await B.declarativeNetRequest.getDynamicRules()).filter((r) => isMainRuleId(r.id)).map((r) => r.id);
        await B.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
        return { removed: ids.length };
      })();
      break;
    case 'cs:consent':
      p = Promise.resolve({ ok: onConsentMessage(sender, msg as { event?: unknown }) });
      break;
    case 'settings:get':
      p = setGlobalSettings({});
      break;
    case 'settings:set':
      p = setGlobalSettings(msg as { cookieBanners?: unknown; privacy?: unknown; ai?: unknown });
      break;
    case 'lists:get':
      p = listsView();
      break;
    case 'lists:set':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = setListEnabled(String(msg.id), Boolean(msg.enabled));
      break;
    case 'lists:addCustom':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = addCustomList(String(msg.url ?? ''), msg.kind);
      break;
    case 'lists:removeCustom':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = removeCustomList(String(msg.id));
      break;
    case 'lists:refresh':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = refreshAndSync(true).then(() => ({ ok: true }));
      break;
    case 'protect:continue':
      // Only the warning page itself, in the tab that was warned.
      if (!sender.url?.startsWith(B.runtime.getURL('blocked.html')) || sender.tab?.id === undefined) return false;
      p = allowContinue(sender.tab.id, String(msg.url ?? ''));
      break;
    case 'protect:stats':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = getHostSet().then(() => ({ stats: hostSetStats(), guard: guardHits() }));
      break;
    case 'test:perms':
      if (!E2E) return false;
      p = (async () => {
        const out: Record<string, unknown> = {};
        for (const o of ['<all_urls>', 'http://*/*', 'https://*/*', String(msg.origin ?? '')]) {
          try {
            out[o] = await B.permissions.contains({ origins: [o] });
          } catch (err) {
            out[o] = String(err);
          }
        }
        try {
          out.all = await B.permissions.getAll();
        } catch (err) {
          out.all = String(err);
        }
        return out;
      })();
      break;
    case 'test:dnr':
      if (!E2E) return false;
      p = (async () => ({
        status: (await B.storage.local.get('dnrStatus')).dnrStatus,
        dynamic: await B.declarativeNetRequest.getDynamicRules(),
        session: await B.declarativeNetRequest.getSessionRules(),
        webRequestErrors,
        protDebug,
        sessionApi: await (async () => {
          const d = B.declarativeNetRequest as unknown as Record<string, unknown>;
          const out: Record<string, unknown> = { fn: typeof d.updateSessionRules, MAX_SESSION: d.MAX_NUMBER_OF_SESSION_RULES, MAX_COMBINED: d.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES };
          try {
            await B.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 9_999_999, priority: 1, action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType }, condition: { requestDomains: ['e2e-session-probe.invalid'], tabIds: [1] } }] });
            out.added = (await B.declarativeNetRequest.getSessionRules()).some((r) => r.id === 9_999_999);
            await B.declarativeNetRequest.updateSessionRules({ removeRuleIds: [9_999_999] });
          } catch (err) {
            out.error = String(err);
          }
          return out;
        })(),
      }))();
      break;
    case 'test:dnrSummary':
      // Real-list Safari check: the DNR status without the full rule dump, plus
      // which of the given hosts have an installed block rule.
      if (!E2E) return false;
      p = (async () => {
        const rules = [...(await B.declarativeNetRequest.getDynamicRules()), ...(await B.declarativeNetRequest.getSessionRules())];
        const blocked = new Set<string>();
        for (const r of rules) {
          if (r.action.type !== 'block') continue;
          for (const d of r.condition.requestDomains ?? []) blocked.add(d);
          const m = /^\|\|([a-z0-9.-]+)\^$/.exec(r.condition.urlFilter ?? '');
          if (m) blocked.add(m[1]!);
        }
        const hosts = Array.isArray(msg.hosts) ? (msg.hosts as string[]) : [];
        const { dnrStatus } = await B.storage.local.get('dnrStatus');
        const s = dnrStatus as Record<string, unknown> | undefined;
        return {
          status: s && { ...s, droppedSample: undefined },
          dynamicRules: (await B.declarativeNetRequest.getDynamicRules()).length,
          sessionRules: (await B.declarativeNetRequest.getSessionRules()).length,
          present: hosts.filter((h) => blocked.has(h)),
        };
      })();
      break;
    case 'test:dnrProbe':
      // Measures how many rules of one shape the browser accepts as dynamic rules
      // (all dynamic rules are removed first; run lists:refresh afterwards).
      if (!E2E) return false;
      // Runs in the background (it can outlast a message round trip); poll test:dnrProbeResult.
      probeResult = null;
      void (async () => {
        const dnrApi = B.declarativeNetRequest;
        const shape = String(msg.shape ?? 'simple');
        const cap = Number(msg.max ?? 40000);
        const chunk = Number(msg.chunk ?? 1000);
        const old = (await dnrApi.getDynamicRules()).map((r) => r.id);
        await dnrApi.updateDynamicRules({ removeRuleIds: old });
        const make = (i: number): chrome.declarativeNetRequest.Rule => {
          const id = 100_000 + i;
          const block = { type: 'block' } as chrome.declarativeNetRequest.RuleAction;
          switch (shape) {
            case 'domains10': return { id, priority: 1, action: block, condition: { requestDomains: Array.from({ length: 10 }, (_, k) => `p${i}-${k}.invalid`) } };
            case 'domains100': return { id, priority: 1, action: block, condition: { requestDomains: Array.from({ length: 100 }, (_, k) => `p${i}-${k}.invalid`) } };
            case 'initiators10': return { id, priority: 1, action: block, condition: { urlFilter: `||p${i}.invalid^`, initiatorDomains: Array.from({ length: 10 }, (_, k) => `s${i}-${k}.invalid`) } };
            case 'types3': return { id, priority: 1, action: block, condition: { urlFilter: `||p${i}.invalid^`, resourceTypes: ['script', 'image', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[] } };
            case 'allow': return { id, priority: 2, action: { type: 'allow' } as chrome.declarativeNetRequest.RuleAction, condition: { urlFilter: `||p${i}.invalid^` } };
            case 'redirect': return { id, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } } as chrome.declarativeNetRequest.RuleAction, condition: { urlFilter: `||p${i}.invalid^` } };
            default: return { id, priority: 1, action: block, condition: { urlFilter: `||p${i}.invalid^` } };
          }
        };
        let n = 0;
        let error = '';
        const t0 = Date.now();
        while (n < cap) {
          const size = Math.min(chunk, cap - n);
          try {
            await dnrApi.updateDynamicRules({ addRules: Array.from({ length: size }, (_, k) => make(n + k)) });
            n += size;
          } catch (err) {
            if (size === 1) { error = String(err); break; }
            // Narrow down the exact count with single-rule adds for the last chunk.
            let ok = 0;
            for (let k = 0; k < size; k++) {
              try { await dnrApi.updateDynamicRules({ addRules: [make(n + k)] }); ok++; } catch (e) { error = String(e); break; }
            }
            n += ok;
            break;
          }
        }
        const installed = (await dnrApi.getDynamicRules()).length;
        await dnrApi.updateDynamicRules({ removeRuleIds: (await dnrApi.getDynamicRules()).map((r) => r.id) });
        probeResult = { shape, accepted: n, installed, error, ms: Date.now() - t0 };
      })().catch((err) => { probeResult = { error: String(err) }; });
      p = Promise.resolve({ started: true });
      break;
    case 'test:log':
      if (!E2E) return false;
      p = Promise.resolve(recentLog.slice(-60));
      break;
    case 'test:cosmeticsFor':
      if (!E2E) return false;
      p = getEngine().then((e) => {
        const host = String(msg.host ?? '');
        const c = e?.cosmeticsFor(host);
        const s = e?.scriptlets(host) ?? [];
        return { scriptlets: s.length, names: [...new Set(s.map((x) => (x as { name?: string }).name ?? String(x)))].slice(0, 15), hiding: c ? JSON.stringify(c).length : 0 };
      });
      break;
    case 'test:openTab':
      // E2E (YouTube timing): open a page in a new background tab.
      if (!E2E) return false;
      // In its own window, so the test page's tab stays visible (Safari throttles hidden tabs).
      p = msg.window === true
        ? B.windows.create({ url: String(msg.url), focused: true }).then((w) => ({ tabId: w?.tabs?.[0]?.id, windowId: w?.id }))
        : B.tabs.create({ url: String(msg.url), active: msg.active === true }).then((t) => ({ tabId: t.id }));
      break;
    case 'test:closeTab':
      if (!E2E) return false;
      p = B.tabs.remove(Number(msg.tabId)).then(() => ({ ok: true }));
      break;
    case 'test:videoTiming':
      // E2E: how far a tab's video player got (fixed function, page main world).
      if (!E2E) return false;
      p = B.scripting
        .executeScript({
          target: { tabId: Number(msg.tabId) },
          world: 'MAIN',
          func: () => {
            const v = (document.querySelector('video.html5-main-video') ?? document.querySelector('video')) as HTMLVideoElement | null;
            const media = performance.getEntriesByType('resource').filter((e) => /googlevideo\.com\/videoplayback/.test(e.name));
            const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
            const pr = (window as unknown as { ytInitialPlayerResponse?: { adPlacements?: unknown[]; playerAds?: unknown } }).ytInitialPlayerResponse;
            return {
              now: Math.round(performance.now()), dcl: Math.round(nav?.domContentLoadedEventEnd ?? 0),
              firstMedia: media.length ? Math.round(media[0]!.startTime) : null, mediaReqs: media.length,
              ready: v ? v.readyState : -1, t: v ? Math.round(v.currentTime * 10) / 10 : -1, paused: v ? v.paused : null,
              adPlacements: pr ? (pr.adPlacements?.length ?? 0) : null, playerAds: pr ? !!pr.playerAds : null,
              adShowing: !!document.querySelector('.ad-showing'), href: location.href,
            };
          },
        } as chrome.scripting.ScriptInjection<[], unknown>)
        .then((r) => r[0]?.result ?? null);
      break;
    case 'test:dnrProbeResult':
      if (!E2E) return false;
      p = Promise.resolve(probeResult);
      break;
    case 'test:clearContinue':
      if (!E2E) return false;
      p = clearTempProtectionRules().then(() => ({ ok: true }));
      break;
    case 'test:protectReload':
      if (!E2E) return false;
      p = reloadHostSet();
      break;
    case 'test:protectLookup':
      if (!E2E) return false;
      p = getHostSet().then((set) => {
        const t0 = performance.now();
        const list = set.lookup(String(msg.host ?? ''));
        return { list, us: (performance.now() - t0) * 1000 };
      });
      break;
    case 'fp:status':
      // Full protection (Chrome): is the switch on, and how many list fixes wait on this tab's site.
      if (!fromExtensionPage(sender)) return false;
      p = (async () => {
        const on = await fullProtectionOn(0);
        let waiting = 0;
        if (GATED && !on && typeof msg.tabId === 'number') {
          const t = await B.tabs.get(msg.tabId).catch(() => null);
          const h = t?.url && /^https?:/i.test(t.url) ? hostOf(t.url) : null;
          if (h) waiting = await waitingFixes(h);
        }
        return { gated: GATED, on, waiting };
      })();
      break;
    case 'fp:start':
      if (!fromExtensionPage(sender)) return false;
      p = startFullProtection().then(() => ({ ok: true }));
      break;
    case 'ai:warm':
      if (!fromExtensionPage(sender)) return false;
      void warmModel();
      p = Promise.resolve({ ok: true });
      break;
    case 'ai:status':
      p = modelAvailability().then((model) => ({ model, debug: modelDebug() }));
      break;
    case 'ai:clearCache':
      if (!fromExtensionPage(sender)) return false;
      p = clearAiCache().then(() => ({ ok: true }));
      break;
    case 'cs:aiInit':
      p = aiInit(sender);
      break;
    case 'cs:aiWanted':
      // Inject the AI content code only where an AI feature is on (they are off by default).
      p = (async () => {
        const init = await aiInit(sender);
        const tabId = sender.tab?.id;
        if (tabId === undefined || !(init.sponsored || init.scam || init.cookiePlans)) return { injected: false };
        await B.scripting.executeScript({ target: { tabId, frameIds: [sender.frameId ?? 0] }, files: ['content-ai.js'] });
        return { injected: true };
      })();
      break;
    case 'cs:aiSponsored':
      if (sender.frameId !== 0) return false;
      p = classifySponsored(String(msg.input ?? '')).then((sponsored) => ({ sponsored }));
      break;
    case 'cs:aiSponsoredSave':
      p = saveSponsoredVerdicts(sender, msg.verdicts).then((n) => ({ saved: n }));
      break;
    case 'cs:aiScam':
      if (sender.frameId !== 0) return false;
      p = confirmScam(String(msg.input ?? ''));
      break;
    case 'cs:aiCookie':
      // Top frame, or the consent iframe holding this tab's cookie-flow lock.
      if (!Array.isArray(msg.offered)) return false;
      p = cookieClickFor(sender, String(msg.input ?? ''), (msg.offered as Clickable[]).slice(0, 25)).then((selector) => ({ selector }));
      break;
    case 'cs:aiCookieLock':
      p = cookieLock(sender, msg as Record<string, unknown>);
      break;
    case 'cs:aiCookieSave':
      p = saveCookiePlan(sender, msg.steps, msg.offered).then((ok) => ({ ok }));
      break;
    case 'cs:aiCookieForget':
      p = forgetCookiePlan(sender).then(() => ({ ok: true }));
      break;
    case 'cs:aiReport':
      if (sender.tab?.id === undefined || typeof sender.frameId !== 'number') return false;
      if (sender.frameId !== 0 && !mayReportCookie(sender)) return false;
      p = Promise.resolve({ ok: aiReport(sender.tab.id, msg.patch, sender.frameId) });
      break;
    case 'cs:leavePage':
      if (sender.tab?.id === undefined || sender.frameId !== 0) return false;
      p = leavePage(sender.tab.id);
      break;
    case 'test:modelStub':
      if (!E2E) return false;
      setModelStub(msg.stub as ModelStub | null);
      p = Promise.resolve({ ok: true });
      break;
    case 'test:modelDebug':
      if (!E2E) return false;
      p = Promise.resolve(modelDebug());
      break;
    case 'cs:tokens':
      p = onContentTokens(sender, msg.tokens as string[]);
      break;
    case 'popup:getState':
      p = siteState(tabOf(msg, sender));
      break;
    case 'popup:setEnabled':
      p = setSiteEnabled(String(msg.site), Boolean(msg.enabled)).then(() => ({ ok: true }));
      break;
    case 'popup:report':
      p = saveReport(Number(msg.tabId), String(msg.note ?? ''));
      break;
    case 'pause:set':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = setPause(Number(msg.minutes) || 0);
      break;
    case 'popup:describe':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = describeHide(tabOf(msg, sender), String(msg.text ?? ''));
      break;
    case 'rules:get':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = rulesView();
      break;
    case 'rules:set':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = setRules(String(msg.text ?? ''));
      break;
    case 'sites:get':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = storedDisabledSites().then((sites) => ({ sites }));
      break;
    case 'sites:set': {
      if (!fromExtensionPage(sender) && !E2E) return false;
      const list = (v: unknown) => (Array.isArray(v) ? v.map(siteFromInput).filter(Boolean).slice(0, 500) : []);
      p = setTrustedSites(list(msg.add), list(msg.remove));
      break;
    }
    case 'log:get':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = logView(Number(msg.tabId ?? -1));
      break;
    case 'backup:export':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = exportBackup();
      break;
    case 'backup:import':
      if (!fromExtensionPage(sender) && !E2E) return false;
      p = importBackup(String(msg.text ?? ''));
      break;
    default:
      return false;
  }
  p.then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});

// ---------- test / diagnostics handle (service-worker global only) ----------

(globalThis as unknown as Record<string, unknown>).__adb = {
  async setSources(sources: ListSource[] | null, userFilters?: string) {
    await updateSettings({ listSources: sources, ...(userFilters !== undefined ? { userFilters } : {}) });
    invalidateEngine();
  },
  async refresh(force = true) {
    await refreshLists(force);
    await syncRules(true);
    return (await B.storage.local.get(['listStatus', 'dnrStatus'])) as Record<string, unknown>;
  },
  async status() {
    const e = await getEngine();
    return { platform: PLATFORM, engine: e ? e.stats : null, ...(await B.storage.local.get(['listStatus', 'dnrStatus', 'settings'])) };
  },
  recentlyBlockedPopups: () => recentlyBlocked,
  consentStatus,
  setCookieBanners: (on: boolean) => setGlobalSettings({ cookieBanners: on }),
  getCount,
  setSiteEnabled,
  startFix,
  answerFix,
  fixStatus,
  getExceptions,
  getPickerRules,
  pruneExceptions,
  advanceClock,
  setModelStub,
  modelDebug,
  modelAvailability,
  aiTabStatus,
  setGlobalSettings,
  listsView,
  setListEnabled,
  addCustomList,
  removeCustomList,
  /** Diagnostics / tests: alternative URLs for catalogue lists (catalogue id → URL). */
  async setUrlOverrides(map: Record<string, string>) {
    await updateSettings({ urlOverrides: map ?? {} });
  },
  async setListChoices(lists: Record<string, boolean>) {
    await updateSettings({ lists: lists ?? {} });
  },
  /** Protection host set: size, memory, where it came from (built / reloaded) and how long that took. */
  async protectionStats() {
    await getHostSet();
    return hostSetStats();
  },
  /** List id for a host (or null), and the lookup time in microseconds. */
  async protectionLookup(host: string) {
    const set = await getHostSet();
    const t0 = performance.now();
    const list = set.lookup(host);
    return { list, us: (performance.now() - t0) * 1000 };
  },
  guardHits,
  /** What a restarted worker does: drop the in-memory set and reload it from IndexedDB. */
  reloadHostSet,
  setPause,
  pickFromContext,
  startZap,
};
