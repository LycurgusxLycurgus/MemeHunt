import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildEntryReport } from '../src/app/report.js';
import { entryContextDecisionMethod, entryGroupFactsSchema, type EntrySnapshot } from '../src/domain/contracts.js';
import { openRouterSettings } from '../src/providers/openrouter.js';
import { geminiSettings } from '../src/providers/gemini.js';
import { decodeSharedAudit, decodeSharedAuditProof, qualifyShared } from '../src/providers/shared-model.js';
import { parseSourceResponse, sourceSpans } from '../src/providers/source-model.js';
import { deriveShared, sharedClaims, type SharedClaim } from '../src/domain/shared.js';
import { socialRubric } from '../src/providers/social-model.js';
import { sharedClaimProjectionMethod, type AttentionSource } from '../src/providers/attention.js';
import type { BaselineAssessment } from '../src/domain/baseline.js';
import { acquisitionEvidenceMethod, buildAcquisitionScope } from '../src/providers/acquisition-evidence.js';
import { SHARED_CUTOFF, sharedFixture } from './shared-fixtures.js';

const KEY = 'shared-model-test-key';
const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
type Span = { id: string; sourceId: string; start: number; end: number; text: string };
type PacketSource = Omit<AttentionSource, 'text'> & { spans: Span[] };
type Packet = {
  claims: SharedClaim[];
  sources: PacketSource[];
  completionMethod?: string;
  sourceInspectionMethod?: string;
  sourceInspectionRule?: string;
  decisionMethod?: string;
  proposal?: Array<Record<string, unknown>>;
  initialProposal?: Record<string, Record<string, unknown>>;
  initialFinal?: Record<string, Record<string, unknown>>;
  rejectedIds?: string[];
  socialScreeningCriteria?: Record<string, string>;
  socialConflictRule?: string;
};
type Captured = { packet: Packet; raw: string };

function envelope(value: unknown) {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }), {
    headers: { 'content-type': 'application/json' },
  });
}

function packetFrom(init: RequestInit | undefined): Captured {
  assert.equal(typeof init?.body, 'string');
  const payload = JSON.parse(String(init!.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
  const raw = payload.contents[0]!.parts[0]!.text;
  return { packet: JSON.parse(raw) as Packet, raw };
}

function openRouterEnvelope(value: unknown) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-shared-fallback-test', object: 'chat.completion', created: 1, model: openRouterSettings.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  }), { headers: { 'content-type': 'application/json' } });
}

function requestPacket(url: string, init: RequestInit | undefined): Captured {
  if (url !== openRouterSettings.url) return packetFrom(init);
  const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
  const raw = body.messages[1]!.content;
  return { packet: JSON.parse(raw) as Packet, raw };
}

function canonicalSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output = Object.fromEntries(Object.entries(input)
    .filter(([key]) => !['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(key))
    .map(([key, item]) => [key, canonicalSchema(item)]));
  if (typeof input.const === 'string') {
    delete output.const;
    output.enum = [input.const];
  }
  return output;
}

function citationFor(packet: Packet, claim: SharedClaim) {
  for (const citation of claim.citations) {
    const source = packet.sources.find(item => item.id === citation.sourceId);
    assert.ok(source, `the source catalog contains ${citation.sourceId}`);
    const span = source.spans.find(item => item.text.includes(citation.quote));
    if (span) return { sourceId: source.id, spanId: span.id };
  }
  assert.fail(`no submitted span contains a literal citation for ${claim.id}`);
}

test('shared audit makes two exact-ID passes over the same complete source packet', async () => {
  const input = sharedFixture();
  input.sources = input.sources.map((source, index) => ({
    ...source,
    // The aggregate exceeds the old invented 120k cap while each packet stays below the established 300k limit.
    text: `${source.text}\n${'Retained synthetic full-source context. '.repeat(index === 0 ? 1_950 : 1_980)}`,
  }));
  assert.ok(input.sources.reduce((sum, source) => sum + source.text.length, 0) > 120_000);
  const requests: Captured[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const captured = packetFrom(init);
    requests.push(captured);
    const ids = captured.packet.claims.map(claim => claim.id);
    const sourceIds = captured.packet.sources.map(source => source.id);
    if (!captured.packet.proposal) {
      return envelope({ claims: Object.fromEntries(captured.packet.claims.map(claim => [claim.id, {
        disposition: 'CLEAR',
        rationale: 'The inspected supplied sources show no incompatible assertion.',
        citations: [citationFor(captured.packet, claim)],
      }])) });
    }
    const proposed = captured.packet.proposal as Array<{ id: string; citations: Array<{ sourceId: string; quote: string }> }>;
    assert.deepEqual(proposed.map(claim => claim.id), ids);
    for (const claim of proposed) {
      assert.ok(claim.citations.every(citation => captured.packet.sources.some(source => source.id === citation.sourceId
        && source.spans.some(span => span.text === citation.quote))));
    }
    return envelope({
      claims: Object.fromEntries(ids.map(id => [id, true])),
      sources: Object.fromEntries(sourceIds.map(id => [id, true])),
    });
  };

  const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher);
  assert.equal(result.code, undefined);
  assert.ok(result.audit);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.raw.length < 300_000), 'the established per-packet limit still bounds both requests');
  assert.equal(requests[0]!.raw.length > 120_000, true, 'complete retained source text crosses 120k without arbitrary truncation');
  assert.deepEqual(requests[0]!.packet.claims, input.claims);
  assert.deepEqual(requests[1]!.packet.claims, input.claims);
  assert.deepEqual(requests[0]!.packet.sources, requests[1]!.packet.sources,
    'proposal and independent review receive identical source IDs, spans, metadata, and full text');
  assert.deepEqual(requests[0]!.packet.sources.map(source => source.id), input.sources.map(source => source.id));
  assert.deepEqual(result.audit.claims.map(claim => claim.id), input.claims.map(claim => claim.id));
  assert.ok(result.audit.claims.every(claim => claim.disposition === 'CLEAR' && claim.citations.length === 1));
  assert.ok(result.audit.review.every(claim => claim.accepted));
  assert.deepEqual(result.audit.sources, input.sources.map(source => ({ id: source.id, complete: true })));
  const retained = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as { claims: SharedClaim[]; sources: AttentionSource[]; audit: unknown };
  assert.deepEqual(retained.claims, input.claims);
  assert.deepEqual(retained.sources, input.sources);
  assert.deepEqual(retained.audit, result.audit);
});

test('Shared receipt selectors allow bounded support decisions but reject factual and conflict use', () => {
  const fixture = sharedFixture();
  const query = `"${fixture.token.address}" ${fixture.token.chain} narrative origin`;
  const responseId = 'attention-acquisition-attention-search-1-response';
  const rawArtifacts = {
    'attention-acquisition-ledger': JSON.stringify({
      method: acquisitionEvidenceMethod,
      token: fixture.token,
      start: SHARED_CUTOFF,
      end: SHARED_CUTOFF,
      searches: [{ id: 'attention-search-1', query, purpose: 'EXACT_TOKEN', artifactId: responseId,
        status: 200, availableAt: SHARED_CUTOFF, required: true }],
    }),
    [responseId]: JSON.stringify({ results: [] }),
  };
  const acquisition = buildAcquisitionScope({
    token: fixture.token, group: 'PUBLIC_ENTRY', cutoff: SHARED_CUTOFF,
    start: SHARED_CUTOFF, end: SHARED_CUTOFF, availableAt: SHARED_CUTOFF,
    ledgerId: 'attention-acquisition-ledger', rawArtifacts, sourceIds: [],
    expectedQueries: [{ query, purpose: 'EXACT_TOKEN' }], blockers: [],
  });
  assert.equal(acquisition.complete, true);
  const receipt = acquisition.evidence[0]!;
  const sources = [...fixture.sources, receipt];
  const receiptSpan = sourceSpans(receipt.id, receipt.text, 'SHARED_MODEL')[0]!;
  const body = fixture.sources[0]!;
  const bodySpan = sourceSpans(body.id, body.text, 'SHARED_MODEL')[0]!;
  const modelResponse = (value: unknown) => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: {
    parts: [{ text: JSON.stringify(value) }],
  } }] });
  const reviewSources = Object.fromEntries(sources.map(source => [source.id, {
    inspection: 'INSPECTED', relevance: 'POTENTIALLY_RELEVANT',
  }]));

  const bounded: SharedClaim = {
    id: 'bounded-support',
    statement: 'A completed bounded review found the public support record inadequate.',
    supportBasis: 'BOUNDED_SUPPORT_DECISION',
    featureIds: ['A01'],
    citations: [{ sourceId: receipt.id, quote: receiptSpan.text }],
  };
  const accepted = decodeSharedAudit([bounded], sources, modelResponse({ claims: { [bounded.id]: {
    disposition: 'CLEAR', rationale: 'The completed review records a bounded evidence gap.',
    citations: [{ sourceId: receipt.id, spanId: receiptSpan.id }],
  } } }), modelResponse({ claims: { [bounded.id]: {
    proposalAccepted: true,
    final: { disposition: 'CLEAR', support: 'SUPPORTED', rationale: 'The receipt records the bounded review operation and result.',
      citations: [{ sourceId: receipt.id, spanId: receiptSpan.id }] },
  } }, sources: reviewSources }), 'acquired-text-inspection-v1', 'source-support-and-conflict-v2');
  assert.equal(accepted.claims[0]?.support, 'SUPPORTED');
  assert.deepEqual(accepted.claims[0]?.citations, [{ sourceId: receipt.id, quote: receiptSpan.text }]);

  const factual: SharedClaim = {
    id: 'body-fact', statement: 'A factual project assertion appears in the source.',
    supportBasis: 'BODY_FACT', featureIds: ['A01'],
    citations: [{ sourceId: body.id, quote: bodySpan.text }],
  };
  assert.throws(() => decodeSharedAudit([factual], sources, modelResponse({ claims: { [factual.id]: {
    disposition: 'CLEAR', rationale: 'This factual statement is incorrectly supported by an operation receipt.',
    citations: [{ sourceId: receipt.id, spanId: receiptSpan.id }],
  } } }), modelResponse({}), 'acquired-text-inspection-v1', 'source-support-and-conflict-v2'),
  'a receipt span cannot be selected for a BODY_FACT claim');

  const conflict: SharedClaim = {
    id: 'bounded-conflict', statement: 'Two source assertions conflict.',
    supportBasis: 'BOUNDED_SUPPORT_DECISION', featureIds: ['A01'],
    citations: [{ sourceId: body.id, quote: bodySpan.text }],
  };
  assert.throws(() => decodeSharedAudit([conflict], sources, modelResponse({ claims: { [conflict.id]: {
    disposition: 'CONFLICT', rationale: 'This is incorrectly treating operation receipts as conflicting assertions.',
    citations: [{ sourceId: receipt.id, spanId: receiptSpan.id }, { sourceId: receipt.id, spanId: receiptSpan.id }],
  } } }), modelResponse({}), 'acquired-text-inspection-v1', 'source-support-and-conflict-v2'),
  'a receipt cannot be either side of a factual CONFLICT');
});

