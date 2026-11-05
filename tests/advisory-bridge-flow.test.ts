import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveC12NativeBridgeFlow} from '../src/providers/advisory-bridge-flow.js';
import {decodeC12BridgeCapture,C12_CAPTURE_ID,type C12BridgeCapture} from '../src/providers/advisory-bridge-import.js';
const RAW=readFileSync('tests/fixtures/c12-all-assets-native-capture.json','utf8'),CUT='2026-11-01T13:00:00.000Z';
const derive=(raw=RAW)=>deriveC12NativeBridgeFlow(raw,CUT,[C12_CAPTURE_ID]);
function mutatePrice(edit:(raw:string)=>string){const c=JSON.parse(RAW) as C12BridgeCapture,r=c.records.find(r=>r.receipt.chain==='market')!;r.raw=edit(r.raw);r.receipt.response.bytes=Buffer.byteLength(r.raw);r.receipt.response.sha256=createHash('sha256').update(r.raw).digest('hex');return JSON.stringify(c);}
test('actual frozen complete population: eight transfers, six independently quoted assets, exact conserved two-direction totals',()=>{
 const m=derive();assert.equal(m.quality,'KNOWN',JSON.stringify(m));const d=m.data as any;
 assert.equal(d.completedTransfers,8);assert.equal(d.canonicalAssets,6);assert.equal(d.pending,null);
 const sol=d.chains.find((c:any)=>c.chain==='solana'),eth=d.chains.find((c:any)=>c.chain==='ethereum');
 // Independent stdlib Fraction oracle from original price lexemes and native unsigned bodies.
 assert.equal(sol.inflowReferenceUsd,'963.8128477921427407863979831');assert.equal(sol.outflowReferenceUsd,'1642.46668133867237012916669311');assert.equal(sol.netReferenceUsd,'-678.65383354652962934276871001');
 assert.equal(eth.netReferenceUsd,'678.65383354652962934276871001');assert.equal(eth.inflowReferenceUsd,sol.outflowReferenceUsd);
 assert.deepEqual(d.assets.map((a:any)=>a.mark.role),Array(6).fill('CANONICAL_ORIGIN_REFERENCE'));
 assert.equal(d.assets.flatMap((a:any)=>a.transfers).filter((t:any)=>t.normalizedFee===null).length,1);
});
test('price timestamp conflict poisons whole authoritative result rather than successful subset',()=>{
 const m=derive(mutatePrice(raw=>raw.replace('"prices":[{"timestamp":1793454784,"price":0.01470453017978976}]','"prices":[{"timestamp":1793454784,"price":0.01470453017978976},{"timestamp":1793454784,"price":0.02}]')));
 assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'C12_BRIDGE_PRICE_TIMESTAMP_CONFLICT');assert.equal((m.data as any).authoritativeReferenceUsd,null);
});
test('one unpriced actual canonical asset blocks the complete USD aggregate',()=>{
 const m=derive(mutatePrice(raw=>raw.replace('"prices":[{"timestamp":1793454784,"price":0.01470453017978976}]','"prices":[]')));assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'C12_BRIDGE_UNPRICED_CANONICAL_ASSET');
});
test('forward and stale marks cannot satisfy the fixed END reference',()=>{
 for(const timestamp of [1793455201,1793454299]){const m=derive(mutatePrice(raw=>raw.replaceAll('1793454784',String(timestamp))));assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'C12_BRIDGE_UNPRICED_CANONICAL_ASSET');}
});
test('exact finite scientific price range preserves tiny and huge assets without fixed precision loss',()=>{
 const m=derive(mutatePrice(raw=>raw.replace('0.01470453017978976','1e100').replace('0.053574596718131785','1e-100')));assert.equal(m.quality,'KNOWN',JSON.stringify(m));
 const assets=(m.data as any).assets,small=assets.find((a:any)=>a.canonicalAssetId.endsWith('0001a500a6b18995b03f44bb040a5ffc28e45cb0'));
 const nonzero=small.chains.find((c:any)=>c.outflowAtomic!=='0');assert.match(nonzero.outflowReferenceUsd,/^0\.0{90,}[1-9]/);assert.ok(!(m.data as any).chains[0].outflowReferenceUsd.includes('e'));
});
test('quote decimals and pre-policy request mutation cannot supply valuation authority',()=>{
 assert.equal(derive(mutatePrice(raw=>raw.replace('"decimals":18','"decimals":6'))).reasonCode,'C12_BRIDGE_PRICE_DECIMALS');
 const c=JSON.parse(RAW);c.valuationPolicy.frozenAt='2026-10-31T23:00:00.000Z';assert.equal(derive(JSON.stringify(c)).reasonCode,'C12_BRIDGE_PRICE_BEFORE_POLICY');
});
test('raw body mutation without matching original receipt hash is rejected',()=>{
 const c=JSON.parse(RAW);c.records[0].raw+=' ';assert.throws(()=>decodeC12BridgeCapture(JSON.stringify(c),CUT),/RAW_HASH_OR_PATH/);assert.equal(derive(JSON.stringify(c)).quality,'MISSING');
});

