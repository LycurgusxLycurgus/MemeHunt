import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { completeFixtureEntryFeatures, fixtureBundle, illustrativeFixtureThesis, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { decisionHash, Service } from '../src/app/service.js';
import { deriveAttention, narrativeSourceBound, originSourceScope, validateLeadershipPositive, type NarrativePublicSupport } from '../src/domain/attention.js';
import { deriveBaseline, type BaselineAssessment } from '../src/domain/baseline.js';
import type { FeatureResult, LiveBundle, Profile, TokenRef } from '../src/domain/contracts.js';
import { evaluateEntry } from '../src/domain/policy.js';
import type { AttentionRead, AttentionSource } from '../src/providers/attention.js';
import { leadershipEntryCriterion, leadershipOptions } from '../src/providers/attention-model.js';

// All source text below is synthetic contract data. It demonstrates citation binding and count rules,
// and makes no claim about a real token or the truth of a market narrative.
const TOKEN: TokenRef = { chain: 'base', address: '0x1111111111111111111111111111111111111111' };
const OTHER: TokenRef = { chain: 'base', address: '0x2222222222222222222222222222222222222222' };
const CUTOFF = '2026-10-01T12:00:00.000Z';
const START = '2026-09-30T12:00:00.000Z';
const FRESH = '2026-10-01T11:59:00.000Z';

type Fixture = { read: AttentionRead; proposal: unknown; review: unknown };

function makeFixture(): Fixture {
  const claimDefinitions = [
    ['A01', `Synthetic source describes ${TOKEN.address} as a community story.`, true],
    ['A02', `Synthetic source classifies ${TOKEN.address} as a community token.`, true],
    ['A03', `Synthetic source explicitly calls ${TOKEN.address} an original primary origin.`, true],
    ['A04', `Synthetic source describes a dated event dependency for ${TOKEN.address}.`, true],
    ['A05', `Synthetic source explains ${TOKEN.address} and its referent without prerequisites.`, true],
  ] as const;
  const claimText = claimDefinitions.map(([, quote]) => quote).join('\n');
  const competitorQuote = `Synthetic source connects ${TOKEN.address} and ${OTHER.address} to the same named narrative.`;
  const claimSource: AttentionSource = {
    id: 'claim-page', url: 'https://public.example/claims', text: claimText, publishedAt: null,
    authorId: null, availableAt: FRESH, kind: 'PAGE',
  };
  const competitorSource: AttentionSource = {
    id: 'competitor-page', url: 'https://public.example/competitors', text: competitorQuote, publishedAt: null,
    authorId: null, availableAt: FRESH, kind: 'PAGE',
  };
  const posts: AttentionSource[] = [];
  const postLabels: Array<{ id: string; sourceId: string; quote: string; role: 'CALL' | 'NEWS' | 'JOKE' }> = [];
  for (let index = 0; index < 11; index++) {
    const originalIndex = index === 10 ? 0 : index;
    const referencesOther = originalIndex >= 8;
    const quote = `Synthetic post ${originalIndex + 1} names ${TOKEN.address}${referencesOther ? ` beside ${OTHER.address}` : ''}.`;
    const author = `author${originalIndex % 3 + 1}`;
    const sourceId = `post-source-${index + 1}`;
    posts.push({
      id: sourceId, url: `https://x.com/${author}/status/${index + 1}`, text: quote,
      publishedAt: `2026-10-01T10:${String(index * 3).padStart(2, '0')}:00.000Z`,
      authorId: `x.com:${author}`, availableAt: FRESH, kind: 'POST',
    });
    postLabels.push({ id: `post-label-${index + 1}`, sourceId, quote, role: 'NEWS' });
  }
  const items = [
    ...claimDefinitions.map(([feature, quote], index) => ({
      id: `claim-${index + 1}`, feature, value: true, summary: `Source claim for ${feature}.`,
      citations: [{ sourceId: claimSource.id, quote }],
    })),
    ...postLabels,
    { id: 'competitor-target', token: TOKEN, sourceId: competitorSource.id, quote: competitorQuote },
    { id: 'competitor-other', token: OTHER, sourceId: competitorSource.id, quote: competitorQuote },
  ];
  const proposal = { claims: items.slice(0, 5), posts: postLabels, competitors: items.slice(16) };
  const review = { decisions: items.map(item => ({ id: item.id, accepted: true, rationale: 'Synthetic source label accepted for the boundary test.' })) };
  const read: AttentionRead = {
    sources: [claimSource, competitorSource, ...posts], rawArtifacts: {},
    queries: ['exact target narrative', 'exact target social posts', 'common name representations'],
    complete: true, codes: [], start: START, end: CUTOFF,
    comparisonSourceIds: [competitorSource.id, ...posts.map(post => post.id)],
  };
  return { read, proposal, review };
}

type OriginStatus = 'SUPPORTED' | 'CONTRADICTED' | 'UNKNOWN';

function makeV2Fixture(originStatus: OriginStatus = 'UNKNOWN', includeComparativePosts = true): Fixture {
  const fixture = makeFixture();
  const projectProfileQuote = `The River Lantern project profile identifies ${TOKEN.address} as the project's original contract.`;
  const projectPostQuote = `The River Lantern project account announces ${TOKEN.address} as its original contract in a dated project update.`;
  const projectProfile: AttentionSource = {
    id: 'project-profile', url: 'https://x.com/river_lantern_project', text: projectProfileQuote,
    publishedAt: null, authorId: null, availableAt: FRESH, kind: 'PAGE',
  };
  const projectPost: AttentionSource = {
    id: 'project-origin-post', url: 'https://x.com/river_lantern_project/status/801', text: projectPostQuote,
    publishedAt: '2026-09-29T10:00:00.000Z', authorId: 'x.com:river_lantern_project', availableAt: FRESH, kind: 'POST',
  };
  fixture.read.sources.push(projectProfile, projectPost);
  const proposal = fixture.proposal as {
    claims: Array<{ id: string; feature: string; citations: Array<{ sourceId: string; quote: string }> }>;
    posts: Array<{ id: string; sourceId: string; quote: string; role: string }>;
    competitors: Array<{ id: string; token: TokenRef; sourceId: string; quote: string }>;
  };
  const originClaim = proposal.claims.find(claim => claim.feature === 'A03');
  assert.ok(originClaim);
  originClaim.citations = [{ sourceId: projectProfile.id, quote: projectProfileQuote }];
  proposal.posts.push({ id: 'project-origin-label', sourceId: projectPost.id, quote: projectPostQuote, role: 'NEWS' });
  const review = fixture.review as {
    decisions: Array<{ id: string; accepted: boolean; rationale: string }>;
    candidateSet?: { complete: boolean; rationale: string };
    originRelationship?: { status: OriginStatus; citations: Array<{ sourceId: string; quote: string }>; rationale: string };
  };
  review.decisions.push({ id: 'project-origin-label', accepted: true, rationale: 'The dated primary account post is accepted as an original project update.' });
  review.candidateSet = { complete: true, rationale: 'All exact-contract representations in the discovered common-name sources are included, including the target.' };
  let originCitations: Array<{ sourceId: string; quote: string }> = [];
  if (originStatus === 'SUPPORTED') originCitations = [{ sourceId: projectPost.id, quote: projectPostQuote }];
  if (originStatus === 'CONTRADICTED') {
    const denialQuote = `The River Lantern project account disavows ${TOKEN.address} as a project token and says the contract was not issued by the project.`;
    const denialPost: AttentionSource = {
      id: 'project-disavowal-post', url: 'https://x.com/river_lantern_project/status/802', text: denialQuote,
      publishedAt: '2026-09-30T10:00:00.000Z', authorId: 'x.com:river_lantern_project', availableAt: FRESH, kind: 'POST',
    };
    fixture.read.sources.push(denialPost);
    proposal.posts.push({ id: 'project-disavowal-label', sourceId: denialPost.id, quote: denialQuote, role: 'NEWS' });
    review.decisions.push({ id: 'project-disavowal-label', accepted: true, rationale: 'The dated primary account post explicitly disavows this exact contract.' });
    originCitations = [{ sourceId: denialPost.id, quote: denialQuote }];
  }
  review.originRelationship = {
    status: originStatus, citations: originCitations,
    rationale: originStatus === 'UNKNOWN' ? 'No dated primary project post resolves the origin relationship.' : 'The dated primary project account post addresses this exact contract.',
  };
  fixture.read.comparisonComplete = true;
  fixture.read.comparisonSourceIds = [
    'competitor-page',
    ...(includeComparativePosts ? fixture.read.sources.filter(source => source.kind === 'POST' && source.id.startsWith('post-source-')).map(source => source.id) : []),
  ];
  return fixture;
}

type ComparisonPattern = 'TARGET_LEADS' | 'TIED' | 'RIVAL_LEADS' | 'NINE_QUALIFIED';

function setComparativePattern(fixture: Fixture, pattern: ComparisonPattern): void {
  const proposal = fixture.proposal as { posts: Array<{ sourceId: string; quote: string; role: string }> };
  for (const [index, label] of proposal.posts.filter(post => post.sourceId.startsWith('post-source-')).entries()) {
    const uniqueIndex = index === 10 ? 0 : index;
    const targetOnly = pattern === 'TARGET_LEADS'
      ? uniqueIndex < 7
      : pattern === 'TIED'
        ? uniqueIndex < 4
        : pattern === 'NINE_QUALIFIED'
          ? uniqueIndex < 5
          : false;
    const rivalOnly = pattern === 'TARGET_LEADS'
      ? uniqueIndex >= 7
      : pattern === 'TIED'
        ? uniqueIndex >= 4 && uniqueIndex < 8
        : pattern === 'NINE_QUALIFIED'
          ? uniqueIndex >= 5 && uniqueIndex < 9
          : true;
    const both = pattern === 'TIED' && uniqueIndex >= 8 && uniqueIndex < 10;
    const priceOnly = pattern === 'NINE_QUALIFIED' && uniqueIndex === 9;
    const quote = priceOnly
      ? `Synthetic comparison price recap ${uniqueIndex + 1} with no substantive token representation.`
      : `Synthetic original comparison post ${uniqueIndex + 1} mentions ${targetOnly || both ? TOKEN.address : ''}${both ? ' and ' : ''}${rivalOnly || both ? OTHER.address : ''} in the River Lantern narrative.`;
    label.quote = quote;
    if (priceOnly) label.role = 'PRICE_ONLY';
    const source = fixture.read.sources.find(item => item.id === label.sourceId);
    assert.ok(source);
    source.text = quote;
  }
}

function assessment(fixture: Fixture, overrides: (f: Fixture) => void = () => {}): BaselineAssessment[] {
  overrides(fixture);
  return deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF, ['evidence-sources', 'evidence-proposal', 'evidence-review']);
}

function inadequateOriginFixture(): Fixture {
  const fixture = makeFixture();
  const proposal = fixture.proposal as { claims: Array<{ id: string; feature: string; value: boolean; summary: string; citations: Array<{ sourceId: string; quote: string }>; originBasis?: string }> };
  const origin = proposal.claims.find(claim => claim.feature === 'A03');
  assert.ok(origin);
  origin.value = false;
  origin.summary = 'The bounded public sample does not establish this token project origin or catalyst.';
  origin.citations = [{ sourceId: 'claim-page', quote: `Synthetic source explicitly calls ${TOKEN.address} an original primary origin.` }];
  origin.originBasis = 'PUBLIC_EVIDENCE_INADEQUATE';
  fixture.read.queries = [
    `"${TOKEN.address}" base narrative origin catalyst`,
    `"${TOKEN.address}" (site:x.com OR site:twitter.com)`,
  ];
  fixture.read.rawArtifacts['attention-search-1'] = JSON.stringify({ results: [{ url: 'https://public.example/claims' }] });
  fixture.read.rawArtifacts['attention-search-2'] = JSON.stringify({ results: [{ url: 'https://public.example/claims' }] });
  const claimSource = fixture.read.sources.find(source => source.id === 'claim-page');
  assert.ok(claimSource);
  fixture.read.rawArtifacts['attention-fetch-1'] = JSON.stringify({
    results: [{ url: claimSource.url, final_url: claimSource.url, text: claimSource.text }], errors: [],
  });
  fixture.read.discoveryUrls = ['https://public.example/claims'];
  fixture.read.originScope = originSourceScope(fixture.read, TOKEN);
  (fixture.review as { originScopeReview?: unknown }).originScopeReview = {
    complete: true, sourceIds: [...fixture.read.originScope.sourceIds],
    rationale: 'Every retained original source was inspected for exact-token origin and catalyst evidence.',
  };
  return fixture;
}

function fixedGrowthAssessment(fixture: Fixture): BaselineAssessment[] {
  const postSources = fixture.read.sources.filter(source => source.kind === 'POST');
  fixture.read.growthSample = {
    method: 'fixed-query-sample-v1', sourceIds: postSources.map(source => source.id),
    queries: [...fixture.read.queries], complete: true,
  };
  return deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF,
    ['evidence-sources', 'evidence-proposal', 'evidence-review'], true);
}

