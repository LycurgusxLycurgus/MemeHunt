import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {O24_BULK_METHOD,O24_BULK_ARCHIVE_METHOD,O24_BULK_STORED_BYTES,O24_BULK_SOURCE_ID,O24_BULK_PREFIX,O24_BULK_ADAPTER,unpackO24BulkSource,validateO24BulkReceiptShape,visitO24BulkSources,validateO24BulkStorage,type O24BulkReceipts} from '../src/providers/advisory-creator-inventory-bulk.js';
import {loadO24BulkCapture} from '../src/providers/advisory-creator-inventory-bulk-import.js';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const cutoff='2026-10-29T17:00:00.000Z';
function archive(raw:string){return JSON.stringify({method:O24_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:Buffer.byteLength(raw),sourceHash:hash(raw),data:deflateRawSync(Buffer.from(raw)).toString('base64')});}
function header():O24BulkReceipts{return{method:O24_BULK_METHOD,token:{chain:'solana',address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},wallet:'7jQwHdK771P286Vsn44v7dFVfCH8CzZcL3PZGidbShch',interval:{start:'2026-10-26T02:00:00Z',end:'2026-10-26T08:00:00Z'},stateSlot:462945391,stateFloorSlot:461595156,roleIndexBefore:null,requests:{genesis:{method:'getGenesisHash',params:[]}},rawArtifacts:{genesis:'{}'},retrievedAt:{genesis:cutoff}};}

test('O24 opaque bulk container preserves exact bytes and rejects hash, compression and UTF8 corruption',()=>{
 const raw=JSON.stringify({jsonrpc:'2.0',id:1,result:{data:[],paginationToken:null}}),valid=archive(raw);assert.equal(unpackO24BulkSource(valid,true),raw);
 for(const change of [(c:any)=>{c.data+='=';},(c:any)=>{c.sourceHash='0'.repeat(64);},(c:any)=>{c.sourceBytes++;},(c:any)=>{c.data=Buffer.concat([Buffer.from(c.data,'base64'),Buffer.from('trailer')]).toString('base64');},(c:any)=>{c.sourceBytes=32_000_001;}]){const c=JSON.parse(valid);change(c);assert.throws(()=>unpackO24BulkSource(JSON.stringify(c),true));}
 assert.throws(()=>unpackO24BulkSource(valid+' ',true),/CANONICAL/);assert.throws(()=>unpackO24BulkSource('x'.repeat(500001),false),/SIZE/);
 const invalid=Buffer.from([0xc3,0x28]);assert.throws(()=>unpackO24BulkSource(JSON.stringify({method:O24_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:invalid.length,sourceHash:hash(invalid),data:deflateRawSync(invalid).toString('base64')}),true),/UTF8/);
});

test('O24 typed header preserves fixed six hours, source clocks, local ownership and bounded storage',()=>{
 assert.equal(validateO24BulkReceiptShape(header(),cutoff).method,O24_BULK_METHOD);
 for(const change of [(r:any)=>{r.interval.start='2026-10-26T03:00:00Z';},(r:any)=>{r.interval.end='2026-10-26T08:00:01Z';},(r:any)=>{r.stateFloorSlot=r.stateSlot+1;},(r:any)=>{r.wallet='invalid';},(r:any)=>{r.roleIndexBefore='invalid';},(r:any)=>{r.rawArtifacts.orphan='{}';},(r:any)=>{r.retrievedAt.genesis='2026-10-29T17:00:00.001Z';},(r:any)=>{r.requests['compiled-0']={};r.rawArtifacts['compiled-0']='{}';r.retrievedAt['compiled-0']=cutoff;},(r:any)=>{r.pool='3M9sVgL4u6ATKaiExf3XhQqNfMB6ijvzk3meMcQaen1w';}]){const r=header();change(r);assert.throws(()=>validateO24BulkReceiptShape(r,cutoff),/ADVISORY_CREATOR_INVENTORY_BULK_/);}
 const large=header();large.rawArtifacts.genesis='x'.repeat(O24_BULK_STORED_BYTES+1);assert.throws(()=>validateO24BulkReceiptShape(large,cutoff),/STORED_SIZE/);
 assert.throws(()=>visitO24BulkSources(header(),cutoff),/SOURCE_MEMBERSHIP/);
});

