// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Warning page for malware / phishing / scam sites (blocked.html?list=<id>#<url>),
// and the landing page after "Leave page" on a suspected scam (?mode=left).

import { catalogueEntry } from '../shared/catalogue.ts';
import { parseBlockedPageUrl } from '../shared/protection.ts';
import { startE2eAgent } from '../shared/e2e-agent.ts';
import { applyTheme } from '../shared/theme.ts';

void applyTheme();

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);
const $ = (id: string) => document.getElementById(id)!;

const WHAT: Record<string, string> = {
  'blp-phishing': 'phishing',
  'blp-scam': 'scams',
  'blp-fraud': 'fraud',
  'blp-ransomware': 'ransomware',
  'blp-malware': 'malware',
};

const params = new URLSearchParams(location.search);
if (params.get('mode') === 'left') {
  document.title = 'You left a suspicious page';
  $('title').textContent = 'You left a page that looked like a scam';
  $('what').textContent = 'Nothing on that page was sent anywhere. If it asked you to call a number, pay, or install something, don’t.';
  $('continue').hidden = true;
  $('back').textContent = 'Close tab';
  $('back').onclick = () => window.close();
} else {
  const { list, url } = parseBlockedPageUrl(location.href);
  let host = '';
  try {
    host = url ? new URL(url).hostname : '';
  } catch {
    /* ignore */
  }
  $('host').textContent = host || 'this address';
  const entry = list ? catalogueEntry(list) : undefined;
  const what = (list && WHAT[list]) ?? 'phishing or malware';
  $('title').textContent = `This site is known for ${what}`;
  document.title = `Blocked: ${host || 'dangerous site'}`;
  $('source').textContent = entry ? `Blocked by Quietfort · listed by ${entry.name} (${entry.homepage})` : list ? `Blocked by Quietfort · listed by ${list}` : 'Blocked by Quietfort';
  $('back').onclick = () => {
    if (history.length > 1) history.back();
    else location.replace('about:blank');
  };
  const cont = $('continue') as HTMLButtonElement;
  if (!url) cont.hidden = true;
  cont.onclick = async () => {
    cont.disabled = true;
    const r = (await api.runtime.sendMessage({ type: 'protect:continue', url })) as { ok?: boolean; error?: string } | undefined;
    if (r?.ok && url) location.replace(url);
    else {
      $('error').hidden = false;
      $('error').textContent = `Could not continue: ${r?.error ?? 'unknown error'}`;
      cont.disabled = false;
    }
  };
}

startE2eAgent('blocked', () => ({
  title: $('title').textContent,
  host: $('host').textContent,
  hasContinue: !$('continue').hidden,
  error: $('error').hidden ? null : $('error').textContent,
}));
