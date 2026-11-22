// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// "Describe it to hide it": the user types what they want gone ("the newsletter
// pop-up", "chat bubble", "recommended videos"); the content side lists the
// visible blocks of the page; this module picks the one that matches, with the
// on-device model when it is there and with word matching when it is not.
// The pick only opens the element picker on that block: nothing is hidden
// until the user presses Hide there.

/** One visible block of the page, as the content side reports it. */
export interface BlockSummary {
  tag: string;
  id: string;
  classes: string[];
  /** aria-label, role, title, alt, data-testid… (name=value) */
  attrs: string[];
  text: string;
  /** Size and position in CSS pixels. */
  w: number;
  h: number;
  x: number;
  y: number;
  /** position: fixed / sticky */
  fixed: boolean;
}

const STOP = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'please', 'hide', 'remove', 'block', 'get', 'rid', 'of', 'all', 'any', 'on', 'in', 'at', 'to', 'from', 'thing', 'things', 'stuff', 'widget', 'box', 'section', 'part', 'area', 'me', 'my', 'i', 'it', 'its', 'and', 'or', 'with', 'annoying', 'page', 'site', 'which', 'one', 'ones', 'that\'s', 'is', 'are', 'about', 'some', 'for', 'other', 'others', 'sites', 'websites', 'web', 'like', 'keeps', 'showing', 'shows', 'appears', 'up', 'little']);

/** Words people use → words pages use for the same thing. */
const SYNONYMS: Record<string, string[]> = {
  popup: ['popup', 'pop-up', 'modal', 'dialog', 'overlay', 'lightbox', 'interstitial'],
  modal: ['modal', 'dialog', 'overlay', 'popup'],
  overlay: ['overlay', 'modal', 'backdrop'],
  newsletter: ['newsletter', 'subscribe', 'signup', 'sign-up', 'sign up', 'email', 'mailing', 'inbox', 'briefing', 'digest'],
  email: ['email', 'e-mail', 'inbox', 'newsletter', 'mailing', 'signup', 'sign up', 'subscribe'],
  subscribe: ['subscribe', 'subscription', 'newsletter', 'signup'],
  signup: ['signup', 'sign-up', 'sign up', 'register', 'subscribe'],
  bubble: ['bubble', 'launcher', 'badge', 'fab'],
  chat: ['chat', 'messenger', 'intercom', 'drift', 'zendesk', 'livechat', 'crisp', 'tawk', 'hubspot-messages', 'support'],
  video: ['video', 'player', 'jwplayer', 'vjs', 'brightcove', 'autoplay'],
  player: ['player', 'video'],
  recommended: ['recommended', 'related', 'outbrain', 'taboola', 'more-stories', 'you-may-like', 'around-the-web', 'trending'],
  related: ['related', 'recommended', 'more'],
  stories: ['stories', 'story', 'articles', 'more-stories'],
  trending: ['trending', 'popular', 'most-read'],
  sidebar: ['sidebar', 'aside', 'rail', 'right-column'],
  comments: ['comments', 'comment', 'disqus', 'discussion', 'replies'],
  footer: ['footer'],
  header: ['header', 'masthead', 'topbar'],
  banner: ['banner', 'bar', 'notice', 'alert', 'promo', 'ribbon'],
  notification: ['notification', 'notifications', 'push', 'notify', 'allow'],
  cookie: ['cookie', 'consent', 'gdpr', 'privacy'],
  app: ['app', 'download', 'install', 'open-in-app', 'smart-banner', 'get the app'],
  login: ['login', 'log-in', 'sign-in', 'signin', 'account', 'register'],
  social: ['social', 'share', 'facebook', 'twitter', 'linkedin', 'pinterest', 'follow'],
  share: ['share', 'social', 'sharing'],
  sticky: ['sticky', 'fixed', 'floating'],
  floating: ['floating', 'sticky', 'fixed'],
  ad: ['ad', 'ads', 'advert', 'advertisement', 'sponsored', 'promoted', 'promo'],
  ads: ['ad', 'ads', 'advert', 'advertisement', 'sponsored', 'promoted'],
  sponsored: ['sponsored', 'promoted', 'partner', 'paid'],
  feedback: ['feedback', 'survey', 'rate', 'poll'],
  survey: ['survey', 'feedback', 'poll', 'questionnaire'],
  paywall: ['paywall', 'subscribe', 'premium', 'meter'],
  donate: ['donate', 'donation', 'support us', 'contribute'],
  weather: ['weather', 'forecast', 'temperature'],
  forecast: ['forecast', 'weather'],
  stock: ['stock', 'ticker', 'market'],
  ticker: ['ticker', 'marquee'],
};

