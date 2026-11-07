import { setTimeout as delay } from 'node:timers/promises';
import { readLimitedText } from './http.js';

export type JupiterResponse = {status:number;raw:string;value:unknown;attempts:Array<{status:number;raw:string}>};

/** One client serializes and spaces requests; only HTTP 429 is retried. */
export function createJupiterClient(fetcher:typeof fetch=fetch,wait:(ms:number,signal?:AbortSignal)=>Promise<void>=async(ms,signal)=>{await delay(ms,undefined,{signal});},onAttempt?:(attempt:number,response:{status:number;raw:string})=>void){
 let tail:Promise<void>=Promise.resolve(),lastStarted=0;
 const request=(url:string,init:RequestInit,signal?:AbortSignal):Promise<JupiterResponse>=>{
  const run=async()=>{
   const attempts:Array<{status:number;raw:string}>=[];
   for(let attempt=0;attempt<4;attempt++){
    signal?.throwIfAborted();
    const pause=Math.max(0,lastStarted+1100-Date.now());if(pause)await wait(pause,signal);
    lastStarted=Date.now();
    const timeout=AbortSignal.timeout(15000),response=await fetcher(url,{...init,signal:signal?AbortSignal.any([signal,timeout]):timeout});
    const raw=response.body?await readLimitedText(response,2_000_000):'';let value:unknown;try{value=JSON.parse(raw);}catch{value=null;}
    attempts.push({status:response.status,raw});
    onAttempt?.(attempt+1,{status:response.status,raw});
    if(response.status!==429||attempt===3)return {status:response.status,raw,value,attempts};
    await wait(1500*(attempt+1),signal);
   }
   throw Error('JUPITER_REQUEST_UNAVAILABLE');
  };
  const result=tail.then(run);tail=result.then(()=>undefined,()=>undefined);return result;
 };
 return {
  quote(inputMint:string,outputMint:string,amount:string,slippageBps:number,signal?:AbortSignal){
   const url=new URL('https://lite-api.jup.ag/swap/v1/quote');url.searchParams.set('inputMint',inputMint);url.searchParams.set('outputMint',outputMint);url.searchParams.set('amount',amount);url.searchParams.set('slippageBps',String(slippageBps));
   return request(url.toString(),{method:'GET',headers:{accept:'application/json'}},signal);
  },
  swap(quoteResponse:unknown,userPublicKey:string,signal?:AbortSignal){
   return request('https://lite-api.jup.ag/swap/v1/swap',{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({quoteResponse,userPublicKey,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true})},signal);
  },
 };
}
