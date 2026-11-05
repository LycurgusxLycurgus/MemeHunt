import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { evidenceRecordSchema, tokenRefSchema, type TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { CALLER_SEED_METHOD, CALLER_SELECTION_ID, callerSeedFromEvidence, deriveCallerHistoryMetrics, replayCallerHistory } from './advisory-caller-measures.js';
import { CALLER_HISTORY_TRUST, callerHistoryKey, callerHistoryRequests, decodeCallerHistory, type CallerHistory } from './advisory-caller-history.js';
import { advisorySemanticRequests, validateAdvisorySemanticWire } from './advisory-semantic.js';
import { RECORDED_CALLER_LIMIT, RECORDED_CALLER_METHOD, RECORDED_CALLER_TRUST, decodeRecordedCallerCapture, deriveRecordedCallerMetrics } from './advisory-recorded-callers.js';

/**
 * Purpose-bound S20 source: one portable file of per-token PROVIDED_CALL_SAMPLE frames, each re-derived from original
 * raw bytes through the unchanged caller helpers. Source qualification only: no author intersection, recurrence, null or outcome.
 * Grants no authority to old namespaces and authorizes no entry or other metric; root central guards own admission.
 */
export const S20_IMPORT_METHOD='s20-provided-call-frame-import-v1',S20_PURPOSE='S20_PROVIDED_CALL_SAMPLE_FRAME',S20_FRAME_METHOD='s20-provided-call-frame-v1';
export const S20_FILE_BYTES=24*1024*1024,S20_FRAME_CAP=16,S20_HOSTED_ARTIFACT_BYTES=500_000;
export const S20_IDENTITY={unit:'X_USER_ID',namespace:'x.com',format:'DECIMAL_STRING',method:'syndication-fx-exact-status-user-id-v1',timeBasis:'AT_RECEIPT_RETRIEVAL',
  trust:'Native X user id read as a JSON string from official syndication user.id_str and FxTwitter tweet.author.id for the identical status id, handle and creation second. An id is an account, not a person, controller, campaign or wallet; the handle is display-at-retrieval only.'} as const;
export type S20Frame={token:TokenRef;identity:typeof S20_IDENTITY;universe:Array<Record<string,unknown>>;events:Array<Record<string,unknown>>;[k:string]:unknown};
export type S20FrameResult={status:'CLOSED';frameHash:string;frame:S20Frame}|{status:'UNCLOSED'|'SOURCE_UNAVAILABLE';code:string;details:string[]};
const instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/),DEC=/^[1-9][0-9]{0,19}$/;
const sha=(t:string)=>createHash('sha256').update(t,'utf8').digest('hex'),ms=(t:string)=>Date.parse(t);
/** Malformed or forged imports throw; honest gaps return UNCLOSED or SOURCE_UNAVAILABLE results. */
function fail(code:string):never{throw new Error('S20_SOURCE_'+code);}
function guard<T>(fn:()=>T,code:string):T{try{return fn();}catch(e){return fail(code+(e instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/.test(e.message)?':'+e.message:''));}}
const unclosed=(code:string,details:string[]=[]):S20FrameResult=>({status:'UNCLOSED',code,details});
const ref=z.object({key:z.string().regex(/^[A-Za-z0-9:._-]{1,240}$/),sha256:hash,bytes:z.number().int().positive().max(S20_FILE_BYTES)}).strict();
const base={frameId:z.string().regex(/^[a-z0-9-]{1,64}$/),token:tokenRefSchema,originalCutoff:instant};
const descriptor=z.object({requests:z.record(z.string(),z.unknown()),artifactIds:z.record(z.string(),z.string())}).strict();
const recordedSpec=z.object({...base,format:z.literal('RECORDED_CALLER_CAPTURE_V2'),outerImport:evidenceRecordSchema,capture:ref}).strict();
const hostedSpec=z.object({...base,format:z.literal('HOSTED_CALLER_PROOF_V23'),proofMethod:z.literal('advisory-provenance-v23'),callers:descriptor.extend({selectionId:z.literal(CALLER_SELECTION_ID)}).strict(),
  callerSemantic:descriptor.nullable(),evidence:z.array(evidenceRecordSchema).max(256),sources:z.record(z.string(),ref)}).strict();
const portableSchema=z.object({manifest:z.object({method:z.literal(S20_IMPORT_METHOD),purpose:z.literal(S20_PURPOSE),packagedAt:instant,
  frames:z.array(z.discriminatedUnion('format',[recordedSpec,hostedSpec])).min(1).max(S20_FRAME_CAP)}).strict(),rawSources:z.record(z.string(),z.string())}).strict();

