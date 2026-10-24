import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { verifyPublicCreatorRole, creatorRolePageRequest, creatorRoleIndexRequest, creatorRoleTransactionRequest, creatorRoleCoinUrl, CREATOR_ROLE_RECEIPTS as R, PINNED_CREATE_V2, PUMP_PROGRAM } from '../src/providers/advisory-creator-role.js';
import { encodeSolanaAddress, decodeSolanaAddress, TOKEN_2022_PROGRAM } from '../src/providers/solana.js';

const key=(i:number)=>encodeSolanaAddress(Buffer.alloc(32,i)),sig=(i:number)=>encodeSolanaAddress(Buffer.alloc(64,i));
const SYS='11111111111111111111111111111111',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',CB='ComputeBudget111111111111111111111111111111';
const wallet=key(8),mint=key(9),stranger=key(10),token={chain:'solana' as const,address:mint},coin=creatorRoleCoinUrl(mint);
const T=1790643467,slot=451486744,signature=sig(3),cutoff='2026-10-12T05:00:00.000Z';
const pump=new PublicKey(PUMP_PROGRAM),seedProgram=new PublicKey(Uint8Array.from(PINNED_CREATE_V2.mayhemSeedProgram)),mintKey=new PublicKey(mint);
const pda=(seeds:Buffer[],program=pump)=>PublicKey.findProgramAddressSync(seeds,program)[0].toBase58();
const bondingCurve=pda([Buffer.from('bonding-curve'),mintKey.toBuffer()]),mintAuthority=pda([Buffer.from('mint-authority')]),eventAuthority=pda([Buffer.from('__event_authority')]);
const accounts=[mint,mintAuthority,bondingCurve,getAssociatedTokenAddressSync(mintKey,new PublicKey(bondingCurve),true,new PublicKey(TOKEN_2022_PROGRAM)).toBase58(),pda([Buffer.from('global')]),wallet,SYS,TOKEN_2022_PROGRAM,ATA,PINNED_CREATE_V2.mayhemProgram,pda([Buffer.from('global-params')],seedProgram),pda([Buffer.from('sol-vault')],seedProgram),pda([Buffer.from('mayhem-state'),mintKey.toBuffer()],seedProgram),key(12),eventAuthority,PUMP_PROGRAM];
const str=(s:string)=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};
const i64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b;};
const names=['Parasite','PARASITE','https://ipfs.io/ipfs/example'];
const label=(w:string)=>`${w.slice(0,4)}\u2026${w.slice(-4)}`;

