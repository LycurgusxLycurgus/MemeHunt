/** A29 v2 provider tests over synthetic portable fixtures; no live claim and no private data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeA29CaptureV2,deriveA29AbsorptionV2} from '../src/providers/advisory-absorption-v2.js';
import {buildA29V2Capture,fixtureSignature,rpc,base58,V2,QUOTE,type V2Options} from './a29-v2-fixtures.js';
import {PUMP_AMM_PROGRAM_ID} from '@pump-fun/pump-swap-sdk';
// Reuses the explicitly synthetic compiled swap builder; its pool is the same key(7)/WSOL canonical pool as the v2 WSOL fixture.
import {a29SwapTransaction,type A29Swap} from './advisory-absorption.test.js';
import {PublicKey} from '@solana/web3.js';

const derive=async(o:V2Options={})=>{const f=await buildA29V2Capture(o),c=decodeA29CaptureV2(f.raw);return deriveA29AbsorptionV2(c.freeze,c.label,c.receipts,f.cutoff,['a29-v2']);};
const rejects=(o:V2Options,code:string)=>assert.rejects(derive(o),(e:Error)=>{assert.equal(e.message,code);return true;});
const gap=async(o:V2Options,quality:string,reason:string)=>{const m=await derive(o),d=m.data as any;assert.equal(m.quality,quality);assert.equal(m.reasonCode,reason);assert.equal(d.vector,null);};
const tokenOf=(p:any)=>p.freeze.tokens[0];
const measuredRow=(err:unknown)=>({signature:fixtureSignature(1),slot:V2.slot0+10,blockTime:V2.t0+10,err});

test('A29 v2 WSOL zero-flow capture is KNOWN at the native threshold', async()=>{
 const m=await derive(),d=m.data as any;
 assert.equal(m.quality,'KNOWN');
 assert.equal(d.instrument.meaningfulBuyerQuoteAtomic,'10000000');
 assert.equal(d.instrument.thresholdSource,'NATIVE');
 assert.deepEqual([d.vector.units.quoteMint,d.vector.units.quoteDecimals,d.vector.units.fx],[QUOTE.WSOL,9,null]);
 assert.equal(d.vector.selling.trades,0);
});

test('A29 v2 WBTC binds the genuine endpoint0 sqrt price to threshold 1266', async()=>{
 const m=await derive({quote:'WBTC'}),d=m.data as any;
 assert.equal(m.quality,'KNOWN');
 assert.equal(d.instrument.meaningfulBuyerQuoteAtomic,'1266');
 assert.deepEqual([d.vector.units.quoteMint,d.vector.units.quoteDecimals,d.vector.units.fx.bankSlot],[QUOTE.WBTC,8,V2.slot0]);
});

test('A29 v2 USDC threshold rounds up at the unit-price boundary', async()=>{
 const exact=await derive({quote:'USDC',sqrt:1n<<64n}),above=await derive({quote:'USDC',sqrt:(1n<<64n)+1n});
 assert.equal((exact.data as any).instrument.meaningfulBuyerQuoteAtomic,'10000000');
 assert.equal((above.data as any).instrument.meaningfulBuyerQuoteAtomic,'10000001');
 assert.equal((above.data as any).vector.units.quoteDecimals,6);
});

test('A29 v2 accepts captured floor omission and the single genesis alias', async()=>{
 assert.equal((await derive({floor:false})).quality,'KNOWN');
 assert.equal((await derive({quote:'WBTC',e1Genesis:false})).quality,'KNOWN');
});

test('A29 v2 retains failed rows without transaction reads', async()=>{
 assert.equal((await derive({pages:[[measuredRow({InstructionError:[0,{Custom:1}]})]]})).quality,'KNOWN');
});

test('A29 v2 never zero-fills missing or unsupported flow', async()=>{
 await gap({pages:[[measuredRow(null)]]},'MISSING','A29_V2_RECEIPT_ABSENT');
 const body=rpc({slot:V2.slot0+10,blockTime:V2.t0+10,meta:{err:null},transaction:{}});
 await gap({pages:[[measuredRow(null)]],transactions:[{signature:fixtureSignature(1),body}]},'MISSING','A29_V2_TRADE_UNSUPPORTED');
});

test('A29 v2 rejects FX, threshold, route and quote tampering', async()=>{
 await rejects({quote:'WBTC',mutate:p=>{const z=tokenOf(p).endpoint0;z.meaningfulQuoteAtomic=String(BigInt(z.meaningfulQuoteAtomic)-1n);}},'A29_V2_FREEZE_THRESHOLD');
 await rejects({quote:'WBTC',mutate:p=>{tokenOf(p).bankKeys=tokenOf(p).bankKeys.slice(0,7);}},'A29_V2_FREEZE_BANK_KEYS');
 await rejects({quote:'WBTC',bankSqrt:(1n<<64n)},'A29_V2_FREEZE_THRESHOLD_MISMATCH');
 await rejects({quote:'USDC',quoteDecimals:9},'A29_V2_BANK_QUOTE_MINT');
 await rejects({mutate:p=>{tokenOf(p).endpoint0.bankSlot+=1;}},'A29_V2_FREEZE_ENDPOINT0_MISMATCH');
 await rejects({mutate:p=>{p.freeze.frozenAt=new Date(V2.t0*1000-60000).toISOString();}},'A29_V2_FREEZE_TIMING');
});

test('A29 v2 validates captured floors without rewriting them', async()=>{
 await rejects({source:r=>{r['a29-e0-bank'].params[1].minContextSlot=V2.slot0+1;}},'A29_V2_CONTEXT_FLOOR');
 await rejects({source:r=>{r['a29-e1-population'].params[1].minContextSlot=-1;}},'A29_V2_REQUEST_FLOOR');
});

test('A29 v2 rejects packet, record and membership tampering', async()=>{
 await rejects({mutate:p=>{p.method='a29-retained-sources-v1';}},'A29_V2_CAPTURE_SHAPE');
 await rejects({mutate:p=>{p.token.address=QUOTE.USDC;}},'A29_V2_CAPTURE_TOKEN');
 await rejects({mutate:p=>{p.freeze.bounds.tapeMaxPages=2;}},'A29_V2_FREEZE_BOUNDS');
 await rejects({mutate:p=>{p.provenance.records[0].cache='x';}},'A29_V2_CAPTURE_RECORD');
 await rejects({mutate:p=>{p.provenance.records[0].sourceSha256='0'.repeat(64);}},'A29_V2_RECEIPT_INTEGRITY');
 await rejects({mutate:p=>{const r=p.provenance.records.find((x:any)=>x.key==='a29-e0-population');r.sourceBytes=320000000;}},'A29_V2_CAPTURE_INFLATE_BUDGET');
 await rejects({mutate:p=>{for(const k of ['requests','rawArtifacts','retrievedAt'])p[k]['a29-page-5']=p[k]['a29-page-0'];p.provenance.records.push({...p.provenance.records.find((x:any)=>x.key==='a29-page-0'),key:'a29-page-5'});}},'A29_V2_RECEIPT_UNUSED');
});

test('A29 v2 rejects a declared role overrun at decode, before inflation', async()=>{
 await rejects({mutate:p=>{p.provenance.records.find((x:any)=>x.key==='a29-page-0').sourceBytes=2000001;}},'A29_V2_RECEIPT_BYTES');
});

// Synthetic constructed swaps through the production v2 decoder, owner binder and aggregation; no live claim.
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)),row=(n:number,slot:number,blockTime:number)=>({signature:fixtureSignature(n),slot,blockTime,err:null});
const buyer=(n:number,r:ReturnType<typeof row>,core:bigint):A29Swap=>({row:r,side:'BUY',core,base:100n,user:key(n),account:key(100+n),owner:key(n).toBase58()});
/** Synthetic v2 wrapper over the unchanged v1 builder: adds the genuine-format PumpSwap emit_cpi witness for the logged event.
 * The inner instruction carries tag e445a52e51cb9a1d plus the Program data payload, and its sole account is the canonical event authority. Matching invoke [2]/success logs are added after the Program data line. */
