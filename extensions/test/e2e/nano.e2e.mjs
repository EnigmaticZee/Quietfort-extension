// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Real-model e2e: the three opt-in AI features (sponsored-content hiding, AI
// cookie-banner click plans, scam check) against Chrome's real on-device model
// (Prompt API, Chrome's built-in model) instead of the stub model.
//
//   NANO=1 NANO_PROFILE=/path/to/chrome-user-data-dir [NANO_RUNS=5] node test/e2e/nano.e2e.mjs [--headful]
//   npm run test:e2e:nano   (same, after a Chrome build)
//
// The model lives in the Chrome user-data dir, so NANO_PROFILE must be a
// dedicated test profile in which the model has been downloaded (see
// `--download`, which turns background networking back on and triggers the
// download through LanguageModel.create() and waits for it). Never point it at
// a real browsing profile.
//
// Skips cleanly (exit 0) unless NANO=1 and the model reports "available".
// Model output is not deterministic: every case runs NANO_RUNS times and the
// pass rate is reported. Safety properties are hard checks on every run
// (never accept cookies, never warn on a legitimate page); quality checks
// pass at >= NANO_MIN_RATE (default 0.8).

import puppeteer from 'puppeteer-core';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { createHarness, sleep, waitFor } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = join(ROOT, 'dist/chrome');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = process.env.NANO_PROFILE || '';
const RUNS = Math.max(1, Number(process.env.NANO_RUNS || 5));
const MIN_RATE = Number(process.env.NANO_MIN_RATE || 0.8);
const headful = process.argv.includes('--headful');
const download = process.argv.includes('--download');

if (process.env.NANO !== '1') {
  console.log('SKIP  real-model e2e: set NANO=1 (and NANO_PROFILE) to run it');
  process.exit(0);
}
if (!PROFILE || !existsSync(PROFILE)) {
  console.log(`SKIP  real-model e2e: NANO_PROFILE ${PROFILE ? `${PROFILE} does not exist` : 'not set'} (a dedicated Chrome user-data dir holding the on-device model)`);
  process.exit(0);
}

/** Flags that let branded Chrome use / fetch the on-device model under automation. */
export const NANO_ARGS = [
  '--no-first-run', '--no-default-browser-check',
  // OptimizationHints is disabled by puppeteer's defaults; the model provider needs it.
  '--enable-features=OptimizationGuideOnDeviceModel:BypassPerfRequirement/true,PromptAPIForGeminiNano,OptimizationHints',
];
const LM_OPTS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

// A fresh copy of the build at a new path (so a new extension id) every run: in a persistent profile Chrome
// keeps an installed unpacked copy's service-worker script cached, so reusing dist/chrome would run a stale worker.
const extCopy = mkdtempSync(join(tmpdir(), 'adb-nano-ext-'));
cpSync(EXT, extCopy, { recursive: true });

const h = createHarness('chrome real-model e2e');
const { server, port } = await startServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !headful,
  pipe: true,
  protocolTimeout: 120000,
  enableExtensions: [extCopy],
  userDataDir: PROFILE,
  // Background networking stays on only for --download (the component updater fetches the model).
  ignoreDefaultArgs: download ? ['--disable-background-networking', '--disable-component-update'] : [],
  args: [...NANO_ARGS, ...(download ? [] : [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>']), '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable'],
});

const vis = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return 'missing';
  const cs = getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden' ? 'hidden' : 'visible';
}, sel);

let exitCode = 0;
try {
  h.info('browser', await browser.version());
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
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

  const availability = () => swEval(async (o) => (typeof LanguageModel === 'undefined' ? 'no-api' : LanguageModel.availability(o).catch((e) => `error: ${e}`)), LM_OPTS);
  let avail = await availability();
  h.info('LanguageModel.availability() in the extension service worker', avail);

  if (download && (avail === 'downloadable' || avail === 'downloading')) {
    console.log('INFO  triggering the model download (LanguageModel.create with a download monitor)…');
    const t0 = Date.now();
    const r = await swEval(async (o) => {
      let last = -1;
      try {
        const s = await LanguageModel.create({ ...o, monitor(m) { m.addEventListener('downloadprogress', (e) => { const p = Math.floor(e.loaded * 100); if (p !== last) { last = p; console.log(`download ${p}%`); } }); } });
        s.destroy();
        return 'created';
      } catch (e) {
        return `create failed: ${e?.name} ${e?.message}`;
      }
    }, LM_OPTS).catch((e) => `error: ${e}`);
    h.info('download', { result: r, seconds: Math.round((Date.now() - t0) / 1000) });
    avail = await availability();
  }

  if (avail !== 'available') {
    console.log(`SKIP  real-model e2e: on-device model is "${avail}" in this profile (download it with --download; see chrome://on-device-internals)`);
  } else {
    await realModelCases(swEval);
    exitCode = h.summary() ? 0 : 1;
  }
} catch (err) {
  h.check('real-model run completed without exceptions', false, String(err?.stack ?? err));
  exitCode = h.summary() ? 0 : 1;
} finally {
  await browser.close().catch(() => undefined);
  server.close();
  rmSync(extCopy, { recursive: true, force: true });
}
process.exit(exitCode);

