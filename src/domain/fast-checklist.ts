export const fastPolicyId = 'research-fast-v3' as const;
export type FastPolicyId=typeof fastPolicyId;
export const isFastPolicy=(id:unknown):id is FastPolicyId=>id===fastPolicyId;
export const isRetiredFastPolicy=(id:unknown):boolean=>id==='research-fast-v2'||id==='research-fast-attention-v1'||id==='research-fast-single-experiment-v1';

export const fastAttentionCheckIds = ['NAR-01', 'ADV-03'] as const;
export const fastChainContextCheckIds = [
  'SEC-01', 'SEC-02', 'SEC-03', 'SEC-04', 'SEC-05', 'LIQ-01',
  'EXE-01', 'EXE-02', 'EXE-03', 'OWN-01', 'OWN-02', 'MKT-01',
  'ADV-01', 'ADV-02', 'ID-01', 'CTX-01', 'CAP-01', 'ADV-05',
] as const;
export const fastRequiredCheckIds = [...fastAttentionCheckIds, ...fastChainContextCheckIds] as const;

export type FastOutcome = 'SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT' | 'UNKNOWN';
export type FastCheckId = typeof fastRequiredCheckIds[number];
export type FastChecklistRow = { checkId: FastCheckId; outcome: FastOutcome };
export type FastChecklistClassification = 'FAST_REJECTED' | 'FAST_SHORTLIST' | 'FAST_UNAVAILABLE';
export type FastChecklistResult = {
  policyId: FastPolicyId;
  classification: FastChecklistClassification;
  binary: 'FAIL';
  coverage: { known: number; total: typeof fastRequiredCheckIds['length'] };
  requiredCheckIds: FastCheckId[];
  rows: FastChecklistRow[];
};

const knownOutcomes = new Set<FastOutcome>(['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT']);
const validOutcomes = new Set<FastOutcome>([...knownOutcomes, 'UNKNOWN']);

/** Classifies already validated fast-check results; it does not authenticate or qualify their evidence. */
export function deriveFastChecklist(rows: ReadonlyArray<{ checkId: string; outcome: FastOutcome }>,policyId:FastPolicyId=fastPolicyId,unavailableSupport:ReadonlyArray<string>=[]): FastChecklistResult {
  if (!Array.isArray(rows)) throw new Error('FAST_CHECKLIST_SCOPE_INVALID');
  const byId = new Map<string, FastOutcome>();
  for (const row of rows) {
    if (!row || typeof row.checkId !== 'string' || !fastRequiredCheckIds.includes(row.checkId as FastCheckId) ||
        !validOutcomes.has(row.outcome) || byId.has(row.checkId)) {
      throw new Error('FAST_CHECKLIST_SCOPE_INVALID');
    }
    byId.set(row.checkId, row.outcome);
  }

  if(byId.size!==fastRequiredCheckIds.length)throw new Error('FAST_CHECKLIST_SCOPE_INVALID');
  const normalizedRows: FastChecklistRow[] = fastRequiredCheckIds.map(checkId => ({
    checkId,
    outcome: byId.get(checkId)!,
  }));
  const negative = normalizedRows.some(row => row.outcome === 'CONTRADICTED' || row.outcome === 'INSUFFICIENT'&&!unavailableSupport.includes(row.checkId));
  const allSupported = normalizedRows.every(row => row.outcome === 'SUPPORTED');
  const classification: FastChecklistClassification = negative
    ? 'FAST_REJECTED'
    : allSupported ? 'FAST_SHORTLIST' : 'FAST_UNAVAILABLE';

  return {
    policyId,
    classification,
    binary: 'FAIL',
    coverage: { known: normalizedRows.filter(row => knownOutcomes.has(row.outcome)&&!unavailableSupport.includes(row.checkId)).length, total: fastRequiredCheckIds.length },
    requiredCheckIds: [...fastRequiredCheckIds],
    rows: normalizedRows,
  };
}
