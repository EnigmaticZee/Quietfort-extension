// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Local test web server for the end-to-end tests. The test browsers use it as
// their HTTP proxy for every host, so one server plays publisher, ad network,
// tracker, popup networks and the filter-list host. Requests are logged so the
// tests can assert what actually reached the network.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Consent-banner fixture pages, shared with the Mac proxy's tests.
const CONSENT_FIXTURES = new URL('../../page-runtime/tests/consent-fixtures/', import.meta.url);
// Strict CSP for csp-cmp.test: the fixtures' own scripts/styles carry nonce="fixture".
export const STRICT_CSP = "default-src 'self'; script-src 'nonce-fixture'; style-src 'self' 'nonce-fixture'; img-src 'self'; object-src 'none'; base-uri 'none'";

// Test-only stand-in for the EasyList Cookie List (written for these tests).
export function cookieFixtureList() {
  return `[Adblock Plus 2.0]
! Title: e2e cookie fixture list
##.fixture-cookie-bar
`;
}

// Test-only filter list, written for these tests (not derived from EasyList).
export function fixtureList(port) {
  return `[Adblock Plus 2.0]
! Title: e2e fixture list
! Network
||adnet.test^
||tracker.test^$third-party
||imp.test^$important
@@||imp.test^
@@||adnet.test/ads/allowed/$image
||redir.test/gpt.js$script,redirect=googletagservices_gpt.js
||redir.test/pixel.gif$image,redirect=1x1.gif
$removeparam=utm_source
||publisher.test/hdr$removeheader=x-tracking-header
||csp.publisher.test^$csp=script-src 'none'
@@||trusted.test^$document
/regex-ad[0-9]+\\.js/
||firstparty-only.test/fp.gif$~third-party
! Popups
||popads.test^$popup
@@||popads.test/allowed^$popup
||popunder.test^$popup,third-party
! Cosmetic
##.ad-banner
##[data-ad-slot]
publisher.test###specific-ad
publisher.test,trusted.test#@#.not-really-an-ad
##.not-really-an-ad
publisher.test#?#.sponsored-box:has-text(Sponsored)
publisher.test##+js(set-constant, adConfig.enabled, false)
publisher.test##+js(trusted-set-cookie, evil, 1)
publisher.test#%#window.__rawJsRan = true
@@||noghide.test^$generichide
! Fix-this-site fixtures: each page is broken by one specific rule
broken-sl.test##+js(set-constant, SiteApp, undefined)
broken-sl.test##.promo-box
##.sidebar-ad
||broken-fp.test/js/widgets.js
broken-fp.test##.fp-banner
`;
}

// Test-only stand-ins for catalogue lists (written for these tests, not list content).
export function phishHostsList() {
  return `# Title: e2e protection fixture (hosts format)
#
0.0.0.0 phish.test
0.0.0.0 malware.test
`;
}

export function annoyanceFixtureList() {
  return `[Adblock Plus 2.0]
! Title: e2e annoyance fixture list
##.newsletter-popup
`;
}

/** Full-size stand-in for the Block List Project malware list: this entry is deep in it. */
export const DEEP_INDEX = 2_500_000;
export const DEEP_HOST = 'deep-entry.malware-full.test';
export const FULL_LIST_HOSTS = 2_700_000;
let fullList = null;

/** Synthetic hosts list with FULL_LIST_HOSTS random hosts (~74 MB), DEEP_HOST at DEEP_INDEX. Generated once; `samples`: index → host every 100,000 entries. */
export function fullMalwareList() {
  if (fullList) return fullList;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const tlds = ['com', 'net', 'xyz', 'top', 'info', 'ru', 'online'];
  let x = 4242;
  const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff);
  const lines = ['# Title: e2e full-size malware fixture (synthetic hosts)', '#'];
  const samples = {};
  for (let i = 0; i < FULL_LIST_HOSTS; i++) {
    if (i === DEEP_INDEX) {
      lines.push(`0.0.0.0 ${DEEP_HOST}`);
      continue;
    }
    // Random letters plus the index: every host distinct.
    let h = '';
    const l = 3 + ((rnd() >>> 8) % 12);
    for (let j = 0; j < l; j++) h += chars[(rnd() >>> 8) % 36];
    const host = `${h}-${i.toString(36)}.${tlds[(rnd() >>> 8) % tlds.length]}`;
    if (i % 100_000 === 0 || i === FULL_LIST_HOSTS - 1) samples[i] = host;
    lines.push(`0.0.0.0 ${host}`);
  }
  const body = Buffer.from(`${lines.join('\n')}\n`);
  fullList = { body, etag: `"full-${body.length}"`, samples };
  return fullList;
}

