// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Cookie-banner helpers: per-frame rule trimming (checked against
// autoconsent's own filterCompactRules, imported here for the test only) and
// the consent-platform markers; the host's fixed opt-out configuration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { filterCompactRules } from '@duckduckgo/autoconsent';
import { hasSiteFrameRule, markerMatcher, rulesFor } from '../../src/shared/consent.ts';
import type { IndexedRuleset } from '../../src/shared/consent.ts';

const require = createRequire(import.meta.url);
const rules = require('@duckduckgo/autoconsent/rules/compact-rules.json') as IndexedRuleset;
const markersText = readFileSync(new URL('../../page-runtime/assets/consent-markers.txt', import.meta.url), 'utf8');
const hostSrc = readFileSync(new URL('../../page-runtime/assets/consent-host.js', import.meta.url), 'utf8');
const fixture = (n: string) => readFileSync(new URL(`../../page-runtime/tests/consent-fixtures/${n}`, import.meta.url), 'utf8');

const URLS = [
  'https://plain.example/',
  'https://www.theguardian.com/uk',
  'https://www.dropbox.com/',
  'https://help.dropbox.com/x',
  'https://www.figma.com/files',
  'https://cmp-consent-tool.privacymanager.io/notice',
  'https://cookielaw.emea.fcagroup.com/x',
  'https://www.coinbase.com/',
  'https://www.tumblr.com/explore',
];

test('rulesFor matches autoconsent filterCompactRules for main frames and iframes', () => {
  for (const url of URLS) {
    for (const mainFrame of [true, false]) {
      const ours = rulesFor(rules, url, mainFrame);
      const theirs = filterCompactRules(rules as never, { url, mainFrame });
      assert.deepEqual(ours.r.map((r) => r[1]), theirs.r.map((r) => r[1]), `${url} main=${mainFrame}`);
      assert.deepEqual(ours.s, theirs.s, `strings for ${url} main=${mainFrame}`);
      assert.equal(ours.v, theirs.v);
    }
  }
});

test('rulesFor: generic main-frame bundle has no site rules, site rules where they apply', () => {
  const g = rulesFor(rules, 'https://plain.example/', true);
  assert.ok(g.r.length > 100);
  assert.ok(g.r.some((r) => r[1] === 'didomi'));
  assert.ok(!g.r.some((r) => r[1].startsWith('auto_')));
  const fig = rulesFor(rules, 'https://www.figma.com/files', true);
  assert.ok(fig.r.some((r) => r[1] === 'figma'));
});

test('iframes: only consent-platform frames have site frame rules', () => {
  assert.ok(hasSiteFrameRule(rules, 'https://cmp-consent-tool.privacymanager.io/notice'));
  assert.ok(!hasSiteFrameRule(rules, 'https://ads.example/frame.html'));
  assert.ok(!hasSiteFrameRule(rules, 'https://www.youtube.com/embed/x'));
});

test('markers: consent platforms yes, ordinary pages no', () => {
  const m = markerMatcher(markersText);
  for (const s of ['https://cdn.privacy-mgmt.com/index.html?message_id=1', 'https://consent.trustarc.com/notice', 'https://x.consensu.org/', fixture('onetrust.html'), fixture('didomi.html')]) {
    assert.ok(m.test(s), s.slice(0, 80));
  }
  for (const s of ['https://www.youtube.com/embed/x', 'https://ads.example/frame.html', fixture('no-cmp.html')]) {
    assert.ok(!m.test(s), s.slice(0, 80));
  }
});

