import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tokenRefSchema, type TokenRef } from '../domain/contracts.js';
import { canonicalSocialUrl, socialAccount, socialInputSchema, socialNamesAddress, type SocialInput } from '../domain/social.js';
import { fetchReadResponse, readLimitedText } from './http.js';

/**
 * Historical caller-body adapter for a fixed, seeded X status corpus (advisory only).
 * Root wiring interface:
 * - callerHistoryRequests(selection): exact keyed public reads, three per status (oEmbed, syndication, FxTwitter).
 * - collectCallerHistory(selection, fetcher?, now?, signal?): bounded reads; returns { rawArtifacts, requests, data }.
 * - decodeCallerHistory(selection, rawArtifacts): offline replay into SocialInput sources plus per-source layers.
 * Source text is FxTwitter tweet.text. Official X data corroborates id, author handle, creation second,
 * current revision and the visible official text only; it never authenticates the longer FX text.
 */
export const CALLER_HISTORY_METHOD = 'caller-history-official-prefix-fx-fulltext-v1' as const;
export const CALLER_HISTORY_TRUST = 'OFFICIAL_PREFIX_FX_FULLTEXT_V1: body text is provider-reported FxTwitter tweet.text; official X syndication/oEmbed corroborate status id, author handle, creation second, current revision and the visible official text only. Text beyond the official visible prefix is not authenticated. Accounts are not people; no reach, follower, holdings or platform-census claim.';
export const CALLER_PROVIDERS = ['oembed', 'syndication', 'fxtwitter'] as const;
export type CallerProvider = typeof CALLER_PROVIDERS[number];
/** Dedicated live allowance: exactly three public reads for each of at most 32 seeded statuses. */
export const CALLER_REQUEST_CAP = 32 * CALLER_PROVIDERS.length;
const MAX_BYTES = 500_000, TIMEOUT_MS = 10_000, SNOWFLAKE_EPOCH = 1288834974657n;
const timestamp = z.iso.datetime({ offset: true });

export const callerHistorySelectionSchema = z.object({
  schemaVersion: z.literal(1), token: tokenRefSchema,
  period: z.object({ start: timestamp, end: timestamp }).strict(), frozenAt: timestamp,
  sourceScopeHash: z.string().regex(/^[0-9a-f]{64}$/),
  queries: z.array(z.string().min(1).max(500)).min(1).max(20),
  posts: z.array(z.object({ seedSourceId: z.string().min(1).max(120), url: z.string().url() }).strict()).min(1).max(32),
}).strict();
export type CallerHistorySelection = z.infer<typeof callerHistorySelectionSchema>;
const receiptSchema = z.object({
  provider: z.enum(CALLER_PROVIDERS), request: z.string(), statusUrl: z.string(), retrievedAt: timestamp,
  status: z.number().int().min(100).max(599).nullable(), finalUrl: z.string().nullable(), body: z.string().nullable(),
  code: z.string().regex(/^CALLER_[A-Z_]+$/).optional(),
}).strict();
export type CallerReceipt = z.infer<typeof receiptSchema>;
export type CallerHistoryRequest = { provider: CallerProvider; statusUrl: string; url: string };
type SocialSource = SocialInput['sources'][number];
type Edit = { range: [number, number]; value: string };
export type CallerSourceLayer = {
  sourceId: string; seedSourceId: string; statusId: string; canonicalUrl: string; authorUrl: string; trust: string;
  receipts: Record<CallerProvider, { request: string; finalUrl: string | null; status: number | null; retrievedAt: string; bodySha256: string | null; code: string | null }>;
  shape: 'LEGACY_TEXT' | 'NOTE_TWEET' | null;
  bodyComplete: boolean;
  completeness: 'OFFICIAL_LEGACY_TEXT_EQUALS_FX_RAW' | 'FX_NOTE_TEXT_OFFICIAL_PREFIX_CORROBORATED' | null;
  bodySource: { provider: 'fxtwitter'; field: 'tweet.text'; trust: 'THIRD_PARTY_PROVIDER_REPORTED' } | null;
  publishedAt: string | null; timePrecision: 'SECOND';
  officialVisibleUtf16: number | null; fxRawUtf16: number | null; fxDisplayEnd: number | null;
  mintLocation: 'OFFICIAL_VISIBLE_TEXT' | 'FX_TEXT_ONLY' | 'ABSENT' | null;
  edit: { state: 'UNEDITED_AT_RETRIEVAL' | 'CURRENT_REVISION_OF_EDITED' | 'UNKNOWN'; editIds: string[]; predecessors: Array<{ statusId: string; idCreatedAt: string }>; windowOpenAtRetrieval: boolean | null; limitation: string } | null;
  role: { quote: boolean; quoteStatusId: string | null; reply: boolean; replyToStatusId: string | null } | null;
  facets: { applied: Array<{ type: 'url' | 'media'; unit: 'codepoint' | 'utf16'; range: [number, number] }>; unanchored: Array<{ type: string; indices: [number, number] }> } | null;
  oembed: 'AGREES' | 'UNAVAILABLE' | 'INVALID' | null;
  failure: string | null;
};
export type CallerHistory = {
  method: typeof CALLER_HISTORY_METHOD; trust: string; token: TokenRef; period: { start: string; end: string }; frozenAt: string;
  sourceScopeHash: string; selectionHash: string; analysisCutoff: string; complete: boolean;
  socialInput: SocialInput; layers: CallerSourceLayer[]; limitations: string[];
};