function projectContextPostFixture(): Fixture {
  const fixture = makeFixture();
  const posts = fixture.read.sources.filter(source => source.kind === 'POST').slice(0, 4);
  const postIds = new Set(posts.map(source => source.id));
  fixture.read.sources = fixture.read.sources.filter(source => source.kind !== 'POST' || postIds.has(source.id));
  fixture.read.postSampleSourceIds = posts.map(source => source.id);
  fixture.read.postSampleComplete = true;
  fixture.read.collectionMethod = 'project-context-v2';
  const proposal = fixture.proposal as { claims: unknown[]; posts: Array<{ id: string; sourceId: string; quote: string; role: string }>; competitors: unknown[] };
  proposal.posts = proposal.posts.slice(0, 4);
  const review = fixture.review as { decisions: Array<{ id: string; accepted: boolean; rationale: string }> };
  const retainedDecisionIds = new Set([...proposal.posts.map(post => post.id), 'claim-1', 'claim-2', 'claim-3', 'claim-4', 'claim-5', 'competitor-target', 'competitor-other']);
  review.decisions = review.decisions.filter(decision => retainedDecisionIds.has(decision.id));

  const previousTimes = ['2026-09-30T13:00:00.000Z', '2026-09-30T18:00:00.000Z', '2026-09-30T23:59:00.000Z'];
  for (let index = 0; index < posts.length; index++) {
    const source = posts[index]!;
    const label = proposal.posts[index]!;
    source.publishedAt = index < 3 ? previousTimes[index]! : '2026-10-01T01:00:00.000Z';
    source.authorId = `x.com:writer${index + 1}`;
    if (index < 3) label.role = (['NEWS', 'JOKE', 'CALL'] as const)[index]!;
    else {
      const quote = `Price-only recap for ${TOKEN.address}; it reports a quote without a project update.`;
      source.text = quote;
      label.quote = quote;
      label.role = 'NEWS';
      review.decisions.find(decision => decision.id === label.id)!.accepted = false;
    }
  }
  return fixture;
}

test('project-context attention counts accepted source posts while retaining rejected role judgments', async t => {
  const fixture = projectContextPostFixture();
  const rows = fixedGrowthAssessment(fixture);
  const qualified = row(rows, 'A16').data as {
    qualified: number;
    excluded: Array<{ id: string; role?: string; accepted?: boolean; reason?: string }>;
    method: string;
  };
  const growth = row(rows, 'A18').data as { previous: number; current: number; dispositions: Array<{ id: string; accepted: boolean; qualified: boolean }> };
  const rejected = qualified.excluded.find(item => item.id === 'post-source-4');

  assert.equal(fixture.read.collectionMethod, 'project-context-v2');
  assert.deepEqual([row(rows, 'A15').quality, row(rows, 'A16').quality, row(rows, 'A17').quality, row(rows, 'A18').quality],
    ['KNOWN', 'KNOWN', 'KNOWN', 'KNOWN']);
  assert.deepEqual([feature(rows, 'A16').value, feature(rows, 'A17').value, feature(rows, 'A18').value], ['3', '3', false]);
  assert.equal(qualified.qualified, 3);
  assert.equal(qualified.method, 'accepted-original-source-posts-v2');
  assert.deepEqual(rejected, { id: 'post-source-4', role: 'NEWS', accepted: false, reason: 'ROLE_NOT_QUALIFIED' });
  assert.deepEqual([growth.previous, growth.current], [3, 0], 'growth uses the same three accepted source claims and excludes the rejected claim');
  assert.deepEqual(growth.dispositions.find(item => item.id === 'post-source-4'), {
    id: 'post-source-4', publishedAt: '2026-10-01T01:00:00.000Z', authorId: 'x.com:writer4', role: 'NEWS',
    accepted: false, qualified: false, bin: 'CURRENT',
  });
  assert.equal((fixture.proposal as { posts: Array<{ id: string; role: string }> }).posts.find(post => post.id === 'post-label-4')?.role,
    'NEWS', 'the proposed role stays intact after the independent rejection');
  assert.equal((fixture.review as { decisions: Array<{ id: string; accepted: boolean }> }).decisions.find(decision => decision.id === 'post-label-4')?.accepted,
    false, 'the actual independent rejection remains visible');

  await t.test('legacy marker absence keeps rejected current roles unresolved', () => {
    const legacy = projectContextPostFixture();
    delete legacy.read.collectionMethod;
    const legacyRows = fixedGrowthAssessment(legacy);
    assert.equal(row(legacyRows, 'A16').quality, 'MISSING');
    assert.equal(feature(legacyRows, 'A16').value, null);
    assert.equal(row(legacyRows, 'A18').quality, 'MISSING');
    assert.equal(feature(legacyRows, 'A18').value, null);
  });

  const blockers: Array<{ name: string; change: (value: Fixture) => void }> = [
    { name: 'missing independent post review', change: value => {
      (value.review as { decisions: Array<{ id: string }> }).decisions = (value.review as { decisions: Array<{ id: string }> }).decisions.filter(item => item.id !== 'post-label-4');
    } },
    { name: 'invalid literal citation', change: value => {
      (value.proposal as { posts: Array<{ id: string; quote: string }> }).posts.find(item => item.id === 'post-label-4')!.quote = `Fabricated ${TOKEN.address} citation.`;
    } },
    { name: 'incomplete post acquisition', change: value => { value.read.postSampleComplete = false; } },
    { name: 'stale observation window', change: value => { value.read.end = '2026-10-01T11:00:00.000Z'; } },
    { name: 'missing original author', change: value => { value.read.sources.find(source => source.id === 'post-source-4')!.authorId = null; } },
    { name: 'missing post date', change: value => { value.read.sources.find(source => source.id === 'post-source-4')!.publishedAt = null; } },
  ];
  for (const scenario of blockers) await t.test(scenario.name, () => {
    const blocked = projectContextPostFixture();
    scenario.change(blocked);
    const blockedRows = fixedGrowthAssessment(blocked);
    for (const id of ['A15', 'A16', 'A17', 'A18']) {
      assert.equal(row(blockedRows, id).quality, 'MISSING', id);
      assert.equal(feature(blockedRows, id).value, null, id);
    }
  });
});

test('linked narrative references bind one hop for A01 while A03 stays literal-contract-only', () => {
  const fixture = makeFixture();
  const parentUrl = 'https://metadata.example/token.json';
  const childUrl = 'https://community.example/narrative';
  const quote = 'River Lantern describes a neighborhood story through shared local art.';
  fixture.read.sources.push(
    { id: 'token-metadata-json', url: parentUrl, text: JSON.stringify({ mint: TOKEN.address, website: childUrl }), publishedAt: null, authorId: null, availableAt: FRESH, kind: 'PAGE' },
    { id: 'linked-reference', url: childUrl, text: quote, publishedAt: null, authorId: null, availableAt: FRESH, kind: 'PAGE', discoveredFrom: parentUrl },
  );
  fixture.read.discoveryUrls = [parentUrl];
  fixture.read.metadataLinks = true;
  fixture.read.metadataUri = parentUrl;
  const claims = (fixture.proposal as { claims: Array<{ feature: string; citations: Array<{ sourceId: string; quote: string }> }> }).claims;
  for (const feature of ['A01', 'A03']) {
    const claim = claims.find(item => item.feature === feature)!;
    claim.citations = [{ sourceId: 'linked-reference', quote }];
  }

  assert.equal(narrativeSourceBound(fixture.read, 'linked-reference', TOKEN), true);
  const rows = assessment(fixture);
  assert.equal(row(rows, 'A01').quality, 'KNOWN', 'the exact linked child describes the narrative after independent review');
  assert.equal(row(rows, 'A03').quality, 'MISSING', 'a source-described reference does not establish primary origin');
  assert.equal(row(rows, 'A03').causes[0]?.code, 'ATT_CITATION_BINDING_INVALID');

  const invalidReads: Array<[string, (read: AttentionRead) => void]> = [
    ['missing metadata-link flag', read => { delete read.metadataLinks; }],
    ['metadata URI is not the parent', read => { read.metadataUri = 'https://other.example/token.json'; }],
    ['parent not in discovery URLs', read => { read.discoveryUrls = []; }],
    ['forged parent relationship', read => { read.sources.find(source => source.id === 'linked-reference')!.discoveredFrom = 'https://elsewhere.example/token.json'; }],
    ['unlinked child target', read => { read.sources.find(source => source.id === 'token-metadata-json')!.text = JSON.stringify({ mint: TOKEN.address, website: 'https://other.example/page' }); }],
  ];
  for (const [name, mutate] of invalidReads) {
    const copy: AttentionRead = {
      ...fixture.read,
      sources: fixture.read.sources.map(source => ({ ...source })),
      discoveryUrls: [...(fixture.read.discoveryUrls ?? [])],
    };
    mutate(copy);
    assert.equal(narrativeSourceBound(copy, 'linked-reference', TOKEN), false, name);
  }
});

function inadequateRepresentationFixture(): Fixture {
  const fixture = makeV2Fixture('UNKNOWN', true);
  const leadId = 'comparison-lead-1';
  const metadataEvidenceId = `${leadId}-metadata`;
  const title = 'River Lantern neighborhood art project';
  const snippet = 'The indexed project describes a community art token and shared public murals.';
  const profileText = 'The current account now publishes OUSD reserve backing and stablecoin lending updates; these fetched publications do not reflect the indexed River Lantern neighborhood art project.';
  fixture.read.comparisonComplete = false;
  fixture.read.codes = [];
  fixture.read.sources.push({
    id: 'current-profile', url: 'https://x.com/river_lantern', text: profileText,
    publishedAt: null, authorId: null, availableAt: CUTOFF, kind: 'PAGE',
  });
  fixture.read.comparisonAcquisition = {
    originalComplete: true, searchSucceeded: true, descriptorComplete: true, leadCount: 1,
    leads: [{
      id: leadId, searchArtifactId: 'attention-search-3', resultIndex: 0, url: 'https://x.com/river_lantern',
      title, snippet, metadataEvidenceId, sourceIds: ['current-profile'], acquisitionStatus: 'ACQUIRED', acquisitionCodes: [],
      recoveryQueryIds: ['attention-recovery-search-1'], recoverySourceIds: ['current-profile'],
    }],
  };
  fixture.read.comparisonQualification = {
    mode: 'qualified-identified-leads-v1', originalAcquisitionComplete: true, complete: false,
    decisions: [], unresolvedLeadIds: [leadId], recoveryCapped: false,
    evidenceAdequacy: {
      verdict: 'INADEQUATE', leadId,
      rationale: 'The indexed project descriptor cannot be associated with the current fetched account subject after the bounded recovery search.',
      citations: [
        { sourceId: metadataEvidenceId, quote: snippet },
        { sourceId: 'current-profile', quote: 'The current account now publishes OUSD reserve backing and stablecoin lending updates' },
      ],
    },
    evidenceAdequacyReview: { accepted: true, rationale: 'The separate source review accepts the cited indexed-to-current-subject mismatch.' },
    adequacySourceLengths: [{ id: 'current-profile', retainedLength: profileText.length }],
  };
  return fixture;
}

function indexedPost(fixture: Fixture, index: number) {
  const source = fixture.read.sources.filter(item => item.kind === 'POST')[index];
  assert.ok(source, `expected fixture post ${index + 1}`);
  const label = (fixture.proposal as { posts: Array<{ id: string; sourceId: string; quote: string; role: string }> }).posts
    .find(item => item.sourceId === source.id);
  assert.ok(label, `expected a reviewed label for ${source.id}`);
  return { source, label };
}

function row(rows: BaselineAssessment[], id: string) {
  const value = rows.find(item => item.id === id);
  assert.ok(value, `expected attention row ${id}`);
  return value;
}

function feature(rows: BaselineAssessment[], id: string): FeatureResult {
  const projection = row(rows, id).projection;
  assert.ok(projection, `expected ${id} projection`);
  return projection;
}

function attentionPolicyStatus(rows: BaselineAssessment[]): string | undefined {
  const features = new Map(completeFixtureEntryFeatures().map(item => [item.id, item]));
  for (const item of rows) if (item.projection) features.set(item.id, item.projection);
  return evaluateEntry([...features.values()], illustrativeUncalibratedProfile, CUTOFF, 'QUALIFIED')
    .checks.find(check => check.checkId === 'ATT-01')?.status;
}

test('source-backed fixture resolves the six attention checks and deduplicates original posts before counting', () => {
  const fixture = makeFixture();
  assert.equal('explanation' in (fixture.proposal as { claims: Array<Record<string, unknown>> }).claims.find(claim => claim.feature === 'A05')!, false,
    'the established unstructured proposal remains a supported legacy input');
  const rows = assessment(fixture);
  const expectedValues: Record<string, string | boolean> = {
    A01: true, A02: true, A03: true, A04: true, A05: true,
    A09: true, A10: true, A11: true, A14: true,
    A15: true, A16: '10', A17: '3',
  };
  for (const [id, value] of Object.entries(expectedValues)) {
    assert.equal(row(rows, id).quality, 'KNOWN', id);
    assert.equal(feature(rows, id).value, value, id);
    assert.ok(row(rows, id).limitations.some(item => item.includes('automated-source-review-v1')), id);
  }
  const sample = row(rows, 'A15').data as { raw: number; originals: number };
  assert.deepEqual([sample.raw, sample.originals], [11, 10]);
  assert.equal((row(rows, 'A11').data as { scope: string }).scope, 'same common-name query post sample across discovered candidates; exact-target searches excluded');
  assert.equal((row(rows, 'A11').data as { tied: boolean }).tied, false);

  const base = new Map(completeFixtureEntryFeatures().map(item => [item.id, item]));
  for (const id of Object.keys(expectedValues)) base.set(id, feature(rows, id));
  const result = evaluateEntry([...base.values()], {
    id: 'synthetic-attention-profile', risk: {}, stage: { ageBands: [] },
  }, CUTOFF, 'QUALIFIED');
  const checks = result.checks.filter(check => ['NAR-01', 'NAR-02', 'NAR-03', 'CAN-01', 'CAN-02', 'ATT-01'].includes(check.checkId));
  assert.deepEqual(checks.map(check => [check.checkId, check.status]), [
    ['ATT-01', 'PASS'], ['CAN-01', 'PASS'], ['CAN-02', 'PASS'],
    ['NAR-01', 'PASS'], ['NAR-02', 'PASS'], ['NAR-03', 'PASS'],
  ]);
});