test('hosted receipt audit bounds citation grammar and rejects wrong source ownership before review', async () => {
  const fixture = sharedFixture();
  const template = fixture.sources[0]!;
  const bodySources = Array.from({ length: 37 }, (_, index) => ({
    ...template,
    id: `hosted-body-${index + 1}`,
    url: `https://public.example/hosted-body-${index + 1}`,
    text: `${template.text}\n${'Retained full-source context for hosted selector bounds. '.repeat(24)}`,
  }));
  const query = `"${fixture.token.address}" ${fixture.token.chain} narrative origin`;
  const responseId = 'attention-acquisition-attention-search-1-response';
  const rawArtifacts = {
    'attention-acquisition-ledger': JSON.stringify({
      method: acquisitionEvidenceMethod, token: fixture.token,
      start: SHARED_CUTOFF, end: SHARED_CUTOFF,
      searches: [{ id: 'attention-search-1', query, purpose: 'EXACT_TOKEN', artifactId: responseId,
        status: 200, availableAt: SHARED_CUTOFF, required: true }],
    }),
    [responseId]: JSON.stringify({ results: [] }),
  };
  const acquisition = buildAcquisitionScope({
    token: fixture.token, group: 'PUBLIC_ENTRY', cutoff: SHARED_CUTOFF,
    start: SHARED_CUTOFF, end: SHARED_CUTOFF, availableAt: SHARED_CUTOFF,
    ledgerId: 'attention-acquisition-ledger', rawArtifacts, sourceIds: [],
    expectedQueries: [{ query, purpose: 'EXACT_TOKEN' }], blockers: [],
  });
  assert.equal(acquisition.complete, true);
  const receipt = acquisition.evidence[0]!;
  const sources = [...bodySources, receipt];
  const bodySpan = sourceSpans(bodySources[0]!.id, bodySources[0]!.text, 'SHARED_MODEL')[0]!;
  const foreignSpan = sourceSpans(bodySources[1]!.id, bodySources[1]!.text, 'SHARED_MODEL')[0]!;
  const receiptSpan = sourceSpans(receipt.id, receipt.text, 'SHARED_MODEL')[0]!;
  const claims: SharedClaim[] = [
    ...bodySources.slice(0, 11).map((source, index) => {
      const selected = sourceSpans(source.id, source.text, 'SHARED_MODEL')[0]!;
      return { id: `body-fact-${index + 1}`, statement: `The retained body ${index + 1} contains the declared source statement.`,
        supportBasis: 'BODY_FACT' as const, featureIds: ['A01'], citations: [{ sourceId: source.id, quote: selected.text }] };
    }),
    { id: 'bounded-search', statement: 'The exact-token search completed with no selected results.',
      supportBasis: 'BOUNDED_SUPPORT_DECISION', featureIds: ['A01'], citations: [{ sourceId: receipt.id, quote: receiptSpan.text }] },
  ];
  type JsonObject = Record<string, unknown>;
  const citationSelectors = (value: unknown): Array<{ sourceId: JsonObject; spanId: JsonObject }> => {
    if (!value || typeof value !== 'object') return [];
    const node = value as JsonObject;
    const properties = node.properties as JsonObject | undefined;
    const sourceId = properties?.sourceId as JsonObject | undefined;
    const spanId = properties?.spanId as JsonObject | undefined;
    const here = sourceId && spanId
      ? [{ sourceId, spanId }]
      : [];
    return [...here, ...Object.values(node).flatMap(citationSelectors)];
  };
  type Mode = 'VALID' | 'WRONG_PAIR' | 'FOREIGN_SOURCE' | 'NONEXISTENT_SPAN' | 'BODY_FACT_RECEIPT'
    | 'CONFLICT_RECEIPT' | 'REVIEW_WRONG_PAIR' | 'REVIEW_NONEXISTENT_SPAN' | 'REVIEW_BODY_FACT_RECEIPT'
    | 'REVIEW_CONFLICT_RECEIPT' | 'REVIEW_INVALID_FINAL' | 'REPAIR_WRONG_PAIR';
  const run = async (mode: Mode, reassessRejected = false) => {
    const requests: Array<{ packet: Captured['packet']; schema: JsonObject }> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const capture = packetFrom(init);
      const payload = JSON.parse(String(init?.body)) as { generationConfig: { responseJsonSchema: JsonObject } };
      const requestIndex = requests.length;
      requests.push({ packet: capture.packet, schema: payload.generationConfig.responseJsonSchema });
      const proposalStage = requestIndex === 0 || requestIndex === 2;
      if (proposalStage) {
        const proposalClaims = Object.fromEntries(claims.map(claim => {
          let citations: Array<{ sourceId: string; spanId: string }> = [citationFor(capture.packet, claim)];
          let disposition = 'CLEAR';
          if ((mode === 'WRONG_PAIR' || mode === 'REPAIR_WRONG_PAIR') && claim.id === 'body-fact-1' && requestIndex === (mode === 'REPAIR_WRONG_PAIR' ? 2 : 0)) {
            citations = [{ sourceId: bodySources[0]!.id, spanId: foreignSpan.id }];
          }
          if (mode === 'FOREIGN_SOURCE' && claim.id === 'body-fact-1' && requestIndex === 0) {
            citations = [{ sourceId: 'not-in-the-retained-catalog', spanId: bodySpan.id }];
          }
          if (mode === 'NONEXISTENT_SPAN' && claim.id === 'body-fact-1' && requestIndex === 0) {
            citations = [{ sourceId: bodySources[0]!.id, spanId: `${bodySources[0]!.id}:span:not-retained` }];
          }
          if (mode === 'BODY_FACT_RECEIPT' && claim.id === 'body-fact-1' && requestIndex === 0) {
            citations = [{ sourceId: receipt.id, spanId: receiptSpan.id }];
          }
          if (mode === 'CONFLICT_RECEIPT' && claim.id === 'bounded-search' && requestIndex === 0) {
            disposition = 'CONFLICT';
            citations = [{ sourceId: bodySources[0]!.id, spanId: bodySpan.id }, { sourceId: receipt.id, spanId: receiptSpan.id }];
          }
          if (mode === 'REPAIR_WRONG_PAIR' && claim.id === 'body-fact-1' && requestIndex === 2) {
            citations = [{ sourceId: bodySources[0]!.id, spanId: foreignSpan.id }];
          }
          return [claim.id, { disposition, rationale: 'The selected evidence is reviewed within the declared bounded scope.', citations }];
        }));
        return envelope({ claims: proposalClaims });
      }
      const reviewStage = requestIndex === 1 || requestIndex === 3;
      assert.ok(reviewStage, `unexpected Shared request stage ${requestIndex}`);
      return envelope({
        claims: Object.fromEntries(claims.map(claim => {
          let citations = [citationFor(capture.packet, claim)];
          let disposition = 'CLEAR';
          let proposalAccepted = true;
          if (mode === 'REVIEW_WRONG_PAIR' && claim.id === 'body-fact-1') citations = [{ sourceId: bodySources[0]!.id, spanId: foreignSpan.id }];
          if (mode === 'REVIEW_NONEXISTENT_SPAN' && claim.id === 'body-fact-1') citations = [{ sourceId: bodySources[0]!.id, spanId: `${bodySources[0]!.id}:span:not-retained` }];
          if (mode === 'REVIEW_BODY_FACT_RECEIPT' && claim.id === 'body-fact-1') citations = [{ sourceId: receipt.id, spanId: receiptSpan.id }];
          if (mode === 'REVIEW_CONFLICT_RECEIPT' && claim.id === 'bounded-search') {
            disposition = 'CONFLICT';
            citations = [{ sourceId: bodySources[0]!.id, spanId: bodySpan.id }, { sourceId: receipt.id, spanId: receiptSpan.id }];
          }
          if (mode === 'REVIEW_INVALID_FINAL' && claim.id === 'body-fact-1') disposition = 'UNCLEAR';
          if (mode === 'REPAIR_WRONG_PAIR' && requestIndex === 1 && claim.id === 'body-fact-1') {
            disposition = 'UNCLEAR';
            proposalAccepted = false;
          }
          return [claim.id, {
            proposalAccepted,
            final: { disposition, support: disposition === 'CLEAR' ? 'SUPPORTED' : 'UNRESOLVED',
              rationale: 'The final statement is reviewed within its original selected evidence.', citations },
          }];
        })),
        sources: Object.fromEntries(capture.packet.sources.map(source => [source.id, {
          inspection: 'INSPECTED', relevance: 'POTENTIALLY_RELEVANT',
        }])),
      });
    };
    const result = await qualifyShared(claims, sources, fixture.token, KEY, fetcher, async () => {}, undefined,
      reassessRejected, undefined, 'reviewed-audit-completion-v1', 'acquired-text-inspection-v1', 'source-support-and-conflict-v2');
    return { result, requests };
  };

  const accepted = await run('VALID');
  assert.equal(accepted.result.code, undefined);
  assert.ok(accepted.result.audit);
  assert.equal(accepted.requests.length, 2);
  const proposalIds = claims.map(claim => claim.id).sort();
  assert.equal(sources.length, 38, 'the mixed fixture carries 37 retained bodies and one genuine operation receipt');
  for (const [index, request] of accepted.requests.entries()) {
    const schemaProperties = request.schema.properties as JsonObject;
    const claimProperties = schemaProperties.claims as JsonObject;
    const claimSchemaProperties = claimProperties.properties as JsonObject;
    assert.deepEqual(Object.keys(claimSchemaProperties).sort(), proposalIds,
      `${index === 0 ? 'proposal' : 'review'} schema retains every exact claim ID`);
    const allSelectors = citationSelectors(request.schema);
    assert.ok(allSelectors.length > 0);
    assert.ok(allSelectors.every(selector => selector.sourceId.type === 'string' && selector.spanId.type === 'string'
      && !('enum' in selector.sourceId) && !('enum' in selector.spanId)),
    `${index === 0 ? 'proposal' : 'review'} hosted selectors use bounded plain strings instead of repeated source/span catalogs`);
    if (index === 1) {
      const reviewSources = schemaProperties.sources as JsonObject;
      assert.deepEqual(Object.keys(reviewSources.properties as JsonObject).sort(), sources.map(source => source.id).sort(),
        'the review still requires source inspection for every exact catalog entry');
    }
  }
  const claimProperties = ((accepted.requests[0]!.schema.properties as JsonObject).claims as JsonObject).properties as JsonObject;
  const bodySelectors = citationSelectors(claimProperties['body-fact-1']);
  assert.ok(bodySelectors.length > 0 && bodySelectors.length <= 2,
    'the hosted BODY_FACT citation grammar uses at most its CLEAR and CONFLICT selector sets');
  assert.ok(bodySelectors.every(selector => selector.sourceId.type === 'string' && selector.spanId.type === 'string'),
    'the hosted BODY_FACT selector pair has source and span strings');
  const boundedSelectors = citationSelectors(claimProperties['bounded-search']);
  assert.ok(boundedSelectors.length > 0, 'a bounded support decision has a selector route for its actual receipt');
  assert.ok(bodySources.reduce((count, source) => count + sourceSpans(source.id, source.text, 'SHARED_MODEL').length, 0) >= 56,
    'the fixture exercises many exact full-body spans behind the compact hosted selectors');
  assert.deepEqual(accepted.requests[0]!.packet.sources, accepted.requests[1]!.packet.sources,
    'the proposal and independent review receive the same complete body/receipt catalog');
  assert.ok(accepted.requests[0]!.packet.sources.every(source => source.spans.map(span => span.text).join('')
    === sources.find(item => item.id === source.id)!.text), 'all retained source text remains available for full inspection');
  assert.deepEqual(accepted.result.audit?.sources, sources.map(source => ({ id: source.id, complete: true })));
  assert.ok(accepted.result.audit?.claims.find(claim => claim.id === 'bounded-search')?.citations.some(citation => citation.sourceId === receipt.id),
    'the valid bounded support decision actually selects its receipt while BODY_FACT remains body-only');

  for (const mode of ['WRONG_PAIR', 'FOREIGN_SOURCE', 'NONEXISTENT_SPAN', 'BODY_FACT_RECEIPT', 'CONFLICT_RECEIPT'] as const) {
    const rejected = await run(mode);
    assert.equal(rejected.result.audit, null, `${mode} cannot qualify the proposal`);
    assert.equal(rejected.result.code, 'SHARED_MODEL_INVALID', `${mode} fails closed at the response boundary`);
    assert.equal(rejected.requests.length, 1, `${mode} is rejected before an independent review request`);
    assert.equal(rejected.result.rawArtifacts['shared-review-prompt'], undefined);
    assert.ok(rejected.result.rawArtifacts['shared-proposal-response'], 'the actual rejected proposal response remains retained');
  }
  for (const mode of ['REVIEW_WRONG_PAIR', 'REVIEW_NONEXISTENT_SPAN', 'REVIEW_BODY_FACT_RECEIPT', 'REVIEW_CONFLICT_RECEIPT', 'REVIEW_INVALID_FINAL'] as const) {
    const rejected = await run(mode);
    assert.equal(rejected.result.audit, null, `${mode} cannot qualify the independent review`);
    assert.equal(rejected.result.code, mode === 'REVIEW_INVALID_FINAL' ? 'SHARED_FINAL_DECISION_INVALID' : 'SHARED_MODEL_INVALID',
      `${mode} fails local strict validation or canonical final agreement`);
    assert.equal(rejected.requests.length, 2, `${mode} is rejected before any repair or later qualification stage`);
    assert.equal(rejected.result.rawArtifacts['shared-repair-proposal-prompt'], undefined);
    assert.ok(rejected.result.rawArtifacts['shared-review-response'], 'the actual rejected independent response remains retained');
  }
  const failedRepair = await run('REPAIR_WRONG_PAIR', true);
  assert.equal(failedRepair.result.code, undefined);
  assert.ok(failedRepair.result.audit, 'a failed repair leaves the original audited decision available');
  assert.equal(failedRepair.result.audit.claims.find(claim => claim.id === 'body-fact-1')?.disposition, 'UNCLEAR');
  assert.equal(failedRepair.requests.length, 3, 'the malformed repair proposal fails before its review request');
  assert.ok(failedRepair.result.rawArtifacts['shared-repair-proposal-response'], 'the failed repair response remains retained');
  assert.equal(failedRepair.result.rawArtifacts['shared-repair-review-prompt'], undefined);
  const failedRepairReceipt = JSON.parse(failedRepair.result.rawArtifacts['shared-qualified-receipt']!) as {
    proposalResponseId?: string; reviewResponseId?: string;
  };
  assert.deepEqual([failedRepairReceipt.proposalResponseId, failedRepairReceipt.reviewResponseId],
    ['shared-proposal-response', 'shared-review-response'], 'the rejected repair never replaces the original selection');
});

