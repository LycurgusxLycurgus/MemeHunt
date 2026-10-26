import { readFileSync } from 'node:fs';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import { decodeA29TradesV2, bindA29TradeAccountV2 } from '../src/providers/advisory-absorption-v2-owner.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import { projectCompiledTransaction } from '../src/providers/advisory-demand-windows.js';

// Fixture shape: {pool:{key,dataBase64,stateSlot},quoteProgram,quoteDecimals,receipts:{[id]:{expected:{signature,slot,at},retrieved,response}}}
const fx=JSON.parse(readFileSync(new URL('../../tests/fixtures/a29-c5-wbtc-receipts.json',import.meta.url),'utf8'));
const pool=PUMP_AMM_SDK.decodePool({data:Buffer.from(fx.pool.dataBase64,'base64'),owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0} as any);
const baseMint=pool.baseMint.toBase58(),baseVault=pool.poolBaseTokenAccount.toBase58();
const result=(id:string,mutate?:(r:any)=>void)=>{const r=JSON.parse(fx.receipts[id].response).result;mutate?.(r);return r;};
const decode=(id:string,r=result(id))=>decodeA29TradesV2(r,fx.receipts[id].expected,fx.pool.key,pool,fx.pool.stateSlot,fx.receipts[id].retrieved,fx.quoteProgram,fx.quoteDecimals);

describe('A29 v2 owner binding',()=>{
 it('benchmark002 binds the route event to its containing frame and own segment leg',()=>{
  const {projected,trades}=decode('002');
  assert.equal(trades.length,1);
  const t=trades[0]!;assert.equal(t.instructionIndex,1);assert.deepEqual(Object.fromEntries(['top','position','pumpOrdinal','hop','routeEvent'].map(k=>[k,(t.provenance as any)?.[k]])),{top:3,position:0,pumpOrdinal:0,hop:1,routeEvent:1});
  const b=bindA29TradeAccountV2(projected,t,baseMint,baseVault);
  assert.deepEqual(b,{account:'25gTGgf4JwkNjQywSBvPLCzk2fniDo4vNH7zisXNwgne',owners:['HDmssgnF4xd1mV6dfDe3NkgacZoD3tAfKEZ7FRh6tjdp'],ambiguous:false,legPosition:15});
  assert.ok(!b.owners.includes(t.user));
 });
 it('benchmark001 truncated receipt: open SBF ancestors recover the closed selected route or fail closed',()=>{
  let out:any;try{out=decode('001');}catch(e){out=(e as Error).message;}
  if(typeof out==='string'){assert.match(out,/^(ADVISORY_TRADE|A29)/);return;}
  assert.equal(out.coverage?.truncated,1);
  for(const t of out.trades){const bound=bindA29TradeAccountV2(out.projected,t,baseMint,baseVault),index=out.projected.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===bound.account),row=out.projected.meta.preTokenBalances.find((r:any)=>r.accountIndex===index);assert.deepEqual(bound.owners,[row.owner]);}
 });
 for(const id of ['003','004'])it(`benchmark${id} BUY binds the known pre/post leg-account owner`,()=>{
  const {projected,trades}=decode(id),keys=projected.transaction.message.accountKeys.map((k:any)=>k.pubkey),positions=new Set<number>();
  assert.ok(trades.some(t=>t.side==='BUY'));
  for(const t of trades){
   const b=bindA29TradeAccountV2(projected,t,baseMint,baseVault),i=keys.indexOf(b.account);
   const pre=projected.meta.preTokenBalances.find((r:any)=>r.accountIndex===i),post=projected.meta.postTokenBalances.find((r:any)=>r.accountIndex===i);
   assert.equal(b.ambiguous,false);assert.equal(pre.owner,post.owner);assert.deepEqual(b.owners,[pre.owner]);
   assert.ok(!positions.has(b.legPosition));positions.add(b.legPosition);
  }
 });
 it('old callers carry no provenance (default false)',()=>{
  const r=fx.receipts['002'],p=projectCompiledTransaction(result('002'));
  const proof=decodePumpSwapWindowTransaction(p,r.expected,fx.pool.key,pool,fx.pool.stateSlot,r.retrieved,true,true,true,true,true,true,fx.quoteProgram,true,fx.quoteDecimals);
  for(const t of proof.trades)assert.equal('provenance' in t,false);
 });
 it('rejects a forged event identity',()=>{
  const {projected,trades}=decode('002');
  assert.throws(()=>bindA29TradeAccountV2(projected,{...trades[0]!,provenance:{...trades[0]!.provenance!,eventPayload:'AA=='}},baseMint,baseVault),/A29V2_EVENT_IDENTITY/);
  assert.throws(()=>bindA29TradeAccountV2(projected,{...trades[0]!,provenance:{...trades[0]!.provenance!,routeEvent:0}},baseMint,baseVault));
  assert.throws(()=>bindA29TradeAccountV2(projected,{...trades[0]!,provenance:undefined},baseMint,baseVault),/A29V2_PROVENANCE/);
 });
 it('rejects a caught or failed frame',()=>{
  assert.throws(()=>decode('002',result('002',r=>{const i=r.meta.logMessages.lastIndexOf('Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success');r.meta.logMessages[i]='Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA failed: custom program error: 0x1';})));
 });
 it('unknown pre-owner and post-owner change stay ambiguous',()=>{
  const noPre=decode('002',result('002',r=>{r.meta.preTokenBalances=r.meta.preTokenBalances.filter((x:any)=>x.accountIndex!==3);}));
  assert.equal(bindA29TradeAccountV2(noPre.projected,noPre.trades[0]!,baseMint,baseVault).ambiguous,true);
  const moved=decode('002',result('002',r=>{for(const x of r.meta.postTokenBalances)if(x.accountIndex===3)x.owner='D8fcUEeTusV3S4EXsgDFc8QHjvoYZkCsU4qg8PNaQvwV';}));
  assert.equal(bindA29TradeAccountV2(moved.projected,moved.trades[0]!,baseMint,baseVault).ambiguous,true);
 });
});