function fail(code: string): never { throw new Error(code); }
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const toUrl = (text: string) => { try { return new URL(text); } catch { return null; } };
const cpSlice = (text: string, a: number, b: number) => Array.from(text).slice(a, b).join('');
const cpToUtf16 = (text: string, index: number) => Array.from(text).slice(0, index).join('').length;
const snowflakeMs = (id: string) => Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH);
const comparable = (text: string) => text.replaceAll('https://', '').replaceAll('http://', '').replace(/\s+/gu, ' ').trim();
const lower = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : null;
const parse = (text: string | null | undefined): any => { if (typeof text !== 'string') return null; try { return JSON.parse(text); } catch { return null; } };
const span = (value: unknown): [number, number] | null => Array.isArray(value) && value.length === 2 && value.every(n => Number.isSafeInteger(n) && n >= 0) && value[0] <= value[1] ? [value[0], value[1]] : null;
const latest = (times: string[]) => times.reduce((a, b) => Date.parse(b) > Date.parse(a) ? b : a);

function statusOf(url: string): { handle: string; id: string } {
  const parsed = toUrl(url);
  if (!parsed) fail('CALLER_SELECTION_INVALID');
  const parts = parsed.pathname.split('/');
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'x.com' || parsed.search || parsed.hash || parts.length !== 4 || parts[0] !== '' || parts[2] !== 'status'
    || !/^[a-z0-9_]{1,15}$/.test(parts[1]!) || !/^[1-9][0-9]{0,19}$/.test(parts[3]!) || canonicalSocialUrl(url) !== url) fail('CALLER_SELECTION_INVALID');
  return { handle: parts[1]!, id: parts[3]! };
}
function parseSelection(input: unknown): CallerHistorySelection {
  const parsed = callerHistorySelectionSchema.safeParse(input);
  if (!parsed.success) fail('CALLER_SELECTION_INVALID');
  const selection = parsed.data, ids = selection.posts.map(post => statusOf(post.url).id);
  if (!(Date.parse(selection.period.start) < Date.parse(selection.period.end)) || Date.parse(selection.period.end) > Date.parse(selection.frozenAt)) fail('CALLER_SELECTION_INVALID');
  if (new Set(ids).size !== ids.length || new Set(selection.posts.map(post => post.seedSourceId)).size !== ids.length) fail('CALLER_SELECTION_INVALID');
  return selection;
}
export function callerHistorySelectionHash(input: unknown): string {
  const s = parseSelection(input);
  return sha(JSON.stringify({ schemaVersion: 1, token: { chain: s.token.chain, address: s.token.address }, period: { start: s.period.start, end: s.period.end }, frozenAt: s.frozenAt,
    sourceScopeHash: s.sourceScopeHash, queries: s.queries, posts: s.posts.map(post => ({ seedSourceId: post.seedSourceId, url: post.url })) }));
}
/** Public embed-token formula used by X's own embed widgets; not a credential. */
export const callerEmbedToken = (id: string) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|[.])/g, '');
export const callerHistoryKey = (id: string, provider: CallerProvider) => `caller-history:${id}:${provider}`;
export function callerHistoryRequests(input: unknown): Record<string, CallerHistoryRequest> {
  const requests: Record<string, CallerHistoryRequest> = {};
  for (const post of parseSelection(input).posts) {
    const { handle, id } = statusOf(post.url);
    requests[callerHistoryKey(id, 'oembed')] = { provider: 'oembed', statusUrl: post.url, url: `https://publish.twitter.com/oembed?url=${encodeURIComponent(post.url)}&omit_script=true&dnt=true` };
    requests[callerHistoryKey(id, 'syndication')] = { provider: 'syndication', statusUrl: post.url, url: `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${callerEmbedToken(id)}` };
    requests[callerHistoryKey(id, 'fxtwitter')] = { provider: 'fxtwitter', statusUrl: post.url, url: `https://api.fxtwitter.com/${handle}/status/${id}` };
  }
  return requests;
}
const failure = (request: CallerHistoryRequest, retrievedAt: string, code: string): CallerReceipt => ({ provider: request.provider, request: request.url, statusUrl: request.statusUrl, retrievedAt, status: null, finalUrl: null, body: null, code });

