import { setTimeout as delay } from 'node:timers/promises';
import { CpAmm, CP_AMM_PROGRAM_ID, derivePoolAuthority, deriveTokenVaultAddress, getPriceFromSqrtPrice, type PoolState } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { Connection, PublicKey, TransactionMessage, VersionedMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram, TransactionInstruction, type AccountInfo } from '@solana/web3.js';
import { AccountLayout, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { solanaRpc, safeRpcCode, PUBLIC_SOLANA_RPC, decodeRawMintControls, decodeProgramHeader, resolveProgramData } from './solana.js';
import { fetchDexPairs, dexArtifacts, parseDexPairs, type DexRecoveryOptions } from './dexscreener.js';
import type { PumpSwapRead } from './pumpswap.js';
import { deriveBaseline, type HolderFacts, type VenueFacts, type VenueInspection } from '../domain/baseline.js';
import type { LiveBundle, Profile, TokenRef } from '../domain/contracts.js';
import { EMPTY_DAMM_VERSION,EMPTY_DAMM_METHOD,type EmptyVenueScreening } from '../domain/venue-entry.js';

// Only local coder/math/builder access; this SDK connection must never dispatch.
const sdk=new CpAmm(new Connection(PUBLIC_SOLANA_RPC,{fetch:async()=>{throw Error('DAMM_HIDDEN_NETWORK_FORBIDDEN');}}));
export const DAMM_VERSION='meteora-damm-v2-sdk-1.5.1-native-b-v1';
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const account=(v:unknown):AccountInfo<Buffer>=>{
 if(!obj(v)||typeof v.owner!=='string'||typeof v.executable!=='boolean'||!Number.isSafeInteger(v.lamports)||Number(v.lamports)<0||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string')throw Error('DAMM_ACCOUNT_SHAPE');
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])throw Error('DAMM_ACCOUNT_SHAPE');
 return {owner:new PublicKey(v.owner),data,executable:v.executable,lamports:Number(v.lamports),rentEpoch:0};
};
const owned=(a:AccountInfo<Buffer>,owner:PublicKey)=>{if(a.executable||!a.owner.equals(owner))throw Error('DAMM_ACCOUNT_BINDING');};
const decodePool=(a:AccountInfo<Buffer>):PoolState=>{owned(a,CP_AMM_PROGRAM_ID);if(a.data.length!==1112)throw Error('DAMM_LAYOUT_UNSUPPORTED');return sdk._program.coder.accounts.decode('pool',a.data);};
function vault(a:AccountInfo<Buffer>,mint:PublicKey){owned(a,TOKEN_PROGRAM_ID);if(a.data.length!==165)throw Error('DAMM_ACCOUNT_BINDING');const v=AccountLayout.decode(a.data);if(!v.mint.equals(mint)||!v.owner.equals(derivePoolAuthority())||v.state!==1||v.delegateOption||v.closeAuthorityOption)throw Error('DAMM_ACCOUNT_BINDING');return v;}
function staticMint(info:AccountInfo<Buffer>,mint:PublicKey){
 const program=info.owner;if(!program.equals(TOKEN_PROGRAM_ID)&&!program.equals(TOKEN_2022_PROGRAM_ID))throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');owned(info,program);
 if(info.data.length<82)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');const decoded=MintLayout.decode(info.data);if(!decoded.isInitialized)throw Error('DAMM_ACCOUNT_BINDING');
 if(program.equals(TOKEN_PROGRAM_ID)){if(info.data.length!==82)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');return decoded;}
 const data=info.data;if(data.length<170||!data.subarray(82,165).equals(Buffer.alloc(83))||data[165]!==1)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');
 let pos=166;const entries=new Map<number,Buffer>();while(pos<data.length){if(pos+4>data.length)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');const type=data.readUInt16LE(pos),length=data.readUInt16LE(pos+2);pos+=4;if(![18,19].includes(type)||entries.has(type)||pos+length>data.length)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');entries.set(type,data.subarray(pos,pos+length));pos+=length;}
 const pointer=entries.get(18),metadata=entries.get(19);if(!pointer||pointer.length!==64||!pointer.subarray(0,32).equals(Buffer.alloc(32))||!pointer.subarray(32).equals(mint.toBuffer())||!metadata||metadata.length<68||!metadata.subarray(0,32).equals(Buffer.alloc(32))||!metadata.subarray(32,64).equals(mint.toBuffer()))throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');
 let offset=64;const uint=()=>{if(offset+4>metadata.length)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');const n=metadata.readUInt32LE(offset);offset+=4;return n;};const str=()=>{const n=uint();if(n>metadata.length-offset)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');new TextDecoder('utf-8',{fatal:true}).decode(metadata.subarray(offset,offset+n));offset+=n;};
 str();str();str();const count=uint();if(count>(metadata.length-offset)/8)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');for(let i=0;i<count;i++){str();str();}if(offset!==metadata.length)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');return decoded;
}
export function decodeEmptyDammState(raw:string,token:TokenRef,poolKey:PublicKey,minSlot:number){
 const r=JSON.parse(raw).result;if(!obj(r)||!obj(r.context)||!Number.isSafeInteger(r.context.slot)||Number(r.context.slot)<minSlot||!Array.isArray(r.value)||r.value.length!==5||r.value.some(v=>v===null))throw Error('DAMM_STATE_MISSING');
 const [poolInfo,target,native,va,vb]=r.value.map(account),pool=decodePool(poolInfo),mint=new PublicKey(token.address);if(token.chain!=='solana')throw Error('DAMM_ACCOUNT_BINDING');
 const side:'A'|'B'|null=pool.tokenAMint.equals(mint)&&pool.tokenBMint.equals(NATIVE_MINT)?'A':pool.tokenBMint.equals(mint)&&pool.tokenAMint.equals(NATIVE_MINT)?'B':null;if(!side||!pool.tokenAVault.equals(deriveTokenVaultAddress(pool.tokenAMint,poolKey))||!pool.tokenBVault.equals(deriveTokenVaultAddress(pool.tokenBMint,poolKey)))throw Error('DAMM_ACCOUNT_BINDING');
 const targetMint=staticMint(target,mint),nativeMint=staticMint(native,NATIVE_MINT);if(!native.owner.equals(TOKEN_PROGRAM_ID)||nativeMint.decimals!==9)throw Error('DAMM_ACCOUNT_BINDING');
 const targetProgram=target.owner,expectedFlag=targetProgram.equals(TOKEN_2022_PROGRAM_ID)?1:0;if((side==='A'?pool.tokenAFlag:pool.tokenBFlag)!==expectedFlag||(side==='A'?pool.tokenBFlag:pool.tokenAFlag)!==0)throw Error('DAMM_ACCOUNT_BINDING');
 const checkVault=(info:AccountInfo<Buffer>,address:PublicKey,program:PublicKey)=>{owned(info,program);if(info.data.length!==165)throw Error('DAMM_ACCOUNT_BINDING');const v=AccountLayout.decode(info.data);if(!v.mint.equals(address)||!v.owner.equals(derivePoolAuthority())||v.state!==1||v.delegateOption||v.closeAuthorityOption)throw Error('DAMM_ACCOUNT_BINDING');};
 checkVault(va,pool.tokenAMint,side==='A'?targetProgram:TOKEN_PROGRAM_ID);checkVault(vb,pool.tokenBMint,side==='B'?targetProgram:TOKEN_PROGRAM_ID);
 if(pool.layoutVersion!==1||pool.feeVersion!==1||pool.collectFeeMode!==1||pool.poolFees.baseFee.baseFeeInfo.data[8]!==0||pool.poolFees.compoundingFeeBps!==0||!pool.liquidity.isZero()||!pool.permanentLockLiquidity.isZero())throw Error('DAMM_MODE_UNSUPPORTED');
 return {pool,slot:Number(r.context.slot),assetSide:side,assetProgram:targetProgram.toBase58(),assetVault:(side==='A'?pool.tokenAVault:pool.tokenBVault).toBase58(),nativeVault:(side==='A'?pool.tokenBVault:pool.tokenAVault).toBase58(),decimals:targetMint.decimals};
}
export function decodeDammState(raw:string,token:TokenRef,poolKey:PublicKey,minSlot:number){
 const r=JSON.parse(raw).result;
 if(!obj(r)||!obj(r.context)||!Number.isSafeInteger(r.context.slot)||Number(r.context.slot)<minSlot||!Array.isArray(r.value)||r.value.length!==5||r.value.some(v=>v===null))throw Error('DAMM_STATE_MISSING');
 const [poolInfo,base,quote,va,vb]=r.value.map(account),pool=decodePool(poolInfo),mint=new PublicKey(token.address);
 if(token.chain!=='solana'||!pool.tokenAMint.equals(mint)||!pool.tokenBMint.equals(NATIVE_MINT)||!pool.tokenAVault.equals(deriveTokenVaultAddress(mint,poolKey))||!pool.tokenBVault.equals(deriveTokenVaultAddress(NATIVE_MINT,poolKey)))throw Error('DAMM_ACCOUNT_BINDING');
 owned(base,TOKEN_PROGRAM_ID);owned(quote,TOKEN_PROGRAM_ID);if(base.data.length!==82||quote.data.length!==82)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');
 const a=MintLayout.decode(base.data),b=MintLayout.decode(quote.data);if(!a.isInitialized||!b.isInitialized||b.decimals!==9)throw Error('DAMM_ACCOUNT_BINDING');
 const av=vault(va,mint),bv=vault(vb,NATIVE_MINT);
 if(pool.layoutVersion!==1||pool.feeVersion!==1||pool.collectFeeMode!==1||pool.tokenAFlag!==0||pool.tokenBFlag!==0||pool.poolFees.baseFee.baseFeeInfo.data[8]!==0||pool.poolFees.compoundingFeeBps!==0||pool.liquidity.lte(new BN(0))||pool.permanentLockLiquidity.isNeg()||pool.permanentLockLiquidity.gt(pool.liquidity))throw Error('DAMM_MODE_UNSUPPORTED');
 const controls=decodeRawMintControls({context:r.context,value:r.value[1]},['rpc-genesis','damm-state']);
 if(!controls.complete||!controls.transferAllowed||controls.currentFeeBps!=='0'||!controls.feeImmutable)throw Error('DAMM_TOKEN_MODE_UNSUPPORTED');
 return {pool,poolKey,base,a,av,bv,controls,slot:Number(r.context.slot),removable:new Decimal(1).sub(new Decimal(pool.permanentLockLiquidity.toString()).div(pool.liquidity.toString())).toFixed()};
}
export function quoteDamm(state:ReturnType<typeof decodeDammState>,profile:Profile,nativeUsd:string,at:string){
 if(!profile.sizeUsd||new Decimal(nativeUsd).lte(0))throw Error('DAMM_QUOTE_CONTEXT_MISSING');
 const price=new Decimal(nativeUsd),quote=new BN(new Decimal(profile.sizeUsd).div(price).mul(1e9).floor().toFixed(0)),common={slippage:0,poolState:state.pool,currentTime:Math.floor(Date.parse(at)/1000),currentSlot:state.slot,tokenADecimal:state.a.decimals,tokenBDecimal:9};
 const buy=sdk.getQuote({...common,inAmount:quote,inputTokenMint:NATIVE_MINT});
 if(buy.consumedInAmount.toString()!==quote.toString()||buy.swapOutAmount.lte(new BN(0))||buy.swapOutAmount.gt(new BN(state.av.amount.toString())))throw Error('DAMM_SIZE_UNQUOTABLE');
 const sell=sdk.getQuote({...common,inAmount:buy.swapOutAmount,inputTokenMint:state.pool.tokenAMint});
 if(sell.consumedInAmount.toString()!==buy.swapOutAmount.toString()||sell.swapOutAmount.lte(new BN(0))||sell.swapOutAmount.gt(new BN(state.bv.amount.toString())))throw Error('DAMM_EXIT_RESERVE_INSUFFICIENT');
 return {quote,buy,sell,reference:getPriceFromSqrtPrice(state.pool.sqrtPrice,state.a.decimals,9).mul(price).toFixed(),exitUsd:new Decimal(sell.swapOutAmount.toString()).div(1e9).mul(price).toFixed(),feesUsd:new Decimal(buy.totalFee.add(sell.totalFee).toString()).div(1e9).mul(price).toFixed()};
}
function swapInstruction(state:ReturnType<typeof decodeDammState>,payer:PublicKey,input:PublicKey,output:PublicKey,amount:BN,min:BN){
 const a=state.pool.tokenAMint,baseAta=getAssociatedTokenAddressSync(a,payer,true),quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,payer,true),event=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],CP_AMM_PROGRAM_ID)[0];
 const data=sdk._program.coder.instruction.encode('swap',{params:{amountIn:amount,minimumAmountOut:min}});
 const keys=[{pubkey:derivePoolAuthority(),isWritable:false,isSigner:false},{pubkey:state.poolKey,isWritable:true,isSigner:false},{pubkey:input.equals(a)?baseAta:quoteAta,isWritable:true,isSigner:false},{pubkey:output.equals(a)?baseAta:quoteAta,isWritable:true,isSigner:false},...[state.pool.tokenAVault,state.pool.tokenBVault].map(pubkey=>({pubkey,isWritable:true,isSigner:false})),...[a,NATIVE_MINT].map(pubkey=>({pubkey,isWritable:false,isSigner:false})),{pubkey:payer,isWritable:false,isSigner:true},...[TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,CP_AMM_PROGRAM_ID,event,CP_AMM_PROGRAM_ID].map(pubkey=>({pubkey,isWritable:false,isSigner:false}))];
 return new TransactionInstruction({programId:CP_AMM_PROGRAM_ID,keys,data});
}
function dammLegs(state:ReturnType<typeof decodeDammState>,q:ReturnType<typeof quoteDamm>,user:PublicKey){
 const baseAta=getAssociatedTokenAddressSync(state.pool.tokenAMint,user,true),quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,user,true);
   const entry=[createAssociatedTokenAccountIdempotentInstruction(user,baseAta,user,state.pool.tokenAMint),createAssociatedTokenAccountIdempotentInstruction(user,quoteAta,user,NATIVE_MINT),SystemProgram.transfer({fromPubkey:user,toPubkey:quoteAta,lamports:BigInt(q.quote.toString())}),createSyncNativeInstruction(quoteAta),swapInstruction(state,user,NATIVE_MINT,state.pool.tokenAMint,q.quote,q.buy.swapOutAmount)];
   const exit=[swapInstruction(state,user,state.pool.tokenAMint,NATIVE_MINT,q.buy.swapOutAmount,new BN(0)),createCloseAccountInstruction(quoteAta,user,user)];

 return {entry,exit};
}
/** One verified legacy-mint, native-token-B DAMM v2 route; read-only RPC and unsigned simulation. */
export async function inspectDammV2(token:TokenRef,poolAddress:string,profile:Profile,holders:HolderFacts|undefined,minSlot:number,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal,recovery?:DexRecoveryOptions):Promise<PumpSwapRead>{
 const rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={},marketEvidence:NonNullable<PumpSwapRead['marketEvidence']>={},errors:Record<string,string>={},poolKey=new PublicKey(poolAddress);
 const inspection:VenueInspection={token,poolAddress,certificateId:'',version:DAMM_VERSION,availableAt:now(),bindingVerified:false,evidenceIds:['rpc-genesis'],errors,limitations:['One selected native-SOL DAMM v2 route; does not certify other pools or globally best execution.','All non-permanently-locked liquidity conservatively treated as withdrawable; temporary locks receive no exemption.']};
 let controls:ReturnType<typeof decodeRawMintControls>|undefined;
 const requests:Record<string,{method:string;params:unknown[]}>={};
 const retain=(id:string,raw:string)=>{rawArtifacts[id]=raw;retrievedAt[id]=now();inspection.evidenceIds.push(id);};
 const read=async(id:string,method:string,params:unknown[])=>{requests[id]={method,params};const r=await solanaRpc(url,method,params,fetcher,undefined,signal);retain(id,r.raw);return r.value;};
 let slot=minSlot;
 const multiple=async(id:string,keys:PublicKey[])=>{const r=await read(id,'getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized',minContextSlot:slot}]);if(!obj(r)||!obj(r.context)||!Number.isSafeInteger(r.context.slot)||Number(r.context.slot)<slot||!Array.isArray(r.value)||r.value.length!==keys.length)throw Error('RPC_SHAPE');slot=Number(r.context.slot);return r.value.map(v=>v===null?null:account(v));};
 try{
  const [initial]=await multiple('damm-pool',[poolKey]);if(!initial)throw Error('DAMM_STATE_MISSING');const discovered=decodePool(initial);
  const priceRead=await fetchDexPairs('solana',NATIVE_MINT.toBase58(),fetcher,now,recovery);
  for(const [id,a]of Object.entries(dexArtifacts(priceRead,'pump-sol-usd','solana',NATIVE_MINT.toBase58(),now()))){marketEvidence[id]=a;rawArtifacts[id]=a.raw;retrievedAt[id]=a.retrievedAt;inspection.evidenceIds.push(id);}
  await multiple('damm-state',[poolKey,new PublicKey(token.address),NATIVE_MINT,discovered.tokenAVault,discovered.tokenBVault]);
  let empty:ReturnType<typeof decodeEmptyDammState>|undefined;try{empty=decodeEmptyDammState(rawArtifacts['damm-state'],token,poolKey,minSlot);}catch{/* The established positive adapter owns all other states. */}
  if(empty){
   const programRaw=await read('damm-program','getAccountInfo',[CP_AMM_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:slot,dataSlice:{offset:0,length:36}}]);
   const program=decodeProgramHeader(programRaw,CP_AMM_PROGRAM_ID.toBase58());if(program.programDataAddress){const d=await read('damm-program-data','getAccountInfo',[program.programDataAddress,{encoding:'base64',commitment:'finalized',minContextSlot:slot,dataSlice:{offset:0,length:45}}]);resolveProgramData(program,d,[]);}
   const availableAt=retrievedAt['damm-state'],screening:EmptyVenueScreening={method:EMPTY_DAMM_METHOD,version:EMPTY_DAMM_VERSION,token,pool:poolAddress,minSlot,slot:empty.slot,assetSide:empty.assetSide,assetProgram:empty.assetProgram,assetVault:empty.assetVault,nativeVault:empty.nativeVault,liquidityAtomic:'0',permanentLockLiquidityAtomic:'0',availableAt,expiresAt:new Date(Date.parse(availableAt)+30000).toISOString(),evidenceIds:[...inspection.evidenceIds,'damm-calculation','damm-requests']};
   retain('damm-calculation',JSON.stringify(screening));retain('damm-requests',JSON.stringify({method:'damm-read-requests-v1',requests}));
   inspection.version=EMPTY_DAMM_VERSION;inspection.certificateId='meteora-damm-v2-native-empty:'+poolAddress;inspection.bindingVerified=true;inspection.screening=screening;inspection.availableAt=now();inspection.limitations=['The selected noncompounding pool has no active liquidity; no quote, cost or simulation was produced.'];return {inspection,rawArtifacts,retrievedAt,marketEvidence};
  }
  const state=decodeDammState(rawArtifacts['damm-state'],token,poolKey,minSlot);controls=state.controls;
  inspection.bindingVerified=true;inspection.certificateId='meteora-damm-v2-native-b:'+poolAddress;inspection.removableLiquidityFraction=state.removable;inspection.executionDisabled=state.pool.poolStatus!==0;
  const programRaw=await read('damm-program','getAccountInfo',[CP_AMM_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:slot,dataSlice:{offset:0,length:36}}]);
  const program=decodeProgramHeader(programRaw,CP_AMM_PROGRAM_ID.toBase58());
  if(program.programDataAddress){const d=await read('damm-program-data','getAccountInfo',[program.programDataAddress,{encoding:'base64',commitment:'finalized',minContextSlot:slot,dataSlice:{offset:0,length:45}}]);const resolved=resolveProgramData(program,d,[]);inspection.limitations.push(resolved.immutable?'Venue deployment immutable.':'Venue upgrade authority observed; binding is not an audit or future safety guarantee.');}
  const price=priceRead.market?.pairs.find(p=>p.baseAddress===NATIVE_MINT.toBase58()&&p.quoteAddress==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'&&p.priceUsd)?.priceUsd;
  if(!price)throw Error('DAMM_USD_PRICE_UNAVAILABLE');
  const q=quoteDamm(state,profile,price,retrievedAt['damm-state']),quoteAt=retrievedAt['damm-state'],expiry=new Date(Math.min(Date.parse(quoteAt),Date.parse(retrievedAt['pump-sol-usd']))+30000).toISOString();
  const venue:VenueFacts={certificateId:inspection.certificateId,bindingVerified:true,version:DAMM_VERSION,token,availableAt:quoteAt,expiresAt:expiry,removableLiquidityFraction:state.removable,lockExpiresAt:null,entryQuoteUsd:profile.sizeUsd!,acquiredAtomic:q.buy.swapOutAmount.toString(),decimals:state.a.decimals,exitQuantityAtomic:q.buy.swapOutAmount.toString(),exitQuoteUsd:q.exitUsd,referencePriceUsd:q.reference,entryExternalCostUsd:'0',exitExternalCostUsd:'0',embeddedFeesUsd:q.feesUsd,costsReconciled:false,method:'INDEPENDENT_QUOTES',evidenceIds:[]};
  errors.execution='DAMM_TRANSACTION_COSTS_UNAVAILABLE';
  let simulationProof:Record<string,unknown>|undefined;
  try{
   const candidates=[...new Set([...(holders?.accounts??[]).sort((a,b)=>BigInt(a.amount)>BigInt(b.amount)?-1:1).map(a=>a.owner),state.pool.creator.toBase58()])].slice(0,8).map(k=>new PublicKey(k));
   const payers=await multiple('damm-payers',candidates);let user:PublicKey|undefined,baseInfo:AccountInfo<Buffer>|null=null;
   const potential=candidates.flatMap((payer,i)=>payers[i]&&!payers[i]!.executable&&payers[i]!.owner.equals(PublicKey.default)&&BigInt(payers[i]!.lamports)>=BigInt(q.quote.toString())+30000000n?[payer]:[]);
   if(!potential.length)throw Error('DAMM_SIMULATION_PAYER_UNAVAILABLE');
   const atas=await multiple('damm-user-accounts',potential.flatMap(p=>[getAssociatedTokenAddressSync(state.pool.tokenAMint,p,true),getAssociatedTokenAddressSync(NATIVE_MINT,p,true)]));
   const index=potential.findIndex((_,i)=>atas[i*2+1]===null);if(index<0)throw Error('DAMM_SIMULATION_PAYER_UNAVAILABLE');user=potential[index];baseInfo=atas[index*2];
   const baseAta=getAssociatedTokenAddressSync(state.pool.tokenAMint,user,true),quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,user,true);
   if(baseInfo){owned(baseInfo,TOKEN_PROGRAM_ID);const a=AccountLayout.decode(baseInfo.data);if(!a.mint.equals(state.pool.tokenAMint)||!a.owner.equals(user)||a.state!==1)throw Error('DAMM_SIMULATION_SETUP_UNSUPPORTED');}
   const {entry,exit}=dammLegs(state,q,user);
   let blockhash='',blockSlot=slot,blockId='damm-blockhash';
   const refresh=async()=>{const block=await read(blockId,'getLatestBlockhash',[{commitment:'finalized',minContextSlot:slot}]);if(!obj(block)||!obj(block.context)||!Number.isSafeInteger(block.context.slot)||Number(block.context.slot)<slot||!obj(block.value)||typeof block.value.blockhash!=='string')throw Error('RPC_SHAPE');blockhash=block.value.blockhash;blockSlot=Number(block.context.slot);};
   await refresh();
   const message=(instructions:TransactionInstruction[])=>new TransactionMessage({payerKey:user!,recentBlockhash:blockhash,instructions}).compileToV0Message();
   const feeFor=async(id:string,instructions:TransactionInstruction[])=>{
     const params=[Buffer.from(message(instructions).serialize()).toString('base64'),{commitment:'finalized',minContextSlot:blockSlot}];requests[id]={method:'getFeeForMessage',params};
     const attempt=async(index:number)=>{const r=await solanaRpc(url,'getFeeForMessage',params,fetcher,undefined,signal,raw=>retain(id+'-attempt-'+index,raw));retain(id,r.raw);retrievedAt[id]=retrievedAt[id+'-attempt-'+index];return r.value;};
     let f:unknown;try{f=await attempt(1);}catch(error){if(safeRpcCode(error)!=='RPC_REMOTE_-32016'||signal?.aborted)throw error;retain(id+'-recovery',JSON.stringify({method:'damm-fee-min-context-retry-v1',delayMs:1000,params,firstResponseId:id+'-attempt-1',secondResponseId:id+'-attempt-2'}));await delay(1000,undefined,{signal});f=await attempt(2);}
     if(!obj(f)||f.value!==null&&(!Number.isSafeInteger(f.value)||Number(f.value)<0))throw Error('DAMM_FEE_UNAVAILABLE');return f.value as number|null;
   };
   let feeIds=['damm-entry-fee','damm-exit-fee'];let fees=await Promise.all([feeFor(feeIds[0],entry),feeFor(feeIds[1],exit)]);
   if(fees.some(f=>f===null)){blockId='damm-blockhash-retry';await refresh();feeIds=['damm-entry-fee-retry','damm-exit-fee-retry'];fees=await Promise.all([feeFor(feeIds[0],entry),feeFor(feeIds[1],exit)]);}
   if(fees.some(f=>f===null))throw Error('DAMM_FEE_UNAVAILABLE');
   const tx=new VersionedTransaction(message([ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...entry,...exit])),wire=Buffer.from(tx.serialize());if(wire.length>1232)throw Error('DAMM_SIMULATION_TRANSACTION_TOO_LARGE');
   const simulation=await read('damm-simulation','simulateTransaction',[wire.toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'finalized',minContextSlot:state.slot,accounts:{encoding:'base64',addresses:[user.toBase58(),baseAta.toBase58(),quoteAta.toBase58(),state.pool.tokenAVault.toBase58(),state.pool.tokenBVault.toBase58()]}}]);
   const proof=verifyDammSimulation(state,q,simulation,tx,user,baseInfo);
   venue.entryExternalCostUsd=new Decimal(Number(fees[0])).add(proof.setupLamports).div(1e9).mul(price).toFixed();venue.exitExternalCostUsd=new Decimal(Number(fees[1])).div(1e9).mul(price).toFixed();venue.costsReconciled=true;venue.simulation={setupVerified:true,buySucceeded:true,sellSucceeded:true};delete errors.execution;
   simulationProof={method:'damm-pre-post-v1',wireBase64:wire.toString('base64'),user:user.toBase58(),feeIds,blockId,setupLamports:proof.setupLamports};
  }catch(e){errors.simulation=e instanceof Error&&/^DAMM_/.test(e.message)?e.message:safeRpcCode(e);}
  retain('damm-calculation',JSON.stringify({method:'damm-native-b-v1',pool:poolAddress,minSlot,slot:state.slot,nativeUsd:price,quoteAtomic:q.quote.toString(),acquiredAtomic:q.buy.swapOutAmount.toString(),exitAtomic:q.sell.swapOutAmount.toString(),simulationProof}));
  retain('damm-requests',JSON.stringify({method:'damm-read-requests-v1',requests}));venue.evidenceIds=[...inspection.evidenceIds];inspection.availableAt=now();return {inspection,controls,venue,rawArtifacts,retrievedAt,marketEvidence};
 }catch(e){retain('damm-requests',JSON.stringify({method:'damm-read-requests-v1',requests}));errors[inspection.bindingVerified?'execution':'binding']=e instanceof Error&&/^DAMM_/.test(e.message)?e.message:safeRpcCode(e);inspection.availableAt=now();return {inspection,controls,rawArtifacts,retrievedAt,marketEvidence};}
}
/** Both swaps use the acquired size; closed WSOL and complete balance vectors reconcile all native movement. */
export function verifyDammSimulation(state:ReturnType<typeof decodeDammState>,q:ReturnType<typeof quoteDamm>,response:unknown,tx:VersionedTransaction,user:PublicKey,baseBefore:AccountInfo<Buffer>|null){
 const reject=():never=>{throw Error('DAMM_SIMULATION_DELTA_MISMATCH');};
 if(!obj(response)||!obj(response.context)||!Number.isSafeInteger(response.context.slot)||Number(response.context.slot)<state.slot||!obj(response.value))return reject();
 const v=response.value;if(v.err!==null)throw Error('DAMM_SIMULATION_REJECTED');
 const integer=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
 const keys=tx.message.staticAccountKeys.map(k=>k.toBase58()),baseAta=getAssociatedTokenAddressSync(state.pool.tokenAMint,user,true),quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,user,true);
 const indices=[user,baseAta,quoteAta,state.pool.tokenAVault,state.pool.tokenBVault].map(k=>keys.indexOf(k.toBase58()));
 if(tx.message.addressTableLookups.length||tx.message.header.numRequiredSignatures!==1||keys[0]!==user.toBase58()||new Set(keys).size!==keys.length||indices.some(i=>i<0)||!integer(v.fee)||!Array.isArray(v.preBalances)||!Array.isArray(v.postBalances)||v.preBalances.length!==keys.length||v.postBalances.length!==keys.length||!v.preBalances.every(integer)||!v.postBalances.every(integer)||!Array.isArray(v.preTokenBalances)||!Array.isArray(v.postTokenBalances)||!obj(v.loadedAddresses)||!Array.isArray(v.loadedAddresses.writable)||v.loadedAddresses.writable.length||!Array.isArray(v.loadedAddresses.readonly)||v.loadedAddresses.readonly.length||!Array.isArray(v.accounts)||v.accounts.length!==5)return reject();
 const pre=v.preBalances as number[],post=v.postBalances as number[],[payer,base,quote,va,vb]=indices;
 if(pre[quote]!==0||post[quote]!==0||pre[base]!==Number(baseBefore?.lamports??0)||pre[va]!==post[va])return reject();
 for(let i=0;i<keys.length;i++)if(![payer,base,vb].includes(i)&&pre[i]!==post[i])return reject();
 if(v.accounts[2]!==null){const closed=account(v.accounts[2]);if(closed.lamports!==0||closed.data.length||!closed.owner.equals(PublicKey.default)||closed.executable)return reject();}
 const afterUser=account(v.accounts[0]),afterBase=account(v.accounts[1]),afterA=account(v.accounts[3]),afterB=account(v.accounts[4]);
 if(!afterUser.owner.equals(PublicKey.default)||afterUser.executable||afterUser.lamports!==post[payer]||afterBase.lamports!==post[base]||afterA.lamports!==post[va]||afterB.lamports!==post[vb])return reject();
 owned(afterBase,TOKEN_PROGRAM_ID);if(afterBase.data.length!==165)return reject();const ab=AccountLayout.decode(afterBase.data),beforeBase=baseBefore?AccountLayout.decode(baseBefore.data):null;
 if(!ab.mint.equals(state.pool.tokenAMint)||!ab.owner.equals(user)||ab.state!==1||ab.amount!==(beforeBase?.amount??0n)||ab.delegateOption||ab.closeAuthorityOption)return reject();
 const tokenRows=(rows:unknown[])=>{const map=new Map<number,{amount:bigint;mint:string;owner:string;decimals:number}>();for(const item of rows){if(!obj(item)||!integer(item.accountIndex)||item.accountIndex>=keys.length||map.has(item.accountIndex)||typeof item.mint!=='string'||typeof item.owner!=='string'||item.programId!==TOKEN_PROGRAM_ID.toBase58()||!obj(item.uiTokenAmount)||typeof item.uiTokenAmount.amount!=='string'||!/^(0|[1-9]\d{0,19})$/.test(item.uiTokenAmount.amount)||!integer(item.uiTokenAmount.decimals))return reject();map.set(item.accountIndex,{amount:BigInt(item.uiTokenAmount.amount),mint:item.mint,owner:item.owner,decimals:item.uiTokenAmount.decimals});}return map;};
 if(baseBefore){owned(baseBefore,TOKEN_PROGRAM_ID);if(baseBefore.data.length!==165)return reject();const prior=AccountLayout.decode(baseBefore.data);if(!prior.mint.equals(state.pool.tokenAMint)||!prior.owner.equals(user)||prior.state!==1)return reject();}
 const before=tokenRows(v.preTokenBalances),after=tokenRows(v.postTokenBalances),auth=derivePoolAuthority().toBase58();
 const bound=(row:ReturnType<typeof tokenRows> extends Map<number,infer T>?T|undefined:never,mint:PublicKey,owner:string,decimals:number)=>!!row&&row.mint===mint.toBase58()&&row.owner===owner&&row.decimals===decimals;
 if(before.has(quote)||after.has(quote)||!bound(after.get(base),state.pool.tokenAMint,user.toBase58(),state.a.decimals)||after.get(base)!.amount!==ab.amount||beforeBase&&(!bound(before.get(base),state.pool.tokenAMint,user.toBase58(),state.a.decimals)||before.get(base)!.amount!==beforeBase.amount)||!beforeBase&&before.has(base))return reject();
 const av=vault(afterA,state.pool.tokenAMint),bv=vault(afterB,NATIVE_MINT);
 for(const [i,mint,decimals]of [[va,state.pool.tokenAMint,state.a.decimals],[vb,NATIVE_MINT,9]] as const)if(!bound(before.get(i),mint,auth,decimals)||!bound(after.get(i),mint,auth,decimals))return reject();
 if(before.get(va)!.amount!==av.amount||after.get(va)!.amount!==av.amount||after.get(vb)!.amount!==bv.amount)return reject();
 const nativeDelta=BigInt(post[vb])-BigInt(pre[vb]);if(bv.amount-before.get(vb)!.amount!==nativeDelta)return reject();
 const setup=BigInt(post[base])-BigInt(pre[base]);if(setup<0n||baseBefore&&setup!==0n||BigInt(pre[payer])-BigInt(post[payer])!==BigInt(v.fee)+setup+nativeDelta||BigInt(q.quote.toString())-nativeDelta<=0n)return reject();
 const legs=dammLegs(state,q,user),expected=new TransactionMessage({payerKey:user,recentBlockhash:tx.message.recentBlockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...legs.entry,...legs.exit]}).compileToV0Message();
 if(!Buffer.from(expected.serialize()).equals(Buffer.from(tx.message.serialize()))||tx.signatures.some(s=>s.some(b=>b!==0)))return reject();
 return {setupLamports:setup.toString()};
}

