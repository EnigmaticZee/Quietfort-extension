// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Content script (isolated world, document_start, all frames). Asks the
// background to apply this page's hiding CSS, then reports `.class` / `#id`
// tokens as they appear so generic selectors keyed on them get applied too
// (the full generic list is far too large to inject into every page).

import { sameRegion } from '../shared/selectors.ts';
import type { Fingerprint, PickerRule } from '../shared/selectors.ts';
import { fingerprintOf, queryAll } from './dom.ts';
import { SCRIPTLET_CACHE_PREFIX, SCRIPTLET_EVENT } from '../shared/scriptlet-event.ts';
import { hostOf } from '../shared/domain.ts';

declare const __E2E__: boolean;

(() => {
  const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);
  if (!/^https?:$/.test(location.protocol)) return;

  // Scriptlets: hand this frame's configuration to the main-world runner
  // (scriptlets-main.ts) as early as possible: first the cached one for this
  // site (top frame), then the background's. The runner skips repeats.
  const toRunner = (cfg: unknown) => {
    if (typeof cfg === 'string' && cfg) window.dispatchEvent(new CustomEvent(SCRIPTLET_EVENT, { detail: cfg }));
  };
  if (window === window.top) {
    const key = SCRIPTLET_CACHE_PREFIX + hostOf(location.href);
    api.storage.local.get(key).then((r) => toRunner(r[key]), () => undefined);
  }
  api.runtime.sendMessage({ type: 'cs:scriptlets' }).then((r: { cfg?: unknown } | undefined) => toRunner(r?.cfg), () => undefined);

  // Safari: tabs.onCreated never names the opener, so pop-up rules could not recognise a tab opened by
  // clicking a link. Say which page a new-tab link was clicked on (trusted clicks only).
  if (api.runtime.getURL('').startsWith('safari-web-extension:')) {
    document.addEventListener('click', (ev) => {
      if (!ev.isTrusted) return;
      const a = (ev.target instanceof Element ? ev.target.closest('a[href]') : null) as HTMLAnchorElement | null;
      if (!a || !/^https?:/i.test(a.href)) return;
      const base = document.querySelector('base[target]')?.getAttribute('target') ?? '';
      const target = (a.getAttribute('target') || base).toLowerCase();
      const newTab = (target !== '' && target !== '_self' && target !== '_top' && target !== '_parent') || ev.metaKey;
      if (newTab) api.runtime.sendMessage({ type: 'cs:linkOpen', url: a.href }).catch(() => undefined);
    }, true);
  }

  // Right-click "Hide this element": remember what was right-clicked (top frame) so the
  // picker can start on it. Stays in this extension's isolated world.
  if (window === window.top) {
    document.addEventListener('contextmenu', (ev) => {
      (window as unknown as { __qfContextTarget?: EventTarget | null }).__qfContextTarget = ev.target instanceof Element ? ev.target : null;
    }, true);
  }

  // End-to-end test build only (compiled out of real builds): lets the test
  // page drive the popup's messages, since WebDriver BiDi cannot open
  // moz-extension:// pages.
  if (__E2E__) {
    window.addEventListener('message', (ev) => {
      const m = ev.data as { __adbTest?: Record<string, unknown>; id?: number } | null;
      if (ev.source !== window || !m || !m.__adbTest) return;
      api.runtime.sendMessage(m.__adbTest).then(
        (res: unknown) => window.postMessage({ __adbTestReply: m.id, res }, '*'),
        (err: unknown) => window.postMessage({ __adbTestReply: m.id, res: { error: String(err) } }, '*'),
      );
    });
  }

  // JavaScript errors from the page's main world (errors-main.ts), top frame only.
  if (window === window.top) {
    const seen = new Set<string>();
    window.addEventListener('message', (ev) => {
      const m = ev.data as { __adbErr?: number; message?: string; filename?: string; stack?: string } | null;
      if (ev.source !== window || !m || m.__adbErr !== 1) return;
      const key = `${m.message}|${m.filename}`;
      if (seen.has(key) || seen.size > 20) return;
      seen.add(key);
      api.runtime.sendMessage({ type: 'cs:jsError', message: m.message, filename: m.filename, stack: m.stack }).catch(() => undefined);
    });
  }

  // Opt-in on-device AI features: their code (content-ai.js) is injected by the
  // background only into frames where one of them is on, not into every page.
  api.runtime.sendMessage({ type: 'cs:aiWanted' }).catch(() => undefined);

  // Cookie-banner handler progress (consent-host.js in the main world, any frame).
  window.addEventListener('message', (ev) => {
    const m = ev.data as { __adbConsent?: number; type?: string; cmp?: string; result?: boolean | null; cosmetic?: boolean; clicks?: number | null } | null;
    if (ev.source !== window || !m || m.__adbConsent !== 1) return;
    api.runtime.sendMessage({ type: 'cs:consent', event: m.type, cmp: m.cmp, result: m.result, cosmetic: m.cosmetic, clicks: m.clicks }).catch(() => undefined);
  });

  // Picker rules: when the applied selector stopped matching but a fallback
  // still matches the element the user picked, switch to that fallback.
  function checkPicker(rules: PickerRule[]): void {
    for (const r of rules) {
      const active = r.selectors[r.active];
      if (!active || queryAll(active).length > 0) continue;
      for (let i = 0; i < r.selectors.length; i++) {
        if (i === r.active) continue;
        const els = queryAll(r.selectors[i]!);
        const max = Math.max(1, r.counts?.[i] ?? 1);
        if (!els.length || els.length > max) continue;
        if (!els.some((el) => sameRegion(r.fingerprint as Fingerprint, fingerprintOf(el)))) continue;
        for (const el of els) (el as HTMLElement).style?.setProperty('display', 'none', 'important');
        r.active = i;
        api.runtime.sendMessage({ type: 'cs:pickerSwitch', id: r.id, index: i }).catch(() => undefined);
        break;
      }
    }
  }

  function watchPicker(rules: PickerRule[]): void {
    const run = () => {
      try {
        checkPicker(rules);
      } catch {
        /* ignore */
      }
    };
    const later = () => {
      setTimeout(run, 300);
      window.addEventListener('load', () => setTimeout(run, 800), { once: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later, { once: true });
    else later();
  }

  const sent = new Set<string>();
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    if (!pending.length) return;
    const tokens = pending;
    pending = [];
    api.runtime.sendMessage({ type: 'cs:tokens', tokens }).catch(() => undefined);
  }

  function note(tok: string): void {
    if (sent.has(tok)) return;
    sent.add(tok);
    pending.push(tok);
  }

  function collect(el: Element): void {
    const id = el.id;
    if (id) note(`#${id}`);
    const cl = el.classList;
    for (let i = 0; i < cl.length; i++) note(`.${cl[i]}`);
  }

  function scan(root: ParentNode): void {
    if (root instanceof Element) collect(root);
    root.querySelectorAll('[id],[class]').forEach(collect);
    if (pending.length && !timer) timer = setTimeout(flush, 30);
  }

  function start(): void {
    scan(document);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          if (r.target instanceof Element) collect(r.target);
        } else {
          r.addedNodes.forEach((n) => {
            if (n instanceof Element) scan(n);
          });
        }
      }
      if (pending.length && !timer) timer = setTimeout(flush, 50);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  }

  api.runtime
    .sendMessage({ type: 'cs:init' })
    .then((res: { enabled?: boolean; generic?: boolean; picker?: PickerRule[] } | undefined) => {
      if (res?.enabled && res.picker?.length) watchPicker(res.picker);
      if (!res?.enabled || !res.generic) return;
      if (document.readyState === 'loading') {
        // Catch what is already parsed, then the rest.
        if (document.documentElement) scan(document);
        document.addEventListener('DOMContentLoaded', start, { once: true });
      } else start();
    })
    .catch(() => undefined);
})();
