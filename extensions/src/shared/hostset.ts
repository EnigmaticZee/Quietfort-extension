// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Compact hashed host set for malware / phishing / scam protection lists that
// are too large for declarativeNetRequest (the full Block List Project malware
// list has ~2.7 million hosts).
//
// Every host is reduced to a 48-bit fingerprint: a 16-bit bucket plus a 32-bit
// key. The set is a bucket offset table (65,537 × u32) and, per bucket, the
// sorted keys (u32) with the owning list (u8). That is 5 bytes per host —
// about 14 MB for 2.7 million hosts — and it serialises as three ArrayBuffers
// that IndexedDB stores and reloads without parsing.
//
// A lookup hashes the host and each parent domain (two labels or more) and
// binary-searches one bucket: well under a microsecond each. A false positive
// needs a 48-bit collision: about n / 2^48 ≈ 1e-8 per lookup for 2.7 million
// hosts. It would show the warning page, which has "Continue anyway".
//
// Lists are parsed straight from the downloaded bytes (no 70 MB string, no
// array of millions of strings); `forEachHost` accepts exactly what
// `parseHostsList` (protection.ts) accepts.

import { KEEP_LOCALHOST_HOSTS } from './test-hosts.ts';
export const BUCKET_BITS = 16;
const BUCKETS = 1 << BUCKET_BITS;
/** At most this many lists can own entries (owner is a u8). */
export const MAX_SET_LISTS = 255;

