// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Built-in filter-list catalogue. Every list is downloaded at runtime from its
// maintainer and kept only in this browser profile; nothing here is list
// content (the build refuses to ship list text). Only permissively usable
// sources are listed — no non-commercial-only lists (Peter Lowe, Dan Pollock,
// Disconnect, Tracker Radar, URLhaus, OpenPhish, PhishTank).
//
// kind 'filters'    → ABP/uBO syntax (or hosts) fed to the filter engine.
// kind 'protection' → hosts-format lists of malicious sites: top-level
//                     navigations go to the warning page, everything else
//                     from those hosts is blocked.

export type ListKind = 'filters' | 'protection';
export type ListCategory = 'ads' | 'privacy' | 'cookies' | 'security' | 'annoyances' | 'regional' | 'other';

export interface CatalogueEntry {
  id: string;
  name: string;
  description: string;
  /** Licence as stated by the maintainer (for display; lists are never redistributed). */
  license: string;
  homepage: string;
  url: string;
  kind: ListKind;
  category: ListCategory;
  /** On unless the user turns it off (regional lists: on when they match the browser language). */
  defaultOn: boolean;
  /** Platforms where `defaultOn` does not apply (the list starts off there). */
  offByDefaultOn?: string[];
  /** Regional lists: the browser languages (primary subtags) they are suggested for. */
  langs?: string[];
  /** Approximate size when last checked, shown until the list has been downloaded. */
  approxBytes: number;
  /** Extra caution shown in the chooser. */
  note?: string;
  /** Who maintains the list, shown in the chooser (credit for third-party lists). */
  credit?: string;
  /**
   * The maintainers' own list from their official URL: may use trusted-only
   * scriptlets (trusted-set-cookie, trusted-click-element...), as it can in uBO
   * and AdGuard. Never set for lists we don't know the maintainer of.
   */
  trusted?: boolean;
}

const EL_LICENCE = 'GPL-3.0 or CC BY-SA 3.0';
const BLP = 'Unlicense (repository; file header says MIT)';
const blp = (name: string, id: string, title: string, description: string, approxBytes: number, defaultOn: boolean, note?: string): CatalogueEntry => ({
  id,
  name: title,
  description,
  license: BLP,
  homepage: 'https://github.com/blocklistproject/Lists',
  url: `https://blocklistproject.github.io/Lists/${name}.txt`,
  kind: 'protection',
  category: 'security',
  defaultOn,
  approxBytes,
  ...(note ? { note } : {}),
});
const regional = (id: string, name: string, url: string, langs: string[], approxBytes: number, license = EL_LICENCE): CatalogueEntry => ({
  id,
  name,
  description: `Ads on ${name.replace(/^EasyList |^Liste /, '')}-language websites (supplements EasyList).`,
  license,
  homepage: 'https://easylist.to/pages/other-supplementary-filter-lists-and-easylist-variants.html',
  url,
  kind: 'filters',
  category: 'regional',
  defaultOn: false,
  langs,
  approxBytes,
});

// uBlock Origin's and AdGuard's own lists (GPL-3.0). Downloaded unmodified, at
// runtime, from the maintainers' GitHub-hosted URLs — never bundled or copied.
// uBO: the pre-assembled `.min.txt` builds (includes resolved) from GitHub Pages.
// AdGuard: FiltersRegistry's `extension/ublock` builds (uBO syntax), which our
// engine parses best. AdGuard Tracking Protection is not offered: at ~440,000
// rules it needs ~500 MB in the extension and almost none fits Chrome's DNR.
const GPL3 = 'GPL-3.0';
const UBO_CREDIT = 'by the uBlock Origin team (github.com/uBlockOrigin/uAssets)';
const ADG_CREDIT = 'by AdGuard (github.com/AdguardTeam/AdguardFilters)';
const ubo = (file: string, id: string, name: string, description: string, category: ListCategory, approxBytes: number, note?: string): CatalogueEntry => ({
  id, name, description, license: GPL3, homepage: 'https://github.com/uBlockOrigin/uAssets',
  url: `https://ublockorigin.github.io/uAssets/filters/${file}`, kind: 'filters', category, defaultOn: false, approxBytes,
  credit: UBO_CREDIT, trusted: true, ...(note ? { note } : {}),
});
const adg = (filterId: number, id: string, name: string, description: string, category: ListCategory, approxBytes: number, note?: string): CatalogueEntry => ({
  id, name, description, license: GPL3, homepage: 'https://github.com/AdguardTeam/AdguardFilters',
  url: `https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/platforms/extension/ublock/filters/${filterId}.txt`,
  kind: 'filters', category, defaultOn: false, approxBytes, credit: ADG_CREDIT, trusted: true, ...(note ? { note } : {}),
});

