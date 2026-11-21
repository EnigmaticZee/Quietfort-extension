// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Runs in the page's main world at document_start (top frame): forwards
// uncaught JavaScript errors to the isolated content script, which reports the
// relevant ones (undefined globals, blocked URLs) as breakage signals. It has no
// extension API access and only posts error text.

(() => {
  let sent = 0;
  const post = (message: unknown, filename: unknown, stack: unknown) => {
    if (sent++ >= 30) return;
    try {
      window.postMessage({ __adbErr: 1, message: String(message ?? '').slice(0, 300), filename: String(filename ?? '').slice(0, 500), stack: String(stack ?? '').slice(0, 1000) }, '*');
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('error', (e) => {
    if (!(e instanceof ErrorEvent)) return; // resource load errors are not script errors
    post(e.message, e.filename, (e.error as Error | undefined)?.stack);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: unknown; stack?: unknown } | undefined;
    post(r && typeof r === 'object' ? r.message : r, '', r && typeof r === 'object' ? r.stack : '');
  });
})();
