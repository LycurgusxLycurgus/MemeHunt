import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {loadHolderAgeCapture} from '../src/providers/advisory-holder-age-import.js';
import {decodeHolderAgeSource} from '../src/providers/advisory-holder-age-source.js';
import {unpackHolderPopulation} from '../src/providers/advisory-topology.js';
import {a29LiveFetcher} from './a29-fixtures.js';
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
export type HolderAgeFixtureMode='claudecoin'|'mixed';
/** ClaudeCoin keeps the genuine full115-owner population and history. Mixed uses explicitly
 * CONSTRUCTED five-owner balances/mint supply with unchanged genuine C5 history responses.
 * Neither fixture's deterministic packaging clock is a provider retrieval claim.
 */
export function holderAgeFixture(mode:HolderAgeFixtureMode='mixed'):any{
 return JSON.parse(readFileSync(new URL(`../../tests/fixtures/advisory-holder-age-${mode}.json`,import.meta.url),'utf8'));
}
/** A test-local source container, not a native RPC envelope. Used by source mutations as well. */
export function writeHolderAgeCapture(directory:string,fixture:any){
 mkdirSync(directory,{recursive:true});const records=fixture.records as any[],keys=records.map(r=>r.key),bytes=Buffer.from(JSON.stringify({method:'o22-local-retained-reference-records-v1',records})),archive=deflateRawSync(bytes);
 const chunk={id:'chunk-0',file:'chunk-0.deflate',encoding:'DEFLATE_RAW_BINARY',sourceBytes:bytes.length,sourceHash:sha(bytes),archiveBytes:archive.length,archiveHash:sha(archive),recordCount:records.length,recordKeysHash:sha(JSON.stringify(keys))};
 const recordCounts:Record<string,number>={ORIGIN:0,BANK_TIME:0,FIRST:0,OLD_PREFIX:0,BEFORE:0,OLDER:0};for(const r of records)recordCounts[r.kind]=(recordCounts[r.kind]??0)+1;
 const nativeSourceBytes=records.reduce((n,r)=>n+Buffer.byteLength(r.kind==='ORIGIN'&&r.id==='rpc-holder-population'&&r.evidence.adapterVersion==='holder-population-archive-v1'?unpackHolderPopulation(r.raw):r.raw),0);
 const manifest={...fixture.header,recordCounts,nativeRecords:records.length,nativeSourceBytes,chunks:[chunk]};writeFileSync(join(directory,'capture.json'),JSON.stringify(manifest,null,2)+'\n');writeFileSync(join(directory,'chunk-0.deflate'),archive);return manifest;
}
export function createHolderAgeFixture(directory:string,mode:HolderAgeFixtureMode='mixed'){
 const fixture=holderAgeFixture(mode),manifest=writeHolderAgeCapture(directory,fixture),token=fixture.header.token,cutoff=fixture.cutoff,receipts=loadHolderAgeCapture(directory,token,cutoff),context=decodeHolderAgeSource(receipts,cutoff),fallback=a29LiveFetcher(token.address,cutoff),calls:Array<{method:string;params:any[]}>=[];
 const fetcher:typeof fetch=async(input,init)=>{if(init?.method==='POST'&&typeof init.body==='string'){const request=JSON.parse(init.body);if(request.method)calls.push(request);}return fallback(input,init);};
 return {token,cutoff,directory,receipts,context,fetcher,calls,fixture,manifest};
}
