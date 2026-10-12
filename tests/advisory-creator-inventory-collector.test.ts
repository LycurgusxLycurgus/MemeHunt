import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk,PUMP_AMM_PROGRAM_ID,poolPda } from '@pump-fun/pump-swap-sdk';
import { collectCreatorInventory,creatorInventoryReuse,replayCreatorInventory,CREATOR_INVENTORY_REQUEST_CAP } from '../src/providers/advisory-creator-inventory-collector.js';
import { decodeCreatorInventory,deriveO24CreatorInventory,creatorTransactionRequest,creatorPageRequest,CREATOR_MAX_PAGES,CREATOR_TRANSACTION_CAP,type CreatorRole,type CreatorTape } from '../src/providers/advisory-creator-inventory.js';
import { PINNED_CREATE_V2,PUMP_PROGRAM,creatorRoleCoinUrl } from '../src/providers/advisory-creator-role.js';
import { encodeSolanaAddress,decodeSolanaAddress,TOKEN_2022_PROGRAM,SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { admittedFetchers,collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';

// Public-shaped synthetic role, wallet, account and tape; no private receipt is read.
const key=(i:number)=>encodeSolanaAddress(Buffer.alloc(32,i)),sig=(i:number)=>encodeSolanaAddress(Buffer.alloc(64,i));
const SYS='11111111111111111111111111111111',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',CB='ComputeBudget111111111111111111111111111111',T22=TOKEN_2022_PROGRAM,quote='So11111111111111111111111111111111111111112';
const mint='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',token={chain:'solana' as const,address:mint},wallet=key(8),stranger=key(10);
const account=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(wallet),true,TOKEN_2022_PROGRAM_ID).toBase58();
const T=Date.parse('2026-10-09T00:00:00.000Z')/1000,slot=400_000,createSig=sig(3),transferSig=sig(4),olderSig=sig(5),ataSig=sig(11);
const at='2026-10-10T12:30:00.000Z',roleAt='2026-10-10T12:00:01.000Z',ANCHOR=10_001,HEAD=500_000,CATALOG=500_010;
const pump=new PublicKey(PUMP_PROGRAM),seedProgram=new PublicKey(Uint8Array.from(PINNED_CREATE_V2.mayhemSeedProgram)),mintKey=new PublicKey(mint);
const pda=(seeds:Buffer[],program=pump)=>PublicKey.findProgramAddressSync(seeds,program)[0].toBase58();
const bondingCurve=pda([Buffer.from('bonding-curve'),mintKey.toBuffer()]),mintAuthority=pda([Buffer.from('mint-authority')]),eventAuthority=pda([Buffer.from('__event_authority')]);
const createAccounts=[mint,mintAuthority,bondingCurve,getAssociatedTokenAddressSync(mintKey,new PublicKey(bondingCurve),true,TOKEN_2022_PROGRAM_ID).toBase58(),pda([Buffer.from('global')]),wallet,SYS,T22,ATA,PINNED_CREATE_V2.mayhemProgram,pda([Buffer.from('global-params')],seedProgram),pda([Buffer.from('sol-vault')],seedProgram),pda([Buffer.from('mayhem-state'),mintKey.toBuffer()],seedProgram),key(12),eventAuthority,PUMP_PROGRAM];
const str=(s:string)=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};
const i64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b;};
const names=['Parasite','PARASITE','https://ipfs.io/ipfs/example'];
/** The signed create_v2 shape of the S13 role tests, with the token-balance arrays every finalized RPC receipt carries. */
function creationTx():any{
 const data=Buffer.concat([Buffer.from(PINNED_CREATE_V2.discriminator),...names.map(str),decodeSolanaAddress(wallet),Buffer.alloc(10)]);
 const event=Buffer.concat([Buffer.from(PINNED_CREATE_V2.eventDiscriminator),...names.map(str),decodeSolanaAddress(mint),decodeSolanaAddress(bondingCurve),decodeSolanaAddress(wallet),decodeSolanaAddress(wallet),i64(T),Buffer.alloc(115)]);
 const writable=new Set([wallet,mint,createAccounts[2],createAccounts[3],createAccounts[9],createAccounts[11],createAccounts[12],createAccounts[13]]);
 const keys=[...new Set([wallet,...createAccounts,CB])].map(pubkey=>({pubkey,signer:pubkey===wallet||pubkey===mint,writable:writable.has(pubkey),source:'transaction'}));
 const pre=keys.map(k=>k.pubkey===wallet?5_000_000_000:k.pubkey===mint?0:1),post=keys.map((k,i)=>k.pubkey===mint?2_753_360:pre[i]!);
 return{slot,blockTime:T,version:0,transaction:{signatures:[createSig,sig(6)],message:{accountKeys:keys,instructions:[{programId:CB,accounts:[],data:'LBc2Nb',stackHeight:1},{programId:PUMP_PROGRAM,accounts:createAccounts,data:encodeSolanaAddress(data),stackHeight:1}]}},
  meta:{err:null,status:{Ok:null},preBalances:pre,postBalances:post,preTokenBalances:[],postTokenBalances:[],innerInstructions:[{index:1,instructions:[
   {program:'system',programId:SYS,stackHeight:2,parsed:{type:'createAccount',info:{newAccount:mint,owner:T22,source:wallet,lamports:1838960,space:234}}},
   {program:'spl-token',programId:T22,stackHeight:2,parsed:{type:'initializeMetadataPointer',info:{mint,metadataAddress:mint}}},
   {program:'spl-token',programId:T22,stackHeight:2,parsed:{type:'initializeMint2',info:{mint,decimals:6,mintAuthority}}},
   {program:'system',programId:SYS,stackHeight:2,parsed:{type:'createAccount',info:{newAccount:bondingCurve,owner:PUMP_PROGRAM,source:wallet,lamports:1285240,space:125}}},
   {programId:PUMP_PROGRAM,stackHeight:2,accounts:[eventAuthority],data:encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),event]))},
  ]}],
  logMessages:[`Program ${CB} invoke [1]`,`Program ${CB} success`,`Program ${PUMP_PROGRAM} invoke [1]`,'Program log: Instruction: CreateV2',`Program ${SYS} invoke [2]`,`Program ${SYS} success`,`Program ${T22} invoke [2]`,`Program ${T22} success`,`Program ${T22} invoke [2]`,`Program ${T22} success`,`Program ${SYS} invoke [2]`,`Program ${SYS} success`,`Program data: ${event.toString('base64')}`,`Program ${PUMP_PROGRAM} invoke [2]`,`Program ${PUMP_PROGRAM} success`,`Program ${PUMP_PROGRAM} success`]}};
}
/** A signed lamport transfer by the wallet that never touches the mint. */
const transferTx=(signature:string,blockTime:number,s:number):any=>({slot:s,blockTime,version:0,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:wallet,signer:true,writable:true,source:'transaction'},{pubkey:key(30),signer:false,writable:true,source:'transaction'},{pubkey:SYS,signer:false,writable:false,source:'transaction'}],instructions:[{program:'system',programId:SYS,stackHeight:1,parsed:{type:'transfer',info:{source:wallet,destination:key(30),lamports:1}}}]}},meta:{err:null,status:{Ok:null},preBalances:[10,0,1],postBalances:[9,1,1],preTokenBalances:[],postTokenBalances:[],innerInstructions:[],logMessages:[`Program ${SYS} invoke [1]`,`Program ${SYS} success`]}});
/** The wallet opens its canonical immutable-owner account at zero before the interval: the pinned start witness. */
const ataTx=():any=>{
 const keys=[wallet,account,mint,SYS,T22,ATA];
 return{slot:slot+10,blockTime:T+300,version:0,transaction:{signatures:[ataSig],message:{accountKeys:keys.map((pubkey,i)=>({pubkey,signer:i===0,writable:i<2,source:'transaction'})),instructions:[{program:'spl-associated-token-account',programId:ATA,stackHeight:1,parsed:{type:'create',info:{source:wallet,account,wallet,mint,systemProgram:SYS,tokenProgram:T22}}}]}},
  meta:{err:null,status:{Ok:null},preBalances:[10,0,1,1,1,1],postBalances:[9,1,1,1,1,1],innerInstructions:[{index:0,instructions:[{program:'spl-token',programId:T22,stackHeight:2,parsed:{type:'initializeImmutableOwner',info:{account}}},{program:'spl-token',programId:T22,stackHeight:2,parsed:{type:'initializeAccount3',info:{account,mint,owner:wallet}}}]}],
   logMessages:[`Program ${ATA} invoke [1]`,`Program ${T22} invoke [2]`,`Program ${T22} success`,`Program ${T22} invoke [2]`,`Program ${T22} success`,`Program ${ATA} success`],
   preTokenBalances:[],postTokenBalances:[{accountIndex:1,mint,owner:wallet,programId:T22,uiTokenAmount:{amount:'0',decimals:6,uiAmount:0,uiAmountString:'0'}}]}};
};
const parsedAccount=(amount:string)=>({lamports:2074080,owner:T22,executable:false,rentEpoch:0,space:170,data:{program:'spl-token-2022',space:170,parsed:{type:'account',info:{extensions:[{extension:'immutableOwner'}],isNative:false,mint,owner:wallet,state:'initialized',tokenAmount:{amount,decimals:6,uiAmount:0,uiAmountString:amount}}}}});
const row=(t:any)=>({signature:t.transaction.signatures[0],slot:t.slot,blockTime:t.blockTime,err:null,memo:null,confirmationStatus:'finalized'});
const older={signature:olderSig,slot:slot-1000,blockTime:T-86400,err:null,memo:null,confirmationStatus:'finalized'};
const dust=(i:number)=>transferTx(sig(100+i),T+400+i,slot+20+i);
const reply=(body:unknown)=>new Response(JSON.stringify(body));
const remoteError={jsonrpc:'2.0',id:1,error:{code:-32009,message:'unavailable'}};
type WorldOptions={dust?:number;rows?:unknown[];txError?:string;walletPageError?:boolean;delayMs?:number};
/** Finalized RPC for the role index, ATA head/index, owner catalog, pinned wallet pages and transactions; counts transactions in flight. */
function rpcWorld(o:WorldOptions={}){
 const calls:Array<{method:string;params:any[]}>=[];let inFlight=0,maxTransactions=0;
 const extra=Array.from({length:o.dust??0},(_,i)=>dust(i));
 const txs=new Map<string,unknown>([[createSig,creationTx()],[transferSig,transferTx(transferSig,T+60,slot+5)],[ataSig,ataTx()],...extra.map(t=>[t.transaction.signatures[0],t] as [string,unknown])]);
 const roleRows=[row(ataTx()),row(transferTx(transferSig,T+60,slot+5)),row(creationTx()),older],walletRows=o.rows??[...extra.map(row).reverse(),...roleRows];
 const fetcher:typeof fetch=async(_input,init)=>{
  const body=JSON.parse(String(init?.body)),isTx=body.method==='getTransaction';calls.push({method:body.method,params:body.params});
  if(isTx){inFlight++;maxTransactions=Math.max(maxTransactions,inFlight);}
  try{
   await new Promise(resolve=>setTimeout(resolve,o.delayMs??0));
   if(isTx)return body.params[0]===o.txError?reply(remoteError):reply({jsonrpc:'2.0',id:1,result:txs.get(body.params[0])??null});
   if(body.method==='getAccountInfo'&&body.params[0]===account)return reply({jsonrpc:'2.0',id:1,result:{context:{slot:HEAD},value:parsedAccount('0')}});
   if(body.method==='getSignaturesForAddress'&&body.params[0]===account)return reply({jsonrpc:'2.0',id:1,result:[row(ataTx())]});
   // The S13 role index is unpinned; the inventory wallet pages carry minContextSlot.
   if(body.method==='getSignaturesForAddress'&&body.params[0]===wallet)return body.params[1]?.minContextSlot===undefined?reply({jsonrpc:'2.0',id:1,result:roleRows}):o.walletPageError?reply(remoteError):reply({jsonrpc:'2.0',id:1,result:walletRows});
   if(body.method==='getTokenAccountsByOwner')return reply({jsonrpc:'2.0',id:1,result:{context:{slot:CATALOG},value:[{pubkey:account,account:parsedAccount('0')}]}});
   throw new Error('UNEXPECTED_RPC');
  }finally{if(isTx)inFlight--;}
 };
 return{fetcher,calls,maxTransactions:()=>maxTransactions};
}
const role:CreatorRole={wallet,mint,creationSignature:createSig,creationSlot:slot};
const tape:CreatorTape={history:{complete:true,pool:key(20),anchorSlot:ANCHOR,range:{start:'2026-10-10T00:00:00.000Z',baselineEnd:'2026-10-10T06:00:00.000Z',end:'2026-10-10T12:00:00.000Z'},trades:[]},vault:key(21)};
const rpc=(result:unknown)=>JSON.stringify({jsonrpc:'2.0',id:1,result});
const roleReceipts=()=>({rawArtifacts:{'transaction-0':rpc(transferTx(transferSig,T+60,slot+5)),'transaction-1':rpc(creationTx())},retrievedAt:{'transaction-0':roleAt,'transaction-1':roleAt},requests:{'transaction-0':creatorTransactionRequest(transferSig),'transaction-1':creatorTransactionRequest(createSig)} as Record<string,unknown>});
const reuse=()=>creatorInventoryReuse([['advisory-creatorRole-',roleReceipts()]]);
const collect=(world:ReturnType<typeof rpcWorld>,signal?:AbortSignal,fetcher:typeof fetch=world.fetcher)=>collectCreatorInventory(token,role,tape,reuse(),'https://rpc.example',fetcher,()=>at,signal);
type Receipts=Awaited<ReturnType<typeof collect>>;
const decode=(r:Receipts)=>{const history=decodeCreatorInventory(token,role,tape,r,at,reuse());return{history,metric:deriveO24CreatorInventory(history,tape,['evidence'])};};

