import type { EvidenceRecord, LiveMarketPair, LiveMarketSummary } from '../domain/contracts.js';
import { fetchReadResponse, readLimitedText } from './http.js';

const chains: Record<string, string> = { solana: 'solana', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringOrNull = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const decimalOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const value = String(v);
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? value : null;
};
const countOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export type DexRead = {
  recovery?: DexRecoveryReceipt;
  retrievedAt?: string;
  status: 'OBSERVED' | 'NO_RESULTS' | 'UNAVAILABLE' | 'INVALID' | 'TRUNCATED';
  code?: string;
  raw?: string;
  market?: LiveMarketSummary;
};

export type DexRecoveryOptions = { tinyfishKey: string; signal?: AbortSignal };
export type DexRecoveryReceipt = {
  method: 'tinyfish-live-dex-json-v1'; requestedUrl: string; requestRaw: string;
  responseRaw?: string; primaryRaw?: string; primaryState: DexRead['status']; primaryCode?: string;
  retrievedAt?: string; primaryRetrievedAt?: string; selected: boolean; code?: string;
};
export const dexPairsUrl = (chain: string, address: string) => `https://api.dexscreener.com/token-pairs/v1/${chains[chain]}/${encodeURIComponent(address)}`;
export const dexFetchBody = (url: string) => ({ urls: [url], format: 'html', ttl: 0, per_url_timeout_ms: 8000, include_etag_and_last_modified: true });
export type DexArtifact = {raw:string;sourceId:string;sourceType:string;accessMode:EvidenceRecord['accessMode'];scope:Record<string,unknown>;retrievedAt:string};
export function dexArtifacts(read:DexRead,id:string,chain:string,address:string,at:string):Record<string,DexArtifact> {
  const out:Record<string,DexArtifact>={},r=read.recovery;
  const scope={chain,mint:address,...(id==='dex-discovery'?{purpose:'DISCOVERY_ONLY'}:{})};
  const add=(key:string,raw:string,sourceId:string,sourceType:string,accessMode:EvidenceRecord['accessMode'],time:string,extra:Record<string,unknown>={})=>{out[key]={raw,sourceId,sourceType,accessMode,retrievedAt:time,scope:{...scope,...extra}};};
  if(r){
    const time=r.retrievedAt??at,parents=[`${id}-fetch-request`,...(r.responseRaw!==undefined?[`${id}-fetch-response`]:[]),...(r.primaryRaw!==undefined?[`${id}-primary`]:[])];
    add(`${id}-fetch-request`,r.requestRaw,'shared-collector','FETCH_REQUEST','LOCAL_DERIVED',time);
    if(r.primaryRaw!==undefined)add(`${id}-primary`,r.primaryRaw,'dexscreener','MARKET_API','PUBLIC_API',r.primaryRetrievedAt??time);
    if(r.responseRaw!==undefined)add(`${id}-fetch-response`,r.responseRaw,'tinyfish-fetch','FETCH_RESPONSE','FREE_ACCOUNT',time);
    const {requestRaw,responseRaw,primaryRaw,...selection}=r;
    add(`${id}-fetch-selection`,JSON.stringify({...selection,parents}),'shared-collector','FETCH_SELECTION','LOCAL_DERIVED',time);
    if(read.raw!==undefined&&r.selected)add(id,read.raw,'tinyfish-fetch','MARKET_API_WITH_FETCH','FREE_ACCOUNT',read.retrievedAt??time,{method:r.method,requestedUrl:r.requestedUrl,parents:[...parents,`${id}-fetch-selection`]});
  }else if(read.raw!==undefined)add(id,read.raw,'dexscreener','MARKET_API','PUBLIC_API',read.retrievedAt??at);
  return out;
}

