import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { EvidenceRecord } from '../src/domain/contracts.js';
import type { AdvisoryMetric } from '../src/domain/advisory-contracts.js';
import type { AdvisorySemantic } from '../src/providers/advisory-semantic.js';
import { callerHistoryKey, collectCallerHistory, decodeCallerHistory, type CallerHistory, type CallerProvider } from '../src/providers/advisory-caller-history.js';
import { CALLER_SEED_METHOD, CALLER_SELECTION_ID, callerSeedFromEvidence, deriveCallerHistoryMetrics, replayCallerHistory, supersedingCallerMetrics } from '../src/providers/advisory-caller-measures.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump', token = { chain: 'solana' as const, address: MINT };
const SCOPE_AT = '2026-10-11T23:00:00.000Z', FROZEN = '2026-10-12T00:00:00.000Z', RETRIEVED = '2026-10-12T00:00:05.000Z', CUTOFF = '2026-10-12T00:10:00.000Z';
const A_AT = '2026-09-29T12:00:00.000Z', B_AT = '2026-09-30T08:00:00.000Z';
const idAt = (iso: string, seq = 1n) => String(((BigInt(Date.parse(iso)) - 1288834974657n) << 22n) + seq);
type Spec = { handle: string; id: string; url: string; createdAt: string } & Record<CallerProvider, any>;
type Seed = { id: string; url: string; publishedAt: string | null; kind?: string };

/** Minimal ordinary post: official text equals FX raw text; a quote role is mirrored in both providers. */
function post(handle: string, createdAt: string, body = `Early entry here. Ca: ${MINT}`, quoteId: string | null = null): Spec {
  const id = idAt(createdAt), Handle = handle.toUpperCase();
  return { handle, id, createdAt, url: `https://x.com/${handle}/status/${id}`,
    oembed: { url: `https://twitter.com/${Handle}/status/${id}`, author_url: `https://twitter.com/${Handle}` },
    syndication: { __typename: 'Tweet', id_str: id, created_at: createdAt, text: body, user: { screen_name: Handle }, edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(createdAt) + 3_600_000) },
      isEdited: false, isStaleEdit: false, ...(quoteId ? { quoted_tweet: { id_str: quoteId } } : {}) },
    fxtwitter: { code: 200, message: 'OK', tweet: { id, text: body, raw_text: { text: body, facets: [] }, author: { screen_name: Handle }, created_timestamp: Date.parse(createdAt) / 1000, is_note_tweet: false,
      replying_to_status: null, reposted_by: null, ...(quoteId ? { quote: { id: quoteId } } : {}) } } };
}
const record = (id: string, sourceId: string, sourceType: string, accessMode: EvidenceRecord['accessMode'], scope: Record<string, unknown>, at = SCOPE_AT): EvidenceRecord =>
  ({ id, sourceId, sourceType, retrievedAt: at, availableAt: at, contentHash: '0'.repeat(64), adapterVersion: 'live-v1', accessMode, scope });
