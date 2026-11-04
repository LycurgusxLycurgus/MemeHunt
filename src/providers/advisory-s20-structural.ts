import {createHash} from 'node:crypto';
import {constants,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef,type EvidenceRecord} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodeS20SourceFrames,S20_FILE_BYTES,S20_FRAME_CAP,S20_IDENTITY,S20_IMPORT_METHOD,S20_FRAME_METHOD,S20_PURPOSE as S20_FRAME_PURPOSE} from './advisory-s20-source-frames.js';
// Dedicated S20 structural purpose over one retained portable source-frame file; the source-frame decoder alone derives and qualifies frames.
export const S20_SOURCE_ID='advisory-s20-structural',S20_SOURCE_PREFIX=S20_SOURCE_ID+'-',S20_CAPTURE_ID=S20_SOURCE_PREFIX+'capture';
export const S20_ADAPTER='s20-provided-sample-structural-source-v1',S20_PURPOSE='PROVIDED_CALL_SAMPLE_STRUCTURAL_RECURRENCE';
export const S20_METRIC_METHOD='s20-provided-sample-structural-recurrence-v1',S20_MIN_CALLERS=2,S20_MIN_FRAMES=2;
export const S20_EVIDENCE_IDS:readonly string[]=[S20_CAPTURE_ID];
export const S20_REASONS={known:'S20_RECURRENCE_DISPROVEN_IN_SUPPLIED_SAMPLES',notMember:'S20_TOKEN_NOT_MEMBER',insufficient:'S20_INSUFFICIENT_TOKEN_FRAMES',unclosed:'S20_SOURCE_FRAME_UNCLOSED',notDisproven:'S20_NECESSARY_CONDITION_NOT_DISPROVEN'} as const;
export type S20Decoded=ReturnType<typeof decodeS20SourceFrames>;
export type S20WireRecord={id:string;raw:string;scope:Record<string,unknown>;retrievedAt:string};
const fail=(code:string):never=>{throw Error('S20_STRUCTURAL_'+code);};
const check=(v:unknown,code:string):void=>{if(!v)fail(code);};
const instant=z.iso.datetime({offset:true}),hex=z.string().regex(/^[a-f0-9]{64}$/),DEC=/^[1-9][0-9]{0,19}$/;
const key=(t:TokenRef)=>t.chain+':'+t.address,byDecimal=(a:string,b:string)=>a.length-b.length||(a<b?-1:a>b?1:0);
const plain=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
export const s20Scope=()=>({method:S20_ADAPTER,purpose:S20_PURPOSE,role:'CAPTURE'});
export const s20Hash=(raw:string)=>createHash('sha256').update(raw,'utf8').digest('hex');
export const s20Owns=(e:EvidenceRecord)=>e.sourceId===S20_SOURCE_ID||e.id.startsWith(S20_SOURCE_PREFIX)||e.adapterVersion===S20_ADAPTER;

/** One bounded regular UTF-8 file read once without following links; its exact text is the single capture record. No manifest-named path is opened. */
export function loadS20StructuralCapture(file:string,token:TokenRef,cutoff:string):{records:S20WireRecord[]}{
 check(tokenRefSchema.safeParse(token).success&&token.chain==='solana','TOKEN');
 let fd:number|undefined,bytes:Buffer=Buffer.alloc(0);
 try{
  fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);
  if(!st.isFile()||st.size>S20_FILE_BYTES)fail('FILE_BOUND');
  // One extra byte detects growth after fstat without an unbounded read.
  const buffer=Buffer.alloc(st.size+1);let read=0;
  for(;;){const n=readSync(fd,buffer,read,buffer.length-read,read);if(n===0)break;read+=n;if(read===buffer.length)break;}
  if(read!==st.size)fail('FILE_BOUND');bytes=buffer.subarray(0,read);
 }finally{if(fd!==undefined)closeSync(fd);}
 const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))fail('UTF8');
 const decoded=decodeS20SourceFrames(text,cutoff);
 return{records:[{id:S20_CAPTURE_ID,raw:text,scope:s20Scope(),retrievedAt:decoded.packagedAt}]};
}

