// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Options page: every site exception and picker rule, with undo / make permanent / remove.

import { exceptionItem, pickerItem } from '../popup/fixes-view.ts';
import type { SiteException } from '../shared/exceptions.ts';
import type { PickerRule } from '../shared/selectors.ts';
import { startE2eAgent } from '../shared/e2e-agent.ts';
import { applyTheme, saveTheme, type Theme } from '../shared/theme.ts';

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);
const $ = (id: string) => document.getElementById(id)!;

async function render(): Promise<void> {
  const s = (await api.runtime.sendMessage({ type: 'fix:list' })) as { exceptions: SiteException[]; picker: PickerRule[]; now: number };
  const ex = $('exceptions');
  ex.textContent = '';
  for (const e of s.exceptions) ex.appendChild(exceptionItem(e, s.now, render, true));
  $('no-exceptions').hidden = s.exceptions.length > 0;
  const pk = $('picker');
  pk.textContent = '';
  for (const r of s.picker) pk.appendChild(pickerItem(r, render, true));
  $('no-picker').hidden = s.picker.length > 0;
}

interface SettingsView {
  cookieBanners: boolean;
  privacy: { gpc: boolean; trimReferrer: boolean; stripClientData: boolean };
  ai: { sponsored: boolean; scam: boolean; cookiePlans: boolean };
  model: string;
  platform: string;
}

const MODEL_TEXT: Record<string, string> = {
  available: 'Model: ready on this device.',
  downloadable: 'Model: supported, not downloaded yet.',
  downloading: 'Model: downloading…',
  unavailable: 'Model: not available on this device or browser — rule-based mode.',
  'no-api': 'Model: this browser has no built-in language model (Prompt API) — rule-based mode.',
};

function bindToggle(id: string, get: (s: SettingsView) => boolean, patch: (v: boolean) => Record<string, unknown>, s: SettingsView): void {
  const el = $(id) as HTMLInputElement;
  el.checked = get(s);
  el.onchange = async () => {
    el.disabled = true;
    const r = (await api.runtime.sendMessage({ type: 'settings:set', ...patch(el.checked) })) as SettingsView;
    el.checked = get(r);
    el.disabled = false;
  };
}

async function renderSettings(): Promise<void> {
  const s = (await api.runtime.sendMessage({ type: 'settings:get' })) as SettingsView;
  bindToggle('cookie-toggle', (x) => x.cookieBanners, (v) => ({ cookieBanners: v }), s);
  bindToggle('gpc-toggle', (x) => x.privacy.gpc, (v) => ({ privacy: { gpc: v } }), s);
  bindToggle('referrer-toggle', (x) => x.privacy.trimReferrer, (v) => ({ privacy: { trimReferrer: v } }), s);
  bindToggle('clientdata-toggle', (x) => x.privacy.stripClientData, (v) => ({ privacy: { stripClientData: v } }), s);
  bindToggle('ai-sponsored', (x) => x.ai.sponsored, (v) => ({ ai: { sponsored: v } }), s);
  bindToggle('ai-scam', (x) => x.ai.scam, (v) => ({ ai: { scam: v } }), s);
  bindToggle('ai-cookie', (x) => x.ai.cookiePlans, (v) => ({ ai: { cookiePlans: v } }), s);
  if (s.platform === 'firefox') {
    $('clientdata-note').textContent = 'Firefox does not send this header; nothing to remove.';
    $('referrer-note').textContent = 'Other sites learn only which site you came from, not the page (rewritten on every third-party request).';
  } else if (s.platform === 'safari') {
    $('referrer-note').textContent = 'Not available in Safari (no response-header conditions in its rule engine).';
    $('clientdata-note').textContent = 'Safari does not send this header.';
  }
  $('ai-model').textContent = MODEL_TEXT[s.model] ?? `Model: ${s.model}`;
  const dl = $('ai-download') as HTMLButtonElement;
  dl.hidden = s.model !== 'downloadable';
  dl.onclick = async () => {
    // Needs a user click (Prompt API rule); runs in this extension page only.
    const LM = (globalThis as unknown as { LanguageModel?: { create(o: unknown): Promise<{ destroy(): void }> } }).LanguageModel;
    if (!LM) return;
    dl.disabled = true;
    try {
      const session = await LM.create({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        monitor(m: EventTarget) {
          m.addEventListener('downloadprogress', (e) => {
            $('ai-download-progress').textContent = `${Math.round(((e as unknown as { loaded: number }).loaded ?? 0) * 100)} %`;
          });
        },
      });
      session.destroy();
      $('ai-download-progress').textContent = 'Done.';
    } catch (err) {
      $('ai-download-progress').textContent = `Download failed: ${String(err)}`;
    }
    dl.disabled = false;
    void (async () => {
  const select = document.getElementById('theme-select') as HTMLSelectElement;
  select.value = await applyTheme();
  select.onchange = () => void saveTheme(select.value as Theme);
})();
void renderSettings();
  };
  $('ai-clear').onclick = async () => {
    await api.runtime.sendMessage({ type: 'ai:clearCache' });
    $('ai-clear-done').textContent = 'Forgotten.';
  };
}