/**
 * On by default in Chrome and Firefox (measured 2026-11-17 on 89 sites x 3
 * loads): with these on, no "turn off your ad blocker" walls (4 sites had one
 * with EasyList/EasyPrivacy alone), about 45 % fewer leftover ad boxes, no
 * extra breakage and no slowdown.
 */
const DEFAULT_ON_LISTS = new Set(['ubo-filters', 'ubo-privacy', 'ubo-badware', 'ubo-quick-fixes', 'ubo-unbreak', 'adguard-base', 'adguard-url-tracking']);

/**
 * uBlock Origin + AdGuard lists (the DEFAULT_ON_LISTS ones on by default on every
 * browser). On Chrome and Safari, where the network-rule limit is reached, their
 * network rules only fill the room left after EasyList / EasyPrivacy (install tiers,
 * dnr-apply.ts); their hiding rules and scriptlets (YouTube ads, anti-adblock) always apply.
 */
export const UBO_ADGUARD_LISTS: CatalogueEntry[] = [
  ubo('filters.min.txt', 'ubo-filters', 'uBlock filters – Ads', 'uBlock Origin\'s own ad filters, made to be used together with EasyList (no overlap).', 'ads', 2_000_000),
  ubo('privacy.min.txt', 'ubo-privacy', 'uBlock filters – Privacy', 'Tracking that EasyPrivacy misses, and tracking parameters in links.', 'privacy', 145_000),
  ubo('badware.min.txt', 'ubo-badware', 'uBlock filters – Badware risks', 'Sites known for scams, fake downloads and deceptive pages.', 'security', 170_000),
  ubo('quick-fixes.min.txt', 'ubo-quick-fixes', 'uBlock filters – Quick fixes', 'Short-lived fixes for sites that currently break or defeat ad blocking.', 'ads', 85_000),
  ubo('unbreak.min.txt', 'ubo-unbreak', 'uBlock filters – Unbreak', 'Exceptions that repair sites broken by other filter lists.', 'other', 180_000),
  ubo('annoyances-cookies.txt', 'ubo-cookies', 'uBlock filters – Cookie notices', 'Rejects or hides cookie-consent banners.', 'cookies', 380_000),
  ubo('annoyances-others.txt', 'ubo-annoyances', 'uBlock filters – Annoyances', 'Pop-ups, sticky overlays and other in-page nuisances.', 'annoyances', 430_000),
  adg(2, 'adguard-base', 'AdGuard Base filter', 'AdGuard\'s main ad-blocking list.', 'ads', 6_500_000,
    'Already includes EasyList, so using both mostly duplicates rules. On Chrome and Safari only part of it fits the browser\'s rule limit.'),
  adg(17, 'adguard-url-tracking', 'AdGuard URL Tracking filter', 'Removes tracking parameters from web addresses.', 'privacy', 185_000),
  adg(4, 'adguard-social', 'AdGuard Social Media filter', 'Social-media "like" and "share" buttons and widgets.', 'annoyances', 950_000),
  adg(14, 'adguard-annoyances', 'AdGuard Annoyances filter', 'Cookie notices, pop-ups, "get the app" banners, chat widgets and other annoyances.', 'annoyances', 4_200_000),
].map((e) => (DEFAULT_ON_LISTS.has(e.id) ? { ...e, defaultOn: true } : e));