const rowSchema=z.object({seedSourceId:z.string().min(1),statusId:z.string().regex(DEC).optional(),sourceId:z.string().min(1).optional(),
 identity:z.union([z.object({userId:z.string().regex(DEC)}).strict(),z.object({code:z.string().min(1)}).strict()]).optional(),
 disposition:z.enum(['ELIGIBLE','SELECTED_EXCLUDED','SEED_EXCLUDED']),reason:z.string().min(1).optional(),event:z.string().min(1).optional(),role:z.string().min(1).optional(),basis:z.string().min(1).optional()}).strict();
const eventSchema=z.object({sourceId:z.string().min(1),statusId:z.string().regex(DEC),publishedAt:instant,retrievedAt:instant,role:z.string().min(1),classification:z.literal('FORWARD_CALL'),binding:z.literal('EXACT_CONTRACT'),
 textSha256:hex,bodySha256:hex,nativeUserId:z.string().regex(DEC),handleAtRetrieval:z.string().min(1),
 identityProof:z.object({statusId:z.string(),handleAtRetrieval:z.string(),createdSecond:instant,paths:z.tuple([z.literal('syndication.body.user.id_str'),z.literal('fxtwitter.body.tweet.author.id')]),receiptSha256:z.object({syndication:hex,fxtwitter:hex}).strict()}).strict()});
const frameSchema=z.object({method:z.literal(S20_FRAME_METHOD),purpose:z.literal(S20_FRAME_PURPOSE),token:tokenRefSchema,format:z.enum(['RECORDED_CALLER_CAPTURE_V2','HOSTED_CALLER_PROOF_V23']),wire:z.string().min(1),
 scope:z.object({kind:z.literal('PROVIDED_CALL_SAMPLE'),seedMethod:z.string().min(1),period:z.object({start:instant,end:instant}).strict(),frozenAt:instant,selectionHash:hex,sourceScopeHash:hex,queries:z.array(z.string())}).strict(),
 rawSourceCatalog:z.object({entries:z.number().int().nonnegative(),sha256:hex}).strict(),universe:z.array(rowSchema),events:z.array(eventSchema),
 closure:z.object({kind:z.literal('PROVIDED_FIXED_SAMPLE_EXHAUSTED'),rows:z.number().int().nonnegative(),queryExhaustive:z.literal(false),platformExhaustive:z.literal(false),unobserved:z.array(z.string())}).strict(),
 identity:z.unknown(),classification:z.record(z.string(),z.unknown()),clocks:z.record(z.string(),instant),trust:z.array(z.string())});