test('reviewed inadequate origin evidence fails NAR-02 as scoped traceability while preserving other claims', () => {
  const fixture = inadequateOriginFixture();
  assert.equal(fixture.read.originScope?.complete, true);
  assert.deepEqual(fixture.read.originScope?.sourceIds, ['claim-page'], 'only source text in the original acquisition scope is inspected');
  const rows = assessment(fixture);

  assert.equal(row(rows, 'A03').quality, 'KNOWN');
  assert.equal(feature(rows, 'A03').value, false);
  assert.equal((row(rows, 'A03').data as { originBasis: string }).originBasis, 'PUBLIC_EVIDENCE_INADEQUATE');
  assert.match((row(rows, 'A03').data as { meaning: string }).meaning, /not proof of fraud/);
  assert.equal(row(rows, 'A01').quality, 'KNOWN', 'a separate accepted narrative claim is retained');
  assert.equal(feature(rows, 'A01').value, true);

  const features = new Map(completeFixtureEntryFeatures().map(item => [item.id, item]));
  for (const item of rows) if (item.projection) features.set(item.id, item.projection);
  const entry = evaluateEntry([...features.values()], illustrativeUncalibratedProfile, CUTOFF, 'QUALIFIED');
  assert.equal(entry.checks.find(check => check.checkId === 'NAR-02')?.status, 'FAIL',
    'the reviewed negative A03 is sufficient for the origin/catalyst screening failure');

  const legacy = assessment(makeFixture());
  assert.equal(row(legacy, 'A03').quality, 'KNOWN');
  assert.equal(feature(legacy, 'A03').value, true, 'unmarked positive origin evidence keeps its established behavior');
});

test('inadequate origin evidence stays unknown when its discovery scope or independent review is incomplete', () => {
  const scenarios: Array<{ name: string; code?: string; change: (fixture: Fixture) => void }> = [
    { name: 'missing origin-scope review', change: fixture => {
      delete (fixture.review as { originScopeReview?: unknown }).originScopeReview;
    } },
    { name: 'review says the source set was incomplete', change: fixture => {
      (fixture.review as { originScopeReview: { complete: boolean } }).originScopeReview.complete = false;
    } },
    { name: 'review does not inspect every exact source ID', change: fixture => {
      (fixture.review as { originScopeReview: { sourceIds: string[] } }).originScopeReview.sourceIds.pop();
    } },
    { name: 'review adds a source outside the declared scope', change: fixture => {
      (fixture.review as { originScopeReview: { sourceIds: string[] } }).originScopeReview.sourceIds.push('forged-source');
    } },
    { name: 'review rejects the proposed screening grade', code: 'ATT_REVIEW_REJECTED', change: fixture => {
      (fixture.review as { decisions: Array<{ id: string; accepted: boolean }> }).decisions.find(item => item.id === 'claim-3')!.accepted = false;
    } },
    { name: 'a discovery seed was not retained', change: fixture => {
      fixture.read.discoveryUrls = ['https://public.example/not-retained'];
      fixture.read.originScope = originSourceScope(fixture.read, TOKEN);
    } },
    { name: 'one exact-address search failed', change: fixture => {
      fixture.read.rawArtifacts['attention-search-2'] = JSON.stringify({ error: 'search unavailable', results: [] });
      fixture.read.originScope = originSourceScope(fixture.read, TOKEN);
    } },
    { name: 'an exact-token launch URL was blocked after its context page was acquired', change: fixture => {
      const launch = 'https://public.example/launch';
      fixture.read.rawArtifacts['attention-search-2'] = JSON.stringify({ results: [
        { url: 'https://public.example/claims' }, { url: launch },
      ] });
      fixture.read.rawArtifacts['attention-fetch-1'] = JSON.stringify({
        results: [{ url: 'https://public.example/claims', final_url: 'https://public.example/claims', text: fixture.read.sources.find(source => source.id === 'claim-page')!.text }],
        errors: [{ url: launch, error: 'bot_blocked', status: 403 }],
      });
      fixture.read.originScope = originSourceScope(fixture.read, TOKEN);
      assert.deepEqual(fixture.read.originScope.acquisition?.urls.find(item => item.url === launch), {
        url: launch, sourceId: null, state: 'UNAVAILABLE',
      });
      assert.equal((fixture.review as { decisions: Array<{ id: string; accepted: boolean }> }).decisions.find(item => item.id === 'claim-3')?.accepted, true,
        'the model still accepts the negative claim; incomplete original acquisition keeps it unknown');
    } },
    { name: 'an exact-token launch URL omitted from the fetch envelope stays incomplete', change: fixture => {
      const launch = 'https://public.example/launch';
      fixture.read.rawArtifacts['attention-search-2'] = JSON.stringify({ results: [
        { url: 'https://public.example/claims' }, { url: launch },
      ] });
      fixture.read.rawArtifacts['attention-fetch-1'] = JSON.stringify({
        results: [{ url: 'https://public.example/claims', final_url: 'https://public.example/claims', text: fixture.read.sources.find(source => source.id === 'claim-page')!.text }],
        errors: [],
      });
      fixture.read.originScope = originSourceScope(fixture.read, TOKEN);
      assert.equal(fixture.read.originScope.acquisition?.urls.find(item => item.url === launch)?.state, 'OMITTED');
    } },
    { name: 'an eligible metadata seed link that failed remains in the original scope', change: fixture => {
      const seed = 'https://metadata.example/token.json';
      const linked = 'https://metadata.example/launch';
      fixture.read.discoveryUrls = [seed];
      fixture.read.rawArtifacts['attention-search-1'] = JSON.stringify({ results: [{ url: 'https://public.example/claims' }] });
      fixture.read.rawArtifacts['attention-search-2'] = JSON.stringify({ results: [] });
      fixture.read.sources.push({ id: 'metadata-seed', url: seed, text: JSON.stringify({ mint: TOKEN.address, website: linked }),
        publishedAt: null, authorId: null, availableAt: FRESH, kind: 'PAGE' });
      fixture.read.rawArtifacts['attention-fetch-1'] = JSON.stringify({
        results: [
          { url: seed, final_url: seed, text: fixture.read.sources.find(source => source.id === 'metadata-seed')!.text, links: [linked] },
          { url: 'https://public.example/claims', final_url: 'https://public.example/claims', text: fixture.read.sources.find(source => source.id === 'claim-page')!.text },
        ],
        errors: [{ url: linked, error: 'bot_blocked', status: 403 }],
      });
      fixture.read.originScope = originSourceScope(fixture.read, TOKEN);
      assert.equal(fixture.read.originScope.acquisition?.urls.find(item => item.url === linked)?.state, 'UNAVAILABLE');
    } },
    { name: 'an original source was clipped beyond the bounded review', change: fixture => {
      fixture.read.sources.find(source => source.id === 'claim-page')!.text += 'x'.repeat(6001);
      fixture.read.originScope = originSourceScope(fixture.read, TOKEN);
    } },
  ];

  for (const scenario of scenarios) {
    const fixture = inadequateOriginFixture();
    scenario.change(fixture);
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A03').quality, 'MISSING', scenario.name);
    assert.equal(feature(rows, 'A03').value, null, scenario.name);
    assert.equal(row(rows, 'A03').causes[0]?.code, scenario.code ?? 'ATT_ORIGIN_EVIDENCE_REVIEW_INCOMPLETE', scenario.name);
    assert.equal(row(rows, 'A01').quality, 'KNOWN', `${scenario.name}: incomplete origin review does not erase A01`);
  }
});

test('reviewed narrative-support gaps fail entry checks without replacing facts or overriding substantive support', () => {
  const fixture = inadequateOriginFixture();
  const scope = originSourceScope(fixture.read, TOKEN);
  assert.equal(scope.complete, true);
  const source = fixture.read.sources.find(item => item.id === scope.sourceIds[0]);
  assert.ok(source);
  const quote = source.text.split('\n')[0]!;
  const receipt: NarrativePublicSupport = {
    method: 'narrative-public-support-v1',
    scope: { method: 'bounded-origin-sources-v1', sourceIds: [...scope.sourceIds] },
    sourceSupport: scope.sourceIds.map((sourceId): NarrativePublicSupport['sourceSupport'][number] => ({
      sourceId, status: 'PUBLIC_SUPPORT_GAP', criteria: ['NARRATIVE_DESCRIPTION', 'EXPLAINABLE_THESIS'],
      rationale: 'The inspected original source records the token but describes no public narrative or thesis.',
      citations: [{ sourceId, quote }],
      review: { accepted: true, inspectionComplete: true, rationale: 'The full retained original source was checked against both support classifications.' },
    })),
    judgments: {
      NARRATIVE_DESCRIPTION: { verdict: 'INADEQUATE', rationale: 'The complete source sample does not explain the token narrative.', citations: [{ sourceId: source.id, quote }], review: { accepted: true, rationale: 'The cited exact-token source supports this bounded gap.' } },
      EXPLAINABLE_THESIS: { verdict: 'INADEQUATE', rationale: 'The complete source sample does not explain an underlying thesis.', citations: [{ sourceId: source.id, quote }], review: { accepted: true, rationale: 'The cited exact-token source supports this bounded gap.' } },
    },
    proposalResponseId: 'attention-narrative-support-proposal-response',
    reviewResponseId: 'attention-narrative-support-review-response',
  };
  const unresolved = structuredClone(fixture);
  unresolved.read.narrativePublicSupport = structuredClone(receipt);
  const proposal = unresolved.proposal as { claims: Array<{ id: string; feature: string }> };
  const removed = new Set(proposal.claims.filter(claim => claim.feature === 'A01' || claim.feature === 'A05').map(claim => claim.id));
  proposal.claims = proposal.claims.filter(claim => !removed.has(claim.id));
  const review = unresolved.review as { decisions: Array<{ id: string }> };
  review.decisions = review.decisions.filter(decision => !removed.has(decision.id));
  const deriveWithSupport = (input: Fixture) => deriveAttention(input.read, input.proposal, input.review, TOKEN, CUTOFF,
    ['evidence-sources', 'evidence-proposal', 'evidence-review'], true);
  const rows = deriveWithSupport(unresolved);
  for (const [id, criterion] of [['A01', 'NARRATIVE_DESCRIPTION'], ['A05', 'EXPLAINABLE_THESIS']] as const) {
    const assessed = row(rows, id);
    assert.equal(assessed.quality, 'KNOWN', `${id} may receive a scoped support grade`);
    assert.equal(feature(rows, id).value, false);
    const data = assessed.data as { method: string; entryCriterion: string; factualAssessment: { quality: string; value: unknown }; meaning: string };
    assert.equal(data.method, 'narrative-public-support-v1');
    assert.equal(data.entryCriterion, criterion);
    assert.deepEqual([data.factualAssessment.quality, data.factualAssessment.value], ['MISSING', null]);
    assert.match(data.meaning, /factual narrative remains unresolved/);
  }

  const supported = inadequateOriginFixture();
  supported.read.narrativePublicSupport = receipt;
  const supportedRows = deriveWithSupport(supported);
  assert.equal(feature(supportedRows, 'A01').value, true, 'accepted factual narrative takes precedence over the separate inadequacy grade');
  assert.equal(feature(supportedRows, 'A05').value, true, 'an accepted factual explanation is not inverted by the support grade');
  assert.equal((row(supportedRows, 'A01').data as { method: string }).method, 'automated-source-review-v1');

  const contrary = structuredClone(unresolved);
  contrary.read.narrativePublicSupport!.sourceSupport[0] = {
    ...contrary.read.narrativePublicSupport!.sourceSupport[0]!, status: 'SUBSTANTIVE_SUPPORT', criteria: ['NARRATIVE_DESCRIPTION'],
  };
  const contraryRows = deriveWithSupport(contrary);
  assert.equal(row(contraryRows, 'A01').quality, 'MISSING', 'substantive evidence on the same criterion blocks an inadequate grade');

  const rejected = structuredClone(unresolved);
  rejected.read.narrativePublicSupport!.sourceSupport[0]!.review.accepted = false;
  rejected.read.narrativePublicSupport!.sourceSupport[0]!.review.inspectionComplete = false;
  const rejectedRows = deriveWithSupport(rejected);
  assert.equal(row(rejectedRows, 'A01').quality, 'MISSING', 'a rejected or incomplete source inspection cannot qualify a narrative gap');

  const badClock = structuredClone(unresolved);
  badClock.read.sources.find(item => item.id === scope.sourceIds[0])!.availableAt = 'not-a-time';
  const badClockRows = deriveWithSupport(badClock);
  assert.equal(row(badClockRows, 'A01').quality, 'MISSING', 'an invalid clock on any source in the inspected scope blocks grading');
});

