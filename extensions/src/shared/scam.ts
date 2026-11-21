// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Scam / scareware heuristics on page content and behaviour, computed locally.
// Page content never leaves the browser: the optional confirmation runs on
// the on-device model.

export interface ScamBehaviour {
  /** requestFullscreen() calls. */
  fullscreen: number;
  /** beforeunload handlers registered. */
  beforeunload: number;
  /** history.pushState / replaceState calls (back-button trapping). */
  history: number;
  /** alert / confirm / prompt calls. */
  dialogs: number;
  /** navigator.keyboard.lock() or pointer lock. */
  inputLock: number;
}

export interface ScamFeatures {
  /** Visible text (any case; truncated by the caller). */
  text: string;
  title: string;
  behaviour: ScamBehaviour;
}

export interface ScamResult {
  score: number;
  categories: string[];
  reasons: string[];
}

const VIRUS = [
  /\bvirus(es)? (have been |has been |were )?(detected|found)\b/, /\byour (computer|pc|device|mac|iphone|phone|system) (is|has been|may be) (infected|compromised|hacked|at risk|blocked|locked)\b/,
  /\b\d+ (viruses|threats|trojans)\b/, /\btrojan\b/, /\bspyware\b/, /\bransomware\b/, /\bmalware (detected|infection)\b/, /\b(windows|microsoft) (defender|security) (alert|warning)\b/,
  /\bapple security (alert|warning)\b/, /\bsecurity (alert|warning|breach)\b/, /\byour (personal )?(data|files|photos|passwords|banking details) (will be|are being|may be) (deleted|stolen|exposed|leaked)\b/,
  /\bdo not (close|restart|shut down|turn off) (this|your)\b/, /\b(access|computer|browser) (has been|is) (blocked|locked|suspended)\b/, /\bpornographic (spyware|virus)\b/,
  /\berror (code|#)\s*[:#]?\s*[0-9a-z]{3,}\b/, /\bimmediate(ly)? (call|contact)\b/, /\bscan (now|complete)\b/,
];
const SUPPORT = [/\bcall\b/, /\b(tech(nical)?|customer|microsoft|apple|windows|it) support\b/, /\bhelp ?line\b/, /\btoll[- ]free\b/, /\btechnician\b/, /\bhelp ?desk\b/, /\bsupport number\b/];
const BRANDS = /\b(microsoft|windows|apple|macos|norton|mcafee|avast|google chrome|amazon|paypal|geek squad)\b/;
// +1 800 123 4567, (888) 555-0199, 1-844-555-0100, +44 20 7946 0958 …
const PHONE = /(\+?\d{1,3}[\s.-]?)?(\(\d{3}\)|\b\d{3})[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{2}[\s.-]\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b/;
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|usdt|tether|crypto(currency)?|dogecoin|doge|solana|sol|xrp|bnb)\b/;
const GIVEAWAY = /\b(giveaway|give away|airdrop|free (bitcoin|btc|eth|crypto))\b/;
const DOUBLE = /\b(double|2x|x2|twice|send (back|you back)|receive back|we will send|will be sent back|return (you )?(double|2x))\b/;
const WALLET = /\b(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33})\b/;
const URGENCY = [
  /\bwithin (\d+|twenty[- ]four|24|48) (hours|minutes|hrs|mins)\b/, /\bact (now|immediately|fast)\b/, /\bimmediately\b/, /\bfinal (notice|warning|reminder)\b/,
  /\b(account|card|subscription|service) (will be|has been) (suspended|closed|terminated|deactivated|cancelled|blocked)\b/, /\bexpires? (today|tonight|in \d+)\b/,
  /\blast chance\b/, /\burgent\b/, /\bonly \d+ (minutes|hours) left\b/, /\bavoid (legal action|arrest|penalties|suspension)\b/,
];
const PAYMENT = [
  /\bgift ?cards?\b/, /\b(google play|itunes|apple|steam|amazon) (gift )?cards?\b/, /\bwire transfer\b/, /\bwestern union\b/, /\bmoneygram\b/, /\bbitcoin atm\b/,
  /\bpay (a |the )?(fee|fine|penalty)\b/, /\bsend (the )?payment\b/, /\b(enter|confirm|verify) your (card|credit card|bank) (details|number|information)\b/,
  /\bpayment of \$?\d+/, /\bprocessing fee\b/, /\bunpaid (toll|invoice|fee|parcel)\b/, /\bredelivery fee\b/,
];

const count = (res: RegExp[], t: string) => res.filter((r) => r.test(t)).length;
const firstHit = (res: RegExp[], t: string): string | null => {
  for (const r of res) {
    const m = r.exec(t);
    if (m) return m[0];
  }
  return null;
};

/** Thresholds: warn at WARN; between ASK and WARN only if the on-device model agrees. */
export const SCAM_WARN = 6;
export const SCAM_ASK = 3;

