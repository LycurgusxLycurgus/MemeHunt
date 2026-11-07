import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { MPL_TOKEN_METADATA_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import { buildCriterionInput, criterionComparisonEligibility, criterionPostFacts, criterionReviewMethod, criterionSharedClaims, criterionWireSchema, decodeCriterionBatch, finalizeCriterionResults, measureCriterionPosts, resolveCriterion, resolveCriterionDecision, type CriterionId, type CriterionInput, type CriterionIssue, type CriterionProof, type CriterionReceipt, type CriterionResult, type CriterionWireRow } from '../src/domain/criterion-review.js';
import { buildNarrativeContentScope } from '../src/domain/attention.js';
import type { SocialPolicyFacts, TokenRef } from '../src/domain/contracts.js';
import type { AttentionRead, AttentionSource } from '../src/providers/attention.js';
import { criterionReviewPacket } from '../src/providers/attention-model.js';
import { criterionFirecrawlProjection } from '../src/providers/criterion-firecrawl.js';
import { projectAcquisition, renderPurposeReceipt } from '../src/domain/acquisition-purpose.js';

const TARGET: TokenRef = { chain: 'base', address: `0x${'a'.repeat(40)}` };
const ALTERNATIVE: TokenRef = { chain: 'base', address: `0x${'b'.repeat(40)}` };
const START = '2026-10-01T00:00:00.000Z';
const END = '2026-10-03T00:00:00.000Z';
const POLICY = 'research-screen-criteria-v1' as const;

type ReadOptions = { posts?: AttentionSource[]; comparisonStatus?: number; newlineBody?: string };

function page(id: string, url: string, text: string, discoveredFrom?: string): AttentionSource {
  return { id, url, text, publishedAt: null, authorId: null, availableAt: END, kind: 'PAGE', ...(discoveredFrom ? { discoveredFrom } : {}) };
}

function readFixture(options: ReadOptions = {}): AttentionRead {
  const metadataUrl = 'https://metadata.example/cedar.json';
  const storyUrl = 'https://public.example/cedar-story';
  const identity = page('identity-metadata', metadataUrl, JSON.stringify({
    name: `Synthetic Cedar ${TARGET.address}`,
    symbol: 'CEDAR',
    website: storyUrl,
  }));
  const story = page('narrative-page', storyUrl,
    options.newlineBody ?? `The Synthetic Cedar community shares local stories and art.\nThe description explains its neighborhood game and active players. Its official project page identifies ${TARGET.address} as the community asset.`, metadataUrl);
  const mint = page('mint-proof-page', 'https://public.example/mint-record', `The published project record identifies ${TARGET.address} as the target mint.`);
  const comparison = page('comparison-page', 'https://public.example/alternative',
    `The alternative project has its own community story and uses mint ${ALTERNATIVE.address}; the target ${TARGET.address} is included only to bind this comparison.`);
  const sources = [identity, story, mint, comparison, ...(options.posts ?? [])];
  const comparisonStatus = options.comparisonStatus ?? 200;
  const searches = [
    { required: true, purpose: 'EXACT_TOKEN', artifactId: 'attention-search-exact', status: 200, availableAt: END },
    { required: true, purpose: 'SOCIAL', artifactId: 'attention-search-social', status: 200, availableAt: END },
    { required: true, purpose: 'COMPARISON', artifactId: 'attention-search-comparison', status: comparisonStatus, availableAt: END },
  ];
  const fetchArtifactId = 'attention-fetch-1';
  const fetchRaw = JSON.stringify({
    results: sources.map(source => ({ url: source.url, final_url: source.url, text: source.text, published_date: source.publishedAt })),
    errors: [],
  });
  const read: AttentionRead = {
    narrativeContentMethod: 'typed-metadata-content-v1',
    metadataLinkMethod: 'onchain-metadata-v1',
    metadataLinks: true,
    metadataUri: metadataUrl,
    discoveryUrls: [metadataUrl],
    sources,
    rawArtifacts: {
      'attention-acquisition-ledger': JSON.stringify({ searches }),
      'attention-search-exact': JSON.stringify({ results: [], errors: [] }),
      'attention-search-social': JSON.stringify({ results: [], errors: [] }),
      'attention-search-comparison': comparisonStatus < 300
        ? JSON.stringify({ results: [], errors: [] })
        : JSON.stringify({ error: 'comparison search unavailable' }),
      'criterion-fetch-requests': JSON.stringify({
        method: 'criterion-fetch-requests-v1',
        requests: [{ artifactId: fetchArtifactId, urls: sources.map(source => source.url) }],
      }),
      'attention-http-outcomes': JSON.stringify({ outcomes: [{ artifactId: fetchArtifactId, status: 200 }] }),
      [fetchArtifactId]: fetchRaw,
    },
    sourceBindings: sources.map((source, resultIndex) => ({
      sourceId: source.id, producerArtifactId: fetchArtifactId, resultIndex,
      requestedUrl: source.url, transform: 'IDENTITY' as const,
    })),
    queries: [`"${TARGET.address}"`, 'Synthetic Cedar alternative'],
    complete: true,
    codes: [],
    start: START,
    end: END,
    comparisonSourceIds: ['comparison-page'],
    comparisonAcquisition: { originalComplete: comparisonStatus < 300, searchSucceeded: comparisonStatus < 300, descriptorComplete: true, leadCount: 0, leads: [] },
  };
  read.narrativeContentScope = buildNarrativeContentScope(read, TARGET);
  return read;
}

function inputFixture(
  read = readFixture(),
  requiredIds: CriterionId[] = ['NAR-01', 'CAN-01', 'ATT-01', 'ADV-03'],
): CriterionInput {
  return buildCriterionInput(read, TARGET, END, requiredIds, POLICY);
}

function span(input: CriterionInput, sourceId: string, includes?: string) {
  const found = input.catalog.find(item => item.sourceId === sourceId && (includes === undefined || item.text.includes(includes)));
  assert.ok(found, `expected a retained span for ${sourceId}${includes ? ` containing ${includes}` : ''}`);
  return found;
}

function hasIssue(issues: CriterionIssue[] | undefined, expected: string): boolean {
  return !!issues?.some(issue => issue.path === expected || issue.path.startsWith(`${expected}.`) || issue.code === expected);
}

function rowFor(
  input: CriterionInput,
  criterionId: CriterionId,
  overrides: Partial<Omit<CriterionWireRow, 'criterionId'>> & {
    proof?: Partial<Pick<CriterionProof, 'premises' | 'representationWitnesses' | 'posts' | 'missingSupport'>>;
  } = {},
): CriterionWireRow {
  const storyRef = span(input, 'narrative-page').id;
  const mintRef = span(input, 'mint-proof-page', TARGET.address).id;
  const genericRef = storyRef;
  const premises: CriterionProof['premises'] = criterionId === 'NAR-01'
    ? [
      { kind: 'referent', assertion: 'The retained narrative names the project.', citationIds: [storyRef] },
      { kind: 'interest', assertion: 'The retained narrative explains why readers care.', citationIds: [storyRef] },
      { kind: 'tokenRelation', assertion: 'The original record states the exact target mint.', citationIds: [mintRef] },
      { kind: 'game', assertion: 'The retained narrative explains its game and players.', citationIds: [storyRef] },
    ]
    : [{ kind: 'boundedReview', assertion: 'The retained source supports this bounded judgment.', citationIds: [genericRef] }];
  const representationWitnesses = criterionId === 'NAR-01'
      ? [{ token: input.token, narrativeCitationIds: [storyRef], mintCitationIds: [mintRef] }]
      : [];
  const posts: CriterionProof['posts'] = [];
  const missingSupport: string[] = [];
  const { proof: proofOverrides, ...rowOverrides } = overrides;
  const wirePremises = proofOverrides?.premises ?? rowOverrides.premises ?? premises;
  const wireWitnesses = proofOverrides?.representationWitnesses ?? rowOverrides.representationWitnesses ?? representationWitnesses;
  const wirePosts = proofOverrides?.posts ?? rowOverrides.posts ?? posts;
  const wireMissingSupport = proofOverrides?.missingSupport ?? rowOverrides.missingSupport ?? missingSupport;
  const citations = [...new Set([
    ...wirePremises.flatMap(premise => premise.citationIds),
    ...wireWitnesses.flatMap(witness => [...witness.narrativeCitationIds, ...witness.mintCitationIds]),
    ...wirePosts.flatMap(post => post.citationIds),
  ])];
  return {
    criterionId,
    disposition: 'SUPPORTED',
    rationale: 'The final judgment uses only the declared evidence scope.',
    citationIds: rowOverrides.citationIds ?? citations,
    premises: wirePremises,
    representationWitnesses: wireWitnesses,
    posts: wirePosts,
    missingSupport: wireMissingSupport,
    unfinishedReason: null,
    ...rowOverrides,
  };
}

function comparisonRow(input: CriterionInput, witnesses = true, alternativeMint = ALTERNATIVE): CriterionWireRow {
  const targetStory = span(input, 'narrative-page').id;
  const targetMint = span(input, 'mint-proof-page', TARGET.address).id;
  const alternativePage = span(input, 'comparison-page');
  const rows = [
    { token: TARGET, narrativeCitationIds: [targetStory], mintCitationIds: [targetMint] },
    { token: alternativeMint, narrativeCitationIds: [alternativePage.id], mintCitationIds: [alternativePage.id] },
  ];
  const premises: CriterionWireRow['premises'] = [{ kind: 'representation', assertion: 'Each representation has its own narrative and literal mint record.', citationIds: [targetStory, targetMint, alternativePage.id] }];
  return {
    criterionId: 'CAN-01', disposition: 'SUPPORTED',
    rationale: 'Each representation has an acquired narrative and exact mint witness.',
    citationIds: [targetStory, targetMint, alternativePage.id], premises,
    representationWitnesses: witnesses ? rows : rows.slice(0, 1), posts: [], missingSupport: [], unfinishedReason: null,
  };
}

function postSource(id: string, index: number, author: string, date: string, text?: string): AttentionSource {
  return {
    id,
    url: `https://x.com/${author}/status/${index + 100}`,
    text: text ?? `Original Cedar community post ${index} identifies ${TARGET.address} and reports a distinct project update.`,
    publishedAt: date,
    authorId: `x.com:${author}`,
    availableAt: END,
    kind: 'POST',
  };
}

function postReview(input: CriterionInput, source: AttentionSource, overrides: Partial<CriterionProof['posts'][number]> = {}): CriterionProof['posts'][number] {
  return {
    sourceId: source.id,
    role: 'CALL',
    original: true,
    tokenBound: true,
    duplicateOf: null,
    citationIds: [span(input, source.id).id],
    ...overrides,
  };
}

function qualifiedPosts(count: number): AttentionSource[] {
  const authors = ['alice', 'basil', 'cedar'];
  const previousCount = Math.floor(count / 2);
  return Array.from({ length: count }, (_, index) => {
    const previous = index < previousCount;
    const hour = (index % 8) + 1;
    const date = previous
      ? `2026-10-01T${String(hour).padStart(2, '0')}:00:00.000Z`
      : `2026-10-02T${String(hour).padStart(2, '0')}:00:00.000Z`;
    return postSource(`post-${index + 1}`, index, authors[index % authors.length]!, date);
  });
}

function receipt(input: CriterionInput, results: Array<CriterionResult | CriterionWireRow>): CriterionReceipt {
  const wireRows = results.filter((row): row is CriterionWireRow => 'disposition' in row);
  const suppliedResults = new Map(results.filter((row): row is CriterionResult => !('disposition' in row)).map(row => [row.criterionId, row]));
  const decoded = decodeCriterionBatch({ rows: wireRows }, input);
  const finalized = finalizeCriterionResults(input, decoded).map(row => suppliedResults.get(row.criterionId) ?? row);
  return {
    method: criterionReviewMethod,
    token: input.token,
    policyId: input.policyId,
    inputId: input.inputId,
    qualifiedAt: END,
    results: finalized,
  };
}

test('criterion input catalogs exact retained bytes, including newlines, and binds them into its scope hash', () => {
  const body = 'The story has a first paragraph.\nThe second paragraph retains its exact line break and wording.';
  const read = readFixture({ newlineBody: body });
  const input = inputFixture(read);
  const sourceSpans = input.catalog.filter(item => item.sourceId === 'narrative-page');

  assert.equal(sourceSpans.map(item => item.text).join(''), body);
  for (const item of sourceSpans) {
    assert.equal(item.text, read.sources.find(source => source.id === item.sourceId)!.text.slice(item.start, item.end));
  }
  assert.match(sourceSpans.map(item => item.text).join(''), /paragraph\.\nThe second/);
  assert.match(sourceSpans[0]!.id, /^c\d{4}$/);

  const changedBytes = inputFixture(readFixture({ newlineBody: body.replace('\n', '\r\n') }));
  assert.notEqual(changedBytes.scopeId, input.scopeId, 'line-ending changes alter the source-bound scope');
  assert.notEqual(changedBytes.inputId, input.inputId);
});

test('decoder rejects forged and out-of-scope citation selectors while scope hashes bind changed inputs', () => {
  const input = inputFixture(readFixture(), ['NAR-01', 'NAR-02']);
  const valid = rowFor(input, 'NAR-01');
  const schema = criterionWireSchema(input);
  assert.equal(schema.safeParse({ rows: [valid] }).success, true);

  const forged = rowFor(input, 'NAR-02');
  forged.citationIds = ['c9999'];
  forged.premises[0]!.citationIds = ['c9999'];
  const forgedBatch = decodeCriterionBatch({ rows: [valid, forged] }, input);
  assert.ok(forgedBatch.rows['NAR-01'], 'one valid final remains independently salvageable');
  assert.ok(hasIssue(forgedBatch.invalid['NAR-02'], 'citationIds'));

  const otherInput = inputFixture(readFixture({ newlineBody: 'A different complete source body changes the frozen scope.' }));
  assert.notEqual(otherInput.scopeId, input.scopeId, 'the source change receives a separate frozen scope');
  assert.notEqual(otherInput.inputId, input.inputId, 'the source change receives a separate input hash');

  const outOfScope = rowFor(input, 'NAR-01');
  const comparisonRef = span(input, 'comparison-page').id;
  outOfScope.citationIds.push(comparisonRef);
  outOfScope.premises[0]!.citationIds.push(comparisonRef);
  const scopedBatch = decodeCriterionBatch({ rows: [outOfScope] }, input);
  assert.ok(hasIssue(scopedBatch.invalid['NAR-01'], 'proof.suppliedSourceIds'));
});

test('invalid, duplicate, and missing sibling rows do not erase an accepted final; corrections cannot replace it', () => {
  const input = inputFixture(readFixture(), ['NAR-01', 'NAR-02', 'NAR-03']);
  const accepted = rowFor(input, 'NAR-01');
  const invalid = rowFor(input, 'NAR-02', { citationIds: ['c9999'] });
  invalid.premises[0]!.citationIds = ['c9999'];
  const initial = decodeCriterionBatch({ rows: [accepted, invalid] }, input);

  assert.equal(initial.rows['NAR-01']?.basis, 'RULE_SATISFIED', 'basis is derived from wire disposition rather than accepted from model text');
  assert.ok(hasIssue(initial.invalid['NAR-02'], 'citationIds'));
  assert.ok(hasIssue(initial.invalid['NAR-03'], 'CRITERION_ROW_MISSING'));
  const duplicates = decodeCriterionBatch({ rows: [accepted, rowFor(input, 'NAR-02'), rowFor(input, 'NAR-02')] }, input);
  assert.ok(duplicates.rows['NAR-01'], 'an invalid sibling group does not erase an accepted final');
  assert.ok(hasIssue(duplicates.invalid['NAR-02'], 'CRITERION_ROW_DUPLICATE'));

  const replacement = rowFor(input, 'NAR-01', { rationale: 'A correction attempted to replace the already accepted final.' });
  const repairedNAR02 = rowFor(input, 'NAR-02', {
    disposition: 'INSUFFICIENT', rationale: 'The invalid sibling received one valid correction.',
    proof: { missingSupport: ['An attributed origin is not established by this bounded source sample.'] },
  });
  const repairedNAR03 = rowFor(input, 'NAR-03', {
    disposition: 'INSUFFICIENT', rationale: 'The missing sibling received one valid correction.',
    proof: { missingSupport: ['A falsifiable thesis explanation is not established by this bounded source sample.'] },
  });
  const correction = decodeCriterionBatch({ rows: [replacement, repairedNAR02, repairedNAR03] }, input);
  const final = finalizeCriterionResults(input, initial, correction);

  assert.deepEqual(final.map(row => row.criterionId), ['NAR-01', 'NAR-02', 'NAR-03']);
  assert.equal(final[0]!.rationale, accepted.rationale, 'the initial accepted final wins over a later replacement');
  assert.equal(final[1]!.rationale, repairedNAR02.rationale);
  assert.equal(final[2]!.rationale, repairedNAR03.rationale);
});

test('identity-only metadata cannot be used as a positive narrative premise; real body and mint spans remain usable', () => {
  const input = inputFixture();
  const identity = span(input, 'identity-metadata', TARGET.address).id;
  const story = span(input, 'narrative-page').id;
  const mint = span(input, 'mint-proof-page', TARGET.address).id;

  assert.ok(input.identityOnlySourceIds.includes('identity-metadata'));
  assert.ok(input.narrativeSourceIds.includes('narrative-page'));
  assert.ok(!input.narrativeSourceIds.includes('identity-metadata'));

  const invalidIdentityPremise = rowFor(input, 'NAR-01', {
    citationIds: [story, mint, identity],
    proof: {
      premises: [
        { kind: 'referent', assertion: 'The linked page names Synthetic Cedar.', citationIds: [story] },
        { kind: 'interest', assertion: 'The project offers local stories.', citationIds: [story] },
        { kind: 'tokenRelation', assertion: 'Identity JSON contains the token address.', citationIds: [identity] },
        { kind: 'game', assertion: 'Identity JSON is being treated as the project game.', citationIds: [identity] },
      ],
    },
  });
  const rejected = decodeCriterionBatch({ rows: [invalidIdentityPremise] }, input);
  assert.ok(hasIssue(rejected.invalid['NAR-01'], 'proof.narrativeEligibility'));

  const valid = rowFor(input, 'NAR-01');
  const accepted = decodeCriterionBatch({ rows: [valid] }, input);
  assert.ok(accepted.rows['NAR-01'], 'eligible story text and an exact literal mint citation support the target relation');
  assert.ok(valid.representationWitnesses[0]!.narrativeCitationIds.includes(story));
  assert.ok(valid.representationWitnesses[0]!.mintCitationIds.includes(mint));

  const wrongTokenWitness = rowFor(input, 'NAR-01', {
    proof: { representationWitnesses: [{ token: ALTERNATIVE, narrativeCitationIds: [story], mintCitationIds: [mint] }] },
  });
  const wrongToken = decodeCriterionBatch({ rows: [wrongTokenWitness] }, input);
  assert.ok(hasIssue(wrongToken.invalid['NAR-01'], 'proof.representationWitnesses'));
});

test('CAN-01 needs a separate narrative and literal mint witness for each representation', () => {
  const input = inputFixture();
  const valid = comparisonRow(input);
  const accepted = decodeCriterionBatch({ rows: [valid] }, input);
  assert.ok(accepted.rows['CAN-01']);

  const missingAlternativeWitness = comparisonRow(input, false);
  const rejected = decodeCriterionBatch({ rows: [missingAlternativeWitness] }, input);
  assert.ok(hasIssue(rejected.invalid['CAN-01'], 'proof.representationWitnesses'));

  const wrongMint = comparisonRow(input, true, { chain: ALTERNATIVE.chain, address: `0x${'c'.repeat(40)}` });
  const forged = decodeCriterionBatch({ rows: [wrongMint] }, input);
  assert.ok(hasIssue(forged.invalid['CAN-01'], 'proof.representationWitnesses'));
});

test('criterion citations retain more than five source-owned selectors and still reject a forged selector', () => {
  const longNarrative = 'The Synthetic Cedar community shares local stories and art. Its neighborhood game welcomes players. '.repeat(90);
  const input = inputFixture(readFixture({ newlineBody: longNarrative }), ['NAR-01']);
  const narrativeIds = input.catalog.filter(item => item.sourceId === 'narrative-page').map(item => item.id);
  assert.ok(narrativeIds.length > 5, 'the fixture supplies enough exact source spans to exercise the expanded citation limit');

  const row = rowFor(input, 'NAR-01');
  row.citationIds = [...new Set([...row.citationIds, ...narrativeIds])];
  assert.ok(row.citationIds.length > 5);
  assert.ok(decodeCriterionBatch({ rows: [row] }, input).rows['NAR-01'], 'multiple legitimate citations remain representable');

  const forged = structuredClone(row);
  forged.citationIds[forged.citationIds.length - 1] = 'c9999';
  assert.ok(hasIssue(decodeCriterionBatch({ rows: [forged] }, input).invalid['NAR-01'], 'citationIds'),
    'the wider list remains catalog-bounded rather than accepting a forged extra selector');
});

test('CAN-01 prompt distinguishes original acquisition from an accounted scope and keeps unsupported no-alternative claims invalid', () => {
  const unresolvedRead = readFixture();
  const lead = {
    id: 'unresolved-lead-1', searchArtifactId: 'attention-search-comparison', resultIndex: 0,
    url: 'https://public.example/unresolved-representation', title: 'Unresolved Cedar representation',
    snippet: 'A relevant-looking comparison lead was not acquired.', metadataEvidenceId: 'unresolved-lead-1-metadata',
    sourceIds: [], acquisitionStatus: 'FAILED' as const, acquisitionCodes: ['ATT_FETCH_TIMEOUT'],
    recoveryQueryIds: ['attention-recovery-search-1'], recoverySourceIds: [],
  };
  unresolvedRead.comparisonAcquisition = {
    ...unresolvedRead.comparisonAcquisition!, originalComplete: true, searchSucceeded: true,
    descriptorComplete: true, leadCount: 1, leads: [lead],
  };
  unresolvedRead.comparisonRecovery = {
    method: 'comparison-acquisition-v1', selectedLeadIds: [lead.id],
    recoveryQueries: [{ queryId: 'attention-recovery-search-1', parentLeadId: lead.id,
      query: '"Unresolved Cedar representation" crypto token', state: 'NO_RESULTS',
      descriptorComplete: true, resultCount: 0, availableAt: END }],
    recoveryCapped: false, sourceLineage: [{ leadId: lead.id, queryIds: ['attention-recovery-search-1'], sourceIds: [] }],
  };
  const input = inputFixture(unresolvedRead, ['CAN-01']);
  assert.equal(input.criterionScopes['CAN-01'].complete, true, 'the bounded operation and lead-accounting receipt is complete');
  const packet = JSON.parse(criterionReviewPacket(input, 'final')) as {
    input: { acquisition: { comparison: { originalComplete: boolean }; comparisonEligibility: { noRelevantAlternativeEligible: boolean; unresolvedLeads: Array<{ id: string; status: string }> } } };
  };
  assert.equal(packet.input.acquisition.comparison.originalComplete, true);
  assert.equal(packet.input.acquisition.comparisonEligibility.noRelevantAlternativeEligible, false);
  assert.deepEqual(packet.input.acquisition.comparisonEligibility.unresolvedLeads, [{ id: lead.id, status: 'FAILED' }]);

  const unsupportedNoAlternative = comparisonRow(input, false);
  unsupportedNoAlternative.premises.push({
    kind: 'noRelevantAlternative',
    assertion: 'No other relevant representation exists.',
    citationIds: [span(input, 'comparison-page').id],
  });
  const rejected = decodeCriterionBatch({ rows: [unsupportedNoAlternative] }, input);
  assert.ok(hasIssue(rejected.invalid['CAN-01'], 'proof.comparisonScope'));

  const insufficient = rowFor(input, 'CAN-01', {
    disposition: 'INSUFFICIENT',
    rationale: 'The completed bounded comparison still contains an unresolved relevant lead.',
    proof: { missingSupport: ['A relevant-looking lead was not acquired and cannot establish its representation.'] },
  });
  const accepted = decodeCriterionBatch({ rows: [insufficient] }, input);
  assert.ok(accepted.rows['CAN-01'], 'a completed review may report insufficient support without claiming no alternative');

  const accountedRead = readFixture();
  accountedRead.comparisonAcquisition = {
    ...accountedRead.comparisonAcquisition!, originalComplete: false, searchSucceeded: true,
    descriptorComplete: true, leadCount: 0, leads: [],
  };
  accountedRead.comparisonRecovery = {
    method: 'comparison-acquisition-v1', selectedLeadIds: [], recoveryQueries: [],
    recoveryCapped: false, sourceLineage: [],
  };
  const accountedInput = inputFixture(accountedRead, ['CAN-01']);
  assert.equal(criterionComparisonEligibility(accountedInput).noRelevantAlternativeEligible, true,
    'a complete recovered and accounted scope can qualify even when the original acquisition flag is false');
});

test('a failed comparison operation blocks CAN rows without poisoning an independently completed NAR-01', () => {
  const input = inputFixture(readFixture({ comparisonStatus: 503 }), ['NAR-01', 'CAN-01']);
  assert.equal(input.criterionScopes['NAR-01'].complete, true);
  assert.equal(input.criterionScopes['CAN-01'].complete, false, JSON.stringify(input.criterionScopes['CAN-01']));
  assert.ok(input.criterionScopes['CAN-01'].failures.includes('ATT_SEARCH_HTTP_503'));

  const batch = decodeCriterionBatch({ rows: [rowFor(input, 'NAR-01'), comparisonRow(input)] }, input);
  assert.ok(batch.rows['NAR-01']);
  assert.equal(batch.rows['CAN-01'], undefined, 'the model row is not decoded for a code-incomplete comparison scope');
  assert.equal(batch.invalid['CAN-01'], undefined, 'an unavailable scope is not misreported as a malformed model row');
  const canResult = finalizeCriterionResults(input, batch).find(row => row.criterionId === 'CAN-01');
  assert.equal(canResult?.evaluationState, 'UNAVAILABLE');
  assert.equal(canResult?.failure?.code, 'ATT_SEARCH_HTTP_503', 'the result preserves the actual collection failure');
});

test('CAN-02 primary relationship review completes independently of failed CAN-01 comparison acquisition', () => {
  const input = inputFixture(readFixture({ comparisonStatus: 503 }), ['CAN-01', 'CAN-02']);
  assert.equal(input.criterionScopes['CAN-01'].complete, false, JSON.stringify(input.criterionScopes['CAN-01']));
  assert.ok(input.criterionScopes['CAN-02'].complete, JSON.stringify(input.criterionScopes['CAN-02']));
  assert.ok(!input.criterionScopes['CAN-02'].sourceIds.includes('comparison-page'),
    'the primary relationship scope excludes comparison-only sources');
  assert.ok(input.primaryLeadershipCitationIds.length > 0, 'the fixture exposes a structurally eligible primary relationship source');

  const primaryRef = input.primaryLeadershipCitationIds[0]!;
  const primarySourceId = input.catalog.find(item => item.id === primaryRef)!.sourceId;
  const primaryRow = rowFor(input, 'CAN-02', {
    citationIds: [primaryRef],
    proof: {
      premises: [{ kind: 'primaryRelationship', assertion: 'The retained primary project page expressly links this exact token to its project.', citationIds: [primaryRef] }],
    },
  });
  assert.ok(input.criterionScopes['CAN-02'].sourceIds.includes(primarySourceId));
  assert.ok(decodeCriterionBatch({ rows: [primaryRow] }, input).rows['CAN-02'],
    'an independently reviewed primary relationship can support CAN-02 without comparison completion');

  const packet = JSON.parse(criterionReviewPacket(input, 'final')) as { requiredProof: string; input: { criterionScopes: Record<string, { sourceIds: string[]; complete: boolean }> } };
  assert.match(packet.requiredProof, /CAN-02 inspect the primary relationship independently of comparison/);
  assert.equal(packet.input.criterionScopes['CAN-02']?.complete, true);
});

test('native Firecrawl recovery can prove a discovered official primary page only from its retained native result', () => {
  const read = readFixture();
  read.criterionReviewMethod = 'criterion-review-v1';
  const url = 'https://official.example/synthetic-cedar';
  const body = `Official project context identifies ${TARGET.address} as the token for the Synthetic Cedar community.`;
  const official = page('firecrawl-official-page', url, body);
  read.sources.push(official);
  read.discoveryUrls = [...(read.discoveryUrls ?? []), url];
  read.sourceBindings!.push({
    sourceId: official.id, producerArtifactId: 'firecrawl-scrape-1', resultIndex: 0,
    requestedUrl: url, transform: 'IDENTITY',
  });
  const manifest = JSON.parse(read.rawArtifacts['criterion-fetch-requests']!) as { requests: Array<{ artifactId: string; urls: string[] }> };
  manifest.requests[0]!.urls.push(url);
  read.rawArtifacts['criterion-fetch-requests'] = JSON.stringify(manifest);
  const fetch = JSON.parse(read.rawArtifacts['attention-fetch-1']!) as { results: Array<{ url: string }>; errors: unknown[] };
  fetch.errors.push({ url, status: 404, error: 'not found' });
  read.rawArtifacts['attention-fetch-1'] = JSON.stringify(fetch);
  read.rawArtifacts['firecrawl-scrape-1'] = JSON.stringify({
    success: true, data: { markdown: body, metadata: { statusCode: 200, url, sourceURL: url } },
  });
  read.rawArtifacts['firecrawl-scrape-1-request'] = JSON.stringify({
    method: 'firecrawl-native-operation-v1',
    request: { operation: 'SCRAPE', url, at: END }, status: 'OBSERVED', httpStatus: 200,
  });

  const input = inputFixture(read, ['CAN-02']);
  assert.ok(criterionFirecrawlProjection(read).pages.some(item => item.sourceId === official.id && item.text === body),
    'the native producer response reconstructs the full official source');
  const primaryRef = input.primaryLeadershipCitationIds.find(id => input.catalog.find(item => item.id === id)?.sourceId === official.id);
  assert.ok(primaryRef, 'the recovered official page is eligible as an independent primary relationship source');
  const accepted = rowFor(input, 'CAN-02', {
    citationIds: [primaryRef],
    proof: { premises: [{ kind: 'primaryRelationship', assertion: 'The recovered official project page identifies this exact token.', citationIds: [primaryRef] }] },
  });
  assert.ok(decodeCriterionBatch({ rows: [accepted] }, input).rows['CAN-02']);

  const tamperedRead = structuredClone(read);
  const response = JSON.parse(tamperedRead.rawArtifacts['firecrawl-scrape-1']!) as { data: { markdown: string } };
  response.data.markdown += '\nSelf-rehashed content added outside the official source.';
  tamperedRead.rawArtifacts['firecrawl-scrape-1'] = JSON.stringify(response);
  assert.equal(criterionFirecrawlProjection(tamperedRead).pages.some(item => item.sourceId === official.id), false,
    'the source ceases to be primary-eligible when the native producer bytes no longer match');
  const tamperedInput = inputFixture(tamperedRead, ['CAN-02']);
  assert.equal(tamperedInput.primaryLeadershipCitationIds.some(id => tamperedInput.catalog.find(item => item.id === id)?.sourceId === official.id), false);
  assert.equal(tamperedInput.criterionScopes['CAN-02']?.complete, false,
    'a source whose retained native producer no longer matches is outside a complete CAN-02 review scope');
  const forged = rowFor(tamperedInput, 'CAN-02', {
    citationIds: [primaryRef],
    proof: { premises: [{ kind: 'primaryRelationship', assertion: 'The altered native body is still claimed as official support.', citationIds: [primaryRef] }] },
  });
  const rejected = decodeCriterionBatch({ rows: [forged] }, tamperedInput);
  assert.equal(rejected.rows['CAN-02'], undefined,
    'an altered native Firecrawl body cannot preserve the primary-support route');
  const unavailable = finalizeCriterionResults(tamperedInput, rejected).find(row => row.criterionId === 'CAN-02');
  assert.equal(unavailable?.evaluationState, 'UNAVAILABLE');
  assert.equal(unavailable?.failure?.category, 'COLLECTION');
  assert.ok(unavailable?.failure?.validationPaths.includes('CRITERION_SOURCE_SCOPE_CLIPPED_OR_UNBOUND'),
    'the tampered native result becomes an explicit acquisition gap, not a model proof or negative finding');
});

test('post measurements count distinct source bodies and derive author/date totals from retained metadata', () => {
  const unique = qualifiedPosts(10);
  const duplicate = postSource('post-copy', 99, 'fourth-author', '2026-10-02T11:00:00.000Z', unique[0]!.text);
  const old = postSource('post-before-window', 100, 'old-author', '2026-09-30T23:59:59.000Z');
  const input = inputFixture(readFixture({ posts: [...unique, duplicate, old] }), ['ATT-01', 'ADV-03']);
  const proofPosts = [...unique, duplicate, old].map(source => postReview(input, source));
  const measured = measureCriterionPosts(input, proofPosts);

  assert.deepEqual(measured, {
    upperBound: true,
    qualifiedSourceIds: unique.map(source => source.id),
    posts: 10,
    authors: 3,
    previous: 5,
    current: 5,
    complete: true,
    issues: [],
  });
  const attRow = rowFor(input, 'ATT-01', { proof: { posts: proofPosts } });
  assert.ok(decodeCriterionBatch({ rows: [attRow] }, input).rows['ATT-01'], 'ATT-01 reaches its existing 10-post/3-author threshold');

  const three = qualifiedPosts(3);
  const inputThree = inputFixture(readFixture({ posts: three }), ['ADV-03']);
  const threeProof = three.map(source => postReview(inputThree, source));
  const threeMeasured = measureCriterionPosts(inputThree, threeProof);
  assert.equal(threeMeasured.posts, 3);
  assert.equal(threeMeasured.authors, 3);
  const advRow = rowFor(inputThree, 'ADV-03', { proof: { posts: threeProof } });
  assert.ok(decodeCriterionBatch({ rows: [advRow] }, inputThree).rows['ADV-03'], 'ADV-03 reaches its existing 3-post/3-author threshold');
});

test('below-threshold or unresolved posts cannot be turned into positive measurements', () => {
  const nine = qualifiedPosts(9);
  const input = inputFixture(readFixture({ posts: nine }), ['ATT-01']);
  const proofPosts = nine.map(source => postReview(input, source));
  const measured = measureCriterionPosts(input, proofPosts);
  assert.equal(measured.posts, 9);
  assert.equal(measured.authors, 3);
  const row = rowFor(input, 'ATT-01', { proof: { posts: proofPosts } });
  const rejected = decodeCriterionBatch({ rows: [row] }, input);
  assert.ok(hasIssue(rejected.invalid['ATT-01'], 'proof.posts.threshold'));

  const unresolved = postSource('post-undated', 200, 'unknown-author', '2026-10-02T10:00:00.000Z');
  unresolved.publishedAt = null;
  unresolved.authorId = null;
  const inputWithUnknown = inputFixture(readFixture({ posts: [...nine, unresolved] }), ['ATT-01']);
  const allProof = [...nine, unresolved].map(source => postReview(inputWithUnknown, source));
  const incomplete = measureCriterionPosts(inputWithUnknown, allProof);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.issues.includes('POST_UNRESOLVED'));
  assert.equal(incomplete.posts, 9, 'unknown author/date remains unresolved rather than a zero or a counted post');
  const incompleteRow = rowFor(inputWithUnknown, 'ATT-01', { proof: { posts: allProof } });
  assert.ok(hasIssue(decodeCriterionBatch({ rows: [incompleteRow] }, inputWithUnknown).invalid['ATT-01'], 'proof.posts.threshold'));

  for (const scenario of [
    { label: 'known ten-post lower bound', known: 10, accepted: true },
    { label: 'known nine-post lower bound', known: 9, accepted: false },
  ]) {
    const known = qualifiedPosts(scenario.known);
    const unread = postSource(`post-unresolved-extra-${scenario.known}`, 250 + scenario.known, 'unknown-author', '2026-10-02T12:30:00.000Z');
    unread.publishedAt = null;
    unread.authorId = null;
    const boundedInput = inputFixture(readFixture({ posts: [...known, unread] }), ['ATT-01']);
    const reviewed = [...known, unread].map(source => postReview(boundedInput, source));
    const candidate = rowFor(boundedInput, 'ATT-01', { proof: { posts: reviewed } });
    const result = decodeCriterionBatch({ rows: [candidate] }, boundedInput);
    if (scenario.accepted) {
      assert.ok(result.rows['ATT-01'], `${scenario.label} may stand despite an unresolved possible extra`);
      assert.equal(measureCriterionPosts(boundedInput, reviewed).complete, false, 'exact totals remain explicitly incomplete');
    } else {
      assert.ok(hasIssue(result.invalid['ATT-01'], 'proof.posts.threshold'), `${scenario.label} cannot be rounded up by an unresolved extra`);
    }
  }

  const longBody = `${'The source discusses the project without naming its mint. '.repeat(20)}\nA separate source segment names ${TARGET.address}.`;
  const splitCitationPost = postSource('post-split-citation', 300, 'split-author', '2026-10-02T12:00:00.000Z', longBody);
  const splitInput = inputFixture(readFixture({ posts: [splitCitationPost] }), ['ATT-01']);
  const firstSpanOnly = postReview(splitInput, splitCitationPost, { tokenBound: true });
  const falseBinding = measureCriterionPosts(splitInput, [firstSpanOnly]);
  assert.equal(falseBinding.complete, false);
  assert.ok(falseBinding.issues.includes('POST_BINDING_INVALID'), 'a positive tokenBound flag cannot replace a literal citeable span');
});

