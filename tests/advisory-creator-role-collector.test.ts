import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { collectCreatorRole,decodeCreatorRole,creatorRoleS13 } from '../src/providers/advisory-creator-role-collector.js';
import { PINNED_CREATE_V2,PUMP_PROGRAM,creatorRoleCoinUrl } from '../src/providers/advisory-creator-role.js';
import { encodeSolanaAddress,decodeSolanaAddress,TOKEN_2022_PROGRAM,SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { collectLiveToken } from '../src/app/live.js';
import { reconstructAdvisory } from '../src/app/advisory.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import type { AdvisoryMetric } from '../src/domain/advisory-contracts.js';

const key=(i:number)=>encodeSolanaAddress(Buffer.alloc(32,i)),sig=(i:number)=>encodeSolanaAddress(Buffer.alloc(64,i));
const SYS='11111111111111111111111111111111',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',CB='ComputeBudget111111111111111111111111111111';
const mint='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',token={chain:'solana' as const,address:mint},coin=creatorRoleCoinUrl(mint),wallet=key(8),stranger=key(10);
const T=Date.parse('2026-10-09T00:00:00.000Z')/1000,slot=400_000,createSig=sig(3),transferSig=sig(4),olderSig=sig(5),cutoff='2026-10-10T13:00:00.000Z';
const pump=new PublicKey(PUMP_PROGRAM),seedProgram=new PublicKey(Uint8Array.from(PINNED_CREATE_V2.mayhemSeedProgram)),mintKey=new PublicKey(mint);
const pda=(seeds:Buffer[],program=pump)=>PublicKey.findProgramAddressSync(seeds,program)[0].toBase58();
const bondingCurve=pda([Buffer.from('bonding-curve'),mintKey.toBuffer()]),mintAuthority=pda([Buffer.from('mint-authority')]),eventAuthority=pda([Buffer.from('__event_authority')]);
const accounts=[mint,mintAuthority,bondingCurve,getAssociatedTokenAddressSync(mintKey,new PublicKey(bondingCurve),true,new PublicKey(TOKEN_2022_PROGRAM)).toBase58(),pda([Buffer.from('global')]),wallet,SYS,TOKEN_2022_PROGRAM,ATA,PINNED_CREATE_V2.mayhemProgram,pda([Buffer.from('global-params')],seedProgram),pda([Buffer.from('sol-vault')],seedProgram),pda([Buffer.from('mayhem-state'),mintKey.toBuffer()],seedProgram),key(12),eventAuthority,PUMP_PROGRAM];
const str=(s:string)=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};
const i64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b;};
const label=(w:string)=>`${w.slice(0,4)}\u2026${w.slice(-4)}`,names=['Parasite','PARASITE','https://ipfs.io/ipfs/example'];

