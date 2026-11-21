// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// $popup blocking: close new tabs/windows opened by a page when the target URL
// matches a `$popup` rule (exceptions and page allowlisting respected).

import { B, log } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import { disabledSites, getEngine, isDisabledIn } from './state.ts';
import { addBlocked } from './counts.ts';

interface Candidate {
  openerTabId: number;
  openerUrl: string | null;
  createdAt: number;
}

/** A popup is judged on every top-level navigation in its first seconds (redirect chains). */
const WATCH_MS = 10000;
const candidates = new Map<number, Candidate>();

export interface PopupEvent {
  at: number;
  url: string;
  openerUrl: string | null;
  rule: string;
}
export const recentlyBlocked: PopupEvent[] = [];

async function frameUrl(tabId: number, frameId: number): Promise<string | null> {
  try {
    const f = await B.webNavigation.getFrame({ tabId, frameId });
    if (f?.url) return f.url;
  } catch {
    /* frame gone */
  }
  try {
    return (await B.tabs.get(tabId)).url ?? null;
  } catch {
    return null;
  }
}

async function topUrl(tabId: number): Promise<string | null> {
  try {
    return (await B.tabs.get(tabId)).url ?? null;
  } catch {
    return null;
  }
}

async function evaluate(tabId: number, url: string | undefined): Promise<void> {
  const c = candidates.get(tabId);
  if (!c) return;
  if (Date.now() - c.createdAt > WATCH_MS) {
    candidates.delete(tabId);
    return;
  }
  if (!url || !/^(https?|wss?):/i.test(url)) return; // about:blank etc: wait for the real navigation
  const engine = await getEngine();
  if (!engine) return;
  const openerTop = await topUrl(c.openerTabId);
  const disabled = await disabledSites();
  if (isDisabledIn(disabled, openerTop ? hostOf(openerTop) : null) || isDisabledIn(disabled, c.openerUrl ? hostOf(c.openerUrl) : null)) return;
  const v = engine.checkPopup(url, c.openerUrl);
  if (v.action !== 'block') return;
  candidates.delete(tabId);
  try {
    await B.tabs.remove(tabId);
  } catch (err) {
    log('popup close failed', String(err));
    return;
  }
  recentlyBlocked.unshift({ at: Date.now(), url, openerUrl: c.openerUrl, rule: v.rule });
  recentlyBlocked.length = Math.min(recentlyBlocked.length, 20);
  addBlocked(c.openerTabId, 1, 'popup');
  log('closed popup', url, 'rule', v.rule);
}

export function registerPopupBlocker(): void {
  const nav = B.webNavigation;
  if (nav?.onCreatedNavigationTarget) {
    nav.onCreatedNavigationTarget.addListener((d) => {
      candidates.set(d.tabId, { openerTabId: d.sourceTabId, openerUrl: null, createdAt: Date.now() });
      void (async () => {
        const c = candidates.get(d.tabId);
        if (c) c.openerUrl = await frameUrl(d.sourceTabId, d.sourceFrameId);
        await evaluate(d.tabId, d.url);
      })();
    });
  } else {
    // Fallback (no onCreatedNavigationTarget): tabs that have an opener.
    B.tabs.onCreated.addListener((tab) => {
      if (tab.id === undefined || tab.openerTabId === undefined) return;
      const id = tab.id;
      candidates.set(id, { openerTabId: tab.openerTabId, openerUrl: null, createdAt: Date.now() });
      void (async () => {
        const c = candidates.get(id);
        if (c) c.openerUrl = await topUrl(tab.openerTabId!);
        await evaluate(id, tab.pendingUrl ?? tab.url);
      })();
    });
  }
  nav?.onBeforeNavigate?.addListener((d) => {
    if (d.frameId === 0 && candidates.has(d.tabId)) void evaluate(d.tabId, d.url);
  });
  nav?.onCommitted?.addListener((d) => {
    if (d.frameId === 0 && candidates.has(d.tabId)) void evaluate(d.tabId, d.url);
  });
  B.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url && candidates.has(tabId)) void evaluate(tabId, info.url);
  });
  B.tabs.onRemoved.addListener((tabId) => candidates.delete(tabId));
}
