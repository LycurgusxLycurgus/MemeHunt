import type { TokenRef } from '../domain/contracts.js';
import { decodeSolanaAddress, safeRpcCode, solanaRpc, SOLANA_MAINNET_GENESIS } from './solana.js';

type Request = { method: string; params: unknown[] };
type Status = 'OBSERVED' | 'UNAVAILABLE' | 'INVALID' | 'TRUNCATED';
export type ChainMovement = { signature: string; slot: number; at: string; account: string; owner: string; mint: string; decimals: number; preAtomic: string; postAtomic: string; deltaAtomic: string };
export type ChainHistory = {
  token: TokenRef; method: 'solana-bounded-movements-v1'; genesisVerified: boolean; addresses: string[];
  sourceUniverseComplete: false; pageLimit: 32; transactionLimit: 16;
  pages: Array<{ address: string; status: Status; returned: number; retained: number; oldestAt: string | null; newestAt: string | null; exhausted: boolean; code?: string }>;
  transactions: Array<{ signature: string; slot: number; at: string | null; status: Status; code?: string; movements: ChainMovement[] }>;
  movements: ChainMovement[]; coveredInterval: { start: string; end: string } | null;
  complete: boolean; tradeCoverageComplete: false; limitations: string[];
};
const object = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
const address = (x: unknown): x is string => { try { if (typeof x !== 'string') return false; decodeSolanaAddress(x); return true; } catch { return false; } };
const signature = (x: unknown): x is string => {
  if (typeof x !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(x)) return false;
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of x)n=n*58n+BigInt(alphabet.indexOf(c));
  const body=n===0n?0:Math.ceil(n.toString(16).length/2);return body+(x.match(/^1*/)?.[0].length??0)===64;
};
const atomic = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9]\d{0,19})$/.test(x) && BigInt(x) <= 18446744073709551615n;
function shape(): never { throw new Error('ADVISORY_CHAIN_SHAPE'); }
function inputs(token: TokenRef, addresses: string[]) {
  if (token.chain !== 'solana' || !address(token.address) || addresses.length > 3 || !addresses.length || new Set(addresses).size !== addresses.length || !addresses.every(address)) throw new Error('ADVISORY_CHAIN_SCOPE');
}
const genesisRequest: Request = { method: 'getGenesisHash', params: [] };
const pageRequest = (key: string): Request => ({ method: 'getSignaturesForAddress', params: [key, { commitment: 'finalized', limit: 32 }] });
const txRequest = (sig: string): Request => ({ method: 'getTransaction', params: [sig, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] });
function read(id: string, expected: Request, raws: Record<string,string>, times: Record<string,string>, requests: Record<string,Request>): { value: unknown; at: number } {
  if (JSON.stringify(requests[id]) !== JSON.stringify(expected) || typeof raws[id] !== 'string' || !Number.isFinite(Date.parse(times[id] ?? ''))) shape();
  const parsed: unknown = JSON.parse(raws[id]!);
  if (!object(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== 1) shape();
  if (parsed.error) {
    const code=object(parsed.error)?parsed.error.code:undefined;
    throw new Error(typeof code==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(code)?code:Number.isSafeInteger(code)&&Math.abs(Number(code))<=999999?`RPC_REMOTE_${code}`:'ADVISORY_CHAIN_REMOTE');
  }
  if (!('result' in parsed)) shape();
  return { value: parsed.result, at: Date.parse(times[id]!) };
}
const failure=(error:unknown,fallback:string):{status:'INVALID'|'UNAVAILABLE';code:string}=>{const code=error instanceof Error&&/^RPC_[A-Z0-9_-]{1,50}$/.test(error.message)?error.message:fallback;return {status:code.startsWith('RPC_')?'UNAVAILABLE':'INVALID',code};};
type SignatureRow = { signature: string; slot: number; blockTime: number | null; err: unknown };
function pageRows(value: unknown, retrieved: number): SignatureRow[] {
  if (!Array.isArray(value) || value.length > 32) shape();
  const seen = new Set<string>(); let previous = Infinity;
  return value.map((v: unknown) => {
    if (!object(v) || !signature(v.signature) || seen.has(v.signature) || !integer(v.slot) || v.slot > previous || !(v.blockTime === null || integer(v.blockTime) && v.blockTime * 1000 <= retrieved) || !('err' in v) || !(v.err === null || object(v.err)) || v.confirmationStatus !== 'finalized') shape();
    seen.add(v.signature); previous = v.slot;
    return { signature: v.signature, slot: v.slot, blockTime: v.blockTime, err: v.err };
  });
}
function transaction(value: unknown, row: SignatureRow, retrieved: number, mint: string, indexedAddresses: string[]): ChainMovement[] {
  if (!object(value) || value.slot !== row.slot || value.blockTime !== row.blockTime || !integer(value.blockTime) || value.blockTime * 1000 > retrieved || !object(value.transaction) || !Array.isArray(value.transaction.signatures) || value.transaction.signatures[0] !== row.signature || !object(value.transaction.message) || !Array.isArray(value.transaction.message.accountKeys) || !object(value.meta) || value.meta.err !== null) shape();
  const keys = value.transaction.message.accountKeys.map((key: unknown) => { if (!object(key) || !address(key.pubkey)) shape(); return key.pubkey; });
  if (new Set(keys).size !== keys.length || !keys.length || keys.length > 256 || !indexedAddresses.every(key=>keys.includes(key))) shape();
  type Balance = { mint: string; owner: string; amount: string; decimals: number };
  const balances = (items: unknown): Map<number,Balance> => {
    if (!Array.isArray(items) || items.length > 256) shape(); const result = new Map<number,Balance>();
    for (const item of items) {
      if (!object(item) || !integer(item.accountIndex) || item.accountIndex >= keys.length || result.has(item.accountIndex) || !address(item.mint) || !address(item.owner) || !object(item.uiTokenAmount) || !atomic(item.uiTokenAmount.amount) || !integer(item.uiTokenAmount.decimals) || item.uiTokenAmount.decimals > 255) shape();
      result.set(item.accountIndex, { mint: item.mint, owner: item.owner, amount: item.uiTokenAmount.amount, decimals: item.uiTokenAmount.decimals });
    }
    return result;
  };
  const pre = balances(value.meta.preTokenBalances), post = balances(value.meta.postTokenBalances), movements: ChainMovement[] = [];
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(index), b = post.get(index);
    if (a && b && (a.mint !== b.mint || a.owner !== b.owner || a.decimals !== b.decimals)) shape();
    const current = b ?? a!; if (current.mint !== mint) continue;
    const before = a?.amount ?? '0', after = b?.amount ?? '0';
    movements.push({ signature: row.signature, slot: row.slot, at: new Date(value.blockTime * 1000).toISOString(), account: keys[index]!, owner: current.owner, mint, decimals: current.decimals, preAtomic: before, postAtomic: after, deltaAtomic: (BigInt(after)-BigInt(before)).toString() });
  }
  if (new Set(movements.map(x => x.decimals)).size > 1) shape();
  return movements;
}

