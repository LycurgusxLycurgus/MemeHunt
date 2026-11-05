import assert from 'node:assert/strict';
import test from 'node:test';
import { CALLER_HISTORY_TRUST, callerEmbedToken, callerHistoryKey, callerHistoryRequests, callerHistorySelectionHash, collectCallerHistory, decodeCallerHistory, type CallerProvider } from '../src/providers/advisory-caller-history.js';
import { socialInputSchema } from '../src/domain/social.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const token = { chain: 'solana' as const, address: MINT };
const RETRIEVED = '2026-10-12T00:00:00.000Z';
const cp = (s: string) => Array.from(s).length;
const idAt = (iso: string, seq: bigint) => String(((BigInt(Date.parse(iso)) - 1288834974657n) << 22n) + seq);
type Spec = { handle: string; id: string } & Record<CallerProvider, any>;
const oembed = (Handle: string, id: string) => ({ url: `https://twitter.com/${Handle}/status/${id}`, author_name: Handle, author_url: `https://twitter.com/${Handle}`, html: '<blockquote class=twitter-tweet><p>synthetic</p></blockquote>', type: 'rich', version: '1.0' });
const edit = (id: string, createdAt: string) => ({ edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(createdAt) + 3_600_000), edits_remaining: '5', is_edit_eligible: true });
const fxTweet = (Handle: string, id: string, createdAt: string, text: string, raw: unknown, isNote: boolean) => ({ url: `https://x.com/${Handle}/status/${id}`, id, text, raw_text: raw, author: { screen_name: Handle, followers: 1 },
  created_at: 'synthetic', created_timestamp: Date.parse(createdAt) / 1000, is_note_tweet: isNote, replying_to: null, replying_to_status: null, reposted_by: null } as Record<string, any>);

/** Ordinary post: official text is complete; FX display_text_range is deliberately off by one, as observed. */
function legacy(handle: string, createdAt: string, seq = 1n, body = `Spotted $TEST early 🔥\nCa: ${MINT}`): Spec {
  const id = idAt(createdAt, seq), Handle = handle.toUpperCase(), media = 'https://t.co/MEDIA00001', raw = `${body} ${media}`, start = cp(body) + 1, indices = [start, start + cp(media)];
  return { handle, id, oembed: oembed(Handle, id),
    syndication: { __typename: 'Tweet', id_str: id, created_at: createdAt, display_text_range: [0, body.length], entities: { media: [{ url: media, expanded_url: `https://x.com/${Handle}/status/${id}/photo/1`, display_url: 'pic.x.com/MEDIA00001', indices }] },
      text: raw, user: { screen_name: Handle }, edit_control: edit(id, createdAt), isEdited: false, isStaleEdit: false },
    fxtwitter: { code: 200, message: 'OK', tweet: fxTweet(Handle, id, createdAt, body, { text: raw, display_text_range: [0, cp(body) - 1], facets: [{ type: 'symbol', indices: [8, 13], original: 'TEST' },
      { type: 'media', indices, original: media, replacement: 'photo' }, { type: 'media', indices, original: media, replacement: 'photo' }] }, false) } };
}
/** Long note: official text is cropped (UTF-16 display range), FX has the full note with its own t.co wrapper and legacy media indices. */
function note(handle: string, createdAt: string, seq = 1n, mintInPrefix = false): Spec {
  const id = idAt(new Date(Date.parse(createdAt) + 487).toISOString(), seq), legacyUrl = 'https://t.co/LEGURL0001', noteUrl = 'https://t.co/NOTEURL001', media = 'https://t.co/MEDIA00002';
  const head = mintInPrefix ? `watching solana:${MINT} 🦠\n\nOpen ` : 'Colony hatching now 🥚\n\nOpen ', mid = '\nhold or stake';
  const tail = mintInPrefix ? ' more ideas\n\nkeeping eyes on it 👀' : ` solana:${MINT}\n\nEvery mint goes back into solana:${MINT}\nWho's hatching?`;
  const visible = `${head}${legacyUrl}${mid}`, mediaAt = [cp(visible) + 1, cp(visible) + 1 + cp(media)];
  const raw = `${head}${noteUrl}${mid}${tail}`, text = `${head}http://colony.example/mint${mid}${tail}`;
  return { handle, id, oembed: oembed(handle, id),
    syndication: { __typename: 'Tweet', id_str: id, created_at: createdAt, display_text_range: [0, visible.length],
      entities: { urls: [{ url: legacyUrl, expanded_url: 'https://colony.example/mint', display_url: 'colony.example/mint', indices: [cp(head), cp(head) + cp(legacyUrl)] }], media: [{ url: media, expanded_url: `https://x.com/${handle}/status/${id}/photo/1`, display_url: 'pic.x.com/MEDIA00002', indices: mediaAt }] },
      text: `${visible} ${media}`, user: { screen_name: handle }, edit_control: edit(id, createdAt), isEdited: false, isStaleEdit: false, note_tweet: { id: 'Tm90ZVR3ZWV0' } },
    fxtwitter: { code: 200, message: 'OK', tweet: fxTweet(handle, id, createdAt, text, { text: raw, display_text_range: [0, raw.length], facets: [
      { type: 'url', indices: [cp(head), cp(head) + cp(noteUrl)], original: noteUrl, replacement: 'http://colony.example/mint', display: 'colony.example/mint' },
      { type: 'media', indices: mediaAt, original: media, replacement: 'photo' }] }, true) } };
}
const selection = (specs: Spec[]) => ({ schemaVersion: 1, token, period: { start: '2026-09-27T00:00:00.000Z', end: '2026-10-11T00:00:00.000Z' }, frozenAt: '2026-10-11T01:00:00.000Z', sourceScopeHash: 'a'.repeat(64),
  queries: [`${MINT} site:x.com`], posts: specs.map((s, i) => ({ seedSourceId: `seed-${i + 1}`, url: `https://x.com/${s.handle}/status/${s.id}` })) });
