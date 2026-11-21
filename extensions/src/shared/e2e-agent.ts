// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Safari end-to-end test build only (compiled out of every other build):
// lets test/e2e/safari.e2e.mjs see and drive the extension's own pages
// (warning page, options page). Safari's WebDriver cannot reach
// safari-web-extension:// pages of an extension the user enabled, so the page
// long-polls the local test server for commands: click a selector, report its
// state, or navigate on.

declare const __E2E__: boolean;
declare const __PLATFORM__: string;
declare const __E2E_LISTS__: Array<{ url: string }> | null;

export function startE2eAgent(page: string, snapshot: () => Record<string, unknown>): void {
  if (!__E2E__ || __PLATFORM__ !== 'safari' || !__E2E_LISTS__?.length) return;
  const endpoint = `${new URL(__E2E_LISTS__[0]!.url).origin}/__agent/poll`;
  const id = Math.random().toString(36).slice(2);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const loop = async () => {
    let result: unknown = null;
    for (let i = 0; i < 2000; i++) {
      let cmd: { cmd: string; seq?: number; sel?: string; url?: string };
      try {
        const body = JSON.stringify({ id, kind: 'ext', page, href: location.href, title: document.title, result, state: snapshot() });
        result = null;
        cmd = (await (await fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'text/plain' } })).json()) as typeof cmd;
      } catch {
        await sleep(500);
        continue;
      }
      if (cmd.cmd === 'noop') continue;
      if (cmd.cmd === 'stop') return;
      try {
        if (cmd.cmd === 'click') {
          const el = document.querySelector<HTMLElement>(cmd.sel ?? '');
          el?.click();
          result = { seq: cmd.seq, ok: true, value: { clicked: !!el } };
        } else if (cmd.cmd === 'state') {
          result = { seq: cmd.seq, ok: true, value: snapshot() };
        } else if (cmd.cmd === 'goto') {
          location.href = cmd.url ?? 'about:blank';
          return;
        } else {
          result = { seq: cmd.seq, ok: false, error: `unknown command ${cmd.cmd}` };
        }
      } catch (err) {
        result = { seq: cmd.seq, ok: false, error: String(err) };
      }
    }
  };
  setTimeout(() => void loop(), 300);
}
