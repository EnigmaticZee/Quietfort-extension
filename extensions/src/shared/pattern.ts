// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABP network pattern matching (`||`, `|`, `*`, `^`, `/regex/`). Port of
// the Rust pattern.rs (tag mac-app-final).

import type { PatternSpec } from './types.ts';

/** `^` matches anything except letters, digits and `_ - . %`, or the end of the URL. */
function isSeparator(c: number): boolean {
  return !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 46 || c === 37);
}

const CARET = 94; // '^'

function segAt(seg: string, u: string, start: number): number {
  let i = start;
  for (let k = 0; k < seg.length; k++) {
    const p = seg.charCodeAt(k);
    if (p === CARET) {
      if (i < u.length && isSeparator(u.charCodeAt(i))) i++;
      else if (i === u.length && /^\^*$/.test(seg.slice(k))) return i;
      else return -1;
    } else if (i < u.length && u.charCodeAt(i) === p) i++;
    else return -1;
  }
  return i;
}

function segFind(seg: string, u: string, from: number): [number, number] | null {
  if (!seg) return [from, from];
  const first = seg.charCodeAt(0);
  let s = from;
  while (s <= u.length) {
    if (first !== CARET) {
      const p = u.indexOf(seg[0]!, s);
      if (p < 0) return null;
      s = p;
    }
    const e = segAt(seg, u, s);
    if (e >= 0) return [s, e];
    s++;
  }
  return null;
}

function endsAt(seg: string, u: string, from: number): boolean {
  for (let s = u.length; s >= from; s--) if (segAt(seg, u, s) === u.length) return true;
  return false;
}

function matchFrom(segments: string[], u: string, start: number, anchored: boolean, endAnchor: boolean): boolean {
  const n = segments.length;
  let pos: number;
  if (anchored) {
    const e = segAt(segments[0]!, u, start);
    if (e < 0) return false;
    pos = e;
    if (n === 1) return !endAnchor || pos === u.length;
  } else if (n === 1) {
    if (endAnchor) return endsAt(segments[0]!, u, 0);
    return segFind(segments[0]!, u, start) !== null;
  } else {
    const f = segFind(segments[0]!, u, start);
    if (!f) return false;
    pos = f[1];
  }
  for (let k = 1; k < n - 1; k++) {
    const f = segFind(segments[k]!, u, pos);
    if (!f) return false;
    pos = f[1];
  }
  const last = segments[n - 1]!;
  return endAnchor ? endsAt(last, u, pos) : segFind(last, u, pos) !== null;
}

export interface CompiledPattern {
  /** `url` is lowercased unless the rule is match-case. */
  matches(url: string, hostStart: number, hostEnd: number): boolean;
}

export function compilePattern(spec: PatternSpec, matchCase: boolean): CompiledPattern {
  if (spec.kind === 'regex') {
    const re = new RegExp(spec.source, matchCase ? '' : 'i');
    return { matches: (url) => re.test(url) };
  }
  const segments = spec.body.split('*');
  const { anchor, endAnchor } = spec;
  return {
    matches(u, hostStart, hostEnd) {
      if (anchor === 'start') return matchFrom(segments, u, 0, true, endAnchor);
      if (anchor === 'host') {
        let i = hostStart;
        for (;;) {
          if (matchFrom(segments, u, i, true, endAnchor)) return true;
          const p = u.indexOf('.', i);
          if (p < 0 || p >= hostEnd) return false;
          i = p + 1;
        }
      }
      return matchFrom(segments, u, 0, false, endAnchor);
    },
  };
}

/** Byte range of the host inside a URL. */
export function hostRange(url: string): [number, number] {
  const si = url.indexOf('://');
  const start = si >= 0 ? si + 3 : 0;
  let authEnd = url.length;
  for (let i = start; i < url.length; i++) {
    const c = url[i];
    if (c === '/' || c === '?' || c === '#') {
      authEnd = i;
      break;
    }
  }
  const auth = url.slice(start, authEnd);
  const at = auth.lastIndexOf('@');
  const hostStart = start + (at >= 0 ? at + 1 : 0);
  const hostPart = url.slice(hostStart, authEnd);
  let hostLen: number;
  if (hostPart.startsWith('[')) hostLen = (hostPart.indexOf(']') + 1) || hostPart.length;
  else {
    const colon = hostPart.indexOf(':');
    hostLen = colon >= 0 ? colon : hostPart.length;
  }
  return [hostStart, hostStart + hostLen];
}
