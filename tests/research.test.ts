import assert from 'node:assert/strict';
import test from 'node:test';
import { starterProfile } from '../src/app/config.js';
import { baselineIds, deriveBaseline, deriveCharts, deriveMarketContext, validateResearch, type BaselineInputs } from '../src/domain/baseline.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { researchPacketSchema, type ResearchPacket, type ResearchRecord } from '../src/domain/research.js';
import type { TokenRef } from '../src/domain/contracts.js';

const TOKEN: TokenRef = { chain: 'solana', address: 'So11111111111111111111111111111111111111112' };
const RIVAL: TokenRef = { chain: 'solana', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
const CUTOFF = '2026-09-29T03:00:00.000Z';
const AT = '2026-09-29T00:00:00.000Z';

type Review = ResearchPacket['reviews'][number];
const record = (id: string, text: string, tokenRefs: TokenRef[] = [TOKEN], publishedAt = '2026-09-29T00:15:00.000Z', overrides: Partial<ResearchRecord> = {}): ResearchRecord => ({
  id, platform: 'public-forum', url: `https://public.example/posts/${id}`, text, publishedAt,
  availableAt: CUTOFF, authorId: `author-${id}`, communityId: null, tokenRefs, ...overrides,
});
const review = (item: ResearchRecord, overrides: Partial<Review> = {}): Review => ({
  recordId: item.id, quote: item.text.slice(0, Math.min(item.text.length, 120)), reviewedBy: 'reviewer-1',
  reviewedAt: CUTOFF, methodVersion: 'human-adjudication-v1', rationale: 'Human review of exact source text and subject binding.',
  role: 'CALL', binding: 'EXACT_CONTRACT', entailment: 'DIRECT', ...overrides,
});
function packet(records: ResearchRecord[] = [], reviews: Review[] = [], extra: Record<string, unknown> = {}): ResearchPacket {
  return researchPacketSchema.parse({ schemaVersion: 1, token: TOKEN, records, reviews, ...extra });
}
function baseline(packetValue: ResearchPacket, overrides: Partial<BaselineInputs> = {}) {
  return deriveBaseline({
    token: TOKEN, cutoff: CUTOFF, profile: starterProfile(), features: [], evidence: [{
      id: 'curated-packet', sourceId: 'curated-research', sourceType: 'USER_IMPORT', retrievedAt: CUTOFF,
      availableAt: CUTOFF, contentHash: 'c'.repeat(64), adapterVersion: 'research-v1', accessMode: 'USER_IMPORT', scope: {},
    }], observations: [], research: packetValue, ...overrides,
  });
}
const assessment = (rows: ReturnType<typeof deriveBaseline>, id: string) => rows.find(row => row.id === id)!;

type MetricField = 'likes' | 'replies' | 'reposts';
type EngagementMetrics = NonNullable<ResearchRecord['metrics']>;
function socialMetricsPacket(metricsFor: (index: number) => EngagementMetrics): ResearchPacket {
  const start = '2026-09-29T02:40:00.000Z';
  const end = '2026-09-29T02:55:00.000Z';
  const records: ResearchRecord[] = [];
  const reviews: Review[] = [];
  for (let index = 0; index < 3; index++) {
    const minute = 50 + index;
    const item = record(`social-${index}`, `Reviewed community update ${index} names ${TOKEN.address} and states an observed project fact.`, [TOKEN],
      `2026-09-29T02:${minute}:00.000Z`, {
        authorId: `social-author-${index}`, communityId: `social-community-${index}`, originId: `social-origin-${index < 2 ? index : 1}`,
        accountCreatedAt: '2026-09-01T00:00:00.000Z', activityIntervalsSeconds: [60, 120], metrics: metricsFor(index),
      });
    records.push(item);
    reviews.push(review(item, { independentOriginProof: { recordId: item.id, quote: item.text.slice(0, 24) } }));
  }
  return packet(records, reviews, { corpus: {
    query: TOKEN.address, sourceSet: ['public-forum'], start, end, bucketSeconds: 300, complete: true, cap: 3,
    coordinationBaselineFraction: '0.7',
  } });
}

function socialCheckStatus(rows: ReturnType<typeof deriveBaseline>, checkId: string): string {
  const features = rows.flatMap(row => row.projection ? [row.projection] : []);
  return evaluateEntry(features, starterProfile(), CUTOFF).checks.find(check => check.checkId === checkId)!.status;
}

function completeMetrics(index: number, zero = false): EngagementMetrics {
  return { observedAt: CUTOFF, likes: zero ? '0' : String(index + 1), replies: zero ? '0' : String(index + 2), reposts: zero ? '0' : String(index) };
}

test('normalized research validates exact token, quote span, time, and lineage before derivation', () => {
  const text = `A public launch note for ${TOKEN.address} includes a concrete update.`;
  const item = record('post-1', text);
  const good = packet([item], [review(item)]);
  assert.equal(validateResearch(good, TOKEN, CUTOFF).records[0]?.id, 'post-1');

  assert.throws(() => validateResearch(good, RIVAL, CUTOFF), /RESEARCH_TOKEN_MISMATCH/);
  assert.throws(() => validateResearch(good, { ...TOKEN, address: `s${TOKEN.address.slice(1)}` }, CUTOFF), /RESEARCH_TOKEN_MISMATCH/,
    'Solana base58 identifiers remain case-sensitive');
  assert.throws(() => validateResearch(packet([item], [{ ...review(item), quote: 'invented quote outside source' }]), TOKEN, CUTOFF), /RESEARCH_CITATION/);
  assert.throws(() => validateResearch(packet([item], [review(item, { reviewedAt: '2026-09-30T00:00:00.000Z' })]), TOKEN, CUTOFF), /RESEARCH_TIME_OR_BINDING/);
  assert.throws(() => validateResearch(packet([record('future-post', text, [TOKEN], '2026-09-29T03:01:00.000Z')]), TOKEN, CUTOFF), /RESEARCH_TIME_OR_BINDING/);
  assert.throws(() => validateResearch(packet([record('future-account', text, [TOKEN], '2026-09-29T00:15:00.000Z', { accountCreatedAt: '2026-09-29T00:16:00.000Z' })]), TOKEN, CUTOFF), /RESEARCH_TIME_OR_BINDING/);
  assert.throws(() => validateResearch(packet([item, { ...item, text: `${text} duplicate` }]), TOKEN, CUTOFF), /RESEARCH_DUPLICATE/);
  assert.throws(() => validateResearch(packet([record('orphan-copy', text, [TOKEN], undefined, { repostOf: 'missing-parent' })]), TOKEN, CUTOFF), /RESEARCH_LINEAGE/);
  const siblingRef = record('sibling-ref', `A public launch note for ${TOKEN.address} names the target.`, [TOKEN, RIVAL]);
  assert.throws(() => validateResearch(packet([siblingRef], [review(siblingRef)]), TOKEN, CUTOFF), /RESEARCH_CITATION/,
    'EXACT_CONTRACT cannot smuggle an unmentioned associated tokenRef into the review');
});

test('S06 counts observed engagement fields per qualified original and gates SOC-02 through normalized imports', () => {
  const incompleteCases: Array<{ name: string; metrics: (index: number) => EngagementMetrics; missing: MetricField[]; medians: [string | null, string | null, string | null] }> = [
    { name: 'empty metrics envelope', metrics: () => ({ observedAt: CUTOFF }), missing: ['likes', 'replies', 'reposts'], medians: [null, null, null] },
    { name: 'likes-only envelope', metrics: () => ({ observedAt: CUTOFF, likes: '1' }), missing: ['replies', 'reposts'], medians: ['1', null, null] },
    { name: 'missing likes', metrics: () => ({ observedAt: CUTOFF, replies: '2', reposts: '1' }), missing: ['likes'], medians: [null, '2', '1'] },
    { name: 'missing replies', metrics: () => ({ observedAt: CUTOFF, likes: '2', reposts: '1' }), missing: ['replies'], medians: ['2', null, '1'] },
    { name: 'missing reposts', metrics: () => ({ observedAt: CUTOFF, likes: '2', replies: '1' }), missing: ['reposts'], medians: ['2', '1', null] },
  ];

  for (const scenario of incompleteCases) {
    const imported = socialMetricsPacket(scenario.metrics);
    assert.equal(validateResearch(imported, TOKEN, CUTOFF).records.length, 3, `${scenario.name}: exact reviewed import validates`);
    const rows = baseline(imported);
    const social = assessment(rows, 'S06');
    const data = social.data as {
      captured: number; total: number; requiredFields: MetricField[];
      coverage: Record<MetricField, { captured: number; missing: number }>;
      medianLikes: string | null; medianReplies: string | null; medianReposts: string | null;
    };
    assert.equal(social.quality, 'MISSING', `${scenario.name}: envelope presence does not establish field coverage`);
    assert.equal(social.projection?.quality, 'MISSING');
    assert.equal(social.projection?.value, false);
    assert.deepEqual([data.captured, data.total, data.requiredFields], [0, 3, ['likes', 'replies', 'reposts']]);
    assert.deepEqual([data.medianLikes, data.medianReplies, data.medianReposts], scenario.medians,
      `${scenario.name}: observed partial numeric fields retain their individual medians`);
    for (const field of ['likes', 'replies', 'reposts'] as const) {
      assert.deepEqual(data.coverage[field], scenario.missing.includes(field) ? { captured: 0, missing: 3 } : { captured: 3, missing: 0 },
        `${scenario.name}: ${field} coverage counts observations on each original`);
    }
    const cause = social.causes.find(item => item.code === 'ENGAGEMENT_FIELDS_MISSING');
    assert.ok(cause);
    assert.equal(cause?.featureId, 'S06');
    assert.match(cause!.action, /likes, replies and reposts for every qualified original/);
    assert.equal(socialCheckStatus(rows, 'SOC-02'), 'UNKNOWN', `${scenario.name}: incomplete S06 cannot satisfy source integrity`);
  }

  for (const zero of [false, true]) {
    const rows = baseline(socialMetricsPacket(index => completeMetrics(index, zero)));
    const social = assessment(rows, 'S06');
    const data = social.data as {
      captured: number; total: number; coverage: Record<MetricField, { captured: number; missing: number }>;
      medianLikes: string | null; medianReplies: string | null; medianReposts: string | null;
    };
    assert.equal(social.quality, 'KNOWN');
    assert.equal(social.projection?.quality, 'KNOWN');
    assert.equal(social.projection?.value, true);
    assert.deepEqual([data.captured, data.total], [3, 3]);
    for (const field of ['likes', 'replies', 'reposts'] as const) assert.deepEqual(data.coverage[field], { captured: 3, missing: 0 });
    if (zero) assert.deepEqual([data.medianLikes, data.medianReplies, data.medianReposts], ['0', '0', '0'], 'explicit zero remains a captured observation');
    else assert.deepEqual([data.medianLikes, data.medianReplies, data.medianReposts], ['2', '3', '1']);
    for (const id of ['S02', 'S03', 'S04', 'S05']) {
      assert.equal(assessment(rows, id).quality, 'KNOWN', `${id} is independently qualified in the fixture`);
      assert.equal(assessment(rows, id).projection?.value, true, `${id} supplies the other SOC-02 dependency`);
    }
    assert.equal(socialCheckStatus(rows, 'SOC-02'), 'PASS', 'complete engagement plus separately qualified dependencies can satisfy SOC-02');
  }
});

test('engagement observations stay between publication and cutoff while incomplete metrics remain unknown', () => {
  const assertInvalidChronology = (input: ResearchPacket, reason: string) => {
    assert.throws(() => validateResearch(input, TOKEN, CUTOFF), /RESEARCH_TIME_OR_BINDING/, `${reason}: direct normalization`);
    assert.throws(() => baseline(input), /RESEARCH_TIME_OR_BINDING/, `${reason}: baseline derivation`);
  };

  const ancientMetrics = socialMetricsPacket(index => ({ ...completeMetrics(index), observedAt: '2000-01-01T00:00:00.000Z' }));
  assertInvalidChronology(ancientMetrics, 'engagement data from before its source posts existed');

  const beforePublication = socialMetricsPacket(index => ({
    ...completeMetrics(index),
    observedAt: index === 0 ? '2026-09-29T02:49:59.999Z' : CUTOFF,
  }));
  assertInvalidChronology(beforePublication, 'a capture one millisecond before publication');

  const afterCutoff = socialMetricsPacket(index => ({
    ...completeMetrics(index),
    observedAt: index === 0 ? '2026-09-29T03:00:00.001Z' : CUTOFF,
  }));
  assertInvalidChronology(afterCutoff, 'a capture one millisecond after the analysis cutoff');

  const validBoundaries = socialMetricsPacket(index => ({
    ...completeMetrics(index),
    observedAt: index === 0 ? '2026-09-29T02:50:00.000Z'
      : index === 1 ? '2026-09-29T04:51:00.000+02:00'
        : CUTOFF,
  }));
  assert.equal(validateResearch(validBoundaries, TOKEN, CUTOFF).records.length, 3,
    'publication equality, an offset-equivalent instant, and the cutoff boundary are valid observations');
  const rows = baseline(validBoundaries);
  assert.equal(assessment(rows, 'S06').quality, 'KNOWN');
  assert.equal((assessment(rows, 'S06').data as { captured: number; total: number }).captured, 3);
  for (const id of ['S02', 'S03', 'S04', 'S05']) {
    assert.equal(assessment(rows, id).quality, 'KNOWN', `${id} is independently qualified`);
    assert.equal(assessment(rows, id).projection?.value, true, `${id} supplies its SOC-02 dependency`);
  }
  assert.equal(socialCheckStatus(rows, 'SOC-02'), 'PASS');

  const allMetrics = socialMetricsPacket(index => completeMetrics(index));
  const missingOneRecord = packet(allMetrics.records.map((item, index) => index === 0 ? { ...item, metrics: undefined } : item),
    allMetrics.reviews, { corpus: allMetrics.corpus });
  assert.equal(validateResearch(missingOneRecord, TOKEN, CUTOFF).records.length, 3,
    'an absent metrics object remains a supported incomplete import');
  const incompleteRows = baseline(missingOneRecord);
  const incompleteSocial = assessment(incompleteRows, 'S06');
  assert.equal(incompleteSocial.quality, 'MISSING');
  assert.deepEqual((incompleteSocial.data as { captured: number; total: number }).captured, 2);
  assert.equal(socialCheckStatus(incompleteRows, 'SOC-02'), 'UNKNOWN');
});

test('research schema admits bounded public HTTPS records and rejects credentials, non-HTTPS, and imported verdicts', () => {
  const item = record('post-1', `A public note for ${TOKEN.address} has an exact token relationship.`);
  assert.throws(() => researchPacketSchema.parse({ ...packet([item]), verdict: 'PASS' }));
  assert.throws(() => packet([{ ...item, url: 'http://public.example/post-1' }]));
  assert.throws(() => packet([{ ...item, url: 'https://name:password@public.example/post-1' }]));
  assert.throws(() => packet([{ ...item, id: 'x'.repeat(129) }]));
  assert.throws(() => packet([{ ...item, text: 'x'.repeat(12_001) }]));
  const duplicateRecordPacket = packet([item, item]);
  const duplicateReviewPacket = packet([item], [review(item), review(item)]);
  assert.equal(duplicateRecordPacket.records.length, 2, 'structure parsing leaves cross-record identity checks to token-scoped validation');
  assert.equal(duplicateReviewPacket.reviews.length, 2);
  assert.throws(() => validateResearch(duplicateRecordPacket, TOKEN, CUTOFF), /RESEARCH_DUPLICATE/);
  assert.throws(() => validateResearch(duplicateReviewPacket, TOKEN, CUTOFF), /RESEARCH_DUPLICATE/);
});

test('corpus derivation collapses reposts and normalized copies, separates warnings and price-only labels, and retains unknown authors', () => {
  const call = record('call', `A community update concerning ${TOKEN.address} brings a real project announcement.`, [TOKEN], '2026-09-29T00:20:00.000Z', { authorId: null });
  const exactCopy = record('copy-text', call.text.replace(/A community/, 'a community').replace(/concerning/, ' concerning  '), [TOKEN]);
  const warning = record('warning', `Risk warning for ${TOKEN.address}: the announced unlock remains unresolved.`, [TOKEN]);
  const price = record('price-only', `Price target for ${TOKEN.address} is posted without a project update.`, [TOKEN]);
  const repost = record('repost', `Repost of ${TOKEN.address} update with no original authorship.`, [TOKEN], '2026-09-29T00:25:00.000Z', { repostOf: 'call' });
  const records = [call, exactCopy, warning, price, repost];
  const labels = [review(call), review(warning, { role: 'WARNING' }), review(price, { role: 'PRICE_ONLY' })];
  const start = '2026-09-29T00:00:00.000Z';
  const end = '2026-09-29T02:00:00.000Z';
  const data = packet(records, labels, { corpus: { query: TOKEN.address, sourceSet: ['public-forum'], start, end, bucketSeconds: 3600, complete: true, cap: 10 } });
  const rows = baseline(data);
  assert.deepEqual(assessment(rows, 'A15').data, { raw: 5, originals: 3, cap: 10, scope: data.corpus });
  assert.deepEqual(assessment(rows, 'S02').data, { raw: 5, originals: 3, copies: 2, method: 'exact-repost-and-normalized-text-v1' });
  assert.equal((assessment(rows, 'A16').data as { qualified: number }).qualified, 1);
  assert.equal((assessment(rows, 'A16').data as { unclassified: number }).unclassified, 0);
  assert.equal(assessment(rows, 'A16').quality, 'KNOWN');
  assert.equal((assessment(rows, 'A16').data as { excluded: Array<{ role: string }> }).excluded.length, 2);
  assert.equal((assessment(rows, 'A17').data as { uniqueSourceAuthors: number }).uniqueSourceAuthors, 0);
  assert.equal((assessment(rows, 'A17').data as { unknownAuthors: number }).unknownAuthors, 1);
  assert.equal(assessment(rows, 'A17').quality, 'MISSING');
  assert.equal((assessment(rows, 'A23').data as { priceOnlyFraction: string }).priceOnlyFraction, '0.33333333333333333333');
  assert.equal((assessment(rows, 'A22').data as { undisclosed: number }).undisclosed, 3);

  const truncated = packet(records, labels, { corpus: { query: TOKEN.address, sourceSet: ['public-forum'], start, end, bucketSeconds: 3600, complete: false, cap: 10 } });
  assert.equal(assessment(baseline(truncated), 'A15').quality, 'TRUNCATED');
});

function qualificationPacket(targetPosts: number, rivalPosts: number): ResearchPacket {
  const records: ResearchRecord[] = [];
  const reviews: Review[] = [];
  const total = targetPosts + rivalPosts;
  for (let i = 0; i < total; i++) {
    const candidate = i < targetPosts ? TOKEN : RIVAL;
    const localIndex = i < targetPosts ? i : i - targetPosts;
    const minute = i < targetPosts ? (localIndex < 2 ? localIndex + 10 : 70 + localIndex - 2) : 110 + localIndex;
    const publishedAt = `2026-09-29T${minute < 60 ? '00' : '01'}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
    const sharedCompetitorMention = localIndex >= (i < targetPosts ? targetPosts : rivalPosts) - 2;
    const other = candidate === TOKEN ? RIVAL : TOKEN;
    const text = `Community call ${i} covers ${candidate.address}${sharedCompetitorMention ? ` and ${other.address}` : ''} with a reviewed product and launch update.`;
    const origin = `origin-${i % 3}`;
    const tokenRefs = sharedCompetitorMention ? [candidate, candidate === TOKEN ? RIVAL : TOKEN] : [candidate];
    const item = record(`call-${i}`, text, tokenRefs, publishedAt, {
      originId: origin, communityId: `community-${i % 3}`, authorId: `author-${i}`,
      accountCreatedAt: '2026-09-01T00:00:00.000Z', activityIntervalsSeconds: [60, 120],
      metrics: { observedAt: CUTOFF, likes: String(i + 1), replies: String(i), reposts: String(i % 2) },
    });
    records.push(item);
    reviews.push(review(item, {
      binding: candidate.address === TOKEN.address ? 'EXACT_CONTRACT' : 'REVIEWED_RELATION',
      paidDisclosure: i === 0 || i === 1 ? true : i === 2 ? undefined : false,
      independentOriginProof: { recordId: item.id, quote: item.text.slice(0, 24) },
    }));
  }
  const targetIdentity = record('identity-main', `Identity note names the target ${TOKEN.address} and its project account.`, [TOKEN]);
  const rivalIdentity = record('identity-rival', `Identity note names the rival ${RIVAL.address} and its project account.`, [RIVAL]);
  const priceOnly = record('price-only', `Price talk mentions ${TOKEN.address} without a project claim.`, [TOKEN]);
  records.push(targetIdentity, rivalIdentity, priceOnly);
  reviews.push(review(targetIdentity, { role: 'OTHER' }), review(rivalIdentity, { role: 'OTHER', binding: 'REVIEWED_RELATION' }), review(priceOnly, { role: 'PRICE_ONLY' }));
  const firstTarget = records.find(item => item.id === 'call-0')!;
  const narrative = {
    description: 'Community token with a stated event-driven theme.', game: 'COMMUNITY', style: 'COMMUNITY',
    citations: [{ recordId: firstTarget.id, quote: 'Community call 0' }], reviewedBy: 'reviewer-1', reviewedAt: CUTOFF,
    rationale: 'The exact reviewed source supports this descriptive framing.', referent: 'the project token',
    interest: 'the announced product update', tokenRelation: 'the source names this token', prerequisites: [],
    officialIdentity: { citation: { recordId: targetIdentity.id, quote: TOKEN.address }, account: '@project', primaryProof: { recordId: targetIdentity.id, quote: targetIdentity.text.slice(0, 24) } },
  };
  const start = '2026-09-29T00:00:00.000Z';
  const end = '2026-09-29T02:00:00.000Z';
  return packet(records, reviews, {
    corpus: { query: TOKEN.address, sourceSet: ['public-forum'], start, end, bucketSeconds: 3600, complete: true, cap: Math.max(20, total + 3), coordinationBaselineFraction: '0.7' },
    narrative,
    competitors: { query: 'reviewed project association', complete: true, candidates: [
      { token: TOKEN, association: { recordId: targetIdentity.id, quote: 'Identity note names the target' }, reviewedBy: 'reviewer-1', identityEvidence: { recordId: targetIdentity.id, quote: TOKEN.address } },
      { token: RIVAL, association: { recordId: rivalIdentity.id, quote: 'Identity note names the rival' }, reviewedBy: 'reviewer-1', identityEvidence: { recordId: rivalIdentity.id, quote: RIVAL.address } },
    ] },
  });
}

test('qualified corpus needs reviewed originals and minimum breadth; competitor shares use fractional multi-token allocation', () => {
  const data = qualificationPacket(10, 4);
  const rows = baseline(data);
  assert.equal(assessment(rows, 'A16').quality, 'KNOWN');
  assert.equal((assessment(rows, 'A16').data as { qualified: number }).qualified, 12, 'reviewed rival records that explicitly mention the target also count toward target attention');
  assert.equal((assessment(rows, 'A17').data as { uniqueSourceAuthors: number }).uniqueSourceAuthors, 12);
  assert.deepEqual((assessment(rows, 'S03').data as { provenOriginGroups: string[] }).provenOriginGroups.sort(), ['origin-0', 'origin-1', 'origin-2']);
  assert.equal(assessment(rows, 'S03').projection?.value, true);
  assert.equal(assessment(rows, 'S10').projection?.value, true);
  assert.equal((assessment(rows, 'S04').data as { oneMinutePeakFraction: string }).oneMinutePeakFraction, '0.083333333333333333333');
  assert.equal(assessment(rows, 'S04').projection?.value, true);
  const metricCoverage = assessment(rows, 'S06').data as { captured: number; total: number };
  assert.deepEqual([metricCoverage.captured, metricCoverage.total], [12, 12]);
  assert.equal((assessment(rows, 'A18').data as { previous: number; current: number }).previous, 2);
  assert.equal((assessment(rows, 'A18').data as { current: number }).current, 10);
  assert.equal(assessment(rows, 'A18').projection?.value, true);
  assert.deepEqual(assessment(rows, 'A22').data, { disclosedPaidPosts: 2, undisclosed: 4, dexPaidOrders: null });
  assert.equal((assessment(rows, 'A23').data as { priceOnlyFraction: string }).priceOnlyFraction, '0.058823529411764705882');
  assert.equal(assessment(rows, 'A01').projection?.value, true);
  assert.equal(assessment(rows, 'S01').quality, 'MISSING', 'a cited account claim does not independently authenticate identity');

  const shares = (assessment(rows, 'A11').data as { shares: Array<{ token: TokenRef; count: string; share: string }> }).shares;
  assert.deepEqual(shares.map(item => [item.count, item.share]), [['10', '0.71428571428571428571'], ['4', '0.28571428571428571429']]);
  assert.equal(assessment(rows, 'A11').quality, 'KNOWN');
  assert.equal(assessment(rows, 'A14').projection?.value, true);
  assert.equal((assessment(rows, 'A14').data as { margin: string }).margin, '6');

  const underMinimum = baseline(qualificationPacket(9, 0));
  assert.equal((assessment(underMinimum, 'A16').data as { qualified: number }).qualified, 9);
  assert.equal(assessment(underMinimum, 'A11').quality, 'MISSING');
  assert.equal(assessment(underMinimum, 'A14').quality, 'MISSING');

  const tie = baseline(qualificationPacket(10, 10));
  assert.equal((assessment(tie, 'A14').data as { tied: boolean }).tied, true);
  assert.equal(assessment(tie, 'A14').projection?.value, false);
});

test('an expired corpus keeps its scoped count but stales the scalar projection only when its source ref resolves', () => {
  const source = qualificationPacket(10, 0);
  const aged = baseline(source);
  const attention = assessment(aged, 'A16');
  assert.equal(attention.quality, 'KNOWN', 'the reviewed source records still support this scoped count');
  assert.equal((attention.data as { qualified: number }).qualified, 10);
  assert.equal(attention.projection?.value, '10');
  assert.equal(attention.projection?.quality, 'STALE', 'one-hour-old corpus output cannot remain a favorable current scalar');
  assert.equal(assessment(aged, 'C03').quality, 'MISSING');
  assert.equal((assessment(aged, 'C03').data as { records: Array<{ id: string; fresh: boolean }> }).records.find(row => row.id === 'A16')?.fresh, false);

  const unresolved = baseline(source, { evidence: [] });
  assert.equal(assessment(unresolved, 'C03').quality, 'MISSING');
  assert.equal(assessment(unresolved, 'A16').projection?.quality, 'KNOWN', 'a missing import artifact reference cannot prove that the source aged past its TTL');
});

test('candidate and imported assertions cannot become qualified evidence; warnings remain outside attention counts', () => {
  const item = record('candidate', `A public claim for ${TOKEN.address} was extracted but has not been reviewed.`);
  const rows = baseline(packet([item], []));
  assert.equal(assessment(rows, 'A16').quality, 'MISSING');
  assert.equal(assessment(rows, 'A16').causes[0]?.category, 'CLAIM_UNVALIDATED');
  assert.equal(assessment(rows, 'A16').projection?.value, '0');
  assert.equal(assessment(rows, 'A11').quality, 'MISSING');
  assert.throws(() => packet([item], [], { candidateVerdict: true, projections: [{ id: 'O03', value: true }] }));
});

const isoMinute = (minute: number) => new Date(Date.parse(AT) + minute * 60_000).toISOString();
type Bar = NonNullable<ResearchPacket['candles']>['bars'][number];
function candleSeries(): NonNullable<ResearchPacket['candles']> {
  const values: Array<[number, number]> = [[3,2],[5,3],[4,2],[6,4],[5,3],[4,1],[5,2],[7,7],[6,6],[7,5],[7,6],[8,7],[7,6]];
  const bars: Bar[] = values.map(([high,low], index) => {
    const start = isoMinute(index), end = isoMinute(index + 1), middle = ((high + low) / 2).toString();
    return { start, end, availableAt: end, open: middle, close: middle, high: String(high), low: String(low), volumeQuote: null };
  });
  return { market: 'fixture-pool', quote: 'USD', intervalSeconds: 60, leftBars: 1, rightBars: 1, comparisonToleranceBps: '0', bars };
}

test('causal confirmed pivots respect strict ties, gaps, availability, and future-bar invariance', () => {
  const full = candleSeries();
  const cutoff = isoMinute(11);
  const atCutoff = deriveCharts(full, cutoff);
  const withFuture = deriveCharts({ ...full, bars: [...full.bars, ...full.bars.slice(11)] }, cutoff);
  assert.deepEqual(withFuture, atCutoff);
  assert.equal(atCutoff.trend, 'UP');
  assert.ok(atCutoff.pivots.every(pivot => Date.parse(pivot.confirmedAt) <= Date.parse(cutoff) && Date.parse(pivot.availableAt) <= Date.parse(cutoff)));
  assert.ok(atCutoff.pivots.some(pivot => pivot.kind === 'HIGH' && pivot.eventAt === isoMinute(8)));
  assert.ok(atCutoff.pivots.some(pivot => pivot.kind === 'LOW' && pivot.eventAt === isoMinute(10)));

  const tied = { ...full, bars: full.bars.slice(0, 3).map((bar, index) => ({ ...bar, high: index === 0 ? '3' : '5', low: '1' })) };
  const tiedResult = deriveCharts(tied, isoMinute(3));
  assert.deepEqual(tiedResult.pivots, []);
  assert.equal(tiedResult.trend, 'UNKNOWN');

  const lateDependency = { ...full, bars: full.bars.map((bar, index) => index === 10 ? { ...bar, availableAt: isoMinute(12) } : bar) };
  const withoutLateDependency = deriveCharts({ ...full, bars: full.bars.slice(0, 10) }, cutoff);
  assert.deepEqual(deriveCharts(lateDependency, cutoff), withoutLateDependency, 'a bar published after cutoff cannot influence a pivot or trend');
  const gap = { ...full, bars: full.bars.map((bar, index) => index === 4 ? { ...bar, start: isoMinute(5), end: isoMinute(6), availableAt: isoMinute(6) } : bar) };
  assert.throws(() => deriveCharts(gap, isoMinute(11)), /CANDLE_SHAPE_OR_GAP/);
  const invalid = { ...full, bars: full.bars.map((bar, index) => index === 2 ? { ...bar, high: '1' } : bar) };
  assert.throws(() => deriveCharts(invalid, isoMinute(11)), /CANDLE_SHAPE_OR_GAP/);
});

test('context keeps covered-chain denominators, canonical bridge net, macro instruments, and launch maturity distinct', () => {
  const end = '2026-09-29T02:00:00.000Z';
  const context = researchPacketSchema.parse({ schemaVersion: 1, token: TOKEN, context: {
    window: { start: '2026-09-29T00:00:00.000Z', end, availableAt: CUTOFF },
    chainVolumes: [
      { chain: 'solana', usd: '60', previousUsd: '40', complete: true },
      { chain: 'base', usd: '40', previousUsd: '60', complete: true },
      { chain: 'bsc', usd: '1000', complete: false },
    ],
    bridges: [
      { canonicalId: 'bridge-1', from: 'base', to: 'solana', usd: '100', completedAt: '2026-09-29T00:30:00.000Z', finalized: true },
      { canonicalId: 'bridge-1', from: 'base', to: 'solana', usd: '100', completedAt: '2026-09-29T00:30:00.000Z', finalized: true },
      { canonicalId: 'bridge-2', from: 'solana', to: 'base', usd: '35', completedAt: '2026-09-29T00:45:00.000Z', finalized: true },
      { canonicalId: 'bridge-3', from: 'solana', to: 'bsc', usd: '400', completedAt: null, finalized: false },
    ],
    macro: [{ instrument: 'BTC', quote: 'USD', bars: candleSeries().bars.slice(0, 3) }],
    launch: { source: 'fixture-review', launches: 10, migrations: 3, volumeUsd: '5000', feesUsd: '50', revenueUsd: '25', cohortEnd: '2026-09-28T00:00:00.000Z', followupSeconds: 86400, survivors: 4, complete: true },
  } }).context!;
  const derived = deriveMarketContext(context, TOKEN, CUTOFF);
  assert.deepEqual(derived.activity.shareOfCoveredChains.map(row => [row.chain, row.share, row.changePercentagePoints]), [
    ['solana', '0.6', '20'], ['base', '0.4', '-20'],
  ]);
  assert.deepEqual(derived.activity.excludedChains, ['bsc', 'robinhood']);
  assert.deepEqual(derived.bridge, { inflowUsd: '100', outflowUsd: '35', netUsd: '65', pending: 1, deduplicatedRecords: 3 });
  assert.equal(derived.macro.length, 1);
  assert.equal(derived.macro[0]?.instrument, 'BTC');
  assert.equal(derived.macro[0]?.trend, 'UNKNOWN', 'three bars are not enough to establish two confirmed highs and lows');
  assert.equal(derived.launch?.launches, 10);
  assert.equal(derived.launch?.migrations, 3);
  assert.equal(derived.launch?.feesUsd, '50');
  assert.equal(derived.launch?.revenueUsd, '25');
  assert.equal(derived.launch?.survivalFraction, '0.4');
  assert.equal(derived.regime.classification, null);

  const uncovered = { ...context, bridges: [], bridgeComplete: false };
  const uncoveredBridgeAssessment = assessment(baseline(packet([], [], { context: uncovered })), 'C12');
  assert.equal(uncoveredBridgeAssessment.quality, 'MISSING', 'an empty record set without a complete bridge scope is not known zero flow');
  const completeEmpty = { ...uncovered, bridgeComplete: true };
  const scopedZero = assessment(baseline(packet([], [], { context: completeEmpty })), 'C12');
  assert.equal(scopedZero.quality, 'KNOWN');
  assert.equal((scopedZero.data as { netUsd: string }).netUsd, '0');

  const immature = researchPacketSchema.parse({ schemaVersion: 1, token: TOKEN, context: {
    window: { start: '2026-09-29T00:00:00.000Z', end, availableAt: CUTOFF }, chainVolumes: [], bridges: [], macro: [],
    launch: { source: 'fixture-review', launches: 10, migrations: 0, volumeUsd: '0', feesUsd: '0', revenueUsd: '0', cohortEnd: '2026-09-28T00:00:00.000Z', followupSeconds: 86400, survivors: 10, complete: true },
  } }).context!;
  assert.equal(deriveMarketContext(immature, TOKEN, '2026-09-28T12:00:00.000Z').launch?.survivalFraction, null);

  assert.throws(() => deriveMarketContext({ ...context, chainVolumes: [...context.chainVolumes, context.chainVolumes[0]!] }, TOKEN, CUTOFF), /CONTEXT_DUPLICATE/);
  const conflictingBridge = { ...context, bridges: [...context.bridges, { ...context.bridges[0]!, usd: '101' }] };
  assert.throws(() => deriveMarketContext(conflictingBridge, TOKEN, CUTOFF), /BRIDGE_CONFLICT/);
});
