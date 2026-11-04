import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {S19_SOURCE_PREFIX,S19_CAPTURE_ID,S19_ADAPTER,S19_PURPOSE,validateS19Source,s19Owns} from '../providers/advisory-s19-singleton-source.js';
export const s19SingletonDescriptorSchema=z.object({method:z.literal(S19_ADAPTER),purpose:z.literal(S19_PURPOSE),captureId:z.literal(S19_CAPTURE_ID)}).strict();
export const s19SingletonDescriptor=()=>s19SingletonDescriptorSchema.parse({method:S19_ADAPTER,purpose:S19_PURPOSE,captureId:S19_CAPTURE_ID});
const fail:()=>never=()=>{throw Error('S19_SINGLETON_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
/** Only proof v73 carries the strict S19 descriptor over its exact five-record source; a reserved id, record or descriptor anywhere else fails closed. */
export function validateS19SingletonCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;s19Singleton?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(s19Owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(S19_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.s19Singleton===undefined){if(p?.method==='advisory-provenance-v73')fail();return;}
 const descriptor=s19SingletonDescriptorSchema.safeParse(p?.s19Singleton);
 if(p?.method!=='advisory-provenance-v73'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!descriptor.success||!same(descriptor.data,s19SingletonDescriptor()))fail();
 const resolved=validateS19Source(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** S19 evidence is confined to its single recomputed advisory metric and receives no storage exception. */
export function validateS19SingletonBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(s19Owns)||Object.keys(raw).some(id=>id.startsWith(S19_SOURCE_PREFIX)))fail();return;}
 const resolved=validateS19SingletonCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v72'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||cites(b.details.advisory.supplements)||b.details.advisory.metrics.some(m=>m.id!=='S19'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='S19');if(actual.length!==1||!same(actual[0],resolved.metric))fail();
}
