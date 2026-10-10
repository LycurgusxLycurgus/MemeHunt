import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { sourceSpans, requestSourceJson, parseSourceResponse } from '../src/providers/source-model.js';
import { normalizeSocialProposal, qualifySocial, validateSocialWire } from '../src/providers/social-model.js';
import { deriveSocial } from '../src/domain/social.js';
import type { TokenRef } from '../src/domain/contracts.js';
import type { SocialInput } from '../src/domain/social.js';
import { SOCIAL_AVAILABLE, SOCIAL_CUTOFF, SOCIAL_END, SOCIAL_START, SOCIAL_TOKEN } from './social-fixtures.js';

const KEY = 'social-model-test-key';
type Span = { id: string; sourceId: string; start: number; end: number; text: string };
type PacketSource = { id: string; kind: 'POST' | 'PAGE'; spans: Span[]; lines?: Array<{ id: string; text: string }> };
type WireCitation = { sourceId: string; spanId: string };
type ModelPacket = { sources: PacketSource[]; requiredPostIds: string[]; requiredDecisionIds?: string[]; outputContract?: string; proposal?: { posts: Array<{ sourceId: string; body: { sourceId: string; quote: string }; [key: string]: unknown }>; identities: Array<{ id: string; [key: string]: unknown }>; accounts: Array<{ accountId: string; [key: string]: unknown }>; identityAssessment?: { verdict: string; citations: Array<{ sourceId: string; quote: string }> }; integrityAssessment?: { verdict: string; citations: Array<{ sourceId: string; quote: string }> } }; pairs?: Array<{ id: string }> };
type CapturedRequest = { payload: Record<string, unknown>; packet: ModelPacket };
type CitationMode = 'valid' | 'unknown-span' | 'wrong-source' | 'extra-quote' | 'extra-offset';
type BodyMode = 'complete' | 'body-segment' | 'unresolved' | 'unknown-line' | 'reversed' | 'cross-source';
type PairMode = 'valid' | 'missing' | 'extra';

