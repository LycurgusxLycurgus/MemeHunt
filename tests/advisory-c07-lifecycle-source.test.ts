import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync,inflateRawSync,deflateRawSync} from 'node:zlib';
import type {EvidenceRecord,TokenRef} from '../src/domain/contracts.js';
import {loadC07LifecycleCapture,validateC07LifecycleSource,C07_SOURCE_ID,C07_SOURCE_PREFIX,C07_CAPTURE_ID,C07_ADAPTER,C07_PURPOSE,C07_FILE_BYTES,C07_RECORDS,C07_RECORD_BYTES} from '../src/providers/advisory-c07-lifecycle-source.js';
import {C07_COHORT,C07_PROFILE_SHA256} from '../src/providers/advisory-c07-study.js';
import {reconstructC07Native} from '../src/providers/advisory-c07-native-source.js';

const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const original=gunzipSync(readFileSync('tests/fixtures/c07-fixed-cohort-lifecycle.json.gz'));
const fixture=JSON.parse(original.toString('utf8'));
const clawd:TokenRef={chain:'solana',address:C07_COHORT[1][0]};
const cutoff='2026-11-10T00:00:00.000Z';
const dir=mkdtempSync(join(tmpdir(),'c07-source-'));
process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
const genuineFile=join(dir,'genuine.json');writeFileSync(genuineFile,original);
function load(file=genuineFile,token=clawd,at=cutoff){return loadC07LifecycleCapture(file,token,at);}
function headers(loaded:ReturnType<typeof load>){
 const rawArtifacts:Record<string,string>={};
 const evidence:EvidenceRecord[]=loaded.records.map(r=>{
  assert.ok(!(r.id in rawArtifacts));rawArtifacts[r.id]=r.raw;
  return{id:r.id,sourceId:C07_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:C07_ADAPTER,scope:r.scope,retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:sha(r.raw)};
 });return{evidence,rawArtifacts};
}
const loaded=load(),genuine=headers(loaded);
const validate=(h=structuredClone(genuine),token=clawd,at=cutoff)=>validateC07LifecycleSource(token,at,h.evidence,h.rawArtifacts);
function receipt(p:any,role:string){const r=p.manifest.receipts.find((r:any)=>r.role===role);assert.ok(r,role);return r;}
function decode(p:any,role:string):string{return receipt(p,role).encoding==='TEXT'?p.rawSources[role]:inflateRawSync(Buffer.from(p.rawSources[role],'base64')).toString('utf8');}
/** Rehash outer stored/decoded bytes; original receipt pins must still reject rewritten authority. */
function setSource(p:any,role:string,text:string){
 const r=receipt(p,role),body=Buffer.from(text);r.sourceBytes=body.length;r.sourceHash=sha(body);
 if(r.encoding==='TEXT')p.rawSources[role]=text;
 else{const archive=deflateRawSync(body);p.rawSources[role]=archive.toString('base64');r.originalArchiveBytes=archive.length;r.originalArchiveHash=sha(archive);}
 r.storedBytes=Buffer.byteLength(p.rawSources[role]);r.storedHash=sha(p.rawSources[role]);
}
function rejectsPacket(label:string,edit:(p:any)=>void,token=clawd,at=cutoff){const p=structuredClone(fixture);edit(p);const file=join(dir,'mutation.json');writeFileSync(file,JSON.stringify(p));assert.throws(()=>validate(headers(load(file,token,at)),token,at),/C07_LIFECYCLE_/,label);}

test('genuine 60-source fixed cohort rederives CLAWD INACTIVE from complete native and finite provided samples',()=>{
 assert.equal(original.length,836193);assert.equal(sha(original),'340a66338fe8aac69ae43cc84a1ac33b5a73e94fb3fe6d6dbf7aef3c6c4c7ee1');
 assert.equal(fixture.manifest.purpose,C07_PURPOSE);assert.equal(fixture.manifest.receipts.length,60);assert.equal(loaded.records.length,61);assert.equal(loaded.records[0]!.id,C07_CAPTURE_ID);
 for(const r of fixture.manifest.receipts){const wire=loaded.records.find(w=>w.id===C07_SOURCE_PREFIX+r.role);assert.ok(wire,r.role);assert.equal(wire.raw,fixture.rawSources[r.role]);assert.equal(wire.retrievedAt,r.retrievedAt);}
 const result=validate(),data=result.metric.data as any;
 assert.equal(result.ids.length,61);assert.equal(result.input.profileSha256,C07_PROFILE_SHA256);assert.equal(result.input.assets.length,7);
 assert.equal(result.metric.id,'C07');assert.equal(result.metric.quality,'KNOWN');assert.equal(data.state,'INACTIVE');assert.equal(data.confirmedAt,'2026-11-05T08:00:00Z');
 assert.equal(data.knowledgeMode,'RETROSPECTIVE_RECONSTRUCTION');
 const native=result.input.assets[1]!.native;assert.equal(native.status,'COMPLETE');assert.equal(native.events.length,1);assert.equal(native.events[0]!.side,'BUY');assert.ok(native.events[0]!.blockTime<1793844000);
 assert.equal(result.input.assets[1]!.attention.status,'COMPLETE');assert.equal(result.input.assets[1]!.attention.posts.length,0);
 assert.deepEqual(data.windows.map((w:any)=>[w.status,w.newMeaningfulBuyerCount,w.buyQuoteAtomic,w.sellQuoteAtomic,w.providedPostCount,w.candidate,w.effective]),[
  ['COMPLETE','0','0','0','0',null,'UNKNOWN'],['COMPLETE','0','0','0','0','INACTIVE','UNKNOWN'],['COMPLETE','0','0','0','0','INACTIVE','INACTIVE']]);
 assert.equal(data.scope.zeroPosts,'FINITE_SAMPLE_NONCONTRADICTION_ONLY_NOT_PLATFORM_QUIET_OR_ATTENTION_DECLINE');
});

