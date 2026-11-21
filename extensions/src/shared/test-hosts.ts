// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Protection lists never contain *.localhost hosts that matter, so the parsers
// skip them. The Safari end-to-end build is the exception: Safari can only
// reach the local test server under *.localhost names (no host-resolver flags),
// so its fixture protection list names hosts like phish.localhost.

declare const __E2E__: boolean;
declare const __PLATFORM__: string;

export const KEEP_LOCALHOST_HOSTS: boolean =
  typeof __E2E__ !== 'undefined' && __E2E__ && typeof __PLATFORM__ !== 'undefined' && __PLATFORM__ === 'safari';
