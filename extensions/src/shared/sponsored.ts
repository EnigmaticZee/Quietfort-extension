// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// "Sponsored content" pre-filters: deterministic signals that nominate page
// blocks as sponsored. Clear cases are hidden directly; ambiguous ones go to
// the on-device model when it is available, and are kept otherwise (stricter
// threshold without the model). Pure functions — the DOM side is in
// content/ai.ts.

import { registrable } from './domain.ts';

/** Disclosure labels, normalised (lower case, no punctuation). */
const STRONG_LABELS = [
  // en
  'sponsored', 'sponsored content', 'sponsored post', 'sponsored link', 'sponsored links', 'sponsored listing', 'sponsored result', 'sponsored ad',
  'promoted', 'promoted post', 'promoted content', 'promoted listing', 'advertisement', 'advertisements', 'advertorial',
  'paid partnership', 'paid content', 'paid post', 'paid promotion', 'partner content', 'affiliate', 'ad feature',
  // de
  'anzeige', 'anzeigen', 'gesponsert', 'werbung', 'gesponserter inhalt', 'sponsored by', 'bezahlte partnerschaft', 'promotion',
  // fr
  'sponsorisé', 'sponsorisée', 'sponsorisés', 'contenu sponsorisé', 'publicité', 'annonce', 'partenariat rémunéré', 'contenu partenaire',
  // es / pt
  'patrocinado', 'patrocinada', 'contenido patrocinado', 'publicidad', 'anuncio', 'promocionado', 'conteúdo patrocinado', 'publicidade', 'anúncio',
  // it
  'sponsorizzato', 'sponsorizzata', 'contenuto sponsorizzato', 'pubblicità', 'annuncio',
  // nl
  'gesponsord', 'advertentie', 'gesponsorde inhoud',
  // pl / cs / sk / hu / ro
  'sponsorowane', 'reklama', 'sponzorováno', 'sponzorované', 'hirdetés', 'szponzorált', 'sponsorizat', 'publicitate', 'reclamă',
  // nordic
  'sponsrad', 'annons', 'sponset', 'annonse', 'sponsoreret', 'reklame', 'mainos', 'sponsoroitu', 'kaupallinen yhteistyö',
  // tr / el / ru / uk
  'sponsorlu', 'reklam', 'χορηγούμενο', 'διαφήμιση', 'реклама', 'спонсорский', 'спонсорский контент', 'спонсорство', 'рекламa',
  // ar / he / hi
  'إعلان', 'ممول', 'مُموَّل', 'ממומן', 'פרסומת', 'प्रायोजित', 'विज्ञापन',
  // vi / th / id / ms
  'được tài trợ', 'quảng cáo', 'ได้รับการสนับสนุน', 'โฆษณา', 'bersponsor', 'iklan', 'disponsori', 'ditaja',
  // cjk
  '広告', 'スポンサー', 'プロモーション', 'pr', '赞助', '广告', '推广', '贊助', '廣告', '광고', '스폰서', '협찬',
];
/** Short labels that are also ordinary words: weaker evidence. */
const WEAK_LABELS = ['ad', 'ads', 'promo', 'partner', 'partners', 'sponsor', 'sponsors', 'offer'];
const BY_PREFIX = /^(sponsored|presented|promoted|paid for|brought to you|in partnership with|gesponsert von|präsentiert von|sponsorisé par|présenté par|patrocinado por|presentado por|sponsorizzato da|gesponsord door|sponsorowane przez)\s/;

const STRONG_SET = new Set(STRONG_LABELS);
const WEAK_SET = new Set(WEAK_LABELS);

export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u00a0\s]+/g, ' ')
    .replace(/^[\s·•|\-–—:()[\]*]+|[\s·•|\-–—:()[\]*.]+$/g, '')
    .trim();
}

/** Is this short text a sponsorship disclosure? */
export function disclosureStrength(text: string): 'strong' | 'weak' | null {
  if (text.length > 60) return null;
  const t = normalizeLabel(text);
  if (!t || t.length > 40) return null;
  if (STRONG_SET.has(t) || BY_PREFIX.test(`${t} `) && t.split(' ').length <= 6) return 'strong';
  if (WEAK_SET.has(t)) return 'weak';
  // "Sponsored · Brand", "Anzeige | Partner"
  const head = t.split(/\s*[·•|]\s*/)[0]!;
  if (head !== t && STRONG_SET.has(head)) return 'strong';
  return null;
}

