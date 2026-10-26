import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CaptureInvalid, boundTextSchema, containsMint, frozenQuery, reconstructXStream, sha256, xPageSchema,
  type BoundText, type FrozenQuery, type XPage, type XStream,
} from '../src/providers/advisory-saturation.js';

// Portable synthetic receipts: fake handles and author ids, snowflake ids bound to their UTC created_at, and the
// genuine SearchTimeline nesting. Bodies are re-serialized and re-hashed at build time, so every semantic mutation
// of the fixture objects reaches the decoder with exact UTF-8 bytes and sha256.
const MINT = 'Fx7aMintTestTokenQZ9xYk3vR2pW8nHc4sJpump';
const CONTROL_MINT = 'Ctr1MintFixtureQZ9xYk3vR2pW8nHc4sJxYz';
const QUERY = `${MINT} since:2026-10-25 until:2026-10-26`;
const OP = 'Fx0pSearchTL_01';
const AUTHOR = { a: '1000000000000000001', b: '1000000002', c: '1000000003', d: '1000000004', e: '1000000005' };
const TOP_ROW = 'cursor-top-9223372036854775807';
const BOTTOM_ROW = 'cursor-bottom-0';
const START = Date.parse('2026-10-25T16:53:28.363Z');
const STEP = 13_897;
const DURATION = 300;
const SETTLE = 19_457;
const END_RULE = 'OBSERVED_X_CLIENT_STREAM_EXHAUSTED_V1';
const W0 = { start: '2026-10-25T07:19:20.000Z', end: '2026-10-25T11:37:06.000Z' };
const W1 = { start: '2026-10-25T11:37:06.000Z', end: '2026-10-25T15:54:52.000Z' };
const NOTE = 'Longform thesis on liquidity rotation, holder distribution and launch cadence. '.repeat(8)
  + `Contract for reference: ${MINT} - verify independently before acting.`;

function scope(edit: (s: any) => void = () => {}): string {
  const windows = () => ({ previous: { ...W0 }, current: { ...W1 }, durationSeconds: 15466, boundaryConvention: 'HALF_OPEN' });
  const s: any = {
    kind: 'A24_AUTHENTICATED_QUERY_CAPTURE_SCOPE_V1',
    frozenAt: '2026-10-25T16:40:00.000000+00:00',
    measurementKind: 'observed authenticated X Latest query-result sample, not all X posts',
    acquisition: 'CHROME_DEVTOOLS_FILTERED_SANITIZED_RESPONSE_EXPORT',
    access: 'existing user-controlled Chrome X session, read-only',
    queries: [
      { label: 'FIXTURE', mint: MINT, query: QUERY, product: 'Latest', count: 20, querySource: 'typed_query', windows: windows() },
      { label: 'CONTROL', mint: CONTROL_MINT, query: `${CONTROL_MINT} since:2026-10-25 until:2026-10-26`, product: 'Latest', count: 20, querySource: 'typed_query', windows: windows() },
    ],
    limitsPerToken: { timelinePages: 20, detailPages: 40, captureWallSeconds: 900, retainedBytes: 8_388_608, perResponseBytes: 500_000, cursorRetries: 1 },
    knownClaim: false,
  };
  edit(s);
  return JSON.stringify(s, null, 2);
}
const Q: FrozenQuery = frozenQuery(scope(), MINT);

function xTime(iso: string): string {
  const [weekday, day, month, year, clock] = new Date(iso).toUTCString().replace(',', '').split(' ');
  return `${weekday} ${month} ${day} ${clock} +0000 ${year}`;
}
const snowflake = (iso: string, seq: number) => (((BigInt(Date.parse(iso)) + 123n - 1288834974657n) << 22n) + BigInt(seq)).toString();

