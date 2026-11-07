import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { AccountType, ExtensionType, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { MPL_TOKEN_METADATA_PROGRAM_ID, metadataPda } from '@pump-fun/pump-swap-sdk';
import { collectLiveSolana, collectLiveToken, fastRouteFacts } from '../src/app/live.js';
import type { LiveRuntime } from '../src/app/live-phases.js';
import { buildEntryReport, explainChecks, renderSnapshot } from '../src/app/report.js';
import { Service } from '../src/app/service.js';
import { parseGeminiSemantic } from '../src/providers/gemini.js';
import { fetchDexPairs, parseDexPairs } from '../src/providers/dexscreener.js';
import { publicHttpsUrl, searchAndFetchPublic } from '../src/providers/tinyfish.js';
import {
  inspectSolanaDetails,
  inspectSolanaMint,
  inspectSolanaRpc,
  LEGACY_TOKEN_PROGRAM,
  SOLANA_MAINNET_GENESIS,
  TOKEN_2022_PROGRAM,
  UPGRADEABLE_LOADER,
} from '../src/providers/solana.js';
import { inspectPumpSwap } from '../src/providers/pumpswap.js';
import { decodeTokenMetadataUri, discoverTokenMetadata, fetchFastMetadata } from '../src/providers/token-discovery.js';
import { collectAttentionSources } from '../src/providers/attention.js';
import { deriveShared, expireSharedWitnesses, sharedClaims, type SharedInputs } from '../src/domain/shared.js';
import { decodeSharedAudit, decodeSharedAuditProof, sharedAuditPrompt, sharedReassessmentIds, validSharedReassessment } from '../src/providers/shared-model.js';
import { sourceSpans } from '../src/providers/source-model.js';
import { sharedFixture } from './shared-fixtures.js';
import { type LiveBundle, type Profile, type TokenRef } from '../src/domain/contracts.js';
import { criterionDiagnostics, criterionIds, criterionPostFacts, criterionReviewMethod } from '../src/domain/criterion-review.js';
import { deriveBaseline, type HolderFacts } from '../src/domain/baseline.js';
import { rugRoutePools } from '../src/domain/rugcheck.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { createJupiterClient } from '../src/providers/jupiter.js';
import { createRugCheckClient } from '../src/providers/rugcheck.js';
import { deriveJupiterRoute, inspectJupiterRoute, retainedJupiterHolders } from '../src/providers/jupiter-route.js';
import { entryGroupsForBundle } from '../src/providers/entry-groups.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const RPC_URL = 'https://rpc.example/?api-key=rpc-secret';
const TINYFISH_KEY = 'tinyfish-test-secret';
const GEMINI_KEY = 'gemini-test-secret';
let geminiKeySequence = 0;
const nextGeminiKey = () => `${GEMINI_KEY}-${++geminiKeySequence}`;
const AT = '2026-09-29T12:00:00.000Z';
const PROGRAM_DATA = new PublicKey(Buffer.alloc(32, 8)).toBase58();
const token: TokenRef = { chain: 'solana', address: MINT };
const profile: Profile = { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } };

test('fresh public-support collection without a DEX name records an empty incomplete comparison ledger', async () => {
  const queries: string[] = [];
  const read = await collectAttentionSources(token, TINYFISH_KEY, async input => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.search.tinyfish.ai');
    queries.push(url.searchParams.get('query')!);
    return jsonResponse({ results: [], errors: [] });
  }, () => AT, undefined, [], undefined, 'public-support-v2', 'requested-page-bodies-v1');

  assert.deepEqual(queries, [
    `"${MINT}" solana narrative origin catalyst`,
    `"${MINT}" (site:x.com OR site:twitter.com)`,
  ], 'no name-based or fabricated comparison query is issued');
  assert.deepEqual(read.queries, queries);
  assert.equal(read.comparisonComplete, false);
  assert.deepEqual(read.comparisonAcquisition, {
    originalComplete: false, searchSucceeded: false, descriptorComplete: true, leadCount: 0, leads: [],
  });
  assert.deepEqual(read.comparisonSourceIds, []);
});

function comparisonGradeIdFields(packet: Record<string, unknown>): Record<string, unknown> {
  const qualification = packet.leadQualification as { globalScopeWireMethod?: string } | undefined;
  return qualification?.globalScopeWireMethod === 'code-owned-comparison-ids-v1' ? {} : {
    leadIds: packet.requiredLeadIds, sourceIds: packet.requiredSourceIds, batchIds: packet.requiredBatchIds,
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('TEST_WAIT_CONDITION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('mainnet RPC pin matches the complete documented Solana genesis hash', () => {
  assert.equal(SOLANA_MAINNET_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
});

test('mint metadata discovery decodes embedded Token-2022 and Metaplex URIs without fetching them', async t => {
  await t.test('Token-2022 reads only its already-fetched mint account and preserves raw RPC evidence', async () => {
    const raw = metadataRpcRaw([rpcAccount(TOKEN_2022_PROGRAM_ID.toBase58(), token2022MetadataAccount('https://project.example/token.json?utm_source=fixture&v=1')), null]);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await discoverTokenMetadata(MINT, RPC_URL, async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse(JSON.parse(raw));
    }, () => AT);

    assert.equal(result.uri, 'https://project.example/token.json?v=1');
    assert.equal(result.code, undefined);
    assert.equal(calls.length, 1, 'metadata parsing makes no hidden follow-up request to the URI');
    assert.equal(calls[0]?.url, RPC_URL);
    assert.equal(calls[0]?.body.method, 'getMultipleAccounts');
    assert.deepEqual((calls[0]?.body.params as unknown[][])[0], [MINT, metadataPda(new PublicKey(MINT)).toBase58()]);
    assert.equal(result.rawArtifacts['discovery-token-metadata'], raw);
    assert.equal(result.retrievedAt['discovery-token-metadata'], AT);
  });

  await t.test('legacy Metaplex URI is public-HTTPS filtered; mismatched mint bindings fail closed', () => {
    const raw = metadataRpcRaw([null, rpcAccount(MPL_TOKEN_METADATA_PROGRAM_ID.toBase58(), legacyMetadataAccount('http://127.0.0.1/private'))]);
    const unsafe = decodeTokenMetadataUri(raw, MINT);
    assert.equal(unsafe.uri, undefined);
    assert.equal(unsafe.code, 'TOKEN_METADATA_URL_UNSAFE');

    const forged = metadataRpcRaw([null, rpcAccount(MPL_TOKEN_METADATA_PROGRAM_ID.toBase58(), legacyMetadataAccount('https://project.example/token.json', new PublicKey(OTHER_MINT)))]);
    assert.throws(() => decodeTokenMetadataUri(forged, MINT), /TOKEN_METADATA_BINDING/);
  });

  await t.test('Token-2022 metadata must declare the exact requested mint', () => {
    const raw = metadataRpcRaw([rpcAccount(TOKEN_2022_PROGRAM_ID.toBase58(), token2022MetadataAccount('https://project.example/token.json', new PublicKey(OTHER_MINT))), null]);
    assert.throws(() => decodeTokenMetadataUri(raw, MINT), /TOKEN_METADATA_BINDING/);
  });
});

test('FAST metadata retries an IPFS gateway once and keeps non-IPFS failures as read gaps', async t => {
  await t.test('an ipfs.io 429 falls back to filebase with the same CID', async () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uhf7x5c3f4e2q2h6f6p5x4g3k2j1i0a';
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const result = await fetchFastMetadata(`https://ipfs.io/ipfs/${cid}/metadata.json`, async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      if (calls.length === 1) return new Response('rate limited', { status: 429 });
      return jsonResponse({ name: 'Captured Metadata' });
    }, () => AT);

    assert.deepEqual(calls, [
      { url: `https://ipfs.io/ipfs/${cid}/metadata.json`, method: 'GET' },
      { url: `https://ipfs.filebase.io/ipfs/${cid}`, method: 'GET' },
    ]);
    assert.equal(result.source?.text, JSON.stringify({ name: 'Captured Metadata' }));
    assert.equal(result.source?.url, `https://ipfs.io/ipfs/${cid}/metadata.json`);
    assert.equal(result.code, undefined);
  });

  await t.test('a failed non-IPFS host returns a metadata read gap without another host request', async () => {
    const calls: string[] = [];
    const result = await fetchFastMetadata('https://metadata.example/token.json', async input => {
      calls.push(String(input));
      return new Response('unavailable', { status: 503 });
    }, () => AT);

    assert.deepEqual(calls, ['https://metadata.example/token.json']);
    assert.equal(result.code, 'METADATA_FETCH_UNAVAILABLE');
    assert.equal(result.source, undefined);
  });
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function token2022MetadataAccount(uri: string, mint = new PublicKey(MINT)): Buffer {
  const metadataString = (value: string) => {
    const bytes = Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const extension = Buffer.concat([
    Buffer.alloc(32), mint.toBuffer(), metadataString('River Lantern'), metadataString('LANT'), metadataString(uri), Buffer.alloc(4),
  ]);
  const length = 170 + extension.length;
  const data = Buffer.alloc(length);
  data.writeBigUInt64LE(1_000_000_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  data[165] = AccountType.Mint;
  data.writeUInt16LE(ExtensionType.TokenMetadata, 166);
  data.writeUInt16LE(extension.length, 168);
  extension.copy(data, 170);
  return data;
}

function metadataRpcRaw(accounts: Array<unknown | null>): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 900 }, value: accounts } });
}

function rpcAccount(owner: string, data: Buffer) {
  return { owner, executable: false, lamports: 1_000_000, data: [data.toString('base64'), 'base64'] };
}

function legacyMetadataAccount(uri: string, mint = new PublicKey(MINT)): Buffer {
  const metadataString = (value: string) => {
    const bytes = Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  return Buffer.concat([Buffer.from([4]), Buffer.alloc(32), mint.toBuffer(), metadataString('River Lantern'), metadataString('LANT'), metadataString(uri)]);
}
const sourceModelRaw = (value: unknown) => JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
});

type TimerTestContext = { mock: { timers: { tick(milliseconds: number): void } } };
async function flushMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
async function advanceTwoRetryDelays(context: TimerTestContext) {
  for (const delay of [1000, 2000]) {
    await flushMicrotasks();
    context.mock.timers.tick(delay);
    await flushMicrotasks();
  }
}

function legacyAccount(overrides: Record<string, unknown> = {}) {
  return {
    owner: LEGACY_TOKEN_PROGRAM,
    data: {
      program: 'spl-token',
      parsed: { type: 'mint', info: { supply: '1000000000000', decimals: 6, mintAuthority: null, freezeAuthority: null } },
    },
    ...overrides,
  };
}

function pair(index: number, overrides: Record<string, unknown> = {}) {
  const asQuote = index === 1;
  return {
    chainId: 'solana',
    pairAddress: `PairAddress${index}`,
    dexId: 'raydium',
    url: `https://dexscreener.com/solana/PairAddress${index}`,
    baseToken: { address: asQuote ? OTHER_MINT : MINT, name: 'Token', symbol: 'T' },
    quoteToken: { address: asQuote ? MINT : 'QuoteMint', name: 'Quote', symbol: 'Q' },
    priceUsd: '0.001',
    liquidity: { usd: String(index + 1) },
    volume: { h24: '25.5' },
    txns: { h24: { buys: 4, sells: 2 } },
    pairCreatedAt: 1750000000000,
    ...overrides,
  };
}

type MockConfig = {
  genesis?: unknown;
  accountValue?: unknown;
  rpcError?: unknown;
  accountError?: unknown;
  rpcStatus?: number;
  dexValue?: unknown | ((call: number) => unknown);
  dexStatus?: number | ((call: number) => number | undefined);
  searchValue?: Record<string, unknown> | ((requestUrl: string, call: number) => unknown);
  searchStatus?: number;
  fetchValue?: unknown | ((urls: string[]) => unknown);
  fetchStatus?: number;
  attentionResponse?: (packet: Record<string, unknown>, call: number) => unknown;
  criterionResponse?: (packet: Record<string, unknown>, call: number) => unknown;
  useCitedClaimReviewCallback?: boolean;
  useCitedEntryCallback?: boolean;
  geminiStatus?: number;
  geminiBody?: string;
};

function mockedFetch(config: MockConfig = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const geminiPackets: Record<string, unknown>[] = [];
  let searchCalls = 0;
  let dexCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      if (config.rpcStatus) return jsonResponse({ error: 'simulated' }, config.rpcStatus);
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getGenesisHash' && config.rpcError !== undefined) throw config.rpcError;
      if (request.method === 'getAccountInfo' && config.accountError !== undefined) throw config.accountError;
      if (request.method === 'getGenesisHash') return jsonResponse({ jsonrpc: '2.0', id: 1, result: config.genesis ?? SOLANA_MAINNET_GENESIS });
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT) return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: config.accountValue === undefined ? legacyAccount() : config.accountValue } });
      if (request.method === 'getProgramAccounts') return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: [] } });
      if (request.method === 'getTokenLargestAccounts') return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: [] } });
      if (request.method === 'getMultipleAccounts') return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: (request.params?.[0] as unknown[]).map(() => null) } });
      if (request.method === 'getAccountInfo' && request.params?.[0] === PROGRAM_DATA) {
        const data = Buffer.alloc(45);
        data.writeUInt32LE(3, 0);
        data.writeBigUInt64LE(300n, 4);
        data[12] = 1;
        Buffer.alloc(32, 11).copy(data, 13);
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: { owner: UPGRADEABLE_LOADER, executable: false, data: [data.toString('base64'), 'base64'] } } });
      }
      if (request.method === 'getAccountInfo') {
        const data = Buffer.alloc(36);
        data.writeUInt32LE(2, 0);
        new PublicKey(PROGRAM_DATA).toBuffer().copy(data, 4);
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: { owner: UPGRADEABLE_LOADER, executable: true, data: [data.toString('base64'), 'base64'] } } });
      }
      throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
    }
    if (url.startsWith('https://api.dexscreener.com/')) {
      const dexCall = dexCalls++;
      const status = typeof config.dexStatus === 'function' ? config.dexStatus(dexCall) : config.dexStatus;
      if (status) return jsonResponse({ error: 'simulated' }, status);
      const value = typeof config.dexValue === 'function' ? config.dexValue(dexCall) : config.dexValue;
      return jsonResponse(value ?? []);
    }
    if (url.startsWith('https://api.search.tinyfish.ai/')) {
      if (config.searchStatus) return jsonResponse({ error: 'simulated' }, config.searchStatus);
      const searchCall = searchCalls++;
      const value = typeof config.searchValue === 'function'
        ? config.searchValue(url, searchCall)
        : config.searchValue ?? { results: [] };
      return jsonResponse(value);
    }
    if (url.startsWith('https://api.fetch.tinyfish.ai/')) {
      if (config.fetchStatus) return jsonResponse({ error: 'simulated' }, config.fetchStatus);
      const request = JSON.parse(String(init?.body)) as { urls?: unknown };
      const urls = Array.isArray(request.urls) ? request.urls.filter((item): item is string => typeof item === 'string') : [];
      const value = typeof config.fetchValue === 'function'
        ? (config.fetchValue as (requestedUrls: string[]) => unknown)(urls)
        : config.fetchValue ?? { results: [], errors: [] };
      return jsonResponse(value);
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      if (url.endsWith(':countTokens')) return jsonResponse({ totalTokens: 100 });
      if (config.geminiStatus) return jsonResponse({ error: 'simulated' }, config.geminiStatus);
      if (config.geminiBody !== undefined) return new Response(config.geminiBody, { headers: { 'content-type': 'application/json' } });
      const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const packet = JSON.parse(request.contents[0]?.parts[0]?.text ?? '{}') as Record<string, unknown>;
      geminiPackets.push(packet);
      if (packet.method === criterionReviewMethod) {
        const input = packet.input as { scopeId: string; requiredIds: string[] };
        const value = config.criterionResponse?.(packet, geminiPackets.length) ?? { rows: input.requiredIds.map(criterionId => ({
          criterionId,
          scopeId: input.scopeId,
          evaluationState: 'UNAVAILABLE',
          outcome: null,
          rationale: 'This fixture leaves the independent criterion judgment unavailable.',
          citationIds: [],
          proof: {
            inspectionComplete: false,
            inspectedSourceIds: [],
            premises: [],
            representationWitnesses: [],
            posts: [],
            missingSupport: [],
            necessaryUnreadSourceIds: [],
          },
          failure: { category: 'MODEL', code: 'CRITERION_REVIEW_UNAVAILABLE', validationPaths: [`rows.${criterionId}`] },
        })) };
        return jsonResponse(attentionEnvelope(value));
      }
      if (packet.claimView && !config.useCitedClaimReviewCallback) {
        return jsonResponse(attentionEnvelope(comparisonRowsForV3(packet, withCriterionPremises(packet, citedAttentionReviewResponse(packet)))));
      }
      if (packet.method === 'binary-public-support-v5' && !config.useCitedEntryCallback) {
        return jsonResponse(comparisonRowsForV3(packet, withCriterionPremises(packet, citedV5EntryFixture(packet, packet.token as TokenRef))));
      }
      if (config.attentionResponse) return jsonResponse(comparisonRowsForV3(packet, withCriterionPremises(packet, config.attentionResponse(packet, geminiPackets.length))));
      return jsonResponse({ candidates: [] });
    }
    throw new Error('UNEXPECTED_MOCK_REQUEST');
  };
  const reset = () => { calls.length = 0; geminiPackets.length = 0; searchCalls = 0; dexCalls = 0; };
  return { calls, fetcher, geminiPackets, reset };
}

type FastCaptureFixture = {
  header: { mint: string; captureDate: string };
  context: {
    profile: Profile;
    cutoff: string;
    collection?: LiveBundle['collection'];
    market?: LiveBundle['market'];
    stageInputs?: NonNullable<LiveBundle['details']>['stageInputs'];
  };
  evidence?: LiveBundle['evidence'];
  rawArtifacts: Record<string, string>;
};

function fastCaptureFixture(name: string): FastCaptureFixture {
  return JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'fast', `${name}.json`), 'utf8')) as FastCaptureFixture;
}

test('public FAST route fixtures omit raw source/model envelopes and local capture paths', () => {
  const directory = join(process.cwd(), 'tests', 'fixtures', 'fast');
  const files = readdirSync(directory).filter(file => file.endsWith('.json')).sort();
  assert.deepEqual(files, [
    'alon-wsol-payer.json',
    'covena-dbc-route-pool.json',
    'fun-dbc-route-pool.json',
    'mutate-no-sell-route.json',
    'slingoor-slippage-r13.json',
  ]);
  for (const file of files) {
    const raw = readFileSync(join(directory, file), 'utf8');
    assert.doesNotMatch(raw, /sourceCapturePath|\.data[\\/]|thoughtSignature|criterion-input|attention-page-\d+/);
    const fixture = JSON.parse(raw) as FastCaptureFixture;
    assert.equal('criteria' in fixture.context, false, `${file} omits captured criterion judgments`);
    assert.ok(Object.keys(fixture.rawArtifacts).every(id => /^(?:jupiter-|rpc-|rugcheck-|dex-)/.test(id)),
      `${file} contains only route-provider evidence`);
  }
});

function fixtureJupiterHolders(fixture: FastCaptureFixture): Pick<HolderFacts, 'slot' | 'accounts'> | undefined {
  return retainedJupiterHolders(fixture.rawArtifacts, { chain: 'solana', address: fixture.header.mint });
}

function fastFixtureDerivation(fixture: FastCaptureFixture) {
  const token: TokenRef = { chain: 'solana', address: fixture.header.mint };
  const evidence = fixture.evidence ?? [];
  const availableAt = evidence.find(record => record.id === 'jupiter-sol-usd')?.retrievedAt ?? fixture.context.cutoff;
  const holders = fixtureJupiterHolders(fixture);
  const jupiterEvidenceIds = Object.keys(fixture.rawArtifacts).filter(id => id.startsWith('jupiter-'));
  const facts = fastRouteFacts(fixture.rawArtifacts, token, fixture.context.profile, availableAt, jupiterEvidenceIds);
  assert.ok(facts.venue, 'the captured ALON fixture includes a valid Jupiter route');
  const baseline = deriveBaseline({
    token,
    cutoff: fixture.context.cutoff,
    profile: fixture.context.profile,
    features: [],
    evidence,
    observations: [],
    ...(fixture.context.market ? { market: fixture.context.market } : {}),
    ...(fixture.context.collection ? { collection: fixture.context.collection } : {}),
    venue: facts.venue,
    venueOutcome: facts.failure,
    rugLiquidity: facts.rug,
    rugReportStatus: facts.rugReportStatus,
  });
  return { token, holders, venue: facts.venue, baseline };
}

function fastFixtureBundle(fixture: FastCaptureFixture, withGroups = false): LiveBundle {
  const { token, baseline } = fastFixtureDerivation(fixture);
  const cutoff = fixture.context.cutoff;
  const input = { method: criterionReviewMethod, token, cutoff, sources: [], catalog: [], acquisition: {} };
  const inputId = sha256(JSON.stringify(input));
  const proof = { reviewAttested: false, suppliedSourceIds: [], premises: [], representationWitnesses: [], posts: [], missingSupport: [] };
  const results = (['NAR-01', 'ADV-03'] as const).map(criterionId => ({
    criterionId,
    scopeId: inputId,
    evaluationState: 'UNAVAILABLE' as const,
    outcome: null,
    basis: 'SYNTHETIC_FIXTURE_NO_SOURCE_REVIEW',
    rationale: 'Synthetic route fixture intentionally omits source and model judgments.',
    citationIds: [],
    proof,
    failure: { category: 'COLLECTION' as const, code: 'SYNTHETIC_FIXTURE_NO_SOURCE_REVIEW', validationPaths: [] },
  }));
  const criteria = {
    method: criterionReviewMethod,
    token,
    policyId: 'research-fast-v3' as const,
    generationMethod: 'single-generation-v1' as const,
    inputId,
    qualifiedAt: cutoff,
    results,
  };
  const rawArtifacts: Record<string, string> = {
    ...fixture.rawArtifacts,
    'criterion-input': JSON.stringify({ ...input, inputId }),
    'fast-single-generation': JSON.stringify({
      method: 'fast-single-generation-v1',
      policyId: 'research-fast-v3',
      token,
      inputId,
      frozenCutoff: cutoff,
      promptSha256: null,
      promptChars: 0,
      validationSchemaSha256: sha256('synthetic-fast-route-fixture-v1'),
      logicalGenerations: 0,
      semanticRepairAttempts: 0,
      independentReview: false,
      transportAttempts: 0,
      fallbackUsed: false,
      finalModel: null,
      responseSha256: null,
      inputTokens: null,
      outputTokens: null,
      rows: results.map(row => ({ criterionId: row.criterionId, outcome: null, category: 'COLLECTION', code: 'SYNTHETIC_FIXTURE_NO_SOURCE_REVIEW', unfinishedReason: null })),
      observed: { startedAt: cutoff, completedAt: cutoff },
    }),
  };
  const syntheticEvidence = (id: string): LiveBundle['evidence'][number] => ({
    id,
    sourceId: 'attention-collector',
    sourceType: 'SAMPLE_SCOPE',
    retrievedAt: cutoff,
    availableAt: cutoff,
    contentHash: sha256(rawArtifacts[id]!),
    adapterVersion: 'live-v1',
    accessMode: 'LOCAL_DERIVED',
    scope: { method: 'synthetic-fast-route-fixture-v1' },
  });
  const evidence = [
    ...(fixture.evidence ?? []),
    syntheticEvidence('criterion-input'),
    syntheticEvidence('fast-single-generation'),
  ];
  const details: NonNullable<LiveBundle['details']> = {
    version: 1,
    profile: fixture.context.profile,
    thesis: null,
    baseline,
    origins: {},
    stageInputs: fixture.context.stageInputs!,
    criteria,
  };
  const bundle: LiveBundle = {
    analysisKind: 'LIVE',
    token,
    cutoff: fixture.context.cutoff,
    evidence,
    rawArtifacts,
    observations: [],
    features: baseline.flatMap(row => row.projection ? [row.projection] : []),
    profile: fixture.context.profile,
    collection: fixture.context.collection!,
    semantic: { status: 'NOT_REQUESTED', claims: [] },
    market: fixture.context.market!,
    details,
  };
  if (withGroups) details.groups = entryGroupsForBundle({ ...bundle, details });
  return bundle;
}

type ProviderFailureCase = {
  quote?: { side: 'buy' | 'sell'; responses: Array<{ status: number; body: string }> };
  rugCheck?: { status: number; emptyMarkets?: boolean };
  rowIds: string[];
};

type FastCauseRow = { checkId: string; outcome: string | undefined; causeCodes: string[]; reason: string };

async function runAlonProviderFailure({ quote, rugCheck, rowIds }: ProviderFailureCase): Promise<FastCauseRow[]> {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
  let service: Service | undefined;
  try {
    const fixture = fastCaptureFixture('alon-wsol-payer');
    const bundle = fastFixtureBundle(fixture);
    assert.ok(bundle.details?.criteria);
    const setArtifact = (id: string, raw: string) => {
      bundle.rawArtifacts[id] = raw;
      const evidence = bundle.evidence.find(item => item.id === id);
      if (evidence) evidence.contentHash = sha256(raw);
    };
    for (const [id, raw] of Object.entries(fixture.rawArtifacts)) setArtifact(id, raw);
    if (quote) {
      let responseIndex = 0;
      const client = createJupiterClient(async () => {
        const item = quote.responses[Math.min(responseIndex++, quote.responses.length - 1)]!;
        return new Response(item.body, { status: item.status, headers: { 'content-type': 'application/json' } });
      }, async () => {});
      const request = JSON.parse(bundle.rawArtifacts[`jupiter-${quote.side}-quote-request`]!) as {
        inputMint: string; outputMint: string; amount: string; slippageBps: number;
      };
      const result = await client.quote(request.inputMint, request.outputMint, request.amount, request.slippageBps);
      const id = `jupiter-${quote.side}-quote`;
      const setAttempt = (attemptId: string, raw: string) => {
        if (!bundle.evidence.some(item => item.id === attemptId)) {
          const templateId = `${id}-attempt-1${attemptId.endsWith('-status') ? '-status' : ''}`;
          const template = bundle.evidence.find(item => item.id === templateId);
          assert.ok(template, `captured evidence template ${templateId} exists`);
          bundle.evidence.push({ ...template, id: attemptId, scope: { ...template.scope, operation: attemptId } });
        }
        setArtifact(attemptId, raw);
      };
      setArtifact(id, result.raw);
      setArtifact(`${id}-status`, JSON.stringify({ status: result.status }));
      for (const [index, attempt] of result.attempts.entries()) {
        const attemptId = `${id}-attempt-${index + 1}`;
        setAttempt(attemptId, attempt.raw);
        setAttempt(`${attemptId}-status`, JSON.stringify({ status: attempt.status }));
      }
    }

    if (rugCheck) {
      const report = rugCheck.emptyMarkets ? JSON.parse(bundle.rawArtifacts['rugcheck-report']!) : null;
      if (report) report.markets = [];
      const body = rugCheck.emptyMarkets ? JSON.stringify(report) : 'rate limited';
      const client = createRugCheckClient(async () => new Response(body, {
        status: rugCheck.status, headers: { 'content-type': 'application/json' },
      }), async () => {});
      const result = await client.report(bundle.token.address);
      setArtifact('rugcheck-report-status', JSON.stringify({ status: result.status }));
      if (result.status === 200) setArtifact('rugcheck-report', result.raw);
    }

    const evidenceIds = bundle.evidence.filter(item => item.id.startsWith('jupiter-')).map(item => item.id);
    const availableAt = bundle.evidence.find(item => item.id === 'jupiter-sol-usd')!.retrievedAt;
    const facts = fastRouteFacts(bundle.rawArtifacts, bundle.token, bundle.profile, availableAt, evidenceIds);
    const baseline = deriveBaseline({
      token: bundle.token, cutoff: bundle.cutoff, profile: bundle.profile, features: [], evidence: bundle.evidence,
      observations: [],
      ...(bundle.market ? { market: bundle.market } : {}),
      ...(bundle.collection ? { collection: bundle.collection } : {}),
      ...(facts.venue ? { venue: facts.venue } : {}),
      ...(facts.failure ? { venueOutcome: facts.failure } : {}),
      ...(facts.rug ? { rugLiquidity: facts.rug } : {}),
      rugReportStatus: facts.rugReportStatus,
    });
    for (const row of baseline.filter(item => ['O08', 'O09', 'O10', 'O11', 'O12', 'O13', 'O14', 'O15', 'O16', 'C02'].includes(item.id))) {
      const index = bundle.details!.baseline.findIndex(item => item.id === row.id);
      if (index >= 0) bundle.details!.baseline[index] = row;
      else bundle.details!.baseline.push(row);
      bundle.features = bundle.features.filter(feature => feature.id !== row.id);
      if (row.projection) bundle.features.push(row.projection);
    }
    const details = bundle.details;
    assert.ok(details);
    details.groups = entryGroupsForBundle({ ...bundle, details });

    service = new Service(':memory:');
    const snapshot = service.analyzeLive(bundle);
    const lines = renderSnapshot(snapshot).split('\n');
    const explanations = explainChecks(snapshot);
    return rowIds.map(checkId => {
      const line = lines.findIndex(item => item.startsWith(`${checkId}: `));
      return {
        checkId,
        outcome: snapshot.details?.fast?.rows.find(row => row.checkId === checkId)?.outcome,
        causeCodes: explanations.find(row => row.checkId === checkId)?.causes.map(cause => cause.code) ?? [],
        reason: lines[line + 1]?.trim() ?? '',
      };
    });
  } finally {
    service?.close();
    globalThis.fetch = savedFetch;
  }
}

function assertFastCauseRows(rows: FastCauseRow[], ids: string[], code: string, reason: string, contains = false) {
  assert.deepEqual(rows.map(row => [row.checkId, row.outcome]), ids.map(id => [id, 'UNKNOWN']));
  for (const row of rows) {
    assert.ok(row.causeCodes.includes(code), `${row.checkId} retains ${code}`);
    assert.ok(!row.causeCodes.includes('LIVE_DEPENDENCY_SKIPPED'), `${row.checkId} does not replace the provider cause`);
    if (contains) assert.ok(row.reason.includes(reason), `${row.checkId} renders ${reason}`);
    else assert.equal(row.reason, `Reason: ${reason}`);
  }
}