type Override = Record<string, Record<string, unknown>>;
function artifacts(sel: unknown, specs: Spec[], override: Override = {}) {
  const out: Record<string, string> = {};
  for (const [key, r] of Object.entries(callerHistoryRequests(sel))) {
    const spec = specs.find(s => r.statusUrl.endsWith(`/${s.id}`))!;
    out[key] = JSON.stringify({ provider: r.provider, request: r.url, statusUrl: r.statusUrl, retrievedAt: RETRIEVED, status: 200, finalUrl: r.url, body: JSON.stringify(spec[r.provider]), ...override[key] });
  }
  return out;
}
const decode = (specs: Spec[], override: Override = {}) => { const sel = selection(specs); return decodeCallerHistory(sel, artifacts(sel, specs, override)); };
const layer = (specs: Spec[], override: Override = {}) => decode(specs, override).layers[0]!;
const A_AT = '2026-09-29T12:00:00.000Z', N_AT = '2026-10-04T15:22:36.000Z';

test('requests are exactly three public reads per seeded canonical status and selections stay bounded', () => {
  const a = legacy('alpha_caller', A_AT), sel = selection([a]), req = callerHistoryRequests(sel), k = (p: CallerProvider) => callerHistoryKey(a.id, p);
  assert.deepEqual(Object.keys(req).sort(), [k('fxtwitter'), k('oembed'), k('syndication')].sort());
  assert.equal(req[k('oembed')]!.url, `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://x.com/alpha_caller/status/${a.id}`)}&omit_script=true&dnt=true`);
  assert.equal(req[k('syndication')]!.url, `https://cdn.syndication.twimg.com/tweet-result?id=${a.id}&lang=en&token=${callerEmbedToken(a.id)}`);
  assert.equal(req[k('fxtwitter')]!.url, `https://api.fxtwitter.com/alpha_caller/status/${a.id}`);
  assert.equal(callerEmbedToken('2106766946280595460'), '53ulq7r5fgw');
  assert.equal(callerHistorySelectionHash(sel), callerHistorySelectionHash(JSON.parse(JSON.stringify(sel))));
  const bad = (patch: Record<string, unknown>) => assert.throws(() => callerHistoryRequests({ ...sel, ...patch }), /CALLER_SELECTION_INVALID/);
  bad({ posts: Array.from({ length: 33 }, (_, i) => ({ seedSourceId: `s${i}`, url: `https://x.com/a/status/${i + 1}` })) });
  bad({ posts: [{ seedSourceId: 's', url: `https://x.com/Alpha_Caller/status/${a.id}` }] });
  bad({ posts: [sel.posts[0], { ...sel.posts[0], seedSourceId: 'other' }] });
  bad({ frozenAt: '2026-10-10T00:00:00.000Z' });
});

