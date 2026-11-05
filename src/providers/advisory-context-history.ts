import { Decimal } from 'decimal.js';
import type { TokenRef } from '../domain/contracts.js';
import { readLimitedText } from './http.js';

export type ContextHistoryRequests = Record<string, { url: string }>;
export type BridgeSampleTransfer = {
  id: string; fromChain: number; toChain: number; tokenChain: number; tokenAddress: string;
  sourceAt: string; completedAt: string; sourceTx: string; targetTx: string;
  amount: string | null; providerUsd: string | null;
  direction: 'INFLOW' | 'OUTFLOW'; sourceStatus: 'confirmed'; targetStatus: 'completed';
  finalityVerified: false; valuationVerified: false;
};
export type ContextHistory = {
  token: TokenRef; method: 'wormhole-bounded-operations-v1'; cutoff: string;
  bridge: { provider: 'WORMHOLESCAN'; chain: 'solana'; complete: false; pageLimit: 2; pageSize: 100;
    recordsReceived: number; duplicateRecords: number; transfers: BridgeSampleTransfer[];
    excluded: Record<string, number>; observedSourceInterval: { start: string; end: string } | null;
    providerReportedUsd: { inflow: string; outflow: string }; finalityVerified: false; valuationVerified: false };
  missingCauses: Record<string, string>; limitations: string[];
};
const fail = (code: string): never => { throw new Error(code); };
function endpoints(token: TokenRef): ContextHistoryRequests {
  if (token.chain !== 'solana' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.address)) fail('CONTEXT_SCOPE_INVALID');
  return Object.fromEntries([0, 1].map(page => [`bridge-page-${page}`, { url: `https://api.wormholescan.io/api/v1/operations?page=${page}&pageSize=100` }]));
}
const safeErrors = new Set(['CONTEXT_TIMEOUT', 'CONTEXT_TRANSPORT', 'CONTEXT_RESPONSE_LIMIT', 'CONTEXT_RESPONSE_EMPTY']);
const time = (value: unknown, cutoff: number): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) > cutoff) fail('CONTEXT_RECORD_TIME');
  return new Date(Date.parse(value as string)).toISOString();
};
const chain = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 65535) fail('CONTEXT_CHAIN_INVALID');
  return value as number;
};
const positiveDecimal = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const amount = new Decimal(value); return amount.isFinite() && amount.gt(0) ? amount.toFixed() : null;
};