/** Same signed create_v2 structure as the role decoder tests, for the real mint address. */
function creationTx():any{
 const data=Buffer.concat([Buffer.from(PINNED_CREATE_V2.discriminator),...names.map(str),decodeSolanaAddress(wallet),Buffer.alloc(10)]);
 const event=Buffer.concat([Buffer.from(PINNED_CREATE_V2.eventDiscriminator),...names.map(str),decodeSolanaAddress(mint),decodeSolanaAddress(bondingCurve),decodeSolanaAddress(wallet),decodeSolanaAddress(wallet),i64(T),Buffer.alloc(115)]);
 const writable=new Set([wallet,mint,accounts[2],accounts[3],accounts[9],accounts[11],accounts[12],accounts[13]]);
 const keys=[...new Set([wallet,...accounts,CB])].map(pubkey=>({pubkey,signer:pubkey===wallet||pubkey===mint,writable:writable.has(pubkey),source:'transaction'}));
 const pre=keys.map(k=>k.pubkey===wallet?5_000_000_000:k.pubkey===mint?0:1),post=keys.map((k,i)=>k.pubkey===mint?2_753_360:pre[i]!);
 return{slot,blockTime:T,version:0,transaction:{signatures:[createSig,sig(6)],message:{accountKeys:keys,instructions:[{programId:CB,accounts:[],data:'LBc2Nb',stackHeight:1},{programId:PUMP_PROGRAM,accounts,data:encodeSolanaAddress(data),stackHeight:1}]}},
  meta:{err:null,status:{Ok:null},preBalances:pre,postBalances:post,innerInstructions:[{index:1,instructions:[
   {program:'system',programId:SYS,stackHeight:2,parsed:{type:'createAccount',info:{newAccount:mint,owner:TOKEN_2022_PROGRAM,source:wallet,lamports:1838960,space:234}}},
   {program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed:{type:'initializeMetadataPointer',info:{mint,metadataAddress:mint}}},
   {program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed:{type:'initializeMint2',info:{mint,decimals:6,mintAuthority}}},
   {program:'system',programId:SYS,stackHeight:2,parsed:{type:'createAccount',info:{newAccount:bondingCurve,owner:PUMP_PROGRAM,source:wallet,lamports:1285240,space:125}}},
   {programId:PUMP_PROGRAM,stackHeight:2,accounts:[eventAuthority],data:encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),event]))},
  ]}],
  logMessages:[`Program ${CB} invoke [1]`,`Program ${CB} success`,`Program ${PUMP_PROGRAM} invoke [1]`,'Program log: Instruction: CreateV2',`Program ${SYS} invoke [2]`,`Program ${SYS} success`,`Program ${TOKEN_2022_PROGRAM} invoke [2]`,`Program ${TOKEN_2022_PROGRAM} success`,`Program ${TOKEN_2022_PROGRAM} invoke [2]`,`Program ${TOKEN_2022_PROGRAM} success`,`Program ${SYS} invoke [2]`,`Program ${SYS} success`,`Program data: ${event.toString('base64')}`,`Program ${PUMP_PROGRAM} invoke [2]`,`Program ${PUMP_PROGRAM} success`,`Program ${PUMP_PROGRAM} success`]}};
}
/** A successful signed transfer by the same wallet that never touches the mint: a definite non-creation. */
const transferTx=(signature:string,blockTime:number,s:number):any=>({slot:s,blockTime,version:0,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:wallet,signer:true,writable:true,source:'transaction'},{pubkey:key(30),signer:false,writable:true,source:'transaction'},{pubkey:SYS,signer:false,writable:false,source:'transaction'}],instructions:[{program:'system',programId:SYS,stackHeight:1,parsed:{type:'transfer',info:{source:wallet,destination:key(30),lamports:1}}}]}},meta:{err:null,status:{Ok:null},preBalances:[10,0,1],postBalances:[9,1,1],innerInstructions:[],logMessages:[`Program ${SYS} invoke [1]`,`Program ${SYS} success`]}});
const page=(profile=wallet,published:string|null=new Date(T*1000).toISOString())=>({results:[{url:coin,final_url:coin,text:`Creator\n\n${label(profile)}\n\nMC`,links:[`https://pump.fun/profile/${profile}`,'https://x.com/parasitedotfun'],...(published?{published_date:published}:{})}],errors:[]});
const row=(signature:string,s:number,blockTime:number,err:unknown=null)=>({signature,slot:s,blockTime,err,confirmationStatus:'finalized'});
const baseRows=()=>[row(transferSig,slot+5,T+60),row(createSig,slot,T),row(olderSig,slot-1000,T-86400)];
function fake(o:{page?:unknown;status?:number;rows?:unknown[];txError?:string;transfer?:unknown}={}){
 const calls:Array<{url:string;headers:Record<string,string>;body:any}>=[];
 const txs=new Map<string,unknown>([[createSig,creationTx()],[transferSig,o.transfer??transferTx(transferSig,T+60,slot+5)]]);
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input),body=JSON.parse(String(init?.body??'null'));calls.push({url,headers:{...(init?.headers as Record<string,string>)},body});
  if(url==='https://api.fetch.tinyfish.ai/')return new Response(JSON.stringify(o.page??page()),{status:o.status??200});
  if(body.method==='getTransaction'&&body.params[0]===o.txError)return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32009,message:'unavailable'}}));
  const result=body.method==='getSignaturesForAddress'?(o.rows??baseRows()):body.method==='getTransaction'?(txs.get(body.params[0])??null):null;
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));
 };
 return{fetcher,calls};
}
const clock=()=>{let n=Date.parse('2026-10-10T12:00:00.000Z');return()=>new Date(n+=1000).toISOString();};
const collect=(o:Parameters<typeof fake>[0]={})=>{const f=fake(o);return collectCreatorRole(token,'tinyfish-secret','https://rpc.example',f.fetcher,clock()).then(r=>({r,calls:f.calls}));};

