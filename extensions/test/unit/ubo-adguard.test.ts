// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// uBlock Origin / AdGuard list support: scriptlet names and trust, `!#if`
// directives, `$denyallow` / `$to` / `$strict1p|3p`, procedural operators,
// redirect resources, and the catalogue entries (runtime download only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeLines, evalDirective, parseLine, proceduralProblem, SCRIPTLETS, EXTENSION_ENV, splitUboArgs } from '../../src/shared/parse.ts';
import { Engine, applyUrlSkip } from '../../src/shared/engine.ts';
import { compileNetworkRule } from '../../src/shared/dnr.ts';
import { RT } from '../../src/shared/types.ts';
import type { NetworkRule } from '../../src/shared/types.ts';
import { resourcePath } from '../../src/shared/resources.ts';
import { CATALOGUE, UBO_ADGUARD_LISTS, isListEnabled } from '../../src/shared/catalogue.ts';

const ROOT = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');

const scriptlet = (line: string, trusted = false) => {
  const p = parseLine(line, trusted);
  if (p.kind === 'scriptlet') return p.scriptlet;
  if (p.kind === 'unsupported') return p.reason;
  throw new Error(`${line} parsed as ${p.kind}`);
};

test('uBO and AdGuard scriptlet names map to the runtime names', () => {
  const cases: Array<[string, string]> = [
    ['a.com##+js(rmnt, script, adblock)', 'remove-node-text'],
    ["a.com#%#//scriptlet('remove-node-text', 'script', 'adblock')", 'remove-node-text'],
    ['a.com##+js(nano-sib, , , 0.02)', 'adjust-setInterval'],
    ["a.com#%#//scriptlet('adjust-setTimeout', 'x')", 'adjust-setTimeout'],
    ['a.com##+js(aost, Math.random, /adblock/)', 'abort-on-stack-trace'],
    ['a.com##+js(noeval-if, /chp_?ad/)', 'prevent-eval-if'],
    ['a.com##+js(set-cookie, consent, true)', 'set-cookie'],
    ['a.com##+js(cookie-remover, /^_ga/)', 'remove-cookie'],
    ['a.com##+js(set-session-storage-item, k, 1)', 'set-session-storage-item'],
    ['a.com##+js(href-sanitizer, a[href*="?url="], ?url)', 'href-sanitizer'],
    ['a.com##+js(json-prune-xhr-response, ads)', 'json-prune-xhr-response'],
    ['a.com##+js(m3u-prune, /ad/, .m3u8)', 'm3u-prune'],
    ['a.com##+js(nobab)', 'prevent-adblock-detector'],
    ['a.com##+js(popads-dummy)', 'popads-dummy'],
    ["a.com#%#//scriptlet('prevent-element-src-loading', 'script', 'ads')", 'prevent-element-src-loading'],
    ['a.com##+js(spoof-css, .ad, display, block)', 'spoof-css'],
    ["a.com#%#//scriptlet('ubo-aeld.js', 'load')", 'prevent-addEventListener'],
  ];
  for (const [line, name] of cases) assert.equal((scriptlet(line) as { name: string }).name, name, line);
});

test('trusted-only scriptlets need a trusted list; unknown names are reported', () => {
  assert.equal(scriptlet('a.com##+js(trusted-set-cookie, a, b)'), 'scriptlet-untrusted:trusted-set-cookie');
  assert.deepEqual(scriptlet('a.com##+js(trusted-set-cookie, a, b)', true), { name: 'trusted-set-cookie', args: ['a', 'b'] });
  assert.equal(scriptlet('a.com##+js(rpnt, script, a, b)'), 'scriptlet-untrusted:replace-node-text');
  assert.equal(scriptlet('a.com##+js(trusted-made-up, x)', true), 'scriptlet:trusted-made-up');
  assert.equal(scriptlet('a.com#%#window.x = 1', true), 'raw-js');
  // AdGuard's argument order for trusted-replace-node-text becomes uBO's.
  assert.deepEqual(scriptlet("a.com#%#//scriptlet('trusted-replace-node-text', 'script', 'ads', '/ads=true/', 'ads=false')", true),
    { name: 'replace-node-text', args: ['script', '/ads=true/', 'ads=false', 'condition', 'ads'] });
  // Engine: trusted only per list.
  const list = 'a.com##+js(trusted-click-element, #reject)';
  assert.equal(Engine.fromLists([{ text: list, trusted: true }]).scriptlets('a.com').length, 1);
  assert.equal(Engine.fromLists([list]).scriptlets('a.com').length, 0);
});

