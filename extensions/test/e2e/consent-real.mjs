// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Real-site check of cookie-banner handling (manual, needs the internet):
// the installed Google Chrome with dist/chrome loaded, real filter lists
// downloaded at runtime, against real EU-facing sites. Each site is loaded
// twice in fresh profiles: with cookie-banner handling OFF (control: does this
// network location get a banner at all?) and ON. Reports what it sees; it
// does not assert, because banners depend on region, A/B tests and bot checks.
//
//   node scripts/build.mjs chrome && node test/e2e/consent-real.mjs [--headful] [--out <dir>] [url...]

import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitFor } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = join(ROOT, 'dist/chrome');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const headful = argv.includes('--headful');
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null;
const urls = argv.filter((a, i) => /^https?:\/\//.test(a) && argv[i - 1] !== '--out');
const SITES = urls.length ? urls : [
  'https://www.theguardian.com/uk',
  'https://www.bbc.co.uk/',
  'https://www.lemonde.fr/',
  'https://www.spiegel.de/',
  'https://www.theverge.com/',
  'https://www.lefigaro.fr/',
  'https://www.corriere.it/',
  'https://elpais.com/',
];
if (OUT) mkdirSync(OUT, { recursive: true });

// Known consent-platform containers, plus a generic "fixed overlay talking about cookies" probe.
const probe = () => {
  const known = [
    '#onetrust-banner-sdk', '#onetrust-pc-sdk', '#didomi-popup', '#didomi-notice', '[id^="sp_message_container"]',
    'iframe[id^="sp_message_iframe"]', '#qc-cmp2-ui', '#CybotCookiebotDialog', '#usercentrics-root', '#usercentrics-cmp-ui',
    '#truste-consent-track', '.truste_box_overlay', '.fc-consent-root', '#cmpbox', '#iubenda-cs-banner', '.cmp-container',
    '#cmpwrapper', '#gdpr-consent-tool-wrapper', '.message-container', '#consent-banner', '#cookie-banner', '.qc-cmp2-container',
  ];
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 50 && r.height > 30 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  };
  const knownVisible = known.filter((s) => [...document.querySelectorAll(s)].some(visible));
  const vw = innerWidth, vh = innerHeight;
  const overlays = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.width * r.height) / (vw * vh) < 0.08) continue;
    const text = (el.innerText || '').slice(0, 2000);
    const isFrame = el.tagName === 'IFRAME';
    if (isFrame ? /consent|privacy|sp_message|cmp|sourcepoint|trustarc/i.test(el.src + el.id + el.title) : /cookie|consent|privacy|datenschutz|partenaires|partner|einwillig|consentimiento|tracciamento|vie privée/i.test(text)) {
      overlays.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className).slice(0, 60), area: Math.round((r.width * r.height) / (vw * vh) * 100) + '%', text: text.replace(/\s+/g, ' ').slice(0, 90) });
    }
    if (overlays.length > 4) break;
  }
  // Banner containers that exist but are hidden (by autoconsent or the cookie list).
  const hidden = [...document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[class*="privacy-banner" i],[id^="sp_message_container"],[class*="cp-wall"]')]
    .filter((el) => el.parentElement && !visible(el) && getComputedStyle(el).display === 'none' || (el.id?.startsWith?.('sp_message_container') && getComputedStyle(el).visibility === 'hidden'))
    .slice(0, 3).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''}`);
  return {
    title: document.title.slice(0, 60),
    hidden,
    knownVisible,
    overlays: overlays.slice(0, 3),
    scrollLocked: getComputedStyle(document.body).overflow === 'hidden' || getComputedStyle(document.documentElement).overflow === 'hidden',
  };
};

async function run(cookieBanners) {
  const profile = mkdtempSync(join(tmpdir(), `adb-real-${cookieBanners ? 'on' : 'off'}-`));
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: !headful, pipe: true, protocolTimeout: 60000, enableExtensions: [EXT], userDataDir: profile,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--lang=en-GB'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const results = [];
  try {
    const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 30000 });
    let sw = await swT.worker();
    const swEval = async (fn, ...a) => {
      try { return await sw.evaluate(fn, ...a); } catch {
        sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 })).worker();
        return sw.evaluate(fn, ...a);
      }
    };
    if (!cookieBanners) await swEval(() => globalThis.__adb.setCookieBanners(false));
    // Wait for the real lists (downloaded on install from their maintainers).
    const lists = await waitFor(async () => {
      const s = await swEval(() => globalThis.__adb.status());
      const ls = s.listStatus || {};
      return ls.easylist?.fetchedAt && ls.easyprivacy?.fetchedAt && (!cookieBanners || ls['easylist-cookie']?.fetchedAt) && s.dnrStatus ? s : null;
    }, 120000, 1000);
    const ls = lists?.listStatus ?? {};
    console.log(`\n=== cookie banners ${cookieBanners ? 'ON' : 'OFF (control)'} — lists: ${Object.entries(ls).map(([k, v]) => `${k} ${v.bytes}B${v.error ? ' ERR ' + v.error : ''}`).join(', ') || 'NOT READY'}`);
    for (const url of SITES) {
      const page = await browser.newPage();
      let r = { url };
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(12000);
        r = { url, final: page.url(), ...(await page.evaluate(probe)) };
        const tabId = await swEval(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
        r.consent = tabId ? await swEval((id) => globalThis.__adb.consentStatus(id), tabId) : null;
        if (OUT) await page.screenshot({ path: join(OUT, `${new URL(url).hostname}-${cookieBanners ? 'on' : 'off'}.png`) });
      } catch (err) {
        r.error = String(err.message || err).slice(0, 120);
      }
      results.push(r);
      const c = r.consent;
      console.log(`${url}\n   visible banner: ${r.knownVisible?.length || r.overlays?.length ? 'YES ' + JSON.stringify({ known: r.knownVisible, overlays: r.overlays }) : 'no'}${r.scrollLocked ? ' (scroll locked)' : ''}`
        + `${cookieBanners ? `\n   autoconsent: ${c?.cmp ? `${c.cmp} popup=${c.popup} optOut=${c.optOut} done=${c.done} cosmetic=${c.cosmetic} clicks=${c.clicks} frame=${c.frame}` : 'no CMP detected'}` : ''}`
        + `${c?.events?.length ? `\n   events: ${c.events.map((e) => `${e.frame}:${e.event}:${e.cmp}${e.result === null ? '' : '=' + e.result}`).join(', ')}` : ''}`
        + `${r.hidden?.length ? `\n   hidden banner elements: ${r.hidden.join(', ')}` : ''}`
        + `${r.error ? `\n   ERROR ${r.error}` : ''}`);
      await page.close();
    }
  } finally {
    await browser.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
  return results;
}

const off = await run(false);
const on = await run(true);
console.log('\n=== summary (control OFF → ON)');
for (let i = 0; i < SITES.length; i++) {
  const a = off[i], b = on[i];
  const shown = (x) => !!(x?.knownVisible?.length || x?.overlays?.length);
  const c = b?.consent;
  const verdict = a?.error || b?.error ? 'load error'
    : !shown(a) && !c?.cmp ? 'no banner shown to this browser/location (nothing to do)'
      : !shown(b) && c?.optOut ? `rejected by autoconsent (${c.cmp})`
        : !shown(b) && c?.done && c.cosmetic ? `hidden by autoconsent cosmetic rule (${c.cmp})`
          : !shown(b) && !c?.cmp ? 'banner not visible with feature on (hidden by cookie list or not shown)'
            : shown(b) ? `STILL VISIBLE${c?.cmp ? ` (autoconsent ${c.cmp}: optOut=${c.optOut})` : ' (no CMP rule matched)'}`
              : `not visible; autoconsent ${c?.cmp} optOut=${c?.optOut}`;
  console.log(`${SITES[i].padEnd(34)} OFF: ${shown(a) ? 'banner' : 'none'}  ON: ${shown(b) ? 'banner' : 'none'}  → ${verdict}`);
}