test('collector reads one page, one index and the windowed candidates without persisting the credential, and replay verifies exactly one creation',async()=>{
 const {r,calls}=await collect({rows:[...baseRows().slice(0,1),row(sig(7),slot+3,T+30,{InstructionError:[0,'Custom']}),...baseRows().slice(1)]});
 assert.deepEqual(Object.keys(r.requests),['page','index','transaction-0','transaction-1']);
 assert.equal(calls[0]!.headers['X-API-Key'],'tinyfish-secret');assert.ok(!JSON.stringify(r).includes('tinyfish-secret'));
 assert.deepEqual(calls[0]!.body,{urls:[coin],format:'markdown',links:true,ttl:0,per_url_timeout_ms:8000});
 const d=decodeCreatorRole(token,r,cutoff);
 assert.deepEqual([d.quality,d.reasonCode,d.binding?.wallet,d.binding?.validity.validAt],['KNOWN','PUBLIC_CREATOR_ROLE_BINDING_VERIFIED',wallet,'2026-10-09T00:00:00.000Z']);
 assert.deepEqual((d.data.candidates as any[]).map(c=>[c.signature,c.outcome]),[[transferSig,'NON_CREATE'],[createSig,'VERIFIED_CREATION']]);
 assert.deepEqual(d.data.failedInWindow,[sig(7)]);
 assert.deepEqual([d.data.metadataDiscoveryHintUsed,d.data.metadataUsedAsBirthProof,d.binding!.publicClaim.pagePublishedDateUsedAsBirthProof],[true,false,false]);
 const prior:AdvisoryMetric={id:'S13',quality:'TRUNCATED',unit:'separate inferred wallet edges',data:{method:'transaction-co-signing-edge-v1',edges:[{wallet:key(40),coSigner:key(41)}],publicActorBindings:[]},evidenceIds:['wallet-receipt'],reasonCode:'CO_SIGNING_WITNESSED_PUBLIC_ACTOR_BINDING_UNAVAILABLE'};
 const known=creatorRoleS13(prior,d,['creator-receipt']);
 assert.deepEqual([known.quality,known.reasonCode,(known.data as any).edges.length,(known.data as any).publicActorBindings.length,known.evidenceIds],['KNOWN','PUBLIC_CREATOR_ROLE_BINDING_VERIFIED',1,1,['wallet-receipt','creator-receipt']]);
 const kept=creatorRoleS13(prior,{...d,binding:null,quality:'TRUNCATED',reasonCode:'CREATOR_CANDIDATE_UNVERIFIED'},['creator-receipt']);
 assert.deepEqual([kept.quality,kept.reasonCode,(kept.data as any).edges.length,(kept.data as any).publicActorBindings.length],['TRUNCATED','CO_SIGNING_WITNESSED_PUBLIC_ACTOR_BINDING_UNAVAILABLE',1,0]);
});

test('page failures, missing metadata and over-cap windows stop discovery with disclosed, truthful states',async()=>{
 let {r}=await collect({status:404});
 assert.deepEqual(Object.keys(r.requests),['page']);assert.deepEqual([decodeCreatorRole(token,r,cutoff).quality,decodeCreatorRole(token,r,cutoff).reasonCode],['MISSING','WEB_FETCH_HTTP_404']);
 ({r}=await collect({page:page(wallet,null)}));
 assert.deepEqual(Object.keys(r.requests),['page']);assert.equal(decodeCreatorRole(token,r,cutoff).reasonCode,'CREATOR_DISCOVERY_DATE_UNAVAILABLE');
 const crowded=Array.from({length:9},(_,i)=>row(sig(20+i),slot+9-i,T+i));
 ({r}=await collect({rows:crowded}));
 const d=decodeCreatorRole(token,r,cutoff);
 assert.deepEqual(Object.keys(r.requests),['page','index']);
 assert.deepEqual([d.quality,d.reasonCode,d.binding,(d.data.candidates as any[]).map(c=>c.outcome)],['TRUNCATED','CREATOR_CANDIDATES_OVER_CAP',null,Array(9).fill('NOT_SELECTED')]);
});

test('an unverifiable candidate blocks the binding, and a profile contradicted by the signed creation is invalid',async()=>{
 let {r}=await collect({txError:transferSig});
 let d=decodeCreatorRole(token,r,cutoff);
 assert.deepEqual([d.quality,d.reasonCode,d.binding,(d.data.candidates as any[])[0].code],['TRUNCATED','CREATOR_CANDIDATE_UNVERIFIED',null,'CREATOR_ROLE_UNAVAILABLE']);
 ({r}=await collect({page:page(stranger)}));
 d=decodeCreatorRole(token,r,cutoff);
 assert.deepEqual([d.quality,d.reasonCode,d.binding],['INVALID','CREATOR_ROLE_CONTRADICTED',null]);
});