/** 64-bit hash of a char/byte sequence as two u32 halves (cyrb53 mixing, full 64 bits kept). */
function mix(h1: number, h2: number): [number, number] {
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

/** Fingerprint of a (lowercase ASCII) host string: [bucket, key]. */
export function hostFingerprint(host: string): [number, number] {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  const [a, b] = mix(h1, h2);
  return [b >>> (32 - BUCKET_BITS), a];
}

function fingerprintBytes(buf: Uint8Array, start: number, end: number): [number, number] {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = start; i < end; i++) {
    const c = buf[i]!;
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  const [a, b] = mix(h1, h2);
  return [b >>> (32 - BUCKET_BITS), a];
}

// ---------- byte-level hosts-list parser ----------

const SP = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;
const isWs = (c: number) => c === SP || c === TAB || c === CR || c === 0x0b || c === 0x0c;
const isAlnum_ = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

function startsWith(buf: Uint8Array, at: number, end: number, s: string): boolean {
  if (end - at < s.length) return false;
  for (let i = 0; i < s.length; i++) if (buf[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

/**
 * Validates a lowercased host in buf[s, e): labels of [a-z0-9_-], not starting
 * or ending with '-', at least two labels. Mirrors protection.ts HOST_RE.
 */
function validHost(buf: Uint8Array, s: number, e: number): boolean {
  if (e <= s) return false;
  let labelStart = s;
  let dots = 0;
  for (let i = s; i <= e; i++) {
    if (i === e || buf[i] === 0x2e) {
      if (i === labelStart) return false;
      if (!isAlnum_(buf[labelStart]!) || !isAlnum_(buf[i - 1]!)) return false;
      if (i < e) dots++;
      labelStart = i + 1;
      continue;
    }
    const c = buf[i]!;
    if (!isAlnum_(c) && c !== 0x2d) return false;
  }
  return dots > 0;
}

function isDottedQuad(buf: Uint8Array, s: number, e: number): boolean {
  let parts = 0;
  let digits = 0;
  for (let i = s; i <= e; i++) {
    if (i === e || buf[i] === 0x2e) {
      if (!digits) return false;
      parts++;
      digits = 0;
      continue;
    }
    if (!isDigit(buf[i]!)) return false;
    digits++;
  }
  return parts === 4;
}

/**
 * Calls `fn(buf, start, end)` for every host in a hosts-format (`0.0.0.0 host`),
 * plain-domain or `||host^` list, lowercasing in place (the buffer is
 * modified). Lines with non-ASCII bytes go to `slow(line)` instead (IDN hosts:
 * the caller converts them with the string parser). Accepts the same hosts as
 * parseHostsList.
 */
export function forEachHost(buf: Uint8Array, fn: (buf: Uint8Array, start: number, end: number) => void, slow?: (line: string) => void): number {
  const n = buf.length;
  let count = 0;
  let pos = 0;
  while (pos < n) {
    let end = buf.indexOf(LF, pos);
    if (end < 0) end = n;
    let s = pos;
    let e = end;
    pos = end + 1;
    while (s < e && isWs(buf[s]!)) s++;
    while (e > s && isWs(buf[e - 1]!)) e--;
    if (s === e) continue;
    const c0 = buf[s]!;
    if (c0 === 0x23 || c0 === 0x21 || c0 === 0x5b) continue; // # ! [
    let ascii = true;
    for (let i = s; i < e; i++) {
      if (buf[i]! >= 0x80) {
        ascii = false;
        break;
      }
    }
    if (!ascii) {
      slow?.(new TextDecoder().decode(buf.subarray(s, e)));
      continue;
    }
    // Trailing comment ("#" after the first character).
    for (let i = s + 1; i < e; i++) {
      if (buf[i] === 0x23) {
        e = i;
        while (e > s && isWs(buf[e - 1]!)) e--;
        break;
      }
    }
    // Lowercase in place.
    for (let i = s; i < e; i++) {
      const c = buf[i]!;
      if (c >= 0x41 && c <= 0x5a) buf[i] = c + 32;
    }
    let hs: number;
    let he: number;
    let prefix = 0;
    if (startsWith(buf, s, e, '0.0.0.0')) prefix = 7;
    else if (startsWith(buf, s, e, '127.0.0.1')) prefix = 9;
    else if (startsWith(buf, s, e, '::1')) prefix = 3;
    else if (startsWith(buf, s, e, '::')) prefix = 2;
    if (prefix && s + prefix < e && isWs(buf[s + prefix]!)) {
      hs = s + prefix;
      while (hs < e && isWs(buf[hs]!)) hs++;
      he = hs;
      while (he < e && !isWs(buf[he]!)) he++;
    } else if (e - s > 3 && buf[s] === 0x7c && buf[s + 1] === 0x7c && buf[e - 1] === 0x5e) {
      hs = s + 2;
      he = e - 1;
    } else {
      let ws = false;
      for (let i = s; i < e; i++) {
        if (isWs(buf[i]!)) {
          ws = true;
          break;
        }
      }
      if (ws) continue;
      hs = s;
      he = e;
    }
    if (he > hs && buf[he - 1] === 0x2e) he--;
    if (he - hs === 9 && startsWith(buf, hs, he, 'localhost')) continue;
    if (he - hs > 10 && buf[he - 10] === 0x2e && startsWith(buf, he - 9, he, 'localhost') && !KEEP_LOCALHOST_HOSTS) continue;
    if (isDottedQuad(buf, hs, he)) continue;
    if (!validHost(buf, hs, he)) continue;
    fn(buf, hs, he);
    count++;
  }
  return count;
}

// ---------- fingerprint lists ----------

/** Fingerprints of one list, in list order (duplicates kept until the set is built). */
export interface FingerprintList {
  buckets: Uint16Array;
  keys: Uint32Array;
  n: number;
}

export class FingerprintCollector {
  private buckets = new Uint16Array(1024);
  private keys = new Uint32Array(1024);
  private n = 0;

  private push(b: number, k: number): void {
    if (this.n === this.keys.length) {
      const nb = new Uint16Array(this.n * 2);
      nb.set(this.buckets);
      this.buckets = nb;
      const nk = new Uint32Array(this.n * 2);
      nk.set(this.keys);
      this.keys = nk;
    }
    this.buckets[this.n] = b;
    this.keys[this.n] = k;
    this.n++;
  }

  addHost(host: string): void {
    const [b, k] = hostFingerprint(host);
    this.push(b, k);
  }

  addBytes(buf: Uint8Array, s: number, e: number): void {
    const [b, k] = fingerprintBytes(buf, s, e);
    this.push(b, k);
  }

  /** Reserve room for about `n` hosts (avoids re-allocations on big lists). */
  reserve(n: number): void {
    if (n <= this.keys.length) return;
    const nb = new Uint16Array(n);
    nb.set(this.buckets.subarray(0, this.n));
    this.buckets = nb;
    const nk = new Uint32Array(n);
    nk.set(this.keys.subarray(0, this.n));
    this.keys = nk;
  }

  finish(): FingerprintList {
    return { buckets: this.buckets.slice(0, this.n), keys: this.keys.slice(0, this.n), n: this.n };
  }
}

// ---------- the set ----------

/** Serialisable form (what IndexedDB stores). */
export interface HostSetData {
  ids: string[];
  offsets: Uint32Array;
  keys: Uint32Array;
  owners: Uint8Array;
  /** Distinct hosts per list (after cross-list de-duplication). */
  counts: number[];
}

export class HostSet {
  readonly ids: string[];
  readonly offsets: Uint32Array;
  readonly keys: Uint32Array;
  readonly owners: Uint8Array;
  readonly counts: number[];

  constructor(d: HostSetData) {
    if (d.offsets.length !== BUCKETS + 1 || d.keys.length !== d.owners.length || d.offsets[BUCKETS] !== d.keys.length) throw new Error('corrupt host set');
    this.ids = d.ids;
    this.offsets = d.offsets;
    this.keys = d.keys;
    this.owners = d.owners;
    this.counts = d.counts;
  }

  get size(): number {
    return this.keys.length;
  }

  /** Bytes held by the typed arrays. */
  get bytes(): number {
    return this.offsets.byteLength + this.keys.byteLength + this.owners.byteLength;
  }

  data(): HostSetData {
    return { ids: this.ids, offsets: this.offsets, keys: this.keys, owners: this.owners, counts: this.counts };
  }

  /** List index of this exact host, or -1. */
  private find(host: string): number {
    const [b, k] = hostFingerprint(host);
    let lo = this.offsets[b]!;
    let hi = this.offsets[b + 1]!;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.keys[mid]!;
      if (v === k) return this.owners[mid]!;
      if (v < k) lo = mid + 1;
      else hi = mid;
    }
    return -1;
  }

  /**
   * Index of the highest-priority (lowest-index) list that lists the host or
   * one of its parent domains (two labels or more), else -1.
   */
  lookupIndex(host: string | null | undefined): number {
    if (!host) return -1;
    let h = host.toLowerCase();
    if (h.endsWith('.')) h = h.replace(/\.+$/, '');
    let best = -1;
    while (h.includes('.')) {
      const o = this.find(h);
      if (o >= 0 && (best < 0 || o < best)) best = o;
      h = h.slice(h.indexOf('.') + 1);
    }
    return best;
  }

  /** List id for a listed host or listed parent domain, else null. */
  lookup(host: string | null | undefined): string | null {
    const i = this.lookupIndex(host);
    return i >= 0 ? (this.ids[i] ?? null) : null;
  }

  /** The listed domain (the host itself or a parent) that matched, for per-host rules. */
  matchedDomain(host: string): string | null {
    let h = host.toLowerCase().replace(/\.+$/, '');
    let found: string | null = null;
    while (h.includes('.')) {
      if (this.find(h) >= 0) found = h;
      h = h.slice(h.indexOf('.') + 1);
    }
    return found;
  }

  /**
   * Builds the set from per-list fingerprints. Earlier lists win when a host
   * is in several lists.
   */
  static build(lists: Array<{ id: string; fp: FingerprintList }>): HostSet {
    if (lists.length > MAX_SET_LISTS) throw new Error('too many lists');
    let total = 0;
    for (const l of lists) total += l.fp.n;
    const start = new Uint32Array(BUCKETS + 1);
    for (const l of lists) for (let i = 0; i < l.fp.n; i++) start[l.fp.buckets[i]! + 1]!++;
    for (let b = 0; b < BUCKETS; b++) start[b + 1]! += start[b]!;
    // key * 256 + owner fits a double exactly (< 2^40): one native sort per bucket.
    const vals = new Float64Array(total);
    const fill = start.slice(0, BUCKETS);
    lists.forEach((l, owner) => {
      for (let i = 0; i < l.fp.n; i++) vals[fill[l.fp.buckets[i]!]!++] = l.fp.keys[i]! * 256 + owner;
    });
    const offsets = new Uint32Array(BUCKETS + 1);
    const keys = new Uint32Array(total);
    const owners = new Uint8Array(total);
    const counts = lists.map(() => 0);
    let out = 0;
    for (let b = 0; b < BUCKETS; b++) {
      offsets[b] = out;
      const s = start[b]!;
      const e = start[b + 1]!;
      if (e - s > 1) vals.subarray(s, e).sort();
      let prev = -1;
      for (let i = s; i < e; i++) {
        const v = vals[i]!;
        const k = Math.floor(v / 256);
        if (k === prev) continue;
        prev = k;
        keys[out] = k;
        const o = v - k * 256;
        owners[out] = o;
        counts[o]!++;
        out++;
      }
    }
    offsets[BUCKETS] = out;
    return new HostSet({ ids: lists.map((l) => l.id), offsets, keys: keys.slice(0, out), owners: owners.slice(0, out), counts });
  }
}
