// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// "What was blocked": the requests Quietfort stopped on the page open in a tab
// (from background/tabdata.ts), refreshed while the page is visible.
// Safari does not tell extensions what its content blockers stopped, so this
// page is not offered there.

import { applyTheme } from '../shared/theme.ts';

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);
const $ = (id: string) => document.getElementById(id)!;

interface View {
  platform: string;
  tabs: Array<{ id: number; title: string; host: string; active: boolean }>;
  url: string | null;
  blocked: Array<{ url: string; type: string; src: string | null; rule?: string; at: number }>;
  counts: { requests: number; popups: number } | null;
}

let tabId = Number(new URLSearchParams(location.search).get('tabId')) || -1;
let lastKey = '';

const TRACKER = /(analytics|metrics|telemetry|track|pixel|beacon|collect|stats|scorecard|hotjar|segment|mixpanel|amplitude|fullstory|clarity|quantserve|chartbeat|newrelic|nr-data|sentry|bugsnag|fingerprint)/i;
const AD = /(ads?[.\/_-]|adserv|adsystem|doubleclick|googlesyndication|adnxs|criteo|taboola|outbrain|pubmatic|rubicon|openx|amazon-adsystem|prebid|banner|sponsor|teads|moatads|adform|smartadserver)/i;

function category(url: string, type: string): ['ads' | 'trackers' | 'danger' | 'other', string] {
  if (type === 'main_frame') return ['danger', 'Dangerous site'];
  if (AD.test(url)) return ['ads', 'Ad'];
  if (TRACKER.test(url) || type === 'ping' || type === 'beacon') return ['trackers', 'Tracker'];
  return ['other', 'Blocked'];
}

const TYPE: Record<string, string> = {
  script: 'Script', image: 'Image', xmlhttprequest: 'Data', sub_frame: 'Frame', stylesheet: 'Style', media: 'Media', font: 'Font',
  ping: 'Ping', beacon: 'Ping', websocket: 'Socket', main_frame: 'Page', object: 'Plug-in', other: 'Other', imageset: 'Image',
};

async function load(): Promise<void> {
  const v = (await api.runtime.sendMessage({ type: 'log:get', tabId })) as View;
  const sel = $('tab') as HTMLSelectElement;
  if (tabId < 0) tabId = v.tabs.find((t) => t.active)?.id ?? v.tabs[0]?.id ?? -1;
  const key = v.tabs.map((t) => `${t.id}:${t.host}`).join('|');
  if (key !== lastKey) {
    lastKey = key;
    sel.textContent = '';
    for (const t of v.tabs) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = `${t.host} — ${t.title || 'untitled'}`.slice(0, 90);
      sel.appendChild(o);
    }
  }
  sel.value = String(tabId);
  if (v.blocked.length === 0 && tabId >= 0 && !v.url) {
    // The tab id came from the list; ask again for its data.
    const again = (await api.runtime.sendMessage({ type: 'log:get', tabId })) as View;
    v.blocked = again.blocked;
    v.url = again.url;
    v.counts = again.counts;
  }
  render(v);
}

function render(v: View): void {
  const q = ($('filter') as HTMLInputElement).value.trim().toLowerCase();
  const rows = $('rows');
  rows.textContent = '';
  const items = [...v.blocked].reverse().filter((b) => !q || b.url.toLowerCase().includes(q) || b.type.includes(q));
  const per: Record<string, number> = { ads: 0, trackers: 0, danger: 0, other: 0 };
  for (const b of v.blocked) per[category(b.url, b.type)[0]]!++;
  for (const b of items) {
    const tr = document.createElement('tr');
    const [cls, label] = category(b.url, b.type);
    const when = document.createElement('td');
    when.className = 'when';
    when.textContent = new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const what = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${cls}`;
    pill.textContent = label;
    what.appendChild(pill);
    const type = document.createElement('td');
    type.className = 'type';
    type.textContent = TYPE[b.type] ?? b.type;
    const url = document.createElement('td');
    url.className = 'url';
    url.textContent = b.url.length > 300 ? `${b.url.slice(0, 300)}…` : b.url;
    if (b.rule) url.title = `Rule: ${b.rule}`;
    tr.append(when, what, type, url);
    rows.appendChild(tr);
  }
  $('empty').hidden = items.length > 0;
  const total = v.blocked.length;
  $('summary').textContent = v.url
    ? `${total} request${total === 1 ? '' : 's'} blocked on ${v.url.length > 80 ? `${v.url.slice(0, 80)}…` : v.url}: ${per.ads} ads, ${per.trackers} trackers, ${per.other} other${v.counts?.popups ? ` · ${v.counts.popups} pop-ups closed` : ''}.`
    : 'Choose a tab.';
}

$('tab').addEventListener('change', () => {
  tabId = Number(($('tab') as HTMLSelectElement).value);
  void load();
});
$('filter').addEventListener('input', () => void load());

void applyTheme();
void load();
setInterval(() => {
  if (document.visibilityState === 'visible') void load();
}, 2000);
