import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeCreatorQuoteTrade,decodeCreatorQuoteAccounting} from '../src/providers/advisory-creator-quote.js';
import {decodeCreatorCoverage,collectCreatorCoverage} from '../src/providers/advisory-creator-coverage.js';
import {archiveDemandReceipt} from '../src/providers/advisory-demand-windows.js';
import {creatorRoleTransactionRequest} from '../src/providers/advisory-creator-role.js';
import {walletTouch} from '../src/providers/advisory-creator-inventory.js';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
const f=JSON.parse(readFileSync('tests/fixtures/s15-native-quote-history.json','utf8')),token=f.token,role:any={quality:'KNOWN',binding:f.binding},cutoff='2026-10-19T19:00:00.000Z',slot=JSON.parse(f.raw.head).result.context.slot;
const buy=()=>JSON.parse(f.raw['tx-'+f.binding.creation.signature]).result;
const env=(result:any)=>JSON.stringify({jsonrpc:'2.0',id:1,result});
function packet(){
 const rows=JSON.parse(f.raw.index).result,r:any={requests:{genesis:{method:'getGenesisHash',params:[]},head:{method:'getSlot',params:[{commitment:'finalized'}]},catalog:{method:'getTokenAccountsByOwner',params:[f.binding.wallet,{mint:token.address},{encoding:'jsonParsed',commitment:'finalized',minContextSlot:slot}]},'page-0':{method:'getSignaturesForAddress',params:[f.binding.wallet,{limit:1000,commitment:'finalized',minContextSlot:slot}]}},rawArtifacts:{genesis:env(SOLANA_MAINNET_GENESIS),head:env(slot),catalog:env({context:{slot},value:[]}),'page-0':env(rows)},retrievedAt:{}};
 for(const row of rows){const id='transaction-'+row.signature;r.requests[id]=creatorRoleTransactionRequest(row.signature);r.rawArtifacts[id]=archiveDemandReceipt(f.raw['tx-'+row.signature]);}
 for(const id of Object.keys(r.requests))r.retrievedAt[id]=cutoff;return r;
}
const decode=(r=packet())=>decodeCreatorCoverage(token,role,f.account,r,cutoff);
test('actual truncated buy uses positive committed transfers without replacing logs; proof29 behavior remains strict',()=>{
 const tx=buy(),before=structuredClone(tx),entry=decodeCreatorQuoteTrade(tx,role,true);assert.equal(entry.execution,'POSITIVE_COMMITTED_TRANSFER_BALANCES_WITH_BOUND_TRUNCATED_TRACE');assert.equal(entry.quote.userAtomic,'2040452');assert.equal(entry.base.unitsAtomic,'123909950351188');assert.equal(entry.quote.transactionNetAtomic,'-4931006');assert.deepEqual(tx,before);assert.throws(()=>decodeCreatorQuoteTrade(tx,role),/LOG_INCOMPLETE/);
});
test('caught/rolled-back legs, destination round trips, malformed prefix and missing metadata never recover the buy',()=>{
 const mutations:Array<(x:any)=>void>=[
  x=>{const b=x.meta.postTokenBalances.find((b:any)=>x.transaction.message.accountKeys[b.accountIndex].pubkey===f.account);b.uiTokenAmount.amount='0';},
  x=>{x.meta.logMessages[x.meta.logMessages.length-2]='Program 11111111111111111111111111111111 failed: caught';},
  x=>{x.meta.logMessages.splice(0,1);},
  x=>{const group=x.meta.innerInstructions.find((g:any)=>g.index===3),transfer=group.instructions.find((i:any)=>i.parsed?.type==='transferChecked');group.instructions.push({...transfer,parsed:{type:'transferChecked',info:{...transfer.parsed.info,source:transfer.parsed.info.destination,destination:transfer.parsed.info.source}}});},
  x=>{x.meta.postTokenBalances.find((b:any)=>x.transaction.message.accountKeys[b.accountIndex].pubkey===f.account).programId=token.address;},
  x=>{x.meta.err={InstructionError:[3,'Custom']};},
  x=>{delete x.meta.innerInstructions[0].instructions.find((i:any)=>i.parsed?.type==='mintTo').parsed.info.account;},
  x=>{x.meta.innerInstructions.find((g:any)=>g.index===3).instructions.push({programId:f.binding.creation.tokenProgram,stackHeight:3,parsed:{type:'unknownAccountAmountWriter',info:{tokenAccount:f.account}}});},
 ];
 for(const mutate of mutations){const tx=buy();mutate(tx);assert.throws(()=>decodeCreatorQuoteTrade(tx,role,true));}
});
test('constructed complete wallet corpus over actual seven receipts excludes other accounts without asserting unlogged execution',()=>{
 const d=decode();assert.equal(d.indexedRows,7);assert.equal(d.successfulInspected,7);assert.equal(d.wholeWalletComplete,true);assert.equal(d.failedFees.payerCensusComplete,true);assert.equal(d.failedFees.creatorChargedLamports,'0');assert.equal(d.targetSignatures.length,7);
 const r=packet(),id='transaction-'+f.binding.creation.signature;delete r.requests[id];delete r.rawArtifacts[id];delete r.retrievedAt[id];const m=decode(r);assert.equal(m.wholeWalletComplete,false);assert.equal(m.sourceReceipts,6);assert.match(m.unresolved[0]!.code,/NOT_COLLECTED/);
});
test('coverage rejects forged clocks/requests/archive/catalog/orphans and never certifies an unresolved critical form',()=>{
 const request=packet();request.requests['page-0'].params[1].minContextSlot++;assert.throws(()=>decode(request),/COVERAGE_RECEIPT/);
 const clock=packet();clock.retrievedAt.head='2026-10-19T19:00:00.001Z';assert.throws(()=>decode(clock),/COVERAGE_RECEIPT/);
 const raw=packet(),id='transaction-'+f.binding.creation.signature;raw.rawArtifacts[id]=JSON.stringify({...JSON.parse(raw.rawArtifacts[id]),sourceHash:'0'.repeat(64)});assert.throws(()=>decode(raw),/COVERAGE_RECEIPT/);
 const extra=packet();extra.requests.orphan=extra.requests.genesis;extra.rawArtifacts.orphan=extra.rawArtifacts.genesis;extra.retrievedAt.orphan=cutoff;assert.throws(()=>decode(extra),/COVERAGE_RECEIPT/);
 const form=packet(),tx=buy();tx.meta.innerInstructions[0].instructions.find((i:any)=>i.parsed?.type==='mintTo').parsed.type='unrecognized';form.rawArtifacts[id]=archiveDemandReceipt(env(tx));const out=decode(form);assert.equal(out.wholeWalletComplete,false);assert.ok(out.unresolved.some(x=>x.code==='CREATOR_WALLET_TOKEN_FORM_UNRESOLVED'));
});
test('complete wallet collector preserves same-run raw clocks, bounds concurrency and retains rate-limit gaps',async()=>{
 const p=packet();let active=0,max=0,calls=0;const fetcher:typeof fetch=async(_input,init)=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,450));try{const req=JSON.parse(String(init?.body)),id=Object.keys(p.requests).find(k=>JSON.stringify(p.requests[k])===JSON.stringify({method:req.method,params:req.params}));return new Response(id?.startsWith('transaction-')?f.raw['tx-'+req.params[0]]:p.rawArtifacts[id!]);}finally{active--;}};
 const prior:any={requests:{},rawArtifacts:{},retrievedAt:{}},r=await collectCreatorCoverage(token,role,f.account,prior,'https://rpc.example',fetcher,()=>cutoff);assert.equal(calls,11);assert.equal(max,2);assert.equal(decode(r).wholeWalletComplete,true);
 const fail=await collectCreatorCoverage(token,role,f.account,prior,'https://rpc.example',async()=>new Response('{}',{status:429}),()=>cutoff);assert.equal(decode(fail).wholeWalletComplete,false);assert.equal(Object.keys(fail.requests).length,1);
});
test('failed payer census stays distinct from unproved target allocation and incomplete receipts',()=>{
 const r=packet(),signature=createHash('sha512').update('native-failed-row').digest(),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+signature.toString('hex')),sig='';while(n){sig=alphabet[Number(n%58n)]+sig;n/=58n;}
 const row={signature:sig,slot:slot-1,blockTime:Date.parse(cutoff)/1000-100,err:{InstructionError:[0,'Custom']},confirmationStatus:'finalized'},index=JSON.parse(r.rawArtifacts['page-0']);index.result.unshift(row);r.rawArtifacts['page-0']=JSON.stringify(index);
 const id='transaction-'+sig,keys=[{pubkey:f.binding.wallet,source:'transaction',signer:true,writable:true}];r.requests[id]={method:'getTransaction',params:[sig,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]};r.retrievedAt[id]=cutoff;r.rawArtifacts[id]=archiveDemandReceipt(env({slot:row.slot,blockTime:row.blockTime,version:0,transaction:{signatures:[sig],message:{accountKeys:keys,instructions:[]}},meta:{err:row.err,status:{Err:row.err},fee:5000,preBalances:[10000],postBalances:[5000],preTokenBalances:[],postTokenBalances:[]}}));
 const d=decode(r);assert.equal(d.failedFees.payerCensusComplete,true);assert.equal(d.failedFees.creatorChargedLamports,'5000');assert.equal(d.failedFees.targetAssociatedCoverageComplete,false);assert.equal(d.failedFees.targetAssociatedChargedLamports,null);
 r.rawArtifacts[id]=archiveDemandReceipt(env(null));assert.equal(decode(r).failedFees.payerCensusComplete,false);assert.equal(decode(r).failedFees.creatorChargedLamports,null);
});