test('runtime.js implements every scriptlet in the table', () => {
  const runtime = read('extensions/page-runtime/assets/runtime.js');
  for (const [name] of SCRIPTLETS) assert.ok(runtime.includes(`S['${name}'] =`), `runtime.js lacks ${name}`);
});

test('!#if directives', () => {
  assert.equal(evalDirective('env_chromium', EXTENSION_ENV.chrome), true);
  assert.equal(evalDirective('cap_html_filtering', EXTENSION_ENV.chrome), false);
  assert.equal(evalDirective('!env_safari && (env_firefox || env_chromium)', EXTENSION_ENV.chrome), true);
  assert.equal(evalDirective('env_firefox &&', EXTENSION_ENV.firefox), false);
  const text = 'a\n!#if env_firefox\nb\n!#else\nc\n!#endif\n!#if cap_html_filtering\nd\n!#endif\ne';
  assert.deepEqual(activeLines(text, EXTENSION_ENV.firefox), ['a', 'b', 'e']);
  assert.deepEqual(activeLines(text, EXTENSION_ENV.chrome), ['a', 'c', 'e']);
  const e = Engine.fromLists(['!#if env_safari\n||safari.example^\n!#endif\n||all.example^'], EXTENSION_ENV.chrome);
  const blocked = (h: string) => e.check({ url: `https://${h}/x.js`, sourceHost: 'p.com', type: RT.SCRIPT }).action === 'block';
  assert.equal(blocked('safari.example'), false);
  assert.equal(blocked('all.example'), true);
});

test('$denyallow, $to and $strict1p / $strict3p', () => {
  const e = Engine.fromLists(['*$script,3p,denyallow=google.com,domain=site.net\n*$image,to=example.org|~cdn.example.org\n/track/$xhr,strict3p']);
  const blocked = (url: string, src: string, type: number) => e.check({ url, sourceHost: src, type }).action === 'block';
  assert.ok(blocked('https://ads.other/x.js', 'site.net', RT.SCRIPT));
  assert.ok(!blocked('https://apis.google.com/x.js', 'site.net', RT.SCRIPT));
  assert.ok(blocked('https://img.example.org/a.png', 'p.org', RT.IMAGE));
  assert.ok(!blocked('https://cdn.example.org/a.png', 'p.org', RT.IMAGE));
  assert.ok(!blocked('https://img.other.net/a.png', 'p.org', RT.IMAGE));
  assert.ok(blocked('https://api.site.net/track/x', 'www.site.net', RT.XHR));
  assert.ok(!blocked('https://www.site.net/track/x', 'www.site.net', RT.XHR));
  // DNR: denyallow/to become request-domain conditions; strict1p can't be expressed.
  const rule = (l: string) => (parseLine(l) as { rule: NetworkRule }).rule;
  const c = compileNetworkRule(rule('*$script,3p,denyallow=google.com,domain=site.net'));
  assert.ok(c.ok && c.rules[0]!.condition.excludedRequestDomains?.includes('google.com'));
  const t = compileNetworkRule(rule('*$image,to=example.org|~cdn.example.org'));
  assert.ok(t.ok && t.rules[0]!.condition.requestDomains?.[0] === 'example.org' && t.rules[0]!.condition.excludedRequestDomains?.[0] === 'cdn.example.org');
  const s = compileNetworkRule(rule('/track/$xhr,strict1p'));
  assert.ok(!s.ok && s.reason === 'strict1p');
});