function tweet(p: { at: string; seq: number; author?: string; handle?: string; text: string; note?: string }): any {
  const id = snowflake(p.at, p.seq), author = p.author ?? AUTHOR.a;
  const t: any = {
    __typename: 'Tweet', rest_id: id,
    core: { user_results: { result: { __typename: 'User', rest_id: author, core: { screen_name: p.handle ?? 'fixture_alpha', name: 'Fixture Account', created_at: 'Tue Mar 01 10:00:00 +0000 2022' }, legacy: { followers_count: 120 } } } },
    edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(p.at) + 3_600_000), is_edit_eligible: true, edits_remaining: '5' },
    is_translatable: false, views: { state: 'Enabled' }, source: 'Fixture Web App',
    legacy: {
      bookmark_count: 0, conversation_id_str: id, created_at: xTime(p.at), display_text_range: [0, [...p.text].length],
      entities: { hashtags: [], symbols: [], urls: [], user_mentions: [] }, favorite_count: 1, full_text: p.text, id_str: id,
      is_quote_status: false, lang: 'en', reply_count: 0, retweet_count: 0, user_id_str: author,
    },
  };
  if (p.note !== undefined) t.note_tweet = { is_expandable: true, note_tweet_results: { result: { id: `Tm90ZVR3ZWV0Fx${p.seq}`, text: p.note, entity_set: { hashtags: [], symbols: [], urls: [], user_mentions: [] } } } };
  return t;
}
const item = (t: any) => ({
  entryId: `tweet-${t.rest_id}`, sortIndex: t.rest_id,
  content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: t }, tweetDisplayType: 'Tweet' }, clientEventInfo: { component: 'result', element: 'tweet' } },
});
const cursorValue = (type: 'Top' | 'Bottom', k: number) => `DAADDAABCgABHVe3qAUXwEEKAAIdVto61tthvwAIAAIAAAA${type === 'Top' ? 'B' : 'C'}CAADAAAAAAgABAAAAA${String(k).padStart(2, '0')}KAAUdV9KJrAAnEAo`;
const cursorEntry = (type: 'Top' | 'Bottom', value: string) => ({
  entryId: type === 'Top' ? TOP_ROW : BOTTOM_ROW, sortIndex: type === 'Top' ? '9223372036854775807' : '0',
  content: { entryType: 'TimelineTimelineCursor', __typename: 'TimelineTimelineCursor', value, cursorType: type },
});
const timeline = (instructions: any[]) => ({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } });
const addDoc = (tweets: any[], k: number) => timeline([{ type: 'TimelineAddEntries', entries: [...tweets.map(item), cursorEntry('Top', cursorValue('Top', k)), cursorEntry('Bottom', cursorValue('Bottom', k))] }]);
const terminalDoc = (k: number) => timeline([
  { type: 'TimelineReplaceEntry', entry_id_to_replace: TOP_ROW, entry: cursorEntry('Top', cursorValue('Top', k)) },
  { type: 'TimelineReplaceEntry', entry_id_to_replace: BOTTOM_ROW, entry: cursorEntry('Bottom', cursorValue('Bottom', k)) },
]);
const instructions = (doc: any): any[] => doc.data.search_by_raw_query.search_timeline.timeline.instructions;
const entries = (doc: any): any[] => instructions(doc)[0].entries;
function bottomContent(doc: any): any {
  for (const i of instructions(doc)) for (const e of i.entries ?? [i.entry]) if (e?.content?.cursorType === 'Bottom') return e.content;
  throw new Error('fixture has no Bottom cursor');
}

type PageSpec = { doc: any; cursor?: string; startedAt: string; durationMs: number; variables: Record<string, unknown>; features: Record<string, unknown>; op: string; rewrite?: (url: URL) => void };
type Fixture = { pages: PageSpec[]; ui: unknown[] };
const settleAt = (n: number) => new Date(START + (n - 1) * STEP + SETTLE).toISOString();
const legacyUi = (n: number, edit: Record<string, unknown> = {}) => ({
  source: 'NATIVE_CHROME_AX_OBSERVATION', observedAt: settleAt(n).replace('Z', '177+00:00'), query: QUERY, selectedTab: 'Neueste',
  afterDownScrollPages: 5, networkFilteredRequestCountBefore: n, networkFilteredRequestCountAfter: n, loadingOrErrorObserved: false,
  visiblePrimaryRows: 3, complete: false, note: 'Fixture contemporaneous UI observation after recorded XHRs; not an X-wide census.', ...edit,
});
const finalUi = (n: number, edit: Record<string, unknown> = {}) => ({
  kind: 'NATIVE_CHROME_CLIENT_END_OBSERVATION_V1', observedAt: settleAt(n), query: QUERY, selected: 'Neueste', downScrollPages: [12, 5],
  filteredRequestsAfterFirst: n, filteredRequestsAfterSecond: n, loadingOrErrorObserved: false, lastVisiblePrimaryAuthor: 'fixture_alpha',
  known: false, source: `Fixture native AX observation; after first down12 requests ${n}, after additional down5 requests ${n}.`, ...edit,
});
function spec(doc: any, k: number): PageSpec {
  return {
    doc, cursor: k === 0 ? undefined : cursorValue('Bottom', k - 1), startedAt: new Date(START + k * STEP).toISOString(), durationMs: DURATION,
    variables: { rawQuery: QUERY, count: 20, querySource: 'typed_query', product: 'Latest', withGrokTranslatedBio: false },
    features: { rweb_video_screen_enabled: false, longform_notetweets_consumption_enabled: true, responsive_web_edit_tweet_api_enabled: true }, op: OP,
  };
}
function fixture(tweetPages: any[][], terminal = true): Fixture {
  const pages = tweetPages.map((tweets, k) => spec(addDoc(tweets, k), k));
  if (terminal) pages.push(spec(terminalDoc(pages.length), pages.length));
  return { pages, ui: [legacyUi(pages.length)] };
}
function urlOf(p: PageSpec): string {
  const u = new URL(`https://x.com/i/api/graphql/${p.op}/SearchTimeline`);
  u.searchParams.set('variables', JSON.stringify(p.cursor === undefined ? p.variables : { ...p.variables, cursor: p.cursor }));
  u.searchParams.set('features', JSON.stringify(p.features));
  p.rewrite?.(u);
  return u.toString();
}
const bound = (raw: string): BoundText => boundTextSchema.parse({ raw, sha256: sha256(raw), bytes: Buffer.byteLength(raw, 'utf8') });
const pagesOf = (f: Fixture): XPage[] => f.pages.map(p => xPageSchema.parse({ method: 'GET', url: urlOf(p), httpStatus: 200, startedAt: p.startedAt, durationMs: p.durationMs, body: bound(JSON.stringify(p.doc)) }));
const obsOf = (f: Fixture): BoundText[] => f.ui.map(u => bound(typeof u === 'string' ? u : JSON.stringify(u)));
const run = (f: Fixture): XStream => reconstructXStream(pagesOf(f), obsOf(f), Q, MINT);

