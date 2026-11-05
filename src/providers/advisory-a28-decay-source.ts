import {isDeepStrictEqual as same} from 'node:util';
import type {TokenRef,EvidenceRecord} from '../domain/contracts.js';
import {s18Instant} from './advisory-s18-study.js';
import {A28_METHOD,A28_PROFILE_SHA256,A28_SOURCE_FRAME_SHA256,A28_QUALIFICATION_SHA256,A28_CATALYST_DISPOSITIONS_SHA256,A28_ADJUDICATION_SHA256,A28_FRANKIE,deriveA28DecayMetric,a28StudyInputSchema,type A28StudyInput} from './advisory-a28-decay-study.js';
import {rederiveA28Source} from './advisory-a28-native-source.js';
import {A28_SOURCE_ID,A28_SOURCE_PREFIX,A28_CAPTURE_ID,A28_ADAPTER,A28_PURPOSE,a28Hash as sha,a28Check as must,a28Fail,decodeA28Portable,a28Id,a28CaptureScope,a28RoleScope} from './advisory-a28-decay-import.js';
export * from './advisory-a28-decay-import.js';
export const a28Owns=(e:EvidenceRecord)=>e.id===A28_SOURCE_ID||e.id.startsWith(A28_SOURCE_PREFIX)||e.sourceId===A28_SOURCE_ID||e.adapterVersion===A28_ADAPTER;
function validateSource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){
 must(s18Instant(cutoff)!==null,'CUTOFF');const owned=evidence.filter(a28Owns),capture=owned.find(e=>e.id===A28_CAPTURE_ID);
 must(capture&&owned.filter(e=>e.id===A28_CAPTURE_ID).length===1,'CAPTURE');const manifestRaw=rawArtifacts[A28_CAPTURE_ID];must(typeof manifestRaw==='string','CAPTURE');
 const m=JSON.parse(manifestRaw),sources:Record<string,string>={};for(const r of m.receipts??[])sources[r.role]=rawArtifacts[a28Id(r.role)]!;
 const{manifest,packet}=decodeA28Portable(manifestRaw,sources,cutoff);must(manifestRaw===JSON.stringify(manifest),'CAPTURE_CANONICAL');
 const ids=[A28_CAPTURE_ID,...manifest.receipts.map(r=>a28Id(r.role))];
 must(owned.length===ids.length&&new Set(owned.map(e=>e.id)).size===ids.length&&owned.every(e=>ids.includes(e.id))&&same(Object.keys(rawArtifacts).filter(id=>id===A28_SOURCE_ID||id.startsWith(A28_SOURCE_PREFIX)).sort(),[...ids].sort()),'OWNERSHIP');
 for(const e of owned){const r=e.id===A28_CAPTURE_ID?null:manifest.receipts.find(r=>a28Id(r.role)===e.id);must(e.sourceId===A28_SOURCE_ID&&e.sourceType==='HISTORICAL_RECEIPT'&&e.adapterVersion===A28_ADAPTER&&e.accessMode==='USER_IMPORT'&&e.contentHash===sha(rawArtifacts[e.id]!)&&e.retrievedAt===e.availableAt&&e.retrievedAt===(r?r.retrievedAt:manifest.packagedAt)&&same(e.scope,r?a28RoleScope(r):a28CaptureScope()),'EVIDENCE');}
 // Full original source, context and citation/group reconstruction precedes every metric/nonmember branch.
 const native=rederiveA28Source(JSON.stringify(packet),{now:Date.parse(cutoff)}),documents=native.studyDocuments;
 const profile=documents.profile,qualification=documents.qualification,dispositions=documents.catalystDispositions;
 must(profile.method===A28_METHOD&&profile.purpose===A28_PURPOSE&&sha(sources['model-profile'])===A28_PROFILE_SHA256&&sha(sources['root-qualification-context'])===A28_QUALIFICATION_SHA256&&sha(sources['catalyst-dispositions'])===A28_CATALYST_DISPOSITIONS_SHA256&&sha(sources['qualification-contract'])===A28_ADJUDICATION_SHA256&&profile.sourceFrameSha256===A28_SOURCE_FRAME_SHA256&&qualification.sourceFrameSha256===A28_SOURCE_FRAME_SHA256,'STUDY_PROFILE');
 const rows=new Map<string,any>(qualification.rows.map((r:any)=>[r.postId,r]));
 const posts:A28StudyInput['posts']=native.posts.map((p:any)=>{const r=rows.get(p.postId);must(r&&['ELIGIBLE','EXCLUDED'].includes(r.rootDecision),'ADJUDICATION');const eligible=r.rootDecision==='ELIGIBLE';return{postId:p.postId,groupId:r.copy.groupId,publishedAt:p.createdAt,primaryEligible:eligible,alternativeEligible:p.postId===A28_FRANKIE?false:eligible};});
 const catalysts:A28StudyInput['catalysts']=dispositions.items.map((c:any)=>{const p=native.posts.find((p:any)=>p.postId===c.postId);must(p,'CATALYST_PRIMARY');return{id:c.postId,publishedAt:c.at,barrier:c.barrierForAnyLaterFitStartingBeforeThisPublication,sourceIds:[a28Id('native-page-'+String(p.page).padStart(2,'0')),a28Id('root-qualification-context'),a28Id('catalyst-dispositions')]};});
 for(const c of dispositions.contextOnly){const p=native.contextOnly.find((p:any)=>p.postId===c.id);must(p,'CATALYST_CONTEXT');catalysts.push({id:c.id,publishedAt:c.at,barrier:c.barrierForAnyLaterFitStartingBeforeThisPublication,sourceIds:[a28Id(p.sourceRole),a28Id('parent-context-receipts'),a28Id('catalyst-dispositions')]});}
 const input:A28StudyInput=a28StudyInputSchema.parse({method:A28_METHOD,profileSha256:A28_PROFILE_SHA256,sourceFrameSha256:A28_SOURCE_FRAME_SHA256,qualificationSha256:A28_QUALIFICATION_SHA256,catalystDispositionsSha256:A28_CATALYST_DISPOSITIONS_SHA256,adjudicationContractSha256:A28_ADJUDICATION_SHA256,packagedAt:manifest.packagedAt,evaluationCutoff:cutoff,source:{status:native.stream.status==='COMPLETE'?'COMPLETE':'MISSING',reason:native.stream.status==='COMPLETE'?null:native.stream.reasonCode,availableAt:manifest.packagedAt,sourceIds:ids},posts,catalysts});
 return{ids,input,metric:deriveA28DecayMetric(token,cutoff,input,new Set(ids))};
}
/** All raw/namespace/source-citation gates run even for a token outside the frozen subject. */
export function validateA28DecaySource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){try{return validateSource(token,cutoff,evidence,rawArtifacts);}catch(e){if(e instanceof Error&&/^A28_DECAY_[A-Z_]+$/.test(e.message))throw e;return a28Fail('SOURCE_INVALID');}}
