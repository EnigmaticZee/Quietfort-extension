// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Builds dist/chrome, dist/firefox and dist/safari.
//  - page-runtime/assets/runtime.js is copied in (wrapped as an ES module),
//    never forked.
//  - No filter-list content is ever bundled: the build fails if anything that
//    looks like list text ends up in dist/ (the EasyList Cookie List included:
//    it is downloaded at runtime like EasyList).
//  - DuckDuckGo autoconsent (MPL-2.0) is copied in UNMODIFIED from the pinned
//    npm package as separate files under autoconsent/ with its LICENSE, plus
//    the repository's THIRD_PARTY_NOTICES.md as THIRD_PARTY_NOTICES.txt (.txt
//    so browsers show it as text from the options page link).

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_SRC = resolve(ROOT, 'page-runtime/assets/runtime.js');
const CONSENT_HOST_SRC = resolve(ROOT, 'page-runtime/assets/consent-host.js');
const CONSENT_MARKERS_SRC = resolve(ROOT, 'page-runtime/assets/consent-markers.txt');
const AUTOCONSENT_PKG = join(ROOT, 'node_modules/@duckduckgo/autoconsent');
const NOTICES = resolve(ROOT, '../THIRD_PARTY_NOTICES.md');
// Shipped unmodified: package path -> path in the extension.
const AUTOCONSENT_FILES = [
  ['dist/autoconsent.playwright.js', 'autoconsent/autoconsent.playwright.js'],
  ['rules/compact-rules.json', 'autoconsent/compact-rules.json'],
  ['LICENSE', 'autoconsent/LICENSE'],
];
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = 'Quietfort';
const DESCRIPTION = 'Blocks ads, trackers, popups and dangerous sites using filter lists downloaded from their maintainers.';

const platforms = process.argv.slice(2).filter((a) => !a.startsWith('-'));
// `--e2e-lists=<url>[,<url>]`: test build (dist/<platform>-e2e) whose default
// filter lists come from the local e2e server and which includes the test relay.
const e2eArg = process.argv.find((a) => a.startsWith('--e2e-lists='));
// An entry may be `id=url` (e.g. `easylist-cookie=http://lists.test/cookie.txt`).
const E2E_LISTS = e2eArg
  ? e2eArg.slice(12).split(',').map((u, i) => {
    const m = /^([a-z0-9-]+)=(.+)$/.exec(u);
    return m ? { id: m[1], url: m[2] } : { id: `e2e${i}`, url: u };
  })
  : null;
const TARGETS = platforms.length ? platforms : ['chrome', 'firefox', 'safari'];

// ---------- runtime.js → module ----------
function wrapRuntime() {
  const src = readFileSync(RUNTIME_SRC, 'utf8').trim().replace(/;\s*$/, '');
  if (!src.includes('(function (cfg)') || !src.endsWith('})')) {
    throw new Error(`unexpected runtime.js shape (expected "(function (cfg) {...})"): ${RUNTIME_SRC}`);
  }
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  const out = join(ROOT, '.cache', 'runtime.mjs');
  writeFileSync(out, `// Generated from page-runtime/assets/runtime.js by scripts/build.mjs. Do not edit.\nexport default ${src};\n`);
  return { path: out, sha256: createHash('sha256').update(src).digest('hex').slice(0, 16) };
}

// ---------- consent host + markers → modules ----------
function wrapConsent() {
  const src = readFileSync(CONSENT_HOST_SRC, 'utf8').trim().replace(/;\s*$/, '');
  if (!src.includes('(function (cfg)') || !src.endsWith('})')) throw new Error(`unexpected consent-host.js shape: ${CONSENT_HOST_SRC}`);
  const host = join(ROOT, '.cache', 'consent-host.mjs');
  writeFileSync(host, `// Generated from page-runtime/assets/consent-host.js by scripts/build.mjs. Do not edit.\nexport default ${src};\n`);
  const markers = join(ROOT, '.cache', 'consent-markers.mjs');
  writeFileSync(markers, `// Generated from page-runtime/assets/consent-markers.txt by scripts/build.mjs. Do not edit.\nexport default ${JSON.stringify(readFileSync(CONSENT_MARKERS_SRC, 'utf8'))};\n`);
  return { host, markers };
}

/** autoconsent files, unmodified from the pinned npm package (version and licence checked). */
function autoconsentFiles() {
  const pkgJson = JSON.parse(readFileSync(join(AUTOCONSENT_PKG, 'package.json'), 'utf8'));
  if (pkgJson.license !== 'MPL-2.0') throw new Error(`@duckduckgo/autoconsent license is ${pkgJson.license}, expected MPL-2.0`);
  const pinned = pkg.dependencies?.['@duckduckgo/autoconsent'];
  if (pkgJson.version !== pinned) throw new Error(`@duckduckgo/autoconsent ${pkgJson.version} installed, package.json pins ${pinned}: run npm ci`);
  return AUTOCONSENT_FILES.map(([from, to]) => ({ to, data: readFileSync(join(AUTOCONSENT_PKG, from)) }));
}