test('code-owned post facts and packet diagnostics preserve exclusions, exact-copy identity, and lower bounds', () => {
  const unique = qualifiedPosts(10);
  const copy = postSource('post-exact-copy', 401, 'copy-author', '2026-10-02T12:00:00.000Z', unique[0]!.text);
  const old = postSource('post-old-window', 402, 'old-author', '2026-09-30T23:59:00.000Z');
  const noMint = postSource('post-no-mint', 403, 'no-mint-author', '2026-10-02T13:00:00.000Z',
    'The Cedar account discusses its community without naming a token address.');
  const quoted = postSource('post-quoted', 404, 'quoted-author', '2026-10-02T14:00:00.000Z',
    `Quoted text from another account: “${unique[1]!.text}”`);
  const forgedDuplicate = postSource('post-forged-duplicate', 405, 'forged-author', '2026-10-02T15:00:00.000Z');
  const unknown = postSource('post-unknown-metadata', 406, 'temporary-author', '2026-10-02T16:00:00.000Z');
  unknown.publishedAt = null;
  unknown.authorId = null;
  const unclassified = postSource('post-unclassified', 407, 'unclassified-author', '2026-10-02T17:00:00.000Z');
  const sources = [...unique, copy, old, noMint, quoted, forgedDuplicate, unknown, unclassified];
  const input = inputFixture(readFixture({ posts: sources }), ['ATT-01']);
  const facts = criterionPostFacts(input);
  const byFact = new Map(facts.map(fact => [fact.sourceId, fact]));

  assert.equal(byFact.get(copy.id)?.exactBodyHash, byFact.get(unique[0]!.id)?.exactBodyHash,
    'code identifies equal retained bodies without deciding whether either is original');
  assert.ok(byFact.get(old.id)?.exclusionReasons.includes('OUTSIDE_WINDOW'));
  assert.ok(byFact.get(noMint.id)?.exclusionReasons.includes('LITERAL_MINT_NOT_IN_CATALOG'));
  assert.equal(byFact.get(unknown.id)?.window, 'UNKNOWN');
  assert.ok(byFact.get(unknown.id)?.exclusionReasons.includes('PUBLICATION_TIME_UNKNOWN'));
  assert.ok(byFact.get(unknown.id)?.exclusionReasons.includes('AUTHOR_UNKNOWN'));
  for (const fact of facts) {
    assert.equal('original' in fact, false, 'static facts do not decide semantic originality');
    assert.equal('role' in fact, false, 'static facts do not decide post meaning');
    assert.equal('duplicateOf' in fact, false, 'duplicate classification remains part of the actual review');
  }

  const classifications = [
    ...unique.map(source => postReview(input, source)),
    postReview(input, copy, { duplicateOf: unique[0]!.id }),
    postReview(input, old),
    postReview(input, noMint, { original: true, tokenBound: false }),
    postReview(input, quoted, { original: false, tokenBound: true }),
    postReview(input, forgedDuplicate, { duplicateOf: 'post-does-not-exist' }),
    postReview(input, unknown),
    // The final offered source is deliberately left unclassified.
  ];
  const candidate = rowFor(input, 'ATT-01', { proof: { posts: classifications } });
  const decoded = decodeCriterionBatch({ rows: [candidate] }, input);
  assert.ok(decoded.rows['ATT-01'], 'ten qualified posts from three distinct authors remain a valid lower bound');

  const packet = JSON.parse(criterionReviewPacket(input, 'final', { value: { rows: [candidate] } })) as {
    postFacts: Array<{ sourceId: string; exactBodyHash: string }>;
    diagnostics: { rows: Record<string, { accepted: boolean; outcomeCompatibility: boolean; measurement: { posts: number; authors: number; previous: number; current: number; complete: boolean }; missingSourceIds: string[]; perSource: Array<{ sourceId: string; reasons: string[] }> }> };
  };
  assert.deepEqual(packet.postFacts, facts, 'final review receives the same deterministic source facts as the criterion input');
  const diagnostic = packet.diagnostics.rows['ATT-01']!;
  assert.equal(diagnostic.accepted, true);
  assert.equal(diagnostic.outcomeCompatibility, true);
  assert.deepEqual(
    [diagnostic.measurement.posts, diagnostic.measurement.authors, diagnostic.measurement.previous, diagnostic.measurement.current],
    [10, 3, 5, 5],
    'counts and interval bins come from distinct code-qualified source bodies and authors, not model-supplied totals',
  );
  assert.equal(diagnostic.measurement.complete, false, 'the unresolved offered post prevents an exact-total claim');
  assert.deepEqual(diagnostic.missingSourceIds, [unclassified.id]);
  const reasons = new Map(diagnostic.perSource.map(item => [item.sourceId, item.reasons]));
  assert.ok(reasons.get(old.id)?.includes('OUTSIDE_WINDOW'));
  assert.ok(reasons.get(noMint.id)?.includes('LITERAL_MINT_NOT_IN_CATALOG'));
  assert.ok(reasons.get(quoted.id)?.includes('NOT_CLASSIFIED_ORIGINAL'));
  assert.ok(reasons.get(forgedDuplicate.id)?.includes('DUPLICATE_REFERENCE_INVALID'));
  assert.ok(reasons.get(unclassified.id)?.includes('CLASSIFICATION_MISSING'));

  const nine = qualifiedPosts(9);
  const unresolved = postSource('post-unclassified-correction', 408, 'unclassified-correction', '2026-10-02T17:30:00.000Z');
  const correctionInput = inputFixture(readFixture({ posts: [...nine, unresolved] }), ['NAR-01', 'ATT-01']);
  const narrative = rowFor(correctionInput, 'NAR-01');
  const belowThreshold = rowFor(correctionInput, 'ATT-01', { proof: { posts: nine.map(source => postReview(correctionInput, source)) } });
  const prior = decodeCriterionBatch({ rows: [narrative, belowThreshold] }, correctionInput);
  assert.ok(prior.rows['NAR-01']);
  assert.ok(hasIssue(prior.invalid['ATT-01'], 'proof.posts.threshold'));
  const rawFinal = JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ rows: [narrative, belowThreshold] }) }] } }] });
  const correction = JSON.parse(criterionReviewPacket(correctionInput, 'correction', undefined, prior, rawFinal)) as {
    accepted: string[];
    unresolved: Record<string, CriterionIssue[]>;
    diagnostics: { rows: Record<string, { outcomeCompatibility: boolean; measurement: { posts: number; complete: boolean }; missingSourceIds: string[] }> };
  };
  assert.deepEqual(correction.accepted, ['NAR-01'], 'correction leaves the accepted narrative sibling frozen');
  assert.deepEqual(correction.unresolved['ATT-01']?.map(issue => issue.path), ['proof.posts.threshold']);
  assert.equal(correction.diagnostics.rows['ATT-01']?.measurement.posts, 9);
  assert.equal(correction.diagnostics.rows['ATT-01']?.measurement.complete, false);
  assert.equal(correction.diagnostics.rows['ATT-01']?.outcomeCompatibility, false);
  assert.deepEqual(correction.diagnostics.rows['ATT-01']?.missingSourceIds, [unresolved.id]);
});

