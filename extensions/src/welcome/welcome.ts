// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Welcome page (opened once on install): what Quietfort does, the theme choice,
// host access where the browser withholds it (Firefox, Safari), list download progress.

import { applyTheme, saveTheme, type Theme } from '../shared/theme.ts';

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);
const $ = (id: string) => document.getElementById(id)!;

async function access(): Promise<void> {
  let ok = true;
  try {
    ok = (await api.permissions.contains({ origins: ['<all_urls>'] })) || (await api.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }));
  } catch {
    /* not supported */
  }
  $('access').hidden = ok;
  $('grant').onclick = async () => {
    if (await api.permissions.request({ origins: ['<all_urls>'] })) $('access').hidden = true;
  };
}

async function status(): Promise<void> {
  const v = (await api.runtime.sendMessage({ type: 'lists:get' }).catch(() => null)) as {
    catalogue?: Array<{ enabled: boolean; status: { fetchedAt: number | null; error: string | null } | null }>;
    dnr?: { installedDynamic: number; installedSession: number } | null;
  } | null;
  const on = (v?.catalogue ?? []).filter((e) => e.enabled);
  const ready = on.filter((e) => e.status?.fetchedAt).length;
  const failed = on.filter((e) => e.status?.error && !e.status.fetchedAt).length;
  const rules = v?.dnr ? v.dnr.installedDynamic + v.dnr.installedSession : 0;
  $('status').textContent = !on.length
    ? 'Filter lists: downloading…'
    : ready < on.length
      ? `Filter lists: ${ready} of ${on.length} downloaded${failed ? ` (${failed} will retry)` : ''}…`
      : `Filter lists ready${rules ? ` · ${rules.toLocaleString()} rules active` : ''}.`;
  if (ready < on.length || !on.length) setTimeout(() => void status(), 2000);
}

void (async () => {
  const theme = await applyTheme();
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=theme]')) {
    r.checked = r.value === theme;
    r.onchange = () => void saveTheme(r.value as Theme);
  }
})();
/** Chrome: offer full protection (the "Allow User Scripts" switch) and show when it is on. */
async function fullProtection(): Promise<void> {
  const f = (await api.runtime.sendMessage({ type: 'fp:status' }).catch(() => null)) as { gated: boolean; on: boolean } | null;
  $('fullprot').hidden = !f?.gated || f.on;
  $('fullprot-done').hidden = !f?.gated || !f.on;
  $('fullprot-go').onclick = () => void api.runtime.sendMessage({ type: 'fp:start' });
  if (f?.gated && !f.on) setTimeout(() => void fullProtection(), 2000);
}

void access();
void status();
void fullProtection();
