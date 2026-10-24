import { setTimeout as delay } from 'node:timers/promises';

export type LiveStageName='PREFLIGHT'|'ATTENTION'|'SOCIAL'|'SHARED'|'FINALIZE';
export type LiveStopOrigin='PROVIDER'|'PHASE_DEADLINE'|'HARD_DEADLINE'|'OPERATION_LIMIT'|'CALLER'|'DEPENDENCY'|'UNSUPPORTED';
export type LiveRuntime={nowMs:()=>number;timeout:(ms:number)=>AbortSignal;wait:(ms:number)=>Promise<void>};
export const nativeLiveRuntime:LiveRuntime={nowMs:Date.now,timeout:AbortSignal.timeout,wait:ms=>delay(ms)};
const allocations:Record<LiveStageName,number>={PREFLIGHT:12,ATTENTION:60,SOCIAL:18,SHARED:12,FINALIZE:48};
export type LiveStageRecord={phase:LiveStageName;startedAt:string|null;endedAt:string|null;startMs:number|null;endMs:number|null;status:'COMPLETED'|'FAILED'|'CANCELLED'|'NOT_STARTED';ops:number;origin?:LiveStopOrigin;code?:string;blockedBy?:LiveStageName;evidenceIds:string[]};
export type LiveStage={signal:AbortSignal;fetcher:typeof fetch;finish:(failure?:{code:string;origin?:LiveStopOrigin;blockedBy?:LiveStageName})=>void};

/** This run's bounded provider work; semantic cancellation never owns final capture. */
export function createLiveRun(full:boolean,transport:typeof fetch,iso:()=>string,runtime:LiveRuntime=nativeLiveRuntime,caller?:AbortSignal){
 const started=runtime.nowMs(),hardMs=full?840000:120000,hard=runtime.timeout(hardMs);
 const hardSignal=caller?AbortSignal.any([hard,caller]):hard;
 const initial=(phase:LiveStageName):LiveStageRecord=>({phase,startedAt:null,endedAt:null,startMs:null,endMs:null,status:'NOT_STARTED',ops:0,evidenceIds:[]});
 const records:Record<LiveStageName,LiveStageRecord>={PREFLIGHT:initial('PREFLIGHT'),ATTENTION:initial('ATTENTION'),SOCIAL:initial('SOCIAL'),SHARED:initial('SHARED'),FINALIZE:initial('FINALIZE')};
 let total=0,semantic:AbortSignal|undefined,work:AbortSignal|undefined;
 const elapsed=()=>Math.max(0,runtime.nowMs()-started);
 const stop=(name:LiveStageName,signal:AbortSignal):{origin:LiveStopOrigin;code:string}|undefined=>caller?.aborted?{origin:'CALLER',code:'LIVE_CALLER_CANCELLED'}:hard.aborted?{origin:'HARD_DEADLINE',code:'LIVE_HARD_DEADLINE'}:signal.aborted?{origin:'PHASE_DEADLINE',code:'LIVE_PHASE_DEADLINE'}:undefined;
 const error=(code:string)=>Object.assign(new Error(code),{name:code.includes('DEADLINE')?'TimeoutError':'AbortError',code});
 const begin=(name:LiveStageName):LiveStage=>{
  const row=records[name];if(row.startedAt!==null||row.endedAt!==null)throw Error('LIVE_STAGE_RESTART');
  row.startedAt=iso();row.startMs=elapsed();
  if((name==='ATTENTION'||name==='SOCIAL'||name==='SHARED')&&!semantic){semantic=runtime.timeout(600000);work=runtime.timeout(480000);}
  const local=name==='PREFLIGHT'||name==='FINALIZE'?runtime.timeout(full?120000:hardMs):name==='SHARED'?semantic!:work!;
  const controller=new AbortController();
  const cancel=()=>{const interrupted=stop(name,local);if(interrupted)controller.abort(error(interrupted.code));};
  for(const source of [hardSignal,local]){if(source.aborted)cancel();else source.addEventListener('abort',cancel,{once:true});}
  const signal=controller.signal;let finished=false;
  const finish:LiveStage['finish']=failure=>{
   if(finished)return;finished=true;for(const source of [hardSignal,local])source.removeEventListener('abort',cancel);row.endedAt=iso();row.endMs=elapsed();const interrupted=stop(name,signal);
   if(interrupted){row.status='CANCELLED';Object.assign(row,interrupted);}
   else if(failure){row.status=failure.origin==='DEPENDENCY'?'NOT_STARTED':'FAILED';Object.assign(row,failure);}
   else if(row.code)row.status='FAILED';
   else row.status='COMPLETED';
  };
  const fetcher:typeof fetch=async(url,init)=>{
   if(finished)throw error('LIVE_STAGE_FINISHED');
   const interrupted=stop(name,signal);if(interrupted)throw error(interrupted.code);
   // Each unfinished branch retains its reservation; only completed work releases slack.
   const reserved=full?(Object.keys(records) as LiveStageName[]).filter(other=>other!==name&&records[other].endedAt===null).reduce((n,other)=>n+Math.max(0,allocations[other]-records[other].ops),0):0;
   if(total>=150||150-total<=reserved){row.origin='OPERATION_LIMIT';row.code='LIVE_OPERATION_LIMIT';throw error('LIVE_OPERATION_LIMIT');}
   total++;row.ops++;
   return transport(url,{...init,signal:init?.signal?AbortSignal.any([signal,init.signal]):signal});
  };
  return {signal,fetcher,finish};
 };
 const skip=(name:LiveStageName,blockedBy:LiveStageName)=>{const row=records[name];if(row.startedAt!==null||row.endedAt!==null)throw Error('LIVE_STAGE_RESTART');row.endedAt=iso();row.endMs=elapsed();row.origin='DEPENDENCY';row.code='LIVE_DEPENDENCY_SKIPPED';row.blockedBy=blockedBy;};
 return {begin,skip,runtime,elapsed,operations:()=>total,hardSignal,receipt:(token:unknown)=>({method:'phase-isolated-live-v1',token,hardLimitMs:hardMs,semanticLimitMs:full?600000:0,operationLimit:150,allocations:full?allocations:{FINALIZE:150},elapsedMs:elapsed(),admittedRequests:total,stages:Object.values(records)})};
}