test('ADV-03 resolution depends on NAR-01; unavailable narrative review cannot become a shortlist pass', () => {
  const input = inputFixture(readFixture({ posts: qualifiedPosts(3) }), ['NAR-01', 'ADV-03']);
  const posts = input.sources.filter(source => source.kind === 'POST').map(source => postReview(input, source));
  const adv = rowFor(input, 'ADV-03', { proof: { posts } });
  const nar = rowFor(input, 'NAR-01');
  const narResult = decodeCriterionBatch({ rows: [nar] }, input).rows['NAR-01']!;
  const supported = receipt(input, [nar, adv]);
  assert.equal(resolveCriterion(supported, 'ADV-03', END), 'PASS');

  const unavailableNarrative: CriterionResult = {
    ...narResult, evaluationState: 'UNAVAILABLE', outcome: null, basis: 'EVALUATION_INCOMPLETE', rationale: 'The narrative final was unavailable.',
    citationIds: [], proof: { ...narResult.proof, reviewAttested: false },
    failure: { category: 'MODEL', code: 'CRITERION_FINAL_INVALID', validationPaths: ['criterionId'] },
  };
  assert.equal(resolveCriterion(receipt(input, [unavailableNarrative, adv]), 'ADV-03', END), 'UNKNOWN');

  const contradictedNarrative: CriterionResult = { ...narResult, outcome: 'CONTRADICTED', basis: 'FACTUAL_COUNTEREVIDENCE' };
  assert.equal(resolveCriterion(receipt(input, [contradictedNarrative, adv]), 'ADV-03', END), 'FAIL');
});

