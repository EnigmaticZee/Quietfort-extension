// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Real Chrome, dist/chrome (production build): welcome page, pause everywhere,
// My Rules, trusted sites, "what was blocked", backup / restore, describe it to
// hide it, right-click "Hide this element", zap (remove until reload). Messages are sent from the
// extension's own settings page, as the real UI does.
//
//   node scripts/build.mjs chrome && node test/e2e/extras.e2e.mjs [--headful]

import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { createHarness, sleep, waitFor } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = join(ROOT, 'dist/chrome');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headful = process.argv.includes('--headful');

const h = createHarness('extras e2e');
const { server, port, log } = await startServer();
const profile = mkdtempSync(join(tmpdir(), 'qf-extras-'));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !headful, pipe: true, protocolTimeout: 30000, enableExtensions: [EXT], userDataDir: profile,
  args: ['--no-first-run', '--no-default-browser-check', `--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable'],
});
// (The fixture list allows adnet.test/ads/allowed/ on purpose.)
const hits = (host) => log.filter((l) => (l.host === host || l.host.endsWith(`.${host}`)) && !l.path.startsWith('/ads/allowed/')).length;

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  const swEval = (fn, ...a) => sw.evaluate(fn, ...a);

  // ---------- welcome page ----------
  const welcome = await waitFor(async () => (await browser.pages()).find((p) => p.url().includes('/welcome.html')), 8000);
  h.check('welcome page opens once on install', !!welcome, welcome?.url());

  await swEval((url) => globalThis.__adb.setSources([{ id: 'fixture', url }]), 'http://lists.test/fixture.txt');
  await swEval(() => globalThis.__adb.refresh(true));

  if (welcome) {
    await welcome.reload();
    const st = await waitFor(() => welcome.$eval('#status', (e) => e.textContent).then((t) => (/ready|downloaded/.test(t) ? t : null)), 15000);
    h.check('welcome page shows list status', !!st, st);
    await welcome.click('input[value=fortNight]');
    const theme = await swEval(() => chrome.storage.local.get('theme').then((r) => r.theme));
    h.check('welcome page theme choice is saved', theme === 'fortNight', theme);
  }

  // The extension page we send messages from (as the popup / settings do).
  const ui = await browser.newPage();
  await ui.goto(`chrome-extension://${extId}/options.html`);
  const send = (msg) => ui.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const site = await browser.newPage();
  const tabIdOf = async (page) => {
    const url = page.url();
    return swEval((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === u)?.id ?? -1), url);
  };

  // ---------- pause everywhere ----------
  await site.goto('http://publisher.test/page.html', { waitUntil: 'load' });
  await sleep(300);
  const adBefore = hits('adnet.test');
  h.check('baseline: ads blocked', adBefore === 0, { adnet: adBefore });

  const paused = await send({ type: 'pause:set', minutes: -1 });
  h.check('pause: until resumed', paused.pausedUntil > Date.now() + 1e12, paused);
  const allow = await swEval(() => chrome.declarativeNetRequest.getDynamicRules().then((rs) => rs.find((r) => r.id === 1)));
  h.check('pause: one allow-all rule on every site', allow && !allow.condition.requestDomains && allow.action.type === 'allowAllRequests', allow);
  const badge = await swEval(() => chrome.action.getBadgeText({}));
  h.check('pause: amber "II" badge', badge === 'II', badge);
  await site.reload({ waitUntil: 'load' });
  await sleep(300);
  h.check('pause: ads load while paused', hits('adnet.test') > adBefore, { adnet: hits('adnet.test') });
  const ps = await send({ type: 'popup:getState', tabId: await tabIdOf(site) });
  h.check('pause: popup state says paused, site switch off', ps.pausedUntil > 0 && ps.enabled === false, { pausedUntil: ps.pausedUntil, enabled: ps.enabled });

  await send({ type: 'pause:set', minutes: 0 });
  const after = hits('adnet.test');
  await site.reload({ waitUntil: 'load' });
  await sleep(300);
  const allowAfter = await swEval(() => chrome.declarativeNetRequest.getDynamicRules().then((rs) => rs.find((r) => r.id === 1) ?? null));
  h.check('resume: ads blocked again, allow rule gone', hits('adnet.test') === after && !allowAfter, { adnet: hits('adnet.test'), allowAfter });
  h.check('resume: badge cleared', (await swEval(() => chrome.action.getBadgeText({}))) === '');

  await send({ type: 'pause:set', minutes: 60 });
  const alarm = await swEval(() => chrome.alarms.get('pause-end'));
  h.check('pause 1 hour: ends by itself (alarm set)', alarm && Math.abs(alarm.scheduledTime - Date.now() - 3600e3) < 60e3, alarm);
  await send({ type: 'pause:set', minutes: 0 });
  h.check('resume: alarm cleared', !(await swEval(() => chrome.alarms.get('pause-end'))));

  // ---------- log ----------
  const logView = await send({ type: 'log:get', tabId: await tabIdOf(site) });
  h.check('what was blocked: lists the ad requests on the page', logView.blocked.some((b) => b.url.includes('adnet.test')), logView.blocked.slice(0, 3));
  const logPage = await browser.newPage();
  await logPage.goto(`chrome-extension://${extId}/log.html?tabId=${await tabIdOf(site)}`);
  const rows = await waitFor(() => logPage.$$eval('#rows tr', (r) => r.length), 5000);
  h.check('what was blocked page: rows shown', rows > 0, rows);
  await logPage.close();

  // ---------- My Rules ----------
  await site.goto('http://describe.test/page.html', { waitUntil: 'load' });
  h.check('before My Rules: custom image loads', hits('custom-block.test') > 0, hits('custom-block.test'));
  const set = await send({ type: 'rules:set', text: '! mine\n||custom-block.test^\ndescribe.test##.masthead\nexample.com##^script:has-text(x)\n' });
  h.check('My Rules saved and checked (2 rules, 1 unusable line)', set.ok && set.check.rules === 2 && set.check.problems.length === 1, set.check);
  const installed = await waitFor(() => swEval(() => chrome.declarativeNetRequest.getDynamicRules().then((rs) => rs.some((r) => JSON.stringify(r.condition).includes('custom-block.test')))), 10000);
  h.check('My Rules: rule installed', installed);
  const c0 = hits('custom-block.test');
  await site.reload({ waitUntil: 'load' });
  await sleep(400);
  h.check('My Rules: request blocked', hits('custom-block.test') === c0, hits('custom-block.test'));
  const mast = await site.$eval('.masthead', (e) => getComputedStyle(e).display);
  h.check('My Rules: element hidden', mast === 'none', mast);
  const got = await send({ type: 'rules:get' });
  h.check('My Rules: read back', got.text.includes('||custom-block.test^'));

  // ---------- trusted sites ----------
  let sites = await send({ type: 'sites:set', add: ['https://www.describe.test/some/page'] });
  h.check('trusted sites: address normalised and added', sites.ok && sites.sites.includes('describe.test'), sites);
  const bad = await send({ type: 'sites:set', add: ['not a site'] });
  h.check('trusted sites: garbage refused', !bad.ok, bad.error);
  const c1 = hits('custom-block.test');
  await site.reload({ waitUntil: 'load' });
  await sleep(400);
  h.check('trusted sites: blocking off there', hits('custom-block.test') > c1);
  sites = await send({ type: 'sites:set', remove: ['describe.test'] });
  h.check('trusted sites: removed', sites.ok && !sites.sites.includes('describe.test'), sites);

  // ---------- describe it to hide it ----------
  await site.reload({ waitUntil: 'load' });
  const tid = await tabIdOf(site);
  // Diagnostics only: open shadow root so the test can read the picker panel.
  await swEval((t) => chrome.scripting.executeScript({ target: { tabId: t }, func: () => { window.__adbPickerOpenShadow = true; } }), tid);
  const d = await send({ type: 'popup:describe', tabId: tid, text: 'the newsletter pop-up' });
  h.check('describe: found (word matching, no model in test Chrome)', d.ok && d.found, d);
  const pickedSel = await waitFor(() => site.evaluate(() => {
    const host = document.getElementById('__adb_picker');
    const first = host?.shadowRoot?.querySelector('label.cand');
    return first ? first.dataset.selector : null;
  }), 4000);
  const matchesModal = pickedSel ? await site.evaluate((s) => { try { const els = document.querySelectorAll(s); return els.length === 1 && els[0].classList.contains('nl-modal'); } catch { return false; } }, pickedSel) : false;
  h.check('describe: picker opens on the newsletter modal', matchesModal, pickedSel);
  // Press Hide in the picker.
  await site.evaluate(() => document.getElementById('__adb_picker').shadowRoot.getElementById('adb-save').click());
  await sleep(500);
  const modal = await site.$eval('.nl-modal', (e) => getComputedStyle(e).display);
  h.check('describe: Hide hides it', modal === 'none', modal);
  await site.reload({ waitUntil: 'load' });
  await sleep(500);
  h.check('describe: stays hidden after reload', (await site.$eval('.nl-modal', (e) => getComputedStyle(e).display)) === 'none');
  const none = await send({ type: 'popup:describe', tabId: tid, text: 'weather forecast' });
  h.check('describe: nothing matching → not found, nothing opened', none.ok && !none.found, none);

  // ---------- right-click "Hide this element" ----------
  await swEval((t) => chrome.scripting.executeScript({ target: { tabId: t }, func: () => { window.__adbPickerOpenShadow = true; } }), tid);
  await site.evaluate(() => {
    const el = document.getElementById('chat-launcher');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  await swEval((t) => globalThis.__adb.pickFromContext(t, 0), tid);
  const ctxSel = await waitFor(() => site.evaluate(() => document.getElementById('__adb_picker')?.shadowRoot?.querySelector('label.cand')?.dataset.selector ?? null), 4000);
  const ctxOk = ctxSel ? await site.evaluate((s) => { try { const els = document.querySelectorAll(s); return els.length === 1 && els[0].id === 'chat-launcher'; } catch { return false; } }, ctxSel) : false;
  h.check('right-click: picker opens on the right-clicked element', ctxOk, ctxSel);
  await site.keyboard.press('Escape');

  // ---------- zap: remove until reload ----------
  await site.reload({ waitUntil: 'load' });
  const savedBefore = (await swEval(() => chrome.storage.local.get('pickerRules').then((r) => r.pickerRules ?? []))).length;
  await site.evaluate(() => { window.__pageClicks = 0; document.getElementById('chat-launcher').addEventListener('click', () => window.__pageClicks++); });
  // Diagnostics only: open shadow root so the test can press Undo.
  await swEval((t) => chrome.scripting.executeScript({ target: { tabId: t }, func: () => { window.__qfZapOpenShadow = true; } }), tid);
  const z = await send({ type: 'popup:zap', tabId: tid });
  const bar = await waitFor(() => site.evaluate(() => document.getElementById('__qf_zap')?.dataset.count === '0' || null), 4000);
  h.check('zap: popup button opens zap mode', z.ok && bar, z);
  const zapClick = async (sel) => {
    const r = await site.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return { x: b.left + 10, y: b.top + 10 }; });
    await site.mouse.move(r.x, r.y);
    await site.mouse.click(r.x, r.y);
    await sleep(150);
  };
  await zapClick('#chat-launcher');
  const gone1 = await site.evaluate(() => ({ gone: !document.getElementById('chat-launcher'), count: document.getElementById('__qf_zap')?.dataset.count, clicks: window.__pageClicks }));
  h.check('zap: a click removes the element at once, the page never sees the click', gone1.gone && gone1.count === '1' && gone1.clicks === 0, gone1);
  await site.evaluate(() => document.getElementById('__qf_zap').shadowRoot.getElementById('qf-zap-undo').click());
  const back = await site.evaluate(() => { const m = document.getElementById('chat-launcher'); return !!m && m.previousElementSibling?.classList.contains('nl-modal'); });
  h.check('zap: Undo puts it back in the same place', back);
  await zapClick('#chat-launcher');
  await site.keyboard.press('Escape');
  await sleep(150);
  const closed = await site.evaluate(() => ({ bar: !!document.getElementById('__qf_zap'), gone: !document.getElementById('chat-launcher') }));
  h.check('zap: Esc leaves zap mode, removed element stays removed', !closed.bar && closed.gone, closed);
  const savedAfter = (await swEval(() => chrome.storage.local.get('pickerRules').then((r) => r.pickerRules ?? []))).length;
  h.check('zap: nothing saved', savedAfter === savedBefore, { savedBefore, savedAfter });
  await site.reload({ waitUntil: 'load' });
  h.check('zap: element back after reload', await site.evaluate(() => !!document.getElementById('chat-launcher')));
  await site.evaluate(() => {
    const el = document.querySelector('.story');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  await swEval((t) => globalThis.__adb.startZap(t, true), tid);
  const ctxZap = await waitFor(() => site.evaluate(() => (!document.querySelector('.story') && document.getElementById('__qf_zap')?.dataset.count === '1') || null), 4000);
  h.check('zap: right-click "Remove until reload" removes that element, zap mode stays open', !!ctxZap);
  await site.keyboard.press('Escape');

  // ---------- backup / restore ----------
  await send({ type: 'sites:set', add: ['trusted.example'] });
  const backup = await send({ type: 'backup:export' });
  h.check('backup: has rules, trusted site, hidden element, theme', backup.format === 'quietfort-backup' && backup.settings.userFilters.includes('custom-block') && backup.settings.disabledSites.includes('trusted.example') && backup.picker.length >= 1 && backup.theme === 'fortNight', { sites: backup.settings.disabledSites, picker: backup.picker.length, theme: backup.theme });
  // Wipe, then restore.
  await send({ type: 'rules:set', text: '' });
  await send({ type: 'sites:set', remove: ['trusted.example'] });
  await swEval(() => chrome.storage.local.set({ pickerRules: [], theme: 'light' }));
  const restored = await send({ type: 'backup:import', text: JSON.stringify(backup) });
  h.check('restore: accepted', restored.ok, restored);
  const after2 = { rules: (await send({ type: 'rules:get' })).text, sites: (await send({ type: 'sites:get' })).sites, theme: await swEval(() => chrome.storage.local.get('theme').then((r) => r.theme)) };
  h.check('restore: rules, trusted site and theme back', after2.rules.includes('custom-block') && after2.sites.includes('trusted.example') && after2.theme === 'fortNight', after2);
  const junk = await send({ type: 'backup:import', text: '{"format":"something-else"}' });
  h.check('restore: other files refused', !junk.ok, junk.error);
} catch (err) {
  h.check('no unexpected error', false, String(err?.stack ?? err));
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(h.summary() ? 0 : 1);
