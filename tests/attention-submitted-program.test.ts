import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSubmittedAttentionProgram, qualifyAttention } from '../src/providers/attention-model.js';
import type { AttentionRead } from '../src/providers/attention.js';

const TOKEN = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
const END = '2026-10-01T12:00:00.000Z';
// Frozen from accepted 4c11306 private qualifySubmittedAttention, before extraction.
const INSTRUCTION_HASHES = {
  proposal: '0005688c0d5b290ee443138c3ce20a8a0bc8c649f6216243714aaaed2a22d75a',
  review: '55764d183be8d9b48908fe37db4384bfa4ca228ea425097a14dd812a87ad48c6',
};
type Packet = {
  instruction: string;
  sources: Array<{ id: string; spans: Array<{ id: string; text: string }>; text?: string }>;
  requiredPostSourceIds?: string[];
  requiredDecisionIds?: string[];
  scope: { comparisonComplete?: boolean; comparisonDeferred?: boolean };
};
function read(full = false, comparison = false): AttentionRead {
  return {
    ...(full ? { entryEvidenceMethod: 'public-support-v2' as const } : {}),
    sources: [
      { id: 'page', url: 'https://public.example/story', text: `Token ${TOKEN.address}. Neighbors tell a lantern story. ${'Unchanged context. '.repeat(400)}`,
        availableAt: END, publishedAt: null, authorId: null, kind: 'PAGE' },
      { id: 'post', url: 'https://x.com/lantern/status/123', text: `Token ${TOKEN.address}. Our community tells a lantern story.`,
        availableAt: END, publishedAt: '2026-10-01T11:00:00.000Z', authorId: 'x.com:lantern', kind: 'POST' },
    ],
    rawArtifacts: {}, queries: ['exact token narrative'], complete: true, postSampleComplete: true, codes: [],
    start: '2026-10-01T11:59:00.000Z', end: END,
    ...(comparison ? { comparisonComplete: false, comparisonSourceIds: ['page'] } : {}),
  };
}
function proposal(packet: Packet) {
  return {
    claims: [{ id: 'story', feature: 'A01', value: true, summary: 'This community shares a neighborhood lantern story.',
      citations: [{ sourceId: 'page', spanId: packet.sources.find(source => source.id === 'page')!.spans[0]!.id }] }],
    posts: Object.fromEntries(packet.requiredPostSourceIds!.map(id => [id, {
      spanId: packet.sources.find(source => source.id === id)!.spans[0]!.id, role: 'NEWS',
    }])), competitors: [],
  };
}
function review(packet: Packet) {
  return {
    decisions: Object.fromEntries(packet.requiredDecisionIds!.map(id => [id, { accepted: true, rationale: 'The unchanged source supports this bounded item.' }])),
    ...(packet.scope.comparisonComplete !== undefined ? {
      candidateSet: { complete: false, rationale: 'This packet does not establish a complete representation set.' },
      originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No primary project endorsement is established here.' },
    } : {}),
  };
}
function envelope(value: unknown) {
  return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }),
    { headers: { 'content-type': 'application/json' } });
}
function packetText(init?: RequestInit) {
  return (JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0]!.parts[0]!.text;
}