test('O24 filesystem importer rejects foreign paths, duplicate source records and symlink bodies',()=>{
 const directory=mkdtempSync(join(tmpdir(),'o24-source-'));try{
  const r=header(),raw=JSON.stringify({jsonrpc:'2.0',id:1,result:null}),rows=['genesis','state-block-time','ata-head','owner-catalog'].map(id=>({id,request:{method:'getGenesisHash',params:[]},retrievedAt:cutoff,file:id+'.json',encoding:'PLAIN',sourceBytes:Buffer.byteLength(raw),sourceHash:hash(raw)}));
  const {requests,rawArtifacts,retrievedAt,...h}=r;const manifest={...h,receipts:rows};for(const row of rows)writeFileSync(join(directory,row.file),raw);writeFileSync(join(directory,'capture.json'),JSON.stringify(manifest));
  assert.equal(loadO24BulkCapture(directory,r.token,cutoff).method,O24_BULK_METHOD);
  writeFileSync(join(directory,'foreign'),'x');assert.throws(()=>loadO24BulkCapture(directory,r.token,cutoff),/FOREIGN_FILE/);rmSync(join(directory,'foreign'));
  const bad=structuredClone(manifest);bad.receipts[0]!.file='../outside';writeFileSync(join(directory,'capture.json'),JSON.stringify(bad));assert.throws(()=>loadO24BulkCapture(directory,r.token,cutoff));
  writeFileSync(join(directory,'capture.json'),JSON.stringify(manifest));rmSync(join(directory,'genesis.json'));symlinkSync(join(directory,'ata-head.json'),join(directory,'genesis.json'));assert.throws(()=>loadO24BulkCapture(directory,r.token,cutoff),/FILE/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('O24 namespace cannot gain storage allowance from orphaned, forged or public-api imported records',()=>{
 const r=header(),{rawArtifacts,retrievedAt,...h}=r,id=O24_BULK_PREFIX+'genesis',d={...h,artifactIds:{genesis:id}},raw={[id]:r.rawArtifacts.genesis!};
 const record:any={id,sourceId:O24_BULK_SOURCE_ID,accessMode:'USER_IMPORT',sourceType:'HISTORICAL_RECEIPT',adapterVersion:O24_BULK_ADAPTER,scope:{request:r.requests.genesis},availableAt:cutoff,retrievedAt:cutoff,contentHash:hash(raw[id]!)};
 for(const change of [(e:any)=>{e.accessMode='PUBLIC_API';},(e:any)=>{e.sourceType='LIVE';},(e:any)=>{e.adapterVersion='o23-bulk-receipts-v1';},(e:any)=>{e.availableAt='2026-10-29T16:59:00Z';},(e:any)=>{e.contentHash='0'.repeat(64);},(e:any)=>{e.scope={};}]){const e=structuredClone(record);change(e);assert.throws(()=>validateO24BulkStorage(d,raw,[e],cutoff),/STORAGE_RECORD/);}
 assert.throws(()=>validateO24BulkStorage(d,raw,[record,{...record,id:O24_BULK_PREFIX+'orphan'}],cutoff),/STORAGE_MEMBERSHIP/);
 assert.throws(()=>validateO24BulkStorage({...d,artifactIds:{genesis:'other-id'}},raw,[record],cutoff),/STORAGE_MEMBERSHIP/);
});

// The helper deliberately constructs a small complete census using exact genuine public native objects.
// It is conformance evidence, never the actual complete8577 creator history.
import {createO24InventoryCapture} from './creator-inventory-bulk-fixtures.js';
function capture(run:(f:ReturnType<typeof createO24InventoryCapture>)=>void){const directory=mkdtempSync(join(tmpdir(),'o24-complete-source-'));try{run(createO24InventoryCapture(directory));}finally{rmSync(directory,{recursive:true,force:true});}}
function changeBulk(r:O24BulkReceipts,change:(response:any)=>void,id='bulk-page-0'){const value=JSON.parse(unpackO24BulkSource(r.rawArtifacts[id]!,true));change(value);r.rawArtifacts[id]=archive(JSON.stringify(value));}
function changePlain(r:O24BulkReceipts,id:string,change:(response:any)=>void){const value=JSON.parse(r.rawArtifacts[id]!);change(value);r.rawArtifacts[id]=JSON.stringify(value);}

test('constructed whole wallet source admits exact original role, native state and all bodies without pool authority',()=>capture(f=>{
 const visits:string[]=[],context=visitO24BulkSources(f.receipts,f.cutoff,(tx,indexed,at,c)=>{assert.equal(tx.transaction.signatures[0],indexed.signature);assert.equal(tx.slot,indexed.slot);assert.ok(Date.parse(at)<=Date.parse(f.cutoff));assert.equal(c.role.wallet,f.receipts.wallet);visits.push(indexed.signature);});
 assert.equal(context.role.creation.slot,446785907);assert.equal(context.role.creation.logCoverage,'COMPLETE_CREATION_FRAME_BEFORE_LATER_TRUNCATION');assert.equal(context.canonicalAccount,'Ga5159tRwuRDZxZycD9ZpEJyLcVs1vcqFmdyc2kqoNkS');assert.equal(context.stateSlot,context.head.context.slot);assert.equal(context.stateSlot,context.ownerCatalog.context.slot);
 assert.equal(context.counts.successfulReferences,17);assert.equal(context.counts.bulkBodies,17);assert.equal(new Set(visits).size,17);assert.equal(context.counts.canonicalIndexReferences,136);assert.equal(context.counts.bulkPages,2);assert.equal(context.walletRows.length,17);assert.ok(context.sourceBytes>0&&context.storedBytes>0);assert.equal(context.receiptManifestHash.length,64);assert.equal(context.sourceHashes.length,Object.keys(f.receipts.requests).length);
 assert.deepEqual(loadO24BulkCapture(f.directory,f.token,f.cutoff),f.receipts);assert.equal(Object.hasOwn(f.receipts,'pool'),false);
}));

test('whole-wallet source rejects weakened requests, failed-row changes, cursor gaps and body/role/state contradictions',()=>capture(f=>{
 const changes:Array<(r:O24BulkReceipts)=>void>=[
  r=>{(r.requests['bulk-page-0'] as any).params[1].filters.tokenAccounts='all';},
  r=>{(r.requests['bulk-page-0'] as any).params[1].filters.slot.gte++;},
  r=>{(r.requests['bulk-page-0'] as any).params[1].limit=501;},
  r=>{(r.requests['wallet-page-0'] as any).params[1].minContextSlot--;},
  r=>{r.roleIndexBefore=null;},
  r=>{changePlain(r,'owner-catalog',v=>{v.result.context.slot++;});},
  r=>{changePlain(r,'ata-head',v=>{v.result.context.slot--;});},
  r=>{changePlain(r,'state-block-time',v=>{v.result=Math.floor(Date.parse(r.interval.end)/1000)-1;});},
  r=>{changePlain(r,'wallet-page-0',v=>{v.result[0].err={InstructionError:[0,'InvalidArgument']};});},
  r=>{changePlain(r,'wallet-page-0',v=>{v.result[0].confirmationStatus='confirmed';});},
  r=>{changePlain(r,'wallet-page-0',v=>{v.result[0].slot=r.stateSlot+1;});},
  r=>{changePlain(r,'wallet-page-0',v=>{v.result.push(v.result[0]);});},
  r=>{changeBulk(r,v=>{v.result.data.pop();});},
  r=>{changeBulk(r,v=>{v.result.data[0].transactionIndex++;});},
  r=>{changeBulk(r,v=>{v.result.data[0].blockTime++;});},
  r=>{changeBulk(r,v=>{v.result.data.at(-1).meta.fee++;});},
  r=>{changeBulk(r,v=>{v.result.data[0].meta.err={InstructionError:[0,'InvalidArgument']};});},
  r=>{changeBulk(r,v=>{v.result.data.reverse();});},
  r=>{changeBulk(r,v=>{v.result.paginationToken='0:0';});},
  r=>{delete r.requests['bulk-page-1'];delete r.rawArtifacts['bulk-page-1'];delete r.retrievedAt['bulk-page-1'];},
  r=>{r.retrievedAt['bulk-page-0']='2026-09-13T19:45:18Z';},
 ];
 for(const change of changes){const r=structuredClone(f.receipts);change(r);assert.throws(()=>visitO24BulkSources(r,f.cutoff));}
}));

test('source identity and original acquisition clocks remain bound to the imported storage descriptor',()=>capture(f=>{
 const {rawArtifacts,retrievedAt,...header}=f.receipts,artifactIds=Object.fromEntries(Object.keys(f.receipts.requests).map(local=>[local,O24_BULK_PREFIX+local])),raw=Object.fromEntries(Object.entries(artifactIds).map(([local,id])=>[id,rawArtifacts[local]!]));
 const evidence:any[]=Object.entries(artifactIds).map(([local,id])=>({id,sourceId:O24_BULK_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:O24_BULK_ADAPTER,availableAt:retrievedAt[local],retrievedAt:retrievedAt[local],contentHash:hash(raw[id]!),scope:{request:f.receipts.requests[local]}}));
 assert.equal(validateO24BulkStorage({...header,artifactIds},raw,evidence,f.cutoff).size,evidence.length);
 const changed=structuredClone(evidence);changed[0].scope.request={method:'getGenesisHash',params:['other']};assert.throws(()=>validateO24BulkStorage({...header,artifactIds},raw,changed,f.cutoff),/STORAGE_RECORD/);
 const context=visitO24BulkSources(f.receipts,f.cutoff),later=structuredClone(f.receipts);later.retrievedAt.genesis=new Date(Date.parse(later.retrievedAt.genesis!)+1).toISOString();assert.notEqual(visitO24BulkSources(later,f.cutoff).receiptManifestHash,context.receiptManifestHash);
}));
