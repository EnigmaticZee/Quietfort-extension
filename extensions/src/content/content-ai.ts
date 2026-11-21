// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// The opt-in on-device AI features (sponsored filter, scam warning, cookie click
// plans), kept out of the content script that runs in every frame of every page:
// the background injects this file only into frames where one of them is on
// (cs:aiWanted). Same isolated world as content.ts.

import { frameBoxes, startAi } from './ai.ts';

(() => {
  const g = globalThis as unknown as { __adbAiStarted?: boolean; browser?: typeof chrome };
  if (g.__adbAiStarted) return;
  g.__adbAiStarted = true;
  const api: typeof chrome = g.browser ?? chrome;
  // In a subframe only the cookie plans, and only for a large, visible consent dialog acting on its own document.
  if (window === window.top) {
    startAi(api);
    // The background asks whether a consent iframe of some origin is really shown in this page.
    api.runtime.onMessage.addListener((m: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      const msg = m as { type?: string; origin?: unknown } | null;
      if (msg?.type !== 'bg:frameBoxes' || typeof msg.origin !== 'string') return false;
      sendResponse({ verdict: frameBoxes(msg.origin) });
      return false;
    });
  } else startAi(api, true);
})();
