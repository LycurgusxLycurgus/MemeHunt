import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSharedAudit, qualifyShared, sharedTemporalScopeSchema } from '../src/providers/shared-model.js';
import { deriveShared, type SharedClaim } from '../src/domain/shared.js';
import { socialRubric } from '../src/providers/social-model.js';
import type { AttentionSource } from '../src/providers/attention.js';
import { sharedFixture } from './shared-fixtures.js';

const KEY = 'shared-model-test-key';
const capturedCatalog=(packet:Packet)=>packet.sources.flatMap(source=>source.spans);
type Span = { id: string; sourceId: string; start: number; end: number; text: string; spanIndex?: number };
type PacketSource = Omit<AttentionSource, 'text'> & { spans: Span[] };
type Packet = {
  claims: SharedClaim[];
  sources: PacketSource[];
  proposal?: Array<Record<string, unknown>>;
  initialProposal?: Record<string, Record<string, unknown>>;
  rejectedIds?: string[];
  socialScreeningCriteria?: Record<string, string>;
  socialConflictRule?: string;
  temporalScope?: {cutoff:string;socialWindow?:{start:string;end:string};socialFacts?:unknown};
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

function citationFor(packet: Packet, claim: SharedClaim) {
  for (const citation of claim.citations) {
    const source = packet.sources.find(item => item.id === citation.sourceId);
    assert.ok(source, `the source catalog contains ${citation.sourceId}`);
    const span = source.spans.find(item => item.text.includes(citation.quote));
    if (span) return span.spanIndex===undefined?{ sourceId: source.id, spanId: span.id }:{spanIndex:span.spanIndex};
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
            citations.push(other.spans[0]!.spanIndex===undefined?{ sourceId: other.id, spanId: other.spans[0]!.id }:{spanIndex:other.spans[0]!.spanIndex});
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

test('full Shared reassesses only rejected complete social conflicts once and keeps the original audit on any failed repair', async t => {
  type RepairMode = 'accept' | 'reject-review' | 'invalid-proposal' | 'changed-copy' | 'failed-review-transport';
  const run = async (options: {
    mode?: RepairMode; incompleteInitial?: boolean; unclearInitial?: boolean; acceptInitialConflicts?: boolean;
  } = {}) => {
    const input = sharedFixture();
    const requests: Captured[] = [];
    let initialWire: Record<string, Record<string, unknown>> = {};
    const fetcher: typeof fetch = async (_url, init) => {
      const captured = packetFrom(init);
      requests.push(captured);
      const ids = captured.packet.claims.map(claim => claim.id);
      const sourceIds = captured.packet.sources.map(source => source.id);
      if (requests.length === 1) {
        initialWire = Object.fromEntries(captured.packet.claims.map(claim => {
          const falseConflict = ['SOC-01', 'SOC-02'].includes(claim.id);
          const first = citationFor(captured.packet, claim);
          const other = captured.packet.sources.find(source => source.id !== first.sourceId)!;
          const citations = falseConflict
            ? [first, other.spans[0]!.spanIndex===undefined?{ sourceId: other.id, spanId: other.spans[0]!.id }:{spanIndex:other.spans[0]!.spanIndex}]
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
          claims: Object.fromEntries(ids.map(id => [id, options.acceptInitialConflicts || !['SOC-01', 'SOC-02'].includes(id)])),
          sources: Object.fromEntries(sourceIds.map(id => [id, !options.incompleteInitial])),
        });
      }
      if (requests.length === 3) {
        if (options.mode === 'invalid-proposal') return envelope({ claims: { 'SOC-01': { disposition: 'CLEAR' } } });
        const rejectedIds = captured.packet.rejectedIds as string[];
        const original = captured.packet.initialProposal as Record<string, Record<string, unknown>>;
        assert.deepEqual(rejectedIds, options.unclearInitial || options.incompleteInitial || options.acceptInitialConflicts ? [] : ['SOC-01', 'SOC-02']);
        const claims = Object.fromEntries(ids.map(id => [id, rejectedIds.includes(id)
          ? { disposition: 'CLEAR', rationale: 'Full source review finds no incompatible assertion.', citations: [citationFor(captured.packet, input.claims.find(claim => claim.id === id)!)] }
          : original[id]]));
        if (options.mode === 'changed-copy') {
          claims.A01 = { ...original.A01!, rationale: 'The repair changes an accepted non-rejected decision.' };
        }
        for (const id of ids.filter(id => !rejectedIds.includes(id))) {
          if (options.mode === 'changed-copy' && id === 'A01') continue;
          assert.deepEqual(claims[id], original[id], `${id} is copied unchanged`);
        }
        return envelope({ claims });
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
    return { input, requests, result };
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
    const receipt = JSON.parse(result.rawArtifacts['shared-qualified-receipt']!) as {
      wireMethod: string; proposalResponseId: string; reviewResponseId: string; audit: unknown;
    };
    assert.deepEqual(receipt, {
      method: 'shared-conflict-review-v1', token: input.token, claims: input.claims, sources: input.sources,
      audit: result.audit, wireMethod: 'shared-audit-wire-v3',
      proposalResponseId: 'shared-repair-proposal-response', reviewResponseId: 'shared-repair-review-response',
    });
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

test('live Shared citation selectors bind source and span together and reject a one-sided conflict', async () => {
  const fixture = sharedFixture();
  for (const invalid of ['wrong-pair', 'one-sided-conflict'] as const) {
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const { packet } = packetFrom(init);
      const payload = JSON.parse(String(init!.body)) as { generationConfig: { responseJsonSchema: unknown } };
      const schemaText = JSON.stringify(payload.generationConfig.responseJsonSchema);
      assert.ok(capturedCatalog(packet).every(span=>span.text.length>0),'the prompt retains every code-owned exact span');
      const claims = Object.fromEntries(packet.claims.map(claim => [claim.id, {
        disposition: invalid === 'one-sided-conflict' ? 'CONFLICT' : 'CLEAR',
        rationale: 'Synthetic malformed audit must never reach independent review.',
        citations: [invalid === 'wrong-pair'
          ? { sourceId: packet.sources[0]!.id, spanId: packet.sources[1]!.spans[0]!.id }
          : citationFor(packet, claim)],
      }]));
      return envelope({ claims });
    };
    const result = await qualifyShared(fixture.claims, fixture.sources, fixture.token, KEY, fetcher);
    assert.equal(result.audit, null, invalid);
    assert.equal(result.code, invalid==='wrong-pair'?'SHARED_CITATION_INVALID':'SHARED_CONFLICT_CITATIONS_INCOMPLETE', invalid);
    assert.equal(calls, 1, 'invalid selectors or a missing conflict side cannot reach review');
    assert.equal(result.rawArtifacts['shared-review-prompt'], undefined);
  }
});

test('historical Shared decoding retains the original receipt shape and literal citation validation', () => {
  const fixture = sharedFixture();
  const proposal = { claims: Object.fromEntries(fixture.claims.map(claim => [claim.id, {
    disposition: 'CLEAR', rationale: 'Previously retained full-scope audit remains decodable.',
    citations: [{ sourceId: fixture.sources[0]!.id, spanId: `${fixture.sources[0]!.id}:span:0` }],
  }])) };
  const review = { claims: Object.fromEntries(fixture.claims.map(claim => [claim.id, true])), sources: Object.fromEntries(fixture.sources.map(source => [source.id, true])) };
  const wire = (value: unknown) => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
  const audit = decodeSharedAudit(fixture.claims, fixture.sources, wire(proposal), wire(review));
  assert.equal(audit.claims.length, fixture.claims.length);
  assert.equal(audit.claims[0]!.citations[0]!.quote, fixture.sources[0]!.text.slice(0, 1000));
  proposal.claims[fixture.claims[0]!.id]!.citations[0]!.sourceId = fixture.sources[1]!.id;
  assert.throws(() => decodeSharedAudit(fixture.claims, fixture.sources, wire(proposal), wire(review)), /SHARED_CITATION_INVALID/);
});

test('Shared request stays flat at a real-sized thirty-source catalog and accepts complete clear review', async () => {
  const fixture=sharedFixture();
  while(fixture.sources.length<30){const index=fixture.sources.length;fixture.sources.push({...fixture.sources[0]!,id:`scale-source-${index}`,text:`Additional retained source ${index} for the exact same bounded review scope.`});}
  let calls=0;
  const fetcher:typeof fetch=async(_url,init)=>{
    calls++;
    const {packet}=packetFrom(init);
    const payload=JSON.parse(String(init!.body)) as {generationConfig:{responseJsonSchema:unknown}};
    const schema=JSON.stringify(payload.generationConfig.responseJsonSchema);
    assert.equal(schema.includes('anyOf'),false,'source count must not expand nested alternatives');
    assert.equal(schema.includes('oneOf'),false,'disposition validation stays code-owned without nested alternatives');
    if(!packet.proposal){
      assert.ok(packet.sources.every(source=>source.spans.length>0));
      return envelope({claims:Object.fromEntries(packet.claims.map(claim=>[claim.id,{disposition:'CLEAR',rationale:'All retained source context inspected without an incompatible assertion.',citations:[citationFor(packet,claim)]}]))});
    }
    return envelope({claims:Object.fromEntries(packet.claims.map(claim=>[claim.id,true])),sources:Object.fromEntries(packet.sources.map(source=>[source.id,true]))});
  };
  const result=await qualifyShared(fixture.claims,fixture.sources,fixture.token,KEY,fetcher);
  assert.equal(result.code,undefined);
  assert.equal(calls,2);
  assert.equal(result.audit!.sources.length,30);
  assert.ok(result.audit!.sources.every(source=>source.complete));
});

test('full Shared retries a malformed one-sided conflict once and retains its exact response before independent review',async()=>{
  const fixture=sharedFixture();
  for(const repaired of [true,false]){
    let calls=0;
    const fetcher:typeof fetch=async(_url,init)=>{
      calls++;
      const {packet,raw}=packetFrom(init);
      if(packet.proposal)return envelope({claims:Object.fromEntries(packet.claims.map(claim=>[claim.id,true])),sources:Object.fromEntries(packet.sources.map(source=>[source.id,true]))});
      if(calls===2){assert.match(raw,/SHARED_CONFLICT_CITATIONS_INCOMPLETE/);assert.match(raw,/Do not invent a missing side/);}
      return envelope({claims:Object.fromEntries(packet.claims.map(claim=>[claim.id,{disposition:calls===1||!repaired?'CONFLICT':'CLEAR',rationale:'Synthetic retained scope exercises response-contract repair only.',citations:[citationFor(packet,claim)]}]))});
    };
    const result=await qualifyShared(fixture.claims,fixture.sources,fixture.token,KEY,fetcher,async()=>{},undefined,true);
    assert.ok(result.rawArtifacts['shared-proposal-contract-attempt-1-response'],'the malformed hosted response remains auditable');
    if(repaired){assert.equal(result.code,undefined);assert.equal(calls,3);assert.ok(result.audit!.review.every(row=>row.accepted));assert.notEqual(result.rawArtifacts['shared-proposal-response'],result.rawArtifacts['shared-proposal-contract-attempt-1-response']);}
    else{assert.equal(result.code,'SHARED_CONFLICT_CITATIONS_INCOMPLETE');assert.equal(calls,2);assert.equal(result.audit,null);assert.equal(result.rawArtifacts['shared-review-prompt'],undefined);}
  }
});

test('Shared proposal and independent review receive identical exact social time bounds and derived facts',async()=>{
  const fixture=sharedFixture(),scope={cutoff:fixture.cutoff,socialWindow:{start:fixture.social!.start,end:fixture.social!.end},socialFacts:fixture.social!};
  let calls=0;
  const fetcher:typeof fetch=async(_url,init)=>{
    calls++;
    const {packet,raw}=packetFrom(init);
    assert.deepEqual(packet.temporalScope,scope);
    assert.match(raw,/do not treat collection time as publication time/);
    assert.match(raw,/not independent world truth/);
    assert.match(raw,/do not assume them correct or force acceptance/);
    if(!packet.proposal)return envelope({claims:Object.fromEntries(packet.claims.map(claim=>[claim.id,{disposition:'CLEAR',rationale:'Retained dates and exact current window show no incompatible assertions.',citations:[citationFor(packet,claim)]}]))});
    return envelope({claims:Object.fromEntries(packet.claims.map(claim=>[claim.id,true])),sources:Object.fromEntries(packet.sources.map(source=>[source.id,true]))});
  };
  const result=await qualifyShared(fixture.claims,fixture.sources,fixture.token,KEY,fetcher,async()=>{},undefined,true,scope);
  assert.equal(result.code,undefined);
  assert.equal(calls,2);
  assert.deepEqual(JSON.parse(result.rawArtifacts['shared-qualified-receipt']!).temporalScope,scope);
  assert.equal(sharedTemporalScopeSchema.safeParse({...scope,socialWindow:{start:scope.cutoff,end:'2099-01-01T00:00:00.000Z'}}).success,false);
  assert.equal(sharedTemporalScopeSchema.safeParse({...scope,socialFacts:{...scope.socialFacts,end:'2026-10-01T11:00:00.000Z'}}).success,false);
});

test('Shared INDEX wire has a source-count-independent citation schema and rejects invalid or mixed selectors',async()=>{
  const fixture=sharedFixture();
  while(fixture.sources.length<33){const index=fixture.sources.length;fixture.sources.push({...fixture.sources[0]!,id:`large-source-${index}`,text:'Retained full inspection context. '.repeat(220)});}
  for(const invalid of [undefined,-1,0.5,99999,'mixed'] as const){
    let calls=0;
    const fetcher:typeof fetch=async(_url,init)=>{
      calls++;
      const {packet}=packetFrom(init);
      const schema=JSON.stringify((JSON.parse(String(init!.body)) as {generationConfig:{responseJsonSchema:unknown}}).generationConfig.responseJsonSchema);
      if(packet.proposal)return envelope({claims:Object.fromEntries(packet.claims.map(c=>[c.id,true])),sources:Object.fromEntries(packet.sources.map(s=>[s.id,true]))});
      assert.ok(schema.includes('spanIndex'));
      assert.ok(capturedCatalog(packet).length>200,'no source spans are truncated to reduce the schema');
      assert.ok(capturedCatalog(packet).every(span=>!schema.includes(span.id)),'source strings never expand model schema state');
      return envelope({claims:Object.fromEntries(packet.claims.map(claim=>[claim.id,{disposition:'CLEAR',rationale:'Complete synthetic source context exercises closed index selection.',citations:[invalid===undefined?citationFor(packet,claim):invalid==='mixed'?{spanIndex:0,sourceId:packet.sources[0]!.id}:{spanIndex:invalid}]}]))});
    };
    const result=await qualifyShared(fixture.claims,fixture.sources,fixture.token,KEY,fetcher,async()=>{},undefined,true);
    if(invalid===undefined){
      assert.equal(result.code,undefined);assert.equal(calls,2);
      assert.deepEqual(decodeSharedAudit(fixture.claims,fixture.sources,result.rawArtifacts['shared-proposal-response']!,result.rawArtifacts['shared-review-response']!,'INDEX'),result.audit);
      assert.throws(()=>decodeSharedAudit(fixture.claims,fixture.sources,result.rawArtifacts['shared-proposal-response']!,result.rawArtifacts['shared-review-response']!),'historical PAIR decoder must not silently accept INDEX');
    }else{assert.equal(result.code,'SHARED_MODEL_INVALID');assert.equal(calls,1);assert.equal(result.audit,null);}
  }
});