/** Catalogue id → fixture served at /catalogue/<id>.txt (others: 404, i.e. a failed download). */
const CATALOGUE_FIXTURES = {
  'blp-phishing': phishHostsList,
  'fanboy-annoyance': annoyanceFixtureList,
};

function sponsoredPage() {
  const para = 'Real editorial text that readers came for, written by the newsroom and long enough to be the main content of the page. ';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>feed</title>
<style>.card { display: block; width: 300px; min-height: 60px; margin: 8px; border: 1px solid #ccc; } aside { display: block; }</style></head><body>
<main>
<article id="story"><span class="kicker">Sponsored</span><p>${para.repeat(6)}</p></article>
<section class="feed">
  <div class="card" id="card-normal"><h3>City council approves new park</h3><p>The council voted 7-2 on Tuesday to turn the old rail yard into a park.</p><a href="/news/park">Read more</a></div>
  <div class="card" id="card-sponsored"><span class="label">Sponsored</span><h3>The gadget everyone is talking about</h3><p>Get yours today with free shipping.</p><a href="https://amzn.to/3abcd">Shop now</a></div>
  <div class="card" id="card-ambiguous"><span class="label">Ad</span><h3>Weekly deals on garden furniture</h3><p>Chairs, tables and parasols at low prices.</p><a href="/shop/garden">See deals</a></div>
  <div class="card" id="card-normal2"><h3>Weather: sunny weekend ahead</h3><p>Temperatures up to 25 degrees, light winds from the west.</p><a href="/news/weather">Forecast</a></div>
</section>
</main>
</body></html>`;
}

function scamPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Windows Defender Security Alert</title></head><body>
<h1>Windows Defender Security Alert</h1>
<p>Your computer is infected with 5 viruses! Trojan spyware detected. Your personal data will be stolen.</p>
<p>Call Microsoft Support immediately at toll free <b>+1 (888) 555-0199</b>. Do not close this window or restart your computer.</p>
<button id="fix">Scan now</button>
<script>
  window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = ''; });
  document.addEventListener('click', function () { try { document.documentElement.requestFullscreen(); } catch (e) {} });
  for (var i = 0; i < 6; i++) history.pushState({ i: i }, '', location.href);
</script>
</body></html>`;
}

function normalPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Corner bakery</title></head><body>
<h1>Corner bakery</h1><p>We bake fresh bread every morning. Call us at (555) 123-4567 to order a cake. Open Monday to Saturday.</p>
<p>How to spot a tech support scam: scammers may claim your computer is infected and ask you to call a number. Close such pages.</p>
</body></html>`;
}

// ---------- extra fixtures for the real-model (NANO=1) run ----------

/** Ambiguous blocks (weak labels only, score in the "ask the model" band): two ads, two editorial cards. */
function sponsoredMixPage() {
  const para = 'Real editorial text that readers came for, written by the newsroom and long enough to be the main content of the page. ';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Riverside Daily</title>
<style>.card { display: block; width: 300px; min-height: 60px; margin: 8px; border: 1px solid #ccc; }</style></head><body>
<main>
<article id="story"><h1>Riverside Daily</h1><p>${para.repeat(6)}</p></article>
<section class="feed">
  <div class="card" id="ed-offer"><span class="label">Offer</span><h3>Bus drivers reject council's pay offer</h3><p>The union said the 3% offer did not keep up with inflation. Talks resume on Monday.</p><a href="/news/bus-strike">Read more</a></div>
  <div class="card" id="ad-promo"><span class="label">Promo</span><h3>Save 40% on meal kits this week</h3><p>Fresh ingredients delivered to your door. Use code FRESH40 at checkout.</p><a href="https://mealkit.example/deal">Claim your discount</a></div>
  <div class="card" id="ed-partner"><span class="label">Partners</span><h3>University and hospital open joint heart research lab</h3><p>Researchers from both institutions will share the new building from next spring.</p><a href="/news/research-lab">Read more</a></div>
  <div class="card" id="ad-sponsor"><span class="label">Sponsor</span><h3>Switch your energy plan and get $100 credit</h3><p>Compare green tariffs in two minutes. New customers only, terms apply.</p><a href="https://energy-switch.example/signup">Get my $100</a></div>
</section>
</main>
</body></html>`;
}

