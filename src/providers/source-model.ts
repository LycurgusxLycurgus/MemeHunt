import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGeminiSemanticRequest, geminiSettings } from './gemini.js';
import { readLimitedText } from './http.js';

export type SourceSpan={id:string;sourceId:string;start:number;end:number;text:string};
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

export async function requestSourceJson<S extends z.ZodType>(packet:string,schema:S,key:string,fetcher:typeof fetch,retain:(raw:string,retrying?:boolean,transportAttempt?:number,responseAttempt?:number)=>void,wait:(ms:number)=>Promise<void>,signal?:AbortSignal,prefix='ATT_MODEL'):Promise<{raw:string;value:z.output<S>}>{
  if(packet.length>300000)throw new Error(`${prefix}_PACKET_LIMIT`);
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
  for(let attempt=0;;attempt++){
    checkRun();
    const local=AbortSignal.timeout(90000),started=Date.now();
    let phase:'RESPONSE_HEADERS'|'RESPONSE_BODY'='RESPONSE_HEADERS',retrying=false;
    const receipt=(code:string)=>retain(JSON.stringify({kind:'LOCAL_MODEL_TRANSPORT',attempt:attempt+1,phase,elapsedMs:Math.max(0,Date.now()-started),budgetMs:90000,code,willRetry:retrying}),false,attempt+1);
    try{
      response=await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:payload,signal:signal?AbortSignal.any([local,signal]):local});
      phase='RESPONSE_BODY';
      raw=await readLimitedText(response,400000);
      checkRun();
      retrying=[408,503,504].includes(response.status)&&attempt<2;
      retain(raw,retrying,undefined,attempt+1);
      receipt(`${prefix}_HTTP_${response.status}`);
      if(!retrying)break;
    }catch(error){
      if(signal?.aborted){receipt(signal.reason?.name==='TimeoutError'?`${prefix}_RUN_TIMEOUT`:`${prefix}_RUN_ABORTED`);checkRun();}
      const timeout=local.aborted||error instanceof Error&&error.name==='TimeoutError';
      retrying=timeout&&attempt<2;
      receipt(timeout?`${prefix}_TIMEOUT`:error instanceof Error&&error.name==='AbortError'?`${prefix}_ABORTED`:`${prefix}_TRANSPORT`);
      if(!retrying){if(timeout)throw new Error(`${prefix}_TIMEOUT`);throw error;}
    }
    checkRun();
    const backoff=attempt===0?30000:60000;
    try{if(wait===delay)await delay(backoff,undefined,{signal});else await wait(backoff);}catch(error){checkRun();throw error;}
    checkRun();
  }
  if(!response.ok)throw new Error(`${prefix}_HTTP_${response.status}`);
  return {raw,value:schema.parse(parseSourceResponse(raw,prefix))};
}
