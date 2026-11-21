// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Scriptlet runner in the page's main world, registered at document_start in
// every frame (background/cosmetics.ts). It is present before the page's own
// scripts run, so the scriptlets it is handed can trap properties and wrap
// fetch / XHR / JSON.parse before the page uses them. (Injecting the runtime
// with scripting.executeScript on navigation commit arrives after the first
// inline scripts in every browser, and in Safari after most of the page, so
// e.g. YouTube's inline player data was read before its ad scriptlets ran.)
//
// The isolated content script and the background hand it a configuration as a
// JSON string in a CustomEvent. Its window capture listener is the first one
// registered, so page scripts cannot intercept or cancel the event. Each
// distinct configuration runs once; a page that dispatches its own can only run
// scriptlets on itself, and cannot stop the real configuration from running.

import runtime from '@runtime';
import { SCRIPTLET_EVENT } from '../shared/scriptlet-event.ts';

(() => {
  const seen = new Set<string>();
  window.addEventListener(
    SCRIPTLET_EVENT,
    (ev) => {
      const d = (ev as CustomEvent).detail;
      if (typeof d !== 'string' || seen.has(d) || seen.size > 8) return;
      seen.add(d);
      let cfg: Parameters<typeof runtime>[0];
      try {
        cfg = JSON.parse(d);
      } catch {
        return;
      }
      if (!cfg || typeof cfg !== 'object') return;
      try {
        runtime({ s: Array.isArray(cfg.s) ? cfg.s : [], p: Array.isArray(cfg.p) ? cfg.p : [] });
      } catch {
        /* a scriptlet failing must not break the page */
      }
    },
    true,
  );
})();
