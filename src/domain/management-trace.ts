import { createHash } from 'node:crypto';
import type { EntryCheckResult, ExecutionBasisRef, ExitQuoteCheck, FeatureResult, ManagementBasisRef, ManagementCheckResult, ManagementResult, PositionEvent, PositionRecord, Predicate, Profile, ThesisEpisode } from './contracts.js';
import type { ExitProofReason } from './exit-proof.js';
import type { LedgerState, LegSelection } from './ledger.js';
import { combineExplanations, evaluateManagement, explainPredicate, predicateRefs, usable, type ExecutionInputs, type PredicateExplanation, type StageInputs } from './policy.js';

/**
 * Status-affecting management rules, fixed per recorded label so saved results replay with the rules that produced them.
 * ALL_TRIGGERS: MG-12 is due if any leg is due and unknown if any leg is unknown. ORDERED: the first leg not yet fully sold decides.
 */
export type ManagementRules = { legSelection: 'ALL_TRIGGERS' | 'ORDERED'; exitReviewQuantity: boolean; executionBasis: boolean };
/** Label recorded on new management snapshots. Pending owner confirmation, like v5 and v6. */
export const MANAGEMENT_POLICY_VERSION = 'thesis-management-v7';
export const MANAGEMENT_RULES: Readonly<Record<string, ManagementRules>> = {
  // v5: traceable rows (Checklist 2 packet 1).
  'thesis-management-v5': { legSelection: 'ALL_TRIGGERS', exitReviewQuantity: false, executionBasis: false },
  // v6: MG-12 follows the sale proposal's leg order; EXIT_REVIEW states remaining quantity and position mode (packet 2).
  'thesis-management-v6': { legSelection: 'ORDERED', exitReviewQuantity: true, executionBasis: false },
  // v7: successors are measured by their declared plan basis; MG-03 needs exact proof for the remaining holding and MG-15 for the candidate leg,
  // both bound to the execution-basis fingerprint; every position-derived amount carries its position context (round two).
  'thesis-management-v7': { legSelection: 'ORDERED', exitReviewQuantity: true, executionBasis: true },
};
/** Labels whose saved results predate traceability; they replay with the v5 rules, then with explanations stripped. */
export const LEGACY_MANAGEMENT_POLICY_VERSIONS: readonly string[] = ['thesis-management-v0'];

/**
 * PASS → RULE_SATISFIED · NOT_APPLICABLE → NOT_CONFIGURED · FAIL → the row-specific code ·
 * UNKNOWN → the first missing prerequisite (evidence, setting, plan, stage input, position, cost, reconciliation, leg, exit proof),
 * or PLAN_EXHAUSTED when every leg is sold and a successor plan is needed.
 * v7 adds PLAN_RECONCILIATION_REQUIRED (a successor without a declared plan basis), QUANTITY_CONFLICT (a due leg larger than the
 * inventory) and the exact exit-proof codes of exit-proof.ts.
 */
export type ManagementReasonCode =
  | 'RULE_SATISFIED' | 'NOT_CONFIGURED'
  | 'SAFETY_RULE_FAILED' | 'EXIT_RULE_FAILED' | 'SUPPORT_CONTRADICTED' | 'INVALIDATION_TRIGGERED' | 'CATALYST_CONTRADICTED'
  | 'TRACTION_NOT_MET' | 'WARNING_TRIGGERED' | 'TRIGGER_NOT_DUE' | 'HORIZON_EXPIRED'
  | 'INSUFFICIENT_EVIDENCE' | 'POLICY_PARAMETER_MISSING' | 'PLAN_UNSPECIFIED' | 'BASELINE_MISSING' | 'STAGE_INPUT_MISSING'
  | 'POSITION_MISSING' | 'COST_UNKNOWN' | 'UNRECONCILED_SALE' | 'NO_ELIGIBLE_LEG' | 'EXIT_NOT_CONFIRMED' | 'PLAN_EXHAUSTED'
  | 'PLAN_RECONCILIATION_REQUIRED' | 'QUANTITY_CONFLICT' | ExitProofReason;
