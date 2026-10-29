/** Constructed fee/price cases over actual public upstream simulation bytes; live acceptance is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {NATIVE_MINT} from '@solana/spl-token';
import {PUMP_AMM_PROGRAM_ID} from '@pump-fun/pump-swap-sdk';
import {buildRouteCostMessages,collectRouteCosts,finishRouteCosts,validateRouteCostBundle,ROUTE_COST_METHOD,type RouteCostCapture} from '../src/providers/route-cost.js';
import {finishEntryRoute} from '../src/providers/entry-route.js';
import {finishExitRoute} from '../src/providers/exit-route.js';
import {finishSimulationRoute} from '../src/providers/simulation-route.js';
import {expireVenueProvenanceAssessment} from '../src/providers/venue-provenance.js';
import type {LiveBundle} from '../src/domain/contracts.js';
const source=JSON.parse(readFileSync(new URL('../../tests/fixtures/simulation-route-live.json',import.meta.url),'utf8')).bundle as LiveBundle;
const copy=()=>structuredClone(source),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const COST_IDS=['cost-route-entry-fee','cost-route-exit-fee','cost-route-sol-usd'],DERIVED='cost-route-derivation';
const json=(b:LiveBundle,id:string)=>JSON.parse(b.rawArtifacts[id]!);
const request=(b:LiveBundle,id:string)=>b.evidence.find(e=>e.id===id)!.scope.request as {method:string;params:any[]};
function rewrite(b:LiveBundle,id:string,fn:(v:any)=>void){const v=json(b,id);fn(v);b.rawArtifacts[id]=JSON.stringify(v);b.evidence.find(e=>e.id===id)!.contentHash=sha(b.rawArtifacts[id]!);}
// All NEW cost receipts below are explicitly constructed:5000lamport fee quotes and100USD/SOL test reference.
// The upstream O12 fixture retains actual public raw bytes/clocks. These tests do not assert live cost acquisition.
function replies(b:LiveBundle){const slot=json(b,'simulation-route-result').result.context.slot;return [JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot},value:5000}}),JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot},value:5000}}),JSON.stringify([{chainId:'solana',baseToken:{address:NATIVE_MINT.toBase58()},quoteToken:{address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},pairAddress:'ConstructedDirectSOLUSDCReference',priceUsd:'100',liquidity:{usd:1000000}}])];}
async function capture(b:LiveBundle,alter?:(responses:string[])=>void){const responses=replies(b);alter?.(responses);let calls=0;const c=await collectRouteCosts(b.token,b.profile,b.rawArtifacts,b.evidence,'https://rpc.invalid',(async()=>new Response(responses[calls++]!)) as typeof fetch,()=>b.cutoff,AbortSignal.timeout(10000));return {c,calls};}
function apply(b:LiveBundle,c:RouteCostCapture){const r=finishRouteCosts(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,c);b.evidence=b.evidence.filter(e=>!e.id.startsWith('cost-route-')).concat(r.capture.records);for(const id of Object.keys(b.rawArtifacts))if(id.startsWith('cost-route-'))delete b.rawArtifacts[id];Object.assign(b.rawArtifacts,r.capture.rawArtifacts);for(const id of ['O15','O16']){const a=r.assessments.find(a=>a.id===id)??structuredClone(source.details!.baseline.find(a=>a.id===id)!);b.details!.baseline[b.details!.baseline.findIndex(a=>a.id===id)]=a;b.features=b.features.filter(f=>f.id!==id).concat(a.projection?[a.projection]:[]);}return r;}
async function positive(){const b=copy(),{c,calls}=await capture(b);assert.equal(calls,3);apply(b,c);return b;}
const ownCapture=(b:LiveBundle):RouteCostCapture=>({records:COST_IDS.map(id=>b.evidence.find(e=>e.id===id)!),rawArtifacts:Object.fromEntries(COST_IDS.map(id=>[id,b.rawArtifacts[id]!]))});
function refreshUpstreams(b:LiveBundle){const entry=finishEntryRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,{records:b.evidence.filter(e=>['entry-route-genesis','entry-route-bank','entry-route-usd'].includes(e.id)),rawArtifacts:Object.fromEntries(['entry-route-genesis','entry-route-bank','entry-route-usd'].map(id=>[id,b.rawArtifacts[id]!]))});b.evidence=b.evidence.filter(e=>!e.id.startsWith('entry-route-')).concat(entry.capture.records);Object.assign(b.rawArtifacts,entry.capture.rawArtifacts);const exit=finishExitRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence);b.evidence=b.evidence.filter(e=>e.id!=='exit-route-derivation').concat(exit.record);b.rawArtifacts[exit.record.id]=exit.raw;const simIds=['largest','token-accounts','payers','setup','blockhash','result'].map(x=>'simulation-route-'+x),simulation=finishSimulationRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,{records:simIds.map(id=>b.evidence.find(e=>e.id===id)!),rawArtifacts:Object.fromEntries(simIds.map(id=>[id,b.rawArtifacts[id]!]))});b.evidence=b.evidence.filter(e=>!e.id.startsWith('simulation-route-')).concat(simulation.capture.records);Object.assign(b.rawArtifacts,simulation.capture.rawArtifacts);for(const [id,a]of [['O10',entry.assessment],['O11',exit.assessment],['O12',simulation.assessment]] as const){b.features=b.features.filter(f=>f.id!==id);if(a){b.details!.baseline[b.details!.baseline.findIndex(x=>x.id===id)]=a;b.features.push(a.projection!);}}b.details!.baseline=b.details!.baseline.map(a=>expireVenueProvenanceAssessment(a,b.cutoff));}

test('cost messages are exact unsigned O12 entry prefix and ComputeBudget plus sell; source operations preserve currency separation',async()=>{
 const b=copy(),wire=request(b,'simulation-route-result').params[0],tx=VersionedTransaction.deserialize(Buffer.from(wire,'base64')),decoded=TransactionMessage.decompile(tx.message),trades=decoded.instructions.flatMap((ix,i)=>ix.programId.equals(PUMP_AMM_PROGRAM_ID)?[{i,name:ix.data.subarray(0,8).equals(createHash('sha256').update('global:buy').digest().subarray(0,8))?'buy':ix.data.subarray(0,8).equals(createHash('sha256').update('global:sell').digest().subarray(0,8))?'sell':null}]:[]),m=buildRouteCostMessages(wire);
 assert.deepEqual(trades.map(x=>x.name),['buy','sell']);const expected=(instructions:typeof decoded.instructions)=>Buffer.from(new TransactionMessage({payerKey:decoded.payerKey,recentBlockhash:decoded.recentBlockhash,instructions}).compileToV0Message().serialize()).toString('base64');
 assert.equal(m.entryMessage,expected(decoded.instructions.slice(0,trades[1]!.i)));assert.equal(m.exitMessage,expected([decoded.instructions[0]!,decoded.instructions[trades[1]!.i]!]));assert.deepEqual(decoded.instructions[0]!.data,ComputeBudgetProgram.setComputeUnitLimit({units:1400000}).data);
 const responses=replies(b),calls:any[]=[];const c=await collectRouteCosts(b.token,b.profile,b.rawArtifacts,b.evidence,'https://rpc.invalid',(async(url,init)=>{calls.push({url,init});return new Response(responses[calls.length-1]!);}) as typeof fetch,()=>b.cutoff,AbortSignal.timeout(10000));assert.equal(calls.length,3);assert.equal(JSON.parse(calls[0].init.body).params[0],m.entryMessage);assert.equal(JSON.parse(calls[1].init.body).params[0],m.exitMessage);assert.match(calls[2].url,/So11111111111111111111111111111111111111112$/);assert.equal(calls[2].init.credentials,'omit');assert.ok(calls.every(x=>x.init.redirect==='error'));
 const r=apply(b,c);assert.equal(r.assessments.length,2);assert.deepEqual(validateRouteCostBundle(b),r.assessments);for(const id of ['O10','O11','O12','O13','O14'])assert.deepEqual(b.details!.baseline.find(a=>a.id===id),source.details!.baseline.find(a=>a.id===id));
});

test('all native/token movements reconcile; requested USD and independent exit plus unspent drive O15, retained rent charged conservatively',async()=>{
 const b=await positive(),facts=b.details!.baseline.find(a=>a.id==='O15')!.data as any,entry=b.details!.baseline.find(a=>a.id==='O10')!.data as any,exit=b.details!.baseline.find(a=>a.id==='O11')!.data as any,sim=json(b,'simulation-route-result').result.value;
 assert.equal(facts.method,ROUTE_COST_METHOD);assert.equal(facts.benchmarkMethod,'INDEPENDENT_QUOTES');assert.equal(facts.feeProofLevel,'QUOTED');assert.equal(facts.setupProofLevel,'SIMULATED');assert.equal(facts.atomicSimulationFeeLamports,String(sim.fee));const setup=BigInt(sim.preBalances[0])-BigInt(sim.postBalances[0])-BigInt(sim.fee);assert.equal(facts.retainedNativeSetupDebitLamports,setup.toString());assert.equal(facts.retainedSetupDeposits.reduce((s:bigint,x:any)=>s+BigInt(x.lamports),0n),setup);assert.ok(facts.retainedSetupDeposits.every((x:any)=>['BASE_ATA','USER_VOLUME_ACCUMULATOR'].includes(x.kind)));
 const expectedEntry=Number(b.profile.sizeUsd)+(Number(setup)+5000)/1e9*100,expectedExit=(Number(exit.outputAtomic)+Number(entry.unspentAtomic))/1e8*Number(entry.quoteUsdReference)-5000/1e9*100,expectedLoss=Math.max(0,1-expectedExit/expectedEntry)*10000;assert.ok(Math.abs(Number(facts.totalEntryCostUsd)-expectedEntry)<1e-12);assert.ok(Math.abs(Number(facts.netExitUsd)-expectedExit)<1e-12);assert.ok(Math.abs(Number(facts.roundTripLossBps)-expectedLoss)<1e-9);assert.equal(b.features.find(f=>f.id==='O15')!.value,facts.roundTripLossBps);assert.equal(b.features.find(f=>f.id==='O16')!.value,true);
 const sequential=(Number((b.details!.baseline.find(a=>a.id==='O12')!.data as any).receivedQuoteAtomic)+Number(entry.unspentAtomic))/1e8*Number(entry.quoteUsdReference)-5000/1e9*100;assert.ok(Math.abs(sequential-Number(facts.netExitUsd))>1e-6,'sequential simulated proceeds must not silently replace independent exit benchmark');
});

test('null/error fees and absent/wrong-currency price stay missing without zeros',async()=>{
 for(const scenario of ['null','remote','wrongCurrency','absent']){const b=copy(),{c}=await capture(b,r=>{if(scenario==='null'){const p=JSON.parse(r[0]!);p.result.value=null;r[0]=JSON.stringify(p);}else if(scenario==='remote')r[1]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32016,message:'context unavailable'}});else if(scenario==='absent')r[2]='[]';else{const p=JSON.parse(r[2]!);p[0].baseToken.address=entryQuote(b);r[2]=JSON.stringify(p);}});const r=apply(b,c);assert.deepEqual(r.assessments,[],scenario);assert.equal(JSON.parse(r.capture.rawArtifacts[DERIVED]!).quality,'MISSING');assert.deepEqual(validateRouteCostBundle(b),[]);assert.equal(b.details!.baseline.find(a=>a.id==='O12')!.quality,'KNOWN');}
 function entryQuote(b:LiveBundle){return (b.details!.baseline.find(a=>a.id==='O10')!.data as any).quoteMint;}
});

test('native conservation, known setup destinations and complete token conservation block malformed economic authority',async()=>{
 const cases:Record<string,(v:any)=>void>={omittedPoolBase:v=>{v.preTokenBalances=v.preTokenBalances.filter((x:any)=>x.accountIndex!==4);v.postTokenBalances=v.postTokenBalances.filter((x:any)=>x.accountIndex!==4);},wrongPoolOwner:v=>{for(const list of [v.preTokenBalances,v.postTokenBalances])list.find((x:any)=>x.accountIndex===4).owner='11111111111111111111111111111111';},unsafe:v=>{v.preBalances[0]=Number.MAX_SAFE_INTEGER+1;},fee:v=>{v.fee++;},payer:v=>{v.postBalances[0]++;},negativeOther:v=>{v.postBalances[2]--;v.postBalances[0]++;},setupOwner:v=>{const ix=v.innerInstructions.flatMap((g:any)=>g.instructions).find((i:any)=>i.programId==='11111111111111111111111111111111');ix.parsed.info.owner='11111111111111111111111111111111';},setupMissing:v=>{v.innerInstructions=[];},tokenBalance:v=>{v.postTokenBalances[0].uiTokenAmount.amount=(BigInt(v.postTokenBalances[0].uiTokenAmount.amount)+1n).toString();},tokenMint:v=>{v.postTokenBalances[0].mint='So11111111111111111111111111111111111111112';}};
 for(const [name,change]of Object.entries(cases)){const b=copy();rewrite(b,'simulation-route-result',p=>change(p.result.value));const {c}=await capture(b),r=finishRouteCosts(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,c);assert.equal(r.assessments.length,0,name);assert.equal(JSON.parse(r.capture.rawArtifacts[DERIVED]!).quality,'MISSING',name);}
});

test('exact source namespace, fee-message bytes, dependencies, caches and exclusive O15/O16 promotion reject rehashed mutations',async()=>{
 const sourcePositive=await positive(),mutations:Record<string,(b:LiveBundle)=>void>={
  source:b=>{b.evidence.find(e=>e.id===COST_IDS[0])!.sourceId='pumpswap-direct';},
  adapter:b=>{b.evidence.find(e=>e.id===DERIVED)!.adapterVersion='live-v1';},
  scope:b=>{b.evidence.find(e=>e.id===COST_IDS[0])!.scope={method:ROUTE_COST_METHOD,dependencies:[],request:{method:'getFeeForMessage',params:['arbitrary']}};},
  raw:b=>{b.rawArtifacts[COST_IDS[0]!]+=' ';},
  cached:b=>{(b.details!.baseline.find(a=>a.id==='O15')!.data as any).roundTripLossBps='0';},
  cachedBool:b=>{b.features.find(f=>f.id==='O16')!.value=false;},
  price:b=>{rewrite(b,COST_IDS[2]!,p=>{p[0].priceUsd='1000';});},
  fee:b=>{rewrite(b,COST_IDS[0]!,p=>{p.result.value=1;});},
  profile:b=>{b.profile.sizeUsd='26';b.details!.profile.sizeUsd='26';},
  foreign:b=>{const a=structuredClone(b.details!.baseline.find(a=>a.id==='O16')!);a.id='O09';a.projection!.id='O09';b.details!.baseline[b.details!.baseline.findIndex(x=>x.id==='O09')]=a;b.features=b.features.filter(f=>f.id!=='O09').concat(a.projection!);},
  stripped:b=>{for(const id of Object.keys(b.rawArtifacts))if(id.startsWith('cost-route-'))delete b.rawArtifacts[id];b.evidence=b.evidence.filter(e=>!e.id.startsWith('cost-route-'));},
  orphan:b=>{b.rawArtifacts['cost-route-orphan']='{}';},
  exitWitnessStripped:b=>{delete b.rawArtifacts['exit-route-derivation'];b.evidence=b.evidence.filter(e=>e.id!=='exit-route-derivation');b.features=b.features.filter(f=>f.id!=='O11');b.details!.baseline[b.details!.baseline.findIndex(a=>a.id==='O11')]={id:'O11',version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:'MISSING',unit:'scoped-record',data:null,observationIds:[],evidenceIds:[],limitations:[],causes:[]};},
 };
 for(const [name,mutate]of Object.entries(mutations)){const b=structuredClone(sourcePositive);mutate(b);assert.throws(()=>validateRouteCostBundle(b),/ROUTE_COST|ENTRY_ROUTE|EXIT_ROUTE|SIMULATION_ROUTE/,name);}
});

test('later final cutoff produces stale costs with exact original clocks; provenance expiry yields unresolved and rejects cached positive',async()=>{
 const b=await positive(),c=ownCapture(b),originalTimes=c.records.map(e=>e.availableAt);b.cutoff=new Date(Date.parse(b.cutoff)+31000).toISOString();refreshUpstreams(b);const r=apply(b,c);assert.equal(r.assessments[0]!.quality,'STALE');assert.deepEqual(c.records.map(e=>e.availableAt),originalTimes);assert.equal(validateRouteCostBundle(b)[0]!.quality,'STALE');
 const expired=await positive(),old=ownCapture(expired),expires=Date.parse(json(expired,'venue-provenance-record').expiresAt);expired.cutoff=new Date(expires+1).toISOString();assert.equal(finishRouteCosts(expired.token,expired.profile,expired.cutoff,expired.rawArtifacts,expired.evidence,old).assessments.length,0);assert.throws(()=>validateRouteCostBundle(expired),/ROUTE_COST|ENTRY_ROUTE|EXIT_ROUTE|SIMULATION_ROUTE/);
});

test('source recovery consumes the shared three actual attempts and RPC redirects never reach a target',async()=>{
 const b=copy();let calls=0;const c=await collectRouteCosts(b.token,b.profile,b.rawArtifacts,b.evidence,'https://rpc.invalid',(async()=>{calls++;return new Response('{}',{status:503});}) as typeof fetch,()=>b.cutoff,AbortSignal.timeout(10000));assert.equal(calls,3);assert.equal(c.records.length,3);assert.deepEqual(finishRouteCosts(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,c).assessments,[]);
 for(const status of [307,308]){let target=0,requests=0;const server=createServer((req,res)=>{if(req.url==='/target'){target++;res.end('{}');}else{requests++;res.writeHead(status,{location:'/target'});res.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{const address=server.address() as {port:number},capture=await collectRouteCosts(b.token,b.profile,b.rawArtifacts,b.evidence,`http://127.0.0.1:${address.port}/rpc`,fetch,()=>b.cutoff,AbortSignal.timeout(10000));assert.equal(target,0);assert.ok(requests<=3);assert.deepEqual(finishRouteCosts(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,capture).assessments,[]);}finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}}
});


test('cost Service save/reopen and CLI offline replay retain exact selected-plan accounting; CLI rejects foreign and bundle modes before reads',async()=>{
 const b=await positive(),dir=mkdtempSync(join(tmpdir(),'route-cost-')),file=join(dir,'live.sqlite');try{let service=new Service(file),saved;try{saved=service.analyzeLive(b);assert.equal(service.analyzeLive(b).id,saved.id);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}service=new Service(file);try{assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}let output='',error='',reads=0;const runtime={env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:(x:string)=>output+=x,stderr:(x:string)=>error+=x};assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],runtime),0,error);assert.deepEqual(JSON.parse(output),saved);assert.equal(reads,0);error='';assert.equal(await runCli(['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--wbtc-costs','--json'],runtime),2);assert.match(error,/ENTRY_ROUTE_SOLANA_REQUIRED/);error='';assert.equal(await runCli(['analyze','--bundle','absent','--wbtc-costs'],runtime),2);assert.match(error,/ENTRY_ROUTE_MODE_REQUIRED/);assert.equal(reads,0);}finally{rmSync(dir,{recursive:true,force:true});}
});