test('PUBLIC_EVIDENCE_INADEQUATE marker cannot qualify A01 or alter a positive A03', () => {
  const fixture = makeFixture();
  const claims = (fixture.proposal as { claims: Array<{ id: string; originBasis?: string }> }).claims;
  claims.find(claim => claim.id === 'claim-1')!.originBasis = 'PUBLIC_EVIDENCE_INADEQUATE';
  const rows = assessment(fixture);
  assert.equal(row(rows, 'A01').quality, 'MISSING');
  assert.equal(row(rows, 'A01').causes[0]?.code, 'ATT_ORIGIN_EVIDENCE_REVIEW_INCOMPLETE');
  assert.equal(row(rows, 'A03').quality, 'KNOWN');
  assert.equal(feature(rows, 'A03').value, true);
});

test('A18 reports strict growth only from one complete fixed-query sample split at its exact midpoint', () => {
  const fixture = makeFixture();
  const timestamps = [
    START, '2026-09-30T18:00:00.000Z', '2026-09-30T22:00:00.000Z', '2026-09-30T23:59:59.999Z',
    '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z', '2026-10-01T04:00:00.000Z',
    '2026-10-01T06:00:00.000Z', '2026-10-01T08:00:00.000Z', CUTOFF, '2026-10-01T07:00:00.000Z',
  ];
  for (let index = 0; index < timestamps.length; index++) {
    const { source } = indexedPost(fixture, index);
    source.publishedAt = timestamps[index]!;
    source.availableAt = CUTOFF;
  }
  const legacyRows = deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF,
    ['evidence-sources', 'evidence-proposal', 'evidence-review']);
  const rows = fixedGrowthAssessment(fixture);
  const a18 = row(rows, 'A18');
  const growth = a18.data as {
    method: string; start: string; midpoint: string; end: string; bucketSeconds: number;
    previous: number; current: number; previousSourceIds: string[]; currentSourceIds: string[];
    dispositions: Array<{ id: string; publishedAt: string; authorId: string; role: string; accepted: boolean; qualified: boolean; bin: string }>;
    scope: string;
  };

  assert.equal(a18.quality, 'KNOWN');
  assert.equal(feature(rows, 'A18').value, true);
  assert.equal(growth.method, 'fixed-sample-equal-bins-v1');
  assert.deepEqual([growth.start, growth.midpoint, growth.end, growth.bucketSeconds], [START, '2026-10-01T00:00:00.000Z', CUTOFF, 43_200]);
  assert.deepEqual([growth.previous, growth.current], [4, 5]);
  assert.deepEqual(growth.previousSourceIds, ['post-source-1', 'post-source-2', 'post-source-3', 'post-source-4']);
  assert.deepEqual(growth.currentSourceIds, ['post-source-5', 'post-source-6', 'post-source-7', 'post-source-8', 'post-source-9'],
    'an item exactly at the midpoint belongs to the current bin and an item at end is excluded');
  assert.equal(growth.dispositions.length, 11, 'the manifest preserves every sampled source, including duplicate and excluded records');
  assert.deepEqual(growth.dispositions[4], {
    id: 'post-source-5', publishedAt: '2026-10-01T00:00:00.000Z', authorId: 'x.com:author2', role: 'NEWS',
    accepted: true, qualified: true, bin: 'CURRENT',
  });
  assert.equal(growth.dispositions[10]?.qualified, false, 'the duplicate original stays visible but does not inflate either bin');
  assert.match(growth.scope, /not platform-wide growth/);
  assert.deepEqual([feature(rows, 'A15').value, feature(rows, 'A16').value, feature(rows, 'A17').value], [true, '9', '3']);
  for (const legacy of legacyRows) assert.deepEqual(row(rows, legacy.id), legacy,
    `${legacy.id} retains its existing projection, evidence, exclusions and limitation`);
  assert.equal(legacyRows.some(item => item.id === 'A18'), false, 'legacy callers do not receive a new attention feature');
});

test('A18 is known false for equal, declining, and complete zero-count fixed samples', () => {
  const cases = [
    { name: 'equal bins', previous: 4, current: 4, expected: [4, 4] as const },
    { name: 'decreasing bins', previous: 5, current: 2, expected: [5, 2] as const },
    { name: 'complete zero participation', previous: 0, current: 0, expected: [0, 0] as const },
  ];
  for (const scenario of cases) {
    const fixture = makeFixture();
    const uniqueCount = 10;
    for (let index = 0; index < uniqueCount; index++) {
      const { source, label } = indexedPost(fixture, index);
      source.publishedAt = index < scenario.previous
        ? `2026-09-30T${String(12 + Math.floor(index * 8 / Math.max(scenario.previous, 1))).padStart(2, '0')}:00:00.000Z`
        : `2026-10-01T${String(1 + (index - scenario.previous) % 10).padStart(2, '0')}:00:00.000Z`;
      source.availableAt = CUTOFF;
      if (index >= scenario.previous + scenario.current || scenario.expected[0] === 0) label.role = 'PRICE_ONLY';
    }
    const duplicate = indexedPost(fixture, 10);
    duplicate.source.publishedAt = '2026-10-01T11:00:00.000Z';
    duplicate.source.availableAt = CUTOFF;
    if (scenario.expected[0] === 0) duplicate.label.role = 'PRICE_ONLY';
    const rows = fixedGrowthAssessment(fixture);

    assert.equal(row(rows, 'A18').quality, 'KNOWN', scenario.name);
    assert.equal(feature(rows, 'A18').value, false, scenario.name);
    assert.deepEqual([(row(rows, 'A18').data as { previous: number }).previous, (row(rows, 'A18').data as { current: number }).current], scenario.expected, scenario.name);
    if (scenario.expected[0] === 0) {
      assert.deepEqual([feature(rows, 'A16').value, feature(rows, 'A17').value], ['0', '0'], 'a complete observed zero is distinct from an empty corpus');
    }
  }
});

test('A18 stays missing when its fixed sample or event provenance is incomplete', () => {
  const cases = [
    { name: 'no manifest', change: (fixture: Fixture) => { delete fixture.read.growthSample; } },
    { name: 'sample marked incomplete', change: (fixture: Fixture) => { fixture.read.growthSample!.complete = false; } },
    { name: 'sample omits a selected source', change: (fixture: Fixture) => { fixture.read.growthSample!.sourceIds.pop(); } },
    { name: 'sample repeats a source instead of covering the set', change: (fixture: Fixture) => { fixture.read.growthSample!.sourceIds[0] = fixture.read.growthSample!.sourceIds[1]!; } },
    { name: 'sample query differs from the acquired query set', change: (fixture: Fixture) => { fixture.read.growthSample!.queries.push('different query'); } },
    { name: 'sample has no fixed query', change: (fixture: Fixture) => { fixture.read.queries = []; fixture.read.growthSample!.queries = []; } },
    { name: 'event predates its observed availability', change: (fixture: Fixture) => {
      indexedPost(fixture, 0).source.availableAt = '2026-10-01T11:55:00.000Z';
      indexedPost(fixture, 0).source.publishedAt = '2026-10-01T11:56:00.000Z';
    } },
    { name: 'post judgment was rejected', change: (fixture: Fixture) => {
      const id = indexedPost(fixture, 0).label.id;
      (fixture.review as { decisions: Array<{ id: string; accepted: boolean }> }).decisions.find(decision => decision.id === id)!.accepted = false;
    } },
    { name: 'post role is unresolved', change: (fixture: Fixture) => { indexedPost(fixture, 0).label.role = 'UNCLEAR'; } },
  ];
  for (const scenario of cases) {
    const fixture = makeFixture();
    fixedGrowthAssessment(fixture);
    scenario.change(fixture);
    const rows = deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF,
      ['evidence-sources', 'evidence-proposal', 'evidence-review'], true);
    assert.equal(row(rows, 'A18').quality, 'MISSING', scenario.name);
    assert.equal(feature(rows, 'A18').value, null, scenario.name);
  }
});

test('a rejected label, paraphrase, stale citation, page label, or missing post metadata cannot become a known feature', async t => {
  await t.test('review rejection leaves a source-backed claim unknown', () => {
    const fixture = makeFixture();
    (fixture.review as { decisions: Array<{ id: string; accepted: boolean; rationale: string }> }).decisions
      .find(decision => decision.id === 'claim-1')!.accepted = false;
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A01').quality, 'MISSING');
    assert.equal(feature(rows, 'A01').value, null);
  });

  await t.test('an explicit cited negative claim stays distinct from missing evidence', () => {
    const fixture = makeFixture();
    const negative = `Synthetic source explicitly says there is no community story for ${TOKEN.address}.`;
    const source = fixture.read.sources.find(item => item.id === 'claim-page')!;
    source.text = `${negative}\n${source.text}`;
    const claims = (fixture.proposal as { claims: Array<{ value: boolean; summary: string; citations: Array<{ quote: string }> }> }).claims;
    claims[0]!.value = false;
    claims[0]!.summary = 'Source says no community story exists.';
    claims[0]!.citations[0]!.quote = negative;
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A01').quality, 'KNOWN');
    assert.equal(feature(rows, 'A01').value, false);
  });

  await t.test('a paraphrase absent from the retained source fails exact citation validation', () => {
    const fixture = makeFixture();
    const claims = (fixture.proposal as { claims: Array<{ citations: Array<{ quote: string }> }> }).claims;
    claims[0]!.citations[0]!.quote = 'An unsupported paraphrase of a synthetic source.';
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A01').quality, 'MISSING');
    assert.equal(feature(rows, 'A01').value, null);
  });

  await t.test('a stale source cannot qualify a claim', () => {
    const fixture = makeFixture();
    fixture.read.sources.find(source => source.id === 'claim-page')!.availableAt = '2026-10-01T11:44:59.999Z';
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A01').quality, 'MISSING');
    assert.equal(feature(rows, 'A01').value, null);
  });

  await t.test('a market or narrative page mislabeled as a social post leaves sample metrics unknown', () => {
    const fixture = makeFixture();
    fixture.read.sources.find(source => source.id === 'post-source-1')!.kind = 'PAGE';
    const rows = assessment(fixture);
    for (const id of ['A15', 'A16', 'A17']) {
      assert.equal(row(rows, id).quality, 'MISSING', id);
      assert.equal(feature(rows, id).value, null, id);
    }
  });

  await t.test('missing timestamp or source-account metadata leaves sample metrics unknown', () => {
    for (const field of ['publishedAt', 'authorId'] as const) {
      const fixture = makeFixture();
      fixture.read.sources.find(source => source.id === 'post-source-1')![field] = null;
      const rows = assessment(fixture);
      assert.equal(row(rows, 'A15').quality, 'MISSING', field);
      assert.equal(row(rows, 'A17').quality, 'MISSING', field);
    }
  });

  await t.test('an uncertain post role prevents a complete sample claim', () => {
    const fixture = makeFixture();
    (fixture.proposal as { posts: Array<{ id: string; role: string }> }).posts[0]!.role = 'UNCLEAR';
    const rows = assessment(fixture);
    for (const id of ['A15', 'A16', 'A17']) {
      assert.equal(row(rows, id).quality, 'MISSING', id);
      assert.equal(feature(rows, id).value, null, id);
    }
  });
});

test('review decisions must cover every proposal item exactly once', async t => {
  await t.test('a missing decision fails closed for the proposal batch', () => {
    const fixture = makeFixture();
    (fixture.review as { decisions: unknown[] }).decisions.pop();
    const rows = assessment(fixture);
    for (const id of ['A01', 'A09', 'A15']) {
      assert.equal(row(rows, id).quality, 'MISSING', id);
      assert.equal(feature(rows, id).value, null, id);
    }
  });

  await t.test('a duplicate decision fails closed for the proposal batch', () => {
    const fixture = makeFixture();
    const decisions = (fixture.review as { decisions: Array<{ id: string; accepted: boolean; rationale: string }> }).decisions;
    decisions[1] = { ...decisions[0]! };
    const rows = assessment(fixture);
    for (const id of ['A01', 'A09', 'A15']) assert.equal(row(rows, id).quality, 'MISSING', id);
  });
});

