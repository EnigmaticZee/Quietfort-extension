// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Real-site, real-model check of the three opt-in AI features (manual, needs
// the internet and a Chrome profile holding the built-in model; see nano.e2e.mjs):
//
//   (a) sponsored-content hiding on feed / search / news / shopping pages:
//       which elements the extension hid (text + crop screenshots), which
//       disclosure labels stayed visible;
//   (b) AI cookie-banner click plans with DuckDuckGo autoconsent and the
//       EasyList Cookie list switched OFF (so the AI path is exercised), plus a
//       control run (nothing on: does this location get a banner?) and a
//       comparison run (autoconsent on, AI off). Every click the page sees is
//       recorded; any click whose text reads as accept/agree/allow is a hard
//       failure, and so is a TCF consent string with purpose consents after the
//       AI run;
//   (c) scam check on popular legitimate sites (incl. pages that talk about
//       scams / viruses): any warning is a hard failure.
//
//   NANO=1 NANO_PROFILE=<dedicated chrome user-data dir> node test/e2e/nano-real.e2e.mjs \
//       [--phase sponsored,cookie,scam] [--rounds 2] [--out <dir>] [--headful] [--only <host-substring>]
//   npm run test:e2e:nano-real
//   --only takes comma-separated URL substrings; NR_MODES=control,ai,autoconsent picks the cookie runs.
//
// Uses only public pages; never logs in, never submits forms, never clicks
// anything itself (it scrolls feeds to load lazy content). The only clicks are
// the ones the extension makes on cookie banners. Sites that answer with a bot
// wall / 4xx are reported as skipped. Results (JSON + screenshots) go to --out
// (default: a new temp directory).
//
// Each run copies dist/chrome to a new path (new extension id; avoids a stale
// worker in the persistent profile). For the AI cookie runs the copy's
// autoconsent page script is replaced by a no-op and the cookie list URL points
// nowhere: the extension's AI path is then the only thing acting on banners.
// Cookies and site storage are cleared before every page load so banners come
// back in every round.

import puppeteer from 'puppeteer-core';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, sleep, waitFor } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = join(ROOT, 'dist/chrome');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = process.env.NANO_PROFILE || '';
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const headful = argv.includes('--headful');
const PHASES = (arg('phase', 'sponsored,cookie,scam')).split(',');
const ROUNDS = Math.max(1, Number(arg('rounds', process.env.NANO_ROUNDS || 2)));
const ONLY = arg('only', '');
const OUT = arg('out', '') || mkdtempSync(join(tmpdir(), 'adb-nano-real-'));
mkdirSync(join(OUT, 'shots'), { recursive: true });

if (process.env.NANO !== '1') {
  console.log('SKIP  real-site real-model e2e: set NANO=1 (and NANO_PROFILE) to run it');
  process.exit(0);
}
if (!PROFILE || !existsSync(PROFILE)) {
  console.log(`SKIP  real-site real-model e2e: NANO_PROFILE ${PROFILE ? `${PROFILE} does not exist` : 'not set'}`);
  process.exit(0);
}

// Same flags as nano.e2e.mjs (kept in sync by hand; importing it would run it).
const NANO_ARGS = [
  '--no-first-run', '--no-default-browser-check',
  '--enable-features=OptimizationGuideOnDeviceModel:BypassPerfRequirement/true,PromptAPIForGeminiNano,OptimizationHints',
];
const LM_OPTS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
const NOWHERE = 'http://127.0.0.1:9/none.txt';

// ---------- site lists ----------

/** (a) Pages that usually carry sponsored / promoted units (no login needed). */
export const SPONSORED_SITES = [
  'https://www.amazon.com/s?k=coffee+maker',
  'https://www.ebay.com/sch/i.html?_nkw=wireless+headphones',
  'https://www.target.com/s?searchTerm=bath+towels',
  'https://www.walmart.com/search?q=laptop',
  'https://www.etsy.com/search?q=ceramic+mug',
  'https://www.wayfair.com/keyword.php?keyword=sofa',
  'https://www.homedepot.com/s/cordless%20drill',
  'https://www.bing.com/search?q=car+insurance+quotes',
  'https://html.duckduckgo.com/html/?q=car+insurance+quotes',
  'https://old.reddit.com/r/technology/',
  'https://www.cnn.com/',
  'https://www.foxnews.com/',
  'https://www.usatoday.com/',
  'https://www.yahoo.com/',
  'https://www.msn.com/en-us',
  'https://www.nytimes.com/',
  'https://www.theguardian.com/us',
  'https://www.allrecipes.com/recipes/17562/dinner/',
  'https://www.foodnetwork.com/recipes',
  'https://www.nytimes.com/wirecutter/',
  'https://www.cnet.com/',
  'https://www.tomsguide.com/',
  'https://stackoverflow.com/questions',
  'https://www.huffpost.com/',
  'https://www.businessinsider.com/',
  'https://www.forbes.com/',
  'https://www.latimes.com/',
  'https://www.independent.co.uk/us',
  'https://www.dailymail.co.uk/ushome/index.html',
  'https://www.delish.com/',
  'https://www.buzzfeed.com/',
  'https://www.theverge.com/',
  'https://www.ign.com/',
  'https://weather.com/',
  'https://www.aol.com/',
  'https://www.bestbuy.com/site/searchpage.jsp?st=tv',
];

