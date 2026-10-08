import { completeFixtureEntryFeatures, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { deriveBaseline } from '../src/domain/baseline.js';
import { sharedClaims, type SharedAudit, type SharedInputs } from '../src/domain/shared.js';
import type { AttentionSource } from '../src/providers/attention.js';

export const SHARED_TOKEN = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
export const SHARED_CUTOFF = '2026-10-01T12:00:00.000Z';

function evidence(id: string, availableAt = SHARED_CUTOFF) {
  return {
    id, sourceId: 'shared-test-fixture', sourceType: 'FIXTURE', retrievedAt: availableAt, availableAt,
    contentHash: 'a'.repeat(64), adapterVersion: 'shared-fixture-v1', accessMode: 'LOCAL_DERIVED' as const,
    scope: { sanitized: true },
  };
}

function source(id: string, text: string): AttentionSource {
  return {
    id, url: `https://public.example/${id}`, text, publishedAt: null, authorId: null,
    availableAt: SHARED_CUTOFF, kind: 'PAGE',
  };
}

export function sharedFixture(): SharedInputs {
  const features = completeFixtureEntryFeatures({ A16: '12', A17: '4', A18: true, S10: true });
  for (const feature of features) {
    feature.availableAt = SHARED_CUTOFF;
    feature.evidenceIds = [`feature-evidence-${feature.id}`];
  }
  const evidenceRows = features.map(feature => evidence(feature.evidenceIds[0]!));
  evidenceRows.push(evidence('attention-qualified-receipt'), evidence('social-qualified-receipt'), evidence('social-evidence'));
  const textLines: string[] = [];
  const citations = new Map<string, string>();
  for (const id of ['A01', 'A02', 'A03', 'A04', 'A05']) {
    const quote = `Synthetic source explicitly supports the qualified ${id} assertion for the target token.`;
    citations.set(id, quote);
    textLines.push(quote);
  }
  const competitorQuote = `A synthetic acquired source links ${SHARED_TOKEN.address} with a distinct project representation.`;
  const originQuote = `A synthetic dated project post identifies ${SHARED_TOKEN.address} as its contract.`;
  textLines.push(competitorQuote, originQuote);
  const attentionSource = source('attention-source', textLines.join('\n'));
  const socialIdentityQuote = 'Synthetic account identity evidence is independently qualified.';
  const socialIntegrityQuote = 'Synthetic account integrity evidence is independently qualified.';
  const socialSource = source('social-source', `${socialIdentityQuote}\n${socialIntegrityQuote}`);
  const sources = [attentionSource, socialSource];
  const baseline = deriveBaseline({
    token: SHARED_TOKEN, cutoff: SHARED_CUTOFF, profile: illustrativeUncalibratedProfile,
    features, evidence: evidenceRows, observations: [],
  });
  for (const id of ['A01', 'A02', 'A03', 'A04', 'A05']) {
    const row = baseline.find(item => item.id === id)!;
    row.quality = 'KNOWN';
    row.data = { summary: `Qualified synthetic ${id} assertion.`, citations: [{ sourceId: attentionSource.id, quote: citations.get(id)! }] };
  }
  const candidateRow = baseline.find(item => item.id === 'A09')!;
  candidateRow.quality = 'KNOWN';
  candidateRow.data = { candidates: [{ token: { chain: 'base', address: '0x2222222222222222222222222222222222222222' }, sourceId: attentionSource.id, quote: competitorQuote }] };
  const originRow = baseline.find(item => item.id === 'A14')!;
  originRow.quality = 'KNOWN';
  originRow.data = { originRelationship: { status: 'SUPPORTED', rationale: 'The synthetic primary post supports the bounded origin claim.', citations: [{ sourceId: attentionSource.id, quote: originQuote }] } };

  const socialCitation = (quote: string) => [{ sourceId: socialSource.id, quote }];
  const social: NonNullable<SharedInputs['social']> = {
    version: 'social-policy-v1', method: 'social-source-review-v1', token: SHARED_TOKEN,
    start: '2026-10-01T00:00:00.000Z', end: SHARED_CUTOFF, availableAt: SHARED_CUTOFF,
    evidenceIds: ['social-evidence'], postCorpusObserved: true, sampleComplete: true, lineageComplete: true,
    qualifiedOriginalCount: 12, accountUpperBound: 4, independentGroupCount: 3, independentCommunityCount: 2,
    identityReview: {
      method: 'source-transparency-review-v1', verdict: 'SUPPORTED', rationale: 'The synthetic identity judgment is source-bound.',
      citations: socialCitation(socialIdentityQuote), missingIndicators: [],
    },
    integrityReview: {
      method: 'source-transparency-review-v1', verdict: 'SUPPORTED', rationale: 'The synthetic integrity judgment is source-bound.',
      citations: socialCitation(socialIntegrityQuote), missingIndicators: [],
    },
  };
  const claims = sharedClaims(baseline, social);
  const audit: SharedAudit = {
    claims: claims.map(claim => ({ id: claim.id, disposition: 'CLEAR', rationale: 'The complete synthetic source set contains no incompatible assertion.', citations: claim.citations })),
    review: claims.map(claim => ({ id: claim.id, accepted: true })),
    sources: sources.map(item => ({ id: item.id, complete: true })),
  };
  return {
    token: SHARED_TOKEN, cutoff: SHARED_CUTOFF, profile: illustrativeUncalibratedProfile,
    baseline, features, evidence: evidenceRows, observations: [], social,
    claims, sources, audit,
    semanticReceiptIds: ['attention-qualified-receipt', 'social-qualified-receipt'],
  };
}

export function requalifyAudit(input: SharedInputs, disposition: 'CLEAR' | 'CONFLICT' | 'UNCLEAR' = 'CLEAR'): SharedAudit {
  const claims = input.claims.map(claim => ({
    id: claim.id, disposition, rationale: `Synthetic ${disposition.toLowerCase()} cross-claim audit disposition.`,
    citations: disposition === 'CONFLICT' && input.sources.length > 1
      ? [claim.citations[0]!, {
        sourceId: input.sources.find(item => item.id !== claim.citations[0]!.sourceId)!.id,
        quote: input.sources.find(item => item.id !== claim.citations[0]!.sourceId)!.text.split('\n')[0]!,
      }]
      : claim.citations,
  }));
  return {
    claims,
    review: input.claims.map(claim => ({ id: claim.id, accepted: true })),
    sources: input.sources.map(item => ({ id: item.id, complete: true })),
  };
}