test('host: opt-out only, no heuristics, no string eval', () => {
  assert.match(hostSrc, /autoAction: 'optOut'/);
  assert.doesNotMatch(hostSrc, /type: 'optIn'|autoAction: 'optIn'/);
  assert.match(hostSrc, /heuristicMode: 'off'/);
  assert.match(hostSrc, /enableHeuristicDetection: false/);
  assert.doesNotMatch(hostSrc, /\beval\(|new Function/);
});

test('host answers init with rules and config, refuses eval', async () => {
  const sent: unknown[] = [];
  const w: Record<string, unknown> = {
    postMessage: (m: unknown) => sent.push(m),
    autoconsentReceiveMessage: undefined,
  };
  const doc = { currentScript: null, querySelector: () => null, getElementById: () => null, readyState: 'complete' };
  const host = new Function('window', 'document', 'setTimeout', `return (${hostSrc.trim()}\n);`)(w, doc, () => 0) as (cfg: unknown) => void;
  host({ rules: { v: 1, s: [], r: [] }, notify: true });
  assert.equal(typeof w.autoconsentSendMessage, 'function');
  const got: Array<Record<string, unknown>> = [];
  w.autoconsentReceiveMessage = async (m: Record<string, unknown>) => { got.push(m); };
  await (w.autoconsentSendMessage as (m: unknown) => Promise<void>)({ type: 'init', url: 'https://x/' });
  await (w.autoconsentSendMessage as (m: unknown) => Promise<void>)({ type: 'eval', id: 'e1', code: 'alert(1)' });
  await (w.autoconsentSendMessage as (m: unknown) => Promise<void>)({ type: 'optOutResult', cmp: 'Onetrust', result: true });
  await new Promise((r) => setTimeout(r, 0));
  const init = got.find((m) => m.type === 'initResp') as { config: Record<string, unknown>; rules: unknown };
  assert.equal(init.config.autoAction, 'optOut');
  assert.equal(init.config.isMainWorld, true);
  assert.deepEqual(init.rules, { autoconsent: [], compact: { v: 1, s: [], r: [] } });
  assert.deepEqual(got.find((m) => m.type === 'evalResp'), { type: 'evalResp', id: 'e1', result: false });
  assert.deepEqual(sent, [{ __adbConsent: 1, type: 'optOutResult', cmp: 'Onetrust', result: true, cosmetic: false, clicks: null }]);
});

test('Sourcepoint message iframes are recognised by URL', async () => {
  const { isSourcepointFrameUrl } = await import('../../src/shared/consent.ts');
  assert.ok(isSourcepointFrameUrl('https://sp-spiegel-de.spiegel.de/index.html?message_id=123&consentUUID=x'));
  assert.ok(isSourcepointFrameUrl('https://cdn.privacy-mgmt.com/privacy-manager/index.html?message_id=1'));
  assert.ok(isSourcepointFrameUrl('https://ccpa-notice.sp-prod.net/?message_id=1'));
  assert.ok(!isSourcepointFrameUrl('https://www.spiegel.de/index.html'));
  assert.ok(!isSourcepointFrameUrl('https://player.example/index.html?video=1'));
});

test('host refuses consent-or-pay clicks only while opting out', async () => {
  const clicks: string[] = [];
  class El {
    innerText: string;
    constructor(t: string) { this.innerText = t; }
    getAttribute() { return null; }
    click() { clicks.push(this.innerText); }
  }
  const sent: Array<Record<string, unknown>> = [];
  const w: Record<string, unknown> = { HTMLElement: El, postMessage: (m: Record<string, unknown>) => sent.push(m) };
  const doc = { currentScript: null, querySelector: () => null, getElementById: () => null, readyState: 'complete' };
  const host = new Function('window', 'document', 'setTimeout', `return (${hostSrc.trim()}\n);`)(w, doc, () => 0) as (cfg: unknown) => void;
  host({ rules: { v: 1, s: [], r: [] }, notify: true });
  const send = w.autoconsentSendMessage as (m: unknown) => Promise<void>;
  const pay = new El('Already subscribed? Sign in');
  const reject = new El('Reject all');
  pay.click();
  assert.deepEqual(clicks, ['Already subscribed? Sign in'], 'page clicks untouched outside opt-out');
  await send({ type: 'report', state: { lifecycle: 'runningOptOut' } });
  pay.click();
  new El('Rifiuta e abbonati').click();
  new El('Refuser et payer 2 €').click();
  reject.click();
  new El('Display options').click();
  await send({ type: 'report', state: { lifecycle: 'optOutSucceeded' } });
  pay.click();
  assert.deepEqual(clicks, ['Already subscribed? Sign in', 'Reject all', 'Display options', 'Already subscribed? Sign in']);
  assert.equal(sent.filter((m) => m.type === 'clickRefused').length, 3);
  assert.equal(El.prototype.click.name, 'click', 'native click restored');
});
