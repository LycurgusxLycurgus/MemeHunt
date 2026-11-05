import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadC12BridgeCapture,decodeC12BridgeCapture,C12_SOURCE_ID,C12_CAPTURE_ID,C12_SOURCE_ADAPTER,c12BridgeScope} from '../src/providers/advisory-bridge-import.js';
import {c12BridgeDescriptor,validateC12BridgeCore} from '../src/app/c12-bridge.js';
const raw=readFileSync('tests/fixtures/c12-all-assets-native-capture.json','utf8'),cutoff='2026-11-01T13:00:00.000Z',token={chain:'solana' as const,address:'So11111111111111111111111111111111111111112'};
const capture=decodeC12BridgeCapture(raw,cutoff);
function core(){return{token,cutoff,evidence:[{id:C12_CAPTURE_ID,sourceId:C12_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT' as const,accessMode:'USER_IMPORT' as const,scope:c12BridgeScope(),retrievedAt:capture.captureCreatedAt,availableAt:capture.captureCreatedAt,adapterVersion:C12_SOURCE_ADAPTER,contentHash:createHash('sha256').update(raw).digest('hex')}],rawArtifacts:{[C12_CAPTURE_ID]:raw}};}
const proof=()=>({method:'advisory-provenance-v63',token,cutoff,c12Bridge:c12BridgeDescriptor()});
test('strict capture import preserves original bytes and rejects symlink/directory/invalid UTF8',()=>{
 const dir=mkdtempSync(join(tmpdir(),'c12-import-'));try{const path=join(dir,'capture.json');writeFileSync(path,raw);assert.equal(loadC12BridgeCapture(path,cutoff).raw,raw);symlinkSync(path,join(dir,'alias'));assert.throws(()=>loadC12BridgeCapture(join(dir,'alias'),cutoff),/C12_BRIDGE_SOURCE_FILE/);assert.throws(()=>loadC12BridgeCapture(dir,cutoff),/FILE_BOUND/);writeFileSync(path,Buffer.from([0xff]));assert.throws(()=>loadC12BridgeCapture(path,cutoff),/UTF8/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('source descriptor admits C12 only with exact proof63 ownership and actual source clock',()=>{
 const input=core();assert.equal(validateC12BridgeCore(input as any,proof())!.metric.quality,'KNOWN');
 for(const p of [{...proof(),method:'advisory-provenance-v62'},{...proof(),c12Bridge:undefined},{...proof(),cutoff:'2026-11-01T00:00:01.000Z'}])assert.throws(()=>validateC12BridgeCore(input as any,p));
 const graft=core();graft.evidence[0]!.availableAt=cutoff;assert.throws(()=>validateC12BridgeCore(graft as any,proof()),/C12_BRIDGE_PROOF_INVALID/);
 const foreign=core();Object.assign(foreign.evidence[0]!,{sourceId:'other'});assert.throws(()=>validateC12BridgeCore(foreign as any,proof()));
});
test('downgrade, extra owned source and entry citation cannot smuggle the new authority',()=>{
 const orphan=core();assert.throws(()=>validateC12BridgeCore(orphan as any,null));
 const duplicate=core();duplicate.evidence.push({...duplicate.evidence[0]!});assert.throws(()=>validateC12BridgeCore(duplicate as any,proof()));
 const entry={...core(),features:[{evidenceIds:[C12_CAPTURE_ID]}]};assert.throws(()=>validateC12BridgeCore(entry as any,proof()));
 assert.equal(validateC12BridgeCore({token,cutoff,evidence:[],rawArtifacts:{}}, {method:'advisory-provenance-v62'}),undefined);
});

import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {validateC12BridgeBundle} from '../src/app/c12-bridge.js';
import {Service} from '../src/app/service.js';
import {DatabaseSync} from 'node:sqlite';
import {starterProfile} from '../src/app/config.js';
import {a29LiveFetcher} from './a29-fixtures.js';
test('profile63 isolates only C12 from ordinary semantic-disabled base40 and rejects forged cached totals',async()=>{
 // Live RPC/DEX reads are constructed fixtures; the imported historical bridge raw bytes are actual retained source evidence.
 const dir=mkdtempSync(join(tmpdir(),'c12-composition-'));try{
  const file=join(dir,'capture.json');writeFileSync(file,raw);
  const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:a29LiveFetcher(token.address,cutoff),now:()=>cutoff};
  const ordinary=await collectLiveToken(token,options),bridge=await collectLiveToken(token,{...options,c12BridgeCapture:file});
  const base=ordinary.details!.advisory!,next=bridge.details!.advisory!,p=JSON.parse(bridge.rawArtifacts['advisory-derivation']!);
  assert.equal(p.method,'advisory-provenance-v63');assert.equal(next.method,'advisory-measurements-v62');
  assert.deepEqual(next.metrics.filter(m=>m.id!=='C12'),base.metrics.filter(m=>m.id!=='C12'));
  assert.deepEqual(bridge.features,ordinary.features);assert.deepEqual(bridge.details!.baseline,ordinary.details!.baseline);
  assert.equal(next.metrics.find(m=>m.id==='C12')!.quality,'KNOWN');
  assert.deepEqual(reconstructAdvisory(bridge.token,bridge.cutoff,bridge.details!.baseline,bridge.evidence,bridge.rawArtifacts,p,bridge.thesis??null,bridge.features),next);
  validateC12BridgeBundle(bridge,true);assert.throws(()=>validateC12BridgeBundle(bridge,false));
  const dbFile=join(dir,'c12.sqlite'),service=new Service(dbFile);
  try{
   const saved=service.analyzeLive(bridge);
   assert.deepEqual(service.show(saved.id),saved);assert.deepEqual(service.replay(saved.id),saved);assert.deepEqual(service.analyzeLive(bridge),saved);
   const db=new DatabaseSync(dbFile);try{const row=db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!;assert.equal(JSON.parse(row.semantic as string).policyVersion,'research-screen-advisory-v60');}finally{db.close();}
   const reopened=new Service(dbFile);try{assert.deepEqual(reopened.show(saved.id),saved);assert.deepEqual(reopened.replay(saved.id),saved);}finally{reopened.close();}
   const badSource=structuredClone(bridge);badSource.evidence.find(e=>e.id===C12_CAPTURE_ID)!.accessMode='PUBLIC_API';assert.throws(()=>service.analyzeLive(badSource),/C12_BRIDGE_PROOF_INVALID/);
  }finally{service.close();}
  const forged=structuredClone(bridge);(forged.details!.advisory!.metrics.find(m=>m.id==='C12')!.data as any).chains[0].netReferenceUsd='0';assert.throws(()=>validateC12BridgeBundle(forged,true));
  const shared=structuredClone(bridge);(shared.details as any).shared={};assert.throws(()=>validateC12BridgeBundle(shared,true));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