test('FAST cashtags bind posts without treating plain symbol words as token references', () => {
  const token = { chain: 'solana', address: 'So11111111111111111111111111111111111111112' } as const;
  const cashtag = postSource('post-cashtag', 201, 'alice', '2026-10-01T11:00:00.000Z',
    'The $CEDAR project announced a community update.');
  const plainWord = postSource('post-plain-symbol', 202, 'basil', '2026-10-01T12:00:00.000Z',
    'The CEDAR project announced a community update.');
  const exactMint = postSource('post-exact-mint', 203, 'cedar', '2026-10-01T13:00:00.000Z',
    `The project post names the exact token ${token.address}.`);
  const read = readFixture({ posts: [cashtag, plainWord, exactMint] });
  const field = (value: string) => {
    const text = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
  };
  const metadata = Buffer.concat([
    Buffer.from([4]), Buffer.alloc(32), new PublicKey(token.address).toBuffer(),
    field('Synthetic Cedar'), field('CEDAR'), field('https://metadata.example/token.json'),
  ]);
  read.rawArtifacts['discovery-token-metadata'] = JSON.stringify({ result: { context: { slot: 1 }, value: [null, {
    owner: MPL_TOKEN_METADATA_PROGRAM_ID.toBase58(), executable: false, lamports: 1,
    data: [metadata.toString('base64'), 'base64'],
  }] } });
  const input = buildCriterionInput(read, token, END, ['ATT-01'], 'research-fast-v3');
  const facts = new Map(criterionPostFacts(input).map(fact => [fact.sourceId, fact]));
  assert.equal(facts.get(cashtag.id)?.exclusionReasons.includes('LITERAL_MINT_NOT_IN_CATALOG'), false,
    'a symbol cashtag binds the acquired post');
  assert.ok(facts.get(plainWord.id)?.exclusionReasons.includes('LITERAL_MINT_NOT_IN_CATALOG'),
    'the unmarked symbol word does not bind a post');
  assert.ok((facts.get(exactMint.id)?.literalMintCitationIds.length ?? 0) > 0,
    'the exact mint remains a valid token reference');
});

