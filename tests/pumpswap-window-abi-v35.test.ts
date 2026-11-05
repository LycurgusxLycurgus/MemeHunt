import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { OFFLINE_PUMP_AMM_PROGRAM } from '@pump-fun/pump-swap-sdk';
import {
  decodePinnedWindowEvent, reconcileWindowQuote,
  PUMP_WINDOW_ABI_SOURCE, PUMP_WINDOW_ABI_HASH,
  PUMP_WINDOW_V35_ABI_SOURCE, PUMP_WINDOW_V35_ABI_HASH,
} from '../src/providers/pumpswap-window-abi.js';

// The installed @pump-fun/pump-swap-sdk@1.20 coder ends its BuyEvent/SellEvent prefix at base_supply.
// We build that prefix from the coder, then append the fixed official-order tail u64 (holder_rewards_bps,
// holder_rewards, creator_fee_unclaimed, quote_transfer_fee), exactly as the chain emits the v35 log.
const toCamel=(s:string):string=>s.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
type EventIdl={events:Array<{name:string;discriminator:number[]}>;types:Array<{name:string;type:{fields:Array<{name:string;type:unknown}>}}>};
function eventPrefix(name:'buyEvent'|'sellEvent',overrides:Record<string,bigint|string|boolean|PublicKey>):Buffer{
  const idl=OFFLINE_PUMP_AMM_PROGRAM.idl as unknown as EventIdl;
  const event=idl.events.find(e=>e.name===name)!;
  const type=idl.types.find(t=>t.name===name)!;
  assert.ok(event&&type,`installed SDK IDL carries ${name}`);
  const data:Record<string,unknown>={};
  // Set both the raw IDL key and its camelCase form so the vector is robust to the coder's casing.
  const put=(k:string,v:bigint|string|boolean|PublicKey):void=>{const val=typeof v==='bigint'?new BN(v.toString()):v;data[k]=val;data[toCamel(k)]=val;};
  for(const field of type.type.fields){
    put(field.name,field.type==='pubkey'?PublicKey.default:field.type==='bool'?false:field.type==='string'?(name==='buyEvent'?'buy':'sell'):0n);
  }
  for(const [k,v] of Object.entries(overrides))put(k,v);
  const encoded=OFFLINE_PUMP_AMM_PROGRAM.coder.types.encode(name,data as never);
  return Buffer.concat([Buffer.from(event.discriminator),Buffer.from(encoded)]);
}
function u64le(v:bigint):Buffer{const b=Buffer.alloc(8);b.writeBigUInt64LE(v);return b;}
function payload(prefix:Buffer,...tail:bigint[]):string{return Buffer.concat([prefix,...tail.map(u64le)]).toString('base64');}

// Valid fee-exclusive identities shared by the vectors and the direct reconcile objects.
const LP=100n,PROT=50n,CREATOR=25n,FEES=175n,CCFBPS=30n,CORE=10000n;
const buyFields={lp_fee:LP,protocol_fee:PROT,coin_creator_fee:CREATOR,coin_creator_fee_basis_points:CCFBPS,quote_amount_in:CORE,user_quote_amount_in:CORE+FEES,quote_amount_in_with_lp_fee:CORE+LP,base_amount_out:5000n};
const sellFields={lp_fee:LP,protocol_fee:PROT,coin_creator_fee:CREATOR,coin_creator_fee_basis_points:CCFBPS,quote_amount_out:CORE,user_quote_amount_out:CORE-FEES,quote_amount_out_without_lp_fee:CORE-LP,base_amount_in:5000n};
const buyD=(o:Record<string,unknown>={}):Record<string,unknown>=>({ixName:'buy',eventLayout:'SDK_PREFIX',lpFee:LP,protocolFee:PROT,coinCreatorFee:CREATOR,coinCreatorFeeBasisPoints:CCFBPS,quoteAmountIn:CORE,userQuoteAmountIn:CORE+FEES,quoteAmountInWithLpFee:CORE+LP,buybackFee:0n,cashback:0n,cashbackFeeBasisPoints:0n,...o});
const sellD=(o:Record<string,unknown>={}):Record<string,unknown>=>({ixName:'sell',eventLayout:'SDK_PREFIX',lpFee:LP,protocolFee:PROT,coinCreatorFee:CREATOR,coinCreatorFeeBasisPoints:CCFBPS,quoteAmountOut:CORE,userQuoteAmountOut:CORE-FEES,quoteAmountOutWithoutLpFee:CORE-LP,buybackFee:0n,cashback:0n,cashbackFeeBasisPoints:0n,...o});
const exactD=(o:Record<string,unknown>={}):Record<string,unknown>=>({ixName:'buy_exact_quote_in',eventLayout:'SDK_PREFIX',lpFee:LP,protocolFee:PROT,coinCreatorFee:CREATOR,coinCreatorFeeBasisPoints:CCFBPS,quoteAmountIn:CORE+FEES,userQuoteAmountIn:CORE,quoteAmountInWithLpFee:CORE+LP,buybackFee:0n,cashback:0n,cashbackFeeBasisPoints:0n,...o});
const holder0={holderRewardsBps:0n,holderRewards:0n,creatorFeeUnclaimed:0n};

