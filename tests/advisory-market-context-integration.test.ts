import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {validateC12BridgeBundle} from '../src/app/c12-bridge.js';
import {Service} from '../src/app/service.js';
import {starterProfile} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {deriveC09MarketContext} from '../src/domain/advisory-market-context.js';
import {C12_CAPTURE_ID} from '../src/providers/advisory-bridge-import.js';
import type {LaunchpadReceipts} from '../src/providers/advisory-launchpad.js';
import {a29LiveFetcher} from './a29-fixtures.js';
const RAW=readFileSync('tests/fixtures/c12-all-assets-native-capture.json','utf8'),cutoff='2026-11-02T00:00:42.000Z',token={chain:'solana' as const,address:'So11111111111111111111111111111111111111112'};
const launchRaw=gunzipSync(readFileSync('tests/fixtures/c09-launchpad-source-fit.json.gz')).toString('utf8');
const launch=JSON.parse(launchRaw) as LaunchpadReceipts;
function fetcher():typeof fetch{
 const base=a29LiveFetcher(token.address,cutoff);
 return async(input,init)=>{
  const source=Object.entries(launch.requests).find(([,r])=>r.url===String(input));
  if(!source)return base(input,init);
  // Historical provider bodies are actual retained bytes; this live read/HTTP Date bracket is a constructed fixture.
  const envelope=JSON.parse(launch.rawArtifacts[source[0]]!);
  return new Response(envelope.body,{status:envelope.httpStatus,headers:{date:new Date(cutoff).toUTCString()}});
 };
}
function collect(file:string,mode=true,withKey=true){return collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:fetcher(),now:()=>cutoff,c12BridgeCapture:file,...(mode?{c09MarketContext:true}:{}),...(withKey?{solanaTrackerKey:'constructed-fixture-key'}:{})});}
type Run=Awaited<ReturnType<typeof collect>>;
const proof=(b:Run)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Run,id:string)=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const reconstruct=(b:Run)=>reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,proof(b),b.thesis??null,b.features);
const local=()=>{const dir=mkdtempSync(join(tmpdir(),'c09-composition-')),file=join(dir,'capture.json');writeFileSync(file,RAW);return{dir,file};};
test('64 joins finalized full-four source rows once, preserves63/C12/other48, and persists policy61 through reopen',async()=>{
 assert.equal(createHash('sha256').update(launchRaw).digest('hex'),'bfcce7c3d869f853bf3e59b41681dba01a17662bce9911820d1d8effd0df9129');
 const{dir,file}=local();try{
  const previous=await collect(file,false),b=await collect(file),facts=b.details!.advisory!,m=metric(b,'C09'),d=m.data as any;
  assert.equal(proof(b).method,'advisory-provenance-v64');assert.equal(facts.method,'advisory-measurements-v63');
  assert.equal(m.quality,'KNOWN');assert.equal(d.coverageComplete,true);assert.equal(d.classification,null);assert.equal(d.classificationStatus,'NOT_ACTIVATED');
  for(const id of ['C11','C12','C15','C16'])assert.equal(metric(b,id).quality,'KNOWN',id);
  assert.deepEqual(facts.metrics.filter(m=>m.id!=='C09'),previous.details!.advisory!.metrics.filter(m=>m.id!=='C09'));
  assert.deepEqual(b.features,previous.features);assert.deepEqual(b.details!.baseline,previous.details!.baseline);assert.equal(b.rawArtifacts[C12_CAPTURE_ID],RAW);
  assert.deepEqual(reconstruct(b),facts);validateC12BridgeBundle(b,true);
  assert.ok(m.evidenceIds.includes(C12_CAPTURE_ID));assert.deepEqual((metric(b,'C16').data as any).survival,{fraction:null,reasonCode:'MATURED_COHORT_FOLLOWUP_UNAVAILABLE'});
  const dbFile=join(dir,'c09.sqlite'),service=new Service(dbFile);try{
   const saved=service.analyzeLive(b);assert.deepEqual(service.show(saved.id),saved);assert.deepEqual(service.replay(saved.id),saved);assert.deepEqual(service.analyzeLive(b),saved);
   const db=new DatabaseSync(dbFile);try{const row=db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!;assert.equal(JSON.parse(row.semantic as string).policyVersion,'research-screen-advisory-v61');}finally{db.close();}
   const reopened=new Service(dbFile);try{assert.deepEqual(reopened.show(saved.id),saved);assert.deepEqual(reopened.replay(saved.id),saved);}finally{reopened.close();}
  }finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('missing nonbridge component remains explicit descriptive partial coverage without an all-four gate',async()=>{
 const{dir,file}=local();try{const b=await collect(file,true,false),m=metric(b,'C09'),d=m.data as any;
  assert.equal(metric(b,'C16').quality,'MISSING');assert.equal(m.quality,'KNOWN');assert.equal(d.coverageComplete,false);assert.equal(d.components.C16.quality,'MISSING');assert.equal(d.classification,null);assert.deepEqual(reconstruct(b),b.details!.advisory);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('unpriced or incomplete native C12 prevents authoritative bridge context rather than a successful subset',async()=>{
 const{dir,file}=local();try{
  for(const mutate of [(c:any)=>{c.records=c.records.filter((r:any)=>!r.id.startsWith('eth-redemptions-26313030'));},(c:any)=>{const r=c.records.find((r:any)=>r.receipt.chain==='market');r.raw='{"coins":{}}';r.receipt.response.bytes=Buffer.byteLength(r.raw);r.receipt.response.sha256=createHash('sha256').update(r.raw).digest('hex');}]){
   const c=JSON.parse(RAW);mutate(c);writeFileSync(file,JSON.stringify(c));const b=await collect(file),m=metric(b,'C09'),d=m.data as any;
   assert.equal(metric(b,'C12').quality,'MISSING');assert.equal(m.quality,'MISSING');assert.equal(d.coverageComplete,false);assert.equal(d.components.C12.values,null);assert.equal(d.classification,null);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('only strict64 may cite C12 in the exact composed C09, and Service rejects forged children plus recomposed caches',async()=>{
 const{dir,file}=local();try{
  const b=await collect(file),service=new Service(join(dir,'tamper.sqlite'));try{
   const forged=structuredClone(b);(metric(forged,'C09').data as any).classification='HOT';assert.throws(()=>service.analyzeLive(forged));
   const downgrade=structuredClone(b),p=proof(downgrade);p.method='advisory-provenance-v63';downgrade.rawArtifacts['advisory-derivation']=JSON.stringify(p);downgrade.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=createHash('sha256').update(downgrade.rawArtifacts['advisory-derivation']!).digest('hex');downgrade.details!.advisory!.method='advisory-measurements-v62';assert.throws(()=>service.analyzeLive(downgrade));
   const child=structuredClone(b);metric(child,'C11').data={forged:'client cache'};const rows=child.details!.advisory!.metrics,composed=deriveC09MarketContext(rows,cutoff);Object.assign(metric(child,'C09'),composed);assert.throws(()=>service.analyzeLive(child),/ADVISORY_PROOF_INVALID/);
   for(const id of ['A22','C15']){const x=structuredClone(b);metric(x,id).evidenceIds.push(C12_CAPTURE_ID);assert.throws(()=>service.analyzeLive(x),/C12_BRIDGE_PROOF_INVALID/);}
   const features=structuredClone(b);features.features[0]!.evidenceIds.push(C12_CAPTURE_ID);assert.throws(()=>service.analyzeLive(features));
   const foreign=structuredClone(b);foreign.evidence.find(e=>e.id===C12_CAPTURE_ID)!.scope={method:'foreign',purpose:'foreign'};assert.throws(()=>service.analyzeLive(foreign));
   assert.throws(()=>validateC12BridgeBundle(b,false));
  }finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('mode gates reject missing capture and incompatible semantic mode before reads; CLI requires explicit C12 source',async()=>{
 let reads=0;const denied=(async()=>{reads++;throw Error('Unexpected read');}) as typeof fetch;
 const opts={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,c09MarketContext:true,fetcher:denied,now:()=>cutoff};
 await assert.rejects(collectLiveToken(token,opts),/C09_MARKET_CONTEXT_MODE_REQUIRED/);
 await assert.rejects(collectLiveToken(token,{...opts,c12BridgeCapture:'unused',semanticEnabled:true}),/C09_MARKET_CONTEXT_MODE_REQUIRED/);
 let out='',err='';const code=await runCli(['analyze',token.address,'--partial','--advisory','--c09-market-context'],{env:{},fetcher:denied,isInteractive:false,stdout:s=>{out+=s;},stderr:s=>{err+=s;},now:()=>cutoff});
 assert.notEqual(code,0);assert.match(out+err,/C09_MARKET_CONTEXT_MODE_REQUIRED/);assert.equal(reads,0);
});