function build(o:{argCreator?:string;eventCreator?:string;argTail?:number;eventTail?:number;extraAccount?:boolean}={}){
 const data=Buffer.concat([Buffer.from(PINNED_CREATE_V2.discriminator),...names.map(str),decodeSolanaAddress(o.argCreator??wallet),Buffer.alloc(o.argTail??11)]);
 // 115 tail bytes mirror the retained 367-byte event that lacks the current trailing depth field.
 const event=Buffer.concat([Buffer.from(PINNED_CREATE_V2.eventDiscriminator),...names.map(str),decodeSolanaAddress(mint),decodeSolanaAddress(bondingCurve),decodeSolanaAddress(wallet),decodeSolanaAddress(o.eventCreator??wallet),i64(T),Buffer.alloc(o.eventTail??115)]);
 const ixAccounts=o.extraAccount?[...accounts,key(13)]:accounts;
 const writable=new Set([wallet,mint,accounts[2],accounts[3],accounts[9],accounts[11],accounts[12],accounts[13]]);
 const keys=[...new Set([wallet,...ixAccounts,CB])].map(pubkey=>({pubkey,signer:pubkey===wallet||pubkey===mint,writable:writable.has(pubkey),source:'transaction'}));
 const pre=keys.map(k=>k.pubkey===wallet?5_000_000_000:k.pubkey===mint?0:1),post=keys.map((k,i)=>k.pubkey===mint?2_753_360:pre[i]!);
 const tx:any={slot,blockTime:T,version:0,transaction:{signatures:[signature,sig(4)],message:{accountKeys:keys,instructions:[{programId:CB,accounts:[],data:'LBc2Nb',stackHeight:1},{programId:PUMP_PROGRAM,accounts:ixAccounts,data:encodeSolanaAddress(data),stackHeight:1}]}},
  meta:{err:null,status:{Ok:null},preBalances:pre,postBalances:post,innerInstructions:[{index:1,instructions:[
   {program:'system',programId:SYS,stackHeight:2,parsed:{type:'createAccount',info:{newAccount:mint,owner:TOKEN_2022_PROGRAM,source:wallet,lamports:1838960,space:234}}},
   {program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed:{type:'initializeMetadataPointer',info:{mint,metadataAddress:mint}}},
   {program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed:{type:'initializeMint2',info:{mint,decimals:6,mintAuthority}}},
   {program:'system',programId:SYS,stackHeight:2,parsed:{type:'createAccount',info:{newAccount:bondingCurve,owner:PUMP_PROGRAM,source:wallet,lamports:1285240,space:125}}},
   {programId:PUMP_PROGRAM,stackHeight:2,accounts:[eventAuthority],data:encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),event]))},
  ]}],
  logMessages:[`Program ${CB} invoke [1]`,`Program ${CB} success`,`Program ${PUMP_PROGRAM} invoke [1]`,'Program log: Instruction: CreateV2',`Program ${SYS} invoke [2]`,`Program ${SYS} success`,`Program ${TOKEN_2022_PROGRAM} invoke [2]`,`Program ${TOKEN_2022_PROGRAM} success`,`Program ${TOKEN_2022_PROGRAM} invoke [2]`,`Program ${TOKEN_2022_PROGRAM} success`,`Program ${SYS} invoke [2]`,`Program ${SYS} success`,`Program data: ${event.toString('base64')}`,`Program ${PUMP_PROGRAM} invoke [2]`,`Program ${PUMP_PROGRAM} success`,`Program ${PUMP_PROGRAM} success`]}};
 const page:any={results:[{url:coin,final_url:coin,title:'Parasite',text:`# PARASITE\n\n### Stats\n\nCreator\n\n${label(wallet)}\n\nMC`,links:['https://pump.fun/',`https://pump.fun/profile/${wallet}`,`https://pump.fun/profile/${wallet}`,'https://x.com/parasitedotfun','https://parasiteonsol.fun/'],published_date:'2026-09-29T00:57:47.000Z'}],errors:[]};
 const rows:any[]=[{signature:sig(5),slot:slot+50,blockTime:T+30,err:null,confirmationStatus:'finalized'},{signature,slot,blockTime:T,err:null,confirmationStatus:'finalized'}];
 return{tx,page,rows,event,profile:wallet,times:{page:'2026-10-12T04:19:43.230Z',index:'2026-10-12T03:52:05.074Z',tx:'2026-10-12T03:54:55.513Z'}};
}
type Fixture=ReturnType<typeof build>;
const receipts=(f:Fixture)=>({
 rawArtifacts:{[R.page]:JSON.stringify(f.page),[R.walletIndex]:JSON.stringify({jsonrpc:'2.0',result:f.rows,id:1}),[R.transaction]:JSON.stringify({jsonrpc:'2.0',result:f.tx,id:1})} as Record<string,string>,
 retrievedAt:{[R.page]:f.times.page,[R.walletIndex]:f.times.index,[R.transaction]:f.times.tx} as Record<string,string>,
 requests:{[R.page]:creatorRolePageRequest(mint),[R.walletIndex]:creatorRoleIndexRequest(f.profile),[R.transaction]:creatorRoleTransactionRequest(signature)} as Record<string,unknown>,
});
const verify=(f:Fixture,at=cutoff)=>verifyPublicCreatorRole(token,receipts(f),at);
const rejects=(f:Fixture,code:string,at=cutoff)=>assert.throws(()=>verify(f,at),{message:`CREATOR_ROLE_${code}`});
const setProfile=(f:Fixture,w:string,links=[`https://pump.fun/profile/${w}`])=>{f.profile=w;f.page.results[0].links=links;f.page.results[0].text=`Creator\n\n${label(w)}\n\nMC`;return f;};