test('competitor identity and leadership depend on a complete comparable source sample', async t => {
  await t.test('coverage accepts reordered exact source membership while preserving ordered requirements', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    const sourceIds = [...fixture.read.comparisonSourceIds!].reverse();
    assert.ok(sourceIds.length > 1, 'the fixture can distinguish set membership from order');
    fixture.read.comparisonCoverage = {
      method: 'required-comparison-evidence-v1', sourceIds,
      sourceRequirements: sourceIds.map(sourceId => ({ sourceId, obligation: 'REQUIRED', parentLeadIds: [], reasons: ['ORIGINAL_COMPARISON'] })),
      batches: [
        { batch: 1, sourceIds: sourceIds.slice(0, 8), proposalResponseId: 'proposal-1', reviewResponseId: 'review-1', rawComplete: true, effectiveComplete: true, blockingSourceIds: [] },
        { batch: 2, sourceIds: sourceIds.slice(8), proposalResponseId: 'proposal-2', reviewResponseId: 'review-2', rawComplete: true, effectiveComplete: true, blockingSourceIds: [] },
      ],
      finalReviewResponseId: 'final-review', complete: true,
    };

    const rows = assessment(fixture);
    assert.equal(row(rows, 'A09').quality, 'KNOWN', JSON.stringify({
      comparisonComplete: fixture.read.comparisonComplete,
      readSourceIds: fixture.read.comparisonSourceIds,
      coverageSourceIds: fixture.read.comparisonCoverage.sourceIds,
      requirements: fixture.read.comparisonCoverage.sourceRequirements.map(item => item.sourceId),
      a09: row(rows, 'A09'),
    }));
    assert.equal(row(rows, 'A10').quality, 'KNOWN');
    assert.equal(row(rows, 'A11').quality, 'KNOWN');

    fixture.read.comparisonCoverage!.sourceRequirements.reverse();
    const reorderedRequirements = assessment(fixture);
    assert.equal(row(reorderedRequirements, 'A09').quality, 'MISSING',
      'requirements must stay aligned to coverage source order even though source membership is order independent');
  });

  await t.test('a source association cannot qualify a syntactically invalid chain address', () => {
    const fixture = makeFixture();
    const invalidAddress = `0x${'2'.repeat(39)}g`;
    const competitors = (fixture.proposal as { competitors: Array<{ id: string; token: TokenRef; sourceId: string; quote: string }> }).competitors;
    const bad = competitors[1]!;
    bad.token = { ...bad.token, address: invalidAddress };
    bad.quote = `Synthetic source connects ${TOKEN.address} and ${invalidAddress} to the same named narrative.`;
    fixture.read.sources.find(source => source.id === bad.sourceId)!.text = bad.quote;

    const rows = assessment(fixture);
    for (const id of ['A09', 'A10', 'A11', 'A14']) assert.equal(row(rows, id).quality, 'MISSING', id);
    const candidates = (row(rows, 'A09').data as { candidates: Array<{ token: TokenRef }> }).candidates;
    assert.equal(candidates.some(candidate => candidate.token.address === invalidAddress), false);
  });

  await t.test('an invented competitor address cannot complete candidate coverage', () => {
    const fixture = makeFixture();
    const competitors = (fixture.proposal as { competitors: Array<{ id: string; token: TokenRef; sourceId: string; quote: string }> }).competitors;
    competitors[1]!.quote = `Synthetic text mentions no contract for ${OTHER.address.slice(0, 6)}.`;
    const rows = assessment(fixture);
    for (const id of ['A09', 'A10', 'A11', 'A14']) {
      assert.equal(row(rows, id).quality, 'MISSING', id);
      assert.equal(feature(rows, id).value, null, id);
    }
  });

  await t.test('a discovered singleton is complete scoped enumeration without a global absence claim', () => {
    const fixture = makeFixture();
    const proposal = fixture.proposal as { claims: unknown[]; posts: unknown[]; competitors: Array<{ id: string }> };
    proposal.competitors = [proposal.competitors[0]!];
    const review = fixture.review as { decisions: Array<{ id: string; accepted: boolean; rationale: string }> };
    review.decisions = review.decisions.filter(decision => decision.id !== 'competitor-other');
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A09').quality, 'KNOWN');
    assert.equal(row(rows, 'A10').quality, 'KNOWN');
    assert.equal(feature(rows, 'A09').value, true);
    assert.match((row(rows, 'A09').data as { scope: string }).scope, /absence outside this sample is not established/);
    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.equal(row(rows, 'A14').quality, 'MISSING');
  });

  await t.test('ties do not promote a target as an uncontested leader', () => {
    const fixture = makeFixture();
    const posts = (fixture.proposal as { posts: Array<{ sourceId: string; quote: string; role: string }> }).posts;
    for (const [index, post] of posts.entries()) {
      const original = index === 10 ? 0 : index;
      const quote = `Synthetic post ${original} for ${TOKEN.address} and ${OTHER.address} in one narrative.`;
      post.quote = quote;
      fixture.read.sources.find(source => source.id === post.sourceId)!.text = post.quote;
    }
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'KNOWN');
    assert.equal(feature(rows, 'A11').value, true);
    assert.equal((row(rows, 'A11').data as { tied: boolean }).tied, true);
    assert.equal(row(rows, 'A14').quality, 'KNOWN');
    assert.equal(feature(rows, 'A14').value, false);
  });

  await t.test('no substantive posts produces no comparison denominator or leadership verdict', () => {
    const fixture = makeFixture();
    const posts = (fixture.proposal as { posts: Array<{ role: string }> }).posts;
    for (const post of posts) post.role = 'PRICE_ONLY';
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A16').quality, 'KNOWN');
    assert.equal(feature(rows, 'A16').value, '0');
    assert.equal(row(rows, 'A17').quality, 'KNOWN');
    assert.equal(feature(rows, 'A17').value, '0');
    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.equal(row(rows, 'A14').quality, 'MISSING');
    assert.equal((row(rows, 'A11').data as { shares: Array<{ share: string | null }> }).shares.every(item => item.share === null), true);
    assert.equal(attentionPolicyStatus(rows), 'FAIL', 'a complete nonempty sample with zero qualified posts is a measured shortfall');
  });
});

test('a PAGE-only corpus leaves post sample metrics unavailable and policy unknown', () => {
  const fixture = makeFixture();
  fixture.read.sources = fixture.read.sources.filter(source => source.kind === 'PAGE');
  (fixture.proposal as { posts: unknown[] }).posts = [];
  (fixture.review as { decisions: Array<{ id: string }> }).decisions =
    (fixture.review as { decisions: Array<{ id: string }> }).decisions.filter(decision => !decision.id.startsWith('post-label-'));

  const rows = assessment(fixture);
  for (const id of ['A15', 'A16', 'A17']) {
    assert.equal(row(rows, id).quality, 'MISSING', id);
    assert.equal(feature(rows, id).value, null, id);
    assert.equal(row(rows, id).causes[0]?.code, 'ATT_POST_CORPUS_UNAVAILABLE', id);
    assert.equal((row(rows, id).data as { sampleProblems: { corpusEmpty: boolean } }).sampleProblems.corpusEmpty, true, id);
  }
  assert.equal(attentionPolicyStatus(rows), 'UNKNOWN');
});

test('partial search outcomes preserve cited narrative assertions and keep absent attention coverage unknown', () => {
  const fixture = makeFixture();
  fixture.read.complete = false;
  fixture.read.codes = ['ATT_FETCH_URL_ERROR'];
  const rows = assessment(fixture);
  assert.equal(row(rows, 'A01').quality, 'KNOWN');
  assert.equal(feature(rows, 'A01').value, true);
  for (const id of ['A09', 'A10', 'A11', 'A14', 'A15', 'A16', 'A17']) {
    assert.equal(row(rows, id).quality, 'MISSING', id);
    assert.equal(feature(rows, id).value, null, id);
  }
});

test('qualified attention thresholds distinguish measured shortfall from legacy missing coverage', () => {
  const features = completeFixtureEntryFeatures().map(item => item.id === 'A15'
    ? { ...item, value: null, quality: 'MISSING' as const }
    : item);
  const profile: Profile = {
    id: 'synthetic-attention-profile', sizeUsd: '10', horizonSeconds: 3600,
    risk: {
      maxTransferFeeBps: '100', maxDirectControlShare: '0.2', maxEntryImpactBps: '100',
      maxExitImpactBps: '100', maxRoundTripLossBps: '500', maxRemovableLiquidityShare: '0.5',
    }, stage: { ageBands: [] },
  };
  const legacy = evaluateEntry(features, profile, CUTOFF, 'LEGACY');
  const qualified = evaluateEntry(features, profile, CUTOFF, 'QUALIFIED');
  assert.equal(legacy.checks.find(check => check.checkId === 'ATT-01')?.status, 'PASS');
  assert.equal(qualified.checks.find(check => check.checkId === 'ATT-01')?.status, 'UNKNOWN');

  const measuredShortfall = features.map(item => item.id === 'A15' ? { ...item, value: true, quality: 'KNOWN' as const }
    : item.id === 'A16' ? { ...item, value: '9', quality: 'KNOWN' as const }
      : item.id === 'A17' ? { ...item, value: '2', quality: 'KNOWN' as const } : item);
  const shortfall = evaluateEntry(measuredShortfall, profile, CUTOFF, 'QUALIFIED');
  assert.equal(shortfall.checks.find(check => check.checkId === 'ATT-01')?.status, 'FAIL');
  assert.equal(shortfall.classification, 'WATCH');
});

test('v2 CAN-02 evaluates origin relationship separately from measured attention leadership', async t => {
  await t.test('dated post from an account matching the accepted A03 project profile supports origin while measured leadership stays unknown', () => {
    const fixture = makeV2Fixture('SUPPORTED', false);
    const rows = assessment(fixture);
    const a03 = row(rows, 'A03');
    assert.equal(a03.quality, 'KNOWN');
    assert.equal(feature(rows, 'A03').value, true);
    const a03Citation = (a03.data as { citations: Array<{ sourceId: string }> }).citations[0]!;
    const profile = fixture.read.sources.find(source => source.id === a03Citation.sourceId)!;
    const projectPost = fixture.read.sources.find(source => source.id === 'project-origin-post')!;
    assert.equal(profile.url, 'https://x.com/river_lantern_project');
    assert.equal(profile.kind, 'PAGE');
    assert.equal(profile.authorId, null, 'a canonical project profile URL can bind to its dated status account');
    assert.equal(projectPost.authorId, 'x.com:river_lantern_project');

    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.equal(feature(rows, 'A11').value, null);
    assert.equal(row(rows, 'A14').quality, 'KNOWN');
    assert.equal(feature(rows, 'A14').value, true);
    const routes = row(rows, 'A14').data as { originRelationship: { status: string }; measuredAttention: { status: string }; basis: string };
    assert.deepEqual([routes.originRelationship.status, routes.measuredAttention.status, routes.basis], ['SUPPORTED', 'UNKNOWN', 'ORIGIN']);

    const features = new Map(completeFixtureEntryFeatures().map(item => [item.id, item]));
    for (const item of rows) if (item.projection) features.set(item.id, item.projection);
    assert.equal(evaluateEntry([...features.values()], illustrativeUncalibratedProfile, CUTOFF, 'QUALIFIED_V2')
      .checks.find(check => check.checkId === 'CAN-02')?.status, 'PASS');
  });

  await t.test('unique measured leadership supports CAN-02 even when origin relationship is unknown', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'KNOWN');
    assert.equal(feature(rows, 'A11').value, true, 'A11 reports measured leadership only');
    const routes = row(rows, 'A14').data as { originRelationship: { status: string }; measuredAttention: { status: string }; basis: string };
    assert.deepEqual([routes.originRelationship.status, routes.measuredAttention.status, routes.basis], ['UNKNOWN', 'SUPPORTED', 'MEASURED_ATTENTION']);
    assert.equal(feature(rows, 'A14').value, true);
  });

  await t.test('a valid explicit disavowal and a known measured shortfall are both required for A14 false', () => {
    const fixture = makeV2Fixture('CONTRADICTED', true);
    setComparativePattern(fixture, 'RIVAL_LEADS');
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'KNOWN');
    assert.equal(feature(rows, 'A11').value, false, 'the target has no unique lead in the complete common-query sample');
    assert.equal(row(rows, 'A14').quality, 'KNOWN');
    assert.equal(feature(rows, 'A14').value, false);
    const routes = row(rows, 'A14').data as { originRelationship: { status: string; citations: Array<{ sourceId: string }> }; measuredAttention: { status: string } };
    assert.equal(routes.originRelationship.status, 'CONTRADICTED');
    assert.equal(routes.originRelationship.citations[0]?.sourceId, 'project-disavowal-post');
    assert.equal(routes.measuredAttention.status, 'CONTRADICTED');
  });

  await t.test('unknown origin plus a known nonleader result remains unknown', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'RIVAL_LEADS');
    const rows = assessment(fixture);
    assert.equal(feature(rows, 'A11').value, false);
    assert.equal(row(rows, 'A14').quality, 'MISSING');
    assert.equal(feature(rows, 'A14').value, null);
  });
});