function corpus() {
  const link = tweet({ at: '2026-10-25T14:10:09Z', seq: 3, author: AUTHOR.c, handle: 'fixture_gamma', text: 'Launch board update https://t.co/FxCard0001' });
  link.legacy.entities.urls = [{ url: 'https://t.co/FxCard0001', expanded_url: `https://pump.fun/coin/${MINT}`, display_url: 'pump.fun/coin/Fx7aMint…', indices: [20, 43] }];
  link.card = { rest_id: 'card://1000000000000000099', legacy: { name: 'summary_large_image', url: 'https://t.co/FxCard0001', binding_values: [{ key: 'title', value: { type: 'STRING', string_value: `Fixture token ${MINT}` } }] } };
  return {
    plain: tweet({ at: '2026-10-25T13:05:11Z', seq: 1, author: AUTHOR.a, handle: 'fixture_alpha', text: `Early look at ${MINT}, chart forming https://t.co/FxPlain001` }),
    note: tweet({ at: '2026-10-25T11:56:35Z', seq: 2, author: AUTHOR.b, handle: 'fixture_beta', text: `${NOTE.slice(0, 272)}… https://t.co/FxNote0001`, note: NOTE }),
    link,
    w0: tweet({ at: '2026-10-25T09:14:27Z', seq: 4, author: AUTHOR.b, handle: 'fixture_beta', text: `${MINT} still building quietly.` }),
  };
}
function fresh() {
  const c = corpus();
  return { c, f: fixture([Object.values(c)]) };
}

/** Accepts only a CaptureInvalid rejection or an explicit non-complete stream; any other runtime error fails. */
function failClosed(label: string, attempt: () => XStream): void {
  let out: XStream | undefined;
  try { out = attempt(); } catch (error) {
    assert.ok(error instanceof CaptureInvalid, `${label}: expected CaptureInvalid, got ${String(error)}`);
    return;
  }
  assert.ok(out);
  assert.notEqual(out.status, 'COMPLETE', `${label}: certified COMPLETE`);
  assert.equal(out.endRule, null, `${label}: end rule without completion`);
  assert.ok(out.reasonCode, `${label}: incomplete without reason`);
}
function truncated(label: string, attempt: () => XStream): void {
  let out: XStream | undefined;
  try { out = attempt(); } catch (error) {
    assert.ok(error instanceof CaptureInvalid, `${label}: expected CaptureInvalid, got ${String(error)}`);
    return;
  }
  assert.ok(out);
  assert.equal(out.status, 'TRUNCATED', label);
  assert.equal(out.endRule, null, label);
}
const rejects = (label: string, attempt: () => unknown) => assert.throws(attempt, (e: unknown) => e instanceof CaptureInvalid, label);
function complete(s: XStream): XStream {
  assert.equal(s.status, 'COMPLETE', s.reasonCode ?? '');
  assert.equal(s.reasonCode, null);
  assert.equal(s.endRule, END_RULE);
  return s;
}
function byId(s: XStream, id: string) {
  const p = s.posts.find(x => x.postId === id);
  assert.ok(p, `post ${id} missing`);
  return p;
}

test('frozenQuery binds the single declared row and rejects altered scopes', () => {
  assert.deepEqual(Q, { query: QUERY, w0: W0, w1: W1, durationMs: 15_466_000, frozenAt: '2026-10-25T16:40:00.000000+00:00' });
  const edits: Array<[string, (s: any) => void]> = [
    ['known claim', s => { s.knownClaim = true; }],
    ['limits changed', s => { s.limitsPerToken.timelinePages = 21; }],
    ['acquisition relabelled', s => { s.acquisition = 'TINYFISH_FETCH'; }],
    ['duplicate mint row', s => { s.queries.push(structuredClone(s.queries[0])); }],
    ['product not Latest', s => { s.queries[0].product = 'Top'; }],
    ['query lacks bounded mint', s => { s.queries[0].query = `X${QUERY}`; }],
    ['windows not adjacent', s => { s.queries[0].windows.previous.end = '2026-10-25T11:37:05.000Z'; }],
    ['unequal declared duration', s => { s.queries[0].windows.durationSeconds = 15467; }],
    ['not half-open', s => { s.queries[0].windows.boundaryConvention = 'CLOSED'; }],
  ];
  for (const [label, edit] of edits) rejects(label, () => frozenQuery(scope(edit), MINT));
  rejects('unparseable scope', () => frozenQuery('{', MINT));
  rejects('mint without a row', () => frozenQuery(scope(), 'Zz9MintAbsentQZ9xYk3vR2pW8nHc4sJxYzpump'));
});

test('xPageSchema owns transport typing and status at ingress', () => {
  const valid = { method: 'GET', url: urlOf(fresh().f.pages[0]!), httpStatus: 200, startedAt: '2026-10-25T16:53:28.363Z', durationMs: 640, body: bound('{}') };
  assert.equal(xPageSchema.safeParse(valid).success, true);
  const variants: Array<[string, unknown]> = [
    ['rate limited', { ...valid, httpStatus: 429 }], ['POST', { ...valid, method: 'POST' }],
    ['instant without offset', { ...valid, startedAt: '2026-10-25T16:53:28.363' }], ['negative duration', { ...valid, durationMs: -1 }],
    ['duration above wall', { ...valid, durationMs: 900_001 }], ['request headers retained', { ...valid, requestHeaders: [] }],
    ['uppercase hash', { ...valid, body: { ...valid.body, sha256: valid.body.sha256.toUpperCase() } }],
    ['negative bytes', { ...valid, body: { ...valid.body, bytes: -1 } }], ['extra body key', { ...valid, body: { ...valid.body, encoding: 'gzip' } }],
    ['empty url', { ...valid, url: '' }],
  ];
  for (const [label, page] of variants) assert.equal(xPageSchema.safeParse(page).success, false, label);
});

