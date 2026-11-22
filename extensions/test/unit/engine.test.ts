// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Engine semantics. Cases originally mirrored the Rust engine's tests (tag mac-app-final) so the
// extension and the desktop proxy agree, plus popup matching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/shared/engine.ts';
import { parseLine, bestToken, stripBadfilter } from '../../src/shared/parse.ts';
import { compilePattern, hostRange } from '../../src/shared/pattern.ts';
import { entityKey, hostOf, isThirdParty, registrable } from '../../src/shared/domain.ts';
import { RT } from '../../src/shared/types.ts';

const LIST = String.raw`
[Adblock Plus 2.0]
! Title: test list
||ads.example.com^
||tracker.net^$third-party
/banner/*/img^
|https://exact.test/ad.js|
||cdn.site.com/ads/$script,domain=news.com|~blog.news.com
@@||ads.example.com/allowed/$image
||important.net^$important
@@||important.net^
||badfiltered.com^
||badfiltered.com^$badfilter
@@||allowlisted-site.com^$document
@@||nogeneric.com^$generichide
/ad[0-9]{3}\.js/
example.com##.sidebar-ad
~example.com##.generic-banner
##.ad-slot
example.com#@#.ad-slot
google.*##.g-ad
0.0.0.0 hosts-entry.org
`;

const e = Engine.fromLists([LIST]);
const S = RT.SCRIPT;
const blocked = (url: string, src: string | null, type: number) => e.check({ url, sourceHost: src, type }).action === 'block';

test('stats', () => {
  assert.equal(e.stats.badfiltered, 1);
  assert.equal(e.stats.cosmetic, 5);
  assert.equal(e.stats.unsupported, 0);
});

test('basic blocking', () => {
  assert.ok(blocked('https://ads.example.com/x.js', 'a.com', S));
  assert.ok(blocked('https://sub.ads.example.com/x.js', 'a.com', S));
  assert.ok(!blocked('https://notads.example.com/x.js', 'a.com', S));
  assert.ok(blocked('https://x.com/banner/123/img?w=300', null, RT.IMAGE));
  assert.ok(!blocked('https://x.com/banner/123/img.png', null, RT.IMAGE)); // ^ doesn't match '.'
  assert.ok(blocked('https://exact.test/ad.js', null, S));
  assert.ok(!blocked('https://exact.test/ad.js?x', null, S));
  assert.ok(blocked('https://x.com/ad123.js', null, S));
  assert.ok(blocked('https://hosts-entry.org/p', null, S));
  assert.ok(blocked('https://ADS.EXAMPLE.COM/X.JS', 'a.com', S), 'case-insensitive');
});

test('party and domain options', () => {
  assert.ok(blocked('https://tracker.net/t.js', 'news.com', S));
  assert.ok(!blocked('https://tracker.net/t.js', 'www.tracker.net', S));
  assert.ok(blocked('https://cdn.site.com/ads/a.js', 'www.news.com', S));
  assert.ok(!blocked('https://cdn.site.com/ads/a.js', 'blog.news.com', S));
  assert.ok(!blocked('https://cdn.site.com/ads/a.js', 'other.com', S));
  assert.ok(!blocked('https://cdn.site.com/ads/a.png', 'news.com', RT.IMAGE));
  // Firefox gives an authoritative thirdParty flag; it wins over the heuristic.
  assert.equal(e.check({ url: 'https://tracker.net/t.js', sourceHost: 'news.com', type: S, thirdParty: false }).action, 'allow');
});

test('exceptions and important', () => {
  assert.equal(e.check({ url: 'https://ads.example.com/allowed/x.png', sourceHost: null, type: RT.IMAGE }).action, 'excepted');
  assert.ok(blocked('https://ads.example.com/allowed/x.js', null, S));
  assert.ok(blocked('https://important.net/x', null, S));
  assert.ok(!blocked('https://badfiltered.com/x', null, S));
  assert.ok(!blocked('https://ads.example.com/x.js', 'www.allowlisted-site.com', S));
});

test('pure host rules do NOT block top-level documents (deliberate, ABP semantics)', () => {
  assert.ok(!blocked('https://ads.example.com/', null, RT.DOCUMENT));
  assert.ok(blocked('https://ads.example.com/', null, RT.SUBDOCUMENT));
  const d = Engine.fromLists(['||bad.example^$document']);
  assert.ok(d.check({ url: 'https://bad.example/', sourceHost: 'bad.example', type: RT.DOCUMENT }).action === 'block');
});

