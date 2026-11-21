// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Test server for the Safari end-to-end test.
//
// Safari has no host-resolver flags or per-browser proxy, and the test must not
// touch /etc/hosts, DNS or the system proxy. Safari resolves every *.localhost
// name to loopback by itself, so the Safari test uses `<name>.localhost` where
// the Chrome/Firefox tests use `<name>.test`:
//
//   Safari ──▶ this front server (port 80, loopback connections only)
//                 │  Host: ads.adnet.localhost  →  ads.adnet.test
//                 ▼
//              server.mjs (the shared fixture server, 127.0.0.1:<random>)
//
// Response bodies (pages, filter lists) get `.test` host names rewritten to
// `.localhost`, so the same fixtures and lists are used unchanged. Port 80
// keeps URLs port-free so `||host/path` filters match as in the other tests
// (macOS lets unprivileged processes bind port 80 on the wildcard address;
// non-loopback connections are dropped).
//
// It also hosts the page agent: every HTML page gets /__agent.js, which
// long-polls /__agent/poll for commands from the test (evaluate, relay a
// message to the extension, navigate). The Safari e2e build's warning and
// options pages run the same protocol (src/shared/e2e-agent.ts). This lets the
// test drive a tab of the user's normal Safari, where the enabled extension
// runs, without WebDriver.

import { createServer, request } from 'node:http';
import { startServer, DEEP_HOST } from './server.mjs';

export const DEEP_HOST_SAFARI = DEEP_HOST.replace(/\.test$/, '.localhost');

const TEXTUAL = /^(text\/|application\/(javascript|json))/;
// `.test` used as a TLD (followed by a URL / filter / quote delimiter), never `re.test(`.
const TEST_TLD = /([a-z0-9-])\.test(?=[/:^"'#$,\s\])<|?&;*]|$)/g;
const toSafari = (s) => s.replace(TEST_TLD, '$1.localhost');
const toInner = (host) => host.replace(/\.localhost$/, '.test');

const AGENT_JS = `(function () {
  if (window.top !== window || window.__adbAgent) return;
  window.__adbAgent = true;
  var id = Math.random().toString(36).slice(2);
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function relay(msg, ms) {
    return new Promise(function (resolve) {
      var rid = Math.random();
      var t = setTimeout(function () { removeEventListener('message', f); resolve({ __noReply: true }); }, ms || 4000);
      function f(e) {
        if (e.data && e.data.__adbTestReply === rid) { clearTimeout(t); removeEventListener('message', f); resolve(e.data.res === undefined ? null : e.data.res); }
      }
      addEventListener('message', f);
      postMessage({ __adbTest: msg, id: rid }, '*');
    });
  }
  async function exec(c) {
    if (c.cmd === 'eval') return await (new Function('return (async () => {' + c.src + '\\n})()'))();
    if (c.cmd === 'relay') return await relay(c.msg, c.timeout);
    if (c.cmd === 'goto') { location.href = c.url; return 'navigating'; }
    if (c.cmd === 'reload') { location.reload(); return 'reloading'; }
    throw new Error('unknown command ' + c.cmd);
  }
  async function loop() {
    var result = null;
    for (;;) {
      var c;
      try {
        var body = JSON.stringify({ id: id, kind: 'page', href: location.href, title: document.title, result: result });
        result = null;
        c = await (await fetch('/__agent/poll', { method: 'POST', body: body, headers: { 'content-type': 'text/plain' } })).json();
      } catch (e) { await sleep(500); continue; }
      if (c.cmd === 'noop') continue;
      if (c.cmd === 'stop') return;
      try { result = { seq: c.seq, ok: true, value: await exec(c) }; } catch (e) { result = { seq: c.seq, ok: false, error: String(e && e.stack || e) }; }
      if (c.cmd === 'goto' || c.cmd === 'reload') return;
    }
  }
  if (document.readyState === 'complete') setTimeout(loop, 30);
  else addEventListener('load', function () { setTimeout(loop, 30); });
})();
`;

/** Agents (one per loaded page) and the commands the test sends them. */
function createHub() {
  const agents = new Map();
  const waiters = new Set();
  let seq = 0;
  const notify = () => {
    for (const w of [...waiters]) {
      for (const a of agents.values()) {
        if (a.firstSeen >= w.since && w.pred(a)) {
          waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(a);
          break;
        }
      }
    }
  };
  const flush = (a) => {
    if (!a.held || !a.queue.length) return;
    const res = a.held;
    a.held = null;
    clearTimeout(a.heldTimer);
    const cmd = a.queue.shift();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(cmd));
  };
  return {
    agents,
    poll(body, res) {
      let a = agents.get(body.id);
      if (!a) {
        a = { id: body.id, firstSeen: Date.now(), queue: [], pending: new Map(), held: null };
        agents.set(body.id, a);
      }
      Object.assign(a, { kind: body.kind, page: body.page ?? null, href: body.href, title: body.title, state: body.state ?? null, lastSeen: Date.now() });
      const r = body.result;
      if (r && a.pending.has(r.seq)) {
        const p = a.pending.get(r.seq);
        a.pending.delete(r.seq);
        r.ok ? p.resolve(r.value) : p.reject(new Error(r.error));
      }
      if (a.held) a.held.end(JSON.stringify({ cmd: 'noop' }));
      a.held = res;
      res.on('close', () => {
        if (a.held === res) a.held = null;
      });
      a.heldTimer = setTimeout(() => {
        if (a.held === res) {
          a.held = null;
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ cmd: 'noop' }));
        }
      }, 15000);
      flush(a);
      notify();
    },
    /** First agent that appears at or after `since` and matches `pred`. */
    waitAgent(pred, { since = 0, timeout = 15000 } = {}) {
      return new Promise((resolve) => {
        const w = { pred, since, resolve };
        w.timer = setTimeout(() => {
          waiters.delete(w);
          resolve(null);
        }, timeout);
        waiters.add(w);
        notify();
      });
    },
    /** Send a command; resolves with its result (or null for navigations). */
    send(a, cmd, timeout = 10000) {
      const s = ++seq;
      const msg = { ...cmd, seq: s };
      const navigates = cmd.cmd === 'goto' || cmd.cmd === 'reload' || cmd.cmd === 'stop';
      const p = navigates
        ? Promise.resolve(null)
        : new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            a.pending.delete(s);
            reject(new Error(`agent timeout: ${cmd.cmd}`));
          }, timeout);
          a.pending.set(s, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        });
      a.queue.push(msg);
      flush(a);
      return p;
    },
  };
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

