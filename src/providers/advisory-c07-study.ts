import {z} from 'zod';
import {s18Instant} from './advisory-s18-study.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';

/** Internal, source-reconstructed DTO. This module authenticates no raw bytes or source completeness. */
export const C07_SCOPE={
 population:'FROZEN_SELECTED_PUMPSWAP_WSOL_VENUE',
 nativeQuote:'FEE_EXCLUSIVE_CORE_WSOL_ATOMIC_DECIMALS_9_BUY_MINUS_SELL_NO_USD_OR_CROSS_ASSET_AGGREGATION',
 buyers:'FIRST_OBSERVED_MEANINGFUL_EVENT_USER_IN_TWELVE_HOUR_TAPE_NOT_PEOPLE_OR_NEW_CAPITAL',
 attention:'FIXED_TWO_QUERY_TOP10_DELIVERED_NATIVE_STATUS_SAMPLE_NOT_GLOBAL_ATTENTION',
 interpretation:'DESCRIPTIVE_SCOPED_OPERATIONAL_HYPOTHESIS_NOT_GLOBAL_OR_TRUE_TOKEN_LIFECYCLE',
 calibration:'ADJACENT_COMPARISONS_SHARE_A_WINDOW_NOT_INDEPENDENT_NO_SIGNIFICANCE_PREDICTIVE_OR_CAUSAL_VALIDATION',
 temporal:'RETROSPECTIVE_RECONSTRUCTION_NOT_KNOWLEDGE_AS_OF_WINDOW_END',
 zeroPosts:'FINITE_SAMPLE_NONCONTRADICTION_ONLY_NOT_PLATFORM_QUIET_OR_ATTENTION_DECLINE',
 sourceAuthority:'ROOT_RAW_SOURCE_BOUNDARY_ONLY_DTO_COMPLETE_AND_IDS_DO_NOT_AUTHENTICATE_SOURCE',
} as const;
export const C07_METHOD='c07-observed-wsol-demand-lifecycle-hypothesis-v2' as const;
export const C07_PROFILE_SHA256='2f93c309802810f6a8212a5badcc2c0bb3f37e9c80610184b9b19eb8fe1a1eec';
export const C07_PARENT_SHA256='cf1bc1963d1763bf5201d795dbb810a79128a13d14d5582e85778471aefa2b59';
export const C07_DISCOVERY_SHA256='997c8bcc75a2372776c73ea38a93415271652bda14bcc632319a9503d2b8bdcc';
export const C07_SOURCE_PLAN_SHA256='1640670f3fd70c887fd77ae2b4f4be012fdca9e61a280932d95b409ba98c276a';
export const C07_WSOL='So11111111111111111111111111111111111111112';
export const C07_START='2026-11-04T20:00:00Z',C07_END='2026-11-05T08:00:00Z';
export const C07_BINS=[['2026-11-05T02:00:00Z','2026-11-05T04:00:00Z'],['2026-11-05T04:00:00Z','2026-11-05T06:00:00Z'],['2026-11-05T06:00:00Z','2026-11-05T08:00:00Z']] as const;
export const C07_COHORT=[
 ['3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump','4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E'],
 ['8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump','GBzd5ooMFkYtYgzUMKfzyaEJpvzxvm5FK4FDJcpVJJcH'],
 ['C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump',null],
 ['CXWNzqBE98SSmkGgHogJZd9vjsLdgaMAFpVfV22ypump',null],
 ['DffdPtAKvnP91k9Ct6QvZ8TwVvWbJ6CxRtGNGNh9pump',null],
 ['DnMszBSMJhfh8St9Zhp4vABw9KFdFsNtyGWnt9rNpump','FsT4AGQPujmDRgkrPSY5G9UeXKPASpZa7xePCqi3oHon'],
 ['nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump',null],
] as const;
const text=z.string().min(1).max(100000),id=z.string().min(1).max(512),instant=z.string().refine(v=>s18Instant(v)!==null),uint=z.string().regex(/^(0|[1-9][0-9]{0,77})$/),safe=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ids=z.array(id).max(1000000).refine(a=>new Set(a).size===a.length);
const tokenSchema=z.object({chain:z.literal('solana'),address:id}).strict();
const health=z.object({status:z.enum(['COMPLETE','MISSING','UNCOMPARABLE']),reason:text.nullable()}).strict().superRefine((v,c)=>{if((v.status==='COMPLETE')!==(v.reason===null))c.addIssue({code:'custom',message:'C07_HEALTH_REASON'});});
const bins=z.tuple([health,health,health]);
export const c07StudyEventSchema=z.object({signature:id,instructionOrdinal:safe,eventOrdinal:safe,blockTime:safe,programTimestamp:z.string().regex(/^(0|-?[1-9][0-9]{0,77})$/),slot:safe,transactionIndex:safe.nullable(),user:id,side:z.enum(['BUY','SELL']),coreQuoteAtomic:uint,cpiAuthorizedAccounts:ids}).strict();
const source=z.object({status:z.enum(['COMPLETE','MISSING','UNCOMPARABLE']),reason:text.nullable(),sourceIds:ids,availableAt:instant,windows:bins}).strict();
export const c07StudyNativeSchema=source.extend({events:z.array(c07StudyEventSchema).max(1000000)}).strict();
export const c07StudyPostSchema=z.object({statusId:z.string().regex(/^[1-9][0-9]{0,29}$/),publishedAt:instant,accepted:z.boolean(),authorId:id,ownText:z.string().max(100000),originalKind:z.enum(['ORIGINAL','COMMENTARY','FORWARD']),role:z.enum(['CALL','NEWS','JOKE','WARNING','RETROSPECTIVE','PRICE_ONLY','OTHER']),qualificationAt:instant,sourceIds:ids,ownBodyMintQuote:text.nullable(),reason:text}).strict();
export const c07StudyAttentionSchema=source.extend({posts:z.array(c07StudyPostSchema).max(20)}).strict();
export const c07StudyAssetSchema=z.object({token:tokenSchema,pool:id.nullable(),quoteMint:z.literal(C07_WSOL),quoteDecimals:z.literal(9),native:c07StudyNativeSchema,attention:c07StudyAttentionSchema}).strict();
export const c07StudyInputSchema=z.object({method:z.literal(C07_METHOD),profileSha256:z.literal(C07_PROFILE_SHA256),parentSelectionSha256:z.literal(C07_PARENT_SHA256),poolDiscoverySha256:z.literal(C07_DISCOVERY_SHA256),sourcePlanSha256:z.literal(C07_SOURCE_PLAN_SHA256),range:z.object({start:z.literal(C07_START),end:z.literal(C07_END)}).strict(),packagedAt:instant,evaluationCutoff:instant,assets:z.array(c07StudyAssetSchema).length(7)}).strict();
export type C07StudyInput=z.infer<typeof c07StudyInputSchema>;
export type C07StudyEvent=z.infer<typeof c07StudyEventSchema>;
export type C07StudyAsset=z.infer<typeof c07StudyAssetSchema>;
export type C07StudyNative=z.infer<typeof c07StudyNativeSchema>;
export type C07StudyAttention=z.infer<typeof c07StudyAttentionSchema>;
export type C07State='UNKNOWN'|'DECAY'|'EXPANSION'|'INACTIVE';
export type C07Measure={firstBuyers:bigint;buy:bigint;sell:bigint;net:bigint;posts:bigint};
export type C07Memory={effective:C07State;pending:Exclude<C07State,'UNKNOWN'>|null;inconclusive:0|1|2;confirmedAt:string|null;reason:string};
export const initialC07Memory=():C07Memory=>({effective:'UNKNOWN',pending:null,inconclusive:0,confirmedAt:null,reason:'C07_NO_COMPARISON'});
export function compareC07(prev:C07Measure,cur:C07Measure):C07State{
 if(cur.firstBuyers===0n&&cur.buy===0n&&cur.sell===0n&&cur.posts===0n)return 'INACTIVE';
 if(cur.firstBuyers<prev.firstBuyers&&cur.net<prev.net&&cur.posts<=prev.posts)return 'DECAY';
 if(cur.firstBuyers>prev.firstBuyers&&cur.net>prev.net&&cur.posts>=prev.posts)return 'EXPANSION';
 return 'UNKNOWN';
}
export function transitionC07(m:C07Memory,c:C07State|'INVALIDATE',at:string):C07Memory{
 if(c==='INVALIDATE')return {...initialC07Memory(),reason:'C07_SOURCE_INVALIDATED'};
 if(c==='UNKNOWN')return m.inconclusive>=1?{...initialC07Memory(),inconclusive:2,reason:'C07_INCONCLUSIVE_EXPIRED'}:{...m,pending:null,inconclusive:1,reason:m.effective==='UNKNOWN'?'C07_NO_SUPPORTED_CANDIDATE':m.reason};
 if(c===m.effective)return {...m,pending:null,inconclusive:0};
 if(c===m.pending)return {effective:c,pending:null,inconclusive:0,confirmedAt:at,reason:'C07_CONFIRMED'};
 return {...m,pending:c,inconclusive:0,reason:m.effective==='UNKNOWN'?'C07_CANDIDATE_PENDING_CONFIRMATION':m.reason};
}
const must=(v:unknown,code:string):void=>{if(!v)throw new Error('C07_'+code);};
const at=(v:string)=>s18Instant(v)!;
const physical=(e:C07StudyEvent)=>JSON.stringify([e.signature,e.instructionOrdinal,e.eventOrdinal]);
/** Full source shape, membership and clocks validated before any token-specific early return. No I/O. */
function prepare(raw:unknown):C07StudyInput{
 const x=c07StudyInputSchema.parse(raw),cutoff=at(x.evaluationCutoff),packaged=at(x.packagedAt);
 must(packaged<=cutoff&&packaged>=at(C07_END),'PACKAGING_CLOCK');
 const mintSet=new Set(x.assets.map(a=>a.token.address));must(mintSet.size===7,'COHORT_DUPLICATE');
 const allPhysical=new Set<string>();
 for(const a of x.assets){
  const expected=C07_COHORT.find(t=>t[0]===a.token.address);must(expected&&expected[1]===a.pool,'COHORT_POOL_BINDING');
  for(const s of [a.native,a.attention]){
   must((s.status==='COMPLETE')===(s.reason===null),'SOURCE_REASON');
   must(at(s.availableAt)>=at(C07_END)&&at(s.availableAt)<=packaged,'SOURCE_CLOCK');
   must(s.status!=='COMPLETE'||s.sourceIds.length>0,'SOURCE_IDS');
   must(s.status==='COMPLETE'||s.windows.every(w=>w.status!=='COMPLETE'),'SOURCE_HEALTH');
  }
  if(a.pool===null)must(a.native.status==='MISSING'&&a.native.events.length===0,'UNSUPPORTED_POOL');
  for(const e of a.native.events){
   must(e.blockTime>=1793822400&&e.blockTime<1793865600,'EVENT_RANGE');
   const key=physical(e);must(!allPhysical.has(key),'DUPLICATE_PHYSICAL_EVENT');allPhysical.add(key);
  }
  must(new Set(a.attention.posts.map(p=>p.statusId)).size===a.attention.posts.length,'DUPLICATE_POST');
  for(const p of a.attention.posts){
   must(p.sourceIds.length>0&&at(p.qualificationAt)>=at(a.attention.availableAt)&&at(p.qualificationAt)<=packaged,'POST_CLOCK_OR_SOURCE');
   if(p.accepted)must((p.originalKind==='ORIGINAL'||p.originalKind==='COMMENTARY')&&['CALL','NEWS','JOKE'].includes(p.role)&&p.ownBodyMintQuote!==null&&p.ownText.includes(p.ownBodyMintQuote),'POST_QUALIFICATION');
  }
 }
 return x;
}
export type C07StudyWindow={start:string;end:string;status:'COMPLETE'|'MISSING'|'UNCOMPARABLE';reason:string|null;firstMeaningfulBuyerIds:string[]|null;newMeaningfulBuyerCount:string|null;buyQuoteAtomic:string|null;sellQuoteAtomic:string|null;netQuoteAtomic:string|null;qualifiedPostIds:string[]|null;providedPostCount:string|null;candidate:C07State|null;effective:C07State;pending:C07Memory['pending'];inconclusiveCount:number};
export type C07StudyAssetResult={token:C07StudyAsset['token'];pool:string|null;quality:'KNOWN'|'MISSING';state:C07State;reasonCode:string;confirmedAt:string|null;windows:C07StudyWindow[];sourceIds:string[]};
export type C07StudyResult={method:typeof C07_METHOD;profileSha256:typeof C07_PROFILE_SHA256;knowledgeMode:'RETROSPECTIVE_RECONSTRUCTION';assets:C07StudyAssetResult[];packagedAt:string;evaluationCutoff:string};
function evaluateAsset(a:C07StudyAsset):C07StudyAssetResult{
 const excluded=new Set(a.native.events.flatMap(e=>e.cpiAuthorizedAccounts)),first=new Map<string,number>();
 for(const e of a.native.events)if(e.side==='BUY'&&BigInt(e.coreQuoteAtomic)>=10000000n&&!excluded.has(e.user))first.set(e.user,Math.min(first.get(e.user)??Infinity,e.blockTime));
 let memory=initialC07Memory(),prev:C07Measure|null=null;
 const windows:C07StudyWindow[]=C07_BINS.map(([start,end],i)=>{
  const healths=[a.native,a.attention,a.native.windows[i],a.attention.windows[i]],bad=healths.find(h=>h.status!=='COMPLETE');
  if(bad){memory=transitionC07(memory,'INVALIDATE',end);prev=null;return {start,end,status:bad.status as 'MISSING'|'UNCOMPARABLE',reason:bad.reason,firstMeaningfulBuyerIds:null,newMeaningfulBuyerCount:null,buyQuoteAtomic:null,sellQuoteAtomic:null,netQuoteAtomic:null,qualifiedPostIds:null,providedPostCount:null,candidate:null,effective:memory.effective,pending:memory.pending,inconclusiveCount:memory.inconclusive};}
  const lo=Number(at(start)/1000000000n),hi=Number(at(end)/1000000000n),buyers=[...first].filter(([,t])=>t>=lo&&t<hi).map(([u])=>u).sort(),events=a.native.events.filter(e=>e.blockTime>=lo&&e.blockTime<hi);
  const buy=events.filter(e=>e.side==='BUY').reduce((s,e)=>s+BigInt(e.coreQuoteAtomic),0n),sell=events.filter(e=>e.side==='SELL').reduce((s,e)=>s+BigInt(e.coreQuoteAtomic),0n),posts=a.attention.posts.filter(p=>p.accepted&&at(p.publishedAt)>=at(start)&&at(p.publishedAt)<at(end)).map(p=>p.statusId).sort();
  const measure={firstBuyers:BigInt(buyers.length),buy,sell,net:buy-sell,posts:BigInt(posts.length)},candidate=prev===null?null:compareC07(prev,measure);
  if(candidate!==null)memory=transitionC07(memory,candidate,end);prev=measure;
  return {start,end,status:'COMPLETE',reason:null,firstMeaningfulBuyerIds:buyers,newMeaningfulBuyerCount:String(buyers.length),buyQuoteAtomic:String(buy),sellQuoteAtomic:String(sell),netQuoteAtomic:String(buy-sell),qualifiedPostIds:posts,providedPostCount:String(posts.length),candidate,effective:memory.effective,pending:memory.pending,inconclusiveCount:memory.inconclusive};
 });
 return {token:a.token,pool:a.pool,quality:memory.effective==='UNKNOWN'?'MISSING':'KNOWN',state:memory.effective,reasonCode:memory.effective==='UNKNOWN'?memory.reason:'C07_SCOPED_HYPOTHESIS_CONFIRMED',confirmedAt:memory.confirmedAt,windows,sourceIds:[...new Set([...a.native.sourceIds,...a.attention.sourceIds,...a.attention.posts.flatMap(p=>p.sourceIds)])].sort()};
}
export function evaluateC07Study(input:unknown):C07StudyResult{
 const x=prepare(input);return {method:C07_METHOD,profileSha256:C07_PROFILE_SHA256,knowledgeMode:'RETROSPECTIVE_RECONSTRUCTION',assets:[...x.assets].sort((a,b)=>a.token.address.localeCompare(b.token.address,'en')).map(evaluateAsset),packagedAt:x.packagedAt,evaluationCutoff:x.evaluationCutoff};
}
export function deriveC07LifecycleMetric(token:{chain:string;address:string},cutoff:string,input:unknown,ownedIds:ReadonlySet<string>):AdvisoryMetric{
 const result=evaluateC07Study(input);must(s18Instant(cutoff)!==null&&at(cutoff)===at(result.evaluationCutoff),'CUTOFF');
 must(result.assets.every(a=>a.sourceIds.every(id=>ownedIds.has(id))),'UNOWNED_SOURCE');
 const asset=result.assets.find(a=>a.token.chain===token.chain&&a.token.address===token.address);
 if(!asset)return {id:'C07',quality:'MISSING',unit:'SCOPED_OPERATIONAL_LIFECYCLE_HYPOTHESIS',data:null,evidenceIds:[],reasonCode:'C07_OUTSIDE_FROZEN_COHORT'};
 return {id:'C07',quality:asset.quality,unit:'SCOPED_OPERATIONAL_LIFECYCLE_HYPOTHESIS',data:{...asset,method:C07_METHOD,profileSha256:C07_PROFILE_SHA256,knowledgeMode:result.knowledgeMode,scope:C07_SCOPE,packagedAt:result.packagedAt},evidenceIds:asset.sourceIds,reasonCode:asset.reasonCode};
}
