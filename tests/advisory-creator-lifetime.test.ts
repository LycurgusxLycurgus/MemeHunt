import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { advisoryMetricSchema } from '../src/domain/advisory-contracts.js';
import type { CreatorInventoryReceipts, CreatorReuse, CreatorRole, CreatorTape } from '../src/providers/advisory-creator-inventory.js';
import { deriveO25CreatorLifetime } from '../src/providers/advisory-creator-lifetime.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';

const DIR='tests/fixtures/o25-creator',MINT='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',WALLET='8RXNzg9QEheV1SZyTLisckJRwziVoZFzGWA3tajj1yJg',PUMP='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CREATION='3Hiax4YZEW8FjgRL86RTJJt5xL5aBCFH1BTw8zfjjiWd5jc8bhWkj3gDS1VALXZKKBqaAHEdjat6VQZXLQSVc1uc',SELL='2Mej3XgaGARrsAtGjzqm9FxH2mAWQSH5QL9CzpKbcTaYiymCAdydGFSkeagwscsxU1vxz8Zm81oAGiLcRqdQXeH';
const token={chain:'solana' as const,address:MINT},role:CreatorRole={wallet:WALLET,mint:MINT,creationSignature:CREATION,creationSlot:451_486_744};
// Projection of the accepted A30 tape O24 consumes (.data/advisory-inventory-cycle/a30-tape.json): pool, anchor, range and O28-bound base vault; the creator signs none of its trades, so the creator-relevant trade subset is empty.
const tape:CreatorTape={history:{complete:true,pool:'4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',anchorSlot:455_909_330,range:{start:'2026-10-11T16:00:00.000Z',baselineEnd:'2026-10-11T22:00:00.000Z',end:'2026-10-12T04:00:00.000Z'},trades:[]},vault:'ALnzFihp12pxn12qZDgwRqEnTF8RGzpXyWWTP6yDQHEy'};
const CUTOFF='2026-10-12T05:02:00.000Z',INTERVAL={start:'2026-10-11T22:00:00.000Z',end:'2026-10-12T04:00:00.000Z'};
const named:Record<string,string>={'creator-ata-head':'creator-ata-head','creator-ata-index':'creator-ata-page-0','creator-owner-accounts':'creator-owner-accounts','creator-wallet-page-0':'creator-wallet-page-0'};
/** Exact retained public receipts under O24's namespace ids, copied byte-for-byte from .data/advisory-creator-cycle; no keys or tracker data. */
function actual():CreatorInventoryReceipts{
 const r:CreatorInventoryReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 for(const file of readdirSync(DIR).filter(f=>f.endsWith('-request.json'))){
  const name=file.slice(0,-'-request.json'.length),id=named[name]??(name.startsWith('wallet-tx-')?`creator-tx-${name.slice('wallet-tx-'.length)}`:null);
  if(!id)continue;
  const meta=JSON.parse(readFileSync(`${DIR}/${file}`,'utf8'));
  r.requests[id]=meta.request;r.retrievedAt[id]=meta.retrievedAt;r.rawArtifacts[id]=readFileSync(`${DIR}/${name}.json`,'utf8');
 }
 return r;
}
type Options={cutoff?:string;tape?:CreatorTape;role?:CreatorRole;reuse?:CreatorReuse};
const derive=(r:CreatorInventoryReceipts,o:Options={})=>deriveO25CreatorLifetime(token,o.role??role,o.tape??tape,r,o.reuse??new Map(),o.cutoff??CUTOFF,['ev-o25']);
const data=(m:{data:unknown})=>m.data as any;
const edit=(r:CreatorInventoryReceipts,id:string,f:(result:any)=>void)=>{const v=JSON.parse(r.rawArtifacts[id]!);f(v.result);r.rawArtifacts[id]=JSON.stringify(v);};
const unresolvedAs=(r:CreatorInventoryReceipts,quality:string,code:string,o:Options={})=>{const m=derive(r,o),d=data(m);assert.deepEqual([m.quality,m.reasonCode],[quality,code]);assert.deepEqual([d.holdings,d.realized,d.currentSells],[null,null,null]);return d;};

