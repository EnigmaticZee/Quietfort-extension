// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Hashed host set for the full-size protection lists: the byte parser accepts
// exactly what parseHostsList accepts, lookups match hosts and subdomains and
// nothing else, cross-list priority, and size / speed at 2.7 million hosts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FingerprintCollector, forEachHost, HostSet, hostFingerprint } from '../../src/shared/hostset.ts';
import { parseHostsList } from '../../src/shared/protection.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function parseBytes(text: string): string[] {
  const out: string[] = [];
  forEachHost(enc(text), (b, s, e) => out.push(new TextDecoder().decode(b.subarray(s, e))), (line) => out.push(...parseHostsList(line)));
  return out;
}

const TRICKY = `# Title: test list
! abp comment
[Adblock Plus 2.0]
0.0.0.0 evil.example
0.0.0.0 Login-Bank.example.   # trailing comment
127.0.0.1 phish.test
::1 v6.example
:: v6b.example
::1host.example
0.0.0.0host.example
0.0.0.0 localhost
0.0.0.0 sub.localhost
0.0.0.0 localhost.example
0.0.0.0 0.0.0.0
0.0.0.0 10.1.2.3
0.0.0.0 bad_host..example
0.0.0.0 -dash.example
0.0.0.0 dash-.example
0.0.0.0 under_score.example
0.0.0.0\ttabbed.example
   plain.example   \r
||abp-style.example^
||^
||a b^
two words.example
nodot
0.0.0.0 sub.evil.example
0.0.0.0 bücher.example
0.0.0.0 ok.example extra-token
#0.0.0.0 commented.example
`;

test('byte parser accepts exactly what parseHostsList accepts (ASCII + IDN fallback)', () => {
  assert.deepEqual(parseBytes(TRICKY), parseHostsList(TRICKY));
  assert.ok(parseHostsList(TRICKY).includes('xn--bcher-kva.example'));
  // No trailing newline, CRLF line ends.
  const crlf = '0.0.0.0 a.example\r\n0.0.0.0 B.example\r\nc.example';
  assert.deepEqual(parseBytes(crlf), ['a.example', 'b.example', 'c.example']);
});

test('fingerprints of bytes and strings agree', () => {
  const c1 = new FingerprintCollector();
  const c2 = new FingerprintCollector();
  forEachHost(enc('0.0.0.0 Evil.Example\nplain.test\n'), (b, s, e) => c1.addBytes(b, s, e));
  c2.addHost('evil.example');
  c2.addHost('plain.test');
  assert.deepEqual(c1.finish(), c2.finish());
  assert.deepEqual(hostFingerprint('a.example'), hostFingerprint('a.example'));
  assert.notDeepEqual(hostFingerprint('a.example'), hostFingerprint('b.example'));
});

function setOf(lists: Array<[string, string[]]>): HostSet {
  return HostSet.build(lists.map(([id, hosts]) => {
    const c = new FingerprintCollector();
    for (const h of hosts) c.addHost(h);
    return { id, fp: c.finish() };
  }));
}

test('lookup: host and subdomains match; parents, siblings and look-alikes do not', () => {
  const s = setOf([['blp-malware', ['evil.example', 'deep.sub.bad.test']]]);
  assert.equal(s.lookup('evil.example'), 'blp-malware');
  assert.equal(s.lookup('a.b.evil.example'), 'blp-malware');
  assert.equal(s.lookup('EVIL.example.'), 'blp-malware');
  assert.equal(s.lookup('notevil.example'), null);
  assert.equal(s.lookup('evil.example.com'), null);
  assert.equal(s.lookup('example'), null);
  assert.equal(s.lookup('bad.test'), null);
  assert.equal(s.lookup('sub.bad.test'), null);
  assert.equal(s.lookup('x.deep.sub.bad.test'), 'blp-malware');
  assert.equal(s.lookup(null), null);
  assert.equal(s.lookup(''), null);
});

test('cross-list duplicates: the earlier list owns the host; counts are distinct hosts', () => {
  const s = setOf([['blp-phishing', ['p.example', 'both.example', 'p.example']], ['blp-malware', ['both.example', 'm.example']]]);
  assert.equal(s.lookup('both.example'), 'blp-phishing');
  assert.equal(s.lookup('m.example'), 'blp-malware');
  assert.deepEqual(s.counts, [2, 1]);
  assert.equal(s.size, 3);
});

