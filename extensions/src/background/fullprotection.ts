// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// "Full protection" on Chrome. The filter lists' page fixes (scriptlets and
// procedural filters) are instructions downloaded at runtime. The Chrome Web
// Store allows running such instructions only through the User Scripts API,
// which the person turns on with Chrome's "Allow User Scripts" switch on
// Quietfort's details page (no extension can turn it on itself). Until then,
// Chrome gets the lists' blocking and hiding rules plus the person's own rules;
// Firefox and Safari are not affected.

import { B, PLATFORM, log } from './api.ts';

/** Chrome-family builds keep the lists' page fixes behind the switch. */
export const GATED = PLATFORM === 'chrome';

/** The parts of chrome.userScripts used here (present only while the switch is on). */
export interface UserScriptsApi {
  getScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string }>>;
  register(scripts: unknown[]): Promise<void>;
  unregister(filter?: { ids?: string[] }): Promise<void>;
  execute?(injection: unknown): Promise<unknown>;
}

export function userScriptsApi(): UserScriptsApi | null {
  return ((B as unknown as { userScripts?: UserScriptsApi }).userScripts) ?? null;
}

let state: { on: boolean; at: number } | null = null;
const listeners: Array<(on: boolean) => void | Promise<void>> = [];

/** Is Chrome's "Allow User Scripts" switch on for Quietfort? (Cached for `maxAgeMs`.) */
export async function fullProtectionOn(maxAgeMs = 5000): Promise<boolean> {
  if (!GATED) return false;
  if (state && Date.now() - state.at < maxAgeMs) return state.on;
  let on = false;
  const api = userScriptsApi();
  if (api) {
    try {
      await api.getScripts();
      on = true;
    } catch {
      on = false;
    }
  }
  const changed = state !== null && state.on !== on;
  state = { on, at: Date.now() };
  if (changed) {
    log(`full protection ${on ? 'on' : 'off'} (Chrome "Allow User Scripts" switch)`);
    for (const fn of listeners) await Promise.resolve(fn(on)).catch((err) => log('full protection change failed', String(err)));
  }
  return on;
}

/** Called when the switch is found turned on or off. */
export function onFullProtectionChange(fn: (on: boolean) => void | Promise<void>): void {
  listeners.push(fn);
}

/** Opens Quietfort's own page in Chrome's extension settings, where the switch is. */
export async function openSwitchPage(): Promise<void> {
  await B.tabs.create({ url: `chrome://extensions/?id=${B.runtime.id}` });
}

let watching: ReturnType<typeof setInterval> | null = null;

/**
 * "Turn on full protection": opens Chrome's page for Quietfort and watches for the switch (every second,
 * up to 3 minutes). When it is turned on, the "Done" page opens so the person sees it worked.
 */
export async function startFullProtection(): Promise<void> {
  if (!GATED) return;
  if (await fullProtectionOn(0)) {
    await B.tabs.create({ url: B.runtime.getURL('fullprotection.html') });
    return;
  }
  await openSwitchPage();
  if (watching) clearInterval(watching);
  const until = Date.now() + 180_000;
  watching = setInterval(() => {
    void (async () => {
      if (Date.now() > until) {
        if (watching) clearInterval(watching);
        watching = null;
        return;
      }
      if (await fullProtectionOn(0)) {
        if (watching) clearInterval(watching);
        watching = null;
        await B.tabs.create({ url: B.runtime.getURL('fullprotection.html?done=1') });
      }
    })();
  }, 1000);
}
