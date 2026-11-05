import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createO23BulkCapture} from './synchrony-bulk-fixtures.js';
import {deriveO23BulkSynchrony,unpackO23BulkSource,O23_BULK_ARCHIVE_METHOD,type O23BulkReceipts} from '../src/providers/advisory-synchrony-bulk.js';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
function archive(source:string){return JSON.stringify({method:O23_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:Buffer.byteLength(source),sourceHash:sha(source),data:deflateRawSync(Buffer.from(source)).toString('base64')});}
function fixture(run:(f:ReturnType<typeof createO23BulkCapture>)=>void,options?:Parameters<typeof createO23BulkCapture>[1]){const d=mkdtempSync(join(tmpdir(),'o23-bulk-provider-'));try{run(createO23BulkCapture(d,options));}finally{rmSync(d,{recursive:true,force:true});}}
function changeBulk(r:O23BulkReceipts,change:(response:any)=>void){const id='bulk-page-0',response=JSON.parse(unpackO23BulkSource(r.rawArtifacts[id]!,true));change(response);r.rawArtifacts[id]=archive(JSON.stringify(response));}
const derive=(r:O23BulkReceipts,cutoff:string)=>deriveO23BulkSynchrony(r,cutoff,['imported-source']);

test('all21 actual residual transactions support only the new complete count tape with exact source evidence',()=>fixture(f=>{
 const metric=derive(f.receipts,f.cutoff),data=metric.data as any;
 assert.equal(metric.id,'O23');assert.equal(metric.quality,'KNOWN');assert.equal(data.method,'sponsored-fee-payer-synchrony-v2');assert.equal(data.scope,'HISTORICAL_FIXED_12H_POOL_TAPE');assert.equal(data.sourceTrust,'RETAINED_PROVIDER_RPC_IMPORT');
 assert.equal(data.coverage.successfulReferences,21);assert.equal(data.coverage.bulkBodies,21);assert.equal(data.coverage.unresolvedTransactions,0);assert.equal(data.denominator,20);assert.equal(data.bins.length,5);assert.ok(data.bins.every((b:any)=>b.null.permutations===999));assert.ok(data.pairedClocks.differentFromIndex>=5);
 assert.equal(data.commonControl,null);assert.equal(data.coordination,null);assert.doesNotMatch(JSON.stringify(data),/buyQuoteAtomic|sellQuoteAtomic|netQuoteAtomic|coreQuoteAtomic|walletQuoteAtomic/);
}));

test('bulk archive is exact UTF8/source-hashed canonical base64 and rejects trailing deflate bytes',()=>{
 const raw=JSON.stringify({jsonrpc:'2.0',id:1,result:{data:[],paginationToken:null}}),valid=archive(raw);assert.equal(unpackO23BulkSource(valid,true),raw);
 for(const mutate of [(c:any)=>{c.data+='=';},(c:any)=>{c.sourceHash='0'.repeat(64);},(c:any)=>{c.sourceBytes++;},(c:any)=>{c.data=Buffer.concat([Buffer.from(c.data,'base64'),Buffer.from('tail')]).toString('base64');},(c:any)=>{c.sourceBytes=32_000_001;}]){const c=JSON.parse(valid);mutate(c);assert.throws(()=>unpackO23BulkSource(JSON.stringify(c),true),/ADVISORY_SYNCHRONY_BULK_/);}
 assert.throws(()=>unpackO23BulkSource(valid+' ',true),/ARCHIVE_CANONICAL/);
 const invalid=Buffer.from([0xc3,0x28]);assert.throws(()=>unpackO23BulkSource(JSON.stringify({method:O23_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:invalid.length,sourceHash:sha(invalid),data:deflateRawSync(invalid).toString('base64')}),true),/UTF8/);
});

