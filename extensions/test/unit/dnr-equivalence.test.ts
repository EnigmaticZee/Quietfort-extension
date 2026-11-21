// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Cross-check: evaluate the compiled DNR rules with a small model of Chrome's
// DNR matching (priority, action precedence, allowAllRequests, requestDomains,
// initiatorDomains, domainType, resourceTypes) and compare against the
// engine's verdicts over a grid of requests. This checks merging, priorities
// and condition translation; the real browser behaviour is covered by the
// Chrome end-to-end test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Engine } from '../../src/shared/engine.ts';
import { compileToDnr } from '../../src/shared/dnr.ts';
import type { DnrRule, ResourceTypeName } from '../../src/shared/dnr.ts';
import { compilePattern, hostRange } from '../../src/shared/pattern.ts';
import { hostMatches, hostOf, isThirdParty } from '../../src/shared/domain.ts';
import { RT } from '../../src/shared/types.ts';

const TYPE_TO_DNR: Record<number, ResourceTypeName> = {
  [RT.DOCUMENT]: 'main_frame', [RT.SUBDOCUMENT]: 'sub_frame', [RT.SCRIPT]: 'script', [RT.STYLESHEET]: 'stylesheet',
  [RT.IMAGE]: 'image', [RT.FONT]: 'font', [RT.MEDIA]: 'media', [RT.XHR]: 'xmlhttprequest', [RT.WEBSOCKET]: 'websocket',
  [RT.PING]: 'ping', [RT.OBJECT]: 'object', [RT.OTHER]: 'other',
};

function urlFilterMatches(filter: string, url: string): boolean {
  let anchor: 'none' | 'host' | 'start' = 'none';
  let body = filter;
  if (body.startsWith('||')) { anchor = 'host'; body = body.slice(2); } else if (body.startsWith('|')) { anchor = 'start'; body = body.slice(1); }
  let end = false;
  if (body.endsWith('|')) { end = true; body = body.slice(0, -1); }
  const lurl = url.toLowerCase();
  const [hs, he] = hostRange(lurl);
  return compilePattern({ kind: 'glob', anchor, endAnchor: end, body: body.toLowerCase() }, false).matches(lurl, hs, he);
}

const reCache = new Map<string, RegExp>();
function regex(src: string, cs: boolean): RegExp {
  const k = (cs ? '1' : '0') + src;
  let re = reCache.get(k);
  if (!re) reCache.set(k, (re = new RegExp(src, cs ? '' : 'i')));
  return re;
}

interface SimReq { url: string; initiator: string | null; type: ResourceTypeName }

function condMatches(r: DnrRule, q: SimReq): boolean {
  const c = r.condition;
  const host = hostOf(q.url);
  const types = c.resourceTypes ?? (['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'] as ResourceTypeName[]);
  if (!types.includes(q.type)) return false;
  if (c.urlFilter && !urlFilterMatches(c.urlFilter, q.url)) return false;
  if (c.regexFilter && !regex(c.regexFilter, !!c.isUrlFilterCaseSensitive).test(q.url)) return false;
  if (c.requestDomains && !c.requestDomains.some((d) => hostMatches(host, d))) return false;
  if (c.excludedRequestDomains?.some((d) => hostMatches(host, d))) return false;
  if (c.initiatorDomains && !(q.initiator && c.initiatorDomains.some((d) => hostMatches(q.initiator!, d)))) return false;
  if (q.initiator && c.excludedInitiatorDomains?.some((d) => hostMatches(q.initiator!, d))) return false;
  if (c.domainType) {
    const tp = q.initiator ? isThirdParty(host, q.initiator) : false;
    if ((c.domainType === 'thirdParty') !== tp) return false;
  }
  return true;
}

const RANK: Record<string, number> = { allow: 5, allowAllRequests: 4, block: 3, upgradeScheme: 2, redirect: 1, modifyHeaders: 0 };

