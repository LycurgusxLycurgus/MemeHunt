import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {decodeHolderAgeSource,unpackHolderAgeChunk,HOLDER_AGE_ARCHIVE_METHOD,HOLDER_AGE_CHUNK_BYTES,validateHolderAgeStorage,HOLDER_AGE_PREFIX,HOLDER_AGE_SOURCE_ID,HOLDER_AGE_ADAPTER,holderAgeContainerScope,type HolderAgeDescriptor} from '../src/providers/advisory-holder-age-source.js';
import {loadHolderAgeCapture} from '../src/providers/advisory-holder-age-import.js';
import {unpackHolderPopulation,archiveHolderPopulation} from '../src/providers/advisory-topology.js';
import {holderAgeFixture,writeHolderAgeCapture,createHolderAgeFixture} from './holder-age-fixtures.js';
import type {EvidenceRecord} from '../src/domain/contracts.js';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
function scenario(work:(dir:string)=>void){const dir=mkdtempSync(join(tmpdir(),'holder-age-source-'));try{work(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function decode(dir:string,fixture:any){writeHolderAgeCapture(dir,fixture);const r=loadHolderAgeCapture(dir,fixture.header.token,fixture.cutoff);return decodeHolderAgeSource(r,fixture.cutoff);}
function record(f:any,kind:string,id?:string){const r=f.records.find((r:any)=>r.kind===kind&&(id===undefined||r.id===id));assert.ok(r);return r;}
function edit(r:any,change:(v:any)=>void){const archived=r.kind==='ORIGIN'&&r.id==='rpc-holder-population'&&r.evidence.adapterVersion==='holder-population-archive-v1',raw=archived?unpackHolderPopulation(r.raw):r.raw;const body=JSON.parse(raw);change(body);r.raw=archived?archiveHolderPopulation(JSON.stringify(body)):JSON.stringify(body);r.sourceBytes=Buffer.byteLength(r.raw);r.sourceHash=sha(r.raw);if(r.kind==='ORIGIN')r.evidence.contentHash=r.sourceHash;}

test('genuine115-owner population and histories reconstruct independently; mixed fixture keeps adjacent source banks explicit',()=>{
 for(const mode of ['claudecoin','mixed']as const)scenario(dir=>{const c=createHolderAgeFixture(dir,mode),x=c.context;assert.equal(x.owners.length,mode==='claudecoin'?115:5);assert.equal(x.first.size,x.owners.length);assert.equal(String(x.owners.reduce((n,o)=>n+BigInt(o.heldAtomic),0n)),x.mint.supplyAtomic);assert.equal(x.origin.requestWire,'NOT_RETAINED');assert.equal(x.bank.slot,mode==='claudecoin'?460805648:461595081);assert.equal(x.mint.slot,mode==='claudecoin'?460805648:461595080);assert.equal(x.summary.positiveOwners,x.owners.length);assert.equal(x.summary.exceptionalOwners.length,0);assert.equal(x.summary.nativeRecords,c.fixture.records.length);assert.ok(x.summary.nativeSourceBytes>0);assert.ok(x.summary.chunkInflatedBytes>0);assert.deepEqual(x.summary.providerIndexPremise,{requestedSlotFloor:0,requestedSlotCeiling:x.bank.slot,status:'ANY',tokenAccounts:'NONE',retention:'DECLARED_PROVIDER_INDEX_NOT_FIRST_EVER'});});
});

test('local chunk framing rejects trailing data, noncanonical base64, false lengths and source hashes',()=>scenario(dir=>{
 const c=createHolderAgeFixture(dir),wrapper=JSON.parse(c.receipts.rawArtifacts['chunk-0']!);for(const change of [(w:any)=>{w.data+='=';},(w:any)=>{w.sourceBytes++;},(w:any)=>{w.sourceHash='0'.repeat(64);},(w:any)=>{w.data=Buffer.concat([Buffer.from(w.data,'base64'),Buffer.from([1,2,3])]).toString('base64');}]){const w=structuredClone(wrapper);change(w);assert.throws(()=>unpackHolderAgeChunk(JSON.stringify(w)),/O22_HOLDER_SOURCE_/);}
 const wrongOrder=JSON.stringify({encoding:wrapper.encoding,method:wrapper.method,sourceBytes:wrapper.sourceBytes,sourceHash:wrapper.sourceHash,data:wrapper.data});assert.throws(()=>unpackHolderAgeChunk(wrongOrder),/ARCHIVE_CANONICAL/);
 const bytes=Buffer.from([0xc0,0xaf]),bad=JSON.stringify({method:HOLDER_AGE_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:bytes.length,sourceHash:sha(bytes),data:deflateRawSync(bytes).toString('base64')});assert.throws(()=>unpackHolderAgeChunk(bad),/UTF8/);
}));

test('record bijection rejects duplicate/missing owners, orphan roles, invented request wires and unbound before cursors',()=>{
 for(const change of [(f:any)=>{f.records.push(structuredClone(record(f,'FIRST')));},(f:any)=>{f.records.splice(f.records.indexOf(record(f,'FIRST')),1);},(f:any)=>{record(f,'FIRST').ownerIndex=19999;},(f:any)=>{record(f,'ORIGIN').request={method:'getGenesisHash',params:[]};},(f:any)=>{record(f,'BEFORE').request.params[1].before='1'.repeat(64);},(f:any)=>{f.records.splice(f.records.indexOf(record(f,'OLD_PREFIX')),1);}])scenario(dir=>{const f=holderAgeFixture();change(f);assert.throws(()=>decode(dir,f),/O22_HOLDER_SOURCE_/);});
});

test('raw origin evidence, native mint/population identity and exact bank time bind source acceptance',()=>{
 for(const change of [(f:any)=>{record(f,'ORIGIN','rpc-mint-raw').evidence.accessMode='USER_IMPORT';},(f:any)=>{record(f,'ORIGIN','rpc-holder-population').evidence.scope.fullAccountData=false;},(f:any)=>{record(f,'ORIGIN','rpc-genesis').retrievedAt=f.header.createdAt;},(f:any)=>{edit(record(f,'ORIGIN','rpc-genesis'),v=>{v.result='11111111111111111111111111111111';});},(f:any)=>{edit(record(f,'ORIGIN','rpc-mint-raw'),v=>{v.result.value.owner='11111111111111111111111111111111';});},(f:any)=>{edit(record(f,'ORIGIN','rpc-holder-population'),v=>{const row=v.result.value[0],bytes=Buffer.from(row.account.data[0],'base64');bytes.writeBigUInt64LE(bytes.readBigUInt64LE(64)+1n,64);row.account.data[0]=bytes.toString('base64');});},(f:any)=>{record(f,'BANK_TIME').request.params[0]--;},(f:any)=>{edit(record(f,'BANK_TIME'),v=>{v.result=Date.parse(f.header.createdAt)/1000;});}])scenario(dir=>{const f=holderAgeFixture();change(f);assert.throws(()=>decode(dir,f));});
});

test('native request, body member, source clocks and RPC bounds cannot be replaced by cached flags',()=>{
 const cases:Array<{label:string;change:(f:any)=>void}>=[
  {label:'request status',change:f=>{record(f,'FIRST').request.params[1].filters.status='succeeded';}},
  {label:'owned-token scope',change:f=>{record(f,'FIRST').request.params[1].filters.tokenAccounts='all';}},
  {label:'future source clock',change:f=>{record(f,'FIRST').retrievedAt='2099-01-01T00:00:00.000Z';}},
  {label:'cached quality flag',change:f=>{record(f,'FIRST').quality='KNOWN';}},
  //64 zero bytes have a canonical base58 encoding; source validation does not authenticate an imported signature cryptographically.
  {label:'signature decoded length63',change:f=>{edit(record(f,'FIRST'),v=>{v.result.data[0].transaction.signatures[0]='1'.repeat(63);});}},
  {label:'queried owner absent from native keys',change:f=>{const r=record(f,'FIRST'),owner=r.request.params[0];edit(r,v=>{const keys=v.result.data[0].transaction.message.accountKeys,candidates=[f.header.token.address,'So11111111111111111111111111111111111111112'],replacement=candidates.find(a=>!keys.some((k:any)=>k.pubkey===a));assert.ok(replacement);const own=keys.find((k:any)=>k.pubkey===owner);assert.ok(own);own.pubkey=replacement;});}},
  {label:'native history body cap',change:f=>{const r=record(f,'FIRST');r.raw+=' '.repeat(500001-Buffer.byteLength(r.raw));r.sourceBytes=Buffer.byteLength(r.raw);r.sourceHash=sha(r.raw);}},
 ];
 for(const {label,change}of cases)scenario(dir=>{const f=holderAgeFixture(),before=JSON.stringify(f.records);change(f);assert.notEqual(JSON.stringify(f.records),before,label+' must change the validated record');assert.throws(()=>decode(dir,f),/O22_HOLDER_/,label);});
});

test('manifest catalogs and purpose-specific storage IDs require whole raw source reconstruction',()=>scenario(dir=>{
 const c=createHolderAgeFixture(dir),rawArtifacts:Record<string,string>={},evidence:EvidenceRecord[]=[],ids=Object.keys(c.receipts.rawArtifacts);for(const local of ids){const id=HOLDER_AGE_PREFIX+local,raw=c.receipts.rawArtifacts[local]!;rawArtifacts[id]=raw;evidence.push({id,sourceId:HOLDER_AGE_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',adapterVersion:HOLDER_AGE_ADAPTER,accessMode:'USER_IMPORT',availableAt:c.receipts.createdAt,retrievedAt:c.receipts.createdAt,contentHash:sha(raw),scope:holderAgeContainerScope(c.receipts,local)});}
 const descriptor:HolderAgeDescriptor={method:c.receipts.method,token:c.token,createdAt:c.receipts.createdAt,ageThresholdHours:24,manifestId:HOLDER_AGE_PREFIX+'manifest',chunkIds:ids.filter(k=>k!=='manifest').map(k=>HOLDER_AGE_PREFIX+k)};assert.deepEqual(validateHolderAgeStorage({token:c.token,rawArtifacts,evidence},descriptor,c.cutoff),new Set(ids.map(k=>HOLDER_AGE_PREFIX+k)));
 const forged=structuredClone(evidence);forged[0]!.accessMode='PUBLIC_API';assert.throws(()=>validateHolderAgeStorage({token:c.token,rawArtifacts,evidence:forged},descriptor,c.cutoff),/STORAGE_RECORD/);
 const r=structuredClone(c.receipts),m=JSON.parse(r.rawArtifacts.manifest!);m.chunks[0].recordKeysHash='0'.repeat(64);r.rawArtifacts.manifest=JSON.stringify(m);assert.throws(()=>decodeHolderAgeSource(r,c.cutoff),/RECORD_CATALOG/);m.chunks[0].sourceBytes=HOLDER_AGE_CHUNK_BYTES+1;r.rawArtifacts.manifest=JSON.stringify(m);assert.throws(()=>decodeHolderAgeSource(r,c.cutoff),/MANIFEST/);
}));

test('portable import permits only bounded exact regular files, strict UTF8 and safe fixed basenames',()=>{
 scenario(dir=>{const c=createHolderAgeFixture(dir);writeFileSync(join(dir,'foreign.txt'),'x');assert.throws(()=>loadHolderAgeCapture(dir,c.token,c.cutoff),/FOREIGN_FILE/);});
 scenario(dir=>{const c=createHolderAgeFixture(dir);const bytes=readFileSync(join(dir,'chunk-0.deflate'));writeFileSync(join(dir,'outside'),bytes);rmSync(join(dir,'chunk-0.deflate'));symlinkSync(join(dir,'outside'),join(dir,'chunk-0.deflate'));assert.throws(()=>loadHolderAgeCapture(dir,c.token,c.cutoff),/FOREIGN_FILE|FILE/);});
 scenario(dir=>{const c=createHolderAgeFixture(dir);const m=JSON.parse(readFileSync(join(dir,'capture.json'),'utf8'));m.chunks[0].file='../chunk-0.deflate';writeFileSync(join(dir,'capture.json'),JSON.stringify(m));assert.throws(()=>loadHolderAgeCapture(dir,c.token,c.cutoff),/FOREIGN_FILE|CHUNK_SEQUENCE/);});
 scenario(dir=>{const c=createHolderAgeFixture(dir);writeFileSync(join(dir,'capture.json'),Buffer.from([0xff]));assert.throws(()=>loadHolderAgeCapture(dir,c.token,c.cutoff),/MANIFEST/);});
});
