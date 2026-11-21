// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Cookie / privacy-consent banners: "reject all", then hide what is left.
//
// Runs DuckDuckGo autoconsent (MPL-2.0), shipped UNMODIFIED in the package as
// autoconsent/autoconsent.playwright.js + autoconsent/compact-rules.json (see
// THIRD_PARTY_NOTICES.md), entirely in the page's main world: first our host
// (extensions/page-runtime/assets/consent-host.js, the same one the Mac proxy
// injects) with this frame's rules and a fixed opt-out-only configuration,
// then autoconsent's page script. Leftover notices are hidden by the EasyList
// Cookie List, downloaded at runtime like the other lists (state.ts).
//
// Top frames always get it; iframes only when their URL looks like a consent
// platform's (markers or a site-specific frame rule), which keeps ad and
// video iframes free of it.

import consentHost from '@consent-host';
import markersText from '@consent-markers';
import { B, log } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import { hasSiteFrameRule, isSourcepointFrameUrl, markerMatcher, rulesFor } from '../shared/consent.ts';
import type { IndexedRuleset } from '../shared/consent.ts';
import { disabledSites, getSettings, isDisabledIn } from './state.ts';

export const AUTOCONSENT_SCRIPT = 'autoconsent/autoconsent.playwright.js';
const RULES_FILE = 'autoconsent/compact-rules.json';
const markers = markerMatcher(markersText);

export interface ConsentStatus {
  /** CMP rule that detected a consent platform. */
  cmp: string | null;
  popup: boolean;
  /** Result of "reject all" (null: not attempted / not finished). */
  optOut: boolean | null;
  done: boolean;
  /** Handled by hiding only (no reject button exists). */
  cosmetic: boolean;
  clicks: number | null;
  frame: 'top' | 'sub' | null;
  /** A "reject" that would have meant paying / subscribing / signing in was not clicked. */
  refusedPaywall?: boolean;
  /** Every progress message on this page, oldest first (at most 20). */
  events: Array<{ frame: 'top' | 'sub'; event: string; cmp: string; result: boolean | null }>;
}

const statusByTab = new Map<number, ConsentStatus>();

export function consentStatus(tabId: number): ConsentStatus | null {
  return statusByTab.get(tabId) ?? null;
}

let rulesPromise: Promise<IndexedRuleset | null> | null = null;

function loadRules(): Promise<IndexedRuleset | null> {
  if (!rulesPromise) {
    rulesPromise = fetch(B.runtime.getURL(RULES_FILE))
      .then((r) => r.json() as Promise<IndexedRuleset>)
      .catch((err) => {
        log('autoconsent rules failed to load', String(err));
        rulesPromise = null;
        return null;
      });
  }
  return rulesPromise;
}

async function topHost(tabId: number, fallback: string): Promise<string> {
  try {
    const u = (await B.tabs.get(tabId)).url;
    return u && /^https?:/i.test(u) ? hostOf(u) ?? fallback : fallback;
  } catch {
    return fallback;
  }
}

/** Should this frame get the consent handler? */
export async function wantsConsent(url: string, frameId: number): Promise<boolean> {
  if (frameId === 0) return true;
  if (markers.test(url) || isSourcepointFrameUrl(url)) return true;
  const rules = await loadRules();
  return !!rules && hasSiteFrameRule(rules, url);
}

async function inject(tabId: number, frameId: number, url: string): Promise<void> {
  const host = hostOf(url);
  if (!host) return;
  if ((await getSettings()).cookieBanners === false) return;
  if (!(await wantsConsent(url, frameId))) return;
  const disabled = await disabledSites();
  const top = frameId === 0 ? host : await topHost(tabId, host);
  if (isDisabledIn(disabled, top) || isDisabledIn(disabled, host)) return;
  const rules = await loadRules();
  if (!rules) return;
  const target = { tabId, frameIds: [frameId] };
  await B.scripting.executeScript({
    target,
    world: 'MAIN',
    injectImmediately: true,
    func: consentHost,
    args: [{ rules: rulesFor(rules, url, frameId === 0), notify: true }],
  } as chrome.scripting.ScriptInjection<[unknown], void>);
  await B.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, files: [AUTOCONSENT_SCRIPT] } as chrome.scripting.ScriptInjection<[], void>);
}

export function registerConsent(): void {
  B.webNavigation?.onCommitted.addListener((d) => {
    if (d.frameId === 0) statusByTab.delete(d.tabId);
    if (!/^https?:/i.test(d.url)) return;
    inject(d.tabId, d.frameId, d.url).catch((err) => log('consent injection failed', d.url, String(err)));
  });
  B.tabs.onRemoved.addListener((tabId) => statusByTab.delete(tabId));
}

/** A progress message relayed by the content script from the host. */
export function onConsentMessage(sender: chrome.runtime.MessageSender, msg: { event?: unknown; cmp?: unknown; result?: unknown; cosmetic?: unknown; clicks?: unknown }): boolean {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  const st: ConsentStatus = statusByTab.get(tabId) ?? { cmp: null, popup: false, optOut: null, done: false, cosmetic: false, clicks: null, frame: null, events: [] };
  const cmp = typeof msg.cmp === 'string' ? msg.cmp.slice(0, 100) : '';
  const frame = sender.frameId === 0 ? 'top' : 'sub';
  if (typeof msg.event === 'string' && st.events.length < 20) {
    st.events.push({ frame, event: msg.event.slice(0, 40), cmp, result: typeof msg.result === 'boolean' ? msg.result : null });
  }
  switch (msg.event) {
    case 'cmpDetected':
      if (!st.cmp) Object.assign(st, { cmp, frame });
      break;
    case 'popupFound':
      Object.assign(st, { cmp, popup: true, frame });
      break;
    case 'optOutResult':
      Object.assign(st, { cmp, optOut: msg.result === true, frame });
      break;
    case 'autoconsentDone':
      Object.assign(st, { cmp, done: true, cosmetic: msg.cosmetic === true, clicks: typeof msg.clicks === 'number' ? msg.clicks : null, frame });
      break;
    case 'clickRefused':
      st.refusedPaywall = true;
      break;
    default:
      return false;
  }
  statusByTab.set(tabId, st);
  return true;
}
