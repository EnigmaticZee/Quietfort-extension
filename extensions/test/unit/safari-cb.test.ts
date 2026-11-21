// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Filter lists → Safari content-blocker JSON (shared/safari-cb.ts). A small
// model of WebKit's content-rule evaluation (rules in order; a matching block
// sets "blocked", a matching ignore-previous-rules clears it) is compared with
// the engine's verdicts over a grid of requests. Whether WebKit accepts the
// JSON is checked separately with WebKit itself (WKContentRuleListStore) on the
// real lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Engine } from '../../src/shared/engine.ts';
import { allowlistRule, compileToDnr } from '../../src/shared/dnr.ts';
import { buildContentBlockers, redirectKeys, urlFilterToRegex, regexToWebKit, regexToWebKitAll } from '../../src/shared/safari-cb.ts';
import type { CbRule, CbResourceType } from '../../src/shared/safari-cb.ts';
import { hostOf, isThirdParty } from '../../src/shared/domain.ts';
import { RT } from '../../src/shared/types.ts';

const TYPE_TO_CB: Record<number, CbResourceType> = {
  [RT.SCRIPT]: 'script', [RT.IMAGE]: 'image', [RT.SUBDOCUMENT]: 'document', [RT.DOCUMENT]: 'document', [RT.XHR]: 'raw', [RT.STYLESHEET]: 'style-sheet', [RT.POPUP]: 'popup',
};

const reCache = new Map<string, RegExp>();
function re(src: string, cs: boolean): RegExp {
  const k = (cs ? '1' : '0') + src;
  let r = reCache.get(k);
  if (!r) reCache.set(k, (r = new RegExp(src, cs ? '' : 'i')));
  return r;
}

const domainMatch = (host: string, d: string) => (d.startsWith('*') ? host === d.slice(1) || host.endsWith(`.${d.slice(1)}`) : host === d);

interface Req { url: string; page: string; type: number }

function triggerMatches(rule: CbRule, q: Req): boolean {
  const t = rule.trigger;
  if (!re(t['url-filter'], !!t['url-filter-is-case-sensitive']).test(q.url)) return false;
  const type = TYPE_TO_CB[q.type]!;
  if (t['resource-type'] && !t['resource-type'].includes(type) && !(type === 'image' && t['resource-type'].includes('svg-document'))) return false;
  if (!t['resource-type'] && type === 'popup') return false;
  if (t['load-context']) {
    const ctx = q.type === RT.SUBDOCUMENT ? 'child-frame' : 'top-frame';
    if (q.type === RT.POPUP) return false;
    if (!t['load-context'].includes(ctx)) return false;
  }
  if (t['load-type']) {
    const tp = isThirdParty(hostOf(q.url), q.page);
    if (!t['load-type'].includes(tp ? 'third-party' : 'first-party')) return false;
  }
  if (t['if-domain'] && !t['if-domain'].some((d) => domainMatch(q.page, d))) return false;
  if (t['unless-domain']?.some((d) => domainMatch(q.page, d))) return false;
  if (t['if-top-url'] && !t['if-top-url'].some((u) => re(u, !!t['url-filter-is-case-sensitive']).test(`https://${q.page}/`))) return false;
  return true;
}

/** Longest plain run of a WebKit regex (lower case): a URL without it can't match. */
const tokenCache = new WeakMap<CbRule, string>();
function token(r: CbRule): string {
  let t = tokenCache.get(r);
  if (t === undefined) {
    const runs = r.trigger['url-filter'].replace(/\\./g, (m) => (/[a-zA-Z0-9]/.test(m[1]!) ? ' ' : m[1]!)).replace(/\[[^\]]*\]|[.*+?()^$]/g, ' ').split(' ');
    t = runs.reduce((a, b) => (b.length > a.length ? b : a), '').toLowerCase();
    tokenCache.set(r, t);
  }
  return t;
}

function simulate(list: CbRule[], q: Req): boolean {
  // WebKit matches normalised URLs (an empty path is "/").
  const url = new URL(q.url).href;
  const lurl = url.toLowerCase();
  const nq = { ...q, url };
  let blocked = false;
  for (const r of list) if (lurl.includes(token(r)) && triggerMatches(r, nq)) blocked = r.action.type === 'block';
  return blocked;
}

