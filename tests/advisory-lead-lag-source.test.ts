import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync,deflateRawSync} from 'node:zlib';
import {decodeA25LeadLagCapture,loadA25LeadLagCapture,A25_CAPTURE_ID,type A25LeadLagCapture} from '../src/providers/advisory-lead-lag-import.js';
import {deriveA25LeadLag,validateA25LeadLagSource} from '../src/providers/advisory-lead-lag-source.js';
const RAW=gunzipSync(readFileSync('tests/fixtures/a25-historical-lead-lag.json.gz')).toString('utf8');
const TOKEN={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},CUT='2026-11-03T00:00:00.000Z';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const capture=()=>JSON.parse(RAW) as A25LeadLagCapture;
function replace(c:A25LeadLagCapture,id:string,raw:string){const r=c.records.find(r=>r.id===id)!;r.encoding='PLAIN_UTF8';r.data=raw;r.sourceBytes=Buffer.byteLength(raw);r.sourceHash=sha(raw);delete r.archiveBytes;delete r.archiveHash;if(r.originalEvidence)r.originalEvidence.contentHash=r.sourceHash;return r;}
let genuine:ReturnType<typeof validateA25LeadLagSource>|undefined;
const resolved=()=>genuine??=validateA25LeadLagSource(RAW,TOKEN,CUT,[A25_CAPTURE_ID]);
test('genuine retained source reconstructs six historical posts, original clocks, dense full intersection and declared exploratory study',()=>{
 const {capture:c,metric}=resolved();assert.equal(c.records.length,29);assert.equal(Object.keys(c.social.records).length,21);assert.equal(metric.quality,'KNOWN',metric.reasonCode);const d=metric.data as any,p=d.provenance;
 assert.equal(d.method,'historical-observed-attention-price-lead-lag-v1');assert.equal(d.status,'COMPLETE');assert.equal(d.analysisClassification,'EXPLORATORY_SECONDARY_DESCRIPTIVE_ANALYSIS_WITH_LAGS_FROZEN_BEFORE_FIRST_CROSS_CORRELATION');assert.equal(p.baselineA16Promoted,false);assert.equal(p.retainedSocialSampleComplete,true);
 assert.equal(p.originalSocialCutoff,'2026-10-26T08:26:30.786Z');assert.deepEqual(p.originalSocialWindow,{start:'2026-10-25T08:24:15.121Z',end:'2026-10-26T08:24:15.121Z'});
 assert.equal(p.allPostDispositions.length,11);assert.equal(p.pageDispositions.length,7);assert.equal(p.qualifiedPosts.length,6);assert.equal(p.includedQualifiedPostCount,6);assert.equal(p.excludedFromIntersection.length,0);
 assert.deepEqual(p.qualifiedPosts.map((x:any)=>x.publishedAt),['2026-10-25T11:47:37.000Z','2026-10-25T14:17:30.000Z','2026-10-25T14:22:00.000Z','2026-10-25T15:04:41.000Z','2026-10-25T16:46:40.000Z','2026-10-25T16:54:55.000Z']);
 assert.equal(new Set(p.qualifiedPosts.map((x:any)=>x.url)).size,6);assert.equal(p.market.fullOriginalBarCount,1000);assert.equal(p.market.alignedCloseLexemes.length,577);assert.ok(p.market.alignedCloseLexemes.every((s:unknown)=>typeof s==='string'&&Number(s)>0));
 assert.deepEqual(d.study.window,{start:'2026-10-25T08:25:00.000Z',end:'2026-10-25T18:02:00.000Z',binSeconds:60,bins:577,differencedLength:576});
 assert.equal(p.market.otherReceiptObservations.length,1);assert.equal(p.market.otherReceiptObservations[0].status,400);assert.equal(p.market.otherReceiptObservations[0].role,'OUTSIDE_SELECTED_PRICE_UNIVERSE_METADATA_ONLY');
 assert.equal(p.bootstrapSeed.sourceHashes.length,24);assert.deepEqual(p.bootstrapSeed.sourceHashes,[...new Set(p.bootstrapSeed.sourceHashes)].sort());assert.match(p.bootstrapSeed.preimageSha256,/^[a-f0-9]{64}$/);assert.equal(p.registration.noPublicRegistryClaim,true);assert.equal(p.registration.notProspectivelyRegisteredBeforeHistoricalEvents,true);
 assert.equal(p.nativeIdentity.meaning,'STATIC_CANONICAL_POOL_IDENTITY_ONLY_NOT_HISTORICAL_PRICE_OR_WALLET_AUTHORITY');assert.equal(p.nativeIdentity.pool,'3M9sVgL4u6ATKaiExf3XhQqNfMB6ijvzk3meMcQaen1w');
});
test('portable full-consumption archives preserve every source and reject trailing compressed bytes, holes and clock forgery',()=>{
 const c=capture(),r=c.records.find(r=>r.encoding==='DEFLATE_RAW_BASE64')!,bytes=Buffer.concat([Buffer.from(r.data,'base64'),Buffer.from('trailing')]);r.data=bytes.toString('base64');r.archiveBytes=bytes.length;r.archiveHash=sha(bytes);assert.throws(()=>decodeA25LeadLagCapture(JSON.stringify(c),CUT),/ARCHIVE_TRAILING/);
 const missing=capture();missing.records.pop();assert.throws(()=>decodeA25LeadLagCapture(JSON.stringify(missing),CUT),/DUPLICATE_MISSING_OR_ORPHAN/);
 const duplicate=capture();duplicate.records.push(duplicate.records[0]!);assert.throws(()=>decodeA25LeadLagCapture(JSON.stringify(duplicate),CUT),/DUPLICATE_MISSING_OR_ORPHAN/);
 const clock=capture();clock.captureCreatedAt='2026-11-01T00:00:00.000Z';assert.throws(()=>decodeA25LeadLagCapture(JSON.stringify(clock),CUT),/RECORD_BOUND_OR_CLOCK/);
 const social=capture();social.records.find(r=>r.kind==='SOCIAL')!.originalEvidence!.availableAt='2026-11-02T00:00:00.000Z';assert.throws(()=>decodeA25LeadLagCapture(JSON.stringify(social),CUT),/SOCIAL_EVIDENCE/);
});
test('changing registration, historical read or body preimages cannot reroll the declared source profile',()=>{
 const c=capture(),decoded=decodeA25LeadLagCapture(RAW,CUT),profile=decoded.decodedRecords.find(r=>r.kind==='PROFILE')!;replace(c,profile.id,profile.raw+'\n');assert.throws(()=>validateA25LeadLagSource(JSON.stringify(c),TOKEN,CUT,[]),/REGISTRATION_HASH/);
 const body=capture(),id=body.social.records['advisory-executor-bodies']!,original=decoded.decodedRecords.find(r=>r.id===id)!;replace(body,id,original.raw+'\n');assert.throws(()=>validateA25LeadLagSource(JSON.stringify(body),TOKEN,CUT,[]),/ORIGINAL_SOCIAL_PREIMAGES/);
 const scope=capture();scope.social.originalCutoff='2026-10-26T08:26:31.786Z';assert.throws(()=>validateA25LeadLagSource(JSON.stringify(scope),TOKEN,CUT,[]),/HISTORICAL_SCOPE/);
 const evidence=capture();evidence.records.find(r=>r.originalEvidence?.id==='advisory-executor-capture')!.originalEvidence!.scope={method:'executor-semantic-v999'};assert.throws(()=>validateA25LeadLagSource(JSON.stringify(evidence),TOKEN,CUT,[]),/SOCIAL_CORE_EVIDENCE/);
});
test('literal market request binds pool/token and full original receipt before prices can enter statistics',()=>{
 const c=capture(),decoded=decodeA25LeadLagCapture(RAW,CUT),body=c.records.find(r=>r.id===c.market.bodyId)!;(body.request as any).url=(body.request as any).url.replace(TOKEN.address,'11111111111111111111111111111111');assert.throws(()=>validateA25LeadLagSource(JSON.stringify(c),TOKEN,CUT,[]),/MARKET_RECEIPT_BINDING/);
 const receipts=JSON.parse(decoded.decodedRecords.find(r=>r.id===c.market.receiptId)!.raw);receipts.find((r:any)=>r.sha256===body.sourceHash).request=structuredClone(body.request);replace(c,c.market.receiptId,JSON.stringify(receipts));assert.throws(()=>validateA25LeadLagSource(JSON.stringify(c),TOKEN,CUT,[]),/MARKET_REQUEST/);
 const changed=capture(),raw=decoded.decodedRecords.find(r=>r.id===changed.market.bodyId)!.raw;replace(changed,changed.market.bodyId,raw.replace('ohlcv_request_response','other'));const m=deriveA25LeadLag(JSON.stringify(changed),TOKEN,CUT,[A25_CAPTURE_ID]);assert.equal(m.quality,'MISSING');assert.equal((m.data as any).study,null);assert.match(m.reasonCode,/MARKET_SOURCE/);
});
test('original source clocks and seed are independent of capture paths, archive representation and current analysis cutoff',()=>{
 const c=capture(),decoded=decodeA25LeadLagCapture(RAW,CUT);c.captureCreatedAt='2026-11-02T20:00:00.000Z';for(const r of c.records)r.sourcePath='/metadata-only/not-a-runtime-file/'+r.id;
 const original=decoded.decodedRecords.find(r=>r.kind==='SOCIAL'&&r.encoding==='DEFLATE_RAW_BASE64')!,r=c.records.find(r=>r.id===original.id)!,packed=deflateRawSync(Buffer.from(original.raw),{level:1});r.data=packed.toString('base64');r.archiveBytes=packed.length;r.archiveHash=sha(packed);
 const later=validateA25LeadLagSource(JSON.stringify(c),TOKEN,'2026-11-04T00:00:00.000Z',[A25_CAPTURE_ID]);assert.deepEqual(later.metric,resolved().metric);
});
test('missing original source yields no study, including foreign selected token or unverifiable native identity',()=>{
 const c=capture();c.records=c.records.filter(r=>r.id!==c.identity.bankId);let m=deriveA25LeadLag(JSON.stringify(c),TOKEN,CUT,[]);assert.equal(m.quality,'MISSING');assert.equal((m.data as any).study,null);
 m=deriveA25LeadLag(RAW,{chain:'solana',address:'11111111111111111111111111111111'},CUT,[]);assert.equal(m.quality,'MISSING');assert.match(m.reasonCode,/TOKEN/);
 const native=capture(),decoded=decodeA25LeadLagCapture(RAW,CUT),bank=decoded.decodedRecords.find(r=>r.id===native.identity.bankId)!;replace(native,bank.id,bank.raw+'\n');assert.throws(()=>validateA25LeadLagSource(JSON.stringify(native),TOKEN,CUT,[]),/POOL_MANIFEST/);
});
test('file boundary refuses symlink, invalid UTF8, cross-token and unavailable future capture before collection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'a25-lead-lag-'));try{const file=join(dir,'capture.json');writeFileSync(file,RAW);symlinkSync(file,join(dir,'link'));assert.throws(()=>loadA25LeadLagCapture(join(dir,'link'),TOKEN,CUT),/SOURCE_FILE/);assert.throws(()=>loadA25LeadLagCapture(file,{chain:'solana',address:'11111111111111111111111111111111'},CUT),/SOURCE_TOKEN/);assert.throws(()=>loadA25LeadLagCapture(file,TOKEN,'2026-11-01T00:00:00.000Z'),/CLOCK_OR_TOKEN/);writeFileSync(file,Buffer.from([0xff]));assert.throws(()=>loadA25LeadLagCapture(file,TOKEN,CUT),/SOURCE_UTF8/);}finally{rmSync(dir,{recursive:true,force:true});}
});