test('cosmetic filtering', () => {
  const r = e.cosmeticsFor('www.example.com')!;
  assert.deepEqual(r.specific, ['.sidebar-ad']);
  assert.ok(!r.generic.includes('.generic-banner'));
  assert.deepEqual(e.genericForTokens('www.example.com', ['.ad-slot']), [], 'site exception unhides');
  const o = e.cosmeticsFor('other.org')!;
  assert.deepEqual(o.specific, []);
  assert.ok(o.generic.includes('.generic-banner'));
  assert.deepEqual(e.genericForTokens('other.org', ['.ad-slot', '.unrelated']), ['.ad-slot']);
  assert.deepEqual(e.cosmeticsFor('www.google.co.uk')!.specific, ['.g-ad']);
  assert.deepEqual(e.cosmeticsFor('google.com')!.specific, ['.g-ad']);
  const ng = e.cosmeticsFor('nogeneric.com')!;
  assert.equal(ng.allowGeneric, false);
  assert.deepEqual(ng.generic, []);
  assert.deepEqual(e.genericForTokens('nogeneric.com', ['.ad-slot']), []);
  assert.equal(e.cosmeticsFor('allowlisted-site.com'), null);
});

test('generic selectors without a class/id key are always applied', () => {
  const c = Engine.fromLists(['##[id^="div-gpt-ad"]\n##a[href*="/aff/"]\n##.keyed\n##div.ad\n##.a, .b']);
  assert.deepEqual(c.cosmeticsFor('x.com')!.generic.sort(), ['##', '.a, .b', '[id^="div-gpt-ad"]', 'a[href*="/aff/"]', 'div.ad'].filter((s) => s !== '##').sort());
  assert.deepEqual(c.genericForTokens('x.com', ['.keyed']), ['.keyed']);
});

test('redirects and modifiers', () => {
  const m = Engine.fromLists([String.raw`
||ads.example/gpt.js$script,redirect=googletagservices_gpt.js
$removeparam=utm_source
$removeparam=/^utm_/
||news.example^$removeparam=fbclid
@@||keep.example^$removeparam=utm_source
||site.example^$csp=script-src 'self'
||site.example^$removeheader=refresh
||rr.example/a.js$script,redirect-rule=noop.js
||rr.example/a.js$script,domain=blockme.example
`]);
  assert.deepEqual(m.check({ url: 'https://ads.example/gpt.js', sourceHost: 'x.com', type: S }), {
    action: 'block', rule: '||ads.example/gpt.js$script,redirect=googletagservices_gpt.js', redirect: 'googletagservices_gpt.js',
  });
  let url = 'https://news.example/a?id=7&utm_source=x&utm_medium=y&fbclid=Z#top';
  assert.equal(m.cleanUrl({ url, sourceHost: 'news.example', type: RT.DOCUMENT }), 'https://news.example/a?id=7#top');
  url = 'https://other.example/?fbclid=Z&utm_source=x';
  assert.equal(m.cleanUrl({ url, sourceHost: null, type: RT.DOCUMENT }), 'https://other.example/?fbclid=Z');
  url = 'https://keep.example/?utm_source=x&utm_campaign=y';
  assert.equal(m.cleanUrl({ url, sourceHost: null, type: RT.DOCUMENT }), 'https://keep.example/');
  const only = Engine.fromLists(['$removeparam=utm_source\n@@||keep.example^$removeparam=utm_source']);
  assert.equal(only.cleanUrl({ url, sourceHost: null, type: RT.DOCUMENT }), null);
  assert.equal(m.cleanUrl({ url: 'https://clean.example/?q=1', sourceHost: null, type: RT.DOCUMENT }), null);
  // Original case is preserved in the cleaned URL.
  assert.equal(m.cleanUrl({ url: 'https://X.example/Path?Keep=A&utm_source=1', sourceHost: null, type: RT.DOCUMENT }), 'https://X.example/Path?Keep=A');
  const doc = { url: 'https://site.example/', sourceHost: 'site.example', type: RT.DOCUMENT };
  assert.deepEqual(m.csp(doc), ["script-src 'self'"]);
  assert.deepEqual(m.headersToRemove(doc), ['refresh']);
  // $redirect-rule only redirects when another rule blocks.
  assert.equal(m.check({ url: 'https://rr.example/a.js', sourceHost: 'other.example', type: S }).action, 'allow');
  assert.deepEqual(m.check({ url: 'https://rr.example/a.js', sourceHost: 'blockme.example', type: S }), {
    action: 'block', rule: '||rr.example/a.js$script,domain=blockme.example', redirect: 'noop.js',
  });
});