test('collector follows the pinned proof order on its derived allowance and reuses only byte-identical S13 receipts with their original clocks',async()=>{
 assert.equal(CREATOR_INVENTORY_REQUEST_CAP,1+CREATOR_MAX_PAGES+1+CREATOR_MAX_PAGES+CREATOR_TRANSACTION_CAP);assert.equal(CREATOR_INVENTORY_REQUEST_CAP,102);
 const world=rpcWorld(),r=await collect(world);
 assert.deepEqual(Object.keys(r.requests),['creator-ata-head','creator-ata-page-0',`creator-tx-${ataSig}`,'creator-owner-accounts','creator-wallet-page-0']);
 assert.deepEqual(world.calls.filter(c=>c.method==='getTransaction').map(c=>c.params[0]),[ataSig],'the creation and the role candidate are reused, never fetched again');
 assert.deepEqual(r.requests['creator-wallet-page-0'],creatorPageRequest(wallet,CATALOG));
 const {history,metric}=decode(r),data=metric.data as any;
 assert.deepEqual([metric.quality,metric.reasonCode,history.walletProof.successfulInspected],['KNOWN','CREATOR_SIGNER_INVENTORY_OBSERVED',3]);
 assert.deepEqual(history.reusedReceipts,['advisory-creatorRole-transaction-0','advisory-creatorRole-transaction-1']);
 assert.deepEqual([data.inventory.netChangeAtomic,data.canonical.startWitness.signature,data.cohort.identity],['0',ataSig,null]);
 assert.equal(decodeCreatorInventory(token,role,tape,r,at).walletProof.code,'CREATOR_RECEIPT_ABSENT','without the S13 receipt the creation witness is absent, never assumed');
 const json={commitment:'finalized',encoding:'json',maxSupportedTransactionVersion:1};
 assert.equal(creatorInventoryReuse([['advisory-demand-',{rawArtifacts:{a:rpc(creationTx())},retrievedAt:{a:roleAt},requests:{a:{method:'getTransaction',params:[createSig,json]}}}]]).size,0,'another encoding is never transformed or reused');
 assert.equal(creatorInventoryReuse([['advisory-window-',{rawArtifacts:{a:JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'RPC_TIMEOUT'}})},retrievedAt:{a:roleAt},requests:{a:creatorTransactionRequest(createSig)}}]]).size,0,'a failed envelope is never reused');
});