test('legacy and long-note bodies become FX text sources with official id, author, second, revision and prefix corroboration', () => {
  const a = legacy('alpha_caller', A_AT), b = note('colony_project', N_AT), rawNote: string = b.fxtwitter.tweet.raw_text.text;
  assert.notEqual(cp(rawNote), rawNote.length);
  const run = decode([a, b]), [la, lb] = run.layers;
  assert.equal(run.complete, true); assert.equal(run.socialInput.sampleComplete, true); assert.equal(run.analysisCutoff, RETRIEVED); assert.equal(run.trust, CALLER_HISTORY_TRUST);
  assert.doesNotThrow(() => socialInputSchema.parse(run.socialInput));
  assert.equal(la!.completeness, 'OFFICIAL_LEGACY_TEXT_EQUALS_FX_RAW'); assert.equal(la!.mintLocation, 'OFFICIAL_VISIBLE_TEXT');
  assert.equal(lb!.completeness, 'FX_NOTE_TEXT_OFFICIAL_PREFIX_CORROBORATED'); assert.equal(lb!.mintLocation, 'FX_TEXT_ONLY');
  assert.deepEqual(lb!.bodySource, { provider: 'fxtwitter', field: 'tweet.text', trust: 'THIRD_PARTY_PROVIDER_REPORTED' });
  assert.deepEqual(lb!.facets!.unanchored, [{ type: 'media', indices: b.fxtwitter.tweet.raw_text.facets[1].indices }]);
  assert.equal(lb!.facets!.applied[0]!.unit, 'codepoint');
  assert.equal(lb!.edit!.state, 'UNEDITED_AT_RETRIEVAL'); assert.equal(lb!.edit!.windowOpenAtRetrieval, false); assert.equal(lb!.oembed, 'AGREES');
  const source = run.socialInput.sources.find(s => s.id === lb!.sourceId)!;
  assert.equal(source.text, b.fxtwitter.tweet.text); assert.equal(source.url, `https://x.com/colony_project/status/${b.id}`);
  assert.equal(source.authorId, 'x.com:colony_project'); assert.equal(source.publishedAt, N_AT); assert.equal(source.availableAt, RETRIEVED);
  assert.equal(run.socialInput.sources.find(s => s.id === la!.sourceId)!.text.includes('t.co'), false);
  assert.equal(layer([note('hira_like', '2026-09-29T12:50:44.000Z', 1n, true)]).mintLocation, 'OFFICIAL_VISIBLE_TEXT');
});

test('prefix comparison tolerates crop spaces, NBSP and entity-link wrappers but not contradictory words or cropped entities', () => {
  const crop = note('colony_project', N_AT); crop.syndication.display_text_range[1] += 1;
  assert.equal(layer([crop]).bodyComplete, true);
  const nbsp = note('colony_project', N_AT); nbsp.syndication.text = nbsp.syndication.text.replace('hatching now', 'hatching\u00a0now');
  assert.equal(layer([nbsp]).bodyComplete, true);
  const word = note('colony_project', N_AT); word.syndication.text = word.syndication.text.replace('Colony', 'Kolony');
  assert.equal(layer([word]).failure, 'CALLER_PREFIX_MISMATCH');
  const cut = note('colony_project', N_AT); cut.syndication.display_text_range[1] = 'Colony hatching now 🥚\n\nOpen '.length + 5;
  assert.equal(layer([cut]).failure, 'CALLER_PREFIX_ENTITY_CROPPED');
});

