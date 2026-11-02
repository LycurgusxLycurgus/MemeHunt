import test from 'node:test';
import assert from 'node:assert/strict';
import {composeS15ReferenceBook,type S15ReferenceBookInput,type NativeLeg,type NativeJoin,type ReferencePoint,type TargetBar,type S15ReferenceBook} from '../src/providers/advisory-creator-reference-book.js';
const WSOL='So11111111111111111111111111111111111111112',WBTC='3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',TARGET='C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump',HASH='a'.repeat(64),PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const at=(unix:number)=>new Date(unix*1000).toISOString();
const q=(n:string,d='1')=>({numerator:n,denominator:d});
function point(mint=WSOL,referenceUnix=900,priceLexeme='2'):ReferencePoint{return{mint,referenceUnix,priceLexeme,recordId:'native-reference',sourceHash:HASH,sourceIndex:0,availableAt:at(2000)};}
function bar(priceLexeme='1.25'):TargetBar{return{...point(TARGET,960,priceLexeme),recordId:'target-reference',pool:'pool',startUnix:900,endUnix:960};}
function leg(id:string,kind:NativeLeg['kind'],amountAtomic:string,event:number,slot:number,counterasset:NativeLeg['counterasset']=null):NativeLeg{return{signature:id,slot,at:at(event),programTimestamp:null,order:slot,top:0,rawLegId:id,direction:['SALE','PLAIN_TRANSFER'].includes(kind)?'OUT':'IN',kind,amountAtomic,counterasset,sourceSemantics:'CONSTRUCTED_NATIVE_VALIDATED_LEG'};}
function join(acquiredRawLegId:string,disposedRawLegId:string,unitsAtomic:string,holdingSeconds:number,disposition:NativeJoin['disposition']='PLAIN_TRANSFER'):NativeJoin{return{acquiredRawLegId,disposedRawLegId,unitsAtomic,holdingSeconds,disposition};}
function fixture():S15ReferenceBookInput{return{position:{token:{chain:'solana',address:TARGET},actor:'actor',canonicalAccount:'canonical',creationSignature:'purchase',creationSlot:1,headSlot:9,targetDecimals:0,heldAtomic:'0',targetPool:'pool',ledger:[leg('purchase','PURCHASE','3',1000,1,{mint:WSOL,program:PROGRAM,decimals:9,amountAtomic:'500000000'}),leg('credit','CREATOR_FEE','1',1010,2),leg('foreign','CROSS_ASSET_EXCHANGE','2',1020,3,{mint:'foreign-mint',program:PROGRAM,decimals:0,amountAtomic:'20'}),leg('sale','SALE','1',1030,4,{mint:WSOL,program:PROGRAM,decimals:9,amountAtomic:'1000000000'}),leg('transfer','PLAIN_TRANSFER','5',1040,5)],fifo:[join('purchase','sale','1',30,'SALE'),join('purchase','transfer','2',40),join('credit','transfer','1',30),join('foreign','transfer','2',20)]},prices:{native:[point()],target:[bar()]},cutoff:at(3000)};}
function complete(input:S15ReferenceBookInput):S15ReferenceBook{const result=composeS15ReferenceBook(input);if(result.status!=='COMPLETE')assert.fail(JSON.stringify(result));return result.book;}
function missing(input:S15ReferenceBookInput,code:RegExp){const result=composeS15ReferenceBook(input);assert.equal(result.status,'MISSING',JSON.stringify(result));if(result.status==='MISSING')assert.match(result.reasonCode,code);}