/**
 * (b) Sites with EU-style consent banners, chosen from a pre-screen of ~95 EU
 * sites from this test location (Toronto): many show no banner outside the
 * EU, many 403 headless Chrome. Groups: Sourcepoint banners in an iframe (the
 * AI path runs in large, visible consent iframes too; autoconsent covers these), "pay or
 * accept" walls (no free reject exists: the AI must click nothing), and
 * top-frame banners with a reject / necessary-only path.
 */
export const COOKIE_SITES = [
  // Sourcepoint, in an iframe
  'https://www.theguardian.com/uk',
  'https://www.spiegel.de/',
  'https://www.bild.de/',
  // pay or accept
  'https://www.corriere.it/',
  'https://www.repubblica.it/',
  'https://www.marca.com/',
  'https://www.ansa.it/',
  'https://www.gazzetta.it/',
  'https://www.ilmessaggero.it/',
  // top-frame banners with a reject path
  'https://www.amazon.de/',
  'https://www.amazon.it/',
  'https://www.amazon.es/',
  'https://www.rte.ie/',
  'https://www.irishtimes.com/',
  'https://www.thejournal.ie/',
  'https://www.trenitalia.com/',
  'https://www.lastampa.it/',
  'https://www.ilsole24ore.com/',
  'https://www.check24.de/',
  'https://www.ikea.com/fr/fr/',
  'https://www.dr.dk/',
  'https://www.ryanair.com/gb/en',
  'https://www.20min.ch/',
  'https://www.blick.ch/',
  'https://politiken.dk/',
  'https://index.hu/',
];

/** (c) Legitimate sites, several of which talk about viruses, scams, security alerts or payment. */
export const SCAM_SITES = [
  'https://www.google.com/',
  'https://en.wikipedia.org/wiki/Main_Page',
  'https://www.bbc.com/news',
  'https://www.amazon.com/',
  'https://www.ebay.com/',
  'https://www.chase.com/',
  'https://www.bankofamerica.com/',
  'https://www.wellsfargo.com/',
  'https://www.paypal.com/us/home',
  'https://www.usa.gov/',
  'https://www.irs.gov/',
  'https://www.gov.uk/',
  'https://www.apple.com/',
  'https://support.microsoft.com/en-us',
  'https://support.apple.com/en-us/102568',
  'https://consumer.ftc.gov/articles/how-spot-avoid-and-report-tech-support-scams',
  'https://www.fbi.gov/how-we-can-help-you/scams-and-safety/common-frauds-and-scams',
  'https://www.norton.com/',
  'https://www.mcafee.com/',
  'https://www.malwarebytes.com/',
  'https://www.usps.com/',
  'https://www.fedex.com/en-us/home.html',
  'https://www.coinbase.com/',
  'https://en.wikipedia.org/wiki/Technical_support_scam',
  'https://www.microsoft.com/en-us/concern/scams',
  'https://www.actionfraud.police.uk/',
  'https://www.canada.ca/en/revenue-agency/corporate/scams-fraud.html',
  'https://www.avast.com/',
  'https://www.kaspersky.com/',
  'https://www.bitdefender.com/',
  'https://www.ups.com/us/en/home',
  'https://www.dhl.com/us-en/home.html',
  'https://www.canadapost-postescanada.ca/cpc/en/home.page',
  'https://www.rbcroyalbank.com/',
  'https://www.td.com/ca/en/personal-banking',
  'https://www.capitalone.com/',
  'https://www.cnn.com/',
  'https://www.nytimes.com/',
  'https://www.target.com/',
  'https://www.bestbuy.ca/en-ca',
];

const pick = (list) => (ONLY ? list.filter((u) => ONLY.split(',').some((o) => u.includes(o))) : list);

const h = createHarness('real-site real-model e2e');
const all = { sponsored: [], cookie: [], scam: [] };
const save = () => writeFileSync(join(OUT, 'results.json'), JSON.stringify(all, null, 2));

// ---------- browser ----------

