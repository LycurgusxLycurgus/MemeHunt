import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { AccountLayout, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda, pumpPoolAuthorityPda } from '@pump-fun/pump-swap-sdk';
import { deriveEntryGroups } from '../domain/entry-groups.js';
import type { EntryGroupInputs } from '../domain/entry-groups.js';
import type { AssessmentDetails, EvidenceRecord, LiveCollection, LiveMarketSummary, Profile, TokenRef } from '../domain/contracts.js';
import { decodeHolderPopulation } from './solana.js';
import { parseDexPairs } from './dexscreener.js';
import { decodeCurveState } from './pumpcurve.js';
import { decodeDammState } from './meteora-damm-v2.js';

export type EntryGroupBundle={token:TokenRef;cutoff:string;profile:Profile;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;collection:LiveCollection;market?:LiveMarketSummary|null;details:Pick<AssessmentDetails,'baseline'|'social'>};
const info=(v:any):AccountInfo<Buffer>=>{
 if(!v||typeof v.owner!=='string'||v.executable!==false||v.data?.[1]!=='base64'||typeof v.data[0]!=='string'||!Number.isSafeInteger(v.lamports)||v.lamports<0)throw Error('GROUP_RAW_ACCOUNT_INVALID');
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])throw Error('GROUP_RAW_ACCOUNT_INVALID');
 return {owner:new PublicKey(v.owner),executable:false,data,lamports:v.lamports,rentEpoch:0};
};

/** Recompute from retained acquisition, rather than accepting imported group verdicts. */
export function entryGroupsForBundle(b:EntryGroupBundle){
 const raw=b.rawArtifacts,input:EntryGroupInputs={token:b.token,cutoff:b.cutoff,profile:b.profile,evidence:b.evidence,collection:b.collection,baseline:b.details.baseline,social:b.details.social};
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
 const venue=b.details.baseline.find(a=>a.id==='O08'&&a.quality==='KNOWN'&&a.projection?.value===true)?.data as {poolAddress?:string;version?:string;certificateId?:string}|undefined;
 const prefix=venue?.version==='pumpswap-sdk-1.20.0-canonical-wsol-v1'?'pumpswap-canonical-wsol:':venue?.version==='pump-curve-sdk-4.0.0-sol-v1'?'pump-curve-sol:':venue?.version==='meteora-damm-v2-sdk-1.5.1-native-b-v1'?'meteora-damm-v2-native-b:':null;
 input.venuePoolAddress=venue?.poolAddress??(prefix&&venue?.certificateId?.startsWith(prefix)?venue.certificateId.slice(prefix.length):undefined);
 if(venue&&input.holders)try{
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
  }else throw Error('GROUP_VAULT_ADAPTER_UNSUPPORTED');
 }catch{input.holders=undefined;input.holderCode='GROUP_VAULT_PROOF_INVALID';}
 return deriveEntryGroups(input);
}
