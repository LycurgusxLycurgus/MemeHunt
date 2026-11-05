import test from 'node:test';
import assert from 'node:assert/strict';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,PUMP_AMM_EVENT_AUTHORITY_PDA,userVolumeAccumulatorPda} from '@pump-fun/pump-swap-sdk';
import {PublicKey} from '@solana/web3.js';
import {encodeSolanaAddress} from '../src/providers/solana.js';
import {eventPrefix,u64le,emitData} from './window-v36-fixtures.js';
import {decodePumpSwapReservePathTransaction,decodePumpSwapWindowTransaction,decodePumpSwapSynchronyTransaction} from '../src/providers/advisory-trades.js';
import {decodeWindowQuote} from '../src/providers/advisory-window.js';
import {projectCompiledTransaction} from '../src/providers/advisory-demand-windows.js';
import {deriveO29QuoteReservePath,deriveO29ReservePath,type ReservePathHistory,type ReservePathTrade} from '../src/providers/advisory-reserve-path.js';
import {synchronyResidualFixture} from './synchrony-bulk-fixtures.js';
const quote={mint:'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',decimals:8,program:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'};
const HOUR=3_600_000,start=Date.parse('2026-10-25T20:00:00.000Z'),end=new Date(start+12*HOUR).toISOString();
/** Constructed exact two-SELL financial DTOs. These are arithmetic inputs, never captured runtime proofs. */
function history(route=true):ReservePathHistory{
 let B=100000n,Q=1000000n;const V=100000n;
 const trades=Array.from({length:2},(_,i):ReservePathTrade=>{
  const b=500n,c=(Q+V)*b/(B+b),at=new Date(start+1000+i*1000).toISOString();
  const t:ReservePathTrade={signature:'constructed-'+i,slot:100+i,at,user:'constructed-user',side:'SELL',instructionIndex:0,instructionName:route?'multi_hop_swap':'sell_v2',baseAtomic:String(b),quoteAtomic:String(c),poolBaseReservesAtomic:String(B),poolQuoteReservesAtomic:String(Q),virtualQuoteReservesAtomic:String(V),transactionIndex:2+i,programTimestamp:String(Date.parse(at)/1000-1),provenance:{top:1,position:0,pumpOrdinal:0,hop:route?0:null,routeEvent:route?0:null,eventPayload:'YQ=='},quoteAccounting:{method:'pumpswap-event-fee-exclusive-v2',basis:'SELL_CORE',eventLayout:'SDK_PREFIX',eventQuoteAtomic:String(c),userQuoteAtomic:String(c),coreQuoteAtomic:String(c),grossQuoteAtomic:String(c),lpFeeAtomic:'0',protocolFeeAtomic:'0',creatorFeeAtomic:'0',totalFeeAtomic:'0',buybackFeeAtomic:'0',cashbackAtomic:'0',holderRewardsBps:null,holderRewardsAtomic:null,creatorFeeUnclaimedAtomic:null,...(route?{route:{hop:0,hops:1}}:{})}};
  B+=b;Q-=c;return t;
 });
 return{method:'CONSTRUCTED_COMPLETE_FINANCIAL_TEST_COHORT',eligible:true,pool:'constructed-pool',range:{start:new Date(start).toISOString(),end},anchorSlot:200,stateSlot:201,complete:true,reasonCode:'CONSTRUCTED_COMPLETE',hours:Array.from({length:12},(_,i)=>({start:new Date(start+i*HOUR).toISOString(),end:new Date(start+(i+1)*HOUR).toISOString(),complete:true})),transactions:trades.map(t=>({signature:t.signature,slot:t.slot,at:t.at,status:'OBSERVED',trades:1})),trades};
}
const derive=(h:ReservePathHistory)=>deriveO29QuoteReservePath(h,quote,['retained-source'])!;
function missing(h:ReservePathHistory,reason:string){const m=derive(h);assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,reason);assert.equal((m.data as any).whole,null);assert.equal((m.data as any).hours,null);return m.data as any;}