test('ATT-02 can qualify from separately reviewed Social breadth when the measured growth branch is insufficient', () => {
  const input = inputFixture(readFixture(), ['ATT-02']);
  const insufficient = rowFor(input, 'ATT-02', {
    disposition: 'INSUFFICIENT',
    rationale: 'The retained common-query sample does not establish increasing attention.',
    proof: { missingSupport: ['The current interval does not exceed the prior interval.'] },
  });
  const social: SocialPolicyFacts = {
    version: 'social-policy-v1', method: 'social-source-review-v1', token: TARGET,
    start: START, end: END, availableAt: END, evidenceIds: ['social-community-review'],
    postCorpusObserved: false, sampleComplete: true, lineageComplete: true,
    qualifiedOriginalCount: null, accountUpperBound: null, independentGroupCount: null,
    independentCommunityCount: null,
    communityBreadthReview: {
      method: 'source-transparency-review-v1', verdict: 'SUPPORTED',
      rationale: 'The separate bounded Social review supports independent community breadth.',
      citations: [{ sourceId: 'social-community-review', quote: 'Three independent communities are documented.' }],
      missingIndicators: [],
    },
  };

  const decision = resolveCriterionDecision(receipt(input, [insufficient]), 'ATT-02', END, social, input);
  assert.equal(decision.status, 'PASS');
  assert.equal(decision.outcome, 'SUPPORTED');
  assert.equal(decision.basis, 'Qualified Social community breadth');
  assert.deepEqual(decision.evidenceIds, social.evidenceIds);
});

