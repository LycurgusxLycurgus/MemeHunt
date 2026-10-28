import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { decisionHash, Service } from '../src/app/service.js';
import type { EvidenceRecord } from '../src/domain/contracts.js';
import { nvidiaSettings } from '../src/providers/nvidia.js';
import { openRouterSettings } from '../src/providers/openrouter.js';
import { sourceModelArtifactInfo, sourceModelEvidenceAllowed } from '../src/providers/source-model.js';
import {
  bundleSchema,
  entryGroupFactsSchema,
  liveBundleSchema,
  liveMarketSummarySchema,
  providerStatusSchema,
  semanticResultSchema,
  type LiveBundle,
} from '../src/domain/contracts.js';

const HASH = 'a'.repeat(64);
const LIVE_BUNDLE: LiveBundle = {
  token: { chain: 'solana', address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' },
  cutoff: '2026-09-29T12:00:00.000Z',
  analysisKind: 'LIVE',
  evidence: [],
  rawArtifacts: {},
  observations: [],
  features: [],
  profile: { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } },
  collection: {
    rpc: { state: 'OBSERVED', count: 1 },
    dex: { state: 'OBSERVED', count: 1 },
    web: { state: 'KEY_MISSING' },
  },
  semantic: { status: 'NOT_REQUESTED', claims: [] },
  market: {
    reportedPairCount: 1,
    retainedPairCount: 1,
    truncated: false,
    pairs: [{
      pairAddress: 'PoolAddress',
      dexId: 'raydium',
      url: 'https://dexscreener.com/solana/PoolAddress',
      mintSide: 'base',
      baseAddress: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',
      quoteAddress: 'QuoteMint',
      priceUsd: '0.001',
      liquidityUsd: '1000',
      volume24hUsd: null,
      buys24h: 2,
      sells24h: 1,
      pairCreatedAt: null,
    }],
  },
};

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
const nvidiaResponseId = 'nvidia-response';
const nvidiaTransportId = 'nvidia-transport-attempt-1';
const nvidiaRaw = JSON.stringify({
  id: 'chatcmpl-service-test', object: 'chat.completion', created: 1, model: nvidiaSettings.model,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"accepted":true}' } }],
});
const nvidiaReceipt = (provider = 'nvidia', model: string = nvidiaSettings.model, attempt = 1, raw = nvidiaRaw) => JSON.stringify({
  kind: 'LOCAL_MODEL_TRANSPORT', attempt, provider, model, phase: 'RESPONSE_BODY',
  elapsedMs: 1, budgetMs: nvidiaSettings.requestTimeoutMs, code: 'ATT_MODEL_HTTP_200', willRetry: false,
  responseBindingMethod: 'retained-body-sha256-v1', responseHash: sha256(raw),
});
const evidenceFor = (id: string, sourceId: string, sourceType: string, accessMode: EvidenceRecord['accessMode'], raw: string, scope: Record<string, unknown> = {}): EvidenceRecord => ({
  id, sourceId, sourceType, retrievedAt: LIVE_BUNDLE.cutoff, availableAt: LIVE_BUNDLE.cutoff,
  contentHash: sha256(raw), adapterVersion: 'nvidia-test-v1', accessMode, scope,
});

function nvidiaServiceBundle(options: { sourceId?: string; receiptId?: string; receipt?: string } = {}): LiveBundle {
  const sourceId = options.sourceId ?? 'nvidia';
  const receiptId = options.receiptId ?? nvidiaTransportId;
  const rawArtifacts: Record<string, string> = { [nvidiaResponseId]: nvidiaRaw };
  const evidence: EvidenceRecord[] = [evidenceFor(nvidiaResponseId, sourceId, 'MODEL_RESPONSE', 'FREE_ACCOUNT', nvidiaRaw, {
    provider: 'nvidia', model: nvidiaSettings.model, responseBindingMethod: 'retained-body-sha256-v1',
  })];
  if (options.receipt !== undefined || receiptId === nvidiaTransportId) {
    const receipt = options.receipt ?? nvidiaReceipt();
    rawArtifacts[receiptId] = receipt;
    evidence.push(evidenceFor(receiptId, 'source-model', 'MODEL_TRANSPORT', 'LOCAL_DERIVED', receipt));
  }
  const inputId = 'fresh-model-input';
  const input = 'untrusted test packet';
  rawArtifacts[inputId] = input;
  evidence.push(evidenceFor(inputId, 'source-model', 'MODEL_INPUT', 'LOCAL_DERIVED', input));
  return { ...LIVE_BUNDLE, evidence, rawArtifacts };
}

