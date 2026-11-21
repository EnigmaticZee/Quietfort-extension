// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Fix-this-site bisection: find the smallest set of rules whose removal makes
// the page work, asking one "Is the page working now?" question per reload.
//
// Candidates are indices 0..n-1 in risk order (see risk.ts). A *test* disables
// a subset; the answer says whether the page works with that subset disabled.
//
//   1. initial  disable everything that acted on the page. If the page is still
//               broken, blocking is not the cause (stop, change nothing).
//   2. ddmin    Zeller's delta debugging: split the current culprit set into
//               chunks (contiguous in risk order, so the riskier half is tried
//               first), keep a chunk / complement that still fixes the page,
//               otherwise refine the granularity. With one culprit this halves
//               the set at every step; with several interacting culprits it
//               converges to a 1-minimal set.
//   3. confirm  disable exactly the result once more (this is also the moment
//               the user sees the fixed page). Never answered from the cache.
//
// Answers are cached and propagated by monotonicity (if disabling S fixes the
// page, disabling any superset does too; if disabling S does not, no subset
// does), which saves reloads. Noise handling: a "No" on the decisive initial
// or confirm test is asked again (best of three). A failed confirmation means
// an earlier answer was wrong, so the search restarts in robust mode, where
// every test is asked until two answers agree. The state is plain JSON so the
// service worker can persist it between reloads.

export type BisectPhase = 'initial' | 'ddmin' | 'verify' | 'confirm' | 'done' | 'failed';

export interface BisectState {
  n: number;
  phase: BisectPhase;
  robust: boolean;
  restarts: number;
  /** Current culprit set (indices, ascending = risk order). */
  c: number[];
  /** Earlier (larger) culprit sets, for backtracking after a wrong "Yes". */
  parents: number[][];
  /** Sets whose "Yes" was double-checked. */
  verified: string[];
  gran: number;
  stage: 'chunks' | 'complements';
  idx: number;
  pending: { set: number[]; votes: boolean[]; noCache: boolean } | null;
  /** Decided tests: key → works. */
  cache: Array<[string, boolean]>;
  asked: number;
  maxQuestions: number;
  history: Array<{ set: number[]; works: boolean }>;
  result: number[] | null;
  reason: string | null;
}

export type BisectStep =
  | { type: 'test'; disable: number[]; step: number; phase: BisectPhase }
  | { type: 'done'; culprits: number[] }
  | { type: 'failed'; reason: string; best: number[] | null };

const key = (set: number[]) => set.join(',');

