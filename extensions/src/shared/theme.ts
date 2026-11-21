// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Quietfort themes for the extension pages (popup, settings, warning page):
// Light (default), Fort Night, macOS Graphite. Same names and colours as the Mac app.

const api: typeof chrome = ((globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome);

export const THEMES = [
  ['light', 'Light'],
  ['fortNight', 'Fort Night'],
  ['graphite', 'macOS Graphite'],
] as const;
export type Theme = (typeof THEMES)[number][0];

function set(theme: string | undefined): void {
  if (theme && theme !== 'light' && THEMES.some(([id]) => id === theme)) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

/** Reads the saved theme and applies it to <html>. Light when unset or unreadable. */
export async function applyTheme(): Promise<Theme> {
  try {
    const { theme } = (await api.storage.local.get('theme')) as { theme?: Theme };
    set(theme);
    return theme ?? 'light';
  } catch {
    return 'light';
  }
}

export async function saveTheme(theme: Theme): Promise<void> {
  set(theme);
  await api.storage.local.set({ theme });
}
