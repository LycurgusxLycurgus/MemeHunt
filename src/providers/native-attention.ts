import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import {deriveAttention} from '../domain/attention.js';
import {publicHttpsUrl} from './tinyfish.js';
import {normalizeAttentionSearchUrl,normalizeAttentionFetchUrl,originSeedLinks,terminalPostScope,type AttentionRead,type AttentionSource} from './attention.js';
import {createSubmittedAttentionProgram} from './attention-model.js';

export const NATIVE_ATTENTION_METHOD='native-attention-qualification-v1' as const;
export const NATIVE_ATTENTION_PURPOSE='NARRATIVE_GAME_QUALIFICATION' as const;
export const NATIVE_ATTENTION_ID='native-attention-capture';
export const NATIVE_ATTENTION_SOURCE='native-attention-executor';
export const NATIVE_ATTENTION_MAX_BYTES=8_000_000;
const instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/);
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const fail=(code:string):never=>{throw Error('NATIVE_ATTENTION_'+code);};
const obj=(v:unknown):v is Record<string,any>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const utf8=(raw:string)=>Buffer.from(raw).toString('utf8')===raw;
const sourceSchema=z.object({id:z.string().regex(/^attention-page-[1-9]\d*$/),url:z.string(),text:z.string().max(120000),publishedAt:instant.nullable(),authorId:z.string().nullable(),availableAt:instant,kind:z.enum(['POST','PAGE']),discoveredFrom:z.string().optional()}).strict();
const postScopeSchema=z.object({method:z.literal('terminal-post-gap-v1'),complete:z.boolean(),sourceIds:z.array(z.string()),gaps:z.array(z.object({url:z.string(),code:z.enum(['HTTP_404','HTTP_410'])}).strict()),blockers:z.array(z.string())}).strict();
/** This first entry-purpose adapter admits the unmodified two-query base collector only. */
const readSchema=z.object({collectionMethod:z.literal('project-context-v2'),leadershipPositiveMethod:z.literal('source-bound-positive-v1'),entryEvidenceMethod:z.literal('public-support-v2'),sources:z.array(sourceSchema).max(64),rawArtifacts:z.record(z.string(),z.string()),queries:z.array(z.string()).length(2),complete:z.boolean(),codes:z.array(z.string()),start:instant,end:instant,comparisonSourceIds:z.array(z.string()).max(0),comparisonComplete:z.literal(false),postSampleComplete:z.boolean(),discoveryUrls:z.array(z.string()).max(4),postSampleScope:postScopeSchema}).strict();
const inputSchema=z.object({encoding:z.literal('UTF8_TEXT'),text:z.string(),sha256:hash,canonicalPromptSha256:hash,schemaJson:z.string().nullable(),schemaSha256:hash.nullable()}).strict();
const responseSchema=z.object({encoding:z.enum(['RAW_JSON_TEXT','CLAUDE_STRUCTURED_OUTPUT']),raw:z.string(),sha256:hash,transportRaw:z.string().nullable()}).strict();
const common={invocationId:z.string().min(1).max(300),startedAt:instant,finishedAt:instant,canonicalPrompt:z.string(),input:inputSchema,response:responseSchema};
const nativeSchema=z.object({...common,stage:z.literal('PROPOSAL'),executor:z.literal('CODEX_NATIVE'),provenance:z.object({harness:z.literal('CODEX_NATIVE_AGENT'),taskId:z.string().min(1).max(300),modelId:z.string().min(1).nullable(),modelIdentity:z.enum(['REPORTED','UNREPORTED']),readOnlyTools:z.array(z.string().min(1)).max(64),telemetryLimitations:z.array(z.string().min(1)).min(1).max(16),canonicalFile:z.object({path:z.string().min(1),sha256:hash}).strict(),taskWrapper:z.string().min(1)}).strict()}).strict();
const claudeSchema=z.object({...common,stage:z.literal('REVIEW'),executor:z.literal('CLAUDE_CODE'),provenance:z.object({cliVersion:z.string().min(1),sessionId:z.string().min(1),modelId:z.string().min(1),tools:z.union([z.tuple([]),z.tuple([z.literal('StructuredOutput')])]),exitCode:z.literal(0),command:z.array(z.string()).min(1).max(80),stdinSha256:hash,initRaw:z.string().min(1),resultRaw:z.string().min(1)}).strict()}).strict();
const captureSchema=z.object({method:z.literal(NATIVE_ATTENTION_METHOD),purpose:z.literal(NATIVE_ATTENTION_PURPOSE),token:tokenRefSchema,createdAt:instant,read:readSchema,executions:z.tuple([nativeSchema,claudeSchema])}).strict();
export type NativeAttentionExecution=z.infer<typeof nativeSchema>|z.infer<typeof claudeSchema>;
export type NativeAttentionCapture=z.infer<typeof captureSchema>;

