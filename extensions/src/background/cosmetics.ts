// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Cosmetic filtering: element-hiding CSS (inserted with scripting.insertCSS as
// a user-origin sheet, so pages can't override or CSP-block it) and the shared
// page runtime (extensions/page-runtime/assets/runtime.js, copied in at build time)
// for scriptlets + procedural selectors, run in the page's main world.

import runtime from '@runtime';
import { B, log } from './api.ts';
import { hostOf } from '../shared/domain.ts';
import { disabledSites, getEngine, isDisabledIn, onDisabledSitesChange, onInvalidate, onOverlayChange } from './state.ts';
import { SCRIPTLET_CACHE_PREFIX, SCRIPTLET_EVENT, SCRIPTLET_SCRIPT_ID } from '../shared/scriptlet-event.ts';
import { recordGenericSelectors } from './tabdata.ts';
import { getPickerRules } from './sitefixes.ts';
import { hostMatches } from '../shared/domain.ts';
import type { PickerRule } from '../shared/selectors.ts';

/**
 * Build a hiding stylesheet: one rule per selector, so a selector the browser
 * doesn't support only drops its own rule. (Not `:is(a, b, …)` groups: the
 * browser cannot index a selector list inside `:is()` by id / class / tag, so
 * all ~900 generic selectors were matched against every element; measured in
 * Chrome traces as +180 ms style recalculation before DOMContentLoaded on
 * cnn.com and +830 ms on apnews.com.) Selectors that could end the rule or
 * open a comment are skipped.
 */
export function hidingCss(selectors: string[], styles: Array<[string, string]> = []): string {
  let css = '';
  for (const sel of selectors) {
    if (/[{}]|\/\*/.test(sel)) continue;
    css += `${sel} { display: none !important; }\n`;
  }
  for (const [sel, decl] of styles) css += `${sel} { ${decl} }\n`;
  return css;
}

export async function insertCss(tabId: number, frameId: number, css: string): Promise<void> {
  if (!css) return;
  await B.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' });
}

function pageHost(url: string | undefined): string | null {
  return url && /^https?:/i.test(url) ? hostOf(url) : null;
}