function input(pageCount = 0, postText = `Alice original post discusses ${SOCIAL_TOKEN.address} and a synthetic neighborhood project.`): SocialInput {
  const post = {
    id: 'post-alice-1', url: 'https://x.com/alice/status/100',
    text: postText,
    publishedAt: '2026-10-03T12:00:00.000Z', authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'POST' as const,
  };
  return {
    schemaVersion: 1,
    sources: [post, ...Array.from({ length: pageCount }, (_, index) => ({
      id: `page-${index + 1}`, url: `https://context${index + 1}.example/about`, text: `Context page ${index + 1} mentions the broader token narrative.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
    }))],
    start: SOCIAL_START, end: SOCIAL_END, targetPostIds: [post.id], identitySourceIds: [],
    sampleComplete: true, identityComplete: false, previousComparable: false, codes: [], queries: ['synthetic source review'], qualifiedAt: SOCIAL_AVAILABLE,
  };
}

function fromRequest(init: RequestInit | undefined): CapturedRequest {
  assert.equal(typeof init?.body, 'string');
  const payload = JSON.parse(String(init!.body)) as Record<string, unknown>;
  const contents = payload.contents as Array<{ parts: Array<{ text: string }> }>;
  return { payload, packet: JSON.parse(contents[0]!.parts[0]!.text) as ModelPacket };
}

function envelope(value: unknown): Response {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }), { headers: { 'content-type': 'application/json' } });
}

function fullText(source: PacketSource): string {
  return [...source.spans].sort((left, right) => left.start - right.start).map(span => span.text).join('');
}

function proposalWire(packet: ModelPacket, citationMode: CitationMode = 'valid', bodyMode: BodyMode = 'complete', judgmentVerdict: 'CONTRADICTED' | 'UNRESOLVED' = 'UNRESOLVED') {
  const source = packet.sources.find(row => row.id === packet.requiredPostIds[0]);
  assert.ok(source);
  const span = source.spans.find(row => row.text.includes(SOCIAL_TOKEN.address));
  assert.ok(span);
  const otherSource = packet.sources.find(row => row.id !== source.id);
  const citation: WireCitation & Record<string, unknown> = {
    sourceId: source.id,
    spanId: citationMode === 'unknown-span' ? 'span-does-not-exist' : citationMode === 'wrong-source' ? otherSource?.spans[0]?.id ?? span.id : span.id,
    ...(citationMode === 'extra-quote' ? { quote: span.text } : {}),
    ...(citationMode === 'extra-offset' ? { start: span.start, end: span.end } : {}),
  };
  const assessmentCitation = { ...citation };
  const posts = packet.requiredPostIds.map(sourceId => {
    const postSource = packet.sources.find(row => row.id === sourceId);
    assert.ok(postSource?.lines?.length);
    const lineIds = postSource.lines.map(line => line.id);
    const body = bodyMode === 'unresolved' ? null : {
      firstLineId: bodyMode === 'unknown-line' ? 'missing-line-id' : bodyMode === 'cross-source' ? `${otherSource?.id ?? 'other'}:line:0` : lineIds[bodyMode === 'reversed' || bodyMode === 'body-segment' ? 1 : 0] ?? 'missing-line-id',
      lastLineId: lineIds[bodyMode === 'reversed' ? 0 : bodyMode === 'body-segment' ? Math.max(1, lineIds.length - 2) : lineIds.length - 1] ?? 'missing-line-id',
    };
    return {
      sourceId, body, role: 'ORIGINAL', binding: 'EXACT_CONTRACT', bindingProof: [],
      parentSourceId: null, origin: null, community: null, campaign: null,
      metrics: { likes: null, replies: null, reposts: null },
    };
  });
  return {
    identityAssessment: { verdict: 'UNRESOLVED', rationale: 'The synthetic packet has no complete independent official-account source scope.', citations: [assessmentCitation] },
    integrityAssessment: {
      verdict: judgmentVerdict,
      rationale: judgmentVerdict === 'CONTRADICTED'
        ? 'The only publication predates the current sample and does not establish current source activity; this is a bounded visibility shortfall.'
        : 'The synthetic one-post sample cannot establish a complete integrity assessment.',
      citations: [assessmentCitation],
    },
    posts, identities: [], accounts: [],
  };
}

function reviewWire(packet: ModelPacket, pairMode: PairMode = 'valid', sourceComplete = true) {
  const proposal = packet.proposal;
  assert.ok(proposal);
  return {
    decisions: [
      { id: 'assessment:identity', accepted: true, rationale: 'The synthetic identity screening rationale matches its cited public source.' },
      { id: 'assessment:integrity', accepted: true, rationale: 'The synthetic integrity screening rationale matches its cited public source.' },
      ...proposal.posts.map(post => ({ id: `post:${post.sourceId}`, accepted: true, rationale: 'The synthetic source supports this complete original-body citation.' })),
      ...proposal.identities.map(identity => ({ id: `identity:${identity.id}`, accepted: true, rationale: 'The synthetic identity record is separately reviewed.' })),
      ...proposal.accounts.map(account => ({ id: `account:${account.accountId}`, accepted: true, rationale: 'The synthetic account fields are separately reviewed.' })),
    ],
    sources: packet.sources.map(source => ({ sourceId: source.id, complete: sourceComplete, rationale: sourceComplete
      ? 'The full synthetic source was inspected for omitted assertions.'
      : 'The source could not be completely inspected.' })),
    pairs: Object.fromEntries([
      ...(packet.pairs ?? []).map(pair => [pair.id, { relation: 'DISTINCT_COMMENTARY', rationale: 'The synthetic records contain distinct commentary.' }] as const),
      ...(pairMode === 'extra' ? [['copy:invented:left:right', { relation: 'DISTINCT_COMMENTARY', rationale: 'This pair was not supplied by the code.' }] as const] : []),
    ].filter(([id]) => !(pairMode === 'missing' && id === packet.pairs?.[0]?.id))),
  };
}

function inputWithCopiedPosts(): SocialInput {
  const value = input();
  const original = value.sources[0]!;
  const second = { ...original, id: 'post-alice-2', url: 'https://x.com/alice/status/101', publishedAt: '2026-10-03T12:01:00.000Z' };
  value.sources.push(second);
  value.targetPostIds.push(second.id);
  return value;
}

function mockModel(options: { citationMode?: CitationMode; bodyMode?: BodyMode; pairMode?: PairMode; status?: number; sourceComplete?: boolean; judgmentVerdict?: 'CONTRADICTED' | 'UNRESOLVED'; responder?: (packet: ModelPacket, call: number) => unknown } = {}) {
  const calls: CapturedRequest[] = [];
  const responses: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = fromRequest(init);
    calls.push(request);
    if (options.status) return new Response('provider rejected request', { status: options.status });
    const value = options.responder?.(request.packet, calls.length) ?? (calls.length === 1
      ? proposalWire(request.packet, options.citationMode, options.bodyMode, options.judgmentVerdict)
      : reviewWire(request.packet, options.pairMode, options.sourceComplete));
    responses.push(value);
    return envelope(value);
  };
  return { calls, responses, fetcher };
}

test('social qualification makes exactly two reviewed passes over identical full source text and retains the normalized receipt', async () => {
  const socialInput = input(2);
  const mock = mockModel();
  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
  assert.equal(mock.calls.length, 2);
  assert.ok(result.proposal);
  assert.ok(result.review);
  assert.equal(result.proposal.identityAssessment?.verdict, 'UNRESOLVED');
  assert.equal(result.proposal.integrityAssessment?.verdict, 'UNRESOLVED');
  assert.deepEqual(result.proposal.identityAssessment?.citations, result.proposal.integrityAssessment?.citations);
  assert.deepEqual(result.review.decisions.filter(row => row.id.startsWith('assessment:')).map(row => row.id), ['assessment:identity', 'assessment:integrity']);
  assert.deepEqual(mock.calls[0]!.packet.sources, mock.calls[1]!.packet.sources);
  assert.equal(fullText(mock.calls[0]!.packet.sources[0]!), socialInput.sources[0]!.text);
  assert.equal(mock.calls[0]!.packet.sources[0]!.spans[0]!.text, socialInput.sources[0]!.text);
  assert.equal(mock.calls[1]!.packet.proposal?.posts[0]?.body.quote, socialInput.sources[0]!.text);
  assert.deepEqual(result.submittedSources, socialInput.sources);
  assert.ok(result.rawArtifacts['social-proposal-prompt']);
  assert.ok(result.rawArtifacts['social-review-prompt']);
  assert.ok(result.rawArtifacts['social-proposal-response']);
  assert.ok(result.rawArtifacts['social-review-response']);
  const receipt = JSON.parse(result.rawArtifacts['social-qualified-receipt']!) as { method: string; read: SocialInput };
  assert.equal(receipt.method, 'social-source-review-v1');
  assert.deepEqual(receipt.read, socialInput);
  const proposalPacket = JSON.parse(result.rawArtifacts['social-proposal-prompt']!) as { instruction: string };
  assert.match(proposalPacket.instruction, /Select supplied sourceId and spanId for citations; code supplies literal quotes/);
  assert.match(proposalPacket.instruction, /firstLineId and lastLineId covering the ENTIRE actual original body/);
  assert.match(proposalPacket.instruction, /Use null when boundaries cannot be established/);
});

test('full Shared repairs only a rejected supported identity screen and preserves the original source records', async t => {
  const run = async (repairReviewAccepted: boolean) => {
    const socialInput = input();
    socialInput.sources.push({
      id: 'profile-alice', url: 'https://x.com/alice',
      text: `Official profile for @alice with token ${SOCIAL_TOKEN.address}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    });
    socialInput.identitySourceIds = ['profile-alice'];
    socialInput.identityComplete = true;
    const originalSources = structuredClone(socialInput.sources);
    const fullSharedReviewWire = (packet: ModelPacket) => {
      const review = reviewWire(packet);
      const decisions = Object.fromEntries(review.decisions.map(({ id, ...decision }) => [id, decision]));
      assert.deepEqual(Object.keys(decisions).sort(), [...packet.requiredDecisionIds!].sort());
      return { ...review, decisions };
    };
    const mock = mockModel({ responder: (packet, call) => {
      const profile = packet.sources.find(source => source.id === 'profile-alice');
      assert.ok(profile, 'every pass receives the same complete identity source');
      const profileSpan = profile.spans.find(span => span.text.includes(SOCIAL_TOKEN.address));
      assert.ok(profileSpan, 'the exact account profile and contract are supplied as a selectable source span');
      const citation = { sourceId: profile.id, spanId: profileSpan.id };
      if (call === 1) {
        const initial = proposalWire(packet);
        return {
          ...initial,
          identityAssessment: {
            verdict: 'SUPPORTED', rationale: 'The profile self-claims the exact contract, though this is not independent corroboration.', citations: [citation],
          },
          identities: [{ id: 'identity:x.com:alice', accountId: 'x.com:alice', status: 'CLAIMED', citations: [citation] }],
        };
      }
      if (call === 2) {
        const initial = fullSharedReviewWire(packet) as { decisions: Record<string, { accepted: boolean }> };
        initial.decisions['assessment:identity']!.accepted = false;
        return initial;
      }
      if (call === 3) return {
        identityAssessment: {
          verdict: 'CONTRADICTED',
          rationale: 'The completely inspected public scope contains only the account self-claim and no independent primary account binding.',
          citations: [citation],
        },
      };
      if (call === 4) {
        const finalReview = fullSharedReviewWire(packet) as { decisions: Record<string, { accepted: boolean }> };
        if (!repairReviewAccepted) finalReview.decisions['assessment:identity']!.accepted = false;
        return finalReview;
      }
      throw new Error(`UNEXPECTED_SOCIAL_REPAIR_CALL_${call}`);
    } });
    const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });
    return { socialInput, originalSources, mock, result };
  };

  await t.test('accepted repair is one fresh proposal and full independent review', async () => {
    const { socialInput, originalSources, mock, result } = await run(true);
    assert.equal(mock.calls.length, 4, 'one original pair plus exactly one bounded repair pair');
    assert.ok(result.proposal && result.review);
    assert.equal(result.proposal.identityAssessment?.verdict, 'CONTRADICTED');
    assert.equal(result.proposal.integrityAssessment?.verdict, 'UNRESOLVED');
    assert.deepEqual(result.submittedSources, originalSources);
    assert.deepEqual(result.proposal.posts.map(post => [post.sourceId, post.body, post.role, post.binding]), [
      ['post-alice-1', { sourceId: 'post-alice-1', quote: socialInput.sources[0]!.text }, 'ORIGINAL', 'EXACT_CONTRACT'],
    ]);
    assert.deepEqual(result.proposal.identities, [{
      id: 'identity:x.com:alice', accountId: 'x.com:alice', status: 'CLAIMED',
      citations: [{ sourceId: 'profile-alice', quote: socialInput.sources[1]!.text }],
    }], 'the targeted screen repair does not rewrite account assertions');
    assert.ok(result.review.decisions.every(decision => decision.accepted), 'the final judgment has a fresh full accepted review');
    assert.deepEqual(result.review.sources.map(source => [source.sourceId, source.complete]), [
      ['post-alice-1', true], ['profile-alice', true],
    ]);

    const repairProposalPacket = mock.calls[2]!.packet as ModelPacket & { selectedAssessmentIds?: string[]; initialProposal?: unknown; initialReview?: unknown };
    const repairReviewPacket = mock.calls[3]!.packet as ModelPacket & { repair?: boolean; initialProposal?: unknown; initialReview?: unknown };
    assert.deepEqual(repairProposalPacket.selectedAssessmentIds, ['assessment:identity']);
    assert.deepEqual(repairProposalPacket.sources, mock.calls[0]!.packet.sources);
    assert.equal(repairReviewPacket.repair, true);
    assert.equal(repairReviewPacket.initialProposal, undefined, 'independent candidate review is blind to the rejected proposal');
    assert.equal(repairReviewPacket.initialReview, undefined, 'independent candidate review is blind to the prior rejection');
    assert.deepEqual(repairReviewPacket.sources, mock.calls[0]!.packet.sources);
    assert.equal(repairProposalPacket.initialProposal !== undefined, true);
    assert.equal(repairProposalPacket.initialReview !== undefined, true);
    assert.equal(repairReviewPacket.proposal?.identityAssessment?.verdict, 'CONTRADICTED');
    assert.equal(mock.calls[1]!.packet.proposal?.identityAssessment?.verdict, 'SUPPORTED', 'the original rejected judgment remains in its own review packet');
    assert.deepEqual(repairReviewPacket.requiredDecisionIds, mock.calls[1]!.packet.requiredDecisionIds);
    assert.ok((mock.calls[3]!.packet.outputContract as string).includes('Copy each key unchanged'));
    assert.ok(Object.hasOwn((mock.responses[1] as { decisions: object }).decisions, 'identity:identity:x.com:alice'));
    assert.ok(Object.hasOwn((mock.responses[3] as { decisions: object }).decisions, 'identity:identity:x.com:alice'));
    assert.notDeepEqual(Object.keys((mock.responses[1] as { decisions: object }).decisions), mock.calls[1]!.packet.requiredDecisionIds,
      'raw object insertion order is deliberately not the canonical required-ID order');
    assert.deepEqual(result.review.decisions.map(decision => decision.id), mock.calls[3]!.packet.requiredDecisionIds,
      'normalized retained decisions use the code-owned required-ID order');

    const initialRaw = parseSourceResponse(result.rawArtifacts['social-proposal-response']!);
    const initial = normalizeSocialProposal(initialRaw, socialInput, SOCIAL_TOKEN).proposal;
    assert.equal(initial.identityAssessment?.verdict, 'SUPPORTED', 'the raw original model response is retained unchanged');
    assert.deepEqual(result.proposal.posts, initial.posts);
    assert.deepEqual(result.proposal.identities, initial.identities);
    assert.deepEqual(result.proposal.accounts, initial.accounts);
    assert.deepEqual(result.proposal.integrityAssessment, initial.integrityAssessment);
    const selection = JSON.parse(result.rawArtifacts['social-repair-selection']!) as {
      method: string; selectedAssessmentIds: string[]; applied: boolean;
    };
    assert.deepEqual(selection, { method: 'social-screening-repair-v1', selectedAssessmentIds: ['assessment:identity'], applied: true });
    const receipt = JSON.parse(result.rawArtifacts['social-qualified-receipt']!) as { wireMethod: string; repairSelectionId: string };
    assert.deepEqual(receipt, { ...receipt, wireMethod: 'social-line-span-v2', repairSelectionId: 'social-repair-selection' });
    assert.ok(result.rawArtifacts['social-repair-proposal-prompt']);
    assert.ok(result.rawArtifacts['social-repair-proposal-response']);
    assert.ok(result.rawArtifacts['social-repair-review-prompt']);
    assert.ok(result.rawArtifacts['social-repair-review-response']);
    assert.doesNotMatch(result.rawArtifacts['social-repair-proposal-prompt']!, /private|secret/i);
    assert.doesNotMatch(result.rawArtifacts['social-repair-review-prompt']!, /private|secret/i);

    validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);
    const tampered = structuredClone(result.proposal);
    tampered.posts[0]!.body.quote += ' forged';
    assert.throws(() => validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, tampered, result.review), /SOCIAL_PROOF_INVALID/);
  });

  await t.test('rejected repair retains the original proposal and does not request a third review', async () => {
    const { socialInput, mock, result } = await run(false);
    assert.equal(mock.calls.length, 4);
    assert.ok(result.proposal && result.review);
    assert.equal(result.proposal.identityAssessment?.verdict, 'SUPPORTED');
    assert.equal(result.review.decisions.find(decision => decision.id === 'assessment:identity')?.accepted, false);
    const selection = JSON.parse(result.rawArtifacts['social-repair-selection']!) as { applied: boolean; code: string };
    assert.deepEqual(selection, {
      method: 'social-screening-repair-v1', selectedAssessmentIds: ['assessment:identity'], applied: false, code: 'SOC_REPAIR_REJECTED',
    });
    validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);
  });
});

