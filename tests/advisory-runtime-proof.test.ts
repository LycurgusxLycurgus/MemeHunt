import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import { runtimeWindowSteps } from '../src/providers/advisory-runtime-proof.js';
import { executedWindowInstructions } from '../src/providers/advisory-window-accounts.js';

// Clearly synthetic projected trees; instruction data is opaque to the runtime proof.
const SBF='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',PUMP='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYS='11111111111111111111111111111111',ZK='ZkTokenProof1111111111111111111111111111111',O='D8fcUEeTusV3S4EXsgDFc8QHjvoYZkCsU4qg8PNaQvwV';
type N={programId:string;accounts:string[];data:string;out?:string};
type Top={ix:N;inner?:Array<[number,N]>};
const n=(programId:string,out?:string):N=>({programId,accounts:[O],data:'1',...(out?{out}:{})});
function tx(tops:Top[],keep?:number,err:unknown=null):any{
 const nodes:Array<[number,N]>=[];for(const t of tops){nodes.push([1,t.ix]);nodes.push(...(t.inner??[]));}
 const logs:string[]=[],stack:N[]=[],pop=()=>{const x=stack.pop()!;logs.push(`Program ${x.programId} ${x.out??'success'}`);};
 for(const [d,x] of nodes){while(stack.length>=d)pop();logs.push(`Program ${x.programId} invoke [${d}]`);stack.push(x);}while(stack.length)pop();
 const keys=[...new Set(nodes.flatMap(([,x])=>[x.programId,...x.accounts]))];
 return{transaction:{message:{accountKeys:keys.map((pubkey,i)=>({pubkey,signer:i===0})),instructions:tops.map(t=>t.ix)}},meta:{err,logMessages:keep===undefined?logs:[...logs.slice(0,keep),'Log truncated'],innerInstructions:tops.flatMap((t,index)=>t.inner?[{index,instructions:t.inner.map(([d,x])=>({...x,stackHeight:d}))}]:[]),preTokenBalances:[],postTokenBalances:[]}};
}
const proofs=(p:any)=>runtimeWindowSteps(p,true).list.map(s=>s.proof);
const simple=():Top[]=>[{ix:n(SBF),inner:[[2,n(TOKEN)]]}];

