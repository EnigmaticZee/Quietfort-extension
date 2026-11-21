// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Rule text → declarativeNetRequest JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../../src/shared/parse.ts';
import { compileNetworkRule, compileToDnr, allowlistRule, regexLooksRe2Compatible, PRIORITY } from '../../src/shared/dnr.ts';
import type { DnrRuleNoId, CompileOne } from '../../src/shared/dnr.ts';
import { Engine } from '../../src/shared/engine.ts';
import type { NetworkRule } from '../../src/shared/types.ts';

function net(line: string): NetworkRule {
  const p = parseLine(line);
  assert.equal(p.kind, 'network', `${line} → ${JSON.stringify(p)}`);
  return (p as { rule: NetworkRule }).rule;
}

function one(line: string, platform: 'chrome' | 'safari' = 'chrome'): DnrRuleNoId {
  const r = compileNetworkRule(net(line), platform);
  assert.ok(r.ok, `${line}: ${JSON.stringify(r)}`);
  assert.equal(r.rules.length, 1, `${line}: expected one rule, got ${JSON.stringify(r.rules)}`);
  return r.rules[0]!;
}

function fails(line: string): CompileOne & { ok: false } {
  const r = compileNetworkRule(net(line));
  assert.ok(!r.ok, `${line} should not compile: ${JSON.stringify(r)}`);
  return r as CompileOne & { ok: false };
}

const BLOCK = { type: 'block' } as const;

test('plain patterns map to urlFilter with DNR default types', () => {
  assert.deepEqual(one('/banner/ads/'), { priority: 1000, action: BLOCK, condition: { urlFilter: '/banner/ads/' } });
  assert.deepEqual(one('&ad_type='), { priority: 1000, action: BLOCK, condition: { urlFilter: '&ad_type=' } });
  assert.deepEqual(one('|https://ads.'), { priority: 1000, action: BLOCK, condition: { urlFilter: '|https://ads.' } });
  assert.deepEqual(one('.swf|'), { priority: 1000, action: BLOCK, condition: { urlFilter: '.swf|' } });
  assert.deepEqual(one('||example.com/ads/*.js^'), { priority: 1000, action: BLOCK, condition: { urlFilter: '||example.com/ads/*.js^' } });
  // Leading/trailing wildcards of unanchored patterns are dropped, like the Rust parser.
  assert.deepEqual(one('*/adframe/*'), { priority: 1000, action: BLOCK, condition: { urlFilter: '/adframe/' } });
  // Case is folded unless $match-case.
  assert.deepEqual(one('/AdServer/'), { priority: 1000, action: BLOCK, condition: { urlFilter: '/adserver/' } });
  assert.deepEqual(one('/AdServer/$match-case'), { priority: 1000, action: BLOCK, condition: { urlFilter: '/AdServer/', isUrlFilterCaseSensitive: true } });
});

test('pure host rules use requestDomains (and never main_frame unless $document)', () => {
  assert.deepEqual(one('||ads.example.com^'), { priority: 1000, action: BLOCK, condition: { requestDomains: ['ads.example.com'] } });
  assert.deepEqual(one('||ads.example.com^$document'), { priority: 1000, action: BLOCK, condition: { requestDomains: ['ads.example.com'], resourceTypes: ['main_frame'] } });
  // Not pure: path, wildcard, port, missing separator, end anchor.
  assert.deepEqual(one('||ads.example.com/x^').condition, { urlFilter: '||ads.example.com/x^' });
  assert.deepEqual(one('||ads.*.example.com^').condition, { urlFilter: '||ads.*.example.com^' });
  assert.deepEqual(one('||ads.example.com:8080^').condition, { urlFilter: '||ads.example.com:8080^' });
  assert.deepEqual(one('||adserver.').condition, { urlFilter: '||adserver.' });
  assert.deepEqual(one('||ads.example.com^|').condition, { urlFilter: '||ads.example.com^|' });
  // Hosts-file lines are pure host rules.
  assert.deepEqual(one('0.0.0.0 tracker.example').condition, { requestDomains: ['tracker.example'] });
});

