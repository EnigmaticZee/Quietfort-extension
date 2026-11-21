// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Filter-list catalogue: defaults, language suggestions, custom-URL validation,
// and the licensing constraints (no non-commercial lists, https only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, customListId, customListUrlProblem, isListEnabled, primaryLangs, suggestedFor } from '../../src/shared/catalogue.ts';

const on = (id: string, langs: string[] = ['en-US'], choices: Record<string, boolean> = {}) => isListEnabled(CATALOGUE.find((e) => e.id === id)!, choices, langs);

test('defaults: EasyList, EasyPrivacy, cookie list and protection (full malware list included) on; annoyances, social, optional lists off', () => {
  for (const id of ['easylist', 'easyprivacy', 'easylist-cookie', 'blp-phishing', 'blp-scam', 'blp-fraud', 'blp-ransomware', 'blp-malware']) assert.equal(on(id), true, id);
  for (const id of ['fanboy-annoyance', 'fanboy-social', 'nocoin', '1hosts-lite']) assert.equal(on(id), false, id);
});

test('regional lists: suggested (and on) for the browser language only', () => {
  assert.deepEqual(primaryLangs(['de-CH', 'de', 'en-US', 'fr']), ['de', 'en', 'fr']);
  assert.deepEqual(suggestedFor(['en-US']), []);
  assert.deepEqual(suggestedFor(['de-DE', 'en']), ['easylist-germany']);
  assert.deepEqual(suggestedFor(['pt-BR', 'es']).sort(), ['easylist-portuguese', 'easylist-spanish']);
  assert.equal(on('easylist-germany', ['de-DE']), true);
  assert.equal(on('easylist-germany', ['en-US']), false);
  assert.equal(on('easylist-germany', ['de-DE'], { 'easylist-germany': false }), false, 'user choice wins');
  assert.equal(on('fanboy-social', ['en'], { 'fanboy-social': true }), true);
});

test('every entry is https, has a licence, and no non-commercial source is listed', () => {
  const banned = /pgl\.yoyo|someonewhocares|disconnect\.me|tracker-radar|urlhaus|abuse\.ch|openphish|phishtank/i;
  const ids = new Set<string>();
  for (const e of CATALOGUE) {
    assert.ok(e.url.startsWith('https://'), e.id);
    assert.ok(e.license.length > 2, e.id);
    assert.ok(!banned.test(e.url) && !banned.test(e.homepage), e.id);
    assert.ok(!ids.has(e.id), `duplicate ${e.id}`);
    ids.add(e.id);
  }
  assert.ok(CATALOGUE.filter((e) => e.kind === 'protection').every((e) => e.url.startsWith('https://blocklistproject.github.io/Lists/')));
});

test('custom list URLs: https only, real hostname, no credentials', () => {
  assert.equal(customListUrlProblem('https://example.com/list.txt'), null);
  assert.match(customListUrlProblem('http://example.com/list.txt')!, /https/);
  assert.match(customListUrlProblem('ftp://example.com/x')!, /https/);
  assert.match(customListUrlProblem('javascript:alert(1)')!, /https/);
  assert.match(customListUrlProblem('https://user:pw@example.com/x')!, /credentials/);
  assert.match(customListUrlProblem('https://localhost/x')!, /domain|local/);
  assert.match(customListUrlProblem('https://192.168.1.1/x')!, /domain/);
  assert.match(customListUrlProblem('not a url')!, /valid/);
  assert.equal(customListId('https://a.example/x'), customListId('https://a.example/x'));
  assert.notEqual(customListId('https://a.example/x'), customListId('https://a.example/y'));
});
