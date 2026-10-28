import type { BaselineAssessment } from '../src/domain/baseline.js';

export type OriginDecision =
  | { verdict: 'PASS'; rationale: string }
  | { verdict: 'FAIL'; negativeBasis: 'FACTUAL_COUNTEREVIDENCE' | 'PUBLIC_SUPPORT_INADEQUATE'; rationale: string };

export function freshOriginAssessment(input: {
  evidenceIds: string[];
  citation: { sourceId: string; quote: string };
  availableAt: string;
  start: string;
  end: string;
  decision?: OriginDecision;
  factualValue?: boolean | null;
  quality?: 'KNOWN' | 'STALE' | 'MISSING';
}): BaselineAssessment {
  const quality = input.quality ?? 'KNOWN';
  const record = input.decision ? {
    method: 'evidence-constitution-v1' as const,
    criterion: 'NAR-02' as const,
    decision: { ...input.decision, citations: [input.citation] },
    availableAt: input.availableAt,
    start: input.start,
    end: input.end,
    evidenceIds: [...input.evidenceIds],
  } : undefined;
  return {
    id: 'A03', version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED',
    quality, unit: 'bool',
    data: { semanticJudgmentMethod: 'evidence-constitution-v1', ...(record ? { entryCriterionDecision: record } : {}) },
    observationIds: [], evidenceIds: [...input.evidenceIds], limitations: [], causes: [],
    projection: {
      id: 'A03', value: input.factualValue ?? true, unit: 'bool', quality,
      availableAt: input.availableAt, evidenceIds: [...input.evidenceIds], applicability: 'APPLICABLE',
    },
  };
}
