import {createHash} from 'node:crypto';
import {Decimal} from 'decimal.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodeSolanaAddress,TOKEN_2022_PROGRAM} from './solana.js';
import {accountTokenView,executedWindowInstructions,recordedWindowInstructions} from './advisory-window-accounts.js';
import {walletTouchAbsence,creatorInventoryTokenAccount,type CreatorRole} from './advisory-creator-inventory.js';
import {visitO24BulkSources,type O24BulkReceipts} from './advisory-creator-inventory-bulk.js';
import {decodeO25LifetimeFlows,type O25LifetimeFlow,type O25PoolContext} from './advisory-creator-lifetime-flows.js';

export const CREATOR_BULK_LIFETIME_METHOD='creator-lifetime-full-vector-empty-held-v2' as const;
const HOUR=3_600_000,SAMPLE=64,U64=18446744073709551615n;
const AGE=[['LT_1H',0,3600],['1H_6H',3600,21600],['6H_24H',21600,86400],['1D_7D',86400,604800],['GE_7D',604800,null]] as const;
const COST=[['LT_100',0,100],['100_1K',100,1000],['1K_10K',1000,10000],['10K_100K',10000,100000],['GE_100K',100000,null]] as const;
const IN=new Set(['PURCHASE','CROSS_ASSET_EXCHANGE','CREATOR_FEE','HOLDER_DISTRIBUTION']),OUT=new Set(['SALE','PLAIN_TRANSFER']);
function fail(code:string):never{throw Error(code);}
const codeOf=(error:unknown)=>error instanceof Error&&/^(O25_[A-Z0-9_]+|CREATOR_[A-Z0-9_]+|ADVISORY_ACCOUNTS_[A-Z0-9_]+)$/.test(error.message)?error.message:'O25_LIFETIME_SEMANTIC_UNRESOLVED';
type View={signature:string;slot:number;transactionIndex:number;at:string;pre:bigint;post:bigint;decimals:number;lifecycle:string[];flows:O25LifetimeFlow[]};
/** The single creation recovery uses the existing positive PURCHASE binding and only its already closed initialization prefix. */
function creationView(tx:any,role:CreatorRole,account:string,flows:O25LifetimeFlow[]){
 if(tx.transaction.signatures[0]!==role.creationSignature||tx.slot!==role.creationSlot||flows.length!==1||flows[0]!.kind!=='PURCHASE'||flows[0]!.direction!=='IN')fail('O25_CREATION_RECOVERY_SCOPE');
 const logs=tx.meta.logMessages;let tops=0;const end=logs.findIndex((line:string)=>/^Program [1-9A-HJ-NP-Za-km-z]+ invoke \[1\]$/.test(line)&&++tops===3);if(end<0)fail('O25_CREATION_PREFIX_UNRESOLVED');
 const prefix={...tx,transaction:{...tx.transaction,message:{...tx.transaction.message,instructions:tx.transaction.message.instructions.slice(0,2)}},meta:{...tx.meta,innerInstructions:tx.meta.innerInstructions.filter((g:any)=>g.index<2),logMessages:logs.slice(0,end)}};
 const steps=executedWindowInstructions(prefix),initialized=steps.filter(s=>s.executed&&s.ix.programId===TOKEN_2022_PROGRAM&&s.ix.parsed?.type==='initializeAccount3'&&s.ix.parsed.info?.account===account&&s.ix.parsed.info.mint===role.mint&&s.ix.parsed.info.owner===role.wallet);
 const n=tx.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===account),pre=tx.meta.preTokenBalances.filter((b:any)=>b.accountIndex===n),post=tx.meta.postTokenBalances.filter((b:any)=>b.accountIndex===n);
 if(n<0||tx.meta.preBalances[n]!==0||pre.length||post.length!==1||initialized.length!==1||flows[0]!.order<steps.length||BigInt(post[0].uiTokenAmount.amount)!==flows[0]!.amountAtomic)fail('O25_CREATION_BALANCE_UNPROVEN');
 return{pre:0n,post:flows[0]!.amountAtomic,lifecycle:['INITIALIZED'],legs:[{order:flows[0]!.order,kind:'TRANSFER_IN',amountAtomic:String(flows[0]!.amountAtomic)}]};
}
function costBasis(flow:O25LifetimeFlow){
 if(flow.kind==='CREATOR_FEE'||flow.kind==='HOLDER_DISTRIBUTION')return{kind:'UNKNOWN_INCOME_BASIS' as const,counterasset:null};
 const q=flow.counterasset;if(!q)fail('O25_COUNTERASSET_UNRESOLVED');
 return{kind:'NATIVE_COUNTERASSET' as const,counterasset:{mint:q.mint,program:q.program,decimals:q.decimals,amountAtomic:String(q.amountAtomic)}};
}
const flowView=(f:O25LifetimeFlow)=>({...f,amountAtomic:String(f.amountAtomic),counterasset:f.counterasset?{...f.counterasset,amountAtomic:String(f.counterasset.amountAtomic)}:null});
/** A complete lifetime vector for a proven empty held population, with no historical FX or closed-lot PnL inference. */
export function deriveO25BulkLifetime(receipts:O24BulkReceipts,poolContext:O25PoolContext,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const gaps:Array<{signature:string;code:string}>=[],gapHash=createHash('sha256'),walletHash=createHash('sha256'),views=new Map<string,View>();let gapCount=0,inspected=0;
 const add=(signature:string,code:string)=>{gapCount++;gapHash.update(JSON.stringify([signature,code]));if(gaps.length<SAMPLE)gaps.push({signature,code});};
 const context=visitO24BulkSources(receipts,cutoff,(tx,indexed,at,source)=>{
  const role:CreatorRole={wallet:source.role.wallet,mint:receipts.token.address,creationSignature:source.role.creation.signature,creationSlot:source.role.creation.slot};inspected++;
  try{const reason=walletTouchAbsence(tx,role,source.canonicalAccount);walletHash.update(JSON.stringify([indexed.signature,reason]));if(reason)add(indexed.signature,reason);}catch(error){const code=codeOf(error);walletHash.update(JSON.stringify([indexed.signature,code]));add(indexed.signature,code);}
  const r=source.canonicalRows.find(r=>r.signature===indexed.signature),referencesCanonical=tx.transaction.message.accountKeys.some((k:any)=>k.pubkey===source.canonicalAccount);
  // The complete wallet census is an independent reverse-membership witness:
  // a balanced canonical receipt/disposal must not disappear with an omitted index row.
  if(referencesCanonical&&(!r||r.err!==null)){add(indexed.signature,'O25_CANONICAL_INDEX_MEMBERSHIP');return;}
  if(!r||r.err!==null)return;
  try{
   if(r.slot!==indexed.slot||r.blockTime!==indexed.blockTime||r.transactionIndex!==null&&r.transactionIndex!==tx.transactionIndex)fail('O25_CANONICAL_INDEX_BINDING');
   const flows=decodeO25LifetimeFlows(tx,source.role,source.canonicalAccount,at,poolContext),position=tx.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===source.canonicalAccount),rawBalances=[...tx.meta.preTokenBalances,...tx.meta.postTokenBalances].filter((b:any)=>b.accountIndex===position);
   if(position<0||!rawBalances.length||rawBalances.some((b:any)=>b.mint!==role.mint||b.owner!==role.wallet||b.programId!==TOKEN_2022_PROGRAM||!Number.isSafeInteger(b.uiTokenAmount?.decimals)||b.uiTokenAmount.decimals<0||b.uiTokenAmount.decimals>255)||new Set(rawBalances.map((b:any)=>b.uiTokenAmount.decimals)).size!==1)fail('O25_CANONICAL_BALANCE_OWNER');
   let v:ReturnType<typeof accountTokenView>|ReturnType<typeof creationView>;
   try{v=accountTokenView(tx,source.canonicalAccount,role.mint,'',[]);}catch(error){if(indexed.signature!==role.creationSignature)throw error;v=creationView(tx,role,source.canonicalAccount,flows);}
   if(v.pre===null||v.post===null)fail('O25_CANONICAL_BALANCE_UNPROVEN');
   const raw=recordedWindowInstructions(tx),seen=new Set<string>();let previous=-1;
   for(const f of flows){
    const ix=raw[f.order],kind=f.direction==='IN'?IN:OUT;
    if(f.signature!==indexed.signature||f.slot!==indexed.slot||f.at!==new Date(indexed.blockTime*1000).toISOString()||!Number.isSafeInteger(f.order)||f.order<=previous||f.order>=raw.length||f.top!==ix?.top||f.rawLegId!==`${indexed.signature}:${f.order}`||seen.has(f.rawLegId)||!['IN','OUT'].includes(f.direction)||!kind.has(f.kind)||typeof f.amountAtomic!=='bigint'||f.amountAtomic<=0n||f.amountAtomic>U64)fail('O25_FLOW_BINDING');
    if(f.programTimestamp!==null&&(!/^(0|[1-9][0-9]{0,18})$/.test(f.programTimestamp)||!Number.isSafeInteger(Number(f.programTimestamp))||Number(f.programTimestamp)*1000>Date.parse(at)))fail('O25_FLOW_CLOCK');
    if(['PURCHASE','CROSS_ASSET_EXCHANGE','SALE'].includes(f.kind)&&!f.counterasset)fail('O25_COUNTERASSET_UNRESOLVED');
    if(['CREATOR_FEE','HOLDER_DISTRIBUTION','PLAIN_TRANSFER'].includes(f.kind)&&f.counterasset!==null)fail('O25_COUNTERASSET_UNRESOLVED');
    if(f.counterasset){const q=f.counterasset;decodeSolanaAddress(q.mint);decodeSolanaAddress(q.program);if(q.mint===role.mint||!Number.isSafeInteger(q.decimals)||q.decimals<0||q.decimals>255||typeof q.amountAtomic!=='bigint'||q.amountAtomic<0n||q.amountAtomic>U64)fail('O25_COUNTERASSET_UNRESOLVED');}
    seen.add(f.rawLegId);previous=f.order;
   }
   if(v.legs.length!==flows.length)fail('O25_CANONICAL_LEG_BIJECTION');
   for(const l of v.legs){const f=flows.find(f=>f.order===l.order);if(!f||!['TRANSFER_IN','TRANSFER_OUT'].includes(l.kind)||f.direction!==(l.kind==='TRANSFER_IN'?'IN':'OUT')||String(f.amountAtomic)!==l.amountAtomic)fail('O25_CANONICAL_LEG_BIJECTION');}
   const net=flows.reduce((n,f)=>n+(f.direction==='IN'?f.amountAtomic:-f.amountAtomic),0n);if(v.post-v.pre!==net)fail('O25_CANONICAL_QUANTITY_CONSERVATION');
   views.set(indexed.signature,{signature:indexed.signature,slot:indexed.slot,transactionIndex:tx.transactionIndex,at:new Date(indexed.blockTime*1000).toISOString(),pre:v.pre,post:v.post,decimals:rawBalances[0].uiTokenAmount.decimals,lifecycle:v.lifecycle,flows});
  }catch(error){add(indexed.signature,codeOf(error));}
 });
 const role:CreatorRole={wallet:context.role.wallet,mint:receipts.token.address,creationSignature:context.role.creation.signature,creationSlot:context.role.creation.slot},canonicalRows=context.canonicalRows.filter(r=>r.err===null),ordered=[...views.values()].sort((a,b)=>a.slot-b.slot||a.transactionIndex-b.transactionIndex),start=Date.parse(context.interval.start),end=Date.parse(context.interval.end);let first:string|null=null,headAtomic:bigint|null=null,continuityPairs=0;
 const reject=(reason:string)=>{first??=reason;};
 const ataIds=Object.keys(receipts.requests).filter(id=>/^ata-page-[0-9]+$/.test(id)).sort((a,b)=>Number(a.split('-').at(-1))-Number(b.split('-').at(-1))),lastAta=ataIds.at(-1),exhausted=lastAta?JSON.parse(receipts.rawArtifacts[lastAta]!).result.length<1000:false;
 if(!exhausted)reject('O25_ATA_LIFETIME_UNEXHAUSTED');
 if(context.canonicalRows.some(r=>r.slot<role.creationSlot)||canonicalRows.some(r=>!views.has(r.signature))||views.size!==canonicalRows.length)reject('O25_CANONICAL_LIFETIME_UNINSPECTED');
 if(inspected!==context.walletRows.filter(r=>r.err===null).length)reject('O25_WALLET_CENSUS');
 if(context.canonicalRows.some(r=>r.blockTime*1000>=start&&r.blockTime*1000<end))reject('O25_CURRENT_INTERVAL_REFERENCE');
 if(!ordered.length||ordered[0]!.signature!==role.creationSignature||ordered[0]!.pre!==0n||!ordered[0]!.lifecycle.includes('INITIALIZED'))reject('O25_CANONICAL_START_UNPROVEN');
 for(let i=1;i<ordered.length;i++){const a=ordered[i-1]!,b=ordered[i]!;continuityPairs++;if(a.post!==b.pre||b.slot===a.slot&&b.transactionIndex<=a.transactionIndex||Date.parse(b.at)<Date.parse(a.at)||b.decimals!==a.decimals)reject('O25_CANONICAL_CONTINUITY');}
 try{
  if(context.head?.context?.slot!==context.stateSlot||context.ownerCatalog?.context?.slot!==context.stateSlot||!Array.isArray(context.ownerCatalog.value)||poolContext.stateSlot<context.stateSlot)fail('O25_FIXED_STATE');
  if(context.head.value===null)headAtomic=0n;else{const v=creatorInventoryTokenAccount(context.head.value,role,'O25_HEAD');if(!v.immutable)fail('O25_HEAD');headAtomic=v.amount;}
  const seen=new Set<string>();let found=false;
  for(const e of context.ownerCatalog.value){if(!e||typeof e.pubkey!=='string'||seen.has(e.pubkey))fail('O25_CATALOG');decodeSolanaAddress(e.pubkey);seen.add(e.pubkey);const v=creatorInventoryTokenAccount(e.account,role,'O25_CATALOG');if(e.pubkey===context.canonicalAccount){if(found||context.head.value===null||!v.immutable||v.amount!==headAtomic)fail('O25_CATALOG_HEAD');found=true;}else if(v.amount!==0n)fail('O25_NON_CANONICAL_BALANCE');}
  if(found!==(context.head.value!==null)||!ordered.length||ordered.at(-1)!.post!==headAtomic)fail('O25_HEAD_CONTINUITY');if(headAtomic!==0n)fail('O25_EMPTY_HELD_REQUIRED');
 }catch(error){reject(codeOf(error));}
 if(gapCount)reject('O25_LIFETIME_FLOW_UNRESOLVED');
 const flows=ordered.flatMap(v=>v.flows),totals:Record<string,bigint>={PURCHASE:0n,CROSS_ASSET_EXCHANGE:0n,CREATOR_FEE:0n,HOLDER_DISTRIBUTION:0n,SALE:0n,PLAIN_TRANSFER:0n};
 type Lot={flow:O25LifetimeFlow;original:bigint;remaining:bigint};const lots:Lot[]=[],consumed:Array<Record<string,unknown>>=[];let incoming=0n,outgoing=0n;
 if(first===null)try{
  for(const f of flows){totals[f.kind]=totals[f.kind]!+f.amountAtomic;if(f.direction==='IN'){incoming+=f.amountAtomic;lots.push({flow:f,original:f.amountAtomic,remaining:f.amountAtomic});continue;}outgoing+=f.amountAtomic;let left=f.amountAtomic;
   while(left>0n){const l=lots[0];if(!l)fail('O25_DISPOSAL_EXCEEDS_LOTS');const take=l.remaining<left?l.remaining:left,basis=costBasis(l.flow),holdingSeconds=(Date.parse(f.at)-Date.parse(l.flow.at))/1000;if(holdingSeconds<0)fail('O25_FIFO_CLOCK');
    const allocation=basis.counterasset?{numeratorAtomicUnits:String(BigInt(basis.counterasset.amountAtomic)*take),denominatorUnitsAtomic:String(l.original),amountAtomic:new Decimal((BigInt(basis.counterasset.amountAtomic)*take).toString()).div(l.original.toString()).toFixed()}:null;
    consumed.push({acquiredSignature:l.flow.signature,acquiredRawLegId:l.flow.rawLegId,disposedSignature:f.signature,disposedRawLegId:f.rawLegId,disposition:f.kind,unitsAtomic:String(take),holdingSeconds,entryBasis:basis,entryCounterassetAllocation:allocation,disposalCounterasset:f.counterasset?{...f.counterasset,amountAtomic:String(f.counterasset.amountAtomic),allocationNumeratorAtomicUnits:String(f.counterasset.amountAtomic*take),allocationDenominatorUnitsAtomic:String(f.amountAtomic)}:null});
    l.remaining-=take;left-=take;if(l.remaining===0n)lots.shift();
   }
  }
  if(lots.length||incoming-outgoing!==headAtomic||headAtomic!==0n)fail('O25_EMPTY_HELD_REQUIRED');
 }catch(error){reject(codeOf(error));}
 const known=first===null,coverage={stateSlot:context.stateSlot,stateFloorSlot:context.stateFloorSlot,canonicalIndexReferences:context.canonicalRows.length,canonicalSuccessful:canonicalRows.length,canonicalIndexExhausted:exhausted,canonicalReceipts:ordered.length,continuityPairs,initializations:ordered.reduce((n,v)=>n+v.lifecycle.filter(x=>x==='INITIALIZED').length,0),closes:ordered.reduce((n,v)=>n+v.lifecycle.filter(x=>x==='CLOSED').length,0),walletReferences:context.walletRows.length,walletSuccessfulInspected:inspected,walletFailedReferences:context.walletRows.filter(r=>r.err!==null).length,typedLegs:flows.length,unresolvedEvents:gapCount,gaps,gapsComplete:gapCount<=SAMPLE,gapHash:gapHash.digest('hex'),walletResultHash:walletHash.digest('hex')};
 return{id:'O25',quality:known?'KNOWN':'MISSING',unit:'scoped-record',evidenceIds:[...new Set(evidenceIds)],reasonCode:known?'CREATOR_LIFETIME_FULL_VECTOR_OBSERVED':first!,data:{
  method:CREATOR_BULK_LIFETIME_METHOD,status:known?'COMPLETE':'UNRESOLVED',profile:'EMPTY_HELD',token:receipts.token,cohort:{kind:'CREATOR_ONLY',wallet:role.wallet,creationSignature:role.creationSignature,creationSlot:role.creationSlot,canonicalAccount:context.canonicalAccount,identity:null,control:null},interval:context.interval,coverage,
  ledger:known?flows.map(f=>({...flowView(f),...(f.direction==='IN'?{entryBasis:costBasis(f)}:{})})):null,
  flows:known?{acquiredAtomic:String(incoming),purchaseAtomic:String(totals.PURCHASE),crossAssetExchangeAtomic:String(totals.CROSS_ASSET_EXCHANGE),creatorFeeAtomic:String(totals.CREATOR_FEE),holderDistributionAtomic:String(totals.HOLDER_DISTRIBUTION),soldAtomic:String(totals.SALE),plainTransferOutAtomic:String(totals.PLAIN_TRANSFER),incomingAtomic:String(incoming),outgoingAtomic:String(outgoing),netAtomic:String(incoming-outgoing),transferInAtomic:'0',mintAtomic:'0',burnAtomic:'0'}:null,
  holdings:known?{heldAtomic:'0',openLots:0,unknownCostAtomic:'0',shareDenominator:'UNDEFINED_ZERO_HELD',ageBands:AGE.map(([band,fromSeconds,toSeconds])=>({band,fromSeconds,toSeconds,atomic:'0',shareOfHeld:null})),costBands:COST.map(([band,lamportsPerWholeTokenFrom,lamportsPerWholeTokenTo])=>({band,lamportsPerWholeTokenFrom,lamportsPerWholeTokenTo,atomic:'0',shareOfHeld:null}))}:null,
  realized:known?{definition:'target units disposed through verified sales / all target units acquired by this scoped wallet',denominatorComponents:['PURCHASE','CROSS_ASSET_EXCHANGE','CREATOR_FEE','HOLDER_DISTRIBUTION'],acquiredAtomic:String(incoming),disposedThroughSalesAtomic:String(totals.SALE),transferredOutAtomic:String(totals.PLAIN_TRANSFER),fraction:incoming>0n?new Decimal(totals.SALE!.toString()).div(incoming.toString()).toFixed():null,denominatorStatus:incoming>0n?'ALL_ACQUIRED_TARGET_ATOMIC':'UNDEFINED_ZERO_ACQUIRED'}:null,
  fifo:known?{method:'FORWARD_FIFO_TARGET_QUANTITIES',openLots:0,closedAcquisitionLots:flows.filter(f=>f.direction==='IN').length,consumptions:consumed}:null,
  currentSells:known?{interval:context.interval,sells:0,unitsAtomic:'0',coreQuoteAtomic:null,userQuoteAtomic:null,quoteStatus:'NOT_MEASURED_NO_INTERVAL_SELLS'}:null,
  heldCostBandQuote:{asset:'SOL',unit:'lamports',decimals:9,basis:'EMPTY_HELD_POPULATION_NO_FX_REQUIRED'},closedLotCosts:'NATIVE_TYPED_COUNTERASSETS_ONLY',incomeEntryBasis:'UNKNOWN_INCOME_BASIS',sourceTrust:'RETAINED_PROVIDER_RPC_IMPORT',
  sourceCoverage:{...context.counts,sourceBytes:context.sourceBytes,storedBytes:context.storedBytes,sourceHash:createHash('sha256').update(JSON.stringify(context.sourceHashes)).digest('hex'),receiptManifestHash:context.receiptManifestHash},
  limitations:['One verified signed-creation wallet and target mint, not a person or all controlled wallets.','The full lifetime quantity ledger and explicit acquisition components establish the realized denominator; transfers are excluded from its sales numerator.','Native counterasset amounts are not summed across assets or converted to SOL/USD. Fee and reward entry basis remains unknown, never zero cost.','Original SOL held-unit cost bands are empty because no held unit remains; no nonzero holding is classified without a cost proof.','Current sells are zero from complete absence of canonical references of any status in the fixed interval and whole-wallet other-account exclusion, not a net-balance inference.','No closed-lot PnL, creator performance/S15, probability of selling, related-party attribution or deployed binary/transport attestation.']}};
}
