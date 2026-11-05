import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import type {AdvisoryMetric} from '../src/domain/advisory-contracts.js';
import {C09_CONTEXT_METHOD,deriveC09MarketContext} from '../src/domain/advisory-market-context.js';
import {deriveC12NativeBridgeFlow} from '../src/providers/advisory-bridge-flow.js';
import {decodeLaunchpadContext,deriveC16Launchpad,type LaunchpadReceipts} from '../src/providers/advisory-launchpad.js';
import {C12_CAPTURE_ID} from '../src/providers/advisory-bridge-import.js';
const CUT='2026-11-01T21:30:00.000Z';
const RAW=readFileSync('tests/fixtures/c12-all-assets-native-capture.json','utf8');
const actualBridge=()=>deriveC12NativeBridgeFlow(RAW,CUT,[C12_CAPTURE_ID]);
const LAUNCHPAD=JSON.parse(gunzipSync(readFileSync('tests/fixtures/c09-launchpad-source-fit.json.gz')).toString('utf8')) as LaunchpadReceipts;
const actualLaunchpad=()=>deriveC16Launchpad(decodeLaunchpadContext(LAUNCHPAD,CUT),Object.keys(LAUNCHPAD.requests).map(k=>'advisory-launchpad-'+k));
// C11/C15 below are deliberately constructed rows; C12/C16 are derived from retained
// actual portable raw-source fixtures. This is not an additional live acquisition.
function children():AdvisoryMetric[]{return[
 {id:'C11',quality:'KNOWN',unit:'scoped-record',reasonCode:'COMPARABLE_CHAIN_ACTIVITY_OBSERVED',evidenceIds:['market-dex','shared-market'],data:{window:{start:'2026-10-31T00:00:00.000Z',end:'2026-11-01T00:00:00.000Z',availableAt:'2026-11-01T21:05:13.480Z'},shareOfCoveredChains:[{chain:'solana',usd:'60',share:'0.6',changePercentagePoints:'5'},{chain:'bsc',usd:'25',share:'0.25',changePercentagePoints:'-3'},{chain:'base',usd:'15',share:'0.15',changePercentagePoints:'-2'}],excludedChains:['robinhood']}},
 actualBridge(),
 {id:'C15',quality:'KNOWN',unit:'scoped-record',reasonCode:'COMPLETED_MACRO_CONTEXT_OBSERVED',evidenceIds:['market-macro','shared-market'],data:['BTC','ETH','SOL'].map(instrument=>({instrument,quote:'USD',start:'2026-10-29T21:00:00.000Z',end:'2026-11-01T21:00:00.000Z',availableAt:'2026-11-01T21:05:13.480Z',completedBars:72,returnFraction:'0.1',drawdownFraction:'0.2',trend:'MIXED',pivots:[],tradeVwap:null}))},
 actualLaunchpad()
 ];}
const data=(m:AdvisoryMetric)=>m.data as any;