test('scriptlets, procedural, styles', () => {
  const s = Engine.fromLists([String.raw`
example.com##+js(set, ads.enabled, false)
example.com,example.org##+js(aopr, adblockDetector)
~sub.example.com##+js(nowebrtc)
sub.example.com#@#+js(aopr, adblockDetector)
nojs.example.com#@#+js()
example.com#?#div.card:has-text(Sponsored)
example.com##section:upward(2)
example.com#$#body { overflow: auto !important; }
example.com##.modal:style(display: none !important)
@@||allowed.example^$document
allowed.example##+js(nowebrtc)
example.com##+js(trusted-set-cookie, a, b)
example.com#%#window.evil = 1
example.com#%#//scriptlet('trusted-click-element', 'a')
example.com#%#//scriptlet('ubo-set-constant.js', 'x.y', 'true')
`]);
  const names = (h: string) => s.scriptlets(h).map((x) => x.name);
  assert.deepEqual(names('www.example.com'), ['nowebrtc', 'set-constant', 'abort-on-property-read', 'set-constant']);
  assert.deepEqual(names('sub.example.com'), ['set-constant', 'set-constant']);
  assert.deepEqual(names('nojs.example.com'), []);
  assert.deepEqual(names('allowed.example'), []);
  assert.deepEqual(s.scriptlets('example.com')[3], { name: 'set-constant', args: ['x.y', 'true'] });
  assert.deepEqual(s.procedural('example.com'), ['div.card:has-text(Sponsored)', 'section:upward(2)']);
  assert.equal(s.cosmeticsFor('example.com')!.styles.length, 2);
  assert.deepEqual(s.procedural('unrelated.net'), []);
  assert.equal(s.stats.unsupported, 3, 'trusted-* and raw JS are refused');
});

test('popup matching', () => {
  const p = Engine.fromLists([String.raw`
||popads.example^$popup
||clickunder.example^$popup,third-party
/redirect/*?ad=$popup,domain=tube.example
@@||popads.example/ok^$popup
||popads.example/ok2^$popup,important
@@||popads.example/ok2^$popup
||ads.example.com^
@@||safe-site.example^$document
`]);
  const popup = (url: string, opener: string | null) => p.checkPopup(url, opener).action;
  assert.equal(popup('https://popads.example/land', 'https://news.example/'), 'block');
  assert.equal(popup('https://sub.popads.example/land', 'https://news.example/'), 'block');
  assert.equal(popup('https://popads.example/ok', 'https://news.example/'), 'excepted');
  assert.equal(popup('https://popads.example/ok2', 'https://news.example/'), 'block', '$important beats exception');
  // third-party relative to the opener page.
  assert.equal(popup('https://clickunder.example/x', 'https://news.example/'), 'block');
  assert.equal(popup('https://clickunder.example/x', 'https://www.clickunder.example/'), 'allow');
  // $domain refers to the opener.
  assert.equal(popup('https://cdn.example/redirect/1?ad=2', 'https://www.tube.example/v/1'), 'block');
  assert.equal(popup('https://cdn.example/redirect/1?ad=2', 'https://other.example/'), 'allow');
  // Non-popup rules never close tabs; popup rules never block requests.
  assert.equal(popup('https://ads.example.com/x', 'https://news.example/'), 'allow');
  assert.equal(p.check({ url: 'https://popads.example/x.js', sourceHost: 'news.example', type: RT.SCRIPT }).action, 'allow');
  // Opener page allowlisted with $document.
  assert.equal(popup('https://popads.example/land', 'https://safe-site.example/a'), 'excepted');
  // Unknown opener (e.g. about:blank chain): only rules without $domain apply.
  assert.equal(popup('https://popads.example/land', null), 'block');
  assert.equal(popup('https://cdn.example/redirect/1?ad=2', 'about:blank'), 'allow');
  assert.equal(p.stats.popup, 6); // 4 blocking + 2 exceptions
  // A generic exception without $popup does not unblock popups.
  const g = Engine.fromLists(['||pp.example^$popup\n@@||pp.example^']);
  assert.equal(g.checkPopup('https://pp.example/', 'https://a.example/').action, 'block');
  // $all includes popup.
  const all = Engine.fromLists(['||everything.example^$all']);
  assert.equal(all.checkPopup('https://everything.example/', 'https://a.example/').action, 'block');
  assert.equal(all.check({ url: 'https://everything.example/', sourceHost: 'everything.example', type: RT.DOCUMENT }).action, 'block');
});