type Bound={ok:true;userId:string;proof:{statusId:string;handleAtRetrieval:string;createdSecond:string;paths:string[];receiptSha256:Record<string,string>}}|{ok:false;code:string};
/** Positive identity only: same status, handle and second in both receipts and one decimal-string id. Never inferred from a handle or snowflake. */
function bindIdentity(statusId:string,handle:string,publishedAt:string,synRaw:string,fxRaw:string):Bound{
  const body=(raw:string):any=>{try{const r=JSON.parse(raw);return r?.status===200&&typeof r.body==='string'?JSON.parse(r.body):null;}catch{return null;}};
  const syn=body(synRaw),fx=body(fxRaw),t=fx?.tweet,no=(code:string):Bound=>({ok:false,code:'NATIVE_ID_'+code});
  if(syn?.__typename!=='Tweet'||fx?.code!==200||!t)return no('RECEIPT_UNAVAILABLE');
  if(syn.id_str!==statusId||t.id!==statusId)return no('STATUS_MISMATCH');
  if(String(syn.user?.screen_name).toLowerCase()!==handle||String(t.author?.screen_name).toLowerCase()!==handle)return no('HANDLE_MISMATCH');
  if(t.reposted_by!=null)return no('AUTHOR_ROLE');
  const a=syn.user.id_str,b=t.author.id;
  // A JSON number cannot carry a 64-bit id exactly, so it is ambiguous rather than coerced.
  if(typeof a==='number'||typeof b==='number')return no('NUMERIC_AMBIGUOUS');
  if(a==null||b==null)return no('MISSING');
  if(typeof a!=='string'||typeof b!=='string'||!DEC.test(a)||!DEC.test(b))return no('FORMAT');
  if(a!==b)return no('CONFLICT');
  if(ms(syn.created_at)!==ms(publishedAt)||t.created_timestamp*1000!==ms(publishedAt))return no('TIME_MISMATCH');
  return {ok:true,userId:a,proof:{statusId,handleAtRetrieval:handle,createdSecond:publishedAt,paths:['syndication.body.user.id_str','fxtwitter.body.tweet.author.id'],receiptSha256:{syndication:sha(synRaw),fxtwitter:sha(fxRaw)}}};
}