const FIXTURE = String.raw`
||ads.example^
||ads2.example^
||sub.ads3.example^
||tracker.example^$third-party
||cdn.example/ads/
/banner/*/img^
|https://exact.example/ad.js|
||cdn2.example/x.js$script,domain=news.example|~blog.news.example
@@||ads.example/allowed/$image
||important.example^$important
@@||important.example^
@@||trusted-page.example^$document
/ad[0-9][0-9][0-9]\.js/
||firstparty.example/t.gif$~third-party
||imgonly.example^$image
||notscript.example^$~script
||redir.example/gpt.js$script,redirect=googletagservices_gpt.js
@@||ads2.example^$domain=friend.example
||popup-only.example^$popup
||popunder.example^$popup,third-party
$script,domain=scriptfree.example
||frames.example^$subdocument
||denied.example^$denyallow=ok.denied.example
/smartpop/$document
||entity-ads.example^$domain=pirate.*
/^https:\/\/[a-z]{3,5}\.(cfd|click)\/\d{2,}\.js$/$script
`;

const URLS = [
  'https://ads.example/x.js', 'https://a.ads.example/b.png', 'https://ads.example/allowed/i.png', 'https://ads.example/allowed/i.js',
  'https://ads2.example/q', 'https://sub.ads3.example/q', 'https://ads3.example/q', 'https://tracker.example/t.js',
  'https://www.tracker.example/p', 'https://cdn.example/ads/a.js', 'https://cdn.example/other.js', 'https://x.example/banner/1/img?x',
  'https://x.example/banner/1/img.png', 'https://exact.example/ad.js', 'https://exact.example/ad.js?x', 'https://cdn2.example/x.js',
  'https://important.example/i.js', 'https://x.example/ad123.js', 'https://x.example/ad12.js', 'https://firstparty.example/t.gif',
  'https://imgonly.example/a.png', 'https://imgonly.example/a.js', 'https://notscript.example/a.js', 'https://notscript.example/a.png',
  'https://popup-only.example/x', 'https://popunder.example/go', 'https://anything.example/s.js', 'https://frames.example/f',
  'https://denied.example/a.js', 'https://ok.denied.example/a.js', 'https://ads.example', 'https://ads.example:8443/x',
  'https://notads.example/x', 'https://ads.example.evil/x',
  'https://land.example/smartpop/x', 'https://entity-ads.example/a.js', 'https://abcd.cfd/123.js', 'https://abcd.click/12.js', 'https://abcd.com/12.js',
];
const PAGES = ['pirate.com', 'pirate.to', 'news.example', 'blog.news.example', 'firstparty.example', 'www.tracker.example', 'trusted-page.example', 'friend.example', 'scriptfree.example', 'other.example'];
const TYPES = [RT.SCRIPT, RT.IMAGE, RT.SUBDOCUMENT, RT.XHR, RT.POPUP, RT.DOCUMENT];

function crossCheck(engine: Engine, lists: CbRule[][], urls: string[], pages: string[], types: number[], skipUrls = new Set<string>()) {
  const mismatches: string[] = [];
  let n = 0;
  let blocks = 0;
  for (const url of urls) for (const page of pages) for (const type of types) {
    if (skipUrls.has(url)) continue;
    n++;
    const ev = engine.check({ url, sourceHost: page, type }).action === 'block';
    // Content blockers are independent: blocked if any of them blocks.
    const cv = lists.some((l) => simulate(l, { url, page, type }));
    if (ev) blocks++;
    if (ev !== cv) mismatches.push(`${url} on ${page} type ${TYPE_TO_CB[type]}: engine=${ev} content-blocker=${cv}`);
  }
  return { n, blocks, mismatches };
}

test('urlFilterToRegex: anchors, separators, wildcards, escaping', () => {
  assert.equal(urlFilterToRegex('||ads.example^'), '^[^:]+:(//)?([^/]+\\.)?ads\\.example([^a-zA-Z0-9_.%-].*)?$');
  assert.equal(urlFilterToRegex('|https://a.b/c.js|'), '^https://a\\.b/c\\.js$');
  assert.equal(urlFilterToRegex('/banner/*/img^'), '/banner/.*/img([^a-zA-Z0-9_.%-].*)?$');
  assert.equal(urlFilterToRegex('*ad*'), 'ad');
  assert.equal(urlFilterToRegex('a(b)+c?{d}'), 'a\\(b\\)\\+c\\?\\{d\\}');
  assert.equal(urlFilterToRegex('é'), null);
});

test('regexToWebKit: rewrites what it can, refuses the rest', () => {
  assert.equal(regexToWebKit('ad\\d+\\.js'), 'ad[0-9]+\\.js');
  assert.equal(regexToWebKit('^https?:\\/\\/x[\\w-]+\\.com\\/'), '^https?://x[a-zA-Z0-9_-]+\\.com/');
  assert.equal(regexToWebKit('(?:a|b)'), null);
  assert.equal(regexToWebKit('ad{2}'), 'add');
  assert.equal(regexToWebKit('\\d{2,4}x'), '[0-9][0-9][0-9]?[0-9]?x');
  assert.equal(regexToWebKit('a{2,}'), 'aaa*');
  assert.equal(regexToWebKit('(ab){2}'), null);
  assert.equal(regexToWebKit('a{500}'), null);
  assert.equal(regexToWebKit('(?=x)'), null);
  assert.equal(regexToWebKit('\\bads'), null);
  assert.equal(regexToWebKit('(?:ab)+c'), '(ab)+c');
});

