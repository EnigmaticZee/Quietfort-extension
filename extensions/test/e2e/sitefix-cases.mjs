// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Fix-this-site and element-picker end-to-end cases, shared by the Chrome and
// Firefox tests. The browser-specific part is `send(page, msg)`: how a popup
// message for the tab showing `page` reaches the background.

import { sleep, waitFor } from './harness.mjs';

const DAY = 24 * 60 * 60 * 1000;

async function display(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display : 'missing';
  }, sel).catch(() => 'error');
}

async function load(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await sleep(900);
}

const works = (page) => page.evaluate(() => window.__siteWorks === true).catch(() => false);

/**
 * Run Fix-this-site on `page`, answering each "Is the page working now?" from
 * the page's own state (`answer` can distort it). Returns the final status and
 * the questions asked.
 */
export async function runFix(send, page, { mode = 'ask', answer = (w) => w, onQuestion } = {}) {
  let st = await send(page, { type: 'fix:start', mode });
  const asked = [];
  for (let i = 0; i < 40; i++) {
    st = await waitFor(async () => {
      try {
        const s = await send(page, { type: 'fix:status' });
        return s && s.phase !== 'reloading' ? s : null;
      } catch {
        return null;
      }
    }, 25000, 250);
    if (!st || st.phase !== 'question') break;
    const w = await works(page);
    asked.push({ testing: st.testing, works: w, confirm: st.confirm });
    if (onQuestion) await onQuestion(answer(w, i));
    else await send(page, { type: 'fix:answer', works: answer(w, i) });
  }
  return { st, asked };
}

