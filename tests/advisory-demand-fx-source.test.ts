import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createA30SourceCapture,a30SourceBundle,a30SourceNativeFixture,a30Archive} from './a30-fx-source-fixtures.js';
import {loadA30SourceCapture} from '../src/providers/advisory-demand-fx-import.js';
import {visitA30Sources,validateA30Storage,validateA30ReceiptShape,projectA30C5Receipts,a30ReceiptsFromDescriptor,a30NativeBodyDigests,A30_SOURCE_PREFIX,A30_SOURCE_ID,A30_SOURCE_ADAPTER,type A30SourceReceipts} from '../src/providers/advisory-demand-fx-source.js';
import {unpackO23BulkSource,visitO23BulkSources} from '../src/providers/advisory-synchrony-bulk.js';
const temporary=(run:(directory:string)=>void)=>{const directory=mkdtempSync(join(tmpdir(),'a30-source-'));try{run(directory);}finally{rmSync(directory,{recursive:true,force:true});}};
function mutate(source:A30SourceReceipts,key:string,change:(v:any)=>void){const archive=key.startsWith('fx-index-')||key.startsWith('fx-body-')||key==='fx-head'||key.startsWith('c5-bulk-page-'),raw=unpackO23BulkSource(source.rawArtifacts[key]!,archive),value=JSON.parse(raw);change(value);source.rawArtifacts[key]=archive?a30Archive(JSON.stringify(value)):JSON.stringify(value);}
const sourceAndHead=(r:A30SourceReceipts,key:string,head:string,change:(v:any)=>void)=>{mutate(r,key,change);r.rawArtifacts[head]=r.rawArtifacts[key]!;};

test('constructed small census replays genuine native source objects and a static-only bank under A30 IDs',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory),before=JSON.stringify(f.source),loaded=loadA30SourceCapture(directory,f.source.token,f.cutoff),seen:any[]=[];
 assert.deepEqual(loaded,f.source);const context=visitA30Sources(loaded,f.cutoff,(tx,indexed,at,companion,identity)=>seen.push({signature:tx.transaction.signatures[0],indexed,at,companion,identity}));
 assert.equal(context.counts.fxIndexReferences,1);assert.equal(context.counts.fxBodies,1);assert.equal(context.counts.fxFailedReferences,0);assert.equal(context.counts.fxCompiledCompanions,1);assert.equal(context.bodyHashes.size,1);assert.equal(seen.length,1);assert.equal(seen[0].indexed.sourceId,A30_SOURCE_PREFIX+'fx-body-0');assert.equal(seen[0].companion.id,A30_SOURCE_PREFIX+'fx-compiled-0');assert.equal(seen[0].identity.program,'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');assert.equal(seen[0].identity.decimalsA,9);assert.equal(seen[0].identity.decimalsB,8);
 for(const key of ['sqrtPriceX64','liquidity','feeRate','tickCurrentIndex'])assert.equal(Object.hasOwn(context.identity,key),false,key);
 assert.equal(JSON.stringify(f.source),before);const c5=projectA30C5Receipts(loaded);assert.equal(c5.method,'o23-complete-quote-tape-v1');assert.equal(Object.keys(c5.requests).some(id=>id.startsWith('fx-')||id.startsWith('c5-')),false);assert.equal(visitO23BulkSources(c5,f.cutoff).counts.successfulReferences,3);
}));

test('failed source references remain explicit and never require or contribute successful bodies',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory),r=structuredClone(f.source);sourceAndHead(r,'fx-index-0','fx-index-head',v=>{const first=v.result.data[0];v.result.data.push({...first,signature:f.c5.fixture.transactions[0].transaction.signatures[0],slot:first.slot-1,transactionIndex:0,blockTime:first.blockTime-1,err:{InstructionError:[0,'InvalidArgument']}});});
 const c=visitA30Sources(r,f.cutoff);assert.equal(c.counts.fxIndexReferences,2);assert.equal(c.counts.fxFailedReferences,1);assert.equal(c.counts.fxBodies,1);
}));