type Frame=S20Decoded['frames'][number];
type Callers=Map<string,{posts:number;handles:string[]}>;
type Projected={closed:boolean;callers:Callers|null;view:Record<string,unknown>};
/** Auditable projection of one declared frame. Raw text, citations and hosted model bodies are never projected; original clocks are kept verbatim. */
function project(f:Frame,current:string,packagedAt:string):Projected{
 const base={frameId:f.frameId,token:f.token,format:f.format,member:key(f.token)===current},r=f.result;
 if(r.status!=='CLOSED'){
  check((r.status==='UNCLOSED'||r.status==='SOURCE_UNAVAILABLE')&&typeof r.code==='string'&&r.code.length>0&&Array.isArray(r.details)&&r.details.every(x=>typeof x==='string'),'FRAME_RESULT');
  // An unknown source is never an empty frame: rows, events and callers stay null.
  return{closed:false,callers:null,view:{...base,status:r.status,code:r.code,details:[...r.details],frameHash:null,rows:null,eventCount:null,callers:null,events:null}};
 }
 check(hex.safeParse(r.frameHash).success&&s20Hash(JSON.stringify(r.frame))===r.frameHash,'FRAME_HASH');
 const parsed=frameSchema.safeParse(r.frame),fr=parsed.success?parsed.data:fail('FRAME_SHAPE');
 check(key(fr.token)===key(f.token)&&fr.format===f.format&&same(fr.identity,S20_IDENTITY)&&fr.closure.rows===fr.universe.length&&fr.clocks.packagedAt===packagedAt&&fr.clocks.frameAvailableAt===packagedAt,'FRAME_BINDING');
 // Callers are native ids only; a handle-derived authorId or a bare userId field is never an identity.
 check(r.frame.events.every(e=>!Object.hasOwn(e,'authorId')&&!Object.hasOwn(e,'userId')),'IDENTITY_FIELD');
 const eligible=fr.universe.filter(u=>u.disposition==='ELIGIBLE');
 // Every non-eligible row is a positive exclusion with a stated reason; only eligible rows carry a caller.
 check(fr.universe.every(u=>u.disposition==='ELIGIBLE'?!!u.sourceId&&!!u.statusId&&!!u.identity&&'userId' in u.identity&&u.reason===undefined:!!u.reason),'EXCLUSION');
 check(eligible.length===fr.events.length&&new Set(fr.events.map(e=>e.sourceId)).size===fr.events.length,'EVENT_MEMBERSHIP');
 const callers:Callers=new Map();
 for(const e of fr.events){
  const row=eligible.find(u=>u.sourceId===e.sourceId),identity=row?.identity,userId=identity&&'userId' in identity?identity.userId:null,proof=e.identityProof;
  check(row&&row.statusId===e.statusId&&userId===e.nativeUserId&&proof.statusId===e.statusId&&proof.handleAtRetrieval===e.handleAtRetrieval&&Date.parse(proof.createdSecond)===Date.parse(e.publishedAt),'IDENTITY_PROOF');
  // Repeated posts by one native id inside a frame are one occurrence of that id in the frame.
  const c=callers.get(e.nativeUserId)??{posts:0,handles:[]};c.posts++;if(!c.handles.includes(e.handleAtRetrieval))c.handles.push(e.handleAtRetrieval);callers.set(e.nativeUserId,c);
 }
 const ids=[...callers.keys()].sort(byDecimal);
 return{closed:true,callers,view:{...base,status:'CLOSED',frameHash:r.frameHash,wire:fr.wire,scope:fr.scope,rawSourceCatalog:fr.rawSourceCatalog,closure:fr.closure,
  rows:fr.universe.length,eventCount:fr.events.length,eligibleRows:eligible.length,
  exclusions:r.frame.universe.filter(u=>u.disposition!=='ELIGIBLE').map(u=>Object.fromEntries(Object.entries(u).filter(([k])=>k!=='identity'))),
  callers:ids.map(id=>({nativeUserId:id,posts:callers.get(id)!.posts,handlesAtRetrieval:callers.get(id)!.handles})),
  events:fr.events.map(e=>({sourceId:e.sourceId,statusId:e.statusId,publishedAt:e.publishedAt,retrievedAt:e.retrievedAt,role:e.role,nativeUserId:e.nativeUserId,handleAtRetrieval:e.handleAtRetrieval,textSha256:e.textSha256,bodySha256:e.bodySha256,identityReceiptSha256:e.identityProof.receiptSha256})),
  classification:fr.classification,clocks:fr.clocks}};
}

const SCOPE={kind:'PROVIDED_CALL_SAMPLE_FRAMES',unit:'X_USER_ID',
 population:'Every row of exactly the declared provided call seed sample frames; not all X, matched current windows, market population, deleted or platform-unseen statuses or predecessor revisions.',
 callers:'Only ELIGIBLE rows with a qualified FORWARD_CALL event carry a caller; every other row is a positive exclusion.',
 identity:'Native X account id as a decimal string corroborated by the responsible frame decoder; an id is an account, not a person, wallet, controller or campaign, and the handle is display-at-retrieval only.'};