function openRouterServiceBundle(): LiveBundle {
  const responseId = 'openrouter-response';
  const transportId = 'openrouter-transport-attempt-1';
  const raw = JSON.stringify({
    id: 'chatcmpl-openrouter-service-test', object: 'chat.completion', created: 1, model: openRouterSettings.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"accepted":true}' } }],
  });
  const receipt = JSON.stringify({
    kind: 'LOCAL_MODEL_TRANSPORT', attempt: 1, provider: 'openrouter', model: openRouterSettings.model,
    requestProfile: openRouterSettings.requestProfile, phase: 'RESPONSE_BODY', elapsedMs: 1,
    budgetMs: openRouterSettings.requestTimeoutMs, code: 'ATT_MODEL_HTTP_200', willRetry: false,
    responseBindingMethod: 'retained-body-sha256-v1', responseHash: sha256(raw),
  });
  const inputId = 'openrouter-model-input', input = 'untrusted test packet';
  const rawArtifacts = { [responseId]: raw, [transportId]: receipt, [inputId]: input };
  const evidence: EvidenceRecord[] = [
    evidenceFor(responseId, 'openrouter', 'MODEL_RESPONSE', 'FREE_ACCOUNT', raw, {
      provider: 'openrouter', model: openRouterSettings.model, responseBindingMethod: 'retained-body-sha256-v1',
    }),
    evidenceFor(transportId, 'source-model', 'MODEL_TRANSPORT', 'LOCAL_DERIVED', receipt),
    evidenceFor(inputId, 'source-model', 'MODEL_INPUT', 'LOCAL_DERIVED', input),
  ];
  return { ...LIVE_BUNDLE, evidence, rawArtifacts };
}

test('external bundle imports reject LIVE while the internal live contract requires its provenance fields', () => {
  assert.throws(() => bundleSchema.parse(LIVE_BUNDLE));
  assert.deepEqual(liveBundleSchema.parse(LIVE_BUNDLE), LIVE_BUNDLE);
  assert.throws(() => liveBundleSchema.parse({ ...LIVE_BUNDLE, collection: undefined }));
  assert.throws(() => liveBundleSchema.parse({ ...LIVE_BUNDLE, rawArtifacts: undefined }));
  assert.throws(() => liveBundleSchema.parse({ ...LIVE_BUNDLE, fabricated: true }));
  assert.throws(() => liveBundleSchema.parse({ ...LIVE_BUNDLE, report: { method: 'entry-outcomes-v1' } }),
    'the current normalized report is derived at display time and is not a new persisted snapshot field');
});

