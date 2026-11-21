// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Fix-this-site exceptions: line construction (narrow, site-scoped), the
// engine overlay (Firefox webRequest decisions, cosmetics, scriptlets), DNR
// compilation (Chrome/Safari), expiry, risk ranking and breakage signals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../../src/shared/parse.ts';
import { Engine, overlayLineProblem } from '../../src/shared/engine.ts';
import {
  activeLines, compileOverlayDnr, cosmeticExceptionLine, DAY_MS, DEFAULT_TTL_MS, isActive, isOverlayId, makePermanent,
  networkExceptionLines, newException, nextExpiry, OVERLAY_FIRST_ID, pruneExpired, removeException, scriptletExceptionLine,
} from '../../src/shared/exceptions.ts';
import { compileToDnr, PRIORITY } from '../../src/shared/dnr.ts';
import { isKnownAdNetwork, networkTier, rankCandidates, TIER } from '../../src/shared/risk.ts';
import type { BreakageCandidate } from '../../src/shared/risk.ts';
import { breakageScore, classifyJsError, errorSignature, isQuickToggle, recordReload, shouldSuggestFix } from '../../src/shared/signals.ts';
import { RT } from '../../src/shared/types.ts';
import type { NetworkRule } from '../../src/shared/types.ts';

const LIST = String.raw`
||adnet.test^
||tracker.test^$third-party
||imp.test^$important
||broken-fp.test/js/widgets.js
/regex-ad[0-9]+\.js/$script
||cdn.thirdparty.test^$script
||redir.test/gpt.js$script,redirect=googletagservices_gpt.js
##.sidebar-ad
broken.test##.promo-box
broken.test#?#.box:has-text(Sponsored)
broken.test,other.test##+js(set-constant, SiteApp, undefined)
broken.test##+js(abort-on-property-read, Tracker\, x)
`;

function rule(line: string): NetworkRule {
  const p = parseLine(line);
  assert.equal(p.kind, 'network');
  return (p as { rule: NetworkRule }).rule;
}

const S = RT.SCRIPT;

test('network exception lines are narrow and site-scoped', () => {
  // Host-only rule, not an ad network: the blocked host, on this site only.
  assert.deepEqual(networkExceptionLines({ rule: rule('||cdn.thirdparty.test^$script'), urls: ['http://a.cdn.thirdparty.test/x.js'], site: 'broken.test', adNetwork: false }),
    ['@@||a.cdn.thirdparty.test^$script,domain=broken.test']);
  // Host-only rule on an ad network: never the whole network, only the URLs the page needed.
  assert.deepEqual(networkExceptionLines({ rule: rule('||adnet.test^'), urls: ['http://ads.adnet.test/ads/ad.js?cb=1', 'http://ads.adnet.test/ads/ad.js?cb=2'], site: 'broken.test', adNetwork: true }),
    ['@@||ads.adnet.test/ads/ad.js$domain=broken.test']);
  assert.deepEqual(networkExceptionLines({ rule: rule('||adnet.test^'), urls: ['http://ads.adnet.test/'], site: 'broken.test', adNetwork: true }), []);
  // Pattern rule: exact pattern + types + $domain; redirect dropped, important kept.
  assert.deepEqual(networkExceptionLines({ rule: rule('||broken-fp.test/js/widgets.js'), urls: [], site: 'broken-fp.test', adNetwork: false }),
    ['@@||broken-fp.test/js/widgets.js$domain=broken-fp.test']);
  assert.deepEqual(networkExceptionLines({ rule: rule('||redir.test/gpt.js$script,redirect=googletagservices_gpt.js'), urls: [], site: 's.test', adNetwork: false }),
    ['@@||redir.test/gpt.js$script,domain=s.test']);
  assert.deepEqual(networkExceptionLines({ rule: rule('||imp.test^$important'), urls: ['http://imp.test/x.gif'], site: 's.test', adNetwork: false }),
    ['@@||imp.test^$important,domain=s.test']);
  assert.deepEqual(networkExceptionLines({ rule: rule(String.raw`/regex-ad[0-9]+\.js/$script`), urls: [], site: 's.test', adNetwork: false }),
    [String.raw`@@/regex-ad[0-9]+\.js/$script,domain=s.test`]);
  // Never a page-wide exception.
  assert.deepEqual(networkExceptionLines({ rule: rule('||x.test^$document'), urls: [], site: 's.test', adNetwork: false }).filter((l) => l.includes('document')), []);
});