test('a duplicated reusable transaction or an extra receipt is rejected, and moved clocks are never KNOWN',async()=>{
 const r=await collect(rpcWorld());
 const duplicated=structuredClone(r),k=`creator-tx-${createSig}`;duplicated.requests[k]=creatorTransactionRequest(createSig);duplicated.rawArtifacts[k]=rpc(creationTx());duplicated.retrievedAt[k]=at;
 assert.throws(()=>decode(duplicated),/CREATOR_INVENTORY_RECEIPT_MEMBERSHIP/);
 const extra=structuredClone(r);extra.requests['creator-ata-page-1']=creatorPageRequest(account,HEAD,ataSig);extra.rawArtifacts['creator-ata-page-1']=rpc([]);extra.retrievedAt['creator-ata-page-1']=at;
 assert.throws(()=>decode(extra),/CREATOR_INVENTORY_RECEIPT_MEMBERSHIP/);
 const early=structuredClone(r);early.retrievedAt['creator-ata-head']='2026-10-10T11:59:59.000Z';
 assert.deepEqual([decode(early).metric.quality,decode(early).metric.reasonCode],['MISSING','CREATOR_ATA_HEAD_TIME']);
 const future=structuredClone(r);future.retrievedAt['creator-wallet-page-0']='2026-10-10T13:00:00.000Z';
 assert.equal(decode(future).metric.quality,'TRUNCATED');
});