test('source-model attribution requires the matching NVIDIA receipt and keeps new prompt evidence local', () => {
  const valid = nvidiaServiceBundle();
  const response = valid.evidence.find(row => row.id === nvidiaResponseId)!;
  assert.deepEqual(sourceModelArtifactInfo(response.id, valid.rawArtifacts![response.id]!, valid.rawArtifacts!), {
    sourceId: 'nvidia', model: nvidiaSettings.model,
  });
  assert.equal(sourceModelEvidenceAllowed(response, valid.rawArtifacts!), true);

  const input = valid.evidence.find(row => row.id === 'fresh-model-input')!;
  assert.equal(sourceModelEvidenceAllowed(input, valid.rawArtifacts!), true);
  assert.equal(sourceModelEvidenceAllowed({ ...input, sourceId: 'gemini', accessMode: 'FREE_ACCOUNT' }, valid.rawArtifacts!), true,
    'older retained Gemini model input provenance remains readable');

  const geminiRaw = JSON.stringify({
    modelVersion: 'gemini-3.5-flash-lite', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"accepted":true}' }] } }],
  });
  const historicalGemini = evidenceFor('historical-response', 'gemini', 'MODEL_RESPONSE', 'FREE_ACCOUNT', geminiRaw);
  assert.equal(sourceModelEvidenceAllowed(historicalGemini, { 'historical-response': geminiRaw }), true,
    'older retained Gemini response provenance remains readable');

  const missing = nvidiaServiceBundle({ receiptId: 'orphan-transport-attempt-1' });
  assert.equal(sourceModelEvidenceAllowed(missing.evidence[0]!, missing.rawArtifacts!), false,
    'a missing matching receipt cannot authorize NVIDIA provenance');
  const crossed = nvidiaServiceBundle({ receiptId: 'orphan-transport-attempt-1', receipt: nvidiaReceipt() });
  assert.equal(sourceModelEvidenceAllowed(crossed.evidence[0]!, crossed.rawArtifacts!), false,
    'a receipt with a different response prefix cannot authorize NVIDIA provenance');
  const wrongProvider = nvidiaServiceBundle({ receipt: nvidiaReceipt('gemini') });
  assert.equal(sourceModelEvidenceAllowed(wrongProvider.evidence[0]!, wrongProvider.rawArtifacts!), false);
  const wrongModel = nvidiaServiceBundle({ receipt: nvidiaReceipt('nvidia', 'another-model') });
  assert.equal(sourceModelEvidenceAllowed(wrongModel.evidence[0]!, wrongModel.rawArtifacts!), false);
  assert.equal(sourceModelEvidenceAllowed({ ...response, sourceId: 'gemini' }, valid.rawArtifacts!), false,
    'a native NVIDIA response cannot be relabeled as Gemini');
});

test('fresh response attribution follows retained-body hashes and exact attempts, including a later bodyless attempt', () => {
  const geminiRaw = JSON.stringify({
    modelVersion: 'gemini-3.5-flash-lite',
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"accepted":true}' }] } }],
  });
  const bodyless = JSON.stringify({ kind: 'LOCAL_MODEL_TRANSPORT', attempt: 3, phase: 'RESPONSE_HEADERS',
    elapsedMs: 1, budgetMs: 90000, model: 'gemini-3.5-flash-lite', code: 'ATT_MODEL_TIMEOUT', willRetry: false,
    responseBindingMethod: 'retained-body-sha256-v1' });
  const artifacts: Record<string, string> = {
    'review-response': nvidiaRaw,
    'review-response-attempt-1': geminiRaw,
    'review-response-attempt-2': nvidiaRaw,
    'review-transport-attempt-1': JSON.stringify({ kind: 'LOCAL_MODEL_TRANSPORT', attempt: 1, phase: 'RESPONSE_BODY',
      elapsedMs: 1, budgetMs: 90000, model: 'gemini-3.5-flash-lite', code: 'ATT_MODEL_HTTP_503', willRetry: true,
      responseBindingMethod: 'retained-body-sha256-v1', responseHash: sha256(geminiRaw) }),
    'review-transport-attempt-2': nvidiaReceipt('nvidia', nvidiaSettings.model, 2),
    'review-transport-attempt-3': bodyless,
  };
  assert.deepEqual(sourceModelArtifactInfo('review-response', nvidiaRaw, artifacts), {
    sourceId: 'nvidia', model: nvidiaSettings.model,
  }, 'the later NVIDIA response body wins despite a terminal Gemini attempt with no retained body');
  assert.deepEqual(sourceModelArtifactInfo('review-response-attempt-1', geminiRaw, artifacts), {
    sourceId: 'gemini', model: 'gemini-3.5-flash-lite',
  }, 'an explicit attempt ID remains attached to its own Gemini body');
  assert.deepEqual(sourceModelArtifactInfo('review-response-attempt-2', nvidiaRaw, artifacts), {
    sourceId: 'nvidia', model: nvidiaSettings.model,
  });
  assert.equal(sourceModelArtifactInfo('review-response', `${nvidiaRaw} `, artifacts), null,
    'a body changed after retention has no matching producer');

  const missingHash = { ...artifacts, 'review-transport-attempt-2': JSON.stringify({
    ...JSON.parse(artifacts['review-transport-attempt-2']!), responseHash: undefined,
  }) };
  assert.equal(sourceModelArtifactInfo('review-response', nvidiaRaw, missingHash), null,
    'a fresh NVIDIA response cannot fall back to provider labels when its body hash is missing');
  const crossedAttempt = { ...artifacts, 'review-transport-attempt-2': nvidiaReceipt('nvidia', nvidiaSettings.model, 1) };
  assert.equal(sourceModelArtifactInfo('review-response', nvidiaRaw, crossedAttempt), null,
    'a receipt whose attempt disagrees with its artifact suffix is invalid');
  const wrongBinding = { ...artifacts, 'review-transport-attempt-1': JSON.stringify({
    ...JSON.parse(artifacts['review-transport-attempt-1']!), responseBindingMethod: 'other-hash-v1',
  }) };
  assert.equal(sourceModelArtifactInfo('review-response', nvidiaRaw, wrongBinding), null,
    'one malformed receipt in a fresh attempt chain fails the chain closed');
  const wrongProviderModel = { ...artifacts, 'review-transport-attempt-2': nvidiaReceipt('nvidia', 'another-model', 2) };
  assert.equal(sourceModelArtifactInfo('review-response', nvidiaRaw, wrongProviderModel), null,
    'the bound provider and model pair is validated before body attribution');
});

