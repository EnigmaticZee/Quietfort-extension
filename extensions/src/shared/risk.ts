// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Breakage-risk ranking of the rules that acted on a page. Fix-this-site
// bisects in this order, so the rules most likely to break a site are tested
// (and kept as exceptions) before the ones that are almost always safe:
//   0 scriptlets             (rewrite page JavaScript)
//   1 site-specific cosmetic
//   2 generic cosmetic
//   3 first-party network blocks
//   4 third-party blocks of hosts that are not known ad networks
//   5 known ad networks     (last: blocking them is the point)

import { registrable } from './domain.ts';

export const TIER = {
  SCRIPTLET: 0,
  COSMETIC_SPECIFIC: 1,
  COSMETIC_GENERIC: 2,
  NETWORK_FIRST_PARTY: 3,
  NETWORK_THIRD_PARTY: 4,
  NETWORK_AD: 5,
} as const;

export const TIER_NAMES = ['scriptlet', 'cosmetic (site-specific)', 'cosmetic (generic)', 'first-party request', 'third-party request', 'ad network request'];

export type CandidateKind = 'scriptlet' | 'cosmetic' | 'network';

export interface BreakageCandidate {
  /** Stable key (kind + rule text). */
  id: string;
  kind: CandidateKind;
  tier: number;
  /** Rule as the user should see it. */
  rule: string;
  /** Site-scoped exception lines that switch this rule off on the site. */
  lines: string[];
  /** e.g. the blocked URLs, or how many elements a selector hid. */
  detail?: string;
}

/** Registrable domains of large ad networks / ad tech (not a filter list: used only for ranking and narrowing). */
const AD_NETWORK_DOMAINS = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com', 'adservice.google.com',
  'adnxs.com', 'amazon-adsystem.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'casalemedia.com', 'moatads.com', 'adsrvr.org', 'smartadserver.com', 'teads.tv',
  'yieldmo.com', 'sharethrough.com', 'media.net', 'adform.net', 'bidswitch.net', '33across.com', 'indexww.com',
  'popads.net', 'propellerads.com', 'revcontent.com', 'mgid.com', 'zedo.com', 'adroll.com', 'quantserve.com',
  'serving-sys.com', 'contextweb.com', 'lijit.com', 'sovrn.com', 'gumgum.com', 'triplelift.com', 'adcolony.com',
  'applovin.com', 'unityads.unity3d.com', 'inmobi.com', 'yieldlab.net', 'adition.com', 'imrworldwide.com',
]);

const AD_LABEL = /^(ads?|adserv\w*|adsystem|adnet\w*|adtech\w*|advert\w*|banners?|popads?|popunder\w*)$|^ad[s]?[-_]|adserver|adsystem|adnxs|doubleclick|syndication|advertising/;

/** Heuristic: is `host` part of a known ad network? */
export function isKnownAdNetwork(host: string): boolean {
  const reg = registrable(host.toLowerCase());
  if (AD_NETWORK_DOMAINS.has(reg)) return true;
  for (const d of AD_NETWORK_DOMAINS) if (host === d || host.endsWith(`.${d}`)) return true;
  const label = reg.split('.')[0] ?? '';
  return AD_LABEL.test(label);
}

export function networkTier(requestHost: string, pageHost: string): number {
  if (registrable(requestHost) === registrable(pageHost)) return TIER.NETWORK_FIRST_PARTY;
  return isKnownAdNetwork(requestHost) ? TIER.NETWORK_AD : TIER.NETWORK_THIRD_PARTY;
}

/**
 * Stable risk order: by tier, then by the order the rules were observed in
 * (ties keep their input order, so the ranking is deterministic). Candidates
 * without any exception line are dropped (nothing narrow can be done).
 */
export function rankCandidates(cands: BreakageCandidate[]): BreakageCandidate[] {
  const seen = new Set<string>();
  const unique = cands.filter((c) => {
    if (!c.lines.length || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return unique.map((c, i) => [c, i] as const).sort((a, b) => a[0].tier - b[0].tier || a[1] - b[1]).map(([c]) => c);
}
