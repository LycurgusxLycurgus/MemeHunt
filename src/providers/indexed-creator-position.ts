import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { decodeSolanaAddress } from './solana.js';
import { readLimitedText } from './http.js';

const METHOD='solana-indexed-creator-position-v1' as const,BASE='https://data.solanatracker.io',BYTES=500_000;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const request=(path:string)=>({method:'GET' as const,url:BASE+path});
const receiptSchema=z.object({request:z.object({method:z.literal('GET'),url:z.string()}).strict(),status:z.number().int().min(0).max(599),retrievedAt:z.iso.datetime({offset:true}),body:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Receipt=z.infer<typeof receiptSchema>;
const packetSchema=z.object({method:z.literal(METHOD),mint:z.string(),cutoff:z.iso.datetime({offset:true}),receipts:z.object({token:receiptSchema,position:receiptSchema.optional()}).strict(),report:z.unknown(),sha256:z.string()}).strict();
export type IndexedCreatorPositionPacket=z.infer<typeof packetSchema>;
const address=(v:unknown):v is string=>{try{return typeof v==='string'&&decodeSolanaAddress(v).length===32;}catch{return false;}};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const amount=(v:unknown,negative=false):string=>{
 if(typeof v!=='number'||!Number.isFinite(v)||!negative&&v<0)throw new Error('POSITION_SOURCE_SHAPE');
 return new Decimal(v).toFixed();
};
const tokenRequest=(mint:string)=>request(`/tokens/${mint}`);
const positionRequest=(mint:string,wallet:string)=>request(`/v2/pnl/wallets/${wallet}/tokens/${mint}?pnlMode=strict`);
function read(r:Receipt,expected:ReturnType<typeof request>,cutoff:string){
 if(JSON.stringify(r.request)!==JSON.stringify(expected)||!Number.isFinite(Date.parse(r.retrievedAt))||Date.parse(r.retrievedAt)>Date.parse(cutoff)||Buffer.byteLength(r.body)>BYTES||hash(r.body)!==r.sha256)throw new Error('POSITION_RECEIPT_INVALID');
 if(r.status!==200)return null;
 try{return JSON.parse(r.body) as unknown;}catch{return null;}
}
function creator(value:unknown,mint:string,at:string){
 if(!object(value)||!object(value.token)||value.token.mint!==mint)return null;
 const t=value.token,c=t.creation;
 if(!object(c)||!address(c.creator)||typeof c.created_tx!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(c.created_tx)||!Number.isSafeInteger(c.created_time)||c.created_time<0||c.created_time*1000>Date.parse(at)||!Number.isInteger(t.decimals)||t.decimals<0||t.decimals>255)return null;
 return{wallet:c.creator as string,creationSignature:c.created_tx as string,createdAt:new Date(c.created_time*1000).toISOString(),decimals:t.decimals as number};
}
function derive(mint:string,cutoff:string,receipts:IndexedCreatorPositionPacket['receipts']){
 if(!address(mint)||!Number.isFinite(Date.parse(cutoff)))throw new Error('POSITION_RECEIPT_INVALID');
 const token=read(receipts.token,tokenRequest(mint),cutoff),claim=creator(token,mint,receipts.token.retrievedAt);
 const base={method:METHOD,mint,cutoff,source:'Solana Tracker PnL V2',denomination:'USD',pnlMode:'strict',creator:claim?{...claim,binding:'PROVIDER_REPORTED_TOKEN_CREATOR',verifiedOnChain:false}:null,
  validatedS15:null,networkFees:'UNESTABLISHED',accountFunding:'UNESTABLISHED',
  limitations:['Provider-reported position, not raw-reconstructed creator performance or a verified human identity.','Provider documents indexed coverage from December 2023 and excludes SOL/stablecoins; any mint may be queried but a numeric position is not guaranteed.','USD amounts are reported by the provider; no conversion to SOL or native quote accounting is inferred.','Strict mode can omit oversold positions; transfers, missing history, costs and fees may prevent complete performance.','Amounts arrive as JSON numbers; this report preserves provider precision, not exact on-chain atomic units.']};
 if(!claim){if(receipts.position)throw new Error('POSITION_RECEIPT_INVALID');return{...base,status:'MISSING',reasonCode:receipts.token.status===200?'CREATOR_CLAIM_UNAVAILABLE':`TOKEN_HTTP_${receipts.token.status}`,reported:null};}
 if(!receipts.position)return{...base,status:'MISSING',reasonCode:'POSITION_NOT_COLLECTED',reported:null};
 if(Date.parse(receipts.position.retrievedAt)<Date.parse(receipts.token.retrievedAt))throw new Error('POSITION_RECEIPT_INVALID');
 const value=read(receipts.position,positionRequest(mint,claim.wallet),cutoff);
 if(receipts.position.status!==200)return{...base,status:'MISSING',reasonCode:`POSITION_HTTP_${receipts.position.status}`,reported:null};
 try{
  if(!object(value)||value.wallet!==claim.wallet||value.token!==mint||value.pnlMode!=='strict'||value.currency!==undefined&&value.currency!=='usd'||!object(value.pnl)||!object(value.current)||!object(value.volume)||!object(value.counts))throw new Error('POSITION_SOURCE_SHAPE');
  const dev=value.identity?.developer;
  if(dev!==undefined&&(!object(dev)||dev.token!==mint||dev.creationTx!==claim.creationSignature))throw new Error('POSITION_SOURCE_SHAPE');
  const reported={invested:amount(value.invested),proceeds:amount(value.proceeds),realizedPnl:amount(value.pnl.realized,true),unrealizedPnl:amount(value.pnl.unrealized,true),totalPnl:amount(value.pnl.total,true),balanceTokens:amount(value.current.balance),costBasis:amount(value.current.costBasis),currentValue:amount(value.current.value),tokensBought:amount(value.volume.tokensBought),tokensSold:amount(value.volume.tokensSold),buys:value.counts.buys,sells:value.counts.sells};
  if(!Number.isSafeInteger(reported.buys)||reported.buys<0||!Number.isSafeInteger(reported.sells)||reported.sells<0)throw new Error('POSITION_SOURCE_SHAPE');
  const net=new Decimal(reported.tokensBought).sub(reported.tokensSold),reconciles=net.eq(reported.balanceTokens);
  return{...base,status:reconciles?'OBSERVED_PROVIDER_REPORT':'INCOMPLETE_REPORTED_INVENTORY',reasonCode:reconciles?'PROVIDER_POSITION_REPORTED':'TRANSFER_OR_INDEX_GAP_UNRESOLVED',reported,inventory:{reportedTradeNetTokens:net.toFixed(),reportedBalanceTokens:reported.balanceTokens,tradeAmountsReconcile:reconciles},completePerformance:false};
 }catch{return{...base,status:'INVALID',reasonCode:'POSITION_SOURCE_BINDING_OR_SHAPE',reported:null};}
}
/** Two provider reads only. API keys are headers and never enter requests, receipts, logs or reports. No database/config is opened. */
export async function collectIndexedCreatorPosition(mint:string,key:string,fetcher:typeof fetch=fetch,now=()=>new Date().toISOString()):Promise<IndexedCreatorPositionPacket>{
 if(!address(mint))throw new Error('INVALID_SOLANA_ADDRESS');if(!key)throw new Error('SOLANA_TRACKER_KEY_MISSING');
 const deadline=AbortSignal.timeout(45_000);
 const collect=async(q:ReturnType<typeof request>):Promise<Receipt>=>{
  let status=0,body='';
  try{const r=await fetcher(q.url,{method:q.method,headers:{'x-api-key':key,accept:'application/json'},signal:AbortSignal.any([deadline,AbortSignal.timeout(20_000)])});status=r.status;body=await readLimitedText(r,BYTES);if(body.includes(key))throw new Error('UNSAFE_PROVIDER_RESPONSE');}
  catch{status=0;body=JSON.stringify({error:{code:'PROVIDER_READ_UNAVAILABLE'}});}
  return{request:q,status,retrievedAt:now(),body,sha256:hash(body)};
 };
 const token=await collect(tokenRequest(mint)),receipts:IndexedCreatorPositionPacket['receipts']={token};
 const claim=creator(read(token,tokenRequest(mint),token.retrievedAt),mint,token.retrievedAt);
 if(claim&&!deadline.aborted)receipts.position=await collect(positionRequest(mint,claim.wallet));
 const cutoff=now(),report=derive(mint,cutoff,receipts),packet={method:METHOD,mint,cutoff,receipts,report};
 return{...packet,sha256:hash(JSON.stringify(packet))};
}
/** Verifies immutable source bytes, exact request binding, clocks and the recomputed report. No network/credentials/database. */
export function replayIndexedCreatorPosition(input:unknown):IndexedCreatorPositionPacket{
 const p=packetSchema.parse(input),{sha256,...body}=p;
 if(sha256!==hash(JSON.stringify(body))||JSON.stringify(derive(p.mint,p.cutoff,p.receipts))!==JSON.stringify(p.report))throw new Error('POSITION_REPLAY_INVALID');
 return p;
}