test('note completeness accepts only a full FX UTF-16 range or a recognized media suffix; unsupported shapes stay incomplete', () => {
  const short = note('colony_project', N_AT); short.fxtwitter.tweet.raw_text.display_text_range[1] -= 10;
  assert.equal(layer([short]).failure, 'CALLER_FX_NOTE_INCOMPLETE');
  const withMedia = note('colony_project', N_AT), raw = withMedia.fxtwitter.tweet.raw_text, extra = 'https://t.co/MEDIA00003', at = cp(raw.text) + 1;
  raw.facets.push({ type: 'media', indices: [at, at + cp(extra)], original: extra, replacement: 'photo' }); raw.text += ` ${extra}`;
  assert.equal(layer([withMedia]).bodyComplete, true);
  const noRaw = note('colony_project', N_AT); delete noRaw.fxtwitter.tweet.raw_text;
  assert.equal(layer([noRaw]).failure, 'CALLER_FX_SHAPE');
  const notNote = note('colony_project', N_AT); notNote.fxtwitter.tweet.is_note_tweet = false;
  assert.equal(layer([notNote]).failure, 'CALLER_SHAPE_UNSUPPORTED');
  const officialBody = note('colony_project', N_AT); officialBody.syndication.note_tweet = { id: 'Tm90ZQ', text: 'unexpected' };
  assert.equal(layer([officialBody]).failure, 'CALLER_SHAPE_UNSUPPORTED');
  const changed = legacy('alpha_caller', A_AT); changed.syndication.text = changed.syndication.text.replace('early', 'later');
  assert.equal(layer([changed]).failure, 'CALLER_LEGACY_TEXT_CONFLICT');
  const relation = legacy('alpha_caller', A_AT); relation.fxtwitter.tweet.text += ' extra';
  assert.equal(layer([relation]).failure, 'CALLER_FX_TEXT_RELATION');
});

test('edited posts qualify as their current revision with listed predecessors; stale revisions do not', () => {
  const current = note('colony_project', '2026-09-30T12:00:51.000Z'), prior = idAt('2026-09-30T11:40:51.000Z', 3n);
  current.syndication.isEdited = true; current.syndication.edit_control.edit_tweet_ids = [prior, current.id];
  const l = layer([current]);
  assert.equal(l.bodyComplete, true); assert.equal(l.edit!.state, 'CURRENT_REVISION_OF_EDITED'); assert.equal(l.publishedAt, '2026-09-30T12:00:51.000Z');
  assert.deepEqual(l.edit!.predecessors, [{ statusId: prior, idCreatedAt: '2026-09-30T11:40:51.000Z' }]);
  const stale = note('colony_project', N_AT); stale.syndication.edit_control.edit_tweet_ids = [stale.id, idAt('2026-10-04T16:00:00.000Z', 1n)];
  assert.equal(layer([stale]).failure, 'CALLER_STALE_REVISION');
  const flagged = note('colony_project', N_AT); flagged.syndication.isStaleEdit = true;
  assert.equal(layer([flagged]).failure, 'CALLER_STALE_REVISION');
  const open = legacy('alpha_caller', A_AT); open.syndication.edit_control.editable_until_msecs = String(Date.parse(RETRIEVED) + 60_000);
  const lo = layer([open]); assert.equal(lo.bodyComplete, true); assert.equal(lo.edit!.windowOpenAtRetrieval, true);
});

test('identity and second-precision time must agree across official, FX and snowflake; period is fixed', () => {
  const author = legacy('alpha_caller', A_AT); author.syndication.user.screen_name = 'someone_else';
  assert.equal(layer([author]).failure, 'CALLER_AUTHOR_CONFLICT');
  const fxSecond = legacy('alpha_caller', A_AT); fxSecond.fxtwitter.tweet.created_timestamp += 1;
  assert.equal(layer([fxSecond]).failure, 'CALLER_TIME_CONFLICT');
  const millis = legacy('alpha_caller', A_AT); millis.syndication.created_at = '2026-09-29T12:00:00.123Z';
  assert.equal(layer([millis]).failure, 'CALLER_TIME_PRECISION');
  const snow = legacy('alpha_caller', A_AT), later = '2026-09-29T12:00:01.000Z'; snow.syndication.created_at = later; snow.fxtwitter.tweet.created_timestamp = Date.parse(later) / 1000;
  assert.equal(layer([snow]).failure, 'CALLER_TIME_CONFLICT');
  assert.equal(layer([legacy('alpha_caller', '2026-10-11T00:00:00.000Z')]).failure, 'CALLER_OUTSIDE_PERIOD');
});

