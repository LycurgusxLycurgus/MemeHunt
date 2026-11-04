import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {S20_SOURCE_PREFIX,S20_CAPTURE_ID,S20_ADAPTER,S20_PURPOSE,validateS20StructuralSource,s20Owns} from '../providers/advisory-s20-structural.js';
export const s20StructuralDescriptorSchema=z.object({method:z.literal(S20_ADAPTER),purpose:z.literal(S20_PURPOSE),captureId:z.literal(S20_CAPTURE_ID)}).strict();
export const s20StructuralDescriptor=()=>s20StructuralDescriptorSchema.parse({method:S20_ADAPTER,purpose:S20_PURPOSE,captureId:S20_CAPTURE_ID});
const fail:()=>never=()=>{throw Error('S20_STRUCTURAL_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
/** Only proof v74 carries the strict S20 descriptor over its single owned capture; a reserved id, record or descriptor anywhere else fails closed. */
export function validateS20StructuralCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;s20Structural?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(s20Owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(S20_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.s20Structural===undefined){if(p?.method==='advisory-provenance-v74')fail();return;}
 const descriptor=s20StructuralDescriptorSchema.safeParse(p?.s20Structural);
 if(p?.method!=='advisory-provenance-v74'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!descriptor.success||!same(descriptor.data,s20StructuralDescriptor()))fail();
 const resolved=validateS20StructuralSource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** S20 evidence is confined to its single recomputed advisory metric and receives no storage exception. */
export function validateS20StructuralBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(s20Owns)||Object.keys(raw).some(id=>id.startsWith(S20_SOURCE_PREFIX)))fail();return;}
 const resolved=validateS20StructuralCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v73'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||cites(b.details.advisory.supplements)||b.details.advisory.metrics.some(m=>m.id!=='S20'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='S20');if(actual.length!==1||!same(actual[0],resolved.metric))fail();
}