type Status = ManagementCheckResult['status'];
export type RowTrace = { reasonCode: ManagementReasonCode; featureRefs: string[]; evidenceRefs: string[]; basisRefs: ManagementBasisRef[] };
export type TraceInputs = {
  episode: ThesisEpisode; features: FeatureResult[]; profile: Profile; cutoff: string; stageInputs: StageInputs;
  stage: { capBand: string; ageBand: string | null }; entryChecks: EntryCheckResult[];
  position: PositionRecord | null; ledger: LedgerState | null; candidate: { legId: string; quantityAtomic: string } | null;
  /** The ordered leg selection when MG-12 was decided by it (ORDERED rules); null under ALL_TRIGGERS. */
  legSelection: LegSelection | null;
  statuses: Record<string, Status>;
  /** v7 rules: rows cite the execution basis instead of the legacy ledger revision, and MG-03/MG-15 are explained by their exit quotes. */
  exact: boolean; exitRowsStatus: Status; executionBasis: ExecutionBasisRef | null; exitQuotes: ExitQuoteCheck[];
};

/** Profile risk limits read by the entry rows that MG-02/MG-03 reuse (policy.ts evaluateEntry). */
const ENTRY_RISK_LIMITS: Record<string, string[]> = {
  'SEC-04': ['maxTransferFeeBps'], 'LIQ-01': ['maxRemovableLiquidityShare'], 'EXE-02': ['maxEntryImpactBps', 'maxExitImpactBps', 'maxRoundTripLossBps'],
};
const SAFETY_ROWS = ['SEC-01', 'SEC-02', 'SEC-03', 'SEC-04', 'SEC-05', 'LIQ-01'], EXIT_ROWS = ['EXE-01', 'EXE-02'];
const basis = (kind: ManagementBasisRef['kind'], ref: string): ManagementBasisRef => ({ kind, ref });