/** Scam in the "ask the model" band (heuristic score 3): fake parcel redelivery fee. */
function parcelScamPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Delivery notice</title></head><body>
<h1>Royal Parcel Service</h1>
<p>Your parcel could not be delivered because of an unpaid redelivery fee. Your package is held at our depot.</p>
<p>Pay the redelivery fee of $1.99 within 24 hours or your parcel will be returned to the sender.</p>
<p>Enter your card details below to schedule a new delivery. Tracking number: RP4471902GB</p>
<form><input placeholder="Card number"><button type="button">Pay $1.99</button></form>
</body></html>`;
}

/** Legitimate pages in the same band: a news story about gift-card scams, a shop sale. */
function scamNewsPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Gift card scams are rising, police warn</title></head><body>
<h1>Gift card scams are rising, police warn</h1>
<p>Police are warning residents about a rise in gift card scams. Fraudsters phone victims, claim to be from the tax office and tell them to act now and pay a fine with Google Play gift cards.</p>
<p>Police say no real agency asks for payment in gift cards. If you get such a call, hang up and report it.</p>
<p>Published Tuesday by our consumer affairs reporter.</p>
</body></html>`;
}

function shopSalePage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Hartley's Hardware - Autumn sale</title></head><body>
<h1>Hartley's Hardware</h1>
<p>Last chance: our autumn sale on garden tools expires tonight. Rakes, spades and leaf blowers are 20% off in store and online.</p>
<p>We accept all major cards, cash and Hartley's gift cards. Free delivery on orders over $50.</p>
<p>Visit us at 12 Mill Road, open 8am to 6pm.</p>
</body></html>`;
}

/** German banner with a direct "necessary only" button (no rule set covers it). */
function cookieBannerDePage(label) {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${label}</title>
<style>#cb { position: fixed; bottom: 0; left: 0; right: 0; background: #eee; padding: 16px; z-index: 1000; }</style></head><body>
<h1>${label}</h1><p id="content">Artikel.</p>
<div id="cb">
  <p>Wir und unsere Partner verwenden Cookies, um Inhalte zu personalisieren und Zugriffe zu analysieren. Sie können Ihre Auswahl jederzeit ändern.</p>
  <button id="accept-all">Alle akzeptieren</button>
  <button id="settings">Einstellungen</button>
  <button id="necessary">Nur notwendige Cookies</button>
</div>
<script>
  window.__clicked = [];
  var cb = document.getElementById('cb');
  document.getElementById('accept-all').onclick = function () { __clicked.push('accept-all'); cb.remove(); window.__consent = 'all'; };
  document.getElementById('settings').onclick = function () { __clicked.push('settings'); };
  document.getElementById('necessary').onclick = function () { __clicked.push('necessary'); cb.remove(); window.__consent = 'none'; };
</script>
</body></html>`;
}

/** A consent banner autoconsent has no rule for: reject is behind "Manage settings". */
function cookieBannerPage(label) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${label}</title>
<style>#cb { position: fixed; bottom: 0; left: 0; right: 0; background: #eee; padding: 16px; z-index: 1000; } #panel { display: none; }</style></head><body>
<h1>${label}</h1><p id="content">Article content.</p>
<div id="cb">
  <p>We and our partners use cookies to personalise content and measure our audience. You can change your choice at any time.</p>
  <button id="accept-all">Accept all</button>
  <button id="more">Manage settings</button>
  <div id="panel"><button id="reject-all">Reject all</button><button id="save">Save and accept</button></div>
</div>
<script>
  window.__clicked = [];
  var cb = document.getElementById('cb');
  document.getElementById('accept-all').onclick = function () { __clicked.push('accept-all'); cb.remove(); window.__consent = 'all'; };
  document.getElementById('more').onclick = function () { __clicked.push('more'); document.getElementById('panel').style.display = 'block'; document.getElementById('accept-all').style.display = 'none'; document.getElementById('more').style.display = 'none'; };
  document.getElementById('reject-all').onclick = function () { __clicked.push('reject-all'); cb.remove(); window.__consent = 'none'; };
  document.getElementById('save').onclick = function () { __clicked.push('save'); cb.remove(); window.__consent = 'all'; };
