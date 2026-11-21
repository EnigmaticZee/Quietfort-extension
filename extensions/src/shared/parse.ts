// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Filter-line parser. A TypeScript port of the Rust parse.rs (tag mac-app-final)
// (ABP / uBO / AdGuard syntax) with one addition the desktop proxy can't use:
// the `$popup` type. Policy is identical: trusted-only scriptlets only from
// trusted lists, raw `#%#` JavaScript never; HTML filters are unsupported.

import { RT, RT_ALL, RT_ALL_BUT_DOCUMENT, typeFromOption } from './types.ts';
import type { CosmeticRule, Modifier, NetworkRule, ParamMatch, Parsed, PatternSpec, RuleExtra, Scriptlet } from './types.ts';

/**
 * Scriptlets runtime.js implements: [canonical, trusted-only, aliases]. Mirrors
 * SCRIPTLETS in parse.rs. Trusted-only scriptlets (arbitrary cookie/storage
 * values, clicking, rewriting page text) are accepted only from lists marked
 * trusted — the uBO / AdGuard lists fetched from their official URLs.
 */
export const SCRIPTLETS: Array<[string, boolean, string[]]> = [
  ['set-constant', false, ['set', 'set-constant']],
  ['abort-on-property-read', false, ['aopr', 'abort-on-property-read']],
  ['abort-on-property-write', false, ['aopw', 'abort-on-property-write']],
  ['abort-current-script', false, ['acs', 'acis', 'abort-current-script', 'abort-current-inline-script']],
  ['abort-on-stack-trace', false, ['aost', 'abort-on-stack-trace']],
  ['prevent-setTimeout', false, ['nostif', 'no-settimeout-if', 'prevent-settimeout', 'settimeout-defuser']],
  ['prevent-setInterval', false, ['nosiif', 'no-setinterval-if', 'prevent-setinterval', 'setinterval-defuser']],
  ['adjust-setTimeout', false, ['nano-stb', 'nano-settimeout-booster', 'adjust-settimeout']],
  ['adjust-setInterval', false, ['nano-sib', 'nano-setinterval-booster', 'adjust-setinterval']],
  ['prevent-requestAnimationFrame', false, ['norafif', 'no-requestanimationframe-if', 'prevent-requestanimationframe']],
  ['prevent-fetch', false, ['no-fetch-if', 'prevent-fetch']],
  ['prevent-xhr', false, ['no-xhr-if', 'prevent-xhr']],
  ['prevent-addEventListener', false, ['aeld', 'addeventlistener-defuser', 'prevent-addeventlistener']],
  ['prevent-window-open', false, ['nowoif', 'no-window-open-if', 'window.open-defuser', 'prevent-window-open']],
  ['prevent-eval-if', false, ['noeval-if', 'prevent-eval-if', 'noeval', 'silent-noeval', 'noeval-silent']],
  ['json-prune', false, ['json-prune']],
  ['json-prune-fetch-response', false, ['json-prune-fetch-response']],
  ['json-prune-xhr-response', false, ['json-prune-xhr-response']],
  ['m3u-prune', false, ['m3u-prune']],
  ['xml-prune', false, ['xml-prune']],
  ['remove-attr', false, ['ra', 'remove-attr']],
  ['remove-class', false, ['rc', 'remove-class']],
  ['set-attr', false, ['set-attr']],
  ['remove-node-text', false, ['rmnt', 'remove-node-text']],
  ['set-cookie', false, ['set-cookie']],
  ['set-cookie-reload', false, ['set-cookie-reload']],
  ['remove-cookie', false, ['remove-cookie', 'cookie-remover']],
  ['set-local-storage-item', false, ['set-local-storage-item']],
  ['set-session-storage-item', false, ['set-session-storage-item']],
  ['href-sanitizer', false, ['href-sanitizer']],
  ['disable-newtab-links', false, ['disable-newtab-links']],
  ['prevent-adblock-detector', false, ['nofab', 'nobab', 'fuckadblock.js-3.2.0', 'prevent-fab-3.2.0', 'bab-defuser', 'prevent-bab', 'prevent-bab2']],
  ['popads-dummy', false, ['popads-dummy', 'popads.net', 'prevent-popads-net']],
  ['prevent-element-src-loading', false, ['prevent-element-src-loading']],
  ['spoof-css', false, ['spoof-css']],
  ['nowebrtc', false, ['nowebrtc', 'prevent-webrtc']],
  ['prevent-innerHTML', false, ['prevent-innerhtml']],
  ['json-edit', false, ['json-edit']],
  ['json-edit-fetch-response', false, ['json-edit-fetch-response']],
  ['json-edit-xhr-response', false, ['json-edit-xhr-response']],
  ['edit-inbound-object', false, ['edit-inbound-object']],
  ['jsonl-edit-xhr-response', false, ['jsonl-edit-xhr-response']],
  ['jsonl-edit-fetch-response', false, ['jsonl-edit-fetch-response']],
  ['trusted-edit-inbound-object', true, ['trusted-edit-inbound-object']],
  ['trusted-jsonl-edit-xhr-response', true, ['trusted-jsonl-edit-xhr-response']],
  ['trusted-jsonl-edit-fetch-response', true, ['trusted-jsonl-edit-fetch-response']],
  ['trusted-json-edit', true, ['trusted-json-edit']],
  ['trusted-json-edit-fetch-response', true, ['trusted-json-edit-fetch-response']],
  ['trusted-json-edit-xhr-response', true, ['trusted-json-edit-xhr-response']],
  ['trusted-replace-argument', true, ['trusted-replace-argument']],
  ['trusted-replace-outbound-text', true, ['trusted-replace-outbound-text']],
  ['trusted-suppress-native-method', true, ['trusted-suppress-native-method']],
  ['trusted-override-element-method', true, ['trusted-override-element-method']],
  ['trusted-prevent-dom-bypass', true, ['trusted-prevent-dom-bypass']],
  ['trusted-create-html', true, ['trusted-create-html']],
  ['trusted-set-constant', true, ['trusted-set', 'trusted-set-constant']],
  ['trusted-set-cookie', true, ['trusted-set-cookie']],
  ['trusted-set-cookie-reload', true, ['trusted-set-cookie-reload']],
  ['trusted-set-local-storage-item', true, ['trusted-set-local-storage-item']],
  ['trusted-set-session-storage-item', true, ['trusted-set-session-storage-item']],
  ['trusted-set-attr', true, ['trusted-set-attr']],
  ['trusted-click-element', true, ['trusted-click-element']],
  ['replace-node-text', true, ['rpnt', 'replace-node-text', 'trusted-rpnt', 'trusted-replace-node-text']],
  ['trusted-replace-fetch-response', true, ['trusted-rpfr', 'trusted-replace-fetch-response']],
  ['trusted-replace-xhr-response', true, ['trusted-replace-xhr-response']],
  ['trusted-prevent-fetch', true, ['trusted-prevent-fetch']],
  ['trusted-prevent-xhr', true, ['trusted-prevent-xhr']],
];