test('quoted text is role metadata and never lends the mint to the quoting body', () => {
  const make = () => { const q = legacy('alpha_caller', '2026-10-01T20:11:12.000Z', 1n, 'Timing was right 🚀\nDM to join'), qid = idAt('2026-10-01T20:10:10.000Z', 1n);
    q.fxtwitter.tweet.quote = { id: qid, url: `https://x.com/ALPHA_CALLER/status/${qid}`, text: `Ca: ${MINT}` }; q.syndication.quoted_tweet = { id_str: qid, text: `Ca: ${MINT}` }; return { q, qid }; };
  const { q, qid } = make(), run = decode([q]), l = run.layers[0]!;
  assert.equal(l.bodyComplete, true); assert.deepEqual(l.role, { quote: true, quoteStatusId: qid, reply: false, replyToStatusId: null });
  assert.equal(l.mintLocation, 'ABSENT'); assert.equal(run.socialInput.sources[0]!.text.includes(MINT), false);
  const other = make().q; other.syndication.quoted_tweet.id_str = idAt('2026-10-01T19:00:00.000Z', 2n);
  assert.equal(layer([other]).failure, 'CALLER_ROLE_CONFLICT');
  const missing = make().q; delete missing.syndication.quoted_tweet;
  assert.equal(layer([missing]).failure, 'CALLER_ROLE_CONFLICT');
});

test('proxy-only, tombstoned or unavailable bodies stay missing; oEmbed is corroboration only', () => {
  const a = legacy('alpha_caller', A_AT), k = (p: CallerProvider) => callerHistoryKey(a.id, p);
  const gone = decode([a], { [k('syndication')]: { status: 404, body: 'not found' } });
  assert.equal(gone.layers[0]!.failure, 'CALLER_OFFICIAL_NOT_FOUND'); assert.equal(gone.socialInput.sources.length, 0);
  assert.equal(gone.complete, false); assert.equal(gone.socialInput.sampleComplete, false); assert.deepEqual(gone.socialInput.codes, ['CALLER_OFFICIAL_NOT_FOUND:seed-1']);
  assert.equal(layer([a], { [k('syndication')]: { body: JSON.stringify({ __typename: 'TweetTombstone' }) } }).failure, 'CALLER_OFFICIAL_TOMBSTONE');
  assert.equal(layer([a], { [k('fxtwitter')]: { status: null, finalUrl: null, body: null, code: 'CALLER_TIMEOUT' } }).failure, 'CALLER_FX_UNAVAILABLE');
  assert.equal(layer([a], { [k('fxtwitter')]: { body: JSON.stringify({ code: 404, message: 'NOT_FOUND', tweet: null }) } }).failure, 'CALLER_FX_UNAVAILABLE');
  const noEmbed = layer([a], { [k('oembed')]: { status: 404, body: 'not found' } }); assert.equal(noEmbed.bodyComplete, true); assert.equal(noEmbed.oembed, 'UNAVAILABLE');
  assert.equal(layer([a], { [k('oembed')]: { body: JSON.stringify(oembed('OTHER', a.id)) } }).failure, 'CALLER_OEMBED_CONFLICT');
});