// Clearly synthetic projected trees exercising the production binder directly.
const PUMP='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYS='11111111111111111111111111111111';
const O='D8fcUEeTusV3S4EXsgDFc8QHjvoYZkCsU4qg8PNaQvwV',X='HDmssgnF4xd1mV6dfDe3NkgacZoD3tAfKEZ7FRh6tjdp',A='25gTGgf4JwkNjQywSBvPLCzk2fniDo4vNH7zisXNwgne',B='BfhbvWntS2AMXG8wmhTi76NSs8ufsiGVQuFYSX6eUNg5';
const M='C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump',V='AhVBxmfr4s7W4ZcGnwp5eNo5i4Nv4tCE1YQrCcGDWgas',EA='GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR';
const A58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=(b:Buffer)=>{let n=BigInt('0x'+(b.toString('hex')||'0')),s='';while(n>0n){s=A58[Number(n%58n)]+s;n/=58n;}for(const x of b){if(x)break;s='1'+s;}return s;};
const u64=(tag:number,v:bigint)=>{const b=Buffer.alloc(9);b[0]=tag;b.writeBigUInt64LE(v,1);return b58(b);};
const key=(k:string)=>new PublicKey(k).toBuffer();
type N={programId:string;accounts:string[];data:string;out?:string};
const transfer=(src:string,dst:string,amount=100n):N=>({programId:TOKEN,accounts:[src,dst,O],data:u64(3,amount)});
const init3=(owner:string,acct=A):N=>({programId:TOKEN,accounts:[acct,M],data:b58(Buffer.concat([Buffer.from([18]),key(owner)]))});
const setOwner=(owner:string):N=>({programId:TOKEN,accounts:[A,O],data:b58(Buffer.concat([Buffer.from([6,2,1]),key(owner)]))});
const close:N={programId:TOKEN,accounts:[A,O,O],data:b58(Buffer.from([9]))};
const event=(p:string):N=>({programId:PUMP,accounts:[EA],data:b58(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(p)]))});
const pump=(out?:string):N=>({programId:PUMP,accounts:[O],data:b58(Buffer.from([1,2,3,4,5,6,7,8])),out});
type Top={ix:N;inner?:Array<[number,N]>};
function tx(tops:Top[],o:{pre?:string|null;post?:string;keep?:number}={}){
 const nodes:Array<[number,N]>=[];for(const t of tops){nodes.push([1,t.ix]);nodes.push(...(t.inner??[]));}
 const logs:string[]=[],stack:N[]=[],pop=()=>{const n=stack.pop()!;logs.push(`Program ${n.programId} ${n.out??'success'}`);};
 for(const [d,n] of nodes){while(stack.length>=d)pop();logs.push(`Program ${n.programId} invoke [${d}]`);stack.push(n);}while(stack.length)pop();
 const keys=[...new Set(nodes.flatMap(([,n])=>[n.programId,...n.accounts]))];
 const row=(owner:string|null|undefined)=>owner===undefined?[]:[{accountIndex:keys.indexOf(A),mint:M,owner}];
 return{transaction:{message:{accountKeys:keys.map((pubkey,i)=>({pubkey,signer:i===0})),instructions:tops.map(t=>t.ix)}},meta:{err:null,logMessages:o.keep===undefined?logs:[...logs.slice(0,o.keep),'Log truncated'],innerInstructions:tops.flatMap((t,index)=>t.inner?[{index,instructions:t.inner.map(([d,n])=>({...n,stackHeight:d}))}]:[]),preTokenBalances:o.pre==='omit'?[]:row(o.pre===undefined?O:o.pre),postTokenBalances:row(o.post??O)}};
}
const trade=(top:number,position:number,routeEvent:number|null,payload:string,side='SELL'):any=>({signature:'s',slot:1,at:'',user:O,side,baseAtomic:'100',quoteAtomic:'1',poolBaseReservesAtomic:'1',poolQuoteReservesAtomic:'1',instructionIndex:0,provenance:{top,position,pumpOrdinal:0,hop:routeEvent,routeEvent,eventPayload:Buffer.from(payload).toString('base64')}});
const direct=(before:N[]=[],after:N[]=[],legOut?:string):Top[]=>[...before.map(ix=>({ix})),{ix:pump(),inner:[[2,{...transfer(A,V),out:legOut}],[2,event('E0')]]},...after.map(ix=>({ix}))];
const bind=(p:any,t:any)=>bindA29TradeAccountV2(p,t,M,V);