describe('A29 runtime step proof',()=>{
 const caught=tx([{ix:n(SBF),inner:[[2,n(PUMP)],[3,n(TOKEN,'failed: custom program error: 0x1')],[2,n(TOKEN)]]}]);
 it('default false is the old executed view with canonical positions and parents',()=>{
  const r=runtimeWindowSteps(caught);
  assert.deepEqual(r.list.map(s=>s.executed),executedWindowInstructions(caught).map((s:any)=>s.executed));
  assert.deepEqual(r.list.map(s=>[s.position,s.parent,s.proof]),[[-1,-1,'LOGGED_SUCCESS'],[0,0,'LOGGED_SUCCESS'],[1,1,'ROLLED_BACK'],[2,0,'LOGGED_SUCCESS']]);
  assert.equal(r.truncated,false);assert.equal(r.logged,4);
  assert.throws(()=>runtimeWindowSteps(tx(simple(),2)),/ADVISORY_ACCOUNTS_LOG_INCOMPLETE/);
 });
 it('true rejects an ordinary SBF caller that succeeds after a failed child',()=>{
  assert.throws(()=>runtimeWindowSteps(caught,true),/^Error: A29_RUNTIME_LOG_BINDING$/);
  assert.throws(()=>runtimeWindowSteps(tx([{ix:n(SBF),inner:[[2,n(PUMP,'failed: e')],[3,n(TOKEN)]]}]),true),/^Error: A29_RUNTIME_LOG_BINDING$/);
 });
 it('a native host may catch a failed ordinary branch; other branches are unaffected',()=>{
  assert.deepEqual(proofs(tx([{ix:n(SYS),inner:[[2,n(PUMP,'failed: e')],[3,n(TOKEN)],[2,n(TOKEN)]]}])),['LOGGED_SUCCESS','ROLLED_BACK','ROLLED_BACK','LOGGED_SUCCESS']);
  assert.deepEqual(proofs(tx([{ix:n(SYS),inner:[[2,n(SBF,'failed: e')],[3,n(PUMP,'failed: e')]]}])),['LOGGED_SUCCESS','ROLLED_BACK','ROLLED_BACK']);
 });
 it('truncated ordinary SBF ancestry commits open and unlogged steps without invented logs',()=>{
  const r=runtimeWindowSteps(tx([{ix:n(SBF),inner:[[2,n(PUMP)],[3,n(TOKEN)],[2,n(TOKEN)]]}],4),true);
  assert.deepEqual(r.list.map(s=>s.proof),['COMMITTED','COMMITTED','LOGGED_SUCCESS','COMMITTED']);
  assert.equal(r.logged,3);assert.equal(r.truncated,true);
 });
 it('a failed SBF child cannot be followed by a later selected branch, and a truncated pending failure needs an open host',()=>{
  assert.throws(()=>runtimeWindowSteps(tx([{ix:n(SBF),inner:[[2,n(TOKEN,'failed: e')],[2,n(PUMP)],[3,n(TOKEN)]]}],4),true),/^Error: A29_RUNTIME_LOG_BINDING$/);
  assert.throws(()=>runtimeWindowSteps(tx([{ix:n(SBF),inner:[[2,n(TOKEN,'failed: e')]]}],3),true),/^Error: A29_RUNTIME_LOG_BINDING$/);
  assert.deepEqual(proofs(tx([{ix:n(SYS),inner:[[2,n(SBF)],[3,n(TOKEN,'failed: e')]]}],4)),['UNKNOWN','UNKNOWN','ROLLED_BACK']);
 });
 it('no inference below an open native or ZK host; closed branches stay independent of the native tail',()=>{
  assert.deepEqual(proofs(tx([...simple(),{ix:n(SYS),inner:[[2,n(PUMP)],[3,n(TOKEN)]]}],5)),['LOGGED_SUCCESS','LOGGED_SUCCESS','UNKNOWN','UNKNOWN','UNKNOWN']);
  assert.deepEqual(proofs(tx([{ix:n(SBF),inner:[[2,n(ZK)],[3,n(TOKEN)]]}],2)),['COMMITTED','UNKNOWN','UNKNOWN']);
  assert.deepEqual(proofs(tx([{ix:n(SBF),inner:[[2,n(SYS)]]}],2)),['COMMITTED','UNKNOWN']);
  assert.deepEqual(proofs(tx([{ix:n(SBF),inner:[[2,n(SYS)],[2,n(TOKEN)]]}],4)),['COMMITTED','LOGGED_SUCCESS','COMMITTED']);
 });
 it('rejects transaction error, prefix, depth, top failure, membership, marker and shape violations',()=>{
  assert.throws(()=>runtimeWindowSteps(tx(simple(),undefined,{InstructionError:[0,'x']}),true),/^Error: A29_RUNTIME_ERR$/);
  const mut=(f:(p:any)=>void,keep?:number)=>{const p=tx(simple(),keep);f(p);return()=>runtimeWindowSteps(p,true);
};
  assert.throws(mut(p=>{p.meta.logMessages[1]=`Program ${PUMP} invoke [2]`;}),/^Error: A29_RUNTIME_LOG_BINDING$/);
  assert.throws(mut(p=>{p.meta.logMessages[1]=`Program ${TOKEN} invoke [3]`;}),/^Error: A29_RUNTIME_LOG_BINDING$/);
  assert.throws(mut(p=>{p.meta.logMessages[3]=`Program ${SBF} failed: e`;}),/^Error: A29_RUNTIME_LOG_BINDING$/);
  assert.throws(mut(p=>{p.transaction.message.accountKeys=p.transaction.message.accountKeys.filter((k:any)=>k.pubkey!==O);}),/^Error: A29_RUNTIME_MEMBERSHIP$/);
  assert.throws(mut(p=>{p.meta.logMessages.push('Log truncated');},2),/^Error: A29_RUNTIME_LOG$/);
  assert.throws(mut(p=>{p.meta.logMessages.splice(2,0,'log truncated');}),/^Error: A29_RUNTIME_LOG_INCOMPLETE$/);
  assert.throws(mut(p=>{p.meta.logMessages.pop();}),/^Error: A29_RUNTIME_LOG_INCOMPLETE$/);
  assert.throws(mut(p=>{p.meta.innerInstructions[0].instructions[0].stackHeight=3;}),/ADVISORY_ACCOUNTS_INNER_DEPTH/);
 });
 it('an unbound suffix after the single marker is ignored without inventing execution',()=>{
  const p=tx(simple(),2);p.meta.logMessages.push('Program log: tail',`Program ${SBF} success`);
  assert.deepEqual(runtimeWindowSteps(p,true),runtimeWindowSteps(tx(simple(),2),true));
  assert.deepEqual(proofs(p),['COMMITTED','COMMITTED']);
 });
 it('rejects a first unlogged node grafted under an already closed parent',()=>{
  const p=tx([{ix:n(SBF),inner:[[2,n(PUMP)],[3,n(TOKEN)],[3,n(TOKEN)]]}],4);p.meta.logMessages.splice(4,0,`Program ${PUMP} success`);
  assert.throws(()=>runtimeWindowSteps(p,true),/^Error: A29_RUNTIME_LOG_BINDING$/);
 });
 it('rejects non-canonical program or account keys',()=>{
  assert.throws(()=>runtimeWindowSteps(tx([{ix:n('ShortHost'),inner:[[2,n(TOKEN)]]}],1),true),/^Error: A29_RUNTIME_MEMBERSHIP$/);
 });
});