/** Canonical name for a uBO / AdGuard scriptlet name (null if we don't implement it). */
export function canonicalScriptlet(name: string): string | null {
  return scriptletInfo(name)?.[0] ?? null;
}

function scriptletInfo(name: string): [string, boolean] | null {
  let n = name.trim();
  if (n.startsWith('ubo-')) n = n.slice(4);
  if (n.endsWith('.js')) n = n.slice(0, -3);
  n = n.toLowerCase();
  for (const [canon, trusted, aliases] of SCRIPTLETS) if (aliases.includes(n)) return [canon, trusted];
  return null;
}

/** AdGuard's trusted-replace-node-text argument order → uBO's (what runtime.js implements). */
function adaptAdguardArgs(canonical: string, args: string[]): string[] {
  if (canonical === 'replace-node-text' && args.length >= 4) {
    const [nodeName, textMatch, pattern, replacement] = args as [string, string, string, string];
    return textMatch ? [nodeName, pattern, replacement, 'condition', textMatch] : [nodeName, pattern, replacement];
  }
  return args;
}

/**
 * `+js(name, a\, b, c)` → ["name", "a, b", "c"]. As in uBO, an argument wrapped
 * in matching quotes (' " `) is taken without them, commas inside it need no
 * escaping, and `\` before that quote is the quote itself:
 * `+js(trusted-rpfr, '"adSlots"', '"no_ads"', player?)` → ["trusted-rpfr", "\"adSlots\"", "\"no_ads\"", "player?"].
 * An argument that opens a quote but doesn't close it before the next comma
 * (or has text after the closing quote) is taken literally.
 */
