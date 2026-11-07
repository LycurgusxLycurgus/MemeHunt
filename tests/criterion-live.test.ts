import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectLiveToken } from '../src/app/live.js';
import { buildEntryReport } from '../src/app/report.js';
import { Service } from '../src/app/service.js';
import { criterionIds, criterionPurposeCatalog, criterionReviewMethod, type CriterionId, type CriterionInput } from '../src/domain/criterion-review.js';
import type { Profile, TokenRef } from '../src/domain/contracts.js';
import { decodeCriterionAttention } from '../src/providers/attention-model.js';

const TOKEN: TokenRef = { chain: 'base', address: `0x${'a'.repeat(40)}` };
const NOW = '2026-10-29T12:00:00.000Z';
const STORY_URL = 'https://public.example/synthetic-token-context';
const BODY = `The directory lists ${TOKEN.address} as a Synthetic Cedar token.\nIt provides no project referent, community interest, game, or mechanism.`;
const PROFILE: Profile = { id: 'criterion-live-test', risk: {}, stage: { ageBands: [] } };
// Derived from the unchanged DUBBLE bundle 8369840015e40427297d1695cf6c9d2ad496edc025699b179db3d033bd000322:
// its six legacy UNAVAILABLE / null-outcome rows are represented as new-wire UNFINISHED rows below.
const CAPTURE_UNFINISHED_CRITERIA: CriterionId[] = ['NAR-01', 'NAR-02', 'NAR-03', 'CAN-01', 'CAN-02', 'ATT-02'];

type ProgramPacket = Record<string, any>;
type WireRow = Record<string, any>;

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

function modelResponse(value: unknown) {
  return jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function criterionRow(packet: ProgramPacket, id: CriterionId, kind: 'UNFINISHED' | 'INSUFFICIENT', variant = 'final'): WireRow {
  const input = packet.input as ProgramPacket;
  const scope = input.criterionScopes?.[id] as { sourceIds?: string[]; complete?: boolean } | undefined;
  const sourceIds = [...(scope?.sourceIds ?? [])];
  const citable = criterionPurposeCatalog(input as CriterionInput)[id]?.BOUNDED_SUPPORT ?? [];
  const citationId = citable.find(id => sourceIds.includes((input.catalog as Array<{ id: string; sourceId: string }>).find(row => row.id === id)?.sourceId ?? ''));
  const disposition = kind === 'INSUFFICIENT' && scope?.complete && citationId ? 'INSUFFICIENT' : 'UNFINISHED';
  return {
    criterionId: id,
    disposition,
    rationale: disposition === 'INSUFFICIENT'
      ? `The retained exact-token page does not establish the ${variant} narrative standard.`
      : 'This independent criterion could not be completed from the bounded test input.',
    citationIds: disposition === 'INSUFFICIENT' && citationId ? [citationId] : [],
    premises: [],
    representationWitnesses: [],
    posts: [],
    missingSupport: disposition === 'INSUFFICIENT'
      ? ['The retained body gives no substantive referent, interest, game, or mechanism.'] : [],
    unfinishedReason: disposition === 'UNFINISHED' ? 'The bounded fixture leaves this independent review unfinished.' : null,
  };
}

function criterionRows(packet: ProgramPacket, openIds: CriterionId[] = []): WireRow[] {
  const input = packet.input as ProgramPacket;
  return criterionIds.map(id => {
    if (openIds.includes(id)) return criterionRow(packet, id, 'UNFINISHED');
    return criterionRow(packet, id, input.criterionScopes?.[id]?.complete ? 'INSUFFICIENT' : 'UNFINISHED');
  });
}

function sharedResponse(packet: ProgramPacket) {
  const claims = packet.claims as Array<{ id: string; citations: Array<{ sourceId: string; quote: string }> }>;
  const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
  const citations = Object.fromEntries(claims.map(claim => {
    const original = claim.citations[0];
    const source = sources.find(item => item.id === original?.sourceId);
    assert.ok(source, `shared source for ${claim.id} exists`);
    const span = source.spans.find(item => item.text === original?.quote) ?? source.spans[0];
    assert.ok(span, `shared source ${source.id} has a retained span`);
    return [claim.id, span.id];
  }));
  const decisions = Object.fromEntries(claims.map(claim => [claim.id, {
    disposition: 'CLEAR',
    rationale: 'The inspected retained evidence contains no incompatible claim.',
    citations: [citations[claim.id]],
  }]));
  if (packet.proposal) {
    return {
      claims: Object.fromEntries(claims.map(claim => [claim.id, {
        proposalAccepted: true,
        final: { ...decisions[claim.id], support: 'INSUFFICIENT' },
      }])),
      sources: Object.fromEntries(sources.map(source => [source.id, {
        inspection: 'INSPECTED', relevance: source.id === claims[0]?.citations[0]?.sourceId ? 'POTENTIALLY_RELEVANT' : 'NO_RELEVANT_CLAIMS',
      }])),
    };
  }
  return { claims: decisions };
}

function syntheticFetcher(options: {
  failCriterionFinal?: boolean;
  malformedCriterionDraft?: boolean;
  malformedCriterionFinal?: boolean;
  openCriterionIds?: CriterionId[];
  persistentUnfinishedIds?: CriterionId[];
  socialCitationFailure?: boolean;
  failAcquisitionSearch?: boolean;
  emptyAcquisitionSearch?: boolean;
  dexPairs?: unknown;
  beforeCriterionModel?: (packet: ProgramPacket) => Promise<void> | void;
  afterCriterionModel?: (packet: ProgramPacket) => void;
  beforeSocialModel?: () => Promise<void> | void;
  afterSocialModel?: () => void;
} = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const criterionPackets: ProgramPacket[] = [];
  const sharedPackets: ProgramPacket[] = [];
  const otherModelPackets: ProgramPacket[] = [];
  const searchQueries: string[] = [];
  const fetchRequests: string[][] = [];
  let correctionOpenIds: CriterionId[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.startsWith('https://api.dexscreener.com/')) return jsonResponse(options.dexPairs ?? []);
    if (url.startsWith('https://api.search.tinyfish.ai/')) {
      const query = new URL(String(input)).searchParams.get('query') ?? '';
      searchQueries.push(query);
      if (options.failAcquisitionSearch) return jsonResponse({ error: 'synthetic required search outage' }, 503);
      if (options.emptyAcquisitionSearch) return jsonResponse({ results: [], errors: [] });
      if (query === `"${TOKEN.address}" base narrative origin catalyst`) {
        return jsonResponse({ results: [{ url: STORY_URL, title: 'Synthetic Cedar directory', snippet: `Directory entry for ${TOKEN.address}.` }], errors: [] });
      }
      return jsonResponse({ results: [], errors: [] });
    }
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const body = JSON.parse(String(init?.body)) as { urls?: unknown };
      const urls = Array.isArray(body.urls) ? body.urls.filter((item): item is string => typeof item === 'string') : [];
      fetchRequests.push(urls);
      return jsonResponse({ results: urls.map(requested => ({ url: requested, final_url: requested, text: BODY, published_date: null, links: [] })), errors: [] });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const packet = JSON.parse(request.contents[0]?.parts[0]?.text ?? '{}') as ProgramPacket;
      if (packet.method === criterionReviewMethod) {
        criterionPackets.push(packet);
        await options.beforeCriterionModel?.(packet);
        const stage = packet.stage;
        let response: Response;
        if (stage === 'draft' && options.malformedCriterionDraft) response = modelResponse('malformed JSON payload');
        else if (stage === 'draft') response = modelResponse({ rows: criterionRows(packet) });
        else if (stage === 'final' && options.failCriterionFinal) response = jsonResponse({ error: 'synthetic provider rejection' }, 429);
        else if (stage === 'final' && options.malformedCriterionFinal) {
          correctionOpenIds = ((packet.input as ProgramPacket).requiredIds as CriterionId[])
            .filter(id => (packet.input as ProgramPacket).criterionScopes[id]?.complete);
          response = modelResponse('malformed JSON payload');
        }
        else if (stage === 'final') {
          const forcedOpen = options.openCriterionIds ?? (options.emptyAcquisitionSearch ? [] : ['NAR-03']);
          const rows = criterionRows(packet, forcedOpen);
          correctionOpenIds = rows.flatMap(row => row.disposition === 'UNFINISHED'
            && (packet.input as ProgramPacket).criterionScopes[row.criterionId as CriterionId]?.complete
            ? [row.criterionId as CriterionId] : []);
          response = modelResponse({ rows });
        }
        else if (stage === 'correction') {
          const persistent = options.persistentUnfinishedIds ?? [];
          const correctionRows = correctionOpenIds.map(id => persistent.includes(id)
            ? criterionRow(packet, id, 'UNFINISHED', 'correction')
            : id === 'NAR-01'
              ? criterionRow(packet, id, 'INSUFFICIENT', 'attempted replacement')
              : criterionRow(packet, id, 'UNFINISHED', 'correction'));
          const replacementId = correctionOpenIds.includes('NAR-01') ? 'ATT-01' : 'NAR-01';
          correctionRows.push(criterionRow(packet, replacementId, 'INSUFFICIENT', 'attempted replacement'));
          response = modelResponse({ rows: correctionRows });
        }
        else throw new Error(`UNEXPECTED_CRITERION_STAGE_${String(stage)}`);
        options.afterCriterionModel?.(packet);
        return response;
      }
      if (Array.isArray(packet.claims) && Array.isArray(packet.sources)) {
        sharedPackets.push(packet);
        return modelResponse(sharedResponse(packet));
      }
      otherModelPackets.push(packet);
      if (Array.isArray(packet.requiredPostIds) && Array.isArray(packet.bindingInventory)) await options.beforeSocialModel?.();
      if (options.socialCitationFailure && Array.isArray(packet.requiredPostIds) && Array.isArray(packet.bindingInventory)) {
        const missingCitations = {
          verdict: 'SUPPORTED',
          rationale: 'Synthetic model draft omitted the required source selectors.',
          citations: [],
        };
        const response = modelResponse({
          identityAssessment: missingCitations,
          integrityAssessment: missingCitations,
          participationAssessment: missingCitations,
          communityBreadthAssessment: missingCitations,
          posts: [],
          identities: [],
          accounts: [],
        });
        options.afterSocialModel?.();
        return response;
      }
      // Unknown legacy/optional programs fail as an ordinary invalid HTTP-200 response.
      const response = modelResponse({});
      if (Array.isArray(packet.requiredPostIds) && Array.isArray(packet.bindingInventory)) options.afterSocialModel?.();
      return response;
    }
    throw new Error(`UNEXPECTED_TEST_REQUEST_${url}`);
  };
  return { fetcher, requests, criterionPackets, sharedPackets, otherModelPackets, searchQueries, fetchRequests };
}

