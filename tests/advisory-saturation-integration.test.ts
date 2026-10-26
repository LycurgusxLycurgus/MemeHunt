import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';
import { A24_CAPTURE_METHOD, A24_CAPTURE_V2_METHOD, CaptureInvalid, decodeA24Capture, deriveA24FromCapture, parseArticle, previewA24Classification } from '../src/providers/advisory-saturation.js';
import { advisorySemanticRulesV3 } from '../src/providers/advisory-semantic.js';
import { SOLANA_MAINNET_GENESIS, LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../src/providers/solana.js';
import { archiveHolderPopulation } from '../src/providers/advisory-topology.js';
import { DEMAND_ARCHIVE_ENCODING, DEMAND_ARCHIVE_METHOD } from '../src/providers/advisory-demand-windows.js';
import { collectLiveToken } from '../src/app/live.js';
import { reconstructAdvisory } from '../src/app/advisory.js';
import { starterProfile } from '../src/app/config.js';
import { Service } from '../src/app/service.js';
import { runCli } from '../src/cli.js';

// Constructed fixtures only: every X, DOM, Helius, DEX and review string is generated here. None is a mainnet or X
// observation, the review executions are fixture text rather than real model output, and nothing claims A24 acceptance.
type Any = any;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bt = (raw: string) => ({ raw, sha256: sha(raw), bytes: Buffer.byteLength(raw, 'utf8') });
const edit = (b: Any, f: (v: Any) => void) => { const v = JSON.parse(b.raw); f(v); Object.assign(b, bt(JSON.stringify(v))); };
const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const MINT = key(91), OTHER = key(92), target = { chain: 'solana' as const, address: MINT };
const RUBRIC: string = advisorySemanticRulesV3;
const T = (hms: string) => `2026-10-25T${hms}.000Z`;
const W0 = T('09:00:00'), T0 = T('10:00:00'), T1 = T('11:00:00'), CUT = T('11:20:00'), X0 = T('11:05:00');
const QUERY = `${MINT} since:2026-10-25_09:00:00_UTC until:2026-10-25_11:00:00_UTC`;
const DEX_URL = `https://api.dexscreener.com/orders/v1/solana/${MINT}`;
const CAPTURE = 'advisory-saturation-capture';
const Q = String.fromCharCode(34), attr = (n: string, v: string) => ` ${n}=${Q}${v}${Q}`;

const p2 = (n: number) => String(n).padStart(2, '0');
const xTime = (ms: number) => {
  const d = new Date(ms);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
};
const snowflake = (ms: number) => String((BigInt(ms) - 1288834974657n) << 22n);
type P = { id: string; author: string; handle: string; at: string; body: string };
const post = (author: string, at: string, body: string): P => ({ id: snowflake(Date.parse(at)), author, handle: `constructed${author}`, at, body });
// W0: 111. W1: 111 and 222, both constructed forward calls. A link-only post without the mint is excluded as unbound.
const POSTS = {
  w0: post('111', T('09:10:00'), `Constructed fixture note ${MINT} only`),
  a: post('111', T('10:10:00'), `Constructed fixture call ${MINT} up`),
  b: post('222', T('10:20:00'), `Constructed fixture call ${MINT} too`),
  link: post('333', T('10:30:00'), 'Constructed fixture link-only https://t.co/abc123'),
};

const entry = (p: P) => ({ entryId: `tweet-${p.id}`, content: { __typename: 'TimelineTimelineItem', itemContent: { __typename: 'TimelineTweet', tweet_results: { result: {
  __typename: 'Tweet', rest_id: p.id, core: { user_results: { result: { __typename: 'User', rest_id: p.author, core: { screen_name: p.handle } } } },
  legacy: { id_str: p.id, user_id_str: p.author, created_at: xTime(Date.parse(p.at)), full_text: p.body }, edit_control: { edit_tweet_ids: [p.id] },
} } } } });
const cursor = (type: string, value: string) => ({ entryId: `cursor-${type.toLowerCase()}-0`, content: { __typename: 'TimelineTimelineCursor', cursorType: type, value } });
const timeline = (instructions: Any[]) => JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } });
const searchUrl = (after?: string) => `https://x.com/i/api/graphql/abcdefghijkl/SearchTimeline?variables=${encodeURIComponent(JSON.stringify({ rawQuery: QUERY, count: 20, querySource: 'typed_query', product: 'Latest', ...(after ? { cursor: after } : {}) }))}&features=${encodeURIComponent(JSON.stringify({ constructed_feature: true }))}`;
const ui = (after = 2) => JSON.stringify({ kind: 'NATIVE_CHROME_CLIENT_END_OBSERVATION_V1', source: 'CONSTRUCTED_FIXTURE_NATIVE_CHROME_CLIENT', query: QUERY, selected: 'Latest', observedAt: T('11:05:10'), downScrollPages: [1, 2], filteredRequestsAfterFirst: 2, filteredRequestsAfterSecond: after, loadingOrErrorObserved: false });
const html = (p: P) => `<article${attr('data-testid', 'tweet')}><div><button${attr('data-testid', `${p.author}-follow`)}${attr('aria-label', `Follow @${p.handle}`)}>Follow</button></div><a${attr('href', `/${p.handle}/status/${p.id}`)}><time${attr('datetime', p.at)}>Oct 25</time></a><div${attr('data-testid', 'tweetText')}><span>${p.body}</span></div></article>`;
const domOf = (p: P) => ({ postId: p.id, sourceUrl: `https://x.com/${p.handle}/status/${p.id}`, sourceKind: 'CHROME_DEVTOOLS_COPY_OUTER_HTML_DOM_SNAPSHOT', observationStart: X0, copyCompletionObservedAt: T('11:05:59'), availableAt: T('11:06:00'), html: bt(html(p)) });

const rpc = (method: string, params: Any[], result: Any, at: string) => ({ origin: 'https://mainnet.helius-rpc.com', httpStatus: 200, requestStartedAt: at, responseCompletedAt: at, request: bt(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })), response: bt(JSON.stringify({ jsonrpc: '2.0', id: 1, result })) });
/** Constructed finalized endpoint: raw legacy mint, positive token accounts with distinct owners and the slot's block time; wide fixtures index tens of thousands of constructed keys. */
function endpoint(slot: number, blockTime: string, balances: bigint[], at: string, wide = false) {
  const wideKey = (fill: number, i: number) => { const k = Buffer.alloc(32, fill); k.writeUInt32BE(i, 28); return new PublicKey(k); };
  const mint = Buffer.alloc(82);
  mint.writeBigUInt64LE(balances.reduce((s, b) => s + b, 0n), 36); mint[44] = 6; mint[45] = 1;
  const accounts = balances.map((amount, i) => {
    const b = Buffer.alloc(165);
    new PublicKey(MINT).toBuffer().copy(b, 0); (wide ? wideKey(3, i) : new PublicKey(key(1 + i))).toBuffer().copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1;
    return { pubkey: wide ? wideKey(4, i).toBase58() : key(50 + i), account: { data: [b.toString('base64'), 'base64'], executable: false, lamports: 2039280, owner: LEGACY_TOKEN_PROGRAM, rentEpoch: 0, space: 165 } };
  });
  return {
    genesis: rpc('getGenesisHash', [], SOLANA_MAINNET_GENESIS, at),
    mint: rpc('getAccountInfo', [MINT, { encoding: 'base64', commitment: 'finalized', minContextSlot: slot }], { context: { slot }, value: { data: [mint.toString('base64'), 'base64'], executable: false, lamports: 1461600, owner: LEGACY_TOKEN_PROGRAM, rentEpoch: 0, space: 82 } }, at),
    population: rpc('getProgramAccounts', [LEGACY_TOKEN_PROGRAM, { encoding: 'base64', commitment: 'finalized', minContextSlot: slot, withContext: true, filters: [{ memcmp: { offset: 0, bytes: MINT } }] }], { context: { slot }, value: accounts }, at),
    blockTime: rpc('getBlockTime', [slot], Date.parse(blockTime) / 1000, at),
  };
}
const scope = JSON.stringify({
  kind: 'A24_AUTHENTICATED_QUERY_CAPTURE_SCOPE_V1', acquisition: 'CHROME_DEVTOOLS_FILTERED_SANITIZED_RESPONSE_EXPORT', knownClaim: false, frozenAt: T('11:00:30'),
  limitsPerToken: { timelinePages: 20, detailPages: 40, captureWallSeconds: 900, retainedBytes: 8388608, perResponseBytes: 500000, cursorRetries: 1 },
  queries: [{ mint: MINT, product: 'Latest', count: 20, querySource: 'typed_query', query: QUERY, windows: { boundaryConvention: 'HALF_OPEN', previous: { start: W0, end: T0 }, current: { start: T0, end: T1 }, durationSeconds: 3600 } }],
});

