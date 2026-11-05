import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync,deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {decodeS15ReferenceCapture,loadS15ReferenceCapture,projectS15Lifetime,S15_REFERENCE_CAPTURE_ID,type S15ReferenceCapture} from '../src/providers/advisory-creator-reference-import.js';
import {deriveS15ReferenceBook,validateS15ReferenceSource,s15ReferencePrices,s15NativeCommitments} from '../src/providers/advisory-creator-reference-source.js';
const RAW=gunzipSync(readFileSync('tests/fixtures/s15-target-reference-book.json.gz')).toString('utf8'),CUT='2026-11-03T00:00:00.000Z',TOKEN={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},POOL='3M9sVgL4u6ATKaiExf3XhQqNfMB6ijvzk3meMcQaen1w';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
function mutate(id:string,edit:(raw:string)=>string){const c=JSON.parse(RAW) as S15ReferenceCapture,r=c.records.find(r=>r.id===id)!,text=decodeS15ReferenceCapture(RAW,CUT).decodedRecords.find(r=>r.id===id)!.raw,raw=edit(text),packed=deflateRawSync(Buffer.from(raw));r.encoding='DEFLATE_RAW_BASE64';r.data=packed.toString('base64');r.archiveBytes=packed.length;r.archiveHash=sha(packed);r.sourceBytes=Buffer.byteLength(raw);r.sourceHash=sha(raw);if(r.receipt){const p=r.receipt as any;if(p.response){p.response.bytes=r.sourceBytes;p.response.sha256=r.sourceHash;}else{p.bytes=r.sourceBytes;p.sha256=r.sourceHash;}}return JSON.stringify(c);}
test('genuine portable corpus reconstructs reference principal and all native canonical lifecycle cash independently',()=>{
 const {capture,metric}=validateS15ReferenceSource(RAW,TOKEN,CUT,[S15_REFERENCE_CAPTURE_ID]);assert.equal(capture.records.length,236);assert.equal(metric.quality,'KNOWN',metric.reasonCode);const d=metric.data as any;
 assert.equal(d.method,'creator-target-reference-book-v1');assert.equal(d.status,'COMPLETE');assert.equal(d.completeReferenceBook,true);assert.equal(d.aggregateNetProfit,null);assert.equal(d.book.referenceValues.length,207);assert.equal(d.book.acquisitions.length,108);assert.equal(d.book.fifo.length,123);assert.equal(d.book.sales.length,113);assert.equal(d.book.transfers.length,1);
 assert.deepEqual(d.book.totals.acquisitionBasisUsd,{numerator:'11949768674804193210047491621',denominator:'500000000000000000000000'});assert.deepEqual(d.book.totals.realizedPrincipalReferenceResultUsd,{numerator:'604445260150506610181336993604356341167',denominator:'329690992408843750000000000000000000'});assert.deepEqual(d.book.totals.carriedTransferBasisUsd,{numerator:'58023672448125247215807',denominator:'42200447028332000000'});
 assert.equal(d.nativeCash.rows.length,156);assert.deepEqual(d.nativeCash.canonical,{transactions:136,actorSystemDeltaLamports:'237712018158',reportedOwnedWsolDeltaAtomic:'0',actorNetworkFeeLamports:'12867207'});assert.deepEqual(d.nativeCash.noncanonical,{transactions:20,actorSystemDeltaLamports:'-143474310',reportedOwnedWsolDeltaAtomic:'0',actorNetworkFeeLamports:'180150'});assert.equal(d.nativeCash.total.actorSystemDeltaLamports,'237568543848');assert.equal(d.nativeCash.total.actorNetworkFeeLamports,'13047357');assert.equal(d.nativeCash.canonicalLifecycleOnlySignatures.length,7);
 for(const signature of d.nativeCash.canonicalLifecycleOnlySignatures){assert.equal(d.nativeCash.rows.find((r:any)=>r.signature===signature).canonicalIndexed,true);assert.ok(!d.book.referenceValues.some((r:any)=>r.signature===signature));}
 assert.equal(d.failed.observation.status,'INCOMPLETE');assert.equal(d.failed.observation.failedTargetAssociatedChargedTransactionOverheadLamports,null);assert.equal(d.failed.observation.rows.length,187);assert.equal(d.failed.observedActorChargedLamports,'28058052');assert.equal(d.failed.allocation,'UNALLOCATED_WALLET_OVERHEAD');assert.equal(d.failed.provenance.filter((r:any)=>r.primaryResultNull).length,2);
 assert.equal(d.nativeCosts.rows.length,634);assert.equal(d.nativeCosts.canonicalRefunds.length,7);assert.equal(d.nativeCosts.canonicalRefundTotalLamports,'10596880');assert.equal(d.nativeCosts.truncatedTraces,13);assert.equal(d.sourceCoverage.successfulWalletBodies,8577);assert.equal(d.sourceCoverage.nativeReferencePoints,372);assert.equal(d.sourceCoverage.targetReferenceBars,1000);
});
test('bounded archive projection preserves original nineteen archives and manifests without external old authority',()=>{
 const c=decodeS15ReferenceCapture(RAW,CUT),p=projectS15Lifetime(c,CUT);assert.equal(Object.keys(p.inventory.requests).length,36);assert.equal(Object.keys(p.inventory.rawArtifacts).filter(k=>k.startsWith('bulk-page-')).length,19);assert.equal(p.inventory.stateSlot,462945391);
 const bad=JSON.parse(RAW) as S15ReferenceCapture,r=bad.records.find(r=>r.encoding==='DEFLATE_RAW_BASE64')!,bytes=Buffer.concat([Buffer.from(r.data,'base64'),Buffer.from('extra')]);r.data=bytes.toString('base64');r.archiveBytes=bytes.length;r.archiveHash=sha(bytes);assert.throws(()=>decodeS15ReferenceCapture(JSON.stringify(bad),CUT),/ARCHIVE_TRAILING/);
 const missing=JSON.parse(RAW);missing.records.pop();assert.throws(()=>decodeS15ReferenceCapture(JSON.stringify(missing),CUT),/DUPLICATE_MISSING_OR_ORPHAN/);
});
test('every failed source is required even while unresolved target purpose retains a known charge',()=>{
 const c=JSON.parse(RAW) as S15ReferenceCapture;const id=c.failed.primaryRecordIds[0]!;c.records=c.records.filter(r=>r.id!==id);const m=deriveS15ReferenceBook(JSON.stringify(c),TOKEN,CUT,[S15_REFERENCE_CAPTURE_ID]);assert.equal(m.quality,'MISSING');assert.equal((m.data as any).completeReferenceBook,false);assert.equal((m.data as any).book,null);
 const forged=JSON.parse(RAW);forged.failed.archiveRecordIds.push(forged.failed.primaryRecordIds[0]);assert.equal(deriveS15ReferenceBook(JSON.stringify(forged),TOKEN,CUT,[]).quality,'MISSING');
});
test('price source validates literal native mint, canonical pool, original lexemes and explicit empty witness',()=>{
 const c=decodeS15ReferenceCapture(RAW,CUT),series=s15ReferencePrices(c,POOL);assert.equal(series.native.length,372);assert.equal(series.target.length,1000);assert.ok(series.native.some(p=>p.priceLexeme==='80304.22228202538'));assert.equal(series.target[0]!.endUnix-series.target[0]!.startUnix,60);
 const bad=JSON.parse(RAW) as S15ReferenceCapture;const target=bad.records.find(r=>r.id==='price-2')!;(target.request as any).url=(target.request as any).url.replace(TOKEN.address,'11111111111111111111111111111111');assert.throws(()=>decodeS15ReferenceCapture(JSON.stringify(bad),CUT),/OBSERVATION_BINDING/);
 // Constructed request and its observation must agree before testing the independent native identity guard.
 target.receipt!.request=structuredClone(target.request);assert.throws(()=>s15ReferencePrices(decodeS15ReferenceCapture(JSON.stringify(bad),CUT),POOL),/TARGET_PRICE_REQUEST/);
 const nonempty=mutate('price-6',raw=>raw.replace('{}','{"solana:So11111111111111111111111111111111111111112":{"decimals":9,"prices":[]}}'));assert.throws(()=>s15ReferencePrices(decodeS15ReferenceCapture(nonempty,CUT),POOL),/PRICE_RESPONSE_IDENTITY|OPTIONAL_EMPTY_HISTORY/);
});
test('caught failed ancestor rolls back child; truncated unlogged inner work remains unknown',()=>{
 const A='11111111111111111111111111111111',B='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',C='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
 const tx={transaction:{message:{instructions:[{programId:A}]}},meta:{err:null,innerInstructions:[{index:0,instructions:[{programId:B,stackHeight:2},{programId:C,stackHeight:3}]}],logMessages:[`Program ${A} invoke [1]`,`Program ${B} invoke [2]`,`Program ${C} invoke [3]`,`Program ${C} success`,`Program ${B} failed: custom program error: 1`,`Program ${A} success`]}};
 assert.deepEqual(s15NativeCommitments(tx).steps.map(s=>s.commitment),['COMMITTED','ROLLED_BACK','ROLLED_BACK']);tx.meta.logMessages=[`Program ${A} invoke [1]`,'Log truncated'];assert.deepEqual(s15NativeCommitments(tx).steps.map(s=>s.commitment),['COMMITTED','UNKNOWN_INNER_COMMITMENT','UNKNOWN_INNER_COMMITMENT']);
});
test('file import rejects symlink/cross-mint/backdated capture before ordinary acquisition',()=>{
 const dir=mkdtempSync(join(tmpdir(),'s15-reference-'));try{const file=join(dir,'source.json');writeFileSync(file,RAW);symlinkSync(file,join(dir,'link'));assert.throws(()=>loadS15ReferenceCapture(join(dir,'link'),TOKEN,CUT),/SOURCE_FILE/);assert.throws(()=>loadS15ReferenceCapture(file,{chain:'solana',address:'11111111111111111111111111111111'},CUT),/SOURCE_TOKEN/);assert.throws(()=>loadS15ReferenceCapture(file,TOKEN,'2026-11-01T00:00:00.000Z'),/TOKEN_OR_CLOCK/);}finally{rmSync(dir,{recursive:true,force:true});}
});
