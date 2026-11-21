// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Sponsored-content pre-filters: disclosure labels in many languages,
// affiliate / ad-network URLs, scoring and the model / no-model thresholds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeDiscloses, blockTooLarge, cacheSelector, decideBlock, disclosureStrength, isAdNetworkUrl, isAffiliateUrl, isProtectedElement, scoreBlock,
} from '../../src/shared/sponsored.ts';
import type { BlockFeatures } from '../../src/shared/sponsored.ts';

const none: BlockFeatures = { labels: [], attrDisclosures: 0, relSponsored: 0, affiliateLinks: 0, adFrames: 0, tokenHints: 0 };

test('disclosure labels in many languages; ordinary text is not one', () => {
  for (const s of ['Sponsored', 'SPONSORED', '· Promoted', 'Anzeige', 'Werbung', 'Sponsorisé', 'Publicité', 'Patrocinado', 'Publicidad', 'Sponsorizzato', 'Gesponsord',
    'Sponsorowane', 'Реклама', '広告', '赞助', '광고', 'Sponsored by Acme', 'Advertisement', 'Paid partnership', 'Sponsored · Acme Inc']) {
    assert.equal(disclosureStrength(s), 'strong', s);
  }
  assert.equal(disclosureStrength('Ad'), 'weak');
  assert.equal(disclosureStrength('Ads'), 'weak');
  for (const s of ['Our sponsors make this possible and we thank them for their support', 'Read more', 'Advertise with us today and reach millions', 'Sponsoring', '']) {
    assert.equal(disclosureStrength(s), null, s);
  }
  assert.ok(attributeDiscloses('Sponsored offer'));
  assert.ok(attributeDiscloses('Anzeige'));
  assert.ok(!attributeDiscloses('Related stories'));
});

test('affiliate and ad-network URL patterns', () => {
  for (const u of ['https://amzn.to/3xYz', 'https://www.amazon.com/dp/B000?tag=site-20', 'https://www.awin1.com/cread.php?awinmid=1', 'https://click.linksynergy.com/deeplink?id=x',
    'https://go.skimresources.com/?id=1', 'https://www.anrdoezrs.net/click-1', 'https://shop.example/aff/item?aff_id=99']) assert.ok(isAffiliateUrl(u), u);
  for (const u of ['https://www.amazon.com/dp/B000', 'https://example.com/?tag=news', 'https://news.example/article', 'not a url']) assert.ok(!isAffiliateUrl(u), u);
  for (const u of ['https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html', 'https://ad.doubleclick.net/x', 'https://cdn.taboola.com/w']) assert.ok(isAdNetworkUrl(u), u);
  assert.ok(!isAdNetworkUrl('https://www.youtube.com/embed/x'));
});

test('scoring and thresholds: clear cases hidden, ambiguous asked (model) or kept (no model)', () => {
  const labelled = { ...none, labels: [{ text: 'Sponsored', strength: 'strong' as const }], affiliateLinks: 1 };
  assert.equal(scoreBlock(labelled).score, 6);
  assert.equal(decideBlock(6, true), 'hide');
  assert.equal(decideBlock(6, false), 'hide');
  const weak = { ...none, labels: [{ text: 'Ad', strength: 'weak' as const }] };
  assert.equal(scoreBlock(weak).score, 2);
  assert.equal(decideBlock(2, true), 'ask');
  assert.equal(decideBlock(2, false), 'keep', 'stricter without the model');
  assert.equal(decideBlock(4, false), 'keep');
  assert.equal(decideBlock(scoreBlock({ ...none, labels: [{ text: 'Sponsored', strength: 'strong' }] }).score, false), 'keep', 'a label alone is not enough without the model');
  assert.equal(decideBlock(scoreBlock({ ...none, adFrames: 1, tokenHints: 1 }).score, false), 'hide');
  assert.equal(decideBlock(scoreBlock(none).score, true), 'keep');
  assert.equal(decideBlock(scoreBlock({ ...none, tokenHints: 3 }).score, true), 'keep');
});

test('never main/article/body; large blocks refused', () => {
  for (const t of ['MAIN', 'article', 'BODY', 'html']) assert.ok(isProtectedElement(t, null), t);
  assert.ok(isProtectedElement('div', 'main'));
  assert.ok(!isProtectedElement('div', null));
  assert.ok(blockTooLarge(5000, 8000, 100, 1000));
  assert.ok(blockTooLarge(100, 8000, 900, 1000));
  assert.ok(!blockTooLarge(300, 8000, 100, 1000));
});

test('cache selectors narrow the layout selector by the evidence', () => {
  assert.equal(cacheSelector('div.card', { ...none, labels: [{ text: 'Sponsored', strength: 'strong' }] }), 'div.card:has-text(Sponsored)');
  assert.equal(cacheSelector('div.card', { ...none, relSponsored: 1 }), 'div.card:has(a[rel~="sponsored"])');
  assert.equal(cacheSelector('li.item', { ...none, adFrames: 1 }, 'ad.doubleclick.net'), 'li.item:has(iframe[src*="ad.doubleclick.net"])');
  assert.equal(cacheSelector('div.card', none), null);
  assert.equal(cacheSelector('', { ...none, relSponsored: 1 }), null);
});