test('O24-verified lifetime receipts give a complete CREATOR_ONLY cost/age/realized/current-sell vector', ()=>{
 const m=derive(actual()),d=data(m);
 assert.equal(m.quality,'KNOWN',m.reasonCode);assert.equal(m.reasonCode,'CREATOR_LIFETIME_VECTOR_OBSERVED');advisoryMetricSchema.parse(m);
 assert.deepEqual([d.inventoryBasis.reasonCode,d.inventoryBasis.pendingPremises,d.inventoryBasis.reusedReceipts],['CREATOR_SIGNER_INVENTORY_OBSERVED',0,[]]);
 assert.deepEqual([d.coverage.headSlot,d.coverage.catalogSlot],[455_913_999,455_914_007]);
 assert.deepEqual([d.coverage.ataIndex.rows,d.coverage.ataIndex.successful,d.coverage.ataIndex.exhausted],[240,2,true]);
 assert.deepEqual([d.coverage.walletIndex.rowsSinceCreation,d.coverage.walletIndex.successfulInspected],[197,67]);
 assert.deepEqual(d.coverage.canonicalReceipts,[CREATION,SELL]);
 const pick=(e:any)=>[e.signature,e.side,e.instruction,e.ixName,e.unitsAtomic,e.coreQuoteLamports,e.protocolFeeLamports,e.buybackFeeLamports,e.creatorFeeLamports,e.creatorFeeToOwnVault,e.feeModel,e.userQuoteLamports,e.networkFeeLamports,e.accountDepositsLamports,e.canonicalPreAtomic,e.canonicalPostAtomic,e.eventTailFields];
 // Values observed by root's replay of these exact receipts (o25-actual-result.json); the lamport identities below are read independently from the receipts.
 assert.deepEqual(d.ledger.map(pick),[
  [CREATION,'BUY','buy_v2','buy','56869836267266','1679012344','7975309','7975309','5037038',true,'INCLUDED','1700000000','32757','9062720','0','56869836267266',18],
  [SELL,'SELL','sell','sell','56869836267266','3088325878','14669548','14669548','9264978',true,'INCLUDED','3049721804','805000','0','56869836267266','0',18]]);
 const [buy,sell]=d.ledger;
 assert.equal(BigInt(buy.userQuoteLamports)+BigInt(buy.accountDepositsLamports)+BigInt(buy.networkFeeLamports),1_709_095_477n);
 assert.equal(BigInt(sell.userQuoteLamports)-BigInt(sell.networkFeeLamports),3_048_916_804n);
 assert.equal(d.flows.transferInAtomic+d.flows.transferOutAtomic+d.flows.mintAtomic+d.flows.burnAtomic,'0000');
 assert.deepEqual([d.realized.acquiredAtomic,d.realized.disposedThroughSalesAtomic,d.realized.fraction],['56869836267266','56869836267266','1']);
 assert.deepEqual(d.realized.disposedLots.map((l:any)=>[l.acquiredSignature,l.disposedSignature,l.unitsAtomic,l.holdingSeconds,l.entryCostLamports]),[[CREATION,SELL,'56869836267266',10,'1700000000']]);
 assert.equal(d.holdings.heldAtomic,'0');assert.equal(d.holdings.shareDenominator,'UNDEFINED_ZERO_HELD');
 assert.ok([...d.holdings.ageBands,...d.holdings.costBands].every((b:any)=>b.atomic==='0'&&b.shareOfHeld===null));
 assert.deepEqual(d.currentSells,{interval:INTERVAL,sells:0,unitsAtomic:'0',coreQuoteLamports:'0',userQuoteLamports:'0'});
 assert.equal(d.quote.usdBasis,null);assert.equal(d.quote.trackerValuesUsed,false);assert.equal(d.cohort.identity,null);
});

test('a creation receipt reused from S13 keeps its body and clock, and a duplicate own copy is rejected by O24 membership', ()=>{
 const r=actual(),id=`creator-tx-${CREATION}`,source='advisory-creatorRole-creator-role-transaction';
 const reuse:CreatorReuse=new Map([[CREATION,{id:source,request:r.requests[id]!,raw:r.rawArtifacts[id]!,retrievedAt:r.retrievedAt[id]!}]]);
 assert.throws(()=>derive(r,{reuse}),/CREATOR_INVENTORY_RECEIPT_MEMBERSHIP/);
 delete r.requests[id];delete r.rawArtifacts[id];delete r.retrievedAt[id];
 const m=derive(r,{reuse}),d=data(m);
 assert.equal(m.quality,'KNOWN',m.reasonCode);
 assert.deepEqual([d.coverage.reusedReceipts,d.inventoryBasis.reusedReceipts],[[source],[source]]);
 assert.equal(d.ledger[0].coreQuoteLamports,'1679012344');
});

test('quote legs and trade instruction semantics fail closed on real receipts that O24 alone still accepts', ()=>{
 const lamports=actual();edit(lamports,`creator-tx-${SELL}`,v=>{v.meta.postBalances[0]+=1;});
 assert.equal(unresolvedAs(lamports,'MISSING','O25_QUOTE_RECONCILIATION').inventoryBasis.reasonCode,'CREATOR_SIGNER_INVENTORY_OBSERVED');
 const instruction=actual();edit(instruction,`creator-tx-${SELL}`,v=>{v.transaction.message.instructions.find((i:any)=>i.programId===PUMP).data='11111111';});
 assert.equal(unresolvedAs(instruction,'MISSING','O25_TRADE_INSTRUCTION').inventoryBasis.reasonCode,'CREATOR_SIGNER_INVENTORY_OBSERVED');
});