test('ATT-02 model packet evaluates growth alone while the resolver still applies Social OR', () => {
  const input = inputFixture(readFixture(), ['ATT-02']);
  const packet = JSON.parse(criterionReviewPacket(input, 'draft')) as {
    requiredProof: string; input: Record<string, unknown>;
  };
  assert.match(packet.requiredProof, /ATT-02 here evaluates growth only; no Social review is supplied/);
  assert.equal('social' in packet.input, false, 'the growth model receives no Social verdict to conflate with its own review');

  const insufficient = rowFor(input, 'ATT-02', {
    disposition: 'INSUFFICIENT',
    rationale: 'The retained common-query sample does not establish increasing attention.',
    proof: { missingSupport: ['The current interval does not exceed the prior interval.'] },
  });
  const social: SocialPolicyFacts = {
    version: 'social-policy-v1', method: 'social-source-review-v1', token: TARGET,
    start: START, end: END, availableAt: END, evidenceIds: ['social-community-review'],
    postCorpusObserved: false, sampleComplete: true, lineageComplete: true,
    qualifiedOriginalCount: null, accountUpperBound: null, independentGroupCount: null,
    independentCommunityCount: null,
    communityBreadthReview: {
      method: 'source-transparency-review-v1', verdict: 'SUPPORTED',
      rationale: 'The separate bounded Social review supports independent community breadth.',
      citations: [{ sourceId: 'social-community-review', quote: 'Three independent communities are documented.' }],
      missingIndicators: [],
    },
  };
  assert.equal(resolveCriterionDecision(receipt(input, [insufficient]), 'ATT-02', END, social, input).status, 'PASS',
    'the application resolver still accepts the independent Social breadth route');
});