/** Constructed independent executions of the identical preview prompt; the second answer can be altered per case. */
function review(c: Any, second?: (posts: Any[]) => void): Any {
  c.classifications = null;
  const { packet, prompt } = previewA24Classification(JSON.stringify(c), target, CUT, RUBRIC) as Any;
  const doms = new Map<string, string>(packet.dom.map((d: Any) => [d.postId, d.sha256]));
  const answer = () => packet.posts.map((p: Any) => {
    const i = p.body.indexOf('call'), call = p.window === 'W1' && i >= 0;
    return { postId: p.postId, bodySha256: p.bodySha256, event: call ? 'FORWARD_CALL' : 'OTHER', eventCitations: call ? [{ start: i, end: i + 4, exactText: 'call' }] : [], paidDisclosureText: 'NOT_OBSERVED', disclosureCitations: [], inspectedRange: { start: 0, end: [...p.body].length }, visiblePaidLabel: doms.has(p.postId) ? 'NOT_OBSERVED' : 'UNINSPECTED', domSha256: doms.get(p.postId) ?? null };
  });
  const first = answer(), other = answer();
  second?.(other);
  c.classifications = {
    first: { executor: 'CODEX_NATIVE', invocationId: 'constructed-codex-a24-0001', prompt, response: JSON.stringify({ posts: first }), availableAt: T('11:07:00') },
    second: { executor: 'CLAUDE_CODE', invocationId: 'constructed-claude-a24-0001', prompt, response: JSON.stringify({ posts: other }), availableAt: T('11:08:00') },
  };
  return c;
}
function capture(o: { w1?: boolean; dom?: boolean; reviews?: boolean } = {}): Any {
  const { w1 = true, dom = true, reviews = true } = o, posts = [POSTS.w0, ...(w1 ? [POSTS.a, POSTS.b] : []), POSTS.link];
  const c: Any = {
    method: A24_CAPTURE_METHOD, token: { chain: 'solana', address: MINT },
    provenance: { ingress: 'USER_IMPORT', acquisition: 'CHROME_DEVTOOLS_FILTERED_SANITIZED_RESPONSE_EXPORT', access: 'USER_SESSION_READ', domAcquisition: 'CHROME_DEVTOOLS_COPY_OUTER_HTML_DOM_SNAPSHOT', domParserContext: 'SCRAPLING_0_5_OFFLINE_CONTEXT_ONLY', holderAccess: 'HELIUS_FREE_ACCOUNT', dexAccess: 'PUBLIC_API' },
    scope: bt(scope),
    x: { status: 'CAPTURED', observations: [bt(ui())], pages: [
      { method: 'GET', url: searchUrl(), httpStatus: 200, startedAt: X0, durationMs: 1000, body: bt(timeline([{ type: 'TimelineAddEntries', entries: [...posts.map(entry), cursor('Top', 'constructed-top-1'), cursor('Bottom', 'constructed-bottom-1')] }])) },
      { method: 'GET', url: searchUrl('constructed-bottom-1'), httpStatus: 200, startedAt: T('11:05:02'), durationMs: 1000, body: bt(timeline(['Top', 'Bottom'].map(t => ({ type: 'TimelineReplaceEntry', entry_id_to_replace: `cursor-${t.toLowerCase()}-0`, entry: cursor(t, `constructed-${t.toLowerCase()}-2`) })))) },
    ] },
    dom: dom && w1 ? [POSTS.a, POSTS.b].map(domOf) : [],
    holders: { s0: endpoint(1000, T0, [600n, 400n], T('11:01:00')), s1: endpoint(9000, T1, [500n, 300n, 200n], T('11:02:00')) },
    dex: { url: DEX_URL, httpStatus: 200, redirected: false, credentialsUsed: false, requestAt: T('11:09:59'), responseAt: T('11:10:00'), availableAt: T('11:10:00'), body: bt(JSON.stringify({ orders: [], boosts: [] })) },
    classifications: null,
  };
  return reviews ? review(c) : c;
}
const editTweet = (c: Any, id: string, f: (r: Any) => void) => edit(c.x.pages[0].body, v => f(v.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries.find((e: Any) => e.entryId === `tweet-${id}`).content.itemContent.tweet_results.result));
const derive = (c: Any, cut = CUT, token: Any = target) => deriveA24FromCapture(typeof c === 'string' ? c : JSON.stringify(c), token, cut, RUBRIC, ['evidence:a24']);
const mut = (change: (c: Any) => void, base: () => Any = () => capture()) => { const c = base(); change(c); return c; };
const missing = (c: Any, reasonCode: string, cut = CUT) => { const v = derive(c, cut); assert.deepEqual([v.quality, v.reasonCode], ['MISSING', reasonCode]); return v.data!; };
const invalid = (cases: [string | null, Any, string?][]) => {
  for (const [code, c, cut] of cases) {
    const v = derive(c, cut ?? CUT);
    assert.equal(v.quality, 'INVALID', `${code}: ${v.reasonCode}`);
    if (code) assert.equal(v.reasonCode, code);
    assert.deepEqual([v.data, v.scope], [null, null]);
  }
};

test('constructed raw capture reconstructs all six components with exact arithmetic', () => {
  const raw = JSON.stringify(capture());
  assert.equal(decodeA24Capture(raw).x.status, 'CAPTURED');
  const v = derive(raw);
  assert.deepEqual([v.quality, v.reasonCode, v.evidenceIds], ['KNOWN', null, ['evidence:a24']]);
  const d = v.data!;
  assert.deepEqual(d.windows.w0, { status: 'COMPLETE', reasonCode: null, posts: 1, authors: 1, countsByAuthor: [{ authorId: '111', posts: 1 }], excludedReposts: 0, excludedUnbound: 0 });
  assert.deepEqual([d.windows.w1.posts, d.windows.w1.authors, d.windows.w1.excludedUnbound], [2, 2, 1]);
  assert.deepEqual(d.repeatedAuthor.value, { posts: 2, authors: 2, repeatPosts: 0, share: { numerator: 0, denominator: 2, value: '0' } });
  assert.deepEqual(d.sourceNovelty.value, { currentAuthors: 2, newAuthors: 1, newAuthorIds: ['222'], returningAuthorIds: ['111'], share: { numerator: 1, denominator: 2, value: '0.5' } });
  assert.deepEqual(d.callerBreadth.value, { callers: 2, callerAuthorIds: ['111', '222'], reviewedPosts: 2 });
  const m = d.mentionGrowth.value!;
  assert.deepEqual([m.n0, m.n1, m.rate.change, m.rate.durationSeconds, m.relative, m.relativeReason], [1, 2, 1, '3600', { numerator: 1, denominator: 1, value: '1' }, null]);
  const h = d.holderGrowth.value!;
  assert.deepEqual([h.unit, h.h0, h.h1, h.rate.change, h.s0, h.s1], ['POSITIVE_OWNER_ADDRESSES', 2, 3, 1, { slot: 1000, blockTime: T0 }, { slot: 9000, blockTime: T1 }]);
  const paid = d.paidVisibility;
  assert.deepEqual([paid.status, paid.hiddenPayments, paid.dex.value], ['COMPLETE', 'NOT_MEASURED', { availableAt: T('11:10:00'), observations: 0, groups: [] }]);
  assert.deepEqual([paid.x.value!.inspectedPosts, paid.x.value!.disclosedPosts, paid.x.value!.labelledPosts], [2, 0, 0]);
  assert.ok(paid.x.value!.posts.every(p => p.labelEvidence === 'DOM_SNAPSHOT'));
  assert.ok(!('score' in d) && !JSON.stringify(d).includes('organic'));
  const s = v.scope!.x as Any;
  assert.deepEqual([s.source, s.sourceVersion, s.access, s.collector], ['chrome-devtools-response-export', A24_CAPTURE_METHOD, 'USER_SESSION_READ', { startedAt: X0, finishedAt: T('11:06:00'), maxClockSkewMs: 0 }]);
  assert.deepEqual(derive(raw), v);
  // The preview packet is the canonical review input: eligible own bodies only (no link-only post) plus the full retained DOM.
  const { packet, prompt } = previewA24Classification(raw, target, CUT, RUBRIC) as Any;
  assert.deepEqual(packet.posts.map((p: Any) => [p.postId, p.window, p.body]), [[POSTS.w0.id, 'W0', POSTS.w0.body], [POSTS.a.id, 'W1', POSTS.a.body], [POSTS.b.id, 'W1', POSTS.b.body]]);
  assert.deepEqual(packet.dom.map((d: Any) => d.sha256), [POSTS.a, POSTS.b].map(p => sha(html(p))));
  assert.ok(packet.dom[0].textNodes.includes(POSTS.a.body));
  assert.equal(prompt, JSON.parse(raw).classifications.first.prompt);
});