type Ctx={format:string;wire:string;token:TokenRef;history:CallerHistory;receipts:Record<string,string>;seedRaw:string;sampleIds:string[];s07:AdvisoryMetric|undefined;classification:object;clocks:Record<string,string>;catalog:Array<[string,string]>;availableAt:string};
/** Shared per-token frame: every provided seed member gets exactly one disposition; S07 is re-derived from raw and only checked, never imported. */
function frameOf(c:Ctx):S20FrameResult{
  const seed=JSON.parse(c.seedRaw) as {selection:{posts:Array<{seedSourceId:string}>};excluded:Array<{seedSourceId:string;reason:string}>};
  if(!same([...seed.selection.posts.map(p=>p.seedSourceId),...seed.excluded.map(e=>e.seedSourceId)].sort(),[...c.sampleIds].sort()))fail('SEED_MEMBERSHIP');
  const h=c.history,sources=new Map(h.socialInput.sources.map(s=>[s.id,s]));
  // Only a status verified outside the frozen period is an exclusion; any other missing body blocks closure.
  const blocking=h.layers.filter(l=>!l.bodyComplete&&l.failure!=='CALLER_OUTSIDE_PERIOD').map(l=>`${l.failure}:${l.seedSourceId}`);
  if(blocking.length)return unclosed('SOURCE_BODY_INCOMPLETE',blocking);
  if(sources.size&&c.s07?.quality!=='KNOWN')return unclosed(c.s07?.reasonCode??'S07_UNAVAILABLE');
  const d=(c.s07?.data??{classifications:[],events:[]}) as {classifications:Array<{sourceId:string;event:string;role:string}>;events:Array<Record<string,any>>};
  const cls=new Map(d.classifications.map(x=>[x.sourceId,x]));
  if([...cls.keys()].some(id=>!sources.has(id))||d.events.some(e=>cls.get(e.sourceId)?.event!=='FORWARD_CALL'))fail('S07_MEMBERSHIP');
  const ids=new Map<string,Bound>();
  for(const l of h.layers)if(l.bodyComplete)ids.set(l.sourceId,bindIdentity(l.statusId,l.canonicalUrl.split('/')[3]!,sources.get(l.sourceId)!.publishedAt!,c.receipts[callerHistoryKey(l.statusId,'syndication')]!,c.receipts[callerHistoryKey(l.statusId,'fxtwitter')]!));
  const unbound=d.events.flatMap(e=>{const b=ids.get(e.sourceId)!;return b.ok?[]:[`${b.code}:${e.sourceId}`];});
  if(unbound.length)return unclosed(unbound[0]!.split(':')[0]!,unbound);
  const byHandle=new Map<string,string>(),conflicts:string[]=[];
  for(const [id,b] of ids)if(b.ok){const handle=b.proof.handleAtRetrieval;if((byHandle.get(handle)??b.userId)!==b.userId)conflicts.push(id);byHandle.set(handle,b.userId);}
  if(conflicts.length)return unclosed('NATIVE_ID_CROSS_STATUS_CONFLICT',conflicts);
  const identity=(id:string)=>{const b=ids.get(id)!;return b.ok?{userId:b.userId}:{code:b.code};};
  const universe=c.sampleIds.map(seedSourceId=>{
    const x=seed.excluded.find(e=>e.seedSourceId===seedSourceId);
    if(x)return {seedSourceId,disposition:'SEED_EXCLUDED',reason:x.reason};
    const l=h.layers.find(y=>y.seedSourceId===seedSourceId)!;
    if(!l.bodyComplete)return {seedSourceId,statusId:l.statusId,disposition:'SELECTED_EXCLUDED',reason:'OUTSIDE_PERIOD_VERIFIED'};
    const k=cls.get(l.sourceId),row={seedSourceId,statusId:l.statusId,sourceId:l.sourceId,identity:identity(l.sourceId)};
    return !k?{...row,disposition:'SELECTED_EXCLUDED',reason:'UNRELATED',basis:'S07_KNOWN_ACCEPTED_BINDING'}
      :k.event!=='FORWARD_CALL'?{...row,disposition:'SELECTED_EXCLUDED',reason:'NON_FORWARD_CALL',event:k.event,role:k.role}:{...row,disposition:'ELIGIBLE',role:k.role};
  });
  // Handle-based authorId is dropped; the handle survives only as display-at-retrieval.
  const events=d.events.map(({authorId:_a,contract:_c,...e})=>{const b=ids.get(e.sourceId)! as Extract<Bound,{ok:true}>;
    return {...e,binding:'EXACT_CONTRACT',text:sources.get(e.sourceId)!.text,textSha256:sha(sources.get(e.sourceId)!.text),bodySource:h.layers.find(l=>l.sourceId===e.sourceId)!.bodySource,textBasis:'CURRENT_REVISION_AT_RETRIEVAL',completeness:h.layers.find(l=>l.sourceId===e.sourceId)!.completeness,retrievedAt:sources.get(e.sourceId)!.availableAt,
      nativeUserId:b.userId,handleAtRetrieval:b.proof.handleAtRetrieval,identityProof:b.proof};});
  const frame={method:S20_FRAME_METHOD,purpose:S20_PURPOSE,token:c.token,format:c.format,wire:c.wire,
    scope:{kind:'PROVIDED_CALL_SAMPLE',seedMethod:CALLER_SEED_METHOD,period:h.period,frozenAt:h.frozenAt,selectionHash:h.selectionHash,sourceScopeHash:h.sourceScopeHash,queries:h.socialInput.queries},
    rawSourceCatalog:{entries:c.catalog.length,sha256:sha(JSON.stringify([...c.catalog].sort()))},universe,events,
    closure:{kind:'PROVIDED_FIXED_SAMPLE_EXHAUSTED',rows:universe.length,queryExhaustive:false,platformExhaustive:false,unobserved:['PREDECESSOR_REVISION_BODIES','DELETED_OR_PLATFORM_UNSEEN_CALLS','STATUSES_OUTSIDE_RETAINED_QUERY_SAMPLE']},
    identity:S20_IDENTITY,classification:c.classification,clocks:{...c.clocks,receiptsRetrievedThrough:h.analysisCutoff,frameAvailableAt:c.availableAt},
    trust:[CALLER_HISTORY_TRUST,'Historical reconstruction under a contract proposed after hints were exposed: no preregistration or blinding is claimed. Hashes bind retained bytes, not provider, model or platform authenticity.']};
  return {status:'CLOSED',frameHash:sha(JSON.stringify(frame)),frame};
}

