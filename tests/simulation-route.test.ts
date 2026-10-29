import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import BN from 'bn.js';
import {PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,type AccountInfo} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PUMP_AMM_SDK,OFFLINE_PUMP_AMM_PROGRAM,PUMP_AMM_PROGRAM_ID} from '@pump-fun/pump-swap-sdk';
import {collectSimulationRoute,finishSimulationRoute,validateSimulationRouteBundle,hasSimulationRoute,type SimulationRouteCapture} from '../src/providers/simulation-route.js';
import {finishEntryRoute,type EntryRouteCapture} from '../src/providers/entry-route.js';
import {finishExitRoute} from '../src/providers/exit-route.js';
import {deriveBaseline} from '../src/domain/baseline.js';
import {venueProvenanceInspection,expireVenueProvenanceAssessment,validateVenueProvenanceBundle} from '../src/providers/venue-provenance.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import type {LiveBundle} from '../src/domain/contracts.js';

// Root retains the original public-source capture and labels all mutations below as constructed negatives.
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/simulation-route-live.json',import.meta.url),'utf8'));
const source=fixture.bundle as LiveBundle;
const PREFIX='simulation-route-',DERIVED=PREFIX+'derivation';
const IDS=['largest','token-accounts','payers','setup','blockhash','result'].map(id=>PREFIX+id);
const ENTRY_IDS=['entry-route-genesis','entry-route-bank','entry-route-usd'];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const copy=()=>structuredClone(source);
const parse=(b:LiveBundle,id:string)=>JSON.parse(b.rawArtifacts[id]!);
const rehash=(b:LiveBundle,id:string)=>{b.evidence.find(e=>e.id===id)!.contentHash=sha(b.rawArtifacts[id]!);};
const mutateRaw=(b:LiveBundle,id:string,change:(body:any)=>void)=>{const body=parse(b,id);change(body);b.rawArtifacts[id]=JSON.stringify(body);rehash(b,id);};
const entryCapture=(b:LiveBundle):EntryRouteCapture=>({records:b.evidence.filter(e=>ENTRY_IDS.includes(e.id)),rawArtifacts:Object.fromEntries(ENTRY_IDS.map(id=>[id,b.rawArtifacts[id]!]))});
const simulationCapture=(b:LiveBundle):SimulationRouteCapture=>({records:b.evidence.filter(e=>e.id.startsWith(PREFIX)&&e.id!==DERIVED),rawArtifacts:Object.fromEntries(IDS.filter(id=>b.rawArtifacts[id]!==undefined).map(id=>[id,b.rawArtifacts[id]!]))});
const request=(b:LiveBundle,id:string)=>b.evidence.find(e=>e.id===id)!.scope.request as {method:string;params:any[]};
function apply(b:LiveBundle,capture:SimulationRouteCapture){
 const finished=finishSimulationRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,capture);
 b.evidence=b.evidence.filter(e=>!e.id.startsWith(PREFIX)).concat(finished.capture.records);
 for(const id of Object.keys(b.rawArtifacts))if(id.startsWith(PREFIX))delete b.rawArtifacts[id];
 Object.assign(b.rawArtifacts,finished.capture.rawArtifacts);
 const baseline=finished.assessment??deriveBaseline({...b,features:b.features.filter(f=>f.id!=='O12'),venueInspection:venueProvenanceInspection(parse(b,'venue-provenance-record'))}).find(a=>a.id==='O12')!;
 b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O12')]=baseline;
 b.features=b.features.filter(f=>f.id!=='O12').concat(baseline.projection?[baseline.projection]:[]);
 return finished;
}
function refreshEntryExit(b:LiveBundle){
 const entry=finishEntryRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,entryCapture(b));
 b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-')).concat(entry.capture.records);Object.assign(b.rawArtifacts,entry.capture.rawArtifacts);
 const defaultFor=(id:string)=>deriveBaseline({...b,features:b.features.filter(f=>f.id!==id),venueInspection:venueProvenanceInspection(parse(b,'venue-provenance-record'))}).find(a=>a.id===id)!;
 const entryAssessment=entry.assessment??defaultFor('O10');b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O10')]=entryAssessment;b.features=b.features.filter(f=>f.id!=='O10').concat(entryAssessment.projection?[entryAssessment.projection]:[]);
 const exit=finishExitRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence);
 b.evidence=b.evidence.filter(e=>e.id!==exit.record.id).concat(exit.record);b.rawArtifacts[exit.record.id]=exit.raw;
 const exitAssessment=exit.assessment??defaultFor('O11');b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O11')]=exitAssessment;b.features=b.features.filter(f=>f.id!=='O11').concat(exitAssessment.projection?[exitAssessment.projection]:[]);
 b.details!.baseline=b.details!.baseline.map(a=>expireVenueProvenanceAssessment(a,b.cutoff));
 b.features=b.features.filter(f=>f.id!=='O08').concat(b.details!.baseline.find(a=>a.id==='O08')!.projection!);
}
function account(v:any):AccountInfo<Buffer>|null{return v===null?null:{owner:new PublicKey(v.owner),data:Buffer.from(v.data[0],'base64'),executable:v.executable,lamports:v.lamports,rentEpoch:0};}