test('fresh transactions run at most two at a time and a failed read is retained, leaving the proof unresolved',async()=>{
 const world=rpcWorld({dust:6,delayMs:3}),r=await collect(world);
 assert.equal(world.maxTransactions(),2);assert.equal(decode(r).metric.quality,'KNOWN');
 const f=await collect(rpcWorld({dust:6,txError:sig(102)}));
 assert.equal(JSON.parse(f.rawArtifacts[`creator-tx-${sig(102)}`]!).error.code,-32009);
 const {metric,history}=decode(f);
 assert.deepEqual([metric.quality,history.walletProof.status,history.walletProof.code],['TRUNCATED','MISSING','RPC_REMOTE_-32009']);
});

test('a wallet index over the transaction cap is never acquired and stays truncated',async()=>{
 const crowd=Array.from({length:CREATOR_TRANSACTION_CAP},(_,i)=>row(dust(i))).reverse();
 const world=rpcWorld({rows:[...crowd,row(ataTx()),row(creationTx()),older]}),r=await collect(world),{history,metric}=decode(r);
 assert.ok(world.calls.length<=CREATOR_INVENTORY_REQUEST_CAP);
 assert.deepEqual(world.calls.filter(c=>c.method==='getTransaction').map(c=>c.params[0]),[ataSig]);
 assert.deepEqual([metric.quality,history.walletProof.code],['TRUNCATED','CREATOR_WALLET_RECEIPT_CAP']);
});