async function tabTopHost(tabId: number, fallback: string | null): Promise<string | null> {
  try {
    return pageHost((await B.tabs.get(tabId)).url) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Content script hello: apply site-specific + always-on generic hiding. */
export async function onContentInit(sender: chrome.runtime.MessageSender): Promise<{ enabled: boolean; generic: boolean; picker?: PickerRule[] }> {
  const tabId = sender.tab?.id;
  const host = pageHost(sender.url);
  if (tabId === undefined || !host) return { enabled: false, generic: false };
  const top = sender.frameId === 0 ? host : await tabTopHost(tabId, host);
  const disabled = await disabledSites();
  if (isDisabledIn(disabled, top) || isDisabledIn(disabled, host)) return { enabled: false, generic: false };
  const engine = await getEngine();
  const c = engine?.cosmeticsFor(host);
  if (!c) return { enabled: false, generic: false };
  try {
    await insertCss(tabId, sender.frameId ?? 0, hidingCss([...c.specific, ...c.generic], c.styles));
  } catch (err) {
    log('insertCSS failed', String(err));
  }
  // Picker rules for this site: the content script checks their fallbacks.
  const picker = sender.frameId === 0 ? (await getPickerRules()).filter((r) => hostMatches(host, r.site)) : [];
  return { enabled: true, generic: c.allowGeneric, ...(picker.length ? { picker } : {}) };
}

/** Content script found new `.class` / `#id` tokens: hide matching generic selectors. */
export async function onContentTokens(sender: chrome.runtime.MessageSender, tokens: string[]): Promise<number> {
  const tabId = sender.tab?.id;
  const host = pageHost(sender.url);
  if (tabId === undefined || !host || !Array.isArray(tokens)) return 0;
  const engine = await getEngine();
  if (!engine) return 0;
  const sels = engine.genericForTokens(host, tokens.slice(0, 5000).map(String));
  if (sels.length && sender.frameId === 0) recordGenericSelectors(tabId, sels);
  if (sels.length) {
    try {
      await insertCss(tabId, sender.frameId ?? 0, hidingCss(sels));
    } catch (err) {
      log('insertCSS failed', String(err));
    }
  }
  return sels.length;
}

// ---------- scriptlets ----------
//
// Scriptlets run in the page's main world through content/scriptlets-main.ts,
// a content script registered at document_start, so they are in place before
// the page's own scripts. Its configuration reaches it from three sources, each
// as soon as it can; the runner runs each distinct configuration once:
//  1. the content script, from a storage.local cache of the top frame's
//     configuration (no background round trip: in Safari the background is
//     often asleep when a page starts loading);
//  2. the content script, from the background ('cs:scriptlets');
//  3. the background on navigation commit (scripting.executeScript), as before.
// If the runner cannot be registered, (3) runs the runtime directly.

let runnerRegistered = false;

/** The configuration for a frame as the JSON string the runner dedupes on, or null if none applies. */
async function scriptletConfig(tabId: number, frameId: number, host: string): Promise<string | null> {
  const engine = await getEngine();
  if (!engine) return null;
  const s = engine.scriptlets(host);
  const p = engine.procedural(host);
  if (!s.length && !p.length) return null;
  const top = frameId === 0 ? host : await tabTopHost(tabId, host);
  const disabled = await disabledSites();
  if (isDisabledIn(disabled, top) || isDisabledIn(disabled, host)) return null;
  return JSON.stringify({ s: s.map((x) => [x.name, x.args]), p });
}

// Cache of top-frame configurations: `sl:<host>` -> JSON string, plus an index
// of the cached hosts so the cache can be cleared without reading all storage.
const CACHE_INDEX = 'slIndex';
const CACHE_MAX = 300;
const cacheMirror = new Map<string, string>();
let cacheLoaded: Promise<void> | null = null;
let cacheGen = 0;

function loadCacheIndex(): Promise<void> {
  cacheLoaded ??= (async () => {
    const { [CACHE_INDEX]: idx } = (await B.storage.local.get(CACHE_INDEX)) as { slIndex?: string[] };
    if (!idx?.length) return;
    const keys = idx.map((h) => SCRIPTLET_CACHE_PREFIX + h);
    const got = await B.storage.local.get(keys);
    for (const h of idx) {
      const v = got[SCRIPTLET_CACHE_PREFIX + h];
      if (typeof v === 'string') cacheMirror.set(h, v);
    }
  })().catch(() => undefined);
  return cacheLoaded;
}

async function updateCache(host: string, cfg: string | null): Promise<void> {
  await loadCacheIndex();
  const gen = cacheGen;
  if ((cacheMirror.get(host) ?? null) === cfg) return;
  if (cfg === null) {
    cacheMirror.delete(host);
    await B.storage.local.remove(SCRIPTLET_CACHE_PREFIX + host);
  } else {
    if (!cacheMirror.has(host) && cacheMirror.size >= CACHE_MAX) {
      const oldest = cacheMirror.keys().next().value as string;
      cacheMirror.delete(oldest);
      await B.storage.local.remove(SCRIPTLET_CACHE_PREFIX + oldest);
    }
    if (gen !== cacheGen) return; // cleared meanwhile
    cacheMirror.set(host, cfg);
    await B.storage.local.set({ [SCRIPTLET_CACHE_PREFIX + host]: cfg });
  }
  await B.storage.local.set({ [CACHE_INDEX]: [...cacheMirror.keys()] });
}

/** Lists, filters or per-site switches changed: drop every cached configuration. */
export async function clearScriptletCache(): Promise<void> {
  cacheGen++;
  await loadCacheIndex();
  const keys = [...cacheMirror.keys()].map((h) => SCRIPTLET_CACHE_PREFIX + h);
  cacheMirror.clear();
  await B.storage.local.remove([...keys, CACHE_INDEX]);
}

let refreshing: Promise<void> = Promise.resolve();

/**
 * Lists, site fixes, per-site switches or the extension changed: recompute every
 * cached site's configuration instead of dropping the cache. Dropping it left the
 * first visit to each site after every list update without scriptlets in Safari
 * (the background answers too late there), e.g. a YouTube ad on the first video.
 */
export function refreshScriptletCache(): Promise<void> {
  refreshing = refreshing.then(async () => {
    await loadCacheIndex();
    for (const host of [...cacheMirror.keys()]) {
      // Top-frame entries only (frameId 0: the tab is not needed).
      await updateCache(host, await scriptletConfig(-1, 0, host));
    }
  }).catch((err) => log('scriptlet cache refresh failed', String(err)));
  return refreshing;
}

/** Content script hello at document_start: this frame's scriptlet configuration. */
export async function onContentScriptlets(sender: chrome.runtime.MessageSender): Promise<{ cfg: string | null }> {
  const tabId = sender.tab?.id;
  const host = pageHost(sender.url);
  if (tabId === undefined || !host) return { cfg: null };
  const frameId = sender.frameId ?? 0;
  const cfg = await scriptletConfig(tabId, frameId, host);
  if (frameId === 0) void updateCache(host, cfg).catch((err) => log('scriptlet cache update failed', String(err)));
  return { cfg };
}

/** Hands a configuration to the main-world runner (runs in the page, serialized by executeScript). */
function dispatchToRunner(name: string, cfg: string): void {
  window.dispatchEvent(new CustomEvent(name, { detail: cfg }));
}

async function registerRunner(): Promise<void> {
  try {
    const existing = await B.scripting.getRegisteredContentScripts({ ids: [SCRIPTLET_SCRIPT_ID] });
    if (!existing.length) {
      await B.scripting.registerContentScripts([
        { id: SCRIPTLET_SCRIPT_ID, js: ['scriptlets.js'], matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: true } as chrome.scripting.RegisteredContentScript,
      ]);
    }
    runnerRegistered = true;
  } catch (err) {
    runnerRegistered = false;
    log('scriptlet runner registration failed; injecting on commit only', String(err));
  }
}

/** On every committed frame: run scriptlets / procedural filters as early as possible. */
export function registerScriptletInjection(): void {
  const ready = registerRunner();
  onInvalidate(() => void refreshScriptletCache());
  onDisabledSitesChange(refreshScriptletCache);
  onOverlayChange(refreshScriptletCache);
  // A new version may parse or run the same lists differently.
  B.runtime.onInstalled.addListener(() => void refreshScriptletCache());
  B.webNavigation?.onCommitted.addListener((d) => {
    const host = pageHost(d.url);
    if (!host) return;
    void (async () => {
      const cfg = await scriptletConfig(d.tabId, d.frameId, host);
      if (d.frameId === 0) void updateCache(host, cfg).catch(() => undefined);
      if (!cfg) return;
      await ready;
      try {
        if (runnerRegistered) {
          await B.scripting.executeScript({
            target: { tabId: d.tabId, frameIds: [d.frameId] },
            world: 'MAIN',
            injectImmediately: true,
            func: dispatchToRunner,
            args: [SCRIPTLET_EVENT, cfg],
          } as chrome.scripting.ScriptInjection<[string, string], void>);
        } else {
          await B.scripting.executeScript({
            target: { tabId: d.tabId, frameIds: [d.frameId] },
            world: 'MAIN',
            injectImmediately: true,
            func: runtime,
            args: [JSON.parse(cfg)],
          } as chrome.scripting.ScriptInjection<[unknown], void>);
        }
      } catch (err) {
        log('runtime injection failed', host, String(err));
      }
    })();
  });
}
