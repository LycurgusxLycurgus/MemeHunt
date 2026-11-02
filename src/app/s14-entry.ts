import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,EvidenceRecord,TokenRef,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {S14_SOURCE_ID,S14_SOURCE_PREFIX,S14_CAPTURE_ID,S14_ADAPTER,S14_PURPOSE,validateS14EntrySource} from '../providers/advisory-actor-entry-source.js';
export const s14EntryDescriptorSchema=z.object({method:z.literal(S14_ADAPTER),purpose:z.literal(S14_PURPOSE),captureId:z.literal(S14_CAPTURE_ID)}).strict();
export const s14EntryDescriptor=()=>s14EntryDescriptorSchema.parse({method:S14_ADAPTER,purpose:S14_PURPOSE,captureId:S14_CAPTURE_ID});
const owns=(e:EvidenceRecord)=>e.sourceId===S14_SOURCE_ID||e.id.startsWith(S14_SOURCE_PREFIX)||e.adapterVersion===S14_ADAPTER;
const fail:()=>never=()=>{throw Error('S14_ENTRY_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
export function validateS14EntryCore(input:Input,proof:unknown){
 const p=proof as {method?:unknown;s14Entry?:unknown;token?:TokenRef;cutoff?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(S14_SOURCE_PREFIX));
 if(!owned.length&&!rawIds.length&&p?.s14Entry===undefined){if(p?.method==='advisory-provenance-v70')fail();return;}
 if(p?.method!=='advisory-provenance-v70'||input.token.chain!=='solana'||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||!same(s14EntryDescriptorSchema.parse(p.s14Entry),s14EntryDescriptor()))fail();
 const resolved=validateS14EntrySource(input.token,input.cutoff,input.evidence,input.rawArtifacts),ids=new Set(resolved.ids);if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>ids.has(id))))fail();return resolved;
}
/** S14 evidence is confined to its own advisory metric and receives no storage exception. */
export function validateS14EntryBundle(b:Bundle|LiveBundle,trustedLive:boolean):void{
 const raw='rawArtifacts'in b?b.rawArtifacts??{}:{};let proof:unknown;
 try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith(S14_SOURCE_PREFIX)))fail();return;}
 const resolved=validateS14EntryCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details'in b?b.details?.baseline:undefined,features:b.features},proof);if(!resolved)return;
 if(!trustedLive||b.analysisKind!=='LIVE'||!('details'in b)||b.details?.advisory?.method!=='advisory-measurements-v69'||b.details.shared||b.details.groups||b.details.social||b.details.executableLiquidity)fail();
 const ids=new Set(resolved.ids),cites=(v:unknown):boolean=>typeof v==='string'?ids.has(v):Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||b.details.advisory.metrics.some(m=>m.id!=='S14'&&cites(m)))fail();
 const actual=b.details.advisory.metrics.filter(m=>m.id==='S14');if(actual.length!==1||!same(actual[0],resolved.metric))fail();return;
}