test('an expired deadline issues nothing and an exhausted dedicated allowance retains sanitized failures without a KNOWN result',async()=>{
 const expired=new AbortController();expired.abort(new Error('COLLECTION_DEADLINE'));
 const idle=rpcWorld(),none=await collect(idle,expired.signal);
 assert.deepEqual([idle.calls.length,Object.keys(none.requests).length],[0,0]);
 const live=new AbortController(),world=rpcWorld(),admission=admittedFetchers(world.fetcher,live.signal,0,0,0,3);
 const r=await collect(world,live.signal,admission.inventoryFetcher);
 assert.deepEqual([admission.counts.inventory,admission.counts.shared,admission.limit.inventory],[3,0,3]);
 assert.equal(JSON.parse(r.rawArtifacts['creator-owner-accounts']!).error.code,'RPC_TRANSPORT');
 const {metric,history}=decode(r);
 assert.deepEqual([metric.quality,history.walletProof.code],['TRUNCATED','RPC_TRANSPORT']);
});

test('replay never derives O24 without a KNOWN recomputed S13 role',async()=>{
 const r=await collect(rpcWorld());
 assert.throws(()=>replayCreatorInventory(token,null,tape,r,reuse(),at,[]),/ADVISORY_PROOF_INVALID/);
 assert.throws(()=>replayCreatorInventory(token,{binding:null,quality:'TRUNCATED',reasonCode:'CREATOR_CANDIDATE_UNVERIFIED',data:{}},tape,r,reuse(),at,[]),/ADVISORY_PROOF_INVALID/);
});