/** Replaces the transfer candidate's only instruction with a parsed Token-2022 entry, declaring its program and the mint as keys with a complete frame. */
const token22=(parsed:unknown)=>(tx:any)=>{
 for(const pubkey of [TOKEN_2022_PROGRAM,mint]){tx.transaction.message.accountKeys.push({pubkey,signer:false,writable:false,source:'lookupTable'});tx.meta.preBalances.push(1);tx.meta.postBalances.push(1);}
 tx.transaction.message.instructions=[{program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:1,parsed}];
 tx.meta.logMessages=[`Program ${TOKEN_2022_PROGRAM} invoke [1]`,`Program ${TOKEN_2022_PROGRAM} success`];
};

test('a fully resolved Token-2022 transferChecked candidate stays a definite non-creation beside the verified creation',async()=>{
 const transfer=transferTx(transferSig,T+60,slot+5);
 token22({type:'transferChecked',info:{source:key(30),destination:wallet,authority:wallet,mint,tokenAmount:{amount:'1',decimals:6,uiAmount:0.000001,uiAmountString:'0.000001'}}})(transfer);
 const {r}=await collect({transfer});
 const d=decodeCreatorRole(token,r,cutoff);
 assert.deepEqual([d.quality,d.reasonCode,d.binding?.wallet],['KNOWN','PUBLIC_CREATOR_ROLE_BINDING_VERIFIED',wallet]);
 assert.deepEqual((d.data.candidates as any[]).map(c=>[c.signature,c.outcome]),[[transferSig,'NON_CREATE'],[createSig,'VERIFIED_CREATION']]);
});

test('a malformed, truncated, incomplete or unparsed non-creation beside the verified creation keeps S13 truncated without a binding',async()=>{
 const edges=[{wallet:key(40),coSigner:key(41)}];
 const prior:AdvisoryMetric={id:'S13',quality:'TRUNCATED',unit:'separate inferred wallet edges',data:{method:'transaction-co-signing-edge-v1',edges,publicActorBindings:[]},evidenceIds:['wallet-receipt'],reasonCode:'CO_SIGNING_WITNESSED_PUBLIC_ACTOR_BINDING_UNAVAILABLE'};
 const variants:Array<[string,(tx:any)=>void]>=[
  ['TRANSACTION_SHAPE',tx=>{tx.transaction.message.instructions=[{programId:PUMP_PROGRAM}];tx.meta.innerInstructions=[];tx.meta.logMessages=['Log truncated'];}],
  ['LOG_TRUNCATED',tx=>{tx.meta.logMessages.push('Log truncated');}],
  ['LOG_INCOMPLETE',tx=>{tx.meta.logMessages=[];}],
  ['CREATE_UNSUPPORTED',tx=>{tx.transaction.message.instructions[0]={programId:SYS,accounts:[wallet,key(30)],data:'3Bxs4h24hBtQy9rw',stackHeight:1};}],
  // Terminal review cases on a parsed Token-2022 entry with intact program, frame, signature and clock bindings.
  ['CREATE_UNSUPPORTED',token22({type:'initializeMint2',info:{}})],
  ['CREATE_UNSUPPORTED',token22({type:'initializeMint2',info:{mint:'not-an-address'}})],
  ['CREATE_UNSUPPORTED',token22({type:'unsupported-critical-type',info:{}})],
 ];
 for(const [code,change] of variants){
  const transfer=transferTx(transferSig,T+60,slot+5);change(transfer);
  const {r}=await collect({transfer});
  assert.deepEqual(Object.keys(r.requests),['page','index','transaction-0','transaction-1'],code);
  const d=decodeCreatorRole(token,r,cutoff),s13=creatorRoleS13(prior,d,['creator-receipt']),data=s13.data as any;
  assert.deepEqual([d.quality,d.reasonCode,d.binding],['TRUNCATED','CREATOR_CANDIDATE_UNVERIFIED',null],code);
  assert.deepEqual((d.data.candidates as any[]).map(c=>[c.signature,c.outcome,c.code]),[[transferSig,'UNVERIFIED',`CREATOR_ROLE_${code}`],[createSig,'VERIFIED_CREATION',null]],code);
  assert.deepEqual([s13.quality,s13.reasonCode,data.edges,data.publicActorBindings,data.creatorRole.reasonCode,s13.evidenceIds],['TRUNCATED','CO_SIGNING_WITNESSED_PUBLIC_ACTOR_BINDING_UNAVAILABLE',edges,[],'CREATOR_CANDIDATE_UNVERIFIED',['wallet-receipt','creator-receipt']],code);
 }
});