test('exact request, fixed cohort, terminal cursor and success-body bijection cannot be weakened',()=>fixture(f=>{
 const changes:Array<(r:O23BulkReceipts)=>void>=[
 r=>{(r.requests['bulk-page-0']!.params[1] as any).limit=501;},
 r=>{(r.requests['bulk-page-0']!.params[1] as any).filters.tokenAccounts='all';},
 r=>{r.range.start=new Date(Date.parse(r.range.start)+1000).toISOString();},
 r=>{changeBulk(r,v=>{v.result.data.pop();});},
 r=>{changeBulk(r,v=>{v.result.data.push(v.result.data[0]);});},
 r=>{changeBulk(r,v=>{v.result.data[0].slot++;});},
 r=>{changeBulk(r,v=>{v.result.data[0].blockTime++;});},
 r=>{changeBulk(r,v=>{v.result.data[0].meta.err={InstructionError:[0,'Custom']};});},
 r=>{changeBulk(r,v=>{v.result.paginationToken='0:0';});},
 r=>{r.rawArtifacts['bulk-page-1']=r.rawArtifacts['bulk-page-0']!;r.requests['bulk-page-1']=structuredClone(r.requests['bulk-page-0']!);r.retrievedAt['bulk-page-1']=r.retrievedAt['bulk-page-0']!;},
 r=>{const v=JSON.parse(r.rawArtifacts['index-page-0']!);v.result[0].confirmationStatus='confirmed';r.rawArtifacts['index-page-0']=JSON.stringify(v);},
 ];
 for(const change of changes){const r=structuredClone(f.receipts);change(r);assert.throws(()=>derive(r,f.cutoff),/ADVISORY_SYNCHRONY_BULK_/);}
}));

test('compiled fallback retains exact native metadata, keyflags and typed instruction parity',()=>fixture(f=>{
 const id=Object.keys(f.receipts.requests).find(id=>id.startsWith('compiled-'))!;assert.ok(id);
 for(const change of [(v:any)=>{v.result.meta.fee++;},(v:any)=>{v.result.slot++;},(v:any)=>{v.result.transaction.signatures[0]=v.result.transaction.signatures[1]??'1'.repeat(64);},(v:any)=>{v.result.meta.loadedAddresses={readonly:['11111111111111111111111111111111'],writable:[]};},(v:any)=>{v.result.meta.innerInstructions[0].instructions[0].data='1';}]){
  const r=structuredClone(f.receipts),v=JSON.parse(r.rawArtifacts[id]!);change(v);r.rawArtifacts[id]=JSON.stringify(v);assert.throws(()=>derive(r,f.cutoff),/ADVISORY_SYNCHRONY_BULK_/);
 }
}));

test('source-valid unprovable fee role keeps every fraction null instead of shrinking the tape',()=>fixture(f=>{
 const r=structuredClone(f.receipts);changeBulk(r,v=>{v.result.data[0].transaction.message.accountKeys[0].signer=false;});const metric=derive(r,f.cutoff),data=metric.data as any;
 assert.equal(metric.quality,'MISSING');assert.equal(data.denominator,null);assert.equal(data.fundingClasses,null);assert.equal(data.seed,null);assert.ok(data.bins.every((b:any)=>b.fraction===null&&b.null===null));assert.ok(data.coverage.unresolvedTransactions>0);
},{caseIndexes:[0],companions:false}));

test('closed native parser equivalence binds multisig authority/signers and amounts without dropping raw account tails',()=>fixture(f=>{
 const companionSignatures=new Set(Object.entries(f.receipts.requests).filter(([id])=>id.startsWith('compiled-')).map(([,request])=>request.params[0]));
 const instructions=(v:any)=>v.result.data.filter((tx:any)=>companionSignatures.has(tx.transaction.signatures[0])).flatMap((tx:any)=>[...tx.transaction.message.instructions,...tx.meta.innerInstructions.flatMap((g:any)=>g.instructions)]);
 for(const mutate of [(v:any)=>{const ix=instructions(v).find((i:any)=>i.parsed?.info?.multisigAuthority);assert.ok(ix);ix.parsed.info.multisigAuthority='11111111111111111111111111111111';},(v:any)=>{const ix=instructions(v).find((i:any)=>i.parsed?.info?.multisigAuthority);assert.ok(ix);ix.parsed.info.signers=[];},(v:any)=>{const ix=instructions(v).find((i:any)=>i.parsed?.info?.multisigAuthority);assert.ok(ix);ix.parsed.info.tokenAmount.amount='1';},(v:any)=>{const ix=instructions(v).find((i:any)=>i.programId==='11111111111111111111111111111111'&&i.parsed?.type==='transfer');assert.ok(ix);ix.parsed.info.lamports++;}]){const r=structuredClone(f.receipts);changeBulk(r,mutate);assert.throws(()=>derive(r,f.cutoff),/COMPANION_INSTRUCTION_PARITY/);}
}));

test('receipt request/clock/hash manifest remains part of reconstructed metric provenance',()=>fixture(f=>{
 const original=derive(f.receipts,f.cutoff),r=structuredClone(f.receipts);r.retrievedAt.genesis=new Date(Date.parse(r.retrievedAt.genesis!)+1).toISOString();const changed=derive(r,f.cutoff);
 assert.equal(changed.quality,'KNOWN');assert.notEqual((original.data as any).coverage.receiptManifestHash,(changed.data as any).coverage.receiptManifestHash);
}));
