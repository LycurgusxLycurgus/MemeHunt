import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { creatorPageRequest, creatorTransactionRequest, decodeCreatorInventory, type CreatorInventoryReceipts, type CreatorReuse, type CreatorRole, type CreatorTape } from './advisory-creator-inventory.js';
import { CREATOR_LIFETIME_METHOD, deriveO25CreatorLifetime } from './advisory-creator-lifetime.js';
import { CREATOR_FAILED_FEES_METHOD, FAILED_FEE_RECEIPT_CAP, classifyCreatorFailedFees, type FailedFeeReceipt, type FailedIndexRow } from './advisory-creator-failed-fees.js';

/** S15 for the S13 creation signer (CREATOR_ONLY): realized target-mint position performance in SOL lamports, recomputed from O25's ledger over O24's raw receipts, with every successful and failed direct network fee and each trade-fee component reported beside it, never netted into a PnL. */
export const CREATOR_PERFORMANCE_METHOD='creator-only-target-position-performance-v1' as const;
const TX='creator-tx-',SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/,LAMPORTS=/^(0|[1-9]\d{0,29})$/;
const LIMITATIONS=[
 'Cohort is the S13 signed creation key recomputed through O24 and O25 (CREATOR_ONLY); it is not a person, team or every wallet the creator may control, and no whole-wallet or other-asset result is implied.',
 'Position is the target mint in SOL lamports under O25 FIFO lots: gross entry cost is the creator-borne Pump quote of each buy (core plus protocol, buyback and creator fees) and proceeds are the creator-received quote of each sell (core minus those fees); trade fees are components already inside these quotes and are never subtracted again.',
 'A creator fee paid into the creator own vault stays flagged inside gross cost; its later claim is neither valued nor netted.',
 'Direct network fees are reported separately: successful creator-paid target-referencing transactions (each must be a ledger trade) and the creator-charged overhead of indexed failed transactions referencing the creator key, classified over the complete failed index; neither is combined with the quote result.',
 'Failed rows are failed transactions in the creator-key index, not creator-initiated attempts or creator actions: each row shows its fee payer, whether the creator signed and whether it references the target, and counts are transactions, not participants. The classifier method name creator-failed-attempt-fees-v1 is a technical identifier and establishes no intent.',
 'Account-funding deposits are reported separately and are not a trading cost; target transfers, mints and burns must be zero.',
 'A record exists only when nothing is held at the head: the unrealized part is then zero without any mark; held units leave the whole record unresolved because no held valuation is supported.',
 'One creator and one token: an observed single-actor record, not a sample statistic, forecast or strategy.',
 'Wallet and canonical-account index completeness is a provider property pinned to finalized context slots, not a cryptographic archive; a creator-paid transaction lists the creator wallet and is therefore expected in its index.',
];
const OUTSIDE_SCOPE=['WHOLE_WALLET_AND_OTHER_ASSETS','THIRD_PARTY_CREATOR_FEE_INCOME','CREATOR_FEE_CLAIM_VALUATION','USD_VALUATION','AGGREGATE_NET_PNL','CURRENT_HUMAN_STRATEGY_OR_INTENT','CALL_OR_SOCIAL_ASSOCIATION'];

type Quality=AdvisoryMetric['quality'];
type Request={method:string;params:unknown[]};
export type CreatorPosition={buys:number;sells:number;acquiredAtomic:bigint;disposedAtomic:bigint;grossEntryCost:bigint;proceeds:bigint;protocolFee:{buy:bigint;sell:bigint};buybackFee:{buy:bigint;sell:bigint};creatorFee:{ownVault:bigint;otherVault:bigint};
 networkFee:bigint;deposits:bigint;fees:Map<string,bigint>;lots:Array<{acquiredSignature:string;disposedSignature:string;unitsAtomic:string;holdingSeconds:number;entryCostLamports:string}>};