test('replay rejects request, order, clock and key tampering, while an uncollected candidate stays truncated',async()=>{
 const {r}=await collect();
 const tampered=(change:(x:typeof r)=>void)=>{const x=structuredClone(r);change(x);return x;};
 const cases:Array<[string,typeof r]>=[
  ['swapped-signature',tampered(x=>{x.requests['transaction-0']={method:'getTransaction',params:[olderSig,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]};})],
  ['reordered',tampered(x=>{[x.requests['transaction-0'],x.requests['transaction-1']]=[x.requests['transaction-1'],x.requests['transaction-0']];[x.rawArtifacts['transaction-0'],x.rawArtifacts['transaction-1']]=[x.rawArtifacts['transaction-1']!,x.rawArtifacts['transaction-0']!];})],
  ['index-before-page',tampered(x=>{x.retrievedAt.index=new Date(Date.parse(x.retrievedAt.page!)-1).toISOString();})],
  ['extra-key',tampered(x=>{x.requests['transaction-5']=x.requests['transaction-0'];x.rawArtifacts['transaction-5']=x.rawArtifacts['transaction-0']!;x.retrievedAt['transaction-5']=x.retrievedAt['transaction-0']!;})],
  ['page-request',tampered(x=>{(x.requests.page as any).body.ttl=3600;})],
  ['future-receipt',tampered(x=>{x.retrievedAt['transaction-1']='2026-10-10T14:00:00.000Z';})],
 ];
 for(const [name,x] of cases)assert.throws(()=>decodeCreatorRole(token,x,cutoff),/ADVISORY_CREATOR_ROLE_RECEIPT/,name);
 const partial=tampered(x=>{delete x.requests['transaction-1'];delete x.rawArtifacts['transaction-1'];delete x.retrievedAt['transaction-1'];});
 const d=decodeCreatorRole(token,partial,cutoff);
 assert.deepEqual([d.quality,d.reasonCode,d.binding,(d.data.candidates as any[])[1].outcome],['TRUNCATED','CREATOR_CANDIDATE_UNVERIFIED',null,'NOT_COLLECTED']);
});

const pool='4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',quote='So11111111111111111111111111111111111111112';
const at='2026-10-10T12:30:00.000Z',hour=Date.parse('2026-10-10T12:00:00.000Z')/1000,day=Date.parse('2026-10-10T00:00:00.000Z')/1000;
const creator=fake();
/** The advisory integration public fixture plus the creator page, wallet index and candidate transactions. */
const liveFetcher:typeof fetch=async(input,init)=>{
 const url=String(input);
 if(url==='https://api.fetch.tinyfish.ai/')return creator.fetcher(input,init);
 if(init?.method==='POST'){
  const request=JSON.parse(String(init.body));
  if(request.method==='getSignaturesForAddress'&&request.params[0]===wallet||request.method==='getTransaction'&&[createSig,transferSig].includes(request.params[0]))return creator.fetcher(input,init);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:request.method==='getSignaturesForAddress'?[]:{context:{slot:1},value:null}}));
 }
 let value:unknown;
 if(url.includes('/token-pairs/'))value=[{chainId:'solana',dexId:'pumpswap',pairAddress:pool,baseToken:{address:mint},quoteToken:{address:quote},priceUsd:'1',liquidity:{usd:10000},volume:{h24:100},txns:{h24:{buys:4,sells:3}}}];
 else if(url.includes('include=base_token'))value={data:{id:`solana_${pool}`,type:'pool',attributes:{address:pool},relationships:{base_token:{data:{id:`solana_${mint}`,type:'token'}},quote_token:{data:{id:`solana_${quote}`,type:'token'}}}},included:[mint,quote].map(address=>({id:`solana_${address}`,type:'token',attributes:{address}}))};
 else if(url.includes('ohlcv'))value={data:{attributes:{ohlcv_list:Array.from({length:75},(_,i)=>[hour-i*3600,10+i%6,11+i%6,9+i%6,10+i%6,20])}}};
 else if(url.includes('coinbase'))value=Array.from({length:75},(_,i)=>[hour-i*3600,9+i%6,11+i%6,10+i%6,10+i%6,2]);
 else if(url.includes('llama'))value={chain:new URL(url).pathname.split('/').at(-1),totalDataChart:[[day-172800,10],[day-86400,20],[day,999]]};
 else if(url.includes('/orders/'))value={orders:[{chainId:'solana',tokenAddress:mint,type:'tokenProfile',status:'approved',paymentTimestamp:Date.parse(at)-1000}],boosts:[]};
 else throw new Error('Unexpected fixture request');
 return new Response(JSON.stringify(value));
};
const rehash=(bundle:{evidence:Array<{id:string;contentHash:string}>;rawArtifacts?:Record<string,string>},id:string)=>{bundle.evidence.find(e=>e.id===id)!.contentHash=createHash('sha256').update(bundle.rawArtifacts![id]!).digest('hex');};