test('actual O12 wire matches official pinned SDK construction and runtime token conservation for exactly O10 acquired quantity',async()=>{
 const b=copy(),a=validateSimulationRouteBundle(b)!,facts=a.data as any,entry=b.details!.baseline.find(a=>a.id==='O10')!.data as any;
 assert.match(fixture.label,/public|capture|source/i);validateVenueProvenanceBundle(b);assert.equal(facts.level,'SIMULATED');assert.equal(facts.setupVerified,true);assert.equal(facts.buySucceeded,true);assert.equal(facts.sellSucceeded,true);assert.equal(facts.quantityAtomic,entry.acquiredAtomic);
 const req=request(b,IDS[5]!),wire=Buffer.from(req.params[0],'base64'),tx=VersionedTransaction.deserialize(wire);
 assert.equal(tx.message.addressTableLookups.length,0);assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.signatures.length,1);assert.ok(tx.signatures[0]!.every(x=>x===0));assert.equal(wire.length,facts.wireBytes);
 const bank=parse(b,'entry-route-bank').result.value.map(account),setup=parse(b,IDS[3]!).result.value.map(account),pool=PUMP_AMM_SDK.decodePool(bank[0]),global=PUMP_AMM_SDK.decodeGlobalConfig(bank[5]),user=new PublicKey(facts.subject),baseProgram=bank[1].owner;
 const protocol=global.protocolFeeRecipients.find(k=>!k.equals(PublicKey.default)&&!k.equals(user))!,buyback=global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default)&&!k.equals(user))!,mint=new PublicKey(b.token.address),quote=new PublicKey(entry.quoteMint),userBase=getAssociatedTokenAddressSync(mint,user,false,baseProgram),userQuote=getAssociatedTokenAddressSync(quote,user,false,TOKEN_PROGRAM_ID);
 const state={globalConfig:{...global,protocolFeeRecipients:global.protocolFeeRecipients.map(()=>protocol),buybackFeeRecipients:global.buybackFeeRecipients.map(()=>buyback)},feeConfig:PUMP_AMM_SDK.decodeFeeConfig(bank[6]),poolKey:new PublicKey(entry.pool),poolAccountInfo:bank[0],pool,poolBaseAmount:new BN(AccountLayout.decode(bank[3].data).amount.toString()),poolQuoteAmount:new BN(AccountLayout.decode(bank[4].data).amount.toString()),baseTokenProgram:baseProgram,quoteTokenProgram:TOKEN_PROGRAM_ID,baseMint:mint,baseMintAccount:(await import('@solana/spl-token')).MintLayout.decode(bank[1].data),user,userBaseTokenAccount:userBase,userQuoteTokenAccount:userQuote,userBaseAccountInfo:setup[1],userQuoteAccountInfo:setup[2]};
 const buys=await PUMP_AMM_SDK.buyInstructions(state,new BN(entry.acquiredAtomic),new BN(entry.actualDebitAtomic));
 // The first leg has created a previously absent base ATA before the second leg runs.
 const sells=await PUMP_AMM_SDK.sellInstructions({...state,userBaseAccountInfo:setup[1]??{owner:baseProgram,data:Buffer.alloc(165),executable:false,lamports:1,rentEpoch:0}},new BN(entry.acquiredAtomic),new BN(0));
 const sdk=new VersionedTransaction(new TransactionMessage({payerKey:user,recentBlockhash:tx.message.recentBlockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...buys,...sells]}).compileToV0Message());assert.deepEqual(Buffer.from(sdk.serialize()),wire);
 const runtime=parse(b,IDS[5]!).result.value,keys=tx.message.staticAccountKeys,baseIndex=keys.findIndex(k=>k.equals(userBase)),quoteIndex=keys.findIndex(k=>k.equals(userQuote)),amount=(rows:any[],index:number)=>BigInt(rows.find(row=>row.accountIndex===index)?.uiTokenAmount.amount??'0');
 assert.equal(runtime.err,null);assert.equal(amount(runtime.postTokenBalances,baseIndex),amount(runtime.preTokenBalances,baseIndex));assert.equal(amount(runtime.postTokenBalances,quoteIndex),amount(runtime.preTokenBalances,quoteIndex)-BigInt(facts.spentQuoteAtomic)+BigInt(facts.receivedQuoteAtomic));
 const events=(runtime.logs as string[]).filter(line=>line.startsWith('Program data: ')).flatMap(line=>{try{const e=OFFLINE_PUMP_AMM_PROGRAM.coder.events.decode(line.slice(14));return e&&['buyEvent','sellEvent'].includes(e.name)?[e]:[];}catch{return[];}});assert.deepEqual(events.map(e=>e.name),['buyEvent','sellEvent']);assert.equal(String((events[0]!.data as any).baseAmountOut),entry.acquiredAtomic);assert.equal(String((events[1]!.data as any).baseAmountIn),entry.acquiredAtomic);
 for(const id of ['O13','O14','O15','O16'])assert.equal(b.details!.baseline.find(a=>a.id===id)!.quality,'MISSING');
});