export type CreatorPerformanceScope={account:string;targets:string[];headSlot:number;catalogSlot:number;failedRows:FailedIndexRow[];successfulTargetFees:Array<{signature:string;feeLamports:string}>;position:CreatorPosition;lifetime:AdvisoryMetric};
export type CreatorPerformanceGate={ready:true;scope:CreatorPerformanceScope}|{ready:false;quality:Quality;code:string;lifetime:AdvisoryMetric};

class Unready extends Error{constructor(readonly quality:Quality,code:string){super(code);}}
function fail(code:string):never{throw new Error(code);}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;

/** Pure check of an O25 data vector: zero held, zero transfers and exact quote identities, or an unresolved code; no mark or forecast is ever substituted. */
export function creatorPositionPerformance(lifetime:unknown):{ok:true;position:CreatorPosition}|{ok:false;quality:Quality;code:string}{
 const d=lifetime as any,bad=(code:string)=>({ok:false as const,quality:'MISSING' as Quality,code});
 if(!object(d)||!Array.isArray(d.ledger)||!object(d.holdings)||!object(d.realized)||!Array.isArray(d.realized.disposedLots)||!object(d.flows))return bad('S15_LIFETIME_SHAPE');
 if(['transferInAtomic','transferOutAtomic','mintAtomic','burnAtomic'].some(k=>d.flows[k]!=='0'))return bad('S15_TARGET_TRANSFER_UNSUPPORTED');
 // Without a supported mark any held units leave the unrealized part unknown, so no performance is reported at all.
 if(d.holdings.heldAtomic!=='0')return bad('S15_HELD_VALUATION_UNSUPPORTED');
 const n=(v:unknown)=>{if(typeof v!=='string'||!LAMPORTS.test(v))throw new Unready('MISSING','S15_LEDGER_ARITHMETIC');return BigInt(v);};
 try{
  const p:CreatorPosition={buys:0,sells:0,acquiredAtomic:0n,disposedAtomic:0n,grossEntryCost:0n,proceeds:0n,protocolFee:{buy:0n,sell:0n},buybackFee:{buy:0n,sell:0n},creatorFee:{ownVault:0n,otherVault:0n},networkFee:0n,deposits:0n,fees:new Map(),lots:[]};
  for(const e of d.ledger){
   if(!object(e)||typeof e.signature!=='string'||p.fees.has(e.signature)||e.side!=='BUY'&&e.side!=='SELL'||typeof e.creatorFeeToOwnVault!=='boolean')throw new Unready('MISSING','S15_LEDGER_ARITHMETIC');
   const units=n(e.unitsAtomic),core=n(e.coreQuoteLamports),protocol=n(e.protocolFeeLamports),buyback=n(e.buybackFeeLamports),creator=n(e.creatorFeeLamports),quote=n(e.userQuoteLamports),network=n(e.networkFeeLamports),deposit=n(e.accountDepositsLamports);
   const buy=e.side==='BUY',charged=protocol+buyback+creator;
   // Each trade quote is its core plus (buy) or minus (sell) exactly these three fees; any other relation would double count or drop a component.
   if(units===0n||quote!==(buy?core+charged:core-charged))throw new Unready('MISSING','S15_LEDGER_ARITHMETIC');
   if(buy){p.buys++;p.acquiredAtomic+=units;p.grossEntryCost+=quote;p.protocolFee.buy+=protocol;p.buybackFee.buy+=buyback;}
   else{p.sells++;p.disposedAtomic+=units;p.proceeds+=quote;p.protocolFee.sell+=protocol;p.buybackFee.sell+=buyback;}
   if(e.creatorFeeToOwnVault)p.creatorFee.ownVault+=creator;else p.creatorFee.otherVault+=creator;
   p.networkFee+=network;p.deposits+=deposit;p.fees.set(e.signature,network);
  }
  let lotUnits=0n;
  for(const l of d.realized.disposedLots){
   if(!object(l)||typeof l.acquiredSignature!=='string'||typeof l.disposedSignature!=='string'||!integer(l.holdingSeconds)||typeof l.entryCostLamports!=='string')throw new Unready('MISSING','S15_LEDGER_ARITHMETIC');
   const units=n(l.unitsAtomic);lotUnits+=units;
   p.lots.push({acquiredSignature:l.acquiredSignature,disposedSignature:l.disposedSignature,unitsAtomic:String(units),holdingSeconds:l.holdingSeconds,entryCostLamports:l.entryCostLamports});
  }
  if(!p.buys)return bad('S15_NO_TARGET_POSITION');
  // Zero held: every acquired unit left through verified sells, so the whole gross entry cost is allocated to realized lots.
  if(p.acquiredAtomic!==p.disposedAtomic||p.acquiredAtomic!==n(d.realized.acquiredAtomic)||p.disposedAtomic!==n(d.realized.disposedThroughSalesAtomic)||lotUnits!==p.disposedAtomic)throw new Unready('MISSING','S15_LEDGER_ARITHMETIC');
  return{ok:true,position:p};
 }catch(error){if(error instanceof Unready)return{ok:false,quality:error.quality,code:error.message};throw error;}
}

