import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { ExecutionBasisRef, FeatureResult, PlanBasisDeclaration, PositionEvent, PositionRecord, ThesisEpisode, TokenRef } from './contracts.js';
import { evaluatePredicate } from './policy.js';

export type LedgerState = { initialQuantityAtomic: string; remainingQuantityAtomic: string; knownCost: string | null; netCashFlow: string | null; soldByLeg: Record<string, string>; unreconciledSale: boolean; revision: string };
const qty = (v: string) => { if (!/^(0|[1-9]\d*)$/.test(v)) throw new Error('INVALID_ATOMIC_QUANTITY'); return BigInt(v); };
const money = (v: string) => { if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(v)) throw new Error('INVALID_QUOTE_AMOUNT'); const d = new Decimal(v); if (!d.isFinite()) throw new Error('INVALID_QUOTE_AMOUNT'); return d; };

/** Validates the event log and returns the events in effect at the cutoff: corrections overlaid, later records excluded, in effective-time order. */
function asOf(position: PositionRecord, events: PositionEvent[], cutoff?: string) {
  if (position.decimals < 0 || position.decimals > 36 || !Number.isInteger(position.decimals)) throw new Error('INVALID_DECIMALS');
  const cutoffMs = cutoff === undefined ? Infinity : Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) throw new Error('INVALID_CUTOFF');
  const initial = qty(position.initialQuantityAtomic);
  const cost: Decimal | null = position.initialCost === null ? null : money(position.initialCost);
  const cash: Decimal | null = cost === null ? null : cost.negated();
  const ids = new Set<string>(); const keys = new Map<string, string>(); const originals = new Map<string, PositionEvent>(); const replacement = new Map<string, PositionEvent>();
  for (const event of events) {
    if (!event.id || !event.idempotencyKey || ids.has(event.id)) throw new Error('DUPLICATE_EVENT_ID');
    ids.add(event.id);
    const normalized = JSON.stringify(event);
    const old = keys.get(event.idempotencyKey);
    if (old !== undefined) { if (old !== normalized) throw new Error('IDEMPOTENCY_CONFLICT'); else throw new Error('DUPLICATE_EVENT'); }
    keys.set(event.idempotencyKey, normalized);
    qty(event.quantityAtomic); money(event.quoteAmount);
    if (!Number.isFinite(Date.parse(event.effectiveAt)) || !Number.isFinite(Date.parse(event.recordedAt))) throw new Error('INVALID_EVENT_TIME');
    if (event.kind === 'CORRECTION') {
      if (!event.replacesId || !originals.has(event.replacesId) || replacement.has(event.replacesId)) throw new Error('INVALID_CORRECTION_REFERENCE');
      if (Date.parse(event.recordedAt) < Date.parse(originals.get(event.replacesId)!.recordedAt)) throw new Error('CORRECTION_BEFORE_ORIGINAL');
      replacement.set(event.replacesId, event);
    } else originals.set(event.id, event);
  }
  const effective = [...originals.values()].filter(e => Date.parse(e.recordedAt) <= cutoffMs).map(e => {
    const correction = replacement.get(e.id);
    return correction && Date.parse(correction.recordedAt) <= cutoffMs ? { ...e, ...correction, kind: e.kind, id: e.id } : e;
  }).filter(e => Date.parse(e.effectiveAt) <= cutoffMs).sort((a,b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt) || a.id.localeCompare(b.id));
  return { initial, cost, cash, effective };
}

function account(position: PositionRecord, { initial, cost, cash, effective }: ReturnType<typeof asOf>) {
  let remaining = initial;
  const soldByLeg: Record<string, string> = {};
  let unreconciledSale = false;
  for (const event of effective) {
    if (Date.parse(event.effectiveAt) < Date.parse(position.entryAt)) throw new Error('EVENT_BEFORE_ENTRY');
    const q = qty(event.quantityAtomic), m = money(event.quoteAmount);
    if (event.kind === 'BUY_REPORTED') {
      if (q === 0n) throw new Error('ZERO_BUY');
      remaining += q;
      cost = cost?.plus(m) ?? null; cash = cash?.minus(m) ?? null;
    } else if (event.kind === 'SELL_REPORTED') {
      if (q === 0n || q > remaining) throw new Error('OVERSELL');
      const before = remaining;
      remaining -= q;
      cost = cost === null ? null : cost.mul(new Decimal((before-q).toString())).div(before.toString());
      cash = cash?.plus(m) ?? null;
      if (event.legId) soldByLeg[event.legId] = (BigInt(soldByLeg[event.legId] ?? '0') + q).toString();
      else unreconciledSale = true;
    } else if (event.kind === 'FEE_REPORTED') {
      if (q > remaining) throw new Error('OVERSELL_FEE');
      const before = remaining;
      remaining -= q;
      if (q > 0n && cost !== null) cost = cost.mul(new Decimal(remaining.toString())).div(before.toString());
      if (!event.feeIncluded) cash = cash?.minus(m) ?? null;
    } else if (event.kind === 'TRANSFER_ADJUSTMENT') {
      if (m.gt(0)) throw new Error('TRANSFER_COST_REQUIRES_BUY');
      if (event.direction === 'OUT') { if (q > remaining) throw new Error('OVERSELL_TRANSFER'); const before = remaining; remaining -= q; if (cost !== null) cost = cost.mul(new Decimal(remaining.toString())).div(before.toString()); }
      else if (event.direction === 'IN') { remaining += q; cost = null; cash = null; }
      else throw new Error('TRANSFER_DIRECTION_REQUIRED');
    }
  }
  return { remaining, cost, cash, soldByLeg, unreconciledSale };
}

