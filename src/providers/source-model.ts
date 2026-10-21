import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGeminiSemanticRequest, geminiSettings } from './gemini.js';
import { readLimitedText } from './http.js';
import { countGeminiInput, type GeminiPacer, type GeminiAdmission } from './gemini-pacing.js';

export type SourceModelRouting={fallbackActive:boolean;pacing?:GeminiPacer};
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
  if(envelope.promptFeedback?.blockReason||envelope.candidates?.length!==1||envelope.candidates[0].finishReason!=='STOP')throw new Error(`${prefix}_FINISH`);
  const parts=envelope.candidates[0].content?.parts?.filter((p:{thought?:boolean})=>!p.thought);
  if(parts?.length!==1||typeof parts[0].text!=='string')throw new Error(`${prefix}_CONTENT`);
  return JSON.parse(parts[0].text);
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
  const counts=new Map<string,Awaited<ReturnType<typeof countGeminiInput>>>();
  for(let attempt=0;;attempt++){
    checkRun();
    if(attempt===2&&routing)routing.fallbackActive=true;
    const model=routing?.fallbackActive||attempt===2?geminiSettings.fallbackModel:geminiSettings.model;
    let admission:GeminiAdmission|undefined;
    if(routing?.pacing){
      let count=counts.get(model);
      if(!count){try{count=await countGeminiInput(model,payload,key,fetcher,signal);}catch(error){checkRun();throw error;}counts.set(model,count);}
      checkRun();
      if(packet.length>300000&&count.method!=='COUNT_TOKENS')throw new Error(`${prefix}_TOKEN_COUNT_UNAVAILABLE`);
      try{admission=await routing.pacing.admit(model,count.tokens,count.method,wait,signal);}catch(error){checkRun();if(error instanceof Error&&error.message==='GEMINI_INPUT_BUDGET')throw new Error(`${prefix}_INPUT_TOKEN_LIMIT`);throw error;}
    }
    const local=AbortSignal.timeout(90000),started=Date.now();
    let phase:'RESPONSE_HEADERS'|'RESPONSE_BODY'='RESPONSE_HEADERS',retrying=false,quotaDelay:number|null=null,attemptRaw:string|undefined;
    const receipt=(code:string)=>retain(JSON.stringify({kind:'LOCAL_MODEL_TRANSPORT',attempt:attempt+1,phase,elapsedMs:Math.max(0,Date.now()-started),budgetMs:90000,model,code,willRetry:retrying,...(admission?{pacing:{inputTokens:admission.inputTokens,countMethod:admission.countMethod,waitedMs:admission.waitedMs,inputTokensPerMinute:routing!.pacing!.inputTokensPerMinute,requestsPerMinute:routing!.pacing!.requestsPerMinute}}:{})}),false,attempt+1);
    try{
      checkRun();
      response=await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:payload,signal:signal?AbortSignal.any([local,signal]):local});
      phase='RESPONSE_BODY';
      raw=await readLimitedText(response,400000);attemptRaw=raw;
      checkRun();
      quotaDelay=response.status===429?minuteQuotaDelay(raw,model):null;
      retrying=([408,500,503,504].includes(response.status)||quotaDelay!==null)&&attempt<2;
      retain(raw,retrying,undefined,attempt+1);
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
    const backoff=Math.max(attempt===0?30000:60000,quotaDelay??0);
    try{if(wait===delay)await delay(backoff,undefined,{signal});else await wait(backoff);}catch(error){checkRun();throw error;}
    checkRun();
  }
  if(!response.ok)throw new Error(`${prefix}_HTTP_${response.status}`);
  return {raw,value:schema.parse(parseSourceResponse(raw,prefix))};
}