function reader(r:CreatorInventoryReceipts,reuse:CreatorReuse,cutoff:number){
 return(id:string,expected:Request):{value:any;at:number}=>{
  const own=Object.hasOwn(r.requests,id),shared=!own&&id.startsWith(TX)?reuse.get(id.slice(TX.length)):undefined;
  if(!own&&!shared)fail('S15_RECEIPT_ABSENT');
  const request=shared?shared.request:r.requests[id],text:unknown=shared?shared.raw:r.rawArtifacts[id],time=shared?shared.retrievedAt:r.retrievedAt[id];
  if(JSON.stringify(request)!==JSON.stringify(expected)||typeof text!=='string')fail('S15_RECEIPT_REQUEST');
  const at=Date.parse(time??'');if(!Number.isFinite(at)||at>cutoff)fail('S15_RECEIPT_CLOCK');
  let raw:any;try{raw=JSON.parse(text);}catch{fail('S15_RECEIPT_SHAPE');}
  if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1||raw.error!==undefined||!Object.hasOwn(raw,'result'))fail('S15_RECEIPT_SHAPE');
  return{value:raw.result,at};
 };
}

/** Every S15 prerequisite recomputed from the same raw receipts: KNOWN O25, a supported zero-held position, the complete failed index from O24's own wallet pages within the dedicated cap, and a successful creator-paid target census equal to the ledger.
 * The collector admits reads only when this is ready; the provider repeats it, so no passed wallet, index or cached fact is trusted. */