test('Service and CLI preserve matching NVIDIA provenance, reject missing or crossed receipts, and replay raw response unchanged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-nvidia-service-'));
  const database = join(directory, 'nvidia.sqlite');
  const valid = nvidiaServiceBundle();
  let service = new Service(database);
  try {
    const saved = service.analyzeLive(valid);
    assert.equal(saved.evidence.find(row => row.id === nvidiaResponseId)?.sourceId, 'nvidia');
    assert.equal(saved.evidence.find(row => row.id === nvidiaResponseId)?.contentHash, sha256(nvidiaRaw));
    assert.equal(readFileSync(join(directory, 'artifacts', sha256(nvidiaRaw)), 'utf8'), nvidiaRaw,
      'the native NVIDIA envelope is retained byte-for-byte under its evidence hash');
    service.close();

    service = new Service(database);
    assert.deepEqual(service.replay(saved.id), saved);
    service.close();

    for (const command of ['show', 'replay']) {
      let output = '';
      const exitCode = await runCli([command, saved.id, '--db', database, '--json'], {
        stdout: text => { output += text; },
        stderr: () => {},
      });
      assert.equal(exitCode, 0, `CLI ${command} succeeds after reopening the NVIDIA snapshot`);
      const cliSnapshot = JSON.parse(output) as { evidence: EvidenceRecord[] };
      assert.ok(cliSnapshot.evidence.some(row => row.id === nvidiaResponseId && row.sourceId === 'nvidia'
        && row.sourceType === 'MODEL_RESPONSE' && row.accessMode === 'FREE_ACCOUNT'
        && row.scope.provider === 'nvidia' && row.scope.model === nvidiaSettings.model),
      `CLI ${command} preserves provider, model and access provenance`);
    }
  } finally {
    try { service.close(); } catch { /* already closed before reopening */ }
    rmSync(directory, { recursive: true, force: true });
  }

  const invalid = [
    ['native response mislabeled as Gemini', nvidiaServiceBundle({ sourceId: 'gemini' })],
    ['missing matching provider receipt', nvidiaServiceBundle({ receiptId: 'orphan-transport-attempt-1' })],
    ['crossed receipt prefix', nvidiaServiceBundle({ receiptId: 'orphan-transport-attempt-1', receipt: nvidiaReceipt() })],
    ['receipt attributed to Gemini', nvidiaServiceBundle({ receipt: nvidiaReceipt('gemini') })],
    ['receipt for another model', nvidiaServiceBundle({ receipt: nvidiaReceipt('nvidia', 'another-model') })],
    ['unbound NVIDIA receipt', (() => { const bundle = structuredClone(valid); const receipt = JSON.parse(bundle.rawArtifacts[nvidiaTransportId]!) as Record<string, unknown>; delete receipt.responseBindingMethod; delete receipt.responseHash; bundle.rawArtifacts[nvidiaTransportId] = JSON.stringify(receipt); bundle.evidence.find(row => row.id === nvidiaTransportId)!.contentHash = sha256(bundle.rawArtifacts[nvidiaTransportId]!); return bundle; })()],
    ['tampered response body hash', (() => { const bundle = structuredClone(valid); bundle.rawArtifacts[nvidiaResponseId] = `${nvidiaRaw} `; bundle.evidence.find(row => row.id === nvidiaResponseId)!.contentHash = sha256(bundle.rawArtifacts[nvidiaResponseId]!); return bundle; })()],
    ['tampered binding method in response scope', (() => { const bundle = structuredClone(valid); bundle.evidence.find(row => row.id === nvidiaResponseId)!.scope.responseBindingMethod = 'other-hash-v1'; return bundle; })()],
    ['removed fresh binding marker in response scope', (() => { const bundle = structuredClone(valid); delete bundle.evidence.find(row => row.id === nvidiaResponseId)!.scope.responseBindingMethod; return bundle; })()],
    ['tampered provider scope', (() => { const bundle = structuredClone(valid); bundle.evidence.find(row => row.id === nvidiaResponseId)!.scope.provider = 'gemini'; return bundle; })()],
    ['tampered model scope', (() => { const bundle = structuredClone(valid); bundle.evidence.find(row => row.id === nvidiaResponseId)!.scope.model = 'another-model'; return bundle; })()],
  ] as const;
  for (const [label, bundle] of invalid) {
    const verifier = new Service(':memory:');
    try { assert.throws(() => verifier.analyzeLive(bundle), /LIVE_PROVENANCE_INVALID/, label); }
    finally { verifier.close(); }
  }
});