/** The API pages are a recent sample, never a complete interval or all-bridge census. */
export function decodeAdvisoryContextHistory(token: TokenRef, rawArtifacts: Record<string, string>, retrievedAt: string,
  requests: ContextHistoryRequests): ContextHistory {
  const expected = endpoints(token), cutoff = Date.parse(retrievedAt);
  if (!Number.isFinite(cutoff)) fail('CONTEXT_TIME_INVALID');
  if (Object.keys(expected).sort().join() !== Object.keys(rawArtifacts).sort().join() || Object.keys(expected).sort().join() !== Object.keys(requests).sort().join()) fail('CONTEXT_REQUEST_SCOPE');
  const excluded: Record<string, number> = {}, missingCauses: Record<string, string> = {
    C12: 'BRIDGE_SAMPLE_INCOMPLETE_FINALITY_AND_VALUATION_UNVERIFIED',
    C16: 'LAUNCH_MIGRATION_HISTORY_AND_MATURED_COHORT_UNAVAILABLE',
  };
  const exclude = (code: string) => { excluded[code] = (excluded[code] ?? 0) + 1; };
  const seen = new Map<string, string>(), conflicts = new Set<string>();
  const candidates = new Map<string, BridgeSampleTransfer>(), sourceTimes: string[] = [];
  let recordsReceived = 0, duplicateRecords = 0;
  for (const id of Object.keys(expected)) {
    if (requests[id]?.url !== expected[id]!.url) fail('CONTEXT_REQUEST_SCOPE');
    let rows: any[];
    try {
      const receipt = JSON.parse(rawArtifacts[id]!);
      if (receipt && Object.keys(receipt).join() === 'code' && safeErrors.has(receipt.code)) fail(receipt.code);
      if (!receipt || Object.keys(receipt).sort().join() !== 'body,httpStatus' || !Number.isInteger(receipt.httpStatus) || receipt.httpStatus < 100 || receipt.httpStatus > 599 || typeof receipt.body !== 'string') fail('CONTEXT_RECEIPT_INVALID');
      if (receipt.httpStatus !== 200) fail('CONTEXT_HTTP_UNAVAILABLE');
      const response = JSON.parse(receipt.body);
      if (!response || !Array.isArray(response.operations) || response.operations.length > 100) fail('CONTEXT_RESPONSE_INVALID');
      rows = response.operations;
    } catch (error) {
      const code = error instanceof Error && /^CONTEXT_[A-Z_]+$/.test(error.message) ? error.message : 'CONTEXT_RECEIPT_INVALID';
      missingCauses[id] = code; continue;
    }
    recordsReceived += rows.length;
    for (const row of rows) {
      try {
        const emitterChain = chain(row.emitterChain), emitter = row.emitterAddress?.hex;
        if (typeof emitter !== 'string' || !/^[0-9a-f]{64}$/.test(emitter) || typeof row.sequence !== 'string' || !/^(?:0|[1-9]\d*)$/.test(row.sequence) || BigInt(row.sequence) > 18446744073709551615n) fail('CONTEXT_CANONICAL_ID');
        const canonical = `${emitterChain}/${emitter}/${row.sequence}`;
        if (row.id !== canonical) fail('CONTEXT_CANONICAL_ID');
        const serialized = JSON.stringify(row);
        if (seen.has(canonical)) {
          duplicateRecords++;
          if (seen.get(canonical) !== serialized) { conflicts.add(canonical); candidates.delete(canonical); exclude('CONTEXT_DUPLICATE_CONFLICT'); }
          continue;
        }
        seen.set(canonical, serialized);
        const from = row.sourceChain, to = row.targetChain, properties = row.content?.standarizedProperties;
        const sourceAt = time(from?.timestamp, cutoff); sourceTimes.push(sourceAt);
        if (!properties || !properties.tokenAddress || !properties.fromChain || !properties.toChain) { exclude('NON_TRANSFER_MESSAGE'); continue; }
        const fromChain = chain(properties.fromChain), toChain = chain(properties.toChain), tokenChain = chain(properties.tokenChain);
        if (fromChain !== from.chainId || fromChain !== emitterChain || fromChain === toChain) fail('CONTEXT_TRANSFER_BINDING');
        if (fromChain !== 1 && toChain !== 1) { exclude('OTHER_CHAIN'); continue; }
        if (from.status !== 'confirmed' || !to || to.status !== 'completed') { exclude('NOT_PROVIDER_COMPLETED'); continue; }
        if (to.chainId !== toChain) fail('CONTEXT_TRANSFER_BINDING');
        const completedAt = time(to.timestamp, cutoff);
        if (Date.parse(completedAt) < Date.parse(sourceAt)) fail('CONTEXT_RECORD_TIME');
        if (typeof from.transaction?.txHash !== 'string' || !from.transaction.txHash || typeof to.transaction?.txHash !== 'string' || !to.transaction.txHash || typeof properties.tokenAddress !== 'string' || properties.tokenAddress.length > 200) fail('CONTEXT_TRANSFER_BINDING');
        let amount: string | null = null;
        if (typeof properties.amount === 'string' && /^(?:0|[1-9]\d*)$/.test(properties.amount) && Number.isSafeInteger(properties.normalizedDecimals) && properties.normalizedDecimals >= 0 && properties.normalizedDecimals <= 18) {
          amount = new Decimal(properties.amount).div(new Decimal(10).pow(properties.normalizedDecimals)).toFixed();
          if (new Decimal(amount).lte(0)) amount = null;
        }
        const providerAmount = positiveDecimal(row.data?.tokenAmount);
        const providerUsd = amount && providerAmount && new Decimal(amount).eq(providerAmount) ? positiveDecimal(row.data?.usdAmount) : null;
        candidates.set(canonical, { id: canonical, fromChain, toChain, tokenChain, tokenAddress: properties.tokenAddress,
          sourceAt, completedAt, sourceTx: from.transaction.txHash, targetTx: to.transaction.txHash,
          amount, providerUsd, direction: toChain === 1 ? 'INFLOW' : 'OUTFLOW',
          sourceStatus: 'confirmed', targetStatus: 'completed', finalityVerified: false, valuationVerified: false });
      } catch (error) { exclude(error instanceof Error && /^CONTEXT_[A-Z_]+$/.test(error.message) ? error.message : 'CONTEXT_RECORD_INVALID'); }
    }
  }
  const transfers = [...candidates.values()].filter(record => !conflicts.has(record.id)).sort((a, b) => a.id.localeCompare(b.id));
  const sum = (direction: BridgeSampleTransfer['direction']) => transfers.filter(record => record.direction === direction && record.providerUsd).reduce((total, record) => total.plus(record.providerUsd!), new Decimal(0)).toFixed();
  sourceTimes.sort();
  return { token, method: 'wormhole-bounded-operations-v1', cutoff: retrievedAt,
    bridge: { provider: 'WORMHOLESCAN', chain: 'solana', complete: false, pageLimit: 2, pageSize: 100,
      recordsReceived, duplicateRecords, transfers, excluded,
      observedSourceInterval: sourceTimes.length ? { start: sourceTimes[0]!, end: sourceTimes.at(-1)! } : null,
      providerReportedUsd: { inflow: sum('INFLOW'), outflow: sum('OUTFLOW') }, finalityVerified: false, valuationVerified: false }, missingCauses,
    limitations: ['Only two latest Wormholescan pages; mutable offset pagination cannot prove interval completeness.',
      'Canonical emitter/sequence identity deduplicates observed messages; unrelated chains and uncompleted records are excluded.',
      'Source confirmed and target completed are provider statuses, not independently verified chain finality.',
      'USD values are provider reported; unvalued or amount-inconsistent records do not enter sample subtotals. Subtotals do not establish chain netflow.',
      'PumpPortal documents prospective launch/migration streams, not complete retrospective cohorts; launch counts and survival are unavailable.'] };
}

