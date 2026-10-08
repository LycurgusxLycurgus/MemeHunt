import type { TokenRef } from '../src/domain/contracts.js';
import {
  socialCopyPairs,
  type SocialInput,
  type SocialProposal,
  type SocialReview,
} from '../src/domain/social.js';

export const SOCIAL_TOKEN: TokenRef = {
  chain: 'base',
  address: '0x1111111111111111111111111111111111111111',
};
export const SOCIAL_START = '2026-10-03T00:00:00.000Z';
export const SOCIAL_END = '2026-10-04T00:00:00.000Z';
export const SOCIAL_CUTOFF = '2026-10-04T00:10:00.000Z';
export const SOCIAL_AVAILABLE = '2026-10-04T00:05:00.000Z';

type Source = SocialInput['sources'][number];
export type SocialFixture = { read: SocialInput; proposal: SocialProposal; review: SocialReview };
export type SocialFixtureOptions = {
  accountCount?: number;
  includeIdentity?: boolean;
  addDisavowal?: boolean;
  disavowalMention?: string;
  missingMetric?: { sourceId: string; field: 'likes' | 'replies' | 'reposts' };
  missingCreationAccount?: string;
  missingHistoryAccount?: string;
  communityKey?: string;
  bodyMode?: 'distinct' | 'all-same';
  pairRelation?: 'COPIED_ENDORSEMENT' | 'DISTINCT_COMMENTARY' | 'UNRESOLVED';
};

export type SocialJudgmentOverrides = {
  identity?: 'SUPPORTED' | 'CONTRADICTED' | 'UNRESOLVED';
  integrity?: 'SUPPORTED' | 'CONTRADICTED' | 'UNRESOLVED';
  identitySourceId?: string;
  integritySourceId?: string;
};