test('marked A05 explanation fields reach both actual Shared passes while legacy projection stays byte exact', async () => {
  const fixture = sharedFixture();
  const source = fixture.sources[0]!;
  const span = sourceSpans(source.id, source.text, 'SHARED_MODEL')[0]!;
  const summary = 'A'.repeat(500);
  const explanation = {
    referent: 'R'.repeat(200),
    interest: `I${'n'.repeat(180)}BREAKPOINT_SENTINEL${'x'.repeat(1)}`.slice(0, 200),
    tokenRelation: 'T'.repeat(200),
    prerequisites: Array.from({ length: 10 }, (_, index) => `${String(index + 1).padStart(2, '0')} ${'P'.repeat(197)}`),
  };
  assert.ok(Object.values(explanation).filter(value => typeof value === 'string').every(value => value.length === 200));
  assert.ok(explanation.prerequisites.every(value => value.length === 200));
  const assessment = (marker: boolean, emptyPrerequisites = false) => ({
    id: 'A05', quality: 'KNOWN', projection: { value: emptyPrerequisites },
    data: { summary, citations: [{ sourceId: source.id, quote: span.text }],
      ...(marker ? { sharedClaimProjectionMethod, semanticPremiseMethod: 'criterion-premises-v1',
        entryDecisionMethod: 'binary-public-support-v5',
        decision: { verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
          rationale: 'The complete independent criterion review lacks a required explanation premise.',
          citations: [{ sourceId: source.id, quote: span.text }],
          criterionProof: { kind: 'PUBLIC_SUPPORT_INADEQUATE', criterion: 'NAR-03', gap: 'No grounded prerequisite assessment was established.' } },
        entryCriterionDecision: { decision: { verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
          rationale: 'The complete independent criterion review lacks a required explanation premise.',
          citations: [{ sourceId: source.id, quote: span.text }],
          criterionProof: { kind: 'PUBLIC_SUPPORT_INADEQUATE', criterion: 'NAR-03', gap: 'No grounded prerequisite assessment was established.' } } },
      } : {}),
      explanation: { ...explanation, prerequisites: emptyPrerequisites ? [] : explanation.prerequisites } },
  } as unknown as BaselineAssessment);
  const legacy = sharedClaims([assessment(false)])[0]!;
  assert.equal(legacy.statement, summary, 'unmarked historical statement bytes remain the original summary');
  const claim = sharedClaims([assessment(true)])[0]!;
  assert.equal(claim.statement.slice(0, summary.length), summary);
  assert.match(claim.statement, /\nValue: false\nReferent: /);
  assert.ok(claim.statement.includes(explanation.referent));
  assert.ok(claim.statement.includes(explanation.interest));
  assert.ok(claim.statement.includes('BREAKPOINT_SENTINEL'), 'the complete actual interest field is retained');
  assert.ok(claim.statement.includes(explanation.tokenRelation));
  for (const prerequisite of explanation.prerequisites) assert.ok(claim.statement.includes(prerequisite));
  assert.ok(claim.statement.includes(explanation.prerequisites.at(-1)!), 'the final prerequisite is not clipped');
  assert.ok(claim.statement.length <= 4000, 'all maximum-sized fields fit inside the existing statement bound');
  const empty = sharedClaims([assessment(true, true)])[0]!;
  assert.match(empty.statement, /\nPrerequisites: none$/,
    'an empty prerequisite list is represented explicitly instead of being omitted');

  const requests: Packet[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const packet = packetFrom(init).packet;
    requests.push(packet);
    const decisions = Object.fromEntries(packet.claims.map(item => [item.id, {
      disposition: 'CLEAR', rationale: 'The selected source is inspected for the complete explanation statement.',
      citations: [citationFor(packet, item)],
    }]));
    if (!Object.hasOwn(packet, 'proposal')) return envelope({ claims: decisions });
    return envelope({
      claims: Object.fromEntries(packet.claims.map(item => [item.id, {
        proposalAccepted: true, final: { ...decisions[item.id]!, support: 'SUPPORTED' },
      }])),
      sources: Object.fromEntries(packet.sources.map(item => [item.id, {
        inspection: 'INSPECTED', relevance: 'POTENTIALLY_RELEVANT',
      }])),
    });
  };
  const result = await qualifyShared([claim], [source], fixture.token, KEY, fetcher, async () => {}, undefined,
    false, undefined, 'reviewed-audit-completion-v1', 'acquired-text-inspection-v1', 'source-support-and-conflict-v2');
  assert.equal(result.code, undefined);
  assert.ok(result.audit);
  assert.equal(requests.length, 2, 'the original proposal and independent review use the same two-pass contract');
  for (const packet of requests) {
    assert.equal(packet.claims[0]?.statement, claim.statement);
    assert.deepEqual(packet.claims[0]?.criterionContext, claim.criterionContext,
      'both original Shared passes receive the exact feature value, decision basis, typed criterion proof and source-owned public decision');
    assert.equal(packet.claims[0]?.statement.includes(explanation.prerequisites.at(-1)!), true);
    assert.equal(packet.sources[0]?.spans.map(item => item.text).join(''), source.text,
      'projection does not clip the actual full source supplied to Shared');
  }
});