test('O12 actual Service save/idempotence/reopen and CLI replay retain the same result with zero network',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'simulation-route-')),file=join(dir,'live.sqlite');try{let service=new Service(file),saved;try{saved=service.analyzeLive(copy());assert.equal(service.analyzeLive(copy()).id,saved.id);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}service=new Service(file);try{assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
 let out='',errors='',calls=0;const code=await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>errors+=x});assert.equal(code,0,errors);assert.deepEqual(JSON.parse(out),saved);assert.equal(calls,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('O12 collector sends only bounded typed read-only methods, disables redirects, and reconstructs retained actual source responses',async()=>{
 const b=copy(),seen:Array<{method:string;params:any[];redirect:RequestRedirect|undefined}>=[];
 const fetcher=(async(_url:any,init:any)=>{const req=JSON.parse(init.body);seen.push({...req,redirect:init.redirect});const original=IDS.find(id=>JSON.stringify(request(b,id))===JSON.stringify({method:req.method,params:req.params}));assert.ok(original,'every typed request must match retained source geometry');return new Response(b.rawArtifacts[original!]);}) as typeof fetch;
 const c=await collectSimulationRoute(b.token,b.profile,b.rawArtifacts,entryCapture(b),'https://rpc.invalid',fetcher,()=>b.cutoff,AbortSignal.timeout(5000));assert.equal(seen.length,6);assert.deepEqual(seen.map(r=>r.method),['getTokenLargestAccounts','getMultipleAccounts','getMultipleAccounts','getMultipleAccounts','getLatestBlockhash','simulateTransaction']);assert.ok(seen.every(r=>r.redirect==='error'));assert.ok(!seen.some(r=>/send|sign|airdrop/i.test(r.method)));
 const sim=seen.at(-1)!.params[1];assert.equal(sim.sigVerify,false);assert.equal(sim.replaceRecentBlockhash,true);assert.equal(apply(b,c).assessment!.quality,'KNOWN');validateSimulationRouteBundle(b);
});

test('constructed rehashed wire, request, event, token-account, source, namespace and cross-feature corruptions cannot preserve O12',()=>{
 const mutations:Record<string,(b:LiveBundle)=>void>={
  cached:b=>{(b.details!.baseline.find(a=>a.id==='O12')!.data as any).setupVerified=false;},
  wire:b=>{const req=request(b,IDS[5]!);const bytes=Buffer.from(req.params[0],'base64');bytes[1]=1;req.params[0]=bytes.toString('base64');},
  request:b=>{request(b,IDS[5]!).params[1].sigVerify=true;},
  rejected:b=>mutateRaw(b,IDS[5]!,r=>{r.result.value.err={InstructionError:[1,{Custom:6004}]};}),
  quantity:b=>mutateRaw(b,IDS[5]!,r=>{const logs=r.result.value.logs as string[],index=logs.findIndex(line=>line.startsWith('Program data: ')&&OFFLINE_PUMP_AMM_PROGRAM.coder.events.decode(line.slice(14))?.name==='buyEvent'),data=Buffer.from(logs[index]!.slice(14),'base64');data.writeBigUInt64LE(1n,16);logs[index]='Program data: '+data.toString('base64');}),
  programScope:b=>mutateRaw(b,IDS[5]!,r=>{const logs=r.result.value.logs as string[],index=logs.findIndex(line=>line.startsWith('Program data: '));logs.splice(index,0,`Program ${PUMP_AMM_PROGRAM_ID.toBase58()} success`);}),
  postAccount:b=>mutateRaw(b,IDS[5]!,r=>{const a=r.result.value.accounts[2],d=Buffer.from(a.data[0],'base64');d.writeBigUInt64LE(1n,64);a.data[0]=d.toString('base64');}),
  preTokenOwner:b=>mutateRaw(b,IDS[5]!,r=>{const facts=b.details!.baseline.find(a=>a.id==='O12')!.data as any,quote=(b.details!.baseline.find(a=>a.id==='O10')!.data as any).quoteMint;r.result.value.preTokenBalances.find((row:any)=>row.owner===facts.subject&&row.mint===quote).owner=PublicKey.default.toBase58();}),
  slot:b=>mutateRaw(b,IDS[5]!,r=>{r.result.context.slot=parse(b,'entry-route-bank').result.context.slot-1;}),
  future:b=>{const e=b.evidence.find(e=>e.id===IDS[5])!;e.availableAt=e.retrievedAt=new Date(Date.parse(b.cutoff)+1).toISOString();},
  source:b=>{b.evidence.find(e=>e.id===IDS[5])!.sourceId='solana-rpc';},
  adapter:b=>{b.evidence.find(e=>e.id===IDS[5])!.adapterVersion='live-v1';},
  omitted:b=>{delete b.rawArtifacts[IDS[3]!];b.evidence=b.evidence.filter(e=>e.id!==IDS[3]);},
  orphan:b=>{b.rawArtifacts[PREFIX+'orphan']='{}';},
  stripped:b=>{for(const id of Object.keys(b.rawArtifacts))if(id.startsWith(PREFIX))delete b.rawArtifacts[id];b.evidence=b.evidence.filter(e=>!e.id.startsWith(PREFIX));},
  promotion:b=>{const a=structuredClone(b.details!.baseline.find(a=>a.id==='O12')!);a.id='O16';a.projection!.id='O16';b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O16')]=a;b.features=b.features.filter(f=>f.id!=='O16').concat(a.projection!);},
 };
 const dir=mkdtempSync(join(tmpdir(),'simulation-negative-')),service=new Service(join(dir,'live.sqlite'));try{for(const [name,mutate]of Object.entries(mutations)){const b=copy();mutate(b);assert.throws(()=>service.analyzeLive(b),/SIMULATION_ROUTE|ENTRY_ROUTE|EXIT_ROUTE|VENUE_PROVENANCE|ARTIFACT|UNKNOWN_EVIDENCE_REF|FUTURE_EVIDENCE|Invalid input/,name);}}finally{service.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed source prefixes and disabled mode persist MISSING; original expiry cannot keep a cached positive simulation',()=>{
 const b=copy(),original=simulationCapture(b),first=structuredClone(original.records[0]!);const failure=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32000,message:'constructed unavailable source'}});first.contentHash=sha(failure);
 assert.equal(apply(b,{records:[first],rawArtifacts:{[first.id]:failure}}).assessment,null);assert.equal(validateSimulationRouteBundle(b),null);assert.equal(b.details!.baseline.find(a=>a.id==='O10')!.quality,'KNOWN');assert.equal(b.details!.baseline.find(a=>a.id==='O11')!.quality,'KNOWN');
 const dir=mkdtempSync(join(tmpdir(),'simulation-missing-')),service=new Service(join(dir,'live.sqlite'));try{const saved=service.analyzeLive(b);assert.equal(saved.details!.baseline.find(a=>a.id==='O12')!.quality,'MISSING');assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();rmSync(dir,{recursive:true,force:true});}
 const disabled=copy();mutateRaw(disabled,'entry-route-bank',r=>{const a=r.result.value[5],d=Buffer.from(a.data[0],'base64');d[56]=d[56]!|16;a.data[0]=d.toString('base64');});refreshEntryExit(disabled);assert.equal(apply(disabled,{records:[],rawArtifacts:{}}).assessment,null);assert.equal(validateSimulationRouteBundle(disabled),null);
 const stale=copy();stale.cutoff=new Date(Date.parse((stale.details!.baseline.find(a=>a.id==='O12')!.data as any).expiresAt)+1).toISOString();assert.throws(()=>validateSimulationRouteBundle(stale),/SIMULATION_ROUTE|ENTRY_ROUTE/,'unchanged cached positive cannot survive quote expiry');refreshEntryExit(stale);const finished=apply(stale,simulationCapture(stale));assert.notEqual(finished.assessment?.quality,'KNOWN');validateSimulationRouteBundle(stale);validateVenueProvenanceBundle(stale);
});