async function launch({ autoconsent }) {
  const extCopy = mkdtempSync(join(tmpdir(), 'adb-nano-real-ext-'));
  cpSync(EXT, extCopy, { recursive: true });
  if (!autoconsent) writeFileSync(join(extCopy, 'autoconsent/autoconsent.playwright.js'), '/* autoconsent disabled for the AI cookie test */\n');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !headful,
    pipe: true,
    protocolTimeout: 180000,
    enableExtensions: [extCopy],
    userDataDir: PROFILE,
    defaultViewport: { width: 1280, height: 900 },
    args: [...NANO_ARGS, '--window-size=1280,900', '--lang=en-US'],
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 30000 });
  let sw = await swTarget.worker();
  const swEval = async (fn, ...args) => {
    try {
      return await sw.evaluate(fn, ...args);
    } catch {
      const t = await browser.waitForTarget((x) => x.type() === 'service_worker' && x.url().endsWith('/background.js'), { timeout: 20000 });
      sw = await t.worker();
      return sw.evaluate(fn, ...args);
    }
  };
  const close = async () => {
    await browser.close().catch(() => undefined);
    rmSync(extCopy, { recursive: true, force: true });
  };
  return { browser, swEval, close };
}

/**
 * Configure: no ad / tracker lists (the AI sees the raw page), cookie list real
 * or pointing nowhere, the given AI features on.
 */
async function configure(swEval, { cookieList, ai }) {
  await swEval(async (o) => {
    globalThis.__adb.setModelStub(null);
    await globalThis.__adb.setUrlOverrides({});
    await globalThis.__adb.setCookieBanners(true);
    await globalThis.__adb.setSources(o.sources);
    await chrome.storage.local.remove('aiCache');
  }, { sources: cookieList ? [] : [{ id: 'easylist-cookie', url: NOWHERE, kind: 'filters' }] });
  await swEval(() => globalThis.__adb.refresh(true)).catch(() => undefined);
  await swEval((p) => globalThis.__adb.setGlobalSettings(p), { ai });
  // Count the content script's scan reports per tab (one per sponsored-filter scan).
  await swEval(() => {
    globalThis.__nrReports = {};
    chrome.runtime.onMessage.addListener((m, sender) => {
      if (m?.type === 'cs:aiReport' && sender.tab) globalThis.__nrReports[sender.tab.id] = (globalThis.__nrReports[sender.tab.id] ?? 0) + 1;
    });
  });
  const avail = await swEval(() => globalThis.__adb.modelAvailability());
  const warm = avail === 'available'
    ? await swEval(async (o) => {
      const t0 = Date.now();
      const s = await LanguageModel.create(o);
      await s.prompt('Reply with the single word: ready');
      s.destroy();
      return Date.now() - t0;
    }, LM_OPTS).catch((e) => String(e))
    : null;
  return { avail, warm };
}

// Main-world recorder, installed before any page script: clicks the page sees,
// and elements that get an inline `display: none !important` (how the
// extension's sponsored filter hides blocks).
function recorder() {
  if (window.__adbRec) return;
  const rec = { clicks: [], hidden: [] };
  window.__adbRec = rec;
  const txt = (el) => ((el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.value || '') + '').replace(/\s+/g, ' ').trim().slice(0, 120);
  addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('button, a, [role="button"], input') || e.target : null;
    if (!t) return;
    const c = { text: txt(t), tag: t.tagName.toLowerCase(), id: t.id || '', trusted: e.isTrusted, at: Math.round(performance.now()) };
    rec.clicks.push(c);
    // Consent iframes are often removed right after the click: also hand the record to the top frame.
    if (window !== window.top) try { window.top.postMessage({ __adbRecFrameClick: { ...c, frame: location.href.slice(0, 80) } }, '*'); } catch { /* ignore */ }
  }, true);
  rec.frameClicks = [];
  if (window === window.top) {
    addEventListener('message', (e) => {
      const c = e.data && e.data.__adbRecFrameClick;
      if (c && typeof c.text === 'string' && rec.frameClicks.length < 50) rec.frameClicks.push(c);
    });
  }
  // Style changes made by page scripts go through the main world's prototypes; the
  // extension's content script (isolated world) does not: that tells the two apart.
  const touched = new WeakSet();
  const decl2el = new WeakMap();
  const styleGet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')?.get;
  if (styleGet) {
    Object.defineProperty(HTMLElement.prototype, 'style', {
      configurable: true,
      get() {
        const d = styleGet.call(this);
        decl2el.set(d, this);
        return d;
      },
      set(v) {
        touched.add(this);
        styleGet.call(this).cssText = v;
      },
    });
  }
  const sp = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (...a) {
    const el = decl2el.get(this);
    if (el) touched.add(el);
    return sp.apply(this, a);
  };
  const ct = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
  if (ct?.set) {
    Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
      configurable: true,
      get: ct.get,
      set(v) {
        const el = decl2el.get(this);
        if (el) touched.add(el);
        ct.set.call(this, v);
      },
    });
  }
  const sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (String(n).toLowerCase() === 'style') touched.add(this);
    return sa.call(this, n, v);
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target;
      if (!(el instanceof HTMLElement) || el.dataset.adbHid) continue;
      if (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important') continue;
      el.dataset.adbHid = String(rec.hidden.length);
      rec.hidden.push({
        n: rec.hidden.length,
        by: touched.has(el) ? 'page' : 'extension',
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        links: [...new Set([...el.querySelectorAll('a[href]')].map((a) => { try { return new URL(a.href).hostname; } catch { return ''; } }).filter(Boolean))].slice(0, 5),
        frames: [...el.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 80)).slice(0, 3),
        at: Math.round(performance.now()),
      });
    }
    // Only changes since the last batch count as "page touched".
    for (const m of muts) touched.delete(m.target);
  });
  obs.observe(document, { attributes: true, attributeFilter: ['style'], subtree: true });
}

