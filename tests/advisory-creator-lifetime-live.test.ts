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

// The accepted public-shaped O24 live world of advisory-creator-inventory-live.test.ts (signed creation, wallet, canonical account, pool and complete tape), restated verbatim because test modules export no fixtures; no private receipt is read and O24 completion is never mocked.
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
const live=async()=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'tinyfish-live-key',fetcher:await liveFetcher(),now:()=>at});
type Bundle=Awaited<ReturnType<typeof live>>;
const rehash=(b:Bundle,id:string)=>{b.evidence.find(e=>e.id===id)!.contentHash=createHash('sha256').update(b.rawArtifacts[id]!).digest('hex');};
const proofOf=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const setProof=(b:Bundle,proof:unknown)=>{b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');};
const reconstruct=(b:Bundle,proof:unknown=proofOf(b))=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);
const REJECTED=/ADVISORY_PROOF_INVALID|LIVE_PROVENANCE_INVALID|FUTURE_EVIDENCE|DUPLICATE_BUNDLE_ID|ARTIFACT_HASH_OR_SIZE|UNREFERENCED_ARTIFACT/;
const metric=(facts:{metrics:Array<{id:string}>},id:string)=>facts.metrics.find(m=>m.id===id) as any;

test('fresh proof v20 derives O25 from the same typed role, tape, inventory receipts and reuse as O24, keeps S15 unready without failed-fee reads, persists under policy v20 and replays exactly',async()=>{
 const bundle=await live(),proof=proofOf(bundle),facts=bundle.details!.advisory!,o24=metric(facts,'O24'),o25=metric(facts,'O25'),d=o25.data,i=o24.data;
 assert.deepEqual([proof.method,facts.method,facts.metrics.length,proof.launchpad],['advisory-provenance-v20','advisory-measurements-v21',50,null]);
 // S15 needs a target position; this created, never-funded account has none, so the gate is unready, no failed-fee read is admitted and the descriptor stays null, never a zero.
 const s15=metric(facts,'S15');
 assert.deepEqual([proof.creatorFailedFees,s15.quality,s15.reasonCode,s15.data.status,s15.data.position,s15.data.networkFees,s15.data.basis.lifetimeReasonCode],[null,'MISSING','S15_NO_TARGET_POSITION','PREREQUISITE_UNRESOLVED',null,null,'CREATOR_LIFETIME_VECTOR_OBSERVED']);
 assert.ok(!bundle.evidence.some(e=>e.sourceId==='advisory-creator-failed-fees'||e.id.startsWith('advisory-creatorFailedFees-')||e.adapterVersion==='creator-failed-fee-archive-v1'));
 assert.deepEqual([o24.quality,o25.quality,o25.reasonCode,o25.unit],['KNOWN','KNOWN','CREATOR_LIFETIME_VECTOR_OBSERVED','scoped-record']);
 // Same evidence, cohort, interval and reused receipts as O24; no new namespace, source or read.
 assert.deepEqual(o25.evidenceIds,o24.evidenceIds);
 assert.deepEqual(Object.keys(proof.creatorInventory.artifactIds),['creator-ata-head','creator-ata-page-0',`creator-tx-${ataSig}`,'creator-owner-accounts','creator-wallet-page-0']);
 assert.ok(!bundle.evidence.some(e=>e.sourceId.includes('lifetime')||e.id.includes('O25')));
 assert.deepEqual([d.method,d.cohort.kind,d.cohort.wallet,d.cohort.creationSignature,d.cohort.creationSlot,d.cohort.canonicalAccount,d.cohort.identity,d.cohort.control],['creator-lifetime-on-inventory-v1','CREATOR_ONLY',wallet,createSig,slot,account,null,null]);
 assert.deepEqual([d.interval,d.currentSells.interval],[i.interval,i.interval]);assert.equal(Date.parse(d.interval.end)-Date.parse(d.interval.start),21_600_000);
 assert.deepEqual([d.inventoryBasis.reasonCode,d.inventoryBasis.pendingPremises],['CREATOR_SIGNER_INVENTORY_OBSERVED',0]);
 assert.deepEqual([d.coverage.headSlot,d.coverage.catalogSlot,d.coverage.ataIndex.rows,d.coverage.ataIndex.exhausted,d.coverage.walletIndex.rowsSinceCreation,d.coverage.walletIndex.successfulInspected,d.coverage.canonicalReceipts],[HEAD,CATALOG,1,true,3,3,[ataSig]]);
 // A created, never-funded canonical account: zero atomic bands, undefined shares and an undefined realized fraction, never a zero-filled ratio.
 assert.deepEqual([d.ledger,d.flows.buyAtomic,d.flows.sellAtomic,d.holdings.heldAtomic,d.holdings.shareDenominator,d.realized.acquiredAtomic,d.realized.fraction],[[],'0','0','0','UNDEFINED_ZERO_HELD','0',null]);
 assert.ok([...d.holdings.ageBands,...d.holdings.costBands].every((b:any)=>b.atomic==='0'&&b.shareOfHeld===null));
 assert.deepEqual([d.currentSells.sells,d.currentSells.unitsAtomic,d.quote.usdBasis,d.quote.trackerValuesUsed],[0,'0',null,false]);
 // S13's retained creation and transfer bodies are reused under their own ids, clocks and hashes; the inventory namespace never stores them twice.
 assert.deepEqual([d.coverage.reusedReceipts,d.inventoryBasis.reusedReceipts,i.reusedReceipts],[['advisory-creatorRole-transaction-0','advisory-creatorRole-transaction-1'],i.reusedReceipts,['advisory-creatorRole-transaction-0','advisory-creatorRole-transaction-1']]);
 const reusedSignatures=d.coverage.reusedReceipts.map((id:string)=>{
  const record=bundle.evidence.find(e=>e.id===id)!;
  assert.deepEqual([record.sourceId,record.adapterVersion,record.availableAt===record.retrievedAt,record.contentHash],['advisory-creator-role','live-v1',true,createHash('sha256').update(bundle.rawArtifacts[id]!).digest('hex')]);
  return JSON.parse(bundle.rawArtifacts[id]!).result.transaction.signatures[0];
 }).sort();
 assert.deepEqual(reusedSignatures,[createSig,transferSig].sort());
 assert.ok(![createSig,transferSig].some(s=>Object.hasOwn(proof.creatorInventory.requests,`creator-tx-${s}`)));
 assert.equal(decisionHash(reconstruct(bundle)),decisionHash(facts));
 assert.ok(!JSON.stringify(bundle).includes('tinyfish-live-key'));
 const directory=mkdtempSync(join(tmpdir(),'advisory-creator-lifetime-v19-')),file=join(directory,'live.sqlite');
 try{
  const writer=new Service(file);let id='';
  try{
   id=writer.analyzeLive(bundle).id;
   const claimed=structuredClone(bundle);metric(claimed.details!.advisory!,'O25').data.realized.fraction='1';
   assert.throws(()=>writer.analyzeLive(claimed),REJECTED);
  }finally{writer.close();}
  const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id) as {semantic:string}).semantic).policyVersion,'research-screen-advisory-v20');}finally{db.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('the same O24 raw under proof v18 never derives O25, keeps every other metric and is not fresh persistence',async()=>{
 const bundle=await live(),proof=proofOf(bundle),facts=bundle.details!.advisory!;
 const v18={...proof,method:'advisory-provenance-v18'},old=reconstruct(bundle,v18),o25=metric(old,'O25');
 assert.deepEqual([old.method,o25.quality,o25.reasonCode,o25.data,o25.evidenceIds],['advisory-measurements-v19','MISSING','INVENTORY_COST_AND_AGE_HISTORY_REQUIRED',null,[]]);
 // Fresh proof v20 also replaces the S15 registry row over this same O25 with its unready record; proof v18 keeps the registry default.
 const others=(metrics:typeof facts.metrics)=>metrics.filter(m=>m.id!=='O25'&&m.id!=='S15');
 assert.deepEqual([metric(old,'S15').reasonCode,metric(old,'S15').data,metric(facts,'S15').reasonCode],['TRANSFER_AWARE_ACTOR_COST_BASIS_REQUIRED',null,'S15_NO_TARGET_POSITION']);
 assert.deepEqual([others(old.metrics),old.supplements],[others(facts.metrics),facts.supplements]);
 assert.deepEqual(metric(old,'O24'),metric(facts,'O24'));
 const adv=(f:typeof facts)=>f.groups.find(g=>g.checkId==='ADV-01')!;
 assert.equal(adv(facts).known-adv(old).known,1);assert.ok(adv(old).unresolved.includes('O25')&&!adv(facts).unresolved.includes('O25'));
 const downgraded=structuredClone(bundle);setProof(downgraded,v18);downgraded.details!.advisory=old;
 const directory=mkdtempSync(join(tmpdir(),'advisory-creator-lifetime-v18-'));
 try{const service=new Service(join(directory,'live.sqlite'));try{assert.throws(()=>service.analyzeLive(downgraded),REJECTED);}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});

test('the same raw under saved proof v19 keeps O25, never derives S15 and is not fresh persistence',async()=>{
 const bundle=await live(),proof=proofOf(bundle),facts=bundle.details!.advisory!;
 const v19={...proof,method:'advisory-provenance-v19',creatorFailedFees:undefined},old=reconstruct(bundle,v19),s15=metric(old,'S15');
 assert.deepEqual([old.method,s15.quality,s15.reasonCode,s15.data,metric(old,'O25')],['advisory-measurements-v20','MISSING','TRANSFER_AWARE_ACTOR_COST_BASIS_REQUIRED',null,metric(facts,'O25')]);
 const others=(metrics:typeof facts.metrics)=>metrics.filter(m=>m.id!=='S15');
 assert.deepEqual([others(old.metrics),old.supplements],[others(facts.metrics),facts.supplements]);
 const downgraded=structuredClone(bundle);setProof(downgraded,v19);downgraded.details!.advisory=old;
 const directory=mkdtempSync(join(tmpdir(),'advisory-creator-lifetime-v19-frozen-'));
 try{const service=new Service(join(directory,'live.sqlite'));try{assert.throws(()=>service.analyzeLive(downgraded),REJECTED);}finally{service.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});

test('a v20 proof without creator-inventory receipts keeps the O25 and S15 registry defaults',async()=>{
 const bundle=await live(),b=structuredClone(bundle),p=proofOf(b);
 p.creatorInventory=null;b.evidence=b.evidence.filter(e=>!e.id.startsWith('advisory-creatorInventory-'));
 for(const id of Object.keys(b.rawArtifacts))if(id.startsWith('advisory-creatorInventory-'))delete b.rawArtifacts[id];
 setProof(b,p);
 const facts=reconstruct(b,p),o25=metric(facts,'O25');
 const s15=metric(facts,'S15');
 assert.deepEqual([facts.method,o25.quality,o25.reasonCode,o25.data,o25.evidenceIds,p.creatorFailedFees,s15.reasonCode,s15.data],['advisory-measurements-v21','MISSING','INVENTORY_COST_AND_AGE_HISTORY_REQUIRED',null,[],null,'TRANSFER_AWARE_ACTOR_COST_BASIS_REQUIRED',null]);
});

test('a failed inventory read leaves O24 unpromoted and O25 at the inherited quality without any vector',async()=>{
 const bundle=await live(),b=structuredClone(bundle),id='advisory-creatorInventory-creator-wallet-page-0',clock=b.evidence.find(e=>e.id===id)!.retrievedAt;
 b.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'RPC_TRANSPORT'}});rehash(b,id);
 const facts=reconstruct(b),o24=metric(facts,'O24'),o25=metric(facts,'O25'),d=o25.data;
 assert.notEqual(o24.quality,'KNOWN');assert.equal(b.evidence.find(e=>e.id===id)!.retrievedAt,clock);
 assert.deepEqual([o25.quality,o25.reasonCode,d.status,d.inventoryBasis.walletProof.code,d.holdings,d.realized,d.currentSells],['TRUNCATED','O25_INVENTORY_PREREQUISITE_UNRESOLVED','PREREQUISITE_UNRESOLVED','RPC_TRANSPORT',null,null,null]);
 assert.deepEqual(o25.evidenceIds,metric(bundle.details!.advisory!,'O25').evidenceIds);
});