function isSubset(a: number[], b: number[]): boolean {
  if (a.length > b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

/** Split `c` into `n` contiguous chunks of near-equal size (first chunks larger). */
export function chunks(c: number[], n: number): number[][] {
  const out: number[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.floor(c.length / n) + (i < c.length % n ? 1 : 0);
    out.push(c.slice(start, start + size));
    start += size;
  }
  return out.filter((x) => x.length);
}

export function newBisect(n: number, maxQuestions = 40): BisectState {
  const all = Array.from({ length: n }, (_, i) => i);
  return {
    n, phase: n ? 'initial' : 'failed', robust: false, restarts: 0, c: all, parents: [], verified: [], gran: 2, stage: 'chunks', idx: 0,
    pending: null, cache: [], asked: 0, maxQuestions, history: [], result: null, reason: n ? null : 'no-candidates',
  };
}

function lookup(st: BisectState, set: number[]): boolean | undefined {
  const k = key(set);
  for (const [ck, v] of st.cache) if (ck === k) return v;
  for (const [ck, v] of st.cache) {
    const cs = ck ? ck.split(',').map(Number) : [];
    if (v && isSubset(cs, set)) return true; // a subset already fixes it
    if (!v && isSubset(set, cs)) return false; // a superset did not fix it
  }
  return undefined;
}

/** The test the current phase wants to run next. */
function currentSet(st: BisectState): { set: number[]; noCache: boolean } | null {
  switch (st.phase) {
    case 'initial':
      return { set: Array.from({ length: st.n }, (_, i) => i), noCache: false };
    case 'confirm': case 'verify':
      return { set: st.c, noCache: true };
    case 'ddmin': {
      const parts = chunks(st.c, st.gran);
      const part = parts[st.idx];
      if (!part) return null;
      if (st.stage === 'chunks') return { set: part, noCache: false };
      const drop = new Set(part);
      return { set: st.c.filter((x) => !drop.has(x)), noCache: false };
    }
    default:
      return null;
  }
}

function startDdmin(st: BisectState, c: number[], gran = 2): void {
  if (c.length < st.c.length) st.parents.push(st.c);
  st.c = c;
  if (c.length <= 1) {
    st.phase = 'confirm';
    return;
  }
  st.phase = 'ddmin';
  st.gran = Math.min(gran, c.length);
  st.stage = 'chunks';
  st.idx = 0;
}

function finish(st: BisectState, ok: boolean, reason: string | null, result: number[] | null): void {
  st.phase = ok ? 'done' : 'failed';
  st.reason = reason;
  st.result = result;
  st.pending = null;
}

/** Apply a decided test result to the state machine. */
function resolve(st: BisectState, set: number[], works: boolean): void {
  switch (st.phase) {
    case 'initial':
      if (!works) return finish(st, false, 'not-caused-by-rules', null);
      return startDdmin(st, set);
    case 'verify':
      st.verified.push(key(st.c));
      if (works) {
        // The set really fixes the page: carry on refining it.
        st.phase = 'ddmin';
        return resolve(st, [], false);
      }
      // The "Yes" that led here was wrong: back to the previous set.
      st.c = st.parents.pop() ?? Array.from({ length: st.n }, (_, i) => i);
      return startDdmin(st, st.c);
    case 'confirm':
      if (works) return finish(st, true, null, [...st.c]);
      if (st.restarts >= 3) return finish(st, false, 'inconsistent-answers', null);
      // An earlier answer must have been wrong: start over, double-checking everything.
      st.robust = true;
      st.restarts++;
      st.cache = [];
      st.phase = 'initial';
      return;
    case 'ddmin': {
      const parts = chunks(st.c, st.gran);
      if (works) {
        if (st.stage === 'chunks') return startDdmin(st, set, 2);
        return startDdmin(st, set, Math.max(st.gran - 1, 2));
      }
      if (set.length) st.idx++;
      if (st.idx < parts.length) return;
      if (st.gran === 2 && st.stage === 'chunks' && set.length && st.c.length < st.n && !st.verified.includes(key(st.c))) {
        // Neither half fixes the page although the whole set did: either the
        // culprits interact, or the earlier "Yes" was wrong. Ask that one again.
        st.phase = 'verify';
        return;
      }
      if (st.stage === 'chunks' && st.gran > 2) {
        st.stage = 'complements';
        st.idx = 0;
        return;
      }
      if (st.gran < st.c.length) {
        st.gran = Math.min(st.gran * 2, st.c.length);
        st.stage = 'chunks';
        st.idx = 0;
        return;
      }
      if (!st.robust && st.c.length > 1) {
        // Several rules look necessary. That is either a real interaction or a
        // wrong "No" earlier on: re-check the "No" answers inside this set
        // (best of three) before excepting more than one rule.
        st.robust = true;
        st.restarts++;
        st.cache = st.cache.filter(([, v]) => v);
        st.parents.push(st.c);
        st.gran = 2;
        st.stage = 'chunks';
        st.idx = 0;
        return;
      }
      st.phase = 'confirm';
      return;
    }
    default:
  }
}

/** Has the pending test collected enough answers? Returns the decision or undefined. */
function decided(st: BisectState): boolean | undefined {
  const p = st.pending!;
  const yes = p.votes.filter(Boolean).length;
  const no = p.votes.length - yes;
  const decisive = st.phase === 'initial' || st.phase === 'confirm' || st.phase === 'verify';
  if (st.robust) {
    if (yes >= 2) return true;
    if (no >= 2) return false;
    return undefined;
  }
  if (!decisive) return p.votes[0];
  if (st.phase === 'verify') {
    // Seeded with the earlier "Yes": best of three.
    if (yes >= 2) return true;
    if (no >= 2) return false;
    return undefined;
  }
  // Decisive tests: a single "Yes" is enough, a "No" must be confirmed (best of three).
  if (p.votes.length === 1) return p.votes[0] ? true : undefined;
  if (yes >= 2) return true;
  if (no >= 2) return false;
  return undefined;
}

export function nextStep(st: BisectState): BisectStep {
  for (let guard = 0; guard < 10000; guard++) {
    if (st.phase === 'done') return { type: 'done', culprits: st.result ?? [] };
    if (st.phase === 'failed') return { type: 'failed', reason: st.reason ?? 'failed', best: st.result };
    if (st.pending) return { type: 'test', disable: [...st.pending.set], step: st.asked + 1, phase: st.phase };
    const cur = currentSet(st);
    if (!cur) {
      finish(st, false, 'internal', null);
      continue;
    }
    if (!cur.noCache) {
      const known = lookup(st, cur.set);
      if (known !== undefined) {
        resolve(st, cur.set, known);
        continue;
      }
    }
    if (st.asked >= st.maxQuestions) {
      finish(st, false, 'too-many-steps', st.c.length < st.n ? [...st.c] : null);
      continue;
    }
    st.pending = { set: cur.set, votes: st.phase === 'verify' ? [true] : [], noCache: cur.noCache };
  }
  finish(st, false, 'internal', null);
  return { type: 'failed', reason: 'internal', best: null };
}

/** Record the answer to the pending test ("does the page work with these rules disabled?"). */
export function answer(st: BisectState, works: boolean): BisectStep {
  if (!st.pending) return nextStep(st);
  st.pending.votes.push(works);
  st.asked++;
  const d = decided(st);
  if (d !== undefined) {
    const set = st.pending.set;
    st.pending = null;
    st.history.push({ set, works: d });
    st.cache = st.cache.filter(([k]) => k !== key(set));
    st.cache.push([key(set), d]);
    resolve(st, set, d);
  } else if (st.asked >= st.maxQuestions) {
    finish(st, false, 'too-many-steps', st.c.length < st.n ? [...st.c] : null);
  }
  return nextStep(st);
}

/** Drive a bisection to the end with an oracle (tests, automatic mode). */
export function runBisect(n: number, oracle: (disabled: number[]) => boolean, maxQuestions = 40): { step: BisectStep; state: BisectState } {
  const st = newBisect(n, maxQuestions);
  let step = nextStep(st);
  while (step.type === 'test') step = answer(st, oracle(step.disable));
  return { step, state: st };
}