test('all seven genuine identities retain six honest missing controls and the old C5 remains missing',()=>{
 const result=validate();
 for(const [i,[mint,pool]] of C07_COHORT.entries()){
  const token:TokenRef={chain:'solana',address:mint},r=validate(structuredClone(genuine),token),input=result.input.assets[i]!;
  assert.equal(input.token.address,mint);assert.equal(input.pool,pool);assert.equal(r.metric.quality,i===1?'KNOWN':'MISSING');
  if(i===1)continue;
  const data=r.metric.data as any;assert.equal(data.state,'UNKNOWN');assert.ok(data.windows.every((w:any)=>w.newMeaningfulBuyerCount===null&&w.buyQuoteAtomic===null&&w.sellQuoteAtomic===null&&w.providedPostCount===null));
  assert.equal(input.native.status,'MISSING');assert.equal(input.native.events.length,0);
  if(i===0)assert.match(input.native.reason!,/WATCHED_ACCOUNT_OPERATION_UNSUPPORTED/);
  else if(i===5)assert.match(input.native.reason!,/PRIVATE_TRANSFER_ROUTE_UNSUPPORTED/);
  else{assert.equal(input.pool,null);assert.match(input.native.reason!,/NO_ELIGIBLE_POOL_MISSING_NO_FALLBACK/);}
 }
 assert.equal(result.input.assets[6]!.attention.status,'MISSING');assert.equal(result.input.assets[6]!.attention.reason,'OWN_BODY_CONCORDANCE_UNRESOLVED');
});

test('a nonmember gets no study value but cannot bypass full source validation',()=>{
 const token:TokenRef={chain:'solana',address:'So11111111111111111111111111111111111111112'},result=validate(structuredClone(genuine),token);
 assert.equal(result.metric.quality,'MISSING');assert.equal(result.metric.reasonCode,'C07_OUTSIDE_FROZEN_COHORT');assert.equal(result.metric.data,null);assert.deepEqual(result.metric.evidenceIds,[]);assert.equal(result.ids.length,61);
 rejectsPacket('nonmember full source still required',p=>{delete p.rawSources['native-a1-bulk-1'];},token);
});

test('owned namespace and exact purpose/provenance/hash/original clock cannot acquire foreign authority',()=>{
 const cases:[string,(h:ReturnType<typeof headers>)=>void][]=[
  ['source',h=>{h.evidence[0]!.sourceId='foreign';}],['adapter',h=>{h.evidence[0]!.adapterVersion='foreign-v1';}],
  ['type',h=>{h.evidence[0]!.sourceType='WEB_PAGE' as any;}],['access',h=>{h.evidence[0]!.accessMode='PUBLIC_API' as any;}],
  ['purpose',h=>{h.evidence[1]!.scope={...h.evidence[1]!.scope,purpose:'WBTC_BULK_FX'};}],
  ['duplicate',h=>{h.evidence.push({...h.evidence[0]!});}],['missing',h=>{h.evidence.pop();}],
  ['hash',h=>{h.evidence[1]!.contentHash='0'.repeat(64);}],['restamped clock',h=>{h.evidence[1]!.retrievedAt=cutoff;h.evidence[1]!.availableAt=cutoff;}],
  ['availability',h=>{h.evidence[1]!.availableAt=cutoff;}],['orphan raw',h=>{h.rawArtifacts[C07_SOURCE_PREFIX+'orphan']='x';}],
  ['missing raw',h=>{delete h.rawArtifacts[h.evidence[1]!.id];}],['changed raw',h=>{h.rawArtifacts[h.evidence[1]!.id]+=' ';}],
  ['foreign id with owned adapter',h=>{h.evidence.push({...h.evidence[0]!,id:'foreign'});h.rawArtifacts.foreign=h.rawArtifacts[C07_CAPTURE_ID]!;}]
 ];
 for(const [label,edit] of cases){const h=structuredClone(genuine);edit(h);assert.throws(()=>validate(h),/C07_LIFECYCLE_/,label);}
});