test('shared model fallback carries across stages only within the same live run', async () => {
  const input = sharedFixture();
  const routing = { fallbackActive: false };
  const calls: Array<{ url: string; body: string; packet: Packet }> = [];
  const waits: number[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const captured = packetFrom(init);
    calls.push({ url: String(url), body: String(init?.body), packet: captured.packet });
    if (calls.length === 1) return new Response('temporary overload 1', { status: 503 });
    if (calls.length === 2) return new Response('temporary overload 2', { status: 500 });
    if (!captured.packet.proposal) return envelope({ claims: Object.fromEntries(input.claims.map(claim => [claim.id, {
      disposition: 'CLEAR', rationale: 'The inspected source supports no material contradiction.',
      citations: [citationFor(captured.packet, claim)],
    }])) });
    return envelope({
      claims: Object.fromEntries(input.claims.map(claim => [claim.id, true])),
      sources: Object.fromEntries(input.sources.map(source => [source.id, true])),
    });
  };

  const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher,
    async milliseconds => { waits.push(milliseconds); }, undefined, false, routing);

  assert.ok(result.audit);
  assert.equal(result.code, undefined);
  assert.equal(routing.fallbackActive, true);
  assert.deepEqual(calls.map(call => call.url), [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:generateContent`,
  ], 'the review stage stays on the fallback after attempt three activates it');
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[1]!.body, calls[2]!.body, 'the transient proposal retries preserve one exact serialized body');
  assert.notEqual(calls[2]!.body, calls[3]!.body, 'the independent review is a separate proposal-bound request');
  assert.deepEqual(waits, [30_000, 60_000]);
  const transport = (stage: string, attempt: number) => JSON.parse(result.rawArtifacts[`shared-${stage}-transport-attempt-${attempt}`]!) as {
    attempt: number; model: string; code: string; willRetry: boolean;
  };
  assert.deepEqual([transport('proposal', 1).model, transport('proposal', 2).model, transport('proposal', 3).model,
    transport('proposal', 1).willRetry, transport('proposal', 2).willRetry, transport('proposal', 3).willRetry],
  [geminiSettings.model, geminiSettings.model, geminiSettings.fallbackModel, true, true, false]);
  assert.equal(transport('proposal', 1).code, 'SHARED_MODEL_HTTP_503');
  assert.equal(transport('proposal', 2).code, 'SHARED_MODEL_HTTP_500');
  assert.equal(transport('proposal', 3).code, 'SHARED_MODEL_HTTP_200');
  assert.equal(transport('review', 1).model, geminiSettings.fallbackModel);

  const freshRouting = { fallbackActive: false };
  const freshUrls: string[] = [];
  const freshFetcher: typeof fetch = async (url, init) => {
    freshUrls.push(String(url));
    const captured = packetFrom(init);
    if (!captured.packet.proposal) return envelope({ claims: Object.fromEntries(input.claims.map(claim => [claim.id, {
      disposition: 'CLEAR', rationale: 'The fresh run inspects all supplied sources without a contradiction.',
      citations: [citationFor(captured.packet, claim)],
    }])) });
    return envelope({ claims: Object.fromEntries(input.claims.map(claim => [claim.id, true])),
      sources: Object.fromEntries(input.sources.map(source => [source.id, true])) });
  };
  const fresh = await qualifyShared(input.claims, input.sources, input.token, KEY, freshFetcher,
    async () => {}, undefined, false, freshRouting);
  assert.ok(fresh.audit);
  assert.deepEqual(freshUrls, [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
  ], 'a new run starts on the primary model instead of inheriting process-global fallback state');
  assert.equal(freshRouting.fallbackActive, false);
});

test('Gemini request rejection falls through to a strict free OpenRouter Shared audit and completes DAT-02/DAT-03', async () => {
  const input = sharedFixture();
  const decisionMethod = 'source-support-and-conflict-v2' as const;
  const attentionSource = input.sources.find(source => source.id === 'attention-source')!;
  const negativeQuote = 'The bounded public sample does not explain a project narrative for this token.';
  const originQuote = 'The retained page includes no dated creator attribution or origin statement.';
  const competitorQuote = (input.baseline.find(row => row.id === 'A09')!.data as { candidates: Array<{ quote: string }> }).candidates[0]!.quote;
  attentionSource.text += `\n${negativeQuote}\n${originQuote}`;
  const sourceEvidence = (id: string, text: string) => ({
    id, sourceId: 'tinyfish-fetch', sourceType: 'ATTENTION_SAMPLE', retrievedAt: SHARED_CUTOFF,
    availableAt: SHARED_CUTOFF, contentHash: sha256(text), adapterVersion: 'shared-context-test-v1',
    accessMode: 'FREE_ACCOUNT' as const, scope: { sourceBound: true },
  });
  input.evidence.push(sourceEvidence(attentionSource.id, attentionSource.text));
  const explainable = input.baseline.find(row => row.id === 'A05')!;
  explainable.quality = 'KNOWN';
  explainable.projection!.quality = 'KNOWN';
  explainable.projection!.value = false;
  explainable.evidenceIds = [attentionSource.id];
  explainable.data = {
    method: 'binary-public-support-v5', summary: 'The bounded public sample does not explain a project narrative for this token.',
    citations: [{ sourceId: attentionSource.id, quote: negativeQuote }],
    entryDecisionMethod: 'binary-public-support-v5', entryCriterion: 'NAR-03',
    outcomeBasisMethod: 'entry-outcome-basis-v1', acquisitionEvidenceMethod,
    decision: {
      verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: 'The completed independent review found no adequate exact-token explanatory thesis.',
      citations: [{ sourceId: attentionSource.id, quote: negativeQuote }],
    },
  };
  const origin = input.baseline.find(row => row.id === 'A03')!;
  origin.quality = 'KNOWN';
  origin.projection!.quality = 'KNOWN';
  origin.projection!.value = false;
  origin.evidenceIds = [...new Set([...origin.evidenceIds, attentionSource.id])];
  origin.projection!.evidenceIds = [...new Set([...origin.projection!.evidenceIds, attentionSource.id])];
  const originFeature = input.features.find(feature => feature.id === 'A03')!;
  originFeature.value = false;
  originFeature.evidenceIds = [...new Set([...originFeature.evidenceIds, attentionSource.id])];
  origin.data = {
    ...(origin.data as Record<string, unknown>), semanticJudgmentMethod: 'evidence-constitution-v1',
    entryCriterionDecision: {
      method: 'evidence-constitution-v1', criterion: 'NAR-02',
      decision: {
        verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
        rationale: 'The retained public source does not establish a dated origin or catalyst.',
        citations: [{ sourceId: attentionSource.id, quote: originQuote }],
      },
      availableAt: SHARED_CUTOFF, start: '2026-10-01T00:00:00.000Z', end: SHARED_CUTOFF,
      evidenceIds: [attentionSource.id],
    },
  };
  const representation = input.baseline.find(row => row.id === 'A09')!;
  representation.data = {
    ...(representation.data as Record<string, unknown>), entryDecisionMethod: 'binary-public-support-v5',
    entryCriterion: 'CAN-01',
    decision: {
      verdict: 'PASS', rationale: 'The bounded representation review identifies a distinct acquired alternative.',
      citations: [{ sourceId: attentionSource.id, quote: competitorQuote }],
    },
  };
  const socialSource = input.sources.find(source => source.id === 'social-source')!;
  const participationQuote = 'The current sample does not establish independent participation across distinct original groups.';
  socialSource.text += `\n${participationQuote}`;
  input.evidence.push(sourceEvidence(socialSource.id, socialSource.text));
  input.social!.outcomeBasisMethod = 'entry-outcome-basis-v1';
  input.social!.participationReview = {
    method: 'source-transparency-review-v1', verdict: 'CONTRADICTED', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
    rationale: 'The inspected sample does not establish independent participation across distinct original groups.',
    citations: [{ sourceId: socialSource.id, quote: participationQuote }], missingIndicators: [],
  };
  for (const id of ['A15', 'A16', 'A17', 'A18']) {
    const row = input.baseline.find(item => item.id === id)!;
    const feature = input.features.find(item => item.id === id)!;
    row.quality = feature.quality = id === 'A15' || id === 'A18' ? 'KNOWN' : 'MISSING';
    row.projection!.quality = feature.quality;
    row.projection!.value = feature.value = id === 'A15' || id === 'A18' ? false : null;
    row.data = id === 'A15' || id === 'A18' ? {
      method: 'entry-evidence-gate-v1', entryCriterion: id === 'A15' ? 'ATT-01' : 'ATT-02', verdict: 'FAIL',
      postSampleScope: { method: 'reviewed-empty-post-scope-v1', complete: true, sourceIds: [] },
    } : null;
  }
  const inspectedSources = Array.from({ length: 15 }, (_, index) => ({
    id: `attention-full-source-${index + 1}`, url: `https://public.example/full-source-${index + 1}`,
    text: `Complete retained test source ${index + 1} for ${input.token.address}; no additional assertion is made.`,
    publishedAt: null, authorId: null, availableAt: SHARED_CUTOFF, kind: 'PAGE' as const,
  }));
  input.sources.push(...inspectedSources);
  input.evidence.push(...inspectedSources.map(source => sourceEvidence(source.id, source.text)));
  input.groups = entryGroupFactsSchema.parse({
    method: 'mandatory-entry-groups-v1', contextDecisionMethod: entryContextDecisionMethod,
    token: input.token, cutoff: input.cutoff,
    groups: [
      ['ADV-01', 'PASS', ['O19'], ['feature-evidence-O19'], {}],
      ['ADV-02', 'PASS', ['O28'], ['feature-evidence-O28'], {}],
      ['ADV-03', 'FAIL', ['A05'], [attentionSource.id], {
        outcome: 'INSUFFICIENT', basis: 'PUBLIC_SUPPORT_INADEQUATE', criterion: 'NAR-03',
        qualifiedOriginals: null, sourceAccounts: null,
      }],
      ['ADV-04', 'PASS', ['S02'], ['feature-evidence-S02'], {}],
      ['ADV-05', 'PASS', ['O08'], ['feature-evidence-O08'], {}],
    ].map(([checkId, status, featureIds, evidenceIds, metrics]) => ({
      checkId, status, rationale: `The fixture retains the completed ${checkId} screening decision.`,
      code: checkId === 'ADV-03' ? 'NECESSARY_ATTENTION_CONTEXT' : `${checkId}_FIXTURE`,
      featureIds, evidenceIds, availableAt: SHARED_CUTOFF, metrics, limitations: [],
    })),
  });
  input.claims = sharedClaims(input.baseline, input.social, decisionMethod);
  const openrouterKey = 'openrouter-shared-test-key';
  const routing = { fallbackMode: 'openrouter-v1' as const, fallbackActive: false, openrouterKey };
  const calls: Array<{ url: string; body: string; raw: string; packet: Packet; headers: Headers }> = [];
  const waits: number[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const target = String(url), body = String(init?.body), captured = requestPacket(target, init);
    calls.push({ url: target, body, raw: captured.raw, packet: captured.packet, headers: new Headers(init?.headers) });
    if (target !== openRouterSettings.url) {
      return new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Use the configured free endpoint.' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    const claims = Object.fromEntries(captured.packet.claims.map(claim => {
      const citation = citationFor(captured.packet, claim);
      return [claim.id, captured.packet.proposal
        ? { proposalAccepted: true, final: { disposition: 'CLEAR', rationale: 'The completed independent review finds no material contradiction and lacks adequate support for every original clause.', citations: [citation], support: 'INSUFFICIENT' } }
        : { disposition: 'CLEAR', rationale: 'The complete retained source inspection finds no material contradiction.', citations: [citation] }];
    }));
    const response = captured.packet.proposal
      ? { claims, sources: Object.fromEntries(captured.packet.sources.map(source => [source.id, { inspection: 'INSPECTED', relevance: 'POTENTIALLY_RELEVANT' }])) }
      : { claims };
    return openRouterEnvelope(response);
  };

  const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher,
    async milliseconds => { waits.push(milliseconds); }, undefined, false, routing,
    'reviewed-audit-completion-v1', 'acquired-text-inspection-v1', decisionMethod);

  assert.equal(result.code, undefined);
  assert.ok(result.audit);
  assert.deepEqual(calls.map(call => call.url), [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    openRouterSettings.url,
    openRouterSettings.url,
  ]);
  assert.equal(calls[0]!.raw, calls[1]!.raw, 'the exact rejected Shared proposal packet is sent to OpenRouter');
  assert.ok(waits.every(milliseconds => milliseconds < 30_000), 'only normal provider pacing occurs; the 400 handoff adds no retry backoff');
  assert.equal(routing.fallbackActive, true, 'successful strict Shared qualification selects OpenRouter for its independent review');
  assert.equal(calls[0]!.headers.get('authorization'), null);
  assert.equal(calls[0]!.headers.get('x-goog-api-key'), KEY);
  assert.equal(calls[1]!.headers.get('authorization'), `Bearer ${openrouterKey}`);
  assert.equal(calls[1]!.headers.get('x-goog-api-key'), null);
  assert.doesNotMatch(calls.map(call => call.body).join('\n'), new RegExp(openrouterKey));

  const primaryRequest = JSON.parse(calls[0]!.body) as { generationConfig: { responseJsonSchema: unknown } };
  const fallbackRequest = JSON.parse(calls[1]!.body) as { model: string; response_format: { json_schema: { schema: unknown } }; provider: { max_price: { prompt: number; completion: number }; allow_fallbacks: boolean } };
  assert.equal(fallbackRequest.model, openRouterSettings.model);
  assert.deepEqual(fallbackRequest.provider, { require_parameters: true, allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } });
  assert.deepEqual(canonicalSchema(primaryRequest.generationConfig.responseJsonSchema), canonicalSchema(fallbackRequest.response_format.json_schema.schema),
    'the provider handoff retains the generated Shared wire schema');

  const rejected = JSON.parse(result.rawArtifacts['shared-proposal-transport-attempt-1']!) as Record<string, unknown>;
  const acceptedProposal = JSON.parse(result.rawArtifacts['shared-proposal-transport-attempt-2']!) as Record<string, unknown>;
  const acceptedReview = JSON.parse(result.rawArtifacts['shared-review-transport-attempt-1']!) as Record<string, unknown>;
  assert.deepEqual([rejected.model, rejected.provider, rejected.code, rejected.willRetry], [geminiSettings.model, undefined, 'SHARED_MODEL_HTTP_400', true]);
  assert.equal(rejected.responseHash, sha256(result.rawArtifacts['shared-proposal-response-attempt-1']!));
  assert.deepEqual([acceptedProposal.model, acceptedProposal.provider, acceptedProposal.requestProfile, acceptedProposal.code, acceptedProposal.willRetry],
    [openRouterSettings.model, 'openrouter', openRouterSettings.requestProfile, 'SHARED_MODEL_HTTP_200', false]);
  assert.equal(acceptedProposal.responseHash, sha256(result.rawArtifacts['shared-proposal-response']!));
  assert.deepEqual([acceptedReview.model, acceptedReview.provider, acceptedReview.code, acceptedReview.willRetry],
    [openRouterSettings.model, 'openrouter', 'SHARED_MODEL_HTTP_200', false]);
  assert.equal(acceptedReview.responseHash, sha256(result.rawArtifacts['shared-review-response']!));
  assert.equal(JSON.parse(result.rawArtifacts['shared-qualified-receipt']!).audit.claims.length, input.claims.length);
  assert.equal(input.sources.length, 17);
  assert.equal(result.audit!.claims.length, input.claims.length,
    'the selected negative context witness does not add synthetic semantic claims');
  assert.equal(result.audit!.sources.length, 17);
  assert.ok(result.audit!.sources.every(source => source.complete), 'all 17 retained full bodies received exact source inspections');
  const replayed = decodeSharedAuditProof(input.claims, input.sources, input.token, result.rawArtifacts, false,
    'reviewed-audit-completion-v1', 'acquired-text-inspection-v1', decisionMethod);
  assert.deepEqual(replayed, result.audit, 'the stored exact prompt/response pair passes the ordinary strict offline proof decoder');

  input.qualityMode = 'ENTRY_GROUPS_V1';
  input.completionMethod = 'reviewed-audit-completion-v1';
  input.sourceInspectionMethod = 'acquired-text-inspection-v1';
  input.decisionMethod = decisionMethod;
  input.audit = result.audit;
  const derived = deriveShared(input);
  assert.equal(derived.facts.semanticQualified, true);
  assert.equal(derived.facts.auditCompleted, true);
  assert.equal(derived.facts.supportCompleted, true);
  assert.equal(derived.facts.supportQualified, false);
  assert.deepEqual([derived.facts.values.C05, derived.facts.values.C06], [false, true],
    'the selected A05 context witness prevents missing A16/A17 counts from poisoning the completed clear audit');
  assert.deepEqual(derived.facts.unresolved, []);
  assert.deepEqual(derived.facts.conflicts, []);

  const snapshot: EntrySnapshot = {
    id: 'shared-fallback-completed-review', caseId: 'shared-fallback-fixture', checklistKind: 'ENTRY',
    token: input.token, cutoff: input.cutoff, analysisKind: 'FIXTURE', features: input.features, evidence: input.evidence,
    result: { checks: ['DAT-02', 'DAT-03'].map(checkId => ({
      checkId, checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'SHARED', required: true,
      status: checkId === 'DAT-02' ? 'FAIL' : 'PASS', reasonCode: checkId === 'DAT-02' ? 'SHARED_SUPPORT_INSUFFICIENT' : 'RULE_SATISFIED', featureRefs: [], evidenceRefs: [],
    })), binary: 'FAIL', classification: 'INSUFFICIENT_DATA', coverage: { known: 0, total: 2 } },
    hash: 'a'.repeat(64),
    details: { version: 1, profile: input.profile, thesis: null, baseline: [...input.baseline, ...derived.assessments],
      origins: {}, stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null }, shared: derived.facts, groups: input.groups },
  };
  const report = buildEntryReport(snapshot);
  assert.deepEqual(report.checks.filter(check => check.checkId === 'DAT-02' || check.checkId === 'DAT-03')
    .map(check => [check.checkId, check.policyStatus, check.outcome]), [
    ['DAT-02', 'FAIL', 'INSUFFICIENT'],
    ['DAT-03', 'PASS', 'SUPPORTED'],
  ], 'a completed unsupported audit is insufficient for semantic support while its clear conflict screen is supported');
});

