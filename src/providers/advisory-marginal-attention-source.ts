import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import type {TokenRef,EvidenceRecord} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {A26_SOURCE_ID,A26_SOURCE_PREFIX,A26_ADAPTER,A26_PROFILE,A26_NATIVE_STORED_BYTES,A26_MANIFEST_BYTES,A26_CAPTURE_ID,A26_NATIVE_MANIFEST_ID,a26BuyerPostScope,decodeA26Manifest,loadA26BuyerPostCapture,type A26Manifest,type A26WireRecord} from './advisory-buyer-post-import.js';
import {validateA26BuyerPostSource} from './advisory-buyer-post-source.js';
import {A30_SOURCE_ID,A30_SOURCE_PREFIX,A30_SOURCE_ADAPTER} from './advisory-demand-fx-source.js';
export const A27_SOURCE_ID='advisory-a27-marginal' as const,A27_SOURCE_PREFIX=A27_SOURCE_ID+'-';
export const A27_ADAPTER='a27-historical-marginal-efficiency-source-v1' as const,A27_PURPOSE='HISTORICAL_MARGINAL_ATTENTION_EFFICIENCY_COMPONENTS' as const;
export const A27_CAPTURE_ID=A27_SOURCE_PREFIX+'capture',A27_NATIVE_MANIFEST_ID=A27_SOURCE_PREFIX+'native-manifest',A27_NATIVE_STORED_BYTES=A26_NATIVE_STORED_BYTES;
export const A27_COMPONENT_METHOD='historical-marginal-attention-efficiency-components-v1' as const,A27_COMPARISON='FIRST_VERSUS_THIRD_EQUAL_2H_BINS' as const,A27_BIN_SECONDS=7200;
export const a27MarginalScope=(role:'CAPTURE'|'NATIVE_MANIFEST')=>({method:A27_ADAPTER,purpose:A27_PURPOSE,role});
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const fail=(code:string):never=>{throw Error('A27_MARGINAL_'+code);};
function check(v:unknown,code:string):asserts v{if(!v)fail(code);}
const to27=(id:string)=>{check(id.startsWith(A26_SOURCE_PREFIX),'INTERNAL_ROLE');return A27_SOURCE_PREFIX+id.slice(A26_SOURCE_PREFIX.length);};
const to26=(id:string)=>{check(id.startsWith(A27_SOURCE_PREFIX),'EXTERNAL_ROLE');return A26_SOURCE_PREFIX+id.slice(A27_SOURCE_PREFIX.length);};
const owns=(e:EvidenceRecord)=>e.sourceId===A27_SOURCE_ID||e.id.startsWith(A27_SOURCE_PREFIX)||e.adapterVersion===A27_ADAPTER;
const oldOwns=(e:EvidenceRecord)=>e.sourceId===A26_SOURCE_ID||e.adapterVersion===A26_ADAPTER||e.id.startsWith(A26_SOURCE_PREFIX)||e.sourceId===A30_SOURCE_ID||e.adapterVersion===A30_SOURCE_ADAPTER||e.id.startsWith(A30_SOURCE_PREFIX);
/** Reuse the retained container format; the new external descriptor grants A27 authority only. */
export function loadA27MarginalCapture(directory:string,token:TokenRef,cutoff:string):{manifest:A26Manifest;records:A26WireRecord[];nativeIds:Set<string>}{
 const original=loadA26BuyerPostCapture(directory,token,cutoff);
 const records=original.records.map(r=>({...r,id:to27(r.id),scope:r.id===A26_CAPTURE_ID?a27MarginalScope('CAPTURE'):r.id===A26_NATIVE_MANIFEST_ID?a27MarginalScope('NATIVE_MANIFEST'):r.scope}));
 return{manifest:original.manifest,records,nativeIds:new Set([...original.nativeIds].map(to27))};
}
/** This projection alone grants no storage or metric authority; full source reconstruction follows it. */
export function projectA27MarginalSource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){
 check(!evidence.some(oldOwns)&&!Object.keys(rawArtifacts).some(id=>id.startsWith(A26_SOURCE_PREFIX)||id.startsWith(A30_SOURCE_PREFIX)),'COMPETING_SOURCE_OWNERSHIP');
 const owned=evidence.filter(owns),rawIds=Object.keys(rawArtifacts).filter(id=>id.startsWith(A27_SOURCE_PREFIX));
 for(const e of owned)check(e.sourceId===A27_SOURCE_ID&&e.adapterVersion===A27_ADAPTER&&e.id.startsWith(A27_SOURCE_PREFIX)&&e.sourceType==='HISTORICAL_RECEIPT'&&e.accessMode==='USER_IMPORT','OWNERSHIP_IDENTITY');
 const capture=rawArtifacts[A27_CAPTURE_ID];check(typeof capture==='string','CAPTURE_REQUIRED');const manifest=decodeA26Manifest(capture,cutoff);check(same(manifest.token,token),'TOKEN');
 const nativeRaw=rawArtifacts[A27_NATIVE_MANIFEST_ID];check(typeof nativeRaw==='string'&&Buffer.byteLength(nativeRaw)<=A26_MANIFEST_BYTES&&Buffer.byteLength(nativeRaw)===manifest.nativeManifest.bytes&&sha(nativeRaw)===manifest.nativeManifest.sha256,'NATIVE_MANIFEST_HASH');
 const originalNative=JSON.parse(nativeRaw) as {receipts:Array<{id:string;retrievedAt:string;request:unknown}>};check(Array.isArray(originalNative.receipts),'NATIVE_MANIFEST');
 const expected=new Map<string,{scope:Record<string,unknown>;at:string}>([[A27_CAPTURE_ID,{scope:a27MarginalScope('CAPTURE'),at:manifest.captureCreatedAt}],[A27_NATIVE_MANIFEST_ID,{scope:a27MarginalScope('NATIVE_MANIFEST'),at:manifest.captureCreatedAt}]]);
 for(const r of originalNative.receipts){const id=A27_SOURCE_PREFIX+'native-'+r.id;check(!expected.has(id),'DUPLICATE_ROLE');expected.set(id,{scope:{request:r.request},at:r.retrievedAt});}
 for(const r of manifest.social.records){const id=A27_SOURCE_PREFIX+'social-'+r.originalEvidence.id;check(!expected.has(id),'DUPLICATE_ROLE');expected.set(id,{scope:{originalId:r.originalEvidence.id},at:r.originalEvidence.retrievedAt});}
 check(owned.length===expected.size&&new Set(owned.map(e=>e.id)).size===owned.length&&rawIds.length===expected.size&&rawIds.every(id=>expected.has(id)),'SOURCE_MEMBERSHIP');
 // All original externally supplied fields are checked before any internal identity/scope rewrite.
 for(const e of owned){const want=expected.get(e.id),raw=rawArtifacts[e.id];check(want&&typeof raw==='string'&&e.contentHash===sha(raw)&&e.availableAt===e.retrievedAt&&e.retrievedAt===want.at&&Date.parse(e.availableAt)<=Date.parse(cutoff)&&same(e.scope,want.scope),'EVIDENCE_HASH_SCOPE_OR_CLOCK');}
 const temporaryEvidence=owned.map(e=>({...e,id:to26(e.id),sourceId:A26_SOURCE_ID,adapterVersion:A26_ADAPTER,scope:e.id===A27_CAPTURE_ID?a26BuyerPostScope('CAPTURE'):e.id===A27_NATIVE_MANIFEST_ID?a26BuyerPostScope('NATIVE_MANIFEST'):e.scope}));
 const temporaryRawArtifacts:Record<string,string>={};for(const id of rawIds)temporaryRawArtifacts[to26(id)]=rawArtifacts[id]!;
 return{manifest,temporaryEvidence,temporaryRawArtifacts};
}
/** Pure regrouping for tests; only the full original-byte source validator below supplies authority. */
export function deriveA27MarginalComponents(source:AdvisoryMetric,evidenceIds:string[]):AdvisoryMetric{
 const d=source.data as any;
 check(source.id==='A26'&&source.quality==='KNOWN'&&d?.method==='historical-first-observed-buyer-post-components-v1'&&d.status==='COMPLETE'&&d.complete===true&&d.completeBuyerHistory===true&&d.completeObservedPostSubset===true&&d.baselineA16Promoted===false,'COMPLETE_SOURCE_COMPONENTS_REQUIRED');
 check(same(d.range,{start:A26_PROFILE.historyStart,baselineEnd:A26_PROFILE.foregroundStart,end:A26_PROFILE.end})&&same(d.foreground,{start:A26_PROFILE.foregroundStart,end:A26_PROFILE.end})&&d.baseline?.complete===true,'FIXED_SOURCE_RANGE');
 check(d.observedPostSubset?.complete===true&&d.qualifiedPosts===0&&Array.isArray(d.observedPostSubset.rawForegroundPosts)&&d.observedPostSubset.rawForegroundPosts.length===0,'COMPLETE_EMPTY_POST_SUBSET_REQUIRED');
 check(Array.isArray(d.firstObservedBuyers)&&d.buyers===d.firstObservedBuyers.length&&Array.isArray(d.hourlyFirstBuyerCounts)&&d.hourlyFirstBuyerCounts.length===6,'FIRST_BUYER_ROWS_REQUIRED');
 const start=Date.parse(A26_PROFILE.foregroundStart),end=Date.parse(A26_PROFILE.end),seen=new Set<string>(),buyerBins=[0,0,0],hours=[0,0,0,0,0,0];
 for(const row of d.firstObservedBuyers){const at=Date.parse(row.at);check(typeof row.user==='string'&&row.user.length>0&&!seen.has(row.user)&&Number.isFinite(at)&&at>=start&&at<end,'UNIQUE_BOUND_FIRST_BUYER');seen.add(row.user);buyerBins[Math.floor((at-start)/(A27_BIN_SECONDS*1000))]!++;hours[Math.floor((at-start)/3600000)]!++;}
 for(const [i,hour]of d.hourlyFirstBuyerCounts.entries())check(hour.complete===true&&hour.start===new Date(start+i*3600000).toISOString()&&hour.end===new Date(start+(i+1)*3600000).toISOString()&&Number.isSafeInteger(hour.newMeaningfulBuyerCount)&&hour.newMeaningfulBuyerCount===hours[i],'HOUR_ROW_RECONCILIATION');
 check(buyerBins.every((n,i)=>n===hours[2*i]!+hours[2*i+1]!), 'BIN_HOUR_RECONCILIATION');
 const postBins=[0,0,0],buyerChange=buyerBins[2]!-buyerBins[0]!,postChange=postBins[2]!-postBins[0]!;check(postChange<=0,'POSITIVE_POST_CHANGE_UNSUPPORTED');
 const bins=buyerBins.map((buyers,i)=>({start:new Date(start+i*A27_BIN_SECONDS*1000).toISOString(),end:new Date(start+(i+1)*A27_BIN_SECONDS*1000).toISOString(),interval:'[start,end)',firstObservedBuyers:buyers,qualifiedPosts:postBins[i]!,complete:true}));
 return{id:'A27',quality:'KNOWN',unit:'scoped-record',reasonCode:'HISTORICAL_MARGINAL_ATTENTION_COMPONENTS_MEASURED',evidenceIds:[...new Set(evidenceIds)],data:{method:A27_COMPONENT_METHOD,scope:'SIGNED_USER_POOL_FIRST_CHANGES_VS_RETAINED_OBSERVED_POST_BIN_CHANGES',status:'COMPLETE',complete:true,completeBuyerHistory:true,completeObservedPostSubset:true,baselineA16Promoted:false,range:d.range,foreground:d.foreground,baseline:d.baseline,pool:d.pool,comparison:A27_COMPARISON,binSeconds:A27_BIN_SECONDS,bins,buyerBins,postBins,first:{buyers:buyerBins[0],qualifiedPosts:postBins[0]},third:{buyers:buyerBins[2],qualifiedPosts:postBins[2]},buyerChange,postChange,marginalEfficiency:null,ratioStatus:'UNDEFINED_NONPOSITIVE_POST_CHANGE',firstObservedBuyers:d.firstObservedBuyers,hourlyFirstBuyerCounts:d.hourlyFirstBuyerCounts,identityUnit:d.identityUnit,newBuyerRule:d.newBuyerRule,meaningfulThreshold:d.meaningfulThreshold,programAccounts:d.programAccounts,observedPostSubset:d.observedPostSubset,nativeSourceCoverage:d.nativeSourceCoverage,pairedClocks:d.pairedClocks,fx:{...d.fx,...(d.fx?.identity?{identity:{...d.fx.identity,sourceId:A27_SOURCE_PREFIX+'native-fx-identity-bank'}}:{})},crossSourceCoherence:d.crossSourceCoherence,sourceAuthentication:d.sourceAuthentication,limitations:['Both complete measured components are retained; nonpositive post change makes growth efficiency undefined, never scalar zero or a conversion probability.','First-versus-third equal two-hour bins are fixed within the independently selected six-hour foreground; the middle bin remains reported.','First buyers are unique qualifying decoded user addresses over the complete twelve-hour canonical pool tape, not first-ever people, organic demand or new capital.','Historical marginal 0.01 SOL reference screens per-BUY legs; it is not actual SOL expenditure, USD value or an executable conversion.','The complete retained raw foreground is empty; positive observed POST subwindows have no supported A16 classification in this adapter.','Historical source/model/native clocks and declared source trust remain unchanged; no current freshness, causal inference, A26/A30 metric promotion or entry authority.']}};
}
export function validateA27MarginalSource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){
 const projected=projectA27MarginalSource(token,cutoff,evidence,rawArtifacts),source=validateA26BuyerPostSource(token,cutoff,projected.temporaryEvidence,projected.temporaryRawArtifacts),ids=source.ids.map(to27),metric=deriveA27MarginalComponents(source.metric,ids);return{metric,ids,nativeIds:new Set([...source.nativeIds].map(to27)),manifest:source.manifest};
}
