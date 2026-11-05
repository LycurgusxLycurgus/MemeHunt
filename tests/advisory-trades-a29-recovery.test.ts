import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
const partial=(a:any,e:any)=>{for(const k of Object.keys(e))assert.deepEqual(a[k],e[k]);};
import { readFileSync } from 'node:fs';
import { PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import {projectCompiledTransaction} from '../src/providers/advisory-demand-windows.js';

const load=(n:string)=>JSON.parse(readFileSync(new URL(`../../tests/fixtures/${n}`,import.meta.url),'utf8'));
const f=load('a29-trace-gap-receipts.json');
const pool=PUMP_AMM_SDK.decodePool({data:Buffer.from(f.pool.dataBase64,'base64')} as any);
const TRUNCATED=['a29-transaction-6','a29-transaction-101','a29-transaction-167','a29-transaction-547'];
const FEE:Record<string,[string,string]>={'a29-transaction-720':['6195','6196'],'a29-transaction-721':['6195','6196'],'a29-transaction-986':['12390','12391']};
const OTHER=['a29-transaction-125','a29-transaction-349','a29-transaction-432'];
const raw=(fx:any,id:string)=>{const r=fx.receipts[id];return projectCompiledTransaction(JSON.parse(r.response).result);};
const run=(fx:any,id:string,value:unknown,rec?:boolean)=>{const r=fx.receipts[id],p=fx===f?pool:PUMP_AMM_SDK.decodePool({data:Buffer.from(fx.pool.dataBase64,'base64')} as any);return rec===undefined?decodePumpSwapWindowTransaction(value,r.expected,fx.pool.key,p,fx.pool.stateSlot,r.retrieved,true,true,true,true,true,true,fx.quoteProgram,true,fx.quoteDecimals,true):decodePumpSwapWindowTransaction(value,r.expected,fx.pool.key,p,fx.pool.stateSlot,r.retrieved,true,true,true,true,true,true,fx.quoteProgram,true,fx.quoteDecimals,true,rec);};
const out=(fn:()=>unknown)=>{try{return JSON.stringify(fn());}catch(e){return `ERR:${(e as Error).message}`;}};
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const dec58=(s:string)=>{let n=0n;for(const c of s)n=n*58n+BigInt(B58.indexOf(c));let h=n.toString(16);if(h.length%2)h='0'+h;return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),n?Buffer.from(h,'hex'):Buffer.alloc(0)]);};
const enc58=(b:Buffer)=>{let n=BigInt('0x'+(b.toString('hex')||'0')),s='';while(n>0n){s=B58[Number(n%58n)]+s;n/=58n;}let z=0;while(z<b.length&&b[z]===0)z++;return '1'.repeat(z)+s;};
const compiled=(id:string)=>JSON.parse(f.receipts[id].response).result;
const keysOf=(c:any)=>[...c.transaction.message.accountKeys.map((k:any)=>typeof k==='string'?k:k.pubkey),...(c.meta.loadedAddresses?.writable??[]),...(c.meta.loadedAddresses?.readonly??[])];
// Physical raw compiled TransferChecked into the selected quote vault, located before projection.
const vaultIn=(c:any)=>{const k=keysOf(c);for(const g of c.meta.innerInstructions)for(const [i,x] of g.instructions.entries()){if(k[x.programIdIndex]!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')continue;const b=dec58(x.data);if(b.length===10&&b[0]===12&&k[x.accounts[2]]===pool.poolQuoteTokenAccount.toBase58())return {g,i,x,b};}throw new Error('fixture vault leg');};

describe('a29Recovery decoder profile', () => {
 it('keeps default-false outputs and reasons exact', () => {
  for(const id of TRUNCATED)assert.equal(out(()=>run(f,id,raw(f,id),false)),'ERR:ADVISORY_TRADE_LOG_TRUNCATED');
  for(const id of Object.keys(FEE))assert.equal(out(()=>run(f,id,raw(f,id),false)),'ERR:ADVISORY_TRADE_FEE_BINDING');
  for(const id of [...TRUNCATED,...Object.keys(FEE),...OTHER])assert.equal(out(()=>run(f,id,raw(f,id))),out(()=>run(f,id,raw(f,id),false)));
  const old=load('a29-c5-wbtc-receipts.json');
  for(const id of Object.keys(old.receipts))assert.equal(out(()=>run(old,id,raw(old,id))),out(()=>run(old,id,raw(old,id),false)));
 });
 it('decodes the retained truncated representatives', () => {
  for(const id of TRUNCATED){const p=run(f,id,raw(f,id),true);assert.equal(p.logRecovery?.truncated,true);assert.ok((p.trades.length)>(0));for(const t of p.trades)assert.equal(typeof (t.provenance?.eventPayload),'string');}
 });
 it('books exact-in budget remainders from typed user debits', () => {
  for(const [id,[booked,budget]] of Object.entries(FEE)){const t=run(f,id,raw(f,id),true).trades.find(x=>x.quoteAccounting?.method==='pumpswap-event-fee-exclusive-v4')!;
   partial(t.quoteAccounting,{bookedQuoteAtomic:booked,walletQuoteAtomic:booked,budgetAtomic:budget,budgetRemainderAtomic:'1',transferWitness:'TRANSFER_CHECKED'});}
 });
 it('leaves the other gaps decoder-identical or decoded', () => {
  for(const id of OTHER)assert.doesNotMatch(out(()=>run(f,id,raw(f,id),true)),/^ERR:ADVISORY_TRADE_(LOG_TRUNCATED|FEE_BINDING)$/);
 });
 it('rejects debit mutations', () => {
  const id='a29-transaction-720',W='ERR:ADVISORY_TRADE_QUOTE_TRANSFER_WITNESS';
  type L={g:any;i:number;x:any;b:Buffer};
  const muts:Array<(l:L)=>void>=[
   l=>{l.b.writeBigUInt64LE(l.b.readBigUInt64LE(1)-1n,1);l.x.data=enc58(l.b);},
   l=>{l.b.writeBigUInt64LE(l.b.readBigUInt64LE(1)+1n,1);l.x.data=enc58(l.b);},
   l=>{l.b[9]=l.b[9]!+1;l.x.data=enc58(l.b);},
   l=>{l.x.accounts=[...l.x.accounts.slice(0,3),l.x.accounts[2]];},
   l=>{l.x.accounts=[l.x.accounts[0],l.x.accounts[2],...l.x.accounts.slice(2)];},
   l=>{l.x.data=enc58(Buffer.concat([Buffer.from([3]),l.b.subarray(1,9)]));l.x.accounts=[l.x.accounts[0],l.x.accounts[2],l.x.accounts[3]];},
   l=>{l.x.accounts=[...l.x.accounts,l.x.accounts[3]];},
   l=>{const y=structuredClone(l.x),c=Buffer.from(l.b);c.writeBigUInt64LE(1n,1);y.data=enc58(c);y.accounts=[l.x.accounts[0],l.x.accounts[1],l.x.accounts[0],l.x.accounts[3]];l.g.instructions.splice(l.i+1,0,y);},
   l=>{const y=structuredClone(l.x),c=Buffer.from(l.b.subarray(0,9));c[0]=4;y.data=enc58(c);y.accounts=[l.x.accounts[0],l.x.accounts[2],l.x.accounts[3]];l.g.instructions.splice(l.i+1,0,y);}];
  for(const [j,m] of muts.entries()){
   const c=compiled(id),l=vaultIn(c);let ordinal=0;
   for(let t=0;t<c.transaction.message.instructions.length;t++){if(t===l.g.index){ordinal+=1+l.i;break;}ordinal+=1+(c.meta.innerInstructions.find((g:any)=>g.index===t)?.instructions.length??0);}
   const invokes=c.meta.logMessages.flatMap((line:string,n:number)=>/ invoke \[\d+\]$/.test(line)?[n]:[]),start=invokes[ordinal]!;
   const end=c.meta.logMessages.findIndex((line:string,n:number)=>n>start&&line===`Program ${f.quoteProgram} success`);
   m(l);
   // The two inserted token nodes receive coherent success logs, so the debit witness (not prefix mismatch) must reject them.
   if(j>=7){assert.ok(end>=0);c.meta.logMessages.splice(end+1,0,`Program ${f.quoteProgram} invoke [${l.x.stackHeight}]`,`Program ${f.quoteProgram} success`);}
   assert.equal(out(()=>run(f,id,projectCompiledTransaction(c),true)),W);
  }
  const e=raw(f,id);e.meta.err={};assert.equal(out(()=>run(f,id,e,true)),'ERR:ADVISORY_TRADE_TRANSACTION_BINDING');
 });
 it('rejects trace, prefix, parent, native and duplicate-event mutations', () => {
  const id='a29-transaction-6',bad=(m:(v:any)=>void)=>{const v=raw(f,id);m(v);return out(()=>run(f,id,v,true));};
  assert.match(bad(v=>{const i=v.meta.logMessages.findIndex((l:string)=>/ invoke \[2\]$/.test(l));v.meta.logMessages[i]=v.meta.logMessages[i].replace(/^Program \S+/,'Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');}),/^ERR:/);
  assert.match(bad(v=>{const g=v.meta.innerInstructions.at(-1);g.instructions.at(-1).stackHeight=9;}),/^ERR:/);
  assert.match(bad(v=>{for(const g of v.meta.innerInstructions)for(const x of g.instructions)if(x.programId==='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'&&x.stackHeight===2){const i=v.transaction.message.instructions[g.index];i.programId='11111111111111111111111111111111';}}),/^ERR:/);
  assert.match(bad(v=>{for(const g of v.meta.innerInstructions){const i=g.instructions.findIndex((x:any)=>x.programId==='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'&&x.accounts?.length===1);if(i>=0){g.instructions.splice(i+1,0,structuredClone(g.instructions[i]));break;}}}),/^ERR:/);
  assert.match(bad(v=>{v.meta.logMessages.push('Log truncated');}),/^ERR:/);
  assert.match(bad(v=>{v.meta.err={InstructionError:[0,'Custom']};}),/^ERR:/);
 });
 it('rejects an unconsumed selected-touching tail', () => {
  const id='a29-transaction-547',v=raw(f,id),ins=v.transaction.message.instructions,last=ins.at(-1);
  if(Array.isArray(last.accounts))last.accounts=[pool.poolQuoteTokenAccount.toBase58(),...last.accounts.slice(1)];
  assert.match(out(()=>run(f,id,v,true)),/^ERR:/);
 });
 it('enforces scope', () => {
  const id='a29-transaction-720',r=f.receipts[id];
  assert.equal(out(()=>decodePumpSwapWindowTransaction(raw(f,id),r.expected,f.pool.key,pool,f.pool.stateSlot,r.retrieved,true,true,true,true,false,true,f.quoteProgram,true,f.quoteDecimals,true,true)),'ERR:ADVISORY_TRADE_A29_RECOVERY_SCOPE');
 });
});