test('raw membership, request binding, clocks and redirects are enforced at the replay edge', () => {
  const a = legacy('alpha_caller', A_AT), sel = selection([a]), raw = artifacts(sel, [a]), k = (p: CallerProvider) => callerHistoryKey(a.id, p);
  assert.throws(() => decodeCallerHistory(sel, { ...raw, extra: '{}' }), /CALLER_RAW_MEMBERSHIP/);
  const { [k('oembed')]: _omitted, ...missing } = raw;
  assert.throws(() => decodeCallerHistory(sel, missing), /CALLER_RAW_MEMBERSHIP/);
  assert.throws(() => decodeCallerHistory(sel, artifacts(sel, [a], { [k('fxtwitter')]: { request: 'https://api.fxtwitter.com/other/status/1' } })), /CALLER_RECEIPT_BINDING/);
  assert.throws(() => decodeCallerHistory(sel, artifacts(sel, [a], { [k('fxtwitter')]: { retrievedAt: '2026-10-10T00:00:00.000Z' } })), /CALLER_CLOCK_ORDER/);
  assert.throws(() => decodeCallerHistory(sel, artifacts(sel, [a], { [k('fxtwitter')]: { status: null } })), /CALLER_RECEIPT_INVALID/);
  const moved = callerHistoryRequests(sel)[k('oembed')]!.url.replace('https://publish.twitter.com/', 'https://publish.x.com/');
  assert.equal(decodeCallerHistory(sel, artifacts(sel, [a], { [k('oembed')]: { finalUrl: moved } })).layers[0]!.oembed, 'AGREES');
  assert.throws(() => decodeCallerHistory(sel, artifacts(sel, [a], { [k('oembed')]: { finalUrl: 'https://elsewhere.example/oembed' } })), /CALLER_REDIRECT_BINDING/);
  assert.throws(() => decodeCallerHistory(sel, artifacts(sel, [a], { [k('syndication')]: { finalUrl: moved } })), /CALLER_REDIRECT_BINDING/);
});

test('collector issues bounded reads, retains exact receipts and replays offline; budget and size failures stay explicit', async () => {
  const a = legacy('alpha_caller', A_AT), b = note('colony_project', N_AT), specs = [a, b], sel = selection(specs), seen: string[] = [];
  const provider = (url: string): CallerProvider => url.startsWith('https://publish.twitter.com/') ? 'oembed' : url.startsWith('https://cdn.syndication.twimg.com/') ? 'syndication' : 'fxtwitter';
  const fetcher = (async (input: unknown) => { const url = String(input); seen.push(url); const spec = specs.find(s => url.includes(s.id))!;
    return new Response(JSON.stringify(spec[provider(url)]), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  const run = await collectCallerHistory(sel, fetcher, () => RETRIEVED);
  assert.equal(seen.length, 6); assert.deepEqual(Object.keys(run.rawArtifacts).sort(), Object.keys(run.requests).sort());
  assert.equal(run.data.complete, true); assert.deepEqual(decodeCallerHistory(sel, run.rawArtifacts), run.data);
  const receipt = JSON.parse(run.rawArtifacts[callerHistoryKey(a.id, 'fxtwitter')]!);
  assert.equal(receipt.finalUrl, receipt.request); assert.equal(receipt.body, JSON.stringify(a.fxtwitter)); assert.equal(receipt.retrievedAt, RETRIEVED);
  const big = await collectCallerHistory(selection([a]), (async (input: unknown) => { const url = String(input);
    return new Response(provider(url) === 'fxtwitter' ? 'x'.repeat(500_001) : JSON.stringify(a[provider(url)]), { status: 200 }); }) as typeof fetch, () => RETRIEVED);
  assert.equal(JSON.parse(big.rawArtifacts[callerHistoryKey(a.id, 'fxtwitter')]!).code, 'CALLER_BODY_LIMIT');
  assert.equal(big.data.layers[0]!.failure, 'CALLER_FX_UNAVAILABLE');
  const controller = new AbortController(); controller.abort(); seen.length = 0;
  const stopped = await collectCallerHistory(sel, fetcher, () => RETRIEVED, controller.signal);
  assert.equal(seen.length, 0); assert.equal(stopped.data.complete, false);
  assert.ok(Object.values(stopped.rawArtifacts).every(raw => JSON.parse(raw).code === 'CALLER_BUDGET'));
  assert.ok(stopped.data.layers.every(l => l.failure === 'CALLER_OFFICIAL_UNAVAILABLE'));
});
