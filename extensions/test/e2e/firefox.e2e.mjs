// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// End-to-end test: the installed Firefox, driven over WebDriver BiDi by
// puppeteer-core, with dist/firefox installed as a temporary add-on
// (BiDi webExtension.install). Same local test server as the Chrome test.
//
// BiDi cannot open moz-extension:// pages or reach the background page, so this
// test uses the e2e build (dist/firefox-e2e): identical code, except the
// default list URL points at the local server and the content script relays
// popup messages posted by the test page (both compiled out of real builds).
//
//   node scripts/build.mjs firefox --e2e-lists=http://lists.test/fixture.txt,easylist-cookie=http://lists.test/cookie.txt
//   node test/e2e/firefox.e2e.mjs [--headful]

import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { createHarness, sleep, waitFor } from './harness.mjs';
import { siteFixCases, pickerCases } from './sitefix-cases.mjs';
import { consentCases } from './consent-cases.mjs';
import { featureCases } from './feature-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = join(ROOT, 'dist/firefox-e2e');
const FIREFOX = process.env.FIREFOX_PATH || '/Applications/Firefox.app/Contents/MacOS/firefox';
const ADDON_ID = 'quietfort@enigmaticzee.github.io';
const UUID = '6f1d2c3b-0a9e-4e7f-8d6c-5b4a39281706';
const headful = process.argv.includes('--headful');

const h = createHarness('firefox e2e');
const { server, port, log, state } = await startServer();
const P = ''; // all hosts go through the local proxy on port 80 URLs
const profile = mkdtempSync(join(tmpdir(), 'adb-firefox-'));

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: FIREFOX,
  headless: !headful,
  userDataDir: profile,
  protocolTimeout: 30000,
  // Lets the test see and click the extension's own warning page (moz-extension://),
  // which WebDriver BiDi otherwise hides. Test browser process only.
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  extraPrefsFirefox: {
    // Firefox already ignores relaxed Referrer-Policies cross-site; turn that off
    // so the test sees the extension's own Referer trimming.
    'network.http.referer.disallowCrossSiteRelaxingDefault': false,
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': port,
    'network.proxy.allow_hijacking_localhost': true,
    'network.proxy.no_proxies_on': '',
    'dom.security.https_first': false,
    'dom.security.https_first_pbm': false,
    'dom.security.https_only_mode': false,
    'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: UUID }),
    'browser.link.open_newwindow': 3,
    'dom.disable_open_during_load': true,
  },
});

const hits = (host, path) => log.filter((l) => l.host === host && (!path || l.path === path));

/** Send a popup message through the e2e content-script relay of `page`. */
function relay(page, msg) {
  return page.evaluate((m) => new Promise((resolve) => {
    const id = Math.random();
    addEventListener('message', function f(e) {
      if (e.data && e.data.__adbTestReply === id) { removeEventListener('message', f); resolve(e.data.res); }
    });
    postMessage({ __adbTest: m, id }, '*');
  }), msg);
}

async function display(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display : 'missing';
  }, sel);
}