test('internationalised hosts become punycode; non-ASCII paths are dropped', () => {
  assert.deepEqual(one('||münchen.example^').condition, { requestDomains: ['xn--mnchen-3ya.example'] });
  assert.deepEqual(one('||bücher.example/ads').condition, { urlFilter: '||xn--bcher-kva.example/ads' });
  assert.equal(fails('/werbung-ä/').reason, 'non-ascii');
  assert.equal(compileNetworkRule(net('||x.com^$domain=bücher.example')).ok, true);
  const r = one('||x.com/a$domain=bücher.example');
  assert.deepEqual(r.condition.initiatorDomains, ['xn--bcher-kva.example']);
});

test('$third-party / $first-party → domainType', () => {
  assert.equal(one('||x.com/a$third-party').condition.domainType, 'thirdParty');
  assert.equal(one('||x.com/a$3p').condition.domainType, 'thirdParty');
  assert.equal(one('||x.com/a$~third-party').condition.domainType, 'firstParty');
  assert.equal(one('||x.com/a$first-party').condition.domainType, 'firstParty');
  assert.equal(one('||x.com/a$1p').condition.domainType, 'firstParty');
  assert.equal(one('||x.com/a$~1p').condition.domainType, 'thirdParty');
  assert.equal(one('||x.com/a').condition.domainType, undefined);
});

test('$domain → initiatorDomains / excludedInitiatorDomains', () => {
  assert.deepEqual(one('||x.com/ad$domain=a.com|b.org|~sub.a.com').condition, {
    urlFilter: '||x.com/ad', initiatorDomains: ['a.com', 'b.org'], excludedInitiatorDomains: ['sub.a.com'],
  });
  assert.deepEqual(one('/ads.js$domain=~a.com').condition, { urlFilter: '/ads.js', excludedInitiatorDomains: ['a.com'] });
  // Domain-only rule (empty pattern) is valid: everything of that type on that site.
  assert.deepEqual(one('$script,domain=a.com').condition, { initiatorDomains: ['a.com'], resourceTypes: ['script'] });
  // Entity domains can't be expressed: keep the rule if a plain domain remains, else drop.
  assert.deepEqual(one('/ad.js$domain=google.*|a.com').condition.initiatorDomains, ['a.com']);
  assert.equal(fails('/ad.js$domain=google.*').reason, 'entity-domain');
  assert.equal(fails('/ad.js$domain=~google.*').reason, 'entity-domain');
});

test('resource types', () => {
  assert.deepEqual(one('||x.com/a$script').condition.resourceTypes, ['script']);
  assert.deepEqual(one('||x.com/a$script,image,stylesheet').condition.resourceTypes, ['script', 'stylesheet', 'image']);
  assert.deepEqual(one('||x.com/a$xhr,ping,websocket,media,font,object').condition.resourceTypes, ['font', 'media', 'xmlhttprequest', 'websocket', 'ping', 'object']);
  assert.deepEqual(one('||x.com/a$subdocument').condition.resourceTypes, ['sub_frame']);
  assert.deepEqual(one('||x.com/a$frame').condition.resourceTypes, ['sub_frame']);
  assert.deepEqual(one('||x.com/a$other').condition.resourceTypes, ['other', 'csp_report', 'webtransport', 'webbundle']);
  assert.deepEqual(one('||x.com/a$beacon').condition.resourceTypes, ['ping']);
  // Negated types: everything but those (and never main_frame implicitly).
  const neg = one('||x.com/a$~script,~image').condition.resourceTypes!;
  assert.ok(!neg.includes('script') && !neg.includes('image') && !neg.includes('main_frame'));
  assert.ok(neg.includes('sub_frame') && neg.includes('xmlhttprequest'));
  // $all includes main_frame (the popup part goes to the popup blocker).
  assert.ok(one('||x.com/a$all').condition.resourceTypes!.includes('main_frame'));
  // Safari: drop types it doesn't know.
  assert.deepEqual(one('||x.com/a$other,object,script', 'safari').condition.resourceTypes, ['script', 'other']);
  assert.ok(one('||x.com/a', 'safari').condition.resourceTypes!.length > 5, 'safari always lists types');
});