test('old native control UI receipt completes the delivered stream with exact posts and no A24 claim', () => {
  const { c, f } = fresh();
  const s = complete(run(f));
  assert.equal(s.pages, 2);
  assert.equal(s.operation, OP);
  assert.equal(s.startedAt, '2026-10-25T16:53:28.363Z');
  assert.equal(s.lastResponseAt, '2026-10-25T16:53:42.560Z');
  assert.deepEqual(s.posts.map(p => p.postId).sort(), Object.values(c).map(t => t.rest_id).sort());
  const expected = [
    { t: c.plain, authorId: AUTHOR.a, createdAt: '2026-10-25T13:05:11.000Z', body: c.plain.legacy.full_text, bodySource: 'LEGACY', binds: true },
    { t: c.note, authorId: AUTHOR.b, createdAt: '2026-10-25T11:56:35.000Z', body: NOTE, bodySource: 'NOTE', binds: true },
    { t: c.link, authorId: AUTHOR.c, createdAt: '2026-10-25T14:10:09.000Z', body: c.link.legacy.full_text, bodySource: 'LEGACY', binds: false },
    { t: c.w0, authorId: AUTHOR.b, createdAt: '2026-10-25T09:14:27.000Z', body: c.w0.legacy.full_text, bodySource: 'LEGACY', binds: true },
  ];
  for (const e of expected) {
    const p = byId(s, e.t.rest_id);
    assert.deepEqual(
      { authorId: p.authorId, createdAt: p.createdAt, role: p.role, revision: p.revision, body: p.body, bodySource: p.bodySource, bodySha256: p.bodySha256, bodyBindsMint: p.bodyBindsMint },
      { authorId: e.authorId, createdAt: e.createdAt, role: 'ORIGINAL', revision: 'SINGLE', body: e.body, bodySource: e.bodySource, bodySha256: sha256(e.body), bodyBindsMint: e.binds },
    );
  }
  assert.equal(s.witness?.rawSha256, sha256(JSON.stringify(f.ui[0])));
  for (const key of ['known', 'quality', 'a24', 'complete']) assert.equal(key in s, false, key);
});

test('new final native client-end receipt certifies the same stream', () => {
  const { f } = fresh();
  f.ui = [finalUi(2)];
  const s = complete(run(f));
  assert.ok(s.witness);
  assert.equal(s.witness.rawSha256, sha256(JSON.stringify(f.ui[0])));
});

test('settled UI must be observed at or after the last response completed', () => {
  const exact = fresh().f;
  exact.ui = [legacyUi(2, { observedAt: '2026-10-25T16:53:42.560000+00:00' })];
  complete(run(exact));
  const early: Array<[string, unknown]> = [
    ['old receipt 1ms before completion', legacyUi(2, { observedAt: '2026-10-25T16:53:42.559000+00:00' })],
    ['old receipt before last request', legacyUi(2, { observedAt: '2026-10-25T16:53:30.000000+00:00' })],
    ['final receipt during last response', finalUi(2, { observedAt: '2026-10-25T16:53:42.400Z' })],
  ];
  for (const [label, ui] of early) {
    const f = fresh().f;
    f.ui = [ui];
    failClosed(label, () => run(f));
  }
});

test('a stream without the terminal continuation stays explicitly incomplete', () => {
  failClosed('single AddEntries page', () => run(fixture([Object.values(corpus())], false)));
  failClosed('second page still adds entries', () => run(fixture([Object.values(corpus()), []], false)));
});

test('full note is the body over truncated legacy text, including genuine legacy.truncated', () => {
  for (const legacyTruncated of [false, true]) {
    const { c, f } = fresh();
    if (legacyTruncated) c.note.legacy.truncated = true;
    const p = byId(complete(run(f)), c.note.rest_id);
    assert.deepEqual({ body: p.body, bodySource: p.bodySource, bodySha256: p.bodySha256, bodyBindsMint: p.bodyBindsMint }, { body: NOTE, bodySource: 'NOTE', bodySha256: sha256(NOTE), bodyBindsMint: true });
    assert.equal(containsMint(c.note.legacy.full_text, MINT), false, 'fixture: mint only in the full note');
  }
});

test('legacy.truncated without a full note fails closed and is never complete-eligible', () => {
  for (const text of [`Early look at ${MINT}, chart forming and more context follows… https://t.co/FxPlain001`, 'Early look at a new chart, the contract is in the rest of this… https://t.co/FxPlain001']) {
    const { c, f } = fresh();
    c.plain.legacy.truncated = true;
    c.plain.legacy.full_text = text;
    failClosed(`truncated legacy: ${text.slice(0, 24)}`, () => run(f));
  }
});

