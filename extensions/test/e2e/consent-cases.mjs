// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Cookie-banner end-to-end cases, shared by the Chrome and Firefox tests.
// Fixture pages: extensions/page-runtime/tests/consent-fixtures (served by
// server.mjs on cmp.test, and on csp-cmp.test with a strict nonce CSP).
//
//   consentCases({ h, browser, label, status(page), setCookieBanners(on) })
//     status(page)          → the background's consent status for that tab (or null)
//     setCookieBanners(on)  → flips the setting and waits until lists are updated

import { sleep, waitFor } from './harness.mjs';

const pageState = (page) => page.evaluate(() => {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' ? 'hidden' : 'visible';
  };
  window.scrollTo(0, 800);
  const scrolled = window.scrollY;
  window.scrollTo(0, 0);
  return {
    clicked: [...(window.__clicked || [])],
    violations: [...(window.__violations || [])],
    bodyOverflow: getComputedStyle(document.body).overflow,
    scrolled,
    otBanner: vis('#onetrust-banner-sdk'),
    otFilter: vis('.onetrust-pc-dark-filter'),
    otGroups: window.OnetrustActiveGroups,
    didomiPopup: vis('#didomi-popup'),
    newsletter: vis('#newsletter'),
    leftover: vis('#leftover'),
    content: vis('#article') !== 'missing' ? vis('#article') : vis('#content'),
    prehide: document.getElementById('autoconsent-prehide')?.textContent?.length ?? 0,
    bodyLen: document.body.innerHTML.length,
    snapshot: window.__snapshot,
    tcf: window.__tcfapi ? (() => { let d; window.__tcfapi('getTCData', 2, (x) => { d = x; }); return { status: d.eventStatus, anyConsent: Object.values(d.purpose.consents).some(Boolean) }; })() : null,
  };
});

