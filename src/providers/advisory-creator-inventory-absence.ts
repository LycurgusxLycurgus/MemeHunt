import {createHash} from 'node:crypto';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodeSolanaAddress} from './solana.js';
import {accountTokenView} from './advisory-window-accounts.js';
import {walletTouchAbsence,creatorInventoryTokenAccount,CREATOR_ABSENCE_LEGACY_TOKEN_SOURCE_COMMIT,TOKEN_2022_SOURCE_COMMIT,SYSTEM_SOURCE_COMMIT,type CreatorRole} from './advisory-creator-inventory.js';
import {visitO24BulkSources,type O24BulkReceipts} from './advisory-creator-inventory-bulk.js';

export const CREATOR_ABSENCE_INVENTORY_METHOD='creator-signer-wallet-base-inventory-absence-v2' as const;
const SAMPLE=64,HOUR=3_600_000;
const code=(e:unknown)=>e instanceof Error&&/^(CREATOR_[A-Z0-9_]+|ADVISORY_ACCOUNTS_[A-Z0-9_]+)$/.test(e.message)?e.message:'CREATOR_ABSENCE_SEMANTIC_UNRESOLVED';
const fail=(s:string):never=>{throw Error(s);};
/** A separate sufficient absence proof. Neither a pool tape nor a quote DTO is an input. */
export function deriveO24BulkInventory(receipts:O24BulkReceipts,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const start=Date.parse(receipts.interval.start),end=Date.parse(receipts.interval.end),gaps:Array<{signature:string;code:string}>=[],gapHash=createHash('sha256'),walletHash=createHash('sha256'),unresolvedSignatures=new Set<string>();let inspected=0,gapCount=0;
 const views=new Map<string,{signature:string;slot:number;at:string;transactionIndex:number|null;preAtomic:string|null;postAtomic:string|null;lifecycle:string[];legs:number}>();
 const add=(signature:string,reason:string)=>{gapCount++;unresolvedSignatures.add(signature);gapHash.update(JSON.stringify([signature,reason]));if(gaps.length<SAMPLE)gaps.push({signature,code:reason});};
 const context=visitO24BulkSources(receipts,cutoff,(tx,indexed,_at,source)=>{
  const role:CreatorRole={wallet:source.role.wallet,mint:receipts.token.address,creationSignature:source.role.creation.signature,creationSlot:source.role.creation.slot};
  inspected++;
  try{const reason=walletTouchAbsence(tx,role,source.canonicalAccount);walletHash.update(JSON.stringify([indexed.signature,reason]));if(reason)add(indexed.signature,reason);}catch(error){const reason=code(error);walletHash.update(JSON.stringify([indexed.signature,reason]));add(indexed.signature,reason);}
  // Only the last successful pre-start pin and successful later canonical references are balance witnesses. The whole raw index is checked separately, including failed interval references.
  const before=source.canonicalRows.filter(r=>r.err===null&&r.blockTime*1000<start).sort((a,b)=>b.slot-a.slot||(b.transactionIndex??-1)-(a.transactionIndex??-1))[0];
  const needed=source.canonicalRows.some(r=>r.signature===indexed.signature&&r.err===null&&(r.blockTime*1000>=start||r.signature===before?.signature));
  if(needed){
   if(indexed.blockTime*1000>=start&&indexed.blockTime*1000<end){add(indexed.signature,'CREATOR_ABSENCE_INTERVAL_REFERENCE');return;}
   try{const v=accountTokenView(tx,source.canonicalAccount,receipts.token.address,'',[]);views.set(indexed.signature,{signature:indexed.signature,slot:indexed.slot,at:new Date(indexed.blockTime*1000).toISOString(),transactionIndex:indexed.transactionIndex,preAtomic:v.pre===null?null:String(v.pre),postAtomic:v.post===null?null:String(v.post),lifecycle:v.lifecycle,legs:v.legs.length});}catch(error){add(indexed.signature,code(error));}
  }
 });
 const role:CreatorRole={wallet:context.role.wallet,mint:receipts.token.address,creationSignature:context.role.creation.signature,creationSlot:context.role.creation.slot};
 const successful=context.walletRows.filter(r=>r.err===null),failed=context.walletRows.length-successful.length,intervalRows=context.canonicalRows.filter(r=>r.blockTime*1000>=start&&r.blockTime*1000<end),before=context.canonicalRows.filter(r=>r.err===null&&r.blockTime*1000<start).sort((a,b)=>b.slot-a.slot||(b.transactionIndex??-1)-(a.transactionIndex??-1))[0];
 const required=context.canonicalRows.filter(r=>r.err===null&&(r.blockTime*1000>=start||r.signature===before?.signature)).sort((a,b)=>a.slot-b.slot||(a.transactionIndex??-1)-(b.transactionIndex??-1)),chain=required.map(r=>views.get(r.signature)),canonical=chain.filter((v):v is NonNullable<typeof v>=>v!==undefined);let headAtomic:string|null=null,firstFailure:string|null=null;
 const reject=(reason:string)=>{firstFailure??=reason;};
 if(!Number.isFinite(start)||end-start!==6*HOUR||start%HOUR!==0||context.stateBlockTime*1000<end)reject('CREATOR_ABSENCE_INTERVAL_INVALID');
 if(intervalRows.length)reject('CREATOR_ABSENCE_INTERVAL_REFERENCE');
 if(!before||!required.length||chain.some(v=>!v)||canonical.some(v=>v.preAtomic===null||v.postAtomic===null))reject('CREATOR_ABSENCE_CANONICAL_CHAIN_UNRESOLVED');
 let continuityPairs=0,continuityBreaks=0;
 for(let i=1;i<canonical.length;i++){continuityPairs++;if(canonical[i-1]!.postAtomic!==canonical[i]!.preAtomic){continuityBreaks++;reject('CREATOR_ABSENCE_CANONICAL_DISCONTINUOUS');}}
 try{
  if(context.head?.context?.slot!==context.stateSlot||context.ownerCatalog?.context?.slot!==context.stateSlot||!Array.isArray(context.ownerCatalog.value))fail('CREATOR_ABSENCE_FIXED_STATE');
  const current=context.head.value;
  if(current===null)headAtomic='0';else{const h=creatorInventoryTokenAccount(current,role,'CREATOR_ABSENCE_HEAD');if(!h.immutable)fail('CREATOR_ABSENCE_HEAD');headAtomic=String(h.amount);}
  let found=false;const seen=new Set<string>();
  for(const entry of context.ownerCatalog.value){if(!entry||typeof entry.pubkey!=='string'||seen.has(entry.pubkey))fail('CREATOR_ABSENCE_CATALOG');decodeSolanaAddress(entry.pubkey);seen.add(entry.pubkey);const a=creatorInventoryTokenAccount(entry.account,role,'CREATOR_ABSENCE_CATALOG');
   if(entry.pubkey===context.canonicalAccount){if(found||current===null||!a.immutable||String(a.amount)!==headAtomic)fail('CREATOR_ABSENCE_CATALOG_HEAD');found=true;}else if(a.amount!==0n)fail('CREATOR_NON_CANONICAL_BALANCE');
  }
  if(found!==(current!==null))fail('CREATOR_ABSENCE_CATALOG_HEAD');
  if(!canonical.length||canonical.at(-1)!.postAtomic!==headAtomic)fail('CREATOR_ABSENCE_HEAD_CONTINUITY');
 }catch(error){reject(code(error));}
 if(canonical[0]?.postAtomic!=='0'||headAtomic!=='0')reject('CREATOR_ABSENCE_NONZERO_BALANCE');
 if(inspected!==successful.length)reject('CREATOR_ABSENCE_WALLET_CENSUS');
 if(gapCount)reject('CREATOR_ABSENCE_WALLET_UNRESOLVED');
 const known=firstFailure===null,inventory=known?{startAtomic:'0',endAtomic:'0',netChangeAtomic:'0',poolBuyBaseAtomic:'0',poolSellBaseAtomic:'0',poolBuyCoreQuoteAtomic:null,poolSellCoreQuoteAtomic:null,transferInBaseAtomic:'0',transferOutBaseAtomic:'0',mintAtomic:'0',burnAtomic:'0',legs:0}:null;
 return{id:'O24',quality:known?'KNOWN':'MISSING',unit:'target-mint base-atomic inventory change of the creation-signer wallet over the A30 measured hours',evidenceIds:[...new Set(evidenceIds)],reasonCode:known?'CREATOR_SIGNER_BASE_INVENTORY_ABSENCE_OBSERVED':firstFailure!,data:{
  method:CREATOR_ABSENCE_INVENTORY_METHOD,purpose:'O24_BASE_INVENTORY_ABSENCE_ONLY',mode:'ABSENCE_ONLY',scope:'CREATION_SIGNER_WALLET_ALL_TARGET_MINT_ACCOUNTS',
  cohort:{wallet:role.wallet,basis:'CREATION_TX_FEE_PAYER_SOLE_NON_MINT_SIGNER',creationSignature:role.creationSignature,canonicalAccount:context.canonicalAccount,identity:null,control:null},
  interval:context.interval,stateSlot:context.stateSlot,stateFloorSlot:context.stateFloorSlot,stateBlockTime:context.stateBlockTime,inventory,nonCanonicalAccountsZeroThroughout:known?true:null,
  canonical:{status:known?'OBSERVED':'MISSING',intervalReferences:intervalRows.length,indexedRows:context.canonicalRows.length,failedRows:context.canonicalRows.filter(r=>r.err!==null).length,startWitness:canonical[0]??null,headAtomic,transactions:canonical,continuityPairs,continuityBreaks},
  walletProof:{status:gapCount?'MISSING':'OBSERVED',rowsSinceCreation:context.walletRows.length,successfulInspected:inspected,failedReferences:failed,unresolvedTransactions:unresolvedSignatures.size,gapEvents:gapCount,gaps,gapsComplete:gapCount<=SAMPLE,gapHash:gapHash.digest('hex'),resultHash:walletHash.digest('hex')},
  sourceCoverage:{...context.counts,sourceBytes:context.sourceBytes,storedBytes:context.storedBytes,sourceHash:createHash('sha256').update(JSON.stringify(context.sourceHashes)).digest('hex'),receiptManifestHash:context.receiptManifestHash},
  quoteMint:null,quoteDecimals:null,quoteBasis:'NOT_MEASURED_BASE_ONLY',sourceTrust:'RETAINED_PROVIDER_RPC_IMPORT',sourceAuthentication:'Hashes bind retained bytes, not transport authentication or independent deployed binary/runtime attestation.',
  sourceCommit:TOKEN_2022_SOURCE_COMMIT,systemSourceCommit:SYSTEM_SOURCE_COMMIT,legacyTokenSourceCommit:CREATOR_ABSENCE_LEGACY_TOKEN_SOURCE_COMMIT,
  premises:['A positively verified closed signed creation frame proves this mint was freshly allocated and initialized with only allowed pre-initialization extensions. Later attempted instructions never stand in for committed creation.','Complete finalized creator-reference index and every successful body cover amount-decreasing owner/delegate/authority operations; provider index completeness is an explicit assumption.','Only exact supported critical Token/ATA forms and resolved account facts admit a negative wallet exclusion. Three additional foreign/native forms are selected exclusively by this absence purpose.'],
  limitations:['One creation-role wallet and one target mint, not a person or all controlled wallets.','No canonical reference of any status lies inside the fixed interval; postinterval balance/lifecycle witnesses are not relabelled as interval activity.','Current empty balances alone never prove historical zero; signed freshness, complete wallet exclusion and canonical chain are conjunctive requirements.','No pool tape, market flow, quote conversion, creator economics, O25 or S15 authority is asserted.','Supported jsonParsed instruction semantics use pinned canonical source, not an independent deployed program/runtime attestation.']}};
}