test('Shared social claims receive the existing screening criteria in both passes without changing conflict gates or non-social topology', async () => {
  const input = sharedFixture();
  const socialClaims = input.claims.filter(claim => /^SOC-/.test(claim.id));
  const conflictClaimId = socialClaims.find(claim => claim.id === 'SOC-01')?.id;
  assert.ok(conflictClaimId, 'the production Shared fixture contains the identity screening claim');
  const expectedCriteria = {
    assessments: socialRubric.assessments,
    identity: socialRubric.identity,
    lineage: socialRubric.lineage,
    accounts: socialRubric.accounts,
    metrics: socialRubric.metrics,
  };

  const run = async (claims: SharedClaim[], rejectedConflict = false) => {
    const requests: Captured[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const captured = packetFrom(init);
      requests.push(captured);
      const ids = captured.packet.claims.map(claim => claim.id);
      const sourceIds = captured.packet.sources.map(source => source.id);
      if (!captured.packet.proposal) {
        return envelope({ claims: Object.fromEntries(captured.packet.claims.map(claim => {
          const conflict = claim.id === conflictClaimId;
          const citations = [citationFor(captured.packet, claim)];
          if (conflict) {
            const other = captured.packet.sources.find(source => source.id !== citations[0]!.sourceId)!;
            citations.push({ sourceId: other.id, spanId: other.spans[0]!.id });
          }
          return [claim.id, {
            disposition: conflict ? 'CONFLICT' : 'CLEAR',
            rationale: conflict
              ? 'The fixture proposes a conflict only to exercise the separate independent acceptance gate.'
              : 'The supplied fixture sources show no incompatible assertion.',
            citations,
          }];
        })) });
      }
      return envelope({
        claims: Object.fromEntries(ids.map(id => [id, !(rejectedConflict && id === conflictClaimId)])),
        sources: Object.fromEntries(sourceIds.map(id => [id, true])),
      });
    };
    const result = await qualifyShared(claims, input.sources, input.token, KEY, fetcher);
    return { requests, result };
  };

  const socialRun = await run(input.claims, true);
  assert.equal(socialRun.requests.length, 2, 'social criteria are added to the existing proposal and review passes');
  for (const request of socialRun.requests) {
    assert.deepEqual(request.packet.socialScreeningCriteria, expectedCriteria,
      'the prompt reuses the exported social model criteria instead of carrying a copied alternate rubric');
    assert.equal(request.packet.socialConflictRule, socialRun.requests[0]!.packet.socialConflictRule,
      'both passes receive identical guidance on self-attribution versus independent corroboration');
  }
  assert.match(socialRun.requests[0]!.packet.socialConflictRule!, /self-posts alone do not contradict inadequate independent identity evidence/);
  assert.match(socialRun.requests[0]!.packet.socialConflictRule!, /authorship and contract context alone do not establish the explicit origin/);
  assert.match(socialRun.requests[0]!.raw, /CONFLICT needs two exact cited sides/);
  assert.match(socialRun.requests[0]!.raw, /one community link does not contradict a shortfall/);
  assert.deepEqual(socialRun.requests[0]!.packet.claims, socialRun.requests[1]!.packet.claims);
  assert.deepEqual(socialRun.requests[0]!.packet.sources, socialRun.requests[1]!.packet.sources,
    'both full audit passes inspect the same evidence alongside the criteria');
  assert.equal(socialRun.result.audit?.claims.find(claim => claim.id === conflictClaimId)?.disposition, 'CONFLICT');
  assert.equal(socialRun.result.audit?.review.find(claim => claim.id === conflictClaimId)?.accepted, false,
    'the criteria do not auto-accept a proposed social conflict');
  const rejectedInput = { ...input, audit: socialRun.result.audit };
  assert.equal(deriveShared(rejectedInput).facts.values.C06, null, 'a rejected conflict remains unknown');

  const acceptedAudit = structuredClone(socialRun.result.audit!);
  acceptedAudit.review.find(claim => claim.id === conflictClaimId)!.accepted = true;
  assert.equal(deriveShared({ ...input, audit: acceptedAudit }).facts.values.C06, false,
    'an independently accepted conflict remains a known adverse Shared outcome');

  const nonSocialClaims = input.claims.filter(claim => !/^SOC-/.test(claim.id));
  const nonSocialRun = await run(nonSocialClaims);
  assert.equal(nonSocialRun.requests.length, 2, 'non-social audits keep their original two-call topology');
  assert.ok(nonSocialRun.requests.every(request => request.packet.socialScreeningCriteria === undefined
    && request.packet.socialConflictRule === undefined), 'social-only context is omitted when the audit has no SOC claims');
});