test('default decode: SDK_PREFIX and +24 CURRENT_APPENDIX keep the exact legacy accounting shape, never exposing quote_transfer_fee', () => {
  const prefix=eventPrefix('buyEvent',buyFields);
  const sdk=decodePinnedWindowEvent(prefix.toString('base64'),true)!;
  assert.equal(sdk.name,'buyEvent');
  assert.equal(sdk.data.eventLayout,'SDK_PREFIX');
  assert.equal(sdk.data.holderRewardsBps,null);
  assert.ok(!('quoteTransferFee' in sdk.data),'default mode never adds quote_transfer_fee');
  const current=decodePinnedWindowEvent(payload(prefix,30n,27n,28n),true)!;
  assert.equal(current.data.eventLayout,'CURRENT_APPENDIX');
  assert.equal(current.data.holderRewardsBps,30n);
  assert.equal(current.data.holderRewards,27n);
  assert.equal(current.data.creatorFeeUnclaimed,28n);
  assert.ok(!('quoteTransferFee' in current.data));
});

test('default decode rejects the +32 transfer-fee appendix and leaves the two-arg legacy object untouched', () => {
  const prefix=eventPrefix('buyEvent',buyFields);
  assert.throws(()=>decodePinnedWindowEvent(payload(prefix,30n,27n,28n,29n),true),/ADVISORY_TRADE_EVENT_ENCODING/);
  const legacy=decodePinnedWindowEvent(prefix.toString('base64'))!;
  assert.equal(legacy.name,'buyEvent');
  assert.equal(legacy.data.baseAmountOut.toString(),'5000');
  assert.ok(!('eventLayout' in legacy.data),'two-arg call performs no accounting assignment');
});

test('modern decode parses the +32 transfer-fee appendix and round-trips the full official tail', () => {
  const prefix=eventPrefix('sellEvent',sellFields);
  const decoded=decodePinnedWindowEvent(payload(prefix,30n,27n,28n,29n),true,true)!;
  assert.equal(decoded.name,'sellEvent');
  assert.equal(decoded.data.eventLayout,'TRANSFER_FEE_APPENDIX');
  assert.equal(decoded.data.holderRewardsBps,30n);
  assert.equal(decoded.data.holderRewards,27n);
  assert.equal(decoded.data.creatorFeeUnclaimed,28n);
  assert.equal(decoded.data.quoteTransferFee,29n);
});

test('modern decode distinguishes an absent transfer fee (null) from a declared 0 across layouts', () => {
  const prefix=eventPrefix('buyEvent',buyFields);
  const sdk=decodePinnedWindowEvent(prefix.toString('base64'),true,true)!;
  assert.equal(sdk.data.eventLayout,'SDK_PREFIX');
  assert.equal(sdk.data.quoteTransferFee,null);
  const current=decodePinnedWindowEvent(payload(prefix,0n,0n,0n),true,true)!;
  assert.equal(current.data.eventLayout,'CURRENT_APPENDIX');
  assert.equal(current.data.quoteTransferFee,null);
  const taxed=decodePinnedWindowEvent(payload(prefix,0n,0n,0n,0n),true,true)!;
  assert.equal(taxed.data.eventLayout,'TRANSFER_FEE_APPENDIX');
  assert.equal(taxed.data.quoteTransferFee,0n);
});