const BOT_WALL = /access denied|are you a (human|robot)|captcha|just a moment|attention required|pardon our interruption|robot check|verify you are human|unusual traffic|request blocked|bot detection|forbidden|something went wrong while loading|press & hold/i;

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
  await page.evaluateOnNewDocument(recorder);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.clearBrowserCookies').catch(() => undefined);
  await cdp.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' }).catch(() => undefined);
  let status = null;
  let error = null;
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = resp?.status() ?? null;
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => undefined);
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 160);
  }
  const loadMs = Date.now() - t0;
  let title = '';
  let bodyLen = 0;
  try {
    ({ title, bodyLen } = await page.evaluate(() => ({ title: document.title.slice(0, 100), bodyLen: (document.body?.innerText ?? '').length })));
  } catch { /* navigation in flight */ }
  const blocked = !error && ((status && status >= 400) || (BOT_WALL.test(title) && bodyLen < 3000) || (bodyLen < 200 && !title));
  return { page, cdp, status, error, title, loadMs, blocked, bodyLen };
}

async function tabIdOf(swEval, page) {
  return swEval(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? null, page.url());
}

async function aiStatus(swEval, page) {
  const id = await tabIdOf(swEval, page);
  return id == null ? null : swEval((i) => globalThis.__adb.aiTabStatus(i), id);
}

/** New model calls since `before` (the worker keeps the last 30, shows 10: we read right after each page). */
async function promptsSince(swEval, before) {
  await waitFor(async () => (await callCount(swEval)) < 1000, 30000, 300);
  const d = await swEval(() => globalThis.__adb.modelDebug());
  const n = Object.values(d.calls).reduce((a, b) => a + b, 0) - (before % 1000);
  return { total: Object.values(d.calls).reduce((a, b) => a + b, 0), prompts: n > 0 ? d.lastPrompts.slice(-Math.min(n, d.lastPrompts.length)) : [] };
}
async function callCount(swEval) {
  const d = await swEval(() => globalThis.__adb.modelDebug());
  // A prompt still running counts as a change (so we wait for its answer).
  const pending = d.lastPrompts.filter((p) => p.ms === undefined && p.error === undefined).length;
  return Object.values(d.calls).reduce((a, b) => a + b, 0) + pending * 1000;
}

const host = (u) => new URL(u).hostname.replace(/^www\./, '');
const shot = async (page, name) => {
  const p = join(OUT, 'shots', `${name}.png`);
  try {
    await page.screenshot({ path: p });
    return p;
  } catch {
    return null;
  }
};

// ---------- (a) sponsored ----------

/** Visible elements whose whole text is a disclosure label (not inside a hidden block). */
function remainingLabels() {
  const re = /^(sponsored|sponsored content|sponsored post|sponsored link|sponsored links|sponsored result|promoted|advertisement|ad|ads|paid content|paid post|partner content|paid partner content)$/i;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 2) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim().replace(/[·•|:]+$/, '').trim();
    if (t.length > 30 || !re.test(t)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || el.closest('[data-adb-hid]')) continue;
    if (el.parentElement && out.some((o) => o.el === el.parentElement)) continue;
    out.push({ el, text: t });
  }
  return out.slice(0, 40).map((o) => o.text);
}

async function settle(swEval, page, minMs, maxMs) {
  const t0 = Date.now();
  let last = await callCount(swEval);
  let lastHid = await page.evaluate(() => window.__adbRec?.hidden.length ?? 0).catch(() => 0);
  let stableSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(1000);
    const c = await callCount(swEval);
    const h = await page.evaluate(() => window.__adbRec?.hidden.length ?? 0).catch(() => 0);
    if (c !== last || h !== lastHid || c >= 1000) {
      last = c;
      lastHid = h;
      stableSince = Date.now();
    }
    if (Date.now() - t0 >= minMs && Date.now() - stableSince >= 4000) break;
  }
}