export async function startSafariServer(port = 80, { fullList = true } = {}) {
  const inner = await startServer();
  const log = [];
  const hub = createHub();
  let bigCache = null; // the rewritten full-size malware list (by upstream ETag)

  const front = createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, 'http://x');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (url.pathname.startsWith('/__agent')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      if (url.pathname === '/__agent.js') {
        res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
        return res.end(AGENT_JS);
      }
      if (url.pathname === '/__agent/poll' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            hub.poll(JSON.parse(body), res);
          } catch (err) {
            res.writeHead(400, cors);
            res.end(String(err));
          }
        });
        return undefined;
      }
    }
    if (url.pathname === '/__done') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><title>Safari e2e finished</title><h1>Safari e2e test finished</h1><p>You can close this tab. Results are in the terminal.</p>');
    }
    log.push({ host, path: url.pathname, query: url.search, at: Date.now(), headers: req.headers });
    if (!fullList && url.pathname === '/catalogue/blp-malware.txt') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('full list disabled for this run');
    }
    const up = request({
      host: '127.0.0.1', port: inner.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: toInner(req.headers.host || '') },
    }, (ures) => {
      if (url.pathname === '/streamed.html') {
        // Pass the streamed fixture through chunk by chunk, so its timing survives.
        const headers = { ...ures.headers };
        delete headers['content-length'];
        res.writeHead(ures.statusCode, headers);
        ures.on('data', (c) => res.write(toSafari(c.toString('utf8'))));
        ures.on('end', () => res.end('\n<script src="/__agent.js"></script>\n'));
        return;
      }
      const chunks = [];
      ures.on('data', (c) => chunks.push(c));
      ures.on('end', () => {
        let body = Buffer.concat(chunks);
        const cat = /^\/catalogue\/([a-z0-9-]+)\.txt$/.exec(url.pathname);
        if (ures.statusCode === 404 && cat && !(cat[1] === 'blp-malware' && !fullList)) {
          // Catalogue lists without a fixture: a valid, empty stand-in instead of a 404, so a
          // list text left in the profile by an earlier (production) install is replaced
          // rather than kept, and the run does not depend on what this Safari downloaded before.
          const text = cat[1].startsWith('blp-')
            ? `# Title: e2e empty stand-in for ${cat[1]}\n0.0.0.0 e2e-placeholder-${cat[1]}.invalid\n`
            : `[Adblock Plus 2.0]\n! Title: e2e empty stand-in for ${cat[1]}\n! (no rules)\n`;
          res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          return res.end(text);
        }
        const type = String(ures.headers['content-type'] || '');
        const headers = { ...ures.headers };
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        if (body.length > 8 * 1024 * 1024) {
          // Full-size malware list: only its one `.test` entry needs renaming.
          const etag = String(ures.headers.etag || '');
          if (bigCache?.etag !== etag) {
            const i = body.indexOf(DEEP_HOST);
            const out = i < 0 ? body : Buffer.concat([body.subarray(0, i), Buffer.from(DEEP_HOST_SAFARI), body.subarray(i + DEEP_HOST.length)]);
            bigCache = { etag, body: out };
          }
          body = bigCache.body;
        } else if (TEXTUAL.test(type) && body.length) {
          let text = toSafari(body.toString('utf8'));
          if (type.startsWith('text/html')) text += '\n<script src="/__agent.js"></script>\n';
          body = Buffer.from(text);
        }
        if (headers['content-security-policy']) headers['content-security-policy'] = toSafari(String(headers['content-security-policy']));
        res.writeHead(ures.statusCode, { ...headers, 'content-length': body.length });
        res.end(body);
      });
    });
    up.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
    req.pipe(up);
    return undefined;
  });
  front.on('connection', (sock) => {
    if (!isLoopback(sock.remoteAddress)) sock.destroy();
  });
  await new Promise((resolve, reject) => {
    front.once('error', reject);
    front.listen({ port, host: '::', ipv6Only: false }, resolve);
  });
  return {
    port: front.address().port,
    log,
    hub,
    state: inner.state,
    close() {
      front.closeAllConnections?.();
      front.close();
      inner.server.close();
    },
  };
}
