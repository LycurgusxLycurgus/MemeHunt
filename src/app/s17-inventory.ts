import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {S17_SOURCE_ID,S17_SOURCE_PREFIX,S17_CAPTURE_ID,S17_ADAPTER,S17_PURPOSE,validateS17InventorySource} from '../providers/advisory-creator-call-inventory-source.js';
export const s17InventoryDescriptorSchema=z.object({method:z.literal(S17_ADAPTER),purpose:z.literal(S17_PURPOSE),captureId:z.literal(S17_CAPTURE_ID)}).strict();
export const s17InventoryDescriptor=()=>s17InventoryDescriptorSchema.parse({method:S17_ADAPTER,purpose:S17_PURPOSE,captureId:S17_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===S17_SOURCE_ID||e.id.startsWith(S17_SOURCE_PREFIX)||e.adapterVersion===S17_ADAPTER;
const fail:()=>never=()=>{throw Error('S17_INVENTORY_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
export function validateS17InventoryCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;s17Inventory?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(S17_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.s17Inventory===undefined){if(p?.method==='advisory-provenance-v71')fail();return;}
 if(p?.method!=='advisory-provenance-v71'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!same(s17InventoryDescriptorSchema.parse(p.s17Inventory),s17InventoryDescriptor()))fail();
 const resolved=validateS17InventorySource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** Only a complete new-purpose S17 source reconstruction grants its owned-native storage allowance. */
export function validateS17InventoryBundle(b:Bundle|LiveBundle,trustedLive:boolean):Set<string>{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(S17_SOURCE_PREFIX)))fail();return new Set();}
 const resolved=validateS17InventoryCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return new Set();
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v70'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='S17'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='S17');if(actual.length!==1||!same(actual[0],resolved.metric))fail();return resolved.nativeIds;
}
