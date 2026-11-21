// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// End-to-end cases for the list chooser, malware/phishing protection, privacy
// extras and the on-device AI features, shared by the Chrome and Firefox tests.
// The browser-specific driver passes `ctl`:
//   settings(patch)        → settings:set (privacy / ai / cookieBanners)
//   setStub(stub|null)     → install / remove the stub model
//   modelDebug()           → { stub, calls }
//   aiStatus(page)         → per-tab AI status (what the content script reported)
//   setList(id, on)        → toggle a catalogue list (Chrome: through the options page UI)
//   listState(id)          → that list's download status
//   aiCache()              → stored per-site AI verdicts / plans (or null if not readable)
//   prepareShadow()        → optional: make the scam banner's shadow root inspectable
//   continueBlocked(page)  → click "Continue anyway" on the warning page
//   protectStats()         → hashed protection set stats (+ navigation-guard log)
//   protectReload()        → drop the in-memory set and reload it (service-worker restart cost)
//   protectLookup(host)    → { list, us }
//   setSiteEnabled(site, on) → the per-site switch (allow-list)
//   strictNoContact        → true where requests are held before they leave (Firefox webRequest)

import { sleep, waitFor } from './harness.mjs';
import { DEEP_HOST, DEEP_INDEX, FULL_LIST_HOSTS } from './server.mjs';

const vis = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return 'missing';
  const cs = getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden' ? 'hidden' : 'visible';
}, sel);

/** The page's own URL (puppeteer's page.url() reports moz-extension pages as about:blank over BiDi). */
const href = (page) => page.evaluate(() => location.href).catch(() => page.url());