test('modern decode strictly rejects any non {0,24,32} trailing length and any non-canonical prefix encoding', () => {
  const prefix=eventPrefix('buyEvent',buyFields);
  for(const bad of [[0n],[0n,0n],[0n,0n,0n,0n,0n]]) assert.throws(()=>decodePinnedWindowEvent(payload(prefix,...bad),true,true),/ADVISORY_TRADE_EVENT_ENCODING/);
  assert.throws(()=>decodePinnedWindowEvent(Buffer.concat([prefix,Buffer.alloc(33)]).toString('base64'),true,true),/ADVISORY_TRADE_EVENT_ENCODING/);
  // A non-canonical borsh bool (0x02) is a genuinely malformed encoding: it is rejected either by the SDK
  // coder ('Invalid bool') or, for bytes that would still decode, by our re-encode round-trip guard. Either
  // valid boundary is an acceptable rejection. A plain value edit (e.g. flipping a base_supply byte) is a
  // different-but-valid u64 that re-encodes identically and must NOT be treated as malformed, so we target
  // an actual bad encoding and only require that it is rejected.
  const flagged=eventPrefix('buyEvent',{...buyFields,can_boost:true});
  let idx=-1;for(let i=0;i<prefix.length;i++)if(prefix[i]!==flagged[i]){idx=i;break;}
  assert.ok(idx>=0,'located the canonical can_boost byte for the non-canonical mutation');
  const nonCanonical=Buffer.from(prefix);nonCanonical[idx]=0x02;
  assert.throws(()=>decodePinnedWindowEvent(payload(nonCanonical,0n,0n,0n,0n),true,true));
});

test('v1 reconcile returns the exact legacy contract for buy/exact/sell with no transfer-fee field', () => {
  const buy=reconcileWindowQuote('buy',buyD());
  assert.equal(buy.method,'pumpswap-event-fee-exclusive-v1');
  assert.equal(buy.basis,'BUY_CORE');
  assert.equal(buy.coreQuoteAtomic,'10000');
  assert.equal(buy.grossQuoteAtomic,'10175');
  assert.equal(buy.totalFeeAtomic,'175');
  assert.ok(!('quoteTransferFeeAtomic' in buy),'v1 object stays identical for proofs 1-34');
  assert.equal(reconcileWindowQuote('sell',sellD()).basis,'SELL_CORE');
  const ex=reconcileWindowQuote('buy_exact_quote_in',exactD());
  assert.equal(ex.basis,'EXACT_QUOTE_BUY_GROSS');
  assert.equal(ex.coreQuoteAtomic,'10000');
  assert.equal(ex.grossQuoteAtomic,'10175');
});

test('v1 reconcile accepts a zero holder CURRENT_APPENDIX but rejects nonzero holder rewards and the v35 transfer layout', () => {
  const ok=reconcileWindowQuote('buy',buyD({eventLayout:'CURRENT_APPENDIX',...holder0,creatorFeeUnclaimed:999n}));
  assert.equal(ok.holderRewardsAtomic,'0');
  assert.equal(ok.creatorFeeUnclaimedAtomic,'999');
  assert.throws(()=>reconcileWindowQuote('buy',buyD({eventLayout:'CURRENT_APPENDIX',holderRewardsBps:30n,holderRewards:25n,creatorFeeUnclaimed:0n})),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('buy',buyD({eventLayout:'TRANSFER_FEE_APPENDIX',...holder0,quoteTransferFee:0n})),/ADVISORY_TRADE_FEE_BINDING/);
});

test('v1 reconcile rejects buyback above protocol, malformed/overflowing u64, broken identities and non-positive core', () => {
  assert.throws(()=>reconcileWindowQuote('buy',buyD({buybackFee:51n})),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('buy',buyD({lpFee:'-1'})),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('buy',buyD({lpFee:'18446744073709551616'})),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('buy',buyD({userQuoteAmountIn:10174n})),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('buy',buyD({quoteAmountIn:0n,userQuoteAmountIn:FEES,quoteAmountInWithLpFee:LP})),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('transfer',buyD()),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('buy',buyD({eventLayout:'FOO'})),/ADVISORY_TRADE_FEE_BINDING/);
});

test('v2 reconcile emits pumpswap-event-fee-exclusive-v2 with quoteTransferFeeAtomic across the three layouts', () => {
  const sdk=reconcileWindowQuote('buy',buyD(),true);
  assert.equal(sdk.method,'pumpswap-event-fee-exclusive-v2');
  assert.equal(sdk.quoteTransferFeeAtomic,null);
  const current=reconcileWindowQuote('buy',buyD({eventLayout:'CURRENT_APPENDIX',...holder0}),true);
  assert.equal(current.quoteTransferFeeAtomic,null);
  const taxed=reconcileWindowQuote('buy',buyD({eventLayout:'TRANSFER_FEE_APPENDIX',...holder0,quoteTransferFee:0n}),true);
  assert.equal(taxed.quoteTransferFeeAtomic,'0');
  assert.equal(taxed.coreQuoteAtomic,'10000');
});

