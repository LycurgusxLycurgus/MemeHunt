import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {A27_SOURCE_ID,A27_SOURCE_PREFIX,A27_CAPTURE_ID,A27_ADAPTER,A27_PURPOSE,A27_COMPARISON,A27_BIN_SECONDS,validateA27MarginalSource} from '../providers/advisory-marginal-attention-source.js';
export const a27MarginalDescriptorSchema=z.object({method:z.literal(A27_ADAPTER),purpose:z.literal(A27_PURPOSE),captureId:z.literal(A27_CAPTURE_ID),comparison:z.literal(A27_COMPARISON),binSeconds:z.literal(A27_BIN_SECONDS)}).strict();
export const a27MarginalDescriptor=()=>a27MarginalDescriptorSchema.parse({method:A27_ADAPTER,purpose:A27_PURPOSE,captureId:A27_CAPTURE_ID,comparison:A27_COMPARISON,binSeconds:A27_BIN_SECONDS});
const owns=(e:EvidenceRecord)=>e.sourceId===A27_SOURCE_ID||e.id.startsWith(A27_SOURCE_PREFIX)||e.adapterVersion===A27_ADAPTER;
const fail:()=>never=()=>{throw Error('A27_MARGINAL_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
export function validateA27MarginalCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;a27Marginal?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(A27_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.a27Marginal===undefined){if(p?.method==='advisory-provenance-v69')fail();return;}
 if(p?.method!=='advisory-provenance-v69'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!same(a27MarginalDescriptorSchema.parse(p.a27Marginal),a27MarginalDescriptor()))fail();
 const resolved=validateA27MarginalSource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** Only a complete new-purpose A27 source reconstruction grants its owned-native storage allowance. */
export function validateA27MarginalBundle(b:Bundle|LiveBundle,trustedLive:boolean):Set<string>{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(A27_SOURCE_PREFIX)))fail();return new Set();}
 const resolved=validateA27MarginalCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return new Set();
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v68'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='A27'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='A27');if(actual.length!==1||!same(actual[0],resolved.metric))fail();return resolved.nativeIds;
}
