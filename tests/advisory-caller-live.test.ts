import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { CALLER_SELECTION_ID } from '../src/providers/advisory-caller-measures.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump', token = { chain: 'solana' as const, address: MINT };
const pool = '4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E', quote = 'So11111111111111111111111111111111111111112';
const AT = '2026-10-10T12:30:00.000Z', hour = Date.parse('2026-10-10T12:00:00.000Z') / 1000, day = Date.parse('2026-10-10T00:00:00.000Z') / 1000;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const envelope = (value: unknown) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
const idAt = (iso: string) => String(((BigInt(Date.parse(iso)) - 1288834974657n) << 22n) + 1n);

/** Sanitized ordinary X post as returned by oEmbed, official syndication and FxTwitter. */
function post(handle: string, createdAt: string, body: string): Record<string, any> {
  const id = idAt(createdAt), Handle = handle.toUpperCase();
  return { handle, id, createdAt, body, url: `https://x.com/${handle}/status/${id}`,
    oembed: { url: `https://twitter.com/${Handle}/status/${id}`, author_url: `https://twitter.com/${Handle}` },
    syndication: { __typename: 'Tweet', id_str: id, created_at: createdAt, text: body, user: { screen_name: Handle },
      edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(createdAt) + 3_600_000) }, isEdited: false, isStaleEdit: false },
    fxtwitter: { code: 200, message: 'OK', tweet: { id, text: body, raw_text: { text: body, facets: [] }, author: { screen_name: Handle },
      created_timestamp: Date.parse(createdAt) / 1000, is_note_tweet: false, replying_to_status: null, reposted_by: null } } };
}
const posts = [
  post('alpha_caller', '2026-10-01T20:10:10.000Z', `Chart breakout loading, entries open now. Ca: ${MINT}`),
  post('beta_caller', '2026-10-02T09:00:00.000Z', `Early entry for the colony before it runs. Ca: ${MINT}`),
];

/** The advisory public-history fixture used by the advisory integration tests, with a named pair so attention keeps its post sample. */
function advisoryFixture(url: string, init?: RequestInit): Response {
  let value: unknown;
  if (init?.method === 'POST') {
    const request = JSON.parse(String(init.body));
    value = { jsonrpc: '2.0', id: 1, result: request.method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : request.method === 'getSignaturesForAddress' ? [] : { context: { slot: 1 }, value: null } };
  } else if (url.includes('/token-pairs/')) value = [{ chainId: 'solana', dexId: 'pumpswap', pairAddress: pool, baseToken: { address: MINT, name: 'Parasite' }, quoteToken: { address: quote }, priceUsd: '1', liquidity: { usd: 10000 }, volume: { h24: 100 }, txns: { h24: { buys: 4, sells: 3 } } }];
  else if (url.includes('include=base_token')) value = { data: { id: `solana_${pool}`, type: 'pool', attributes: { address: pool }, relationships: { base_token: { data: { id: `solana_${MINT}`, type: 'token' } }, quote_token: { data: { id: `solana_${quote}`, type: 'token' } } } }, included: [MINT, quote].map(address => ({ id: `solana_${address}`, type: 'token', attributes: { address } })) };
  else if (url.includes('ohlcv')) value = { data: { attributes: { ohlcv_list: Array.from({ length: 75 }, (_, i) => [hour - i * 3600, 10 + i % 6, 11 + i % 6, 9 + i % 6, 10 + i % 6, 20]) } } };
  else if (url.includes('coinbase')) value = Array.from({ length: 75 }, (_, i) => [hour - i * 3600, 9 + i % 6, 11 + i % 6, 10 + i % 6, 10 + i % 6, 2]);
  else if (url.includes('llama')) value = { chain: new URL(url).pathname.split('/').at(-1), totalDataChart: [[day - 172800, 10], [day - 86400, 20], [day, 999]] };
  else if (url.includes('/orders/')) value = { orders: [{ chainId: 'solana', tokenAddress: MINT, type: 'tokenProfile', status: 'approved', paymentTimestamp: Date.parse(AT) - 1000 }], boosts: [] };
  else throw new Error('Unexpected fixture request');
  return json(value);
}