test('portable closed catalog and original requests/clocks/bodies remain frozen even after rehashing',()=>{
 const cases:[string,(p:any)=>void][]=[
  ['wrong purpose',p=>{p.manifest.purpose='WBTC_BULK_FX';}],['wrong method',p=>{p.manifest.method='old-source';}],
  ['path authority',p=>{p.manifest.sourcePath='/tmp/raw';}],['duplicate role',p=>{p.manifest.receipts.push({...p.manifest.receipts[0]});}],
  ['foreign role',p=>{p.rawSources.foreign='{}';}],['missing terminal',p=>{p.manifest.receipts=p.manifest.receipts.filter((r:any)=>r.role!=='native-a1-bulk-1');delete p.rawSources['native-a1-bulk-1'];}],
  ['rewritten native request',p=>{receipt(p,'native-a1-index-0').request.params[1].before='fabricated-upper';}],
  ['rewritten search query',p=>{receipt(p,'search-02').request.query='different sample';}],
  ['rewritten receipt clock',p=>{receipt(p,'native-a1-bulk-0').retrievedAt=cutoff;}],['HTTP error',p=>{receipt(p,'native-a1-bulk-0').httpStatus=503;}],
  ['archive hash',p=>{receipt(p,'native-a1-bulk-0').originalArchiveHash='0'.repeat(64);}],['stored hash',p=>{receipt(p,'native-a1-bulk-0').storedHash='0'.repeat(64);}],
  ['invalid archive',p=>{p.rawSources['native-a1-bulk-0']='!';}],
  ['profile rewrite',p=>{const c=JSON.parse(decode(p,'contract'));c.nativeRule.meaningfulBuyCoreQuoteAtomic='1';setSource(p,'contract',JSON.stringify(c));}],
  ['rehash native body',p=>{setSource(p,'native-a1-bulk-0',decode(p,'native-a1-bulk-0')+' ');}],
  ['rehash public own body',p=>{const role='2118139164726329509-syndication',v=JSON.parse(decode(p,role));v.text='invented call';setSource(p,role,JSON.stringify(v));}]
 ];for(const [label,edit] of cases)rejectsPacket(label,edit);
 rejectsPacket('cutoff before packaging',()=>{},clawd,new Date(Date.parse(fixture.manifest.packagedAt)-1).toISOString());
 // These mutations reject through original receipt pins; they do not independently exercise
 // every downstream financial/qualification guard. The genuine source executes those guards.
});

test('native in-memory boundary independently rejects a fabricated latest-index cursor and raw clock/hash gaps',()=>{
 const receipts=JSON.parse(decode(fixture,'native-requests')),capture=JSON.parse(decode(fixture,'native-capture'));
 const raw=new Map<string,string>(receipts.map((r:any)=>[r.id,decode(fixture,'native-'+r.id)]));
 const wrongRequest=structuredClone(receipts),r=wrongRequest.find((r:any)=>r.id==='a1-index-0');r.request.params[1].before='fabricated-upper';r.requestHash=sha(JSON.stringify(r.request));r.requestBytes=Buffer.byteLength(JSON.stringify(r.request));
 assert.match(reconstructC07Native(raw,capture,wrongRequest)[1]!.native.reason!,/REQUEST_OR_BODY_A1_INDEX_0/);
 const changed=new Map(raw);changed.set('a1-bulk-0',raw.get('a1-bulk-0')+' ');assert.equal(reconstructC07Native(changed,capture,receipts)[1]!.native.status,'MISSING');
 const clock=structuredClone(receipts);clock.find((r:any)=>r.id==='a1-bulk-0').receivedAt='2026-11-04T00:00:00Z';assert.match(reconstructC07Native(raw,capture,clock)[1]!.native.reason!,/RECEIPT_CLOCKS/);
 const orphan=new Map(raw);orphan.set('a1-bank/../../foreign','{}');assert.match(reconstructC07Native(orphan,capture,receipts)[1]!.native.reason!,/RAW_CATALOG/);
});

test('FILE boundary rejects symlinks, directories, oversize, malformed JSON/UTF8 and bounded record claims',()=>{
 const bad=join(dir,'bad.json');writeFileSync(bad,'{"manifest":');assert.throws(()=>load(bad),/C07_LIFECYCLE_/);
 writeFileSync(bad,Buffer.from([0x7b,0xff,0x7d]));assert.throws(()=>load(bad),/C07_LIFECYCLE_/);
 assert.throws(()=>load(dir),/C07_LIFECYCLE_/);const link=join(dir,'symlink.json');symlinkSync(genuineFile,link);assert.throws(()=>load(link),/C07_LIFECYCLE_/);
 writeFileSync(bad,Buffer.alloc(C07_FILE_BYTES+1,0x20));assert.throws(()=>load(bad),/C07_LIFECYCLE_/);
 assert.throws(()=>load(genuineFile,{chain:'base',address:'0x0000000000000000000000000000000000000001'}),/C07_LIFECYCLE_/);
 rejectsPacket('record cap',p=>{p.manifest.receipts=Array.from({length:C07_RECORDS+1},(_,i)=>({...p.manifest.receipts[0],role:'extra-'+i}));});
 rejectsPacket('decoded per record claim cap',p=>{receipt(p,'native-a1-bulk-0').sourceBytes=C07_RECORD_BYTES+1;});
});