// ---------- tiny PNG writer (2x2.png) ----------
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GIF_1X1 = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
]);

// ---------- manifests ----------
function manifest(platform) {
  const common = {
    manifest_version: 3,
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_popup: 'popup.html', default_title: NAME, default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    host_permissions: ['<all_urls>'],
    content_scripts: [
      { matches: ['http://*/*', 'https://*/*'], js: ['content.js'], run_at: 'document_start', all_frames: true },
    ],
    options_ui: { page: 'options.html', open_in_tab: true },
    // blocked.html: the malware/phishing warning page that DNR / webRequest redirect navigations to.
    web_accessible_resources: [{ resources: ['resources/*', 'blocked.html'], matches: ['<all_urls>'] }],
  };
  // Main-world error hook for breakage detection (Chrome ≥111, Firefox ≥128).
  if (platform !== 'safari') {
    common.content_scripts.push({ matches: ['http://*/*', 'https://*/*'], js: ['errors.js'], run_at: 'document_start', all_frames: false, world: 'MAIN' });
  }
  const base = ['storage', 'unlimitedStorage', 'alarms', 'scripting', 'webNavigation', 'contextMenus'];
  if (platform === 'chrome') {
    return {
      ...common,
      // 138: Chrome's per-extension "Allow User Scripts" switch (full protection, background/fullprotection.ts).
      minimum_chrome_version: '138',
      permissions: ['declarativeNetRequest', ...base, 'webRequest', 'userScripts'],
      background: { service_worker: 'background.js' },
    };
  }
  if (platform === 'firefox') {
    return {
      ...common,
      permissions: [...base, 'webRequest', 'webRequestBlocking'],
      background: { scripts: ['background.js'] },
      browser_specific_settings: {
        gecko: {
          id: 'quietfort@enigmaticzee.github.io',
          strict_min_version: '128.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    };
  }
  return {
    ...common,
    // WithHostAccess: Safari applies redirect / modifyHeaders rules only with it (block and
    // allow rules work without it).
    // nativeMessaging: hands the compiled content-blocker rules to the companion app
    // (background/safari-cb.ts); nothing else is sent to it.
    permissions: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess', ...base, 'webRequest', 'nativeMessaging'],
    background: { service_worker: 'background.js' },
    browser_specific_settings: { safari: { strict_min_version: '17.0' } },
  };
}

// ---------- guard: never ship list content ----------
const LIST_CONTENT = [/^\[Adblock Plus/m, /^! Title:/m, /^! Homepage: https:\/\/easylist/m, /^! Expires:/m, /^! Checksum:/m];
function assertNoListContent(dir) {
  const bad = LIST_CONTENT;
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        if (st.size > 1024 * 1024) throw new Error(`refusing to ship ${p}: ${st.size} bytes (filter list content?)`);
        const text = readFileSync(p, 'latin1');
        for (const re of bad) if (re.test(text)) throw new Error(`refusing to ship ${p}: looks like filter-list content (${re})`);
      }
    }
  };
  walk(dir);
}

// The guard must recognise a filter list such as the EasyList Cookie List header.
{
  const sample = '[Adblock Plus 2.0]\n! Checksum: x\n! Title: Easylist Cookie List\n! Expires: 9 days (update frequency)\n##.cookie-notice\n';
  if (!LIST_CONTENT.every((re) => re.source.includes('Homepage') || re.test(sample))) throw new Error('list-content guard self-test failed');
}

const runtime = wrapRuntime();
const consent = wrapConsent();
const acFiles = autoconsentFiles();
for (const platform of TARGETS) {
  const out = join(ROOT, 'dist', E2E_LISTS ? `${platform}-e2e` : platform);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'icons'), { recursive: true });
  const target = platform === 'chrome' ? 'chrome121' : platform === 'firefox' ? 'firefox128' : 'safari17';
  await build({
    entryPoints: {
      background: join(ROOT, 'src/background/main.ts'),
      content: join(ROOT, 'src/content/content.ts'),
      'content-ai': join(ROOT, 'src/content/content-ai.ts'),
      popup: join(ROOT, 'src/popup/popup.ts'),
      options: join(ROOT, 'src/options/options.ts'),
      picker: join(ROOT, 'src/content/picker.ts'),
      zap: join(ROOT, 'src/content/zap.ts'),
      describe: join(ROOT, 'src/content/describe.ts'),
      welcome: join(ROOT, 'src/welcome/welcome.ts'),
      fullprotection: join(ROOT, 'src/welcome/fullprotection.ts'),
      log: join(ROOT, 'src/log/log.ts'),
      errors: join(ROOT, 'src/content/errors-main.ts'),
      gpc: join(ROOT, 'src/content/gpc-main.ts'),
      scriptlets: join(ROOT, 'src/content/scriptlets-main.ts'),
      blocked: join(ROOT, 'src/blocked/blocked.ts'),
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    target,
    minify: false,
    minifySyntax: true, // drops `if (__E2E__)` test-only code from real builds
    legalComments: 'none',
    banner: { js: '// This Source Code Form is subject to the terms of the Mozilla Public\n// License, v. 2.0. If a copy of the MPL was not distributed with this\n// file, You can obtain one at https://mozilla.org/MPL/2.0/.' },
    define: { __PLATFORM__: JSON.stringify(platform), __E2E__: JSON.stringify(!!E2E_LISTS), __E2E_LISTS__: JSON.stringify(E2E_LISTS) },
    alias: { '@runtime': runtime.path, '@consent-host': consent.host, '@consent-markers': consent.markers },
    logLevel: 'warning',
  });
  cpSync(join(ROOT, 'src/popup/popup.html'), join(out, 'popup.html'));
  cpSync(join(ROOT, 'src/popup/popup.css'), join(out, 'popup.css'));
  cpSync(join(ROOT, 'src/options/options.html'), join(out, 'options.html'));
  cpSync(join(ROOT, 'src/blocked/blocked.html'), join(out, 'blocked.html'));
  cpSync(join(ROOT, 'src/welcome/welcome.html'), join(out, 'welcome.html'));
  // Full protection (Chrome's "Allow User Scripts" switch) exists only in Chrome-family builds.
  if (platform === 'chrome') cpSync(join(ROOT, 'src/welcome/fullprotection.html'), join(out, 'fullprotection.html'));
  else rmSync(join(out, 'fullprotection.js'), { force: true });
  cpSync(join(ROOT, 'src/log/log.html'), join(out, 'log.html'));
  cpSync(join(ROOT, 'resources'), join(out, 'resources'), { recursive: true });
  writeFileSync(join(out, 'resources', '1x1.gif'), GIF_1X1);
  writeFileSync(join(out, 'resources', '2x2.png'), png(2, 2, () => [0, 0, 0, 0]));
  // Quietfort icons (assets/icons, rendered from the Fort Shield design).
  for (const s of [16, 32, 48, 128]) copyFileSync(join(ROOT, 'assets', 'icons', `${s}.png`), join(out, 'icons', `${s}.png`));
  mkdirSync(join(out, 'autoconsent'), { recursive: true });
  for (const f of acFiles) writeFileSync(join(out, f.to), f.data);
  cpSync(NOTICES, join(out, 'THIRD_PARTY_NOTICES.txt'));
  {
    const shipped = readFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    if (!shipped.includes('## DuckDuckGo autoconsent') || !shipped.includes('Mozilla Public License')) {
      throw new Error('THIRD_PARTY_NOTICES.txt in the build lacks the autoconsent (MPL-2.0) notice');
    }
  }
  const mf = manifest(platform);
  // Firefox's default MV3 extension CSP adds `upgrade-insecure-requests`, which
  // would turn the e2e server's http:// list URL into https://. Real list URLs
  // are https, so only the test build relaxes this.
  if (E2E_LISTS && platform === 'firefox') mf.content_security_policy = { extension_pages: "script-src 'self'" };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(mf, null, 2)}\n`);
  assertNoListContent(out);
  if (!E2E_LISTS && /__adbTest|__agent|lists\.(test|localhost)/.test(readFileSync(join(out, 'content.js'), 'utf8') + readFileSync(join(out, 'background.js'), 'utf8') + readFileSync(join(out, 'picker.js'), 'utf8') + readFileSync(join(out, 'blocked.js'), 'utf8') + readFileSync(join(out, 'options.js'), 'utf8'))) {
    throw new Error('test-only code leaked into a production build');
  }
  if (platform === 'safari') {
    // The Safari app bundles dist/safari from an explicit file list: a file missing
    // there builds fine but is absent in Safari ("Unable to find welcome.html").
    const proj = readFileSync(join(ROOT, 'safari-app', 'AdBlocker Companion', 'AdBlocker Companion.xcodeproj', 'project.xcproj'), 'utf8');
    const missing = readdirSync(out).filter((f) => !proj.includes(`dist/safari/${f}"`));
    if (missing.length) throw new Error(`Safari app project does not bundle: ${missing.join(', ')} (add them to safari-app/…/project.xcproj)`);
  }
  console.log(`built ${out.slice(ROOT.length + 1)} (runtime.js ${runtime.sha256})`);
}