test('simulation HTTP retry attempts share the eight-request cap and actual redirects cannot produce hidden requests',async()=>{
 const b=copy();let calls=0;const fetcher=(async(_url:any,init:any)=>{calls++;const req=JSON.parse(init.body),id=IDS.find(id=>JSON.stringify(request(b,id))===JSON.stringify({method:req.method,params:req.params}));assert.ok(id);return calls%3===0?new Response(b.rawArtifacts[id!]):new Response('{}',{status:503});}) as typeof fetch;
 const c=await collectSimulationRoute(b.token,b.profile,b.rawArtifacts,entryCapture(b),'https://rpc.invalid',fetcher,()=>b.cutoff,AbortSignal.timeout(15000));assert.equal(calls,8);assert.equal(apply(b,c).assessment,null);validateSimulationRouteBundle(b);
 let hits=0,redirects=0;const server=createServer((req,res)=>{if(req.url==='/target'){redirects++;res.end('{}');}else{hits++;res.writeHead(307,{location:'/target'});res.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{const address=server.address() as {port:number},x=copy(),captured=await collectSimulationRoute(x.token,x.profile,x.rawArtifacts,entryCapture(x),`http://127.0.0.1:${address.port}/rpc`,fetch,()=>x.cutoff,AbortSignal.timeout(10000));assert.ok(hits>0&&hits<=8);assert.equal(redirects,0);assert.equal(apply(x,captured).assessment,null);validateSimulationRouteBundle(x);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('explicit simulation mode rejects bundle and foreign-chain inputs before reads; old entry-only bundles keep no simulation authority',async()=>{
 let reads=0,error='';const runtime={env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:()=>{},stderr:(x:string)=>error+=x};assert.equal(await runCli(['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--wbtc-simulate','--json'],runtime),2);assert.match(error,/ENTRY_ROUTE_SOLANA_REQUIRED/);error='';assert.equal(await runCli(['analyze','--bundle','absent','--wbtc-simulate'],runtime),2);assert.match(error,/ENTRY_ROUTE_MODE_REQUIRED/);assert.equal(reads,0);
 const old=JSON.parse(readFileSync(new URL('../../tests/fixtures/entry-route-live.json',import.meta.url),'utf8')).bundle as LiveBundle;assert.equal(hasSimulationRoute(old),false);assert.equal(validateSimulationRouteBundle(old),null);validateVenueProvenanceBundle(old);
});
