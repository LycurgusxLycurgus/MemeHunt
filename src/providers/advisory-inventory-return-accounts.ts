import {Decimal} from 'decimal.js';
import {PUMP_AMM_PROGRAM_ID,pumpAmmJson} from '@pump-fun/pump-swap-sdk';
import {recordedWindowInstructions} from './advisory-window-accounts.js';
import {getInventoryReturnExecution} from './advisory-inventory-return-runtime.js';
import type {AdvisoryWindowHistory} from './advisory-window.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import type {InventoryReturnSourceContext,InventoryReturnPoolContext} from './advisory-inventory-returns-source.js';

const PUMP=PUMP_AMM_PROGRAM_ID.toBase58(),SYSTEM='11111111111111111111111111111111',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKENS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(code:string):never=>{throw Error('INVENTORY_RETURNS_'+code);};
const uint=(v:unknown):string=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,19})$/.test(v)||BigInt(v)>18446744073709551615n)fail('ATOMIC');return v as string;};
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
type NativeRecord={value:any;at:string};
type Custody='USER_TOKEN_ACCOUNT'|'PROTOCOL_VAULT';
export type InventoryReturnEndpointBinding={trade:number;account:string;user:string;signature:string;position:number;parentPosition:number;side:'BUY'|'SELL';baseAtomic:string;custody:Custody;custodian:string};
export type InventoryReturnBinding={accounts:string[];bindings:InventoryReturnEndpointBinding[];custody:Array<{account:string;kind:Custody;owner:string}>;vault:string;mint:string;baseProgram:string;baseDecimals:number};
const descendants=(list:ReturnType<typeof recordedWindowInstructions>,position:number)=>{let end=position+1;while(end<list.length&&list[end]!.top===list[position]!.top&&list[end]!.depth>list[position]!.depth)end++;return Array.from({length:end-position-1},(_,i)=>position+i+1);};
function rawFacts(value:any,account:string,mint:string){
 const keys=value.transaction?.message?.accountKeys;if(!Array.isArray(keys))fail('KEYS');const at=keys.findIndex((k:any)=>k?.pubkey===account);if(at<0)fail('ACCOUNT_ABSENT');
 const facts:any[]=[];for(const side of ['preTokenBalances','postTokenBalances']){const rows=value.meta?.[side];if(!Array.isArray(rows))fail('BALANCE_SHAPE');const own=rows.filter((r:any)=>r?.accountIndex===at);if(own.length>1)fail('BALANCE_SHAPE');for(const r of own){if(r.mint!==mint||!TOKENS.has(r.programId)||typeof r.owner!=='string'||!integer(r.uiTokenAmount?.decimals)||r.uiTokenAmount.decimals>255)fail('BALANCE_IDENTITY');uint(r.uiTokenAmount.amount);facts.push({side,...r});}}
 return facts;
}
/** Candidate identity is derived before storage admission. Execution remains a separate conjunctive proof. */
export function bindInventoryReturnEndpoints(window:AdvisoryWindowHistory,poolContext:InventoryReturnPoolContext,windowNativeRecords:Map<string,NativeRecord>):InventoryReturnBinding{
 const pool=poolContext.pool,mint=pool?.baseMint?.toBase58?.(),vault=pool?.poolBaseTokenAccount?.toBase58?.();
 if(!window.complete||!window.poolVerified||window.pool!==poolContext.poolKey||window.token.address!==mint||typeof vault!=='string'||window.quote?.mint!==poolContext.quote.mint||window.quote?.program!==poolContext.quote.program||window.quote?.decimals!==poolContext.quote.decimals)fail('WINDOW_BINDING');
 const bindings:InventoryReturnEndpointBinding[]=[],custody=new Map<string,{account:string;kind:Custody;owner:string}>(),used=new Set<string>(),programs=new Set<string>(),decimals=new Set<number>();
 window.trades.forEach((trade,tradeIndex)=>{
  const source=windowNativeRecords.get(trade.signature),value=source?.value;if(!value||value.slot!==trade.slot||new Date(value.blockTime*1000).toISOString()!==trade.at||value.transaction?.signatures?.[0]!==trade.signature||value.meta?.err!==null||!trade.quoteAccounting||trade.quoteAccounting.coreQuoteAtomic!==trade.quoteAtomic)fail('TRADE_SOURCE');uint(trade.baseAtomic);uint(trade.quoteAtomic);
  const list=recordedWindowInstructions(value),matches:Array<{position:number;parentPosition:number;account:string;kind:Custody;owner:string;program:string;decimals:number}>=[];
  for(const [parentPosition,parent]of list.entries()){
   const a=parent.ix.accounts;if(parent.ix.programId!==PUMP||!Array.isArray(a))continue;
   const route=trade.instructionName==='multi_hop_swap';
   if(route){if(a[0]!==trade.user||a.length<21||(a.length-16)%5!==0)continue;const selected=[];for(let h=16;h<a.length;h+=5)if(a[h+2]===window.pool&&a[h]===mint&&a[h+3]===vault&&a[h+1]===poolContext.quote.mint&&a[h+4]===pool.poolQuoteTokenAccount.toBase58())selected.push(h);if(selected.length!==1)continue;}
   else if(a[0]!==window.pool||a[1]!==trade.user||a[3]!==mint||a[4]!==poolContext.quote.mint||a[7]!==vault||a[8]!==pool.poolQuoteTokenAccount.toBase58()||a[16]!==PUMP)continue;
   for(const position of descendants(list,parentPosition)){
    const s=list[position]!,p=s.ix.parsed,i=p?.info;if(!TOKENS.has(s.ix.programId)||p?.type!=='transferChecked'||!object(i)||i.mint!==mint||i.tokenAmount?.amount!==trade.baseAtomic||!integer(i.tokenAmount.decimals))continue;
    const account=trade.side==='BUY'?i.destination:i.source;if(typeof account!=='string'||account===vault||account===SYSTEM||(trade.side==='BUY'?i.source:i.destination)!==vault)continue;
    const facts=rawFacts(value,account,mint),owners=new Set<string>(facts.map(f=>f.owner));let kind:Custody='USER_TOKEN_ACCOUNT',owner=trade.user;
    if(route){const roles:string[]=[];for(let h=16;h<a.length;h+=5)if(a[h+2]!==window.pool&&(a[h]===mint&&a[h+3]===account||a[h+1]===mint&&a[h+4]===account))roles.push(a[h+2]);if(roles.length!==1||owners.size!==1||!owners.has(roles[0]!))continue;owner=roles[0]!;kind='PROTOCOL_VAULT';}
    else{
     // The pinned v2 ABI removed the two legacy protocol-fee recipient roles: its base program is9; SDK legacy swaps declare their own ordered role (11).
     const baseProgramPosition=['buy_v2','buy_exact_quote_in_v2','sell_v2'].includes(trade.instructionName??'')?9:pumpAmmJson.instructions.find(d=>d.name===trade.instructionName)?.accounts.findIndex(r=>r.name==='base_token_program')??-1;
     if(a[5]!==account||!TOKENS.has(a[baseProgramPosition])||a[baseProgramPosition]!==s.ix.programId)continue;if(!facts.length){const initialization=list.filter(x=>x.ix.programId===s.ix.programId&&x.ix.parsed?.type==='initializeAccount3'&&x.ix.parsed.info?.account===account&&x.ix.parsed.info?.mint===mint&&x.ix.parsed.info?.owner===trade.user);if(initialization.length!==1)continue;}else if(owners.size!==1||!owners.has(trade.user))continue;}
    if(facts.some(f=>f.programId!==s.ix.programId||f.uiTokenAmount.decimals!==i.tokenAmount.decimals))continue;
    matches.push({position,parentPosition,account,kind,owner,program:s.ix.programId,decimals:i.tokenAmount.decimals});
   }
  }
  if(matches.length!==1)fail('ENDPOINT_BINDING');const m=matches[0]!,key=trade.signature+':'+m.position;if(used.has(key))fail('DUPLICATE_TRADE_LEG');used.add(key);programs.add(m.program);decimals.add(m.decimals);
  const prior=custody.get(m.account);if(prior&&(prior.kind!==m.kind||prior.owner!==m.owner))fail('CUSTODY_CONFLICT');custody.set(m.account,{account:m.account,kind:m.kind,owner:m.owner});bindings.push({trade:tradeIndex,account:m.account,user:trade.user,signature:trade.signature,position:m.position,parentPosition:m.parentPosition,side:trade.side,baseAtomic:trade.baseAtomic,custody:m.kind,custodian:m.owner});
 });
 if(!bindings.length||programs.size!==1||decimals.size!==1||custody.size>512)fail('POPULATION');
 return{accounts:[...custody.keys()].sort(),bindings,custody:[...custody.values()].sort((a,b)=>a.account.localeCompare(b.account)),vault,mint,baseProgram:[...programs][0]!,baseDecimals:[...decimals][0]!};
}

