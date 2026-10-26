import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { geminiSettings } from '../src/providers/gemini.js';
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
type ModelPacket = { scope?: { entryDecisionMethod?: string }; rubric?: { entrySupport?: string }; sources: PacketSource[]; requiredPostIds: string[]; requiredDecisionIds?: string[]; outputContract?: string; invalidProposal?: unknown; proposal?: { posts: Array<{ sourceId: string; body: { sourceId: string; quote: string }; [key: string]: unknown }>; identities: Array<{ id: string; [key: string]: unknown }>; accounts: Array<{ accountId: string; [key: string]: unknown }>; identityAssessment?: { verdict: string; citations: Array<{ sourceId: string; quote: string }> }; integrityAssessment?: { verdict: string; citations: Array<{ sourceId: string; quote: string }> }; participationAssessment?: { verdict: string; citations: Array<{ sourceId: string; quote: string }> }; communityBreadthAssessment?: { verdict: string; citations: Array<{ sourceId: string; quote: string }> } }; pairs?: Array<{ id: string }> };
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

function quotaErrorBody(options: { quotaIds?: string[]; model?: string; retryDelay?: string | null; quotaValue?: string } = {}): string {
  const quotaFailureType = 'type.googleapis.com/google.rpc.QuotaFailure';
  const retryInfoType = 'type.googleapis.com/google.rpc.RetryInfo';
  const quotaIds = options.quotaIds ?? ['GenerateContentInputTokensPerModelPerMinute-FreeTier'];
  const details: Array<Record<string, unknown>> = [{
    '@type': quotaFailureType,
    violations: quotaIds.map(quotaId => ({
      quotaId, quotaValue: options.quotaValue ?? '250000',
      quotaDimensions: { model: options.model ?? geminiSettings.model },
    })),
  }];
  if (options.retryDelay !== null) details.push({ '@type': retryInfoType, retryDelay: options.retryDelay ?? '45s' });
  return JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details } });
}

function fullText(source: PacketSource): string {
  return [...source.spans].sort((left, right) => left.start - right.start).map(span => span.text).join('');
}

function proposalWire(packet: ModelPacket, citationMode: CitationMode = 'valid', bodyMode: BodyMode = 'complete', judgmentVerdict: 'CONTRADICTED' | 'UNRESOLVED' = 'UNRESOLVED', participationVerdict: 'CONTRADICTED' | 'UNRESOLVED' = 'UNRESOLVED') {
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
    ...(['public-support-v2', 'public-support-v3'].includes(packet.scope?.entryDecisionMethod ?? '') ? { participationAssessment: {
      verdict: participationVerdict,
      rationale: participationVerdict === 'CONTRADICTED'
        ? 'The completely inspected synthetic scope does not evidence independent participation origins and communities.'
        : 'The synthetic bounded scope does not establish a complete participation assessment.',
      citations: [assessmentCitation],
    } } : {}),
    ...(packet.scope?.entryDecisionMethod === 'public-support-v3' ? { communityBreadthAssessment: {
      verdict: 'UNRESOLVED',
      rationale: 'The synthetic one-post scope cannot establish three independently sourced communities.',
      citations: [assessmentCitation],
    } } : {}),
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
      ...(proposal.participationAssessment ? [{ id: 'assessment:participation', accepted: true, rationale: 'The synthetic participation rationale matches its cited public source.' }] : []),
      ...(proposal.communityBreadthAssessment ? [{ id: 'assessment:communityBreadth', accepted: true, rationale: 'The synthetic community breadth rationale matches its cited public source.' }] : []),
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

function keyedReviewWire(packet: ModelPacket, sourceComplete = true) {
  const review = reviewWire(packet, 'valid', sourceComplete);
  return { ...review, decisions: Object.fromEntries(review.decisions.map(({ id, ...decision }) => [id, decision])) };
}

function inputWithCopiedPosts(): SocialInput {
  const value = input();
  const original = value.sources[0]!;
  const second = { ...original, id: 'post-alice-2', url: 'https://x.com/alice/status/101', publishedAt: '2026-10-03T12:01:00.000Z' };
  value.sources.push(second);
  value.targetPostIds.push(second.id);
  return value;
}

function mockModel(options: { citationMode?: CitationMode; bodyMode?: BodyMode; pairMode?: PairMode; status?: number; sourceComplete?: boolean; judgmentVerdict?: 'CONTRADICTED' | 'UNRESOLVED'; participationVerdict?: 'CONTRADICTED' | 'UNRESOLVED'; responder?: (packet: ModelPacket, call: number) => unknown } = {}) {
  const calls: CapturedRequest[] = [];
  const responses: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = fromRequest(init);
    calls.push(request);
    if (options.status) return new Response('provider rejected request', { status: options.status });
    const value = options.responder?.(request.packet, calls.length) ?? (calls.length === 1
      ? proposalWire(request.packet, options.citationMode, options.bodyMode, options.judgmentVerdict, options.participationVerdict)
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
  assert.equal(createHash('sha256').update(result.rawArtifacts['social-proposal-prompt']!).digest('hex'),
    '304aceabff2a70df16ec19f1efce095fa6c5b42a8132c08d33c8be49d0108384',
    'merged source-scope inventory retains the exact checkpoint2 proposal prompt bytes');
  const mainLegacy=JSON.parse(result.rawArtifacts['social-proposal-prompt']!);
  delete mainLegacy.identityScopeInventory;delete mainLegacy.currentWindowFacts;
  mainLegacy.instruction=mainLegacy.instruction.replace('Do not invent official claims for exchange listings or token commentators. ','');
  assert.equal(createHash('sha256').update(JSON.stringify(mainLegacy)).digest('hex'),'d621cf8beb52d20aacf4645811138b95ba576e263133bd890d3ff920e32aba7f','the original main packet remains a separately pinned canonical variant');
  assert.match(proposalPacket.instruction, /Select supplied sourceId and spanId for citations; code supplies literal quotes/);
  assert.match(proposalPacket.instruction, /firstLineId and lastLineId covering the ENTIRE actual original body/);
  assert.match(proposalPacket.instruction, /Use null when boundaries cannot be established/);
});

test('selector repair is limited to a reproducible citation failure and receives one strict corrected proposal', async t => {
  const invalidProposal = (packet: ModelPacket) => {
    const proposal = proposalWire(packet) as ReturnType<typeof proposalWire>;
    const sourceId = packet.requiredPostIds[0]!;
    const mutablePost = proposal.posts[0]! as unknown as { metrics: { replies: unknown } };
    mutablePost.metrics.replies = {
      text: '1', citation: { sourceId, spanId: `${sourceId}:span:1` },
    };
    return proposal;
  };

  await t.test('valid correction gets the unchanged catalog and a fresh independent review', async () => {
    const mock = mockModel({ responder: (packet, call) => {
      if (call === 1) return invalidProposal(packet);
      if (call === 2) {
        assert.ok(packet.invalidProposal, 'repair packet identifies the locally rejected proposal');
        return proposalWire(packet);
      }
      return keyedReviewWire(packet);
    } });
    const socialInput = input(2);
    const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });

    assert.equal(mock.calls.length, 3, 'one invalid proposal, one full corrected proposal, then the ordinary independent review');
    assert.ok(result.proposal && result.review);
    assert.equal(result.code, undefined);
    assert.equal(result.proposal.posts[0]?.metrics.replies, null);
    assert.deepEqual(mock.calls[0]!.packet.sources, mock.calls[1]!.packet.sources);
    assert.deepEqual(mock.calls[0]!.packet.sources, mock.calls[2]!.packet.sources);
    assert.equal(fullText(mock.calls[1]!.packet.sources[0]!), socialInput.sources[0]!.text);
    assert.deepEqual(mock.calls[2]!.packet.proposal, result.proposal);

    const originalPrompt = JSON.parse(result.rawArtifacts['social-proposal-prompt']!) as Record<string, unknown>;
    const repairPrompt = JSON.parse(result.rawArtifacts['social-selector-repair-prompt']!) as Record<string, unknown>;
    const { instruction: _originalInstruction, ...originalContext } = originalPrompt;
    const { instruction: _repairInstruction, invalidProposal: repairTrigger, ...repairContext } = repairPrompt;
    assert.deepEqual(repairContext, originalContext, 'repair retains the exact original token, scope, inventory, timeline, and full catalog');
    assert.deepEqual(repairTrigger, mock.responses[0]);
    assert.match(String(repairPrompt.instruction), /identical complete catalog/);
    assert.ok(result.rawArtifacts['social-selector-repair-response']);
    assert.doesNotMatch(result.rawArtifacts['social-review-prompt']!, /invalidProposal/);
    validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);

    const forgedCatalog = { ...result.rawArtifacts };
    const forgedRepairPrompt = JSON.parse(forgedCatalog['social-selector-repair-prompt']!) as { sources: PacketSource[] };
    forgedRepairPrompt.sources[0]!.spans[0]!.text += ' forged';
    forgedCatalog['social-selector-repair-prompt'] = JSON.stringify(forgedRepairPrompt);
    assert.throws(() => validateSocialWire(forgedCatalog, socialInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);
  });

  await t.test('a second invalid selector remains unknown without a third request', async () => {
    const mock = mockModel({ responder: (packet, call) => call === 1
      ? invalidProposal(packet)
      : call === 2
        ? invalidProposal(packet)
        : reviewWire(packet) });
    const result = await qualifySocial(input(), SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });

    assert.equal(mock.calls.length, 2);
    assert.equal(result.proposal, null);
    assert.equal(result.review, null);
    assert.equal(result.code, 'SOC_CITATION_INVALID');
    assert.ok(result.rawArtifacts['social-proposal-response']);
    assert.ok(result.rawArtifacts['social-selector-repair-prompt']);
    assert.ok(result.rawArtifacts['social-selector-repair-response']);
    assert.equal(result.rawArtifacts['social-review-prompt'], undefined);
  });

  await t.test('a valid initial proposal or a non-citation validation error never enters selector repair', async () => {
    const valid = mockModel({ responder: (packet, call) => call === 1 ? proposalWire(packet) : keyedReviewWire(packet) });
    const validResult = await qualifySocial(input(), SOCIAL_TOKEN, KEY, valid.fetcher, async () => {}, undefined, { screeningRepair: true });
    assert.equal(valid.calls.length, 2);
    assert.ok(validResult.proposal && validResult.review);
    assert.equal(validResult.rawArtifacts['social-selector-repair-prompt'], undefined);

    const malformed = mockModel({ responder: packet => {
      const proposal = proposalWire(packet) as Record<string, unknown>;
      delete proposal.identityAssessment;
      return proposal;
    } });
    const malformedResult = await qualifySocial(input(), SOCIAL_TOKEN, KEY, malformed.fetcher, async () => {}, undefined, { screeningRepair: true });
    assert.equal(malformed.calls.length, 1);
    assert.equal(malformedResult.code, 'SOC_MODEL_INVALID');
    assert.equal(malformedResult.proposal, null);
    assert.equal(malformedResult.rawArtifacts['social-selector-repair-prompt'], undefined);
  });
});