export function splitUboArgs(inner: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    while (i < inner.length && /\s/.test(inner[i]!)) i++;
    const q = inner[i];
    if (q === "'" || q === '"' || q === '`') {
      let j = i + 1;
      let cur = '';
      let closed = false;
      while (j < inner.length) {
        const c = inner[j]!;
        if (c === '\\' && inner[j + 1] === q) {
          cur += q;
          j += 2;
        } else if (c === q) {
          closed = true;
          j++;
          break;
        } else {
          cur += c;
          j++;
        }
      }
      let k = j;
      while (k < inner.length && /\s/.test(inner[k]!)) k++;
      if (closed && (k >= inner.length || inner[k] === ',')) {
        out.push(cur);
        if (k >= inner.length) return out;
        i = k + 1;
        continue;
      }
    }
    // Unquoted: up to the next unescaped comma.
    let cur = '';
    while (i < inner.length) {
      const c = inner[i]!;
      if (c === '\\' && inner[i + 1] === ',') {
        cur += ',';
        i += 2;
      } else if (c === ',') break;
      else {
        cur += c;
        i++;
      }
    }
    out.push(cur.trim());
    if (i >= inner.length) return out;
    i++;
  }
}

/** `'name', "a", 'b\'c'` → ["name", "a", "b'c"]; null if malformed. */
function splitQuotedArgs(inner: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    while (i < inner.length && (/\s/.test(inner[i]!) || inner[i] === ',')) i++;
    if (i >= inner.length) break;
    const q = inner[i++];
    if (q !== "'" && q !== '"') return null;
    let cur = '';
    for (;;) {
      if (i >= inner.length) return null;
      const c = inner[i++]!;
      if (c === '\\') {
        if (i >= inner.length) return null;
        cur += inner[i++];
      } else if (c === q) break;
      else cur += c;
    }
    out.push(cur);
  }
  return out;
}

/** Parse a scriptlet body: a Scriptlet, `null` (empty call) or a rejection reason. */
function parseScriptlet(body: string, trusted: boolean): Scriptlet | null | { reason: string } {
  let args: string[];
  let adguard = false;
  if (body.startsWith('+js(') && body.endsWith(')')) {
    const inner = body.slice(4, -1);
    if (!inner.trim()) return null;
    args = splitUboArgs(inner);
  } else if (body.startsWith('//scriptlet(') && body.endsWith(')')) {
    const inner = body.slice(12, -1);
    if (!inner.trim()) return null;
    const a = splitQuotedArgs(inner);
    if (!a) return { reason: 'scriptlet-syntax' };
    args = a;
    adguard = true;
  } else return { reason: 'raw-js' };
  const name = args[0];
  if (name === undefined) return { reason: 'scriptlet-syntax' };
  const info = scriptletInfo(name);
  if (!info) return { reason: `scriptlet:${name.trim().replace(/\.js$/, '')}` };
  const [canonical, trustedOnly] = info;
  // Trusted-only scriptlets: never from third-party or custom lists.
  if (trustedOnly && !trusted) return { reason: `scriptlet-untrusted:${canonical}` };
  const rest = args.slice(1);
  return { name: canonical, args: adguard ? adaptAdguardArgs(canonical, rest) : rest };
}

// ---------- `!#if` pre-parsing directives ----------

/** `!#if` tokens that are true for each extension build (the extension can't do HTML filtering). */
export const EXTENSION_ENV: Record<'chrome' | 'firefox' | 'safari', string[]> = {
  chrome: ['env_chromium', 'env_mv3', 'cap_user_stylesheet'],
  firefox: ['env_firefox', 'cap_user_stylesheet'],
  safari: ['env_safari', 'env_mv3', 'cap_user_stylesheet'],
};

