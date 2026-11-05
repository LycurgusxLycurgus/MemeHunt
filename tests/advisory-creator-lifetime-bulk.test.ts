import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateRawSync,deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveO25BulkLifetime} from '../src/providers/advisory-creator-lifetime-bulk.js';
import {createO25LifetimeCapture} from './creator-lifetime-bulk-fixtures.js';

const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function scenario(work:(c:ReturnType<typeof createO25LifetimeCapture>)=>void){const directory=mkdtempSync(join(tmpdir(),'creator-lifetime-'));try{work(createO25LifetimeCapture(directory));}finally{rmSync(directory,{recursive:true,force:true});}}
function bulk(source:any,change:(rows:any[])=>void){const id='bulk-page-0',wrapper=JSON.parse(source.rawArtifacts[id]),body=JSON.parse(inflateRawSync(Buffer.from(wrapper.data,'base64')).toString());change(body.result.data);const raw=Buffer.from(JSON.stringify(body));source.rawArtifacts[id]=JSON.stringify({method:'o23-deflate-raw-v1',encoding:'DEFLATE_RAW_BASE64',sourceBytes:raw.length,sourceHash:sha(raw),data:deflateRawSync(raw).toString('base64')});}
function plain(source:any,id:string,change:(rows:any)=>void){const body=JSON.parse(source.rawArtifacts[id]);change(body.result);source.rawArtifacts[id]=JSON.stringify(body);}
const run=(c:ReturnType<typeof createO25LifetimeCapture>)=>deriveO25BulkLifetime(c.source,c.poolContext,c.cutoff,['inventory','bank']);
const canonical=(tx:any,account:string)=>[...tx.transaction.message.instructions,...tx.meta.innerInstructions.flatMap((g:any)=>g.instructions)].filter((ix:any)=>ix.parsed?.type==='transferChecked'&&(ix.parsed.info.source===account||ix.parsed.info.destination===account));

test('full genuine136receipt fixture proves all lifetime quantities, income components, FIFO and exact realized denominator',()=>scenario(c=>{
 const before=JSON.stringify(c.source),m=run(c),d=m.data as any;assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'CREATOR_LIFETIME_FULL_VECTOR_OBSERVED');assert.equal(d.profile,'EMPTY_HELD');assert.equal(d.coverage.canonicalReceipts,136);assert.equal(d.coverage.continuityPairs,135);assert.equal(d.coverage.initializations,7);assert.equal(d.coverage.closes,7);assert.equal(d.coverage.walletSuccessfulInspected,140);assert.equal(d.coverage.typedLegs,222);assert.equal(d.coverage.unresolvedEvents,0);assert.equal(d.ledger.length,222);assert.equal(new Set(d.ledger.map((f:any)=>f.rawLegId)).size,222);
 assert.deepEqual(d.flows,{acquiredAtomic:'339149663879364',purchaseAtomic:'337603576226656',crossAssetExchangeAtomic:'1515682959060',creatorFeeAtomic:'30403754759',holderDistributionAtomic:'938889',soldAtomic:'109149663879364',plainTransferOutAtomic:'230000000000000',incomingAtomic:'339149663879364',outgoingAtomic:'339149663879364',netAtomic:'0',transferInAtomic:'0',mintAtomic:'0',burnAtomic:'0'});
 assert.equal(d.realized.acquiredAtomic,'339149663879364');assert.equal(d.realized.disposedThroughSalesAtomic,'109149663879364');assert.equal(d.realized.transferredOutAtomic,'230000000000000');assert.equal(d.realized.fraction,'0.32183332464745913755');assert.equal(d.realized.denominatorStatus,'ALL_ACQUIRED_TARGET_ATOMIC');assert.deepEqual(d.realized.denominatorComponents,['PURCHASE','CROSS_ASSET_EXCHANGE','CREATOR_FEE','HOLDER_DISTRIBUTION']);
 assert.equal(d.fifo.openLots,0);assert.equal(d.fifo.closedAcquisitionLots,108);const exactAllocation=d.fifo.consumptions.find((r:any)=>r.entryCounterassetAllocation?.numeratorAtomicUnits==='1315519314614178952184628');assert.equal(exactAllocation.entryCounterassetAllocation.denominatorUnitsAtomic,'27600555139');assert.equal(exactAllocation.entryCounterassetAllocation.amountAtomic,'47662784606652');const used=d.fifo.consumptions.reduce((n:bigint,r:any)=>n+BigInt(r.unitsAtomic),0n);assert.equal(String(used),'339149663879364');assert.equal(String(d.fifo.consumptions.filter((r:any)=>r.disposition==='SALE').reduce((n:bigint,r:any)=>n+BigInt(r.unitsAtomic),0n)),'109149663879364');assert.equal(JSON.stringify(c.source),before);
}));