export function reduceLedger(position: PositionRecord, events: PositionEvent[], cutoff?: string): LedgerState {
  const state = asOf(position, events, cutoff);
  const { remaining, cost, cash, soldByLeg, unreconciledSale } = account(position, state);
  return { initialQuantityAtomic: state.initial.toString(), remainingQuantityAtomic: remaining.toString(), knownCost: cost?.toString() ?? null, netCashFlow: cash?.toString() ?? null, soldByLeg, unreconciledSale, revision: JSON.stringify(state.effective.map(e => [e.id,e.recordedAt,e.effectiveAt])) };
}

/** The base a plan's shares are measured against. ORIGIN is a first thesis: the position's original quantity and every attributed sale. */
export type PlanBasis = { mode: 'ORIGIN' | PlanBasisDeclaration['mode']; anchorAt: string | null };
export const ORIGIN_PLAN: PlanBasis = { mode: 'ORIGIN', anchorAt: null };
/** v7: a first thesis measures from the origin, a successor by its declared basis; a successor saved before declarations existed has none (null). */
export const declaredPlanBasis = (episode: ThesisEpisode): PlanBasis | null =>
  episode.supersedesEpisodeId === undefined ? ORIGIN_PLAN : episode.planBasis ?? null;

/** What a sell plan is measured against: shares of baseQuantityAtomic, current inventory, and the sales attributed to its legs since the anchor. */
export type QuantityBasis = PlanBasis & { baseQuantityAtomic: string; remainingQuantityAtomic: string; soldByLeg: Record<string, string>; unreconciledSale: boolean };
/** The pre-v7 basis: every plan measures from the position's origin, whatever its lineage. */
export const originBasis = (s: LedgerState): QuantityBasis => ({ ...ORIGIN_PLAN, baseQuantityAtomic: s.initialQuantityAtomic, remainingQuantityAtomic: s.remainingQuantityAtomic, soldByLeg: s.soldByLeg, unreconciledSale: s.unreconciledSale });

/**
 * Anchored at T, the base is the inventory from events effective at or before T, and only sales effective after T count toward the plan's legs;
 * an unattributed sale after T leaves the plan unreconciled. Without an anchor this equals originBasis.
 */
export function quantityBasis(position: PositionRecord, events: PositionEvent[], cutoff: string, plan: PlanBasis): QuantityBasis {
  const state = asOf(position, events, cutoff), all = account(position, state);
  if (plan.anchorAt === null) return { ...plan, baseQuantityAtomic: state.initial.toString(), remainingQuantityAtomic: all.remaining.toString(), soldByLeg: all.soldByLeg, unreconciledSale: all.unreconciledSale };
  const anchor = Date.parse(plan.anchorAt);
  const base = account(position, { ...state, effective: state.effective.filter(e => Date.parse(e.effectiveAt) <= anchor) }).remaining;
  const soldByLeg: Record<string, string> = {};
  let unreconciledSale = false;
  for (const e of state.effective) if (e.kind === 'SELL_REPORTED' && Date.parse(e.effectiveAt) > anchor) {
    if (e.legId) soldByLeg[e.legId] = (BigInt(soldByLeg[e.legId] ?? '0') + BigInt(e.quantityAtomic)).toString();
    else unreconciledSale = true;
  }
  return { ...plan, baseQuantityAtomic: base.toString(), remainingQuantityAtomic: all.remaining.toString(), soldByLeg, unreconciledSale };
}

export const EXECUTION_BASIS_VERSION = 'execution-basis-v1';
const instant = (v: string) => new Date(Date.parse(v)).toISOString();
const amount = (v: string | null) => v === null ? null : new Decimal(v).toFixed();
const byKey = (r: Record<string, string>) => Object.keys(r).sort().map(k => [k, r[k]]);
/**
 * Content identity of everything an exact exit quote must match: token, case, position terms, episode and plan quantities, the plan basis,
 * the effective as-of events and the resulting inventory and attribution. Canonical form is one JSON array in this fixed order, with instants
 * as UTC ISO, decimals without exponent or trailing zeros, events in ledger order (effective instant, then ID) and attribution sorted by leg ID.
 * The cutoff itself is excluded, so an unchanged as-of state keeps its fingerprint; records learned after the cutoff never enter it.
 */