export async function siteFixCases({ h, browser, send, hits, log, label }) {
  const L = (s) => `${label}: ${s}`;

  // ---------- scriptlet breakage ----------
  const sl = await browser.newPage();
  await load(sl, 'http://broken-sl.test/page.html');
  h.check(L('fixture broken by the scriptlet before the fix'), !(await works(sl)) && (await display(sl, '#promo')) === 'none');
  const r1 = await runFix(send, sl);
  h.info(L('scriptlet fix questions'), r1.asked);
  h.check(L('Fix-this-site converged to the scriptlet (one rule)'), r1.st?.phase === 'done' && r1.st.result?.length === 1 && r1.st.result[0].kind === 'scriptlet'
    && r1.st.result[0].lines[0] === 'broken-sl.test#@#+js(set-constant, SiteApp, undefined)', r1.st);
  h.check(L('bisection halved the candidates (risk order: scriptlet tested first)'), r1.asked.length <= 6 && r1.asked[1]?.testing?.[0]?.includes('+js(set-constant'), r1.asked.map((a) => a.testing?.length));
  h.check(L('exception is expiring (7 days) with provenance'), r1.st?.result?.[0] && r1.st.result[0].expiresAt - r1.st.result[0].createdAt === 7 * DAY && /Fix this site/.test(r1.st.result[0].reason) && r1.st.result[0].site === 'broken-sl.test', r1.st?.result?.[0]);
  const before = log.length;
  await load(sl, 'http://broken-sl.test/page.html');
  const adHitsAfter = hits('ads.adnet.test', '/ads/ad.js').filter((l) => log.indexOf(l) >= before).length;
  h.check(L('scriptlet exception fixes the page'), await works(sl));
  h.check(L('ads on the fixed page stay blocked; site cosmetic still applied'), adHitsAfter === 0 && (await sl.evaluate(() => window.__adLoaded)) === undefined && (await display(sl, '#promo')) === 'none' && (await display(sl, '#side')) === 'none');
  const pub = await browser.newPage();
  await load(pub, 'http://publisher.test/page.html');
  h.check(L('other sites keep the scriptlet and ad blocking'), (await pub.evaluate(() => window.adConfig.enabled)) === false && (await pub.evaluate(() => window.__adLoaded)) === undefined);

  // ---------- first-party network breakage ----------
  const fp = await browser.newPage();
  await load(fp, 'http://broken-fp.test/page.html');
  h.check(L('fixture broken by the first-party block before the fix'), !(await works(fp)) && hits('broken-fp.test', '/js/widgets.js').length === 0);
  const st0 = await send(fp, { type: 'popup:getState' });
  h.check(L('breakage detected automatically (JS error + first-party block → suggestion)'), st0.suggestFix === true && st0.signals.some((s) => s.kind === 'js-error') && st0.signals.some((s) => s.kind === 'first-party-blocked'), st0.signals);
  const r2 = await runFix(send, fp);
  h.info(L('first-party fix questions'), r2.asked);
  h.check(L('Fix-this-site converged to the first-party rule'), r2.st?.phase === 'done' && r2.st.result?.length === 1 && r2.st.result[0].rule === '||broken-fp.test/js/widgets.js'
    && r2.st.result[0].lines[0] === '@@||broken-fp.test/js/widgets.js$domain=broken-fp.test', r2.st);
  await load(fp, 'http://broken-fp.test/page.html');
  h.check(L('network exception fixes the page'), (await works(fp)) && (await fp.evaluate(() => window.__widgetsLoaded)) === 1);
  h.check(L('ad on the fixed page stays blocked; banner still hidden'), (await fp.evaluate(() => window.__adLoaded)) === undefined && (await display(fp, '#banner')) === 'none');
  const cross = await pub.evaluate(() => new Promise((r) => {
    const s = document.createElement('script');
    s.src = 'http://broken-fp.test/js/widgets.js?from=publisher';
    s.onload = () => r('loaded');
    s.onerror = () => r('blocked');
    document.head.appendChild(s);
  }));
  h.check(L('exception is scoped to the site (same URL from another site still blocked)'), cross === 'blocked', cross);

  // ---------- list, undo, automatic mode ----------
  let list = await send(fp, { type: 'fix:list' });
  h.check(L('both exceptions listed'), list.exceptions.length === 2, list.exceptions.map((e) => e.lines));
  const fpEx = list.exceptions.find((e) => e.site === 'broken-fp.test');
  await send(fp, { type: 'fix:undo', id: fpEx.id });
  await load(fp, 'http://broken-fp.test/page.html');
  h.check(L('undo removes the exception (page broken again)'), !(await works(fp)));
  const r3 = await runFix(send, fp, { mode: 'auto' });
  h.check(L('automatic mode: decided from the triggering JS error without questions'), r3.st?.phase === 'done' && r3.asked.length === 0 && r3.st.mode === 'auto' && r3.st.result?.[0]?.rule === '||broken-fp.test/js/widgets.js', { st: r3.st, asked: r3.asked });

  // ---------- noisy answer ----------
  await load(sl, 'http://broken-sl.test/page.html');
  list = await send(sl, { type: 'fix:list' });
  await send(sl, { type: 'fix:undo', id: list.exceptions.find((e) => e.site === 'broken-sl.test').id });
  await load(sl, 'http://broken-sl.test/page.html');
  const r4 = await runFix(send, sl, { answer: (w, i) => (i === 2 ? !w : w) });
  h.check(L('one wrong answer: still converges to the scriptlet'), r4.st?.phase === 'done' && r4.st.result?.length === 1 && r4.st.result[0].kind === 'scriptlet', { st: r4.st?.result?.map((e) => e.rule), asked: r4.asked });

  // ---------- make permanent / expiry with the test clock ----------
  list = await send(sl, { type: 'fix:list' });
  h.check(L('exceptions before expiry'), list.exceptions.length === 2, list.exceptions.map((e) => e.rule));
  await send(sl, { type: 'test:advanceClock', ms: 6 * DAY });
  const keep = await send(sl, { type: 'test:pruneExceptions' });
  h.check(L('nothing expires after 6 days'), keep.expired === 0, keep);
  await send(sl, { type: 'test:advanceClock', ms: 1 * DAY + 60000 });
  const gone = await send(sl, { type: 'test:pruneExceptions' });
  list = await send(sl, { type: 'fix:list' });
  h.check(L('after 7 days both exceptions expire'), gone.expired === 2 && list.exceptions.length === 0, { gone, left: list.exceptions });
  await load(sl, 'http://broken-sl.test/page.html');
  await load(fp, 'http://broken-fp.test/page.html');
  h.check(L('expired exceptions no longer apply (both pages broken again)'), !(await works(sl)) && !(await works(fp)) && (await fp.evaluate(() => window.__widgetsLoaded)) === undefined);
  // Make permanent survives the clock.
  const r5 = await runFix(send, fp);
  const id5 = r5.st?.result?.[0]?.id;
  await send(fp, { type: 'fix:permanent', id: id5 });
  await send(fp, { type: 'test:advanceClock', ms: 30 * DAY });
  await send(fp, { type: 'test:pruneExceptions' });
  list = await send(fp, { type: 'fix:list' });
  h.check(L('permanent exception survives 30 more days'), list.exceptions.length === 1 && list.exceptions[0].expiresAt === null, list.exceptions);
  await send(fp, { type: 'fix:undo', id: id5 });

  await sl.close();
  await fp.close();
  await pub.close();
}

