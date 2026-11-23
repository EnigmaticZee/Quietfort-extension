// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Per-tab blocked-request counters (reset on each top-level navigation),
// mirrored to storage.session so they survive service-worker restarts.

import { B } from './api.ts';
import type { Category } from '../shared/category.ts';

export type Kinds = Record<Category, number>;

interface TabCount {
  requests: number;
  popups: number;
  /** Requests split by rough kind (shared/category.ts). */
  kinds?: Kinds;
}

const noKinds = (): Kinds => ({ ads: 0, trackers: 0, danger: 0, other: 0 });

let counts: Record<string, TabCount> = {};
let loaded: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const s = await B.storage.session.get('tabCounts');
        counts = { ...((s.tabCounts as Record<string, TabCount>) ?? {}), ...counts };
      } catch {
        /* storage.session unavailable */
      }
    })();
  }
  return loaded;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    B.storage.session?.set({ tabCounts: counts }).catch(() => undefined);
  }, 250);
}

function badge(tabId: number): void {
  const c = counts[tabId];
  const n = c ? c.requests + c.popups : 0;
  // No count: null falls back to the global badge ("II" while paused everywhere).
  B.action.setBadgeText({ tabId, text: n ? String(n > 999 ? '999+' : n) : null } as unknown as chrome.action.BadgeTextDetails).catch(() => undefined);
}

export function addBlocked(tabId: number, n = 1, kind: 'request' | 'popup' = 'request', cat: Category = 'other'): void {
  if (tabId < 0) return;
  void load().then(() => {
    const c = (counts[tabId] ??= { requests: 0, popups: 0, kinds: noKinds() });
    if (kind === 'popup') c.popups += n;
    else {
      c.requests += n;
      (c.kinds ??= noKinds())[cat] += n;
    }
    badge(tabId);
    scheduleSave();
  });
}

export function resetTab(tabId: number): void {
  void load().then(() => {
    // Popups closed on behalf of this tab are kept until the next navigation too.
    counts[tabId] = { requests: 0, popups: 0, kinds: noKinds() };
    badge(tabId);
    scheduleSave();
  });
}

export function removeTab(tabId: number): void {
  void load().then(() => {
    delete counts[tabId];
    scheduleSave();
  });
}

export async function getCount(tabId: number): Promise<Required<TabCount>> {
  await load();
  const c = counts[tabId];
  return { requests: c?.requests ?? 0, popups: c?.popups ?? 0, kinds: c?.kinds ?? noKinds() };
}