test('empty current window is MISSING with measured zeros and undefined required ratios', () => {
  const d = missing(capture({ w1: false }), 'REPEAT_DENOMINATOR_ZERO');
  assert.deepEqual(d.repeatedAuthor.value, { posts: 0, authors: 0, repeatPosts: 0, share: null });
  assert.deepEqual([d.sourceNovelty.reasonCode, d.sourceNovelty.value!.share], ['NOVELTY_DENOMINATOR_ZERO', null]);
  assert.deepEqual([d.callerBreadth.value!.callers, d.mentionGrowth.value!.n1, d.mentionGrowth.value!.rate.change, d.windows.w1.excludedUnbound], [0, 0, -1, 1]);
  assert.equal(d.holderGrowth.value!.h1, 3);
});

test('missing DOM, reviews or agreement stay MISSING and never become zero', () => {
  const noDom = missing(capture({ dom: false }), 'PAID_LABEL_INSPECTION_MISSING');
  assert.deepEqual([noDom.callerBreadth.value!.callers, noDom.paidVisibility.x.value, noDom.paidVisibility.dex.status], [2, null, 'COMPLETE']);
  const noReview = derive(capture({ reviews: false }));
  assert.deepEqual([noReview.quality, noReview.data!.callerBreadth.value, noReview.data!.repeatedAuthor.value!.posts], ['MISSING', null, 2]);
  const split = missing(review(capture({ reviews: false }), b => Object.assign(b.find(p => p.postId === POSTS.b.id), { event: 'NEWS', eventCitations: [] })), 'FORWARD_CALL_REVIEW_INCOMPLETE');
  assert.equal(split.callerBreadth.value, null);
});

test('valid FAILED sources persist as MISSING with no fabricated counts', () => {
  const x = derive(mut(c => { c.x = { status: 'FAILED', reasonCode: 'X_LOGIN_WALL' }; c.dom = []; c.classifications = null; }));
  assert.deepEqual([x.quality, x.reasonCode, x.data!.windows.w1.posts, x.data!.callerBreadth.value, x.data!.holderGrowth.value!.h1], ['MISSING', 'X_LOGIN_WALL', null, null, 3]);
  const h = missing(mut(c => { c.holders = { status: 'FAILED', reasonCode: 'HELIUS_HTTP_429' }; }), 'HELIUS_HTTP_429');
  assert.deepEqual([h.holderGrowth.value, h.callerBreadth.value!.callers], [null, 2]);
  const d = missing(mut(c => { c.dex = { status: 'FAILED', reasonCode: 'DEX_HTTP_503' }; }), 'DEX_HTTP_503');
  assert.deepEqual([d.paidVisibility.dex.value, d.paidVisibility.hiddenPayments], [null, 'NOT_MEASURED']);
  invalid([['A24_ORPHAN_SOURCES', mut(c => { c.x = { status: 'FAILED', reasonCode: 'X_LOGIN_WALL' }; })]]);
});

test('stream end requires terminal cursor replacement and a settled client observation', () => {
  missing(mut(c => { c.x.pages.pop(); }), 'X_STREAM_END_NOT_OBSERVED');
  missing(mut(c => { c.x.observations = []; }), 'X_CLIENT_SETTLED_END_NOT_OBSERVED');
  missing(mut(c => { c.x.observations = [bt(ui(3))]; }), 'X_CLIENT_SETTLED_END_NOT_OBSERVED');
});

test('scope, query, cursor and hash forgeries are INVALID', () => {
  invalid([
    ['A24_X_QUERY', mut(c => edit(c.scope, s => { s.queries[0].query = `${MINT} lang:en`; }))],
    ['A24_SCOPE_WINDOWS', mut(c => edit(c.scope, s => { s.queries[0].windows.current.start = T('10:00:01'); }))],
    ['A24_SCOPE_LIMITS', mut(c => edit(c.scope, s => { s.limitsPerToken.timelinePages = 21; }))],
    ['A24_SCOPE_MINT', mut(c => edit(c.scope, s => { s.queries[0].mint = OTHER; }))],
    ['A24_SCOPE_HASH', mut(c => { c.scope.raw = c.scope.raw.replace('HALF_OPEN', 'HALF_OPEX'); })],
    ['A24_X_CURSOR_CHAIN', mut(c => { c.x.pages[1].url = searchUrl('constructed-bottom-9'); })],
    ['A24_X_BODY_HASH', mut(c => { c.x.pages[0].body.raw = c.x.pages[0].body.raw.replace('only', 'onlY'); })],
    ['A24_UI_HASH', mut(c => { c.x.observations[0].raw = c.x.observations[0].raw.replace('Latest', 'Latesu'); })],
    ['A24_CAPTURE_SCHEMA', mut(c => { c.quality = 'KNOWN'; })],
    ['A24_CAPTURE_SCHEMA', mut(c => { delete c.classifications; })],
  ]);
});

test('fully rehashed bodies are caught by the DOM rendering or the canonical review prompt', () => {
  invalid([
    ['A24_DOM_BODY', mut(c => editTweet(c, POSTS.a.id, r => { r.legacy.full_text += ' extra'; }))],
    ['A24_CLASSIFICATION_PROVENANCE', mut(c => editTweet(c, POSTS.w0.id, r => { r.legacy.full_text += ' extra'; }))],
  ]);
});

