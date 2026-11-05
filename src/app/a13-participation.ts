import {z} from 'zod';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {A13_SOURCE_ID,A13_CAPTURE_ID,A13_ADAPTER,A13_PURPOSE,a13ParticipationScope,decodeA13ParticipationCapture} from '../providers/advisory-participation-import.js';
import {deriveA13Participation} from '../providers/advisory-participation-source.js';

export const a13ParticipationDescriptorSchema=z.object({method:z.literal(A13_ADAPTER),purpose:z.literal(A13_PURPOSE),captureId:z.literal(A13_CAPTURE_ID)}).strict();
export const a13ParticipationDescriptor=()=>a13ParticipationDescriptorSchema.parse({method:A13_ADAPTER,purpose:A13_PURPOSE,captureId:A13_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===A13_SOURCE_ID||e.id.startsWith(A13_SOURCE_ID+'-')||e.adapterVersion===A13_ADAPTER;
const fail:()=>never=()=>{throw Error('A13_PARTICIPATION_PROOF_INVALID');};
type Core={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};

export function validateA13ParticipationCore(input:Core,proof:unknown){
 const p=proof as {method?:unknown;a13Participation?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(A13_SOURCE_ID+'-'));
 if(!owned.length&&!rawIds.length&&p?.a13Participation===undefined){if(p?.method==='advisory-provenance-v65')fail();return;}
 if(p?.method!=='advisory-provenance-v65'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!isDeepStrictEqual(a13ParticipationDescriptorSchema.parse(p.a13Participation),a13ParticipationDescriptor())||owned.length!==1||rawIds.length!==1||rawIds[0]!==A13_CAPTURE_ID)fail();
 const e=owned[0]!,raw=input.rawArtifacts[A13_CAPTURE_ID];
 if(typeof raw!=='string'||e.id!==A13_CAPTURE_ID||e.sourceId!==A13_SOURCE_ID||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='USER_IMPORT'||e.adapterVersion!==A13_ADAPTER||e.contentHash!==createHash('sha256').update(raw).digest('hex')||!isDeepStrictEqual(e.scope,a13ParticipationScope()))fail();
 const capture=decodeA13ParticipationCapture(raw,input.cutoff);
 if(e.availableAt!==capture.captureCreatedAt||e.retrievedAt!==capture.captureCreatedAt||[...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.includes(A13_CAPTURE_ID)))fail();
 return{raw,capture,metric:deriveA13Participation(raw,input.token,input.cutoff,[A13_CAPTURE_ID])};
}

/** The sole source authority is A13. Every stored cache is recomputed from raw. */
export function validateA13ParticipationBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(A13_SOURCE_ID+'-')))fail();return;}
 const resolved=validateA13ParticipationCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);
 if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v64'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const cites=(v:unknown):boolean=>typeof v==='string'?v===A13_CAPTURE_ID:Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='A13'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='A13');if(actual.length!==1||!isDeepStrictEqual(actual[0],resolved.metric))fail();
}