test('archived immutable receipt reuse preserves original clocks and never reuses mutable head/catalog/index',async()=>{
 const p=packet(),original='2026-10-19T18:00:00.000Z';for(const id of Object.keys(p.retrievedAt))p.retrievedAt[id]=original;
 const calls:string[]=[],fetcher:typeof fetch=async(_input,init)=>{const req=JSON.parse(String(init?.body));calls.push(req.method);const id=Object.keys(p.requests).find(k=>JSON.stringify(p.requests[k])===JSON.stringify({method:req.method,params:req.params}));assert.ok(id);return new Response(p.rawArtifacts[id]);};
 const r=await collectCreatorCoverage(token,role,f.account,p,'https://rpc.example',fetcher,()=>cutoff);assert.deepEqual(calls,['getGenesisHash','getSlot','getTokenAccountsByOwner','getSignaturesForAddress']);
 assert.equal(r.retrievedAt.head,cutoff);assert.equal(r.retrievedAt['transaction-'+f.binding.creation.signature],original);assert.equal(decode(r).wholeWalletComplete,true);
});

test('attempted-superset exclusion still binds every visible runtime prefix and rejects a dropped critical instruction',()=>{
 const p=packet(),tx=buy();tx.meta.innerInstructions[0].instructions.shift();p.rawArtifacts['transaction-'+f.binding.creation.signature]=archiveDemandReceipt(env(tx));const d=decode(p);assert.equal(d.wholeWalletComplete,false);assert.ok(d.unresolved.some(x=>x.code==='CREATOR_WALLET_RUNTIME_TRACE_UNRESOLVED'));
});

