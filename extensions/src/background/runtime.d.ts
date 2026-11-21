// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** extensions/page-runtime/assets/runtime.js, wrapped as a module by scripts/build.mjs. */
declare module '@runtime' {
  const runtime: (cfg: { s?: Array<[string, string[]]>; p?: string[]; test?: boolean }) => void;
  export default runtime;
}

/** extensions/page-runtime/assets/consent-host.js, wrapped as a module by scripts/build.mjs. */
declare module '@consent-host' {
  const host: (cfg: { rules: unknown; notify?: boolean; timeBoxMs?: number }) => void;
  export default host;
}

/** extensions/page-runtime/assets/consent-markers.txt, as a string (scripts/build.mjs). */
declare module '@consent-markers' {
  const text: string;
  export default text;
}