const ATA='Km6Zx9bT9MgWTTdaRZaXQhLEnUaPaBbTpB3B6aoJE2v';
const b58=(s:string)=>{let n=0n;for(const c of s)n=n*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));const hex=n.toString(16);return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex')]);};
// The actual creator Pump trade instructions: the SELL's single top-level Pump call and the launch buy_v2 at top-level index 4 (after the compute budget, create_v2 and ATA calls).
const pumpIx=(v:any,sig:string)=>sig===SELL?v.transaction.message.instructions.find((i:any)=>i.programId===PUMP):v.transaction.message.instructions[4];
const mutate=(sig:string,f:(ix:any)=>void)=>{const r=actual();edit(r,`creator-tx-${sig}`,v=>f(pumpIx(v,sig)));return r;};
const reData=(sig:string,f:(b:Buffer)=>Buffer)=>mutate(sig,ix=>{ix.data=encodeSolanaAddress(f(b58(ix.data)));});
const u64=(at:number,value:bigint|((v:bigint)=>bigint))=>(b:Buffer)=>{const c=Buffer.from(b);c.writeBigUInt64LE(typeof value==='function'?value(c.readBigUInt64LE(at)):value,at);return c;};
const disc=(d:number[])=>(b:Buffer)=>Buffer.concat([Buffer.from(d),b.subarray(8)]);
const swap=(i:number,j:number)=>(ix:any)=>{[ix.accounts[i],ix.accounts[j]]=[ix.accounts[j],ix.accounts[i]];};

test('the actual launch buy_v2 and SELL bind their pinned IDL encodings, ordered roles and exact-token amount semantics', ()=>{
 const raw=(sig:string)=>pumpIx(JSON.parse(actual().rawArtifacts[`creator-tx-${sig}`]!).result,sig);
 assert.deepEqual([raw(CREATION).programId,raw(CREATION).accounts.length,b58(raw(CREATION).data).length,raw(SELL).accounts.length,b58(raw(SELL).data).length],[PUMP,27,24,16,24]);
 const m=derive(actual()),[buy,sell]=data(m).ledger,args=(sig:string)=>{const b=b58(raw(sig).data);return [b.readBigUInt64LE(8),b.readBigUInt64LE(16)] as [bigint,bigint];};
 assert.equal(m.quality,'KNOWN',m.reasonCode);
 assert.deepEqual([buy.instruction,sell.instruction],['buy_v2','sell']);
 // Both actual instructions are 24 bytes (the buy_v2 omits its trailing partial_fill OptionBool): each amount is the executed token amount and each quote limit holds against the reconciled post-fee user quote.
 const [buyAmount,maxSolCost]=args(CREATION),[sellAmount,minSolOutput]=args(SELL);
 assert.deepEqual([buyAmount,sellAmount],[56_869_836_267_266n,56_869_836_267_266n]);
 assert.ok(maxSolCost>=1_700_000_000n&&minSolOutput<=3_049_721_804n);
 assert.deepEqual([buy.userQuoteLamports,buy.feeModel,sell.userQuoteLamports,sell.feeModel,sell.creatorFeeToOwnVault],['1700000000','INCLUDED','3049721804','INCLUDED',true]);
 // The current 25-byte buy_v2 encoding with an explicit partial_fill byte is the same supported instruction and the same priced trade.
 for(const flag of [0,1]){const v=derive(reData(CREATION,b=>Buffer.concat([b,Buffer.from([flag])])));assert.equal(v.quality,'KNOWN',v.reasonCode);assert.deepEqual([data(v).ledger[0].instruction,data(v).ledger[0].userQuoteLamports],['buy_v2','1700000000']);}
});