describe('A29 v2 synthetic lifecycle and identity guards',()=>{
 it('a unique executed init before the leg matching the post-owner resolves a missing pre-owner',()=>{
  assert.deepEqual(bind(tx(direct([init3(O)]),{pre:'omit'}),trade(1,-1,null,'E0')),{account:A,owners:[O],ambiguous:false,legPosition:2});
 });
 it('init after the leg, wrong init owner, SetAuthority, change-revert and close-reinit stay ambiguous',()=>{
  const noPre={pre:'omit'};
  assert.equal(bind(tx(direct([],[init3(O)]),noPre),trade(0,-1,null,'E0')).ambiguous,true);
  assert.equal(bind(tx(direct([init3(X)]),noPre),trade(1,-1,null,'E0')).ambiguous,true);
  assert.equal(bind(tx(direct([setOwner(X)]),{pre:O,post:X}),trade(1,-1,null,'E0')).ambiguous,true);
  assert.equal(bind(tx(direct([setOwner(X),setOwner(O)])),trade(2,-1,null,'E0')).ambiguous,true);
  assert.equal(bind(tx(direct([close,init3(O)])),trade(2,-1,null,'E0')).ambiguous,true);
 });
 it('a caught rolled-back leg is never bound',()=>{
  assert.throws(()=>bind(tx(direct([],[],'failed: custom program error: 0x1')),trade(0,-1,null,'E0')),/A29_TRADE_LEG/);
 });
 it('repeated selected venue with equal amounts binds each event to its own leg and never cross-binds',()=>{
  const p=tx([{ix:pump(),inner:[[2,transfer(A,V)],[2,event('E0')],[2,transfer(B,V)],[2,event('E1')]]}]);
  const a=bind(p,trade(0,-1,0,'E0')),b=bind(p,trade(0,-1,1,'E1'));
  assert.equal(a.account,A);assert.equal(b.account,B);assert.notEqual(a.legPosition,b.legPosition);
  assert.throws(()=>bind(p,trade(0,-1,1,'E0')),/A29V2_EVENT_IDENTITY/);
  const dup=tx([{ix:pump(),inner:[[2,transfer(A,V)],[2,transfer(A,V)],[2,event('E0')]]}]);
  assert.throws(()=>bind(dup,trade(0,-1,0,'E0')),/A29_TRADE_LEG/);
 });
 it('an open native ancestor of the selected frame stays unproven; an unrelated open native tail does not block a closed selected frame',()=>{
  const hosted=tx([{ix:{programId:SYS,accounts:[O],data:'1'},inner:[[2,pump()],[3,transfer(A,V)],[3,event('E0')]]}],{keep:7});
  assert.throws(()=>bind(hosted,trade(0,0,null,'E0')),/A29_TRADE_STEP/);
  const tail=tx([...direct(),{ix:{programId:SYS,accounts:[O],data:'1'}}],{keep:7});
  assert.deepEqual(bind(tail,trade(0,-1,null,'E0')),{account:A,owners:[O],ambiguous:false,legPosition:1});
 });
});
