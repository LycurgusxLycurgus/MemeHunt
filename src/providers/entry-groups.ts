import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { Decimal } from 'decimal.js';
import { AccountLayout, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda, pumpPoolAuthorityPda } from '@pump-fun/pump-swap-sdk';
import { deriveEntryGroups } from '../domain/entry-groups.js';
import type { EntryGroupInputs } from '../domain/entry-groups.js';
import type { AssessmentDetails, EvidenceRecord, LiveCollection, LiveMarketSummary, Profile, TokenRef } from '../domain/contracts.js';
import { entryContextDecisionMethod } from '../domain/contracts.js';
import { decodeHolderPopulation } from './solana.js';
import { parseDexPairs } from './dexscreener.js';
import { decodeCurveState } from './pumpcurve.js';
import { decodeDammState,decodeEmptyDammState } from './meteora-damm-v2.js';
import { EMPTY_DAMM_VERSION } from '../domain/venue-entry.js';
import { isFastPolicy } from '../domain/fast-checklist.js';
import {resolveCriterionDecision,type CriterionInput} from '../domain/criterion-review.js';
import { deriveJupiterVaults } from './jupiter-route.js';
import { rugOwnerTypes } from '../domain/rugcheck.js';

export type EntryGroupBundle={token:TokenRef;cutoff:string;profile:Profile;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;collection:LiveCollection;market?:LiveMarketSummary|null;details:Pick<AssessmentDetails,'baseline'|'social'|'criteria'>};
const info=(v:any):AccountInfo<Buffer>=>{
 if(!v||typeof v.owner!=='string'||v.executable!==false||v.data?.[1]!=='base64'||typeof v.data[0]!=='string'||!Number.isSafeInteger(v.lamports)||v.lamports<0)throw Error('GROUP_RAW_ACCOUNT_INVALID');
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])throw Error('GROUP_RAW_ACCOUNT_INVALID');
 return {owner:new PublicKey(v.owner),executable:false,data,lamports:v.lamports,rentEpoch:0};
};

