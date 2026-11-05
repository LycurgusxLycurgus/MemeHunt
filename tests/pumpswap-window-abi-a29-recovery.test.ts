import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
const partial=(a:any,e:any)=>{for(const k of Object.keys(e))assert.deepEqual(a[k],e[k]);};
import { reconcileWindowQuote } from '../src/providers/pumpswap-window-abi.js';

const creator={toBase58:()=>'2aHg1PaiGhqFJbSNxocTqWn2CC5rdt1oo3VDu6HiVs1R'};
const noCreator={toBase58:()=>'11111111111111111111111111111111'};
// a29-transaction-720 BuyEvent fields (retained receipt).
const e720=()=>({quoteAmountIn:'6196',maxQuoteAmountIn:'6196',userQuoteAmountIn:'6000',quoteAmountInWithLpFee:'6012',lpFeeBasisPoints:'20',lpFee:'12',protocolFeeBasisPoints:'5',protocolFee:'3',coinCreatorFeeBasisPoints:'300',coinCreatorFee:'180',coinCreator:creator as any,ixName:'buy_exact_quote_in_v2',cashbackFeeBasisPoints:'0',cashback:'0',buybackFeeBasisPoints:'5000',buybackFee:'1',eventLayout:'TRANSFER_FEE_APPENDIX',holderRewardsBps:'300',holderRewards:'180',creatorFeeUnclaimed:'283399',quoteTransferFee:'0'} as Record<string,any>);
// a29-transaction-547 selected BuyEvent (remainder 0, legacy exact-in).
const e547=()=>({...e720(),quoteAmountIn:'25292',maxQuoteAmountIn:'25292',userQuoteAmountIn:'24495',quoteAmountInWithLpFee:'24544',lpFee:'49',protocolFee:'13',coinCreatorFee:'735',holderRewards:'735',buybackFee:'6',creatorFeeUnclaimed:'24200',ixName:'buy_exact_quote_in'});
const code=(f:()=>unknown)=>{try{f();return 'OK';}catch(e){return (e as Error).message;}};

describe('a29 recovery fee-exclusive-v4', () => {
 it('books the exact budget remainder', () => {
  const q=reconcileWindowQuote('buy_exact_quote_in_v2',e720(),true,true,undefined,true);
  partial(q,{method:'pumpswap-event-fee-exclusive-v4',basis:'EXACT_QUOTE_BUY_GROSS',coreQuoteAtomic:'6000',bookedQuoteAtomic:'6195',walletQuoteAtomic:'6195',budgetAtomic:'6196',budgetRemainderAtomic:'1',totalFeeAtomic:'195',transferWitness:'NONE'});
  const z=reconcileWindowQuote('buy_exact_quote_in',e547(),true,true,undefined,true);
  assert.deepEqual(z,reconcileWindowQuote('buy_exact_quote_in',e547(),true,true));
 });
 it('keeps old default paths unchanged', () => {
  assert.equal(code(()=>reconcileWindowQuote('buy_exact_quote_in_v2',e720(),true,true)),'ADVISORY_TRADE_FEE_BINDING');
  assert.equal(code(()=>reconcileWindowQuote('buy_exact_quote_in_v2',e720(),true)),'ADVISORY_TRADE_FEE_BINDING');
  assert.equal(code(()=>reconcileWindowQuote('buy_exact_quote_in_v2',e720())),'ADVISORY_TRADE_FEE_BINDING');
  assert.equal(code(()=>reconcileWindowQuote('buy_exact_quote_in_v2',e720(),true,false,undefined,true)),'ADVISORY_TRADE_FEE_BINDING');
 });
 it('fails closed on every mutation', () => {
  const bad:Array<Record<string,any>>=[{userQuoteAmountIn:'6001'},{userQuoteAmountIn:'5999',quoteAmountInWithLpFee:'6011'},{lpFee:'13'},{protocolFee:'4'},{coinCreatorFee:'181',holderRewards:'181'},{maxQuoteAmountIn:'6197'},{quoteAmountIn:'6194'},{cashback:'1'},{cashbackFeeBasisPoints:'1'},{coinCreator:noCreator},{quoteAmountInWithLpFee:'6013'},{buybackFee:'4'}];
  // A mutation that leaves quote===user+fees is an ordinary zero-remainder exact-in: the narrowed gate returns the exact old object, never v4.
  for(const m of bad){const d={...e720(),...m};if(code(()=>reconcileWindowQuote('buy_exact_quote_in_v2',d,true,true,undefined,true))==='OK'){const q=reconcileWindowQuote('buy_exact_quote_in_v2',d,true,true,undefined,true);assert.notEqual(q.method,'pumpswap-event-fee-exclusive-v4');assert.deepEqual(q,reconcileWindowQuote('buy_exact_quote_in_v2',d,true,true));}}
 });
 it('never routes a taxed exact-in through v4', () => {
  const r=code(()=>reconcileWindowQuote('buy_exact_quote_in_v2',{...e720(),quoteTransferFee:'1'},true,true,undefined,true));
  if(r==='OK')assert.notEqual(reconcileWindowQuote('buy_exact_quote_in_v2',{...e720(),quoteTransferFee:'1'},true,true,undefined,true).method,'pumpswap-event-fee-exclusive-v4');
 });
});
