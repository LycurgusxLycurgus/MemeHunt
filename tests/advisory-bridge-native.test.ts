import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {bridgeKeccak,decodeSignedVaa,decodeWttTransferPayload,reconstructC12NativeTransfers,NativeBridgeError} from '../src/providers/advisory-bridge-native.js';
import type {C12BridgeCapture} from '../src/providers/advisory-bridge-import.js';
const fixture=():C12BridgeCapture=>JSON.parse(readFileSync(new URL('../../tests/fixtures/c12-all-assets-native-capture.json',import.meta.url),'utf8'));
const edit=(c:C12BridgeCapture,id:string,fn:(v:any)=>void)=>{const row=c.records.find(r=>r.id===id)!;assert.ok(row,id);const json=(JSON.parse as any)(row.raw,(_key:string,value:unknown,context?:{source?:string})=>typeof value==='number'&&!Number.isSafeInteger(value)?(JSON as any).rawJSON(context!.source):value);fn(json);row.raw=JSON.stringify(json);row.receipt.response.bytes=Buffer.byteLength(row.raw);row.receipt.response.sha256=createHash('sha256').update(row.raw).digest('hex');};
const reject=(c:C12BridgeCapture,code?:RegExp)=>assert.throws(()=>reconstructC12NativeTransfers(c),code??NativeBridgeError);
const strip=(c:C12BridgeCapture,pattern:RegExp)=>{c.records=c.records.filter(r=>!pattern.test(r.id));};

