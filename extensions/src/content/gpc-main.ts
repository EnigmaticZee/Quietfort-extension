// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Global Privacy Control in the page's main world (registered only while the
// GPC setting is on): navigator.globalPrivacyControl === true, matching the
// Sec-GPC: 1 request header (https://w3c.github.io/gpc/).

(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true, enumerable: true });
  } catch {
    /* ignore */
  }
})();