test('empty held SOL bands do not invent FX or fee/reward entry basis',()=>scenario(c=>{
 const m=run(c),d=m.data as any;assert.equal(m.quality,'KNOWN');assert.equal(d.holdings.heldAtomic,'0');assert.equal(d.holdings.openLots,0);assert.equal(d.holdings.unknownCostAtomic,'0');assert.equal(d.holdings.shareDenominator,'UNDEFINED_ZERO_HELD');for(const b of [...d.holdings.ageBands,...d.holdings.costBands]){assert.equal(b.atomic,'0');assert.equal(b.shareOfHeld,null);}assert.equal(d.holdings.ageBands.length,5);assert.equal(d.holdings.costBands.length,5);assert.equal(d.heldCostBandQuote.asset,'SOL');assert.equal(d.heldCostBandQuote.basis,'EMPTY_HELD_POPULATION_NO_FX_REQUIRED');
 const income=d.ledger.filter((f:any)=>f.kind==='CREATOR_FEE'||f.kind==='HOLDER_DISTRIBUTION');assert.equal(income.length,14);for(const f of income){assert.deepEqual(f.entryBasis,{kind:'UNKNOWN_INCOME_BASIS',counterasset:null});assert.equal(f.counterasset,null);}assert.ok(d.fifo.consumptions.some((r:any)=>r.entryBasis.kind==='UNKNOWN_INCOME_BASIS'&&r.entryCounterassetAllocation===null));
 const first=d.ledger.find((f:any)=>f.kind==='PURCHASE');assert.equal(first.counterasset.mint,'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');assert.equal(first.counterasset.decimals,8);assert.equal(first.counterasset.amountAtomic,'2608788');assert.equal(d.currentSells.sells,0);assert.equal(d.currentSells.unitsAtomic,'0');assert.equal(d.currentSells.coreQuoteAtomic,null);assert.equal(d.currentSells.userQuoteAtomic,null);
}));

test('a source-complete wallet subset cannot silently omit an older canonical lifetime body',()=>scenario(c=>{
 const sig='4SBrxgaze48Dv3pQQ2HeuPvHNL1T4J3kSwRbWVR3pnBac2cVgijxhpykmkFAxAv45ucL5Rq5rHLAjsq6cpLL6VXn';plain(c.source,'wallet-page-0',rows=>{const n=rows.findIndex((r:any)=>r.signature===sig);assert.ok(n>=0);rows.splice(n,1);});bulk(c.source,rows=>{const n=rows.findIndex(tx=>tx.transaction.signatures[0]===sig);assert.ok(n>=0);rows.splice(n,1);});const m=run(c),d=m.data as any;assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'O25_CANONICAL_LIFETIME_UNINSPECTED');assert.equal(d.ledger,null);assert.equal(d.holdings,null);assert.equal(d.realized,null);assert.equal(d.currentSells,null);
}));

test('an omitted balanced canonical index row cannot hide its retained acquisition and sale',()=>scenario(c=>{
 const sig='53Xz6cvA21HEyEQrMAWcgzZjNZKk8eDEMpVpEXxaTwXV13hfU6CvpUm5KSgp6J7XTXgyKdiNgJMXtcjR1ZfLzPYK';
 for(const contradiction of [false,true]){
  const source=structuredClone(c.source);plain(source,'ata-page-0',rows=>{const n=rows.findIndex((r:any)=>r.signature===sig);assert.ok(n>=0);if(contradiction)rows[n].err={InstructionError:[0,'Custom']};else rows.splice(n,1);});
  const m=deriveO25BulkLifetime(source,c.poolContext,c.cutoff,['inventory','bank']),d=m.data as any;
  assert.equal(m.quality,'MISSING');assert.ok(d.coverage.gaps.some((g:any)=>g.signature===sig&&g.code==='O25_CANONICAL_INDEX_MEMBERSHIP'));
  for(const key of ['ledger','flows','holdings','realized','fifo','currentSells'])assert.equal(d[key],null);
 }
}));

test('one failed interval reference rejects the full vector despite zero net inventory',()=>scenario(c=>{
 plain(c.source,'ata-page-0',rows=>rows.splice(11,0,{...rows[0],signature:c.fixture.preCreationTail.signature,slot:461500000,transactionIndex:0,blockTime:1792983600,err:{InstructionError:[0,'Custom']}}));const m=run(c);assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'O25_CURRENT_INTERVAL_REFERENCE');assert.equal((m.data as any).realized,null);
}));

test('a changed canonical amount or owner cannot leave a partial economic vector',()=>{
 scenario(c=>{bulk(c.source,rows=>{const tx=rows.find(tx=>tx.transaction.signatures[0]==='325KZ299MeuWk9dAkcxfN67E5WnAv7vRsQZhFRwYAW87ZZDVRCZVWSHtFxM65FegzEd1bN7q8nSjfidLYr8zCbDR');canonical(tx,c.fixture.account)[0].parsed.info.tokenAmount.amount='229999999999999';});const m=run(c);assert.equal(m.quality,'MISSING');for(const k of ['ledger','flows','holdings','realized','fifo','currentSells'])assert.equal((m.data as any)[k],null);});
 scenario(c=>{bulk(c.source,rows=>{const tx=rows.find(tx=>tx.transaction.signatures[0]==='325KZ299MeuWk9dAkcxfN67E5WnAv7vRsQZhFRwYAW87ZZDVRCZVWSHtFxM65FegzEd1bN7q8nSjfidLYr8zCbDR');const n=tx.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===c.fixture.account);tx.meta.preTokenBalances.find((b:any)=>b.accountIndex===n).owner=c.fixture.token.address;});const m=run(c);assert.equal(m.quality,'MISSING');assert.equal((m.data as any).holdings,null);});
});

test('positive current holdings, inconsistent catalogue and source clock forgery cannot certify an empty-held vector',()=>{
 scenario(c=>{plain(c.source,'owner-catalog',v=>v.value.push({pubkey:c.fixture.token.address,account:{owner:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',data:{program:'spl-token-2022',parsed:{type:'account',info:{mint:c.fixture.token.address,owner:c.fixture.wallet,state:'initialized',tokenAmount:{amount:'1'},extensions:[{extension:'immutableOwner'}]}}}}}));const m=run(c);assert.equal(m.quality,'MISSING');assert.equal((m.data as any).realized,null);});
 scenario(c=>{c.source.retrievedAt['bulk-page-0']='2099-01-01T00:00:00.000Z';assert.throws(()=>run(c));});
});