export async function collectCallerHistory(input: unknown, fetcher: typeof fetch = fetch, now: () => string = () => new Date().toISOString(), signal?: AbortSignal) {
  const selection = parseSelection(input), requests = callerHistoryRequests(selection), rawArtifacts: Record<string, string> = {};
  for (const [key, request] of Object.entries(requests)) {
    let receipt: CallerReceipt;
    if (signal?.aborted) receipt = failure(request, now(), 'CALLER_BUDGET');
    else {
      try {
        const response = await fetchReadResponse(request.url, { headers: { accept: 'application/json' }, redirect: request.provider === 'oembed' ? 'follow' : 'error', ...(signal ? { signal } : {}) }, fetcher, TIMEOUT_MS);
        const body = await readLimitedText(response, MAX_BYTES);
        receipt = { provider: request.provider, request: request.url, statusUrl: request.statusUrl, retrievedAt: now(), status: response.status, finalUrl: response.url || request.url, body };
      } catch (error) {
        const message = error instanceof Error ? error.message : '', name = error instanceof Error ? error.name : '';
        receipt = failure(request, now(), signal?.aborted || message === 'COLLECTION_BUDGET' ? 'CALLER_BUDGET' : message === 'PROVIDER_RESPONSE_LIMIT' ? 'CALLER_BODY_LIMIT' : message === 'PROVIDER_EMPTY_RESPONSE' ? 'CALLER_BODY_EMPTY'
          : name === 'TimeoutError' || name === 'AbortError' ? 'CALLER_TIMEOUT' : 'CALLER_TRANSPORT');
      }
    }
    rawArtifacts[key] = JSON.stringify(receipt);
  }
  return { rawArtifacts, requests, data: decodeCallerHistory(selection, rawArtifacts) };
}

function finalAllowed(request: CallerHistoryRequest, finalUrl: string): boolean {
  if (finalUrl === request.url) return true;
  if (request.provider !== 'oembed') return false;
  const a = toUrl(request.url), b = toUrl(finalUrl);
  return !!a && !!b && b.protocol === 'https:' && b.hostname === 'publish.x.com' && b.pathname === a.pathname && b.search === a.search;
}
/** An entity is anchored only when its literal original occupies its indices in one declared unit. */
function anchor(text: string, indices: [number, number], original: string): { unit: 'codepoint' | 'utf16'; range: [number, number] } | null {
  if (cpSlice(text, indices[0], indices[1]) === original) return { unit: 'codepoint', range: [cpToUtf16(text, indices[0]), cpToUtf16(text, indices[1])] };
  if (text.slice(indices[0], indices[1]) === original) return { unit: 'utf16', range: indices };
  return null;
}
function applyEdits(text: string, edits: Edit[]): string | null {
  let out = text, floor = text.length;
  for (const edit of [...edits].sort((a, b) => b.range[0] - a.range[0])) {
    if (edit.range[1] > floor) return null;
    out = out.slice(0, edit.range[0]) + edit.value + out.slice(edit.range[1]); floor = edit.range[0];
  }
  return out;
}

