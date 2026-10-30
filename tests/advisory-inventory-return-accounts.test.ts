import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindInventoryReturnEndpoints,deriveO26InventoryReturns} from '../src/providers/advisory-inventory-return-accounts.js';
import {createO26InventoryCapture} from './inventory-returns-fixtures.js';
import type {InventoryReturnSourceContext} from '../src/providers/advisory-inventory-returns-source.js';

const DIRECT='2RukXtMqv6EAFFQppeaS1TfRmiXBEDgBeFBAnMPYkRsC',EPHEMERAL='EDS3q3c6SUeN6ajXULWo5ZChzLenbC2A1NMT7K1xYHWX';
const BUY='3uzeE8sfKpNJRNcpcWHYFeJNcGMEKhuLT7pba8uhBEevx7N6yeiepFnH4DUDVVN3sYJQY3roXBFBEVzBSWpARoAM',SELL='4p2WSiBhQdWXNSG2pNpaqcGZiHPBWscMfEZofb64KbCXnH9r1x8taysA6iXikpGqZbNnkyCDhuvk5YAGKqVVWRDi',TEMP='3KCXXwsW6gm6kr3Bc79vNBSXHAx1SNf4q3kczMxRMvmSfhJHo9jDkLdy2GJUdySYTJNpEvAQdyspnxGrhdrpBTAq';
function scenario(work:(context:InventoryReturnSourceContext)=>void){const dir=mkdtempSync(join(tmpdir(),'inventory-return-'));try{work(createO26InventoryCapture(dir).context);}finally{rmSync(dir,{recursive:true,force:true});}}
const run=(context:InventoryReturnSourceContext)=>deriveO26InventoryReturns(context,['own-capture']);
function changeBody(c:InventoryReturnSourceContext,signature:string,change:(value:any)=>void){const old=c.transactions.get(signature)!;const value=structuredClone(old.value);change(value);const record={...old,value};c.transactions=new Map(c.transactions);c.transactions.set(signature,record);if(c.windowNativeRecords.has(signature)){c.windowNativeRecords=new Map(c.windowNativeRecords);c.windowNativeRecords.set(signature,record);}}
const flatten=(v:any)=>[...v.transaction.message.instructions,...v.meta.innerInstructions.flatMap((g:any)=>g.instructions)];
const missing=(m:ReturnType<typeof run>)=>{assert.equal(m.quality,'MISSING');assert.equal((m.data as any).complete,false);assert.equal((m.data as any).motifCount,undefined);assert.equal((m.data as any).accounts,undefined);};

test('genuine three-body constructed census proves a positive complete motif with native WBTC denominator',()=>scenario(c=>{
 const before=JSON.stringify({window:c.window,bindings:c.bindings,rows:[...c.indexes],values:[...c.transactions]});const m=run(c),d=m.data as any;assert.equal(m.quality,'KNOWN');assert.equal(d.method,'selected-window-inventory-return-v3');assert.equal(d.population,2);assert.equal(d.coveredAccounts,2);assert.equal(d.complete,true);assert.equal(d.motifCount,1);assert.equal(d.repeatedMotifCount,0);assert.equal(d.motifGrossQuoteAtomic,'2416');assert.equal(d.coveredTradeGrossQuoteAtomic,'3477');assert.equal(d.openAccounts,0);assert.equal(d.passThroughReturns,1);assert.equal(d.singleSidePoolReturns,1);assert.equal(d.transferOnlyReturns,0);assert.equal(d.quoteDecimals,8);assert.equal(d.quoteMint,c.poolContext.quote.mint);assert.equal(d.sourceCoverage.quantityContexts,3);assert.equal(d.sourceCoverage.continuityPairs,1);assert.equal(d.sourceCoverage.initializations,2);assert.equal(d.sourceCoverage.closes,1);assert.equal(d.sourceCoverage.selfTransfers,1);
 assert.equal(d.custodySplit.USER_TOKEN_ACCOUNT.population,2);assert.equal(d.custodySplit.PROTOCOL_VAULT.population,0);assert.equal(d.custodySplit.USER_TOKEN_ACCOUNT.coveredTradeGrossQuoteAtomic,'3477');assert.equal(d.motifs[0].account,DIRECT);assert.equal(d.motifs[0].proof.length,2);assert.deepEqual(d.motifs[0].signatures,[BUY,SELL]);assert.equal(JSON.stringify({window:c.window,bindings:c.bindings,rows:[...c.indexes],values:[...c.transactions]}),before);
}));

