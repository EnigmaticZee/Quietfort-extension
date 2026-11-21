// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Malware/phishing protection: hosts parsing, de-duplication and limits,
// Firefox lookup, DNR rule shapes and the warning-page URL round trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProtectionSet, chooseDnrLists, continueRule, CONTINUE_FIRST_ID, CONTINUE_PRIORITY, CONTINUE_SLOTS, GUARD_FIRST_ID, guardRules, MAX_PROTECTION_HOSTS,
  parseBlockedPageUrl, parseHostsList, PROTECTION_FIRST_ID, PROTECTION_PRIORITY, PROTECTION_SLOTS, protectionDnrRules, warningUrl,
} from '../../src/shared/protection.ts';
import { PRIORITY } from '../../src/shared/dnr.ts';

const SAMPLE = `# Title: test list
# a comment
0.0.0.0 evil.example
0.0.0.0 Login-Bank.example.   # trailing comment
127.0.0.1 phish.test
0.0.0.0 localhost
0.0.0.0 0.0.0.0
0.0.0.0 10.1.2.3
0.0.0.0 bad_host..example
plain.example
||abp-style.example^
0.0.0.0 sub.evil.example
`;

test('parseHostsList: hosts, plain and ||host^ lines; comments, localhost, IPs and junk skipped', () => {
  assert.deepEqual(parseHostsList(SAMPLE), ['evil.example', 'login-bank.example', 'phish.test', 'plain.example', 'abp-style.example', 'sub.evil.example']);
});

test('buildProtectionSet: dedupe across lists, parents cover subdomains, cap reported', () => {
  const s = buildProtectionSet([
    { id: 'a', hosts: ['evil.example', 'sub.evil.example', 'x.example'] },
    { id: 'b', hosts: ['x.example', 'y.example', 'z.example'] },
  ], 3);
  assert.deepEqual(s.byList, [{ id: 'a', hosts: ['evil.example', 'x.example'] }, { id: 'b', hosts: ['y.example'] }]);
  assert.deepEqual(s.counts, { a: 2, b: 1 });
  assert.deepEqual(s.dropped, { b: 1 });
  assert.equal(s.total, 3);
});

test('DNR lists: whole lists in priority order within the host budget; text-less (full-size) lists stay hashed-only', () => {
  const lists = [
    { id: 'blp-phishing', hosts: 190_000, text: true },
    { id: 'blp-malware', hosts: 2_700_000, text: false },
    { id: 'blp-fraud', hosts: 500_000, text: true },
    { id: 'blp-scam', hosts: 200_000, text: true },
    { id: 'blp-ransomware', hosts: 0, text: true },
  ];
  assert.deepEqual(chooseDnrLists(lists), ['blp-phishing', 'blp-fraud']);
  assert.deepEqual(chooseDnrLists(lists, 10_000_000), ['blp-phishing', 'blp-fraud', 'blp-scam']);
  assert.equal(MAX_PROTECTION_HOSTS, 800_000);
});

test('guard rules: redirect + block for one listed domain, session ids outside the continue range', () => {
  const [redirect, block] = guardRules(GUARD_FIRST_ID, 'deep.example', 'blp-malware', 'chrome-extension://abc/blocked.html');
  assert.equal(redirect!.id, GUARD_FIRST_ID);
  assert.equal(block!.id, GUARD_FIRST_ID + 1);
  assert.deepEqual(redirect!.condition.requestDomains, ['deep.example']);
  assert.deepEqual(redirect!.condition.resourceTypes, ['main_frame']);
  assert.equal(redirect!.action.redirect!.regexSubstitution, 'chrome-extension://abc/blocked.html?list=blp-malware#\\0');
  assert.equal(block!.action.type, 'block');
  assert.ok(!block!.condition.resourceTypes!.includes('main_frame'));
  assert.equal(redirect!.priority, PROTECTION_PRIORITY);
  assert.ok(GUARD_FIRST_ID >= CONTINUE_FIRST_ID + CONTINUE_SLOTS || GUARD_FIRST_ID + 100 <= CONTINUE_FIRST_ID);
  assert.ok(GUARD_FIRST_ID >= PROTECTION_FIRST_ID + PROTECTION_SLOTS);
  assert.equal(warningUrl('moz-extension://x/blocked.html', 'blp-malware', 'http://a.example/p?q#f'), 'moz-extension://x/blocked.html?list=blp-malware#http://a.example/p?q#f');
});