function decodePost(token: TokenRef, period: { start: string; end: string }, post: { seedSourceId: string; url: string }, r: Record<CallerProvider, CallerReceipt>): { source: SocialSource | null; layer: CallerSourceLayer } {
  const { handle, id } = statusOf(post.url);
  const layer: CallerSourceLayer = { sourceId: `caller-${id}`, seedSourceId: post.seedSourceId, statusId: id, canonicalUrl: post.url, authorUrl: `https://x.com/${handle}`, trust: CALLER_HISTORY_TRUST,
    receipts: Object.fromEntries(CALLER_PROVIDERS.map(p => [p, { request: r[p].request, finalUrl: r[p].finalUrl, status: r[p].status, retrievedAt: r[p].retrievedAt, bodySha256: r[p].body === null ? null : sha(r[p].body!), code: r[p].code ?? null }])) as CallerSourceLayer['receipts'],
    shape: null, bodyComplete: false, completeness: null, bodySource: null, publishedAt: null, timePrecision: 'SECOND', officialVisibleUtf16: null, fxRawUtf16: null, fxDisplayEnd: null,
    mintLocation: null, edit: null, role: null, facets: null, oembed: null, failure: null };
  const reject = (code: string) => ({ source: null, layer: { ...layer, failure: code } });
  if (r.syndication.status === 404) return reject('CALLER_OFFICIAL_NOT_FOUND');
  if (r.syndication.status !== 200) return reject('CALLER_OFFICIAL_UNAVAILABLE');
  const syn = parse(r.syndication.body);
  if (!syn || typeof syn !== 'object') return reject('CALLER_OFFICIAL_SHAPE');
  if (syn.__typename === 'TweetTombstone') return reject('CALLER_OFFICIAL_TOMBSTONE');
  if (syn.__typename !== 'Tweet' || typeof syn.text !== 'string') return reject('CALLER_OFFICIAL_SHAPE');
  const fx = r.fxtwitter.status === 200 ? parse(r.fxtwitter.body) : null, t = fx?.tweet;
  if (!fx || fx.code !== 200 || !t || typeof t !== 'object') return reject('CALLER_FX_UNAVAILABLE');
  if (syn.id_str !== id || t.id !== id) return reject('CALLER_ID_CONFLICT');
  if (lower(syn.user?.screen_name) !== handle || lower(t.author?.screen_name) !== handle) return reject('CALLER_AUTHOR_CONFLICT');
  if (t.reposted_by != null) return reject('CALLER_REPOST_NOT_AUTHOR_BODY');
  if (r.oembed.status === 200) {
    const o = parse(r.oembed.body);
    if (!o || typeof o.author_url !== 'string' || typeof o.url !== 'string') layer.oembed = 'INVALID';
    else if (![`https://x.com/${handle}`, `https://twitter.com/${handle}`].includes(o.author_url.toLowerCase().replace(/[/]$/, '')) || !o.url.includes(`/status/${id}`)) return reject('CALLER_OEMBED_CONFLICT');
    else layer.oembed = 'AGREES';
  } else layer.oembed = 'UNAVAILABLE';

  // X created_at and FxTwitter created_timestamp carry whole seconds; the snowflake is compared at that precision only.
  if (typeof syn.created_at !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.]000)?Z$/.test(syn.created_at) || !Number.isFinite(Date.parse(syn.created_at))) return reject('CALLER_TIME_PRECISION');
  const second = Date.parse(syn.created_at) / 1000;
  if (t.created_timestamp !== second || Math.floor(snowflakeMs(id) / 1000) !== second) return reject('CALLER_TIME_CONFLICT');
  const publishedAt = new Date(second * 1000).toISOString(); layer.publishedAt = publishedAt;
  if (Date.parse(publishedAt) < Date.parse(period.start) || Date.parse(publishedAt) >= Date.parse(period.end)) return reject('CALLER_OUTSIDE_PERIOD');

  // Edits are descriptive: the current revision may qualify; earlier revision bodies are never inferred.
  const ec = syn.edit_control;
  const ids: string[] | null = Array.isArray(ec?.edit_tweet_ids) && ec.edit_tweet_ids.length > 0 && ec.edit_tweet_ids.every((x: unknown) => typeof x === 'string' && /^[1-9][0-9]{0,19}$/.test(x)) ? ec.edit_tweet_ids : null;
  if (syn.isStaleEdit === true || ids && ids[ids.length - 1] !== id) return reject('CALLER_STALE_REVISION');
  const until = Number(ec?.editable_until_msecs);
  layer.edit = { state: !ids ? 'UNKNOWN' : ids.length === 1 && syn.isEdited === false ? 'UNEDITED_AT_RETRIEVAL' : ids.length > 1 && syn.isEdited === true ? 'CURRENT_REVISION_OF_EDITED' : 'UNKNOWN',
    editIds: ids ?? [], predecessors: (ids ?? []).slice(0, -1).map(p => ({ statusId: p, idCreatedAt: new Date(snowflakeMs(p)).toISOString() })),
    windowOpenAtRetrieval: ids && Number.isFinite(until) ? until > Date.parse(r.syndication.retrievedAt) : null,
    limitation: 'Body is the current revision at retrieval; predecessor bodies are unobserved and predecessor times are id creation times only.' };

  // Quoted and parent posts are role metadata; their text is never part of this source body.
  const refId = (value: any, key: string): string | null => value == null ? null : typeof value[key] === 'string' ? value[key] : '?';
  const fxQuote = refId(t.quote, 'id'), synQuote = refId(syn.quoted_tweet, 'id_str');
  const fxReply = typeof t.replying_to_status === 'string' ? t.replying_to_status : null;
  const synReply = typeof syn.in_reply_to_status_id_str === 'string' ? syn.in_reply_to_status_id_str : refId(syn.parent, 'id_str');
  const differs = (a: string | null, b: string | null) => (a === null) !== (b === null) || (a !== null && b !== null && a !== '?' && b !== '?' && a !== b);
  if (differs(fxQuote, synQuote) || differs(fxReply, synReply)) return reject('CALLER_ROLE_CONFLICT');
  const known = (a: string | null, b: string | null) => a !== null && a !== '?' ? a : b !== null && b !== '?' ? b : null;
  layer.role = { quote: fxQuote !== null, quoteStatusId: known(fxQuote, synQuote), reply: fxReply !== null, replyToStatusId: known(fxReply, synReply) };

  // tweet.text must equal raw_text.text with anchored url facets expanded and anchored media facets removed.
  const raw = t.raw_text, rawText = raw?.text, facets = raw?.facets;
  if (typeof t.text !== 'string' || typeof rawText !== 'string' || !Array.isArray(facets)) return reject('CALLER_FX_SHAPE');
  const edits: Edit[] = [], applied: NonNullable<CallerSourceLayer['facets']>['applied'] = [], unanchored: NonNullable<CallerSourceLayer['facets']>['unanchored'] = [];
  const mediaOriginals = new Set<string>(), seen = new Set<string>();
  for (const facet of facets) {
    const indices = span(facet?.indices);
    if (!indices || typeof facet.type !== 'string') return reject('CALLER_FX_SHAPE');
    if (facet.type !== 'url' && facet.type !== 'media') continue;
    if (typeof facet.original !== 'string' || (facet.type === 'url' && typeof facet.replacement !== 'string')) return reject('CALLER_FX_SHAPE');
    if (facet.type === 'media') mediaOriginals.add(facet.original);
    const anchored = anchor(rawText, indices, facet.original);
    if (!anchored) { unanchored.push({ type: facet.type, indices }); continue; }
    const key = `${anchored.range[0]}:${anchored.range[1]}:${facet.type}:${facet.original}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edits.push({ range: anchored.range, value: facet.type === 'url' ? facet.replacement : '' });
    applied.push({ type: facet.type, unit: anchored.unit, range: anchored.range });
  }
  layer.facets = { applied, unanchored }; layer.fxRawUtf16 = rawText.length;
  const rebuilt = applyEdits(rawText, edits);
  if (rebuilt === null || rebuilt.trimEnd() !== t.text.trimEnd()) return reject('CALLER_FX_TEXT_RELATION');

  // Official display_text_range counts UTF-16 units; X entity indices count code points (anchored per entity).
  let officialVisible: string;
  const officialNote = syn.note_tweet !== undefined;
  if (!officialNote && t.is_note_tweet === false) {
    if (syn.text !== rawText) return reject('CALLER_LEGACY_TEXT_CONFLICT');
    layer.shape = 'LEGACY_TEXT'; layer.completeness = 'OFFICIAL_LEGACY_TEXT_EQUALS_FX_RAW';
    officialVisible = syn.text; layer.officialVisibleUtf16 = syn.text.length;
  } else if (officialNote && t.is_note_tweet === true && syn.note_tweet && typeof syn.note_tweet === 'object' && Object.keys(syn.note_tweet).join() === 'id') {
    layer.shape = 'NOTE_TWEET';
    const fd = span(raw.display_text_range);
    if (!fd || fd[0] !== 0 || fd[1] > rawText.length) return reject('CALLER_FX_NOTE_INCOMPLETE');
    layer.fxDisplayEnd = fd[1];
    const suffix = rawText.slice(fd[1]).trim();
    if (suffix && !suffix.split(/\s+/u).every(part => mediaOriginals.has(part))) return reject('CALLER_FX_NOTE_INCOMPLETE');
    const dr = span(syn.display_text_range);
    if (!dr || dr[0] !== 0 || dr[1] === 0 || dr[1] > syn.text.length) return reject('CALLER_OFFICIAL_SHAPE');
    const urls: any[] = Array.isArray(syn.entities?.urls) ? syn.entities.urls : [], media: any[] = Array.isArray(syn.entities?.media) ? syn.entities.media : [];
    const officialEdits: Edit[] = [];
    for (const entity of [...urls, ...media]) {
      const indices = span(entity?.indices), isMedia = media.includes(entity);
      if (!indices || typeof entity.url !== 'string' || (!isMedia && typeof entity.expanded_url !== 'string')) return reject('CALLER_OFFICIAL_SHAPE');
      const anchored = anchor(syn.text, indices, entity.url);
      if (!anchored) return reject('CALLER_PREFIX_ENTITY_UNANCHORED');
      if (anchored.range[0] >= dr[1]) continue;
      if (isMedia) return reject('CALLER_PREFIX_ENTITY_UNSUPPORTED');
      if (anchored.range[1] > dr[1]) return reject('CALLER_PREFIX_ENTITY_CROPPED');
      officialEdits.push({ range: anchored.range, value: entity.expanded_url });
    }
    officialVisible = syn.text.slice(0, dr[1]); layer.officialVisibleUtf16 = dr[1];
    const prefix = applyEdits(officialVisible, officialEdits), wanted = prefix === null ? '' : comparable(prefix);
    if (!wanted || !comparable(t.text).startsWith(wanted)) return reject('CALLER_PREFIX_MISMATCH');
    layer.completeness = 'FX_NOTE_TEXT_OFFICIAL_PREFIX_CORROBORATED';
  } else return reject('CALLER_SHAPE_UNSUPPORTED');

  const officialHas = socialNamesAddress(officialVisible, token), fxHas = socialNamesAddress(t.text, token);
  if (officialHas && !fxHas) return reject('CALLER_BINDING_CONFLICT');
  layer.mintLocation = officialHas ? 'OFFICIAL_VISIBLE_TEXT' : fxHas ? 'FX_TEXT_ONLY' : 'ABSENT';
  if (!t.text.trim() || t.text.length > 120000) return reject('CALLER_TEXT_BOUNDS');
  layer.bodyComplete = true;
  layer.bodySource = { provider: 'fxtwitter', field: 'tweet.text', trust: 'THIRD_PARTY_PROVIDER_REPORTED' };
  return { layer, source: { id: layer.sourceId, url: post.url, text: t.text, publishedAt, authorId: socialAccount(post.url), availableAt: latest(CALLER_PROVIDERS.map(p => r[p].retrievedAt)), kind: 'POST' } };
}

/** Offline replay. Structural receipt problems throw; per-status evidence gaps stay explicit in layers and codes. */
export function decodeCallerHistory(input: unknown, rawArtifacts: Record<string, string>): CallerHistory {
  const selection = parseSelection(input), requests = callerHistoryRequests(selection);
  if (Object.keys(rawArtifacts).sort().join('|') !== Object.keys(requests).sort().join('|')) fail('CALLER_RAW_MEMBERSHIP');
  const receipts: Record<string, CallerReceipt> = {};
  for (const [key, request] of Object.entries(requests)) {
    const parsed = receiptSchema.safeParse(parse(rawArtifacts[key]));
    if (!parsed.success) fail('CALLER_RECEIPT_INVALID');
    const receipt = parsed.data, failed = receipt.status === null;
    if (receipt.provider !== request.provider || receipt.request !== request.url || receipt.statusUrl !== request.statusUrl) fail('CALLER_RECEIPT_BINDING');
    if (failed !== (receipt.body === null) || failed !== (receipt.finalUrl === null) || failed !== (receipt.code !== undefined)) fail('CALLER_RECEIPT_INVALID');
    if (Date.parse(receipt.retrievedAt) < Date.parse(selection.frozenAt)) fail('CALLER_CLOCK_ORDER');
    if (receipt.finalUrl !== null && !finalAllowed(request, receipt.finalUrl)) fail('CALLER_REDIRECT_BINDING');
    receipts[key] = receipt;
  }
  const decoded = selection.posts.map(post => {
    const { id } = statusOf(post.url);
    return decodePost(selection.token, selection.period, post, { oembed: receipts[callerHistoryKey(id, 'oembed')]!, syndication: receipts[callerHistoryKey(id, 'syndication')]!, fxtwitter: receipts[callerHistoryKey(id, 'fxtwitter')]! });
  });
  const sources = decoded.flatMap(d => d.source ? [d.source] : []), layers = decoded.map(d => d.layer);
  // A status verified (official, FX and snowflake seconds agree) to fall outside the frozen period is an exclusion, not a missing body.
  const complete = layers.every(l => l.bodyComplete || l.failure === 'CALLER_OUTSIDE_PERIOD');
  const socialInput = socialInputSchema.parse({ schemaVersion: 1, sources, start: selection.period.start, end: selection.period.end, targetPostIds: sources.map(s => s.id),
    identitySourceIds: [], sampleComplete: complete, identityComplete: false, previousComparable: false,
    codes: layers.filter(l => l.failure).map(l => `${l.failure}:${l.seedSourceId}`), queries: selection.queries });
  return { method: CALLER_HISTORY_METHOD, trust: CALLER_HISTORY_TRUST, token: selection.token, period: selection.period, frozenAt: selection.frozenAt,
    sourceScopeHash: selection.sourceScopeHash, selectionHash: callerHistorySelectionHash(selection), analysisCutoff: latest(Object.values(receipts).map(r => r.retrievedAt)), complete, socialInput, layers,
    limitations: ['Fixed seeded corpus only; not a platform census, reach, follower or unique-person measure.',
      'Body text is provider-reported FxTwitter tweet.text; official X data corroborates id, author handle, creation second, current revision and visible official text only.',
      'Long-post text beyond the official visible prefix is not authenticated.',
      'Edited posts are read as their current revision; predecessor bodies are unobserved.',
      'Quoted and parent posts are role metadata only; their text is excluded from the source body.',
      'Paid-partnership labels are absent from these bodies; S08/A22 keep their existing sources.'] };
}
