// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// AI cookie click plans: whatever the model proposes, only offered
// reject / necessary-only controls (and settings openers before them) are
// clicked — accept / subscribe / pay / login and invented selectors are refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieLocks, cookieSchema, frameQualifies, isDangerText, isNavigateText, isRejectText, LOCK_TTL_MS, MAX_STEPS, offerToModel, parentFrameVerdict, validatePlan, validateStep } from '../../src/shared/clickplan.ts';
import type { Clickable } from '../../src/shared/clickplan.ts';

const b = (selector: string, text: string, extra: Partial<Clickable> = {}): Clickable => ({ selector, text, tag: 'button', ...extra });

test('reject / necessary-only vocabulary in many languages', () => {
  for (const t of ['Reject all', 'REJECT ALL COOKIES', 'Decline', 'Only necessary', 'Use necessary cookies only', 'Continue without accepting', 'Accept only essential cookies',
    'Alle ablehnen', 'Nur notwendige Cookies', 'Tout refuser', 'Continuer sans accepter', 'Rechazar todo', 'Solo necesarias', 'Rifiuta tutto', 'Alles weigeren', 'Rejeitar tudo',
    'Odrzuć wszystkie', 'Avvisa alla', 'Hylkää kaikki', 'Tümünü reddet', 'Отклонить все', 'すべて拒否', '全部拒绝', '모두 거부', 'I do not accept', 'No, thank you']) {
    assert.ok(isRejectText(t), t);
    assert.ok(!isDangerText(t), `${t} must not read as accept`);
  }
});

test('accept / subscribe / pay / login vocabulary is dangerous', () => {
  for (const t of ['Accept all', 'I agree', 'Allow all', 'OK', 'Got it', 'Alle akzeptieren', 'Zustimmen', "J'accepte", 'Tout accepter', 'Aceptar', 'Accetta tutto', 'Akkoord',
    'Subscribe', 'Reject all and subscribe', 'Ablehnen und PUR-Abo abschließen', 'Sign in', 'Log in to reject', 'Pay €2.99 to reject', 'Принять все', '同意', '동의', 'Continue', 'Accept and close']) {
    assert.ok(isDangerText(t), t);
  }
  assert.ok(isNavigateText('Manage options'));
  assert.ok(isNavigateText('Einstellungen'));
  assert.ok(!isNavigateText('Accept all'));
});

const offered = [b('#accept', 'Accept all'), b('#settings', 'Manage options'), b('#reject', 'Reject all'), b('#sub', 'Reject and subscribe'),
  b('a.policy', 'Privacy policy', { tag: 'a', href: '/privacy' }), b('a.rej', 'Decline', { tag: 'a', href: '#' }), b('#login', 'Log in')];

test('validateStep: accepts offered reject controls only', () => {
  const ok = validateStep('#reject', offered, 0);
  assert.ok(ok.ok && ok.kind === 'reject');
  const nav = validateStep('#settings', offered, 0);
  assert.ok(nav.ok && nav.kind === 'navigate');
  const link = validateStep('a.rej', offered, 0);
  assert.ok(link.ok && link.kind === 'reject', 'in-page link is fine');
});

test('validateStep: malicious / accept plans are refused', () => {
  const refused = (sel: unknown, i = 0) => {
    const v = validateStep(sel, offered, i);
    assert.ok(!v.ok, `${String(sel)} should be refused`);
    return v.ok ? '' : v.reason;
  };
  assert.match(refused('#accept'), /accept/);
  assert.match(refused('#sub'), /subscribe|accept/);
  assert.match(refused('#login'), /login|accept/);
  assert.match(refused('a.policy'), /navigates away/);
  assert.match(refused('body'), /not offered/);
  assert.match(refused('#reject, #accept'), /not offered/);
  assert.match(refused('button'), /not offered/);
  refused(null);
  refused(42);
  refused('');
  assert.match(refused('#settings', MAX_STEPS - 1), /not a reject/, 'last step cannot be "settings"');
  assert.match(refused('#reject', MAX_STEPS), /too many/);
});