test('fresh social wire always carries both source-span judgments and independent review IDs', async () => {
  const mock = mockModel();
  const result = await qualifySocial(input(1), SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
  assert.equal(mock.calls.length, 2, 'both judgments share the established proposal and independent-review passes');
  const proposal = result.proposal;
  assert.ok(proposal?.identityAssessment && proposal.integrityAssessment);
  for (const judgment of [proposal.identityAssessment, proposal.integrityAssessment]) {
    assert.equal(judgment.verdict, 'UNRESOLVED');
    assert.equal(judgment.citations.length, 1);
    const citation = judgment.citations[0]!;
    const source = result.submittedSources.find(row => row.id === citation.sourceId);
    assert.ok(source?.text.includes(citation.quote));
    assert.ok(citation.quote.length >= 8 && citation.quote.length <= 1000);
  }
  const independentReview = result.review;
  assert.ok(independentReview);
  assert.deepEqual(independentReview.decisions.filter(row => row.id.startsWith('assessment:')).map(row => row.id), [
    'assessment:identity', 'assessment:integrity',
  ]);
  assert.deepEqual((mock.responses[1] as { pairs: Record<string, unknown> }).pairs, {}, 'an empty generated candidate set has an exact empty review object');
  const proposalPrompt = result.rawArtifacts['social-proposal-prompt']!;
  assert.match(proposalPrompt, /identityAssessment and integrityAssessment/);
  assert.match(proposalPrompt, /bindingInventory and timeline/);
  assert.match(proposalPrompt, /No independentPrimaryCandidateSourceIds means an account has no possible complete independent public binding path/);
  assert.match(result.rawArtifacts['social-review-prompt']!, /assessment:identity and assessment:integrity/);
  assert.match(result.rawArtifacts['social-review-prompt']!, /localChecks/);
  assert.match(result.rawArtifacts['social-review-prompt']!, /empty candidate list requires an empty object/);
  const proposalCatalog = JSON.parse(proposalPrompt) as { bindingInventory: Array<{ accountId: string; accountContractSourceIds: string[]; independentPrimaryCandidateSourceIds: string[] }>; timeline: Array<{ sourceId: string; publishedAt: string | null; inCurrentWindow: boolean }> };
  assert.deepEqual(proposalCatalog.bindingInventory, [{ accountId: 'x.com:alice', accountContractSourceIds: ['post-alice-1'], independentPrimaryCandidateSourceIds: [] }]);
  assert.deepEqual(proposalCatalog.timeline, [{ sourceId: 'post-alice-1', publishedAt: '2026-10-03T12:00:00.000Z', inCurrentWindow: true }]);
  const reviewCatalog = JSON.parse(result.rawArtifacts['social-review-prompt']!) as { localChecks: { posts: Array<{ bodyComplete: boolean; literalContractInBody: boolean; inCurrentWindow: boolean }> } };
  assert.deepEqual(reviewCatalog.localChecks.posts, [{ sourceId: 'post-alice-1', bodyComplete: true, literalContractInBody: true, inCurrentWindow: true }]);
  const wire = mock.responses[0] as { identityAssessment: { citations: Array<Record<string, unknown>> }; posts: Array<{ body: Record<string, unknown> }> };
  assert.deepEqual(Object.keys(wire.identityAssessment.citations[0]!).sort(), ['sourceId', 'spanId']);
  assert.deepEqual(Object.keys(wire.posts[0]!.body).sort(), ['firstLineId', 'lastLineId']);
  assert.equal(JSON.stringify(wire).includes('quote'), false, 'fresh proposal selectors never contain model-authored citation text');
});

test('fresh model proposals missing either mandatory judgment remain invalid before independent review', async t => {
  for (const missing of ['identityAssessment', 'integrityAssessment'] as const) await t.test(missing, async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const request = fromRequest(init);
      const proposal = proposalWire(request.packet) as Record<string, unknown>;
      delete proposal[missing];
      return envelope(proposal);
    };
    const result = await qualifySocial(input(), SOCIAL_TOKEN, KEY, fetcher, async () => {});
    assert.equal(calls, 1);
    assert.equal(result.proposal, null);
    assert.equal(result.review, null);
    assert.equal(result.code, 'SOC_MODEL_INVALID');
  });
});