/** Entirely synthetic public-source records for bounded social derivation tests. */
export function makeSocialFixture(options: SocialFixtureOptions = {}): SocialFixture {
  const accountCount = options.accountCount ?? 3;
  const handles = ['alice', 'bob', 'carol', 'dana'].slice(0, accountCount);
  const sources: Source[] = [];
  const posts: SocialProposal['posts'] = [];
  const accountPosts = new Map<string, string[]>();
  const targetPostIds: string[] = [];

  for (let accountIndex = 0; accountIndex < handles.length; accountIndex++) {
    const handle = handles[accountIndex]!;
    const accountId = `x.com:${handle}`;
    const history: string[] = [];
    const rows = [
      { period: 'prior', at: '2026-10-02T10:00:00.000Z', ordinal: 0 },
      { period: 'current', at: `2026-10-03T10:0${accountIndex * 2}:00.000Z`, ordinal: 1 },
      { period: 'current', at: `2026-10-03T10:0${accountIndex * 2 + 1}:00.000Z`, ordinal: 2 },
    ];
    for (const row of rows) {
      const id = `post-${handle}-${row.ordinal}`;
      const url = `https://x.com/${handle}/status/${1000 + accountIndex * 10 + row.ordinal}`;
      const body = options.bodyMode === 'all-same'
        ? `Community members share this token note for ${SOCIAL_TOKEN.address}.`
        : `${handle} shares ${SOCIAL_TOKEN.address}: note ${accountIndex}-${row.ordinal}.`;
      const originUrl = `https://origins.example/${handle}`;
      const communityUrl = options.communityKey && handle === 'alice' ? options.communityKey : `https://groups.example/${handle}`;
      const metricOrder = accountIndex * 2 + row.ordinal - 1;
      const metrics = row.period === 'current'
        ? { likes: metricOrder, replies: metricOrder, reposts: metricOrder + 2 }
        : null;
      const metricText = metrics
        ? `Likes: ${metrics.likes} Replies: ${metrics.replies} Reposts: ${metrics.reposts}`
        : 'Historical publication.';
      const createdAt = '2026-10-01T00:00:00.000Z';
      const text = `${body}\nOrigin: ${originUrl}\nCommunity: ${communityUrl}\n${metricText}\nAccount created: ${createdAt}`;
      sources.push({ id, url, text, publishedAt: row.at, authorId: accountId, availableAt: SOCIAL_AVAILABLE, kind: 'POST' });
      targetPostIds.push(id);
      history.push(id);
      const citation = { sourceId: id, quote: body };
      const citeUrl = (value: string) => ({ sourceId: id, quote: value });
      const metricField = (name: 'likes' | 'replies' | 'reposts', value: number) => ({
        text: String(value),
        citation: citeUrl(`${name === 'likes' ? 'Likes' : name === 'replies' ? 'Replies' : 'Reposts'}: ${value}`),
      });
      posts.push({
        sourceId: id,
        body: citation,
        role: 'ORIGINAL',
        binding: 'EXACT_CONTRACT',
        bindingProof: [],
        parentSourceId: null,
        origin: { key: originUrl, citation: citeUrl(originUrl) },
        community: { key: communityUrl, citation: citeUrl(communityUrl) },
        campaign: null,
        metrics: {
          likes: metrics && !(options.missingMetric?.sourceId === id && options.missingMetric.field === 'likes') ? metricField('likes', metrics.likes) : null,
          replies: metrics && !(options.missingMetric?.sourceId === id && options.missingMetric.field === 'replies') ? metricField('replies', metrics.replies) : null,
          reposts: metrics && !(options.missingMetric?.sourceId === id && options.missingMetric.field === 'reposts') ? metricField('reposts', metrics.reposts) : null,
        },
      });
    }
    accountPosts.set(accountId, history);
  }

  const identitySourceIds: string[] = [];
  const identities: SocialProposal['identities'] = [];
  if (options.includeIdentity !== false && handles.length) {
    const handle = handles[0]!;
    const accountId = `x.com:${handle}`;
    const profileId = 'identity-profile-alice';
    const profileText = `Account @${handle} publishes the exact contract ${SOCIAL_TOKEN.address}.`;
    const websiteId = 'identity-primary-project';
    const websiteText = `The project for ${SOCIAL_TOKEN.address} identifies @${handle} as its account.`;
    sources.push({ id: profileId, url: `https://x.com/${handle}`, text: profileText, publishedAt: null, authorId: accountId, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' });
    sources.push({ id: websiteId, url: 'https://project.example/about', text: websiteText, publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' });
    identitySourceIds.push(profileId, websiteId);
    identities.push({
      id: 'project-official-account', accountId, status: 'PUBLIC_BINDING_SUPPORTED',
      citations: [
        { sourceId: profileId, quote: profileText },
        { sourceId: websiteId, quote: websiteText },
      ],
    });
    if (options.addDisavowal) {
      const disavowalId = 'identity-independent-disavowal';
      const mention = options.disavowalMention ?? `@${handle}`;
      const text = `A primary project statement says ${SOCIAL_TOKEN.address} is not associated with ${mention}.`;
      sources.push({ id: disavowalId, url: 'https://statement.example/notice', text, publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' });
      identitySourceIds.push(disavowalId);
      identities.push({ id: 'project-disavows-account', accountId, status: 'DISAVOWED', citations: [{ sourceId: disavowalId, quote: text }] });
    }
  }

  const accounts: SocialProposal['accounts'] = [...accountPosts].map(([accountId, history]) => {
    const createdSource = sources.find(source => source.id === history[1])!;
    const createdQuote = 'Account created: 2026-10-01T00:00:00.000Z';
    return {
      accountId,
      createdAt: options.missingCreationAccount === accountId ? null : { text: '2026-10-01T00:00:00.000Z', citation: { sourceId: createdSource.id, quote: createdQuote } },
      historySourceIds: options.missingHistoryAccount === accountId ? history.slice(1) : history,
    };
  });

  const proposal: SocialProposal = { posts, identities, accounts };
  const pairs = socialCopyPairs(proposal, SOCIAL_TOKEN);
  const decisions = [
    ...posts.map(post => ({ id: `post:${post.sourceId}`, accepted: true, rationale: 'The synthetic original source supports this bounded post record.' })),
    ...identities.map(identity => ({ id: `identity:${identity.id}`, accepted: true, rationale: 'The synthetic source relationship is independently reviewed.' })),
    ...accounts.map(account => ({ id: `account:${account.accountId}`, accepted: true, rationale: 'The synthetic account fields are source-bound.' })),
  ];
  const review: SocialReview = {
    decisions,
    sources: sources.map(source => ({ sourceId: source.id, complete: true, rationale: 'Every required assertion in this synthetic source is reviewed.' })),
    pairs: pairs.map(pair => ({ id: pair.id, relation: options.pairRelation ?? 'COPIED_ENDORSEMENT', rationale: 'The synthetic pair relationship is explicitly reviewed.' })),
  };
  const read: SocialInput = {
    schemaVersion: 1,
    sources,
    start: SOCIAL_START,
    end: SOCIAL_END,
    targetPostIds,
    identitySourceIds,
    sampleComplete: true,
    identityComplete: identitySourceIds.length > 0,
    previousComparable: true,
    codes: [],
    queries: ['synthetic exact-contract scope'],
    qualifiedAt: SOCIAL_AVAILABLE,
  };
  return { read, proposal, review };
}

/** Adds the two fresh-model judgments and their independent review decisions to a synthetic fixture. */
export function addSocialJudgments(fixture: SocialFixture, overrides: SocialJudgmentOverrides = {}): SocialFixture {
  const citation = (sourceId: string | undefined) => {
    const source = fixture.read.sources.find(row => row.id === sourceId)
      ?? fixture.read.sources.find(row => row.kind === 'PAGE')
      ?? fixture.read.sources[0];
    if (!source || source.text.length < 8) throw new Error('SOCIAL_FIXTURE_CITATION_MISSING');
    return { sourceId: source.id, quote: source.text.slice(0, 1000) };
  };
  const identityCitation = citation(overrides.identitySourceId ?? 'identity-primary-project');
  const integrityCitation = citation(overrides.integritySourceId ?? 'post-alice-1');
  fixture.proposal.identityAssessment = {
    verdict: overrides.identity ?? 'SUPPORTED',
    rationale: 'The bounded synthetic public sources provide a source-qualified identity screening judgment.',
    citations: [identityCitation],
  };
  fixture.proposal.integrityAssessment = {
    verdict: overrides.integrity ?? 'SUPPORTED',
    rationale: 'The bounded synthetic current sample supports an independently reviewed integrity screening judgment.',
    citations: [integrityCitation],
  };
  fixture.review.decisions.push(
    { id: 'assessment:identity', accepted: true, rationale: 'The synthetic identity screening rationale matches the cited public source.' },
    { id: 'assessment:integrity', accepted: true, rationale: 'The synthetic integrity screening rationale matches the cited public source.' },
  );
  return fixture;
}