test('signed create_v2 plus a unique public profile claim yields a narrow historical creator-role binding',()=>{
 const r=verify(build());
 assert.equal(r.wallet,wallet);assert.equal(r.actor.id,`PUBLIC_PUMP_PROFILE:${wallet}`);assert.equal(r.role,'TOKEN_CREATION_SIGNER_AND_DECLARED_CREATOR');
 assert.deepEqual(r.validity,{kind:'HISTORICAL_TRANSACTION',validAt:'2026-09-29T00:57:47.000Z',validUntil:null,ongoingControlAsserted:false});
 assert.equal(r.creation.signature,signature);assert.equal(r.creation.instructionIndex,1);assert.equal(r.creation.walletIsFeePayer,true);assert.equal(r.creation.bondingCurve,bondingCurve);
 assert.equal(r.abi.argumentTailBytes,11);assert.equal(r.abi.eventTailBytes,115);
 assert.equal(r.publicClaim.profileLinks,2);assert.equal(r.publicClaim.observedAt,'2026-10-12T04:19:43.230Z');
 assert.equal(r.walletIndex.returned,2);assert.equal(r.walletIndex.providerIndexExhausted,true);
 assert.equal(r.personIdentityAsserted,false);assert.equal(r.socialAccountBound,false);assert.equal(r.currentFeeBeneficiaryAsserted,false);
});

test('page published_date is retained but never becomes the creation clock',()=>{
 const f=build();f.page.results[0].published_date='2020-01-01T00:00:00.000Z';const r=verify(f);
 assert.equal(r.validity.validAt,'2026-09-29T00:57:47.000Z');assert.equal(r.publicClaim.pagePublishedDate,'2020-01-01T00:00:00.000Z');assert.equal(r.publicClaim.pagePublishedDateUsedAsBirthProof,false);
});

test('verification is pure and makes no network calls',()=>{
 const original=globalThis.fetch;globalThis.fetch=(()=>{throw new Error('NETWORK');}) as typeof fetch;
 try{verify(build());}finally{globalThis.fetch=original;}
});

test('profile claims must be unique, well formed, labelled and bound to the requested mint page',()=>{
 rejects(setProfile(build(),wallet,[`https://pump.fun/profile/${wallet}`,`https://pump.fun/profile/${stranger}`]),'PROFILE_AMBIGUOUS');
 rejects(setProfile(build(),wallet,['https://pump.fun/profile/not-an-address!']),'PROFILE_MALFORMED');
 rejects(setProfile(build(),wallet,['https://pump.fun/']),'PROFILE_MISSING');
 let f=build();f.page.results[0].text='Creator\n\nZZZZ\u2026ZZZZ\n';rejects(f,'PROFILE_LABEL_MISMATCH');
 f=build();f.page.results[0].text='no creator label';rejects(f,'PROFILE_LABEL_MISSING');
 f=build();f.page.results[0].final_url=creatorRoleCoinUrl(stranger);rejects(f,'PAGE_MINT_MISMATCH');
 f=build();f.page.errors=[{error:'timeout'}];rejects(f,'PAGE_ERRORS');
});

test('a public profile that differs from the signing creator is a contradiction, not a binding',()=>{
 rejects(setProfile(build(),stranger),'PROFILE_ROLE_CONTRADICTION');
});

test('creator argument and event roles must agree with the signing user',()=>{
 rejects(build({argCreator:stranger}),'SIGNED_ROLE_CONTRADICTION');
 rejects(build({eventCreator:stranger}),'SIGNED_ROLE_CONTRADICTION');
});

test('receipts bind exact requests, availability and clocks',()=>{
 let r=receipts(build());(r.requests[R.page] as any).body.ttl=3600;
 assert.throws(()=>verifyPublicCreatorRole(token,r,cutoff),{message:'CREATOR_ROLE_RECEIPT'});
 r=receipts(build());r.rawArtifacts[R.transaction]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32429}});
 assert.throws(()=>verifyPublicCreatorRole(token,r,cutoff),{message:'CREATOR_ROLE_UNAVAILABLE'});
 r=receipts(build());r.rawArtifacts[R.transaction]=JSON.stringify({jsonrpc:'2.0',id:1,result:null});
 assert.throws(()=>verifyPublicCreatorRole(token,r,cutoff),{message:'CREATOR_ROLE_TRANSACTION_UNAVAILABLE'});
 rejects(build(),'CLOCK','2026-10-12T04:00:00.000Z');
 let f=build();f.times.page='2026-09-28T00:00:00.000Z';rejects(f,'CLOCK');
 f=build();f.rows=[f.rows[0]];rejects(f,'INDEX_SIGNATURE');
 f=build();f.rows[1].slot=slot+1;rejects(f,'TRANSACTION_BINDING');
 f=build();f.tx.meta.err={InstructionError:[1,{Custom:1}]};rejects(f,'TRANSACTION_FAILED');
});

