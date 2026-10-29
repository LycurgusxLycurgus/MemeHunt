import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {deflateRawSync} from 'node:zlib';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
import {a29LiveFetcher} from './a29-fixtures.js';
import type {O23BulkReceipts} from '../src/providers/advisory-synchrony-bulk.js';

export const bulkSha=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex');
/** Exact native public rows, projected from bulk responses. Not RPC getTransaction envelopes and not a complete tape. */
export function synchronyResidualFixture():any{
 return JSON.parse(readFileSync(fileURLToPath(new URL('../../tests/fixtures/advisory-synchrony-bulk-residuals.json',import.meta.url)),'utf8'));
}
const rpc=(result:unknown)=>JSON.stringify({jsonrpc:'2.0',id:1,result});

/** CONSTRUCTED census and bulk envelopes over an explicitly selected public-source subset.
 * Original native transaction objects/compiled bytes remain unchanged. These envelopes and
 * import clocks test the codec only; they are not the captured 57,642-body historical tape.
 */
export function createO23BulkCapture(directory:string,options:{caseIndexes?:number[];companions?:boolean}={}){
 mkdirSync(directory,{recursive:true});
 const fixture=synchronyResidualFixture(),token={chain:'solana' as const,address:fixture.token};
 const selected=(options.caseIndexes??fixture.cases.map((_:unknown,i:number)=>i)).map((i:number)=>fixture.cases[i]);
 const txs=selected.map((c:any)=>structuredClone(c.transaction)).sort((a:any,b:any)=>b.slot-a.slot||b.transactionIndex-a.transactionIndex);
 const range=fixture.range,anchorSlot=461595156,cutoff='2026-10-29T16:00:00.000Z';
 const requests:O23BulkReceipts['requests']={},rawArtifacts:Record<string,string>={},retrievedAt:Record<string,string>={},receipts:any[]=[];
 const put=(id:string,request:{method:string;params:unknown[]},raw:string,at:string,compressed=false)=>{
  requests[id]=request;retrievedAt[id]=at;
  const file=id+(compressed?'.deflate':'.json'),source=Buffer.from(raw),archive=compressed?deflateRawSync(source):source;
  writeFileSync(join(directory,file),archive);
  receipts.push({id,request,retrievedAt:at,file,encoding:compressed?'DEFLATE_RAW_BINARY':'PLAIN',sourceBytes:source.length,sourceHash:bulkSha(source),...(compressed?{archiveBytes:archive.length,archiveHash:bulkSha(archive)}:{})});
  rawArtifacts[id]=compressed?JSON.stringify({method:'o23-deflate-raw-v1',encoding:'DEFLATE_RAW_BASE64',sourceBytes:source.length,sourceHash:bulkSha(source),data:archive.toString('base64')}):raw;
 };
 put('genesis',{method:'getGenesisHash',params:[]},rpc(SOLANA_MAINNET_GENESIS),'2026-10-29T14:00:00.000Z');
 put('anchor-slot',{method:'getSlot',params:[{commitment:'finalized'}]},rpc(anchorSlot),'2026-10-29T14:00:01.000Z');
 put('anchor-time',{method:'getBlockTime',params:[anchorSlot]},rpc(Date.parse(range.end)/1000+30),'2026-10-29T14:00:02.000Z');
 const index=txs.map((tx:any)=>({signature:tx.transaction.signatures[0],slot:tx.slot,blockTime:tx.blockTime,err:null,confirmationStatus:'finalized'}));
 put('index-page-0',{method:'getSignaturesForAddress',params:[fixture.pool,{commitment:'finalized',limit:1000,minContextSlot:anchorSlot}]},rpc(index),'2026-10-29T14:00:03.000Z');
 put('bulk-page-0',{method:'getTransactionsForAddress',params:[fixture.pool,{transactionDetails:'full',encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized',minContextSlot:anchorSlot,sortOrder:'desc',limit:500,filters:{blockTime:{gte:Date.parse(range.start)/1000,lt:Date.parse(range.end)/1000},status:'succeeded',tokenAccounts:'none'}}]},rpc({data:txs,paginationToken:null}),'2026-10-29T14:01:00.000Z',true);
 if(options.companions!==false){let n=0;for(const c of selected)if(c.compiled)put('compiled-'+n++,c.compiled.receipt.request,c.compiled.raw,c.compiled.receipt.retrievedAt);}
 // Reconstructed bank envelope uses retained public state with a CONSTRUCTED post-source receipt clock.
 put('pool',{method:'getMultipleAccounts',params:[[fixture.pool,'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'],{encoding:'base64',commitment:'finalized'}]},fixture.poolSource.raw,'2026-10-29T15:59:00.000Z');
 const manifest={method:'o23-complete-quote-tape-v1' as const,token,pool:fixture.pool,range,anchorSlot,receipts};
 writeFileSync(join(directory,'capture.json'),JSON.stringify(manifest));
 const source:O23BulkReceipts={method:manifest.method,token,pool:fixture.pool,range,anchorSlot,requests,rawArtifacts,retrievedAt};
 const fallback=a29LiveFetcher(token.address,cutoff),calls:Array<{method:string;params:any[]}>=[];
 const fetcher:typeof fetch=async(input,init)=>{
  if(init?.method==='POST'){
   const req=JSON.parse(String(init.body));calls.push(req);
   if(req.method==='getSlot')return new Response(rpc(anchorSlot));
   if(req.method==='getBlockTime')return new Response(rpc(Date.parse(cutoff)/1000-10));
   if(req.method==='getMultipleAccounts'&&req.params[0][0]===fixture.pool&&req.params[0].length===2)return new Response(fixture.poolSource.raw);
   if(req.method==='getAccountInfo'&&req.params[0]===fixture.pool)return new Response(rpc({context:JSON.parse(fixture.poolSource.raw).result.context,value:JSON.parse(fixture.poolSource.raw).result.value[0]}));
  }
  const response=await fallback(input,init);return new Response((await response.text()).replaceAll('4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',fixture.pool).replaceAll('So11111111111111111111111111111111111111112','3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'));
 };
 return {fixture,token,cutoff,manifest,source,receipts:source,fetcher,calls,directory};
}