</script>
</body></html>`;
}

/**
 * A consent banner in a cross-origin iframe (Sourcepoint-style): the frame page
 * reports its clicks to the parent, which removes the iframe once a choice is made.
 * mode: pos (accept / "Manage settings" → reject all), accept (accept-only).
 */
function cmpFramePage(mode) {
  const buttons = mode === 'accept'
    ? '<button id="accept-all">Accept all</button><button id="ok">OK</button>'
    : '<button id="accept-all">Accept all</button><button id="more">Manage settings</button><div id="panel" style="display:none"><button id="reject-all">Reject all</button><button id="save">Save and accept</button></div>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>cmp frame</title>
<style>html, body { margin: 0; height: 100%; font: 14px sans-serif; } #msg { padding: 16px; background: #fff; height: 100%; box-sizing: border-box; }</style></head><body>
<div id="msg" class="message-container">
  <p>We and our partners use cookies and store or access information on your device to personalise ads and content and measure our audience. You can change your choice at any time in the privacy settings.</p>
  ${buttons}
</div>
<script>
  function tell(id, choice) { parent.postMessage({ cmpFrameClick: id, choice: choice }, '*'); }
  document.querySelectorAll('button').forEach(function (b) {
    b.onclick = function () {
      if (b.id === 'more') { document.getElementById('panel').style.display = 'block'; document.getElementById('accept-all').style.display = 'none'; b.style.display = 'none'; tell('more'); return; }
      tell(b.id, b.id === 'reject-all' ? 'none' : 'all');
    };
  });
</script>
</body></html>`;
}

/**
 * Publisher page holding a consent iframe from cmpframe.test.
 * kind: pos | accept | dual (banner in the top frame too) | tiny (1x1 iframe) | hidden (visibility:hidden iframe).
 */
function framedCookiePage(host, kind) {
  const mode = kind === 'accept' ? 'accept' : 'pos';
  const style = kind === 'tiny' ? 'width:1px;height:1px;'
    : kind === 'hidden' ? 'width:640px;height:320px;visibility:hidden;'
    : 'width:640px;height:320px;';
  const top = kind === 'dual' ? `<div id="cb" style="position:fixed;top:0;left:0;right:0;background:#eee;padding:16px;z-index:1000">
  <p>We use cookies to personalise content and measure our audience. You can change your choice at any time.</p>
  <button id="accept-all">Accept all</button><button id="reject-all">Reject all</button>
</div>` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${host}</title></head><body>
<h1>${host}</h1><p id="content">Article content.</p>
${top}
<iframe id="cmp" title="SP Consent Message" src="http://cmpframe.test/banner.html?mode=${mode}" style="position:fixed;bottom:20px;left:20px;border:0;z-index:2000;${style}"></iframe>
<script>
  window.__clicked = [];
  window.__frameClicked = [];
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || !m.cmpFrameClick || ev.origin !== 'http://cmpframe.test') return;
    __frameClicked.push(m.cmpFrameClick);
    if (m.choice) { window.__consent = m.choice; var f = document.getElementById('cmp'); if (f) f.remove(); }
  });
  var cb = document.getElementById('cb');
  if (cb) {
    document.getElementById('accept-all').onclick = function () { __clicked.push('accept-all'); cb.remove(); window.__topConsent = 'all'; };
    document.getElementById('reject-all').onclick = function () { __clicked.push('reject-all'); cb.remove(); window.__topConsent = 'none'; };
  }
