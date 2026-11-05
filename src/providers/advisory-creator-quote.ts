import {validateNativeCreatorTokenForms} from './advisory-creator-inventory.js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { TokenRef } from '../domain/contracts.js';
import type { CreatorRoleDecode } from './advisory-creator-role-collector.js';
import { decodeCreatorRole } from './advisory-creator-role-collector.js';
import type { CreatorRoleReceipts } from './advisory-creator-role.js';
import { PUMP_PROGRAM, creatorRoleTransactionRequest } from './advisory-creator-role.js';
import { decodePumpTradeEvent, bindPumpTradeInstruction } from './advisory-creator-lifetime.js';
import {truncatedQuoteCandidates,proveCommittedQuoteTransfers} from './advisory-creator-quote-execution.js';
import { executedWindowInstructions } from './advisory-window-accounts.js';
import { LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM,SOLANA_MAINNET_GENESIS,decodeSolanaAddress,safeRpcCode,solanaRpc } from './solana.js';

export const CREATOR_QUOTE_REQUEST_CAP=68,CREATOR_QUOTE_TRANSACTION_CAP=64,CREATOR_QUOTE_BYTES=6_000_000;
type Request={method:string;params:unknown[]};
export type CreatorQuoteReceipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>};
const SYSTEM='11111111111111111111111111111111',WSOL='So11111111111111111111111111111111111111112',PROGRAMS=new Set([LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const n=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,19})$/.test(v)||BigInt(v)>2n**64n-1n)throw new Error('CREATOR_QUOTE_AMOUNT');return BigInt(v);};
const key=(v:unknown):v is string=>{try{return typeof v==='string'&&decodeSolanaAddress(v).length===32;}catch{return false;}};
function bytes58(s:string){if(!/^[1-9A-HJ-NP-Za-km-z]{1,6000}$/.test(s))throw new Error('CREATOR_QUOTE_ENCODING');let a=0n;for(const c of s)a=a*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));const h=a.toString(16);return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),a===0n?Buffer.alloc(0):Buffer.from(h.length%2?'0'+h:h,'hex')]);}
const sig=(s:unknown):s is string=>typeof s==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s)&&bytes58(s).length===64;
const pda=(...seeds:Buffer[])=>PublicKey.findProgramAddressSync(seeds,new PublicKey(PUMP_PROGRAM))[0].toBase58();
const headRequest=(account:string):Request=>({method:'getAccountInfo',params:[account,{encoding:'jsonParsed',commitment:'finalized'}]});
const indexRequest=(account:string,slot:number):Request=>({method:'getSignaturesForAddress',params:[account,{limit:1000,commitment:'finalized',minContextSlot:slot}]});
const genesis:Request={method:'getGenesisHash',params:[]};
function scope(role:CreatorRoleDecode){
 const b=role.binding;if(role.quality!=='KNOWN'||!b)throw new Error('ADVISORY_CREATOR_ACCOUNTING_ROLE');
 return{b,account:getAssociatedTokenAddressSync(new PublicKey(b.token.address),new PublicKey(b.wallet),false,new PublicKey(b.creation.tokenProgram)).toBase58()};
}
/** One quote-native v2 Pump trade. Full runtime, bound event/authority, CPI subtree, exact token transfers and metadata balances are all required. */
export function decodeCreatorQuoteTrade(tx:any,role:CreatorRoleDecode,recoverCommitted=false){
 const {b,account}=scope(role),mint=b.token.address,meta=tx?.meta,message=tx?.transaction?.message;
 if(!obj(meta)||meta.err!==null||!obj(message)||!Array.isArray(message.accountKeys)||!integer(meta.fee)||!integer(tx.blockTime))throw new Error('CREATOR_QUOTE_TRANSACTION');
 const keys=message.accountKeys,flags=new Map<string,any>();
 for(const k of keys){if(!obj(k)||!key(k.pubkey)||typeof k.signer!=='boolean'||typeof k.writable!=='boolean'||flags.has(k.pubkey))throw new Error('CREATOR_QUOTE_KEYS');flags.set(k.pubkey,k);}
 if(!flags.get(b.wallet)?.signer)throw new Error('CREATOR_QUOTE_SIGNER');
 let recovered=false;let steps:ReturnType<typeof executedWindowInstructions>;
 try{steps=executedWindowInstructions(tx);}catch(error){if(!recoverCommitted)throw error;steps=truncatedQuoteCandidates(tx);recovered=true;}
 const events=steps.flatMap((s,i)=>{
  if(!s.executed||s.ix.programId!==PUMP_PROGRAM||typeof s.ix.data!=='string')return[];
  const event=decodePumpTradeEvent(bytes58(s.ix.data),mint);return event?[{event,index:i,step:s}]:[];
 });
 if(events.length!==1)throw new Error('CREATOR_QUOTE_EVENT_COUNT');
 const {event:e,index:eventIndex,step:eventStep}=events[0]!,authority=pda(Buffer.from('__event_authority'));
 if(eventStep.ix.accounts?.length!==1||eventStep.ix.accounts[0]!==authority||e.timestamp!==BigInt(tx.blockTime)||e.user!==b.wallet)throw new Error('CREATOR_QUOTE_EVENT_BINDING');
 let parent=eventIndex-1;while(parent>=0&&steps[parent]!.top===eventStep.top&&steps[parent]!.depth>=eventStep.depth)parent--;
 const step=steps[parent];if(!step?.executed||step.top!==eventStep.top||step.depth!==eventStep.depth-1||step.ix.programId!==PUMP_PROGRAM)throw new Error('CREATOR_QUOTE_EVENT_PARENT');
 const a=step.ix.accounts,quoteMint=e.tail.quoteMint,quoteProgram=a?.[4];
 if(!key(quoteMint)||quoteMint===SYSTEM||quoteMint===WSOL||quoteMint===mint||quoteMint!==b.creation.quoteMint||!PROGRAMS.has(quoteProgram))throw new Error('CREATOR_QUOTE_DENOMINATION');
 const bound=bindPumpTradeInstruction(step.ix,flags,{mint,wallet:b.wallet,creationSignature:b.creation.signature,creationSlot:b.creation.slot},account,e,{mint:quoteMint,program:quoteProgram});
 const core=n(String(e.tail.quoteAmount)),buyback=n(String(e.tail.buybackFee??0n)),reward=n(String(e.tail.holderRewards??0n)),rewardBps=n(String(e.tail.holderRewardsBps??0n));
 if(e.solAmount!==0n||(e.tail.cashback??0n)!==0n||Array.isArray(e.tail.shareholders)&&e.tail.shareholders.length)throw new Error('CREATOR_QUOTE_SEMANTICS');
 const holder=b.creation.holderReward===true,recipient=holder?pda(Buffer.from('holder-rewards'),new PublicKey(mint).toBuffer()):e.creator;
 if(holder?(e.creator!==recipient||reward!==e.creatorFee||rewardBps!==e.creatorFeeBasisPoints):(reward!==0n||rewardBps!==0n))throw new Error('CREATOR_QUOTE_HOLDER_REWARD');
 // Bind every movement inside the trade frame; attempted/rolled-back children are never used.
 const children=[];for(let i=parent+1;i<steps.length&&steps[i]!.top===step.top&&steps[i]!.depth>step.depth;i++)children.push(steps[i]!);
 const transfers=children.filter(s=>s.executed&&PROGRAMS.has(s.ix.programId)&&['transfer','transferChecked'].includes(s.ix.parsed?.type));
 const balance=(address:string,asset:string)=>{
  const index=keys.findIndex((k:any)=>k.pubkey===address);if(index<0||!Array.isArray(meta.preTokenBalances)||!Array.isArray(meta.postTokenBalances))throw new Error('CREATOR_QUOTE_BALANCE');
  const pick=(rows:any[])=>{const own=rows.filter(x=>x.accountIndex===index);if(own.length>1)throw new Error('CREATOR_QUOTE_BALANCE');const x=own[0];if(!x)return null;if(x.mint!==asset||!integer(x.uiTokenAmount?.decimals)||x.uiTokenAmount.decimals>255)throw new Error('CREATOR_QUOTE_BALANCE');return{amount:n(x.uiTokenAmount.amount),decimals:x.uiTokenAmount.decimals,owner:x.owner};};
  const before=pick(meta.preTokenBalances),after=pick(meta.postTokenBalances);if(!after||before&&before.decimals!==after.decimals||!before&&meta.preBalances?.[index]!==0)throw new Error('CREATOR_QUOTE_BALANCE');
  return{pre:before?.amount??0n,post:after.amount,decimals:after.decimals,owner:after.owner};
 };
 const base=balance(account,mint),quoteUser=a[15],quote=balance(quoteUser,quoteMint);
 if(base.owner!==b.wallet||quote.owner!==b.wallet||base.post-base.pre!==(e.isBuy?e.tokenAmount:-e.tokenAmount))throw new Error('CREATOR_QUOTE_BASE_IDENTITY');
 const transfer=(source:string,destination:string,asset:string,program:string,amount:bigint)=>{
  const matches=transfers.filter(s=>s.ix.programId===program&&s.ix.parsed?.type==='transferChecked'&&s.ix.parsed.info?.source===source&&s.ix.parsed.info?.destination===destination&&s.ix.parsed.info?.mint===asset);
  if(matches.length!==1||n(matches[0]!.ix.parsed.info.tokenAmount?.amount)!==amount||matches[0]!.ix.parsed.info.tokenAmount?.decimals!==(asset===mint?base.decimals:quote.decimals)||matches[0]!.ix.parsed.info.authority!==([a[11],a[12]].includes(source)?a[10]:b.wallet))throw new Error('CREATOR_QUOTE_TRANSFER');
  return matches[0]!;
 };
 const curve=a[10],baseCurve=a[11],quoteCurve=a[12];
 const baseTransfer=transfer(e.isBuy?baseCurve:account,e.isBuy?account:baseCurve,mint,a[3],e.tokenAmount);
 const fits=(included:boolean)=>{
  const protocol=included?e.fee-buyback:e.fee;if(protocol<0n)return null;
  const charged=protocol+buyback+e.creatorFee,user=e.isBuy?core+charged:core-charged;
  if(user<=0n)return null;
  const matched=new Set([baseTransfer]);
  try{
   matched.add(transfer(e.isBuy?quoteUser:quoteCurve,e.isBuy?quoteCurve:quoteUser,quoteMint,quoteProgram,e.isBuy?core:user));
   if(protocol)matched.add(transfer(e.isBuy?quoteUser:quoteCurve,a[7],quoteMint,quoteProgram,protocol));
   if(buyback)matched.add(transfer(e.isBuy?quoteUser:quoteCurve,a[9],quoteMint,quoteProgram,buyback));
   if(e.creatorFee)matched.add(transfer(e.isBuy?quoteUser:quoteCurve,a[17],quoteMint,quoteProgram,e.creatorFee));
  }catch{return null;}
  return{protocol,user,matched,model:included?'BUYBACK_INCLUDED_IN_PROTOCOL':'BUYBACK_ADDITIONAL'};
 };
 const fitsAll=(buyback?[false,true]:[false]).map(fits).filter((f):f is NonNullable<typeof f>=>f!==null);
 if(fitsAll.length!==1)throw new Error('CREATOR_QUOTE_FEE_IDENTITY');const fit=fitsAll[0]!;
 if(recovered){validateNativeCreatorTokenForms(tx);if(!e.isBuy)throw new Error('CREATOR_QUOTE_RECOVERY_SCOPE');proveCommittedQuoteTransfers(tx,steps,fit.matched);}
 if(e.isBuy?fit.user>bound.limit:fit.user<bound.limit)throw new Error('CREATOR_QUOTE_SLIPPAGE');
 // Routers may convert the received quote immediately. Reconcile all executed quote-account transfers
 // to metadata and expose flows outside the Pump subtree separately; never call the intermediate quote final proceeds.
 const own=new Set(children),outsideQuote:Array<{direction:string;amountAtomic:string;counterpartyAccount:string}>=[];let quoteNet=0n;
 for(const s of steps){
  if(!s.executed||!PROGRAMS.has(s.ix.programId))continue;
  const p=s.ix.parsed,info=p?.info,touches=[info?.source,info?.destination,info?.account].some(x=>[account,quoteUser].includes(x))||s.ix.accounts?.some((x:string)=>[account,quoteUser].includes(x));
  if(!touches)continue;
  if(p?.type==='transferChecked'){
   if([info.source,info.destination].includes(account)&&!own.has(s))throw new Error('CREATOR_QUOTE_OUTSIDE_BASE_FLOW');
   if([info.source,info.destination].includes(quoteUser)){
    if(info.mint!==quoteMint||s.ix.programId!==quoteProgram||info.tokenAmount?.decimals!==quote.decimals)throw new Error('CREATOR_QUOTE_ROUTED_IDENTITY');
    const amount=n(info.tokenAmount.amount),incoming=info.destination===quoteUser,outgoing=info.source===quoteUser;quoteNet+=(incoming?amount:0n)-(outgoing?amount:0n);
    if(!own.has(s)&&recovered&&!(s as {runtimeCommitted?:boolean}).runtimeCommitted)throw new Error('CREATOR_QUOTE_OUTSIDE_EXECUTION_UNPROVEN');
    if(!own.has(s))outsideQuote.push({direction:incoming?'IN':'OUT',amountAtomic:String(amount),counterpartyAccount:incoming?info.source:info.destination});
   }
  }else if(!['initializeAccount','initializeAccount2','initializeAccount3','initializeImmutableOwner','getAccountDataSize'].includes(p?.type))throw new Error('CREATOR_QUOTE_ACCOUNT_MUTATION_UNSUPPORTED');
 }
 if(quote.post-quote.pre!==quoteNet)throw new Error('CREATOR_QUOTE_ROUTED_BALANCE');
 if(transfers.some(s=>[s.ix.parsed?.info?.source,s.ix.parsed?.info?.destination].some(x=>[account,quoteUser].includes(x))&&!fit.matched.has(s)))throw new Error('CREATOR_QUOTE_EXTRA_TRANSFER');

 return{signature:tx.transaction.signatures[0] as string,slot:tx.slot as number,at:new Date(tx.blockTime*1000).toISOString(),side:e.isBuy?'BUY' as const:'SELL' as const,instruction:bound.instruction,
  base:{mint,decimals:base.decimals,unitsAtomic:String(e.tokenAmount),account,preAtomic:String(base.pre),postAtomic:String(base.post)},quote:{mint:quoteMint,program:quoteProgram,decimals:quote.decimals,coreAtomic:String(core),userAtomic:String(fit.user),transactionNetAtomic:String(quoteNet),routedFlowsOutsideTrade:outsideQuote,proceedsBasis:'PUMP_LEG_QUOTE_BEFORE_OTHER_ROUTE_LEGS',solConversion:null},
  fees:{includedInUserQuote:true,protocolAtomic:String(fit.protocol),buybackAtomic:String(buyback),creatorAtomic:String(e.creatorFee),holderRewardAtomic:String(reward),holderRewardIsCreatorFeeSubset:true,holderRewardFeeAuthority:holder?recipient:null,creatorFeeAttributedToSignerAtomic:holder?'0':null,receivedHolderDistributionsAtomic:null,model:fit.model,unclaimedAccruedAtomic:String(e.tail.creatorFeeUnclaimed??0n)},
  networkFee:{asset:'SOL',unit:'lamports',directCreatorCharged:keys[0].pubkey===b.wallet?String(meta.fee):'0',includedInQuote:false},execution:recovered?'POSITIVE_COMMITTED_TRANSFER_BALANCES_WITH_BOUND_TRUNCATED_TRACE':'COMPLETE_SUCCESSFUL_RUNTIME_TRACE'};
}