/** Explains each management row's already-decided status; never changes a status. */
export function traceManagementRows(x: TraceInputs): Record<string, RowTrace> {
  const t = x.episode.thesis, s = x.statuses;
  const feature = (id: string) => x.features.find(f => f.id === id);
  const isUsable = (id: string) => usable(feature(id), x.cutoff);
  const row = (reasonCode: ManagementReasonCode, featureRefs: string[], basisRefs: ManagementBasisRef[]): RowTrace => ({
    reasonCode, featureRefs, basisRefs,
    evidenceRefs: [...new Set(featureRefs.flatMap(id => isUsable(id) ? feature(id)!.evidenceIds : []))],
  });
  const explain = (p: Predicate) => explainPredicate(p, x.features, x.cutoff);
  const ledgerRevision = x.exact ? (x.executionBasis ? [basis('EXECUTION_BASIS', x.executionBasis.fingerprint)] : [])
    : x.ledger ? [basis('LEDGER_REVISION', createHash('sha256').update(x.ledger.revision).digest('hex'))] : [];
  const positionRef = x.position ? [basis('POSITION', x.position.id)] : [];
  const legsField = [basis('THESIS_FIELD', 'legs')];

  function predicateRow(status: Status, field: string, failCode: ManagementReasonCode, explanation: PredicateExplanation | null, unconfigured: ManagementReasonCode): RowTrace {
    const fieldRef = [basis('THESIS_FIELD', field)];
    if (!explanation) return row(unconfigured, [], fieldRef);
    return row(status === 'PASS' ? 'RULE_SATISFIED' : status === 'FAIL' ? failCode : 'INSUFFICIENT_EVIDENCE', explanation.featureRefs, fieldRef);
  }

  function entryRow(status: Status, ids: string[], failCode: ManagementReasonCode): RowTrace {
    const rows = x.entryChecks.filter(c => ids.includes(c.checkId));
    const decisive = status === 'FAIL' ? rows.filter(r => r.status === 'FAIL') : status === 'UNKNOWN' ? rows.filter(r => r.status !== 'PASS') : rows;
    const missingLimits = (r: EntryCheckResult) => r.status === 'UNKNOWN' ? (ENTRY_RISK_LIMITS[r.checkId] ?? []).filter(k => x.profile.risk[k] === undefined) : [];
    const refsOf = (r: EntryCheckResult) => {
      if (r.status !== 'UNKNOWN') return r.featureRefs;
      const unusable = r.featureRefs.filter(id => !isUsable(id));
      return unusable.length ? unusable : missingLimits(r).length ? [] : r.featureRefs;
    };
    const featureRefs = [...new Set(decisive.flatMap(refsOf))];
    const limits = [...new Set(decisive.flatMap(missingLimits))];
    const code: ManagementReasonCode = status === 'PASS' ? 'RULE_SATISFIED' : status === 'FAIL' ? failCode
      : decisive.some(r => r.featureRefs.some(id => !isUsable(id))) || !limits.length ? 'INSUFFICIENT_EVIDENCE' : 'POLICY_PARAMETER_MISSING';
    return row(code, featureRefs, [...decisive.map(r => basis('ENTRY_CHECK', r.checkId)), ...limits.map(k => basis('PROFILE_FIELD', `risk.${k}`))]);
  }

  function coherenceRow(): RowTrace {
    const fields = [['support', t.support], ['invalidation', t.invalidation], ['catalyst', t.catalyst ? [t.catalyst] : []]] as const;
    const referenced = [...new Set(fields.flatMap(([, ps]) => ps.flatMap(predicateRefs)))];
    const fieldRefs = fields.filter(([, ps]) => ps.length).map(([name]) => basis('THESIS_FIELD', name));
    return s['MG-04'] === 'PASS' ? row('RULE_SATISFIED', referenced, fieldRefs) : row('INSUFFICIENT_EVIDENCE', referenced.filter(id => !isUsable(id)), fieldRefs);
  }

  function stageRow(): RowTrace {
    const created = x.stageInputs.tokenCreatedAt, createdAt = created ? Date.parse(created) : NaN;
    const missing = [
      ...(x.stage.capBand === 'UNKNOWN' ? ['circulatingMarketCapUsd'] : []),
      ...(!Number.isFinite(createdAt) || Date.parse(x.cutoff) < createdAt ? ['tokenCreatedAt'] : []),
    ];
    const ageBands = basis('PROFILE_FIELD', 'stage.ageBands');
    if (s['MG-05'] === 'PASS') return row('RULE_SATISFIED', [], [basis('STAGE_INPUT', 'circulatingMarketCapUsd'), basis('STAGE_INPUT', 'tokenCreatedAt'), ageBands]);
    if (missing.length) return row('STAGE_INPUT_MISSING', [], missing.map(k => basis('STAGE_INPUT', k)));
    return row('POLICY_PARAMETER_MISSING', [], [ageBands]);
  }

  function triggerRow(): RowTrace {
    if (!t.legs.length) return row('PLAN_UNSPECIFIED', [], legsField);
    if (x.legSelection) return orderedTriggerRow(x.legSelection);
    const legs = t.legs.map(l => ({ id: l.id, e: explain(l.trigger) }));
    const status = s['MG-12'];
    const decisive = status === 'UNKNOWN' ? legs.filter(l => l.e.truth === 'UNKNOWN') : status === 'PASS' ? legs.filter(l => l.e.truth === 'TRUE') : legs;
    const code: ManagementReasonCode = status === 'PASS' ? 'RULE_SATISFIED' : status === 'FAIL' ? 'TRIGGER_NOT_DUE' : 'INSUFFICIENT_EVIDENCE';
    return row(code, [...new Set(decisive.flatMap(l => l.e.featureRefs))], decisive.map(l => basis('EXIT_LEG', l.id)));
  }

  function orderedTriggerRow(next: LegSelection): RowTrace {
    if (next.kind === 'UNRESOLVED_PLAN') return row('PLAN_RECONCILIATION_REQUIRED', [], [...positionRef, ...ledgerRevision]);
    if (next.kind === 'UNRECONCILED') return row('UNRECONCILED_SALE', [], [...positionRef, ...ledgerRevision]);
    if (next.kind === 'EXHAUSTED') return row('PLAN_EXHAUSTED', [], [...t.legs.map(l => basis('EXIT_LEG', l.id)), ...ledgerRevision]);
    if (next.kind === 'NO_PLAN') return row('PLAN_UNSPECIFIED', [], legsField);
    const trigger = explain(t.legs.find(l => l.id === next.legId)!.trigger);
    const code: ManagementReasonCode = next.kind === 'DUE' ? 'RULE_SATISFIED' : next.kind === 'NOT_DUE' ? 'TRIGGER_NOT_DUE' : 'INSUFFICIENT_EVIDENCE';
    return row(code, trigger.featureRefs, [basis('EXIT_LEG', next.legId), ...ledgerRevision]);
  }

  function quantityRow(): RowTrace {
    const code: ManagementReasonCode = s['MG-13'] === 'PASS' ? 'RULE_SATISFIED' : !x.ledger ? 'POSITION_MISSING' : x.ledger.knownCost === null ? 'COST_UNKNOWN'
      : t.legs.length && x.legSelection?.kind === 'UNRESOLVED_PLAN' ? 'PLAN_RECONCILIATION_REQUIRED' : 'PLAN_UNSPECIFIED';
    return row(code, [], [...positionRef, ...ledgerRevision, ...legsField]);
  }

  function feasibilityRow(): RowTrace {
    const exitRefs = EXIT_ROWS.flatMap(id => x.entryChecks.find(c => c.checkId === id)?.featureRefs ?? []);
    if (s['MG-15'] === 'PASS') return row('RULE_SATISFIED', [...new Set(exitRefs)], [basis('EXIT_LEG', x.candidate!.legId), ...positionRef, ...ledgerRevision, ...EXIT_ROWS.map(id => basis('ENTRY_CHECK', id))]);
    if (!x.position || !x.ledger) return row('POSITION_MISSING', [], []);
    if (!t.legs.length) return row('PLAN_UNSPECIFIED', [], legsField);
    if (x.ledger.unreconciledSale) return row('UNRECONCILED_SALE', [], [...positionRef, ...ledgerRevision]);
    if (!x.candidate) return row('NO_ELIGIBLE_LEG', [], [...legsField, ...ledgerRevision]);
    const exit = entryRow(s['MG-03'], EXIT_ROWS, 'EXIT_RULE_FAILED');
    return row('EXIT_NOT_CONFIRMED', exit.featureRefs, [basis('EXIT_LEG', x.candidate.legId), ...exit.basisRefs]);
  }

  /** An exit quote's verdict, citing the position, execution basis, the proofs it rests on and any missing profile setting. */
  function quoteRow(q: ExitQuoteCheck, refs: ManagementBasisRef[], featureRefs: string[] = []): RowTrace {
    const settings = q.reasonCode === 'POLICY_PARAMETER_MISSING'
      ? [...(x.profile.exitProofLevel ? [] : ['exitProofLevel']), ...(x.profile.risk.maxExitImpactBps === undefined ? ['risk.maxExitImpactBps'] : [])].map(k => basis('PROFILE_FIELD', k)) : [];
    return row(q.reasonCode as ManagementReasonCode, featureRefs, [...refs, ...positionRef, ...ledgerRevision, ...q.proofIds.map(id => basis('EXIT_PROOF', id)), ...settings]);
  }

  /** v7 MG-03: entry-sized exit rows decide unless they pass or only the remaining-holding proof failed; then that proof explains the row. */
  function holdingExitRow(): RowTrace {
    const remaining = x.exitQuotes.find(q => q.request.purpose === 'REMAINING_POSITION');
    if (!remaining || x.exitRowsStatus === 'FAIL' || (x.exitRowsStatus === 'UNKNOWN' && remaining.status !== 'FAIL')) return entryRow(s['MG-03'], EXIT_ROWS, 'EXIT_RULE_FAILED');
    if (remaining.status !== 'PASS') return quoteRow(remaining, []);
    const rows = entryRow('PASS', EXIT_ROWS, 'EXIT_RULE_FAILED');
    return quoteRow(remaining, rows.basisRefs, rows.featureRefs);
  }

  /** v7 MG-15: the exact quote for the due step, or for the next step while none is due; otherwise why there is none, never hiding a step that does not fit. */
  function exactFeasibilityRow(): RowTrace {
    const step = x.exitQuotes.find(q => q.request.purpose === 'CANDIDATE_LEG') ?? x.exitQuotes.find(q => q.request.purpose === 'NEXT_LEG');
    if (step) return quoteRow(step, [basis('EXIT_LEG', step.request.legId!)]);
    if (!x.position || !x.ledger) return row('POSITION_MISSING', [], []);
    if (!t.legs.length) return row('PLAN_UNSPECIFIED', [], legsField);
    const next = x.legSelection;
    if (next?.kind === 'UNRESOLVED_PLAN') return row('PLAN_RECONCILIATION_REQUIRED', [], [...positionRef, ...ledgerRevision]);
    if (next?.kind === 'UNRECONCILED') return row('UNRECONCILED_SALE', [], [...positionRef, ...ledgerRevision]);
    if (next?.kind === 'DUE' || next?.kind === 'NOT_DUE') return row('QUANTITY_CONFLICT', [], [basis('EXIT_LEG', next.legId), ...positionRef, ...ledgerRevision]);
    return row('NO_ELIGIBLE_LEG', [], [...legsField, ...ledgerRevision]);
  }

  const optional = (p: Predicate | null) => p ? explain(p) : null;
  return {
    'MG-01': s['MG-01'] === 'PASS' ? row('RULE_SATISFIED', [], [basis('EPISODE', x.episode.id), basis('BASELINE_SNAPSHOT', x.episode.baselineSnapshotId)]) : row('BASELINE_MISSING', [], [basis('EPISODE', x.episode.id)]),
    'MG-02': entryRow(s['MG-02'], SAFETY_ROWS, 'SAFETY_RULE_FAILED'),
    'MG-03': x.exact ? holdingExitRow() : entryRow(s['MG-03'], EXIT_ROWS, 'EXIT_RULE_FAILED'),
    'MG-04': coherenceRow(),
    'MG-05': stageRow(),
    'MG-06': predicateRow(s['MG-06'], 'support', 'SUPPORT_CONTRADICTED', combineExplanations('all', t.support.map(explain)), 'PLAN_UNSPECIFIED'),
    'MG-07': predicateRow(s['MG-07'], 'invalidation', 'INVALIDATION_TRIGGERED', combineExplanations('any', t.invalidation.map(explain)), 'PLAN_UNSPECIFIED'),
    'MG-08': predicateRow(s['MG-08'], 'catalyst', 'CATALYST_CONTRADICTED', optional(t.catalyst), 'NOT_CONFIGURED'),
    'MG-09': predicateRow(s['MG-09'], 'onchainTraction', 'TRACTION_NOT_MET', optional(t.onchainTraction), 'PLAN_UNSPECIFIED'),
    'MG-10': predicateRow(s['MG-10'], 'externalTraction', 'TRACTION_NOT_MET', optional(t.externalTraction), 'PLAN_UNSPECIFIED'),
    'MG-11': predicateRow(s['MG-11'], 'warning', 'WARNING_TRIGGERED', optional(t.warning), 'NOT_CONFIGURED'),
    'MG-12': triggerRow(),
    'MG-13': quantityRow(),
    'MG-14': t.expiryAt ? row(s['MG-14'] === 'FAIL' ? 'HORIZON_EXPIRED' : 'RULE_SATISFIED', [], [basis('THESIS_FIELD', 'expiryAt')]) : row('NOT_CONFIGURED', [], [basis('THESIS_FIELD', 'expiryAt')]),
    'MG-15': x.exact ? exactFeasibilityRow() : feasibilityRow(),
  };
}

