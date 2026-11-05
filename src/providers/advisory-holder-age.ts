import {Decimal} from 'decimal.js';
import {isDeepStrictEqual as same} from 'node:util';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import type {HolderAgeSourceContext} from './advisory-holder-age-source.js';
import {decodeSolanaAddress} from './solana.js';

export const HOLDER_AGE_METHOD='holder-weighted-observed-reference-age-v2' as const;
/** Exact documented special routes; OLD positive references remain usable, never negative-history FRESH. */
export const HOLDER_AGE_SPECIAL_ADDRESSES:readonly string[]=Object.freeze(["Stake11111111111111111111111111111111111111", "StakeConfig11111111111111111111111111111111", "Sysvar1111111111111111111111111111111111111", "AddressLookupTab1e1111111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111", "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Vote111111111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111", "BPFLoader2111111111111111111111111111111111", "Config1111111111111111111111111111111111111", "Ed25519SigVerify111111111111111111111111111", "Feature111111111111111111111111111111111111", "KeccakSecp256k11111111111111111111111111111", "LoaderV411111111111111111111111111111111111", "NativeLoader1111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "SysvarEpochSchedu1e111111111111111111111111", "SysvarFees111111111111111111111111111111111", "Sysvar1nstructions1111111111111111111111111", "SysvarRecentB1ockHashes11111111111111111111", "SysvarRent111111111111111111111111111111111", "SysvarRewards111111111111111111111111111111", "SysvarS1otHashes111111111111111111111111111", "SysvarS1otHistory11111111111111111111111111", "SysvarStakeHistory1111111111111111111111111", "SysvarEpochRewards11111111111111111111111111", "SysvarLastRestartS1ot1111111111111111111111"]);
export type HolderAgeReference={signature:string;slot:number;transactionIndex:number;blockTime:number|null;version:'legacy'|0|1;signer:boolean;failed:boolean;paginationToken:string|null};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function fail(code:string):never{throw Error('O22_HOLDER_REFERENCE_'+code);}
function check(v:unknown,code:string):asserts v{if(!v)fail(code);}
function address(v:unknown):string{check(typeof v==='string','ADDRESS');try{decodeSolanaAddress(v);}catch{fail('ADDRESS');}return v;}
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function signature(v:unknown):string{check(typeof v==='string'&&v.length>=64&&v.length<=88&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(v),'SIGNATURE');let n=0n;for(const c of v)n=n*58n+BigInt(ALPHABET.indexOf(c));const bytes=(n===0n?0:Math.ceil(n.toString(16).length/2))+(v.match(/^1*/)?.[0].length??0);check(bytes===64,'SIGNATURE');return v;}
/** Full native direct-address reference only. No instruction success, signer activity or financial effect is inferred. */
export function validateHolderReference(value:any,owner:string,bank:{slot:number;blockTime:number},sourceAt:string):HolderAgeReference|null{
 address(owner);const at=Date.parse(sourceAt);check(integer(bank.slot)&&integer(bank.blockTime)&&bank.blockTime>0&&Number.isFinite(at)&&at>=bank.blockTime*1000,'CLOCK');
 check(object(value)&&same(Object.keys(value).sort(),['data','paginationToken'])&&Array.isArray(value.data)&&value.data.length<=1&&(value.paginationToken===null||typeof value.paginationToken==='string'),'RESULT');
 if(value.data.length===0){check(value.paginationToken===null,'CURSOR');return null;}
 const row=value.data[0];check(object(row)&&integer(row.slot)&&row.slot<=bank.slot&&integer(row.transactionIndex)&&(row.blockTime===null||integer(row.blockTime)&&row.blockTime<=bank.blockTime&&row.blockTime*1000<=at),'ROW');
 check(row.version==='legacy'||row.version===0||row.version===1,'VERSION');const tx=row.transaction,meta=row.meta;check(object(tx)&&object(tx.message)&&Array.isArray(tx.signatures)&&tx.signatures.length>0&&object(meta)&&Object.hasOwn(meta,'err')&&(meta.err===null||object(meta.err)||typeof meta.err==='string'&&meta.err.length>0),'TRANSACTION');
 for(const s of tx.signatures)signature(s);check(new Set(tx.signatures).size===tx.signatures.length,'SIGNATURE');
 const message=tx.message;address(message.recentBlockhash);check(Array.isArray(message.instructions)&&Array.isArray(message.accountKeys)&&message.accountKeys.length>0&&message.accountKeys.length<=256,'MESSAGE');
 const keys=message.accountKeys as any[],seen=new Set<string>();let signers=0,staticCount=0,loaded=false,unsigned=false;
 // jsonParsed writable is the effective sanitized flag, not the serialized header/ALT request.
 // Official parse_accounts.rs uses maybe-writable/LoadedMessage::is_writable; reserved keys and
 // invoked program IDs may be demoted. Do not invert those booleans into raw readonly counts.
 // Primary Gitblobs: parse_accounts db77c94ed405e4df9e13a1f920be24db350811ba;
 // sanitized 999e23e9feca271d1e5bc10c1d233b962ed59501; loaded 44e3243fc01ef46aa320233f5b85ff8fb19a1f5a.
 for(const k of keys){check(object(k)&&typeof k.signer==='boolean'&&typeof k.writable==='boolean'&&(k.source==='transaction'||k.source==='lookupTable'),'KEY');address(k.pubkey);check(!seen.has(k.pubkey),'KEY');seen.add(k.pubkey);
  if(k.source==='lookupTable'){loaded=true;check(k.signer===false,'LOOKUP');continue;}
  check(!loaded,'LOOKUP');staticCount++;if(k.signer){check(!unsigned,'HEADER');signers++;}else unsigned=true;
 }
 check(keys[0].signer===true&&keys[0].writable===true&&signers===tx.signatures.length&&signers<=255&&seen.has(owner),'MEMBERSHIP');
 if(message.header!==undefined){const h=message.header;check(object(h)&&same(Object.keys(h).sort(),['numReadonlySignedAccounts','numReadonlyUnsignedAccounts','numRequiredSignatures'])&&h.numRequiredSignatures===signers&&integer(h.numReadonlySignedAccounts)&&h.numReadonlySignedAccounts<signers&&integer(h.numReadonlyUnsignedAccounts)&&h.numReadonlyUnsignedAccounts<=staticCount-signers,'HEADER');for(let i=0;i<staticCount;i++)if(keys[i].writable)check(i<signers?i<signers-h.numReadonlySignedAccounts:i<staticCount-h.numReadonlyUnsignedAccounts,'HEADER');}
 const lookups=message.addressTableLookups,emptyLoaded=meta.loadedAddresses===undefined||meta.loadedAddresses===null||same(meta.loadedAddresses,{writable:[],readonly:[]});
 if(row.version===0){check(Array.isArray(lookups),'LOOKUP');let w=0,r=0;for(const l of lookups){check(object(l)&&Array.isArray(l.writableIndexes)&&Array.isArray(l.readonlyIndexes),'LOOKUP');address(l.accountKey);for(const indices of [l.writableIndexes,l.readonlyIndexes]){check(indices.every((i:unknown)=>integer(i)&&i<=255)&&new Set(indices).size===indices.length,'LOOKUP');}check(!l.writableIndexes.some((i:number)=>l.readonlyIndexes.includes(i)),'LOOKUP');w+=l.writableIndexes.length;r+=l.readonlyIndexes.length;}check(w+r===keys.length-staticCount&&keys.slice(staticCount+w).every(k=>k.writable===false),'LOOKUP');
  if(!emptyLoaded)check(same(meta.loadedAddresses,{writable:keys.slice(staticCount,staticCount+w).map(k=>k.pubkey),readonly:keys.slice(staticCount+w).map(k=>k.pubkey)}),'LOOKUP');
 }else check(!loaded&&(lookups===undefined||Array.isArray(lookups)&&lookups.length===0)&&emptyLoaded,'LOOKUP');
 if(row.version===1)check(object(message.transactionConfig)&&same(Object.keys(message.transactionConfig).sort(),['computeUnitLimit','heapSize','loadedAccountsDataSizeLimit','priorityFee'])&&Object.values(message.transactionConfig).every(v=>v===null||integer(v)),'VERSION1');
 const sig=tx.signatures[0];check(value.paginationToken===null||value.paginationToken===`${row.slot}:${row.transactionIndex}`,'CURSOR');
 return{signature:sig,slot:row.slot,transactionIndex:row.transactionIndex,blockTime:row.blockTime,version:row.version,signer:keys.find(k=>k.pubkey===owner)!.signer,failed:meta.err!==null,paginationToken:value.paginationToken};
}

type Classification='OLD_WITNESSED'|'FRESH_UNDER_DECLARED_INDEX'|'UNKNOWN';
type OwnerProof={owner:string;heldAtomic:string;classification:Classification;witnessKey:string|null;reason?:string};
const uint=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&BigInt(v)<=18446744073709551615n;
function coreCheck(v:unknown,code:string):asserts v{if(!v)throw Error('O22_HOLDER_AGE_'+code);}
/** Complete raw population, one independent classification per owner; source importer owns native envelope/request/hash admission. */
export function deriveO22HolderAge(context:HolderAgeSourceContext,evidenceIds:string[]):AdvisoryMetric{
 const c=context,h=c.holders,bank=c.bank,cutoff=Date.parse(c.cutoff),created=Date.parse(c.createdAt);coreCheck(c.token.chain==='solana'&&integer(bank.slot)&&integer(bank.blockTime)&&bank.blockTime>0&&Number.isFinite(cutoff)&&Number.isFinite(created)&&created<=cutoff&&Date.parse(bank.at)<=created,'SCOPE');
 coreCheck(h.complete===true&&h.slot===bank.slot&&integer(c.mint.slot)&&c.mint.slot<=h.slot&&uint(h.supplyAtomic)&&h.supplyAtomic===c.mint.supplyAtomic&&integer(c.mint.decimals)&&c.mint.decimals<=255&&['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(c.mint.program)&&h.accounts.length<=100000,'POPULATION');
 const weights=new Map<string,bigint>(),accounts=new Set<string>();let supply=0n;for(const a of h.accounts){address(a.address);address(a.owner);coreCheck(!accounts.has(a.address)&&uint(a.amount),'ACCOUNT');accounts.add(a.address);const amount=BigInt(a.amount);supply+=amount;if(amount>0n)weights.set(a.owner,(weights.get(a.owner)??0n)+amount);}
 coreCheck(supply===BigInt(h.supplyAtomic),'SUPPLY');const owners=[...weights].sort(([a],[b])=>a<b?-1:a>b?1:0);
 coreCheck(owners.length<=20000&&same(c.owners,owners.map(([owner,held])=>({owner,heldAtomic:String(held)}))),'ROSTER');
 const maps=[c.first,c.prefixes,c.before,c.older];for(const m of maps){coreCheck(m instanceof Map,'SOURCE_MAP');for(const i of m.keys())coreCheck(integer(i)&&i<owners.length,'ORPHAN');}
 const boundary=bank.blockTime-86400,ledger:OwnerProof[]=[],exceptions=new Set(HOLDER_AGE_SPECIAL_ADDRESSES),expectedPremise={requestedSlotFloor:0,requestedSlotCeiling:bank.slot,status:'ANY',tokenAccounts:'NONE',retention:'DECLARED_PROVIDER_INDEX_NOT_FIRST_EVER'};coreCheck(same(c.summary.providerIndexPremise,expectedPremise)&&same(c.summary.exceptionalOwners,owners.map(([o])=>o).filter(o=>exceptions.has(o))),'PROVIDER_PREMISE');
 let contradiction=false;
 const reference=(entry:{value:any;record:{retrievedAt:string}},owner:string)=>{coreCheck(Number.isFinite(Date.parse(entry.record.retrievedAt))&&Date.parse(entry.record.retrievedAt)<=created,'SOURCE_CLOCK');return validateHolderReference(entry.value,owner,bank,entry.record.retrievedAt);};
 for(const[i,[owner,held]]of owners.entries()){
  const first=c.first.get(i),older=c.older.get(i),prefix=c.prefixes.get(i),before=c.before.get(i);let classification:Classification='UNKNOWN',reason='FIRST_REFERENCE_UNAVAILABLE',witnessKey:string|null=first?.record.key??null;
  const ref=first?reference(first,owner):null;
  if(ref&&ref.blockTime!==null&&ref.blockTime<=boundary){coreCheck(!older&&!prefix&&!before,'UNEXPECTED_ROLE');classification='OLD_WITNESSED';reason='DATED_OLDER_REFERENCE';}
  else if(ref&&ref.blockTime===null){coreCheck(!prefix&&!before,'UNEXPECTED_ROLE');const fallback=older?reference(older,owner):null;if(fallback&&fallback.blockTime!==null&&fallback.blockTime<=boundary){classification='OLD_WITNESSED';reason='DATED_OLDER_FALLBACK';witnessKey=older!.record.key;}else reason='NULL_TIME_WITHOUT_DATED_OLDER_WITNESS';}
  else if(ref&&ref.blockTime!==null){coreCheck(!older,'UNEXPECTED_ROLE');reason='NEGATIVE_HISTORY_CORROBORATION_MISSING';
   for(const entry of [prefix,before])if(entry)coreCheck(Number.isFinite(Date.parse(entry.record.retrievedAt))&&Date.parse(entry.record.retrievedAt)<=created,'SOURCE_CLOCK');
   if(prefix)coreCheck(object(prefix.value)&&Array.isArray(prefix.value.data)&&(prefix.value.paginationToken===null||typeof prefix.value.paginationToken==='string'),'NEGATIVE_HISTORY_SHAPE');if(before)coreCheck(Array.isArray(before.value),'NEGATIVE_HISTORY_SHAPE');
   if(prefix?.value.data.length||before?.value.length){contradiction=true;reason='CONTRADICTORY_EARLIER_REFERENCE';}
   else if(prefix&&before){coreCheck(prefix.value.paginationToken===null,'NEGATIVE_CURSOR');if(exceptions.has(owner))reason='DOCUMENTED_SPECIAL_ADDRESS_INDEX_UNSUPPORTED';else{classification='FRESH_UNDER_DECLARED_INDEX';reason='POSITIVE_FIRST_WITH_TWO_NEGATIVE_CORROBORATIONS';}}
  }else{coreCheck(!older&&!prefix&&!before,'UNEXPECTED_ROLE');reason='EMPTY_FIRST_REFERENCE_NOT_FRESH';}
  ledger.push({owner,heldAtomic:String(held),classification,witnessKey,...(classification==='UNKNOWN'?{reason}:{})});
 }
 // One source-index disagreement defeats the shared negative-history premise; all positive OLD witnesses remain valid.
 if(contradiction)for(const p of ledger)if(p.classification==='FRESH_UNDER_DECLARED_INDEX'){p.classification='UNKNOWN';p.reason='SHARED_INDEX_PREMISE_CONTRADICTION';}
 const counts={OLD_WITNESSED:0,FRESH_UNDER_DECLARED_INDEX:0,UNKNOWN:0};let old=0n,fresh=0n,unknown=0n;for(const p of ledger){counts[p.classification]++;const held=BigInt(p.heldAtomic);if(p.classification==='OLD_WITNESSED')old+=held;else if(p.classification==='FRESH_UNDER_DECLARED_INDEX')fresh+=held;else unknown+=held;}coreCheck(old+fresh+unknown===supply,'WEIGHTS');const complete=supply>0n&&counts.UNKNOWN===0&&ledger.length===owners.length,ratio=complete?new Decimal(String(fresh)).div(String(supply)).toFixed():null;
 return{id:'O22',quality:complete?'KNOWN':'MISSING',unit:'holder-weighted observed-reference age share',evidenceIds:[...new Set(evidenceIds)],reasonCode:complete?'COMPLETE_HOLDER_REFERENCE_AGE_OBSERVED':supply===0n?'HOLDER_REFERENCE_AGE_ZERO_DENOMINATOR':contradiction?'HOLDER_REFERENCE_INDEX_CONTRADICTION':'HOLDER_REFERENCE_AGE_INCOMPLETE',data:{method:HOLDER_AGE_METHOD,token:c.token,populationSlot:bank.slot,mintSlot:c.mint.slot,mintPopulationSameSlot:c.mint.slot===bank.slot,bankBlockTime:bank.blockTime,bankAt:new Date(bank.blockTime*1000).toISOString(),ageThresholdHours:24,boundaryBlockTime:boundary,interval:{start:new Date(boundary*1000).toISOString(),end:new Date(bank.blockTime*1000).toISOString(),freshBoundary:'(start,end]',oldBoundary:'<=start'},queryHistoryStartSlot:0,activityScope:'PROVIDER_OBSERVED_DIRECT_ADDRESS_REFERENCE',firstEverActivityAt:null,walletBirth:null,identityUnit:'token-account owner address; passive, failed and program-custody references included; not a person',classificationCounts:counts,weightsAtomic:{old:String(old),fresh:String(fresh),unknown:String(unknown),total:String(supply)},fraction:ratio,numeratorAtomic:complete?String(fresh):null,denominatorAtomic:String(supply),complete,sourceCoverage:c.summary,providerIndexPremise:expectedPremise,origin:c.origin,ownerProofs:ledger,limitations:['First observed means a direct address reference in the declared provider index, not wallet creation, signing, first-ever activity or a person.','OLD uses a positive dated older reference; FRESH is conditional on the declared index coverage and two per-owner negative corroborations. Empty or null-time history alone never establishes fresh exposure.','Hash-bound local retained RPC import does not authenticate provider completeness, transport or deployed program bytecode. Original holder query wire was not retained; its declared semantics bind the original collector evidence.','Mint and population slots may be adjacent; exact supply reconciliation is a measured sanity check, not an issuance or no-change attestation.']}};
}
