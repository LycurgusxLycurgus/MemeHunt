import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {loadInventoryReturnCapture} from '../src/providers/advisory-inventory-returns-import.js';
import {decodeInventoryReturnSource} from '../src/providers/advisory-inventory-returns-source.js';
import {a29LiveFetcher} from './a29-fixtures.js';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
/** Three genuine native getTransaction envelopes, one genuine compiled envelope and genuine endpoint indexes.
 * Only the selected-pool index is a CONSTRUCTED SMALL census. Never the actual1038trade/289endpoint hour.
 */
export function inventoryReturnsFixture():any{return JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-inventory-returns-small.json',import.meta.url),'utf8'));}
export function createO26InventoryCapture(directory:string){
 mkdirSync(directory,{recursive:true});const fixture=inventoryReturnsFixture(),records=fixture.records,bytes=Buffer.from(JSON.stringify({method:'o26-local-retained-rpc-records-v1',records})),archive=deflateRawSync(bytes),chunk={id:'chunk-0',file:'chunk-0.deflate',encoding:'DEFLATE_RAW_BINARY',sourceBytes:bytes.length,sourceHash:sha(bytes),archiveBytes:archive.length,archiveHash:sha(archive),recordKeys:records.map((r:any)=>r.key)},recordCounts:Record<string,number>={WINDOW:0,INDEX:0,OFFPOOL:0,COMPILED_POOL:0,COMPILED_OFFPOOL:0};
 for(const r of records)recordCounts[r.kind]=(recordCounts[r.kind]??0)+1;
 const manifest={...fixture.header,recordCounts,nativeRecords:records.length,nativeSourceBytes:records.reduce((n:number,r:any)=>n+r.sourceBytes,0),chunks:[chunk]};writeFileSync(join(directory,'capture.json'),JSON.stringify(manifest,null,2)+'\n');writeFileSync(join(directory,'chunk-0.deflate'),archive);
 const token=fixture.header.token,cutoff=fixture.cutoff,receipts=loadInventoryReturnCapture(directory,token,cutoff),context=decodeInventoryReturnSource(receipts,cutoff),fallback=a29LiveFetcher(token.address,cutoff),calls:Array<{method:string;params:any[]}>=[];
 const fetcher:typeof fetch=async(input,init)=>{if(init?.method==='POST'&&typeof init.body==='string'){const request=JSON.parse(init.body);if(request.method)calls.push(request);}return fallback(input,init);};
 return {receipts,source:receipts,context,token,cutoff,fixture,manifest,directory,fetcher,calls};
}