function recordedFrame(f:z.infer<typeof recordedSpec>,raw:string,packagedAt:string):S20FrameResult{
  const o=f.outerImport;
  if(Buffer.byteLength(raw)>RECORDED_CALLER_LIMIT||o.id!=='advisory-recorded-callers-capture'||o.sourceId!=='advisory-recorded-callers'||o.sourceType!=='HISTORICAL_RECEIPT'||o.adapterVersion!==RECORDED_CALLER_METHOD
    ||o.accessMode!=='USER_IMPORT'||!same(o.scope,{method:RECORDED_CALLER_METHOD})||o.contentHash!==sha(raw)||o.retrievedAt!==o.availableAt||ms(o.availableAt)>ms(f.originalCutoff)||ms(f.originalCutoff)>ms(packagedAt))fail('OUTER_IMPORT');
  // Unchanged decoder: seed rederivation, request/receipt clocks and qualification executions, all no later than the original outer import.
  const d=guard(()=>decodeRecordedCallerCapture(raw,f.token,o.availableAt),'RECORDED'),c=d.capture,q=c.qualification;
  // JSON escaping must not disguise an impossible UTF-8 preimage inside the recorded capture.
  for(const text of [...Object.values(c.seed.rawArtifacts),...Object.values(c.callers.rawArtifacts),...(q?[q.proposal.prompt,q.proposal.response,q.review.prompt,q.review.response]:[])])
    if(Buffer.from(text,'utf8').toString('utf8')!==text)fail('SOURCE_UTF8');
  if(!q)return {status:'SOURCE_UNAVAILABLE',code:'RECORDED_CLASSIFICATION_ABSENT',details:[]};
  const s07=deriveRecordedCallerMetrics(raw,f.token,o.availableAt,[o.id]).find(m=>m.id==='S07');
  return frameOf({format:f.format,wire:'recorded-caller-fields-v1',token:f.token,history:d.history,receipts:c.callers.rawArtifacts,seedRaw:c.seed.rawArtifacts[CALLER_SELECTION_ID]!,
    sampleIds:(JSON.parse(c.seed.rawArtifacts['attention-scope']!) as {postSampleSourceIds:string[]}).postSampleSourceIds,s07,availableAt:packagedAt,
    classification:{method:'recorded-caller-fields-v1',ingress:'USER_IMPORT',trust:RECORDED_CALLER_TRUST,executions:{proposal:q.proposal.execution,review:q.review.execution}},
    clocks:{seedFrozenAt:d.history.frozenAt,qualifiedAt:q.review.execution.finishedAt,outerImportAt:o.availableAt,originalCutoff:f.originalCutoff,packagedAt},
    catalog:[['capture',o.contentHash],...c.seed.evidence.map(e=>[e.id,e.contentHash] as [string,string]),...Object.entries(c.callers.rawArtifacts).map(([k,v])=>[k,sha(v)] as [string,string]),
      ['qualification-proposal',q.proposal.execution.responseSha256],['qualification-review',q.review.execution.responseSha256]]});
}

