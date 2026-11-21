// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Host for DuckDuckGo autoconsent (MPL-2.0, from the npm package, shipped
// unmodified) running entirely in the page's main world: the proxy injects it
// as an inline <script nonce> and the extensions with scripting.executeScript.
// Written from autoconsent's documented message protocol; no third-party code.
//
// Invoked as (HOST)(CONFIG) immediately BEFORE autoconsent.playwright.js, with
// CONFIG = {rules: <compact ruleset {v,s,r}>, notify?: bool, timeBoxMs?: number}.
// autoconsent.playwright.js reads window.autoconsentSendMessage, sends 'init',
// and this host answers with the rules and a fixed opt-out configuration.
//
// Safety:
//  - autoAction is always 'optOut' ("reject all" / "necessary only"); this
//    host never sends 'optIn' and has no code path that could.
//  - isMainWorld: rule snippets run as functions, never as strings, so nothing
//    needs 'unsafe-eval' and 'eval' requests are refused.
//  - Heuristic (text-based) button detection is off: only CMP-specific rules
//    act, and they act only after detecting their CMP's popup.
//  - Consent-or-pay walls are left alone: during opt-out, clicks on buttons
//    about paying / subscribing / signing in are refused (see guard()).
//  - Time box: detection stops after detectRetries (~5-10 s), and whatever
//    happens, nothing autoconsent pre-hid stays hidden after timeBoxMs.
(function (cfg) {
  'use strict';
  try {
    var W = window, D = document;
    if (typeof W.autoconsentSendMessage === 'function' || W.autoconsentReceiveMessage) return;
    var config = {
      enabled: true,
      autoAction: 'optOut',
      disabledCmps: [],
      enablePrehide: true,
      enableCosmeticRules: true,
      enableGeneratedRules: true,
      detectRetries: 10,
      isMainWorld: true,
      prehideTimeout: 2000,
      enableHeuristicDetection: false,
      enablePopupMutationObserver: false,
      heuristicMode: 'off',
      visualTest: false,
      logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
    };
    // autoconsent's RuleBundle: {autoconsent: [JSON rules], compact: {v, s, r}}.
    var rules = { autoconsent: [], compact: (cfg && cfg.rules) || undefined };

    // Strict CSP: autoconsent writes its hiding rules into <style id=...>
    // elements it looks up by id. Under the proxy this script carries the
    // response's nonce; create those elements with it so they are allowed.
    // Injected by an extension there is no current script: reuse the nonce
    // of the page's own styles (or scripts), if it has any.
    // (Injected before the page is parsed, retry once it is.)
    function pageNonce() {
      try {
        var own = D.currentScript || D.querySelector('style[nonce],link[rel=stylesheet][nonce],script[nonce]');
        return (own && own.nonce) || '';
      } catch (e) { return ''; }
    }
    var nonce = pageNonce();
    function ensureStyles(create) {
      try {
        if (!nonce) nonce = pageNonce();
        if (!nonce) return;
        ['autoconsent-css-rules', 'autoconsent-prehide'].forEach(function (id) {
          var old = D.getElementById(id);
          // (A prehide sheet that is gone was removed by autoconsent: keep it gone.)
          if (old ? old.nonce === nonce : !create && id === 'autoconsent-prehide') return;
          var s = D.createElement('style');
          s.id = id;
          s.setAttribute('nonce', nonce);
          if (old) {
            s.textContent = old.textContent;
            old.replaceWith(s);
          } else {
            (D.head || D.documentElement).appendChild(s);
          }
        });
      } catch (e) { /* ignore */ }
    }
    ensureStyles(true);
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { ensureStyles(false); }, { once: true });

    function reply(msg) {
      // autoconsent assigns autoconsentReceiveMessage right after it sends
      // 'init' (synchronously), so answer on the next microtask.
      Promise.resolve().then(function () {
        try { if (W.autoconsentReceiveMessage) W.autoconsentReceiveMessage(msg); } catch (e) { /* ignore */ }
      });
    }

    function notify(msg) {
      if (!cfg || !cfg.notify) return;
      try {
        W.postMessage({
          __adbConsent: 1,
          type: String(msg.type),
          cmp: String(msg.cmp || ''),
          result: msg.result === undefined ? null : !!msg.result,
          cosmetic: !!msg.isCosmetic,
          clicks: typeof msg.totalClicks === 'number' ? msg.totalClicks : null,
        }, '*');
      } catch (e) { /* ignore */ }
    }

    // Consent-or-pay guard. Some rules' "reject" target is, on some sites, a
    // "reject and subscribe" / "already subscribed? sign in" button that
    // leaves the page (seen on lefigaro.fr). While autoconsent is opting out
    // (it reports its lifecycle to this host), refuse any .click() on an
    // element that talks about paying, subscribing or signing in, and leave
    // the choice to the user.
    var PAY = /subscri|abonn|abbon|suscri|assinatur|\bsign ?in\b|\blog ?in\b|connexion|connectez|anmelden|einloggen|\baccedi\b|iniciar sesi|zaloguj|\bpay\b|\bpaid\b|bezahl|kaufen|purchase|\bbuy\b|premium|\babo\b|pur-?abo|contentpass|[€£$]/i;
    var proto = W.HTMLElement && W.HTMLElement.prototype;
    var nativeClick = proto && proto.click;
    var guarded = null;
    function labelOf(el) {
      var t = '';
      try {
        t = [el.innerText || el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.value || ''].join(' ');
      } catch (e) { /* ignore */ }
      return t.slice(0, 500);
    }
    function guard(on) {
      if (!proto || !nativeClick) return;
      try {
        if (on && !guarded) {
          guarded = function () {
            if (PAY.test(labelOf(this))) {
              notify({ type: 'clickRefused', cmp: labelOf(this).replace(/\s+/g, ' ').trim().slice(0, 80) });
              return undefined;
            }
            return nativeClick.apply(this, arguments);
          };
          proto.click = guarded;
        } else if (!on && guarded) {
          if (proto.click === guarded) proto.click = nativeClick;
          guarded = null;
        }
      } catch (e) { /* ignore */ }
    }

    W.autoconsentSendMessage = function (msg) {
      try {
        if (!msg || typeof msg !== 'object') return Promise.resolve();
        switch (msg.type) {
          case 'init':
            reply({ type: 'initResp', config: config, rules: rules });
            break;
          case 'eval':
            // Never evaluate strings (isMainWorld runs snippets directly).
            reply({ type: 'evalResp', id: msg.id, result: false });
            break;
          case 'report':
            var lc = msg.state && msg.state.lifecycle;
            if (lc === 'openPopupDetected' || lc === 'runningOptOut') guard(true);
            else if (lc === 'optOutSucceeded' || lc === 'optOutFailed' || lc === 'done' || lc === 'nothingDetected') guard(false);
            break;
          case 'cmpDetected':
          case 'popupFound':
          case 'optOutResult':
          case 'autoconsentDone':
            notify(msg);
            break;
          default:
            break;
        }
      } catch (e) { /* ignore */ }
      return Promise.resolve();
    };

    setTimeout(function () {
      guard(false);
      try {
        var p = D.getElementById('autoconsent-prehide');
        if (p) p.remove();
      } catch (e) { /* ignore */ }
    }, (cfg && cfg.timeBoxMs) || 15000);
  } catch (e) { /* never break the page */ }
})