/** Recompute from retained acquisition, rather than accepting imported group verdicts. */
export function entryGroupsForBundle(b:EntryGroupBundle){
 const raw=b.rawArtifacts,input:EntryGroupInputs={token:b.token,cutoff:b.cutoff,profile:b.profile,evidence:b.evidence,collection:b.collection,baseline:b.details.baseline,social:b.details.social};
 const capture=raw['live-state-capture']?JSON.parse(raw['live-state-capture']):undefined,method=capture?.contextDecisionMethod;
 if(method!==undefined&&method!==entryContextDecisionMethod)throw Error('ENTRY_CONTEXT_METHOD_INVALID');
 if(method)input.contextDecisionMethod=method;
 const record=(id:string)=>b.evidence.find(e=>e.id===id),observed=(id:string,source:string)=>record(id)?.sourceId===source&&raw[id]!==undefined;
 try{
  if(!observed('rpc-mint-raw','solana-rpc')||!observed('rpc-holder-population','solana-rpc'))throw Error('HOLDER_POPULATION_REQUIRED');
  const mintRaw=JSON.parse(raw['rpc-mint-raw']);if(mintRaw.error||!Number.isSafeInteger(mintRaw.result?.context?.slot))throw Error('GROUP_HOLDER_PROOF_INVALID');
  const mint=info(mintRaw.result.value),decoded=MintLayout.decode(mint.data),supply=decoded.supply.toString(),population=JSON.parse(raw['rpc-holder-population']);
  if(!decoded.isInitialized||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(mint.owner.toBase58()))throw Error('GROUP_HOLDER_PROOF_INVALID');
  if(population.error)throw Error('GROUP_HOLDER_PROOF_INVALID');
  input.holders=decodeHolderPopulation(population.result,b.token.address,mint.owner.toBase58(),supply,mintRaw.result.context.slot);
 }catch(error){input.holderCode=b.details.baseline.find(a=>a.id==='O17')?.causes[0]?.code??(error instanceof Error?error.message:'GROUP_HOLDER_PROOF_INVALID');}
 try{
  const e=record('dex-pairs');if(!e||!['dexscreener','tinyfish-fetch'].includes(e.sourceId)||!raw[e.id])throw Error('ACTIVITY_FIELDS_MISSING');
  input.market=parseDexPairs(JSON.parse(raw[e.id]),b.token.chain,b.token.address);
 }catch{input.marketCode=b.collection.dex.code??'ACTIVITY_FIELDS_MISSING';}
 // Exclude only an adapter-verified target vault, never an arbitrary claimed pool owner.
 const selected=b.details.baseline.find(a=>a.id==='O08'&&a.quality==='KNOWN'&&a.projection?.value===true)?.data as {kind?:string;poolAddress?:string;version?:string;certificateId?:string}|undefined;
 let venue=selected;
 const prefix=venue?.version==='pumpswap-sdk-1.20.0-canonical-wsol-v1'?'pumpswap-canonical-wsol:':venue?.version==='pump-curve-sdk-4.0.0-sol-v1'?'pump-curve-sol:':venue?.version==='meteora-damm-v2-sdk-1.5.1-native-b-v1'?'meteora-damm-v2-native-b:':venue?.version===EMPTY_DAMM_VERSION?'meteora-damm-v2-native-empty:':null;
 input.venuePoolAddress=venue?.poolAddress??(prefix&&venue?.certificateId?.startsWith(prefix)?venue.certificateId.slice(prefix.length):undefined);
 if(venue?.kind==='JUPITER_ROUTE'&&isFastPolicy(b.details.criteria?.policyId)&&input.holders)try{
  const ids=b.evidence.filter(e=>e.id.startsWith('jupiter-')).map(e=>e.id),at=record('jupiter-sol-usd')?.retrievedAt;
  if(!at)throw Error('GROUP_VAULT_PROOF_INVALID');
  const vaults=deriveJupiterVaults(raw,b.token,b.profile,input.holders);
  if(vaults.length){input.excludedVaults=vaults;input.exclusionEvidenceIds=ids;}
 }catch{/* Without a verified buy delta no vault is excluded. */}
 if(venue&&venue.kind!=='JUPITER_ROUTE'&&input.holders)try{
  if(!input.venuePoolAddress)throw Error('GROUP_VAULT_PROOF_INVALID');
  const mint=new PublicKey(b.token.address),pool=new PublicKey(input.venuePoolAddress);
  if(venue.version==='pumpswap-sdk-1.20.0-canonical-wsol-v1'){
   if(!observed('pump-mints-vaults','pumpswap-direct'))throw Error('GROUP_VAULT_PROOF_INVALID');
   const capture=JSON.parse(raw['pump-mints-vaults']),r=capture.result;if(capture.error||!Number.isSafeInteger(r?.context?.slot)||!Array.isArray(r.value)||r.value.length!==8)throw Error('GROUP_VAULT_PROOF_INVALID');
   const p=info(r.value[0]),v=info(r.value[5]),decoded=PUMP_AMM_SDK.decodePool(p),vault=AccountLayout.decode(v.data);
   const base=info(r.value[3]);
   if(!p.owner.equals(PUMP_AMM_PROGRAM_ID)||!pool.equals(poolPda(0,pumpPoolAuthorityPda(mint),mint,NATIVE_MINT))||!decoded.creator.equals(pumpPoolAuthorityPda(mint))||!decoded.baseMint.equals(mint)||!decoded.quoteMint.equals(NATIVE_MINT)||!v.owner.equals(base.owner)||!vault.mint.equals(mint)||!vault.owner.equals(pool)||vault.state!==1||vault.delegateOption||vault.closeAuthorityOption)throw Error('GROUP_VAULT_PROOF_INVALID');
   input.excludedVaults=[decoded.poolBaseTokenAccount.toBase58()];input.exclusionEvidenceIds=['pump-mints-vaults'];
  }else if(venue.version==='pump-curve-sdk-4.0.0-sol-v1'){
   if(!observed('curve-state','pump-curve-direct'))throw Error('GROUP_VAULT_PROOF_INVALID');
   const state=decodeCurveState(raw['curve-state'],mint,0);if(!state.key.equals(pool))throw Error('GROUP_VAULT_PROOF_INVALID');
   input.excludedVaults=[getAssociatedTokenAddressSync(mint,state.key,true,state.mintInfo.owner).toBase58()];input.exclusionEvidenceIds=['curve-state'];
  }else if(venue.version==='meteora-damm-v2-sdk-1.5.1-native-b-v1'){
   if(!observed('damm-state','meteora-damm-direct'))throw Error('GROUP_VAULT_PROOF_INVALID');
   const state=decodeDammState(raw['damm-state'],b.token,pool,0);input.excludedVaults=[state.pool.tokenAVault.toBase58()];input.exclusionEvidenceIds=['damm-state'];
  }else if(venue.version===EMPTY_DAMM_VERSION){
   if(!observed('damm-state','meteora-damm-direct'))throw Error('GROUP_VAULT_PROOF_INVALID');
   const state=decodeEmptyDammState(raw['damm-state'],b.token,pool,0);input.excludedVaults=[state.assetVault];input.exclusionEvidenceIds=['damm-state'];
  }else throw Error('GROUP_VAULT_ADAPTER_UNSUPPORTED');
 }catch{input.holders=undefined;input.holderCode='GROUP_VAULT_PROOF_INVALID';}
 let rugLabels=new Map<string,'AMM'|'LOCKER'>(),rugLabelAvailable=false;
 if(raw['rugcheck-policy']&&isFastPolicy(b.details.criteria?.policyId)&&input.holders)try{
  if(record('rugcheck-report')?.sourceId==='rugcheck'&&JSON.parse(raw['rugcheck-report-status']).status===200){const report=JSON.parse(raw['rugcheck-report']);rugLabelAvailable=report?.mint===b.token.address&&!!report.knownAccounts&&typeof report.knownAccounts==='object'&&!Array.isArray(report.knownAccounts);if(rugLabelAvailable)rugLabels=rugOwnerTypes(raw['rugcheck-report'],b.token.address);}
  const labeled=input.holders.accounts.filter(account=>rugLabels.has(account.owner)).map(account=>account.address);
  if(labeled.length){input.excludedVaults=[...new Set([...(input.excludedVaults??[]),...labeled])];input.exclusionEvidenceIds=[...new Set([...(input.exclusionEvidenceIds??[]),'rugcheck-report'])];}
 }catch{/* An unavailable third-party report cannot certify an owner. */}
 const groups=deriveEntryGroups(input);
 if(selected?.kind==='JUPITER_ROUTE'&&isFastPolicy(b.details.criteria?.policyId)){
  const context=groups.groups.find(group=>group.checkId==='ADV-05');
  if(context?.code==='CURRENT_MARKET_SUPPORT_INADEQUATE'){context.status='UNKNOWN';context.code='JUPITER_MARKET_PRICE_UNAVAILABLE';context.rationale='The exact-token market price is unavailable.';}
 }
 const owner=groups.groups.find(group=>group.checkId==='ADV-01'),limit=b.profile.risk.maxDirectControlShare;
 if(raw['rugcheck-policy']&&isFastPolicy(b.details.criteria?.policyId)&&input.holders&&owner){
  const excluded=new Set(input.excludedVaults??[]),totals=new Map<string,bigint>();let program=0n,locked=0n;
  for(const account of input.holders.accounts){const n=BigInt(account.amount);if(rugLabels.get(account.owner)==='LOCKER')locked+=n;if(!PublicKey.isOnCurve(new PublicKey(account.owner).toBytes()))program+=n;if(!excluded.has(account.address)&&PublicKey.isOnCurve(new PublicKey(account.owner).toBytes()))totals.set(account.owner,(totals.get(account.owner)??0n)+n);}
  const supply=new Decimal(input.holders.supplyAtomic),largest=[...totals.values()].reduce((a,n)=>n>a?n:a,0n),share=new Decimal(largest.toString()).div(supply).toFixed();
  owner.metrics.largestOwnerSupplyFraction=share;owner.metrics.largestWalletSupplyFraction=share;owner.metrics.programHeldSupplyFraction=new Decimal(program.toString()).div(supply).toFixed();if(rugLabelAvailable)owner.metrics.lockedSupplyFraction=new Decimal(locked.toString()).div(supply).toFixed();
  if(limit!==undefined){owner.status=new Decimal(share).gt(limit)?'FAIL':'PASS';owner.code='WALLET_ONLY_CONTROL_SCREEN';owner.rationale='The control-share criterion considers on-curve wallets only; program-held supply is reported separately.';}
  owner.limitations.push('Wallet-only control criterion; third-party AMM and locker labels are attributed to RugCheck.');
 }else if(isFastPolicy(b.details.criteria?.policyId)&&input.holders&&owner?.status==='FAIL'&&limit!==undefined){
  const excluded=new Set(input.excludedVaults??[]),totals=new Map<string,bigint>();
  for(const account of input.holders.accounts)if(!excluded.has(account.address))totals.set(account.owner,(totals.get(account.owner)??0n)+BigInt(account.amount));
  const supply=input.holders.supplyAtomic,wallets=[...totals].filter(([address])=>PublicKey.isOnCurve(address)).map(([,amount])=>amount).sort((a,b)=>a>b?-1:a<b?1:0);
  const largest=new Decimal((wallets[0]??0n).toString()).div(supply);
  if(largest.gt(limit))owner.metrics.largestWalletSupplyFraction=largest.toFixed();
  else{owner.status='UNKNOWN';owner.code='OWNER_PROGRAM_ACCOUNT_UNCERTIFIED';owner.rationale='An owner above your limit is a program-derived account, possibly an unsupported pool, not certified as a vault; no negative is recorded.';}
 }
 if(b.details.criteria){
  let criterionInput:CriterionInput;try{criterionInput=JSON.parse(raw['criterion-input']);}catch{throw Error('CRITERION_PROOF_REQUIRED');}
  if(criterionInput.inputId!==b.details.criteria.inputId)throw Error('CRITERION_PROOF_INVALID');
  const decision=resolveCriterionDecision(b.details.criteria,'ADV-03',b.cutoff,b.details.social,criterionInput),index=groups.groups.findIndex(g=>g.checkId==='ADV-03');
  groups.groups[index]={checkId:'ADV-03',status:decision.status,rationale:decision.rationale||'Criterion review unavailable.',code:decision.status==='UNKNOWN'?decision.failure?.code??'CRITERION_UNAVAILABLE':`CRITERION_${decision.outcome}`,featureIds:[],evidenceIds:decision.evidenceIds,availableAt:b.details.criteria.qualifiedAt,metrics:{outcome:decision.outcome,basis:decision.basis},limitations:['Bounded reviewed source sample; no global popularity or human identity claim.']};
 }
 return groups;
}
