import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {S16_SOURCE_ID,S16_SOURCE_PREFIX,S16_CAPTURE_ID,S16_ADAPTER,S16_PURPOSE,validateS16CopySource} from '../providers/advisory-copy-source-adapter.js';
export const s16CopyDescriptorSchema=z.object({method:z.literal(S16_ADAPTER),purpose:z.literal(S16_PURPOSE),captureId:z.literal(S16_CAPTURE_ID)}).strict();
export const s16CopyDescriptor=()=>s16CopyDescriptorSchema.parse({method:S16_ADAPTER,purpose:S16_PURPOSE,captureId:S16_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===S16_SOURCE_ID||e.id.startsWith(S16_SOURCE_PREFIX)||e.adapterVersion===S16_ADAPTER;
const fail:()=>never=()=>{throw Error('S16_COPY_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
export function validateS16CopyCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;s16Copy?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(S16_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.s16Copy===undefined){if(p?.method==='advisory-provenance-v72')fail();return;}
 if(p?.method!=='advisory-provenance-v72'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!same(s16CopyDescriptorSchema.parse(p.s16Copy),s16CopyDescriptor()))fail();
 const resolved=validateS16CopySource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** Only a complete new-purpose S16 source reconstruction grants its owned-native storage allowance. */
export function validateS16CopyBundle(b:Bundle|LiveBundle,trustedLive:boolean):Set<string>{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(S16_SOURCE_PREFIX)))fail();return new Set();}
 const resolved=validateS16CopyCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return new Set();
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v71'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='S16'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='S16');if(actual.length!==1||!same(actual[0],resolved.metric))fail();return resolved.nativeIds;
}