test('finalized four-child composition keeps actual native C12 totals and separate windows without a regime',()=>{
 const rows=children(),before=structuredClone(rows),m=deriveC09MarketContext(rows,CUT),d=data(m);
 assert.equal(rows[1].quality,'KNOWN',JSON.stringify(rows[1]));assert.equal(rows[3].quality,'KNOWN',JSON.stringify(rows[3]));assert.equal(m.quality,'KNOWN');assert.equal(d.method,C09_CONTEXT_METHOD);assert.equal(d.coverageComplete,true);assert.deepEqual(Object.keys(d.components),['C11','C12','C15','C16']);
 assert.equal(d.classification,null);assert.equal(d.classificationStatus,'NOT_ACTIVATED');assert.equal('score'in d,false);
 assert.equal(d.components.C11.windows.end,'2026-11-01T00:00:00.000Z');assert.equal(d.components.C12.windows.end,'2026-10-31T14:00:00.000Z');assert.equal(d.components.C15.windows[0].end,'2026-11-01T21:00:00.000Z');
 assert.equal(d.components.C16.windows.rolling.endNotBefore,null);assert.equal(d.components.C16.windows.rolling.asOf,'PROVIDER_UNPUBLISHED');assert.equal(d.components.C16.windows.completedMoneyDay.end,'2026-11-01T00:00:00.000Z');
 assert.equal(d.components.C16.values.survival.fraction,null);assert.equal(d.components.C16.values.money.volumeUsd,'103804867');assert.equal(d.components.C16.values.money.feesUsd,'1415068');assert.equal(d.components.C16.values.money.revenueUsd,'983028');
 assert.deepEqual(d.components.C12.values.chains,data(rows[1]).chains);assert.equal(d.components.C12.values.chains[0].netReferenceUsd,'-678.65383354652962934276871001');assert.equal(d.components.C12.values.assets.some((a:any)=>'transfers'in a),false);
 assert.deepEqual(d.components.C11.scope.excludedChains,['robinhood']);assert.equal(d.components.C15.history[0].completedBars,72);assert.equal(d.components.C12.availability.at,null);assert.notEqual(d.components.C12.windows.end,CUT);
 assert.deepEqual(rows,before);assert.deepEqual(m.evidenceIds,[...new Set(rows.flatMap(r=>r.evidenceIds))]);
});
test('missing or partial nonbridge components remain explicit without inventing an all-four-known gate',()=>{
 const rows=children(),c16=rows[3];c16.quality='MISSING';c16.reasonCode='LAUNCH_AND_MIGRATION_COUNTS_UNAVAILABLE';data(c16).counts=null;
 const m=deriveC09MarketContext(rows,CUT),d=data(m);assert.equal(m.quality,'KNOWN');assert.equal(d.coverageComplete,false);assert.equal(d.components.C16.quality,'MISSING');assert.equal(d.components.C16.reasonCode,c16.reasonCode);assert.equal(d.components.C16.values.counts,null);assert.equal(d.components.C16.values.money.volumeUsd,'103804867');assert.equal(d.components.C16.history.survival.fraction,null);
 const absent=deriveC09MarketContext(rows.filter(m=>m.id!=='C15'),CUT);assert.equal(absent.quality,'KNOWN');assert.equal(data(absent).coverageComplete,false);assert.equal(data(absent).components.C15.values,null);assert.equal(data(absent).components.C15.reasonCode,'C09_COMPONENT_NOT_PRESENT');
});
test('absent, unpriced, incomplete or wrong-purpose bridge context never supplies authoritative bridge values',()=>{
 for(const variant of ['ABSENT','UNPRICED','INCOMPLETE','WRONG_METHOD','FUTURE']){
  const rows=children();if(variant==='ABSENT')rows.splice(1,1);else{const b=rows[1];if(variant==='UNPRICED'){b.quality='MISSING';b.reasonCode='C12_BRIDGE_UNPRICED_CANONICAL_ASSET';}if(variant==='INCOMPLETE')data(b).status='INCOMPLETE';if(variant==='WRONG_METHOD')data(b).method='provider-usd-summary';if(variant==='FUTURE')data(b).window.end='2026-11-02T00:00:00.000Z';}
  const m=deriveC09MarketContext(rows,CUT),d=data(m);assert.equal(m.quality,'MISSING',variant);assert.equal(d.coverageComplete,false);assert.equal(d.components.C12.values,null);assert.equal(d.classification,null);assert.equal(d.classificationStatus,'NOT_ACTIVATED');
 }
});
test('composer copies child values and citations and rejects ambiguous duplicate child identities',()=>{
 const rows=children(),before=structuredClone(rows),out=data(deriveC09MarketContext(rows,CUT));out.components.C12.values.chains[0].netReferenceUsd='0';out.components.C11.evidenceIds.push('forged');out.components.C16.values.survival.fraction=1;assert.deepEqual(rows,before);
 assert.throws(()=>deriveC09MarketContext([...rows,rows[1]],CUT),/C09_CONTEXT_COMPONENT_DUPLICATE/);assert.throws(()=>deriveC09MarketContext(rows,'bad'),/C09_CONTEXT_CUTOFF_INVALID/);
});