// ---------- filter lists ----------

interface ListStatusView { fetchedAt: number | null; bytes: number; error: string | null }
interface EntryView {
  id: string; name: string; description: string; license: string; homepage: string; url: string; kind: string; category: string;
  defaultOn: boolean; approxBytes: number; note?: string; credit?: string; enabled: boolean; suggested: boolean; status: ListStatusView | null;
}
interface CustomView { id: string; url: string; name: string; enabled: boolean; kind: string; status: ListStatusView | null }
interface ListsView {
  platform: string;
  override: boolean;
  cookieBanners: boolean;
  catalogue: EntryView[];
  custom: CustomView[];
  protection: { hosts: Record<string, number>; total: number; bytes: number; dnrLists: string[]; dnrHosts: number; ms: number; source: string } | null;
  dnr: {
    installedDynamic: number; installedSession: number; limits: Record<string, number>; stats: Record<string, number>;
    droppedByReason: Record<string, number>; rejected: number; protection: { hosts: Record<string, number>; dropped: Record<string, number>; rules: number; regexRules: number; lists?: string[] } | null;
    privacyRules: number; appliedAt: number;
  } | null;
}

const GROUPS: Array<[string, string]> = [
  ['ads', 'Ads'], ['privacy', 'Privacy'], ['cookies', 'Cookie notices'], ['security', 'Malware, phishing & scam protection'],
  ['annoyances', 'Annoyances & social'], ['regional', 'Regional'], ['other', 'Other'],
];