test('impossible pinned-ABI encodings, ordered roles or amounts leave the whole vector unresolved', ()=>{
 const rejected=(r:CreatorInventoryReceipts,code:string,o24Observed=true)=>{const d=unresolvedAs(r,'MISSING',code);if(o24Observed)assert.equal(d.inventoryBasis.reasonCode,'CREATOR_SIGNER_INVENTORY_OBSERVED');};
 // The three reviewer mutations of the actual historical SELL, each accepted by O24.
 rejected(mutate(SELL,ix=>{ix.accounts.reverse();}),'O25_TRADE_ROLE');
 rejected(mutate(SELL,ix=>{ix.accounts.splice(ix.accounts.indexOf(ATA),1);}),'O25_TRADE_ROLE');
 rejected(reData(SELL,b=>b.subarray(0,8)),'O25_TRADE_ARGS');
 // Arguments: an extra byte on the OptionBool-free sell, a non-Borsh bool or a second optional byte on buy_v2.
 rejected(reData(SELL,b=>Buffer.concat([b,Buffer.from([0])])),'O25_TRADE_ARGS');
 rejected(reData(CREATION,b=>Buffer.concat([b,Buffer.from([2])])),'O25_TRADE_ARGS',false);
 rejected(reData(CREATION,b=>Buffer.concat([b,Buffer.from([0,0])])),'O25_TRADE_ARGS',false);
 // Amount and slippage beyond the executed trade: amount at byte 8, quote limit at byte 16.
 rejected(reData(SELL,u64(8,v=>v-1n)),'O25_TRADE_AMOUNT');
 rejected(reData(SELL,u64(16,3_088_325_879n)),'O25_TRADE_AMOUNT');
 rejected(reData(CREATION,u64(16,1_679_012_343n)),'O25_TRADE_AMOUNT',false);
 // Limits between the core and the post-fee quote: the core gate alone would pass them; the official fee-inclusive buy and after-fee sell semantics reject them.
 rejected(reData(CREATION,u64(16,1_690_000_000n)),'O25_TRADE_AMOUNT',false);
 rejected(reData(SELL,u64(16,3_070_000_000n)),'O25_TRADE_AMOUNT');
 // Roles by position: creator, mint, token program, creator vault and event authority each moved off their IDL slot.
 rejected(mutate(SELL,swap(5,6)),'O25_TRADE_ROLE');
 rejected(mutate(SELL,swap(2,3)),'O25_TRADE_ROLE');
 rejected(mutate(SELL,swap(7,9)),'O25_TRADE_ROLE');
 rejected(mutate(SELL,swap(8,15)),'O25_TRADE_ROLE');
 rejected(mutate(SELL,swap(10,12)),'O25_TRADE_ROLE');
 rejected(mutate(CREATION,swap(13,14)),'O25_TRADE_ROLE',false);
 // Discriminators: the unsupported exact-quote buy, and supported variants whose layout the accounts do not satisfy.
 rejected(reData(CREATION,disc([194,171,28,70,104,77,91,47])),'O25_TRADE_VARIANT_UNSUPPORTED',false);
 rejected(reData(SELL,disc([93,246,130,60,231,233,64,178])),'O25_TRADE_ROLE');
 rejected(reData(CREATION,disc([102,6,61,18,1,218,235,234])),'O25_TRADE_ROLE',false);
 // Remaining accounts come only after every fixed role, and the buyback leg must land on one of them.
 rejected(mutate(SELL,ix=>{ix.accounts.splice(14);}),'O25_QUOTE_RECONCILIATION');
});

test('a canonical receipt outside the O24-inspected set leaves the lifetime truncated without any new read', ()=>{
 const gap=actual(),fake=encodeSolanaAddress(Buffer.alloc(64,9));
 edit(gap,'creator-ata-page-0',rows=>{const at=rows.findIndex((x:any)=>x.signature===CREATION);rows.splice(at,0,{...rows[at],signature:fake});});
 assert.equal(unresolvedAs(gap,'TRUNCATED','O25_CANONICAL_RECEIPT_UNINSPECTED').inventoryBasis.reasonCode,'CREATOR_SIGNER_INVENTORY_OBSERVED');
});

test('O25 inherits the O24 prerequisite and never reports a vector without the whole-wallet proof', ()=>{
 const noWallet=actual();delete noWallet.requests['creator-wallet-page-0'];delete noWallet.rawArtifacts['creator-wallet-page-0'];delete noWallet.retrievedAt['creator-wallet-page-0'];
 assert.equal(unresolvedAs(noWallet,'TRUNCATED','O25_INVENTORY_PREREQUISITE_UNRESOLVED').inventoryBasis.reasonCode,'CREATOR_NON_CANONICAL_ACCOUNTS_UNPROVEN');
 assert.equal(unresolvedAs(actual(),'MISSING','O25_INVENTORY_PREREQUISITE_UNRESOLVED',{tape:{...tape,history:{...tape.history,complete:false}}}).inventoryBasis.reasonCode,'CREATOR_TAPE_INCOMPLETE');
 const early=derive(actual(),{cutoff:'2026-10-12T05:00:00.000Z'});
 assert.notEqual(early.quality,'KNOWN');assert.equal(early.reasonCode,'O25_INVENTORY_PREREQUISITE_UNRESOLVED');
 const head=actual();edit(head,'creator-owner-accounts',v=>{v.value[0].account.data.parsed.info.tokenAmount.amount='5';});
 const mismatch=derive(head);assert.notEqual(mismatch.quality,'KNOWN');assert.equal(mismatch.reasonCode,'O25_INVENTORY_PREREQUISITE_UNRESOLVED');
});

test('O24 scope guards still throw before any O25 projection', ()=>{
 assert.throws(()=>derive(actual(),{role:{...role,wallet:'11111111111111111111111111111111'}}),/CREATOR_INVENTORY_SCOPE/);
});