test('v2 reconcile throws the typed unsupported error on a nonzero quote transfer fee', () => {
  assert.throws(()=>reconcileWindowQuote('buy',buyD({eventLayout:'TRANSFER_FEE_APPENDIX',...holder0,quoteTransferFee:7n}),true),/ADVISORY_TRADE_QUOTE_TRANSFER_FEE_UNSUPPORTED/);
});

test('v2 reconcile admits a holder reward only when it exactly duplicates the coin creator fee, never adding it', () => {
  const dup=reconcileWindowQuote('buy',buyD({eventLayout:'CURRENT_APPENDIX',holderRewardsBps:CCFBPS,holderRewards:CREATOR,creatorFeeUnclaimed:0n}),true);
  assert.equal(dup.holderRewardsAtomic,'25');
  assert.equal(dup.totalFeeAtomic,'175');
  assert.throws(()=>reconcileWindowQuote('buy',buyD({eventLayout:'CURRENT_APPENDIX',holderRewardsBps:CCFBPS,holderRewards:26n,creatorFeeUnclaimed:0n}),true),/ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(()=>reconcileWindowQuote('buy',buyD({eventLayout:'CURRENT_APPENDIX',holderRewardsBps:31n,holderRewards:CREATOR,creatorFeeUnclaimed:0n}),true),/ADVISORY_TRADE_FEE_BINDING/);
  const ordinary=reconcileWindowQuote('buy',buyD({eventLayout:'CURRENT_APPENDIX',...holder0}),true);
  assert.equal(ordinary.creatorFeeAtomic,'25');
  assert.equal(ordinary.holderRewardsAtomic,'0');
});

test('v2 reconcile never double-adds the buyback slice or the accrued creator_fee_unclaimed, and prices sell/exact cores', () => {
  const bb=reconcileWindowQuote('buy',buyD({eventLayout:'TRANSFER_FEE_APPENDIX',...holder0,quoteTransferFee:0n,buybackFee:40n}),true);
  assert.equal(bb.buybackFeeAtomic,'40');
  assert.equal(bb.protocolFeeAtomic,'50');
  assert.equal(bb.totalFeeAtomic,'175');
  const accrued=reconcileWindowQuote('buy',buyD({eventLayout:'TRANSFER_FEE_APPENDIX',holderRewardsBps:0n,holderRewards:0n,creatorFeeUnclaimed:999999n,quoteTransferFee:0n}),true);
  assert.equal(accrued.creatorFeeUnclaimedAtomic,'999999');
  assert.equal(accrued.totalFeeAtomic,'175');
  assert.equal(reconcileWindowQuote('sell',sellD({eventLayout:'TRANSFER_FEE_APPENDIX',...holder0,quoteTransferFee:0n}),true).coreQuoteAtomic,'10000');
  assert.equal(reconcileWindowQuote('buy_exact_quote_in',exactD({eventLayout:'TRANSFER_FEE_APPENDIX',...holder0,quoteTransferFee:0n}),true).grossQuoteAtomic,'10175');
});

test('end-to-end decode then reconcile: an untaxed v35 buy reconciles to v2, a taxed one is rejected', () => {
  const prefix=eventPrefix('buyEvent',buyFields);
  const clean=decodePinnedWindowEvent(payload(prefix,0n,0n,0n,0n),true,true)!;
  const quote=reconcileWindowQuote('buy',clean.data,true);
  assert.equal(quote.method,'pumpswap-event-fee-exclusive-v2');
  assert.equal(quote.coreQuoteAtomic,'10000');
  assert.equal(quote.quoteTransferFeeAtomic,'0');
  const taxed=decodePinnedWindowEvent(payload(prefix,0n,0n,0n,9n),true,true)!;
  assert.throws(()=>reconcileWindowQuote('buy',taxed.data,true),/ADVISORY_TRADE_QUOTE_TRANSFER_FEE_UNSUPPORTED/);
});

test('the v35 ABI constants are exported and the legacy constants are left exact', () => {
  assert.equal(PUMP_WINDOW_V35_ABI_SOURCE,'https://registry.npmjs.org/@pump-fun/pump-swap-sdk/-/pump-swap-sdk-2.2.0.tgz');
  assert.equal(PUMP_WINDOW_V35_ABI_HASH,'c2f8ce0bc0a740d9125644b2d95494c97199fce1604802f5ab0497184bdcce61');
  assert.equal(PUMP_WINDOW_ABI_SOURCE,'https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json');
  assert.equal(PUMP_WINDOW_ABI_HASH,'b7d8c57a4d9c4dd0109a9ab893052352333252d4eedced10ac091d4d66cab89b');
});
