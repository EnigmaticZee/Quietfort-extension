// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Event that hands a scriptlet configuration to the main-world runner (content/scriptlets-main.ts). */
export const SCRIPTLET_EVENT = 'adb-scriptlets-v1';

/** storage.local key of the cached configuration for a top-frame host. */
export const SCRIPTLET_CACHE_PREFIX = 'sl:';

/** Registered content script id of the main-world runner. */
export const SCRIPTLET_SCRIPT_ID = 'adb-scriptlets';