test('exact mixed consideration, credit and fractional FIFO basis conserve across sale and custody transfer',()=>{
 const input=fixture(),before=JSON.stringify(input),b=complete(input);assert.equal(JSON.stringify(input),before);
 assert.deepEqual(b.acquisitions.map(a=>a.basisUsd),[q('1'),q('0'),q('5','2')]);
 assert.equal(b.acquisitions[1]!.basisConvention,'ZERO_TOKEN_PURCHASE_CONSIDERATION_FOR_NATIVE_PROTOCOL_CREDITS');assert.equal(b.acquisitions[1]!.kind,'CREATOR_FEE');assert.equal(b.policy.incomeRecognition,'NOT_ASSERTED');
 assert.equal(b.referenceValues.length,3);assert.equal(b.referenceValues.find(r=>r.rawLegId==='foreign')!.convention,'RECEIVED_TARGET_REFERENCE_VALUE');assert.equal(b.referenceValues.find(r=>r.rawLegId==='foreign')!.counterasset!.amountAtomic,'20');
 assert.deepEqual(b.fifo.map(f=>f.allocatedBasisUsd),[q('1','3'),q('2','3'),q('0'),q('5','2')]);
 assert.deepEqual(b.sales[0]!.proceedsUsd,q('2'));assert.deepEqual(b.sales[0]!.allocatedBasisUsd,q('1','3'));assert.deepEqual(b.sales[0]!.realizedPrincipalReferenceResultUsd,q('5','3'));
 assert.deepEqual(b.transfers[0]!.carriedBasisUsd,q('19','6'));assert.equal(b.transfers[0]!.proceeds,null);assert.equal(b.transfers[0]!.realizedPrincipalReferenceResultUsd,null);
 assert.deepEqual(b.totals.acquisitionBasisUsd,q('7','2'));assert.deepEqual(b.totals.soldAllocatedBasisUsd,q('1','3'));assert.deepEqual(b.totals.carriedTransferBasisUsd,q('19','6'));assert.deepEqual(b.totals.openBasisUsd,q('0'));assert.equal(b.totals.acquiredUnitsAtomic,'6');assert.equal(b.totals.soldUnitsAtomic,'1');assert.equal(b.totals.transferredUnitsAtomic,'5');assert.deepEqual(b.unrealized.bookValueUsd,q('0'));assert.equal(b.aggregateNetProfit,null);
});
test('native identity and decimal exponents remain exact, independently of foreign units surrendered',()=>{
 const input=fixture();input.position.ledger[0]!.counterasset={mint:WBTC,program:PROGRAM,decimals:8,amountAtomic:'1'};input.prices.native.push(point(WBTC,900,'3.25e4'));input.prices.target=[bar('1.000000000000000000000000000001')];input.position.ledger[2]!.counterasset!.amountAtomic='999999';const b=complete(input);
 assert.deepEqual(b.acquisitions[0]!.basisUsd,q('13','40000'));assert.deepEqual(b.acquisitions[2]!.basisUsd,q('1000000000000000000000000000001','500000000000000000000000000000'));assert.equal(b.referenceValues[0]!.reference.priceLexeme,'3.25e4');assert.equal(b.referenceValues[0]!.reference.mint,WBTC);
});
test('provided native event order and exact unit joins are consumed unchanged, not resorted by instruction or raw id',()=>{
 const input=fixture();input.position.ledger[1]!.slot=1;input.position.ledger[1]!.order=0;input.position.ledger[1]!.signature='aaa-before-lexically';const b=complete(input);assert.deepEqual(b.acquisitions.map(a=>a.rawLegId),['purchase','credit','foreign']);assert.deepEqual(b.fifo.map(a=>a.unitsAtomic),['1','2','1','2']);
 const absent=fixture();absent.position.fifo.pop();missing(absent,/FIFO_COVERAGE/);
 const excessive=fixture();excessive.position.fifo[0]!.unitsAtomic='4';missing(excessive,/FIFO_UNITS/);
 const rounded=fixture();rounded.position.fifo[0]!.unitsAtomic='0.333333';missing(rounded,/ATOMIC/);
 const duplicate=fixture();duplicate.position.fifo.push({...duplicate.position.fifo[0]!});missing(duplicate,/FIFO_JOIN/);
 const wrongKind=fixture();wrongKind.position.fifo[0]!.disposition='PLAIN_TRANSFER';missing(wrongKind,/FIFO_KIND_OR_CLOCK/);
});
test('latest positive pre-event references reject conflicts and never fill missing, future or stale intervals',()=>{
 const noMark=fixture();noMark.prices.native=[];missing(noMark,/MISSING_REFERENCE_MARK/);
 const future=fixture();future.prices.native=[point(WSOL,1100,'2')];missing(future,/MISSING_REFERENCE_MARK/);
 const uncompleted=fixture();uncompleted.prices.target=[{...bar(),startUnix:1020,endUnix:1080,referenceUnix:1080}];missing(uncompleted,/MISSING_REFERENCE_MARK/);
 const conflict=fixture();conflict.prices.native.push({...point(),recordId:'other-source',priceLexeme:'3'});missing(conflict,/CONFLICTING_REFERENCE/);
 const same=fixture();same.prices.native.push({...point(),recordId:'other-source',priceLexeme:'2.000'});assert.equal(complete(same).referenceValues[0]!.reference.recordId,'native-reference');
 const positive=fixture();positive.prices.native.push(point(WSOL,950,'0'));assert.equal(complete(positive).referenceValues[0]!.reference.referenceUnix,900);
 const targetMissing=fixture();targetMissing.prices.target=[];missing(targetMissing,/MISSING_REFERENCE_MARK/);
});
test('native3600second and completed target900second age limits are inclusive with original source clocks',()=>{
 const native=fixture();native.position.ledger=native.position.ledger.filter(l=>l.rawLegId==='purchase'||l.rawLegId==='sale');native.position.ledger[1]!.amountAtomic='3';native.position.fifo=[join('purchase','sale','3',0,'SALE')];for(const l of native.position.ledger)l.at=at(4000);native.cutoff=at(7000);native.prices.native=[{...point(WSOL,400,'2'),availableAt:at(6000)}];native.prices.target=[];assert.equal(complete(native).referenceValues[0]!.reference.ageSeconds,3600);
 for(const l of native.position.ledger)l.at=at(4001);missing(native,/STALE_REFERENCE_MARK/);
 const target=fixture();target.position.ledger[2]!.at=at(1860);target.position.ledger[3]!.at=at(1870);target.position.ledger[4]!.at=at(1880);target.position.fifo=[join('purchase','sale','1',870,'SALE'),join('purchase','transfer','2',880),join('credit','transfer','1',870),join('foreign','transfer','2',20)];assert.equal(complete(target).referenceValues.find(r=>r.rawLegId==='foreign')!.reference.ageSeconds,900);
 target.position.ledger[2]!.at=at(1861);target.position.fifo[3]!.holdingSeconds=19;missing(target,/STALE_REFERENCE_MARK/);
 const laterSource=fixture();laterSource.prices.native[0]!.availableAt=at(3001);missing(laterSource,/REFERENCE_SOURCE_CLOCK/);
 const beforeReference=fixture();beforeReference.prices.native[0]!.availableAt=at(800);missing(beforeReference,/REFERENCE_SOURCE_CLOCK/);
});
test('malformed prices, unsupported held inventory and ambiguous non-credit inflows do not inherit zero basis',()=>{
 for(const value of ['1e1001','01','NaN','1.2.3']){const input=fixture();input.prices.native[0]!.priceLexeme=value;missing(input,/PRICE_LEXEME|PRICE_EXPONENT/);}
 const holder=fixture();holder.position.ledger[1]!.kind='HOLDER_DISTRIBUTION';assert.deepEqual(complete(holder).acquisitions[1]!.basisUsd,q('0'));
 const unknown=fixture();unknown.position.ledger[1]!.kind='PURCHASE';missing(unknown,/COUNTERASSET/);
 const held=fixture();(held.position as {heldAtomic:string}).heldAtomic='1';missing(held,/POSITION/);
 const wrongPool=fixture();wrongPool.prices.target[0]!.pool='foreign-pool';missing(wrongPool,/TARGET_BAR_IDENTITY/);
 const wrongMint=fixture();wrongMint.prices.target[0]!.mint=WSOL;missing(wrongMint,/TARGET_BAR_IDENTITY/);
});