/** Hashes bind retained USER_IMPORT bytes; they do not authenticate a provider or executor. */
export function nativeAttentionScope(raw:string){return {method:NATIVE_ATTENTION_METHOD,purpose:NATIVE_ATTENTION_PURPOSE,contentHash:sha(raw)};}

function postUrl(url:string){const u=new URL(url);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(u.pathname);}
function canonicalUrl(url:string){if(!postUrl(url))return url;const u=new URL(url);return 'https://x.com/'+u.pathname.split('/')[1]!.toLowerCase()+'/status/'+u.pathname.split('/')[3];}

/** Replay the existing base collector's bounded queue/body/metadata rules without IO.
 * read.end is its acquisition START (the collector captures it before IO), not the
 * last page time. Per-source actual clocks are retained and bounded by proposal start.
 */
function replayRead(read:z.infer<typeof readSchema>,token:TokenRef,proposalStart:string):AttentionRead{
 const raw=read.rawArtifacts,keys=Object.keys(raw);
 if(keys.length>256||keys.some(id=>!/^attention-(?:http-outcomes|search-[12]|fetch-[1-9]\d*(?:-retry-1)?)$/.test(id))||Object.values(raw).some(v=>!utf8(v)))fail('SOURCE_ARTIFACT_MEMBERSHIP');
 if(Date.parse(read.start)!==Date.parse(read.end)-24*3600_000||Date.parse(read.end)>Date.parse(proposalStart))fail('SOURCE_CLOCK');
 const seeds=[...new Set(read.discoveryUrls.map(url=>{const safe=publicHttpsUrl(url,true);if(!safe)fail('SOURCE_URL');return canonicalUrl(safe!);}))];
 if(!same(seeds,read.discoveryUrls))fail('DISCOVERY_SEEDS');
 const seedScopes=seeds.map(url=>{const u=new URL(url);return 'site:'+u.hostname+(/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)?u.pathname:'');});
 const queries=[`"${token.address}" ${token.chain} ${seedScopes.length?`(${seedScopes.join(' OR ')})`:'narrative origin catalyst'}`,`"${token.address}" (site:x.com OR site:twitter.com)`];
 if(!same(read.queries,queries))fail('SOURCE_QUERIES');
 let outcomes:any;try{outcomes=JSON.parse(raw['attention-http-outcomes']!);}catch{return fail('HTTP_OUTCOMES');}
 if(!obj(outcomes)||!same(Object.keys(outcomes).sort(),['method','outcomes'])||outcomes.method!=='fetch-http-outcomes-v1'||!Array.isArray(outcomes.outcomes)||outcomes.outcomes.length>150)fail('HTTP_OUTCOMES');
 const statuses=new Map<string,number>(),used=new Set<string>(['attention-http-outcomes']);
 for(const row of outcomes.outcomes){if(!obj(row)||!same(Object.keys(row).sort(),['artifactId','status'])||typeof row.artifactId!=='string'||!/^attention-(?:search-[12]|fetch-[1-9]\d*(?:-retry-1)?)$/.test(row.artifactId)||!Number.isInteger(row.status)||row.status<100||row.status>599||statuses.has(row.artifactId))fail('HTTP_OUTCOMES');statuses.set(row.artifactId,row.status);}
 const observed=new Set<string>(),codes:string[]=[],urls=[...seeds],sources:AttentionSource[]=[],discoveryParents=new Map<string,string>(),followed=new Set<string>();
 let postSampleComplete=true;
 const status=(id:string)=>{const n=statuses.get(id);if(n===undefined)fail('HTTP_OUTCOME_MISSING');observed.add(id);return n!;};
 const packet=(id:string,max:number)=>{const value=raw[id];if(typeof value!=='string'||Buffer.byteLength(value)>max)fail('SOURCE_PREIMAGE_MISSING');used.add(id);try{return JSON.parse(value);}catch{return fail('SOURCE_PREIMAGE_JSON');}};
 for(let i=0;i<2;i++){
  const id='attention-search-'+(i+1),s=status(id);
  if(s<200||s>=300){codes.push('ATT_SEARCH_HTTP_'+s);postSampleComplete=false;continue;}
  const value=packet(id,100000);
  if(!obj(value)||!Array.isArray(value.results)){codes.push('ATT_SEARCH_SHAPE');postSampleComplete=false;continue;}
  for(const r of value.results){if(!obj(r)||typeof r.url!=='string')continue;const safe=normalizeAttentionSearchUrl(r.url);if(safe&&!urls.includes(safe)){if(urls.length>=40){codes.push('ATT_PAGE_CAP');if(postUrl(safe))postSampleComplete=false;continue;}urls.push(safe);}}
 }
 let offset=0,batch=0;
 while(offset<urls.length){
  const requested=urls.slice(offset,offset+10);offset+=requested.length;batch++;
  const id='attention-fetch-'+batch,s=status(id);
  if(s<200||s>=300){codes.push('ATT_FETCH_HTTP_'+s);if(requested.some(postUrl))postSampleComplete=false;continue;}
  const value=packet(id,2000000);
  if(!obj(value)||!Array.isArray(value.results)||!Array.isArray(value.errors)){codes.push('ATT_FETCH_SHAPE');if(requested.some(postUrl))postSampleComplete=false;continue;}
  let results=[...value.results],errors=[...value.errors];
  const permanent=new Set(errors.filter(obj).filter(e=>![408,429,502,503,504].includes(Number(e.status))&&e.error!=='timeout').map(e=>e.url));
  const returnedUrls=new Set(results.filter(obj).filter(r=>typeof r.text==='string').map(r=>r.url));
  const retryUrls=requested.filter(url=>!returnedUrls.has(url)&&!permanent.has(url));
  if(retryUrls.length){
   const retry=id+'-retry-1';
   // A transport failure has no retained HTTP observation and cannot be replayed
   // under this deliberately bounded import profile.
   const rs=status(retry),recovered=packet(retry,2000000);
   if(rs>=200&&rs<300&&obj(recovered)&&Array.isArray(recovered.results)&&Array.isArray(recovered.errors)){
    const valid=recovered.results.filter(obj).filter(r=>retryUrls.includes(String(r.url))&&typeof r.text==='string');results.push(...valid);const recoveredUrls=new Set(valid.map(r=>r.url));errors=[...errors.filter(e=>!obj(e)||!recoveredUrls.has(e.url)),...recovered.errors];
   }
  }
  if(errors.length)codes.push('ATT_FETCH_URL_ERROR');
  const returned=new Set<string>();
  for(const r of results){
   if(!obj(r)||typeof r.url!=='string'||typeof r.text!=='string')continue;
   const requestedUrl=publicHttpsUrl(r.url,true);let url=typeof r.final_url==='string'?normalizeAttentionFetchUrl(r.final_url):requestedUrl;
   if(!requestedUrl||!url||!requested.includes(requestedUrl)||returned.has(requestedUrl)){codes.push('ATT_FETCH_BINDING');continue;}
   if(!r.text.trim()||/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(r.text)){codes.push('ATT_FETCH_BLOCKED_CONTENT');if(postUrl(requestedUrl))postSampleComplete=false;continue;}
   const u=new URL(url),post=postUrl(url);
   if(postUrl(requestedUrl)&&(!post||new URL(requestedUrl).pathname.split('/')[3]!==u.pathname.split('/')[3])){codes.push('ATT_FETCH_BINDING');postSampleComplete=false;continue;}
   returned.add(requestedUrl);if(post)url=canonicalUrl(url);
   if(r.text.length>120000){codes.push('ATT_TEXT_CAP');if(post)postSampleComplete=false;}
   const text=r.text.slice(0,120000),prior=sources.find(s=>s.url===url);if(prior)continue;
   const at=typeof r.published_date==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r.published_date)&&Number.isFinite(Date.parse(r.published_date))&&Date.parse(r.published_date)<=Date.parse(read.end)?new Date(r.published_date).toISOString():null;
   const availableAt=read.sources[sources.length]?.availableAt;
   if(!availableAt||Date.parse(availableAt)<Date.parse(read.end)||Date.parse(availableAt)>Date.parse(proposalStart))fail('SOURCE_CLOCK');
   sources.push({id:'attention-page-'+(sources.length+1),url,text,publishedAt:at,authorId:post?u.hostname.replace(/^www\./,'').replace('twitter.com','x.com')+':'+u.pathname.split('/')[1]!.toLowerCase():null,availableAt,kind:post?'POST':'PAGE',...(discoveryParents.has(requestedUrl)?{discoveredFrom:discoveryParents.get(requestedUrl)}:{})});
   const metadataLinks=seeds.includes(requestedUrl)&&/\.json(?:[?]|$)/i.test(requestedUrl)?[...text.matchAll(/https:\/\/[^"\s\\<>]+/g)].map(m=>m[0]):[];
   if(seeds.includes(requestedUrl))for(const next of originSeedLinks(requestedUrl,[...(Array.isArray(r.links)?r.links:[]),...metadataLinks],'project-context-v2')){
    if(urls.includes(next))continue;followed.add(next);discoveryParents.set(next,requestedUrl);urls.splice(offset+followed.size-1,0,next);if(urls.length>40){const omitted=urls.pop()!;codes.push('ATT_PAGE_CAP');if(postUrl(omitted))postSampleComplete=false;}
   }
  }
  if(requested.some(u=>!returned.has(u)))codes.push('ATT_FETCH_INCOMPLETE');
  if(requested.some(u=>postUrl(u)&&!returned.has(u)))postSampleComplete=false;
 }
 if(observed.size!==statuses.size||keys.some(id=>!used.has(id)))fail('SOURCE_ORPHAN');
 const expected:AttentionRead={collectionMethod:'project-context-v2',leadershipPositiveMethod:'source-bound-positive-v1',sources,rawArtifacts:raw,queries,entryEvidenceMethod:'public-support-v2',complete:codes.length===0,codes:[...new Set(codes)],start:read.start,end:read.end,comparisonSourceIds:[],comparisonComplete:false,postSampleComplete,discoveryUrls:seeds};
 expected.postSampleScope=terminalPostScope(expected);
 if(!same(read,expected))fail('SOURCE_REPLAY_MISMATCH');
 return expected;
}

function executionResponse(execution:NativeAttentionExecution,prompt:string,wireSchema:z.ZodType,repairProfile?:'A12_WITNESS_UNADJUDICATED_ORIGIN'):unknown{
 if(execution.canonicalPrompt!==prompt||execution.input.canonicalPromptSha256!==sha(prompt)||execution.input.sha256!==sha(execution.input.text)||execution.response.sha256!==sha(execution.response.raw)||!utf8(prompt)||!utf8(execution.input.text)||!utf8(execution.response.raw)||Buffer.byteLength(execution.response.raw)>400000)fail('EXECUTION_BYTES');
 const schema=execution.input.schemaJson;
 if((schema===null)!==(execution.input.schemaSha256===null)||schema!==null&&(execution.input.schemaSha256!==sha(schema)||!same(JSON.parse(schema),z.toJSONSchema(wireSchema,execution.executor==='CLAUDE_CODE'?{target:'draft-7'}:{}))))fail('EXECUTION_SCHEMA');
 if(Buffer.byteLength(execution.input.text)+Buffer.byteLength(schema??'')+(execution.executor==='CODEX_NATIVE'?Buffer.byteLength(prompt):0)>300000)fail('EXECUTION_BUDGET');
 if(Date.parse(execution.finishedAt)<Date.parse(execution.startedAt))fail('EXECUTION_CLOCK');
 if(execution.executor==='CODEX_NATIVE'){
  const p=execution.provenance;
  if(execution.response.encoding!=='RAW_JSON_TEXT'||execution.response.transportRaw!==null||p.taskId!==execution.invocationId||p.canonicalFile.sha256!==sha(prompt)||p.taskWrapper!==execution.input.text||!p.taskWrapper.includes(p.canonicalFile.path)||!p.taskWrapper.includes(p.canonicalFile.sha256)||(p.modelIdentity==='UNREPORTED')!==(p.modelId===null))fail('NATIVE_PROVENANCE');
 }else{
  const p=execution.provenance,transport=execution.response.transportRaw;
  if(!transport||!utf8(transport)||Buffer.byteLength(transport)>1000000||p.stdinSha256!==execution.input.sha256||!execution.input.text.includes(prompt)||!/(?:^|\/)claude$/.test(p.command[0]??'')||!p.command.includes('--output-format')||!p.command.includes('stream-json')||p.command.some(arg=>/^(?:--resume|--continue|--fork-session)(?:=|$)/.test(arg)||['-r','-c'].includes(arg)))return fail('CLAUDE_PROVENANCE');
  const lines=transport.split(/\r?\n/).filter(Boolean);let parsed:any[];try{parsed=lines.map(line=>JSON.parse(line));}catch{return fail('CLAUDE_TRANSPORT');}
  if(!lines.includes(p.initRaw)||!lines.includes(p.resultRaw))fail('CLAUDE_TRANSPORT');
  let init:any,result:any;try{init=JSON.parse(p.initRaw);result=JSON.parse(p.resultRaw);}catch{return fail('CLAUDE_TRANSPORT');}
  if(parsed.filter(v=>v.type==='system'&&v.subtype==='init').length!==1||parsed.filter(v=>v.type==='result').length!==1||init.type!=='system'||init.subtype!=='init'||init.session_id!==p.sessionId||init.model!==p.modelId||!same(init.tools,p.tools)||init.claude_code_version!==p.cliVersion||result.type!=='result'||result.subtype!=='success'||result.is_error!==false||result.session_id!==p.sessionId||p.sessionId!==execution.invocationId)fail('CLAUDE_IDENTITY');
  const toolUses=parsed.flatMap(v=>v.type==='assistant'&&Array.isArray(v.message?.content)?v.message.content.filter((part:any)=>part?.type==='tool_use'):[]);
  if(p.tools.length){
   // Claude's --json-schema advertises this output-only formatter even with
   // --tools ''. It supplies no IO/source authority; bind its single emission
   // to the exact retained structured result instead of claiming tools[].
   if(execution.response.encoding!=='CLAUDE_STRUCTURED_OUTPUT'||schema===null||toolUses.length<1||toolUses.length>2||toolUses.some((t:any)=>t.name!=='StructuredOutput')||!same(toolUses.at(-1).input,result.structured_output))fail('CLAUDE_FORMATTER');
   if(toolUses.length===2){
    const first=toolUses[0],prior=structuredClone(first.input),feedback=parsed.flatMap(v=>v.type==='user'&&Array.isArray(v.message?.content)?v.message.content:[]).find((part:any)=>part?.type==='tool_result'&&part.tool_use_id===first.id);
    // One observed formatter repair moves the existing citations field into
    // originRelationship. No decision, rationale or citation may change.
    const firstCheck=wireSchema.safeParse(first.input);
    if(firstCheck.success||feedback?.is_error!==true||!obj(prior))fail('CLAUDE_FORMATTER_REPAIR');
    const finalOrigin=result.structured_output?.originRelationship;
    if(repairProfile==='A12_WITNESS_UNADJUDICATED_ORIGIN'&&!firstCheck.success&&firstCheck.error.issues.length>0&&firstCheck.error.issues.every(issue=>issue.path[0]==='originRelationship')&&typeof prior.originRelationship==='string'&&obj(finalOrigin)&&finalOrigin.status==='UNKNOWN'&&same(finalOrigin.citations,[]))prior.originRelationship=finalOrigin;
    else {if(!obj(prior.originRelationship)||!Array.isArray(prior.citations)||'citations' in prior.originRelationship)fail('CLAUDE_FORMATTER_REPAIR');prior.originRelationship.citations=prior.citations;delete prior.citations;}
    if(!same(prior,result.structured_output))fail('CLAUDE_FORMATTER_REPAIR');
   }
  }else if(toolUses.length)fail('CLAUDE_FORMATTER');
  if(execution.response.encoding==='CLAUDE_STRUCTURED_OUTPUT'){
   if(schema===null||!p.command.includes('--json-schema')||!p.command.includes(schema)||!obj(result.structured_output)||execution.response.raw!==JSON.stringify(result.structured_output))fail('CLAUDE_STRUCTURED_OUTPUT');
  }else if(typeof result.result!=='string'||execution.response.raw!==result.result)fail('CLAUDE_RESULT');
 }
 try{return JSON.parse(execution.response.raw);}catch{return fail('RESPONSE_JSON');}
}

/** Deterministic USER_IMPORT admission and A01/A02 derivation. No shell, model or network. */
export function decodeNativeAttentionCapture(raw:string,token:TokenRef,cutoff:string){
 if(!utf8(raw)||Buffer.byteLength(raw)>NATIVE_ATTENTION_MAX_BYTES||!instant.safeParse(cutoff).success)fail('CAPTURE_BYTES_OR_CUTOFF');
 let capture:NativeAttentionCapture;try{capture=captureSchema.parse(JSON.parse(raw));}catch{return fail('CAPTURE_SCHEMA');}
 if(token.chain!=='solana'||!same(capture.token,token))fail('TOKEN');
 const [native,claude]=capture.executions,times=[capture.read.end,native.startedAt,native.finishedAt,claude.startedAt,claude.finishedAt,capture.createdAt,cutoff].map(Date.parse);
 if(times.some((at,index)=>index>0&&at<times[index-1]!)||Date.parse(capture.createdAt)-Date.parse(capture.read.end)>600000||native.invocationId===claude.invocationId)fail('CAUSAL_CLOCK_OR_DEADLINE');
 const read=replayRead(capture.read,token,native.startedAt),program=createSubmittedAttentionProgram(read,token,true);
 let proposal,review;try{
  proposal=program.normalizeProposal(executionResponse(native,program.proposalPacket,program.wireProposalSchema));
  const reviewProgram=program.buildReview(proposal);if(!reviewProgram)fail('REVIEW_REQUIRED');
  review=program.normalizeReview(executionResponse(claude,reviewProgram!.reviewPacket,reviewProgram!.wireReviewSchema),proposal);
 }catch(error){if(error instanceof Error&&error.message.startsWith('NATIVE_ATTENTION_'))throw error;return fail('CANONICAL_PROGRAM');}
 const assessments=deriveAttention(read,proposal,review,token,cutoff,[NATIVE_ATTENTION_ID]).filter(a=>a.id==='A01'||a.id==='A02');
 if(assessments.length!==2)fail('ASSESSMENT_SCOPE');
 return {capture,read,proposal,review,assessments};
}

/** Read a single bounded regular file without following symlinks before any live IO. */
export function loadNativeAttentionCapture(file:string,token:TokenRef,cutoff:string){
 let fd:number|undefined,raw:string;
 try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>NATIVE_ATTENTION_MAX_BYTES)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==st.size||!Buffer.from(bytes.toString('utf8')).equals(bytes))fail('FILE_UTF8');raw=bytes.toString('utf8');}catch(error){if(error instanceof Error&&error.message.startsWith('NATIVE_ATTENTION_'))throw error;return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}
 return {raw,decoded:decodeNativeAttentionCapture(raw!,token,cutoff)};
}

// Pure execution carriers only; callers retain their own source and purpose authority.
export {nativeSchema as nativeQualificationProposalExecutionSchema,claudeSchema as nativeQualificationReviewExecutionSchema,executionResponse as decodeNativeQualificationResponse};