const SEM_REQUIRED=['advisory-semantic-selection','advisory-semantic-proposal-prompt','advisory-semantic-proposal-response','advisory-semantic-review-prompt','advisory-semantic-review-response'];
const SEM_KEY=/^advisory-semantic-(?:selection|(?:proposal|review)-(?:prompt|response|(?:response|transport)-attempt-\d{1,2}))$/;
function hostedFrame(f:z.infer<typeof hostedSpec>,raws:Record<string,string>,packagedAt:string):S20FrameResult{
  const ev=f.evidence,by=new Map(ev.map(e=>[e.id,e])),get=(id:string)=>by.get(id)??fail('CATALOG');
  if(by.size!==ev.length||!same(Object.keys(f.sources).sort(),[...by.keys()].sort())||ms(f.originalCutoff)>ms(packagedAt))fail('CATALOG');
  for(const e of ev)if(e.contentHash!==f.sources[e.id]!.sha256||e.adapterVersion!=='live-v1'||e.retrievedAt!==e.availableAt||ms(e.availableAt)>ms(f.originalCutoff)||Buffer.byteLength(raws[e.id]!)>S20_HOSTED_ARTIFACT_BYTES)fail('EVIDENCE');
  const scope=get('attention-scope'),sel=get(CALLER_SELECTION_ID),sampleIds=guard(()=>z.array(z.string()).parse(JSON.parse(raws[scope.id]!).postSampleSourceIds),'SEED_SCOPE'),pages=sampleIds.map(get);
  if(new Set(sampleIds).size!==sampleIds.length||scope.sourceId!=='attention-collector'||scope.sourceType!=='SAMPLE_SCOPE'||scope.accessMode!=='LOCAL_DERIVED'||!same(scope.scope,{method:'comparison-scope-v2'})
    ||sel.sourceId!=='advisory-collector'||sel.sourceType!=='SAMPLE_SCOPE'||sel.accessMode!=='LOCAL_DERIVED'||!same(sel.scope,{method:CALLER_SEED_METHOD})
    ||[scope,...pages].some(e=>ms(e.availableAt)>ms(sel.availableAt))||pages.some(e=>e.sourceId!=='tinyfish-fetch'||e.sourceType!=='WEB_PAGE'||e.accessMode!=='FREE_ACCOUNT'))fail('SEED_RECORD');
  const seed=callerSeedFromEvidence(f.token,[scope,sel,...pages],raws,sel.availableAt);
  if(seed.selection===null)return fail('SEED_BINDING');
  if(seed.raw!==raws[sel.id])fail('SEED_BINDING');
  const selection=seed.selection,expected=callerHistoryRequests(selection),receipts:Record<string,string>={},times:Record<string,string>={};
  if(!same(f.callers.requests,expected)||!same(Object.keys(f.callers.artifactIds).sort(),Object.keys(expected).sort()))fail('REQUEST_BINDING');
  for(const [key,id] of Object.entries(f.callers.artifactIds)){const e=get(id);
    if(id!==`advisory-callers-${key}`||e.sourceId!=='advisory-callers'||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='PUBLIC_API'||!same(e.scope,{request:expected[key]})
      ||guard(()=>JSON.parse(raws[id]!),'RECEIPT_BINDING')?.retrievedAt!==e.retrievedAt)fail('RECEIPT_BINDING');
    receipts[key]=raws[id]!;times[key]=e.retrievedAt;}
  const history=guard(()=>decodeCallerHistory(selection,receipts),'HISTORY'),sem=f.callerSemantic;
  if(!same([...by.keys()].sort(),[scope.id,sel.id,...sampleIds,...Object.values(f.callers.artifactIds),...Object.values(sem?.artifactIds??{})].sort()))fail('MEMBERSHIP');
  if(!sem)return {status:'SOURCE_UNAVAILABLE',code:'HOSTED_CLASSIFICATION_ABSENT',details:[]};
  const semIds=sem.artifactIds,keys=Object.keys(semIds),semRaw:Record<string,string>={};let qualifiedMs=0;
  if(!same([...keys].sort(),Object.keys(sem.requests).sort())||SEM_REQUIRED.some(k=>!keys.includes(k))||keys.some(k=>!SEM_KEY.test(k)))fail('SEMANTIC_CATALOG');
  for(const key of keys){const id=semIds[key]!,e=get(id),hosted=/prompt|response/.test(key),request={operation:key,modelRequests:advisorySemanticRequests()};
    if(id!==`advisory-callerSemantic-${key}`||e.sourceId!==(hosted?'gemini':'advisory-collector')||e.accessMode!==(hosted?'FREE_ACCOUNT':'LOCAL_DERIVED')||e.sourceType!=='HISTORICAL_RECEIPT'
      ||!same(e.scope,{request})||!same(sem.requests[key],request)||ms(e.availableAt)<ms(history.analysisCutoff))fail('SEMANTIC_BINDING');
    semRaw[key]=raws[id]!;qualifiedMs=Math.max(qualifiedMs,ms(e.availableAt));}
  // Original response bytes only: parseSourceResponse ignores opaque thought fields and reads the single final part.
  let semantic:ReturnType<typeof validateAdvisorySemanticWire>|null=null,code='ADV_SEMANTIC_INVALID';
  try{semantic=validateAdvisorySemanticWire(history.socialInput,semRaw,f.token,'v3');}catch(e){if(e instanceof Error&&/^ADV_SEMANTIC_[A-Z_0-9]+$/.test(e.message))code=e.message;}
  if(!semantic)return unclosed('CLASSIFICATION_FAILED',[code]);
  const s07=deriveCallerHistoryMetrics(f.token,f.originalCutoff,history,semantic,[...by.keys()]).find(m=>m.id==='S07');
  const replayed=guard(()=>replayCallerHistory(f.token,f.originalCutoff,ev,raws,{raw:receipts,times,requests:expected,ids:[]},CALLER_SELECTION_ID,{raw:semRaw,times:{},requests:{},ids:[]},'v3'),'REPLAY').find(m=>m.id==='S07');
  if(replayed?.quality!==s07?.quality||!same(replayed?.data,s07?.data))fail('REPLAY_DIVERGENCE');
  return frameOf({format:f.format,wire:semantic.method,token:f.token,history,receipts,seedRaw:raws[sel.id]!,sampleIds,s07,availableAt:packagedAt,
    classification:{method:semantic.method,ingress:'HOSTED_MODEL_RECEIPTS',proofMethod:f.proofMethod,trust:'Hosted model responses are retained operator/import bytes; hashes bind bytes, not provider or model signatures.',
      responseSha256:{proposal:sha(semRaw['advisory-semantic-proposal-response']!),review:sha(semRaw['advisory-semantic-review-response']!)}},
    clocks:{seedFrozenAt:history.frozenAt,qualifiedAt:new Date(qualifiedMs).toISOString(),originalCutoff:f.originalCutoff,packagedAt},catalog:ev.map(e=>[e.id,e.contentHash] as [string,string])});
}