test('regexToWebKitAll: alternation becomes several patterns', () => {
  assert.deepEqual(regexToWebKitAll('^https?:\\/\\/[a-z]{3}\\.(cfd|click)\\/\\d{2}$'), [
    '^https?://[a-z][a-z][a-z]\\.(cfd)/[0-9][0-9]$',
    '^https?://[a-z][a-z][a-z]\\.(click)/[0-9][0-9]$',
  ]);
  assert.deepEqual(regexToWebKitAll('ads|track'), ['ads', 'track']);
  assert.equal(regexToWebKitAll('((a|b)c|d)'), null);
  assert.equal(regexToWebKitAll('(?=x)a'), null);
  // Every expansion matches exactly what the original matches.
  const src = '^https?:\\/\\/[a-z]{4,6}\\.(?:top|xyz)\\/\\d{3,}\\.js$';
  const all = regexToWebKitAll(src)!.map((r) => new RegExp(r));
  const orig = new RegExp(src);
  for (const u of ['https://abcd.top/123.js', 'http://abcdef.xyz/12345.js', 'https://abc.top/123.js', 'https://abcdefg.top/123.js', 'https://abcd.top/12.js', 'https://abcd.com/123.js']) {
    assert.equal(all.some((r) => r.test(u)), orig.test(u), u);
  }
});

test('content-blocker rules agree with the engine on a request grid (popups included)', () => {
  const engine = Engine.fromLists([FIXTURE]);
  const r = buildContentBlockers(engine.networkRules, { blockers: 1 });
  assert.equal(r.stats.overflow, 0);
  assert.ok(r.stats.popupRules >= 2);
  const { n, blocks, mismatches } = crossCheck(engine, r.lists, URLS, PAGES, TYPES);
  assert.ok(n > 1000);
  assert.ok(blocks > 150 && blocks < n - 150, `non-trivial grid: ${blocks}/${n} blocked`);
  assert.deepEqual(mismatches, []);
});

test('rules shared out over several content blockers give the same verdicts', () => {
  const engine = Engine.fromLists([FIXTURE]);
  const one = buildContentBlockers(engine.networkRules, { blockers: 1 });
  const exceptions = one.stats.exceptionRules;
  const split = buildContentBlockers(engine.networkRules, { blockers: 4, perBlocker: exceptions + 6 });
  assert.equal(split.stats.overflow, Math.max(0, one.stats.blockRules - 4 * 6));
  const full = buildContentBlockers(engine.networkRules, { blockers: 20, perBlocker: exceptions + 6 });
  assert.equal(full.stats.overflow, 0);
  for (const l of full.lists) assert.ok(l.length <= exceptions + 6);
  const { mismatches } = crossCheck(engine, full.lists.filter((l) => l.some((r) => r.action.type === 'block')), URLS, PAGES, TYPES);
  assert.deepEqual(mismatches, []);
});

test('sites turned off: nothing is blocked on them', () => {
  const engine = Engine.fromLists([FIXTURE]);
  const allow = allowlistRule(['news.example'])!;
  const r = buildContentBlockers(engine.networkRules, { blockers: 1, extraDnr: [allow] });
  for (const url of URLS) for (const type of TYPES) {
    assert.equal(simulate(r.lists[0]!, { url, page: 'news.example', type }), false, url);
    assert.equal(simulate(r.lists[0]!, { url, page: 'blog.news.example', type }), false, url);
  }
  assert.equal(simulate(r.lists[0]!, { url: 'https://ads.example/x.js', page: 'other.example', type: RT.SCRIPT }), true);
});

