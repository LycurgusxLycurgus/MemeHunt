import { setTimeout as delay } from 'node:timers/promises';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { PublicKey, TransactionMessage, VersionedMessage, VersionedTransaction, ComputeBudgetProgram, type AccountInfo, type TransactionInstruction } from '@solana/web3.js';
import { AccountLayout, MintLayout, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_SDK, pumpIdl, PUMP_PROGRAM_ID, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, bondingCurvePda, getBuyV3TokenAmountFromQuoteAmount, getBuyV3QuoteAmountFromTokenAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { PUMP_FEE_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import { solanaRpc, safeRpcCode, PUBLIC_SOLANA_RPC, decodeRawMintControls, decodeProgramHeader, resolveProgramData } from './solana.js';
import { fetchDexPairs, dexArtifacts, parseDexPairs, type DexRecoveryOptions } from './dexscreener.js';
import type { PumpSwapRead } from './pumpswap.js';
import { deriveBaseline, type BaselineAssessment, type HolderFacts, type VenueFacts, type VenueInspection } from '../domain/baseline.js';
import type { LiveBundle, Profile, TokenRef } from '../domain/contracts.js';

const tradeDiscriminator=Buffer.from(pumpIdl.events.find(e=>e.name==='TradeEvent')!.discriminator);
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const account=(v:unknown):AccountInfo<Buffer>=>{
  if(!obj(v)||typeof v.owner!=='string'||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string'||typeof v.executable!=='boolean'||!Number.isSafeInteger(v.lamports)||Number(v.lamports)<0)throw new Error('CURVE_ACCOUNT_SHAPE');
  return {owner:new PublicKey(v.owner),data:Buffer.from(v.data[0],'base64'),lamports:Number(v.lamports),executable:v.executable,rentEpoch:0};
};
const owned=(a:AccountInfo<Buffer>,owner:PublicKey)=>{if(a.executable||!a.owner.equals(owner))throw new Error('CURVE_ACCOUNT_BINDING');};
export function decodeCurveState(raw:string,mint:PublicKey,minSlot:number){
  const body=JSON.parse(raw),r=body.result;
  if(body.error||!obj(r)||!obj(r.context)||!Number.isSafeInteger(r.context.slot)||Number(r.context.slot)<minSlot||!Array.isArray(r.value)||r.value.length!==5||r.value.some(v=>v===null))throw new Error('CURVE_STATE_MISSING');
  const [curveInfo,globalInfo,feeInfo,mintInfo,vaultInfo]=r.value.map(account);
  owned(curveInfo,PUMP_PROGRAM_ID);owned(globalInfo,PUMP_PROGRAM_ID);owned(feeInfo,PUMP_FEE_PROGRAM_ID);
  if(![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(mintInfo.owner.toBase58()))throw new Error('CURVE_ACCOUNT_BINDING');
  owned(mintInfo,mintInfo.owner);owned(vaultInfo,mintInfo.owner);
  const curve=PUMP_SDK.decodeBondingCurve(curveInfo),global=PUMP_SDK.decodeGlobal(globalInfo),fees=PUMP_SDK.decodeFeeConfig(feeInfo),mintAccount=MintLayout.decode(mintInfo.data),vault=AccountLayout.decode(vaultInfo.data),key=bondingCurvePda(mint);
  if(!global.initialized||!mintAccount.isInitialized||!vault.mint.equals(mint)||!vault.owner.equals(key)||vault.state!==1||vault.delegateOption||vault.closeAuthorityOption||mintAccount.supply<=0n||new BN(mintAccount.supply.toString()).gt(curve.tokenTotalSupply)||new BN(vault.amount.toString()).lt(curve.realTokenReserves))throw new Error('CURVE_ACCOUNT_BINDING');
  if(!curve.quoteMint.equals(PublicKey.default)&&!curve.quoteMint.equals(NATIVE_MINT)||curve.depth!==0||curve.isMayhemMode||curve.isCashbackCoin)throw new Error('CURVE_EXECUTION_MODE_UNSUPPORTED');
  return {curve,global,fees,mintAccount,mintInfo,vaultInfo,vault,slot:Number(r.context.slot),key};
}
export function quoteCurve(state:ReturnType<typeof decodeCurveState>,sizeUsd:string,priceUsd:string){
  const {curve,global,fees,mintAccount,vault}=state;
  if(curve.complete)throw new Error('CURVE_AWAITING_MIGRATION');
  const price=new Decimal(priceUsd),size=new Decimal(sizeUsd);
  if(!price.isFinite()||!price.gt(0)||!size.isFinite()||!size.gt(0)||curve.virtualQuoteReserves.lten(0)||curve.virtualTokenReserves.lten(0))throw new Error('CURVE_QUOTE_INVALID');
  const quote=new BN(size.div(price).mul(1e9).floor().toFixed(0)),supply=new BN(mintAccount.supply.toString()),balance=new BN(vault.amount.toString());
  const args={global,feeConfig:fees,mintSupply:supply,bondingCurve:curve,curveBaseTokenBalance:balance};
  const acquired=getBuyV3TokenAmountFromQuoteAmount({...args,amount:quote});
  if(acquired.lten(0)||acquired.gte(curve.realTokenReserves))throw new Error('CURVE_MIGRATION_BOUNDARY');
  const spent=getBuyV3QuoteAmountFromTokenAmount({...args,amount:acquired}),exit=getSellSolAmountFromTokenAmount({...args,amount:acquired});
  if(spent.gt(quote)||exit.lten(0)||exit.gt(curve.realQuoteReserves))throw new Error('CURVE_DEPTH_UNAVAILABLE');
  const scale=new Decimal(10).pow(mintAccount.decimals),reference=new Decimal(curve.virtualQuoteReserves.toString()).div(1e9).mul(price).div(new Decimal(curve.virtualTokenReserves.toString()).div(scale));
  return {quote,acquired,spent,exit,price,reference,exitUsd:new Decimal(exit.toString()).add(quote.sub(spent).toString()).div(1e9).mul(price)};
}

/** Verify actual unsigned simulation, program-scoped events and native/token deltas. */
export function verifyCurveSimulation(raw:string,wire:string,mint:PublicKey,tokenProgram:PublicKey,user:PublicKey,base:PublicKey,acquired:BN,maxSpent:BN,slot:number){
  const tx=VersionedTransaction.deserialize(Buffer.from(wire,'base64')),keys=tx.message.staticAccountKeys.map(k=>k.toBase58()),baseIndex=keys.indexOf(base.toBase58()),r=JSON.parse(raw).result;
  if(tx.message.addressTableLookups.length||tx.message.header.numRequiredSignatures!==1||keys[0]!==user.toBase58()||baseIndex<0||tx.signatures.some(s=>s.some(b=>b!==0))||!r||!Number.isSafeInteger(r.context?.slot)||r.context.slot<slot||!obj(r.value)||r.value.err!==null)throw new Error('CURVE_SIMULATION_REJECTED');
  const instructions=tx.message.compiledInstructions.filter(i=>keys[i.programIdIndex]===PUMP_PROGRAM_ID.toBase58());
  if(instructions.length!==2)throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');
  for(const [index,ix] of instructions.entries()){
    const bytes=Buffer.from(ix.data),descriptor=pumpIdl.instructions.find(i=>i.name===(index===0?'buy_v3':'sell_v3'));
    if(!descriptor||bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from(descriptor.discriminator))||bytes.readBigUInt64LE(8)!==BigInt(acquired.toString())||index===0&&bytes.readBigUInt64LE(16)!==BigInt(maxSpent.toString())||keys[ix.accountKeyIndexes[1]]!==mint.toBase58()||keys[ix.accountKeyIndexes[5]]!==bondingCurvePda(mint).toBase58()||keys[ix.accountKeyIndexes[8]]!==user.toBase58())throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');
  }
  const v=r.value,pre=v.preBalances,post=v.postBalances,integer=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  if(!Array.isArray(pre)||!Array.isArray(post)||pre.length!==keys.length||post.length!==keys.length||!pre.every(integer)||!post.every(integer)||!integer(v.fee)||!Array.isArray(v.logs)||!Array.isArray(v.accounts)||v.accounts.length!==2||!v.accounts[0]||!v.accounts[1]||!Array.isArray(v.preTokenBalances)||!Array.isArray(v.postTokenBalances)||!obj(v.loadedAddresses)||!Array.isArray(v.loadedAddresses.writable)||v.loadedAddresses.writable.length||!Array.isArray(v.loadedAddresses.readonly)||v.loadedAddresses.readonly.length)throw new Error('CURVE_SIMULATION_BALANCES_UNAVAILABLE');
  const payer=account(v.accounts[0]),token=account(v.accounts[1]);owned(payer,PublicKey.default);owned(token,tokenProgram);
  const finalToken=AccountLayout.decode(token.data);
  if(payer.lamports!==post[0]||token.lamports!==post[baseIndex]||!finalToken.mint.equals(mint)||!finalToken.owner.equals(user)||finalToken.state!==1)throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');
  const tokenAmount=(entries:unknown[])=>{const matches=entries.filter(e=>obj(e)&&e.accountIndex===baseIndex);if(matches.length>1)throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');if(!matches.length)return null;const e=matches[0] as Record<string,unknown>;if(e.mint!==mint.toBase58()||e.owner!==user.toBase58()||e.programId!==tokenProgram.toBase58()||!obj(e.uiTokenAmount)||typeof e.uiTokenAmount.amount!=='string'||!/^\d+$/.test(e.uiTokenAmount.amount))throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');return BigInt(e.uiTokenAmount.amount);};
  const before=tokenAmount(v.preTokenBalances),after=tokenAmount(v.postTokenBalances);
  if(after===null||after!==finalToken.amount||pre[baseIndex]===0&&(before!==null||after!==0n)||pre[baseIndex]>0&&before!==after)throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');
  const stack:string[]=[],events:Array<Record<string,unknown>>=[];
  for(const line of v.logs){if(typeof line!=='string')throw new Error('CURVE_SIMULATION_LOG_SCOPE');const invoke=/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/.exec(line),done=/^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:)/.exec(line);if(invoke)stack.push(invoke[1]);else if(done){if(stack.pop()!==done[1])throw new Error('CURVE_SIMULATION_LOG_SCOPE');}else if(stack.at(-1)===PUMP_PROGRAM_ID.toBase58()&&line.startsWith('Program data: ')){const bytes=Buffer.from(line.slice(14),'base64');if(bytes.subarray(0,8).equals(tradeDiscriminator))events.push(PUMP_SDK.decodeTradeEventBc(bytes.subarray(8)) as unknown as Record<string,unknown>);}}
  const matches=events.filter(e=>String(e.mint)===mint.toBase58()&&String(e.user)===user.toBase58()&&String(e.tokenAmount)===acquired.toString()),buys=matches.filter(e=>e.isBuy===true),sells=matches.filter(e=>e.isBuy===false);
  if(stack.length||buys.length!==1||sells.length!==1)throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');
  const amount=(e:Record<string,unknown>,buy:boolean)=>{const value=new BN(String(e.solAmount)),fee=new BN(String(e.fee)).add(new BN(String(e.creatorFee)));return buy?value.add(fee):value.sub(fee);};
  const spent=amount(buys[0],true),received=amount(sells[0],false);
  if(spent.lten(0)||received.lten(0)||spent.gt(maxSpent))throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');
  const setup=BigInt(pre[0])-BigInt(post[0])-BigInt(spent.toString())+BigInt(received.toString())-BigInt(Number(v.fee));
  if(setup<0n||pre[baseIndex]===0&&setup<BigInt(post[baseIndex]))throw new Error('CURVE_SIMULATION_DELTA_MISMATCH');
  return {feeLamports:String(v.fee),setupLamports:setup.toString(),spent:spent.toString(),received:received.toString()};
}

/** New curve proof is reconstructed from retained state/price/fees/simulation; old snapshots are untouched. */
function validateCurveFee(id:string,bundle:LiveBundle,user:string,acquired:string,spent:string,exit:string,slot:number){
  const raw=bundle.rawArtifacts,requests=JSON.parse(raw['curve-fee-requests']),params=requests[id],block=JSON.parse(raw['curve-blockhash']).result;
  if(requests.method!=='curve-message-fees-v1'||!Array.isArray(params)||params.length!==2||typeof params[0]!=='string'||params[1]?.commitment!=='finalized'||params[1].minContextSlot!==Math.max(slot,block.context.slot))throw new Error('CURVE_PROOF_INVALID');
  const bytes=Buffer.from(params[0],'base64'),message=VersionedMessage.deserialize(bytes),keys=message.staticAccountKeys.map(k=>k.toBase58());
  if(bytes.toString('base64')!==params[0]||message.header.numRequiredSignatures!==1||keys[0]!==user||message.recentBlockhash!==block.value.blockhash||message.addressTableLookups.length)throw new Error('CURVE_PROOF_INVALID');
  const ix=message.compiledInstructions.filter(i=>keys[i.programIdIndex]===PUMP_PROGRAM_ID.toBase58()),buy=id==='curve-entry-fee',descriptor=pumpIdl.instructions.find(i=>i.name===(buy?'buy_v3':'sell_v3'))!,data=ix[0]?Buffer.from(ix[0].data):Buffer.alloc(0);
  if(ix.length!==1||data.length<24||!data.subarray(0,8).equals(Buffer.from(descriptor.discriminator))||data.readBigUInt64LE(8)!==BigInt(acquired)||data.readBigUInt64LE(16)!==BigInt(buy?spent:exit)||keys[ix[0].accountKeyIndexes[1]]!==bundle.token.address||keys[ix[0].accountKeyIndexes[5]]!==bondingCurvePda(new PublicKey(bundle.token.address)).toBase58()||keys[ix[0].accountKeyIndexes[8]]!==user)throw new Error('CURVE_PROOF_INVALID');
  const marker=raw[`${id}-recovery`];
  let selected=`${id}-attempt-1`;
  if(marker){
    const r=JSON.parse(marker),first=bundle.evidence.find(e=>e.id===`${id}-attempt-1`)!,receipt=bundle.evidence.find(e=>e.id===`${id}-recovery`)!;
    selected=`${id}-attempt-2`;
    if(r.method!=='curve-fee-min-context-retry-v1'||r.delayMs!==1000||JSON.stringify(r.params)!==JSON.stringify(params)||r.firstResponseId!==first?.id||r.secondResponseId!==selected||!receipt||receipt.sourceId!=='pump-curve-derived'||receipt.accessMode!=='LOCAL_DERIVED'||JSON.parse(raw[first.id]).error?.code!==-32016||Date.parse(first.retrievedAt)>Date.parse(receipt.retrievedAt))throw new Error('CURVE_PROOF_INVALID');
  }
  const attempt=bundle.evidence.find(e=>e.id===selected),normal=bundle.evidence.find(e=>e.id===id);
  if(!attempt||!normal||attempt.sourceId!=='pump-curve-direct'||attempt.accessMode!=='PUBLIC_API'||raw[id]!==raw[selected]||normal.retrievedAt!==attempt.retrievedAt||marker&&Date.parse(attempt.retrievedAt)<Date.parse(bundle.evidence.find(e=>e.id===`${id}-recovery`)!.retrievedAt))throw new Error('CURVE_PROOF_INVALID');
}
export function validateCurveBundle(bundle:LiveBundle){
  if(!bundle.evidence.some(e=>e.id==='venue-route-selection'))return;
  const raw=bundle.rawArtifacts,selection=JSON.parse(raw['venue-route-selection']),primary=JSON.parse(raw['pump-pool-config']);
  const packet=JSON.parse(raw['shared-derivation']) as {venueInspection:VenueInspection;venue?:VenueFacts;baseline:BaselineAssessment[]};
  if(selection.method!=='pump-venue-selection-v1'||selection.primaryStateId!=='pump-pool-config'||primary.result?.value?.[0]!==null||!['BONDING_CURVE','UNVERIFIED'].includes(selection.selected)||!packet.venueInspection||packet.venueInspection.version!=='pump-curve-sdk-4.0.0-sol-v1'||selection.selected!==(packet.venueInspection.bindingVerified?'BONDING_CURVE':'UNVERIFIED'))throw new Error('CURVE_PROOF_INVALID');
const venueIds=['O08','O09','O10','O11','O12','O13','O14','O15','O16'];
  const expected=deriveBaseline({sharedMode:true,token:bundle.token,cutoff:bundle.cutoff,profile:bundle.profile,features:bundle.features.filter(f=>!venueIds.includes(f.id)),evidence:bundle.evidence,observations:bundle.observations,market:bundle.market,collection:bundle.collection,semantic:bundle.semantic,venueInspection:packet.venueInspection,venue:packet.venue});
  for(const id of venueIds)if(JSON.stringify(expected.find(a=>a.id===id))!==JSON.stringify(packet.baseline.find(a=>a.id===id)))throw new Error('CURVE_PROOF_INVALID');
  if(!packet.venueInspection.bindingVerified){if(packet.venue)throw new Error('CURVE_PROOF_INVALID');return;}
  for(const id of ['curve-state','curve-program'])if(!bundle.evidence.some(e=>e.id===id&&e.sourceId==='pump-curve-direct'&&e.accessMode==='PUBLIC_API'&&e.scope.mint===bundle.token.address))throw new Error('CURVE_PROOF_INVALID');
  const bankSlot=JSON.parse(raw['curve-state']).result?.context?.slot;
  for(const id of ['curve-program',...(raw['curve-program-data']?['curve-program-data']:[])]){const r=JSON.parse(raw[id]).result;if(!Number.isSafeInteger(r?.context?.slot)||r.context.slot<bankSlot)throw new Error('CURVE_PROOF_INVALID');}
  const program=decodeProgramHeader(JSON.parse(raw['curve-program']).result,PUMP_PROGRAM_ID.toBase58());
  if(program.programDataAddress)resolveProgramData(program,JSON.parse(raw['curve-program-data']).result,[]);
  const mint=new PublicKey(bundle.token.address),minSlot=JSON.parse(raw['rpc-account']).result.context.slot,state=decodeCurveState(raw['curve-state'],mint,minSlot);
  if(packet.venueInspection.poolAddress!==state.key.toBase58()||packet.venueInspection.certificateId!==`pump-curve-sol:${state.key.toBase58()}`||packet.venueInspection.removableLiquidityFraction!=='0')throw new Error('CURVE_PROOF_INVALID');
  if(!packet.venue)return;
  const calc=JSON.parse(raw['curve-quote-calculation']),price=parseDexPairs(JSON.parse(raw['pump-sol-usd']),'solana',NATIVE_MINT.toBase58()).pairs.find(p=>p.baseAddress===NATIVE_MINT.toBase58()&&p.quoteAddress==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'&&p.priceUsd)?.priceUsd;
  if(!price)throw new Error('CURVE_PROOF_INVALID');
  const q=quoteCurve(state,bundle.profile.sizeUsd!,price),v=packet.venue;
  const at=bundle.evidence.find(e=>e.id==='curve-state')!,priceAt=bundle.evidence.find(e=>e.id==='pump-sol-usd')!;
  const expires=new Date(Math.min(Date.parse(at.retrievedAt),Date.parse(priceAt.retrievedAt))+30000).toISOString();
  if(calc.method!=='pump-curve-sol-v1'||calc.minSlot!==minSlot||calc.slot!==state.slot||calc.nativeUsd!==price||calc.quoteAtomic!==q.quote.toString()||calc.actualEntryAtomic!==q.spent.toString()||calc.acquiredAtomic!==q.acquired.toString()||calc.exitAtomic!==q.exit.toString()||v.method!=='INDEPENDENT_QUOTES'||v.embeddedFeesUsd!=='0'||!v.bindingVerified||v.acquiredAtomic!==q.acquired.toString()||v.exitQuantityAtomic!==q.acquired.toString()||v.entryQuoteUsd!==bundle.profile.sizeUsd||v.exitQuoteUsd!==q.exitUsd.toFixed()||v.referencePriceUsd!==q.reference.toFixed()||v.decimals!==state.mintAccount.decimals||v.availableAt!==at.retrievedAt||v.expiresAt!==expires||v.removableLiquidityFraction!=='0'||v.version!==packet.venueInspection.version||v.certificateId!==packet.venueInspection.certificateId)throw new Error('CURVE_PROOF_INVALID');
  if(v.costsReconciled){
    const proof=JSON.parse(raw['curve-simulation-proof']),user=new PublicKey(proof.user),base=getAssociatedTokenAddressSync(mint,user,true,state.mintInfo.owner);
    const verified=verifyCurveSimulation(raw['curve-roundtrip-simulation'],proof.wire,mint,state.mintInfo.owner,user,base,q.acquired,q.spent,state.slot);
    const fee=(id:string)=>{validateCurveFee(id,bundle,proof.user,q.acquired.toString(),q.spent.toString(),q.exit.toString(),state.slot);const f=JSON.parse(raw[id]).result;if(!Number.isSafeInteger(f?.context?.slot)||f.context.slot<state.slot||!Number.isSafeInteger(f.value)||f.value<0)throw new Error('CURVE_PROOF_INVALID');return new Decimal(f.value);};
    if(proof.base!==base.toBase58()||Object.entries(verified).some(([k,val])=>proof[k]!==val)||v.entryExternalCostUsd!==fee('curve-entry-fee').add(verified.setupLamports).div(1e9).mul(price).toFixed()||v.exitExternalCostUsd!==fee('curve-exit-fee').div(1e9).mul(price).toFixed()||!v.simulation?.setupVerified||!v.simulation.buySucceeded||!v.simulation.sellSucceeded)throw new Error('CURVE_PROOF_INVALID');
  }else if(v.simulation)throw new Error('CURVE_PROOF_INVALID');
}

export async function inspectPumpCurve(token:TokenRef,profile:Profile,holders:HolderFacts|undefined,minSlot:number,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal,recovery?:DexRecoveryOptions):Promise<PumpSwapRead>{
  const mint=new PublicKey(token.address),key=bondingCurvePda(mint),rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={},errors:Record<string,string>={},marketEvidence:NonNullable<PumpSwapRead['marketEvidence']>={};
  const inspection:VenueInspection={token,poolAddress:key.toBase58(),certificateId:'',version:'pump-curve-sdk-4.0.0-sol-v1',availableAt:now(),bindingVerified:false,evidenceIds:['rpc-genesis'],errors,limitations:['Native SOL bonding curve; no LP redemption claims. Program upgrade risk remains separate. Only active, depth-zero, non-mayhem and non-cashback curves are executable.']};
  const read=async(id:string,method:string,params:unknown[])=>{const retain=(raw:string)=>{rawArtifacts[id]=raw;retrievedAt[id]=now();if(!inspection.evidenceIds.includes(id))inspection.evidenceIds.push(id);};const r=await solanaRpc(url,method,params,fetcher,undefined,signal,retain);return r.value;};
  let controls:PumpSwapRead['controls'],venue:VenueFacts|undefined;
  try{
    const discovery=await read('curve-discovery','getMultipleAccounts',[[key.toBase58(),mint.toBase58()],{encoding:'base64',commitment:'finalized',minContextSlot:minSlot}]) as {value:unknown[]};
    if(!Array.isArray(discovery.value)||discovery.value.length!==2||discovery.value.some(v=>v===null))throw new Error('CURVE_STATE_MISSING');
    const tokenProgram=account(discovery.value[1]).owner,curveAta=getAssociatedTokenAddressSync(mint,key,true,tokenProgram);
    const market=await fetchDexPairs('solana',NATIVE_MINT.toBase58(),fetcher,now,recovery);
    for(const [id,a] of Object.entries(dexArtifacts(market,'pump-sol-usd','solana',NATIVE_MINT.toBase58(),now()))){marketEvidence[id]=a;rawArtifacts[id]=a.raw;retrievedAt[id]=a.retrievedAt;inspection.evidenceIds.push(id);}
    const price=market.market?.pairs.find(p=>p.baseAddress===NATIVE_MINT.toBase58()&&p.quoteAddress==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'&&p.priceUsd)?.priceUsd;
    const keys=[key,GLOBAL_PDA,PUMP_FEE_CONFIG_PDA,mint,curveAta];
    await read('curve-state','getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized',minContextSlot:minSlot}]);
    const state=decodeCurveState(rawArtifacts['curve-state'],mint,minSlot);
    const program=decodeProgramHeader(await read('curve-program','getAccountInfo',[PUMP_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:state.slot,dataSlice:{offset:0,length:36}}]),PUMP_PROGRAM_ID.toBase58());
    if(program.programDataAddress){const facts=resolveProgramData(program,await read('curve-program-data','getAccountInfo',[program.programDataAddress,{encoding:'base64',commitment:'finalized',minContextSlot:state.slot,dataSlice:{offset:0,length:45}}]),[]);inspection.limitations.push(facts.immutable?'Venue program immutable.':'Venue program has an observed upgrade authority.');}
    controls=decodeRawMintControls({context:{slot:state.slot},value:{owner:state.mintInfo.owner.toBase58(),data:[state.mintInfo.data.toString('base64'),'base64']}},['rpc-genesis','curve-state']);
    inspection.bindingVerified=true;inspection.certificateId=`pump-curve-sol:${key.toBase58()}`;inspection.removableLiquidityFraction='0';
    if(!price)throw new Error('CURVE_USD_PRICE_UNAVAILABLE');
    if(!controls.complete||!controls.transferAllowed||controls.currentFeeBps!=='0'||!controls.feeImmutable)throw new Error('CURVE_TOKEN_MODE_UNSUPPORTED');
    const q=quoteCurve(state,profile.sizeUsd!,price),availableAt=retrievedAt['curve-state'],expiresAt=new Date(Math.min(Date.parse(availableAt),Date.parse(retrievedAt['pump-sol-usd']))+30000).toISOString();
    venue={certificateId:inspection.certificateId,bindingVerified:true,version:inspection.version,token,availableAt,expiresAt,removableLiquidityFraction:'0',lockExpiresAt:null,entryQuoteUsd:profile.sizeUsd!,acquiredAtomic:q.acquired.toString(),decimals:state.mintAccount.decimals,exitQuantityAtomic:q.acquired.toString(),exitQuoteUsd:q.exitUsd.toFixed(),referencePriceUsd:q.reference.toFixed(),entryExternalCostUsd:'0',exitExternalCostUsd:'0',embeddedFeesUsd:'0',costsReconciled:false,method:'INDEPENDENT_QUOTES',evidenceIds:inspection.evidenceIds};
    try{
      const candidates=[...new Set([...(holders?.accounts.slice(0,5).map(a=>a.owner)??[]),state.curve.creator.toBase58(),...state.global.feeRecipients.map(k=>k.toBase58()),...state.global.buybackFeeRecipients.map(k=>k.toBase58())])].filter(a=>a!==PublicKey.default.toBase58()).slice(0,12).map(a=>new PublicKey(a));
      const payers=await read('curve-simulation-payers','getMultipleAccounts',[candidates.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized',minContextSlot:state.slot}]) as {value:unknown[]};
      const index=payers.value.findIndex(v=>{if(!v)return false;const a=account(v);return !a.executable&&a.owner.equals(PublicKey.default)&&BigInt(a.lamports)>=BigInt(q.quote.toString())+30000000n;});
      if(index<0)throw new Error('CURVE_SIMULATION_PAYER_UNAVAILABLE');
      const user=candidates[index],base=getAssociatedTokenAddressSync(mint,user,true,tokenProgram),baseResponse=await read('curve-user-account','getAccountInfo',[base.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:state.slot}]) as {value:unknown};
      const buys=await PUMP_SDK.buyV3Instructions({bondingCurve:state.curve,associatedUserAccountInfo:baseResponse.value?account(baseResponse.value):null,mint,user,amount:q.acquired,quoteAmount:q.spent,slippage:0,tokenProgram,buybackFeeRecipient:state.global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default))});
      const sells=await PUMP_SDK.sellV3Instructions({bondingCurve:state.curve,mint,user,amount:q.acquired,quoteAmount:q.exit,slippage:0,tokenProgram,buybackFeeRecipient:state.global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default))});
      const block=await read('curve-blockhash','getLatestBlockhash',[{commitment:'finalized',minContextSlot:state.slot}]) as {context:{slot:number};value:{blockhash:string}};
      const message=(instructions:TransactionInstruction[])=>new TransactionMessage({payerKey:user,recentBlockhash:block.value.blockhash,instructions}).compileToV0Message();
      const fee=async(id:string,instructions:TransactionInstruction[])=>{
        const params=[Buffer.from(message(instructions).serialize()).toString('base64'),{commitment:'finalized',minContextSlot:Math.max(state.slot,block.context.slot)}];
        const requests=rawArtifacts['curve-fee-requests']?JSON.parse(rawArtifacts['curve-fee-requests']):{method:'curve-message-fees-v1'};requests[id]=params;rawArtifacts['curve-fee-requests']=JSON.stringify(requests);retrievedAt['curve-fee-requests']=now();if(!inspection.evidenceIds.includes('curve-fee-requests'))inspection.evidenceIds.push('curve-fee-requests');
        let attempt=1,value:{context:{slot:number};value:unknown};
        try{value=await read(`${id}-attempt-1`,'getFeeForMessage',params) as typeof value;}catch(error){
          if(!recovery||safeRpcCode(error)!=='RPC_REMOTE_-32016'||signal?.aborted)throw error;
          const marker=`${id}-recovery`;rawArtifacts[marker]=JSON.stringify({method:'curve-fee-min-context-retry-v1',params,delayMs:1000,firstResponseId:`${id}-attempt-1`,secondResponseId:`${id}-attempt-2`});retrievedAt[marker]=now();inspection.evidenceIds.push(marker);
          await delay(1000,undefined,{signal});attempt=2;value=await read(`${id}-attempt-2`,'getFeeForMessage',params) as typeof value;
        }
        rawArtifacts[id]=rawArtifacts[`${id}-attempt-${attempt}`];retrievedAt[id]=retrievedAt[`${id}-attempt-${attempt}`];inspection.evidenceIds.push(id);
        if(!Number.isSafeInteger(value.context?.slot)||value.context.slot<Math.max(state.slot,block.context.slot)||typeof value.value!=='number'||!Number.isSafeInteger(value.value)||value.value<0)throw new Error('CURVE_FEE_UNAVAILABLE');return new Decimal(value.value);
      };
      const entryFee=await fee('curve-entry-fee',buys),exitFee=await fee('curve-exit-fee',sells);
      const tx=new VersionedTransaction(message([ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...buys,...sells])),wire=Buffer.from(tx.serialize());
      if(wire.length>1232)throw new Error('CURVE_SIMULATION_TRANSACTION_TOO_LARGE');
      await read('curve-roundtrip-simulation','simulateTransaction',[wire.toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'finalized',minContextSlot:state.slot,accounts:{encoding:'base64',addresses:[user.toBase58(),base.toBase58()]}}]);
      const proof=verifyCurveSimulation(rawArtifacts['curve-roundtrip-simulation'],wire.toString('base64'),mint,tokenProgram,user,base,q.acquired,q.spent,state.slot);
      venue.entryExternalCostUsd=entryFee.add(proof.setupLamports).div(1e9).mul(q.price).toFixed();venue.exitExternalCostUsd=exitFee.div(1e9).mul(q.price).toFixed();venue.costsReconciled=true;venue.simulation={setupVerified:true,buySucceeded:true,sellSucceeded:true};
      rawArtifacts['curve-simulation-proof']=JSON.stringify({wire:wire.toString('base64'),user:user.toBase58(),base:base.toBase58(),...proof});retrievedAt['curve-simulation-proof']=now();inspection.evidenceIds.push('curve-simulation-proof');
    }catch(error){errors.simulation=error instanceof Error&&error.message.startsWith('CURVE_')?error.message:safeRpcCode(error);errors.execution=errors.simulation;}
    rawArtifacts['curve-quote-calculation']=JSON.stringify({method:'pump-curve-sol-v1',minSlot,slot:state.slot,nativeUsd:price,quoteAtomic:q.quote.toString(),actualEntryAtomic:q.spent.toString(),acquiredAtomic:q.acquired.toString(),exitAtomic:q.exit.toString(),venue});retrievedAt['curve-quote-calculation']=now();inspection.evidenceIds.push('curve-quote-calculation');
    venue.evidenceIds=[...new Set(inspection.evidenceIds)];
    inspection.availableAt=now();return {inspection,controls,venue,rawArtifacts,retrievedAt,marketEvidence};
  }catch(error){errors[inspection.bindingVerified?'execution':'binding']=error instanceof Error&&error.message.startsWith('CURVE_')?error.message:safeRpcCode(error);inspection.availableAt=now();return {inspection,controls,rawArtifacts,retrievedAt,marketEvidence};}
}
