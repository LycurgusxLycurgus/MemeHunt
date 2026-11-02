import {z} from 'zod';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {A25_SOURCE_ID,A25_CAPTURE_ID,A25_ADAPTER,A25_PURPOSE,a25LeadLagScope} from '../providers/advisory-lead-lag-import.js';
import {validateA25LeadLagSource} from '../providers/advisory-lead-lag-source.js';
export const a25LeadLagDescriptorSchema=z.object({method:z.literal(A25_ADAPTER),purpose:z.literal(A25_PURPOSE),captureId:z.literal(A25_CAPTURE_ID)}).strict();
export const a25LeadLagDescriptor=()=>a25LeadLagDescriptorSchema.parse({method:A25_ADAPTER,purpose:A25_PURPOSE,captureId:A25_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===A25_SOURCE_ID||e.id.startsWith(A25_SOURCE_ID+'-')||e.adapterVersion===A25_ADAPTER;
const fail:()=>never=()=>{throw Error('A25_LEAD_LAG_PROOF_INVALID');};
type Core={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
export function validateA25LeadLagCore(input:Core,proof:unknown){
 const p=proof as {method?:unknown;a25LeadLag?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),ids=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(A25_SOURCE_ID+'-'));
 if(!owned.length&&!ids.length&&p?.a25LeadLag===undefined){if(p?.method==='advisory-provenance-v67')fail();return;}
 if(p?.method!=='advisory-provenance-v67'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!same(a25LeadLagDescriptorSchema.parse(p.a25LeadLag),a25LeadLagDescriptor())||owned.length!==1||ids.length!==1||ids[0]!==A25_CAPTURE_ID)fail();
 const e=owned[0]!,raw=input.rawArtifacts[A25_CAPTURE_ID];if(typeof raw!=='string'||e.id!==A25_CAPTURE_ID||e.sourceId!==A25_SOURCE_ID||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='USER_IMPORT'||e.adapterVersion!==A25_ADAPTER||e.contentHash!==createHash('sha256').update(raw).digest('hex')||!same(e.scope,a25LeadLagScope())||[...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.includes(A25_CAPTURE_ID)))fail();
 const resolved=validateA25LeadLagSource(raw,input.token,input.cutoff,[A25_CAPTURE_ID]);if(e.availableAt!==resolved.capture.captureCreatedAt||e.retrievedAt!==resolved.capture.captureCreatedAt)fail();return{raw,...resolved};
}
/** Historical study authority is restricted to A25. Ordinary quotas remain unchanged. */
export function validateA25LeadLagBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(A25_SOURCE_ID+'-')))fail();return;}
 const resolved=validateA25LeadLagCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v66'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const cites=(v:unknown):boolean=>typeof v==='string'?v===A25_CAPTURE_ID:Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='A25'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='A25');if(actual.length!==1||!same(actual[0],resolved.metric))fail();
}