test('parser classification', () => {
  const k = (l: string) => parseLine(l).kind;
  assert.equal(k('! comment'), 'ignored');
  assert.equal(k('[Adblock Plus 2.0]'), 'ignored');
  assert.equal(k('# hosts comment'), 'ignored');
  assert.equal(k(''), 'ignored');
  assert.equal(k('0.0.0.0 tracker.net'), 'network');
  assert.equal(k('127.0.0.1 localhost'), 'ignored');
  assert.equal(k('example.com##.ad'), 'cosmetic');
  assert.equal(k('##.banner-ad'), 'cosmetic');
  assert.equal(k('example.com#?#div:has-text(Ad)'), 'procedural');
  assert.equal(k('##div:has-text(Ad)'), 'unsupported');
  assert.equal(k('example.com#%#window.x=1'), 'unsupported');
  assert.equal(k('example.com##+js(trusted-set-cookie, a, b)'), 'unsupported');
  assert.equal(k('example.com##+js(unknown-scriptlet)'), 'unsupported');
  assert.equal(k('example.com##^script:has-text(ad)'), 'unsupported');
  assert.equal(k('example.com$$script[data-ad]'), 'unsupported');
  assert.equal(k('||x.com^$badfilter'), 'badfilter');
  assert.equal(k('||x.com^$popup'), 'network');
  assert.equal(k('||x.com^$method=post'), 'network', '$method is supported');
  assert.equal(k('||x.com^$denyallow=a.com'), 'network', '$denyallow is supported');
  assert.equal(k('||x.com^$denyallow=~a.com'), 'unsupported', 'negated denyallow domains are not');
  assert.equal(k('*'), 'unsupported');
  assert.equal(k('||x.com^$generichide'), 'unsupported', 'generichide only on exceptions');
  assert.equal(k('x.com#$#.a { background: url(http://evil) }'), 'unsupported');
  assert.equal(k('||x.com/pa$th/x'), 'network', 'non-option $ stays in pattern');
  assert.equal(k('||x.com/path$with$dollar'), 'unsupported', 'trailing $word is read as an (unknown) option, like the Rust parser');
  const p = parseLine('||x.com/a$b=c$d') as { kind: string };
  assert.equal(p.kind, 'unsupported'); // last $ is followed by a valid-looking option name we don't know
});

test('scriptlet argument syntaxes', () => {
  const p = parseLine(String.raw`a.com,b.com##+js(nostif, ad\, block, 2000)`);
  assert.ok(p.kind === 'scriptlet' && p.scriptlet);
  assert.deepEqual(p.scriptlet, { name: 'prevent-setTimeout', args: ['ad, block', '2000'] });
  assert.deepEqual(p.includeDomains, ['a.com', 'b.com']);
  const q = parseLine(String.raw`x.com#%#//scriptlet('ubo-set-constant.js', 'ads.enabled', "false")`);
  assert.ok(q.kind === 'scriptlet');
  assert.deepEqual(q.scriptlet, { name: 'set-constant', args: ['ads.enabled', 'false'] });
  const r = parseLine('x.com#@#+js()');
  assert.ok(r.kind === 'scriptlet' && r.exception && r.scriptlet === null);
});

test('badfilter stripping and tokens', () => {
  assert.equal(stripBadfilter('||x.com^$script,badfilter'), '||x.com^$script');
  assert.equal(stripBadfilter('||x.com^$badfilter'), '||x.com^');
  assert.equal(bestToken('/banner*ads/', 'none', false), null);
  assert.equal(bestToken('/adserver/', 'none', false), 'adserver');
  assert.equal(bestToken('adserver', 'none', false), null);
});