const THRESHOLD={minimumDistinctCallers:S20_MIN_CALLERS,minimumDistinctTokenFrames:S20_MIN_FRAMES,basis:'HARD_FROZEN_ORIGINAL_COMPATIBLE',higherPositiveKernelEvaluated:false,textSpacingTiesEvaluated:false,orderTieBreakEvaluated:false,nullModelEvaluated:false,flowEvaluated:false};
const INTERPRETATION={entireS20PositiveProcessAsserted:false,globalNoCampaignAsserted:false,campaignAbsenceAsserted:false,personIdentityAsserted:false,walletControlAsserted:false,searchCoverageEqual:'NOT_ASSERTED',windowAligned:'NOT_ASSERTED',retrospectiveAfterFreeze:true,preregistered:false,blinded:false,independentDiscovery:false};
const PREDICATE='Any recurring ordered set of at least 2 distinct native caller ids across at least 2 distinct token frames implies at least 2 native ids each occurring in at least 2 distinct token frames; fewer such ids disproves every such recurrence in these samples.';
const COUNTING='A native id counts at most once per frame; repeated posts by the same id within one frame are one occurrence. Handles never join or split ids.';
const PRIOR='Existing sourcefit hints about shared identities, older proposed profiles and source formats were exposed before the contract freeze. This is retrospective secondary analysis fixed before the structural comparison, not preregistration, blinding or independent discovery.';
const LIMITATIONS=[
 'A KNOWN zero counts only the scoped recurring ordered caller-set family in exactly these supplied provided call samples. It is not the entire S20 positive process and asserts no global no-campaign, person, wallet or campaign absence.',
 'Only the hard frozen original-compatible necessary predicate is evaluated; no higher positive kernel, text or spacing tie-break, cohort flow, positive examples or null model is evaluated, so campaignFlag stays null and NOT_EVALUATED.',
 'Search coverage and window alignment across frames are not asserted; predecessor revisions, deleted or platform-unseen calls and statuses outside the retained query samples are unobserved.',
 'Native X ids come from official syndication and FxTwitter receipts as qualified by the responsible frame decoder; hashes bind retained bytes, not provider, model or platform authenticity.',
 'The value became available at the retrospective packaging after the contract freeze and after prior hint exposure.',
 'A non-member token, a single provided frame, an unclosed or unavailable source frame reports MISSING with a null count, never zero.'];

