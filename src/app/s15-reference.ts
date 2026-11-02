import {z} from 'zod';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {S15_REFERENCE_SOURCE_ID,S15_REFERENCE_CAPTURE_ID,S15_REFERENCE_ADAPTER,S15_REFERENCE_PURPOSE,s15ReferenceScope} from '../providers/advisory-creator-reference-import.js';
import {validateS15ReferenceSource} from '../providers/advisory-creator-reference-source.js';
export const s15ReferenceDescriptorSchema=z.object({method:z.literal(S15_REFERENCE_ADAPTER),purpose:z.literal(S15_REFERENCE_PURPOSE),captureId:z.literal(S15_REFERENCE_CAPTURE_ID)}).strict();
export const s15ReferenceDescriptor=()=>s15ReferenceDescriptorSchema.parse({method:S15_REFERENCE_ADAPTER,purpose:S15_REFERENCE_PURPOSE,captureId:S15_REFERENCE_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===S15_REFERENCE_SOURCE_ID||e.id.startsWith(S15_REFERENCE_SOURCE_ID+'-')||e.adapterVersion===S15_REFERENCE_ADAPTER;
const fail:()=>never=()=>{throw Error('S15_REFERENCE_PROOF_INVALID');};
type Core={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
export function validateS15ReferenceCore(input:Core,proof:unknown){
 const p=proof as {method?:unknown;s15Reference?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),ids=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(S15_REFERENCE_SOURCE_ID+'-'));
 if(!owned.length&&!ids.length&&p?.s15Reference===undefined){if(p?.method==='advisory-provenance-v66')fail();return;}
 if(p?.method!=='advisory-provenance-v66'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!isDeepStrictEqual(s15ReferenceDescriptorSchema.parse(p.s15Reference),s15ReferenceDescriptor())||owned.length!==1||ids.length!==1||ids[0]!==S15_REFERENCE_CAPTURE_ID)fail();
 const e=owned[0]!,raw=input.rawArtifacts[S15_REFERENCE_CAPTURE_ID];
 if(typeof raw!=='string'||e.id!==S15_REFERENCE_CAPTURE_ID||e.sourceId!==S15_REFERENCE_SOURCE_ID||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='USER_IMPORT'||e.adapterVersion!==S15_REFERENCE_ADAPTER||e.contentHash!==createHash('sha256').update(raw).digest('hex')||!isDeepStrictEqual(e.scope,s15ReferenceScope())||[...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.includes(S15_REFERENCE_CAPTURE_ID)))fail();
 // This performs full native index/body/role/FIFO/failed closure, not just an archive header check.
 const resolved=validateS15ReferenceSource(raw,input.token,input.cutoff,[S15_REFERENCE_CAPTURE_ID]);
 if(e.availableAt!==resolved.capture.captureCreatedAt||e.retrievedAt!==resolved.capture.captureCreatedAt)fail();
 return{raw,...resolved};
}
/** Only this fully validated single capture can receive the new bounded storage allowance. */
export function validateS15ReferenceBundle(b:Bundle|LiveBundle,trustedLive:boolean):Set<string>{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(S15_REFERENCE_SOURCE_ID+'-')))fail();return new Set();}
 const resolved=validateS15ReferenceCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return new Set();
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v65'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const cites=(v:unknown):boolean=>typeof v==='string'?v===S15_REFERENCE_CAPTURE_ID:Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='S15'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='S15');if(actual.length!==1||!isDeepStrictEqual(actual[0],resolved.metric))fail();
 return new Set([S15_REFERENCE_CAPTURE_ID]);
}
