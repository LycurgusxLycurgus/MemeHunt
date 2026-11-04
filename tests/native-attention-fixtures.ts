/** Constructed transport records and corpus for protocol tests, never real model evidence. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {TokenRef} from '../src/domain/contracts.js';
import {collectAttentionSources} from '../src/providers/attention.js';
import {createSubmittedAttentionProgram} from '../src/providers/attention-model.js';
import {sourceSpans} from '../src/providers/source-model.js';
import {NATIVE_ATTENTION_METHOD,NATIVE_ATTENTION_PURPOSE,type NativeAttentionCapture,type NativeAttentionExecution} from '../src/providers/native-attention.js';
export const NATIVE_TEST_TOKEN={chain:'solana',address:'So11111111111111111111111111111111111111112'} as const;
export const NATIVE_TEST_CUTOFF='2026-10-01T12:05:00.000Z';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export async function nativeAttentionFixture(options:{post?:boolean;seed?:boolean;gap?:boolean;reject?:boolean;structured?:boolean;token?:TokenRef;acquiredAt?:string;prefix?:string}={}){
 const token=options.token??NATIVE_TEST_TOKEN,base=Date.parse(options.acquiredAt??'2026-10-01T12:00:00.000Z'),at=(ms:number)=>new Date(base+ms).toISOString();
 const url=options.post?'https://x.com/lantern/status/100':'https://lantern.example/about',seed='https://lantern.example/';
 const text=`${options.prefix??''}Token ${token.address}. Neighbors use this community token to share a lantern story.`;
 const fetcher=(async(input:URL|RequestInfo,init?:RequestInit)=>{
  const endpoint=String(input);
  if(endpoint.startsWith('https://api.search.tinyfish.ai/'))return new Response(JSON.stringify({results:[{url}],errors:[]}),{status:200});
  const request=JSON.parse(String(init?.body)),results=request.urls.filter((v:string)=>!options.gap||v!==seed).map((v:string)=>({url:v,final_url:v,text:v===seed?'Our local community project.':text,published_date:options.post?'2026-10-01T10:00:00Z':undefined,links:v===seed?[url]:[]}));
  return new Response(JSON.stringify({results,errors:options.gap&&request.urls.includes(seed)?[{url:seed,status:404,error:'page_not_found'}]:[]}),{status:200});
 }) as typeof fetch;
 // Native capture v1 freezes the original base-collector contract. New hosted
 // comparison caches are not part of that imported protocol or its prompt.
 const {comparisonAcquisition:_acquisition,comparisonRankingSourceIds:_ranking,postSampleSourceIds:_sample,...read}=await collectAttentionSources(token,'constructed-no-network',fetcher,()=>at(0),undefined,options.seed?[seed]:[],undefined,'public-support-v2');
 const program=createSubmittedAttentionProgram(read,token,true),source=read.sources.find(s=>s.url===url)!,span=sourceSpans(source.id,source.text).find(s=>s.text.includes(token.address))!;
 const wire={claims:[{id:'narrative',feature:'A01',value:true,summary:'Neighbors share a community lantern story.',citations:[{sourceId:source.id,spanId:span.id}]},{id:'game',feature:'A02',value:true,summary:'A community game based on neighbors sharing the lantern story.',citations:[{sourceId:source.id,spanId:span.id}]}],posts:Object.fromEntries(read.sources.filter(s=>s.kind==='POST').map(s=>[s.id,{spanId:sourceSpans(s.id,s.text)[0]!.id,role:'NEWS'}])),competitors:[]};
 const proposal=program.normalizeProposal(wire),reviewProgram=program.buildReview(proposal)!;
 const decisions=Object.fromEntries([...proposal.claims,...proposal.posts,...proposal.competitors].map(item=>[item.id,{accepted:!options.reject||item.id!=='game',rationale:options.reject&&item.id==='game'?'The source does not support the proposed game inference.':'The cited unchanged source supports this bounded judgment.'}]));
 const review={decisions,candidateSet:{complete:false,rationale:'Comparison collection was explicitly deferred in this corpus.'},originRelationship:{status:'UNKNOWN',citations:[],rationale:'This bounded source corpus does not establish primary origin.'}};
 const nativePrompt=program.proposalPacket,path='/constructed-test/proposal.json',nativeWrapper=`Read the canonical packet ${path} SHA256 ${sha(nativePrompt)}. Return only its requested JSON. This is a constructed protocol test.`;
 const native:NativeAttentionExecution={stage:'PROPOSAL',executor:'CODEX_NATIVE',invocationId:'constructed-native-task',startedAt:at(60000),finishedAt:at(120000),canonicalPrompt:nativePrompt,input:{encoding:'UTF8_TEXT',text:nativeWrapper,sha256:sha(nativeWrapper),canonicalPromptSha256:sha(nativePrompt),schemaJson:null,schemaSha256:null},response:{encoding:'RAW_JSON_TEXT',raw:JSON.stringify(wire),sha256:sha(JSON.stringify(wire)),transportRaw:null},provenance:{harness:'CODEX_NATIVE_AGENT',taskId:'constructed-native-task',modelId:null,modelIdentity:'UNREPORTED',readOnlyTools:['constructed-canonical-file-read'],telemetryLimitations:['Constructed test fixture; this is not actual native execution evidence.'],canonicalFile:{path,sha256:sha(nativePrompt)},taskWrapper:nativeWrapper}};
 const schemaJson=options.structured?JSON.stringify(z.toJSONSchema(reviewProgram.wireReviewSchema,{target:'draft-7'})):null;
 const initRaw=JSON.stringify({type:'system',subtype:'init',session_id:'constructed-claude-session',model:'constructed-model',claude_code_version:'constructed-cli',tools:[]});
 const resultRaw=JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'constructed-claude-session',...(options.structured?{structured_output:review}:{result:JSON.stringify(review)})});
 const claude:NativeAttentionExecution={stage:'REVIEW',executor:'CLAUDE_CODE',invocationId:'constructed-claude-session',startedAt:at(120000),finishedAt:at(180000),canonicalPrompt:reviewProgram.reviewPacket,input:{encoding:'UTF8_TEXT',text:reviewProgram.reviewPacket,sha256:sha(reviewProgram.reviewPacket),canonicalPromptSha256:sha(reviewProgram.reviewPacket),schemaJson,schemaSha256:schemaJson?sha(schemaJson):null},response:{encoding:options.structured?'CLAUDE_STRUCTURED_OUTPUT':'RAW_JSON_TEXT',raw:JSON.stringify(review),sha256:sha(JSON.stringify(review)),transportRaw:initRaw+'\n'+resultRaw+'\n'},provenance:{cliVersion:'constructed-cli',sessionId:'constructed-claude-session',modelId:'constructed-model',tools:[],exitCode:0,command:['claude','--output-format','stream-json',...(schemaJson?['--json-schema',schemaJson]:[])],stdinSha256:sha(reviewProgram.reviewPacket),initRaw,resultRaw}};
 const capture:NativeAttentionCapture={method:NATIVE_ATTENTION_METHOD,purpose:NATIVE_ATTENTION_PURPOSE,token,createdAt:at(181000),read:read as NativeAttentionCapture['read'],executions:[native as NativeAttentionCapture['executions'][0],claude as NativeAttentionCapture['executions'][1]]};
 return capture;
}
export function replaceFixtureReview(capture:NativeAttentionCapture,wire:unknown){
 const e=capture.executions[1],raw=JSON.stringify(wire),result=JSON.parse(e.provenance.resultRaw);
 if(e.response.encoding==='CLAUDE_STRUCTURED_OUTPUT')result.structured_output=wire;else result.result=raw;
 const resultRaw=JSON.stringify(result);e.response.raw=raw;e.response.sha256=sha(raw);e.response.transportRaw=e.response.transportRaw!.replace(e.provenance.resultRaw,resultRaw);e.provenance.resultRaw=resultRaw;
}
