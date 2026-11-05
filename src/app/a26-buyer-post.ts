import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {A26_SOURCE_ID,A26_SOURCE_PREFIX,A26_CAPTURE_ID,A26_ADAPTER,A26_PURPOSE} from '../providers/advisory-buyer-post-import.js';
import {validateA26BuyerPostSource} from '../providers/advisory-buyer-post-source.js';
export const a26BuyerPostDescriptorSchema=z.object({method:z.literal(A26_ADAPTER),purpose:z.literal(A26_PURPOSE),captureId:z.literal(A26_CAPTURE_ID)}).strict();
export const a26BuyerPostDescriptor=()=>a26BuyerPostDescriptorSchema.parse({method:A26_ADAPTER,purpose:A26_PURPOSE,captureId:A26_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===A26_SOURCE_ID||e.id.startsWith(A26_SOURCE_PREFIX)||e.adapterVersion===A26_ADAPTER;
const fail:()=>never=()=>{throw Error('A26_BUYER_POST_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
export function validateA26BuyerPostCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;a26BuyerPost?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(A26_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.a26BuyerPost===undefined){if(p?.method==='advisory-provenance-v68')fail();return;}
 if(p?.method!=='advisory-provenance-v68'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!same(a26BuyerPostDescriptorSchema.parse(p.a26BuyerPost),a26BuyerPostDescriptor()))fail();
 const resolved=validateA26BuyerPostSource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** Full native/runtime and historical social validation precedes the new owned-native-only allowance. */
export function validateA26BuyerPostBundle(b:Bundle|LiveBundle,trustedLive:boolean):Set<string>{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(A26_SOURCE_PREFIX)))fail();return new Set();}
 const resolved=validateA26BuyerPostCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return new Set();
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v67'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='A26'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='A26');if(actual.length!==1||!same(actual[0],resolved.metric))fail();return resolved.nativeIds;
}
