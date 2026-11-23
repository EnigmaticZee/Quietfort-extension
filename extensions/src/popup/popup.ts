// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { exceptionItem, pickerItem } from './fixes-view.ts';
import { applyTheme } from '../shared/theme.ts';
import type { SiteException } from '../shared/exceptions.ts';
import type { PickerRule } from '../shared/selectors.ts';

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);

interface State {
  platform: string;
  host: string | null;
  site: string | null;
  enabled: boolean;
  blocked: number;
  kinds?: Record<Kind, number>;
  popupsBlocked: number;
  lists: Record<string, { fetchedAt: number | null; error: string | null }>;
  dnr: { installed: number; dropped: number; rejected: number } | null;
  hostAccess: boolean;
  /** Safari: the companion app's content blockers that are on. */
  contentBlockers?: { on: number; total: number; error: boolean } | null;
  cookieBanners: boolean;
  consent: { cmp: string | null; popup: boolean; optOut: boolean | null; done: boolean; cosmetic: boolean; refusedPaywall?: boolean } | null;
  suggestFix: boolean;
  exceptions: SiteException[];
  picker: PickerRule[];
  fix: FixStatus;
  now: number;
  /** Paused everywhere until (ms), 0 when not paused. */
  pausedUntil: number;
  error?: string;
}

interface FixStatus {
  active: boolean;
  phase: string;
  mode?: string;
  step?: number;
  total?: number;
  testing?: string[];
  question?: boolean;
  confirm?: boolean;
  result?: SiteException[] | null;
  message?: string | null;
}

const $ = (id: string) => document.getElementById(id)!;

type Kind = 'ads' | 'trackers' | 'danger' | 'other';
const KINDS: Kind[] = ['ads', 'trackers', 'danger', 'other'];
const SVG = 'http://www.w3.org/2000/svg';