test('fresh identity citation closure only carries an existing assessment edge into the binding record', async t => {
  const socialInput = input();
  socialInput.sources.push(
    {
      id: 'primary-binding', url: 'https://public.example/project',
      text: `The project account @alice represents token contract ${SOCIAL_TOKEN.address}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    },
    {
      id: 'profile-alice', url: 'https://x.com/alice',
      text: `Official public profile for @alice names token contract ${SOCIAL_TOKEN.address}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    },
    {
      id: 'primary-bob', url: 'https://public.example/other-project',
      text: `The project account @bob represents token contract ${SOCIAL_TOKEN.address}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    },
    {
      id: 'alice-without-contract', url: 'https://public.example/account-reference',
      text: 'The project account @alice is mentioned here without a token contract address.',
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    },
  );
  socialInput.identitySourceIds = ['profile-alice'];
  socialInput.identityComplete = true;

  const sourceCitation = (packet: ModelPacket, sourceId: string, matches: (text: string) => boolean) => {
    const source = packet.sources.find(row => row.id === sourceId);
    assert.ok(source, `the packet supplies ${sourceId}`);
    const span = source.spans.find(candidate => matches(candidate.text));
    assert.ok(span, `${sourceId} supplies the required literal citation span`);
    return { sourceId, spanId: span.id };
  };
  const bindingProposal = (packet: ModelPacket, primarySourceId: string) => {
    const profile = sourceCitation(packet, 'profile-alice', text => text.includes(SOCIAL_TOKEN.address) && text.includes('@alice'));
    const primary = sourceCitation(packet, primarySourceId, text => text.includes('@') && text.includes(SOCIAL_TOKEN.address));
    return {
      ...proposalWire(packet),
      identityAssessment: {
        verdict: 'SUPPORTED',
        rationale: 'A distinct primary project page and the public account profile both state this exact token binding.',
        citations: [primary],
      },
      identities: [{
        id: 'identity:x.com:alice', accountId: 'x.com:alice', status: 'PUBLIC_BINDING_SUPPORTED', citations: [primary],
      }],
    };
  };

  const mock = mockModel({ responder: (packet, call) => call === 1
    ? bindingProposal(packet, 'primary-binding')
    : keyedReviewWire(packet) });
  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });

  assert.equal(mock.calls.length, 2);
  assert.ok(result.proposal && result.review);
  assert.deepEqual(result.proposal.identities[0]?.citations, [
    { sourceId: 'primary-binding', quote: socialInput.sources.find(source => source.id === 'primary-binding')!.text },
    { sourceId: 'profile-alice', quote: socialInput.sources.find(source => source.id === 'profile-alice')!.text },
  ]);
  assert.deepEqual(result.proposal.identityAssessment?.citations, [
    { sourceId: 'primary-binding', quote: socialInput.sources.find(source => source.id === 'primary-binding')!.text },
    { sourceId: 'profile-alice', quote: socialInput.sources.find(source => source.id === 'profile-alice')!.text },
  ]);
  assert.deepEqual(mock.calls[1]!.packet.proposal?.identities[0]?.citations, result.proposal.identities[0]?.citations,
    'the independent reviewer receives the existing account-page citation added to both supported edges');
  assert.deepEqual(mock.calls[1]!.packet.proposal?.identities[0], result.proposal.identities[0],
    'the independently reviewed proposal contains the mechanically closed primary and account edges');
  assert.equal(result.review.decisions.find(row => row.id === 'assessment:identity')?.accepted, true);
  assert.equal(deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-test']).facts.identityReview?.verdict, 'SUPPORTED');
  const receipt = JSON.parse(result.rawArtifacts['social-qualified-receipt']!) as { identityCitationMethod?: string };
  assert.equal(receipt.identityCitationMethod, 'identity-citation-closure-v3');
  validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);

  const originalWire = mock.responses[0];
  const onlyAssessmentCitations = (sourceIds: string[]) => {
    const value = structuredClone(originalWire) as ReturnType<typeof bindingProposal>;
    const packet = mock.calls[0]!.packet;
    value.identityAssessment.citations = sourceIds.map(sourceId => sourceCitation(packet, sourceId, text => text.length > 0));
    return normalizeSocialProposal(value, socialInput, SOCIAL_TOKEN, true).proposal.identities[0]!.citations;
  };
  await t.test('account-only assessment cannot add an independent primary edge', () => {
    assert.deepEqual(onlyAssessmentCitations(['profile-alice']), result.proposal!.identities[0]!.citations.slice(0, 1));
  });
  await t.test('a page for another account cannot close Alice’s binding', () => {
    assert.deepEqual(onlyAssessmentCitations(['primary-bob', 'profile-alice']), result.proposal!.identities[0]!.citations.slice(0, 1));
  });
  await t.test('a page without the literal token address cannot close the binding', () => {
    assert.deepEqual(onlyAssessmentCitations(['alice-without-contract', 'profile-alice']), result.proposal!.identities[0]!.citations.slice(0, 1));
  });

  await t.test('own-account closure appends only the existing matching account publication with literal CA and account name', () => {
    const raw = structuredClone(originalWire) as ReturnType<typeof bindingProposal>;
    const normalized = normalizeSocialProposal(raw, socialInput, SOCIAL_TOKEN, true, true).proposal;
    assert.deepEqual(normalized.identities[0]?.citations, result.proposal!.identities[0]!.citations);
    assert.deepEqual(normalized.identityAssessment?.citations, result.proposal!.identityAssessment?.citations);
    assert.equal(raw.identities[0]?.citations.some(ref => ref.sourceId === 'profile-alice'), false,
      'the account-page edge was selected from the retained catalog rather than supplied in the original proposal');
  });

  await t.test('a different account URL or a page without the literal CA cannot supply the own-account edge', () => {
    const raw = structuredClone(originalWire) as ReturnType<typeof bindingProposal>;
    const wrongAccount = structuredClone(socialInput);
    wrongAccount.sources.find(source => source.id === 'profile-alice')!.url = 'https://x.com/bob';
    const wrongAccountResult = normalizeSocialProposal(raw, wrongAccount, SOCIAL_TOKEN, true, true).proposal;
    assert.deepEqual(wrongAccountResult.identities[0]?.citations, [
      { sourceId: 'primary-binding', quote: socialInput.sources.find(source => source.id === 'primary-binding')!.text },
    ]);

    const missingAddress = structuredClone(socialInput);
    missingAddress.sources.find(source => source.id === 'profile-alice')!.text = 'Official public profile for @alice with no token address.';
    const missingAddressResult = normalizeSocialProposal(raw, missingAddress, SOCIAL_TOKEN, true, true).proposal;
    assert.deepEqual(missingAddressResult.identities[0]?.citations, [
      { sourceId: 'primary-binding', quote: socialInput.sources.find(source => source.id === 'primary-binding')!.text },
    ]);
  });

  await t.test('a reviewer rejection keeps the identity judgment unresolved', async () => {
    const rejected = mockModel({ responder: (packet, call) => {
      if (call === 1) return bindingProposal(packet, 'primary-binding');
      const review = keyedReviewWire(packet) as { decisions: Record<string, { accepted: boolean; rationale: string }> };
      review.decisions['assessment:identity']!.accepted = false;
      return review;
    } });
    const rejectedResult = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, rejected.fetcher, async () => {}, undefined, { screeningRepair: true });
    assert.ok(rejectedResult.proposal && rejectedResult.review);
    const reviewedIdentity = rejected.calls[1]!.packet.proposal?.identities[0] as { citations?: Array<{ sourceId: string }> } | undefined;
    assert.ok(reviewedIdentity?.citations?.some(citation => citation.sourceId === 'profile-alice'));
    assert.equal(deriveSocial(rejectedResult.read, rejectedResult.proposal, rejectedResult.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-test']).facts.identityReview?.verdict, 'UNRESOLVED');
    validateSocialWire(rejectedResult.rawArtifacts, socialInput, SOCIAL_TOKEN, rejectedResult.proposal, rejectedResult.review);
  });

  await t.test('v1 reconstruction keeps its prior assessment-only behavior; a rehashed v2-to-v1 downgrade cannot retain the v2 result', () => {
    const v1Proposal = normalizeSocialProposal(structuredClone(originalWire), socialInput, SOCIAL_TOKEN, true, false).proposal;
    assert.deepEqual(v1Proposal.identities[0]?.citations, [
      { sourceId: 'primary-binding', quote: socialInput.sources.find(source => source.id === 'primary-binding')!.text },
    ]);

    const legacyRaw = { ...result.rawArtifacts };
    const legacyReceipt = JSON.parse(legacyRaw['social-qualified-receipt']!) as { identityCitationMethod?: string; proposal?: unknown };
    legacyReceipt.identityCitationMethod = 'assessment-citation-closure-v1';
    legacyReceipt.proposal = v1Proposal;
    legacyRaw['social-qualified-receipt'] = JSON.stringify(legacyReceipt);
    validateSocialWire(legacyRaw, socialInput, SOCIAL_TOKEN, v1Proposal, result.review);

    const downgradedRaw = { ...result.rawArtifacts };
    const downgradedReceipt = JSON.parse(downgradedRaw['social-qualified-receipt']!) as { identityCitationMethod?: string };
    downgradedReceipt.identityCitationMethod = 'assessment-citation-closure-v1';
    downgradedRaw['social-qualified-receipt'] = JSON.stringify(downgradedReceipt);
    assert.throws(() => validateSocialWire(downgradedRaw, socialInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);
  });

  await t.test('marker and local citation tampering fail proof reconstruction', () => {
    const forgedMarker = { ...result.rawArtifacts };
    const rawReceipt = JSON.parse(forgedMarker['social-qualified-receipt']!) as Record<string, unknown>;
    rawReceipt.identityCitationMethod = 'forged-closure';
    forgedMarker['social-qualified-receipt'] = JSON.stringify(rawReceipt);
    assert.throws(() => validateSocialWire(forgedMarker, socialInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);

    const withoutClosedEdge = structuredClone(result.proposal!);
    withoutClosedEdge.identities[0]!.citations = withoutClosedEdge.identities[0]!.citations.slice(0, 1);
    assert.throws(() => validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, withoutClosedEdge, result.review), /SOCIAL_PROOF_INVALID/);
  });
});

test('fresh post-body identity closure requires the matching complete author post and keeps independent review authoritative', async t => {
  const makeInput = (primaryBinding: boolean): SocialInput => {
    const value = input();
    value.entryDecisionMethod = 'public-support-v2';
    value.reviewCriterionMethod = 'verdict-aware-v4';
    value.sources.push({
      id: 'primary-binding', url: 'https://public.example/project',
      text: primaryBinding
        ? `The project account @alice represents token contract ${SOCIAL_TOKEN.address}.`
        : `The market dashboard lists token contract ${SOCIAL_TOKEN.address}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    });
    value.identitySourceIds = ['primary-binding'];
    value.identityComplete = true;
    return value;
  };
  const citation = (packet: ModelPacket, sourceId: string, includes: string) => {
    const source = packet.sources.find(row => row.id === sourceId);
    assert.ok(source, `packet includes ${sourceId}`);
    const span = source.spans.find(candidate => candidate.text.includes(includes));
    assert.ok(span, `${sourceId} has a literal span containing ${includes}`);
    return { sourceId, spanId: span.id };
  };
  const proposal = (packet: ModelPacket) => {
    const primary = citation(packet, 'primary-binding', SOCIAL_TOKEN.address);
    const post = citation(packet, packet.requiredPostIds[0]!, SOCIAL_TOKEN.address);
    const raw = proposalWire(packet);
    return {
      ...raw,
      identityAssessment: {
        verdict: 'SUPPORTED', rationale: 'A distinct project page and the matching public account publication identify this exact contract.', citations: [primary],
      },
      integrityAssessment: {
        verdict: 'CONTRADICTED', rationale: 'The complete bounded sample does not establish current attributable activity and provenance.', citations: [post],
      },
      participationAssessment: {
        verdict: 'CONTRADICTED', rationale: 'The complete bounded sample does not establish the required independent account and community counts.', citations: [post],
      },
      identities: [{ id: 'identity:x.com:alice', accountId: 'x.com:alice', status: 'PUBLIC_BINDING_SUPPORTED', citations: [primary] }],
    };
  };
  const ownInput = makeInput(true);
  const mock = mockModel({ responder: (packet, call) => call === 1 ? proposal(packet) : keyedReviewWire(packet) });
  const result = await qualifySocial(ownInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });

  assert.equal(result.code, undefined, JSON.stringify(result.rawArtifacts['social-validation-error']));
  assert.ok(result.proposal && result.review);
  const ownCitation = result.proposal.identities[0]!.citations.find(ref => ref.sourceId === 'post-alice-1');
  assert.ok(ownCitation, 'the exact complete post body is added as the account-authored edge');
  assert.ok(ownCitation.quote.includes(SOCIAL_TOKEN.address));
  assert.ok(result.proposal.identityAssessment?.citations.some(ref => ref.sourceId === 'post-alice-1' && ref.quote === ownCitation.quote));
  const reviewedIdentity = mock.calls[1]!.packet.proposal?.identities[0] as { citations?: Array<{ sourceId: string; quote: string }> } | undefined;
  assert.ok(reviewedIdentity?.citations?.some(ref => ref.sourceId === 'post-alice-1' && ref.quote === ownCitation.quote),
    'the independent reviewer receives the same mechanically closed post citation');
  assert.equal(result.review.decisions.find(row => row.id === 'assessment:identity')?.accepted, true);
  const receipt = JSON.parse(result.rawArtifacts['social-qualified-receipt']!) as { identityCitationMethod?: string };
  assert.equal(receipt.identityCitationMethod, 'identity-citation-closure-v3');
  validateSocialWire(result.rawArtifacts, ownInput, SOCIAL_TOKEN, result.proposal, result.review);
  const withoutPostEdge = structuredClone(result.proposal);
  withoutPostEdge.identities[0]!.citations = withoutPostEdge.identities[0]!.citations.filter(ref => ref.sourceId !== 'post-alice-1');
  withoutPostEdge.identityAssessment!.citations = withoutPostEdge.identityAssessment!.citations.filter(ref => ref.sourceId !== 'post-alice-1');
  assert.throws(() => validateSocialWire(result.rawArtifacts, ownInput, SOCIAL_TOKEN, withoutPostEdge, result.review), /SOCIAL_PROOF_INVALID/,
    'admission reconstructs the post edge from the retained exact body rather than trusting the supplied normalized proposal');

  const rawWire = mock.responses[0];
  assert.ok(rawWire);
  const wrongAuthor = structuredClone(ownInput);
  wrongAuthor.sources[0]!.url = 'https://x.com/bob/status/100';
  wrongAuthor.sources[0]!.authorId = 'x.com:bob';
  const wrongAuthorProposal = normalizeSocialProposal(rawWire, wrongAuthor, SOCIAL_TOKEN, true, true, true).proposal;
  assert.equal(wrongAuthorProposal.identities[0]!.citations.some(ref => ref.sourceId === 'post-alice-1'), false,
    'an exact-contract post published by a different account cannot close Alice’s identity edge');

  const missingBodyWire = structuredClone(rawWire) as { posts: Array<{ body: unknown }> };
  missingBodyWire.posts[0]!.body = null;
  const missingBodyProposal = normalizeSocialProposal(missingBodyWire, ownInput, SOCIAL_TOKEN, true, true, true).proposal;
  assert.equal(missingBodyProposal.identities[0]!.citations.some(ref => ref.sourceId === 'post-alice-1'), false,
    'a post without a complete body selection cannot close the identity edge');

  const unsupportedPrimaryInput = makeInput(false);
  const unsupportedPrimary = mockModel({ responder: (packet, call) => call === 1 ? proposal(packet) : keyedReviewWire(packet) });
  const unsupportedPrimaryResult = await qualifySocial(unsupportedPrimaryInput, SOCIAL_TOKEN, KEY, unsupportedPrimary.fetcher, async () => {}, undefined, { screeningRepair: true });
  assert.ok(unsupportedPrimaryResult.proposal && unsupportedPrimaryResult.review);
  assert.ok(unsupportedPrimaryResult.proposal.identities[0]!.citations.some(ref => ref.sourceId === 'post-alice-1'),
    'own-post citation can be retained without promoting it to an independent primary page');
  const noPrimary = deriveSocial(unsupportedPrimaryResult.read, unsupportedPrimaryResult.proposal, unsupportedPrimaryResult.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-test']);
  assert.notEqual(noPrimary.facts.identityReview?.verdict, 'SUPPORTED',
    'the mechanically added own post cannot replace the distinct independent primary binding');

  const rejected = mockModel({ responder: (packet, call) => {
    if (call === 1) return proposal(packet);
    const review = keyedReviewWire(packet) as { decisions: Record<string, { accepted: boolean; rationale: string }> };
    review.decisions['assessment:identity']!.accepted = false;
    return review;
  } });
  const rejectedResult = await qualifySocial(ownInput, SOCIAL_TOKEN, KEY, rejected.fetcher, async () => {}, undefined, { screeningRepair: true });
  assert.ok(rejectedResult.proposal && rejectedResult.review);
  const rejectedIdentity = rejected.calls[1]!.packet.proposal?.identities[0] as { citations?: Array<{ sourceId: string }> } | undefined;
  assert.ok(rejectedIdentity?.citations?.some(ref => ref.sourceId === 'post-alice-1'));
  assert.equal(deriveSocial(rejectedResult.read, rejectedResult.proposal, rejectedResult.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-test']).facts.identityReview?.verdict, 'UNRESOLVED',
    'independent reviewer rejection prevents a supported identity result');
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
    assert.deepEqual(selection, { method: 'social-screening-repair-v2', selectedAssessmentIds: ['assessment:identity'], applied: true });
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
      method: 'social-screening-repair-v2', selectedAssessmentIds: ['assessment:identity'], applied: false, code: 'SOC_REPAIR_REJECTED',
    });
    validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);
  });
});