type Leg={signature:string;slot:number;transactionIndex:number;at:string;order:number;kind:'POOL_BUY'|'POOL_SELL'|'TRANSFER_IN'|'TRANSFER_OUT';amountAtomic:string;counterparty:string;trade:number|null};
type TransactionView={signature:string;slot:number;transactionIndex:number;at:string;preAtomic:string;postAtomic:string;lifecycle:string[];selfTransfers:Array<{order:number;amountAtomic:string}>;legs:Leg[]};
type AccountHistory={account:string;custody:Custody;owner:string;trades:number[];transactions:TransactionView[];legs:Leg[];startAtomic:string;endAtomic:string};
function accountView(value:any,account:string,bound:InventoryReturnBinding,execution:ReturnType<typeof getInventoryReturnExecution>):TransactionView{
 const facts=rawFacts(value,account,bound.mint),pre=facts.find(f=>f.side==='preTokenBalances'),post=facts.find(f=>f.side==='postTokenBalances'),role=bound.custody.find(c=>c.account===account)??fail('CUSTODY');
 if(facts.some(f=>f.programId!==bound.baseProgram||f.uiTokenAmount.decimals!==bound.baseDecimals||f.owner!==role.owner))fail('ACCOUNT_OWNER_OR_UNITS');
 let initialized:number|null=null,closed:number|null=null;const legs:Leg[]=[],selfTransfers:TransactionView['selfTransfers']=[],lifecycle:string[]=[];
 const signature=value.transaction.signatures[0],at=new Date(value.blockTime*1000).toISOString();
 for(const step of execution.list){
  if(!step.criticalAccounts.includes(account)||!step.executed)continue;const p=step.ix.parsed,i=p?.info,order=step.order;
  if(!object(i)||typeof p.type!=='string')fail('UNSUPPORTED_WRITER');
  if(step.ix.programId===ATA){if(!['create','createIdempotent'].includes(p.type)||i.account!==account||i.mint!==bound.mint||i.tokenProgram!==bound.baseProgram||i.wallet!==role.owner)fail('ATA_BINDING');continue;}
  if(step.ix.programId!==bound.baseProgram)fail('UNSUPPORTED_WRITER');
  if(p.type==='transferChecked'){
   if(i.source!==account&&i.destination!==account)fail('UNSUPPORTED_REFERENCE');if(i.mint!==bound.mint||i.tokenAmount?.decimals!==bound.baseDecimals)fail('TRANSFER_UNITS');const amount=uint(i.tokenAmount.amount);
   if(i.source===account&&i.destination===account){selfTransfers.push({order,amountAtomic:amount});continue;}
   const incoming=i.destination===account,counterparty=incoming?i.source:i.destination;if(typeof counterparty!=='string')fail('TRANSFER_SHAPE');const binding=bound.bindings.find(b=>b.signature===signature&&b.position===order&&b.account===account);
   if(counterparty===bound.vault&&!binding||binding&&(binding.baseAtomic!==amount||binding.side!==(incoming?'BUY':'SELL')))fail('UNBOUND_SELECTED_LEG');
   legs.push({signature,slot:value.slot,transactionIndex:value.transactionIndex,at,order,kind:binding?(incoming?'POOL_BUY':'POOL_SELL'):incoming?'TRANSFER_IN':'TRANSFER_OUT',amountAtomic:amount,counterparty,trade:binding?.trade??null});
  }else if(p.type==='initializeAccount3'){
   if(i.account!==account||i.mint!==bound.mint||i.owner!==role.owner||initialized!==null||closed!==null)fail('INITIALIZATION');initialized=order;lifecycle.push('INITIALIZED');
  }else if(p.type==='closeAccount'){
   if(i.account!==account||closed!==null)fail('CLOSE');closed=order;lifecycle.push('CLOSED');
  }else if(p.type==='initializeImmutableOwner'){if(i.account!==account)fail('IMMUTABLE_OWNER');}
  else fail('UNSUPPORTED_WRITER');
 }
 for(const step of execution.list){
  if(!step.lifecycleAccounts.includes(account)||!step.executed)continue;
  const i=step.ix.parsed?.info;if(step.ix.programId!==SYSTEM||step.ix.parsed?.type!=='createAccount'||!object(i)||i.newAccount!==account||i.owner!==bound.baseProgram||!integer(i.space)||i.space<165||initialized===null||pre||step.order>=initialized)fail('SYSTEM_LIFECYCLE');
  let parent=step.parent,withinAta=false;while(parent>=0){const ancestor=execution.list[parent]!;if(ancestor.ix.programId===ATA&&ancestor.ix.parsed?.info?.account===account)withinAta=true;parent=ancestor.parent;}if(!withinAta)fail('SYSTEM_LIFECYCLE');
 }
 const effectPositions=[...legs.map(l=>l.order),...selfTransfers.map(l=>l.order)],first=Math.min(Infinity,...effectPositions),last=Math.max(-1,...effectPositions);
 if(initialized!==null&&(pre||initialized>=first)||closed!==null&&(post||closed<=last)||initialized!==null&&closed!==null&&initialized>=closed)fail('LIFECYCLE');
 const before=pre?BigInt(pre.uiTokenAmount.amount):initialized!==null?0n:null,after=post?BigInt(post.uiTokenAmount.amount):closed!==null?0n:null;if(before===null||after===null)fail('STATE_ABSENT');
 let balance:bigint=before??fail('STATE_ABSENT');const observations=[...legs.map(l=>({order:l.order,delta:['POOL_BUY','TRANSFER_IN'].includes(l.kind)?BigInt(l.amountAtomic):-BigInt(l.amountAtomic),self:null as string|null})),...selfTransfers.map(l=>({order:l.order,delta:0n,self:l.amountAtomic}))].sort((a,b)=>a.order-b.order);
 for(const o of observations){if(o.self!==null&&balance<BigInt(o.self))fail('SELF_TRANSFER_BALANCE');balance+=o.delta;if(balance<0n||balance>18446744073709551615n)fail('INTERMEDIATE_BALANCE');}if(balance!==after)fail('QUANTITY');
 for(const b of bound.bindings.filter(b=>b.signature===signature&&b.account===account))if(!legs.some(l=>l.trade===b.trade))fail('TRADE_LEG_MISSING');
 return{signature,slot:value.slot,transactionIndex:value.transactionIndex,at,preAtomic:String(before),postAtomic:String(after),lifecycle,selfTransfers,legs};
}