/** Attribute text (aria-label, title, data-*) that discloses sponsorship. */
export function attributeDiscloses(value: string): boolean {
  const v = value.toLowerCase();
  return /\b(sponsored|promoted|advertisement|advertorial)\b|anzeige|gesponsert|sponsoris|patrocinad|sponsorizzat|gesponsord|реклама|広告|广告|광고/.test(v);
}

const AFFILIATE_HOSTS = [
  'amzn.to', 'amzn.eu', 'go.skimresources.com', 'redirect.viglink.com', 'click.linksynergy.com', 'linksynergy.com', 'awin1.com', 'shareasale.com',
  'anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com', 'tkqlhce.com', 'kqzyfj.com', 'pjtra.com', 'pntra.com', 'pntrs.com', 'prf.hn', 'clk.tradedoubler.com',
  'rstyle.me', 'shopstyle.it', 'howl.me', 'go.redirectingat.com', 'clickbank.net', 'hop.clickbank.net', 'sjv.io', 'pxf.io', 'ojrq.net', 'avantlink.com',
  'tidd.ly', 'bit.ly/aff', 'shop-links.co', 'fave.co', 'geni.us', 'lmct.co', 'impact.com', 'partnerize.com', 'webgains.com', 'zanox.com', 'belboon.com',
];
const AFFILIATE_PARAMS = /[?&](tag|aff_id|affid|affiliate|affiliate_id|aff|ref_id|irclickid|clickref|campaignid|subid|u1)=|[?&]utm_medium=(affiliate|aff|partner)/i;

export function isAffiliateUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (AFFILIATE_HOSTS.some((h) => (h.includes('/') ? `${host}${u.pathname}`.startsWith(h) : host === h || host.endsWith(`.${h}`)))) return true;
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) && u.searchParams.has('tag')) return true;
  if (/\/(aff|affiliate|go|recommends|out)\/[^/]+/i.test(u.pathname) && AFFILIATE_PARAMS.test(u.search)) return true;
  return AFFILIATE_PARAMS.test(u.search) && /\b(aff|affiliate|partner)\b/i.test(u.search);
}

const AD_FRAME_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net',
  'amazon-adsystem.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'media.net', 'revcontent.com', 'mgid.com', 'yieldmo.com',
  'teads.tv', 'smartadserver.com', 'adform.net', 'sharethrough.com', 'triplelift.com', '33across.com', 'zemanta.com', 'nativo.com', 'plista.com',
];

export function isAdNetworkUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AD_FRAME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const TOKEN_HINT = /(^|[-_\s])(sponsored|sponsor|promoted|advert|advertorial|ad-slot|adslot|ad-unit|adunit|native-ad|nativead|paid-post|partner-content)($|[-_\s\d])/i;

export function tokenHint(classAndId: string): boolean {
  return TOKEN_HINT.test(classAndId);
}

export interface BlockFeatures {
  /** Disclosure labels found in short text nodes of the block. */
  labels: Array<{ text: string; strength: 'strong' | 'weak' }>;
  /** aria-label / title / data-* values that disclose sponsorship. */
  attrDisclosures: number;
  relSponsored: number;
  affiliateLinks: number;
  adFrames: number;
  /** class / id tokens of the block and its descendants mentioning sponsorship. */
  tokenHints: number;
}

export interface BlockScore {
  score: number;
  reasons: string[];
}

export function scoreBlock(f: BlockFeatures): BlockScore {
  let score = 0;
  const reasons: string[] = [];
  const strong = f.labels.find((l) => l.strength === 'strong');
  if (strong) {
    score += 4;
    reasons.push(`label "${strong.text}"`);
  } else if (f.labels.length) {
    score += 2;
    reasons.push(`short label "${f.labels[0]!.text}"`);
  }
  if (f.attrDisclosures) {
    score += 3;
    reasons.push('attribute discloses sponsorship');
  }
  if (f.relSponsored) {
    score += 3;
    reasons.push('rel="sponsored" link');
  }
  if (f.adFrames) {
    score += 4;
    reasons.push('ad-network frame');
  }
  if (f.affiliateLinks) {
    score += f.affiliateLinks >= 2 ? 3 : 2;
    reasons.push(`${f.affiliateLinks} affiliate link(s)`);
  }
  if (f.tokenHints) {
    score += 1;
    reasons.push('class/id mentions sponsorship');
  }
  return { score, reasons };
}

