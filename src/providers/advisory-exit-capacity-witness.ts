import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {PublicKey} from '@solana/web3.js';
import {poolPda,pumpPoolAuthorityPda} from '@pump-fun/pump-swap-sdk';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import {attentionProposalSchema,attentionReviewSchema} from '../domain/attention.js';
import {publicHttpsUrl} from './tinyfish.js';
import {nativeQualificationProposalExecutionSchema,nativeQualificationReviewExecutionSchema,decodeNativeQualificationResponse} from './native-attention.js';

export const A12_WITNESS_METHOD='a12-zero-target-witness-capture-v1' as const;
export const A12_WITNESS_PURPOSE='A12_ZERO_TARGET_POSITIVE_WITNESS' as const;
export const A12_WITNESS_ID='a12-zero-witness-capture';
export const A12_WITNESS_SOURCE='a12-zero-witness-executor';
export const A12_WITNESS_MAX_BYTES=8_000_000;
const instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/);
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const fail=(code:string):never=>{throw Error('A12_ZERO_WITNESS_'+code);};
const utf8=(raw:string)=>Buffer.from(raw).toString('utf8')===raw;
const obj=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const sourceSchema=z.object({id:z.string().regex(/^a12-witness-source-[1-9]\d*$/),url:z.string(),text:z.string().max(120000),availableAt:instant,batchId:z.string().min(1).max(200),resultIndex:z.number().int().nonnegative()}).strict();
const acquisitionSchema=z.object({method:z.literal('bounded-static-tinyfish-fetch-v1'),startedAt:instant,complete:z.boolean(),batches:z.array(z.object({id:z.string().min(1).max(200),requestedUrls:z.array(z.string()).min(1).max(32),status:z.number().int().min(100).max(599),availableAt:instant,raw:z.string()}).strict()).min(1).max(8),sourceIds:z.array(z.string()).max(32)}).strict();
const routeHintSchema=z.object({token:tokenRefSchema,pool:z.string().min(1),quoteMint:z.string().min(1),sourceId:z.string().min(1),quote:z.string().min(1).max(120000)}).strict();
export const a12ZeroWitnessSchema=z.object({method:z.literal(A12_WITNESS_METHOD),purpose:z.literal(A12_WITNESS_PURPOSE),target:tokenRefSchema,witness:tokenRefSchema,createdAt:instant,scope:z.object({description:z.string().min(8).max(4000),queries:z.array(z.string().min(1).max(4000)).max(8),routeUniverse:z.literal('CANONICAL_PUMPSWAP_INDEX0_QUOTE_MINT'),impactBps:z.string().max(5).regex(/^(?:0|[1-9]\d*)$/).refine(v=>BigInt(v)<=10000n)}).strict(),sources:z.array(sourceSchema).max(32),acquisition:acquisitionSchema,diagnostics:z.object({membershipComplete:z.literal(false),knownLeads:z.array(z.object({token:tokenRefSchema,sourceIds:z.array(z.string()).max(32),status:z.enum(['NOT_ADJUDICATED','UNRESOLVED_RESEARCH_LEAD']),rationale:z.string().min(8).max(4000)}).strict()).max(32),priorCatalog:z.object({sourcePacketHash:hash,reviewResultHash:hash,status:z.literal('UNQUALIFIED'),availableAt:instant}).strict().nullable()}).strict(),routeHints:z.tuple([routeHintSchema,routeHintSchema]),executions:z.tuple([nativeQualificationProposalExecutionSchema,nativeQualificationReviewExecutionSchema])}).strict();
export type A12ZeroWitnessCapture=z.infer<typeof a12ZeroWitnessSchema>;

