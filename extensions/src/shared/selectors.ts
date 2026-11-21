// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Multi-locator element picker: candidate selector generation, scoring and
// validation. DOM-free: it works on the small `ElLike` view of an element tree,
// so it runs unchanged in the content script (adapter over real elements) and
// in unit tests (plain objects). `matchSpec` is the reference matcher for the
// selector subset produced here; the picker cross-checks CSS candidates with
// the browser's querySelectorAll.

export interface ElLike {
  /** Lowercase tag name. */
  readonly tagName: string;
  readonly id: string;
  readonly classes: readonly string[];
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly parent: ElLike | null;
  readonly children: readonly ElLike[];
  /** textContent */
  readonly text: string;
}

export interface AttrTest {
  name: string;
  /** Absent = presence test. */
  value?: string;
  op?: '=' | '^=' | '*=';
}

export interface Compound {
  tag?: string;
  id?: string;
  classes?: string[];
  attrs?: AttrTest[];
  /** :nth-of-type(n), 1-based. */
  nth?: number;
  /** :has(> child) */
  has?: Compound;
  /** :has-text(text) — procedural (runtime.js), substring of textContent. */
  hasText?: string;
}

/** parts[0] is the outermost compound, the last one is the target. */
export interface SelectorSpec {
  parts: Compound[];
  /** combinators[i] joins parts[i] and parts[i+1]. */
  combinators: Array<' ' | '>'>;
}

export type CandidateKind = 'id' | 'attr' | 'class' | 'has' | 'text' | 'anchored' | 'raw-classes' | 'path';

export interface Candidate {
  kind: CandidateKind;
  spec: SelectorSpec;
  selector: string;
  procedural: boolean;
  count: number;
  score: number;
  notes: string[];
}

// ---------- hash-like names ----------

const CSS_IN_JS_PREFIX = /^(?:css|sc|jsx|emotion|styled|jss|makeStyles|tw|svelte|astro|chakra|mui-[a-z]+)-/i;

function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Looks like a generated (build-hash / CSS-in-JS) class name or id that will change between deploys. */
export function isHashLike(name: string): boolean {
  if (!name) return false;
  if (CSS_IN_JS_PREFIX.test(name)) return true;
  if (/^[a-f0-9]{6,}$/i.test(name) && /\d/.test(name)) return true;
  // CSS modules: Block_elem__3xk9F, header_a1b2c
  if (/__[A-Za-z0-9-]{5,}$/.test(name) && /\d|[A-Z].*[a-z]|[a-z].*[A-Z]/.test(name.split('__').pop()!)) return true;
  if (/_[a-zA-Z0-9]{5,}$/.test(name) && /\d/.test(name.split('_').pop()!) && /[a-z]/i.test(name.split('_').pop()!)) return true;
  const segments = name.split(/[-_]+/).filter(Boolean);
  for (const seg of segments) {
    if (/^\d+x\d+$/i.test(seg)) continue; // ad sizes: 300x250
    const digits = (seg.match(/\d/g) ?? []).length;
    const letters = (seg.match(/[a-z]/gi) ?? []).length;
    if (seg.length >= 5 && digits && letters && digits / seg.length >= 0.25) return true;
    if (seg.length >= 6 && digits && letters && shannon(seg) >= 2.8) return true;
    // Random mixed case: bdVaJa, kEjbxe (camel segments of 1-2 letters).
    if (seg.length >= 5 && /[a-z]/.test(seg) && /[A-Z]/.test(seg.slice(1)) && seg !== seg.toUpperCase()) {
      const camel = seg.split(/(?=[A-Z])/);
      if (camel.some((c) => c.length <= 2)) return true;
    }
  }
  return false;
}

// ---------- serialisation ----------

export function cssEscape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0xa0) {
      if (i === 0 && /\d/.test(ch)) out += `\\3${ch} `;
      else if (i === 0 && ch === '-' && s.length === 1) out += '\\-';
      else out += ch;
    } else out += `\\${ch}`;
  }
  return out;
}

function attrValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Text argument of :has-text(): parentheses and newlines are not allowed in it. */
export function cleanText(s: string): string {
  return s.replace(/[(),\\\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function compoundToString(c: Compound): string {
  let s = c.tag ?? '';
  if (c.id) s += `#${cssEscape(c.id)}`;
  for (const cl of c.classes ?? []) s += `.${cssEscape(cl)}`;
  for (const a of c.attrs ?? []) s += a.value === undefined ? `[${a.name}]` : `[${a.name}${a.op ?? '='}${attrValue(a.value)}]`;
  if (c.nth) s += `:nth-of-type(${c.nth})`;
  if (c.has) s += `:has(> ${compoundToString(c.has)})`;
  if (!s) s = '*';
  if (c.hasText) s += `:has-text(${c.hasText})`;
  return s;
}

export function specToString(spec: SelectorSpec): string {
  let s = compoundToString(spec.parts[0]!);
  for (let i = 1; i < spec.parts.length; i++) s += `${spec.combinators[i - 1] === '>' ? ' > ' : ' '}${compoundToString(spec.parts[i]!)}`;
  return s;
}

export function isProceduralSpec(spec: SelectorSpec): boolean {
  return spec.parts.some((p) => p.hasText !== undefined || p.has?.hasText !== undefined);
}

/** The CSS part of a procedural spec (hasText removed) — what querySelectorAll can pre-filter with. */
export function cssPart(spec: SelectorSpec): SelectorSpec {
  return { parts: spec.parts.map(({ hasText: _drop, ...rest }) => rest), combinators: spec.combinators };
}

// ---------- matching ----------

function nthOfType(el: ElLike): number {
  const p = el.parent;
  if (!p) return 1;
  let n = 0;
  for (const c of p.children) {
    if (c.tagName === el.tagName) n++;
    if (c === el) return n;
  }
  return n;
}

function attrOf(el: ElLike, name: string): string | undefined {
  for (const [n, v] of el.attrs) if (n === name) return v;
  return undefined;
}

export function matchCompound(el: ElLike, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id !== undefined && el.id !== c.id) return false;
  for (const cl of c.classes ?? []) if (!el.classes.includes(cl)) return false;
  for (const a of c.attrs ?? []) {
    const v = attrOf(el, a.name);
    if (v === undefined) return false;
    if (a.value !== undefined) {
      const op = a.op ?? '=';
      if (op === '=' && v !== a.value) return false;
      if (op === '^=' && !v.startsWith(a.value)) return false;
      if (op === '*=' && !v.includes(a.value)) return false;
    }
  }
  if (c.nth && nthOfType(el) !== c.nth) return false;
  if (c.has && !el.children.some((ch) => matchCompound(ch, c.has!))) return false;
  if (c.hasText !== undefined && !el.text.includes(c.hasText)) return false;
  return true;
}

export function matchSpec(el: ElLike, spec: SelectorSpec): boolean {
  const go = (node: ElLike, i: number): boolean => {
    if (!matchCompound(node, spec.parts[i]!)) return false;
    if (i === 0) return true;
    if (spec.combinators[i - 1] === '>') return !!node.parent && go(node.parent, i - 1);
    for (let a = node.parent; a; a = a.parent) if (go(a, i - 1)) return true;
    return false;
  };
  return go(el, spec.parts.length - 1);
}

export function* walk(root: ElLike): Generator<ElLike> {
  yield root;
  for (const c of root.children) yield* walk(c);
}

export function querySpec(root: ElLike, spec: SelectorSpec): ElLike[] {
  const out: ElLike[] = [];
  for (const el of walk(root)) if (matchSpec(el, spec)) out.push(el);
  return out;
}

// ---------- scoring ----------

const SEMANTIC_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-component', 'data-module'];
const LABEL_ATTRS = ['aria-label', 'aria-labelledby', 'role', 'name', 'itemtype', 'title', 'alt', 'data-label'];

function isAdAttr(name: string): boolean {
  return /^data-(?:ad|ads|advert|google-query-id|ad-[a-z-]+|ad[a-z-]*)$/.test(name) || /^data-ad/.test(name);
}

/** Lower is better. Hash-like names, positional indices and depth are penalised. */
export function scoreSpec(spec: SelectorSpec, count: number): { score: number; notes: string[] } {
  let score = 0;
  const notes: string[] = [];
  const visit = (c: Compound, nested: boolean) => {
    if (c.id !== undefined) {
      if (isHashLike(c.id)) {
        score += 50;
        notes.push(`hash-like id #${c.id}`);
      } else score -= 1;
    }
    for (const cl of c.classes ?? []) {
      if (isHashLike(cl)) {
        score += 50;
        notes.push(`hash-like class .${cl}`);
      } else score += 1;
    }
    for (const a of c.attrs ?? []) {
      if (SEMANTIC_ATTRS.includes(a.name)) score += 0.5;
      else if (isAdAttr(a.name)) score += 1;
      else if (LABEL_ATTRS.includes(a.name)) score += 2.5;
      else score += 3;
      if (a.value !== undefined && isHashLike(a.value.replace(/\s+/g, '-'))) {
        score += 30;
        notes.push(`hash-like value ${a.name}`);
      }
    }
    if (c.nth) {
      score += 8;
      notes.push('positional index');
    }
    if (c.has) {
      score += 2;
      visit(c.has, true);
    }
    if (c.hasText !== undefined) {
      score += 4;
      notes.push('procedural (:has-text)');
    }
    const bare = !c.id && !c.classes?.length && !c.attrs?.length && !c.has && c.hasText === undefined && !c.nth;
    if (bare) score += nested ? 3 : 1;
  };
  spec.parts.forEach((p) => visit(p, false));
  const depth = spec.parts.length - 1;
  if (depth) {
    score += depth * 3;
    notes.push(`depth ${depth}`);
  }
  if (count === 0) {
    score += 1000;
    notes.push('matches nothing');
  } else if (count > 1) {
    score += Math.min(20, 3 * Math.log2(count));
    notes.push(`${count} matches`);
  }
  score += specToString(spec).length / 50;
  return { score: Math.round(score * 100) / 100, notes };
}

// ---------- generation ----------

export interface Counter {
  /** Number of elements in the document matching `spec`. */
  count(spec: SelectorSpec): number;
}

function single(c: Compound): SelectorSpec {
  return { parts: [c], combinators: [] };
}

function stableClasses(el: ElLike): string[] {
  return el.classes.filter((c) => c && !isHashLike(c));
}

function ownText(el: ElLike): string {
  // Shortest distinctive text: the first few words of the element's text.
  const words = cleanText(el.text).split(' ').filter(Boolean);
  return words.slice(0, 4).join(' ').slice(0, 40);
}

/** A compound that identifies `el` without positional indices, or null. */
function anchorOf(el: ElLike): Compound | null {
  if (el.id && !isHashLike(el.id)) return { tag: el.tagName, id: el.id };
  for (const [n, v] of el.attrs) if (SEMANTIC_ATTRS.includes(n) && v && !isHashLike(v)) return { tag: el.tagName, attrs: [{ name: n, value: v }] };
  const cls = stableClasses(el);
  if (cls.length) return { tag: el.tagName, classes: [cls[0]!] };
  return null;
}

function pathFrom(ancestor: ElLike | null, el: ElLike): { parts: Compound[]; combinators: Array<' ' | '>'> } {
  const chain: ElLike[] = [];
  for (let n: ElLike | null = el; n && n !== ancestor; n = n.parent) chain.unshift(n);
  const parts = chain.map((n) => {
    const p = n.parent;
    const sameTag = p ? p.children.filter((c) => c.tagName === n.tagName).length : 1;
    return sameTag > 1 ? { tag: n.tagName, nth: nthOfType(n) } : { tag: n.tagName };
  });
  return { parts, combinators: parts.map(() => '>' as const) };
}

function make(kind: CandidateKind, spec: SelectorSpec, counter: Counter): Candidate {
  const count = counter.count(spec);
  const { score, notes } = scoreSpec(spec, count);
  return { kind, spec, selector: specToString(spec), procedural: isProceduralSpec(spec), count, score, notes };
}

/**
 * Candidate selectors for `el`, best first. Always returns at least five
 * distinct selectors when the element tree allows it (the positional paths are
 * the last resort).
 */
export function generateCandidates(el: ElLike, counter: Counter): Candidate[] {
  const tag = el.tagName;
  const out: Candidate[] = [];
  const add = (kind: CandidateKind, spec: SelectorSpec) => {
    const c = make(kind, spec, counter);
    if (c.count > 0 && !out.some((o) => o.selector === c.selector)) out.push(c);
  };

  // 1. id
  if (el.id) add('id', single({ tag, id: el.id }));

  // 2. semantic attributes
  for (const [n, v] of el.attrs) {
    if (SEMANTIC_ATTRS.includes(n) && v) add('attr', single({ tag, attrs: [{ name: n, value: v }] }));
    else if (isAdAttr(n)) add('attr', single({ tag, attrs: [{ name: n }] }));
    else if (LABEL_ATTRS.includes(n) && v && v.length <= 80) add('attr', single({ tag, attrs: [{ name: n, value: v }] }));
  }

  // 3. stable class combination: the rarest single class, then the rarest pair.
  const cls = stableClasses(el);
  if (cls.length) {
    const ranked = cls.map((c) => [c, counter.count(single({ tag, classes: [c] }))] as const).sort((a, b) => a[1] - b[1]);
    const best = ranked[0]!;
    if (best[1] <= 1 || ranked.length === 1) add('class', single({ tag, classes: [best[0]] }));
    else {
      let pair: string[] = [best[0], ranked[1]![0]];
      let pc = counter.count(single({ tag, classes: pair }));
      for (let i = 1; i < ranked.length && pc > 1; i++) {
        for (let j = i + 1; j < ranked.length; j++) {
          const p = [ranked[i]![0], ranked[j]![0]];
          const n = counter.count(single({ tag, classes: p }));
          if (n >= 1 && n < pc) {
            pair = p;
            pc = n;
          }
        }
      }
      add('class', single({ tag, classes: pair }));
      add('class', single({ tag, classes: [best[0]] }));
    }
  }

  // 4. structural :has(> child) with a stable child feature
  for (const ch of el.children) {
    const a = anchorOf(ch);
    const childAttr = ch.attrs.find(([n, v]) => (SEMANTIC_ATTRS.includes(n) || LABEL_ATTRS.includes(n) || n === 'src' || n === 'href') && v && v.length <= 80);
    const hasC: Compound | null = a ?? (childAttr ? { tag: ch.tagName, attrs: [{ name: childAttr[0], value: childAttr[1] }] } : null);
    if (hasC) {
      add('has', single({ tag, has: hasC }));
      break;
    }
  }
  if (!out.some((c) => c.kind === 'has') && el.children.length) {
    const ch = el.children[0]!;
    add('has', single({ tag, has: { tag: ch.tagName } }));
  }

  // 5. procedural :has-text()
  const text = ownText(el);
  if (text.length >= 3) {
    const t = single({ tag, hasText: text });
    // Ancestors contain the same text; anchor on the parent when that helps.
    if (counter.count(t) === 1) add('text', t);
    else {
      const p = el.parent;
      const pa = p ? anchorOf(p) ?? (p.tagName !== 'body' && p.tagName !== 'html' ? { tag: p.tagName } : null) : null;
      if (pa) add('text', { parts: [pa, { tag, hasText: text }], combinators: ['>'] });
      else add('text', t);
    }
  }

  // 6. anchored path from the nearest stable ancestor
  for (let a = el.parent, depth = 1; a && depth <= 4; a = a.parent, depth++) {
    const anc = anchorOf(a);
    if (anc) {
      const rel = pathFrom(a, el);
      add('anchored', { parts: [anc, ...rel.parts], combinators: ['>', ...rel.combinators.slice(1)] });
      break;
    }
  }

  // 7. all classes (what a naive picker writes) — kept as a visible, penalised option
  if (el.classes.length && el.classes.length !== cls.length) add('raw-classes', single({ tag, classes: [...el.classes] }));

  // 8. positional path from the root
  const root = pathFrom(null, el);
  add('path', { parts: root.parts, combinators: root.combinators.slice(1) });
  if (out.length < 5 && root.parts.length > 2) {
    const short = { parts: root.parts.slice(-2), combinators: ['>' as const] };
    add('path', short);
  }

  return out.sort((a, b) => a.score - b.score);
}

// ---------- validation ----------

export const MAX_MATCHES = 50;
export const MAX_TEXT_SHARE = 0.5;

export interface PickStats {
  count: number;
  /** A match is (or contains) html, body or main. */
  matchesRoot: boolean;
  /** Text of the matched elements / text of the whole page. */
  textShare: number;
}

export function validatePick(s: PickStats): { ok: true } | { ok: false; reason: string } {
  if (s.count === 0) return { ok: false, reason: 'matches nothing' };
  if (s.matchesRoot) return { ok: false, reason: 'would hide the whole page (html/body/main)' };
  if (s.count > MAX_MATCHES) return { ok: false, reason: `matches ${s.count} elements (max ${MAX_MATCHES})` };
  if (s.textShare > MAX_TEXT_SHARE) return { ok: false, reason: `would hide ${Math.round(s.textShare * 100)}% of the page text` };
  return { ok: true };
}

/** String-level checks the background repeats before saving a user rule. */
export function selectorStringProblem(sel: string): string | null {
  const s = sel.trim();
  if (!s) return 'empty';
  if (s.length > 400) return 'too long';
  if (/[{}]/.test(s) || /\n/.test(s)) return 'invalid characters';
  if (/^(?:html|body|main|:root|\*)$/i.test(s)) return 'selects the whole page';
  if (s.replace(/"(?:[^"\\]|\\.)*"/g, '""').includes(',')) return 'selector lists are not allowed';
  return null;
}

// ---------- fallbacks ----------

export interface Fingerprint {
  tag: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number } | null;
}

function iou(a: NonNullable<Fingerprint['rect']>, b: NonNullable<Fingerprint['rect']>): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Does a fallback's match look like the element the user originally picked? */
export function sameRegion(saved: Fingerprint, now: Fingerprint): boolean {
  if (saved.tag !== now.tag) return false;
  const a = cleanText(saved.text).slice(0, 60).toLowerCase();
  const b = cleanText(now.text).slice(0, 60).toLowerCase();
  if (a && b && (a === b || (a.length >= 8 && b.includes(a.slice(0, 20))) || (b.length >= 8 && a.includes(b.slice(0, 20))))) return true;
  if (saved.rect && now.rect && iou(saved.rect, now.rect) >= 0.5) return true;
  return !a && !b && !saved.rect;
}

export interface PickerRule {
  id: string;
  site: string;
  /** Ranked selectors: index 0 was the primary at save time. */
  selectors: string[];
  /** Index of the selector currently applied. */
  active: number;
  /** Match count of each selector at save time (a fallback may not match more). */
  counts: number[];
  fingerprint: Fingerprint;
  createdAt: number;
  switchedAt?: number;
}

/** The filter line a picker rule contributes (site-specific, so procedural selectors are allowed). */
export function pickerRuleLine(r: PickerRule): string {
  return `${r.site}##${r.selectors[r.active] ?? r.selectors[0]}`;
}