/**
 * Article text with inline affiliate links: the only evidence is affiliate and/or rel="sponsored" links,
 * and the block reads as prose (a paragraph, or long text in which the links are a small part). Some
 * publishers send every outbound link through an affiliate service and mark it rel="sponsored", as Google
 * asks (real site: Tom's Guide, go.redirectingat.com, in a news paragraph), so such a block is the article
 * itself, not an ad. Never hidden, the model is not asked.
 */
export function proseWithInlineLinks(f: BlockFeatures, tag: string, textLen: number, linkTextLen: number): boolean {
  if (!(f.affiliateLinks || f.relSponsored) || f.labels.length || f.attrDisclosures || f.adFrames || f.tokenHints) return false;
  if (tag.toLowerCase() === 'p' || tag.toLowerCase() === 'blockquote') return true;
  return textLen >= 160 && linkTextLen / textLen < 0.35;
}

/** Score at or above which a block is hidden without asking the model. */
export const HIDE_THRESHOLD = 5;
/** Lowest score worth asking the model about. */
export const ASK_THRESHOLD = 2;

/**
 * hide: clear case; ask: ambiguous, the model decides; keep: not enough
 * evidence. Without a model, ambiguous blocks are kept (stricter threshold).
 */
export function decideBlock(score: number, modelAvailable: boolean): 'hide' | 'ask' | 'keep' {
  if (score >= HIDE_THRESHOLD) return 'hide';
  if (score >= ASK_THRESHOLD && modelAvailable) return 'ask';
  return 'keep';
}

/** Elements that are never hidden (nor anything containing them). */
export const PROTECTED_TAGS = new Set(['html', 'body', 'main', 'article', 'head']);

export function isProtectedElement(tag: string, role: string | null): boolean {
  return PROTECTED_TAGS.has(tag.toLowerCase()) || role === 'main' || role === 'article';
}

/** Size guard: a block may not hold a large share of the page. */
export function blockTooLarge(blockText: number, bodyText: number, blockArea: number, viewportArea: number): boolean {
  if (bodyText > 0 && blockText / bodyText > 0.25 && blockText > 400) return true;
  if (viewportArea > 0 && blockArea / viewportArea > 0.6) return true;
  return false;
}

/**
 * Block growth guard: while looking for the block around a signal, stop at a
 * parent that adds far more text than the block found so far (real sites: an
 * "Advertisement" slot inside a rail with the weather widget and games).
 */
export function growsTooMuch(bestText: number, parentText: number): boolean {
  return parentText > Math.max(bestText * 3, bestText + 300);
}

const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|x|twitter|tiktok|youtube|linkedin|pinterest|threads|bsky|reddit|whatsapp|snapchat)\.(com|net|app)$/;

/**
 * Navigation-like block: several short links, mostly to the page's own site
 * or social profiles: a menu or footer, not a sponsored unit (real sites:
 * a USA Today menu with "Advertise with us", Yahoo's footer next to an ad slot).
 */
export function looksLikeNavigation(links: Array<{ host: string; text: string }>, pageHost: string): boolean {
  if (links.length < 5) return false;
  const site = registrable(pageHost.toLowerCase());
  const own = links.filter((l) => {
    const h = l.host.toLowerCase();
    return registrable(h) === site || SOCIAL_HOSTS.test(h);
  }).length;
  const avg = links.reduce((a, l) => a + l.text.trim().length, 0) / links.length;
  return own / links.length >= 0.6 && avg <= 30;
}

/**
 * A section of the site's own links (several distinct links, nearly all to
 * the page's site) whose only evidence is a label: the label belongs to an
 * ad slot inside it (real sites: Yahoo's weather + games column holding an
 * empty "Advertisement" slot), so the section is kept rather than sent to the
 * model, which tends to follow the label.
 */
export function ownSectionWithLabelOnly(f: BlockFeatures, linkHosts: string[], pageHost: string): boolean {
  if (f.attrDisclosures || f.relSponsored || f.affiliateLinks || f.adFrames || !f.labels.length) return false;
  if (linkHosts.length < 3) return false;
  const site = registrable(pageHost.toLowerCase());
  return linkHosts.filter((h) => registrable(h.toLowerCase()) === site).length / linkHosts.length >= 0.8;
}

