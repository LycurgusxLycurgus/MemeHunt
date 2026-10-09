import { Decimal } from 'decimal.js';
import BN from 'bn.js';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, type AccountInfo } from '@solana/web3.js';
import { AccountLayout, MintLayout, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_AMM_SDK, OFFLINE_PUMP_AMM_PROGRAM, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, pumpPoolAuthorityPda, poolPda, lpMintPda, buyQuoteInput, buyBaseInput, sellBaseInput, type SwapSolanaState } from '@pump-fun/pump-swap-sdk';
import type { ControlFacts, HolderFacts, VenueFacts, VenueInspection } from '../domain/baseline.js';
import type { Profile, TokenRef } from '../domain/contracts.js';
import { dexArtifacts, fetchDexPairs, type DexArtifact, type DexRead, type DexRecoveryOptions } from './dexscreener.js';
import { solanaRpc, safeRpcCode, PUBLIC_SOLANA_RPC, decodeProgramHeader, resolveProgramData, decodeRawMintControls } from './solana.js';

export type PumpSwapRead={inspection:VenueInspection;controls?:ControlFacts;venue?:VenueFacts;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;marketEvidence?:Record<string,DexArtifact>};
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const obj=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
function account(value:unknown):AccountInfo<Buffer>{
  if(!obj(value)||typeof value.owner!=='string'||!Array.isArray(value.data)||value.data[1]!=='base64'||typeof value.data[0]!=='string'||typeof value.executable!=='boolean'||!Number.isSafeInteger(value.lamports)||Number(value.lamports)<0)throw new Error('RPC_SHAPE');
  const data=Buffer.from(value.data[0],'base64');if(data.toString('base64')!==value.data[0])throw new Error('RPC_SHAPE');
  return {owner:new PublicKey(value.owner),data,executable:value.executable,lamports:Number(value.lamports),rentEpoch:0};
}
function owned(info:AccountInfo<Buffer>,owner:PublicKey){if(!info.owner.equals(owner)||info.executable)throw new Error('PUMP_ACCOUNT_BINDING');}
function vault(info:AccountInfo<Buffer>,program:PublicKey,mint:PublicKey,pool:PublicKey){
  owned(info,program);if(info.data.length<165)throw new Error('PUMP_ACCOUNT_BINDING');const a=AccountLayout.decode(info.data);
  if(!a.mint.equals(mint)||!a.owner.equals(pool)||a.state!==1||a.delegateOption!==0||a.closeAuthorityOption!==0)throw new Error('PUMP_ACCOUNT_BINDING');return a;
}

