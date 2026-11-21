// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Host helpers. We deliberately do not ship the Public Suffix List (it is
// MPL-2.0 data); a small table of common multi-label suffixes is enough for
// first/third-party decisions on popups and entity (`site.*`) cosmetic rules.
// Network $third-party matching on Chrome/Safari is done natively by DNR and
// on Firefox by webRequest's own `thirdParty` flag.

const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.tw', 'org.tw', 'net.tw',
  'com.hk', 'org.hk', 'net.hk',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg',
  'com.mx', 'org.mx', 'gob.mx',
  'com.ar', 'org.ar', 'gob.ar',
  'com.tr', 'org.tr', 'net.tr', 'gov.tr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'co.za', 'org.za', 'gov.za',
  'co.il', 'org.il', 'ac.il',
  'com.ua', 'org.ua', 'net.ua',
  'com.pl', 'net.pl', 'org.pl',
  'co.id', 'or.id', 'web.id', 'ac.id',
  'com.my', 'org.my', 'net.my',
  'com.ph', 'org.ph', 'net.ph',
  'com.vn', 'net.vn', 'org.vn',
  'com.eg', 'com.sa', 'com.pk', 'com.ng', 'com.co', 'com.pe', 'com.ve', 'com.ec',
  'co.th', 'in.th', 'ac.th',
  // Common "private" suffixes where unrelated parties share a parent domain.
  'github.io', 'gitlab.io', 'blogspot.com', 'appspot.com', 'herokuapp.com',
  'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'cloudfront.net', 'azurewebsites.net', 'amazonaws.com', 's3.amazonaws.com',
]);

/** Host of an absolute URL, lowercased, without port, brackets or trailing dot. */
export function hostOf(url: string): string {
  const afterScheme = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url;
  let authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (authority.startsWith('[')) return authority.slice(1).split(']')[0]!.toLowerCase();
  return (authority.split(':')[0] ?? '').replace(/\.+$/, '').toLowerCase();
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** Registrable domain ("eTLD+1"), heuristic. */
export function registrable(host: string): string {
  if (!host || isIp(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  const last3 = labels.slice(-3).join('.');
  if (MULTI_LABEL_SUFFIXES.has(last3)) return labels.slice(-4).join('.');
  if (MULTI_LABEL_SUFFIXES.has(last2)) return last3;
  return last2;
}

/** Public suffix part of `host` (heuristic counterpart of `registrable`). */
export function publicSuffix(host: string): string {
  const reg = registrable(host);
  const dot = reg.indexOf('.');
  return dot >= 0 ? reg.slice(dot + 1) : '';
}

/** `host` equals `domain` or is a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || (host.length > domain.length && host.endsWith(domain) && host[host.length - domain.length - 1] === '.');
}

/** `a.b.example.com` → a.b.example.com, b.example.com, example.com, com */
export function suffixes(host: string): string[] {
  const out: string[] = [];
  let h = host;
  for (;;) {
    out.push(h);
    const i = h.indexOf('.');
    if (i < 0) break;
    h = h.slice(i + 1);
  }
  return out;
}

/** `www.google.co.uk` → `google.*` (entity syntax). */
export function entityKey(host: string): string | null {
  if (isIp(host)) return null;
  const reg = registrable(host);
  const suffix = publicSuffix(host);
  if (!suffix) return null;
  const label = reg.slice(0, reg.length - suffix.length - 1);
  return label ? `${label}.*` : null;
}

export function isThirdParty(requestHost: string, sourceHost: string): boolean {
  return registrable(requestHost) !== registrable(sourceHost);
}

/** Domain-option matcher that understands `site.*` entity entries. */
export function domainListMatches(host: string, domain: string): boolean {
  if (domain.endsWith('.*')) {
    const ent = entityKey(host);
    if (!ent) return false;
    // `google.*` also matches `www.google.de`.
    return ent === domain;
  }
  return hostMatches(host, domain);
}

/** IDN → punycode via the URL parser; null if not a valid host. */
export function toAsciiHost(host: string): string | null {
  if (/^[\x00-\x7f]*$/.test(host)) return host.toLowerCase();
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
}
