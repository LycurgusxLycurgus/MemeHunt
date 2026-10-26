import assert from 'node:assert/strict';
import test from 'node:test';
import { collectExecutorSocialBodies, decodeExecutorSocialBodies } from '../src/providers/executor-social-bodies.js';
import { callerHistoryKey, callerHistoryRequests, type CallerProvider } from '../src/providers/advisory-caller-history.js';
import { qualifyExecutorSemantic } from '../src/providers/executor-semantic.js';
import type { SocialInput } from '../src/domain/social.js';
import type { TokenRef } from '../src/domain/contracts.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const TOKEN: TokenRef = { chain: 'solana', address: MINT };
const START = '2026-10-10T12:00:00.000Z', END = '2026-10-11T12:00:00.000Z';
const CLOCK = '2026-10-11T12:00:30.000Z', EXEC_AT = '2026-10-11T12:01:00.000Z', CUTOFF = '2026-10-11T12:03:00.000Z';
const LIMIT = 8 * 1024 * 1024, PAID = 'Paid partnership';
const NL = String.fromCharCode(10), CRLF = String.fromCharCode(13) + NL;
const ROCKET = String.fromCodePoint(0x1f680), FIRE = String.fromCodePoint(0x1f525), EYES = String.fromCodePoint(0x1f440);
// Native bodies: CRLF, a trailing newline and astral code points must survive byte-exact.
const BODY_A = `Loading up on $ALPHA now${CRLF}CA: ${MINT}${CRLF}Not leaving ${ROCKET}${NL}`;
const BODY_B = `Second leg incoming ${MINT} ${FIRE}`;
const cp = (s: string) => Array.from(s).length;
const ms = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString();
const minute = (at: string) => at.slice(0, 16) + ':00.000Z';
const idAt = (iso: string, seq: bigint) => String(((BigInt(Date.parse(iso)) - 1288834974657n) << 22n) + seq);

type Source = SocialInput['sources'][number];
type Spec = { handle: string; id: string; at: string; body: string } & Record<CallerProvider, any>;
/** Minimal legacy triplet: official text equals FX raw text, no facets, unedited, real snowflake. */
function status(handle: string, at: string, body: string, seq = 1n): Spec {
  const id = idAt(at, seq), Handle = handle.toUpperCase();
  return { handle, id, at, body,
    oembed: { url: `https://twitter.com/${Handle}/status/${id}`, author_name: Handle, author_url: `https://twitter.com/${Handle}`, html: '<blockquote class=twitter-tweet><p>synthetic</p></blockquote>', type: 'rich', version: '1.0' },
    syndication: { __typename: 'Tweet', id_str: id, created_at: at, display_text_range: [0, body.length], entities: {}, text: body, user: { screen_name: Handle },
      edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(at) + 3_600_000), edits_remaining: '5', is_edit_eligible: true }, isEdited: false, isStaleEdit: false },
    fxtwitter: { code: 200, message: 'OK', tweet: { url: `https://x.com/${Handle}/status/${id}`, id, text: body, raw_text: { text: body, display_text_range: [0, cp(body)], facets: [] },
      author: { screen_name: Handle, followers: 1 }, created_at: 'synthetic', created_timestamp: Date.parse(at) / 1000, is_note_tweet: false, replying_to: null, replying_to_status: null, reposted_by: null } } };
}
const A = () => status('alpha_caller', '2026-10-11T07:00:37.000Z', BODY_A);
const B = () => status('beta_caller', '2026-10-11T10:15:12.000Z', BODY_B);
// TinyFish-style rendered text: coarse-minute dates, flattened body, optional paid label.
const rendered = (s: Spec, label = '', suffix = '') => `${label}${s.handle} on X: ${s.body.split(CRLF).join(' ').trim()}${suffix} / X`;
const post = (id: string, s: Spec, publishedAt: string | null = minute(s.at), text = rendered(s)) =>
  ({ id, url: `https://x.com/${s.handle}/status/${s.id}`, text, publishedAt, authorId: `x.com:${s.handle}`, availableAt: END, kind: 'POST' }) as Source;
