// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Firefox runs an MV3 background as an event page and unloads it after ~30 s
// without events. Our blocking webRequest listener then wakes it on the next
// navigation, and every request of that page (the document included) is held
// until the engine has been rebuilt from the stored list text: measured at
// +0.5 s time-to-first-byte and DOMContentLoaded on news sites whenever the
// user had been idle for half a minute. An extension API call from the
// background resets Firefox's idle timer, so a cheap one every 20 s keeps the
// compiled engine in memory. (Chrome blocks with DNR, which needs no worker.)

import { B } from './api.ts';

export const KEEPALIVE_MS = 20_000;

export function keepBackgroundAlive(): void {
  setInterval(() => {
    B.runtime.getPlatformInfo().catch(() => undefined);
  }, KEEPALIVE_MS);
}
