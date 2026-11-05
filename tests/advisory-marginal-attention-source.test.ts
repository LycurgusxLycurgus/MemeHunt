import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import type {EvidenceRecord} from '../src/domain/contracts.js';
import type {AdvisoryMetric} from '../src/domain/advisory-contracts.js';
import {A26_PROFILE,A26_SOURCE_ID,A26_SOURCE_PREFIX,A26_ADAPTER} from '../src/providers/advisory-buyer-post-import.js';
import {A27_SOURCE_ID,A27_SOURCE_PREFIX,A27_CAPTURE_ID,A27_NATIVE_MANIFEST_ID,A27_ADAPTER,A27_PURPOSE,A27_COMPARISON,a27MarginalScope,projectA27MarginalSource,validateA27MarginalSource,deriveA27MarginalComponents} from '../src/providers/advisory-marginal-attention-source.js';
import {a27MarginalDescriptor,validateA27MarginalCore,validateA27MarginalBundle} from '../src/app/a27-marginal.js';
const fixture=JSON.parse(gunzipSync(readFileSync('tests/fixtures/a26-historical-social-and-native-header.json.gz')).toString('utf8'));
const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},cutoff='2026-11-04T00:00:00.000Z',sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
/** Genuine compact social/header bytes plus explicitly invalid native placeholders: mapping tests only. */
function incompleteWire(){
 const evidence:EvidenceRecord[]=[],rawArtifacts:Record<string,string>={};
 const add=(id:string,raw:string,at:string,scope:Record<string,unknown>)=>{rawArtifacts[id]=raw;evidence.push({id,sourceId:A27_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:A27_ADAPTER,contentHash:sha(raw),availableAt:at,retrievedAt:at,scope});};
 add(A27_CAPTURE_ID,fixture.manifestRaw,fixture.manifest.captureCreatedAt,a27MarginalScope('CAPTURE'));add(A27_NATIVE_MANIFEST_ID,fixture.nativeManifestRaw,fixture.manifest.captureCreatedAt,a27MarginalScope('NATIVE_MANIFEST'));
 const native=JSON.parse(fixture.nativeManifestRaw);for(const r of native.receipts)add(A27_SOURCE_PREFIX+'native-'+r.id,fixture.nativeSamples[r.id]??'CONSTRUCTED_INVALID_NATIVE_PLACEHOLDER:'+r.id,r.retrievedAt,{request:r.request});
 for(const r of fixture.manifest.social.records)add(A27_SOURCE_PREFIX+'social-'+r.originalEvidence.id,fixture.social[r.originalEvidence.id].raw,r.originalEvidence.retrievedAt,{originalId:r.originalEvidence.id});
 return{evidence,rawArtifacts};
}
function constructedSource():AdvisoryMetric{
 const firstObservedBuyers=['2026-10-26T02:00:00.000Z','2026-10-26T03:59:59.999Z','2026-10-26T04:00:00.000Z','2026-10-26T05:59:59.999Z','2026-10-26T06:00:00.000Z'].map((at,i)=>({user:'constructed-user-'+i,at,signature:'constructed-native-'+i,slot:i,transactionIndex:0,coreQuoteAtomic:'1',baselineSell:i===0,baselineSubThresholdBuy:i===1}));
 const start=Date.parse(A26_PROFILE.foregroundStart),hourlyFirstBuyerCounts=Array.from({length:6},(_,i)=>({start:new Date(start+i*3600000).toISOString(),end:new Date(start+(i+1)*3600000).toISOString(),complete:true,newMeaningfulBuyerCount:firstObservedBuyers.filter(b=>Date.parse(b.at)>=start+i*3600000&&Date.parse(b.at)<start+(i+1)*3600000).length}));
 return{id:'A26',quality:'KNOWN',unit:'constructed pure input only; not native source authority',reasonCode:'CONSTRUCTED_TEST',evidenceIds:[],data:{method:'historical-first-observed-buyer-post-components-v1',status:'COMPLETE',complete:true,completeBuyerHistory:true,completeObservedPostSubset:true,baselineA16Promoted:false,range:{start:A26_PROFILE.historyStart,baselineEnd:A26_PROFILE.foregroundStart,end:A26_PROFILE.end},foreground:{start:A26_PROFILE.foregroundStart,end:A26_PROFILE.end},baseline:{complete:true,start:A26_PROFILE.historyStart,end:A26_PROFILE.foregroundStart},qualifiedPosts:0,observedPostSubset:{complete:true,rawForegroundPosts:[],originalLogicalSourceRoles:['advisory-executor-source-example']},buyers:firstObservedBuyers.length,firstObservedBuyers,hourlyFirstBuyerCounts,pool:'constructed-pool',identityUnit:'decoded user address',newBuyerRule:'first qualifying BUY in complete12h',meaningfulThreshold:{referenceAtomic:'10000000'},programAccounts:{accounts:[]},nativeSourceCoverage:{complete:true},pairedClocks:[],fx:{identity:{sourceId:A26_SOURCE_PREFIX+'native-fx-identity-bank'}},crossSourceCoherence:{complete:true},sourceAuthentication:'constructed DTO only'}};
}
test('all398 new source identities map bijectively while raw strings, body scopes and clocks remain unchanged',()=>{
 const input=incompleteWire(),result=projectA27MarginalSource(token,cutoff,input.evidence,input.rawArtifacts);assert.equal(result.temporaryEvidence.length,398);assert.equal(Object.keys(result.temporaryRawArtifacts).length,398);assert.equal(result.manifest.captureCreatedAt,fixture.manifest.captureCreatedAt);
 for(const e of input.evidence){const oldId=A26_SOURCE_PREFIX+e.id.slice(A27_SOURCE_PREFIX.length),projected=result.temporaryEvidence.find(x=>x.id===oldId)!;assert.equal(projected.sourceId,A26_SOURCE_ID);assert.equal(projected.adapterVersion,A26_ADAPTER);assert.equal(projected.contentHash,e.contentHash);assert.equal(projected.retrievedAt,e.retrievedAt);assert.equal(projected.availableAt,e.availableAt);assert.equal(result.temporaryRawArtifacts[oldId],input.rawArtifacts[e.id]);if(![A27_CAPTURE_ID,A27_NATIVE_MANIFEST_ID].includes(e.id))assert.deepEqual(projected.scope,e.scope);}
 assert.equal(result.temporaryEvidence.filter(e=>e.id.startsWith(A26_SOURCE_PREFIX+'native-')&&e.id!==A26_SOURCE_PREFIX+'native-manifest').length,375);
});
test('source-only, adapter-only, prefix-only and mixed old identities fail before they can be normalized into authority',()=>{
 for(const edit of [(e:EvidenceRecord)=>{e.sourceId='ordinary-source';},(e:EvidenceRecord)=>{e.adapterVersion='ordinary-v1';},(e:EvidenceRecord)=>{e.id='ordinary-id';}]){const input=incompleteWire();edit(input.evidence[0]!);assert.throws(()=>projectA27MarginalSource(token,cutoff,input.evidence,input.rawArtifacts),/OWNERSHIP_IDENTITY/);}
 for(const edit of [(e:EvidenceRecord)=>{e.sourceId=A26_SOURCE_ID;},(e:EvidenceRecord)=>{e.adapterVersion=A26_ADAPTER;},(e:EvidenceRecord)=>{e.id=A26_SOURCE_PREFIX+'capture';}]){const input=incompleteWire();edit(input.evidence[0]!);assert.throws(()=>projectA27MarginalSource(token,cutoff,input.evidence,input.rawArtifacts),/COMPETING_SOURCE_OWNERSHIP/);}
 const input=incompleteWire();input.rawArtifacts[A26_SOURCE_PREFIX+'orphan']='x';assert.throws(()=>projectA27MarginalSource(token,cutoff,input.evidence,input.rawArtifacts),/COMPETING_SOURCE_OWNERSHIP/);
});
test('metadata purpose/scope laundering and native or social scope changes are rejected before internal rewrite',()=>{
 for(const id of [A27_CAPTURE_ID,A27_NATIVE_MANIFEST_ID,A27_SOURCE_PREFIX+'native-c5-genesis',A27_SOURCE_PREFIX+'social-advisory-executor-capture']){const input=incompleteWire();input.evidence.find(e=>e.id===id)!.scope={method:A26_ADAPTER,purpose:'HISTORICAL_FIRST_BUYER_POST_COMPONENTS'};assert.throws(()=>projectA27MarginalSource(token,cutoff,input.evidence,input.rawArtifacts),/EVIDENCE_HASH_SCOPE_OR_CLOCK/);}
});
test('missing, extra, duplicate, hash and clock changes never receive a mapped valid source catalog',()=>{
 const missing=incompleteWire();delete missing.rawArtifacts[A27_SOURCE_PREFIX+'native-c5-genesis'];assert.throws(()=>projectA27MarginalSource(token,cutoff,missing.evidence,missing.rawArtifacts),/SOURCE_MEMBERSHIP/);
 const extra=incompleteWire();extra.rawArtifacts[A27_SOURCE_PREFIX+'native-unknown']='x';assert.throws(()=>projectA27MarginalSource(token,cutoff,extra.evidence,extra.rawArtifacts),/SOURCE_MEMBERSHIP/);
 const duplicate=incompleteWire();duplicate.evidence.push(duplicate.evidence[0]!);assert.throws(()=>projectA27MarginalSource(token,cutoff,duplicate.evidence,duplicate.rawArtifacts),/SOURCE_MEMBERSHIP/);
 for(const edit of [(e:EvidenceRecord)=>{e.contentHash='0'.repeat(64);},(e:EvidenceRecord)=>{e.availableAt='2026-11-04T01:00:00.000Z';},(e:EvidenceRecord)=>{e.accessMode='PUBLIC_API';}]){const input=incompleteWire();edit(input.evidence[2]!);assert.throws(()=>projectA27MarginalSource(token,cutoff,input.evidence,input.rawArtifacts),/OWNERSHIP_IDENTITY|EVIDENCE_HASH_SCOPE_OR_CLOCK/);}
});
test('mapped incomplete native placeholders are not metric authority or a validated storage allowance',()=>{
 const input=incompleteWire();assert.throws(()=>validateA27MarginalSource(token,cutoff,input.evidence,input.rawArtifacts),/A26_BUYER_POST_SOURCE_NATIVE_SOURCE_HASH|A26_BUYER_POST_SOURCE_NATIVE_ARCHIVE/);
 const proof={method:'advisory-provenance-v69',token,cutoff,a27Marginal:a27MarginalDescriptor()};assert.throws(()=>validateA27MarginalCore({token,cutoff,...input},proof),/A26_BUYER_POST_SOURCE_NATIVE_SOURCE_HASH|A26_BUYER_POST_SOURCE_NATIVE_ARCHIVE/);
});
test('fixed equal half-open bins preserve signed deltas, all components and undefined growth ratio without nesting A26 metric',()=>{
 const source=constructedSource(),metric=deriveA27MarginalComponents(source,[A27_CAPTURE_ID]),d=metric.data as any;assert.equal(metric.id,'A27');assert.equal(metric.quality,'KNOWN');assert.equal(d.comparison,A27_COMPARISON);assert.equal(d.binSeconds,7200);assert.deepEqual(d.buyerBins,[2,2,1]);assert.deepEqual(d.postBins,[0,0,0]);assert.equal(d.buyerChange,-1);assert.equal(d.postChange,0);assert.equal(d.marginalEfficiency,null);assert.equal(d.ratioStatus,'UNDEFINED_NONPOSITIVE_POST_CHANGE');assert.equal(d.bins.length,3);assert.equal(d.bins[0].start,'2026-10-26T02:00:00.000Z');assert.equal(d.bins[2].end,'2026-10-26T08:00:00.000Z');assert.equal(d.firstObservedBuyers.length,5);assert.equal(d.fx.identity.sourceId,A27_SOURCE_PREFIX+'native-fx-identity-bank');assert.equal(d.baselineA16Promoted,false);assert.equal(JSON.stringify(d).includes(A26_SOURCE_PREFIX),false);assert.equal('sourceMetric'in d,false);assert.equal(d.id,undefined);
});
test('incomplete buyer/post components, nonempty posts, duplicates, out-of-range times and row/hour mismatches cannot use a zero denominator',()=>{
 for(const edit of [(m:any)=>{m.quality='MISSING';},(m:any)=>{m.data.completeBuyerHistory=false;},(m:any)=>{m.data.completeObservedPostSubset=false;},(m:any)=>{m.data.qualifiedPosts=null;},(m:any)=>{m.data.observedPostSubset.rawForegroundPosts=[{publishedAt:'2026-10-26T03:00:00.000Z'}];},(m:any)=>{m.data.firstObservedBuyers[1].user=m.data.firstObservedBuyers[0].user;},(m:any)=>{m.data.firstObservedBuyers[0].at=A26_PROFILE.end;},(m:any)=>{m.data.firstObservedBuyers[0].at='invalid';},(m:any)=>{m.data.hourlyFirstBuyerCounts[0].newMeaningfulBuyerCount++;},(m:any)=>{m.data.hourlyFirstBuyerCounts[1].complete=false;}]){const source=constructedSource();edit(source);assert.throws(()=>deriveA27MarginalComponents(source,[]),/A27_MARGINAL_/);}
});
test('new strict descriptor is A27-only and missing/downgraded/orphan source proofs receive no authority',()=>{
 assert.deepEqual(a27MarginalDescriptor(),{method:A27_ADAPTER,purpose:A27_PURPOSE,captureId:A27_CAPTURE_ID,comparison:A27_COMPARISON,binSeconds:7200});assert.equal(validateA27MarginalCore({token,cutoff,evidence:[],rawArtifacts:{}},{method:'advisory-provenance-v68'}),undefined);assert.throws(()=>validateA27MarginalCore({token,cutoff,evidence:[],rawArtifacts:{}},{method:'advisory-provenance-v69'}),/PROOF_INVALID/);
 const input=incompleteWire();assert.throws(()=>validateA27MarginalCore({token,cutoff,...input},{method:'advisory-provenance-v68',token,cutoff,a27Marginal:a27MarginalDescriptor()}),/PROOF_INVALID/);
 assert.throws(()=>validateA27MarginalBundle({token,cutoff,...input,rawArtifacts:{...input.rawArtifacts,'advisory-derivation':'not-json'}} as any,true),/PROOF_INVALID/);
});