function mockedJupiterReplayFetch(bundle: Pick<LiveBundle, 'token' | 'rawArtifacts'>) {
  const raw = bundle.rawArtifacts;
  const calls: string[] = [];
  const attemptCounts = new Map<string, number>();
  const attemptsFor = (id: string) => Object.keys(raw)
    .filter(key => new RegExp(`^${id}-attempt-[1-4]$`).test(key))
    .sort((a, b) => Number(a.slice(a.lastIndexOf('-') + 1)) - Number(b.slice(b.lastIndexOf('-') + 1)));
  const response = (id: string, status = 200) => {
    const body = raw[id];
    if (body === undefined) throw new Error(`JUPITER_MOCK_ARTIFACT_MISSING_${id}`);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://api.dexscreener.com/')) return response('jupiter-sol-usd');
    if (url.startsWith('https://lite-api.jup.ag/swap/v1/quote')) {
      const parsed = new URL(url);
      const id = parsed.searchParams.get('inputMint') === OTHER_MINT ? 'jupiter-buy-quote' : 'jupiter-sell-quote';
      const attempts = attemptsFor(id);
      const index = attemptCounts.get(id) ?? 0;
      attemptCounts.set(id, index + 1);
      const artifact = attempts[Math.min(index, attempts.length - 1)] ?? id;
      const statusRaw = raw[`${artifact}-status`] ?? raw[`${id}-status`];
      const status = statusRaw ? JSON.parse(statusRaw).status as number : 200;
      return response(artifact, status);
    }
    if (url === 'https://lite-api.jup.ag/swap/v1/swap') {
      const request = JSON.parse(String(init?.body)) as { quoteResponse: { inputMint: string } };
      const id = request.quoteResponse.inputMint === OTHER_MINT ? 'jupiter-buy-swap' : 'jupiter-sell-swap';
      const attempts = attemptsFor(id);
      const index = attemptCounts.get(id) ?? 0;
      attemptCounts.set(id, index + 1);
      const artifact = attempts[Math.min(index, attempts.length - 1)] ?? id;
      const statusRaw = raw[`${artifact}-status`] ?? raw[`${id}-status`];
      const status = statusRaw ? JSON.parse(statusRaw).status as number : 200;
      return response(artifact, status);
    }
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      const wire = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const canonical = JSON.stringify({ method: wire.method, params: wire.params });
      const requestId = Object.keys(raw).find(key => key.endsWith('-request') && raw[key] === canonical);
      if (!requestId) throw new Error(`JUPITER_MOCK_RPC_REQUEST_MISSING_${wire.method}`);
      return response(requestId.slice(0, -'-request'.length));
    }
    throw new Error(`JUPITER_MOCK_UNEXPECTED_URL_${new URL(url).hostname}`);
  };
  return { calls, fetcher };
}

test('ALON wSOL payer simulation is accepted from captured route bytes', () => {
  const fixture = fastCaptureFixture('alon-wsol-payer');
  assert.equal(fixture.header.captureDate, '2026-11-01');
  const { token, venue } = fastFixtureDerivation(fixture);
  assert.equal(token.address, fixture.header.mint);
  assert.ok(venue.simulation?.buySucceeded && venue.simulation.sellSucceeded);
  const payer = (JSON.parse(fixture.rawArtifacts['jupiter-buy-swap-request']!) as { userPublicKey: string }).userPublicKey;
  const addresses = JSON.parse(fixture.rawArtifacts['jupiter-buy-accounts-1-request']!).params[0] as string[];
  const before = JSON.parse(fixture.rawArtifacts['jupiter-buy-accounts-1']!).result.value as Array<any>;
  const after = JSON.parse(fixture.rawArtifacts['jupiter-buy-simulation']!).result.value as { preBalances: number[]; postBalances: number[] };
  const wsolDebits = before.flatMap((account, index) => {
    const info = account?.data?.parsed?.info;
    return info?.mint === OTHER_MINT && info.owner === payer
      ? [BigInt(after.preBalances[index]!) - BigInt(after.postBalances[index]!)] : [];
  });
  assert.ok(wsolDebits.some(delta => delta > 0n), 'the payer contributes wrapped SOL during the buy');
  const nativeDebit = BigInt(after.preBalances[0]!) - BigInt(after.postBalances[0]!);
  assert.equal(venue.buyPaymentLamports, (nativeDebit + wsolDebits.reduce((sum, delta) => sum + delta, 0n)).toString());
  assert.ok(addresses.length > 0);
});

test('Jupiter retries a mocked 429 with pacing and derives rows from the successful quote', async () => {
  const fixture = fastCaptureFixture('alon-wsol-payer');
  const token: TokenRef = { chain: 'solana', address: fixture.header.mint };
  const raw = { ...fixture.rawArtifacts };
  const waits: number[] = [];
  let calls = 0;
  const successfulRaw = raw['jupiter-buy-quote']!;
  const client = createJupiterClient(async () => {
    calls++;
    return calls === 1 ? jsonResponse({ error: 'rate limited' }, 429) : new Response(successfulRaw, {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }, async milliseconds => { waits.push(milliseconds); });
  const requestedAmount = JSON.parse(raw['jupiter-buy-quote-request']!).amount as string;
  const result = await client.quote(OTHER_MINT, token.address, requestedAmount, 500);
  assert.equal(calls, 2);
  assert.equal(result.status, 200);
  assert.equal(result.attempts.length, 2);
  assert.equal(waits[0], 1500, 'the provider 429 receives the linear retry backoff');
  assert.ok(waits[1]! >= 1000 && waits[1]! <= 1100, 'the retry also observes the minimum start spacing, allowing elapsed milliseconds');
  raw['jupiter-buy-quote-attempt-1'] = result.attempts[0]!.raw;
  raw['jupiter-buy-quote-attempt-1-status'] = JSON.stringify({ status: 429 });
  raw['jupiter-buy-quote-attempt-2'] = result.raw;
  raw['jupiter-buy-quote-attempt-2-status'] = JSON.stringify({ status: 200 });
  raw['jupiter-buy-quote'] = result.raw;
  raw['jupiter-buy-quote-status'] = JSON.stringify({ status: 200 });
  const holders = fixtureJupiterHolders(fixture);
  const route = deriveJupiterRoute(raw, token, fixture.context.profile, holders as HolderFacts | undefined, fixture.context.cutoff, Object.keys(raw)).venue;
  assert.equal(route.acquiredAtomic, (result.value as { outAmount: string }).outAmount);
  const baseline = deriveBaseline({ token, cutoff: fixture.context.cutoff, profile: fixture.context.profile,
    features: [], evidence: [], observations: [], venue: route });
  assert.equal(evaluateEntry(baseline.flatMap(row => row.projection ? [row.projection] : []), fixture.context.profile, fixture.context.cutoff, 'QUALIFIED_V2')
    .checks.find(row => row.checkId === 'EXE-01')?.status, 'PASS');
});

test('missing Jupiter holder data leaves the buy simulation UNKNOWN with its acquisition cause', () => {
  const fixture = fastCaptureFixture('alon-wsol-payer');
  const { token } = fastFixtureDerivation(fixture);
  const route = deriveJupiterRoute(fixture.rawArtifacts, token, fixture.context.profile, undefined, fixture.context.cutoff,
    Object.keys(fixture.rawArtifacts)).venue;
  assert.equal(route.simulationCode, 'JUPITER_HOLDERS_UNAVAILABLE');
  const noPayerBaseline = deriveBaseline({ token, cutoff: fixture.context.cutoff, profile: fixture.context.profile,
    features: [], evidence: [], observations: [], venue: route });
  assert.equal(noPayerBaseline.find(row => row.id === 'O12')?.causes[0]?.code, 'JUPITER_HOLDERS_UNAVAILABLE');
  assert.equal(evaluateEntry(noPayerBaseline.flatMap(row => row.projection ? [row.projection] : []), fixture.context.profile, fixture.context.cutoff, 'QUALIFIED_V2')
    .checks.find(row => row.checkId === 'EXE-03')?.status, 'UNKNOWN');
});

test('mutate no sell route keeps buy rows and marks EXE-01 through EXE-03 INSUFFICIENT', () => {
  const fixture = fastCaptureFixture('mutate-no-sell-route');
  const service = new Service(':memory:');
  try {
    const snapshot = service.analyzeLive(fastFixtureBundle(fixture));
    const route = snapshot.details?.baseline.find(row => row.id === 'O08')?.data as { route?: unknown[]; sellCode?: string; buySucceeded?: boolean };
    assert.ok(route.route?.length);
    assert.equal(route.buySucceeded, true);
    assert.equal(route.sellCode, 'JUPITER_NO_ROUTE');
    assert.deepEqual(snapshot.details?.fast?.rows.filter(row => ['EXE-01', 'EXE-02', 'EXE-03'].includes(row.checkId))
      .map(row => [row.checkId, row.outcome]), [['EXE-01', 'INSUFFICIENT'], ['EXE-02', 'INSUFFICIENT'], ['EXE-03', 'INSUFFICIENT']]);
  } finally { service.close(); }
});

test('COVENA LIQ-01 judges the DBC Jupiter route pool as program-held with zero removable', () => {
  const fixture = fastCaptureFixture('covena-dbc-route-pool');
  const service = new Service(':memory:');
  try {
    const snapshot = service.analyzeLive(fastFixtureBundle(fixture, true));
    const pools = rugRoutePools(fixture.rawArtifacts, fixture.header.mint);
    const liquidity = snapshot.details?.baseline.find(row => row.id === 'O09');
    assert.ok(pools.length > 0 && liquidity);
    assert.deepEqual(liquidity.data, {
      fraction: '0', pool: pools[0], marketType: 'bonding curve', source: 'program-held bonding curve',
    });
    assert.equal(snapshot.details?.fast?.rows.find(row => row.checkId === 'LIQ-01')?.outcome, 'SUPPORTED');
  } finally { service.close(); }
});

test('RugCheck AMM and LOCKER labels are attributed and locked supply is reported', () => {
  const fixture = fastCaptureFixture('covena-dbc-route-pool');
  const service = new Service(':memory:');
  try {
    const snapshot = service.analyzeLive(fastFixtureBundle(fixture, true));
    const ownerGroup = snapshot.details?.groups?.groups.find(group => group.checkId === 'ADV-01');
    const population = JSON.parse(fixture.rawArtifacts['rpc-holder-population']!).result.value as Array<{ pubkey: string; account: { data: [string, string] } }>;
    const knownAccounts = JSON.parse(fixture.rawArtifacts['rugcheck-report']!).knownAccounts as Record<string, { type: string }>;
    const mint = JSON.parse(fixture.rawArtifacts['rpc-mint-raw']!).result.value as { data: [string, string] };
    const supply = Buffer.from(mint.data[0], 'base64').readBigUInt64LE(36);
    const labeled: Array<{ address: string; amount: bigint; type: string }> = [];
    for (const item of population) {
      const bytes = Buffer.from(item.account.data[0], 'base64');
      const owner = new PublicKey(bytes.subarray(32, 64)).toBase58();
      const type = knownAccounts[owner]?.type;
      if (type === 'AMM' || type === 'LOCKER') labeled.push({ address: item.pubkey, amount: bytes.readBigUInt64LE(64), type });
    }
    assert.ok(ownerGroup && labeled.length > 0);
    assert.equal(ownerGroup.status, 'PASS');
    const excluded = ownerGroup.metrics.excludedVaults as string[];
    assert.ok(labeled.every(row => excluded.includes(row.address)));
    const locked = labeled.filter(row => row.type === 'LOCKER').reduce((sum, row) => sum + row.amount, 0n);
    assert.ok(Math.abs(Number(ownerGroup.metrics.lockedSupplyFraction) - Number(locked) / Number(supply)) < 1e-12);
    assert.ok(ownerGroup.limitations.some(item => /third-party AMM and locker labels are attributed to RugCheck/i.test(item)));
  } finally { service.close(); }
});

test('FUN route pool is program-held with zero removable liquidity while OWN-02 remains wallet-only', () => {
  const fixture = fastCaptureFixture('fun-dbc-route-pool');
  const service = new Service(':memory:');
  try {
    const snapshot = service.analyzeLive(fastFixtureBundle(fixture, true));
    const ownerGroup = snapshot.details?.groups?.groups.find(group => group.checkId === 'ADV-01');
    const liquidity = snapshot.details?.baseline.find(row => row.id === 'O09');
    const executionCause = snapshot.details?.baseline.find(row => row.id === 'O12')?.causes[0]?.code;
    const pool = JSON.parse(fixture.rawArtifacts['jupiter-buy-quote']!).routePlan[0].swapInfo.ammKey as string;
    assert.ok(ownerGroup && liquidity);
    assert.equal(ownerGroup.status, 'PASS');
    assert.match(ownerGroup.rationale, /on-curve wallets only; program-held supply is reported separately/i);
    assert.ok(Number(ownerGroup.metrics.programHeldSupplyFraction) > 0);
    assert.equal(snapshot.details?.fast?.rows.find(row => row.checkId === 'OWN-02')?.outcome, 'SUPPORTED');
    assert.deepEqual(liquidity.data, { fraction: '0', pool, marketType: 'bonding curve', source: 'program-held bonding curve' });
    assert.equal(snapshot.details?.fast?.rows.find(row => row.checkId === 'LIQ-01')?.outcome, 'SUPPORTED');
    assert.equal(executionCause, 'JUPITER_SELL_PAYER_UNAVAILABLE');
    assert.equal(snapshot.details?.fast?.rows.find(row => row.checkId === 'EXE-03')?.outcome, 'UNKNOWN');
  } finally { service.close(); }
});

test('Jupiter accepts quoted minimum deltas, rejects a short delta, and records a partial sell fraction', () => {
  const fixture = fastCaptureFixture('alon-wsol-payer');
  const token: TokenRef = { chain: 'solana', address: fixture.header.mint };
  const raw: Record<string, string> = { ...fixture.rawArtifacts };
  const buyQuote = JSON.parse(raw['jupiter-buy-quote']!) as { outAmount: string; otherAmountThreshold: string };
  const buyPayer = (JSON.parse(raw['jupiter-buy-swap-request']!) as { userPublicKey: string }).userPublicKey;
  const beforeBuy = JSON.parse(raw['jupiter-buy-accounts-1']!) as { result: { value: Array<any> } };
  const afterBuy = JSON.parse(raw['jupiter-buy-simulation']!) as { result: { value: { accounts: Array<any> } } };
  let selected = 0;
  let buyDelta: bigint|undefined;
  for (const account of beforeBuy.result.value) {
    const info = account?.data?.parsed?.info;
    if (info?.mint !== token.address) continue;
    if (info.owner === buyPayer) buyDelta = BigInt(afterBuy.result.value.accounts[selected].data.parsed.info.tokenAmount.amount) - BigInt(info.tokenAmount.amount);
    selected++;
  }
  assert.ok(buyDelta && buyDelta > 0n);
  const setBuyMinimum = (candidate: Record<string, string>, minimum: bigint) => {
    const quote = JSON.parse(candidate['jupiter-buy-quote']!) as Record<string, any>;
    quote.otherAmountThreshold = minimum.toString();
    candidate['jupiter-buy-quote'] = JSON.stringify(quote);
    for (const id of Object.keys(candidate).filter(key => /^jupiter-buy-quote-attempt-\d+$/.test(key))) candidate[id] = JSON.stringify(quote);
    const swapRequest = JSON.parse(candidate['jupiter-buy-swap-request']!) as Record<string, any>;
    swapRequest.quoteResponse = quote;
    candidate['jupiter-buy-swap-request'] = JSON.stringify(swapRequest);
  };
  const acceptedRaw = { ...raw };
  setBuyMinimum(acceptedRaw, buyDelta);
  const acceptedHolders = fixtureJupiterHolders(fixture);
  assert.ok(acceptedHolders);
  const accepted = deriveJupiterRoute(acceptedRaw, token, fixture.context.profile, acceptedHolders as HolderFacts, fixture.context.cutoff, Object.keys(acceptedRaw)).venue;
  assert.ok(accepted.simulation, 'a simulated buy delta meeting the quoted minimum is accepted');

  const shortRaw = { ...acceptedRaw };
  setBuyMinimum(shortRaw, buyDelta + 1n);
  const shortHolders = fixtureJupiterHolders(fixture);
  assert.ok(shortHolders);
  assert.equal(deriveJupiterRoute(shortRaw, token, fixture.context.profile, shortHolders as HolderFacts, fixture.context.cutoff, Object.keys(shortRaw)).venue.simulationCode,
    'JUPITER_SIMULATION_DELTA', 'a simulated buy delta below the quoted minimum is rejected');

  const partialRaw = { ...acceptedRaw };
  const holders = fixtureJupiterHolders(fixture);
  assert.ok(holders);
  const required = BigInt(buyQuote.outAmount);
  const quantity = required / 2n;
  const payer = (JSON.parse(partialRaw['jupiter-sell-swap-request']!) as { userPublicKey: string }).userPublicKey;
  const candidatesRequest = JSON.parse(partialRaw['jupiter-payers-request']!) as { params: [string[], unknown[]] };
  const priorCandidates = candidatesRequest.params[0];
  const payerIndex = priorCandidates.indexOf(payer);
  assert.ok(payerIndex >= 0);
  const payers = JSON.parse(partialRaw['jupiter-payers']!) as { result: { value: unknown[] } };
  payers.result.value = [payers.result.value[payerIndex]];
  candidatesRequest.params[0] = [payer];
  partialRaw['jupiter-payers-request'] = JSON.stringify(candidatesRequest);
  partialRaw['jupiter-payers'] = JSON.stringify(payers);
  holders.accounts = holders.accounts.filter(account => account.owner === payer).slice(0, 1).map(account => ({ ...account, amount: quantity.toString() }));
  assert.equal(holders.accounts.length, 1);

  const sellBefore = JSON.parse(partialRaw['jupiter-sell-accounts-1']!) as { result: { value: Array<any> } };
  const sellAfter = JSON.parse(partialRaw['jupiter-sell-simulation']!) as { result: { value: { accounts: Array<any> } } };
  let selectedSell = 0;
  let payerSellIndex = -1;
  for (const account of sellBefore.result.value) {
    const info = account?.data?.parsed?.info;
    if (info?.mint !== token.address) continue;
    if (info.owner === payer) {
      payerSellIndex = selectedSell;
      info.tokenAmount.amount = quantity.toString();
    }
    selectedSell++;
  }
  assert.ok(payerSellIndex >= 0);
  sellAfter.result.value.accounts[payerSellIndex].data.parsed.info.tokenAmount.amount = '0';
  partialRaw['jupiter-sell-accounts-1'] = JSON.stringify(sellBefore);
  partialRaw['jupiter-sell-simulation'] = JSON.stringify(sellAfter);
  const sellQuote = JSON.parse(partialRaw['jupiter-sell-quote']!) as Record<string, any>;
  const fullSellAmount = BigInt(sellQuote.inAmount);
  const partialQuote = {
    ...sellQuote,
    inAmount: quantity.toString(),
    outAmount: (BigInt(sellQuote.outAmount) * quantity / fullSellAmount).toString(),
    otherAmountThreshold: (BigInt(sellQuote.otherAmountThreshold) * quantity / fullSellAmount).toString(),
  };
  partialRaw['jupiter-sell-simulation-quote-request'] = JSON.stringify({ inputMint: token.address, outputMint: OTHER_MINT, amount: quantity.toString(), slippageBps: 500 });
  partialRaw['jupiter-sell-simulation-quote-attempt-1'] = JSON.stringify(partialQuote);
  partialRaw['jupiter-sell-simulation-quote-attempt-1-status'] = JSON.stringify({ status: 200 });
  partialRaw['jupiter-sell-simulation-quote'] = JSON.stringify(partialQuote);
  partialRaw['jupiter-sell-simulation-quote-status'] = JSON.stringify({ status: 200 });
  partialRaw['jupiter-sell-swap-request'] = JSON.stringify({ quoteResponse: partialQuote, userPublicKey: payer, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true });
  const partial = deriveJupiterRoute(partialRaw, token, fixture.context.profile, holders as HolderFacts, fixture.context.cutoff, Object.keys(partialRaw)).venue;
  assert.ok(partial.simulation);
  assert.equal(partial.simulation.simulatedFraction, '0.5');
});

test('FAST report displays Jupiter route-vault exclusions only when present and preserves zero-generation provider causes', () => {
  const fixture = fastCaptureFixture('covena-dbc-route-pool');
  const service = new Service(':memory:');
  try {
    const snapshot = service.analyzeLive(fastFixtureBundle(fixture, true));
    assert.ok(snapshot.details?.fast && snapshot.details.groups && snapshot.details.criteria && snapshot.details.fastGeneration);
    const empty = structuredClone(snapshot) as any;
    const owner = empty.details.groups.groups.find((group: { checkId: string }) => group.checkId === 'ADV-01');
    owner.status = 'PASS';
    owner.metrics.excludedVaults = [];
    empty.details.fast.rows.find((row: { checkId: string }) => row.checkId === 'ADV-01').outcome = 'SUPPORTED';
    const emptyText = renderSnapshot(empty);
    const emptyLines = emptyText.split('\n');
    const emptyIndex = emptyLines.findIndex(line => line.startsWith('ADV-01:'));
    const emptyLine = emptyLines.slice(emptyIndex, emptyIndex + 2).join('\n');
    assert.match(emptyLine, /no vault exclusion was claimed/i);
    assert.doesNotMatch(emptyLine, /excluded vaults?: [^;\n]+/i);
    owner.metrics.excludedVaults = ['verified Jupiter route vault'];
    owner.rationale = 'The verified Jupiter route vault was excluded from the owner measure.';
    assert.match(renderSnapshot(empty), /verified Jupiter route vault was excluded/i);

    const provider = structuredClone(snapshot) as any;
    provider.details.fastGeneration.logicalGenerations = 0;
    provider.details.fast.rows.find((row: { checkId: string }) => row.checkId === 'NAR-01').outcome = 'UNKNOWN';
    const judgment = provider.details.criteria.results.find((row: { criterionId: string }) => row.criterionId === 'NAR-01');
    judgment.evaluationState = 'UNAVAILABLE';
    judgment.outcome = null;
    judgment.failure = { category: 'INFRA', code: 'CRITERION_MODEL_HTTP_503', validationPaths: [] };
    const providerLines = renderSnapshot(provider).split('\n');
    const narIndex = providerLines.findIndex(line => line.startsWith('NAR-01: UNKNOWN'));
    assert.match(providerLines[narIndex + 1] ?? '', /Provider unavailable: CRITERION_MODEL_HTTP_503/);
    assert.doesNotMatch(providerLines[narIndex + 1] ?? '', /Model unavailable/i);
  } finally { service.close(); }
});

test('Slingoor retries one slippage and reports a repeated slippage as UNKNOWN with its cause', async () => {
  const fixture = fastCaptureFixture('slingoor-slippage-r13');
  const token: TokenRef = { chain: 'solana', address: fixture.header.mint };
  const holders = fixtureJupiterHolders(fixture);
  assert.ok(holders);
  const buySwap = (JSON.parse(fixture.rawArtifacts['jupiter-buy-swap']!) as { swapTransaction: string }).swapTransaction;
  const replay = async (repeat: boolean) => {
    const mock = mockedJupiterReplayFetch({ token, rawArtifacts: fixture.rawArtifacts });
    let buyQuotes = 0, buySimulations = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://lite-api.jup.ag/swap/v1/quote') && new URL(url).searchParams.get('inputMint') === OTHER_MINT) buyQuotes++;
      if (url.startsWith('https://rpc.example/')) {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (request.method === 'simulateTransaction' && request.params[0] === buySwap) {
          buySimulations++;
          if (buySimulations === 2 && !repeat) {
            const second = JSON.parse(fixture.rawArtifacts['jupiter-buy-simulation']!);
            second.result.value.err = null;
            return jsonResponse(second);
          }
        }
      }
      return mock.fetcher(input, init);
    };
    const capture = await inspectJupiterRoute(token, fixture.context.profile, holders as HolderFacts | undefined, RPC_URL, fetcher, () => fixture.context.cutoff);
    assert.equal(buyQuotes, 2);
    assert.equal(buySimulations, 2);
    const raw = { ...fixture.rawArtifacts, ...capture.rawArtifacts };
    const venue = deriveJupiterRoute(raw, token, fixture.context.profile, holders as HolderFacts | undefined,
      capture.retrievedAt['jupiter-sol-usd']!, Object.keys(raw)).venue;
    return { raw, venue, finalSimulation: JSON.parse(capture.rawArtifacts['jupiter-buy-simulation']!) };
  };

  const recovered = await replay(false);
  assert.equal(recovered.finalSimulation.result.value.err, null,
    'the stub supplies the second observed response after the captured first slippage');
  assert.ok(recovered.raw['jupiter-buy-first-simulation']);
  const repeated = await replay(true);
  assert.equal(repeated.venue.simulationCode, 'JUPITER_SLIPPAGE_MOVED_TWICE');
  const baseline = deriveBaseline({ token, cutoff: fixture.context.cutoff, profile: fixture.context.profile,
    features: [], evidence: [], observations: [], venue: repeated.venue });
  assert.equal(baseline.find(row => row.id === 'O12')?.causes[0]?.code, 'JUPITER_SLIPPAGE_MOVED_TWICE');
  assert.equal(evaluateEntry(baseline.flatMap(row => row.projection ? [row.projection] : []), fixture.context.profile, fixture.context.cutoff, 'QUALIFIED_V2')
    .checks.find(row => row.checkId === 'EXE-03')?.status, 'UNKNOWN');
  assert.ok(repeated.raw['jupiter-buy-first-simulation']);
});

test('Jupiter no-route cause reaches FAST row reasons', async () => {
  const ids = ['SEC-05', 'CAP-01', 'ADV-05', 'EXE-01', 'EXE-02', 'EXE-03'];
  const rows = await runAlonProviderFailure({
    quote: { side: 'buy', responses: [{ status: 400, body: JSON.stringify({ errorCode: 'NO_ROUTES_FOUND' }) }] }, rowIds: ids,
  });
  assertFastCauseRows(rows, ids, 'JUPITER_NO_ROUTE', 'Jupiter found no route for the requested trade.');
});

test('Jupiter quote outage cause reaches FAST row reasons after three 429 responses', async () => {
  const ids = ['SEC-05', 'CAP-01', 'ADV-05', 'EXE-01', 'EXE-02', 'EXE-03'];
  const rows = await runAlonProviderFailure({
    quote: { side: 'buy', responses: [429, 429, 429, 503].map(status => ({ status, body: 'upstream unavailable' })) }, rowIds: ids,
  });
  assertFastCauseRows(rows, ids, 'JUPITER_PROVIDER_UNAVAILABLE', 'Jupiter did not provide the requested quote or swap.');
});

test('RugCheck 429 cause reaches the LIQ-01 reason', async () => {
  const rows = await runAlonProviderFailure({ rugCheck: { status: 429 }, rowIds: ['LIQ-01'] });
  assertFastCauseRows(rows, ['LIQ-01'], 'RUGCHECK_REPORT_UNAVAILABLE', 'RugCheck report unavailable (HTTP 429)', true);
});

test('uncovered RugCheck route pool has a distinct LIQ-01 cause', async () => {
  const rows = await runAlonProviderFailure({ rugCheck: { status: 200, emptyMarkets: true }, rowIds: ['LIQ-01'] });
  assertFastCauseRows(rows, ['LIQ-01'], 'JUPITER_LIQUIDITY_UNAVAILABLE', 'Route pool not covered by the RugCheck report.');
});

test('sell quote outage cause reaches FAST execution row reasons', async () => {
  const ids = ['EXE-01', 'EXE-02', 'EXE-03'];
  const rows = await runAlonProviderFailure({
    quote: { side: 'sell', responses: [{ status: 503, body: 'upstream unavailable' }] }, rowIds: ids,
  });
  assertFastCauseRows(rows, ids, 'JUPITER_PROVIDER_UNAVAILABLE', 'Jupiter did not provide the requested quote or swap.');
});

test('the standalone RPC inspection makes one bounded genesis-only mainnet check', async (t) => {
  await t.test('a valid mainnet response uses one getGenesisHash request with no account lookup', async () => {
    const mock = mockedFetch();
    const read = await inspectSolanaRpc(RPC_URL, mock.fetcher);
    assert.equal(read.status, 'OBSERVED');
    assert.equal(read.genesisHash, SOLANA_MAINNET_GENESIS);
    assert.ok(read.genesisRaw);
    assert.equal(read.accountRaw, undefined);
    assert.equal(read.mint, undefined);
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0]!;
    assert.equal(call.url, RPC_URL);
    assert.equal(call.init?.method, 'POST');
    assert.ok(call.init?.signal instanceof AbortSignal);
    assert.equal((call.init?.signal as AbortSignal).aborted, false);
    const request = JSON.parse(String(call.init?.body)) as { method: string; params: unknown[] };
    assert.equal(request.method, 'getGenesisHash');
    assert.deepEqual(request.params, []);
  });

  await t.test('a wrong cluster is rejected after the same single handshake', async () => {
    const mock = mockedFetch({ genesis: 'wrong-genesis' });
    const read = await inspectSolanaRpc(RPC_URL, mock.fetcher);
    assert.deepEqual({ status: read.status, code: read.code }, { status: 'INVALID', code: 'WRONG_CLUSTER' });
    assert.equal(read.genesisRaw, JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'wrong-genesis' }));
    assert.equal(read.accountRaw, undefined);
    assert.equal(mock.calls.length, 1);
    assert.equal((JSON.parse(String(mock.calls[0]?.init?.body)) as { method: string }).method, 'getGenesisHash');
  });
});