export async function consentCases({ h, browser, label, status, setCookieBanners }) {
  const page = await browser.newPage();
  const open = async (url) => {
    await page.goto(url, { waitUntil: 'load' });
  };
  const clickedSomething = () => waitFor(async () => (await page.evaluate(() => (window.__clicked || []).length)) > 0, 12000, 150);
  const statusFor = async (want) => waitFor(async () => {
    const s = await status(page);
    return s && want(s) ? s : null;
  }, 4000, 200);

  for (const host of ['cmp.test', 'csp-cmp.test']) {
    const tag = `${label} consent [${host === 'cmp.test' ? 'no CSP' : 'strict CSP'}]`;

    // OneTrust-style banner, present at load.
    await open(`http://${host}/onetrust.html`);
    await clickedSomething();
    await sleep(600);
    let st = await pageState(page);
    h.check(`${tag} OneTrust: "Reject All" clicked, never "Accept"`, st.clicked.length === 1 && st.clicked[0] === 'reject' && st.otGroups === ',C0001,', st.clicked);
    h.check(`${tag} OneTrust: banner and overlay gone`, st.otBanner !== 'visible' && st.otFilter !== 'visible', { banner: st.otBanner, filter: st.otFilter });
    h.check(`${tag} OneTrust: page scroll restored`, st.bodyOverflow !== 'hidden' && st.scrolled > 0, { overflow: st.bodyOverflow, scrolled: st.scrolled });
    h.check(`${tag} OneTrust: content visible, nothing left pre-hidden`, st.content === 'visible' && st.prehide === 0, { content: st.content, prehide: st.prehide });
    let cs = await statusFor((s) => s.optOut !== null);
    h.check(`${tag} OneTrust: background reports reject succeeded`, cs?.cmp === 'Onetrust' && cs.optOut === true, cs);
    if (host === 'csp-cmp.test') {
      const scriptViolations = st.violations.filter((v) => v.startsWith('script-src'));
      h.check(`${tag} OneTrust: no script CSP violations`, scriptViolations.length === 0, st.violations);
      if (st.violations.length) h.info(`${tag} other CSP violations`, st.violations);
    }

    // Didomi-style popup with IAB TCF API, appearing 800 ms after load.
    await open(`http://${host}/didomi.html`);
    await clickedSomething();
    await sleep(600);
    st = await pageState(page);
    h.check(`${tag} Didomi/TCF: "Refuse" clicked, never "Accept"`, st.clicked.length === 1 && st.clicked[0] === 'disagree', st.clicked);
    h.check(`${tag} Didomi/TCF: TCF reports user action with no consent`, st.tcf?.status === 'useractioncomplete' && st.tcf.anyConsent === false, st.tcf);
    h.check(`${tag} Didomi/TCF: popup gone, scroll restored`, st.didomiPopup !== 'visible' && st.bodyOverflow !== 'hidden' && st.scrolled > 0, { popup: st.didomiPopup, overflow: st.bodyOverflow, scrolled: st.scrolled });
    cs = await statusFor((s) => s.optOut !== null);
    h.check(`${tag} Didomi/TCF: background reports reject succeeded`, cs?.cmp === 'didomi' && cs.optOut === true, cs);
    if (host === 'csp-cmp.test') {
      const scriptViolations = st.violations.filter((v) => v.startsWith('script-src'));
      h.check(`${tag} Didomi/TCF: no script CSP violations`, scriptViolations.length === 0, st.violations);
    }
  }

  // Consent-or-pay wall ("reject" = subscribe): left for the user.
  await open('http://cmp.test/paywall.html');
  await sleep(5000);
  let pw = await pageState(page);
  h.check(`${label} consent: "reject and subscribe" wall not clicked, left visible`, pw.clicked.length === 0 && pw.otBanner === 'visible', { clicked: pw.clicked, banner: pw.otBanner });
  const pws = await status(page);
  h.check(`${label} consent: paywall refusal reported`, pws?.refusedPaywall === true, pws);

  // No consent platform: nothing clicked, hidden or changed.
  await open('http://cmp.test/no-cmp.html');
  await sleep(6000);
  let st = await pageState(page);
  h.check(`${label} consent: page without a CMP untouched (no clicks, modal still shown, body unchanged)`, st.clicked.length === 0 && st.newsletter === 'visible' && st.bodyLen === st.snapshot && st.prehide === 0, { clicked: st.clicked, newsletter: st.newsletter, bodyLen: st.bodyLen, snapshot: st.snapshot, prehide: st.prehide });
  h.check(`${label} consent: no CMP reported for the plain page`, !(await status(page))?.cmp, await status(page));

  // Iframes: only a consent platform's frame gets the handler.
  await open('http://cmp.test/frames.html');
  await sleep(1500);
  const frameHas = async (part) => {
    const f = page.frames().find((x) => x.url().includes(part));
    return f ? f.evaluate(() => typeof window.autoconsentSendMessage) : 'no frame';
  };
  const frames = { cmp: await frameHas('privacy-mgmt.com'), video: await frameHas('videohost.test'), top: await page.evaluate(() => typeof window.autoconsentSendMessage) };
  h.check(`${label} consent: injected into the top frame and the consent-platform iframe only (not the video iframe)`, frames.top === 'function' && frames.cmp === 'function' && frames.video === 'undefined', frames);

  // Leftover notice from no known platform: hidden by the cookie list.
  await open('http://cmp.test/leftover.html');
  const hidden = await waitFor(async () => (await pageState(page)).leftover === 'hidden', 4000, 200);
  st = await pageState(page);
  h.check(`${label} consent: leftover cookie notice hidden by the (runtime) cookie list`, hidden && st.content === 'visible' && st.clicked.length === 0, { leftover: st.leftover, clicked: st.clicked });

  // Setting off: banners stay, cookie list unused.
  await setCookieBanners(false);
  await open('http://cmp.test/onetrust.html');
  await sleep(5000);
  st = await pageState(page);
  h.check(`${label} consent: switched off → banner left alone`, st.clicked.length === 0 && st.otBanner === 'visible', { clicked: st.clicked, banner: st.otBanner });
  await open('http://cmp.test/leftover.html');
  await sleep(1500);
  h.check(`${label} consent: switched off → cookie list not applied`, (await pageState(page)).leftover === 'visible');

  // And on again.
  await setCookieBanners(true);
  await open('http://cmp.test/onetrust.html');
  await clickedSomething();
  st = await pageState(page);
  h.check(`${label} consent: switched on again → rejected`, st.clicked[0] === 'reject' && st.clicked.length === 1, st.clicked);
  return page;
}
