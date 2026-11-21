// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Wall clock for expiring site exceptions, with a test offset. The offset can
// only be changed from the background context (the service-worker diagnostics
// handle `__adb`, or the e2e build's test relay), never by web pages.

import { B } from './api.ts';

let offset = 0;
let loaded: Promise<void> | null = null;

export function loadClock(): Promise<void> {
  loaded ??= B.storage.local.get('testClockOffset').then((s) => {
    offset = Number(s.testClockOffset) || 0;
  }, () => undefined);
  return loaded;
}

export function now(): number {
  return Date.now() + offset;
}

/** Move the clock forward by `ms` (tests; persisted across worker restarts). */
export async function advanceClock(ms: number): Promise<number> {
  await loadClock();
  offset += Number(ms) || 0;
  await B.storage.local.set({ testClockOffset: offset });
  return offset;
}
