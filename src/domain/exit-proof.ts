import { Decimal } from 'decimal.js';
import type { EvidenceRecord, ExitProof, ExitQuoteCheck, ExitQuoteRequest, PositionRecord, Profile } from './contracts.js';

/**
 * Exit-quote adapters whose source-bound proofs count as verified. Only the synthetic fixture adapter exists in this branch
 * (CLI capabilities lists no certified venue); live adapters join when Checklist 1 publishes a certified quote producer.
 */
export const SUPPORTED_EXIT_QUOTE_ADAPTERS: readonly string[] = ['fixture-exit-quote-v1'];
export const SCENARIO_QUOTE_LABEL = 'scenario quote, not verified';

export type ExitProofReason =
  | 'RULE_SATISFIED' | 'POLICY_PARAMETER_MISSING'
  | 'EXIT_PROOF_MISSING' | 'EXIT_PROOF_MISMATCH' | 'EXIT_PROOF_NOT_CURRENT' | 'EXIT_PROOF_UNSUPPORTED' | 'EXIT_PROOF_UNVERIFIED' | 'EXIT_PROOF_INCOMPLETE' | 'EXIT_PROOF_CONFLICT'
  | 'EXIT_ROUTE_BLOCKED' | 'TOKEN_EXIT_RESTRICTED' | 'EXIT_LIMIT_EXCEEDED';
export type ExitQuoteContext = { cutoff: string; profile: Profile; evidence: EvidenceRecord[]; mode: PositionRecord['mode'] };
type Usable = { proof: ExitProof; trust: 'VERIFIED' | 'SCENARIO'; feasibility: 'FILLABLE' | 'BLOCKED' | 'OVER_LIMIT'; worstNet: bigint; feesOut: bigint };
type Unusable = 'EXIT_PROOF_NOT_CURRENT' | 'EXIT_PROOF_UNSUPPORTED' | 'EXIT_PROOF_UNVERIFIED' | 'EXIT_PROOF_INCOMPLETE';
/** When no matching proof is usable, the reported cause is the first of these that any of them hit. */
const UNUSABLE_PRECEDENCE: Unusable[] = ['EXIT_PROOF_UNVERIFIED', 'EXIT_PROOF_UNSUPPORTED', 'EXIT_PROOF_INCOMPLETE', 'EXIT_PROOF_NOT_CURRENT'];

const matches = (p: ExitProof, r: ExitQuoteRequest) => r.token !== null
  && p.token.chain === r.token.chain && p.token.address === r.token.address && p.caseId === r.caseId && p.episodeId === r.episodeId
  && p.positionId === r.positionId && p.legId === r.legId && BigInt(p.quantityAtomic) === BigInt(r.quantityAtomic) && p.decimals === r.decimals
  && p.executionBasis.version === r.executionBasis.version && p.executionBasis.fingerprint === r.executionBasis.fingerprint;

/**
 * One matching proof, checked in order: current at the cutoff; every cited evidence record present and available no later than the proof;
 * trust (any user-imported evidence makes it a scenario, accepted only for a HYPOTHETICAL position; otherwise its adapter must be supported
 * and must have produced cited evidence); the profile's required level; fees in another asset converted with evidence. Then the outcome:
 * blocked, over the impact limit or not worth selling (worst-case output minus fees at or below zero), or fillable.
 */
function assess(p: ExitProof, x: ExitQuoteContext, level: 'QUOTED' | 'SIMULATED', maxImpactBps: Decimal): Usable | Unusable {
  const cutoff = Date.parse(x.cutoff);
  if (!(Date.parse(p.asOf) <= cutoff && Date.parse(p.availableAt) <= cutoff && cutoff < Date.parse(p.expiresAt))) return 'EXIT_PROOF_NOT_CURRENT';
  const record = (id: string) => x.evidence.find(e => e.id === id && Date.parse(e.availableAt) <= Date.parse(p.availableAt));
  const conversions = p.outcome === 'FILLABLE' ? p.fees.flatMap(f => f.conversionEvidenceIds) : [];
  const cited = [...p.evidenceIds, ...conversions].map(record);
  if (cited.some(e => !e)) return 'EXIT_PROOF_INCOMPLETE';
  const trust = cited.some(e => e!.accessMode === 'USER_IMPORT') ? 'SCENARIO' : 'VERIFIED';
  if (trust === 'SCENARIO' && x.mode !== 'HYPOTHETICAL') return 'EXIT_PROOF_UNVERIFIED';
  if (trust === 'VERIFIED' && (!SUPPORTED_EXIT_QUOTE_ADAPTERS.includes(p.route.adapter) || !p.evidenceIds.some(id => record(id)!.adapterVersion === p.route.adapter))) return 'EXIT_PROOF_UNSUPPORTED';
  if (level === 'SIMULATED' && p.level !== 'SIMULATED') return 'EXIT_PROOF_UNSUPPORTED';
  if (p.outcome === 'BLOCKED') return { proof: p, trust, feasibility: 'BLOCKED', worstNet: 0n, feesOut: 0n };
  let feesOut = 0n;
  for (const f of p.fees) {
    if (f.includedInOutput) continue;
    if (f.asset === p.output.asset) feesOut += BigInt(f.amountAtomic);
    else if (f.outputAmountAtomic !== null && f.conversionEvidenceIds.length) feesOut += BigInt(f.outputAmountAtomic);
    else return 'EXIT_PROOF_INCOMPLETE';
  }
  const worstNet = BigInt(p.output.minimumAtomic) - feesOut;
  return { proof: p, trust, feasibility: new Decimal(p.output.priceImpactBps).gt(maxImpactBps) || worstNet <= 0n ? 'OVER_LIMIT' : 'FILLABLE', worstNet, feesOut };
}