test('exceptions → allow / allowAllRequests', () => {
  assert.deepEqual(one('@@||x.com/ads/good.js'), { priority: 2000, action: { type: 'allow' }, condition: { urlFilter: '||x.com/ads/good.js' } });
  assert.deepEqual(one('@@||cdn.x.com^$script,domain=a.com'), {
    priority: 2000, action: { type: 'allow' }, condition: { requestDomains: ['cdn.x.com'], initiatorDomains: ['a.com'], resourceTypes: ['script'] },
  });
  assert.deepEqual(one('@@||trusted.example^$document'), {
    priority: 2000, action: { type: 'allowAllRequests' }, condition: { requestDomains: ['trusted.example'], resourceTypes: ['main_frame', 'sub_frame'] },
  });
  // $document plus other types: allowAllRequests + allow.
  const both = compileNetworkRule(net('@@||t.example^$document,image'));
  assert.ok(both.ok);
  assert.deepEqual(both.rules.map((r) => r.action.type), ['allowAllRequests', 'allow']);
  assert.deepEqual(both.rules[1]!.condition.resourceTypes, ['image']);
  // Cosmetic-only page exceptions are not network rules.
  assert.deepEqual(fails('@@||x.com^$generichide'), { ok: false, reason: 'cosmetic-only', notInDnr: true });
  assert.deepEqual(fails('@@||x.com^$elemhide'), { ok: false, reason: 'cosmetic-only', notInDnr: true });
  assert.equal(fails('@@||x.com^$redirect=noop.js').reason, 'redirect-exception');
});

test('$important outranks exceptions', () => {
  const imp = one('||ads.example^$important');
  const exc = one('@@||ads.example^');
  assert.equal(imp.priority, PRIORITY.IMPORTANT);
  assert.ok(imp.priority > exc.priority);
  assert.ok(one('@@||x.com^$document').priority < imp.priority);
  assert.deepEqual(one('||ads.example/x.js$important,redirect=noop.js').priority, PRIORITY.IMPORTANT + 1);
});

test('$redirect uses bundled neutral resources', () => {
  assert.deepEqual(one('||x.com/ga.js$script,redirect=google-analytics_analytics.js'), {
    priority: 1001, action: { type: 'redirect', redirect: { extensionPath: '/resources/google-analytics_analytics.js' } },
    condition: { urlFilter: '||x.com/ga.js', resourceTypes: ['script'] },
  });
  assert.equal(one('||x.com/a.js$script,redirect=noopjs').action.redirect!.extensionPath, '/resources/noop.js');
  assert.equal(one('||x.com/a.js$script,redirect=noop.js:5').action.redirect!.extensionPath, '/resources/noop.js');
  assert.equal(one('||x.com/a.gif$image,redirect=1x1-transparent.gif').action.redirect!.extensionPath, '/resources/1x1.gif');
  assert.equal(one('||x.com/a.png$image,redirect=ubo-2x2.png').action.redirect!.extensionPath, '/resources/2x2.png');
  assert.equal(one('||x.com/a$xhr,empty').action.redirect!.extensionPath, '/resources/noop.txt');
  assert.equal(one('||x.com/a$script,rewrite=abp-resource:blank-js').action.redirect!.extensionPath, '/resources/noop.js');
  // Unknown resource: still blocks (redirect implies block).
  const r = compileNetworkRule(net('||x.com/a.js$script,redirect=nonexistent-thing.js'));
  assert.ok(r.ok);
  assert.deepEqual(r.rules[0]!.action, BLOCK);
  assert.equal(r.note, 'redirect-unknown-as-block');
  // $redirect-rule needs "only if something else blocks" — DNR can't say that.
  assert.equal(fails('||x.com/a.js$script,redirect-rule=noop.js').reason, 'redirect-rule');
});