</script>
</body></html>`;
}

function privacyPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>privacy</title></head><body>
<p>privacy fixture</p>
<img id="tp" src="http://thirdparty.test/ref.gif?from=privacy">
<img id="mal" src="http://malware.test/pixel.gif" onerror="window.__malBlocked = true">
<script>window.__gpc = navigator.globalPrivacyControl;</script>
</body></html>`;
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function page() {
  // The browsers reach this server as an HTTP proxy, so URLs carry no port
  // (an explicit port would stop `||host/path` filters from matching).
  const P = '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>publisher</title>
<script>
  window.adConfig = { enabled: true };
  window.__earlyEnabled = window.adConfig.enabled;
  window.__events = [];
</script>
<script src="http://ads.adnet.test${P}/ads/ad.js" onerror="__events.push('adjs-error')"></script>
<script src="http://cdn.publisher.test${P}/lib.js"></script>
<script src="http://redir.test${P}/gpt.js"></script>
<script src="http://cdn.other.test${P}/regex-ad123.js" onerror="__events.push('regex-error')"></script>
</head><body>
<img id="img-tracker" src="http://tracker.test${P}/pixel.gif">
<img id="img-excepted" src="http://ads.adnet.test${P}/ads/allowed/ok.gif">
<img id="img-important" src="http://imp.test${P}/x.gif">
<img id="img-redirect" src="http://redir.test${P}/pixel.gif">
<img id="img-fp" src="http://firstparty-only.test${P}/fp.gif">
<div class="ad-banner" id="generic-ad">generic ad</div>
<div data-ad-slot="1" id="attr-ad">attribute ad</div>
<div id="specific-ad">site-specific ad</div>
<div class="sponsored-box" id="sponsored">Sponsored content</div>
<div class="sponsored-box" id="not-sponsored">Editorial content</div>
<div class="not-really-an-ad" id="excepted-cosmetic">excepted by #@#</div>
<div class="content" id="content">real content</div>
<button id="open-bad" onclick="window.__p1 = window.open('http://popads.test${P}/landing')">bad popup</button>
<button id="open-good" onclick="window.__p2 = window.open('http://goodsite.test${P}/landing')">good popup</button>
<button id="open-allowed" onclick="window.__p3 = window.open('http://popads.test${P}/allowed/x')">allowed popup</button>
<button id="open-blank-then-bad" onclick="var w = window.open('about:blank'); setTimeout(function(){ w.location.href = 'http://popads.test${P}/later'; }, 300)">blank then bad</button>
<button id="open-3p" onclick="window.open('http://popunder.test${P}/x')">third-party popunder</button>
<a id="link-bad" href="http://popads.test${P}/viaLink" target="_blank">link popup</a>
<script>
  setTimeout(function () {
    var d = document.createElement('div');
    d.className = 'ad-banner';
    d.id = 'late-ad';
    d.textContent = 'late generic ad';
    document.body.appendChild(d);
  }, 600);
  fetch('/echo?id=1&utm_source=newsletter&x=2').then(function (r) { return r.text(); }).then(function (t) { window.__echo = t; });
  fetch('/hdr').then(function (r) { window.__hdr = r.headers.get('x-tracking-header'); window.__hdrKeep = r.headers.get('x-keep-header'); });
  window.addEventListener('load', function () { window.__loaded = true; });
</script>
</body></html>`;
}

// Broken by the scriptlet `set-constant, SiteApp, undefined` (whenever it runs:
// it overrides the value even after the assignment).
function brokenScriptletPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>broken by a scriptlet</title>
<script src="http://ads.adnet.test/ads/ad.js"></script>
<script src="http://tracker.test/t.js"></script>
<script>
  window.SiteApp = { start: function () { document.getElementById('app').textContent = 'App ready'; window.__siteWorks = true; } };
</script>
</head><body>
<div class="promo-box" id="promo">house promo</div>
<div class="sidebar-ad" id="side">sidebar ad</div>
<div id="app">Loading…</div>
<script>
  window.addEventListener('load', function () { setTimeout(function () { SiteApp.start(); }, 150); });
</script>
</body></html>`;
}

// Broken by the first-party network rule `||broken-fp.test/js/widgets.js`.
function brokenFirstPartyPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>broken by a first-party block</title>
<script src="/js/widgets.js"></script>
<script src="http://ads.adnet.test/ads/ad.js"></script>
</head><body>
<div class="fp-banner" id="banner">banner</div>
<div id="w">Loading widgets…</div>
<script>
  Widgets.render(document.getElementById('w'));
  window.__siteWorks = true;
