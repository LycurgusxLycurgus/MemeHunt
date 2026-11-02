import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import type {AdvisoryMetric} from '../src/domain/advisory-contracts.js';
import {A26_PROFILE,A26_CAPTURE_ID,A26_NATIVE_MANIFEST_ID,A26_NATIVE_MANIFEST_HASH,A26_SOURCE_ID,A26_ADAPTER,A26_PURPOSE,decodeA26Manifest,loadA26BuyerPostCapture,projectA26BuyerPostCapture} from '../src/providers/advisory-buyer-post-import.js';
import {validateA26ObservedPostSubset,requireA26EmptyRawForeground,deriveA26BuyerPostComponents,validateA26BuyerPostSource} from '../src/providers/advisory-buyer-post-source.js';
import {a26BuyerPostDescriptor,validateA26BuyerPostCore,validateA26BuyerPostBundle} from '../src/app/a26-buyer-post.js';
// Genuine social/native header preimages, NOT a complete native source or new live observation.
const fixture=JSON.parse(gunzipSync(readFileSync('tests/fixtures/a26-historical-social-and-native-header.json.gz')).toString('utf8'));
const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},cutoff='2026-11-04T00:00:00.000Z';
const social=()=>validateA26ObservedPostSubset(token,fixture.manifest.social.originalCutoff,fixture.social);
function constructedNative():AdvisoryMetric{
 const windows=Array.from({length:6},(_,i)=>({start:new Date(Date.parse(A26_PROFILE.foregroundStart)+i*3600000).toISOString(),end:new Date(Date.parse(A26_PROFILE.foregroundStart)+(i+1)*3600000).toISOString(),complete:true,newMeaningfulBuyers:i===0?[{user:'constructed-address-one',signature:'constructed-signature',slot:1,transactionIndex:0,at:'2026-10-26T02:30:00.000Z',coreQuoteAtomic:'100',baselineSell:true,baselineSubThresholdBuy:true}]:[],newMeaningfulBuyerCount:i===0?1:0}));
 return{id:'A30',quality:'KNOWN',unit:'constructed pure-composer input only',reasonCode:'CONSTRUCTED_TEST',evidenceIds:[],data:{method:'complete-pool-baseline-demand-fx-cells-v1',complete:true,range:{start:A26_PROFILE.historyStart,baselineEnd:A26_PROFILE.foregroundStart,end:A26_PROFILE.end},baseline:{complete:true,start:A26_PROFILE.historyStart,end:A26_PROFILE.foregroundStart,meaningfulBuyers:5,hours:[]},windows,fx:{sourceCoverage:{completeFxSource:true},requiredQueryTransactions:1,identifiedQueryTransactions:1},crossSourceCoherence:{complete:true},pool:'constructed-pool',identityUnit:'decoded user account',newBuyerRule:'constructed per-leg threshold',meaningfulThreshold:{referenceAtomic:'10000000'},programAccounts:{accounts:[]},sourceCoverage:{complete:true},pairedClocks:[],sourceAuthentication:'constructed pure DTO; not source authority'}};
}
test('genuine complete retained source closure proves only the matched raw-empty foreground, with historical dispositions',()=>{
 const s=social();assert.equal(s.complete,true);assert.equal(s.qualifiedPosts,0);assert.deepEqual(s.rawForegroundPosts,[]);assert.equal(s.baselineA16Promoted,false);assert.equal(s.allPostDispositions.length,11);assert.equal(s.pageDispositions.length,7);assert.equal(s.originalSocialCutoff,'2026-10-26T08:26:30.786Z');assert.deepEqual(s.originalSocialWindow,{start:'2026-10-25T08:24:15.121Z',end:'2026-10-26T08:24:15.121Z'});assert.ok(s.allPostDispositions.every(p=>Date.parse(p.publishedAt)<Date.parse(A26_PROFILE.historyStart)));assert.equal(s.qualificationRule,'EMPTY_RAW_RETAINED_FOREGROUND_IMPLIES_ZERO_UNDER_EVERY_A16_QUALIFICATION');
});
test('every required original social byte, clock, source catalog and cutoff remains bound',()=>{
 const changed=structuredClone(fixture.social);changed['advisory-executor-capture'].raw+='\n';assert.throws(()=>validateA26ObservedPostSubset(token,fixture.manifest.social.originalCutoff,changed),/SOCIAL_HASH_OR_CLOCK/);
 const missing=structuredClone(fixture.social);delete missing['advisory-executor-acquisition'];assert.throws(()=>validateA26ObservedPostSubset(token,fixture.manifest.social.originalCutoff,missing),/SOCIAL_MEMBERSHIP/);
 const clock=structuredClone(fixture.social);clock['advisory-executor-capture'].evidence.availableAt='2026-11-02T00:00:00.000Z';assert.throws(()=>validateA26ObservedPostSubset(token,fixture.manifest.social.originalCutoff,clock),/SOCIAL_HASH_OR_CLOCK/);
 assert.throws(()=>validateA26ObservedPostSubset(token,'2026-10-26T08:26:31.786Z',fixture.social),/ORIGINAL_SOCIAL_PREIMAGES/);
});
test('positive retained foreground cannot borrow SOCIAL qualification as A16, and half-open boundaries and missing dates are explicit',()=>{
 assert.deepEqual(requireA26EmptyRawForeground([{publishedAt:'2026-10-26T01:59:59.999Z'},{publishedAt:A26_PROFILE.end}]),[]);
 for(const at of [A26_PROFILE.foregroundStart,'2026-10-26T07:59:59.999Z'])assert.throws(()=>requireA26EmptyRawForeground([{publishedAt:at}]),/POSITIVE_POST_QUALIFICATION_UNSUPPORTED/);
 for(const at of [null,'invalid'])assert.throws(()=>requireA26EmptyRawForeground([{publishedAt:at}]),/POST_TIME_REQUIRED/);
});
test('pure projection preserves measured buyer rows, hourly counts and undefined ratio rather than scalar zero or conversion probability',()=>{
 const m=deriveA26BuyerPostComponents(constructedNative(),social(),['constructed-proof']),d=m.data as any;assert.equal(m.id,'A26');assert.equal(m.quality,'KNOWN');assert.equal(d.completeBuyerHistory,true);assert.equal(d.completeObservedPostSubset,true);assert.equal(d.buyers,1);assert.equal(d.qualifiedPosts,0);assert.equal(d.buyersPerPost,null);assert.equal(d.ratioStatus,'UNDEFINED_ZERO_POST_DENOMINATOR');assert.deepEqual(d.hourlyFirstBuyerCounts.map((h:any)=>h.newMeaningfulBuyerCount),[1,0,0,0,0,0]);assert.equal(d.firstObservedBuyers[0].baselineSell,true);assert.equal(d.firstObservedBuyers[0].baselineSubThresholdBuy,true);assert.equal(d.baselineA16Promoted,false);
});
test('zero post denominator never completes a missing numerator, missing FX, repeated first buyer or unaligned native hour',()=>{
 for(const edit of [(m:any)=>{m.quality='MISSING';},(m:any)=>{m.data.complete=false;},(m:any)=>{m.data.fx.identifiedQueryTransactions=0;},(m:any)=>{m.data.crossSourceCoherence.complete=false;},(m:any)=>{m.data.windows[1].complete=false;},(m:any)=>{m.data.windows[0].start=A26_PROFILE.historyStart;},(m:any)=>{m.data.windows[1].newMeaningfulBuyers=[{...m.data.windows[0].newMeaningfulBuyers[0],at:'2026-10-26T03:30:00.000Z'}];m.data.windows[1].newMeaningfulBuyerCount=1;}]){const m=constructedNative();edit(m);assert.throws(()=>deriveA26BuyerPostComponents(m,social(),[]),/A26_BUYER_POST_/);}
});
test('outer profile/native manifest identity and original social metadata are strict, never cached component authority',()=>{
 const m=decodeA26Manifest(fixture.manifestRaw,cutoff);assert.deepEqual(m.profile,A26_PROFILE);assert.equal(m.social.records.length,21);assert.equal(m.nativeManifest.sha256,A26_NATIVE_MANIFEST_HASH);
 for(const edit of [(c:any)=>{c.profile.foregroundStart='2026-10-26T03:00:00.000Z';},(c:any)=>{c.nativeManifest.sha256='0'.repeat(64);},(c:any)=>{c.social.records.push(c.social.records[0]);},(c:any)=>{c.social.records[0].file='../escape';},(c:any)=>{c.buyers=1225;}]){const m=structuredClone(fixture.manifest);edit(m);assert.throws(()=>decodeA26Manifest(JSON.stringify(m),cutoff),/A26_BUYER_POST_SOURCE_/);}
 assert.throws(()=>decodeA26Manifest(fixture.manifestRaw,'2026-11-01T00:00:00.000Z'),/CLOCK_TOKEN_OR_NATIVE_IDENTITY/);
});
test('genuine compact header fixture is insufficient for native components and receives no source allowance',()=>{
 const raw={[A26_CAPTURE_ID]:fixture.manifestRaw,[A26_NATIVE_MANIFEST_ID]:fixture.nativeManifestRaw};assert.throws(()=>projectA26BuyerPostCapture(token,cutoff,[],raw),/MISSING_NATIVE/);assert.throws(()=>validateA26BuyerPostSource(token,cutoff,[],raw),/MISSING_NATIVE/);
 assert.deepEqual(a26BuyerPostDescriptor(),{method:A26_ADAPTER,purpose:A26_PURPOSE,captureId:A26_CAPTURE_ID});assert.equal(validateA26BuyerPostCore({token,cutoff,evidence:[],rawArtifacts:{}},{method:'advisory-provenance-v67'}),undefined);assert.throws(()=>validateA26BuyerPostCore({token,cutoff,evidence:[],rawArtifacts:{}},{method:'advisory-provenance-v68'}),/PROOF_INVALID/);
 assert.throws(()=>validateA26BuyerPostBundle({token,cutoff,evidence:[{id:A26_CAPTURE_ID,sourceId:A26_SOURCE_ID,adapterVersion:A26_ADAPTER}],rawArtifacts:{}} as any,true),/PROOF_INVALID/);
});
test('strict nested filesystem import refuses foreign files, symlink roots/directories and cross-token capture before native collection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'a26-buyer-post-'));try{
  const root=join(dir,'capture');mkdirSync(root);mkdirSync(join(root,'native'));mkdirSync(join(root,'social'));writeFileSync(join(root,'capture.json'),fixture.manifestRaw);writeFileSync(join(root,'native/capture.json'),fixture.nativeManifestRaw);
  symlinkSync(root,join(dir,'root-link'));assert.throws(()=>loadA26BuyerPostCapture(join(dir,'root-link'),token,cutoff),/DIRECTORY/);
  writeFileSync(join(root,'foreign'),'unexpected');assert.throws(()=>loadA26BuyerPostCapture(root,token,cutoff),/FOREIGN_FILE/);rmSync(join(root,'foreign'));
  assert.throws(()=>loadA26BuyerPostCapture(root,{chain:'solana',address:'11111111111111111111111111111111'},cutoff),/TOKEN/);
  rmSync(join(root,'native'),{recursive:true});symlinkSync(dir,join(root,'native'));assert.throws(()=>loadA26BuyerPostCapture(root,token,cutoff),/DIRECTORY/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
