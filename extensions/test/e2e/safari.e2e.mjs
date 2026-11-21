// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// End-to-end test in real Safari: the Safari web extension inside the companion
// app (safari-app/, Debug build), enabled in Safari by the owner.
//
//   npm run test:e2e:safari                # build if needed, then run
//   node test/e2e/safari.e2e.mjs --no-build [--no-full-list] [--no-webdriver]
//
// One-time manual setup (cannot be automated; see the message printed when it
// is missing): Safari › Settings › Extensions › enable "Quietfort for Safari"
// and allow it on every website. Optional: Settings › Advanced › "Show features
// for web developers", then Developer › "Allow remote automation" (only used to
// check whether WebDriver windows run extensions; the test does not need it).
//
// How it works:
//  - Build: the e2e bundle (dist/safari-e2e: list URLs point at the local
//    server, content-script message relay, agent on the warning/options pages)
//    is put into the companion app with xcodebuild, at the same path as
//    `npm run build:safari`, so Safari keeps the extension enabled. Skipped
//    when the app already contains exactly this bundle. dist/safari is rebuilt
//    as the production bundle afterwards; `npm run build:safari` puts the
//    production bundle back into the app.
//  - Hosts: <name>.localhost (Safari resolves these to loopback), served by
//    safari-server.mjs on port 80; no hosts file, DNS or proxy changes.
//  - Driving: a tab in the user's Safari (`open -a Safari <url>`). Each fixture
//    page runs a small agent that long-polls the test server for commands
//    (evaluate in the page, relay a popup message to the extension, navigate),
//    so nothing has to be clicked by hand. WebDriver is tried first; Safari's
//    automation windows are only used if the extension runs in them.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSafariServer, DEEP_HOST_SAFARI } from './safari-server.mjs';
import { createHarness, sleep, waitFor } from './harness.mjs';
import { DEEP_INDEX, FULL_LIST_HOSTS } from './server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.SAFARI_E2E_PORT || 80);
const ORIGIN = (host) => `http://${host}${PORT === 80 ? '' : `:${PORT}`}`;
const APP = join(ROOT, 'safari-app/build/Build/Products/Debug/AdBlocker Companion.app');
const APPEX_RES = join(APP, 'Contents/PlugIns/AdBlocker Companion Extension.appex/Contents/Resources');
const E2E_DIST = join(ROOT, 'dist/safari-e2e');
const args = new Set(process.argv.slice(2));
const FULL_LIST = !args.has('--no-full-list');
// --real-lists: the default lists and the uBO / AdGuard lists come from their real
// URLs (not fixtures). Only the list-size check runs: old vs new defaults in this
// Safari (rule limits, rules installed and dropped, sample hosts from each list).
const REAL_LISTS = args.has('--real-lists');
// --probe: measure how many dynamic rules of each shape Safari accepts, then restore the rules.
const PROBE = args.has('--probe');
// --status: connect, print the extension's DNR status and log, stop.
const STATUS = args.has('--status');
// --real-lists --yt: after the real lists are in, time real YouTube videos with blocking on, off, on again.
const YT = args.has('--yt');
const REAL_IDS_OLD = ['easylist', 'easyprivacy', 'easylist-cookie'];
const REAL_IDS_ADD = ['ubo-filters', 'ubo-privacy', 'ubo-badware', 'ubo-quick-fixes', 'ubo-unbreak', 'adguard-base', 'adguard-url-tracking'];

const OWNER_STEPS = `
The Safari extension is not active in Safari yet. One-time setup, by hand in Safari:
  1. Safari > Settings... > Extensions: tick "Quietfort for Safari" and the three
     "Quietfort Rules 1/2/3" items (the content blockers that carry the filter lists).
     (Not listed? Quit Safari, run: open "${APP}" , reopen Safari.)
  2. Give it access to every website: Safari > Settings... > Websites > "AdBlocker Companion"
     (left column, under Extensions) > "When visiting other websites: Allow".
     (While it lacks access, its toolbar icon shows an orange badge and nothing runs.)
  3. Optional (not needed for the test): Developer tab > "Allow remote automation", and once in
     Terminal: safaridriver --enable  (asks for your admin password).
Then run:  cd "${ROOT}" && npm run test:e2e:safari
`;

const CB_STEPS = `
Some of the companion app's content blockers are off. In Safari > Settings... > Extensions,
tick "AdBlocker Rules 1", "AdBlocker Rules 2" and "AdBlocker Rules 3", then run the test again.
`;

const OTHER_BLOCKERS = `
Another content blocker is filtering the test pages (with AdBlocker Companion not involved,
the fixture ad script was still blocked). Turn the others off in Safari > Settings... >
Extensions while the test runs (e.g. Adblock Plus, ABP Control Panel, AdGuard; also the
AdGuard for Mac app's Safari filtering), then run the test again.
`;

// ---------- build ----------

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  // errors.js (main-world error hook) is not used by the Safari manifest and not copied into the app.
  return out.filter((f) => f !== 'errors.js').sort();
}

function sameTree(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const fa = filesUnder(a);
  const fb = filesUnder(b);
  if (fa.join('\n') !== fb.join('\n')) return false;
  const h = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  return fa.every((f) => h(join(a, f)) === h(join(b, f)));
}

async function realListUrls() {
  const { CATALOGUE } = await import(join(ROOT, 'src/shared/catalogue.ts'));
  return [...REAL_IDS_OLD, ...REAL_IDS_ADD].map((id) => `${id}=${CATALOGUE.find((e) => e.id === id).url}`).join(',');
}