test('missing or contradictory author, identity, time, body or edit evidence rejects', () => {
  const cases: Array<[string, (t: any) => void]> = [
    ['author result missing', t => { delete t.core.user_results.result; }],
    ['author unavailable', t => { t.core.user_results.result.__typename = 'UserUnavailable'; }],
    ['legacy author differs from stable author', t => { t.legacy.user_id_str = AUTHOR.e; }],
    ['handle missing', t => { delete t.core.user_results.result.core.screen_name; }],
    ['legacy id differs from rest_id', t => { t.legacy.id_str = snowflake('2026-10-25T13:05:11Z', 99); }],
    ['created_at missing', t => { delete t.legacy.created_at; }],
    ['created_at contradicts snowflake', t => { t.legacy.created_at = xTime('2026-10-25T14:05:11Z'); }],
    ['created_at not X format', t => { t.legacy.created_at = '2026-10-25T13:05:11Z'; }],
    ['created_at wrong weekday', t => { t.legacy.created_at = t.legacy.created_at.replace('Sun', 'Mon'); }],
    ['legacy body missing', t => { delete t.legacy.full_text; }],
    ['note referenced without text', t => { t.note_tweet = { is_expandable: true, note_tweet_results: {} }; }],
    ['empty note text', t => { t.note_tweet = { is_expandable: true, note_tweet_results: { result: { text: '' } } }; }],
    ['edit control missing', t => { delete t.edit_control; }],
    ['empty edit family', t => { t.edit_control.edit_tweet_ids = []; }],
    ['non-numeric edit id', t => { t.edit_control.edit_tweet_ids = ['not-an-id']; }],
  ];
  for (const [label, mutate] of cases) {
    const { c, f } = fresh();
    mutate(c.plain);
    failClosed(label, () => run(f));
  }
});

test('observed multi-revision edit families stay AMBIGUOUS, never fabricated SINGLE', () => {
  const { c, f } = fresh();
  c.plain.edit_control.edit_tweet_ids = [c.plain.rest_id, snowflake('2026-10-25T13:09:00Z', 21)];
  c.w0.edit_control.edit_tweet_ids = [snowflake('2026-10-25T09:10:00Z', 22), c.w0.rest_id];
  const s = run(f);
  assert.equal(byId(s, c.plain.rest_id).revision, 'AMBIGUOUS');
  assert.equal(byId(s, c.w0.rest_id).revision, 'AMBIGUOUS');
  assert.equal(byId(s, c.note.rest_id).revision, 'SINGLE');
});

test('mint binding is exact, case-sensitive and base58-bounded in the own body', () => {
  const bodies: Array<[string, boolean]> = [
    [MINT, true], [`CA: ${MINT}.`, true], [`(${MINT})`, true], [`$${MINT}!`, true], [`A${MINT} vs (${MINT})`, true],
    [`A${MINT}`, false], [`${MINT}2`, false], [`${MINT.charAt(0).toLowerCase()}${MINT.slice(1)}`, false], [`${MINT.slice(0, -1)} soon`, false], ['no contract here', false],
  ];
  const tweets = bodies.map(([text], i) => tweet({ at: `2026-10-25T12:${String(10 + i).padStart(2, '0')}:00Z`, seq: 30 + i, text }));
  const s = complete(run(fixture([tweets])));
  bodies.forEach(([text, binds], i) => {
    assert.equal(byId(s, tweets[i].rest_id).bodyBindsMint, binds, text);
    assert.equal(containsMint(text, MINT), binds, text);
  });
});

test('link- or card-only mint matches stay unbound', () => {
  const { c, f } = fresh();
  assert.equal(containsMint(JSON.stringify(c.link), MINT), true, 'fixture: mint present in url entity and card');
  const p = byId(complete(run(f)), c.link.rest_id);
  assert.equal(p.bodyBindsMint, false);
  assert.equal(p.body, 'Launch board update https://t.co/FxCard0001');
});

test('nested quoted bodies never become primaries; own commentary stays primary', () => {
  const c = corpus();
  const quoted = tweet({ at: '2026-10-25T10:02:00Z', seq: 40, author: AUTHOR.c, handle: 'fixture_gamma', text: `Original call ${MINT}` });
  const quote = tweet({ at: '2026-10-25T12:40:00Z', seq: 41, author: AUTHOR.d, handle: 'fixture_delta', text: 'This aged well https://t.co/FxQuote001' });
  const own = tweet({ at: '2026-10-25T12:45:00Z', seq: 42, author: AUTHOR.e, handle: 'fixture_epsilon', text: `Adding ${MINT} to my list https://t.co/FxQuote002` });
  for (const t of [quote, own]) {
    t.legacy.is_quote_status = true;
    t.legacy.quoted_status_id_str = quoted.rest_id;
    t.quoted_status_result = { result: structuredClone(quoted) };
  }
  const s = complete(run(fixture([[...Object.values(c), quote, own]])));
  assert.equal(s.posts.length, 6);
  assert.equal(s.posts.some(p => p.postId === quoted.rest_id), false);
  const q = byId(s, quote.rest_id), o = byId(s, own.rest_id);
  assert.deepEqual({ role: q.role, body: q.body, binds: q.bodyBindsMint }, { role: 'COMMENTARY', body: quote.legacy.full_text, binds: false });
  assert.deepEqual({ role: o.role, body: o.body, binds: o.bodyBindsMint }, { role: 'COMMENTARY', body: own.legacy.full_text, binds: true });
});