test('structured RPC transport failures map to safe codes without inspecting arbitrary messages', async (t) => {
  const direct = (code: string) => Object.assign(new Error('opaque provider failure'), { code });
  const timeoutFailure = (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const coded = error as Error & { code?: string; cause?: { code?: string } };
    return error.name === 'TimeoutError' || [coded.code, coded.cause?.code].some(code => code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT');
  };
  const cases: Array<{ label: string; error: unknown; code: string }> = [
    { label: 'TimeoutError name', error: Object.assign(new Error('private endpoint and secret'), { name: 'TimeoutError' }), code: 'RPC_TIMEOUT' },
    { label: 'direct ETIMEDOUT', error: direct('ETIMEDOUT'), code: 'RPC_TIMEOUT' },
    { label: 'cause UND_ERR_CONNECT_TIMEOUT', error: new Error('wrapper failure', { cause: direct('UND_ERR_CONNECT_TIMEOUT') }), code: 'RPC_TIMEOUT' },
    { label: 'direct EACCES', error: direct('EACCES'), code: 'RPC_NETWORK_ACCESS_DENIED' },
    { label: 'cause EPERM', error: new Error('wrapper failure', { cause: direct('EPERM') }), code: 'RPC_NETWORK_ACCESS_DENIED' },
    { label: 'direct ENOTFOUND', error: direct('ENOTFOUND'), code: 'RPC_DNS_ERROR' },
    { label: 'cause EAI_AGAIN', error: new Error('wrapper failure', { cause: direct('EAI_AGAIN') }), code: 'RPC_DNS_ERROR' },
    {
      label: 'misleading message and unknown cause code',
      error: new Error('TimeoutError ETIMEDOUT EACCES ENOTFOUND https://private-rpc.example/?token=rpc-secret', { cause: direct('PRIVATE_PROVIDER_CODE') }),
      code: 'RPC_TRANSPORT',
    },
  ];
  for (const item of cases) {
    await t.test(item.label, async st => {
      if (timeoutFailure(item.error)) st.mock.timers.enable({ apis: ['setTimeout'] });
      let calls = 0;
      const fetcher: typeof fetch = async () => { calls += 1; throw item.error; };
      const pending = inspectSolanaRpc(RPC_URL, fetcher);
      if (timeoutFailure(item.error)) {
        await advanceTwoRetryDelays(st);
        st.mock.timers.tick(30_000);
        await flushMicrotasks();
      }
      const read = await pending;
      assert.deepEqual(read, { status: 'UNAVAILABLE', code: item.code });
      assert.equal(calls, timeoutFailure(item.error) ? 4 : 1,
        'read recovery permits one delayed attempt only for classified local timeouts');
      assert.equal(JSON.stringify(read).includes('rpc-secret'), false);
      assert.equal(JSON.stringify(read).includes('private-rpc.example'), false);
      assert.equal(JSON.stringify(read).includes('PRIVATE_PROVIDER_CODE'), false);
    });
  }
});

test('RPC inspector signals reach child requests and cancel their waits', async t => {
  await t.test('standalone RPC inspector forwards its final signal', async () => {
    const controller = new AbortController();
    const reason = new DOMException('inspection cancelled', 'AbortError');
    let calls = 0;
    let signalAborted = false;
    const pending = inspectSolanaRpc(RPC_URL, (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          signalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 1);
    controller.abort(reason);
    const read = await pending;
    assert.equal(read.status, 'UNAVAILABLE');
    assert.equal(calls, 1);
    assert.equal(signalAborted, true);
  });

  await t.test('mint inspector forwards its signal through the handshake and account read', async () => {
    const controller = new AbortController();
    const reason = new DOMException('inspection cancelled', 'AbortError');
    let calls = 0;
    let accountSignalAborted = false;
    const pending = inspectSolanaMint(MINT, RPC_URL, async (_input, init) => {
      calls++;
      if (calls === 1) return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          accountSignalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 2);
    controller.abort(reason);
    const read = await pending;
    assert.equal(read.status, 'UNAVAILABLE');
    assert.ok(read.genesisRaw, 'successful handshake evidence is retained');
    assert.equal(calls, 2);
    assert.equal(accountSignalAborted, true);
  });

  await t.test('details inspector forwards its signal to nested RPC requests', async () => {
    const controller = new AbortController();
    const reason = new DOMException('details cancelled', 'AbortError');
    const mint = {
      kind: 'MINT_LEGACY' as const,
      programId: LEGACY_TOKEN_PROGRAM,
      supplyAtomic: '1000000000000',
      decimals: 6,
      mintAuthority: null,
      freezeAuthority: null,
      slot: 321,
    };
    const rawMint = Buffer.alloc(82);
    rawMint[44] = 6;
    rawMint[45] = 1;
    let calls = 0;
    let populationSignalAborted = false;
    const pending = inspectSolanaDetails(mint, MINT, RPC_URL, async (_input, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getAccountInfo') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: 321 },
          value: { owner: LEGACY_TOKEN_PROGRAM, executable: false, data: [rawMint.toString('base64'), 'base64'] },
        } });
      }
      assert.equal(request.method, 'getProgramAccounts');
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          populationSignalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 2);
    controller.abort(reason);
    const read = await pending;
    assert.equal(populationSignalAborted, true);
    assert.equal(read.errors.holderPopulation, 'RPC_TRANSPORT');
    assert.equal(calls, 2, 'aborting the child read stops later detail requests');
  });

  await t.test('PumpSwap inspector forwards its final signal to its first RPC read', async () => {
    const controller = new AbortController();
    const reason = new DOMException('venue inspection cancelled', 'AbortError');
    let calls = 0;
    let signalAborted = false;
    const pending = inspectPumpSwap(token, profile, undefined, undefined, 321, RPC_URL, (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          signalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, () => AT, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 1);
    controller.abort(reason);
    const read = await pending;
    assert.equal(read.inspection.errors.binding, 'RPC_TRANSPORT');
    assert.equal(calls, 1);
    assert.equal(signalAborted, true);
  });
});

test('mint inspection reuses the pinned handshake and preserves successful raw responses', async (t) => {
  await t.test('success performs the genesis and finalized jsonParsed account calls', async () => {
    const mock = mockedFetch();
    const read = await inspectSolanaMint(MINT, RPC_URL, mock.fetcher);
    assert.equal(read.status, 'OBSERVED');
    assert.equal(read.genesisHash, SOLANA_MAINNET_GENESIS);
    assert.ok(read.genesisRaw);
    assert.ok(read.accountRaw);
    assert.equal(read.mint?.kind, 'MINT_LEGACY');
    assert.equal(mock.calls.length, 2);
    const genesis = JSON.parse(String(mock.calls[0]?.init?.body)) as { method: string; params: unknown[] };
    const account = JSON.parse(String(mock.calls[1]?.init?.body)) as { method: string; params: unknown[] };
    assert.equal(genesis.method, 'getGenesisHash');
    assert.deepEqual(genesis.params, []);
    assert.equal(account.method, 'getAccountInfo');
    assert.deepEqual(account.params, [MINT, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    assert.equal(read.genesisRaw, JSON.stringify({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS }));
    assert.equal(read.accountRaw, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: legacyAccount() } }));
    assert.equal(Object.hasOwn(read, 'retrievedAt'), false, 'legacy callers keep the original response shape');
  });

  await t.test('optional clock binds each successful raw response to its own retrieval time', async () => {
    const base = Date.parse('2026-10-06T12:00:00.000Z');
    let current = base;
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getGenesisHash') {
        current = base + 1_000;
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      }
      assert.equal(request.method, 'getAccountInfo');
      current = base + 302_000;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: legacyAccount() } });
    };
    const read = await inspectSolanaMint(MINT, RPC_URL, fetcher, undefined, () => new Date(current).toISOString());
    assert.equal(read.status, 'OBSERVED');
    assert.deepEqual(read.retrievedAt, {
      'rpc-genesis': new Date(base + 1_000).toISOString(),
      'rpc-account': new Date(base + 302_000).toISOString(),
    });
    assert.equal(Date.parse(read.retrievedAt!['rpc-account']!) - Date.parse(read.retrievedAt!['rpc-genesis']!), 301_000,
      'the account timestamp reflects its response, not the later run completion');
    assert.equal(calls, 2);
  });

  await t.test('final mint reads request the preflight context floor and reject an older response', async () => {
    let accountParams: unknown;
    const mock = mockedFetch();
    const floor = 321;
    const read = await inspectSolanaMint(MINT, RPC_URL, async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT) accountParams = request.params[1];
      return mock.fetcher(input, init);
    }, undefined, () => AT, floor);
    assert.equal(read.status, 'OBSERVED');
    assert.deepEqual(accountParams, { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: floor });

    const stale: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getGenesisHash') return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      assert.equal(request.method, 'getAccountInfo');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: floor - 1 }, value: legacyAccount() } });
    };
    const rejected = await inspectSolanaMint(MINT, RPC_URL, stale, undefined, undefined, floor);
    assert.deepEqual({ status: rejected.status, code: rejected.code }, { status: 'UNAVAILABLE', code: 'RPC_SHAPE' });
    assert.equal(rejected.accountRaw, undefined, 'a stale account body cannot become canonical mint evidence');
  });

  await t.test('failed account reads retain only the successful handshake timestamp', async () => {
    const current = '2026-10-06T12:00:00.000Z';
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getGenesisHash') return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      throw new Error('simulated account failure');
    };
    const read = await inspectSolanaMint(MINT, RPC_URL, fetcher, undefined, () => current);
    assert.equal(read.status, 'UNAVAILABLE');
    assert.deepEqual(read.retrievedAt, { 'rpc-genesis': current });
    assert.equal(read.accountRaw, undefined);
  });

  await t.test('an account-stage timeout keeps genesis evidence and does not create account evidence', async st => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = Object.assign(new Error('fetch failed for https://private-rpc.example/?token=rpc-secret'), { name: 'TimeoutError' });
    const mock = mockedFetch({ accountError: timeout });
    const pending = inspectSolanaMint(MINT, RPC_URL, mock.fetcher);
    await advanceTwoRetryDelays(st);
    st.mock.timers.tick(30_000);
    await flushMicrotasks();
    const read = await pending;
    assert.deepEqual({ status: read.status, code: read.code }, { status: 'UNAVAILABLE', code: 'RPC_TIMEOUT' });
    assert.ok(read.genesisRaw);
    assert.equal(read.genesisHash, SOLANA_MAINNET_GENESIS);
    assert.equal(read.accountRaw, undefined);
    assert.equal(read.mint, undefined);
    assert.equal(mock.calls.length, 5, 'the account lookup gets three fast attempts and one delayed fallback after the successful genesis check');
    assert.equal((JSON.parse(String(mock.calls[0]?.init?.body)) as { method: string }).method, 'getGenesisHash');
    assert.equal((JSON.parse(String(mock.calls[1]?.init?.body)) as { method: string }).method, 'getAccountInfo');
    assert.equal((JSON.parse(String(mock.calls[2]?.init?.body)) as { method: string }).method, 'getAccountInfo');
    assert.equal((JSON.parse(String(mock.calls[3]?.init?.body)) as { method: string }).method, 'getAccountInfo');
    assert.equal(JSON.stringify(read).includes('rpc-secret'), false);
    assert.equal(JSON.stringify(read).includes('private-rpc.example'), false);
  });
});

test('DexScreener retrieval timestamps require a successfully read raw body and remain optional for legacy callers', async t => {
  await t.test('records the body retrieval instant', async () => {
    const retrievedAt = '2026-10-06T12:00:00.000Z';
    const read = await fetchDexPairs('solana', MINT, async () => jsonResponse([pair(0)]), () => retrievedAt);
    assert.equal(read.status, 'OBSERVED');
    assert.equal(read.retrievedAt, retrievedAt);
    assert.equal(read.market?.pairs[0]?.priceUsd, '0.001');
  });

  await t.test('leaves unavailable and unclocked results without retrieval metadata', async () => {
    const unavailable = await fetchDexPairs('solana', MINT, async () => jsonResponse({ error: 'unavailable' }, 500), () => {
      throw new Error('clock must not run without a successful raw body');
    });
    assert.equal(unavailable.status, 'UNAVAILABLE');
    assert.equal(Object.hasOwn(unavailable, 'retrievedAt'), false);

    const legacy = await fetchDexPairs('solana', MINT, async () => jsonResponse([pair(0)]));
    assert.equal(legacy.status, 'OBSERVED');
    assert.equal(Object.hasOwn(legacy, 'retrievedAt'), false);
  });
});

test('DEX recovery is opt-in, keeps healthy direct reads unchanged, and selects only literal fixed-URL JSON', async () => {
  const healthy = mockedFetch({ dexValue: [pair(0)] });
  const direct = await fetchDexPairs('solana', MINT, healthy.fetcher, () => AT, { tinyfishKey: TINYFISH_KEY });
  assert.equal(direct.status, 'OBSERVED');
  assert.equal(direct.market?.pairs[0]?.pairAddress, 'PairAddress0');
  assert.equal(Object.hasOwn(direct, 'recovery'), false, 'a healthy direct read bypasses TinyFish entirely');
  assert.equal(healthy.calls.length, 1);
  assert.ok(healthy.calls[0]?.url.startsWith('https://api.dexscreener.com/token-pairs/v1/solana/'));

  const emptyWithoutRecovery = mockedFetch({ dexValue: [] });
  const legacy = await fetchDexPairs('solana', MINT, emptyWithoutRecovery.fetcher, () => AT);
  assert.equal(legacy.status, 'NO_RESULTS');
  assert.equal(Object.hasOwn(legacy, 'recovery'), false);
  assert.equal(emptyWithoutRecovery.calls.length, 1, 'omitting recovery preserves the old direct-only request shape');

  const selectedText = JSON.stringify([pair(0)]);
  const recoveredMock = mockedFetch({
    dexValue: [],
    fetchValue: (urls: string[]) => ({
      results: urls.map(url => ({ url, final_url: url, format: 'html', text: selectedText })),
      errors: [],
    }),
  });
  const times = [AT, '2026-09-29T12:00:02.000Z'];
  let clockReads = 0;
  const recovered = await fetchDexPairs('solana', MINT, recoveredMock.fetcher, () => times[clockReads++]!, { tinyfishKey: TINYFISH_KEY });
  const requestedUrl = `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;
  assert.equal(recovered.status, 'OBSERVED');
  assert.equal(recovered.raw, selectedText, 'the selected provider text is retained verbatim');
  assert.equal(recovered.retrievedAt, times[1]);
  assert.deepEqual(recovered.recovery, {
    method: 'tinyfish-live-dex-json-v1',
    requestedUrl,
    requestRaw: JSON.stringify({
      urls: [requestedUrl], format: 'html', ttl: 0, per_url_timeout_ms: 8000, include_etag_and_last_modified: true,
    }),
    responseRaw: JSON.stringify({
      results: [{ url: requestedUrl, final_url: requestedUrl, format: 'html', text: selectedText }], errors: [],
    }),
    primaryRaw: '[]',
    primaryState: 'NO_RESULTS',
    primaryRetrievedAt: times[0],
    retrievedAt: times[1],
    selected: true,
  });
  assert.equal(recoveredMock.calls.length, 2, 'empty direct data enters exactly one bounded fallback request');
  const fetchCall = recoveredMock.calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.ok(fetchCall);
  assert.equal(fetchCall.init?.method, 'POST');
  assert.equal((fetchCall.init?.headers as Record<string, string>)['X-API-Key'], TINYFISH_KEY);
  assert.deepEqual(JSON.parse(String(fetchCall.init?.body)), {
    urls: [requestedUrl], format: 'html', ttl: 0, per_url_timeout_ms: 8000, include_etag_and_last_modified: true,
  });
  assert.equal(JSON.stringify(recovered).includes(TINYFISH_KEY), false, 'the key is transport-only');
});

test('DEX recovery rejects malformed, redirected, incomplete, oversized, or wrong-token Fetch responses without repair', async () => {
  const requestedUrl = `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;
  const result = (overrides: Record<string, unknown> = {}) => ({
    url: requestedUrl, final_url: requestedUrl, format: 'html', text: JSON.stringify([pair(0)]), ...overrides,
  });
  const cases: Array<{ name: string; body?: string; status?: number; transportError?: Error; code: string; state: string }> = [
    { name: 'malformed Fetch envelope JSON', body: '{', code: 'DEX_FETCH_JSON', state: 'INVALID' },
    { name: 'HTTP-200 Fetch errors', body: JSON.stringify({ results: [], errors: [{ url: requestedUrl, error: 'timeout' }] }), code: 'DEX_FETCH_SHAPE', state: 'INVALID' },
    { name: 'changed requested URL', body: JSON.stringify({ results: [result({ url: `${requestedUrl}?other=1` })], errors: [] }), code: 'DEX_FETCH_URL', state: 'INVALID' },
    { name: 'redirected final URL', body: JSON.stringify({ results: [result({ final_url: 'https://other.example/redirect' })], errors: [] }), code: 'DEX_FETCH_URL', state: 'INVALID' },
    { name: 'non-HTML Fetch format', body: JSON.stringify({ results: [result({ format: 'markdown' })], errors: [] }), code: 'DEX_FETCH_SHAPE', state: 'INVALID' },
    { name: 'Markdown instead of literal JSON text', body: JSON.stringify({ results: [result({ text: `# Pairs\n${JSON.stringify([pair(0)])}` })], errors: [] }), code: 'DEX_FETCH_JSON', state: 'INVALID' },
    { name: 'valid JSON for a different mint', body: JSON.stringify({ results: [result({ text: JSON.stringify([pair(0, { baseToken: { address: 'WrongMint' }, quoteToken: { address: 'OtherMint' } })]) })], errors: [] }), code: 'DEX_FETCH_WRONG_TOKEN', state: 'INVALID' },
    { name: 'oversized raw envelope', body: JSON.stringify({ results: [result({ text: 'x'.repeat(400_001) })], errors: [] }), code: 'DEX_FETCH_RESPONSE_LIMIT', state: 'INVALID' },
    { name: 'provider HTTP failure', status: 503, body: JSON.stringify({ error: 'unavailable' }), code: 'DEX_FETCH_HTTP_503', state: 'UNAVAILABLE' },
    { name: 'provider transport failure', transportError: new TypeError('synthetic network failure'), code: 'DEX_FETCH_TRANSPORT', state: 'UNAVAILABLE' },
  ];

  for (const scenario of cases) {
    let fallbackCalls = 0;
    const fetcher: typeof fetch = async input => {
      const url = String(input);
      if (url === requestedUrl) return jsonResponse([]);
      if (url === 'https://api.fetch.tinyfish.ai/') {
        fallbackCalls++;
        if (scenario.transportError) throw scenario.transportError;
        return new Response(scenario.body, { status: scenario.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`UNEXPECTED_MOCK_REQUEST_${url}`);
    };
    const read = await fetchDexPairs('solana', MINT, fetcher, () => AT, { tinyfishKey: TINYFISH_KEY });
    assert.equal(read.status, scenario.state, scenario.name);
    assert.equal(read.code, scenario.code, scenario.name);
    assert.equal(read.recovery?.selected, false, scenario.name);
    assert.equal(read.recovery?.primaryRaw, '[]', scenario.name);
    assert.equal(read.recovery?.primaryState, 'NO_RESULTS', scenario.name);
    assert.equal(fallbackCalls, 1, `${scenario.name}: recovery is attempted only once`);
    assert.equal(JSON.stringify(read).includes(TINYFISH_KEY), false, `${scenario.name}: key is absent from the receipt`);
  }
});

function liveOptions(fetcher: typeof fetch, overrides: Partial<Parameters<typeof collectLiveSolana>[1]> = {}) {
  return { profile, semanticEnabled: false, fetcher, now: () => AT, ...overrides };
}

test('semantic expiry still performs fresh final RPC and DEX reads in the actual collector', async () => {
  const mock = mockedFetch();
  let nowMs = 0;
  let workDeadline: AbortController | undefined;
  let expired = false;
  const afterExpiry: Array<{ url: string; method?: string; params?: unknown[] }> = [];
  const runtime: LiveRuntime = {
    nowMs: () => nowMs,
    timeout: milliseconds => {
      const controller = new AbortController();
      if (milliseconds === 480_000) workDeadline = controller;
      return controller.signal;
    },
    wait: async () => {},
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    let request: { method?: string; params?: unknown[] } | undefined;
    if (url.startsWith('https://rpc.example/')) request = JSON.parse(String(init?.body)) as typeof request;
    if (expired && (url.startsWith('https://rpc.example/') || url.startsWith('https://api.dexscreener.com/'))) {
      afterExpiry.push({ url, method: request?.method, params: request?.params });
    }
    const response = await mock.fetcher(input, init);
    if (!expired && url.startsWith('https://api.search.tinyfish.ai/')) {
      assert.ok(workDeadline, 'the semantic work signal exists before attention starts its first provider request');
      nowMs = 480_000;
      expired = true;
      workDeadline.abort();
    }
    return response;
  };
  const now = () => new Date(Date.parse(AT) + nowMs).toISOString();
  const bundle = await collectLiveSolana(token, liveOptions(fetcher, {
    semanticEnabled: true, tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), rpcUrl: RPC_URL, runtime, now,
  }));

  assert.equal(expired, true);
  const run = JSON.parse(bundle.rawArtifacts['live-run-scope']!) as {
    elapsedMs: number; semanticLimitMs: number; stages: Array<{ phase: string; status: string; origin?: string; ops: number; endMs: number | null }>;
  };
  const attention = run.stages.find(stage => stage.phase === 'ATTENTION')!;
  const finalize = run.stages.find(stage => stage.phase === 'FINALIZE')!;
  assert.equal(run.semanticLimitMs, 600_000);
  assert.equal(run.elapsedMs, 480_000);
  assert.deepEqual([attention.status, attention.origin, attention.endMs], ['CANCELLED', 'PHASE_DEADLINE', 480_000]);
  assert.equal(finalize.status, 'COMPLETED');
  assert.ok(finalize.ops > 0, 'the final stage receives live transport operations after semantic cancellation');

  assert.ok(afterExpiry.some(call => call.url.startsWith('https://rpc.example/') && call.method === 'getGenesisHash'));
  const finalMint = afterExpiry.find(call => call.url.startsWith('https://rpc.example/') && call.method === 'getAccountInfo' && call.params?.[0] === MINT);
  assert.ok(finalMint, 'the final canonical mint is actually read after semantic expiry');
  assert.deepEqual(finalMint.params?.[1], { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: 321 });
  assert.ok(afterExpiry.some(call => call.url.startsWith('https://api.dexscreener.com/')), 'the final DEX request is actually sent after semantic expiry');
  assert.ok(bundle.evidence.some(record => record.id === 'rpc-account' && record.sourceId === 'solana-rpc'));
  assert.ok(bundle.evidence.some(record => record.id === 'dex-pairs-primary' && record.sourceId === 'dexscreener'),
    'the final direct DEX response remains evidence even when the optional recovery is not selected');
  assert.ok(bundle.evidence.some(record => record.id === 'dex-discovery-primary'), 'early discovery remains separately labeled');
  const discoveryPrimary = bundle.evidence.find(record => record.id === 'dex-discovery-primary')!;
  const finalDex = bundle.evidence.find(record => record.id === 'dex-pairs-primary')!;
  assert.ok(discoveryPrimary, 'early DEX discovery is retained');
  assert.ok(Date.parse(finalDex.retrievedAt) > Date.parse(discoveryPrimary.retrievedAt), 'final market state is retrieved after early discovery');
});

test('semantic research keeps the partial 120-second final stage active through venue collection', async () => {
  const mock = mockedFetch();
  const timeouts: number[] = [];
  const runtime: LiveRuntime = {
    nowMs: () => 0,
    timeout: milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; },
    wait: async () => {},
  };
  const research = { schemaVersion: 1 as const, token, records: [], reviews: [] };
  const bundle = await collectLiveSolana(token, liveOptions(mock.fetcher, {
    semanticEnabled: true, tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), rpcUrl: RPC_URL, research, runtime,
  }));
  assert.ok(timeouts.every(milliseconds => milliseconds === 120_000), 'research uses the existing partial-run ceiling');
  assert.ok(bundle.evidence.some(record => record.id === 'curated-research'));
  assert.ok(!bundle.rawArtifacts['live-run-scope'], 'legacy/partial research does not claim the fresh full-run phase receipt');
  assert.ok(!bundle.rawArtifacts['social-attention-seed'], 'curated research does not start the live social branch');
  const rpcMethods = mock.calls.filter(call => call.url.startsWith('https://rpc.example/'))
    .map(call => (JSON.parse(String(call.init?.body)) as { method: string }).method);
  assert.ok(rpcMethods.some(method => method === 'getAccountInfo'), 'canonical mint acquisition remains live');
  const lastSearchIndex = mock.calls.reduce((last, call, index) => call.url.startsWith('https://api.search.tinyfish.ai/') ? index : last, -1);
  assert.ok(mock.calls.slice(lastSearchIndex + 1).some(call => call.url.startsWith('https://rpc.example/')),
    'venue RPC work still reaches the provider after attention uses the shared final-stage fetcher');
});

test('Service accepts safe RPC diagnostics and keeps a partial holder error as the cause', async () => {
  const mock = mockedFetch();
  const rawMint = Buffer.alloc(82);
  rawMint.writeBigUInt64LE(1_000_000_000_000n, 36);
  rawMint[44] = 6;
  rawMint[45] = 1;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT
        && (request.params[1] as { encoding?: string } | undefined)?.encoding === 'base64') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: 321 }, value: rpcAccount(LEGACY_TOKEN_PROGRAM, rawMint),
        } });
      }
      if (request.method === 'getProgramAccounts') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'provider population failure' } });
      }
    }
    return mock.fetcher(input, init);
  };
  const bundle = await collectLiveSolana(token, liveOptions(fetcher));
  const diagnostic = bundle.evidence.find(record => record.id === 'rpc-detail-errors');
  assert.ok(diagnostic, 'partial detail failures have a retained local diagnostic record');
  assert.equal(diagnostic.sourceId, 'solana-rpc-diagnostics');
  assert.equal(diagnostic.accessMode, 'LOCAL_DERIVED');
  const diagnostics = JSON.parse(bundle.rawArtifacts['rpc-detail-errors']!) as { errors: Record<string, string> };
  assert.equal(diagnostics.errors.holderPopulation, 'RPC_REMOTE_-32005', 'safe diagnostics preserve the provider’s actual full-population error code');
  for (const id of ['O17', 'O18', 'O19', 'O20']) {
    assert.equal(bundle.details?.baseline.find(row => row.id === id)?.causes[0]?.code, 'RPC_REMOTE_-32005',
      `${id} keeps the original failed population request despite the top-account fallback`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'holder-diagnostic-service-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  try {
    const saved = service.analyzeLive(bundle);
    assert.ok(saved.evidence.some(record => record.id === 'rpc-detail-errors' && record.sourceId === 'solana-rpc-diagnostics'));
    assert.equal(saved.details?.baseline.find(row => row.id === 'O19')?.causes[0]?.code, 'RPC_REMOTE_-32005');
    assert.deepEqual(service.replay(saved.id), saved, 'diagnostic evidence and the real cause survive persistence and replay');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('holder context recovery retains each failed RPC body and time across supply reconciliation', async () => {
  const mint = { kind: 'MINT_LEGACY' as const, programId: LEGACY_TOKEN_PROGRAM, supplyAtomic: '100', decimals: 6,
    mintAuthority: null, freezeAuthority: null, slot: 321 };
  const makeMint = (supply: bigint) => {
    const data = Buffer.alloc(82);
    data.writeBigUInt64LE(supply, 36);
    data[44] = 6;
    data[45] = 1;
    return data;
  };
  const holderAccount = (amount: bigint) => {
    const data = Buffer.alloc(165);
    new PublicKey(MINT).toBuffer().copy(data);
    Buffer.alloc(32, 9).copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return data;
  };
  const lagRaw = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'minimum context slot not reached' } });
  let mintReads = 0;
  let populationReads = 0;
  let clockTick = 0;
  const populationBodies: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
    if (request.method === 'getAccountInfo' && request.params?.[0] === MINT) {
      mintReads++;
      const slot = mintReads === 1 ? 321 : 323;
      const supply = mintReads === 1 ? 100n : 90n;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
        context: { slot }, value: rpcAccount(LEGACY_TOKEN_PROGRAM, makeMint(supply)),
      } });
    }
    if (request.method === 'getProgramAccounts') {
      populationReads++;
      populationBodies.push(String(init?.body));
      if (populationReads === 1 || populationReads === 3) return new Response(lagRaw, { status: 200 });
      const slot = populationReads === 2 ? 322 : 324;
      const amount = populationReads === 2 ? 90n : 90n;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
        context: { slot }, value: [{ pubkey: PROGRAM_DATA, account: rpcAccount(LEGACY_TOKEN_PROGRAM, holderAccount(amount)) }],
      } });
    }
    if (request.method === 'getAccountInfo') {
      const header = Buffer.alloc(36);
      header.writeUInt32LE(2, 0);
      new PublicKey(PROGRAM_DATA).toBuffer().copy(header, 4);
      if (request.params?.[0] === PROGRAM_DATA) {
        const data = Buffer.alloc(45);
        data.writeUInt32LE(3, 0);
        data.writeBigUInt64LE(300n, 4);
        data[12] = 1;
        Buffer.alloc(32, 11).copy(data, 13);
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: 324 }, value: rpcAccount(UPGRADEABLE_LOADER, data),
        } });
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
        context: { slot: 324 }, value: { ...rpcAccount(UPGRADEABLE_LOADER, header), executable: true },
      } });
    }
    throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
  };
  const pending = inspectSolanaDetails(mint, MINT, RPC_URL, fetcher, undefined, () =>
    new Date(Date.parse(AT) + clockTick++ * 1000).toISOString());

  await flushMicrotasks();
  assert.equal(populationReads, 1);
  await waitForCondition(() => populationReads === 2);
  assert.equal(populationReads, 2, 'the first context error retries the same population request');
  await waitForCondition(() => mintReads === 2 && populationReads === 3);
  assert.equal(mintReads, 2, 'a mismatched but valid population still enters the separate bounded supply reconciliation');
  assert.equal(populationReads, 3);
  await waitForCondition(() => populationReads === 4);
  const details = await pending;

  assert.equal(populationReads, 4);
  assert.deepEqual(populationBodies.slice(0, 2).map(body => JSON.parse(body)),
    Array.from({ length: 2 }, () => JSON.parse(populationBodies[0]!)),
    'the context retry preserves the original finalized floor and every serialized getProgramAccounts parameter');
  assert.deepEqual(populationBodies.slice(2).map(body => JSON.parse(body)),
    Array.from({ length: 2 }, () => JSON.parse(populationBodies[2]!)),
    'the reconciliation context retry preserves its own finalized floor and filters');
  assert.equal((JSON.parse(populationBodies[0]!) as { params: Array<unknown> })['params'][1]
    && ((JSON.parse(populationBodies[0]!) as { params: Array<unknown> }).params[1] as { minContextSlot: number }).minContextSlot, 321);
  assert.equal(((JSON.parse(populationBodies[2]!) as { params: Array<unknown> }).params[1] as { minContextSlot: number }).minContextSlot, 323,
    'the supply reconciliation never lowers the minimum finalized slot');
  assert.equal(details.rawArtifacts['rpc-holder-context-attempt-1'], lagRaw);
  assert.equal(details.rawArtifacts['rpc-holder-context-attempt-2'], lagRaw,
    'callback artifact numbering continues across the separate reconciliation population request');
  assert.ok(details.retrievedAt?.['rpc-holder-context-attempt-1']);
  assert.ok(details.retrievedAt?.['rpc-holder-context-attempt-2']);
  assert.ok(Date.parse(details.retrievedAt!['rpc-holder-context-attempt-1']!)
    < Date.parse(details.retrievedAt!['rpc-holder-context-attempt-2']!));
  assert.equal(details.rawArtifacts['rpc-holder-population-reconciliation-attempt-1']?.includes('"slot"'), true);
  assert.equal((JSON.parse(details.rawArtifacts['rpc-holder-population']!) as { result: { context: { slot: number } } }).result.context.slot, 324,
    'the canonical holder artifact is the successful reconciled body, not a failed context response');
  assert.ok(Date.parse(details.retrievedAt!['rpc-holder-population']!)
    > Date.parse(details.retrievedAt!['rpc-holder-context-attempt-2']!),
  'the canonical reconciled success is timestamped after both failed context responses');
  assert.equal(details.holders?.complete, true);
  assert.equal(details.holders?.slot, 324);
  assert.equal(details.holders?.supplyAtomic, '90');
  assert.equal(details.errors.holderPopulation, undefined);
});