function size(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

function ago(t: number | null): string {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function statusLine(st: ListStatusView | null, approx: number, enabled: boolean, hosts?: number): string {
  const parts: string[] = [];
  parts.push(st?.bytes ? size(st.bytes) : `≈ ${size(approx)}`);
  parts.push(`updated ${ago(st?.fetchedAt ?? null)}`);
  if (hosts !== undefined && enabled) parts.push(`${hosts.toLocaleString()} hosts protected`);
  return parts.join(' · ');
}

function listItem(v: { id: string; name: string; enabled: boolean; status: ListStatusView | null }, extra: (li: HTMLElement) => void, meta: string): HTMLLIElement {
  const li = el('li');
  li.dataset.list = v.id;
  const label = el('label');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = v.enabled;
  cb.dataset.list = v.id;
  cb.onchange = async () => {
    cb.disabled = true;
    await api.runtime.sendMessage({ type: 'lists:set', id: v.id, enabled: cb.checked });
    cb.disabled = false;
    setTimeout(() => void renderLists(), 300);
  };
  const body = el('div');
  body.append(el('span', 'lname', v.name));
  extra(body);
  body.append(el('div', 'meta', meta));
  if (v.status?.error && v.enabled) body.append(el('div', 'err', `Last download failed: ${v.status.error}`));
  label.append(cb, body);
  li.append(label);
  return li;
}

async function renderLists(): Promise<void> {
  const v = (await api.runtime.sendMessage({ type: 'lists:get' })) as ListsView;
  $('lists-override').hidden = !v.override;
  const root = $('lists');
  root.textContent = '';
  const ph = v.protection?.hosts ?? v.dnr?.protection?.hosts ?? {};
  for (const [cat, title] of GROUPS) {
    const entries = v.catalogue.filter((e) => e.category === cat);
    if (!entries.length) continue;
    if (cat === 'regional') entries.sort((a, b) => Number(b.suggested) - Number(a.suggested));
    const g = el('div', 'group');
    g.append(el('h3', undefined, title));
    const ul = el('ul', 'lists');
    for (const e of entries) {
      ul.append(listItem(e, (body) => {
        if (e.suggested) body.append(el('span', 'tag', 'suggested for your language'));
        if (e.id === 'easylist-cookie' && !v.cookieBanners) body.append(el('span', 'tag', 'off while cookie handling is off'));
        body.append(el('div', 'desc', e.description));
        if (e.note) body.append(el('div', 'note', e.note));
      }, `${statusLine(e.status, e.approxBytes, e.enabled, e.kind === 'protection' ? ph[e.id] ?? 0 : undefined)} · licence: ${e.license}${e.credit ? ` · ${e.credit}` : ''}`));
    }
    g.append(ul);
    root.append(g);
  }
  const cu = $('custom-lists');
  cu.textContent = '';
  for (const c of v.custom) {
    const li = listItem(c, (body) => body.append(el('div', 'desc', `${c.url} (${c.kind === 'protection' ? 'dangerous hosts' : 'filter rules'})`)), statusLine(c.status, 0, c.enabled, c.kind === 'protection' ? ph[c.id] ?? 0 : undefined));
    const rm = el('button', 'remove', 'Remove');
    rm.onclick = async () => {
      await api.runtime.sendMessage({ type: 'lists:removeCustom', id: c.id });
      void renderLists();
    };
    li.append(rm);
    cu.append(li);
  }
  // Rule report.
  const lines: string[] = [];
  if (v.platform === 'firefox') {
    lines.push('Firefox: every rule is applied by the extension itself (webRequest) — no browser rule limits.');
    if (v.protection) lines.push(`Protection: ${v.protection.total.toLocaleString()} dangerous hosts (hashed set, ${size(v.protection.bytes)} in memory), checked before any request is sent.`);
  } else if (v.dnr) {
    const d = v.dnr;
    lines.push(`Installed: ${d.installedDynamic.toLocaleString()} dynamic + ${d.installedSession.toLocaleString()} session rules (limits: ${d.limits.dynamic} dynamic, ${d.limits.dynamicUnsafe} unsafe, ${d.limits.session} session, ${d.limits.regex} regex).`);
    lines.push(`Filter-list rules: ${d.stats.dynamicRules ?? 0} dynamic, ${d.stats.sessionRules ?? 0} session, ${d.stats.regexRules ?? 0} regex.`);
    if (d.protection) lines.push(`Protection: ${Object.values(d.protection.hosts).reduce((a, b) => a + b, 0).toLocaleString()} hosts in ${d.protection.rules} rules${Object.keys(d.protection.dropped).length ? `; left out for the limit: ${JSON.stringify(d.protection.dropped)}` : ''}.`);
    if (v.protection) {
      const rest = v.protection.total - v.protection.dnrHosts;
      lines.push(`Protection, all lists: ${v.protection.total.toLocaleString()} dangerous hosts (hashed set, ${size(v.protection.bytes)} in memory)${rest > 0 ? `; about ${rest.toLocaleString()} of them are checked when a page or frame starts loading and sent to the warning page` : ''}.`);
    }
    lines.push(`Privacy header rules: ${d.privacyRules}.`);
    const dropped = Object.entries(d.droppedByReason);
    lines.push(dropped.length ? `Filter rules not installed: ${dropped.map(([k, n]) => `${n} ${k}`).join(', ')}.` : 'Every convertible filter rule is installed.');
    if (d.rejected) lines.push(`${d.rejected} rules rejected by the browser.`);
    lines.push(`Last applied ${ago(d.appliedAt)}.`);
  } else lines.push('Rules not installed yet.');
  $('dnr-report').textContent = lines.join('\n');
}

$('lists-refresh').onclick = async () => {
  ($('lists-refresh') as HTMLButtonElement).disabled = true;
  await api.runtime.sendMessage({ type: 'lists:refresh' });
  ($('lists-refresh') as HTMLButtonElement).disabled = false;
  void renderLists();
};

$('custom-add').onclick = async () => {
  const input = $('custom-url') as HTMLInputElement;
  const r = (await api.runtime.sendMessage({ type: 'lists:addCustom', url: input.value, kind: ($('custom-kind') as HTMLSelectElement).value })) as { ok: boolean; error?: string };
  $('custom-msg').textContent = r.ok ? 'Added; downloading…' : `Not added: ${r.error}`;
  if (r.ok) input.value = '';
  void renderLists();
};

// ---------- My Rules ----------

interface RulesCheck { lines: number; rules: number; problems: Array<{ line: number; text: string; reason: string }> }

function showCheck(c: RulesCheck | undefined, saved: boolean): void {
  const msg = $('rules-msg');
  const ul = $('rules-problems');
  ul.textContent = '';
  if (!c) return;
  msg.textContent = `${saved ? 'Saved. ' : ''}${c.rules} rule${c.rules === 1 ? '' : 's'}${c.problems.length ? `, ${c.problems.length} not used` : ''}.`;
  for (const p of c.problems) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = p.text;
    li.append(`Line ${p.line}: `, code, ` (${p.reason})`);
    ul.appendChild(li);
  }
}

async function renderRules(): Promise<void> {
  const r = (await api.runtime.sendMessage({ type: 'rules:get' })) as { text: string; check: RulesCheck };
  ($('rules-text') as HTMLTextAreaElement).value = r.text;
  showCheck(r.check, false);
}

$('rules-save').onclick = async () => {
  ($('rules-save') as HTMLButtonElement).disabled = true;
  const r = (await api.runtime.sendMessage({ type: 'rules:set', text: ($('rules-text') as HTMLTextAreaElement).value })) as { ok: boolean; error?: string; check?: RulesCheck };
  ($('rules-save') as HTMLButtonElement).disabled = false;
  if (!r.ok) $('rules-msg').textContent = r.error ?? 'Not saved.';
  else showCheck(r.check, true);
};

// ---------- Trusted sites ----------

async function renderSites(sites?: string[]): Promise<void> {
  const list = sites ?? ((await api.runtime.sendMessage({ type: 'sites:get' })) as { sites: string[] }).sites;
  const ul = $('sites');
  ul.textContent = '';
  for (const site of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = site;
    const b = document.createElement('button');
    b.textContent = 'Remove';
    b.onclick = async () => {
      const r = (await api.runtime.sendMessage({ type: 'sites:set', remove: [site] })) as { sites: string[] };
      void renderSites(r.sites);
    };
    li.append(name, b);
    ul.appendChild(li);
  }
  $('no-sites').hidden = list.length > 0;
}

$('site-add').onclick = async () => {
  const input = $('site-add-text') as HTMLInputElement;
  const r = (await api.runtime.sendMessage({ type: 'sites:set', add: [input.value] })) as { ok: boolean; sites: string[]; error?: string };
  $('sites-msg').textContent = r.ok ? '' : r.error ?? 'Not added.';
  if (r.ok) input.value = '';
  void renderSites(r.sites);
};

// ---------- Backup ----------

$('backup-export').onclick = async () => {
  const data = await api.runtime.sendMessage({ type: 'backup:export' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `quietfort-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $('backup-msg').textContent = 'Backup saved to your downloads.';
};

$('backup-import').onclick = () => ($('backup-file') as HTMLInputElement).click();
$('backup-file').onchange = async () => {
  const input = $('backup-file') as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 5_000_000) {
    $('backup-msg').textContent = 'That file is too large to be a Quietfort backup.';
    return;
  }
  const r = (await api.runtime.sendMessage({ type: 'backup:import', text: await file.text() })) as { ok: boolean; error?: string; skipped?: string[]; summary?: string };
  if (!r.ok) {
    $('backup-msg').textContent = r.error ?? 'Not restored.';
    return;
  }
  $('backup-msg').textContent = `Restored: ${r.summary}.${r.skipped?.length ? ` Skipped: ${r.skipped.slice(0, 5).join(', ')}${r.skipped.length > 5 ? '…' : ''}.` : ''}`;
  await applyTheme();
  void renderSettings();
  void render();
  void renderRules();
  void renderSites();
  void renderLists();
};

void renderSettings();
void render();
void renderRules();
void renderSites();
void renderLists();
setInterval(() => {
  if (document.visibilityState === 'visible') void renderLists();
}, 4000);

startE2eAgent('options', () => ({
  lists: document.querySelectorAll('#lists input[type=checkbox]').length,
  gpc: ($('gpc-toggle') as HTMLInputElement).checked,
  cookieBanners: ($('cookie-toggle') as HTMLInputElement).checked,
  model: $('ai-model').textContent,
  dnr: ($('dnr-report').textContent ?? '').slice(0, 600),
}));
