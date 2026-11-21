// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Fix-this-site bisection: convergence, question budget, ties, interacting
// culprits, noisy answers, serialisation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, chunks, newBisect, nextStep, runBisect } from '../../src/shared/bisect.ts';
import type { BisectState } from '../../src/shared/bisect.ts';

/** Page works iff every culprit is disabled (the usual case: each culprit alone breaks it). */
const allOf = (culprits: number[]) => (disabled: number[]) => culprits.every((c) => disabled.includes(c));
/** Page works iff any culprit is disabled (breakage needs all of them together). */
const anyOf = (culprits: number[]) => (disabled: number[]) => culprits.some((c) => disabled.includes(c));

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('chunks are contiguous, ordered and cover the set', () => {
  assert.deepEqual(chunks([0, 1, 2, 3, 4], 2), [[0, 1, 2], [3, 4]]);
  assert.deepEqual(chunks([5, 7, 9], 3), [[5], [7], [9]]);
  assert.deepEqual(chunks([1, 2], 4), [[1], [2]]);
});

test('single culprit: converges to exactly that rule for every size and position', () => {
  for (let n = 1; n <= 40; n++) {
    for (let k = 0; k < n; k++) {
      const { step, state } = runBisect(n, allOf([k]));
      assert.deepEqual(step, { type: 'done', culprits: [k] }, `n=${n} k=${k}`);
      // initial + ~2 per halving + confirm
      const bound = 2 * Math.ceil(Math.log2(Math.max(n, 2))) + 3;
      assert.ok(state.asked <= bound, `n=${n} k=${k}: ${state.asked} questions > ${bound}`);
    }
  }
});

test('halving: the first tests disable the riskier half of the remaining set', () => {
  const st = newBisect(8);
  let s = nextStep(st);
  assert.deepEqual(s.type === 'test' && s.disable, [0, 1, 2, 3, 4, 5, 6, 7]); // initial: everything
  s = answer(st, true);
  assert.deepEqual(s.type === 'test' && s.disable, [0, 1, 2, 3]); // riskier half first
  s = answer(st, false);
  assert.deepEqual(s.type === 'test' && s.disable, [4, 5, 6, 7]);
  s = answer(st, true);
  assert.deepEqual(s.type === 'test' && s.disable, [4, 5]);
  s = answer(st, true);
  assert.deepEqual(s.type === 'test' && s.disable, [4]);
  s = answer(st, false);
  assert.deepEqual(s.type === 'test' && s.disable, [5]);
  s = answer(st, true);
  // Confirmation re-runs exactly the result.
  assert.deepEqual(s.type === 'test' && [s.disable, s.phase], [[5], 'confirm']);
  s = answer(st, true);
  assert.deepEqual(s, { type: 'done', culprits: [5] });
});

test('page broken even with everything disabled: not caused by rules (asked twice)', () => {
  const { step, state } = runBisect(10, () => false);
  assert.deepEqual(step, { type: 'failed', reason: 'not-caused-by-rules', best: null });
  assert.equal(state.asked, 2);
});

test('no candidates fails immediately', () => {
  assert.deepEqual(runBisect(0, () => true).step, { type: 'failed', reason: 'no-candidates', best: null });
});

test('two culprits that each break the page: converges to both', () => {
  for (const n of [2, 5, 9, 16, 33]) {
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const { step } = runBisect(n, allOf([a, b]), 80);
        assert.deepEqual(step, { type: 'done', culprits: [a, b] }, `n=${n} a=${a} b=${b}`);
      }
    }
  }
});

test('three culprits: 1-minimal result', () => {
  const { step } = runBisect(24, allOf([2, 11, 23]), 80);
  assert.deepEqual(step, { type: 'done', culprits: [2, 11, 23] });
});

test('ties: when either of two rules alone fixes the page, the higher-ranked one is kept', () => {
  for (const [a, b] of [[0, 1], [3, 7], [1, 14], [6, 9]] as const) {
    const { step } = runBisect(16, anyOf([a, b]));
    assert.deepEqual(step, { type: 'done', culprits: [a] }, `tie ${a}/${b}`);
  }
  // Deterministic: same inputs, same questions.
  const r1 = runBisect(16, anyOf([3, 7])).state.history;
  const r2 = runBisect(16, anyOf([3, 7])).state.history;
  assert.deepEqual(r1, r2);
});

test('noisy answers: any single wrong answer still converges to the culprit', () => {
  for (const n of [1, 2, 3, 7, 12, 25]) {
    for (let k = 0; k < n; k++) {
      const clean = runBisect(n, allOf([k])).state.asked;
      for (let flip = 1; flip <= clean + 1; flip++) {
        let i = 0;
        const truth = allOf([k]);
        const { step, state } = runBisect(n, (d) => (++i === flip ? !truth(d) : truth(d)), 60);
        assert.deepEqual(step, { type: 'done', culprits: [k] }, `n=${n} k=${k} flip@${flip}: ${JSON.stringify(state.history)}`);
      }
    }
  }
});

test('noisy answers: random 10% error rate mostly converges and never returns a wrong single rule silently', () => {
  let ok = 0;
  let wrong = 0;
  const runs = 300;
  for (let r = 0; r < runs; r++) {
    const rnd = seeded(r + 1);
    const n = 4 + Math.floor(rnd() * 28);
    const k = Math.floor(rnd() * n);
    const truth = allOf([k]);
    const { step } = runBisect(n, (d) => (rnd() < 0.1 ? !truth(d) : truth(d)), 60);
    if (step.type === 'done' && step.culprits.length === 1 && step.culprits[0] === k) ok++;
    else if (step.type === 'done' && !step.culprits.includes(k)) wrong++;
  }
  assert.ok(ok / runs >= 0.9, `converged ${ok}/${runs}`);
  assert.ok(wrong / runs <= 0.02, `wrong result ${wrong}/${runs}`);
});

test('question budget is enforced', () => {
  let i = 0;
  const { step, state } = runBisect(64, () => (i++ % 2 === 0), 5);
  assert.equal(step.type, 'failed');
  assert.ok(state.asked <= 5);
});

test('state survives JSON round trips between answers (service worker restarts)', () => {
  let st: BisectState = newBisect(19);
  let s = nextStep(st);
  const truth = allOf([13]);
  while (s.type === 'test') {
    st = JSON.parse(JSON.stringify(st)) as BisectState;
    s = answer(st, truth(s.disable));
  }
  assert.deepEqual(s, { type: 'done', culprits: [13] });
});