async function sponsoredRun(round) {
  const { browser, swEval, close } = await launch({ autoconsent: true });
  const results = [];
  try {
    const cfg = await configure(swEval, { cookieList: true, ai: { sponsored: true, scam: false, cookiePlans: false } });
    console.log(`INFO  sponsored round ${round}: model ${cfg.avail}, warm-up ${cfg.warm} ms`);
    if (cfg.avail !== 'available') throw new Error(`model is ${cfg.avail}`);
    for (const url of pick(SPONSORED_SITES)) {
      await swEval(() => chrome.storage.local.remove('aiCache'));
      const before = await callCount(swEval);
      const o = await openPage(browser, url);
      const r = { url, round, status: o.status, title: o.title, loadMs: o.loadMs };
      try {
        if (o.error || o.blocked) {
          Object.assign(r, { skipped: o.error ? `load error: ${o.error}` : `bot wall / blocked (status ${o.status}, "${o.title}")` });
          r.shot = await shot(o.page, `sponsored-r${round}-${host(url)}-blocked`);
        } else {
          await settle(swEval, o.page, 6000, 45000);
          // Lazy feeds: scroll a few screens (no clicks), let the filter rescan, back to the top.
          for (let i = 0; i < 4; i++) {
            await o.page.evaluate(() => scrollBy(0, innerHeight)).catch(() => undefined);
            await sleep(700);
          }
          await settle(swEval, o.page, 3000, 40000);
          await o.page.evaluate(() => scrollTo(0, 0)).catch(() => undefined);
          await sleep(500);
          const st = await aiStatus(swEval, o.page);
          const rec = await o.page.evaluate(() => window.__adbRec).catch(() => null);
          r.stats = st?.sponsored ?? null;
          r.scans = await swEval((i) => globalThis.__nrReports[i] ?? 0, await tabIdOf(swEval, o.page));
          r.hidden = rec?.hidden ?? [];
          r.remainingLabels = await o.page.evaluate(remainingLabels).catch(() => []);
          r.shot = await shot(o.page, `sponsored-r${round}-${host(url)}`);
          // Crop shots of up to 6 hidden blocks: unhide, screenshot, hide again.
          r.hiddenShots = [];
          for (const h of r.hidden.filter((x) => x.by === 'extension').slice(0, 6)) {
            const p = join(OUT, 'shots', `sponsored-r${round}-${host(url)}-hidden${h.n}.png`);
            try {
              const el = await o.page.$(`[data-adb-hid="${h.n}"]`);
              if (!el) continue;
              await el.evaluate((e) => e.style.removeProperty('display'));
              await el.scrollIntoView().catch(() => undefined);
              const box = await el.boundingBox();
              if (box && box.width > 4 && box.height > 4) {
                await el.screenshot({ path: p });
                r.hiddenShots.push(p);
              }
              await el.evaluate((e) => e.style.setProperty('display', 'none', 'important'));
            } catch { /* detached */ }
          }
        }
        const pr = await promptsSince(swEval, before);
        r.model = pr.prompts.map((p) => ({ ms: p.ms, createMs: p.createMs, out: p.out, error: p.error, input: p.prompt.slice(0, 400) }));
      } finally {
        await o.page.close().catch(() => undefined);
      }
      results.push(r);
      all.sponsored.push(r);
      save();
      const s = r.stats;
      console.log(`${r.skipped ? 'SKIP' : 'INFO'}  [a r${round}] ${url}  ${r.skipped ?? `hidden ${r.hidden.filter((x) => x.by === 'extension').length} (+${r.hidden.filter((x) => x.by === 'page').length} by page) (ext: hidden=${s?.hidden} asked=${s?.asked} kept=${s?.kept}, scans ${r.scans}), labels still visible ${r.remainingLabels.length}`}`);
      for (const h of (r.hidden ?? []).slice(0, 30)) console.log(`        ${h.by === 'page' ? '(page) ' : ''}hid <${h.tag}${h.cls ? ` .${h.cls.split(' ')[0]}` : ''}> "${h.text.slice(0, 110)}"`);
      for (const m of r.model ?? []) console.log(`        model ${m.ms ?? '-'}ms ${m.out ?? m.error}`);
    }
  } finally {
    await close();
  }
  return results;
}

// ---------- (b) cookie banners ----------

// Consent banner probe (top frame; consent iframes counted by their src / id).
function bannerProbe() {
  const known = [
    '#onetrust-banner-sdk', '#onetrust-pc-sdk', '#didomi-popup', '#didomi-notice', '[id^="sp_message_container"]',
    'iframe[id^="sp_message_iframe"]', '#qc-cmp2-ui', '#CybotCookiebotDialog', '#usercentrics-root', '#usercentrics-cmp-ui',
    '#truste-consent-track', '.truste_box_overlay', '.fc-consent-root', '#cmpbox', '#iubenda-cs-banner',
    '#cmpwrapper', '#gdpr-consent-tool-wrapper', '#consent-banner', '#cookie-banner', '.qc-cmp2-container', '#uc-banner',
  ];
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 50 && r.height > 30 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  };
  const knownVisible = known.filter((s) => [...document.querySelectorAll(s)].some(vis));
  const overlays = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.width * r.height) / (innerWidth * innerHeight) < 0.05) continue;
    const isFrame = el.tagName === 'IFRAME';
    const text = isFrame ? '' : (el.innerText || '').slice(0, 2000);
    const shadow = !!el.shadowRoot;
    if (isFrame ? /consent|privacy|sp_message|cmp|sourcepoint|trustarc|cookie/i.test(el.src + el.id + el.title)
      : /cookie|consent|datenschutz|partenaires|einwillig|consentimiento|tracciamento|vie privée|toestemming|privacy settings|your privacy|tracking/i.test(text) || (shadow && /cmp|consent|usercentrics|cookie/i.test(el.id + el.tagName))) {
      overlays.push({ tag: el.tagName.toLowerCase(), id: el.id, frame: isFrame, area: `${Math.round((r.width * r.height) / (innerWidth * innerHeight) * 100)}%`, text: text.replace(/\s+/g, ' ').slice(0, 100) });
    }
    if (overlays.length > 4) break;
  }
  return { banner: knownVisible.length > 0 || overlays.length > 0, knownVisible, overlays: overlays.slice(0, 3), inFrame: overlays.length > 0 && overlays.every((o) => o.frame) };
}

