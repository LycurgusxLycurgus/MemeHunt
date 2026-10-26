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
import { PINNED_CREATE_V2,PUMP_PROGRAM,creatorRoleCoinUrl } from '../src/providers/advisory-creator-role.js';
import { encodeSolanaAddress,decodeSolanaAddress,TOKEN_2022_PROGRAM,SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { collectLiveToken } from '../src/app/live.js';
import { Service,decisionHash } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { reconstructAdvisory } from '../src/app/advisory.js';

// The public-shaped synthetic world of advisory-creator-inventory-collector.test.ts (signed creation, wallet, canonical account, pool and complete tape), restated because test modules export no fixtures; no private receipt is read.
const key=(i:number)=>encodeSolanaAddress(Buffer.alloc(32,i)),sig=(i:number)=>encodeSolanaAddress(Buffer.alloc(64,i));
const SYS='11111111111111111111111111111111',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',CB='ComputeBudget111111111111111111111111111111',T22=TOKEN_2022_PROGRAM,quote='So11111111111111111111111111111111111111112';
const mint='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',token={chain:'solana' as const,address:mint},wallet=key(8),stranger=key(10);
const account=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(wallet),true,TOKEN_2022_PROGRAM_ID).toBase58();
const T=Date.parse('2026-10-09T00:00:00.000Z')/1000,slot=400_000,createSig=sig(3),transferSig=sig(4),olderSig=sig(5),ataSig=sig(11);
const at='2026-10-10T12:30:00.000Z',ANCHOR=10_001,HEAD=500_000,CATALOG=500_010;
const pump=new PublicKey(PUMP_PROGRAM),seedProgram=new PublicKey(Uint8Array.from(PINNED_CREATE_V2.mayhemSeedProgram)),mintKey=new PublicKey(mint);
const pda=(seeds:Buffer[],program=pump)=>PublicKey.findProgramAddressSync(seeds,program)[0].toBase58();
const bondingCurve=pda([Buffer.from('bonding-curve'),mintKey.toBuffer()]),mintAuthority=pda([Buffer.from('mint-authority')]),eventAuthority=pda([Buffer.from('__event_authority')]);
const createAccounts=[mint,mintAuthority,bondingCurve,getAssociatedTokenAddressSync(mintKey,new PublicKey(bondingCurve),true,TOKEN_2022_PROGRAM_ID).toBase58(),pda([Buffer.from('global')]),wallet,SYS,T22,ATA,PINNED_CREATE_V2.mayhemProgram,pda([Buffer.from('global-params')],seedProgram),pda([Buffer.from('sol-vault')],seedProgram),pda([Buffer.from('mayhem-state'),mintKey.toBuffer()],seedProgram),key(12),eventAuthority,PUMP_PROGRAM];
const str=(s:string)=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};
const i64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b;};
const names=['Parasite','PARASITE','https://ipfs.io/ipfs/example'];
function creationTx():any{
 const data=Buffer.concat([Buffer.from(PINNED_CREATE_V2.discriminator),...names.map(str),decodeSolanaAddress(wallet),Buffer.alloc(10)]);
 const event=Buffer.concat([Buffer.from(PINNED_CREATE_V2.eventDiscriminator),...names.map(str),decodeSolanaAddress(mint),decodeSolanaAddress(bondingCurve),decodeSolanaAddress(wallet),decodeSolanaAddress(wallet),i64(T),Buffer.concat([Buffer.alloc(32),decodeSolanaAddress(TOKEN_2022_PROGRAM),Buffer.alloc(51)])]);
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
const transferTx=(signature:string,blockTime:number,s:number):any=>({slot:s,blockTime,version:0,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:wallet,signer:true,writable:true,source:'transaction'},{pubkey:key(30),signer:false,writable:true,source:'transaction'},{pubkey:SYS,signer:false,writable:false,source:'transaction'}],instructions:[{program:'system',programId:SYS,stackHeight:1,parsed:{type:'transfer',info:{source:wallet,destination:key(30),lamports:1}}}]}},meta:{err:null,status:{Ok:null},preBalances:[10,0,1],postBalances:[9,1,1],preTokenBalances:[],postTokenBalances:[],innerInstructions:[],logMessages:[`Program ${SYS} invoke [1]`,`Program ${SYS} success`]}});
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
const reply=(body:unknown)=>new Response(JSON.stringify(body));
/** Finalized RPC for the S13 role index, the ATA head and index, the owner catalog, the pinned wallet page and the transactions. */
const world:typeof fetch=async(_input,init)=>{
 const body=JSON.parse(String(init?.body)),ok=(result:unknown)=>reply({jsonrpc:'2.0',id:1,result});
 const transfer=transferTx(transferSig,T+60,slot+5),txs:Record<string,unknown>={[createSig]:creationTx(),[transferSig]:transfer,[ataSig]:ataTx()};
 if(body.method==='getTransaction')return ok(txs[body.params[0]]??null);
 if(body.method==='getAccountInfo')return ok({context:{slot:HEAD},value:parsedAccount('0')});
 if(body.method==='getSignaturesForAddress')return ok(body.params[0]===account?[row(ataTx())]:[row(ataTx()),row(transfer),row(creationTx()),older]);
 if(body.method==='getTokenAccountsByOwner')return ok({context:{slot:CATALOG},value:[{pubkey:account,account:parsedAccount('0')}]});
 throw new Error('UNEXPECTED_RPC');
};
const hour=Date.parse('2026-10-10T12:00:00.000Z')/1000,day=Date.parse('2026-10-10T00:00:00.000Z')/1000;
const poolCreator=new PublicKey(Buffer.alloc(32,7)),pool=poolPda(0,poolCreator,new PublicKey(mint),NATIVE_MINT).toBase58();
const wsolMintData=(()=>{const b=Buffer.alloc(82);b[44]=9;b[45]=1;return b.toString('base64');})();
const coin=creatorRoleCoinUrl(mint),creatorPage={results:[{url:coin,final_url:coin,text:`Creator\n\n${wallet.slice(0,4)}…${wallet.slice(-4)}\n\nMC`,links:[`https://pump.fun/profile/${wallet}`],published_date:new Date(T*1000).toISOString()}],errors:[]};
/** Public live fixture with a verifiable pool and anchor (complete hour and A30 tape), the S13 creator page and the inventory world. */
async function liveFetcher():Promise<typeof fetch>{
 const type=sdk.idl.types!.find(t=>t.name==='pool')!,state:Record<string,unknown>={};
 for(const f of (type.type as any).fields)state[f.name]=f.type==='pubkey'?poolCreator:f.type==='bool'?false:f.type==='string'?'':f.type==='u8'||f.type==='u16'?0:new BN(0);
 Object.assign(state,{baseMint:new PublicKey(mint),quoteMint:NATIVE_MINT});
 const poolData=(await sdk.coder.accounts.encode('pool',state)).toString('base64');
 return async(input,init)=>{
  const url=String(input);let value:unknown;
  if(url==='https://api.fetch.tinyfish.ai/')return reply(creatorPage);
  if(init?.method==='POST'){
   const request=JSON.parse(String(init.body));
   if(request.method==='getTransaction'||request.method==='getTokenAccountsByOwner'||request.params?.[0]===account||request.method==='getSignaturesForAddress'&&request.params[0]===wallet)return world(input,init);
   value={jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:request.method==='getSlot'?ANCHOR:request.method==='getBlockTime'?hour+60:request.method==='getSignaturesForAddress'?[]:request.method==='getAccountInfo'&&request.params[0]===pool?{context:{slot:ANCHOR+1},value:{owner:PUMP_AMM_PROGRAM_ID.toBase58(),executable:false,lamports:1,data:[poolData,'base64']}}:request.method==='getMultipleAccounts'&&request.params[0]?.[0]===pool?{context:{slot:ANCHOR+1},value:[{owner:PUMP_AMM_PROGRAM_ID.toBase58(),executable:false,lamports:1,data:[poolData,'base64']},{owner:T22,executable:false,lamports:1,data:[wsolMintData,'base64']}]}:{context:{slot:1},value:null}};
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
const live=async()=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'tinyfish-live-key',fetcher:await liveFetcher(),now:()=>at});
type Bundle=Awaited<ReturnType<typeof live>>;
const rehash=(b:Bundle,id:string)=>{b.evidence.find(e=>e.id===id)!.contentHash=createHash('sha256').update(b.rawArtifacts[id]!).digest('hex');};
const proofOf=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const setProof=(b:Bundle,proof:unknown)=>{b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');};
const reconstruct=(b:Bundle,proof:unknown=proofOf(b))=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);
const REJECTED=/ADVISORY_PROOF_INVALID|LIVE_PROVENANCE_INVALID|FUTURE_EVIDENCE|DUPLICATE_BUNDLE_ID|ARTIFACT_HASH_OR_SIZE|UNREFERENCED_ARTIFACT/;

test('a KNOWN creator inventory is fresh proof v20 and facts v21, persists under policy v20 and replays exactly',async()=>{
 const bundle=await live(),proof=proofOf(bundle),facts=bundle.details!.advisory!,o24=facts.metrics.find(m=>m.id==='O24')!;
 assert.deepEqual([proof.method,facts.method,facts.metrics.length,proof.launchpad],['advisory-provenance-v40','advisory-measurements-v39',50,null]);
 assert.deepEqual([o24.quality,(o24.data as any).method,(o24.data as any).cohort.wallet,facts.metrics.find(m=>m.id==='S13')!.quality,facts.metrics.find(m=>m.id==='A30')!.quality],['KNOWN','creator-signer-wallet-inventory-v1',wallet,'KNOWN','KNOWN']);
 // C16 and the one-hour supplement keep their accepted wiring; the supplement stays outside the 50 metrics.
 assert.equal(facts.metrics.find(m=>m.id==='C16')!.reasonCode,'LAUNCHPAD_RECEIPTS_NOT_COLLECTED');assert.ok(facts.supplements?.shortDemand);
 assert.equal(decisionHash(reconstruct(bundle)),decisionHash(facts));
 const directory=mkdtempSync(join(tmpdir(),'advisory-creator-inventory-v18-')),file=join(directory,'live.sqlite');
 try{
  const writer=new Service(file);let id='';try{id=writer.analyzeLive(bundle).id;}finally{writer.close();}
  const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id) as {semantic:string}).semantic).policyVersion,'research-screen-advisory-v37');}finally{db.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('the creator-inventory namespace is exactly its descriptor: extra, orphan, duplicate, cross-id, empty, removed, downgraded, rehashed, rescoped and reclocked receipts fail closed',async()=>{
 const bundle=await live(),head='advisory-creatorInventory-creator-ata-head',directory=mkdtempSync(join(tmpdir(),'advisory-creator-inventory-namespace-'));
 const recordOf=(b:Bundle,id=head)=>b.evidence.find(e=>e.id===id)!;
 const forge=(change:(b:Bundle,p:any)=>void)=>{const b=structuredClone(bundle),p=proofOf(b);change(b,p);setProof(b,p);return b;};
 const extra=(b:Bundle,id:string,patch:Partial<Bundle['evidence'][number]>={})=>{b.rawArtifacts[id]=b.rawArtifacts[head]!;b.evidence.push({...structuredClone(recordOf(b)),id,...patch});rehash(b,id);};
 const strip=(b:Bundle,keep:(id:string)=>boolean)=>{b.evidence=b.evidence.filter(e=>keep(e.id));for(const id of Object.keys(b.rawArtifacts))if(!keep(id))delete b.rawArtifacts[id];};
 const cases:Array<[string,Bundle]>=[
  // With the descriptor present, an undeclared record owned by source or by the reserved prefix is rejected like the C16 namespace.
  ['extra-prefixed-same-source',forge(b=>extra(b,'advisory-creatorInventory-extra',{adapterVersion:'untrusted',scope:{request:{method:'getAccountInfo',params:[stranger]}}}))],
  ['extra-source-unprefixed-id',forge(b=>extra(b,'creator-inventory-shadow'))],
  ['reserved-prefix-foreign-source',forge(b=>extra(b,'advisory-creatorInventory-shadow',{sourceId:'advisory-window'}))],
  ['duplicate-declared-receipt',forge(b=>{b.evidence.push(structuredClone(recordOf(b)));})],
  ['cross-id-descriptor',forge((_b,p)=>{p.creatorInventory.artifactIds['creator-ata-page-0']=head;})],
  ['empty-descriptor',forge((_b,p)=>{p.creatorInventory={requests:{},artifactIds:{}};})],
  ['empty-descriptor-without-receipts',forge((b,p)=>{p.creatorInventory={requests:{},artifactIds:{}};strip(b,id=>!id.startsWith('advisory-creatorInventory-'));})],
  ['null-descriptor-orphans',forge((_b,p)=>{p.creatorInventory=null;})],
  ['missing-descriptor',forge((_b,p)=>{delete p.creatorInventory;})],
  ['declared-receipt-removed',forge(b=>strip(b,id=>id!==head))],
  ['proof-v17-with-inventory',forge((_b,p)=>{p.method='advisory-provenance-v17';})],
  ['self-consistent-v17-downgrade',forge((_b,p)=>{p.method='advisory-provenance-v17';delete p.creatorInventory;})],
  ['role-descriptor-removed',forge((_b,p)=>{p.creatorRole=null;})],
  ['stale-receipt-hash',forge(b=>{recordOf(b).contentHash='0'.repeat(64);})],
  ['rescoped-receipt',forge(b=>{recordOf(b).scope={...recordOf(b).scope,wallet:stranger};})],
  ['future-receipt-clock',forge(b=>{const r=recordOf(b);r.retrievedAt=r.availableAt='2026-10-10T12:31:00.000Z';})],
  ['split-receipt-clock',forge(b=>{recordOf(b).availableAt='2026-10-10T12:29:00.000Z';})],
 ];
 assert.equal(decisionHash(reconstruct(structuredClone(bundle))),decisionHash(bundle.details!.advisory),'the unmodified bundle is the positive control');
 try{
  for(const [name,b] of cases){
   assert.throws(()=>reconstruct(b),/ADVISORY_PROOF_INVALID/,name);
   const service=new Service(join(directory,`${name}.sqlite`));
   try{assert.throws(()=>service.analyzeLive(b),REJECTED,name);}finally{service.close();}
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