// Constructed repeat observations of actual account batches, not new native evidence.
// Preserve original u64 number lexemes when mutating a copy (rentEpoch exceeds 2^53).
function duplicateAccounts(label:string,edit:(json:any,row:C12BridgeCapture['records'][number])=>void,earlier=true):string{
 const c=JSON.parse(RAW) as C12BridgeCapture,original=c.records.find(r=>r.id===label)!;
 const row=structuredClone(original);row.id='constructed-repeat-'+label;row.receipt.label=row.id;row.receipt.response.file=`raw/${row.id}.json`;
 const offset=earlier?-3000:3000;row.receipt.startedAt=new Date(Date.parse(original.receipt.startedAt)+offset).toISOString();row.receipt.finishedAt=new Date(Date.parse(original.receipt.finishedAt)+offset).toISOString();
 const json=(JSON.parse as any)(row.raw,(_key:string,value:unknown,context?:{source?:string})=>typeof value==='number'&&!Number.isSafeInteger(value)?(JSON as any).rawJSON(context!.source):value);
 edit(json,row);row.raw=JSON.stringify(json);row.receipt.response.bytes=Buffer.byteLength(row.raw);row.receipt.response.sha256=createHash('sha256').update(row.raw).digest('hex');
 c.records.unshift(row);return JSON.stringify(c);
}
const missingAllUsd=(raw:string)=>{const m=derive(raw);assert.equal(m.quality,'MISSING',JSON.stringify(m));assert.equal((m.data as any).authoritativeReferenceUsd,null);assert.equal((m.data as any).chains,null);return m;};
const bank='sol-c12-discovered-accounts-batch-1';
const item=(json:any,kind:'vaa'|'msg'|'meta'|'mint')=>json.result.value.findIndex((a:any)=>{if(a===null)return false;const b=Buffer.from(a.data[0],'base64');return kind==='meta'?b.length===35:kind==='mint'?b.length===82:b.subarray(0,3).toString()===kind;});
function changeData(json:any,index:number,edit:(bytes:Buffer)=>void){assert.ok(index>=0);const a=json.result.value[index],bytes=Buffer.from(a.data[0],'base64');edit(bytes);a.data[0]=bytes.toString('base64');}

test('earlier same-bank account byte/owner/executable/null contradictions poison public USD totals',()=>{
 for(const change of [
  (j:any)=>changeData(j,item(j,'vaa'),b=>{b[95]^=1;}),
  (j:any)=>{j.result.value[item(j,'vaa')].owner='11111111111111111111111111111111';},
  (j:any)=>{j.result.value[item(j,'vaa')].executable=true;},
  (j:any)=>{j.result.value[item(j,'vaa')]=null;},
  (j:any)=>{j.result.value[item(j,'mint')].lamports+=1;},
 ])missingAllUsd(duplicateAccounts(bank,change));
 // The same conflict must poison the result even when the bad observation is later.
 missingAllUsd(duplicateAccounts(bank,j=>{j.result.value[item(j,'vaa')]=null;},false));
});
test('every retained account observation validates encoding/base64/finalized context, not only the chosen read',()=>{
 missingAllUsd(duplicateAccounts(bank,j=>{j.result.value[item(j,'vaa')].data[1]='base64+zstd';}));
 missingAllUsd(duplicateAccounts(bank,j=>{j.result.value[item(j,'vaa')].data[0]+='!';}));
 missingAllUsd(duplicateAccounts(bank,(_j,row)=>{(row.receipt.request as {params:any[]}).params[1].commitment='confirmed';}));
 missingAllUsd(duplicateAccounts(bank,j=>{j.result.context.slot=1;}));
 // Adjacent native u64 values would round to the same JS Number; still a bank conflict.
 missingAllUsd(duplicateAccounts(bank,j=>{j.result.value[item(j,'vaa')].rentEpoch=(JSON as any).rawJSON('18446744073709551614');}));
});
test('cross-bank immutable PostedVAA/reliable-message/WrappedMeta bytes cannot be repaired by a favorable later read',()=>{
 for(const [label,kind,offset]of [[bank,'vaa',95],['sol-source-reliable-messages','msg',95],[bank,'meta',34]] as const){
  const raw=duplicateAccounts(label,j=>{j.result.context.slot-=1;changeData(j,item(j,kind),b=>{b[offset]^=1;});});
  assert.match(missingAllUsd(raw).reasonCode,/IMMUTABLE_ACCOUNT_CONFLICT/);
 }
});
test('identical same-bank and cross-bank repeated account witnesses preserve exact complete result',()=>{
 for(const edit of [()=>{},(j:any)=>{j.result.context.slot+=1;}]){
  const result=derive(duplicateAccounts(bank,edit));assert.equal(result.quality,'KNOWN',JSON.stringify(result));assert.deepEqual(result,derive());
 }
});
test('legitimate cross-bank mint supply/lamports and ProgramData live-field changes preserve the complete native flow',()=>{
 const mint=duplicateAccounts(bank,j=>{j.result.context.slot+=1;const i=item(j,'mint');changeData(j,i,b=>{b.writeBigUInt64LE(b.readBigUInt64LE(36)+1n,36);});j.result.value[i].lamports+=1;},false);
 assert.deepEqual(derive(mint),derive());
 const program=duplicateAccounts('sol-wtt-core-programdata-headers',j=>{j.result.context.slot+=1;changeData(j,0,b=>{b[13]^=1;});j.result.value[0].lamports+=1;},false);
 assert.deepEqual(derive(program),derive());
 // Immutable proof data may have changed rent balance across banks without a body change.
 const rent=duplicateAccounts(bank,j=>{j.result.context.slot+=1;j.result.value[item(j,'vaa')].lamports+=1;},false);
 assert.deepEqual(derive(rent),derive());
});