export function scoreScam(f: ScamFeatures): ScamResult {
  const t = `${f.title}\n${f.text}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 30000);
  const b = f.behaviour;
  const categories: string[] = [];
  const reasons: string[] = [];
  let score = 0;

  const virus = count(VIRUS, t);
  // Support wording must surround the phone number itself (a shop's "call us"
  // number elsewhere on a page about scams is not a support scam).
  let support = 0;
  const phoneRe = new RegExp(PHONE.source, 'g');
  for (let m = phoneRe.exec(t); m && support < 2; m = phoneRe.exec(t)) {
    support = Math.max(support, count(SUPPORT, t.slice(Math.max(0, m.index - 120), m.index + m[0].length + 60)));
  }
  const phone = support > 0;
  const brand = BRANDS.test(t);
  if (virus >= 2) {
    const s = virus >= 4 ? 4 : 3;
    score += s + (brand ? 1 : 0);
    categories.push('fake-virus-alert');
    reasons.push(`it shows a fake virus or security alert (“${firstHit(VIRUS, t)}”)`);
  } else if (virus === 1) score += 1;
  if (phone && support >= 2) {
    score += virus >= 1 ? 4 : 2;
    categories.push('tech-support');
    reasons.push('it asks you to call a phone number for “support”');
  }
  const lockSignals = (b.beforeunload > 0 ? 1 : 0) + (b.dialogs >= 3 ? 1 : 0) + (b.history >= 5 ? 1 : 0) + (b.inputLock > 0 ? 1 : 0);
  if (b.fullscreen > 0 && lockSignals >= 1) {
    score += 4;
    categories.push('browser-lock');
    reasons.push('it tries to lock your browser (full screen and blocks leaving)');
  } else if (lockSignals >= 2) {
    score += 2;
    categories.push('browser-lock');
    reasons.push('it tries to stop you from leaving the page');
  }
  const crypto = CRYPTO.test(t);
  if (crypto && GIVEAWAY.test(t) && (DOUBLE.test(t) || WALLET.test(f.text))) {
    score += 6;
    categories.push('crypto-giveaway');
    reasons.push('it promises to send back more cryptocurrency than you send (“giveaway”)');
  } else if (crypto && DOUBLE.test(t) && WALLET.test(f.text)) {
    score += 3;
    categories.push('crypto-giveaway');
    reasons.push('it asks you to send cryptocurrency to a wallet and promises more back');
  }
  const urgency = count(URGENCY, t);
  const payment = count(PAYMENT, t);
  if (urgency >= 1 && payment >= 1) {
    const gift = /\bgift ?cards?\b/.test(t);
    score += gift ? 4 : urgency >= 2 && payment >= 2 ? 4 : 3;
    categories.push('urgent-payment');
    reasons.push(gift ? 'it urgently asks for payment with gift cards' : 'it pressures you to pay urgently');
  }
  return { score, categories, reasons };
}

export function scamDecision(score: number, modelAvailable: boolean): 'warn' | 'ask' | 'none' {
  if (score >= SCAM_WARN) return 'warn';
  if (score >= SCAM_ASK && modelAvailable) return 'ask';
  return 'none';
}

/**
 * Prompt input for the model. The heuristic findings are deliberately not
 * listed: with "it urgently asks for payment with gift cards" in the prompt,
 * the built-in model called a hardware shop's sale page ("last chance … we accept
 * gift cards") a scam 1/3 times (same lesson as the sponsored filter).
 */
export function scamPrompt(f: ScamFeatures, _r: ScamResult, host: string): string {
  return [
    `Site: ${host}`,
    `Title: ${f.title.slice(0, 120)}`,
    `Behaviour: fullscreen=${f.behaviour.fullscreen} beforeunload=${f.behaviour.beforeunload} dialogs=${f.behaviour.dialogs} history=${f.behaviour.history}`,
    'Visible text:',
    f.text.replace(/\s+/g, ' ').trim().slice(0, 1800),
  ].join('\n');
}

export const SCAM_SYSTEM = 'You classify one web page. "scam": a fake virus or security alert, a tech-support scam asking you to call a number, a browser locker, a fake cryptocurrency giveaway, or a fake demand (fee, fine, parcel charge, account suspension) to pay urgently by card, gift card, wire or crypto. "shop": a store, sale or product page, even with "last chance" or "sale ends tonight" and gift cards as a payment option. "news": news, guides or warnings that describe scams or security threats. "service": a bank, government, delivery, support or account page of a real organisation. "other": anything else. First say in a few words what the page is, then label it. Answer only with the JSON object.';

/** "about" first, then a label: grounding before the verdict (as for the sponsored filter). */
export const SCAM_SCHEMA = {
  type: 'object',
  properties: { about: { type: 'string', maxLength: 120 }, kind: { type: 'string', enum: ['scam', 'shop', 'news', 'service', 'other'] } },
  required: ['about', 'kind'],
  additionalProperties: false,
} as const;

/** Model answer → { scam, reason } (`{ scam, reason }` is the stub model's / legacy shape). */
export function readScamAnswer(r: unknown): { scam: boolean; reason: string } | null {
  const o = r as { kind?: unknown; about?: unknown; scam?: unknown; reason?: unknown } | null;
  if (!o || typeof o !== 'object') return null;
  const about = typeof o.about === 'string' ? o.about : typeof o.reason === 'string' ? o.reason : '';
  if (typeof o.kind === 'string' && ['scam', 'shop', 'news', 'service', 'other'].includes(o.kind)) return { scam: o.kind === 'scam', reason: about.slice(0, 200) };
  return typeof o.scam === 'boolean' ? { scam: o.scam, reason: about.slice(0, 200) } : null;
}
