import { Decimal } from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM, PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_EVENT_AUTHORITY_PDA, userVolumeAccumulatorPda, poolPda, pumpAmmJson } from '@pump-fun/pump-swap-sdk';
import type { TokenRef } from '../domain/contracts.js';
import { decodeAdvisoryChain, type ChainHistory } from './advisory-chain.js';
import { safeRpcCode, solanaRpc } from './solana.js';
import { decodePinnedWindowInstruction,decodePinnedWindowEvent,reconcileWindowQuote,type QuoteAccounting } from './pumpswap-window-abi.js';
type Request={method:string;params:unknown[]};
export type DecodedTrade={signature:string;slot:number;at:string;user:string;side:'BUY'|'SELL';baseAtomic:string;quoteAtomic:string;poolBaseReservesAtomic:string;poolQuoteReservesAtomic:string;instructionIndex:number;instructionName?:string;quoteAccounting?:QuoteAccounting;virtualQuoteReservesAtomic?:string};
export type TradeHistory={method:'pumpswap-decoded-sample-v1';token:TokenRef;pool:string|null;quoteMint:string;quoteDecimals:9;poolVerified:boolean;stateSlot:number|null;trades:DecodedTrade[];buyQuoteAtomic:string;sellQuoteAtomic:string;netQuoteAtomic:string;coveredInterval:{start:string;end:string}|null;sourceUniverseComplete:false;complete:false;transactionsInspected:number;transactionsExcluded:number;excluded:Array<{signature:string;code:string}>;limitations:string[]};
export type WindowTransactionProof={trades:DecodedTrade[];foreignSwapLegs:number;nonSwapInvocations:number;cpiAuthorizedAccounts:string[];logRecovery?:LogRecovery};
/** Opt-in only. Unresolved invocations were attempted after log truncation; none is PumpSwap flow or touches the selected pool, and their execution is not proven. */
export type LogRecovery={truncated:boolean;unresolvedInvocations:number;emptyForeignSweeps:number};
const program=PUMP_AMM_PROGRAM_ID.toBase58();
const obj=(x:unknown):x is Record<string,any>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
const atomic=(x:unknown):string=>{const s=String(x);if(!/^(0|[1-9]\d{0,19})$/.test(s)||BigInt(s)>18446744073709551615n)throw new Error('ADVISORY_TRADE_ATOMIC');return s;};
// Opt-in only: the signed i128 virtual_quote_reserves of an event whose exact SDK prefix was already re-encoded and matched.
const signed128=(x:unknown):string=>{const s=typeof x==='bigint'||x!==null&&typeof x==='object'?String(x):'';if(!/^(0|-?[1-9][0-9]{0,38})$/.test(s)||BigInt(s)< -(2n**127n)||BigInt(s)>2n**127n-1n)throw new Error('ADVISORY_TRADE_VIRTUAL_QUOTE');return s;};
const request=(pool:string):Request=>({method:'getAccountInfo',params:[pool,{encoding:'base64',commitment:'finalized'}]});
function bytes58(s:unknown):Buffer{if(typeof s!=='string'||s.length>2000||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s))throw new Error('ADVISORY_TRADE_INSTRUCTION');let n=0n;const a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';for(const c of s)n=n*58n+BigInt(a.indexOf(c));let hex=n.toString(16);if(hex.length%2)hex='0'+hex;return Buffer.concat([Buffer.alloc(s.match(/^1*/)?.[0].length??0),n===0n?Buffer.alloc(0):Buffer.from(hex,'hex')]);}
const definitions=pumpAmmJson.instructions.filter(x=>['buy','buy_exact_quote_in','sell'].includes(x.name));
function side(ix:any,currentAbi=false):'BUY'|'SELL'|null{try{const b=bytes58(ix.data);if(currentAbi){const pinned=decodePinnedWindowInstruction(b);if(pinned)return pinned.side;}const def=definitions.find(d=>Buffer.from(d.discriminator).equals(b.subarray(0,8)));return def?.name==='sell'?'SELL':def?'BUY':null;}catch{return null;}}
function decodeTransaction(value:any,expected:{signature:string;slot:number;at:string|null},poolKey:string,pool:any,stateSlot:number,retrieved:string,windowProof?:WindowTransactionProof,currentAbi=false,feeExclusive=false,recovery=false,retainVirtualQuote=false):DecodedTrade[]{
 if(!obj(value)||value.slot!==expected.slot||!integer(value.blockTime)||new Date(value.blockTime*1000).toISOString()!==expected.at||value.blockTime*1000>Date.parse(retrieved)||value.slot>stateSlot||!obj(value.meta)||value.meta.err!==null||value.transaction?.signatures?.[0]!==expected.signature)throw new Error('ADVISORY_TRADE_TRANSACTION_BINDING');
 const message=value.transaction.message,keys=message?.accountKeys;
 if(!Array.isArray(keys)||!Array.isArray(message.instructions)||!Array.isArray(value.meta.innerInstructions)||!Array.isArray(value.meta.logMessages))throw new Error('ADVISORY_TRADE_TRANSACTION_SHAPE');
 if(windowProof){
  if(!Number.isFinite(Date.parse(retrieved))||!['legacy',0,1].includes(value.version)||!keys.length||keys.length>256||keys.some((k:any)=>!obj(k)||typeof k.pubkey!=='string'||typeof k.signer!=='boolean')||new Set(keys.map((k:any)=>k.pubkey)).size!==keys.length)throw new Error('ADVISORY_TRADE_TRANSACTION_SHAPE');
  for(const k of keys){try{new PublicKey(k.pubkey);}catch{throw new Error('ADVISORY_TRADE_TRANSACTION_SHAPE');}}
 }
 const pumpInstructions:any[]=[];
 const groups=new Map<number,any[]>();for(const g of value.meta.innerInstructions){if(!integer(g.index)||g.index>=message.instructions.length||groups.has(g.index)||!Array.isArray(g.instructions))throw new Error('ADVISORY_TRADE_INNER_SHAPE');groups.set(g.index,g.instructions);}
 for(const [i,ix] of message.instructions.entries()){if(ix.programId===program)pumpInstructions.push({...ix,depth:1,top:i});for(const inner of groups.get(i)??[])if(inner.programId===program){if(!integer(inner.stackHeight)||inner.stackHeight<2)throw new Error('ADVISORY_TRADE_INNER_DEPTH');pumpInstructions.push({...inner,depth:inner.stackHeight});}}
 const decodeEvent=currentAbi?(payload:string)=>decodePinnedWindowEvent(payload,feeExclusive):(payload:string)=>OFFLINE_PUMP_AMM_PROGRAM.coder.events.decode(payload);
 const authorized=(key:string,depth:number)=>keys.some((k:any)=>k.pubkey===key&&(k.signer===true||depth>1));
 const tokenProgram=(key:string)=>key===TOKEN_PROGRAM_ID.toBase58()||key===TOKEN_2022_PROGRAM_ID.toBase58();
 if(windowProof)for(const ix of pumpInstructions){
  if(!Array.isArray(ix.accounts)||ix.accounts.some((a:any)=>typeof a!=='string'||!keys.some((k:any)=>k.pubkey===a)))throw new Error('ADVISORY_TRADE_INSTRUCTION_ACCOUNTS');
  const bytes=bytes58(ix.data),definition=pumpAmmJson.instructions.find(d=>Buffer.from(d.discriminator).equals(bytes.subarray(0,8)));
  const pinned=currentAbi?decodePinnedWindowInstruction(bytes):null;
  if(pinned){
   ix.pinned=pinned;const a=ix.accounts;
   if(pinned.side){
    if(a.length!==17||a[2]!==GLOBAL_CONFIG_PDA.toBase58()||!tokenProgram(a[9])||!tokenProgram(a[10])||a[11]!=='11111111111111111111111111111111'||a[12]!==userVolumeAccumulatorPda(new PublicKey(a[1])).toBase58()||a[13]!==PUMP_AMM_FEE_CONFIG_PDA.toBase58()||a[15]!==PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58()||a[16]!==program||!authorized(a[1],ix.depth)||a[0]===poolKey&&a[10]!==TOKEN_PROGRAM_ID.toBase58())throw new Error('ADVISORY_TRADE_V2_ACCOUNT_BINDING');
   }else{
    if(a.length!==12||!authorized(a[0],ix.depth)||a[1]!==GLOBAL_CONFIG_PDA.toBase58()||!tokenProgram(a[4])||a[8]!=='11111111111111111111111111111111'||a[9]!==ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()||a[10]!==PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58()||a[11]!==program||a[7]!==getAssociatedTokenAddressSync(new PublicKey(a[3]),new PublicKey(a[6]),true,new PublicKey(a[4])).toBase58()||a[2]===poolKey&&(a[3]!==NATIVE_MINT.toBase58()||a[4]!==TOKEN_PROGRAM_ID.toBase58()||a[5]!==pool.poolQuoteTokenAccount.toBase58()))throw new Error('ADVISORY_TRADE_SWEEP_ACCOUNT_BINDING');
    windowProof.nonSwapInvocations++;
   }
   continue;
  }
  if(!definition){
   // Anchor emit_cpi uses a reserved discriminator, not an ordinary IDL instruction.
   const eventAuthority=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],PUMP_AMM_PROGRAM_ID)[0].toBase58();
   const payload=bytes.subarray(8).toString('base64');
   if(!bytes.subarray(0,8).equals(Buffer.from('e445a52e51cb9a1d','hex'))||ix.depth<2||ix.accounts.length!==1||ix.accounts[0]!==eventAuthority||!decodeEvent(payload))throw new Error('ADVISORY_TRADE_UNSUPPORTED_INSTRUCTION');
   ix.eventCpiPayload=payload;continue;
  }
  if(!side(ix,currentAbi)){
   const decoded=(OFFLINE_PUMP_AMM_PROGRAM.coder.instruction as typeof OFFLINE_PUMP_AMM_PROGRAM.coder.instruction & {decode(data:string,encoding:'base58'):unknown}).decode(ix.data,'base58');
   if(!decoded||ix.accounts.length<definition.accounts.length)throw new Error('ADVISORY_TRADE_UNSUPPORTED_INSTRUCTION');
   windowProof.nonSwapInvocations++;
  }else if(!definition.accounts.some(a=>a.name==='user'&&'signer' in a&&a.signer===true))throw new Error('ADVISORY_TRADE_SIGNER_CONTRACT');
 }
 type Frame={program:string;ix:any|null;events:DecodedTrade[];observedEvents:number;eventPayload?:string;children:number;emptySweep?:boolean;flowBelow?:boolean};const stack:Frame[]=[],trades:DecodedTrade[]=[];let cursor=0,truncatedAt=-1;
 // The runtime logs 'Log truncated' in place of the first line over its byte limit and may keep shorter later lines, so nothing after it binds a frame.
 const selectedAccounts=recovery?[poolKey,pool.poolBaseTokenAccount.toBase58(),pool.poolQuoteTokenAccount.toBase58()]:[];
 // A foreign sweep with no CPI, no event and no selected-pool account cannot move selected-pool tokens; selected-pool sweeps still require their event.
 const emptyForeignSweep=(f:Frame)=>recovery&&f.emptySweep===true&&f.children===0&&f.observedEvents===0&&!f.eventPayload&&(f.ix.depth>1||!groups.get(f.ix.top)?.length)&&!f.ix.accounts.some((k:string)=>selectedAccounts.includes(k));
 for(const [n,line] of value.meta.logMessages.entries()){if(typeof line!=='string')throw new Error('ADVISORY_TRADE_LOG_SHAPE');if(recovery&&line==='Log truncated'){truncatedAt=n;break;}let m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);
  if(m){const depth=Number(m[2]);if(depth!==stack.length+1)throw new Error('ADVISORY_TRADE_LOG_DEPTH');let ix=null;if(m[1]===program){ix=pumpInstructions[cursor++];if(!ix||ix.depth!==depth)throw new Error('ADVISORY_TRADE_INVOCATION_BINDING');if(windowProof&&ix.eventCpiPayload){const parent=stack.at(-1);if(parent?.program!==program||parent.eventPayload!==ix.eventCpiPayload)throw new Error('ADVISORY_TRADE_EVENT_CPI_BINDING');}}if(stack.length)stack.at(-1)!.children++;stack.push({program:m[1]!,ix,events:[],observedEvents:0,children:0});continue;}
  m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);if(m){const f=stack.pop();if(!f||f.program!==m[1]||m[2]!=='success')throw new Error('ADVISORY_TRADE_LOG_FAILURE');const flow=windowProof&&f.ix&&(side(f.ix,currentAbi)||f.ix.pinned);if(flow&&f.observedEvents!==1&&!emptyForeignSweep(f))throw new Error('ADVISORY_TRADE_EVENT_MISSING');if(f.emptySweep&&(f.observedEvents||f.children))throw new Error('ADVISORY_TRADE_SWEEP_EVENT_BINDING');if(flow){for(const a of stack)a.flowBelow=true;if(!f.observedEvents)windowProof!.logRecovery!.emptyForeignSweeps++;}trades.push(...f.events);continue;}
  if(recovery&&line.startsWith('Program log: Nothing to sweep for fee bucket ')){const f=stack.at(-1);if(f?.program===program&&f.ix?.pinned&&!f.ix.pinned.side){if(f.emptySweep||line!==`Program log: Nothing to sweep for fee bucket ${f.ix.pinned.name==='sweep_protocol_fee'?0:1}`)throw new Error('ADVISORY_TRADE_SWEEP_EVENT_BINDING');f.emptySweep=true;}continue;}
  if(!line.startsWith('Program data: '))continue;const frame=stack.at(-1);if(!frame||frame.program!==program||!frame.ix)continue;const direction=side(frame.ix,currentAbi);if(!direction&&!windowProof)continue;
  const payload=line.slice(14);if(payload.length>4000||Buffer.from(payload,'base64').toString('base64')!==payload)throw new Error('ADVISORY_TRADE_EVENT_ENCODING');const event=decodeEvent(payload);if(windowProof&&event)frame.eventPayload=payload;
  if(currentAbi&&frame.ix.pinned&&!direction){
   const d=event?.data,a=frame.ix.accounts;
   // The IDL declares bucket as u8, without an enum. This guarded mapping was
   // observed on all 21 named sweeps in the three retained 2026-10-11 receipts;
   // an unobserved bucket stays unsupported rather than being treated as zero flow.
   if(frame.observedEvents||event?.name!=='sweepPoolFeeEvent'||d.pool?.toBase58()!==a[2]||d.quoteMint?.toBase58()!==a[3]||d.recipient?.toBase58()!==a[6]||d.payer?.toBase58()!==a[0]||String(d.timestamp)!==String(value.blockTime)||d.bucket!==(frame.ix.pinned.name==='sweep_protocol_fee'?0:1)||a[2]===poolKey&&d.baseMint?.toBase58()!==pool.baseMint.toBase58())throw new Error('ADVISORY_TRADE_SWEEP_EVENT_BINDING');
   atomic(d.amount);frame.observedEvents++;continue;
  }
  if(!direction||!event||!['buyEvent','sellEvent'].includes(event.name))continue;
  if(frame.events.length||windowProof&&frame.observedEvents||event.name!==(direction==='BUY'?'buyEvent':'sellEvent'))throw new Error('ADVISORY_TRADE_EVENT_DUPLICATE');
  frame.observedEvents++;
  const d=event.data as any,a=frame.ix.accounts;
  if(windowProof&&Array.isArray(a)&&a[0]!==poolKey){
   if(a.length<17||a[16]!==program||d.pool?.toBase58()!==a[0]||d.user?.toBase58()!==a[1]||d.userBaseTokenAccount?.toBase58()!==a[5]||d.userQuoteTokenAccount?.toBase58()!==a[6]||String(d.timestamp)!==String(value.blockTime))throw new Error('ADVISORY_TRADE_FOREIGN_EVENT_BINDING');
   windowProof.foreignSwapLegs++;continue;
  }
  const transactionSigner=Array.isArray(a)&&keys.some((k:any)=>k.pubkey===a[1]&&k.signer===true);
  const cpiAuthorized=!!windowProof&&frame.ix.depth>1&&Array.isArray(a)&&keys.some((k:any)=>k.pubkey===a[1]);
  if(!Array.isArray(a)||a.length<17||a[0]!==poolKey||a[3]!==pool.baseMint.toBase58()||a[4]!==NATIVE_MINT.toBase58()||a[7]!==pool.poolBaseTokenAccount.toBase58()||a[8]!==pool.poolQuoteTokenAccount.toBase58()||a[16]!==program||d.pool?.toBase58()!==poolKey||d.user?.toBase58()!==a[1]||d.userBaseTokenAccount?.toBase58()!==a[5]||d.userQuoteTokenAccount?.toBase58()!==a[6]||!transactionSigner&&!cpiAuthorized||String(d.timestamp)!==String(value.blockTime))throw new Error('ADVISORY_TRADE_EVENT_BINDING');
  if(!transactionSigner&&cpiAuthorized&&!windowProof!.cpiAuthorizedAccounts.includes(a[1]))windowProof!.cpiAuthorizedAccounts.push(a[1]);
  const instructionBytes=bytes58(frame.ix.data);const definition=definitions.find(x=>Buffer.from(x.discriminator).equals(instructionBytes.subarray(0,8)));const pinned=frame.ix.pinned;
  if(!pinned&&(!definition||(instructionBytes.length!==24&&instructionBytes.length!==25)||definition.name==='sell'&&instructionBytes.length!==24||instructionBytes.length===25&&instructionBytes[24]!>1))throw new Error('ADVISORY_TRADE_INSTRUCTION_DECODE');
  // Successfully executed pre-track-volume buy instructions retain the same two IDL u64 fields.
  // Read that exact legacy 24-byte form; current forms use the pinned SDK decoder.
  const instruction=pinned?{name:pinned.name==='buy_exact_quote_in_v2'?'buyExactQuoteIn':pinned.name==='buy_v2'?'buy':'sell',data:pinned.args}:instructionBytes.length===24&&definition!.name!=='sell'?{name:definition!.name==='buy_exact_quote_in'?'buyExactQuoteIn':'buy',data:Object.fromEntries(definition!.args.slice(0,2).map((arg,i)=>[arg.name.replace(/_([a-z])/g,(_m,c:string)=>c.toUpperCase()),instructionBytes.readBigUInt64LE(8+i*8).toString()]))}:(OFFLINE_PUMP_AMM_PROGRAM.coder.instruction as typeof OFFLINE_PUMP_AMM_PROGRAM.coder.instruction & {decode(data:string,encoding:'base58'):{name:string;data:unknown}|null}).decode(frame.ix.data,'base58');if(!instruction)throw new Error('ADVISORY_TRADE_INSTRUCTION_DECODE');const args=instruction.data as any;
  if(instruction.name==='buy'&&(String(args.baseAmountOut)!==String(d.baseAmountOut)||BigInt(atomic(args.maxQuoteAmountIn))<BigInt(atomic(d.userQuoteAmountIn)))||instruction.name==='sell'&&(String(args.baseAmountIn)!==String(d.baseAmountIn)||BigInt(atomic(args.minQuoteAmountOut))>BigInt(atomic(d.userQuoteAmountOut)))||instruction.name==='buyExactQuoteIn'&&(BigInt(atomic(args.spendableQuoteIn))<BigInt(atomic(d.userQuoteAmountIn))||BigInt(atomic(args.minBaseAmountOut))>BigInt(atomic(d.baseAmountOut))))throw new Error('ADVISORY_TRADE_ARGUMENT_BINDING');
  // The event supplies quote notionals, not transaction counts or inferred token balance deltas.
  const instructionName=pinned?.name??definition!.name;
  const quoteAccounting=feeExclusive?reconcileWindowQuote(instructionName,d):undefined;
  if(quoteAccounting&&direction==='BUY'&&BigInt(atomic(instruction.name==='buyExactQuoteIn'?args.spendableQuoteIn:args.maxQuoteAmountIn))<BigInt(quoteAccounting.grossQuoteAtomic))throw new Error('ADVISORY_TRADE_ARGUMENT_BINDING');
  const baseAtomic=atomic(direction==='BUY'?d.baseAmountOut:d.baseAmountIn),quoteAtomic=quoteAccounting?.coreQuoteAtomic??atomic(direction==='BUY'?d.quoteAmountIn:d.quoteAmountOut);
  if(BigInt(baseAtomic)<=0n||BigInt(quoteAtomic)<=0n)throw new Error('ADVISORY_TRADE_ZERO_AMOUNT');
  frame.events.push({signature:expected.signature,slot:expected.slot,at:expected.at!,user:a[1],side:direction,baseAtomic,quoteAtomic,poolBaseReservesAtomic:atomic(d.poolBaseTokenReserves),poolQuoteReservesAtomic:atomic(d.poolQuoteTokenReserves),instructionIndex:cursor-1,...(quoteAccounting?{instructionName,quoteAccounting}:{}),...(retainVirtualQuote?{virtualQuoteReservesAtomic:signed128(d.virtualQuoteReserves)}:{})});
 }
 if(truncatedAt>=0){
  // meta.err proves only top-level success: a nested frame still open above a closed flow frame, and every unbound invocation, stay unproven.
  const unresolved=[...stack.flatMap(f=>f.ix?[f.ix]:[]),...pumpInstructions.slice(cursor)];
  if(value.meta.logMessages.indexOf('Log truncated',truncatedAt+1)>=0)throw new Error('ADVISORY_TRADE_LOG_SHAPE');
  if(stack.slice(1).some(f=>f.flowBelow)||unresolved.some(ix=>side(ix,currentAbi)!==null||ix.pinned||ix.accounts.some((k:string)=>selectedAccounts.includes(k))))throw new Error('ADVISORY_TRADE_LOG_TRUNCATED');
  Object.assign(windowProof!.logRecovery!,{truncated:true,unresolvedInvocations:unresolved.length});
 } else if(stack.length||cursor!==pumpInstructions.length)throw new Error('ADVISORY_TRADE_LOG_INCOMPLETE');
 const expectedSwaps=pumpInstructions.filter(ix=>side(ix,currentAbi)!==null&&ix.accounts?.[0]===poolKey).length;
 if(expectedSwaps!==trades.length)throw new Error('ADVISORY_TRADE_EVENT_MISSING');return trades;
}
/** Scoped pool-flow decoder. CPI authorization is an executed-program observation, never a person or wallet-control binding.
 * logRecovery is opt-in for fee-exclusive callers; without it receipts decode exactly as before.
 * retainVirtualQuote is opt-in for fee-exclusive callers only: each selected-pool trade also carries its own verified event virtual_quote_reserves as a signed i128 decimal string; nothing else changes. */