test('DNR rules: main_frame redirect to the warning page with the URL, block for subresources, chunked', () => {
  const hosts = Array.from({ length: 25 }, (_, i) => `h${i}.example`).sort();
  const set = buildProtectionSet([{ id: 'blp-phishing', hosts }]);
  const { rules, regexRules } = protectionDnrRules(set, 'chrome-extension://abc/blocked.html', 'chrome', 10);
  assert.equal(rules.length, 6);
  assert.equal(regexRules, 3);
  assert.equal(rules[0]!.id, PROTECTION_FIRST_ID);
  const redirect = rules[0]!;
  assert.equal(redirect.priority, PROTECTION_PRIORITY);
  assert.ok(PROTECTION_PRIORITY > PRIORITY.IMPORTANT && PROTECTION_PRIORITY > PRIORITY.EXCEPTION && PROTECTION_PRIORITY < PRIORITY.ALLOWLIST);
  assert.deepEqual(redirect.condition.resourceTypes, ['main_frame']);
  assert.equal(redirect.condition.regexFilter, '^.+$');
  assert.equal(redirect.action.redirect!.regexSubstitution, 'chrome-extension://abc/blocked.html?list=blp-phishing#\\0');
  assert.equal(redirect.condition.requestDomains!.length, 10);
  const block = rules[1]!;
  assert.equal(block.action.type, 'block');
  assert.ok(!block.condition.resourceTypes!.includes('main_frame'));
  assert.deepEqual(block.condition.requestDomains, redirect.condition.requestDomains);
  // Safari: no regexFilter redirect (it ignores requestDomains there); one block rule per chunk, main frame included.
  const sr = protectionDnrRules(set, 'x', 'safari', 10);
  assert.equal(sr.regexRules, 0);
  assert.ok(sr.rules.every((r) => r.action.type === 'block' && !r.condition.regexFilter && r.condition.resourceTypes!.includes('main_frame')));
  assert.ok(!sr.rules[0]!.condition.resourceTypes!.includes('object'));
  assert.deepEqual(sr.rules[0]!.condition.requestDomains, redirect.condition.requestDomains);
  const g = guardRules(4200000, 'evil.example', 'blp-malware', 'x', 'safari');
  assert.equal(g.length, 1);
  assert.equal(g[0]!.action.type, 'block');
  assert.ok(g[0]!.condition.resourceTypes!.includes('main_frame'));
});

test('continue rule (Safari): no tabIds, content rule lists are not per tab', () => {
  const r = continueRule(4100000, 'evil.example', 7, 'safari');
  assert.equal(r.action.type, 'allow');
  assert.equal(r.condition.tabIds, undefined);
  assert.deepEqual(r.condition.requestDomains, ['evil.example']);
});

test('continue rule: session allow for the host in one tab, above protection', () => {
  const r = continueRule(4100000, 'evil.example', 7);
  assert.equal(r.action.type, 'allow');
  assert.deepEqual(r.condition.tabIds, [7]);
  assert.deepEqual(r.condition.requestDomains, ['evil.example']);
  assert.ok(r.condition.resourceTypes!.includes('main_frame'));
  assert.ok(CONTINUE_PRIORITY > PROTECTION_PRIORITY && CONTINUE_PRIORITY < PRIORITY.ALLOWLIST);
});

test('warning-page URL round trip keeps the full original URL (query and fragment)', () => {
  const orig = 'http://evil.example/login?next=/a#frag';
  assert.deepEqual(parseBlockedPageUrl(`chrome-extension://x/blocked.html?list=blp-phishing#${orig}`), { list: 'blp-phishing', url: orig });
  assert.deepEqual(parseBlockedPageUrl('moz-extension://x/blocked.html?list=a#javascript:alert(1)'), { list: 'a', url: null });
  assert.deepEqual(parseBlockedPageUrl('moz-extension://x/blocked.html'), { list: null, url: null });
});