type Variant = { missingSyndication?: string; reviewStatus?: number; releaseAfterReads?: number; categories?: Record<string, string> };
/** One live run in which every RPC request is held until the caller pipeline reaches its declared point (fallback after 15 s). */
async function run(variant: Variant = {}) {
  let tick = 0, held = 0, callerReads = 0, firstCallerTick: number | null = null, heldAtReview: number | null = null, releasedBy: string | null = null;
  const callerPackets: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const open = (reason: string) => { if (!releasedBy) { releasedBy = reason; release(); } };
  const fallback = setTimeout(() => open('fallback-timer'), 15_000); fallback.unref();
  const now = () => new Date(Date.parse(AT) + tick++).toISOString();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.search.tinyfish.ai/')) return json({ results: posts.map(p => ({ url: p.url, title: 'Parasite caller post', snippet: `Parasite contract ${MINT}` })) });
    if (url.startsWith('https://api.fetch.tinyfish.ai/')) {
      const urls = (JSON.parse(String(init?.body)).urls ?? []) as string[];
      return json({ results: urls.map(u => { const p = posts.find(x => x.url === u); return { url: u, final_url: u, text: p ? p.body : `Parasite page naming ${MINT}.`, ...(p ? { published_date: p.createdAt } : {}) }; }), errors: [] });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const packet = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      const sources: any[] = Array.isArray(packet.sources) ? packet.sources : [];
      if (typeof packet.rules === 'string' && sources.length && sources.every(s => String(s.id).startsWith('caller-'))) {
        const stage = packet.proposal ? 'review' : 'proposal';
        callerPackets.push(stage);
        if (stage === 'review') {
          heldAtReview = held; queueMicrotask(() => open('caller-review'));
          if (variant.reviewStatus) return json({ error: 'fixture review unavailable' }, variant.reviewStatus);
          return json(envelope({ sources: sources.map(s => ({ id: s.id, complete: true, accepted: true })), persistence: false }));
        }
        return json(envelope({ persistence: null, sources: sources.map(s => {
          const span = s.spans.find((x: any) => x.text.includes(MINT));
          return { id: s.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: variant.categories?.[posts.find(p => s.id === `caller-${p.id}`)?.handle ?? ''] ?? 'CRYPTO_CALLER', topic: span.text.includes('Chart') ? 'PRICE_CHART' : 'OTHER', artifact: 'NONE', theme: null,
            paidDisclosure: 'NOT_OBSERVED', incentives: [], citations: [{ sourceId: s.id, spanId: span.id }], rationale: 'The cited span is an explicit prospective call naming the exact contract.' };
        }) }));
      }
      // Attention, social, shared and current-corpus classification stay unavailable in this fixture; they must fail without affecting the caller pipeline.
      return json({ error: 'fixture model unavailable' }, 400);
    }
    const provider = url.startsWith('https://publish.twitter.com/') ? 'oembed' : url.startsWith('https://cdn.syndication.twimg.com/') ? 'syndication' : url.startsWith('https://api.fxtwitter.com/') ? 'fxtwitter' : null;
    if (provider) {
      firstCallerTick ??= tick; callerReads++;
      const p = posts.find(x => url.includes(x.id))!;
      if (variant.releaseAfterReads && callerReads >= variant.releaseAfterReads) queueMicrotask(() => open('caller-reads'));
      if (provider === 'syndication' && variant.missingSyndication === p.id) return json({ error: 'not found' }, 404);
      return json(p[provider]);
    }
    if (init?.method === 'POST') { held++; await gate; held--; }
    return advisoryFixture(url, init);
  };
  try {
    const bundle = await collectLiveToken(token, { profile: starterProfile(), semanticEnabled: true, advisoryEnabled: true, tinyfishKey: 'tinyfish-fixture-key', geminiKey: 'gemini-fixture-key', fetcher, now });
    return { bundle, callerPackets, callerReads, firstCallerTick, heldAtReview, releasedBy };
  } finally { clearTimeout(fallback); }
}
type Run = Awaited<ReturnType<typeof run>>;
const metric = (r: Run, id: string) => r.bundle.details!.advisory!.metrics.find(m => m.id === id)!;
const diagnostics = (r: Run) => JSON.parse(r.bundle.rawArtifacts['social-run-diagnostics']!);
const proofOf = (r: Run) => JSON.parse(r.bundle.rawArtifacts['advisory-derivation']!);
function persists(r: Run, name: string) {
  const directory = mkdtempSync(join(tmpdir(), `advisory-caller-live-${name}-`));
  try {
    const service = new Service(join(directory, 'live.sqlite'));
    try { const saved = service.analyzeLive(r.bundle); assert.deepEqual(service.replay(saved.id), service.show(saved.id)); } finally { service.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('caller bodies and the independent classification pair run in the background while advisory RPC is held, before late capture, and replay', async () => {
  const r = await run();
  assert.equal(r.releasedBy, 'caller-review', 'advisory RPC stayed held until the caller review was served');
  assert.ok((r.heldAtReview ?? 0) > 0, 'historical advisory RPC was still pending when the caller pair finished');
  assert.deepEqual(r.callerPackets, ['proposal', 'review'], 'exactly one proposal/review pair');
  assert.equal(r.callerReads, 6);
  const selection = r.bundle.evidence.find(e => e.id === CALLER_SELECTION_ID)!;
  assert.ok(r.firstCallerTick !== null && Date.parse(selection.availableAt) < Date.parse(AT) + r.firstCallerTick, 'the seed is frozen before the first caller read');
  const receipts = r.bundle.evidence.filter(e => e.sourceId === 'advisory-callers');
  assert.equal(receipts.length, 6);
  assert.ok(receipts.every(e => Date.parse(e.retrievedAt) > Date.parse(selection.availableAt)));
  const proof = proofOf(r);
  assert.equal(proof.method, 'advisory-provenance-v24');
  assert.deepEqual(Object.keys(proof.creatorRole.artifactIds), ['page'], 'a page without a profile link stops creator discovery after one receipt');
  assert.equal((metric(r, 'S13').data as any).creatorRole.reasonCode, 'CREATOR_ROLE_PAGE_SHAPE');
  assert.equal(JSON.parse(r.bundle.rawArtifacts['advisory-callerSemantic-advisory-semantic-selection']!).method, 'advisory-source-selection-v3');
  assert.equal(Object.keys(proof.callers.artifactIds).length, 6);
  const semanticIds = Object.values(proof.callerSemantic.artifactIds) as string[];
  assert.ok(semanticIds.includes('advisory-callerSemantic-advisory-semantic-proposal-response'));
  assert.ok(semanticIds.includes('advisory-callerSemantic-advisory-semantic-review-response'));
  const classifiedAt = Math.max(...semanticIds.map(id => Date.parse(r.bundle.evidence.find(e => e.id === id)!.retrievedAt)));
  assert.ok(Date.parse(JSON.parse(r.bundle.rawArtifacts['live-state-capture']!).startedAt) > classifiedAt, 'late canonical capture starts after the caller classification batch');
  assert.deepEqual([diagnostics(r).callerStatus, diagnostics(r).admittedCallerRequests, diagnostics(r).callerRequestLimit], ['CLASSIFIED', 6, 96]);
  for (const id of ['S07', 'S09', 'A23']) {
    assert.equal(metric(r, id).quality, 'KNOWN', id);
    assert.equal((metric(r, id).data as any).method, 'historical-caller-sample-v1', id);
    assert.equal((metric(r, id).data as any).scope.kind, 'HISTORICAL_FIXED_ATTENTION_SAMPLE', id);
  }
  assert.equal((metric(r, 'S09').data as any).top1Share, '0.5');
  assert.equal((metric(r, 'S09').data as any).top5Share, '1');
  assert.equal((metric(r, 'A23').data as any).fraction, '0.5');
  const a21 = metric(r, 'A21').data as any;
  assert.equal(metric(r, 'A21').quality, 'KNOWN'); assert.equal(a21.method, 'historical-caller-sample-v1'); assert.equal(a21.categoryRubric, 'reviewed-public-origin-v1');
  assert.deepEqual([a21.eligible, a21.classified, a21.numerator, a21.fraction], [2, 2, 0, '0'], 'a complete crypto-native sample is a measured zero, not missing');
  persists(r, 'classified');
});

test('an incomplete caller body retains every receipt, skips the model pair and leaves the historical metrics MISSING', async () => {
  const r = await run({ missingSyndication: posts[1]!.id, releaseAfterReads: 6 });
  assert.equal(r.releasedBy, 'caller-reads');
  assert.deepEqual(r.callerPackets, []);
  const proof = proofOf(r);
  assert.equal(proof.callerSemantic, null);
  assert.equal(Object.keys(proof.callers.artifactIds).length, 6);
  assert.equal(JSON.parse(r.bundle.rawArtifacts[`advisory-callers-caller-history:${posts[1]!.id}:syndication`]!).status, 404);
  assert.equal(diagnostics(r).callerStatus, 'BODIES_INCOMPLETE');
  assert.equal(metric(r, 'S09').quality, 'MISSING');
  assert.notEqual((metric(r, 'S09').data as any)?.method, 'historical-caller-sample-v1');
  persists(r, 'incomplete');
});

test('a failed caller review is retained once, non-fatally, and cannot certify historical metrics', async () => {
  const r = await run({ reviewStatus: 400 });
  assert.equal(r.releasedBy, 'caller-review');
  assert.deepEqual(r.callerPackets, ['proposal', 'review'], 'no retry and no duplicate pair');
  const proof = proofOf(r);
  assert.ok(Object.keys(proof.callerSemantic.artifactIds).includes('advisory-semantic-proposal-response'));
  assert.equal(diagnostics(r).callerStatus, 'ADV_SEMANTIC_HTTP_400');
  for (const id of ['S07', 'S09', 'A23']) assert.equal(metric(r, id).quality, 'MISSING', id);
  persists(r, 'review-failed');
});

test('a reviewed external origin gives a proper historical A21 fraction; an UNKNOWN origin leaves A21 MISSING without disturbing call measures', async () => {
  const external = await run({ categories: { beta_caller: 'EXTERNAL' } });
  const a21 = metric(external, 'A21').data as any;
  assert.equal(metric(external, 'A21').quality, 'KNOWN');
  assert.deepEqual([a21.eligible, a21.classified, a21.numerator, a21.fraction], [2, 2, 1, '0.5']);
  assert.deepEqual(a21.external.map((e: any) => e.sourceId), [`caller-${posts[1]!.id}`]);
  persists(external, 'external');
  const unknown = await run({ categories: { beta_caller: 'UNKNOWN' } });
  assert.equal(metric(unknown, 'A21').quality, 'MISSING');
  assert.notEqual((metric(unknown, 'A21').data as any)?.method, 'historical-caller-sample-v1');
  assert.equal(metric(unknown, 'S09').quality, 'KNOWN', 'an unresolved origin does not disturb the call-event measures');
  persists(unknown, 'unknown-origin');
});
