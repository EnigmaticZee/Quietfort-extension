// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// "Hide an element": injected on demand into the top frame. Highlights the
// element under the pointer; a click selects it and opens a panel with ranked
// candidate selectors (match counts, scores, live preview, widen/narrow to the
// parent/child). Save stores the chosen selector as the primary site rule and
// the other valid candidates as fallbacks.

import { generateCandidates, specToString, validatePick } from '../shared/selectors.ts';
import type { Candidate } from '../shared/selectors.ts';
import { elLike, fingerprintOf, queryAll } from './dom.ts';

declare const __E2E__: boolean;

(() => {
  // `__adbPickerOpenShadow` can only be set from the extension's isolated world
  // (diagnostics / tests); pages cannot see or set it.
  const w = window as unknown as { __adbPicker?: boolean; __adbPickerOpenShadow?: boolean; __adbPickerTake?: () => void };
  // Already open: move it to the newly chosen element (a second "Describe it", or the right-click menu).
  if (w.__adbPicker) {
    w.__adbPickerTake?.();
    return;
  }
  w.__adbPicker = true;
  const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);

  const host = document.createElement('div');
  host.id = '__adb_picker';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: __E2E__ || w.__adbPickerOpenShadow ? 'open' : 'closed' });
  root.innerHTML = `<style>
    .box { position: fixed; border: 2px solid #0a84ff; background: rgba(10,132,255,.15); pointer-events: none; box-sizing: border-box; }
    .box.sel { border-color: #169383; background: rgba(22,147,131,.2); }
    .panel { position: fixed; right: 12px; bottom: 12px; width: 420px; max-height: 70vh; overflow: auto; pointer-events: auto;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1d1d1f; background: #fff;
      border: 1px solid #c7c7cc; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.25); padding: 10px; }
    @media (prefers-color-scheme: dark) { .panel { color: #f2f2f7; background: #1c1c1e; border-color: #48484a; } }
    .hint { margin: 0 0 6px; }
    label.cand { display: grid; grid-template-columns: auto 1fr auto; gap: 6px; align-items: start; padding: 4px; border-radius: 6px; cursor: pointer; }
    label.cand:hover { background: rgba(127,127,127,.12); }
    code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .meta { color: #8e8e93; white-space: nowrap; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    button { font: inherit; padding: 4px 9px; border-radius: 6px; border: 1px solid #c7c7cc; background: transparent; color: inherit; cursor: pointer; }
    button.primary { background: #0a7c4a; border-color: #0a7c4a; color: #fff; }
    button:disabled { opacity: .45; cursor: default; }
    .status { margin-top: 6px; min-height: 1.4em; }
    .status.bad { color: #ff453a; }
  </style><div class="layer"></div><div class="panel"><p class="hint">Click the element you want to hide. Esc to cancel.</p><div class="list"></div>
    <div class="row" hidden><button id="adb-widen" type="button">Widen (parent)</button><button id="adb-narrow" type="button">Narrow (child)</button>
    <button id="adb-preview" type="button">Preview</button><button id="adb-save" class="primary" type="button">Hide</button><button id="adb-cancel" type="button">Cancel</button></div>
    <div class="status" id="adb-status"></div></div>`;
  document.documentElement.appendChild(host);

  const layer = root.querySelector('.layer') as HTMLElement;
  const panel = root.querySelector('.panel') as HTMLElement;
  const list = root.querySelector('.list') as HTMLElement;
  const row = root.querySelector('.row') as HTMLElement;
  const status = root.querySelector('#adb-status') as HTMLElement;
  const hint = root.querySelector('.hint') as HTMLElement;
  const $ = (id: string) => root.querySelector(`#${id}`) as HTMLButtonElement;

  let selected: Element | null = null;
  const trail: Element[] = []; // narrower elements, for "Narrow"
  let cands: Candidate[] = [];
  let choice = 0;
  let preview = false;
  const previewed = new Map<HTMLElement, string>();

  const inPicker = (ev: Event) => ev.composedPath().includes(host);

  // What each kind of outline is drawn around, so outlines can follow the page when it scrolls.
  const drawn = new Map<string, Element[]>();
  let redrawQueued = false;
  function redraw(): void {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      for (const [cls, els] of drawn) boxes(els, cls);
    });
  }
  window.addEventListener('scroll', redraw, { capture: true, passive: true });
  window.addEventListener('resize', redraw, { passive: true });

  function boxes(els: Element[], cls: string): void {
    drawn.set(cls, els);
    layer.querySelectorAll(`.${cls}`).forEach((b) => b.remove());
    for (const el of els.slice(0, 60)) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const b = document.createElement('div');
      b.className = `box ${cls}`;
      b.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      layer.appendChild(b);
    }
  }

  function stats(els: Element[]): { count: number; matchesRoot: boolean; textShare: number } {
    const main = document.querySelector('main');
    const matchesRoot = els.some((e) => e === document.documentElement || e === document.body || e.tagName === 'MAIN' || (main !== null && e.contains(main)));
    const outer = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
    const total = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim().length || 1;
    const mine = outer.reduce((n, e) => n + (e.textContent ?? '').replace(/\s+/g, ' ').trim().length, 0);
    return { count: els.length, matchesRoot, textShare: mine / total };
  }

  function unpreview(): void {
    for (const [el, old] of previewed) el.style.setProperty('display', old);
    previewed.clear();
  }

  function refresh(): void {
    const c = cands[choice];
    unpreview();
    if (!c) return;
    const els = queryAll(c.selector);
    const v = validatePick(stats(els));
    boxes(els, 'sel');
    if (preview && v.ok) {
      for (const el of els) {
        const h = el as HTMLElement;
        previewed.set(h, h.style.getPropertyValue('display'));
        h.style.setProperty('display', 'none', 'important');
      }
      boxes([], 'sel');
    }
    status.textContent = v.ok ? `${els.length} element${els.length === 1 ? '' : 's'} will be hidden on ${location.hostname}.` : `Not allowed: ${v.reason}`;
    status.className = v.ok ? 'status' : 'status bad';
    status.dataset.ok = String(v.ok);
    $('adb-save').disabled = !v.ok;
    $('adb-narrow').disabled = trail.length === 0;
    $('adb-widen').disabled = !selected?.parentElement || selected.parentElement === document.body || selected.parentElement === document.documentElement;
  }

  function select(el: Element): void {
    selected = el;
    const cache = new WeakMap();
    cands = generateCandidates(elLike(el, cache), { count: (spec) => queryAll(specToString(spec)).filter((e) => !host.contains(e)).length });
    choice = 0;
    list.textContent = '';
    cands.forEach((c, i) => {
      const lab = document.createElement('label');
      lab.className = 'cand';
      lab.dataset.selector = c.selector;
      lab.dataset.count = String(c.count);
      lab.dataset.kind = c.kind;
      lab.dataset.score = String(c.score);
      lab.title = c.notes.join('; ');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'cand';
      radio.checked = i === 0;
      radio.addEventListener('change', () => {
        choice = i;
        refresh();
      });
      const code = document.createElement('code');
      code.textContent = c.selector;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${c.count} match${c.count === 1 ? '' : 'es'} · ${c.kind}`;
      lab.append(radio, code, meta);
      list.appendChild(lab);
    });
    hint.textContent = 'Pick a selector. The first one is the most robust; the others are kept as fallbacks.';
    row.hidden = false;
    boxes([], 'hover');
    refresh();
  }

  function close(): void {
    unpreview();
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', redraw, true);
    window.removeEventListener('resize', redraw);
    host.remove();
    w.__adbPicker = false;
    w.__adbPickerTake = undefined;
  }

  function onMove(ev: MouseEvent): void {
    if (selected || inPicker(ev)) return;
    const t = ev.target;
    if (t instanceof Element && t !== document.documentElement && t !== document.body) boxes([t], 'hover');
  }

  function onClick(ev: MouseEvent): void {
    if (inPicker(ev)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (selected) return; // panel open: clicks on the page do nothing
    const t = ev.target;
    if (t instanceof Element && t !== document.documentElement && t !== document.body) select(t);
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  panel.addEventListener('click', (ev) => ev.stopPropagation());

  $('adb-cancel').addEventListener('click', close);
  $('adb-preview').addEventListener('click', () => {
    preview = !preview;
    $('adb-preview').textContent = preview ? 'Stop preview' : 'Preview';
    refresh();
  });
  $('adb-widen').addEventListener('click', () => {
    const p = selected?.parentElement;
    if (!selected || !p || p === document.body) return;
    trail.push(selected);
    select(p);
  });
  $('adb-narrow').addEventListener('click', () => {
    const c = trail.pop();
    if (c) select(c);
  });
  // Opened from the right-click menu or from "Describe it to hide it": start on that element.
  function take(): void {
    const m = window as unknown as { __qfPickElement?: Element | null };
    const pre = m.__qfPickElement;
    m.__qfPickElement = null;
    if (pre instanceof Element && pre.isConnected && pre !== document.documentElement && pre !== document.body) {
      queueMicrotask(() => {
        unpreview();
        trail.length = 0;
        pre.scrollIntoView({ block: 'nearest' });
        select(pre);
      });
    }
  }
  w.__adbPickerTake = take;
  take();

  $('adb-save').addEventListener('click', async () => {
    const chosen = cands[choice];
    if (!chosen || !selected) return;
    // Primary first, then every other candidate that is valid on its own.
    // Candidates built on hash-like names (score ≥ 50) would not survive a redeploy: not kept as fallbacks.
    const ordered = [chosen, ...cands.filter((c) => c !== chosen && c.score < 50)].filter((c) => validatePick(stats(queryAll(c.selector))).ok);
    const fingerprint = fingerprintOf(selected);
    $('adb-save').disabled = true;
    const res = (await api.runtime.sendMessage({
      type: 'picker:save', selectors: ordered.map((c) => c.selector), counts: ordered.map((c) => c.count), fingerprint,
    })) as { ok: boolean; error?: string };
    if (!res?.ok) {
      status.textContent = `Could not save: ${res?.error ?? 'unknown error'}`;
      status.className = 'status bad';
      $('adb-save').disabled = false;
      return;
    }
    unpreview();
    for (const el of queryAll(chosen.selector)) (el as HTMLElement).style.setProperty('display', 'none', 'important');
    close();
  });
})();