export async function collectAdvisoryContextHistory(token: TokenRef, fetcher: typeof fetch = fetch,
  now: () => string = () => new Date().toISOString(), signal?: AbortSignal) {
  const requests = endpoints(token), rawArtifacts: Record<string, string> = {};
  await Promise.all(Object.entries(requests).map(async ([id, request]) => {
    try {
      const timeout = AbortSignal.timeout(8000), effective = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetcher(request.url, { signal: effective, redirect: 'error', headers: { accept: 'application/json' } });
      rawArtifacts[id] = JSON.stringify({ httpStatus: response.status, body: await readLimitedText(response, 2_000_000) });
    } catch (error) {
      signal?.throwIfAborted();
      const code = error instanceof Error && error.message === 'PROVIDER_RESPONSE_LIMIT' ? 'CONTEXT_RESPONSE_LIMIT'
        : error instanceof Error && error.message === 'PROVIDER_EMPTY_RESPONSE' ? 'CONTEXT_RESPONSE_EMPTY'
        : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'CONTEXT_TIMEOUT' : 'CONTEXT_TRANSPORT';
      rawArtifacts[id] = JSON.stringify({ code });
    }
  }));
  const retrievedAt = now();
  return { rawArtifacts, retrievedAt, requests, data: decodeAdvisoryContextHistory(token, rawArtifacts, retrievedAt, requests) };
}