/** Canonical-account evidence only: never proves all creator-controlled accounts or failed-fee coverage. */
export function decodeCreatorQuoteAccounting(token:TokenRef,role:CreatorRoleDecode,r:CreatorQuoteReceipts,cutoff:string,recoverCommitted=false){
 const {b,account}=scope(role);if(token.chain!=='solana'||token.address!==b.token.address)throw new Error('ADVISORY_CREATOR_ACCOUNTING_ROLE');
 const keys=Object.keys(r.requests),used=new Set<string>(),cut=Date.parse(cutoff);
 const invalid=():never=>{throw new Error('ADVISORY_CREATOR_ACCOUNTING_RECEIPT');};
 if(!Number.isFinite(cut)||keys.length>CREATOR_QUOTE_REQUEST_CAP||JSON.stringify([...keys].sort())!==JSON.stringify(Object.keys(r.rawArtifacts).sort())||JSON.stringify([...keys].sort())!==JSON.stringify(Object.keys(r.retrievedAt).sort())||Object.values(r.rawArtifacts).reduce((n,x)=>n+Buffer.byteLength(x),0)>CREATOR_QUOTE_BYTES)invalid();
 const read=(id:string,request:Request)=>{
  used.add(id);if(!keys.includes(id))throw new Error('CREATOR_QUOTE_NOT_COLLECTED');
  const at=Date.parse(r.retrievedAt[id]??'');if(JSON.stringify(r.requests[id])!==JSON.stringify(request)||!Number.isFinite(at)||at>cut||typeof r.rawArtifacts[id]!=='string'||Buffer.byteLength(r.rawArtifacts[id]!)>500000)invalid();
  let v:any;try{v=JSON.parse(r.rawArtifacts[id]!);}catch{return invalid();}
  if(!obj(v)||v.jsonrpc!=='2.0'||v.id!==1)invalid();if(v.error)throw new Error('CREATOR_QUOTE_SOURCE_UNAVAILABLE');if(!Object.hasOwn(v,'result'))invalid();return{value:v.result,at};
 };
 const records:any[]=[],unresolved:Array<{signature:string;code:string}>=[];let indexComplete=false,headSlot:number|null=null,indexed=0,canonicalHeadAtomic:string|null=null,closed=false;
 let code='CREATOR_QUOTE_NOT_COLLECTED';
 try{
  const g=read('genesis',genesis);if(g.value!==SOLANA_MAINNET_GENESIS)throw new Error('CREATOR_QUOTE_WRONG_CLUSTER');
  const head=read('head',headRequest(account)),hv=head.value;if(head.at<g.at||!integer(hv?.context?.slot))invalid();headSlot=hv.context.slot;
  if(hv.value!==null){const i=hv.value?.data?.parsed?.info;if(hv.value.owner!==b.creation.tokenProgram||i?.mint!==token.address||i?.owner!==b.wallet)throw new Error('CREATOR_QUOTE_HEAD');canonicalHeadAtomic=String(n(i.tokenAmount?.amount));}
  const index=read('index',indexRequest(account,headSlot!)),rows=index.value;if(index.at<head.at)invalid();
  if(!Array.isArray(rows)||rows.length>1000)throw new Error('CREATOR_QUOTE_INDEX');indexed=rows.length;
  const seen=new Set<string>();let prior=Infinity,priorTime=Infinity;
  for(const row of rows){if(!obj(row)||!sig(row.signature)||seen.has(row.signature)||!integer(row.slot)||row.slot>prior||row.slot>headSlot!||!integer(row.blockTime)||row.blockTime>priorTime||row.blockTime*1000>index.at||row.confirmationStatus!=='finalized'||!('err'in row)||row.err!==null&&!obj(row.err))throw new Error('CREATOR_QUOTE_INDEX');seen.add(row.signature);prior=row.slot;priorTime=row.blockTime;}
  if(rows.length===1000)throw new Error('CREATOR_QUOTE_INDEX_CAP');if(rows.some(x=>x.slot<b.creation.slot))throw new Error('CREATOR_QUOTE_PRIOR_INCARNATION');
  indexComplete=true;const successful=rows.filter(x=>x.err===null);if(successful.length>CREATOR_QUOTE_TRANSACTION_CAP)throw new Error('CREATOR_QUOTE_TRANSACTION_CAP');
  for(const [i,row]of successful.entries()){
   let tx:{value:any;at:number};try{tx=read(`transaction-${i}`,creatorRoleTransactionRequest(row.signature));if(tx.at<row.blockTime*1000||!recoverCommitted&&tx.at<index.at)invalid();if(tx.value?.slot!==row.slot||tx.value?.blockTime!==row.blockTime||tx.value?.transaction?.signatures?.[0]!==row.signature||tx.value?.meta?.err!==null)throw new Error('CREATOR_QUOTE_TRANSACTION_BINDING');}catch(error){if(error instanceof Error&&error.message==='ADVISORY_CREATOR_ACCOUNTING_RECEIPT')throw error;unresolved.push({signature:row.signature,code:error instanceof Error?error.message:'CREATOR_QUOTE_SOURCE_UNRESOLVED'});continue;}
   try{records.push(decodeCreatorQuoteTrade(tx.value,role,recoverCommitted));}catch(error){
    // A closed zero account is retained as lifecycle evidence only with an executed, explicitly bound close.
    let isClose=false;try{const x=tx.value,keys=x.transaction.message.accountKeys,ai=keys.findIndex((k:any)=>k.pubkey===account),pre=x.meta.preTokenBalances?.find((v:any)=>v.accountIndex===ai),post=x.meta.postTokenBalances?.find((v:any)=>v.accountIndex===ai);isClose=pre?.mint===token.address&&pre?.owner===b.wallet&&pre?.uiTokenAmount?.amount==='0'&&!post&&x.meta.postBalances?.[ai]===0&&(recoverCommitted?(()=>{const touch=executedWindowInstructions(x).filter(s=>s.executed&&PROGRAMS.has(s.ix.programId)&&([s.ix.parsed?.info?.account,s.ix.parsed?.info?.source,s.ix.parsed?.info?.destination].includes(account)||s.ix.accounts?.includes(account)));return touch.length===1&&touch[0]!.ix.programId===b.creation.tokenProgram&&touch[0]!.ix.parsed?.type==='closeAccount'&&touch[0]!.ix.parsed.info?.account===account&&touch[0]!.ix.parsed.info?.owner===b.wallet;})():executedWindowInstructions(x).some(s=>s.executed&&s.ix.programId===b.creation.tokenProgram&&s.ix.parsed?.type==='closeAccount'&&s.ix.parsed.info?.account===account&&s.ix.parsed.info?.owner===b.wallet));if(isClose&&hv.value===null&&i===0)closed=true;}catch{/* unresolved remains explicit */}
    if(!isClose)unresolved.push({signature:row.signature,code:error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'CREATOR_QUOTE_DECODE_UNRESOLVED'});
   }
  }
  code=unresolved.length?'CREATOR_QUOTE_EXECUTION_INCOMPLETE':'CREATOR_QUOTE_CANONICAL_LEDGER_OBSERVED';
 }catch(error){if(error instanceof Error&&error.message==='ADVISORY_CREATOR_ACCOUNTING_RECEIPT')throw error;code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'CREATOR_QUOTE_SOURCE_UNRESOLVED';}
 if(keys.some(k=>!used.has(k)))invalid();
 let continuity:{complete:boolean;reasonCode:string;openingAtomic:string|null;closingAtomic:string|null}|undefined;
 if(recoverCommitted){
  const ordered=[...records].sort((a,b)=>a.slot-b.slot),opening=ordered[0]?.base.preAtomic??null,closing=ordered.at(-1)?.base.postAtomic??null;
  const complete=indexComplete&&unresolved.length===0&&opening==='0'&&closing===(canonicalHeadAtomic??(closed?'0':null))&&ordered.every((entry,i)=>i===0||entry.slot>ordered[i-1]!.slot&&entry.base.preAtomic===ordered[i-1]!.base.postAtomic);
  continuity={complete,reasonCode:complete?'CREATOR_QUOTE_CONTINUITY_OBSERVED':'CREATOR_QUOTE_CONTINUITY_UNRESOLVED',openingAtomic:opening,closingAtomic:closing};
  if(indexComplete&&unresolved.length===0&&!complete){unresolved.push({signature:b.creation.signature,code:continuity.reasonCode});code=continuity.reasonCode;}
 }
 const assets=new Map<string,{mint:string;decimals:number;verifiedBuys:number;verifiedSells:number;entryAtomic:bigint;proceedsAtomic:bigint;holderRewardsAtomic:bigint}>();
 for(const e of records){let a=assets.get(e.quote.mint);if(a&&a.decimals!==e.quote.decimals)invalid();if(!a){a={mint:e.quote.mint,decimals:e.quote.decimals,verifiedBuys:0,verifiedSells:0,entryAtomic:0n,proceedsAtomic:0n,holderRewardsAtomic:0n};assets.set(e.quote.mint,a);}if(e.side==='BUY'){a.verifiedBuys++;a.entryAtomic+=BigInt(e.quote.userAtomic);}else{a.verifiedSells++;a.proceedsAtomic+=BigInt(e.quote.userAtomic);}a.holderRewardsAtomic+=BigInt(e.fees.holderRewardAtomic);}
 return{method:'creator-canonical-native-quote-accounting-v1',token,wallet:b.wallet,account,cutoff,scope:'CANONICAL_TARGET_ACCOUNT_ONLY',completeCreatorPerformance:false,reasonCode:code,
  ...(continuity?{canonicalContinuity:continuity}:{}),coverage:{indexComplete,indexedReferences:indexed,headSlot,canonicalHeadAtomic:canonicalHeadAtomic??(closed?'0':null),closedZeroAccount:closed,verifiedTrades:records.length,unresolved,wholeWalletComplete:false,failedNetworkFeesComplete:false},
  assets:[...assets.values()].map(a=>({...a,entryAtomic:String(a.entryAtomic),proceedsAtomic:String(a.proceedsAtomic),holderRewardsAtomic:String(a.holderRewardsAtomic),totalsBasis:'VERIFIED_RECORDS_ONLY_NOT_COMPLETE_POSITION',realizedResultAtomic:null,solConversion:null})),records,
  networkFees:{asset:'SOL',unit:'lamports',verifiedTradeDirectLamports:String(records.reduce((s,e)=>s+BigInt(e.networkFee.directCreatorCharged),0n)),complete:false,subtractedFromQuote:false},
  limitations:['Canonical account receipts do not exclude historical other creator accounts or establish complete creator performance.','Quote units are native atomic amounts; SOL network fees are separate. No historical FX or combined profit is inferred.','Holder rewards duplicate the creator fee field; they are counted once as trader cost, never added as creator income or inferred as received distributions.','Incomplete runtime traces remain unresolved even when token balances suggest a trade. Accrued creator fees are state, not extra trade cost or realized reward income.']};
}

