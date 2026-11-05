import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync,inflateRawSync,deflateRawSync} from 'node:zlib';
import type {EvidenceRecord,TokenRef} from '../src/domain/contracts.js';
import {loadS18ObservabilityCapture,validateS18ObservabilitySource,S18_SOURCE_ID,S18_SOURCE_PREFIX,S18_CAPTURE_ID,S18_ADAPTER,S18_PURPOSE} from '../src/providers/advisory-s18-observability-source.js';
import {S18_REASONS} from '../src/providers/advisory-s18-study.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const original=gunzipSync(readFileSync('tests/fixtures/s18-selected-buy-observability.json.gz'));
const fixture=JSON.parse(original.toString());
const token:TokenRef={chain:'solana',address:'8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump'};
const cutoff='2026-11-10T00:00:00.000Z';
const selected=JSON.parse(fixture.rawSources.contract).selection.signature;
const controls:TokenRef[]=[
 {chain:'solana',address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},
 {chain:'solana',address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'}];
const dir=mkdtempSync(join(tmpdir(),'s18-source-'));
process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
const genuineFile=join(dir,'genuine.json');writeFileSync(genuineFile,original);
function load(file=genuineFile,t=token,at=cutoff){return loadS18ObservabilityCapture(file,t,at);}
function headers(loaded:ReturnType<typeof load>){
 const rawArtifacts:Record<string,string>={};
 const evidence:EvidenceRecord[]=loaded.records.map(r=>{
  assert.equal(typeof r.raw,'string');assert.equal(typeof r.retrievedAt,'string');assert.ok(!(r.id in rawArtifacts));rawArtifacts[r.id]=r.raw;
  return{id:r.id,sourceId:S18_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:S18_ADAPTER,scope:r.scope,retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:sha(r.raw)};
 });
 return{evidence,rawArtifacts};
}
const loaded=load(),genuine=headers(loaded);
const validate=(h=structuredClone(genuine),t=token,at=cutoff)=>validateS18ObservabilitySource(t,at,h.evidence,h.rawArtifacts);
const receipt=(p:any,role:string)=>{const r=p.manifest.receipts.find((r:any)=>r.role===role);assert.ok(r,role);return r;};
function decode(p:any,role:string):string{return receipt(p,role).encoding==='TEXT'?p.rawSources[role]:inflateRawSync(Buffer.from(p.rawSources[role],'base64')).toString();}
/** Refresh both stored and decoded hashes, so a semantic contradiction is not merely a stale outer checksum. */
function setSource(p:any,role:string,text:string){
 const r=receipt(p,role),bytes=Buffer.from(text);r.sourceBytes=bytes.length;r.sourceHash=sha(bytes);
 if(r.encoding==='TEXT')p.rawSources[role]=text;
 else{const archive=deflateRawSync(bytes);p.rawSources[role]=archive.toString('base64');r.originalArchiveBytes=archive.length;r.originalArchiveHash=sha(archive);}
 r.storedBytes=Buffer.byteLength(p.rawSources[role]);r.storedHash=sha(p.rawSources[role]);
}
// Native financial JSON can contain u64 values beyond Number.MAX_SAFE_INTEGER. Preserve every untouched numeric lexeme.
const losslessParse=(text:string):any=>JSON.parse(text,((_key:string,value:unknown,context:{source:string})=>typeof value==='number'?(JSON as any).rawJSON(context.source):value) as any);
function editSource(p:any,role:string,edit:(body:any)=>void){const body=losslessParse(decode(p,role));edit(body);setSource(p,role,JSON.stringify(body));}
function refreshNativeReceipts(p:any){
 const cap=JSON.parse(p.rawSources['native-capture']);
 cap.receipts=cap.receipts.filter((r:any)=>p.manifest.receipts.some((x:any)=>x.role==='native-'+r.id));
 for(const r of cap.receipts){const outer=receipt(p,'native-'+r.id),request=JSON.stringify(outer.request);Object.assign(r,{request:structuredClone(outer.request),requestBytes:Buffer.byteLength(request),requestHash:sha(request),sourceBytes:outer.sourceBytes,sourceHash:outer.sourceHash,archiveBytes:outer.originalArchiveBytes,archiveHash:outer.originalArchiveHash,startedAt:outer.startedAt,receivedAt:outer.retrievedAt});}
 cap.requestsIssued=cap.receipts.length;cap.decodedBytes=cap.receipts.reduce((n:number,r:any)=>n+r.sourceBytes,0);cap.storedBytes=cap.receipts.reduce((n:number,r:any)=>n+r.archiveBytes,0);
 cap.stats.bulkPages=cap.receipts.filter((r:any)=>r.id.startsWith('bulk-')).length;cap.stats.indexPages=cap.receipts.filter((r:any)=>r.id.startsWith('index-')).length;
 setSource(p,'native-capture',JSON.stringify(cap));
}
function rejectsPacket(label:string,edit:(p:any)=>void,native=false,at=cutoff,t=token){
 const p=structuredClone(fixture);edit(p);if(native)refreshNativeReceipts(p);
 const file=join(dir,'mutation.json');writeFileSync(file,JSON.stringify(p));
 assert.throws(()=>validate(headers(load(file,t,at)),t,at),/S18_OBSERVABILITY_/,label);
}
const bulk=losslessParse(decode(fixture,'native-bulk-0'));
const routed=bulk.result.data.find((t:any)=>t.transaction.signatures[0]!==selected&&t.meta.logMessages.some((l:string)=>/^Program log: Instruction: (BuyExactQuoteIn|Buy|Sell)$/.test(l))&&t.meta.logMessages.includes('Program 6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB success'));
assert.ok(routed,'The genuine tape must contain a nonselected relevant routed trade for the ancestor test');
const routedSignature=routed.transaction.signatures[0];
const mutateRouted=(p:any,edit:(t:any)=>void)=>editSource(p,'native-bulk-0',body=>{const tx=body.result.data.find((t:any)=>t.transaction.signatures[0]===routedSignature);assert.ok(tx);edit(tx);});

test('genuine retained 22-source CLAWD pack reconstructs the complete selected study and exact components',()=>{
 assert.equal(original.length,696855);assert.equal(sha(original),'e9e076574951e28fcc8cb96751545b577ebd5382328e95f72f8e1fd7b05ae338');
 assert.equal(fixture.manifest.purpose,S18_PURPOSE);assert.equal(fixture.manifest.receipts.length,22);assert.equal(loaded.records.length,23);assert.equal(loaded.records[0]!.id,S18_CAPTURE_ID);
 assert.equal(loaded.records[0]!.retrievedAt,fixture.manifest.packagedAt);
 for(const r of fixture.manifest.receipts){const wire=loaded.records.find(x=>x.id===S18_SOURCE_PREFIX+r.role);assert.ok(wire,r.role);assert.equal(wire.raw,fixture.rawSources[r.role],r.role);assert.equal(wire.retrievedAt,r.retrievedAt,r.role);}
 const result=validate();assert.equal(result.metric.quality,'KNOWN');assert.equal(result.metric.id,'S18');assert.equal(result.ids.length,23);
 const data=result.metric.data as any,study=data.study,c=study.components;
 assert.equal(data.membership.sourceValidated,true);assert.equal(data.membership.currentTokenMember,true);
 assert.equal(study.selection.label,'SELECTED_INCREMENTAL_BUY');
 assert.equal(c.entry.value.selectedBaseAccount.preAtomic,'8793265724');assert.equal(c.entry.value.selectedBaseAccount.postAtomic,'20357621391');
 assert.equal(c.tracking.value.followCount,'0');assert.equal(c.tracking.value.entryTimeTracking,'UNKNOWN');
 assert.equal(c.repost.value.quoteMinusOriginal.seconds,'76');assert.equal(c.repost.value.quoteMinusNativeEntry.seconds,'148');
 assert.equal(c.flow.value.retainedEvents,10);assert.equal(c.flow.value.pre.other.netQuoteAtomic,'41501976');assert.equal(c.flow.value.post.other.netQuoteAtomic,'262064924');
 assert.equal(c.flow.value.postMinusPre.otherNetQuoteAtomic,'220562948');assert.equal(c.flow.value.pre.actor.netQuoteAtomic,'11713397');assert.equal(c.flow.value.post.actor.netQuoteAtomic,'0');
 assert.equal(c.flow.value.sameSecond.selectedEntry.coreQuoteAtomic,'15406876');
 assert.equal(study.interpretation.causalCopyAsserted,false);assert.equal(study.interpretation.globalTrackerCensusAsserted,false);
});

test('genuine C5 and Parasite are nonmembers only after the same entire selected source is validated',()=>{
 for(const t of controls){
  const result=validate(headers(load(genuineFile,t)),t),data=result.metric.data as any;
  assert.equal(result.metric.quality,'MISSING');assert.equal(result.metric.reasonCode,S18_REASONS.notMember);
  assert.equal(result.ids.length,23);assert.equal(data.membership.sourceValidated,true);assert.equal(data.membership.currentTokenMember,false);assert.equal(data.study,null);
  rejectsPacket('nonmember cannot bypass malformed full source',p=>{delete p.rawSources['native-bulk-1'];},false,cutoff,t);
 }
});

test('owned namespace, provenance, original clocks, exact hashes and catalog reject before native decoding',()=>{
 const cases:[string,(h:ReturnType<typeof headers>)=>void][]=[
  ['wrong source',h=>{h.evidence[0]!.sourceId='advisory-foreign';}],
  ['wrong adapter',h=>{h.evidence[0]!.adapterVersion='foreign-v1';}],
  ['wrong source type',h=>{h.evidence[0]!.sourceType='WEB_PAGE' as any;}],
  ['wrong access mode',h=>{h.evidence[0]!.accessMode='PUBLIC_API' as any;}],
  ['duplicate evidence',h=>{h.evidence.push(structuredClone(h.evidence[0]!));}],
  ['missing evidence',h=>{h.evidence.pop();}],
  ['wrong scope',h=>{h.evidence[1]!.scope={};}],
  ['wrong content hash',h=>{h.evidence[1]!.contentHash='0'.repeat(64);}],
  ['future availability',h=>{h.evidence[1]!.availableAt='2026-11-11T00:00:00.000Z';}],
  ['restamped retrieval',h=>{h.evidence[1]!.retrievedAt=cutoff;h.evidence[1]!.availableAt=cutoff;}],
  ['orphan owned raw',h=>{h.rawArtifacts[S18_SOURCE_PREFIX+'orphan']='x';}],
  ['missing raw',h=>{delete h.rawArtifacts[h.evidence[1]!.id];}],
  ['raw changed without hash',h=>{h.rawArtifacts[h.evidence[1]!.id]+=' ';}],
  ['foreign id using adapter',h=>{h.evidence.push({...h.evidence[0]!,id:'unrelated'});h.rawArtifacts.unrelated=h.rawArtifacts[S18_CAPTURE_ID]!;}]];
 for(const [label,edit] of cases){const h=structuredClone(genuine);edit(h);assert.throws(()=>validate(h),/S18_OBSERVABILITY_/,label);}
});

test('portable profile, purpose, receipt catalog, original request and clocks cannot be rewritten',()=>{
 for(const [label,edit] of [
  ['wrong method',(p:any)=>{p.manifest.method='old-source-v1';}],
  ['wrong purpose',(p:any)=>{p.manifest.purpose='UNRELATED_PURPOSE';}],
  ['wrong subject',(p:any)=>{p.manifest.subject.address=controls[0]!.address;}],
  ['duplicate role',(p:any)=>{p.manifest.receipts.push(structuredClone(p.manifest.receipts[0]));}],
  ['foreign role',(p:any)=>{p.rawSources.foreign='x';}],
  ['unknown field',(p:any)=>{p.manifest.sourcePath='/tmp/capture';}],
  ['public request',(p:any)=>{receipt(p,'public-fxtwitter').request.url='https://api.fxtwitter.com/0rdlibrary/status/2110921003983397065';}],
  ['HTTP failure',(p:any)=>{receipt(p,'gmgn-response').httpStatus=503;}],
  ['receipt after packaging',(p:any)=>{receipt(p,'native-bulk-0').retrievedAt=cutoff;}],
  ['stored bytes',(p:any)=>{receipt(p,'native-bulk-0').storedBytes++;}],
  ['decoded bytes',(p:any)=>{receipt(p,'native-bulk-0').sourceBytes++;}],
  ['archive hash',(p:any)=>{receipt(p,'native-bulk-0').originalArchiveHash='0'.repeat(64);}],
  ['malformed base64',(p:any)=>{p.rawSources['native-bulk-0']='!not-base64!';}],
  ['frozen profile changed',(p:any)=>{const c=JSON.parse(p.rawSources.contract);c.components.flow.horizonSeconds=60;setSource(p,'contract',JSON.stringify(c));}]
 ] as [string,(p:any)=>void][])rejectsPacket(label,edit);
 rejectsPacket('cutoff before packaging',()=>{},false,new Date(Date.parse(fixture.manifest.packagedAt)-1).toISOString());
});

// This one-capture adapter pins native receipts too. These negatives protect frozen-source binding;
// their rejection does not independently prove each downstream semantic guard. The genuine positive executes full native reconstruction.
test('rehashing native receipt copies cannot turn incomplete, inconsistent or uncommitted tape into authority',()=>{
 rejectsPacket('missing terminal page',p=>{p.manifest.receipts=p.manifest.receipts.filter((r:any)=>r.role!=='native-bulk-1');delete p.rawSources['native-bulk-1'];},true);
 rejectsPacket('native index membership disagreement',p=>{
  editSource(p,'native-index-0',v=>{const n=v.result.length;v.result=v.result.filter((r:any)=>r.signature!==routedSignature);assert.equal(v.result.length,n-1);});
  const cap=JSON.parse(p.rawSources['native-capture']);cap.stats.indexRows--;cap.stats.successfulExpected--;setSource(p,'native-capture',JSON.stringify(cap));
 },true);
 rejectsPacket('matching but wrong cursor',p=>{editSource(p,'native-bulk-0',v=>{assert.notEqual(v.result.paginationToken,null);v.result.paginationToken='1:0';});receipt(p,'native-bulk-1').request.params[1].paginationToken='1:0';},true);
 rejectsPacket('native chronology contradiction',p=>{const r=receipt(p,'native-bulk-0'),at=Date.parse(receipt(p,'native-index-0').retrievedAt)-1000;r.retrievedAt=new Date(at).toISOString();r.startedAt=new Date(at-50).toISOString();},true);
 rejectsPacket('nonselected failed transaction in successful tape',p=>mutateRouted(p,tx=>{tx.meta.err={InstructionError:[5,'InvalidInstructionData']};}),true);
 rejectsPacket('nonselected failed outer ancestor',p=>mutateRouted(p,tx=>{const log='Program 6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB success',index=tx.meta.logMessages.lastIndexOf(log);assert.ok(index>=0);tx.meta.logMessages[index]=log.replace('success','failed: custom program error: 0x1');}),true);
 rejectsPacket('native copied receipt status',p=>{const cap=JSON.parse(p.rawSources['native-capture']);cap.receipts[0].completeHTTPBody=false;setSource(p,'native-capture',JSON.stringify(cap));},true);
});

test('selected public quote and GMGN wallet/own DOM remain bound to original retained bytes',()=>{
 // These original public bodies are frozen contract pins: refreshed outer hashes may correctly reject at that pin, before the semantic binder.
 rejectsPacket('quote parent and receipt contradiction',p=>{const v=JSON.parse(p.rawSources['public-fxtwitter']);v.tweet.quote.id='2110920686352863466';v.tweet.quote.text=v.tweet.quote.text.replace(selected,'1'.repeat(88));setSource(p,'public-fxtwitter',JSON.stringify(v));});
 rejectsPacket('GMGN query mismatches selected wallet and actual response',p=>{const v=JSON.parse(p.rawSources['gmgn-observation']),post=JSON.parse(v.postData);post.q=controls[0]!.address;v.postData=JSON.stringify(post);receipt(p,'gmgn-response').request.postData=v.postData;setSource(p,'gmgn-observation',JSON.stringify(v));});
 rejectsPacket('GMGN DOM count disagrees with actual response',p=>{const before=p.rawSources['gmgn-dom'];const after=before.replace(/(>Tracked<\/span><span[^>]*>)0(<\/span>)/,(_match:string,prefix:string,suffix:string)=>prefix+'999'+suffix);assert.notEqual(after,before,'actual Tracked0 DOM mutation premise');setSource(p,'gmgn-dom',after);});
 rejectsPacket('GMGN DOM wallet mismatch',p=>{const before=p.rawSources['gmgn-dom'];const after=before.replaceAll(JSON.parse(p.rawSources.contract).selection.actor,controls[0]!.address);assert.notEqual(after,before);setSource(p,'gmgn-dom',after);});
});

test('FILE boundary rejects malformed JSON, directories, symlinks, oversize and decompression limits',()=>{
 const bad=join(dir,'bad.json');writeFileSync(bad,'{"manifest":');assert.throws(()=>load(bad),/S18_OBSERVABILITY_/);
 assert.throws(()=>load(genuineFile,{chain:'base',address:'0x0000000000000000000000000000000000000001'}),/S18_OBSERVABILITY_/);
 writeFileSync(bad,Buffer.from([0x7b,0xff,0x7d]));assert.throws(()=>load(bad),/S18_OBSERVABILITY_/);
 assert.throws(()=>load(dir),/S18_OBSERVABILITY_/);
 const link=join(dir,'capture-link.json');symlinkSync(genuineFile,link);assert.throws(()=>load(link),/S18_OBSERVABILITY_/);
 writeFileSync(bad,Buffer.alloc(8*1024*1024+1,0x20));assert.throws(()=>load(bad),/S18_OBSERVABILITY_/);
 rejectsPacket('record count cap',p=>{p.manifest.receipts=Array.from({length:65},(_,i)=>({...p.manifest.receipts[0],role:'extra-'+i}));});
 rejectsPacket('per-record decoded cap',p=>{setSource(p,'native-bulk-0',' '.repeat(2*1024*1024+1));});
 // Five bounded compressed bodies exceed the aggregate cap while staying individually under 2 MiB and the FILE below 8 MiB.
 rejectsPacket('decoded aggregate cap',p=>{for(const role of ['native-genesis','native-anchor-slot','native-anchor-time','native-current-pool-mints','native-upper-signature'])setSource(p,role,' '.repeat(1800000));});
});
