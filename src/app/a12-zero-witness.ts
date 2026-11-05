import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import type {Bundle,LiveBundle,TokenRef,EvidenceRecord} from '../domain/contracts.js';
import {decodeA12ZeroWitnessCapture,a12WitnessScope,A12_WITNESS_ID,A12_WITNESS_METHOD,A12_WITNESS_SOURCE} from '../providers/advisory-exit-capacity-witness.js';

export const A12_WITNESS_COMPARISON_MODE='zero-target-positive-witness-invariant-v1' as const;
const owned=(e:EvidenceRecord)=>e.sourceId===A12_WITNESS_SOURCE||e.adapterVersion===A12_WITNESS_METHOD||e.id.startsWith('a12-zero-witness-');
const fail=():never=>{throw Error('A12_ZERO_WITNESS_PROOF_INVALID');};
type Input={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>};

/** Source authority is specific to proof58's witness variant, independent of Shared. */
export function validateA12WitnessSource(input:Input,proof:unknown){
  const p=proof as {method?:unknown;exitCapacity?:{witnessCaptureId?:unknown;comparisonMode?:unknown;impactBps?:unknown}}|null,d=p?.exitCapacity;
  const records=input.evidence.filter(owned),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith('a12-zero-witness-'));
  const marked=d?.witnessCaptureId!==undefined||d?.comparisonMode===A12_WITNESS_COMPARISON_MODE;
  if(!records.length&&!rawIds.length&&!marked)return;
  if(p?.method!=='advisory-provenance-v58'||d?.witnessCaptureId!==A12_WITNESS_ID||d.comparisonMode!==A12_WITNESS_COMPARISON_MODE||records.length!==1||rawIds.length!==1||rawIds[0]!==A12_WITNESS_ID)return fail();
  const record=records[0]!,raw=input.rawArtifacts[A12_WITNESS_ID];
  if(typeof raw!=='string'||record.id!==A12_WITNESS_ID||record.sourceId!==A12_WITNESS_SOURCE||record.sourceType!=='MODEL_EXECUTION'||record.accessMode!=='USER_IMPORT'||record.adapterVersion!==A12_WITNESS_METHOD||record.contentHash!==createHash('sha256').update(raw).digest('hex')||!same(record.scope,a12WitnessScope(raw)))return fail();
  const decoded=decodeA12ZeroWitnessCapture(raw,input.token,input.cutoff);
  if(record.retrievedAt!==decoded.capture.createdAt||record.availableAt!==decoded.capture.createdAt||d.impactBps!==decoded.capture.scope.impactBps)return fail();
  return decoded;
}

export function validateA12WitnessBundle(b:Bundle|LiveBundle,trustedLive:boolean){
  const raw='rawArtifacts' in b?b.rawArtifacts??{}:{};
  let proof:unknown;try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owned)||Object.keys(raw).some(id=>id.startsWith('a12-zero-witness-')))fail();return;}
  const decoded=validateA12WitnessSource({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw},proof);
  if(!decoded)return;
  if(!trustedLive||b.analysisKind!=='LIVE')return fail();
  if(!b.details?.advisory||b.details.advisory.method!=='advisory-measurements-v57'||b.profile.risk.maxExitImpactBps!==decoded.capture.scope.impactBps||Object.values(raw).reduce((sum,value)=>sum+Buffer.byteLength(value),0)>24_000_000)return fail();
  const cites=(value:unknown):boolean=>typeof value==='string'?value===A12_WITNESS_ID:Array.isArray(value)?value.some(cites):!!value&&typeof value==='object'?Object.values(value).some(cites):false;
  if(cites(b.features)||cites(b.observations)||cites(b.semantic)||cites(b.exitProofs)||cites(b.details.baseline)||cites(b.details.groups)||cites(b.details.shared)||cites(b.details.social)||b.details.advisory.metrics.some(m=>m.id!=='A12'&&cites(m)))fail();
}