test('cosmetic and scriptlet exception lines', () => {
  assert.equal(cosmeticExceptionLine('broken.test', '.promo-box'), 'broken.test#@#.promo-box');
  assert.equal(scriptletExceptionLine('broken.test', { name: 'set-constant', args: ['SiteApp', 'undefined'] }), 'broken.test#@#+js(set-constant, SiteApp, undefined)');
  assert.equal(scriptletExceptionLine('broken.test', { name: 'abort-on-property-read', args: ['Tracker, x'] }), 'broken.test#@#+js(abort-on-property-read, Tracker\\, x)');
});

test('overlay refuses broad exceptions (whole site / whole network / page-wide)', () => {
  for (const bad of ['@@||adnet.test^', '@@||broken.test^$document', '@@||broken.test^$generichide', '#@#.promo-box', 'broken.test#@#+js()',
    '##.ad', '@@||x.test^$removeparam=a,domain=s.test', '@@||x.test^$domain=~s.test', '@@||x.test^$domain=google.*', '#@#+js(set-constant, a, b)']) {
    assert.notEqual(overlayLineProblem(bad), null, bad);
  }
  for (const good of ['@@||adnet.test/ads/ad.js$domain=s.test', 'broken.test#@#.promo-box', 'broken.test#@#+js(set-constant, SiteApp, undefined)', 'broken.test#@#.box:has-text(Sponsored)']) {
    assert.equal(overlayLineProblem(good), null, good);
  }
});

test('engine overlay: network exceptions take effect on the site only (webRequest path)', () => {
  const e = Engine.fromLists([LIST]);
  const widget = { url: 'http://broken-fp.test/js/widgets.js', sourceHost: 'broken-fp.test', type: S };
  const ad = { url: 'http://ads.adnet.test/ads/ad.js', sourceHost: 'broken-fp.test', type: S };
  assert.equal(e.check(widget).action, 'block');
  const res = e.setOverlay(['@@||broken-fp.test/js/widgets.js$domain=broken-fp.test', '@@||adnet.test^']);
  assert.equal(res.accepted, 1);
  assert.equal(res.rejected[0]!.reason, 'not-site-scoped');
  assert.equal(e.check(widget).action, 'excepted');
  assert.equal(e.check(ad).action, 'block', 'ads elsewhere on the page stay blocked');
  assert.equal(e.check({ ...widget, sourceHost: 'other.test' }).action, 'block', 'other sites unaffected');
  // $important needs an $important exception.
  e.setOverlay(['@@||imp.test^$domain=s.test']);
  assert.equal(e.check({ url: 'http://imp.test/x.gif', sourceHost: 's.test', type: RT.IMAGE }).action, 'block');
  e.setOverlay(['@@||imp.test^$important,domain=s.test']);
  assert.equal(e.check({ url: 'http://imp.test/x.gif', sourceHost: 's.test', type: RT.IMAGE }).action, 'excepted');
  e.setOverlay([]);
  assert.equal(e.check(widget).action, 'block');
});

test('engine overlay: cosmetic, procedural and scriptlet exceptions', () => {
  const e = Engine.fromLists([LIST]);
  assert.deepEqual(e.scriptlets('broken.test').map((s) => s.name).sort(), ['abort-on-property-read', 'set-constant']);
  e.setOverlay([
    scriptletExceptionLine('broken.test', { name: 'set-constant', args: ['SiteApp', 'undefined'] }),
    cosmeticExceptionLine('broken.test', '.promo-box'),
    cosmeticExceptionLine('broken.test', '.sidebar-ad'),
    cosmeticExceptionLine('broken.test', '.box:has-text(Sponsored)'),
  ]);
  assert.deepEqual(e.scriptlets('broken.test').map((s) => s.name), ['abort-on-property-read'], 'only the exact call is excepted');
  assert.deepEqual(e.scriptlets('other.test').map((s) => s.name), ['set-constant'], 'other site keeps the scriptlet');
  const c = e.cosmeticsFor('broken.test')!;
  assert.ok(!c.specific.includes('.promo-box'));
  assert.deepEqual(e.genericForTokens('broken.test', ['.sidebar-ad']), []);
  assert.deepEqual(e.genericForTokens('publisher.test', ['.sidebar-ad']), ['.sidebar-ad']);
  assert.deepEqual(e.procedural('broken.test'), []);
  // Subdomains of the site are covered too (same site).
  assert.deepEqual(e.genericForTokens('www.broken.test', ['.sidebar-ad']), []);
});