/** Picker on the hashed-class fixture, then the fallback switch after a "redeploy". */
export async function pickerCases({ h, browser, send, state, label, beforePick }) {
  const L = (s) => `${label}: ${s}`;
  state.pickerClass = 'promo-unit';
  const page = await browser.newPage();
  await load(page, 'http://picker.test/page.html');
  const target = 'aside[aria-label="Sponsored offer"]';
  if (beforePick) await beforePick(page);
  const pickRes = await send(page, { type: 'popup:pick' });
  const injected = await waitFor(() => page.evaluate(() => !!document.getElementById('__adb_picker')?.shadowRoot), 5000);
  h.check(L('picker injected'), injected, pickRes);
  await page.click(target);
  await sleep(300);
  const panel = () => page.evaluate(() => {
    const r = document.getElementById('__adb_picker').shadowRoot;
    return {
      cands: [...r.querySelectorAll('label.cand')].map((l) => ({ selector: l.dataset.selector, count: Number(l.dataset.count), kind: l.dataset.kind, score: Number(l.dataset.score) })),
      ok: r.getElementById('adb-status').dataset.ok,
      status: r.getElementById('adb-status').textContent,
      saveDisabled: r.getElementById('adb-save').disabled,
    };
  });
  const p1 = await panel();
  h.info(L('picker candidates'), p1.cands);
  const primary = p1.cands[0];
  h.check(L('≥5 candidate selectors (id/attr/class/:has/:has-text/path)'), p1.cands.length >= 5 && ['class', 'attr', 'has', 'text'].every((k) => p1.cands.some((c) => c.kind === k)), p1.cands.map((c) => c.kind));
  h.check(L('primary selector is stable (no hashed classes) and unique'), primary && primary.count === 1 && !/css-|jsx-|sc-|__/.test(primary.selector) && p1.ok === 'true', primary);
  const click = (id) => page.evaluate((i) => document.getElementById('__adb_picker').shadowRoot.getElementById(i).click(), id);
  await click('adb-preview');
  const prev = await display(page, target);
  await click('adb-preview');
  h.check(L('live preview hides the matches and restores them'), prev === 'none' && (await display(page, target)) !== 'none', prev);
  await click('adb-widen');
  await sleep(200);
  const wide = await panel();
  h.check(L('widen to the parent (<main>) is refused by validation'), wide.ok === 'false' && wide.saveDisabled === true && /whole page|page text/.test(wide.status), wide.status);
  await click('adb-narrow');
  await sleep(200);
  const narrow = await panel();
  h.check(L('narrow returns to the picked element'), narrow.cands[0]?.selector === primary.selector && narrow.ok === 'true');
  await click('adb-save');
  await sleep(800);
  const list = await send(page, { type: 'fix:list' });
  const rule = list.picker[0];
  h.check(L('saved as site rule with fallbacks'), rule && rule.site === 'picker.test' && rule.selectors[0] === primary.selector && rule.selectors.length >= 3 && rule.active === 0, rule);
  h.check(L('picker closed and element hidden'), (await page.evaluate(() => !document.getElementById('__adb_picker'))) && (await display(page, target)) === 'none');
  await load(page, 'http://picker.test/page.html');
  h.check(L('rule applies on the next visit'), (await display(page, target)) === 'none' && (await display(page, 'aside[aria-label="Related"]')) !== 'none');

  // "Redeploy": the stable class changes, the primary stops matching.
  state.pickerClass = 'promo-card';
  await load(page, 'http://picker.test/page.html');
  const switched = await waitFor(async () => (await send(page, { type: 'fix:list' })).picker[0]?.active !== 0, 5000, 250);
  const after = (await send(page, { type: 'fix:list' })).picker[0];
  h.check(L('primary stopped matching → switched to a fallback that matches the same element'), switched && after.active > 0 && after.selectors[after.active] !== primary.selector && after.switchedAt, after);
  h.check(L('element hidden after the class change'), (await display(page, target)) === 'none' && (await display(page, 'aside[aria-label="Related"]')) !== 'none');
  await load(page, 'http://picker.test/page.html');
  h.check(L('fallback is now the applied rule (hidden by CSS on reload)'), (await display(page, target)) === 'none' && (await page.evaluate((s) => document.querySelector(s).style.display, target)) === '', after.selectors[after.active]);
  await send(page, { type: 'picker:remove', id: after.id });
  await load(page, 'http://picker.test/page.html');
  h.check(L('removing the rule shows the element again'), (await display(page, target)) !== 'none');
  await page.close();
}