const hour=Date.parse('2026-10-10T12:00:00.000Z')/1000,day=Date.parse('2026-10-10T00:00:00.000Z')/1000;
const poolCreator=new PublicKey(Buffer.alloc(32,7)),pool=poolPda(0,poolCreator,new PublicKey(mint),NATIVE_MINT).toBase58();
const label=(w:string)=>`${w.slice(0,4)}\u2026${w.slice(-4)}`,coin=creatorRoleCoinUrl(mint);
const creatorPage={results:[{url:coin,final_url:coin,text:`Creator\n\n${label(wallet)}\n\nMC`,links:[`https://pump.fun/profile/${wallet}`],published_date:new Date(T*1000).toISOString()}],errors:[]};
/** Public live fixture with a verifiable pool and anchor (complete hour and A30 tape), the S13 creator page and the inventory world. */
async function liveFetcher(o:WorldOptions={}):Promise<typeof fetch>{
 const type=sdk.idl.types!.find(t=>t.name==='pool')!,state:Record<string,unknown>={};
 for(const f of (type.type as any).fields)state[f.name]=f.type==='pubkey'?poolCreator:f.type==='bool'?false:f.type==='string'?'':f.type==='u8'||f.type==='u16'?0:new BN(0);
 Object.assign(state,{baseMint:new PublicKey(mint),quoteMint:NATIVE_MINT});
 const poolData=(await sdk.coder.accounts.encode('pool',state)).toString('base64'),world=rpcWorld(o);
 return async(input,init)=>{
  const url=String(input);let value:unknown;
  if(url==='https://api.fetch.tinyfish.ai/')return reply(creatorPage);
  if(init?.method==='POST'){
   const request=JSON.parse(String(init.body));
   if(request.method==='getTransaction'||request.method==='getTokenAccountsByOwner'||request.params?.[0]===account||request.method==='getSignaturesForAddress'&&request.params[0]===wallet)return world.fetcher(input,init);
   value={jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:request.method==='getSlot'?ANCHOR:request.method==='getBlockTime'?hour+60:request.method==='getSignaturesForAddress'?[]:request.method==='getAccountInfo'&&request.params[0]===pool?{context:{slot:ANCHOR+1},value:{owner:PUMP_AMM_PROGRAM_ID.toBase58(),executable:false,lamports:1,data:[poolData,'base64']}}:{context:{slot:1},value:null}};
  }else if(url.includes('/token-pairs/'))value=[{chainId:'solana',dexId:'pumpswap',pairAddress:pool,baseToken:{address:mint},quoteToken:{address:quote},priceUsd:'1',liquidity:{usd:10000},volume:{h24:100},txns:{h24:{buys:4,sells:3}}}];
  else if(url.includes('include=base_token'))value={data:{id:`solana_${pool}`,type:'pool',attributes:{address:pool},relationships:{base_token:{data:{id:`solana_${mint}`,type:'token'}},quote_token:{data:{id:`solana_${quote}`,type:'token'}}}},included:[mint,quote].map(address=>({id:`solana_${address}`,type:'token',attributes:{address}}))};
  else if(url.includes('ohlcv'))value={data:{attributes:{ohlcv_list:Array.from({length:75},(_,i)=>[hour-i*3600,10+i%6,11+i%6,9+i%6,10+i%6,20])}}};
  else if(url.includes('coinbase'))value=Array.from({length:75},(_,i)=>[hour-i*3600,9+i%6,11+i%6,10+i%6,10+i%6,2]);
  else if(url.includes('llama'))value={chain:new URL(url).pathname.split('/').at(-1),totalDataChart:[[day-172800,10],[day-86400,20],[day,999]]};
  else if(url.includes('/orders/'))value={orders:[{chainId:'solana',tokenAddress:mint,type:'tokenProfile',status:'approved',paymentTimestamp:Date.parse(at)-1000}],boosts:[]};
  else throw new Error('Unexpected fixture request');
  return reply(value);
 };
}
const live=async(o:WorldOptions={})=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'tinyfish-live-key',fetcher:await liveFetcher(o),now:()=>at});
const rehash=(b:{evidence:Array<{id:string;contentHash:string}>;rawArtifacts:Record<string,string>},id:string)=>{b.evidence.find(e=>e.id===id)!.contentHash=createHash('sha256').update(b.rawArtifacts[id]!).digest('hex');};

