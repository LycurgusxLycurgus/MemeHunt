import { Decimal } from 'decimal.js';
import type { FeatureResult, PositionEvent, PositionRecord, ThesisEpisode } from './contracts.js';
import { evaluatePredicate } from './policy.js';

export type LedgerState = { initialQuantityAtomic: string; remainingQuantityAtomic: string; knownCost: string | null; netCashFlow: string | null; soldByLeg: Record<string, string>; unreconciledSale: boolean; revision: string };
const qty = (v: string) => { if (!/^(0|[1-9]\d*)$/.test(v)) throw new Error('INVALID_ATOMIC_QUANTITY'); return BigInt(v); };
const money = (v: string) => { if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(v)) throw new Error('INVALID_QUOTE_AMOUNT'); const d = new Decimal(v); if (!d.isFinite()) throw new Error('INVALID_QUOTE_AMOUNT'); return d; };

export function reduceLedger(position: PositionRecord, events: PositionEvent[], cutoff?: string): LedgerState {
  if (position.decimals < 0 || position.decimals > 36 || !Number.isInteger(position.decimals)) throw new Error('INVALID_DECIMALS');
  const cutoffMs = cutoff === undefined ? Infinity : Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) throw new Error('INVALID_CUTOFF');
  const initial = qty(position.initialQuantityAtomic);
  let remaining = initial;
  let cost: Decimal | null = position.initialCost === null ? null : money(position.initialCost);
  let cash: Decimal | null = cost === null ? null : cost.negated();
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
  return { initialQuantityAtomic: initial.toString(), remainingQuantityAtomic: remaining.toString(), knownCost: cost?.toString() ?? null, netCashFlow: cash?.toString() ?? null, soldByLeg, unreconciledSale, revision: JSON.stringify(effective.map(e => [e.id,e.recordedAt,e.effectiveAt])) };
}

export function proposeLeg(episode: ThesisEpisode, state: LedgerState, features: FeatureResult[], cutoff: string): { legId: string; quantityAtomic: string } | null {
  if (state.unreconciledSale) return null;
  const q0 = BigInt(state.initialQuantityAtomic), remaining = BigInt(state.remainingQuantityAtomic);
  for (const leg of episode.thesis.legs) {
    const alreadySold = BigInt(state.soldByLeg[leg.id] ?? '0');
    const target = leg.allRemaining ? remaining : q0 * BigInt(leg.quantityBps ?? 0) / 10000n;
    if (!leg.allRemaining && alreadySold >= target) continue;
    const due = evaluatePredicate(leg.trigger, features, cutoff);
    if (due !== 'TRUE') return null;
    const unfilled = leg.allRemaining ? remaining : target - alreadySold;
    if (unfilled <= 0n) continue;
    if (unfilled > remaining) return null;
    return { legId: leg.id, quantityAtomic: unfilled.toString() };
  }
  return null;
}