const PAGE = { id: 'page-1', url: 'https://community.example/alpha', text: `Community page for ${MINT}`, publishedAt: null, authorId: 'community.example', availableAt: END, kind: 'PAGE' } as unknown as Source;
function readOf(targets: Source[], extra: Source[] = [PAGE]): SocialInput {
  return { schemaVersion: 1, start: START, end: END, targetPostIds: targets.map(s => s.id), identitySourceIds: [], sampleComplete: true, identityComplete: false, previousComparable: true,
    codes: ['TINYFISH_RENDERED'], queries: [MINT], sources: [...targets, ...extra] } as SocialInput;
}
function base() {
  const a = A(), b = B(), old = status('old_caller', '2026-10-09T08:00:00.000Z', `Old call ${MINT}`);
  return { a, b, specs: [a, b, old], read: readOf([post('orig-a', a, undefined, rendered(a, `${PAID} | `)), post('orig-b', b), post('orig-old', old, old.at)]) };
}
function clock(start = CLOCK) {
  let t = Date.parse(start); const times: string[] = [];
  return { times, now: () => { const v = new Date(t).toISOString(); t += 1000; times.push(v); return v; } };
}
const providerOf = (url: string): CallerProvider => url.startsWith('https://publish.twitter.com/') ? 'oembed' : url.startsWith('https://cdn.syndication.twimg.com/') ? 'syndication' : 'fxtwitter';
type Override = (provider: CallerProvider, spec: Spec) => Response | undefined;
function fetcherFor(specs: Spec[], seen: string[], override?: Override): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input), provider = providerOf(url), spec = specs.find(s => url.includes(s.id)); seen.push(url);
    if (!spec) return new Response('not found', { status: 404 });
    return override?.(provider, spec) ?? new Response(JSON.stringify(spec[provider]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const collect = (read: SocialInput, specs: Spec[], seen: string[] = [], override?: Override, now = clock().now) =>
  collectExecutorSocialBodies(read, TOKEN, fetcherFor(specs, seen, override), now, new AbortController().signal);
const decode = (capture: string, cutoff = CUTOFF, token: TokenRef = TOKEN) => decodeExecutorSocialBodies(capture, token, cutoff);
const byId = (read: SocialInput, id: string) => read.sources.find(s => s.id === id)!;
const textSum = (read: SocialInput) => read.sources.reduce((n, s) => n + s.text.length, 0);

function walk(root: unknown, visit: (holder: Record<string, unknown>, key: string, value: unknown) => void): void {
  if (root && typeof root === 'object') for (const [key, value] of Object.entries(root)) { visit(root as Record<string, unknown>, key, value); walk(value, visit); }
}
const holders = (root: unknown, name: string) => { const out: Array<Record<string, any>> = []; walk(root, (holder, key) => { if (key === name) out.push(holder); }); return out; };
function strings(root: unknown): string[] { const out: string[] = []; walk(root, (_h, _k, value) => { if (typeof value === 'string') out.push(value); }); return out; }

test('fresh triplets compound only dated current targets; context, page, original read and paid label stay exact', async () => {
  const { a, b, specs, read } = base(), seen: string[] = [], c = clock();
  const out = await collect(read, specs, seen, undefined, c.now);
  assert.equal(seen.length, 6, 'three reads for each of the two in-window statuses only');
  assert.ok(seen.every(url => url.includes(a.id) || url.includes(b.id)));
  const cap = JSON.parse(out.capture);
  assert.equal(cap.method, 'executor-social-bodies-v1'); assert.equal(JSON.stringify(cap), out.capture);
  for (const key of ['original', 'selection', 'startedAt', 'finishedAt', 'rawArtifacts']) assert.ok(key in cap, key);
  assert.deepEqual(cap.original, read);
  assert.equal(Object.keys(callerHistoryRequests(cap.selection)).length, 6); assert.deepEqual(Object.keys(cap.rawArtifacts).sort(), Object.keys(callerHistoryRequests(cap.selection)).sort());
  assert.deepEqual(cap.selection.queries, read.queries); assert.equal(cap.selection.period.end, END);
  assert.deepEqual(cap.selection.posts.map((p: any) => p.url).sort(), [a, b].map(s => `https://x.com/${s.handle}/status/${s.id}`).sort());
  const decoded = decode(out.capture);
  assert.deepEqual(decoded.read, out.read); assert.deepEqual(decoded.bodyBySourceId, out.bodyBySourceId); assert.deepEqual(decoded.originalRead, read);
  assert.deepEqual(out.bodyBySourceId, { 'orig-a': BODY_A, 'orig-b': BODY_B });
  assert.deepEqual(out.read.targetPostIds, read.targetPostIds); assert.deepEqual(out.read.sources.map(s => s.id), read.sources.map(s => s.id));
  for (const id of ['orig-old', 'page-1']) assert.equal(JSON.stringify(byId(out.read, id)), JSON.stringify(byId(decoded.originalRead, id)), id);
  assert.equal(out.read.sampleComplete, true);
  assert.deepEqual(out.read.codes.slice(0, read.codes.length), read.codes);
  const receipts = Object.values(cap.rawArtifacts as Record<string, string>).map(raw => JSON.parse(raw));
  const latest = (id: string) => receipts.filter(r => String(r.request).includes(id)).map(r => String(r.retrievedAt)).sort().at(-1)!;
  assert.equal(decoded.availableAt, cap.finishedAt);
  assert.ok(decoded.availableAt >= receipts.map(r => String(r.retrievedAt)).sort().at(-1)!);
  for (const [id, s] of [['orig-a', a], ['orig-b', b]] as Array<[string, Spec]>) {
    const src = byId(out.read, id), orig = byId(read, id);
    assert.equal(src.url, `https://x.com/${s.handle}/status/${s.id}`); assert.equal(src.authorId, `x.com:${s.handle}`);
    // Official second differs from the coarse rendered minute yet both sit inside the window: accepted, never restamped.
    assert.equal(src.publishedAt, s.at); assert.notEqual(src.publishedAt, orig.publishedAt);
    assert.ok(c.times.includes(src.availableAt), 'availableAt is a real receipt clock'); assert.ok(src.availableAt >= latest(s.id));
    const at = src.text.indexOf(s.body);
    assert.ok(at > 0, `${id}: trust prefix precedes the native body`);
    assert.ok(src.text.endsWith(orig.text), `${id}: entire original rendered text retained`);
    assert.ok(at + s.body.length < src.text.length - orig.text.length, `${id}: separator between body and original`);
  }
  assert.ok(byId(out.read, 'orig-a').text.includes(PAID)); assert.ok(!out.bodyBySourceId['orig-a']!.includes(PAID));
});

test('an incomplete second triplet keeps its original source and target, drops nothing and marks the read incomplete', async () => {
  const { a, b, specs, read } = base();
  const out = await collect(read, specs, [], (provider, spec) => provider === 'fxtwitter' && spec.id === b.id
    ? new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND', tweet: null }), { status: 404 }) : undefined);
  assert.deepEqual(out.bodyBySourceId, { 'orig-a': BODY_A });
  assert.ok(byId(out.read, 'orig-a').text.includes(BODY_A)); assert.equal(byId(out.read, 'orig-a').publishedAt, a.at);
  assert.deepEqual(byId(out.read, 'orig-b'), byId(read, 'orig-b'));
  assert.deepEqual(out.read.targetPostIds, read.targetPostIds); assert.equal(out.read.sources.length, read.sources.length);
  assert.equal(out.read.sampleComplete, false);
  assert.ok(out.read.codes.some(code => code.includes('orig-b'))); assert.ok(!out.read.codes.some(code => code.includes('orig-a')));
  assert.deepEqual(decode(out.capture).read, out.read);
});

test('undated targets remain explicit unresolved gaps without speculative current-window selection', async () => {
  const c = status('charlie_caller', '2026-10-11T09:00:05.000Z', `Watching ${MINT} closely`), d = status('delta_caller', '2026-10-09T09:00:00.000Z', `Earlier ${MINT}`);
  const read = readOf([post('orig-c', c, null), post('orig-d', d, null)], []), seen: string[] = [];
  const out = await collect(read, [c, d], seen);
  assert.equal(seen.length, 0);
  assert.deepEqual(Object.keys(out.bodyBySourceId), []); assert.deepEqual(byId(out.read, 'orig-c'), byId(read, 'orig-c'));
  assert.ok(out.read.codes.some(code=>code.includes('orig-c')));
  assert.deepEqual(byId(out.read, 'orig-d'), byId(read, 'orig-d')); assert.deepEqual(out.read.targetPostIds, read.targetPostIds);
  assert.equal(out.read.sampleComplete, false); assert.ok(out.read.codes.some(code => code.includes('orig-d')));
});

test('selections over 32 statuses or with duplicate statuses are refused before any read', async () => {
  const many = Array.from({ length: 33 }, (_, i) => { const s = status(`caller_${i}`, ms('2026-10-11T01:00:00.000Z', i * 60000), `Call ${i} ${MINT}`); return post(`orig-${i}`, s); });
  const seen: string[] = [];
  const capped=await collect(readOf(many, []), [], seen);
  assert.equal(capped.read.sampleComplete,false);assert.deepEqual(capped.bodyBySourceId,{});assert.equal(capped.read.targetPostIds.length,33);
  const a = A();
  const duplicated=await collect(readOf([post('orig-a', a), post('orig-a2', a)], []), [a], seen);
  assert.equal(duplicated.read.sampleComplete,false);assert.deepEqual(duplicated.bodyBySourceId,{});assert.equal(duplicated.read.targetPostIds.length,2);
  assert.equal(seen.length, 0);
});

test('capture binding: token, source, membership, selection, request, clock, redirect and canonical bytes are strict', async () => {
  const { a, specs, read } = base(), out = await collect(read, specs), key = (p: CallerProvider) => callerHistoryKey(a.id, p);
  const receipt = (cap: any, p: CallerProvider, patch: Record<string, unknown>) => { cap.rawArtifacts[key(p)] = JSON.stringify({ ...JSON.parse(cap.rawArtifacts[key(p)]), ...patch }); };
  const mutations: Array<[string, (cap: any) => void]> = [
    ['method', c => { c.method = 'executor-social-bodies-v0'; }],
    ['original source text', c => { c.original.sources[0].text += ' altered'; }],
    ['original target dropped', c => { c.original.targetPostIds.pop(); }],
    ['extra orphan raw', c => { c.rawArtifacts.extra = '{}'; }],
    ['missing receipt', c => { delete c.rawArtifacts[key('oembed')]; }],
    ['modified selection', c => { c.selection.queries = ['other']; }],
    ['frozen clock', c => { c.startedAt = ms(c.startedAt, 1000); }],
    ['request url', c => { c.rawArtifacts[key('fxtwitter')]=JSON.stringify({...JSON.parse(c.rawArtifacts[key('fxtwitter')]),statusUrl:'https://x.com/other/status/1'}); }],
    ['receipt request binding', c => receipt(c, 'fxtwitter', { request: 'https://api.fxtwitter.com/other/status/1' })],
    ['backdated receipt', c => receipt(c, 'fxtwitter', { retrievedAt: '2026-10-11T11:00:00.000Z' })],
    ['future receipt', c => receipt(c, 'fxtwitter', { retrievedAt: ms(CUTOFF, 60000) })],
    ['redirect', c => receipt(c, 'oembed', { finalUrl: 'https://elsewhere.example/oembed' })],
    ['invalid receipt', c => receipt(c, 'syndication', { status: null })],
  ];
  for (const [name, mutate] of mutations) {
    const cap = JSON.parse(out.capture); mutate(cap);
    assert.throws(() => decode(JSON.stringify(cap)), Error, name);
  }
  assert.throws(() => decode(JSON.stringify(JSON.parse(out.capture), null, 1)), Error, 'noncanonical bytes');
  assert.throws(() => decode(out.capture, CUTOFF, { ...TOKEN, address: '11111111111111111111111111111111' }), Error, 'token');
  assert.throws(() => decode(out.capture, CLOCK), Error, 'cutoff before receipts');
});

test('a tampered official id inside a canonical receipt never yields a known body', async () => {
  const { a, specs, read } = base(), out = await collect(read, specs);
  for (const p of ['syndication', 'fxtwitter'] as const) {
    const cap = JSON.parse(out.capture), k = callerHistoryKey(a.id, p), r = JSON.parse(cap.rawArtifacts[k]), body = JSON.parse(r.body);
    if (p === 'syndication') body.id_str = '1234567890123456789'; else body.tweet.id = '1234567890123456789';
    r.body = JSON.stringify(body); cap.rawArtifacts[k] = JSON.stringify(r);
    let decoded: ReturnType<typeof decodeExecutorSocialBodies>;
    try { decoded = decode(JSON.stringify(cap)); } catch { continue; }
    assert.equal(decoded.bodyBySourceId['orig-a'], undefined, p); assert.equal(decoded.read.sampleComplete, false, p);
    assert.deepEqual(byId(decoded.read, 'orig-a'), byId(read, 'orig-a'), p); assert.equal(decoded.bodyBySourceId['orig-b'], BODY_B, p);
  }
});

test('source corpus over 120k characters and captures over 8 MiB are refused, never truncated', async () => {
  const a = A();
  await assert.rejects(async () => collect(readOf([post('orig-a', a, undefined, 'y'.repeat(120_001))], []), [a]));
  const near = readOf([post('orig-a', a, undefined, 'y'.repeat(120_000 - BODY_A.length))], []);
  assert.equal(textSum(near), 120_000 - BODY_A.length);
  const over=await collect(near,[a]);
  assert.equal(over.read.sampleComplete,false);assert.deepEqual(over.bodyBySourceId,{});assert.deepEqual(over.read.sources,near.sources);assert.ok(over.read.codes.includes('CALLER_BODY_CORPUS_CAP'));
  const { specs, read } = base(), out = await collect(read, specs);
  assert.throws(() => decode('x'.repeat(LIMIT + 1)));
  assert.throws(() => decode(out.capture + ' '.repeat(LIMIT)));
});

// v2 executor harness: deterministic direct-JSON answers built from the packet canonical and the native body map only.
type Call = { protocol: string; stage: string; executor: string; packet: string; executionId: string; response?: string };
type Respond = (key: string, json: string, canonical: any) => string;
const family = (protocol: string) => protocol.includes('social') ? 'social' : 'advisory';
const spans = (source: any): any[] => [...(source.spans ?? [])].sort((x: any, y: any) => (x.start ?? 0) - (y.start ?? 0));
const textOf = (source: any): string => typeof source.text === 'string' ? source.text : spans(source).map(s => s.text).join('');
const spanIn = (source: any, needle: string, body?: string): string => (spans(source).find(s => String(s.text).includes(needle) && (!body || body.includes(s.text)))
  ?? spans(source).find(s => String(s.text).includes(needle)) ?? spans(source)[0])?.id ?? `${source.id}:span:0`;
/** The line range whose joined text is exactly the native body; exact joins first, then a trailing terminator. */
function lineRange(source:any,body:string):{firstLineId:string;lastLineId:string}|null{
 const text=textOf(source),offsets:Array<{start:number;end:number}>=[];let offset=0;
 for(const match of text.matchAll(/\r\n|\r|\n/g)){offsets.push({start:offset,end:match.index!});offset=match.index!+match[0].length;}offsets.push({start:offset,end:text.length});
 const start=text.indexOf('\n')+1,end=start+body.length,first=offsets.findIndex(x=>x.start===start),last=offsets.findIndex(x=>x.end===end);
 return first>=0&&last>=first&&text.slice(start,end)===body?{firstLineId:source.lines[first].id,lastLineId:source.lines[last].id}:null;
}
function socialProposal(canonical: any, bodies: Record<string, string>) {
  const sourceOf = (id: string) => canonical.sources.find((s: any) => s.id === id), first = sourceOf(canonical.requiredPostIds[0]);
  const citation = { sourceId: first.id, spanId: spanIn(first, MINT, bodies[first.id]) };
  const assessment = (name: string) => ({ verdict: 'UNRESOLVED', rationale: `The synthetic scope cannot establish a complete ${name} assessment.`, citations: [citation] });
  const posts = canonical.requiredPostIds.map((sourceId: string) => {
    const source = sourceOf(sourceId), body = bodies[sourceId];
    return { sourceId, body: (body === undefined ? null : lineRange(source, body)) ?? { firstLineId: source.lines[0].id, lastLineId: source.lines.at(-1).id },
      role: 'ORIGINAL', binding: 'EXACT_CONTRACT', bindingProof: [], parentSourceId: null, origin: null, community: null, campaign: null, metrics: { likes: null, replies: null, reposts: null } };
  });
  return { identityAssessment: assessment('identity'), integrityAssessment: assessment('integrity'), posts, identities: [], accounts: [] };
}
function socialReview(canonical: any) {
  const proposal = canonical.proposal;
  const ids: string[] = canonical.requiredDecisionIds ?? [
    ...(proposal.identityAssessment ? ['assessment:identity'] : []), ...(proposal.integrityAssessment ? ['assessment:integrity'] : []),
    ...proposal.posts.map((p: any) => `post:${p.sourceId}`), ...proposal.identities.map((row: any) => `identity:${row.id}`), ...proposal.accounts.map((row: any) => `account:${row.accountId}`)];
  return {
    decisions: Object.fromEntries(ids.map(id => [id, { accepted: true, rationale: 'The cited retained source supports this record.' }])),
    sources: canonical.sources.map((source: any) => ({ sourceId: source.id, complete: true, rationale: 'The full retained source text was inspected.' })),
    pairs: Object.fromEntries((canonical.pairs ?? []).map((pair: any) => [pair.id, { relation: 'DISTINCT_COMMENTARY', rationale: 'Each post carries distinct commentary.' }])),
  };
}
const advisoryProposal = (canonical: any, bodies: Record<string, string>) => ({
  sources: canonical.sources.map((source: any) => ({ id: source.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: 'CRYPTO_CALLER', topic: 'OTHER', artifact: 'NONE', theme: null,
    paidDisclosure: 'NOT_OBSERVED', incentives: [], citations: [{ sourceId: source.id, spanId: spanIn(source, MINT, bodies[source.id]) }],
    rationale: 'Explicit prospective buy call naming the literal contract in crypto caller context.' })),
  persistence: null,
});
const advisoryReview = (canonical: any) => ({ sources: canonical.sources.map((source: any) => ({ id: source.id, complete: true, accepted: true })), persistence: false });
const wire = (protocol: string, stage: string, canonical: any, bodies: Record<string, string>) => family(protocol) === 'social'
  ? (stage === 'proposal' ? socialProposal(canonical, bodies) : socialReview(canonical))
  : (stage === 'proposal' ? advisoryProposal(canonical, bodies) : advisoryReview(canonical));
function harness(bodies: Record<string, string>, respond?: Respond) {
  const calls: Call[] = [], { now } = clock(EXEC_AT);
  const executor = async (request: { protocol: string; stage: string; executor: string; packet: string; signal: AbortSignal }) => {
    const call: Call = { protocol: request.protocol, stage: request.stage, executor: request.executor, packet: request.packet, executionId: `exec:${request.protocol}:${request.stage}` };
    calls.push(call);
    const canonical = JSON.parse(request.packet).canonical, json = JSON.stringify(wire(request.protocol, request.stage, canonical, bodies));
    call.response = respond ? respond(`${family(request.protocol)}:${request.stage}`, json, canonical) : json;
    return { response: call.response, executionId: call.executionId, modelId: null, modelIdSource: 'UNREPORTED' as const, tools: 'NONE' as const, freshSession: true as const };
  };
  return { calls, now, executor };
}
async function runV2(fx: { read: SocialInput; bodyBySourceId: Record<string, string> }, respond?: Respond) {
  const h = harness(fx.bodyBySourceId, respond);
  const out = await qualifyExecutorSemantic(fx.read, TOKEN, h.executor, h.now, new AbortController().signal, { wire: 'v2', bodyBySourceId: fx.bodyBySourceId });
  return { ...h, out };
}
async function current(extra?: Spec) {
  const { a, b } = base();
  const targets = [post('orig-a', a, undefined, rendered(a, `${PAID} | `)), post('orig-b', b), ...(extra ? [post('orig-c', extra, undefined, rendered(extra, '', ` CA ${MINT}`))] : [])];
  return collect(readOf(targets), extra ? [a, b, extra] : [a, b]);
}
const counts = (calls: Call[]) => [['social', 'proposal'], ['social', 'review'], ['advisory', 'proposal'], ['advisory', 'review']]
  .map(([f, s]) => calls.filter(c => family(c.protocol) === f && c.stage === s).length);
const callOf = (calls: Call[], f: string, s: string) => calls.find(c => family(c.protocol) === f && c.stage === s)!;
const retained = (capture: string, call: Call) => strings(JSON.parse(capture)).includes(call.response!);

test('v2 qualifies native bodies through fixed full-body line selectors; the five-argument v1 path is unchanged', async () => {
  const fx = await current(), r = await runV2(fx);
  assert.equal(r.out.code, null); assert.deepEqual(counts(r.calls), [1, 1, 1, 1], 'one attempt per stage');
  assert.equal(JSON.parse(r.out.capture).method, 'executor-current-semantic-v2');
  assert.ok(r.calls.some(c => /social-v2$/.test(c.protocol)) && r.calls.some(c => /advisory-v2$/.test(c.protocol)));
  assert.ok(r.calls.every(c => /-v2$/.test(c.protocol)));
  const packet = JSON.parse(callOf(r.calls, 'social', 'proposal').packet), contract = strings(packet.outputContract);
  assert.equal(Object.keys(fx.bodyBySourceId).length, 2);
  for (const [id, body] of Object.entries(fx.bodyBySourceId)) {
    assert.ok(body.includes(MINT), `${id}: positive binding carries the literal CA inside the native body`);
    const range = lineRange(packet.canonical.sources.find((s: any) => s.id === id), body);
    assert.ok(range, `${id}: native body is an exact line range of the canonical`);
    assert.ok(contract.includes(range.firstLineId) && contract.includes(range.lastLineId), `${id}: selectors fixed in outputContract`);
  }
  assert.equal(JSON.parse(callOf(r.calls, 'social', 'proposal').response!).posts.length, packet.canonical.requiredPostIds.length);
  const v1 = harness(fx.bodyBySourceId), legacy = await qualifyExecutorSemantic(fx.read, TOKEN, v1.executor, v1.now, new AbortController().signal);
  assert.equal(JSON.parse(legacy.capture).method, 'executor-current-semantic-v1');
  assert.deepEqual([...new Set(v1.calls.map(c => c.protocol))].sort(), ['executor-advisory-v1', 'executor-social-v1']);
});

test('v2 social proposal selecting anything but the exact native body fails before review; advisory pair unaffected', async () => {
  const fx = await current();
  const variants: Array<[string, (source: any, range: { firstLineId: string; lastLineId: string }) => unknown]> = [
    ['whole compound text', source => ({ firstLineId: source.lines[0].id, lastLineId: source.lines.at(-1).id })],
    ['first native line only', (_source, range) => ({ firstLineId: range.firstLineId, lastLineId: range.firstLineId })],
  ];
  for (const [name, select] of variants) {
    const r = await runV2(fx, (key, json, canonical) => {
      if (key !== 'social:proposal') return json;
      const out = JSON.parse(json), source = canonical.sources.find((s: any) => s.id === 'orig-a');
      out.posts.find((p: any) => p.sourceId === 'orig-a').body = select(source, lineRange(source, BODY_A)!);
      return JSON.stringify(out);
    });
    assert.notEqual(r.out.code, null, name); assert.deepEqual(counts(r.calls), [1, 0, 1, 1], name);
    assert.ok(retained(r.out.capture, callOf(r.calls, 'social', 'proposal')), `${name}: raw response retained`);
  }
});

test('v2 advisory rows must match the exact id enum and count; omissions, duplicates, foreign ids and envelopes fail at proposal', async () => {
  const fx = await current(), ok = await runV2(fx), packet = JSON.parse(callOf(ok.calls, 'advisory', 'proposal').packet);
  const ids: string[] = packet.canonical.sources.map((s: any) => s.id), n = ids.length;
  assert.ok(n >= 2);
  assert.ok(holders(packet.outputContract, 'minItems').some(h => h.minItems === n && h.maxItems === n), 'minItems = maxItems = N');
  assert.ok(holders(packet.outputContract, 'enum').some(h => Array.isArray(h.enum) && [...h.enum].sort().join() === [...ids].sort().join()), 'source id enum');
  const variants: Array<[string, (json: string) => string]> = [
    ['omitted', json => { const w = JSON.parse(json); w.sources.pop(); return JSON.stringify(w); }],
    ['duplicate', json => { const w = JSON.parse(json); w.sources[w.sources.length - 1] = structuredClone(w.sources[0]); return JSON.stringify(w); }],
    ['different id', json => { const w = JSON.parse(json); w.sources[w.sources.length - 1].id = 'not-a-source'; return JSON.stringify(w); }],
    ['gemini envelope', json => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: json }] } }] })],
  ];
  for (const [name, edit] of variants) {
    const r = await runV2(fx, (key, json) => key === 'advisory:proposal' ? edit(json) : json);
    assert.notEqual(r.out.code, null, name); assert.deepEqual(counts(r.calls), [1, 1, 1, 0], `${name}: no review, no retry`);
    assert.ok(retained(r.out.capture, callOf(r.calls, 'advisory', 'proposal')), `${name}: raw response retained`);
  }
});

