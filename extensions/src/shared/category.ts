// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Rough kind of a blocked request, for the pop-up's breakdown and the
// "What was blocked" page. Guessed from the address, so "other" is honest
// about what can't be told apart.

export type Category = 'ads' | 'trackers' | 'danger' | 'other';

const TRACKER = /(analytics|metrics|telemetry|track|pixel|beacon|collect|stats|scorecard|hotjar|segment|mixpanel|amplitude|fullstory|clarity|quantserve|chartbeat|newrelic|nr-data|sentry|bugsnag|fingerprint)/i;
const AD = /(ads?[./_-]|adserv|adsystem|doubleclick|googlesyndication|adnxs|criteo|taboola|outbrain|pubmatic|rubicon|openx|amazon-adsystem|prebid|banner|sponsor|teads|moatads|adform|smartadserver)/i;

export function category(url: string, type: string, rule?: string): Category {
  if (type === 'main_frame' || rule?.startsWith('protection:')) return 'danger';
  if (AD.test(url)) return 'ads';
  if (TRACKER.test(url) || type === 'ping' || type === 'beacon') return 'trackers';
  return 'other';
}

export const CATEGORY_LABEL: Record<Category, string> = {
  ads: 'Ad',
  trackers: 'Tracker',
  danger: 'Dangerous site',
  other: 'Blocked',
};