/** Reconstructs only the declared bounded account-index sample, never whole-wallet or mint history. */
export function decodeAdvisoryChain(token: TokenRef, addresses: string[], rawArtifacts: Record<string,string>, retrievedAt: Record<string,string>, requests: Record<string,Request>): ChainHistory {
  inputs(token, addresses);
  const result: ChainHistory = { token, method: 'solana-bounded-movements-v1', genesisVerified: false, addresses: [...addresses], sourceUniverseComplete: false, pageLimit: 32, transactionLimit: 16, pages: [], transactions: [], movements: [], coveredInterval: null, complete: false, tradeCoverageComplete: false, limitations: ['Selected addresses do not enumerate all token activity or all wallet history.', 'Account balance movements do not distinguish transfers, sales, LP operations or routed trade legs.', 'No bot, shared control, wallet creation or organic-demand attribution is made.'] };
  try { result.genesisVerified = read('advisory-chain-genesis', genesisRequest, rawArtifacts, retrievedAt, requests).value === SOLANA_MAINNET_GENESIS; } catch { /* unavailable or invalid genesis fails closed */ }
  if (!result.genesisVerified) { result.limitations.push('Mainnet genesis verification unavailable or invalid.'); return result; }
  const rows = new Map<string,SignatureRow>(), indexedBy = new Map<string,string[]>(), listedAt = new Map<string,number>();
  for (const [i,key] of addresses.entries()) {
    try {
      const response = read(`advisory-chain-page-${i}`, pageRequest(key), rawArtifacts, retrievedAt, requests), found = pageRows(response.value, response.at);
      for (const row of found) { const prior = rows.get(row.signature); if (prior && JSON.stringify(prior) !== JSON.stringify(row)) shape(); }
      for (const row of found) { rows.set(row.signature,row); indexedBy.set(row.signature,[...(indexedBy.get(row.signature)??[]),key]);listedAt.set(row.signature,Math.max(listedAt.get(row.signature)??0,response.at)); }
      const dates = found.flatMap(x => x.blockTime === null ? [] : [new Date(x.blockTime*1000).toISOString()]);
      result.pages.push({ address: key, status: found.length === 32 || found.some(x => x.blockTime === null) ? 'TRUNCATED' : 'OBSERVED', returned: found.length, retained: found.length, oldestAt: dates.length ? dates.reduce((a,b)=>a<b?a:b) : null, newestAt: dates.length ? dates.reduce((a,b)=>a>b?a:b) : null, exhausted: found.length < 32 });
    } catch(error) { result.pages.push({ address: key, ...failure(error,'ADVISORY_CHAIN_PAGE_INVALID'), returned: 0, retained: 0, oldestAt: null, newestAt: null, exhausted: false }); }
  }
  const selected = [...rows.values()].slice(0,16);
  for (const [i,row] of selected.entries()) {
    const base = { signature: row.signature, slot: row.slot, at: row.blockTime === null ? null : new Date(row.blockTime*1000).toISOString(), movements: [] as ChainMovement[] };
    if (row.err !== null) { result.transactions.push({ ...base, status: 'UNAVAILABLE', code: 'TRANSACTION_FAILED' }); continue; }
    try {
      const response = read(`advisory-chain-transaction-${i}`, txRequest(row.signature), rawArtifacts, retrievedAt, requests);
      if (response.value === null) { result.transactions.push({ ...base, status: 'UNAVAILABLE', code: 'TRANSACTION_NOT_AVAILABLE' }); continue; }
      if(response.at < (listedAt.get(row.signature)??Infinity))shape();
      const movements = transaction(response.value,row,response.at,token.address,indexedBy.get(row.signature)??[]);
      result.transactions.push({ ...base, status: 'OBSERVED', movements }); result.movements.push(...movements);
    } catch(error) { result.transactions.push({ ...base, ...failure(error,'ADVISORY_CHAIN_TRANSACTION_INVALID') }); }
  }
  if (rows.size > 16) result.limitations.push(`Transaction retention cap: ${rows.size} indexed signatures, at most 16 retained.`);
  result.complete = rows.size <= 16 && result.pages.every(x=>x.status === 'OBSERVED') && result.transactions.every(x=>x.status === 'OBSERVED');
  const times = result.transactions.filter(x=>x.status==='OBSERVED' && x.at !== null).map(x=>x.at!);
  if (times.length) result.coveredInterval = { start: times.reduce((a,b)=>a<b?a:b), end: times.reduce((a,b)=>a>b?a:b) };
  return result;
}