test('canonical submitted program preserves original instructions, packet order, prefix/full scopes and hosted bytes', async t => {
  for (const item of [
    { name: 'legacy-prefix', full: false, comparison: false, deferred: false, short: false },
    { name: 'full-source', full: true, comparison: false, deferred: false, short: false },
    { name: 'v2-short', full: false, comparison: true, deferred: false, short: true },
    { name: 'v2-deferred-prefix', full: false, comparison: true, deferred: true, short: false },
    { name: 'v2-deferred-full', full: true, comparison: true, deferred: true, short: false },
  ]) await t.test(item.name, async () => {
    const source = read(item.full, item.comparison);
    if (item.short) source.sources[0]!.text = source.sources[0]!.text.slice(0, 1000);
    const program = createSubmittedAttentionProgram(source, TOKEN, item.deferred);
    const first = JSON.parse(program.proposalPacket) as Packet;
    const normalized = program.normalizeProposal(proposal(first));
    const built = program.buildReview(normalized)!;
    const second = JSON.parse(built.reviewPacket) as Packet;
    assert.equal(createHash('sha256').update(first.instruction).digest('hex'), INSTRUCTION_HASHES.proposal);
    assert.equal(createHash('sha256').update(second.instruction).digest('hex'), INSTRUCTION_HASHES.review);
    assert.deepEqual(Object.keys(first), ['instruction', 'token', 'rubric', 'postRoles', 'sources', 'scope',
      'primaryOriginPostCitationOptions', 'eligibleClaimSourceIds', 'eligibleOriginClaimSourceIds', 'originCitationRule', 'requiredPostSourceIds']);
    assert.deepEqual(Object.keys(second), ['instruction', 'token', 'rubric', 'postRoles', 'sources', 'scope',
      'originCitationOptions', 'proposal', 'requiredDecisionIds']);
    assert.equal(program.sources[0]!.text.length, item.full ? source.sources[0]!.text.length : Math.min(source.sources[0]!.text.length, 6000));
    assert.deepEqual(first.sources, second.sources);
    assert.equal(first.scope.comparisonDeferred, item.deferred ? true : undefined);
    assert.deepEqual(program.normalizeReview(review(second), normalized).decisions.map(row => row.id), ['story', 'post:post']);
    const requests: string[] = [];
    const result = await qualifyAttention(source, TOKEN, 'program-test-key', async (input, init) => {
      if (String(input).includes(':countTokens')) return new Response(JSON.stringify({ totalTokens: 1000 }));
      const text = packetText(init); requests.push(text);
      // Deferred comparison's later stages are outside this submitted-source program.
      if (requests.length > 2) throw new Error('constructed comparison stage unavailable');
      const packet = JSON.parse(text) as Packet;
      return envelope(requests.length === 1 ? proposal(packet) : review(packet));
    }, async () => {});
    assert.equal(requests[0], program.proposalPacket);
    assert.equal(requests[1], built.reviewPacket);
    assert.deepEqual(result.proposal, normalized);
    assert.ok(result.review?.decisions.every(row => row.accepted));
  });
});

test('canonical program rejects source/span, token, feature, post and decision substitutions before returning authority', () => {
  const source = read(true), program = createSubmittedAttentionProgram(source, TOKEN);
  const first = JSON.parse(program.proposalPacket) as Packet;
  const wire = proposal(first), normalized = program.normalizeProposal(wire);
  const built = program.buildReview(normalized)!, second = JSON.parse(built.reviewPacket) as Packet;
  for (const mutate of [
    (value: typeof wire) => { value.claims[0]!.citations[0]!.sourceId = 'https://public.example/story'; },
    (value: typeof wire) => { value.claims[0]!.citations[0]!.spanId = first.sources.find(row => row.id === 'post')!.spans[0]!.id; },
    (value: typeof wire) => { value.claims.push({ ...value.claims[0]!, id: 'duplicate-feature' }); },
    (value: typeof wire) => { value.claims[0]!.id = 'post:forged'; },
    (value: typeof wire) => { delete value.posts.post; },
  ]) {
    const changed = structuredClone(wire); mutate(changed);
    assert.throws(() => program.normalizeProposal(changed));
  }
  const wrongToken = createSubmittedAttentionProgram(source, { ...TOKEN, address: '0x2222222222222222222222222222222222222222' });
  assert.throws(() => wrongToken.normalizeProposal(wire));
  const cached = structuredClone(normalized); cached.claims[0]!.citations[0]!.quote = 'A fabricated quote cannot become review context.';
  assert.throws(() => program.buildReview(cached), /ATT_MODEL_SPAN_INVALID/);
  const omitted = review(second); delete omitted.decisions['post:post'];
  assert.throws(() => program.normalizeReview(omitted, normalized));
  const surplus = review(second); surplus.decisions.extra = { accepted: true, rationale: 'A non-required decision is not permitted.' };
  assert.throws(() => program.normalizeReview(surplus, normalized));
  const rejection = review(second); rejection.decisions.story!.accepted = false;
  assert.equal(program.normalizeReview(rejection, normalized).decisions[0]!.accepted, false, 'a genuine rejection is retained, never inverted');
});

