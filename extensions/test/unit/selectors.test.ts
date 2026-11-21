// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Element picker: hash-like name detection, candidate generation, scoring,
// validation and fallback region matching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cssEscape, generateCandidates, isHashLike, matchSpec, querySpec, sameRegion, scoreSpec, selectorStringProblem,
  specToString, validatePick, walk,
} from '../../src/shared/selectors.ts';
import type { ElLike, SelectorSpec } from '../../src/shared/selectors.ts';
import { parseLine } from '../../src/shared/parse.ts';

// ---- tiny element tree builder ----
interface Node extends ElLike {
  children: Node[];
  parent: Node | null;
}
function h(tag: string, attrs: Record<string, string> = {}, ...kids: Array<Node | string>): Node {
  const classes = (attrs.class ?? '').split(/\s+/).filter(Boolean);
  const node: Node = {
    tagName: tag, id: attrs.id ?? '', classes, attrs: Object.entries(attrs), parent: null, children: [],
    get text(): string {
      return own.join('') + this.children.map((c) => c.text).join('');
    },
  };
  const own: string[] = [];
  for (const k of kids) {
    if (typeof k === 'string') own.push(k);
    else {
      k.parent = node;
      node.children.push(k);
    }
  }
  return node;
}
const counterFor = (root: Node) => ({ count: (s: SelectorSpec) => querySpec(root, s).length });
function find(root: Node, pred: (n: ElLike) => boolean): Node {
  for (const n of walk(root)) if (pred(n)) return n as Node;
  throw new Error('not found');
}

test('hash-like class names are recognised', () => {
  const hashy = ['css-1x9fz7k', 'sc-bdVaJa', 'kEjbxe', 'jsx-8a7f6e2b', 'Card_root__3xk9F', 'header_a1b2c', 'a8f3e2c1', 'emotion-0', 'x7Fq2LpZ', 'styles_wrapper__Zx81q', 'makeStyles-root-12', 'bdVaJa'];
  const stable = ['promo-unit', 'ad-banner', 'sidebar', 'mainContent', 'col-6', 'mt-4', 'grid-cols-12', 'ad-300x250', 'btn-primary', 'article__header', 'is-active', 'Header', 'navBar', 'h1', 'top-ad'];
  for (const n of hashy) assert.ok(isHashLike(n), `${n} should be hash-like`);
  for (const n of stable) assert.ok(!isHashLike(n), `${n} should be stable`);
});

test('cssEscape handles leading digits and punctuation', () => {
  assert.equal(cssEscape('ad-box'), 'ad-box');
  assert.equal(cssEscape('1col'), '\\31 col');
  assert.equal(cssEscape('a:b.c'), 'a\\:b\\.c');
});

test('matchSpec: descendant, child, nth-of-type, :has, :has-text', () => {
  const root = h('html', {}, h('body', {},
    h('div', { class: 'wrap' }, h('p', {}, 'one'), h('p', { class: 'x' }, 'two')),
    h('section', {}, h('p', {}, 'three'))));
  const c = counterFor(root);
  assert.equal(c.count({ parts: [{ tag: 'div' }, { tag: 'p' }], combinators: [' '] }), 2);
  assert.equal(c.count({ parts: [{ tag: 'body' }, { tag: 'p' }], combinators: ['>'] }), 0);
  assert.equal(c.count({ parts: [{ tag: 'p', nth: 2 }], combinators: [] }), 1);
  assert.equal(c.count({ parts: [{ tag: 'div', has: { tag: 'p', classes: ['x'] } }], combinators: [] }), 1);
  assert.equal(c.count({ parts: [{ tag: 'p', hasText: 'thr' }], combinators: [] }), 1);
  assert.equal(specToString({ parts: [{ tag: 'div', classes: ['wrap'] }, { tag: 'p', nth: 2 }], combinators: ['>'] }), 'div.wrap > p:nth-of-type(2)');
});

function fixture(promoClass = 'promo-unit'): Node {
  return h('html', {}, h('body', {},
    h('header', { class: 'css-9k2j1a site-header' }, 'Site name'),
    h('main', {},
      h('article', { class: 'sc-fzXfMv Article_body__2kD9s' }, 'Lots of real article text here that people came to read.'),
      h('aside', { class: `css-1q2w3e4 ${promoClass} jsx-8a7f6e2b`, 'aria-label': 'Sponsored offer' },
        h('span', { class: 'sc-AxjAm' }, 'Sponsored'), ' Buy the new widget today'),
      h('aside', { class: 'css-77aa1b2 related-links', 'aria-label': 'Related' }, h('span', { class: 'sc-AxjAm' }, 'Related'), ' More stories')),
    h('footer', { class: 'Footer_root__9fK2q' }, 'Footer')));
}

test('candidates for an element with hashed classes: ≥5, best one stable and unique', () => {
  const root = fixture();
  const target = find(root, (n) => n.attrs.some(([k, v]) => k === 'aria-label' && v === 'Sponsored offer'));
  const cands = generateCandidates(target, counterFor(root));
  assert.ok(cands.length >= 5, cands.map((c) => c.selector).join(' | '));
  const kinds = new Set(cands.map((c) => c.kind));
  for (const k of ['class', 'attr', 'has', 'text', 'path']) assert.ok(kinds.has(k as never), `missing ${k}: ${[...kinds]}`);
  const best = cands[0]!;
  assert.equal(best.selector, 'aside.promo-unit');
  assert.equal(best.count, 1);
  for (const c of cands) {
    assert.ok(matchSpec(target, c.spec), `${c.selector} must match the target`);
    if (c.kind !== 'raw-classes') assert.ok(!/css-|jsx-|sc-/.test(c.selector), `${c.selector} uses a hashed class`);
  }
  // The naive all-classes selector is offered but ranked below every stable one.
  const raw = cands.find((c) => c.kind === 'raw-classes')!;
  assert.ok(raw && raw.score > cands.filter((c) => c.kind !== 'raw-classes' && c.kind !== 'path').reduce((m, c) => Math.max(m, c.score), 0));
  // Sorted by score.
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1]!.score <= cands[i]!.score);
  // Every candidate is a valid site-specific user rule.
  for (const c of cands) {
    const p = parseLine(`example.com##${c.selector}`);
    assert.ok(p.kind === (c.procedural ? 'procedural' : 'cosmetic'), `${c.selector} → ${p.kind}`);
  }
});

