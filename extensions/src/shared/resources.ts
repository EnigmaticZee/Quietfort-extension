// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// `$redirect` resource names (uBO / AdGuard / ABP spellings) → neutral files we
// wrote ourselves and ship in /resources. Mirrors the Rust resources.rs (tag mac-app-final).

const FILES: Record<string, string[]> = {
  'noop.js': ['noop.js', 'noopjs', 'noop-js', 'abp-resource:blank-js', 'blank-js'],
  'google-analytics_analytics.js': ['google-analytics_analytics.js', 'google-analytics.com/analytics.js', 'google-analytics', 'google-analytics-ga', 'google-analytics_ga.js'],
  'googletagmanager_gtm.js': ['googletagmanager_gtm.js', 'googletagmanager-gtm', 'googletagmanager.com/gtm.js'],
  'googlesyndication_adsbygoogle.js': ['googlesyndication_adsbygoogle.js', 'googlesyndication-adsbygoogle', 'googlesyndication.com/adsbygoogle.js'],
  'googletagservices_gpt.js': ['googletagservices_gpt.js', 'googletagservices-gpt', 'googletagservices.com/gpt.js'],
  'noop.css': ['noop.css', 'noopcss', 'blank-css'],
  '1x1.gif': ['1x1.gif', '1x1-transparent.gif', '1x1-transparent-gif'],
  '2x2.png': ['2x2.png', '2x2-transparent.png', '3x2.png', '3x2-transparent.png', '32x32.png', '32x32-transparent.png'],
  'noop.txt': ['noop.txt', 'nooptext', 'empty', 'blank-text'],
  'noop.html': ['noop.html', 'noopframe', 'blank-html'],
  'noop.json': ['noop.json', 'noopjson'],
  'noop-0.1s.mp3': ['noop-0.1s.mp3', 'noopmp3-0.1s', 'blank-mp3'],
  'noop-1s.mp4': ['noop-1s.mp4', 'noopmp4-1s', 'blank-mp4'],
  'noop-vast2.xml': ['noop-vast2.xml', 'noopvast-2.0'],
  'noop-vast3.xml': ['noop-vast3.xml', 'noopvast-3.0'],
  'noop-vast4.xml': ['noop-vast4.xml', 'noopvast-4.0'],
  'noop-vmap1.xml': ['noop-vmap1.xml', 'noopvmap-1.0', 'noop-vmap1.0.xml'],
  'google-ima.js': ['google-ima.js', 'google-ima3', 'google-ima3.js'],
  'prebid-ads.js': ['prebid-ads.js', 'prebid-ads'],
  'fingerprint2.js': ['fingerprint2.js', 'fingerprintjs2'],
  'fingerprint3.js': ['fingerprint3.js', 'fingerprintjs3'],
  'amazon_apstag.js': ['amazon_apstag.js', 'amazon-apstag', 'amazon_apstag'],
  'fuckadblock-3.2.0.js': ['fuckadblock.js-3.2.0', 'nofab.js', 'prevent-fab-3.2.0', 'nobab2.js', 'nobab.js', 'prevent-bab2', 'prevent-bab'],
  'popads.js': ['popads.js', 'popads.net.js', 'prevent-popads-net'],
  'scorecardresearch_beacon.js': ['scorecardresearch_beacon.js', 'scorecardresearch-beacon'],
};

const ALIASES = new Map<string, string>();
for (const [file, names] of Object.entries(FILES)) for (const n of names) ALIASES.set(n, file);

/** Extension-relative path (`/resources/x`) for a redirect name, or null if we have none. */
export function resourcePath(name: string): string | null {
  let n = name.trim().toLowerCase();
  if (n.startsWith('ubo-')) n = n.slice(4);
  const file = ALIASES.get(n);
  return file ? `/resources/${file}` : null;
}

export const RESOURCE_FILES = Object.keys(FILES);