function firecrawlFallbackFetcher(base: typeof fetch, resultUrls = [STORY_URL], options: {
  searchStatus?: number; scrapeStatus?: number; failSearch?: (query: string) => boolean; dexPairs?: unknown;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let failedSearchQuery: string | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (options.dexPairs !== undefined && url.startsWith('https://api.dexscreener.com/')) return jsonResponse(options.dexPairs);
    if (url.startsWith('https://api.search.tinyfish.ai/')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      const shouldFail = options.failSearch ? options.failSearch(query) : query.startsWith(`"${TOKEN.address}" base`);
      if (shouldFail) {
        failedSearchQuery = query;
        return jsonResponse({ error: 'synthetic search outage' }, 503);
      }
    }
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const request = JSON.parse(String(init?.body)) as { urls?: unknown };
      const urls = Array.isArray(request.urls) ? request.urls.filter((item): item is string => typeof item === 'string') : [];
      return jsonResponse({ results: [], errors: urls.map(pageUrl => ({ url: pageUrl, status: 404, error: 'not found' })) });
    }
    if (url === 'https://api.firecrawl.dev/v2/search' || url === 'https://api.firecrawl.dev/v2/scrape') {
      calls.push({ url, init });
      if (url.endsWith('/search')) return jsonResponse({ success: true, data: { web: resultUrls.map((pageUrl, index) => ({
        url: pageUrl, title: `Synthetic Firecrawl result ${index + 1}`, description: 'A retained public page result.',
      })) } }, options.searchStatus ?? 200);
      const request = JSON.parse(String(init?.body)) as { url: string };
      return jsonResponse({ success: true, data: { markdown: BODY, metadata: { statusCode: 200, url: request.url, sourceURL: request.url } } }, options.scrapeStatus ?? 200);
    }
    return base(input, init);
  };
  return { fetcher, calls, get failedSearchQuery() { return failedSearchQuery; } };
}