/** IAB TCF v2 consent state, if the site has a CMP with __tcfapi. */
function tcfState() {
  return new Promise((res) => {
    if (typeof window.__tcfapi !== 'function') return res(null);
    const t = setTimeout(() => res('timeout'), 2500);
    try {
      window.__tcfapi('getTCData', 2, (d, ok) => {
        clearTimeout(t);
        if (!ok || !d) return res('error');
        res({ eventStatus: d.eventStatus, gdprApplies: d.gdprApplies, purposeConsents: Object.values(d.purpose?.consents ?? {}).filter(Boolean).length, vendorConsents: Object.values(d.vendor?.consents ?? {}).filter(Boolean).length });
      });
    } catch {
      clearTimeout(t);
      res('error');
    }
  });
}

/** Clicked text that reads as accepting (independent of the extension's own vocabulary). */
export function readsAsAccept(text) {
  const t = String(text).toLowerCase();
  if (/(reject|refuse|decline|deny|necessary|essential|required|only|without|ablehnen|notwendig|erforderlich|nur |refuser|sans accepter|senza accettare|sin aceptar|sem aceitar|ohne|zonder|rechazar|necesari|rifiut|necessari|weigeren|noodzakelijk|avvisa|nødvendige|manage|settings|einstellungen|paramètres|options|preferences|customi[sz]e|personnaliser|anpassen|impostazioni|configurar)/.test(t)) return false;
  return /(accept|agree|allow|akzeptier|zustimm|einverstanden|annehmen|accepter|j'accepte|aceptar|acepto|accett|accetto|consent|akkoord|toestaan|godkänn|\bok\b|got it|continue|weiter|zgadzam)/.test(t);
}

async function cookieRun(round, mode) {
  // mode: control (nothing), ai (AI plans only), autoconsent (rules only)
  const { browser, swEval, close } = await launch({ autoconsent: mode === 'autoconsent' });
  const results = [];
  try {
    const cfg = await configure(swEval, { cookieList: mode === 'autoconsent', ai: { sponsored: false, scam: false, cookiePlans: mode === 'ai' } });
    console.log(`INFO  cookie ${mode} round ${round}: model ${cfg.avail}, warm-up ${cfg.warm} ms`);
    if (mode === 'ai' && cfg.avail !== 'available') throw new Error(`model is ${cfg.avail}`);
    for (const url of pick(COOKIE_SITES)) {
      await swEval(() => chrome.storage.local.remove('aiCache'));
      const before = await callCount(swEval);
      const o = await openPage(browser, url);
      const r = { url, round, mode, status: o.status, title: o.title, loadMs: o.loadMs };
      try {
        if (o.error || o.blocked) {
          r.skipped = o.error ? `load error: ${o.error}` : `bot wall / blocked (status ${o.status}, "${o.title}")`;
        } else {
          const t0 = Date.now();
          if (mode === 'ai') {
            // A consent iframe's flow starts a little after the top frame's "no banner here" and may hand
            // over to a second frame (Sourcepoint's privacy manager): wait for a final result, or give
            // frames 20 s when the top frame saw no banner.
            const interim = (c) => c.result === 'frame-closed' || (c.frame && c.result === 'gone');
            const final = (c) => c && ((c.result && (!interim(c) || Date.now() - t0 > 30000)) || (c.banner === false && Date.now() - t0 > 20000));
            r.ai = await waitFor(async () => {
              const a = await aiStatus(swEval, o.page);
              return final(a?.cookie) ? a.cookie : null;
            }, 60000, 500) ?? (await aiStatus(swEval, o.page))?.cookie ?? null;
            r.aiMs = Date.now() - t0;
            await sleep(2500);
          } else {
            await sleep(12000);
          }
          r.probe = await o.page.evaluate(bannerProbe).catch((e) => ({ error: String(e) }));
          r.tcf = await o.page.evaluate(tcfState).catch(() => null);
          r.clicks = [];
          // Top-frame clicks, plus iframe clicks relayed to the top (the iframe may be gone by now).
          const topRec = await o.page.evaluate(() => ({ clicks: window.__adbRec?.clicks ?? [], frameClicks: window.__adbRec?.frameClicks ?? [] })).catch(() => ({ clicks: [], frameClicks: [] }));
          for (const x of topRec.clicks) r.clicks.push({ ...x, frame: 'top' });
          for (const x of topRec.frameClicks) r.clicks.push(x);
          // Frames that could not relay (still present): read them directly, skipping ones already relayed.
          for (const f of o.page.frames()) {
            if (f === o.page.mainFrame()) continue;
            const c = await f.evaluate(() => window.__adbRec?.clicks ?? []).catch(() => []);
            for (const x of c) if (!topRec.frameClicks.some((y) => y.at === x.at && y.text === x.text)) r.clicks.push({ ...x, frame: f.url().slice(0, 80) });
          }
          // The extension's own record of what it clicked counts too.
          r.acceptClicks = [...r.clicks, ...((r.ai?.steps ?? []).map((t) => ({ text: String(t), source: 'ai-report' })))].filter((c) => readsAsAccept(c.text));
          if (mode === 'autoconsent') {
            const id = await tabIdOf(swEval, o.page);
            const c = id == null ? null : await swEval((i) => globalThis.__adb.consentStatus(i), id);
            r.autoconsent = c ? { cmp: c.cmp, popup: c.popup, optOut: c.optOut, done: c.done, cosmetic: c.cosmetic, clicks: c.clicks, frame: c.frame } : null;
          }
          r.shot = await shot(o.page, `cookie-${mode}-r${round}-${host(url)}`);
        }
        const pr = await promptsSince(swEval, before);
        r.model = pr.prompts.map((p) => ({ ms: p.ms, createMs: p.createMs, out: p.out, error: p.error, input: p.prompt.slice(0, 900) }));
      } finally {
        await o.page.close().catch(() => undefined);
      }
      results.push(r);
      all.cookie.push(r);
      save();
      const b = r.probe;
      console.log(`${r.skipped ? 'SKIP' : 'INFO'}  [b ${mode} r${round}] ${url}  ${r.skipped ?? `banner after: ${b?.banner ? `YES${b.inFrame ? ' (iframe)' : ''} ${JSON.stringify(b.knownVisible)} ${JSON.stringify(b.overlays?.map((x) => x.text || x.id))}` : 'no'}`}`
        + `${r.ai ? `\n        ai: ${JSON.stringify(r.ai)} (${r.aiMs} ms)` : ''}${r.autoconsent ? `\n        autoconsent: ${JSON.stringify(r.autoconsent)}` : ''}`
        + `${r.clicks?.length ? `\n        clicks: ${JSON.stringify(r.clicks.map((c) => c.text))}` : ''}${r.tcf ? `\n        tcf: ${JSON.stringify(r.tcf)}` : ''}`
        + `${r.acceptClicks?.length ? `\n        !!! ACCEPT-LIKE CLICK: ${JSON.stringify(r.acceptClicks)}` : ''}`);
      for (const m of r.model ?? []) console.log(`        model ${m.ms ?? '-'}ms ${m.out ?? m.error}`);
    }
  } finally {
    await close();
  }
  return results;
}

// ---------- (c) scam ----------

async function scamRun(round) {
  const { browser, swEval, close } = await launch({ autoconsent: true });
  const results = [];
  try {
    const cfg = await configure(swEval, { cookieList: true, ai: { sponsored: false, scam: true, cookiePlans: false } });
    console.log(`INFO  scam round ${round}: model ${cfg.avail}, warm-up ${cfg.warm} ms`);
    if (cfg.avail !== 'available') throw new Error(`model is ${cfg.avail}`);
    for (const url of pick(SCAM_SITES)) {
      const before = await callCount(swEval);
      const o = await openPage(browser, url);
      const r = { url, round, status: o.status, title: o.title, loadMs: o.loadMs };
      try {
        if (o.error || o.blocked) {
          r.skipped = o.error ? `load error: ${o.error}` : `bot wall / blocked (status ${o.status}, "${o.title}")`;
        } else {
          // The content script checks at DOM ready + 1.2 s, load + 1.5 s and DOM ready + 6 s.
          await sleep(7500);
          await waitFor(async () => {
            const a = await aiStatus(swEval, o.page);
            return a?.scam && (a.scam.decision !== 'ask' || a.scam.asked) ? a : null;
          }, 30000, 500);
          const a = await aiStatus(swEval, o.page);
          r.scam = a?.scam ?? null;
          r.banner = await o.page.evaluate(() => !!document.querySelector('adb-scam-warning')).catch(() => false);
          r.warned = r.banner || r.scam?.decision === 'warn';
          if (r.warned || r.scam?.asked) r.shot = await shot(o.page, `scam-r${round}-${host(url)}`);
        }
        const pr = await promptsSince(swEval, before);
        r.model = pr.prompts.map((p) => ({ ms: p.ms, createMs: p.createMs, out: p.out, error: p.error }));
      } finally {
        await o.page.close().catch(() => undefined);
      }
      results.push(r);
      all.scam.push(r);
      save();
      console.log(`${r.skipped ? 'SKIP' : r.warned ? 'WARN' : 'INFO'}  [c r${round}] ${url}  ${r.skipped ?? `score ${r.scam?.score ?? '-'} ${JSON.stringify(r.scam?.categories ?? [])} decision ${r.scam?.decision ?? 'none (no report)'}${r.scam?.asked ? (r.warned ? ' (model: scam)' : ' (model: not a scam)') : ''}${r.warned ? ' — WARNED' : ''}`}`);
      for (const m of r.model ?? []) console.log(`        model ${m.ms ?? '-'}ms ${m.out ?? m.error}`);
    }
  } finally {
    await close();
  }
  return results;
}

// ---------- main ----------

let exitCode = 0;
try {
  for (let round = 1; round <= ROUNDS; round++) {
    if (PHASES.includes('sponsored')) {
      await sponsoredRun(round);
    }
    if (PHASES.includes('cookie')) {
      for (const mode of (process.env.NR_MODES || 'control,ai,autoconsent').split(',')) {
        await cookieRun(round, mode);
      }
    }
    if (PHASES.includes('scam')) {
      await scamRun(round);
    }
  }
} catch (err) {
  h.check('run completed without exceptions', false, String(err?.stack ?? err));
}
save();

// ---------- summary ----------

const lat = (rows) => {
  const v = rows.flatMap((r) => r.model ?? []).filter((m) => typeof m.ms === 'number').map((m) => m.ms + (m.createMs ?? 0)).sort((a, b) => a - b);
  return v.length ? { calls: v.length, median: v[Math.floor(v.length / 2)], p90: v[Math.floor(v.length * 0.9)], max: v[v.length - 1] } : { calls: 0 };
};
console.log(`\n=== results in ${OUT}`);
if (all.sponsored.length) {
  const ok = all.sponsored.filter((r) => !r.skipped);
  h.info('(a) sponsored: pages tested / skipped', `${new Set(ok.map((r) => r.url)).size} / ${new Set(all.sponsored.filter((r) => r.skipped).map((r) => r.url)).size}`);
  h.info('(a) sponsored: blocks hidden by the extension (all rounds)', ok.reduce((a, r) => a + r.hidden.filter((x) => x.by === 'extension').length, 0));
  h.info('(a) sponsored: inline display:none!important set by the page itself (ignored)', ok.reduce((a, r) => a + r.hidden.filter((x) => x.by === 'page').length, 0));
  h.info('(a) sponsored: model latency per block (ms)', lat(all.sponsored));
  console.log('    precision needs a human label per hidden block: see the "hid" lines above / results.json + shots/');
}
if (all.cookie.length) {
  const ai = all.cookie.filter((r) => r.mode === 'ai' && !r.skipped);
  const accepts = ai.filter((r) => r.acceptClicks?.length || (r.tcf && typeof r.tcf === 'object' && r.tcf.purposeConsents > 0));
  const ac = all.cookie.filter((r) => r.mode === 'autoconsent' && !r.skipped);
  const ctl = all.cookie.filter((r) => r.mode === 'control' && !r.skipped);
  const shown = (u, round) => ctl.find((r) => r.url === u && r.round === round)?.probe?.banner;
  const withBanner = ai.filter((r) => shown(r.url, r.round));
  const aiRejected = withBanner.filter((r) => r.ai?.result === 'rejected' && !r.probe?.banner);
  const acWithBanner = ac.filter((r) => shown(r.url, r.round));
  const acGone = acWithBanner.filter((r) => !r.probe?.banner);
  h.info('(b) cookie: site-rounds with a banner in the control run', `${withBanner.length} (of ${ai.length} loaded)`);
  h.info('(b) cookie: AI rejected + banner gone', `${aiRejected.length}/${withBanner.length}`);
  h.info('(b) cookie: autoconsent banner gone', `${acGone.length}/${acWithBanner.length}`);
  h.info('(b) cookie: AI model latency per step (ms)', lat(ai));
  h.check('(b) cookie: the AI path never clicked anything that reads as accept, no TCF purpose consent after it', accepts.length === 0, accepts.map((r) => ({ url: r.url, round: r.round, clicks: r.acceptClicks, tcf: r.tcf })));
}
if (all.scam.length) {
  const ok = all.scam.filter((r) => !r.skipped);
  const warned = ok.filter((r) => r.warned);
  h.info('(c) scam: page loads checked / skipped', `${ok.length} / ${all.scam.length - ok.length}`);
  h.info('(c) scam: model asked', `${ok.filter((r) => r.scam?.asked).length} page loads`);
  h.info('(c) scam: model latency (ms)', lat(all.scam));
  h.check('(c) scam: no warning on any legitimate site', warned.length === 0, warned.map((r) => ({ url: r.url, round: r.round, scam: r.scam })));
}
exitCode = h.summary() ? 0 : 1;
process.exit(exitCode);