test('quote-aware exact reserve path keeps existing null depth/cohort and modelled endpoint semantics',()=>{
 for(const route of [false,true]){const h=history(route),m=derive(h),d=m.data as any;assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'EFFECTIVE_RESERVE_PATH_OBSERVED');assert.equal(d.method,'complete-pool-effective-reserve-path-v2');assert.equal(d.quoteMint,quote.mint);assert.equal(d.quoteDecimals,8);assert.equal(d.quoteProgram,quote.program);assert.equal(d.cohortClock,'CANONICAL_INDEX_BLOCK_TIME');assert.deepEqual([d.depthAtDefinedImpact,d.cohortBaseline,d.anomaly,d.thinLiquidity,d.offsetCause],[null,null,null,null,null]);assert.deepEqual([d.gates.curveMatches,d.gates.continuityPairs,d.gates.effectiveDiscontinuities],[2,1,0]);assert.equal(d.whole.modelledPost.basis,'MODELLED_CURVE_ENDPOINT');assert.equal(d.whole.modelledPost.at,h.trades[1]!.at);assert.equal(d.whole.modelledPost.programTimestamp,h.trades[1]!.programTimestamp);assert.notEqual(d.whole.modelledPost.at,h.range.end);assert.equal(d.hours[1].firstEventPre,null);assert.equal(d.hours[1].netCoreQuoteAtomic,'0');}
 const old=deriveO29ReservePath(history(false) as any,['retained-source'])!;assert.equal(old.quality,'KNOWN');assert.equal((old.data as any).method,'complete-pool-effective-reserve-path-v1');assert.equal((old.data as any).quoteDecimals,9);assert.equal((old.data as any).quoteProgram,undefined);assert.equal(deriveO29ReservePath(history(true) as any,[])!.reasonCode,'RESERVE_PATH_QUOTE_ACCOUNTING_MISSING');
});

test('whole path rejects missing V, one-atom curve error, effective reserve gap and incomplete population',()=>{
 let h=history();delete (h.trades[0] as any).virtualQuoteReservesAtomic;missing(h,'RESERVE_PATH_VIRTUAL_QUOTE_MISSING');
 h=history();const t=h.trades[0]!;t.quoteAtomic=String(BigInt(t.quoteAtomic)+1n);t.quoteAccounting!.coreQuoteAtomic=t.quoteAtomic;missing(h,'RESERVE_CURVE_MISMATCH');
 h=history();const x=h.trades[1]!,Q=BigInt(x.poolQuoteReservesAtomic)+100000n,B=BigInt(x.poolBaseReservesAtomic),V=BigInt(x.virtualQuoteReservesAtomic),b=BigInt(x.baseAtomic),core=(Q+V)*b/(B+b);x.poolQuoteReservesAtomic=String(Q);x.quoteAtomic=x.quoteAccounting!.coreQuoteAtomic=String(core);const g=missing(h,'RESERVE_PATH_EFFECTIVE_DISCONTINUOUS').gates;assert.equal(g.curveMismatches,0);assert.equal(g.effectiveDiscontinuities,1);
 h=history();h.complete=false;h.reasonCode='SOURCE_BODY_UNRESOLVED';missing(h,'SOURCE_BODY_UNRESOLVED');
 h=history();h.transactions[0]!.trades=0;missing(h,'RESERVE_PATH_TAPE_SHRUNK');
 h=history();h.transactions[0]!.status='INVALID';missing(h,'RESERVE_PATH_TAPE_SHRUNK');
 h=history();h.hours.pop();missing(h,'RESERVE_PATH_HOURS_UNALIGNED');
});

test('multi-hop kind requires bound route/provenance and repeated selected legs preserve real invocation order',()=>{
 for(const mutate of [(t:ReservePathTrade)=>{delete t.quoteAccounting!.route;},(t:ReservePathTrade)=>{t.provenance.hop=1;},(t:ReservePathTrade)=>{t.quoteAccounting!.route!.hops=0;}]){const h=history();mutate(h.trades[0]!);missing(h,'RESERVE_PATH_ROUTE_CONTEXT_INVALID');}
 let h=history();h.trades[0]!.side='BUY';missing(h,'RESERVE_PATH_QUOTE_ACCOUNTING_MISSING');
 h=history();h.trades[0]!.quoteAccounting!.basis='BUY_CORE';missing(h,'RESERVE_PATH_ROUTE_KIND_INVALID');
 h=history(false);h.trades[0]!.provenance.hop=0;missing(h,'RESERVE_PATH_PROVENANCE_INVALID');
 h=history();for(let i=0;i<2;i++){const t=h.trades[i]!;t.signature='same-transaction';t.slot=100;t.transactionIndex=2;t.at=h.trades[0]!.at;t.quoteAccounting!.route={hop:i*2,hops:3};t.provenance.hop=i*2;t.provenance.routeEvent=i*2;}
 h.transactions=[{signature:'same-transaction',slot:100,at:h.trades[0]!.at,status:'OBSERVED',trades:2}];assert.equal(derive(h).quality,'KNOWN');
 // A logged/recovered path may retain inverted legacy indexes; canonical bound provenance is invariant.
 const recovered=structuredClone(h);recovered.trades[0]!.instructionIndex=2;recovered.trades[1]!.instructionIndex=0;assert.equal(derive(recovered).quality,'KNOWN');
 const duplicate=structuredClone(h);duplicate.trades[1]!.provenance.routeEvent=0;missing(duplicate,'RESERVE_PATH_ORDER_INVALID');
 const wrongParent=structuredClone(h);wrongParent.trades[1]!.provenance.position=1;missing(wrongParent,'RESERVE_PATH_ORDER_INVALID');
 h=history();h.trades[1]!.slot=h.trades[0]!.slot;h.trades[1]!.transactionIndex=null;missing(h,'INTRA_SLOT_ORDER_UNKNOWN');
 assert.throws(()=>deriveO29QuoteReservePath(history(),{...quote,decimals:-1},[]),/RESERVE_PATH_QUOTE_CONTEXT_INVALID/);
});

