import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {A28_SOURCE_ID,A28_SOURCE_PREFIX,A28_CAPTURE_ID,A28_ADAPTER,A28_PURPOSE,validateA28DecaySource,a28Owns} from '../providers/advisory-a28-decay-source.js';
export const a28DecayDescriptorSchema=z.object({method:z.literal(A28_ADAPTER),purpose:z.literal(A28_PURPOSE),captureId:z.literal(A28_CAPTURE_ID)}).strict();
export const a28DecayDescriptor=()=>a28DecayDescriptorSchema.parse({method:A28_ADAPTER,purpose:A28_PURPOSE,captureId:A28_CAPTURE_ID});
const fail:()=>never=()=>{throw Error('A28_DECAY_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
/** Only proof v77 carries the strict A28 descriptor over its owned source records; a reserved id, record or descriptor anywhere else fails closed. */
export function validateA28DecayCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;a28Decay?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(a28Owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id===A28_SOURCE_ID||id.startsWith(A28_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.a28Decay===undefined){if(p?.method==='advisory-provenance-v77')fail();return;}
 const descriptor=a28DecayDescriptorSchema.safeParse(p?.a28Decay);
 if(p?.method!=='advisory-provenance-v77'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!descriptor.success||!same(descriptor.data,a28DecayDescriptor()))fail();
 const resolved=validateA28DecaySource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);
 if(resolved.metric.id!=='A28'||resolved.metric.evidenceIds.some(id=>!ids.has(id)))fail();
 if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** A28 evidence is confined to its single recomputed advisory metric and receives no storage exception. */
export function validateA28DecayBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(a28Owns)||Object.keys(raw).some(id=>id===A28_SOURCE_ID||id.startsWith(A28_SOURCE_PREFIX)))fail();return;}
 const resolved=validateA28DecayCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v76'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||cites(b.details.advisory.supplements)||b.details.advisory.metrics.some(m=>m.id!=='A28'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='A28');if(actual.length!==1||!same(actual[0],resolved.metric))fail();
}
