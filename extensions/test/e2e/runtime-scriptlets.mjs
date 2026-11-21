// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Page-runtime tests in headless Chrome: loads extensions/page-runtime/tests/browser/
// runtime.html (original scriptlets + procedural filters) and scriptlets.html
// (uBO / AdGuard list scriptlets) and checks every result is true.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createHarness, waitFor } from './harness.mjs';

const ROOT = fileURLToPath(new URL('../../page-runtime/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const h = createHarness('runtime scriptlets');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  for (const page of ['runtime.html', 'scriptlets.html']) {
    const p = await browser.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${origin}/tests/browser/${page}`);
    const r = await waitFor(() => p.evaluate(() => window.__results), 15000);
    if (!r) {
      const partial = await p.evaluate(() => JSON.stringify(window.R ?? null)).catch((e) => String(e));
      h.check(`${page}: results reported`, false, { errors, partial });
      continue;
    }
    for (const [k, v] of Object.entries(r.detail)) h.check(`${page}: ${k}`, v === true, v === true ? '' : v);
    h.check(`${page}: no uncaught page errors from the runtime`, !errors.some((e) => /runtime|Blocked by content filter/.test(e) && !/stackTrap|badProp|writeTrap/.test(e)), errors);
    await p.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(h.summary() ? 0 : 1);