test('live collection persists one verified S13 creator role through Service and rejects forged, downgraded, orphaned and claimed receipts',async()=>{
 const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'tinyfish-live-key',fetcher:liveFetcher,now:()=>at});
 const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!),facts=bundle.details!.advisory!,s13=facts.metrics.find(m=>m.id==='S13')!;
 assert.deepEqual([proof.method,facts.method],['advisory-provenance-v21','advisory-measurements-v22']);
 assert.deepEqual(Object.keys(proof.creatorRole.artifactIds),['page','index','transaction-0','transaction-1']);
 const receipts=bundle.evidence.filter(e=>e.sourceId==='advisory-creator-role');
 assert.ok(receipts.length===4&&receipts.every(e=>e.accessMode==='PUBLIC_API'&&e.adapterVersion==='live-v1'&&Object.keys(e.scope).join()==='request'));
 assert.ok(!JSON.stringify(bundle).includes('tinyfish-live-key'));
 assert.deepEqual([s13.quality,s13.reasonCode,(s13.data as any).publicActorBindings[0].actor.id,(s13.data as any).publicActorBindings[0].personIdentityAsserted],['KNOWN','PUBLIC_CREATOR_ROLE_BINDING_VERIFIED',`PUBLIC_PUMP_PROFILE:${wallet}`,false]);
 // A proof v14 never derives the role, and creator receipts without a descriptor are orphans.
 assert.throws(()=>reconstructAdvisory(token,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,{...proof,method:'advisory-provenance-v14',creatorRole:null},bundle.thesis??null,bundle.features),/ADVISORY_PROOF_INVALID/);
 const directory=mkdtempSync(join(tmpdir(),'advisory-creator-role-')),file=join(directory,'live.sqlite');
 try{
  const writer=new Service(file);let id='';
  try{
   id=writer.analyzeLive(bundle).id;
   const forge=(change:(b:typeof bundle,proof:any)=>void)=>{const b=structuredClone(bundle),p=JSON.parse(b.rawArtifacts['advisory-derivation']!);change(b,p);b.rawArtifacts['advisory-derivation']=JSON.stringify(p);rehash(b,'advisory-derivation');return b;};
   const cases:Array<[string,typeof bundle]>=[
    ['truncated-creation-log',forge(b=>{const rid='advisory-creatorRole-transaction-1',raw=JSON.parse(b.rawArtifacts[rid]!);raw.result.meta.logMessages.push('Log truncated');b.rawArtifacts[rid]=JSON.stringify(raw);rehash(b,rid);})],
    ['proof-v14-with-role',forge((_b,p)=>{p.method='advisory-provenance-v14';})],
    ['orphaned-role-receipts',forge((_b,p)=>{p.creatorRole=null;})],
    ['claimed-other-wallet',forge(b=>{((b.details!.advisory!.metrics.find(m=>m.id==='S13')!.data as any).publicActorBindings[0]).wallet=stranger;})],
    ['mutated-index-request',forge((b,p)=>{const request={method:'getSignaturesForAddress',params:[stranger,{limit:1000,commitment:'finalized'}]};p.creatorRole.requests.index=request;b.evidence.find(e=>e.id==='advisory-creatorRole-index')!.scope={request};})],
   ];
   for(const [name,candidate] of cases)assert.throws(()=>writer.analyzeLive(candidate),/ADVISORY_PROOF_INVALID/,name);
  }finally{writer.close();}
  const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id) as {semantic:string}).semantic).policyVersion,'research-screen-advisory-v20');}finally{db.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});
