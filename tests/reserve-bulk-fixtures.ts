import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {bulkSha,createO23BulkCapture} from './synchrony-bulk-fixtures.js';

/** Three exact contiguous native bulk rows, not a complete historical tape or fabricated getTransaction responses. */
export function reserveContiguousFixture():any{
 return JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-reserve-bulk-contiguous.json',import.meta.url),'utf8'));
}
/** CONSTRUCTED complete12h subset census/envelopes over three contiguous actual public transactions.
 * Native transaction/meta/slot/blockTime/version/index objects and their source provenance stay exact.
 * Reuses the accepted O23 portable header/final-bank harness; this is codec evidence, never wholehistory acceptance.
 */
export function createO29BulkCapture(directory:string){
 const f=createO23BulkCapture(directory,{caseIndexes:[]}),fixture=reserveContiguousFixture();
 const txs=structuredClone(fixture.transactions),index=txs.map((tx:any)=>({signature:tx.transaction.signatures[0],slot:tx.slot,blockTime:tx.blockTime,err:null,confirmationStatus:'finalized'}));
 for(const[id,result,compressed]of [['index-page-0',index,false],['bulk-page-0',{data:txs,paginationToken:null},true]] as const){
  const receipt=f.manifest.receipts.find((r:any)=>r.id===id)!;
  const raw=JSON.stringify({jsonrpc:'2.0',id:1,result}),source=Buffer.from(raw),archive=compressed?deflateRawSync(source):source;
  receipt.sourceBytes=source.length;receipt.sourceHash=bulkSha(source);
  if(compressed){receipt.archiveBytes=archive.length;receipt.archiveHash=bulkSha(archive);receipt.retrievedAt=fixture.bulkSource.retrievedAt;}
  writeFileSync(join(directory,receipt.file),archive);
  f.source.rawArtifacts[id]=compressed?JSON.stringify({method:'o23-deflate-raw-v1',encoding:'DEFLATE_RAW_BASE64',sourceBytes:source.length,sourceHash:receipt.sourceHash,data:archive.toString('base64')}):raw;
  f.source.retrievedAt[id]=receipt.retrievedAt;
 }
 writeFileSync(join(directory,'capture.json'),JSON.stringify(f.manifest));
 return {...f,fixture};
}