test('fresh Live criterion review is dispatched, admitted, shared, reported and replayed from a temp database', async _t => {
  const mock = syntheticFetcher({ malformedCriterionDraft: true });
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-synthetic-secret',
    geminiKey: 'gemini-criterion-success-secret',
    fetcher: mock.fetcher,
    now: () => NOW,
    runtime: { nowMs: () => Date.parse(NOW), timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
  });

  assert.equal(mock.criterionPackets.filter(packet => packet.stage === 'draft').length, 1);
  assert.equal(mock.criterionPackets.filter(packet => packet.stage === 'final').length, 1);
  assert.equal(mock.criterionPackets.filter(packet => packet.stage === 'correction').length, 1,
    'only the one invalid sibling is corrected once');
  assert.ok(bundle.rawArtifacts['criterion-draft-invalid'], 'a malformed draft is retained as untrusted input while final review continues');
  assert.ok(bundle.rawArtifacts['criterion-draft-response'], 'the actual malformed HTTP-200 draft is retained');
  assert.ok(bundle.rawArtifacts['criterion-final-prompt'] && bundle.rawArtifacts['criterion-final-response'],
    'a malformed draft causes an actual independent final review');
  assert.ok(bundle.rawArtifacts['criterion-correction-prompt'] && bundle.rawArtifacts['criterion-correction-response'],
    'the actual malformed final row causes exactly one correction request');
  assert.deepEqual(mock.criterionPackets.map(packet => packet.stage), ['draft', 'final', 'correction']);
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED', 'fresh criteria do not require the optional legacy factual packet');
  assert.deepEqual(bundle.semantic.claims, []);
  assert.ok(mock.otherModelPackets.every(packet => Array.isArray(packet.requiredPostIds) && !!packet.bindingInventory),
    `non-criterion calls are isolated Social work; no legacy factual packet is dispatched: ${JSON.stringify(mock.otherModelPackets.map(packet => Object.keys(packet)))}`);
  const canonicalInput = JSON.parse(bundle.rawArtifacts['criterion-input']!) as CriterionInput;
  const sourceRead = {
    ...JSON.parse(bundle.rawArtifacts['criterion-source-read']!),
    rawArtifacts: bundle.rawArtifacts,
  } as Parameters<typeof decodeCriterionAttention>[0];
  const providerReceipt = decodeCriterionAttention(sourceRead, TOKEN,
    JSON.parse(bundle.rawArtifacts['criterion-receipt']!).qualifiedAt, bundle.rawArtifacts);
  assert.deepEqual(bundle.details?.criteria, providerReceipt,
    'the collector projection must exactly match the independently replayed provider receipt');
  assert.equal(canonicalInput.sources.find(row => row.url === STORY_URL)?.text, BODY,
    `the code-owned input round-trips literal newline bytes; searches=${JSON.stringify(mock.searchQueries)} sources=${JSON.stringify(canonicalInput.sources.map(row => row.url))}`);
  assert.equal(bundle.rawArtifacts['criterion-final-response'] !== undefined, true);
  assert.equal(bundle.details?.criteria?.results.find(row => row.criterionId === 'NAR-01')?.rationale,
    'The retained exact-token page does not establish the final narrative standard.',
    `a correction cannot replace an accepted final row; result=${JSON.stringify(bundle.details?.criteria?.results.find(row => row.criterionId === 'NAR-01'))} scope=${JSON.stringify(canonicalInput.criterionScopes['NAR-01'])}`);
  assert.equal(bundle.details?.criteria?.results.find(row => row.criterionId === 'NAR-03')?.evaluationState, 'UNAVAILABLE');
  assert.ok(mock.sharedPackets.length >= 2, 'Shared receives and independently audits completed judgments despite unrelated unavailable criteria');
  assert.ok(bundle.rawArtifacts['shared-qualified-receipt']);

  const dir = mkdtempSync(join(tmpdir(), 'criterion-live-admission-'));
  const database = join(dir, 'fresh.sqlite');
  let service = new Service(database);
  try {
    const saved = service.analyzeLive(bundle);
    const report = buildEntryReport(saved);
    const narrative = report.checks.find(row => row.checkId === 'NAR-01');
    assert.equal(narrative?.outcome, 'INSUFFICIENT');
    assert.equal(narrative?.basis, 'PUBLIC_SUPPORT_INADEQUATE');
    assert.ok(report.checks.some(row => row.checkId === 'NAR-03' && row.outcome === 'UNKNOWN'),
      'unavailable sibling remains unknown rather than inheriting a legacy fact');
    assert.equal(service.replay(saved.id).hash, saved.hash);
    service.close();
    service = new Service(database);
    assert.equal(service.replay(saved.id).hash, saved.hash, 'the admitted fresh receipt reopens and replays offline');
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const changed = structuredClone(bundle);
  const source = changed.evidence.find(row => row.id === 'attention-page-1');
  assert.ok(source);
  const fakeBody = BODY + '\nRehashed source-only tampering.';
  changed.rawArtifacts['attention-page-1'] = fakeBody;
  source.contentHash = createHash('sha256').update(fakeBody).digest('hex');
  const tamperDir = mkdtempSync(join(tmpdir(), 'criterion-live-tamper-'));
  const tamperService = new Service(join(tamperDir, 'tampered.sqlite'));
  try {
    assert.throws(() => tamperService.analyzeLive(changed), /CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID/,
      're-hashing the source artifact cannot make it agree with its independently retained producer result');

    const responseTamper = structuredClone(bundle);
    const finalResponse = JSON.parse(responseTamper.rawArtifacts['criterion-final-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    finalResponse.candidates[0]!.content.parts[0]!.text += ' ';
    const changedResponse = JSON.stringify(finalResponse);
    responseTamper.rawArtifacts['criterion-final-response'] = changedResponse;
    const responseEvidence = responseTamper.evidence.find(row => row.id === 'criterion-final-response');
    assert.ok(responseEvidence);
    responseEvidence.contentHash = createHash('sha256').update(changedResponse).digest('hex');
    assert.throws(() => tamperService.analyzeLive(responseTamper), /LIVE_PROVENANCE_INVALID/,
      're-hashing model output cannot transfer ownership away from its bound provider response receipt');

    const transformTamper = structuredClone(bundle);
    const changedSourceRead = JSON.parse(transformTamper.rawArtifacts['criterion-source-read']!) as ProgramPacket;
    changedSourceRead.sourceBindings[0].transform = 'FUTURE_UNSUPPORTED_TRANSFORM';
    transformTamper.rawArtifacts['criterion-source-read'] = JSON.stringify(changedSourceRead);
    const changedAttentionReceipt = JSON.parse(transformTamper.rawArtifacts['attention-qualified-receipt']!) as ProgramPacket;
    changedAttentionReceipt.read.sourceBindings[0].transform = 'FUTURE_UNSUPPORTED_TRANSFORM';
    transformTamper.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(changedAttentionReceipt);
    for (const id of ['criterion-source-read', 'attention-qualified-receipt']) {
      const evidence = transformTamper.evidence.find(row => row.id === id);
      assert.ok(evidence, `${id} evidence exists`);
      evidence.contentHash = createHash('sha256').update(transformTamper.rawArtifacts[id]!).digest('hex');
    }
    assert.throws(() => tamperService.analyzeLive(transformTamper), /CRITERION_SOURCE_INVALID/,
      'a runtime-forged transform is rejected even when both retained read receipts and evidence hashes agree');

    const replaceArtifact = (changedBundle: typeof bundle, id: string, raw: string) => {
      changedBundle.rawArtifacts[id] = raw;
      const evidence = changedBundle.evidence.find(row => row.id === id);
      assert.ok(evidence, `${id} evidence exists`);
      evidence.contentHash = createHash('sha256').update(raw).digest('hex');
    };
    const mutateBothReads = (changedBundle: typeof bundle, mutate: (read: ProgramPacket) => void) => {
      const sourceRead = JSON.parse(changedBundle.rawArtifacts['criterion-source-read']!) as ProgramPacket;
      const qualified = JSON.parse(changedBundle.rawArtifacts['attention-qualified-receipt']!) as ProgramPacket;
      mutate(sourceRead);
      mutate(qualified.read);
      replaceArtifact(changedBundle, 'criterion-source-read', JSON.stringify(sourceRead));
      replaceArtifact(changedBundle, 'attention-qualified-receipt', JSON.stringify(qualified));
    };

    const metadataTamper = structuredClone(bundle);
    const originalRead = JSON.parse(metadataTamper.rawArtifacts['criterion-source-read']!) as ProgramPacket;
    const originalBinding = originalRead.sourceBindings[0] as { producerArtifactId: string; resultIndex: number };
    const producer = JSON.parse(metadataTamper.rawArtifacts[originalBinding.producerArtifactId]!) as ProgramPacket;
    producer.results[originalBinding.resultIndex].published_date = '2026-10-28T12:00:00.000Z';
    replaceArtifact(metadataTamper, originalBinding.producerArtifactId, JSON.stringify(producer));
    assert.throws(() => tamperService.analyzeLive(metadataTamper), /CRITERION_SOURCE_INVALID/,
      'a forged producer publication date cannot change the collector-owned source metadata after its hash is recomputed');

    const orderTamper = structuredClone(bundle);
    mutateBothReads(orderTamper, read => {
      read.sources[0].id = 'attention-page-2';
      read.sourceBindings[0].sourceId = 'attention-page-2';
    });
    assert.throws(() => tamperService.analyzeLive(orderTamper), /CRITERION_SOURCE_INVALID/,
      'renumbering the first accepted page cannot make source order self-consistent');

    const markerTamper = structuredClone(bundle);
    mutateBothReads(markerTamper, read => { read.criterionReviewMethod = 'criterion-review-future'; });
    assert.throws(() => tamperService.analyzeLive(markerTamper), /CRITERION_PROOF_INVALID/,
      'fresh marker tampering cannot fall back into the legacy admission path');

    const legacyDowngrade = structuredClone(bundle);
    const stripMarkers = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripMarkers);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'criterionReviewMethod' && key !== 'acquisitionPurposeMethod')
        .map(([key, nested]) => [key, stripMarkers(nested)]));
    };
    for (const id of [
      'criterion-source-read', 'attention-qualified-receipt', 'criterion-input', 'criterion-receipt',
      'attention-acquisition-scope', 'attention-scope', 'social-acquisition-scope', 'social-derivation',
    ]) {
      const raw = legacyDowngrade.rawArtifacts[id];
      assert.equal(typeof raw, 'string', `${id} canonical source artifact exists`);
      const stripped = JSON.stringify(stripMarkers(JSON.parse(raw)));
      assert.notEqual(stripped, raw, `${id} carries a canonical review or purpose marker`);
      replaceArtifact(legacyDowngrade, id, stripped);
    }
    legacyDowngrade.details = stripMarkers(legacyDowngrade.details) as typeof legacyDowngrade.details;
    assert.throws(() => tamperService.analyzeLive(legacyDowngrade), /CRITERION_PROOF_INVALID|SOCIAL_PROOF_REQUIRED/,
      'removing both method markers from canonical reads, details, and rehashed source artifacts cannot downgrade a fresh bundle into legacy admission');
  } finally {
    tamperService.close();
    rmSync(tamperDir, { recursive: true, force: true });
  }
});