test('canonical review preserves v2 origin schema and only original empty legacy programs omit review', () => {
  const source = read(true, true), program = createSubmittedAttentionProgram(source, TOKEN, true);
  const normalized = program.normalizeProposal(proposal(JSON.parse(program.proposalPacket) as Packet));
  const second = JSON.parse(program.buildReview(normalized)!.reviewPacket) as Packet;
  const missing = review(second); delete (missing as Record<string, unknown>).candidateSet;
  assert.throws(() => program.normalizeReview(missing, normalized));
  const origin = review(second);
  origin.originRelationship = { status: 'SUPPORTED', citations: [], rationale: 'An unsupported origin has no primary citation.' };
  assert.throws(() => program.normalizeReview(origin, normalized), /ATT_MODEL_ORIGIN_CITATION_MISSING/);
  const noPosts = { ...read(), sources: [read().sources[0]!] };
  const legacy = createSubmittedAttentionProgram(noPosts, TOKEN);
  const empty = legacy.normalizeProposal({ claims: [], posts: {}, competitors: [] });
  assert.equal(legacy.buildReview(empty), null);
  assert.deepEqual(legacy.normalizeReview({ decisions: {} }, empty), { decisions: [] });
  assert.throws(() => legacy.normalizeReview({ decisions: { invented: { accepted: true, rationale: 'Unexpected review authority.' } } }, empty));
  const v2 = createSubmittedAttentionProgram({ ...noPosts, comparisonComplete: false }, TOKEN);
  assert.ok(v2.buildReview(empty), 'v2 completeness/origin review is required even with no item decisions');
});

test('native wire parsing fails closed on inconsistent A05 while hosted execution keeps its one scoped repair', async () => {
  const source = read(true), program = createSubmittedAttentionProgram(source, TOKEN);
  const first = JSON.parse(program.proposalPacket) as Packet, initial = proposal(first);
  const explanation = { referent: 'The neighborhood lantern story', interest: 'Neighbors share this story', tokenRelation: 'This token represents the community', prerequisites: [] as string[] };
  const a05 = { ...initial.claims[0]!, id: 'explanation', feature: 'A05', value: false,
    summary: 'This token represents a neighborhood that shares a lantern story.', explanation };
  const invalid = { ...initial, claims: [...initial.claims, a05] };
  assert.throws(() => program.normalizeProposal(invalid), /A05 value must match its necessary prerequisite list/);
  const repaired = { ...invalid, claims: [...initial.claims, { ...a05, value: true }] };
  const calls: string[] = [];
  const result = await qualifyAttention(source, TOKEN, 'program-test-key', async (input, init) => {
    if (String(input).includes(':countTokens')) return new Response(JSON.stringify({ totalTokens: 1000 }));
    const text = packetText(init); calls.push(text);
    if (calls.length === 1) return envelope(invalid);
    if (calls.length === 2) return envelope(repaired);
    return envelope(review(JSON.parse(text) as Packet));
  }, async () => {});
  assert.equal(result.code, undefined);
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[1]!).invalidProposal, invalid);
  assert.equal(calls[2], program.buildReview(program.normalizeProposal(repaired))!.reviewPacket);
  assert.ok(result.rawArtifacts['attention-proposal-invalid-response']);
  assert.equal(result.rawArtifacts['attention-proposal-response'], result.rawArtifacts['attention-proposal-repair-response']);
});