test('full Shared reassesses only rejected or locally unqualified complete social conflicts once', async t => {
  type RepairMode = 'accept' | 'one-sided-repair' | 'duplicate-side-repair' | 'reject-review' | 'invalid-proposal' | 'changed-copy' | 'failed-review-transport';
  const run = async (options: {
    mode?: RepairMode; incompleteInitial?: boolean; unclearInitial?: boolean; acceptInitialConflicts?: boolean; oneSidedInitial?: boolean;
  } = {}) => {
    const input = sharedFixture();
    const requests: Captured[] = [];
    let initialWire: Record<string, Record<string, unknown>> = {};
    let fetchError: string | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      const captured = packetFrom(init);
      requests.push(captured);
      const ids = captured.packet.claims.map(claim => claim.id);
      const sourceIds = captured.packet.sources.map(source => source.id);
      if (requests.length === 1) {
        initialWire = Object.fromEntries(captured.packet.claims.map(claim => {
          const falseConflict = options.oneSidedInitial
            ? claim.id === 'SOC-01'
            : ['SOC-01', 'SOC-02'].includes(claim.id);
          const first = citationFor(captured.packet, claim);
          const other = captured.packet.sources.find(source => source.id !== first.sourceId)!;
          const citations = falseConflict && !options.oneSidedInitial
            ? [first, { sourceId: other.id, spanId: other.spans[0]!.id }]
            : [first];
          const disposition = options.unclearInitial && claim.id === 'SOC-01' ? 'UNCLEAR' : falseConflict ? 'CONFLICT' : 'CLEAR';
          return [claim.id, {
            disposition,
            rationale: disposition === 'CONFLICT'
              ? 'The initial pass records a deliberately rejected false conflict for bounded reassessment.'
              : 'The complete source packet was inspected for this claim.',
            citations,
          }];
        }));
        return envelope({ claims: initialWire });
      }
      if (requests.length === 2) {
        return envelope({
          claims: Object.fromEntries(ids.map(id => [id, options.oneSidedInitial === true
            || options.acceptInitialConflicts || !['SOC-01', 'SOC-02'].includes(id)])),
          sources: Object.fromEntries(sourceIds.map(id => [id, !options.incompleteInitial])),
        });
      }
      if (requests.length === 3) {
        try {
          if (options.mode === 'invalid-proposal') return envelope({ claims: { 'SOC-01': { disposition: 'CLEAR' } } });
          const rejectedIds = captured.packet.rejectedIds as string[];
          const original = captured.packet.initialProposal as Record<string, Record<string, unknown>>;
          const expectedRejected = options.oneSidedInitial
            ? ['SOC-01']
            : options.unclearInitial || options.incompleteInitial || options.acceptInitialConflicts ? [] : ['SOC-01', 'SOC-02'];
          assert.deepEqual(rejectedIds, expectedRejected);
          const claims = Object.fromEntries(ids.map(id => [id, rejectedIds.includes(id)
            ? options.mode === 'one-sided-repair' && id === 'SOC-01'
              ? { disposition: 'CONFLICT', rationale: 'The attempted repair still has only one side of the alleged contradiction.', citations: [citationFor(captured.packet, input.claims.find(claim => claim.id === id)!)] }
              : options.mode === 'duplicate-side-repair' && id === 'SOC-01'
                ? (() => { const citation = citationFor(captured.packet, input.claims.find(claim => claim.id === id)!); return { disposition: 'CONFLICT', rationale: 'The attempted repair repeats one cited side instead of establishing both sides.', citations: [citation, citation] }; })()
                : { disposition: 'CLEAR', rationale: 'Full source review finds no incompatible assertion.', citations: [citationFor(captured.packet, input.claims.find(claim => claim.id === id)!)] }
            : original[id]]));
          if (options.mode === 'changed-copy') {
            claims.A01 = { ...original.A01!, rationale: 'The repair changes an accepted non-rejected decision.' };
          }
          for (const id of ids.filter(id => !rejectedIds.includes(id))) {
            if (options.mode === 'changed-copy' && id === 'A01') continue;
            assert.deepEqual(claims[id], original[id], `${id} is copied unchanged`);
          }
          return envelope({ claims });
        } catch (error) {
          fetchError = error instanceof Error ? error.stack ?? error.message : String(error);
          throw error;
        }
      }
      if (requests.length === 4) {
        if (options.mode === 'failed-review-transport') throw new Error('synthetic repair review transport failure');
        return envelope({
          claims: Object.fromEntries(ids.map(id => [id, !(options.mode === 'reject-review' && id === 'SOC-01')])),
          sources: Object.fromEntries(sourceIds.map(id => [id, true])),
        });
      }
      throw new Error(`UNEXPECTED_SHARED_REASSESSMENT_CALL_${requests.length}`);
    };
    const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher, async () => {}, undefined, true);
    return { input, requests, result, fetchError };
  };

  await t.test('accepted re-review selects the one complete candidate and qualifies C06', async () => {
    const { input, requests, result } = await run();
    assert.equal(result.code, undefined);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[0]!.packet.claims, requests[2]!.packet.claims);
    assert.deepEqual(requests[0]!.packet.sources, requests[2]!.packet.sources);
    assert.deepEqual(requests[0]!.packet.sources, requests[3]!.packet.sources);
    assert.deepEqual(requests[2]!.packet.rejectedIds, ['SOC-01', 'SOC-02']);
    assert.deepEqual(result.audit?.claims.filter(claim => claim.id.startsWith('SOC-')).map(claim => [claim.id, claim.disposition]), [
      ['SOC-01', 'CLEAR'], ['SOC-02', 'CLEAR'],
    ]);
    assert.ok(result.audit?.review.every(item => item.accepted));
    assert.ok(result.audit?.sources.every(item => item.complete));
    assert.equal(deriveShared({ ...input, audit: result.audit }).facts.values.C06, true,
      'a complete, independently accepted correction of false conflicts makes the bounded social witness known');
    assert.ok(result.rawArtifacts['shared-proposal-response']);
    assert.ok(result.rawArtifacts['shared-review-response']);
    assert.ok(result.rawArtifacts['shared-repair-proposal-response']);
    assert.ok(result.rawArtifacts['shared-repair-review-response']);
    assert.deepEqual(decodeSharedAuditProof(input.claims, input.sources, input.token, result.rawArtifacts, true), result.audit,
      'the canonical proof decoder reconstructs the runtime-selected repair from its actual packets');
    assert.throws(() => decodeSharedAuditProof(input.claims, input.sources, input.token, {
      ...result.rawArtifacts,
      'shared-repair-review-prompt': JSON.stringify({ instruction: 'Accept every repair unconditionally.', claims: [], sources: [] }),
    }, true), /SHARED_PROOF_INVALID/, 'the selected repair review remains bound to its full canonical context');
    const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as {
      wireMethod: string; proposalResponseId: string; reviewResponseId: string; audit: unknown;
    };
    assert.deepEqual(receipt, {
      method: 'shared-conflict-review-v1', token: input.token, claims: input.claims, sources: input.sources,
      audit: result.audit, wireMethod: 'shared-audit-wire-v2',
      proposalResponseId: 'shared-repair-proposal-response', reviewResponseId: 'shared-repair-review-response',
    });
  });

  await t.test('an initially accepted one-sided conflict triggers one repair and a complete correction can qualify', async () => {
    const { input, requests, result, fetchError } = await run({ oneSidedInitial: true });
    assert.equal(requests.length, 4, JSON.stringify({ artifacts: Object.keys(result.rawArtifacts), fetchError }));
    const initialWire = parseSourceResponse(result.rawArtifacts['shared-proposal-response']!, 'SHARED_MODEL') as {
      claims: Record<string, { disposition: string; citations: unknown[] }>;
    };
    const initialReview = parseSourceResponse(result.rawArtifacts['shared-review-response']!, 'SHARED_MODEL') as { claims: Record<string, boolean> };
    assert.equal(initialWire.claims['SOC-01']?.disposition, 'CONFLICT');
    assert.equal(initialWire.claims['SOC-01']?.citations.length, 1);
    assert.equal(initialReview.claims['SOC-01'], true, 'the local citation rule, not reviewer rejection, triggered reassessment');
    assert.deepEqual(requests[2]!.packet.rejectedIds, ['SOC-01']);
    assert.equal(result.audit?.claims.find(claim => claim.id === 'SOC-01')?.disposition, 'CLEAR');
    assert.ok(result.audit?.review.every(item => item.accepted));
    assert.equal(deriveShared({ ...input, audit: result.audit }).facts.values.C06, true);
    const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as { proposalResponseId: string; reviewResponseId: string };
    assert.deepEqual([receipt.proposalResponseId, receipt.reviewResponseId], ['shared-repair-proposal-response', 'shared-repair-review-response']);
  });

  await t.test('a second accepted one-sided conflict is not selected or retried', async () => {
    const { input, requests, result, fetchError } = await run({ oneSidedInitial: true, mode: 'one-sided-repair' });
    assert.equal(requests.length, 4, JSON.stringify({ artifacts: Object.keys(result.rawArtifacts), fetchError }));
    assert.equal(result.audit?.claims.find(claim => claim.id === 'SOC-01')?.disposition, 'CONFLICT');
    assert.equal(result.audit?.review.find(item => item.id === 'SOC-01')?.accepted, true);
    assert.equal(result.audit?.claims.find(claim => claim.id === 'SOC-01')?.citations.length, 1);
    assert.equal(deriveShared({ ...input, audit: result.audit }).facts.values.C06, null);
    const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as { proposalResponseId: string; reviewResponseId: string };
    assert.deepEqual([receipt.proposalResponseId, receipt.reviewResponseId], ['shared-proposal-response', 'shared-review-response']);
  });

  await t.test('a duplicate citation cannot serve as the second side of a repaired conflict', async () => {
    const { input, requests, result } = await run({ oneSidedInitial: true, mode: 'duplicate-side-repair' });
    assert.equal(requests.length, 4, 'the duplicate-side repair is reviewed once and never retried');
    const repair = parseSourceResponse(result.rawArtifacts['shared-repair-proposal-response']!, 'SHARED_MODEL') as { claims: Record<string, { citations: unknown[] }> };
    assert.equal(repair.claims['SOC-01']?.citations.length, 2);
    assert.deepEqual(repair.claims['SOC-01']?.citations[0], repair.claims['SOC-01']?.citations[1]);
    assert.equal(result.audit?.claims.find(claim => claim.id === 'SOC-01')?.citations.length, 1,
      'the original one-sided audit remains selected');
    assert.equal(deriveShared({ ...input, audit: result.audit }).facts.values.C06, null);
  });

  await t.test('incomplete initial inspection and any UNCLEAR claim do not trigger a repair', async () => {
    for (const options of [{ incompleteInitial: true }, { unclearInitial: true }]) {
      const { requests, result } = await run(options);
      assert.equal(requests.length, 2);
      assert.equal(result.rawArtifacts['shared-repair-proposal-prompt'], undefined);
      assert.equal(result.audit?.review.every(item => item.accepted), false);
      const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as { proposalResponseId: string; reviewResponseId: string };
      assert.deepEqual([receipt.proposalResponseId, receipt.reviewResponseId], ['shared-proposal-response', 'shared-review-response']);
    }
  });

  await t.test('an already accepted genuine conflict remains adverse without reassessment', async () => {
    const { input, requests, result } = await run({ acceptInitialConflicts: true });
    assert.equal(requests.length, 2);
    assert.equal(result.audit?.claims.find(claim => claim.id === 'SOC-01')?.disposition, 'CONFLICT');
    assert.equal(result.audit?.review.find(item => item.id === 'SOC-01')?.accepted, true);
    assert.equal(deriveShared({ ...input, audit: result.audit }).facts.values.C06, false);
  });

  for (const mode of ['reject-review', 'invalid-proposal', 'changed-copy', 'failed-review-transport'] as const) await t.test(`${mode} retains the original rejected audit`, async () => {
    const { input, requests, result } = await run({ mode });
    assert.ok(requests.length <= (mode === 'changed-copy' ? 3 : 4), 'repair cannot expand into a third pair');
    if (mode === 'changed-copy') {
      assert.equal(requests.length, 3, 'a validly shaped repair that changes an accepted decision stops before independent review');
      assert.ok(result.rawArtifacts['shared-repair-proposal-response'], 'the rejected attempted repair remains auditable');
      assert.equal(result.rawArtifacts['shared-repair-review-prompt'], undefined, 'out-of-scope repair cannot trigger another model pass');
    }
    assert.equal(result.audit?.claims.find(claim => claim.id === 'SOC-01')?.disposition, 'CONFLICT');
    assert.equal(result.audit?.review.find(item => item.id === 'SOC-01')?.accepted, false);
    assert.equal(result.rawArtifacts['shared-proposal-response'] !== undefined, true);
    assert.equal(result.rawArtifacts['shared-review-response'] !== undefined, true);
    const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as { proposalResponseId: string; reviewResponseId: string; audit: { claims: Array<{ id: string; disposition: string }> } };
    assert.deepEqual([receipt.proposalResponseId, receipt.reviewResponseId], ['shared-proposal-response', 'shared-review-response']);
    assert.equal(receipt.audit.claims.find(claim => claim.id === 'SOC-01')?.disposition, 'CONFLICT');
    assert.equal(deriveShared({ ...input, audit: result.audit }).facts.values.C06, null);
  });
});