/** Captions that mark a display-ad slot ("Advertisement" above a banner), as opposed to native-ad labels ("Sponsored"). */
const DISPLAY_CAPTIONS = new Set([
  'advertisement', 'advertisements', 'anzeige', 'anzeigen', 'werbung', 'publicité', 'publicidad', 'pubblicità', 'publicidade',
  'reklama', 'reklame', 'reklam', 'annonce', 'annons', 'annonse', 'advertentie', 'mainos', 'реклама', '広告', '广告', '廣告', '광고',
]);

export function isDisplayCaption(text: string): boolean {
  return DISPLAY_CAPTIONS.has(normalizeLabel(text));
}

/**
 * A block holding one of the site's own headlines next to outside links (real
 * sites: Taboola feed cards on The Independent pairing its own story with a
 * paid one; a Fox News story Taboola labels "PROMOTED"). The block is not
 * hidden; paid items inside it are handled one by one.
 */
export function mixedFeedContainer(links: Array<{ host: string; text: string }>, pageHost: string): boolean {
  const site = registrable(pageHost.toLowerCase());
  const own = new Set(links.filter((l) => l.host && registrable(l.host.toLowerCase()) === site && l.text.trim().length >= 25).map((l) => l.text.trim()));
  return own.size >= 1 && links.some((l) => l.host && registrable(l.host.toLowerCase()) !== site);
}

/** CSS string literal for `:has-text()` / attribute values. */
function quoteless(s: string): string {
  return s.replace(/[()"\\]/g, '').slice(0, 60);
}

/**
 * Cache rule (a cosmetic selector) for a decided block: the block's stable
 * selector narrowed by the evidence that nominated it, so the verdict applies
 * to the same layout on later visits and the model runs once per layout.
 */
export function cacheSelector(blockSel: string, f: BlockFeatures, frameHost?: string, affiliateHost?: string): string | null {
  if (!blockSel) return null;
  if (f.relSponsored) return `${blockSel}:has(a[rel~="sponsored"])`;
  if (f.adFrames && frameHost) return `${blockSel}:has(iframe[src*="${quoteless(frameHost)}"])`;
  const label = f.labels.find((l) => l.strength === 'strong') ?? f.labels[0];
  if (label) return `${blockSel}:has-text(${quoteless(label.text.trim())})`;
  if (f.affiliateLinks && affiliateHost) return `${blockSel}:has(a[href*="${quoteless(affiliateHost)}"])`;
  return null;
}

/**
 * Prompt input for the model: pruned block text, its short label and where its
 * links go. The pre-filter's own findings are deliberately not listed: with
 * "signals found" in the prompt, the built-in model called every weak-label block
 * sponsored (0/20 editorial blocks kept in the real-model e2e).
 */
export function sponsoredPrompt(text: string, label: string | null, linkHosts: string[], pageHost: string): string {
  return [
    `Page: ${pageHost}`,
    `Short label shown on the block: ${label ? `"${label.replace(/\s+/g, ' ').trim().slice(0, 40)}"` : 'none'}`,
    `Links go to: ${linkHosts.slice(0, 8).join(', ') || 'none'}`,
    'Block text:',
    text.replace(/\s+/g, ' ').trim().slice(0, 700),
  ].join('\n');
}

export const SPONSORED_SYSTEM = 'You label one block of a news or shopping web page. "ad": it tries to sell you something or get you to sign up - advertising, a sponsored or paid post, a promotion, a discount, an affiliate product link. "editorial": a news story, article or report written by the site, even when it is about money, prices, offers, companies, sponsors, partners or advertising. "other": navigation, comments, anything else. A one-word label such as "Offer", "Partners", "Sponsor", "Ad" or "Promo" at the start is NOT enough on its own: decide from what the text says. First say in a few words what the block is about, then label it. Answer only with the JSON object.';

/** "about" first: a few words of grounding before the label made the real model far more accurate (50% → 100% in the prompt lab). */
export const SPONSORED_SCHEMA = {
  type: 'object',
  properties: { about: { type: 'string', maxLength: 80 }, kind: { type: 'string', enum: ['ad', 'editorial', 'other'] } },
  required: ['about', 'kind'],
  additionalProperties: false,
} as const;

/** Model answer → sponsored? (`{ sponsored }` is the stub model's / legacy shape.) */
export function readSponsoredAnswer(r: unknown): boolean | null {
  const o = r as { kind?: unknown; sponsored?: unknown } | null;
  if (!o || typeof o !== 'object') return null;
  if (o.kind === 'ad') return true;
  if (o.kind === 'editorial' || o.kind === 'other') return false;
  return typeof o.sponsored === 'boolean' ? o.sponsored : null;
}
