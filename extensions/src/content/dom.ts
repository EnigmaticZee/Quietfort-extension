// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// DOM helpers shared by the content script and the element picker: matching
// the selector subset the picker produces (CSS + a trailing :has-text()), and
// element fingerprints for fallback matching.

import type { ElLike, Fingerprint } from '../shared/selectors.ts';

/** Elements matching `sel`; supports a trailing procedural `:has-text(text)`. */
export function queryAll(sel: string, root: ParentNode = document): Element[] {
  const at = sel.lastIndexOf(':has-text(');
  try {
    if (at >= 0 && sel.endsWith(')')) {
      const base = sel.slice(0, at) || '*';
      const text = sel.slice(at + 10, -1);
      return [...root.querySelectorAll(base)].filter((el) => (el.textContent ?? '').includes(text));
    }
    return [...root.querySelectorAll(sel)];
  } catch {
    return [];
  }
}

export function fingerprintOf(el: Element): Fingerprint {
  const r = el.getBoundingClientRect();
  const rect = r.width || r.height ? { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) } : null;
  return { tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), rect };
}

/** Lazy ElLike view of a DOM element (for selector generation). */
export function elLike(el: Element, cache = new WeakMap<Element, ElLike>()): ElLike {
  const hit = cache.get(el);
  if (hit) return hit;
  const view: ElLike = {
    tagName: el.tagName.toLowerCase(),
    id: el.id,
    classes: [...el.classList],
    attrs: [...el.attributes].map((a) => [a.name, a.value] as const),
    get parent() {
      return el.parentElement ? elLike(el.parentElement, cache) : null;
    },
    get children() {
      return [...el.children].map((c) => elLike(c, cache));
    },
    get text() {
      return el.textContent ?? '';
    },
  };
  cache.set(el, view);
  return view;
}
