import type {TokenRef} from '../domain/contracts.js';
import type {O25LifetimeFlow} from './advisory-creator-lifetime-flows.js';

export type NativeLeg=Omit<O25LifetimeFlow,'amountAtomic'|'counterasset'>&{amountAtomic:string;counterasset:{mint:string;program:string;decimals:number;amountAtomic:string}|null};
export type NativeJoin={acquiredRawLegId:string;disposedRawLegId:string;disposition:'SALE'|'PLAIN_TRANSFER';unitsAtomic:string;holdingSeconds:number};
export type ReferencePoint={mint:string;referenceUnix:number;priceLexeme:string;recordId:string;sourceHash:string;sourceIndex:number;availableAt:string};
export type TargetBar=ReferencePoint&{pool:string;startUnix:number;endUnix:number};
export type S15ReferenceBookInput={position:{token:TokenRef;actor:string;canonicalAccount:string;creationSignature:string;creationSlot:number;headSlot:number;targetDecimals:number;heldAtomic:'0';targetPool:string;ledger:NativeLeg[];fifo:NativeJoin[]};prices:{native:ReferencePoint[];target:TargetBar[]};cutoff:string};
export type ExactRational={numerator:string;denominator:string};
const CREDIT_BASIS='ZERO_TOKEN_PURCHASE_CONSIDERATION_FOR_NATIVE_PROTOCOL_CREDITS' as const;
const NATIVE=new Set(['So11111111111111111111111111111111111111112','3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh']);
type Rat={n:bigint;d:bigint};
const ZERO:Rat={n:0n,d:1n};
const fail=(reason:string):never=>{throw Error('S15_REFERENCE_BOOK_'+reason);};
function check(value:unknown,reason:string):asserts value{if(!value)fail(reason);}
function gcd(a:bigint,b:bigint){let x=a<0n?-a:a,y=b<0n?-b:b;while(y){const r=x%y;x=y;y=r;}return x;}
function rat(n:bigint,d:bigint):Rat{check(d!==0n,'ZERO_DENOMINATOR');if(n===0n)return ZERO;if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return{n:n/g,d:d/g};}
const add=(a:Rat,b:Rat)=>rat(a.n*b.d+b.n*a.d,a.d*b.d),sub=(a:Rat,b:Rat)=>rat(a.n*b.d-b.n*a.d,a.d*b.d),mul=(a:Rat,b:Rat)=>rat(a.n*b.n,a.d*b.d);
const equal=(a:Rat,b:Rat)=>a.n*b.d===b.n*a.d;
const exact=(r:Rat):ExactRational=>({numerator:r.n.toString(),denominator:r.d.toString()});
const sum=(values:Rat[])=>values.reduce(add,ZERO);
function atomic(value:string){check(typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value),'ATOMIC');const n=BigInt(value);check(n<=2n**64n-1n,'ATOMIC');return n;}
function decimal(text:string):Rat{
 check(typeof text==='string'&&text.length<=256,'PRICE_LEXEME');const m=/^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);check(m,'PRICE_LEXEME');
 const exponentText=m[4]??'0';check(exponentText.replace(/^[+-]/,'').length<=4,'PRICE_EXPONENT');const exponent=Number(exponentText);check(Number.isSafeInteger(exponent)&&Math.abs(exponent)<=1000,'PRICE_EXPONENT');
 const fraction=m[3]??'',shift=exponent-fraction.length,n=BigInt(m[2]!+fraction)*(m[1]==='-'?-1n:1n);return shift>=0?rat(n*10n**BigInt(shift),1n):rat(n,10n**BigInt(-shift));
}
function unix(at:string){const ms=Date.parse(at);check(Number.isSafeInteger(ms)&&ms>=0&&ms%1000===0,'EVENT_CLOCK');return ms/1000;}
function scale(amount:bigint,decimals:number){check(Number.isSafeInteger(decimals)&&decimals>=0&&decimals<=255,'DECIMALS');return rat(amount,10n**BigInt(decimals));}
type Candidate={point:ReferencePoint|TargetBar;value:Rat};
function series(points:(ReferencePoint|TargetBar)[],cutoff:number,target?:{mint:string;pool:string}):Candidate[]{
 const seen=new Map<string,Candidate>(),out:Candidate[]=[];
 for(const point of points){
  check(point&&typeof point.recordId==='string'&&point.recordId.length>0&&/^[a-f0-9]{64}$/.test(point.sourceHash)&&Number.isSafeInteger(point.sourceIndex)&&point.sourceIndex>=0&&Number.isSafeInteger(point.referenceUnix)&&point.referenceUnix>=0,'REFERENCE_SOURCE');
  const available=Date.parse(point.availableAt);check(Number.isFinite(available)&&available<=cutoff&&point.referenceUnix*1000<=available,'REFERENCE_SOURCE_CLOCK');
  if(target){check('pool'in point&&point.pool===target.pool&&point.mint===target.mint&&Number.isSafeInteger(point.startUnix)&&Number.isSafeInteger(point.endUnix)&&point.startUnix>=0&&point.endUnix-point.startUnix===60&&point.referenceUnix===point.endUnix,'TARGET_BAR_IDENTITY');}
  else check(NATIVE.has(point.mint),'NATIVE_REFERENCE_IDENTITY');
  const value=decimal(point.priceLexeme),key=`${point.mint}:${target?target.pool+':':''}${point.referenceUnix}`,previous=seen.get(key);
  if(previous)check(equal(value,previous.value)&&(!target||('startUnix'in point&&'startUnix'in previous.point&&point.startUnix===previous.point.startUnix)),'CONFLICTING_REFERENCE');
  else seen.set(key,{point,value});
  if(value.n>0n)out.push({point,value});
 }
 return out;
}
function select(points:Candidate[],mint:string,event:number,maxAge:number){
 const eligible=points.filter(c=>c.point.mint===mint&&c.point.referenceUnix<=event);check(eligible.length>0,'MISSING_REFERENCE_MARK');
 const latest=Math.max(...eligible.map(c=>c.point.referenceUnix));check(event-latest<=maxAge,'STALE_REFERENCE_MARK');
 const selected=eligible.filter(c=>c.point.referenceUnix===latest).sort((a,b)=>a.point.recordId.localeCompare(b.point.recordId)||a.point.sourceIndex-b.point.sourceIndex)[0]!;
 return{value:selected.value,reference:{...selected.point,priceUsd:exact(selected.value),eventUnix:event,ageSeconds:event-latest,maxAgeSeconds:maxAge}};
}