test('ephemeral absent raw balances require positive execution, init and close; self-transfer is one zero observation',()=>scenario(c=>{
 const d=run(c).data as any,account=d.accounts.find((a:any)=>a.account===EPHEMERAL),v=account.transactions[0];assert.equal(v.preAtomic,'0');assert.equal(v.postAtomic,'0');assert.deepEqual(v.lifecycle,['INITIALIZED','CLOSED']);assert.equal(v.selfTransfers.length,1);assert.equal(v.selfTransfers[0].amountAtomic,'114730547');assert.equal(v.legs.length,2);assert.equal(account.legs.filter((l:any)=>l.kind==='POOL_SELL').length,1);assert.equal(d.motifs.length,1);
 c.companions=new Map(c.companions);c.companions.delete(TEMP);missing(run(c));
}));

test('an incomplete selected binding or forged custody cache never leaves partial known motifs',()=>{
 scenario(c=>{c.bindings={...c.bindings,bindings:c.bindings.bindings.slice(1)};missing(run(c));});
 scenario(c=>{c.bindings={...c.bindings,custody:c.bindings.custody.map(r=>({...r,kind:'PROTOCOL_VAULT' as const}))};missing(run(c));});
 scenario(c=>{const rows=new Map(c.windowNativeRecords);rows.delete(BUY);assert.throws(()=>bindInventoryReturnEndpoints(c.window,c.poolContext,rows),/INVENTORY_RETURNS_TRADE_SOURCE/);});
});

test('owner, mint and decimal contradictions reject the whole account history',()=>{
 for(const field of ['owner','mint','decimals'])scenario(c=>{changeBody(c,SELL,v=>{const at=v.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===DIRECT);const row=v.meta.preTokenBalances.find((r:any)=>r.accountIndex===at);if(field==='decimals')row.uiTokenAmount.decimals=9;else row[field]=field==='mint'?c.poolContext.quote.mint:c.poolContext.poolKey;});missing(run(c));});
});

test('balanced per-transaction states cannot hide an inter-transaction continuity gap',()=>scenario(c=>{
 changeBody(c,SELL,v=>{const at=v.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===DIRECT);for(const side of ['preTokenBalances','postTokenBalances']){const row=v.meta[side].find((r:any)=>r.accountIndex===at);row.uiTokenAmount.amount=String(BigInt(row.uiTokenAmount.amount)+1n);}});const m=run(c);missing(m);assert.equal(m.reasonCode,'INVENTORY_RETURNS_CONTINUITY');
}));

test('missing body, omitted account row and absent lifecycle witnesses are whole failures',()=>{
 scenario(c=>{c.transactions=new Map(c.transactions);c.transactions.delete(SELL);missing(run(c));});
 scenario(c=>{c.indexes=new Map(c.indexes);c.indexes.set(DIRECT,c.indexes.get(DIRECT)!.filter(r=>r.signature!==SELL));missing(run(c));});
 scenario(c=>{changeBody(c,BUY,v=>{for(const ix of flatten(v))if(ix.parsed?.type==='initializeAccount3'&&ix.parsed.info.account===DIRECT)ix.parsed.type='unsupportedInitialize';});missing(run(c));});
});

test('unsupported relevant writer, altered selected amount and insufficient self-transfer balance stay unresolved',()=>{
 scenario(c=>{changeBody(c,SELL,v=>{for(const ix of flatten(v))if(ix.parsed?.type==='transferChecked'&&ix.parsed.info.source===DIRECT)ix.parsed.type='unrecognizedAmountWriter';});missing(run(c));});
 scenario(c=>{changeBody(c,SELL,v=>{for(const ix of flatten(v))if(ix.parsed?.type==='transferChecked'&&ix.parsed.info.source===DIRECT)ix.parsed.info.tokenAmount.amount='135649089';});missing(run(c));});
 scenario(c=>{changeBody(c,TEMP,v=>{for(const ix of flatten(v))if(ix.parsed?.type==='transferChecked'&&ix.parsed.info.source===EPHEMERAL&&ix.parsed.info.destination===EPHEMERAL)ix.parsed.info.tokenAmount.amount='114730548';});missing(run(c));});
});
