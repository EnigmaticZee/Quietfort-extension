// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Privacy extras:
//   gpc          Sec-GPC: 1 on every request + navigator.globalPrivacyControl
//                (https://w3c.github.io/gpc/).
//   trimReferrer Third-party Referer reduced to the origin.
//                Firefox: exact, per request (webRequest).
//                Chrome ≥128: documents whose Referrer-Policy is missing or
//                weaker get `strict-origin-when-cross-origin`, so the browser
//                itself sends only the origin cross-origin. (A page's own
//                <meta name="referrer"> or referrerpolicy= attributes still win.)
//   stripClientData  Remove Chrome's X-Client-Data header on Google domains.

import type { DnrRule } from './dnr.ts';
import { ALL_TYPES } from './protection.ts';

export interface PrivacySettings {
  gpc: boolean;
  trimReferrer: boolean;
  stripClientData: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = { gpc: true, trimReferrer: true, stripClientData: true };

/** Dynamic rule ids for privacy rules. */
export const PRIVACY_FIRST_ID = 4_000_000;
export const PRIVACY_SLOTS = 16;
/** Above list exceptions (2000) / $important (3000) / protection (5000) so the headers are set on allowed requests. */
export const PRIVACY_PRIORITY = 6000;

const GOOGLE_CC = 'ac ad ae al am as at az ba be bf bg bi bj bs bt by ca cat cd cf cg ch ci cl cm cn co.ao co.bw co.ck co.cr co.id co.il co.in co.jp co.ke co.kr co.ls co.ma co.mz co.nz co.th co.tz co.ug co.uk co.uz co.ve co.vi co.za co.zm co.zw com com.af com.ag com.ar com.au com.bd com.bh com.bn com.bo com.br com.bz com.co com.cu com.cy com.do com.ec com.eg com.et com.fj com.gh com.gi com.gt com.hk com.jm com.kh com.kw com.lb com.ly com.mm com.mt com.mx com.my com.na com.ng com.ni com.np com.om com.pa com.pe com.pg com.ph com.pk com.pr com.py com.qa com.sa com.sb com.sg com.sl com.sv com.tj com.tr com.tw com.ua com.uy com.vc com.vn cv cz de dj dk dm dz ee es fi fm fr ga ge gg gl gm gr gy hn hr ht hu ie im iq is it je jo kg ki kz la li lk lt lu lv md me mg mk ml mn ms mu mv mw ne nl no nr nu pl pn ps pt ro rs ru rw sc se sh si sk sm sn so sr st td tg tl tm tn to tt vg vu ws'.split(' ');

/** Domains Chrome sends X-Client-Data to (google.<cc> plus Google services). */
export const GOOGLE_DOMAINS: string[] = [
  ...GOOGLE_CC.map((c) => `google.${c}`),
  'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'googlevideo.com', 'youtube.com', 'youtube-nocookie.com', 'ytimg.com',
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'withgoogle.com', 'gvt1.com', 'gvt2.com', 'ggpht.com', '2mdn.net',
];

const WEAK_POLICIES = ['*unsafe-url*', '*no-referrer-when-downgrade*', 'origin-when-cross-origin', '*, origin-when-cross-origin'];

/** Chrome major version from a user-agent string (0 when unknown). */
export function chromeMajor(ua: string): number {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : 0;
}

export function privacyDnrRules(s: PrivacySettings, opts: { platform: 'chrome' | 'safari'; chromeVersion: number }): DnrRule[] {
  const rules: DnrRule[] = [];
  let id = PRIVACY_FIRST_ID;
  const types = opts.platform === 'safari' ? ALL_TYPES.filter((t) => !['object', 'csp_report', 'webtransport', 'webbundle'].includes(t)) : ALL_TYPES;
  if (s.gpc) {
    rules.push({
      id: id++,
      priority: PRIVACY_PRIORITY,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }] },
      condition: { resourceTypes: types },
    });
  }
  if (s.trimReferrer && opts.platform === 'chrome' && opts.chromeVersion >= 128) {
    const set = { type: 'modifyHeaders' as const, responseHeaders: [{ header: 'Referrer-Policy', operation: 'set' as const, value: 'strict-origin-when-cross-origin' }] };
    rules.push({ id: id++, priority: PRIVACY_PRIORITY, action: set, condition: { resourceTypes: ['main_frame', 'sub_frame'], excludedResponseHeaders: [{ header: 'referrer-policy' }] } });
    rules.push({ id: id++, priority: PRIVACY_PRIORITY, action: set, condition: { resourceTypes: ['main_frame', 'sub_frame'], responseHeaders: [{ header: 'referrer-policy', values: WEAK_POLICIES }] } });
  }
  if (s.stripClientData && opts.platform === 'chrome') {
    rules.push({
      id: id++,
      priority: PRIVACY_PRIORITY,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Client-Data', operation: 'remove' }] },
      condition: { requestDomains: GOOGLE_DOMAINS, resourceTypes: types },
    });
  }
  return rules;
}

/** Firefox: request headers after the privacy settings (webRequest.onBeforeSendHeaders). */
export function rewriteRequestHeaders(
  headers: Array<{ name: string; value?: string }>,
  s: PrivacySettings,
  thirdParty: boolean,
): Array<{ name: string; value?: string }> | null {
  let changed = false;
  let out = headers;
  if (s.gpc && !out.some((h) => h.name.toLowerCase() === 'sec-gpc')) {
    out = [...out, { name: 'Sec-GPC', value: '1' }];
    changed = true;
  }
  if (s.trimReferrer && thirdParty) {
    out = out.map((h) => {
      if (h.name.toLowerCase() !== 'referer' || !h.value) return h;
      const t = trimToOrigin(h.value);
      if (t === h.value) return h;
      changed = true;
      return { name: h.name, value: t };
    });
  }
  if (s.stripClientData && out.some((h) => h.name.toLowerCase() === 'x-client-data')) {
    out = out.filter((h) => h.name.toLowerCase() !== 'x-client-data');
    changed = true;
  }
  return changed ? out : null;
}

export function trimToOrigin(referer: string): string {
  try {
    const u = new URL(referer);
    if (!/^https?:$/.test(u.protocol)) return referer;
    return `${u.origin}/`;
  } catch {
    return referer;
  }
}