test('reposts remain labelled REPOST and never surface the reposted original', () => {
  const c = corpus();
  const original = tweet({ at: '2026-10-25T12:00:01Z', seq: 50, author: AUTHOR.c, handle: 'fixture_gamma', text: `Fresh entry ${MINT}` });
  const repost = tweet({ at: '2026-10-25T12:30:00Z', seq: 51, author: AUTHOR.d, handle: 'fixture_delta', text: `RT @fixture_gamma: Fresh entry ${MINT}` });
  repost.legacy.retweeted_status_result = { result: original };
  const s = complete(run(fixture([[...Object.values(c), repost]])));
  assert.equal(byId(s, repost.rest_id).role, 'REPOST');
  assert.equal(s.posts.some(p => p.postId === original.rest_id), false);
});

test('stable author ids survive handle changes and distinct ids stay distinct posts', () => {
  const c = corpus();
  const second = tweet({ at: '2026-10-25T13:20:00Z', seq: 60, author: AUTHOR.a, handle: 'fixture_alpha_renamed', text: `Second note on ${MINT}` });
  const again = structuredClone(c.plain);
  again.core.user_results.result.core.screen_name = 'fixture_alpha_renamed';
  const s = complete(run(fixture([Object.values(c), [second, again]])));
  assert.equal(s.posts.length, 5);
  assert.equal(byId(s, c.plain.rest_id).authorId, AUTHOR.a);
  assert.equal(byId(s, second.rest_id).authorId, AUTHOR.a);
  assert.notEqual(c.plain.rest_id, second.rest_id);
});

test('repeated identical evidence deduplicates; conflicting evidence for one id rejects', () => {
  const same = corpus();
  assert.equal(complete(run(fixture([Object.values(same), [structuredClone(same.plain), structuredClone(same.note)]]))).posts.length, 4);
  const conflicts: Array<[string, (t: any) => void]> = [
    ['body differs', t => { t.legacy.full_text = `Edited view on ${MINT}`; }],
    ['author differs', t => { t.core.user_results.result.rest_id = AUTHOR.e; t.legacy.user_id_str = AUTHOR.e; }],
    ['note differs', t => { t.note_tweet = { is_expandable: true, note_tweet_results: { result: { text: `${NOTE} Update.` } } }; }],
  ];
  for (const [label, mutate] of conflicts) {
    const c = corpus(), repeat = structuredClone(c.plain);
    mutate(repeat);
    failClosed(label, () => run(fixture([Object.values(c), [repeat]])));
  }
});

test('unsupported entries, modules, instructions, errors and tombstones never yield a silent sample', () => {
  const module = { entryId: 'toptabsrpusermodule-1886000000000000000', sortIndex: '1886000000000000000', content: { entryType: 'TimelineTimelineModule', __typename: 'TimelineTimelineModule', displayType: 'Vertical', items: [{ entryId: 'toptabsrpusermodule-1886000000000000000-user-1000000009', item: { itemContent: { itemType: 'TimelineUser', __typename: 'TimelineUser', user_results: { result: { __typename: 'User', rest_id: '1000000009' } } } } }] } };
  const tombstone = { entryId: 'tweet-1886000000000000001', sortIndex: '1886000000000000001', content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: { __typename: 'TweetTombstone', tombstone: { __typename: 'TextTombstone', text: { text: 'This post is unavailable.' } } } } } } };
  const userItem = { entryId: 'user-1000000009', sortIndex: '1886000000000000002', content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', __typename: 'TimelineUser', user_results: { result: { __typename: 'User', rest_id: '1000000009' } } } } };
  const variants: Array<[string, (doc: any, c: any) => void]> = [
    ['module entry', d => { entries(d).unshift(structuredClone(module)); }],
    ['tombstone item', d => { entries(d).unshift(structuredClone(tombstone)); }],
    ['user item', d => { entries(d).unshift(structuredClone(userItem)); }],
    ['only unsupported entries', d => { instructions(d)[0].entries = [structuredClone(module), ...entries(d).filter((e: any) => e.content.cursorType)]; }],
    ['pin instruction', (d, c) => { instructions(d).push({ type: 'TimelinePinEntry', entry: item(c.plain) }); }],
    ['terminate instruction', d => { instructions(d).push({ type: 'TimelineTerminateTimeline', direction: 'Top' }); }],
    ['clear cache instruction', d => { instructions(d).unshift({ type: 'TimelineClearCache' }); }],
    ['errors beside data', d => { d.errors = [{ message: 'Fixture partial failure', code: 131 }]; }],
  ];
  for (const [label, mutate] of variants) {
    const { c, f } = fresh();
    mutate(f.pages[0]!.doc, c);
    failClosed(label, () => run(f));
  }
});