test('$removeparam → redirect with queryTransform', () => {
  assert.deepEqual(one('$removeparam=utm_source'), {
    priority: 1000, action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: ['utm_source'] } } } },
    condition: { urlFilter: '^utm_source=', resourceTypes: ['main_frame', 'sub_frame', 'script', 'stylesheet', 'image', 'font', 'media', 'xmlhttprequest', 'websocket', 'ping', 'object', 'other', 'csp_report', 'webtransport', 'webbundle'] },
  });
  assert.deepEqual(one('||x.com^$removeparam=fbclid,document').condition, { requestDomains: ['x.com'], urlFilter: '^fbclid=', resourceTypes: ['main_frame'] });
  assert.deepEqual(one('||x.com/path$removeparam=fbclid').condition.urlFilter, '||x.com/path');
  assert.equal(one('||x.com^$removeparam,document').condition.urlFilter, '?');
  assert.deepEqual(one('||x.com^$removeparam,document').action, { type: 'redirect', redirect: { transform: { query: '' } } });
  assert.equal(fails('$removeparam=/^utm_/').reason, 'removeparam-regex');
  assert.equal(fails('$removeparam=~keep').reason, 'removeparam-allExcept');
});

test('$csp and $removeheader → modifyHeaders', () => {
  assert.deepEqual(one("||x.com^$csp=script-src 'self'"), {
    priority: 1000,
    action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: "script-src 'self'" }] },
    condition: { requestDomains: ['x.com'], resourceTypes: ['main_frame', 'sub_frame'] },
  });
  assert.deepEqual(one('||x.com^$removeheader=refresh').action, { type: 'modifyHeaders', responseHeaders: [{ header: 'refresh', operation: 'remove' }] });
  // Protected headers are refused at parse time (same policy as the Rust engine).
  assert.equal(parseLine('||x.com^$removeheader=content-security-policy').kind, 'unsupported');
  assert.equal(parseLine('||x.com^$removeheader=request:cookie').kind, 'unsupported');
});

test('regex rules → regexFilter; RE2-incompatible ones dropped', () => {
  assert.deepEqual(one('/^https?:\\/\\/ads\\d+\\./').condition, { regexFilter: '^https?:\\/\\/ads\\d+\\.' });
  assert.equal(fails('/ad(?=s)\\.js/').reason, 'regex-not-re2');
  assert.equal(fails('/(ab)\\1/').reason, 'regex-not-re2');
  assert.ok(regexLooksRe2Compatible('^https?://[a-z]+\\.js$'));
  assert.ok(!regexLooksRe2Compatible('foo(?<!bar)'));
  // `/path/` without regex meta is a plain path, not a regex.
  assert.deepEqual(one('/adbanner/').condition, { urlFilter: '/adbanner/' });
});

test('popup rules are left to the popup blocker', () => {
  assert.deepEqual(fails('||popads.example^$popup'), { ok: false, reason: 'popup-only', notInDnr: true });
  assert.deepEqual(fails('||popads.example^$popup,third-party'), { ok: false, reason: 'popup-only', notInDnr: true });
  // Mixed: the non-popup part still compiles.
  assert.deepEqual(one('||ads.example/x$popup,script').condition.resourceTypes, ['script']);
});

test('host anchor followed by wildcard degrades to an unanchored filter', () => {
  assert.deepEqual(one('||*ads.js').condition, { urlFilter: 'ads.js' });
});

// ---------- whole-set compilation ----------

function set(lines: string[]): NetworkRule[] {
  return Engine.fromLists([lines.join('\n')]).networkRules;
}

test('merges pure host rules with identical conditions', () => {
  const r = compileToDnr(set(['||a.com^', '||b.com^', '||c.com^$third-party', '||d.com^$third-party', '||e.com^$script', '||f.com/x']));
  const doms = r.dynamic.filter((x) => x.condition.requestDomains).map((x) => [x.condition.requestDomains, x.condition.domainType ?? null, x.condition.resourceTypes ?? null]);
  assert.deepEqual(doms.sort(), [
    [['a.com', 'b.com'], null, null],
    [['c.com', 'd.com'], 'thirdParty', null],
    [['e.com'], null, ['script']],
  ].sort());
  assert.equal(r.dynamic.length, 4);
  assert.equal(r.stats.mergedHostRules, 5);
});

test('merging drops subdomains covered by a parent and chunks big lists', () => {
  const r = compileToDnr(set(['||a.com^', '||x.a.com^', '||y.x.a.com^', '||b.com^']));
  assert.deepEqual(r.dynamic[0]!.condition.requestDomains, ['a.com', 'b.com']);
  const many = Array.from({ length: 2500 }, (_, i) => `||h${i}.example^`);
  const r2 = compileToDnr(set(many), { mergeChunk: 1000 });
  assert.deepEqual(r2.dynamic.map((x) => x.condition.requestDomains!.length), [1000, 1000, 500]);
});