test('validatePlan: must end with exactly one reject click', () => {
  const second = [b('#rej2', 'Reject all'), b('#save', 'Save and accept')];
  assert.ok(validatePlan(['#settings', '#rej2'], [offered, second]).ok);
  assert.ok(validatePlan([{ selector: '#reject' }], [offered]).ok);
  assert.ok(!validatePlan(['#settings'], [offered]).ok, 'never ends on a reject');
  assert.ok(!validatePlan(['#reject', '#rej2'], [offered, second]).ok, 'reject before the end');
  assert.ok(!validatePlan(['#settings', '#save'], [offered, second]).ok, 'accept in step 2');
  assert.ok(!validatePlan([], []).ok);
  assert.ok(!validatePlan(['#settings', '#settings', '#settings', '#reject'], [offered, offered, offered, offered]).ok);
  assert.ok(!validatePlan('#reject', [offered]).ok);
});

test('the model is constrained to the offered selectors', () => {
  const s = cookieSchema(offered) as { properties: { selector: { enum: string[] } } };
  assert.deepEqual(s.properties.selector.enum, [...offered.map((o) => o.selector), 'none']);
});

test('the model is only shown controls validation could accept', () => {
  const all = [
    b('#a', 'Accept all'), b('#m', 'Manage settings'), b('#r', 'Reject all'), b('#s', 'Save and accept'),
    b('#l', 'Privacy policy', { tag: 'a', href: '/privacy' }), b('#n', 'Nur notwendige Cookies'), b('#x', 'Learn more'),
  ];
  assert.deepEqual(all.filter(offerToModel).map((c) => c.selector), ['#m', '#r', '#n', '#x']);
  // An answer outside the subset is still refused by validation against everything offered.
  assert.equal(validateStep('#a', all, 0).ok, false);
});

// ---------- consent iframes ----------

const consentText = 'We and our partners use cookies and process personal data. Manage or reject cookies.';

test('frameQualifies: only large, visible frames that read as a consent dialog', () => {
  const ok = { width: 600, height: 400, docHidden: false, text: consentText };
  assert.ok(frameQualifies(ok).ok);
  assert.ok(frameQualifies({ ...ok, width: 200, height: 100 }).ok, 'exactly the minimum');
  for (const [v, why] of [
    [{ ...ok, width: 199 }, /too small/],
    [{ ...ok, height: 99 }, /too small/],
    [{ ...ok, width: 1, height: 1 }, /too small/],
    [{ ...ok, width: 0, height: 0 }, /too small/],
    [{ ...ok, width: NaN, height: 300 }, /too small/],
    [{ ...ok, docHidden: true }, /hidden/],
    [{ ...ok, text: 'Watch the highlights. Click to play the video.' }, /consent/],
    [{ ...ok, text: '' }, /consent/],
  ] as const) {
    const r = frameQualifies(v);
    assert.ok(!r.ok && why.test(r.reason), JSON.stringify(v));
  }
});

test('frameQualifies: the banner must be on screen (at least half of it)', () => {
  const base = { width: 600, height: 400, docHidden: false, text: consentText };
  assert.ok(frameQualifies({ ...base, bannerArea: 1000, visibleArea: 1000 }).ok);
  assert.ok(frameQualifies({ ...base, bannerArea: 1000, visibleArea: 500 }).ok);
  assert.ok(!frameQualifies({ ...base, bannerArea: 1000, visibleArea: 499 }).ok, 'mostly scrolled away');
  assert.ok(!frameQualifies({ ...base, bannerArea: 1000, visibleArea: 0 }).ok, 'off screen');
  assert.ok(!frameQualifies({ ...base, bannerArea: 0, visibleArea: 0 }).ok, 'not rendered');
  assert.ok(!frameQualifies({ ...base, bannerArea: 1000, visibleArea: null }).ok, 'not measured = no');
});

