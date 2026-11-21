// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// AI cookie click plans: when a consent banner is still visible after
// autoconsent, the on-device model proposes which element to click. Nothing
// it says is trusted: every step is validated here, deterministically, before
// the content script clicks:
//   - the selector must be one of the elements we offered (no free-form CSS);
//   - the final click must read as reject / necessary-only / decline in one of
//     many languages; intermediate clicks may only open settings;
//   - nothing may read as accept / agree / allow / subscribe / pay / log in;
//   - no links that navigate away; at most MAX_STEPS clicks.

export const MAX_STEPS = 3;

export interface Clickable {
  selector: string;
  /** Visible text, or aria-label / value / title when there is none. */
  text: string;
  tag: string;
  /** For links: the href attribute as written. */
  href?: string | null;
  /** input type, if an input. */
  type?: string | null;
}

/** Normalise for matching: lower case, single spaces, no punctuation at the ends. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFC')
    .replace(/[ \s]+/g, ' ')
    .replace(/[’`]/g, "'")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .trim();
}

const REJECT = [
  // en
  'reject all', 'reject all cookies', 'reject cookies', 'reject', 'reject optional cookies', 'reject non-essential', 'reject non-essential cookies', 'reject additional cookies',
  'decline', 'decline all', 'decline cookies', 'decline optional cookies', 'deny', 'deny all', 'refuse', 'refuse all', 'refuse cookies',
  'necessary only', 'only necessary', 'necessary cookies only', 'only necessary cookies', 'use necessary cookies only', 'allow necessary cookies only', 'accept necessary cookies only',
  'essential only', 'only essential', 'essential cookies only', 'only essential cookies', 'accept essential cookies only', 'accept only essential cookies', 'accept only necessary cookies',
  'strictly necessary only', 'required only', 'only required', 'only required cookies', 'continue without accepting', 'continue without agreeing', 'without accepting',
  'disagree', 'i disagree', 'do not accept', "don't accept", 'i do not accept', 'do not agree', "don't agree", 'i do not agree', 'do not consent', "don't consent", 'no thanks', 'no, thanks', 'no thank you', 'no, thank you', 'opt out', 'opt-out', 'object to all', 'reject and close', 'save and exit without consent',
  // de
  'alle ablehnen', 'ablehnen', 'cookies ablehnen', 'nur notwendige', 'nur notwendige cookies', 'nur erforderliche', 'nur erforderliche cookies', 'nur essenzielle', 'nur essenzielle cookies', 'nur technisch notwendige', 'notwendige cookies akzeptieren', 'nur notwendige cookies akzeptieren', 'nur notwendige cookies erlauben', 'ohne zustimmung fortfahren', 'ohne einwilligung fortfahren', 'nicht einverstanden', 'verweigern', 'alle verweigern',
  // fr
  'tout refuser', 'refuser', 'refuser tout', 'refuser les cookies', 'tout rejeter', 'rejeter', 'rejeter tout', 'continuer sans accepter', 'uniquement les cookies nécessaires', 'cookies nécessaires uniquement', 'nécessaires uniquement', 'seulement nécessaires', 'je refuse', 'non merci',
  // es / pt
  'rechazar todo', 'rechazar todas', 'rechazar', 'rechazar cookies', 'solo necesarias', 'sólo necesarias', 'solo esenciales', 'solo cookies necesarias', 'denegar', 'denegar todo', 'continuar sin aceptar', 'no acepto',
  'rejeitar tudo', 'rejeitar', 'rejeitar todos', 'recusar', 'recusar tudo', 'apenas necessários', 'apenas essenciais', 'somente necessários', 'continuar sem aceitar',
  // it
  'rifiuta tutto', 'rifiuta tutti', 'rifiuta', 'rifiuto', 'solo necessari', 'solo cookie necessari', 'continua senza accettare', 'nega', 'nega tutto',
  // nl
  'alles weigeren', 'weigeren', 'alles afwijzen', 'afwijzen', 'alleen noodzakelijk', 'alleen noodzakelijke', 'alleen noodzakelijke cookies', 'alleen functionele cookies', 'niet akkoord',
  // pl / cs / sk / hu / ro
  'odrzuć wszystkie', 'odrzuć', 'odrzucam', 'tylko niezbędne', 'odmów', 'odmítnout vše', 'odmítnout', 'pouze nezbytné', 'odmietnuť všetko', 'odmietnuť', 'összes elutasítása', 'elutasítom', 'elutasítás', 'respinge tot', 'respinge', 'doar necesare',
  // nordic / fi
  'avvisa alla', 'avvisa', 'avböj', 'avböj alla', 'endast nödvändiga', 'neka', 'neka alla', 'afvis alle', 'afvis', 'kun nødvendige', 'avvis alle', 'avvis', 'kun nødvendige informasjonskapsler', 'hylkää kaikki', 'hylkää', 'vain välttämättömät',
  // tr / el / ru / uk
  'tümünü reddet', 'reddet', 'sadece gerekli', 'yalnızca gerekli', 'απόρριψη όλων', 'απόρριψη', 'μόνο τα απαραίτητα', 'отклонить все', 'отклонить', 'отказаться', 'только необходимые', 'відхилити все', 'відхилити', 'лише необхідні',
  // asia
  'すべて拒否', '拒否する', '拒否', '必要なもののみ', '全部拒绝', '拒绝', '仅必要', '仅限必要', '全部拒絕', '拒絕', '모두 거부', '거부', '필수만', '필수 쿠키만',
];

const NAVIGATE = [
  'manage', 'manage options', 'manage settings', 'manage preferences', 'manage cookies', 'cookie settings', 'cookies settings', 'settings', 'preferences', 'cookie preferences',
  'options', 'more options', 'customize', 'customise', 'customize settings', 'show purposes', 'see purposes', 'more information', 'details', 'show details', 'advanced settings',
  'einstellungen', 'cookie-einstellungen', 'anpassen', 'verwalten', 'mehr optionen', 'optionen', 'details anzeigen',
  'paramètres', 'personnaliser', 'gérer', 'gérer les préférences', 'plus d\'options', 'en savoir plus',
  'configurar', 'configuración', 'preferencias', 'gestionar', 'más opciones', 'personalizar', 'gerir', 'definições', 'configurações', 'mais opções',
  'impostazioni', 'personalizza', 'gestisci', 'più opzioni', 'opzioni', 'instellingen', 'voorkeuren', 'beheren', 'meer opties', 'aanpassen',
  'ustawienia', 'dostosuj', 'zarządzaj', 'nastavení', 'upravit', 'beállítások', 'setări', 'inställningar', 'anpassa', 'indstillinger', 'innstillinger', 'tilpass', 'asetukset',
  'ayarlar', 'ρυθμίσεις', 'настройки', 'параметры', 'налаштування', '設定', '设置', '設置', '설정',
];

/** Words that must never appear on anything we click (after removing reject phrases). */
const DANGER = [
  'accept', 'accept all', 'agree', 'i agree', 'allow', 'allow all', 'ok', 'okay', 'got it', 'i understand', 'understood', 'consent', 'yes', 'continue', 'confirm', 'save', 'enable',
  'subscribe', 'subscription', 'sign up', 'sign in', 'log in', 'login', 'register', 'pay', 'buy', 'purchase', 'upgrade', 'premium', 'checkout', 'donate', 'ad-free', 'ad free', 'trial',
  'akzeptieren', 'alle akzeptieren', 'zustimmen', 'einverstanden', 'erlauben', 'annehmen', 'abonnieren', 'abo', 'pur-abo', 'anmelden', 'einloggen', 'kaufen', 'bezahlen', 'werbefrei', 'weiter', 'speichern', 'bestätigen',
  'accepter', "j'accepte", 'tout accepter', 'autoriser', "s'abonner", 'abonnement', 'connexion', 'se connecter', 'payer', 'acheter', 'continuer', 'enregistrer', 'valider',
  'aceptar', 'acepto', 'aceptar todo', 'permitir', 'suscribirse', 'suscríbete', 'iniciar sesión', 'pagar', 'comprar', 'continuar', 'guardar',
  'aceitar', 'aceito', 'concordo', 'assinar', 'entrar', 'salvar',
  'accetta', 'accetto', 'accetta tutto', 'consenti', 'abbonati', 'abbonamento', 'accedi', 'paga', 'acquista', 'continua', 'salva',
  'accepteren', 'akkoord', 'toestaan', 'alles toestaan', 'abonneren', 'inloggen', 'betalen', 'kopen', 'doorgaan', 'opslaan',
  'akceptuj', 'akceptuję', 'zgadzam się', 'zaakceptuj', 'zezwól', 'subskrybuj', 'zaloguj', 'zapłać', 'kup', 'přijmout', 'souhlasím', 'povolit', 'přihlásit', 'elfogadom', 'elfogad', 'accept toate', 'accept tot',
  'acceptera', 'godkänn', 'tillåt', 'acceptér', 'accepter alle', 'godta', 'tillat', 'hyväksy', 'hyväksyn', 'salli',
  'kabul', 'kabul et', 'kabul ediyorum', 'izin ver', 'αποδοχή', 'αποδέχομαι', 'συμφωνώ', 'принять', 'принять все', 'согласен', 'согласна', 'разрешить', 'войти', 'оплатить', 'прийняти', 'погоджуюсь',
  '同意', '接受', '全部接受', '承認', '許可', '登録', '購読', 'ログイン', '订阅', '登录', '支付', '동의', '수락', '모두 허용', '허용', '구독', '로그인', '결제',
];

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

