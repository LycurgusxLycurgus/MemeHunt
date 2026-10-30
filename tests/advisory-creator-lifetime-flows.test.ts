import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createO25LifetimeCapture} from './creator-lifetime-bulk-fixtures.js';
import {verifyPublicCreatorRole} from '../src/providers/advisory-creator-role.js';
import {recordedWindowInstructions} from '../src/providers/advisory-window-accounts.js';
import {decodeO25LifetimeFlows,type O25LifetimeFlow} from '../src/providers/advisory-creator-lifetime-flows.js';
const canonical='Ga5159tRwuRDZxZycD9ZpEJyLcVs1vcqFmdyc2kqoNkS',PUMP='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',DLMM='LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
function fixture(run:(f:ReturnType<typeof createO25LifetimeCapture>,role:ReturnType<typeof verifyPublicCreatorRole>)=>void){const dir=mkdtempSync(join(tmpdir(),'o25-flows-'));try{const f=createO25LifetimeCapture(dir),role=verifyPublicCreatorRole(f.token,f.fixture.role,f.cutoff,f.fixture.roleIndexBefore??undefined,true);run(f,role);}finally{rmSync(dir,{recursive:true,force:true});}}
const alpha='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bytes(s:string){let n=0n;for(const c of s)n=n*58n+BigInt(alpha.indexOf(c));const h=n.toString(16);return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),n?Buffer.from(h.length%2?'0'+h:h,'hex'):Buffer.alloc(0)]);}
function base58(b:Buffer){let n=BigInt('0x'+b.toString('hex')),s='';while(n){s=alpha[Number(n%58n)]+s;n/=58n;}return'1'.repeat(b.findIndex(x=>x!==0)<0?b.length:b.findIndex(x=>x!==0))+s;}
const sum=(flows:O25LifetimeFlow[],pick:(f:O25LifetimeFlow)=>boolean)=>flows.filter(pick).reduce((n,f)=>n+f.amountAtomic,0n);

test('genuine136 native receipts yield every222 ordered canonical leg with typed acquisition/sale/income distinctions',()=>fixture((f,role)=>{
 const flows:O25LifetimeFlow[]=[];
 for(const row of f.fixture.canonicalBodies){const legs=decodeO25LifetimeFlows(row.transaction,role,canonical,row.source.retrievedAt,f.poolContext);assert.equal(new Set(legs.map(l=>l.rawLegId)).size,legs.length);assert.ok(legs.every((l,i)=>l.rawLegId===`${l.signature}:${l.order}`&&(i===0||legs[i-1]!.order<l.order)));flows.push(...legs);}
 assert.equal(flows.length,222);assert.equal(sum(flows,l=>l.direction==='IN'),339149663879364n);assert.equal(sum(flows,l=>l.direction==='OUT'),339149663879364n);assert.equal(sum(flows,l=>l.kind==='PURCHASE'),337603576226656n);assert.equal(sum(flows,l=>l.kind==='CROSS_ASSET_EXCHANGE'),1515682959060n);assert.equal(sum(flows,l=>l.kind==='CREATOR_FEE'),30403754759n);assert.equal(sum(flows,l=>l.kind==='HOLDER_DISTRIBUTION'),938889n);assert.equal(sum(flows,l=>l.kind==='SALE'),109149663879364n);assert.equal(sum(flows,l=>l.kind==='PLAIN_TRANSFER'),230000000000000n);
 assert.ok(flows.filter(l=>['PURCHASE','CROSS_ASSET_EXCHANGE','SALE'].includes(l.kind)).every(l=>l.counterasset!==null));assert.ok(flows.filter(l=>['CREATOR_FEE','HOLDER_DISTRIBUTION','PLAIN_TRANSFER'].includes(l.kind)).every(l=>l.counterasset===null));assert.ok(flows.some(l=>l.counterasset!==null&&l.counterasset.mint===role.creation.quoteMint&&l.counterasset.decimals===8));assert.ok(flows.some(l=>l.counterasset!==null&&l.counterasset.mint==='So11111111111111111111111111111111111111112'&&l.counterasset.decimals===9));
}));

test('creation later-truncated BUY uses existing committed-credit recovery and cannot promote an altered transfer',()=>fixture((f,role)=>{
 const c=f.fixture.canonicalBodies.find((r:any)=>r.transaction.transaction.signatures[0]===role.creation.signature);assert.ok(c);const got=decodeO25LifetimeFlows(c.transaction,role,canonical,c.source.retrievedAt,f.poolContext);assert.equal(got.length,1);assert.equal(got[0]!.kind,'PURCHASE');assert.match(got[0]!.sourceSemantics,/POSITIVE_COMMITTED_TRANSFER/);assert.equal(got[0]!.counterasset!.amountAtomic,2608788n);
 const tx=structuredClone(c.transaction),s=recordedWindowInstructions(tx).find(s=>s.ix.parsed?.type==='transferChecked'&&s.ix.parsed.info.destination===canonical)!;s.ix.parsed.info.tokenAmount.amount='1';assert.throws(()=>decodeO25LifetimeFlows(tx,role,canonical,c.source.retrievedAt,f.poolContext));
}));

