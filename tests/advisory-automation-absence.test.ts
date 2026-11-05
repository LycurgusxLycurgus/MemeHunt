import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
// Constructed conformance over representative actual public C5 bytes;
// this subset does not establish complete-hour production measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import type {AdvisoryWindowHistory,AdvisoryWindowReuse} from '../src/providers/advisory-window.js';
import {AUTOMATION_ABSENCE_METHOD,AUTOMATION_ABSENCE_REGISTRY_VERSION,DCA_PROGRAM,OFFICIAL_AUTOMATION_SOURCES,OFFICIAL_AUTOMATION_ABSENCE_SOURCES,collectAdvisoryAutomation,deriveO30Window,type AutomationReceipts} from '../src/providers/advisory-automation.js';
import {collectLiveToken} from '../src/app/live.js';
import {Service} from '../src/app/service.js';
import {starterProfile} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {busyWindowFixture} from './window-busy-fixtures.js';

const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/o30-registry-absence-c5.json',import.meta.url),'utf8'));
const token=fixture.token as {chain:'solana';address:string};
const bodies:Record<string,string>={
 'dca-lib':readFileSync(new URL('../../tests/fixtures/automation-dca-address.txt',import.meta.url),'utf8'),
 'dca-idl':readFileSync(new URL('../../tests/fixtures/automation-dca-idl.json',import.meta.url),'utf8'),
 'dca-readme':readFileSync(new URL('../../tests/fixtures/automation-dca-readme.md',import.meta.url),'utf8'),
 'recurring-doc':readFileSync(new URL('../../tests/fixtures/automation-dca-doc.md',import.meta.url),'utf8'),
};
const currentBodies:Record<string,string>={...bodies,'recurring-doc':JSON.parse(fixture.automationReceipts.rawArtifacts['source-recurring-doc']).body as string};
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const clone=()=>({window:structuredClone(fixture.window) as AdvisoryWindowHistory,windowReceipts:structuredClone(fixture.windowReceipts) as AdvisoryWindowReuse});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function response(body:string,url:string){const r=new Response(body);Object.defineProperty(r,'url',{value:url});return r;}
function network(anchor:number,cutoff=fixture.cutoff){
 const calls:Array<{url:string;method:string;params?:unknown}>=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);if(init?.method==='POST'){const q=JSON.parse(String(init.body));calls.push({url,method:q.method,params:q.params});assert.equal(q.method,'getAccountInfo');assert.equal(q.params[0],DCA_PROGRAM);return new Response(anchor===fixture.window.anchorSlot?fixture.automationReceipts.rawArtifacts['program-account']:JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:anchor+1},value:{owner:LOADER,executable:true,data:['','base64'],lamports:1}}}));}
  const s=OFFICIAL_AUTOMATION_SOURCES.find(s=>s.url===url);assert.ok(s);calls.push({url,method:'GET'});assert.equal(init?.redirect,'error');return response(currentBodies[s.id]!,url);
 };
 return {calls,fetcher,now:()=>cutoff};
}
async function measured(){const c=clone(),n=network(c.window.anchorSlot!);const collected=await collectAdvisoryAutomation(token,c.window,'https://rpc.invalid',n.fetcher,n.now,undefined,true),receipts=structuredClone(fixture.automationReceipts) as AutomationReceipts;assert.deepEqual(collected.rawArtifacts,receipts.rawArtifacts);assert.deepEqual(collected.requests,receipts.requests);return {...c,...n,receipts,metric:deriveO30Window(token,c.window,c.windowReceipts,receipts,fixture.cutoff,[],true)};}
function changeReceipt(c:ReturnType<typeof clone>,mutate:(value:any)=>void,id=Object.keys(c.windowReceipts.rawArtifacts)[0]!){const r=JSON.parse(c.windowReceipts.rawArtifacts[id]!);mutate(r.result);c.windowReceipts.rawArtifacts[id]=JSON.stringify(r);return c;}