test('parentFrameVerdict: the top frame vetoes hidden / tiny / off-screen iframes', () => {
  const o = 'https://cmp.example';
  const box = { origin: o, width: 600, height: 400, inViewport: true, styleVisible: true };
  assert.equal(parentFrameVerdict([box], o), 'visible');
  assert.equal(parentFrameVerdict([{ ...box, styleVisible: false }], o), 'hidden');
  assert.equal(parentFrameVerdict([{ ...box, width: 1, height: 1 }], o), 'hidden');
  assert.equal(parentFrameVerdict([{ ...box, inViewport: false }], o), 'hidden');
  assert.equal(parentFrameVerdict([{ ...box, styleVisible: false }, box], o), 'visible', 'one visible iframe of that origin is enough');
  assert.equal(parentFrameVerdict([box], 'https://other.example'), 'unknown');
  assert.equal(parentFrameVerdict([], o), 'unknown');
});

test('CookieLocks: one flow per tab; the one in progress wins', () => {
  const L = new CookieLocks(1000);
  assert.ok(L.acquire(1, 0, 0).ok, 'top frame takes it');
  assert.deepEqual(L.acquire(1, 7, 10), { ok: false, reason: 'busy' }, 'frame must wait');
  assert.ok(L.acquire(1, 0, 20).ok, 'holder may re-acquire');
  assert.ok(L.acquire(2, 7, 20).ok, 'other tabs are independent');
  assert.ok(L.holds(1, 0, 500) && !L.holds(1, 7, 500));
  assert.ok(!L.renew(1, 7, 500).ok, 'only the holder renews');
  assert.ok(L.renew(1, 0, 900).ok);
  assert.ok(L.holds(1, 0, 1800), 'renewed');
  // TTL: a holder that went quiet loses it.
  assert.ok(!L.holds(1, 0, 1901));
  assert.ok(L.acquire(1, 7, 1901).ok, 'frame takes over after the TTL');
  // Release lets the other one in; finish shuts everyone out until reset.
  assert.ok(!L.release(1, 0, 1950), 'non-holder cannot release');
  assert.ok(L.release(1, 7, 1950));
  assert.ok(L.acquire(1, 0, 1960).ok);
  assert.ok(L.finish(1, 0, 1970));
  assert.deepEqual(L.acquire(1, 7, 1980), { ok: false, reason: 'done' });
  assert.deepEqual(L.acquire(1, 0, 99999), { ok: false, reason: 'done' }, 'done does not expire');
  assert.equal(L.owner(1, 99999), 0);
  L.reset(1);
  assert.ok(L.acquire(1, 7, 100000).ok, 'navigation resets');
  assert.equal(LOCK_TTL_MS, 15000);
});

test('CookieLocks: a model call in flight keeps the lock past the TTL', () => {
  const L = new CookieLocks(1000);
  assert.ok(L.acquire(1, 5, 0).ok);
  L.busy(1, 5, true, 0);
  assert.ok(L.isBusy(1, 5));
  assert.ok(L.holds(1, 5, 30000), 'slow model call');
  assert.deepEqual(L.acquire(1, 0, 30000), { ok: false, reason: 'busy' });
  L.busy(1, 5, false, 30000);
  assert.ok(L.holds(1, 5, 30999));
  assert.ok(!L.holds(1, 5, 31001));
  L.busy(1, 9, true, 0);
  assert.ok(!L.isBusy(1, 9), 'busy from a non-holder is ignored');
});

test('"Manage or reject cookies" is a settings step while more steps are allowed, never accept', () => {
  const offered = [b('#m', 'Manage or reject cookies'), b('#y', "Yes, I'm happy")];
  const v0 = validateStep('#m', offered, 0);
  assert.ok(v0.ok && v0.kind === 'navigate');
  const vLast = validateStep('#m', offered, MAX_STEPS - 1);
  assert.ok(vLast.ok && vLast.kind === 'reject');
  assert.ok(!validateStep('#y', offered, 0).ok);
  assert.ok(validatePlan(['#m', '#r'], [offered, [b('#r', 'Reject all')]]).ok);
});