/** Evaluate a directive condition (`!`, `&&`, `||`, parentheses); unknown tokens are false. */
export function evalDirective(expr: string, env: readonly string[]): boolean {
  const toks = expr.match(/&&|\|\||[!()]|[A-Za-z0-9_]+|\S/g) ?? [];
  let i = 0;
  const unary = (): boolean | null => {
    const t = toks[i++];
    if (t === '!') {
      const v = unary();
      return v === null ? null : !v;
    }
    if (t === '(') {
      const v = or();
      if (v === null || toks[i++] !== ')') return null;
      return v;
    }
    if (t !== undefined && /^[A-Za-z0-9_]+$/.test(t)) return env.includes(t.toLowerCase());
    return null;
  };
  const and = (): boolean | null => {
    let v = unary();
    while (v !== null && toks[i] === '&&') {
      i++;
      const r = unary();
      v = r === null ? null : v && r;
    }
    return v;
  };
  const or = (): boolean | null => {
    let v = and();
    while (v !== null && toks[i] === '||') {
      i++;
      const r = and();
      v = r === null ? null : v || r;
    }
    return v;
  };
  const v = or();
  return v === true && i === toks.length;
}

/** The lines of a list that are active under `env` (`!#if` / `!#else` / `!#endif` applied). */
export function activeLines(text: string, env: readonly string[]): string[] {
  const out: string[] = [];
  const stack: Array<[boolean, boolean]> = [];
  let active = true;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith('!#if') && (t.length === 4 || /^[\s(!]/.test(t.slice(4)))) {
      const cond = evalDirective(t.slice(4).trim(), env);
      stack.push([active, cond]);
      active = active && cond;
      continue;
    }
    if (t.startsWith('!#else')) {
      const top = stack[stack.length - 1];
      if (top) active = top[0] && !top[1];
      continue;
    }
    if (t.startsWith('!#endif')) {
      const top = stack.pop();
      if (top) active = top[0];
      continue;
    }
    if (active) out.push(line);
  }
  return out;
}

const MARKER_STARTS = ['##', '#@#', '#?#', '#@?#', '#$#', '#@$#', '#%#', '#@%#'];

/** Parse one line. `trusted`: the line comes from a trusted list (enables trusted-only scriptlets). */
export function parseLine(input: string, trusted = false): Parsed {
  const line = input.trim();
  if (!line || line.startsWith('!') || line.startsWith('[') || (line.startsWith('#') && !MARKER_STARTS.some((m) => line.startsWith(m)))) {
    return { kind: 'ignored' };
  }
  const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1) +(.*)$/.exec(line);
  if (hosts) {
    const domain = hosts[1]!.trim().split(/\s+/)[0] ?? '';
    if (!domain || ['localhost', '0.0.0.0', 'local'].includes(domain)) return { kind: 'ignored' };
    return parseNetwork(`||${domain}^`);
  }
  return parseCosmetic(line, trusted) ?? parseNetwork(line);
}

function splitDomains(list: string, sep: string): [string[], string[]] {
  const inc: string[] = [];
  const exc: string[] = [];
  for (const raw of list.split(sep)) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (d.startsWith('~')) exc.push(d.slice(1));
    else inc.push(d);
  }
  return [inc, exc];
}

type Kind = 'hide' | 'procedural' | 'style' | 'scriptlet' | 'html';

const COSMETIC_MARKERS: Array<[string, Kind, boolean]> = [
  ['#@%#', 'scriptlet', true], ['#%#', 'scriptlet', false],
  ['#@$?#', 'html', true], ['#$?#', 'html', false],
  ['#@$#', 'style', true], ['#$#', 'style', false],
  ['#@?#', 'procedural', true], ['#?#', 'procedural', false],
  ['$@$', 'html', true], ['$$', 'html', false],
  ['#@#', 'hide', true], ['##', 'hide', false],
];