test('source-bound measured positives use the canonical qualified common-query posts', () => {
  const fixture = makeV2Fixture('UNKNOWN', true);
  setComparativePattern(fixture, 'TARGET_LEADS');
  fixture.read.leadershipPositiveMethod = 'source-bound-positive-v1';
  const routes = leadershipEntryCriterion(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF) as {
    originRelationship: { status: string };
    measuredAttention: { status: string; sourceIds: string[] };
    reviewedPosts: Array<{ sourceId: string; quote: string }>;
  };

  assert.equal(routes.originRelationship.status, 'UNKNOWN');
  assert.equal(routes.measuredAttention.status, 'SUPPORTED');
  const options = leadershipOptions(fixture.read, TOKEN, CUTOFF, routes);
  assert.ok(options.measured.length >= 10, 'the model receives only cited posts from the canonically supported common-query ranking');
  const selected = options.measured[0]!;
  const source = fixture.read.sources.find(item => item.id === selected.sourceId)!;
  const quote = routes.reviewedPosts.find(post => post.sourceId === source.id)!.quote;
  assert.equal(source.text, quote);
  assert.equal(validateLeadershipPositive(fixture.read, TOKEN, CUTOFF, {
    verdict: 'PASS', basis: 'MEASURED_ATTENTION', citations: [{ sourceId: source.id, quote }],
  }, routes), true);
  assert.equal(validateLeadershipPositive(fixture.read, TOKEN, CUTOFF, {
    verdict: 'PASS', basis: 'MEASURED_ATTENTION', citations: [{ sourceId: source.id, quote }],
  }, { ...routes, measuredAttention: { status: 'UNKNOWN', sourceIds: routes.measuredAttention.sourceIds } }), false,
  'a reviewed source is not a positive measurement option without the canonical SUPPORTED route');
});

test('v2 measured leadership uses only complete common-query posts in-window with ten posts, three accounts, two candidates, and a unique leader', async t => {
  await t.test('target-zero nonleader remains a measured false result', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'RIVAL_LEADS');
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'KNOWN');
    assert.equal(feature(rows, 'A11').value, false);
    const ranking = row(rows, 'A11').data as { shares: Array<{ token: TokenRef; count: string }>; tied: boolean };
    assert.equal(ranking.shares.find(item => item.token.address === TOKEN.address)?.count, '0');
    assert.equal(ranking.tied, false);
  });

  await t.test('a tie is known but never reports unique leadership', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'TIED');
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'KNOWN');
    assert.equal(feature(rows, 'A11').value, false);
    assert.equal((row(rows, 'A11').data as { tied: boolean }).tied, true);
    assert.equal((row(rows, 'A14').data as { measuredAttention: { status: string } }).measuredAttention.status, 'CONTRADICTED');
  });

  await t.test('nine qualifying common-query posts are insufficient even across three accounts', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'NINE_QUALIFIED');
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.equal(feature(rows, 'A11').value, null);
  });

  await t.test('fewer than three common-query accounts are insufficient', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    for (const source of fixture.read.sources.filter(item => item.id.startsWith('post-source-'))) source.authorId = 'x.com:shared-account';
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'MISSING');
  });

  await t.test('old common-query posts outside the identical window cannot establish leadership', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    for (const source of fixture.read.sources.filter(item => item.id.startsWith('post-source-'))) source.publishedAt = '2026-09-30T11:59:00.000Z';
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.equal(row(rows, 'A14').quality, 'MISSING');
  });

  await t.test('target-focused posts outside common-query source IDs are excluded', () => {
    const fixture = makeV2Fixture('UNKNOWN', false);
    setComparativePattern(fixture, 'TARGET_LEADS');
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.deepEqual((row(rows, 'A11').data as { sourceIds: string[] }).sourceIds, []);
  });

  await t.test('a target-only duplicate seen first cannot erase a common-query original from its own sample', () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    const firstCommon = fixture.read.sources.find(source => source.id === 'post-source-1')!;
    const targetOnly: AttentionSource = {
      ...firstCommon, id: 'target-only-duplicate', url: 'https://x.com/target_search/status/999', authorId: 'x.com:target_search',
    };
    fixture.read.sources.splice(fixture.read.sources.indexOf(firstCommon), 0, targetOnly);
    (fixture.proposal as { posts: Array<{ id: string; sourceId: string; quote: string; role: string }> }).posts.unshift({
      id: 'target-only-duplicate-label', sourceId: targetOnly.id,
      quote: (fixture.proposal as { posts: Array<{ sourceId: string; quote: string }> }).posts.find(post => post.sourceId === firstCommon.id)!.quote,
      role: 'NEWS',
    });
    (fixture.review as { decisions: Array<{ id: string; accepted: boolean; rationale: string }> }).decisions.push({
      id: 'target-only-duplicate-label', accepted: true, rationale: 'A target-focused original is separately reviewed.'
    });
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A11').quality, 'KNOWN');
    assert.equal(feature(rows, 'A11').value, true);
    const ranking = row(rows, 'A11').data as { sourceIds: string[] };
    assert.equal(ranking.sourceIds.length, 10, 'the complete common sample retains ten distinct originals');
    assert.equal(ranking.sourceIds.includes(targetOnly.id), false, 'target-only posts never enter comparison counts');
  });

  await t.test('incomplete comparison acquisition prevents both CAN-01 and leadership qualification', () => {
    const fixture = makeV2Fixture('SUPPORTED', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    fixture.read.comparisonComplete = false;
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A09').quality, 'MISSING');
    assert.equal(row(rows, 'A10').quality, 'MISSING');
    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.equal(row(rows, 'A14').quality, 'KNOWN');
    assert.equal(feature(rows, 'A14').value, true, 'the separately qualified origin route remains visible');
  });
});

test('recovered comparison posts do not enter the original leadership or general post sample', () => {
  const makeQualifiedTargetLeader = () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    return fixture;
  };
  const baseline = makeQualifiedTargetLeader();
  const baselineRows = assessment(baseline);
  const expectedA15 = row(baselineRows, 'A15').data as { raw: number };
  const expectedA16 = row(baselineRows, 'A16').data as { qualified: number };
  const expectedAuthors = (row(baselineRows, 'A17').data as { authors: string[] }).authors;

  const fixture = makeQualifiedTargetLeader();
  const originalRankingIds = [...fixture.read.comparisonSourceIds!];
  const originalPostIds = fixture.read.sources.filter(source => source.kind === 'POST').map(source => source.id);
  fixture.read.comparisonRankingSourceIds = originalRankingIds;
  fixture.read.postSampleSourceIds = originalPostIds;
  const proposal = fixture.proposal as { posts: Array<{ id: string; sourceId: string; quote: string; role: string }> };
  const review = fixture.review as { decisions: Array<{ id: string; accepted: boolean; rationale: string }> };
  const recovered = Array.from({ length: 20 }, (_, index) => {
    const author = `recovery${index % 3 + 1}`;
    const id = `recovery-post-${index + 1}`;
    const quote = `A targeted recovery post promotes only rival contract ${OTHER.address}.`;
    const source: AttentionSource = {
      id, url: `https://x.com/${author}/status/${1000 + index}`, text: quote,
      publishedAt: `2026-10-01T10:${String(index).padStart(2, '0')}:00.000Z`,
      authorId: `x.com:${author}`, availableAt: FRESH, kind: 'POST',
    };
    proposal.posts.push({ id: `recovery-label-${index + 1}`, sourceId: id, quote, role: 'NEWS' });
    review.decisions.push({ id: `recovery-label-${index + 1}`, accepted: true, rationale: 'The exact targeted post text is accepted for its source role.' });
    return source;
  });
  fixture.read.sources.push(...recovered);
  fixture.read.comparisonSourceIds = [...originalRankingIds, ...recovered.map(source => source.id)];

  const rows = assessment(fixture);
  const ranking = row(rows, 'A11').data as { sourceIds: string[]; shares: Array<{ token: TokenRef; count: string }> };
  const targetShare = ranking.shares.find(item => item.token.address === TOKEN.address)?.count;
  const rivalShare = ranking.shares.find(item => item.token.address === OTHER.address)?.count;

  assert.equal(row(rows, 'A11').quality, 'KNOWN');
  assert.equal(feature(rows, 'A11').value, true, 'twenty recovery-only rival posts cannot reverse the original common-query leader');
  assert.ok(Number(targetShare) > Number(rivalShare));
  assert.equal(ranking.sourceIds.some(id => id.startsWith('recovery-post-')), false);
  assert.equal((row(rows, 'A15').data as { raw: number }).raw, expectedA15.raw);
  assert.equal((row(rows, 'A16').data as { qualified: number }).qualified, expectedA16.qualified);
  assert.deepEqual((row(rows, 'A17').data as { authors: string[] }).authors, expectedAuthors);
});

test('v2 origin support requires an accepted exact-contract A03 and a linked dated primary POST citation', async t => {
  await t.test('an unaccepted A03 cannot support the separate origin route', () => {
    const fixture = makeV2Fixture('SUPPORTED', false);
    (fixture.review as { decisions: Array<{ id: string; accepted: boolean }> }).decisions.find(item => item.id === 'claim-3')!.accepted = false;
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A03').quality, 'MISSING');
    assert.equal(row(rows, 'A14').quality, 'MISSING');
    assert.equal((row(rows, 'A14').data as { originRelationship: { status: string } }).originRelationship.status, 'UNKNOWN');
  });

  await t.test('a page citation cannot stand in for a dated project POST', () => {
    const fixture = makeV2Fixture('SUPPORTED', false);
    const review = fixture.review as { originRelationship: { citations: Array<{ sourceId: string; quote: string }> } };
    const page = fixture.read.sources.find(item => item.id === 'competitor-page')!;
    review.originRelationship.citations = [{ sourceId: page.id, quote: (fixture.proposal as { competitors: Array<{ sourceId: string; quote: string }> }).competitors[0]!.quote }];
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A14').quality, 'MISSING');
    assert.equal((row(rows, 'A14').data as { originRelationship: { status: string } }).originRelationship.status, 'UNKNOWN');
  });

  await t.test('origin quote must itself name the target contract', () => {
    const fixture = makeV2Fixture('SUPPORTED', false);
    const post = fixture.read.sources.find(item => item.id === 'project-origin-post')!;
    const phrase = 'in a dated project update.';
    assert.ok(post.text.includes(phrase));
    (fixture.review as { originRelationship: { citations: Array<{ sourceId: string; quote: string }> } })
      .originRelationship.citations = [{ sourceId: post.id, quote: phrase }];
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A14').quality, 'MISSING');
    assert.equal((row(rows, 'A14').data as { originRelationship: { status: string } }).originRelationship.status, 'UNKNOWN');
  });

  await t.test('a reviewer-detected candidate omission keeps CAN-01 and measured leadership unknown', () => {
    const fixture = makeV2Fixture('SUPPORTED', true);
    setComparativePattern(fixture, 'TARGET_LEADS');
    (fixture.review as { candidateSet: { complete: boolean; rationale: string } }).candidateSet.complete = false;
    const rows = assessment(fixture);
    assert.equal(row(rows, 'A09').quality, 'MISSING');
    assert.equal(row(rows, 'A10').quality, 'MISSING');
    assert.equal(row(rows, 'A11').quality, 'MISSING');
    assert.equal(row(rows, 'A14').quality, 'KNOWN');
    assert.equal(feature(rows, 'A14').value, true, 'accepted origin remains independent of candidate-set completeness');
  });
});

test('v2 derivation requires independent candidate-set and origin relationship review fields', async t => {
  for (const field of ['candidateSet', 'originRelationship'] as const) await t.test(`missing ${field} invalidates the v2 review`, () => {
    const fixture = makeV2Fixture('UNKNOWN', true);
    const review = fixture.review as { candidateSet?: unknown; originRelationship?: unknown };
    delete review[field];
    const rows = assessment(fixture);
    for (const id of ['A09', 'A10', 'A11', 'A14']) {
      assert.equal(row(rows, id).quality, 'MISSING', id);
      assert.equal(row(rows, id).causes[0]?.code, 'ATT_REVIEW_SCOPE_COVERAGE_INVALID', id);
    }
    assert.equal((row(rows, 'A14').data as { method: string }).method, 'representation-routes-v2');
    assert.equal((row(rows, 'A14').data as { originRelationship: { status: string } }).originRelationship.status, 'UNKNOWN');
    assert.equal((row(rows, 'A14').data as { measuredAttention: { status: string } }).measuredAttention.status, 'UNKNOWN');
  });
});

