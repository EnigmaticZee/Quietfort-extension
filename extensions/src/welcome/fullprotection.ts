// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Full protection page (Chrome): explains the one switch, opens Chrome's page
// for Quietfort, and shows "on" as soon as the switch is turned on.

import { applyTheme } from '../shared/theme.ts';

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);
const $ = (id: string) => document.getElementById(id) as HTMLElement;

type Status = { gated: boolean; on: boolean; waiting: number };

async function status(): Promise<Status | null> {
  return (await api.runtime.sendMessage({ type: 'fp:status' }).catch(() => null)) as Status | null;
}

function show(s: Status): void {
  $('fp-off').hidden = !s.gated || s.on;
  $('fp-on').hidden = !s.gated || !s.on;
  $('fp-na').hidden = s.gated;
  $('fp-title').textContent = s.gated && !s.on ? 'Turn on full protection' : 'Full protection';
  $('fp-lead').textContent = !s.gated ? 'Already on in this browser.' : s.on ? 'Done.' : 'One switch in Chrome.';
  document.title = s.gated && s.on ? 'Full protection is on – Quietfort' : 'Full protection – Quietfort';
}

void (async () => {
  await applyTheme().catch(() => undefined);
  const first = await status();
  if (first) show(first);
  $('fp-open').addEventListener('click', () => void api.runtime.sendMessage({ type: 'fp:start' }));
  // Follow the switch while this page is open.
  setInterval(() => {
    void status().then((s) => s && show(s));
  }, 1500);
})();