function parseCosmetic(line: string, trusted: boolean): Parsed | null {
  for (const [marker, baseKind, exception] of COSMETIC_MARKERS) {
    const idx = line.indexOf(marker);
    if (idx < 0) continue;
    const domains = line.slice(0, idx);
    if (/[/^|=$@?&]/.test(domains)) continue;
    const body = line.slice(idx + marker.length).trim();
    if (!body) return { kind: 'ignored' };
    const [includeDomains, excludeDomains] = splitDomains(domains, ',');
    let kind = baseKind;
    if (kind === 'hide') {
      if (body.startsWith('+js(')) kind = 'scriptlet';
      else if (body.startsWith('^')) kind = 'html';
      else if (isProcedural(body)) kind = 'procedural';
    }
    const rule = (selector: string): CosmeticRule => ({ includeDomains: [...includeDomains], excludeDomains: [...excludeDomains], selector, exception });
    switch (kind) {
      case 'html':
        return { kind: 'unsupported', reason: 'html-filter' };
      case 'scriptlet': {
        const s = parseScriptlet(body, trusted);
        if (s !== null && 'reason' in s) return { kind: 'unsupported', reason: s.reason };
        if (s === null && !exception) return { kind: 'ignored' };
        return { kind: 'scriptlet', includeDomains, excludeDomains, scriptlet: s, exception };
      }
      case 'style': {
        const brace = body.lastIndexOf('{');
        if (brace >= 0 && body.trimEnd().endsWith('}')) {
          const sel = body.slice(0, brace).trim();
          const declarations = body.slice(brace + 1).trimEnd().replace(/}+$/, '').trim();
          if (!sel || isProcedural(sel) || !safeDeclarations(declarations)) return { kind: 'unsupported', reason: 'style-unsafe' };
          return { kind: 'style', rule: rule(sel), declarations };
        }
        return { kind: 'unsupported', reason: 'style-snippet' };
      }
      case 'procedural': {
        if (body.endsWith(')')) {
          const at = body.slice(0, -1).lastIndexOf(':style(');
          if (at >= 0) {
            const sel = body.slice(0, at);
            const decl = body.slice(at + 7, -1);
            if (!isProcedural(sel) && safeDeclarations(decl)) return { kind: 'style', rule: rule(sel), declarations: decl };
          }
        }
        const problem = proceduralProblem(body);
        if (problem) return { kind: 'unsupported', reason: problem };
        // Generic procedural filters are too expensive (uBO forbids them too).
        if (includeDomains.length === 0 && !exception) return { kind: 'unsupported', reason: 'generic-procedural' };
        return { kind: 'procedural', rule: rule(body) };
      }
      case 'hide':
        return { kind: 'cosmetic', rule: rule(body) };
    }
  }
  return null;
}

/** Reject CSS that could load resources or run code. */
export function safeDeclarations(decl: string): boolean {
  const d = decl.toLowerCase();
  return !['url(', 'expression(', '@import', 'javascript:', '\\', 'image-set(', '-moz-binding'].some((b) => d.includes(b));
}

const PROCEDURAL_OPS = [
  ':has-text(', ':-abp-has(', ':-abp-contains(', ':contains(', ':xpath(', ':upward(',
  ':remove(', ':style(', ':matches-css', ':min-text-length(', ':watch-attr(',
  ':matches-path(', ':matches-attr(', ':matches-prop(', ':others(', ':remove-attr(',
  ':remove-class(', ':-abp-properties(', ':nth-ancestor(', ':if(', ':if-not(',
  ':matches-media(',
];

/** Procedural operators runtime.js implements (mirrors RUNTIME_OPS in parse.rs). */
const RUNTIME_OPS = [
  'has-text', '-abp-contains', 'contains', 'upward', 'nth-ancestor', 'remove', 'remove-attr', 'remove-class',
  'matches-path', 'matches-attr', 'matches-media', 'watch-attr', 'style', 'others', '-abp-properties', 'matches-css',
  'matches-css-before', 'matches-css-after', 'min-text-length', 'xpath', '-abp-has', 'has', 'if', 'if-not',
];
const NATIVE_FN_PSEUDOS = ['not', 'is', 'where', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'lang', 'dir', 'host', 'host-context', 'state'];