/** Fetch's HTML format preserves API JSON literally. Never repair or unescape its text. */
export function parseDexFetch(raw: string, url: string, chain: string, address: string): { text: string; market: LiveMarketSummary } {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new Error('DEX_FETCH_JSON'); }
  if (!record(body) || !Array.isArray(body.results) || !Array.isArray(body.errors) || body.results.length !== 1 || body.errors.length) throw new Error('DEX_FETCH_SHAPE');
  const row = body.results[0];
  if (!record(row) || row.url !== url || row.final_url !== url) throw new Error('DEX_FETCH_URL');
  if (row.format !== 'html' || typeof row.text !== 'string') throw new Error('DEX_FETCH_SHAPE');
  let value: unknown;
  try { value = JSON.parse(row.text); } catch { throw new Error('DEX_FETCH_JSON'); }
  if (!Array.isArray(value)) throw new Error('DEX_FETCH_SHAPE');
  const market = parseDexPairs(value, chain, address);
  if (value.length && !market.retainedPairCount) throw new Error('DEX_FETCH_WRONG_TOKEN');
  return { text: row.text, market };
}

export function parseDexPairs(value: unknown, chain: string, address: string): LiveMarketSummary {
  if (!Array.isArray(value)) throw new Error('DEX_SHAPE');
  const pairs: LiveMarketPair[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!record(item) || item.chainId !== chain || typeof item.pairAddress !== 'string') continue;
    const rawBase = record(item.baseToken) ? stringOrNull(item.baseToken.address) : null;
    const rawQuote = record(item.quoteToken) ? stringOrNull(item.quoteToken.address) : null;
    const base=chain==='solana'?rawBase:rawBase?.toLowerCase()??null;
    const quote=chain==='solana'?rawQuote:rawQuote?.toLowerCase()??null;
    if(chain!=='solana')address=address.toLowerCase();
    if (!base || !quote || (base !== address && quote !== address) || seen.has(item.pairAddress)) continue;
    seen.add(item.pairAddress);
    const mintSide = base === address ? 'base' : 'quote';
    const liquidity = record(item.liquidity) ? item.liquidity.usd : null;
    const volume = record(item.volume) ? item.volume.h24 : null;
    const txns = record(item.txns) && record(item.txns.h24) ? item.txns.h24 : null;
    const createdAt = typeof item.pairCreatedAt === 'number' && Number.isFinite(item.pairCreatedAt) && item.pairCreatedAt >= 0 && item.pairCreatedAt <= 8.64e15
      ? new Date(item.pairCreatedAt).toISOString() : null;
    pairs.push({
      pairAddress: item.pairAddress,
      dexId: stringOrNull(item.dexId),
      url: stringOrNull(item.url),
      mintSide,
      baseAddress: base,
      quoteAddress: quote,
      priceUsd: mintSide === 'base' ? decimalOrNull(item.priceUsd) : null,
      liquidityUsd: decimalOrNull(liquidity),
      volume24hUsd: decimalOrNull(volume),
      buys24h: txns ? countOrNull(txns.buys) : null,
      sells24h: txns ? countOrNull(txns.sells) : null,
      pairCreatedAt: createdAt,
    });
  }
  pairs.sort((a,b) => Number(b.liquidityUsd ?? -1) - Number(a.liquidityUsd ?? -1) || a.pairAddress.localeCompare(b.pairAddress));
  return { reportedPairCount: value.length, retainedPairCount: Math.min(pairs.length, 20), truncated: pairs.length > 20, pairs: pairs.slice(0,20) };
}