test('procedural operators are checked against what runtime.js implements', () => {
  assert.equal(proceduralProblem('div:matches-path(/news/) .ad'), null);
  assert.equal(proceduralProblem('.x:others()'), null);
  assert.equal(proceduralProblem('div:not(:has-text(x)):nth-child(2)'), null);
  assert.equal(proceduralProblem('div:matches-prop(x)'), 'procedural-op:matches-prop');
  assert.equal(proceduralProblem('div:has-text(x):style(background: url(x))'), 'style-unsafe');
  assert.equal(parseLine('a.com##div:matches-prop(x)').kind, 'unsupported');
  assert.equal(parseLine('a.com##div:has-text(x):remove-attr(style)').kind, 'procedural');
});

test('new redirect resources (uBO and AdGuard names)', () => {
  for (const [name, file] of [
    ['google-ima.js', 'google-ima.js'], ['google-ima3', 'google-ima.js'], ['prebid-ads.js', 'prebid-ads.js'],
    ['fingerprint2.js', 'fingerprint2.js'], ['fingerprint3.js', 'fingerprint3.js'], ['amazon_apstag.js', 'amazon_apstag.js'],
    ['fuckadblock.js-3.2.0', 'fuckadblock-3.2.0.js'], ['nofab.js', 'fuckadblock-3.2.0.js'], ['popads.net.js', 'popads.js'],
    ['scorecardresearch_beacon.js', 'scorecardresearch_beacon.js'],
  ]) {
    assert.equal(resourcePath(name!), `/resources/${file}`, name);
    const src = read(`extensions/resources/${file}`);
    assert.match(src, /^\/\/ Written from scratch/);
    assert.doesNotThrow(() => new Function(src), file);
  }
});

test('catalogue: uBO and AdGuard lists are runtime downloads from official GitHub URLs, credited', () => {
  assert.ok(UBO_ADGUARD_LISTS.length >= 8);
  for (const e of UBO_ADGUARD_LISTS) {
    assert.ok(CATALOGUE.includes(e), e.id);
    assert.equal(e.license, 'GPL-3.0', e.id);
    assert.equal(e.trusted, true, e.id);
    const on = ['ubo-filters', 'ubo-privacy', 'ubo-badware', 'ubo-quick-fixes', 'ubo-unbreak', 'adguard-base', 'adguard-url-tracking'].includes(e.id);
    assert.equal(isListEnabled(e, {}, ['en-US'], 'chrome'), on, `${e.id} default on Chrome`);
    assert.equal(isListEnabled(e, {}, ['en-US'], 'firefox'), on, `${e.id} default on Firefox`);
    assert.equal(isListEnabled(e, {}, ['en-US'], 'safari'), on, `${e.id} default on Safari`);
    assert.equal(isListEnabled(e, { [e.id]: !on }, ['en-US'], 'chrome'), !on, `${e.id}: the user's choice wins`);
    assert.ok(e.credit && /uBlock Origin|AdGuard/.test(e.credit), e.id);
    assert.ok(/^https:\/\/(ublockorigin\.github\.io\/uAssets\/filters\/|raw\.githubusercontent\.com\/AdguardTeam\/FiltersRegistry\/master\/platforms\/extension\/ublock\/filters\/)/.test(e.url), e.url);
    assert.ok(!/adtidy\.org/.test(e.url), e.id);
  }
  // Only these entries are trusted.
  assert.deepEqual(CATALOGUE.filter((e) => e.trusted).map((e) => e.id).sort(), UBO_ADGUARD_LISTS.map((e) => e.id).sort());
});