/** Pure portable decoder: exact frame/source keysets, hashes and clocks, then per-format raw adapters. No path field is ever opened. */
export function decodeS20SourceFrames(text:string,cutoff:string){
  if(!instant.safeParse(cutoff).success)fail('CUTOFF');
  if(Buffer.byteLength(text,'utf8')>S20_FILE_BYTES||Buffer.from(text,'utf8').toString('utf8')!==text)fail('FILE_BOUND');
  const p=guard(()=>portableSchema.parse(JSON.parse(text)),'SCHEMA'),m=p.manifest;
  if(ms(m.packagedAt)>ms(cutoff))fail('CLOCK');
  const tokens=m.frames.map(f=>`${f.token.chain}:${f.token.address}`),frameIds=m.frames.map(f=>f.frameId);
  if(new Set(tokens).size!==tokens.length||new Set(frameIds).size!==frameIds.length)fail('FRAME_IDENTITY');
  const refs=m.frames.flatMap(f=>f.format==='RECORDED_CALLER_CAPTURE_V2'?[f.capture]:Object.values(f.sources)),keys=refs.map(r=>r.key);
  if(new Set(keys).size!==keys.length||!same([...keys].sort(),Object.keys(p.rawSources).sort()))fail('MEMBERSHIP');
  for(const r of refs){const raw=p.rawSources[r.key]!;if(Buffer.from(raw,'utf8').toString('utf8')!==raw)fail('SOURCE_UTF8');if(Buffer.byteLength(raw,'utf8')!==r.bytes||sha(raw)!==r.sha256)fail('SOURCE_HASH');}
  const frames=m.frames.map(f=>({frameId:f.frameId,token:f.token,format:f.format,result:f.format==='RECORDED_CALLER_CAPTURE_V2'?recordedFrame(f,p.rawSources[f.capture.key]!,m.packagedAt)
    :hostedFrame(f,Object.fromEntries(Object.entries(f.sources).map(([id,r])=>[id,p.rawSources[r.key]!])),m.packagedAt)}));
  // Comparability is declared on the identity basis only; search coverage, window alignment and shared ids are neither asserted nor computed.
  return {method:S20_IMPORT_METHOD,purpose:S20_PURPOSE,sha256:sha(text),packagedAt:m.packagedAt,cutoff,frames,
    comparability:{identity:S20_IDENTITY,identityBasisIdenticalAcrossClosedFrames:frames.every(x=>x.result.status!=='CLOSED'||same(x.result.frame.identity,S20_IDENTITY)),
      searchCoverageEqual:'NOT_ASSERTED' as const,windowAligned:'NOT_ASSERTED' as const,sharedIdentitiesComputed:false as const}};
}
/** One bounded regular UTF-8 file, opened without following links. */
export function loadS20SourceFrames(file:string,cutoff:string){
  let fd:number|undefined,bytes:Buffer=Buffer.alloc(0);
  try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>S20_FILE_BYTES)fail('FILE_BOUND');bytes=readFileSync(fd);if(bytes.length!==st.size||bytes.length>S20_FILE_BYTES)fail('FILE_BOUND');}
  catch(e){return fail(e instanceof Error&&e.message.startsWith('S20_SOURCE_')?e.message.slice(11):'FILE_OPEN');}
  finally{if(fd!==undefined)closeSync(fd);}
  const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))fail('UTF8');
  return decodeS20SourceFrames(text,cutoff);
}
