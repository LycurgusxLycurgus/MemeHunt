import { PublicKey } from '@solana/web3.js';
import { executedWindowInstructions, recordedWindowInstructions } from './advisory-window-accounts.js';

export type StepProof='LOGGED_SUCCESS'|'COMMITTED'|'ROLLED_BACK'|'UNKNOWN';
export type ProofStep={ix:any;depth:number;top:number;position:number;parent:number;executed:boolean;proof:StepProof};

// Native/builtin hosts and precompiles can handle a child's error Result directly, so their children's success is never inferred.
// Union of the old A29 v2 native list with pinned mainnet builtins, including both ZK proof programs.
const HOST=new Set(['11111111111111111111111111111111','ComputeBudget111111111111111111111111111111','Vote111111111111111111111111111111111111111','Stake11111111111111111111111111111111111111','Config1111111111111111111111111111111111111','BPFLoaderUpgradeab1e11111111111111111111111','BPFLoader2111111111111111111111111111111111','BPFLoader1111111111111111111111111111111111','LoaderV411111111111111111111111111111111111','NativeLoader1111111111111111111111111111111','AddressLookupTab1e1111111111111111111111111','Ed25519SigVerify111111111111111111111111111','KeccakSecp256k11111111111111111111111111111','Secp256r1SigVerify1111111111111111111111111','ZkTokenProof1111111111111111111111111111111','ZkE1Gama1Proof11111111111111111111111111111','Feature111111111111111111111111111111111111']);
const INVOKE=/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/,OUTCOME=/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/;
const fail=(code:string):never=>{throw new Error(code);};

// position is -1 for a top-level instruction and the inner-group index otherwise; parent is the global index (-1 at top level).
function shape(list:Array<{ix:any;depth:number;top:number;executed:boolean}>):ProofStep[]{
 const out:ProofStep[]=[],stack:number[]=[];let position=-1;
 list.forEach((s,i)=>{
  position=s.depth===1?-1:position+1;stack.length=s.depth-1;
  out.push({ix:s.ix,depth:s.depth,top:s.top,position,parent:s.depth===1?-1:stack[s.depth-2]!,executed:s.executed,proof:s.executed?'LOGGED_SUCCESS':'ROLLED_BACK'});
  stack[s.depth-1]=i;
 });
 return out;
}

/** Committed-step proof shared by the A29 recovery decoder and owner binder. False returns the old executed view unchanged. True binds the exact log prefix to the recorded tree. Under finalized success, it infers COMMITTED only through ordinary SBF ancestry: a failed ancestor stays ROLLED_BACK, and anything below a host whose outcome is unlogged is UNKNOWN. */
export function runtimeWindowSteps(projected:any,recovery=false):{list:ProofStep[];logged:number;truncated:boolean}{
 if(!recovery){const list=shape(executedWindowInstructions(projected));return{list,logged:list.length,truncated:false};}
 if(projected?.meta?.err!==null)fail('A29_RUNTIME_ERR');
 const list=shape(recordedWindowInstructions(projected)),keys=projected?.transaction?.message?.accountKeys;
 if(!Array.isArray(keys))fail('A29_RUNTIME_MEMBERSHIP');
 const canonical=(k:unknown)=>{if(typeof k!=='string')return false;try{return new PublicKey(k).toBase58()===k;}catch{return false;}};
 const members=new Set((keys as any[]).map(k=>canonical(k?.pubkey)?k.pubkey:fail('A29_RUNTIME_MEMBERSHIP')));
 for(const s of list)if(!members.has(s.ix.programId)||!Array.isArray(s.ix.accounts)||s.ix.accounts.some((k:unknown)=>typeof k!=='string'||!members.has(k)))fail('A29_RUNTIME_MEMBERSHIP');
 const logs=projected.meta.logMessages;
 if(!Array.isArray(logs)||logs.some((l:unknown)=>typeof l!=='string'))fail('A29_RUNTIME_LOG');
 const cut=logs.indexOf('Log truncated'),truncated=cut>=0;
 // Exactly one canonical marker; only the prefix before it is bound, and any suffix is ignored.
 if(truncated&&logs.indexOf('Log truncated',cut+1)>=0)fail('A29_RUNTIME_LOG');
 // A failed callee traps its ordinary SBF caller immediately, so failure propagates up to the first HOST, which alone may catch it.
 const outcome:Array<boolean|undefined>=[],stack:number[]=[],mustFail=new Set<number>();let cursor=0;
 for(const line of (truncated?logs.slice(0,cut):logs) as string[]){
  const inv=line.match(INVOKE);
  if(inv){const s=list[cursor];if(stack.length&&mustFail.has(stack.at(-1)!)||!s||Number(inv[2])!==stack.length+1||s.depth!==stack.length+1||s.ix.programId!==inv[1]||s.parent!==(stack.at(-1)??-1))fail('A29_RUNTIME_LOG_BINDING');stack.push(cursor++);continue;}
  const out=line.match(OUTCOME);
  if(out){const p=stack.pop();if(p===undefined||list[p]!.ix.programId!==out[1])fail('A29_RUNTIME_LOG_BINDING');outcome[p!]=out[2]==='success';if(list[p!]!.parent<0&&!outcome[p!]||mustFail.has(p!)&&outcome[p!])fail('A29_RUNTIME_LOG_BINDING');
   const up=list[p!]!.parent;if(!outcome[p!]&&up>=0&&!HOST.has(list[up]!.ix.programId))mustFail.add(up);continue;}
  if(/^Program \S+ (invoke|success|failed)(?:\b|:)/.test(line)||/log truncated/i.test(line))fail('A29_RUNTIME_LOG_INCOMPLETE');
 }
 if(!truncated&&(stack.length||cursor!==list.length))fail('A29_RUNTIME_LOG_INCOMPLETE');
 // A pending failure at the marker is consistent with finalized success only if an open HOST above it can catch it.
 for(const [j,e] of stack.entries())if(mustFail.has(e)&&!stack.slice(0,j).some(a=>HOST.has(list[a]!.ix.programId)))fail('A29_RUNTIME_LOG_BINDING');
 // The first unlogged node either starts a new top-level instruction or is a child of a frame still open at the marker.
 const next=list[cursor];
 if(next&&next.depth>1&&(next.depth>stack.length+1||next.parent!==stack[next.depth-2]))fail('A29_RUNTIME_LOG_BINDING');
 // Ancestors precede descendants, so each parent's proof is final before its children.
 // COMMITTED requires the whole chain, including the step itself, to be ordinary SBF; a host step needs an explicit logged success.
 const hosted:boolean[]=[];
 for(const [i,s] of list.entries()){
  const up=s.parent<0?undefined:list[s.parent]!;
  hosted[i]=HOST.has(s.ix.programId)||s.parent>=0&&hosted[s.parent]!;
  if(up?.proof==='ROLLED_BACK'||outcome[i]===false)s.proof='ROLLED_BACK';
  else if(up?.proof==='UNKNOWN')s.proof='UNKNOWN';
  else s.proof=outcome[i]===true?'LOGGED_SUCCESS':hosted[i]?'UNKNOWN':'COMMITTED';
  s.executed=s.proof==='LOGGED_SUCCESS'||s.proof==='COMMITTED';
 }
 return{list,logged:cursor,truncated};
}