test('holder genesis, mint, program, slot, supply and block time contradictions never yield KNOWN', () => {
  const invalidCodes: [string, (c: Any) => void][] = [
    ['A24_HOLDER_GENESIS', c => edit(c.holders.s0.genesis.response, r => { r.result = key(7); })],
    ['A24_HOLDER_MINT_REQUEST', c => edit(c.holders.s0.mint.request, r => { r.params[0] = OTHER; })],
    ['A24_HOLDER_POPULATION_REQUEST', c => edit(c.holders.s1.population.request, r => { r.params[0] = TOKEN_2022_PROGRAM; })],
    ['A24_HOLDER_POPULATION_REQUEST', c => edit(c.holders.s1.population.request, r => { r.params[1].minContextSlot = 8999; })],
    ['A24_HOLDER_MINT', c => edit(c.holders.s0.mint.response, r => { const b = Buffer.from(r.result.value.data[0], 'base64'); b[45] = 0; r.result.value.data[0] = b.toString('base64'); })],
    ['A24_HOLDER_BLOCKTIME', c => edit(c.holders.s1.blockTime.request, r => { r.params[0] = 9001; })],
    ['HOLDER_FRAME_MISMATCH', c => edit(c.holders.s1.blockTime.response, r => { r.result += 1; })],
    ['A24_RPC_HASH', c => { c.holders.s0.population.response.raw += ' '; }],
    ['A24_HOLDER_AFTER_CUTOFF', c => { c.holders.s1.blockTime.responseCompletedAt = T('11:20:01'); }],
    ['A24_HOLDER_MINT_DRIFT', c => edit(c.holders.s1.mint.response, r => { const b = Buffer.from(r.result.value.data[0], 'base64'); b[44] = 9; r.result.value.data[0] = b.toString('base64'); })],
  ];
  invalid(invalidCodes.map(([code, change]) => [code, mut(change)]));
  const supply = derive(mut(c => edit(c.holders.s1.mint.response, r => { const b = Buffer.from(r.result.value.data[0], 'base64'); b.writeBigUInt64LE(999n, 36); r.result.value.data[0] = b.toString('base64'); })));
  assert.notEqual(supply.quality, 'KNOWN');
  assert.equal(supply.data?.holderGrowth.value ?? null, null);
});

test('DEX snapshot age, endpoint binding and paid groups', () => {
  missing(mut(c => { c.dex.availableAt = '2026-10-25T11:04:59.999Z'; c.dex.responseAt = c.dex.availableAt; c.dex.requestAt = T('11:04:59'); }), 'DEX_SNAPSHOT_STALE');
  invalid([[null, mut(c => { c.dex.url = `https://api.dexscreener.com/orders/v1/solana/${OTHER}`; })], ['A24_DEX_HASH', mut(c => { c.dex.body.raw += ' '; })]]);
  const paid = derive(mut(c => { c.dex.body = bt(JSON.stringify({
    orders: [{ chainId: 'solana', tokenAddress: MINT, type: 'tokenProfile', status: 'approved', paymentTimestamp: Date.parse(T('10:30:00')) }],
    boosts: [{ id: 'constructed-boost-1', chainId: 'solana', tokenAddress: MINT, amount: 10, paymentTimestamp: Date.parse(T('08:00:00')) }],
  })); }));
  assert.equal(paid.quality, 'KNOWN', `${paid.reasonCode}`);
  assert.deepEqual(paid.data!.paidVisibility.dex.value!.groups, [
    { venue: 'dexscreener', kind: 'BOOST', type: 'boost', status: null, timing: 'BEFORE_INTERVAL', count: 1 },
    { venue: 'dexscreener', kind: 'ORDER', type: 'tokenProfile', status: 'approved', timing: 'IN_INTERVAL', count: 1 },
  ]);
  assert.equal(paid.data!.paidVisibility.hiddenPayments, 'NOT_MEASURED');
});

test('review executions must be distinct invocations of the canonical prompt with own-body spans', () => {
  const base = () => capture({ reviews: false });
  invalid([
    ['A24_CLASSIFICATION_PROVENANCE', mut(c => { c.classifications.second.prompt += ' '; })],
    ['A24_CLASSIFICATION_PROVENANCE', mut(c => { c.classifications.second.invocationId = c.classifications.first.invocationId; })],
    ['A24_CLASSIFICATION_PROVENANCE', mut(c => { c.classifications.second.executor = 'CODEX_NATIVE'; })],
    ['A24_CLASSIFICATION_BINDING', review(base(), b => { b.find(p => p.postId === POSTS.a.id).eventCitations = []; })],
    ['A24_CLASSIFICATION_BINDING', review(base(), b => { b.find(p => p.postId === POSTS.a.id).eventCitations[0].exactText = 'cell'; })],
    ['A24_CLASSIFICATION_BINDING', review(base(), b => { b.find(p => p.postId === POSTS.a.id).inspectedRange.end -= 1; })],
    ['A24_CLASSIFICATION_BINDING', review(base(), b => { Object.assign(b.find(p => p.postId === POSTS.b.id), { visiblePaidLabel: 'UNINSPECTED', domSha256: null }); })],
    ['A24_CLASSIFICATION_COVERAGE', review(base(), b => { b.pop(); })],
  ]);
});

test('DOM identity, hash and orphan contradictions are INVALID', () => {
  invalid([
    ['A24_DOM_HASH', mut(c => { c.dom[0].html.raw = c.dom[0].html.raw.replace('Follow<', 'Folloq<'); })],
    ['A24_DOM_BINDING', mut(c => { c.dom[0].sourceUrl = `https://x.com/constructed222/status/${POSTS.a.id}`; })],
    ['A24_DOM_BINDING', mut(c => { c.dom[0].html = bt(html({ ...POSTS.a, author: '222' })); })],
    ['A24_DOM_BINDING', mut(c => { c.dom[0].observationStart = T('11:05:01'); })],
    ['A24_DOM_ORPHAN', mut(c => { c.dom.push(domOf(POSTS.link)); })],
    ['A24_DOM_ORPHAN', mut(c => { c.dom.push(domOf(POSTS.a)); })],
  ]);
});

test('clock bounds: capture wall edge, cutoff, collection start and token binding', () => {
  const late = (at: string) => mut(c => { c.dom[0].availableAt = at; }, () => capture({ reviews: false }));
  assert.equal(derive(late(T('11:20:00')), T('11:25:00')).data!.windows.w1.status, 'COMPLETE');
  missing(late(T('11:20:01')), 'X_CAPTURE_BUDGET_EXCEEDED', T('11:25:00'));
  invalid([
    ['A24_CLASSIFICATION_CLOCK', capture(), T('11:07:30')],
    [null, mut(c => { c.x.pages[0].startedAt = T('10:59:59'); for (const d of c.dom) d.observationStart = T('10:59:59'); }, () => capture({ reviews: false }))],
  ]);
  const other = derive(capture(), CUT, { chain: 'solana', address: OTHER });
  assert.deepEqual([other.quality, other.reasonCode], ['INVALID', 'A24_TOKEN']);
});

test('byte budgets: 8 MiB capture, 500 KB X response, 20 MB-capable holder population', () => {
  invalid([['A24_CAPTURE_SIZE', JSON.stringify(capture()) + ' '.repeat(8_388_608)]]);
  missing(mut(c => { Object.assign(c.x.pages[0].body, bt(c.x.pages[0].body.raw + ' '.repeat(500_001))); }, () => capture({ dom: false, reviews: false })), 'X_RESPONSE_BYTES_CAP');
  const big = derive(mut(c => { Object.assign(c.holders.s1.population.response, bt(c.holders.s1.population.response.raw + ' '.repeat(1_000_000))); }));
  assert.deepEqual([big.quality, big.data!.holderGrowth.value!.h1], ['KNOWN', 3]);
});

test('UNCLEAR on any required W1 dimension in both responses leaves the post unqualified and the vector MISSING', () => {
  const both = (change: (p: Any) => void, id = POSTS.a.id) => mut(c => {
    for (const e of [c.classifications.first, c.classifications.second]) { const r = JSON.parse(e.response); change(r.posts.find((p: Any) => p.postId === id)); e.response = JSON.stringify(r); }
  });
  const cases: ((p: Any) => void)[] = [
    p => { p.event = 'UNCLEAR'; p.eventCitations = []; },
    p => { p.event = 'UNCLEAR'; },
    p => { p.paidDisclosureText = 'UNCLEAR'; },
    p => { p.visiblePaidLabel = 'UNCLEAR'; },
  ];
  for (const change of cases) {
    const v = derive(both(change));
    assert.deepEqual([v.quality, v.reasonCode], ['MISSING', 'FORWARD_CALL_REVIEW_INCOMPLETE']);
    assert.deepEqual([v.data!.callerBreadth.value, v.data!.paidVisibility.x.value, v.data!.repeatedAuthor.value!.posts, v.data!.holderGrowth.value!.h1], [null, null, 2, 3]);
  }
  invalid([['A24_CLASSIFICATION_BINDING', both(p => { p.event = 'UNCLEAR'; p.eventCitations[0].exactText = 'cell'; })]]);
  const w0 = derive(both(p => { p.event = 'UNCLEAR'; p.paidDisclosureText = 'UNCLEAR'; }, POSTS.w0.id));
  assert.deepEqual([w0.quality, w0.data], ['KNOWN', derive(capture()).data]);
});