test('new WBTC absence branch covers multi-hop/direct/truncated representative arrays; old default stays MISSING',async()=>{
 const m=await measured(),d=m.metric.data as any;assert.match(fixture.label,/CONSTRUCTED/);assert.equal(m.calls.length,5);assert.deepEqual(m.calls.map(c=>c.method).sort(),['GET','GET','GET','GET','getAccountInfo'].sort());
 for(const [id,raw]of Object.entries(m.windowReceipts.rawArtifacts))assert.equal(sha(raw),fixture.sourceHashes[id]);
 for(const [id,raw]of Object.entries(m.receipts.rawArtifacts))assert.equal(sha(raw),fixture.automationSourceHashes[id]);assert.deepEqual(m.receipts.retrievedAt,fixture.automationReceipts.retrievedAt);assert.ok(Object.values(m.receipts.retrievedAt).every(at=>Date.parse(at)<=Date.parse(fixture.cutoff)));assert.deepEqual(OFFICIAL_AUTOMATION_ABSENCE_SOURCES.slice(0,3),OFFICIAL_AUTOMATION_SOURCES.slice(0,3));assert.equal(OFFICIAL_AUTOMATION_SOURCES[3].sha256,'735e27be4fc85ab44049646f4f9fb6c92ee68b52e6479a09b14b5c973539224b');assert.equal(OFFICIAL_AUTOMATION_ABSENCE_SOURCES[3].pinnedReviewedAt,'2026-10-29T11:39:30.994Z');
 assert.ok(m.window.trades.some(t=>t.instructionName==='multi_hop_swap'));assert.ok(m.window.trades.some(t=>t.instructionName!=='multi_hop_swap'));assert.ok(Object.values(m.windowReceipts.rawArtifacts).some(raw=>raw.includes('Log truncated')));
 assert.equal(m.metric.quality,'KNOWN');assert.equal(d.method,AUTOMATION_ABSENCE_METHOD);assert.equal(d.registryVersion,AUTOMATION_ABSENCE_REGISTRY_VERSION);assert.equal(d.registry.version,AUTOMATION_ABSENCE_REGISTRY_VERSION);assert.equal(d.quoteMint,'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');assert.equal(d.quoteDecimals,8);
 const denominator=m.window.trades.reduce((n,t)=>n+BigInt(t.quoteAtomic),0n);assert.ok(denominator>0n);assert.deepEqual([d.coveredQuoteAtomic,d.knownAutomatedQuoteAtomic,d.knownAutomatedFraction,d.unattributedQuoteAtomic],[String(denominator),'0','0',String(denominator)]);assert.equal(d.coveredTrades,m.window.trades.length);assert.equal(d.unknownAutomation,'NOT_MEASURED');assert.ok(d.trades.every((t:any)=>t.attribution==='UNATTRIBUTED'&&t.attributionBasis==='COMPLETE_PARSED_INSTRUCTIONS_NO_REGISTERED_DCA'));
 const old=clone(),n=network(old.window.anchorSlot!);const skipped=await collectAdvisoryAutomation(token,old.window,'https://rpc.invalid',n.fetcher,n.now);assert.equal(n.calls.length,0);assert.equal(deriveO30Window(token,old.window,old.windowReceipts,skipped,fixture.cutoff,[]).quality,'MISSING');
});


test('versioned source pins reject cross-mode bodies while legacy native default keeps its old positive zero',async()=>{
 const m=await measured(),oldReceipts=structuredClone(m.receipts),oldBody={httpStatus:200,url:OFFICIAL_AUTOMATION_SOURCES[3].url,body:bodies['recurring-doc']};oldReceipts.rawArtifacts['source-recurring-doc']=JSON.stringify(oldBody);
 const mismatch=deriveO30Window(token,m.window,m.windowReceipts,oldReceipts,fixture.cutoff,[],true);assert.equal(mismatch.quality,'MISSING');assert.equal(mismatch.reasonCode,'AUTOMATION_SOURCE_CHANGED');assert.equal((mismatch.data as any).knownAutomatedFraction,null);
 // Constructed legacy v4 recovered-array conformance; this is not a new native-token measurement.
 const native=clone();native.window.method='pumpswap-selected-pool-window-v4';for(const tx of native.window.transactions)tx.logRecovery={truncated:true,unresolvedInvocations:0,emptyForeignSweeps:0};
 const old=deriveO30Window(token,native.window,native.windowReceipts,oldReceipts,fixture.cutoff,[]);assert.equal(old.quality,'KNOWN');assert.equal((old.data as any).knownAutomatedFraction,'0');assert.equal((old.data as any).method,'official-automation-flash-fill-window-v1');assert.equal('pinnedReviewedAt' in (old.data as any).registry.programs[0].sources[3],false);
 const wrong=deriveO30Window(token,native.window,native.windowReceipts,m.receipts,fixture.cutoff,[]);assert.equal(wrong.quality,'MISSING');assert.equal(wrong.reasonCode,'AUTOMATION_SOURCE_CHANGED');
 // Even an explicit flag does not change the existing native v3/v4 branch's source semantics.
 assert.deepEqual(deriveO30Window(token,native.window,native.windowReceipts,oldReceipts,fixture.cutoff,[],true),old);
});

