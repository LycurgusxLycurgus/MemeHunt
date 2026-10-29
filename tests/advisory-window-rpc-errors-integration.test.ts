import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {busyWindowFixture} from './window-busy-fixtures.js';
import {collectLiveToken} from '../src/app/live.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){const f=await busyWindowFixture(3);(f.rows[3] as any).err='MaxLoadedAccountsDataSizeExceeded';(f.rows[4] as any).err='BlockhashNotFound';return f;}

test('new51 producer and Service bind codec while old48 rejects the same failed-row strings',async()=>{
 const f=await fixture(),options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28Expanded:true,fetcher:f.fetcher,now:()=>f.cutoff},b=await collectLiveToken(f.token,{...options,o28RpcErrors:true});
 const p=JSON.parse(b.rawArtifacts['advisory-derivation']!),a=b.details!.advisory!.metrics.find(m=>m.id==='O28')!;assert.equal(p.method,'advisory-provenance-v51');assert.equal(b.details!.advisory!.method,'advisory-measurements-v50');assert.equal(a.quality,'KNOWN');assert.deepEqual([(a.data as any).successfulSignatures,(a.data as any).failedReferences,(a.data as any).sellQuoteAtomic],[3,2,'3000']);
 const old=await collectLiveToken(f.token,options);assert.equal(JSON.parse(old.rawArtifacts['advisory-derivation']!).method,'advisory-provenance-v48');assert.equal(old.details!.advisory!.metrics.find(m=>m.id==='O28')!.quality,'MISSING');assert.equal(old.details!.advisory!.metrics.find(m=>m.id==='O28')!.reasonCode,'ADVISORY_WINDOW_PAGE_SHAPE');
 const dir=mkdtempSync(join(tmpdir(),'rpc-unit-service-')),file=join(dir,'live.sqlite');let saved;
 try{let s=new Service(file);try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);const down=structuredClone(b);down.rawArtifacts['advisory-derivation']=JSON.stringify({...p,method:'advisory-provenance-v48'});down.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(down.rawArtifacts['advisory-derivation']);assert.throws(()=>s.analyzeLive(down),/ADVISORY_PROOF_INVALID/);}finally{s.close();}s=new Service(file);try{assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v48');}finally{db.close();}let out='',error='',calls=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{calls++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>error+=x}),0,error);assert.equal(calls,0);assert.deepEqual(JSON.parse(out),saved);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('actual CLI analysis propagates the explicit51 mode and preserves literal failed rows',async()=>{
 const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'rpc-unit-cli-'));try{let out='',error='';const file=join(dir,'live.sqlite');assert.equal(await runCli(['analyze',f.token.address,'--chain','solana','--partial','--advisory','--o28-expanded','--o28-rpc-errors','--db',file,'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:f.fetcher,now:()=>f.cutoff,stdout:x=>out+=x,stderr:x=>error+=x}),0,error);const saved=JSON.parse(out);assert.equal(saved.details.advisory.method,'advisory-measurements-v50');assert.equal(saved.details.advisory.metrics.find((m:any)=>m.id==='O28').quality,'KNOWN');const db=new DatabaseSync(file);try{const sem=JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string);assert.equal(sem.policyVersion,'research-screen-advisory-v48');}finally{db.close();}assert.ok(!f.calls.some(c=>c.method==='getTransaction'&&f.rows.slice(3,5).some(r=>r.signature===c.params[0])));}finally{rmSync(dir,{recursive:true,force:true});}
});

test('unit-error mode rejects missing prerequisites or mixed authority modes before reads',async()=>{
 let reads=0;const fetcher:typeof fetch=async()=>{reads++;throw Error('NETWORK_DENIED');},f=await fixture(),base={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,o28RpcErrors:true,fetcher};
 for(const options of [base,{...base,o28Expanded:true,o30RegistryAbsence:true},{...base,o28Expanded:true,historicalTopicReuse:true}])await assert.rejects(collectLiveToken(f.token,options),/O28_RPC_ERRORS_REQUIRED/);
 for(const args of [['analyze','--bundle','absent','--o28-rpc-errors'],['analyze',f.token.address,'--partial','--advisory','--o28-rpc-errors'],['analyze',f.token.address,'--partial','--advisory','--o28-expanded','--o28-rpc-errors','--o30-registry-absence'],['analyze','0x1111111111111111111111111111111111111111','--chain','bsc','--partial','--advisory','--o28-expanded','--o28-rpc-errors']]){let error='';assert.equal(await runCli(args,{env:{},isInteractive:false,fetcher,stdout:()=>{},stderr:x=>error+=x}),2);assert.match(error,/O28_RPC_ERRORS_REQUIRED/);}assert.equal(reads,0);
});