test('Service accepts and replays exact OpenRouter provenance through the live allowlist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-openrouter-service-'));
  const database = join(directory, 'openrouter.sqlite');
  const bundle = openRouterServiceBundle();
  const service = new Service(database);
  try {
    const saved = service.analyzeLive(bundle);
    const response = saved.evidence.find(row => row.id === 'openrouter-response');
    assert.equal(response?.sourceId, 'openrouter');
    assert.equal(response?.scope.provider, 'openrouter');
    assert.equal(response?.scope.model, openRouterSettings.model);
    assert.equal(readFileSync(join(directory, 'artifacts', sha256(bundle.rawArtifacts!['openrouter-response']!)), 'utf8'), bundle.rawArtifacts!['openrouter-response']);
    assert.deepEqual(service.replay(saved.id), saved);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('provider statuses and semantic results reject unknown keys and out-of-contract sizes', () => {
  assert.deepEqual(providerStatusSchema.parse({ state: 'UNAVAILABLE', code: 'HTTP_429' }), { state: 'UNAVAILABLE', code: 'HTTP_429' });
  assert.throws(() => providerStatusSchema.parse({ state: 'OBSERVED', secret: 'must not pass' }));
  assert.throws(() => providerStatusSchema.parse({ state: 'OBSERVED', count: -1 }));

  const claim = {
    kind: 'NARRATIVE',
    value: 'A community token',
    evidenceId: 'web-1',
    quote: 'The project describes itself as a community token.',
    assertion: 'SOURCE_STATES',
  } as const;
  assert.deepEqual(semanticResultSchema.parse({
    status: 'CANDIDATE', claims: [claim], model: 'gemini-3.5-flash-lite',
    promptHash: HASH, responseHash: HASH, schemaVersion: 1,
  }).status, 'CANDIDATE');
  assert.throws(() => semanticResultSchema.parse({ status: 'CANDIDATE', claims: Array(21).fill(claim) }));
  assert.throws(() => semanticResultSchema.parse({ status: 'CANDIDATE', claims: [{ ...claim, quote: 'short' }] }));
  assert.throws(() => semanticResultSchema.parse({ status: 'CANDIDATE', claims: [], unexpected: true }));
});

test('market summary caps displayed pairs while keeping total retained count separate', () => {
  const pair = LIVE_BUNDLE.market!.pairs[0]!;
  const summary = { reportedPairCount: 30, retainedPairCount: 30, truncated: true, pairs: Array(20).fill(pair) };
  assert.equal(liveMarketSummarySchema.parse(summary).pairs.length, 20);
  assert.throws(() => liveMarketSummarySchema.parse({ ...summary, pairs: Array(21).fill(pair) }));
  assert.throws(() => liveMarketSummarySchema.parse({ ...summary, provider: 'DEX' }));
});

test('assessment details accept strict optional entry-group facts and the new Shared quality mode', () => {
  const groupIds = ['ADV-01','ADV-02','ADV-03','ADV-04','ADV-05'] as const;
  const groups = {
    method: 'mandatory-entry-groups-v1' as const, token: LIVE_BUNDLE.token, cutoff: LIVE_BUNDLE.cutoff,
    groups: groupIds.map(checkId => ({
      checkId, status: 'UNKNOWN' as const, rationale: 'The current criterion is not qualified.', code: 'CURRENT_EVIDENCE_UNAVAILABLE',
      featureIds: [], evidenceIds: [], availableAt: LIVE_BUNDLE.cutoff, metrics: { measured: null }, limitations: ['The needed source was unavailable.'],
    })),
  };
  assert.deepEqual(entryGroupFactsSchema.parse(groups), groups);
  assert.equal(entryGroupFactsSchema.safeParse({ ...groups, groups: groups.groups.slice(1) }).success, false);
  assert.equal(entryGroupFactsSchema.safeParse({ ...groups, groups: [...groups.groups.slice(0, 4), { ...groups.groups[4]!, extra: true }] }).success, false);

  const details = {
    version: 1 as const, profile: LIVE_BUNDLE.profile, thesis: null, baseline: [], origins: {},
    stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null }, groups,
    shared: {
      method: 'shared-evidence-v1' as const, qualityMode: 'ENTRY_GROUPS_V1' as const,
      token: LIVE_BUNDLE.token, cutoff: LIVE_BUNDLE.cutoff, witnesses: [], freshness: [], unresolved: [],
      semanticQualified: false, auditQualified: false, conflicts: [],
      values: { C03: null, C04: null, C05: null, C06: null },
    },
  };
  const parsed = liveBundleSchema.parse({ ...LIVE_BUNDLE, details });
  assert.deepEqual(parsed.details, details);
  const legacy = liveBundleSchema.parse(LIVE_BUNDLE);
  assert.equal(legacy.details, undefined, 'legacy detailed facts remain optional');
});