</script>
</body></html>`;
}

// Element picker fixture: CSS-in-JS / CSS-modules class names everywhere; the
// ad's only stable class is configurable so a test can "redeploy" the site.
function pickerPage(promoClass) {
  const para = 'This is the real article text that readers came for. It is long enough that hiding one small box never hides most of the page. ';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>picker</title>
<style>aside { display: block; width: 300px; height: 120px; margin: 10px; border: 1px solid #ccc; }</style></head><body>
<header class="css-9k2j1a site-header">Picker test site</header>
<main>
<article class="sc-fzXfMv Article_body__2kD9s"><p>${para.repeat(3)}</p><p>${para.repeat(3)}</p></article>
<aside class="css-1q2w3e4 ${promoClass} jsx-8a7f6e2b" aria-label="Sponsored offer"><span class="sc-AxjAm">Sponsored</span> Buy the new widget today</aside>
<aside class="css-77aa1b2 related-links" aria-label="Related"><span class="sc-AxjAm">Related</span> More stories</aside>
</main>
<footer class="Footer_root__9fK2q">Footer</footer>
</body></html>`;
}

/** "Describe it to hide it" / My Rules page: an article, a newsletter modal, a chat bubble, a custom-rule image. */
function describePage() {
  return `<!doctype html><html><head><title>Describe test</title><style>
  .nl-modal{position:fixed;top:120px;left:200px;width:480px;height:300px;background:#fff;border:1px solid #888;z-index:5}
  #chat-launcher{position:fixed;right:20px;bottom:20px;width:64px;height:64px;border-radius:50%;background:#36c}
  </style></head><body>
  <header class="masthead" style="height:80px">Daily Example — Home · News · Sport</header>
  <article class="story" style="width:800px;min-height:900px">Latest headlines from today. The council met to discuss the plan. More text follows here about the city budget.</article>
  <aside class="weather-box" style="margin-top:300px;height:120px;width:300px">Weather: light rain, 12°</aside>
  <div class="nl-modal" role="dialog" aria-modal="true"><h2>Subscribe to our newsletter</h2><p>Get the best stories in your inbox every morning.</p><button>Sign up</button></div>
  <div id="chat-launcher" class="intercom-launcher" aria-label="Open chat"></div>
  <img id="custom" src="http://custom-block.test/pixel.gif" width="1" height="1">
  </body></html>`;
}

