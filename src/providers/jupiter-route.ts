import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout,AccountLayout } from '@solana/spl-token';
import { Decimal } from 'decimal.js';
import type { HolderFacts, JupiterRouteFacts } from '../domain/baseline.js';
import type { Profile, TokenRef } from '../domain/contracts.js';
import { createJupiterClient } from './jupiter.js';
import { fetchDexPairs, parseDexPairs } from './dexscreener.js';
import { PUBLIC_SOLANA_RPC,decodeHolderPopulation,decodeMintAccount } from './solana.js';
import { readLimitedText } from './http.js';
import { USDC } from './pumpswap.js';

export const jupiterCauses = [
 'JUPITER_ACCOUNTS_INVALID',
 'JUPITER_BUY_SIMULATION_FAILED',
 'JUPITER_CONTEXT_UNAVAILABLE',
 'JUPITER_HOLDERS_UNAVAILABLE',
 'JUPITER_HTTP_INVALID',
 'JUPITER_LIQUIDITY_UNAVAILABLE',
 'JUPITER_LOOKUP_INVALID',
 'JUPITER_LOOKUP_UNAVAILABLE',
 'JUPITER_NO_ROUTE',
 'JUPITER_PAYER_INVALID',
 'JUPITER_PAYER_UNAVAILABLE',
 'JUPITER_PRICE_UNAVAILABLE',
 'JUPITER_PROVIDER_UNAVAILABLE',
 'JUPITER_QUOTE_EXPIRED',
 'JUPITER_QUOTE_INVALID',
 'JUPITER_ROUTE_UNAVAILABLE',
 'JUPITER_RPC_UNAVAILABLE',
 'JUPITER_SELL_PAYER_UNAVAILABLE',
 'JUPITER_SELL_QUOTE_UNAVAILABLE',
 'JUPITER_SELL_SIMULATION_FAILED',
 'JUPITER_SIMULATION_DELTA',
 'JUPITER_SIMULATION_INVALID',
 'JUPITER_SIMULATION_UNAVAILABLE',
 'JUPITER_SIZE_INVALID',
 'JUPITER_SLIPPAGE_EXCEEDED',
 'JUPITER_SLIPPAGE_MOVED_TWICE',
 'JUPITER_SWAP_INVALID',
 'JUPITER_SWAP_UNAVAILABLE',
] as const;
export type JupiterCause = typeof jupiterCauses[number];
function fail(code:JupiterCause):never{throw Error(code);}