test('actual sparse post-truncation logs and foreign transfer-fee initialization admit exclusion without executing unlogged calls',()=>{
 const evidence=JSON.parse(readFileSync('tests/fixtures/s15-creator-exclusion-history.json','utf8')),transactions=Object.values(evidence.receipts).map((r:any)=>JSON.parse(r.raw).result);
 assert.equal(transactions.length,2);for(const tx of transactions)assert.equal(walletTouch(tx,{wallet:f.binding.wallet,mint:token.address,creationSlot:f.binding.creation.slot,creationSignature:f.binding.creation.signature},f.account,true),null);
 const foreign=transactions.find((x:any)=>x.meta.innerInstructions.some((g:any)=>g.instructions.some((i:any)=>i.parsed?.type==='initializeTransferFeeConfig'))),ix=foreign.meta.innerInstructions.flatMap((g:any)=>g.instructions).find((i:any)=>i.parsed?.type==='initializeTransferFeeConfig');ix.parsed.info.mint=token.address;foreign.transaction.message.accountKeys.push({pubkey:token.address,writable:true,signer:false,source:'transaction'});foreign.meta.preBalances.push(0);foreign.meta.postBalances.push(0);assert.equal(walletTouch(foreign,{wallet:f.binding.wallet,mint:token.address,creationSlot:f.binding.creation.slot,creationSignature:f.binding.creation.signature},f.account,true),'CREATOR_WALLET_TARGET_EXTENSION_UNRESOLVED');
});

