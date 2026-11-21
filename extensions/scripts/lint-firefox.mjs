// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Runs Mozilla's `web-ext lint` on dist/firefox. web-ext is MPL-2.0, so it is
// fetched on demand with npx as a dev tool and is NOT a dependency of this
// package (nothing from it is bundled).

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('npx', ['--yes', 'web-ext@8', 'lint', '--source-dir', resolve(ROOT, 'dist/firefox'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
