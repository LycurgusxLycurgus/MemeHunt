import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {S18_SOURCE_PREFIX,S18_CAPTURE_ID,S18_ADAPTER,S18_PURPOSE,validateS18ObservabilitySource,s18Owns} from '../providers/advisory-s18-observability-source.js';
export const s18ObservabilityDescriptorSchema=z.object({method:z.literal(S18_ADAPTER),purpose:z.literal(S18_PURPOSE),captureId:z.literal(S18_CAPTURE_ID)}).strict();
export const s18ObservabilityDescriptor=()=>s18ObservabilityDescriptorSchema.parse({method:S18_ADAPTER,purpose:S18_PURPOSE,captureId:S18_CAPTURE_ID});
const fail:()=>never=()=>{throw Error('S18_OBSERVABILITY_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
/** Only proof v75 carries the strict S18 descriptor over its owned source records; a reserved id, record or descriptor anywhere else fails closed. */
export function validateS18ObservabilityCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;s18Observability?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(s18Owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(S18_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.s18Observability===undefined){if(p?.method==='advisory-provenance-v75')fail();return;}
 const descriptor=s18ObservabilityDescriptorSchema.safeParse(p?.s18Observability);
 if(p?.method!=='advisory-provenance-v75'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!descriptor.success||!same(descriptor.data,s18ObservabilityDescriptor()))fail();
 const resolved=validateS18ObservabilitySource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);
 if(resolved.metric.id!=='S18'||resolved.metric.evidenceIds.some(id=>!ids.has(id)))fail();
 if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** S18 evidence is confined to its single recomputed advisory metric and receives no storage exception. */
export function validateS18ObservabilityBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(s18Owns)||Object.keys(raw).some(id=>id.startsWith(S18_SOURCE_PREFIX)))fail();return;}
 const resolved=validateS18ObservabilityCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v74'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||cites(b.details.advisory.supplements)||b.details.advisory.metrics.some(m=>m.id!=='S18'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='S18');if(actual.length!==1||!same(actual[0],resolved.metric))fail();
}
