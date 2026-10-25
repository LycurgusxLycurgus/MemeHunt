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
/** extendedLegs (proof36 only) counts selected-pool trades decoded through a proof36-only mode: v3 accounting, a duplicate selected route venue or proof36 truncated recovery, plus foreign swaps proven only by proof36 truncated recovery. */
export type WindowTransactionProof={trades:DecodedTrade[];foreignSwapLegs:number;nonSwapInvocations:number;cpiAuthorizedAccounts:string[];logRecovery?:LogRecovery;extendedLegs?:number};
/** Opt-in only. Unresolved invocations were attempted after log truncation; without an execution proof their success is not established.
 * unresolvedForeignSwaps exists only under foreign-flow recovery: unresolved foreign-pool swaps bound to their own trace event witness, counted inside unresolvedInvocations and never as executed legs or flow.
 * executionProvenInvocations (proof35 only) counts the unresolved invocations whose successful execution is proven by the runtime CPI ?-propagation theorem on a finalized meta.err-null receipt with ordinary SBF ancestry; it stays <= unresolvedInvocations and never reduces the unclosed count itself. */
export type LogRecovery={truncated:boolean;unresolvedInvocations:number;emptyForeignSweeps:number;unresolvedForeignSwaps?:number;executionProvenInvocations?:number};
const program=PUMP_AMM_PROGRAM_ID.toBase58();
const PUMP_CURVE_PROGRAM='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// Canonical Pump-program PDAs required by multi_hop_swap accounts 14-16 (docs source-input/final-context/multi-hop-pinned.md); always present even when no hop is a bonding curve.
const PUMP_CURVE_GLOBAL='4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const PUMP_CURVE_FEE_CONFIG='8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
const PUMP_CURVE_EVENT_AUTHORITY='Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const MULTI_HOP_TAG=Buffer.from([43,100,73,19,233,246,111,148]);
const SYSTEM_SENTINEL='11111111111111111111111111111111';
// Proof36: a multi_hop_swap hop whose venue is its base mint's Pump bonding-curve PDA is a curve hop; it emits no PumpSwap event and is never priced here.
const curvePda=(mint:string)=>PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'),new PublicKey(mint).toBuffer()],new PublicKey(PUMP_CURVE_PROGRAM))[0].toBase58();
const TOKEN_2022=TOKEN_2022_PROGRAM_ID.toBase58();
// Native (non-loaded) programs are host Rust and are not bound by the SBF cpi_common ? propagation, so an invocation with any native-builtin ancestor cannot be execution-proven from meta.err alone. Every other program id is necessarily a loaded SBF program (BPFLoaderUpgradeable-owned).
const NATIVE_BUILTINS=new Set(['11111111111111111111111111111111','ComputeBudget111111111111111111111111111111','Vote111111111111111111111111111111111111111','Stake11111111111111111111111111111111111111','Config1111111111111111111111111111111111111','BPFLoaderUpgradeab1e11111111111111111111111','BPFLoader2111111111111111111111111111111111','BPFLoader1111111111111111111111111111111111','LoaderV411111111111111111111111111111111111','NativeLoader1111111111111111111111111111111','AddressLookupTab1e1111111111111111111111111','Ed25519SigVerify111111111111111111111111111','KeccakSecp256k11111111111111111111111111111','Secp256r1SigVerify1111111111111111111111111']);
const obj=(x:unknown):x is Record<string,any>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
const atomic=(x:unknown):string=>{const s=String(x);if(!/^(0|[1-9]\d{0,19})$/.test(s)||BigInt(s)>18446744073709551615n)throw new Error('ADVISORY_TRADE_ATOMIC');return s;};
// Opt-in only: the signed i128 virtual_quote_reserves of an event whose exact SDK prefix was already re-encoded and matched.
const signed128=(x:unknown):string=>{const s=typeof x==='bigint'||x!==null&&typeof x==='object'?String(x):'';if(!/^(0|-?[1-9][0-9]{0,38})$/.test(s)||BigInt(s)< -(2n**127n)||BigInt(s)>2n**127n-1n)throw new Error('ADVISORY_TRADE_VIRTUAL_QUOTE');return s;};
const request=(pool:string):Request=>({method:'getAccountInfo',params:[pool,{encoding:'base64',commitment:'finalized'}]});
function bytes58(s:unknown):Buffer{if(typeof s!=='string'||s.length>2000||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s))throw new Error('ADVISORY_TRADE_INSTRUCTION');let n=0n;const a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';for(const c of s)n=n*58n+BigInt(a.indexOf(c));let hex=n.toString(16);if(hex.length%2)hex='0'+hex;return Buffer.concat([Buffer.alloc(s.match(/^1*/)?.[0].length??0),n===0n?Buffer.alloc(0):Buffer.from(hex,'hex')]);}
const definitions=pumpAmmJson.instructions.filter(x=>['buy','buy_exact_quote_in','sell'].includes(x.name));
function side(ix:any,currentAbi=false):'BUY'|'SELL'|null{try{const b=bytes58(ix.data);if(currentAbi){const pinned=decodePinnedWindowInstruction(b);if(pinned)return pinned.side;}const def=definitions.find(d=>Buffer.from(d.discriminator).equals(b.subarray(0,8)));return def?.name==='sell'?'SELL':def?'BUY':null;}catch{return null;}}
function decodeTransaction(value:any,expected:{signature:string;slot:number;at:string|null},poolKey:string,pool:any,stateSlot:number,retrieved:string,windowProof?:WindowTransactionProof,currentAbi=false,feeExclusive=false,recovery=false,retainVirtualQuote=false,foreignRecovery=false,modern=false,quoteProgram?:string,extended=false,quoteDecimals?:number):DecodedTrade[]{
 if(!obj(value)||value.slot!==expected.slot||!integer(value.blockTime)||new Date(value.blockTime*1000).toISOString()!==expected.at||value.blockTime*1000>Date.parse(retrieved)||value.slot>stateSlot||!obj(value.meta)||value.meta.err!==null||value.transaction?.signatures?.[0]!==expected.signature)throw new Error('ADVISORY_TRADE_TRANSACTION_BINDING');
 const message=value.transaction.message,keys=message?.accountKeys;
 if(!Array.isArray(keys)||!Array.isArray(message.instructions)||!Array.isArray(value.meta.innerInstructions)||!Array.isArray(value.meta.logMessages))throw new Error('ADVISORY_TRADE_TRANSACTION_SHAPE');
 if(windowProof){
  if(!Number.isFinite(Date.parse(retrieved))||!['legacy',0,1].includes(value.version)||!keys.length||keys.length>256||keys.some((k:any)=>!obj(k)||typeof k.pubkey!=='string'||typeof k.signer!=='boolean')||new Set(keys.map((k:any)=>k.pubkey)).size!==keys.length)throw new Error('ADVISORY_TRADE_TRANSACTION_SHAPE');
  for(const k of keys){try{new PublicKey(k.pubkey);}catch{throw new Error('ADVISORY_TRADE_TRANSACTION_SHAPE');}}
 }
 const pumpInstructions:any[]=[];
 const groups=new Map<number,any[]>();for(const g of value.meta.innerInstructions){if(!integer(g.index)||g.index>=message.instructions.length||groups.has(g.index)||!Array.isArray(g.instructions))throw new Error('ADVISORY_TRADE_INNER_SHAPE');groups.set(g.index,g.instructions);}
 for(const [i,ix] of message.instructions.entries()){if(ix.programId===program)pumpInstructions.push({...ix,depth:1,top:i,position:-1});for(const [k,inner] of (groups.get(i)??[]).entries())if(inner.programId===program){if(!integer(inner.stackHeight)||inner.stackHeight<2)throw new Error('ADVISORY_TRADE_INNER_DEPTH');pumpInstructions.push({...inner,depth:inner.stackHeight,top:i,position:k});}}
 const decodeEvent=currentAbi?(payload:string)=>decodePinnedWindowEvent(payload,feeExclusive,modern,extended):(payload:string)=>OFFLINE_PUMP_AMM_PROGRAM.coder.events.decode(payload);
 const authorized=(key:string,depth:number)=>keys.some((k:any)=>k.pubkey===key&&(k.signer===true||depth>1));
 const tokenProgram=(key:string)=>key===TOKEN_PROGRAM_ID.toBase58()||key===TOKEN_2022_PROGRAM_ID.toBase58();
 const quoteMintKey=pool?.quoteMint?.toBase58?.()??NATIVE_MINT.toBase58(),quoteProgramKey=quoteProgram??TOKEN_PROGRAM_ID.toBase58();
 // Frozen v35 event clock: for modern receipts the self-attested event timestamp is an independent integer inside the same frozen half-open hour and never after retrieval; it is not forced to equal the RPC blockTime estimate. Legacy (modern=false) keeps the exact strict equality unchanged by version.
 const blockHour=Math.floor((value.blockTime as number)/3600)*3600;
 const clockOk=(ts:unknown):boolean=>{const s=String(ts);if(!modern)return s===String(value.blockTime);if(!/^(0|[1-9]\d{0,18})$/.test(s))return false;const t=Number(s);return Number.isSafeInteger(t)&&t>=blockHour&&t<blockHour+3600&&t*1000<=Date.parse(retrieved);};
 if(windowProof)for(const ix of pumpInstructions){
  if(!Array.isArray(ix.accounts)||ix.accounts.some((a:any)=>typeof a!=='string'||!keys.some((k:any)=>k.pubkey===a)))throw new Error('ADVISORY_TRADE_INSTRUCTION_ACCOUNTS');
  const bytes=bytes58(ix.data),definition=pumpAmmJson.instructions.find(d=>Buffer.from(d.discriminator).equals(bytes.subarray(0,8)));
  const pinned=currentAbi?decodePinnedWindowInstruction(bytes):null;
  // Pinned multi_hop_swap is recognized only under the modern (proof35) decoder; proofs<=34 keep treating it through the ordinary non-swap path, so their raw semantics are unchanged.
  if(modern&&!pinned&&bytes.subarray(0,8).equals(MULTI_HOP_TAG)){
   if(bytes.length!==24)throw new Error('ADVISORY_TRADE_INSTRUCTION_DECODE');
   const a=ix.accounts,extra=a.length-16,hops=extra/5,selectedHops:number[]=[];
   // Proofs<=35 admit exactly one selected venue; proof36 (extended) admits a repeated selected venue, each bound to its own ordered event.
   if(extra>=5&&extra%5===0)for(let h=0;h<hops;h++)if(a[16+5*h+2]===poolKey){if(selectedHops.length&&!extended)throw new Error('ADVISORY_TRADE_MULTIHOP_ACCOUNT_BINDING');selectedHops.push(h);}
   const hop=selectedHops[0]??-1;
   if(hop<0){windowProof.nonSwapInvocations++;ix.multiHop={selectedHop:-1,hops:0,amountIn:'0',minOut:'0'};continue;}
   const b=16+5*hop,amountIn=bytes.readBigUInt64LE(8),minOut=bytes.readBigUInt64LE(16);
   // The 16 canonical fixed accounts (selected-program global/fee/event authority, the user volume accumulator PDA, token/system/curve programs) and the selected hop's base/quote/pool/vaults are bound here; a positive route input is required. Cross-mint route endpoints are bound in the event, never compared across units.
   if(!authorized(a[0],ix.depth)||a[3]!==GLOBAL_CONFIG_PDA.toBase58()||a[4]!==PUMP_AMM_FEE_CONFIG_PDA.toBase58()||a[5]!==userVolumeAccumulatorPda(new PublicKey(a[0])).toBase58()||a[7]!==TOKEN_PROGRAM_ID.toBase58()||a[8]!==TOKEN_2022_PROGRAM_ID.toBase58()||a[9]!==SYSTEM_SENTINEL||a[10]!==PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58()||a[11]!==program||a[12]!==PUMP_CURVE_PROGRAM||a[13]!==PUMP_CURVE_GLOBAL||a[14]!==PUMP_CURVE_FEE_CONFIG||a[15]!==PUMP_CURVE_EVENT_AUTHORITY||a[b]!==pool.baseMint.toBase58()||a[b+1]!==pool.quoteMint.toBase58()||a[b+3]!==pool.poolBaseTokenAccount.toBase58()||a[b+4]!==pool.poolQuoteTokenAccount.toBase58()||amountIn<=0n||minOut<=0n)throw new Error('ADVISORY_TRADE_MULTIHOP_ACCOUNT_BINDING');
   // Each hop trades two distinct mints; the strict single-direction sell chain (quote_i==base_(i+1)) is enforced once the selected SELL event proves the route direction, so a mixed buy/sell or discontinuous route is rejected there rather than passing a direction-agnostic shared-mint test.
   for(let h=0;h<hops;h++)if(a[16+5*h]===a[16+5*h+1])throw new Error('ADVISORY_TRADE_MULTIHOP_ROUTE');
   if(selectedHops.some(s=>a[16+5*s]!==a[b]||a[16+5*s+1]!==a[b+1]||a[16+5*s+3]!==a[b+3]||a[16+5*s+4]!==a[b+4]))throw new Error('ADVISORY_TRADE_MULTIHOP_ACCOUNT_BINDING');
   ix.multiHop={selectedHop:hop,hops,amountIn:amountIn.toString(),minOut:minOut.toString()};
   // Proof36: the ordered PumpSwap hops are all hops except bonding-curve venues; each must carry exactly one event, bound in order.
   if(extended)Object.assign(ix.multiHop,{selectedHops,poolHops:Array.from({length:hops},(_,h)=>h).filter(h=>a[16+5*h+2]!==curvePda(a[16+5*h]))});
   continue;
  }
  if(pinned){
   ix.pinned=pinned;const a=ix.accounts;
   if(pinned.side){
    if(a.length!==17||a[2]!==GLOBAL_CONFIG_PDA.toBase58()||!tokenProgram(a[9])||!tokenProgram(a[10])||a[11]!=='11111111111111111111111111111111'||a[12]!==userVolumeAccumulatorPda(new PublicKey(a[1])).toBase58()||a[13]!==PUMP_AMM_FEE_CONFIG_PDA.toBase58()||a[15]!==PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58()||a[16]!==program||!authorized(a[1],ix.depth)||a[0]===poolKey&&a[10]!==quoteProgramKey)throw new Error('ADVISORY_TRADE_V2_ACCOUNT_BINDING');
   }else{
    if(a.length!==12||!authorized(a[0],ix.depth)||a[1]!==GLOBAL_CONFIG_PDA.toBase58()||!tokenProgram(a[4])||a[8]!=='11111111111111111111111111111111'||a[9]!==ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()||a[10]!==PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58()||a[11]!==program||a[7]!==getAssociatedTokenAddressSync(new PublicKey(a[3]),new PublicKey(a[6]),true,new PublicKey(a[4])).toBase58()||a[2]===poolKey&&(a[3]!==quoteMintKey||a[4]!==quoteProgramKey||a[5]!==pool.poolQuoteTokenAccount.toBase58()))throw new Error('ADVISORY_TRADE_SWEEP_ACCOUNT_BINDING');
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
 type Frame={program:string;ix:any|null;events:DecodedTrade[];observedEvents:number;eventPayload?:string;eventPayloads?:string[];eventCpiConsumed?:number;children:number;emptySweep?:boolean;flowBelow?:boolean;route?:{k:number;name:string;prev:{hop:number;out:bigint}|null}};const stack:Frame[]=[],trades:DecodedTrade[]=[],extendedTrades=new Set<DecodedTrade>();let cursor=0,truncatedAt=-1,extendedForeign=0;
 // The runtime logs 'Log truncated' in place of the first line over its byte limit and may keep shorter later lines, so nothing after it binds a frame.
 const selectedAccounts=recovery?[poolKey,pool.poolBaseTokenAccount.toBase58(),pool.poolQuoteTokenAccount.toBase58()]:[];
 // A foreign sweep with no CPI, no event and no selected-pool account cannot move selected-pool tokens; selected-pool sweeps still require their event.
 const emptyForeignSweep=(f:Frame)=>recovery&&f.emptySweep===true&&f.children===0&&f.observedEvents===0&&!f.eventPayload&&(f.ix.depth>1||!groups.get(f.ix.top)?.length)&&!f.ix.accounts.some((k:string)=>selectedAccounts.includes(k));
 // Proof36 quote-transfer witness: the immediate Token/Token-2022 children of the swap's own recorded trace node, built lazily once from validated stackHeights. A bound leg must be a Token-2022 TransferChecked or TransferCheckedWithFee of the exact mint, authority and verified decimals; an explicit fee must equal the event tax, and an ordinary TransferChecked carries no serialized fee, so none is invented.
 const witnessFail=():never=>{throw new Error('ADVISORY_TRADE_QUOTE_TRANSFER_WITNESS');};
 let witnessTree:Array<{parent:number;raw:any}>|undefined;const witnessAt=new Map<string,number>();
 const tokenChildren=(ix:any):any[]=>{
  const tree=witnessTree??=(()=>{const nodes:Array<{parent:number;raw:any}>=[];for(const [t,top] of message.instructions.entries()){const path=[nodes.length];witnessAt.set(`${t}:-1`,nodes.length);nodes.push({parent:-1,raw:top});for(const [k,inner] of (groups.get(t)??[]).entries()){const h=obj(inner)?inner.stackHeight:null;if(!integer(h)||h<2||h>path.length+1)witnessFail();path.length=h-1;witnessAt.set(`${t}:${k}`,nodes.length);path.push(nodes.length);nodes.push({parent:path[h-2]!,raw:inner});}}return nodes;})();
  const i=witnessAt.get(`${ix.top}:${ix.position}`);if(i===undefined)return witnessFail();
  return tree.filter(e=>e.parent===i&&obj(e.raw)&&tokenProgram(e.raw.programId)).map(e=>e.raw);
 };
 const legInfo=(leg:any):Record<string,any>=>obj(leg?.parsed)&&obj(leg.parsed.info)?leg.parsed.info:{};
 const witnessAmount=(x:unknown):bigint=>{if(typeof x!=='string'||!/^(0|[1-9]\d{0,19})$/.test(x)||BigInt(x)>18446744073709551615n)witnessFail();return BigInt(x as string);};
 const checkedLeg=(leg:any,mint:string,authority:string):{amount:bigint;fee:bigint|null}=>{
  const info=legInfo(leg),type=leg?.parsed?.type,decimals=obj(info.tokenAmount)?info.tokenAmount.decimals:null;
  if(leg?.programId!==TOKEN_2022||type!=='transferChecked'&&type!=='transferCheckedWithFee'||info.mint!==mint||info.authority!==authority||'multisigAuthority' in info||!integer(decimals)||decimals>255||mint===quoteMintKey&&decimals!==quoteDecimals)witnessFail();
  const amount=witnessAmount(info.tokenAmount.amount);
  if(type==='transferChecked')return 'feeAmount' in info?witnessFail():{amount,fee:null};
  if(!obj(info.feeAmount)||info.feeAmount.decimals!==decimals)witnessFail();
  const fee=witnessAmount(info.feeAmount.amount);if(fee>amount)witnessFail();return {amount,fee};
 };
 const witnessKind=(fee:bigint|null)=>fee===null?'TRANSFER_CHECKED' as const:'TRANSFER_CHECKED_WITH_FEE' as const;
 // Direct swaps: a SELL pays exactly one vault->user leg of U under the pool authority. A BUY pays from the user quote account under the user: exactly one leg to the pool quote vault plus non-vault legs; v1 vault=core+LP+tax with all legs totalling booked+tax, v2 non-vault legs are the canonical buyback slice (or none with a zero credited buyback) and the vault takes the rest plus tax. The quote token program account must be Token-2022.
 const directWitness=(ix:any,q:QuoteAccounting,direction:'BUY'|'SELL',v2:boolean,d:any)=>{
  const a=ix.accounts,tax=BigInt(q.quoteTransferFeeAtomic!),legs=tokenChildren(ix);
  if(a[v2?10:12]!==TOKEN_2022)witnessFail();
  if(direction==='SELL'){const out=legs.filter(l=>legInfo(l).source===a[8]&&legInfo(l).destination===a[6]);if(out.length!==1)witnessFail();
   const leg=checkedLeg(out[0],quoteMintKey,a[0]);if(leg.amount!==BigInt(q.userQuoteAtomic)||leg.fee!==null&&leg.fee!==tax)witnessFail();return witnessKind(leg.fee);}
  const paid=legs.filter(l=>legInfo(l).source===a[6]),vault=paid.filter(l=>legInfo(l).destination===a[8]);if(vault.length!==1)witnessFail();
  const v=checkedLeg(vault[0],quoteMintKey,a[1]),nv=paid.filter(l=>l!==vault[0]).reduce((n,l)=>n+checkedLeg(l,quoteMintKey,a[1]).amount,0n),booked=BigInt(q.bookedQuoteAtomic!);
  if(v.fee!==null&&v.fee!==tax)witnessFail();
  if(v2?!(nv===BigInt(q.protocolFeeAtomic)*BigInt(atomic(d.buybackFeeBasisPoints))/10000n||nv===0n&&q.buybackFeeAtomic==='0')||v.amount!==booked-nv+tax:v.amount!==BigInt(q.coreQuoteAtomic)+BigInt(q.lpFeeAtomic)+tax||nv+v.amount!==booked+tax)witnessFail();
  return witnessKind(v.fee);
 };
 // Route hops: the first BUY hop's a1 input leg carries Q+tax under the user; the last SELL hop's vault->a2 payout carries U under the pool.
 const routeWitness=(ix:any,buyRoute:boolean,h:number,q:QuoteAccounting)=>{
  const a=ix.accounts,b=16+5*h,tax=BigInt(q.quoteTransferFeeAtomic!);
  const source=buyRoute?a[1]:a[b+4],destination=buyRoute?a[b+4]:a[2],authority=buyRoute?a[0]:a[b+2],want=buyRoute?BigInt(q.eventQuoteAtomic)+tax:BigInt(q.userQuoteAtomic);
  const hit=tokenChildren(ix).filter(l=>legInfo(l).source===source&&legInfo(l).destination===destination);if(hit.length!==1)witnessFail();
  const leg=checkedLeg(hit[0],a[b+1],authority);if(leg.amount!==want||leg.fee!==null&&leg.fee!==tax)witnessFail();return witnessKind(leg.fee);
 };
 // Proof36 ordered route binder: the k-th PumpSwap event of a multi_hop_swap binds to the k-th non-curve hop. Every bound hop checks its pool, user, user/System roles, clock, fee masks, chain link to the previous bound hop and the route endpoints; only selected-pool hops add flow.
 const bindRouteEvent=(frame:Frame,event:any,instructionIndex:number)=>{
  const md=event.data as any,ma=frame.ix.accounts,mh=frame.ix.multiHop,r=frame.route??={k:0,name:event.name,prev:null};
  if(r.k>=mh.poolHops.length)throw new Error('ADVISORY_TRADE_EVENT_DUPLICATE');
  if(event.name!==r.name)throw new Error('ADVISORY_TRADE_MULTIHOP_ROUTE');
  const buyRoute=r.name==='buyEvent',h:number=mh.poolHops[r.k],last=mh.hops-1,b=16+5*h;
  if(r.k===0)for(let x=0;x<last;x++)if(buyRoute?ma[16+5*x]!==ma[16+5*(x+1)+1]:ma[16+5*x+1]!==ma[16+5*(x+1)])throw new Error('ADVISORY_TRADE_MULTIHOP_ROUTE');
  const userBase=buyRoute?h===last?ma[2]:SYSTEM_SENTINEL:h===0?ma[1]:SYSTEM_SENTINEL,userQuote=buyRoute?h===0?ma[1]:SYSTEM_SENTINEL:h===last?ma[2]:SYSTEM_SENTINEL;
  if(md.pool?.toBase58()!==ma[b+2]||md.user?.toBase58()!==ma[0]||md.userBaseTokenAccount?.toBase58()!==userBase||md.userQuoteTokenAccount?.toBase58()!==userQuote||!clockOk(md.timestamp))throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT_BINDING');
  const q=reconcileWindowQuote(buyRoute?'multi_hop_swap':'sell',md,modern,true,{hop:h,hops:mh.hops});
  const tax=BigInt(q.quoteTransferFeeAtomic??'0'),base=BigInt(atomic(buyRoute?md.baseAmountOut:md.baseAmountIn)),out=buyRoute?base:BigInt(q.userQuoteAtomic)-tax;
  if(r.prev&&r.prev.hop===h-1&&(buyRoute?BigInt(q.eventQuoteAtomic):base)!==r.prev.out||h===0&&BigInt(mh.amountIn)!==(buyRoute?BigInt(q.eventQuoteAtomic)+tax:base)||h===last&&BigInt(mh.minOut)>out)throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT_BINDING');
  const signer=keys.some((k:any)=>k.pubkey===ma[0]&&k.signer===true),cpi=frame.ix.depth>1&&keys.some((k:any)=>k.pubkey===ma[0]);
  if(!signer&&!cpi)throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT_BINDING');
  if(tax>0n)q.transferWitness=routeWitness(frame.ix,buyRoute,h,q);
  r.prev={hop:h,out};r.k++;
  if(ma[b+2]!==poolKey){windowProof!.foreignSwapLegs++;return;}
  if(!signer&&!windowProof!.cpiAuthorizedAccounts.includes(ma[0]))windowProof!.cpiAuthorizedAccounts.push(ma[0]);
  frame.observedEvents++;
  if(base<=0n||BigInt(q.coreQuoteAtomic)<=0n)throw new Error('ADVISORY_TRADE_ZERO_AMOUNT');
  const trade:DecodedTrade={signature:expected.signature,slot:expected.slot,at:expected.at!,user:ma[0],side:buyRoute?'BUY':'SELL',baseAtomic:String(base),quoteAtomic:q.coreQuoteAtomic,poolBaseReservesAtomic:atomic(md.poolBaseTokenReserves),poolQuoteReservesAtomic:atomic(md.poolQuoteTokenReserves),instructionIndex,instructionName:'multi_hop_swap',quoteAccounting:q,...(retainVirtualQuote?{virtualQuoteReservesAtomic:signed128(md.virtualQuoteReserves)}:{})};
  frame.events.push(trade);if(q.method==='pumpswap-event-fee-exclusive-v3'||mh.selectedHops.length>1)extendedTrades.add(trade);
 };
 // Canonical selected-pool event->trade binding, reused by the live log path and the proof35 execution-proof recovery; instructionIndex replaces the live cursor position.
 const bindSelectedSwap=(frame:Frame,event:any,direction:'BUY'|'SELL',instructionIndex:number)=>{
  const d=event.data as any,a=frame.ix.accounts;
  const transactionSigner=Array.isArray(a)&&keys.some((k:any)=>k.pubkey===a[1]&&k.signer===true);
  const cpiAuthorized=!!windowProof&&frame.ix.depth>1&&Array.isArray(a)&&keys.some((k:any)=>k.pubkey===a[1]);
  if(!Array.isArray(a)||a.length<17||a[0]!==poolKey||a[3]!==pool.baseMint.toBase58()||a[4]!==quoteMintKey||a[7]!==pool.poolBaseTokenAccount.toBase58()||a[8]!==pool.poolQuoteTokenAccount.toBase58()||a[16]!==program||d.pool?.toBase58()!==poolKey||d.user?.toBase58()!==a[1]||d.userBaseTokenAccount?.toBase58()!==a[5]||d.userQuoteTokenAccount?.toBase58()!==a[6]||!transactionSigner&&!cpiAuthorized||!clockOk(d.timestamp))throw new Error('ADVISORY_TRADE_EVENT_BINDING');
  if(!transactionSigner&&cpiAuthorized&&!windowProof!.cpiAuthorizedAccounts.includes(a[1]))windowProof!.cpiAuthorizedAccounts.push(a[1]);
  const instructionBytes=bytes58(frame.ix.data);const definition=definitions.find(x=>Buffer.from(x.discriminator).equals(instructionBytes.subarray(0,8)));const pinned=frame.ix.pinned;
  if(!pinned&&(!definition||(instructionBytes.length!==24&&instructionBytes.length!==25)||definition.name==='sell'&&instructionBytes.length!==24||instructionBytes.length===25&&instructionBytes[24]!>1))throw new Error('ADVISORY_TRADE_INSTRUCTION_DECODE');
  const instruction=pinned?{name:pinned.name==='buy_exact_quote_in_v2'?'buyExactQuoteIn':pinned.name==='buy_v2'?'buy':'sell',data:pinned.args}:instructionBytes.length===24&&definition!.name!=='sell'?{name:definition!.name==='buy_exact_quote_in'?'buyExactQuoteIn':'buy',data:Object.fromEntries(definition!.args.slice(0,2).map((arg,i)=>[arg.name.replace(/_([a-z])/g,(_m,c:string)=>c.toUpperCase()),instructionBytes.readBigUInt64LE(8+i*8).toString()]))}:(OFFLINE_PUMP_AMM_PROGRAM.coder.instruction as typeof OFFLINE_PUMP_AMM_PROGRAM.coder.instruction & {decode(data:string,encoding:'base58'):{name:string;data:unknown}|null}).decode(frame.ix.data,'base58');if(!instruction)throw new Error('ADVISORY_TRADE_INSTRUCTION_DECODE');const args=instruction.data as any;
  if(instruction.name==='buy'&&(String(args.baseAmountOut)!==String(d.baseAmountOut)||BigInt(atomic(args.maxQuoteAmountIn))<BigInt(atomic(d.userQuoteAmountIn)))||instruction.name==='sell'&&(String(args.baseAmountIn)!==String(d.baseAmountIn)||BigInt(atomic(args.minQuoteAmountOut))>BigInt(atomic(d.userQuoteAmountOut)))||instruction.name==='buyExactQuoteIn'&&(BigInt(atomic(args.spendableQuoteIn))<BigInt(atomic(d.userQuoteAmountIn))||BigInt(atomic(args.minBaseAmountOut))>BigInt(atomic(d.baseAmountOut))))throw new Error('ADVISORY_TRADE_ARGUMENT_BINDING');
  const instructionName=pinned?.name??definition!.name;
  const quoteAccounting=feeExclusive?reconcileWindowQuote(instructionName,d,modern,extended):undefined;
  const v3=quoteAccounting?.method==='pumpswap-event-fee-exclusive-v3';
  // Proof36 v3 binds caps to the wallet amount: a BUY maximum/spendable covers booked quote plus tax and a SELL minimum is met by the landed quote; a taxed swap needs its own checked transfer witness.
  if(quoteAccounting&&direction==='BUY'&&BigInt(atomic(instruction.name==='buyExactQuoteIn'?args.spendableQuoteIn:args.maxQuoteAmountIn))<BigInt(v3?quoteAccounting.walletQuoteAtomic!:quoteAccounting.grossQuoteAtomic)||v3&&direction==='SELL'&&BigInt(atomic(args.minQuoteAmountOut))>BigInt(quoteAccounting!.walletQuoteAtomic!))throw new Error('ADVISORY_TRADE_ARGUMENT_BINDING');
  if(v3&&quoteAccounting!.quoteTransferFeeAtomic!==null&&quoteAccounting!.quoteTransferFeeAtomic!=='0')quoteAccounting!.transferWitness=directWitness(frame.ix,quoteAccounting!,direction,!!pinned,d);
  const baseAtomic=atomic(direction==='BUY'?d.baseAmountOut:d.baseAmountIn),quoteAtomic=quoteAccounting?.coreQuoteAtomic??atomic(direction==='BUY'?d.quoteAmountIn:d.quoteAmountOut);
  if(BigInt(baseAtomic)<=0n||BigInt(quoteAtomic)<=0n)throw new Error('ADVISORY_TRADE_ZERO_AMOUNT');
  const trade:DecodedTrade={signature:expected.signature,slot:expected.slot,at:expected.at!,user:a[1],side:direction,baseAtomic,quoteAtomic,poolBaseReservesAtomic:atomic(d.poolBaseTokenReserves),poolQuoteReservesAtomic:atomic(d.poolQuoteTokenReserves),instructionIndex,...(quoteAccounting?{instructionName,quoteAccounting}:{}),...(retainVirtualQuote?{virtualQuoteReservesAtomic:signed128(d.virtualQuoteReserves)}:{})};frame.events.push(trade);if(v3)extendedTrades.add(trade);
 };
 for(const [n,line] of value.meta.logMessages.entries()){if(typeof line!=='string')throw new Error('ADVISORY_TRADE_LOG_SHAPE');if(recovery&&line==='Log truncated'){truncatedAt=n;break;}let m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);
  if(m){const depth=Number(m[2]);if(depth!==stack.length+1)throw new Error('ADVISORY_TRADE_LOG_DEPTH');let ix=null;if(m[1]===program){ix=pumpInstructions[cursor++];if(!ix||ix.depth!==depth)throw new Error('ADVISORY_TRADE_INVOCATION_BINDING');if(windowProof&&ix.eventCpiPayload){const parent=stack.at(-1);let ok=parent?.program===program;if(ok&&parent!.ix?.multiHop){const q=parent!.eventPayloads??[],c=parent!.eventCpiConsumed??0;ok=c<q.length&&q[c]===ix.eventCpiPayload;parent!.eventCpiConsumed=c+1;}else if(ok)ok=parent!.eventPayload===ix.eventCpiPayload;if(!ok)throw new Error('ADVISORY_TRADE_EVENT_CPI_BINDING');}}if(stack.length)stack.at(-1)!.children++;stack.push({program:m[1]!,ix,events:[],observedEvents:0,children:0});continue;}
  m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);if(m){const f=stack.pop();if(!f||f.program!==m[1]||m[2]!=='success')throw new Error('ADVISORY_TRADE_LOG_FAILURE');if(windowProof&&f.ix?.multiHop&&(f.eventPayloads?.length??0)!==(f.eventCpiConsumed??0))throw new Error('ADVISORY_TRADE_EVENT_CPI_BINDING');const flow=windowProof&&f.ix&&(side(f.ix,currentAbi)||f.ix.pinned||(f.ix.multiHop?.selectedHop??-1)>=0);if(flow&&(f.observedEvents!==(f.ix.multiHop?.selectedHops?.length??1)||f.ix.multiHop?.poolHops&&(f.route?.k??0)!==f.ix.multiHop.poolHops.length)&&!emptyForeignSweep(f))throw new Error('ADVISORY_TRADE_EVENT_MISSING');if(f.emptySweep&&(f.observedEvents||f.children))throw new Error('ADVISORY_TRADE_SWEEP_EVENT_BINDING');if(flow){for(const a of stack)a.flowBelow=true;if(!f.observedEvents)windowProof!.logRecovery!.emptyForeignSweeps++;}trades.push(...f.events);continue;}
  if(recovery&&line.startsWith('Program log: Nothing to sweep for fee bucket ')){const f=stack.at(-1);if(f?.program===program&&f.ix?.pinned&&!f.ix.pinned.side){if(f.emptySweep||line!==`Program log: Nothing to sweep for fee bucket ${f.ix.pinned.name==='sweep_protocol_fee'?0:1}`)throw new Error('ADVISORY_TRADE_SWEEP_EVENT_BINDING');f.emptySweep=true;}continue;}
  if(!line.startsWith('Program data: '))continue;const frame=stack.at(-1);if(!frame||frame.program!==program||!frame.ix)continue;const direction=side(frame.ix,currentAbi);if(!direction&&!windowProof)continue;
  const payload=line.slice(14);if(payload.length>4000||Buffer.from(payload,'base64').toString('base64')!==payload)throw new Error('ADVISORY_TRADE_EVENT_ENCODING');const event=decodeEvent(payload);if(windowProof&&event){if(frame.ix?.multiHop)(frame.eventPayloads??=[]).push(payload);else frame.eventPayload=payload;}
  if(windowProof&&frame.ix?.multiHop&&event){
   if(!['buyEvent','sellEvent'].includes(event.name))throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT');
   if(extended&&frame.ix.multiHop.poolHops){bindRouteEvent(frame,event,cursor-1);continue;}
   const md=event.data as any,ma=frame.ix.accounts,mh=frame.ix.multiHop;
   // One PumpSwap event per hop; a hop on another pool binds to its own user and clock only and never adds selected-pool flow.
   if(md.pool?.toBase58()!==poolKey){if(md.user?.toBase58()!==ma[0]||!clockOk(md.timestamp))throw new Error('ADVISORY_TRADE_FOREIGN_EVENT_BINDING');windowProof.foreignSwapLegs++;continue;}
   if(mh.selectedHop<0||frame.observedEvents)throw new Error('ADVISORY_TRADE_EVENT_DUPLICATE');
   // SellEvent carries no ix_name. Only a selected-pool SELL hop is a supported multi-hop trade; a multi-hop BuyEvent is explicitly unsupported rather than aliased.
   if(event.name!=='sellEvent')throw new Error('ADVISORY_TRADE_MULTIHOP_BUY_UNSUPPORTED');
   // One-direction sell route: the quote mint sold on each hop is the base mint bought on the next (quote_i==base_(i+1)); a mixed or discontinuous path is rejected. The final hop produces the selected pool's quote, bound below.
   for(let h=0;h<mh.hops-1;h++)if(ma[16+5*h+1]!==ma[16+5*(h+1)])throw new Error('ADVISORY_TRADE_MULTIHOP_ROUTE');
   // The base always routes internally (System sentinel). The route-endpoint argument is bound only in its own unit: min_amount_out against the delivered quote when this is the last hop (user_out_token_account), amount_in against the base when this is the first hop; the quote is the real route output only on the last hop and otherwise routes on internally.
   const last=mh.selectedHop===mh.hops-1;
   if(md.user?.toBase58()!==ma[0]||md.userBaseTokenAccount?.toBase58()!==SYSTEM_SENTINEL||!clockOk(md.timestamp)||(last?md.userQuoteTokenAccount?.toBase58()!==ma[2]||BigInt(mh.minOut)>BigInt(atomic(md.userQuoteAmountOut)):md.userQuoteTokenAccount?.toBase58()!==SYSTEM_SENTINEL)||mh.selectedHop===0&&mh.amountIn!==atomic(md.baseAmountIn))throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT_BINDING');
   const mSigner=keys.some((k:any)=>k.pubkey===ma[0]&&k.signer===true),mCpi=frame.ix.depth>1&&keys.some((k:any)=>k.pubkey===ma[0]);
   if(!mSigner&&!mCpi)throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT_BINDING');
   if(!mSigner&&mCpi&&!windowProof.cpiAuthorizedAccounts.includes(ma[0]))windowProof.cpiAuthorizedAccounts.push(ma[0]);
   frame.observedEvents++;
   const mQuote=reconcileWindowQuote('sell',md,modern),mBase=atomic(md.baseAmountIn),mQ=mQuote.coreQuoteAtomic;
   if(BigInt(mBase)<=0n||BigInt(mQ)<=0n)throw new Error('ADVISORY_TRADE_ZERO_AMOUNT');
   frame.events.push({signature:expected.signature,slot:expected.slot,at:expected.at!,user:ma[0],side:'SELL',baseAtomic:mBase,quoteAtomic:mQ,poolBaseReservesAtomic:atomic(md.poolBaseTokenReserves),poolQuoteReservesAtomic:atomic(md.poolQuoteTokenReserves),instructionIndex:cursor-1,instructionName:'multi_hop_swap',quoteAccounting:mQuote,...(retainVirtualQuote?{virtualQuoteReservesAtomic:signed128(md.virtualQuoteReserves)}:{})});
   continue;
  }
  if(currentAbi&&frame.ix.pinned&&!direction){
   const d=event?.data,a=frame.ix.accounts;
   // The IDL declares bucket as u8, without an enum. This guarded mapping was
   // observed on all 21 named sweeps in the three retained 2026-10-11 receipts;
   // an unobserved bucket stays unsupported rather than being treated as zero flow.
   if(frame.observedEvents||event?.name!=='sweepPoolFeeEvent'||d.pool?.toBase58()!==a[2]||d.quoteMint?.toBase58()!==a[3]||d.recipient?.toBase58()!==a[6]||d.payer?.toBase58()!==a[0]||!clockOk(d.timestamp)||d.bucket!==(frame.ix.pinned.name==='sweep_protocol_fee'?0:1)||a[2]===poolKey&&d.baseMint?.toBase58()!==pool.baseMint.toBase58())throw new Error('ADVISORY_TRADE_SWEEP_EVENT_BINDING');
   atomic(d.amount);frame.observedEvents++;continue;
  }
  if(!direction||!event||!['buyEvent','sellEvent'].includes(event.name))continue;
  if(frame.events.length||windowProof&&frame.observedEvents||event.name!==(direction==='BUY'?'buyEvent':'sellEvent'))throw new Error('ADVISORY_TRADE_EVENT_DUPLICATE');
  frame.observedEvents++;
  const d=event.data as any,a=frame.ix.accounts;
  if(windowProof&&Array.isArray(a)&&a[0]!==poolKey){
   if(a.length<17||a[16]!==program||d.pool?.toBase58()!==a[0]||d.user?.toBase58()!==a[1]||d.userBaseTokenAccount?.toBase58()!==a[5]||d.userQuoteTokenAccount?.toBase58()!==a[6]||!clockOk(d.timestamp))throw new Error('ADVISORY_TRADE_FOREIGN_EVENT_BINDING');
   windowProof.foreignSwapLegs++;continue;
  }
  bindSelectedSwap(frame,event,direction,cursor-1);
 }
 if(truncatedAt>=0){
  // meta.err proves only top-level success: a nested frame still open above a closed flow frame, and every unbound invocation, stay unproven.
  const unresolved=[...stack.flatMap(f=>f.ix?[f.ix]:[]),...pumpInstructions.slice(cursor)];
  if(value.meta.logMessages.indexOf('Log truncated',truncatedAt+1)>=0)throw new Error('ADVISORY_TRADE_LOG_SHAPE');
  const foreign=new Set<any>(),executed=new Set<any>();
  if(foreignRecovery){
   // Opt-in: an unresolved swap is admitted only as a canonical foreign-pool leg bound to its own emit_cpi event in the instruction trace; it adds no flow and its execution stays unproven.
   const reject=():never=>{throw new Error('ADVISORY_TRADE_LOG_TRUNCATED');};
   const member=(k:unknown)=>typeof k==='string'&&keys.some((x:any)=>x.pubkey===k),touches=(k:unknown)=>selectedAccounts.includes(k as string);
   const trace:Array<{ix:any;top:number;position:number;depth:unknown}>=[];
   for(const [t,ix] of message.instructions.entries()){trace.push({ix,top:t,position:-1,depth:1});for(const [k,inner] of (groups.get(t)??[]).entries())trace.push({ix:inner,top:t,position:k,depth:obj(inner)?inner.stackHeight:null});}
   const at=(ix:any)=>trace.findIndex(e=>e.top===ix.top&&e.position===ix.position);
   const eventAuthority=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],PUMP_AMM_PROGRAM_ID)[0].toBase58(),claimed=new Set<any>();
   for(const ix of unresolved){
    const direction=side(ix,currentAbi);if(direction===null)continue;
    const a=ix.accounts,witness=pumpInstructions[pumpInstructions.indexOf(ix)+1],start=at(ix),stop=witness?at(witness):-1;
    if(start<0||a.length<17||a[0]===poolKey||a.some(touches)||a[2]!==GLOBAL_CONFIG_PDA.toBase58()||a[15]!==eventAuthority||a[16]!==program)reject();
    // Legacy IDL swaps also bind their user authority and canonical base/quote token, System and Associated Token program roles; current v2 roles were bound in the pre-pass.
    if(!ix.pinned){const b=bytes58(ix.data),def=definitions.find(x=>Buffer.from(x.discriminator).equals(b.subarray(0,8)));if(!def||a.length<def.accounts.length||(b.length!==24&&b.length!==25)||def.name==='sell'&&b.length!==24||b.length===25&&b[24]!>1||!authorized(a[1],ix.depth)||!tokenProgram(a[11])||!tokenProgram(a[12])||a[13]!=='11111111111111111111111111111111'||a[14]!==ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())reject();}
    if(!witness?.eventCpiPayload||!unresolved.includes(witness)||claimed.has(witness)||witness.top!==ix.top||witness.depth!==ix.depth+1||stop<=start)reject();
    // The witness must be the only PumpSwap invocation in the swap's subtree, reached only through strict descendants.
    let end=start+1;while(end<trace.length&&integer(trace[end]!.depth)&&(trace[end]!.depth as number)>ix.depth)end++;
    if(stop>=end||trace.slice(start+1,end).filter(e=>obj(e.ix)&&e.ix.programId===program).length!==1)reject();
    const event=decodeEvent(witness.eventCpiPayload),d=event?.data as any;
    if(event?.name!==(direction==='BUY'?'buyEvent':'sellEvent')||d.pool?.toBase58()!==a[0]||d.user?.toBase58()!==a[1]||d.userBaseTokenAccount?.toBase58()!==a[5]||d.userQuoteTokenAccount?.toBase58()!==a[6]||!clockOk(d.timestamp))reject();
    claimed.add(witness);foreign.add(ix);
   }
   for(const ix of unresolved)if(ix.eventCpiPayload&&!claimed.has(ix)&&['buyEvent','sellEvent'].includes(decodeEvent(ix.eventCpiPayload)?.name??''))reject();
   // The route stays open, so every instruction after the last log-bound PumpSwap invocation (same-top tail and later tops) must be canonical and exclude the selected pool and vaults.
   const from=cursor?at(pumpInstructions[cursor-1]):-1;
   if(foreign.size&&(cursor&&from<0||trace.slice(from+1).some(e=>!obj(e.ix)||!member(e.ix.programId)||!Array.isArray(e.ix.accounts)||e.ix.accounts.some((k:unknown)=>!member(k)||touches(k))||touches(e.ix.programId)||e.position>=0&&(!integer(e.depth)||(e.depth as number)<2))))reject();
  }
  if(modern){
   // Runtime execution proof: Agave v4.3.2 and v4.3.0-alpha.2 program-runtime/src/cpi.rs cpi_common propagates a failed callee via the ? operator (L842) and returns Ok(SUCCESS) only on success (L890); official-cpi-execution.md Step 10. On a finalized meta.err===null receipt any Pump invocation recorded in the complete stackHeight trace - whether its frame opened before 'Log truncated' or lies wholly after the marker - is proven executed when its full trace ancestry is entirely ordinary non-builtin SBF programs. Ancestry is resolved from the recorded trace, never the stale open log stack, so later siblings and unlogged children are handled identically.
   const closeDef=pumpAmmJson.instructions.find(x=>x.name==='close_user_volume_accumulator'),bound=new Set<any>(),frameOf=new Map<any,Frame>();for(const f of stack)if(f.ix)frameOf.set(f.ix,f);
   // Recorded instruction tree (proof35 truncated recovery only): every top-level and inner node in execution preorder with the parent its validated stackHeight implies (integer >=2, at most one level below its predecessor, program id a transaction account); PumpSwap wrappers bind to their node by top/position. The retained log prefix before the first marker must be exactly this preorder's prefix in program and depth, and the first unlogged node may attach no deeper than the still-open log stack; nothing after the marker is required or invented. Any violation leaves the truncated receipt unproven.
   const badTrace=():never=>{throw new Error('ADVISORY_TRADE_LOG_TRUNCATED');},traceTree:Array<{depth:number;program:string;parent:number;pump:any}>=[],traceAt=new Map<string,number>(),pumpAt=new Map<string,any>();for(const ix of pumpInstructions)pumpAt.set(`${ix.top}:${ix.position}`,ix);
   const traceNode=(t:number,k:number,depth:number,programId:unknown,parent:number):number=>{if(typeof programId!=='string'||!keys.some((x:any)=>x.pubkey===programId))badTrace();traceAt.set(`${t}:${k}`,traceTree.length);traceTree.push({depth,program:programId as string,parent,pump:pumpAt.get(`${t}:${k}`)??null});return traceTree.length-1;};
   for(const [t,top] of message.instructions.entries()){const path=[traceNode(t,-1,1,top?.programId,-1)];for(const [k,inner] of (groups.get(t)??[]).entries()){const h=obj(inner)?inner.stackHeight:null;if(!integer(h)||h<2||h>path.length+1)badTrace();path.length=h-1;path.push(traceNode(t,k,h,inner.programId,path[h-2]!));}}
   let logged=0;for(const line of value.meta.logMessages.slice(0,truncatedAt)){const m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);if(!m)continue;const e=traceTree[logged++];if(!e||e.program!==m[1]||e.depth!==Number(m[2]))badTrace();}
   if(logged<traceTree.length&&traceTree[logged]!.depth>stack.length+1)badTrace();
   const ancestrySbf=(ix:any):boolean=>{const i=traceAt.get(`${ix.top}:${ix.position}`);if(i===undefined)return false;for(let n=traceTree[i]!.parent;n>=0;n=traceTree[n]!.parent)if(NATIVE_BUILTINS.has(traceTree[n]!.program))return false;return true;};
   // close_user_volume_accumulator takes no arguments, so its canonical serialization is exactly the 8-byte discriminator; any trailing bytes are rejected.
   const canonicalClose=(ix:any):boolean=>{try{const b=bytes58(ix.data),a=ix.accounts;return !!closeDef&&Buffer.from(closeDef.discriminator).equals(b.subarray(0,8))&&b.length===closeDef.discriminator.length&&a.length===closeDef.accounts.length&&authorized(a[0],ix.depth)&&a[1]===userVolumeAccumulatorPda(new PublicKey(a[0])).toBase58()&&a[2]===PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58()&&a[3]===program&&!a.some((k:string)=>selectedAccounts.includes(k));}catch{return false;}};
   // ix's own event-CPI witness from the recorded tree: the only PumpSwap node anywhere in ix's subtree, an immediate child carrying an emit_cpi payload, claimable at most once. A Pump node under a later sibling or under one of ix's own non-Pump children is never ix's witness.
   const ownChild=(ix:any)=>{const i=traceAt.get(`${ix.top}:${ix.position}`);if(i===undefined)return null;let end=i+1;while(end<traceTree.length&&traceTree[end]!.depth>traceTree[i]!.depth)end++;const own=traceTree.slice(i+1,end).filter(e=>e.pump);const w=own.length===1&&own[0]!.parent===i?own[0]!.pump:null;return w&&w.eventCpiPayload&&!bound.has(w)?w:null;};
   for(const ix of unresolved){if(executed.has(ix)||foreign.has(ix)||bound.has(ix))continue;const dir=side(ix,currentAbi);
    if(dir!==null&&Array.isArray(ix.accounts)&&ix.accounts[0]===poolKey&&(ix.multiHop?.selectedHop??-1)<0){
     // Direct selected-pool swap (logged-open or wholly unlogged): bind its own buy/sell event-CPI child once through the shared bindSelectedSwap validators, reusing an in-frame event already bound before the marker. Multi-hop buys and non-selected swaps are not admitted.
     if(!ancestrySbf(ix))continue;const w=ownChild(ix);
     // Proof36: the swap's event and its own event-CPI child may both be logged before the marker (the child closed after being payload-bound to the logged event at its invoke), leaving only the swap's own close lost.
     const loggedWitness=extended&&!!w&&!unresolved.includes(w)&&pumpInstructions.indexOf(w)<cursor&&frameOf.get(ix)?.observedEvents===1&&w.eventCpiPayload===frameOf.get(ix)!.eventPayload;
     if(!w||!unresolved.includes(w)&&!loggedWitness)continue;const ev=decodeEvent(w.eventCpiPayload);if(!ev||ev.name!==(dir==='BUY'?'buyEvent':'sellEvent'))continue;
     const frame:Frame=frameOf.get(ix)??{program,ix,events:[],observedEvents:0,children:0};
     // A first, unlogged event runs the shared selected-swap validators. An event logged before the marker already bound the trade, so its unlogged emit_cpi child is accepted as the swap's own witness only when the child payload is byte-identical to that logged event - the same payload-equality invariant the fully-logged EVENT_CPI_BINDING path enforces; a same-name child differing in pool, clock or amounts is rejected and the swap stays unproven.
     if(frame.observedEvents===0){frame.observedEvents++;bindSelectedSwap(frame,ev,dir,pumpInstructions.indexOf(ix));}
     else if(w.eventCpiPayload!==frame.eventPayload)continue;
     bound.add(w);if(loggedWitness)for(const t of frame.events)extendedTrades.add(t);trades.push(...frame.events);frame.events=[];executed.add(ix);if(unresolved.includes(w))executed.add(w);
    }else if(extended&&dir!==null&&!ix.multiHop&&Array.isArray(ix.accounts)&&ix.accounts[0]!==poolKey){
     // Proof36 foreign direct swap left open or unlogged by the marker: under ordinary SBF ancestry it is proven executed by its own sole event-CPI child, byte-identical to its already logged and counted event or, when unlogged, bound to its own pool, user, user token accounts and clock exactly as a logged foreign leg. It never touches the selected pool or vaults and adds no flow.
     if(!ancestrySbf(ix)||ix.accounts.length<17||ix.accounts[16]!==program||ix.accounts.some((k:string)=>selectedAccounts.includes(k)))continue;const w=ownChild(ix);if(!w)continue;const open=frameOf.get(ix);
     if(open?.observedEvents){if(w.eventCpiPayload!==open.eventPayload)continue;}
     else{const ev=decodeEvent(w.eventCpiPayload),d=ev?.data as any,a=ix.accounts;if(!unresolved.includes(w)||ev?.name!==(dir==='BUY'?'buyEvent':'sellEvent')||d.pool?.toBase58()!==a[0]||d.user?.toBase58()!==a[1]||d.userBaseTokenAccount?.toBase58()!==a[5]||d.userQuoteTokenAccount?.toBase58()!==a[6]||!clockOk(d.timestamp))continue;windowProof!.foreignSwapLegs++;}
     bound.add(w);if(unresolved.includes(w))executed.add(w);executed.add(ix);extendedForeign++;
    }else if(extended&&ix.multiHop?.poolHops){
     // Proof36 route recovery: the route's PumpSwap trace descendants must be exactly its immediate event-CPI children, one per ordered non-curve hop and none claimed before; a logged prefix must equal the leading children byte for byte, and each remaining unlogged child is bound in order by the same route binder (its errors propagate). Any other shape stays unproven.
     if(!ancestrySbf(ix))continue;const i=traceAt.get(`${ix.top}:${ix.position}`)!;let end=i+1;while(end<traceTree.length&&traceTree[end]!.depth>traceTree[i]!.depth)end++;
     const own=traceTree.slice(i+1,end).filter(e=>e.pump).map(e=>e.parent===i&&e.pump.eventCpiPayload&&!bound.has(e.pump)?e.pump:null);
     const frame:Frame=frameOf.get(ix)??{program,ix,events:[],observedEvents:0,children:0},logged=frame.eventPayloads??[];
     if(own.length!==ix.multiHop.poolHops.length||own.some(w=>!w)||logged.length>own.length||logged.some((p,j)=>p!==own[j].eventCpiPayload)||own.slice(logged.length).some(w=>!unresolved.includes(w)))continue;
     for(const w of own.slice(logged.length)){const ev=decodeEvent(w.eventCpiPayload);if(ev?.name!=='buyEvent'&&ev?.name!=='sellEvent')throw new Error('ADVISORY_TRADE_MULTIHOP_EVENT');bindRouteEvent(frame,ev,pumpInstructions.indexOf(ix));}
     if(frame.observedEvents!==ix.multiHop.selectedHops.length||(frame.route?.k??0)!==ix.multiHop.poolHops.length)throw new Error('ADVISORY_TRADE_EVENT_MISSING');
     for(const w of own){bound.add(w);if(unresolved.includes(w))executed.add(w);}
     for(const t of frame.events)extendedTrades.add(t);trades.push(...frame.events);frame.events=[];executed.add(ix);
    }else if(dir===null&&!ix.pinned&&(ix.multiHop?.selectedHop??-1)<0&&canonicalClose(ix)){
     // Canonical selected-disjoint close_user_volume_accumulator: it must carry its own unique CloseUserVolumeAccumulatorEvent CPI child bound to the same user on an in-window clock. The event identity is verified whether the child is unlogged (admitted and counted here) or already closed in the logged prefix (verified but not re-counted), so a wrongly-closed or mismatched event is never accepted.
     if(!ancestrySbf(ix))continue;const w=ownChild(ix);if(!w)continue;const ev=decodeEvent(w.eventCpiPayload),ed=ev?.data as any;
     if(!ev||ev.name!=='closeUserVolumeAccumulatorEvent'||ed.user?.toBase58()!==ix.accounts[0]||!clockOk(ed.timestamp))continue;
     if(unresolved.includes(w)){bound.add(w);executed.add(w);}
     executed.add(ix);
    }
   }
  }
  if(stack.slice(1).some(f=>f.flowBelow)||unresolved.some(ix=>!foreign.has(ix)&&!executed.has(ix)&&((side(ix,currentAbi)!==null||ix.pinned||(ix.multiHop?.selectedHop??-1)>=0)||ix.accounts.some((k:string)=>selectedAccounts.includes(k)))))throw new Error('ADVISORY_TRADE_LOG_TRUNCATED');
  Object.assign(windowProof!.logRecovery!,{truncated:true,unresolvedInvocations:unresolved.length},modern?{executionProvenInvocations:executed.size}:{},foreignRecovery?{unresolvedForeignSwaps:foreign.size}:{});
 } else if(stack.length||cursor!==pumpInstructions.length)throw new Error('ADVISORY_TRADE_LOG_INCOMPLETE');
 const expectedSwaps=pumpInstructions.reduce((n,ix)=>n+((side(ix,currentAbi)!==null&&ix.accounts?.[0]===poolKey)?1:(ix.multiHop?.selectedHop??-1)>=0?ix.multiHop.selectedHops?.length??1:0),0);
 if(windowProof&&extended)windowProof.extendedLegs=extendedTrades.size+extendedForeign;
 if(expectedSwaps!==trades.length)throw new Error('ADVISORY_TRADE_EVENT_MISSING');return trades;
}
/** Scoped pool-flow decoder. CPI authorization is an executed-program observation, never a person or wallet-control binding.
 * logRecovery is opt-in for fee-exclusive callers; without it receipts decode exactly as before.
 * retainVirtualQuote is opt-in for fee-exclusive callers only: each selected-pool trade also carries its own verified event virtual_quote_reserves as a signed i128 decimal string; nothing else changes.
 * foreignFlowRecovery (requires logRecovery) also admits a truncated receipt whose unresolved swaps are canonical foreign-pool legs bound to their own trace event witness, with a canonical selected-disjoint tail; they are counted in logRecovery.unresolvedForeignSwaps, never as executed legs.
 * extended (proof36, requires modern) admits quote-transfer-taxed swaps with a checked transfer witness, v1 cashback, the historical +16 holder appendix, full ordered multi-hop BUY/SELL route binding and truncated route recovery. Under truncation it also completes a direct selected swap whose own event-CPI child was logged before the marker, and proves an open or unlogged foreign direct swap from its own bound event-CPI child; extendedLegs counts the selected trades decoded through these modes plus foreign swaps proven only by proof36 recovery. */