async function directDexPairs(chain: string, address: string, fetcher: typeof fetch, now?:()=>string): Promise<DexRead> {
  if (!chains[chain] || !/^[A-Za-z0-9]{20,128}$/.test(address)) throw new Error('INVALID_TOKEN_REF');
  try {
    const response = await fetchReadResponse(`https://api.dexscreener.com/token-pairs/v1/${chains[chain]}/${encodeURIComponent(address)}`, {
      headers: { accept: 'application/json' },
    },fetcher,7000);
    if (!response.ok) return { status: 'UNAVAILABLE', code: `DEX_HTTP_${response.status}` };
    const raw = await readLimitedText(response, 400_000);
    const receipt=now?{retrievedAt:now()}:{};
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { status: 'INVALID', code: 'DEX_JSON', raw,...receipt }; }
    try {
      const market = parseDexPairs(value, chain, address);
      return { status: market.retainedPairCount === 0 ? 'NO_RESULTS' : market.truncated ? 'TRUNCATED' : 'OBSERVED', raw, market,...receipt };
    } catch { return { status: 'INVALID', code: 'DEX_SHAPE', raw,...receipt }; }
  } catch (error) {
    return { status: 'UNAVAILABLE', code: error instanceof Error && error.message === 'PROVIDER_RESPONSE_LIMIT' ? 'DEX_RESPONSE_LIMIT' : 'DEX_TRANSPORT' };
  }
}

export async function fetchDexPairs(chain: string, address: string, fetcher: typeof fetch = fetch, now?:()=>string, recovery?:DexRecoveryOptions): Promise<DexRead> {
  const primary = await directDexPairs(chain, address, fetcher, now);
  if (!recovery?.tinyfishKey || primary.market?.retainedPairCount) return primary;
  const requestedUrl = dexPairsUrl(chain,address), requestRaw = JSON.stringify(dexFetchBody(requestedUrl));
  const receipt: DexRecoveryReceipt = { method:'tinyfish-live-dex-json-v1', requestedUrl, requestRaw, primaryState:primary.status, selected:false,
    ...(primary.raw !== undefined ? {primaryRaw:primary.raw} : {}), ...(primary.code ? {primaryCode:primary.code} : {}),...(primary.retrievedAt?{primaryRetrievedAt:primary.retrievedAt}:{}) };
  try {
    const timeout=AbortSignal.timeout(15_000);
    const response=await fetcher('https://api.fetch.tinyfish.ai/',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':recovery.tinyfishKey},body:requestRaw,signal:recovery.signal?AbortSignal.any([timeout,recovery.signal]):timeout});
    if (!response.ok) throw new Error(`DEX_FETCH_HTTP_${response.status}`);
    receipt.responseRaw=await readLimitedText(response,400_000);
    receipt.retrievedAt=(now??(()=>new Date().toISOString()))();
    const selected=parseDexFetch(receipt.responseRaw,requestedUrl,chain,address);
    receipt.selected=true;
    return {status:selected.market.retainedPairCount?selected.market.truncated?'TRUNCATED':'OBSERVED':'NO_RESULTS',raw:selected.text,market:selected.market,retrievedAt:receipt.retrievedAt,recovery:receipt};
  } catch(error) {
    receipt.code=error instanceof Error && /^DEX_FETCH_/.test(error.message)?error.message:error instanceof Error&&error.message==='PROVIDER_RESPONSE_LIMIT'?'DEX_FETCH_RESPONSE_LIMIT':error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'DEX_FETCH_TIMEOUT':'DEX_FETCH_TRANSPORT';
    return {...primary,status:receipt.code==='DEX_FETCH_TIMEOUT'||receipt.code==='DEX_FETCH_TRANSPORT'||receipt.code.startsWith('DEX_FETCH_HTTP_')?'UNAVAILABLE':'INVALID',code:receipt.code,recovery:receipt};
  }
}

export async function probeDexScreener(chain: string, address: string) {
  const result = await fetchDexPairs(chain, address);
  return {
    chain, address, status: result.status, pairCount: result.market?.reportedPairCount ?? 0,
    pairs: result.market?.pairs.slice(0,10).map(p => ({ pairAddress: p.pairAddress, dexId: p.dexId, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd })) ?? [],
    source: 'DEX Screener public token-pairs endpoint', certified: false,
    ...(result.code ? { code: result.code } : {}),
  };
}
