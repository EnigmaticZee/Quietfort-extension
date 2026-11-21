// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// List items for site exceptions and picker rules (popup and options page).

import type { SiteException } from '../shared/exceptions.ts';
import type { PickerRule } from '../shared/selectors.ts';

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);

export function expiryText(e: SiteException, now: number): string {
  if (e.expiresAt === null) return 'permanent';
  const ms = e.expiresAt - now;
  if (ms <= 0) return 'expired';
  const d = Math.floor(ms / 86400000);
  const h = Math.round((ms % 86400000) / 3600000);
  return d ? `expires in ${d} day${d === 1 ? '' : 's'}${h ? ` ${h} h` : ''}` : `expires in ${Math.max(1, h)} h`;
}

function button(label: string, cls: string, onClick: () => Promise<void>): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.className = cls;
  b.addEventListener('click', () => {
    b.disabled = true;
    void onClick();
  });
  return b;
}

export function exceptionItem(e: SiteException, now: number, after: () => Promise<void>, showSite = false): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'exception';
  li.dataset.id = e.id;
  const rule = document.createElement('code');
  rule.textContent = e.rule;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${showSite ? `${e.site} · ` : ''}Exception: ${e.lines.join('  ')} · added ${new Date(e.createdAt).toLocaleDateString()} · ${expiryText(e, now)}`;
  meta.title = e.reason;
  li.append(rule, meta, button('Undo', 'undo', async () => {
    await api.runtime.sendMessage({ type: 'fix:undo', id: e.id });
    await after();
  }));
  if (e.expiresAt !== null) {
    li.append(button('Make permanent', 'permanent', async () => {
      await api.runtime.sendMessage({ type: 'fix:permanent', id: e.id });
      await after();
    }));
  }
  return li;
}

export function pickerItem(r: PickerRule, after: () => Promise<void>, showSite = false): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'picker-rule';
  li.dataset.id = r.id;
  const rule = document.createElement('code');
  rule.textContent = `${r.site}##${r.selectors[r.active]}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const fb = r.selectors.length - 1;
  meta.textContent = `${showSite ? `${r.site} · ` : ''}Hidden element · ${fb} fallback${fb === 1 ? '' : 's'}${r.active ? ' · switched to a fallback' : ''}`;
  meta.title = r.selectors.join('\n');
  li.append(rule, meta, button('Remove', 'remove', async () => {
    await api.runtime.sendMessage({ type: 'picker:remove', id: r.id });
    await after();
  }));
  return li;
}