test('flat wire citation schema size does not grow with source count while local citation validation stays strict', async () => {
  const small = mockModel();
  await qualifySocial(input(0), SOCIAL_TOKEN, KEY, small.fetcher, async () => {});
  const large = mockModel();
  await qualifySocial(input(15), SOCIAL_TOKEN, KEY, large.fetcher, async () => {});
  const schemaSize = (request: CapturedRequest) => JSON.stringify((request.payload.generationConfig as { responseJsonSchema: unknown }).responseJsonSchema);
  const smallSchema = schemaSize(small.calls[0]!);
  const largeSchema = schemaSize(large.calls[0]!);
  assert.equal(largeSchema, smallSchema);
  assert.ok(largeSchema.length < 20000, `flat response schema was ${largeSchema.length} characters`);
  assert.doesNotMatch(largeSchema, /post-alice-1|page-15/);
});

test('unknown or cross-source span selectors and generated quote or offset fields fail before independent review', async t => {
  for (const citationMode of ['unknown-span', 'wrong-source', 'extra-quote', 'extra-offset'] as const) {
    await t.test(citationMode, async () => {
      const mock = mockModel({ citationMode });
      const result = await qualifySocial(input(1), SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
      assert.equal(mock.calls.length, 1);
      assert.equal(result.proposal, null);
      assert.equal(result.review, null);
      assert.equal(result.code, citationMode === 'extra-quote' || citationMode === 'extra-offset' ? 'SOC_MODEL_INVALID' : 'SOC_CITATION_INVALID');
    });
  }
});

test('line selectors resolve the exact multiline body, preserving CRLF, spaces, and Unicode', async () => {
  const body = `Title repeated above\r\n  Original body line one\r\n  Original body line two has ${SOCIAL_TOKEN.address} and 😀\r\nNavigation footer`;
  const socialInput = input(0, body);
  const mock = mockModel({ bodyMode: 'body-segment' });
  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
  assert.equal(result.code, undefined);
  assert.ok(result.proposal && result.review);
  assert.equal(result.proposal.posts[0]?.body.quote, '  Original body line one\r\n  Original body line two has ' + SOCIAL_TOKEN.address + ' and 😀');
  assert.equal(result.proposal.posts[0]?.bodyComplete, true);
  const manifest = JSON.parse(result.rawArtifacts['social-body-selection']!) as Array<{ sourceId: string; start: number; end: number; length: number; bodyComplete: boolean; reason: string | null }>;
  const expectedStart = body.indexOf('  Original body line one');
  const expectedEnd = body.indexOf('\r\nNavigation footer');
  assert.deepEqual(manifest[0], { sourceId: 'post-alice-1', selection: { firstLineId: 'post-alice-1:line:1', lastLineId: 'post-alice-1:line:2' }, start: expectedStart, end: expectedEnd, length: result.proposal.posts[0]!.body.quote.length, bodyComplete: true, reason: null });
});

test('a CA heading never becomes EXACT_CONTRACT; matching profile and publication can attribute the claimed account', async t => {
  const cases: Array<{ name: string; profileUrl?: string; profileText?: string; expected: 'PROVEN_ACCOUNT' | 'UNCLEAR' }> = [
    {
      name: 'matching account profile',
      profileUrl: 'https://x.com/alice',
      profileText: `Public profile for @alice lists contract ${SOCIAL_TOKEN.address}.`,
      expected: 'PROVEN_ACCOUNT',
    },
    {
      name: 'profile belongs to another account',
      profileUrl: 'https://x.com/bob',
      profileText: `Public profile for @alice lists contract ${SOCIAL_TOKEN.address}.`,
      expected: 'UNCLEAR',
    },
    { name: 'profile unavailable', expected: 'UNCLEAR' },
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    const body = `Title: ${SOCIAL_TOKEN.address}\nOriginal publication by @alice.\nNavigation footer`;
    const socialInput = input(0, body);
    if (scenario.profileUrl && scenario.profileText) {
      socialInput.sources.push({
        id: 'profile-context', url: scenario.profileUrl, text: scenario.profileText,
        publishedAt: null, authorId: scenario.profileUrl.endsWith('/alice') ? 'x.com:alice' : 'x.com:bob',
        availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
      });
      socialInput.identitySourceIds = ['profile-context'];
      socialInput.identityComplete = true;
    }

    const calls: CapturedRequest[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const request = fromRequest(init);
      calls.push(request);
      return envelope(calls.length === 1
        ? proposalWire(request.packet, 'valid', 'body-segment')
        : reviewWire(request.packet));
    };
    const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, fetcher, async () => {});
    assert.equal(calls.length, 2);
    assert.ok(result.proposal && result.review);
    const post = result.proposal.posts[0]!;
    assert.equal(post.body.quote, 'Original publication by @alice.');
    assert.equal(post.bodyComplete, true);
    assert.equal(post.body.quote.includes(SOCIAL_TOKEN.address), false, 'the CA in the excluded title is not part of the original body');
    assert.equal(post.binding, scenario.expected);
    assert.notEqual(post.binding, 'EXACT_CONTRACT');
    if (scenario.expected === 'PROVEN_ACCOUNT') {
      assert.deepEqual(post.bindingProof.map(ref => ref.sourceId), ['profile-context', 'post-alice-1']);
    } else {
      assert.deepEqual(post.bindingProof, []);
    }
    assert.equal(result.proposal.identityAssessment?.verdict, 'UNRESOLVED');
    assert.deepEqual(result.proposal.identities, [], 'source attribution does not authenticate an account identity');
  });
});