export function executionBasis(token: TokenRef | null, episode: ThesisEpisode, position: PositionRecord, events: PositionEvent[], cutoff: string, plan: QuantityBasis | null): ExecutionBasisRef {
  const state = asOf(position, events, cutoff), ledger = reduceLedger(position, events, cutoff);
  const content = [
    EXECUTION_BASIS_VERSION, token && [token.chain, token.address], episode.caseId,
    [position.id, position.caseId, position.mode, BigInt(position.initialQuantityAtomic).toString(), amount(position.initialCost), position.quoteCurrency, position.decimals, instant(position.entryAt), instant(position.recordedAt)],
    [episode.id, episode.thesis.legs.map(l => [l.id, l.quantityBps, l.allRemaining])],
    plan ? [plan.mode, plan.anchorAt && instant(plan.anchorAt), plan.baseQuantityAtomic, byKey(plan.soldByLeg), plan.unreconciledSale] : 'UNRESOLVED',
    state.effective.map(e => [e.id, e.kind, BigInt(e.quantityAtomic).toString(), amount(e.quoteAmount), instant(e.effectiveAt), instant(e.recordedAt), e.legId ?? null, e.feeIncluded ?? null, e.direction ?? null]),
    [ledger.remainingQuantityAtomic, amount(ledger.knownCost), amount(ledger.netCashFlow), byKey(ledger.soldByLeg), ledger.unreconciledSale],
  ];
  return { version: EXECUTION_BASIS_VERSION, fingerprint: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}

/** Where the sell plan stands: the first leg not yet fully sold, in plan order, and whether its trigger is due. Later legs never jump the queue. */
export type LegSelection =
  | { kind: 'NO_PLAN' } | { kind: 'UNRESOLVED_PLAN' } | { kind: 'UNRECONCILED' } | { kind: 'EXHAUSTED' }
  | { kind: 'NOT_DUE' | 'UNKNOWN'; legId: string }
  | { kind: 'DUE'; legId: string; quantityAtomic: string | null };

/**
 * Walks legs in order, skipping legs whose share of the base is fully sold (an all-remaining leg once inventory is zero).
 * Without a basis nothing is sold yet; an unresolved successor basis or an unattributed sale makes the next leg unknowable.
 * A due leg's quantity is null when there is no basis or its unfilled share exceeds remaining inventory.
 */
export function nextLeg(episode: ThesisEpisode, state: QuantityBasis | 'UNRESOLVED' | null, features: FeatureResult[], cutoff: string): LegSelection {
  if (!episode.thesis.legs.length) return { kind: 'NO_PLAN' };
  if (state === 'UNRESOLVED') return { kind: 'UNRESOLVED_PLAN' };
  if (state?.unreconciledSale) return { kind: 'UNRECONCILED' };
  const q0 = state ? BigInt(state.baseQuantityAtomic) : 0n, remaining = state ? BigInt(state.remainingQuantityAtomic) : 0n;
  for (const leg of episode.thesis.legs) {
    const unfilled = !state ? null : leg.allRemaining ? remaining : q0 * BigInt(leg.quantityBps ?? 0) / 10000n - BigInt(state.soldByLeg[leg.id] ?? '0');
    if (unfilled !== null && unfilled <= 0n) continue;
    const due = evaluatePredicate(leg.trigger, features, cutoff);
    if (due !== 'TRUE') return { kind: due === 'FALSE' ? 'NOT_DUE' : 'UNKNOWN', legId: leg.id };
    return { kind: 'DUE', legId: leg.id, quantityAtomic: unfilled !== null && unfilled <= remaining ? unfilled.toString() : null };
  }
  return { kind: 'EXHAUSTED' };
}

export const legCandidate = (s: LegSelection): { legId: string; quantityAtomic: string } | null =>
  s.kind === 'DUE' && s.quantityAtomic !== null ? { legId: s.legId, quantityAtomic: s.quantityAtomic } : null;

/** A not-yet-due leg's unfilled share of the basis, or null when nothing is left to sell or it does not fit the remaining inventory. */
export function upcomingLeg(episode: ThesisEpisode, state: QuantityBasis, legId: string): { legId: string; quantityAtomic: string } | null {
  const leg = episode.thesis.legs.find(l => l.id === legId);
  if (!leg) return null;
  const remaining = BigInt(state.remainingQuantityAtomic);
  const unfilled = leg.allRemaining ? remaining : BigInt(state.baseQuantityAtomic) * BigInt(leg.quantityBps ?? 0) / 10000n - BigInt(state.soldByLeg[leg.id] ?? '0');
  return unfilled > 0n && unfilled <= remaining ? { legId, quantityAtomic: unfilled.toString() } : null;
}

export function proposeLeg(episode: ThesisEpisode, state: LedgerState, features: FeatureResult[], cutoff: string): { legId: string; quantityAtomic: string } | null {
  return legCandidate(nextLeg(episode, originBasis(state), features, cutoff));
}
