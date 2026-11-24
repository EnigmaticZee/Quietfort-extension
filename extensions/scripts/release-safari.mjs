// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Builds the Safari companion app for download outside the Mac App Store:
// Release build, signed with a Developer ID certificate, notarized by Apple and
// stapled, then zipped as dist/quietfort-safari.zip.
//
// Needs, on the Mac that runs it:
//   - Xcode, signed in to the Apple developer team (QF_TEAM, default below)
//   - a "Developer ID Application" certificate for that team in the keychain
//   - notarization credentials saved once with
//       xcrun notarytool store-credentials quietfort --team-id <team>
//     (QF_NOTARY_PROFILE names another profile)
//
// Usage: node scripts/release-safari.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const TEAM = process.env.QF_TEAM ?? 'G39T62RW4Q';
const PROFILE = process.env.QF_NOTARY_PROFILE ?? 'quietfort';
const PROJECT_DIR = join(ROOT, 'safari-app', 'AdBlocker Companion');
const APP_NAME = 'Quietfort for Safari.app';
const OUT = join(ROOT, 'dist', 'quietfort-safari.zip');
const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer' };
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', env, cwd: opts.cwd ?? ROOT, encoding: 'utf8' });
}

const work = mkdtempSync(join(tmpdir(), 'quietfort-safari-'));
const archive = join(work, 'Quietfort.xcarchive');
const exported = join(work, 'export');
const app = join(exported, APP_NAME);
try {
  run('node', ['scripts/build.mjs', 'safari']);
  run('xcodebuild', [
    '-project', 'AdBlocker Companion.xcodeproj', '-scheme', 'AdBlocker Companion', '-configuration', 'Release',
    '-archivePath', archive, `DEVELOPMENT_TEAM=${TEAM}`, 'CODE_SIGN_STYLE=Automatic',
    `MARKETING_VERSION=${VERSION}`, '-allowProvisioningUpdates', 'archive',
  ], { cwd: PROJECT_DIR });
  const options = join(work, 'export.plist');
  writeFileSync(options, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>developer-id</string>
<key>teamID</key><string>${TEAM}</string>
<key>signingStyle</key><string>automatic</string>
<key>destination</key><string>export</string>
</dict></plist>
`);
  run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportPath', exported, '-exportOptionsPlist', options, '-allowProvisioningUpdates']);
  run('codesign', ['--verify', '--deep', '--strict', app]);

  const upload = join(work, 'upload.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, upload]);
  const result = run('xcrun', ['notarytool', 'submit', upload, '--keychain-profile', PROFILE, '--wait', '--timeout', '30m'], { capture: true });
  console.log(result);
  if (!/status: Accepted/.test(result)) throw new Error('Apple did not accept the app (see the notarytool output above).');
  run('xcrun', ['stapler', 'staple', app]);
  run('spctl', ['-a', '-vv', app]);

  rmSync(OUT, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', app, OUT]);
  console.log(`\nSafari ${VERSION}: ${OUT}`);
} finally {
  // Keep this Mac's Safari from picking up the temporary copies as extra installs.
  for (const a of [app, join(archive, 'Products', 'Applications', APP_NAME)]) {
    if (existsSync(a)) try { execFileSync(LSREGISTER, ['-u', a], { stdio: 'ignore' }); } catch { /* not registered */ }
  }
  rmSync(work, { recursive: true, force: true });
}
