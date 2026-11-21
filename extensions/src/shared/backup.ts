// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Backup and restore of the user's own choices (settings page). The file holds
// only what the user set: switches, My Rules, trusted sites, list choices,
// hidden elements, permanent site fixes, theme. No filter-list content, no
// browsing data. Imports are checked field by field: anything unexpected is
// dropped, never trusted.

export const BACKUP_FORMAT = 'quietfort-backup';
export const BACKUP_VERSION = 1;
/** My Rules larger than this are refused (the editor would be unusable anyway). */
export const MAX_USER_RULES_BYTES = 2_000_000;

export interface BackupSettings {
  disabledSites: string[];
  userFilters: string;
  cookieBanners: boolean;
  lists: Record<string, boolean>;
  customLists: Array<{ id: string; url: string; name: string; enabled: boolean; kind: 'filters' | 'protection' }>;
  privacy: Record<string, boolean>;
  ai: Record<string, boolean>;
}

export interface PickerRuleData {
  id: string;
  site: string;
  selectors: string[];
  counts: number[];
  active: number;
  fingerprint: { tag: string; text: string; rect: { x: number; y: number; w: number; h: number } | null };
  createdAt: number;
}

export interface ExceptionData {
  id: string;
  kind: string;
  site: string;
  rule: string;
  lines: string[];
  createdAt: number;
  expiresAt: null;
  reason: string;
  source: 'fix-this-site';
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  settings: BackupSettings;
  picker: PickerRuleData[];
  exceptions: ExceptionData[];
  theme: string;
}

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const HOST = /^(\*|[a-z0-9-]+(\.[a-z0-9-]+)*)$/i;

function host(v: unknown): string | null {
  const s = str(v, 253)?.trim().toLowerCase();
  return s && s !== '*' && HOST.test(s) ? s : null;
}

function bools(v: unknown, keys?: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'boolean' && k.length <= 80 && (!keys || keys.includes(k))) out[k] = x;
  }
  return out;
}

export interface ReadResult {
  backup: Backup | null;
  /** What was dropped, for the user. */
  skipped: string[];
  error?: string;
}

