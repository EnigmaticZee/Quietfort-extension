// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// "Describe it to hide it", page side: injected on demand into the top frame.
// Lists the visible blocks of the page (shared/describe.ts BlockSummary) and
// keeps the elements so the background can open the element picker on the one
// it picked. Reads the page only; changes nothing.

import type { BlockSummary } from '../shared/describe.ts';

(() => {
  const w = window as unknown as { __qfDescribe?: { blocks: BlockSummary[]; vw: number; vh: number }; __qfDescribeEls?: Element[] };
  const MAX = 600;
  const ATTRS = ['aria-label', 'role', 'title', 'alt', 'data-testid', 'data-test', 'data-component', 'name', 'aria-modal'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'BR', 'svg', 'PATH', 'HTML', 'BODY', 'OPTION']);
  const vw = innerWidth;
  const vh = innerHeight;
  const blocks: BlockSummary[] = [];
  const els: Element[] = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    if (els.length >= MAX) break;
    if (SKIP.has(el.tagName) || el.id === '__adb_picker') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 18 || r.width * r.height < 1500) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    // A wrapper with exactly one child of the same size adds nothing: keep the inner one only.
    const only = el.children.length === 1 ? el.children[0]!.getBoundingClientRect() : null;
    if (only && Math.abs(only.width - r.width) < 2 && Math.abs(only.height - r.height) < 2) continue;
    const attrs: string[] = [];
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) attrs.push(`${a}=${v.slice(0, 40)}`);
    }
    blocks.push({
      tag: el.tagName.toLowerCase(),
      id: el.id.slice(0, 60),
      classes: [...el.classList].slice(0, 8).map((c) => c.slice(0, 40)),
      attrs,
      text: ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.left),
      y: Math.round(r.top + scrollY),
      fixed: cs.position === 'fixed' || cs.position === 'sticky',
    });
    els.push(el);
  }
  w.__qfDescribe = { blocks, vw, vh };
  w.__qfDescribeEls = els;
})();