test('sample Shared claims retain per-post judgments, reviewer gaps, and separate code measurements', () => {
  const posts = qualifiedPosts(3);
  const input = inputFixture(readFixture({ posts }), ['ADV-03']);
  const row = rowFor(input, 'ADV-03', {
    disposition: 'INSUFFICIENT',
    rationale: 'The completed sample does not establish the required original post support.',
    proof: {
      posts: posts.map((source, index) => postReview(input, source, index === 1
        ? { role: 'NEWS', original: false, tokenBound: true }
        : { role: 'CALL', original: true, tokenBound: true })),
      missingSupport: ['The second source repeats a quoted project line and does not show an original update.'],
    },
  });
  const decoded = decodeCriterionBatch({ rows: [row] }, input);
  assert.ok(decoded.rows['ADV-03']);
  const claims = criterionSharedClaims(receipt(input, [decoded.rows['ADV-03']!]), input);
  const claim = claims[0]!;
  const context = claim.criterionReviewContext as {
    missingSupport: string[];
    premises: Array<{ kind: string; assertion: string; citations: Array<{ sourceId: string; quote: string }> }>;
    measured: { posts: number; authors: number; previous: number; current: number; complete: boolean };
  };

  assert.equal(context.premises.length, posts.length);
  assert.deepEqual(context.premises.map(premise => premise.kind), posts.map(() => 'reviewedPost'));
  assert.match(context.premises[1]!.assertion, /role NEWS; original false; token-bound true; duplicate of none/);
  assert.deepEqual(context.premises.map(premise => premise.citations[0]?.sourceId), posts.map(source => source.id));
  assert.ok(context.premises[1]!.citations[0]!.quote.includes(TARGET.address), 'Shared receives the source-owned literal citation');
  assert.deepEqual(context.missingSupport, [
    'Reviewer gap assertion (unverified): The second source repeats a quoted project line and does not show an original update.',
  ]);
  assert.deepEqual(context.measured, { posts: 2, authors: 2, previous: 1, current: 1, complete: true });
  assert.match(claim.statement, /Code-qualified sample: 2 posts from 2 source authors/,
    'the consumed numerical statement is rebuilt from code-qualified posts, not model-authored counts');
  assert.doesNotMatch(context.premises.map(premise => premise.assertion).join(' '), /all posts are original/i,
    'the projection does not replace distinct row decisions with a generic blanket claim');
});