/** The pre-traceability shape: same statuses and proposal, empty refs, no basis, three generic reason codes. */
export function toLegacyManagementResult(result: ManagementResult): ManagementResult {
  return {
    ...result,
    checks: result.checks.map(({ basisRefs: _basis, ...c }) => ({
      ...c, featureRefs: [], evidenceRefs: [],
      reasonCode: c.status === 'UNKNOWN' ? 'INSUFFICIENT_EVIDENCE' : c.status === 'FAIL' ? 'RULE_FAILED' : 'RULE_SATISFIED',
    })),
  };
}

type ManagementInputs = [episode: ThesisEpisode, features: FeatureResult[], position: PositionRecord | null, events: PositionEvent[], profile: Profile, cutoff: string, stageInputs?: StageInputs, execution?: ExecutionInputs];

/** Evaluates management with the rules and result shape of a recorded label; unknown labels fail closed. Labels before v7 ignore execution inputs. */
export function evaluateManagementAs(policyVersion: unknown, ...[episode, features, position, events, profile, cutoff, stageInputs, execution]: ManagementInputs): ManagementResult {
  const legacy = typeof policyVersion === 'string' && LEGACY_MANAGEMENT_POLICY_VERSIONS.includes(policyVersion);
  const rules = legacy ? MANAGEMENT_RULES['thesis-management-v5'] : typeof policyVersion === 'string' && Object.hasOwn(MANAGEMENT_RULES, policyVersion) ? MANAGEMENT_RULES[policyVersion] : undefined;
  if (!rules) throw new Error('UNSUPPORTED_POLICY_VERSION');
  const result = evaluateManagement(episode, features, position, events, profile, cutoff, stageInputs, rules, execution);
  return legacy ? toLegacyManagementResult(result) : result;
}
