// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Firefox: network filtering with blocking webRequest and the full engine.
// This is more complete than DNR (exact $domain/entity semantics, $redirect-rule,
// regex $removeparam, every exception type) and has no rule-count limits.

import { B } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import { resourcePath } from '../shared/resources.ts';
import { typeFromWebRequest } from '../shared/types.ts';
import type { Engine, RequestInfo } from '../shared/engine.ts';
import { disabledSitesSync, disabledSites, engineSync, getEngine, getSettings, isDisabledIn } from './state.ts';
import type { Settings } from './state.ts';
import { getHostSet, hostSetSync, isAllowedInTab, warningPageUrl } from './protection.ts';
import type { HostSet } from '../shared/hostset.ts';
import { warningUrl } from '../shared/protection.ts';
import { rewriteRequestHeaders } from '../shared/privacy.ts';
import { addBlocked } from './counts.ts';
import { category } from '../shared/category.ts';
import { recordBlocked } from './tabdata.ts';

interface FxDetails {
  requestId: string;
  url: string;
  method?: string;
  type: string;
  tabId: number;
  frameId: number;
  timeStamp?: number;
  originUrl?: string;
  documentUrl?: string;
  thirdParty?: boolean;
  frameAncestors?: Array<{ url: string; frameId: number }>;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

const OWN_ORIGIN = B.runtime.getURL('');

function httpHost(url: string | undefined): string | null {
  return url && /^(https?|wss?):/i.test(url) ? hostOf(url) : null;
}

function topUrl(d: FxDetails): string | undefined {
  if (d.type === 'main_frame') return d.url;
  const anc = d.frameAncestors;
  if (anc && anc.length) return anc[anc.length - 1]!.url;
  return d.documentUrl;
}

function info(d: FxDetails): RequestInfo {
  const sourceHost = d.type === 'main_frame' ? httpHost(d.url) : httpHost(d.documentUrl ?? d.originUrl);
  return { url: d.url, sourceHost, type: typeFromWebRequest(d.type), thirdParty: d.type === 'main_frame' ? false : d.thirdParty, ...(d.method ? { method: d.method } : {}) };
}

function skip(d: FxDetails, disabled: string[]): boolean {
  if ((d.originUrl ?? '').startsWith(OWN_ORIGIN) || (d.documentUrl ?? '').startsWith(OWN_ORIGIN)) return true;
  if (!/^(https?|wss?):/i.test(d.url)) return true;
  return isDisabledIn(disabled, httpHost(topUrl(d)));
}

/** Malware/phishing/scam hosts: warning page for navigations, cancel for everything else. */
function protect(p: HostSet, d: FxDetails): chrome.webRequest.BlockingResponse | null {
  const host = httpHost(d.url);
  const list = p.lookup(host);
  if (!list || isAllowedInTab(d.tabId, host!)) return null;
  addBlocked(d.tabId, 1, 'request', 'danger');
  recordBlocked(d.tabId, { url: d.url, type: d.type, src: d.type === 'main_frame' ? null : httpHost(d.documentUrl ?? d.originUrl), rule: `protection:${list}`, at: d.timeStamp ?? Date.now() });
  if (d.type === 'main_frame') return { redirectUrl: warningUrl(warningPageUrl(), list, d.url) };
  return { cancel: true };
}

function decide(e: Engine | null, p: HostSet | null, d: FxDetails, disabled: string[]): chrome.webRequest.BlockingResponse {
  if (skip(d, disabled)) return {};
  if (p) {
    const r = protect(p, d);
    if (r) return r;
  }
  if (!e) return {};
  const i = info(d);
  const v = e.check(i);
  if (v.action === 'block') {
    addBlocked(d.tabId, 1, 'request', category(d.url, d.type, v.rule));
    recordBlocked(d.tabId, { url: d.url, type: d.type, src: i.sourceHost, rule: v.rule, at: d.timeStamp ?? Date.now() });
    const path = v.redirect ? resourcePath(v.redirect) : null;
    // Never redirect a top-level navigation to a stub resource.
    if (path && d.type !== 'main_frame') return { redirectUrl: B.runtime.getURL(path.slice(1)) };
    return { cancel: true };
  }
  const clean = e.cleanUrl(i);
  if (clean && clean !== d.url) return { redirectUrl: clean };
  return {};
}

export function registerFirefoxWebRequest(): void {
  const wr = B.webRequest;
  wr.onBeforeRequest.addListener(
    // Firefox accepts a Promise from blocking listeners: hold requests until
    // the engine and the protection host set are loaded after a background restart.
    ((d: FxDetails) => {
      const e = engineSync();
      const p = hostSetSync();
      if (e && p) return decide(e, p, d, disabledSitesSync());
      return Promise.all([getEngine(), getHostSet().catch(() => null), disabledSites()]).then(([eng, prot, dis]) => decide(eng, prot, d, dis));
    }) as never,
    { urls: ['<all_urls>'] },
    ['blocking'],
  );

  // Privacy extras: Sec-GPC, third-party Referer trimmed to the origin.
  let privacy: Settings['privacy'] | null = null;
  const loadPrivacy = () => getSettings().then((s) => (privacy = s.privacy));
  void loadPrivacy();
  B.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void loadPrivacy();
  });
  const rewrite = (d: FxDetails & { requestHeaders?: Array<{ name: string; value?: string }> }, s: Settings['privacy']) => {
    if (!d.requestHeaders || (d.originUrl ?? '').startsWith(OWN_ORIGIN)) return {};
    const out = rewriteRequestHeaders(d.requestHeaders, s, d.thirdParty === true);
    return out ? { requestHeaders: out } : {};
  };
  wr.onBeforeSendHeaders.addListener(
    ((d: FxDetails & { requestHeaders?: Array<{ name: string; value?: string }> }) => {
      if (!/^(https?|wss?):/i.test(d.url)) return {};
      if (privacy) return rewrite(d, privacy);
      return loadPrivacy().then((s) => rewrite(d, s));
    }) as never,
    { urls: ['<all_urls>'] },
    ['blocking', 'requestHeaders'],
  );

  wr.onHeadersReceived.addListener(
    ((d: FxDetails) => {
      const e = engineSync();
      if (!e || skip(d, disabledSitesSync()) || !d.responseHeaders) return {};
      const i = info(d);
      const csp = e.csp(i);
      const remove = e.headersToRemove(i);
      if (!csp.length && !remove.length) return {};
      const headers = d.responseHeaders.filter((h) => !remove.includes(h.name.toLowerCase()));
      for (const value of csp) headers.push({ name: 'Content-Security-Policy', value });
      return { responseHeaders: headers };
    }) as never,
    { urls: ['<all_urls>'] },
    ['blocking', 'responseHeaders'],
  );
}