/** Why runtime.js can't run this procedural selector, if it can't. */
export function proceduralProblem(sel: string): string | null {
  const re = /(::?)([A-Za-z0-9-]+)\(/g;
  for (let m = re.exec(sel); m; m = re.exec(sel)) {
    const op = m[2]!;
    if (m[1] === '::' || NATIVE_FN_PSEUDOS.includes(op)) continue;
    if (!RUNTIME_OPS.includes(op)) return `procedural-op:${op}`;
    if (op === 'style') {
      const rest = sel.slice(m.index + m[0].length);
      if (!safeDeclarations(rest.endsWith(')') ? rest.slice(0, -1) : rest)) return 'style-unsafe';
    }
  }
  return null;
}

export function isProcedural(sel: string): boolean {
  return PROCEDURAL_OPS.some((op) => sel.includes(op));
}

export function looksLikeOptions(s: string): boolean {
  return s.length > 0 && s.split(',').every((opt) => {
    const name = opt.replace(/^~/, '').split('=')[0] ?? '';
    return name.length > 0 && /^[A-Za-z0-9_-]+$/.test(name);
  });
}

const PROTECTED_HEADERS = [
  'strict-transport-security', 'content-security-policy', 'x-frame-options',
  'access-control-allow-origin', 'access-control-allow-credentials',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'set-cookie', 'location', 'content-type',
];

function parseNetwork(line: string): Parsed {
  const exception = line.startsWith('@@');
  const body = exception ? line.slice(2) : line;
  const dollar = body.lastIndexOf('$');
  let patternStr = body;
  let options: string | null = null;
  if (dollar >= 0 && looksLikeOptions(body.slice(dollar + 1))) {
    patternStr = body.slice(0, dollar);
    options = body.slice(dollar + 1);
  }

  const rule: NetworkRule = {
    raw: line, pattern: { kind: 'glob', anchor: 'none', endAnchor: false, body: '' }, exception,
    important: false, matchCase: false, types: 0, thirdParty: null, includeDomains: [], excludeDomains: [],
    generichide: false, elemhide: false, redirect: null, redirectRule: false, modifier: null, pureHost: null, token: null,
  };
  let positive = 0;
  let negative = 0;
  let badfilter = false;
  const extra: RuleExtra = { denyallow: [], toInclude: [], toExclude: [], strictThirdParty: null };

  if (options !== null) {
    for (const rawOpt of options.split(',')) {
      const neg = rawOpt.startsWith('~');
      const opt = neg ? rawOpt.slice(1) : rawOpt;
      const eq = opt.indexOf('=');
      const name = (eq >= 0 ? opt.slice(0, eq) : opt).toLowerCase();
      const value = eq >= 0 ? opt.slice(eq + 1) : null;
      switch (name) {
        case 'third-party': case '3p': rule.thirdParty = !neg; break;
        case 'first-party': case '1p': rule.thirdParty = neg; break;
        case 'domain': case 'from': {
          const [inc, exc] = splitDomains(value ?? '', '|');
          rule.includeDomains = inc;
          rule.excludeDomains = exc;
          break;
        }
        case 'important': rule.important = true; break;
        case 'denyallow': {
          const [inc, exc] = splitDomains(value ?? '', '|');
          if (neg || !inc.length || exc.length) return { kind: 'unsupported', reason: 'option:denyallow' };
          extra.denyallow = inc;
          break;
        }
        case 'to': {
          const [inc, exc] = splitDomains(value ?? '', '|');
          if (neg || (!inc.length && !exc.length)) return { kind: 'unsupported', reason: 'option:to' };
          extra.toInclude = inc;
          extra.toExclude = exc;
          break;
        }
        // uBO `$reason=`: text for the block page; informational only.
        case 'reason': break;
        case 'popunder': if (!neg) positive |= RT.POPUP; break;
        case 'app': return { kind: 'unsupported', reason: 'n/a:app' };
        case 'webrtc': return { kind: 'unsupported', reason: 'n/a:webrtc' };
        case 'cname': return { kind: 'unsupported', reason: exception ? 'n/a:cname-exception' : 'option:cname' };
        case 'method': {
          const ms = (value ?? '').split('|').map((m) => m.trim()).filter(Boolean);
          if (neg || !ms.length) return { kind: 'unsupported', reason: 'option:method' };
          extra.methods = ms.filter((m) => !m.startsWith('~')).map((m) => m.toUpperCase());
          extra.notMethods = ms.filter((m) => m.startsWith('~')).map((m) => m.slice(1).toUpperCase());
          break;
        }
        case 'genericblock':
          if (!exception || neg) return { kind: 'unsupported', reason: 'option:genericblock' };
          extra.genericblock = true;
          break;
        case 'urlskip': {
          const steps = (value ?? '').split(/\s+/).filter(Boolean);
          if (neg || !steps.length || !steps.every((st) => /^(?:\?.+|\/.+\/|-base64|-safebase64|-uricomponent|\+https|-blocked)$/.test(st))) {
            return { kind: 'unsupported', reason: 'urlskip-bad' };
          }
          extra.navigation = { kind: 'urlskip', steps };
          break;
        }
        case 'uritransform': {
          const m = /^\/((?:\\.|[^/])+)\/((?:\\.|[^/])*)\/([a-z]*)$/.exec(value ?? '');
          if (neg || !m) return { kind: 'unsupported', reason: 'uritransform-bad' };
          try { new RegExp(m[1]!, m[3]); } catch { return { kind: 'unsupported', reason: 'uritransform-bad' }; }
          extra.navigation = { kind: 'uritransform', re: m[1]!, flags: m[3]!, replacement: m[2]! };
          break;
        }
        case 'strict1p': case 'strict-first-party': extra.strictThirdParty = neg; break;
        case 'strict3p': case 'strict-third-party': extra.strictThirdParty = !neg; break;
        case 'match-case': rule.matchCase = true; break;
        case 'badfilter': badfilter = true; break;
        case 'all': positive |= RT_ALL | RT.POPUP; break;
        case 'generichide': case 'ghide':
          if (!exception || neg) return { kind: 'unsupported', reason: 'option:generichide' };
          rule.generichide = true;
          break;
        case 'elemhide': case 'ehide':
          if (!exception || neg) return { kind: 'unsupported', reason: 'option:elemhide' };
          rule.elemhide = true;
          break;
        case 'redirect': case 'redirect-rule': case 'rewrite': {
          let v = value ?? '';
          if (v.startsWith('abp-resource:')) v = v.slice(13);
          v = v.split(':')[0] ?? '';
          if (exception) {
            extra.redirectException = true;
            rule.redirect = v;
            break;
          }
          if (!v) return { kind: 'unsupported', reason: 'redirect-empty' };
          rule.redirect = v;
          rule.redirectRule = name === 'redirect-rule';
          break;
        }
        case 'empty': rule.redirect = 'empty'; break;
        case 'removeparam': case 'queryprune': {
          const v = value ?? '';
          let pm: ParamMatch;
          if (!v) pm = { kind: 'all' };
          else if (v.startsWith('~')) pm = { kind: 'allExcept', name: v.slice(1) };
          else if (v.length > 2 && v.startsWith('/') && v.endsWith('/')) {
            try {
              pm = { kind: 'regex', source: v.slice(1, -1), re: new RegExp(v.slice(1, -1)) };
            } catch {
              return { kind: 'unsupported', reason: 'removeparam-bad-regex' };
            }
          } else if (v.startsWith('/')) return { kind: 'unsupported', reason: 'removeparam-regex-flags' };
          else pm = { kind: 'name', name: v };
          rule.modifier = { kind: 'removeparam', param: pm };
          break;
        }
        case 'csp': rule.modifier = { kind: 'csp', value: (value ?? '').trim() }; break;
        case 'removeheader': {
          const v = (value ?? '').trim().toLowerCase();
          if (v.startsWith('request:') || (!v && !exception) || PROTECTED_HEADERS.includes(v)) {
            return { kind: 'unsupported', reason: 'removeheader-protected' };
          }
          rule.modifier = { kind: 'removeheader', value: v };
          break;
        }
        default: {
          if (/^_+$/.test(name)) break; // AdGuard's no-op `$_`
          const t = typeFromOption(name);
          if (t === null) return { kind: 'unsupported', reason: `option:${name}` };
          if (neg) negative |= t;
          else positive |= t;
        }
      }
    }
  }

  // Pattern.
  let p = patternStr;
  const regexMeta = (s: string) => /[\\[({+?$|.]/.test(s);
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/') && regexMeta(p.slice(1, -1))) {
    try {
      new RegExp(p.slice(1, -1), rule.matchCase ? '' : 'i');
    } catch {
      return { kind: 'unsupported', reason: 'bad-regex' };
    }
    rule.pattern = { kind: 'regex', source: p.slice(1, -1) };
  } else {
    let anchor: 'none' | 'host' | 'start' = 'none';
    if (p.startsWith('||')) {
      p = p.slice(2);
      anchor = 'host';
    } else if (p.startsWith('|')) {
      p = p.slice(1);
      anchor = 'start';
    }
    let endAnchor = false;
    if (p.endsWith('|')) {
      p = p.slice(0, -1);
      endAnchor = true;
    }
    let trimmed = anchor === 'none' ? p.replace(/^\*+|\*+$/g, '') : p.replace(/\*+$/, '');
    if (!rule.matchCase) trimmed = trimmed.toLowerCase();
    if (!trimmed && anchor === 'none' && !endAnchor && rule.includeDomains.length === 0 && extra.toInclude.length === 0 && !exception && !rule.modifier) {
      return { kind: 'unsupported', reason: 'match-all' };
    }
    rule.token = bestToken(trimmed.toLowerCase(), anchor, endAnchor);
    if (anchor === 'host' && !endAnchor && trimmed.endsWith('^')) {
      const host = trimmed.slice(0, -1);
      if (host && !/[/*^?=:|]/.test(host)) rule.pureHost = host;
    }
    rule.pattern = { kind: 'glob', anchor, endAnchor, body: trimmed };
  }

  // Types. Deliberate difference from the Rust engine: a pure `||host^` rule does
  // not block top-level navigations unless it says `$document` (ABP semantics).
  // Breaking link click-throughs from an extension is worse than letting a
  // tracker page load in a tab the user asked for.
  rule.types = RT_ALL_BUT_DOCUMENT;
  if (positive) rule.types = positive;
  if (negative) rule.types = (positive ? positive : RT_ALL_BUT_DOCUMENT) & ~negative;
  if ((rule.generichide || rule.elemhide) && !positive) rule.types = RT.DOCUMENT;
  if (rule.modifier?.kind === 'csp' && !positive) rule.types = RT.DOCUMENT | RT.SUBDOCUMENT;
  if ((rule.modifier?.kind === 'removeparam' || rule.modifier?.kind === 'removeheader') && !positive) rule.types = RT_ALL;
  if (rule.types === 0) return { kind: 'unsupported', reason: 'no-types' };

  if (extra.navigation && !positive) rule.types = RT.DOCUMENT;
  if (extra.genericblock && !positive) rule.types = RT.DOCUMENT;
  if (extra.denyallow.length || extra.toInclude.length || extra.toExclude.length || extra.strictThirdParty !== null
    || extra.methods || extra.redirectException || extra.genericblock || extra.navigation) rule.extra = extra;
  if (badfilter) return { kind: 'badfilter', raw: stripBadfilter(line) };
  return { kind: 'network', rule };
}

export function stripBadfilter(raw: string): string {
  const i = raw.lastIndexOf('$');
  if (i < 0) return raw;
  const opts = raw.slice(i + 1).split(',').filter((o) => o !== 'badfilter');
  return opts.length ? `${raw.slice(0, i)}$${opts.join(',')}` : raw.slice(0, i);
}

const STOP_TOKENS = new Set(['http', 'https', 'www', 'com', 'js', 'net', 'org', 'html', 'php']);

/** Longest alphanumeric run guaranteed to appear as a whole token in any matching URL. */
export function bestToken(body: string, anchor: 'none' | 'host' | 'start', endAnchor: boolean): string | null {
  let best: [number, number] | null = null;
  const isAlnum = (c: string | undefined) => c !== undefined && /[a-z0-9]/i.test(c);
  let i = 0;
  while (i < body.length) {
    if (!isAlnum(body[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < body.length && isAlnum(body[i])) i++;
    const end = i;
    const leftOk = start === 0 ? anchor !== 'none' : body[start - 1] !== '*';
    const rightOk = end === body.length ? endAnchor : body[end] !== '*';
    const tok = body.slice(start, end);
    if (leftOk && rightOk && tok.length >= 2 && !STOP_TOKENS.has(tok) && (!best || end - start > best[1] - best[0])) {
      best = [start, end];
    }
  }
  return best ? body.slice(best[0], best[1]) : null;
}

export type { PatternSpec, Modifier };
