import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {decodeA13ParticipationCapture,a13NativeInput} from '../src/providers/advisory-participation-import.js';
import {reconstructA13NativeParticipation} from '../src/providers/advisory-participation-native.js';
import type {A13NativeInput,A13NativeRecord} from '../src/providers/advisory-participation-native.js';
function fixture(){const raw=gunzipSync(readFileSync(new URL('../../tests/fixtures/a13-observed-peer-participation.json.gz',import.meta.url))).toString('utf8');const cutoff=JSON.parse(raw).captureCreatedAt as string;return {input:a13NativeInput(decodeA13ParticipationCapture(raw,cutoff)),cutoff};}
function mutate(input:A13NativeInput,predicate:(r:A13NativeRecord)=>boolean,fn:(json:any)=>void){const r=input.records.find(predicate);assert.ok(r);const v=JSON.parse(r.raw);fn(v);r.raw=JSON.stringify(v);r.sha256=createHash('sha256').update(r.raw).digest('hex');return r;}
const hf=(r:A13NativeRecord)=>r.request?.method==='getProgramAccounts'&&JSON.stringify(r.request.params).includes('HfSspmBgvTb5m4uMqcftkxwhXqzLGZYEaQ21HwYgpump');
function reject(input:A13NativeInput,cutoff:string,code:RegExp){assert.throws(()=>reconstructA13NativeParticipation(input,cutoff),code);}

test('genuine ten-candidate source reconstructs complete owner transitions while four access controls remain missing',()=>{
 const {input,cutoff}=fixture(),before=input.records.map(r=>r.sha256),n=reconstructA13NativeParticipation(input,cutoff);
 assert.equal(n.candidates.length,10);assert.equal(n.coverage.fullStudyStatus,'INCOMPLETE');assert.equal(n.coverage.candidateSubfamilyStatus,'COMPLETE');assert.equal(n.controls.length,4);
 for(const c of n.controls){assert.equal(c.httpStatus,429);assert.equal(c.rawCount,null);assert.equal(c.adjustedCount,null);}
 for(const c of n.candidates){assert.equal(c.delta,c.entrants-c.leavers);assert.equal(c.adjustedP0,c.common+c.leavers);assert.equal(c.adjustedP1,c.common+c.entrants);assert.equal(c.rawP0,c.adjustedP0+c.excludedP0);assert.equal(c.rawP1,c.adjustedP1+c.excludedP1);assert.equal(c.positiveGrowth,Math.max(0,c.delta));assert.equal(c.positiveGrowth,0);assert.ok(c.intervalSeconds===1182||c.intervalSeconds===1183);}
 assert.equal(n.operator.addressCount,42);assert.deepEqual(n.operator.kinds,{PUMPSWAP_POOL:16,METEORA_DLMM:4,PUMP_BONDING_CURVE:22});assert.equal(n.sourceTimes.nominalTimerSeconds,900);assert.equal(n.sourceTimes.actualGapSeconds,1178.397);assert.equal(n.sourceTimes.schedulingVarianceSeconds,278.397);assert.equal(n.sourceTimes.exactFifteenMinuteObservation,false);assert.equal(n.sourceTimes.T0.lastResponseAt,'2026-11-02T10:16:56.834Z');assert.equal(n.sourceTimes.T0.finishedAt,'2026-11-02T10:16:57.184Z');assert.equal(n.sourceTimes.T1.lastResponseAt,'2026-11-02T10:36:38.784Z');assert.equal(n.sourceTimes.T1.finishedAt,'2026-11-02T10:36:39.174Z');assert.deepEqual(input.records.map(r=>r.sha256),before);
});

test('missing peer, duplicate census account and unreconciled amount never become zero observations',()=>{
 let {input,cutoff}=fixture();const r=input.records.find(hf)!;input.records=input.records.filter(q=>q.id!==r.id);reject(input,cutoff,/MISSING_RECORD/);
 ({input,cutoff}=fixture());mutate(input,hf,v=>v.result.value.push(v.result.value[0]));reject(input,cutoff,/RPC_SHAPE/);
 ({input,cutoff}=fixture());mutate(input,hf,v=>{const b=Buffer.from(v.result.value[0].account.data[0],'base64');b.writeBigUInt64LE(b.readBigUInt64LE(64)+1n,64);v.result.value[0].account.data[0]=b.toString('base64');});reject(input,cutoff,/HOLDER_SUPPLY_UNRECONCILED/);
});