test('pattern matching edge cases', () => {
  const m = (body: string, anchor: 'none' | 'host' | 'start', end: boolean, url: string) => {
    const [hs, he] = hostRange(url);
    return compilePattern({ kind: 'glob', anchor, endAnchor: end, body }, false).matches(url, hs, he);
  };
  assert.ok(m('example.com^', 'host', false, 'https://example.com/'));
  assert.ok(m('example.com^', 'host', false, 'https://example.com'));
  assert.ok(m('example.com^', 'host', false, 'https://example.com:8080/'));
  assert.ok(!m('example.com^', 'host', false, 'https://badexample.com/'));
  assert.ok(!m('example.com^', 'host', false, 'https://example.com.evil.net/'));
  assert.ok(!m('example.com^', 'host', false, 'https://x.com/?u=example.com/'));
  assert.ok(m('/ads/*.js^', 'none', false, 'https://x.com/ads/a/b.js?x'));
  assert.ok(!m('/ads/*.js^', 'none', false, 'https://x.com/ads/b.json'));
  assert.ok(m('/a/*/b', 'none', true, 'https://x.com/a/q/b/a/r/b'));
  assert.ok(m('https://ads.', 'start', false, 'https://ads.x.com/'));
  assert.ok(!m('https://ads.', 'start', false, 'https://x.com/https://ads.'));
  assert.ok(m('^ad^', 'none', false, 'https://x.com/ad?'));
  assert.ok(m('ad^^', 'none', false, 'https://x.com/ad'));
  assert.ok(m('user@', 'none', false, 'https://user@x.com/'));
  assert.equal(hostOf('https://user@Sub.Example.com:8443/p?q'), 'sub.example.com');
  assert.equal(hostOf('http://[::1]:80/'), '::1');
});

test('domain heuristics', () => {
  assert.equal(registrable('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrable('a.b.example.com'), 'example.com');
  assert.equal(registrable('user.github.io'), 'user.github.io');
  assert.equal(registrable('127.0.0.1'), '127.0.0.1');
  assert.ok(isThirdParty('ads.tracker.net', 'www.example.co.uk'));
  assert.ok(!isThirdParty('cdn.example.co.uk', 'www.example.co.uk'));
  assert.equal(entityKey('www.google.co.uk'), 'google.*');
  assert.equal(entityKey('google.de'), 'google.*');
  assert.equal(entityKey('localhost'), null);
});

test('performance: parse + check stay within budget on synthetic 100k-rule list', () => {
  const lines: string[] = [];
  for (let i = 0; i < 60000; i++) lines.push(`||host${i}.example^`);
  for (let i = 0; i < 40000; i++) lines.push(`/path${i}/ad$script,domain=site${i % 500}.com`);
  const t0 = performance.now();
  const big = Engine.fromLists([lines.join('\n')]);
  const parseMs = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 10000; i++) big.check({ url: `https://cdn.example/path${i}/ad?x=1`, sourceHost: `site${i % 500}.com`, type: RT.SCRIPT });
  const checkMs = performance.now() - t1;
  assert.ok(parseMs < 3000, `parse ${parseMs} ms`);
  assert.ok(checkMs < 1000, `10k checks ${checkMs} ms`);
});

test('page fixes from downloaded lists are kept apart (Chrome full protection)', () => {
  const list = 'example.com##+js(set-constant, adsOn, false)\nexample.com##.promo:has-text(Sale)\nother.com##+js(nowebrtc)';
  const mine = 'example.com##+js(nobab)\nexample.com##.box:has-text(Hello)';
  const e = Engine.fromLists([{ text: list, remote: true }, mine]);
  const names = (scope: 'all' | 'local' | 'remote') => e.scriptlets('example.com', scope).map((s) => s.name);
  // ("nobab" is stored under its full name.)
  assert.deepEqual(names('local'), ['prevent-adblock-detector']);
  assert.deepEqual(names('remote'), ['set-constant']);
  assert.deepEqual(names('all').sort(), ['prevent-adblock-detector', 'set-constant']);
  assert.deepEqual(e.procedural('example.com', 'local'), ['.box:has-text(Hello)']);
  assert.deepEqual(e.procedural('example.com', 'remote'), ['.promo:has-text(Sale)']);
  assert.equal(e.procedural('example.com').length, 2);
  // Default (Firefox, Safari): everything, as before.
  assert.equal(e.scriptlets('example.com').length, 2);
  // An exception from any source cancels a list fix (here: the person's own exception).
  const ex = Engine.fromLists([{ text: list, remote: true }, 'example.com#@#+js(set-constant, adsOn, false)']);
  assert.deepEqual(ex.scriptlets('example.com', 'remote'), []);
  // Plain strings (My Rules, picker) count as the person's own.
  assert.equal(Engine.fromLists([list]).scriptlets('example.com', 'remote').length, 0);
});
