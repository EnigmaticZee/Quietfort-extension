// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Page runtime: scriptlets + procedural cosmetic filtering.
// Written from scratch from public behaviour descriptions; no third-party code.
// Invoked as: (RUNTIME)(CONFIG) where CONFIG = {s: [[name, [args]]...], p: [selector...]}
(function (cfg) {
  'use strict';
  var W = window, D = document;

  // ---------- helpers ----------
  function toRegex(s) {
    if (s === undefined || s === null || s === '') return null;
    s = String(s);
    var neg = false;
    if (s.charAt(0) === '!') { neg = true; s = s.slice(1); }
    var re;
    var last = s.lastIndexOf('/');
    if (s.length > 2 && s.charAt(0) === '/' && last > 0) {
      try { re = new RegExp(s.slice(1, last), s.slice(last + 1)); } catch (e) { return { test: function () { return false; } }; }
    } else {
      re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    return neg ? { test: function (t) { return !re.test(t); } } : re;
  }
  function hit(re, text) { return re === null || re.test(String(text)); }
  function safeFnString(fn) { try { return String(fn); } catch (e) { return ''; } }

  var CONSTANTS = {
    'undefined': undefined, 'false': false, 'true': true, 'null': null, '': '', 'emptyStr': '',
    'noopFunc': function () {}, 'trueFunc': function () { return true; }, 'falseFunc': function () { return false; },
    'emptyArr': [], '[]': [], 'emptyObj': {}, '{}': {}, 'yes': 'yes', 'no': 'no', 'NaN': NaN,
    'Infinity': Infinity, '-1': -1, 'on': 'on', 'off': 'off',
    'noopCallbackFunc': function () { return function () {}; },
    'noopArray': function () { return []; }, 'noopObject': function () { return {}; },
    'throwFunc': function () { throw new Error('Blocked by content filter'); },
    'noopPromiseResolve': function () { return Promise.resolve(new Response('')); },
    'noopPromiseReject': function () { return Promise.reject(new Error('Blocked by content filter')); }
  };
  function constValue(raw) {
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, raw)) {
      var v = CONSTANTS[raw];
      if (raw === 'emptyArr' || raw === '[]') return { ok: true, v: [] };
      if (raw === 'emptyObj' || raw === '{}') return { ok: true, v: {} };
      return { ok: true, v: v };
    }
    if (/^-?\d{1,5}$/.test(raw)) return { ok: true, v: parseInt(raw, 10) };
    return { ok: false };
  }

  // Install `leaf(owner, prop)` at the end of a property chain like "a.b.c",
  // waiting for intermediate objects that don't exist yet.
  function onChain(chain, leaf) {
    var parts = String(chain).split('.');
    (function walk(owner, i) {
      var prop = parts[i];
      if (i === parts.length - 1) { leaf(owner, prop); return; }
      var cur;
      try { cur = owner[prop]; } catch (e) { return; }
      if (cur !== null && (typeof cur === 'object' || typeof cur === 'function')) { walk(cur, i + 1); return; }
      // Several chains can wait on the same missing property (e.g. a.x and a.y):
      // keep an earlier waiter's setter and pass assignments on to it too.
      var prev;
      try { prev = Object.getOwnPropertyDescriptor(owner, prop); } catch (e) {}
      var prevSet = prev && typeof prev.set === 'function' ? prev.set : null;
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          get: function () { return cur; },
          set: function (v) {
            cur = v;
            if (prevSet) { try { prevSet.call(this, v); } catch (e) {} }
            if (v !== null && (typeof v === 'object' || typeof v === 'function')) walk(v, i + 1);
          }
        });
      } catch (e) {}
    })(W, 0);
  }

  function onReady(fn) {
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', fn, { once: true }); else fn();
  }
  function observe(fn) {
    var pending = false;
    var run = function () { pending = false; try { fn(); } catch (e) {} };
    onReady(function () {
      run();
      new MutationObserver(function () {
        if (!pending) { pending = true; setTimeout(run, 50); }
      }).observe(D.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function abortError() { return new ReferenceError('Blocked by content filter'); }

  // ---------- scriptlets ----------
  var S = {};

  S['set-constant'] = function (chain, raw) {
    var c = constValue(String(raw));
    if (!c.ok) return;
    onChain(chain, function (owner, prop) {
      try {
        Object.defineProperty(owner, prop, { configurable: true, get: function () { return c.v; }, set: function () {} });
      } catch (e) {}
    });
  };

  S['abort-on-property-read'] = function (chain) {
    onChain(chain, function (owner, prop) {
      try { Object.defineProperty(owner, prop, { configurable: true, get: function () { throw abortError(); }, set: function () {} }); } catch (e) {}
    });
  };

  S['abort-on-property-write'] = function (chain) {
    onChain(chain, function (owner, prop) {
      try { Object.defineProperty(owner, prop, { configurable: true, get: function () { return undefined; }, set: function () { throw abortError(); } }); } catch (e) {}
    });
  };

  S['abort-current-script'] = function (chain, needle) {
    var re = toRegex(needle);
    var check = function () {
      var s = D.currentScript;
      if (!s) return;
      var text = s.src || s.textContent || '';
      if (hit(re, text)) throw abortError();
    };
    onChain(chain, function (owner, prop) {
      var value;
      try { value = owner[prop]; } catch (e) {}
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          get: function () { check(); return value; },
          set: function (v) { check(); value = v; }
        });
      } catch (e) {}
    });
  };

  function timerDefuser(name) {
    return function (needle, delay) {
      var re = toRegex(needle);
      var delayNeg = typeof delay === 'string' && delay.charAt(0) === '!';
      var delayNum = delay !== undefined && delay !== '' ? parseInt(delayNeg ? delay.slice(1) : delay, 10) : NaN;
      var orig = W[name];
      W[name] = new Proxy(orig, {
        apply: function (target, thisArg, args) {
          var fnText = typeof args[0] === 'function' ? safeFnString(args[0]) : String(args[0]);
          var d = Number(args[1]) || 0;
          var delayOk = isNaN(delayNum) || (delayNeg ? d !== delayNum : d === delayNum);
          if (hit(re, fnText) && delayOk) { args[0] = function () {}; }
          return Reflect.apply(target, thisArg, args);
        }
      });
    };
  }
  S['prevent-setTimeout'] = timerDefuser('setTimeout');
  S['prevent-setInterval'] = timerDefuser('setInterval');

  S['prevent-addEventListener'] = function (type, needle) {
    var typeRe = toRegex(type), re = toRegex(needle);
    var proto = W.EventTarget && W.EventTarget.prototype;
    if (!proto) return;
    proto.addEventListener = new Proxy(proto.addEventListener, {
      apply: function (t, target, args) {
        var handler = args[1];
        var text = typeof handler === 'function' ? safeFnString(handler) : (handler && handler.handleEvent ? safeFnString(handler.handleEvent) : '');
        if (hit(typeRe, args[0]) && hit(re, text)) return undefined;
        return Reflect.apply(t, target, args);
      }
    });
  };

  S['prevent-window-open'] = function (needle) {
    var re = toRegex(needle);
    W.open = new Proxy(W.open, {
      apply: function (t, thisArg, args) {
        if (re === null || re.test(String(args[0] || ''))) {
          return { closed: false, close: function () {}, focus: function () {}, blur: function () {}, postMessage: function () {} };
        }
        return Reflect.apply(t, thisArg, args);
      }
    });
  };

  function prunePath(obj, path) {
    var parts = path.split('.'), changed = false;
    (function rec(o, i) {
      if (o === null || typeof o !== 'object') return;
      var p = parts[i];
      if (p === '[]') { if (Array.isArray(o)) o.forEach(function (x) { rec(x, i + 1); }); return; }
      if (i === parts.length - 1) { if (Object.prototype.hasOwnProperty.call(o, p)) { try { delete o[p]; changed = true; } catch (e) {} } return; }
      rec(o[p], i + 1);
    })(obj, 0);
    return changed;
  }
  function hasPath(obj, path) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length; i++) {
      if (o === null || typeof o !== 'object' || !(parts[i] in o)) return false;
      o = o[parts[i]];
    }
    return true;
  }
  S['json-prune'] = function (toRemove, required) {
    var prune = makePruner(toRemove, required);
    var wrap = function (obj) { try { prune(obj); } catch (e) {} return obj; };
    JSON.parse = new Proxy(JSON.parse, { apply: function (t, thisArg, args) { return wrap(Reflect.apply(t, thisArg, args)); } });
    if (W.Response) {
      Response.prototype.json = new Proxy(Response.prototype.json, {
        apply: function (t, thisArg, args) { return Reflect.apply(t, thisArg, args).then(wrap); }
      });
    }
  };

  S['remove-attr'] = function (attrs, selector) {
    var list = String(attrs || '').split('|').filter(Boolean);
    if (!list.length) return;
    var sel = selector || list.map(function (a) { return '[' + a + ']'; }).join(',');
    observe(function () {
      D.querySelectorAll(sel).forEach(function (el) { list.forEach(function (a) { el.removeAttribute(a); }); });
    });
  };

  S['remove-class'] = function (classes, selector) {
    var list = String(classes || '').split('|').filter(Boolean);
    if (!list.length) return;
    var sel = selector || list.map(function (c) { return '.' + CSS.escape(c); }).join(',');
    observe(function () {
      D.querySelectorAll(sel).forEach(function (el) { list.forEach(function (c) { el.classList.remove(c); }); });
    });
  };

  S['nowebrtc'] = function () {
    var Fake = function () {
      return {
        close: function () {}, createDataChannel: function () { return {}; },
        createOffer: function () { return Promise.reject(new DOMException('Blocked', 'NotAllowedError')); },
        setLocalDescription: function () { return Promise.resolve(); },
        addEventListener: function () {}, removeEventListener: function () {}
      };
    };
    ['RTCPeerConnection', 'webkitRTCPeerConnection'].forEach(function (n) { if (W[n]) W[n] = Fake; });
  };

  // ---------- request / response helpers ----------
  var nativeParse = JSON.parse, nativeStringify = JSON.stringify;

  // propsToMatch: "url:/re/ method:POST" pairs, or a plain URL needle.
  function parseProps(raw) {
    raw = String(raw === undefined || raw === null ? '' : raw).trim();
    if (raw === '' || raw === '*') return {};
    var parts = raw.split(/\s+/), out = {};
    var paired = parts.every(function (p) { var m = /^([a-zA-Z]+):/.exec(p); return m && m[1] !== 'http' && m[1] !== 'https' && m[1] !== 'data'; });
    if (!paired) return { url: toRegex(raw) };
    parts.forEach(function (p) { var i = p.indexOf(':'); out[p.slice(0, i)] = toRegex(p.slice(i + 1)); });
    return out;
  }
  function matchProps(props, details) {
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var v = details[k];
      if (!hit(props[k], v === undefined || v === null ? '' : v)) return false;
    }
    return true;
  }
  function namedArgs(arr, from) {
    var o = {};
    for (var i = from; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1];
    return o;
  }
  function fetchDetails(args) {
    var a = args[0], o = args[1] || {};
    var url = a && typeof a === 'object' && 'url' in a ? a.url : String(a);
    var method = o.method || (a && typeof a === 'object' && a.method) || 'GET';
    return { url: url, method: String(method).toUpperCase(), body: typeof o.body === 'string' ? o.body : '' };
  }
  function cloneResponse(resp, body) {
    var r;
    try { r = new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers }); } catch (e) { return resp; }
    try { Object.defineProperties(r, { url: { value: resp.url }, type: { value: resp.type }, redirected: { value: resp.redirected } }); } catch (e) {}
    return r;
  }
  // Rewrite the text of matching fetch() responses. transform(text) → new text, or null to keep.
  function hookFetchText(props, transform) {
    if (!W.fetch) return;
    W.fetch = new Proxy(W.fetch, {
      apply: function (t, thisArg, args) {
        var p = Reflect.apply(t, thisArg, args);
        var d;
        try { d = fetchDetails(args); } catch (e) { return p; }
        if (!matchProps(props, d)) return p;
        return p.then(function (resp) {
          return resp.clone().text().then(function (text) {
            var out;
            try { out = transform(text); } catch (e) { out = null; }
            return typeof out === 'string' && out !== text ? cloneResponse(resp, out) : resp;
          }, function () { return resp; });
        });
      }
    });
  }
  // Same for XMLHttpRequest (response / responseText getters).
  var xhrInfo = new WeakMap(), xhrTransforms = [], xhrHooked = false;
  function hookXhrText(props, transform) {
    xhrTransforms.push([props, transform]);
    if (xhrHooked) return;
    xhrHooked = true;
    var P = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (!P) return;
    P.open = new Proxy(P.open, {
      apply: function (t, xhr, args) {
        xhrInfo.set(xhr, { method: String(args[0] || 'GET').toUpperCase(), url: String(args[1]) });
        return Reflect.apply(t, xhr, args);
      }
    });
    var rtD = Object.getOwnPropertyDescriptor(P, 'responseText'), rD = Object.getOwnPropertyDescriptor(P, 'response');
    if (!rtD || !rD || !rtD.get || !rD.get) return;
    var transformText = function (xhr, text) {
      var info = xhrInfo.get(xhr);
      if (!info || xhr.readyState !== 4 || typeof text !== 'string') return text;
      if (info.inText === text) return info.outText;
      var out = text;
      xhrTransforms.forEach(function (tr) {
        if (!matchProps(tr[0], info)) return;
        var v;
        try { v = tr[1](out); } catch (e) { v = null; }
        if (typeof v === 'string') out = v;
      });
      info.inText = text; info.outText = out;
      return out;
    };
    Object.defineProperty(P, 'responseText', { configurable: true, enumerable: true, get: function () { return transformText(this, rtD.get.call(this)); } });
    Object.defineProperty(P, 'response', {
      configurable: true, enumerable: true,
      get: function () {
        var v = rD.get.call(this), type = this.responseType;
        if (type === '' || type === 'text') return transformText(this, v);
        if (type === 'json' && v !== null && typeof v === 'object') {
          var info = xhrInfo.get(this);
          if (!info || !xhrTransforms.some(function (tr) { return matchProps(tr[0], info); })) return v;
          if (info.inJson === v) return info.outJson;
          var s = nativeStringify(v), o = transformText(this, s), res = v;
          if (o !== s) { try { res = nativeParse(o); } catch (e) {} }
          info.inJson = v; info.outJson = res;
          return res;
        }
        return v;
      }
    });
  }
  // `/re/flags` or literal string replacement (every occurrence).
  function replaceText(text, pattern, replacement) {
    if (pattern === '*') return replacement;
    var s = String(pattern), last = s.lastIndexOf('/');
    if (s.length > 2 && s.charAt(0) === '/' && last > 0) {
      try { return text.replace(new RegExp(s.slice(1, last), s.slice(last + 1)), replacement); } catch (e) { return text; }
    }
    return s === '' ? text : text.split(s).join(replacement);
  }

  function makePruner(toRemove, required) {
    var removes = String(toRemove || '').split(/\s+/).filter(Boolean);
    var needs = String(required || '').split(/\s+/).filter(Boolean);
    return function (obj) {
      if (!removes.length || obj === null || typeof obj !== 'object') return false;
      if (!needs.every(function (n) { return hasPath(obj, n); })) return false;
      var changed = false;
      removes.forEach(function (p) { if (prunePath(obj, p)) changed = true; });
      return changed;
    };
  }

  // ---------- timers / eval ----------
  function timerBooster(name) {
    return function (needle, delay, boost) {
      var re = toRegex(needle === '*' ? '' : needle);
      var d = delay === undefined || delay === '' ? 1000 : (delay === '*' ? null : parseInt(delay, 10));
      var b = parseFloat(boost);
      if (isNaN(b)) b = 0.05;
      b = Math.min(50, Math.max(0.001, b));
      W[name] = new Proxy(W[name], {
        apply: function (t, thisArg, args) {
          var text = typeof args[0] === 'function' ? safeFnString(args[0]) : String(args[0]);
          if (hit(re, text) && (d === null || Number(args[1]) === d)) args[1] = (Number(args[1]) || 0) * b;
          return Reflect.apply(t, thisArg, args);
        }
      });
    };
  }
  S['adjust-setTimeout'] = timerBooster('setTimeout');
  S['adjust-setInterval'] = timerBooster('setInterval');

  S['prevent-requestAnimationFrame'] = function (needle) {
    var re = toRegex(needle);
    if (!W.requestAnimationFrame) return;
    W.requestAnimationFrame = new Proxy(W.requestAnimationFrame, {
      apply: function (t, thisArg, args) {
        if (hit(re, typeof args[0] === 'function' ? safeFnString(args[0]) : String(args[0]))) args[0] = function () {};
        return Reflect.apply(t, thisArg, args);
      }
    });
  };

  S['prevent-eval-if'] = function (needle) {
    var re = toRegex(needle);
    W.eval = new Proxy(W.eval, {
      apply: function (t, thisArg, args) {
        if (hit(re, String(args[0]))) return undefined;
        return Reflect.apply(t, thisArg, args);
      }
    });
  };

  // Stack of the code touching a property, minus our own frames.
  function callerStack() {
    var lines = String(new Error().stack || '').split('\n');
    // V8 starts with an "Error" header line; Firefox/Safari don't.
    if (lines.length && !/@|^\s*at /.test(lines[0])) lines.shift();
    // Drop callerStack, check and the property getter/setter.
    return lines.slice(3).join('\n');
  }
  S['abort-on-stack-trace'] = function (chain, needle) {
    if (!chain || !needle) return;
    var page = location.href.split('#')[0];
    var test;
    if (needle === 'inlineScript') {
      test = function (st) { return st.split('\n').some(function (l) { var i = l.indexOf(page); return i >= 0 && /^:\d+/.test(l.slice(i + page.length)); }); };
    } else if (needle === 'injectedScript') {
      test = function (st) { return /<anonymous>|\beval\b|Function/.test(st); };
    } else {
      var re = toRegex(needle);
      test = function (st) { return hit(re, st); };
    }
    onChain(chain, function (owner, prop) {
      var value;
      try { value = owner[prop]; } catch (e) {}
      var check = function () { if (test(callerStack())) throw abortError(); };
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          get: function () { check(); return value; },
          set: function (v) { check(); value = v; }
        });
      } catch (e) {}
    });
  };

  // ---------- network responses ----------
  var SAFE_BODIES = { '': '', 'emptyStr': '', 'emptyObj': '{}', 'emptyArr': '[]', '{}': '{}', '[]': '[]', 'true': '', 'false': '' };
  function fakeFetch(propsRaw, body) {
    var props = parseProps(propsRaw);
    if (!W.fetch) return;
    W.fetch = new Proxy(W.fetch, {
      apply: function (target, thisArg, args) {
        var d;
        try { d = fetchDetails(args); } catch (e) { return Reflect.apply(target, thisArg, args); }
        if (!matchProps(props, d)) return Reflect.apply(target, thisArg, args);
        var r = new Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': /^[[{]/.test(body) ? 'application/json' : 'text/plain' } });
        try { Object.defineProperty(r, 'url', { value: d.url }); } catch (e) {}
        return Promise.resolve(r);
      }
    });
  }
  S['prevent-fetch'] = function (props, body) {
    var b = SAFE_BODIES[body === undefined ? '' : body];
    fakeFetch(props, b === undefined ? '' : b);
  };
  S['trusted-prevent-fetch'] = function (props, body) { fakeFetch(props, body === undefined ? '' : String(body)); };

  function fakeXhr(propsRaw, body) {
    var props = parseProps(propsRaw);
    var XHR = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (!XHR) return;
    var info = new WeakMap();
    XHR.open = new Proxy(XHR.open, {
      apply: function (t, xhr, args) { info.set(xhr, { method: String(args[0] || 'GET').toUpperCase(), url: String(args[1]) }); return Reflect.apply(t, xhr, args); }
    });
    XHR.send = new Proxy(XHR.send, {
      apply: function (t, xhr, args) {
        var d = info.get(xhr) || { url: '', method: 'GET' };
        d.body = typeof args[0] === 'string' ? args[0] : '';
        if (!matchProps(props, d)) return Reflect.apply(t, xhr, args);
        var type = xhr.responseType, resp = body;
        if (type === 'json') { try { resp = nativeParse(body || 'null'); } catch (e) { resp = null; } }
        else if (type === 'arraybuffer') resp = new ArrayBuffer(0);
        else if (type === 'blob') resp = new Blob([]);
        else if (type === 'document') resp = null;
        try {
          Object.defineProperties(xhr, {
            readyState: { value: 4, configurable: true }, status: { value: 200, configurable: true },
            statusText: { value: 'OK', configurable: true }, responseText: { value: typeof resp === 'string' ? resp : '', configurable: true },
            response: { value: resp, configurable: true }, responseURL: { value: d.url, configurable: true }
          });
        } catch (e) {}
        setTimeout(function () {
          ['readystatechange', 'load', 'loadend'].forEach(function (type) {
            try { xhr.dispatchEvent(new Event(type)); } catch (e) {}
          });
        }, 1);
      }
    });
  }
  S['prevent-xhr'] = function (props, body) {
    var b = SAFE_BODIES[body === undefined ? '' : body];
    fakeXhr(props, b === undefined ? '' : b);
  };
  S['trusted-prevent-xhr'] = function (props, body) { fakeXhr(props, body === undefined ? '' : String(body)); };

  function jsonTextPruner(toRemove, required) {
    var prune = makePruner(toRemove, required);
    return function (text) {
      var obj;
      try { obj = nativeParse(text); } catch (e) { return null; }
      return prune(obj) ? nativeStringify(obj) : null;
    };
  }
  S['json-prune-fetch-response'] = function (toRemove, required) {
    var named = namedArgs(arguments, 2);
    hookFetchText(parseProps(named.propsToMatch), jsonTextPruner(toRemove, required));
  };
  S['json-prune-xhr-response'] = function (toRemove, required) {
    var named = namedArgs(arguments, 2);
    hookXhrText(parseProps(named.propsToMatch), jsonTextPruner(toRemove, required));
  };

  function m3uPruner(pattern) {
    var s = String(pattern || ''), last = s.lastIndexOf('/'), whole = null, re = null;
    if (!s) return function () { return null; };
    if (s.length > 2 && s.charAt(0) === '/' && last > 0) {
      var flags = s.slice(last + 1);
      try {
        if (/[sm]/.test(flags)) whole = new RegExp(s.slice(1, last), flags.indexOf('g') >= 0 ? flags : flags + 'g');
        else re = new RegExp(s.slice(1, last), flags);
      } catch (e) { return function () { return null; }; }
    }
    return function (text) {
      if (!/^\s*#EXTM3U/.test(text)) return null;
      if (whole) return text.replace(whole, '');
      var lines = text.split('\n'), out = [];
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (re ? re.test(l) : l.indexOf(s) >= 0) {
          if (/^#EXTINF/.test(l)) i++;
          continue;
        }
        out.push(l);
      }
      return out.join('\n');
    };
  }
  S['m3u-prune'] = function (pattern, url) {
    var props = url ? { url: toRegex(url) } : {};
    hookFetchText(props, m3uPruner(pattern));
    hookXhrText(props, m3uPruner(pattern));
  };

  S['xml-prune'] = function (selector, check, url) {
    if (!selector || !W.DOMParser) return;
    var prune = function (text) {
      if (!/^\s*</.test(text)) return null;
      var doc = new DOMParser().parseFromString(text, 'text/xml');
      if (doc.querySelector('parsererror')) return null;
      var find = function (sel) {
        var m = /^xpath\((.*)\)$/.exec(sel);
        if (!m) { try { return Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch (e) { return []; } }
        var res = [];
        try {
          var it = doc.evaluate(m[1], doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (var i = 0; i < it.snapshotLength; i++) res.push(it.snapshotItem(i));
        } catch (e) {}
        return res;
      };
      if (check && !find(check).length) return null;
      var nodes = find(selector);
      if (!nodes.length) return null;
      nodes.forEach(function (n) {
        if (n.nodeType === 2 && n.ownerElement) n.ownerElement.removeAttribute(n.nodeName);
        else if (n.parentNode) n.parentNode.removeChild(n);
      });
      return new XMLSerializer().serializeToString(doc);
    };
    var props = url ? { url: toRegex(url) } : {};
    hookFetchText(props, prune);
    hookXhrText(props, prune);
  };

  S['trusted-replace-fetch-response'] = function (pattern, replacement, props) {
    if (pattern === undefined || pattern === '') return;
    hookFetchText(parseProps(props), function (text) { return replaceText(text, pattern, replacement || ''); });
  };
  S['trusted-replace-xhr-response'] = function (pattern, replacement, props) {
    if (pattern === undefined || pattern === '') return;
    hookXhrText(parseProps(props), function (text) { return replaceText(text, pattern, replacement || ''); });
  };

  // ---------- DOM text ----------
  function nodeNameTest(name) {
    var s = String(name || '');
    if (s.length > 2 && s.charAt(0) === '/' && s.lastIndexOf('/') > 0) { var re = toRegex(s); return function (n) { return re.test(n.nodeName.toLowerCase()); }; }
    s = s.toLowerCase();
    return function (n) { return n.nodeName.toLowerCase() === s; };
  }
  function nodeTextEditor(nodeName, pattern, replacement, extra) {
    if (!nodeName || pattern === undefined || pattern === '') return;
    var nameOk = nodeNameTest(nodeName), re = toRegex(pattern);
    var opts = namedArgs(extra || [], 0), cond = opts.condition ? toRegex(opts.condition) : null;
    var tag = /^[a-z][a-z0-9-]*$/i.test(nodeName) ? nodeName : null;
    var handle = function (n) {
      if (!nameOk(n)) return;
      var isText = n.nodeType === 3;
      var text = isText ? n.nodeValue : n.textContent;
      if (!text || !re.test(text) || (cond && !cond.test(text))) return;
      var out = replacement === null ? '' : replaceText(text, pattern, replacement);
      if (out === text) return;
      if (isText) n.nodeValue = out; else n.textContent = out;
    };
    var visit = function (n) {
      if (n.nodeType === 3) { if (n.parentNode && nameOk(n.parentNode)) handle(n.parentNode); else handle(n); return; }
      if (n.nodeType !== 1) return;
      handle(n);
      if (tag && n.firstElementChild) { try { n.querySelectorAll(tag).forEach(handle); } catch (e) {} }
    };
    try { if (tag) D.querySelectorAll(tag).forEach(handle); } catch (e) {}
    // Synchronous enough: the parser runs a microtask checkpoint before executing
    // a parser-inserted script, so its text is edited before it runs.
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') { visit(m.target); continue; }
        for (var j = 0; j < m.addedNodes.length; j++) visit(m.addedNodes[j]);
      }
    }).observe(D, { childList: true, subtree: true, characterData: true });
  }
  S['remove-node-text'] = function (nodeName, pattern) { nodeTextEditor(nodeName, pattern, null, Array.prototype.slice.call(arguments, 2)); };
  S['replace-node-text'] = function (nodeName, pattern, replacement) {
    nodeTextEditor(nodeName, pattern, replacement === undefined ? '' : replacement, Array.prototype.slice.call(arguments, 3));
  };

  // ---------- cookies & storage ----------
  var SAFE_VALUE = /^(?:true|false|yes|no|y|n|ok|on|off|accept|accepted|reject|rejected|allow|allowed|disallow|deny|denied|necessary|essential|nonessential|hide|hidden|checked|unchecked|forbidden|forever|dismiss|dismissed|enable|enabled|disable|disabled|null|undefined|-1|\d{1,5}|)$/i;
  function specialValue(v) {
    if (v === '$now$') return String(Date.now());
    if (v === '$currentDate$') return String(new Date());
    if (v === '$currentISODate$') return new Date().toISOString();
    return v;
  }
  function getCookie(name) {
    var parts = D.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim(), eq = p.indexOf('=');
      if ((eq < 0 ? p : p.slice(0, eq)) === name) return eq < 0 ? '' : p.slice(eq + 1);
    }
    return null;
  }
  function expiresAttr(raw) {
    if (!raw) return '';
    var secs = raw === '1day' ? 86400 : raw === '1year' ? 31536000 : parseInt(raw, 10);
    return isNaN(secs) || secs <= 0 ? '' : '; max-age=' + Math.min(secs, 400 * 86400);
  }
  function writeCookie(name, value, path, expires, domain) {
    if (!name || /[;=\s]/.test(name)) return false;
    if (getCookie(name) === value) return false;
    var p = path === undefined || path === '' ? '/' : path;
    var c = name + '=' + value + (p === 'none' ? '' : (p.charAt(0) === '/' ? '; path=' + p : '; path=/')) + expiresAttr(expires);
    if (domain) {
      var d = String(domain).replace(/^\./, '');
      if (location.hostname === d || location.hostname.slice(-d.length - 1) === '.' + d) c += '; domain=' + d;
    }
    try { D.cookie = c; } catch (e) { return false; }
    return getCookie(name) === value;
  }
  S['set-cookie'] = function (name, value, path, domain) {
    if (!SAFE_VALUE.test(String(value))) return;
    writeCookie(name, encodeURIComponent(String(value)), path, '', domain);
  };
  S['set-cookie-reload'] = function (name, value, path, domain) {
    if (!SAFE_VALUE.test(String(value))) return;
    if (writeCookie(name, encodeURIComponent(String(value)), path, '', domain)) location.reload();
  };
  S['trusted-set-cookie'] = function (name, value, expires, path, domain) {
    if (value === undefined) return;
    writeCookie(name, specialValue(String(value)), path, expires, domain);
  };
  S['trusted-set-cookie-reload'] = function (name, value, expires, path, domain) {
    if (value === undefined) return;
    if (writeCookie(name, specialValue(String(value)), path, expires, domain)) location.reload();
  };
  S['remove-cookie'] = function (needle) {
    var re = toRegex(needle);
    var remove = function () {
      D.cookie.split(';').forEach(function (p) {
        var name = p.split('=')[0].trim();
        if (!name || !hit(re, name)) return;
        var host = location.hostname.split('.'), past = '=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        var paths = ['/', location.pathname];
        for (var i = 0; i < host.length - 1; i++) {
          var dom = host.slice(i).join('.');
          paths.forEach(function (pa) {
            try { D.cookie = name + past + '; path=' + pa; D.cookie = name + past + '; path=' + pa + '; domain=' + dom; D.cookie = name + past + '; path=' + pa + '; domain=.' + dom; } catch (e) {}
          });
        }
      });
    };
    remove();
    W.addEventListener('beforeunload', remove);
    D.addEventListener('visibilitychange', function () { if (D.visibilityState === 'hidden') remove(); });
  };

  function storageValue(raw, trusted) {
    var map = { 'undefined': 'undefined', 'false': 'false', 'true': 'true', 'null': 'null', '': '', 'emptyArr': '[]', 'emptyObj': '{}', '[]': '[]', '{}': '{}' };
    if (Object.prototype.hasOwnProperty.call(map, raw)) return map[raw];
    if (trusted) return specialValue(raw);
    return SAFE_VALUE.test(raw) ? raw : null;
  }
  function setStorageItem(kind, key, value, trusted) {
    if (!key) return;
    var store;
    try { store = W[kind]; } catch (e) { return; }
    if (!store) return;
    var raw = String(value === undefined ? '' : value);
    try {
      if (raw === '$remove$') {
        var re = toRegex(key);
        if (key.charAt(0) === '/') {
          var keys = [];
          for (var i = 0; i < store.length; i++) keys.push(store.key(i));
          keys.forEach(function (k) { if (re.test(k)) store.removeItem(k); });
        } else store.removeItem(key);
        return;
      }
      var v = storageValue(raw, trusted);
      if (v !== null && store.getItem(key) !== v) store.setItem(key, v);
    } catch (e) {}
  }
  S['set-local-storage-item'] = function (k, v) { setStorageItem('localStorage', k, v, false); };
  S['set-session-storage-item'] = function (k, v) { setStorageItem('sessionStorage', k, v, false); };
  S['trusted-set-local-storage-item'] = function (k, v) { setStorageItem('localStorage', k, v, true); };
  S['trusted-set-session-storage-item'] = function (k, v) { setStorageItem('sessionStorage', k, v, true); };

  S['trusted-set-constant'] = function (chain, raw) {
    var s = String(raw === undefined ? '' : raw), c = constValue(s), v;
    if (c.ok) v = c.v;
    else if (/^-?\d+(\.\d+)?$/.test(s)) v = Number(s);
    else {
      try {
        v = nativeParse(s);
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'value' in v) v = v.value;
      } catch (e) { v = s; }
    }
    onChain(chain, function (owner, prop) {
      try { Object.defineProperty(owner, prop, { configurable: true, get: function () { return v; }, set: function () {} }); } catch (e) {}
    });
  };

  // ---------- attributes / links ----------
  function attrSetter(selector, attrs, value, trusted) {
    if (!selector || !attrs) return;
    var names = String(attrs).split('|').filter(function (a) { return a && !/^on/i.test(a) && /^[\w:-]+$/.test(a); });
    var raw = String(value === undefined ? '' : value);
    if (!names.length || /^\s*javascript:/i.test(raw)) return;
    var copy = /^\[([\w:-]+)\]$/.exec(raw);
    if (!trusted && !copy && !/^(?:|true|false|yes|no|on|off|-?\d{1,5})$/i.test(raw)) return;
    observe(function () {
      D.querySelectorAll(selector).forEach(function (el) {
        names.forEach(function (a) {
          var v = copy ? el.getAttribute(copy[1]) : raw;
          if (v !== null && !/^\s*javascript:/i.test(v) && el.getAttribute(a) !== v) el.setAttribute(a, v);
        });
      });
    });
  }
  S['set-attr'] = function (sel, attrs, value) { attrSetter(sel, attrs, value, false); };
  S['trusted-set-attr'] = function (sel, attrs, value) { attrSetter(sel, attrs, value, true); };

  S['href-sanitizer'] = function (selector, source) {
    if (!selector) return;
    var src = source || 'text';
    var valid = function (u) { try { var x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } };
    observe(function () {
      D.querySelectorAll(selector).forEach(function (a) {
        if (a.__hrefSanitized) return;
        var v = null;
        if (src === 'text') v = (a.textContent || '').trim();
        else if (/^\[[\w:-]+\]$/.test(src)) v = a.getAttribute(src.slice(1, -1));
        else if (src.charAt(0) === '?') { try { v = new URL(a.href, location.href).searchParams.get(src.slice(1)); } catch (e) {} }
        var u = v && valid(v);
        if (u) { a.setAttribute('href', u); a.__hrefSanitized = true; }
      });
    });
  };

  S['disable-newtab-links'] = function () {
    D.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
      if (a && a.getAttribute('target') !== '_self') a.removeAttribute('target');
    }, true);
  };

  // ---------- anti-adblock / popups ----------
  S['prevent-adblock-detector'] = function () {
    var Fake = function () {};
    var self = function () { return this; };
    Fake.prototype = {
      check: function () { return false; }, clearEvent: self, emitEvent: self, setOption: self, setOptions: self,
      onDetected: self, onNotDetected: function (fn) { if (typeof fn === 'function') setTimeout(fn, 1); return this; },
      on: function (detected, fn) { if (!detected && typeof fn === 'function') setTimeout(fn, 1); return this; }
    };
    var inst = new Fake();
    ['FuckAdBlock', 'BlockAdBlock', 'SniffAdBlock'].forEach(function (n) {
      try { Object.defineProperty(W, n, { configurable: true, get: function () { return Fake; }, set: function () {} }); } catch (e) {}
    });
    ['fuckAdBlock', 'blockAdBlock', 'sniffAdBlock'].forEach(function (n) {
      try { Object.defineProperty(W, n, { configurable: true, get: function () { return inst; }, set: function () {} }); } catch (e) {}
    });
  };

  S['popads-dummy'] = function () {
    var dummy = {};
    ['PopAds', 'popns'].forEach(function (n) {
      try { Object.defineProperty(W, n, { configurable: false, get: function () { return n === 'popns' ? 'PopAds' : dummy; }, set: function () {} }); } catch (e) {}
    });
  };

  var NEUTRAL_SRC = {
    script: 'data:text/javascript,(function(){})()', img: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    iframe: 'data:text/html,', link: 'data:text/css,'
  };
  S['prevent-element-src-loading'] = function (tagName, match) {
    var tag = String(tagName || '').toLowerCase(), re = toRegex(match);
    var neutral = NEUTRAL_SRC[tag];
    if (!neutral || re === null) return;
    var ctorName = { script: 'HTMLScriptElement', img: 'HTMLImageElement', iframe: 'HTMLIFrameElement', link: 'HTMLLinkElement' }[tag];
    var attr = tag === 'link' ? 'href' : 'src';
    var proto = W[ctorName] && W[ctorName].prototype;
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, attr);
    if (d && d.set) {
      Object.defineProperty(proto, attr, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) { return d.set.call(this, re.test(String(v)) ? neutral : v); }
      });
    }
    var EP = W.Element.prototype;
    EP.setAttribute = new Proxy(EP.setAttribute, {
      apply: function (t, el, args) {
        if (el instanceof W[ctorName] && String(args[0]).toLowerCase() === attr && re.test(String(args[1]))) args[1] = neutral;
        return Reflect.apply(t, el, args);
      }
    });
  };

  S['spoof-css'] = function (selector) {
    if (!selector || !W.getComputedStyle) return;
    var spoof = {};
    for (var i = 1; i + 1 < arguments.length; i += 2) {
      var prop = String(arguments[i]).trim().replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
      spoof[prop] = String(arguments[i + 1]);
    }
    var kebab = function (p) { return p.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); };
    W.getComputedStyle = new Proxy(W.getComputedStyle, {
      apply: function (t, thisArg, args) {
        var style = Reflect.apply(t, thisArg, args), el = args[0];
        var match = false;
        try { match = el instanceof W.Element && el.matches(selector); } catch (e) {}
        if (!match) return style;
        return new Proxy(style, {
          get: function (target, key) {
            if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(spoof, key)) return spoof[key];
            if (key === 'getPropertyValue') {
              return function (p) {
                var camel = String(p).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
                return Object.prototype.hasOwnProperty.call(spoof, camel) ? spoof[camel] : target.getPropertyValue(p);
              };
            }
            var v = Reflect.get(target, key, target);
            return typeof v === 'function' ? v.bind(target) : v;
          }
        });
      }
    });
    void kebab;
  };

  // Split a selector list on top-level commas.
  function splitSelectorList(s) {
    var out = [], cur = '', depth = 0, q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) { cur += c; if (c === '\\') { cur += s.charAt(++i); } else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  // `a >>> b`: b inside a's shadow root.
  function queryDeep(sel) {
    var parts = sel.split(/\s*>>>\s*/), root = D, el = null;
    for (var i = 0; i < parts.length; i++) {
      try { el = root.querySelector(parts[i]); } catch (e) { return null; }
      if (!el) return null;
      if (i < parts.length - 1) { root = el.shadowRoot; if (!root) return null; }
    }
    return el;
  }
  // Accept / agree / allow-all wording (several languages), unless it is
  // really a reject or necessary-only choice ("accept necessary only").
  var ACCEPT_RE = /\b(?:accept(?:er|ar|eren|era|ă)?|accetta|aceptar|akzeptieren|annehmen|zustimmen|agree|allow all|allow cookies|alle (?:akzeptieren|zulassen|erlauben)|tout accepter|j'accepte|i accept|got it|einverstanden|consent(?:ir)?|akceptuj\w*|zgadzam|souhlas\w*|godkänn|hyväksy\w*|toestaan|akkoord)\b/i;
  var REJECT_RE = /\b(?:reject|decline|refuse|deny|necessary|essential|only|without|nur|notwendig|ablehnen|refuser|rechazar|rifiuta|weiger|odrzu\w*|opt.?out|disagree|do not|don't|save|settings|preferences|manage|customi[sz]e|einstellungen|paramètres)\b/i;
  function readsAsAccept(el) {
    var text = [el.textContent, el.getAttribute && el.getAttribute('aria-label'), el.value, el.title].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return ACCEPT_RE.test(text) && !REJECT_RE.test(text);
  }

  S['trusted-click-element'] = function (selectors, extraMatch, delay) {
    var list = splitSelectorList(String(selectors || ''));
    if (!list.length) return;
    var needText = null;
    var extras = String(extraMatch || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    for (var i = 0; i < extras.length; i++) {
      var m = /^(cookie|localStorage|containsText):(.*)$/.exec(extras[i]);
      if (!m) return;
      if (m[1] === 'containsText') { needText = m[2]; continue; }
      var kv = m[2].split('='), key = kv[0], val = kv.length > 1 ? kv.slice(1).join('=') : null, have;
      if (m[1] === 'cookie') have = getCookie(key); else { try { have = W.localStorage.getItem(key); } catch (e) { have = null; } }
      if (have === null || (val !== null && have !== val)) return;
    }
    var wait = Math.min(10000, Math.max(0, parseInt(delay, 10) || 0));
    var idx = 0, busy = false, done = false, mo = null;
    var deadline = Date.now() + 10000 + wait;
    var finish = function () { done = true; if (mo) mo.disconnect(); };
    var step = function () {
      if (done || busy) return;
      if (idx >= list.length || Date.now() > deadline) { finish(); return; }
      var el = queryDeep(list[idx]);
      if (!el || (needText && (el.textContent || '').indexOf(needText) < 0)) return;
      // Owner's rule: never click anything that reads as accepting consent.
      if (readsAsAccept(el)) { finish(); return; }
      busy = true;
      setTimeout(function () {
        try { el.click(); } catch (e) {}
        idx++; busy = false;
        if (idx >= list.length) finish(); else step();
      }, idx === 0 ? wait : 50);
    };
    onReady(function () {
      step();
      if (done) return;
      mo = new MutationObserver(step);
      mo.observe(D.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(finish, 10000 + wait);
    });
  };

  // ---------- function wrappers (trusted lists only, except where noted) ----------
  // Resolve "a.b.c" to [owner, prop]; null if the chain doesn't exist yet.
  function resolveChain(path) {
    var parts = String(path || '').split('.'), owner = W;
    if (parts[0] === 'window') parts.shift();
    for (var i = 0; i < parts.length - 1; i++) {
      try { owner = owner[parts[i]]; } catch (e) { return null; }
      if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) return null;
    }
    return parts.length ? [owner, parts[parts.length - 1]] : null;
  }
  // Wrap the function at `path`: wrapper(target, thisArg, args) does the call.
  function wrapFunction(path, wrapper) {
    var r = resolveChain(path);
    if (!r) return;
    var fn;
    try { fn = r[0][r[1]]; } catch (e) { return; }
    if (typeof fn !== 'function') return;
    try { r[0][r[1]] = new Proxy(fn, { apply: function (t, thisArg, args) { return wrapper(t, thisArg, args); } }); } catch (e) {}
  }
  function literalValue(raw) {
    var s = String(raw === undefined ? '' : raw), c = constValue(s);
    if (c.ok) return c.v;
    if (s.indexOf('json:') === 0) { try { return nativeParse(s.slice(5)); } catch (e) { return undefined; } }
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  }
  // "/re/repl/flags" (as in `repl:/a/b/`).
  function parseRepl(s) {
    var m = /^\/((?:\\.|[^\/])*)\/((?:\\.|[^\/])*)\/([a-z]*)$/.exec(s);
    if (!m) return null;
    try { return [new RegExp(m[1], m[3]), m[2]]; } catch (e) { return null; }
  }

  S['trusted-replace-argument'] = function (path, pos, raw) {
    var named = namedArgs(arguments, 3), cond = named.condition ? toRegex(named.condition) : null;
    var repl = String(raw || '').indexOf('repl:') === 0 ? parseRepl(String(raw).slice(5)) : null;
    if (String(raw || '').indexOf('repl:') === 0 && !repl) return;
    wrapFunction(path, function (t, thisArg, args) {
      var useThis = pos === 'this', i = parseInt(pos, 10);
      if (!useThis && (isNaN(i) || i < 0)) return Reflect.apply(t, thisArg, args);
      var cur = useThis ? thisArg : args[i];
      if (cond && !cond.test(String(cur))) return Reflect.apply(t, thisArg, args);
      var next = repl ? String(cur).replace(repl[0], repl[1]) : literalValue(raw);
      if (useThis) return Reflect.apply(t, typeof thisArg === 'string' ? String(next) : next, args);
      args = Array.prototype.slice.call(args);
      args[i] = next;
      return Reflect.apply(t, thisArg, args);
    });
  };

  S['trusted-replace-outbound-text'] = function (path, pattern, replacement) {
    var named = namedArgs(arguments, 3), cond = named.condition ? toRegex(named.condition) : null;
    if (!pattern) return;
    wrapFunction(path, function (t, thisArg, args) {
      var out = Reflect.apply(t, thisArg, args);
      if (typeof out !== 'string' || (cond && !cond.test(out))) return out;
      return replaceText(out, pattern, replacement === undefined ? '' : replacement);
    });
  };

  // Each `|`-separated part matches one argument: /regex/, '*' or '' (any), or the literal text.
  S['trusted-suppress-native-method'] = function (path, signature, how) {
    var sig = String(signature || '').split('|').map(function (p) {
      if (p === '' || p === '*') return function () { return true; };
      var re = p.length > 2 && p.charAt(0) === '/' && p.lastIndexOf('/') > 0 ? toRegex(p) : null;
      var lit = p.replace(/^(['"])(.*)\1$/, '$2');
      return function (v) {
        var s = typeof v === 'string' ? v : (v instanceof W.Element ? v.outerHTML.slice(0, 200) : (function () { try { return nativeStringify(v); } catch (e) { return String(v); } })());
        return re ? re.test(s) : (s === lit || String(v) === lit);
      };
    });
    wrapFunction(path, function (t, thisArg, args) {
      if (sig.every(function (m, i) { return m(args[i]); })) {
        if (how === 'abort' || how === undefined || how === '') throw abortError();
        return undefined;
      }
      return Reflect.apply(t, thisArg, args);
    });
  };

  S['trusted-override-element-method'] = function (path, selector, disposition) {
    if (!selector) return;
    wrapFunction(path, function (t, thisArg, args) {
      var match = false;
      try { match = thisArg instanceof W.Element && thisArg.matches(selector); } catch (e) {}
      if (!match) return Reflect.apply(t, thisArg, args);
      if (disposition === 'throw') throw abortError();
      return disposition === undefined || disposition === '' ? undefined : literalValue(disposition);
    });
  };

  // Keep pages from fetching pristine natives from a fresh iframe.
  S['trusted-prevent-dom-bypass'] = function (path, target) {
    var props = target ? [target] : ['fetch', 'XMLHttpRequest', 'open', 'setTimeout', 'setInterval', 'eval', 'JSON.parse'];
    var patch = function (frame) {
      var win;
      try { win = frame.contentWindow; } catch (e) { return; }
      if (!win || win === W) return;
      props.forEach(function (p) {
        var src = resolveChain(p), dst;
        if (!src) return;
        var parts = p.split('.'), owner = win;
        for (var i = 0; i < parts.length - 1 && owner; i++) { try { owner = owner[parts[i]]; } catch (e) { owner = null; } }
        if (!owner) return;
        try { dst = src[0][src[1]]; owner[parts[parts.length - 1]] = dst; } catch (e) {}
      });
    };
    wrapFunction(path, function (t, thisArg, args) {
      var out = Reflect.apply(t, thisArg, args);
      for (var i = 0; i < args.length; i++) {
        var n = args[i];
        if (!n || n.nodeType !== 1) continue;
        if (n.tagName === 'IFRAME') patch(n);
        else if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll('iframe'), patch);
      }
      return out;
    });
  };

  S['trusted-create-html'] = function (parentSelector, html, duration) {
    if (!parentSelector || !html || !W.DOMParser) return;
    onReady(function () {
      var parent = D.querySelector(parentSelector);
      if (!parent) return;
      // DOMParser output is inert: scripts in it never run.
      var nodes = Array.prototype.slice.call(new DOMParser().parseFromString(String(html), 'text/html').body.childNodes);
      nodes.forEach(function (n) { parent.appendChild(n); });
      var ms = parseInt(duration, 10);
      if (ms > 0) setTimeout(function () { nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); }); }, ms);
    });
  };

  S['prevent-innerHTML'] = function (selector, pattern) {
    var re = toRegex(pattern), P = W.Element && W.Element.prototype;
    var d = P && Object.getOwnPropertyDescriptor(P, 'innerHTML');
    if (!d || !d.set) return;
    Object.defineProperty(P, 'innerHTML', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) {
        var m = true;
        if (selector) { try { m = this.matches(selector); } catch (e) { m = false; } }
        if (m && hit(re, String(v))) return;
        return d.set.call(this, v);
      }
    });
  };

  // ---------- json-edit (a small JSONPath subset) ----------
  // Paths: `..key` (any depth), `.key`, `.*` / `[*]`, `[?.k=="v"]` / `[?.k]` filters,
  // optionally ending in `=json` (assignment: trusted lists only).
  function parseJsonq(q) {
    var steps = [], i = 0, s = String(q || '').trim(), assign;
    var eq = -1, depth = 0, quote = null;
    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      if (quote) { if (ch === '\\') k++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '=' && depth === 0 && s.charAt(k - 1) !== '=' && s.charAt(k + 1) !== '=') { eq = k; break; }
    }
    if (eq >= 0) { try { assign = { v: nativeParse(s.slice(eq + 1)) }; } catch (e) { return null; } s = s.slice(0, eq); }
    if (s.charAt(0) !== '.') s = '.' + s;
    while (i < s.length) {
      var m;
      if ((m = /^\.\.([\w$-]+|\*)/.exec(s.slice(i)))) { steps.push(['desc', m[1]]); i += m[0].length; continue; }
      if ((m = /^\.([\w$-]+|\*)/.exec(s.slice(i)))) { steps.push(['child', m[1]]); i += m[0].length; continue; }
      if ((m = /^\[\*\]/.exec(s.slice(i)))) { steps.push(['child', '*']); i += m[0].length; continue; }
      if ((m = /^\[\?\.([\w$.-]+)\s*(?:(==|!=|\^=|\$=|\*=)\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[\w.-]+))?\]/.exec(s.slice(i)))) {
        var val;
        if (m[3] !== undefined) { try { val = nativeParse(m[3].charAt(0) === "'" ? '"' + m[3].slice(1, -1).replace(/"/g, '\\"') + '"' : m[3]); } catch (e) { val = m[3]; } }
        steps.push(['filter', m[1], m[2], val]); i += m[0].length; continue;
      }
      return null;
    }
    return { steps: steps, assign: assign };
  }
  function jsonqMatches(root, steps) {
    var cur = [{ p: null, k: null, v: root }];
    var kids = function (o) { var out = []; if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { out.push({ p: o, k: k, v: o[k] }); }); return out; };
    steps.forEach(function (st) {
      var next = [];
      if (st[0] === 'child') cur.forEach(function (m) { kids(m.v).forEach(function (c) { if (st[1] === '*' || c.k === st[1]) next.push(c); }); });
      else if (st[0] === 'desc') {
        var walk = function (m, d) { if (d > 64) return; kids(m.v).forEach(function (c) { if (st[1] === '*' || c.k === st[1]) next.push(c); walk(c, d + 1); }); };
        cur.forEach(function (m) { walk(m, 0); });
      } else {
        next = cur.filter(function (m) {
          var v = m.v;
          st[1].split('.').forEach(function (k) { v = v !== null && typeof v === 'object' ? v[k] : undefined; });
          if (st[2] === undefined) return v !== undefined;
          var a = String(v), b = String(st[3]);
          return st[2] === '==' ? v === st[3] : st[2] === '!=' ? v !== st[3] : st[2] === '^=' ? a.indexOf(b) === 0 : st[2] === '$=' ? a.slice(-b.length) === b : a.indexOf(b) >= 0;
        });
      }
      cur = next;
    });
    return cur;
  }
  function jsonEditor(q, trusted) {
    var parsed = parseJsonq(q);
    if (!parsed || (parsed.assign && !trusted)) return null;
    return function (obj) {
      if (obj === null || typeof obj !== 'object') return false;
      var hits = jsonqMatches(obj, parsed.steps).filter(function (m) { return m.p; });
      hits.reverse().forEach(function (m) {
        if (parsed.assign) m.p[m.k] = parsed.assign.v;
        else if (Array.isArray(m.p)) m.p.splice(Number(m.k), 1);
        else delete m.p[m.k];
      });
      return hits.length > 0;
    };
  }
  function jsonEdit(trusted) {
    return function (q) {
      var edit = jsonEditor(q, trusted), named = namedArgs(arguments, 1), need = named.matches ? toRegex(named.matches) : null;
      if (!edit) return;
      JSON.parse = new Proxy(JSON.parse, {
        apply: function (t, thisArg, args) {
          var obj = Reflect.apply(t, thisArg, args);
          if (!need || need.test(String(args[0]))) { try { edit(obj); } catch (e) {} }
          return obj;
        }
      });
    };
  }
  function jsonEditResponse(hook, trusted) {
    return function (q, props) {
      var edit = jsonEditor(q, trusted);
      if (!edit) return;
      hook(parseProps(props), function (text) {
        var obj;
        try { obj = nativeParse(text); } catch (e) { return null; }
        return edit(obj) ? nativeStringify(obj) : null;
      });
    };
  }
  S['json-edit'] = jsonEdit(false);
  S['trusted-json-edit'] = jsonEdit(true);
  S['json-edit-fetch-response'] = jsonEditResponse(hookFetchText, false);
  S['trusted-json-edit-fetch-response'] = jsonEditResponse(hookFetchText, true);
  S['json-edit-xhr-response'] = jsonEditResponse(hookXhrText, false);
  S['trusted-json-edit-xhr-response'] = jsonEditResponse(hookXhrText, true);

  function inboundEditor(trusted) {
    return function (path, pos, q) {
      var edit = jsonEditor(q, trusted), i = parseInt(pos, 10);
      if (!edit || isNaN(i)) return;
      wrapFunction(path, function (t, thisArg, args) {
        if (args[i] && typeof args[i] === 'object') { try { edit(args[i]); } catch (e) {} }
        return Reflect.apply(t, thisArg, args);
      });
    };
  }
  S['edit-inbound-object'] = inboundEditor(false);
  S['trusted-edit-inbound-object'] = inboundEditor(true);
  // JSON Lines responses: edit every line that is a JSON value.
  function jsonlEditResponse(hook, trusted) {
    return function (q, props) {
      var edit = jsonEditor(q, trusted);
      if (!edit) return;
      hook(parseProps(props), function (text) {
        var changed = false;
        var out = text.split('\n').map(function (line) {
          var obj;
          try { obj = nativeParse(line); } catch (e) { return line; }
          if (!edit(obj)) return line;
          changed = true;
          return nativeStringify(obj);
        });
        return changed ? out.join('\n') : null;
      });
    };
  }
  S['jsonl-edit-xhr-response'] = jsonlEditResponse(hookXhrText, false);
  S['jsonl-edit-fetch-response'] = jsonlEditResponse(hookFetchText, false);
  S['trusted-jsonl-edit-xhr-response'] = jsonlEditResponse(hookXhrText, true);
  S['trusted-jsonl-edit-fetch-response'] = jsonlEditResponse(hookFetchText, true);

  (cfg.s || []).forEach(function (call) {
    var fn = S[call[0]];
    if (fn) { try { fn.apply(null, call[1] || []); } catch (e) {} }
  });

  // ---------- procedural cosmetics ----------
  var OPS = ['has-text', '-abp-contains', 'contains', 'upward', 'nth-ancestor', 'remove-attr', 'remove-class', 'remove',
    'matches-path', 'matches-attr', 'matches-media', 'watch-attr', 'style', 'others', '-abp-properties', 'matches-css-before',
    'matches-css-after', 'matches-css', 'min-text-length', 'xpath', '-abp-has', 'has', 'if', 'if-not', 'not'];

  // Split "base:op(arg)rest" into a base selector and a list of [op, arg] / [' css', text] steps.
  function parseProcedural(sel) {
    var steps = [], base = null, buf = '', i = 0;
    var flush = function () {
      if (buf.trim() === '') { buf = ''; return; }
      if (base === null && steps.length === 0) base = buf.trim(); else steps.push(['css', buf]);
      buf = '';
    };
    while (i < sel.length) {
      var matched = null;
      if (sel.charAt(i) === ':') {
        for (var k = 0; k < OPS.length; k++) {
          if (sel.substr(i + 1, OPS[k].length + 1) === OPS[k] + '(') { matched = OPS[k]; break; }
        }
      }
      // Native :has()/:not() with plain arguments stay in the CSS selector.
      if (matched === 'has' || matched === 'not') {
        var argStart = i + matched.length + 2, d = 1, j = argStart;
        while (j < sel.length && d > 0) { if (sel[j] === '(') d++; else if (sel[j] === ')') d--; j++; }
        var inner = sel.slice(argStart, j - 1);
        if (!OPS.some(function (o) { return o !== 'has' && o !== 'not' && inner.indexOf(':' + o + '(') >= 0; })) {
          buf += sel.slice(i, j); i = j; continue;
        }
      }
      if (!matched) { buf += sel.charAt(i++); continue; }
      flush();
      var start = i + matched.length + 2, depth = 1, p = start;
      while (p < sel.length && depth > 0) {
        var ch = sel.charAt(p);
        if (ch === '\\') { p += 2; continue; }
        if (ch === '(') depth++; else if (ch === ')') depth--;
        p++;
      }
      if (depth !== 0) return null;
      steps.push([matched, sel.slice(start, p - 1)]);
      i = p;
    }
    flush();
    return { base: base, steps: steps };
  }

  function textRe(arg) {
    if (arg.length > 1 && arg.charAt(0) === '/' && arg.lastIndexOf('/') > 0) return toRegex(arg);
    return toRegex(arg);
  }

  function applyStep(nodes, step) {
    var op = step[0], arg = step[1], out = [];
    var each = function (f) { nodes.forEach(function (n) { var r = f(n); if (r) { if (Array.isArray(r)) out.push.apply(out, r); else out.push(r); } }); };
    switch (op) {
      case 'css':
        var css = arg.trim();
        if (/^[>+~]/.test(css) || /^\s/.test(arg)) {
          each(function (n) { try { return Array.prototype.slice.call(n.querySelectorAll(':scope ' + arg.trim())); } catch (e) { return null; } });
        } else {
          each(function (n) { try { return n.matches(css) ? n : null; } catch (e) { return null; } });
        }
        break;
      case 'has-text': case '-abp-contains': case 'contains':
        var re = textRe(arg);
        each(function (n) { return re.test(n.textContent || '') ? n : null; });
        break;
      case 'min-text-length':
        var min = parseInt(arg, 10) || 0;
        each(function (n) { return (n.textContent || '').length >= min ? n : null; });
        break;
      case 'upward': case 'nth-ancestor':
        var num = parseInt(arg, 10);
        each(function (n) {
          if (!isNaN(num) && String(num) === arg.trim()) {
            var a = n; for (var k = 0; k < num && a; k++) a = a.parentElement; return a;
          }
          try { return n.parentElement ? n.parentElement.closest(arg) : null; } catch (e) { return null; }
        });
        break;
      case '-abp-has': case 'has': case 'if':
        var sub = parseProcedural(arg);
        each(function (n) { return sub && queryWithin(n, sub).length ? n : null; });
        break;
      case 'if-not': case 'not':
        var subn = parseProcedural(arg);
        each(function (n) { return subn && !matchesSelf(n, subn) ? n : null; });
        break;
      case 'matches-css': case 'matches-css-before': case 'matches-css-after':
        var pseudo = op === 'matches-css' ? null : (op === 'matches-css-before' ? '::before' : '::after');
        var colon = arg.indexOf(':');
        if (colon < 0) break;
        var prop = arg.slice(0, colon).trim(), valRe = toRegex(arg.slice(colon + 1).trim());
        each(function (n) { try { return valRe.test(getComputedStyle(n, pseudo).getPropertyValue(prop)) ? n : null; } catch (e) { return null; } });
        break;
      case 'xpath':
        each(function (n) {
          var res = [];
          try {
            var it = D.evaluate(arg, n, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (var k = 0; k < it.snapshotLength; k++) { var x = it.snapshotItem(k); if (x.nodeType === 1) res.push(x); }
          } catch (e) {}
          return res;
        });
        break;
      case 'remove':
        out = nodes.slice(); out.__remove = true;
        break;
      case 'remove-attr': case 'remove-class':
        out = nodes.slice(); out.__action = [op, toRegex(arg.replace(/^(['"])(.*)\1$/, '$2'))];
        break;
      case 'style':
        out = nodes.slice(); out.__style = arg;
        break;
      case '-abp-properties':
        // Elements styled by a stylesheet rule whose declarations match the pattern.
        var pat = arg.trim(), propRe;
        if (pat.length > 2 && pat.charAt(0) === '/' && pat.lastIndexOf('/') > 0) propRe = toRegex(pat);
        else propRe = new RegExp(pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
        var sels = [];
        Array.prototype.forEach.call(D.styleSheets, function (sh) {
          var rules;
          try { rules = sh.cssRules; } catch (e) { return; }
          Array.prototype.forEach.call(rules || [], function (r) { if (r.selectorText && r.style && propRe.test(r.style.cssText)) sels.push(r.selectorText); });
        });
        if (nodes.length === 1 && nodes[0] === D) {
          sels.forEach(function (sel) { try { D.querySelectorAll(sel).forEach(function (el) { if (out.indexOf(el) < 0) out.push(el); }); } catch (e) {} });
        } else {
          each(function (n) { return sels.some(function (sel) { try { return n.matches(sel); } catch (e) { return false; } }) ? n : null; });
        }
        break;
      case 'others':
        out = nodes.slice(); out.__others = true;
        break;
      case 'matches-path':
        var pre = toRegex(arg);
        out = hit(pre, location.pathname + location.search) ? nodes.slice() : [];
        break;
      case 'matches-media':
        var mm = false;
        try { mm = W.matchMedia(arg).matches; } catch (e) {}
        out = mm ? nodes.slice() : [];
        break;
      case 'watch-attr':
        // Our observer already re-runs on attribute changes.
        out = nodes.slice();
        break;
      case 'matches-attr':
        // "name"="value", either side may be /regex/; value optional.
        var am = /^\s*("[^"]*"|\/(?:\\.|[^\/])+\/[a-z]*|[^=\s]+)\s*(?:=\s*("[^"]*"|\/(?:\\.|[^\/])*\/[a-z]*|\S+))?\s*$/.exec(arg);
        if (!am) break;
        var tester = function (raw) {
          if (raw.charAt(0) === '/' && raw.lastIndexOf('/') > 0) { var re = toRegex(raw); return function (v) { return re.test(v); }; }
          var lit = raw.replace(/^"(.*)"$/, '$1');
          return function (v) { return v === lit; };
        };
        var nameT = tester(am[1]), valT = am[2] === undefined ? null : tester(am[2]);
        each(function (n) {
          for (var k = 0; k < n.attributes.length; k++) {
            var at = n.attributes[k];
            if (nameT(at.name) && (valT === null || valT(at.value))) return n;
          }
          return null;
        });
        break;
    }
    if (nodes.__remove) out.__remove = true;
    if (nodes.__action && !out.__action) out.__action = nodes.__action;
    if (nodes.__style && !out.__style) out.__style = nodes.__style;
    if (nodes.__others) out.__others = true;
    return out;
  }

  function queryWithin(root, parsed) {
    var nodes;
    try {
      nodes = parsed.base ? Array.prototype.slice.call(root.querySelectorAll(parsed.base.charAt(0).match(/[>+~]/) ? ':scope ' + parsed.base : parsed.base)) : [root];
    } catch (e) { return []; }
    for (var i = 0; i < parsed.steps.length && nodes.length; i++) nodes = applyStep(nodes, parsed.steps[i]);
    return nodes;
  }
  function matchesSelf(el, parsed) {
    if (parsed.base) { try { if (!el.matches(parsed.base)) return false; } catch (e) { return false; } }
    var nodes = [el];
    for (var i = 0; i < parsed.steps.length && nodes.length; i++) nodes = applyStep(nodes, parsed.steps[i]);
    return nodes.length > 0;
  }

  function applyAction(n, action) {
    var re = action[1];
    if (action[0] === 'remove-attr') {
      Array.prototype.slice.call(n.attributes).forEach(function (a) { if (hit(re, a.name)) n.removeAttribute(a.name); });
    } else {
      Array.prototype.slice.call(n.classList).forEach(function (c) { if (hit(re, c)) n.classList.remove(c); });
    }
  }
  // Hide everything except `keep`, its ancestors and its descendants.
  function hideOthers(keep, hidden) {
    var el = keep;
    while (el && el.parentElement && el !== D.body && el !== D.documentElement) {
      Array.prototype.forEach.call(el.parentElement.children, function (sib) {
        if (sib === el || hidden.has(sib) || /^(?:SCRIPT|STYLE|LINK|META|HEAD|TEMPLATE)$/.test(sib.tagName)) return;
        hidden.add(sib);
        sib.style.setProperty('display', 'none', 'important');
      });
      el = el.parentElement;
    }
  }
  function applyStyle(n, decl) {
    // Declarations were checked by the filter parser (no url(), expression()...).
    String(decl).split(';').forEach(function (d) {
      var i = d.indexOf(':');
      if (i < 0) return;
      var prop = d.slice(0, i).trim(), val = d.slice(i + 1).trim(), imp = /!important\s*$/.test(val);
      if (imp) val = val.replace(/!important\s*$/, '').trim();
      try { n.style.setProperty(prop, val, imp ? 'important' : ''); } catch (e) {}
    });
  }

  var rules = (cfg.p || []).map(parseProcedural).filter(Boolean);
  if (rules.length) {
    var hidden = new WeakSet();
    observe(function () {
      rules.forEach(function (r) {
        var nodes = queryWithin(D, r);
        nodes.forEach(function (n) {
          if (nodes.__remove) { n.remove(); return; }
          if (nodes.__action) { applyAction(n, nodes.__action); return; }
          if (nodes.__style) { applyStyle(n, nodes.__style); return; }
          if (nodes.__others) { hideOthers(n, hidden); return; }
          if (hidden.has(n)) return;
          hidden.add(n);
          n.style.setProperty('display', 'none', 'important');
        });
      });
    });
  }

  // Exposed for tests only.
  if (cfg.test) { W.__filterRuntime = { parse: parseProcedural, query: queryWithin }; }
})
