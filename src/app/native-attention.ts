import {z} from 'zod';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {BaselineAssessment} from '../domain/baseline.js';
import type {EvidenceRecord,FeatureResult,LiveBundle,SemanticResult,TokenRef,Bundle} from '../domain/contracts.js';
import {decodeNativeAttentionCapture,nativeAttentionScope,NATIVE_ATTENTION_ID,NATIVE_ATTENTION_METHOD,NATIVE_ATTENTION_PURPOSE,NATIVE_ATTENTION_SOURCE} from '../providers/native-attention.js';

export const nativeAttentionDescriptorSchema=z.object({method:z.literal('native-attention-qualification-v1'),purpose:z.literal('NARRATIVE_GAME_QUALIFICATION'),captureId:z.literal('native-attention-capture')}).strict();
export const nativeAttentionDescriptor=()=>nativeAttentionDescriptorSchema.parse({method:NATIVE_ATTENTION_METHOD,purpose:NATIVE_ATTENTION_PURPOSE,captureId:NATIVE_ATTENTION_ID});
type Decoded=ReturnType<typeof decodeNativeAttentionCapture>;
export function nativeAttentionSemantic(decoded:Decoded):SemanticResult {
  return {status:decoded.assessments.every(a=>a.quality==='KNOWN')?'VALIDATED':'CANDIDATE',claims:[],nativeAttention:nativeAttentionDescriptor()};
}
type Core={token:TokenRef;cutoff:string;evidence:EvidenceRecord[];rawArtifacts:Record<string,string>;baseline:BaselineAssessment[];features:FeatureResult[]};
const owns=(e:EvidenceRecord)=>e.sourceId===NATIVE_ATTENTION_SOURCE||e.adapterVersion===NATIVE_ATTENTION_METHOD||e.id.startsWith('native-attention-');
const fail=():never=>{throw Error('NATIVE_ATTENTION_PROOF_INVALID');};

/** Replay native authority before advisory C10 consumes the two entry features. */
export function validateNativeAttentionCore(input:Core,proof:unknown):Decoded|undefined {
  const p=proof as {method?:unknown;nativeAttention?:unknown}|null,owned=input.evidence.filter(owns),rawIds=Object.keys(input.rawArtifacts).filter(id=>id.startsWith('native-attention-'));
  if(!owned.length&&!rawIds.length&&p?.nativeAttention===undefined){if(p?.method==='advisory-provenance-v59')fail();return;}
  if(p?.method!=='advisory-provenance-v59'||!isDeepStrictEqual(nativeAttentionDescriptorSchema.parse(p.nativeAttention),nativeAttentionDescriptor())||owned.length!==1||rawIds.length!==1||rawIds[0]!==NATIVE_ATTENTION_ID)fail();
  const e=owned[0]!,raw=input.rawArtifacts[NATIVE_ATTENTION_ID];
  if(typeof raw!=='string'||e.id!==NATIVE_ATTENTION_ID||e.sourceId!==NATIVE_ATTENTION_SOURCE||e.sourceType!=='MODEL_EXECUTION'||e.adapterVersion!==NATIVE_ATTENTION_METHOD||e.accessMode!=='USER_IMPORT'||e.contentHash!==createHash('sha256').update(raw).digest('hex')||!isDeepStrictEqual(e.scope,nativeAttentionScope(raw)))fail();
  const decoded=decodeNativeAttentionCapture(raw,input.token,input.cutoff);
  if(e.availableAt!==decoded.capture.createdAt||e.retrievedAt!==decoded.capture.createdAt)fail();
  for(const expected of decoded.assessments){
    const actual=input.baseline.filter(a=>a.id===expected.id),features=input.features.filter(f=>f.id===expected.id);
    if(actual.length!==1||!isDeepStrictEqual(actual[0],expected)||features.length!==(expected.projection?1:0)||expected.projection&&!isDeepStrictEqual(features[0],expected.projection))fail();
  }
  const cites=(v:unknown):boolean=>typeof v==='string'?v===NATIVE_ATTENTION_ID:Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
  for(const a of input.baseline){
    if(['A01','A02'].includes(a.id))continue;
    const checked=structuredClone(a);
    // The existing baseline TTL report exposes its inputs. These two rows are
    // transparent dependencies, not direct source authority for another feature.
    if(checked.id==='C03'&&checked.data&&typeof checked.data==='object'&&'records' in checked.data){
      const records=(checked.data as {records?:unknown}).records;
      if(Array.isArray(records))for(const row of records)if(row&&typeof row==='object'&&['A01','A02'].includes(row.id)&&isDeepStrictEqual(row.evidenceIds,[NATIVE_ATTENTION_ID]))row.evidenceIds=[];
    }
    if(cites(checked))fail();
  }
  if(input.features.some(f=>!['A01','A02'].includes(f.id)&&cites(f)))fail();
  return decoded;
}

/** This runs independently of Shared, including partial runs and untrusted imports. */
export function validateNativeAttentionBundle(b:Bundle|LiveBundle,trustedLive:boolean):void {
  const raw='rawArtifacts' in b?b.rawArtifacts??{}:{},marker='semantic' in b?b.semantic.nativeAttention:undefined;
  let proof:unknown;try{proof=JSON.parse(raw['advisory-derivation']??'null');}catch{if(b.evidence.some(owns)||marker)fail();return;}
  const present=b.evidence.some(owns)||Object.keys(raw).some(id=>id.startsWith('native-attention-'))||marker!==undefined||(proof as {nativeAttention?:unknown}|null)?.nativeAttention!==undefined||(proof as {method?:unknown}|null)?.method==='advisory-provenance-v59';
  if(!present)return;
  if(!trustedLive||b.analysisKind!=='LIVE')return fail();
  if(Object.values(raw).reduce((total,value)=>total+Buffer.byteLength(value),0)>24_000_000)return fail();
  const details=b.details;
  if(!details?.advisory||details.shared||details.social||details.groups||details.advisory.method!=='advisory-measurements-v58')return fail();
  const decoded=validateNativeAttentionCore({token:b.token,cutoff:b.cutoff,evidence:b.evidence,rawArtifacts:raw,baseline:details.baseline,features:b.features},proof);
  if(!decoded||!isDeepStrictEqual(b.semantic,nativeAttentionSemantic(decoded)))fail();
  const cites=(v:unknown):boolean=>typeof v==='string'?v===NATIVE_ATTENTION_ID:Array.isArray(v)?v.some(cites):!!v&&typeof v==='object'?Object.values(v).some(cites):false;
  if(cites(b.observations)||cites(b.exitProofs)||details.advisory.metrics.some(m=>m.id!=='C10'&&cites(m)))fail();
}