test('source request, time, terminal, ordering and head conflicts cannot become complete coverage',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory);const cases:Array<(r:A30SourceReceipts)=>void>=[
  r=>{(r.requests['fx-index-0']!.params[1] as any).filters.status='succeeded';},
  r=>{r.retrievedAt['fx-body-0']='2026-10-30T15:00:00.000Z';},
  r=>{mutate(r,'fx-index-0',v=>{v.result.paginationToken=v.result.data[0].slot+':'+v.result.data[0].transactionIndex;});},
  r=>{mutate(r,'fx-index-head',v=>{v.result.data[0].err='AccountNotFound';});},
  r=>{sourceAndHead(r,'fx-body-0','fx-head',v=>{v.result.data[0].transactionIndex++;});},
  r=>{sourceAndHead(r,'fx-body-0','fx-head',v=>{v.result.data=[];});},
  r=>{mutate(r,'fx-head',v=>{v.result.data[0].meta.fee++;});},
  r=>{r.retrievedAt['fx-compiled-0']='2026-10-30T16:00:00.000Z';},
  r=>{mutate(r,'fx-compiled-0',v=>{v.result.transactionIndex++;});},
 ];for(const change of cases){const r=structuredClone(f.source);change(r);assert.throws(()=>visitA30Sources(r,f.cutoff),/ADVISORY_A30_SOURCE_/);}
}));

test('static identity validates exact native account owners/mints/PDA but never supplies a historical price',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory),before=visitA30Sources(f.source,f.cutoff).identity,r=structuredClone(f.source);
 mutate(r,'fx-identity-bank',v=>{const a=v.result.value[8],bytes=Buffer.from(a.data[0],'base64');bytes.writeBigUInt64LE(bytes.readBigUInt64LE(65)+1n,65);a.data[0]=bytes.toString('base64');});assert.deepEqual(visitA30Sources(r,f.cutoff).identity,before);
 for(const change of [(v:any)=>{v.result.value[8].owner='11111111111111111111111111111111';},(v:any)=>{v.result.value[2].data[0]=v.result.value[7].data[0];},(v:any)=>{const a=v.result.value[8],b=Buffer.from(a.data[0],'base64');b[40]^=1;a.data[0]=b.toString('base64');}]){const changed=structuredClone(f.source);mutate(changed,'fx-identity-bank',change);assert.throws(()=>visitA30Sources(changed,f.cutoff),/ADVISORY_A30_SOURCE_IDENTITY_/);}
}));

test('lossless native-body fingerprints distinguish unsafe u64 tokens and preserve array/type distinctions',()=>{
 const sig=JSON.parse(a30SourceNativeFixture().nativeTransactionRaw).transaction.signatures[0];const raw=(n:string,fields='"slot":1,"blockTime":2,"transactionIndex":3')=>' {"result":{"data":[{'+fields+',"transaction":{"signatures":["'+sig+'"]},"meta":{"u64":'+n+',"a":[1,2]}}]}}';
 const hash=(r:string)=>a30NativeBodyDigests(r).get(sig)!.hash;assert.notEqual(hash(raw('9007199254740992')),hash(raw('9007199254740993')));assert.equal(hash(raw('9007199254740993')),hash(raw('9007199254740993','"transactionIndex":3,"blockTime":2,"slot":1')));assert.notEqual(hash(raw('"9007199254740993"')),hash(raw('9007199254740993')));assert.notEqual(hash(raw('9007199254740993').replace('[1,2]','[2,1]')),hash(raw('9007199254740993')));
});

test('own storage permission needs exact source ownership, byte hashes, clocks, scopes and full source replay',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory),b=a30SourceBundle(f.source),before=JSON.stringify(b),ids=validateA30Storage(b.descriptor,b.rawArtifacts,b.evidence,f.cutoff);assert.equal(ids.size,Object.keys(f.source.requests).length);assert.ok([...ids].every(id=>id.startsWith(A30_SOURCE_PREFIX)));assert.equal(JSON.stringify(b),before);assert.deepEqual(a30ReceiptsFromDescriptor(b.descriptor,b.rawArtifacts,b.evidence,f.cutoff),f.source);
 for(const change of [(x:typeof b)=>{x.evidence[0]!.sourceId='advisory-synchrony-bulk';},(x:typeof b)=>{x.evidence[0]!.adapterVersion='o23-bulk-receipts-v1';},(x:typeof b)=>{x.evidence[0]!.availableAt=f.cutoff;},(x:typeof b)=>{x.evidence[0]!.scope={request:{method:'getSlot',params:[]}};},(x:typeof b)=>{x.rawArtifacts[A30_SOURCE_PREFIX+'orphan']='{}';},(x:typeof b)=>{x.descriptor.artifactIds[Object.keys(x.descriptor.artifactIds)[0]!] = 'advisory-synchrony-bulk-genesis';}]){const x=structuredClone(b);change(x);assert.throws(()=>validateA30Storage(x.descriptor,x.rawArtifacts,x.evidence,f.cutoff),/ADVISORY_A30_SOURCE_/);}
 assert.equal(A30_SOURCE_ID,'advisory-a30-fx');assert.equal(A30_SOURCE_ADAPTER,'a30-incoming-fx-source-v1');
}));

