import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import type {EvidenceRecord,TokenRef} from '../src/domain/contracts.js';
import {loadA28DecayCapture,validateA28DecaySource,A28_SOURCE_ID,A28_SOURCE_PREFIX,A28_CAPTURE_ID,A28_ADAPTER,A28_PURPOSE,A28_ORIGINAL_BODIES,a28Owns,a28Hash as sha} from '../src/providers/advisory-a28-decay-source.js';
import {rederiveA28Source} from '../src/providers/advisory-a28-native-source.js';
import {reconstructXStream} from '../src/providers/advisory-saturation.js';
import {A28_SOURCE_FRAME_SHA256,A28_PROFILE_SHA256} from '../src/providers/advisory-a28-decay-study.js';
const original=gunzipSync(readFileSync(join(process.cwd(),'tests/fixtures/a28-native-decay.json.gz'))),fixture=JSON.parse(original.toString('utf8'));
const cutoff='2026-11-06T00:00:00.000Z';
const c5:TokenRef={chain:'solana',address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
const parasite:TokenRef={chain:'solana',address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'},clawd:TokenRef={chain:'solana',address:'8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump'};
const dir=mkdtempSync(join(tmpdir(),'a28-source-')),file=join(dir,'capture.json');writeFileSync(file,original);
process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
const loaded=loadA28DecayCapture(file,c5,cutoff);
function headers(x=loaded){const rawArtifacts=Object.fromEntries(x.records.map(r=>[r.id,r.raw]));const evidence:EvidenceRecord[]=x.records.map(r=>({id:r.id,sourceId:A28_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:sha(r.raw),adapterVersion:A28_ADAPTER,accessMode:'USER_IMPORT',scope:r.scope}));return{evidence,rawArtifacts};}
const genuine=headers();
const validate=(h=genuine,token=c5,at=cutoff)=>validateA28DecaySource(token,at,h.evidence,h.rawArtifacts);
function rejectFile(change:(p:any)=>void,token=c5){const p=structuredClone(fixture);change(p);const f=join(dir,'changed.json');writeFileSync(f,JSON.stringify(p));assert.throws(()=>loadA28DecayCapture(f,token,cutoff),/A28_DECAY_/);}
const body=(p:any,role:string)=>p.records.find((r:any)=>r.role===role).body;
function editBody(p:any,role:string,change:(j:any)=>void){const b=body(p,role),j=JSON.parse(b.raw);change(j);b.raw=JSON.stringify(j);b.bytes=Buffer.byteLength(b.raw);b.sha256=sha(b.raw);}
function editPage(p:any,n:number,change:(j:any)=>void){const role='native-page-'+String(n).padStart(2,'0');editBody(p,role,change);editBody(p,'original-manifest',m=>{const b=body(p,role);m.entries[n].bytes=b.bytes;m.entries[n].sha256=b.sha256;m.responseBytesTotal=m.entries.reduce((x:number,e:any)=>x+e.bytes,0);});}
const ins=(j:any)=>j.data.search_by_raw_query.search_timeline.timeline.instructions;

test('genuine source rederives exact native census, corrected URLs, original clocks and context separation',()=>{
 assert.equal(original.length,596517);assert.equal(fixture.purpose,A28_PURPOSE);assert.equal(fixture.records.length,19);assert.equal(loaded.records.length,20);assert.equal(loaded.records[0]!.id,A28_CAPTURE_ID);
 for(const r of fixture.records){assert.equal(r.body.sha256,A28_ORIGINAL_BODIES[r.role]!.sha256);assert.equal(loaded.records.find(x=>x.id===A28_SOURCE_PREFIX+r.role)!.raw,r.body.raw);}
 const native=rederiveA28Source(original.toString('utf8'),{now:Date.parse(cutoff)});
 assert.equal(native.stream.status,'COMPLETE');assert.equal(native.stream.pages,3);assert.equal(native.stream.startedAt,'2026-11-04T13:43:50.420Z');assert.equal(native.stream.lastResponseAt,'2026-11-04T13:44:17.710Z');assert.equal(native.stream.witness.observedAt,'2026-11-04T13:44:31.524Z');
 assert.equal(native.posts.length,22);assert.equal(native.posts[0].postId,'2113777174369230965');assert.equal(native.posts.at(-1).postId,'2114795091244015796');
 for(const p of native.posts){assert.equal(sha(p.body),p.bodySha256);assert.ok(p.withinFrozenInterval);assert.ok(!native.contextOnly.some((c:any)=>c.postId===p.postId));}
 const sasa=native.posts.find((p:any)=>p.postId==='2114563729526542842');assert.equal(sasa.bodyBindsMint,false);assert.equal(sasa.ownUrlEntities[0].offsetInterpretation,'CODEPOINT_ONLY');assert.match(sasa.ownUrlEntities[0].entity.expanded_url,/C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump/);
 const gcr=native.posts.find((p:any)=>p.postId==='2114002882022490581');assert.equal(gcr.body,'https://t.co/CrpxkTiM1n');assert.equal(gcr.bodyBindsMint,false);assert.ok(native.contextOnly.some((c:any)=>c.postId==='2114002863940641233'&&c.originalCommentaryBorrowed===false));
 assert.ok(native.contextOnly.some((c:any)=>c.postId==='2114361840058966065'&&c.revision==='UNVERIFIED'));
 assert.equal(native.nativeReuse.A24MetricAuthority,false);assert.equal(native.nativeReuse.privateDecoderCopy,false);assert.equal(native.stream.terminalProof.originalBodyNeverStrippedOrRewritten,true);
});

test('genuine C5 source-derived conditional vector and two real nonmember controls validate all raw first',()=>{
 const r=validate(),data=r.metric.data as any;assert.equal(r.ids.length,20);assert.equal(r.input.sourceFrameSha256,A28_SOURCE_FRAME_SHA256);assert.equal(r.input.profileSha256,A28_PROFILE_SHA256);assert.equal(r.metric.quality,'KNOWN');assert.equal(r.metric.unit,'MODEL_CONDITIONAL_SECONDS');
 assert.equal(data.interpretations.length,2);assert.equal(data.sensitivityEnvelope.allCasesIndividuallyFitted,true);assert.equal(data.sensitivityEnvelope.positiveHalfLifeSupportEnvelope.upper.kind,'UNBOUNDED');assert.equal(data.sensitivityEnvelope.positiveHalfLifeSupportEnvelope.nonDecaySupported,true);
 for(const p of r.input.posts)assert.equal(p.alternativeEligible,p.postId==='2114795091244015796'?false:p.primaryEligible);
 assert.ok(r.input.posts.find(p=>p.postId==='2114563729526542842')!.primaryEligible);
 assert.ok(r.input.catalysts.some(c=>c.id==='2114002863940641233'&&c.barrier));
 assert.ok(r.input.catalysts.find(c=>c.id==='2114561798733275284')?.barrier===false);
 for(const token of [parasite,clawd]){const control=validate(structuredClone(genuine),token);assert.equal(control.metric.quality,'MISSING');assert.equal(control.metric.reasonCode,'A28_OUTSIDE_FROZEN_SUBJECT');assert.equal(control.metric.data,null);assert.deepEqual(control.metric.evidenceIds,[]);assert.equal(control.ids.length,20);const broken=structuredClone(genuine);delete broken.rawArtifacts[A28_SOURCE_PREFIX+'native-page-02'];assert.throws(()=>validate(broken,token),/A28_DECAY_/);}
});

test('new owned namespace exact purpose, provenance, requests, clocks, full catalog and hashes fail closed',()=>{
 const changes:[string,(h:typeof genuine)=>void][]=[
  ['source',h=>{h.evidence[0]!.sourceId='advisory-saturation';}],['adapter',h=>{h.evidence[0]!.adapterVersion='a24-raw-capture-v1';}],['type',h=>{h.evidence[0]!.sourceType='MODEL_API';}],['access',h=>{h.evidence[0]!.accessMode='PUBLIC_API';}],
  ['purpose',h=>{h.evidence[1]!.scope={...h.evidence[1]!.scope,purpose:'A24_SATURATION'};}],['request',h=>{h.evidence[1]!.scope={...h.evidence[1]!.scope,request:{url:'foreign'}};}],['clock',h=>{h.evidence[1]!.retrievedAt=cutoff;h.evidence[1]!.availableAt=cutoff;}],['availability',h=>{h.evidence[1]!.availableAt=cutoff;}],
  ['hash',h=>{h.evidence[1]!.contentHash='0'.repeat(64);}],['duplicate',h=>{h.evidence.push({...h.evidence[0]!});}],['missing',h=>{h.evidence.pop();}],['missing raw',h=>{delete h.rawArtifacts[h.evidence[1]!.id];}],['orphan raw',h=>{h.rawArtifacts[A28_SOURCE_PREFIX+'orphan']='x';}],['raw mutation',h=>{h.rawArtifacts[h.evidence[1]!.id]+=' ';}],
  ['owned adapter foreign id',h=>{h.evidence.push({...h.evidence[0]!,id:'foreign'});h.rawArtifacts.foreign=h.rawArtifacts[A28_CAPTURE_ID]!;}]
 ];
 for(const[label,change]of changes){const h=structuredClone(genuine);change(h);assert.throws(()=>validate(h),/A28_DECAY_/,label);}
 assert.equal(a28Owns({...genuine.evidence[0]!,id:'foreign',sourceId:'foreign'}),true);
});

test('portable original snapshot is pinned before source semantics, including fully rehashed tampering',()=>{
 // These prove immutable-origin admission, not reachability of every deeper semantic branch.
 const changes:((p:any)=>void)[]=[p=>p.purpose='A24_SATURATION',p=>p.namespace='advisory-saturation',p=>p.sourcePath='/etc/passwd',p=>p.packagedAt='2026-11-07T00:00:00.000Z',p=>p.records.push({...p.records[0]}),p=>p.records.pop(),p=>body(p,'native-page-00').sha256='0'.repeat(64),
  p=>editPage(p,2,j=>ins(j)[2].direction='Top'),p=>editBody(p,'root-qualification-context',q=>q.rows[0].rootDecision='ELIGIBLE'),p=>editBody(p,'catalyst-dispositions',q=>q.items[0].barrierForAnyLaterFitStartingBeforeThisPublication=true),p=>editBody(p,'model-profile',q=>q.peak.gridSeconds=1),p=>editBody(p,'client-end-witness',w=>w.filteredRequestsAfterSecond=2),p=>p.records.push({role:'foreign',body:{raw:'{}',bytes:2,sha256:sha('{}')}})];
 for(const change of changes)rejectFile(change);
 rejectFile(p=>editBody(p,'model-profile',q=>q.method='foreign'),parasite);
});

test('native terminal adapter preserves old public decoder and rejects genuine protocol boundary mutations',()=>{
 const m=JSON.parse(body(fixture,'original-manifest').raw),pages=m.entries.map((e:any,i:number)=>({...e,body:body(fixture,'native-page-'+String(i).padStart(2,'0'))}));
 assert.throws(()=>reconstructXStream(pages,[],{query:m.query} as any,c5.address),(e:any)=>e.code==='A24_X_UNKNOWN_INSTRUCTION');
 const reject=(change:(p:any)=>void,rx:RegExp)=>{const p=structuredClone(fixture);change(p);assert.throws(()=>rederiveA28Source(JSON.stringify(p),{now:Date.parse(cutoff)}),rx);};
 reject(p=>editPage(p,2,j=>ins(j)[2].direction='Top'),/EXACT_BOTTOM_TERMINATION/);
 reject(p=>editPage(p,2,j=>ins(j)[2].extra=true),/TERMINATION_KEYS/);
 reject(p=>editPage(p,2,j=>{ins(j)[0].entry_id_to_replace='other';ins(j)[0].entry.entryId='other';}),/ADJACENT_ROW/);
 reject(p=>editBody(p,'original-manifest',m=>{const e=m.entries[2],u=new URL(e.url),v=JSON.parse(u.searchParams.get('variables')!);v.cursor='wrong';e.variables=v;u.searchParams.set('variables',JSON.stringify(v));e.url=u.href;}),/FINAL_REQUEST_CHAIN/);
 reject(p=>editPage(p,0,j=>{const e=ins(j)[0].entries.find((e:any)=>e.content?.itemContent?.tweet_results?.result?.note_tweet);delete e.content.itemContent.tweet_results.result.note_tweet.note_tweet_results.result.text;}),/A24_X_BODY/);
 reject(p=>editPage(p,0,j=>{const e=ins(j)[0].entries.find((e:any)=>e.content?.__typename==='TimelineTimelineItem');e.content.itemContent.tweet_results.result.legacy.user_id_str='1';}),/A24_X_IDENTITY/);
 reject(p=>editPage(p,0,j=>{const e=ins(j)[0].entries.find((e:any)=>e.content?.itemContent?.tweet_results?.result?.rest_id==='2114563729526542842');e.content.itemContent.tweet_results.result.legacy.entities.urls[0].indices=[140,163];}),/A28_OWN_URL_OFFSET/);
 const p=structuredClone(fixture);editBody(p,'client-end-witness',w=>{w.loadingOrErrorObserved=true;w.complete=true;});assert.equal(rederiveA28Source(JSON.stringify(p),{now:Date.parse(cutoff)}).stream.status,'INCOMPLETE');
});

test('source judgments remain body-bound with exact primary census, group and own URL proof',()=>{
 for(const [change,rx]of [
  [(q:any)=>{q.rows[0].postId='2114002863940641233';},/QUALIFICATION_PRIMARY_BINDING/],
  [(q:any)=>{q.rows.pop();},/QUALIFICATION_FULL_PRIMARY_CENSUS/],
  [(q:any)=>{q.rows[0].binding.literalOwnMint=false;},/QUALIFICATION_BINDING_SOURCE/],
  [(q:any)=>{q.rows[0].copy.groupId='merged';},/QUALIFICATION_RECONSTRUCTED_GROUP/],
  [(q:any)=>{const r=q.rows.find((r:any)=>r.eligibility.nonPriceOwnSpans.length);r.eligibility.nonPriceOwnSpans[0].text='NOT IN OWN SOURCE';},/QUALIFICATION_OWN_SOURCE_SPAN/]
 ]as const){const p=structuredClone(fixture);editBody(p,'root-qualification-context',change);assert.throws(()=>rederiveA28Source(JSON.stringify(p),{now:Date.parse(cutoff)}),rx);}
});

test('regular NOFOLLOW UTF8 bounded file import and opaque metadata paths cannot read external source files',()=>{
 const link=join(dir,'linked.json');symlinkSync(file,link);assert.throws(()=>loadA28DecayCapture(link,c5,cutoff),/A28_DECAY_/);
 const folder=join(dir,'directory');mkdirSync(folder);assert.throws(()=>loadA28DecayCapture(folder,c5,cutoff),/A28_DECAY_/);
 const big=join(dir,'big.json');writeFileSync(big,Buffer.alloc(4*1024*1024+1));assert.throws(()=>loadA28DecayCapture(big,c5,cutoff),/A28_DECAY_/);
 const bad=join(dir,'utf8.json');writeFileSync(bad,Buffer.from([0xff]));assert.throws(()=>loadA28DecayCapture(bad,c5,cutoff),/A28_DECAY_/);
 assert.throws(()=>loadA28DecayCapture(file,{chain:'base',address:'x'},cutoff),/A28_DECAY_/);
 const p=structuredClone(fixture);p.sourcePath='/etc/passwd';writeFileSync(join(dir,'path.json'),JSON.stringify(p));assert.throws(()=>loadA28DecayCapture(join(dir,'path.json'),c5,cutoff),/A28_DECAY_/);
});
