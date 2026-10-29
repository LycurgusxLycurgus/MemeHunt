import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createO29BulkCapture} from './reserve-bulk-fixtures.js';
import {createO23BulkCapture} from './synchrony-bulk-fixtures.js';
import {deriveO29BulkReservePath} from '../src/providers/advisory-reserve-bulk.js';
import {deriveO23BulkSynchrony,unpackO23BulkSource,O23_BULK_ARCHIVE_METHOD,type O23BulkReceipts} from '../src/providers/advisory-synchrony-bulk.js';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function temporary(run:(directory:string)=>void){const d=mkdtempSync(join(tmpdir(),'reserve-bulk-provider-'));try{run(d);}finally{rmSync(d,{recursive:true,force:true});}}
function mutateBulk(source:O23BulkReceipts,change:(value:any)=>void){const value=JSON.parse(unpackO23BulkSource(source.rawArtifacts['bulk-page-0']!,true));change(value);const raw=JSON.stringify(value);source.rawArtifacts['bulk-page-0']=JSON.stringify({method:O23_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:Buffer.byteLength(raw),sourceHash:sha(raw),data:deflateRawSync(Buffer.from(raw)).toString('base64')});}
const derive=(source:O23BulkReceipts,cutoff:string)=>deriveO29BulkReservePath(source,cutoff,['retained-source']);

test('three actual contiguous financial rows in a constructed complete subset prove exact quote curves and continuity',()=>temporary(d=>{
 const f=createO29BulkCapture(d),before=JSON.stringify(f.source),metric=derive(f.source,f.cutoff),data=metric.data as any;
 assert.equal(metric.id,'O29');assert.equal(metric.quality,'KNOWN');assert.equal(metric.reasonCode,'EFFECTIVE_RESERVE_PATH_OBSERVED');assert.equal(data.method,'complete-pool-effective-reserve-path-v2');assert.equal(data.quoteMint,'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');assert.equal(data.quoteDecimals,8);assert.equal(data.financialPurpose,'O29_RESERVE_PATH_ONLY');
 assert.equal(data.sourceCoverage.successfulReferences,3);assert.equal(data.sourceCoverage.bulkBodies,3);assert.equal(data.sourceCoverage.financialDecodedTransactions,3);assert.equal(data.sourceCoverage.unresolvedFinancialTransactions,0);assert.equal(data.sourceCoverage.financialTrades,3);
 assert.equal(data.gates.checkedTrades,3);assert.equal(data.gates.curveMatches,3);assert.equal(data.gates.curveMismatches,0);assert.equal(data.gates.continuityPairs,2);assert.equal(data.gates.effectiveDiscontinuities,0);
 assert.equal(data.depthAtDefinedImpact,null);assert.equal(data.cohortBaseline,null);assert.equal(data.anomaly,null);assert.equal(data.thinLiquidity,null);assert.equal(data.offsetCause,null);
 assert.equal(data.whole.firstEventPre.signature,f.fixture.transactions[2].transaction.signatures[0]);assert.equal(data.whole.modelledPost.afterSignature,f.fixture.transactions[0].transaction.signatures[0]);assert.equal(data.whole.modelledPost.basis,'MODELLED_CURVE_ENDPOINT');assert.notEqual(data.whole.modelledPost.at,f.source.range.end);
 assert.equal(data.hours.length,12);for(const h of data.hours.slice(0,11)){assert.equal(h.trades,0);assert.equal(h.buyCoreQuoteAtomic,'0');assert.equal(h.sellCoreQuoteAtomic,'0');assert.equal(h.firstEventPre,null);assert.equal(h.modelledPost,null);assert.equal(h.curveImpact,null);}
 assert.equal(JSON.stringify(f.source),before,'financial consumer never rewrites retained source or index clocks');
}));

test('all21 sparse actual residuals prove20 financial legs but cannot force a continuous reserve path',()=>temporary(d=>{
 const f=createO23BulkCapture(d),metric=derive(f.source,f.cutoff),data=metric.data as any;
 assert.equal(metric.quality,'MISSING');assert.equal(metric.reasonCode,'RESERVE_PATH_EFFECTIVE_DISCONTINUOUS');assert.equal(data.sourceCoverage.successfulReferences,21);assert.equal(data.sourceCoverage.financialDecodedTransactions,21);assert.equal(data.sourceCoverage.financialTrades,20);assert.equal(data.sourceCoverage.zeroTradeTransactions,1);assert.equal(data.sourceCoverage.unresolvedFinancialTransactions,0);
 assert.equal(data.gates.checkedTrades,20);assert.equal(data.gates.curveMatches,20);assert.equal(data.gates.curveMismatches,0);assert.equal(data.gates.continuityPairs,19);assert.ok(data.gates.effectiveDiscontinuities>0);assert.equal(data.whole,null);assert.equal(data.hours,null);assert.equal(data.offsets,null);
 assert.ok(data.pairedClocks.differentFromIndex>=5);assert.ok(data.sourceCoverage.compiledFallbacks>=15);
}));

test('one source-valid financial decoding gap keeps the whole path missing rather than dropping its transaction',()=>temporary(d=>{
 const f=createO29BulkCapture(d),source=structuredClone(f.source);mutateBulk(source,v=>{v.result.data[0].meta.logMessages=v.result.data[0].meta.logMessages.filter((line:string)=>!line.startsWith('Program data: '));});
 const metric=derive(source,f.cutoff),data=metric.data as any;assert.equal(metric.quality,'MISSING');assert.equal(metric.reasonCode,'RESERVE_BULK_TAPE_UNRESOLVED');assert.equal(data.sourceCoverage.successfulReferences,3);assert.equal(data.sourceCoverage.financialDecodedTransactions,2);assert.equal(data.sourceCoverage.unresolvedFinancialTransactions,1);assert.equal(data.sourceCoverage.financialTrades,2);assert.equal(data.gates,null);assert.equal(data.whole,null);assert.equal(data.hours,null);
}));

test('financial consumer cannot bypass the closed source bijection or companion binding gates',()=>temporary(d=>{
 const f=createO29BulkCapture(d);for(const change of [(v:any)=>{v.result.data.pop();},(v:any)=>{v.result.data[0].slot++;},(v:any)=>{v.result.data.reverse();}]){const source=structuredClone(f.source);mutateBulk(source,change);assert.throws(()=>derive(source,f.cutoff),/ADVISORY_SYNCHRONY_BULK_/);}
}));

test('O29 interpretation leaves the existing proof52 O23 count/statistics unchanged on identical bytes',()=>temporary(d=>{
 const f=createO29BulkCapture(d),before=deriveO23BulkSynchrony(f.source,f.cutoff,['retained-source']);derive(f.source,f.cutoff);assert.deepEqual(deriveO23BulkSynchrony(f.source,f.cutoff,['retained-source']),before);
}));
