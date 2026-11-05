import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {INVENTORY_RETURNS_METHOD,INVENTORY_RETURNS_CHUNK_METHOD,INVENTORY_RETURNS_ARCHIVE_METHOD,INVENTORY_RETURNS_SOURCE_ID,INVENTORY_RETURNS_PREFIX,INVENTORY_RETURNS_ADAPTER,inventoryReturnContainerScope,validateInventoryReturnStorage,unpackInventoryReturnChunk,validateInventoryReturnReceiptShape,decodeInventoryReturnSource,type InventoryReturnReceipts} from '../src/providers/advisory-inventory-returns-source.js';
import {loadInventoryReturnCapture} from '../src/providers/advisory-inventory-returns-import.js';
import {createO26InventoryCapture} from './inventory-returns-fixtures.js';
const sha=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},pool='3M9sVgL4u6ATKaiExf3XhQqNfMB6ijvzk3meMcQaen1w',at='2026-10-30T09:00:00.000Z';
function smallContainer(){
 // Deliberately empty native roster: useful only for container/loader rejection tests, never a complete pool/source proof.
 const source=JSON.stringify({method:INVENTORY_RETURNS_CHUNK_METHOD,records:[{key:'WINDOW:window-anchor-slot',kind:'WINDOW',id:'window-anchor-slot',request:{method:'getSlot',params:[{commitment:'finalized'}]},retrievedAt:at,sourceBytes:43,sourceHash:'0'.repeat(64),raw:'{"jsonrpc":"2.0","id":1,"result":461595156}'}]}),raw=Buffer.from(source),packed=deflateRawSync(raw),wrapper=JSON.stringify({method:INVENTORY_RETURNS_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:raw.length,sourceHash:sha(raw),data:packed.toString('base64')});
 const manifest={method:INVENTORY_RETURNS_METHOD,token,pool,windowEnd:'2026-10-26T08:00:00.000Z',createdAt:at,sourceSemantics:'Parsed native RPC request semantics and exact retained response bytes/clocks; no original HTTP request-wire or provider authentication claim. Outer format is a local retained container, never an RPC response.',windowOrigin:{snapshot:'CONSTRUCTED_INCOMPLETE_CODEC_ONLY',source:'ACCEPTED_ARCHIVED_WINDOW',bankClock:at},recordCounts:{WINDOW:1,INDEX:0,OFFPOOL:0,COMPILED_POOL:0,COMPILED_OFFPOOL:0},nativeRecords:1,nativeSourceBytes:43,chunks:[{id:'chunk-0',file:'chunk-0.deflate',encoding:'DEFLATE_RAW_BINARY',sourceBytes:raw.length,sourceHash:sha(raw),archiveBytes:packed.length,archiveHash:sha(packed),recordKeys:['WINDOW:window-anchor-slot']}]};
 const receipts:InventoryReturnReceipts={method:INVENTORY_RETURNS_METHOD,token,pool,windowEnd:manifest.windowEnd,createdAt:at,rawArtifacts:{manifest:JSON.stringify(manifest),'chunk-0':wrapper}};return{raw,packed,wrapper,manifest,receipts};
}
test('local byte container preserves exact UTF8 and rejects trailing compressed bytes, forged sizes, hashes and noncanonical base64',()=>{
 const f=smallContainer();assert.equal(unpackInventoryReturnChunk(f.wrapper),f.raw.toString());
 for(const mutate of [(x:any)=>{x.data=Buffer.concat([f.packed,Buffer.from([0])]).toString('base64');},(x:any)=>{x.sourceBytes--;},(x:any)=>{x.sourceHash='f'.repeat(64);},(x:any)=>{x.data+='\n';},(x:any)=>{x.extra=true;},(x:any)=>{x.sourceBytes=32_000_001;}]){const x=JSON.parse(f.wrapper);mutate(x);assert.throws(()=>unpackInventoryReturnChunk(JSON.stringify(x)),/ADVISORY_INVENTORY_RETURNS_/);}
 const invalid=Buffer.from([0xff]),bad=JSON.stringify({method:INVENTORY_RETURNS_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:1,sourceHash:sha(invalid),data:deflateRawSync(invalid).toString('base64')});assert.throws(()=>unpackInventoryReturnChunk(bad),/UTF8/);
});
test('container header never grants completeness and rejects future creation, unexpected parts and record byte forgery',()=>{
 const f=smallContainer();assert.deepEqual(validateInventoryReturnReceiptShape(f.receipts,at),f.receipts);assert.throws(()=>decodeInventoryReturnSource(f.receipts,at),/NATIVE_RECORD/);
 const future=structuredClone(f.receipts);future.createdAt='2026-10-30T09:00:00.001Z';assert.throws(()=>validateInventoryReturnReceiptShape(future,at),/SCOPE/);
 const orphan=structuredClone(f.receipts);orphan.rawArtifacts.unrelated='{}';assert.throws(()=>validateInventoryReturnReceiptShape(orphan,at),/OUTER_MEMBERSHIP/);
});
test('local import binds original binary hashes and an exact regular-file catalog, without relabeling contents as RPC',()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-container-codec-'));try{const f=smallContainer();writeFileSync(join(dir,'capture.json'),JSON.stringify(f.manifest));writeFileSync(join(dir,'chunk-0.deflate'),f.packed);const r=loadInventoryReturnCapture(dir,token,at);assert.equal(r.rawArtifacts['chunk-0'],f.wrapper);assert.equal(r.createdAt,at);
  writeFileSync(join(dir,'foreign.json'),'{}');assert.throws(()=>loadInventoryReturnCapture(dir,token,at),/FOREIGN_FILE/);rmSync(join(dir,'foreign.json'));
  writeFileSync(join(dir,'chunk-0.deflate'),Buffer.concat([f.packed,Buffer.from([0])]));assert.throws(()=>loadInventoryReturnCapture(dir,token,at),/FILE|ARCHIVE_HASH/);rmSync(join(dir,'chunk-0.deflate'));
  symlinkSync(join(dir,'capture.json'),join(dir,'chunk-0.deflate'));assert.throws(()=>loadInventoryReturnCapture(dir,token,at),/FILE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// Re-encode only test copies of the explicitly constructed small source package.
function changeRecords(receipts:InventoryReturnReceipts,mutate:(records:any[])=>void):InventoryReturnReceipts{
 const r=structuredClone(receipts),m=JSON.parse(r.rawArtifacts.manifest!),parts=m.chunks.map((c:any)=>JSON.parse(unpackInventoryReturnChunk(r.rawArtifacts[c.id]!))),records=parts.flatMap((p:any)=>p.records);mutate(records);
 for(const v of records){v.sourceBytes=Buffer.byteLength(v.raw);v.sourceHash=sha(v.raw);}
 // This durable fixture has one chunk; its exact record and native-byte catalogs are rebound after the mutation.
 assert.equal(parts.length,1);const raw=Buffer.from(JSON.stringify({method:INVENTORY_RETURNS_CHUNK_METHOD,records})),packed=deflateRawSync(raw),c=m.chunks[0];Object.assign(c,{sourceBytes:raw.length,sourceHash:sha(raw),archiveBytes:packed.length,archiveHash:sha(packed),recordKeys:records.map((v:any)=>v.key)});m.nativeRecords=records.length;m.nativeSourceBytes=records.reduce((n:number,v:any)=>n+v.sourceBytes,0);m.recordCounts={WINDOW:0,INDEX:0,OFFPOOL:0,COMPILED_POOL:0,COMPILED_OFFPOOL:0};for(const v of records)m.recordCounts[v.kind]++;
 r.rawArtifacts['chunk-0']=JSON.stringify({method:INVENTORY_RETURNS_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:raw.length,sourceHash:sha(raw),data:packed.toString('base64')});r.rawArtifacts.manifest=JSON.stringify(m);return r;
}

test('genuine retained endpoint source derives roster before allowance and requires reverse index/body membership',()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-source-join-'));try{const f=createO26InventoryCapture(join(dir,'capture')),c=f.context;assert.equal(c.bindings.accounts.length,2);assert.equal(c.window.trades.length,3);assert.equal(c.summary.successfulReferences,3);assert.equal(c.summary.compiledCompanions,1);assert.equal(c.cutoff,f.cutoff);
  const absent=changeRecords(f.receipts,records=>{const r=records.find(v=>v.kind==='INDEX'&&v.id==='account-0-page-0'),raw=JSON.parse(r.raw);assert.equal(raw.result.data.length,2);raw.result.data.shift();r.raw=JSON.stringify(raw);});assert.throws(()=>decodeInventoryReturnSource(absent,f.cutoff),/REVERSE_BODY_INDEX/);
  const failed=changeRecords(f.receipts,records=>{const r=records.find(v=>v.kind==='INDEX'&&v.id==='account-0-page-0'),raw=JSON.parse(r.raw);raw.result.data[0].err={InstructionError:[0,'Custom']};r.raw=JSON.stringify(raw);});assert.throws(()=>decodeInventoryReturnSource(failed,f.cutoff),/BODY_METADATA/);
  const missingTerminal=changeRecords(f.receipts,records=>{const at=records.findIndex(v=>v.kind==='INDEX'&&v.id==='account-1-page-1');records.splice(at,1);});assert.throws(()=>decodeInventoryReturnSource(missingTerminal,f.cutoff),/INDEX_INCOMPLETE/);
  const duplicate=changeRecords(f.receipts,records=>records.push(structuredClone(records[0])));assert.throws(()=>decodeInventoryReturnSource(duplicate,f.cutoff),/NATIVE_RECORD/);
  const future=changeRecords(f.receipts,records=>{records[0].retrievedAt='2026-10-31T00:00:00.000Z';});assert.throws(()=>decodeInventoryReturnSource(future,f.cutoff),/NATIVE_RECORD/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('storage allowance accepts only exact local-container evidence after full derived source joins',()=>{
 const dir=mkdtempSync(join(tmpdir(),'o26-source-storage-'));try{const f=createO26InventoryCapture(join(dir,'capture'));
  const stored=(r:InventoryReturnReceipts)=>{const rawArtifacts:Record<string,string>={},evidence=Object.entries(r.rawArtifacts).map(([part,raw])=>{const id=INVENTORY_RETURNS_PREFIX+part;rawArtifacts[id]=raw;return{id,sourceId:INVENTORY_RETURNS_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT' as const,adapterVersion:INVENTORY_RETURNS_ADAPTER,contentHash:sha(raw),availableAt:r.createdAt,retrievedAt:r.createdAt,scope:inventoryReturnContainerScope(r,part)};});return{bundle:{token:r.token,rawArtifacts,evidence},descriptor:{method:r.method,token:r.token,pool:r.pool,windowEnd:r.windowEnd,createdAt:r.createdAt,manifestId:INVENTORY_RETURNS_PREFIX+'manifest',chunkIds:[INVENTORY_RETURNS_PREFIX+'chunk-0']}};};
  const valid=stored(f.receipts);assert.deepEqual([...validateInventoryReturnStorage(valid.bundle,valid.descriptor,f.cutoff)].sort(),Object.keys(valid.bundle.rawArtifacts).sort());
  const forged=structuredClone(valid);forged.bundle.evidence[0]!.scope={request:{method:'getTransaction',params:[]}} as any;assert.throws(()=>validateInventoryReturnStorage(forged.bundle,forged.descriptor,f.cutoff),/STORAGE_RECORD/);
  const missing=changeRecords(f.receipts,records=>{const v=records.find(v=>v.kind==='INDEX'&&v.id==='account-0-page-0'),raw=JSON.parse(v.raw);raw.result.data.shift();v.raw=JSON.stringify(raw);}),changed=stored(missing);assert.throws(()=>validateInventoryReturnStorage(changed.bundle,changed.descriptor,f.cutoff),/REVERSE_BODY_INDEX/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
