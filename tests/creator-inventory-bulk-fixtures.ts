import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {bulkSha} from './synchrony-bulk-fixtures.js';
import {a29LiveFetcher} from './a29-fixtures.js';
import type {O24BulkReceipts} from '../src/providers/advisory-creator-inventory-bulk.js';

/** Genuine exact public sources. The small selected native body subset is never a complete real wallet history. */
export function creatorAbsenceFixture():any{
 return JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-creator-inventory-bulk-absence.json',import.meta.url),'utf8'));
}

/** CONSTRUCTED SMALL complete wallet census over seventeen genuine public bodies, not actual8577history.
 * Role discovery's original1000row index and all native objects/state sources remain exact and separate.
 * Imported source has no pool/tape descriptor. The ordinary live mock is independent and identical in51/54 comparisons.
 */
export function createO24InventoryCapture(directory:string){
 mkdirSync(directory,{recursive:true});
 const fixture=creatorAbsenceFixture(),token=fixture.token,cutoff='2026-10-29T18:00:00.000Z';
 const requests:Record<string,unknown>={},rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={},receipts:any[]=[];
 const put=(id:string,request:unknown,raw:string,at:string,compressed=false)=>{
  const file=id+(compressed?'.deflate':'.json'),source=Buffer.from(raw),archive=compressed?deflateRawSync(source):source;
  writeFileSync(join(directory,file),archive);requests[id]=request;retrievedAt[id]=at;
  receipts.push({id,request,retrievedAt:at,file,encoding:compressed?'DEFLATE_RAW_BINARY':'PLAIN',sourceBytes:source.length,sourceHash:bulkSha(source),...(compressed?{archiveBytes:archive.length,archiveHash:bulkSha(archive)}:{})});
  rawArtifacts[id]=compressed?JSON.stringify({method:'o23-deflate-raw-v1',encoding:'DEFLATE_RAW_BASE64',sourceBytes:source.length,sourceHash:bulkSha(source),data:archive.toString('base64')}):raw;
 };
 for(const id of ['genesis','state-block-time','ata-head','owner-catalog']){const s=fixture.state[id];put(id,s.receipt.request,s.raw,s.receipt.retrievedAt);}
 for(const[id,native]of [['role-page','creator-role-page'],['role-index','creator-role-wallet-index'],['role-transaction','creator-role-transaction']] as const)put(id,fixture.role.requests[native],fixture.role.rawArtifacts[native],fixture.role.retrievedAt[native]);
 const ata=fixture.state['ata-index'];put('ata-page-0',ata.receipt.request,ata.raw,ata.receipt.retrievedAt);
 const selected=[...fixture.gaps,...fixture.canonicalBodies,fixture.creation],bySignature=new Map<string,any>();for(const c of selected)bySignature.set(c.transaction.transaction.signatures[0],c);
 const native=[...bySignature.values()].sort((a,b)=>b.transaction.slot-a.transaction.slot||b.transaction.transactionIndex-a.transaction.transactionIndex),txs=native.map(c=>structuredClone(c.transaction));
 const index=txs.map(tx=>({signature:tx.transaction.signatures[0],slot:tx.slot,err:tx.meta.err,memo:null,blockTime:tx.blockTime,confirmationStatus:'finalized',transactionIndex:tx.transactionIndex}));
 // Exact genuine older native row provides the creation-crossing terminal witness; this census is constructed, not the9000row acquisition.
 index.push(structuredClone(fixture.preCreationTail));
 const rpc=(result:unknown)=>JSON.stringify({jsonrpc:'2.0',id:1,result});
 put('wallet-page-0',{method:'getSignaturesForAddress',params:[fixture.wallet,{limit:1000,commitment:'finalized',minContextSlot:fixture.stateSlot}]},rpc(index),'2026-10-29T16:27:00.000Z');
 const creationSlot=fixture.creation.transaction.slot,last=txs.at(-1)!,cursor=`${last.slot}:${last.transactionIndex}`;
 const bulkRequest=(paginationToken?:string)=>({method:'getTransactionsForAddress',params:[fixture.wallet,{transactionDetails:'full',encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized',minContextSlot:fixture.stateSlot,sortOrder:'desc',limit:500,...(paginationToken?{paginationToken}:{}),filters:{slot:{gte:creationSlot,lte:fixture.stateSlot},status:'succeeded',tokenAccounts:'none'}}]});
 const bulkClock=native.map(c=>c.source.retrievedAt).sort().at(-1)!;
 put('bulk-page-0',bulkRequest(),rpc({data:txs,paginationToken:cursor}),bulkClock,true);
 put('bulk-page-1',bulkRequest(cursor),rpc({data:[],paginationToken:null}),bulkClock,true);
 const header={method:'o24-creator-wallet-absence-v2' as const,token,wallet:fixture.wallet,interval:fixture.interval,stateSlot:fixture.stateSlot,stateFloorSlot:fixture.stateFloorSlot,roleIndexBefore:fixture.roleIndexBefore};
 const manifest={...header,receipts};writeFileSync(join(directory,'capture.json'),JSON.stringify(manifest));
 const source:O24BulkReceipts={...header,requests,rawArtifacts,retrievedAt};
 const fallback=a29LiveFetcher(token.address,cutoff),calls:Array<{method:string;params:any[]}>=[];
 const fetcher:typeof fetch=async(input,init)=>{if(init?.method==='POST'&&typeof init.body==='string'){const request=JSON.parse(init.body);if(request.method)calls.push(request);}return fallback(input,init);};
 return {fixture,token,cutoff,manifest,source,receipts:source,fetcher,calls,directory};
}