test('uncertain or overlong body boundaries remain source-reviewed but body-ineligible and UNCLEAR', async t => {
  const cases = [
    { name: 'unresolved boundary', bodyMode: 'unresolved' as const, bodyText: undefined, reason: 'UNRESOLVED_BOUNDARY' },
    { name: 'length cap', bodyMode: 'complete' as const, bodyText: `${SOCIAL_TOKEN.address} ${'long '.repeat(220)}`, reason: 'LENGTH_CAP' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const mock = mockModel({ bodyMode: scenario.bodyMode });
    const result = await qualifySocial(input(0, scenario.bodyText), SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
    assert.equal(mock.calls.length, 2, 'body boundary ambiguity still receives independent source review');
    assert.ok(result.proposal && result.review);
    assert.equal(result.proposal.posts[0]?.bodyComplete, false);
    assert.equal(result.proposal.posts[0]?.role, 'UNCLEAR');
    assert.equal(result.proposal.posts[0]?.binding, 'UNCLEAR');
    assert.equal(result.proposal.posts[0]?.body.quote, result.submittedSources[0]!.text.slice(0, 1000));
    assert.equal(result.review.sources[0]?.complete, true, 'complete source inspection can accept an unrepresentable body as UNCLEAR');
    const manifest = JSON.parse(result.rawArtifacts['social-body-selection']!) as Array<{ bodyComplete: boolean; reason: string }>;
    assert.deepEqual({ bodyComplete: manifest[0]?.bodyComplete, reason: manifest[0]?.reason }, { bodyComplete: false, reason: scenario.reason });
  });
});

test('a full old-source inspection can support a bounded negative despite body length cap, while incomplete inspection stays unknown', async () => {
  const body = `${SOCIAL_TOKEN.address} ${'old publication detail '.repeat(90)}`;
  const run = async (sourceComplete: boolean) => {
    const socialInput = input(0, body);
    socialInput.sources[0]!.publishedAt = '2026-10-02T23:59:00.000Z';
    const mock = mockModel({ sourceComplete, judgmentVerdict: 'CONTRADICTED' });
    const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
    assert.ok(result.proposal && result.review);
    assert.equal(result.proposal.posts[0]?.bodyComplete, false);
    assert.equal(result.proposal.posts[0]?.role, 'UNCLEAR');
    assert.equal(result.review.sources[0]?.complete, sourceComplete);

    const reviewPacket = JSON.parse(result.rawArtifacts['social-review-prompt']!) as {
      sources: PacketSource[];
      timeline: Array<{ sourceId: string; publishedAt: string | null; inCurrentWindow: boolean }>;
      bodySelectionManifest: Array<{ sourceId: string; bodyComplete: boolean; reason: string }>;
    };
    assert.equal(fullText(reviewPacket.sources[0]!), body, 'the independent reviewer receives all acquired source text');
    assert.deepEqual(reviewPacket.timeline, [{ sourceId: 'post-alice-1', publishedAt: '2026-10-02T23:59:00.000Z', inCurrentWindow: false }]);
    assert.deepEqual(reviewPacket.bodySelectionManifest.map(({ sourceId, bodyComplete, reason }) => ({ sourceId, bodyComplete, reason })), [
      { sourceId: 'post-alice-1', bodyComplete: false, reason: 'LENGTH_CAP' },
    ]);

    return deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  };

  const completelyInspected = await run(true);
  assert.equal(completelyInspected.facts.integrityReview?.verdict, 'CONTRADICTED',
    'an old publication can support the bounded negative even though its selected body exceeds the citation limit');
  const incompletelyInspected = await run(false);
  assert.equal(incompletelyInspected.facts.integrityReview?.verdict, 'UNRESOLVED',
    'incomplete source inspection cannot support a negative judgment');
});

test('malformed, cross-source, and reversed body line selections cannot certify a complete post body', async t => {
  const body = `Title\nOriginal line one\nOriginal line two with ${SOCIAL_TOKEN.address}\nFooter`;
  for (const bodyMode of ['unknown-line', 'reversed', 'cross-source'] as const) await t.test(bodyMode, async () => {
    const mock = mockModel({ bodyMode });
    const result = await qualifySocial(input(1, body), SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
    assert.equal(mock.calls.length, 1);
    assert.equal(result.proposal, null);
    assert.equal(result.review, null);
    assert.equal(result.code, 'SOC_CITATION_INVALID');
  });
});

test('independent review returns only the exact code-generated copy-pair keys', async t => {
  for (const pairMode of ['valid', 'missing', 'extra'] as const) await t.test(pairMode, async () => {
    const mock = mockModel({ pairMode });
    const result = await qualifySocial(inputWithCopiedPosts(), SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
    assert.equal(mock.calls.length, 2);
    assert.deepEqual(mock.calls[1]!.packet.pairs?.map(pair => pair.id), ['copy:post-alice-1:post-alice-2']);
    if (pairMode === 'valid') {
      assert.ok(result.proposal && result.review);
      assert.deepEqual(result.review.pairs.map(pair => pair.id), ['copy:post-alice-1:post-alice-2']);
      assert.deepEqual((mock.responses[1] as { pairs: Record<string, unknown> }).pairs, {
        'copy:post-alice-1:post-alice-2': { relation: 'DISTINCT_COMMENTARY', rationale: 'The synthetic records contain distinct commentary.' },
      });
    } else {
      assert.equal(result.proposal, null);
      assert.equal(result.review, null);
      assert.equal(result.code, 'SOC_MODEL_INVALID', 'missing and invented pair keys fail the strict closed object schema');
    }
  });
});

test('long source spans stay exact and an unspanned required post stops before transport', async () => {
  const longText = 'A'.repeat(2000);
  const spans = sourceSpans('long-source', longText, 'SOC_MODEL');
  assert.equal(spans.map(span => span.text).join(''), longText);
  assert.ok(spans.every(span => span.end - span.start >= 8 && span.end - span.start <= 1000));
  assert.deepEqual(sourceSpans('short-source', '1234567', 'SOC_MODEL'), []);
  assert.deepEqual(sourceSpans('short-source', '1234567'), []);

  const shortInput = input();
  shortInput.sources[0]!.text = 'short!!';
  let calls = 0;
  const tooShort = await qualifySocial(shortInput, SOCIAL_TOKEN, KEY, async () => { calls++; return envelope({}); }, async () => {});
  assert.equal(tooShort.code, 'SOC_TEXT_CAP');
  assert.equal(calls, 0);
});

test('packet transport errors use SOC_MODEL prefix without changing retry or payload contracts', async () => {
  let calls = 0;
  await assert.rejects(() => requestSourceJson('x'.repeat(300001), z.object({ ok: z.boolean() }), KEY,
    async () => { calls++; throw new Error('oversized request must stop before transport'); }, () => {}, async () => {}, undefined, 'SOC_MODEL'),
  /SOC_MODEL_PACKET_LIMIT/);
  assert.equal(calls, 0);

  const retained: string[] = [];
  await assert.rejects(() => requestSourceJson('packet', z.object({ ok: z.boolean() }), KEY,
    async () => new Response('bad request', { status: 400 }),
    raw => { retained.push(raw); }, async () => {}, undefined, 'SOC_MODEL'), /SOC_MODEL_HTTP_400/);
  assert.equal(retained[0], 'bad request');
  const transportReceipt = JSON.parse(retained[1]!) as { kind: string; attempt: number; code: string; willRetry: boolean };
  assert.deepEqual({ kind: transportReceipt.kind, attempt: transportReceipt.attempt, code: transportReceipt.code, willRetry: transportReceipt.willRetry }, {
    kind: 'LOCAL_MODEL_TRANSPORT', attempt: 1, code: 'SOC_MODEL_HTTP_400', willRetry: false,
  });
});

test('proposal timeout retry preserves two logical passes, exact packet identity, and secret-free receipts', async () => {
  const calls: CapturedRequest[] = [];
  const waits: number[] = [];
  const timeout = Object.assign(new Error('private endpoint details and model-secret'), { name: 'TimeoutError' });
  const fetcher: typeof fetch = async (_url, init) => {
    const request = fromRequest(init);
    calls.push(request);
    if (calls.length === 1) throw timeout;
    return calls.length === 2 ? envelope(proposalWire(request.packet)) : envelope(reviewWire(request.packet));
  };
  const result = await qualifySocial(input(), SOCIAL_TOKEN, KEY, fetcher, async milliseconds => { waits.push(milliseconds); });
  assert.equal(calls.length, 3, 'one proposal retry retains the original two logical model passes');
  assert.deepEqual(calls[0]!.packet, calls[1]!.packet, 'the retry resends the identical proposal packet');
  assert.equal(calls[2]!.packet.proposal?.identityAssessment?.verdict, 'UNRESOLVED');
  assert.deepEqual(waits, [30_000]);
  assert.ok(result.proposal && result.review);
  const attempt = JSON.parse(result.rawArtifacts['social-proposal-transport-attempt-1']!) as { code: string; willRetry: boolean };
  assert.equal(attempt.code, 'SOC_MODEL_TIMEOUT');
  assert.equal(attempt.willRetry, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes('private endpoint details'), false);
});

test('caller cancellation during social model retry wait stays unresolved without a second request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw Object.assign(new Error('temporary timeout'), { name: 'TimeoutError' });
  };
  const result = await qualifySocial(input(), SOCIAL_TOKEN, KEY, fetcher, async () => {
    controller.abort(new DOMException('cancelled', 'AbortError'));
  }, controller.signal);
  assert.equal(calls, 1);
  assert.equal(result.code, 'SOC_MODEL_RUN_ABORTED');
  assert.equal(result.proposal, null);
  assert.equal(result.review, null);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('historical-only integrity recovery corrects a rejected current-post premise with independent review', async t => {
  const run = async (options: { accepted?: boolean; complete?: boolean; current?: boolean } = {}) => {
    const socialInput = input();
    if (!options.current) socialInput.sources[0]!.publishedAt = '2026-10-02T23:59:00.000Z';
    const model = mockModel({ responder: (packet, call) => {
      if (call === 1) return proposalWire(packet, 'valid', 'complete', 'CONTRADICTED');
      if (call === 3) {
        const span = packet.sources[0]!.spans[0]!;
        return { integrityAssessment: {
          verdict: 'CONTRADICTED',
          rationale: 'Every inspected publication precedes the declared current window. This bounded public sample cannot establish current visibility; it does not prove global inactivity or fraud.',
          citations: [{ sourceId: span.sourceId, spanId: span.id }],
        } };
      }
      const wire = reviewWire(packet, 'valid', options.complete !== false);
      const decisions = Object.fromEntries(wire.decisions.map(({ id, ...decision }) => [id, decision]));
      decisions['assessment:integrity']!.accepted = call === 4 && options.accepted !== false;
      return { ...wire, decisions };
    } });
    const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, model.fetcher, async () => {}, undefined, { screeningRepair: true });
    return { socialInput, model, result };
  };
  await t.test('accepted correction preserves corpus, other judgments, and replay proof', async () => {
    const { socialInput, model, result } = await run();
    assert.equal(model.calls.length, 4);
    assert.ok(result.proposal && result.review);
    assert.equal(Object.hasOwn(model.calls[3]!.packet, 'initialProposal'), false);
    assert.equal(Object.hasOwn(model.calls[3]!.packet, 'initialReview'), false);
    assert.match(JSON.parse(result.rawArtifacts['social-repair-review-prompt']!).instruction, /Review ONLY the proposal supplied in this request/);
    const original = normalizeSocialProposal(parseSourceResponse(result.rawArtifacts['social-proposal-response']!), socialInput, SOCIAL_TOKEN).proposal;
    assert.deepEqual(result.proposal.posts, original.posts);
    assert.deepEqual(result.proposal.accounts, original.accounts);
    assert.deepEqual(result.proposal.identities, original.identities);
    assert.deepEqual(result.proposal.identityAssessment, original.identityAssessment);
    assert.deepEqual(result.submittedSources, socialInput.sources);
    assert.deepEqual(JSON.parse(result.rawArtifacts['social-repair-selection']!), { method: 'social-screening-repair-v2', selectedAssessmentIds: ['assessment:integrity'], applied: true });
    validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);
    const facts = deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']).facts;
    assert.equal(facts.qualifiedOriginalCount, 0);
    assert.equal(facts.integrityReview?.verdict, 'CONTRADICTED');
    const tampered = structuredClone(result.proposal);
    tampered.identityAssessment!.rationale += ' tampered';
    assert.throws(() => validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, tampered, result.review), /SOCIAL_PROOF_INVALID/);
    const markerTamper = { ...result.rawArtifacts, 'social-repair-selection': JSON.stringify({ method: 'social-screening-repair-v1', selectedAssessmentIds: ['assessment:identity'], applied: true }) };
    assert.throws(() => validateSocialWire(markerTamper, socialInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);
  });
  await t.test('fresh review rejection retains unknown instead of retrying to a known result', async () => {
    const { socialInput, model, result } = await run({ accepted: false });
    assert.equal(model.calls.length, 4);
    assert.ok(result.proposal && result.review);
    assert.equal(result.review.decisions.find(row => row.id === 'assessment:integrity')?.accepted, false);
    assert.equal(deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, []).facts.integrityReview?.verdict, 'UNRESOLVED');
    validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);
  });
  for (const [name, options] of [['incomplete source inspection', { complete: false }], ['a current publication', { current: true }]] as const) await t.test(name, async () => {
    const { model, result } = await run(options);
    assert.equal(model.calls.length, 2);
    assert.equal(result.rawArtifacts['social-repair-selection'], undefined);
  });
});