test('stable author ID governs DOM identity; a legal handle change binds, a follow ID change does not', () => {
  const renamed = { ...POSTS.a, handle: 'constructed111r' };
  const v = derive(review(mut(c => { c.dom[0] = domOf(renamed); }, () => capture({ reviews: false }))));
  assert.deepEqual([v.quality, v.reasonCode, v.data], ['KNOWN', null, derive(capture()).data]);
  invalid([['A24_DOM_BINDING', mut(c => { c.dom[0] = domOf({ ...renamed, author: '999' }); })]]);
});

test('inspectedRange accepts the strict object or the exact [0, end] tuple; malformed or partial ranges fail closed', () => {
  const ranged = (f: (p: Any) => Any, which = [0, 1]) => mut(c => {
    const executions = [c.classifications.first, c.classifications.second];
    for (const i of which) { const r = JSON.parse(executions[i].response); for (const p of r.posts) p.inspectedRange = f(p); executions[i].response = JSON.stringify(r); }
  });
  const tuple = (p: Any) => [p.inspectedRange.start, p.inspectedRange.end];
  const known = derive(capture());
  assert.equal(known.quality, 'KNOWN');
  for (const which of [[0, 1], [0], [1]]) {
    const v = derive(ranged(tuple, which));
    assert.deepEqual([v.quality, v.reasonCode, v.data], ['KNOWN', null, known.data], `${which}`);
  }
  invalid([
    ['A24_CLASSIFICATION_COVERAGE', ranged(() => [0])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(p => [0, p.inspectedRange.end, 0])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(p => ['0', p.inspectedRange.end])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(p => [0, String(p.inspectedRange.end)])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(p => [1, p.inspectedRange.end])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(p => [null, p.inspectedRange.end])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(() => [0, null])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(() => [0, -1])],
    ['A24_CLASSIFICATION_COVERAGE', ranged(p => ({ ...p.inspectedRange, extra: 0 }))],
    ['A24_CLASSIFICATION_BINDING', ranged(p => [0, p.inspectedRange.end - 1])],
    ['A24_CLASSIFICATION_BINDING', ranged(p => [0, p.inspectedRange.end + 1], [1])],
  ]);
});

let requests = 0;
const fetcher: typeof fetch = async (input, init) => {
  requests++;
  const url = String(input);
  let result: Any;
  if (init?.method === 'POST') { const r = JSON.parse(String(init.body)); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: r.method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : r.method === 'getSignaturesForAddress' ? [] : { context: { slot: 1 }, value: null } })); }
  if (url.includes('/token-pairs/')) result = [];
  else if (url.includes('coinbase')) result = Array.from({ length: 75 }, (_, i) => [Date.parse(CUT) / 1000 - i * 3600, 9, 11, 10, 10, 2]);
  else if (url.includes('llama')) result = { chain: new URL(url).pathname.split('/').at(-1), totalDataChart: [] };
  else if (url.includes('/orders/')) result = { orders: [], boosts: [] };
  else result = {};
  return new Response(JSON.stringify(result));
};
const live = (a24Capture?: string) => collectLiveToken(target, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, ...(a24Capture === undefined ? {} : { a24Capture }), fetcher, now: () => CUT } as Any);
const a24Of = (metrics: Any[]) => metrics.find((m: Any) => m.id === 'A24');
const rehash = (b: Any) => { for (const e of b.evidence) e.contentHash = sha(b.rawArtifacts[e.id]!); };