test('fresh criterion provider outage persists as explicit unavailable judgments instead of a command failure', async () => {
  const mock = syntheticFetcher({ failCriterionFinal: true });
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-synthetic-secret',
    geminiKey: 'gemini-criterion-outage-secret',
    fetcher: mock.fetcher,
    now: () => NOW,
    runtime: { nowMs: () => Date.parse(NOW), timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
  });

  const failure = JSON.parse(bundle.rawArtifacts['criterion-failure']!) as { stage: string; code: string };
  assert.equal(failure.stage, 'final');
  assert.match(failure.code, /^CRITERION_MODEL_/);
  assert.ok(bundle.details?.criteria?.results.every(row => row.evaluationState === 'UNAVAILABLE'));
  assert.ok(bundle.details?.criteria?.results.every(row => row.failure?.code === failure.code));

  const dir = mkdtempSync(join(tmpdir(), 'criterion-live-outage-'));
  const service = new Service(join(dir, 'outage.sqlite'));
  try {
    const saved = service.analyzeLive(bundle);
    const report = buildEntryReport(saved);
    assert.ok(report.checks.filter(row => row.checkId.startsWith('NAR-')).every(row => row.outcome === 'UNKNOWN'));
    assert.ok(!report.completion.blockers.some(row => row.code === 'COMMAND_FAILED'));
    assert.equal(service.replay(saved.id).hash, saved.hash);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all required criterion acquisition scopes blocked skips model review and replays only collection causes', async () => {
  const mock = syntheticFetcher({ failAcquisitionSearch: true });
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-synthetic-secret',
    geminiKey: 'gemini-blocked-scopes-secret',
    fetcher: mock.fetcher,
    now: () => NOW,
    runtime: { nowMs: () => Date.parse(NOW), timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
  });

  assert.ok(mock.searchQueries.length >= 2, 'both code-required discovery and Social sampling operations are attempted');
  assert.equal(mock.criterionPackets.length, 0, 'the collector does not call the criterion model when every required scope is operationally blocked');
  assert.equal(Object.keys(bundle.rawArtifacts).some(id => /^criterion-(?:draft|final|correction)(?:-|$)/.test(id)), false,
    'no draft, final, correction, or model-failure artifact is fabricated');
  assert.equal(bundle.rawArtifacts['criterion-failure'], undefined);
  const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as CriterionInput;
  assert.ok(input.requiredIds.every(id => !input.criterionScopes[id].complete));
  assert.ok(input.criterionScopes['NAR-01'].failures.includes('ATT_SEARCH_HTTP_503'),
    'the reconstructed criterion scope keeps the actual provider HTTP failure');
  assert.ok(bundle.details?.criteria?.results.every(row => row.evaluationState === 'UNAVAILABLE'
    && row.outcome === null && row.failure?.category === 'COLLECTION'
    && row.failure.code === 'ATT_SEARCH_HTTP_503'),
  'every unavailable row reports the acquisition failure, never a model failure or negative finding');
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED');

  const dir = mkdtempSync(join(tmpdir(), 'criterion-live-blocked-scopes-'));
  const database = join(dir, 'blocked.sqlite');
  const service = new Service(database);
  let saved: ReturnType<Service['analyzeLive']>;
  try {
    saved = service.analyzeLive(bundle);
    assert.equal(saved.result.classification, 'INSUFFICIENT_DATA');
    assert.ok(buildEntryReport(saved).checks.filter(row => row.checkId.startsWith('NAR-'))
      .every(row => row.outcome === 'UNKNOWN'));
    assert.equal(service.replay(saved.id).hash, saved.hash);
  } finally { service.close(); }
  const reopened = new Service(database);
  try {
    assert.equal(reopened.replay(saved.id).hash, saved.hash, 'the actual collection failure and no-call receipt survive offline replay');
  } finally { reopened.close(); }

  const bypass = structuredClone(bundle);
  const forgedPrompt = '{"method":"criterion-review-v1","stage":"draft","forged":true}';
  bypass.rawArtifacts['criterion-draft-prompt'] = forgedPrompt;
  const criterionInputEvidence = bypass.evidence.find(row => row.id === 'criterion-input');
  assert.ok(criterionInputEvidence);
  bypass.evidence.push({ ...criterionInputEvidence, id: 'criterion-draft-prompt',
    contentHash: createHash('sha256').update(forgedPrompt).digest('hex') });
  const tamperDir = mkdtempSync(join(tmpdir(), 'criterion-live-blocked-bypass-'));
  const verifier = new Service(join(tamperDir, 'bypass.sqlite'));
  try {
    assert.throws(() => verifier.analyzeLive(bypass), /CRITERION_PROOF_INVALID|CRITERION_PROOF_REQUIRED/,
      'a rehashed or injected model phase cannot bypass the reconstructed all-blocked acquisition scope');
  } finally {
    verifier.close();
    rmSync(tamperDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete empty acquisition still receives the real two-pass insufficiency review', async () => {
  const mock = syntheticFetcher({ emptyAcquisitionSearch: true });
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-synthetic-secret',
    geminiKey: 'gemini-empty-scope-secret',
    fetcher: mock.fetcher,
    now: () => NOW,
    runtime: { nowMs: () => Date.parse(NOW), timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
  });

  const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as CriterionInput;
  assert.equal(input.sources.length, 0, 'the bounded search returned successfully with no source bodies');
  assert.ok(input.requiredIds.every(id => input.criterionScopes[id].complete),
    'a completed empty acquisition is not treated as an operational failure');
  assert.deepEqual(mock.criterionPackets.map(packet => packet.stage), ['draft', 'final'],
    'the accounted no-results purpose receipt lets the independent final review decide an empty bounded scope without a correction');
  assert.equal(bundle.rawArtifacts['criterion-failure'], undefined);
  const narrative = bundle.details?.criteria?.results.find(row => row.criterionId === 'NAR-01');
  assert.equal(narrative?.evaluationState, 'COMPLETED');
  assert.equal(narrative?.outcome, 'INSUFFICIENT',
    'a real completed review of the empty scope may conclude insufficient support');
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
  const directory = mkdtempSync(join(tmpdir(), 'criterion-live-empty-scope-'));
  const service = new Service(join(directory, 'empty.sqlite'));
  try {
    const saved = service.analyzeLive(bundle);
    assert.equal(service.replay(saved.id).hash, saved.hash);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed final response is retained as untrusted input for one correction without importing its rows', async () => {
  const mock = syntheticFetcher({ malformedCriterionFinal: true });
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-synthetic-secret',
    geminiKey: 'gemini-criterion-malformed-secret',
    fetcher: mock.fetcher,
    now: () => NOW,
    runtime: { nowMs: () => Date.parse(NOW), timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
  });

  assert.ok(bundle.rawArtifacts['criterion-final-invalid']);
  assert.equal(mock.criterionPackets.filter(packet => packet.stage === 'final').length, 1);
  assert.equal(mock.criterionPackets.filter(packet => packet.stage === 'correction').length, 1);
  const correction = mock.criterionPackets.find(packet => packet.stage === 'correction');
  assert.equal(correction?.invalidFinalResponse, bundle.rawArtifacts['criterion-final-response']);
  const rows = bundle.details?.criteria?.results ?? [];
  assert.match(rows.find(row => row.criterionId === 'NAR-01')?.rationale ?? '', /attempted replacement/);
  assert.equal(rows.find(row => row.criterionId === 'NAR-02')?.evaluationState, 'UNAVAILABLE',
    'the malformed final contributes no accepted sibling rows');

  const dir = mkdtempSync(join(tmpdir(), 'criterion-live-malformed-final-'));
  const service = new Service(join(dir, 'malformed-final.sqlite'));
  try {
    const saved = service.analyzeLive(bundle);
    assert.equal(service.replay(saved.id).hash, saved.hash);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('six capture-derived UNFINISHED rows receive one correction and remain model-unknown', async () => {
  const mock = syntheticFetcher({
    openCriterionIds: CAPTURE_UNFINISHED_CRITERIA,
    persistentUnfinishedIds: CAPTURE_UNFINISHED_CRITERIA,
  });
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-capture-derived-secret',
    geminiKey: 'gemini-capture-derived-secret',
    fetcher: mock.fetcher,
    now: () => NOW,
    runtime: { nowMs: () => Date.parse(NOW), timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
  });

  assert.deepEqual(mock.criterionPackets.map(packet => packet.stage), ['draft', 'final', 'correction'],
    'six unfinished legacy rows still use only one bounded correction stage');
  const correction = mock.criterionPackets.find(packet => packet.stage === 'correction')!;
  assert.deepEqual(Object.keys(correction.questions as Record<string, unknown>).sort(), [...CAPTURE_UNFINISHED_CRITERIA].sort(),
    'the correction packet contains exactly the six open IDs mapped from the captured legacy UNAVAILABLE rows');
  assert.deepEqual(Object.keys(correction.unresolved as Record<string, unknown>).sort(), [...CAPTURE_UNFINISHED_CRITERIA].sort());
  assert.ok((correction.accepted as string[]).includes('ATT-01'), 'completed siblings are identified as frozen');

  const input = JSON.parse(bundle.rawArtifacts['criterion-input']!) as CriterionInput;
  assert.ok(CAPTURE_UNFINISHED_CRITERIA.every(id => input.criterionScopes[id].complete),
    'the fixture opens model review only for these six rows; no collection failure is substituted');
  const receipt = decodeCriterionAttention(
    { ...JSON.parse(bundle.rawArtifacts['criterion-source-read']!), rawArtifacts: bundle.rawArtifacts },
    TOKEN,
    JSON.parse(bundle.rawArtifacts['criterion-receipt']!).qualifiedAt,
    bundle.rawArtifacts,
  );
  for (const id of CAPTURE_UNFINISHED_CRITERIA) {
    const row = receipt.results.find(result => result.criterionId === id);
    assert.deepEqual([row?.evaluationState, row?.outcome, row?.failure?.category, row?.failure?.code],
      ['UNAVAILABLE', null, 'MODEL', 'CRITERION_REVIEW_UNFINISHED'], `${id} stays honestly unresolved after one unfinished correction`);
  }
  const acceptedAttention = receipt.results.find(result => result.criterionId === 'ATT-01')!;
  assert.equal(acceptedAttention.outcome, 'INSUFFICIENT');
  assert.doesNotMatch(acceptedAttention.rationale, /attempted replacement/,
    'the correction cannot replace an already accepted sibling even when it returns an extra row');
  assert.equal(bundle.semantic.status, 'NOT_REQUESTED');
});

test('invalid Social citations remain unavailable while independent fresh criteria and Shared audit still complete', async () => {
  const mock = syntheticFetcher({ socialCitationFailure: true });
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-synthetic-secret',
    geminiKey: 'gemini-social-citation-failure-secret',
    fetcher: mock.fetcher,
    now: () => NOW,
    runtime: { nowMs: () => Date.parse(NOW), timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
  });

  const socialFailure = JSON.parse(bundle.rawArtifacts['live-run-scope']!) as {
    stages: Array<{ phase: string; status: string; code?: string }>;
  };
  const socialStage = socialFailure.stages.find(stage => stage.phase === 'SOCIAL');
  assert.equal(socialStage?.status, 'FAILED');
  assert.equal(socialStage?.code, 'SOC_CITATION_INVALID', 'the production selector validator reports the model failure');
  assert.ok(bundle.rawArtifacts['social-proposal-response']);
  assert.ok(bundle.rawArtifacts['social-selector-repair-response'], 'one invalid selector repair is retained before the final failure');
  const socialRows = bundle.details?.baseline.filter(row => row.id.startsWith('S')) ?? [];
  assert.ok(socialRows.length > 0, 'the fixture retains the deterministic Social baseline');
  const socialIdentity = socialRows.find(row => row.id === 'S01');
  assert.equal(socialIdentity?.quality, 'MISSING', JSON.stringify(socialRows));
  assert.equal(socialIdentity?.causes?.[0]?.code, 'SOC_CITATION_INVALID', JSON.stringify(socialRows));
  assert.equal(bundle.details?.social?.identityReview, undefined);
  assert.equal(bundle.details?.social?.integrityReview, undefined);
  assert.equal(bundle.details?.social?.participationReview, undefined);
  assert.equal(bundle.details?.social?.communityBreadthReview, undefined);

  assert.equal(bundle.semantic.status, 'NOT_REQUESTED', 'fresh criteria remain independent of optional Social model failure');
  assert.equal(bundle.details?.criteria?.results.length, criterionIds.length);
  assert.equal(bundle.details?.criteria?.results.find(row => row.criterionId === 'NAR-01')?.outcome, 'INSUFFICIENT');
  assert.ok(bundle.rawArtifacts['shared-qualified-receipt'], 'Shared receives and completes the independent criterion audit');
  assert.ok(mock.sharedPackets.length >= 2);
  const sharedReceipt = JSON.parse(bundle.rawArtifacts['shared-qualified-receipt']!) as {
    claims: Array<{ criterionReviewContext?: { criterionId: string; outcome: string } }>;
    audit: { claims: Array<{ id: string }> };
  };
  assert.ok(sharedReceipt.claims.some(claim => claim.criterionReviewContext?.criterionId === 'NAR-01'),
    'Shared audits the completed narrative result even though Social review failed');
  assert.ok(!sharedReceipt.claims.some(claim => claim.criterionReviewContext?.criterionId === 'NAR-03'),
    'Shared does not turn an unavailable sibling into a completed claim');
  assert.equal(sharedReceipt.audit.claims.length, sharedReceipt.claims.length,
    'the accepted Shared receipt includes an independent final for each claim in its consumed scope');

  const dir = mkdtempSync(join(tmpdir(), 'criterion-social-failure-'));
  const service = new Service(join(dir, 'social-failure.sqlite'));
  try {
    const saved = service.analyzeLive(bundle);
    const report = buildEntryReport(saved);
    const narrativeJudgment = report.checks.find(row => row.checkId === 'NAR-01');
    const narrativeResult = saved.details?.criteria?.results.find(row => row.criterionId === 'NAR-01');
    assert.equal(narrativeJudgment?.outcome, 'INSUFFICIENT');
    assert.deepEqual(narrativeJudgment?.criterionJudgment, {
      outcome: narrativeResult?.outcome,
      basis: narrativeResult?.basis,
      rationale: narrativeResult?.rationale,
      reviewerMissingSupport: narrativeResult?.proof.missingSupport,
    }, 'fresh criterion rationale and reviewer gap assertions are directly available in the report check');
    for (const checkId of ['SOC-01', 'SOC-02', 'SOC-03']) {
      const check = report.checks.find(row => row.checkId === checkId);
      assert.equal(check?.outcome, 'UNKNOWN', `${checkId} remains unavailable after the failed Social citation review`);
      assert.ok(check?.causes.some(cause => cause.code === 'SOC_CITATION_INVALID'), `${checkId} retains the producer failure cause`);
    }
    assert.equal(service.replay(saved.id).hash, saved.hash);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Social dependency closure is stable when Social and criterion review finish in either order', async () => {
  const timeline: string[] = [];
  let tick = 0;
  const base = Date.parse('2026-10-29T12:00:00.000Z');
  const waitFor = <T>(promise: Promise<T>, label: string, order: string) => new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${order}_${label}_BARRIER_TIMEOUT: ${timeline.join(', ')}`)), 10_000);
    promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });

  for (const order of ['SOCIAL_FIRST', 'CRITERIA_FIRST'] as const) {
    const socialReady = deferred<void>();
    const criteriaReady = deferred<void>();
    let socialResponses = 0;
    let criteriaCorrectionReturned = false;
    const model = syntheticFetcher({
      socialCitationFailure: true,
      beforeCriterionModel: async () => {
        if (order === 'SOCIAL_FIRST') await waitFor(socialReady.promise, 'SOCIAL', order);
      },
      afterCriterionModel: packet => {
        timeline.push(`${order}:criterion-${String(packet.stage)}-response`);
        if (order === 'CRITERIA_FIRST' && packet.stage === 'correction' && !criteriaCorrectionReturned) {
          criteriaCorrectionReturned = true;
          setImmediate(() => criteriaReady.resolve());
        }
      },
      beforeSocialModel: async () => {
        if (order === 'CRITERIA_FIRST') await waitFor(criteriaReady.promise, 'CRITERIA', order);
      },
      afterSocialModel: () => {
        socialResponses++;
        timeline.push(`${order}:social-model-${socialResponses}`);
        if (order === 'SOCIAL_FIRST' && socialResponses === 2) setImmediate(() => socialReady.resolve());
      },
    });
    const now = () => new Date(base + ++tick).toISOString();
    const bundle = await collectLiveToken(TOKEN, {
      profile: PROFILE,
      semanticEnabled: true,
      tinyfishKey: `tinyfish-chronology-${order.toLowerCase()}-secret`,
      geminiKey: `gemini-chronology-${order.toLowerCase()}-secret`,
      fetcher: model.fetcher,
      now,
      runtime: { nowMs: () => base + tick, timeout: ms => AbortSignal.timeout(ms), wait: async () => {} },
    });

    const socialPacket = JSON.parse(bundle.rawArtifacts['social-derivation']!) as {
      read: { qualifiedAt?: string };
      evidenceIds: string[];
    };
    const laterCriterion = bundle.evidence.find(row => row.id === 'criterion-final-response');
    assert.ok(laterCriterion, 'the final criterion model response has a real producer record');
    assert.ok(socialPacket.read.qualifiedAt);
    assert.ok(!socialPacket.evidenceIds.includes(laterCriterion.id),
      'the Social closure includes its own frozen sources and receipts, not unrelated criterion model evidence');
    assert.ok(socialPacket.evidenceIds.includes('social-attention-seed'));
    const socialTime = Date.parse(socialPacket.read.qualifiedAt);
    const criterionTime = Date.parse(laterCriterion.availableAt);
    if (order === 'SOCIAL_FIRST') {
      assert.ok(socialTime < criterionTime, `${socialPacket.read.qualifiedAt} !< ${laterCriterion.availableAt}; ${timeline.join(', ')}`);
    } else {
      assert.ok(criterionTime < socialTime, `${laterCriterion.availableAt} !< ${socialPacket.read.qualifiedAt}; ${timeline.join(', ')}`);
    }

    const service = new Service(':memory:');
    try {
      const saved = service.analyzeLive(bundle);
      assert.equal(service.replay(saved.id).hash, saved.hash, `${order} bundle admits and replays offline`);
      if (order === 'SOCIAL_FIRST') {
        const lateDependency = structuredClone(bundle);
        const lateSocialPacket = JSON.parse(lateDependency.rawArtifacts['social-derivation']!) as { evidenceIds: string[] };
        lateSocialPacket.evidenceIds.push(laterCriterion.id);
        const raw = JSON.stringify(lateSocialPacket);
        lateDependency.rawArtifacts['social-derivation'] = raw;
        const record = lateDependency.evidence.find(row => row.id === 'social-derivation');
        assert.ok(record);
        record.contentHash = createHash('sha256').update(raw).digest('hex');
        assert.throws(() => service.analyzeLive(lateDependency), /SOCIAL_PROOF_INVALID/,
          'Service rejects a genuinely later criterion response when it is forged into the consumed Social dependency set');
      }
    } finally {
      service.close();
    }
  }
});

test('Firecrawl search and scrape recovery retains native provenance through Service admission and replay', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const runtime = {
    nowMs: () => Date.now(),
    timeout: (ms: number) => AbortSignal.timeout(ms),
    wait: async (ms: number) => { t.mock.timers.tick(ms); },
  };
  const model = syntheticFetcher();
  const pages = [STORY_URL, 'https://public.example/cedar-context', 'https://public.example/cedar-notes'];
  const fallback = firecrawlFallbackFetcher(model.fetcher, pages);
  const bundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-firecrawl-synthetic-secret',
    firecrawlKey: 'firecrawl-synthetic-secret',
    geminiKey: 'gemini-firecrawl-recovery-secret',
    fetcher: fallback.fetcher,
    now: () => NOW,
    runtime,
  });

  assert.equal(fallback.calls.filter(call => call.url.endsWith('/search')).length, 1);
  assert.equal(fallback.calls.filter(call => call.url.endsWith('/scrape')).length, 2,
    'the shared Attention runtime caps Firecrawl scrapes at two per analysis');
  assert.ok(bundle.rawArtifacts['firecrawl-search-1']);
  assert.ok(bundle.rawArtifacts['firecrawl-search-1-request']);
  assert.ok(bundle.rawArtifacts['firecrawl-scrape-1']);
  assert.ok(bundle.rawArtifacts['firecrawl-scrape-1-request']);
  assert.equal(bundle.rawArtifacts['firecrawl-scrape-2'] !== undefined, true);
  const searchOperation = JSON.parse(bundle.rawArtifacts['firecrawl-search-1-request']!) as {
    status: string; httpStatus: number; request: { operation: string; query: string }; replacesSearchId: string;
  };
  assert.deepEqual({ status: searchOperation.status, httpStatus: searchOperation.httpStatus, operation: searchOperation.request.operation, replaces: searchOperation.replacesSearchId }, {
    status: 'OBSERVED', httpStatus: 200, operation: 'SEARCH', replaces: 'attention-search-1',
  });
  const firecrawlSearchRequest = JSON.parse(String(fallback.calls.find(call => call.url.endsWith('/search'))?.init?.body)) as { query: string };
  assert.equal(fallback.failedSearchQuery, firecrawlSearchRequest.query,
    'Firecrawl receives exactly the failed bounded TinyFish query without generic substitution');
  assert.equal(searchOperation.request.query, fallback.failedSearchQuery);
  assert.ok(firecrawlSearchRequest.query.includes(TOKEN.address), 'the exact-token selector remains in the recovered search request');
  assert.ok(firecrawlSearchRequest.query.length <= 2_000, 'the exact query stays within Firecrawl’s bounded input contract');
  const sourceRead = JSON.parse(bundle.rawArtifacts['criterion-source-read']!) as ProgramPacket;
  const bindings = sourceRead.sourceBindings as Array<{ sourceId: string; producerArtifactId: string; resultIndex: number; transform: string }>;
  assert.deepEqual(bindings.filter(binding => binding.producerArtifactId.startsWith('firecrawl-scrape-')).map(binding => binding.producerArtifactId), [
    'firecrawl-scrape-1', 'firecrawl-scrape-2',
  ], 'only the first two failed fetches receive source-owned native scrape results');
  assert.ok(bindings.filter(binding => binding.producerArtifactId.startsWith('firecrawl-scrape-')).every(binding =>
    binding.resultIndex === 0 && binding.transform === 'IDENTITY'));
  assert.equal(sourceRead.sources.find((source: ProgramPacket) => source.url === STORY_URL)?.text, BODY);
  for (const id of ['firecrawl-search-1', 'firecrawl-scrape-1', 'firecrawl-scrape-2']) {
    assert.ok(bundle.evidence.some(row => row.id === id && row.sourceId === 'firecrawl'), `${id} has native Firecrawl evidence ownership`);
  }
  assert.doesNotMatch(JSON.stringify(bundle), /firecrawl-synthetic-secret/);

  const dir = mkdtempSync(join(tmpdir(), 'criterion-firecrawl-admission-'));
  const database = join(dir, 'firecrawl.sqlite');
  let service = new Service(database);
  try {
    const saved = service.analyzeLive(bundle);
    assert.equal(service.replay(saved.id).hash, saved.hash);
    service.close();
    service = new Service(database);
    assert.equal(service.replay(saved.id).hash, saved.hash, 'native search/scrape receipts replay from the admitted source read');

    const replaceArtifact = (changed: typeof bundle, id: string, raw: string) => {
      changed.rawArtifacts[id] = raw;
      const evidence = changed.evidence.find(row => row.id === id);
      assert.ok(evidence, `${id} is retained as evidence`);
      evidence.contentHash = createHash('sha256').update(raw).digest('hex');
    };
    const rawTamper = structuredClone(bundle);
    const scrape = JSON.parse(rawTamper.rawArtifacts['firecrawl-scrape-1']!) as ProgramPacket;
    scrape.data.markdown = `${BODY}\nforged provider body`;
    replaceArtifact(rawTamper, 'firecrawl-scrape-1', JSON.stringify(scrape));
    assert.throws(() => service.analyzeLive(rawTamper), /CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID|CRITERION_PROOF_INVALID/,
      'a self-rehashed Firecrawl body still disagrees with the producer-bound attention source');

    const statusTamper = structuredClone(bundle);
    const request = JSON.parse(statusTamper.rawArtifacts['firecrawl-scrape-1-request']!) as ProgramPacket;
    request.httpStatus = 201;
    replaceArtifact(statusTamper, 'firecrawl-scrape-1-request', JSON.stringify(request));
    assert.throws(() => service.analyzeLive(statusTamper), /CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID|CRITERION_PROOF_INVALID|LIVE_PROVENANCE_INVALID/,
      'a rehashed operation cannot rewrite the received HTTP status that authorized the retained result');

    const urlTamper = structuredClone(bundle);
    const changedRequest = JSON.parse(urlTamper.rawArtifacts['firecrawl-scrape-1-request']!) as ProgramPacket;
    changedRequest.request.url = 'https://public.example/forged-source';
    replaceArtifact(urlTamper, 'firecrawl-scrape-1-request', JSON.stringify(changedRequest));
    assert.throws(() => service.analyzeLive(urlTamper), /CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID|CRITERION_PROOF_INVALID|LIVE_PROVENANCE_INVALID/,
      'the Firecrawl request URL remains bound to the collector’s requested page');

    const omittedRaw = structuredClone(bundle);
    delete omittedRaw.rawArtifacts['firecrawl-scrape-1'];
    assert.throws(() => service.analyzeLive(omittedRaw), /RAW_ARTIFACT_REQUIRED|CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID|CRITERION_PROOF_INVALID|LIVE_PROVENANCE_INVALID/,
      'removing a native provider response cannot leave its source binding admissible');

    const orderTamper = structuredClone(bundle);
    const changedRead = JSON.parse(orderTamper.rawArtifacts['criterion-source-read']!) as ProgramPacket;
    const changedReceipt = JSON.parse(orderTamper.rawArtifacts['attention-qualified-receipt']!) as ProgramPacket;
    const firecrawlBinding = changedRead.sourceBindings.find((binding: ProgramPacket) => binding.producerArtifactId === 'firecrawl-scrape-1');
    assert.ok(firecrawlBinding);
    firecrawlBinding.resultIndex = 1;
    changedReceipt.read.sourceBindings.find((binding: ProgramPacket) => binding.producerArtifactId === 'firecrawl-scrape-1').resultIndex = 1;
    replaceArtifact(orderTamper, 'criterion-source-read', JSON.stringify(changedRead));
    replaceArtifact(orderTamper, 'attention-qualified-receipt', JSON.stringify(changedReceipt));
    assert.throws(() => service.analyzeLive(orderTamper), /CRITERION_SOURCE_INVALID|CRITERION_INPUT_INVALID|CRITERION_PROOF_INVALID/,
      'both self-consistent collector reads cannot reorder the one-result Firecrawl producer output');
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const noKeyModel = syntheticFetcher();
  const noKeyFallback = firecrawlFallbackFetcher(noKeyModel.fetcher);
  const noKeyBundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-no-firecrawl-secret',
    geminiKey: 'gemini-firecrawl-disabled-secret',
    fetcher: noKeyFallback.fetcher,
    now: () => NOW,
    runtime,
  });
  assert.equal(noKeyFallback.calls.length, 0, 'no Firecrawl key means zero provider HTTP requests');
  assert.equal(Object.keys(noKeyBundle.rawArtifacts).some(id => id.startsWith('firecrawl-')), false);

  const failedModel = syntheticFetcher();
  const failedScrape = firecrawlFallbackFetcher(failedModel.fetcher, pages, { scrapeStatus: 503 });
  const failedBundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-firecrawl-failure-secret',
    firecrawlKey: 'firecrawl-failed-attempt-secret',
    geminiKey: 'gemini-firecrawl-failed-attempt-secret',
    fetcher: failedScrape.fetcher,
    now: () => NOW,
    runtime,
  });
  assert.equal(failedScrape.calls.filter(call => call.url.endsWith('/search')).length, 1,
    'Live issues only one native search fallback');
  assert.equal(failedScrape.calls.filter(call => call.url.endsWith('/scrape')).length, 2,
    'two failed native scrape requests consume the entire Live scrape budget');
  assert.equal(failedBundle.rawArtifacts['firecrawl-scrape-1-request'] !== undefined, true);
  assert.equal(failedBundle.rawArtifacts['firecrawl-scrape-2-request'] !== undefined, true);
  assert.equal(failedBundle.rawArtifacts['firecrawl-scrape-3-request'], undefined,
    'a third failed-page recovery never exceeds the two-request bound');
  for (const id of ['firecrawl-scrape-1-request', 'firecrawl-scrape-2-request']) {
    const operation = JSON.parse(failedBundle.rawArtifacts[id]!) as { status: string; code: string; httpStatus: number };
    assert.deepEqual({ status: operation.status, code: operation.code, httpStatus: operation.httpStatus }, {
      status: 'UNAVAILABLE', code: 'FIRECRAWL_HTTP_503', httpStatus: 503,
    });
  }

  const failedSearchModel = syntheticFetcher();
  const failedSearch = firecrawlFallbackFetcher(failedSearchModel.fetcher, pages, { searchStatus: 503 });
  const failedSearchBundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-firecrawl-search-failure-secret',
    firecrawlKey: 'firecrawl-search-failure-secret',
    geminiKey: 'gemini-firecrawl-search-failure-secret',
    fetcher: failedSearch.fetcher,
    now: () => NOW,
    runtime,
  });
  assert.equal(failedSearch.calls.filter(call => call.url.endsWith('/search')).length, 1,
    'a failed Firecrawl search consumes its only Live search slot');
  assert.equal(failedSearch.calls.filter(call => call.url.endsWith('/scrape')).length, 0,
    'failed search metadata cannot invent pages to scrape');
  const failedSearchOperation = JSON.parse(failedSearchBundle.rawArtifacts['firecrawl-search-1-request']!) as {
    method: string; request: { operation: string; query: string }; status: string; code: string; httpStatus: number; replacesSearchId: string;
  };
  assert.deepEqual({
    method: failedSearchOperation.method, operation: failedSearchOperation.request.operation,
    query: failedSearchOperation.request.query, status: failedSearchOperation.status,
    code: failedSearchOperation.code, httpStatus: failedSearchOperation.httpStatus,
    replacesSearchId: failedSearchOperation.replacesSearchId,
  }, {
    method: 'firecrawl-native-operation-v1', operation: 'SEARCH', query: failedSearch.failedSearchQuery,
    status: 'UNAVAILABLE', code: 'FIRECRAWL_HTTP_503', httpStatus: 503, replacesSearchId: 'attention-search-1',
  });

  const comparisonModel = syntheticFetcher();
  const comparisonQueryPrefix = '"Synthetic Cedar" base crypto token contract';
  const comparisonFallback = firecrawlFallbackFetcher(comparisonModel.fetcher, [STORY_URL], {
    failSearch: query => query === comparisonQueryPrefix,
    dexPairs: [{
      chainId: 'base', pairAddress: `0x${'c'.repeat(40)}`,
      baseToken: { address: TOKEN.address, name: 'Synthetic Cedar' },
      quoteToken: { address: `0x${'b'.repeat(40)}` },
    }],
  });
  const comparisonBundle = await collectLiveToken(TOKEN, {
    profile: PROFILE,
    semanticEnabled: true,
    tinyfishKey: 'tinyfish-comparison-fallback-secret',
    firecrawlKey: 'firecrawl-comparison-fallback-secret',
    geminiKey: 'gemini-comparison-fallback-secret',
    fetcher: comparisonFallback.fetcher,
    now: () => NOW,
    runtime,
  });
  assert.equal(comparisonFallback.failedSearchQuery, comparisonQueryPrefix);
  const comparisonSearchCall = comparisonFallback.calls.find(call => call.url.endsWith('/search'));
  assert.ok(comparisonSearchCall, 'an actual failed comparison search activates the bounded native Firecrawl search');
  const comparisonNativeRequest = JSON.parse(comparisonBundle.rawArtifacts['firecrawl-search-1-request']!) as {
    request: { query: string }; replacesSearchId: string; httpStatus: number; status: string;
  };
  assert.equal(comparisonNativeRequest.request.query, comparisonFallback.failedSearchQuery,
    'the fallback reuses the exact failed comparison query, not the exact-token or a generic substitute');
  assert.ok(comparisonNativeRequest.replacesSearchId.startsWith('attention-search-3'));
  assert.equal(comparisonNativeRequest.httpStatus, 200);
  assert.equal(comparisonNativeRequest.status, 'OBSERVED');
  const comparisonProviderBody = JSON.parse(String(comparisonSearchCall.init?.body)) as { query: string };
  assert.equal(comparisonProviderBody.query, comparisonFallback.failedSearchQuery);
  const originalSearchRequest = JSON.parse(comparisonBundle.rawArtifacts[
    `attention-acquisition-${comparisonNativeRequest.replacesSearchId}-request`
  ]!) as { query: string };
  assert.equal(originalSearchRequest.query, comparisonNativeRequest.request.query,
    'the retained failed producer request independently binds the native fallback query');
  const comparisonDir = mkdtempSync(join(tmpdir(), 'criterion-firecrawl-comparison-'));
  const comparisonService = new Service(join(comparisonDir, 'comparison.sqlite'));
  try {
    const saved = comparisonService.analyzeLive(comparisonBundle);
    assert.equal(comparisonService.replay(saved.id).hash, saved.hash,
      'Service reconstructs and replays a Firecrawl fallback for the failed comparison request');
  } finally {
    comparisonService.close();
    rmSync(comparisonDir, { recursive: true, force: true });
  }
});