test('$method, $popunder, redirect exceptions, $genericblock, $urlskip / $uritransform', () => {
  const e = Engine.fromLists([String.raw`||api.example/collect$xhr,method=post
||pop.example^$popunder
||cdn.example/gpt.js$script,redirect=noop.js
@@||cdn.example/gpt.js$script,redirect-rule,domain=keep.example
||generic-ads.example^
||site-ads.example^$domain=gb.example
@@||gb.example^$genericblock
||t.example/out?$doc,urlskip=?url
||www.shop.example/dp/*/ref=$doc,uritransform=/\/ref=[^\/?#]+//`]);
  const v = (url: string, src: string, type: number, method?: string) => e.check({ url, sourceHost: src, type, ...(method ? { method } : {}) });
  assert.equal(v('https://api.example/collect', 'p.com', RT.XHR, 'POST').action, 'block');
  assert.equal(v('https://api.example/collect', 'p.com', RT.XHR, 'GET').action, 'allow');
  assert.equal(e.checkPopup('https://pop.example/x', 'https://p.com/').action, 'block');
  assert.deepEqual(v('https://cdn.example/gpt.js', 'a.example', RT.SCRIPT), { action: 'block', rule: '||cdn.example/gpt.js$script,redirect=noop.js', redirect: 'noop.js' });
  assert.deepEqual(v('https://cdn.example/gpt.js', 'keep.example', RT.SCRIPT), { action: 'block', rule: '||cdn.example/gpt.js$script,redirect=noop.js', redirect: null });
  assert.equal(v('https://generic-ads.example/a.js', 'gb.example', RT.SCRIPT).action, 'allow');
  assert.equal(v('https://generic-ads.example/a.js', 'x.example', RT.SCRIPT).action, 'block');
  assert.equal(v('https://site-ads.example/a.js', 'gb.example', RT.SCRIPT).action, 'block');
  assert.equal(e.navigationTarget('https://t.example/out?url=https%3A%2F%2FDest.example%2FP'), 'https://Dest.example/P');
  assert.equal(e.navigationTarget('https://www.shop.example/dp/B01/ref=sr_1?k=v'), 'https://www.shop.example/dp/B01?k=v');
  assert.equal(e.navigationTarget('https://example.org/'), null);
  assert.equal(applyUrlSkip(['?u', '-base64'], 'https://t.example/?u=aHR0cHM6Ly9kLmV4YW1wbGUv'), 'https://d.example/');
  assert.equal(applyUrlSkip(['?u'], 'https://t.example/?u=javascript%3Aalert(1)'), null);
  // DNR: method conditions; navigation rules and redirect exceptions are handled outside DNR.
  const rule = (l: string) => (parseLine(l) as { rule: NetworkRule }).rule;
  const m = compileNetworkRule(rule('||api.example/collect$xhr,method=post|~get'));
  assert.ok(m.ok && m.rules[0]!.condition.requestMethods?.[0] === 'post');
  const n = compileNetworkRule(rule('||t.example/out?$doc,urlskip=?url'));
  assert.ok(!n.ok && n.notInDnr);
});

test('uBO scriptlet arguments: quoted arguments lose their quotes (as in uBO)', () => {
  // uBO's own YouTube rules: without unquoting, the pattern would include the single quotes and never match.
  assert.deepEqual(splitUboArgs(`trusted-rpfr, '"adSlots"', '"no_ads"', player?`), ['trusted-rpfr', '"adSlots"', '"no_ads"', 'player?']);
  assert.deepEqual(splitUboArgs(`set, "a, b", c`), ['set', 'a, b', 'c']);
  assert.deepEqual(splitUboArgs('x, `t`'), ['x', 't']);
  assert.deepEqual(splitUboArgs(`x, 'it\\'s'`), ['x', "it's"]);
  // Not a whole quoted argument: taken literally, as before.
  assert.deepEqual(splitUboArgs(`x, 'a'b, c`), ['x', "'a'b", 'c']);
  assert.deepEqual(splitUboArgs(`x, 'open`), ['x', "'open"]);
  assert.deepEqual(splitUboArgs(`x, /"ad.*?"/, a\\, b`), ['x', '/"ad.*?"/', 'a, b']);
  assert.deepEqual(splitUboArgs('x, '), ['x', '']);
  const e = Engine.fromLists([{ text: `www.youtube.com##+js(trusted-rpfr, '"adSlots"', '"no_ads"', player?)`, trusted: true }]);
  assert.deepEqual(e.scriptlets('www.youtube.com').map((s) => s.args), [['"adSlots"', '"no_ads"', 'player?']]);
});