/** Only read RPCs and unsigned simulation. No signer or send/broadcast method exists here. */
export async function inspectPumpSwap(token:TokenRef,profile:Profile,controls:ControlFacts|undefined,holders:HolderFacts|undefined,minSlot:number,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal,recovery?:DexRecoveryOptions,wait:(ms:number,signal?:AbortSignal)=>Promise<void>=(ms,s)=>delay(ms,undefined,{signal:s})):Promise<PumpSwapRead>{
  const mint=new PublicKey(token.address),poolKey=poolPda(0,pumpPoolAuthorityPda(mint),mint,NATIVE_MINT);
  const rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={},errors:Record<string,string>={};
  let solMarket:DexRead|undefined;
  const marketEvidence:Record<string,DexArtifact>={};
  const acquirePrice=async()=>{
    solMarket=await fetchDexPairs('solana',NATIVE_MINT.toBase58(),fetcher,recovery?now:undefined,recovery);
    if(recovery){for(const [id,a] of Object.entries(dexArtifacts(solMarket,'pump-sol-usd','solana',NATIVE_MINT.toBase58(),now()))){marketEvidence[id]=a;rawArtifacts[id]=a.raw;retrievedAt[id]=a.retrievedAt;inspection.evidenceIds.push(id);}}
    else if(solMarket.raw){rawArtifacts['pump-sol-usd']=solMarket.raw;retrievedAt['pump-sol-usd']=now();inspection.evidenceIds.push('pump-sol-usd');}
  };
  const inspection:VenueInspection={token,poolAddress:poolKey.toBase58(),certificateId:'',version:'pumpswap-sdk-1.20.0-canonical-wsol-v1',availableAt:now(),bindingVerified:false,evidenceIds:['rpc-genesis'],errors,limitations:['Canonical WSOL PumpSwap only; live binding is not a code audit or future upgrade guarantee.']};
  const read=async(id:string,method:string,params:unknown[])=>{const r=await solanaRpc(url,method,params,fetcher,undefined,signal);rawArtifacts[id]=r.raw;retrievedAt[id]=now();inspection.evidenceIds.push(id);return r.value;};
  let slot=minSlot,resolvedControls:ControlFacts|undefined;
  const multiple=async(id:string,keys:PublicKey[])=>{
    const r=await read(id,'getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized',minContextSlot:slot}]);
    if(!obj(r)||!obj(r.context)||!Number.isSafeInteger(r.context.slot)||Number(r.context.slot)<slot||!Array.isArray(r.value)||r.value.length!==keys.length)throw new Error('RPC_SHAPE');slot=Number(r.context.slot);
    return r.value.map(v=>v===null?null:account(v));
  };
  const single=async(id:string,key:PublicKey,length:number)=>{
    const r=await read(id,'getAccountInfo',[key.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:slot,dataSlice:{offset:0,length}}]);
    if(!obj(r)||!obj(r.context)||!Number.isSafeInteger(r.context.slot)||Number(r.context.slot)<slot)throw new Error('RPC_SHAPE');return r;
  };
  try {
    const [poolInfo,globalInfo,feeInfo]=await multiple('pump-pool-config',[poolKey,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA]);
    if(!poolInfo||!globalInfo||!feeInfo)throw new Error('PUMP_STATE_MISSING');
    owned(poolInfo,PUMP_AMM_PROGRAM_ID);owned(globalInfo,PUMP_AMM_PROGRAM_ID);owned(feeInfo,PUMP_FEE_PROGRAM_ID);
    let pool=PUMP_AMM_SDK.decodePool(poolInfo),globalConfig=PUMP_AMM_SDK.decodeGlobalConfig(globalInfo),feeConfig=PUMP_AMM_SDK.decodeFeeConfig(feeInfo);
    if(pool.index!==0||!pool.creator.equals(pumpPoolAuthorityPda(mint))||!pool.baseMint.equals(mint)||!pool.quoteMint.equals(NATIVE_MINT)||!poolKey.equals(poolPda(pool.index,pool.creator,pool.baseMint,pool.quoteMint))||!pool.lpMint.equals(lpMintPda(poolKey)))throw new Error('PUMP_ACCOUNT_BINDING');
    // Discovery is not numeric evidence. Capture every coupled input from one finalized bank.
    const discovered=pool;
    // Slow price recovery must finish before the bank used for executable numeric inputs.
    if(recovery)await acquirePrice();
    const [currentPoolInfo,currentGlobalInfo,currentFeeInfo,baseInfo,quoteInfo,baseVaultInfo,quoteVaultInfo,lpInfo]=await multiple('pump-mints-vaults',[poolKey,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,mint,NATIVE_MINT,discovered.poolBaseTokenAccount,discovered.poolQuoteTokenAccount,discovered.lpMint]);
    if(!currentPoolInfo||!currentGlobalInfo||!currentFeeInfo)throw new Error('PUMP_STATE_MISSING');
    owned(currentPoolInfo,PUMP_AMM_PROGRAM_ID);owned(currentGlobalInfo,PUMP_AMM_PROGRAM_ID);owned(currentFeeInfo,PUMP_FEE_PROGRAM_ID);
    pool=PUMP_AMM_SDK.decodePool(currentPoolInfo);globalConfig=PUMP_AMM_SDK.decodeGlobalConfig(currentGlobalInfo);feeConfig=PUMP_AMM_SDK.decodeFeeConfig(currentFeeInfo);
    if(pool.index!==0||!pool.creator.equals(pumpPoolAuthorityPda(mint))||!pool.baseMint.equals(mint)||!pool.quoteMint.equals(NATIVE_MINT)||!pool.lpMint.equals(lpMintPda(poolKey))||!pool.poolBaseTokenAccount.equals(discovered.poolBaseTokenAccount)||!pool.poolQuoteTokenAccount.equals(discovered.poolQuoteTokenAccount)||!pool.lpMint.equals(discovered.lpMint))throw new Error('PUMP_ACCOUNT_BINDING');
    const stateSlot=slot;
    if(!baseInfo||!quoteInfo||!baseVaultInfo||!quoteVaultInfo||!lpInfo)throw new Error('PUMP_STATE_MISSING');
    if(![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(baseInfo.owner.toBase58()))throw new Error('PUMP_ACCOUNT_BINDING');
    owned(quoteInfo,TOKEN_PROGRAM_ID);if(baseInfo.executable||baseInfo.data.length<82||quoteInfo.data.length!==82)throw new Error('PUMP_ACCOUNT_BINDING');
    const baseMintAccount=MintLayout.decode(baseInfo.data),quoteMintAccount=MintLayout.decode(quoteInfo.data);
    if(!baseMintAccount.isInitialized||!quoteMintAccount.isInitialized||quoteMintAccount.decimals!==9)throw new Error('PUMP_ACCOUNT_BINDING');
    const baseVault=vault(baseVaultInfo,baseInfo.owner,mint,poolKey),quoteVault=vault(quoteVaultInfo,TOKEN_PROGRAM_ID,NATIVE_MINT,poolKey);
    if(!pool.poolBaseTokenAccount.equals(getAssociatedTokenAddressSync(mint,poolKey,true,baseInfo.owner))||!pool.poolQuoteTokenAccount.equals(getAssociatedTokenAddressSync(NATIVE_MINT,poolKey,true,TOKEN_PROGRAM_ID)))throw new Error('PUMP_ACCOUNT_BINDING');
    const program=decodeProgramHeader(await single('pump-program',PUMP_AMM_PROGRAM_ID,36),PUMP_AMM_PROGRAM_ID.toBase58());
    if(program.programDataAddress){const resolved=resolveProgramData(program,await single('pump-program-data',new PublicKey(program.programDataAddress),45),[]);inspection.limitations.push(resolved.immutable?'Venue deployment immutable.':`Venue upgrade authority observed: ${resolved.upgradeAuthority}; admin ${globalConfig.admin.toBase58()} can change fee/disable settings.`);}
    resolvedControls=decodeRawMintControls({context:{slot},value:{owner:baseInfo.owner.toBase58(),data:[baseInfo.data.toString('base64'),'base64']}},['rpc-genesis','pump-mints-vaults']);
    controls=resolvedControls;
    inspection.bindingVerified=true;inspection.certificateId=`pumpswap-canonical-wsol:${poolKey.toBase58()}`;
    inspection.executionDisabled=!!(globalConfig.disableFlags&24);
    try{
      if(!lpInfo.owner.equals(TOKEN_2022_PROGRAM_ID)&&!lpInfo.owner.equals(TOKEN_PROGRAM_ID)||lpInfo.executable||lpInfo.data.length<82)throw new Error('PUMP_LP_UNSUPPORTED');
      const lpControls=decodeRawMintControls({context:{slot},value:{owner:lpInfo.owner.toBase58(),data:[lpInfo.data.toString('base64'),'base64']}});
      if(!lpControls.complete||!lpControls.transferAllowed||lpControls.currentFeeBps!=='0'||!lpControls.feeImmutable)throw new Error('PUMP_LP_UNSUPPORTED');
      const lp=MintLayout.decode(lpInfo.data);
      if(!lp.isInitialized||lp.mintAuthorityOption!==1||!lp.mintAuthority.equals(poolKey)||lp.freezeAuthorityOption!==0||pool.lpSupply.lte(new BN(0))||new BN(lp.supply.toString()).gt(pool.lpSupply))throw new Error('PUMP_LP_UNSUPPORTED');
      inspection.removableLiquidityFraction=new Decimal(lp.supply.toString()).div(pool.lpSupply.toString()).toFixed();
      inspection.limitations.push('All outstanding LP tokens assumed redeemable; direct burns reduce mint supply, not pool.lpSupply. No undocumented locker exemption.');
    }catch(e){errors.liquidity=e instanceof Error&&/^PUMP_/.test(e.message)?e.message:safeRpcCode(e);}
    if(!controls?.complete||controls.currentFeeBps!=='0'||!controls.feeImmutable||!controls.transferAllowed||pool.isMayhemMode||pool.virtualQuoteReserves.isNeg()||inspection.executionDisabled)throw new Error('PUMP_EXECUTION_MODE_UNSUPPORTED');
    if(!profile.sizeUsd||!inspection.removableLiquidityFraction)throw new Error('PUMP_EXECUTION_CONTEXT_MISSING');
    if(!recovery)await acquirePrice();
    const solUsd=solMarket?.market?.pairs.find(p=>p.baseAddress===NATIVE_MINT.toBase58()&&p.quoteAddress===USDC&&p.priceUsd!==null)?.priceUsd;
    if(!solUsd||new Decimal(solUsd).lte(0))throw new Error('PUMP_USD_PRICE_UNAVAILABLE');
    const priceAt=recovery?retrievedAt['pump-sol-usd']:retrievedAt['pump-mints-vaults'];
    if(recovery&&(!priceAt||Date.parse(now())-Date.parse(priceAt)>30_000||Date.parse(now())<Date.parse(priceAt)))throw new Error('PUMP_USD_PRICE_STALE');
    const price=new Decimal(solUsd),quote=new BN(new Decimal(profile.sizeUsd).div(price).mul(1e9).floor().toFixed(0));
    const stateArgs={baseReserve:new BN(baseVault.amount.toString()),quoteReserve:new BN(quoteVault.amount.toString()),virtualQuoteReserves:pool.virtualQuoteReserves,globalConfig,baseMintAccount,baseMint:mint,coinCreator:pool.coinCreator,creator:pool.creator,feeConfig,quoteMint:NATIVE_MINT,isMayhemMode:pool.isMayhemMode,creatorFeeBps:pool.creatorFeeBps,slippage:0};
    let buy:ReturnType<typeof buyQuoteInput>,actualBuy:ReturnType<typeof buyBaseInput>,sell:ReturnType<typeof sellBaseInput>;
    try{buy=buyQuoteInput({...stateArgs,quote});if(buy.base.lte(new BN(0)))throw new Error('PUMP_SIZE_UNQUOTABLE');actualBuy=buyBaseInput({...stateArgs,base:buy.base});sell=sellBaseInput({...stateArgs,base:buy.base});}
    catch(error){if(error instanceof Error&&error.message==='Insufficient real quote reserves to cover the sell output.')throw new Error('PUMP_EXIT_RESERVE_INSUFFICIENT');if(error instanceof Error&&/^PUMP_/.test(error.message))throw error;throw new Error('PUMP_QUOTE_INVALID');}
    if(sell.uiQuote.gt(stateArgs.quoteReserve))throw new Error('PUMP_EXIT_RESERVE_INSUFFICIENT');
    const reference=new Decimal(stateArgs.quoteReserve.add(pool.virtualQuoteReserves).toString()).div(1e9).mul(price).div(new Decimal(baseVault.amount.toString()).div(new Decimal(10).pow(baseMintAccount.decimals)));
    const quoteAt=retrievedAt['pump-mints-vaults'];
    const venue:VenueFacts={certificateId:inspection.certificateId,bindingVerified:true,version:inspection.version,token,availableAt:quoteAt,expiresAt:new Date(Date.parse(quoteAt)+30_000).toISOString(),removableLiquidityFraction:inspection.removableLiquidityFraction,lockExpiresAt:null,entryQuoteUsd:profile.sizeUsd,acquiredAtomic:buy.base.toString(),decimals:baseMintAccount.decimals,exitQuantityAtomic:buy.base.toString(),exitQuoteUsd:new Decimal(sell.uiQuote.toString()).add(quote.sub(actualBuy.uiQuote).toString()).div(1e9).mul(price).toFixed(),referencePriceUsd:reference.toFixed(),entryExternalCostUsd:'0',exitExternalCostUsd:'0',embeddedFeesUsd:new Decimal(actualBuy.uiQuote.sub(actualBuy.internalQuoteAmount).toString()).add(sell.internalQuoteAmountOut.sub(sell.uiQuote).toString()).div(1e9).mul(price).toFixed(),costsReconciled:false,method:'INDEPENDENT_QUOTES',evidenceIds:[]};
    if(recovery)venue.expiresAt=new Date(Math.min(Date.parse(quoteAt),Date.parse(priceAt))+30_000).toISOString();
    // Preserve quote evidence when simulation setup is unavailable. Unknown fees are never asserted zero.
    errors.execution='PUMP_TRANSACTION_COSTS_UNAVAILABLE';
    let simulationProof:Record<string,unknown>|undefined;
    try{
      const rankedOwners=[...(holders?.accounts??[])].filter(a=>BigInt(a.amount)>0n).sort((a,b)=>BigInt(a.amount)>BigInt(b.amount)?-1:BigInt(a.amount)<BigInt(b.amount)?1:0);
      let candidates=[...new Set(rankedOwners.map(a=>a.owner))].slice(0,5).map(a=>new PublicKey(a));
      let payerInfos=candidates.length?await multiple('pump-simulation-payers',candidates):[];
      const funded=(a:AccountInfo<Buffer>|null)=>!!a&&!a.executable&&a.owner.equals(PublicKey.default)&&BigInt(a.lamports)>=BigInt(quote.toString())+30_000_000n;
      const choose=async(id:string)=>{
        const indices=payerInfos.flatMap((a,i)=>funded(a)?[i]:[]);
        if(!indices.length)return undefined;
        const keys=indices.flatMap(i=>[getAssociatedTokenAddressSync(mint,candidates[i],true,baseInfo.owner),getAssociatedTokenAddressSync(NATIVE_MINT,candidates[i],true,TOKEN_PROGRAM_ID)]);
        const infos=await multiple(id,keys);
        let selected=indices.findIndex((_,i)=>infos[i*2]!==null&&infos[i*2+1]===null);
        if(selected<0)selected=indices.findIndex((_,i)=>infos[i*2+1]===null);
        if(selected<0)return undefined;
        return {index:indices[selected],base:infos[selected*2],quote:infos[selected*2+1]};
      };
      let selection=await choose('pump-simulation-user-accounts');
      if(!selection){
        // Verified protocol configuration supplies public simulation subjects, never user identity.
        const seen=new Set(candidates.map(k=>k.toBase58()));
        candidates=[...globalConfig.protocolFeeRecipients,globalConfig.admin].filter(k=>!k.equals(PublicKey.default)&&!seen.has(k.toBase58())&&!!seen.add(k.toBase58())).slice(0,8);
        payerInfos=candidates.length?await multiple('pump-simulation-fallback-payers',candidates):[];selection=await choose('pump-simulation-fallback-user-accounts');
      }
      if(!selection)throw new Error('PUMP_SIMULATION_PAYER_UNAVAILABLE');const index=selection.index,user=candidates[index];
      const baseAta=getAssociatedTokenAddressSync(mint,user,true,baseInfo.owner),quoteAta=getAssociatedTokenAddressSync(NATIVE_MINT,user,true,TOKEN_PROGRAM_ID);
      const userBaseAccountInfo=selection.base,userQuoteAccountInfo=selection.quote;
      if(userBaseAccountInfo){owned(userBaseAccountInfo,baseInfo.owner);const a=AccountLayout.decode(userBaseAccountInfo.data);if(!a.mint.equals(mint)||!a.owner.equals(user)||a.state!==1)throw new Error('PUMP_SIMULATION_SETUP_UNSUPPORTED');}
      if(userQuoteAccountInfo)throw new Error('PUMP_SIMULATION_EXISTING_WSOL_UNSUPPORTED');
      // The offline SDK randomly selects fee recipients for each instruction builder.
      // Pin one observed eligible recipient for both legs to avoid redundant account keys.
      const simulationConfig={...globalConfig,protocolFeeRecipients:globalConfig.protocolFeeRecipients.map(()=>globalConfig.protocolFeeRecipients[0]),buybackFeeRecipients:globalConfig.buybackFeeRecipients.map(()=>globalConfig.buybackFeeRecipients[0])};
      const state:SwapSolanaState={globalConfig:simulationConfig,feeConfig,poolKey,poolAccountInfo:currentPoolInfo,pool,poolBaseAmount:stateArgs.baseReserve,poolQuoteAmount:stateArgs.quoteReserve,baseTokenProgram:baseInfo.owner,quoteTokenProgram:TOKEN_PROGRAM_ID,baseMint:mint,baseMintAccount,user,userBaseTokenAccount:baseAta,userQuoteTokenAccount:quoteAta,userBaseAccountInfo,userQuoteAccountInfo};
      const buys=await PUMP_AMM_SDK.buyInstructions(state,buy.base,actualBuy.uiQuote),sells=await PUMP_AMM_SDK.sellInstructions(state,buy.base,new BN(0));
      let blockhash='',blockSlot=stateSlot;
      const refreshBlock=async(id:string)=>{const block=await read(id,'getLatestBlockhash',[{commitment:'finalized',minContextSlot:stateSlot}]);if(!obj(block)||!obj(block.value)||typeof block.value.blockhash!=='string')throw new Error('RPC_SHAPE');blockhash=block.value.blockhash;if(obj(block.context)&&Number.isSafeInteger(block.context.slot))blockSlot=Math.max(stateSlot,Number(block.context.slot));};
      await refreshBlock('pump-blockhash');
      const message=(instructions:typeof buys)=>new TransactionMessage({payerKey:user,recentBlockhash:blockhash,instructions}).compileToV0Message();
      const feeFor=async(id:string,instructions:typeof buys)=>{
        const params=[Buffer.from(message(instructions).serialize()).toString('base64'),{commitment:'finalized',minContextSlot:blockSlot}];
        const retain=(artifact:string,raw:string)=>{rawArtifacts[artifact]=raw;retrievedAt[artifact]=now();inspection.evidenceIds.push(artifact);};
        const attempt=async(index:number)=>{const r=await solanaRpc(url,'getFeeForMessage',params,fetcher,undefined,signal,recovery?raw=>retain(`${id}-min-context-attempt-${index}`,raw):undefined);retain(id,r.raw);retrievedAt[id]=retrievedAt[`${id}-min-context-attempt-${index}`]??retrievedAt[id];return r.value;};
        let response:unknown;
        if(!recovery)response=await read(id,'getFeeForMessage',params);
        else try{response=await attempt(1);}catch(error){
          if(safeRpcCode(error)!=='RPC_REMOTE_-32016'||signal?.aborted)throw error;
          retain(`${id}-min-context-recovery`,JSON.stringify({method:'fee-min-context-retry-v1',operation:'getFeeForMessage',params,code:'RPC_REMOTE_-32016',delayMs:1000,firstResponseId:`${id}-min-context-attempt-1`,secondResponseId:`${id}-min-context-attempt-2`}));
          await wait(1000,signal);signal?.throwIfAborted();response=await attempt(2);
        }
        if(!obj(response))throw new Error('RPC_SHAPE');if(response.value===null)return null;if(!Number.isSafeInteger(response.value)||Number(response.value)<0)throw new Error('RPC_SHAPE');return new Decimal(Number(response.value));
      };
      let entryFee=await feeFor('pump-entry-network-fee',buys),exitFee=await feeFor('pump-exit-network-fee',sells);
      if(entryFee===null||exitFee===null){
        // Fee is blockhash-specific. Preserve attempts and rebuild both messages once.
        await refreshBlock('pump-blockhash-retry');
        entryFee=await feeFor('pump-entry-network-fee-retry',buys);exitFee=await feeFor('pump-exit-network-fee-retry',sells);
      }
      if(entryFee===null||exitFee===null)throw new Error('PUMP_FEE_MESSAGE_UNAVAILABLE');
      venue.exitExternalCostUsd=exitFee.div(1e9).mul(price).toFixed();
      const combined=[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...buys,...sells],tx=new VersionedTransaction(message(combined));
      const wire=Buffer.from(tx.serialize());if(wire.length>1232)throw new Error('PUMP_SIMULATION_TRANSACTION_TOO_LARGE');
      const sim=await read('pump-roundtrip-simulation','simulateTransaction',[wire.toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'finalized',minContextSlot:stateSlot,accounts:{encoding:'base64',addresses:[user.toBase58(),baseAta.toBase58(),quoteAta.toBase58()]}}]);
      if(!obj(sim)||!obj(sim.context)||!Number.isSafeInteger(sim.context.slot)||Number(sim.context.slot)<stateSlot)throw new Error('PUMP_SIMULATION_STATE_CHANGED');
      if(!obj(sim.value)||sim.value.err!==null)throw new Error('PUMP_SIMULATION_REJECTED');
      const v=sim.value,keys=tx.message.staticAccountKeys.map(k=>k.toBase58()),payerIndex=keys.indexOf(user.toBase58()),baseIndex=keys.indexOf(baseAta.toBase58()),quoteIndex=keys.indexOf(quoteAta.toBase58());
      if(!Array.isArray(v.preBalances)||!Array.isArray(v.postBalances)||v.fee===undefined||v.fee===null||!Array.isArray(v.preTokenBalances)||!Array.isArray(v.postTokenBalances)||!obj(v.loadedAddresses)||!Array.isArray(v.loadedAddresses.writable)||!Array.isArray(v.loadedAddresses.readonly))throw new Error('PUMP_SIMULATION_BALANCES_UNAVAILABLE');
      const integer=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
      if(tx.message.addressTableLookups.length||v.loadedAddresses.writable.length||v.loadedAddresses.readonly.length||new Set(keys).size!==keys.length||payerIndex!==0||baseIndex<0||quoteIndex<0||tx.message.header.numRequiredSignatures!==1||!integer(v.fee)||v.preBalances.length!==keys.length||v.postBalances.length!==keys.length||!v.preBalances.every(integer)||!v.postBalances.every(integer))throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      const pre=v.preBalances as number[],post=v.postBalances as number[];
      const tokens=(entries:unknown[])=>{const map=new Map<number,{mint:string;owner:string;programId:string;amount:bigint;decimals:number}>();for(const e of entries){if(!obj(e)||!integer(e.accountIndex)||e.accountIndex>=keys.length||map.has(e.accountIndex)||typeof e.mint!=='string'||typeof e.owner!=='string'||typeof e.programId!=='string'||!obj(e.uiTokenAmount)||typeof e.uiTokenAmount.amount!=='string'||!/^(0|[1-9]\d{0,19})$/.test(e.uiTokenAmount.amount)||BigInt(e.uiTokenAmount.amount)>18446744073709551615n||!integer(e.uiTokenAmount.decimals)||e.uiTokenAmount.decimals>255)throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');map.set(e.accountIndex,{mint:e.mint,owner:e.owner,programId:e.programId,amount:BigInt(e.uiTokenAmount.amount),decimals:e.uiTokenAmount.decimals});}return map;};
      const beforeTokens=tokens(v.preTokenBalances),afterTokens=tokens(v.postTokenBalances);
      if(!Array.isArray(v.accounts)||v.accounts.length!==3||pre[quoteIndex]!==0||post[quoteIndex]!==0||beforeTokens.has(quoteIndex)||afterTokens.has(quoteIndex))throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      // Some RPCs return a closed-account tombstone instead of null.
      if(v.accounts[2]!==null){const closed=account(v.accounts[2]);if(closed.lamports!==0||closed.executable||!closed.owner.equals(PublicKey.default)||closed.data.length!==0)throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');}
      const afterBase=v.accounts[1]?account(v.accounts[1]):null,afterPayer=v.accounts[0]?account(v.accounts[0]):null;
      if(!afterBase||!afterPayer||!afterBase.owner.equals(baseInfo.owner)||!afterPayer.owner.equals(PublicKey.default)||afterPayer.lamports!==post[payerIndex]||afterBase.lamports!==post[baseIndex]||!Array.isArray(v.logs))throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      if(afterBase.executable||afterPayer.executable)throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      const afterToken=AccountLayout.decode(afterBase.data);if(!afterToken.mint.equals(mint)||!afterToken.owner.equals(user)||afterToken.state!==1)throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      const beforeBase=beforeTokens.get(baseIndex),afterBalance=afterTokens.get(baseIndex);
      const bound=(t:typeof beforeBase)=>!!t&&t.mint===mint.toBase58()&&t.owner===user.toBase58()&&t.programId===baseInfo.owner.toBase58()&&t.decimals===baseMintAccount.decimals;
      if(!bound(afterBalance)||afterBalance!.amount!==afterToken.amount||pre[baseIndex]>0&&(!bound(beforeBase)||beforeBase!.amount!==afterBalance!.amount)||pre[baseIndex]===0&&(beforeBase!==undefined||afterBalance!.amount!==0n))throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      const stack:string[]=[],events:Array<{name:string;data:Record<string,unknown>}>=[];
      for(const line of v.logs){if(typeof line!=='string')throw new Error('RPC_SHAPE');const invoke=/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/.exec(line),done=/^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:)/.exec(line);if(invoke)stack.push(invoke[1]);else if(done){if(stack.pop()!==done[1])throw new Error('PUMP_SIMULATION_LOG_SCOPE');}else if(stack.at(-1)===PUMP_AMM_PROGRAM_ID.toBase58()&&line.startsWith('Program data: ')){const event=OFFLINE_PUMP_AMM_PROGRAM.coder.events.decode(line.slice(14));if(event)events.push({name:event.name.toLowerCase(),data:event.data});}}
      const matching=(name:string,field:string)=>events.filter(e=>e.name===name&&String(e.data.user)===user.toBase58()&&String(e.data.pool)===poolKey.toBase58()&&String(e.data[field])===buy.base.toString());
      const buyEvents=matching('buyevent','baseAmountOut'),sellEvents=matching('sellevent','baseAmountIn');
      if(stack.length||buyEvents.length!==1||sellEvents.length!==1)throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      const spent=String(buyEvents[0].data.userQuoteAmountIn),received=String(sellEvents[0].data.userQuoteAmountOut);
      if(!/^(0|[1-9]\d*)$/.test(spent)||!/^(0|[1-9]\d*)$/.test(received)||BigInt(spent)>BigInt(actualBuy.uiQuote.toString()))throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      // Native payer delta includes all retained setup rent, including program-created accounts.
      // Separate entry/exit message fees remain conservative relative to this single atomic simulation.
      const setup=BigInt(pre[payerIndex])-BigInt(post[payerIndex])-BigInt(spent)+BigInt(received)-BigInt(v.fee as number);
      if(setup<0n||pre[baseIndex]===0&&setup<BigInt(post[baseIndex]))throw new Error('PUMP_SIMULATION_DELTA_MISMATCH');
      venue.entryExternalCostUsd=entryFee.add(setup.toString()).div(1e9).mul(price).toFixed();venue.costsReconciled=true;delete errors.execution;
      venue.simulation={setupVerified:true,buySucceeded:true,sellSucceeded:true};
      simulationProof={method:'SIMULATION_PRE_POST_BALANCES',wireBase64:wire.toString('base64'),staticAccountKeys:keys,payerIndex,baseIndex,quoteIndex,slot:sim.context.slot,evidenceId:'pump-roundtrip-simulation',feeLamports:String(v.fee),setupLamports:setup.toString()};
    }catch(e){errors.simulation=e instanceof Error&&/^PUMP_/.test(e.message)?e.message:safeRpcCode(e);}
    rawArtifacts['pump-quote-calculation']=JSON.stringify({sdk:inspection.version,pool:poolKey.toBase58(),requestedUsd:profile.sizeUsd,quoteAtomic:quote.toString(),actualEntryAtomic:actualBuy.uiQuote.toString(),acquiredAtomic:buy.base.toString(),exitAtomic:sell.uiQuote.toString(),method:'INDEPENDENT_QUOTES',virtualQuoteReserves:pool.virtualQuoteReserves.toString(),actualQuoteReserve:quoteVault.amount.toString(),slot:stateSlot,...(recovery?{nativeUsd:solUsd,nativePriceEvidenceId:'pump-sol-usd'}:{}),simulationProof});retrievedAt['pump-quote-calculation']=now();inspection.evidenceIds.push('pump-quote-calculation');
    venue.evidenceIds=inspection.evidenceIds.filter(id=>id!=='rpc-genesis'&&id!=='pump-pool-config'&&!['pump-program','pump-program-data','pump-simulation-payers','pump-simulation-fallback-payers','pump-simulation-user-accounts'].includes(id));
    inspection.availableAt=now();return {inspection,controls:resolvedControls,venue,rawArtifacts,retrievedAt,...(recovery?{marketEvidence}:{})};
  }catch(e){const code=e instanceof Error&&/^PUMP_/.test(e.message)?e.message:safeRpcCode(e);errors[inspection.bindingVerified?'execution':'binding']=code;inspection.availableAt=now();return {inspection,controls:resolvedControls,rawArtifacts,retrievedAt,...(recovery?{marketEvidence}:{})};}
}
