import {z} from 'zod';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {C12_SOURCE_ID,C12_CAPTURE_ID,C12_SOURCE_ADAPTER,C12_SOURCE_PURPOSE,c12BridgeScope,decodeC12BridgeCapture} from '../providers/advisory-bridge-import.js';
import {deriveC12NativeBridgeFlow} from '../providers/advisory-bridge-flow.js';

export const c12BridgeDescriptorSchema=z.object({method:z.literal(C12_SOURCE_ADAPTER),purpose:z.literal(C12_SOURCE_PURPOSE),captureId:z.literal(C12_CAPTURE_ID)}).strict();
export const c12BridgeDescriptor=()=>c12BridgeDescriptorSchema.parse({method:C12_SOURCE_ADAPTER,purpose:C12_SOURCE_PURPOSE,captureId:C12_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===C12_SOURCE_ID||e.id.startsWith(C12_SOURCE_ID+'-')||e.adapterVersion===C12_SOURCE_ADAPTER;
const fail:()=>never=()=>{throw Error('C12_BRIDGE_PROOF_INVALID');};
type Core={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};

/** C12 is global covered context, not token identity or an entry witness. */
export function validateC12BridgeCore(input:Core,proof:unknown){
 const p=proof as {method?:unknown;c12Bridge?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(C12_SOURCE_ID+'-'));
 if(!owned.length&&!rawIds.length&&p?.c12Bridge===undefined){if(p?.method==='advisory-provenance-v63')fail();return;}
 if(p?.method!=='advisory-provenance-v63'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!isDeepStrictEqual(c12BridgeDescriptorSchema.parse(p.c12Bridge),c12BridgeDescriptor())||owned.length!==1||rawIds.length!==1||rawIds[0]!==C12_CAPTURE_ID)fail();
 const e=owned[0]!,raw=input.rawArtifacts[C12_CAPTURE_ID];
 if(typeof raw!=='string'||e.id!==C12_CAPTURE_ID||e.sourceId!==C12_SOURCE_ID||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='USER_IMPORT'||e.adapterVersion!==C12_SOURCE_ADAPTER||e.contentHash!==createHash('sha256').update(raw).digest('hex')||!isDeepStrictEqual(e.scope,c12BridgeScope()))fail();
 const capture=decodeC12BridgeCapture(raw,input.cutoff);
 if(e.availableAt!==capture.captureCreatedAt||e.retrievedAt!==capture.captureCreatedAt||[...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.includes(C12_CAPTURE_ID)))fail();
 return{raw,capture,metric:deriveC12NativeBridgeFlow(raw,input.cutoff,[C12_CAPTURE_ID])};
}

/** Runs before Shared and storage checks, including partial or untrusted imports. */
export function validateC12BridgeBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(C12_SOURCE_ID+'-')))fail();return;}
 const resolved=validateC12BridgeCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);
 if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||b.details?.advisory?.method!=='advisory-measurements-v62'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const cites=(v:unknown):boolean=>typeof v==='string'?v===C12_CAPTURE_ID:Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='C12'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='C12');if(actual.length!==1||!isDeepStrictEqual(actual[0],resolved.metric))fail();
}