function context(){const f=synchronyResidualFixture(),bank=JSON.parse(f.poolSource.raw).result,pa=bank.value[0],pool=PUMP_AMM_SDK.decodePool({data:Buffer.from(pa.data[0],'base64'),owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0}),q=decodeWindowQuote(bank.value[1],pool.quoteMint.toBase58());return{f,bank,pool,q};}
function paired(c:any,ctx:ReturnType<typeof context>,count=false){const tx=c.transaction,e={signature:c.signature,slot:tx.slot,at:c.indexAt},fn=count?decodePumpSwapSynchronyTransaction:decodePumpSwapReservePathTransaction;const call=(v:any,p:any)=>fn(v,e,ctx.f.pool,ctx.pool,ctx.bank.context.slot,c.bulkSource.retrievedAt,ctx.q.program,ctx.q.decimals,p);try{return call(tx,{logRecovery:tx.meta.logMessages.includes('Log truncated')});}catch(error){if(c.compiled)return call(projectCompiledTransaction(JSON.parse(c.compiled.raw).result),{logRecovery:true,foreignFlowRecovery:true,compiledRecovery:true});if(!tx.meta.logMessages.includes('Log truncated'))return call(tx,{logRecovery:true});throw error;}}

test('all 21 genuine residuals gain full O29 fields through the separate financial boundary; old financial clocks/count DTO stay frozen',()=>{
 const ctx=context();let legs=0,compiled=0,seams=0;
 for(const c of ctx.f.cases){const before=JSON.stringify(c.transaction),p=paired(c,ctx),counts=paired(c,ctx,true);if(c.compiled)compiled++;assert.equal(p.trades.length,counts.trades.length);legs+=p.trades.length;
  for(let i=0;i<p.trades.length;i++){const t=p.trades[i] as any,ct=counts.trades[i]!;assert.equal(t.at,c.indexAt);assert.match(t.virtualQuoteReservesAtomic,/^(0|-?[1-9]\d*)$/);assert.ok(t.quoteAccounting);assert.ok(BigInt(t.baseAtomic)>0n);assert.ok(BigInt(t.quoteAtomic)>0n);assert.equal(t.programTimestamp,ct.programTimestamp);assert.deepEqual(t.provenance,ct.provenance);assert.equal((ct as any).quoteAccounting,undefined);assert.equal((ct as any).virtualQuoteReservesAtomic,undefined);if(t.instructionName==='multi_hop_swap'){assert.ok(t.quoteAccounting.route);assert.equal(t.quoteAccounting.route.hop,t.provenance.hop);}}
  if(['ADVISORY_TRADE_EVENT_BINDING','ADVISORY_TRADE_MULTIHOP_EVENT_BINDING'].includes(c.originalFailure)){seams++;assert.throws(()=>decodePumpSwapWindowTransaction(c.transaction,{signature:c.signature,slot:c.transaction.slot,at:c.indexAt},ctx.f.pool,ctx.pool,ctx.bank.context.slot,c.bulkSource.retrievedAt,true,true,false,true,false,true,ctx.q.program,true,ctx.q.decimals),new RegExp(c.originalFailure));}
  assert.equal(JSON.stringify(c.transaction),before);
 }
 assert.equal(legs,20);assert.equal(compiled,16);assert.equal(seams,5);
});

test('new financial paired-clock path still rejects future program clocks and wrong bound user/role',()=>{
 const ctx=context(),c=ctx.f.cases.find((x:any)=>x.originalFailure==='ADVISORY_TRADE_MULTIHOP_EVENT_BINDING'),p=paired(c,ctx),t=p.trades[0] as any;
 const tx=structuredClone(c.transaction),at=Number(t.programTimestamp)-2;tx.blockTime=at;
 assert.throws(()=>decodePumpSwapReservePathTransaction(tx,{signature:c.signature,slot:tx.slot,at:new Date(at*1000).toISOString()},ctx.f.pool,ctx.pool,ctx.bank.context.slot,new Date((at+1)*1000).toISOString(),ctx.q.program,ctx.q.decimals),/ADVISORY_TRADE_(MULTIHOP_)?EVENT_BINDING/);
 const bad=structuredClone(c.transaction),pv=t.provenance,ix=pv.position<0?bad.transaction.message.instructions[pv.top]:bad.meta.innerInstructions.find((g:any)=>g.index===pv.top).instructions[pv.position];ix.accounts[0]=ctx.f.pool;
 assert.throws(()=>decodePumpSwapReservePathTransaction(bad,{signature:c.signature,slot:bad.slot,at:c.indexAt},ctx.f.pool,ctx.pool,ctx.bank.context.slot,c.bulkSource.retrievedAt,ctx.q.program,ctx.q.decimals),/ADVISORY_TRADE_/);
 assert.throws(()=>decodePumpSwapReservePathTransaction(c.transaction,{signature:c.signature,slot:c.transaction.slot,at:c.indexAt},ctx.f.pool,ctx.pool,ctx.bank.context.slot,c.bulkSource.retrievedAt,ctx.q.program,ctx.q.decimals,{compiledRecovery:true}),/ADVISORY_TRADE_RESERVE_PATH_SCOPE/);
});

