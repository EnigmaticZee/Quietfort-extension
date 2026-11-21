// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Fails if any installed npm package (dev or prod) is not under a permissive
// license. Nothing from node_modules is bundled except what esbuild pulls from
// our own sources. The one runtime dependency, @duckduckgo/autoconsent
// (MPL-2.0), is not bundled: its files are copied unmodified (build.mjs).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|BlueOak-1\.0\.0|CC0-1\.0|Unlicense|Python-2\.0)$/;
// File-level copyleft, allowed per package only: shipped as separate,
// unmodified files with their license (see THIRD_PARTY_NOTICES.md).
const ALLOWED_PER_PACKAGE = { '@duckduckgo/autoconsent': 'MPL-2.0' };
const out = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (name.startsWith('@')) { walk(p); continue; }
    const pj = join(p, 'package.json');
    if (existsSync(pj)) {
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses || []).map((l) => l.type).join(' OR ');
      out.push({ name: pkg.name, version: pkg.version, license: lic || 'UNKNOWN' });
      walk(join(p, 'node_modules'));
    }
  }
}
walk(join(ROOT, 'node_modules'));
const ok = (l) => l.replace(/[()]/g, '').split(/\s+OR\s+/).some((x) => ALLOWED.test(x.trim()));
const bad = out.filter((p) => !ok(p.license) && ALLOWED_PER_PACKAGE[p.name] !== p.license);
const counts = {};
for (const p of out) counts[p.license] = (counts[p.license] ?? 0) + 1;
console.log(`${out.length} packages:`, counts);
if (bad.length) {
  console.error('Non-permissive or unknown licenses:', bad);
  process.exit(1);
}
console.log('all permissive');