test('live collection persists a KNOWN creator inventory O24 through Service and rejects removed, downgraded, duplicated, extra, moved, rescoped and claimed receipts',async()=>{
 const bundle=await live(),proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!),facts=bundle.details!.advisory!,o24=facts.metrics.find(m=>m.id==='O24')!,data=o24.data as any;
 assert.deepEqual([proof.method,facts.method],['advisory-provenance-v22','advisory-measurements-v22']);
 assert.deepEqual([facts.metrics.find(m=>m.id==='A30')!.quality,facts.metrics.find(m=>m.id==='S13')!.quality],['KNOWN','KNOWN']);
 assert.deepEqual(Object.keys(proof.creatorInventory.artifactIds),['creator-ata-head','creator-ata-page-0',`creator-tx-${ataSig}`,'creator-owner-accounts','creator-wallet-page-0']);
 const receipts=bundle.evidence.filter(e=>e.sourceId==='advisory-creator-inventory');
 assert.ok(receipts.length===5&&receipts.every(e=>e.accessMode==='PUBLIC_API'&&e.adapterVersion==='live-v1'&&Object.keys(e.scope).join()==='request'));
 assert.deepEqual([o24.quality,o24.reasonCode,data.method,data.cohort.wallet,data.inventory.netChangeAtomic,data.nonCanonicalAccountsZeroThroughout],['KNOWN','CREATOR_SIGNER_INVENTORY_OBSERVED','creator-signer-wallet-inventory-v1',wallet,'0',true]);
 assert.deepEqual(data.reusedReceipts,['advisory-creatorRole-transaction-0','advisory-creatorRole-transaction-1']);
 assert.ok(o24.evidenceIds.includes('advisory-creatorRole-transaction-1')&&o24.evidenceIds.includes(`advisory-creatorInventory-creator-tx-${ataSig}`));
 assert.ok(!JSON.stringify(bundle).includes('tinyfish-live-key'));
 const directory=mkdtempSync(join(tmpdir(),'advisory-creator-inventory-')),file=join(directory,'live.sqlite');
 try{
  const writer=new Service(file);let id='';
  try{
   id=writer.analyzeLive(bundle).id;
   const forge=(change:(b:typeof bundle,p:any)=>void)=>{const b=structuredClone(bundle),p=JSON.parse(b.rawArtifacts['advisory-derivation']!);change(b,p);b.rawArtifacts['advisory-derivation']=JSON.stringify(p);rehash(b,'advisory-derivation');return b;};
   const head='advisory-creatorInventory-creator-ata-head';
   const add=(b:typeof bundle,p:any,key:string,request:unknown,raw:string)=>{const rid=`advisory-creatorInventory-${key}`;b.evidence.push({...b.evidence.find(e=>e.id===head)!,id:rid,scope:{request},contentHash:createHash('sha256').update(raw).digest('hex')});b.rawArtifacts[rid]=raw;p.creatorInventory.requests[key]=request;p.creatorInventory.artifactIds[key]=rid;};
   const cases:Array<[string,typeof bundle]>=[
    ['descriptor-removed',forge((_b,p)=>{p.creatorInventory=null;})],
    ['descriptor-key-deleted',forge((_b,p)=>{delete p.creatorInventory;})],
    ['proof-v15-with-inventory',forge((_b,p)=>{p.method='advisory-provenance-v15';})],
    ['role-descriptor-removed',forge((_b,p)=>{p.creatorRole=null;})],
    ['duplicate-reused-creation',forge((b,p)=>add(b,p,`creator-tx-${createSig}`,creatorTransactionRequest(createSig),b.rawArtifacts['advisory-creatorRole-transaction-1']!))],
    ['extra-receipt',forge((b,p)=>add(b,p,'creator-ata-page-1',creatorPageRequest(account,HEAD,ataSig),rpc([])))],
    ['orphaned-receipt',forge((_b,p)=>{delete p.creatorInventory.requests['creator-wallet-page-0'];delete p.creatorInventory.artifactIds['creator-wallet-page-0'];})],
    ['moved-head-clock',forge(b=>{const e=b.evidence.find(e=>e.id===head)!;e.retrievedAt=e.availableAt='2026-10-10T11:00:00.000Z';})],
    ['rehashed-head-amount',forge(b=>{const raw=JSON.parse(b.rawArtifacts[head]!);raw.result.value.data.parsed.info.tokenAmount.amount='5';b.rawArtifacts[head]=JSON.stringify(raw);rehash(b,head);})],
    ['rescoped-receipt',forge(b=>{const e=b.evidence.find(e=>e.id===head)!;e.scope={...e.scope,wallet:stranger};})],
    ['foreign-adapter',forge(b=>{b.evidence.find(e=>e.id===head)!.adapterVersion='demand-archive-v1';})],
    ['claimed-other-wallet',forge(b=>{(b.details!.advisory!.metrics.find(m=>m.id==='O24')!.data as any).cohort.wallet=stranger;})],
   ];
   for(const [name,candidate] of cases)assert.throws(()=>writer.analyzeLive(candidate),/ADVISORY_PROOF_INVALID/,name);
   const unhashed=structuredClone(bundle);unhashed.rawArtifacts[head]=unhashed.rawArtifacts[head]!.replace('"amount":"0"','"amount":"5"');
   assert.throws(()=>writer.analyzeLive(unhashed),/ARTIFACT_HASH_OR_SIZE/);
  }finally{writer.close();}
  const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id) as {semantic:string}).semantic).policyVersion,'research-screen-advisory-v20');}finally{db.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a live inventory without the wallet exit proof is retained and replayed but never supersedes the sampled O24',async()=>{
 const bundle=await live({walletPageError:true}),proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!),o24=bundle.details!.advisory!.metrics.find(m=>m.id==='O24')!;
 assert.ok(Object.keys(proof.creatorInventory.artifactIds).includes('creator-wallet-page-0'));
 assert.deepEqual([o24.quality,o24.reasonCode],['MISSING','PINNED_FIXED_COHORT_ENDPOINTS_REQUIRED']);
 assert.notEqual((o24.data as any)?.method,'creator-signer-wallet-inventory-v1');
 const directory=mkdtempSync(join(tmpdir(),'advisory-creator-inventory-partial-')),file=join(directory,'live.sqlite');
 try{const service=new Service(file);try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),service.show(saved.id));}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});