/** Replay all original provider results, retaining entire text and stable result pointers. */
export function a12WitnessSourcesFromAcquisition(input:A12ZeroWitnessCapture['acquisition']){
 const acquisition=acquisitionSchema.parse(input),sources:A12ZeroWitnessCapture['sources']=[],batchIds=new Set<string>(),requestedAll=new Set<string>();let complete=true,total=0;
 for(const batch of acquisition.batches){
  total+=Buffer.byteLength(batch.raw);
  if(!utf8(batch.raw)||Buffer.byteLength(batch.raw)>2_000_000||total>4_000_000||batchIds.has(batch.id)||Date.parse(batch.availableAt)<Date.parse(acquisition.startedAt))fail('ACQUISITION_BOUND');
  batchIds.add(batch.id);
  const requested=new Set<string>();
  for(const url of batch.requestedUrls){if(!publicHttpsUrl(url,true)||requested.has(url))fail('SOURCE_URL');requested.add(url);requestedAll.add(url);}
  if(requestedAll.size>32)fail('ACQUISITION_BOUND');
  if(batch.status<200||batch.status>=300){complete=false;continue;}
  let value:unknown;try{value=JSON.parse(batch.raw);}catch{return fail('SOURCE_PREIMAGE_JSON');}
  if(!obj(value)||!Array.isArray(value.results)||!Array.isArray(value.errors))return fail('SOURCE_PREIMAGE_SHAPE');
  const observed=new Set<string>();
  for(const [index,result] of value.results.entries()){
   if(!obj(result)||typeof result.url!=='string'||!requested.has(result.url)||observed.has(result.url)||typeof result.text!=='string'||!utf8(result.text)||result.text.length>120000)fail('SOURCE_RESULT');
   observed.add(result.url);
   const url=result.final_url===undefined?result.url:result.final_url;
   if(typeof url!=='string'||!publicHttpsUrl(url,true))fail('SOURCE_URL');
   if(!result.text.trim())complete=false;
   sources.push({id:'a12-witness-source-'+(sources.length+1),url,text:result.text,availableAt:batch.availableAt,batchId:batch.id,resultIndex:index});
   if(sources.length>32)fail('ACQUISITION_BOUND');
  }
  for(const error of value.errors){if(!obj(error)||typeof error.url!=='string'||!requested.has(error.url)||observed.has(error.url))fail('SOURCE_ERROR');observed.add(error.url);complete=false;}
  if(observed.size!==requested.size)complete=false;
 }
 return {sources,complete,sourceIds:sources.map(s=>s.id)};
}

type PromptCapture=Pick<A12ZeroWitnessCapture,'target'|'witness'|'scope'|'sources'|'diagnostics'>;
const context=(capture:PromptCapture)=>({purpose:A12_WITNESS_PURPOSE,target:capture.target,witness:capture.witness,scope:capture.scope,sources:capture.sources,diagnostics:capture.diagnostics});
export function a12WitnessProposalPrompt(capture:PromptCapture){return JSON.stringify({...context(capture),instruction:'Adjudicate only the declared target and distinct witness as token representations of the same narrative. Inspect the ENTIRE retained current sources and diagnostics. Return attentionProposalSchema JSON with claims:[], posts:[], and exactly two competitors in order, IDs "target" then "witness", matching the declared tokens. Each competitor requires one unchanged literal source quote containing its exact contract address and substantive own narrative association. Tickers, generic platform text, pair denomination alone, or copied identity do not establish association. Preserve uncertain or adverse evidence for independent rejection. This is a partial pair, never a complete membership catalog, entry judgment, capacity measurement or permission. Do not infer membership from native bank outcomes; none are supplied.'});}
export function a12WitnessReviewPrompt(capture:PromptCapture,proposal:unknown){return JSON.stringify({...context(capture),proposal,instruction:'Independently inspect ENTIRE current sources, diagnostics and both proposed literal CA/narrative citations. Return attentionReviewSchema JSON: decisions:[{id:"target",accepted,rationale},{id:"witness",accepted,rationale}], candidateSet:{complete:false,rationale}, originRelationship:{status:"UNKNOWN",citations:[],rationale}. Cover each fixed ID exactly once. Accept only genuine own-identity same-narrative association supported by the exact unchanged source quote and contract address. Reject ticker-only, generic platform, pair-denomination-only, copied-identity or ambiguous association. Preserve actual rejection. This program establishes only the partial pair, never exhaustive membership, entry decisions, leadership permissions or native capacity. Emit no other fields.'});}
export function a12WitnessScope(raw:string){return {method:A12_WITNESS_METHOD,purpose:A12_WITNESS_PURPOSE,contentHash:sha(raw)};}