function world(seeds: Seed[]) {
  const rawArtifacts: Record<string, string> = { 'attention-scope': JSON.stringify({ queries: [`${MINT} site:x.com`], postSampleSourceIds: seeds.map(s => s.id), start: '2026-10-10T23:00:00.000Z', end: SCOPE_AT }) };
  const evidence = [record('attention-scope', 'attention-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: 'comparison-scope-v2' })];
  for (const s of seeds) { evidence.push(record(s.id, 'tinyfish-fetch', 'WEB_PAGE', 'FREE_ACCOUNT', { url: s.url, publishedAt: s.publishedAt, authorId: null, kind: s.kind ?? 'POST' })); rawArtifacts[s.id] = `page ${s.id}`; }
  return { evidence, rawArtifacts };
}
const provider = (url: string): CallerProvider => url.startsWith('https://publish.twitter.com/') ? 'oembed' : url.startsWith('https://cdn.syndication.twimg.com/') ? 'syndication' : 'fxtwitter';
/** Live-shaped run: seed, selection evidence, bounded reads and per-key receipt evidence exactly as the collector ingests them. */
async function run(specs: Spec[], seeds: Seed[] = specs.map((s, i) => ({ id: `attention-page-${i + 1}`, url: s.url, publishedAt: s.createdAt }))) {
  const { evidence, rawArtifacts } = world(seeds), seed = callerSeedFromEvidence(token, evidence, rawArtifacts, FROZEN);
  if (seed.selection === null) throw new Error(seed.code);
  evidence.push({ ...record(CALLER_SELECTION_ID, 'advisory-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: CALLER_SEED_METHOD }, FROZEN), contentHash: createHash('sha256').update(seed.raw).digest('hex') }); rawArtifacts[CALLER_SELECTION_ID] = seed.raw;
  const fetcher = (async (input: unknown) => { const url = String(input), spec = specs.find(s => url.includes(s.id))!; return new Response(JSON.stringify(spec[provider(url)]), { status: 200 }); }) as typeof fetch;
  const collected = await collectCallerHistory(seed.selection, fetcher, () => RETRIEVED);
  const callers = { raw: {} as Record<string, string>, times: {} as Record<string, string>, requests: collected.requests as Record<string, unknown>, ids: [] as string[] };
  for (const [key, raw] of Object.entries(collected.rawArtifacts)) {
    const id = `advisory-callers-${key}`;
    evidence.push(record(id, 'advisory-callers', 'HISTORICAL_RECEIPT', 'PUBLIC_API', { request: collected.requests[key] }, RETRIEVED));
    rawArtifacts[id] = raw; callers.raw[key] = raw; callers.times[key] = RETRIEVED; callers.ids.push(id);
  }
  return { evidence, rawArtifacts, selection: seed.selection, history: collected.data, callers };
}
type Claim = AdvisorySemantic['sources'][number];
function classify(history: CallerHistory, patch: Record<string, Partial<Claim>> = {}, extra: Partial<AdvisorySemantic> = {}): AdvisorySemantic {
  return { method: 'advisory-source-classification-v2', token, persistence: null, persistenceAccepted: false, ...extra,
    sources: history.socialInput.sources.map((s): Claim => ({ id: s.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: 'CRYPTO_CALLER', topic: 'PRICE_CHART', artifact: 'NONE', theme: null, paidDisclosure: 'NOT_OBSERVED',
      incentives: [], citations: [{ sourceId: s.id, quote: `Ca: ${MINT}` }], rationale: 'synthetic reviewed classification', complete: true, accepted: true, ...patch[s.id] })) };
}
const pick = (metrics: AdvisoryMetric[], id: string) => metrics.find(metric => metric.id === id)!;
const states = (metrics: AdvisoryMetric[]) => metrics.map(metric => `${metric.id}:${metric.quality}:${metric.reasonCode}`);

test('seed freezes canonical X statuses from the retained attention post sample before any caller read', () => {
  const inside = post('alpha_caller', A_AT), undated = post('beta_caller', '2026-10-11T22:00:00.000Z');
  const { evidence, rawArtifacts } = world([
    { id: 'p1', url: `https://twitter.com/ALPHA_CALLER/status/${inside.id}?s=20`, publishedAt: A_AT },
    { id: 'p2', url: undated.url, publishedAt: null },
    { id: 'p3', url: 'https://x.com/old_caller/status/1', publishedAt: '2026-09-20T00:00:00.000Z' },
    { id: 'p4', url: 'https://example.com/post/1', publishedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'p5', url: inside.url, publishedAt: A_AT },
    { id: 'p6', url: 'https://x.com/page_like/status/2', publishedAt: null, kind: 'PAGE' }]);
  const seed = callerSeedFromEvidence(token, evidence, rawArtifacts, FROZEN);
  if (seed.selection === null) throw new Error(seed.code);
  assert.deepEqual(seed.selection.posts, [{ seedSourceId: 'p1', url: inside.url }, { seedSourceId: 'p2', url: undated.url }]);
  assert.deepEqual(seed.selection.period, { start: '2026-09-28T00:00:00.000Z', end: FROZEN });
  assert.equal(seed.selection.sourceScopeHash, createHash('sha256').update(rawArtifacts['attention-scope']!).digest('hex'));
  assert.equal(JSON.parse(seed.raw).method, CALLER_SEED_METHOD);
  assert.deepEqual(JSON.parse(seed.raw).excluded, [{ seedSourceId: 'p3', reason: 'OUTSIDE_PERIOD' }, { seedSourceId: 'p4', reason: 'NOT_X_STATUS' }, { seedSourceId: 'p5', reason: 'DUPLICATE_STATUS' }, { seedSourceId: 'p6', reason: 'NOT_POST' }]);
  assert.deepEqual(seed.evidenceIds, ['attention-scope', 'p1', 'p2']);
  assert.deepEqual(callerSeedFromEvidence(token, evidence, rawArtifacts, '2026-10-11T22:00:00.000Z'), { selection: null, code: 'CALLER_SEED_CLOCK_ORDER' });
  const missing = world([{ id: 'p1', url: inside.url, publishedAt: null }]); missing.evidence.pop();
  assert.deepEqual(callerSeedFromEvidence(token, missing.evidence, missing.rawArtifacts, FROZEN), { selection: null, code: 'CALLER_SEED_SOURCE_MISSING' });
  const many = world(Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, url: `https://x.com/caller_${i}/status/${i + 1}`, publishedAt: null })));
  assert.deepEqual(callerSeedFromEvidence(token, many.evidence, many.rawArtifacts, FROZEN), { selection: null, code: 'CALLER_SEED_OVER_CAP' });
  const empty = world([]);
  assert.deepEqual(callerSeedFromEvidence(token, empty.evidence, empty.rawArtifacts, FROZEN), { selection: null, code: 'CALLER_SEED_EMPTY' });
  assert.deepEqual(callerSeedFromEvidence(token, [], {}, FROZEN), { selection: null, code: 'CALLER_SEED_SCOPE_MISSING' });
});

test('reviewed full-body classifications give historical S07/S09/A23 with structural roles, edits and exact scope', async () => {
  const quoted = post('alpha_caller', A_AT), quoting = post('alpha_caller', '2026-10-01T20:11:12.000Z', `Timing was right. Ca: ${MINT}`, quoted.id);
  const beta = post('beta_caller', B_AT), news = post('gamma_news', '2026-10-02T09:00:00.000Z', 'Market recap without a contract');
  const { history } = await run([quoted, quoting, beta, news]), id = (s: Spec) => `caller-${s.id}`;
  const metrics = deriveCallerHistoryMetrics(token, CUTOFF, history, classify(history, { [id(beta)]: { topic: 'OTHER' }, [id(news)]: { binding: 'UNRELATED', event: 'NEWS', topic: 'OTHER', citations: [] } }), ['x']);
  assert.deepEqual(metrics.map(m => m.id), ['S07', 'S09', 'A23']);
  assert.deepEqual(states(metrics), ['S07:KNOWN:HISTORICAL_CALL_EVENTS_CLASSIFIED', 'S09:KNOWN:HISTORICAL_CALLER_CONCENTRATION_OBSERVED', 'A23:KNOWN:HISTORICAL_CLASSIFIED_FRACTION_OBSERVED']);
  const s09 = pick(metrics, 'S09').data as any, events = (pick(metrics, 'S07').data as any).events;
  assert.deepEqual(s09.callerCounts, [['x.com:alpha_caller', 2], ['x.com:beta_caller', 1]]);
  assert.equal(s09.top1Share, new Decimal(2).div(3).toFixed()); assert.equal(s09.top5Share, '1'); assert.equal(s09.reach, null); assert.equal(s09.propagationShare, null);
  assert.deepEqual(events.map((e: any) => [e.statusId, e.role, e.quoteStatusId]), [[quoted.id, 'ORIGINAL', null], [quoting.id, 'COMMENTARY', quoted.id], [beta.id, 'ORIGINAL', null]]);
  assert.equal(events[0].publishedAt, A_AT); assert.equal(events[0].timePrecision, 'SECOND'); assert.equal(events[0].edit.state, 'UNEDITED_AT_RETRIEVAL'); assert.equal(events[0].mintLocation, 'OFFICIAL_VISIBLE_TEXT');
  assert.match(events[0].bodySha256, /^[0-9a-f]{64}$/);
  const a23 = pick(metrics, 'A23').data as any;
  assert.deepEqual([a23.eligible, a23.classified, a23.unclassified, a23.numerator, a23.fraction], [3, 3, 0, 2, new Decimal(2).div(3).toFixed()]);
  assert.equal(s09.scope.kind, 'HISTORICAL_FIXED_ATTENTION_SAMPLE'); assert.equal(s09.scope.frozenAt, FROZEN); assert.equal(s09.scope.analysisCutoff, RETRIEVED);
  assert.equal(s09.scope.selectionHash, history.selectionHash); assert.deepEqual(s09.scope.excluded, []);
});

test('unclear events, unresolved binding, rejected or missing review and late or incomplete bodies never become KNOWN', async () => {
  const a = post('alpha_caller', A_AT), b = post('beta_caller', B_AT), w = await run([a, b]), ia = `caller-${a.id}`, ib = `caller-${b.id}`, h = w.history;
  const derive = (semantic: AdvisorySemantic | null, history = h, cutoff = CUTOFF) => states(deriveCallerHistoryMetrics(token, cutoff, history, semantic, []));
  const all = (reason: string) => ['S07', 'S09', 'A23'].map(id => `${id}:MISSING:${reason}`);
  assert.deepEqual(derive(classify(h, { [ia]: { event: 'UNCLEAR' } })), ['S07:MISSING:HISTORICAL_EVENT_UNCLEAR', 'S09:MISSING:HISTORICAL_EVENT_UNCLEAR', 'A23:KNOWN:HISTORICAL_CLASSIFIED_FRACTION_OBSERVED']);
  assert.deepEqual(derive(classify(h, { [ia]: { binding: 'UNCLEAR' } })), all('HISTORICAL_BINDING_UNRESOLVED'));
  assert.deepEqual(derive(classify(h, { [ia]: { accepted: false } })), all('HISTORICAL_CLASSIFICATION_REJECTED'));
  assert.deepEqual(derive(classify(h, { [ia]: { complete: false } })), all('HISTORICAL_CLASSIFICATION_REJECTED'));
  assert.deepEqual(derive(classify(h, {}, { token: { chain: 'solana', address: 'So11111111111111111111111111111111111111112' } })), all('HISTORICAL_CLASSIFICATION_REJECTED'));
  assert.deepEqual(derive(null), all('HISTORICAL_CLASSIFICATION_UNAVAILABLE'));
  assert.deepEqual(derive(classify(h), h, '2026-10-12T00:00:04.000Z'), all('HISTORICAL_SAMPLE_AFTER_CUTOFF'));
  assert.deepEqual(derive(classify(h, { [ia]: { topic: 'UNKNOWN' } })), ['S07:KNOWN:HISTORICAL_CALL_EVENTS_CLASSIFIED', 'S09:KNOWN:HISTORICAL_CALLER_CONCENTRATION_OBSERVED', 'A23:MISSING:HISTORICAL_CLASSIFIED_FRACTION_INCOMPLETE']);
  assert.deepEqual(derive(classify(h, { [ia]: { event: 'NEWS' }, [ib]: { event: 'RETROSPECTIVE' } })), ['S07:KNOWN:HISTORICAL_CALL_EVENTS_CLASSIFIED', 'S09:MISSING:HISTORICAL_CALL_DENOMINATOR_ZERO', 'A23:KNOWN:HISTORICAL_CLASSIFIED_FRACTION_OBSERVED']);
  assert.equal(derive(classify(h, { [ia]: { binding: 'UNRELATED' }, [ib]: { binding: 'UNRELATED' } }))[2], 'A23:MISSING:HISTORICAL_CLASSIFIED_FRACTION_DENOMINATOR_ZERO');
  const k = callerHistoryKey(b.id, 'syndication'), broken = { ...w.callers.raw, [k]: JSON.stringify({ ...JSON.parse(w.callers.raw[k]!), status: 404, body: 'not found' }) };
  const partial = decodeCallerHistory(w.selection, broken);
  assert.equal(partial.complete, false); assert.deepEqual(derive(classify(partial), partial), all('HISTORICAL_BODIES_INCOMPLETE'));
});

test('a status verified outside the frozen period is an explicit exclusion, not incompleteness', async () => {
  const old = post('old_caller', '2026-09-20T00:00:00.000Z'), current = post('alpha_caller', A_AT);
  const w = await run([current, old], [{ id: 'p1', url: current.url, publishedAt: null }, { id: 'p2', url: old.url, publishedAt: null }]);
  assert.equal(w.history.complete, true); assert.equal(w.history.layers[1]!.failure, 'CALLER_OUTSIDE_PERIOD'); assert.equal(w.history.socialInput.sources.length, 1);
  const metrics = deriveCallerHistoryMetrics(token, CUTOFF, w.history, classify(w.history), []);
  assert.equal(pick(metrics, 'S09').quality, 'KNOWN');
  assert.deepEqual((pick(metrics, 'S09').data as any).scope.excluded, [{ seedSourceId: 'p2', statusId: old.id, code: 'CALLER_OUTSIDE_PERIOD' }]);
});

test('offline replay recomputes the frozen seed and exact request catalog; tampering is rejected', async () => {
  const a = post('alpha_caller', A_AT), b = post('beta_caller', B_AT), w = await run([a, b]);
  const replay = (patch: { evidence?: EvidenceRecord[]; rawArtifacts?: Record<string, string>; callers?: typeof w.callers } = {}) =>
    replayCallerHistory(token, CUTOFF, patch.evidence ?? w.evidence, patch.rawArtifacts ?? w.rawArtifacts, patch.callers ?? w.callers, CALLER_SELECTION_ID, null);
  const metrics = replay();
  assert.deepEqual(metrics.map(m => m.reasonCode), Array(3).fill('HISTORICAL_CLASSIFICATION_UNAVAILABLE'));
  for (const id of [CALLER_SELECTION_ID, 'attention-scope', 'attention-page-1', w.callers.ids[0]!]) assert.ok(metrics[0]!.evidenceIds.includes(id));
  const widened = { ...w.rawArtifacts, 'attention-scope': JSON.stringify({ ...JSON.parse(w.rawArtifacts['attention-scope']!), queries: ['other query'] }) };
  assert.throws(() => replay({ rawArtifacts: widened }), /ADVISORY_PROOF_INVALID/);
  const narrowed = JSON.parse(w.rawArtifacts[CALLER_SELECTION_ID]!); narrowed.selection.posts.pop();
  assert.throws(() => replay({ rawArtifacts: { ...w.rawArtifacts, [CALLER_SELECTION_ID]: JSON.stringify(narrowed) } }), /ADVISORY_PROOF_INVALID/);
  const moved = '2026-10-12T00:00:01.000Z';
  assert.throws(() => replay({ evidence: w.evidence.map(e => e.id === CALLER_SELECTION_ID ? { ...e, availableAt: moved, retrievedAt: moved } : e) }), /ADVISORY_PROOF_INVALID/);
  assert.throws(() => replay({ evidence: w.evidence.map(e => e.id === CALLER_SELECTION_ID ? { ...e, accessMode: 'USER_IMPORT' as const } : e) }), /ADVISORY_PROOF_INVALID/);
  assert.throws(() => replay({ evidence: w.evidence.map(e => e.id === CALLER_SELECTION_ID ? { ...e, adapterVersion: 'live-v0' } : e) }), /ADVISORY_PROOF_INVALID/);
  assert.throws(() => replay({ evidence: w.evidence.map(e => e.id === CALLER_SELECTION_ID ? { ...e, contentHash: '0'.repeat(64) } : e) }), /ADVISORY_PROOF_INVALID/);
  assert.throws(() => replay({ evidence: [...w.evidence, structuredClone(w.evidence.find(e => e.id === CALLER_SELECTION_ID)!)] }), /ADVISORY_PROOF_INVALID/);
  const graftedScope = { ...structuredClone(w.evidence.find(e => e.id === 'attention-scope')!), availableAt: '2026-10-11T22:00:00.000Z', retrievedAt: '2026-10-11T22:00:00.000Z' };
  assert.throws(() => replay({ evidence: [graftedScope, ...w.evidence] }), /ADVISORY_PROOF_INVALID/);
  const key = callerHistoryKey(a.id, 'fxtwitter');
  assert.throws(() => replay({ callers: { ...w.callers, requests: { ...w.callers.requests, [key]: { provider: 'fxtwitter', statusUrl: a.url, url: 'https://api.fxtwitter.com/other/status/1' } } } }), /ADVISORY_PROOF_INVALID/);
  const { [key]: _dropped, ...fewer } = w.callers.requests;
  assert.throws(() => replay({ callers: { ...w.callers, requests: fewer } }), /ADVISORY_PROOF_INVALID/);
  assert.throws(() => replay({ callers: { ...w.callers, times: { ...w.callers.times, [key]: CUTOFF } } }), /ADVISORY_PROOF_INVALID/);
  assert.throws(() => replayCallerHistory(token, CUTOFF, w.evidence, w.rawArtifacts, w.callers, 'advisory-callers-other', null), /ADVISORY_PROOF_INVALID/);
  assert.throws(() => replayCallerHistory(token, '2026-10-11T23:59:59.000Z', w.evidence, w.rawArtifacts, w.callers, CALLER_SELECTION_ID, null), /ADVISORY_PROOF_INVALID/);
  const forged = replayCallerHistory(token, CUTOFF, w.evidence, w.rawArtifacts, w.callers, CALLER_SELECTION_ID, { raw: { 'advisory-semantic-proposal-response': '{}' }, times: {}, requests: {}, ids: [] });
  assert.ok(forged.every(m => m.quality === 'MISSING' && m.reasonCode === 'HISTORICAL_CLASSIFICATION_UNAVAILABLE'));
});

test('shared collection budget exhaustion is retained as CALLER_BUDGET and leaves the sample incomplete', async () => {
  const a = post('alpha_caller', A_AT), { evidence, rawArtifacts } = world([{ id: 'p1', url: a.url, publishedAt: null }]), seed = callerSeedFromEvidence(token, evidence, rawArtifacts, FROZEN);
  if (seed.selection === null) throw new Error(seed.code);
  const history = await collectCallerHistory(seed.selection, (() => { throw new Error('COLLECTION_BUDGET'); }) as typeof fetch, () => RETRIEVED);
  assert.ok(Object.values(history.rawArtifacts).every(raw => JSON.parse(raw).code === 'CALLER_BUDGET'));
  assert.equal(history.data.complete, false);
});

test('historical values fill only current metrics that are not KNOWN', () => {
  const metric = (id: string, quality: AdvisoryMetric['quality'], reasonCode = 'current'): AdvisoryMetric => ({ id, quality, unit: 'fraction', data: {}, evidenceIds: [], reasonCode });
  const kept = supersedingCallerMetrics([metric('S09', 'KNOWN'), metric('A23', 'MISSING')], [metric('S09', 'KNOWN', 'historical'), metric('A23', 'KNOWN', 'historical'), metric('S07', 'MISSING', 'historical')]);
  assert.deepEqual(kept.map(m => `${m.id}:${m.reasonCode}`), ['A23:historical']);
});
