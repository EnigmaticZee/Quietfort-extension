// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Download and storage of protection (dangerous-host) lists. A list is parsed
// straight from the downloaded bytes into 48-bit host fingerprints, which go
// to IndexedDB (`fp:<id>`); the list text itself is not kept, except — on DNR
// browsers — for lists small enough to become DNR rules (`ptext:<id>` in
// storage.local). Re-downloads are conditional (ETag / Last-Modified), so an
// unchanged 72 MB list costs one small request a day.

import { B, PLATFORM, log } from './api.ts';
import { idbDelete, idbGet, idbKeys, idbSet } from './idb.ts';
import { FingerprintCollector, forEachHost } from '../shared/hostset.ts';
import type { FingerprintList } from '../shared/hostset.ts';
import { parseHostsList, PROTECTION_TEXT_MAX } from '../shared/protection.ts';

export const USES_DNR = PLATFORM !== 'firefox';

/** What the `list:<id>` record of a protection list carries besides url / fetchedAt. */
export interface ProtectionMeta {
  /** FNV-1a of the downloaded bytes (change detection). */
  digest: number;
  bytes: number;
  /** Hosts parsed (before de-duplication). */
  hosts: number;
  /** Text kept in storage.local for DNR rules. */
  text: boolean;
  etag?: string;
  lastModified?: string;
  parseMs: number;
}

interface FpRecord {
  url: string;
  digest: number;
  n: number;
  buckets: Uint16Array;
  keys: Uint32Array;
}

export const fpKey = (id: string) => `fp:${id}`;
export const textKey = (id: string) => `ptext:${id}`;

/** Larger downloads are refused (the full Block List Project malware list is ~72 MB). */
const MAX_BYTES = 150 * 1024 * 1024;
/** 72 MB (18 MB gzipped) can take a while on a slow connection. */
const TIMEOUT_MS = 5 * 60 * 1000;

function fnv1a(buf: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i]!, 0x01000193);
  return h >>> 0;
}

/** Parse a downloaded hosts list into fingerprints (modifies `bytes`: lowercased in place). */
export function fingerprintList(bytes: Uint8Array): FingerprintList {
  const c = new FingerprintCollector();
  c.reserve(Math.max(1024, Math.ceil(bytes.length / 24)));
  forEachHost(bytes, (b, s, e) => c.addBytes(b, s, e), (line) => {
    for (const h of parseHostsList(line)) c.addHost(h);
  });
  return c.finish();
}

export interface DownloadResult {
  meta: ProtectionMeta;
  changed: boolean;
}

/**
 * Download (conditionally) and compile one protection list. Throws on network
 * errors and on responses that are not a hosts list; the previous data stays.
 */
export async function downloadProtectionList(id: string, url: string, prev: { url: string; protection?: ProtectionMeta } | undefined): Promise<DownloadResult> {
  const haveFp = (await idbKeys()).includes(fpKey(id));
  const headers: Record<string, string> = {};
  const same = !!prev?.protection && prev.url === url && haveFp;
  if (same && prev.protection!.etag) headers['If-None-Match'] = prev.protection!.etag;
  else if (same && prev.protection!.lastModified) headers['If-Modified-Since'] = prev.protection!.lastModified;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal, credentials: 'omit', headers });
    if (res.status === 304 && same) return { meta: prev.protection!, changed: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES && !res.headers.get('content-encoding')) throw new Error(`list too large (${len} bytes)`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error(`list too large (${bytes.length} bytes)`);
    let first = 0;
    while (first < bytes.length && bytes[first]! <= 0x20) first++;
    if (bytes.length < 20 || bytes[first] === 0x3c) throw new Error('response is not a hosts list');
    const digest = fnv1a(bytes);
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    if (same && prev.protection!.digest === digest && prev.protection!.bytes === bytes.length) {
      return { meta: { ...prev.protection!, etag, lastModified }, changed: false };
    }
    const keepText = USES_DNR && bytes.length <= PROTECTION_TEXT_MAX;
    const text = keepText ? new TextDecoder().decode(bytes) : '';
    const t0 = Date.now();
    const fp = fingerprintList(bytes);
    const parseMs = Date.now() - t0;
    if (!fp.n) throw new Error('no hosts in the list');
    await idbSet(fpKey(id), { url, digest, n: fp.n, buckets: fp.buckets, keys: fp.keys } satisfies FpRecord);
    if (keepText) await B.storage.local.set({ [textKey(id)]: text });
    else await B.storage.local.remove(textKey(id));
    log(`protection list ${id}: ${bytes.length} bytes, ${fp.n} hosts parsed in ${parseMs} ms`);
    return { meta: { digest, bytes: bytes.length, hosts: fp.n, text: keepText, etag, lastModified, parseMs }, changed: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadFingerprints(id: string): Promise<FingerprintList | null> {
  const r = await idbGet<FpRecord>(fpKey(id));
  if (!r || !r.keys || !r.buckets || r.keys.length !== r.n) return null;
  return { buckets: r.buckets, keys: r.keys, n: r.n };
}

/** Forget stored data of protection lists that are no longer configured. */
export async function pruneProtectionData(keep: string[]): Promise<void> {
  const k = new Set(keep);
  const stale = (await idbKeys()).filter((x) => x.startsWith('fp:') && !k.has(x.slice(3)));
  await idbDelete(stale);
  const all = await B.storage.local.get(null);
  const staleText = Object.keys(all).filter((x) => x.startsWith('ptext:') && !k.has(x.slice(6)));
  if (staleText.length) await B.storage.local.remove(staleText);
}