test('failed, truncated or incomplete frames and unbound events fail closed',()=>{
 let f=build();f.tx.meta.logMessages.push('Log truncated');rejects(f,'LOG_TRUNCATED');
 f=build();f.tx.meta.logMessages[14]=`Program ${PUMP_PROGRAM} failed: custom program error: 0x1`;rejects(f,'FRAME_FAILED');
 f=build();f.tx.meta.logMessages.pop();rejects(f,'LOG_INCOMPLETE');
 f=build();f.tx.meta.logMessages.splice(12,1);rejects(f,'EVENT_MISSING');
 f=build();const altered=Buffer.from(f.event);altered[altered.length-1]=1;f.tx.meta.innerInstructions[0].instructions[4].data=encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),altered]));rejects(f,'EVENT_BINDING');
});

test('only a well-formed, completely logged trace that cannot allocate or initialize the mint is a definite non-creation',()=>{
 const sell='5jRcjdixRUDEPkNcS2FRdRe5AdLBY2JGX',frame=(p:string)=>[`Program ${p} invoke [2]`,`Program ${p} success`];
 const pumpLogs=(inner:string[])=>[`Program ${PUMP_PROGRAM} invoke [1]`,'Program log: Instruction: Sell',...inner,`Program ${PUMP_PROGRAM} consumed 51634 of 999700 compute units`,`Program ${PUMP_PROGRAM} success`];
 const transferChecked={program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed:{type:'transferChecked',info:{mint,authority:wallet,source:key(30),destination:key(30),tokenAmount:{amount:'1',decimals:6}}}};
 const nonCreate=(o:{top?:any[];inner?:any[];logs?:string[]}={})=>{
  const f=build(),keys=[wallet,key(30),SYS,PUMP_PROGRAM,TOKEN_2022_PROGRAM,mint].map((pubkey,i)=>({pubkey,signer:i===0,writable:i<2,source:'transaction'}));
  f.tx={slot,blockTime:T,version:0,transaction:{signatures:[signature],message:{accountKeys:keys,instructions:o.top??[{programId:PUMP_PROGRAM,accounts:[wallet,mint,key(30),TOKEN_2022_PROGRAM],data:sell,stackHeight:1}]}},
   meta:{err:null,status:{Ok:null},preBalances:keys.map(()=>1),postBalances:keys.map(()=>1),innerInstructions:[{index:0,instructions:o.inner??[transferChecked]}],logMessages:o.logs??pumpLogs(frame(TOKEN_2022_PROGRAM))}};
  return f;
 };
 rejects(nonCreate(),'NON_CREATE');
 rejects(nonCreate({top:[{program:'system',programId:SYS,stackHeight:1,parsed:{type:'transfer',info:{source:wallet,destination:key(30),lamports:1}}}],inner:[],logs:[`Program ${SYS} invoke [1]`,`Program ${SYS} success`]}),'NON_CREATE');
 // First native review reproduction: an instruction with neither parsed nor raw content and a truncated trace.
 rejects(nonCreate({top:[{programId:PUMP_PROGRAM}],inner:[],logs:['Log truncated']}),'TRANSACTION_SHAPE');
 rejects(nonCreate({logs:[...pumpLogs(frame(TOKEN_2022_PROGRAM)),'Log truncated']}),'LOG_TRUNCATED');
 rejects(nonCreate({inner:[]}),'LOG_INCOMPLETE');
 rejects(nonCreate({logs:pumpLogs([])}),'LOG_INCOMPLETE');
 rejects(nonCreate({top:[{programId:PUMP_PROGRAM,accounts:[wallet],data:'0OIl',stackHeight:1}]}),'TRANSACTION_SHAPE');
 rejects(nonCreate({top:[{programId:PUMP_PROGRAM,accounts:[wallet,key(31)],data:sell,stackHeight:1}]}),'TRANSACTION_SHAPE');
 rejects(nonCreate({inner:[{programId:SYS,accounts:[wallet,mint],data:'3Bxs4h24hBtQy9rw',stackHeight:2}],logs:pumpLogs(frame(SYS))}),'CREATE_UNSUPPORTED');
 rejects(nonCreate({inner:[{program:'system',programId:SYS,stackHeight:2,parsed:{type:'createAccount',info:{newAccount:mint,owner:TOKEN_2022_PROGRAM,source:wallet,lamports:1,space:82}}}],logs:pumpLogs(frame(SYS))}),'CREATE_UNSUPPORTED');
 rejects(nonCreate({inner:[{program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed:{type:'initializeMint2',info:{mint,decimals:6,mintAuthority}}}]}),'CREATE_UNSUPPORTED');
 // Terminal review cases: a parsed critical body proves absence only in an explicitly supported, exact and fully resolved form.
 const t22=(parsed:any)=>nonCreate({inner:[{program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed}]});
 const sys=(info:any,type='transfer')=>nonCreate({inner:[{program:'system',programId:SYS,stackHeight:2,parsed:{type,info}}],logs:pumpLogs(frame(SYS))});
 const checked=transferChecked.parsed.info,withInfo=(change:Record<string,unknown>)=>t22({type:'transferChecked',info:{...checked,...change}});
 for(const parsed of [{type:'initializeMint2',info:{}},{type:'initializeMint2',info:{mint:'not-an-address'}},{type:'unsupported-critical-type',info:{}}])rejects(t22(parsed),'CREATE_UNSUPPORTED');
 rejects(t22({type:'transferChecked',info:{mint,source:key(30),destination:key(30),tokenAmount:checked.tokenAmount}}),'CREATE_UNSUPPORTED');
 for(const change of [{destination:'not-an-address'},{source:key(31)},{source:mint},{authority:mint},{mint:key(31)},{mint:'not-an-address'},{newAccount:mint},{tokenAmount:{amount:'-1',decimals:6}},{tokenAmount:{amount:'1'}}])rejects(withInfo(change),'CREATE_UNSUPPORTED');
 rejects(withInfo({tokenAmount:{amount:'1',decimals:6,uiAmount:0.000001,uiAmountString:'0.000001'}}),'NON_CREATE');
 rejects(sys({source:wallet,destination:key(30),lamports:1}),'NON_CREATE');
 for(const info of [{source:wallet,destination:key(30)},{source:wallet,destination:key(30),lamports:'1'},{source:wallet,destination:mint,lamports:1},{source:'not-an-address',destination:key(30),lamports:1},{source:wallet,destination:key(30),lamports:1,owner:TOKEN_2022_PROGRAM}])rejects(sys(info),'CREATE_UNSUPPORTED');
 rejects(sys({account:mint,owner:TOKEN_2022_PROGRAM},'assign'),'CREATE_UNSUPPORTED');
});