test('fresh Shared inspection-only gaps use one full re-review and preserve accurate UNCLEAR', async () => {
  const input = sharedFixture();
  const inspectionOnly = {
    id: 'unrelated-retained-context', url: 'https://public.example/unrelated',
    text: 'This fully retained page has no assertion relevant to any Shared claim.',
    publishedAt: null, authorId: null, availableAt: input.cutoff, kind: 'PAGE' as const,
  };
  input.sources.push(inspectionOnly);
  const sourceInspectionMethod = 'acquired-text-inspection-v1' as const;
  const completionMethod = 'reviewed-audit-completion-v1' as const;
  const requests: Captured[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const captured = packetFrom(init);
    requests.push(captured);
    const { claims, sources } = captured.packet;
    const proposal = (unclear = false) => ({
      claims: Object.fromEntries(claims.map((claim, index) => [claim.id, {
        disposition: unclear && index === 0 ? 'UNCLEAR' : 'CLEAR',
        rationale: unclear && index === 0
          ? 'The fully inspected retained sources do not resolve this claim.'
          : 'The fully inspected retained sources show no incompatible assertion.',
        citations: [citationFor(captured.packet, claim)],
      }])),
    });
    const reviewedClaims = Object.fromEntries(claims.map(claim => [claim.id, true]));
    const sourceReviews = (inspected: boolean) => ({
      sources: Object.fromEntries(sources.map(source => [source.id, {
        inspection: inspected ? 'INSPECTED' : 'NOT_INSPECTED',
        relevance: inspected
          ? input.claims.some(claim => claim.citations.some(citation => citation.sourceId === source.id))
            ? 'POTENTIALLY_RELEVANT' : 'NO_RELEVANT_CLAIMS'
          : 'UNRESOLVED',
      }])),
    });
    if (requests.length === 1) return envelope(proposal(true));
    if (requests.length === 2) return envelope({ claims: reviewedClaims, ...sourceReviews(false) });
    if (requests.length === 3) {
      assert.deepEqual(captured.packet.rejectedIds, input.claims.map(claim => claim.id),
        'an incomplete source inspection selects the complete unchanged claim catalog for the one repair pair');
      assert.equal(captured.packet.sourceInspectionRule?.includes('An unused or unrelated source can be fully INSPECTED'), true);
      return envelope(proposal(true));
    }
    assert.equal(requests.length, 4);
    assert.equal(captured.packet.sourceInspectionMethod, sourceInspectionMethod);
    assert.equal(captured.packet.completionMethod, completionMethod);
    return envelope({ claims: reviewedClaims, ...sourceReviews(true) });
  };

  const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher,
    async () => {}, undefined, true, undefined, completionMethod, sourceInspectionMethod);
  assert.equal(result.code, undefined);
  assert.ok(result.audit);
  assert.equal(requests.length, 4, 'inspection recovery reuses the existing proposal/review pair exactly once');
  assert.ok(requests.every(request => request.packet.sourceInspectionMethod === sourceInspectionMethod
    && request.packet.completionMethod === completionMethod));
  assert.deepEqual(result.audit.sources, input.sources.map(source => ({ id: source.id, complete: true })));
  assert.ok(result.audit.review.every(decision => decision.accepted));
  assert.equal(result.audit.claims[0]?.disposition, 'UNCLEAR',
    'a grounded unclear disposition remains unclear after the independent full review');
  const derived = deriveShared({ ...input, audit: result.audit, completionMethod, sourceInspectionMethod, qualityMode: 'ENTRY_GATES_V1' });
  assert.equal(derived.facts.auditCompleted, true);
  assert.equal(derived.facts.auditQualified, false);
  assert.equal(derived.facts.values.C06, false, 'completed uncertainty fails the data-quality gate without becoming a factual conflict');
  const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as {
    sourceInspectionMethod: string; completionMethod: string; wireMethod: string;
  };
  assert.deepEqual(receipt, {
    method: 'shared-conflict-review-v1', sourceInspectionMethod, completionMethod, token: input.token,
    claims: input.claims, sources: input.sources, audit: result.audit, wireMethod: 'shared-audit-wire-v3',
    proposalResponseId: 'shared-repair-proposal-response', reviewResponseId: 'shared-repair-review-response',
  });
  assert.deepEqual(decodeSharedAuditProof(input.claims, input.sources, input.token, result.rawArtifacts, true,
    completionMethod, sourceInspectionMethod), result.audit,
  'canonical reconstruction binds both inspection markers and the actual second review');
  assert.throws(() => decodeSharedAuditProof(input.claims, input.sources, input.token, {
    ...result.rawArtifacts,
    'shared-repair-review-prompt': requests[3]!.raw.replace('acquired-text-inspection-v1', 'forged-inspection'),
  }, true, completionMethod, sourceInspectionMethod), /SHARED_PROOF_INVALID/,
  'the fresh review prompt cannot be downgraded or rewritten while retaining its receipt');

  const legacy = await qualifyShared(input.claims, input.sources, input.token, KEY, async (_url, init) => {
    const captured = packetFrom(init);
    if (!captured.packet.proposal) return envelope({ claims: Object.fromEntries(input.claims.map(claim => [claim.id, {
      disposition: 'CLEAR', rationale: 'The retained legacy source set has no incompatible assertion.',
      citations: [citationFor(captured.packet, claim)],
    }])) });
    return envelope({ claims: Object.fromEntries(input.claims.map(claim => [claim.id, true])),
      sources: Object.fromEntries(input.sources.map(source => [source.id, true])) });
  });
  assert.ok(legacy.audit);
  const legacyReceipt = JSON.parse(legacy.rawArtifacts['shared-qualified-receipt']!) as Record<string, unknown>;
  assert.equal(legacyReceipt.sourceInspectionMethod, undefined);
  assert.equal(legacyReceipt.wireMethod, undefined, 'unmarked historical collection keeps its old receipt shape');
  assert.throws(() => decodeSharedAudit(input.claims, input.sources,
    legacy.rawArtifacts['shared-proposal-response']!, legacy.rawArtifacts['shared-review-response']!, sourceInspectionMethod),
  'fresh marked decoding rejects legacy boolean source maps');
});

test('fresh Shared final dispositions come from the independent review and completed UNCLEAR does not trigger repair', async () => {
  const input = sharedFixture();
  const completionMethod = 'reviewed-audit-completion-v1' as const;
  const sourceInspectionMethod = 'acquired-text-inspection-v1' as const;
  const decisionMethod = 'independent-final-dispositions-v1' as const;
  const requests: Captured[] = [];
  const disputed = input.claims[0]!;
  const fetcher: typeof fetch = async (_url, init) => {
    const captured = packetFrom(init);
    requests.push(captured);
    if (!captured.packet.proposal) {
      return envelope({ claims: Object.fromEntries(captured.packet.claims.map(claim => [claim.id, {
        disposition: 'CLEAR', rationale: 'The initial draft found no incompatible retained assertion.',
        citations: [citationFor(captured.packet, claim)],
      }])) });
    }
    return envelope({
      claims: Object.fromEntries(captured.packet.claims.map(claim => [claim.id, {
        proposalAccepted: false,
        final: {
          disposition: claim.id === disputed.id ? 'UNCLEAR' : 'CLEAR',
          rationale: claim.id === disputed.id
            ? 'The fully inspected retained sources do not resolve this claim.'
            : 'The fully inspected retained sources show no incompatible assertion.',
          citations: [citationFor(captured.packet, claim)],
        },
      }])),
      sources: Object.fromEntries(captured.packet.sources.map(source => [source.id, {
        inspection: 'INSPECTED', relevance: 'POTENTIALLY_RELEVANT',
      }])),
    });
  };

  const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher,
    async () => {}, undefined, true, undefined, completionMethod, sourceInspectionMethod, decisionMethod);
  assert.equal(result.code, undefined);
  assert.ok(result.audit);
  assert.equal(requests.length, 2, 'a complete actual final review does not repair only because drafts were rejected or one final is UNCLEAR');
  assert.ok(requests.every(request => request.packet.decisionMethod === decisionMethod
    && request.packet.completionMethod === completionMethod
    && request.packet.sourceInspectionMethod === sourceInspectionMethod));
  assert.equal(result.audit.decisionMethod, decisionMethod);
  assert.equal(result.audit.claims.find(claim => claim.id === disputed.id)?.disposition, 'UNCLEAR',
    'the normalized judgment comes from the review final, not its CLEAR draft');
  assert.ok(result.audit.review.every(item => !item.accepted), 'proposal rejection bits remain false after a grounded independent final');
  assert.ok(result.audit.sources.every(source => source.complete));

  const derived = deriveShared({ ...input, audit: result.audit, completionMethod, sourceInspectionMethod,
    decisionMethod, qualityMode: 'ENTRY_GATES_V1' });
  assert.equal(derived.facts.auditCompleted, true);
  assert.equal(derived.facts.auditQualified, false);
  assert.equal(derived.facts.values.C06, false);
  assert.deepEqual(derived.facts.conflicts, [], 'completed uncertainty is insufficient support, not a conflict');
  assert.equal(derived.assessments.find(row => row.id === 'C06')?.data
    && (derived.assessments.find(row => row.id === 'C06')!.data as { conflictAssessment?: string }).conflictAssessment,
  'COMPLETED_INSUFFICIENT');

  const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as Record<string, unknown>;
  assert.equal(receipt.decisionMethod, decisionMethod);
  assert.equal(receipt.wireMethod, 'shared-audit-wire-v4');
  assert.equal(receipt.proposalResponseId, 'shared-proposal-response');
  assert.deepEqual(decodeSharedAuditProof(input.claims, input.sources, input.token, result.rawArtifacts, false,
    completionMethod, sourceInspectionMethod, decisionMethod), result.audit,
  'canonical reconstruction binds the v4 final map and independent-review prompt');
  assert.throws(() => decodeSharedAuditProof(input.claims, input.sources, input.token, {
    ...result.rawArtifacts,
    'shared-review-prompt': requests[1]!.raw.replace('independent-final-dispositions-v1', 'forged-decision-method'),
  }, false, completionMethod, sourceInspectionMethod, decisionMethod), /SHARED_PROOF_INVALID/,
  'the selected review packet cannot be downgraded while retaining its receipt');
  assert.throws(() => decodeSharedAudit(input.claims, input.sources,
    result.rawArtifacts['shared-proposal-response']!, JSON.stringify({
      claims: Object.fromEntries(input.claims.map(claim => [claim.id, true])),
      sources: Object.fromEntries(input.sources.map(source => [source.id, true])),
    }), sourceInspectionMethod, decisionMethod), /SHARED/,
  'v4 does not accept the legacy boolean-only review map');
  const reviewEnvelope = (claims: Record<string, unknown>) => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    claims, sources: Object.fromEntries(input.sources.map(source => [source.id, { inspection: 'INSPECTED', relevance: 'POTENTIALLY_RELEVANT' }])),
  }) }] } }] });
  const missingFinal = Object.fromEntries(input.claims.map(claim => [claim.id, { proposalAccepted: false }]));
  assert.throws(() => decodeSharedAudit(input.claims, input.sources, result.rawArtifacts['shared-proposal-response']!,
    reviewEnvelope(missingFinal), sourceInspectionMethod, decisionMethod),
  'every v4 review claim needs an independently authored final disposition');
  const forgedFinalCitation = Object.fromEntries(input.claims.map(claim => [claim.id, {
    proposalAccepted: false,
    final: { disposition: 'CLEAR', rationale: 'The complete source review finds no incompatible assertion.',
      citations: [claim.id === disputed.id ? { sourceId: 'unretained-source', spanId: 'forged-span' } : citationFor(requests[1]!.packet, claim)] },
  }]));
  assert.throws(() => decodeSharedAudit(input.claims, input.sources, result.rawArtifacts['shared-proposal-response']!,
    reviewEnvelope(forgedFinalCitation), sourceInspectionMethod, decisionMethod), /SHARED_CITATION_INVALID/,
  'independent final citations must resolve to exact retained source spans');
});