test('ids are unique, start after the reserved allowlist slot, session ids separate', () => {
  const r = compileToDnr(set(['||a.com/1', '||a.com/2', '||a.com/3', '@@||a.com/2']), { limits: { dynamic: 3, dynamicUnsafe: 3, session: 10, sessionUnsafe: 10, regex: 10 } });
  assert.deepEqual(r.dynamic.map((x) => x.id), [2, 3]);
  assert.deepEqual(r.session.map((x) => x.id), [1, 2]);
  // Exceptions are placed first.
  assert.equal(r.dynamic[0]!.action.type, 'allow');
});

test('limits: prioritises exceptions > important > unsafe > hosts > rest, reports drops', () => {
  const lines = [
    '/generic1/', '/generic2/', '/generic3/',
    '||h1.com^', '||h2.com^$script',
    '||imp.com/x$important',
    '@@||ok.com/x',
    '||r.com/a.js$script,redirect=noop.js',
  ];
  const r = compileToDnr(set(lines), { limits: { dynamic: 6, dynamicUnsafe: 1, session: 0, sessionUnsafe: 0, regex: 1000 } });
  const kinds = r.dynamic.map((x) => `${x.action.type}:${x.condition.urlFilter ?? x.condition.requestDomains?.join(',')}`);
  assert.deepEqual(kinds, ['allow:||ok.com/x', 'block:||imp.com/x', 'redirect:||r.com/a.js', 'block:h1.com', 'block:h2.com']);
  assert.deepEqual(r.droppedByReason, { 'rule-limit': 3 });
  assert.deepEqual(r.dropped.map((d) => d.raw), ['/generic1/', '/generic2/', '/generic3/']);
});

test('limits: unsafe cap and overflow into session rules', () => {
  const lines = ['||a.com/1.js$redirect=noop.js', '||a.com/2.js$redirect=noop.js', '||a.com/3.js$redirect=noop.js', '/b1/', '/b2/'];
  const r = compileToDnr(set(lines), { limits: { dynamic: 4, dynamicUnsafe: 1, session: 2, sessionUnsafe: 1, regex: 10 } });
  assert.equal(r.dynamic.filter((x) => x.action.type === 'redirect').length, 1);
  assert.equal(r.session.filter((x) => x.action.type === 'redirect').length, 1);
  assert.equal(r.droppedByReason['unsafe-rule-limit'], 1);
  assert.equal(r.dynamic.length, 3); // 1 redirect + 2 blocks
  assert.equal(r.stats.unsafeRules, 2);
});

test('limits: regex cap and runtime RE2 check', () => {
  const r = compileToDnr(set(['/a[0-9]+\\.js/', '/b[0-9]+\\.js/', '/c[0-9]+\\.js/']), { limits: { dynamic: 100, dynamicUnsafe: 10, session: 0, sessionUnsafe: 0, regex: 2 } });
  assert.equal(r.stats.regexRules, 2);
  assert.equal(r.droppedByReason['regex-limit'], 1);
  const r2 = compileToDnr(set(['/a[0-9]+\\.js/', '/b[0-9]+\\.js/']), { isRegexSupported: (s) => !s.startsWith('b') });
  assert.equal(r2.droppedByReason['regex-unsupported'], 1);
  assert.equal(r2.dynamic.length, 1);
});

test('$badfilter removes rules before compilation', () => {
  const r = compileToDnr(set(['||a.com/x', '||a.com/x$badfilter', '||b.com/y']));
  assert.deepEqual(r.dynamic.map((x) => x.condition.urlFilter), ['||b.com/y']);
});

test('duplicates are removed', () => {
  const r = compileToDnr(set(['||a.com/x', '||a.com/x', '||A.com/x']));
  assert.equal(r.dynamic.length, 1);
  assert.equal(r.notes['duplicate'], 2);
});