test('new MainPump typed quote tax/tail and account-role mutations fail whole receipt',()=>fixture((f,role)=>{
 const c=f.fixture.canonicalBodies.find((r:any)=>recordedWindowInstructions(r.transaction).some(s=>s.ix.programId===PUMP&&s.ix.data&&bytes(s.ix.data).subarray(0,8).toString('hex')==='1c92de7726c469d5'));assert.ok(c);
 for(const mutation of [(tx:any)=>{const e=recordedWindowInstructions(tx).find(s=>s.ix.programId===PUMP&&s.ix.data&&bytes(s.ix.data).subarray(0,16).toString('hex')==='e445a52e51cb9a1dbddb7fd34ee661ee')!;const b=bytes(e.ix.data),offset=b.length-7*8;/* quoteAmount is followed by six typed u64 appendix fields. */b.writeBigUInt64LE(b.readBigUInt64LE(offset)+1n,offset);e.ix.data=base58(b);},(tx:any)=>{const e=recordedWindowInstructions(tx).find(s=>s.ix.programId===PUMP&&s.ix.data&&bytes(s.ix.data).subarray(0,16).toString('hex')==='e445a52e51cb9a1dbddb7fd34ee661ee')!;const b=bytes(e.ix.data);b.writeBigUInt64LE(1n,b.length-8);e.ix.data=base58(b);},(tx:any)=>{const e=recordedWindowInstructions(tx).find(s=>s.ix.programId===PUMP&&s.ix.data&&bytes(s.ix.data).subarray(0,16).toString('hex')==='e445a52e51cb9a1dbddb7fd34ee661ee')!;e.ix.data=base58(Buffer.concat([bytes(e.ix.data),Buffer.from([0])]));},(tx:any)=>{const s=recordedWindowInstructions(tx).find(s=>s.ix.programId===PUMP&&s.ix.data&&bytes(s.ix.data).subarray(0,8).toString('hex')==='1c92de7726c469d5')!;s.ix.accounts[10]=s.ix.accounts[9];}]){const tx=structuredClone(c.transaction);mutation(tx);assert.throws(()=>decodeO25LifetimeFlows(tx,role,canonical,c.source.retrievedAt,f.poolContext));}
}));

test('DLMM dual events count once and optional/remaining accounts never receive a blanket waiver',()=>fixture((f,role)=>{
 const c=f.fixture.canonicalBodies.find((r:any)=>recordedWindowInstructions(r.transaction).some(s=>s.ix.programId===DLMM&&s.ix.accounts?.includes(canonical)));assert.ok(c);const got=decodeO25LifetimeFlows(c.transaction,role,canonical,c.source.retrievedAt,f.poolContext).filter(l=>l.sourceSemantics.includes('DLMM'));assert.equal(got.length,1);
 for(const mutate of [(s:any)=>{s.ix.accounts[1]=s.ix.accounts[0];},(s:any)=>{s.ix.accounts[s.ix.accounts.length-1]='11111111111111111111111111111111';},(s:any)=>{const b=bytes(s.ix.data);b.writeUInt32LE(1,24);s.ix.data=base58(b);}]){const tx=structuredClone(c.transaction),s=recordedWindowInstructions(tx).find(s=>s.ix.programId===DLMM&&s.ix.accounts?.includes(canonical))!;mutate(s);assert.throws(()=>decodeO25LifetimeFlows(tx,role,canonical,c.source.retrievedAt,f.poolContext));}
}));

test('source clock, raw writer coverage and holder distribution own-credit boundaries remain explicit',()=>fixture((f,role)=>{
 const holder=f.fixture.canonicalBodies.find((r:any)=>recordedWindowInstructions(r.transaction).some(s=>s.ix.programId===PUMP&&s.ix.data&&bytes(s.ix.data).subarray(0,8).toString('hex')==='623691610246ad2b'));assert.ok(holder);const flow=decodeO25LifetimeFlows(holder.transaction,role,canonical,holder.source.retrievedAt,f.poolContext).find(l=>l.kind==='HOLDER_DISTRIBUTION')!;assert.equal(flow.amountAtomic,938889n);assert.notEqual(flow.amountAtomic,115582824n);assert.equal(flow.counterasset,null);
 assert.throws(()=>decodeO25LifetimeFlows(holder.transaction,role,canonical,'2026-01-01T00:00:00Z',f.poolContext));
 const tx=structuredClone(holder.transaction),s=recordedWindowInstructions(tx).find(s=>s.ix.parsed?.type==='transferChecked'&&s.ix.parsed.info.destination===canonical)!;s.ix.parsed.type='mintTo';assert.throws(()=>decodeO25LifetimeFlows(tx,role,canonical,holder.source.retrievedAt,f.poolContext));
}));


test('genuine DLMM empty-vector and explicit zero-length X/Y hook slices are exact distinct supported encodings',()=>fixture((f,role)=>{
 for(const size of [28,32]){const c=f.fixture.canonicalBodies.find((r:any)=>recordedWindowInstructions(r.transaction).some(s=>s.ix.programId===DLMM&&s.ix.accounts?.includes(canonical)&&s.ix.data&&bytes(s.ix.data).length===size));assert.ok(c);const ix=recordedWindowInstructions(c.transaction).find(s=>s.ix.programId===DLMM&&s.ix.accounts?.includes(canonical))!,raw=bytes(ix.ix.data);assert.equal(raw.subarray(24).toString('hex'),size===28?'00000000':'0200000000000100');const flows=decodeO25LifetimeFlows(c.transaction,role,canonical,c.source.retrievedAt,f.poolContext);assert.equal(flows.filter(l=>l.sourceSemantics.includes('DLMM')).length,1);if(size===32){const tx=structuredClone(c.transaction),step=recordedWindowInstructions(tx).find(s=>s.ix.programId===DLMM&&s.ix.accounts?.includes(canonical))!,bad=bytes(step.ix.data);bad[29]=1;step.ix.data=base58(bad);assert.throws(()=>decodeO25LifetimeFlows(tx,role,canonical,c.source.retrievedAt,f.poolContext),/DLMM_REMAINING_INFO/);}}
}));
