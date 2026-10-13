import { Decimal } from 'decimal.js';
import type { TokenRef } from '../domain/contracts.js';
import { deriveCharts } from '../domain/baseline.js';
import type { ResearchPacket } from '../domain/research.js';
import { readLimitedText } from './http.js';

type Candle = NonNullable<ResearchPacket['candles']>['bars'][number];
type Instrument = 'BTC' | 'ETH' | 'SOL';
type Chain = 'solana' | 'bsc' | 'base';
export type MarketHistory = {
  token: TokenRef; pool: string | null; cutoff: string;
  candles: NonNullable<ResearchPacket['candles']> | null;
  chart: ReturnType<typeof deriveCharts> | null;
  macro: Array<{ instrument: Instrument; bars: Candle[]; chart: ReturnType<typeof deriveCharts> }>;
  chainVolumes: Array<{ chain: Chain; usd: string; previousUsd: string; complete: true }>;
  contextWindow: { start: string; end: string; availableAt: string } | null;
  missingCauses: Record<string, string>; limitations: string[];
};
export type MarketRequests = Record<string, { url: string }>;
const instruments: Instrument[] = ['BTC', 'ETH', 'SOL'];
const chains: Array<{ id: Chain; vendor: string }> = [{ id: 'solana', vendor: 'Solana' }, { id: 'bsc', vendor: 'BSC' }, { id: 'base', vendor: 'Base' }];
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const fail = (code: string): never => { throw new Error(code); };
const scope = (token: TokenRef, pool: string | null) => {
  if (token.chain !== 'solana' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.address) || pool !== null && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)) fail('MARKET_SCOPE_INVALID');
};
function endpoints(token: TokenRef, pool: string | null): MarketRequests {
  scope(token, pool);
  return {
    ...(pool ? {
      'market-pool': { url: `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}?include=base_token,quote_token` },
      'market-candles': { url: `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=100&currency=usd&token=${token.address}&include_empty_intervals=false` },
    } : {}),
    ...Object.fromEntries(instruments.map(instrument => [`macro-${instrument}`, { url: `https://api.exchange.coinbase.com/products/${instrument}-USD/candles?granularity=3600` }])),
    ...Object.fromEntries(chains.map(chain => [`dex-${chain.id}`, { url: `https://api.llama.fi/overview/dexs/${chain.vendor}?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true` }])),
  };
}
function number(value: unknown, positive = false): string {
  if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return fail('MARKET_NUMBER_INVALID');
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lt(0) || positive && parsed.lte(0)) return fail('MARKET_NUMBER_INVALID');
  return parsed.toFixed();
}
function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000) return fail('MARKET_TIME_INVALID');
  return value;
}
function candles(rows: unknown, kind: 'GECKO' | 'COINBASE', retrievedAt: string): Candle[] {
  if (!Array.isArray(rows) || rows.length > 1000) return fail('MARKET_CANDLES_INVALID');
  const seen = new Set<number>(), cutoff = Date.parse(retrievedAt);
  const parsed: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 6) return fail('MARKET_CANDLES_INVALID');
    const at = seconds(row[0]);
    if (at % 3600 !== 0 || seen.has(at)) return fail('MARKET_CANDLES_DUPLICATE_OR_TIME');
    seen.add(at);
    // A live provider commonly includes its current unfinished candle. It is
    // retained in the receipt but never used as historical observation.
    if (at * 1000 > cutoff) return fail('MARKET_CANDLES_FUTURE');
    const open = number(row[kind === 'GECKO' ? 1 : 3], true), high = number(row[2], true),
      low = number(row[kind === 'GECKO' ? 3 : 1], true), close = number(row[4], true), volume = number(row[5]);
    if (new Decimal(high).lt(Decimal.max(open, close, low)) || new Decimal(low).gt(Decimal.min(open, close, high))) return fail('MARKET_CANDLES_OHLC');
    if ((at + 3600) * 1000 > cutoff) continue;
    parsed.push({ start: iso(at * 1000), end: iso((at + 3600) * 1000), availableAt: retrievedAt,
      open, high, low, close, volumeQuote: kind === 'GECKO' ? volume : null });
  }
  const sorted = parsed.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(-72);
  if (sorted.length < 2) return fail('MARKET_HISTORY_TOO_SHORT');
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start !== sorted[i - 1]!.end) return fail('MARKET_CANDLES_GAP');
  // A stale sequence cannot silently become the requested latest-hour window.
  if (Date.parse(sorted.at(-1)!.end) !== Math.floor(cutoff / 3_600_000) * 3_600_000) return fail('MARKET_CANDLES_STALE');
  return sorted;
}
function chartSeries(market: string, bars: Candle[]): NonNullable<ResearchPacket['candles']> {
  return { market, quote: 'USD', intervalSeconds: 3600, leftBars: 2, rightBars: 2, comparisonToleranceBps: '10', bars };
}
function boundPool(input: unknown, token: TokenRef, pool: string): void {
  const value = input as any;
  if (!value || value.data?.type !== 'pool' || value.data?.id !== `solana_${pool}` || value.data?.attributes?.address !== pool || !Array.isArray(value.included)) fail('MARKET_POOL_BINDING');
  const ids = ['base_token', 'quote_token'].map(side => value.data.relationships?.[side]?.data?.id);
  if (['base_token', 'quote_token'].some(side => value.data.relationships?.[side]?.data?.type !== 'token')) fail('MARKET_POOL_BINDING');
  if (ids.some(id => typeof id !== 'string') || ids[0] === ids[1]) fail('MARKET_POOL_BINDING');
  const matching = ids.filter(id => id === `solana_${token.address}`);
  if (matching.length !== 1) fail('MARKET_POOL_BINDING');
  for (const id of ids) {
    const entries = value.included.filter((entry: any) => entry?.id === id && entry.type === 'token');
    if (entries.length !== 1 || entries[0]?.attributes?.address !== id.slice(7)) fail('MARKET_POOL_BINDING');
  }
}
const safeCodes = new Set(['MARKET_HTTP_UNAVAILABLE', 'MARKET_TIMEOUT', 'MARKET_TRANSPORT', 'MARKET_RESPONSE_LIMIT', 'MARKET_RESPONSE_EMPTY']);
/** Offline receipt reconstruction. Only fixed endpoint identities can supply data. */
export function decodeAdvisoryMarket(token: TokenRef, pool: string | null, rawArtifacts: Record<string, string>, retrievedAt: string, requests: MarketRequests): MarketHistory {
  scope(token, pool);
  if (!Number.isFinite(Date.parse(retrievedAt)) || !/^\d{4}-\d\d-\d\dT/.test(retrievedAt)) fail('MARKET_TIME_INVALID');
  const expected = endpoints(token, pool), missingCauses: Record<string, string> = {};
  if (Object.keys(rawArtifacts).some(id => !expected[id]) || Object.keys(requests).some(id => !expected[id])) fail('MARKET_REQUEST_SCOPE');
  const read = (id: string): unknown => {
    if (!requests[id] || requests[id]!.url !== expected[id]?.url) return fail('MARKET_REQUEST_SCOPE');
    if (!Object.hasOwn(rawArtifacts, id)) return fail('MARKET_RECEIPT_MISSING');
    let envelope: any;
    try { envelope = JSON.parse(rawArtifacts[id]!); } catch { return fail('MARKET_RECEIPT_INVALID'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail('MARKET_RECEIPT_INVALID');
    if ('code' in envelope) {
      if (Object.keys(envelope).length !== 1 || !safeCodes.has(envelope.code)) return fail('MARKET_RECEIPT_INVALID');
      return fail(envelope.code);
    }
    if (Object.keys(envelope).sort().join(',') !== 'body,httpStatus' || !Number.isInteger(envelope.httpStatus) || envelope.httpStatus < 100 || envelope.httpStatus > 599 || typeof envelope.body !== 'string') return fail('MARKET_RECEIPT_INVALID');
    if (envelope.httpStatus !== 200) return fail('MARKET_HTTP_UNAVAILABLE');
    try { return JSON.parse(envelope.body); } catch { return fail('MARKET_RESPONSE_INVALID'); }
  };
  const attempt = <T>(id: string, operation: () => T): T | null => {
    try { return operation(); } catch (error) {
      const code = error instanceof Error && /^MARKET_[A-Z_]+$/.test(error.message) ? error.message : 'MARKET_RESPONSE_INVALID';
      missingCauses[id] = code; return null;
    }
  };
  let marketCandles: MarketHistory['candles'] = null;
  if (pool) {
    const bound = attempt('market-pool', () => { boundPool(read('market-pool'), token, pool); return true; });
    if (bound) marketCandles = attempt('market-candles', () => {
      const value = read('market-candles') as any;
      return chartSeries(pool, candles(value?.data?.attributes?.ohlcv_list, 'GECKO', retrievedAt));
    });
    else missingCauses['market-candles'] = 'MARKET_POOL_BINDING_UNAVAILABLE';
  } else missingCauses['market-candles'] = 'MARKET_POOL_UNAVAILABLE';
  const macro = instruments.flatMap(instrument => {
    const result = attempt(`macro-${instrument}`, () => { const bars = candles(read(`macro-${instrument}`), 'COINBASE', retrievedAt); return { instrument, bars, chart: deriveCharts(chartSeries(instrument, bars), retrievedAt) }; });
    return result ? [result] : [];
  });
  const end = Math.floor(Date.parse(retrievedAt) / 86_400_000) * 86_400_000, start = end - 86_400_000;
  const chainVolumes = chains.flatMap(chain => {
    const result = attempt(`dex-${chain.id}`, () => {
      const response = read(`dex-${chain.id}`) as any;
      if (!Array.isArray(response?.totalDataChart) || response.totalDataChart.length > 20_000 || response.chain !== chain.vendor) return fail('MARKET_CHAIN_BINDING');
      const values = new Map<number, string>();
      for (const row of response.totalDataChart) {
        if (!Array.isArray(row) || row.length !== 2) return fail('MARKET_CHAIN_SHAPE');
        const at = seconds(row[0]);
        if (at % 86400 !== 0 || values.has(at)) return fail('MARKET_CHAIN_DUPLICATE_OR_TIME');
        if (at * 1000 > Date.parse(retrievedAt)) return fail('MARKET_CHAIN_FUTURE');
        values.set(at, number(row[1]));
      }
      const usd = values.get(start / 1000), previousUsd = values.get((start - 86_400_000) / 1000);
      if (usd === undefined || previousUsd === undefined) return fail('MARKET_CHAIN_WINDOW_MISSING');
      return { chain: chain.id, usd, previousUsd, complete: true as const };
    });
    return result ? [result] : [];
  });
  missingCauses.C12 = 'BRIDGE_TRANSACTION_COLLECTION_UNAVAILABLE';
  missingCauses.C16 = 'LAUNCH_AND_MIGRATION_COUNTS_UNAVAILABLE';
  return { token, pool, cutoff: retrievedAt, candles: marketCandles, chart: marketCandles ? deriveCharts(marketCandles, retrievedAt) : null,
    macro, chainVolumes, contextWindow: chainVolumes.length ? { start: iso(start), end: iso(end), availableAt: retrievedAt } : null, missingCauses,
    limitations: ['Historical records retrieved now were not necessarily available at their event time.', 'Coinbase base-asset volume is not USD trade notional; trade VWAP is not inferred.', 'Chain DEX volumes cover reported protocols, not all activity or net capital flow.', 'No bridge completeness or launch-count evidence is supplied by fee series.'] };
}

/** Eight fixed public reads at most, four concurrently; no keys, paid endpoints or redirects. */
export async function collectAdvisoryMarket(token: TokenRef, pool: string | null, fetcher: typeof fetch, now: () => string, signal?: AbortSignal): Promise<{ rawArtifacts: Record<string, string>; retrievedAt: string; requests: MarketRequests; data: MarketHistory }> {
  const requests = endpoints(token, pool), rawArtifacts: Record<string, string> = {}, entries = Object.entries(requests);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const [id, request] = entries[next++]!;
      try {
        const timeout = AbortSignal.timeout(8000);
        const response = await fetcher(request.url, { headers: { accept: 'application/json' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        const body = await readLimitedText(response, 1_000_000);
        rawArtifacts[id] = JSON.stringify({ httpStatus: response.status, body });
      } catch (error) {
        const code = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'MARKET_TIMEOUT' : error instanceof Error && error.message === 'PROVIDER_RESPONSE_LIMIT' ? 'MARKET_RESPONSE_LIMIT' : error instanceof Error && error.message === 'PROVIDER_EMPTY_RESPONSE' ? 'MARKET_RESPONSE_EMPTY' : 'MARKET_TRANSPORT';
        rawArtifacts[id] = JSON.stringify({ code });
      }
    }
  }));
  const retrievedAt = now();
  return { rawArtifacts, retrievedAt, requests, data: decodeAdvisoryMarket(token, pool, rawArtifacts, retrievedAt, requests) };
}