try {
  h.info('browser', await browser.version());
  const id = await browser.installExtension(EXT);
  h.check('temporary add-on installed', id === ADDON_ID, id);
  await sleep(1500);

  // The extension downloads its (test) list on install; wait until it filters.
  const page = await browser.newPage();
  const ready = await waitFor(async () => {
    await page.goto(`http://publisher.test${P}/page.html`, { waitUntil: 'load' });
    return (await page.evaluate(() => window.__libLoaded === true && window.__adLoaded === undefined));
  }, 20000, 500);
  h.check('list downloaded at runtime and engine active', ready);
  h.check('list fetched from the list host', hits('lists.test', '/fixture.txt').length >= 1);
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  const w = await page.evaluate(() => ({
    adLoaded: window.__adLoaded, lib: window.__libLoaded, realGpt: window.__realGpt, gptReady: window.googletag?.apiReady,
    regex: window.__regexAdLoaded, echo: window.__echo, hdr: window.__hdr, hdrKeep: window.__hdrKeep,
    adEnabled: window.adConfig?.enabled, early: window.__earlyEnabled, rawJs: window.__rawJsRan,
    imgs: Object.fromEntries([...document.images].map((i) => [i.id, i.naturalWidth])),
  }));
  h.info('page state', w);
  h.check('ad script blocked', w.adLoaded === undefined && hits('ads.adnet.test', '/ads/ad.js').length === 0);
  h.check('first-party library allowed', w.lib === true);
  h.check('third-party tracker pixel blocked', w.imgs['img-tracker'] === 0 && hits('tracker.test').length === 0);
  h.check('exception respected', w.imgs['img-excepted'] === 1);
  h.check('$important beats exception', w.imgs['img-important'] === 0 && hits('imp.test').length === 0);
  h.check('$redirect script stub', w.gptReady === true && w.realGpt === undefined && hits('redir.test', '/gpt.js').length === 0);
  h.check('$redirect 1x1.gif', w.imgs['img-redirect'] === 1 && hits('redir.test', '/pixel.gif').length === 0);
  h.check('regex rule blocks', w.regex === undefined && hits('cdn.other.test').length === 0);
  h.check('$~third-party not applied to third-party request', w.imgs['img-fp'] === 1);
  h.check('$removeparam strips utm_source', w.echo === '?id=1&x=2', w.echo);
  h.check('$removeheader strips response header', w.hdr === null && w.hdrKeep === 'kept', { hdr: w.hdr, keep: w.hdrKeep });
  h.check('generic keyed hiding', (await display(page, '#generic-ad')) === 'none');
  h.check('generic attribute hiding', (await display(page, '#attr-ad')) === 'none');
  h.check('site-specific hiding', (await display(page, '#specific-ad')) === 'none');
  h.check('procedural :has-text via runtime.js', (await display(page, '#sponsored')) === 'none');
  h.check('procedural does not over-match', (await display(page, '#not-sponsored')) !== 'none');
  h.check('cosmetic exception respected', (await display(page, '#excepted-cosmetic')) !== 'none');
  h.check('late element hidden', await waitFor(async () => (await display(page, '#late-ad')) === 'none', 3000));
  h.check('scriptlet set-constant', w.adEnabled === false, w.adEnabled);
  h.info('first visit: scriptlet ran before first inline script (no cache yet; timing, not guaranteed)', w.early === false ? 'yes' : `no (inline saw ${w.early})`);
  {
    // A page that streams in like a real site: scriptlets are in place before its first inline script.
    await page.goto(`http://publisher.test${P}/streamed.html`, { waitUntil: 'load' });
    const first = await page.evaluate(() => window.__streamedEarly);
    await page.goto(`http://publisher.test${P}/streamed.html?again`, { waitUntil: 'load' });
    const again = await page.evaluate(() => window.__streamedEarly);
    h.check('streamed page: scriptlet in place before the first inline script (first and repeat visit)', first === false && again === false, { first, again });
    await page.goto(`http://publisher.test${P}/page.html`, { waitUntil: 'load' });
    await sleep(1500);
  }
  h.check('raw JS / trusted scriptlets never run', w.rawJs === undefined);

  // Popups.
  const openPages = async () => (await browser.pages()).map((p) => p.url());
  const popupCase = async (label, selector, urlPart, expectClosed) => {
    await page.bringToFront();
    await page.click(selector);
    await sleep(2500);
    const urls = await openPages();
    const open = urls.some((u) => u.includes(urlPart));
    for (const p of await browser.pages()) if (p !== page && /goodsite|popads|popunder/.test(p.url())) await p.close();
    h.check(label, expectClosed ? !open : open, urls.filter((u) => u.startsWith('http')));
  };
  await popupCase('$popup closed', '#open-bad', 'popads.test' + P + '/landing', true);
  await popupCase('non-matching popup stays open', '#open-good', 'goodsite.test' + P + '/landing', false);
  await popupCase('$popup exception respected', '#open-allowed', 'popads.test' + P + '/allowed/x', false);
  await popupCase('about:blank → popads.test closed', '#open-blank-then-bad', 'popads.test' + P + '/later', true);
  await popupCase('$popup,third-party closed', '#open-3p', 'popunder.test', true);

  const csp = await browser.newPage();
  await csp.goto(`http://csp.publisher.test${P}/`, { waitUntil: 'load' });
  h.check('$csp blocks inline script', (await csp.evaluate(() => window.__inlineRan)) === undefined);
  await csp.close();

  const trusted = await browser.newPage();
  await trusted.goto(`http://trusted.test${P}/page.html`, { waitUntil: 'load' });
  await sleep(1200);
  h.check('$document exception: ad allowed, no hiding', (await trusted.evaluate(() => window.__adLoaded)) === true && (await display(trusted, '#generic-ad')) !== 'none');
  await trusted.close();

  // Per-site switch.
  await relay(page, { type: 'popup:setEnabled', site: 'publisher.test', enabled: false });
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  h.check('site off: nothing blocked or hidden', (await page.evaluate(() => window.__adLoaded)) === true && (await display(page, '#generic-ad')) !== 'none');
  await relay(page, { type: 'popup:setEnabled', site: 'publisher.test', enabled: true });
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  h.check('site on again: blocking resumes', (await page.evaluate(() => window.__adLoaded)) === undefined);

  // Popup state (what the toolbar popup shows) via the relay.
  await sleep(1000);
  const st = await relay(page, { type: 'popup:getState', tabId: 'sender' });
  h.check('popup state: host, enabled, blocked count', st.host === 'publisher.test' && st.enabled === true && st.blocked >= 6 && st.platform === 'firefox', st);

  // ---------- Fix this site / element picker (messages through the page's relay) ----------
  const ONCE = new Set(['fix:start', 'fix:answer', 'fix:undo', 'fix:permanent', 'test:advanceClock', 'test:pruneExceptions', 'popup:pick', 'picker:remove', 'fix:cancel']);
  const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('relay timeout'); })]);
  const send = async (p, msg) => {
    const m = { ...msg, tabId: 'sender' };
    // Actions that reload the tab may lose their reply with the old document: never repeat them.
    if (ONCE.has(msg.type)) return withTimeout(relay(p, m), 5000).catch(() => null);
    for (let i = 0; i < 20; i++) {
      try {
        const r = await withTimeout(relay(p, m), 3000);
        if (r !== undefined) return r;
      } catch { /* page navigating */ }
      await sleep(250);
    }
    throw new Error(`relay failed: ${msg.type}`);
  };
  await siteFixCases({ h, browser, send, hits, log, label: 'firefox' });
  await pickerCases({ h, browser, send, state, label: 'firefox' });

  // ---------- cookie banners ----------
  const cookieListState = async (p) => (await send(p, { type: 'popup:getState' })).lists?.['easylist-cookie'] ?? null;
  {
    const probe = await browser.newPage();
    await probe.goto('http://cmp.test/no-cmp.html', { waitUntil: 'load' });
    h.check('firefox: cookie list downloaded at runtime (cookie banners on by default)', !!(await waitFor(async () => (await cookieListState(probe))?.fetchedAt, 10000, 300)));
    await probe.close();
  }
  const cpage = await consentCases({
    h, browser, label: 'firefox',
    status: async (p) => (await send(p, { type: 'popup:getState' })).consent ?? null,
    setCookieBanners: async (on) => {
      const p = await browser.newPage();
      await p.goto('http://cmp.test/no-cmp.html', { waitUntil: 'load' });
      await send(p, { type: 'settings:set', cookieBanners: on });
      await waitFor(async () => {
        const s = await send(p, { type: 'popup:getState' });
        return s.cookieBanners === on && (on ? !!s.lists?.['easylist-cookie']?.fetchedAt : !s.lists?.['easylist-cookie']);
      }, 10000, 300);
      await p.close();
    },
  });
  const cst = await send(cpage, { type: 'popup:getState' });
  h.check('firefox popup state: cookie setting on, banner reported rejected', cst.cookieBanners === true && cst.consent?.cmp === 'Onetrust' && cst.consent.optOut === true, { cookieBanners: cst.cookieBanners, consent: cst.consent });
  await cpage.close();

  // ---------- list chooser, protection, privacy, AI ----------
  {
    const ctlPage = await browser.newPage();
    await ctlPage.goto('http://relay.test/', { waitUntil: 'load' });
    const ctlSend = (msg) => send(ctlPage, msg);
    const lists = await ctlSend({ type: 'lists:get' });
    const enabled = lists.catalogue.filter((e) => e.enabled).map((e) => e.id);
    h.check('firefox catalogue: default lists on (EasyList, EasyPrivacy, cookie, protection), annoyances/social off', ['easylist', 'easyprivacy', 'easylist-cookie', 'blp-phishing', 'blp-scam', 'blp-fraud', 'blp-ransomware'].every((x) => enabled.includes(x)) && !enabled.includes('fanboy-annoyance') && !enabled.includes('fanboy-social'), enabled);
    const bad = await ctlSend({ type: 'lists:addCustom', url: 'http://example.com/list.txt' });
    h.check('firefox: custom list must be https', bad?.ok === false && /https/.test(bad.error), bad);
    const settingsNow = await ctlSend({ type: 'settings:get' });
    h.info('Prompt API in Firefox', settingsNow.model);
    await featureCases({
      h, browser, label: 'firefox', log, extOrigin: `moz-extension://${UUID}/`,
      ctl: {
        settings: (patch) => ctlSend({ type: 'settings:set', ...patch }),
        setStub: (stub) => ctlSend({ type: 'test:modelStub', stub }),
        modelDebug: () => ctlSend({ type: 'test:modelDebug' }),
        aiStatus: async (p) => (await send(p, { type: 'popup:getState' })).ai ?? null,
        listState: async (x) => (await ctlSend({ type: 'popup:getState' })).lists?.[x] ?? null,
        aiCache: async () => null,
        setList: async (x, on) => {
          await ctlSend({ type: 'lists:set', id: x, enabled: on });
        },
        protectStats: () => ctlSend({ type: 'protect:stats' }),
        protectReload: () => ctlSend({ type: 'test:protectReload' }),
        protectLookup: (host) => ctlSend({ type: 'test:protectLookup', host }),
        setSiteEnabled: (site, on) => ctlSend({ type: 'popup:setEnabled', site, enabled: on }),
        strictNoContact: true,
        continueBlocked: async (p) => {
          try {
            await p.click('#continue');
            return true;
          } catch (err) {
            h.info('firefox: clicking Continue on the moz-extension page', String(err));
            return false;
          }
        },
      },
    });
    await ctlPage.close();
  }
} catch (err) {
  h.check('test run completed without exceptions', false, `${globalThis.__e2eStep ? `[step: ${globalThis.__e2eStep}] ` : ''}${String(err?.stack ?? err)}`);
} finally {
  await browser.close().catch(() => undefined);
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(h.summary() ? 0 : 1);