/** Source-only purpose admission; no native collection or A09 completeness authority. */
export function decodeA12ZeroWitnessCapture(raw:string,target:TokenRef,cutoff:string){
 if(!utf8(raw)||Buffer.byteLength(raw)>A12_WITNESS_MAX_BYTES||!instant.safeParse(cutoff).success)fail('CAPTURE_BYTES_OR_CUTOFF');
 let capture:A12ZeroWitnessCapture;try{capture=a12ZeroWitnessSchema.parse(JSON.parse(raw));}catch{return fail('CAPTURE_SCHEMA');}
 if(target.chain!=='solana'||!same(target,capture.target)||capture.witness.chain!=='solana'||same(capture.target,capture.witness))fail('TOKEN');
 try{new PublicKey(capture.target.address);new PublicKey(capture.witness.address);}catch{return fail('TOKEN');}
 const [native,claude]=capture.executions,times=[capture.acquisition.startedAt,native.startedAt,native.finishedAt,claude.startedAt,claude.finishedAt,capture.createdAt,cutoff].map(Date.parse);
 if(times.some((v,i)=>i>0&&v<times[i-1]!)||Date.parse(capture.createdAt)-times[0]!>600000||native.invocationId===claude.invocationId)fail('CAUSAL_CLOCK_OR_DEADLINE');
 const rebuilt=a12WitnessSourcesFromAcquisition(capture.acquisition);
 if(!same(rebuilt.sources,capture.sources)||!same(rebuilt.sourceIds,capture.acquisition.sourceIds)||rebuilt.complete!==capture.acquisition.complete)fail('SOURCE_REPLAY_MISMATCH');
 for(const batch of capture.acquisition.batches)if(Date.parse(batch.availableAt)>Date.parse(native.startedAt))fail('SOURCE_CLOCK');
 for(const source of capture.sources)if(Date.parse(cutoff)-Date.parse(source.availableAt)>900000)fail('SOURCE_TTL');
 const diagnostics=capture.diagnostics,seen=new Set<string>(),sourceIds=new Set(capture.sources.map(s=>s.id));
 if(diagnostics.priorCatalog&&Date.parse(diagnostics.priorCatalog.availableAt)>Date.parse(capture.acquisition.startedAt))fail('PRIOR_CATALOG_CLOCK');
 for(const lead of diagnostics.knownLeads){const key=JSON.stringify(lead.token);if(seen.has(key)||new Set(lead.sourceIds).size!==lead.sourceIds.length||lead.sourceIds.some(id=>!sourceIds.has(id))||!lead.sourceIds.length&&!diagnostics.priorCatalog)fail('DIAGNOSTICS');seen.add(key);}
 let proposal:z.infer<typeof attentionProposalSchema>,review:z.infer<typeof attentionReviewSchema>;
 try{proposal=attentionProposalSchema.parse(decodeNativeQualificationResponse(native,a12WitnessProposalPrompt(capture),attentionProposalSchema));review=attentionReviewSchema.parse(decodeNativeQualificationResponse(claude,a12WitnessReviewPrompt(capture,proposal),attentionReviewSchema,'A12_WITNESS_UNADJUDICATED_ORIGIN'));}catch{return fail('EXECUTION_PROGRAM');}
 if(proposal.claims.length||proposal.posts.length||proposal.competitors.length!==2||review.entryDecisions||review.leadershipScreening||review.originScopeReview||review.candidateSet?.complete!==false||review.originRelationship?.status!=='UNKNOWN'||review.originRelationship.citations.length||review.decisions.length!==2||new Set(review.decisions.map(d=>d.id)).size!==2||review.decisions.some(d=>!['target','witness'].includes(d.id)))fail('SEMANTIC_SCOPE');
 for(const [index,member] of proposal.competitors.entries()){
  const expected=index===0?capture.target:capture.witness,source=capture.sources.find(s=>s.id===member.sourceId),hint=capture.routeHints[index]!;
  if(member.id!==(index===0?'target':'witness')||!same(member.token,expected)||!source||!source.text.includes(member.quote)||!member.quote.includes(expected.address))fail('MEMBER_CITATION');
  const routeSource=capture.sources.find(s=>s.id===hint.sourceId);
  if(!same(hint.token,expected)||!routeSource||!routeSource.text.includes(hint.quote)||![expected.address,hint.pool,hint.quoteMint].every(v=>hint.quote.includes(v)))fail('ROUTE_HINT');
  try{const mint=new PublicKey(expected.address),quote=new PublicKey(hint.quoteMint);if(!poolPda(0,pumpPoolAuthorityPda(mint),mint,quote).equals(new PublicKey(hint.pool)))fail('ROUTE_HINT');}catch{return fail('ROUTE_HINT');}
 }
 if(capture.routeHints[0].pool===capture.routeHints[1].pool)fail('SHARED_ROUTE');
 return {capture,qualified:review.decisions.every(d=>d.accepted),members:proposal.competitors,routeHints:capture.routeHints,sourceHash:sha(raw),sourceReadyAt:capture.createdAt};
}

export function loadA12ZeroWitnessCapture(path:string,target:TokenRef,cutoff:string){
 let fd:number|undefined,raw:string;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>A12_WITNESS_MAX_BYTES)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==stat.size||!Buffer.from(bytes.toString('utf8')).equals(bytes))fail('FILE_UTF8');raw=bytes.toString('utf8');}catch(error){if(error instanceof Error&&error.message.startsWith('A12_ZERO_WITNESS_'))throw error;return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}
 return {raw,decoded:decodeA12ZeroWitnessCapture(raw!,target,cutoff)};
}