export const COOKIE_LIST_ID = 'easylist-cookie';

export const CATALOGUE: CatalogueEntry[] = [
  {
    id: 'easylist', name: 'EasyList', description: 'The primary ad-blocking list: ad servers, ad frames and ad placeholders.',
    license: EL_LICENCE, homepage: 'https://easylist.to/', url: 'https://easylist.to/easylist/easylist.txt',
    kind: 'filters', category: 'ads', defaultOn: true, approxBytes: 2_100_000,
  },
  {
    id: 'easyprivacy', name: 'EasyPrivacy', description: 'Tracking scripts, pixels and analytics beacons.',
    license: EL_LICENCE, homepage: 'https://easylist.to/', url: 'https://easylist.to/easylist/easyprivacy.txt',
    kind: 'filters', category: 'privacy', defaultOn: true, approxBytes: 1_900_000,
  },
  {
    id: COOKIE_LIST_ID, name: 'EasyList Cookie List', description: 'Hides cookie notices left over after automatic rejection (used only while cookie-banner handling is on).',
    license: EL_LICENCE, homepage: 'https://easylist.to/', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    kind: 'filters', category: 'cookies', defaultOn: true, approxBytes: 900_000,
  },
  blp('phishing', 'blp-phishing', 'Phishing protection (Block List Project)', 'Sites that impersonate banks, shops and log-in pages to steal passwords and card numbers.', 5_700_000, true),
  blp('scam', 'blp-scam', 'Scam protection (Block List Project)', 'Fake shops, tech-support scams and other fraudulent sites.', 230_000, true),
  blp('fraud', 'blp-fraud', 'Fraud protection (Block List Project)', 'Sites known for financial fraud.', 8_600_000, true),
  blp('ransomware', 'blp-ransomware', 'Ransomware protection (Block List Project)', 'Ransomware distribution and command-and-control hosts.', 70_000, true),
  blp('malware', 'blp-malware', 'Malware protection, full (Block List Project)', 'Every host the project lists for malware distribution.', 72_000_000, true,
    'Very large (about 2.7 million hosts; 72 MB, 18 MB compressed, re-downloaded only when it changes). Kept as a compact hashed set (about 14 MB in memory), every host included.'),
  {
    id: 'fanboy-annoyance', name: "Fanboy's Annoyance List", description: 'Newsletter pop-ups, "open in app" prompts, chat widgets and other in-page annoyances.',
    license: 'CC BY 3.0', homepage: 'https://easylist.to/', url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    kind: 'filters', category: 'annoyances', defaultOn: false, approxBytes: 2_200_000,
  },
  {
    id: 'fanboy-social', name: "Fanboy's Social Blocking List", description: 'Social-media share buttons and embedded widgets.',
    license: 'CC BY 3.0', homepage: 'https://easylist.to/', url: 'https://secure.fanboy.co.nz/fanboy-social.txt',
    kind: 'filters', category: 'annoyances', defaultOn: false, approxBytes: 410_000,
  },
  {
    id: 'nocoin', name: 'NoCoin', description: 'In-browser cryptocurrency miners.',
    license: 'MIT', homepage: 'https://github.com/hoshsadiq/adblock-nocoin-list', url: 'https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/nocoin.txt',
    kind: 'filters', category: 'security', defaultOn: false, approxBytes: 16_000,
  },
  {
    id: '1hosts-lite', name: '1Hosts (Lite)', description: 'Ads, trackers and telemetry hosts (domain-level blocking).',
    license: 'MPL-2.0', homepage: 'https://github.com/badmojr/1Hosts', url: 'https://badmojr.github.io/1Hosts/Lite/adblock.txt',
    kind: 'filters', category: 'other', defaultOn: false, approxBytes: 2_350_000,
  },
  ...UBO_ADGUARD_LISTS,
  regional('easylist-germany', 'EasyList Germany', 'https://easylist.to/easylistgermany/easylistgermany.txt', ['de'], 282_000),
  regional('easylist-italy', 'EasyList Italy', 'https://easylist-downloads.adblockplus.org/easylistitaly.txt', ['it'], 190_000),
  regional('easylist-dutch', 'EasyList Dutch', 'https://easylist-downloads.adblockplus.org/easylistdutch.txt', ['nl'], 70_000),
  regional('easylist-spanish', 'EasyList Spanish', 'https://easylist-downloads.adblockplus.org/easylistspanish.txt', ['es'], 129_000),
  regional('easylist-portuguese', 'EasyList Portuguese', 'https://easylist-downloads.adblockplus.org/easylistportuguese.txt', ['pt'], 76_000),
  regional('easylist-polish', 'EasyList Polish', 'https://easylist-downloads.adblockplus.org/easylistpolish.txt', ['pl'], 196_000),
  regional('easylist-china', 'EasyList China', 'https://easylist-downloads.adblockplus.org/easylistchina.txt', ['zh'], 500_000),
  regional('easylist-hebrew', 'EasyList Hebrew', 'https://raw.githubusercontent.com/easylist/EasyListHebrew/master/EasyListHebrew.txt', ['he', 'iw'], 237_000),
  regional('liste-fr', 'Liste FR', 'https://easylist-downloads.adblockplus.org/liste_fr.txt', ['fr'], 437_000, 'CC BY-SA 3.0'),
  regional('liste-ar', 'Liste AR', 'https://easylist-downloads.adblockplus.org/Liste_AR.txt', ['ar'], 62_000, 'CC BY-SA 3.0'),
  regional('easylist-czech-slovak', 'EasyList Czech and Slovak', 'https://raw.githubusercontent.com/tomasko126/easylistczechandslovak/master/filters.txt', ['cs', 'sk'], 22_000, 'CC BY-SA 4.0'),
  regional('koreanlist', 'KoreanList', 'https://easylist-downloads.adblockplus.org/koreanlist.txt', ['ko'], 47_000),
  regional('indianlist', 'IndianList', 'https://easylist-downloads.adblockplus.org/indianlist.txt', ['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'ur'], 660_000),
];

export function catalogueEntry(id: string): CatalogueEntry | undefined {
  return CATALOGUE.find((e) => e.id === id);
}

/** Primary language subtags of the browser's languages, deduplicated, in order. */
export function primaryLangs(langs: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of langs) {
    const p = String(l).toLowerCase().split(/[-_]/)[0]!;
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Regional lists suggested for these browser languages. */
export function suggestedFor(langs: readonly string[]): string[] {
  const prim = primaryLangs(langs);
  return CATALOGUE.filter((e) => e.langs?.some((l) => prim.includes(l))).map((e) => e.id);
}

declare const __PLATFORM__: string | undefined;
function currentPlatform(): string {
  return typeof __PLATFORM__ !== 'undefined' ? __PLATFORM__ : 'chrome';
}

/** Whether a catalogue list is on: the user's choice, else its default (regional: suggested). */
export function isListEnabled(e: CatalogueEntry, choices: Record<string, boolean>, langs: readonly string[], platform: string = currentPlatform()): boolean {
  const c = choices[e.id];
  if (typeof c === 'boolean') return c;
  if (e.langs) return suggestedFor(langs).includes(e.id);
  return e.defaultOn && !e.offByDefaultOn?.includes(platform);
}

export interface CustomList {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
  kind: ListKind;
}

export const MAX_CUSTOM_LISTS = 30;

/** Validate a user-supplied list URL: https only, no credentials, a real host. */
export function customListUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:') return 'only https:// list URLs are allowed';
  if (u.username || u.password) return 'URLs with credentials are not allowed';
  if (!u.hostname.includes('.') || /^\[|^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return 'the URL needs a domain name';
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost')) return 'local addresses are not allowed';
  if (raw.length > 2000) return 'URL too long';
  return null;
}

/** Stable id for a custom list URL. */
export function customListId(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  return `custom-${h.toString(36)}`;
}