test('model answer: enum label (real model) and boolean (stub) shapes', async () => {
  const { readSponsoredAnswer, sponsoredPrompt, SPONSORED_SCHEMA } = await import('../../src/shared/sponsored.ts');
  assert.equal(readSponsoredAnswer({ about: 'meal kit discount', kind: 'ad' }), true);
  assert.equal(readSponsoredAnswer({ about: 'bus strike', kind: 'editorial' }), false);
  assert.equal(readSponsoredAnswer({ kind: 'other' }), false);
  assert.equal(readSponsoredAnswer({ sponsored: true }), true);
  assert.equal(readSponsoredAnswer({ kind: 'maybe' }), null);
  assert.equal(readSponsoredAnswer(null), null);
  assert.deepEqual(SPONSORED_SCHEMA.required, ['about', 'kind']);
  const p = sponsoredPrompt('Offer  Bus drivers reject pay offer', 'Offer', ['news.example'], 'news.example');
  assert.match(p, /Short label shown on the block: "Offer"/);
  assert.doesNotMatch(p, /Signals found/);
});

test('block growth guard and navigation-like blocks (real-site false positives)', async () => {
  const { growsTooMuch, looksLikeNavigation } = await import('../../src/shared/sponsored.ts');
  // "Advertisement" slot (13 chars) inside a rail with weather + games (600): stop.
  assert.equal(growsTooMuch(13, 600), true);
  // Label header (30) → whole sponsored card (250): keep climbing.
  assert.equal(growsTooMuch(30, 250), false);
  assert.equal(growsTooMuch(400, 1100), false);
  const menu = ['Humankind', 'Advertise Your Business', 'Just Curious', 'Booklist', 'Legals', 'Press Releases'].map((text) => ({ host: 'www.usatoday.com', text }));
  assert.equal(looksLikeNavigation(menu, 'www.usatoday.com'), true);
  const footer = [['legal.yahoo.com', 'Terms'], ['guce.yahoo.com', 'Privacy Dashboard'], ['x.com', 'X'], ['www.facebook.com', 'Facebook'], ['www.yahooinc.com', 'Careers']].map(([host, text]) => ({ host, text }));
  assert.equal(looksLikeNavigation(footer, 'www.yahoo.com'), true, 'own site + social profiles (4/5)');
  const taboola = [['trk.novatrendnews.com', 'The heater everyone is talking about'], ['popup.taboola.com', 'AdChoices'], ['www.healthinsight.ca', 'What does your LDL-C level really mean'], ['visionaryecho.com', 'How to look up your home value'], ['topgadgetinsider.com', 'Hidden wallet tracker']].map(([host, text]) => ({ host, text }));
  assert.equal(looksLikeNavigation(taboola, 'www.usatoday.com'), false);
  assert.equal(looksLikeNavigation(menu.slice(0, 3), 'www.usatoday.com'), false, 'too few links');
});

test('a section of own-site links with only a label is not sent to the model', async () => {
  const { ownSectionWithLabelOnly } = await import('../../src/shared/sponsored.ts');
  const label = { ...none, labels: [{ text: 'Advertisement', strength: 'strong' as const }] };
  const yahoo = ['weather.yahoo.com', 'www.yahoo.com', 'www.yahoo.com', 'www.yahoo.com', 'www.yahoo.com'];
  assert.equal(ownSectionWithLabelOnly(label, yahoo, 'www.yahoo.com'), true);
  assert.equal(ownSectionWithLabelOnly({ ...label, relSponsored: 1 }, yahoo, 'www.yahoo.com'), false, 'more evidence than the label');
  assert.equal(ownSectionWithLabelOnly(label, ['www.yahoo.com', 'advertiser.example'], 'www.yahoo.com'), false, 'a native ad card: few links');
  assert.equal(ownSectionWithLabelOnly(label, ['a.example', 'b.example', 'www.yahoo.com'], 'www.yahoo.com'), false, 'off-site links');
  assert.equal(ownSectionWithLabelOnly(none, yahoo, 'www.yahoo.com'), false, 'no label');
});

test('display-ad captions vs native labels; mixed feed containers', async () => {
  const { isDisplayCaption, mixedFeedContainer } = await import('../../src/shared/sponsored.ts');
  for (const s of ['Advertisement', 'ADVERTISEMENT', 'Anzeige', 'Publicité']) assert.equal(isDisplayCaption(s), true, s);
  assert.equal(isDisplayCaption('Ad'), false, 'a short native label ("Techno Mag | Ad"): the whole card is the unit');
  for (const s of ['Sponsored', 'Promoted', 'Paid Content', 'Sponsored by Chase']) assert.equal(isDisplayCaption(s), false, s);
  const page = 'www.independent.co.uk';
  const mixed = [
    { host: 'www.independent.co.uk', text: 'Two dead and three injured in crash following police chase' },
    { host: 'www.independent.co.uk', text: 'Princess Kate to make royal tour comeback after cancer battle' },
    { host: 'putaianddatatowork.cio.com', text: 'What the AI era means for your data' },
  ];
  assert.equal(mixedFeedContainer(mixed, page), true);
  assert.equal(mixedFeedContainer(mixed.slice(1), page), true, 'one own headline + one paid item (Independent feed card)');
  assert.equal(mixedFeedContainer([mixed[2]!], page), false, 'only the paid item');
  assert.equal(mixedFeedContainer(mixed.slice(0, 2), page), false, 'no outside link: the site\'s own list');
});