test('Keccak is Ethereum Keccak rather than SHA3; payload byte/fee/layout guards are exact',()=>{
 assert.equal(bridgeKeccak(Buffer.alloc(0)).toString('hex'),'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');assert.equal(bridgeKeccak(Buffer.from('abc')).toString('hex'),'4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
 const p=Buffer.alloc(133);p[0]=1;p[32]=5;p[132]=2;assert.equal(decodeWttTransferPayload(p).amount,'5');assert.equal(decodeWttTransferPayload(p).fee,'2');p[132]=6;assert.throws(()=>decodeWttTransferPayload(p),/FEE_BOUND/);p[0]=3;assert.equal(decodeWttTransferPayload(p).fee,null);assert.throws(()=>decodeWttTransferPayload(p.subarray(0,132)),/TRANSFER_PAYLOAD/);p[0]=1;assert.throws(()=>decodeWttTransferPayload(Buffer.concat([p,Buffer.from([0])])),/TRANSFER_PAYLOAD/);
 assert.throws(()=>decodeSignedVaa(Buffer.alloc(5)),/SIGNED_VAA_VERSION/);const signed=Buffer.alloc(6);signed[0]=1;signed[5]=1;assert.throws(()=>decodeSignedVaa(signed),/SIGNED_VAA_BOUND/);
});

test('genuine complete all-assets capture reconstructs both directions and every original source body',()=>{
 const c=fixture(),before=JSON.stringify(c),r=reconstructC12NativeTransfers(c);assert.deepEqual(r.scope,{start:1793451600,end:1793455200});assert.equal(r.transfers.length,8);assert.equal(new Set(r.transfers.map(t=>t.canonicalAssetId)).size,6);assert.equal(r.transfers.filter(t=>t.destinationChain===1).length,2);assert.equal(r.transfers.filter(t=>t.destinationChain===2).length,6);assert.deepEqual(r.coverage,{ethereumEvents:6,solReferences:17,solCompletions:9,outsidePair:7,nonCompletionTransactions:8,ethereumChunks:3,solanaPages:1});
 for(const t of r.transfers){assert.equal(t.originChain,2);assert.equal(t.originalDecimals,18);assert.equal(t.representationDecimals,8);assert.match(t.bodyKeccak,/^[0-9a-f]{64}$/);assert.notEqual(t.bodyKeccak,t.vmDoubleKeccak);assert.ok(t.sourceNativeTime<=t.destinationNativeTime);assert.ok(t.sourceMessageTime<=t.destinationNativeTime);assert.match(t.canonicalAssetId,/^ethereum:0x[0-9a-f]{40}$/);}
 assert.equal(r.transfers.filter(t=>t.payloadType===3).length,1);assert.equal(r.transfers.find(t=>t.payloadType===3)!.normalizedFee,null);assert.equal(r.transfers.find(t=>t.payloadType===3)!.recipientNormalizedAmount,null);assert.equal(JSON.stringify(c),before);
});

test('constructed missing census chunks, scope narrowing, strict prestart and raw tampering fail closed',()=>{
 let c=fixture();strip(c,/eth-redemptions-26313030/);reject(c,/EVENT_INDEX_GAP/);
 c=fixture();c.scopeManifest.assets='PRICED_ONLY';reject(c,/SCOPE_STATIC/);
 c=fixture();edit(c,'sol-program-index-0',v=>{v.result=v.result.filter((x:any)=>x.blockTime>=1793451600);});reject(c,/SOL_PRESTART_BOUNDARY/);
 c=fixture();c.records.find(r=>r.id==='anchor-sol-slot')!.raw+=' ';reject(c,/RAW_HASH/);
 c=fixture();edit(c,'anchor-sol-slot',v=>{v.id=999999;});reject(c,/RPC_ID/);
});

test('original rate failures require exact matching successful recovery; omitted body cannot become zero',()=>{
 const c=fixture(),recovered=c.records.find(r=>r.id.startsWith('sol-tx-')&&r.id.endsWith('-retry-1'))!;assert.ok(recovered);c.records=c.records.filter(r=>r.id!==recovered.id);reject(c,/MISSING_solana_getTransaction/);
 const d=fixture(),retry=d.records.find(r=>r.id.startsWith('sol-tx-')&&r.id.endsWith('-retry-1'))!;(retry.receipt.request as any).params[0]='altered';reject(d,/RETRY_BINDING/);
});

test('wrapper embedded VAA alone and current true-only state do not establish committed exact body',()=>{
 let c=fixture();strip(c,/eth-wrapper-completed-before/);reject(c,/MISSING_ethereum_eth_call/);
 c=fixture();const id=c.records.find(r=>r.id.startsWith('eth-wrapper-completed-before'))!.id;edit(c,id,v=>{v.result='0x'+'0'.repeat(63)+'1';});reject(c,/WRAPPER_FALSE_TO_TRUE/);
 c=fixture();const at=c.records.find(r=>r.id.startsWith('eth-wrapper-completed-at'))!;(at.receipt.request as any).params[0].data=(at.receipt.request as any).params[0].data.slice(0,-2)+'00';reject(c,/MISSING_ethereum_eth_call/);
});

test('source native publication, reliable message and canonical block membership are mandatory',()=>{
 let c=fixture();strip(c,/sol-source-reliable-messages/);reject(c,/MISSING_ACCOUNT/);
 c=fixture();const id=c.records.find(r=>r.id.startsWith('source-eth-receipt-'))!.id;edit(c,id,v=>{v.result.logs=[];});reject(c,/UNIQUE_ETH_SOURCE_PUBLICATION/);
 c=fixture();edit(c,'source-sol-block-463701531',v=>{v.result.signatures=[];});reject(c,/CONFLICT_getBlock|SOL_BLOCK_MEMBERSHIP/);
 // originalDecimals17 still normalizes to8, so use7 to contradict the actual initialized8-decimal mint.
 c=fixture();const account=c.records.find(r=>r.id==='sol-c12-discovered-accounts-batch-1')!;const j=JSON.parse(account.raw);const at=j.result.value.findIndex((x:any)=>Buffer.from(x.data[0],'base64').length===35);edit(c,account.id,v=>{const b=Buffer.from(v.result.value[at].data[0],'base64');b[34]=7;v.result.value[at].data[0]=b.toString('base64');});reject(c,/WRAPPED_MINT_AUTHORITY_DECIMALS/);
});

test('constructed caught/ancestor failed completion never inherits outer success and missing logs are unproved',()=>{
 const c=fixture(),r=reconstructC12NativeTransfers(c),t=r.transfers.find(t=>t.destinationChain===1)!,id=c.records.find(r=>r.receipt.request.method==='getTransaction'&&(r.receipt.request as any).params[0]===t.destinationTransaction)!.id;
 edit(c,id,v=>{v.result.meta.logMessages=v.result.meta.logMessages.map((s:string)=>s===`Program wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb success`?s.replace('success','failed: constructed failure'):s);});
 // This constructed inconsistent successful outer status has no committed target; no flow may be admitted from it.
 const result=reconstructC12NativeTransfers(c);assert.equal(result.transfers.some(x=>x.destinationTransaction===t.destinationTransaction),false);
 const d=fixture();edit(d,id,v=>{v.result.meta.logMessages=null;});reject(d,/UNTRUNCATED_LOGS/);
});

test('protocol boundary state and finality witnesses cannot be omitted or silently changed',()=>{
 let c=fixture();strip(c,/eth-wtt-implementation-26312975$/);reject(c,/MISSING_ethereum_eth_getStorageAt/);
 c=fixture();edit(c,'eth-wtt-implementation-code-26313173',v=>{v.result='0x00';});reject(c,/IMPLEMENTATION_BOUNDARY_CHANGE/);
 // A changed raw anchor first violates its exact frozen-manifest binding, before deterministic-hour selection.
 c=fixture();edit(c,'anchor-sol-slot',v=>{v.result=1;});reject(c,/NATIVE_ANCHORS/);
 c=fixture();edit(c,'sol-wtt-core-programdata-headers',v=>{const b=Buffer.from(v.result.value[0].data[0],'base64');b.writeBigUInt64LE(999999999n,4);v.result.value[0].data[0]=b.toString('base64');});reject(c,/PROGRAM_DEPLOYMENT/);
});


test('native JSON object member order is immaterial while every committed-event field remains bound',()=>{
 const c=fixture(),id=c.records.find(r=>r.receipt.request.method==='eth_getTransactionReceipt')!.id;
 edit(c,id,v=>{v.result.logs=v.result.logs.map((x:any)=>Object.fromEntries(Object.entries(x).reverse()));});
 assert.equal(reconstructC12NativeTransfers(c).transfers.length,8);
 const d=fixture();edit(d,id,v=>{const event=v.result.logs.find((x:any)=>x.address==='0x3ee18b2214aff97000d974cf647e7c347e8fa585');event.transactionIndex='0xffffff';});reject(d,/COMMITTED_EVENT/);
});