test('new v2 snapshots use the v2 policy while research-screen-v1 and schema v1 replay keep frozen rules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'attention-policy-test-'));
  const path = join(directory, 'attention.sqlite');
  const features = completeFixtureEntryFeatures().map(item => item.id === 'A15' || item.id === 'A11'
    ? { ...item, value: null, quality: 'MISSING' as const }
    : item);
  const service = new Service(path);
  try {
    const current = service.analyze(fixtureBundle(features, illustrativeFixtureThesis));
    assert.equal(current.result.checks.find(check => check.checkId === 'ATT-01')?.status, 'UNKNOWN');
    assert.equal(current.result.checks.find(check => check.checkId === 'CAN-02')?.status, 'PASS', 'new snapshots use A14 v2 routes rather than requiring legacy A11 as well');
    assert.deepEqual(service.replay(current.id), current);
    service.close();

    const db = new DatabaseSync(path);
    let v1Hash = '';
    try {
      db.exec('DROP TRIGGER snapshots_no_update');
      const stored = db.prepare('SELECT payload,semantic FROM snapshots WHERE id=?').get(current.id) as { payload: string; semantic: string };
      const payload = JSON.parse(stored.payload) as Record<string, unknown> & { result: ReturnType<typeof evaluateEntry>; hash: string };
      const semantic = JSON.parse(stored.semantic) as Record<string, unknown> & {
        features: FeatureResult[]; policyFeatures: FeatureResult[]; policyVersion: string; profile: Profile; cutoff: string; result: ReturnType<typeof evaluateEntry>;
      };
      assert.equal(semantic.policyVersion, 'research-screen-v2');
      semantic.policyVersion = 'research-screen-v1';
      semantic.result = evaluateEntry(semantic.policyFeatures, semantic.profile, semantic.cutoff, 'QUALIFIED');
      payload.result = semantic.result;
      payload.hash = decisionHash(semantic);
      v1Hash = payload.hash;
      db.prepare('UPDATE snapshots SET payload=?,hash=?,semantic=? WHERE id=?')
        .run(JSON.stringify(payload), payload.hash, JSON.stringify(semantic), current.id);
    } finally {
      db.close();
    }

    const v1Service = new Service(path);
    try {
      const v1 = v1Service.replay(current.id);
      assert.equal(v1.result.checks.find(check => check.checkId === 'ATT-01')?.status, 'UNKNOWN');
      assert.equal(v1.result.checks.find(check => check.checkId === 'CAN-02')?.status, 'UNKNOWN', 'the frozen v1 conjunction still requires A11');
      assert.equal(v1.hash, v1Hash);
    } finally {
      v1Service.close();
    }

    const legacyDb = new DatabaseSync(path);
    let legacyHash = '';
    try {
      legacyDb.exec('DROP TRIGGER snapshots_no_update');
      const stored = legacyDb.prepare('SELECT payload,semantic FROM snapshots WHERE id=?').get(current.id) as { payload: string; semantic: string };
      const payload = JSON.parse(stored.payload) as Record<string, unknown> & { result: ReturnType<typeof evaluateEntry>; hash: string };
      const semantic = JSON.parse(stored.semantic) as Record<string, unknown> & {
        features: FeatureResult[]; profile: Profile; cutoff: string; result: ReturnType<typeof evaluateEntry>;
      };
      semantic.schemaVersion = 1;
      delete semantic.policyVersion;
      delete semantic.policyFeatures;
      semantic.result = evaluateEntry(semantic.features, semantic.profile, semantic.cutoff, 'LEGACY');
      payload.result = semantic.result;
      payload.hash = decisionHash(semantic);
      legacyHash = payload.hash;
      legacyDb.prepare('UPDATE snapshots SET payload=?,hash=?,semantic=? WHERE id=?')
        .run(JSON.stringify(payload), payload.hash, JSON.stringify(semantic), current.id);
    } finally {
      legacyDb.close();
    }

    const reopened = new Service(path);
    try {
      const legacy = reopened.replay(current.id);
      assert.equal(legacy.result.checks.find(check => check.checkId === 'ATT-01')?.status, 'PASS');
      assert.equal(legacy.hash, legacyHash);
    } finally {
      reopened.close();
    }
  } finally {
    try { service.close(); } catch { /* already closed before legacy conversion */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('structured A05 preserves both known judgments and keeps inconsistent or stale claims unknown', async t => {
  const explanation = {
    referent: 'The synthetic River Lantern launchpad',
    interest: 'Trade fees are removed from circulation.',
    tokenRelation: `This exact token ${TOKEN.address} pays those fees.`,
    prerequisites: [],
  };

  await t.test('accepted true and false values preserve the explanation and review in assessment data', () => {
    for (const value of [true, false]) {
      const fixture = makeFixture();
      const claims = (fixture.proposal as { claims: Array<Record<string, any>> }).claims;
      const claim = claims.find(item => item.feature === 'A05')!;
      const prerequisites = value ? [] : ['A launchpad is a platform for trading new tokens; that meaning is needed to understand the sentence.'];
      claim.value = value;
      claim.explanation = { ...explanation, prerequisites };
      const rows = assessment(fixture);
      const a05 = row(rows, 'A05');
      assert.equal(a05.quality, 'KNOWN');
      assert.equal(feature(rows, 'A05').value, value);
      const data = a05.data as { summary: string; explanation: unknown; citations: unknown[]; review: { accepted: boolean } };
      assert.equal(data.summary, claim.summary);
      assert.deepEqual(data.explanation, { ...explanation, prerequisites });
      assert.equal(data.citations[0] && (data.citations[0] as { sourceId: string }).sourceId, 'claim-page');
      assert.equal(data.review.accepted, true);
    }
  });

  await t.test('a structured value/list mismatch cannot become known even after acceptance', () => {
    const fixture = makeFixture();
    const claim = (fixture.proposal as { claims: Array<Record<string, any>> }).claims.find(item => item.feature === 'A05')!;
    claim.value = true;
    claim.explanation = { ...explanation, prerequisites: ['An indispensable concept is stated in the source and remains unexplained.'] };
    const a05 = row(assessment(fixture), 'A05');
    assert.equal(a05.quality, 'MISSING');
    assert.equal(a05.projection?.value, null);
    assert.equal(a05.causes[0]?.code, 'ATT_QUALIFICATION_EXPLANATION_INVALID');
    const data = a05.data as { proposedSummary: string; explanation: unknown; citations: unknown[]; review: { accepted: boolean } };
    assert.equal(data.proposedSummary, claim.summary);
    assert.deepEqual(data.explanation, claim.explanation);
    assert.equal((data.citations[0] as { sourceId: string }).sourceId, 'claim-page');
    assert.equal(data.review.accepted, true);
  });

  await t.test('stale and non-present exact citations cannot qualify structured A05', async nested => {
    for (const attack of ['stale', 'quote not present'] as const) await nested.test(attack, () => {
      const fixture = makeFixture();
      const claim = (fixture.proposal as { claims: Array<Record<string, any>> }).claims.find(item => item.feature === 'A05')!;
      claim.explanation = explanation;
      if (attack === 'stale') fixture.read.sources.find(source => source.id === 'claim-page')!.availableAt = '2026-10-01T11:44:59.999Z';
      else (claim.citations as Array<{ quote: string }>)[0]!.quote = 'A source quotation that is not present in retained text.';
      const a05 = row(assessment(fixture), 'A05');
      assert.equal(a05.quality, 'MISSING');
      assert.equal(a05.projection?.value, null);
      assert.equal(a05.causes[0]?.code, 'ATT_CITATION_BINDING_INVALID');
    });
  });
});

test('Service saves, reopens, and replays structured A05 beside an unchanged unstructured legacy claim', () => {
  const makeLiveBundle = (attention: BaselineAssessment[]): LiveBundle => {
    const profile = illustrativeUncalibratedProfile;
    const baseline = deriveBaseline({ token: TOKEN, cutoff: CUTOFF, profile, features: [], evidence: [], observations: [], attention });
    return {
      token: TOKEN, cutoff: CUTOFF, analysisKind: 'LIVE', evidence: [], rawArtifacts: {}, observations: [], features: [], profile,
      collection: { rpc: { state: 'UNAVAILABLE', code: 'SYNTHETIC_OFFLINE' }, dex: { state: 'UNAVAILABLE', code: 'SYNTHETIC_OFFLINE' }, web: { state: 'KEY_MISSING' } },
      semantic: { status: 'NOT_REQUESTED', claims: [] }, market: null,
      details: { version: 1, profile, thesis: null, baseline, origins: {}, stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null } },
    };
  };
  const buildAttention = (structured: boolean) => {
    const fixture = makeFixture();
    fixture.read.comparisonComplete = true;
    (fixture.review as { candidateSet?: unknown; originRelationship?: unknown }).candidateSet = {
      complete: true, rationale: 'Every synthetic exact-contract representation is accounted for in this test fixture.',
    };
    (fixture.review as { candidateSet?: unknown; originRelationship?: unknown }).originRelationship = {
      status: 'UNKNOWN', citations: [], rationale: 'No synthetic dated primary project post resolves origin.',
    };
    if (structured) {
      const claim = (fixture.proposal as { claims: Array<Record<string, any>> }).claims.find(item => item.feature === 'A05')!;
      claim.explanation = {
        referent: 'The synthetic River Lantern launchpad', interest: 'Trade fees are removed from circulation.',
        tokenRelation: `This exact token ${TOKEN.address} pays those fees.`, prerequisites: [],
      };
    }
    return deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF, []);
  };
  const directory = mkdtempSync(join(tmpdir(), 'attention-a05-replay-'));
  const path = join(directory, 'attention.sqlite');
  const structuredRows = buildAttention(true);
  const legacyRows = buildAttention(false);
  try {
    let structuredId = '';
    let legacyId = '';
    let structuredHash = '';
    let legacyHash = '';
    const service = new Service(path);
    try {
      const structured = service.analyzeLive(makeLiveBundle(structuredRows));
      const legacy = service.analyzeLive(makeLiveBundle(legacyRows));
      structuredId = structured.id;
      legacyId = legacy.id;
      structuredHash = structured.hash;
      legacyHash = legacy.hash;
      const structuredData = structured.details!.baseline.find(item => item.id === 'A05')!.data as { explanation?: unknown };
      const legacyData = legacy.details!.baseline.find(item => item.id === 'A05')!.data as { explanation?: unknown };
      assert.ok(structuredData.explanation);
      assert.equal('explanation' in legacyData, false, 'old snapshots are not backfilled with the new fields');
    } finally {
      service.close();
    }

    const reopened = new Service(path);
    try {
      const structuredReplay = reopened.replay(structuredId);
      const legacyReplay = reopened.replay(legacyId);
      assert.equal(structuredReplay.hash, structuredHash);
      assert.equal(legacyReplay.hash, legacyHash);
      assert.deepEqual(structuredReplay.details!.baseline.find(item => item.id === 'A05')!.data,
        structuredRows.find(item => item.id === 'A05')!.data);
      assert.deepEqual(legacyReplay.details!.baseline.find(item => item.id === 'A05')!.data,
        legacyRows.find(item => item.id === 'A05')!.data);
      assert.deepEqual(reopened.frozenDetails(structuredId).baseline.find(item => item.id === 'A05')!.data,
        structuredRows.find(item => item.id === 'A05')!.data);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh public-representation inadequacy establishes only CAN-01 failure while legacy derivation stays frozen', () => {
  const fixture = inadequateRepresentationFixture();
  const legacy = assessment(fixture);
  assert.equal(row(legacy, 'A09').quality, 'MISSING', 'the legacy path does not consume the new adequacy judgment');
  assert.equal(row(legacy, 'A10').quality, 'MISSING');
  assert.equal('evidenceAdequacy' in (row(legacy, 'A09').data as Record<string, unknown>), false);

  const qualified = deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF,
    ['evidence-sources', 'evidence-proposal', 'evidence-review'], true);
  assert.equal(row(qualified, 'A09').quality, 'KNOWN');
  assert.equal(feature(qualified, 'A09').value, false);
  assert.equal(row(qualified, 'A10').quality, 'MISSING', 'inadequacy does not invent a competitor or resolve token binding');
  assert.equal(feature(qualified, 'A10').value, null);
  assert.deepEqual((row(qualified, 'A09').data as { evidenceAdequacy: { citations: Array<{ sourceId: string }> } })
    .evidenceAdequacy.citations.map(citation => citation.sourceId), ['comparison-lead-1-metadata', 'current-profile']);

  const features = new Map(completeFixtureEntryFeatures({ A16: '12', A17: '4', A18: true, S10: true }).map(item => [item.id, item]));
  for (const item of qualified) if (item.projection) features.set(item.id, item.projection);
  const entry = evaluateEntry([...features.values()], illustrativeUncalibratedProfile, CUTOFF, 'QUALIFIED_V2');
  const can01 = entry.checks.find(check => check.checkId === 'CAN-01');
  assert.equal(can01?.status, 'FAIL', 'the qualified A09 contradiction is sufficient even while A10 remains missing');
  assert.deepEqual(can01?.featureRefs, ['A09', 'A10']);
});

test('public-representation inadequacy remains unknown without accepted, complete, literal, fresh source proof', () => {
  const cases: Array<{ name: string; mutate: (fixture: Fixture) => void }> = [
    { name: 'independent review rejects the assessment', mutate: fixture => {
      (fixture.read.comparisonQualification as { evidenceAdequacyReview: { accepted: boolean } }).evidenceAdequacyReview.accepted = false;
    } },
    { name: 'independent assessment is unresolved', mutate: fixture => {
      (fixture.read.comparisonQualification as { evidenceAdequacy: { verdict: string } }).evidenceAdequacy.verdict = 'UNRESOLVED';
    } },
    { name: 'assessment is omitted', mutate: fixture => {
      delete (fixture.read.comparisonQualification as { evidenceAdequacy?: unknown }).evidenceAdequacy;
    } },
    { name: 'the metadata citation is not literal in its own descriptor', mutate: fixture => {
      const qualification = fixture.read.comparisonQualification as { evidenceAdequacy: { citations: Array<{ quote: string }> } };
      qualification.evidenceAdequacy.citations[0]!.quote = 'A different indexed project descriptor not in this result.';
    } },
    { name: 'the fetched-context citation is not literal', mutate: fixture => {
      const qualification = fixture.read.comparisonQualification as { evidenceAdequacy: { citations: Array<{ quote: string }> } };
      qualification.evidenceAdequacy.citations[1]!.quote = 'A fetched mismatch that does not appear in the retained body.';
    } },
    { name: 'recovery-query lineage is absent', mutate: fixture => {
      fixture.read.comparisonAcquisition!.leads[0]!.recoveryQueryIds = [];
    } },
    { name: 'cited fetched source is outside the lead lineage', mutate: fixture => {
      fixture.read.comparisonAcquisition!.leads[0]!.sourceIds = [];
      fixture.read.comparisonAcquisition!.leads[0]!.recoverySourceIds = [];
    } },
    { name: 'recovery was capped', mutate: fixture => {
      (fixture.read.comparisonQualification as { recoveryCapped: boolean }).recoveryCapped = true;
    } },
    { name: 'descriptor scope is incomplete', mutate: fixture => {
      fixture.read.comparisonAcquisition!.descriptorComplete = false;
    } },
    { name: 'source acquisition reports a conflict', mutate: fixture => {
      fixture.read.comparisonAcquisition!.leads[0]!.acquisitionCodes = ['ATT_LEAD_CONFLICT'];
    } },
    { name: 'collector reports a descriptor cap', mutate: fixture => {
      fixture.read.codes = ['ATT_DESCRIPTOR_CAP'];
    } },
    { name: 'retained-length manifest is forged', mutate: fixture => {
      (fixture.read.comparisonQualification as { adequacySourceLengths: Array<{ retainedLength: number }> }).adequacySourceLengths[0]!.retainedLength--;
    } },
    { name: 'full fetched body exceeds the submitted source bound', mutate: fixture => {
      const source = fixture.read.sources.find(item => item.id === 'current-profile')!;
      source.text += 'x'.repeat(6001 - source.text.length);
      (fixture.read.comparisonQualification as { adequacySourceLengths: Array<{ retainedLength: number }> }).adequacySourceLengths[0]!.retainedLength = source.text.length;
    } },
    { name: 'fetched source is stale', mutate: fixture => {
      fixture.read.sources.find(item => item.id === 'current-profile')!.availableAt = new Date(Date.parse(CUTOFF) - 900_001).toISOString();
    } },
    { name: 'fetched source is from after the cutoff', mutate: fixture => {
      fixture.read.sources.find(item => item.id === 'current-profile')!.availableAt = new Date(Date.parse(CUTOFF) + 1).toISOString();
    } },
    { name: 'assessment cites a different lead', mutate: fixture => {
      (fixture.read.comparisonQualification as { evidenceAdequacy: { leadId: string } }).evidenceAdequacy.leadId = 'comparison-lead-99';
    } },
  ];

  for (const scenario of cases) {
    const fixture = inadequateRepresentationFixture();
    scenario.mutate(fixture);
    const rows = deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF,
      ['evidence-sources', 'evidence-proposal', 'evidence-review'], true);
    assert.equal(row(rows, 'A09').quality, 'MISSING', scenario.name);
    assert.equal(feature(rows, 'A09').value, null, scenario.name);
    assert.equal(row(rows, 'A10').quality, 'MISSING', scenario.name);
  }
});

test('leadership entry grades require the complete route and never replace factual origin or measured leadership', () => {
  const setScreening = (fixture: Fixture, verdict: 'INADEQUATE' | 'UNRESOLVED' = 'INADEQUATE') => {
    fixture.read.comparisonComplete = true;
    fixture.read.comparisonSourceIds = [];
    fixture.read.comparisonRankingSourceIds = [];
    fixture.read.originScope = {
      method: 'bounded-origin-sources-v1', complete: true, sourceIds: ['claim-page'],
      acquisition: fixture.read.originScope?.acquisition,
    };
    const review = fixture.review as Record<string, unknown>;
    review.candidateSet = { complete: false, rationale: 'No complete representation set supports a measured leadership judgment.' };
    review.originRelationship = { status: 'UNKNOWN', citations: [], rationale: 'No primary-origin relationship is supported.' };
    review.leadershipScreening = {
      method: 'reviewed-public-support-v1', verdict,
      rationale: 'The complete bounded origin and comparison evidence does not support the public entry criterion.',
      citations: [{ sourceId: 'claim-page', quote: fixture.read.sources.find(source => source.id === 'claim-page')!.text }],
      sourceIds: ['claim-page'],
      review: { accepted: true, rationale: 'The independent review accepts the bounded public-support assessment.' },
    };
  };
  const rowsFor = (fixture: Fixture) => deriveAttention(fixture.read, fixture.proposal, fixture.review, TOKEN, CUTOFF,
    ['evidence-sources', 'evidence-proposal', 'evidence-review']);

  const graded = inadequateOriginFixture();
  setScreening(graded);
  const gradedRows = rowsFor(graded);
  const a14 = row(gradedRows, 'A14');
  const grade = a14.data as { originRelationship: { status: string }; measuredAttention: { status: string }; leadershipScreening?: unknown; basis: string };
  assert.equal(a14.quality, 'KNOWN');
  assert.equal(feature(gradedRows, 'A14').value, false);
  assert.equal(grade.originRelationship.status, 'UNKNOWN');
  assert.equal(grade.measuredAttention.status, 'UNKNOWN');
  assert.ok(grade.leadershipScreening);
  assert.equal(grade.basis, 'EVIDENCE_INADEQUACY');

  const rejected = inadequateOriginFixture();
  setScreening(rejected);
  ((rejected.review as { leadershipScreening: { review: { accepted: boolean } } }).leadershipScreening.review).accepted = false;
  assert.equal(row(rowsFor(rejected), 'A14').quality, 'MISSING', 'a rejected independent grade stays unknown');

  const unresolved = inadequateOriginFixture();
  setScreening(unresolved, 'UNRESOLVED');
  assert.equal(row(rowsFor(unresolved), 'A14').quality, 'MISSING', 'an unresolved grade stays unknown');

  const incompleteOrigin = inadequateOriginFixture();
  setScreening(incompleteOrigin);
  incompleteOrigin.read.originScope!.complete = false;
  assert.equal(row(rowsFor(incompleteOrigin), 'A14').quality, 'MISSING', 'incomplete original evidence cannot produce the grade');

  const incompleteComparison = inadequateOriginFixture();
  setScreening(incompleteComparison);
  incompleteComparison.read.comparisonComplete = false;
  assert.equal(row(rowsFor(incompleteComparison), 'A14').quality, 'MISSING', 'incomplete comparison evidence cannot produce the grade');

  const unboundCitation = inadequateOriginFixture();
  setScreening(unboundCitation);
  ((unboundCitation.review as { leadershipScreening: { citations: Array<{ quote: string }> } }).leadershipScreening.citations[0]!).quote = 'A grade citation absent from the original source.';
  assert.equal(row(rowsFor(unboundCitation), 'A14').quality, 'MISSING', 'a nonliteral grade citation stays unknown');

  const originPrecedence = makeV2Fixture('SUPPORTED');
  const originSource = originPrecedence.read.sources.find(source => source.id === 'project-profile')!;
  originPrecedence.read.originScope = { method: 'bounded-origin-sources-v1', complete: true, sourceIds: [originSource.id] };
  (originPrecedence.review as Record<string, unknown>).leadershipScreening = {
    method: 'reviewed-public-support-v1', verdict: 'INADEQUATE',
    rationale: 'Synthetic adverse grade used to verify the separate factual route.',
    citations: [{ sourceId: originSource.id, quote: originSource.text }], sourceIds: [originSource.id],
    review: { accepted: true, rationale: 'The synthetic grade receives an independent acceptance.' },
  };
  const originRows = rowsFor(originPrecedence);
  const originGrade = row(originRows, 'A14').data as { originRelationship: { status: string }; leadershipScreening?: unknown; basis: string };
  assert.equal(feature(originRows, 'A14').value, true);
  assert.equal(originGrade.originRelationship.status, 'SUPPORTED');
  assert.equal(originGrade.basis, 'ORIGIN', 'supported factual origin takes precedence over a negative entry grade');
  assert.equal(originGrade.leadershipScreening, undefined, 'do not carry a contrary entry grade into qualified data');

  const measuredPrecedence = makeV2Fixture('UNKNOWN');
  setComparativePattern(measuredPrecedence, 'TARGET_LEADS');
  const measuredSource = measuredPrecedence.read.sources.find(source => source.id === 'project-profile')!;
  measuredPrecedence.read.originScope = { method: 'bounded-origin-sources-v1', complete: true, sourceIds: [measuredSource.id] };
  (measuredPrecedence.review as Record<string, unknown>).leadershipScreening = {
    method: 'reviewed-public-support-v1', verdict: 'INADEQUATE',
    rationale: 'Synthetic adverse grade used to verify the separate factual route.',
    citations: [{ sourceId: measuredSource.id, quote: measuredSource.text }], sourceIds: [measuredSource.id],
    review: { accepted: true, rationale: 'The synthetic grade receives an independent acceptance.' },
  };
  const measuredRows = rowsFor(measuredPrecedence);
  const measuredGrade = row(measuredRows, 'A14').data as { measuredAttention: { status: string }; leadershipScreening?: unknown; basis: string };
  assert.equal(feature(measuredRows, 'A14').value, true);
  assert.equal(measuredGrade.measuredAttention.status, 'SUPPORTED');
  assert.equal(measuredGrade.basis, 'MEASURED_ATTENTION', 'supported measured leadership takes precedence over a negative entry grade');
  assert.equal(measuredGrade.leadershipScreening, undefined, 'do not carry a contrary entry grade into qualified data');
});

test('task-v5 keeps reviewed origin traceability and leadership support as independent criteria', () => {
  const fixtureFor = (trace: 'INADEQUATE' | 'UNRESOLVED', leadership: 'INADEQUATE' | 'UNRESOLVED', accepted = true) => {
    const fixture = inadequateOriginFixture();
    const proposal = fixture.proposal as { claims: Array<{ id: string; feature: string }> };
    const origin = proposal.claims.find(claim => claim.feature === 'A03');
    assert.ok(origin);
    proposal.claims = proposal.claims.filter(claim => claim.feature !== 'A03');
    const review = fixture.review as {
      decisions: Array<{ id: string; accepted: boolean; rationale: string }>;
      candidateSet?: { complete: boolean; rationale: string };
      originRelationship?: { status: string; citations: Array<{ sourceId: string; quote: string }>; rationale: string };
      leadershipScreening?: unknown;
    };
    review.decisions = review.decisions.filter(decision => decision.id !== origin.id);
    review.candidateSet = { complete: false, rationale: 'The comparison sample is complete enough to review both public-support criteria.' };
    review.originRelationship = { status: 'UNKNOWN', citations: [], rationale: 'No dated primary-origin relationship is established.' };
    fixture.read.comparisonComplete = true;
    fixture.read.comparisonQualification = {
      mode: 'qualified-identified-leads-v3', wireMethod: 'comparison-lead-tasks-v5',
      supportScopeMethod: 'comparison-lead-support-scope-v4',
    };
    const scope = fixture.read.originScope!;
    const source = fixture.read.sources.find(item => item.id === scope.sourceIds[0]);
    assert.ok(source && scope.complete && scope.sourceIds.length > 0);
    const citation = { sourceId: source.id, quote: source.text };
    const judgment = (verdict: 'INADEQUATE' | 'UNRESOLVED') => ({ verdict,
      rationale: 'This criterion is independently assessed against the complete retained original source.', citations: [citation] });
    const assessmentReview = { accepted, rationale: accepted
      ? 'The independent review accepts this criterion on its own evidence.'
      : 'The independent review rejects this criterion on its own evidence.' };
    review.leadershipScreening = {
      method: 'reviewed-public-support-v2', verdict: leadership,
      rationale: 'The leadership criterion is reviewed independently from factual identity and origin traceability.',
      citations: [citation], sourceIds: [...scope.sourceIds],
      review: { ...assessmentReview, inspectionComplete: true, sourceIds: [...scope.sourceIds] },
      originTraceability: { ...judgment(trace), review: assessmentReview },
    };
    return fixture;
  };
  const rowsFor = (fixture: Fixture) => deriveAttention(fixture.read, fixture.proposal, fixture.review,
    TOKEN, CUTOFF, ['evidence-sources', 'evidence-proposal', 'evidence-review'], true);

  const traceOnly = rowsFor(fixtureFor('INADEQUATE', 'UNRESOLVED'));
  assert.equal(row(traceOnly, 'A03').quality, 'KNOWN');
  assert.equal(feature(traceOnly, 'A03').value, false);
  assert.equal((row(traceOnly, 'A03').data as { method: string }).method, 'origin-traceability-screen-v2');
  assert.equal(row(traceOnly, 'A14').quality, 'MISSING', 'origin traceability cannot substitute for leadership evidence');

  const leadershipOnly = rowsFor(fixtureFor('UNRESOLVED', 'INADEQUATE'));
  assert.equal(row(leadershipOnly, 'A03').quality, 'MISSING', 'a leadership grade cannot settle factual origin traceability');
  assert.equal(row(leadershipOnly, 'A14').quality, 'KNOWN');
  assert.equal(feature(leadershipOnly, 'A14').value, false);
  const leadershipData = row(leadershipOnly, 'A14').data as { leadershipScreening?: { method: string; originTraceability: { verdict: string } } };
  assert.equal(leadershipData.leadershipScreening?.method, 'reviewed-public-support-v2');
  assert.equal(leadershipData.leadershipScreening?.originTraceability.verdict, 'UNRESOLVED');

  const rejectedTrace = rowsFor(fixtureFor('INADEQUATE', 'UNRESOLVED', false));
  assert.equal(row(rejectedTrace, 'A03').quality, 'MISSING', 'a rejected origin-traceability judgment remains unknown');
});