test('EXACT_CONTRACT is rejected when the CA appears only in the original rendered title, not the native body', async () => {
  const c = status('charlie_caller', '2026-10-11T09:00:05.000Z', `Quiet accumulation, no ticker yet ${EYES}`), fx = await current(c);
  assert.ok(!fx.bodyBySourceId['orig-c']!.includes(MINT)); assert.ok(byId(fx.read, 'orig-c').text.includes(MINT));
  const r = await runV2(fx);
  assert.notEqual(r.out.code, null);
  assert.deepEqual(counts(r.calls), [1, 0, 1, 0], 'both native binding guards reject at proposal');
});

// v3: identical harness; only the ancillary bindingProof containment check is relaxed.
async function runV3(fx: { read: SocialInput; bodyBySourceId: Record<string, string> }, respond?: Respond) {
  const h = harness(fx.bodyBySourceId, respond);
  const out = await qualifyExecutorSemantic(fx.read, TOKEN, h.executor, h.now, new AbortController().signal, { wire: 'v3', bodyBySourceId: fx.bodyBySourceId });
  return { ...h, out };
}
const span0 = (canonical: any, id: string) => spans(canonical.sources.find((s: any) => s.id === id))[0];
const editPosts = (edit: (post: any, canonical: any) => void): Respond => (key, json, canonical) => {
  if (key !== 'social:proposal') return json;
  const out = JSON.parse(json); for (const p of out.posts) edit(p, canonical); return JSON.stringify(out);
};
const ownSpan0 = editPosts((p, canonical) => { p.bindingProof = [{ sourceId: p.sourceId, spanId: span0(canonical, p.sourceId).id }]; });

