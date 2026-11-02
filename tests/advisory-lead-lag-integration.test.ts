import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {validateA25LeadLagBundle} from '../src/app/a25-lead-lag.js';
import {A25_CAPTURE_ID} from '../src/providers/advisory-lead-lag-import.js';
import {Service} from '../src/app/service.js';
import {starterProfile,starterConfig} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {a29LiveFetcher} from './a29-fixtures.js';

const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
// The historical social/native identity/price evidence is genuine. This test's live HTTP transport
// and final analysis clock are constructed; genuine token acceptance is separate.
const cutoff='2026-11-03T00:00:00.000Z';
const capture=()=>gunzipSync(readFileSync('tests/fixtures/a25-historical-lead-lag.json.gz')).toString('utf8');

test('A25 lead-lag mode rejects incompatible boundaries before file or API reads',async()=>{
 let reads=0;
 const base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,a25LeadLagCapture:'/nonexistent-a25-test-file',fetcher:async()=>{reads++;throw Error('UNEXPECTED_READ');}};
 for(const change of [{advisoryEnabled:false},{semanticEnabled:true},{o28Expanded:true},{s15ReferenceCapture:'/another-file'},{a13ParticipationCapture:'/another-file'},{c12BridgeCapture:'/another-file'},{a12ZeroWitnessCapture:'/another-file'},{executableLiquidity:true},{nativeAttentionCapture:'/another-file'},{o25LifetimeCapture:'/another-file'}]){
  await assert.rejects(()=>collectLiveToken(token,{...base,...change}),/A25_LEAD_LAG_MODE_REQUIRED|C12_BRIDGE_MODE_REQUIRED/);
 }
 await assert.rejects(()=>collectLiveToken({chain:'base',address:'0x0000000000000000000000000000000000000001'},base),/A25_LEAD_LAG_MODE_REQUIRED/);
 assert.equal(reads,0);
});

test('proof67 confines a historical attention-price study to A25 and preserves ordinary40 entry evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a25-lead-lag-composition-'));
 try{
  const file=join(dir,'capture.json');writeFileSync(file,capture());
  const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:a29LiveFetcher(token.address,cutoff),now:()=>cutoff};
  const ordinary=await collectLiveToken(token,options);
  const next=await collectLiveToken(token,{...options,a25LeadLagCapture:file});
  const facts=next.details!.advisory!,proof=JSON.parse(next.rawArtifacts['advisory-derivation']!);
  assert.equal(proof.method,'advisory-provenance-v67');assert.equal(facts.method,'advisory-measurements-v66');
  assert.deepEqual(facts.metrics.filter(m=>m.id!=='A25'),ordinary.details!.advisory!.metrics.filter(m=>m.id!=='A25'));
  assert.deepEqual(next.features,ordinary.features);assert.deepEqual(next.details!.baseline,ordinary.details!.baseline);
  const metric=facts.metrics.find(m=>m.id==='A25')!,data=metric.data as Record<string,unknown>;
  assert.equal(metric.quality,'KNOWN',JSON.stringify(metric));assert.equal(metric.unit,'scoped-record');
  assert.equal(data.status,'COMPLETE');
  const study=data.study as {lags:Array<{lagMinutes:number;overlap:number;correlation:number}>;null:{pValue:number}};
  assert.deepEqual(study.lags.map(r=>r.lagMinutes),Array.from({length:13},(_,i)=>-30+i*5));assert.ok(study.lags.every(r=>r.overlap>=120&&Number.isFinite(r.correlation)&&Math.abs(r.correlation)<=1));assert.ok(study.null.pValue>0&&study.null.pValue<=1);
  assert.deepEqual(reconstructAdvisory(next.token,next.cutoff,next.details!.baseline,next.evidence,next.rawArtifacts,proof,next.thesis??null,next.features),facts);
  validateA25LeadLagBundle(next,true);
  assert.throws(()=>validateA25LeadLagBundle(next,false));
  const dbFile=join(dir,'a25.sqlite'),service=new Service(dbFile);
  try{
   const saved=service.analyzeLive(next),ordinaryService=new Service(join(dir,'ordinary.sqlite'));
   let baseSaved;try{baseSaved=ordinaryService.analyzeLive(ordinary);}finally{ordinaryService.close();}
   assert.deepEqual(saved.result.checks.filter(c=>c.required),baseSaved.result.checks.filter(c=>c.required));
   assert.equal(saved.result.classification,baseSaved.result.classification);
   assert.deepEqual(service.show(saved.id),saved);assert.deepEqual(service.replay(saved.id),saved);assert.deepEqual(service.analyzeLive(next),saved);
   const db=new DatabaseSync(dbFile);try{const row=db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!;assert.equal(JSON.parse(row.semantic as string).policyVersion,'research-screen-advisory-v64');}finally{db.close();}
   const reopened=new Service(dbFile);try{assert.deepEqual(reopened.show(saved.id),saved);assert.deepEqual(reopened.replay(saved.id),saved);}finally{reopened.close();}
   const changed=structuredClone(next);(changed.details!.advisory!.metrics.find(m=>m.id==='A25')!.data as Record<string,unknown>).status='fabricated';assert.throws(()=>service.analyzeLive(changed));
  }finally{service.close();}
  assert.ok(next.features.length>0);
  for(const edit of [
   (b:typeof next)=>{b.features[0]!.evidenceIds.push(A25_CAPTURE_ID);},
   (b:typeof next)=>{b.details!.advisory!.metrics.find(m=>m.id==='O25')!.evidenceIds.push(A25_CAPTURE_ID);},
   (b:typeof next)=>{b.evidence.find(e=>e.id===A25_CAPTURE_ID)!.accessMode='PUBLIC_API';},
   (b:typeof next)=>{const p=JSON.parse(b.rawArtifacts['advisory-derivation']!);p.method='advisory-provenance-v66';b.rawArtifacts['advisory-derivation']=JSON.stringify(p);},
  ]){const changed=structuredClone(next);edit(changed);assert.throws(()=>validateA25LeadLagBundle(changed,true));}
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('CLI requires A25 FILE before collection or persistence for missing and following-flag forms',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a25-lead-lag-required-file-'));
 try{
  const config=join(dir,'config.json'),configRaw=JSON.stringify(starterConfig());writeFileSync(config,configRaw);
  for(const [label,trailing] of [['missing',[]],['following-flag',['--json']]] as const){
   const db=join(dir,label+'.sqlite'),stdout:string[]=[],stderr:string[]=[];let reads=0;
   const code=await runCli(['analyze',token.address,'--partial','--advisory','--json','--config',config,'--db',db,'--a25-lead-lag-capture',...trailing],{env:{},isInteractive:false,now:()=>cutoff,stdout:s=>stdout.push(s),stderr:s=>stderr.push(s),fetcher:async()=>{reads++;throw Error('UNEXPECTED_COLLECTION');}});
   assert.equal(code,2,label);assert.match(stderr.join(''),/^FLAG_VALUE_REQUIRED:/,label);assert.equal(stdout.join(''),'',label);assert.equal(reads,0,label);assert.equal(existsSync(db),false,label);assert.equal(readFileSync(config,'utf8'),configRaw,label);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
