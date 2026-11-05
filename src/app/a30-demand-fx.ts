import type {Bundle,LiveBundle,TokenRef,EvidenceRecord,FeatureResult} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {A30_SOURCE_ID,A30_SOURCE_PREFIX,A30_SOURCE_ADAPTER,a30ReceiptsFromDescriptor,validateA30Storage,type A30SourceDescriptor} from '../providers/advisory-demand-fx-source.js';

const owned=(e:EvidenceRecord)=>e.sourceId===A30_SOURCE_ID||e.id.startsWith(A30_SOURCE_PREFIX)||e.adapterVersion===A30_SOURCE_ADAPTER;
const fail=():never=>{throw Error('A30_FX_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline?:BaselineAssessment[];features?:FeatureResult[]};
type Proof={method?:unknown;token?:TokenRef;cutoff?:unknown;pool?:unknown;a30Fx?:A30SourceDescriptor};

/** The temporary legacy-format C5 projection never grants legacy source authority. */
export function validateA30FxCore(input:Input,proof:unknown){
 const p=proof as Proof|null,records=input.evidence.filter(owned),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith(A30_SOURCE_PREFIX));
 if(!records.length&&!rawIds.length&&p?.a30Fx===undefined){if(p?.method==='advisory-provenance-v60')fail();return;}
 if(p?.method!=='advisory-provenance-v60'||!p.a30Fx||p.token?.chain!==input.token.chain||p.token.address!==input.token.address||p.cutoff!==input.cutoff||p.pool!==p.a30Fx.pool)return fail();
 let receipts;try{receipts=a30ReceiptsFromDescriptor(p.a30Fx,input.rawArtifacts,input.evidence,input.cutoff);}catch{return fail();}
 if(receipts.token.chain!==input.token.chain||receipts.token.address!==input.token.address)return fail();
 const ids=Object.values(p.a30Fx.artifactIds),set=new Set(ids);
 if([...(input.baseline??[]),...(input.features??[])].some(f=>f.evidenceIds.some(id=>set.has(id))))return fail();
 return {receipts,ids,descriptor:p.a30Fx};
}

/** Outside Shared: only trusted proof60 LIVE inputs may store and consume these receipts. */
export function validateA30FxBundle(b:Bundle|LiveBundle,trustedLive:boolean):Set<string>{
 const raw='rawArtifacts' in b?b.rawArtifacts??{}:{};
 let proof:unknown;try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owned)||Object.keys(raw).some(id=>id.startsWith(A30_SOURCE_PREFIX)))fail();return new Set();}
 const resolved=validateA30FxCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:'details' in b?b.details?.baseline:undefined,features:b.features},proof);
 if(!resolved)return new Set();
 if(!trustedLive||b.analysisKind!=='LIVE'||b.details?.advisory?.method!=='advisory-measurements-v59')return fail();
 const ids=new Set(resolved.ids),cites=(value:unknown):boolean=>typeof value==='string'?ids.has(value):Array.isArray(value)?value.some(cites):!!value&&typeof value==='object'?Object.values(value).some(cites):false;
 if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||cites(b.details.groups)||cites(b.details.shared)||cites(b.details.social)||cites(b.details.executableLiquidity)||b.details.advisory.metrics.some(m=>m.id!=='A30'&&cites(m)))return fail();
 return validateA30Storage(resolved.descriptor,raw,b.evidence,b.cutoff);
}
