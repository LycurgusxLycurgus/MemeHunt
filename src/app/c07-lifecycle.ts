import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {C07_SOURCE_ID,C07_SOURCE_PREFIX,C07_CAPTURE_ID,C07_ADAPTER,C07_PURPOSE,validateC07LifecycleSource,c07Owns} from '../providers/advisory-c07-lifecycle-source.js';
export const c07LifecycleDescriptorSchema=z.object({method:z.literal(C07_ADAPTER),purpose:z.literal(C07_PURPOSE),captureId:z.literal(C07_CAPTURE_ID)}).strict();
export const c07LifecycleDescriptor=()=>c07LifecycleDescriptorSchema.parse({method:C07_ADAPTER,purpose:C07_PURPOSE,captureId:C07_CAPTURE_ID});
const fail:()=>never=()=>{throw Error('C07_LIFECYCLE_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
/** Only proof v76 carries the strict C07 descriptor over its owned source records; a reserved id, record or descriptor anywhere else fails closed. */
export function validateC07LifecycleCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;c07Lifecycle?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(c07Owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id===C07_SOURCE_ID||id.startsWith(C07_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.c07Lifecycle===undefined){if(p?.method==='advisory-provenance-v76')fail();return;}
 const descriptor=c07LifecycleDescriptorSchema.safeParse(p?.c07Lifecycle);
 if(p?.method!=='advisory-provenance-v76'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!descriptor.success||!same(descriptor.data,c07LifecycleDescriptor()))fail();
 const resolved=validateC07LifecycleSource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);
 if(resolved.metric.id!=='C07'||resolved.metric.evidenceIds.some(id=>!ids.has(id)))fail();
 if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** C07 evidence is confined to its single recomputed advisory metric and receives no storage exception. */
export function validateC07LifecycleBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(c07Owns)||Object.keys(raw).some(id=>id===C07_SOURCE_ID||id.startsWith(C07_SOURCE_PREFIX)))fail();return;}
 const resolved=validateC07LifecycleCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v75'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||cites(b.details.advisory.supplements)||b.details.advisory.metrics.some(m=>m.id!=='C07'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='C07');if(actual.length!==1||!same(actual[0],resolved.metric))fail();
}
