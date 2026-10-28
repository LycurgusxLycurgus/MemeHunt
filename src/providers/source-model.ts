import { createHash } from 'node:crypto';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGeminiSemanticRequest, geminiSettings } from './gemini.js';
import type { EvidenceRecord } from '../domain/contracts.js';
import { nvidiaSettings, nvidiaPacerForKey, buildNvidiaSourceRequest, parseNvidiaSourceResponse } from './nvidia.js';
import { openRouterSettings, openRouterPacerForKey, buildOpenRouterSourceRequest, parseOpenRouterSourceResponse } from './openrouter.js';
import { readLimitedText } from './http.js';
import { countGeminiInput, type GeminiPacer, type GeminiAdmission } from './gemini-pacing.js';

export type SourceModelRouting={fallbackActive:boolean;pacing?:GeminiPacer;fallbackMode?:'nvidia-v1'|'openrouter-v1';nvidiaKey?:string;openrouterKey?:string};
export type SourceSpan={id:string;sourceId:string;start:number;end:number;text:string};
/** Only an explicitly identified minute quota can recover within this run. */
function minuteQuotaDelay(raw:string,model:string):number|null{
  try{
    const error=JSON.parse(raw).error;
    if(error?.code!==429||error.status!=='RESOURCE_EXHAUSTED'||!Array.isArray(error.details))return null;
    const violations=error.details.filter((d:{'@type'?:string})=>d['@type']==='type.googleapis.com/google.rpc.QuotaFailure').flatMap((d:{violations?:unknown[]})=>Array.isArray(d.violations)?d.violations:[]);
    const retry=error.details.find((d:{'@type'?:string})=>d['@type']==='type.googleapis.com/google.rpc.RetryInfo');
    if(!violations.length||!violations.every((v:{quotaId?:unknown;quotaValue?:unknown;quotaDimensions?:{model?:string}})=>typeof v.quotaId==='string'&&/PerMinute(?:-|$)/.test(v.quotaId)&&Number(v.quotaValue)>0&&v.quotaDimensions?.model===model)||typeof retry?.retryDelay!=='string'||!/^\d+(?:\.\d+)?s$/.test(retry.retryDelay))return null;
    const ms=Number(retry.retryDelay.slice(0,-1))*1000;
    return Number.isFinite(ms)&&ms>=0&&ms<=60000?ms:null;
  }catch{return null;}
}
/** Parse only the final non-thought JSON; persistence uses the same response boundary. */
export function parseSourceResponse(raw:string,prefix='ATT_MODEL'):unknown{
  const envelope=JSON.parse(raw);
  if(envelope.choices!==undefined||envelope.object==='chat.completion')return envelope.model===openRouterSettings.model?parseOpenRouterSourceResponse(envelope,prefix):parseNvidiaSourceResponse(envelope,prefix);
  if(envelope.promptFeedback?.blockReason||envelope.candidates?.length!==1||envelope.candidates[0].finishReason!=='STOP')throw new Error(`${prefix}_FINISH`);
  const parts=envelope.candidates[0].content?.parts?.filter((p:{thought?:boolean})=>!p.thought);
  if(parts?.length!==1||typeof parts[0].text!=='string')throw new Error(`${prefix}_CONTENT`);
  return JSON.parse(parts[0].text);
}
const responseHash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
function responseReceipts(id:string,rawArtifacts:Record<string,string>){
  const match=id.match(/^(.*)-response(?:-attempt-(\d+))?$/);
  if(!match)return {attempt:null,receipts:[] as any[]};
  const receipts=Object.entries(rawArtifacts).flatMap(([key,value])=>{
    const suffix=key.match(/^(.*)-transport-attempt-(\d+)$/);
    if(!suffix||suffix[1]!==match[1])return [];
    try{const r=JSON.parse(value);return [{...r,artifactAttempt:Number(suffix[2])}];}catch{return [{invalid:true}];}
  });
  return {attempt:match[2]?Number(match[2]):null,receipts};
}
export function sourceModelArtifactInfo(id:string,raw:string,rawArtifacts:Record<string,string>):{sourceId:'gemini'|'nvidia'|'openrouter';model?:string}|null{
  let body:any;try{body=JSON.parse(raw);}catch{/* Failed HTTP text remains retained. */}
  const {attempt,receipts}=responseReceipts(id,rawArtifacts);
  const fresh=receipts.some(r=>'responseBindingMethod' in r||'responseHash' in r);
  if(fresh){
    if(receipts.some(r=>r.kind!=='LOCAL_MODEL_TRANSPORT'||r.responseBindingMethod!=='retained-body-sha256-v1'||!Number.isInteger(r.attempt)||r.attempt<1||r.attempt>3||r.attempt!==r.artifactAttempt||!(r.provider==='openrouter'?r.model===openRouterSettings.model&&r.requestProfile===openRouterSettings.requestProfile:r.provider==='nvidia'?r.model===nvidiaSettings.model:(r.provider===undefined||r.provider==='gemini')&&[geminiSettings.model,geminiSettings.fallbackModel].includes(r.model))||('responseHash' in r&&(typeof r.responseHash!=='string'||!/^[a-f0-9]{64}$/.test(r.responseHash)||r.phase!=='RESPONSE_BODY'||!/_HTTP_\d{3}$/.test(r.code)))))return null;
    const producer=receipts.filter(r=>(attempt===null||r.attempt===attempt)&&r.responseHash===responseHash(raw)).sort((a,b)=>b.attempt-a.attempt)[0];
    if(!producer)return null;
    if(producer.provider==='openrouter'){
      if(body?.candidates!==undefined||body?.modelVersion!==undefined)return null;
      if((body?.choices!==undefined||body?.object==='chat.completion')&&body.model!==openRouterSettings.model)return null;
      return {sourceId:'openrouter',model:openRouterSettings.model};
    }
    if(producer.provider==='nvidia'){
      if(body?.candidates!==undefined||body?.modelVersion!==undefined)return null;
      if((body?.choices!==undefined||body?.object==='chat.completion')&&body.model!==nvidiaSettings.model)return null;
      return {sourceId:'nvidia',model:nvidiaSettings.model};
    }
    if(body?.choices!==undefined||body?.object==='chat.completion'||body?.model===nvidiaSettings.model)return null;
    return {sourceId:'gemini',model:typeof body?.modelVersion==='string'?body.modelVersion:producer.model};
  }
  if(body?.choices!==undefined||body?.object==='chat.completion'||body?.model===nvidiaSettings.model||receipts.some(r=>r.provider==='nvidia'))return null;
  return {sourceId:'gemini',...(typeof body?.modelVersion==='string'?{model:body.modelVersion}:{})};
}
export function sourceModelEvidenceAllowed(e:EvidenceRecord,rawArtifacts:Record<string,string>):boolean{
  if(e.sourceType==='MODEL_INPUT')return e.sourceId==='source-model'&&e.accessMode==='LOCAL_DERIVED'||e.sourceId==='gemini'&&e.accessMode==='FREE_ACCOUNT';
  if(e.sourceType!=='MODEL_RESPONSE'||e.accessMode!=='FREE_ACCOUNT')return false;
  const raw=rawArtifacts[e.id];if(typeof raw!=='string')return false;
  const info=sourceModelArtifactInfo(e.id,raw,rawArtifacts);if(!info)return false;
  if((e.scope.responseBindingMethod!==undefined||responseReceipts(e.id,rawArtifacts).receipts.some(r=>r.responseBindingMethod==='retained-body-sha256-v1'))&&(e.scope.responseBindingMethod!=='retained-body-sha256-v1'||e.scope.provider!==info.sourceId||e.scope.model!==info.model||!responseReceipts(e.id,rawArtifacts).receipts.some(r=>r.responseBindingMethod==='retained-body-sha256-v1'&&r.responseHash===responseHash(raw))))return false;
  if(e.sourceId==='gemini')return e.scope.provider!=='nvidia'&&e.scope.provider!=='openrouter'&&info.sourceId==='gemini';
  if(e.sourceId==='openrouter')return info.sourceId==='openrouter'&&e.scope.provider==='openrouter'&&e.scope.model===openRouterSettings.model;
  return e.sourceId==='nvidia'&&info.sourceId==='nvidia'&&e.scope.provider==='nvidia'&&e.scope.model===nvidiaSettings.model;
}
export function sourceSpans(sourceId:string,text:string,prefix='ATT_MODEL'):SourceSpan[]{
  const protectedRuns=[...text.matchAll(/[A-Za-z0-9]{32,64}/g)].map(m=>({start:m.index!,end:m.index!+m[0].length}));
  const spans:SourceSpan[]=[];
  if(text.length<8)return spans;
  let start=0;
  while(start<text.length){
    let end=Math.min(start+1000,text.length);
    if(end<text.length){
      const newline=text.lastIndexOf('\n',end-1);
      if(newline>=start+500)end=newline+1;
      if(text.length-end<8)end=text.length-8;
      const run=protectedRuns.find(r=>r.start<end&&r.end>end);
      if(run)end=run.start;
      if(end>start&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
    }
    if(end-start<8||end-start>1000)throw new Error(`${prefix}_SOURCE_UNCITABLE`);
    spans.push({id:`${sourceId}:span:${spans.length}`,sourceId,start,end,text:text.slice(start,end)});
    start=end;
  }
  return spans;
}

export async function requestSourceJson<S extends z.ZodType>(packet:string,schema:S,key:string,fetcher:typeof fetch,retain:(raw:string,retrying?:boolean,transportAttempt?:number,responseAttempt?:number)=>void,wait:(ms:number)=>Promise<void>,signal?:AbortSignal,prefix='ATT_MODEL',routing?:SourceModelRouting):Promise<{raw:string;value:z.output<S>}>{
  // Larger full-source packets require real token admission; unpaced legacy calls keep their prior cap.
  if(packet.length>(routing?.pacing?1000000:300000))throw new Error(`${prefix}_PACKET_LIMIT`);
  const body={...buildGeminiSemanticRequest('attention-source-review'),contents:[{role:'user',parts:[{text:packet}]}]};
  // Gemini's supported subset omits dialect and string-length keywords; Zod still enforces them locally.
  const jsonSchema=JSON.parse(JSON.stringify(z.toJSONSchema(schema),(name,value)=>{
    if(['$schema','minLength','maxLength','minItems','maxItems'].includes(name))return undefined;
    // Gemini documents string enums; encode literal citation IDs as one-value enums.
    // Local Zod parsing still enforces the original exact source/span contract.
    if(value&&typeof value==='object'&&typeof value.const==='string'){
      const {const:literal,...rest}=value;return {...rest,enum:[literal]};
    }
    return value;
  }));
  const payload=JSON.stringify({...body,generationConfig:{...body.generationConfig,responseJsonSchema:jsonSchema}});
  const checkRun=()=>{if(signal?.aborted)throw new Error(signal.reason?.name==='TimeoutError'?`${prefix}_RUN_TIMEOUT`:`${prefix}_RUN_ABORTED`);};
  let response:Response,raw:string;
  // A sibling stage may update the run preference, but never this request's recovery plan.
  const nvidiaMode=routing?.fallbackMode==='nvidia-v1';
  const openrouterMode=routing?.fallbackMode==='openrouter-v1';
  const nativeMode=nvidiaMode||openrouterMode;
  const fallbackAvailable=openrouterMode?!!routing?.openrouterKey:!nvidiaMode||!!routing?.nvidiaKey;
  const preferredFallback=fallbackAvailable&&routing?.fallbackActive===true;
  let selectedFallback=preferredFallback;
  let primaryRejected=false;
  const counts=new Map<string,Awaited<ReturnType<typeof countGeminiInput>>>();
  for(let attempt=0;;attempt++){
    checkRun();
    selectedFallback=fallbackAvailable&&(primaryRejected|| (attempt===2?!preferredFallback:preferredFallback));
    const nvidia=nvidiaMode&&selectedFallback;
    const openrouter=openrouterMode&&selectedFallback,native=nvidia||openrouter;
    const model=openrouter?openRouterSettings.model:nvidia?nvidiaSettings.model:selectedFallback?geminiSettings.fallbackModel:geminiSettings.model;
    const nativeAdmission=openrouter?await openRouterPacerForKey(routing!.openrouterKey!).admit(wait,signal):nvidia?await nvidiaPacerForKey(routing!.nvidiaKey!).admit(wait,signal):undefined;
    let admission:GeminiAdmission|undefined;
    if(routing?.pacing&&!native){
      let count=counts.get(model);
      if(!count){try{count=await countGeminiInput(model,payload,key,fetcher,signal);}catch(error){checkRun();throw error;}counts.set(model,count);}
      checkRun();
      if(packet.length>300000&&count.method!=='COUNT_TOKENS')throw new Error(`${prefix}_TOKEN_COUNT_UNAVAILABLE`);
      try{admission=await routing.pacing.admit(model,count.tokens,count.method,wait,signal);}catch(error){checkRun();if(error instanceof Error&&error.message==='GEMINI_INPUT_BUDGET')throw new Error(`${prefix}_INPUT_TOKEN_LIMIT`);throw error;}
    }
    const budgetMs=openrouter?openRouterSettings.requestTimeoutMs:nvidia?nvidiaSettings.requestTimeoutMs:90000;
    const local=AbortSignal.timeout(budgetMs),started=Date.now();
    let phase:'RESPONSE_HEADERS'|'RESPONSE_BODY'='RESPONSE_HEADERS',retrying=false,handoff=false,quotaDelay:number|null=null,attemptRaw:string|undefined,retainedBody:string|undefined;
    const receipt=(code:string)=>retain(JSON.stringify({kind:'LOCAL_MODEL_TRANSPORT',attempt:attempt+1,phase,elapsedMs:Math.max(0,Date.now()-started),budgetMs,model,...(native?{provider:openrouter?'openrouter':'nvidia',pacing:nativeAdmission,...(openrouter?{requestProfile:openRouterSettings.requestProfile}:{})}:{}),...(nativeMode?{responseBindingMethod:'retained-body-sha256-v1',...(retainedBody!==undefined?{responseHash:responseHash(retainedBody)}:{})}:{}),code,willRetry:retrying,...(admission?{pacing:{inputTokens:admission.inputTokens,countMethod:admission.countMethod,waitedMs:admission.waitedMs,inputTokensPerMinute:routing!.pacing!.inputTokensPerMinute,requestsPerMinute:routing!.pacing!.requestsPerMinute}}:{})}),false,attempt+1);
    try{
      checkRun();
      response=await fetcher(openrouter?openRouterSettings.url:nvidia?nvidiaSettings.url:`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:native?{Authorization:'Bearer '+(openrouter?routing!.openrouterKey!:routing!.nvidiaKey!),'content-type':'application/json',accept:'application/json'}:{'x-goog-api-key':key,'content-type':'application/json'},body:openrouter?JSON.stringify(buildOpenRouterSourceRequest(packet,z.toJSONSchema(schema))):nvidia?JSON.stringify(buildNvidiaSourceRequest(packet,z.toJSONSchema(schema))):payload,signal:signal?AbortSignal.any([local,signal]):local});
      phase='RESPONSE_BODY';
      raw=await readLimitedText(response,400000);attemptRaw=raw;
      checkRun();
      quotaDelay=response.status===429?minuteQuotaDelay(raw,model):null;
      if(response.status===400&&!selectedFallback&&openrouterMode&&fallbackAvailable&&attempt<2){
        try{const error=JSON.parse(raw)?.error;handoff=error?.code===400&&error?.status==='INVALID_ARGUMENT';}catch{/* An invalid error envelope cannot trigger a provider handoff. */}
      }
      if(handoff)primaryRejected=true;
      retrying=(handoff||[408,500,503,504].includes(response.status)||quotaDelay!==null)&&attempt<2;
      retain(raw,retrying,undefined,attempt+1);retainedBody=raw;
      receipt(`${prefix}_HTTP_${response.status}`);
      if(!retrying)break;
    }catch(error){
      if(signal?.aborted){receipt(signal.reason?.name==='TimeoutError'?`${prefix}_RUN_TIMEOUT`:`${prefix}_RUN_ABORTED`);checkRun();}
      const timeout=local.aborted||error instanceof Error&&error.name==='TimeoutError';
      retrying=timeout&&attempt<2;
      receipt(timeout?`${prefix}_TIMEOUT`:error instanceof Error&&error.name==='AbortError'?`${prefix}_ABORTED`:`${prefix}_TRANSPORT`);
      if(!retrying){if(timeout)throw new Error(`${prefix}_TIMEOUT`);throw error;}
    }finally{if(admission)routing!.pacing!.settle(admission,attemptRaw);}
    checkRun();
    if(handoff)continue;
    const backoff=Math.max(attempt===0?30000:60000,quotaDelay??0);
    try{if(wait===delay)await delay(backoff,undefined,{signal});else await wait(backoff);}catch(error){checkRun();throw error;}
    checkRun();
  }
  if(!response.ok)throw new Error(`${prefix}_HTTP_${response.status}`);
  const value=schema.parse(parseSourceResponse(raw,prefix));
  if(routing)routing.fallbackActive=selectedFallback;
  return {raw,value};
}