test('query, Latest, count, querySource, features and operation stay fixed; cursor consumes previous Bottom', () => {
  const p = (f: Fixture, k: number) => f.pages[k]!;
  const variants: Array<[string, (f: Fixture) => void]> = [
    ['rawQuery drift', f => { p(f, 1).variables.rawQuery = `${MINT} since:2026-10-24 until:2026-10-26`; }],
    ['product drift', f => { p(f, 1).variables.product = 'Top'; }],
    ['count drift', f => { p(f, 1).variables.count = 40; }],
    ['querySource drift', f => { p(f, 1).variables.querySource = 'recent_search_click'; }],
    ['features drift', f => { p(f, 1).features.rweb_video_screen_enabled = true; }],
    ['operation drift', f => { p(f, 1).op = 'Fx0pOtherOp_02'; }],
    ['cursor is previous Top', f => { p(f, 1).cursor = cursorValue('Top', 0); }],
    ['cursor altered', f => { p(f, 1).cursor = `${cursorValue('Bottom', 0)}A`; }],
    ['cursor missing', f => { p(f, 1).cursor = undefined; }],
    ['first page carries a cursor', f => { p(f, 0).cursor = cursorValue('Bottom', 9); }],
    ['pages consistently not the frozen query', f => { for (const x of f.pages) x.variables.rawQuery = MINT; }],
    ['other host', f => { p(f, 1).rewrite = u => { u.host = 'twitter.com'; }; }],
    ['extra url parameter', f => { p(f, 0).rewrite = u => { u.searchParams.set('fieldToggles', '{}'); }; }],
    ['plain http', f => { p(f, 1).rewrite = u => { u.protocol = 'http:'; }; }],
  ];
  for (const [label, mutate] of variants) {
    const { f } = fresh();
    mutate(f);
    failClosed(label, () => run(f));
  }
});

test('terminal page is exactly two proper Top/Bottom cursor replacements', () => {
  const variants: Array<[string, (doc: any, c: any) => void]> = [
    ['empty AddEntries beside replacements', d => { instructions(d).push({ type: 'TimelineAddEntries', entries: [] }); }],
    ['item replacement', (d, c) => { instructions(d).push({ type: 'TimelineReplaceEntry', entry_id_to_replace: `tweet-${c.plain.rest_id}`, entry: item(c.plain) }); }],
    ['Top replacement missing', d => { instructions(d).splice(0, 1); }],
    ['duplicate Bottom replacement', d => { instructions(d).push(structuredClone(instructions(d)[1])); }],
    ['entryId differs from replaced id', d => { instructions(d)[0].entry.entryId = 'cursor-top-1886000000000000000'; }],
    ['errors beside replacements', d => { d.errors = [{ message: 'Rate limit exceeded', code: 88 }]; }],
    ['terminate instruction added', d => { instructions(d).push({ type: 'TimelineTerminateTimeline', direction: 'Bottom' }); }],
    ['non Top/Bottom cursor', d => { instructions(d)[1].entry.content.cursorType = 'Gap'; }],
    ['empty cursor value', d => { instructions(d)[1].entry.content.value = ''; }],
    ['cursor rows re-added instead of replaced', d => { const rows = instructions(d).map((i: any) => i.entry); instructions(d).splice(0, 2, { type: 'TimelineAddEntries', entries: rows }); }],
  ];
  for (const [label, mutate] of variants) {
    const { c, f } = fresh();
    mutate(f.pages[1]!.doc, c);
    failClosed(label, () => run(f));
  }
});

test('terminal replacements must target the prior page Top/Bottom row identities', () => {
  const variants: Array<[string, (doc: any) => void]> = [
    ['foreign Bottom row', d => { const r = instructions(d)[1]; r.entry_id_to_replace = r.entry.entryId = 'cursor-bottom-1886000000000000777'; }],
    ['foreign Top row', d => { const r = instructions(d)[0]; r.entry_id_to_replace = r.entry.entryId = 'cursor-top-1886000000000000777'; }],
    ['Top and Bottom rows swapped', d => { const [top, bottom] = instructions(d); top.entry_id_to_replace = top.entry.entryId = BOTTOM_ROW; bottom.entry_id_to_replace = bottom.entry.entryId = TOP_ROW; }],
  ];
  for (const [label, mutate] of variants) {
    const { f } = fresh();
    mutate(f.pages[1]!.doc);
    failClosed(label, () => run(f));
  }
});

test('returned Bottom never repeats or loops an earlier Bottom, terminal included', () => {
  const consumed = fresh().f;
  bottomContent(consumed.pages[1]!.doc).value = cursorValue('Bottom', 0);
  failClosed('terminal returns the consumed Bottom', () => run(consumed));
  const extra = () => [tweet({ at: '2026-10-25T08:00:00Z', seq: 70, author: AUTHOR.d, handle: 'fixture_delta', text: `Backlog ${MINT}` })];
  const loop = fixture([Object.values(corpus()), extra()]);
  bottomContent(loop.pages[1]!.doc).value = cursorValue('Bottom', 0);
  loop.pages[2]!.cursor = cursorValue('Bottom', 0);
  failClosed('middle page repeats Bottom and the chain follows it', () => run(loop));
  const earlier = fixture([Object.values(corpus()), extra()]);
  bottomContent(earlier.pages[2]!.doc).value = cursorValue('Bottom', 0);
  failClosed('terminal returns a non-adjacent earlier Bottom', () => run(earlier));
});

test('page starts are monotonic and nothing follows the terminal page', () => {
  const back = fresh().f;
  back.pages[1]!.startedAt = '2026-10-25T16:53:20.000Z';
  failClosed('continuation started before first page', () => run(back));
  const after = fresh().f;
  after.pages.push(spec(addDoc([tweet({ at: '2026-10-25T08:30:00Z', seq: 71, text: `Late ${MINT}` })], 2), 2));
  after.ui = [legacyUi(3)];
  failClosed('page after terminal', () => run(after));
});