test('a $redirect the web extension does not have installed is blocked by the content blockers', () => {
  const list = '||ads.example/adsbygoogle.js$script,redirect=googlesyndication_adsbygoogle.js\n||ads.example^\n||site.example/fix.js$script,redirect=noop.js,domain=fixed.example';
  const engine = Engine.fromLists([list]);
  const q = { url: 'https://ads.example/adsbygoogle.js', page: 'news.example', type: RT.SCRIPT };
  // Installed in DNR: the content blocker lets it through for the stub swap.
  const dnr = compileToDnr(engine.networkRules, { platform: 'safari' });
  const installed = new Set(dnr.dynamic.flatMap((r) => redirectKeys(r)));
  assert.equal(installed.size, 2);
  const withStub = buildContentBlockers(engine.networkRules, { blockers: 1, dnrRedirects: installed });
  assert.equal(simulate(withStub.lists[0]!, q), false);
  assert.equal(withStub.stats.redirectsBlocked ?? 0, 0);
  // Not installed (Safari's rule cap): blocked outright, never let through.
  const none = buildContentBlockers(engine.networkRules, { blockers: 1, dnrRedirects: new Set() });
  assert.equal(simulate(none.lists[0]!, q), true);
  assert.equal(simulate(none.lists[0]!, { url: 'https://site.example/fix.js', page: 'fixed.example', type: RT.SCRIPT }), true);
  assert.equal(simulate(none.lists[0]!, { url: 'https://site.example/fix.js', page: 'other.example', type: RT.SCRIPT }), false);
  assert.equal(none.stats.redirectsBlocked, 2);
});

test('Safari DNR: stub redirects are installed before exceptions and blocks when room is short', () => {
  const exceptions = Array.from({ length: 50 }, (_, i) => `@@||site${i}.example/ok.js$script`).join('\n');
  const blocks = Array.from({ length: 50 }, (_, i) => `||block${i}.example^`).join('\n');
  const engine = Engine.fromLists([`${exceptions}\n${blocks}`, '||ads.example/gpt.js$script,redirect=googletagservices_gpt.js']);
  const limits = { dynamic: 11, dynamicUnsafe: 11, session: 0, sessionUnsafe: 0, regex: 100 } as Parameters<typeof compileToDnr>[1] extends infer O ? O extends { limits?: infer L } ? L : never : never;
  const safari = compileToDnr(engine.networkRules, { platform: 'safari', limits, tierOf: (i) => engine.networkRuleList[i]! });
  assert.ok(safari.dynamic.some((r) => r.action.type === 'redirect'), 'redirect installed on Safari');
  const chrome = compileToDnr(engine.networkRules, { platform: 'chrome', limits, tierOf: (i) => engine.networkRuleList[i]! });
  assert.ok(!chrome.dynamic.some((r) => r.action.type === 'redirect'), 'Chrome keeps exceptions first');
});

test('primary lists fill the content blockers first', () => {
  const engine = Engine.fromLists(['||primary1.example^\n||primary2.example^', '||optional1.example^\n||optional2.example^']);
  const tier = (i: number) => engine.networkRuleList[i]!;
  const r = buildContentBlockers(engine.networkRules, { blockers: 1, perBlocker: 4, tierOf: tier });
  const text = JSON.stringify(r.lists);
  assert.ok(text.includes('primary1') && text.includes('primary2'));
  assert.ok(r.stats.overflow > 0);
});

test('real EasyList + EasyPrivacy (dev-data, if present): content blockers agree with the engine on sampled rules', { skip: !existsSync(new URL('../../../dev-data/easylist.txt', import.meta.url)) }, () => {
  const lists = ['easylist.txt', 'easyprivacy.txt'].map((f) => readFileSync(new URL(`../../../dev-data/${f}`, import.meta.url), 'utf8'));
  const engine = Engine.fromLists(lists);
  const r = buildContentBlockers(engine.networkRules, { blockers: 3 });
  assert.equal(r.stats.overflow, 0);
  const urls: string[] = [];
  const hostRules = engine.networkRules.filter((x) => x.pureHost && !x.exception && !x.includeDomains.length);
  for (let i = 0; i < hostRules.length; i += Math.ceil(hostRules.length / 150)) urls.push(`https://www.${hostRules[i]!.pureHost}/x/y.js?z=1`);
  const pathRules = engine.networkRules.filter((x) => x.pattern.kind === 'glob' && x.pattern.anchor === 'host' && !x.pureHost && !x.exception && !x.pattern.body.includes('*') && !x.pattern.body.includes('^') && !x.includeDomains.length);
  for (let i = 0; i < pathRules.length; i += Math.ceil(pathRules.length / 150)) {
    const p = pathRules[i]!.pattern as { body: string };
    urls.push(`https://${p.body}${p.body.includes('?') ? '&' : '?'}v=1`);
  }
  urls.push('https://example.com/', 'https://www.wikipedia.org/static/app.js', 'https://cdn.jsdelivr.net/npm/react/index.js');
  const lists2 = r.lists.filter((l) => l.some((x) => x.action.type === 'block'));
  const { n, blocks, mismatches } = crossCheck(engine, lists2, urls, ['example.com', 'news.ycombinator.com'], [RT.SCRIPT, RT.IMAGE, RT.XHR]);
  assert.ok(n > 1000, `checked ${n}`);
  assert.ok(blocks > n / 3, `non-trivial: ${blocks}/${n} blocked`);
  assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} mismatches of ${n}`);
});