test('DNR overlay: exceptions compile to allow rules in the reserved id range', () => {
  const lines = [
    '@@||broken-fp.test/js/widgets.js$domain=broken-fp.test',
    '@@||a.cdn.thirdparty.test^$script,domain=broken.test',
    '@@||imp.test^$important,domain=s.test',
    'broken.test#@#.promo-box', // not network: ignored here
    '@@||adnet.test^', // refused
  ];
  const { rules, dropped } = compileOverlayDnr(lines);
  assert.deepEqual(rules, [
    { id: OVERLAY_FIRST_ID, priority: PRIORITY.EXCEPTION, action: { type: 'allow' }, condition: { urlFilter: '||broken-fp.test/js/widgets.js', initiatorDomains: ['broken-fp.test'] } },
    { id: OVERLAY_FIRST_ID + 1, priority: PRIORITY.EXCEPTION, action: { type: 'allow' }, condition: { requestDomains: ['a.cdn.thirdparty.test'], initiatorDomains: ['broken.test'], resourceTypes: ['script'] } },
    { id: OVERLAY_FIRST_ID + 2, priority: PRIORITY.IMPORTANT + 100, action: { type: 'allow' }, condition: { requestDomains: ['imp.test'], initiatorDomains: ['s.test'] } },
  ]);
  assert.deepEqual(dropped, [{ line: '@@||adnet.test^', reason: 'not-site-scoped' }]);
  assert.ok(rules.every((r) => isOverlayId(r.id)));
  // The filter-list rules installed next to them start after the reserved block.
  const main = compileToDnr(Engine.fromLists([LIST]).networkRules, { reservedDynamic: OVERLAY_FIRST_ID + 999 });
  assert.ok(main.dynamic.every((r) => !isOverlayId(r.id) && r.id !== 1));
});