test('live proof37 carries the raw capture, reconstructs the full vector and survives Service save/reopen/replay', async () => {
  const raw = JSON.stringify(capture()), bundle: Any = await live(raw);
  const proof = JSON.parse(bundle.rawArtifacts['advisory-derivation']);
  assert.deepEqual([proof.method, proof.saturation, proof.a29], ['advisory-provenance-v40', { captureId: CAPTURE }, null]);
  assert.equal(bundle.rawArtifacts[CAPTURE], raw);
  const ev = bundle.evidence.find((e: Any) => e.id === CAPTURE);
  assert.deepEqual([ev.scope, ev.contentHash], [{ method: A24_CAPTURE_METHOD }, sha(raw)]);
  for (const s of ['advisory-saturation', 'USER_IMPORT', 'HISTORICAL_RECEIPT']) assert.ok(JSON.stringify(ev).includes(s), s);
  assert.equal(bundle.details.advisory.method, 'advisory-measurements-v39');
  const metric = a24Of(bundle.details.advisory.metrics);
  assert.equal(metric.quality, 'KNOWN');
  assert.deepEqual(metric.data, deriveA24FromCapture(raw, target, CUT, RUBRIC, metric.data.evidenceIds));
  assert.deepEqual(reconstructAdvisory(target, CUT, bundle.details.baseline, bundle.evidence, bundle.rawArtifacts, proof, bundle.thesis ?? null, bundle.features), bundle.details.advisory);

  const dir = mkdtempSync(join(tmpdir(), 'meme-a24-')), file = join(dir, 'case.sqlite');
  let service = new Service(file);
  try {
    const saved = service.analyzeLive(bundle), before = requests;
    service.close(); service = new Service(file);
    assert.deepEqual(service.replay(saved.id), saved);
    assert.deepEqual(service.replay(saved.id), saved);
    assert.equal(requests, before);
    const tamper: ((b: Any) => void)[] = [
      b => { const c = JSON.parse(b.rawArtifacts[CAPTURE]); c.token.address = OTHER; b.rawArtifacts[CAPTURE] = JSON.stringify(c); },
      b => { const c = JSON.parse(b.rawArtifacts[CAPTURE]); delete c.classifications; b.rawArtifacts[CAPTURE] = JSON.stringify(c); },
      b => { const c = JSON.parse(b.rawArtifacts[CAPTURE]); c.scope.raw += ' '; b.rawArtifacts[CAPTURE] = JSON.stringify(c); },
      b => { const p = JSON.parse(b.rawArtifacts['advisory-derivation']); p.method = 'advisory-provenance-v36'; b.rawArtifacts['advisory-derivation'] = JSON.stringify(p); },
      b => { const p = JSON.parse(b.rawArtifacts['advisory-derivation']); p.saturation.captureId = 'advisory-saturation-other'; b.rawArtifacts['advisory-derivation'] = JSON.stringify(p); },
      b => { b.evidence.find((e: Any) => e.id === CAPTURE).scope = { method: 'a24-raw-capture-v2' }; },
      b => { const p = JSON.parse(b.rawArtifacts['advisory-derivation']); delete p.saturation; b.rawArtifacts['advisory-derivation'] = JSON.stringify(p); },
    ];
    for (const change of tamper) { const bad = structuredClone(bundle); change(bad); rehash(bad); assert.throws(() => service.analyzeLive(bad)); }
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('valid FAILED capture persists MISSING and no packet keeps the saturation descriptor null', async () => {
  const failed = JSON.stringify(mut(c => { c.x = { status: 'FAILED', reasonCode: 'X_LOGIN_WALL' }; c.dom = []; c.classifications = null; c.holders = { status: 'FAILED', reasonCode: 'HELIUS_HTTP_429' }; c.dex = { status: 'FAILED', reasonCode: 'DEX_HTTP_503' }; }, () => capture({ reviews: false })));
  const bundle: Any = await live(failed), metric = a24Of(bundle.details.advisory.metrics);
  assert.deepEqual([metric.quality, metric.data.data.holderGrowth.value, metric.data.data.windows.w1.posts], ['MISSING', null, null]);
  const dir = mkdtempSync(join(tmpdir(), 'meme-a24-failed-')), file = join(dir, 'case.sqlite');
  const service = new Service(file);
  try { const saved = service.analyzeLive(bundle); assert.deepEqual(service.replay(saved.id), saved); }
  finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
  const none: Any = await live();
  assert.equal(JSON.parse(none.rawArtifacts['advisory-derivation']).saturation, null);
  assert.equal(none.rawArtifacts[CAPTURE], undefined);
  const absent = a24Of(none.details.advisory.metrics);
  assert.ok(!absent || absent.quality === 'MISSING');
});

test('legacy proof36 relabel reconstructs historical facts35 without A24 and is not freshly admitted', async () => {
  const bundle: Any = await live(JSON.stringify(capture())), legacy = structuredClone(bundle), old = JSON.parse(legacy.rawArtifacts['advisory-derivation']);
  assert.equal(old.a29, null); delete old.a29;
  delete old.saturation; old.method = 'advisory-provenance-v36';
  delete legacy.rawArtifacts[CAPTURE];
  legacy.evidence = legacy.evidence.filter((e: Any) => e.id !== CAPTURE);
  legacy.rawArtifacts['advisory-derivation'] = JSON.stringify(old);
  rehash(legacy);
  const facts = reconstructAdvisory(target, CUT, legacy.details.baseline, legacy.evidence, legacy.rawArtifacts, old, legacy.thesis ?? null, legacy.features) as Any;
  assert.equal(facts.method, 'advisory-measurements-v35');
  const oldA24 = a24Of(facts.metrics);
  assert.ok(!oldA24 || oldA24.quality === 'MISSING');
  const dir = mkdtempSync(join(tmpdir(), 'meme-a24-legacy-')), service = new Service(join(dir, 'case.sqlite'));
  try { assert.throws(() => service.analyzeLive(legacy)); }
  finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

// v2 transport: representation-only; both holder population responses travel as exact holder-archive containers of their originals.
const V1 = A24_CAPTURE_METHOD, V2 = A24_CAPTURE_V2_METHOD;
const archived = (b: Any) => ({ archive: archiveHolderPopulation(b.raw), sha256: b.sha256, bytes: b.bytes });
const toV2 = (c: Any, sides = ['s0', 's1']) => { const v = structuredClone(c); v.method = V2; for (const s of sides) v.holders[s].population.response = archived(v.holders[s].population.response); return v; };
const asV2 = () => toV2(capture());
const s1Response = (c: Any) => c.holders.s1.population.response;
const sourceVersion = (v: Any) => v.scope.x.sourceVersion;
const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A canonical container over arbitrary bytes from the codec's public constants, for inputs the producer itself refuses. */
const rawContainer = (bytes: Buffer) => JSON.stringify({ method: DEMAND_ARCHIVE_METHOD, encoding: DEMAND_ARCHIVE_ENCODING, sourceBytes: bytes.length, sourceHash: hex(bytes), data: deflateRawSync(bytes).toString('base64') });

test('v2 materializes the exact holder originals and reconstructs the identical vector, packet and prompt', () => {
  const v1 = capture(), raw1 = JSON.stringify(v1), raw2 = JSON.stringify(toV2(v1));
  const d1 = decodeA24Capture(raw1), d2 = decodeA24Capture(raw2);
  assert.deepEqual([d1.method, d2.method], [V1, V2]);
  assert.deepEqual({ ...d2, method: V1 }, d1);
  for (const s of ['s0', 's1'] as const) {
    const r = (d2.holders as Any)[s].population.response;
    assert.deepEqual([r.raw, r.sha256, r.bytes], [v1.holders[s].population.response.raw, sha(r.raw), Buffer.byteLength(r.raw, 'utf8')]);
  }
  const a: Any = derive(raw1), b: Any = derive(raw2);
  assert.deepEqual([a.quality, b.quality, b.reasonCode, sourceVersion(a), sourceVersion(b)], ['KNOWN', 'KNOWN', null, V1, V2]);
  assert.deepEqual({ ...b, scope: { ...b.scope, x: { ...b.scope.x, sourceVersion: V1 } } }, a);
  assert.deepEqual(previewA24Classification(raw2, target, CUT, RUBRIC), previewA24Classification(raw1, target, CUT, RUBRIC));
});

test('v2 keeps the existing holder failure shape and echoes the actual transport method', () => {
  const v = derive(mut(c => { c.method = V2; c.holders = { status: 'FAILED', reasonCode: 'HELIUS_HTTP_429' }; }));
  assert.deepEqual([v.quality, v.reasonCode, v.data!.holderGrowth.value, v.data!.callerBreadth.value!.callers, sourceVersion(v)], ['MISSING', 'HELIUS_HTTP_429', null, 2, V2]);
});

test('only both v2 population responses may be archived: mixed, misplaced and relabelled representations are schema-invalid', () => {
  const misplaced: ((c: Any) => void)[] = [
    c => { c.holders.s0.genesis.response = archived(c.holders.s0.genesis.response); },
    c => { c.holders.s1.mint.response = archived(c.holders.s1.mint.response); },
    c => { c.holders.s1.blockTime.response = archived(c.holders.s1.blockTime.response); },
    c => { c.holders.s1.population.request = archived(c.holders.s1.population.request); },
    c => { s1Response(c).raw = 'x'; },
    c => { c.scope = archived(c.scope); },
    c => { c.x.pages[0].body = archived(c.x.pages[0].body); },
    c => { c.x.observations[0] = archived(c.x.observations[0]); },
    c => { c.dom[0].html = archived(c.dom[0].html); },
    c => { c.dex.body = archived(c.dex.body); },
    c => { c.method = V1; },
    c => { c.method = 'a24-raw-capture-v3'; },
  ];
  invalid([
    ['A24_CAPTURE_SCHEMA', toV2(capture(), ['s0'])],
    ['A24_CAPTURE_SCHEMA', toV2(capture(), ['s1'])],
    ['A24_CAPTURE_SCHEMA', toV2(capture(), [])],
    ...misplaced.map(change => ['A24_CAPTURE_SCHEMA', mut(change, asV2)] as [string, Any]),
  ]);
});

test('archived originals bind through the existing codec and the declared original hash and length', () => {
  const original = s1Response(capture());
  const container = (change: (o: Any) => void) => (c: Any) => { const o = JSON.parse(s1Response(c).archive); change(o); s1Response(c).archive = JSON.stringify(o); };
  // A container whose base64 ends in padding, so a non-canonical final symbol still decodes to the same compressed bytes.
  const padded = (() => { for (let k = 0; k < 64; k++) { const a = archived(bt(original.raw + ' '.repeat(k))); if (JSON.parse(a.archive).data.endsWith('=')) return a; } throw new Error('fixture: no padded container'); })();
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const badUtf8 = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":"', 'utf8'), Buffer.from([0xff]), Buffer.from('"}', 'utf8')]);
  const inner = archiveHolderPopulation(original.raw), nested = archiveHolderPopulation(inner);
  assert.equal(derive(mut(c => { c.holders.s1.population.response = padded; }, asV2)).quality, 'KNOWN');
  const A = 'A24_HOLDER_ARCHIVE_INVALID', H = 'A24_HOLDER_ARCHIVE_HASH';
  invalid([
    [H, mut(c => { s1Response(c).sha256 = sha(`${original.raw} `); }, asV2)],
    [H, mut(c => { s1Response(c).bytes += 1; }, asV2)],
    [H, mut(c => { c.holders.s1.population.response = { archive: nested, sha256: original.sha256, bytes: original.bytes }; }, asV2)],
    [A, mut(container(o => { o.sourceHash = sha(`${original.raw} `); }), asV2)],
    [A, mut(container(o => { o.sourceBytes += 1; }), asV2)],
    [A, mut(container(o => { o.method = 'advisory-window-archive-v1'; }), asV2)],
    [A, mut(container(o => { o.extra = 0; }), asV2)],
    [A, mut(c => { const { method, encoding, ...rest } = JSON.parse(s1Response(c).archive); s1Response(c).archive = JSON.stringify({ encoding, method, ...rest }); }, asV2)],
    [A, mut(c => { s1Response(c).archive = JSON.stringify(JSON.parse(s1Response(c).archive), null, 1); }, asV2)],
    [A, mut(container(o => { o.data = Buffer.concat([Buffer.from(o.data, 'base64'), Buffer.from([0x03, 0x00])]).toString('base64'); }), asV2)],
    [A, mut(container(o => { const b = Buffer.from(o.data, 'base64'); o.data = b.subarray(0, b.length - 8).toString('base64'); }), asV2)],
    [A, mut(c => { const o = JSON.parse(padded.archive), i = o.data.indexOf('=') - 1; o.data = o.data.slice(0, i) + B64[B64.indexOf(o.data[i]) + 1] + o.data.slice(i + 1); c.holders.s1.population.response = { ...padded, archive: JSON.stringify(o) }; }, asV2)],
    [A, mut(c => { c.holders.s1.population.response = { archive: rawContainer(badUtf8), sha256: hex(badUtf8), bytes: badUtf8.length }; }, asV2)],
    [A, mut(c => { s1Response(c).archive = 'not a container'; }, asV2)],
    // The codec unpacks exactly one level; a container nested inside it reaches the unchanged RPC validator as a non-RPC body.
    ['A24_RPC_RESPONSE', mut(c => { c.holders.s1.population.response = { archive: nested, sha256: sha(inner), bytes: Buffer.byteLength(inner, 'utf8') }; }, asV2)],
  ]);
});

test('v2 keeps the unchanged 8 MiB serialized packet and 20 MB original bounds', () => {
  invalid([
    ['A24_CAPTURE_SIZE', JSON.stringify(asV2()) + ' '.repeat(8_388_608)],
    ['A24_CAPTURE_SIZE', JSON.stringify(mut(c => { s1Response(c).archive = 'not a container'; }, asV2)) + ' '.repeat(8_388_608)],
  ]);
  const r = s1Response(capture()), edge = bt(r.raw + ' '.repeat(20_000_000 - r.bytes)), over = Buffer.from(`${edge.raw} `, 'utf8');
  const atEdge = derive(mut(c => { c.holders.s1.population.response = archived(edge); }, asV2));
  assert.deepEqual([atEdge.quality, atEdge.data!.holderGrowth.value!.h1], ['KNOWN', 3]);
  assert.throws(() => archiveHolderPopulation(over.toString('utf8')), /HOLDER_ARCHIVE_SOURCE_LIMIT/);
  invalid([['A24_HOLDER_ARCHIVE_INVALID', mut(c => { c.holders.s1.population.response = { archive: rawContainer(over), sha256: hex(over), bytes: over.length }; }, asV2)]]);
});

test('a constructed ~15 MB holder population pair is admitted through v2 inside the unchanged 8 MiB packet', () => {
  const big = capture(), owners = (n: number) => Array<bigint>(n).fill(1n);
  big.holders = { s0: endpoint(1000, T0, owners(37_000), T('11:01:00'), true), s1: endpoint(9000, T1, owners(37_100), T('11:02:00'), true) };
  const plain = JSON.stringify(big), raw = JSON.stringify(toV2(big));
  for (const s of ['s0', 's1']) assert.ok(big.holders[s].population.response.bytes > 15_000_000, s);
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 8_388_608, `${Buffer.byteLength(raw, 'utf8')}`);
  invalid([['A24_CAPTURE_SIZE', plain]]);
  const decoded: Any = decodeA24Capture(raw);
  assert.deepEqual([decoded.holders.s0.population.response, decoded.holders.s1.population.response], [big.holders.s0.population.response, big.holders.s1.population.response]);
  const v = derive(raw);
  assert.equal(v.quality, 'KNOWN', `${v.reasonCode}`);
  const h = v.data!.holderGrowth.value!;
  assert.deepEqual([h.h0, h.h1, h.rate.change, sourceVersion(v)], [37_000, 37_100, 100, V2]);
});

test('fresh live proof binds the v2 adapter, scope and decoded method; replay rejects any disagreement or orphan', async () => {
  const raw = JSON.stringify(asV2()), bundle: Any = await live(raw);
  const proof = JSON.parse(bundle.rawArtifacts['advisory-derivation']), ev = bundle.evidence.find((e: Any) => e.id === CAPTURE);
  assert.deepEqual([proof.method, proof.saturation, bundle.rawArtifacts[CAPTURE], ev.adapterVersion, ev.scope, ev.contentHash], ['advisory-provenance-v40', { captureId: CAPTURE }, raw, V2, { method: V2 }, sha(raw)]);
  const metric = a24Of(bundle.details.advisory.metrics);
  assert.deepEqual([metric.quality, metric.data], ['KNOWN', deriveA24FromCapture(raw, target, CUT, RUBRIC, [CAPTURE])]);
  assert.equal(sourceVersion(metric.data), V2);
  const replay = (change: (b: Any, p: Any) => void = () => {}) => {
    const b = structuredClone(bundle), p = structuredClone(proof);
    change(b, p);
    return () => reconstructAdvisory(target, CUT, b.details.baseline, b.evidence, b.rawArtifacts, p, b.thesis ?? null, b.features);
  };
  assert.deepEqual(replay()(), bundle.details.advisory);
  const captureRecord = (b: Any) => b.evidence.find((e: Any) => e.id === CAPTURE);
  const stray = (adapterVersion: string) => (b: Any) => { b.evidence.push({ ...captureRecord(b), id: 'a24-stray-copy', sourceId: 'local-config', adapterVersion }); b.rawArtifacts['a24-stray-copy'] = raw; };
  assert.doesNotThrow(replay(stray('live-v1')));
  const rejected: ((b: Any, p: Any) => void)[] = [
    stray(V1), stray(V2),
    (_b, p) => { p.saturation = null; },
    (_b, p) => { delete p.saturation; p.method = 'advisory-provenance-v36'; },
    b => { captureRecord(b).adapterVersion = V1; },
    b => { captureRecord(b).scope = { method: V1 }; },
    b => { Object.assign(captureRecord(b), { adapterVersion: V1, scope: { method: V1 } }); },
    b => { Object.assign(captureRecord(b), { adapterVersion: 'a24-raw-capture-v3', scope: { method: 'a24-raw-capture-v3' } }); },
    b => { captureRecord(b).scope = { method: V2, transport: 'archive' }; },
  ];
  for (const change of rejected) assert.throws(replay(change), /ADVISORY_PROOF_INVALID/);
  await assert.rejects(live(JSON.stringify(toV2(capture(), ['s0']))), /A24_CAPTURE_INVALID/);
  await assert.rejects(live(JSON.stringify(mut(c => { s1Response(c).bytes += 1; }, asV2))), /A24_CAPTURE_INVALID/);
  const dir = mkdtempSync(join(tmpdir(), 'meme-a24-v2-')), file = join(dir, 'case.sqlite');
  let service = new Service(file);
  try {
    const saved = service.analyzeLive(bundle), before = requests;
    service.close(); service = new Service(file);
    assert.deepEqual(service.replay(saved.id), saved);
    assert.equal(requests, before);
    const tamper: ((b: Any) => void)[] = [
      b => { captureRecord(b).adapterVersion = V1; },
      b => { Object.assign(captureRecord(b), { adapterVersion: V1, scope: { method: V1 } }); },
      b => { const c = JSON.parse(b.rawArtifacts[CAPTURE]); c.method = V1; b.rawArtifacts[CAPTURE] = JSON.stringify(c); },
      b => { const c = JSON.parse(b.rawArtifacts[CAPTURE]); c.holders.s1.population.response.bytes += 1; b.rawArtifacts[CAPTURE] = JSON.stringify(c); },
      b => { const c = JSON.parse(b.rawArtifacts[CAPTURE]); c.holders.s0.population.response = capture().holders.s0.population.response; b.rawArtifacts[CAPTURE] = JSON.stringify(c); },
    ];
    for (const change of tamper) { const bad = structuredClone(bundle); change(bad); rehash(bad); assert.throws(() => service.analyzeLive(bad), /ADVISORY_PROOF_INVALID/); }
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('CLI --a24-capture reads a v2 file through the unchanged reader and saves its v2 binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meme-a24-cli-')), file = join(dir, 'capture.json'), raw = JSON.stringify(asV2());
  writeFileSync(file, raw);
  let out = '';
  try {
    const code = await runCli(['analyze', MINT, '--partial', '--advisory', '--a24-capture', file, '--db', join(dir, 'dd.sqlite'), '--json'], { env: {}, fetcher, now: () => CUT, isInteractive: false, stdout: text => { out += text; }, stderr: () => {} });
    assert.equal(code, 0);
    const snapshot = JSON.parse(out), ev = snapshot.evidence.find((e: Any) => e.id === CAPTURE);
    assert.deepEqual([ev.adapterVersion, ev.scope, ev.contentHash, a24Of(snapshot.details.advisory.metrics).quality], [V2, { method: V2 }, sha(raw), 'KNOWN']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// v2 DOM grammar: native mixed-case SVG element names only inside SVG context; the exported parser and v1 keep the frozen lowercase grammar.
const SVG = `<div${attr('aria-label', 'Constructed chart card')}><svg${attr('viewBox', '0 0 10 10')}${attr('aria-label', 'Constructed chart')}><title>Constructed chart title</title><defs><clipPath${attr('id', 'constructed-clip')}><rect${attr('x', '0')}${attr('width', '10')}></rect></clipPath><linearGradient${attr('id', 'constructed-fill')}${attr('x1', '0')}><stop${attr('offset', '0%')}${attr('stop-color', '#00BA7C')}></stop></linearGradient></defs><g${attr('clip-path', 'url(#constructed-clip)')}${attr('aria-label', 'Constructed series')}><text>Constructed svg text</text><path${attr('fill', 'url(#constructed-fill)')}${attr('d', 'M0,0L10,10')}></path></g></svg></div>`;
const withSvg = (fragment: string) => html(POSTS.a).replace('</article>', `${fragment}</article>`);
/** Unreviewed capture whose first retained article carries the fragment; v2 unless v1 is asked for. */
const svgCapture = (fragment = SVG, method: string = V2) => { const c = capture({ reviews: false }); c.dom[0] = { ...domOf(POSTS.a), html: bt(withSvg(fragment)) }; return method === V2 ? toV2(c) : c; };
const domCode = (code: string) => (e: unknown) => e instanceof CaptureInvalid && e.code === code;

test('native clipPath and linearGradient stay rejected by the exported parser and v1, and are admitted only through v2', () => {
  assert.throws(() => parseArticle(withSvg(SVG)), domCode('A24_DOM_ATTRIBUTE'));
  assert.equal(parseArticle(html(POSTS.a)).tag, 'article');
  const v1 = svgCapture(SVG, V1);
  invalid([['A24_DOM_ATTRIBUTE', v1]]);
  assert.throws(() => previewA24Classification(JSON.stringify(v1), target, CUT, RUBRIC), domCode('A24_DOM_ATTRIBUTE'));
  const base: Any = previewA24Classification(JSON.stringify(toV2(capture({ reviews: false }))), target, CUT, RUBRIC);
  const raw = JSON.stringify(svgCapture()), { packet, prompt }: Any = previewA24Classification(raw, target, CUT, RUBRIC);
  const of = (p: Any, id: string) => p.dom.find((d: Any) => d.postId === id);
  assert.deepEqual([packet.posts, of(packet, POSTS.b.id)], [base.packet.posts, of(base.packet, POSTS.b.id)]);
  const a0 = of(base.packet, POSTS.a.id);
  assert.deepEqual(of(packet, POSTS.a.id), { postId: POSTS.a.id, sha256: sha(withSvg(SVG)), textNodes: [...a0.textNodes, 'Constructed chart title', 'Constructed svg text'], labels: [...a0.labels, 'Constructed chart card', 'Constructed chart', 'Constructed series'] });
  const reviewed = review(svgCapture()), v = derive(reviewed);
  assert.deepEqual([v.quality, v.reasonCode, sourceVersion(v), v.data!.callerBreadth.value!.callers, v.data!.paidVisibility.x.value!.inspectedPosts], ['KNOWN', null, V2, 2, 2]);
  assert.equal(reviewed.classifications.first.prompt, prompt);
});

test('v2 SVG admission is context-bound, exact and case-sensitive; every existing DOM gate still applies after SVG content', () => {
  const svgOf = (inner: string) => `<svg${attr('viewBox', '0 0 1 1')}>${inner}</svg>`;
  const clip = (open = 'clipPath', close = open) => `<${open}${attr('id', 'c')}></${close}>`;
  invalid([
    ['A24_DOM_TAG', svgCapture('<Span>x</Span>')],
    ['A24_DOM_ATTRIBUTE', svgCapture('<sPan>x</sPan>')],
    ['A24_DOM_ATTRIBUTE', svgCapture(`<div>${clip()}</div>`)],
    ['A24_DOM_ATTRIBUTE', svgCapture(svgOf(`<foreignObject><div>${clip()}</div></foreignObject>`))],
    ['A24_DOM_TAG', svgCapture(svgOf(clip('ClipPath')))],
    ['A24_DOM_ATTRIBUTE', svgCapture(svgOf(clip('linearGradientX')))],
    ['A24_DOM_NESTING', svgCapture(svgOf(clip('clipPath', 'clippath')))],
    ['A24_DOM_NESTING', svgCapture(svgOf(clip('clippath', 'clipPath')))],
    ['A24_DOM_NESTING', svgCapture(svgOf(`<clipPath${attr('id', 'c')}>`))],
    ['A24_DOM_ATTRIBUTE', svgCapture(svgOf(`<clipPath${attr('id', 'c')}${attr('id', 'd')}></clipPath>`))],
    ['A24_DOM_ENTITY', svgCapture(svgOf(`<clipPath${attr('id', '&copy;')}></clipPath>`))],
    ['A24_DOM_BINDING', svgCapture(svgOf(`<g${attr('data-testid', `${POSTS.a.author}-follow`)}></g>`))],
    ['A24_DOM_BINDING', svgCapture(svgOf(`<g><time${attr('datetime', POSTS.a.at)}>t</time></g>`))],
    ['A24_DOM_BINDING', svgCapture(svgOf(`<foreignObject><article${attr('data-testid', 'tweet')}></article></foreignObject>`))],
    ['A24_DOM_HASH', mut(c => { c.dom[0].html.raw = c.dom[0].html.raw.replace('Constructed svg text', 'Constructed svg texT'); }, () => svgCapture())],
    ['A24_DOM_BINDING', mut(c => { c.dom[0].sourceUrl = `https://x.com/constructed222/status/${POSTS.b.id}`; }, () => svgCapture())],
  ]);
  const fo: Any = previewA24Classification(JSON.stringify(svgCapture(svgOf(`<foreignObject${attr('width', '1')}><div${attr('title', 'Constructed html label')}>Constructed html in svg</div></foreignObject>`))), target, CUT, RUBRIC);
  const dom = fo.packet.dom.find((d: Any) => d.postId === POSTS.a.id);
  assert.deepEqual([dom.textNodes.at(-1), dom.labels.at(-1)], ['Constructed html in svg', 'Constructed html label']);
});

test('live v2 retains the SVG article and reconstructs it under the v2 binding', async () => {
  const raw = JSON.stringify(review(svgCapture())), bundle: Any = await live(raw), proof = JSON.parse(bundle.rawArtifacts['advisory-derivation']);
  const metric = a24Of(bundle.details.advisory.metrics);
  assert.deepEqual([metric.quality, metric.data], ['KNOWN', deriveA24FromCapture(raw, target, CUT, RUBRIC, [CAPTURE])]);
  assert.deepEqual(reconstructAdvisory(target, CUT, bundle.details.baseline, bundle.evidence, bundle.rawArtifacts, proof, bundle.thesis ?? null, bundle.features), bundle.details.advisory);
});