/** Outcome for a subresource request on a page whose top document is `https://<page>/`. */
function simulate(rules: DnrRule[], q: SimReq, page: string | null): 'block' | 'allow' | 'none' {
  let best: DnrRule | null = null;
  const consider = (r: DnrRule) => {
    if (r.action.type === 'modifyHeaders') return;
    if (!best || r.priority > best.priority || (r.priority === best.priority && RANK[r.action.type]! > RANK[best.action.type]!)) best = r;
  };
  for (const r of rules) {
    if (r.action.type === 'allowAllRequests') continue;
    if (condMatches(r, q)) consider(r);
  }
  // allowAllRequests matched by the page's main_frame request applies to everything in it.
  if (page) {
    const doc: SimReq = { url: `https://${page}/`, initiator: null, type: 'main_frame' };
    for (const r of rules) if (r.action.type === 'allowAllRequests' && condMatches(r, doc)) consider(r);
  }
  if (!best) return 'none';
  const t = (best as DnrRule).action.type;
  if (t === 'block' || (t === 'redirect' && (best as DnrRule).action.redirect?.extensionPath)) return 'block';
  if (t === 'allow' || t === 'allowAllRequests') return 'allow';
  return 'none';
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
/ad[0-9]{3}\.js/
||firstparty.example/t.gif$~third-party
||imgonly.example^$image
||notscript.example^$~script
||redir.example/gpt.js$script,redirect=googletagservices_gpt.js
@@||ads2.example^$domain=friend.example
||popup-only.example^$popup
$script,domain=scriptfree.example
||frames.example^$subdocument
`;

const URLS = [
  'https://ads.example/x.js', 'https://a.ads.example/b.png', 'https://ads.example/allowed/i.png', 'https://ads.example/allowed/i.js',
  'https://ads2.example/q', 'https://sub.ads3.example/q', 'https://ads3.example/q', 'https://tracker.example/t.js',
  'https://www.tracker.example/p', 'https://cdn.example/ads/a.js', 'https://cdn.example/other.js', 'https://x.example/banner/1/img?x',
  'https://x.example/banner/1/img.png', 'https://exact.example/ad.js', 'https://exact.example/ad.js?x', 'https://cdn2.example/x.js',
  'https://important.example/i.js', 'https://x.example/ad123.js', 'https://x.example/ad12.js', 'https://firstparty.example/t.gif',
  'https://imgonly.example/a.png', 'https://imgonly.example/a.js', 'https://notscript.example/a.js', 'https://notscript.example/a.png',
  'https://redir.example/gpt.js', 'https://popup-only.example/x', 'https://anything.example/s.js', 'https://frames.example/f',
];
const SOURCES = ['news.example', 'blog.news.example', 'firstparty.example', 'www.tracker.example', 'trusted-page.example', 'friend.example', 'scriptfree.example', 'other.example'];
const TYPES = [RT.SCRIPT, RT.IMAGE, RT.SUBDOCUMENT, RT.XHR];

function crossCheck(engine: Engine, rules: DnrRule[], urls: string[], sources: string[], types: number[]) {
  const mismatches: string[] = [];
  let n = 0;
  let blocks = 0;
  for (const url of urls) for (const src of sources) for (const type of types) {
    n++;
    const ev = engine.check({ url, sourceHost: src, type }).action === 'block' ? 'block' : 'pass';
    const dv = simulate(rules, { url, initiator: src, type: TYPE_TO_DNR[type]! }, src) === 'block' ? 'block' : 'pass';
    if (ev === 'block') blocks++;
    if (ev !== dv) mismatches.push(`${url} from ${src} type ${TYPE_TO_DNR[type]}: engine=${ev} dnr=${dv}`);
  }
  return { n, blocks, mismatches };
}

test('compiled DNR rules agree with the engine on a request grid', () => {
  const engine = Engine.fromLists([FIXTURE]);
  const c = compileToDnr(engine.networkRules);
  assert.equal(c.dropped.length, 0, JSON.stringify(c.dropped));
  const { n, blocks, mismatches } = crossCheck(engine, c.dynamic, URLS, SOURCES, TYPES);
  assert.ok(n > 800);
  assert.ok(blocks > 150 && blocks < n - 150, `non-trivial grid: ${blocks}/${n} blocked`);
  assert.deepEqual(mismatches, []);
});

test('real EasyList + EasyPrivacy (dev-data, if present): DNR model agrees with the engine on sampled rules', { skip: !existsSync(new URL('../../../dev-data/easylist.txt', import.meta.url)) }, () => {
  const lists = ['easylist.txt', 'easyprivacy.txt'].map((f) => readFileSync(new URL(`../../../dev-data/${f}`, import.meta.url), 'utf8'));
  const engine = Engine.fromLists(lists);
  const c = compileToDnr(engine.networkRules);
  assert.equal((c.droppedByReason['rule-limit'] ?? 0) + (c.droppedByReason['unsafe-rule-limit'] ?? 0), 0, 'fits in Chrome limits');
  const rules = [...c.dynamic, ...c.session];
  // Build request URLs from pure-host and path rules so many of them should match.
  const urls: string[] = [];
  const hostRules = engine.networkRules.filter((r) => r.pureHost && !r.exception && !r.includeDomains.length);
  for (let i = 0; i < hostRules.length; i += Math.ceil(hostRules.length / 150)) urls.push(`https://www.${hostRules[i]!.pureHost}/x/y.js?z=1`);
  const pathRules = engine.networkRules.filter((r) => r.pattern.kind === 'glob' && r.pattern.anchor === 'host' && !r.pureHost && !r.exception && !r.pattern.body.includes('*') && !r.pattern.body.includes('^') && !r.includeDomains.length);
  for (let i = 0; i < pathRules.length; i += Math.ceil(pathRules.length / 150)) {
    const p = pathRules[i]!.pattern as { body: string };
    urls.push(`https://${p.body}${p.body.includes('?') ? '&' : '?'}v=1`);
  }
  urls.push('https://example.com/', 'https://www.wikipedia.org/static/app.js', 'https://cdn.jsdelivr.net/npm/react/index.js');
  const { n, blocks, mismatches } = crossCheck(engine, rules, urls, ['example.com', 'news.ycombinator.com'], [RT.SCRIPT, RT.IMAGE, RT.XHR]);
  assert.ok(n > 1000, `checked ${n}`);
  assert.ok(blocks > n / 3, `non-trivial: ${blocks}/${n} blocked`);
  assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} mismatches of ${n}`);
});