test('a source-valid constructed cross-source disagreement fails instead of joining incompatible native bodies',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory),r=structuredClone(f.source),tx=JSON.parse(f.native.nativeTransactionRaw);tx.transaction.message.accountKeys.push({pubkey:r.pool,signer:false,writable:false,source:'transaction'});
 mutate(r,'c5-index-page-0',v=>{v.result=[{signature:tx.transaction.signatures[0],slot:tx.slot,blockTime:tx.blockTime,err:null,confirmationStatus:'finalized'}];});mutate(r,'c5-bulk-page-0',v=>{v.result={data:[tx],paginationToken:null};});const b=a30SourceBundle(r);assert.throws(()=>validateA30Storage(b.descriptor,b.rawArtifacts,b.evidence,f.cutoff),/ADVISORY_A30_SOURCE_OVERLAP_CONFLICT/);
}));

test('receipt/archive bounds reject unknown roles, malformed encodings and future source clocks',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory);for(const change of [(r:A30SourceReceipts)=>{r.requests['fx-index-100']=r.requests['fx-index-0']!;r.rawArtifacts['fx-index-100']=r.rawArtifacts['fx-index-0']!;r.retrievedAt['fx-index-100']=r.retrievedAt['fx-index-0']!;},(r:A30SourceReceipts)=>{const x=JSON.parse(r.rawArtifacts['fx-index-0']!);x.sourceBytes=500001;r.rawArtifacts['fx-index-0']=JSON.stringify(x);},(r:A30SourceReceipts)=>{r.retrievedAt['fx-body-0']='2026-10-31T00:00:00.000Z';},(r:A30SourceReceipts)=>{delete r.rawArtifacts['c5-genesis'];}]){const r=structuredClone(f.source);change(r);assert.throws(()=>validateA30ReceiptShape(r,f.cutoff),/ADVISORY_A30_SOURCE_/);}
 const r=structuredClone(f.source),wrapper=JSON.parse(r.rawArtifacts['fx-index-0']!);wrapper.data+='AAAA';r.rawArtifacts['fx-index-0']=JSON.stringify(wrapper);assert.throws(()=>visitA30Sources(r,f.cutoff),/ADVISORY_A30_SOURCE_ARCHIVE/);
}));

test('portable importer enforces exact fixed files, regular no-follow reads and original source hashes',()=>temporary(directory=>{
 const f=createA30SourceCapture(directory),manifestPath=join(directory,'capture.json'),original=readFileSync(manifestPath),receipt=f.manifest.receipts.find((x:any)=>x.id==='fx-identity-bank');
 writeFileSync(join(directory,'foreign.txt'),'unowned');assert.throws(()=>loadA30SourceCapture(directory,f.source.token,f.cutoff),/ADVISORY_A30_IMPORT_FOREIGN_FILE/);rmSync(join(directory,'foreign.txt'));
 const raw=readFileSync(join(directory,receipt.file));writeFileSync(join(directory,receipt.file),Buffer.concat([raw,Buffer.from(' ')]));assert.throws(()=>loadA30SourceCapture(directory,f.source.token,f.cutoff),/ADVISORY_A30_IMPORT_SOURCE_HASH/);writeFileSync(join(directory,receipt.file),raw);
 rmSync(join(directory,receipt.file));symlinkSync(manifestPath,join(directory,receipt.file));assert.throws(()=>loadA30SourceCapture(directory,f.source.token,f.cutoff),/ADVISORY_A30_IMPORT_FILE/);rmSync(join(directory,receipt.file));writeFileSync(join(directory,receipt.file),raw);
 const m=JSON.parse(original.toString());m.receipts[0].file='../escape';writeFileSync(manifestPath,JSON.stringify(m));assert.throws(()=>loadA30SourceCapture(directory,f.source.token,f.cutoff),/ADVISORY_A30_IMPORT_/);
}));
