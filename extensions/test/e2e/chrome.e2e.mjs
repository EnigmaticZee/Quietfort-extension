// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// End-to-end test: the installed Google Chrome with dist/chrome loaded
// (puppeteer `enableExtensions`, i.e. CDP Extensions.loadUnpacked over a pipe —
// works on branded Chrome, which ignores --load-extension since v137) against
// the local test server.
//
//   node test/e2e/chrome.e2e.mjs [--headful] [--real-lists]

import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullMalwareList, startServer } from './server.mjs';
import { createHarness, sleep, waitFor } from './harness.mjs';
import { siteFixCases, pickerCases } from './sitefix-cases.mjs';
import { consentCases } from './consent-cases.mjs';
import { featureCases } from './feature-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = join(ROOT, 'dist/chrome');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headful = process.argv.includes('--headful');
const realLists = process.argv.includes('--real-lists') || existsSync(join(ROOT, '../dev-data/easylist.txt'));

const h = createHarness('chrome e2e');
const { server, port, log, state } = await startServer();
const P = ''; // all hosts go through the local proxy on port 80 URLs
const profile = mkdtempSync(join(tmpdir(), 'adb-chrome-'));

const launch = () => puppeteer.launch({
  executablePath: CHROME,
  headless: !headful,
  pipe: true,
  protocolTimeout: 30000,
  enableExtensions: [EXT],
  userDataDir: profile,
  args: ['--no-first-run', '--no-default-browser-check', `--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable'],
});
let browser = await launch();

const hits = (host, path) => log.filter((l) => l.host === host && (!path || l.path === path));

async function display(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display : 'missing';
  }, sel);
}

try {
  h.info('browser', await browser.version());
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
  const extId = new URL(swTarget.url()).host;
  let sw = await swTarget.worker();
  let swStale = false;
  const attachSw = async () => {
    const t = await browser.waitForTarget((x) => x.type() === 'service_worker' && x.url().endsWith('/background.js'), { timeout: 20000 });
    sw = await t.worker();
    swStale = false;
  };
  const swEval = async (fn, ...args) => {
    if (swStale) await attachSw();
    try {
      return await sw.evaluate(fn, ...args);
    } catch (err) {
      // The service worker may have been restarted; reattach.
      await attachSw();
      return sw.evaluate(fn, ...args);
    }
  };
  h.check('extension service worker running', !!extId, extId);

  // ---------- lists & DNR ----------
  const fixtureUrl = `http://lists.test${P}/fixture.txt`;
  // The cookie list (on by default with cookie-banner handling) comes from the test server too.
  await swEval((url) => globalThis.__adb.setSources([{ id: 'fixture', url }, { id: 'easylist-cookie', url: 'http://lists.test/cookie.txt' }]), fixtureUrl);
  const st = await swEval(() => globalThis.__adb.refresh(true));
  const dnr = st.dnrStatus;
  h.check('fixture list downloaded at runtime', st.listStatus?.fixture?.bytes > 100 && !st.listStatus.fixture.error, st.listStatus?.fixture);
  h.check('cookie list downloaded at runtime (cookie banners on by default)', st.listStatus?.['easylist-cookie']?.bytes > 20 && !st.listStatus['easylist-cookie'].error && st.settings?.cookieBanners !== false, st.listStatus?.['easylist-cookie']);
  h.check('DNR rules installed', dnr?.installedDynamic > 5, { installedDynamic: dnr?.installedDynamic, stats: dnr?.stats });
  h.check('no DNR rule rejected by Chrome', dnr?.rejected?.length === 0, dnr?.rejected);
  h.check('popup rules kept out of DNR', dnr?.notInDnr?.['popup-only'] === 3, dnr?.notInDnr);
  const installed = await swEval(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length);
  h.check('getDynamicRules matches status', installed === dnr.installedDynamic, installed);
  const alarm = await swEval(async () => chrome.alarms.get('refresh-lists'));
  h.check('24h refresh alarm scheduled (hourly staleness check)', alarm?.periodInMinutes === 60, alarm);
  h.info('DNR limits reported by Chrome', dnr.limits);

  // ---------- publisher page ----------
  const page = await browser.newPage();
  page.on('console', (m) => process.env.VERBOSE && console.log('[page]', m.text()));
  await page.goto(`http://publisher.test${P}/page.html`, { waitUntil: 'load' });
  await sleep(1500);
  const w = await page.evaluate(() => ({
    adLoaded: window.__adLoaded, lib: window.__libLoaded, realGpt: window.__realGpt, gptReady: window.googletag?.apiReady,
    regex: window.__regexAdLoaded, echo: window.__echo, hdr: window.__hdr, hdrKeep: window.__hdrKeep, events: window.__events,
    adEnabled: window.adConfig?.enabled, early: window.__earlyEnabled, rawJs: window.__rawJsRan,
    imgs: Object.fromEntries([...document.images].map((i) => [i.id, i.naturalWidth])),
  }));
  h.info('page state', w);

  h.check('ad script blocked (||adnet.test^)', w.adLoaded === undefined && hits('ads.adnet.test', '/ads/ad.js').length === 0, w.events);
  h.check('first-party library allowed', w.lib === true);
  h.check('third-party tracker pixel blocked ($third-party)', w.imgs['img-tracker'] === 0 && hits('tracker.test').length === 0);
  h.check('exception respected (@@||adnet.test/ads/allowed/$image)', w.imgs['img-excepted'] === 1 && hits('ads.adnet.test', '/ads/allowed/ok.gif').length === 1);
  h.check('$important beats exception', w.imgs['img-important'] === 0 && hits('imp.test').length === 0);
  h.check('$redirect=googletagservices_gpt.js served from extension', w.gptReady === true && w.realGpt === undefined && hits('redir.test', '/gpt.js').length === 0);
  h.check('$redirect=1x1.gif served from extension', w.imgs['img-redirect'] === 1 && hits('redir.test', '/pixel.gif').length === 0);
  h.check('regex rule blocks', w.regex === undefined && hits('cdn.other.test').length === 0);
  h.check('$~third-party rule does not apply to third-party request', w.imgs['img-fp'] === 1);
  h.check('$removeparam strips utm_source (DNR queryTransform)', w.echo === '?id=1&x=2' && hits('publisher.test', '/echo').every((l) => !l.query.includes('utm_source')), w.echo);
  h.check('$removeheader strips response header', w.hdr === null && w.hdrKeep === 'kept', { hdr: w.hdr, keep: w.hdrKeep });

  h.check('generic keyed hiding (##.ad-banner)', (await display(page, '#generic-ad')) === 'none');
  h.check('generic attribute hiding (##[data-ad-slot])', (await display(page, '#attr-ad')) === 'none');
  h.check('site-specific hiding (publisher.test###specific-ad)', (await display(page, '#specific-ad')) === 'none');
  h.check('procedural :has-text via runtime.js', (await display(page, '#sponsored')) === 'none');
  h.check('procedural does not over-match', (await display(page, '#not-sponsored')) !== 'none');
  h.check('cosmetic exception (#@#) respected', (await display(page, '#excepted-cosmetic')) !== 'none');
  h.check('normal content visible', (await display(page, '#content')) !== 'none');
  const lateHidden = await waitFor(async () => (await display(page, '#late-ad')) === 'none', 3000);
  h.check('element added later is hidden (mutation token scan)', lateHidden);
  h.check('scriptlet set-constant (adConfig.enabled → false)', w.adEnabled === false, w.adEnabled);
  h.info('first visit: scriptlet ran before the first inline script (no cache yet; timing, not guaranteed)', w.early === false ? 'yes' : `no (inline script saw ${w.early})`);
  h.check('raw #%# JS and trusted-* scriptlets never run', w.rawJs === undefined);
  {
    // A page that streams in like a real site: scriptlets are in place before its first inline script.
    const p2 = await browser.newPage();
    await p2.goto(`http://publisher.test${P}/streamed.html`, { waitUntil: 'load' });
    const first = await p2.evaluate(() => window.__streamedEarly);
    await p2.goto(`http://publisher.test${P}/streamed.html?again`, { waitUntil: 'load' });
    const again = await p2.evaluate(() => window.__streamedEarly);
    h.check('streamed page: scriptlet in place before the first inline script (first and repeat visit)', first === false && again === false, { first, again });
    await p2.close();
  }

  const tabId = await swEval(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `http://publisher.test${P}/*`);
  const count = await swEval((id) => globalThis.__adb.getCount(id), tabId);
  h.check('blocked-request count for the tab', count.requests >= 6, count);

  // ---------- popups ----------
  const openPages = async () => (await browser.pages()).map((p) => p.url());
  const popupCase = async (label, selector, urlPart, expectClosed) => {
    const before = log.length;
    await page.bringToFront();
    await page.click(selector);
    await sleep(2500);
    const urls = await openPages();
    const open = urls.some((u) => u.includes(urlPart));
    for (const p of await browser.pages()) if (p !== page && /goodsite|popads|popunder/.test(p.url())) await p.close();
    h.check(label, expectClosed ? !open : open, { open: urls.filter((u) => !u.startsWith('chrome')), served: log.slice(before).map((l) => l.host + l.path) });
  };
  await popupCase('$popup: window.open to popads.test closed', '#open-bad', 'popads.test' + P + '/landing', true);
  await popupCase('non-matching popup stays open', '#open-good', 'goodsite.test' + P + '/landing', false);
  await popupCase('$popup exception (@@...$popup) respected', '#open-allowed', 'popads.test' + P + '/allowed/x', false);
  await popupCase('about:blank popup later navigated to popads.test closed', '#open-blank-then-bad', 'popads.test' + P + '/later', true);
  await popupCase('$popup,third-party popunder closed', '#open-3p', 'popunder.test', true);
  await popupCase('target=_blank link to popup domain closed', '#link-bad', 'popads.test' + P + '/viaLink', true);
  const recent = await swEval(() => globalThis.__adb.recentlyBlockedPopups());
  h.check('popup log records closed popups with rule', recent.length >= 4 && recent.every((r) => r.rule && r.openerUrl?.includes('publisher.test')), recent.map((r) => [r.url, r.rule]));
  for (const p of await browser.pages()) if (/goodsite|popads/.test(p.url())) await p.close();

  // ---------- popup UI ----------
  const ui = await browser.newPage();
  await ui.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await waitFor(() => ui.evaluate(() => document.getElementById('host').textContent !== '…'), 3000);
  const uiState = await ui.evaluate(() => ({
    host: document.getElementById('host').textContent, blocked: Number(document.getElementById('blocked').textContent),
    popups: Number(document.getElementById('popups').textContent), toggle: document.getElementById('toggle').checked,
    status: document.getElementById('status').textContent,
  }));
  h.check('popup UI shows host, counts and enabled switch', uiState.host === 'publisher.test' && uiState.blocked >= 6 && uiState.popups >= 4 && uiState.toggle === true, uiState);
  await ui.click('#report');
  await ui.type('#report-note', 'images missing');
  await ui.click('#report-send');
  await sleep(500);
  const reportText = await ui.evaluate(() => document.getElementById('report-done').textContent);
  const reports = await swEval(async () => (await chrome.storage.local.get('reports')).reports);
  h.check('report-broken-site stub saves locally', reports?.length === 1 && reports[0].note === 'images missing' && /saved/.test(reportText), reportText);

  // ---------- $csp ----------
  const csp = await browser.newPage();
  await csp.goto(`http://csp.publisher.test${P}/`, { waitUntil: 'load' });
  h.check('$csp blocks inline script', (await csp.evaluate(() => window.__inlineRan)) === undefined && (await csp.$('#p')) !== null);
  await csp.close();

  // ---------- page-level exceptions ----------
  const trusted = await browser.newPage();
  await trusted.goto(`http://trusted.test${P}/page.html`, { waitUntil: 'load' });
  await sleep(1200);
  h.check('@@||trusted.test^$document: ad script allowed', (await trusted.evaluate(() => window.__adLoaded)) === true);
  h.check('@@||trusted.test^$document: no cosmetic hiding', (await display(trusted, '#generic-ad')) !== 'none' && (await display(trusted, '#attr-ad')) !== 'none');
  await trusted.close();
  const ng = await browser.newPage();
  await ng.goto(`http://noghide.test${P}/page.html`, { waitUntil: 'load' });
  await sleep(1200);
  h.check('$generichide: generic hiding off', (await display(ng, '#generic-ad')) !== 'none' && (await display(ng, '#attr-ad')) !== 'none');
  h.check('$generichide: network blocking still on', (await ng.evaluate(() => window.__adLoaded)) === undefined);
  await ng.close();

  // ---------- per-site switch ----------
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:setEnabled', site: 'publisher.test', enabled: false }));
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  const off = await page.evaluate(() => ({ ad: window.__adLoaded, enabled: window.adConfig.enabled }));
  h.check('site switched off: requests not blocked', off.ad === true, off);
  h.check('site switched off: no cosmetics/scriptlets', (await display(page, '#generic-ad')) !== 'none' && (await display(page, '#specific-ad')) !== 'none' && off.enabled === true);
  await page.bringToFront();
  await page.click('#open-bad');
  await sleep(2500);
  h.check('site switched off: popups not closed', (await openPages()).some((u) => u.includes('popads.test' + P + '/landing')));
  for (const p of await browser.pages()) if (/popads/.test(p.url())) await p.close();
  await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:setEnabled', site: 'publisher.test', enabled: true }));
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  h.check('site switched back on: blocking resumes', (await page.evaluate(() => window.__adLoaded)) === undefined && (await display(page, '#generic-ad')) === 'none');

  // ---------- browser restart (cold service worker, state from storage) ----------
  await browser.close();
  browser = await launch();
  const sw2 = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
  sw = await sw2.worker();
  h.check('after browser restart: same extension id', new URL(sw2.url()).host === extId, sw2.url());
  // Re-loading the unpacked extension over CDP behaves like a reinstall: Chrome
  // drops its dynamic rules while extension storage survives. The worker must
  // notice and re-install them from the stored lists.
  const rulesAtStart = await swEval(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length);
  h.info('dynamic rules right after relaunch', rulesAtStart);
  const rulesAfter = await waitFor(async () => {
    const n = await swEval(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length);
    return n === dnr.installedDynamic ? n : 0;
  }, 10000, 250);
  h.check('after browser restart: DNR rules present (self-healed if dropped)', rulesAfter === dnr.installedDynamic, rulesAfter);
  const page3 = await browser.newPage();
  await page3.goto(`http://publisher.test${P}/page.html`, { waitUntil: 'load' });
  await sleep(1500);
  h.check('after browser restart: blocking + cosmetics + scriptlets work', (await page3.evaluate(() => window.__adLoaded)) === undefined && (await display(page3, '#specific-ad')) === 'none' && (await page3.evaluate(() => window.adConfig.enabled)) === false);
  await page3.bringToFront();
  await page3.click('#open-bad');
  await sleep(3000);
  h.check('after browser restart: popup closed', !(await browser.pages()).some((p) => p.url().includes('popads.test' + P + '/landing')));
  await page3.close();

  // ---------- Fix this site / element picker ----------
  const msgPage = await browser.newPage();
  await msgPage.goto(`chrome-extension://${extId}/options.html`);
  const tabIdOf = async (p) => swEval(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, p.url());
  const send = async (p, msg) => {
    // The production build has no test relay: drive the test clock through the worker handle.
    if (msg.type === 'test:advanceClock') return { offset: await swEval((ms) => globalThis.__adb.advanceClock(ms), msg.ms) };
    if (msg.type === 'test:pruneExceptions') return { expired: await swEval(() => globalThis.__adb.pruneExceptions()) };
    return msgPage.evaluate((m) => chrome.runtime.sendMessage(m), { ...msg, tabId: await tabIdOf(p) });
  };
  await siteFixCases({ h, browser, send, hits, log, label: 'chrome' });
  const overlayIds = await swEval(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.id >= 2 && r.id < 1002).length);
  h.check('chrome: DNR overlay empty after undo/expiry', overlayIds === 0, overlayIds);

  // Popup UI: Fix this site with the real buttons, then the fixes list with Undo.
  {
    const sl = await browser.newPage();
    await sl.goto('http://broken-sl.test/page.html', { waitUntil: 'load' });
    await sleep(900);
    const slTab = await tabIdOf(sl);
    const pop = await browser.newPage();
    await pop.goto(`chrome-extension://${extId}/popup.html?tabId=${slTab}&mode=ask`);
    await waitFor(() => pop.evaluate(() => document.getElementById('host').textContent === 'broken-sl.test'), 5000);
    await pop.click('#fix');
    let clicks = 0;
    for (let i = 0; i < 20; i++) {
      const s = await waitFor(() => pop.evaluate(() => ({
        q: !document.getElementById('fix-question').hidden,
        done: !document.getElementById('fix-result').hidden,
      })).then((x) => (x.q || x.done ? x : null)), 25000, 200);
      if (!s || s.done) break;
      const ok = await sl.evaluate(() => window.__siteWorks === true).catch(() => false);
      await pop.click(ok ? '#fix-yes' : '#fix-no');
      clicks++;
      await sleep(400);
    }
    const ui = await pop.evaluate(() => ({ result: document.getElementById('fix-result').textContent, items: [...document.querySelectorAll('#fix-list li.exception code')].map((c) => c.textContent) }));
    h.check('chrome popup UI: Yes/No buttons drive the fix to the scriptlet', clicks >= 2 && /Fixed/.test(ui.result) && ui.result.includes('set-constant'), { clicks, ui });
    await pop.reload();
    await waitFor(() => pop.evaluate(() => document.querySelectorAll('#fix-list li.exception').length === 1), 5000);
    const listed = await pop.evaluate(() => ({ text: document.querySelector('#fix-list li.exception')?.textContent ?? '', fixes: !document.getElementById('fixes').hidden }));
    h.check('chrome popup UI: exception listed with expiry, Undo and Make permanent', listed.fixes && /expires in 7 days|expires in 6 days/.test(listed.text) && /Undo/.test(listed.text) && /Make permanent/.test(listed.text), listed);
    await pop.click('#fix-list li.exception button.undo');
    await sleep(500);
    const left = await swEval(() => globalThis.__adb.getExceptions());
    h.check('chrome popup UI: Undo removes the exception', left.length === 0, left);
    await pop.close();
    await sl.close();
  }

  // The production picker uses a closed shadow root; open it for the test from the extension's isolated world.
  const beforePick = async (p) => swEval(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__adbPickerOpenShadow = true; } });
  }, await tabIdOf(p));
  await pickerCases({ h, browser, send, state, label: 'chrome', beforePick });
  await msgPage.close();

  // ---------- cookie banners ----------
  {
    const cpage = await consentCases({
      h, browser, label: 'chrome',
      status: async (p) => swEval((id) => globalThis.__adb.consentStatus(id), await tabIdOf(p)),
      setCookieBanners: async (on) => {
        await swEval((v) => globalThis.__adb.setCookieBanners(v), on);
        await swEval(() => globalThis.__adb.refresh(false));
      },
    });
    // Popup UI: the setting and what happened on this page.
    const cTab = await tabIdOf(cpage);
    await sleep(800);
    const pop = await browser.newPage();
    await pop.goto(`chrome-extension://${extId}/popup.html?tabId=${cTab}`);
    await waitFor(() => pop.evaluate(() => document.getElementById('host').textContent === 'cmp.test'), 5000);
    const ui = await waitFor(() => pop.evaluate(() => {
      const t = document.getElementById('cookie-status');
      return !t.hidden ? { checked: document.getElementById('cookie-toggle').checked, text: t.textContent } : null;
    }), 5000);
    h.check('chrome popup UI: cookie toggle on and banner reported rejected', ui?.checked === true && /Cookie banner rejected \(Onetrust\)/.test(ui.text), ui);
    await pop.close();
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html`);
    await waitFor(() => opts.evaluate(() => document.getElementById('cookie-toggle').checked), 3000);
    await opts.click('#cookie-toggle');
    const off = await waitFor(async () => (await swEval(() => globalThis.__adb.status())).settings?.cookieBanners === false, 3000);
    await opts.click('#cookie-toggle');
    const on = await waitFor(async () => (await swEval(() => globalThis.__adb.status())).settings?.cookieBanners === true, 3000);
    h.check('chrome options UI: cookie toggle switches the setting', !!off && !!on);
    await opts.close();
    await cpage.close();
    h.check('chrome: autoconsent files shipped unmodified next to the code', await swEval(async () => {
      const sha = async (f) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(chrome.runtime.getURL(f))).arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
      return (await sha('autoconsent/autoconsent.playwright.js')) === 'fe7529f48eec96f79f8252f0e9171fa260769e3c7c2c6ec09a0ad326d7545fd0'
        && (await sha('autoconsent/compact-rules.json')) === 'dd7520af6344ccdd42cf599174bcd95b563111f8db4c7e3163f47c4850422efa'
        && (await sha('autoconsent/LICENSE')) === 'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85';
    }));
  }

  // ---------- list chooser, protection, privacy, AI ----------
  {
    // Switch from the diagnostic list override to the built-in catalogue, with
    // every catalogue URL pointed at the test server.
    const ids = (await swEval(() => globalThis.__adb.listsView())).catalogue.map((e) => e.id);
    const overrides = Object.fromEntries(ids.map((id) => [id, `http://lists.test/catalogue/${id}.txt`]));
    overrides.easylist = 'http://lists.test/fixture.txt';
    overrides['easylist-cookie'] = 'http://lists.test/cookie.txt';
    await swEval(async (o) => {
      await globalThis.__adb.setUrlOverrides(o);
      await globalThis.__adb.setSources(null);
    }, overrides);
    const st = await swEval(() => globalThis.__adb.refresh(true));
    const view = await swEval(() => globalThis.__adb.listsView());
    const enabled = view.catalogue.filter((e) => e.enabled).map((e) => e.id);
    h.check('chrome catalogue: default lists on (EasyList, EasyPrivacy, cookie, protection), annoyances/social off', ['easylist', 'easyprivacy', 'easylist-cookie', 'blp-phishing', 'blp-scam', 'blp-fraud', 'blp-ransomware'].every((id) => enabled.includes(id)) && !enabled.includes('fanboy-annoyance') && !enabled.includes('fanboy-social'), enabled);
    h.check('chrome catalogue: protection hosts compiled to DNR redirect + block rules', st.dnrStatus?.protection?.hosts?.['blp-phishing'] === 2 && st.dnrStatus.protection.rules === 2 && st.dnrStatus.rejected.length === 0, { protection: st.dnrStatus?.protection, rejected: st.dnrStatus?.rejected });
    h.check('chrome: privacy header rules installed (GPC, Referrer-Policy x2, X-Client-Data)', st.dnrStatus?.privacyRules === 4, st.dnrStatus?.privacyRules);
    h.check('chrome: DNR limits reported with the list status', view.dnr?.limits?.dynamic > 0 && typeof view.dnr?.installedDynamic === 'number', view.dnr?.limits);
    h.info('real Prompt API in this Chrome (no stub)', await swEval(async () => ({ typeofLanguageModel: typeof LanguageModel, availability: await globalThis.__adb.modelAvailability() })));

    // Options page: chooser UI renders, custom URL validation, rule report.
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html`);
    await waitFor(() => opts.evaluate(() => document.querySelectorAll('#lists input[data-list]').length > 10), 5000);
    const ui = await opts.evaluate(() => {
      const row = document.querySelector('#lists li[data-list="easylist"]');
      return {
        rows: document.querySelectorAll('#lists li[data-list]').length,
        easylist: row?.textContent ?? '',
        phishingChecked: document.querySelector('input[data-list="blp-phishing"]')?.checked,
        annoyChecked: document.querySelector('input[data-list="fanboy-annoyance"]')?.checked,
        report: document.getElementById('dnr-report').textContent,
      };
    });
    h.check('chrome options UI: catalogue with name, licence, size, last update and toggles', ui.rows >= 20 && /EasyList/.test(ui.easylist) && /licence/.test(ui.easylist) && /updated/.test(ui.easylist) && /kB|MB/.test(ui.easylist) && ui.phishingChecked === true && ui.annoyChecked === false, ui);
    h.check('chrome options UI: rule report shows installed rules and limits', /Installed: .*limits/.test(ui.report) && /Protection: 2 hosts/.test(ui.report), ui.report);
    await opts.type('#custom-url', 'http://example.com/list.txt');
    await opts.click('#custom-add');
    await sleep(300);
    const msg = await opts.evaluate(() => document.getElementById('custom-msg').textContent);
    h.check('chrome options UI: custom list must be https', /only https/.test(msg), msg);
    const add = await swEval(() => globalThis.__adb.addCustomList('https://lists.example/custom.txt', 'filters'));
    const view2 = await swEval(() => globalThis.__adb.listsView());
    h.check('chrome: https custom list accepted and listed', add.ok && view2.custom.some((c) => c.url === 'https://lists.example/custom.txt'), add);
    await swEval((id) => globalThis.__adb.removeCustomList(id), add.id);

    await featureCases({
      h, browser, label: 'chrome', log, extOrigin: `chrome-extension://${extId}/`,
      ctl: {
        settings: (patch) => swEval((p) => globalThis.__adb.setGlobalSettings(p), patch),
        setStub: (stub) => swEval((x) => globalThis.__adb.setModelStub(x), stub),
        modelDebug: () => swEval(() => globalThis.__adb.modelDebug()),
        aiStatus: async (p) => swEval((id) => globalThis.__adb.aiTabStatus(id), await tabIdOf(p)),
        listState: async (id) => (await swEval(() => globalThis.__adb.status())).listStatus?.[id] ?? null,
        aiCache: async () => (await swEval(async () => (await chrome.storage.local.get('aiCache')).aiCache)) ?? {},
        setList: async (id, on) => {
          // Through the options page, like a user.
          await opts.bringToFront();
          await opts.reload();
          await waitFor(() => opts.evaluate((i) => !!document.querySelector(`input[data-list="${i}"]`), id), 5000);
          const cur = await opts.evaluate((i) => document.querySelector(`input[data-list="${i}"]`).checked, id);
          if (cur !== on) await opts.click(`input[data-list="${id}"]`);
          await waitFor(async () => (await swEval((i) => globalThis.__adb.listsView().then((v) => v.catalogue.find((e) => e.id === i).enabled), id)) === on, 5000);
        },
        continueBlocked: async (p) => {
          await p.click('#continue');
          return true;
        },
        protectStats: () => swEval(async () => ({ stats: await globalThis.__adb.protectionStats(), guard: globalThis.__adb.guardHits() })),
        protectReload: () => swEval(() => globalThis.__adb.reloadHostSet()),
        protectLookup: (host) => swEval((x) => globalThis.__adb.protectionLookup(x), host),
        setSiteEnabled: (site, on) => swEval((x, y) => globalThis.__adb.setSiteEnabled(x, y), site, on),
        strictNoContact: false,

        prepareShadow: (host) => swEval((hst) => {
          if (globalThis.__adbShadowHook) return;
          globalThis.__adbShadowHook = true;
          chrome.webNavigation.onCommitted.addListener((d) => {
            if (d.frameId === 0 && d.url.includes(hst)) chrome.scripting.executeScript({ target: { tabId: d.tabId }, injectImmediately: true, func: () => { window.__adbAiOpenShadow = true; } });
          });
        }, host),
      },
    });
    await opts.close();
  }

  // ---------- real lists (stress) ----------
  if (realLists) {
    await swEval((port) => globalThis.__adb.setSources([
      { id: 'easylist', url: `http://lists.test/real/easylist.txt` },
      { id: 'easyprivacy', url: `http://lists.test/real/easyprivacy.txt` },
      // Real EasyList Cookie List when dev-data has a copy (404 → kept out by the list fetcher).
      { id: 'easylist-cookie', url: `http://lists.test/real/fanboy-cookiemonster.txt` },
    ]), port);
    const t0 = Date.now();
    const real = await swEval(() => globalThis.__adb.refresh(true));
    const d = real.dnrStatus;
    h.info('real EasyList Cookie List (dev-data copy)', real.listStatus?.['easylist-cookie'] ? { bytes: real.listStatus['easylist-cookie'].bytes, error: real.listStatus['easylist-cookie'].error } : 'not configured');
    h.info('real EasyList+EasyPrivacy → DNR', { ms: Date.now() - t0, applyMs: d.ms, installedDynamic: d.installedDynamic, installedSession: d.installedSession, stats: d.stats, dropped: d.droppedByReason, notInDnr: d.notInDnr, rejected: d.rejected.length });
    h.check('real lists: all compiled rules accepted by Chrome', d.rejected.length === 0 && d.installedMain === d.stats.dynamicRules, { rejected: d.rejected.slice(0, 3), installedMain: d.installedMain, compiled: d.stats.dynamicRules });
    h.check('real lists: nothing dropped for rule limits', !d.droppedByReason['rule-limit'] && !d.droppedByReason['unsafe-rule-limit'] && !d.droppedByReason['regex-limit'], d.droppedByReason);
    const engineStats = (await swEval(() => globalThis.__adb.status())).engine;
    h.info('real lists engine stats', { network: engineStats.network, cosmetic: engineStats.cosmetic, popup: engineStats.popup, unsupported: engineStats.unsupported });
    // A known EasyList pattern must now block in a page.
    const p2 = await browser.newPage();
    await p2.goto(`http://publisher.test${P}/page.html`, { waitUntil: 'load' });
    const blockedReal = await p2.evaluate(async (port) => {
      const tryLoad = (src) => new Promise((r) => { const s = document.createElement('script'); s.src = src; s.onload = () => r('loaded'); s.onerror = () => r('blocked'); document.head.appendChild(s); });
      return {
        adsbygoogle: await tryLoad(`http://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js`),
        gtm: await tryLoad(`http://www.googletagmanager.com/gtm.js?id=GTM-X`),
        control: await tryLoad(`http://cdn.publisher.test/lib.js?2`),
      };
    }, port);
    h.check('real lists: googlesyndication & googletagmanager blocked, control loads', blockedReal.adsbygoogle === 'blocked' && blockedReal.gtm === 'blocked' && blockedReal.control === 'loaded', blockedReal);
    await p2.close();
  }

  // ---------- protection after a real service-worker stop (last: the worker handle is not used afterwards) ----------
  {
    await swEval(() => globalThis.__adb.setSources(null));
    await swEval(() => globalThis.__adb.refresh(false));
    const ext = await browser.newPage();
    await ext.goto(`chrome-extension://${extId}/options.html`);
    const msg = (m) => ext.evaluate((x) => chrome.runtime.sendMessage(x), m);
    const before = (await waitFor(async () => {
      const s = (await msg({ type: 'protect:stats' }))?.stats;
      return (s?.counts?.['blp-malware'] ?? 0) > 0 ? s : null;
    }, 120000, 500));
    // An entry not visited yet in this session (no guard session rule for it).
    const host = fullMalwareList().samples[2_600_000];
    const cdp = await ext.createCDPSession();
    await cdp.send('ServiceWorker.enable').catch(() => undefined);
    const stopAt = Date.now();
    const stopped = await cdp.send('ServiceWorker.stopAllWorkers').then(() => true, (e) => String(e));
    await cdp.detach().catch(() => undefined);
    await sleep(1000);
    const gone = !(await browser.targets()).some((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`));
    const p = await browser.newPage();
    const before2 = hits(host).length;
    const t0 = Date.now();
    await p.goto(`http://${host}/after-restart`, { waitUntil: 'load', timeout: 8000 }).catch(() => undefined);
    const url = await waitFor(async () => (p.url().startsWith(`chrome-extension://${extId}/`) ? p.url() : null), 8000, 100);
    const warnMs = Date.now() - t0;
    const after = (await msg({ type: 'protect:stats' }))?.stats;
    h.check('chrome: after a real service-worker stop, the first navigation to a listed host (entry 2,600,000) is warned', !!url && url.includes('blocked.html?list=blp-malware'), { url: url ?? p.url(), warnMs, stopped, workerGone: gone });
    h.check('chrome: the restarted worker reloaded the set from IndexedDB (not re-parsed)', after?.source === 'idb' && after.at > stopAt && after.counts?.['blp-malware'] === before.counts['blp-malware'], { before: { source: before.source, ms: before.ms }, after: after && { source: after.source, ms: after.ms } });
    h.info('chrome: cold worker → warning page', { warnMs, setReloadMs: after?.ms, requestsToHost: hits(host).length - before2 });
    await p.close();
    await ext.close();
  }
} catch (err) {
  h.check('test run completed without exceptions', false, `${globalThis.__e2eStep ? `[step: ${globalThis.__e2eStep}] ` : ''}${String(err?.stack ?? err)}`);
} finally {
  await browser.close().catch(() => undefined);
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(h.summary() ? 0 : 1);