export function decodePumpSwapWindowTransaction(value:unknown,expected:{signature:string;slot:number;at:string},poolKey:string,pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>,stateSlot:number,retrieved:string,currentAbi=false,feeExclusive=false,logRecovery=false,retainVirtualQuote=false):WindowTransactionProof{
 if(feeExclusive&&!currentAbi)throw new Error('ADVISORY_TRADE_FEE_SCOPE');
 if(logRecovery&&!feeExclusive)throw new Error('ADVISORY_TRADE_RECOVERY_SCOPE');
 if(retainVirtualQuote&&!feeExclusive)throw new Error('ADVISORY_TRADE_VIRTUAL_SCOPE');
 const proof:WindowTransactionProof={trades:[],foreignSwapLegs:0,nonSwapInvocations:0,cpiAuthorizedAccounts:[],...(logRecovery?{logRecovery:{truncated:false,unresolvedInvocations:0,emptyForeignSweeps:0}}:{})};
 proof.trades=decodeTransaction(value,expected,poolKey,pool,stateSlot,retrieved,proof,currentAbi,feeExclusive,logRecovery,retainVirtualQuote);return proof;
}
/** One pool-state receipt. Trade reconstruction separately requires the original indexed finalized transaction receipts. */
export async function collectAdvisoryTrades(token:TokenRef,pool:string|null,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<{rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>}>{
 if(token.chain!=='solana')throw new Error('ADVISORY_TRADE_SCOPE');new PublicKey(token.address);if(pool)new PublicKey(pool);
 const rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={},requests:Record<string,Request>={};if(!pool)return{rawArtifacts,retrievedAt,requests};const id='advisory-trades-pool',r=request(pool);requests[id]=r;
 try{await solanaRpc(rpcUrl,r.method,r.params,fetcher,100_000,signal,raw=>{rawArtifacts[id]=raw;retrievedAt[id]=now();});}catch(e){if(!rawArtifacts[id]){rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(e)}});retrievedAt[id]=now();}}
 return{rawArtifacts,retrievedAt,requests};
}
export function decodeAdvisoryTrades(token:TokenRef,poolKey:string|null,chain:ChainHistory,chainRaw:Record<string,string>,chainTimes:Record<string,string>,chainRequests:Record<string,Request>,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,Request>):TradeHistory{
 const result:TradeHistory={method:'pumpswap-decoded-sample-v1',token,pool:poolKey,quoteMint:NATIVE_MINT.toBase58(),quoteDecimals:9,poolVerified:false,stateSlot:null,trades:[],buyQuoteAtomic:'0',sellQuoteAtomic:'0',netQuoteAtomic:'0',coveredInterval:null,sourceUniverseComplete:false,complete:false,transactionsInspected:0,transactionsExcluded:0,excluded:[],limitations:['Bounded indexed sample; not whole-token or whole-wallet activity.','Quote amounts are WSOL atomic units excluding fees; no historical USD conversion inferred.','No bot, shared-control, organic-demand or arbitrage attribution.']};
 try{
  if(token.chain!=='solana'||!poolKey||JSON.stringify(decodeAdvisoryChain(token,chain.addresses,chainRaw,chainTimes,chainRequests,chain.method==='solana-paginated-movements-v2'))!==JSON.stringify(chain)||!chain.genesisVerified||!chain.addresses.includes(poolKey))throw new Error('ADVISORY_TRADE_CHAIN_SCOPE');
  const id='advisory-trades-pool';if(JSON.stringify(requests[id])!==JSON.stringify(request(poolKey))||!Number.isFinite(Date.parse(retrievedAt[id]??'')))throw new Error('ADVISORY_TRADE_POOL_REQUEST');const receipt=JSON.parse(rawArtifacts[id]!);const r=receipt.result,v=r?.value;if(receipt.jsonrpc!=='2.0'||receipt.id!==1||!integer(r?.context?.slot)||!obj(v)||v.owner!==program||v.executable!==false||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string'||v.data[0].length>10000)throw new Error('ADVISORY_TRADE_POOL_SHAPE');const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])throw new Error('ADVISORY_TRADE_POOL_ENCODING');
  const pool=PUMP_AMM_SDK.decodePool({data,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});if(pool.baseMint.toBase58()!==token.address||!pool.quoteMint.equals(NATIVE_MINT)||poolPda(pool.index,pool.creator,pool.baseMint,pool.quoteMint).toBase58()!==poolKey)throw new Error('ADVISORY_TRADE_POOL_BINDING');result.poolVerified=true;result.stateSlot=r.context.slot;
  const seen=new Set<string>();for(const [i,t] of chain.transactions.entries()){if(seen.has(t.signature))throw new Error('ADVISORY_TRADE_SIGNATURE_DUPLICATE');seen.add(t.signature);if(t.status!=='OBSERVED'){result.transactionsExcluded++;result.excluded.push({signature:t.signature,code:t.code??'CHAIN_TRANSACTION_NOT_OBSERVED'});continue;}result.transactionsInspected++;try{const id=`advisory-chain-transaction-${i}`;if(!t.at||Date.parse(t.at)>Date.parse(retrievedAt['advisory-trades-pool']!))throw new Error('ADVISORY_TRADE_POOL_CHRONOLOGY');result.trades.push(...decodeTransaction(JSON.parse(chainRaw[id]!).result,t,poolKey,pool,r.context.slot,chainTimes[id]!));}catch(e){result.transactionsExcluded++;result.excluded.push({signature:t.signature,code:e instanceof Error&&/^ADVISORY_TRADE_[A-Z_]+$/.test(e.message)?e.message:'ADVISORY_TRADE_DECODE_INVALID'});}}
 }catch(e){result.limitations.push(e instanceof Error&&/^ADVISORY_TRADE_[A-Z_]+$/.test(e.message)?e.message:'ADVISORY_TRADE_PROOF_INVALID');result.trades=[];result.poolVerified=false;result.stateSlot=null;}
 result.trades.sort((a,b)=>a.slot-b.slot||a.signature.localeCompare(b.signature)||a.instructionIndex-b.instructionIndex);let buys=0n,sells=0n;for(const t of result.trades){if(t.side==='BUY')buys+=BigInt(t.quoteAtomic);else sells+=BigInt(t.quoteAtomic);}result.buyQuoteAtomic=String(buys);result.sellQuoteAtomic=String(sells);result.netQuoteAtomic=String(buys-sells);if(result.trades.length){const times=result.trades.map(t=>t.at).sort();result.coveredInterval={start:times[0]!,end:times.at(-1)!};}return result;
}

export function deriveAdvisoryTrades(history:TradeHistory,cutoff:string,evidenceIds:string[]):import('../domain/advisory-contracts.js').AdvisoryMetric[]{
 const valid=history.poolVerified&&history.trades.length>0&&history.trades.every(t=>Date.parse(t.at)<=Date.parse(cutoff));
 const ordered=valid?[...history.trades].sort((a,b)=>a.slot-b.slot||a.signature.localeCompare(b.signature)||a.instructionIndex-b.instructionIndex):[];
 const motifs:Array<{user:string;start:string;end:string;signatures:string[];baseBoughtAtomic:string;baseSoldAtomic:string;grossQuoteAtomic:string;netQuoteAtomic:string}>=[];
 // A relative return to the start of a decoded trade segment is not a claim about total wallet inventory.
 for(const user of new Set(ordered.map(t=>t.user))){let inventory=0n,bought=0n,sold=0n,quote=0n,net=0n;let segment:DecodedTrade[]=[];
  for(const t of ordered.filter(t=>t.user===user)){const base=BigInt(t.baseAtomic),amount=BigInt(t.quoteAtomic);inventory+=t.side==='BUY'?base:-base;if(t.side==='BUY')bought+=base;else sold+=base;quote+=amount;net+=t.side==='BUY'?-amount:amount;segment.push(t);
   if(inventory===0n&&bought>0n&&sold>0n){motifs.push({user,start:segment[0]!.at,end:t.at,signatures:[...new Set(segment.map(x=>x.signature))],baseBoughtAtomic:String(bought),baseSoldAtomic:String(sold),grossQuoteAtomic:String(quote),netQuoteAtomic:String(net)});bought=0n;sold=0n;quote=0n;net=0n;segment=[];}
  }
 }
 const repeatedUsers=[...new Set(motifs.map(m=>m.user))].filter(user=>motifs.filter(m=>m.user===user).length>=2);
 const vector=ordered.filter(t=>BigInt(t.poolBaseReservesAtomic)>0n&&BigInt(t.poolQuoteReservesAtomic)>0n).map(t=>{
  const preReservePrice=new Decimal(t.poolQuoteReservesAtomic).div(t.poolBaseReservesAtomic),executionPrice=new Decimal(t.quoteAtomic).div(t.baseAtomic);
  return {signature:t.signature,at:t.at,side:t.side,quoteAtomic:t.quoteAtomic,preBaseReserveAtomic:t.poolBaseReservesAtomic,preQuoteReserveAtomic:t.poolQuoteReservesAtomic,preQuoteAtomicPerBaseAtomic:preReservePrice.toFixed(),executionQuoteAtomicPerBaseAtomic:executionPrice.toFixed(),executionVsPreReservePrice:executionPrice.div(preReservePrice).minus(1).toFixed()};
 });
 const first=vector[0],last=vector.at(-1);const sameWindow=first&&last&&first.at!==last.at?{
  start:first.at,end:last.at,endpointMethod:'event-pretrade-reserves-v1',priceChange:new Decimal(last.preQuoteAtomicPerBaseAtomic).div(first.preQuoteAtomicPerBaseAtomic).minus(1).toFixed(),quoteReserveChangeAtomic:String(BigInt(last.preQuoteReserveAtomic)-BigInt(first.preQuoteReserveAtomic)),baseReserveChangeAtomic:String(BigInt(last.preBaseReserveAtomic)-BigInt(first.preBaseReserveAtomic)),
  quoteFlowAtomic:String(ordered.filter(t=>Date.parse(t.at)>=Date.parse(first.at)&&Date.parse(t.at)<Date.parse(last.at)).reduce((n,t)=>n+(t.side==='BUY'?BigInt(t.quoteAtomic):-BigInt(t.quoteAtomic)),0n)),flowInterval:'[start,end)',continuousCoverage:false,
 }:null;
 const cutoffMs=Date.parse(cutoff),meaningfulQuoteAtomic='10000000',firstSeen=new Map<string,string>();for(const t of ordered)if(t.side==='BUY'&&BigInt(t.quoteAtomic)>=BigInt(meaningfulQuoteAtomic)&&!firstSeen.has(t.user))firstSeen.set(t.user,t.at);
 const windows=Number.isFinite(cutoffMs)?Array.from({length:6},(_,i)=>{const start=cutoffMs-(6-i)*3_600_000,end=start+3_600_000,selected=ordered.filter(t=>Date.parse(t.at)>=start&&Date.parse(t.at)<end),buyers=[...firstSeen].filter(([,at])=>Date.parse(at)>=start&&Date.parse(at)<end).map(([user])=>user),net=selected.reduce((n,t)=>n+(t.side==='BUY'?BigInt(t.quoteAtomic):-BigInt(t.quoteAtomic)),0n);return{start:new Date(start).toISOString(),end:new Date(end).toISOString(),coverage:selected.length?'TRUNCATED':'MISSING',decodedTrades:selected.length,firstObservedMeaningfulBuyers:buyers,netQuoteAtomic:String(net),sampleCondition:selected.length?buyers.length>0&&net>=0n:null};}):[];
 return [
  {id:'O28',quality:valid?'TRUNCATED':'MISSING',unit:'WSOL quote flow',data:history,evidenceIds,reasonCode:valid?'DECODED_QUOTE_FLOW_BOUNDED_SAMPLE':'DECODED_QUOTE_FLOW_UNAVAILABLE'},
  {id:'O26',quality:valid?'TRUNCATED':'MISSING',unit:'bounded inventory-return motifs',data:{method:'decoded-trade-inventory-return-v1',scope:'same-user exact base-atomic return in retained pool trades',motifs,motifCount:motifs.length,repeatedUsers,repeatedGrossQuoteAtomic:String(motifs.filter(m=>repeatedUsers.includes(m.user)).reduce((n,m)=>n+BigInt(m.grossQuoteAtomic),0n)),repeatedMotifCount:motifs.filter(m=>repeatedUsers.includes(m.user)).length,coveredGrossQuoteAtomic:String(motifs.reduce((n,m)=>n+BigInt(m.grossQuoteAtomic),0n)),complete:false,transferCoverage:false,alternatives:['Arbitrage or legitimate inventory rebalancing can produce the same motif.'],limitations:['Starting absolute inventory, intervening transfers and unretained trades are not observed.','Zero motifs in a bounded sample does not establish absence globally.']},evidenceIds,reasonCode:valid?'INVENTORY_RETURN_MOTIFS_BOUNDED_SAMPLE':'DECODED_TRADES_UNAVAILABLE'},
  {id:'O29',quality:'MISSING',unit:'same-window price/quote/reserve vector',data:{method:'event-price-quote-reserves-v1',vector,sameWindow,depthAtDefinedImpact:null,cohortBaseline:null,anomaly:null,limitations:['Execution-versus-pre-reserve-price includes curve movement; it is not a independently simulated fixed-size price-impact certificate.','Reserve vectors do not replace defined depth measurements.','No calibrated cohort baseline exists; no thin-liquidity anomaly is asserted.']},evidenceIds,reasonCode:'MATCHED_DEPTH_AND_COHORT_BASELINE_UNAVAILABLE'},
  {id:'A30',quality:'MISSING',unit:'meaningful-buyer/decoded-flow window persistence',data:{method:'sample-demand-windows-v1',meaningfulThreshold:{quoteMint:history.quoteMint,quoteDecimals:9,quoteAtomic:meaningfulQuoteAtomic,quoteUnits:'0.01',meaning:'descriptive research threshold, not profitability or organic demand'},windowMethod:'six trailing one-hour half-open buckets ending at cutoff',cutoff,windows,observedWindows:windows.filter(w=>w.decodedTrades>0).length,sampleConditionWindows:windows.filter(w=>w.sampleCondition===true).length,sampleConditionShare:windows.some(w=>w.decodedTrades>0)?new Decimal(windows.filter(w=>w.sampleCondition===true).length).div(windows.filter(w=>w.decodedTrades>0).length).toFixed():null,verifiedNewBuyerShare:null,preWindowHolderAndTraderBaseline:false,complete:false,limitations:['First observed within a retained sample does not establish a newly entering buyer.','Unobserved buckets remain missing, not zero-volume observations.','Persistence share requires a comparable complete tape and pre-window buyer baseline.']},evidenceIds,reasonCode:'NEW_BUYER_BASELINE_AND_COMPLETE_WINDOW_TAPE_UNAVAILABLE'},
 ];
}