export async function featureCases({ h, browser, label, log, ctl, extOrigin }) {
  const hits = (host, path) => log.filter((l) => l.host === host && (!path || l.path === path));
  const page = await browser.newPage();
  // A beforeunload prompt must never be needed; dismiss one if it appears so later steps still run.
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    void d.accept().catch(() => undefined);
  });

  // ---------- malware / phishing protection ----------
  {
    const st = await waitFor(async () => {
      const s = await ctl.listState('blp-phishing');
      return s?.fetchedAt ? s : null;
    }, 15000, 300);
    h.check(`${label}: phishing protection list downloaded at runtime (on by default)`, !!st && !st.error, st);
    const before = hits('phish.test').length;
    await page.goto('http://phish.test/login?next=%2Faccount', { waitUntil: 'load' }).catch(() => undefined);
    await sleep(800);
    const url = await href(page);
    const text = await page.evaluate(() => ({ title: document.getElementById('title')?.textContent, host: document.getElementById('host')?.textContent, hasContinue: !!document.getElementById('continue') })).catch((e) => ({ error: String(e) }));
    h.check(`${label}: navigation to listed phishing host shows the warning page`, url.startsWith(extOrigin) && url.includes('blocked.html?list=blp-phishing#http://phish.test/login?next=%2Faccount'), url);
    h.check(`${label}: warning page explains and offers Go back / Continue`, /phishing/.test(text.title ?? '') && text.host === 'phish.test' && text.hasContinue, text);
    h.check(`${label}: the phishing host was never contacted`, hits('phish.test').length === before, hits('phish.test').length - before);
    const contOk = await ctl.continueBlocked(page);
    await waitFor(async () => page.url().startsWith('http://phish.test/'), 8000, 200);
    h.check(`${label}: "Continue anyway" loads the site in this tab`, contOk !== false && page.url() === 'http://phish.test/login?next=%2Faccount' && (await page.evaluate(() => !!document.getElementById('phish')).catch(() => false)), page.url());
    const other = await browser.newPage();
    await other.goto('http://phish.test/again', { waitUntil: 'load' }).catch(() => undefined);
    await sleep(500);
    const otherUrl = await href(other);
    h.check(`${label}: "continue" is for this tab only (another tab is warned again)`, otherUrl.startsWith(extOrigin) && otherUrl.includes('blocked.html'), otherUrl);
    await other.close();
  }

  // ---------- full-size protection list (hashed set, no host limit) ----------
  {
    const st = await waitFor(async () => {
      const s = await ctl.listState('blp-malware');
      return s?.fetchedAt || s?.error ? s : null;
    }, 180000, 500);
    h.check(`${label}: full malware list (${FULL_LIST_HOSTS.toLocaleString()} hosts, ${Math.round((st?.bytes ?? 0) / 1e6)} MB) downloaded at runtime, on by default`, !!st?.fetchedAt && !st.error && st.hosts >= FULL_LIST_HOSTS, st);
    const stats = await waitFor(async () => {
      const s = (await ctl.protectStats())?.stats;
      return s && (s.counts?.['blp-malware'] ?? 0) > 0 ? s : null;
    }, 30000, 500);
    h.info(`${label}: protection set`, stats);
    h.check(`${label}: every host in the hashed set (no cap), about 5 bytes per host`, (stats?.counts?.['blp-malware'] ?? 0) >= FULL_LIST_HOSTS - 10 && stats.bytes < 16e6, { malware: stats?.counts?.['blp-malware'], mb: (stats?.bytes ?? 0) / 1e6 });
    const deep = await ctl.protectLookup(DEEP_HOST);
    const normal = await ctl.protectLookup('normal.test');
    h.check(`${label}: entry ${DEEP_INDEX.toLocaleString()} of the list is found; an ordinary host is not`, deep.list === 'blp-malware' && normal.list === null, { deep, normal });

    const nav = async (p, url) => {
      // Firefox (BiDi) may never report "load" for a redirect to a moz-extension page.
      await p.goto(url, { waitUntil: 'load', timeout: 8000 }).catch(() => undefined);
      const u = await waitFor(async () => {
        const x = await href(p);
        return x.startsWith(extOrigin) ? x : null;
      }, 6000, 100);
      // Let the warning page's script fill in the host.
      if (u) await waitFor(() => p.evaluate(() => !!document.getElementById('host')?.textContent).catch(() => false), 3000, 100);
      return u ?? href(p);
    };
    const contact = (host, before) => hits(host).length - before;
    const strict = (name, ok, detail) => (ctl.strictNoContact ? h.check(name, ok, detail) : h.info(`${name} [not guaranteed without blocking webRequest]`, { ok, ...detail }));

    const p1 = await browser.newPage();
    let before = hits(DEEP_HOST).length;
    const target = `http://${DEEP_HOST}/download/setup.exe?campaign=7`;
    const t0 = Date.now();
    const u1 = await nav(p1, target);
    const warnMs = Date.now() - t0;
    const t1 = await p1.evaluate(() => ({ title: document.getElementById('title')?.textContent, host: document.getElementById('host')?.textContent })).catch((e) => ({ error: String(e) }));
    h.check(`${label}: navigation to the deep entry goes to the warning page (original URL kept)`, u1.startsWith(extOrigin) && u1.endsWith(`blocked.html?list=blp-malware#${target}`) && /malware/.test(t1.title ?? '') && t1.host === DEEP_HOST, { url: u1, t1, warnMs });
    await sleep(500);
    strict(`${label}: the deep-entry host was never contacted`, contact(DEEP_HOST, before) === 0, { requests: contact(DEEP_HOST, before), guard: (await ctl.protectStats())?.guard?.slice(-2) });

    const sub = `www.login.${DEEP_HOST}`;
    before = hits(sub).length;
    const u2 = await nav(p1, `http://${sub}/`);
    h.check(`${label}: subdomains of a listed host are blocked too`, u2.startsWith(extOrigin) && u2.includes('blocked.html?list=blp-malware#'), u2);
    await sleep(300);
    strict(`${label}: the subdomain was never contacted`, contact(sub, before) === 0, { requests: contact(sub, before) });

    const frameHost = `frame.${DEEP_HOST}`;
    before = hits(frameHost).length;
    const p2 = await browser.newPage();
    await p2.goto('http://framer.test/page.html', { waitUntil: 'load' }).catch(() => undefined);
    await sleep(1200);
    const fr = {
      top: await p2.evaluate(() => !!document.getElementById('top')).catch(() => false),
      frames: p2.frames().map((f) => f.url()),
    };
    h.check(`${label}: a frame from a listed host does not load; the page around it does`, fr.top === true && !fr.frames.some((u) => u.includes(frameHost)), { fr, requests: contact(frameHost, before) });
    strict(`${label}: the listed frame host was never contacted`, contact(frameHost, before) === 0, { requests: contact(frameHost, before) });
    await p2.close();

    // "Continue anyway" on the deep entry.
    const u3 = await nav(p1, target);
    const ok = u3.startsWith(extOrigin) && (await ctl.continueBlocked(p1));
    const went = await waitFor(async () => p1.url() === target, 8000, 200);
    h.check(`${label}: "Continue anyway" on a hashed-list host loads it in this tab`, ok !== false && !!went && (await p1.evaluate(() => document.title).catch(() => '')) === DEEP_HOST, { url: p1.url(), u3 });

    // Allow-list (per-site switch off): no warning there; back on: warned again.
    const allowed = `allowed.${DEEP_HOST}`;
    await ctl.setSiteEnabled(allowed, false);
    const p3 = await browser.newPage();
    before = hits(allowed).length;
    await p3.goto(`http://${allowed}/`, { waitUntil: 'load' }).catch(() => undefined);
    await sleep(800);
    const u4 = await href(p3);
    h.check(`${label}: protection off for an allow-listed site (per-site switch)`, u4 === `http://${allowed}/` && contact(allowed, before) >= 1, { url: u4 });
    await ctl.setSiteEnabled(allowed, true);
    const u5 = await nav(p3, `http://${allowed}/again`);
    h.check(`${label}: switched back on → warned again`, u5.startsWith(extOrigin) && u5.includes('blocked.html'), u5);
    await p3.close();

    // Normal sites are unaffected.
    const p4 = await browser.newPage();
    const g0 = (await ctl.protectStats())?.guard?.length ?? 0;
    const t2 = Date.now();
    await p4.goto('http://normal.test/page.html', { waitUntil: 'load' });
    const normalMs = Date.now() - t2;
    const g1 = (await ctl.protectStats())?.guard ?? [];
    h.check(`${label}: an ordinary site loads normally (not warned)`, (await href(p4)) === 'http://normal.test/page.html' && (await p4.evaluate(() => document.title)) === 'Corner bakery' && !g1.slice(g0).some((x) => x.host === 'normal.test'), { normalMs });
    await p4.close();

    // Restart cost: drop the in-memory set and reload it from IndexedDB, then block again.
    const re = await ctl.protectReload();
    h.check(`${label}: restarted worker reloads the set from IndexedDB fast (no re-parse)`, re?.source === 'idb' && re.ms < 1500 && (re.counts?.['blp-malware'] ?? 0) >= FULL_LIST_HOSTS - 10, re);
    globalThis.__e2eStep = 'lookup latency';
    const lat = await ctl.protectLookup(`www.some-ordinary-site.example`);
    globalThis.__e2eStep = 'close p1';
    h.info(`${label}: lookup latency (4 labels, unlisted)`, `${lat.us.toFixed(1)} µs (includes timer resolution)`);
    await p1.goto('about:blank').catch(() => undefined);
    await p1.close().catch(() => undefined);
  }

  // ---------- privacy extras ----------
  {
    globalThis.__e2eStep = 'privacy settings';
    await ctl.settings({ privacy: { gpc: true, trimReferrer: true, stripClientData: true } });
    await sleep(500);
    const from = log.length;
    globalThis.__e2eStep = 'privacy page';
    await page.goto('http://privacy.test/deep/path/page.html?secret=1', { waitUntil: 'load' });
    globalThis.__e2eStep = 'privacy checks';
    await sleep(800);
    const reqs = log.slice(from);
    const doc = reqs.find((l) => l.host === 'privacy.test' && l.path.endsWith('page.html'));
    const tp = reqs.find((l) => l.host === 'thirdparty.test');
    const pg = await page.evaluate(() => ({ gpc: window.__gpc, gpcNow: navigator.globalPrivacyControl, mal: window.__malBlocked === true }));
    h.check(`${label}: Sec-GPC: 1 sent on the document request`, doc?.headers?.['sec-gpc'] === '1', doc?.headers?.['sec-gpc']);
    h.check(`${label}: Sec-GPC: 1 sent on third-party requests`, tp?.headers?.['sec-gpc'] === '1', tp?.headers?.['sec-gpc']);
    h.check(`${label}: navigator.globalPrivacyControl is true in the page`, pg.gpc === true && pg.gpcNow === true, pg);
    h.check(`${label}: third-party Referer trimmed to the origin despite Referrer-Policy: unsafe-url`, tp?.headers?.referer === 'http://privacy.test/', tp?.headers?.referer);
    h.check(`${label}: subresource from a protected (malware) host blocked`, pg.mal && hits('malware.test').length === 0, { mal: pg.mal, hits: hits('malware.test').length });
    await ctl.settings({ privacy: { gpc: false, trimReferrer: false } });
    await sleep(800);
    const from2 = log.length;
    await page.goto('http://privacy.test/deep/path/page.html?secret=2', { waitUntil: 'load' });
    await sleep(800);
    const doc2 = log.slice(from2).find((l) => l.host === 'privacy.test');
    const tp2 = log.slice(from2).find((l) => l.host === 'thirdparty.test');
    const gpc2 = await page.evaluate(() => navigator.globalPrivacyControl);
    h.check(`${label}: GPC off → no Sec-GPC header, navigator.globalPrivacyControl not true`, doc2 && !doc2.headers['sec-gpc'] && gpc2 !== true, { header: doc2?.headers?.['sec-gpc'], gpc2 });
    h.check(`${label}: Referer trimming off → full Referer (page policy unsafe-url)`, tp2?.headers?.referer === 'http://privacy.test/deep/path/page.html?secret=2', tp2?.headers?.referer);
    await ctl.settings({ privacy: { gpc: true, trimReferrer: true } });
  }

  // ---------- list chooser: toggling a list changes filtering ----------
  {
    await page.goto('http://annoy.test/page.html', { waitUntil: 'load' });
    await sleep(600);
    h.check(`${label}: annoyance list off by default → newsletter box visible`, (await vis(page, '#nl')) === 'visible');
    await ctl.setList('fanboy-annoyance', true);
    const st = await waitFor(async () => {
      const s = await ctl.listState('fanboy-annoyance');
      return s?.fetchedAt ? s : null;
    }, 15000, 300);
    const hidden = await waitFor(async () => {
      await page.reload({ waitUntil: 'load' });
      await sleep(400);
      return (await vis(page, '#nl')) === 'hidden';
    }, 12000, 500);
    h.check(`${label}: turning the annoyance list on downloads it and hides the box`, !!st && hidden, st);
    await ctl.setList('fanboy-annoyance', false);
    const shown = await waitFor(async () => {
      await page.reload({ waitUntil: 'load' });
      await sleep(400);
      return (await vis(page, '#nl')) === 'visible';
    }, 12000, 500);
    h.check(`${label}: turning it off again shows the box`, shown);
  }

  // ---------- AI features without a model (deterministic modes) ----------
  await ctl.setStub(null);
  await ctl.settings({ ai: { sponsored: true, scam: true, cookiePlans: true } });
  {
    await page.goto('http://sponsored.test/page.html', { waitUntil: 'load' });
    await sleep(1500);
    const s = { sponsored: await vis(page, '#card-sponsored'), normal: await vis(page, '#card-normal'), normal2: await vis(page, '#card-normal2'), ambiguous: await vis(page, '#card-ambiguous'), story: await vis(page, '#story'), main: await vis(page, 'main') };
    const ai = await ctl.aiStatus(page);
    h.check(`${label}: [no model] sponsored card hidden by the pre-filters`, s.sponsored === 'hidden', s);
    h.check(`${label}: [no model] normal cards kept`, s.normal === 'visible' && s.normal2 === 'visible', s);
    h.check(`${label}: [no model] ambiguous "Ad" card kept (stricter threshold)`, s.ambiguous === 'visible' && ai?.sponsored?.mode === 'prefilter-only', { s, ai: ai?.sponsored });
    h.check(`${label}: main/article never hidden (article carries a "Sponsored" kicker)`, s.story === 'visible' && s.main === 'visible', s);
  }
  {
    await ctl.prepareShadow?.('scam.test');
    await page.goto('http://scam.test/page.html', { waitUntil: 'load' });
    const banner = await waitFor(() => page.evaluate(() => !!document.querySelector('adb-scam-warning')), 6000, 200);
    const why = await page.evaluate(() => document.querySelector('adb-scam-warning')?.shadowRoot?.querySelector('.why')?.textContent ?? null);
    const ai = await ctl.aiStatus(page);
    h.check(`${label}: scam page warned ("looks like a scam because…")`, banner && ai?.scam?.decision === 'warn', { ai: ai?.scam, why });
    h.check(`${label}: scam warning names the reasons`, why === null || /virus|security alert/.test(why) && /phone number/.test(why), why);
    const leave = await page.evaluate(() => {
      const b = document.querySelector('adb-scam-warning')?.shadowRoot?.querySelector('.leave');
      if (!b) return false;
      b.click();
      return true;
    });
    if (leave) {
      const left = await waitFor(async () => (await href(page)).includes('blocked.html?mode=left'), 6000, 200);
      h.check(`${label}: one-click "Leave page" leaves the scam page (no "leave site?" prompt)`, left && dialogs === 0, { url: await href(page), dialogs });
    } else h.info(`${label}: "Leave page" click`, 'shadow root not inspectable in this browser; not clicked');
    await page.goto('http://normal.test/page.html', { waitUntil: 'load' });
    await sleep(2500);
    const normal = await page.evaluate(() => !!document.querySelector('adb-scam-warning'));
    const ai2 = await ctl.aiStatus(page);
    h.check(`${label}: normal page (bakery phone + scam advice) not warned`, !normal && ai2?.scam?.decision !== 'warn', ai2?.scam);
  }
  {
    await page.goto('http://cookies3.test/page.html', { waitUntil: 'load' });
    await sleep(5500);
    const st = await page.evaluate(() => ({ clicked: window.__clicked, banner: !!document.getElementById('cb') }));
    const ai = await ctl.aiStatus(page);
    h.check(`${label}: [no model] unknown cookie banner left alone (nothing clicked)`, st.clicked.length === 0 && st.banner && ai?.cookie?.result === 'no-model', { st, ai: ai?.cookie });
  }

  // ---------- AI features with the stub model ----------
  await ctl.setStub({
    available: true,
    rules: [
      { task: 'sponsored', contains: 'Weekly deals on garden furniture', result: { sponsored: true } },
      { task: 'sponsored', result: { sponsored: false } },
      { task: 'cookie', contains: 'cookies2.test-MALICIOUS', result: { selector: '#accept-all' } },
      { task: 'cookie', contains: 'Step 1.', result: { selector: '#more' } },
      { task: 'cookie', contains: 'Step 2.', result: { selector: '#reject-all' } },
      { task: 'scam', result: { scam: false, reason: '' } },
    ],
  });
  {
    await page.goto('http://sponsored.test/page.html', { waitUntil: 'load' });
    await sleep(2000);
    const s = { ambiguous: await vis(page, '#card-ambiguous'), sponsored: await vis(page, '#card-sponsored'), normal: await vis(page, '#card-normal'), story: await vis(page, '#story') };
    const dbg = await ctl.modelDebug();
    h.check(`${label}: [stub model] ambiguous card classified sponsored by the model and hidden`, s.ambiguous === 'hidden' && s.sponsored === 'hidden' && s.normal === 'visible' && s.story === 'visible' && dbg.calls.sponsored >= 1, { s, calls: dbg.calls });
    const calls1 = dbg.calls.sponsored;
    const cache = await ctl.aiCache();
    if (cache) h.check(`${label}: [stub model] verdict cached per site + selector as a cosmetic rule`, cache['sponsored.test']?.sponsored?.['div.card:has-text(Ad)'] === true, cache['sponsored.test']);
    await page.reload({ waitUntil: 'load' });
    await sleep(2000);
    const dbg2 = await ctl.modelDebug();
    h.check(`${label}: [stub model] second visit uses the cached verdict (model not asked again)`, (await vis(page, '#card-ambiguous')) === 'hidden' && dbg2.calls.sponsored === calls1, { before: calls1, after: dbg2.calls.sponsored });
  }
  {
    await page.goto('http://cookies.test/page.html', { waitUntil: 'load' });
    const done = await waitFor(() => page.evaluate(() => !document.getElementById('cb')), 9000, 200);
    const st = await page.evaluate(() => ({ clicked: window.__clicked, consent: window.__consent }));
    const ai = await waitFor(async () => {
      const a = await ctl.aiStatus(page);
      return a?.cookie?.result ? a : null;
    }, 5000, 200);
    h.check(`${label}: [stub model] AI click plan opens settings, rejects all, banner gone`, done && JSON.stringify(st.clicked) === '["more","reject-all"]' && st.consent === 'none' && ai?.cookie?.result === 'rejected', { st, ai: ai?.cookie });
    const cache = await ctl.aiCache();
    if (cache) h.check(`${label}: [stub model] working plan cached for the site`, cache['cookies.test']?.cookiePlan?.length === 2, cache['cookies.test']?.cookiePlan);
    // Replay without any model: the cached, re-validated plan is used.
    await ctl.setStub({ available: false, rules: [] });
    const callsBefore = (await ctl.modelDebug()).calls.cookie;
    await page.reload({ waitUntil: 'load' });
    const done2 = await waitFor(() => page.evaluate(() => !document.getElementById('cb')), 9000, 200);
    const ai2 = await waitFor(async () => {
      const a = await ctl.aiStatus(page);
      return a?.cookie?.result ? a : null;
    }, 5000, 200);
    h.check(`${label}: cached plan replayed on the next visit`, done2 && ai2?.cookie?.cached === true && (await page.evaluate(() => window.__consent)) === 'none', { ai: ai2?.cookie, callsBefore });
  }
  {
    // A malicious / wrong plan (model proposes "Accept all") is refused.
    await ctl.setStub({ available: true, rules: [{ task: 'cookie', result: { selector: '#accept-all' } }] });
    await page.goto('http://cookies2.test/page.html', { waitUntil: 'load' });
    await sleep(6000);
    const st = await page.evaluate(() => ({ clicked: window.__clicked, banner: !!document.getElementById('cb'), consent: window.__consent }));
    const ai = await ctl.aiStatus(page);
    h.check(`${label}: [stub model] "Accept all" plan refused by validation, nothing clicked`, st.clicked.length === 0 && st.banner && st.consent === undefined && ai?.cookie?.result === 'refused', { st, ai: ai?.cookie });
  }
  await frameCookieCases({ h, page, label, ctl });
  await ctl.setStub(null);
  await ctl.settings({ ai: { sponsored: false, scam: false, cookiePlans: false } });
  await page.close();
}

