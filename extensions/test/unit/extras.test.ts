// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestByWords, describeWords, readDescribeAnswer, shortlist, describePrompt } from '../../src/shared/describe.ts';
import type { BlockSummary } from '../../src/shared/describe.ts';
import { readBackup, checkRules, BACKUP_FORMAT } from '../../src/shared/backup.ts';
import { allowlistRule } from '../../src/shared/dnr.ts';
import { parseLine } from '../../src/shared/parse.ts';

const vp = { w: 1280, h: 800 };
const blk = (p: Partial<BlockSummary>): BlockSummary => ({ tag: 'div', id: '', classes: [], attrs: [], text: '', w: 300, h: 200, x: 0, y: 0, fixed: false, ...p });

const page: BlockSummary[] = [
  blk({ tag: 'div', id: 'page', w: 1280, h: 5000, text: 'Home News Sport Subscribe to our newsletter Chat with us Latest headlines' }),
  blk({ tag: 'header', classes: ['site-header'], w: 1280, h: 80, text: 'Home News Sport' }),
  blk({ tag: 'article', classes: ['story'], w: 800, h: 3000, text: 'Latest headlines from today. The council said it would subscribe to the plan.' }),
  blk({ tag: 'div', classes: ['nl-modal', 'overlay'], attrs: ['role=dialog', 'aria-modal=true'], w: 500, h: 360, fixed: true, text: 'Subscribe to our newsletter Get the best stories in your inbox Sign up' }),
  blk({ tag: 'div', id: 'intercom-container', classes: ['intercom-launcher'], w: 60, h: 60, fixed: true, text: '' }),
  blk({ tag: 'aside', classes: ['rail'], w: 300, h: 1200, text: 'Most read Trending now' }),
  blk({ tag: 'div', classes: ['OUTBRAIN'], w: 800, h: 600, text: 'Around the web: you may like' }),
];

test('describe: words, synonyms and plurals', () => {
  const w = describeWords('Hide the annoying newsletter pop-ups please');
  assert.deepEqual(w.map((x) => x.word), ['newsletter', 'popup']);
  assert.ok(w[1]!.alts.includes('modal'));
});

test('describe: word matching picks the whole widget, not the article', () => {
  assert.equal(bestByWords(page, 'newsletter popup', vp), 3);
  assert.equal(bestByWords(page, 'chat bubble', vp), 4);
  assert.equal(bestByWords(page, 'recommended stories from other sites', vp), 6);
  assert.equal(bestByWords(page, 'sidebar', vp), 5);
  // Nothing like it on the page.
  assert.equal(bestByWords(page, 'weather widget', vp), -1);
  assert.equal(bestByWords(page, '', vp), -1);
});

test('describe: model shortlist, prompt and answer', () => {
  const order = shortlist(page, 'newsletter popup', vp, 4);
  assert.equal(order[0], 3);
  assert.equal(order.length, 4);
  const prompt = describePrompt('newsletter popup', page, order);
  assert.match(prompt, /^Hide: newsletter popup/);
  assert.match(prompt, /0\. <div> \.nl-modal/);
  assert.equal(readDescribeAnswer({ index: 0 }, order), 3);
  assert.equal(readDescribeAnswer({ index: -1 }, order), -1);
  assert.equal(readDescribeAnswer({ index: 9 }, order), -1);
  assert.equal(readDescribeAnswer(null, order), -1);
});

test('pause everywhere: one allow-all rule; normal list unchanged', () => {
  const r = allowlistRule(['example.com', '*'])!;
  assert.equal(r.action.type, 'allowAllRequests');
  assert.equal(r.condition.requestDomains, undefined);
  assert.deepEqual(r.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.deepEqual(allowlistRule(['example.com'])!.condition.requestDomains, ['example.com']);
});

test('backup: round trip and refusal of bad input', () => {
  const good = {
    format: BACKUP_FORMAT, version: 1, exportedAt: '2026-11-20T00:00:00Z', theme: 'fortNight',
    settings: {
      disabledSites: ['example.com', 'Bad Site!', '*'], userFilters: '||ads.example^\nexample.com##.promo', cookieBanners: false,
      lists: { easylist: true, 'x': 'yes' }, customLists: [{ id: 'c1', url: 'https://lists.example/f.txt', name: 'F', enabled: true, kind: 'filters' }, { id: 'c2', url: 'http://insecure/x', name: 'x' }],
      privacy: { gpc: true, evil: true }, ai: { scam: true },
    },
    picker: [{ id: 'p1', site: 'news.example', selectors: ['.nl-modal'], counts: [1], active: 0, fingerprint: { tag: 'div', text: 'x', rect: null }, createdAt: 1 }, { site: 'x.example', selectors: [] }],
    exceptions: [
      { id: 'e1', kind: 'network', site: 'shop.example', rule: '||cdn.example^', lines: ['@@||cdn.example^$domain=shop.example'], createdAt: 1, expiresAt: null, reason: 'fix' },
      { id: 'e2', site: 'shop.example', rule: 'bad', lines: ['||evil.example^'] },
    ],
  };
  const r = readBackup(JSON.stringify(good));
  assert.ok(r.backup);
  const b = r.backup!;
  assert.deepEqual(b.settings.disabledSites, ['example.com']);
  assert.equal(b.settings.cookieBanners, false);
  assert.deepEqual(b.settings.lists, { easylist: true });
  assert.equal(b.settings.customLists.length, 1);
  assert.deepEqual(b.settings.privacy, { gpc: true });
  assert.equal(b.picker.length, 1);
  assert.equal(b.exceptions.length, 1, 'an "exception" that blocks something is refused');
  assert.equal(b.theme, 'fortNight');
  assert.ok(r.skipped.length >= 4);
  assert.equal(readBackup('nope').backup, null);
  assert.equal(readBackup(JSON.stringify({ format: 'other' })).backup, null);
  assert.equal(readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99 })).backup, null);
});

test('My Rules check counts rules and reports unusable lines', () => {
  const c = checkRules('! comment\n||ads.example^\nexample.com##.banner\n\nexample.com##^script:has-text(ad)\n', (l) => parseLine(l) as { kind: string; reason?: string });
  assert.equal(c.rules, 2);
  assert.equal(c.problems.length, 1);
  assert.equal(c.problems[0]!.line, 5);
});