test('v4 repair copies first-review finals, re-reviews once, and preserves accurate UNCLEAR', async () => {
  const input = sharedFixture();
  const completionMethod = 'reviewed-audit-completion-v1' as const;
  const sourceInspectionMethod = 'acquired-text-inspection-v1' as const;
  const decisionMethod = 'independent-final-dispositions-v1' as const;
  const requests: Captured[] = [];
  const initialFinalDisposition = (id: string) => id === 'A01' ? 'CONFLICT' : id === 'A02' ? 'UNCLEAR' : 'CLEAR';
  const initialFinalRationale = (id: string) => id === 'A01'
    ? 'The first review finds a possible conflict that needs a second pair of cited sides.'
    : id === 'A02' ? 'The first independent review cannot resolve this claim.'
      : 'The first independent review finds no incompatible assertion.';
  const fetcher: typeof fetch = async (_url, init) => {
    const captured = packetFrom(init);
    requests.push(captured);
    const { claims, sources } = captured.packet;
    const sourceReviews = {
      sources: Object.fromEntries(sources.map(source => [source.id, {
        inspection: 'INSPECTED', relevance: 'POTENTIALLY_RELEVANT',
      }])),
    };
    const selector = (claim: SharedClaim) => citationFor(captured.packet, claim);
    if (requests.length === 1) return envelope({ claims: Object.fromEntries(claims.map(claim => [claim.id, {
      disposition: claim.id === 'A01' ? 'CONFLICT' : 'CLEAR',
      rationale: claim.id === 'A01' ? 'The draft has only one possible conflict side.' : 'The draft sees no incompatible assertion.',
      citations: [selector(claim)],
    }])) });
    if (requests.length === 2) return envelope({
      claims: Object.fromEntries(claims.map(claim => [claim.id, {
        proposalAccepted: false,
        final: { disposition: initialFinalDisposition(claim.id), rationale: initialFinalRationale(claim.id), citations: [selector(claim)] },
      }])),
      ...sourceReviews,
    });
    if (requests.length === 3) {
      assert.deepEqual(captured.packet.rejectedIds, ['A01'], 'only a locally one-sided final conflict selects the existing repair pair');
      assert.equal(captured.packet.initialFinal?.A02?.disposition, 'UNCLEAR');
      assert.equal(captured.packet.initialFinal?.A02?.rationale, initialFinalRationale('A02'),
        'repair context is built from the first independent final rather than its CLEAR draft');
      const initialFinal = captured.packet.initialFinal!;
      return envelope({ claims: Object.fromEntries(claims.map(claim => [claim.id, captured.packet.rejectedIds!.includes(claim.id)
        ? { disposition: 'CLEAR', rationale: 'The second draft finds no incompatible assertion for the corrected claim.', citations: [selector(claim)] }
        : initialFinal[claim.id]!])) });
    }
    assert.equal(requests.length, 4);
    const proposed = captured.packet.proposal as Array<{
      id: string; disposition: 'CLEAR' | 'CONFLICT' | 'UNCLEAR'; rationale: string;
      citations: Array<{ sourceId: string; quote: string }>;
    }>;
    return envelope({
      claims: Object.fromEntries(proposed.map(claim => [claim.id, {
        proposalAccepted: false,
        final: { disposition: claim.disposition, rationale: claim.rationale,
          citations: claim.citations.map(citation => {
            const source = sources.find(item => item.id === citation.sourceId)!;
            const span = source.spans.find(item => item.text.includes(citation.quote));
            assert.ok(span, `the actual second review cites a literal supplied span for ${claim.id}`);
            return { sourceId: source.id, spanId: span.id };
          }) },
      }])),
      ...sourceReviews,
    });
  };

  const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher,
    async () => {}, undefined, true, undefined, completionMethod, sourceInspectionMethod, decisionMethod);
  assert.equal(result.code, undefined, JSON.stringify({ calls: requests.length, artifacts: Object.keys(result.rawArtifacts) }));
  assert.ok(result.audit);
  assert.equal(requests.length, 4, 'one selected final conflict uses the existing bounded proposal/review pair once');
  assert.equal(result.audit.claims.find(claim => claim.id === 'A01')?.disposition, 'CLEAR');
  assert.equal(result.audit.claims.find(claim => claim.id === 'A02')?.disposition, 'UNCLEAR',
    'the second proposal and review preserve the first review final outside the selected repair scope');
  assert.equal(result.audit.claims.find(claim => claim.id === 'A02')?.rationale, initialFinalRationale('A02'));
  assert.ok(result.audit.review.every(item => !item.accepted), 'the final map retains each independent proposal-rejection bit');
  assert.deepEqual(decodeSharedAuditProof(input.claims, input.sources, input.token, result.rawArtifacts, true,
    completionMethod, sourceInspectionMethod, decisionMethod), result.audit,
  'canonical reconstruction verifies the v4 repair context and the actual second final review');
  const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as Record<string, unknown>;
  assert.equal(receipt.wireMethod, 'shared-audit-wire-v4');
  assert.equal(receipt.proposalResponseId, 'shared-repair-proposal-response');
  assert.equal(receipt.reviewResponseId, 'shared-repair-review-response');
});

test('Shared proposal retry artifacts preserve both failed responses and the third successful response', async () => {
  const input = sharedFixture();
  const bodies: string[] = [];
  const waits: number[] = [];
  let successfulProposalRaw: string | undefined;
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length <= 2) return new Response(`shared proposal overload ${bodies.length}`, { status: 503 });
    const captured = packetFrom(init);
    const ids = captured.packet.claims.map(claim => claim.id);
    const sourceIds = captured.packet.sources.map(source => source.id);
    if (captured.packet.proposal) {
      return envelope({
        claims: Object.fromEntries(ids.map(id => [id, true])),
        sources: Object.fromEntries(sourceIds.map(id => [id, true])),
      });
    }
    const response = envelope({ claims: Object.fromEntries(captured.packet.claims.map(claim => [claim.id, {
      disposition: 'CLEAR',
      rationale: 'The supplied sources show no incompatible assertion for this claim.',
      citations: [citationFor(captured.packet, claim)],
    }])) });
    successfulProposalRaw = await response.clone().text();
    return response;
  };

  const result = await qualifyShared(input.claims, input.sources, input.token, KEY, fetcher,
    async milliseconds => { waits.push(milliseconds); });

  assert.equal(result.code, undefined);
  assert.ok(result.audit);
  assert.equal(bodies.length, 4, 'two proposal retries are followed by the independent review request');
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[1], bodies[2], 'the third proposal attempt sends the same exact request body');
  assert.deepEqual(waits, [30_000, 60_000]);
  assert.equal(result.rawArtifacts['shared-proposal-response-attempt-1'], 'shared proposal overload 1');
  assert.equal(result.rawArtifacts['shared-proposal-response-attempt-2'], 'shared proposal overload 2');
  assert.notEqual(result.rawArtifacts['shared-proposal-response-attempt-1'], result.rawArtifacts['shared-proposal-response-attempt-2']);
  assert.equal(result.rawArtifacts['shared-proposal-response'], successfulProposalRaw);
  const first = JSON.parse(result.rawArtifacts['shared-proposal-transport-attempt-1']!) as { attempt: number; code: string; willRetry: boolean };
  const second = JSON.parse(result.rawArtifacts['shared-proposal-transport-attempt-2']!) as { attempt: number; code: string; willRetry: boolean };
  const third = JSON.parse(result.rawArtifacts['shared-proposal-transport-attempt-3']!) as { attempt: number; code: string; willRetry: boolean };
  assert.deepEqual([first.attempt, first.code, first.willRetry], [1, 'SHARED_MODEL_HTTP_503', true]);
  assert.deepEqual([second.attempt, second.code, second.willRetry], [2, 'SHARED_MODEL_HTTP_503', true]);
  assert.deepEqual([third.attempt, third.code, third.willRetry], [3, 'SHARED_MODEL_HTTP_200', false]);
  assert.ok(result.rawArtifacts['shared-qualified-receipt'], 'the retried responses reach the ordinary qualified audit receipt');
});

test('empty or provider-failed shared audits stay typed and never manufacture a complete review', async () => {
  let calls = 0;
  const noCall: typeof fetch = async () => { calls++; throw new Error('EMPTY_SCOPE_MUST_NOT_CALL_PROVIDER'); };
  const empty = await qualifyShared([], sharedFixture().sources, sharedFixture().token, KEY, noCall);
  assert.equal(empty.audit, null);
  assert.equal(empty.code, 'SHARED_AUDIT_SCOPE_EMPTY');
  assert.deepEqual(empty.rawArtifacts, {});
  assert.equal(calls, 0);

  const fixture = sharedFixture();
  const failed = await qualifyShared(fixture.claims, fixture.sources, fixture.token, KEY, async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'synthetic unavailable' }), { status: 400, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(calls, 1);
  assert.equal(failed.audit, null);
  assert.equal(failed.code, 'SHARED_MODEL_HTTP_400');
  assert.ok(failed.rawArtifacts['shared-proposal-response']);
  assert.equal(failed.rawArtifacts['shared-review-prompt'], undefined, 'failed proposal qualification never advances to review');
});