test('Service gives only the validated LIVE holder-population artifact its separate bounded allowance', async () => {
  const mock = mockedFetch();
  const rawMint = Buffer.alloc(82);
  rawMint.writeBigUInt64LE(100n, 36);
  rawMint[44] = 6;
  rawMint[45] = 1;
  const holderAccount = Buffer.alloc(165);
  new PublicKey(MINT).toBuffer().copy(holderAccount);
  Buffer.alloc(32, 9).copy(holderAccount, 32);
  holderAccount.writeBigUInt64LE(100n, 64);
  holderAccount[108] = 1;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT
        && (request.params[1] as { encoding?: string } | undefined)?.encoding === 'base64') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: 321 }, value: rpcAccount(LEGACY_TOKEN_PROGRAM, rawMint),
        } });
      }
      if (request.method === 'getProgramAccounts') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: [{
          pubkey: PROGRAM_DATA, account: rpcAccount(LEGACY_TOKEN_PROGRAM, holderAccount),
        }] } });
      }
    }
    return mock.fetcher(input, init);
  };
  const bundle = await collectLiveSolana(token, liveOptions(fetcher));
  const population = bundle.evidence.find(record => record.id === 'rpc-holder-population');
  const populationRaw = bundle.rawArtifacts['rpc-holder-population'];
  assert.ok(population && populationRaw, 'the fixture retains a successful exact-supply full holder population');
  assert.equal(population.sourceId, 'solana-rpc');
  assert.equal(population.sourceType, 'JSON_RPC');
  assert.equal(population.accessMode, 'PUBLIC_API');

  const directory = mkdtempSync(join(tmpdir(), 'holder-population-cap-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  const setArtifact = (id: string, raw: string) => {
    const evidence = bundle.evidence.find(record => record.id === id);
    assert.ok(evidence, `${id} has a matching provenance record`);
    bundle.rawArtifacts[id] = raw;
    evidence.contentHash = sha256(raw);
  };
  try {
    setArtifact('rpc-holder-population', populationRaw.trimEnd().padEnd(24_000_001, ' '));
    assert.doesNotThrow(() => service.analyzeLive(bundle),
      'a correctly hashed holder response above the ordinary aggregate cap fits the exact holder allowance');

    setArtifact('rpc-holder-population', populationRaw.trimEnd().padEnd(64_000_001, ' '));
    assert.throws(() => service.analyzeLive(bundle), /ARTIFACT_HASH_OR_SIZE/,
      'the holder allowance still has a hard 64 MB ceiling even when the supplied digest matches');

    setArtifact('rpc-holder-population', populationRaw);
    const mintRaw = bundle.rawArtifacts['rpc-mint-raw'];
    assert.ok(mintRaw, 'the paired raw mint artifact is retained');
    setArtifact('rpc-mint-raw', mintRaw.trimEnd().padEnd(24_000_001, ' '));
    assert.throws(() => service.analyzeLive(bundle), /ARTIFACT_HASH_OR_SIZE/,
      'an equally large non-holder artifact remains subject to the ordinary LIVE aggregate cap');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Service reconstructs a finalized holder-population retry and rejects rehashed trigger, floor, and bound mutations', async () => {
  const mock = mockedFetch();
  const makeMint = (supply: bigint) => {
    const bytes = Buffer.alloc(82);
    bytes.writeBigUInt64LE(supply, 36);
    bytes[44] = 6;
    bytes[45] = 1;
    return bytes;
  };
  const holderAccount = (amount: bigint) => {
    const bytes = Buffer.alloc(165);
    new PublicKey(MINT).toBuffer().copy(bytes, 0);
    Buffer.alloc(32, 9).copy(bytes, 32);
    bytes.writeBigUInt64LE(amount, 64);
    bytes[108] = 1;
    return bytes;
  };
  let mintReads = 0;
  let populationReads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT
        && (request.params[1] as { encoding?: string } | undefined)?.encoding === 'base64') {
        mintReads++;
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: mintReads === 1 ? 322 : 324 }, value: rpcAccount(LEGACY_TOKEN_PROGRAM, makeMint(mintReads === 1 ? 100n : 90n)),
        } });
      }
      if (request.method === 'getProgramAccounts') {
        populationReads++;
        const amount = populationReads === 1 ? 90n : 90n;
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: populationReads === 1 ? 323 : 325 },
          value: [{ pubkey: PROGRAM_DATA, account: rpcAccount(LEGACY_TOKEN_PROGRAM, holderAccount(amount)) }],
        } });
      }
    }
    return mock.fetcher(input, init);
  };
  const bundle = await collectLiveSolana(token, liveOptions(fetcher));
  assert.equal(mintReads, 2, 'the mismatch produces exactly one finalized raw-mint refresh');
  assert.equal(populationReads, 2, 'the refreshed mint is followed by exactly one fresh population scan');
  assert.ok(bundle.rawArtifacts['rpc-mint-raw-reconciliation-attempt-1']);
  assert.ok(bundle.rawArtifacts['rpc-holder-population-reconciliation-attempt-1']);
  assert.ok(bundle.rawArtifacts['rpc-mint-reconciliation-response']);
  assert.equal(bundle.rawArtifacts['rpc-mint-raw'], bundle.rawArtifacts['rpc-mint-reconciliation-response']);
  for (const id of ['O17', 'O18', 'O19', 'O20']) {
    assert.equal(bundle.details?.baseline.find(row => row.id === id)?.quality, 'KNOWN', `${id} is derived from the reconciled complete population`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'holder-reconciliation-service-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  const rehash = (candidate: typeof bundle, id: string, raw: string) => {
    candidate.rawArtifacts[id] = raw;
    const evidence = candidate.evidence.find(record => record.id === id);
    assert.ok(evidence, `${id} has a provenance record`);
    evidence.contentHash = sha256(raw);
  };
  try {
    const saved = service.analyzeLive(bundle);
    assert.deepEqual(service.replay(saved.id), saved, 'the verified reconciliation survives persistence and deterministic replay');

    const badTrigger = structuredClone(bundle);
    const initialPopulation = JSON.parse(badTrigger.rawArtifacts['rpc-holder-population-reconciliation-attempt-1']!) as {
      result: { value: Array<{ account: { data: [string, string] } }> };
    };
    const initialBytes = Buffer.from(initialPopulation.result.value[0]!.account.data[0], 'base64');
    initialBytes.writeBigUInt64LE(100n, 64);
    initialPopulation.result.value[0]!.account.data[0] = initialBytes.toString('base64');
    const initialPopulationRaw = JSON.stringify(initialPopulation);
    rehash(badTrigger, 'rpc-holder-population-reconciliation-attempt-1', initialPopulationRaw);
    assert.throws(() => service.analyzeLive(badTrigger), /HOLDER_RECONCILIATION_PROOF_INVALID/,
      'a rehashed original sample that no longer mismatches cannot authorize a retry');

    const badFloor = structuredClone(bundle);
    const currentMint = JSON.parse(badFloor.rawArtifacts['rpc-mint-raw']!) as { result: { context: { slot: number } } };
    currentMint.result.context.slot = 322;
    rehash(badFloor, 'rpc-mint-raw', JSON.stringify(currentMint));
    assert.throws(() => service.analyzeLive(badFloor), /HOLDER_RECONCILIATION_PROOF_INVALID/,
      'a rehashed refreshed mint below the first population slot fails monotonic-floor validation');

    const badBounds = structuredClone(bundle);
    const concentration = badBounds.details?.baseline.find(row => row.id === 'O19');
    assert.ok(concentration);
    concentration.data = { ...(concentration.data as Record<string, unknown>), sampledAtomic: '89' };
    assert.throws(() => service.analyzeLive(badBounds), /HOLDER_RECONCILIATION_PROOF_INVALID/,
      'a modified baseline cannot be admitted when it disagrees with the exact reconciled holder decode');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy mint facts stay bounded while direct shared-token-program state proves mutability', async () => {
  const dexPairs = [
    pair(0, { liquidity: { usd: '100000' } }),
    pair(1, { liquidity: { usd: '50000' } }),
    ...Array.from({ length: 22 }, (_, index) => pair(index + 2)),
    pair(0, { liquidity: { usd: '999999999' } }),
    pair(30, { chainId: 'ethereum' }),
    pair(31, { baseToken: { address: 'UnrelatedMint' }, quoteToken: { address: 'OtherQuote' } }),
  ];
  const mock = mockedFetch({ dexValue: dexPairs });
  const result = await collectLiveSolana(token, liveOptions(mock.fetcher));

  assert.equal(result.collection.rpc.state, 'OBSERVED');
  for (const id of ['O01', 'O03', 'O04', 'O06']) {
    const row = result.features.find(feature => feature.id === id);
    assert.equal(row?.quality, 'KNOWN', `${id} is backed by the observed legacy mint account`);
    assert.equal(row?.value, true);
  }
  const program = result.features.find(row => row.id === 'O05');
  assert.equal(program?.quality, 'KNOWN');
  assert.equal(program?.value, false, 'the direct Program and ProgramData accounts resolve a live upgrade authority');
  assert.ok(program?.evidenceIds.includes('rpc-program-data'), 'the token-program conclusion is independently sourced from binary loader state');
  for (const id of ['O08', 'O09', 'O10', 'O17', 'O20', 'C02', 'A01', 'A02', 'A05', 'S01', 'C05']) {
    const row = result.features.find(feature => feature.id === id);
    assert.ok(!row || row.quality !== 'KNOWN' || row.value !== true, `${id} needs its own evidence before becoming favorable`);
  }

  assert.equal(result.market?.reportedPairCount, dexPairs.length);
  assert.equal(result.market?.retainedPairCount, 20);
  assert.equal(result.market?.truncated, true);
  assert.equal(result.market?.pairs.length, 20);
  const quotePair = result.market?.pairs.find(row => row.mintSide === 'quote');
  assert.equal(quotePair?.priceUsd, null);
  assert.equal(result.collection.dex.state, 'TRUNCATED');
  assert.equal(result.observations.some(row => row.field === 'tokenCreatedAt'), false);
  assert.ok(result.observations.some(row => row.field.endsWith('.poolCreatedAt')));
});

test('wrong genesis, missing accounts, Token-2022, and RPC errors remain distinct', async (t) => {
  await t.test('wrong genesis is invalid and does not yield mint features', async () => {
    const mock = mockedFetch({ genesis: 'wrong-genesis' });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.deepEqual(result.collection.rpc, { state: 'INVALID', code: 'WRONG_CLUSTER' });
    const directFacts = result.features.filter(row => ['O01', 'O02', 'O03', 'O04', 'O05', 'O06', 'O07'].includes(row.id));
    assert.ok(directFacts.every(row => row.quality !== 'KNOWN'), 'a rejected cluster must not yield favorable mint facts');
    assert.equal(result.rawArtifacts['rpc-account'], undefined);
    assert.equal(result.collection.dex.state, 'NO_RESULTS');
  });

  await t.test('a finalized null account produces only a sourced non-mint result', async () => {
    const mock = mockedFetch({ accountValue: null });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.equal(result.features.find(row => row.id === 'O01')?.quality, 'KNOWN');
    assert.equal(result.features.find(row => row.id === 'O01')?.value, false);
    const otherDirectFacts = result.features.filter(row => row.id !== 'O01' && ['O02', 'O03', 'O04', 'O05', 'O06', 'O07'].includes(row.id));
    assert.ok(otherDirectFacts.every(row => row.quality !== 'KNOWN' || row.value !== true), 'a non-mint account cannot establish mint controls');
    assert.ok(result.observations.some(row => row.field === 'mintAccountKind' && row.value === 'ACCOUNT_MISSING'));
  });

  await t.test('Token-2022 is partial and does not inherit legacy authority checks', async () => {
    const account = {
      owner: TOKEN_2022_PROGRAM,
      data: {
        program: 'spl-token-2022',
        parsed: { type: 'mint', info: { supply: '10', decimals: 2, mintAuthority: 'Authority111', freezeAuthority: 'Authority222' } },
      },
    };
    const mock = mockedFetch({ accountValue: account });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.equal(result.features.find(row => row.id === 'O01')?.quality, 'KNOWN');
    assert.equal(result.features.find(row => row.id === 'O01')?.value, true);
    const legacyControlFacts = result.features.filter(row => ['O03', 'O04', 'O05', 'O06'].includes(row.id));
    assert.ok(legacyControlFacts.every(row => row.quality !== 'KNOWN' || row.value !== true), 'a parsed Token-2022 response cannot inherit legacy control facts');
    assert.ok(result.observations.some(row => row.field === 'mintProgramId' && row.value === TOKEN_2022_PROGRAM));
  });

  await t.test('parsed program mismatch is invalid rather than treated as a mint', async () => {
    const mock = mockedFetch({ accountValue: legacyAccount({ data: { program: 'spl-token-2022', parsed: { type: 'mint', info: { supply: '10', decimals: 2, mintAuthority: null, freezeAuthority: null } } } }) });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.equal(result.collection.rpc.state, 'INVALID');
    assert.equal(result.features.some(row => row.id === 'O01'), false);
  });

  await t.test('RPC 429 leaves DEX collection intact and exposes a bounded code', async st => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    const mock = mockedFetch({ rpcStatus: 429, dexValue: [pair(1)] });
    const pending = collectLiveSolana(token, liveOptions(mock.fetcher));
    await advanceTwoRetryDelays(st);
    const result = await pending;
    assert.deepEqual(result.collection.rpc, { state: 'UNAVAILABLE', code: 'RPC_HTTP_429' });
    assert.equal(result.collection.dex.state, 'OBSERVED');
    assert.equal(result.features.some(row => row.id === 'O01'), false);
    assert.equal(JSON.stringify(result).includes(RPC_URL), false);
  });
});

test('DEX parser binds exact mint sides, removes duplicates and unrelated pairs, and caps output', () => {
  const input = [pair(0), pair(1), pair(0), pair(2, { chainId: 'ethereum' }), pair(3, {
    baseToken: { address: 'UnrelatedMint' }, quoteToken: { address: 'OtherQuote' },
  })];
  const summary = parseDexPairs(input, 'solana', MINT);
  assert.equal(summary.reportedPairCount, 5);
  assert.equal(summary.retainedPairCount, 2);
  assert.equal(summary.truncated, false);
  assert.deepEqual(summary.pairs.map(row => row.pairAddress).sort(), ['PairAddress0', 'PairAddress1']);
  assert.equal(summary.pairs.find(row => row.mintSide === 'base')?.priceUsd, '0.001');
  assert.equal(summary.pairs.find(row => row.mintSide === 'quote')?.priceUsd, null);
});

test('TinyFish includes only exact-mint public pages and drops unsafe redirect targets', async () => {
  const unsafe = 'https://127.0.0.1/private';
  assert.equal(publicHttpsUrl('http://127.0.0.1/private'), null);
  assert.equal(publicHttpsUrl(unsafe), null);
  assert.equal(publicHttpsUrl('https://public.example/page#section'), null);
  assert.equal(publicHttpsUrl('https://public.example/page'), 'https://public.example/page');

  const text = `Mint ${MINT}: the project describes itself as a community token.`;
  const mock = mockedFetch({
    searchValue: { results: [
      { url: 'https://public.example/evidence', title: 'Public mention', snippet: 'Exact token page' },
      { url: 'https://public.example/unrelated', title: 'Unrelated', snippet: 'No mint here' },
      { url: 'http://127.0.0.1/private', title: 'Private', snippet: 'Never fetch' },
    ] },
    fetchValue: { results: [
      { url: 'https://public.example/evidence', final_url: 'https://public.example/evidence', text, published_date: '2026-09-01' },
      { url: 'https://public.example/unrelated', final_url: 'https://public.example/unrelated', text: 'A page with no mint address.' },
      { url: 'https://public.example/evidence', final_url: unsafe, text },
    ], errors: [] },
  });
  const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
  assert.equal(result.status, 'OBSERVED');
  assert.deepEqual(result.pages.map(page => page.finalUrl), ['https://public.example/evidence']);
  const fetchCall = mock.calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.ok(fetchCall);
  assert.equal((fetchCall.init?.headers as Record<string, string>)['X-API-Key'], TINYFISH_KEY);
  const requested = JSON.parse(String(fetchCall.init?.body)) as { urls: string[]; ttl: number; format: string };
  assert.equal(requested.urls.includes('http://127.0.0.1/private'), false);
  assert.equal(requested.ttl, 0);
  assert.equal(requested.format, 'markdown');
});

test('TinyFish query handling preserves resource keys for attention and keeps legacy fetches queryless', async () => {
  const functional = 'https://public.example/rootdata/resource?k=MTUxNzY%3D';
  const tracked = `${functional}&utm_source=search&fbclid=click-id&gclid=click-id&msclkid=click-id`;
  assert.equal(publicHttpsUrl(functional, true), functional);
  assert.equal(publicHttpsUrl(tracked, true), functional, 'known tracking parameters are removed while the resource key survives');
  assert.equal(publicHttpsUrl(functional), 'https://public.example/rootdata/resource', 'the legacy default continues to remove the query');
  assert.equal(publicHttpsUrl(`${functional}&api_key=private`, true), null);
  assert.equal(publicHttpsUrl(`${functional}&access_token=private`, true), null);

  const text = `Mint ${MINT}: the page identifies its exact contract.`;
  const mock = mockedFetch({
    searchValue: { results: [{ url: functional }] },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({ url, final_url: url, text })), errors: [] }),
  });
  const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
  const fetchCall = mock.calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/')!;
  const fetchRequest = JSON.parse(String(fetchCall.init?.body)) as { urls: string[] };

  assert.deepEqual(fetchRequest.urls, ['https://public.example/rootdata/resource']);
  assert.equal(result.status, 'OBSERVED');
  assert.equal(result.pages[0]?.url, 'https://public.example/rootdata/resource');
});

test('TinyFish HTTP-200 Fetch errors distinguish incomplete coverage from an empty corpus', async (t) => {
  const searchValue = { results: [{ url: 'https://public.example/evidence' }] };
  const timeoutBody = { results: [], errors: [{ url: 'https://public.example/evidence', error: 'timeout' }] };

  await t.test('all requested pages failing is unavailable and keeps the raw Fetch body', async () => {
    const mock = mockedFetch({ searchValue, fetchValue: timeoutBody });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.code, 'WEB_FETCH_TIMEOUT');
    assert.deepEqual(result.pages, []);
    assert.equal(result.fetchRaw, JSON.stringify(timeoutBody));
  });

  await t.test('a successful empty Fetch response remains no results', async () => {
    const mock = mockedFetch({ searchValue, fetchValue: { results: [], errors: [] } });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'NO_RESULTS');
    assert.equal(result.code, undefined);
    assert.deepEqual(result.pages, []);
    assert.equal(result.fetchRaw, JSON.stringify({ results: [], errors: [] }));
  });

  await t.test('a retained exact-mint page survives alongside a bot-blocked URL', async () => {
    const text = `Mint ${MINT}: a community token.`;
    const fetchValue = {
      results: [{ url: 'https://public.example/evidence', final_url: 'https://public.example/evidence', text }],
      errors: [{ url: 'https://public.example/other', error: 'bot_blocked' }],
    };
    const mock = mockedFetch({ searchValue, fetchValue });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'TRUNCATED');
    assert.equal(result.code, 'WEB_FETCH_BOT_BLOCKED');
    assert.deepEqual(result.pages.map(page => page.finalUrl), ['https://public.example/evidence']);
    assert.equal(result.fetchRaw, JSON.stringify(fetchValue));
  });

  await t.test('missing or malformed result/error arrays fail closed with raw evidence', async (st) => {
    for (const [name, fetchValue] of [
      ['missing errors', { results: [] }],
      ['malformed results', { results: 'not-an-array', errors: [] }],
    ] as const) {
      await st.test(name, async () => {
        const mock = mockedFetch({ searchValue, fetchValue });
        const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
        assert.equal(result.status, 'INVALID');
        assert.equal(result.code, 'WEB_FETCH_SHAPE');
        assert.deepEqual(result.pages, []);
        assert.equal(result.fetchRaw, JSON.stringify(fetchValue));
      });
    }
  });

  await t.test('unknown provider error tokens map to the generic safe code', async () => {
    const fetchValue = { results: [], errors: [{ url: 'https://public.example/evidence', error: 'private: raw message' }] };
    const mock = mockedFetch({ searchValue, fetchValue });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.code, 'WEB_FETCH_URL_ERROR');
    assert.equal(result.fetchRaw, JSON.stringify(fetchValue));
  });
});

test('TinyFish HTTP authorization and quota failures stay provider-specific', async (t) => {
  for (const status of [401, 402, 429]) {
    await t.test(`Search HTTP ${status}`, async () => {
      const mock = mockedFetch({ searchStatus: status });
      const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
      assert.equal(result.status, 'UNAVAILABLE');
      assert.equal(result.code, `WEB_SEARCH_HTTP_${status}`);
      assert.equal(mock.calls.length, 1);
    });
  }
  for (const status of [401, 402, 429]) {
    await t.test(`Fetch HTTP ${status}`, async () => {
      const mock = mockedFetch({
        fetchStatus: status,
        searchValue: { results: [{ url: 'https://public.example/evidence' }] },
      });
      const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
      assert.equal(result.status, 'UNAVAILABLE');
      assert.equal(result.code, `WEB_FETCH_HTTP_${status}`);
      assert.equal(mock.calls.length, 2);
    });
  }
});

function geminiResponse(claims: unknown, finishReason = 'STOP') {
  return { candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ claims }) }] } }] };
}

type AttentionPacket = {
  proposal?: unknown;
  sources: Array<{ id: string; url?: string; discoveredFrom?: string; spans: Array<{ id: string; text: string }> }>;
  requiredPostSourceIds?: string[];
  requiredDecisionIds?: string[];
};

function entrySupportResponse(packet: Record<string, unknown>): Record<string, unknown> {
  const citedV5Scope = packet.method === 'binary-public-support-v5' && packet.entrySupportScope;
  if (packet.entrySupportMethod !== 'reviewed-sample-growth-v1' && !citedV5Scope) return {};
  const sources = packet.sources as Array<{ id: string; kind?: string; spans: Array<{ id: string; text: string }> }>;
  const scope = packet.entrySupportScope as { complete?: boolean; sourceIds?: string[]; posts?: Array<{ sourceId: string }> } | undefined;
  const postIds = new Set([...(scope?.sourceIds ?? []), ...(scope?.posts ?? []).map(post => post.sourceId)]);
  const post = sources.find(source => source.kind === 'POST' && postIds.has(source.id) && source.spans.length > 0);
  const cited = post ?? sources.find(source => source.spans.length > 0);
  assert.ok(cited?.spans[0], 'a marked public-entry response cites an actual supplied span');
  const completePostWitness = scope?.complete === true && post?.spans[0];
  const judgment = (criterion: string) => completePostWitness
    ? { verdict: 'INADEQUATE', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: `The complete retained POST sample does not establish the ${criterion} support standard.`,
      citation: { sourceId: post!.id, spanId: post!.spans[0]!.id } }
    : { verdict: 'UNRESOLVED',
      rationale: `The supplied acquisition or POST evidence does not resolve the ${criterion} support standard.`,
      citation: { sourceId: cited!.id, spanId: cited!.spans[0]!.id } };
  return { entrySupport: {
    attentionContext: judgment('attention-context'),
    qualifiedSample: judgment('qualified-sample'),
    growth: judgment('growth'),
  } };
}

function publicLeadScopes(packet: Record<string, unknown>) {
  const qualification = packet.leadQualification as {
    leads?: Array<{ id: string; metadataEvidenceId: string; sourceIds?: string[]; recoverySourceIds?: string[] }>;
    decisions?: Array<{ leadId: string; accounted: boolean; accounting: { role: string } }>;
  } | undefined;
  const facts = packet.publicScopeFacts as Array<{
    leadId: string; originalComplete: boolean; recoveryComplete: boolean; queryReady: boolean; queryCount: number;
    effectiveAccounted: boolean; descriptorComplete: boolean; descriptorFresh: boolean;
    collectionBlocked: boolean; leadReviewsComplete: boolean; reviewedIndexedRole?: string;
  }> | undefined;
  const catalog = packet.sources as Array<{ sourceId: string; spans: Array<{ id: string; text: string }> }> | undefined;
  assert.ok(qualification?.leads && facts && catalog, 'the v2 grade packet supplies exact lead and collection facts');
  return Object.fromEntries(qualification.leads.map(lead => {
    const fact = facts.find(row => row.leadId === lead.id);
    const decision = qualification.decisions?.find(row => row.leadId === lead.id);
    const descriptor = catalog.find(source => source.sourceId === lead.metadataEvidenceId);
    assert.ok(fact && decision && descriptor?.spans[0], `the v2 packet has the full scope inputs for ${lead.id}`);
    const citations: Array<{ sourceId: string; spanId: string }> = [{ sourceId: descriptor.sourceId, spanId: descriptor.spans[0]!.id }];
    const bodyIds = fact.originalComplete ? lead.sourceIds ?? [] : lead.recoverySourceIds ?? [];
    const body = catalog.find(source => bodyIds.includes(source.sourceId) && source.spans.length > 0);
    if (body?.spans[0]) citations.push({ sourceId: body.sourceId, spanId: body.spans[0].id });
    const reviewed = fact.descriptorComplete && fact.descriptorFresh && !fact.collectionBlocked
      && fact.queryReady && fact.recoveryComplete && fact.leadReviewsComplete;
    const role = fact.reviewedIndexedRole ?? decision.accounting.role;
    const basis = fact.originalComplete ? 'ORIGINAL_COMPLETE'
      : fact.effectiveAccounted && fact.queryCount > 0 ? 'MATCHED_ENTITY_RECOVERY'
        : role === 'MARKET_OR_INDEX_RECORD' && fact.queryCount > 0 ? 'REVIEWED_MARKET_RECOVERY' : 'NONE';
    const complete = reviewed && basis !== 'NONE' && role !== 'UNRESOLVED';
    return [lead.id, {
      status: complete ? 'REVIEWED' : 'UNRESOLVED', basis: complete ? basis : 'NONE', role,
      blocker: complete ? 'NONE' : role === 'PROJECT_OR_PUBLICATION' ? 'MISSING_NECESSARY_CONTEXT' : 'INCOMPLETE_COLLECTION_OR_REVIEW',
      rationale: complete
        ? 'The independent review verifies this lead public-support scope against its own descriptor and retained source evidence.'
        : 'The lead public-review scope remains unresolved because a necessary own collection or review condition is incomplete.',
      citations,
    }];
  }));
}

function publicLeadScopeReviews(packet: Record<string, unknown>) {
  const scopes = (packet.supportProposal as { leadScopes?: Record<string, unknown> } | undefined)?.leadScopes;
  return scopes ? Object.fromEntries(Object.keys(scopes).map(id => [id, {
    accepted: true, rationale: 'The independent review checks this lead scope against its own original and recovery evidence.',
  }])) : undefined;
}

function isSocialModelPacket(packet: Record<string, unknown>): boolean {
  return Array.isArray(packet.requiredPostIds) && 'rubric' in packet;
}

function assertInvalidSocialProposal(rawArtifacts: Record<string, string>) {
  const raw = rawArtifacts['social-validation-error'];
  assert.ok(raw, 'the attention-shaped fixture response is retained as an invalid social proposal');
  const diagnostic = JSON.parse(raw) as { code: string; issues: unknown[] };
  assert.equal(diagnostic.code, 'SOC_MODEL_INVALID');
  assert.ok(diagnostic.issues.length > 0, 'the rejected social response includes safe schema-path diagnostics');
}

function assertSocialProviderCallsAreSeparated(mock: ReturnType<typeof mockedFetch>, rawArtifacts: Record<string, string>) {
  const attentionScope = JSON.parse(rawArtifacts['attention-scope']!) as { queries: string[] };
  const acquisition = JSON.parse(rawArtifacts['social-acquisition-scope']!) as {
    read: { queries: string[] };
    requestedUrls: string[];
  };
  const searchCalls = mock.calls.filter(call => call.url.startsWith('https://api.search.tinyfish.ai/'));
  const query = (url: string) => new URL(url).searchParams.get('query') ?? '';
  const socialQueries = acquisition.read.queries.filter(value => !attentionScope.queries.includes(value));
  const attentionSearchCalls = searchCalls.filter(call => attentionScope.queries.includes(query(call.url))).map(call => query(call.url)).sort();
  const socialSearchCalls = searchCalls.filter(call => socialQueries.includes(query(call.url))).map(call => query(call.url)).sort();
  assert.deepEqual(attentionSearchCalls, [...attentionScope.queries].sort(), 'attention keeps its original search requests');
  assert.deepEqual(socialSearchCalls, [...socialQueries].sort(), 'social selection searches are counted separately');
  assert.equal(searchCalls.length, attentionSearchCalls.length + socialSearchCalls.length, 'every Search request belongs to exactly one stage');

  const fetchCalls = mock.calls.filter(call => call.url === 'https://api.fetch.tinyfish.ai/');
  const fetchUrls = (call: typeof fetchCalls[number]) => {
    const request = JSON.parse(String(call.init?.body)) as { urls?: unknown };
    return Array.isArray(request.urls) ? request.urls : [];
  };
  const socialFetchCalls = fetchCalls.filter(call => JSON.stringify(fetchUrls(call)) === JSON.stringify(acquisition.requestedUrls));
  const socialFetchArtifacts = Object.keys(rawArtifacts).filter(key => /^social-fetch-\d+$/.test(key));
  assert.equal(socialFetchCalls.length, acquisition.requestedUrls.length ? 1 : 0, 'the social selection owns its bounded Fetch batch');
  assert.equal(socialFetchCalls.length, socialFetchArtifacts.length, 'social Fetch calls retain their own response artifact');
  const attentionFetchArtifacts = Object.keys(rawArtifacts).filter(key => /^attention.*fetch-\d+$/.test(key));
  assert.equal(fetchCalls.length - socialFetchCalls.length, attentionFetchArtifacts.length, 'remaining Fetch batches stay with attention and comparison recovery');
  return { attentionSearchCount: attentionSearchCalls.length, socialSearchCount: socialSearchCalls.length, attentionFetchCount: attentionFetchArtifacts.length, socialFetchCount: socialFetchCalls.length };
}