const PUMP=PUMP_AMM_PROGRAM_ID.toBase58(),EVENT_AUTHORITY=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],PUMP_AMM_PROGRAM_ID)[0].toBase58();
function v2SwapTransaction(s:A29Swap):any{
 const tx=a29SwapTransaction(s),keys:string[]=tx.transaction.message.accountKeys,logs:string[]=tx.meta.logMessages;
 const at=logs.findIndex(l=>l.startsWith('Program data: ')),payload=Buffer.from(logs[at]!.slice('Program data: '.length),'base64');
 const pump=keys.indexOf(PUMP),authority=keys.indexOf(EVENT_AUTHORITY);
 if(at<0||pump<0||authority<0)throw new Error('A29_V2_FIXTURE_EVENT');
 const data=base58(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),payload]));
 tx.meta.innerInstructions[0].instructions.push({programIdIndex:pump,accounts:[authority],data,stackHeight:2});
 logs.splice(at+1,0,`Program ${PUMP} invoke [2]`,`Program ${PUMP} success`);
 return tx;
}
const swaps=(list:A29Swap[]):V2Options=>({pages:[list.map(s=>s.row)],transactions:list.map(s=>({signature:s.row.signature,body:rpc(v2SwapTransaction(s))}))});

test('A29 v2 full measure aggregates delegate-signed cohort SELL and BUY and symmetric fresh buyers at the T-1/T boundary', async()=>{
 const {t0}=V2,L=V2.seconds;
 const m=await derive(swaps([
  // Measured: cohort SELL and BUY, each signed by a delegate that is not the leg account owner.
  {row:row(1,2500,t0+800),side:'SELL',core:20000000n,base:800n,user:key(60),account:key(100),owner:key(20).toBase58()},
  {row:row(2,2400,t0+700),side:'BUY',core:30000000n,base:300n,user:key(61),account:key(101),owner:key(21).toBase58()},
  buyer(70,row(3,2300,t0+600),15000000n),
  buyer(71,row(4,2200,t0+500),9999999n),
  // Slot governs equal block times: slot0+1 is measured, slot0 is baseline. T=10000000 counts, T-1 does not.
  buyer(74,row(5,1001,t0),10000000n),
  buyer(70,row(6,1000,t0),20000000n),
  buyer(72,row(7,900,t0-L),12000000n),
  buyer(72,row(8,800,t0-L-1),12000000n),
  buyer(73,row(9,700,t0-2*L),12000000n),
 ])),v=(m.data as any).vector;
 assert.equal(m.quality,'KNOWN',m.reasonCode);
 assert.deepEqual(v.selling,{trades:2,sellBaseAtomic:'800',sellQuoteAtomic:'20000000',buyBaseAtomic:'300',buyQuoteAtomic:'30000000',netSellBaseAtomic:'500'});
 // Warmup {72,73}; baseline {70,72} minus warmup = {70}; measured {61,70,74} minus baseline = {61,74}; 71 is below T.
 const g=v.newBuyerGrowth;
 assert.deepEqual([g.warmup.meaningfulBuyers,g.baseline.meaningfulBuyers,g.measured.meaningfulBuyers,g.difference,g.ratio],[2,1,2,1,'2']);
 assert.deepEqual(v.inventory,{deltaAtomic:'-1000000000000',residualAtomic:'-999999999500'});
 assert.ok(v.cohort.every((c:any)=>c.owner!==key(60).toBase58()&&c.owner!==key(61).toBase58()));
});

test('A29 v2 full measure withholds the vector on an unknown pre-owner and counts T-1 dust as observed zero', async()=>{
 const r=()=>row(1,2500,V2.t0+800);
 await gap(swaps([{...buyer(70,r(),15000000n),pre:'omit'}]),'MISSING','A29_V2_OWNER_AMBIGUOUS');
 const dust=await derive(swaps([buyer(71,r(),9999999n)]));
 assert.equal(dust.quality,'KNOWN',dust.reasonCode);
 assert.equal((dust.data as any).vector.newBuyerGrowth.measured.meaningfulBuyers,0);
});
