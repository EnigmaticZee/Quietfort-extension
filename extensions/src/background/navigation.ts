// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// `$urlskip` / `$uritransform` (uBO): when a tab navigates to a tracking link
// whose real destination is inside the URL, go straight there. Top-level
// navigations only; skipped on sites where the user turned blocking off.

import { B, log } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import { disabledSites, getEngine, isDisabledIn } from './state.ts';

export function registerNavigationRules(): void {
  B.webNavigation?.onBeforeNavigate.addListener((d) => {
    if (d.frameId !== 0 || !/^https?:/i.test(d.url)) return;
    void (async () => {
      const engine = await getEngine();
      const target = engine?.navigationTarget(d.url);
      if (!target) return;
      if (isDisabledIn(await disabledSites(), hostOf(d.url))) return;
      try {
        await B.tabs.update(d.tabId, { url: target });
      } catch (err) {
        log('urlskip navigation failed', String(err));
      }
    })();
  });
}