test('registered calls in either instruction array, including truncated receipts, never become registry absence',async()=>{
 const original=await measured();
 for(const id of Object.keys(fixture.windowReceipts.rawArtifacts))for(const location of ['top','inner'] as const){const c=changeReceipt(clone(),v=>{if(location==='top')v.transaction.message.instructions[0].programId=DCA_PROGRAM;else{if(!v.meta.innerInstructions.length)v.meta.innerInstructions.push({index:0,instructions:[]});v.meta.innerInstructions[0].instructions.push({programId:DCA_PROGRAM,accounts:[],data:'1',stackHeight:2});}},id);const metric=deriveO30Window(token,c.window,c.windowReceipts,original.receipts,fixture.cutoff,[],true),d=metric.data as any;assert.equal(metric.quality,'MISSING',location);assert.equal(metric.reasonCode,'ADVISORY_AUTOMATION_REGISTERED_CALL_REQUIRES_BOUND_EXECUTION');assert.equal(d.knownAutomatedQuoteAtomic,null);assert.equal(d.knownAutomatedFraction,null);}
});

test('missing/malformed transaction arrays, missing trade witnesses and zero denominator remain unresolved',async()=>{
 const m=await measured();const cases:Array<(v:any)=>void>=[v=>{v.meta.innerInstructions=null;},v=>{v.transaction.message.instructions[0].programId='not-a-key';},v=>{v.meta.innerInstructions.push({index:0,instructions:[]},{index:0,instructions:[]});}];
 for(const id of Object.keys(fixture.windowReceipts.rawArtifacts))for(const mutation of cases){const c=changeReceipt(clone(),mutation,id),r=deriveO30Window(token,c.window,c.windowReceipts,m.receipts,fixture.cutoff,[],true);assert.equal(r.quality,'MISSING');assert.equal((r.data as any).knownAutomatedFraction,null);}
 const missing=clone();delete missing.windowReceipts.rawArtifacts[Object.keys(missing.windowReceipts.rawArtifacts)[0]!];assert.equal(deriveO30Window(token,missing.window,missing.windowReceipts,m.receipts,fixture.cutoff,[],true).quality,'MISSING');
 const count=clone();count.window.transactions[0]!.trades++;assert.equal(deriveO30Window(token,count.window,count.windowReceipts,m.receipts,fixture.cutoff,[],true).quality,'MISSING');
 const zero=clone();zero.window.trades=zero.window.trades.map(t=>({...t,quoteAtomic:'0'}));const r=deriveO30Window(token,zero.window,zero.windowReceipts,m.receipts,fixture.cutoff,[],true);assert.equal(r.reasonCode,'AUTOMATION_DENOMINATOR_ZERO');assert.equal((r.data as any).knownAutomatedFraction,null);
});