test('fallbacks keep matching the same element after the primary class changes', () => {
  const v1 = fixture();
  const t1 = find(v1, (n) => n.attrs.some(([k, v]) => k === 'aria-label' && v === 'Sponsored offer'));
  const cands = generateCandidates(t1, counterFor(v1));
  const v2 = fixture('promo-card');
  const t2 = find(v2, (n) => n.attrs.some(([k, v]) => k === 'aria-label' && v === 'Sponsored offer'));
  const c2 = counterFor(v2);
  assert.equal(c2.count(cands[0]!.spec), 0, 'primary no longer matches');
  const still = cands.slice(1).filter((c) => c.count === 1 && c2.count(c.spec) === 1 && matchSpec(t2, c.spec));
  assert.ok(still.length >= 2, `fallbacks still matching: ${still.map((c) => c.selector)}`);
  assert.ok(still.some((c) => c.selector === 'aside[aria-label="Sponsored offer"]'));
});

test('ids and data-testid beat classes; hash-like ids are penalised', () => {
  const root = h('html', {}, h('body', {},
    h('div', { id: 'ad-slot-top', class: 'banner', 'data-testid': 'top-ad' }, 'Ad'),
    h('div', { id: 'r8f3k2j9x', class: 'banner2' }, 'Other')));
  const a = generateCandidates(find(root, (n) => n.id === 'ad-slot-top'), counterFor(root));
  assert.equal(a[0]!.selector, 'div#ad-slot-top');
  assert.equal(a[1]!.selector, 'div[data-testid="top-ad"]');
  const b = generateCandidates(find(root, (n) => n.id === 'r8f3k2j9x'), counterFor(root));
  assert.notEqual(b[0]!.kind, 'id');
  assert.ok(b.find((c) => c.kind === 'id')!.notes.some((n) => n.includes('hash-like id')));
});

test('data-ad* attributes become presence selectors', () => {
  const root = h('html', {}, h('body', {}, h('ins', { 'data-ad-slot': '12345', class: 'x8f2k1a9' }), h('p', {}, 'content')));
  const c = generateCandidates(find(root, (n) => n.tagName === 'ins'), counterFor(root));
  assert.ok(c.some((x) => x.selector === 'ins[data-ad-slot]'));
  assert.equal(c[0]!.selector, 'ins[data-ad-slot]');
});

test('scoring penalises positional indices, depth, hashes and over-matching', () => {
  const base = scoreSpec({ parts: [{ tag: 'div', classes: ['promo'] }], combinators: [] }, 1).score;
  assert.ok(scoreSpec({ parts: [{ tag: 'div', nth: 3 }], combinators: [] }, 1).score > base);
  assert.ok(scoreSpec({ parts: [{ tag: 'section' }, { tag: 'div', classes: ['promo'] }], combinators: ['>'] }, 1).score > base);
  assert.ok(scoreSpec({ parts: [{ tag: 'div', classes: ['css-1x9fz7k'] }], combinators: [] }, 1).score > base + 40);
  assert.ok(scoreSpec({ parts: [{ tag: 'div', classes: ['promo'] }], combinators: [] }, 12).score > base);
  assert.ok(scoreSpec({ parts: [{ tag: 'div', classes: ['promo'] }], combinators: [] }, 0).score >= 1000);
});

test('validation refuses page-wide selectors', () => {
  assert.deepEqual(validatePick({ count: 1, matchesRoot: false, textShare: 0.1 }), { ok: true });
  assert.equal(validatePick({ count: 0, matchesRoot: false, textShare: 0 }).ok, false);
  assert.equal(validatePick({ count: 1, matchesRoot: true, textShare: 0.1 }).ok, false);
  assert.equal(validatePick({ count: 51, matchesRoot: false, textShare: 0.1 }).ok, false);
  assert.equal(validatePick({ count: 50, matchesRoot: false, textShare: 0.1 }).ok, true);
  assert.equal(validatePick({ count: 2, matchesRoot: false, textShare: 0.8 }).ok, false);
  for (const s of ['html', 'body', 'MAIN', '*', ':root', '', 'div { color: red }', 'a, b']) assert.notEqual(selectorStringProblem(s), null, s);
  for (const s of ['aside.promo', 'div[aria-label="Ads, sponsored"]', 'aside:has-text(Sponsored)', 'body > div:nth-of-type(2)']) assert.equal(selectorStringProblem(s), null, s);
});

test('sameRegion compares tag, text and position', () => {
  const fp = { tag: 'aside', text: 'Sponsored Buy the new widget today', rect: { x: 0, y: 100, w: 300, h: 250 } };
  assert.ok(sameRegion(fp, { tag: 'aside', text: 'Sponsored Buy the new widget today', rect: null }));
  assert.ok(sameRegion(fp, { tag: 'aside', text: 'something else', rect: { x: 10, y: 110, w: 300, h: 250 } }));
  assert.ok(!sameRegion(fp, { tag: 'div', text: 'Sponsored Buy the new widget today', rect: null }));
  assert.ok(!sameRegion(fp, { tag: 'aside', text: 'Related More stories', rect: { x: 0, y: 900, w: 300, h: 100 } }));
});
