import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync,deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {decodeA13ParticipationCapture,loadA13ParticipationCapture,A13_CAPTURE_ID,type A13ParticipationCapture} from '../src/providers/advisory-participation-import.js';
import {deriveA13Participation,a13ParticipationRatio,a13QualificationClosure,reconstructA13Qualification} from '../src/providers/advisory-participation-source.js';
const RAW=gunzipSync(readFileSync('tests/fixtures/a13-observed-peer-participation.json.gz')).toString('utf8'),CUT='2026-11-03T00:00:00.000Z',TOKEN={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
function mutate(id:string,edit:(raw:string)=>string){const c=JSON.parse(RAW) as A13ParticipationCapture,r=c.records.find(r=>r.id===id)!;const decoded=decodeA13ParticipationCapture(RAW,CUT).decodedRecords.find(r=>r.id===id)!,raw=edit(decoded.raw);r.data=deflateRawSync(Buffer.from(raw)).toString('base64');r.bytes=Buffer.byteLength(raw);r.sha256=createHash('sha256').update(raw).digest('hex');return JSON.stringify(c);}
const derive=(raw=RAW,token=TOKEN)=>deriveA13Participation(raw,token,CUT,[A13_CAPTURE_ID]);
test('genuine shared ten-candidate study preserves measured zero denominator, unresolved membership and failed controls',()=>{
 const m=derive();assert.equal(m.quality,'KNOWN',JSON.stringify(m));const d=m.data as any;assert.equal(d.share,null);assert.equal(d.shareStatus,'UNDEFINED_ZERO_POSITIVE_GROWTH');assert.equal(d.numeratorPositiveGrowth,'0');assert.equal(d.denominatorPositiveGrowth,'0');assert.equal(d.denominatorIdentified,true);assert.equal(d.qualificationComplete,false);assert.equal(d.identification,'FINITE_FRAME_ZERO_POSITIVE_GROWTH_INVARIANT');assert.equal(d.candidates.length,10);assert.equal(d.qualification.unresolvedTokenKeys.length,2);assert.equal(d.acquisition.complete,false);assert.equal(d.acquisition.requiredCandidateSourcesComplete,true);assert.equal(d.acquisition.failedControlReads,4);assert.equal(d.controls.length,4);assert.ok(d.controls.every((c:any)=>c.rawCount===null&&c.adjustedCount===null));assert.ok(d.candidates.every((c:any)=>c.delta<=0&&[1182,1183].includes(c.intervalSeconds)));assert.equal(d.operator.addressCount,42);
});
test('three actual accepted target identities share one panel and retain distinct native row identities',()=>{
 for(const address of [TOKEN.address,'CXWNzqBE98SSmkGgHogJZd9vjsLdgaMAFpVfV22ypump','DffdPtAKvnP91k9Ct6QvZ8TwVvWbJ6CxRtGNGNh9pump']){const m=derive(RAW,{chain:'solana',address});assert.equal(m.quality,'KNOWN',JSON.stringify(m));assert.ok((m.data as any).candidates.some((r:any)=>r.mint===address));}
 const unresolved=derive(RAW,{chain:'solana',address:'HKh5uh37FyRhRbDPcmPCoTcfByRLdY65RFZj9AvZpump'});assert.equal(unresolved.quality,'MISSING');assert.equal((unresolved.data as any).denominatorIdentified,false);
});
test('complete-panel positive ratio uses exact integer fractions; uncertainty is only removable when output invariant',()=>{
 assert.deepEqual(a13ParticipationRatio([{mint:'a',delta:3},{mint:'b',delta:2}],'a',['a','b'],[],true,0).share,{numerator:'3',denominator:'5'});
 assert.throws(()=>a13ParticipationRatio([{mint:'a',delta:0},{mint:'b',delta:1}],'a',['a'],['b'],false,0),/MEMBERSHIP_CAN_CHANGE/);
 assert.throws(()=>a13ParticipationRatio([{mint:'a',delta:0}],'a',['a'],[],false,1),/MATERIAL_IDENTITY_OUTSIDE_FRAME/);
});
test('raw source and excerpt fields are checked independently of producer labels',()=>{
 const c=decodeA13ParticipationCapture(RAW,CUT),q=reconstructA13Qualification(c,CUT);assert.equal(q.review.candidateSet.complete,false);
 const id=c.qualification.sourceRecords[JSON.parse(c.decodedRecords.find(r=>r.id===c.qualification.packetRecordId)!.raw).sources[0].fullLocalSourceRef]!;
 const m=derive(mutate(id,raw=>raw+' '));assert.equal(m.quality,'MISSING');assert.match(m.reasonCode,/QUALIFICATION_SOURCE_HASH/);
 const bad=derive(mutate(c.qualification.reviewRecordId,raw=>{const j=JSON.parse(raw);j.decisions[0].association.citations[0].quote='manufactured reward quote';return JSON.stringify(j);}));assert.equal(bad.quality,'MISSING');assert.match(bad.reasonCode,/QUALIFICATION_CITATION/);
});
test('bounded DEFLATE requires exact full consumption, original hashes, no orphan or missing record',()=>{
 const c=JSON.parse(RAW) as A13ParticipationCapture;c.records[0]!.data=Buffer.concat([Buffer.from(c.records[0]!.data,'base64'),Buffer.from('trailing')]).toString('base64');assert.throws(()=>decodeA13ParticipationCapture(JSON.stringify(c),CUT),/DEFLATE_TRAILING/);
 const bad=JSON.parse(RAW) as A13ParticipationCapture;bad.records[0]!.sha256='0'.repeat(64);assert.throws(()=>decodeA13ParticipationCapture(JSON.stringify(bad),CUT),/HASH_OR_UTF8/);
 const missing=JSON.parse(RAW);missing.records.pop();assert.throws(()=>decodeA13ParticipationCapture(JSON.stringify(missing),CUT),/MISSING_OR_ORPHAN/);
});
test('file importer rejects symlinks and outside-frame target before live acquisition',()=>{
 const dir=mkdtempSync(join(tmpdir(),'a13-import-'));try{const file=join(dir,'capture.json');writeFileSync(file,RAW);symlinkSync(file,join(dir,'link'));assert.throws(()=>loadA13ParticipationCapture(join(dir,'link'),TOKEN,CUT),/SOURCE_FILE/);assert.throws(()=>loadA13ParticipationCapture(file,{chain:'solana',address:'11111111111111111111111111111111'},CUT),/TOKEN_OUTSIDE_FRAME/);assert.throws(()=>loadA13ParticipationCapture(file,TOKEN,'2026-11-01T00:00:00.000Z'),/SOURCE_CLOCK/);}finally{rmSync(dir,{recursive:true,force:true});}
});

type Disposition='MEMBER'|'NON_MEMBER'|'UNRESOLVED';
function judgment(dispositions:Disposition[],complete:boolean,extras:unknown[]=[]){return{decisions:dispositions.map((disposition,i)=>({tokenKey:`solana:${['a','b','c'][i]}`,disposition})),candidateSet:{complete},additionalMaterialIdentities:extras};}
function ratioFromJudgments(native:ReturnType<typeof judgment>,review:ReturnType<typeof judgment>,deltas:number[]){
 const closure=a13QualificationClosure(native,review,['solana:a','solana:b','solana:c']);
 return a13ParticipationRatio(deltas.map((delta,i)=>({mint:['a','b','c'][i]!,delta})),'a',closure.acceptedTokenKeys.map(k=>k.slice(7)),closure.unresolvedTokenKeys,closure.qualificationComplete,closure.additionalMaterialIdentities);
}
test('asymmetric qualification completeness cannot omit either judgment unresolved positive-growth candidates',()=>{
 for(const [native,review] of [
  [judgment(['MEMBER','UNRESOLVED','UNRESOLVED'],false),judgment(['MEMBER','MEMBER','MEMBER'],true)],
  [judgment(['MEMBER','MEMBER','MEMBER'],true),judgment(['MEMBER','UNRESOLVED','UNRESOLVED'],false)]
 ]){
  const closure=a13QualificationClosure(native!,review!,['solana:a','solana:b','solana:c']);assert.equal(closure.qualificationComplete,false);assert.deepEqual(closure.acceptedTokenKeys,['solana:a']);assert.deepEqual(closure.unresolvedTokenKeys,['solana:b','solana:c']);
  assert.throws(()=>ratioFromJudgments(native!,review!,[3,7,11]),/MEMBERSHIP_CAN_CHANGE_DENOMINATOR/);
  const zero=ratioFromJudgments(native!,review!,[0,-1,0]);assert.equal(zero.share,null);assert.equal(zero.denominatorPositiveGrowth,'0');assert.equal(zero.identification,'FINITE_FRAME_ZERO_POSITIVE_GROWTH_INVARIANT');assert.deepEqual(zero.unresolvedTokenKeys,['solana:b','solana:c']);
 }
});
test('two complete flags do not close conflicting membership sets or hide additional material identities',()=>{
 const native=judgment(['MEMBER','NON_MEMBER','MEMBER'],true),review=judgment(['MEMBER','MEMBER','MEMBER'],true);
 const closure=a13QualificationClosure(native,review,['solana:a','solana:b','solana:c']);assert.equal(closure.qualificationComplete,false);assert.deepEqual(closure.unresolvedTokenKeys,['solana:b']);assert.throws(()=>ratioFromJudgments(native,review,[3,7,11]),/MEMBERSHIP_CAN_CHANGE_DENOMINATOR/);
 for(const extraSide of ['native','review']){
  const n=judgment(['MEMBER','MEMBER','MEMBER'],true,extraSide==='native'?[{tokenKey:'solana:additional'}]:[]),r=judgment(['MEMBER','MEMBER','MEMBER'],true,extraSide==='review'?[{tokenKey:'solana:additional'}]:[]);
  const c=a13QualificationClosure(n,r,['solana:a','solana:b','solana:c']);assert.equal(c.qualificationComplete,false);assert.equal(c.additionalMaterialIdentities,1);
  for(const deltas of [[3,7,11],[0,0,0]])assert.throws(()=>ratioFromJudgments(n,r,deltas),/MATERIAL_IDENTITY_OUTSIDE_FRAME/);
 }
 assert.throws(()=>a13ParticipationRatio([{mint:'a',delta:1}],'a',['a'],[],true,1),/MATERIAL_IDENTITY_OUTSIDE_FRAME/);
});