async function build() {
  const lists = REAL_LISTS
    ? `--e2e-lists=${ORIGIN('lists.localhost')}/fixture.txt,${await realListUrls()}`
    : `--e2e-lists=${ORIGIN('lists.localhost')}/fixture.txt,easylist-cookie=${ORIGIN('lists.localhost')}/cookie.txt`;
  execFileSync('node', ['scripts/build.mjs', 'safari', lists], { cwd: ROOT, stdio: 'inherit' });
  // Native code (companion app, extension handler, content blockers) newer than the app: rebuild too.
  const appBin = join(APP, 'Contents/MacOS/AdBlocker Companion');
  const nativeDir = join(ROOT, 'safari-app/AdBlocker Companion');
  const nativeNewer = !existsSync(appBin) || filesUnder(nativeDir)
    .some((f) => /\.(swift|plist|entitlements|xcproj)$/.test(f) && statSync(join(nativeDir, f)).mtimeMs > statSync(appBin).mtimeMs);
  if (!nativeNewer && sameTree(E2E_DIST, APPEX_RES)) {
    console.log('companion app already contains this e2e bundle; xcodebuild skipped');
    return false;
  }
  // The Xcode project copies dist/safari: put the e2e bundle there for the app build.
  rmSync(join(ROOT, 'dist/safari'), { recursive: true, force: true });
  cpSync(E2E_DIST, join(ROOT, 'dist/safari'), { recursive: true });
  try {
    execFileSync('xcodebuild', [
      '-project', 'AdBlocker Companion.xcodeproj', '-scheme', 'AdBlocker Companion', '-configuration', 'Debug',
      '-derivedDataPath', '../build', 'DEVELOPMENT_TEAM=G39T62RW4Q', 'CODE_SIGN_STYLE=Automatic', '-allowProvisioningUpdates', 'build', '-quiet',
    ], { cwd: join(ROOT, 'safari-app/AdBlocker Companion'), stdio: 'inherit', env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer' } });
  } finally {
    // dist/safari is the production bundle again.
    execFileSync('node', ['scripts/build.mjs', 'safari'], { cwd: ROOT, stdio: 'inherit' });
  }
  if (!sameTree(E2E_DIST, APPEX_RES)) throw new Error('the companion app does not contain the e2e bundle after xcodebuild');
  return true;
}

// ---------- WebDriver (plain W3C HTTP) ----------

async function freePort() {
  return new Promise((res) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function wd(base, method, path, body, timeoutMs = 60000) {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${j?.value?.error ?? r.status} ${j?.value?.message ?? ''}`.trim());
  return j.value;
}

async function startWebDriver() {
  const port = await freePort();
  const proc = spawn('/usr/bin/safaridriver', ['--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => fetch(`${base}/status`).then((r) => r.ok, () => false), 5000, 100);
  try {
    const v = await wd(base, 'POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } }, 40000);
    return { base, proc, session: v.sessionId, error: null };
  } catch (err) {
    proc.kill();
    return { base, proc: null, session: null, error: String(err.message ?? err) };
  }
}

// ---------- run ----------

const h = createHarness('safari e2e');
let rebuilt = false;
if (!args.has('--no-build')) {
  rebuilt = await build();
  let running = false;
  try {
    running = !!execFileSync('pgrep', ['-f', 'AdBlocker Companion.app/Contents/MacOS'], { encoding: 'utf8' }).trim();
  } catch {
    /* not running */
  }
  if (rebuilt || !running) {
    // Registers the (re)built extension with Safari. This is only the companion
    // app: it turns no system filtering on.
    execFileSync('open', ['-g', APP]);
    await sleep(2000);
  }
}

const srv = await startSafariServer(PORT, { fullList: FULL_LIST }).catch((err) => {
  console.error(`cannot listen on port ${PORT}: ${err.message}. Is something else using it? (SAFARI_E2E_PORT=<port> also works, but then rebuild; ||host/path filters need port 80.)`);
  process.exit(1);
});
const { log, hub } = srv;
let logFrom = 0;
const hits = (host, path) => log.slice(logFrom).filter((l) => l.host === host && (!path || l.path === path));
const safariVersion = (() => {
  try {
    return execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info.plist', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim();
  } catch {
    return '?';
  }
})();
h.info('Safari', safariVersion);

let driver = null; // { base, session } when the WebDriver window runs the extension
let cur = null; // the agent of the page currently shown in the test tab
let semiAuto = true;

/** Open a URL in a fresh tab (WebDriver window or the user's Safari). */
async function openFresh(url) {
  const since = Date.now();
  if (driver) await wd(driver.base, 'POST', `/session/${driver.session}/url`, { url }).catch(() => undefined);
  else execFileSync('open', ['-a', 'Safari', url]);
  return since;
}

const isPage = (url) => (a) => a.kind === 'page' && a.href === url;
const isExt = (page) => (a) => a.kind === 'ext' && a.page === page;

/** Navigate the test tab; waits for the agent of the page that loads. */
async function go(url, pred = isPage(url), timeout = 15000) {
  const since = Date.now();
  if (cur) hub.send(cur, { cmd: 'goto', url });
  else await openFresh(url);
  let a = await hub.waitAgent(pred, { since, timeout });
  if (!a && cur) {
    // The tab got stuck (e.g. on a page without an agent): start over in a new tab.
    h.info('test tab did not report back, reopening', url);
    const s2 = await openFresh(url);
    a = await hub.waitAgent(pred, { since: s2, timeout });
  }
  if (a) cur = a;
  return a;
}

async function reload(timeout = 15000) {
  const since = Date.now();
  const href = cur.href;
  hub.send(cur, { cmd: 'reload' });
  const a = await hub.waitAgent(isPage(href), { since, timeout });
  if (a) cur = a;
  return a;
}

const run = (src, timeout) => hub.send(cur, { cmd: 'eval', src }, timeout);
const relay = async (msg, timeout = 5000) => {
  const r = await hub.send(cur, { cmd: 'relay', msg: { tabId: 'sender', ...msg }, timeout: timeout - 500 }, timeout);
  return r?.__noReply ? null : r;
};
const state = () => relay({ type: 'popup:getState' });
const visSrc = (sel) => `const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden' ? 'hidden' : 'visible';`;
const vis = (sel) => run(visSrc(sel));
const extState = async (a) => (await hub.send(a, { cmd: 'state' }));
const step = (s) => (globalThis.__e2eStep = s);

async function connect() {
  const start = `${ORIGIN('relay.localhost')}/`;
  if (!args.has('--no-webdriver')) {
    const w = await startWebDriver();
    if (w.session) {
      driver = w;
      const since = Date.now();
      await wd(w.base, 'POST', `/session/${w.session}/url`, { url: `${start}?via=webdriver` }).catch(() => undefined);
      const a = await hub.waitAgent((x) => x.kind === 'page' && x.href.includes('via=webdriver'), { since, timeout: 10000 });
      cur = a;
      const st = a ? await state().catch(() => null) : null;
      if (st?.platform === 'safari') {
        semiAuto = false;
        h.info('mode', 'WebDriver: the automation window runs the extension');
        return st;
      }
      h.info('WebDriver', a ? 'session works, but the extension does not run in Safari automation windows; using the normal Safari window instead' : 'session created but the page never reported back');
      await wd(w.base, 'DELETE', `/session/${w.session}`).catch(() => undefined);
      w.proc.kill();
      driver = null;
      cur = null;
    } else {
      h.info('WebDriver unavailable (needs Developer › "Allow remote automation"; not required)', w.error);
    }
  }
  h.info('mode', 'semi-automatic: a tab in your normal Safari window, driven by the page agent (no clicks needed)');
  const a = await go(`${start}?via=open`, (x) => x.kind === 'page' && x.href.includes('via=open'), 20000);
  if (!a) return null;
  // Right after a rebuild Safari takes a while to load the new extension version.
  return waitFor(async () => state().catch(() => null), rebuilt ? 45000 : 8000, 1000);
}

async function realListsCheck() {
  const samples = process.env.SAFARI_SAMPLES ? JSON.parse(readFileSync(process.env.SAFARI_SAMPLES, 'utf8')) : {};
  const allHosts = Object.values(samples).flat();
  const out = {};
  // --yt only needs the current defaults.
  for (const [name, on] of (YT ? [['new', true]] : [['old', false], ['new', true]])) {
    step(`real lists: ${name}`);
    for (const id of REAL_IDS_ADD) await relay({ type: 'lists:set', id, enabled: on }, 10000);
    const t0 = Date.now();
    const rf = await relay({ type: 'lists:refresh' }, 300000).catch((e) => ({ error: String(e) }));
    // The relay gives up after ~30 s while a big rebuild is still running: wait until a
    // DNR status newer than this step is stored and the installed rules match it.
    let s = null;
    await waitFor(async () => {
      s = await relay({ type: 'test:dnrSummary', hosts: allHosts }, 60000).catch(() => null);
      const st = s?.status;
      return !!st && st.appliedAt > t0 && s.dynamicRules === st.installedDynamic && s.sessionRules === st.installedSession;
    }, 600000, 5000);
    const st = s?.status ?? {};
    const present = new Set(s?.present ?? []);
    const perList = Object.fromEntries(Object.entries(samples).map(([id, hs]) => [id, `${hs.filter((x) => present.has(x)).length}/${hs.length}`]));
    out[name] = { refreshMs: Date.now() - t0, refresh: rf, limits: st.limits, stats: st.stats, installedDynamic: st.installedDynamic, installedMain: st.installedMain, installedSession: st.installedSession, droppedByReason: st.droppedByReason, rejected: st.rejected?.length, rejectedSample: st.rejected?.slice(0, 5), dynamicRules: s?.dynamicRules, sessionRules: s?.sessionRules, protection: st.protection && { rules: st.protection.rules, lists: st.protection.lists }, sampleHostsInstalled: perList };
    h.info(`real lists, ${name} defaults`, out[name]);
    const limitDrops = Object.entries(st.droppedByReason ?? {}).filter(([k]) => /limit/.test(k)).reduce((a, [, v]) => a + v, 0);
    h.info(`${name} defaults: rules left out for the rule limit (compiler / Safari's own cap)`, { compiler: limitDrops, safariCap: st.cappedByBrowser ?? 0, installedMain: st.installedMain });
    // The e2e fixture's own $removeheader rule (x-tracking-header) is a known Safari refusal.
    const realRejected = (st.rejected ?? []).filter((r) => !/x-tracking-header/i.test(r.error));
    h.check(`${name} defaults: Safari accepted every real-list rule`, realRejected.length === 0, realRejected.slice(0, 5));
    for (const [id, hs] of Object.entries(samples)) {
      if (!hs.length) continue;
      // Primary lists must be complete; optional lists fill the room that is left.
      if (REAL_IDS_OLD.includes(id)) h.check(`${name} defaults: sample hosts from ${id} have an installed block rule`, hs.every((x) => present.has(x)), perList[id]);
      else if (on) h.info(`${name} defaults: sample hosts from ${id} installed (optional list, room permitting)`, perList[id]);
    }
    if (on) {
      // Hiding rules and scriptlets do not count against the network-rule limit: YouTube's are in.
      const yt = await relay({ type: 'test:cosmeticsFor', host: 'www.youtube.com' }, 30000).catch((e) => ({ error: String(e) }));
      h.info('new defaults: YouTube scriptlets / hiding rules from the engine', yt);
      h.check('new defaults: YouTube ad scriptlets are active', (yt?.scriptlets ?? 0) > 0, yt);
      // The full lists in the companion app's content blockers.
      const cbT0 = Date.now();
      await relay({ type: 'cb:push', force: false }, 300000).catch(() => null);
      const cbMs = Date.now() - cbT0;
      // Status merges Safari's state with the conversion stats of the last push.
      const cb = await relay({ type: 'cb:status' }, 60000).catch((e) => ({ error: String(e) }));
      h.info('real lists: content blockers', { ms: cbMs, blockers: cb?.blockers, stats: cb?.stats && { converted: cb.stats.converted, blockRules: cb.stats.blockRules, exceptionRules: cb.stats.exceptionRules, popupRules: cb.stats.popupRules, overflow: cb.stats.overflow, skipped: cb.stats.skipped } });
      h.check('real lists: all content blockers loaded by Safari, nothing overflowed',
        cb?.ok === true && cb.blockers?.every((b) => b.enabled === true && !b.error) && (cb.stats?.overflow ?? 1) === 0, cb?.blockers ?? cb);
      const total = (cb?.blockers ?? []).reduce((n, b) => n + (b.rules ?? 0), 0);
      h.check('real lists: content blockers carry far more than the DNR cap (>100,000 rules)', total > 100000, total);
    }
  }
  if (process.env.SAFARI_REAL_OUT) (await import('node:fs')).writeFileSync(process.env.SAFARI_REAL_OUT, JSON.stringify(out, null, 1));
  // Leave the lists at the Safari default (now on).
  for (const id of REAL_IDS_ADD) await relay({ type: 'lists:set', id, enabled: true }, 10000);
}

/** Real YouTube: when the video data starts loading, blocking on vs off for youtube.com (same videos, same session). */
async function ytTiming() {
  const ids = (process.env.YT_IDS ?? 'q6fgVVmdpgY,50d1VVjaPmo,awjlMCCdqXw,dQw4w9WgXcQ').split(',');
  const reps = Number(process.env.YT_REPS ?? '2');
  const rows = [];
  for (const mode of ['on', 'off', 'on-again']) {
    step(`yt ${mode}`);
    const sw = await relay({ type: 'popup:setEnabled', site: 'youtube.com', enabled: mode !== 'off' }, 60000).catch((e) => ({ error: String(e) }));
    if (sw?.ok !== true) h.info(`yt ${mode}: switch`, sw);
    for (let r = 0; r < reps; r++) {
      for (const id of ids) {
        const o = await relay({ type: 'test:openTab', url: `https://www.youtube.com/watch?v=${id}`, window: true }, 10000).catch(() => null);
        if (!o?.tabId) { h.info(`yt ${mode} ${id}: could not open a tab`, o); continue; }
        let last = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          await sleep(500);
          last = await relay({ type: 'test:videoTiming', tabId: o.tabId }, 5000).catch(() => null);
          // Playing: when it started = now − position (playback runs at 1x from the start).
          if (last && last.t > 0.5) { last.playStart = Math.round(last.now - last.t * 1000); break; }
        }
        await relay({ type: 'test:closeTab', tabId: o.tabId }, 5000).catch(() => null);
        rows.push({ mode, id, rep: r + 1, ...(last ?? {}) });
        h.info(`yt ${mode} ${id} #${r + 1}`, last);
      }
    }
  }
  const med = (a) => { const v = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const summary = Object.fromEntries(['on', 'off', 'on-again'].map((m) => {
    const rs = rows.filter((x) => x.mode === m);
    return [m, { videos: rs.length, medianPlayStartMs: med(rs.map((x) => x.playStart)), notPlaying: rs.filter((x) => x.playStart == null).length, medianFirstMediaMs: med(rs.map((x) => x.firstMedia)), medianDclMs: med(rs.map((x) => x.dcl)), noMedia: rs.filter((x) => x.firstMedia == null).length, adsInPlayerData: rs.filter((x) => (x.adPlacements ?? 0) > 0 || x.playerAds).length, adShowing: rs.filter((x) => x.adShowing).length }];
  }));
  h.info('yt summary (ms from opening the video to playback starting)', summary);
  if (process.env.YT_OUT) (await import('node:fs')).writeFileSync(process.env.YT_OUT, JSON.stringify({ rows, summary }, null, 1));
  await relay({ type: 'popup:setEnabled', site: 'youtube.com', enabled: true }, 60000).catch(() => null);
}

let exitCode = 0;
try {
  step('connect');
  const st0 = await connect();
  if (!cur) {
    h.check('Safari loads http://relay.localhost/ from the test server', false, 'no page reported back: is Safari able to open http://relay.localhost/?');
    throw new Error('stopped');
  }
  if (!st0 || st0.platform !== 'safari') {
    // Is another blocker (Adblock Plus, AdGuard, ...) filtering the fixtures? Our extension is not running here.
    if (await go(`${ORIGIN('publisher.localhost')}/page.html?interference=1`)) {
      await sleep(1000);
      if ((await run('return window.__adLoaded').catch(() => true)) !== true) console.log(OTHER_BLOCKERS);
    }
    console.log(OWNER_STEPS);
    h.check('extension active in Safari (content-script relay answers)', false, st0 ?? 'no answer from the extension');
    exitCode = 2;
    throw new Error('stopped');
  }
  h.check('extension active in Safari (content script + background answer)', st0.platform === 'safari', { platform: st0.platform, hostAccess: st0.hostAccess });
  h.check('extension has access to the site (allowed on every website)', st0.hostAccess === true, st0.hostAccess);
  h.info('permissions', await relay({ type: 'test:perms', origin: `${ORIGIN('relay.localhost')}/*` }).catch((e) => String(e)));
  // "Continue anyway" lasts until Safari restarts there: forget earlier runs' choices.
  await relay({ type: 'test:clearContinue' }, 10000);
  // Lists that failed earlier (e.g. while no test server was running) sit in a one-hour
  // retry back-off: download everything now.
  if (STATUS) {
    const sm = await relay({ type: 'test:dnrSummary', hosts: [] }, 20000).catch((e) => ({ error: String(e) }));
    h.info('dnr summary', sm ? { ...sm, status: sm.status && { ...sm.status, rejected: sm.status.rejected?.length } } : sm);
    const cbt = Date.now();
    h.info('content blockers', { ms: undefined, ...(await relay({ type: 'cb:status' }, 60000).catch((e) => ({ error: String(e) }))) });
    h.info('content blocker status time', `${Date.now() - cbt} ms`);
    h.info('extension log', await relay({ type: 'test:log' }, 20000).catch((e) => String(e)));
    if (process.env.STATUS_WAIT) {
      // Follow a sync in progress: print new log lines until a newer DNR status is stored.
      const since = sm?.status?.appliedAt ?? 0;
      const t0 = Date.now();
      let seen = 0;
      while (Date.now() - t0 < Number(process.env.STATUS_WAIT) * 1000) {
        await sleep(15000);
        const lines = await relay({ type: 'test:log' }, 20000).catch(() => null);
        if (Array.isArray(lines)) {
          const fresh = lines.slice(Math.max(0, lines.length - (lines.length - seen)));
          for (const l of fresh) console.log('  log', l.slice(0, 300));
          seen = lines.length;
        } else console.log('  (no answer from the extension)', Math.round((Date.now() - t0) / 1000), 's');
        const now = await relay({ type: 'test:dnrSummary', hosts: [] }, 20000).catch(() => null);
        if (now?.status?.appliedAt > since) {
          h.info(`sync finished after ${Math.round((Date.now() - t0) / 1000)} s of waiting`, { ...now, status: { ...now.status, rejected: now.status.rejected?.length, version: undefined } });
          break;
        }
      }
    }
    throw new Error('stopped');
  }
  if (PROBE) {
    const out = {};
    for (const shape of (process.env.PROBE_SHAPES || 'simple,domains10,domains100,initiators10,types3,allow,redirect').split(',')) {
      step(`probe ${shape}`);
      await relay({ type: 'test:dnrProbe', shape, max: Number(process.env.PROBE_MAX || 40000) }, 10000);
      let r = null;
      await waitFor(async () => (r = await relay({ type: 'test:dnrProbeResult' }, 10000).catch(() => null)), 900000, 3000);
      out[shape] = r;
      h.info(`probe ${shape}`, r);
    }
    if (process.env.SAFARI_PROBE_OUT) (await import('node:fs')).writeFileSync(process.env.SAFARI_PROBE_OUT, JSON.stringify(out, null, 1));
  }
  step('refresh');
  // Real lists: eleven downloads plus compiling ~300,000 rules takes up to ~3 minutes.
  const rf = await relay({ type: 'lists:refresh' }, REAL_LISTS ? 300000 : 120000).catch((e) => ({ error: String(e) }));
  h.check('forced list refresh completed', rf?.ok === true, rf);
  if (PROBE) throw new Error('stopped');
  if (REAL_LISTS) {
    await realListsCheck();
    if (YT) await ytTiming();
    throw new Error('stopped');
  }

  // Other content blockers would make the network/cosmetic checks meaningless: with
  // this extension off for the site, the fixture ad must load and stay visible.
  step('interference');
  await relay({ type: 'popup:setEnabled', site: 'publisher.localhost', enabled: false });
  await relay({ type: 'cb:push', force: false }, 180000).catch(() => null);
  if (await go(`${ORIGIN('publisher.localhost')}/page.html?interference=1`)) {
    await sleep(1200);
    const other = await run(`return { ad: window.__adLoaded === true, gen: getComputedStyle(document.getElementById('generic-ad')).display };`);
    const clean = other.ad && other.gen !== 'none';
    if (!clean) {
      console.log(OTHER_BLOCKERS);
      // Ours, if it is ours: what the background and the companion app had at that moment.
      const diag = { adScriptServed: log.filter((l) => l.path === '/ads/ad.js').length, cb: await relay({ type: 'cb:status' }, 20000).catch(() => null), log: await relay({ type: 'test:log' }, 10000).catch(() => null) };
      h.info('interference diagnostics', diag);
    }
    h.check('no other content blocker filters the test pages', clean, other);
  }
  await relay({ type: 'popup:setEnabled', site: 'publisher.localhost', enabled: true });
  await relay({ type: 'cb:push', force: false }, 180000).catch(() => null);

  logFrom = log.length; // the interference probe above loaded the fixture ads on purpose
  // ---------- lists ----------
  step('lists');
  const ready = await waitFor(async () => {
    const s = await state().catch(() => null);
    return s?.lists?.e2e0?.fetchedAt && s.dnr?.installed > 0 ? s : null;
  }, 40000, 1000);
  h.check('filter list downloaded at runtime and DNR rules installed', !!ready, ready ? { list: ready.lists.e2e0, dnr: ready.dnr } : (await state().catch(() => null))?.lists);
  h.check('list fetched from the list host', log.some((l) => l.host === 'lists.localhost' && l.path === '/fixture.txt'));
  if (ready) h.info('DNR', ready.dnr);
  // The fixture fits easily: almost nothing may be left out (a wrongly learned
  // browser cap once squeezed the rules to 16 and silently dropped most of them).
  if (ready) h.check('DNR: fixture rules installed, none squeezed out by a rule cap', ready.dnr?.installed >= 15 && ready.dnr?.dropped <= 2, ready.dnr);

  // ---------- content blockers (companion app) ----------
  step('content-blockers');
  const pub0 = `${ORIGIN('publisher.localhost')}/page.html`;
  const cbT0 = Date.now();
  const cb = await relay({ type: 'cb:push' }, 180000).catch((e) => ({ error: String(e) }));
  h.info('content blockers: update time (rules → companion app → Safari)', `${Date.now() - cbT0} ms`);
  h.check('content blockers: rules handed to the companion app and loaded by Safari',
    cb?.ok === true && cb.blockers?.length === 3 && cb.blockers.every((b) => !b.error) && cb.blockers[0].rules > 1,
    cb?.blockers ?? cb);
  const cbOff = (cb?.blockers ?? []).filter((b) => b.enabled !== true).map((b) => b.id);
  if (cbOff.length) console.log(CB_STEPS);
  h.check('content blockers: all turned on in Safari', cb?.ok === true && cbOff.length === 0, cb?.blockers?.map((b) => ({ id: b.id, enabled: b.enabled })));
  if (cb?.stats) h.info('content blockers: conversion', { converted: cb.stats.converted, blockRules: cb.stats.blockRules, exceptionRules: cb.stats.exceptionRules, popupRules: cb.stats.popupRules, skipped: cb.stats.skipped });
  const popupState = await state().catch(() => null);
  h.check('popup state reports the content blockers', popupState?.contentBlockers?.total === 3 && popupState.contentBlockers.on === 3 - cbOff.length, popupState?.contentBlockers);
  if (cb?.ok && !cbOff.length) {
    // The content blockers on their own: the extension's filter-list DNR rules removed.
    const rm = await relay({ type: 'test:dnrMainOff' });
    logFrom = log.length;
    if (await go(`${pub0}?cbonly=1`)) {
      await sleep(1500);
      const c = await run(`return { ad: window.__adLoaded, lib: window.__libLoaded, imgs: Object.fromEntries([...document.images].map((i) => [i.id, i.naturalWidth])) };`);
      h.info('content blockers only', { dnrRulesRemoved: rm?.removed, page: c });
      h.check('content blockers only: ad script blocked, library loaded', c.ad === undefined && c.lib === true && hits('ads.adnet.localhost', '/ads/ad.js').length === 0, c);
      h.check('content blockers only: third-party tracker pixel blocked', c.imgs['img-tracker'] === 0 && hits('tracker.localhost').length === 0, c.imgs);
      h.check('content blockers only: @@ exception respected', c.imgs['img-excepted'] === 1, c.imgs);
      h.check('content blockers only: $important beats exception', c.imgs['img-important'] === 0 && hits('imp.localhost').length === 0, c.imgs);
      h.check('content blockers only: $~third-party not applied to a third-party request', c.imgs['img-fp'] === 1, c.imgs);
    } else h.check('content blockers only: page loaded', false);
    const back = await relay({ type: 'lists:refresh' }, 120000).catch((e) => ({ error: String(e) }));
    const restored = await waitFor(async () => ((await state().catch(() => null))?.dnr?.installed ?? 0) >= (ready?.dnr?.installed ?? 1), 30000, 1000);
    h.check('DNR rules restored after the content-blocker-only check', back?.ok === true && !!restored, back);
    logFrom = log.length; // the content-blocker-only step leaves $redirect targets to DNR on purpose
  }

  // ---------- network blocking + cosmetic hiding ----------
  step('publisher');
  const pub = `${ORIGIN('publisher.localhost')}/page.html`;
  const engineOn = await waitFor(async () => {
    if (!(await go(pub))) return false;
    return run('return window.__libLoaded === true && window.__adLoaded === undefined');
  }, 25000, 1000);
  h.check('engine active on the test page (ad script blocked, library loaded)', !!engineOn);
  await reload();
  await sleep(1500);
  const w = await run(`return {
    adLoaded: window.__adLoaded, lib: window.__libLoaded, realGpt: window.__realGpt, gptReady: window.googletag && window.googletag.apiReady,
    regex: window.__regexAdLoaded, echo: window.__echo, hdr: window.__hdr, hdrKeep: window.__hdrKeep,
    adEnabled: window.adConfig && window.adConfig.enabled, early: window.__earlyEnabled, rawJs: window.__rawJsRan,
    imgs: Object.fromEntries([...document.images].map((i) => [i.id, i.naturalWidth])),
  };`);
  h.info('page state', w);
  h.check('network: ad script blocked (never reached the server)', w.adLoaded === undefined && hits('ads.adnet.localhost', '/ads/ad.js').length === 0, hits('ads.adnet.localhost').map((l) => l.path));
  h.check('network: first-party library allowed', w.lib === true);
  h.check('network: third-party tracker pixel blocked', w.imgs['img-tracker'] === 0 && hits('tracker.localhost').length === 0, { w: w.imgs['img-tracker'], hits: hits('tracker.localhost').length });
  h.check('network: @@ exception respected', w.imgs['img-excepted'] === 1);
  h.check('network: $important beats exception', w.imgs['img-important'] === 0 && hits('imp.localhost').length === 0);
  h.check('network: $redirect script stub', w.gptReady === true && w.realGpt === undefined && hits('redir.localhost', '/gpt.js').length === 0, { gptReady: w.gptReady, real: w.realGpt, hits: hits('redir.localhost', '/gpt.js').length });
  h.check('network: $redirect 1x1.gif', w.imgs['img-redirect'] === 1 && hits('redir.localhost', '/pixel.gif').length === 0, { w: w.imgs['img-redirect'], hits: hits('redir.localhost', '/pixel.gif').length });
  // (checked below, after reading the DNR status)
  h.check('network: $~third-party not applied to a third-party request', w.imgs['img-fp'] === 1);
  h.check('network: $removeparam strips utm_source', w.echo === '?id=1&x=2', w.echo);
  const dnrNow = await relay({ type: 'test:dnr' }, 15000).catch(() => null);
  const hdrRejected = dnrNow?.status?.rejected?.find((r) => /x-tracking-header/i.test(r.error));
  if (w.hdr !== null && hdrRejected) h.info('network: $removeheader [Safari limitation: Safari rejects DNR rules for headers it does not know]', hdrRejected.error);
  else h.check('network: $removeheader strips a response header', w.hdr === null && w.hdrKeep === 'kept', { hdr: w.hdr, keep: w.hdrKeep });
  const regexDropped = dnrNow?.status?.droppedSample?.find((r) => r.reason === 'regex-unsupported');
  if (regexDropped && w.regex === true) h.info('network: regex rule [Safari limitation: Safari\'s isRegexSupported() rejects it; installed anyway it does not match either]', regexDropped.raw);
  else h.check('network: regex rule blocks', w.regex === undefined && hits('cdn.other.localhost').length === 0);
  h.check('cosmetic: generic class hiding', (await vis('#generic-ad')) === 'hidden');
  h.check('cosmetic: generic attribute hiding', (await vis('#attr-ad')) === 'hidden');
  h.check('cosmetic: site-specific hiding', (await vis('#specific-ad')) === 'hidden');
  h.check('cosmetic: procedural :has-text', (await vis('#sponsored')) === 'hidden');
  h.check('cosmetic: procedural does not over-match', (await vis('#not-sponsored')) === 'visible');
  h.check('cosmetic: #@# exception respected', (await vis('#excepted-cosmetic')) === 'visible');
  h.check('cosmetic: element added later is hidden', await waitFor(async () => (await vis('#late-ad')) === 'hidden', 3000, 200));
  h.check('scriptlet: set-constant', w.adEnabled === false, w.adEnabled);
  h.info('first visit: scriptlet ran before the first inline script (no cache yet; timing, not guaranteed)', w.early === false ? 'yes' : `no (inline saw ${w.early})`);
  h.check('raw JS / trusted scriptlets never run', w.rawJs === undefined);
  {
    // A page that streams in like a real site (first inline script 150 ms after the head):
    // scriptlets must be in place by then, on the first visit and on a repeat visit.
    const seen = [];
    for (const q of ['', '?again']) {
      if (await go(`${ORIGIN('publisher.localhost')}/streamed.html${q}`)) seen.push(await run('return window.__streamedEarly'));
      else seen.push('page did not load');
    }
    h.check('scriptlet in place before the first inline script of a streamed page (first and repeat visit)', seen[0] === false && seen[1] === false, seen);
  }
  if (driver) {
    // WebDriver clicks are real user gestures: Safari opens a popup only for those.
    step('popups');
    const wdS = (m, path, body) => wd(driver.base, m, `/session/${driver.session}${path}`, body);
    const handles = async () => (await wdS('GET', '/window/handles').catch(() => [])) ?? [];
    const home = await wdS('GET', '/window').catch(() => null);
    const closeOthers = async () => {
      for (const hnd of await handles()) {
        if (hnd === home) continue;
        await wdS('POST', '/window', { handle: hnd }).catch(() => null);
        await wdS('DELETE', '/window').catch(() => null);
      }
      if (home) await wdS('POST', '/window', { handle: home }).catch(() => null);
    };
    const popupCase = async (label, sel, host, path, expectBlocked) => {
      await go(pub);
      await sleep(800);
      const before = (await handles()).length;
      const from = log.length;
      const el = await wdS('POST', '/element', { using: 'css selector', value: sel }).catch(() => null);
      const id = el && Object.values(el)[0];
      if (!id) { h.check(`${label} (button found)`, false, sel); return; }
      await wdS('POST', `/element/${id}/click`, {}).catch(() => null);
      await sleep(2500);
      const opened = (await handles()).length - before;
      const served = log.slice(from).filter((l) => l.host === host && l.path === path).length;
      h.check(label, expectBlocked ? opened === 0 && served === 0 : opened >= 1 && served >= 1, { opened, served });
      await closeOthers();
    };
    await popupCase('$popup: window.open to an ad network never opens (never contacted)', '#open-bad', 'popads.localhost', '/landing', true);
    await popupCase('$popup: a normal popup still opens', '#open-good', 'goodsite.localhost', '/landing', false);
    await popupCase('$popup exception (@@...$popup) respected', '#open-allowed', 'popads.localhost', '/allowed/x', false);
    await popupCase('$popup: target=_blank link to an ad network blocked', '#link-bad', 'popads.localhost', '/viaLink', true);
    await popupCase('$popup,third-party popunder blocked', '#open-3p', 'popunder.localhost', '/x', true);
  } else {
    h.info('popup blocking ($popup)', 'not run: needs WebDriver (a real click); the page agent cannot produce a user gesture in a normal Safari window');
  }

  step('csp');
  if (await go(`${ORIGIN('csp.publisher.localhost')}/`)) h.check('network: $csp blocks inline script', (await run('return window.__inlineRan')) === undefined);
  else h.check('network: $csp page loaded', false);
  step('trusted');
  if (await go(`${ORIGIN('trusted.localhost')}/page.html`)) {
    await sleep(1200);
    h.check('$document exception: ad allowed, no hiding', (await run('return window.__adLoaded')) === true && (await vis('#generic-ad')) === 'visible');
  } else h.check('$document exception page loaded', false);

  // ---------- zap (remove until reload) ----------
  step('zap');
  if (await go(`${ORIGIN('publisher.localhost')}/page.html?zap=1`)) {
    await sleep(800);
    const mk = `for (const id of ['zap-a', 'zap-b']) { const d = document.createElement('div'); d.id = id; d.textContent = id; d.style.cssText = 'width:200px;height:60px;background:#ccc'; document.body.prepend(d); }
      window.__zapClicks = 0; document.getElementById('zap-a').addEventListener('click', () => window.__zapClicks++); return true;`;
    await run(mk);
    const z = await relay({ type: 'popup:zap' }, 10000);
    const open = await waitFor(() => run(`return document.getElementById('__qf_zap')?.dataset.count === '0' || null`), 4000, 200);
    h.check('zap: opens in Safari', z?.ok === true && !!open, z);
    await run(`document.getElementById('zap-a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true;`);
    const r1 = await run(`return { gone: !document.getElementById('zap-a'), count: document.getElementById('__qf_zap')?.dataset.count, clicks: window.__zapClicks }`);
    h.check('zap: a click removes the element, the page never sees the click', r1?.gone && r1.count === '1' && r1.clicks === 0, r1);
    await run(`document.getElementById('__qf_zap').shadowRoot.getElementById('qf-zap-undo').click(); return true;`);
    h.check('zap: Undo puts it back', await run(`return !!document.getElementById('zap-a')`));
    await run(`document.getElementById('__qf_zap').shadowRoot.getElementById('qf-zap-done').click(); return true;`);
    await run(`const el = document.getElementById('zap-b'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true;`);
    const zc = await relay({ type: 'popup:zap', context: true }, 10000);
    const r2 = await waitFor(() => run(`return (!document.getElementById('zap-b') && document.getElementById('__qf_zap')?.dataset.count === '1') || null`), 4000, 200);
    h.check('zap: right-click "Remove until reload" removes that element', zc?.ok === true && !!r2, zc);
    await reload();
    await sleep(500);
    h.check('zap: nothing kept after reload', await run(`return !document.getElementById('__qf_zap')`));
  } else h.check('zap: page loaded', false);

  // ---------- per-site switch ----------
  step('per-site');
  await go(pub);
  // The popup reloads the page as soon as this answers: it must answer only once
  // Safari's content blockers have the change, and quickly (no list rebuild).
  const cbOffT0 = Date.now();
  const off = await relay({ type: 'popup:setEnabled', site: 'publisher.localhost', enabled: false }, 30000);
  const offMs = Date.now() - cbOffT0;
  h.check('per-site off: in effect in Safari within 5 s (no list rebuild)', off?.ok === true && offMs < 5000, { offMs });
  await reload();
  await sleep(1500);
  h.check('per-site off: nothing blocked or hidden', off?.ok === true && (await run('return window.__adLoaded')) === true && (await vis('#generic-ad')) === 'visible', off);
  const stOff = await state();
  h.check('per-site off: popup state shows the site disabled', stOff?.enabled === false && stOff.host === 'publisher.localhost', { enabled: stOff?.enabled, host: stOff?.host });
  const onT0 = Date.now();
  const on = await relay({ type: 'popup:setEnabled', site: 'publisher.localhost', enabled: true }, 30000);
  h.check('per-site on again: in effect within 5 s', on?.ok === true && Date.now() - onT0 < 5000, { onMs: Date.now() - onT0 });
  await reload();
  await sleep(1500);
  h.check('per-site on again: blocking and hiding resume', (await run('return window.__adLoaded')) === undefined && (await vis('#generic-ad')) === 'hidden');
  await sleep(500);
  const stOn = await state();
  h.check('popup state: host, enabled, platform', stOn?.host === 'publisher.localhost' && stOn.enabled === true && stOn.platform === 'safari', { host: stOn?.host, enabled: stOn?.enabled });
  h.info('popup state: blocked-request count unavailable on Safari (no DNR block reports, getMatchedRules has no rule ids); the popup shows On/Off instead', { blocked: stOn?.blocked });

  // ---------- cookie banners ----------
  step('cookies');
  const cookieList = await waitFor(async () => (await state().catch(() => null))?.lists?.['easylist-cookie']?.fetchedAt, 15000, 500);
  h.check('cookie list downloaded at runtime (cookie banners on by default)', !!cookieList);
  for (const [fixture, expectClick, cmp] of [['onetrust.html', 'reject', 'Onetrust'], ['didomi.html', 'disagree', null]]) {
    if (!(await go(`${ORIGIN('cmp.localhost')}/${fixture}`))) {
      h.check(`cookie banner ${fixture}: page loaded`, false);
      continue;
    }
    await waitFor(() => run('return (window.__clicked || []).length > 0'), 12000, 300);
    await sleep(600);
    const cs = await run(`const vis = (s) => { const el = document.querySelector(s); if (!el) return 'missing'; const c = getComputedStyle(el); return c.display === 'none' || c.visibility === 'hidden' || c.opacity === '0' ? 'hidden' : 'visible'; };
      window.scrollTo(0, 800); const scrolled = window.scrollY; window.scrollTo(0, 0);
      return { clicked: [...(window.__clicked || [])], overflow: getComputedStyle(document.body).overflow, scrolled,
        ot: vis('#onetrust-banner-sdk'), otFilter: vis('.onetrust-pc-dark-filter'), didomi: vis('#didomi-popup'),
        content: vis('#article') !== 'missing' ? vis('#article') : vis('#content'), prehide: document.getElementById('autoconsent-prehide')?.textContent?.length ?? 0 };`);
    h.check(`cookie banner ${fixture}: "${expectClick}" clicked, never accept`, cs.clicked.length === 1 && cs.clicked[0] === expectClick, cs.clicked);
    h.check(`cookie banner ${fixture}: banner gone, scroll restored, content visible`, cs.ot !== 'visible' && cs.otFilter !== 'visible' && cs.didomi !== 'visible' && cs.overflow !== 'hidden' && cs.scrolled > 0 && cs.content === 'visible' && cs.prehide === 0, cs);
    if (cmp) {
      const c = await waitFor(async () => {
        const s = (await state().catch(() => null))?.consent;
        return s?.optOut != null ? s : null;
      }, 5000, 300);
      h.check(`cookie banner ${fixture}: background reports the reject`, c?.cmp === cmp && c.optOut === true, c);
    }
  }

  // ---------- privacy extras ----------
  step('privacy');
  await relay({ type: 'settings:set', privacy: { gpc: true, trimReferrer: true, stripClientData: true } });
  await sleep(800);
  const privUrl = `${ORIGIN('privacy.localhost')}/deep/path/page.html?secret=1`;
  let from = log.length;
  if (await go(privUrl)) {
    await sleep(800);
    const reqs = log.slice(from);
    const doc = reqs.find((l) => l.host === 'privacy.localhost' && l.path.endsWith('page.html'));
    const tp = reqs.find((l) => l.host === 'thirdparty.localhost');
    const pg = await run('return { gpc: window.__gpc, gpcNow: navigator.globalPrivacyControl, mal: window.__malBlocked === true };');
    h.check('privacy: Sec-GPC: 1 on the document request', doc?.headers?.['sec-gpc'] === '1', doc?.headers?.['sec-gpc'] ?? 'missing');
    h.check('privacy: Sec-GPC: 1 on third-party requests', tp?.headers?.['sec-gpc'] === '1', tp?.headers?.['sec-gpc'] ?? (tp ? 'missing' : 'no request'));
    h.check('privacy: navigator.globalPrivacyControl is true in the page', pg.gpc === true && pg.gpcNow === true, pg);
    h.info('privacy: third-party Referer (Safari build has no Referer rule; Safari trims cross-site referrers itself)', tp?.headers?.referer ?? 'none');
    h.check('protection: subresource from a listed (malware) host blocked', pg.mal && hits('malware.localhost').length === 0, { mal: pg.mal, hits: hits('malware.localhost').length });
  } else h.check('privacy page loaded', false);

  // ---------- malware / phishing warning page ----------
  step('protection');
  const pst = await waitFor(async () => {
    const s = (await state().catch(() => null))?.lists?.['blp-phishing'];
    return s?.fetchedAt ? s : null;
  }, 20000, 500);
  h.check('protection: phishing list downloaded at runtime (on by default)', !!pst && !pst.error, pst);
  // Let the protection DNR rules land.
  await sleep(1500);
  const phishUrl = `${ORIGIN('phish.localhost')}/login?next=%2Faccount`;
  const before = hits('phish.localhost').length;
  const warn = await go(phishUrl, isExt('blocked'), 15000);
  if (warn) {
    const ws = await extState(warn);
    h.check('protection: listed host → warning page (original URL kept)', /^safari-web-extension:\/\/[^/]+\/blocked\.html\?list=blp-phishing#http:\/\/phish\.localhost\/login\?next=%2Faccount$/.test(warn.href), warn.href);
    h.check('protection: warning page explains and offers Continue', /phishing/.test(ws.title ?? '') && ws.host === 'phish.localhost' && ws.hasContinue, ws);
    h.check('protection: the phishing host was never contacted', hits('phish.localhost').length === before, hits('phish.localhost').length - before);
    const since = Date.now();
    const clicked = await hub.send(warn, { cmd: 'click', sel: '#continue' });
    const landed = await hub.waitAgent(isPage(phishUrl), { since, timeout: 10000 });
    if (landed) cur = landed;
    const err = landed ? null : { clicked, page: await extState(warn).catch((e) => String(e)), agents: [...hub.agents.values()].filter((a) => a.firstSeen >= since).map((a) => a.href), phishRequests: hits('phish.localhost').length - before };
    h.check('protection: "Continue anyway" loads the site in this tab', clicked?.clicked && !!landed && (await run('return !!document.getElementById("phish")')), landed ? landed.href : err);
    if (driver) {
      const handle = await wd(driver.base, 'POST', `/session/${driver.session}/window/new`, { type: 'tab' }).catch(() => null);
      if (handle) {
        await wd(driver.base, 'POST', `/session/${driver.session}/window`, { handle: handle.handle });
        const s2 = Date.now();
        await wd(driver.base, 'POST', `/session/${driver.session}/url`, { url: `${ORIGIN('phish.localhost')}/again` }).catch(() => undefined);
        const other = await hub.waitAgent((a) => a.kind === 'ext' && a.page === 'blocked' || (a.kind === 'page' && a.href.includes('/again')), { since: s2, timeout: 10000 });
        h.check('protection: "continue" is for this tab only (another tab is warned again)', other?.kind === 'ext', other?.href);
      }
    } else h.info('protection: "continue is for this tab only"', 'not run: needs a second tab, which a page cannot open without a user gesture (WebDriver mode only)');
  } else {
    h.check('protection: listed host → warning page', false, { lastAgent: [...hub.agents.values()].at(-1)?.href, contacted: hits('phish.localhost').length - before });
    cur = null;
  }

  // ---------- options page (via the warning page of another listed host) ----------
  step('options');
  const warn2 = await go(`${ORIGIN('malware.localhost')}/`, isExt('blocked'), 15000);
  if (warn2) {
    const since = Date.now();
    hub.send(warn2, { cmd: 'goto', url: 'options.html' });
    const opt = await hub.waitAgent(isExt('options'), { since, timeout: 10000 });
    if (opt) {
      cur = null;
      const os = await waitFor(async () => {
        const s = await extState(opt);
        return s.lists > 0 && !/checking/.test(s.model ?? '') ? s : null;
      }, 8000, 300) ?? await extState(opt);
      h.check('options page loads: list catalogue, settings and rule report rendered', os.lists >= 10 && os.gpc === true && os.cookieBanners === true && /rules/i.test(os.dnr ?? ''), { ...os, dnr: os.dnr?.slice(0, 160) });
      h.info('options: model', os.model);
      // Turn GPC off with the options page's own switch.
      await hub.send(opt, { cmd: 'click', sel: '#gpc-toggle' });
      const offNow = await waitFor(async () => (await extState(opt)).gpc === false, 3000, 200);
      await sleep(1000);
      from = log.length;
      const s2 = Date.now();
      hub.send(opt, { cmd: 'goto', url: privUrl.replace('secret=1', 'secret=2') });
      cur = await hub.waitAgent((a) => a.kind === 'page' && a.href.includes('secret=2'), { since: s2, timeout: 10000 });
      if (cur) {
        await sleep(500);
        const doc2 = log.slice(from).find((l) => l.host === 'privacy.localhost');
        const gpc2 = await run('return navigator.globalPrivacyControl');
        h.check('options: GPC switched off in the options page → no Sec-GPC, navigator.globalPrivacyControl not true', !!offNow && doc2 && !doc2.headers['sec-gpc'] && gpc2 !== true, { switched: !!offNow, header: doc2?.headers?.['sec-gpc'], gpc2 });
        await relay({ type: 'settings:set', privacy: { gpc: true } });
      } else h.check('options: navigated on from the options page', false);
    } else h.check('options page loads', false, 'the options page never reported back');
  } else {
    h.check('options page: reached via the warning page of malware.localhost', false);
    cur = null;
  }

  // ---------- list chooser ----------
  step('lists toggle');
  if (await go(`${ORIGIN('annoy.localhost')}/page.html`)) {
    await sleep(600);
    h.check('lists: annoyance list off by default → newsletter box visible', (await vis('#nl')) === 'visible');
    await relay({ type: 'lists:set', id: 'fanboy-annoyance', enabled: true });
    const hidden = await waitFor(async () => {
      if (!(await reload())) return false;
      await sleep(500);
      return (await vis('#nl')) === 'hidden';
    }, 15000, 800);
    h.check('lists: turning the annoyance list on downloads it and hides the box', hidden);
    await relay({ type: 'lists:set', id: 'fanboy-annoyance', enabled: false });
    const shown = await waitFor(async () => {
      if (!(await reload())) return false;
      await sleep(500);
      return (await vis('#nl')) === 'visible';
    }, 15000, 800);
    h.check('lists: turning it off again shows the box', shown);
  }

  // ---------- full-size protection list: hashed set + navigation guard (Safari path) ----------
  if (FULL_LIST) {
    step('full list');
    await go(`${ORIGIN('relay.localhost')}/full`);
    const fst = await waitFor(async () => {
      const s = (await state().catch(() => null))?.lists?.['blp-malware'];
      return s?.fetchedAt || s?.error ? s : null;
    }, 240000, 2000);
    h.check(`full malware list (${FULL_LIST_HOSTS.toLocaleString()} hosts) downloaded at runtime`, !!fst?.fetchedAt && !fst.error && fst.hosts >= FULL_LIST_HOSTS, fst);
    const stats = await waitFor(async () => {
      const s = (await relay({ type: 'protect:stats' }, 30000).catch(() => null))?.stats;
      return s && (s.counts?.['blp-malware'] ?? 0) > 0 ? s : null;
    }, 60000, 1000);
    h.info('protection set', stats);
    h.check('full list: every host in the hashed set, about 5 bytes per host', (stats?.counts?.['blp-malware'] ?? 0) >= FULL_LIST_HOSTS - 10 && stats.bytes < 16e6, { malware: stats?.counts?.['blp-malware'], mb: (stats?.bytes ?? 0) / 1e6 });
    const deep = await relay({ type: 'test:protectLookup', host: DEEP_HOST_SAFARI }, 15000);
    h.check(`full list: entry ${DEEP_INDEX.toLocaleString()} is found`, deep?.list === 'blp-malware', deep);
    const target = `${ORIGIN(DEEP_HOST_SAFARI)}/download/setup.exe?campaign=7`;
    let b = hits(DEEP_HOST_SAFARI).length;
    const t0 = Date.now();
    const dw = await go(target, isExt('blocked'), 15000);
    const ms = Date.now() - t0;
    if (dw) {
      const ds = await extState(dw);
      h.check('navigation guard: hashed-list host → warning page (original URL kept)', dw.href.endsWith(`blocked.html?list=blp-malware#${target}`) && /malware/.test(ds.title ?? '') && ds.host === DEEP_HOST_SAFARI, { href: dw.href, ds, ms });
      h.info('navigation guard: first request reached the server [not guaranteed without blocking webRequest]', `${hits(DEEP_HOST_SAFARI).length - b} request(s)`);
      const sub = `www.login.${DEEP_HOST_SAFARI}`;
      b = hits(sub).length;
      hub.send(dw, { cmd: 'goto', url: `${ORIGIN(sub)}/` });
      const sw = await hub.waitAgent((a) => (a.kind === 'ext' && a.page === 'blocked' && a.href.includes(sub)) || (a.kind === 'page' && a.href.includes(sub)), { since: Date.now() - 50, timeout: 12000 });
      h.check('navigation guard: subdomain of a listed host warned too', sw?.kind === 'ext', sw?.href);
      if (sw?.kind === 'ext') {
        const since = Date.now();
        await hub.send(sw, { cmd: 'click', sel: '#continue' });
        const landed = await hub.waitAgent((a) => a.kind === 'page' && a.href.includes(sub), { since, timeout: 10000 });
        h.check('navigation guard: "Continue anyway" loads the hashed-list host', !!landed, landed?.href ?? (await extState(sw).catch(() => null)));
        cur = landed ?? null;
      } else cur = sw?.kind === 'page' ? sw : null;
    } else {
      h.check('navigation guard: hashed-list host → warning page', false, { ms, lastAgent: [...hub.agents.values()].at(-1)?.href, requests: hits(DEEP_HOST_SAFARI).length - b });
      cur = [...hub.agents.values()].filter((a) => a.kind === 'page').at(-1) ?? null;
    }
    const n = await go(`${ORIGIN('normal.localhost')}/page.html`);
    h.check('an ordinary site loads normally (not warned)', !!n && (await run('return document.title')) === 'Corner bakery');
  } else h.info('full-size malware list', 'skipped (--no-full-list)');
  if (process.env.SAFARI_E2E_DUMP && cur?.kind === 'page') {
    const d = await relay({ type: 'test:dnr' }, 20000).catch((e) => ({ error: String(e) }));
    (await import('node:fs')).writeFileSync(process.env.SAFARI_E2E_DUMP, JSON.stringify(d, null, 1));
  }
} catch (err) {
  if (String(err?.message) !== 'stopped') h.check('test run completed without exceptions', false, `${globalThis.__e2eStep ? `[step: ${globalThis.__e2eStep}] ` : ''}${String(err?.stack ?? err)}`);
} finally {
  if (cur) hub.send(cur, { cmd: 'goto', url: `${ORIGIN('relay.localhost')}/__done` });
  await sleep(500);
  if (driver) {
    await wd(driver.base, 'DELETE', `/session/${driver.session}`).catch(() => undefined);
    driver.proc.kill();
  }
  srv.close();
}
const ok = h.summary();
process.exit(exitCode || (ok ? 0 : 1));