/** Normalised search words for a description (with synonyms). */
export function describeWords(description: string): Array<{ word: string; alts: string[] }> {
  const raw = description.toLowerCase().replace(/[“”"'’]/g, '').split(/[^a-z0-9-]+/).filter(Boolean);
  const out: Array<{ word: string; alts: string[] }> = [];
  for (let w of raw) {
    if (STOP.has(w) || w.length < 2) continue;
    if (w.includes('-') && (SYNONYMS[w.replace(/-/g, '')] || SYNONYMS[w.replace(/-/g, '').replace(/s$/, '')])) w = w.replace(/-/g, '');
    if (w.endsWith('s') && w.length > 3 && SYNONYMS[w.slice(0, -1)]) w = w.slice(0, -1);
    if (w === 'pop' || w === 'up') w = 'popup';
    if (out.some((o) => o.word === w)) continue;
    out.push({ word: w, alts: [...new Set([w, ...(SYNONYMS[w] ?? [])])] });
  }
  return out;
}

function blob(b: BlockSummary): { names: string; text: string } {
  const names = [b.tag, b.id, ...b.classes, ...b.attrs].join(' ').toLowerCase();
  return { names, text: b.text.toLowerCase() };
}

/** Word-matching score of one block for a description (no model). */
export function scoreBlock(b: BlockSummary, words: Array<{ word: string; alts: string[] }>, viewport: { w: number; h: number }): number {
  if (!words.length) return 0;
  const { names, text } = blob(b);
  let score = 0;
  let matched = 0;
  for (const { word, alts } of words) {
    let best = 0;
    for (const a of alts) {
      const exact = a === word ? 1 : 0.7;
      if (names.includes(a)) best = Math.max(best, 3 * exact);
      else if (new RegExp(`(^|[^a-z])${a.replace(/[-]/g, '\\-')}`).test(text)) best = Math.max(best, 2 * exact);
    }
    // Words about position / behaviour.
    if (['sticky', 'floating', 'popup', 'modal', 'overlay', 'banner', 'chat'].includes(word) && b.fixed) best = Math.max(best, 1.5);
    if (word === 'sidebar' && b.tag === 'aside') best = Math.max(best, 3);
    if (word === 'footer' && b.tag === 'footer') best = Math.max(best, 3);
    if (word === 'header' && b.tag === 'header') best = Math.max(best, 3);
    if (word === 'video' && (b.tag === 'video' || b.tag === 'iframe')) best = Math.max(best, 1);
    if (best > 0) matched++;
    score += best;
  }
  if (!matched) return 0;
  // Every word should count: a block matching all of them beats one matching a single word twice.
  score *= 0.5 + (0.5 * matched) / words.length;
  // Prefer blocks that are a whole thing, not a page-wide wrapper or a tiny word.
  const area = (b.w * b.h) / Math.max(1, viewport.w * viewport.h);
  if (area > 0.85) score *= 0.3;
  else if (area < 0.002) score *= 0.6;
  return score;
}

/** Best block by word matching, or -1 when nothing matches well enough. */
export function bestByWords(blocks: BlockSummary[], description: string, viewport: { w: number; h: number }): number {
  const words = describeWords(description);
  let best = -1;
  let bestScore = 1.4;
  blocks.forEach((b, i) => {
    const s = scoreBlock(b, words, viewport);
    // Ties: the earlier (outer) block, so the whole widget is hidden rather than one line of it.
    if (s > bestScore + 1e-9) {
      best = i;
      bestScore = s;
    }
  });
  return best;
}

/** At most this many blocks are shown to the model (its context is small). */
export const MODEL_BLOCKS = 40;

/** Blocks for the model: the word-matching favourites first, then the largest. */
export function shortlist(blocks: BlockSummary[], description: string, viewport: { w: number; h: number }, max = MODEL_BLOCKS): number[] {
  const words = describeWords(description);
  const scored = blocks.map((b, i) => ({ i, s: scoreBlock(b, words, viewport), area: b.w * b.h }));
  const byScore = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.i);
  const rest = scored.filter((x) => x.s === 0).sort((a, b) => b.area - a.area).map((x) => x.i);
  return [...byScore, ...rest].slice(0, max);
}

export const DESCRIBE_SYSTEM = 'You help a person hide one part of a web page. You get what they want hidden and a numbered list of page blocks (tag, names, size, the start of the text). Pick the ONE block that is the thing they describe - the whole widget, not one line inside it, and never the main article or the whole page. If none fits, answer -1. Answer only with the JSON object.';

export function describeSchema(n: number) {
  return {
    type: 'object',
    properties: { index: { type: 'integer', minimum: -1, maximum: Math.max(0, n - 1) } },
    required: ['index'],
    additionalProperties: false,
  } as const;
}

/** Where a block sits on the first screen ("bottom-right"), or '' when it is further down the page. */
export function placeOf(b: BlockSummary, viewport: { w: number; h: number }): string {
  if (b.y > viewport.h && !b.fixed) return '';
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const v = cy < viewport.h / 3 ? 'top' : cy > (viewport.h * 2) / 3 ? 'bottom' : 'middle';
  const h = cx < viewport.w / 3 ? 'left' : cx > (viewport.w * 2) / 3 ? 'right' : 'centre';
  return b.w > viewport.w * 0.6 ? v : `${v}-${h}`;
}

export function describePrompt(description: string, blocks: BlockSummary[], order: number[], viewport?: { w: number; h: number }): string {
  const lines = order.map((i, n) => {
    const b = blocks[i]!;
    const names = [b.id && `#${b.id}`, ...b.classes.slice(0, 4).map((c) => `.${c}`), ...b.attrs.slice(0, 3)].filter(Boolean).join(' ');
    const place = viewport ? placeOf(b, viewport) : '';
    return `${n}. <${b.tag}> ${names.slice(0, 120)} | ${b.w}x${b.h}${b.fixed ? ' floating' : ''}${place ? ` ${place}` : ''} | ${b.text.slice(0, 90)}`;
  });
  return `Hide: ${description.slice(0, 200)}\nBlocks:\n${lines.join('\n')}`;
}

/**
 * Final pick from the model's answer and word matching. The model wins, except when the words point
 * clearly at one block and the model chose a block that shares none of the person's words.
 */
export function combinePicks(blocks: BlockSummary[], description: string, viewport: { w: number; h: number }, modelPick: number | null): { index: number; via: 'model' | 'words' } {
  const byWords = bestByWords(blocks, description, viewport);
  if (modelPick === null || modelPick < 0) return { index: byWords, via: 'words' };
  if (byWords >= 0 && byWords !== modelPick && scoreBlock(blocks[modelPick]!, describeWords(description), viewport) === 0) return { index: byWords, via: 'words' };
  return { index: modelPick, via: 'model' };
}

/** Model answer → index into `blocks`, or -1. */
export function readDescribeAnswer(r: unknown, order: number[]): number {
  const n = (r as { index?: unknown } | null)?.index;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= order.length) return -1;
  return order[n]!;
}