test('unknown creation ABI, unsupported quote path, oversized tails and non-unique mint creation are rejected',()=>{
 let f=build();f.tx.transaction.message.instructions[1].data=encodeSolanaAddress(Buffer.from([1,2,3,4,5,6,7,8,9]));rejects(f,'CREATE_UNSUPPORTED');
 rejects(build({extraAccount:true}),'QUOTE_PATH_UNSUPPORTED');
 rejects(build({argTail:12}),'ABI_UNSUPPORTED');
 rejects(build({eventTail:117}),'ABI_UNSUPPORTED');
 f=build();f.tx.meta.innerInstructions[0].instructions.splice(1,0,{program:'spl-token',programId:TOKEN_2022_PROGRAM,stackHeight:2,parsed:{type:'initializeMintCloseAuthority',info:{mint,newAuthority:wallet}}});f.tx.meta.logMessages.splice(6,0,`Program ${TOKEN_2022_PROGRAM} invoke [2]`,`Program ${TOKEN_2022_PROGRAM} success`);rejects(f,'MINT_INITIALIZATION');
 f=build();const i=f.tx.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===mint);f.tx.meta.preBalances[i]=1461600;rejects(f,'MINT_INITIALIZATION');
 f=build();f.tx.transaction.message.accountKeys.find((k:any)=>k.pubkey===mint).signer=false;f.tx.transaction.signatures=[signature];rejects(f,'CREATE_ACCOUNTS');
});
