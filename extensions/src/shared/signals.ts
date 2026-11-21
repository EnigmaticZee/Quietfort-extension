// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Breakage signals: evidence that blocking broke the page in a tab. Pure
// helpers (classification, scoring, reload/toggle detection) so they can be
// unit tested; the background keeps the per-tab state.

export type SignalKind = 'js-error' | 'first-party-blocked' | 'reload-repeat' | 'toggle-quick' | 'explicit';

export interface Signal {
  kind: SignalKind;
  at: number;
  detail?: string;
}

export interface JsErrorReport {
  message: string;
  filename?: string;
  stack?: string;
}

export interface JsErrorClass {
  relevant: boolean;
  why: 'undefined-global' | 'blocked-url' | null;
  signature: string;
}

/** Error texts typical of code that expected a blocked script / a neutralised global. */
const UNDEFINED_PATTERNS: RegExp[] = [
  /\bis not defined\b/i,
  /\bis undefined\b/i,
  /\bis null\b/i,
  /\bundefined is not\b/i,
  /\bnull is not\b/i,
  /cannot read propert(?:y|ies) of (?:undefined|null)/i,
  /cannot set propert(?:y|ies) of (?:undefined|null)/i,
  /can't access property .*(?:undefined|null)/i,
  /\bis not a function\b/i,
  /\bis not a constructor\b/i,
  /blocked by content filter/i,
];

/** Normalised error text used to recognise "the same error" across reloads. */
export function errorSignature(message: string): string {
  return String(message)
    .replace(/^uncaught\s+(?:\(in promise\)\s*)?/i, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .toLowerCase();
}

function stripQuery(u: string): string {
  const i = u.search(/[?#]/);
  return i >= 0 ? u.slice(0, i) : u;
}

export function classifyJsError(e: JsErrorReport, blockedUrls: string[]): JsErrorClass {
  const signature = errorSignature(e.message);
  const text = `${e.message}\n${e.filename ?? ''}\n${e.stack ?? ''}`;
  for (const u of blockedUrls) {
    const base = stripQuery(u);
    if (base.length > 8 && text.includes(base)) return { relevant: true, why: 'blocked-url', signature };
  }
  if (UNDEFINED_PATTERNS.some((re) => re.test(e.message))) return { relevant: true, why: 'undefined-global', signature };
  return { relevant: false, why: null, signature };
}

const WEIGHTS: Record<SignalKind, number> = {
  'js-error': 2,
  'first-party-blocked': 1,
  'reload-repeat': 2,
  'toggle-quick': 2,
  explicit: 3,
};

/** Sum of weights of the distinct signal kinds within `windowMs` of `now`. */
export function breakageScore(signals: Signal[], now: number, windowMs = 10 * 60 * 1000): number {
  const kinds = new Set(signals.filter((s) => now - s.at <= windowMs).map((s) => s.kind));
  let score = 0;
  for (const k of kinds) score += WEIGHTS[k];
  return score;
}

export function shouldSuggestFix(signals: Signal[], now: number): boolean {
  return breakageScore(signals, now) >= 2;
}

export const RELOAD_WINDOW_MS = 30_000;

/**
 * Record a top-level reload of `url`; `repeat` is true when this is at least
 * the second reload of the same URL within RELOAD_WINDOW_MS.
 */
export function recordReload(history: Array<{ url: string; at: number }>, url: string, at: number): { history: Array<{ url: string; at: number }>; repeat: boolean } {
  const base = url.split('#')[0]!;
  const recent = history.filter((h) => at - h.at <= RELOAD_WINDOW_MS && h.url === base);
  recent.push({ url: base, at });
  return { history: recent, repeat: recent.length >= 2 };
}

export const TOGGLE_WINDOW_MS = 60_000;

/** Protection switched off and back on within TOGGLE_WINDOW_MS. */
export function isQuickToggle(offAt: number | undefined, onAt: number): boolean {
  return offAt !== undefined && onAt >= offAt && onAt - offAt <= TOGGLE_WINDOW_MS;
}
