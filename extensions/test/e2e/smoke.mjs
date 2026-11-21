// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Smoke test against the real internet with the PRODUCTION builds: the
// extension must download EasyList + EasyPrivacy from easylist.to on install,
// compile them, and block ad/tracker requests on real sites.
//
//   node test/e2e/smoke.mjs [chrome|firefox ...]

import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, sleep, waitFor } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const which = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const BROWSERS = which.length ? which : ['chrome', 'firefox'];
const SITES = ['https://www.theguardian.com/international', 'https://edition.cnn.com/', 'https://www.speedtest.net/'];
const AD_HOSTS = /doubleclick\.net|googlesyndication\.com|googletagservices\.com|adnxs\.com|amazon-adsystem\.com|criteo\.|taboola\.com|outbrain\.com|scorecardresearch\.com|google-analytics\.com|googletagmanager\.com|chartbeat\.|permutive\.|hotjar\.|quantserve\.com|moatads\.com|pubmatic\.com|rubiconproject\.com|casalemedia\.com|bing\.com\/action|facebook\.net/;

const h = createHarness('real-site smoke');

async function visit(browser, url, label) {
  const page = await browser.newPage();
  const failed = [];
  const ok = [];
  page.on('requestfailed', (r) => failed.push([r.url(), r.failure()?.errorText]));
  page.on('requestfinished', (r) => {
    // A $redirect rule answers with an internal 307 to the extension's stand-in
    // (chrome-extension:// / moz-extension://): the request never left the browser.
    const res = r.response();
    const loc = res?.headers()?.location ?? '';
    if (res && res.status() === 307 && /^(chrome|moz)-extension:\/\//.test(loc)) failed.push([r.url(), 'redirected to stand-in (blocked)']);
    else ok.push(r.url());
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    h.info(`${label} ${url}`, `navigation: ${String(err).slice(0, 120)}`);
  }
  await sleep(8000);
  const blocked = failed.filter(([, e]) => /BLOCKED_BY_CLIENT|NS_ERROR_ABORT|NS_BINDING_ABORTED|blocked/i.test(e || ''));
  const blockedAds = blocked.filter(([u]) => AD_HOSTS.test(u));
  const leakedAds = ok.filter((u) => AD_HOSTS.test(u));
  await page.close();
  return { requests: ok.length + failed.length, blocked: blocked.length, blockedAds: blockedAds.length, leakedAds: [...new Set(leakedAds.map((u) => new URL(u).host))], sampleBlocked: [...new Set(blocked.map(([u]) => new URL(u).host))].slice(0, 8) };
}

for (const name of BROWSERS) {
  const profile = mkdtempSync(join(tmpdir(), `adb-smoke-${name}-`));
  let browser;
  try {
    if (name === 'chrome') {
      browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, pipe: true, protocolTimeout: 60000, enableExtensions: [join(ROOT, 'dist/chrome')], userDataDir: profile,
        args: ['--no-first-run', '--no-default-browser-check'],
      });
      const t = await browser.waitForTarget((x) => x.type() === 'service_worker' && x.url().endsWith('/background.js'));
      const sw = await t.worker();
      const t0 = Date.now();
      const st = await waitFor(async () => {
        const s = await sw.evaluate(() => globalThis.__adb.status());
        return s.dnrStatus && s.listStatus?.easylist?.bytes && s.listStatus?.easyprivacy?.bytes ? s : null;
      }, 90000, 1000);
      h.check('chrome: EasyList + EasyPrivacy fetched from easylist.to and compiled', !!st, st ? { ms: Date.now() - t0, lists: Object.fromEntries(Object.entries(st.listStatus).map(([k, v]) => [k, v.bytes])), dnr: { installed: st.dnrStatus.installedDynamic + st.dnrStatus.installedSession, dropped: st.dnrStatus.droppedByReason, rejected: st.dnrStatus.rejected.length, applyMs: st.dnrStatus.ms } } : 'timeout');
    } else {
      browser = await puppeteer.launch({
        browser: 'firefox', executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox', headless: true, userDataDir: profile, protocolTimeout: 60000,
      });
      await browser.installExtension(join(ROOT, 'dist/firefox'));
      await sleep(15000); // download + parse on install (no handle into the background page over BiDi)
      h.info('firefox', 'waited 15 s for list download');
    }
    for (const url of SITES) {
      const r = await visit(browser, url, name);
      h.info(`${name} ${url}`, r);
      // Pass = something was blocked AND no request to a well-known ad/tracker host got through.
      h.check(`${name}: blocks on ${new URL(url).host}, no known ad/tracker host leaked`, r.blocked > 0 && r.leakedAds.length === 0, { blocked: r.blocked, leaked: r.leakedAds });
    }
  } catch (err) {
    h.check(`${name}: smoke run completed`, false, String(err).slice(0, 300));
  } finally {
    await browser?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
}
process.exit(h.summary() ? 0 : 1);