/** Existing proof36 supported opcode: one route revisits the selected venue at hops0 and2.
 * This conformance receipt tests invocation ordering only; its reserves are not a measured curve path. */
test('canonical multi-hop opcode retains observed indexes0/2 for two selected legs in one bound parent',()=>{
 const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58(),program=PUMP_AMM_PROGRAM_ID.toBase58(),authority=PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(),system='11111111111111111111111111111111',user=new PublicKey(Buffer.alloc(32,4)),U=user.toBase58(),input=key(30),output=key(31),router=key(20),S=key(100),A=key(101),selected=key(40),baseVault=key(60),quoteVault=key(61),foreign=key(51),at=Math.floor(start/1000)+60;
 const fixed=[U,input,output,GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58(),userVolumeAccumulatorPda(user).toBase58(),key(15),quote.program,'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',system,authority,program,'6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P','4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf','8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt','Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'];
 const hopAccounts=[[A,S,selected,baseVault,quoteVault],[S,A,foreign,key(72),key(73)],[A,S,selected,baseVault,quoteVault]],amounts=[[100300n,100000n,90000n,0n,300n,0n],[90000n,90000n,80000n,0n,0n,0n],[80000n,79700n,70000n,200n,0n,100n]];
 const events=amounts.map(([gross,core,base,lp,protocol,creator],i)=>Buffer.concat([eventPrefix('buyEvent',{timestamp:BigInt(at),pool:new PublicKey(hopAccounts[i]![2]!),user,user_base_token_account:new PublicKey(i===2?output:system),user_quote_token_account:new PublicKey(i===0?input:system),pool_base_token_reserves:100000n,pool_quote_token_reserves:1000000n,ix_name:'multi_hop_swap',quote_amount_in:gross!,user_quote_amount_in:core!,quote_amount_in_with_lp_fee:core!+lp!,base_amount_out:base!,lp_fee:lp!,protocol_fee:protocol!,coin_creator_fee:creator!}),u64le(0n),u64le(0n),u64le(0n)]));
 const ix={programId:program,accounts:[...fixed,...hopAccounts.flat()],data:encodeSolanaAddress(Buffer.concat([Buffer.from([43,100,73,19,233,246,111,148]),u64le(100300n),u64le(70000n)])),stackHeight:2},inner=[ix,...events.map(e=>({programId:program,accounts:[authority],data:encodeSolanaAddress(emitData(e)),stackHeight:3}))],keys=[...new Set([router,U,...inner.flatMap(i=>[i.programId,...i.accounts])])],logs=[`Program ${router} invoke [1]`,`Program ${program} invoke [2]`,...events.flatMap(e=>[`Program data: ${e.toString('base64')}`,`Program ${program} invoke [3]`,`Program ${program} success`]),`Program ${program} success`,`Program ${router} success`];
 const tx={version:0,slot:1000,blockTime:at,transaction:{signatures:['constructed-repeat'],message:{accountKeys:keys.map(pubkey=>({pubkey,signer:pubkey===U,writable:true})),instructions:[{programId:router,accounts:[U],data:encodeSolanaAddress(Buffer.from([1]))}]}},meta:{err:null,fee:5000,innerInstructions:[{index:0,instructions:inner}],logMessages:logs}},pool={baseMint:new PublicKey(A),quoteMint:new PublicKey(S),poolBaseTokenAccount:new PublicKey(baseVault),poolQuoteTokenAccount:new PublicKey(quoteVault)};
 const p=decodePumpSwapReservePathTransaction(tx,{signature:'constructed-repeat',slot:1000,at:new Date(at*1000).toISOString()},selected,pool as any,1001,new Date((at+120)*1000).toISOString(),quote.program,9);
 assert.deepEqual(p.trades.map(t=>[t.instructionIndex,t.provenance.top,t.provenance.position,t.provenance.pumpOrdinal,t.provenance.hop,t.provenance.routeEvent,t.quoteAccounting!.route]),[[0,0,0,0,0,0,{hop:0,hops:3}],[2,0,0,0,2,2,{hop:2,hops:3}]]);
});