/** The ring around the count: one arc per kind, with a small gap between arcs. */
function drawRing(kinds: Record<Kind, number> | null, full = false): void {
  const svg = $('ring');
  svg.textContent = '';
  const size = 104, stroke = 10, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const arc = (colour: string, len: number, offset: number, round: boolean) => {
    const el = document.createElementNS(SVG, 'circle');
    el.setAttribute('cx', '52');
    el.setAttribute('cy', '52');
    el.setAttribute('r', String(r));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', colour);
    el.setAttribute('stroke-width', String(stroke));
    if (round) el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-dasharray', `${len} ${c}`);
    el.setAttribute('stroke-dashoffset', String(-offset));
    el.setAttribute('transform', 'rotate(-90 52 52)');
    svg.appendChild(el);
  };
  arc('var(--quiet)', c, 0, false);
  if (full) return arc('var(--accent)', c, 0, false);
  const parts = KINDS.map((k) => [k, kinds?.[k] ?? 0] as const).filter(([, n]) => n > 0);
  const total = parts.reduce((a, [, n]) => a + n, 0);
  if (!total) return;
  // Round caps reach stroke/2 past each end, so leave that much (plus a gap) between arcs.
  const gap = parts.length > 1 ? stroke + 3 : 0;
  let off = gap / 2;
  for (const [k, n] of parts) {
    const len = (c * n) / total;
    arc(`var(--k-${k})`, Math.max(len - gap, 0.01), off, true);
    off += len;
  }
}

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  // `?tabId=N` lets the page be opened in a tab for diagnostics and tests.
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  if (forced) return api.tabs.get(forced);
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render(): Promise<void> {
  const tab = await activeTab();
  if (tab?.id === undefined) return;
  // The switch stays disabled (and shows no guess) until the real state arrives.
  const s = (await api.runtime.sendMessage({ type: 'popup:getState', tabId: tab.id }).catch(() => null)) as State | null;
  if (!s || s.error) {
    $('host').textContent = 'Unavailable';
    $('toggle-label').textContent = 'Couldn\u2019t read this site\u2019s setting. Close and reopen this panel.';
    return;
  }
  $('host').textContent = s.host ?? 'This page';
  const na = !s.host;
  const fav = $('fav');
  if (na) fav.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 17.5l11-11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  else fav.textContent = s.host!.replace(/^www\./, '').charAt(0);
  $('summary').classList.toggle('na', na);
  $('na-note').hidden = !na;
  // Hide, Zap, Fix site and the describe field act on the page, so they can't work here.
  // Pause and the cookie switch are global and stay usable.
  for (const id of ['pick', 'zap', 'fix', 'describe-text', 'describe-go']) ($(id) as HTMLButtonElement | HTMLInputElement).disabled = na;
  $('describe-form').classList.toggle('off', na);
  $('access').hidden = s.hostAccess;
  const cb = s.contentBlockers;
  $('cb-off').hidden = !cb || (cb.on === cb.total && !cb.error);
  if (cb && cb.on < cb.total) $('cb-off-text').textContent = `${cb.total - cb.on} of ${cb.total} Quietfort Rules sets are off in Safari, so most filter-list rules are not applied.`;
  else if (cb?.error) $('cb-off-text').textContent = 'Safari could not load some of the blocking rules. They will be retried.';
  $('grant').onclick = async () => {
    // Must run in the click handler (user gesture). Safari ignores the request: show its own setting instead.
    if (await api.permissions.request({ origins: ['<all_urls>'] }).catch(() => false)) window.location.reload();
    else $('grant-help').hidden = false;
  };
  if (s.platform === 'safari') $('grant-help').hidden = false;
  const toggle = $('toggle') as HTMLInputElement;
  toggle.checked = s.enabled;
  toggle.disabled = !s.host || !!s.pausedUntil;
  $('toggle-label').textContent = !s.host ? 'Can\u2019t run on this page' : s.pausedUntil ? `Paused ${untilText(s.pausedUntil)}` : s.enabled ? 'Protected' : 'Off on this site';
  $('toggle-label').className = `state${s.pausedUntil ? ' paused' : s.host && s.enabled ? ' on' : ''}`;
  $('summary').classList.toggle('paused', !!s.pausedUntil);
  renderPause(s, tab.id);
  void renderFullProtection(tab.id);
  const safari = s.platform === 'safari';
  $('log-open').hidden = safari;
  $('acts').classList.toggle('single', safari);
  const active = s.enabled && !!s.host && !s.pausedUntil;
  const big = $('blocked');
  if (safari) {
    // Safari doesn't tell extensions which requests its content blocker stopped, so a
    // count would always read 0. Show that blocking is active instead of a wrong number.
    big.textContent = active ? 'On' : 'Off';
    $('blocked-label').textContent = 'blocking';
    drawRing(null, active);
  } else {
    big.textContent = s.blocked > 9999 ? `${Math.floor(s.blocked / 1000)}k` : String(s.blocked);
    $('blocked-label').textContent = 'blocked';
    drawRing(s.kinds ?? null);
  }
  big.classList.toggle('long', big.textContent.length > 3);
  $('safari-counts').hidden = !safari;
  for (const k of KINDS) {
    $(`n-${k}`).textContent = String(s.kinds?.[k] ?? 0);
    ($(`n-${k}`).parentElement as HTMLElement).hidden = safari || (k === 'danger' && !s.kinds?.danger);
  }
  $('popups').textContent = String(s.popupsBlocked);
  const lists = Object.entries(s.lists);
  const newest = Math.max(0, ...lists.map(([, l]) => l.fetchedAt ?? 0));
  const errors = lists.filter(([, l]) => l.error).map(([id]) => id);
  let status = lists.length ? `Filter lists updated ${ago(newest || null)}` : 'Filter lists not downloaded yet';
  if (errors.length) status += ` · update failed: ${errors.join(', ')}`;
  if (s.dnr) status += ` · ${s.dnr.installed.toLocaleString()} rules`;
  $('status').textContent = status;
  $('status').title = s.dnr?.dropped ? `${s.dnr.dropped.toLocaleString()} list rules can\u2019t be used in this browser and were skipped.` : '';

  renderCookies(s);
  renderFix(s.fix, tab.id, s.suggestFix);
  renderFixes(s);

  toggle.onchange = async () => {
    if (!s.site) return;
    const enabled = toggle.checked;
    toggle.disabled = true;
    $('toggle-label').textContent = enabled ? 'Turning blocking on…' : 'Turning blocking off…';
    // Resolves once the change is in effect (in Safari: once its content blockers have it),
    // so the reload below shows the page with the new setting.
    const res = (await api.runtime.sendMessage({ type: 'popup:setEnabled', site: s.site, enabled }).catch((err) => ({ error: String(err) }))) as { ok?: boolean; error?: string };
    if (!res?.ok) {
      toggle.checked = !enabled;
      toggle.disabled = false;
      $('toggle-label').textContent = 'That didn\u2019t work. Try again.';
      return;
    }
    await api.tabs.reload(tab.id!);
    window.close();
  };
}