/** Parses and cleans a backup file's text. */
export function readBackup(text: string): ReadResult {
  const skipped: string[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { backup: null, skipped, error: 'This file is not a Quietfort backup (not JSON).' };
  }
  if (!raw || typeof raw !== 'object' || raw.format !== BACKUP_FORMAT) return { backup: null, skipped, error: 'This file is not a Quietfort backup.' };
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) return { backup: null, skipped, error: 'This backup was made by a newer version of Quietfort.' };
  const s = (raw.settings ?? {}) as Record<string, unknown>;

  const sites: string[] = [];
  for (const x of Array.isArray(s.disabledSites) ? s.disabledSites : []) {
    const h = host(x);
    if (h && !sites.includes(h)) sites.push(h);
    else if (!h) skipped.push(`trusted site “${String(x).slice(0, 60)}”`);
  }

  let userFilters = typeof s.userFilters === 'string' ? s.userFilters : '';
  if (userFilters.length > MAX_USER_RULES_BYTES) {
    skipped.push('My Rules (too large)');
    userFilters = '';
  }

  const customLists: BackupSettings['customLists'] = [];
  for (const c of Array.isArray(s.customLists) ? s.customLists : []) {
    const o = (c ?? {}) as Record<string, unknown>;
    const url = str(o.url, 2000);
    const id = str(o.id, 100);
    if (!url || !id || !/^https:\/\//i.test(url)) {
      skipped.push(`custom list ${String(o.url ?? '').slice(0, 80)}`);
      continue;
    }
    customLists.push({ id, url, name: str(o.name, 200) ?? url, enabled: o.enabled !== false, kind: o.kind === 'protection' ? 'protection' : 'filters' });
  }

  const picker: PickerRuleData[] = [];
  for (const r of Array.isArray(raw.picker) ? raw.picker : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const site = host(o.site);
    const selectors = Array.isArray(o.selectors) ? o.selectors.map((x) => str(x, 1000)).filter((x): x is string => !!x).slice(0, 10) : [];
    if (!site || !selectors.length) {
      skipped.push('a hidden element');
      continue;
    }
    const fp = (o.fingerprint ?? {}) as Record<string, unknown>;
    const rect = fp.rect && typeof fp.rect === 'object' ? fp.rect as Record<string, unknown> : null;
    picker.push({
      id: str(o.id, 60) ?? `${Date.now().toString(36)}-${picker.length}`,
      site,
      selectors,
      counts: selectors.map((_, i) => (Array.isArray(o.counts) && Number.isFinite(Number(o.counts[i])) ? Number(o.counts[i]) : 1)),
      active: Number.isInteger(o.active) && (o.active as number) >= 0 && (o.active as number) < selectors.length ? (o.active as number) : 0,
      fingerprint: {
        tag: str(fp.tag, 20) ?? '',
        text: str(fp.text, 200) ?? '',
        rect: rect ? { x: Number(rect.x) || 0, y: Number(rect.y) || 0, w: Number(rect.w) || 0, h: Number(rect.h) || 0 } : null,
      },
      createdAt: Number(o.createdAt) || Date.now(),
    });
  }

  const exceptions: ExceptionData[] = [];
  for (const e of Array.isArray(raw.exceptions) ? raw.exceptions : []) {
    const o = (e ?? {}) as Record<string, unknown>;
    const site = host(o.site);
    const lines = Array.isArray(o.lines) ? o.lines.map((x) => str(x, 2000)).filter((x): x is string => !!x) : [];
    // Exceptions may only switch rules off (@@…, #@#…), on their own site.
    const ok = site && lines.length && lines.every((l) => (l.startsWith('@@') || /#@[$%?]?#/.test(l)) && l.includes(site));
    if (!ok) {
      skipped.push(`site fix ${String(o.rule ?? '').slice(0, 60)}`);
      continue;
    }
    exceptions.push({
      id: str(o.id, 60) ?? `${Date.now().toString(36)}-x${exceptions.length}`,
      kind: str(o.kind, 40) ?? 'network',
      site: site!,
      rule: str(o.rule, 2000) ?? '',
      lines,
      createdAt: Number(o.createdAt) || Date.now(),
      expiresAt: null,
      reason: str(o.reason, 500) ?? 'restored from backup',
      source: 'fix-this-site',
    });
  }

  const theme = ['light', 'fortNight', 'graphite'].includes(String(raw.theme)) ? String(raw.theme) : 'light';
  return {
    skipped,
    backup: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: str(raw.exportedAt, 40) ?? '',
      settings: {
        disabledSites: sites.sort(),
        userFilters,
        cookieBanners: s.cookieBanners !== false,
        lists: bools(s.lists),
        customLists,
        privacy: bools(s.privacy, ['gpc', 'trimReferrer', 'stripClientData']),
        ai: bools(s.ai, ['sponsored', 'scam', 'cookiePlans']),
      },
      picker,
      exceptions,
      theme,
    },
  };
}

/** Check of the user's own rules, line by line, for the My Rules editor. */
export interface RulesCheck {
  lines: number;
  rules: number;
  problems: Array<{ line: number; text: string; reason: string }>;
}

export function checkRules(text: string, parse: (line: string) => { kind: string; reason?: string }): RulesCheck {
  const out: RulesCheck = { lines: 0, rules: 0, problems: [] };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    out.lines++;
    if (line.startsWith('!')) return;
    const p = parse(line);
    if (p.kind === 'ignored') return;
    if (p.kind === 'unsupported' || p.kind === 'invalid') {
      if (out.problems.length < 50) out.problems.push({ line: i + 1, text: line.slice(0, 120), reason: p.reason ?? 'not supported' });
      return;
    }
    out.rules++;
  });
  return out;
}