test('screening repair can correct a rejected historical integrity rationale once while preserving copy relations', async () => {
  const socialInput = inputWithCopiedPosts();
  socialInput.sources.filter(source => source.kind === 'POST').forEach((source, index) => {
    source.publishedAt = `2026-10-02T12:0${index}:00.000Z`;
  });
  const before = structuredClone(socialInput.sources);
  const pairId = 'copy:post-alice-1:post-alice-2';
  const mock = mockModel({ responder: (packet, call) => {
    if (call === 1) {
      const initial = proposalWire(packet);
      return { ...initial, integrityAssessment: {
        verdict: 'SUPPORTED', rationale: 'These historical posts establish current integrity and active visibility.',
        citations: initial.integrityAssessment.citations,
      } };
    }
    if (call === 2) {
      const initialReview = keyedReviewWire(packet) as { decisions: Record<string, { accepted: boolean; rationale: string }>; pairs: Record<string, { relation: string; rationale: string }> };
      const rejected = initialReview.decisions['assessment:integrity'];
      assert.ok(rejected);
      rejected.accepted = false;
      rejected.rationale = 'The cited posts predate the current sample and cannot establish current visibility.';
      initialReview.pairs[pairId] = { relation: 'COPIED_ENDORSEMENT', rationale: 'The identical historical publications are copied endorsements.' };
      return initialReview;
    }
    if (call === 3) {
      assert.deepEqual((packet as ModelPacket & { selectedAssessmentIds?: string[] }).selectedAssessmentIds, ['assessment:integrity'], 'only the temporally invalid integrity judgment is selected');
      const initialReview = (packet as ModelPacket & { initialReview?: { pairs?: Array<{ id: string; relation: string }> } }).initialReview;
      assert.deepEqual(initialReview?.pairs?.map(pair => [pair.id, pair.relation]), [[pairId, 'COPIED_ENDORSEMENT']],
        'repair receives the initial full review and the same copy-pair relationship');
      const post = packet.sources.find(source => source.id === 'post-alice-1')!;
      const span = post.spans.find(candidate => candidate.text.includes(SOCIAL_TOKEN.address))!;
      return { integrityAssessment: {
        verdict: 'CONTRADICTED',
        rationale: 'Every publication in the complete sample predates the window, so this bounded sample lacks current public verifiability.',
        citations: [{ sourceId: post.id, spanId: span.id }],
      } };
    }
    if (call === 4) {
      const repairedReview = keyedReviewWire({ ...packet, pairs: [{ id: pairId }] }) as { pairs: Record<string, { relation: string; rationale: string }> };
      repairedReview.pairs[pairId] = { relation: 'COPIED_ENDORSEMENT', rationale: 'The same two source bodies remain copied endorsements.' };
      return repairedReview;
    }
    throw new Error(`UNEXPECTED_HISTORICAL_SCREENING_REPAIR_CALL_${call}`);
  } });
  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });

  assert.equal(mock.calls.length, 4, `the historical integrity correction uses one proposal/review pair: ${JSON.stringify({
    code: result.code, selection: result.rawArtifacts['social-repair-selection'], pairs: result.review?.pairs,
    integrity: result.proposal?.integrityAssessment,
  })}`);
  assert.ok(result.proposal && result.review);
  assert.deepEqual(result.submittedSources, before, 'the original post dates and source text remain unchanged');
  assert.deepEqual(result.proposal.posts.map(post => post.sourceId), ['post-alice-1', 'post-alice-2']);
  assert.equal(result.proposal.identityAssessment?.verdict, 'UNRESOLVED', 'the unselected identity judgment is frozen');
  assert.equal(result.proposal.integrityAssessment?.verdict, 'CONTRADICTED');
  assert.equal(result.review.decisions.find(decision => decision.id === 'assessment:integrity')?.accepted, true,
    'the corrected historical-only explanation receives a new accepted full review');
  const selection = JSON.parse(result.rawArtifacts['social-repair-selection']!) as { method: string; selectedAssessmentIds: string[]; applied: boolean };
  assert.deepEqual(selection, { method: 'social-screening-repair-v2', selectedAssessmentIds: ['assessment:integrity'], applied: true });
  const initialReview = JSON.parse(result.rawArtifacts['social-review-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const initialWire = JSON.parse(initialReview.candidates[0]!.content.parts[0]!.text) as {
    decisions: Record<string, { accepted: boolean }>; pairs: Record<string, { relation: string }>;
  };
  const finalReview = JSON.parse(result.rawArtifacts['social-repair-review-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const finalWire = JSON.parse(finalReview.candidates[0]!.content.parts[0]!.text) as { pairs: Record<string, { relation: string }> };
  assert.equal(initialWire.decisions['assessment:integrity']?.accepted, false, 'the original rejection remains retained');
  assert.equal(initialWire.pairs[pairId]?.relation, 'COPIED_ENDORSEMENT');
  assert.equal(finalWire.pairs[pairId]?.relation, initialWire.pairs[pairId]?.relation,
    'the repaired review cannot change an already-reviewed copy relation');
  const derived = deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence']);
  assert.equal(derived.facts.integrityReview?.verdict, 'CONTRADICTED', 'the reviewed correction supports only the bounded current-window shortfall');

  validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);
  const tampered = { ...result.rawArtifacts };
  const tamperedEnvelope = JSON.parse(tampered['social-repair-review-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const changedWire = JSON.parse(tamperedEnvelope.candidates[0]!.content.parts[0]!.text) as { pairs: Record<string, { relation: string; rationale: string }> };
  changedWire.pairs[pairId] = { relation: 'DISTINCT_COMMENTARY', rationale: 'A changed pair judgment must not enter through screening repair.' };
  tamperedEnvelope.candidates[0]!.content.parts[0]!.text = JSON.stringify(changedWire);
  tampered['social-repair-review-response'] = JSON.stringify(tamperedEnvelope);
  assert.throws(() => validateSocialWire(tampered, socialInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/,
    'offline proof rejects a changed nonselected pair relationship');
});

test('frozen positive guards repair only fully inspected impossible positives and require an accepted cited negative', async t => {
  const frozenRead = (complete = true) => {
    const read = input();
    read.screeningConstraintMethod = 'frozen-positive-guards-v1';
    read.reviewCriterionMethod = 'verdict-aware-v4';
    read.entryDecisionMethod = 'public-support-v3';
    read.sources[0]!.publishedAt = '2026-10-02T12:00:00.000Z';
    read.sampleComplete = complete;
    if (!complete) read.codes = ['SOC_FETCH_TIMEOUT'];
    return read;
  };
  const citationFor = (packet: ModelPacket): WireCitation => {
    const source = packet.sources.find(row => row.id === packet.requiredPostIds[0]);
    assert.ok(source);
    const span = source.spans.find(row => row.text.includes(SOCIAL_TOKEN.address));
    assert.ok(span);
    return { sourceId: source.id, spanId: span.id };
  };
  const impossiblePositive = (packet: ModelPacket) => {
    const proposal = proposalWire(packet, 'valid', 'complete') as ReturnType<typeof proposalWire>;
    const citation = citationFor(packet);
    (proposal as any).integrityAssessment = {
      verdict: 'SUPPORTED', rationale: 'The fully inspected historical post proves current integrity and complete source lineage.', citations: [citation],
    };
    (proposal as any).participationAssessment = {
      verdict: 'CONTRADICTED', rationale: 'The complete retained scope does not establish independent public participation.', citations: [citation],
    };
    (proposal as any).communityBreadthAssessment = {
      verdict: 'CONTRADICTED', rationale: 'The complete retained scope does not establish independent public communities.', citations: [citation],
    };
    return proposal;
  };
  const groundedNegative = (packet: ModelPacket) => ({ integrityAssessment: {
    verdict: 'CONTRADICTED',
    rationale: 'The fully inspected source does not establish the origin or public community needed to qualify current integrity; this is an evidence shortfall, not a fraud finding.',
    citations: [citationFor(packet)],
  } });

  await t.test('an impossible positive is constrained to a reviewed negative on complete evidence', async () => {
    const read = frozenRead();
    const model = mockModel({ responder: (packet, call) => {
      if (call === 1) return impossiblePositive(packet);
      if (call === 2) {
        const initialReview = keyedReviewWire(packet) as { decisions: Record<string, { accepted: boolean }> };
        assert.equal(initialReview.decisions['assessment:integrity']?.accepted, true,
          'the guard is independently derived even when the initial reviewer accepts the impossible positive');
        return initialReview;
      }
      if (call === 3) {
        const repair = packet as ModelPacket & { frozenPositiveGuards?: { assessmentIds?: string[] }; initialReview?: { decisions?: Array<{ id: string; accepted: boolean }> } };
        assert.deepEqual(repair.frozenPositiveGuards?.assessmentIds, ['assessment:integrity']);
        assert.equal(repair.initialReview?.decisions?.find(row => row.id === 'assessment:integrity')?.accepted, true);
        return groundedNegative(packet);
      }
      assert.equal(call, 4);
      assert.equal((packet as ModelPacket & { repair?: boolean }).repair, true);
      return keyedReviewWire(packet);
    } });
    const result = await qualifySocial(read, SOCIAL_TOKEN, KEY, model.fetcher, async () => {}, undefined, { screeningRepair: true });

    assert.equal(model.calls.length, 4);
    const repairSchema = (model.calls[2]!.payload.generationConfig as { responseJsonSchema: { properties: { integrityAssessment: { properties: { verdict: { enum: string[] } } } } } }).responseJsonSchema;
    assert.deepEqual(repairSchema.properties.integrityAssessment.properties.verdict.enum, ['CONTRADICTED'],
      'the existing repair schema cannot repeat a positive that fails the frozen guard');
    assert.equal(result.code, undefined);
    assert.equal(result.proposal?.integrityAssessment?.verdict, 'CONTRADICTED');
    assert.equal(result.review?.decisions.find(row => row.id === 'assessment:integrity')?.accepted, true,
      'the negative is admitted only after independent review');
    const derived = deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-frozen-guard-test']);
    assert.equal(derived.facts.integrityReview?.verdict, 'CONTRADICTED');
    const history = derived.assessments.find(row => row.id === 'S05')!;
    assert.equal(history.quality, 'MISSING', 'a negative current-source assessment does not fill in unavailable account history');
    assert.deepEqual((history.data as { indicators: unknown[] }).indicators, []);
    const selection = JSON.parse(result.rawArtifacts['social-repair-selection']!) as { method: string; selectedAssessmentIds: string[]; applied: boolean };
    assert.deepEqual(selection, { method: 'social-screening-repair-v4', selectedAssessmentIds: ['assessment:integrity'], applied: true });
    validateSocialWire(result.rawArtifacts, read, SOCIAL_TOKEN, result.proposal, result.review);
  });

  await t.test('a rejected negative repair stays unresolved instead of becoming a silent FAIL', async () => {
    const read = frozenRead();
    const model = mockModel({ responder: (packet, call) => {
      if (call === 1) return impossiblePositive(packet);
      if (call === 2) return keyedReviewWire(packet);
      if (call === 3) return groundedNegative(packet);
      const review = keyedReviewWire(packet) as { decisions: Record<string, { accepted: boolean; rationale: string }> };
      review.decisions['assessment:integrity']!.accepted = false;
      review.decisions['assessment:integrity']!.rationale = 'The source review does not support this negative evidence judgment.';
      return review;
    } });
    const result = await qualifySocial(read, SOCIAL_TOKEN, KEY, model.fetcher, async () => {}, undefined, { screeningRepair: true });

    assert.equal(model.calls.length, 4);
    assert.equal(result.code, undefined, 'a rejected optional repair does not turn a qualified initial assessment into a transport error');
    const selection = JSON.parse(result.rawArtifacts['social-repair-selection']!) as { applied: boolean; code?: string };
    assert.equal(selection.applied, false);
    assert.equal(selection.code, 'SOC_REPAIR_REJECTED');
    assert.equal(result.proposal?.integrityAssessment?.verdict, 'SUPPORTED', 'the rejected repair cannot replace the retained proposal');
    assert.equal(deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-frozen-guard-test']).facts.integrityReview?.verdict,
      'UNRESOLVED', 'the original positive still fails its local support guard and does not become a negative finding');
    validateSocialWire(result.rawArtifacts, read, SOCIAL_TOKEN, result.proposal, result.review);
  });

  await t.test('an incomplete acquisition does not activate the frozen negative repair', async () => {
    const read = frozenRead(false);
    const model = mockModel({ responder: (packet, call) => call === 1 ? impossiblePositive(packet) : keyedReviewWire(packet) });
    const result = await qualifySocial(read, SOCIAL_TOKEN, KEY, model.fetcher, async () => {}, undefined, { screeningRepair: true });

    assert.equal(model.calls.length, 2);
    assert.equal(result.rawArtifacts['social-repair-selection'], undefined);
    assert.equal(result.rawArtifacts['social-repair-proposal-prompt'], undefined);
    assert.equal(result.proposal?.integrityAssessment?.verdict, 'SUPPORTED');
    assert.equal(deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-frozen-guard-test']).facts.integrityReview?.verdict,
      'UNRESOLVED', 'an acquisition timeout leaves the evidence judgment unresolved');
    validateSocialWire(result.rawArtifacts, read, SOCIAL_TOKEN, result.proposal, result.review);
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

test('fresh literal association evidence gets one selector repair and keeps unsupported community facts null', async t => {
  const invalidKey = 'https://t.me/MayaSamoyed_portal';
  const makeInput = (marked: boolean, text = `${SOCIAL_TOKEN.address} Alice describes the project and leaves only the truncated Telegram reference t.me/MayaSamoyed\\_po… for the community.`) => {
    const value = input(0, text);
    value.entryDecisionMethod = 'public-support-v3';
    value.reviewCriterionMethod = 'verdict-aware-v4';
    value.identityComplete = true;
    if (marked) value.associationCitationMethod = 'literal-associations-v1';
    return value;
  };
  const citationFor = (packet: ModelPacket) => {
    const post = packet.sources.find(source => source.id === packet.requiredPostIds[0]);
    assert.ok(post);
    const span = post.spans.find(candidate => candidate.text.includes(SOCIAL_TOKEN.address));
    assert.ok(span);
    return { sourceId: post.id, spanId: span.id };
  };
  const negativeProposal = (packet: ModelPacket): any => {
    const proposal = proposalWire(packet, 'valid', 'complete', 'CONTRADICTED', 'CONTRADICTED') as any;
    const citation = citationFor(packet);
    proposal.identityAssessment = { verdict: 'CONTRADICTED', rationale: 'The complete public identity scope contains no independent account binding.', citations: [citation] };
    proposal.integrityAssessment = { verdict: 'CONTRADICTED', rationale: 'The inspected post does not establish independently supported project lineage.', citations: [citation] };
    proposal.participationAssessment = { verdict: 'CONTRADICTED', rationale: 'The complete sample does not establish independent participant origins and communities.', citations: [citation] };
    proposal.communityBreadthAssessment = { verdict: 'CONTRADICTED', rationale: 'The complete sample does not establish independently identified public communities.', citations: [citation] };
    return proposal;
  };
  const invalidProposal = (packet: ModelPacket) => {
    const proposal = negativeProposal(packet);
    proposal.posts[0]!.community = { key: invalidKey, citation: citationFor(packet) };
    return proposal;
  };
  const complete = makeInput(true);
  const repairedModel = mockModel({ responder: (packet, call) => {
    if (call === 1) return invalidProposal(packet);
    if (call === 2) {
      assert.ok(packet.invalidProposal, 'the repair is tied to the initial unsupported association key');
      assert.equal((packet.invalidProposal as any).posts[0]?.community?.key, invalidKey);
      return negativeProposal(packet);
    }
    assert.equal(call, 3, 'the corrected proposal gets one ordinary independent full review');
    assert.equal(packet.proposal?.posts[0]?.community, null, 'the reviewer sees the corrected full proposal with no unsupported community');
    assert.equal(packet.proposal?.communityBreadthAssessment?.verdict, 'CONTRADICTED');
    return keyedReviewWire(packet);
  } });
  const repaired = await qualifySocial(complete, SOCIAL_TOKEN, KEY, repairedModel.fetcher, async () => {}, undefined, { screeningRepair: true });

  assert.equal(repaired.code, undefined);
  assert.equal(repairedModel.calls.length, 3, 'one proposal, one bounded selector repair, and one independent review');
  assert.ok(repaired.proposal && repaired.review);
  assert.equal(repaired.proposal.posts[0]?.community, null);
  assert.equal(repaired.proposal.posts[0]?.origin, null);
  assert.equal(repaired.proposal.posts[0]?.campaign, null);
  assert.equal(repaired.proposal.communityBreadthAssessment?.verdict, 'CONTRADICTED');
  assert.equal(repaired.review.decisions.find(row => row.id === 'assessment:communityBreadth')?.accepted, true);
  assert.ok(repaired.review.sources.every(source => source.complete));
  assert.equal(repaired.rawArtifacts['social-selector-repair-response'] !== undefined, true);
  assert.equal(repaired.rawArtifacts['social-repair-proposal-prompt'], undefined, 'the accepted adverse judgments do not trigger a separate screening repair');
  const facts = deriveSocial(repaired.read, repaired.proposal, repaired.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-association-test']).facts;
  assert.equal(facts.identityReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.integrityReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.participationReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.communityBreadthReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.independentCommunityCount, null, 'no community is inferred from the truncated reference');
  validateSocialWire(repaired.rawArtifacts, complete, SOCIAL_TOKEN, repaired.proposal, repaired.review);

  await t.test('a second invalid association stays unqualified without a review call', async () => {
    const failedModel = mockModel({ responder: (packet, call) => call === 1 || call === 2 ? invalidProposal(packet) : keyedReviewWire(packet) });
    const failed = await qualifySocial(complete, SOCIAL_TOKEN, KEY, failedModel.fetcher, async () => {}, undefined, { screeningRepair: true });
    assert.equal(failedModel.calls.length, 2);
    assert.equal(failed.proposal, null);
    assert.equal(failed.review, null);
    assert.equal(failed.code, 'SOC_CITATION_INVALID');
    assert.equal(failed.rawArtifacts['social-review-prompt'], undefined);
  });

  await t.test('a valid new-mode association and an unmarked legacy proposal each use no repair call', async () => {
    const validInput = makeInput(true, `${SOCIAL_TOKEN.address} Alice points to the public group https://t.me/synthetic-community.`);
    const validModel = mockModel({ responder: (packet, call) => {
      if (call !== 1) return keyedReviewWire(packet);
      const proposal = negativeProposal(packet);
      proposal.posts[0]!.community = { key: 'https://t.me/synthetic-community', citation: citationFor(packet) };
      return proposal;
    } });
    const valid = await qualifySocial(validInput, SOCIAL_TOKEN, KEY, validModel.fetcher, async () => {}, undefined, { screeningRepair: true });
    assert.equal(valid.code, undefined, JSON.stringify(valid.rawArtifacts['social-validation-error'] ?? valid.rawArtifacts));
    assert.equal(validModel.calls.length, 2);
    assert.equal(valid.proposal?.posts[0]?.community?.key, 'https://t.me/synthetic-community');
    assert.equal(valid.rawArtifacts['social-selector-repair-prompt'], undefined);
    validateSocialWire(valid.rawArtifacts, validInput, SOCIAL_TOKEN, valid.proposal, valid.review);

    const legacyInput = input();
    const legacyModel = mockModel();
    const legacy = await qualifySocial(legacyInput, SOCIAL_TOKEN, KEY, legacyModel.fetcher, async () => {});
    assert.equal(legacy.code, undefined, JSON.stringify(legacy.rawArtifacts['social-validation-error'] ?? legacy.rawArtifacts));
    assert.equal(legacyModel.calls.length, 2);
    assert.equal(legacy.read.associationCitationMethod, undefined);
    assert.equal(legacy.rawArtifacts['social-selector-repair-prompt'], undefined);
    validateSocialWire(legacy.rawArtifacts, legacyInput, SOCIAL_TOKEN, legacy.proposal, legacy.review);
  });

  await t.test('wire reconstruction rejects reserialized association key, citation span, repair context, and omitted repair', () => {
    const rewritten = (raw: Record<string, string>, artifactId: string, mutate: (wire: Record<string, any>) => void) => {
      const envelope = JSON.parse(raw[artifactId]!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      const wire = JSON.parse(envelope.candidates[0]!.content.parts[0]!.text) as Record<string, any>;
      mutate(wire);
      envelope.candidates[0]!.content.parts[0]!.text = JSON.stringify(wire);
      raw[artifactId] = JSON.stringify(envelope);
      return wire;
    };
    const invalid = (artifacts: Record<string, string>) => assert.throws(
      () => validateSocialWire(artifacts, complete, SOCIAL_TOKEN, repaired.proposal, repaired.review),
      /SOCIAL_PROOF_INVALID|SOC_CITATION_INVALID/,
    );

    const changedKey = structuredClone(repaired.rawArtifacts);
    rewritten(changedKey, 'social-selector-repair-response', wire => {
      wire.posts[0].community = { key: invalidKey, citation: citationFor(repairedModel.calls[1]!.packet) };
    });
    invalid(changedKey);

    const changedSpan = structuredClone(repaired.rawArtifacts);
    rewritten(changedSpan, 'social-selector-repair-response', wire => {
      wire.posts[0].community = { key: 'https://t.me/synthetic-community', citation: { sourceId: 'post-alice-1', spanId: 'unretained-association-span' } };
    });
    invalid(changedSpan);

    const changedContext = structuredClone(repaired.rawArtifacts);
    const repairPacket = JSON.parse(changedContext['social-selector-repair-prompt']!) as { sources: PacketSource[] };
    repairPacket.sources[0]!.spans[0]!.text += ' modified context';
    changedContext['social-selector-repair-prompt'] = JSON.stringify(repairPacket);
    invalid(changedContext);

    const omittedRepair = structuredClone(repaired.rawArtifacts);
    delete omittedRepair['social-selector-repair-prompt'];
    delete omittedRepair['social-selector-repair-response'];
    invalid(omittedRepair);
  });
});

test('public-support-v2 separates full post bodies from short citations and requires an independently reviewed participation judgment', async t => {
  const body = `${SOCIAL_TOKEN.address} ${'Original public post detail. '.repeat(48)}`;
  const socialInput = input(0, body);
  socialInput.entryDecisionMethod = 'public-support-v2';
  socialInput.identityComplete = true;
  const mock = mockModel({ participationVerdict: 'CONTRADICTED' });
  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});

  assert.equal(result.code, undefined);
  assert.equal(mock.calls.length, 2);
  assert.equal(result.read.entryDecisionMethod, 'public-support-v2');
  assert.equal(result.proposal?.communityBreadthAssessment, undefined, 'v2 keeps its exact three-judgment contract');
  assert.equal(result.proposal?.posts[0]?.body.quote, body);
  assert.equal(result.proposal?.posts[0]?.bodyComplete, true);
  assert.equal(result.review?.sources[0]?.complete, true);
  assert.deepEqual(result.proposal?.participationAssessment?.verdict, 'CONTRADICTED');
  assert.deepEqual(result.review?.decisions.filter(row => row.id.startsWith('assessment:')).map(row => row.id), [
    'assessment:identity', 'assessment:integrity', 'assessment:participation',
  ]);
  for (const judgment of [result.proposal?.identityAssessment, result.proposal?.integrityAssessment, result.proposal?.participationAssessment]) {
    assert.ok(judgment);
    assert.ok(judgment.citations.every(citation => citation.quote.length <= 1000));
  }
  const proposalPacket = JSON.parse(result.rawArtifacts['social-proposal-prompt']!) as { scope: SocialInput; sources: PacketSource[] };
  const reviewPacket = JSON.parse(result.rawArtifacts['social-review-prompt']!) as { requiredDecisionIds: string[]; sources: PacketSource[]; bodySelectionManifest: Array<{ bodyComplete: boolean; reason: string | null }> };
  assert.equal(proposalPacket.scope.entryDecisionMethod, 'public-support-v2');
  assert.equal(fullText(proposalPacket.sources[0]!), body, 'the proposal receives the complete post body');
  assert.equal(fullText(reviewPacket.sources[0]!), body, 'the independent reviewer receives the same complete post body');
  assert.deepEqual(reviewPacket.requiredDecisionIds.filter(id => id.startsWith('assessment:')), [
    'assessment:identity', 'assessment:integrity', 'assessment:participation',
  ]);
  assert.deepEqual(reviewPacket.bodySelectionManifest[0], {
    sourceId: 'post-alice-1', selection: { firstLineId: 'post-alice-1:line:0', lastLineId: 'post-alice-1:line:0' },
    start: 0, end: body.length, length: body.length, bodyComplete: true, reason: null,
  });
  validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);

  await t.test('canonical packet validation rejects a stripped new-method marker and a missing third reviewer decision', () => {
    const stripMarker = structuredClone(result.rawArtifacts);
    for (const id of ['social-proposal-prompt', 'social-review-prompt']) {
      const packet = JSON.parse(stripMarker[id]!) as { scope: SocialInput };
      delete packet.scope.entryDecisionMethod;
      stripMarker[id] = JSON.stringify(packet);
    }
    assert.throws(
      () => validateSocialWire(stripMarker, socialInput, SOCIAL_TOKEN, result.proposal, result.review),
      /SOCIAL_PROOF_INVALID/,
    );

    const missingParticipationReview = structuredClone(result.rawArtifacts);
    const providerResponse = JSON.parse(missingParticipationReview['social-review-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const review = JSON.parse(providerResponse.candidates[0]!.content.parts[0]!.text) as {
      decisions: Array<{ id: string }> | Record<string, unknown>;
    };
    if (Array.isArray(review.decisions)) review.decisions = review.decisions.filter(decision => decision.id !== 'assessment:participation');
    else delete review.decisions['assessment:participation'];
    providerResponse.candidates[0]!.content.parts[0]!.text = JSON.stringify(review);
    missingParticipationReview['social-review-response'] = JSON.stringify(providerResponse);
    assert.throws(
      () => validateSocialWire(missingParticipationReview, socialInput, SOCIAL_TOKEN, result.proposal, result.review),
      /SOCIAL_PROOF_INVALID/,
    );
  });

  await t.test('empty new-mode screening citations get one selector repair and the retained instruction is canonical', async () => {
    const emptyInput = input(0, body);
    emptyInput.entryDecisionMethod = 'public-support-v2';
    emptyInput.identityComplete = true;
    const mock = mockModel({ responder: (packet, call) => {
      if (call === 1) {
        const proposal = proposalWire(packet);
        proposal.identityAssessment.citations = [];
        proposal.integrityAssessment.citations = [];
        proposal.participationAssessment!.citations = [];
        return proposal;
      }
      if (call === 2) {
        assert.ok(packet.invalidProposal, 'the selector repair is tied to the original empty-citation draft');
        return proposalWire(packet);
      }
      return keyedReviewWire(packet);
    } });
    const repaired = await qualifySocial(emptyInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });

    assert.equal(repaired.code, undefined);
    assert.equal(mock.calls.length, 3, 'one empty-citation draft, one corrected proposal, and one independent review');
    assert.ok(repaired.proposal && repaired.review);
    assert.ok(repaired.proposal.identityAssessment!.citations.length > 0);
    assert.ok(repaired.proposal.integrityAssessment!.citations.length > 0);
    assert.ok(repaired.proposal.participationAssessment!.citations.length > 0);
    const initialEnvelope = JSON.parse(repaired.rawArtifacts['social-proposal-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const initialDraft = JSON.parse(initialEnvelope.candidates[0]!.content.parts[0]!.text) as ReturnType<typeof proposalWire>;
    assert.deepEqual(initialDraft.identityAssessment.citations, []);
    assert.deepEqual(initialDraft.integrityAssessment.citations, []);
    assert.deepEqual(initialDraft.participationAssessment!.citations, []);
    assert.deepEqual(mock.calls[1]!.packet.invalidProposal, initialDraft,
      'the repair request retains the exact invalid provider proposal');
    const originalPrompt = JSON.parse(repaired.rawArtifacts['social-proposal-prompt']!) as Record<string, unknown>;
    const repairPrompt = JSON.parse(repaired.rawArtifacts['social-selector-repair-prompt']!) as Record<string, unknown>;
    const { instruction: _originalInstruction, ...originalContext } = originalPrompt;
    const { instruction: _repairInstruction, invalidProposal, ...repairContext } = repairPrompt;
    assert.deepEqual(repairContext, originalContext, 'repair reuses the identical token, scope, timeline, inventory, and full catalog');
    assert.deepEqual(invalidProposal, initialDraft);
    assert.ok(repaired.rawArtifacts['social-selector-repair-response']);
    validateSocialWire(repaired.rawArtifacts, emptyInput, SOCIAL_TOKEN, repaired.proposal, repaired.review);

    const tampered = structuredClone(repaired.rawArtifacts);
    repairPrompt.instruction = `${String(repairPrompt.instruction)} altered`;
    tampered['social-selector-repair-prompt'] = JSON.stringify(repairPrompt);
    assert.throws(() => validateSocialWire(tampered, emptyInput, SOCIAL_TOKEN, repaired.proposal!, repaired.review!), /SOCIAL_PROOF_INVALID/,
      'retained selector-repair instructions are reconstructed and checked');
  });

  await t.test('the legacy wire still rejects an empty screening citation without selector repair', async () => {
    const legacyInput = input(0, body);
    const mock = mockModel({ responder: packet => {
      const proposal = proposalWire(packet);
      proposal.identityAssessment.citations = [];
      return proposal;
    } });
    const result = await qualifySocial(legacyInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });

    assert.equal(mock.calls.length, 1);
    assert.equal(result.code, 'SOC_MODEL_INVALID');
    assert.equal(result.proposal, null);
    assert.equal(result.rawArtifacts['social-selector-repair-prompt'], undefined);
  });

  const derived = deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(derived.facts.participationReview?.verdict, 'CONTRADICTED', 'complete source inspection can grade inadequate participation evidence negatively');

  const legacy = await qualifySocial(input(0, body), SOCIAL_TOKEN, KEY, mockModel().fetcher, async () => {});
  assert.equal(legacy.read.entryDecisionMethod, undefined);
  assert.equal(legacy.proposal?.posts[0]?.bodyComplete, false, 'the absent marker keeps the historical 1,000-character whole-body limit');
  assert.ok((legacy.proposal?.posts[0]?.body.quote.length ?? Infinity) <= 1000);
  assert.equal(legacy.proposal?.participationAssessment, undefined, 'legacy inputs do not add a third screening judgment');

  await t.test('the new marker requires a third proposal judgment before review', async () => {
    const missing = mockModel({ responder: (packet, call) => {
      if (call !== 1) return reviewWire(packet);
      const proposal = proposalWire(packet) as Record<string, unknown>;
      delete proposal.participationAssessment;
      return proposal;
    } });
    const rejected = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, missing.fetcher, async () => {});
    assert.equal(missing.calls.length, 1);
    assert.equal(rejected.proposal, null);
    assert.equal(rejected.code, 'SOC_MODEL_INVALID');
  });

  await t.test('missing independent participation review coverage remains unresolved', async () => {
    const missing = mockModel({ responder: (packet, call) => {
      if (call === 1) return proposalWire(packet);
      const review = reviewWire(packet);
      return { ...review, decisions: review.decisions.filter(decision => decision.id !== 'assessment:participation') };
    } });
    const unreviewed = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, missing.fetcher, async () => {});
    assert.ok(unreviewed.proposal && unreviewed.review);
    const ungraded = deriveSocial(unreviewed.read, unreviewed.proposal, unreviewed.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
    assert.equal(ungraded.facts.participationReview, undefined);
    assert.ok(ungraded.assessments.find(row => row.id === 'S03')?.causes.some(cause => cause.code === 'SOC_REVIEW_INVALID'));
  });
});

test('verdict-aware review guidance is reconstructed only for its explicit fresh-run marker', async () => {
  const markedInput = input(0);
  markedInput.entryDecisionMethod = 'public-support-v2';
  markedInput.reviewCriterionMethod = 'verdict-aware-v1';
  const markedMock = mockModel();
  const marked = await qualifySocial(markedInput, SOCIAL_TOKEN, KEY, markedMock.fetcher, async () => {});

  assert.equal(marked.code, undefined);
  const proposalPrompt = JSON.parse(marked.rawArtifacts['social-proposal-prompt']!) as { instruction: string };
  const reviewPrompt = JSON.parse(marked.rawArtifacts['social-review-prompt']!) as { instruction: string; scope: SocialInput };
  assert.equal(reviewPrompt.scope.reviewCriterionMethod, 'verdict-aware-v1');
  assert.doesNotMatch(proposalPrompt.instruction, /When scope\.postSampleScope\.complete=true/,
    'the additional criterion governs independent review, not the proposal pass');
  assert.match(reviewPrompt.instruction, /When scope\.postSampleScope\.complete=true/);
  assert.match(reviewPrompt.instruction, /Do not reject a negative verdict merely by restating the same missing positive evidence/);
  validateSocialWire(marked.rawArtifacts, markedInput, SOCIAL_TOKEN, marked.proposal, marked.review);

  const legacyInput = input(0);
  legacyInput.entryDecisionMethod = 'public-support-v2';
  const legacyMock = mockModel();
  const legacy = await qualifySocial(legacyInput, SOCIAL_TOKEN, KEY, legacyMock.fetcher, async () => {});

  assert.equal(legacy.code, undefined);
  const legacyReview = JSON.parse(legacy.rawArtifacts['social-review-prompt']!) as { instruction: string; scope: SocialInput };
  assert.equal(legacyReview.scope.reviewCriterionMethod, undefined);
  assert.doesNotMatch(legacyReview.instruction, /When scope\.postSampleScope\.complete=true/,
    'an absent marker preserves the previous review instruction');
  validateSocialWire(legacy.rawArtifacts, legacyInput, SOCIAL_TOKEN, legacy.proposal, legacy.review);
});

test('verdict-aware v2 keeps other-platform evidence in assessments and constrains X account IDs', async t => {
  const socialInput = input();
  const otherPlatform = {
    id: 'instagram-source', url: 'https://www.instagram.com/river_lantern/',
    text: `A public Instagram page discusses the River Lantern project and token ${SOCIAL_TOKEN.address}, while making no claim that this page is an X account.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
  };
  socialInput.sources.push(otherPlatform);
  socialInput.identitySourceIds = [otherPlatform.id];
  socialInput.identityComplete = true;
  socialInput.entryDecisionMethod = 'public-support-v2';
  socialInput.reviewCriterionMethod = 'verdict-aware-v2';

  const validMock = mockModel({ responder: (packet, call) => {
    if (call !== 1) return reviewWire(packet);
    const proposal = proposalWire(packet);
    const source = packet.sources.find(row => row.id === otherPlatform.id)!;
    const citation = { sourceId: source.id, spanId: source.spans.find(span => span.text.includes(SOCIAL_TOKEN.address))!.id };
    proposal.identityAssessment = {
      verdict: 'UNRESOLVED',
      rationale: 'The full source describes an Instagram page but does not establish any X account binding.',
      citations: [citation],
    };
    proposal.integrityAssessment = {
      verdict: 'UNRESOLVED',
      rationale: 'The full source is retained as other-platform context and does not establish X participation.',
      citations: [citation],
    };
    return proposal;
  } });
  const valid = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, validMock.fetcher, async () => {});
  assert.equal(valid.code, undefined);
  assert.ok(valid.proposal && valid.review);
  assert.equal(valid.proposal.identities.length, 0);
  assert.deepEqual(valid.proposal.identityAssessment?.citations.map(citation => citation.sourceId), [otherPlatform.id]);
  assert.deepEqual(valid.proposal.integrityAssessment?.citations.map(citation => citation.sourceId), [otherPlatform.id]);
  const prompt = JSON.parse(valid.rawArtifacts['social-proposal-prompt']!) as { accountRepresentation?: string };
  assert.match(prompt.accountRepresentation ?? '', /only canonical x\.com:lowercase_handle IDs/i);
  assert.match(prompt.accountRepresentation ?? '', /Preserve ALL other-platform identity claims and counterevidence/i);
  validateSocialWire(valid.rawArtifacts, socialInput, SOCIAL_TOKEN, valid.proposal, valid.review);

  await t.test('an Instagram identity cannot be represented as an X public-account record', async () => {
    const invalidMock = mockModel({ responder: (packet, call) => {
      if (call !== 1) return reviewWire(packet);
      const source = packet.sources.find(row => row.id === otherPlatform.id)!;
      return {
        ...proposalWire(packet),
        identities: [{
          id: 'identity:instagram:river_lantern', accountId: 'instagram:river_lantern', status: 'CLAIMED',
          citations: [{ sourceId: source.id, spanId: source.spans[0]!.id }],
        }],
      };
    } });
    const invalid = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, invalidMock.fetcher, async () => {});
    assert.equal(invalidMock.calls.length, 1);
    assert.equal(invalid.code, 'SOC_MODEL_INVALID');
    assert.equal(invalid.proposal, null);
    assert.equal(invalid.review, null);
  });
});

test('verdict-aware v3 repairs a locally unsupported positive and binds the selection checks', async () => {
  const socialInput = input();
  socialInput.entryDecisionMethod = 'public-support-v3';
  socialInput.reviewCriterionMethod = 'verdict-aware-v3';
  const mock = mockModel({ responder: (packet, call) => {
    if (call === 1) {
      const proposal = proposalWire(packet) as Record<string, unknown>;
      const assessment = (proposal as { participationAssessment: { rationale: string; citations: WireCitation[] } }).participationAssessment;
      (proposal as { participationAssessment: { verdict: string; rationale: string; citations: WireCitation[] } }).participationAssessment = {
        verdict: 'SUPPORTED',
        rationale: 'The fully inspected post is offered as sufficient participation evidence.',
        citations: assessment.citations,
      };
      return proposal;
    }
    if (call === 2) return keyedReviewWire(packet);
    if (call === 3) {
      const repair = packet as ModelPacket & {
        selectedAssessmentIds?: string[];
        qualificationChecks?: {
          acquisitionComplete: boolean; allSourcesInspected: boolean;
          qualifiedSampleComplete: boolean; qualifiedLineageComplete: boolean; qualifiedOriginalCount: number | null;
          accountUpperBound: number | null; independentGroupCount: number | null;
          independentCommunityCount: number | null; judgments: Record<string, string>;
        };
      };
      assert.deepEqual(repair.selectedAssessmentIds, ['assessment:participation']);
      assert.deepEqual(repair.qualificationChecks, {
        acquisitionComplete: true, allSourcesInspected: true,
        qualifiedSampleComplete: true, qualifiedLineageComplete: false, qualifiedOriginalCount: 1,
        accountUpperBound: 1, independentGroupCount: null, independentCommunityCount: null,
        judgments: { identity: 'UNRESOLVED', integrity: 'UNRESOLVED', participation: 'UNRESOLVED', communityBreadth: 'UNRESOLVED' },
      });
      const post = packet.sources.find(source => source.id === packet.requiredPostIds[0])!;
      const span = post.spans.find(candidate => candidate.text.includes(SOCIAL_TOKEN.address))!;
      return { participationAssessment: {
        verdict: 'CONTRADICTED',
        rationale: 'The complete retained sample contains one account and no source-evidenced independent origin or community; this does not establish that no other participants exist.',
        citations: [{ sourceId: post.id, spanId: span.id }],
      } };
    }
    if (call === 4) return keyedReviewWire(packet);
    throw new Error(`UNEXPECTED_V3_SCREENING_REPAIR_CALL_${call}`);
  } });

  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });
  assert.equal(mock.calls.length, 4);
  assert.equal(result.code, undefined);
  assert.ok(result.proposal && result.review);
  assert.equal(result.proposal.participationAssessment?.verdict, 'CONTRADICTED');
  assert.equal(result.proposal.communityBreadthAssessment?.verdict, 'UNRESOLVED');
  assert.equal(result.proposal.posts[0]?.body.quote, socialInput.sources[0]?.text,
    'the repair changes only the selected screening judgment and retains the original post facts');
  assert.ok(result.review.decisions.every(decision => decision.accepted));
  assert.match(result.rawArtifacts['social-repair-proposal-prompt']!, /false qualifiedSampleComplete or qualifiedLineageComplete is NOT an acquisition failure/);
  const marker = JSON.parse(result.rawArtifacts['social-repair-selection']!) as {
    method: string; selectedAssessmentIds: string[]; applied: boolean;
  };
  assert.deepEqual(marker, {
    method: 'social-screening-repair-v3', selectedAssessmentIds: ['assessment:participation'], applied: true,
  });
  validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);

  const wrongMarker = structuredClone(result.rawArtifacts);
  wrongMarker['social-repair-selection'] = JSON.stringify({
    method: 'social-screening-repair-v2', selectedAssessmentIds: ['assessment:integrity'], applied: true,
  });
  assert.throws(() => validateSocialWire(wrongMarker, socialInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);

  const changedChecks = structuredClone(result.rawArtifacts);
  const repairPacket = JSON.parse(changedChecks['social-repair-proposal-prompt']!) as {
    qualificationChecks: { accountUpperBound: number | null };
  };
  repairPacket.qualificationChecks.accountUpperBound = 999;
  changedChecks['social-repair-proposal-prompt'] = JSON.stringify(repairPacket);
  assert.throws(() => validateSocialWire(changedChecks, socialInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);
});

test('verdict-aware v3 rejects a repeated positive identity repair when any included claim is unbound', async () => {
  const socialInput = input();
  socialInput.entryDecisionMethod = 'public-support-v3';
  socialInput.reviewCriterionMethod = 'verdict-aware-v3';
  socialInput.sources.push(
    { id: 'profile-river', url: 'https://x.com/river_lantern',
      text: `Official River Lantern profile for @river_lantern with contract ${SOCIAL_TOKEN.address}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' },
    { id: 'primary-river', url: 'https://river.example/project',
      text: `The River Lantern project account @river_lantern represents contract ${SOCIAL_TOKEN.address}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' },
    { id: 'profile-claimed', url: 'https://x.com/claimed_user',
      text: 'A public account profile for @claimed_user, with no independent token binding.',
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' },
  );
  socialInput.identitySourceIds = ['profile-river', 'primary-river', 'profile-claimed'];
  socialInput.identityComplete = true;

  const mock = mockModel({ responder: (packet, call) => {
    if (call === 1) {
      const proposal = proposalWire(packet) as Record<string, unknown>;
      const citation = (sourceId: string, predicate: (text: string) => boolean) => {
        const source = packet.sources.find(row => row.id === sourceId);
        assert.ok(source, `the proposal packet includes ${sourceId}`);
        const span = source.spans.find(item => predicate(item.text));
        assert.ok(span, `${sourceId} includes the exact cited identity evidence`);
        return { sourceId, spanId: span.id };
      };
      const profile = citation('profile-river', text => text.includes('@river_lantern') && text.includes(SOCIAL_TOKEN.address));
      const primary = citation('primary-river', text => text.includes('@river_lantern') && text.includes(SOCIAL_TOKEN.address));
      const claimed = citation('profile-claimed', text => text.includes('@claimed_user'));
      proposal.identities = [
        { id: 'identity:x.com:river_lantern', accountId: 'x.com:river_lantern', status: 'PUBLIC_BINDING_SUPPORTED', citations: [profile, primary] },
        { id: 'identity:x.com:claimed_user', accountId: 'x.com:claimed_user', status: 'CLAIMED', citations: [claimed] },
      ];
      proposal.identityAssessment = {
        verdict: 'SUPPORTED', rationale: 'The official record and independent project page support the River Lantern account.',
        citations: [profile, primary],
      };
      return proposal;
    }
    if (call === 2) return keyedReviewWire(packet);
    if (call === 3) {
      const repair = packet as ModelPacket & { selectedAssessmentIds?: string[]; qualificationChecks?: {
        acquisitionComplete: boolean; allSourcesInspected: boolean; judgments: Record<string, string>;
      } };
      assert.deepEqual(repair.selectedAssessmentIds, ['assessment:identity']);
      assert.equal(repair.qualificationChecks?.acquisitionComplete, true);
      assert.equal(repair.qualificationChecks?.allSourcesInspected, true);
      assert.equal(repair.qualificationChecks?.judgments.identity, 'UNRESOLVED',
        'the complete review still finds that the included CLAIMED record prevents a positive identity result');
      const profile = packet.sources.find(row => row.id === 'profile-river')!;
      const primary = packet.sources.find(row => row.id === 'primary-river')!;
      return { identityAssessment: {
        verdict: 'SUPPORTED', rationale: 'The official binding remains a positive identity result.',
        citations: [
          { sourceId: profile.id, spanId: profile.spans.find(span => span.text.includes(SOCIAL_TOKEN.address))!.id },
          { sourceId: primary.id, spanId: primary.spans.find(span => span.text.includes(SOCIAL_TOKEN.address))!.id },
        ],
      } };
    }
    if (call === 4) return keyedReviewWire(packet);
    throw new Error(`UNEXPECTED_V3_IDENTITY_REPAIR_CALL_${call}`);
  } });

  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });
  assert.equal(result.code, undefined);
  assert.equal(mock.calls.length, 4);
  assert.ok(result.proposal && result.review);
  assert.equal(result.proposal.identityAssessment?.verdict, 'SUPPORTED', 'the rejected repair leaves the exact original proposal in place');
  assert.deepEqual(result.proposal.identities.map(identity => identity.status), ['PUBLIC_BINDING_SUPPORTED', 'CLAIMED']);
  assert.equal(deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, []).facts.identityReview?.verdict, 'UNRESOLVED');
  assert.match(result.rawArtifacts['social-repair-proposal-prompt']!, /A positive identity grade requires EVERY included identity record/);
  assert.match(result.rawArtifacts['social-repair-proposal-prompt']!, /A supported official record cannot cancel another included CLAIMED\/unbound record/);
  assert.deepEqual(JSON.parse(result.rawArtifacts['social-repair-selection']!), {
    method: 'social-screening-repair-v3', selectedAssessmentIds: ['assessment:identity'], applied: false, code: 'SOC_REPAIR_REJECTED',
  });
  validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);
});

test('verdict-aware v4 grades complete acquisition while preserving uncertain facts and the bounded positive guard', async t => {
  const completeInput = input();
  completeInput.entryDecisionMethod = 'public-support-v3';
  completeInput.reviewCriterionMethod = 'verdict-aware-v4';
  completeInput.identityComplete = true;

  const citationFor = (packet: ModelPacket) => {
    const post = packet.sources.find(source => source.id === packet.requiredPostIds[0]);
    assert.ok(post);
    const span = post.spans.find(candidate => candidate.text.includes(SOCIAL_TOKEN.address));
    assert.ok(span);
    return { sourceId: post.id, spanId: span.id };
  };
  const negative = mockModel({ responder: (packet, call) => {
    if (call !== 1) return keyedReviewWire(packet);
    const proposal = proposalWire(packet) as Record<string, unknown>;
    const citation = citationFor(packet);
    const judgment = (rationale: string) => ({ verdict: 'CONTRADICTED', rationale, citations: [citation] });
    proposal.identityAssessment = judgment('The complete inspected public scope contains no independent source binding this token to an official account.');
    proposal.integrityAssessment = judgment('The inspected post does not provide the explicit origin and independent community needed for supported lineage.');
    proposal.participationAssessment = judgment('The complete sample does not establish three accounts, two independent origins, or two public communities.');
    proposal.communityBreadthAssessment = judgment('The complete sample does not establish three independently identified public communities.');
    return proposal;
  } });
  const reviewed = await qualifySocial(completeInput, SOCIAL_TOKEN, KEY, negative.fetcher, async () => {}, undefined, { screeningRepair: true });

  assert.equal(reviewed.code, undefined, JSON.stringify(reviewed.rawArtifacts['social-validation-error'] ?? reviewed.rawArtifacts));
  assert.equal(negative.calls.length, 2, 'a grounded negative that receives independent acceptance needs no repair call');
  assert.ok(reviewed.proposal && reviewed.review);
  const schema = (negative.calls[0]!.payload.generationConfig as { responseJsonSchema: {
    properties: Record<string, { properties: Record<string, { enum?: string[] }> }>;
  } }).responseJsonSchema;
  for (const field of ['identityAssessment', 'integrityAssessment', 'participationAssessment', 'communityBreadthAssessment']) {
    assert.deepEqual(schema.properties[field]?.properties.verdict?.enum, ['SUPPORTED', 'CONTRADICTED'],
      `${field} uses a binary entry judgment after its acquisition scope is complete`);
  }
  const submitted = JSON.parse(reviewed.rawArtifacts['social-proposal-prompt']!) as {
    entryEvidenceStandard?: { identityAcquisitionComplete: boolean; sampleAcquisitionComplete: boolean; rule: string };
  };
  assert.deepEqual([
    submitted.entryEvidenceStandard?.identityAcquisitionComplete,
    submitted.entryEvidenceStandard?.sampleAcquisitionComplete,
  ], [true, true]);
  assert.match(submitted.entryEvidenceStandard?.rule ?? '', /Qualified factual counts\/lineage may remain null or UNCLEAR/);

  const facts = deriveSocial(reviewed.read, reviewed.proposal, reviewed.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-v4-evidence']).facts;
  assert.equal(facts.identityReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.integrityReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.participationReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.communityBreadthReview?.verdict, 'CONTRADICTED');
  assert.equal(facts.qualifiedOriginalCount, 1, 'only the one actually reviewed current original is counted');
  assert.equal(facts.independentGroupCount, null, 'missing origin evidence remains unknown rather than zero');
  assert.equal(facts.independentCommunityCount, null, 'missing community evidence remains unknown rather than zero');
  assert.equal(reviewed.proposal.posts[0]?.body.quote, completeInput.sources[0]?.text);
  assert.equal(reviewed.proposal.posts[0]?.origin, null);
  assert.equal(reviewed.proposal.posts[0]?.community, null);
  assert.deepEqual(reviewed.proposal.posts[0]?.metrics, { likes: null, replies: null, reposts: null });
  validateSocialWire(reviewed.rawArtifacts, completeInput, SOCIAL_TOKEN, reviewed.proposal, reviewed.review);

  await t.test('unfinished acquisition keeps the three-way verdict option', async () => {
    const incompleteInput = input();
    incompleteInput.entryDecisionMethod = 'public-support-v3';
    incompleteInput.reviewCriterionMethod = 'verdict-aware-v4';
    incompleteInput.sampleComplete = false;
    incompleteInput.identityComplete = false;
    const incomplete = mockModel();
    const result = await qualifySocial(incompleteInput, SOCIAL_TOKEN, KEY, incomplete.fetcher, async () => {});
    assert.equal(result.code, undefined);
    assert.equal(incomplete.calls.length, 2);
    assert.equal(result.proposal?.identityAssessment?.verdict, 'UNRESOLVED');
    assert.equal(result.proposal?.integrityAssessment?.verdict, 'UNRESOLVED');
    assert.equal(result.proposal?.participationAssessment?.verdict, 'UNRESOLVED');
    assert.equal(result.proposal?.communityBreadthAssessment?.verdict, 'UNRESOLVED');
    const incompleteSchema = (incomplete.calls[0]!.payload.generationConfig as { responseJsonSchema: {
      properties: Record<string, { properties: Record<string, { enum?: string[] }> }>;
    } }).responseJsonSchema;
    assert.deepEqual(incompleteSchema.properties.participationAssessment?.properties.verdict?.enum,
      ['SUPPORTED', 'CONTRADICTED', 'UNRESOLVED']);
    const context = JSON.parse(result.rawArtifacts['social-proposal-prompt']!) as {
      entryEvidenceStandard?: { identityAcquisitionComplete: boolean; sampleAcquisitionComplete: boolean };
    };
    assert.deepEqual([context.entryEvidenceStandard?.identityAcquisitionComplete, context.entryEvidenceStandard?.sampleAcquisitionComplete], [false, false]);
  });

  await t.test('complete identity acquisition can be judged while the post sample stays unresolved', async () => {
    const identityOnlyInput = input();
    identityOnlyInput.entryDecisionMethod = 'public-support-v3';
    identityOnlyInput.reviewCriterionMethod = 'verdict-aware-v4';
    identityOnlyInput.identityComplete = true;
    identityOnlyInput.sampleComplete = false;
    const identityOnly = mockModel({ responder: (packet, call) => {
      if (call !== 1) return reviewWire(packet);
      const proposal = proposalWire(packet) as Record<string, unknown>;
      proposal.identityAssessment = { verdict: 'CONTRADICTED',
        rationale: 'The complete identity scope has no independent account-to-contract binding.',
        citations: [citationFor(packet)] };
      return proposal;
    } });
    const result = await qualifySocial(identityOnlyInput, SOCIAL_TOKEN, KEY, identityOnly.fetcher, async () => {});
    assert.equal(result.code, undefined);
    const schema = (identityOnly.calls[0]!.payload.generationConfig as { responseJsonSchema: {
      properties: Record<string, { properties: Record<string, { enum?: string[] }> }>;
    } }).responseJsonSchema;
    assert.deepEqual(schema.properties.identityAssessment?.properties.verdict?.enum, ['SUPPORTED', 'CONTRADICTED']);
    assert.deepEqual(schema.properties.integrityAssessment?.properties.verdict?.enum, ['SUPPORTED', 'CONTRADICTED', 'UNRESOLVED']);
    assert.equal(result.proposal?.identityAssessment?.verdict, 'CONTRADICTED');
    assert.equal(result.proposal?.integrityAssessment?.verdict, 'UNRESOLVED');
    assert.equal(result.proposal?.participationAssessment?.verdict, 'UNRESOLVED');
    const facts = deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, []).facts;
    assert.equal(facts.identityReview?.verdict, 'CONTRADICTED');
    assert.equal(facts.sampleComplete, false);
    assert.equal(facts.qualifiedOriginalCount, null);
    assert.equal(facts.independentCommunityCount, null);
  });

  await t.test('a locally unsupported positive receives the existing one repair pair and stays guarded', async () => {
    const positiveInput = structuredClone(completeInput);
    const positive = mockModel({ responder: (packet, call) => {
      if (call === 1) {
        const proposal = proposalWire(packet) as Record<string, unknown>;
        const citation = citationFor(packet);
        const negativeJudgment = (rationale: string) => ({ verdict: 'CONTRADICTED', rationale, citations: [citation] });
        proposal.identityAssessment = negativeJudgment('The complete inspected sources do not establish independent official account binding.');
        proposal.integrityAssessment = negativeJudgment('The sample lacks the explicit origin and independent community needed for supported lineage.');
        proposal.participationAssessment = { verdict: 'SUPPORTED', rationale: 'The retained post is proposed as sufficient participation evidence.', citations: [citation] };
        proposal.communityBreadthAssessment = negativeJudgment('The sample does not establish three independent public communities.');
        return proposal;
      }
      if (call === 2) {
        const review = keyedReviewWire(packet);
        review.decisions['assessment:participation']!.accepted = false;
        review.decisions['assessment:participation']!.rationale = 'The one retained account does not meet the required independent participation threshold.';
        return review;
      }
      if (call === 3) {
        const repair = packet as ModelPacket & { selectedAssessmentIds?: string[]; qualificationChecks?: {
          acquisitionComplete: boolean; allSourcesInspected: boolean; qualifiedLineageComplete: boolean;
          independentGroupCount: number | null; independentCommunityCount: number | null;
        } };
        assert.deepEqual(repair.selectedAssessmentIds, ['assessment:participation']);
        assert.equal(repair.qualificationChecks?.acquisitionComplete, true);
        assert.equal(repair.qualificationChecks?.allSourcesInspected, true);
        assert.equal(repair.qualificationChecks?.qualifiedLineageComplete, false);
        assert.equal(repair.qualificationChecks?.independentGroupCount, null);
        assert.equal(repair.qualificationChecks?.independentCommunityCount, null);
        assert.match(String((packet as { instruction?: string }).instruction), /A false qualifiedSampleComplete or qualifiedLineageComplete is NOT an acquisition failure/);
        return { participationAssessment: { verdict: 'CONTRADICTED',
          rationale: 'The complete inspected sample does not establish the independent origins and communities needed for supported participation.',
          citations: [citationFor(packet)] } };
      }
      if (call === 4) return keyedReviewWire(packet);
      throw new Error(`UNEXPECTED_V4_SCREENING_REPAIR_CALL_${call}`);
    } });
    const result = await qualifySocial(positiveInput, SOCIAL_TOKEN, KEY, positive.fetcher, async () => {}, undefined, { screeningRepair: true });
    assert.equal(result.code, undefined);
    assert.equal(positive.calls.length, 4, 'the bounded repair uses one proposal and one independent review');
    assert.equal(result.proposal?.participationAssessment?.verdict, 'CONTRADICTED');
    assert.equal(result.proposal?.posts[0]?.body.quote, positiveInput.sources[0]?.text);
    assert.deepEqual(JSON.parse(result.rawArtifacts['social-repair-selection']!), {
      method: 'social-screening-repair-v4', selectedAssessmentIds: ['assessment:participation'], applied: true,
    });
    assert.equal(deriveSocial(result.read, result.proposal, result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, []).facts.independentCommunityCount, null);
    validateSocialWire(result.rawArtifacts, positiveInput, SOCIAL_TOKEN, result.proposal, result.review);

    const downgraded = structuredClone(result.rawArtifacts);
    downgraded['social-repair-selection'] = JSON.stringify({
      method: 'social-screening-repair-v3', selectedAssessmentIds: ['assessment:participation'], applied: true,
    });
    assert.throws(() => validateSocialWire(downgraded, positiveInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);

    const changedChecks = structuredClone(result.rawArtifacts);
    const repairPacket = JSON.parse(changedChecks['social-repair-proposal-prompt']!) as {
      qualificationChecks: { independentCommunityCount: number | null };
    };
    repairPacket.qualificationChecks.independentCommunityCount = 0;
    changedChecks['social-repair-proposal-prompt'] = JSON.stringify(repairPacket);
    assert.throws(() => validateSocialWire(changedChecks, positiveInput, SOCIAL_TOKEN, result.proposal, result.review), /SOCIAL_PROOF_INVALID/);
  });

  await t.test('fresh v4 marker and reconstructed acquisition context cannot be downgraded or rewritten', () => {
    const downgradedInput = structuredClone(completeInput);
    downgradedInput.reviewCriterionMethod = 'verdict-aware-v3';
    assert.throws(() => validateSocialWire(reviewed.rawArtifacts, downgradedInput, SOCIAL_TOKEN, reviewed.proposal, reviewed.review), /SOCIAL_PROOF_INVALID/);

    const changedContext = structuredClone(reviewed.rawArtifacts);
    const prompt = JSON.parse(changedContext['social-proposal-prompt']!) as { entryEvidenceStandard: { sampleAcquisitionComplete: boolean } };
    prompt.entryEvidenceStandard.sampleAcquisitionComplete = false;
    changedContext['social-proposal-prompt'] = JSON.stringify(prompt);
    assert.throws(() => validateSocialWire(changedContext, completeInput, SOCIAL_TOKEN, reviewed.proposal, reviewed.review), /SOCIAL_PROOF_INVALID/);
  });
});

test('public-support-v3 adds an independently reviewed community-breadth judgment without changing v2', async () => {
  const body = `${SOCIAL_TOKEN.address} ${'A retained original body with source-grounded community context. '.repeat(24)}`;
  const socialInput = input(0, body);
  socialInput.entryDecisionMethod = 'public-support-v3';
  socialInput.identityComplete = true;
  const mock = mockModel();
  const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {});

  assert.equal(result.code, undefined);
  assert.equal(mock.calls.length, 2);
  assert.equal(result.read.entryDecisionMethod, 'public-support-v3');
  assert.equal(result.proposal?.posts[0]?.body.quote, body, 'v3 retains the full post body for both review passes');
  assert.equal(result.proposal?.communityBreadthAssessment?.verdict, 'UNRESOLVED');
  assert.match(result.proposal?.communityBreadthAssessment?.rationale ?? '', /three independently sourced communities/);
  assert.ok(result.proposal?.communityBreadthAssessment?.citations[0]?.quote.length <= 1000);
  assert.deepEqual(result.review?.decisions.filter(row => row.id.startsWith('assessment:')).map(row => row.id), [
    'assessment:identity', 'assessment:integrity', 'assessment:participation', 'assessment:communityBreadth',
  ]);
  const proposalPacket = JSON.parse(result.rawArtifacts['social-proposal-prompt']!) as ModelPacket;
  const reviewPacket = JSON.parse(result.rawArtifacts['social-review-prompt']!) as ModelPacket & { requiredDecisionIds: string[] };
  assert.equal(proposalPacket.scope?.entryDecisionMethod, 'public-support-v3');
  assert.match(proposalPacket.rubric?.entrySupport ?? '', /communityBreadthAssessment/);
  assert.match(proposalPacket.rubric?.entrySupport ?? '', /A18 growth is evaluated separately/);
  assert.match(result.rawArtifacts['social-review-prompt']!, /assessment:communityBreadth/);
  assert.deepEqual(reviewPacket.requiredDecisionIds.filter(id => id.startsWith('assessment:')), [
    'assessment:identity', 'assessment:integrity', 'assessment:participation', 'assessment:communityBreadth',
  ]);
  validateSocialWire(result.rawArtifacts, socialInput, SOCIAL_TOKEN, result.proposal, result.review);

  const missingCommunityReview = structuredClone(result.review!);
  missingCommunityReview.decisions = missingCommunityReview.decisions.filter(row => row.id !== 'assessment:communityBreadth');
  const unreviewed = deriveSocial(result.read, result.proposal, missingCommunityReview, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-v3']);
  assert.equal(unreviewed.facts.communityBreadthReview, undefined);
  assert.ok(unreviewed.assessments.find(row => row.id === 'S10')?.causes.some(cause => cause.code === 'SOC_REVIEW_INVALID'));
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

test('fresh repair re-inspects a fully acquired historical post with a null body without qualifying it as current', async t => {
  const run = async (condition: 'historical' | 'active' | 'missing-date' | 'transport') => {
    const socialInput = input(0, `${SOCIAL_TOKEN.address} The complete retained source includes an original publication whose body boundary is unresolved.`);
    socialInput.reviewCriterionMethod = 'verdict-aware-v4';
    socialInput.entryDecisionMethod = 'public-support-v3';
    socialInput.inspectionRecoveryMethod = 'historical-post-inspection-v1';
    socialInput.identityComplete = true;
    if (condition === 'historical') socialInput.sources[0]!.publishedAt = '2026-10-02T23:59:00.000Z';
    if (condition === 'active') socialInput.sources[0]!.publishedAt = SOCIAL_START;
    if (condition === 'missing-date') socialInput.sources[0]!.publishedAt = null;
    if (condition === 'transport') { socialInput.sampleComplete = false; socialInput.codes = ['SOC_FETCH_TIMEOUT']; }
    const mock = mockModel({ responder: (packet, call) => {
      if (call === 1) {
        const proposal = proposalWire(packet, 'valid', 'unresolved', 'CONTRADICTED', 'CONTRADICTED') as ReturnType<typeof proposalWire> & {
          identityAssessment: { verdict: string; rationale: string };
          communityBreadthAssessment: { verdict: string; rationale: string; citations: Array<{ sourceId: string; spanId: string }> };
        };
        proposal.identityAssessment.verdict = 'CONTRADICTED';
        proposal.identityAssessment.rationale = 'The complete public identity scope does not establish an independently supported account.';
        proposal.communityBreadthAssessment = { verdict: 'CONTRADICTED',
          rationale: 'The complete public sample does not establish three independently sourced communities.',
          citations: proposal.integrityAssessment.citations };
        return proposal;
      }
      if (call === 2) return keyedReviewWire(packet, false);
      if (call === 3) {
        const selected = (packet as unknown as { selectedAssessmentIds: string[] }).selectedAssessmentIds;
        const source = packet.sources.find(row => row.id === packet.requiredPostIds[0]);
        assert.ok(source);
        const span = source.spans.find(row => row.text.includes(SOCIAL_TOKEN.address));
        assert.ok(span);
        const assessment = { verdict: 'CONTRADICTED',
          rationale: 'After reading the entire old source, the bounded entry evidence remains inadequate.',
          citations: [{ sourceId: source.id, spanId: span.id }] };
        return Object.fromEntries(selected.map(id => [
          ({ 'assessment:integrity': 'integrityAssessment', 'assessment:participation': 'participationAssessment',
            'assessment:communityBreadth': 'communityBreadthAssessment' } as Record<string, string>)[id], assessment,
        ]));
      }
      return keyedReviewWire(packet, true);
    } });
    const result = await qualifySocial(socialInput, SOCIAL_TOKEN, KEY, mock.fetcher, async () => {}, undefined, { screeningRepair: true });
    return { result, mock, input: socialInput };
  };

  const historical = await run('historical');
  assert.equal(historical.result.code, undefined, JSON.stringify(historical.result.rawArtifacts['social-validation-error'] ?? {}));
  assert.equal(historical.mock.calls.length, 4, 'one existing two-call repair adds one proposal and its independent full review');
  assert.equal(historical.result.read.inspectionRecoveryMethod, 'historical-post-inspection-v1');
  assert.equal(historical.result.proposal?.posts[0]?.bodyComplete, false, 'a body boundary remains unresolved after source inspection');
  assert.equal(historical.result.proposal?.posts[0]?.role, 'UNCLEAR', 'the old post remains ineligible as a qualified participant');
  assert.equal(historical.result.review?.sources[0]?.complete, true, 'the repair review completes inspection of the retained historical source');
  const initialReview = JSON.parse(historical.result.rawArtifacts['social-review-response']!) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  const initial = JSON.parse(initialReview.candidates[0]!.content.parts[0]!.text) as { sources: Array<{ complete: boolean }> };
  assert.equal(initial.sources[0]?.complete, false, 'the original reviewer actually left the old source incomplete');
  const repair = JSON.parse(historical.result.rawArtifacts['social-repair-proposal-prompt']!) as {
    selectedAssessmentIds: string[]; historicalInspectionGaps: Array<{ sourceId: string; publishedAt: string; bodyRemainsUnqualified: boolean; retainedCharacters: number }>;
    historicalInspectionRule: string;
  };
  assert.deepEqual(repair.selectedAssessmentIds, ['assessment:integrity', 'assessment:participation', 'assessment:communityBreadth']);
  assert.deepEqual(repair.historicalInspectionGaps, [{ sourceId: 'post-alice-1', publishedAt: '2026-10-02T23:59:00.000Z',
    bodyRemainsUnqualified: true, retainedCharacters: historical.input.sources[0]!.text.length }]);
  assert.match(repair.historicalInspectionRule, /Do not equate bodyComplete=false with unread source/);
  assert.match(repair.historicalInspectionRule, /genuine unfinished inspection remains incomplete/);
  assert.equal(historical.result.proposal?.integrityAssessment?.verdict, 'CONTRADICTED');
  assert.equal(historical.result.proposal?.participationAssessment?.verdict, 'CONTRADICTED');
  assert.equal(historical.result.proposal?.communityBreadthAssessment?.verdict, 'CONTRADICTED');
  validateSocialWire(historical.result.rawArtifacts, historical.input, SOCIAL_TOKEN, historical.result.proposal, historical.result.review);
  const facts = deriveSocial(historical.result.read, historical.result.proposal, historical.result.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']).facts;
  assert.equal(facts.qualifiedOriginalCount, 0, 'the dated-before-window post never becomes a current participant');

  for (const condition of ['active', 'missing-date', 'transport'] as const) await t.test(condition, async () => {
    const blocked = await run(condition);
    assert.equal(blocked.result.code, undefined);
    assert.equal(blocked.mock.calls.length, 2, `${condition} records do not enter historical body inspection repair`);
    assert.equal(blocked.result.rawArtifacts['social-repair-proposal-prompt'], undefined);
    assert.equal(blocked.result.rawArtifacts['social-repair-selection'], undefined);
    assert.equal(blocked.result.review?.sources[0]?.complete, false);
  });
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
  const transportReceipt = JSON.parse(retained[1]!) as { kind: string; attempt: number; model: string; code: string; willRetry: boolean };
  assert.deepEqual({ kind: transportReceipt.kind, attempt: transportReceipt.attempt, code: transportReceipt.code, willRetry: transportReceipt.willRetry }, {
    kind: 'LOCAL_MODEL_TRANSPORT', attempt: 1, code: 'SOC_MODEL_HTTP_400', willRetry: false,
  });
  assert.equal(transportReceipt.model, geminiSettings.model);
});

test('source-model fallback follows two eligible failures with the same request and records model per attempt', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const retained: string[] = [];
  const waits: number[] = [];
  const timeout = Object.assign(new Error('private upstream detail'), { name: 'TimeoutError' });
  const result = await requestSourceJson('same packet', z.object({ ok: z.boolean() }), KEY,
    async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      if (calls.length === 1) throw timeout;
      if (calls.length === 2) return new Response('temporary 500 response', { status: 500 });
      return envelope({ ok: true });
    }, raw => { retained.push(raw); }, async milliseconds => { waits.push(milliseconds); }, undefined, 'SOC_MODEL');

  assert.deepEqual(result.value, { ok: true });
  assert.deepEqual(calls.map(call => call.url), [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:generateContent`,
  ]);
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[1]!.body, calls[2]!.body);
  assert.deepEqual(waits, [30_000, 60_000]);
  assert.equal(result.raw, retained.find(raw => raw.startsWith('{"candidates"')));
  const receipts = retained.filter(raw => raw.startsWith('{"kind":"LOCAL_MODEL_TRANSPORT"')).map(raw => JSON.parse(raw) as {
    attempt: number; model: string; code: string; willRetry: boolean;
  });
  assert.deepEqual(receipts.map(({ attempt, model, code, willRetry }) => ({ attempt, model, code, willRetry })), [
    { attempt: 1, model: geminiSettings.model, code: 'SOC_MODEL_TIMEOUT', willRetry: true },
    { attempt: 2, model: geminiSettings.model, code: 'SOC_MODEL_HTTP_500', willRetry: true },
    { attempt: 3, model: geminiSettings.fallbackModel, code: 'SOC_MODEL_HTTP_200', willRetry: false },
  ]);
});

test('fallback exhaustion is bounded to three identical bodies and reports the last HTTP failure', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const retained: string[] = [];
  const waits: number[] = [];
  await assert.rejects(() => requestSourceJson('same packet', z.object({ ok: z.boolean() }), KEY,
    async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return new Response(`temporary failure ${calls.length}`, { status: 500 });
    }, raw => { retained.push(raw); }, async milliseconds => { waits.push(milliseconds); }, undefined, 'SOC_MODEL'), /SOC_MODEL_HTTP_500/);

  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[1]!.body, calls[2]!.body);
  assert.deepEqual(calls.map(call => call.url), [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:generateContent`,
  ]);
  assert.deepEqual(waits, [30_000, 60_000]);
  assert.deepEqual(retained.filter(raw => !raw.startsWith('{"kind":"LOCAL_MODEL_TRANSPORT"')), [
    'temporary failure 1', 'temporary failure 2', 'temporary failure 3',
  ]);
  const receipts = retained.filter(raw => raw.startsWith('{"kind":"LOCAL_MODEL_TRANSPORT"')).map(raw => JSON.parse(raw) as { model: string; willRetry: boolean });
  assert.deepEqual(receipts.map(receipt => [receipt.model, receipt.willRetry]), [
    [geminiSettings.model, true], [geminiSettings.model, true], [geminiSettings.fallbackModel, false],
  ]);
});

test('verified minute quota retries the same request using RetryInfo and preserves generic receipts', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const retained: string[] = [];
  const waits: number[] = [];
  const routing = { fallbackActive: false };
  const quotaBody = quotaErrorBody({ retryDelay: '45s' });
  const result = await requestSourceJson('same quota packet', z.object({ ok: z.boolean() }), KEY,
    async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return calls.length === 1 ? new Response(quotaBody, { status: 429 }) : envelope({ ok: true });
    }, raw => { retained.push(raw); }, async milliseconds => { waits.push(milliseconds); }, undefined, 'SOC_MODEL', routing);

  assert.deepEqual(result.value, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.url), Array(2).fill(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`));
  assert.equal(calls[0]!.body, calls[1]!.body, 'the retry sends the exact serialized request');
  assert.deepEqual(waits, [45_000], 'the valid RetryInfo delay above the normal first wait is honored');
  assert.equal(routing.fallbackActive, false, 'a successful primary-model retry does not activate fallback routing');
  assert.equal(retained[0], quotaBody, 'the original provider response remains available as raw evidence');
  const receipts = retained.filter(raw => raw.startsWith('{"kind":"LOCAL_MODEL_TRANSPORT"')).map(raw => JSON.parse(raw) as {
    attempt: number; model: string; code: string; willRetry: boolean;
  });
  assert.deepEqual(receipts.map(({ attempt, model, code, willRetry }) => ({ attempt, model, code, willRetry })), [
    { attempt: 1, model: geminiSettings.model, code: 'SOC_MODEL_HTTP_429', willRetry: true },
    { attempt: 2, model: geminiSettings.model, code: 'SOC_MODEL_HTTP_200', willRetry: false },
  ]);
  assert.ok(receipts.every(receipt => !JSON.stringify(receipt).includes('PerMinute')),
    'transport receipts expose the bounded HTTP code without leaking provider quota details');
});

test('repeated verified minute quotas use the bounded third fallback attempt and keep it scoped to the run', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const retained: string[] = [];
  const waits: number[] = [];
  const routing = { fallbackActive: false };
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    return calls.length <= 2
      ? new Response(quotaErrorBody({ retryDelay: calls.length === 1 ? '45s' : '58s' }), { status: 429 })
      : envelope({ ok: true });
  };
  const firstStage = await requestSourceJson('quota proposal packet', z.object({ ok: z.boolean() }), KEY,
    fetcher, raw => { retained.push(raw); }, async milliseconds => { waits.push(milliseconds); }, undefined, 'SOC_MODEL', routing);
  const sameRunStage = await requestSourceJson('later stage packet', z.object({ ok: z.boolean() }), KEY,
    fetcher, raw => { retained.push(raw); }, async () => {}, undefined, 'SOC_MODEL', routing);
  const freshRouting = { fallbackActive: false };
  const freshRunStage = await requestSourceJson('new run packet', z.object({ ok: z.boolean() }), KEY,
    fetcher, raw => { retained.push(raw); }, async () => {}, undefined, 'SOC_MODEL', freshRouting);

  assert.deepEqual(firstStage.value, { ok: true });
  assert.deepEqual(sameRunStage.value, { ok: true });
  assert.deepEqual(freshRunStage.value, { ok: true });
  assert.deepEqual(calls.slice(0, 3).map(call => call.url), [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:generateContent`,
  ]);
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[1]!.body, calls[2]!.body);
  assert.deepEqual(waits, [45_000, 60_000], 'RetryInfo is bounded by the existing 30/60 second waits');
  assert.equal(calls[3]!.url, `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:generateContent`,
    'the fallback stays active for later stages in this run');
  assert.equal(calls[4]!.url, `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    'a fresh route begins on the primary model');
  assert.equal(routing.fallbackActive, true);
  assert.equal(freshRouting.fallbackActive, false);
  const receipts = retained.filter(raw => raw.startsWith('{"kind":"LOCAL_MODEL_TRANSPORT"')).map(raw => JSON.parse(raw) as {
    attempt: number; model: string; code: string; willRetry: boolean;
  });
  assert.deepEqual(receipts.slice(0, 3).map(({ attempt, model, code, willRetry }) => ({ attempt, model, code, willRetry })), [
    { attempt: 1, model: geminiSettings.model, code: 'SOC_MODEL_HTTP_429', willRetry: true },
    { attempt: 2, model: geminiSettings.model, code: 'SOC_MODEL_HTTP_429', willRetry: true },
    { attempt: 3, model: geminiSettings.fallbackModel, code: 'SOC_MODEL_HTTP_200', willRetry: false },
  ]);
});

test('caller abort during identified minute-quota wait prevents the next request', async () => {
  const controller = new AbortController();
  const urls: string[] = [];
  const waits: number[] = [];
  await assert.rejects(() => requestSourceJson('quota packet', z.object({ ok: z.boolean() }), KEY,
    async input => {
      urls.push(String(input));
      return new Response(quotaErrorBody({ retryDelay: '45s' }), { status: 429 });
    }, () => {}, async milliseconds => {
      waits.push(milliseconds);
      controller.abort(new DOMException('cancelled', 'AbortError'));
    }, controller.signal, 'SOC_MODEL'), /SOC_MODEL_RUN_ABORTED/);
  assert.deepEqual(urls, [`https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`]);
  assert.deepEqual(waits, [45_000]);
});

test('daily, mixed, mismatched, incomplete, and invalid-delay quota responses remain permanent 429 failures', async t => {
  const cases = [
    { name: 'daily quota', body: quotaErrorBody({ quotaIds: ['GenerateContentInputTokensPerModelPerDay-FreeTier'] }) },
    { name: 'mixed minute and daily quotas', body: quotaErrorBody({ quotaIds: ['GenerateContentInputTokensPerModelPerMinute-FreeTier', 'GenerateContentInputTokensPerModelPerDay-FreeTier'] }) },
    { name: 'different model', body: quotaErrorBody({ model: 'gemini-other-model' }) },
    { name: 'missing RetryInfo', body: quotaErrorBody({ retryDelay: null }) },
    { name: 'delay above sixty seconds', body: quotaErrorBody({ retryDelay: '61s' }) },
    { name: 'zero quota value', body: quotaErrorBody({ quotaValue: '0' }) },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const urls: string[] = [];
    const retained: string[] = [];
    const waits: number[] = [];
    const routing = { fallbackActive: false };
    let message = '';
    await assert.rejects(() => requestSourceJson('quota packet', z.object({ ok: z.boolean() }), KEY,
      async input => { urls.push(String(input)); return new Response(scenario.body, { status: 429 }); },
      raw => { retained.push(raw); }, async milliseconds => { waits.push(milliseconds); }, undefined, 'SOC_MODEL', routing),
    error => {
      message = String(error);
      return message.includes('SOC_MODEL_HTTP_429');
    });
    assert.deepEqual(urls, [`https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`]);
    assert.deepEqual(waits, []);
    assert.equal(routing.fallbackActive, false);
    assert.equal(message.includes('RESOURCE_EXHAUSTED'), false, 'the thrown status does not expose provider quota details');
    const receipt = JSON.parse(retained.find(raw => raw.startsWith('{"kind":"LOCAL_MODEL_TRANSPORT"'))!) as {
      kind: string; attempt: number; phase: string; elapsedMs: number; budgetMs: number;
      model: string; code: string; willRetry: boolean;
    };
    assert.ok(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0);
    assert.deepEqual(receipt, {
      kind: 'LOCAL_MODEL_TRANSPORT', attempt: 1, phase: 'RESPONSE_BODY',
      elapsedMs: receipt.elapsedMs, budgetMs: 90_000, model: geminiSettings.model,
      code: 'SOC_MODEL_HTTP_429', willRetry: false,
    });
    assert.equal(JSON.stringify(receipt).includes('PerMinute'), false);
  });
});

