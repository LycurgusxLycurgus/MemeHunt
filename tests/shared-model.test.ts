import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyShared } from '../src/providers/shared-model.js';
import { deriveShared, type SharedClaim } from '../src/domain/shared.js';
import { socialRubric } from '../src/providers/social-model.js';
import type { AttentionSource } from '../src/providers/attention.js';
import { sharedFixture } from './shared-fixtures.js';

const KEY = 'shared-model-test-key';
type Span = { id: string; sourceId: string; start: number; end: number; text: string };
type PacketSource = Omit<AttentionSource, 'text'> & { spans: Span[] };
type Packet = {
  claims: SharedClaim[];
  sources: PacketSource[];
  proposal?: Array<Record<string, unknown>>;
  initialProposal?: Record<string, Record<string, unknown>>;
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
      audit: result.audit, wireMethod: 'shared-audit-wire-v2',
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