type Motif={account:string;custody:Custody;start:string;end:string;signatures:string[];legs:number;transferLegs:number;poolBuyBaseAtomic:string;poolSellBaseAtomic:string;transferInBaseAtomic:string;transferOutBaseAtomic:string;grossQuoteAtomic:string;netQuoteAtomic:string;proof:Array<{signature:string;slot:number;order:number;kind:Leg['kind'];amountAtomic:string}>};
function statistics(accounts:AccountHistory[],window:AdvisoryWindowHistory){
 const motifs:Motif[]=[];let passThroughReturns=0,singleSidePoolReturns=0,transferOnlyReturns=0,openAccounts=0;
 const sum=(legs:Leg[],kind:Leg['kind'])=>String(legs.filter(l=>l.kind===kind).reduce((n,l)=>n+BigInt(l.amountAtomic),0n));
 for(const account of accounts){let level=0n,segment:Leg[]=[];for(const leg of account.legs){if(BigInt(leg.amountAtomic)===0n)continue;level+=(['POOL_BUY','TRANSFER_IN'].includes(leg.kind)?1n:-1n)*BigInt(leg.amountAtomic);segment.push(leg);if(level!==0n)continue;const legs=segment,buys=legs.filter(l=>l.kind==='POOL_BUY'),sells=legs.filter(l=>l.kind==='POOL_SELL');segment=[];if(!buys.length||!sells.length){passThroughReturns++;if(buys.length||sells.length)singleSidePoolReturns++;else transferOnlyReturns++;continue;}const quote=(l:Leg)=>BigInt(window.trades[l.trade!]!.quoteAtomic);motifs.push({account:account.account,custody:account.custody,start:legs[0]!.at,end:legs.at(-1)!.at,signatures:[...new Set(legs.map(l=>l.signature))],legs:legs.length,transferLegs:legs.filter(l=>l.trade===null).length,poolBuyBaseAtomic:sum(legs,'POOL_BUY'),poolSellBaseAtomic:sum(legs,'POOL_SELL'),transferInBaseAtomic:sum(legs,'TRANSFER_IN'),transferOutBaseAtomic:sum(legs,'TRANSFER_OUT'),grossQuoteAtomic:String([...buys,...sells].reduce((n,l)=>n+quote(l),0n)),netQuoteAtomic:String(sells.reduce((n,l)=>n+quote(l),0n)-buys.reduce((n,l)=>n+quote(l),0n)),proof:legs.map(l=>({signature:l.signature,slot:l.slot,order:l.order,kind:l.kind,amountAtomic:l.amountAtomic}))});}if(segment.length)openAccounts++;}
 const repeatedAccounts=[...new Set(motifs.map(m=>m.account))].filter(a=>motifs.filter(m=>m.account===a).length>=2).sort(),repeated=motifs.filter(m=>repeatedAccounts.includes(m.account)),gross=(ms:Motif[])=>String(ms.reduce((n,m)=>n+BigInt(m.grossQuoteAtomic),0n));
 return{motifCount:motifs.length,repeatedAccounts,repeatedMotifCount:repeated.length,passThroughReturns,singleSidePoolReturns,transferOnlyReturns,openAccounts,motifGrossQuoteAtomic:gross(motifs),repeatedMotifGrossQuoteAtomic:gross(repeated),motifs};
}
/** Whole-history consumer. Source acceptance is separate; no partial account can produce KNOWN. */
export function deriveO26InventoryReturns(source:InventoryReturnSourceContext,evidenceIds:string[]):AdvisoryMetric{
 const {window,poolContext}=source,base={id:'O26' as const,unit:'inventory-return motifs in a complete selected-pool hour',evidenceIds:[...new Set(evidenceIds)]},bound=source.bindings;
 try{
  const recomputed=bindInventoryReturnEndpoints(window,poolContext,source.windowNativeRecords);if(JSON.stringify(recomputed)!==JSON.stringify(bound))fail('BINDING_CACHE');
  const endpoints=new Set(bound.accounts),executions=new Map<string,ReturnType<typeof getInventoryReturnExecution>>(),histories:AccountHistory[]=[];
  for(const [signature,record]of source.transactions){const v=record.value,companion=source.companions.get(signature);executions.set(signature,getInventoryReturnExecution(v,companion?.value,{expected:{signature,slot:v.slot,blockTime:v.blockTime,transactionIndex:v.transactionIndex},nativeSourceAt:record.at,compiledSourceAt:companion?.at,cutoff:source.cutoff,endpoints}));}
  let pairs=0,contexts=0,initializations=0,closes=0,selfTransfers=0;const usedTrades=new Set<number>();
  for(const account of bound.accounts){const role=bound.custody.find(c=>c.account===account)!,rows=source.indexes.get(account)??fail('INDEX_MISSING'),views:TransactionView[]=[];
   for(const row of rows){if(row.err!==null)continue;const record=source.transactions.get(row.signature)??fail('BODY_MISSING');const v=record.value;if(v.slot!==row.slot||v.blockTime!==row.blockTime||v.transactionIndex!==row.transactionIndex||v.meta?.err!==null)fail('ROW_BINDING');views.push(accountView(v,account,bound,executions.get(row.signature)??fail('EXECUTION_MISSING')));contexts++;}
   views.sort((a,b)=>a.slot-b.slot||a.transactionIndex-b.transactionIndex);if(!views.length)fail('EMPTY_ACCOUNT');for(let i=1;i<views.length;i++){const a=views[i-1]!,b=views[i]!;if(a.slot===b.slot&&a.transactionIndex>=b.transactionIndex)fail('ORDER');if(a.postAtomic!==b.preAtomic)fail('CONTINUITY');pairs++;}
   const legs=views.flatMap(v=>v.legs);for(const l of legs)if(l.trade!==null){if(usedTrades.has(l.trade))fail('TRADE_DUPLICATE');usedTrades.add(l.trade);}for(const v of views){initializations+=v.lifecycle.filter(l=>l==='INITIALIZED').length;closes+=v.lifecycle.filter(l=>l==='CLOSED').length;selfTransfers+=v.selfTransfers.length;}
   histories.push({account,custody:role.kind,owner:role.owner,trades:bound.bindings.filter(b=>b.account===account).map(b=>b.trade),transactions:views,legs,startAtomic:views[0]!.preAtomic,endAtomic:views.at(-1)!.postAtomic});
  }
  if(usedTrades.size!==window.trades.length)fail('TRADE_COVERAGE');const stats=statistics(histories,window),covered=String(window.trades.reduce((n,t)=>n+BigInt(t.quoteAtomic),0n));
  const custodySplit=Object.fromEntries((['USER_TOKEN_ACCOUNT','PROTOCOL_VAULT']as const).map(kind=>{const accounts=histories.filter(a=>a.custody===kind),s=statistics(accounts,window),trades=bound.bindings.filter(b=>b.custody===kind),volume=String(trades.reduce((n,b)=>n+BigInt(window.trades[b.trade]!.quoteAtomic),0n));return[kind,{population:accounts.length,selectedTrades:trades.length,coveredTradeGrossQuoteAtomic:volume,...s,motifQuoteShare:BigInt(volume)>0n?new Decimal(s.motifGrossQuoteAtomic).div(volume).toFixed():null}];}));
  return{...base,quality:'KNOWN',reasonCode:'SELECTED_WINDOW_INVENTORY_RETURNS_OBSERVED',data:{method:'selected-window-inventory-return-v3',scope:'VERIFIED_SELECTED_POOL_HOUR_ALL_OBSERVED_BASE_COUNTERPARTY_ENDPOINTS',pool:window.pool,window:window.window,anchorSlot:window.anchorSlot,segmentRule:'Per token account, a segment closes at every exact return to its starting balance; a motif is a closed segment containing at least one selected-pool buy leg and one selected-pool sell leg.',population:histories.length,coveredAccounts:histories.length,complete:true,...stats,quoteMint:poolContext.quote.mint,quoteDecimals:poolContext.quote.decimals,quoteBasis:'fee-exclusive core quote of all decoded selected-window trades',coveredTradeGrossQuoteAtomic:covered,motifQuoteShare:BigInt(covered)>0n?new Decimal(stats.motifGrossQuoteAtomic).div(covered).toFixed():null,custodySplit,accounts:histories,sourceCoverage:{...source.summary,quantityContexts:contexts,continuityPairs:pairs,initializations,closes,selfTransfers,selectedTrades:usedTrades.size},sourceTrust:'LOCAL_RETAINED_RPC_CONTAINER',sourceAuthentication:'Hashes bind retained bytes, not provider authentication or independent onchain attestation.',alternatives:['Arbitrage routing, market making or legitimate inventory rebalancing can produce the same motif.','Routers and shared pools do not establish common ownership.'],limitations:['Only the declared selected-pool hour and derived base-token endpoints are covered; endpoints are not people and owners are not aggregated.','Motifs crossing the window boundaries or linking several accounts are not detected; this is not a whole-token or whole-wallet wash-trading estimate.','Protocol vault custody remains explicit; all selected routed trades remain in the population and quote denominator.']}};
 }catch(error){return{...base,quality:'MISSING',reasonCode:error instanceof Error&&/^(INVENTORY_RETURNS_|O26_)/.test(error.message)?error.message:'INVENTORY_RETURNS_ACCOUNT_UNRESOLVED',data:{method:'selected-window-inventory-return-v3',complete:false,scope:'VERIFIED_SELECTED_POOL_HOUR_ALL_OBSERVED_BASE_COUNTERPARTY_ENDPOINTS',sourceTrust:'LOCAL_RETAINED_RPC_CONTAINER'}};}
}