async function realModelCases(swEval) {
  // Configure the extension like the normal e2e: every list from the local test server, no stub.
  const ids = (await swEval(() => globalThis.__adb.listsView())).catalogue.map((e) => e.id);
  const overrides = Object.fromEntries(ids.map((id) => [id, `http://lists.test/catalogue/${id}.txt`]));
  overrides.easylist = 'http://lists.test/fixture.txt';
  overrides['easylist-cookie'] = 'http://lists.test/cookie.txt';
  await swEval(async (o) => {
    await globalThis.__adb.setUrlOverrides(o);
    await globalThis.__adb.setSources(null);
    globalThis.__adb.setModelStub(null);
  }, overrides);
  await swEval(() => globalThis.__adb.refresh(true));
  await swEval((p) => globalThis.__adb.setGlobalSettings(p), { ai: { sponsored: true, scam: true, cookiePlans: true } });
  const clearCache = () => swEval(() => chrome.storage.local.remove('aiCache'));
  const tabIdOf = async (p) => swEval(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, p.url());
  const aiStatus = async (p) => swEval((id) => globalThis.__adb.aiTabStatus(id), await tabIdOf(p));
  const debug = () => swEval(() => globalThis.__adb.modelDebug());
  const init = await swEval(() => globalThis.__adb.modelAvailability());
  h.check('extension sees the real model (no stub)', init === 'available' && (await debug()).stub === false, init);

  // Warm-up: the first session after browser start loads the model.
  const warm = await swEval(async (o) => {
    const t0 = Date.now();
    const s = await LanguageModel.create(o);
    const t1 = Date.now();
    const out = await s.prompt('Reply with the single word: ready');
    s.destroy();
    return { createMs: t1 - t0, promptMs: Date.now() - t1, out: out.slice(0, 40) };
  }, LM_OPTS);
  h.info('warm-up (model load + first prompt)', warm);

  const tally = new Map();
  const record = (name, ok, detail) => {
    const t = tally.get(name) ?? { pass: 0, runs: 0, fails: [] };
    t.runs++;
    if (ok) t.pass++;
    else t.fails.push(detail);
    tally.set(name, t);
  };
  const safety = [];
  const page = await browser.newPage();
  page.on('dialog', (d) => void d.accept().catch(() => undefined));

  for (let run = 1; run <= RUNS; run++) {
    await clearCache();
    console.log(`INFO  --- run ${run}/${RUNS} ---`);

    // Sponsored content: the existing fixture (ambiguous "Ad" card) + a mixed feed of weak-label blocks.
    {
      await page.goto('http://sponsored.test/page.html', { waitUntil: 'load' });
      // The content script reports at the end of each scan, i.e. after the model's verdicts.
      await waitFor(async () => ((await aiStatus(page))?.sponsored?.asked ?? 0) >= 1, 45000, 300);
      await sleep(500);
      const s = { ambiguous: await vis(page, '#card-ambiguous'), sponsored: await vis(page, '#card-sponsored'), normal: await vis(page, '#card-normal'), normal2: await vis(page, '#card-normal2'), story: await vis(page, '#story') };
      record('sponsored: ambiguous "Ad" garden-furniture card hidden by the model', s.ambiguous === 'hidden', s);
      const fp = s.normal !== 'visible' || s.normal2 !== 'visible' || s.story !== 'visible';
      if (fp) safety.push({ case: 'sponsored.test editorial hidden', s });

      await page.goto('http://sponsored-mix.test/page.html', { waitUntil: 'load' });
      await waitFor(async () => ((await aiStatus(page))?.sponsored?.asked ?? 0) >= 4, 60000, 300);
      await sleep(500);
      const m = { edOffer: await vis(page, '#ed-offer'), adPromo: await vis(page, '#ad-promo'), edPartner: await vis(page, '#ed-partner'), adSponsor: await vis(page, '#ad-sponsor'), story: await vis(page, '#story') };
      record('sponsored-mix: "Promo" meal-kit ad hidden', m.adPromo === 'hidden', m);
      record('sponsored-mix: "Sponsor" energy-deal ad hidden', m.adSponsor === 'hidden', m);
      record('sponsored-mix: editorial "Offer" story (pay offer) kept', m.edOffer === 'visible', m);
      record('sponsored-mix: editorial "Partners" story (research lab) kept', m.edPartner === 'visible', m);
      if (m.story !== 'visible') safety.push({ case: 'sponsored-mix main story hidden', m });
    }

    // Cookie click plans.
    for (const [host, expected] of [['cookies.test', '["more","reject-all"]'], ['cookies-de.test', '["necessary"]']]) {
      await page.goto(`http://${host}/page.html`, { waitUntil: 'load' });
      const ai = await waitFor(async () => {
        const a = await aiStatus(page);
        return a?.cookie?.result ? a : null;
      }, 45000, 300);
      const st = await page.evaluate(() => ({ clicked: window.__clicked, consent: window.__consent, banner: !!document.getElementById('cb') }));
      record(`cookie plan on ${host}: rejects (${expected})`, JSON.stringify(st.clicked) === expected && st.consent === 'none' && ai?.cookie?.result === 'rejected', { st, cookie: ai?.cookie });
      if (st.consent === 'all' || st.clicked.some((c) => /accept|save/.test(c))) safety.push({ case: `${host} accepted cookies`, st });
    }

    // Scam check: heuristic warn page, one model-confirmed scam, three legitimate pages.
    for (const [host, wantWarn, needsModel] of [['scam.test', true, false], ['parcel.test', true, true], ['scam-news.test', false, true], ['shop-sale.test', false, true], ['normal.test', false, false]]) {
      await page.goto(`http://${host}/page.html`, { waitUntil: 'load' });
      const ai = await waitFor(async () => {
        const a = await aiStatus(page);
        if (!a?.scam) return null;
        if (a.scam.decision === 'warn') return a;
        return !needsModel || a.scam.asked ? a : null;
      }, 45000, 300);
      if (!needsModel && !wantWarn) await sleep(2500);
      const banner = await page.evaluate(() => !!document.querySelector('adb-scam-warning'));
      const a2 = (await aiStatus(page)) ?? ai;
      const warned = banner || a2?.scam?.decision === 'warn';
      const label = wantWarn ? `scam: ${host} warned${needsModel ? ' (model confirms)' : ''}` : `scam: legitimate ${host} not warned`;
      record(label, warned === wantWarn && (!needsModel || a2?.scam?.asked === true), a2?.scam);
      if (!wantWarn && warned) safety.push({ case: `false scam warning on ${host}`, scam: a2?.scam });
      await page.goto('about:blank');
    }
  }

  // Latency from the worker's prompt log (real model only).
  const dbg = await debug();
  const lat = {};
  for (const p of dbg.lastPrompts) {
    if (typeof p.ms !== 'number') continue;
    (lat[p.task] ??= []).push(p.ms + (p.createMs ?? 0));
  }
  const stats = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { n: s.length, median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
  };
  h.info('latency per model call (session create + prompt, ms; last 30 calls)', Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stats(v)])));
  h.info('model calls this session', dbg.calls);
  if (process.env.NANO_DEBUG) for (const p of dbg.lastPrompts) console.log(`DEBUG ${p.task} ${p.ms ?? '-'}ms ${JSON.stringify(p.prompt)} => ${p.out ?? p.error}`);
  const errors = dbg.lastPrompts.filter((p) => p.error);
  if (errors.length) h.info('model errors', errors.map((e) => ({ task: e.task, error: e.error })));

  console.log('');
  for (const [name, t] of tally) {
    const rate = t.pass / t.runs;
    h.check(`[real model] ${name}: ${t.pass}/${t.runs} (${Math.round(rate * 100)}%)`, rate >= MIN_RATE, t.fails.length ? t.fails.slice(0, 2) : '');
  }
  h.check('[real model] safety: never accepted cookies, never warned on a legitimate page, never hid editorial content', safety.length === 0, safety.slice(0, 5));
  await page.close();
}
