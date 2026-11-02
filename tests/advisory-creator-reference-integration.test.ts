import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {validateS15ReferenceBundle} from '../src/app/s15-reference.js';
import {S15_REFERENCE_CAPTURE_ID} from '../src/providers/advisory-creator-reference-import.js';
import {Service} from '../src/app/service.js';
import {starterProfile,starterConfig} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {a29LiveFetcher} from './a29-fixtures.js';

const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
// Native evidence is an exact historical corpus. This test's live HTTP transport
// and final analysis clock are constructed; genuine token acceptance is separate.
const cutoff='2026-11-03T00:00:00.000Z';
const capture=()=>gunzipSync(readFileSync('tests/fixtures/s15-target-reference-book.json.gz')).toString('utf8');

test('S15 reference mode rejects incompatible boundaries before file or API reads',async()=>{
 let reads=0;
 const base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,s15ReferenceCapture:'/nonexistent-s15-test-file',fetcher:async()=>{reads++;throw Error('UNEXPECTED_READ');}};
 for(const change of [{advisoryEnabled:false},{semanticEnabled:true},{o28Expanded:true},{a13ParticipationCapture:'/another-file'},{c12BridgeCapture:'/another-file'},{a12ZeroWitnessCapture:'/another-file'},{executableLiquidity:true},{nativeAttentionCapture:'/another-file'},{o25LifetimeCapture:'/another-file'}]){
  await assert.rejects(()=>collectLiveToken(token,{...base,...change}),/S15_REFERENCE_MODE_REQUIRED|C12_BRIDGE_MODE_REQUIRED/);
 }
 await assert.rejects(()=>collectLiveToken({chain:'base',address:'0x0000000000000000000000000000000000000001'},base),/S15_REFERENCE_MODE_REQUIRED/);
 assert.equal(reads,0);
});

test('proof66 confines a raw historical reference book to S15 and preserves ordinary40 entry evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s15-reference-composition-'));
 try{
  const file=join(dir,'capture.json');writeFileSync(file,capture());
  const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:a29LiveFetcher(token.address,cutoff),now:()=>cutoff};
  const ordinary=await collectLiveToken(token,options);
  const next=await collectLiveToken(token,{...options,s15ReferenceCapture:file});
  const facts=next.details!.advisory!,proof=JSON.parse(next.rawArtifacts['advisory-derivation']!);
  assert.equal(proof.method,'advisory-provenance-v66');assert.equal(facts.method,'advisory-measurements-v65');
  assert.deepEqual(facts.metrics.filter(m=>m.id!=='S15'),ordinary.details!.advisory!.metrics.filter(m=>m.id!=='S15'));
  assert.deepEqual(next.features,ordinary.features);assert.deepEqual(next.details!.baseline,ordinary.details!.baseline);
  const metric=facts.metrics.find(m=>m.id==='S15')!,data=metric.data as Record<string,unknown>;
  assert.equal(metric.quality,'KNOWN',JSON.stringify(metric));assert.equal(metric.unit,'scoped-record');
  assert.equal(data.status,'COMPLETE');assert.equal(data.completeReferenceBook,true);assert.equal(data.aggregateNetProfit,null);
  assert.deepEqual(reconstructAdvisory(next.token,next.cutoff,next.details!.baseline,next.evidence,next.rawArtifacts,proof,next.thesis??null,next.features),facts);
  assert.deepEqual([...validateS15ReferenceBundle(next,true)],[S15_REFERENCE_CAPTURE_ID]);
  assert.throws(()=>validateS15ReferenceBundle(next,false));
  const dbFile=join(dir,'s15.sqlite'),service=new Service(dbFile);
  try{
   const saved=service.analyzeLive(next),ordinaryService=new Service(join(dir,'ordinary.sqlite'));
   let baseSaved;try{baseSaved=ordinaryService.analyzeLive(ordinary);}finally{ordinaryService.close();}
   assert.deepEqual(saved.result.checks.filter(c=>c.required),baseSaved.result.checks.filter(c=>c.required));
   assert.equal(saved.result.classification,baseSaved.result.classification);
   assert.deepEqual(service.show(saved.id),saved);assert.deepEqual(service.replay(saved.id),saved);assert.deepEqual(service.analyzeLive(next),saved);
   const db=new DatabaseSync(dbFile);try{const row=db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!;assert.equal(JSON.parse(row.semantic as string).policyVersion,'research-screen-advisory-v63');}finally{db.close();}
   const reopened=new Service(dbFile);try{assert.deepEqual(reopened.show(saved.id),saved);assert.deepEqual(reopened.replay(saved.id),saved);}finally{reopened.close();}
   const changed=structuredClone(next);(changed.details!.advisory!.metrics.find(m=>m.id==='S15')!.data as Record<string,unknown>).aggregateNetProfit='fabricated';assert.throws(()=>service.analyzeLive(changed));
  }finally{service.close();}
  assert.ok(next.features.length>0);
  for(const edit of [
   (b:typeof next)=>{b.features[0]!.evidenceIds.push(S15_REFERENCE_CAPTURE_ID);},
   (b:typeof next)=>{b.details!.advisory!.metrics.find(m=>m.id==='O25')!.evidenceIds.push(S15_REFERENCE_CAPTURE_ID);},
   (b:typeof next)=>{b.evidence.find(e=>e.id===S15_REFERENCE_CAPTURE_ID)!.accessMode='PUBLIC_API';},
   (b:typeof next)=>{const p=JSON.parse(b.rawArtifacts['advisory-derivation']!);p.method='advisory-provenance-v65';b.rawArtifacts['advisory-derivation']=JSON.stringify(p);},
  ]){const changed=structuredClone(next);edit(changed);assert.throws(()=>validateS15ReferenceBundle(changed,true));}
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('CLI requires S15 FILE before collection or persistence for missing and following-flag forms',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s15-reference-required-file-'));
 try{
  const config=join(dir,'config.json'),configRaw=JSON.stringify(starterConfig());writeFileSync(config,configRaw);
  for(const [label,trailing] of [['missing',[]],['following-flag',['--json']]] as const){
   const db=join(dir,label+'.sqlite'),stdout:string[]=[],stderr:string[]=[];let reads=0;
   const code=await runCli(['analyze',token.address,'--partial','--advisory','--json','--config',config,'--db',db,'--s15-reference-capture',...trailing],{env:{},isInteractive:false,now:()=>cutoff,stdout:s=>stdout.push(s),stderr:s=>stderr.push(s),fetcher:async()=>{reads++;throw Error('UNEXPECTED_COLLECTION');}});
   assert.equal(code,2,label);assert.match(stderr.join(''),/^FLAG_VALUE_REQUIRED:/,label);assert.equal(stdout.join(''),'',label);assert.equal(reads,0,label);assert.equal(existsSync(db),false,label);assert.equal(readFileSync(config,'utf8'),configRaw,label);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
