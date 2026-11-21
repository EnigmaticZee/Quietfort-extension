// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

declare const __PLATFORM__: 'chrome' | 'firefox' | 'safari';
/** True only in the end-to-end test build (dist/<platform>-e2e). */
declare const __E2E__: boolean;

export const E2E: boolean = __E2E__;

export const PLATFORM: 'chrome' | 'firefox' | 'safari' = __PLATFORM__;

/**
 * Promise-based WebExtension namespace. Firefox and Safari expose `browser`
 * (whose blocking webRequest listeners may return promises); Chrome MV3's
 * `chrome` namespace is promise-based too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const B: typeof chrome = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof chrome;

/** Last log lines, kept in memory (read by e2e tests; nothing is sent anywhere). */
export const recentLog: string[] = [];

export function log(...args: unknown[]): void {
  console.log('[adblocker]', ...args);
  recentLog.push(`${new Date().toISOString().slice(11, 19)} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.slice(0, 500));
  if (recentLog.length > 200) recentLog.splice(0, recentLog.length - 200);
}