test('DNR overlay priorities beat the blocks they cancel (simulated DNR resolution)', () => {
  const main = compileToDnr(Engine.fromLists([LIST]).networkRules, { reservedDynamic: 1000 }).dynamic;
  const overlay = compileOverlayDnr(['@@||broken-fp.test/js/widgets.js$domain=broken-fp.test', '@@||imp.test^$important,domain=s.test']).rules;
  // Minimal DNR evaluator for the conditions used here.
  const matches = (r: (typeof main)[0], url: string, initiator: string, type: string) => {
    const c = r.condition;
    const host = new URL(url).hostname;
    if (c.requestDomains && !c.requestDomains.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    if (c.initiatorDomains && !c.initiatorDomains.some((d) => initiator === d || initiator.endsWith(`.${d}`))) return false;
    if (c.resourceTypes && !c.resourceTypes.includes(type as never)) return false;
    if (c.urlFilter && !url.includes(c.urlFilter.replace(/^\|\|/, ''))) return false;
    return true;
  };
  const decide = (url: string, initiator: string, type: string) => {
    const hits = [...main, ...overlay].filter((r) => matches(r, url, initiator, type));
    if (!hits.length) return 'none';
    const top = Math.max(...hits.map((r) => r.priority));
    const best = hits.filter((r) => r.priority === top);
    return best.some((r) => r.action.type === 'allow') ? 'allow' : best[0]!.action.type;
  };
  assert.equal(decide('http://broken-fp.test/js/widgets.js', 'broken-fp.test', 'script'), 'allow');
  assert.equal(decide('http://broken-fp.test/js/widgets.js', 'other.test', 'script'), 'block');
  assert.equal(decide('http://ads.adnet.test/ads/ad.js', 'broken-fp.test', 'script'), 'block');
  assert.equal(decide('http://imp.test/x.gif', 's.test', 'image'), 'allow');
  assert.equal(decide('http://imp.test/x.gif', 'other.test', 'image'), 'block');
});

test('expiry: 7-day default, prune, permanent, undo, next expiry', () => {
  const t0 = Date.UTC(2026, 10, 15);
  const a = newException({ kind: 'scriptlet', site: 'broken.test', rule: 'broken.test##+js(set-constant, SiteApp, undefined)', lines: ['broken.test#@#+js(set-constant, SiteApp, undefined)'], reason: 'test' }, t0);
  const b = newException({ kind: 'network', site: 'fp.test', rule: '||fp.test/w.js', lines: ['@@||fp.test/w.js$domain=fp.test'], reason: 'test' }, t0 + DAY_MS);
  assert.equal(a.expiresAt, t0 + DEFAULT_TTL_MS);
  assert.equal(DEFAULT_TTL_MS, 7 * DAY_MS);
  assert.ok(isActive(a, t0 + 7 * DAY_MS - 1));
  assert.ok(!isActive(a, t0 + 7 * DAY_MS));
  let list = [a, b];
  assert.deepEqual(activeLines(list, t0), [...a.lines, ...b.lines]);
  assert.equal(nextExpiry(list, t0), a.expiresAt);
  const { kept, expired } = pruneExpired(list, t0 + 7 * DAY_MS + 1);
  assert.deepEqual(expired.map((x) => x.id), [a.id]);
  assert.deepEqual(kept.map((x) => x.id), [b.id]);
  assert.deepEqual(activeLines(list, t0 + 7 * DAY_MS + 1), b.lines);
  list = makePermanent(list, a.id);
  assert.equal(list[0]!.expiresAt, null);
  assert.ok(isActive(list[0]!, t0 + 1000 * DAY_MS));
  assert.equal(nextExpiry(list, t0), b.expiresAt);
  list = removeException(list, b.id);
  assert.deepEqual(list.map((x) => x.id), [a.id]);
  // Provenance is kept.
  assert.equal(a.rule, 'broken.test##+js(set-constant, SiteApp, undefined)');
  assert.equal(a.source, 'fix-this-site');
  assert.equal(a.createdAt, t0);
});

test('risk ranking: scriptlets, cosmetic specific, generic, 1p, 3p, ad networks; stable ties', () => {
  assert.ok(isKnownAdNetwork('ads.adnet.test'));
  assert.ok(isKnownAdNetwork('securepubads.g.doubleclick.net'));
  assert.ok(isKnownAdNetwork('pagead2.googlesyndication.com'));
  assert.ok(!isKnownAdNetwork('cdn.jsdelivr.net'));
  assert.ok(!isKnownAdNetwork('address.test'));
  assert.equal(networkTier('static.broken.test', 'www.broken.test'), TIER.NETWORK_FIRST_PARTY);
  assert.equal(networkTier('cdn.other.test', 'broken.test'), TIER.NETWORK_THIRD_PARTY);
  assert.equal(networkTier('ads.adnet.test', 'broken.test'), TIER.NETWORK_AD);
  const c = (id: string, tier: number): BreakageCandidate => ({ id, kind: 'network', tier, rule: id, lines: [`l-${id}`] });
  const ranked = rankCandidates([c('ad1', 5), c('3p', 4), c('gen1', 2), c('1p', 3), c('spec', 1), c('sl', 0), c('gen2', 2), c('ad2', 5), { ...c('none', 0), lines: [] }, c('sl', 0)]);
  assert.deepEqual(ranked.map((x) => x.id), ['sl', 'spec', 'gen1', 'gen2', '1p', '3p', 'ad1', 'ad2']);
});

test('breakage signals: JS error classification', () => {
  const blocked = ['http://broken-fp.test/js/widgets.js?v=2'];
  assert.equal(classifyJsError({ message: 'Uncaught ReferenceError: Widgets is not defined' }, []).why, 'undefined-global');
  assert.equal(classifyJsError({ message: "TypeError: Cannot read properties of undefined (reading 'start')" }, []).why, 'undefined-global');
  assert.equal(classifyJsError({ message: 'TypeError: SiteApp is undefined' }, []).why, 'undefined-global');
  assert.equal(classifyJsError({ message: "TypeError: can't access property \"start\", SiteApp is undefined" }, []).why, 'undefined-global');
  assert.equal(classifyJsError({ message: 'Script error', filename: 'http://broken-fp.test/js/widgets.js' }, blocked).why, 'blocked-url');
  assert.equal(classifyJsError({ message: 'SyntaxError: unexpected token' }, blocked).relevant, false);
  assert.equal(errorSignature('Uncaught ReferenceError: x1 is not defined at line 12'), errorSignature('ReferenceError: x1 is not defined at line 99'));
});

test('breakage signals: scoring, reload repeats, quick toggles', () => {
  const now = 1_000_000;
  assert.equal(shouldSuggestFix([{ kind: 'first-party-blocked', at: now }], now), false);
  assert.equal(shouldSuggestFix([{ kind: 'first-party-blocked', at: now }, { kind: 'first-party-blocked', at: now }], now), false, 'distinct kinds only');
  assert.equal(shouldSuggestFix([{ kind: 'js-error', at: now }], now), true);
  assert.equal(shouldSuggestFix([{ kind: 'js-error', at: now - 11 * 60 * 1000 }], now), false, 'old signals expire');
  assert.equal(breakageScore([{ kind: 'explicit', at: now }, { kind: 'first-party-blocked', at: now }], now), 4);
  let h = recordReload([], 'http://a.test/p#x', 0);
  assert.equal(h.repeat, false);
  h = recordReload(h.history, 'http://a.test/p', 20_000);
  assert.equal(h.repeat, true);
  assert.equal(recordReload([{ url: 'http://a.test/p', at: 0 }], 'http://a.test/p', 31_000).repeat, false);
  assert.equal(recordReload([{ url: 'http://a.test/q', at: 0 }], 'http://a.test/p', 1000).repeat, false);
  assert.ok(isQuickToggle(1000, 30_000));
  assert.ok(!isQuickToggle(1000, 120_000));
  assert.ok(!isQuickToggle(undefined, 1000));
});
