# Third-party notices

Quietfort includes the third-party software listed below. Each component
remains under its own license; nothing here changes those terms.

## DuckDuckGo autoconsent

- Used for: automatic "reject all" on cookie / privacy-consent pop-ups
  (all browsers).
- Version: 18.5.0 (npm package `@duckduckgo/autoconsent`)
- Source code: https://github.com/duckduckgo/autoconsent
  (npm: https://www.npmjs.com/package/@duckduckgo/autoconsent ,
  tarball https://registry.npmjs.org/@duckduckgo/autoconsent/-/autoconsent-18.5.0.tgz)
- Authors: the autoconsent contributors (package author: Sam Macbeth; published by DuckDuckGo). The package contains no separate copyright notice.
- License: Mozilla Public License, version 2.0 (MPL-2.0)

Files used, all **unmodified** (byte-identical to the npm package):

| File in the package                 | Where it ships |
|-------------------------------------|----------------|
| `dist/autoconsent.playwright.js`    | extensions: `autoconsent/autoconsent.playwright.js` |
| `rules/compact-rules.json`          | extensions: `autoconsent/compact-rules.json` |
| `LICENSE`                           | extensions: `autoconsent/LICENSE` |

These files are Covered Software under the MPL-2.0. You can obtain their
Source Code Form from the links above; the files as shipped are themselves
that source code. The build copies them from the pinned npm package and checks
its licence. Quietfort itself is also released under the MPL-2.0 (see `LICENSE`).

This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/.

The full license text ships as `autoconsent/LICENSE` inside the extension packages.

## Filter lists (not included)

Filter lists, including the EasyList Cookie List
(https://secure.fanboy.co.nz/fanboy-cookiemonster.txt, from https://easylist.to),
are **not** distributed with this product. They are downloaded by the user's
own copy of the software directly from their maintainers at runtime.

Lists from The Block List Project (https://github.com/blocklistproject/Lists, Unlicense)
are downloaded the same way for the dangerous-site warnings.

## uBlock Origin and AdGuard filter lists (references only, not included)

The lists below are offered in the list chooser (all off by default). They are
licensed under the GNU General Public License v3.0 by their maintainers. **No
list text is included in, bundled with, or modified by this product**: when the
user turns a list on, their own copy of the extension downloads it,
unmodified, from the maintainer's official GitHub-hosted URL, and the list
chooser credits the maintainer and licence. Licences checked on 2026-11-16 (the
`! License:` header of each list and each repository's `LICENSE` file).

uBlock Origin team, https://github.com/uBlockOrigin/uAssets, licence GPL-3.0
(https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE). Pre-assembled
builds served by the project's GitHub Pages site:

- uBlock filters – Ads: https://ublockorigin.github.io/uAssets/filters/filters.min.txt
- uBlock filters – Privacy: https://ublockorigin.github.io/uAssets/filters/privacy.min.txt
- uBlock filters – Badware risks: https://ublockorigin.github.io/uAssets/filters/badware.min.txt
- uBlock filters – Quick fixes: https://ublockorigin.github.io/uAssets/filters/quick-fixes.min.txt
- uBlock filters – Unbreak: https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt
- uBlock filters – Cookie notices: https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt
- uBlock filters – Annoyances: https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt

AdGuard, https://github.com/AdguardTeam/AdguardFilters, licence GPL-3.0
(https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE). Compiled
builds published in AdGuard's FiltersRegistry repository on GitHub (the
`extension/ublock` platform build), not AdGuard's own CDN:

- AdGuard Base filter (includes EasyList): https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/platforms/extension/ublock/filters/2.txt
- AdGuard URL Tracking filter: https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/platforms/extension/ublock/filters/17.txt
- AdGuard Social Media filter: https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/platforms/extension/ublock/filters/4.txt
- AdGuard Annoyances filter: https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/platforms/extension/ublock/filters/14.txt

Our support for these lists' syntax (scriptlets, redirect resources, options)
was written from scratch from public documentation; no uBlock Origin or AdGuard
source code was used.