export function creatorPerformanceGate(token:TokenRef,role:CreatorRole,tape:CreatorTape,inventory:CreatorInventoryReceipts,reuse:CreatorReuse,cutoff:string,evidenceIds:string[]):CreatorPerformanceGate{
 const lifetime=deriveO25CreatorLifetime(token,role,tape,inventory,reuse,cutoff,evidenceIds);
 try{
  if(lifetime.quality!=='KNOWN')throw new Unready(lifetime.quality,'S15_O25_PREREQUISITE_UNRESOLVED');
  const d=lifetime.data as any;
  if(!object(d)||d.method!==CREATOR_LIFETIME_METHOD||d.status!=='COMPLETE'||d.token?.address!==token.address||d.cohort?.kind!=='CREATOR_ONLY'||d.cohort.wallet!==role.wallet||d.quote?.asset!=='SOL'||!object(d.coverage))fail('S15_LIFETIME_SHAPE');
  const checked=creatorPositionPerformance(d);if(!checked.ok)throw new Unready(checked.quality,checked.code);
  const history=decodeCreatorInventory(token,role,tape,inventory,cutoff,reuse),w=history.walletProof,c=history.canonical;
  if(w.status!=='OBSERVED'||c.status!=='OBSERVED'||history.account!==d.cohort.canonicalAccount||w.catalogSlot!==d.coverage.catalogSlot||c.headSlot!==d.coverage.headSlot)fail('S15_SCOPE_MISMATCH');
  const read=reader(inventory,reuse,Date.parse(cutoff)),catalogSlot=w.catalogSlot!,rows:FailedIndexRow[]=[];
  let before:string|undefined;
  // The failed set comes from the same raw wallet pages O24 walked, never from a passed list or another index.
  for(const p of w.pages){
   const {value,at}=read(p.id,creatorPageRequest(role.wallet,catalogSlot,before));
   if(!Array.isArray(value)||value.length!==p.returned)fail('S15_INDEX_PROJECTION');
   for(const v of value){
    if(!object(v)||typeof v.signature!=='string'||!SIGNATURE.test(v.signature)||!integer(v.slot)||!integer(v.blockTime)||v.blockTime*1000>at||!('err' in v)||!(v.err===null||object(v.err))||v.confirmationStatus!=='finalized'||!(v.transactionIndex===undefined||v.transactionIndex===null||integer(v.transactionIndex)))fail('S15_INDEX_PROJECTION');
    rows.push({signature:v.signature,slot:v.slot,blockTime:v.blockTime,err:v.err,transactionIndex:integer(v.transactionIndex)?v.transactionIndex:null,confirmationStatus:'finalized'});
   }
   before=value.at(-1)?.signature;
  }
  const since=rows.filter(r=>r.slot>=role.creationSlot&&r.slot<=catalogSlot),successful=since.filter(r=>r.err===null),failedRows=since.filter(r=>r.err!==null);
  if(since.length!==w.rowsSinceCreation||successful.length!==w.successfulInspected)fail('S15_INDEX_PROJECTION');
  if(failedRows.length>FAILED_FEE_RECEIPT_CAP)throw new Unready('TRUNCATED','S15_FAILED_INDEX_CAP');
  const targets=[...new Set([history.account,...w.otherCurrentAccounts.map(a=>a.account)])],targetSet=new Set([role.mint,...targets]);
  // Successful creator-paid transactions that reference the target must be exactly the ledger trades with the same meta.fee; any other one is an unsupported non-trade cost.
  const census=new Map<string,string>();
  for(const row of successful){
   const {value}=read(`${TX}${row.signature}`,creatorTransactionRequest(row.signature)),keys=value?.transaction?.message?.accountKeys;
   if(!object(value)||value.slot!==row.slot||value.blockTime!==row.blockTime||value.transaction?.signatures?.[0]!==row.signature||!object(value.meta)||value.meta.err!==null||!integer(value.meta.fee)||!Array.isArray(keys)||!keys.length||!keys.every((k:any)=>object(k)&&typeof k.pubkey==='string'&&typeof k.signer==='boolean'))fail('S15_TRANSACTION_BINDING');
   if(keys[0].pubkey===role.wallet&&keys[0].signer===true&&keys.some((k:any)=>targetSet.has(k.pubkey)))census.set(row.signature,String(value.meta.fee));
  }
  for(const [signature,fee] of checked.position.fees)if(census.get(signature)!==String(fee))fail('S15_LEDGER_FEE_MISMATCH');
  if(census.size!==checked.position.fees.size)throw new Unready('MISSING','S15_NON_TRADE_TARGET_FEE_UNSUPPORTED');
  return{ready:true,scope:{account:history.account,targets,headSlot:c.headSlot!,catalogSlot,failedRows,successfulTargetFees:[...census].map(([signature,feeLamports])=>({signature,feeLamports})),position:checked.position,lifetime}};
 }catch(error){if(error instanceof Unready)return{ready:false,quality:error.quality,code:error.message,lifetime};throw error;}
}