test('shared claims expand accepted citation IDs to their original exact source bytes', () => {
  const body = 'First retained paragraph.\nSecond retained paragraph with the exact target mint.';
  const input = inputFixture(readFixture({ newlineBody: body }), ['NAR-01']);
  const accepted = rowFor(input, 'NAR-01');
  const claims = criterionSharedClaims(receipt(input, [accepted]), input);

  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.id, 'criterion:NAR-01');
  assert.deepEqual(claims[0]!.citations.map(citation => citation.quote), accepted.citationIds.map(id => input.catalog.find(item => item.id === id)!.text));
  assert.ok(claims[0]!.citations.some(citation => citation.quote.includes('\n')));
});

test('single generation uses the same local row guards as reviewed final judgments', async t => {
  const cases: Array<{ name: string; make: () => { input: CriterionInput; row: CriterionWireRow; id: CriterionId } }> = [];
  const narInput = () => inputFixture(readFixture(), ['NAR-01']);
  cases.push({ name: 'wrong literal mint', make: () => {
    const input = narInput(), row = rowFor(input, 'NAR-01');
    const wrong = span(input, 'comparison-page', ALTERNATIVE.address).id;
    row.premises = row.premises.map(item => item.kind === 'tokenRelation' ? { ...item, citationIds: [wrong] } : item);
    row.citationIds = [...new Set(row.premises.flatMap(item => item.citationIds))];
    return { input, row, id: 'NAR-01' };
  } });
  cases.push({ name: 'foreign source selector', make: () => {
    const input = narInput(), row = rowFor(input, 'NAR-01');
    row.citationIds = [...row.citationIds, span(input, 'comparison-page').id];
    return { input, row, id: 'NAR-01' };
  } });
  cases.push({ name: 'identity-only narrative', make: () => {
    const input = narInput(), row = rowFor(input, 'NAR-01'), identity = span(input, 'identity-metadata').id;
    row.premises = row.premises.map(item => ({ ...item, citationIds: [identity] }));
    row.citationIds = [identity];
    return { input, row, id: 'NAR-01' };
  } });
  cases.push({ name: 'purpose-ineligible receipt citation', make: () => {
    const input = narInput();
    const projection = projectAcquisition({ group: 'PUBLIC_ENTRY', token: TARGET, availableAt: END, searches: [], targets: [], samples: [], fresh: true, aborted: false });
    const receipt = renderPurposeReceipt(projection), header = receipt.facts[0]!;
    const id = 'c9999', text = receipt.text.slice(header.start, header.end);
    input.acquisitionPurposeMethod = 'acquisition-purpose-v1';
    input.purposeProjection = projection;
    input.catalog.push({ id, sourceId: 'acquisition-attention-scope', spanId: 'receipt:header', start: header.start, end: header.end, text });
    input.criterionScopes['NAR-01']!.sourceIds.push('acquisition-attention-scope');
    const row = rowFor(input, 'NAR-01'); row.citationIds = [...row.citationIds, id];
    return { input, row, id: 'NAR-01' };
  } });
  cases.push({ name: 'out-of-window post', make: () => {
    const outside = postSource('outside-post', 401, 'outside_author', '2026-09-30T23:59:59.000Z');
    const input = inputFixture(readFixture({ posts: [outside] }), ['ADV-03']);
    return { input, row: rowFor(input, 'ADV-03', { proof: { posts: [postReview(input, outside)] } }), id: 'ADV-03' };
  } });
  cases.push({ name: 'duplicate post', make: () => {
    const posts = qualifiedPosts(3), input = inputFixture(readFixture({ posts }), ['ADV-03']);
    const reviewed = posts.map((item, index) => postReview(input, item, index === 1 ? { duplicateOf: posts[0]!.id } : {}));
    return { input, row: rowFor(input, 'ADV-03', { proof: { posts: reviewed } }), id: 'ADV-03' };
  } });
  cases.push({ name: 'threshold mismatch', make: () => {
    const posts = qualifiedPosts(2), input = inputFixture(readFixture({ posts }), ['ADV-03']);
    return { input, row: rowFor(input, 'ADV-03', { proof: { posts: posts.map(item => postReview(input, item)) } }), id: 'ADV-03' };
  } });
  cases.push({ name: 'contradiction without a closed sample', make: () => {
    const posts = qualifiedPosts(3), unresolved = postSource('unresolved-post', 402, 'unknown_author', '2026-10-02T11:00:00.000Z');
    unresolved.authorId = null; unresolved.publishedAt = null;
    const input = inputFixture(readFixture({ posts: [...posts, unresolved] }), ['ADV-03']);
    const row = rowFor(input, 'ADV-03', { disposition: 'CONTRADICTED', proof: { posts: posts.map(item => postReview(input, item)) } });
    return { input, row, id: 'ADV-03' };
  } });

  for (const scenario of cases) await t.test(scenario.name, () => {
    const { input, row, id } = scenario.make();
    const final = decodeCriterionBatch({ rows: [row] }, input, 'final');
    const single = decodeCriterionBatch({ rows: [row] }, input, 'single');
    if (id !== 'ADV-03') {
      if (scenario.name === 'identity-only narrative') {
        assert.ok(final.invalid[id]?.length, 'reviewed final still rejects identity-only narrative support');
        assert.equal(single.invalid[id], undefined, 'single decode converts unsupported identity-only support to a valid insufficient row');
        assert.equal(single.rows[id]?.evaluationState, 'COMPLETED');
        assert.equal(single.rows[id]?.outcome, 'INSUFFICIENT');
        return;
      }
      if (scenario.name === 'purpose-ineligible receipt citation') {
        assert.ok(final.invalid[id]?.some(problem => problem.path === 'citationIds:purpose'), 'reviewed final still rejects the ineligible receipt citation');
        assert.equal(single.invalid[id], undefined, 'single decode removes the ineligible receipt citation before the unchanged proof guards');
        assert.equal(single.rows[id]?.outcome, 'SUPPORTED');
        assert.equal(single.rows[id]?.citationIds.includes('c9999'), false);
        return;
      }
      assert.deepEqual(single.invalid[id]?.map(issue => [issue.path, issue.code]), final.invalid[id]?.map(issue => [issue.path, issue.code]),
        'the one-stage topology changes the review claim, not the NAR-01 evidence guards');
      assert.ok(single.invalid[id]?.length, 'the deliberately invalid NAR-01 proof remains rejected');
      return;
    }
    assert.ok(final.invalid[id]?.length, 'reviewed final still rejects the deliberately invalid proof');
    if (scenario.name === 'contradiction without a closed sample') {
      assert.equal(single.invalid[id], undefined, 'an unclassified in-scope post is disclosed and does not invalidate the normalized row');
      assert.equal(single.rows[id]?.evaluationState, 'COMPLETED');
      assert.equal(single.rows[id]?.outcome, 'SUPPORTED');
      assert.match(single.rows[id]?.rationale ?? '', /Some in-scope posts were unclassified and were not counted/);
    } else {
      assert.equal(single.invalid[id], undefined, 'single ADV-03 derives INSUFFICIENT from the retained measurement instead of rejecting its model disposition');
      assert.equal(single.rows[id]?.evaluationState, 'COMPLETED');
      assert.equal(single.rows[id]?.outcome, 'INSUFFICIENT');
    }
  });
});