function attentionSpanId(packet: Record<string, unknown>, sourceId: string, includes: string): string {
  const source = (packet.sources as AttentionPacket['sources']).find(item => item.id === sourceId);
  assert.ok(source, `attention packet omitted ${sourceId}`);
  const span = source.spans.find(item => item.text.includes(includes));
  assert.ok(span, `no supplied span in ${sourceId} contains ${JSON.stringify(includes)}`);
  return span.id;
}

function attentionSourceId(packet: Record<string, unknown>, includes: string): string {
  const source = (packet.sources as AttentionPacket['sources']).find(item => item.spans.some(span => span.text.includes(includes)));
  assert.ok(source, `no supplied source span contains ${JSON.stringify(includes)}`);
  return source.id;
}

function attentionObservationId(packet: Record<string, unknown>, token: TokenRef, sourceId: string): string {
  const observations = packet.exactContractObservations as Array<{
    observationId: string; token: TokenRef; sourceId: string; spanId: string;
  }>;
  const observation = observations.find(item => item.token.chain === token.chain && item.token.address === token.address
    && item.sourceId === sourceId);
  assert.ok(observation, `no code-owned literal observation for ${token.chain}:${token.address} in ${sourceId}`);
  return observation.observationId;
}

function attentionMetadataSpanId(packet: Record<string, unknown>, sourceId: string, includes?: string): string {
  const source = (packet.sources as AttentionPacket['sources']).find(item => item.id === sourceId);
  assert.ok(source, `indexed lead packet omitted ${sourceId}`);
  const span = source.spans.find(item => includes === undefined || item.text.includes(includes));
  assert.ok(span, `no indexed span in ${sourceId} contains ${JSON.stringify(includes)}`);
  return span.id;
}

function attentionEnvelope(value: unknown) {
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] };
}

function citedAttentionReviewResponse(packet: Record<string, unknown>) {
  const view = packet.claimView as { claims: Array<{
    id: string; feature: string; value: boolean; originBasis?: string; summary: string;
    explanation?: unknown; citedEvidence: Array<{ sourceId: string; spanId: string }>;
  }> };
  return {
    decisions: Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
      accepted: true, rationale: 'The fixture independently checks each requested item against its canonical cited view.',
    }])),
    finalClaims: Object.fromEntries(view.claims.map(claim => [claim.id, {
      id: claim.id, feature: claim.feature, value: claim.value,
      ...(claim.originBasis ? { originBasis: claim.originBasis } : {}), summary: claim.summary,
      ...(claim.explanation ? { explanation: claim.explanation } : {}),
      citations: claim.citedEvidence.map(({ sourceId, spanId }) => ({ sourceId, spanId })),
    }])),
  };
}

function comparisonRowsForV3(packet: Record<string, unknown>, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const envelope = structuredClone(value) as Record<string, unknown>;
  const candidate = (envelope.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0];
  const part = candidate?.content?.parts?.[0];
  const response = (part?.text ? JSON.parse(part.text) : envelope) as Record<string, unknown>;
  const rowFormat = `${String(packet.rowFormat ?? '')}\n${String(packet.instruction ?? '')}`;
  const rows = (source: unknown, key: string) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
    return Object.entries(source as Record<string, unknown>).map(([id, item]) => ({ [key]: id, ...(item as Record<string, unknown>) }));
  };
  const coherentRows = (source: unknown) => {
    const decisions = Array.isArray(source) ? source : rows(source, 'leadId');
    return Array.isArray(decisions) ? decisions.map(value => {
      const row = value as Record<string, unknown>;
      const accounting = row.accounting as Record<string, unknown> | undefined;
      if (!accounting || ('descriptorRef' in accounting && !('status' in accounting))) return row;
      const descriptorRefs = accounting.descriptorRefs;
      const corroboratingRefs = accounting.corroboratingRefs;
      if (!Array.isArray(descriptorRefs) || descriptorRefs.length !== 1 || !Array.isArray(corroboratingRefs)) return row;
      if (accounting.status === 'UNRESOLVED' && accounting.basis === 'NONE') {
        const { status: _status, descriptorRefs: _descriptorRefs, ...rest } = accounting;
        return { ...row, accounting: { ...rest, descriptorRef: descriptorRefs[0] } };
      }
      if (accounting.status === 'ACCOUNTED' && accounting.basis !== 'NONE' && accounting.role !== 'UNRESOLVED'
        && corroboratingRefs.length > 0 && corroboratingRefs.length <= 5) {
        const { status: _status, descriptorRefs: _descriptorRefs, corroboratingRefs: _corroboratingRefs, ...rest } = accounting;
        return { ...row, accounting: { ...rest, descriptorRef: descriptorRefs[0], corroboratingRef: corroboratingRefs[0], additionalCorroboratingRefs: corroboratingRefs.slice(1) } };
      }
      return row;
    }) : decisions;
  };
  if (Array.isArray(packet.operands) && packet.requiredLeadDecisionGroups && !('proposal' in packet)
    && response.decisions && !('withOriginalBodies' in (response.decisions as Record<string, unknown>))) {
    const groups = packet.requiredLeadDecisionGroups as { withOriginalBodies: string[]; withoutOriginalBodies: string[] };
    const decisions = coherentRows(response.decisions) as Array<Record<string, unknown>>;
    const byId = new Map(decisions.map(row => [String(row.leadId), row]));
    response.decisions = {
      withOriginalBodies: groups.withOriginalBodies.flatMap(id => byId.has(id) ? [byId.get(id)] : []),
      withoutOriginalBodies: groups.withoutOriginalBodies.flatMap(id => byId.has(id) ? [byId.get(id)] : []),
    };
  } else if (Array.isArray(packet.operands) && rowFormat.includes('Accounting has one authoritative basis and no status field.')
    && !('proposal' in packet) && response.decisions) {
    response.decisions = coherentRows(response.decisions);
  } else if (Array.isArray(packet.selectedLeadIds) && Array.isArray(packet.leads) && response.leads && !Array.isArray(response.leads)) {
    response.leads = rows(response.leads, 'leadId');
  } else if (packet.requiredSourceDecisionGroups && response.sourceDecisions
    && !('withLiteralObservations' in (response.sourceDecisions as Record<string, unknown>))) {
    const decisions = response.sourceDecisions as Record<string, unknown>;
    const groups = packet.requiredSourceDecisionGroups as { withLiteralObservations: string[]; withoutLiteralObservations: string[] };
    response.decisions = rows(response.decisions, 'id');
    response.bodyDecisions = rows(response.bodyDecisions, 'sourceId');
    response.sourceDecisions = {
      withLiteralObservations: groups.withLiteralObservations.flatMap(id => id in decisions ? [{ sourceId: id, ...(decisions[id] as Record<string, unknown>) }] : []),
      withoutLiteralObservations: groups.withoutLiteralObservations.flatMap(id => id in decisions ? [{ sourceId: id, ...(decisions[id] as Record<string, unknown>) }] : []),
    };
  } else if (Array.isArray(packet.operands) && rowFormat.includes('Return decisions as one array row for EVERY operand')) {
    response.decisions = rows(response.decisions, 'leadId');
  } else if (Array.isArray(packet.operands) && rowFormat.includes('Return decisions as an array with exactly one leadId row')) {
    response.decisions = rows(response.decisions, 'leadId');
  } else if (rowFormat.includes('Return bodyObservations and posts as arrays')) {
    response.bodyObservations = rows(response.bodyObservations, 'sourceId');
    const postRows = rows(response.posts, 'sourceId');
    const omitNoPosts = String(packet.rowFormat ?? '').includes('There are no POST sources: posts field does not exist');
    if (omitNoPosts && Array.isArray(postRows) && postRows.length === 0) delete response.posts;
    else response.posts = postRows;
    const omitNoObservations = String(packet.rowFormat ?? '').includes('There are no literal contract observations: competitors field does not exist');
    if (omitNoObservations && Array.isArray(response.competitors) && response.competitors.length === 0) delete response.competitors;
  } else if (rowFormat.includes('Return decisions, sourceDecisions and bodyDecisions as arrays')) {
    response.decisions = rows(response.decisions, 'id');
    response.sourceDecisions = rows(response.sourceDecisions, 'sourceId');
    response.bodyDecisions = rows(response.bodyDecisions, 'sourceId');
  } else if (rowFormat.includes('Return leadRoles, sourceSupport and leadBlockers as arrays')) {
    const leadRoles = rows(response.leadRoles, 'leadId');
    response.leadRoles = Array.isArray(leadRoles) && rowFormat.includes('descriptorRef is a single object, not an array')
      ? leadRoles.map(value => {
        const row = value as Record<string, unknown>;
        if ('descriptorRef' in row) return row;
        const { descriptorRefs, ...rest } = row;
        return Array.isArray(descriptorRefs) && descriptorRefs.length > 0
          ? { ...rest, descriptorRef: descriptorRefs[0] }
          : rest;
      })
      : leadRoles;
    response.sourceSupport = rows(response.sourceSupport, 'sourceId');
    const blockers = rows(response.leadBlockers, 'leadId');
    response.leadBlockers = Array.isArray(blockers) ? blockers.map((row: Record<string, unknown>) => ({
      ...row, blockerProof: row.blockerProof ?? null,
    })) : blockers;
  } else if (rowFormat.includes('Return entryReview.leadRoles, sourceSupport and leadBlockers as exact ID arrays')) {
    const entryReview = response.entryReview as Record<string, unknown> | undefined;
    if (entryReview) response.entryReview = {
      ...entryReview,
      leadRoles: rows(entryReview.leadRoles, 'leadId'),
      sourceSupport: rows(entryReview.sourceSupport, 'sourceId'),
      leadBlockers: rows(entryReview.leadBlockers, 'leadId'),
    };
    response.decisions = rows(response.decisions, 'id');
  }
  if (part) part.text = JSON.stringify(response);
  return part ? envelope : response;
}



function comparisonReviewFields(packet: Record<string, unknown>) {
  const sources = (packet.sources ?? []) as Array<{ id: string }>;
  return {
    sourceDecisions: Object.fromEntries(sources.map(source => [source.id, {
      disposition: 'RELEVANT', insufficiencyKind: 'NONE',
      rationale: 'The retained source establishes this exact project representation.',
      inspectionComplete: true,
    }])),
    supportDecisions: Object.fromEntries(sources.map(source => [source.id, {
      accepted: true, rationale: 'The independent review accepts the selected source-support classification.',
    }])),
    missingRepresentations: [],
  };
}

function freshComparisonResponse(packet: Record<string, unknown>, target: TokenRef, additionalCandidates: TokenRef[] = []) {
  const sources = (packet.sources ?? []) as AttentionPacket['sources'];
  if (packet.entryTask && packet.mergeTask) {
    const entry = packet.entryTask as { proposal?: Record<string, unknown>; sources?: Array<{ id: string; spans: Array<{ id: string }> }> };
    const merge = packet.mergeTask as { candidates?: Array<{ id: string }>; manifest?: { qualificationMethod?: string; entryDecisionMethod?: string } };
    const proposal = entry.proposal;
    assert.ok(proposal, 'the fresh final review receives the exact entry proposal');
    const leadRoles = proposal.leadRoles as Record<string, unknown>;
    const sourceSupport = proposal.sourceSupport as Record<string, unknown>;
    const leadBlockers = proposal.leadBlockers as Record<string, unknown>;
    const entryCitation = entry.sources?.flatMap(source => source.spans.map(span => ({ sourceId: source.id, spanId: span.id })))
      .find(ref => ref.sourceId && ref.spanId);
    if (merge.manifest?.entryDecisionMethod === 'binary-public-support-v1') {
      assert.ok(entryCitation, 'the direct entry decision cites a supplied comparison-body span');
    }
    return attentionEnvelope({
      ...(merge.manifest?.entryDecisionMethod === 'binary-public-support-v1' ? { entryDecision: {
        verdict: 'FAIL', rationale: 'The bounded comparison sample does not meet the independent public-support standard.', citations: [entryCitation!],
      } } : {}),
      entryReview: {
        leadRoles: Object.fromEntries(Object.keys(leadRoles).map(id => [id, { accepted: true, rationale: 'The own indexed role is supported by its descriptor and retained body.' } ])),
        sourceSupport: Object.fromEntries(Object.keys(sourceSupport).map(id => [id, { accepted: true, rationale: 'The body classification is supported by its own inspected literal text.' } ])),
        leadBlockers: Object.fromEntries(Object.keys(leadBlockers).map(id => [id, { accepted: true, rationale: 'No unsupported semantic blocker is asserted.' } ])),
        grade: { accepted: true, rationale: 'The unresolved public-support judgment is appropriate for the selected evidence.' },
      },
      decisions: Object.fromEntries((merge.candidates ?? []).map(({ id }) => [id, { accepted: true, rationale: 'The candidate is checked against its retained literal observation.' } ])),
      candidateSet: { complete: true, rationale: 'The target and every relevant representation in these full source batches are accounted for.' },
    });
  }

  if ((packet.method === 'binary-public-support-v2' || packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4') && Array.isArray(packet.sources)) {
    const catalog = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
    const originIds = (packet.scope as { originSourceIds: string[] }).originSourceIds;
    const origin = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
      .find(({ source, span }) => originIds.includes(source.id) && span.text.includes(target.address));
    const comparison = catalog.flatMap(source => source.spans.map(span => ({ source, span })))[0];
    assert.ok(origin, 'the independent origin criterion cites a literal target span from the original scope');
    assert.ok(comparison, 'the remaining criteria cite actual retained comparison text');
    const explanationIds = packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4' ? packet.explainableCitationSourceIds as string[] : [];
    const explainable = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
      .find(({ source, span }) => explanationIds.includes(source.id) && span.text.includes(target.address));
    if (packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4') assert.ok(explainable, 'the fresh thesis judgment cites a narrative-bound exact-token source');
    const final = Object.hasOwn(packet, 'draft');
    const grade = (verdict: 'PASS' | 'FAIL', sourceId: string, spanId: string, rationale: string) => ({
      verdict, rationale, citation: { sourceId, spanId },
      ...(packet.outcomeBasisMethod === 'entry-outcome-basis-v1' && verdict === 'FAIL'
        ? { negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE' } : {}),
    });
    return attentionEnvelope({
      ...entrySupportResponse(packet),
      originTraceability: grade('FAIL', origin.source.id, origin.span.id, final
        ? 'The retained source names the exact contract but does not establish its specific originating project or catalyst.'
        : 'The cited source names the exact contract but does not establish a specific originating project or catalyst.'),
      leadership: { ...grade(packet.method === 'binary-public-support-v4' || final ? 'FAIL' : 'PASS', comparison.source.id, comparison.span.id, final
        ? 'The bounded sample has no relative exact-token mention counts or verified primary-origin relationship.'
        : 'The retained source is proposed as support for the leadership criterion.'),
        ...(packet.method === 'binary-public-support-v4' ? { basis: 'EVIDENCE_INADEQUACY' } : {}) },
      representations: grade(final ? 'FAIL' : 'PASS', comparison.source.id, comparison.span.id, final
        ? 'The bounded source review does not establish adequate competing-representation coverage.'
        : 'The retained source is proposed as support for the representation criterion.'),
      ...(packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4' ? { explainableThesis: grade(final ? 'FAIL' : 'PASS', explainable!.source.id, explainable!.span.id, final
        ? 'The retained sources do not adequately explain the narrative interest and its relationship to this exact token.'
        : 'The retained source is proposed as support for a plain-language thesis judgment.') } : {}),
      inspectionComplete: true,
    });
  }

  if (packet.method === 'binary-public-support-v1' && Array.isArray(packet.sources)) {
    const catalog = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
    const sourceIds = catalog.map(source => source.id);
    const cited = catalog.flatMap(source => source.spans.map(span => ({ sourceId: source.id, ...span })))
      .find(span => span.text.includes(target.address));
    assert.ok(cited, 'the binary origin pair cites literal target text in its original source scope');
    const decision = (verdict: 'PASS' | 'FAIL') => ({ verdict,
      rationale: 'The criterion is judged independently from the complete retained sample.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] });
    if ('screening' in packet) return attentionEnvelope({
      originTraceability: decision('FAIL'), leadership: decision('FAIL'), inspectionComplete: true, sourceIds,
    });
    return attentionEnvelope({
      originTraceability: { verdict: 'UNRESOLVED', rationale: 'The draft leaves the criterion for independent review.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] },
      leadership: { verdict: 'UNRESOLVED', rationale: 'The draft leaves the separate criterion for independent review.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] },
      sourceIds,
    });
  }

  if (Array.isArray(packet.operands)) {
    const operands = packet.operands as Array<{
      leadId: string; indexedDescriptorId: string; originalBodyIds: string[]; recoveryBodyIds: string[];
      literalOptions: Array<{ id: string; token: TokenRef; sourceId: string; spanId: string }>;
    }>;
    if (packet.proposal) {
      const decisions = packet.proposal as { decisions: Record<string, unknown> };
      return attentionEnvelope({ decisions: Object.fromEntries(Object.keys(decisions.decisions).map(id => [id, {
        accounting: { accepted: true, rationale: 'The indexed item identity is reviewed separately from public support.' },
        representation: { accepted: true, rationale: 'The proposed relation is checked against its own descriptor and retained sources.' },
        subjectComparison: { accepted: true, rationale: 'The original-body comparison is reviewed as a separate factual axis.' },
        evidenceAdequacy: { accepted: true, rationale: 'The proposal does not infer inadequacy from a missing original body.' },
      }])) });
    }
    const catalog = sources;
    return attentionEnvelope({ decisions: Object.fromEntries(operands.map(operand => {
      const descriptor = catalog.find(source => source.id === operand.indexedDescriptorId);
      assert.ok(descriptor?.spans[0], `the task packet retains ${operand.indexedDescriptorId}`);
      const descriptorRef = { sourceId: descriptor.id, spanId: descriptor.spans[0]!.id };
      const ownIds = [...operand.originalBodyIds, ...operand.recoveryBodyIds];
      const body = catalog.find(source => ownIds.includes(source.id) && source.spans.length > 0
        && source.spans.some(span => span.text.includes(target.address)));
      const ownBody = body ?? catalog.find(source => ownIds.includes(source.id) && source.spans.length > 0);
      const bodyRef = ownBody?.spans[0] ? { sourceId: ownBody.id, spanId: ownBody.spans[0].id } : undefined;
      const literal = operand.literalOptions.find(option => option.token.chain === target.chain
        && option.token.address === target.address && ownIds.includes(option.sourceId));
      const isTarget = !!literal && operand.originalBodyIds.length > 0;
      const decision: Record<string, unknown> = {
        accounting: {
          status: ownBody ? 'ACCOUNTED' : 'UNRESOLVED', basis: ownBody ? operand.originalBodyIds.includes(ownBody.id) ? 'ORIGINAL_TEXT' : 'RECOVERED_ENTITY' : 'NONE',
          role: /market|pool|pair|dexscreener/i.test(operand.leadId) ? 'MARKET_OR_INDEX_RECORD' : 'PROJECT_OR_PUBLICATION',
          rationale: ownBody ? 'This lead is supported by its own acquired or positively recovered source.' : 'The own item remains unresolved without acquired corroboration.',
          descriptorRefs: [descriptorRef], corroboratingRefs: bodyRef ? [bodyRef] : [],
        },
        representation: isTarget && literal
          ? { status: 'BOUND', literalObservationId: literal.id, rationale: 'The target mint is bound by its own original project text.', associationRefs: bodyRef ? [bodyRef] : [] }
          : ownBody
            ? { status: 'UNRELATED', rationale: 'The own source describes a distinct indexed project, not the target narrative.', citations: [descriptorRef, bodyRef] }
            : { status: 'UNRESOLVED', rationale: 'The available item evidence does not establish a target association.', citations: [descriptorRef] },
      };
      if (operand.originalBodyIds.length) {
        decision.subjectComparison = isTarget && bodyRef
          ? { status: 'CONSISTENT', indexedSubject: 'The indexed target project', currentSubject: 'The acquired target project', rationale: 'The original body describes its own indexed target project.', descriptorRefs: [descriptorRef], fetchedRefs: [bodyRef] }
          : { status: 'UNRESOLVED', indexedSubject: 'The indexed project', currentSubject: null, rationale: 'The original body does not establish a current subject match.', descriptorRefs: [descriptorRef], fetchedRefs: [] };
        decision.evidenceAdequacy = { verdict: 'UNRESOLVED', rationale: 'This lead does not establish an original-source public-support deficiency.', citations: [] };
      }
      return [operand.leadId, decision];
    })) });
  }

  const scope = packet.scope as { batch?: number } | undefined;
  if (typeof scope?.batch === 'number' && packet.targetContext && Array.isArray(packet.exactContractObservations)) {
    const observationSources = packet.exactContractObservations as Array<{ observationId: string; token: TokenRef; sourceId: string }>;
    if (!packet.proposal) {
      const bodyObservations = Object.fromEntries(sources.map(source => {
        const span = source.spans[0];
        assert.ok(span, `batch source ${source.id} has a selected literal span`);
        const text = source.spans.map(item => item.text).join('\n');
        const footer = /About Press Copyright Contact us Creators (?:Advertisers )?Developers Terms Privacy Policy/i.test(text);
        const isTarget = text.includes(target.address);
        const bodyRole = footer ? 'OTHER_CONTEXT'
          : /market index|market pair|liquidity|trading data/i.test(text) ? 'MARKET_OR_INDEX_RECORD' : 'PROJECT_OR_PUBLICATION';
        const description = footer ? 'NO_SUBSTANTIVE_CONTENT'
          : /Lunar Cat|feline art|digital-parasite project|AVA AI/i.test(text) && !isTarget ? 'DISTINCT_OTHER_SUBJECT'
            : /market index|market pair|liquidity|trading data/i.test(text) ? 'MARKET_FIELDS_OR_BOILERPLATE' : 'SPECIFIC_PROJECT_OR_MECHANISM';
        const ref = { sourceId: source.id, spanId: span.id };
        return [source.id, {
          bodyRole: { kind: bodyRole, rationale: 'The source role follows its own full retained body.', citations: [ref] },
          description: { kind: description, rationale: 'The description follows the inspected text rather than the indexed name alone.', citations: [ref] },
        }];
      }));
      const candidateTokens = [target, ...additionalCandidates];
      const competitors = candidateTokens.flatMap((token, index) => {
        const observation = observationSources.find(item => item.token.chain === token.chain && item.token.address === token.address
          && sources.some(source => source.id === item.sourceId && source.spans.some(span => span.text.includes(token.address))));
        return observation ? [{ id: index === 0 ? 'target-retained-text' : `competing-retained-text-${index}`, observationId: observation.observationId }] : [];
      });
      return attentionEnvelope({ bodyObservations, competitors,
        posts: Object.fromEntries(((packet.requiredPostSourceIds ?? []) as string[]).map(id => [id, {
          spanId: attentionSpanId(packet, id, target.address), role: 'OTHER',
        }])) });
    }
    const proposal = packet.proposal as { competitors?: Array<{ observationId?: string; sourceId?: string }> };
    const selectedSourceIds = new Set((proposal.competitors ?? []).flatMap(item => {
      if (item.sourceId) return [item.sourceId];
      const observation = observationSources.find(candidate => candidate.observationId === item.observationId);
      return observation ? [observation.sourceId] : [];
    }));
    const noContent = (source: AttentionPacket['sources'][number]) => source.spans.some(span => /About Press Copyright Contact us Creators (?:Advertisers )?Developers Terms Privacy Policy/i.test(span.text));
    const decisions = Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
      accepted: true, rationale: 'The exact batch item is reviewed against every retained source span.' } ]));
    const omitNoItemDecisions = String(packet.rowFormat ?? '').includes('There are no required item decisions. The decisions field does not exist');
    return attentionEnvelope({
      ...(omitNoItemDecisions ? {} : { decisions }),
      candidateSet: { complete: true, rationale: 'Every relevant exact-contract observation in the acquired full-text batch is included.' },
      sourceDecisions: Object.fromEntries(sources.map(source => [source.id, {
        disposition: noContent(source) ? 'INSUFFICIENT' : selectedSourceIds.has(source.id) ? 'RELEVANT' : 'CONTEXT',
        insufficiencyKind: noContent(source) ? 'NO_SUBSTANTIVE_CONTENT' : 'NONE',
        rationale: 'The source is classified from its full retained text and selected observations.', inspectionComplete: true,
      } ])),
      bodyDecisions: Object.fromEntries(sources.map(source => [source.id, {
        bodyRole: { accepted: true, rationale: 'The retained full body supports this role.' },
        description: { accepted: true, rationale: 'The retained full body supports this description.' },
      } ])),
      ...(observationSources.length ? { missingRepresentations: [] } : {}),
    });
  }

  if (Array.isArray(packet.bodyObservations) && Array.isArray(packet.leadContexts) && Array.isArray(packet.sourceRequirements)) {
    const observations = packet.bodyObservations as Array<{ sourceId: string; bodyRole: { kind: string }; description: { kind: string } }>;
    const contexts = packet.leadContexts as Array<{ leadId: string; indexedMetadataSourceId: string; originalSourceIds: string[]; recoverySourceIds: string[] }>;
    const refFor = (sourceId: string) => {
      const source = sources.find(item => item.id === sourceId);
      assert.ok(source?.spans[0], `the entry packet supplies a selected span for ${sourceId}`);
      return { sourceId, spanId: source.spans[0]!.id };
    };
    const leadRoles = Object.fromEntries(contexts.map(context => {
      const descriptor = sources.find(source => source.id === context.indexedMetadataSourceId);
      assert.ok(descriptor?.spans[0], `the entry packet includes ${context.indexedMetadataSourceId}`);
      const own = [...context.originalSourceIds, ...context.recoverySourceIds].find(id => sources.some(source => source.id === id && source.spans.length));
      return [context.leadId, {
        role: /market|pool|pair|dexscreener/i.test(descriptor.spans.map(span => span.text).join(' ')) ? 'MARKET_OR_INDEX_RECORD' : 'PROJECT_OR_PUBLICATION',
        rationale: 'The original indexed descriptor identifies the source role.', descriptorRefs: [refFor(descriptor.id)],
        ownContextRefs: own ? [refFor(own)] : [],
      }];
    }));
    const sourceSupport = Object.fromEntries(observations.map(observation => {
      const status = observation.description.kind === 'SPECIFIC_PROJECT_OR_MECHANISM' ? 'BINDING_EVIDENCE' : 'CONTEXT_ONLY';
      return [observation.sourceId, { status, rationale: 'The fully inspected body is either specific narrative evidence or context.', citations: [refFor(observation.sourceId)], blockerProof: null }];
    }));
    const gradeSourceId = observations.find(item => item.description.kind === 'MARKET_FIELDS_OR_BOILERPLATE')?.sourceId
      ?? observations[0]?.sourceId ?? sources[0]?.id;
    assert.ok(gradeSourceId, 'the entry packet contains a literal grade witness');
    const proposal = { leadRoles, sourceSupport, leadBlockers: Object.fromEntries(contexts.map(context => [context.leadId, null])),
      grade: { verdict: 'UNRESOLVED', rationale: 'The retained bodies do not establish a reviewed public-support gap.', citations: [refFor(gradeSourceId)] } };
    if (!packet.entryTask) return attentionEnvelope(proposal);
  }
  return undefined;
}

function citedClaimReviewFixture(packet: Record<string, unknown>, summaryOverrides: Record<string, string> = {}) {
  const view = packet.claimView as { claims: Array<{ id: string; feature: string; value: boolean; originBasis?: string;
    summary: string; explanation?: unknown; citedEvidence: Array<{ sourceId: string; spanId: string }> }> };
  assert.ok(view?.claims, 'the canonical cited review exposes only the selected claim spans');
  const finalClaims = Object.fromEntries(view.claims.map(claim => [claim.id, {
    id: claim.id, feature: claim.feature, value: claim.value,
    ...(claim.originBasis ? { originBasis: claim.originBasis } : {}), summary: summaryOverrides[claim.id] ?? claim.summary,
    ...(claim.explanation ? { explanation: claim.explanation } : {}),
    citations: claim.citedEvidence.map(({ sourceId, spanId }) => ({ sourceId, spanId })),
  }]));
  return attentionEnvelope({
    decisions: Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
      accepted: true, rationale: 'The independent cited review checks the exact claim-specific source selectors.',
    }])),
    finalClaims,
  });
}

function citedV5EntryFixture(packet: Record<string, unknown>, target: TokenRef, representation?: {
  basis: 'NO_RELEVANT_ALTERNATIVE' | 'IDENTIFIED_REPRESENTATIONS'; alternative?: TokenRef;
}) {
  const catalog = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
  const scope = packet.scope as { originSourceIds?: string[] };
  const acquisitionScope = packet.acquisitionScope as { requiredEvidenceIds?: string[] } | undefined;
  const acquisitionRecords = new Set(((packet.acquisitionEvidence ?? []) as Array<{ id: string }>).map(record => record.id));
  const acquisitionInspection = acquisitionScope?.requiredEvidenceIds?.map(sourceId => {
    assert.ok(acquisitionRecords.has(sourceId), `the v5 acquisition inspection selects actual required receipt ${sourceId}`);
    return { sourceId, complete: true, rationale: 'The required bounded acquisition receipt and its linked operation records were inspected.' };
  });
  const narrativeIds = new Set((packet.narrativeGameSourceIds ?? []) as string[]);
  const originIds = new Set(scope.originSourceIds ?? []);
  const origin = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
    .find(({ source, span }) => originIds.has(source.id) && span.text.includes(target.address));
  const narrative = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
    .find(({ source, span }) => narrativeIds.has(source.id) && span.text.includes(target.address));
  const comparison = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
    .find(({ span }) => span.text.trim().length >= 8);
  const representationCitation = (address: string, allowedIds?: Set<string>) => {
    const match = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
      .filter(({ source }) => !allowedIds || allowedIds.has(source.id))
      .find(({ span }) => span.text.includes(address));
    assert.ok(match, `the complete v5 source packet contains a literal witness for ${address}`);
    return { source: match.source, span: match.span };
  };
  assert.ok(origin, 'the v5 origin criterion cites a literal target span from its original scope');
  assert.ok(narrative, 'the v5 narrative criterion cites a literal target span from a narrative-bound source');
  assert.ok(comparison, 'the v5 response cites actual supplied full-source text');
  const cite = ({ source, span }: { source: { id: string }; span: { id: string } }) => ({ sourceId: source.id, spanId: span.id });
  const targetRepresentation = representationCitation(target.address, narrativeIds);
  if (representation?.basis === 'IDENTIFIED_REPRESENTATIONS') assert.ok(representation.alternative,
    'the identified-representation fixture supplies a distinct alternative token');
  const alternative = representation?.basis === 'IDENTIFIED_REPRESENTATIONS'
    ? representationCitation(representation.alternative!.address) : undefined;
  return attentionEnvelope({
    ...entrySupportResponse(packet),
    originTraceability: { verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: 'The bounded source record does not establish a specific originating project relationship.', citations: [cite(origin)] },
    leadership: { verdict: 'FAIL', basis: 'EVIDENCE_INADEQUACY', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: 'The retained sample does not establish primary-origin or measured leadership support.', citations: [cite(comparison)] },
    representations: representation ? {
      verdict: 'PASS', basis: representation.basis,
      rationale: representation.basis === 'NO_RELEVANT_ALTERNATIVE'
        ? 'The complete retained source scope contains only this target narrative witness and no independently relevant alternative.'
        : 'The full retained source bodies independently connect the target narrative and its distinct alternative representation.',
      citations: [cite(targetRepresentation)], targetWitness: { citations: [cite(targetRepresentation)] },
      ...(alternative ? { firstAlternativeWitness: { token: representation.alternative!, citations: [cite(alternative)] }, otherAlternativeWitnesses: [] } : {}),
    } : { verdict: 'FAIL', basis: 'EVIDENCE_INADEQUACY', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: 'The bounded source record does not establish adequate representation coverage.', citations: [cite(comparison)] },
    explainableThesis: { verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: 'The retained sources do not establish an adequate plain-language thesis for this token.', citations: [cite(narrative)] },
    narrativeGame: { verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: 'The bounded entry review does not establish the complete narrative-game support standard.', citations: [cite(narrative)] },
    ...(acquisitionInspection ? { acquisitionInspection } : {}),
    inspectionComplete: true,
  });
}