export function decodePumpSwapWindowTransaction(value:unknown,expected:{signature:string;slot:number;at:string},poolKey:string,pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>,stateSlot:number,retrieved:string,currentAbi=false,feeExclusive=false,logRecovery=false,retainVirtualQuote=false,foreignFlowRecovery=false,modern=false,quoteProgram?:string,extended=false,quoteDecimals?:number):WindowTransactionProof{
 if(feeExclusive&&!currentAbi)throw new Error('ADVISORY_TRADE_FEE_SCOPE');
 if(logRecovery&&!feeExclusive)throw new Error('ADVISORY_TRADE_RECOVERY_SCOPE');
 if(foreignFlowRecovery&&!logRecovery)throw new Error('ADVISORY_TRADE_RECOVERY_SCOPE');
 if(retainVirtualQuote&&!feeExclusive)throw new Error('ADVISORY_TRADE_VIRTUAL_SCOPE');
 if(modern&&!feeExclusive)throw new Error('ADVISORY_TRADE_MODERN_SCOPE');
 if(extended&&!modern)throw new Error('ADVISORY_TRADE_EXTENDED_SCOPE');
 const proof:WindowTransactionProof={trades:[],foreignSwapLegs:0,nonSwapInvocations:0,cpiAuthorizedAccounts:[],...(logRecovery?{logRecovery:{truncated:false,unresolvedInvocations:0,emptyForeignSweeps:0,...(foreignFlowRecovery?{unresolvedForeignSwaps:0}:{})}}:{}),...(extended?{extendedLegs:0}:{})};
 proof.trades=decodeTransaction(value,expected,poolKey,pool,stateSlot,retrieved,proof,currentAbi,feeExclusive,logRecovery,retainVirtualQuote,foreignFlowRecovery,modern,quoteProgram,extended,quoteDecimals);return proof;
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