test('HTTP 400/429, malformed successful output, and abort during backoff do not start a fallback request', async t => {
  for (const status of [400, 429] as const) await t.test(`HTTP ${status}`, async () => {
    const urls: string[] = [];
    await assert.rejects(() => requestSourceJson('packet', z.object({ ok: z.boolean() }), KEY,
      async input => { urls.push(String(input)); return new Response('rejected', { status }); }, () => {}, async () => {}, undefined, 'SOC_MODEL'),
    new RegExp(`SOC_MODEL_HTTP_${status}`));
    assert.deepEqual(urls, [`https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`]);
  });

  await t.test('schema-invalid HTTP 200', async () => {
    const urls: string[] = [];
    await assert.rejects(() => requestSourceJson('packet', z.object({ ok: z.boolean() }), KEY,
      async input => { urls.push(String(input)); return new Response('{"candidates":[]}'); }, () => {}, async () => {}, undefined, 'SOC_MODEL'), /SOC_MODEL_FINISH/);
    assert.deepEqual(urls, [`https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`]);
  });

  await t.test('caller abort during second delay', async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const waits: number[] = [];
    await assert.rejects(() => requestSourceJson('packet', z.object({ ok: z.boolean() }), KEY,
      async input => {
        urls.push(String(input));
        if (urls.length === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        return new Response('temporary failure', { status: 500 });
      }, () => {}, async milliseconds => {
        waits.push(milliseconds);
        if (milliseconds === 60_000) controller.abort(new DOMException('cancelled', 'AbortError'));
      }, controller.signal, 'SOC_MODEL'), /SOC_MODEL_RUN_ABORTED/);
    assert.deepEqual(urls, [
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    ]);
    assert.deepEqual(waits, [30_000, 60_000]);
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


test('merged social replay accepts both exact pre-merge public packet templates and rejects a hybrid source-scope omission',async()=>{
 const read={...input(),entryDecisionMethod:'public-support-v3' as const};const mock=mockModel();const result=await qualifySocial(read,SOCIAL_TOKEN,KEY,mock.fetcher,async()=>{});assert.ok(result.proposal&&result.review,result.code);validateSocialWire(result.rawArtifacts,result.read,SOCIAL_TOKEN,result.proposal,result.review);
 const legacy=structuredClone(result.rawArtifacts);for(const id of ['social-proposal-prompt','social-review-prompt']){const p=JSON.parse(legacy[id]!);delete p.identityScopeInventory;delete p.currentWindowFacts;p.instruction=p.instruction.replace('Do not invent official claims for exchange listings or token commentators. ','').replace('When currentWindowFacts has zero current targets and no undated targets, reject ANY rationale claiming metadata shortfalls across qualified current posts: there are no such participants. A separately supported bounded empty-sample visibility judgment must say that precisely. ','');legacy[id]=JSON.stringify(p);}
 validateSocialWire(legacy,result.read,SOCIAL_TOKEN,result.proposal,result.review);const hybrid=structuredClone(legacy),p=JSON.parse(hybrid['social-proposal-prompt']!);p.currentWindowFacts=JSON.parse(result.rawArtifacts['social-proposal-prompt']!).currentWindowFacts;hybrid['social-proposal-prompt']=JSON.stringify(p);assert.throws(()=>validateSocialWire(hybrid,result.read,SOCIAL_TOKEN,result.proposal,result.review),/SOCIAL_PROOF_INVALID/);
});