test('absence requires nonvacuous pool/Token CPI witnesses and consistent whole-window trade summaries',async()=>{
 const m=await measured(),PUMP='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
 const mutations:Array<(v:any)=>void>=[v=>{v.meta.innerInstructions=[];},v=>{for(const ix of [...v.transaction.message.instructions,...v.meta.innerInstructions.flatMap((g:any)=>g.instructions)])if(ix.programId===PUMP&&Array.isArray(ix.accounts))ix.accounts=ix.accounts.filter((a:string)=>a!==m.window.pool);},v=>{for(const g of v.meta.innerInstructions)g.instructions=g.instructions.filter((ix:any)=>ix.programId!==TOKEN&&ix.programId!==T22);}];
 for(const id of Object.keys(fixture.windowReceipts.rawArtifacts))for(const mutate of mutations){const c=changeReceipt(clone(),mutate,id),r=deriveO30Window(token,c.window,c.windowReceipts,m.receipts,fixture.cutoff,[],true);assert.equal(r.quality,'MISSING',id);assert.equal(r.reasonCode,'ADVISORY_AUTOMATION_INSTRUCTION_WITNESS_MISSING');assert.equal((r.data as any).knownAutomatedFraction,null);}
 for(const mutate of [(w:AdvisoryWindowHistory)=>{w.transactions.push({...w.transactions[0]!,signature:'unmatched-summary',trades:1});},(w:AdvisoryWindowHistory)=>{w.transactions[0]!.trades=0;},(w:AdvisoryWindowHistory)=>{w.transactions[0]!.signature='different-summary';}]){const c=clone();mutate(c.window);const r=deriveO30Window(token,c.window,c.windowReceipts,m.receipts,fixture.cutoff,[],true);assert.equal(r.reasonCode,'ADVISORY_AUTOMATION_WINDOW_RECEIPT');assert.equal((r.data as any).knownAutomatedFraction,null);}
 // Exact duplicate requests cannot pick a conflicting first body in the absence branch.
 const dup=clone(),id=Object.keys(dup.windowReceipts.requests)[0]!;dup.windowReceipts.requests.duplicate=structuredClone(dup.windowReceipts.requests[id]!);dup.windowReceipts.rawArtifacts.duplicate=dup.windowReceipts.rawArtifacts[id]!;dup.windowReceipts.retrievedAt.duplicate=dup.windowReceipts.retrievedAt[id]!;assert.equal(deriveO30Window(token,dup.window,dup.windowReceipts,m.receipts,fixture.cutoff,[],true).reasonCode,'ADVISORY_AUTOMATION_WINDOW_RECEIPT');
 // Account-only references are not invocations; all programId fields remain unchanged.
 const account=changeReceipt(clone(),v=>{const ix=v.transaction.message.instructions.find((ix:any)=>Array.isArray(ix.accounts));assert.ok(ix);ix.accounts.push(DCA_PROGRAM);});assert.equal(deriveO30Window(token,account.window,account.windowReceipts,m.receipts,fixture.cutoff,[],true).quality,'KNOWN');
});

test('invalid v5 windows have accurate MISSING scope/reason and make no source reads',async()=>{
 const mutations:Array<{mutate:(w:AdvisoryWindowHistory)=>void;reason:string}>=[...[(w:AdvisoryWindowHistory)=>{w.complete=false;},(w:AdvisoryWindowHistory)=>{w.genesisVerified=false;},(w:AdvisoryWindowHistory)=>{w.poolVerified=false;},(w:AdvisoryWindowHistory)=>{w.anchorSlot=null;}].map(mutate=>({mutate,reason:'AUTOMATION_WINDOW_INCOMPLETE'})),...[(w:AdvisoryWindowHistory)=>{w.quote!.mint='So11111111111111111111111111111111111111112';},(w:AdvisoryWindowHistory)=>{w.quote!.decimals=9;},(w:AdvisoryWindowHistory)=>{w.quote!.program='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';},(w:AdvisoryWindowHistory)=>{w.poolAdmission!.status='UNSUPPORTED_QUOTE';}].map(mutate=>({mutate,reason:'AUTOMATION_QUOTE_UNSUPPORTED'})),{mutate:w=>{w.trades=[];},reason:'AUTOMATION_WINDOW_WITHOUT_TRADES'}];
 for(const {mutate,reason} of mutations){const c=clone();mutate(c.window);const n=network(fixture.window.anchorSlot),r=await collectAdvisoryAutomation(token,c.window,'https://rpc.invalid',n.fetcher,n.now,undefined,true),metric=deriveO30Window(token,c.window,c.windowReceipts,r,fixture.cutoff,[],true);assert.equal(n.calls.length,0);assert.equal(metric.quality,'MISSING');assert.equal(metric.reasonCode,reason);assert.equal((metric.data as any).scope,'UNVERIFIED_OR_UNSUPPORTED_SELECTED_POOL_HOUR');assert.equal((metric.data as any).knownAutomatedFraction,null);}
 const c=clone();c.window.genesisVerified=false;c.window.quote!.decimals=9;assert.equal(deriveO30Window(token,c.window,c.windowReceipts,{rawArtifacts:{},requests:{},retrievedAt:{}},fixture.cutoff,[],true).reasonCode,'AUTOMATION_WINDOW_INCOMPLETE');
});

