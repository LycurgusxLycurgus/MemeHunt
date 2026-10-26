import { readFileSync } from 'node:fs';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import { decodeA29TradesV2, decodeA29TradesV3, bindA29TradeAccountV2, bindA29TradeAccountV3 } from '../src/providers/advisory-absorption-v2-owner.js';
import { runtimeWindowSteps } from '../src/providers/advisory-runtime-proof.js';

// Fixture shape matches a29-c5-wbtc-receipts.json.
const load=(name:string)=>{
 const fx=JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`,import.meta.url),'utf8'));
 const pool=PUMP_AMM_SDK.decodePool({data:Buffer.from(fx.pool.dataBase64,'base64'),owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0} as any);
 return{baseMint:pool.baseMint.toBase58(),baseVault:pool.poolBaseTokenAccount.toBase58(),decode:(id:string,v3=false)=>(v3?decodeA29TradesV3:decodeA29TradesV2)(JSON.parse(fx.receipts[id].response).result,fx.receipts[id].expected,fx.pool.key,pool,fx.pool.stateSlot,fx.receipts[id].retrieved,fx.quoteProgram,fx.quoteDecimals)};
};

describe('A29 v3 owner on retained receipts',()=>{
 const c5=load('a29-c5-wbtc-receipts.json'),gap=load('a29-trace-gap-receipts.json');
 for(const id of ['001','002','003','004'])it(`benchmark${id} v3 equals every unambiguous v2 binding`,()=>{
  let out:any;try{out=c5.decode(id);}catch(e){assert.match((e as Error).message,/^(ADVISORY_TRADE|A29)/);return;}
  let compared=0;
  for(const t of out.trades){let v2;try{v2=bindA29TradeAccountV2(out.projected,t,c5.baseMint,c5.baseVault);}catch{continue;}if(!v2.ambiguous){assert.deepEqual(bindA29TradeAccountV3(out.projected,t,c5.baseMint,c5.baseVault),v2);compared++;}}
  if(id!=='001')assert.ok(compared>0);
 });
 const cases:Array<[string,number,number,string,string,number]>=[
  ['a29-transaction-125',5,14,'6PF27TSCVBxvMvcRTSdCTMwixGMdgHRrpm2VZ44GgSLx','9xVWuyEmp2ip1jAJ5QsA7gBujeLGLZRjojADEZ45bgxC',33],
  ['a29-transaction-349',5,16,'A8GmDThbc5YrAZv1idVB9bgRdZXZhEri5tKnoUXjfBPd','6QLNsNyvPyM1H4fzhuReeuNMrwGygTp5BEeA9triKm6L',35],
  ['a29-transaction-432',0,0,'8UFqfimrQ8KJMpf4PhLHkSfYPsN2uMrAM4kHjepQQ96H','pXRFxkiWGJc7Rri4FLqAZD52UcKvs6gBqM6ZfuKqquW',3]];
 for(const [id,top,position,account,owner,legPosition] of cases)it(`${id} resolves the owner at the leg that v2 could not`,()=>{
  const {projected,trades}=gap.decode(id),t=trades.find(x=>x.provenance?.top===top&&x.provenance?.position===position);
  assert.ok(t);
  assert.deepEqual(bindA29TradeAccountV3(projected,t!,gap.baseMint,gap.baseVault),{account,owners:[owner],ambiguous:false,legPosition});
  let v2:any;try{v2=bindA29TradeAccountV2(projected,t!,gap.baseMint,gap.baseVault);}catch(e){v2=(e as Error).message;}
  if(typeof v2==='string')assert.equal(v2,'A29V2_FRAME_UNLOGGED');else assert.equal(v2.ambiguous,true);
 });
 // Requires the shared decoder's a29Recovery profile.
 for(const id of ['a29-transaction-6','a29-transaction-101','a29-transaction-167'])it(`${id} recovered trades bind through the same committed steps`,()=>{
  const {projected,trades}=gap.decode(id,true),{list}=runtimeWindowSteps(projected,true);
  assert.ok(trades.length>0);
  for(const t of trades){const b=bindA29TradeAccountV3(projected,t,gap.baseMint,gap.baseVault);assert.equal(list[b.legPosition]!.executed,true);if(!b.ambiguous)assert.equal(b.owners.length,1);}
 });
});

// Clearly synthetic projected trees exercising the production v3 binder directly.
const PUMP='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYS='11111111111111111111111111111111',SBF='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const O='D8fcUEeTusV3S4EXsgDFc8QHjvoYZkCsU4qg8PNaQvwV',X='HDmssgnF4xd1mV6dfDe3NkgacZoD3tAfKEZ7FRh6tjdp',A='25gTGgf4JwkNjQywSBvPLCzk2fniDo4vNH7zisXNwgne',B='BfhbvWntS2AMXG8wmhTi76NSs8ufsiGVQuFYSX6eUNg5';
const M='C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump',V='AhVBxmfr4s7W4ZcGnwp5eNo5i4Nv4tCE1YQrCcGDWgas',EA='GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR';
const A58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=(b:Buffer)=>{let n=BigInt('0x'+(b.toString('hex')||'0')),s='';while(n>0n){s=A58[Number(n%58n)]+s;n/=58n;}for(const x of b){if(x)break;s='1'+s;}return s;};
const u64=(tag:number,v:bigint)=>{const b=Buffer.alloc(9);b[0]=tag;b.writeBigUInt64LE(v,1);return b58(b);};
const key=(k:string)=>new PublicKey(k).toBuffer();
type N={programId:string;accounts:string[];data:string;out?:string};
type Top={ix:N;inner?:Array<[number,N]>};
const transfer=(src:string,dst:string,amount=100n):N=>({programId:TOKEN,accounts:[src,dst,O],data:u64(3,amount)});
const raw=(accounts:string[],bytes:number[]):N=>({programId:TOKEN,accounts,data:b58(Buffer.from(bytes))});
const init3=(owner:string):N=>({programId:TOKEN,accounts:[A,M],data:b58(Buffer.concat([Buffer.from([18]),key(owner)]))});
const setOwner=(owner:string):N=>({programId:TOKEN,accounts:[A,O],data:b58(Buffer.concat([Buffer.from([6,2,1]),key(owner)]))});
const close=raw([A,O,O],[9]);
const event=(p:string):N=>({programId:PUMP,accounts:[EA],data:b58(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(p)]))});
const pump=():N=>({programId:PUMP,accounts:[O],data:b58(Buffer.from([1,2,3,4,5,6,7,8]))});
const host=(programId:string,accounts=[O]):N=>({programId,accounts,data:'1'});
function tx(tops:Top[],o:Record<string,any>={}):any{
 const nodes:Array<[number,N]>=[];for(const t of tops){nodes.push([1,t.ix]);nodes.push(...(t.inner??[]));}
 const logs:string[]=[],stack:N[]=[],pop=()=>{const x=stack.pop()!;logs.push(`Program ${x.programId} ${x.out??'success'}`);};
 for(const [d,x] of nodes){while(stack.length>=d)pop();logs.push(`Program ${x.programId} invoke [${d}]`);stack.push(x);}while(stack.length)pop();
 const keys=[...new Set(nodes.flatMap(([,x])=>[x.programId,...x.accounts]))];
 const row=(owner:unknown)=>owner===undefined?[]:[{accountIndex:keys.indexOf(A),mint:M,owner}];
 return{transaction:{message:{accountKeys:keys.map((pubkey,i)=>({pubkey,signer:i===0})),instructions:tops.map(t=>t.ix)}},meta:{err:null,logMessages:o.keep===undefined?logs:[...logs.slice(0,o.keep),'Log truncated'],innerInstructions:tops.flatMap((t,index)=>t.inner?[{index,instructions:t.inner.map(([d,x])=>({...x,stackHeight:d}))}]:[]),preTokenBalances:row('pre' in o?o.pre:O),postTokenBalances:row('post' in o?o.post:O)}};
}
const trade=(top:number,position:number,routeEvent:number|null,payload:string,side='SELL'):any=>({signature:'s',slot:1,at:'',user:O,side,baseAtomic:'100',quoteAtomic:'1',poolBaseReservesAtomic:'1',poolQuoteReservesAtomic:'1',instructionIndex:0,provenance:{top,position,pumpOrdinal:0,hop:routeEvent,routeEvent,eventPayload:Buffer.from(payload).toString('base64')}});
const direct=(before:N[]=[],after:N[]=[]):Top[]=>[...before.map(ix=>({ix})),{ix:pump(),inner:[[2,transfer(A,V)],[2,event('E0')]]},...after.map(ix=>({ix}))];
const bind=(p:any,t:any)=>bindA29TradeAccountV3(p,t,M,V),known=(legPosition:number)=>({account:A,owners:[O],ambiguous:false,legPosition});

describe('A29 v3 synthetic committed frames',()=>{
 it('wholly unlogged selected frame, event and leg under SBF ancestry bind; v2 stays blocked',()=>{
  const p=tx(direct(),{keep:1});
  assert.deepEqual(bind(p,trade(0,-1,null,'E0')),known(1));
  assert.throws(()=>bindA29TradeAccountV2(p,trade(0,-1,null,'E0'),M,V),/A29V2_FRAME_UNLOGGED/);
 });
 it('a selected-disjoint unlogged foreign tail does not erase a proven event and leg',()=>{
  const p=tx([{ix:pump(),inner:[[2,transfer(A,V)],[2,event('E0')],[2,host(SBF,[EA])],[3,host(SBF,[EA])]]}],{keep:6});
  assert.deepEqual(bind(p,trade(0,-1,null,'E0')),known(1));
 });
 it('native ancestry and unproven vault legs fail closed',()=>{
  assert.throws(()=>bind(tx([{ix:host(SYS),inner:[[2,pump()],[3,transfer(A,V)],[3,event('E0')]]}],{keep:1}),trade(0,0,null,'E0')),/A29_TRADE_STEP/);
  assert.throws(()=>bind(tx([{ix:pump(),inner:[[2,host(SYS)],[3,transfer(A,V)],[2,event('E0')]]}],{keep:1}),trade(0,-1,null,'E0')),/A29V3_LEG_UNPROVEN/);
 });
 it('duplicate or forged events and duplicate legs fail closed',()=>{
  assert.throws(()=>bind(tx([{ix:pump(),inner:[[2,transfer(A,V)],[2,event('E0')],[2,event('E0')]]}]),trade(0,-1,null,'E0')),/A29V2_EVENT_IDENTITY/);
  assert.throws(()=>bind(tx(direct()),trade(0,-1,null,'E1')),/A29V2_EVENT_IDENTITY/);
  assert.throws(()=>bind(tx([{ix:pump(),inner:[[2,transfer(A,V)],[2,transfer(A,V)],[2,event('E0')]]}]),trade(0,-1,0,'E0')),/A29_TRADE_LEG/);
 });
 it('owner at leg: terminal close after the leg and a unique init before it resolve',()=>{
  assert.deepEqual(bind(tx(direct([],[close]),{post:undefined}),trade(0,-1,null,'E0')),known(1));
  assert.equal(bindA29TradeAccountV2(tx(direct([],[close]),{post:undefined}),trade(0,-1,null,'E0'),M,V).ambiguous,true);
  assert.deepEqual(bind(tx(direct([init3(O)]),{pre:undefined}),trade(1,-1,null,'E0')),known(2));
  assert.deepEqual(bind(tx([...direct(),{ix:{...pump(),programId:SYS},inner:[[2,{...close,out:'failed: custom program error: 0x1'}]]}]),trade(0,-1,null,'E0')),known(1));
  assert.deepEqual(bind(tx(direct([],[raw([B,A,O],[9])])),trade(0,-1,null,'E0')),known(1));
 });
 it('reassignment, close+reinit, close before leg, malformed, unknown extension and unknown execution stay ambiguous',()=>{
  const amb=(p:any,top=0)=>assert.equal(bind(p,trade(top,-1,null,'E0')).ambiguous,true);
  amb(tx(direct([],[close])));
  amb(tx(direct([],[close,init3(O)])));
  amb(tx(direct([close,init3(O)])),2);
  amb(tx(direct([],[setOwner(X)]),{post:X}));
  amb(tx(direct([setOwner(X),setOwner(O)])),2);
  amb(tx(direct([],[raw([A,O,O],[9,0])]),{post:undefined}));
  amb(tx(direct([],[raw([B,A,O],[26,1])])));
  amb(tx([...direct(),{ix:host(SYS),inner:[[2,close]]}],{keep:7,post:undefined}));
  amb(tx(direct(),{post:X}));
 });
});
