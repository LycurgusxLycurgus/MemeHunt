import { setTimeout as delay } from 'node:timers/promises';
import { readLimitedText } from './http.js';

export type RugCheckAttempt={status:number;raw:string};
let requestTail:Promise<void>=Promise.resolve(),lastStarted=0;

/** Bounded third-party report transport; the caller interprets the report. */
export function createRugCheckClient(fetcher:typeof fetch=fetch,wait:(ms:number,signal?:AbortSignal)=>Promise<void>=async(ms,signal)=>{await delay(ms,undefined,{signal});}){
 return {report(mint:string,signal?:AbortSignal,onAttempt?:(attempt:number,value:RugCheckAttempt)=>void){
  const run=async()=>{
   for(let attempt=1;attempt<=4;attempt++){
    signal?.throwIfAborted();const pause=Math.max(0,lastStarted+1100-Date.now());if(pause)await wait(pause,signal);lastStarted=Date.now();
    const timeout=AbortSignal.timeout(15000),response=await fetcher(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`,{headers:{accept:'application/json'},signal:signal?AbortSignal.any([signal,timeout]):timeout});
    const raw=response.body?await readLimitedText(response,2_000_000):'';onAttempt?.(attempt,{status:response.status,raw});
    if(response.status!==429||attempt===4){let value:unknown;try{value=JSON.parse(raw);}catch{value=null;}return {status:response.status,raw,value};}
    await wait(1500*attempt,signal);
   }
   throw Error('RUGCHECK_UNAVAILABLE');
  };
  const result=requestTail.then(run);requestTail=result.then(()=>undefined,()=>undefined);return result;
 }};
}