test('modifier exceptions fold into the modifier rules', () => {
  // Pure host exception → excludedRequestDomains.
  let r = compileToDnr(set(['$removeparam=utm_source', '@@||bank.example^$removeparam=utm_source']));
  assert.deepEqual(r.dynamic[0]!.condition.excludedRequestDomains, ['bank.example']);
  // Value-less exception cancels every removeparam rule for that host.
  r = compileToDnr(set(['$removeparam=a', '$removeparam=b', '@@||bank.example^$removeparam']));
  assert.ok(r.dynamic.every((x) => x.condition.excludedRequestDomains?.includes('bank.example')));
  // Domain-only exception → excludedInitiatorDomains.
  r = compileToDnr(set(['$removeparam=utm_source', '@@$removeparam=utm_source,domain=shop.example']));
  assert.deepEqual(r.dynamic[0]!.condition.excludedInitiatorDomains, ['shop.example']);
  // Same pattern exception removes the rule.
  r = compileToDnr(set(["||x.com/p$csp=script-src 'none'", "@@||x.com/p$csp=script-src 'none'"]));
  assert.equal(r.dynamic.length, 0);
  // Global exception removes everything of that kind.
  r = compileToDnr(set(['||x.com^$removeheader=refresh', '@@$removeheader']));
  assert.equal(r.dynamic.length, 0);
  // Exceptions with a value only cancel that value.
  r = compileToDnr(set(['$removeparam=a', '$removeparam=b', '@@||s.example^$removeparam=a']));
  const byParam = Object.fromEntries(r.dynamic.map((x) => [x.action.redirect!.transform!.queryTransform!.removeParams![0], x.condition.excludedRequestDomains]));
  assert.deepEqual(byParam, { a: ['s.example'], b: undefined });
  // Unsupported shape is reported.
  r = compileToDnr(set(['$removeparam=a', '@@/weird/path$removeparam=a']));
  assert.equal(r.droppedByReason['modifier-exception-unsupported'], 1);
});

test('notInDnr accounting', () => {
  const r = compileToDnr(set(['||p.com^$popup', '@@||x.com^$generichide', '||a.com/x']));
  assert.deepEqual(r.notInDnr, { 'popup-only': 1, 'cosmetic-only': 1 });
  assert.equal(r.dropped.length, 0);
});

test('allowlist rule', () => {
  assert.deepEqual(allowlistRule(['example.com', 'news.example.org']), {
    id: 1, priority: 10000, action: { type: 'allowAllRequests' },
    condition: { requestDomains: ['example.com', 'news.example.org'], resourceTypes: ['main_frame', 'sub_frame'] },
  });
  assert.equal(allowlistRule([]), null);
  assert.ok(allowlistRule(['x.com'])!.priority > PRIORITY.IMPORTANT);
});

test('install tiers: primary-list rules are kept when the rule limit is reached', () => {
  // List 0 = primary, list 1 = optional. The optional list's rules sort first in
  // list order, but only 3 slots exist (1 reserved): its rules must lose.
  const e = Engine.fromLists(['||p1.com/ad\n||p2.com/ad\n||shared.com^', '@@||ok.com/x\n||o1.com/ad\n||o2.com/ad\n||shared.com^\n||only-opt.com^']);
  const tierOf = (i: number) => e.networkRuleList[i]!;
  const lim = { dynamic: 6, dynamicUnsafe: 6, session: 0, sessionUnsafe: 0, regex: 10 };
  const r = compileToDnr(e.networkRules, { limits: lim, tierOf });
  const kept = r.dynamic.map((x) => x.condition.urlFilter ?? x.condition.requestDomains!.join(','));
  // exception first (even from the optional list), then the primary list (merged hosts,
  // then path rules), then what fits.
  assert.deepEqual(kept.slice(0, 4), ['||ok.com/x', 'shared.com', '||p1.com/ad', '||p2.com/ad']);
  assert.equal(r.dynamic.length, 5);
  // shared.com is not repeated in the optional list's merged host rule.
  assert.ok(!r.dynamic.some((x) => x.condition.requestDomains?.includes('shared.com') && x.condition.requestDomains.includes('only-opt.com')));
  assert.ok(r.dropped.every((d) => /o1|o2|only-opt/.test(d.raw)), JSON.stringify(r.dropped));
  // Without tiers, list order alone would have dropped primary rules: not the case with tiers.
  assert.ok(!r.dropped.some((d) => /p1|p2/.test(d.raw)));
});