test('v3 qualifies a valid own-source span:0 bindingProof that crosses the trust header; v2 still records the frozen failure; v1 unchanged', async () => {
  const fx = await current(), v3 = await runV3(fx, ownSpan0);
  const canonical = JSON.parse(callOf(v3.calls, 'social', 'proposal').packet).canonical;
  for (const [id, body] of Object.entries(fx.bodyBySourceId)) {
    const text = String(span0(canonical, id).text);
    assert.ok(body.includes(MINT), `${id}: literal CA in native body`);
    assert.ok(!body.includes(text), `${id}: span 0 is not contained in the native body`);
  }
  assert.equal(v3.out.code, null); assert.deepEqual(counts(v3.calls), [1, 1, 1, 1], 'one attempt per stage');
  assert.equal(JSON.parse(v3.out.capture).method, 'executor-current-semantic-v3');
  assert.equal(callOf(v3.calls, 'social', 'proposal').protocol, 'executor-social-v3');
  const v2 = await runV2(fx, ownSpan0);
  assert.notEqual(v2.out.code, null); assert.deepEqual(counts(v2.calls), [1, 0, 1, 1], 'v2 fails at social proposal, no retry');
  assert.equal(JSON.parse(v2.out.capture).method, 'executor-current-semantic-v2');
  assert.ok(retained(v2.out.capture, callOf(v2.calls, 'social', 'proposal')), 'v2 raw response retained');
  const v1 = harness(fx.bodyBySourceId), legacy = await qualifyExecutorSemantic(fx.read, TOKEN, v1.executor, v1.now, new AbortController().signal);
  assert.equal(JSON.parse(legacy.capture).method, 'executor-current-semantic-v1');
  assert.deepEqual([...new Set(v1.calls.map(c => c.protocol))].sort(), ['executor-advisory-v1', 'executor-social-v1']);
});