test('literal mint, program, account state, complete population filter and finalized native time are mandatory',()=>{
 let {input,cutoff}=fixture();mutate(input,hf,v=>{v.result.value[0].account.owner='11111111111111111111111111111111';});reject(input,cutoff,/RPC_SHAPE/);
 ({input,cutoff}=fixture());mutate(input,hf,v=>{const b=Buffer.from(v.result.value[0].account.data[0],'base64');b[108]=0;v.result.value[0].account.data[0]=b.toString('base64');});reject(input,cutoff,/RPC_SHAPE/);
 ({input,cutoff}=fixture());const p=input.records.find(hf)!;(p.request!.params[1] as any).filters.push({dataSize:165});reject(input,cutoff,/POPULATION_REQUEST/);
 ({input,cutoff}=fixture());const time=input.records.find(r=>r.request?.method==='getBlockTime'&&input.rounds.T0.includes(r.id))!;time.request!.params=[1];reject(input,cutoff,/NATIVE_TIME|ORPHAN_ROUND/);
});

test('within-round mint control/supply change rejects, original source availability and envelope stay bound',()=>{
 let {input,cutoff}=fixture();const bankId=input.rounds.T0.filter(id=>input.records.find(r=>r.id===id)?.request?.method==='getMultipleAccounts').at(-1)!;mutate(input,r=>r.id===bankId,v=>{const b=Buffer.from(v.result.value[9].data[0],'base64');b.writeBigUInt64LE(b.readBigUInt64LE(36)+1n,36);v.result.value[9].data[0]=b.toString('base64');});reject(input,cutoff,/ROUND_MINT_CORE_SUPPLY/);
 ({input,cutoff}=fixture());input.records.find(hf)!.availableAt='2099-01-01T00:00:00.000Z';reject(input,cutoff,/AVAILABILITY/);
 ({input,cutoff}=fixture());mutate(input,hf,v=>{v.id=999;});reject(input,cutoff,/RPC_ENVELOPE/);
 ({input,cutoff}=fixture());input.records.find(hf)!.raw+=' ';reject(input,cutoff,/HASH/);
});

test('native protocol identity and fixed exclusion operator cannot be replaced by catalogue flags',()=>{
 let {input,cutoff}=fixture();mutate(input,r=>r.id===input.roleCatalogRecordId,v=>{v.rows[0].identity.baseMint='11111111111111111111111111111111';v.rows[0].status='VERIFIED';});
 // A pool decodes its own mint; catalogue hints are not authority for native pool fields.
 const unchanged=reconstructA13NativeParticipation(input,cutoff);assert.equal(unchanged.operator.addressCount,42);
 ({input,cutoff}=fixture());const cat=JSON.parse(input.records.find(r=>r.id===input.roleCatalogRecordId)!.raw),source=cat.rows[0].identity.source.sourceHash;mutate(input,r=>r.sha256===source,v=>{const request=input.records.find(r=>r.sha256===source)!.request!;const i=(request.params[0] as string[]).indexOf(cat.rows[0].address);v.result.value[i].owner='11111111111111111111111111111111';});const actual=input.records.find(r=>r.request?.method==='getMultipleAccounts'&&(r.request.params[0] as string[]).includes(cat.rows[0].address))!;mutate(input,r=>r.id===input.roleCatalogRecordId,v=>{for(const row of v.rows)if(row.identity.source.sourceHash===source)row.identity.source.sourceHash=actual.sha256;});reject(input,cutoff,/PROTOCOL_OWNER/);
 ({input,cutoff}=fixture());mutate(input,r=>r.id===input.scopeRecordId,v=>{v.fixedExcludedAddresses[0]='11111111111111111111111111111111';});reject(input,cutoff,/EXACT_FIXED_OPERATOR|FROZEN_OPERATOR/);
});

test('failed-control receipts, interval variance and declared native membership cannot be silently dropped',()=>{
 let {input,cutoff}=fixture();const control=input.records.find(r=>input.rounds.T0.includes(r.id)&&r.httpStatus===429)!;control.httpStatus=200;reject(input,cutoff,/CONTROL_FAILURE/);
 ({input,cutoff}=fixture());mutate(input,r=>r.id===input.varianceRecordId,v=>{v.T1FirstRequestAt=v.T0FinishedAt;});reject(input,cutoff,/EXECUTION_VARIANCE_BINDING/);
 ({input,cutoff}=fixture());input.rounds.T0.push(input.rounds.T0[0]!);reject(input,cutoff,/RECORD_REUSE/);
});

// Constructed metadata copies test the clock boundary; genuine receipt bytes stay intact.
test('acquisition completion may follow response availability but cannot precede it or exceed cutoff',()=>{
 let {input,cutoff}=fixture();mutate(input,r=>r.id===input.varianceRecordId,v=>{v.T0FinishedAt='2026-11-02T10:16:56.000Z';});reject(input,cutoff,/ACQUISITION_COMPLETION_CLOCK/);
 ({input,cutoff}=fixture());mutate(input,r=>r.id===input.varianceRecordId,v=>{v.T1FinishedAt='2099-01-01T00:00:00.000Z';});reject(input,cutoff,/ACQUISITION_COMPLETION_CLOCK/);
});