/** KNOWN only with a ready gate and a COMPLETE classification of every recomputed failed row; any gap or unknown held valuation leaves the whole record unresolved. Forged or misfiled failed receipts throw. */
export function deriveS15CreatorPerformance(token:TokenRef,role:CreatorRole,tape:CreatorTape,inventory:CreatorInventoryReceipts,reuse:CreatorReuse,failed:FailedFeeReceipt[]|null,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const gate=creatorPerformanceGate(token,role,tape,inventory,reuse,cutoff,evidenceIds);
 const base={method:CREATOR_PERFORMANCE_METHOD,token,
  cohort:{kind:'CREATOR_ONLY',wallet:role.wallet,basis:'S13_SIGNED_CREATION_ROLE_VIA_O24_O25',creationSignature:role.creationSignature,creationSlot:role.creationSlot,identity:null,control:null},
  quote:{asset:'SOL',unit:'lamports',decimals:9,usdBasis:null,trackerValuesUsed:false},basis:{lifetimeMethod:CREATOR_LIFETIME_METHOD,lifetimeReasonCode:gate.ready?gate.scope.lifetime.reasonCode:gate.lifetime.reasonCode,failedFeeMethod:CREATOR_FAILED_FEES_METHOD},
  outsideScope:OUTSIDE_SCOPE,limitations:LIMITATIONS};
 const empty={position:null,unrealized:null,tradeFees:null,networkFees:null,accountFunding:null};
 const metric=(quality:Quality,data:Record<string,unknown>,reason:string):AdvisoryMetric=>({id:'S15',quality,unit:'scoped-record',data:{...base,...data},evidenceIds:[...new Set(evidenceIds)],reasonCode:reason});
 if(!gate.ready)return metric(gate.quality,{status:'PREREQUISITE_UNRESOLVED',...empty},gate.code);
 const s=gate.scope,d=s.lifetime.data as any,p=s.position;
 if(failed===null)return metric('MISSING',{status:'FAILED_FEES_NOT_COLLECTED',failedIndexedRows:s.failedRows.length,...empty},'S15_FAILED_FEES_NOT_COLLECTED');
 const fees=classifyCreatorFailedFees({actor:role.wallet,mint:role.mint,targetAccounts:s.targets,creationSlot:role.creationSlot,headSlot:s.catalogSlot,cutoff,rows:s.failedRows,receipts:failed});
 // Orphan, misfiled, re-requested, rehashed, re-clocked or rebound receipts invalidate the proof rather than a metric.
 if(fees.status==='INVALID')fail(fees.reasonCode);
 if(fees.actor!==role.wallet||fees.mint!==role.mint||fees.coverage.indexedRows!==s.failedRows.length||JSON.stringify(fees.targetSet)!==JSON.stringify([role.mint,...s.targets]))fail('S15_FAILED_FEE_SCOPE');
 // Indexed failed transactions referencing the creator key: payer and signer flags show whether the creator was charged or signed, never that it initiated them.
 const failedTransactionsReferencingCreator={meaning:'failed transactions in the complete creator-key index since creation, classified only for the network fee directly charged to the creator; not creator attempts, actions or intent',
  countBasis:'TRANSACTIONS_NOT_PARTICIPANTS',method:fees.method,status:fees.status,reasonCode:fees.reasonCode,coverage:fees.coverage,counts:fees.counts,foreignAssetCoverage:fees.foreignAssetCoverage,overheadAllocation:fees.overheadAllocation,storage:fees.storage,
  rows:fees.rows.map(r=>({signature:r.signature,slot:r.slot,classification:r.classification,code:r.code,feePayer:r.feePayer,actorSigner:r.actorSigner,targetReference:r.targetReference,metaFeeLamports:r.metaFeeLamports,actorChargedLamports:r.actorChargedLamports}))};
 if(fees.status!=='COMPLETE')return metric('TRUNCATED',{status:'FAILED_FEES_INCOMPLETE',failedTransactionsReferencingCreator,...empty},'S15_FAILED_FEES_INCOMPLETE');
 const failedOverhead=BigInt(fees.failedTargetAssociatedChargedTransactionOverheadLamports!),c=d.coverage,holding=p.lots.map(l=>l.holdingSeconds);
 return metric('KNOWN',{status:'COMPLETE',
  position:{asset:'TARGET_MINT',mint:role.mint,canonicalAccount:s.account,costMethod:'O25_FIFO_LOTS',buys:p.buys,sells:p.sells,acquiredAtomic:String(p.acquiredAtomic),disposedAtomic:String(p.disposedAtomic),
   grossEntryCostLamports:String(p.grossEntryCost),allocatedGrossEntryCostLamports:String(p.grossEntryCost),realizedProceedsLamports:String(p.proceeds),realizedQuoteResultLamports:String(p.proceeds-p.grossEntryCost),
   definition:'realized sell quotes minus the gross buy quotes allocated to the disposed FIFO lots; trade fees are inside both quotes, while network fees, deposits and creator-charged overhead of failed transactions referencing the creator key are excluded; not a net PnL'},
  unrealized:{heldAtomic:'0',unrealizedLamports:'0',mark:null,basis:'ZERO_HELD_NO_MARK_REQUIRED'},
  tradeFees:{includedInQuotes:true,protocolFeeLamports:{buy:String(p.protocolFee.buy),sell:String(p.protocolFee.sell),total:String(p.protocolFee.buy+p.protocolFee.sell)},buybackFeeLamports:{buy:String(p.buybackFee.buy),sell:String(p.buybackFee.sell),total:String(p.buybackFee.buy+p.buybackFee.sell)},
   creatorFee:{ownVaultLamports:String(p.creatorFee.ownVault),otherVaultLamports:String(p.creatorFee.otherVault),ownVaultBasis:'paid into the creator own vault and kept inside gross quotes; the claim is not valued'}},
  networkFees:{successfulTradeLamports:String(p.networkFee),successfulTargetTransactions:s.successfulTargetFees.length,failedTargetAssociatedChargedTransactionOverheadLamports:String(failedOverhead),failedIndexedRows:s.failedRows.length,directTotalLamports:String(p.networkFee+failedOverhead),subtractedFromPosition:false},
  accountFunding:{depositsLamports:String(p.deposits),subtractedFromPosition:false},
  targetTransfers:{transferInAtomic:d.flows.transferInAtomic,transferOutAtomic:d.flows.transferOutAtomic,mintAtomic:d.flows.mintAtomic,burnAtomic:d.flows.burnAtomic,basis:'O25_COMPLETE_TRANSFER_MINT_BURN_PROOF',wholeWalletSolFlows:'OUTSIDE_POSITION_SCOPE',accountRentRefunds:'OUTSIDE_POSITION_SCOPE'},
  thirdPartyCreatorFeeIncome:{status:'OUTSIDE_POSITION_SCOPE',lamports:null},
  sample:{kind:'OBSERVED_SINGLE_ACTOR_RECORD',actors:1,tokens:1,disposedLots:p.lots,holdingSeconds:{min:Math.min(...holding),max:Math.max(...holding)}},
  censoring:{cutoff,headSlot:s.headSlot,catalogSlot:s.catalogSlot,heldAtHeadAtomic:'0',rightCensored:false},
  indexCompleteness:{walletIndex:{pinnedSlot:s.catalogSlot,rowsSinceCreation:c.walletIndex.rowsSinceCreation,successful:c.walletIndex.successfulInspected,failed:s.failedRows.length,pages:c.walletIndex.pages},ataIndex:c.ataIndex,basis:'provider indexes pinned to finalized context slots'},
  currentSixHourProfile:{...d.currentSells,partOfPerformance:false},
  failedTransactionsReferencingCreator},'S15_CREATOR_POSITION_PERFORMANCE_OBSERVED');
}