test('data round trip (what IndexedDB stores) gives the same answers; corrupt data refused', () => {
  const s = setOf([['a', ['x.example', 'y.example']]]);
  const d = structuredClone(s.data());
  const s2 = new HostSet(d);
  assert.equal(s2.lookup('www.x.example'), 'a');
  assert.equal(s2.lookup('z.example'), null);
  assert.throws(() => new HostSet({ ...d, keys: d.keys.slice(1) }));
});

/** Synthetic hosts-format list (random names, realistic lengths). */
export function syntheticList(n: number, seed = 7): { text: string; hosts: string[] } {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const tlds = ['com', 'net', 'xyz', 'top', 'info', 'ru', 'co.uk'];
  let x = seed;
  const rnd = () => {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    return x;
  };
  const hosts: string[] = [];
  for (let i = 0; i < n; i++) {
    let h = '';
    const l = 5 + (rnd() % 14);
    for (let j = 0; j < l; j++) h += chars[rnd() % 36];
    if (rnd() % 4 === 0) h = `${['www', 'login', 'cdn', 'mail'][rnd() % 4]}.${h}`;
    hosts.push(`${h}.${tlds[rnd() % tlds.length]}`);
  }
  return { text: `# synthetic\n${hosts.map((h) => `0.0.0.0 ${h}`).join('\n')}\n`, hosts };
}

test('full-size list: 2.7 million hosts — build time, memory, lookup latency, reload cost, false positives', () => {
  const N = 2_700_000;
  const { text, hosts } = syntheticList(N);
  const bytes = enc(text);
  const t0 = performance.now();
  const c = new FingerprintCollector();
  c.reserve(N);
  const parsed = forEachHost(bytes, (b, s, e) => c.addBytes(b, s, e));
  const fp = c.finish();
  const t1 = performance.now();
  const set = HostSet.build([{ id: 'blp-malware', fp }]);
  const t2 = performance.now();
  assert.equal(parsed, N);
  // Deep in the list, and subdomains of it.
  for (const i of [0, 1_234_567, 2_500_000, N - 1]) {
    assert.equal(set.lookup(hosts[i]!), 'blp-malware', hosts[i]);
    assert.equal(set.lookup(`a.b.${hosts[i]!}`), 'blp-malware');
  }
  // Lookup latency over unlisted hosts (the common case: every parent is tried).
  const probes = Array.from({ length: 200_000 }, (_, i) => `www.site${i}.example-${i % 97}.com`);
  const t3 = performance.now();
  let fps = 0;
  for (const p of probes) if (set.lookup(p)) fps++;
  const t4 = performance.now();
  // Reload: what a restarted worker does with the IndexedDB record.
  const t5 = performance.now();
  const reloaded = new HostSet(structuredClone(set.data()));
  const t6 = performance.now();
  assert.equal(reloaded.lookup(hosts[2_500_000]!), 'blp-malware');
  const distinct = new Set(hosts).size;
  assert.ok(set.size >= distinct - 5 && set.size <= distinct, `size ${set.size} vs ${distinct}`);
  assert.equal(fps, 0, 'no false positives among 200k unlisted hosts');
  const mb = set.bytes / 1e6;
  assert.ok(mb < 15, `${mb} MB`);
  const usPerLookup = ((t4 - t3) * 1000) / probes.length;
  console.log(`hostset: ${N} hosts (${(bytes.length / 1e6).toFixed(0)} MB text) parse+hash ${(t1 - t0).toFixed(0)} ms, build ${(t2 - t1).toFixed(0)} ms, ${mb.toFixed(1)} MB, lookup ${usPerLookup.toFixed(2)} µs (3 labels), structured-clone reload ${(t6 - t5).toFixed(0)} ms`);
  assert.ok(usPerLookup < 20, `${usPerLookup} µs per lookup`);
});

test('a listed parent in a higher-priority list wins over a listed subdomain in a lower one', () => {
  const s = setOf([['blp-phishing', ['evil.example']], ['blp-malware', ['sub.evil.example', 'only.example']]]);
  assert.equal(s.lookup('sub.evil.example'), 'blp-phishing');
  assert.equal(s.lookup('x.sub.evil.example'), 'blp-phishing');
  assert.equal(s.lookupIndex('only.example'), 1);
  assert.equal(s.matchedDomain('a.sub.evil.example'), 'evil.example');
  assert.equal(s.matchedDomain('a.only.example'), 'only.example');
  assert.equal(s.matchedDomain('a.example'), null);
});