test('v3 still fails before review on anything but the exact native body selectors', async () => {
  const fx = await current();
  const variants: Array<[string, (source: any, range: { firstLineId: string; lastLineId: string }) => unknown]> = [
    ['whole compound text', source => ({ firstLineId: source.lines[0].id, lastLineId: source.lines.at(-1).id })],
    ['first native line only', (_source, range) => ({ firstLineId: range.firstLineId, lastLineId: range.firstLineId })],
  ];
  for (const [name, select] of variants) {
    const r = await runV3(fx, editPosts((p, canonical) => {
      p.bindingProof = [{ sourceId: p.sourceId, spanId: span0(canonical, p.sourceId).id }];
      if (p.sourceId === 'orig-a') { const source = canonical.sources.find((s: any) => s.id === 'orig-a'); p.body = select(source, lineRange(source, BODY_A)!); }
    }));
    assert.notEqual(r.out.code, null, name); assert.deepEqual(counts(r.calls), [1, 0, 1, 1], name);
    assert.ok(retained(r.out.capture, callOf(r.calls, 'social', 'proposal')), `${name}: raw response retained`);
  }
});

test('v3 EXACT_CONTRACT still fails when the CA is only in the rendered title, even with a valid own-source proof', async () => {
  const c = status('charlie_caller', '2026-10-11T09:00:05.000Z', `Quiet accumulation, no ticker yet ${EYES}`), fx = await current(c);
  assert.ok(!fx.bodyBySourceId['orig-c']!.includes(MINT)); assert.ok(byId(fx.read, 'orig-c').text.includes(MINT));
  const r = await runV3(fx, ownSpan0);
  assert.notEqual(r.out.code, null); assert.deepEqual(counts(r.calls), [1, 0, 1, 0]);
});