test('recovered native ledger proves chronological canonical continuity and rejects a zero-close that hides token movement',()=>{
 const r:any={rawArtifacts:{genesis:env(SOLANA_MAINNET_GENESIS),head:f.raw.head,index:f.raw.index},requests:{genesis:{method:'getGenesisHash',params:[]},head:f.requests.head,index:{method:'getSignaturesForAddress',params:[f.account,{limit:1000,commitment:'finalized',minContextSlot:slot}]}},retrievedAt:{genesis:cutoff,head:cutoff,index:cutoff}},rows=JSON.parse(f.raw.index).result;
 for(const [i,row]of rows.entries()){r.requests['transaction-'+i]=creatorRoleTransactionRequest(row.signature);r.rawArtifacts['transaction-'+i]=f.raw['tx-'+row.signature];r.retrievedAt['transaction-'+i]=cutoff;}
 const d=decodeCreatorQuoteAccounting(token,role,r,cutoff,true);assert.equal(d.canonicalContinuity!.complete,true);assert.equal(d.coverage.unresolved.length,0);assert.equal(d.assets[0]!.entryAtomic,'2040452');
 const gap=structuredClone(r),remaining=rows.filter((_x:any,i:number)=>i!==2);gap.rawArtifacts.index=env(remaining);for(const k of Object.keys(gap.requests).filter(k=>k.startsWith('transaction-'))){delete gap.requests[k];delete gap.rawArtifacts[k];delete gap.retrievedAt[k];}for(const [i,row]of remaining.entries()){gap.requests['transaction-'+i]=creatorRoleTransactionRequest(row.signature);gap.rawArtifacts['transaction-'+i]=f.raw['tx-'+row.signature];gap.retrievedAt['transaction-'+i]=cutoff;}assert.equal(decodeCreatorQuoteAccounting(token,role,gap,cutoff,true).canonicalContinuity!.complete,false);
 const altered=structuredClone(r),body=JSON.parse(altered.rawArtifacts['transaction-0']),close=body.result.transaction.message.instructions.find((i:any)=>i.parsed?.type==='closeAccount');body.result.transaction.message.instructions.push({...close,parsed:{type:'approve',info:{source:f.account,owner:f.binding.wallet,delegate:token.address,amount:'0'}}});body.result.meta.logMessages.push(`Program ${close.programId} invoke [1]`,`Program ${close.programId} success`);altered.rawArtifacts['transaction-0']=env(body.result);const out=decodeCreatorQuoteAccounting(token,role,altered,cutoff,true);assert.equal(out.canonicalContinuity!.complete,false);assert.ok(out.coverage.unresolved.length>0);
});

test('a later canonical inflow cannot be hidden by a creator-wallet index that never references the recipient owner',()=>{
 const p=packet();p.rawArtifacts.catalog=env({context:{slot},value:[{pubkey:f.account,account:{owner:f.binding.creation.tokenProgram,data:{parsed:{info:{mint:token.address,owner:f.binding.wallet,tokenAmount:{amount:'1'}}}}}}]});
 const d=decodeCreatorCoverage(token,role,f.account,p,cutoff,[],{slot,amountAtomic:'0'});assert.equal(d.sourceComplete,true);assert.equal(d.canonicalCatalogAtomic,'1');assert.equal(d.wholeWalletComplete,false);assert.ok(d.unresolved.some(x=>x.code==='CREATOR_COVERAGE_CANONICAL_HEAD_MISMATCH'));
});


test('proof32 catalog minimum-context lag retries the identical finalized request twice; proof31 retains original behavior',async()=>{
 const p=packet();let catalogs=0;const fetcher:typeof fetch=async(_input,init)=>{const req=JSON.parse(String(init?.body)),request={method:req.method,params:req.params},id=Object.keys(p.requests).find(k=>JSON.stringify(p.requests[k])===JSON.stringify(request));assert.ok(id);if(id==='catalog'&&++catalogs<3)return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32016,message:'Minimum context slot has not been reached'}}));return new Response(p.rawArtifacts[id!]);};
 const r=await collectCreatorCoverage(token,role,f.account,p,'https://rpc.example',fetcher,()=>cutoff,undefined,true);assert.equal(catalogs,3);assert.equal(decodeCreatorCoverage(token,role,f.account,r,cutoff,[],undefined,true).wholeWalletComplete,true);assert.deepEqual(r.requests.catalog,p.requests.catalog);
 catalogs=0;const old=await collectCreatorCoverage(token,role,f.account,p,'https://rpc.example',fetcher,()=>cutoff);assert.equal(catalogs,1);assert.equal(decode(old).catalogComplete,false);
});
