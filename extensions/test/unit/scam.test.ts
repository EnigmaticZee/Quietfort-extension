// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Scam / scareware heuristics: each scam family warns; ordinary pages
// (including pages that talk about scams) do not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCAM_ASK, SCAM_WARN, scamDecision, scoreScam } from '../../src/shared/scam.ts';
import type { ScamBehaviour } from '../../src/shared/scam.ts';

const quiet: ScamBehaviour = { fullscreen: 0, beforeunload: 0, history: 0, dialogs: 0, inputLock: 0 };
const score = (text: string, behaviour: Partial<ScamBehaviour> = {}, title = '') => scoreScam({ text, title, behaviour: { ...quiet, ...behaviour } });

test('fake virus alert + tech-support number warns', () => {
  const r = score('Windows Defender Security Alert! Your computer is infected with 5 viruses. Trojan spyware detected. Your personal data will be stolen. Call Microsoft Support immediately at toll free +1 (888) 555-0199. Do not close this window.');
  assert.ok(r.score >= SCAM_WARN, JSON.stringify(r));
  assert.ok(r.categories.includes('fake-virus-alert') && r.categories.includes('tech-support'));
  assert.equal(scamDecision(r.score, false), 'warn');
});

test('browser locker behaviour warns even with little text', () => {
  const r = score('Access to this computer has been blocked. Error code: 0x80070424. Call the helpline 1-844-555-0100 for technical support.', { fullscreen: 2, beforeunload: 1, dialogs: 5, history: 20 });
  assert.ok(r.score >= SCAM_WARN, JSON.stringify(r));
  assert.ok(r.categories.includes('browser-lock'));
});

test('crypto giveaway warns', () => {
  const r = score('Official Elon BTC GIVEAWAY! Send 0.1 to 2 BTC to the address below and we will send back DOUBLE. bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh. Only 30 minutes left!');
  assert.ok(r.score >= SCAM_WARN, JSON.stringify(r));
  assert.ok(r.categories.includes('crypto-giveaway'));
});

test('urgent gift-card payment demand reaches the model threshold; strong combos warn', () => {
  const r = score('FINAL NOTICE: your account will be suspended within 24 hours. To avoid suspension pay the processing fee with Google Play gift cards and send the codes immediately.');
  assert.ok(r.score >= SCAM_ASK, JSON.stringify(r));
  assert.ok(r.categories.includes('urgent-payment'));
});

test('normal pages and pages about scams do not warn', () => {
  const pages = [
    'Welcome to our bakery. We bake fresh bread every morning. Call us at (555) 123-4567 to order a cake for your party. Open Monday to Saturday.',
    'How to spot a tech support scam: scammers may claim your computer is infected and ask you to call a number. Microsoft never asks you to call. If you see such a pop-up, close the browser.',
    'Bitcoin price today: BTC rose 3% as ethereum and solana gained. Analysts expect volatility. Read our crypto market report.',
    'Your order has shipped. Track your parcel online. Gift cards make great presents — shop our gift card collection.',
    'Antivirus review: we tested how well Norton and McAfee detect trojans and spyware in our lab. Results below.',
  ];
  for (const p of pages) {
    const r = score(p);
    assert.equal(scamDecision(r.score, false), 'none', `${p.slice(0, 40)} → ${JSON.stringify(r)}`);
  }
  // A full-screen video player on a normal page is not a locker.
  assert.equal(scamDecision(score('Watch the match live in HD.', { fullscreen: 1 }).score, true), 'none');
});

test('a shop phone number on a page that discusses scams is not a support scam', () => {
  const r = score('Corner bakery. We bake fresh bread every morning. Call us at (555) 123-4567 to order a cake. Open Monday to Saturday. How to spot a tech support scam: scammers may claim your computer is infected and ask you to call a number. Close such pages.');
  assert.equal(scamDecision(r.score, false), 'none', JSON.stringify(r));
  assert.ok(!r.categories.includes('tech-support'));
});

test('scam model answer: kind label (real model) and boolean (stub) shapes; prompt has no heuristic findings', async () => {
  const { readScamAnswer, scamPrompt, SCAM_SCHEMA } = await import('../../src/shared/scam.ts');
  assert.deepEqual(readScamAnswer({ about: 'fake parcel fee', kind: 'scam' }), { scam: true, reason: 'fake parcel fee' });
  assert.deepEqual(readScamAnswer({ about: 'hardware store sale', kind: 'shop' }), { scam: false, reason: 'hardware store sale' });
  assert.equal(readScamAnswer({ about: 'x', kind: 'news' })?.scam, false);
  assert.deepEqual(readScamAnswer({ scam: true, reason: 'stub' }), { scam: true, reason: 'stub' });
  assert.equal(readScamAnswer({ kind: 'maybe' }), null);
  assert.equal(readScamAnswer(null), null);
  assert.deepEqual(SCAM_SCHEMA.required, ['about', 'kind']);
  const p = scamPrompt({ text: 'Last chance sale', title: 'Shop', behaviour: { fullscreen: 0, beforeunload: 0, history: 0, dialogs: 0, inputLock: 0 } }, { score: 4, categories: ['urgent-payment'], reasons: ['it urgently asks for payment with gift cards'] }, 'shop.example');
  assert.doesNotMatch(p, /Heuristic|gift cards/);
});