export async function collectCreatorQuoteAccounting(token:TokenRef,roleReceipts:CreatorRoleReceipts,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal,reuseRole=false):Promise<CreatorQuoteReceipts|null>{
 const role=decodeCreatorRole(token,roleReceipts,now(),true,true,true);if(!role.binding||!role.binding.creation.quoteMint||role.binding.creation.quoteMint===WSOL)return null;
 const {account}=scope(role),r:CreatorQuoteReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 let reserved=0;
 const run=async(id:string,request:Request)=>{if(signal?.aborted||Object.keys(r.requests).length>=CREATOR_QUOTE_REQUEST_CAP)return;const available=CREATOR_QUOTE_BYTES-Object.values(r.rawArtifacts).reduce((n,v)=>n+Buffer.byteLength(v),0)-reserved-128;if(available<128)return;const bytes=Math.min(500000,available);reserved+=bytes+128;r.requests[id]=request;
  try{const shared=reuseRole&&request.method==='getTransaction'?Object.keys(roleReceipts.requests).find(k=>JSON.stringify(roleReceipts.requests[k])===JSON.stringify(request)&&(()=>{try{return JSON.parse(roleReceipts.rawArtifacts[k]!).result!=null;}catch{return false;}})()):undefined;if(shared){if(Buffer.byteLength(roleReceipts.rawArtifacts[shared]!)>bytes){r.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'RPC_STORAGE_CAP'}});r.retrievedAt[id]=now();}else{r.rawArtifacts[id]=roleReceipts.rawArtifacts[shared]!;r.retrievedAt[id]=roleReceipts.retrievedAt[shared]!;}}else await solanaRpc(rpcUrl,request.method,request.params,fetcher,bytes,signal,raw=>{r.rawArtifacts[id]=raw;r.retrievedAt[id]=now();});}catch(e){if(!Object.hasOwn(r.rawArtifacts,id)){r.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(e)}});r.retrievedAt[id]=now();}}finally{reserved-=bytes+128;}};
 try{
  await run('genesis',genesis);if(JSON.parse(r.rawArtifacts.genesis!).result!==SOLANA_MAINNET_GENESIS)return r;
  await run('head',headRequest(account));const slot=JSON.parse(r.rawArtifacts.head!).result?.context?.slot;if(!integer(slot))return r;
  await run('index',indexRequest(account,slot));const rows=JSON.parse(r.rawArtifacts.index!).result;if(!Array.isArray(rows)||rows.length>=1000)return r;const selected=rows.filter(x=>x.err===null);if(selected.length>CREATOR_QUOTE_TRANSACTION_CAP)return r;const preflight=decodeCreatorQuoteAccounting(token,role,r,now());if(!preflight.coverage.indexComplete||preflight.reasonCode!=='CREATOR_QUOTE_EXECUTION_INCOMPLETE')return r;
  for(let i=0;i<selected.length&&!signal?.aborted;i+=2)await Promise.all(selected.slice(i,i+2).map((row,j)=>run(`transaction-${i+j}`,creatorRoleTransactionRequest(row.signature))));
 }catch{/* exact retained prefix is replayed as incomplete */}
 return r;
}
