import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalSocialUrl,
  deriveSocial,
  socialAccount,
  socialCopyPairs,
  socialNamesAddress,
} from '../src/domain/social.js';
import {
  addSocialJudgments,
  makeSocialFixture,
  SOCIAL_CUTOFF,
  SOCIAL_TOKEN,
} from './social-fixtures.js';
import { completeFixtureEntryFeatures, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { evaluateEntry } from '../src/domain/policy.js';

function assessment(result: ReturnType<typeof deriveSocial>, id: string) {
  const value = result.assessments.find(row => row.id === id);
  assert.ok(value, `missing ${id}`);
  return value;
}

type MetricName = 'likes' | 'replies' | 'reposts';
type MetricOrder = 'before-label' | 'after-label';
type MetricEvidenceOverrides = { sourceLexeme?: string; quoteLexeme?: string; citationQuote?: string };

function setMetricEvidence(
  fixture: ReturnType<typeof makeSocialFixture>,
  metric: MetricName,
  proposed: string,
  order: MetricOrder,
  lexeme: string,
  label: string,
  separator: ':' | '=' = ':',
  evidence: MetricEvidenceOverrides = {},
) {
  const post = fixture.proposal.posts.find(row => row.sourceId === 'post-alice-1');
  assert.ok(post);
  const field = post.metrics[metric];
  assert.ok(field);
  const source = fixture.read.sources.find(row => row.id === post.sourceId);
  assert.ok(source);
  const oldQuote = field.citation.quote;
  const sourceLexeme = evidence.sourceLexeme ?? lexeme;
  const quoteLexeme = evidence.quoteLexeme ?? lexeme;
  const sourceEvidence = order === 'before-label'
    ? `Observed count ${sourceLexeme} ${label}`
    : `Observed ${label}${separator} ${sourceLexeme}`;
  const quote = evidence.citationQuote ?? (order === 'before-label'
    ? `Observed count ${quoteLexeme} ${label}`
    : `Observed ${label}${separator} ${quoteLexeme}`);
  assert.ok(quote.length >= 8 && quote.length <= 1000);
  assert.ok(source.text.includes(oldQuote), 'fixture starts with the exact metric citation');
  source.text = source.text.replace(oldQuote, sourceEvidence);
  field.text = proposed;
  field.citation.quote = quote;
  assert.ok(source.text.includes(quote), 'citation remains unchanged contiguous source text');
}

function assertSoc02CannotPassWithMissingMetrics(result: ReturnType<typeof deriveSocial>, context: string) {
  const metricProjection = assessment(result, 'S06').projection;
  assert.ok(metricProjection, `${context}: S06 projection exists`);
  const features = completeFixtureEntryFeatures().map(feature => feature.id === 'S06' ? metricProjection : feature);
  const entry = evaluateEntry(features, illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V3', result.facts);
  const soc02 = entry.checks.find(check => check.checkId === 'SOC-02');
  assert.ok(soc02, `${context}: SOC-02 check exists`);
  assert.equal(soc02.status, 'UNKNOWN', `${context}: incomplete source metrics cannot establish SOC-02`);
}

test('complete synthetic source review derives all social rows and immutable policy facts', () => {
  const fixture = makeSocialFixture();
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1', 'social-evidence-1']);

  assert.deepEqual(result.assessments.map(row => [row.id, row.quality, row.projection?.value]), [
    ['S01', 'KNOWN', true], ['S02', 'KNOWN', true], ['S03', 'KNOWN', true], ['S04', 'KNOWN', true],
    ['S05', 'KNOWN', true], ['S06', 'KNOWN', true], ['S10', 'KNOWN', true],
  ]);
  assert.equal(result.facts.sampleComplete, true);
  assert.equal(result.facts.lineageComplete, true);
  assert.equal(result.facts.qualifiedOriginalCount, 6);
  assert.equal(result.facts.accountUpperBound, 3);
  assert.equal(result.facts.independentGroupCount, 3);
  assert.equal(result.facts.independentCommunityCount, 3);
  assert.deepEqual(result.facts.evidenceIds, ['social-evidence-1']);

  const synchrony = assessment(result, 'S04').data as { currentPeakFraction: string; previousPeakFraction: string; calibration: string };
  assert.deepEqual([synchrony.currentPeakFraction, synchrony.previousPeakFraction, synchrony.calibration], ['0.16666666666666666667', '1', 'UNCALIBRATED']);
  const engagement = assessment(result, 'S06').data as { coverage: Record<string, number>; median: Record<string, string> };
  assert.deepEqual(engagement.coverage, { likes: 6, replies: 6, reposts: 6 });
  assert.deepEqual(engagement.median, { likes: '2.5', replies: '2.5', reposts: '4.5' });
});

test('missing per-post metrics and coarse account history stay unknown instead of becoming zero or exact dates', () => {
  const metricFixture = makeSocialFixture({ missingMetric: { sourceId: 'post-carol-2', field: 'replies' } });
  const metricResult = deriveSocial(metricFixture.read, metricFixture.proposal, metricFixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(metricResult, 'S06').quality, 'MISSING');
  assert.equal(assessment(metricResult, 'S06').causes[0]?.code, 'SOC_METRIC_FIELDS_MISSING');
  assert.deepEqual((assessment(metricResult, 'S06').data as { coverage: Record<string, number> }).coverage, { likes: 6, replies: 5, reposts: 6 });

  const historyFixture = makeSocialFixture();
  const account = historyFixture.proposal.accounts.find(row => row.accountId === 'x.com:alice');
  assert.ok(account?.createdAt);
  account.createdAt.text = 'Joined October 2026';
  account.createdAt.citation.quote = 'Account Joined October 2026';
  const createdSource = historyFixture.read.sources.find(source => source.id === account.createdAt!.citation.sourceId);
  assert.ok(createdSource);
  createdSource.text = createdSource.text.replace('Account created: 2026-10-01T00:00:00.000Z', 'Account Joined October 2026');
  const historyResult = deriveSocial(historyFixture.read, historyFixture.proposal, historyFixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(historyResult, 'S05').quality, 'MISSING');
  assert.equal(assessment(historyResult, 'S05').causes[0]?.code, 'SOC_ACCOUNT_DATE_PRECISION');
  const indicators = (assessment(historyResult, 'S05').data as { indicators: Array<{ accountId: string; createdAt: string | null }> }).indicators;
  assert.equal(indicators.find(row => row.accountId === 'x.com:alice')?.createdAt, null);
});

test('exact metric parser rejects rounded K notation and comma-formatted counts', () => {
  for (const text of ['1.2K', '1,200']) {
    const fixture = makeSocialFixture();
    const post = fixture.proposal.posts.find(row => row.sourceId === 'post-alice-1');
    assert.ok(post?.metrics.likes);
    post.metrics.likes.text = text;
    post.metrics.likes.citation.quote = `Likes: ${text}`;
    const source = fixture.read.sources.find(row => row.id === post.sourceId);
    assert.ok(source);
    source.text = source.text.replace('Likes: 0', `Likes: ${text}`);
    const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
    assert.equal(assessment(result, 'S06').quality, 'MISSING', text);
    assert.equal((assessment(result, 'S06').data as { coverage: Record<string, number> }).coverage.likes, 5, text);
  }
});

test('metric lexemes are validated whole in both label orders and preserve per-field missingness', () => {
  const unsupported = [
    { lexeme: '1,234', proposed: '234', exactMetric: 'likes' as const, exactLabel: 'likes' },
    { lexeme: '1.5', proposed: '5', exactMetric: 'likes' as const, exactLabel: 'likes' },
    { lexeme: '-5', proposed: '5', exactMetric: 'likes' as const, exactLabel: 'likes' },
    { lexeme: '+5', proposed: '5' },
    { lexeme: '1.2K', proposed: '2' },
    { lexeme: '1.2 K', proposed: '1.2' },
    { lexeme: '3M', proposed: '3' },
    { lexeme: '3 M', proposed: '3' },
    { lexeme: 'x5', proposed: '5' },
    { lexeme: '5x', proposed: '5' },
  ];
  const labels: Record<MetricName, string[]> = {
    likes: ['like', 'likes'],
    replies: ['reply', 'replies'],
    reposts: ['repost', 'reposts', 'retweet', 'retweets'],
  };
  const metricNames = Object.keys(labels) as MetricName[];

  for (const [caseIndex, counter] of unsupported.entries()) {
    for (const [orderIndex, order] of (['before-label', 'after-label'] as const).entries()) {
      const metric = orderIndex === 0 && counter.exactMetric
        ? counter.exactMetric
        : metricNames[(caseIndex + orderIndex) % metricNames.length]!;
      const aliases = labels[metric];
      const label = orderIndex === 0 && counter.exactLabel
        ? counter.exactLabel
        : aliases[(caseIndex + orderIndex) % aliases.length]!;
      const fixture = makeSocialFixture();
      const separator = caseIndex % 2 === 0 ? ':' : '=';
      setMetricEvidence(fixture, metric, counter.proposed, order, counter.lexeme, label, separator);
      const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
      const social = assessment(result, 'S06');
      const coverage = (social.data as { coverage: Record<MetricName, number> }).coverage;

      assert.equal(social.quality, 'MISSING', `${counter.lexeme} ${label} (${order})`);
      assert.equal(social.projection?.value, null, `${counter.lexeme} ${label} (${order})`);
      assert.equal(social.causes[0]?.code, 'SOC_METRIC_FIELDS_MISSING');
      assert.deepEqual(coverage, {
        likes: metric === 'likes' ? 5 : 6,
        replies: metric === 'replies' ? 5 : 6,
        reposts: metric === 'reposts' ? 5 : 6,
      });
    }
  }
});

test('whitespace and punctuation-separated metric expressions are rejected around both label orders', () => {
  const groupedExpressions: Array<{
    name: string;
    expression: string;
    beforeLabelProposed: string;
    afterLabelProposed: string;
    orders?: MetricOrder[];
  }> = [
    { name: 'U+202F narrow no-break space', expression: '1\u202F234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'U+00A0 no-break space', expression: '1\u00A0234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'thin space', expression: '1\u2009234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'ASCII space', expression: '1 234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'tab', expression: '1\t234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'comma-space', expression: '1, 234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'multiple numeric groups', expression: '1 234 567', beforeLabelProposed: '567', afterLabelProposed: '1' },
    { name: 'standalone comma', expression: '1 , 234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'standalone decimal point', expression: '1 . 5', beforeLabelProposed: '5', afterLabelProposed: '1' },
    { name: 'standalone plus sign', expression: '1 + 234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'standalone minus sign', expression: '1 - 234', beforeLabelProposed: '234', afterLabelProposed: '1' },
    { name: 'separated K abbreviation', expression: '1.2 K', beforeLabelProposed: 'K', afterLabelProposed: '1.2', orders: ['after-label'] },
    { name: 'separated K abbreviation with comma', expression: '1.2 K,', beforeLabelProposed: 'K,', afterLabelProposed: '1.2', orders: ['after-label'] },
  ];

  for (const { name, expression, beforeLabelProposed, afterLabelProposed, orders } of groupedExpressions) {
    for (const order of orders ?? ['before-label', 'after-label']) {
      const proposed = order === 'before-label'
        ? beforeLabelProposed
        : afterLabelProposed;
      const fixture = makeSocialFixture();
      setMetricEvidence(fixture, 'likes', proposed, order, expression, 'likes', order === 'before-label' ? ':' : '=');
      const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
      const social = assessment(result, 'S06');
      const coverage = (social.data as { coverage: Record<MetricName, number> }).coverage;

      assert.equal(social.quality, 'MISSING', `${name} ${JSON.stringify(expression)} (${order})`);
      assert.equal(social.projection?.value, null, `${name} (${order})`);
      assert.equal(social.causes[0]?.code, 'SOC_METRIC_FIELDS_MISSING');
      assert.deepEqual(coverage, { likes: 5, replies: 6, reposts: 6 }, `${name} (${order})`);
      assertSoc02CannotPassWithMissingMetrics(result, `${name} (${order})`);
    }
  }
});

test('clipped metric quotes cannot hide a grouped numeric prefix or suffix in the retained source', () => {
  const clippedCases: Array<{
    name: string;
    order: MetricOrder;
    proposed: string;
    label: string;
    citationQuote: string;
  }> = [
    { name: 'prefix before counter', order: 'before-label', proposed: '234', label: 'likes', citationQuote: '234 likes' },
    { name: 'suffix after counter', order: 'after-label', proposed: '1', label: 'Likes', citationQuote: 'Likes: 1' },
  ];

  for (const scenario of clippedCases) {
    const fixture = makeSocialFixture();
    setMetricEvidence(
      fixture,
      'likes',
      scenario.proposed,
      scenario.order,
      '1 234',
      scenario.label,
      ':',
      { sourceLexeme: '1 234', citationQuote: scenario.citationQuote },
    );
    const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
    const social = assessment(result, 'S06');
    const coverage = (social.data as { coverage: Record<MetricName, number> }).coverage;

    assert.equal(scenario.citationQuote.length >= 8, true, `${scenario.name}: quote meets the schema minimum`);
    assert.equal(social.quality, 'MISSING', scenario.name);
    assert.equal(social.projection?.value, null, scenario.name);
    assert.equal(social.causes[0]?.code, 'SOC_METRIC_FIELDS_MISSING');
    assert.deepEqual(coverage, { likes: 5, replies: 6, reposts: 6 }, scenario.name);
    assertSoc02CannotPassWithMissingMetrics(result, scenario.name);
  }
});

test('supported decimal and zero counters accept every likes, replies, reposts, and retweet alias', () => {
  const supported: Array<{ metric: MetricName; label: string; order: MetricOrder; text: string; separator?: ':' | '=' }> = [
    { metric: 'likes', label: 'like', order: 'before-label', text: '1.5' },
    { metric: 'likes', label: 'likes', order: 'after-label', text: '0', separator: '=' },
    { metric: 'replies', label: 'reply', order: 'before-label', text: '1.5' },
    { metric: 'replies', label: 'replies', order: 'after-label', text: '0', separator: '=' },
    { metric: 'reposts', label: 'repost', order: 'before-label', text: '1.5' },
    { metric: 'reposts', label: 'reposts', order: 'after-label', text: '0', separator: '=' },
    { metric: 'reposts', label: 'retweet', order: 'before-label', text: '1.5' },
    { metric: 'reposts', label: 'retweets', order: 'after-label', text: '0', separator: '=' },
  ];

  for (const counter of supported) {
    const fixture = makeSocialFixture();
    setMetricEvidence(fixture, counter.metric, counter.text, counter.order, counter.text, counter.label, counter.separator);
    const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
    const social = assessment(result, 'S06');
    assert.equal(social.quality, 'KNOWN', `${counter.text} ${counter.label} (${counter.order})`);
    assert.equal(social.projection?.value, true);
    assert.deepEqual((social.data as { coverage: Record<MetricName, number> }).coverage, { likes: 6, replies: 6, reposts: 6 });
    const engagement = (social.data as { engagement: Array<{ sourceId: string } & Record<MetricName, string | null>> }).engagement;
    assert.equal(engagement.find(row => row.sourceId === 'post-alice-1')?.[counter.metric], counter.text);
  }
});

test('metric aliases require their full word boundaries', () => {
  const invalidLabels: Array<{ metric: MetricName; label: string }> = [
    { metric: 'likes', label: 'dislikes' },
    { metric: 'likes', label: 'likesCount' },
    { metric: 'replies', label: 'replying' },
    { metric: 'replies', label: 'repliesCount' },
    { metric: 'reposts', label: 'retweeting' },
    { metric: 'reposts', label: 'repostsCount' },
  ];

  for (const { metric, label } of invalidLabels) {
    const fixture = makeSocialFixture();
    setMetricEvidence(fixture, metric, '5', 'after-label', '5', label);
    const social = assessment(deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']), 'S06');
    const coverage = (social.data as { coverage: Record<MetricName, number> }).coverage;
    assert.equal(social.quality, 'MISSING', label);
    assert.deepEqual(coverage, {
      likes: metric === 'likes' ? 5 : 6,
      replies: metric === 'replies' ? 5 : 6,
      reposts: metric === 'reposts' ? 5 : 6,
    });
  }
});

test('reviewed copied endorsements collapse independent groups, while unresolved pairs keep lineage unknown', () => {
  const copied = makeSocialFixture({ bodyMode: 'all-same', pairRelation: 'COPIED_ENDORSEMENT' });
  const candidatePairs = socialCopyPairs(copied.proposal, SOCIAL_TOKEN);
  assert.ok(candidatePairs.length > 1);
  assert.deepEqual(candidatePairs.map(pair => pair.id), [...candidatePairs.map(pair => pair.id)].sort());
  const copiedResult = deriveSocial(copied.read, copied.proposal, copied.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(copiedResult.facts.lineageComplete, true);
  assert.equal(copiedResult.facts.independentGroupCount, 1);
  assert.equal(assessment(copiedResult, 'S02').projection?.value, true);
  assert.equal(assessment(copiedResult, 'S03').projection?.value, false);

  const unresolved = makeSocialFixture({ bodyMode: 'all-same', pairRelation: 'UNRESOLVED' });
  const unresolvedResult = deriveSocial(unresolved.read, unresolved.proposal, unresolved.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(unresolvedResult.facts.lineageComplete, false);
  assert.equal(assessment(unresolvedResult, 'S02').quality, 'MISSING');
});

test('bodyComplete false excludes a post from participation, history, and copy-pair candidates even when its labels claim a match', () => {
  const fixture = makeSocialFixture({ bodyMode: 'all-same' });
  const currentIds = new Set(fixture.read.sources
    .filter(source => source.kind === 'POST' && Date.parse(source.publishedAt!) >= Date.parse(fixture.read.start))
    .map(source => source.id));
  for (const post of fixture.proposal.posts.filter(row => currentIds.has(row.sourceId))) {
    post.bodyComplete = false;
    post.role = 'ORIGINAL';
    post.binding = 'EXACT_CONTRACT';
  }

  const pairs = socialCopyPairs(fixture.proposal, SOCIAL_TOKEN);
  fixture.review.pairs = pairs.map(pair => ({ id: pair.id, relation: 'DISTINCT_COMMENTARY', rationale: 'The remaining complete source bodies receive an explicit independent disposition.' }));
  assert.ok(pairs.every(pair => !currentIds.has(pair.left) && !currentIds.has(pair.right)));
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(result.facts.sampleComplete, false, 'an incomplete current body cannot complete the participation sample');
  assert.equal(result.facts.qualifiedOriginalCount, null);
  assert.equal(result.facts.accountUpperBound, null);
  assert.equal(result.facts.lineageComplete, false);
  assert.equal(assessment(result, 'S03').quality, 'MISSING');
  const history = (assessment(result, 'S05').data as { indicators: Array<{ accountId: string; historyPosts: number }> }).indicators;
  assert.ok(history.every(account => account.historyPosts === 0), 'incomplete bodies do not enter account history');
});

test('platform handles and unidentifiable community names cannot establish independent communities', () => {
  const fixture = makeSocialFixture({ communityKey: '@mytelegramgroup' });
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(result.facts.lineageComplete, false);
  assert.equal(assessment(result, 'S02').projection?.value, true);
  assert.equal(assessment(result, 'S03').quality, 'MISSING');
  assert.equal(assessment(result, 'S10').quality, 'MISSING');
});

test('conflicting independent binding and disavowal stays unknown; a longer handle is not the same account', () => {
  const conflict = makeSocialFixture({ addDisavowal: true });
  const conflictResult = deriveSocial(conflict.read, conflict.proposal, conflict.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(conflictResult, 'S01').quality, 'MISSING');
  assert.equal(assessment(conflictResult, 'S01').causes[0]?.code, 'SOC_IDENTITY_CONFLICT');

  const longerHandle = makeSocialFixture({ addDisavowal: true, disavowalMention: '@alicebackup' });
  const result = deriveSocial(longerHandle.read, longerHandle.proposal, longerHandle.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(result, 'S01').quality, 'MISSING');
  assert.equal(assessment(result, 'S01').causes[0]?.code, 'SOC_IDENTITY_PROOF_UNRESOLVED');
});

test('an incomplete accepted binding cannot negate a valid disavowal, while a complete disavowal remains known false', () => {
  const incompleteBinding = makeSocialFixture({ addDisavowal: true });
  const positive = incompleteBinding.proposal.identities.find(claim => claim.status === 'PUBLIC_BINDING_SUPPORTED');
  assert.ok(positive);
  positive.citations = positive.citations.slice(0, 1);
  const unresolved = deriveSocial(incompleteBinding.read, incompleteBinding.proposal, incompleteBinding.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(unresolved, 'S01').quality, 'MISSING');
  assert.equal(assessment(unresolved, 'S01').projection?.value, null);
  assert.equal(assessment(unresolved, 'S01').causes[0]?.code, 'SOC_IDENTITY_PROOF_UNRESOLVED');

  const disavowalOnly = makeSocialFixture({ addDisavowal: true });
  disavowalOnly.proposal.identities = disavowalOnly.proposal.identities.filter(claim => claim.status === 'DISAVOWED');
  disavowalOnly.review.decisions = disavowalOnly.review.decisions.filter(decision => decision.id !== 'identity:project-official-account');
  const disproven = deriveSocial(disavowalOnly.read, disavowalOnly.proposal, disavowalOnly.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(disproven, 'S01').quality, 'KNOWN');
  assert.equal(assessment(disproven, 'S01').projection?.value, false);
});

test('an incomplete source cannot make a definite disavowal known false', () => {
  const fixture = makeSocialFixture({ addDisavowal: true });
  const disavowalSource = fixture.read.identitySourceIds.find(id => id.includes('disavowal'));
  assert.ok(disavowalSource);
  fixture.review.sources.find(source => source.sourceId === disavowalSource)!.complete = false;
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(result, 'S01').quality, 'MISSING');
  assert.equal(assessment(result, 'S01').projection?.value, null);
  assert.equal(assessment(result, 'S01').causes[0]?.code, 'SOC_IDENTITY_PROOF_UNRESOLVED');
});

test('source-dated posts outside the current window do not poison its zero-account bound', () => {
  const oldOnly = makeSocialFixture();
  const priorIds = oldOnly.read.sources.filter(source => source.kind === 'POST' && Date.parse(source.publishedAt!) < Date.parse(oldOnly.read.start)).map(source => source.id);
  oldOnly.read.targetPostIds = priorIds;
  for (const id of priorIds) {
    const post = oldOnly.proposal.posts.find(row => row.sourceId === id)!;
    post.role = 'REPOST';
    post.binding = 'UNCLEAR';
    post.parentSourceId = null;
    oldOnly.review.decisions.find(row => row.id === `post:${id}`)!.accepted = false;
    oldOnly.review.sources.find(row => row.sourceId === id)!.complete = false;
  }
  const boundedEmpty = deriveSocial(oldOnly.read, oldOnly.proposal, oldOnly.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(boundedEmpty.facts.sampleComplete, true);
  assert.equal(boundedEmpty.facts.accountUpperBound, 0);
  assert.equal(assessment(boundedEmpty, 'S03').quality, 'KNOWN');
  assert.equal(assessment(boundedEmpty, 'S03').projection?.value, false);

  const rejectedCurrent = makeSocialFixture();
  rejectedCurrent.read.targetPostIds = rejectedCurrent.read.sources.filter(source => source.kind === 'POST' && Date.parse(source.publishedAt!) >= Date.parse(rejectedCurrent.read.start)).map(source => source.id);
  const rejectedId = rejectedCurrent.read.targetPostIds[0]!;
  rejectedCurrent.proposal.posts.find(row => row.sourceId === rejectedId)!.role = 'UNCLEAR';
  rejectedCurrent.proposal.posts.find(row => row.sourceId === rejectedId)!.binding = 'UNCLEAR';
  rejectedCurrent.review.decisions.find(row => row.id === `post:${rejectedId}`)!.accepted = false;
  const rejectedResult = deriveSocial(rejectedCurrent.read, rejectedCurrent.proposal, rejectedCurrent.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(rejectedResult.facts.sampleComplete, false);
  assert.equal(assessment(rejectedResult, 'S03').quality, 'MISSING');

  const unresolvedCurrentParent = makeSocialFixture();
  unresolvedCurrentParent.read.targetPostIds = unresolvedCurrentParent.read.sources.filter(source => source.kind === 'POST' && Date.parse(source.publishedAt!) >= Date.parse(unresolvedCurrentParent.read.start)).map(source => source.id);
  const unresolvedId = unresolvedCurrentParent.read.targetPostIds[0]!;
  const repost = unresolvedCurrentParent.proposal.posts.find(row => row.sourceId === unresolvedId)!;
  repost.role = 'REPOST';
  repost.parentSourceId = 'missing-current-parent';
  const unresolvedParentResult = deriveSocial(unresolvedCurrentParent.read, unresolvedCurrentParent.proposal, unresolvedCurrentParent.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(unresolvedParentResult.facts.sampleComplete, true);
  assert.equal(assessment(unresolvedParentResult, 'S02').quality, 'MISSING');
  assert.equal(assessment(unresolvedParentResult, 'S03').quality, 'MISSING');

  const missingDate = makeSocialFixture();
  missingDate.read.targetPostIds = missingDate.read.sources.filter(source => source.kind === 'POST' && Date.parse(source.publishedAt!) >= Date.parse(missingDate.read.start)).map(source => source.id);
  const noDateId = missingDate.read.targetPostIds[0]!;
  missingDate.read.sources.find(source => source.id === noDateId)!.publishedAt = null;
  const noDateResult = deriveSocial(missingDate.read, missingDate.proposal, missingDate.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(noDateResult.facts.sampleComplete, false);

  const rejectedPrior = makeSocialFixture();
  const rejectedPriorIds = rejectedPrior.read.sources.filter(source => source.kind === 'POST' && Date.parse(source.publishedAt!) < Date.parse(rejectedPrior.read.start)).map(source => source.id);
  for (const id of rejectedPriorIds) {
    rejectedPrior.review.decisions.find(row => row.id === `post:${id}`)!.accepted = false;
    rejectedPrior.review.sources.find(row => row.sourceId === id)!.complete = false;
  }
  const priorResult = deriveSocial(rejectedPrior.read, rejectedPrior.proposal, rejectedPrior.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(priorResult.facts.sampleComplete, true, 'the current window remains complete');
  assert.equal(assessment(priorResult, 'S04').quality, 'MISSING', 'rejected prior evidence cannot make synchrony comparable');
});

test('canonical X aliases collapse URL query variants and contract matching respects chain-specific boundaries', () => {
  assert.equal(socialAccount('https://twitter.com/Alice/status/88?ref=feed'), 'x.com:alice');
  assert.equal(canonicalSocialUrl('https://twitter.com/Alice/status/88?ref=feed#post'), 'https://x.com/alice/status/88');
  assert.equal(canonicalSocialUrl('https://x.com/Alice?utm_source=search'), 'https://x.com/alice');
  assert.equal(socialNamesAddress(`contract ${SOCIAL_TOKEN.address.toUpperCase()} confirmed`, SOCIAL_TOKEN), true);
  assert.equal(socialNamesAddress(`${SOCIAL_TOKEN.address}a`, SOCIAL_TOKEN), false);
  assert.equal(socialNamesAddress(`a${SOCIAL_TOKEN.address}`, SOCIAL_TOKEN), false);
});

test('invalid citations, omitted review coverage, and stale scope reject all seven projections', () => {
  const badCitation = makeSocialFixture();
  badCitation.proposal.posts[0]!.body.quote = 'A fabricated quote outside every retained source.';
  const citationResult = deriveSocial(badCitation.read, badCitation.proposal, badCitation.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.deepEqual(citationResult.assessments.map(row => row.causes[0]?.code), Array(7).fill('SOC_CITATION_INVALID'));

  const incomplete = makeSocialFixture();
  incomplete.review.sources.pop();
  const incompleteResult = deriveSocial(incomplete.read, incomplete.proposal, incomplete.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.deepEqual(incompleteResult.assessments.map(row => row.causes[0]?.code), Array(7).fill('SOC_REVIEW_INVALID'));

  const stale = makeSocialFixture();
  const staleCutoff = '2026-10-04T00:20:00.000Z';
  const staleResult = deriveSocial(stale.read, stale.proposal, stale.review, SOCIAL_TOKEN, staleCutoff, ['social-evidence-1']);
  assert.equal(assessment(staleResult, 'S02').causes[0]?.code, 'SOC_SOURCE_STALE');
});

test('independently reviewed inadequate public identity verifiability is a bounded negative, not an impersonation finding', () => {
  const fixture = makeSocialFixture();
  const profile = fixture.read.sources.find(source => source.id === 'identity-profile-alice');
  const project = fixture.read.sources.find(source => source.id === 'identity-primary-project');
  assert.ok(profile && project);
  project.text = `The project page documents ${SOCIAL_TOKEN.address} but does not identify an official account.`;
  fixture.proposal.identities = [{
    id: 'claimed-official-account', accountId: 'x.com:alice', status: 'CLAIMED',
    citations: [{ sourceId: profile.id, quote: profile.text }],
  }];
  fixture.review.decisions = fixture.review.decisions.filter(row => !row.id.startsWith('identity:'));
  fixture.review.decisions.push({ id: 'identity:claimed-official-account', accepted: true, rationale: 'The profile makes the claimed account assertion, without independently binding it to the project.' });
  addSocialJudgments(fixture, { identity: 'CONTRADICTED', identitySourceId: project.id, integrity: 'UNRESOLVED' });

  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(result, 'S01').quality, 'MISSING', 'the semantic screening does not fabricate local binding proof');
  assert.equal(result.facts.identityReview?.verdict, 'CONTRADICTED');
  assert.match(result.facts.identityReview?.rationale ?? '', /public sources/);
  assert.doesNotMatch(result.facts.identityReview?.rationale ?? '', /impersonat|fraud|bot/i);
  const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-01')?.status, 'FAIL');
});

test('a reviewed integrity negative may use missing desired indicators without turning missing metrics into zero', () => {
  const fixture = makeSocialFixture({
    missingMetric: { sourceId: 'post-alice-1', field: 'replies' },
    missingCreationAccount: 'x.com:alice',
  });
  fixture.read.previousComparable = false;
  addSocialJudgments(fixture, { identity: 'UNRESOLVED', integrity: 'CONTRADICTED' });
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.deepEqual(result.facts.integrityReview?.missingIndicators, ['ACCOUNT_HISTORY', 'ENGAGEMENT', 'COMPARABLE_HISTORY']);
  assert.equal(result.facts.integrityReview?.verdict, 'CONTRADICTED');
  assert.equal(assessment(result, 'S05').quality, 'MISSING');
  assert.equal(assessment(result, 'S06').quality, 'MISSING');
  assert.equal(assessment(result, 'S04').quality, 'MISSING');
  const engagement = assessment(result, 'S06').data as { coverage: Record<MetricName, number>; engagement: Array<{ sourceId: string; replies: string | null }> };
  assert.deepEqual(engagement.coverage, { likes: 6, replies: 5, reposts: 6 });
  assert.equal(engagement.engagement.find(row => row.sourceId === 'post-alice-1')?.replies, null);
  const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-02')?.status, 'FAIL');
});

test('guarded positive integrity review can pass when only desired engagement statistics are unavailable', () => {
  const fixture = makeSocialFixture({ missingMetric: { sourceId: 'post-alice-1', field: 'replies' } });
  addSocialJudgments(fixture, { identity: 'UNRESOLVED', integrity: 'SUPPORTED' });
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(result.facts.sampleComplete, true);
  assert.equal(result.facts.lineageComplete, true);
  assert.equal(result.facts.integrityReview?.verdict, 'SUPPORTED');
  assert.deepEqual(result.facts.integrityReview?.missingIndicators, ['ENGAGEMENT']);
  assert.equal(assessment(result, 'S06').quality, 'MISSING');
  const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-02')?.status, 'PASS');
});

test('positive integrity judgments stay unresolved without current sample, complete lineage, or clean local checks', () => {
  const cases = [
    ['incomplete current collection', (fixture: ReturnType<typeof makeSocialFixture>) => { fixture.read.sampleComplete = false; }],
    ['empty current sample', (fixture: ReturnType<typeof makeSocialFixture>) => {
      fixture.read.targetPostIds = fixture.read.targetPostIds.filter(id => id.endsWith('-0'));
    }],
    ['incomplete source lineage', (fixture: ReturnType<typeof makeSocialFixture>) => {
      fixture.proposal.posts.find(post => post.sourceId === 'post-alice-1')!.community = null;
    }],
    ['adverse synchrony', (fixture: ReturnType<typeof makeSocialFixture>) => {
      for (const source of fixture.read.sources.filter(source => source.kind === 'POST')) {
        if (source.id.endsWith('-0')) source.publishedAt = source.id === 'post-alice-0' ? '2026-10-02T10:00:00.000Z' : source.id === 'post-bob-0' ? '2026-10-02T10:01:00.000Z' : '2026-10-02T10:02:00.000Z';
        else source.publishedAt = '2026-10-03T10:00:00.000Z';
      }
    }],
    ['invalid exact metric', (fixture: ReturnType<typeof makeSocialFixture>) => {
      setMetricEvidence(fixture, 'likes', '234', 'after-label', '1,234', 'likes');
    }],
  ] as const;

  for (const [label, mutate] of cases) {
    const fixture = makeSocialFixture();
    mutate(fixture);
    addSocialJudgments(fixture, { identity: 'UNRESOLVED', integrity: 'SUPPORTED' });
    const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
    assert.equal(result.facts.integrityReview?.verdict, 'UNRESOLVED', label);
    const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
    assert.equal(entry.checks.find(row => row.checkId === 'SOC-02')?.status, 'UNKNOWN', label);
  }
});

test('positive identity judgment cannot pass on an unbound claimed account', () => {
  const fixture = makeSocialFixture();
  fixture.proposal.identities[0]!.status = 'CLAIMED';
  addSocialJudgments(fixture, { identity: 'SUPPORTED', integrity: 'UNRESOLVED' });
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(result, 'S01').projection?.value, null);
  assert.equal(result.facts.identityReview?.verdict, 'UNRESOLVED');
  const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-01')?.status, 'UNKNOWN');
});

test('positive identity requires a reviewed account page and a distinct cited primary page naming that account and contract', () => {
  const fixture = makeSocialFixture();
  addSocialJudgments(fixture, { identity: 'SUPPORTED', integrity: 'UNRESOLVED' });
  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(result, 'S01').projection?.value, true);
  assert.equal(result.facts.identityReview?.verdict, 'SUPPORTED');
  const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-01')?.status, 'PASS');

  const profileOnly = makeSocialFixture();
  const primary = profileOnly.read.sources.find(source => source.id === 'identity-primary-project')!;
  primary.text = `The project describes ${SOCIAL_TOKEN.address} but does not identify an account.`;
  profileOnly.proposal.identities[0]!.citations = [
    { sourceId: 'identity-profile-alice', quote: profileOnly.read.sources.find(source => source.id === 'identity-profile-alice')!.text },
  ];
  addSocialJudgments(profileOnly, { identity: 'SUPPORTED', identitySourceId: primary.id, integrity: 'UNRESOLVED' });
  const unsupported = deriveSocial(profileOnly.read, profileOnly.proposal, profileOnly.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(unsupported.facts.identityReview?.verdict, 'UNRESOLVED');
  const unsupportedEntry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', unsupported.facts);
  assert.equal(unsupportedEntry.checks.find(row => row.checkId === 'SOC-01')?.status, 'UNKNOWN');
});

test('profile self-claims and X account titles cannot supply the independent public identity binding path', () => {
  const fixture = makeSocialFixture();
  const profile = fixture.read.sources.find(source => source.id === 'identity-profile-alice');
  assert.ok(profile);
  profile.text = `Official project title: River Lantern ${SOCIAL_TOKEN.address} @alice`;
  fixture.proposal.identities[0]!.status = 'PUBLIC_BINDING_SUPPORTED';
  fixture.proposal.identities[0]!.citations = [{ sourceId: profile.id, quote: profile.text }];
  addSocialJudgments(fixture, { identity: 'SUPPORTED', identitySourceId: profile.id, integrity: 'UNRESOLVED' });

  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(assessment(result, 'S01').projection?.value, null);
  assert.equal(result.facts.identityReview?.verdict, 'UNRESOLVED');
  const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-01')?.status, 'UNKNOWN');
});

test('rejected or incomplete independent judgment review remains unresolved', () => {
  const rejected = makeSocialFixture();
  addSocialJudgments(rejected, { identity: 'CONTRADICTED', integrity: 'CONTRADICTED' });
  rejected.review.decisions.find(row => row.id === 'assessment:identity')!.accepted = false;
  rejected.review.sources.find(row => row.sourceId === 'post-alice-1')!.complete = false;
  const result = deriveSocial(rejected.read, rejected.proposal, rejected.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(result.facts.identityReview?.verdict, 'UNRESOLVED');
  assert.equal(result.facts.integrityReview?.verdict, 'UNRESOLVED');

  const legacy = makeSocialFixture();
  const old = deriveSocial(legacy.read, legacy.proposal, legacy.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(old.facts.identityReview, undefined);
  assert.equal(old.facts.integrityReview, undefined, 'optional judgments preserve old proposal fixtures and replay inputs');
});

test('independent rejection leaves negative identity and integrity judgments UNKNOWN without inversion', () => {
  const fixture = makeSocialFixture();
  addSocialJudgments(fixture, { identity: 'CONTRADICTED', integrity: 'CONTRADICTED' });
  fixture.review.decisions.find(row => row.id === 'assessment:identity')!.accepted = false;
  fixture.review.decisions.find(row => row.id === 'assessment:integrity')!.accepted = false;

  const result = deriveSocial(fixture.read, fixture.proposal, fixture.review, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-evidence-1']);
  assert.equal(result.facts.identityReview?.verdict, 'UNRESOLVED');
  assert.equal(result.facts.integrityReview?.verdict, 'UNRESOLVED');
  const entry = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', result.facts);
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-01')?.status, 'UNKNOWN');
  assert.equal(entry.checks.find(row => row.checkId === 'SOC-02')?.status, 'UNKNOWN');
});