/** Pure money arithmetic over already reconstructed native quantities and FIFO joins.
 * This does not admit source authority, classify fees or reorder native events. */
function compose(input:S15ReferenceBookInput){
 const p=input.position,cutoff=Date.parse(input.cutoff);check(Number.isFinite(cutoff)&&p.token.chain==='solana'&&p.heldAtomic==='0'&&p.ledger.length>0,'POSITION');scale(0n,p.targetDecimals);
 check(Number.isSafeInteger(p.creationSlot)&&Number.isSafeInteger(p.headSlot)&&p.creationSlot>=0&&p.headSlot>=p.creationSlot,'POSITION_CLOCK');
 const native=series(input.prices.native,cutoff),target=series(input.prices.target,cutoff,{mint:p.token.address,pool:p.targetPool});
 const byId=new Map<string,{leg:NativeLeg;index:number;units:bigint;event:number}>(),basis=new Map<string,Rat>(),proceeds=new Map<string,Rat>(),conventions=new Map<string,string>();
 const referenceValues:Array<{rawLegId:string;signature:string;at:string;kind:NativeLeg['kind'];convention:string;amountAtomic:string;counterasset:NativeLeg['counterasset'];reference:ReturnType<typeof select>['reference'];valueUsd:ExactRational}>=[];
 const acquisitions:Array<{rawLegId:string;signature:string;at:string;kind:NativeLeg['kind'];sourceSemantics:string;amountAtomic:string;counterasset:NativeLeg['counterasset'];basisConvention:string;basisUsd:ExactRational}>=[];
 let incoming=0n,sold=0n,transferred=0n,previousSlot=p.creationSlot,previousEvent=0;
 for(const [index,leg]of p.ledger.entries()){
  const units=atomic(leg.amountAtomic),event=unix(leg.at);check(units>0n&&typeof leg.rawLegId==='string'&&!byId.has(leg.rawLegId),'LEG_ID_OR_UNITS');
  check(Number.isSafeInteger(leg.slot)&&leg.slot>=previousSlot&&leg.slot<=p.headSlot&&event>=previousEvent&&event*1000<=cutoff,'NATIVE_ORDER');previousSlot=leg.slot;previousEvent=event;
  check((leg.direction==='IN'&&['PURCHASE','CROSS_ASSET_EXCHANGE','CREATOR_FEE','HOLDER_DISTRIBUTION'].includes(leg.kind))||(leg.direction==='OUT'&&['SALE','PLAIN_TRANSFER'].includes(leg.kind)),'LEG_KIND_DIRECTION');
  byId.set(leg.rawLegId,{leg,index,units,event});
  let value=ZERO,convention:string=CREDIT_BASIS;
  if(leg.kind==='CREATOR_FEE'||leg.kind==='HOLDER_DISTRIBUTION'){check(leg.counterasset===null&&typeof leg.sourceSemantics==='string'&&leg.sourceSemantics.length>0,'CREDIT_SOURCE_KIND');}
  else if(leg.kind==='PLAIN_TRANSFER'){check(leg.counterasset===null,'TRANSFER_CONSIDERATION');}
  else{
   const counter=leg.counterasset;check(counter&&counter.mint!==p.token.address,'COUNTERASSET');const counterUnits=atomic(counter.amountAtomic);check(counterUnits>0n,'COUNTERASSET');scale(0n,counter.decimals);
   if(NATIVE.has(counter.mint)){
    const mark=select(native,counter.mint,event,3600);value=mul(scale(counterUnits,counter.decimals),mark.value);convention=leg.kind==='SALE'?'NATIVE_COUNTERASSET_REFERENCE_PROCEEDS':'NATIVE_COUNTERASSET_REFERENCE_CONSIDERATION';
    referenceValues.push({rawLegId:leg.rawLegId,signature:leg.signature,at:leg.at,kind:leg.kind,convention,amountAtomic:leg.amountAtomic,counterasset:counter,reference:mark.reference,valueUsd:exact(value)});
   }else{
    check(leg.kind==='CROSS_ASSET_EXCHANGE','UNSUPPORTED_COUNTERASSET');const mark=select(target,p.token.address,event,900);value=mul(scale(units,p.targetDecimals),mark.value);convention='RECEIVED_TARGET_REFERENCE_VALUE';
    referenceValues.push({rawLegId:leg.rawLegId,signature:leg.signature,at:leg.at,kind:leg.kind,convention,amountAtomic:leg.amountAtomic,counterasset:counter,reference:mark.reference,valueUsd:exact(value)});
   }
  }
  if(leg.direction==='IN'){incoming+=units;basis.set(leg.rawLegId,value);conventions.set(leg.rawLegId,convention);acquisitions.push({rawLegId:leg.rawLegId,signature:leg.signature,at:leg.at,kind:leg.kind,sourceSemantics:leg.sourceSemantics,amountAtomic:leg.amountAtomic,counterasset:leg.counterasset,basisConvention:convention,basisUsd:exact(value)});}
  else if(leg.kind==='SALE'){sold+=units;proceeds.set(leg.rawLegId,value);}else transferred+=units;
 }
 const consumed=new Map<string,bigint>(),disposed=new Map<string,bigint>(),allocated=new Map<string,Rat>(),pairs=new Set<string>();
 const fifo=p.fifo.map(join=>{
  const acquisition=byId.get(join.acquiredRawLegId),disposal=byId.get(join.disposedRawLegId),units=atomic(join.unitsAtomic),pair=`${join.acquiredRawLegId}\u0000${join.disposedRawLegId}`;
  check(acquisition&&disposal&&acquisition.leg.direction==='IN'&&disposal.leg.direction==='OUT'&&acquisition.index<disposal.index&&units>0n&&!pairs.has(pair),'FIFO_JOIN');pairs.add(pair);
  check(join.disposition===disposal.leg.kind&&join.holdingSeconds===disposal.event-acquisition.event,'FIFO_KIND_OR_CLOCK');
  const taken=(consumed.get(join.acquiredRawLegId)??0n)+units,out=(disposed.get(join.disposedRawLegId)??0n)+units;check(taken<=acquisition.units&&out<=disposal.units,'FIFO_UNITS');consumed.set(join.acquiredRawLegId,taken);disposed.set(join.disposedRawLegId,out);
  const whole=basis.get(join.acquiredRawLegId);check(whole,'FIFO_ENTRY_BASIS');const share=rat(whole.n*units,whole.d*acquisition.units);allocated.set(join.disposedRawLegId,add(allocated.get(join.disposedRawLegId)??ZERO,share));
  return{...join,acquisitionUnitsAtomic:acquisition.leg.amountAtomic,basisConvention:conventions.get(join.acquiredRawLegId)!,allocatedBasisUsd:exact(share)};
 });
 for(const {leg,units}of byId.values())check((leg.direction==='IN'?consumed.get(leg.rawLegId):disposed.get(leg.rawLegId))===units,'FIFO_COVERAGE');
 check(incoming===sold+transferred,'QUANTITY_CONSERVATION');
 const sales=p.ledger.filter(leg=>leg.kind==='SALE').map(leg=>{const value=proceeds.get(leg.rawLegId),entry=allocated.get(leg.rawLegId);check(value&&entry,'SALE_BASIS_OR_VALUE');return{rawLegId:leg.rawLegId,signature:leg.signature,amountAtomic:leg.amountAtomic,proceedsUsd:exact(value),allocatedBasisUsd:exact(entry),realizedPrincipalReferenceResultUsd:exact(sub(value,entry))};});
 const transfers=p.ledger.filter(leg=>leg.kind==='PLAIN_TRANSFER').map(leg=>{const entry=allocated.get(leg.rawLegId);check(entry,'TRANSFER_BASIS');return{rawLegId:leg.rawLegId,signature:leg.signature,amountAtomic:leg.amountAtomic,carriedBasisUsd:exact(entry),proceeds:null,realizedPrincipalReferenceResultUsd:null};});
 const allBasis=sum([...basis.values()]),soldBasis=sum(p.ledger.filter(l=>l.kind==='SALE').map(l=>allocated.get(l.rawLegId)!)),carriedBasis=sum(p.ledger.filter(l=>l.kind==='PLAIN_TRANSFER').map(l=>allocated.get(l.rawLegId)!)),saleValue=sum([...proceeds.values()]);
 check(equal(allBasis,add(soldBasis,carriedBasis)),'BASIS_CONSERVATION');
 return{method:'creator-target-historical-reference-book-v1' as const,completeReferenceBook:true as const,policy:{creditBasis:CREDIT_BASIS,nativeMaxAgeSeconds:3600,targetMaxAgeSeconds:900,targetBarSeconds:60,incomeRecognition:'NOT_ASSERTED' as const},referenceValues,acquisitions,fifo,sales,transfers,unrealized:{heldAtomic:'0' as const,bookValueUsd:exact(ZERO),basis:'PROVED_ZERO_HELD_HEAD' as const},totals:{acquiredUnitsAtomic:incoming.toString(),soldUnitsAtomic:sold.toString(),transferredUnitsAtomic:transferred.toString(),heldUnitsAtomic:'0' as const,acquisitionBasisUsd:exact(allBasis),soldAllocatedBasisUsd:exact(soldBasis),carriedTransferBasisUsd:exact(carriedBasis),openBasisUsd:exact(ZERO),saleReferenceValueUsd:exact(saleValue),realizedPrincipalReferenceResultUsd:exact(sub(saleValue,soldBasis)),quantityConserved:true as const,basisConserved:true as const},aggregateNetProfit:null};
}
export type S15ReferenceBook=ReturnType<typeof compose>;
export type S15ReferenceBookResult={status:'COMPLETE';book:S15ReferenceBook}|{status:'MISSING';reasonCode:string};
export function composeS15ReferenceBook(input:S15ReferenceBookInput):S15ReferenceBookResult{
 try{return{status:'COMPLETE',book:compose(input)};}catch(error){return{status:'MISSING',reasonCode:error instanceof Error&&error.message.startsWith('S15_REFERENCE_BOOK_')?error.message:'S15_REFERENCE_BOOK_INPUT'};}
}