test('source model distinguishes official identity scope and an empty dated current sample', async () => {
  const socialInput = input();
  socialInput.sources[0]!.publishedAt = '2026-10-02T23:59:00.000Z';
  socialInput.sources.push({ id: 'primary', kind: 'PAGE', url: 'https://project.example/about', text: `Official project account @alice, contract ${SOCIAL_TOKEN.address}`, publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE });
  socialInput.sources.push({ id: 'account', kind: 'PAGE', url: 'https://x.com/alice', text: `Official account @alice, contract ${SOCIAL_TOKEN.address}`, publishedAt: null, authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE });
  socialInput.identitySourceIds = ['primary', 'account'];
  socialInput.identityComplete = true;
  const mock = mockModel();
  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});
  assert.ok(result.proposal && result.review);
  for (const call of mock.calls) {
    const packet = call.packet as ModelPacket & { identityScopeInventory: unknown; currentWindowFacts: { currentTargetPostIds: string[]; undatedTargetPostIds: string[] } };
    assert.deepEqual(packet.identityScopeInventory, [{ accountId: 'x.com:alice', accountContractSourceIds: ['account'], independentPrimaryCandidateSourceIds: ['primary'] }]);
    assert.deepEqual(packet.currentWindowFacts.currentTargetPostIds, []);
    assert.deepEqual(packet.currentWindowFacts.undatedTargetPostIds, []);
  }
  assert.match(result.rawArtifacts['social-proposal-prompt']!, /Do not invent official claims for exchange listings or token commentators/);
  assert.match(result.rawArtifacts['social-review-prompt']!, /reject ANY rationale claiming metadata shortfalls across qualified current posts/);
});