test('decisionHash keeps valid canonical bytes and reports strict serialization failures safely', () => {
  const canonical = { a: 1, b: [true, null] };
  const expected = createHash('sha256').update('{"a":1,"b":[true,null]}').digest('hex');
  assert.equal(decisionHash({ b: [true, null], a: 1 }), expected);
  assert.equal(decisionHash(canonical), expected);
  assert.notEqual(decisionHash({}), decisionHash({ value: null }), 'absent and explicit null stay distinct');

  const assertDiagnostic = (value: unknown, path: string, kind: string, privateText?: string) => {
    let caught: unknown;
    try { decisionHash(value); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, 'UNSERIALIZABLE_VALUE');
    const diagnostic = (caught as Error & { serialization?: { path: string; kind: string } }).serialization;
    assert.deepEqual(diagnostic, { path, kind });
    if (privateText) assert.doesNotMatch(`${caught.message} ${JSON.stringify(diagnostic)}`, new RegExp(privateText));
  };

  assertDiagnostic({ nested: { missing: undefined } }, '$.nested.missing', 'undefined');
  assertDiagnostic([undefined], '$[0]', 'undefined');
  assertDiagnostic(undefined, '$', 'undefined');
  assertDiagnostic({ hidden: 12345678901234567890n }, '$.hidden', 'bigint', '12345678901234567890');
  assertDiagnostic({ callback: () => 'private return value' }, '$.callback', 'function', 'private return value');
  assertDiagnostic({ marker: Symbol('private marker') }, '$.marker', 'symbol', 'private marker');

  const arbitraryKey = 'x'.repeat(65);
  assertDiagnostic({ [arbitraryKey]: 987654321n }, '$.[key]', 'bigint', arbitraryKey);
});
