// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Zap mode: injected on demand into the top frame. Highlights the element under
// the pointer; a click removes it from the page right away. Nothing is saved:
// everything comes back when the page is reloaded. Undo puts back the last
// removed element; Esc or Done leaves zap mode.
// Opened from the right-click menu: the right-clicked element is zapped at once
// (and zap mode stays open for more).

declare const __E2E__: boolean;

(() => {
  // `__qfZapOpenShadow` can only be set from the extension's isolated world (tests); pages cannot see or set it.
  type W = { __qfZap?: { zapNow(el: Element): void }; __qfZapElement?: Element | null; __qfZapOpenShadow?: boolean };
  const w = window as unknown as W;
  const pre = w.__qfZapElement;
  w.__qfZapElement = null;
  if (w.__qfZap) {
    if (pre instanceof Element) w.__qfZap.zapNow(pre);
    return;
  }

  const host = document.createElement('div');
  host.id = '__qf_zap';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: __E2E__ || w.__qfZapOpenShadow ? 'open' : 'closed' });
  root.innerHTML = `<style>
    .box { position: fixed; border: 2px solid #169383; background: rgba(22,147,131,.18); pointer-events: none; box-sizing: border-box; border-radius: 3px; }
    .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); pointer-events: auto; display: flex; gap: 8px; align-items: center;
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1d1d1f; background: #fff;
      border: 1px solid #c7c7cc; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.22); padding: 8px 8px 8px 14px; white-space: nowrap; }
    @media (prefers-color-scheme: dark) { .bar { color: #f2f2f7; background: #1c1c1e; border-color: #48484a; } }
    .count { color: #8e8e93; }
    button { font: inherit; padding: 5px 11px; border-radius: 8px; border: 1px solid #c7c7cc; background: transparent; color: inherit; cursor: pointer; }
    button.primary { background: #169383; border-color: #169383; color: #fff; }
    button:disabled { opacity: .45; cursor: default; }
  </style><div class="layer"></div><div class="bar" role="toolbar" aria-label="Zap mode">
    <span id="qf-zap-text">Click anything to remove it until you reload.</span><span class="count" id="qf-zap-count"></span>
    <button id="qf-zap-undo" type="button" disabled>Undo</button><button id="qf-zap-done" class="primary" type="button">Done</button></div>`;
  document.documentElement.appendChild(host);

  const layer = root.querySelector('.layer') as HTMLElement;
  const bar = root.querySelector('.bar') as HTMLElement;
  const undoBtn = root.querySelector('#qf-zap-undo') as HTMLButtonElement;
  const countEl = root.querySelector('#qf-zap-count') as HTMLElement;
  /** Removed elements, newest last, with where they were so Undo can put them back. */
  const removed: Array<{ el: Element; parent: Node; next: Node | null }> = [];

  const inBar = (ev: Event) => ev.composedPath().includes(host);
  const zappable = (t: EventTarget | null): t is Element =>
    t instanceof Element && t !== document.documentElement && t !== document.body && t !== host && !host.contains(t);

  function box(el: Element | null): void {
    layer.textContent = '';
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const b = document.createElement('div');
    b.className = 'box';
    b.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    layer.appendChild(b);
  }

  function update(): void {
    undoBtn.disabled = removed.length === 0;
    countEl.textContent = removed.length ? `${removed.length} removed` : '';
    host.dataset.count = String(removed.length);
  }

  function zapNow(el: Element): void {
    if (!zappable(el) || !el.isConnected || !el.parentNode) return;
    removed.push({ el, parent: el.parentNode, next: el.nextSibling });
    el.remove();
    box(null);
    update();
  }

  function undo(): void {
    const last = removed.pop();
    if (!last) return;
    const next = last.next && last.next.parentNode === last.parent ? last.next : null;
    last.parent.insertBefore(last.el, next);
    update();
  }

  function close(): void {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('mousedown', swallow, true);
    window.removeEventListener('mouseup', swallow, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    host.remove();
    delete w.__qfZap;
  }

  let hovered: Element | null = null;
  function onMove(ev: MouseEvent): void {
    if (inBar(ev)) {
      hovered = null;
      box(null);
      return;
    }
    hovered = zappable(ev.target) ? ev.target : null;
    box(hovered);
  }
  function onScroll(): void {
    box(hovered && hovered.isConnected ? hovered : null);
  }
  /** Page handlers never see the clicks that zap (no links followed, no menus opened). */
  function swallow(ev: MouseEvent): void {
    if (inBar(ev)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }
  function onClick(ev: MouseEvent): void {
    if (inBar(ev)) return;
    swallow(ev);
    if (zappable(ev.target)) zapNow(ev.target);
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if ((ev.key === 'z' && (ev.metaKey || ev.ctrlKey)) || ev.key === 'Backspace') {
      if (!removed.length) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      undo();
    }
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mousedown', swallow, true);
  window.addEventListener('mouseup', swallow, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  bar.addEventListener('click', (ev) => ev.stopPropagation());
  undoBtn.addEventListener('click', undo);
  (root.querySelector('#qf-zap-done') as HTMLButtonElement).addEventListener('click', close);

  w.__qfZap = { zapNow };
  update();
  if (pre instanceof Element) zapNow(pre);
})();
