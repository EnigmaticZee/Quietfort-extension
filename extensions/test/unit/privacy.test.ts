// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeMajor, DEFAULT_PRIVACY, GOOGLE_DOMAINS, PRIVACY_FIRST_ID, privacyDnrRules, rewriteRequestHeaders, trimToOrigin } from '../../src/shared/privacy.ts';
import { PROTECTION_FIRST_ID } from '../../src/shared/protection.ts';

test('DNR privacy rules: GPC header, Referrer-Policy (Chrome ≥128), X-Client-Data on Google', () => {
  const rules = privacyDnrRules(DEFAULT_PRIVACY, { platform: 'chrome', chromeVersion: 157 });
  assert.equal(rules.length, 4);
  assert.ok(rules.every((r, i) => r.id === PRIVACY_FIRST_ID + i && r.id < PROTECTION_FIRST_ID));
  const gpc = rules[0]!;
  assert.deepEqual(gpc.action.requestHeaders, [{ header: 'Sec-GPC', operation: 'set', value: '1' }]);
  assert.ok(gpc.condition.resourceTypes!.includes('main_frame'));
  const [missing, weak] = [rules[1]!, rules[2]!];
  assert.deepEqual(missing.condition.excludedResponseHeaders, [{ header: 'referrer-policy' }]);
  assert.ok(weak.condition.responseHeaders![0]!.values!.includes('*unsafe-url*'));
  assert.equal(missing.action.responseHeaders![0]!.value, 'strict-origin-when-cross-origin');
  const xcd = rules[3]!;
  assert.deepEqual(xcd.action.requestHeaders, [{ header: 'X-Client-Data', operation: 'remove' }]);
  assert.ok(GOOGLE_DOMAINS.includes('google.com') && GOOGLE_DOMAINS.includes('google.co.uk') && GOOGLE_DOMAINS.includes('youtube.com'));
  assert.equal(privacyDnrRules(DEFAULT_PRIVACY, { platform: 'chrome', chromeVersion: 121 }).length, 2, 'no response-header conditions before Chrome 128');
  assert.equal(privacyDnrRules(DEFAULT_PRIVACY, { platform: 'safari', chromeVersion: 0 }).length, 1);
  assert.equal(privacyDnrRules({ gpc: false, trimReferrer: false, stripClientData: false }, { platform: 'chrome', chromeVersion: 157 }).length, 0);
  assert.equal(chromeMajor('Mozilla/5.0 ... Chrome/157.0.8103.51 Safari/537.36'), 157);
});

test('Firefox header rewrite: adds Sec-GPC, trims third-party Referer, strips X-Client-Data', () => {
  const h = [{ name: 'Referer', value: 'https://news.example/article/123?u=me' }, { name: 'Accept', value: '*/*' }];
  assert.deepEqual(rewriteRequestHeaders(h, DEFAULT_PRIVACY, true), [{ name: 'Referer', value: 'https://news.example/' }, { name: 'Accept', value: '*/*' }, { name: 'Sec-GPC', value: '1' }]);
  assert.deepEqual(rewriteRequestHeaders(h, DEFAULT_PRIVACY, false), [...h, { name: 'Sec-GPC', value: '1' }], 'first-party Referer untouched');
  assert.equal(rewriteRequestHeaders([{ name: 'Sec-GPC', value: '1' }], DEFAULT_PRIVACY, false), null);
  assert.deepEqual(rewriteRequestHeaders([{ name: 'X-Client-Data', value: 'abc' }], { gpc: false, trimReferrer: false, stripClientData: true }, true), []);
  assert.equal(trimToOrigin('https://a.example:8443/x/y'), 'https://a.example:8443/');
  assert.equal(trimToOrigin('garbage'), 'garbage');
});