function phraseRe(p: string): RegExp {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return CJK.test(p) ? new RegExp(esc, 'u') : new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, 'u');
}

const byLength = (a: string, b: string) => b.length - a.length;
// Compiled on first use, not at load: this module is bundled into the content
// script, which runs in every frame of every page, and compiling these ~400
// Unicode-property expressions took ~60 ms of main-thread time per frame
// (Chrome trace, cnn.com) although only the opt-in cookie click plans use them.
let compiled: { reject: Array<readonly [string, RegExp]>; nav: RegExp[]; danger: RegExp[] } | null = null;
function phraseRes(): { reject: Array<readonly [string, RegExp]>; nav: RegExp[]; danger: RegExp[] } {
  compiled ??= {
    reject: [...REJECT].sort(byLength).map((p) => [p, phraseRe(p)] as const),
    nav: [...NAVIGATE].sort(byLength).map(phraseRe),
    danger: DANGER.map(phraseRe),
  };
  return compiled;
}

/** Text with every reject phrase removed (so "continue without accepting" doesn't read as "accept"). */
function withoutReject(t: string): string {
  let out = t;
  for (const [p, re] of phraseRes().reject) {
    if (re.test(out)) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ');
    if (!out.trim()) break;
    void p;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function isRejectText(text: string): boolean {
  const t = normText(text);
  if (!t || t.length > 80) return false;
  return phraseRes().reject.some(([, re]) => re.test(t));
}

export function isNavigateText(text: string): boolean {
  const t = normText(text);
  if (!t || t.length > 60) return false;
  return phraseRes().nav.some((re) => re.test(t));
}

export function isDangerText(text: string): boolean {
  const t = withoutReject(normText(text));
  if (!t) return false;
  return phraseRes().danger.some((re) => re.test(t));
}

export type StepKind = 'reject' | 'navigate';

export type StepVerdict = { ok: true; kind: StepKind; target: Clickable } | { ok: false; reason: string };

function navigatesAway(c: Clickable): boolean {
  if (c.tag !== 'a') return false;
  const h = (c.href ?? '').trim();
  if (!h || h === '#' || h.startsWith('#') || /^javascript:\s*(void\(0\)|;)?\s*$/i.test(h)) return false;
  return true;
}

/**
 * Elements worth showing the model: anything validation would refuse outright
 * (accept / subscribe / pay / log-in wording, links away, text inputs) is left
 * out, so the model is not tempted by the big "Accept all" button. Validation
 * still runs on the full list, so an answer outside this subset is refused.
 */
export function offerToModel(c: Clickable): boolean {
  return !navigatesAway(c) && !(c.type && /^(password|email|text|file)$/i.test(c.type)) && !isDangerText(c.text);
}

/** Validate one proposed click against the offered elements. */
export function validateStep(selector: unknown, offered: Clickable[], stepIndex: number): StepVerdict {
  if (typeof selector !== 'string' || !selector) return { ok: false, reason: 'no selector' };
  if (stepIndex >= MAX_STEPS) return { ok: false, reason: 'too many steps' };
  const target = offered.find((c) => c.selector === selector);
  if (!target) return { ok: false, reason: 'selector was not offered' };
  if (navigatesAway(target)) return { ok: false, reason: 'link navigates away' };
  if (target.type && /^(password|email|text|file)$/i.test(target.type)) return { ok: false, reason: 'not a button' };
  const text = target.text;
  if (isDangerText(text)) return { ok: false, reason: `refused: "${text}" reads as accept/subscribe/pay/login` };
  // "Manage or reject cookies" (Sourcepoint's first layer) opens the settings: a navigation step while one is still allowed.
  if (isRejectText(text)) return { ok: true, kind: stepIndex < MAX_STEPS - 1 && isNavigateText(text) ? 'navigate' : 'reject', target };
  if (stepIndex < MAX_STEPS - 1 && isNavigateText(text)) return { ok: true, kind: 'navigate', target };
  return { ok: false, reason: `refused: "${text}" is not a reject / necessary-only control` };
}

export interface PlanStep {
  selector: string;
  text: string;
  kind: StepKind;
}

/**
 * Validate a whole plan (cached plans, tests): every step validated in order,
 * the last one must be a reject click, and only the last one may be.
 */
export function validatePlan(steps: unknown, offeredPerStep: Clickable[][]): { ok: true; steps: PlanStep[] } | { ok: false; reason: string } {
  if (!Array.isArray(steps) || !steps.length) return { ok: false, reason: 'empty plan' };
  if (steps.length > MAX_STEPS) return { ok: false, reason: 'too many steps' };
  const out: PlanStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as { selector?: unknown } | string;
    const sel = typeof s === 'string' ? s : s?.selector;
    const v = validateStep(sel, offeredPerStep[i] ?? [], i);
    if (!v.ok) return { ok: false, reason: `step ${i + 1}: ${v.reason}` };
    const last = i === steps.length - 1;
    if (last && v.kind !== 'reject') return { ok: false, reason: 'plan does not end with a reject click' };
    if (!last && v.kind === 'reject') return { ok: false, reason: 'reject click before the end of the plan' };
    out.push({ selector: v.target.selector, text: v.target.text, kind: v.kind });
  }
  return { ok: true, steps: out };
}

// ---------- banner detection helpers ----------

const BANNER_WORDS = /cookie|consent|gdpr|dsgvo|datenschutz|privacy|privacidad|confidentialité|vie privée|riservatezza|privacy policy|einwilligung|consentement|consentimento|consenso|toestemming|zgod|souhlas|samtycke|samtykke|suostumus|çerez|файлы cookie|クッキー|쿠키|隐私|tracking|tracker/i;

export function looksLikeConsentText(text: string): boolean {
  return BANNER_WORDS.test(text);
}

export function cookiePrompt(bannerText: string, offered: Clickable[], step: number): string {
  return [
    `Step ${step + 1}. Consent banner text: ${bannerText.replace(/\s+/g, ' ').trim().slice(0, 600)}`,
    'Clickable elements (selector => text):',
    ...offered.slice(0, 25).map((c) => `${c.selector} => ${c.text.slice(0, 60)}`),
    'Pick the selector that rejects all optional cookies (reject all / necessary only / decline). If there is none, pick the selector that opens the settings where rejecting is possible. Never pick accept, agree, allow, subscribe, pay or log-in buttons. Answer "none" if no element fits.',
  ].join('\n');
}

export const COOKIE_SYSTEM = 'You help a privacy tool close cookie consent banners by REJECTING optional cookies. You only choose among the listed selectors. Answer only with the JSON object.';

/** JSON schema constraining the answer to the offered selectors (or "none"). */
export function cookieSchema(offered: Clickable[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: { selector: { type: 'string', enum: [...offered.slice(0, 25).map((c) => c.selector), 'none'] } },
    required: ['selector'],
    additionalProperties: false,
  };
}

// ---------- consent banners inside iframes ----------
//
// Sourcepoint (Guardian, Spiegel, Bild) and some preference centres (iubenda)
// render the banner in a cross-origin iframe. The content script in that frame
// may run the cookie-plan flow on its own document only, and only when the
// frame is a real, visible consent dialog. One flow per tab at a time: the
// background holds a (tab, frame) lock with a short TTL.

export const FRAME_MIN_WIDTH = 200;
export const FRAME_MIN_HEIGHT = 100;

export interface FrameView {
  /** The frame's own viewport (innerWidth / innerHeight), CSS px. */
  width: number;
  height: number;
  /** document.visibilityState === 'hidden'. */
  docHidden: boolean;
  /** Visible text of the frame's document (or the banner candidate). */
  text: string;
  /** Banner element area and the part of it inside the top-level viewport (IntersectionObserver, implicit root); null = not measured yet. */
  bannerArea?: number | null;
  visibleArea?: number | null;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** May the cookie-plan flow run in this subframe? (The top frame never needs this.) */
export function frameQualifies(v: FrameView): Verdict {
  if (v.docHidden) return { ok: false, reason: 'frame document hidden' };
  if (!(v.width >= FRAME_MIN_WIDTH && v.height >= FRAME_MIN_HEIGHT)) return { ok: false, reason: `frame too small (${Math.round(v.width)}x${Math.round(v.height)})` };
  if (!looksLikeConsentText(v.text)) return { ok: false, reason: 'no consent wording' };
  if (v.bannerArea != null) {
    const vis = v.visibleArea ?? 0;
    if (!(v.bannerArea > 0) || !(vis > 0) || vis < 0.5 * v.bannerArea) return { ok: false, reason: 'banner not in the viewport' };
  }
  return { ok: true };
}

export interface ParentFrameBox {
  /** Origin of the iframe element's src (resolved). */
  origin: string;
  width: number;
  height: number;
  /** Intersects the top-level viewport. */
  inViewport: boolean;
  /** Not display:none / visibility:hidden / near-zero opacity (itself or an ancestor). */
  styleVisible: boolean;
}

/**
 * The top frame's view of the iframe elements that could hold a frame of `origin`:
 * "visible" when one is large, on screen and not hidden by CSS, "hidden" when
 * matching iframes exist but none is, "unknown" when none matches (nested frames,
 * a frame that navigated away from its src).
 */
export function parentFrameVerdict(boxes: ParentFrameBox[], origin: string): 'visible' | 'hidden' | 'unknown' {
  const m = boxes.filter((b) => b.origin === origin);
  if (!m.length) return 'unknown';
  return m.some((b) => b.styleVisible && b.inViewport && b.width >= FRAME_MIN_WIDTH && b.height >= FRAME_MIN_HEIGHT) ? 'visible' : 'hidden';
}

export const LOCK_TTL_MS = 15000;

interface Lock {
  frameId: number;
  until: number;
  /** A flow in this tab rejected: nobody else acts until the top frame navigates. */
  done: boolean;
  /** A model call for the holder is in flight (the TTL does not run out meanwhile). */
  busy: number;
}

export type LockResult = { ok: true } | { ok: false; reason: 'busy' | 'done' | 'not-holder' };

/**
 * One cookie-plan flow per tab. The flow already in progress wins; a finished
 * reject ends it for the page; a holder that went quiet loses the lock after
 * the TTL. Pure (time is passed in) so it can be unit tested.
 */
export class CookieLocks {
  private locks = new Map<number, Lock>();
  private ttl: number;

  constructor(ttl = LOCK_TTL_MS) {
    this.ttl = ttl;
  }

  private live(tabId: number, now: number): Lock | null {
    const l = this.locks.get(tabId);
    if (!l) return null;
    if (!l.done && !l.busy && l.until <= now) {
      this.locks.delete(tabId);
      return null;
    }
    return l;
  }

  acquire(tabId: number, frameId: number, now: number): LockResult {
    const l = this.live(tabId, now);
    if (l?.done) return { ok: false, reason: 'done' };
    if (l && l.frameId !== frameId) return { ok: false, reason: 'busy' };
    this.locks.set(tabId, { frameId, until: now + this.ttl, done: false, busy: l?.busy ?? 0 });
    return { ok: true };
  }

  holds(tabId: number, frameId: number, now: number): boolean {
    const l = this.live(tabId, now);
    return !!l && !l.done && l.frameId === frameId;
  }

  /** Whoever holds or last finished the flow in this tab (for reports). */
  owner(tabId: number, now: number): number | null {
    return this.live(tabId, now)?.frameId ?? null;
  }

  renew(tabId: number, frameId: number, now: number): LockResult {
    if (!this.holds(tabId, frameId, now)) return { ok: false, reason: 'not-holder' };
    this.locks.get(tabId)!.until = now + this.ttl;
    return { ok: true };
  }

  isBusy(tabId: number, frameId: number): boolean {
    const l = this.locks.get(tabId);
    return !!l && l.frameId === frameId && l.busy > 0;
  }

  /** Model call started / ended for the holder. */
  busy(tabId: number, frameId: number, on: boolean, now: number): void {
    const l = this.live(tabId, now);
    if (!l || l.frameId !== frameId) return;
    l.busy = Math.max(0, l.busy + (on ? 1 : -1));
    l.until = now + this.ttl;
  }

  release(tabId: number, frameId: number, now: number): boolean {
    if (!this.holds(tabId, frameId, now)) return false;
    this.locks.delete(tabId);
    return true;
  }

  finish(tabId: number, frameId: number, now: number): boolean {
    if (!this.holds(tabId, frameId, now)) return false;
    this.locks.get(tabId)!.done = true;
    return true;
  }

  reset(tabId: number): void {
    this.locks.delete(tabId);
  }
}
