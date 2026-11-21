// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export function createHarness(name) {
  const results = [];
  return {
    check(label, ok, detail = '') {
      results.push({ label, ok: !!ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    },
    info(label, detail) {
      console.log(`INFO  ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    },
    summary() {
      const pass = results.filter((r) => r.ok).length;
      const fail = results.length - pass;
      console.log(`\n${name}: ${pass} passed, ${fail} failed (${results.length} checks)`);
      if (fail) for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.label} ${r.detail ? JSON.stringify(r.detail) : ''}`);
      return fail === 0;
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs = 5000, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return v;
    await sleep(stepMs);
  }
}