export async function collectAdvisoryChain(token: TokenRef, addresses: string[], rpcUrl: string, fetcher: typeof fetch, now: ()=>string, signal?: AbortSignal): Promise<{rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>;data:ChainHistory}> {
  inputs(token,addresses);
  const rawArtifacts: Record<string,string> = {}, retrievedAt: Record<string,string> = {}, requests: Record<string,Request> = {};
  const run = async (id: string, request: Request) => {
    requests[id] = request;
    try { await solanaRpc(rpcUrl, request.method, request.params, fetcher, 500_000, signal, raw => { rawArtifacts[id] = raw; retrievedAt[id] = now(); }); }
    catch (error) { if (!rawArtifacts[id]) { rawArtifacts[id] = JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}}); retrievedAt[id] = now(); } }
  };
  await run('advisory-chain-genesis',genesisRequest);
  let mainnet = false; try { mainnet = read('advisory-chain-genesis',genesisRequest,rawArtifacts,retrievedAt,requests).value === SOLANA_MAINNET_GENESIS; } catch {}
  if (mainnet) {
    await Promise.all(addresses.map((key,i)=>run(`advisory-chain-page-${i}`,pageRequest(key))));
    const rows = new Map<string,SignatureRow>();
    for (const [i,key] of addresses.entries()) { try { const response=read(`advisory-chain-page-${i}`,pageRequest(key),rawArtifacts,retrievedAt,requests); for(const row of pageRows(response.value,response.at)) if(!rows.has(row.signature))rows.set(row.signature,row); } catch {} }
    const selected=[...rows.values()].slice(0,16);
    for(let offset=0;offset<selected.length;offset+=4) await Promise.all(selected.slice(offset,offset+4).map((row,j)=>row.err===null?run(`advisory-chain-transaction-${offset+j}`,txRequest(row.signature)):Promise.resolve()));
  }
  return {rawArtifacts,retrievedAt,requests,data:decodeAdvisoryChain(token,addresses,rawArtifacts,retrievedAt,requests)};
}