test('registry pin/program/clock/ownership failures cannot turn absence into a known zero',async()=>{
 const m=await measured(),mutations:Array<(r:AutomationReceipts)=>void>=[
  r=>{const x=JSON.parse(r.rawArtifacts['source-recurring-doc']!);x.body+=' ';r.rawArtifacts['source-recurring-doc']=JSON.stringify(x);},
  r=>{const x=JSON.parse(r.rawArtifacts['program-account']!);x.result.context.slot=m.window.anchorSlot!-1;r.rawArtifacts['program-account']=JSON.stringify(x);},
  r=>{const x=JSON.parse(r.rawArtifacts['program-account']!);x.result.value.executable=false;r.rawArtifacts['program-account']=JSON.stringify(x);},
 ];
 for(const mutate of mutations){const r=structuredClone(m.receipts);mutate(r);const metric=deriveO30Window(token,m.window,m.windowReceipts,r,fixture.cutoff,[],true);assert.equal(metric.quality,'MISSING');assert.equal((metric.data as any).knownAutomatedFraction,null);}
 const future=structuredClone(m.receipts);future.retrievedAt['program-account']=new Date(Date.parse(fixture.cutoff)+1).toISOString();assert.throws(()=>deriveO30Window(token,m.window,m.windowReceipts,future,fixture.cutoff,[],true),/RECEIPT_TIME/);
 const orphan=structuredClone(m.receipts);orphan.rawArtifacts.orphan='{}';assert.throws(()=>deriveO30Window(token,m.window,m.windowReceipts,orphan,fixture.cutoff,[],true),/RECEIPT_MEMBERSHIP/);
 const badQuote=clone();badQuote.window.quote!.decimals=9;const n=network(badQuote.window.anchorSlot!);const none=await collectAdvisoryAutomation(token,badQuote.window,'https://rpc.invalid',n.fetcher,n.now,undefined,true);assert.equal(n.calls.length,0);assert.equal(deriveO30Window(token,badQuote.window,badQuote.windowReceipts,none,fixture.cutoff,[],true).reasonCode,'AUTOMATION_QUOTE_UNSUPPORTED');
});