export function validateDammBundle(bundle:LiveBundle){
 const raw=bundle.rawArtifacts,selection=raw['damm-route-selection'];if(!selection&&!Object.keys(raw).some(id=>id.startsWith('damm-')))return;
 const reject=():never=>{throw Error('DAMM_PROOF_INVALID');};
 const route=JSON.parse(selection??'null'),packet=JSON.parse(raw['shared-derivation']??'null') as {venueInspection:VenueInspection;venue?:VenueFacts;baseline:ReturnType<typeof deriveBaseline>};
 if(!route||route.method!=='verified-native-route-v1'||route.selected!=='METEORA_DAMM_V2'||typeof route.pool!=='string'||!packet?.venueInspection||![DAMM_VERSION,EMPTY_DAMM_VERSION].includes(packet.venueInspection.version)||packet.venueInspection.poolAddress!==route.pool)return reject();
 const venueIds=['O08','O09','O10','O11','O12','O13','O14','O15','O16'];
 const expected=deriveBaseline({sharedMode:true,token:bundle.token,cutoff:bundle.cutoff,profile:bundle.profile,features:bundle.features.filter(f=>!venueIds.includes(f.id)),evidence:bundle.evidence,observations:bundle.observations,venue:packet.venue,venueInspection:packet.venueInspection});
 const actual=JSON.parse(raw['shared-derivation']).baseline as ReturnType<typeof deriveBaseline>;
 for(const id of venueIds)if(JSON.stringify(expected.find(a=>a.id===id))!==JSON.stringify(actual.find(a=>a.id===id)))return reject();
 const requests=JSON.parse(raw['damm-requests']??'null');if(requests?.method!=='damm-read-requests-v1'||!obj(requests.requests))return reject();
 const canonicalSlot=JSON.parse(raw['rpc-account']).result.context.slot,scout=JSON.parse(raw['native-route-scout']??'null'),minSlot=scout?.result?.context?.slot,pool=new PublicKey(route.pool),inspection=packet.venueInspection;
 const scoutRecord=bundle.evidence.find(e=>e.id==='native-route-scout'&&e.sourceId==='venue-discovery-rpc'&&e.accessMode==='PUBLIC_API'),scoutIndex=route.candidatePools?.indexOf(route.pool);
 if(!Number.isSafeInteger(minSlot)||minSlot<canonicalSlot||!scoutRecord||!Array.isArray(route.candidatePools)||route.candidatePools.length>2||new Set(route.candidatePools).size!==route.candidatePools.length||JSON.stringify(route.candidatePools)!==JSON.stringify(scoutRecord.scope.candidatePools)||scoutIndex<0||scout.result?.value?.length!==route.candidatePools.length||scout.result.value[scoutIndex]?.owner!==CP_AMM_PROGRAM_ID.toBase58()||scout.result.value[scoutIndex]?.executable!==false)return reject();
 for(const [id,request]of Object.entries(requests.requests)){if(!obj(request)||!['getMultipleAccounts','getAccountInfo','getLatestBlockhash','getFeeForMessage','simulateTransaction'].includes(String(request.method))||!Array.isArray(request.params))return reject();if(raw[id]&&!bundle.evidence.some(e=>e.id===id&&e.sourceId==='meteora-damm-direct'&&e.accessMode==='PUBLIC_API'&&e.scope.mint===bundle.token.address))return reject();}
 if(inspection.version===EMPTY_DAMM_VERSION){
  if(!inspection.bindingVerified||packet.venue||!inspection.screening||inspection.removableLiquidityFraction!==undefined||inspection.executionDisabled!==undefined||Object.keys(raw).some(id=>/^damm-(?:simulation|entry-fee|exit-fee|payers|user-accounts|blockhash)/.test(id)))return reject();
  const state=decodeEmptyDammState(raw['damm-state'],bundle.token,pool,minSlot),initial=JSON.parse(raw['damm-pool']).result,first=decodePool(account(initial.value[0]));
  const poolParams=[[pool.toBase58()],{encoding:'base64',commitment:'finalized',minContextSlot:minSlot}],stateParams=[[pool.toBase58(),bundle.token.address,NATIVE_MINT.toBase58(),first.tokenAVault.toBase58(),first.tokenBVault.toBase58()],{encoding:'base64',commitment:'finalized',minContextSlot:initial.context.slot}];
  if(!Number.isSafeInteger(initial.context.slot)||initial.context.slot<minSlot||state.slot<initial.context.slot||requests.requests['damm-pool']?.method!=='getMultipleAccounts'||JSON.stringify(requests.requests['damm-pool'].params)!==JSON.stringify(poolParams)||requests.requests['damm-state']?.method!=='getMultipleAccounts'||JSON.stringify(requests.requests['damm-state'].params)!==JSON.stringify(stateParams)||!first.tokenAVault.equals(state.pool.tokenAVault)||!first.tokenBVault.equals(state.pool.tokenBVault))return reject();
  const programRequest=[CP_AMM_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:state.slot,dataSlice:{offset:0,length:36}}],programResult=JSON.parse(raw['damm-program']).result;if(requests.requests['damm-program']?.method!=='getAccountInfo'||JSON.stringify(requests.requests['damm-program'].params)!==JSON.stringify(programRequest)||!Number.isSafeInteger(programResult?.context?.slot)||programResult.context.slot<state.slot)return reject();
  const header=decodeProgramHeader(programResult,CP_AMM_PROGRAM_ID.toBase58());if(header.programDataAddress){const params=[header.programDataAddress,{encoding:'base64',commitment:'finalized',minContextSlot:state.slot,dataSlice:{offset:0,length:45}}],value=JSON.parse(raw['damm-program-data']).result;if(requests.requests['damm-program-data']?.method!=='getAccountInfo'||JSON.stringify(requests.requests['damm-program-data'].params)!==JSON.stringify(params)||!Number.isSafeInteger(value?.context?.slot)||value.context.slot<state.slot)return reject();resolveProgramData(header,value,[]);}else if(raw['damm-program-data'])return reject();
  const expectedRequestIds=['damm-pool','damm-state','damm-program',...(header.programDataAddress?['damm-program-data']:[])];if(JSON.stringify(Object.keys(requests.requests))!==JSON.stringify(expectedRequestIds))return reject();
  const at=bundle.evidence.find(e=>e.id==='damm-state'),calc=JSON.parse(raw['damm-calculation']??'null'),s=inspection.screening;
  const expectedIds=['rpc-genesis','damm-pool',...Object.keys(raw).filter(id=>id==='pump-sol-usd'||id.startsWith('pump-sol-usd-')),'damm-state','damm-program',...(header.programDataAddress?['damm-program-data']:[]),'damm-calculation','damm-requests'];
  if(!at||expectedIds.some(id=>!bundle.evidence.some(e=>e.id===id))||!bundle.evidence.some(e=>e.id==='damm-calculation'&&e.sourceId==='meteora-damm-derived')||!bundle.evidence.some(e=>e.id==='damm-requests'&&e.sourceId==='meteora-damm-derived')||s.method!==EMPTY_DAMM_METHOD||s.version!==EMPTY_DAMM_VERSION||s.token.chain!==bundle.token.chain||s.token.address!==bundle.token.address||s.pool!==route.pool||s.minSlot!==minSlot||s.slot!==state.slot||s.assetSide!==state.assetSide||s.assetProgram!==state.assetProgram||s.assetVault!==state.assetVault||s.nativeVault!==state.nativeVault||s.liquidityAtomic!=='0'||s.permanentLockLiquidityAtomic!=='0'||s.availableAt!==at.retrievedAt||s.expiresAt!==new Date(Date.parse(s.availableAt)+30000).toISOString()||inspection.certificateId!=='meteora-damm-v2-native-empty:'+route.pool||JSON.stringify(calc)!==JSON.stringify(s)||JSON.stringify(s.evidenceIds)!==JSON.stringify(expectedIds)||JSON.stringify(s.evidenceIds)!==JSON.stringify(inspection.evidenceIds))return reject();
  return;
 }
 if(!inspection.bindingVerified){if(packet.venue)return reject();return;}
 const state=decodeDammState(raw['damm-state'],bundle.token,pool,minSlot),expectedKeys=[pool.toBase58(),bundle.token.address,NATIVE_MINT.toBase58(),state.pool.tokenAVault.toBase58(),state.pool.tokenBVault.toBase58()];
 if(JSON.stringify(requests.requests['damm-state'].params)!==JSON.stringify([expectedKeys,{encoding:'base64',commitment:'finalized',minContextSlot:JSON.parse(raw['damm-pool']).result.context.slot}])||inspection.certificateId!=='meteora-damm-v2-native-b:'+route.pool||inspection.removableLiquidityFraction!==state.removable)return reject();
 for(const id of ['damm-program',...(raw['damm-program-data']?['damm-program-data']:[])]){const result=JSON.parse(raw[id]).result;if(!Number.isSafeInteger(result?.context?.slot)||result.context.slot<state.slot)return reject();}
 const header=decodeProgramHeader(JSON.parse(raw['damm-program']).result,CP_AMM_PROGRAM_ID.toBase58());if(requests.requests['damm-program']?.params?.[0]!==CP_AMM_PROGRAM_ID.toBase58())return reject();if(header.programDataAddress){if(requests.requests['damm-program-data']?.params?.[0]!==header.programDataAddress)return reject();resolveProgramData(header,JSON.parse(raw['damm-program-data']).result,[]);}
 if(!packet.venue)return;
 const calc=JSON.parse(raw['damm-calculation']),native=parseDexPairs(JSON.parse(raw['pump-sol-usd']),'solana',NATIVE_MINT.toBase58()).pairs.find(p=>p.baseAddress===NATIVE_MINT.toBase58()&&p.quoteAddress==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'&&p.priceUsd)?.priceUsd;if(!native)return reject();
 const at=bundle.evidence.find(e=>e.id==='damm-state')!,priceAt=bundle.evidence.find(e=>e.id==='pump-sol-usd')!,q=quoteDamm(state,bundle.profile,native,at.retrievedAt),v=packet.venue;
 const expires=new Date(Math.min(Date.parse(at.retrievedAt),Date.parse(priceAt.retrievedAt))+30000).toISOString();
 if(calc.method!=='damm-native-b-v1'||calc.pool!==route.pool||calc.minSlot!==minSlot||calc.slot!==state.slot||calc.nativeUsd!==native||calc.quoteAtomic!==q.quote.toString()||calc.acquiredAtomic!==q.buy.swapOutAmount.toString()||calc.exitAtomic!==q.sell.swapOutAmount.toString()||v.certificateId!==inspection.certificateId||v.version!==DAMM_VERSION||!v.bindingVerified||v.token.chain!==bundle.token.chain||v.token.address!==bundle.token.address||v.availableAt!==at.retrievedAt||v.expiresAt!==expires||v.entryQuoteUsd!==bundle.profile.sizeUsd||v.acquiredAtomic!==q.buy.swapOutAmount.toString()||v.exitQuantityAtomic!==v.acquiredAtomic||v.exitQuoteUsd!==q.exitUsd||v.referencePriceUsd!==q.reference||v.embeddedFeesUsd!==q.feesUsd||v.decimals!==state.a.decimals||v.removableLiquidityFraction!==state.removable||v.method!=='INDEPENDENT_QUOTES')return reject();
 for(const [id,source]of Object.entries(raw).filter(([id])=>/^damm-(?:entry|exit)-fee(?:-retry)?-recovery$/.test(id))){
  const receipt=JSON.parse(source),base=id.replace(/-recovery$/,''),first=bundle.evidence.find(e=>e.id===receipt.firstResponseId),second=bundle.evidence.find(e=>e.id===receipt.secondResponseId),marker=bundle.evidence.find(e=>e.id===id);
  if(receipt.method!=='damm-fee-min-context-retry-v1'||receipt.delayMs!==1000||receipt.firstResponseId!==base+'-attempt-1'||receipt.secondResponseId!==base+'-attempt-2'||JSON.stringify(receipt.params)!==JSON.stringify(requests.requests[base]?.params)||!first||first.sourceId!=='meteora-damm-direct'||JSON.parse(raw[first.id]).error?.code!==-32016||!marker||marker.sourceId!=='meteora-damm-derived'||Date.parse(marker.availableAt)<Date.parse(first.availableAt)||second&&(second.sourceId!=='meteora-damm-direct'||Date.parse(second.availableAt)<Date.parse(marker.availableAt))||raw[base]&&(!second||raw[base]!==raw[second.id]))return reject();
 }
 if(v.costsReconciled){
  const proof=calc.simulationProof;if(proof?.method!=='damm-pre-post-v1')return reject();
  const tx=VersionedTransaction.deserialize(Buffer.from(proof.wireBase64,'base64')),user=new PublicKey(proof.user),baseAta=getAssociatedTokenAddressSync(state.pool.tokenAMint,user,true),quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,user,true);
  const userReq=requests.requests['damm-user-accounts'].params[0] as string[],baseIndex=userReq.indexOf(baseAta.toBase58()),accounts=JSON.parse(raw['damm-user-accounts']).result.value;if(baseIndex<0||userReq[baseIndex+1]!==quoteAta.toBase58()||accounts[baseIndex+1]!==null)return reject();
  const baseBefore=accounts[baseIndex]===null?null:account(accounts[baseIndex]),simulation=JSON.parse(raw['damm-simulation']).result,verified=verifyDammSimulation(state,q,simulation,tx,user,baseBefore);
  if(proof.setupLamports!==verified.setupLamports||JSON.stringify(requests.requests['damm-simulation'].params)!==JSON.stringify([proof.wireBase64,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'finalized',minContextSlot:state.slot,accounts:{encoding:'base64',addresses:[user.toBase58(),baseAta.toBase58(),quoteAta.toBase58(),state.pool.tokenAVault.toBase58(),state.pool.tokenBVault.toBase58()]}}]))return reject();
  if(proof.blockId==='damm-blockhash-retry'&& !['damm-entry-fee','damm-exit-fee'].some(id=>JSON.parse(raw[id]??'null')?.result?.value===null))return reject();
  const legs=dammLegs(state,q,user),block=JSON.parse(raw[proof.blockId]).result.value.blockhash;
  if(!['damm-blockhash','damm-blockhash-retry'].includes(proof.blockId)||JSON.stringify(proof.feeIds)!==JSON.stringify(proof.blockId==='damm-blockhash'?['damm-entry-fee','damm-exit-fee']:['damm-entry-fee-retry','damm-exit-fee-retry']))return reject();
  const fees=(proof.feeIds as string[]).map((id,i)=>{const message=new TransactionMessage({payerKey:user,recentBlockhash:block,instructions:i?legs.exit:legs.entry}).compileToV0Message();const params=requests.requests[id].params;if(params[0]!==Buffer.from(message.serialize()).toString('base64')||params[1]?.commitment!=='finalized'||!Number.isSafeInteger(params[1]?.minContextSlot)||params[1].minContextSlot<state.slot)return reject();const fee=JSON.parse(raw[id]).result?.value;if(!Number.isSafeInteger(fee)||fee<0)return reject();return fee;});
  if(v.entryExternalCostUsd!==new Decimal(fees[0]).add(verified.setupLamports).div(1e9).mul(native).toFixed()||v.exitExternalCostUsd!==new Decimal(fees[1]).div(1e9).mul(native).toFixed()||JSON.stringify(v.simulation)!==JSON.stringify({setupVerified:true,buySucceeded:true,sellSucceeded:true}))return reject();
 }else if(v.simulation)return reject();

}