/**
 * Judges one exact exit quote request against the supplied proofs. Missing, mismatched, stale, unsupported, unverified, incomplete or
 * contradictory evidence is UNKNOWN; agreeing usable proofs give PASS (fillable within limits) or FAIL (blocked or over limit).
 * The request is always returned, so the operator can see exactly which quote is needed. No trade is placed.
 */
export function checkExitQuote(request: ExitQuoteRequest, proofs: ExitProof[], x: ExitQuoteContext): ExitQuoteCheck {
  const verdict = (status: ExitQuoteCheck['status'], feasibility: ExitQuoteCheck['feasibility'], reasonCode: ExitProofReason, proofIds: string[], used: Usable[] = [], quote: ExitQuoteCheck['quote'] = null): ExitQuoteCheck => {
    const trust = !used.length ? null : used.every(u => u.trust === 'VERIFIED') ? 'VERIFIED' : 'SCENARIO';
    return { request, status, feasibility, reasonCode, proofIds, trust, label: trust === 'SCENARIO' ? SCENARIO_QUOTE_LABEL : null, quote };
  };
  const level = x.profile.exitProofLevel, maxImpact = x.profile.risk.maxExitImpactBps;
  if (!level || maxImpact === undefined) return verdict('UNKNOWN', 'UNKNOWN', 'POLICY_PARAMETER_MISSING', []);
  const samePurpose = proofs.filter(p => p.purpose === request.purpose);
  if (!samePurpose.length) return verdict('UNKNOWN', 'UNKNOWN', 'EXIT_PROOF_MISSING', []);
  const matching = samePurpose.filter(p => matches(p, request)).sort((a, b) => a.id.localeCompare(b.id));
  if (!matching.length) return verdict('UNKNOWN', 'UNKNOWN', 'EXIT_PROOF_MISMATCH', samePurpose.map(p => p.id).sort());
  const assessed = matching.map(p => assess(p, x, level, new Decimal(maxImpact)));
  const usable = assessed.filter((a): a is Usable => typeof a !== 'string');
  if (!usable.length) return verdict('UNKNOWN', 'UNKNOWN', UNUSABLE_PRECEDENCE.find(r => assessed.includes(r))!, matching.map(p => p.id));
  const ids = usable.map(u => u.proof.id), fillable = usable.filter(u => u.feasibility === 'FILLABLE');
  if (fillable.length === usable.length) {
    const { proof, feesOut } = [...fillable].sort((a, b) => a.worstNet < b.worstNet ? -1 : a.worstNet > b.worstNet ? 1 : a.proof.id.localeCompare(b.proof.id))[0]!;
    if (proof.outcome !== 'FILLABLE') throw new Error('EXIT_PROOF_OUTCOME');
    return verdict('PASS', 'FILLABLE', 'RULE_SATISFIED', ids, usable, {
      outputAsset: proof.output.asset, outputDecimals: proof.output.decimals, expectedOutputAtomic: proof.output.expectedAtomic,
      minimumOutputAtomic: proof.output.minimumAtomic, feesInOutputAtomic: feesOut.toString(), priceImpactBps: proof.output.priceImpactBps,
    });
  }
  if (fillable.length) return verdict('UNKNOWN', 'UNKNOWN', 'EXIT_PROOF_CONFLICT', ids, usable);
  const blocked = usable.filter(u => u.proof.outcome === 'BLOCKED');
  const reason = blocked.some(u => u.proof.outcome === 'BLOCKED' && u.proof.blockedScope === 'TOKEN') ? 'TOKEN_EXIT_RESTRICTED' : blocked.length ? 'EXIT_ROUTE_BLOCKED' : 'EXIT_LIMIT_EXCEEDED';
  return verdict('FAIL', blocked.length ? 'BLOCKED' : 'OVER_LIMIT', reason, ids, usable);
}