export function startServer(port = 0) {
  const log = [];
  const state = { pickerClass: 'promo-unit' };
  const server = createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    log.push({ host, path: url.pathname, query: url.search, at: Date.now(), headers: req.headers });
    const p = server.address().port;
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(body);
    };
    if (host === 'lists.test' && url.pathname === '/fixture.txt') return send(200, 'text/plain', fixtureList(p));
    if (host === 'lists.test' && url.pathname === '/cookie.txt') return send(200, 'text/plain', cookieFixtureList());
    if ((host === 'cmp.test' || host === 'csp-cmp.test') && /^\/[a-z-]+\.html$/.test(url.pathname)) {
      let html;
      try {
        html = readFileSync(new URL(url.pathname.slice(1), CONSENT_FIXTURES));
      } catch {
        return send(404, 'text/plain', 'no such fixture');
      }
      return send(200, 'text/html; charset=utf-8', html, host === 'csp-cmp.test' ? { 'content-security-policy': STRICT_CSP } : {});
    }
    if (host === 'lists.test' && url.pathname.startsWith('/real/')) {
      // Real EasyList/EasyPrivacy from the developer's local dev-data copy (stress test).
      return import('node:fs').then((fs) => {
        const f = new URL(`../../../dev-data/${url.pathname.slice(6)}`, import.meta.url);
        if (!fs.existsSync(f)) return send(404, 'text/plain', 'missing');
        send(200, 'text/plain', fs.readFileSync(f));
      });
    }
    if (host === 'lists.test' && url.pathname === '/catalogue/blp-malware.txt') {
      const { body, etag } = fullMalwareList();
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      return send(200, 'text/plain', body, { etag });
    }
    if (host === 'framer.test' && url.pathname === '/page.html') {
      return send(200, 'text/html; charset=utf-8', `<!doctype html><title>framer</title><p id="top">top page</p><iframe id="f" src="http://frame.${DEEP_HOST}/inner.html"></iframe>`);
    }
    if (host === 'lists.test' && url.pathname.startsWith('/catalogue/')) {
      const fx = CATALOGUE_FIXTURES[url.pathname.slice(11).replace(/\.txt$/, '')];
      return fx ? send(200, 'text/plain', fx()) : send(404, 'text/plain', 'no fixture');
    }
    if (host === 'describe.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', describePage());
    if (host === 'sponsored.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', sponsoredPage());
    if (host === 'scam.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', scamPage());
    if (host === 'normal.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', normalPage());
    if (/^cookies\d?\.test$/.test(host) && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', cookieBannerPage(host));
    if (host === 'sponsored-mix.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', sponsoredMixPage());
    if (host === 'parcel.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', parcelScamPage());
    if (host === 'scam-news.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', scamNewsPage());
    if (host === 'shop-sale.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', shopSalePage());
    if (host === 'cmpframe.test' && url.pathname === '/banner.html') return send(200, 'text/html; charset=utf-8', cmpFramePage(url.searchParams.get('mode')));
    {
      const fm = /^frame-(pos|accept|dual|tiny|hidden)\.test$/.exec(host);
      if (fm && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', framedCookiePage(host, fm[1]));
    }
    if (host === 'cookies-de.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', cookieBannerDePage(host));
    if (host === 'annoy.test' && url.pathname === '/page.html') {
      return send(200, 'text/html; charset=utf-8', '<!doctype html><title>annoy</title><div class="newsletter-popup" id="nl">Subscribe to our newsletter!</div><p id="c">content</p>');
    }
    // Weak Referrer-Policy from the server: the extension must still trim third-party referrers.
    if (host === 'privacy.test' && url.pathname.endsWith('page.html')) return send(200, 'text/html; charset=utf-8', privacyPage(), { 'referrer-policy': 'unsafe-url' });
    if (host === 'phish.test') return send(200, 'text/html', `<!doctype html><title>phish ${url.pathname}</title><p id="phish">fake login page</p>`);
    if (url.pathname === '/echo') return send(200, 'text/plain', url.search);
    if (url.pathname === '/hdr') return send(200, 'text/plain', 'ok', { 'x-tracking-header': 'secret', 'x-keep-header': 'kept', 'access-control-expose-headers': '*' });
    if (url.pathname.endsWith('.gif')) return send(200, 'image/gif', GIF);
    if (url.pathname.endsWith('ad.js')) return send(200, 'application/javascript', 'window.__adLoaded = true;');
    if (url.pathname.endsWith('regex-ad123.js')) return send(200, 'application/javascript', 'window.__regexAdLoaded = true;');
    if (url.pathname.endsWith('gpt.js')) return send(200, 'application/javascript', 'window.__realGpt = true;');
    if (url.pathname.endsWith('lib.js')) return send(200, 'application/javascript', 'window.__libLoaded = true;');
    if (host === 'csp.publisher.test') {
      return send(200, 'text/html', '<!doctype html><title>csp</title><script>window.__inlineRan = true;</script><p id="p">csp page</p>');
    }
    if (host === 'broken-sl.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', brokenScriptletPage());
    if (host === 'broken-fp.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', brokenFirstPartyPage());
    if (host === 'broken-fp.test' && url.pathname === '/js/widgets.js') {
      return send(200, 'application/javascript', "window.Widgets = { render: function (el) { el.textContent = 'widgets ok'; } }; window.__widgetsLoaded = (window.__widgetsLoaded || 0) + 1;");
    }
    if (host === 'picker.test' && url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', pickerPage(state.pickerClass));
    if (url.pathname === '/streamed.html') {
      // Like a real site over the network: the head arrives first and the first
      // inline script 150 ms later (YouTube's player data sits far down a
      // streamed page). Checks that scriptlets are in place by then.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.write(`<!doctype html><html><head><meta charset="utf-8"><title>streamed</title><!-- ${'x'.repeat(2048)} -->\n`);
      setTimeout(() => {
        res.end('<script>window.adConfig = { enabled: true }; window.__streamedEarly = window.adConfig.enabled;</script></head><body><p id="content">streamed</p></body></html>');
      }, 150);
      return;
    }
    if (url.pathname === '/page.html') return send(200, 'text/html; charset=utf-8', page());
    if (url.pathname === '/landing' || url.pathname.startsWith('/allowed') || url.pathname === '/later' || url.pathname === '/x' || url.pathname === '/viaLink') {
      return send(200, 'text/html', `<!doctype html><title>landing ${host}${url.pathname}</title><p>landing</p>`);
    }
    send(200, 'text/html', `<!doctype html><title>${host}</title><p>ok</p>`);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, log, state })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startServer(Number(process.argv[2] || 0));
  console.log(`test server on 127.0.0.1:${port}`);
}
