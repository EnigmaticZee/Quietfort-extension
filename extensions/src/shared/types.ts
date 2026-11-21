// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Request resource types as a bitmask (same bit layout as the Rust engine, plus POPUP). */
export const RT = {
  DOCUMENT: 1 << 0,
  SUBDOCUMENT: 1 << 1,
  SCRIPT: 1 << 2,
  STYLESHEET: 1 << 3,
  IMAGE: 1 << 4,
  FONT: 1 << 5,
  MEDIA: 1 << 6,
  XHR: 1 << 7,
  WEBSOCKET: 1 << 8,
  PING: 1 << 9,
  OBJECT: 1 << 10,
  OTHER: 1 << 11,
  /** New window / tab opened by a page. Never part of the default type set. */
  POPUP: 1 << 12,
} as const;

export const RT_ALL = (1 << 12) - 1;
export const RT_ALL_BUT_DOCUMENT = RT_ALL & ~RT.DOCUMENT;

export function typeFromOption(name: string): number | null {
  switch (name) {
    case 'document': case 'doc': return RT.DOCUMENT;
    case 'subdocument': case 'frame': return RT.SUBDOCUMENT;
    case 'script': return RT.SCRIPT;
    case 'stylesheet': case 'css': return RT.STYLESHEET;
    case 'image': return RT.IMAGE;
    case 'font': return RT.FONT;
    case 'media': return RT.MEDIA;
    case 'xmlhttprequest': case 'xhr': return RT.XHR;
    case 'websocket': return RT.WEBSOCKET;
    case 'ping': case 'beacon': return RT.PING;
    case 'object': case 'object-subrequest': return RT.OBJECT;
    case 'other': return RT.OTHER;
    case 'popup': return RT.POPUP;
    default: return null;
  }
}

/** webRequest `type` (Chrome/Firefox) → bit. */
export function typeFromWebRequest(t: string): number {
  switch (t) {
    case 'main_frame': return RT.DOCUMENT;
    case 'sub_frame': return RT.SUBDOCUMENT;
    case 'script': return RT.SCRIPT;
    case 'stylesheet': return RT.STYLESHEET;
    case 'image': case 'imageset': return RT.IMAGE;
    case 'font': return RT.FONT;
    case 'media': return RT.MEDIA;
    case 'xmlhttprequest': return RT.XHR;
    case 'websocket': return RT.WEBSOCKET;
    case 'ping': case 'beacon': return RT.PING;
    case 'object': case 'object_subrequest': return RT.OBJECT;
    default: return RT.OTHER;
  }
}

export interface Scriptlet {
  name: string;
  args: string[];
}

export type ParamMatch =
  | { kind: 'all' }
  | { kind: 'name'; name: string }
  | { kind: 'allExcept'; name: string }
  | { kind: 'regex'; source: string; re: RegExp };

export type Modifier =
  | { kind: 'removeparam'; param: ParamMatch }
  | { kind: 'csp'; value: string }
  | { kind: 'removeheader'; value: string };

export type PatternSpec =
  | { kind: 'regex'; source: string }
  /** `anchor`: none | host (`||`) | start (`|`); `body` keeps `*` and `^`. */
  | { kind: 'glob'; anchor: 'none' | 'host' | 'start'; endAnchor: boolean; body: string };

export interface NetworkRule {
  raw: string;
  pattern: PatternSpec;
  exception: boolean;
  important: boolean;
  matchCase: boolean;
  types: number;
  /** true = only third-party, false = only first-party. */
  thirdParty: boolean | null;
  includeDomains: string[];
  excludeDomains: string[];
  generichide: boolean;
  elemhide: boolean;
  redirect: string | null;
  /** `$redirect-rule`: only redirect when something else blocks. */
  redirectRule: boolean;
  modifier: Modifier | null;
  /** `||host^` with no path: candidates for DNR `requestDomains` merging. */
  pureHost: string | null;
  /** Lowercase token used for indexing, if any. */
  token: string | null;
  /** Rarely used conditions (`$denyallow`, `$to`, `$strict1p` / `$strict3p`). */
  extra?: RuleExtra;
}

export interface RuleExtra {
  /** The rule never applies to requests to these hosts. */
  denyallow: string[];
  /** Request host must match one of these (if any) and none of `toExclude`. */
  toInclude: string[];
  toExclude: string[];
  /** true = `$strict3p` (hosts differ), false = `$strict1p` (same host). */
  strictThirdParty: boolean | null;
  /** `$method=get|~post` (upper-case). */
  methods?: string[];
  notMethods?: string[];
  /** `@@...$redirect(-rule)`: cancels the redirect only; blocking stays. */
  redirectException?: boolean;
  /** `@@||site^$genericblock`: no generic network blocking on that page. */
  genericblock?: boolean;
  /** `$urlskip` / `$uritransform`: where a top-level navigation should go instead. */
  navigation?: { kind: 'urlskip'; steps: string[] } | { kind: 'uritransform'; re: string; flags: string; replacement: string };
}

export interface CosmeticRule {
  includeDomains: string[];
  excludeDomains: string[];
  selector: string;
  exception: boolean;
}

export type Parsed =
  | { kind: 'network'; rule: NetworkRule }
  | { kind: 'badfilter'; raw: string }
  | { kind: 'cosmetic'; rule: CosmeticRule }
  | { kind: 'procedural'; rule: CosmeticRule }
  | { kind: 'style'; rule: CosmeticRule; declarations: string }
  | { kind: 'scriptlet'; includeDomains: string[]; excludeDomains: string[]; scriptlet: Scriptlet | null; exception: boolean }
  | { kind: 'ignored' }
  | { kind: 'unsupported'; reason: string };