test('proof49 producer/Service persist exact O30, preserve proof48 default and reject downgrade/orphans',async()=>{
 const f=await busyWindowFixture(3),n=network(f.rows[0]!.slot+1,f.cutoff);const fetcher:typeof fetch=async(input,init)=>{if(init?.method==='POST'){const q=JSON.parse(String(init.body));if(q.method==='getAccountInfo'&&q.params[0]===DCA_PROGRAM)return n.fetcher(input,init);}else if(OFFICIAL_AUTOMATION_SOURCES.some(s=>s.url===String(input)))return n.fetcher(input,init);
 // The busy fixture intentionally has no Token CPI. Add a declared synthetic CPI and matching logs for this constructed absence-conformance test only.
 const response=await f.fetcher(input,init);if(init?.method==='POST'&&JSON.parse(String(init.body)).method==='getTransaction'){const raw=await response.text(),r=JSON.parse(raw),v=r.result;if(v?.meta&&v.transaction?.message?.instructions?.[0]?.programId==='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'){const tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';v.meta.innerInstructions=[{index:0,instructions:[{programId:tokenProgram,accounts:[],data:'1',stackHeight:2}]}];v.meta.logMessages.splice(1,0,`Program ${tokenProgram} invoke [2]`,`Program ${tokenProgram} success`);return new Response(JSON.stringify(r));}return new Response(raw);}return response;};
 const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,fetcher,now:()=>f.cutoff};
 const b=await collectLiveToken(f.token,{...options,o30RegistryAbsence:true}),proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),facts=b.details!.advisory!,metric=facts.metrics.find(m=>m.id==='O30')!;assert.equal(proof.method,'advisory-provenance-v49');assert.equal(facts.method,'advisory-measurements-v48');assert.equal(metric.quality,'KNOWN');assert.equal((metric.data as any).coveredQuoteAtomic,'3000');assert.equal((metric.data as any).knownAutomatedFraction,'0');assert.equal(Object.keys(proof.automation.requests).length,5);
 const old=await collectLiveToken(f.token,options);assert.equal(JSON.parse(old.rawArtifacts['advisory-derivation']!).method,'advisory-provenance-v48');assert.equal(old.details!.advisory!.metrics.find(m=>m.id==='O30')!.quality,'MISSING');assert.deepEqual(old.details!.advisory!.metrics.filter(m=>m.id!=='O30'),facts.metrics.filter(m=>m.id!=='O30'));
 const dir=mkdtempSync(join(tmpdir(),'o30-v49-')),file=join(dir,'live.sqlite');try{let s=new Service(file),saved;try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);for(const key of ['window','automation'] as const)for(const dropOwned of [false,true]){const stripped=structuredClone(b),p=structuredClone(proof);delete p[key];if(dropOwned){const prefix=`advisory-${key}-`;stripped.evidence=stripped.evidence.filter(e=>e.sourceId!==`advisory-${key}`&&!e.id.startsWith(prefix));for(const id of Object.keys(stripped.rawArtifacts))if(id.startsWith(prefix))delete stripped.rawArtifacts[id];}stripped.rawArtifacts['advisory-derivation']=JSON.stringify(p);stripped.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(stripped.rawArtifacts['advisory-derivation']);assert.throws(()=>s.analyzeLive(stripped),/ADVISORY_PROOF_INVALID/);}
 const rawOrphan=structuredClone(b);rawOrphan.rawArtifacts['advisory-automation-orphan']='{}';assert.throws(()=>s.analyzeLive(rawOrphan),/UNREFERENCED_ARTIFACT/);
 const duplicate=structuredClone(b),automationRecord=duplicate.evidence.find(e=>e.sourceId==='advisory-automation')!;duplicate.evidence.push({...automationRecord});assert.throws(()=>s.analyzeLive(duplicate),/DUPLICATE_BUNDLE_ID/);
 const down=structuredClone(b),p={...proof,method:'advisory-provenance-v48'};down.rawArtifacts['advisory-derivation']=JSON.stringify(p);down.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(down.rawArtifacts['advisory-derivation']);assert.throws(()=>s.analyzeLive(down),/ADVISORY_PROOF_INVALID/);const orphan=structuredClone(b);orphan.evidence.push({...orphan.evidence.find(e=>e.sourceId==='advisory-automation')!,id:'advisory-automation-orphan',contentHash:sha('{}')});orphan.rawArtifacts['advisory-automation-orphan']='{}';assert.throws(()=>s.analyzeLive(orphan),/ADVISORY_PROOF_INVALID/);}finally{s.close();}s=new Service(file);try{assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v46');}finally{db.close();}let out='',err='',calls=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assertEntryCliSnapshot(JSON.parse(out),saved);assert.equal(calls,0);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('explicit O30 mode requires live Solana advisory+expanded before any reads',async()=>{
 let reads=0,error='';const runtime={env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:()=>{},stderr:(x:string)=>error+=x};for(const args of [['analyze','--bundle','absent','--o30-registry-absence'],['analyze',token.address,'--partial','--advisory','--o30-registry-absence'],['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o30-registry-absence']]){error='';assert.equal(await runCli(args,runtime),2);assert.match(error,/O30_ADVISORY_REQUIRED/);}assert.equal(reads,0);
});