function untilText(ts: number): string {
  if (ts > Date.now() + 365 * 86400000) return 'until you turn it back on';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `until ${time}` : `until ${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
}

/** Chrome: the lists' page fixes for this site wait for Chrome's "Allow User Scripts" switch. */
async function renderFullProtection(tabId: number): Promise<void> {
  const f = (await api.runtime.sendMessage({ type: 'fp:status', tabId }).catch(() => null)) as { gated: boolean; on: boolean; waiting: number } | null;
  $('fullprot').hidden = !f || !f.gated || f.on || f.waiting === 0;
  $('fullprot-go').onclick = () => {
    void api.runtime.sendMessage({ type: 'fp:start' });
    if (!new URLSearchParams(location.search).get('tabId')) setTimeout(() => window.close(), 300);
  };
}

function renderPause(s: State, tabId: number): void {
  const paused = !!s.pausedUntil;
  $('pause-label').textContent = paused ? 'Resume' : 'Pause';
  $('pause-icon').toggleAttribute('hidden', paused);
  $('play-icon').toggleAttribute('hidden', !paused);
  $('pause-open').title = paused ? 'Turn blocking back on everywhere' : 'Pause blocking on every site';
  document.querySelector('.rounds')!.classList.toggle('dimmed', paused);
  const set = async (minutes: number) => {
    await api.runtime.sendMessage({ type: 'pause:set', minutes });
    $('pause-menu').hidden = true;
    await api.tabs.reload(tabId).catch(() => undefined);
    await render();
  };
  $('pause-open').onclick = () => {
    if (paused) void set(0);
    else $('pause-menu').hidden = !$('pause-menu').hidden;
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>('#pause-menu button')) {
    b.onclick = () => {
      let m = Number(b.dataset.minutes);
      if (b.dataset.minutes === 'tomorrow') {
        const t = new Date();
        t.setHours(24, 0, 0, 0);
        m = Math.max(1, Math.round((t.getTime() - Date.now()) / 60000));
      }
      void set(m);
    };
  }
  $('log-open').onclick = () => {
    void api.tabs.create({ url: api.runtime.getURL(`log.html?tabId=${tabId}`) });
    window.close();
  };
  // Start loading the on-device model (if it is downloaded) while the person types.
  ($('describe-text') as HTMLInputElement).addEventListener('focus', () => { void api.runtime.sendMessage({ type: 'ai:warm' }).catch(() => undefined); }, { once: true });
  ($('describe-form') as HTMLFormElement).onsubmit = async (ev) => {
    ev.preventDefault();
    const input = $('describe-text') as HTMLInputElement;
    const text = input.value.trim();
    const st = $('describe-status');
    if (!text) {
      input.focus();
      return;
    }
    ($('describe-go') as HTMLButtonElement).disabled = true;
    st.hidden = false;
    st.textContent = 'Looking…';
    const slow = setTimeout(() => { st.textContent = 'Looking… The first search after starting the browser takes a few seconds.'; }, 2500);
    const res = (await api.runtime.sendMessage({ type: 'popup:describe', tabId, text }).catch((err) => ({ ok: false, error: String(err) }))) as { ok: boolean; found?: boolean; error?: string };
    clearTimeout(slow);
    ($('describe-go') as HTMLButtonElement).disabled = false;
    if (!res?.ok) st.textContent = `Couldn\u2019t look at this page: ${res?.error ?? 'unknown error'}`;
    else if (!res.found) st.textContent = 'Nothing on this page matches that. Try other words, or use \u201cHide\u201d.';
    else {
      st.textContent = 'Found it. Check the highlighted part on the page and press Hide.';
      if (!new URLSearchParams(location.search).get('tabId')) setTimeout(() => window.close(), 900);
    }
  };
}

function renderCookies(s: State): void {
  const toggle = $('cookie-toggle') as HTMLInputElement;
  toggle.checked = s.cookieBanners;
  toggle.onchange = async () => {
    toggle.disabled = true;
    await api.runtime.sendMessage({ type: 'settings:set', cookieBanners: toggle.checked });
    toggle.disabled = false;
    await render();
  };
  const c = s.consent;
  const st = $('cookie-status');
  let text = '';
  if (s.cookieBanners && c?.cmp) {
    const name = c.cmp.replace(/^auto_.*/, 'site rule');
    // (autoconsent still reports success when its click was refused.)
    if (c.refusedPaywall) text = `This banner's “reject” means subscribing or signing in, so it was left for you to decide.`;
    else if (c.optOut === true) text = c.cosmetic ? `Cookie banner hidden (${name}).` : `Cookie banner rejected (${name}).`;
    else if (c.done && c.cosmetic) text = `Cookie banner hidden (${name}).`;
    else if (c.optOut === false) text = `Found a cookie banner (${name}) but could not reject it.`;
    else if (c.popup) text = `Rejecting the cookie banner (${name})…`;
  }
  st.textContent = text;
  st.hidden = !text;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function renderFix(f: FixStatus, tabId: number, suggest: boolean): void {
  const running = f.active;
  $('suggest').hidden = !suggest || running;
  ($('fix') as HTMLButtonElement).disabled = running || $('summary').classList.contains('na');
  $('fix-progress').hidden = !running;
  $('fix-question').hidden = !f.question;
  if (running) {
    const n = f.testing?.length ?? 0;
    $('fix-text').textContent = f.question
      ? f.confirm
        ? `Step ${f.step}: ${n === 1 ? 'one rule is' : `${n} rules are`} switched off on this site. Check the page.`
        : `Step ${f.step}: ${n} of ${f.total} rules switched off on this site. Check the page.`
      : `Step ${f.step}: reloading with ${n} of ${f.total} rules switched off${f.mode === 'auto' ? ' (checking the page error automatically)' : ''}…`;
  }
  const res = $('fix-result');
  if (f.phase === 'done' && f.result?.length) {
    res.hidden = false;
    res.textContent = `Fixed. ${f.result.length === 1 ? 'This rule is' : 'These rules are'} switched off on this site for 7 days: ${f.result.map((e) => e.rule).join(', ')}`;
  } else if ((f.phase === 'failed' || f.phase === 'cancelled') && f.message) {
    res.hidden = false;
    res.textContent = f.message;
  } else res.hidden = true;
  if (pollTimer) clearTimeout(pollTimer);
  if (running && !f.question) pollTimer = setTimeout(() => void render(), 700);
  $('fix').onclick = async () => {
    ($('fix') as HTMLButtonElement).disabled = true;
    // `?mode=ask|auto` (diagnostics, tests) forces the decision mode.
    const mode = new URLSearchParams(location.search).get('mode') ?? undefined;
    renderFix((await api.runtime.sendMessage({ type: 'fix:start', tabId, mode })) as FixStatus, tabId, false);
  };
  const reply = (works: boolean) => async () => {
    $('fix-question').hidden = true;
    const next = (await api.runtime.sendMessage({ type: 'fix:answer', tabId, works })) as FixStatus;
    await render();
    void next;
  };
  $('fix-yes').onclick = reply(true);
  $('fix-no').onclick = reply(false);
  $('fix-cancel').onclick = async () => {
    await api.runtime.sendMessage({ type: 'fix:cancel', tabId });
    await render();
  };
  $('pick').onclick = async () => {
    await api.runtime.sendMessage({ type: 'popup:pick', tabId });
    if (!new URLSearchParams(location.search).get('tabId')) window.close();
  };
  $('zap').onclick = async () => {
    await api.runtime.sendMessage({ type: 'popup:zap', tabId });
    if (!new URLSearchParams(location.search).get('tabId')) window.close();
  };
  $('zap').title = 'Click things on the page to remove them until you reload';
}

function renderFixes(s: State): void {
  const list = $('fix-list');
  list.textContent = '';
  for (const e of s.exceptions) list.appendChild(exceptionItem(e, s.now, render));
  for (const r of s.picker) list.appendChild(pickerItem(r, render));
  $('fixes').hidden = !s.exceptions.length && !s.picker.length;
}

$('report').addEventListener('click', () => {
  $('report-done').hidden = true;
  $('report-form').hidden = !$('report-form').hidden;
  if (!$('report-form').hidden) ($('report-note') as HTMLTextAreaElement).focus();
});

$('report-send').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id === undefined) return;
  const note = ($('report-note') as HTMLTextAreaElement).value;
  const res = (await api.runtime.sendMessage({ type: 'popup:report', tabId: tab.id, note })) as { id?: string; error?: string };
  $('report-form').hidden = true;
  $('report-done').hidden = false;
  $('report-done').textContent = res.id
    ? 'Thanks. The report was saved on this device; sending reports is not available yet.'
    : `Could not save the report: ${res.error ?? 'unknown error'}`;
});

void applyTheme();
void render();