/** Pure S20 projection from one decoded portable source. Hard shape errors throw; every honest gap is MISSING with a null count. */
export function deriveS20StructuralMetric(token:TokenRef,decoded:S20Decoded,ids:readonly string[]):AdvisoryMetric{
 check(same([...ids],[...S20_EVIDENCE_IDS]),'EVIDENCE_IDS');
 check(tokenRefSchema.safeParse(token).success,'TOKEN');
 const d=decoded,frames=d.frames;
 check(d.method===S20_IMPORT_METHOD&&d.purpose===S20_FRAME_PURPOSE&&hex.safeParse(d.sha256).success&&instant.safeParse(d.packagedAt).success&&instant.safeParse(d.cutoff).success&&Date.parse(d.packagedAt)<=Date.parse(d.cutoff),'SOURCE');
 check(Array.isArray(frames)&&frames.length>=1&&frames.length<=S20_FRAME_CAP,'FRAME_COUNT');
 check(new Set(frames.map(f=>key(f.token))).size===frames.length&&new Set(frames.map(f=>f.frameId)).size===frames.length,'FRAME_IDENTITY');
 check(d.comparability?.identityBasisIdenticalAcrossClosedFrames===true&&same(d.comparability.identity,S20_IDENTITY)&&d.comparability.sharedIdentitiesComputed===false,'COMPARABILITY');
 const current=key(token),projected=frames.map(f=>project(f,current,d.packagedAt)),member=frames.find(f=>key(f.token)===current)??null;
 const blockers:string[]=[];
 if(!member)blockers.push(S20_REASONS.notMember);
 // The frozen threshold needs two distinct token frames; one provided frame is never a vacuous zero.
 if(frames.length<S20_MIN_FRAMES)blockers.push(S20_REASONS.insufficient);
 if(projected.some(p=>!p.closed))blockers.push(S20_REASONS.unclosed);
 let predicate:Record<string,unknown>|null=null,known=false,reasonCode:string=blockers[0]??S20_REASONS.notDisproven;
 if(!blockers.length){
  const occurrences=new Map<string,string[]>();
  projected.forEach((p,i)=>{for(const id of p.callers!.keys())occurrences.set(id,[...(occurrences.get(id)??[]),frames[i]!.frameId]);});
  const all=[...occurrences.keys()].sort(byDecimal),recurring=all.filter(id=>occurrences.get(id)!.length>=S20_MIN_FRAMES);
  known=recurring.length<S20_MIN_CALLERS;reasonCode=known?S20_REASONS.known:S20_REASONS.notDisproven;
  predicate={statement:PREDICATE,countingRule:COUNTING,distinctNativeIds:all.length,frameOccurrences:all.map(id=>({nativeUserId:id,frameIds:occurrences.get(id)!})),
   idsInAtLeastTwoFrames:recurring.map(id=>({nativeUserId:id,frameIds:occurrences.get(id)!})),recurringIdCount:recurring.length,minimumRecurringIds:S20_MIN_CALLERS,satisfied:!known,disprovesRecurrence:known};
 }
 const closedViews=projected.filter(p=>p.closed),allClosed=closedViews.length===projected.length,total=(field:string)=>closedViews.reduce((n,p)=>n+(p.view[field] as number),0);
 const data={method:S20_METRIC_METHOD,purpose:S20_PURPOSE,token,scope:SCOPE,
  source:{importMethod:d.method,importPurpose:d.purpose,sha256:d.sha256,packagedAt:d.packagedAt,declaredFrames:frames.length,frameCap:S20_FRAME_CAP,comparability:d.comparability},
  membership:{currentTokenMember:member!==null,frameId:member?.frameId??null,declaredTokens:frames.map(f=>f.token)},
  universe:{frames:projected.map(p=>p.view),closedFrames:closedViews.length,notClosedFrames:projected.length-closedViews.length,rows:allClosed?total('rows'):null,events:allClosed?total('eventCount'):null},
  threshold:THRESHOLD,blockers,necessaryPredicateEvaluated:predicate!==null,necessaryPredicate:predicate,
  recurrence:{value:known?0:null,unit:'RECURRING_ORDERED_CALLER_SET_FAMILY',scope:'SUPPLIED_PROVIDED_CALL_SAMPLES_ONLY',globalPointValue:null},
  campaignFlag:null,campaignFlagStatus:'NOT_EVALUATED',flow:'NOT_EVALUATED',positiveExamples:'NOT_EVALUATED',nullModel:'NOT_EVALUATED',interpretation:INTERPRETATION,
  clocks:{eventClock:'X_STATUS_CREATION_SECOND',frameClocks:'PRESERVED_PER_FRAME',packagedAt:d.packagedAt,cutoff:d.cutoff,measurementAvailableAt:known?d.packagedAt:null},
  priorExposure:PRIOR,limitations:LIMITATIONS};
 return{id:'S20',quality:known?'KNOWN':'MISSING',unit:'scoped-record',reasonCode,evidenceIds:[...ids],data:plain(data)};
}

/** Full S20 source: exactly one owned record holding the original file text, its hash, scope and packaging clock, decoded by the unchanged frame decoder. */
export function validateS20StructuralSource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>):{ids:string[];metric:AdvisoryMetric}{
 const raw=rawArtifacts[S20_CAPTURE_ID];check(typeof raw==='string','CAPTURE_REQUIRED');
 const ids=[...S20_EVIDENCE_IDS],owned=evidence.filter(s20Owns),rawIds=Object.keys(rawArtifacts).filter(id=>id.startsWith(S20_SOURCE_PREFIX));
 check(owned.length===1&&owned[0]!.id===S20_CAPTURE_ID&&evidence.filter(e=>e.id===S20_CAPTURE_ID).length===1&&same(rawIds,ids),'CATALOG');
 const e=owned[0]!,text=raw as string;
 check(e.sourceId===S20_SOURCE_ID&&e.adapterVersion===S20_ADAPTER&&e.sourceType==='HISTORICAL_RECEIPT'&&e.accessMode==='USER_IMPORT'&&e.contentHash===s20Hash(text)&&same(e.scope,s20Scope()),'EVIDENCE');
 check(token.chain==='solana'&&instant.safeParse(cutoff).success,'TOKEN');
 const decoded=decodeS20SourceFrames(text,cutoff);
 check(e.retrievedAt===decoded.packagedAt&&e.availableAt===decoded.packagedAt&&Date.parse(decoded.packagedAt)<=Date.parse(cutoff),'CLOCK');
 return{ids,metric:deriveS20StructuralMetric(token,decoded,ids)};
}