test('missing, malformed, unsettled or context-only UI receipts cannot certify completion', () => {
  const shapes: Array<{ name: string; make: (edit: Record<string, unknown>) => unknown; before: string; after: string; tab: string; noScroll: Record<string, unknown> }> = [
    { name: 'old', make: e => legacyUi(2, e), before: 'networkFilteredRequestCountBefore', after: 'networkFilteredRequestCountAfter', tab: 'selectedTab', noScroll: { afterDownScrollPages: 0 } },
    { name: 'final', make: e => finalUi(2, e), before: 'filteredRequestsAfterFirst', after: 'filteredRequestsAfterSecond', tab: 'selected', noScroll: { downScrollPages: [12, 0] } },
  ];
  const cases: Array<[string, unknown[]]> = [['no receipt', []], ['malformed receipt', ['{source: NATIVE_CHROME_AX_OBSERVATION']]];
  for (const s of shapes) {
    cases.push(
      [`${s.name}: request after further scroll`, [s.make({ [s.after]: 3 })]],
      [`${s.name}: counts not the page count`, [s.make({ [s.before]: 3, [s.after]: 3 })]],
      [`${s.name}: loading or error`, [s.make({ loadingOrErrorObserved: true })]],
      [`${s.name}: no further scroll`, [s.make(s.noScroll)]],
      [`${s.name}: other query`, [s.make({ query: `${QUERY} lang:en` })]],
      [`${s.name}: other tab`, [s.make({ [s.tab]: 'Top' })]],
      [`${s.name}: reproduction-only purpose`, [s.make({ purpose: 'PROTOCOL_REPRODUCTION_ONLY' })]],
    );
  }
  for (const [label, ui] of cases) {
    const { f } = fresh();
    f.ui = ui;
    failClosed(label, () => run(f));
  }
});

test('a cached complete or known flag never substitutes for terminal chain and settled end', () => {
  const single = fixture([Object.values(corpus())], false);
  single.ui = [legacyUi(1, { complete: true })];
  failClosed('complete flag on single page', () => run(single));
  const open = fixture([Object.values(corpus()), []], false);
  open.ui = [legacyUi(2, { complete: true })];
  failClosed('complete flag on non-terminal chain', () => run(open));
  const loading = fresh().f;
  loading.ui = [legacyUi(2, { complete: true, loadingOrErrorObserved: true })];
  failClosed('complete flag while loading', () => run(loading));
  const known = fresh().f;
  known.ui = [finalUi(2, { known: true, filteredRequestsAfterSecond: 3 })];
  failClosed('known flag with a further request', () => run(known));
});

test('timeline page cap and per-response byte cap are enforced at their bounds', () => {
  const older = (k: number) => [tweet({ at: new Date(Date.parse('2026-10-25T06:00:00Z') - k * 60_000).toISOString(), seq: 100 + k, author: AUTHOR.d, handle: 'fixture_delta', text: `Backlog ${k} ${MINT}` })];
  const twenty = complete(run(fixture([Object.values(corpus()), ...Array.from({ length: 18 }, (_, k) => older(k))])));
  assert.equal(twenty.pages, 20);
  assert.equal(twenty.posts.length, 22);
  truncated('21 timeline pages', () => run(fixture([Object.values(corpus()), ...Array.from({ length: 19 }, (_, k) => older(k))])));
  truncated('response above 500000 bytes', () => run(fixture([[tweet({ at: '2026-10-25T12:00:00Z', seq: 90, text: `${MINT} ${'x'.repeat(500_000)}` })]])));
});

test('exact UTF-8 byte length and sha256 bind every page and observation', () => {
  const utf = tweet({ at: '2026-10-25T12:20:00Z', seq: 80, text: `Größe 🚀 ${MINT} – früh` });
  const f = fixture([[utf]]);
  const p = byId(complete(run(f)), utf.rest_id);
  assert.equal(p.body, utf.legacy.full_text);
  assert.equal(p.bodyBindsMint, true);
  const raw = pagesOf(f)[0]!.body.raw;
  assert.notEqual(Buffer.byteLength(raw, 'utf8'), raw.length, 'fixture: multi-byte body');
  const cases: Array<[string, (pages: XPage[], obs: BoundText[]) => void]> = [
    ['UTF-16 length declared as bytes', pages => { pages[0]!.body.bytes = pages[0]!.body.raw.length; }],
    ['stale sha256', pages => { pages[0]!.body.sha256 = sha256(`${pages[0]!.body.raw} `); }],
    ['semantic edit under old hash', pages => { pages[0]!.body.raw = pages[0]!.body.raw.replace(MINT, MINT.replace('pump', 'pumq')); }],
    ['terminal edit under old hash', pages => { pages[1]!.body.raw = pages[1]!.body.raw.replace('cursor-bottom-0', 'cursor-bottom-9'); }],
    ['observation stale hash', (_pages, obs) => { obs[0]!.sha256 = sha256(`${obs[0]!.raw} `); }],
    ['observation byte count', (_pages, obs) => { obs[0]!.bytes += 1; }],
  ];
  for (const [label, mutate] of cases) {
    const pages = pagesOf(f), obs = obsOf(f);
    mutate(pages, obs);
    rejects(label, () => reconstructXStream(pages, obs, Q, MINT));
  }
  utf.legacy.full_text = utf.legacy.full_text.replace(MINT, `A${MINT}`);
  assert.equal(byId(complete(run(f)), utf.rest_id).bodyBindsMint, false, 'recomputed bytes carry the semantic edit');
});
