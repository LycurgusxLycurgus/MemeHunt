import type { BaselineAssessment } from '../src/domain/baseline.js';
import type { AttentionEntryBounds } from '../src/domain/attention.js';

export type NarrativeFixtureOutcome = 'SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT' | 'UNKNOWN';

export type AttentionBoundsFixtureOptions = {
  posts?: AttentionEntryBounds['posts'];
  accounts?: AttentionEntryBounds['accounts'];
  previous?: AttentionEntryBounds['previous'];
  current?: AttentionEntryBounds['current'];
  complete?: boolean;
  inspectionComplete?: boolean;
  narrative?: NarrativeFixtureOutcome;
  measured?: { posts: string; accounts: string; growth?: boolean };
};

/** Small deterministic carrier for testing the pure resolver and its consumers. */
export function attentionBoundsFixture(options: AttentionBoundsFixtureOptions = {}): BaselineAssessment[] {
  const sourceIds = ['post-1', 'post-2', 'post-3', 'post-4'];
  const bounds: AttentionEntryBounds & { inspectionComplete?: boolean } = {
    method: 'accepted-post-intervals-v1', complete: options.complete ?? true,
    start: '2026-09-30T12:00:00.000Z', end: '2026-10-01T12:00:00.000Z',
    midpoint: '2026-10-01T00:00:00.000Z',
    queries: ['exact token narrative', 'exact token posts'], sourceIds, blockers: [],
    dispositions: sourceIds.map((sourceId, index) => ({
      sourceId, originalContent: 'RETAINED', bin: index < 2 ? 'PREVIOUS' : 'CURRENT',
      classification: index < 3 ? 'QUALIFIED' : 'POTENTIAL',
      reasons: [index < 3 ? 'ACCEPTED_DATED_EXACT_TOKEN_ORIGINAL' : 'ORIGINAL_METADATA_UNRESOLVED'],
      citations: [{ sourceId, quote: `Retained exact token post ${index + 1}.` }],
    })),
    posts: options.posts ?? { lower: 3, upper: 4 },
    accounts: options.accounts ?? { lower: 3, upper: 4 },
    previous: options.previous ?? { lower: 2, upper: 3 },
    current: options.current ?? { lower: 1, upper: 2 },
    ...(options.inspectionComplete === false ? { inspectionComplete: false } : { inspectionComplete: true }),
  };

  const projection = (id: string, value: string | boolean | null, quality: BaselineAssessment['quality']): NonNullable<BaselineAssessment['projection']> => ({
    id, value, unit: id === 'A16' || id === 'A17' ? 'count' : 'bool', quality,
    availableAt: '2026-10-01T12:00:00.000Z', evidenceIds: sourceIds, applicability: 'APPLICABLE',
  });
  const fact = (id: string, value: string | boolean | null, quality: BaselineAssessment['quality'], data: unknown = null): BaselineAssessment => ({
    id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality,
    unit: typeof value === 'string' ? 'count' : 'bool', data, observationIds: [], evidenceIds: sourceIds,
    limitations: [], causes: quality === 'KNOWN' ? [] : [{ category: 'CLAIM_UNVALIDATED', code: 'FIXTURE_UNKNOWN', featureId: id, evidenceIds: sourceIds, action: 'Complete the fixture evidence.' }],
    projection: projection(id, value, quality),
  });

  const narrativeOutcome = options.narrative ?? 'SUPPORTED';
  const narrative = fact('A01', narrativeOutcome === 'SUPPORTED' ? true : narrativeOutcome === 'UNKNOWN' ? null : false,
    narrativeOutcome === 'UNKNOWN' ? 'MISSING' : 'KNOWN',
    narrativeOutcome === 'INSUFFICIENT'
      ? { method: 'narrative-public-support-v1', publicSupport: { citations: [{ sourceId: 'post-1', quote: 'Retained exact token post 1.' }] } }
      : { method: 'automated-source-review-v1' });
  const otherNarrative = [fact('A02', true, 'KNOWN'), fact('A05', true, 'KNOWN')];
  const measured = options.measured;
  const a15 = fact('A15', measured ? true : null, measured ? 'KNOWN' : 'MISSING', { entryBounds: bounds });
  const a16 = fact('A16', measured?.posts ?? null, measured ? 'KNOWN' : 'MISSING');
  const a17 = fact('A17', measured?.accounts ?? null, measured ? 'KNOWN' : 'MISSING');
  const a18 = fact('A18', measured?.growth ?? null, measured?.growth === undefined ? 'MISSING' : 'KNOWN', { entryBounds: bounds });
  return [narrative, ...otherNarrative, a15, a16, a17, a18];
}