test('v3 keeps PROVEN_ACCOUNT forbidden', async () => {
  const fx = await current();
  const r = await runV3(fx, editPosts((p, canonical) => {
    if (p.sourceId !== 'orig-a') return;
    p.binding = 'PROVEN_ACCOUNT';
    p.bindingProof = [{ sourceId: 'orig-a', spanId: span0(canonical, 'orig-a').id }, { sourceId: 'page-1', spanId: span0(canonical, 'page-1').id }];
  }));
  assert.notEqual(r.out.code, null); assert.deepEqual(counts(r.calls), [1, 0, 1, 1]);
});

test('v3 bindingProof refs with unknown or foreign spans still fail the canonical resolver', async () => {
  const fx = await current();
  const variants: Array<[string, (canonical: any) => unknown]> = [
    ['unknown span', () => ({ sourceId: 'orig-a', spanId: 'orig-a:span:missing' })],
    ['span of another source', canonical => ({ sourceId: 'orig-a', spanId: span0(canonical, 'orig-b').id })],
  ];
  for (const [name, ref] of variants) {
    const r = await runV3(fx, editPosts((p, canonical) => { if (p.sourceId === 'orig-a') p.bindingProof = [ref(canonical)]; }));
    assert.notEqual(r.out.code, null, name); assert.deepEqual(counts(r.calls), [1, 0, 1, 1], `${name}: no review, no retry`);
  }
});

test('v3 accepts an UNRELATED post whose own-source proof lies outside its native body; v2 rejects the same response', async () => {
  const c = status('charlie_caller', '2026-10-11T09:00:05.000Z', `Quiet accumulation, no ticker yet ${EYES}`), fx = await current(c);
  const respond = editPosts((p, canonical) => {
    p.bindingProof = [{ sourceId: p.sourceId, spanId: span0(canonical, p.sourceId).id }];
    if (p.sourceId === 'orig-c') p.binding = 'UNRELATED';
  });
  const v3 = await runV3(fx, respond), v2 = await runV2(fx, respond);
  assert.equal(counts(v3.calls)[0], 1); assert.equal(counts(v3.calls)[1], 1, 'v3 social proposal passes guardBodies');
  assert.equal(counts(v2.calls)[0], 1); assert.equal(counts(v2.calls)[1], 0, 'v2 frozen guard rejects');
});