type Retained={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
const native=NATIVE_MINT.toBase58();
export const isJupiterSlippage=(value:unknown):boolean=>/\"Custom\":6001|0x1771|slippage(?: tolerance)? exceeded|slippage_exceeded/i.test(JSON.stringify(value));
const amount=(x:unknown):x is string=>typeof x==='string'&&/^(0|[1-9]\d*)$/.test(x);
const parse=(raw:Record<string,string>,id:string):any=>JSON.parse(raw[id]);
function httpStatus(raw:Record<string,string>,id:string){
 const attempts=Object.keys(raw).filter(key=>new RegExp('^'+id+'-attempt-[1-4]$').test(key)).sort();
 if(!attempts.length||attempts.some((key,index)=>key!==`${id}-attempt-${index+1}`)||attempts.some((key,index)=>index<attempts.length-1&&parse(raw,key+'-status').status!==429))fail('JUPITER_HTTP_INVALID');
 const last=attempts[attempts.length-1],status=parse(raw,last+'-status').status;
 if(status!==parse(raw,id+'-status').status||raw[last]!==raw[id])fail('JUPITER_HTTP_INVALID');
 return status;
}
const price=(raw:Record<string,string>)=>parseDexPairs(parse(raw,'jupiter-sol-usd'),'solana',native).pairs.find(p=>p.baseAddress===native&&p.quoteAddress===USDC&&p.priceUsd!==null)?.priceUsd;
const names=(holders:HolderFacts)=>{const totals=new Map<string,bigint>();for(const account of holders.accounts)totals.set(account.owner,(totals.get(account.owner)??0n)+BigInt(account.amount));return [...totals].filter(([owner])=>{try{return PublicKey.isOnCurve(new PublicKey(owner).toBytes());}catch{return false;}}).sort((a,b)=>a[1]>b[1]?-1:a[1]<b[1]?1:a[0]<b[0]?-1:a[0]>b[0]?1:0).slice(0,100).map(([owner])=>owner);};
const quote=(raw:Record<string,string>,id:string,input:string,output:string,qty:string)=>{
 const status=httpStatus(raw,id);
 if(status!==200){let code;try{code=parse(raw,id).errorCode;}catch{}fail(status===400&&code==='NO_ROUTES_FOUND'?'JUPITER_NO_ROUTE':'JUPITER_PROVIDER_UNAVAILABLE');}
 let q:any;try{q=parse(raw,id);}catch{fail('JUPITER_QUOTE_INVALID');}
 if(JSON.stringify(parse(raw,id+'-request'))!==JSON.stringify({inputMint:input,outputMint:output,amount:qty,slippageBps:500}))fail('JUPITER_QUOTE_INVALID');
 if(q.inputMint!==input||q.outputMint!==output||q.inAmount!==qty||!amount(q.outAmount)||BigInt(q.outAmount)<=0n||!Array.isArray(q.routePlan)||!q.routePlan.length||q.routePlan.some((r:any)=>!r?.swapInfo?.ammKey||typeof r.swapInfo.label!=='string'||!r.swapInfo.label.trim())||!q.routePlan.some((r:any)=>r.swapInfo.inputMint===input)||!q.routePlan.some((r:any)=>r.swapInfo.outputMint===output)||typeof q.priceImpactPct!=='string'||!new Decimal(q.priceImpactPct).isFinite()||new Decimal(q.priceImpactPct).lt(0))fail('JUPITER_QUOTE_INVALID');
 return q;
};
function payerFrom(raw:Record<string,string>,holders:HolderFacts,_required:bigint,buyLamports:bigint,side:'buy'|'sell'){
 const candidates=names(holders),packet=parse(raw,'jupiter-payers');
 if(JSON.stringify(parse(raw,'jupiter-payers-request'))!==JSON.stringify({method:'getMultipleAccounts',params:[candidates,{encoding:'base64',commitment:'finalized'}]}))fail('JUPITER_PAYER_INVALID');
 if(packet.error||!Number.isSafeInteger(packet.result?.context?.slot)||packet.result.context.slot<holders.slot||!Array.isArray(packet.result?.value)||packet.result.value.length!==candidates.length)fail('JUPITER_PAYER_UNAVAILABLE');
 for(const [i,owner] of candidates.entries()){
  const account=packet.result.value[i],balance=holders.accounts.filter(a=>a.owner===owner).reduce((sum,a)=>sum+BigInt(a.amount),0n);
  const minimum=side==='sell'?10000000n:buyLamports+100000000n;
  if((side==='sell'||account?.owner===PublicKey.default.toBase58())&&account?.executable===false&&Number.isSafeInteger(account.lamports)&&BigInt(account.lamports)>=minimum&&(side==='buy'||balance>0n))return owner;
 }
 fail('JUPITER_PAYER_UNAVAILABLE');
}
const sellAmount=(holders:HolderFacts,payer:string,required:bigint)=>{const balance=holders.accounts.filter(a=>a.owner===payer).reduce((sum,a)=>sum+BigInt(a.amount),0n);return balance<required?balance:required;};
const simulationQuoteId=(raw:Record<string,string>,side:'buy'|'sell')=>side==='sell'&&raw['jupiter-sell-simulation-quote']?'jupiter-sell-simulation-quote':`jupiter-${side}-quote`;
function txKeys(raw:Record<string,string>,side:'buy'|'sell',payer:string,minSlot=0){
 const build=parse(raw,`jupiter-${side}-swap`),status=httpStatus(raw,`jupiter-${side}-swap`);
 if(JSON.stringify(parse(raw,`jupiter-${side}-swap-request`))!==JSON.stringify({quoteResponse:parse(raw,simulationQuoteId(raw,side)),userPublicKey:payer,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true}))fail('JUPITER_SWAP_INVALID');
 if(status!==200||typeof build.swapTransaction!=='string')fail('JUPITER_SWAP_UNAVAILABLE');
 const tx=VersionedTransaction.deserialize(Buffer.from(build.swapTransaction,'base64'));
 if(tx.version!==0||tx.message.staticAccountKeys[0]?.toBase58()!==payer||tx.signatures.some(s=>s.some(byte=>byte!==0)))fail('JUPITER_SWAP_INVALID');
 const lookups=tx.message.addressTableLookups.map((item,index)=>{
  const response=parse(raw,`jupiter-${side}-lookup-${index+1}`),value=response.result?.value;
  if(JSON.stringify(parse(raw,`jupiter-${side}-lookup-${index+1}-request`))!==JSON.stringify({method:'getAccountInfo',params:[item.accountKey.toBase58(),{encoding:'base64',commitment:'finalized'}]}))fail('JUPITER_LOOKUP_INVALID');
  if(response.error||!Number.isSafeInteger(response.result?.context?.slot)||response.result.context.slot<minSlot||!value||value.owner!==AddressLookupTableProgram.programId.toBase58()||value.data?.[1]!=='base64')fail('JUPITER_LOOKUP_UNAVAILABLE');
  return new AddressLookupTableAccount({key:item.accountKey,state:AddressLookupTableAccount.deserialize(Buffer.from(value.data[0],'base64'))});
 });
 const segments=tx.message.getAccountKeys({addressLookupTableAccounts:lookups}).keySegments().map(segment=>segment.map(k=>k.toBase58()));
 return {tx,segments,keys:segments.flat()};
}
function simulation(raw:Record<string,string>,side:'buy'|'sell',mint:string,payer:string,qty:bigint,minSlot:number){
 const {keys,segments}=txKeys(raw,side,payer,minSlot),after=parse(raw,`jupiter-${side}-simulation`),beforeValues:any[]=[];let newestSlot=minSlot;
 const q=parse(raw,simulationQuoteId(raw,side));
 if(!keys.includes(mint)||!Array.isArray(q.routePlan)||q.routePlan.some((r:any)=>!keys.includes(r?.swapInfo?.ammKey)))fail('JUPITER_SWAP_INVALID');
 for(let offset=0;offset<keys.length;offset+=100){const part=keys.slice(offset,offset+100),id=`jupiter-${side}-accounts-${offset/100+1}`,before=parse(raw,id);
  if(JSON.stringify(parse(raw,id+'-request'))!==JSON.stringify({method:'getMultipleAccounts',params:[part,{encoding:'jsonParsed',commitment:'finalized'}]})||before.error||!Number.isSafeInteger(before.result?.context?.slot)||before.result.context.slot<minSlot||!Array.isArray(before.result?.value)||before.result.value.length!==part.length)fail('JUPITER_ACCOUNTS_INVALID');
  newestSlot=Math.max(newestSlot,before.result.context.slot);beforeValues.push(...before.result.value);
 }
 if(after.result?.value?.err!==null&&after.result?.value?.err!==undefined)fail(isJupiterSlippage(after.result.value)?raw[`jupiter-${side}-first-simulation`]?'JUPITER_SLIPPAGE_MOVED_TWICE':'JUPITER_SLIPPAGE_EXCEEDED':side==='buy'?'JUPITER_BUY_SIMULATION_FAILED':'JUPITER_SELL_SIMULATION_FAILED');
 if(after.error||!Number.isSafeInteger(after.result?.context?.slot)||after.result.context.slot<newestSlot||after.result?.value?.err!==null||!Array.isArray(after.result.value.accounts))fail('JUPITER_SIMULATION_UNAVAILABLE');
 if(JSON.stringify(after.result.value.loadedAddresses?.writable??[])!==JSON.stringify(segments[1]??[])||JSON.stringify(after.result.value.loadedAddresses?.readonly??[])!==JSON.stringify(segments[2]??[]))fail('JUPITER_LOOKUP_INVALID');
 const selected=keys.flatMap((key,i)=>beforeValues[i]?.data?.parsed?.info?.mint===mint?[{key,account:beforeValues[i],info:beforeValues[i].data.parsed.info}]:[]);
 const wire=parse(raw,`jupiter-${side}-swap`).swapTransaction;
 if(JSON.stringify(parse(raw,`jupiter-${side}-simulation-request`))!==JSON.stringify({method:'simulateTransaction',params:[wire,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,accounts:{encoding:'jsonParsed',addresses:selected.map(s=>s.key)}}]}))fail('JUPITER_SIMULATION_INVALID');
 if(after.result.value.accounts.length!==selected.length)fail('JUPITER_SIMULATION_INVALID');
 let payerDelta=0n;const vaultDeltas:Array<{key:string;delta:bigint}>=[];
 for(const [i,entry] of selected.entries()){
  const post=after.result.value.accounts[i]?.data?.parsed?.info,prior=entry.info;
  if(![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(entry.account.owner)||after.result.value.accounts[i]?.owner!==entry.account.owner||!post||post.mint!==mint||post.owner!==prior.owner||!amount(prior.tokenAmount?.amount)||!amount(post.tokenAmount?.amount))fail('JUPITER_SIMULATION_INVALID');
  const delta=BigInt(post.tokenAmount.amount)-BigInt(prior.tokenAmount.amount);
  if(prior.owner===payer)payerDelta+=delta;
  if(side==='buy'&&!PublicKey.isOnCurve(new PublicKey(prior.owner).toBytes()))vaultDeltas.push({key:entry.key,delta});
 }
 if(side==='buy'?(!amount(q.otherAmountThreshold)||payerDelta<BigInt(q.otherAmountThreshold)||payerDelta<=0n):payerDelta!==-qty)fail('JUPITER_SIMULATION_DELTA');
 const v=after.result.value;
 if(!Array.isArray(v.preBalances)||!Array.isArray(v.postBalances)||v.preBalances.length!==keys.length||v.postBalances.length!==keys.length||!Number.isSafeInteger(v.preBalances[0])||!Number.isSafeInteger(v.postBalances[0])||!Number.isSafeInteger(v.fee)||v.fee<0)fail('JUPITER_SIMULATION_INVALID');
 const wrapped=beforeValues.reduce((sum:bigint,account:any,index:number)=>{const info=account?.data?.parsed?.info;if(info?.mint===native&&info.owner===payer&&Number.isSafeInteger(v.preBalances[index])&&Number.isSafeInteger(v.postBalances[index]))return sum+BigInt(v.preBalances[index])-BigInt(v.postBalances[index]);return sum;},0n);
 const paid=BigInt(v.preBalances[0])-BigInt(v.postBalances[0])+wrapped,fee=BigInt(v.fee);
 if(side==='buy'&&paid<0n||side==='sell'&&(!amount(q.otherAmountThreshold)||-paid+fee<BigInt(q.otherAmountThreshold)))fail('JUPITER_SIMULATION_DELTA');
 return {vaults:vaultDeltas.filter(item=>item.delta===-payerDelta).map(item=>item.key),paymentLamports:paid.toString()};
}

/** Reconstruct the route from retained provider and RPC responses only. */
export function deriveJupiterRoute(raw:Record<string,string>,token:TokenRef,profile:Profile,holders:HolderFacts|undefined,availableAt:string,evidenceIds:string[]):{venue:JupiterRouteFacts;vaults:string[]}{
 if(token.chain!=='solana'||!profile.sizeUsd)fail('JUPITER_CONTEXT_UNAVAILABLE');
 const usd=price(raw);if(!usd||!new Decimal(usd).isFinite()||new Decimal(usd).lte(0))fail('JUPITER_PRICE_UNAVAILABLE');
 const lamports=new Decimal(profile.sizeUsd).div(usd).mul(1e9).floor().toFixed(0);
 if(!amount(lamports)||BigInt(lamports)<=0n)fail('JUPITER_SIZE_INVALID');
 const buy=quote(raw,'jupiter-buy-quote',native,token.address,lamports);let sell:any,sellCode:string|undefined;try{sell=quote(raw,'jupiter-sell-quote',token.address,native,buy.outAmount);}catch(error){sellCode=error instanceof Error&&/^JUPITER_[A-Z_]+$/.test(error.message)?error.message:'JUPITER_SELL_QUOTE_UNAVAILABLE';}
 const route=buy.routePlan.map((r:any)=>({ammKey:r.swapInfo.ammKey,label:r.swapInfo.label}));
 let vaults:string[]=[],simulated=false,buySucceeded=false,buyPaymentLamports:string|undefined,simulationCode='JUPITER_SIMULATION_UNAVAILABLE',simulatedFraction:string|undefined;
 try{if(!holders)fail('JUPITER_HOLDERS_UNAVAILABLE');const buyPayer=payerFrom(raw,holders,BigInt(buy.outAmount),BigInt(lamports),'buy');const buySimulation=simulation(raw,'buy',token.address,buyPayer,BigInt(buy.outAmount),holders.slot);vaults=buySimulation.vaults;buyPaymentLamports=buySimulation.paymentLamports;buySucceeded=true;if(!sell)fail((sellCode??'JUPITER_SELL_QUOTE_UNAVAILABLE') as JupiterCause);let sellPayer:string;try{sellPayer=payerFrom(raw,holders,BigInt(buy.outAmount),BigInt(lamports),'sell');}catch{fail('JUPITER_SELL_PAYER_UNAVAILABLE');}const qty=sellAmount(holders,sellPayer,BigInt(buy.outAmount));if(qty<BigInt(buy.outAmount))quote(raw,'jupiter-sell-simulation-quote',token.address,native,qty.toString());else if(raw['jupiter-sell-simulation-quote'])fail('JUPITER_QUOTE_INVALID');simulation(raw,'sell',token.address,sellPayer,qty,holders.slot);simulatedFraction=new Decimal(qty.toString()).div(buy.outAmount).toFixed();simulated=true;}catch(error){simulationCode=error instanceof Error&&/^JUPITER_[A-Z_]+$/.test(error.message)?error.message:'JUPITER_SIMULATION_UNAVAILABLE';}
 const venue:JupiterRouteFacts={kind:'JUPITER_ROUTE',token,availableAt,expiresAt:new Date(Date.parse(availableAt)+30000).toISOString(),certificateId:'jupiter-route:'+token.address,route,entryQuoteUsd:profile.sizeUsd,acquiredAtomic:buy.outAmount,exitQuoteUsd:sell?new Decimal(sell.outAmount).div(1e9).mul(usd).toFixed():null,entryImpactBps:new Decimal(buy.priceImpactPct).mul(10000).toFixed(),exitImpactBps:sell?new Decimal(sell.priceImpactPct).mul(10000).toFixed():null,roundTripLossBps:sell?Decimal.max(0,new Decimal(1).sub(new Decimal(sell.outAmount).div(lamports)).mul(10000)).toFixed():null,...(sellCode?{sellCode}:{}),buySucceeded,...(buyPaymentLamports?{buyPaymentLamports}:{}),...(simulated?{simulation:{setupVerified:true,buySucceeded:true,sellSucceeded:true,...(simulatedFraction?{simulatedFraction}:{})} as const}:{simulationCode}),evidenceIds};
 return {venue,vaults};
}

export function deriveJupiterVaults(raw:Record<string,string>,token:TokenRef,profile:Profile,holders:HolderFacts):string[]{
 if(token.chain!=='solana'||!profile.sizeUsd)fail('JUPITER_CONTEXT_UNAVAILABLE');
 const usd=price(raw);if(!usd||!new Decimal(usd).isFinite()||new Decimal(usd).lte(0))fail('JUPITER_PRICE_UNAVAILABLE');
 const lamports=new Decimal(profile.sizeUsd).div(usd).mul(1e9).floor().toFixed(0),buy=quote(raw,'jupiter-buy-quote',native,token.address,lamports);
 const payer=payerFrom(raw,holders,BigInt(buy.outAmount),BigInt(lamports),'buy');
 return simulation(raw,'buy',token.address,payer,BigInt(buy.outAmount),holders.slot).vaults;
}

export function retainedJupiterHolders(raw:Record<string,string>,token:TokenRef):HolderFacts|undefined{
 try{const mint=parse(raw,'rpc-mint-raw').result,population=parse(raw,'rpc-holder-population');if(population.error||!mint?.value||mint.value.data?.[1]!=='base64'||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(mint.value.owner))throw Error();const decoded=MintLayout.decode(Buffer.from(mint.value.data[0],'base64'));return decodeHolderPopulation(population.result,token.address,mint.value.owner,decoded.supply.toString(),mint.context.slot);}catch{/* A bounded largest-account sample can still select a simulation payer. */}
 try{
  const mint=decodeMintAccount(parse(raw,'rpc-account').result),largest=parse(raw,'rpc-largest').result,bank=parse(raw,'rpc-holder-accounts').result;
  if((mint.kind!=='MINT_LEGACY'&&mint.kind!=='MINT_TOKEN_2022_PARTIAL')||!Number.isSafeInteger(largest?.context?.slot)||largest.context.slot<mint.slot||!Number.isSafeInteger(bank?.context?.slot)||bank.context.slot<largest.context.slot||!Array.isArray(largest.value)||largest.value.length>20||!Array.isArray(bank.value)||bank.value.length!==largest.value.length)throw Error();
  const seen=new Set<string>(),accounts=largest.value.map((row:any,index:number)=>{const info=bank.value[index];if(typeof row?.address!=='string'||seen.has(row.address)||!amount(row.amount)||row.decimals!==mint.decimals||info?.owner!==mint.programId||info.executable!==false||info.data?.[1]!=='base64')throw Error();seen.add(row.address);const bytes=Buffer.from(info.data[0],'base64');if(bytes.length<165)throw Error();const decoded=AccountLayout.decode(bytes);if(decoded.mint.toBase58()!==token.address||![1,2].includes(decoded.state)||decoded.amount.toString()!==row.amount)throw Error();return {address:row.address,owner:decoded.owner.toBase58(),amount:row.amount};});
  if(accounts.reduce((sum:bigint,a:{amount:string})=>sum+BigInt(a.amount),0n)>BigInt(mint.supplyAtomic))throw Error();
  return {supplyAtomic:mint.supplyAtomic,accounts,complete:false,slot:bank.context.slot,evidenceIds:['rpc-genesis','rpc-largest','rpc-holder-accounts']};
 }catch{return undefined;}
}

/** Capture bounded public quote and unsigned simulation evidence in the final stage. */
export async function inspectJupiterRoute(token:TokenRef,profile:Profile,holders:HolderFacts|undefined,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal):Promise<Retained>{
 const rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={};
 const put=(id:string,raw:string)=>{rawArtifacts[id]=raw;retrievedAt[id]=now();};
 const rpc=async(id:string,method:string,params:unknown[])=>{put(id+'-request',JSON.stringify({method,params}));const timeout=AbortSignal.timeout(8000),response=await fetcher(url,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:signal?AbortSignal.any([signal,timeout]):timeout});const raw=await readLimitedText(response,2000000);put(id,raw);if(!response.ok)fail('JUPITER_RPC_UNAVAILABLE');const body=JSON.parse(raw);if(body.error||!body.result)fail('JUPITER_RPC_UNAVAILABLE');return body.result;};
 let activeRequest='';
 const jupiter=createJupiterClient(fetcher,undefined,(attempt,response)=>{put(`${activeRequest}-attempt-${attempt}`,response.raw);put(`${activeRequest}-attempt-${attempt}-status`,JSON.stringify({status:response.status}));});
 const jup=async(id:string,call:ReturnType<typeof jupiter.quote>)=>{activeRequest=id;const result=await call;put(id,result.raw);put(id+'-status',JSON.stringify({status:result.status}));if(result.status!==200||!result.value){let code;try{code=JSON.parse(result.raw).errorCode;}catch{}fail(result.status===400&&code==='NO_ROUTES_FOUND'?'JUPITER_NO_ROUTE':isJupiterSlippage(result.value)?'JUPITER_SLIPPAGE_EXCEEDED':'JUPITER_PROVIDER_UNAVAILABLE');}return result.value as any;};
 try{
  const market=await fetchDexPairs('solana',native,fetcher,now);if(!market.raw)fail('JUPITER_PRICE_UNAVAILABLE');put('jupiter-sol-usd',market.raw);
  const usd=price(rawArtifacts);if(!usd||!profile.sizeUsd)fail('JUPITER_PRICE_UNAVAILABLE');
  const lamports=new Decimal(profile.sizeUsd).div(usd).mul(1e9).floor().toFixed(0);
  put('jupiter-buy-quote-request',JSON.stringify({inputMint:native,outputMint:token.address,amount:lamports,slippageBps:500}));
  let buy=await jup('jupiter-buy-quote',jupiter.quote(native,token.address,lamports,500,signal));
  let parsedBuy=quote(rawArtifacts,'jupiter-buy-quote',native,token.address,lamports);
  let buyPayer:string|undefined,sellPayer:string|undefined;
  if(holders)try{const candidates=names(holders);if(candidates.length)await rpc('jupiter-payers','getMultipleAccounts',[candidates,{encoding:'base64',commitment:'finalized'}]);try{buyPayer=payerFrom(rawArtifacts,holders,BigInt(parsedBuy.outAmount),BigInt(lamports),'buy');}catch{}try{sellPayer=payerFrom(rawArtifacts,holders,BigInt(parsedBuy.outAmount),BigInt(lamports),'sell');}catch{}}catch{/* Quotes remain useful without a simulation payer. */}
  const simulate=async(side:'buy'|'sell',q:any,payer:string)=>{
   put(`jupiter-${side}-swap-request`,JSON.stringify({quoteResponse:q,userPublicKey:payer,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true}));
   const built=await jup(`jupiter-${side}-swap`,jupiter.swap(q,payer!,signal));
   const tx=VersionedTransaction.deserialize(Buffer.from(built.swapTransaction,'base64'));
   for(const [index,lookup] of tx.message.addressTableLookups.entries()){
    const id=`jupiter-${side}-lookup-${index+1}`;
    const connection=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>{const request=JSON.parse(String(init?.body));put(id+'-request',JSON.stringify({method:request.method,params:request.params}));const timeout=AbortSignal.timeout(8000),response=await fetcher(input,{...init,signal:signal?AbortSignal.any([signal,timeout]):timeout});put(id,await readLimitedText(response.clone(),2000000));return response;}});
    const result=await connection.getAddressLookupTable(lookup.accountKey,{commitment:'finalized'});if(!result.value)fail('JUPITER_LOOKUP_UNAVAILABLE');
   }
   const {keys}=txKeys(rawArtifacts,side,payer!);
   const values:any[]=[];
   for(let offset=0;offset<keys.length;offset+=100){const part=keys.slice(offset,offset+100),accounts=await rpc(`jupiter-${side}-accounts-${offset/100+1}`,'getMultipleAccounts',[part,{encoding:'jsonParsed',commitment:'finalized'}]);if(!Array.isArray(accounts.value)||accounts.value.length!==part.length)fail('JUPITER_ACCOUNTS_INVALID');values.push(...accounts.value);}
   const addresses=keys.filter((_,index)=>values[index]?.data?.parsed?.info?.mint===token.address);
   const result=await rpc(`jupiter-${side}-simulation`,'simulateTransaction',[built.swapTransaction,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,accounts:{encoding:'jsonParsed',addresses}}]);
   if(result.value?.err&&isJupiterSlippage(result.value))fail('JUPITER_SLIPPAGE_EXCEEDED');
  };
  if(buyPayer)try{await simulate('buy',buy,buyPayer);}catch(error){
   if(error instanceof Error&&error.message==='JUPITER_SLIPPAGE_EXCEEDED')try{
    for(const [id,value] of Object.entries(rawArtifacts).filter(([id])=>id.startsWith('jupiter-buy-')))put(id.replace('jupiter-buy-','jupiter-buy-first-'),value);
    put('jupiter-buy-quote-request',JSON.stringify({inputMint:native,outputMint:token.address,amount:lamports,slippageBps:500}));
    buy=await jup('jupiter-buy-quote',jupiter.quote(native,token.address,lamports,500,signal));parsedBuy=quote(rawArtifacts,'jupiter-buy-quote',native,token.address,lamports);await simulate('buy',buy,buyPayer);
   }catch{/* The retained second attempt records the outcome. */}
  }
  put('jupiter-sell-quote-request',JSON.stringify({inputMint:token.address,outputMint:native,amount:parsedBuy.outAmount,slippageBps:500}));
  const sell=await jup('jupiter-sell-quote',jupiter.quote(token.address,native,parsedBuy.outAmount,500,signal));
  quote(rawArtifacts,'jupiter-sell-quote',token.address,native,parsedBuy.outAmount);
  if(sellPayer&&holders)try{const qty=sellAmount(holders,sellPayer,BigInt(parsedBuy.outAmount));let simulationQuote=sell;if(qty<BigInt(parsedBuy.outAmount)){put('jupiter-sell-simulation-quote-request',JSON.stringify({inputMint:token.address,outputMint:native,amount:qty.toString(),slippageBps:500}));simulationQuote=await jup('jupiter-sell-simulation-quote',jupiter.quote(token.address,native,qty.toString(),500,signal));quote(rawArtifacts,'jupiter-sell-simulation-quote',token.address,native,qty.toString());}try{await simulate('sell',simulationQuote,sellPayer);}catch(error){if(error instanceof Error&&error.message==='JUPITER_SLIPPAGE_EXCEEDED'){
    for(const [id,value] of Object.entries(rawArtifacts).filter(([id])=>id.startsWith('jupiter-sell-')))put(id.replace('jupiter-sell-','jupiter-sell-first-'),value);
    const id=qty<BigInt(parsedBuy.outAmount)?'jupiter-sell-simulation-quote':'jupiter-sell-quote';put(id+'-request',JSON.stringify({inputMint:token.address,outputMint:native,amount:qty.toString(),slippageBps:500}));
    const retried=await jup(id,jupiter.quote(token.address,native,qty.toString(),500,signal));await simulate('sell',retried,sellPayer);
   }}}catch{/* Failed simulation stays unavailable. */}
 }catch(error){put('jupiter-failure',JSON.stringify({code:error instanceof Error&&/^JUPITER_[A-Z_]+$/.test(error.message)?error.message:'JUPITER_ROUTE_UNAVAILABLE'}));}
 return {rawArtifacts,retrievedAt};
}
