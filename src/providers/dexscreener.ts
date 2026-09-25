import { readLimitedText } from './http.js';
const chains: Record<string,string> = { solana: 'solana', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };
export async function probeDexScreener(chain: string, address: string) {
  if (!chains[chain] || !/^[A-Za-z0-9]{20,128}$/.test(address)) throw new Error('INVALID_TOKEN_REF');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${chains[chain]}/${encodeURIComponent(address)}`, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return { chain, address, status: 'UNAVAILABLE', httpStatus: response.status, certified: false };
    const body = await readLimitedText(response,1_000_000);
    const value: unknown = JSON.parse(body); if (!Array.isArray(value)) throw new Error('PROVIDER_SHAPE');
    return { chain, address, status: 'OBSERVED', pairCount: value.length, pairs: value.slice(0,10).map((v: any) => ({ pairAddress: v.pairAddress ?? null, dexId: v.dexId ?? null, priceUsd: v.priceUsd ?? null, liquidityUsd: v.liquidity?.usd ?? null })), source: 'DEX Screener public token-pairs endpoint', certified: false };
  } finally { clearTimeout(timer); }
}
