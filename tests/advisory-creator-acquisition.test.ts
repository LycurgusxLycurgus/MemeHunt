import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconcileCreatorRoute} from '../src/providers/advisory-creator-route-ledger.js';
const f=JSON.parse(readFileSync('tests/fixtures/s15-native-quote-history.json','utf8')),
 a=JSON.parse(readFileSync('tests/fixtures/s15-quote-acquisition.json','utf8')),
 role:any={quality:'KNOWN',binding:f.binding,data:{},reasonCode:'PUBLIC_CREATOR_ROLE_BINDING_VERIFIED'},
 tx=JSON.parse(a.transaction.raw).result,h=JSON.parse(a.helius.raw)[0],
 account='9An4JPxzgRRxNDEN23MsP4w7r1kSwNYaYcwZvNRiTb3C';

test('actual preceding quote acquisition reconciles every native/token account and two executed swaps without a historical price estimate',()=>{
 const d=reconcileCreatorRoute(tx,h,role,f.account,null,account);
 assert.equal(d.side,'QUOTE_ACQUISITION');assert.equal(d.nativeAccountsReconciled,40);assert.equal(d.tokenAccountsReconciled,7);
 assert.equal(d.acquisition?.quoteAtomic,'4931006');assert.equal(d.acquisition?.inputSolLamports,'9670000000');
 assert.equal(d.acquisition?.capitalInLamports,'5670000000');assert.equal(d.acquisition?.temporaryRentReturnedLamports,'1488440');
 assert.equal(d.acquisition?.legs.length,2);assert.equal(d.walletNativeDeltaLamports,'-4002520000');
 assert.equal(d.acquisition?.legs[0]?.outputAtomic,d.acquisition?.legs[1]?.inputAtomic);
 assert.equal(d.settlement,null,'quote acquisition must never be labelled target sell proceeds');
 assert.throws(()=>reconcileCreatorRoute(tx,h,role,f.account,null),/CREATOR_ROUTE_/,'legacy close-only path must not acquire a new interpretation');
});

test('quote acquisition rejects provider/metadata/amount/wrapping changes instead of certifying a cost basis',()=>{
 const mutations:Array<(t:any,p:any)=>void>=[
  (_t,p)=>p.rawTransaction.meta.fee++,
  (_t,p)=>p.parsed.tokenTransfers[0].rawTokenAmount++,
  (_t,p)=>p.parsed.instructions.find((i:any)=>i.instructionName==='swap_v2').decoded.args.amount='1',
  (t,_p)=>t.meta.postTokenBalances.find((b:any)=>b.mint===f.binding.creation.quoteMint).uiTokenAmount.amount='0',
  (t,_p)=>t.meta.logMessages.pop(),
  (t,_p)=>t.meta.innerInstructions[0].instructions.find((i:any)=>i.parsed?.type==='syncNative').parsed.info.account=f.account,
 ];
 for(const mutate of mutations){const t=structuredClone(tx),p=structuredClone(h);mutate(t,p);assert.throws(()=>reconcileCreatorRoute(t,p,role,f.account,null,account));}
 assert.throws(()=>reconcileCreatorRoute(tx,h,role,f.account,null,f.account),/CREATOR_ROUTE_ACQUISITION_/);
});