function withCriterionPremises(packet: Record<string, unknown>, value: unknown): unknown {
  if (packet.semanticPremiseMethod !== 'criterion-premises-v1' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const envelope = structuredClone(value) as Record<string, unknown>;
  const candidate = (envelope.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0];
  const part = candidate?.content?.parts?.[0];
  const response = (part?.text ? JSON.parse(part.text) : envelope) as Record<string, unknown>;
  const sources = (packet.sources ?? []) as Array<{ id?: string; spans?: Array<{ id?: string; text?: string }> }>;
  const reviewRefs = ((packet.claimView as { claims?: Array<{ citedEvidence?: Array<{ sourceId: string; spanId: string; text: string }> }> } | undefined)?.claims ?? [])
    .flatMap(claim => claim.citedEvidence ?? []);
  const premise = (ref: unknown, assertion: string) => {
    if (!ref || typeof ref !== 'object') return undefined;
    const selector = ref as { sourceId?: unknown; spanId?: unknown };
    if (typeof selector.sourceId !== 'string' || typeof selector.spanId !== 'string') return undefined;
    const source = sources.find(item => item.id === selector.sourceId);
    const span = source?.spans?.find(item => item.id === selector.spanId);
    const text = span?.text ?? reviewRefs.find(item => item.sourceId === selector.sourceId && item.spanId === selector.spanId)?.text;
    if (typeof text !== 'string' || !text) return undefined;
    const extract = text.slice(0, 1000);
    return { assertion, sourceId: selector.sourceId, spanId: selector.spanId, extract };
  };
  const factualProof = (claim: Record<string, unknown>, refs: unknown[]) => {
    const first = refs.map(ref => premise(ref, 'The cited fixture span is the retained source premise.')).find(Boolean);
    if (!first) return undefined;
    const explanation = claim.explanation && typeof claim.explanation === 'object' ? claim.explanation as { prerequisites?: unknown[] } : undefined;
    const prerequisites = (explanation?.prerequisites ?? []).map((item, index) => premise(refs[index % refs.length], typeof item === 'string' ? item : 'The prerequisite is represented in the retained fixture span.')).filter(Boolean);
    return { referent: first, interest: first, tokenRelation: first, ...(explanation ? { prerequisiteAssessment: 'The fixture supplies the claim explanation for independent review.' } : {}), prerequisites };
  };
  const publicProof = (criterion: 'NAR-01' | 'NAR-02' | 'NAR-03', grade: Record<string, unknown>) => {
    const citations = Array.isArray(grade.citations) ? grade.citations : [];
    const first = citations.map(ref => premise(ref, 'The cited fixture span is the retained criterion premise.')).find(Boolean);
    if (grade.verdict === 'PASS' && first) {
      const base = { kind: 'SUPPORTED', criterion, premises: [first] } as const;
      if (criterion === 'NAR-01') return { ...base, referent: first, interest: first, tokenRelation: first, gameClass: 'COMMUNITY', mechanism: first };
      if (criterion === 'NAR-03') return { ...base, referent: first, interest: first, tokenRelation: first,
        prerequisiteAssessment: 'The bounded fixture supplies no additional indispensable prerequisite.', prerequisites: [] };
      return base;
    }
    if (grade.negativeBasis === 'FACTUAL_COUNTEREVIDENCE' && first) {
      return { kind: 'FACTUAL_COUNTEREVIDENCE', criterion,
        proposition: criterion === 'NAR-01' ? 'NARRATIVE_GAME_SUPPORTED' : criterion === 'NAR-02' ? 'ORIGIN_TRACEABLE' : 'THESIS_EXPLAINABLE',
        incompatibleAssertion: 'The retained fixture premise is incompatible with the named criterion proposition.', premise: first,
        incompatibility: 'The cited fixture premise states the incompatible proposition.' };
    }
    if (grade.negativeBasis === 'PUBLIC_SUPPORT_INADEQUATE') return { kind: 'PUBLIC_SUPPORT_INADEQUATE', criterion,
      gap: typeof grade.rationale === 'string' ? grade.rationale : 'The complete fixture review lacks a named necessary support premise.' };
    return undefined;
  };

  if (packet.method === 'binary-public-support-v5') {
    for (const [field, criterion] of [['narrativeGame', 'NAR-01'], ['originTraceability', 'NAR-02'], ['explainableThesis', 'NAR-03']] as const) {
      const grade = response[field];
      if (grade && typeof grade === 'object' && !('criterionProof' in grade)) {
        const proof = publicProof(criterion, grade as Record<string, unknown>);
        if (proof) (grade as Record<string, unknown>).criterionProof = proof;
      }
    }
  } else if (packet.claimView && response.finalClaims && typeof response.finalClaims === 'object') {
    const view = packet.claimView as { claims?: Array<{ id: string; feature: string; citedEvidence?: unknown[] }> };
    const finals = response.finalClaims as Record<string, unknown>;
    for (const claim of view.claims ?? []) {
      const final = finals[claim.id];
      if ((claim.feature === 'A01' || claim.feature === 'A05') && final && typeof final === 'object' && !('criterionProof' in final)) {
        const proof = factualProof(final as Record<string, unknown>, claim.citedEvidence ?? []);
        if (proof) (final as Record<string, unknown>).criterionProof = proof;
      }
    }
  }
  if (part?.text) part.text = JSON.stringify(response);
  return candidate ? envelope : response;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const savedShapeSources = () => [
  {
    id: 'web-page-1',
    text: 'Mint ' + MINT + '\nThe project is a community token for holders. Its category is a meme coin. Official account: @Schoen\\_xyz.',
  },
  {
    id: 'web-page-2',
    text: 'Mint ' + MINT + '\nThe Solana token launched on Pump.fun.',
  },
];
const savedShapeClaims = () => [
  { kind: 'NARRATIVE', value: 'Community token', evidenceId: 'web-page-1', quote: 'community token', assertion: 'SOURCE_STATES' },
  { kind: 'GAME_TYPE', value: 'Meme coin', evidenceId: 'web-page-1', quote: 'meme coin', assertion: 'SOURCE_STATES' },
  { kind: 'SOCIAL_ACCOUNT', value: '@Schoen_xyz', evidenceId: 'web-page-1', quote: '@Schoen_xyz', assertion: 'SOURCE_STATES' },
  { kind: 'TOKEN_RELATION', value: 'Solana token', evidenceId: 'web-page-2', quote: 'Solana token', assertion: 'SOURCE_STATES' },
  { kind: 'ORIGIN', value: 'Pump.fun launch', evidenceId: 'web-page-2', quote: 'launched on Pump.fun', assertion: 'SOURCE_STATES' },
];

test('legacy semantic parser aligns one raw social quote without modifying the response', () => {
  const sources = savedShapeSources();
  const claims = savedShapeClaims();
  const response = geminiResponse(claims);
  const originalResponse = JSON.stringify(response);
  const packet = JSON.stringify({ instruction: 'sanitized saved-shape packet', token: MINT, sources });
  const parsed = parseGeminiSemantic(response, packet, MINT, sources);
  assert.equal(parsed.status, 'CANDIDATE');
  assert.equal(parsed.claims.length, 5);
  assert.equal(parsed.claims[2]?.quote, '@Schoen\\_xyz');
  assert.deepEqual(parsed.claims.filter((_claim, index) => index !== 2), claims.filter((_, index) => index !== 2));
  assert.equal(JSON.stringify(response), originalResponse);
  assert.equal(parsed.promptHash, sha256(packet));
  assert.equal(parsed.responseHash, sha256(originalResponse));
});

test('Gemini social-handle fallback accepts only one complete exact raw spelling', async (t) => {
  const sourceWith = (rawHandle: string) => 'Mint ' + MINT + '\nAccount: ' + rawHandle;
  const packet = 'sanitized parser adversary packet';
  const parseQuote = (rawSource: string, quote: string, kind = 'SOCIAL_ACCOUNT', evidenceId = 'web-page-1', address = MINT) =>
    parseGeminiSemantic(geminiResponse([{
      kind, value: 'Synthetic account', evidenceId, quote, assertion: 'SOURCE_STATES',
    }]), packet, address, [{ id: 'web-page-1', text: rawSource }]);

  await t.test('multiple escaped underscores and punctuation delimiters retain the exact raw handle', () => {
    const raw = '@Schoen\\_xyz\\_bot';
    const result = parseQuote(sourceWith('(' + raw + '),'), '@Schoen_xyz_bot');
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.claims[0]?.quote, raw);
  });

  await t.test('the same raw spelling may appear more than once', () => {
    const raw = '@Schoen\\_xyz';
    const result = parseQuote(sourceWith(raw + ' and (' + raw + ').'), '@Schoen_xyz');
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.claims[0]?.quote, raw);
  });

  await t.test('exact raw quote takes precedence over another equivalent spelling', () => {
    const exact = '@Schoen_xyz';
    const result = parseQuote(sourceWith(exact + ' and @Schoen\\_xyz.'), exact);
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.claims[0]?.quote, exact);
  });

  const rejected = [
    ['longer prefix', 'x@Schoen\\_xyz', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['longer suffix', '@Schoen\\_xyzEvil', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['escaped suffix', '@Schoen\\_xyz\\_extra', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['different case', '@Schoen\\_xyz', '@schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['fabricated handle', '@Schoen\\_xyz', '@Other_account', 'SOCIAL_ACCOUNT'],
    ['wrong claim kind', '@Schoen\\_xyz', '@Schoen_xyz', 'NARRATIVE'],
    ['arbitrary backslash escape', '@Schoen\\x_xyz', '@Schoen_x_xyz', 'SOCIAL_ACCOUNT'],
    ['doubled backslash escape', '@Schoen\\\\_xyz', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['normalized whitespace', '@Schoen\\_xyz', '@Schoen xyz', 'SOCIAL_ACCOUNT'],
  ] as const;
  for (const [name, raw, quote, kind] of rejected) {
    await t.test(name + ' is rejected', () => {
      const result = parseQuote(sourceWith(raw), quote, kind);
      assert.equal(result.status, 'INVALID');
      assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
      assert.deepEqual(result.claims, []);
    });
  }

  await t.test('two distinct raw spellings that render identically are ambiguous', () => {
    const result = parseQuote(sourceWith('@Schoen\\_xyz_bot and @Schoen_xyz\\_bot'), '@Schoen_xyz_bot');
    assert.equal(result.status, 'INVALID');
    assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
  });

  await t.test('expanded raw citation must still fit the quote schema', () => {
    const displayed = '@' + 'a'.repeat(997) + '_b';
    const raw = displayed.replace('_', '\\_');
    assert.equal(displayed.length, 1000);
    assert.equal(raw.length, 1001);
    const result = parseQuote(sourceWith(raw), displayed);
    assert.equal(result.status, 'INVALID');
    assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
  });

  await t.test('missing evidence ID or mint text rejects the claim', () => {
    const quote = 'community token';
    const claim = { kind: 'NARRATIVE', value: 'Community', evidenceId: 'missing-source', quote, assertion: 'SOURCE_STATES' };
    const missingId = parseGeminiSemantic(geminiResponse([claim]), packet, MINT, [{ id: 'web-page-1', text: sourceWith(quote) }]);
    assert.equal(missingId.status, 'INVALID');
    assert.deepEqual(missingId.validationErrors, ['UNSUPPORTED_CITATION']);
    const missingMint = parseGeminiSemantic(geminiResponse([{
      ...claim, evidenceId: 'web-page-1',
    }]), packet, MINT, [{ id: 'web-page-1', text: 'A community token is discussed here.' }]);
    assert.equal(missingMint.status, 'INVALID');
    assert.deepEqual(missingMint.validationErrors, ['UNSUPPORTED_CITATION']);
  });

  await t.test('one unsupported sibling invalidates the complete batch', () => {
    const good = { kind: 'NARRATIVE', value: 'Community', evidenceId: 'web-page-1', quote: 'community token', assertion: 'SOURCE_STATES' };
    const bad = { ...good, value: 'Fabricated', quote: 'project is guaranteed to moon' };
    const source = 'Mint ' + MINT + '\nIt is a community token.';
    const result = parseGeminiSemantic(geminiResponse([good, bad]), packet, MINT, [{ id: 'web-page-1', text: source }]);
    assert.equal(result.status, 'INVALID');
    assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
    assert.deepEqual(result.claims, []);
  });
});

test('legacy Gemini parser cannot cite text beyond its supplied source excerpt', () => {
  const visibleQuote = 'Visible release notes';
  const hiddenQuote = 'Unseen founder guarantee';
  const pageText = 'Mint ' + MINT + '\nThe page says ' + visibleQuote + '.\n' + 'x'.repeat(6100) + '\n' + hiddenQuote + '.';
  assert.ok(pageText.length > 6000);
  assert.ok(pageText.indexOf(hiddenQuote) >= 6000);
  const submitted = pageText.slice(0, 6000);
  assert.ok(submitted.includes(visibleQuote));
  assert.equal(submitted.includes(hiddenQuote), false);
  const source = [{ id: 'web-page-1', text: submitted }];
  const packet = JSON.stringify({ sources: source });
  const visible = parseGeminiSemantic(geminiResponse([{
    kind: 'NARRATIVE', value: 'Synthetic statement', evidenceId: 'web-page-1', quote: visibleQuote, assertion: 'SOURCE_STATES',
  }]), packet, MINT, source);
  assert.equal(visible.status, 'CANDIDATE');
  assert.equal(visible.claims[0]?.quote, visibleQuote);
  const hidden = parseGeminiSemantic(geminiResponse([{
    kind: 'NARRATIVE', value: 'Synthetic statement', evidenceId: 'web-page-1', quote: hiddenQuote, assertion: 'SOURCE_STATES',
  }]), packet, MINT, source);
  assert.equal(hidden.status, 'INVALID');
  assert.deepEqual(hidden.validationErrors, ['UNSUPPORTED_CITATION']);

  const tailOnlyMintText = visibleQuote + '\n' + 'x'.repeat(6000) + '\n' + MINT;
  const submittedText = tailOnlyMintText.slice(0, 6000);
  assert.equal(submittedText.includes(MINT), false);
  const tailMint = parseGeminiSemantic(
    geminiResponse([{ kind: 'NARRATIVE', value: 'Synthetic statement', evidenceId: 'web-page-1', quote: visibleQuote, assertion: 'SOURCE_STATES' }]),
    JSON.stringify({ sources: [{ id: 'web-page-1', text: submittedText }] }),
    MINT,
    [{ id: 'web-page-1', text: submittedText }],
  );
  assert.equal(tailMint.status, 'INVALID');
  assert.deepEqual(tailMint.validationErrors, ['UNSUPPORTED_CITATION']);
});

test('thirty exact-mint DEX pairs stay visibly truncated at twenty retained', async () => {
  const mock = mockedFetch({ dexValue: Array.from({ length: 30 }, (_, index) => pair(index)) });
  const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
  assert.equal(result.market?.reportedPairCount, 30);
  assert.equal(result.market?.retainedPairCount, 20);
  assert.equal(result.market?.pairs.length, 20);
  assert.equal(result.market?.truncated, true);
  assert.deepEqual(result.collection.dex, { state: 'TRUNCATED', count: 20 });
});

test('legacy Gemini parser accepts exact source claims and rejects malformed model output', () => {
  const pageText = `Mint ${MINT}: the project describes itself as a community token.`;
  const supportedClaim = { kind: 'NARRATIVE', value: 'Community token', evidenceId: 'web-page-1', quote: 'a community token', assertion: 'SOURCE_STATES' };
  const packet = JSON.stringify({ sources: [{ id: 'web-page-1', text: pageText }] });
  const sources = [{ id: 'web-page-1', text: pageText }];
  const candidate = parseGeminiSemantic(geminiResponse([supportedClaim]), packet, MINT, sources);
  assert.equal(candidate.status, 'CANDIDATE');
  assert.equal(candidate.claims.length, 1);

  const unsupported = parseGeminiSemantic(geminiResponse([{ ...supportedClaim, quote: 'the project is legitimate' }]), packet, MINT, sources);
  assert.equal(unsupported.status, 'INVALID');
  assert.deepEqual(unsupported.validationErrors, ['UNSUPPORTED_CITATION']);
  const missingId = parseGeminiSemantic(geminiResponse([{ ...supportedClaim, evidenceId: 'unfetched-source' }]), packet, MINT, sources);
  assert.equal(missingId.status, 'INVALID');
  assert.deepEqual(missingId.validationErrors, ['UNSUPPORTED_CITATION']);
  assert.equal(parseGeminiSemantic(geminiResponse([], 'MAX_TOKENS'), packet, MINT, sources).status, 'INVALID');
  const blocked = parseGeminiSemantic({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }, packet, MINT, sources);
  assert.equal(blocked.status, 'INVALID');
  assert.deepEqual(blocked.validationErrors, ['BLOCKED']);
});

test('full Solana discovery seeds only exact-base DEX links and qualifies linked source posts through both model passes', { todo: 'FULL baseline before cycle B; resolve in --full move' }, async () => {
  const siteSeed = 'https://official.example/project';
  const profileSeed = 'https://x.com/community';
  const whitepaper = 'https://official.example/whitepaper/overview';
  const linkedPost = 'https://x.com/community/status/601';
  const searchPage = 'https://public.example/search-page';
  const searchPost = 'https://x.com/search_author/status/501';
  const quoteOnlyLink = 'https://quote-only.example/project';
  const unrelatedChainLink = 'https://foreign.example/project';
  const wrongAccountPost = 'https://x.com/other_account/status/602';
  const text = new Map<string, string>([
    [siteSeed, `Mint ${MINT}: the project describes its River Lantern neighborhood art community.`],
    [profileSeed, `Project account for ${MINT}; neighbors share ongoing River Lantern artwork.`],
    [whitepaper, `Mint ${MINT}: the project mechanism funds shared community artwork.`],
    [linkedPost, `Mint ${MINT}: neighbors share an original River Lantern community art update.`],
    [searchPage, `Mint ${MINT}: the bounded search sample includes a public project mention.`],
    [searchPost, `Mint ${MINT}: price and chart volume update only.`],
  ]);
  // This fixture covers DEX-seeded source acquisition; omit a usable name so it stays outside comparison-ledger qualification.
  const exactBase = pair(0, { baseToken: { address: MINT, name: '' }, info: {
    websites: [{ url: siteSeed }], socials: [{ url: profileSeed }],
  } });
  const quoteOnly = pair(1, { info: {
    websites: [{ url: quoteOnlyLink }], socials: [],
  } });
  const unrelatedChain = pair(2, { chainId: 'ethereum', info: {
    websites: [{ url: unrelatedChainLink }], socials: [],
  } });
  const mock = mockedFetch({
    dexValue: [exactBase, quoteOnly, unrelatedChain],
    searchValue: { results: [{ url: searchPage }, { url: searchPost }] },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({
      url, final_url: url, text: text.get(url) ?? `Mint ${MINT}: retained exact-token source for ${url}.`,
      ...(url.includes('/status/') ? { published_date: '2026-09-29T10:00:00Z' } : {}),
      ...(url === siteSeed ? { links: [whitepaper, 'https://elsewhere.example/docs/guide'] } : {}),
      ...(url === profileSeed ? { links: [linkedPost, wrongAccountPost] } : {}),
    })), errors: [] }),
    attentionResponse: (packet, call) => {
      if (isSocialModelPacket(packet)) {
        return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'This fixture deliberately returns the attention schema to the social proposal pass.' } });
      }
      const typedPacket = packet as AttentionPacket;
      const value = packet.proposal
        ? { decisions: Object.fromEntries((typedPacket.requiredDecisionIds as string[]).map(id => [id, {
          accepted: true, rationale: 'The exact source span supports this synthetic live integration label.',
        }])),
          candidateSet: { complete: false, rationale: 'The synthetic source packet does not claim complete representation coverage.' },
          originRelationship: {
            status: 'UNKNOWN', citations: [],
            rationale: 'The synthetic source packet has no accepted A03 claim linked to a dated project post.',
          },
        }
        : {
          claims: [{ id: 'community-narrative', feature: 'A01', value: true,
            summary: 'The source describes a River Lantern community art project.',
            citations: [{ sourceId: attentionSourceId(packet, 'describes its River Lantern'), spanId: attentionSpanId(packet, attentionSourceId(packet, 'describes its River Lantern'), 'describes its River Lantern') }] }],
          posts: Object.fromEntries((typedPacket.requiredPostSourceIds as string[]).map(sourceId => {
            const source = typedPacket.sources.find(item => item.id === sourceId)!;
            const priceOnly = source.spans.some(span => span.text.includes('price and chart volume update only'));
            return [sourceId, { spanId: attentionSpanId(packet, sourceId, 'Mint ' + MINT), role: priceOnly ? 'PRICE_ONLY' : 'NEWS' }];
          })),
          competitors: [],
        };
      assert.ok(call === 1 || call === 2);
      return attentionEnvelope(value);
    },
  });

  const result = await collectLiveSolana(token, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const providerCalls = assertSocialProviderCallsAreSeparated(mock, result.rawArtifacts);
  assert.deepEqual(providerCalls, { attentionSearchCount: 2, socialSearchCount: 1, attentionFetchCount: 2, socialFetchCount: 1 }, 'social Search uses only the required query when the bounded context plan is already full');
  const fetchCalls = mock.calls.filter(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.equal(fetchCalls.length, 3, 'the social acquisition adds one bounded Fetch batch after the two attention batches');
  const fetchBatches = fetchCalls.map(call => (JSON.parse(String(call.init?.body)) as { urls: string[]; links: boolean }).urls);
  assert.deepEqual(fetchBatches[0], [siteSeed, profileSeed, searchPage, searchPost], 'exact-base DEX links lead the search URLs');
  assert.deepEqual(fetchBatches[1], [whitepaper, linkedPost], 'only same-host project docs and same-account direct posts are expanded');
  assert.ok(fetchCalls.every(call => (JSON.parse(String(call.init?.body)) as { links?: boolean }).links === true));
  const flattened = fetchBatches.flat();
  assert.equal(flattened.includes(quoteOnlyLink), false, 'a quote-side DEX token does not contribute project links');
  assert.equal(flattened.includes(unrelatedChainLink), false, 'another chain does not contribute project links');
  assert.equal(flattened.includes(wrongAccountPost), false, 'a seeded account cannot expand to another account');

  assert.deepEqual(result.collection.web, { state: 'OBSERVED', count: 6 });
  const criterionPackets = mock.geminiPackets.filter(packet => packet.method === criterionReviewMethod);
  const socialPackets = mock.geminiPackets.filter(isSocialModelPacket);
  assert.deepEqual(criterionPackets.map(packet => packet.stage), ['draft', 'final'],
    'the fresh route uses its independent criterion pair rather than the legacy Attention proposal/review');
  assert.equal(socialPackets.length, 2, 'the fresh Social stage rejects the intentionally attention-shaped fixture and makes its bounded schema-repair request');
  assert.equal(socialPackets[1]?.schemaRepair, 'strict-draft-schema-v1');
  assertInvalidSocialProposal(result.rawArtifacts);

  const input = JSON.parse(result.rawArtifacts['criterion-input']!) as {
    sources: Array<{ id: string; url: string; text: string; discoveredFrom?: string }>;
    sourceBindings: Array<{ sourceId: string; producerArtifactId: string; resultIndex: number }>;
  };
  const source = (url: string) => {
    const row = input.sources.find(candidate => candidate.url === url);
    assert.ok(row, 'the code-owned criterion input retains ' + url);
    return row;
  };
  assert.deepEqual([source(siteSeed).discoveredFrom, source(profileSeed).discoveredFrom], [undefined, undefined]);
  assert.equal(source(whitepaper).discoveredFrom, siteSeed,
    'same-host project documentation keeps the DEX-rooted parent that selected it');
  assert.equal(source(linkedPost).discoveredFrom, profileSeed,
    'the exact-account original post keeps the DEX-rooted profile parent that selected it');
  assert.equal(source(siteSeed).text, text.get(siteSeed));
  assert.equal(source(profileSeed).text, text.get(profileSeed));
  assert.equal(source(whitepaper).text, text.get(whitepaper));
  assert.equal(source(linkedPost).text, text.get(linkedPost));
  for (const url of [siteSeed, profileSeed, whitepaper, linkedPost]) {
    const row = source(url);
    assert.ok(input.sourceBindings.some(binding => binding.sourceId === row.id),
      'the retained source is bound to its producer operation: ' + url);
  }
  assert.equal(JSON.stringify(result).includes(TINYFISH_KEY), false);
  assert.equal(JSON.stringify(result).includes(GEMINI_KEY), false);
  assert.equal(result.semantic.status, 'NOT_REQUESTED');
  assert.ok(result.details?.criteria?.results.every(row => row.evaluationState === 'UNAVAILABLE' && row.outcome === null),
    'the fixture does not fabricate fresh criterion judgments');
  const verifier = new Service(':memory:');
  try {
    const saved = verifier.analyzeLive(result);
    const report = buildEntryReport(saved);
    assert.ok(result.details?.criteria?.results.every(row =>
      report.checks.find(check => check.checkId === row.criterionId)?.outcome === 'UNKNOWN'));
    assert.equal(verifier.replay(saved.id).hash, saved.hash,
      'the exact-base acquisition and its independent Social failure remain replayable');
  } finally { verifier.close(); }
});
test('criterion post facts retain full bodies and code-owned dates while unavailable classification stays unknown', { todo: 'FULL baseline before cycle B; resolve in --full move' }, async () => {
  const longText = 'Mint ' + MINT + ': an original neighborhood art community update. ' + 'x'.repeat(8_100);
  const cases = [
    { name: 'dated before-window post', publishedDate: '2026-09-27T10:00:00Z', expectedWindow: 'NOT_CURRENT' },
    { name: 'full-text in-window post', publishedDate: '2026-09-29T10:00:00Z', expectedWindow: 'CURRENT' },
    { name: 'missing post date', publishedDate: undefined, expectedWindow: 'UNKNOWN' },
  ] as const;

  for (const scenario of cases) {
    const postUrl = 'https://x.com/river_lantern/status/991';
    const mock = mockedFetch({
      dexValue: [pair(0, { baseToken: { address: MINT, name: '' }, info: { websites: [], socials: [] } })],
      searchValue: () => ({ results: [{ url: postUrl, title: 'Original community update', snippet: 'Mint ' + MINT }] }),
      fetchValue: (urls: string[]) => ({ results: urls.map(url => ({
        url, final_url: url, text: longText, ...(scenario.publishedDate ? { published_date: scenario.publishedDate } : {}),
      })), errors: [] }),
    });

    const bundle = await collectLiveSolana(token, liveOptions(mock.fetcher, {
      tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
    }));
    const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as Parameters<typeof criterionPostFacts>[0];
    const source = input.sources.find(row => row.url === postUrl);
    assert.ok(source, 'the original post body is part of the current criterion input');
    assert.equal(source.text, longText, scenario.name + ' retains every acquired character');
    assert.ok(source.text.length > 6_000);
    const fact = criterionPostFacts(input).find(row => row.sourceId === source.id);
    assert.ok(fact, 'the code-owned post facts include this exact source ID');
    assert.equal(fact.exactBodyHash, sha256(longText));
    assert.equal(fact.publishedAt, scenario.publishedDate ? new Date(scenario.publishedDate).toISOString() : null);
    assert.equal(fact.authorId, 'x.com:river_lantern');
    if (scenario.expectedWindow === 'UNKNOWN') {
      assert.equal(fact.window, 'UNKNOWN');
      assert.ok(fact.exclusionReasons.includes('PUBLICATION_TIME_UNKNOWN'));
    } else if (scenario.expectedWindow === 'NOT_CURRENT') {
      assert.notEqual(fact.window, 'CURRENT', 'a pre-window publication cannot be counted in the current interval');
      assert.ok(fact.exclusionReasons.includes('OUTSIDE_WINDOW') || fact.window === 'PREVIOUS');
    } else {
      assert.equal(fact.window, 'CURRENT');
      assert.ok(!fact.exclusionReasons.includes('OUTSIDE_WINDOW'));
    }

    const criterionPackets = mock.geminiPackets.filter(packet => packet.method === criterionReviewMethod);
    assert.deepEqual(criterionPackets.map(packet => packet.stage), ['draft', 'final']);
    const draft = criterionPackets.find(packet => packet.stage === 'draft');
    assert.ok(draft);
    assert.deepEqual(draft.postFacts, criterionPostFacts(input),
      'the model packet includes code-owned publication time and exact body hashes');
    const finalEnvelope = JSON.parse(bundle.rawArtifacts['criterion-final-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const finalValue = JSON.parse(finalEnvelope.candidates[0]!.content.parts[0]!.text);
    const diagnostics = criterionDiagnostics(input, finalValue) as { rows: Record<string, { measurement: { posts: number; authors: number; complete: boolean; issues: string[] } }> };
    assert.equal(diagnostics.rows['ADV-03']?.measurement.posts, 0,
      'an unavailable model classification cannot manufacture a qualified-post count');
    assert.equal(diagnostics.rows['ADV-03']?.measurement.authors, 0);
    assert.equal(diagnostics.rows['ADV-03']?.measurement.complete, false);
    assert.ok(diagnostics.rows['ADV-03']?.measurement.issues.includes('POST_CLASSIFICATION_INCOMPLETE'));
    assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
    const service = new Service(':memory:');
    try {
      const saved = service.analyzeLive(bundle);
      assert.equal(buildEntryReport(saved).checks.find(row => row.checkId === 'ADV-03')?.outcome, 'UNKNOWN');
    } finally { service.close(); }
  }
});
test('fresh criterion review receives the full acquired body without a factual-summary pass', { todo: 'FULL baseline before cycle B; resolve in --full move' }, async () => {
  const target = { chain: 'base', address: '0x' + 'a' + '1'.repeat(39) } as const;
  const rival = '0x2222222222222222222222222222222222222222';
  const postUrl = 'https://x.com/river_lantern/status/901';
  const targetLead = 'The River Lantern neighborhood-art project represents exact contract ' + target.address + '.';
  const rivalTail = ' A distinct River Lantern neighborhood-art project is represented by exact contract ' + rival + '.';
  const comparisonText = targetLead + 'x'.repeat(15_100 - targetLead.length) + rivalTail
    + 'z'.repeat(16_166 - 15_100 - rivalTail.length);
  assert.equal(comparisonText.length, 16_166);
  assert.ok(comparisonText.indexOf(rival) > 15_100);

  let legacyAttentionCalls = 0;
  const mock = mockedFetch({
    dexValue: [{ chainId: 'base', pairAddress: 'comparisonFixturePair', baseToken: { address: target.address, name: 'River Lantern' }, quoteToken: { address: '0x3333333333333333333333333333333333333333' } }],
    searchValue: requestUrl => {
      const query = new URL(requestUrl).searchParams.get('query') ?? '';
      return { results: query.includes('River Lantern') || query.toLowerCase().includes(target.address.toLowerCase())
        ? [{ url: postUrl, title: 'River Lantern exact-contract source', snippet: 'The post names exact contract ' + target.address + '.' }]
        : [] };
    },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({
      url, final_url: url, text: comparisonText, published_date: '2026-09-29T10:00:00Z',
    })), errors: [] }),
    attentionResponse: packet => {
      if (isSocialModelPacket(packet)) return attentionEnvelope({
        decisions: {}, candidateSet: { complete: false, rationale: 'This fixture leaves optional Social review unresolved.' },
      });
      legacyAttentionCalls++;
      return attentionEnvelope({});
    },
  });

  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as Parameters<typeof criterionPostFacts>[0];
  const source = input.sources.find(item => item.url === postUrl);
  assert.ok(source, 'the complete original page is retained in code-owned criterion input');
  assert.equal(source.text, comparisonText);
  assert.equal(bundle.rawArtifacts[source.id], comparisonText);
  assert.equal(source.publishedAt, '2026-09-29T10:00:00.000Z');
  assert.equal(legacyAttentionCalls, 0, 'fresh marked full runs dispatch no legacy factual/public-support recipe');

  const packets = mock.geminiPackets.filter(packet => packet.method === criterionReviewMethod);
  assert.deepEqual(packets.map(packet => packet.stage), ['draft', 'final']);
  assert.ok(packets.every(packet => !Object.hasOwn(packet, 'claimView')),
    'the independent criterion packets carry criteria, not the old factual claim-view pass');
  const finalPacket = packets.find(packet => packet.stage === 'final');
  assert.ok(finalPacket);
  const projected = finalPacket.input as { catalog: Array<{ id: string; sourceId: string; start: number; text: string }> };
  const rivalTailRow = projected.catalog.find(row => row.sourceId === source.id && row.text.includes(rival));
  assert.ok(rivalTailRow, 'the model packet includes the exact rival mint retained after character 15,100');
  assert.equal(rivalTailRow.start + rivalTailRow.text.indexOf(rival), comparisonText.indexOf(rival),
    'the tail citation preserves the exact original source offset even when its span begins earlier');
  assert.ok(finalPacket.postFacts instanceof Array);
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
  assert.deepEqual(bundle.semantic.claims, []);
  assert.ok(bundle.details?.criteria?.results.every(row => row.evaluationState === 'UNAVAILABLE' && row.outcome === null),
    'the mock does not convert the retained body into model-owned judgments');
});
test('fresh entry-first lead recovery preserves each parent lineage through Service replay', { todo: 'FULL baseline before cycle B; resolve in --full move' }, async () => {
  const target = { chain: 'solana', address: MINT } as const;
  const alternate = { chain: 'solana', address: OTHER_MINT } as const;
  const targetUrl = 'https://public.example/river-lantern';
  const failedUrl = 'https://index.example/ava';
  const unrelatedUrl = 'https://index.example/lunar-cat';
  const alternateUrl = 'https://projects.example/avaai-contract';
  const unavailableAlternateUrl = 'https://retired.example/avaai-project';
  const unrelatedEvidenceUrl = 'https://encyclopedia.example/lunar-cat';
  const footerUrl = 'https://www.youtube.com/about';
  const targetText = `The River Lantern project represents exact contract ${target.address}. Its community shares a neighborhood story.`;
  const alternateText = `AVAAI represents the indexed digital-parasite project under exact contract ${alternate.address}; this is a separate Solana representation.`;
  const unrelatedEvidenceText = 'Lunar Cat is an illustrated pink-eyed feline art collective on Solana, centered on pink-eyed cat collectibles and community illustration rather than a digital-parasite mechanism.';
  const footerText = 'About Press Copyright Contact us Creators Advertise Developers Terms Privacy Policy.';
  let clockMs = Date.parse('2026-10-06T12:00:00.000Z');
  const fakeNow = () => new Date(clockMs).toISOString();
  let attentionModelCalls = 0;
  const mock = mockedFetch({
    dexValue: (dexCall: number) => [pair(0, { baseToken: { address: target.address, name: 'River Lantern' }, priceUsd: dexCall === 0 ? '0.001' : '0.002' })],
    searchValue: requestUrl => {
      const query = new URL(requestUrl).searchParams.get('query') ?? '';
      if (query.includes('(site:x.com OR site:twitter.com)')) return { results: [] };
      if (query.includes('"River Lantern"')) return { results: [
        { url: targetUrl, title: 'River Lantern exact target project', snippet: `Project contract ${target.address}.` },
        { url: failedUrl, title: 'AVA AI digital parasite project', snippet: 'The indexed project describes a digital-parasite mechanism.' },
        { url: unrelatedUrl, title: 'Lunar Cat pink-eyed feline art project', snippet: 'A Solana art project centered on illustrated pink-eyed cats and collectible artwork.' },
      ] };
      if (query.includes(`"${target.address}"`)) return { results: [{ url: targetUrl }] };
      if (query.includes('Lunar Cat')) return { results: [
        { url: unrelatedEvidenceUrl, title: 'Lunar Cat is a feline art collective', snippet: 'A Solana art project centered on pink-eyed cat collectibles, not a digital-parasite mechanism.' },
        { url: footerUrl, title: 'YouTube About', snippet: 'About Press Copyright Contact us Creators Advertise Developers Terms Privacy Policy' },
      ] };
       return { results: [{
         url: alternateUrl, title: 'AVAAI exact contract project page',
         snippet: 'This page connects the indexed AVAAI digital-parasite project to its deployed contract.',
       }, {
         url: unavailableAlternateUrl, title: 'Retired AVAAI project page',
         snippet: 'An indexed alternate that returns an explicit permanent page response.',
       }] };
    },
    fetchValue: (urls: string[]) => urls.some(url => url === failedUrl || url === unrelatedUrl)
      ? {
        results: urls.filter(url => url === targetUrl).map(url => ({ url, final_url: url, text: targetText })),
        errors: urls.filter(url => url === failedUrl || url === unrelatedUrl).map(url => ({ url, status: 404, error: 'not_found' })),
      }
       : { results: urls.filter(url => url !== unavailableAlternateUrl).map((url: string) => ({ url, final_url: url,
         text: url === alternateUrl ? alternateText : url === unrelatedEvidenceUrl ? unrelatedEvidenceText : url === footerUrl ? footerText : 'A retained public project page.' })),
         errors: urls.filter(url => url === unavailableAlternateUrl).map(url => ({ url, status: 410, error: 'page_not_found' })) },
    useCitedClaimReviewCallback: true,
    attentionResponse: packet => {
      attentionModelCalls++;
      clockMs += 61_000;
      const typed = packet as AttentionPacket;
      const scope = packet.scope as Record<string, unknown> | undefined;
      const freshResponse = freshComparisonResponse(packet, target);
      if (freshResponse) return freshResponse;
      if (packet.originalProposal && packet.originalReview && Array.isArray(packet.sources)) {
        const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string }> }>;
        const first = sources.flatMap(source => source.spans.map(span => ({ sourceId: source.id, spanId: span.id })))[0];
        assert.ok(first, 'the complete narrative-support review has at least one selectable retained source span');
        const rationale = 'This fixture leaves narrative sufficiency unresolved after inspecting the complete offered source catalog.';
        if (packet.proposal) return attentionEnvelope({
          sourceDecisions: Object.fromEntries(sources.map(source => [source.id, {
            accepted: true, inspectionComplete: true,
            rationale: 'The independent fixture review inspected every span in this source.',
          }])),
          decisions: {
            NARRATIVE_DESCRIPTION: { accepted: true, rationale },
            EXPLAINABLE_THESIS: { accepted: true, rationale },
          },
        });
        const cite = (sourceId: string) => ({ sourceId, spanId: sources.find(source => source.id === sourceId)!.spans[0]!.id });
        return attentionEnvelope({
          sourceSupport: Object.fromEntries(sources.map(source => [source.id, {
            status: 'UNRESOLVED', criteria: [], rationale,
            citations: source.spans.length ? [cite(source.id)] : [],
          }])),
          judgments: {
            NARRATIVE_DESCRIPTION: { verdict: 'UNRESOLVED', rationale, citations: [first] },
            EXPLAINABLE_THESIS: { verdict: 'UNRESOLVED', rationale, citations: [first] },
          },
        });
      }
      if (packet.claimView) return citedClaimReviewFixture(packet);
      if (packet.method === 'binary-public-support-v5') return citedV5EntryFixture(packet, target);
      if (packet.manifest) {
        const leadScopeReviews = publicLeadScopeReviews(packet);
        return attentionEnvelope({
          ...(packet.supportProposal ? { supportReview: { accepted: true, rationale: 'The final review checks the scoped public-support proposal and its exact source citations.' } } : {}),
          ...(leadScopeReviews ? { leadScopeReviews } : {}),
          decisions: Object.fromEntries((packet.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The chain-qualified contracts remain bound to reviewed source observations.',
          }])),
          candidateSet: { complete: true, rationale: 'The target and every positively recovered representation are present in the reviewed merge.' },
        });
      }
      if (Array.isArray(packet.requiredLeadIds) && Array.isArray(packet.requiredSourceIds) && Array.isArray(packet.requiredBatchIds)) {
        const catalog = packet.sources as Array<{ sourceId: string; spans: Array<{ id: string; text: string }> }>;
        const cited = catalog.flatMap(source => source.spans.map(span => ({ sourceId: source.sourceId, ...span })))[0];
        assert.ok(cited, 'the global grade can cite one exact retained source span');
        return attentionEnvelope({ verdict: 'UNRESOLVED', rationale: 'This fixture does not assert a complete public-support deficiency.',
          citations: [{ sourceId: cited.sourceId, spanId: cited.id },], ...comparisonGradeIdFields(packet),
          ...((packet.leadQualification as { supportScopeMethod?: string } | undefined)?.supportScopeMethod === 'comparison-lead-support-scope-v2'
            ? { leadScopes: publicLeadScopes(packet) } : {}) });
      }
      if (typeof scope?.batch === 'number') {
        if (packet.proposal) {
          const comparisonReview = comparisonReviewFields(packet);
          const sourceDecisions = comparisonReview.sourceDecisions as Record<string, { disposition: string; insufficiencyKind: string; rationale: string }>;
          for (const source of typed.sources) {
            if (source.spans.some(span => span.text.includes('About Press Copyright'))) {
              sourceDecisions[source.id] = {
                disposition: 'INSUFFICIENT', insufficiencyKind: 'NO_SUBSTANTIVE_CONTENT',
                rationale: 'The retained YouTube footer contains no substantive project evidence.',
              };
            } else if (source.spans.some(span => span.text.includes('pink-eyed cat collectibles'))) {
              sourceDecisions[source.id] = {
                disposition: 'CONTEXT', insufficiencyKind: 'NONE',
                rationale: 'This retained page positively describes the independently indexed feline art subject.',
              };
            }
          }
          const supportDecisions = comparisonReview.supportDecisions as Record<string, { accepted: boolean; rationale: string }>;
          for (const source of typed.sources) {
            if (source.spans.some(span => span.text.includes('About Press Copyright'))) {
              comparisonReview.sourceDecisions[source.id] = {
                disposition: 'INSUFFICIENT', insufficiencyKind: 'NO_SUBSTANTIVE_CONTENT', inspectionComplete: true,
                rationale: 'The retained YouTube footer contains no substantive project evidence.',
              };
              supportDecisions[source.id] = { accepted: true, rationale: 'The full footer is correctly treated as non-substantive context.' };
            } else if (source.spans.some(span => span.text.includes('pink-eyed cat collectibles'))) {
              comparisonReview.sourceDecisions[source.id] = {
                disposition: 'CONTEXT', insufficiencyKind: 'NONE', inspectionComplete: true,
                rationale: 'This retained page positively describes a distinct indexed feline art subject.',
              };
              supportDecisions[source.id] = { accepted: true, rationale: 'The independent review accepts this unrelated context classification.' };
            } else if (!source.spans.some(span => span.text.includes(target.address) && span.text.includes('River Lantern'))) {
              comparisonReview.sourceDecisions[source.id] = {
                disposition: 'CONTEXT', insufficiencyKind: 'NONE', inspectionComplete: true,
                rationale: 'This full source describes a different indexed project, so it is audited as context rather than a target representation.',
              };
              supportDecisions[source.id] = { accepted: true, rationale: 'The independent review accepts this distinct-project context classification.' };
            }
          }
          return attentionEnvelope({
          decisions: Object.fromEntries((packet.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The exact source span supports this reviewed comparison item.',
          }])),
          candidateSet: { complete: true, rationale: 'Every relevant exact-contract observation in the retained batch is included.' },
          ...comparisonReview,
          });
        }
        const competitors = [] as Array<{ id: string; observationId: string }>;
        if (typed.sources.some(source => source.spans.some(span => span.text.includes(target.address)))) {
          const sourceId = attentionSourceId(packet, target.address);
          competitors.push({ id: 'target-recovered-review', observationId: attentionObservationId(packet, target, sourceId) });
        }
        const leadScope = scope.leadQualification as { leads?: Array<{ id?: string; leadId?: string; sourceIds?: string[]; recoverySourceIds?: string[] }> } | undefined;
        const sourceSupport = Object.fromEntries(typed.sources.map(source => {
          const targetSpan = source.spans.find(span => span.text.includes(target.address) && span.text.includes('River Lantern'));
          const leadIds = (leadScope?.leads ?? []).filter(lead => [...(lead.sourceIds ?? []), ...(lead.recoverySourceIds ?? [])].includes(source.id))
            .map(lead => lead.id ?? lead.leadId).filter((id): id is string => typeof id === 'string');
          return [source.id, targetSpan
            ? { status: 'BINDING_EVIDENCE', rationale: 'This retained page connects the River Lantern narrative with its literal token.', citations: [{ sourceId: source.id, spanId: targetSpan.id }], leadIds }
            : { status: 'CONTEXT_ONLY', rationale: 'This retained page documents a distinct indexed subject or non-narrative context.', citations: [], leadIds }];
        }));
        return attentionEnvelope({ competitors, posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => {
          const span = attentionSpanId(packet, id, target.address);
          return [id, { spanId: span, role: 'NEWS' }];
        })), sourceSupport });
      }
      if (packet.selectedLeadIds) {
        const selected = packet.leads as Array<{ id: string; metadataEvidenceId: string }>;
        const metadata = packet.metadata as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        return attentionEnvelope({ leads: Object.fromEntries(selected.map(lead => {
          const source = metadata.find(item => item.id === lead.metadataEvidenceId);
          assert.ok(source, `V2 recovery plan includes own descriptor ${lead.metadataEvidenceId}`);
          const descriptorTerm = lead.id === 'comparison-lead-3' ? 'pink-eyed feline art' : 'digital parasite';
          const descriptor = source.spans.find(span => span.text.includes(descriptorTerm));
          assert.ok(descriptor, `V2 recovery plan receives the ${lead.id} lead descriptor`);
          const isUnrelated = lead.id === 'comparison-lead-3';
          return [lead.id, {
            queries: [isUnrelated
              ? 'Find Lunar Cat pink-eyed feline art subject and its distinctive Solana project description'
              : 'Find AVAAI digital parasite project original sources and exact contract on Solana'],
            rationale: isUnrelated
              ? 'Find an independent descriptive source for the indexed Lunar Cat art subject.'
              : 'Find independent sources identifying the indexed AVAAI mechanism and its contract.',
            metadataRefs: [{ sourceId: lead.metadataEvidenceId, spanId: descriptor.id }],
          }];
        })) });
      }
      if (scope?.mode === 'qualified-identified-leads-v3' && packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        return attentionEnvelope({ decisions: Object.keys(proposed.decisions).map(leadId => ({ leadId,
          accounting: { accepted: true, rationale: 'The review checks each original indexed entity and acquisition outcome.' },
          representation: { accepted: true, rationale: 'The proposed binding or unrelated subject is supported by its own cited evidence.' },
          subjectComparison: { accepted: true, rationale: 'An unread original stays unresolved while recovered subject evidence is reviewed separately.' },
          evidenceAdequacy: { accepted: true, rationale: 'No failed fetch is used as a negative factual adequacy finding.' },
        })) });
      }
      if (scope?.mode === 'qualified-identified-leads-v3') {
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[]; recoverySourceIds: string[]; acquisitionStatus: string }>;
        const decisions = leads.map(lead => {
          const descriptor = { sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId) };
          const original = typed.sources.find(source => lead.sourceIds.includes(source.id));
          const originalSpan = original?.spans.find(span => span.text.includes(lead.id === 'comparison-lead-3' ? 'pink-eyed' : 'project'));
          if (lead.id === 'comparison-lead-1' && original && originalSpan) {
            const fetched = { sourceId: original.id, spanId: originalSpan.id };
            return { leadId: lead.id,
              accounting: { status: 'ACCOUNTED', basis: 'ORIGINAL_TEXT', role: 'PROJECT_OR_PUBLICATION',
                rationale: 'The original target project page was fetched and its own indexed entity is retained.', descriptorRefs: [descriptor], corroboratingRefs: [fetched] },
              representation: { status: 'BOUND', unresolvedKind: 'NONE', token: target, rationale: 'The original target page binds its literal mint to the River Lantern neighborhood project.', citations: [fetched] },
              subjectComparison: { status: 'CONSISTENT', indexedSubject: 'River Lantern exact target project', currentSubject: 'River Lantern exact target project',
                rationale: 'The original indexed descriptor and fetched target page describe the same subject.', descriptorRefs: [descriptor], fetchedRefs: [fetched] },
              evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'The target page does not establish a factual public-support deficiency.', citations: [descriptor] },
            };
          }
          if (lead.id === 'comparison-lead-2') {
            const recovered = typed.sources.find(source => source.url === alternateUrl && lead.recoverySourceIds.includes(source.id));
            assert.ok(recovered, 'the AVAAI proof is an actually fetched source in this lead recovery lineage');
            const fetched = { sourceId: recovered.id, spanId: attentionSpanId(packet, recovered.id, alternate.address) };
            return { leadId: lead.id,
              accounting: { status: 'ACCOUNTED', basis: 'RECOVERED_ENTITY', role: 'PROJECT_OR_PUBLICATION',
                rationale: 'The indexed AVAAI subject is positively identified by its own different-host recovered project description.',
                descriptorRefs: [descriptor], corroboratingRefs: [fetched] },
              representation: { status: 'UNRELATED', unresolvedKind: 'NONE', token: null,
                rationale: 'The recovered digital-parasite project is distinct from the target neighborhood-art narrative.', citations: [descriptor, fetched] },
              subjectComparison: { status: 'UNRESOLVED', indexedSubject: 'AVAAI digital-parasite project', currentSubject: null,
                rationale: 'The failed original page remains unread; recovery identifies the indexed entity without replacing its original body.', descriptorRefs: [descriptor], fetchedRefs: [] },
              evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'The failed original page does not establish a factual public-support deficiency.', citations: [descriptor] },
            };
          }
          const independent = typed.sources.find(source => source.url === unrelatedEvidenceUrl && lead.recoverySourceIds.includes(source.id));
          assert.ok(independent, 'the different-host Lunar Cat description is retained in its own lead recovery lineage');
          const fetched = { sourceId: independent.id, spanId: attentionSpanId(packet, independent.id, 'pink-eyed cat collectibles') };
          const indexed = { sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId, 'pink-eyed feline art') };
          return { leadId: lead.id,
            accounting: { status: 'ACCOUNTED', basis: 'RECOVERED_ENTITY', role: 'PROJECT_OR_PUBLICATION',
              rationale: 'The lead-specific different-host description corroborates this indexed feline-art entity.', descriptorRefs: [indexed], corroboratingRefs: [fetched] },
            representation: { status: 'UNRELATED', unresolvedKind: 'NONE', token: null,
              rationale: 'The positively described feline-art project is distinct from the neighborhood target narrative.', citations: [indexed, fetched] },
            subjectComparison: { status: 'UNRESOLVED', indexedSubject: 'Lunar Cat pink-eyed feline art project', currentSubject: null,
              rationale: 'The original indexed page was not fetched; the corroborating recovery does not replace its body.', descriptorRefs: [indexed], fetchedRefs: [] },
            evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'An unread original page does not establish a factual adequacy mismatch.', citations: [indexed] },
          };
        });
        return attentionEnvelope({ decisions });
      }
      if (packet.proposal) return attentionEnvelope({
        decisions: Object.fromEntries((typed.requiredDecisionIds as string[]).map(id => [id, {
          accepted: true, rationale: 'The bounded narrative source supports this review item.',
        }])),
        candidateSet: { complete: false, rationale: 'The source prefix cannot establish all retained representations.' },
        originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No dated primary account relationship is established.' },
      });
      const targetSourceId = attentionSourceId(packet, target.address);
      return attentionEnvelope({
        claims: [{ id: 'claim-topic', feature: 'A01', value: true, summary: 'A community neighborhood project narrative.',
          citations: [{ sourceId: targetSourceId, spanId: attentionSpanId(packet, targetSourceId, target.address) }] }],
        posts: {}, competitors: [],
      });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), 'attention-recovery-live-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  try {
    const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
      tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true, now: fakeNow,
    }));
    const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
      read: {
        comparisonAcquisition: { leads: Array<{ id: string; recoveryQueryIds: string[]; recoverySourceIds: string[] }> };
        comparisonRecovery?: {
          selectedLeadIds: string[];
          recoveryQueries: Array<{ parentLeadId: string; queryId: string; descriptorComplete: boolean }>;
          sourceLineage: Array<{ leadId: string; queryIds: string[]; sourceIds: string[] }>;
        };
      };
    };
    const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as {
      sources: Array<{ id: string; url: string; text: string }>;
      sourceBindings: Array<{ sourceId: string; producerArtifactId: string; resultIndex: number }>;
      acquisition: { comparisonRecovery?: typeof receipt.read.comparisonRecovery };
    };
    const recovery = receipt.read.comparisonRecovery;
    assert.ok(recovery, 'the criterion input retains the code-owned per-parent recovery ledger');
    assert.deepEqual(input.acquisition.comparisonRecovery, recovery,
      'the model input is bound to the same immutable recovery lineage as the qualified source read');
    assert.ok(recovery.selectedLeadIds.length > 0);
    assert.ok(recovery.recoveryQueries.every(query => recovery.selectedLeadIds.includes(query.parentLeadId)),
      'each recovery query names its own selected parent lead');
    for (const lineage of recovery.sourceLineage) {
      const lead = receipt.read.comparisonAcquisition.leads.find(item => item.id === lineage.leadId);
      assert.ok(lead, 'the lineage resolves to its original indexed lead');
      assert.deepEqual(lead.recoveryQueryIds, lineage.queryIds,
        'the recovery ledger preserves each parent’s complete original and follow-up query IDs');
      assert.deepEqual(lead.recoverySourceIds, lineage.sourceIds,
        'a recovery body cannot be transferred from a sibling indexed subject');
      for (const id of lineage.queryIds) {
        const matchedQuery: typeof recovery.recoveryQueries[number] | undefined = recovery.recoveryQueries.find(item => item.queryId === id);
        if (matchedQuery) assert.equal(matchedQuery.parentLeadId, lineage.leadId);
        else assert.ok(bundle.rawArtifacts[id], 'a parent-scoped prior recovery query remains in the immutable artifact catalog');
      }
      for (const sourceId of lineage.sourceIds) {
        const source = input.sources.find(item => item.id === sourceId);
        const binding = input.sourceBindings.find(item => item.sourceId === sourceId);
        assert.ok(source && binding, 'every recovered body retains its source and producing request binding');
        const producer = JSON.parse(bundle.rawArtifacts[binding.producerArtifactId]!) as {
          results: Array<{ url: string; final_url?: string; text: string }>;
        };
        const result = producer.results[binding.resultIndex];
        assert.ok(result);
        assert.equal(result.url, source.url);
        assert.equal(result.text, source.text, 'the parent-scoped recovered text matches the original provider body');
      }
    }
    assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
    assert.equal(bundle.rawArtifacts['attention-proposal-prompt'], undefined);
    assert.equal(bundle.rawArtifacts['attention-review-prompt'], undefined);
    assert.deepEqual(mock.geminiPackets.filter(packet => packet.method === criterionReviewMethod).map(packet => packet.stage), ['draft', 'final']);

    const saved = service.analyzeLive(bundle);
    assert.deepEqual(service.replay(saved.id), saved, 'the recovered parent lineage survives Service admission and offline replay');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('failed criterion transport remains unavailable and replayable without inventing a final request', async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const postUrl = 'https://x.com/river_lantern/status/902';
  const text = 'The River Lantern project represents exact contract ' + target.address + ' and its neighborhood-art community.';
  const mock = mockedFetch({
    dexValue: [{ chainId: 'base', pairAddress: 'partialFailurePair', baseToken: { address: target.address, name: 'River Lantern' }, quoteToken: { address: '0x3333333333333333333333333333333333333333' } }],
    searchValue: () => ({ results: [{ url: postUrl, title: 'River Lantern exact-contract post', snippet: text }] }),
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({ url, final_url: url, text, published_date: '2026-09-29T10:00:00Z' })), errors: [] }),
    criterionResponse: () => { throw new TypeError('fixture criterion provider transport failure'); },
  });
  const directory = mkdtempSync(join(tmpdir(), 'criterion-provider-failure-'));
  const database = join(directory, 'partial.sqlite');
  try {
    const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
      tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
      runtime: { nowMs: Date.now, timeout: AbortSignal.timeout, wait: async () => {} },
    }));
    const failure = JSON.parse(bundle.rawArtifacts['criterion-failure']!) as { stage: string; code: string };
    assert.equal(failure.stage, 'draft');
    assert.match(failure.code, /^CRITERION_MODEL_/);
    assert.ok(mock.geminiPackets.some(packet => packet.method === criterionReviewMethod && packet.stage === 'draft'));
    assert.equal(mock.geminiPackets.some(packet => packet.method === criterionReviewMethod && packet.stage === 'final'), false,
      'a transport failure before a draft cannot create a final review prompt');
    assert.ok(bundle.rawArtifacts['criterion-draft-prompt']);
    assert.ok(bundle.rawArtifacts['criterion-draft-transport-attempt-1']);
    assert.equal(bundle.rawArtifacts['criterion-draft-response'], undefined);
    assert.equal(bundle.rawArtifacts['criterion-final-prompt'], undefined);
    assert.equal(bundle.rawArtifacts['criterion-final-response'], undefined);
    const receipt = JSON.parse(bundle.rawArtifacts['criterion-receipt']!) as {
      results: Array<{ evaluationState: string; outcome: string | null; failure?: { code: string } | null }>;
    };
    assert.ok(receipt.results.length > 0);
    assert.ok(receipt.results.every(row => row.evaluationState === 'UNAVAILABLE' && row.outcome === null));
    assert.ok(receipt.results.some(row => row.failure?.code === failure.code),
      'the unavailable receipt retains the actual provider failure code');
    assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
    const writer = new Service(database);
    let saved: ReturnType<Service['analyzeLive']>;
    try {
      saved = writer.analyzeLive(bundle);
      assert.equal(saved.semantic?.status, 'NOT_REQUESTED');
      assert.equal(saved.result.classification, 'INSUFFICIENT_DATA');
      assert.ok(buildEntryReport(saved).checks.filter(row => row.checkId.startsWith('NAR-'))
        .every(row => row.outcome === 'UNKNOWN'));
    } finally { writer.close(); }
    const reopened = new Service(database);
    try {
      assert.deepEqual(reopened.replay(saved.id), saved, 'the honest pre-final transport failure survives close, reopen and replay');
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('shared late capture preserves discovery but never uses it when final RPC and DEX reads fail', async () => {
  const target = { chain: 'solana', address: MINT } as const;
  let clockMs = Date.parse('2026-10-06T12:00:00.000Z');
  const mock = mockedFetch({
    rpcStatus: 503,
    dexValue: [pair(0, { baseToken: { address: target.address, name: 'River Lantern' }, priceUsd: '0.001' })],
    dexStatus: (call: number) => call === 0 ? undefined : 503,
  });
  const directory = mkdtempSync(join(tmpdir(), 'late-capture-final-failure-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  try {
    const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
      semanticEnabled: true,
      rpcUrl: RPC_URL,
      now: () => new Date(clockMs += 1_000).toISOString(),
    }));
    const capture = JSON.parse(bundle.rawArtifacts['live-state-capture']!) as {
      method: string; discoveryId: string | null; canonical: Array<{ id: string; retrievedAt: string }>;
      rpcState: string; dexState: string;
    };
    assert.equal(capture.method, 'late-state-capture-v1');
    assert.equal(capture.discoveryId, 'dex-discovery');
    assert.deepEqual(capture.canonical, [], 'failed final reads contribute no canonical state records');
    assert.equal(capture.rpcState, 'UNAVAILABLE');
    assert.equal(capture.dexState, 'UNAVAILABLE');
    assert.ok(bundle.rawArtifacts['dex-discovery'], 'the successful early discovery response remains available as discovery evidence');
    assert.equal(bundle.rawArtifacts['dex-pairs'], undefined);
    assert.equal(bundle.rawArtifacts['rpc-genesis'], undefined);
    assert.equal(bundle.rawArtifacts['rpc-account'], undefined);
    assert.equal(bundle.collection.dex.state, 'UNAVAILABLE');
    assert.equal(bundle.collection.rpc.state, 'UNAVAILABLE');
    assert.equal(bundle.market, null, 'the failed final DEX read does not fall back to the discovery quote');
    assert.equal(bundle.observations.some(item => item.evidenceIds.includes('dex-discovery')), false);
    assert.equal(bundle.features.some(item => item.evidenceIds.includes('dex-discovery')), false);
    const rows = bundle.details?.baseline ?? [];
    assert.notEqual(rows.find(row => row.id === 'O02')?.quality, 'KNOWN');
    assert.notEqual(rows.find(row => row.id === 'O28')?.quality, 'KNOWN');
    assert.ok(rows.every(row => !row.evidenceIds.includes('dex-discovery')),
      'baseline rows cannot turn the discovery response into a final-state witness');

    const saved = service.analyzeLive(bundle);
    assert.deepEqual(service.replay(saved.id), saved, 'the honest unavailable final capture persists and replays offline');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh 33-criterion response reorders code-owned rows, replays, and rejects rehashed tampering', { todo: 'FULL baseline before cycle B; resolve in --full move' }, async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const website = 'https://public.example/river-lantern-project';
  const text = 'Token ' + target.address + '. The River Lantern project tells a neighborhood arts story.';
  const mock = mockedFetch({
    dexValue: [{
      chainId: 'base', pairAddress: 'FreshCriterionFixturePair',
      baseToken: { address: target.address, name: 'River Lantern' },
      quoteToken: { address: '0x3333333333333333333333333333333333333333' },
      info: { websites: [{ url: website }], socials: [] },
    }],
    searchValue: (_url, call) => ({ results: call === 0 ? [{ url: website, title: 'River Lantern project', snippet: text }] : [] }),
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({ url, final_url: url, text })), errors: [] }),
    criterionResponse: packet => {
      const input = packet.input as { scopeId: string; requiredIds: string[] };
      return { rows: [...input.requiredIds].reverse().map(criterionId => ({
        criterionId,
        scopeId: input.scopeId,
        evaluationState: 'UNAVAILABLE',
        outcome: null,
        rationale: 'The independent review fixture does not assert a criterion judgment.',
        citationIds: [],
        proof: {
          inspectionComplete: false,
          inspectedSourceIds: [],
          premises: [],
          representationWitnesses: [],
          posts: [],
          missingSupport: [],
          necessaryUnreadSourceIds: [],
        },
        failure: { category: 'MODEL', code: 'CRITERION_REVIEW_UNAVAILABLE', validationPaths: ['rows.' + criterionId] },
      })) };
    },
  });
  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as {
    requiredIds: string[];
    sources: Array<{ id: string; url: string; text: string }>;
    sourceBindings: Array<{ sourceId: string; producerArtifactId: string }>;
  };
  const source = input.sources.find(item => item.url === website);
  assert.ok(source);
  assert.equal(source.text, text);
  assert.ok(input.sourceBindings.some(binding => binding.sourceId === source.id));
  assert.deepEqual(input.requiredIds, criterionIds, 'the fresh route has exactly the code-owned full criterion set');
  assert.deepEqual(bundle.details?.criteria?.results.map(row => row.criterionId), criterionIds,
    'provider row order does not change the canonical criterion order');
  assert.ok(bundle.details?.criteria?.results.every(row => row.evaluationState === 'UNAVAILABLE' && row.outcome === null),
    'the fixture preserves unreviewed judgments as unavailable');
  assert.deepEqual(mock.geminiPackets.filter(packet => packet.method === criterionReviewMethod).map(packet => packet.stage), ['draft', 'final']);
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
  assert.deepEqual(bundle.semantic.claims, []);

  const directory = mkdtempSync(join(tmpdir(), 'fresh-criterion-replay-'));
  const database = join(directory, 'criterion.sqlite');
  const service = new Service(database);
  let saved: ReturnType<Service['analyzeLive']>;
  try {
    saved = service.analyzeLive(bundle);
    assert.equal(service.replay(saved.id).hash, saved.hash);
  } finally { service.close(); }
  const reopened = new Service(database);
  try {
    assert.deepEqual(reopened.replay(saved.id), saved, 'the canonical result reopens and replays from the retained code-owned proof');
  } finally { reopened.close(); }

  const forgedOutput = structuredClone(bundle);
  const response = JSON.parse(forgedOutput.rawArtifacts['criterion-final-response']!) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  response.candidates[0]!.content.parts[0]!.text += ' ';
  const changedResponse = JSON.stringify(response);
  forgedOutput.rawArtifacts['criterion-final-response'] = changedResponse;
  const responseEvidence = forgedOutput.evidence.find(item => item.id === 'criterion-final-response');
  assert.ok(responseEvidence);
  responseEvidence.contentHash = sha256(changedResponse);
  const responseVerifier = new Service(join(directory, 'forged-response.sqlite'));
  try {
    assert.throws(() => responseVerifier.analyzeLive(forgedOutput), /LIVE_PROVENANCE_INVALID/,
      're-hashing a changed model response cannot detach it from its original provider transport receipt');
  } finally { responseVerifier.close(); }

  const forgedSource = structuredClone(bundle);
  const changedBody = text + ' altered after acquisition';
  forgedSource.rawArtifacts[source.id] = changedBody;
  const sourceEvidence = forgedSource.evidence.find(item => item.id === source.id);
  assert.ok(sourceEvidence);
  sourceEvidence.contentHash = sha256(changedBody);
  const sourceVerifier = new Service(join(directory, 'forged-source.sqlite'));
  try {
    assert.throws(() => sourceVerifier.analyzeLive(forgedSource), /CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID/,
      're-hashing a source cannot change its independently retained producer body');
  } finally {
    sourceVerifier.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('fresh criterion retains linked origin bytes and leaves unreviewed A03 unknown through replay', { todo: 'FULL baseline before cycle B; resolve in --full move' }, async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const website = 'https://public.example/river-lantern-origin';
  const sourceText = 'Token ' + target.address + '. The River Lantern page describes a community project but provides no dated origin or catalyst source.';
  const mock = mockedFetch({
    dexValue: [{
      chainId: 'base', pairAddress: 'FixtureRiverLanternOriginPair',
      baseToken: { address: target.address, name: 'River Lantern', symbol: 'RIVER' },
      quoteToken: { address: '0x3333333333333333333333333333333333333333', name: 'USD Coin', symbol: 'USDC' },
      priceUsd: '0.001', liquidity: { usd: '100000' },
      info: { websites: [{ url: website }], socials: [] },
    }],
    searchValue: { results: [] },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({ url, final_url: url, text: sourceText })), errors: [] }),
  });
  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as {
    sources: Array<{ id: string; url: string; text: string }>;
    sourceBindings: Array<{ sourceId: string; producerArtifactId: string }>;
  };
  const source = input.sources.find(item => item.url === website);
  assert.ok(source, 'the DEX-rooted origin URL contributes an acquired source to the fresh criterion catalog');
  assert.equal(source.text, sourceText);
  assert.ok(input.sourceBindings.some(binding => binding.sourceId === source.id),
    'the exact body remains bound to its producing Fetch operation');
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
  assert.deepEqual(mock.geminiPackets.filter(packet => packet.method === criterionReviewMethod).map(packet => packet.stage), ['draft', 'final']);
  assert.equal(bundle.rawArtifacts['attention-leadership-proposal-prompt'], undefined,
    'the marked full route does not invent a separate legacy public-entry prompt');
  assert.ok(bundle.details?.criteria?.results.every(row => row.evaluationState === 'UNAVAILABLE' && row.outcome === null),
    'the default independent criterion fixture makes no factual or public-entry claim');
  const directory = mkdtempSync(join(tmpdir(), 'criterion-origin-source-proof-'));
  const database = join(directory, 'criterion.sqlite');
  const service = new Service(database);
  let saved: ReturnType<Service['analyzeLive']>;
  try {
    saved = service.analyzeLive(bundle);
    assert.equal(buildEntryReport(saved).checks.find(row => row.checkId === 'NAR-02')?.outcome, 'UNKNOWN',
      'without an actual criterion review, the origin proposition stays unknown');
    assert.deepEqual(service.replay(saved.id), saved);
  } finally { service.close(); }

  const forged = structuredClone(bundle);
  const changed = sourceText + ' altered after acquisition';
  forged.rawArtifacts[source.id] = changed;
  const record = forged.evidence.find(item => item.id === source.id);
  assert.ok(record);
  record.contentHash = sha256(changed);
  const verifier = new Service(join(directory, 'forged-source.sqlite'));
  try {
    assert.throws(() => verifier.analyzeLive(forged), /CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID/,
      're-hashing a changed page cannot detach it from the original provider response');
  } finally {
    verifier.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('blocked exact-token page retains its 403 without inventing a body or reviewed origin result', { todo: 'FULL baseline before cycle B; resolve in --full move' }, async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const website = 'https://public.example/river-lantern-origin';
  const launch = 'https://public.example/river-lantern-launch';
  const sourceText = 'Token ' + target.address + '. The River Lantern page describes a community project.';
  const mock = mockedFetch({
    dexValue: [{
      chainId: 'base', pairAddress: 'FixtureRiverLanternOriginPair',
      baseToken: { address: target.address, name: 'River Lantern', symbol: 'RIVER' },
      quoteToken: { address: '0x3333333333333333333333333333333333333333', name: 'USD Coin', symbol: 'USDC' },
      priceUsd: '0.001', liquidity: { usd: '100000' },
      info: { websites: [{ url: website }], socials: [] },
    }],
    searchValue: (_url, call) => ({ results: call === 0 ? [{ url: website }, { url: launch }] : [] }),
    fetchValue: (urls: string[]) => ({
      results: urls.filter(url => url !== launch).map(url => ({ url, final_url: url, text: sourceText })),
      errors: urls.includes(launch) ? [{ url: launch, error: 'bot_blocked', status: 403 }] : [],
    }),
  });
  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const inputRaw = bundle.rawArtifacts['criterion-input']!;
  const input = JSON.parse(inputRaw) as {
    sources: Array<{ id: string; url: string; text: string }>;
    criterionScopes: Record<string, { complete: boolean; failures: string[]; sourceIds: string[] }>;
  };
  assert.ok(input.sources.some(source => source.url === website && source.text === sourceText));
  assert.equal(input.sources.some(source => source.url === launch), false,
    'the blocked page does not become a source body or citation');
  assert.equal(input.criterionScopes['NAR-02'].complete, true,
    'complete means the bounded operation and each returned result/error were accounted');
  const requests = JSON.parse(bundle.rawArtifacts['criterion-fetch-requests']!) as {
    requests: Array<{ artifactId: string; urls: string[] }>;
  };
  const blockedRequest = requests.requests.find(request => request.urls.includes(launch));
  assert.ok(blockedRequest, 'the actual required fetch request names the blocked URL');
  const blockedResponse = JSON.parse(bundle.rawArtifacts[blockedRequest.artifactId]!) as {
    errors: Array<{ url: string; status: number; error: string }>;
  };
  assert.ok(blockedResponse.errors.some(error => error.url === launch && error.status === 403 && error.error === 'bot_blocked'),
    'the exact per-URL 403 remains in the original provider response');
  assert.deepEqual(mock.geminiPackets.filter(packet => packet.method === criterionReviewMethod).map(packet => packet.stage), ['draft', 'final']);
  assert.ok(bundle.details?.criteria?.results.find(row => row.criterionId === 'NAR-02')?.evaluationState === 'UNAVAILABLE',
    'the fixture does not fabricate an independent positive or negative origin judgment');
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED');

  const directory = mkdtempSync(join(tmpdir(), 'criterion-blocked-origin-proof-'));
  const database = join(directory, 'blocked.sqlite');
  const service = new Service(database);
  try {
    const saved = service.analyzeLive(bundle);
    assert.equal(buildEntryReport(saved).checks.find(row => row.checkId === 'NAR-02')?.outcome, 'UNKNOWN');
    assert.equal(service.replay(saved.id).hash, saved.hash);
  } finally { service.close(); }

  const forged = structuredClone(bundle);
  const forgedInput = JSON.parse(inputRaw) as typeof input;
  forgedInput.criterionScopes['NAR-02'].sourceIds.push('forged-unread-launch-body');
  const forgedRaw = JSON.stringify(forgedInput);
  forged.rawArtifacts['criterion-input'] = forgedRaw;
  const inputEvidence = forged.evidence.find(item => item.id === 'criterion-input');
  assert.ok(inputEvidence);
  inputEvidence.contentHash = sha256(forgedRaw);
  const verifier = new Service(join(directory, 'forged-scope.sqlite'));
  try {
    assert.throws(() => verifier.analyzeLive(forged), /CRITERION_PROOF_INVALID|CRITERION_SOURCE_INVALID/,
      're-hashing a forged source list cannot claim that the unread HTTP-403 page was inspected');
  } finally {
    verifier.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('missing provider keys skip optional web/model calls while preserving RPC and DEX collection', async () => {
  const mock = mockedFetch({ dexValue: [pair(1)] });
  const result = await collectLiveSolana(token, liveOptions(mock.fetcher, { semanticEnabled: true }));
  assert.equal(result.collection.web.state, 'KEY_MISSING');
  assert.equal(result.semantic.status, 'KEY_MISSING');
  assert.equal(mock.calls.some(call => call.url.includes('tinyfish.ai')), false);
  assert.equal(mock.calls.some(call => call.url.includes('generativelanguage.googleapis.com')), false);
  assert.equal(result.collection.rpc.state, 'OBSERVED');
  assert.equal(result.collection.dex.state, 'OBSERVED');
  assert.equal(result.rawArtifacts['attention-acquisition-scope'], undefined,
    'without optional provider keys there is no hosted attention packet to mark or misstate');
});

test('ENTRY_GROUPS_V1 records an incomplete C05 as known false and persists it through replay', async () => {
  const mock = mockedFetch({ dexValue: [pair(1)] });
  const bundle = await collectLiveSolana(token, liveOptions(mock.fetcher, { semanticEnabled: true }));
  const c05Features = bundle.features.filter(feature => feature.id === 'C05');
  const c05Assessment = bundle.details?.baseline.find(row => row.id === 'C05');
  assert.equal(c05Features.length, 1, 'a legacy C05 with no projection still receives one shared projection');
  assert.equal(bundle.details?.shared?.qualityMode, 'ENTRY_GROUPS_V1');
  assert.equal(c05Features[0]?.quality, 'KNOWN', 'the explicit gate mode records an incomplete review as a known failed quality gate');
  assert.equal(c05Features[0]?.value, false);
  assert.deepEqual(c05Assessment?.projection, c05Features[0]);
  assert.ok(bundle.details?.shared, 'the shared proof is present even when optional hosted keys are absent');
  assert.equal(mock.calls.some(call => call.url.includes('tinyfish.ai') || call.url.includes('generativelanguage.googleapis.com')), false,
    'the fixture exercises the service boundary without hosted requests');

  const directory = mkdtempSync(join(tmpdir(), 'shared-c05-replay-'));
  const database = join(directory, 'shared.sqlite');
  let snapshotId = '';
  let savedHash = '';
  try {
    const service = new Service(database);
    try {
      const saved = service.analyzeLive(bundle);
      snapshotId = saved.id;
      savedHash = saved.hash;
      assert.deepEqual(saved.details?.baseline.find(row => row.id === 'C05')?.projection, c05Features[0]);
    } finally {
      service.close();
    }

    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, savedHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
      assert.deepEqual(reopened.frozenDetails(snapshotId).baseline.find(row => row.id === 'C05')?.projection, c05Features[0]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy Shared repair proof reconstructs selected raw responses and rejects rehashed reassessment tampering', async () => {
  const fixture = sharedFixture();
  const mock = mockedFetch({ dexValue: [] });
  const bundle = await collectLiveToken(fixture.token, liveOptions(mock.fetcher, {
    semanticEnabled: true, profile: fixture.profile, now: () => fixture.cutoff,
  }));
  assert.ok(bundle.details?.shared);

  const originalProof = bundle.evidence.find(record => record.id === 'shared-derivation');
  assert.ok(originalProof);
  bundle.evidence = bundle.evidence.filter(record => record.id !== originalProof.id);
  delete bundle.rawArtifacts[originalProof.id];
  // This test isolates the retained Shared-repair contract. Pin its synthetic
  // path to legacy policy instead of claiming that the fixture meets all new
  // mandatory groups; the separate fresh-service proof test covers that path.
  const groupProof = bundle.evidence.find(record => record.id === 'entry-groups-derivation');
  assert.ok(groupProof);
  bundle.evidence = bundle.evidence.filter(record => record.id !== groupProof.id);
  delete bundle.rawArtifacts[groupProof.id];
  delete bundle.details!.groups;
  bundle.details!.shared!.qualityMode = 'ENTRY_GATES_V1';
  const captureRecord = bundle.evidence.find(record => record.id === 'live-state-capture');
  assert.ok(captureRecord);
  const capture = JSON.parse(bundle.rawArtifacts[captureRecord.id]!) as Record<string, unknown>;
  delete capture.entryGroupMethod;
  delete capture.contextDecisionMethod;
  bundle.rawArtifacts[captureRecord.id] = JSON.stringify(capture);
  captureRecord.contentHash = sha256(bundle.rawArtifacts[captureRecord.id]!);
  bundle.profile = fixture.profile;
  bundle.details!.profile = fixture.profile;
  delete bundle.details!.social;

  const source = fixture.sources.find(item => item.id === 'attention-source');
  assert.ok(source);
  if (source.kind === 'ACQUISITION_RECEIPT') throw new Error('the attention fixture source must remain a retained body');
  const counterSource = {
    id: 'counter-source', url: 'https://public.example/counter',
    text: 'A separate acquired page retains the comparison assertion for this fixture.',
    publishedAt: null, authorId: null, availableAt: bundle.cutoff, kind: 'PAGE' as const,
  };
  const claims = sharedClaims(fixture.baseline, undefined);
  const sources = [{ ...source, availableAt: bundle.cutoff }, counterSource];
  const sourceEvidence = (item: typeof sources[number]) => ({
    id: item.id, sourceId: 'tinyfish-fetch', sourceType: 'WEB_PAGE', retrievedAt: bundle.cutoff,
    availableAt: bundle.cutoff, contentHash: sha256(item.text), adapterVersion: 'live-v1',
    accessMode: 'FREE_ACCOUNT' as const,
    scope: { url: item.url, publishedAt: item.publishedAt, authorId: item.authorId, kind: item.kind },
  });
  const attachArtifact = (
    id: string, raw: string, sourceId: string, sourceType: string,
    accessMode: typeof bundle.evidence[number]['accessMode'], scope: Record<string, unknown>,
  ) => {
    bundle.rawArtifacts[id] = raw;
    bundle.evidence.push({
      id, sourceId, sourceType, retrievedAt: bundle.cutoff, availableAt: bundle.cutoff,
      contentHash: sha256(raw), adapterVersion: 'live-v1', accessMode, scope,
    });
  };
  for (const record of fixture.evidence.filter(item => item.id !== 'social-evidence')) {
    attachArtifact(record.id, JSON.stringify({ fixture: record.id }), 'shared-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { fixture: true });
  }
  for (const item of sources) {
    bundle.rawArtifacts[item.id] = item.text;
    bundle.evidence.push(sourceEvidence(item));
  }

  const spanFor = (sourceId: string, quote?: string) => {
    const source = sources.find(item => item.id === sourceId)!;
    const span = sourceSpans(source.id, source.text, 'SHARED_MODEL').find(item => quote ? item.text.includes(quote) : true);
    assert.ok(span, `the raw source has a code-owned span for ${sourceId}`);
    return { sourceId, spanId: span.id };
  };
  const sourceAClaimRefs = Object.fromEntries(claims.map(claim => [claim.id, spanFor(claim.citations[0]!.sourceId, claim.citations[0]!.quote)]));
  const initialClaims = Object.fromEntries(claims.map(claim => [claim.id, {
    disposition: claim.id === 'A01' ? 'CONFLICT' : 'CLEAR',
    rationale: claim.id === 'A01'
      ? 'The initial cross-claim pass records a one-sided comparison conflict.'
      : 'The retained sources show no incompatible assertion for this claim.',
    citations: claim.id === 'A01'
      ? [sourceAClaimRefs[claim.id]]
      : [sourceAClaimRefs[claim.id]],
  }]));
  const repairClaims = {
    ...initialClaims,
    A01: {
      disposition: 'CLEAR',
      rationale: 'The complete retained sources contain no incompatible assertion for this claim.',
      citations: [sourceAClaimRefs.A01],
    },
  };
  const resolveProposalForPrompt = (wire: Record<string, { disposition: string; rationale: string; citations: Array<{ sourceId: string; spanId: string }> }>) =>
    Object.entries(wire).map(([id, decision]) => ({
      ...decision,
      id,
      citations: decision.citations.map(ref => {
        const source = sources.find(item => item.id === ref.sourceId)!;
        const span = sourceSpans(source.id, source.text, 'SHARED_MODEL').find(item => item.id === ref.spanId);
        assert.ok(span, `the resolved prompt citation points to an original span ${ref.spanId}`);
        return { sourceId: ref.sourceId, quote: span.text };
      }),
    }));
  const initialResolvedProposal = resolveProposalForPrompt(initialClaims);
  const repairResolvedProposal = resolveProposalForPrompt(repairClaims);
  const review = (acceptA01: boolean) => ({
    claims: Object.fromEntries(claims.map(claim => [claim.id, claim.id === 'A01' ? acceptA01 : true])),
    sources: Object.fromEntries(sources.map(item => [item.id, true])),
  });
  const raw = (value: unknown) => sourceModelRaw({ claims: value && typeof value === 'object' && 'claims' in value
    ? (value as { claims: unknown }).claims : value });
  const proposalResponse = raw({ claims: initialClaims });
  const reviewResponse = sourceModelRaw(review(true));
  const repairProposalResponse = raw({ claims: repairClaims });
  const repairReviewResponse = sourceModelRaw(review(true));
  const audit = decodeSharedAudit(claims, sources, repairProposalResponse, repairReviewResponse);
  const initialAudit = decodeSharedAudit(claims, sources, proposalResponse, reviewResponse);
  assert.equal(initialAudit.review.find(item => item.id === 'A01')?.accepted, true);
  assert.deepEqual(sharedReassessmentIds(initialAudit), ['A01'], 'the locally detected one-sided conflict is the repair trigger');
  assert.equal(validSharedReassessment(initialAudit, audit), true);
  assert.equal(deriveShared({ ...fixture, social: undefined, claims, sources, audit }).facts.values.C06, true);

  const modelScope = { method: 'automated-source-review-v1', model: 'fixture' };
  for (const [id, content, sourceType] of [
    ['shared-proposal-prompt', sharedAuditPrompt('proposal', claims, sources, bundle.token), 'MODEL_INPUT'],
    ['shared-proposal-response', proposalResponse, 'MODEL_RESPONSE'],
    ['shared-review-prompt', sharedAuditPrompt('review', claims, sources, bundle.token, { proposal: initialResolvedProposal }), 'MODEL_INPUT'],
    ['shared-review-response', reviewResponse, 'MODEL_RESPONSE'],
    ['shared-repair-proposal-prompt', sharedAuditPrompt('repair-proposal', claims, sources, bundle.token, {
      initialProposal: initialClaims, initialAudit, rejectedIds: sharedReassessmentIds(initialAudit),
    }), 'MODEL_INPUT'],
    ['shared-repair-proposal-response', repairProposalResponse, 'MODEL_RESPONSE'],
    ['shared-repair-review-prompt', sharedAuditPrompt('repair-review', claims, sources, bundle.token, { proposal: repairResolvedProposal }), 'MODEL_INPUT'],
    ['shared-repair-review-response', repairReviewResponse, 'MODEL_RESPONSE'],
  ] as const) attachArtifact(id, content, 'gemini', sourceType, 'FREE_ACCOUNT', modelScope);
  const receipt = {
    method: 'shared-conflict-review-v1', token: bundle.token, claims, sources, audit,
    wireMethod: 'shared-audit-wire-v2',
    proposalResponseId: 'shared-repair-proposal-response', reviewResponseId: 'shared-repair-review-response',
  };
  attachArtifact('shared-qualified-receipt', JSON.stringify(receipt), 'shared-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: receipt.method });
  assert.deepEqual(decodeSharedAuditProof(claims, sources, bundle.token, bundle.rawArtifacts, true), audit,
    'the synthetic retained proof uses the same canonical context as the runtime decoder');

  const input: SharedInputs = {
    ...fixture, qualityMode: 'ENTRY_GATES_V1',
    token: bundle.token, cutoff: bundle.cutoff, profile: bundle.profile,
    baseline: fixture.baseline, features: fixture.features, evidence: structuredClone(bundle.evidence),
    observations: bundle.observations, social: undefined, claims, sources, audit,
    semanticReceiptIds: ['attention-qualified-receipt', 'social-qualified-receipt'],
  };
  const effective = expireSharedWitnesses(input);
  const derived = deriveShared(effective);
  const sharedIds = new Set(['C03', 'C04', 'C05', 'C06']);
  bundle.features = [
    ...effective.features.filter(feature => !sharedIds.has(feature.id)),
    ...derived.assessments.map(assessment => assessment.projection!),
  ];
  bundle.details!.baseline = [
    ...effective.baseline.filter(assessment => !sharedIds.has(assessment.id)),
    ...derived.assessments,
  ];
  bundle.details!.shared = derived.facts;
  assert.equal(bundle.details!.baseline.find(row => row.id === 'C06')?.projection?.value, true,
    'the synthetic legacy fixture keeps its established Shared completeness result');

  const proofRaw = JSON.stringify(input);
  bundle.rawArtifacts['shared-derivation'] = proofRaw;
  bundle.evidence.push({
    id: 'shared-derivation', sourceId: 'shared-collector', sourceType: 'CALCULATION',
    retrievedAt: bundle.cutoff, availableAt: bundle.cutoff, contentHash: sha256(proofRaw),
    adapterVersion: 'live-v1', accessMode: 'LOCAL_DERIVED', scope: { method: 'shared-evidence-v1', qualityMode: input.qualityMode },
  });

  const directory = mkdtempSync(join(tmpdir(), 'shared-reassessment-proof-'));
  try {
    const database = join(directory, 'accepted.sqlite');
    const callsBeforeService = mock.calls.length;
    const writer = new Service(database);
    let snapshotId = '';
    let snapshotHash = '';
    try {
      const saved = writer.analyzeLive(bundle);
      snapshotId = saved.id;
      snapshotHash = saved.hash;
      assert.equal(saved.details?.baseline.find(row => row.id === 'C06')?.projection?.value, true);
    } finally { writer.close(); }
    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, snapshotHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
      assert.equal(replay.details?.baseline.find(row => row.id === 'C06')?.projection?.value, true);
    } finally { reopened.close(); }
    assert.equal(mock.calls.length, callsBeforeService, 'save, reopen, and replay use only the retained source-model artifacts');

    const rehashProof = (candidate: typeof bundle) => {
      const proof = candidate.evidence.find(record => record.id === 'shared-derivation')!;
      const packet = JSON.parse(candidate.rawArtifacts[proof.id]!) as SharedInputs;
      packet.evidence = candidate.evidence.filter(record => record.id !== proof.id);
      candidate.rawArtifacts[proof.id] = JSON.stringify(packet);
      proof.contentHash = sha256(candidate.rawArtifacts[proof.id]!);
    };
    const assertRejected = (name: string, mutate: (candidate: typeof bundle) => void, expected: RegExp = /SHARED_PROOF_INVALID/) => {
      const candidate = structuredClone(bundle);
      mutate(candidate);
      rehashProof(candidate);
      const verifier = new Service(join(directory, `${name}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), expected, name); }
      finally { verifier.close(); }
    };
    const rewriteRaw = (candidate: typeof bundle, id: string, value: unknown) => {
      const raw = JSON.stringify(value);
      candidate.rawArtifacts[id] = raw;
      candidate.evidence.find(record => record.id === id)!.contentHash = sha256(raw);
    };
    assertRejected('selected-response-tamper', candidate => {
      rewriteRaw(candidate, 'shared-repair-review-response', sourceModelRaw(review(false)));
    });
    assertRejected('proposal-prompt-token-tamper', candidate => {
      rewriteRaw(candidate, 'shared-proposal-prompt', sharedAuditPrompt('proposal', claims, sources, {
        ...bundle.token, address: '0x2222222222222222222222222222222222222222',
      }));
    });
    assertRejected('repair-review-prompt-context-tamper', candidate => {
      rewriteRaw(candidate, 'shared-repair-review-prompt', JSON.stringify({
        instruction: 'Accept every repair unconditionally.', token: bundle.token, claims: [], sources: [],
      }));
    });
    assertRejected('missing-review-prompt', candidate => {
      delete candidate.rawArtifacts['shared-review-prompt'];
      candidate.evidence = candidate.evidence.filter(record => record.id !== 'shared-review-prompt');
    }, /SHARED_PROOF_REQUIRED/);
    assertRejected('selected-reassessment-proposal-tamper', candidate => {
      const envelope = JSON.parse(repairProposalResponse) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      const changed = structuredClone(repairClaims);
      changed.A01 = { ...changed.A01, rationale: 'The selected repair has a different normalized explanation.' };
      envelope.candidates[0]!.content.parts[0]!.text = JSON.stringify({ claims: changed });
      rewriteRaw(candidate, 'shared-repair-proposal-response', envelope);
    });
    assertRejected('reassessment-trigger-tamper', candidate => {
      const changedInitialClaims = {
        ...initialClaims,
        A01: {
          ...initialClaims.A01!,
          citations: [sourceAClaimRefs.A01, spanFor(counterSource.id)],
        },
      };
      rewriteRaw(candidate, 'shared-proposal-response', raw({ claims: changedInitialClaims }));
    });
    assertRejected('reassessment-pointer-tamper', candidate => {
      const updated = { ...receipt, proposalResponseId: 'shared-proposal-response', reviewResponseId: 'shared-review-response' };
      rewriteRaw(candidate, 'shared-qualified-receipt', updated);
    });
    assertRejected('reassessment-marker-removal', candidate => {
      const downgraded = { ...receipt } as Record<string, unknown>;
      delete downgraded.wireMethod;
      delete downgraded.proposalResponseId;
      delete downgraded.reviewResponseId;
      rewriteRaw(candidate, 'shared-qualified-receipt', downgraded);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