/** AI cookie plans for consent banners inside a cross-origin iframe (cmpframe.test), stub model. */
async function frameCookieCases({ h, page, label, ctl }) {
  const FRAME_RULES = [
    { task: 'cookie', contains: 'We use cookies to personalise content', result: { selector: '#reject-all' } },
    { task: 'cookie', contains: 'Step 1.', result: { selector: '#more' } },
    { task: 'cookie', contains: 'Step 2.', result: { selector: '#reject-all' } },
  ];
  const state = () => page.evaluate(() => ({ top: window.__clicked, frame: window.__frameClicked, consent: window.__consent ?? null, topConsent: window.__topConsent ?? null, iframe: !!document.getElementById('cmp'), topBanner: !!document.getElementById('cb') }));
  const cookieCalls = async () => (await ctl.modelDebug()).calls.cookie;
  // Consent iframes act only in a visible tab.
  await page.bringToFront();
  const accepted = (st) => [...st.top, ...st.frame].some((c) => /accept|save|^ok$/.test(c)) || st.consent === 'all' || st.topConsent === 'all';

  // Positive: the banner lives in a cross-origin iframe; the frame's own content script opens settings and rejects.
  await ctl.settings({ ai: { sponsored: false, scam: false, cookiePlans: true } });
  await ctl.setStub({ available: true, rules: FRAME_RULES });
  {
    await page.goto('http://frame-pos.test/page.html', { waitUntil: 'load' });
    await waitFor(async () => (await state()).consent !== null, 15000, 200);
    const ai = await waitFor(async () => {
      const a = await ctl.aiStatus(page);
      return a?.cookie?.result ? a : null;
    }, 8000, 200);
    const st = await state();
    h.check(`${label}: [stub model] consent banner in a cross-origin iframe: settings opened, rejected, frame closed`,
      JSON.stringify(st.frame) === '["more","reject-all"]' && st.consent === 'none' && !st.iframe && st.top.length === 0, { st, ai: ai?.cookie });
    h.check(`${label}: [stub model] iframe flow reported for the tab (frame closed on reject)`, ai?.cookie?.result === 'rejected' && ai?.cookie?.frame === true, ai?.cookie);
    const cache = await ctl.aiCache();
    if (cache) {
      h.check(`${label}: iframe plan cached under the TOP-level site, scoped to the frame host`,
        cache['frame-pos.test']?.cookiePlan?.length === 2 && cache['frame-pos.test']?.cookiePlanScope === 'cmpframe.test' && !cache['cmpframe.test'],
        { top: cache['frame-pos.test'], frameHost: cache['cmpframe.test'] ?? null });
    }
    // Replay the cached plan in the frame without a model.
    await ctl.setStub({ available: false, rules: [] });
    const before = await cookieCalls();
    await page.reload({ waitUntil: 'load' });
    await waitFor(async () => (await state()).consent !== null, 15000, 200);
    const st2 = await state();
    h.check(`${label}: cached iframe plan replayed on the next visit (no model)`, JSON.stringify(st2.frame) === '["more","reject-all"]' && st2.consent === 'none' && (await cookieCalls()) === before, { st2 });
  }

  // Negative: accept-only banner in the iframe, the model says "Accept all": nothing is clicked.
  await ctl.setStub({ available: true, rules: [{ task: 'cookie', result: { selector: '#accept-all' } }] });
  {
    await page.goto('http://frame-accept.test/page.html', { waitUntil: 'load' });
    await sleep(9000);
    const st = await state();
    h.check(`${label}: [stub model] accept-only banner in an iframe: nothing clicked`, st.frame.length === 0 && st.consent === null && st.iframe, st);
  }

  // Dual: a banner in the top frame AND one in an iframe: exactly one flow acts.
  await ctl.setStub({ available: true, rules: FRAME_RULES });
  {
    await page.goto('http://frame-dual.test/page.html', { waitUntil: 'load' });
    await waitFor(async () => {
      const st = await state();
      return st.consent !== null || st.topConsent !== null;
    }, 15000, 200);
    await sleep(8000);
    const st = await state();
    const rejects = [...st.top, ...st.frame].filter((c) => c === 'reject-all').length;
    h.check(`${label}: [stub model] banner in top frame + iframe: only one of them acts`,
      rejects === 1 && !accepted(st) && ((st.topConsent === 'none') !== (st.consent === 'none')), st);
  }

  // Tiny (1x1) and CSS-hidden (visibility:hidden) consent iframes are ignored.
  for (const kind of ['tiny', 'hidden']) {
    const before = await cookieCalls();
    await page.goto(`http://frame-${kind}.test/page.html`, { waitUntil: 'load' });
    await sleep(kind === 'hidden' ? 10000 : 8000);
    const st = await state();
    h.check(`${label}: [stub model] ${kind} consent iframe ignored (no click, model not asked)`, st.frame.length === 0 && st.consent === null && (await cookieCalls()) === before, { st, calls: (await cookieCalls()) - before });
  }

  // The opt-in setting and the per-site switch apply to frames (the cached plan for frame-pos.test is not used either).
  await ctl.settings({ ai: { sponsored: false, scam: false, cookiePlans: false } });
  {
    await page.goto('http://frame-pos.test/page.html', { waitUntil: 'load' });
    await sleep(8000);
    const st = await state();
    h.check(`${label}: AI cookie plans off: consent iframe left alone`, st.frame.length === 0 && st.iframe, st);
  }
  await ctl.settings({ ai: { sponsored: false, scam: false, cookiePlans: true } });
  if (ctl.setSiteEnabled) {
    await ctl.setSiteEnabled('frame-pos.test', false);
    await page.goto('http://frame-pos.test/page.html', { waitUntil: 'load' });
    await sleep(8000);
    const st = await state();
    h.check(`${label}: site switched off: its consent iframe left alone`, st.frame.length === 0 && st.iframe, st);
    await ctl.setSiteEnabled('frame-pos.test', true);
  }
}
