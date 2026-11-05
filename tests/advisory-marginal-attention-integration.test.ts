import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {collectLiveToken} from '../src/app/live.js';
import {starterProfile,starterConfig} from '../src/app/config.js';
import {runCli} from '../src/cli.js';
import {validateA27MarginalBundle,a27MarginalDescriptor} from '../src/app/a27-marginal.js';
import {A27_SOURCE_ID,A27_CAPTURE_ID,A27_ADAPTER,a27MarginalScope} from '../src/providers/advisory-marginal-attention-source.js';
import {Service} from '../src/app/service.js';
import {advisoryFactsSchema} from '../src/domain/advisory-contracts.js';
import {a29LiveFetcher} from './a29-fixtures.js';

const token={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
const cutoff='2026-11-03T00:00:00.000Z';
// The full genuine native corpus is >3GB decoded. Its per-artifact acceptance
// is retained separately; these durable tests exercise actual public boundaries.
test('A27 mode rejects incompatible source/entry/semantic boundaries before any file/API read',async()=>{
 let reads=0;const options={profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,a27MarginalCapture:'/nonexistent-a26-directory',fetcher:async()=>{reads++;throw Error('UNEXPECTED_API');}};
 for(const other of [{advisoryEnabled:false},{semanticEnabled:true},{a26BuyerPostCapture:'/other'},{a25LeadLagCapture:'/other'},{s15ReferenceCapture:'/other'},{a13ParticipationCapture:'/other'},{c12BridgeCapture:'/other'},{a30FxCapture:'/other'},{nativeAttentionCapture:'/other'},{o25LifetimeCapture:'/other'},{executableLiquidity:true},{o28Expanded:true}])await assert.rejects(()=>collectLiveToken(token,{...options,...other}),/A27_MARGINAL_MODE_REQUIRED|C12_BRIDGE_MODE_REQUIRED/);
 await assert.rejects(()=>collectLiveToken({chain:'base',address:'0x0000000000000000000000000000000000000001'},options),/A27_MARGINAL_MODE_REQUIRED/);assert.equal(reads,0);
});

test('CLI requires A27 directory value before API or database creation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a27-cli-boundary-'));try{
  const config=join(dir,'config.json'),raw=JSON.stringify(starterConfig());writeFileSync(config,raw);
  for(const [name,tail]of [['missing',[]],['following',['--json']]]as const){let reads=0;const out:string[]=[],err:string[]=[],db=join(dir,name+'.sqlite');const code=await runCli(['analyze',token.address,'--partial','--advisory','--config',config,'--db',db,'--a27-marginal-capture',...tail],{env:{},isInteractive:false,stdout:s=>out.push(s),stderr:s=>err.push(s),fetcher:async()=>{reads++;throw Error('UNEXPECTED_API');}});assert.equal(code,2);assert.match(err.join(''),/^FLAG_VALUE_REQUIRED:/);assert.equal(reads,0);assert.equal(existsSync(db),false);assert.equal(out.join(''),'');assert.equal(readFileSync(config,'utf8'),raw);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('unowned ordinary bundles receive no A27 allowance; malformed owned records fail before storage',async()=>{
 const ordinary=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,now:()=>cutoff,fetcher:a29LiveFetcher(token.address,cutoff)});assert.equal(validateA27MarginalBundle(ordinary,true).size,0);
 const dir=mkdtempSync(join(tmpdir(),'a27-storage-boundary-'));try{
  const malformed=structuredClone(ordinary),raw='{"fabricated":true}';malformed.rawArtifacts[A27_CAPTURE_ID]=raw;malformed.evidence.push({id:A27_CAPTURE_ID,sourceId:A27_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:A27_ADAPTER,availableAt:cutoff,retrievedAt:cutoff,contentHash:createHash('sha256').update(raw).digest('hex'),scope:a27MarginalScope('CAPTURE')});
  assert.throws(()=>validateA27MarginalBundle(malformed,true));assert.throws(()=>validateA27MarginalBundle(malformed,false));
  const service=new Service(join(dir,'test.sqlite'));try{assert.throws(()=>service.analyzeLive(malformed));}finally{service.close();}
  const orphan=structuredClone(ordinary);orphan.rawArtifacts[A27_CAPTURE_ID]=raw;assert.throws(()=>validateA27MarginalBundle(orphan,true));
  const descriptor=structuredClone(ordinary),proof=JSON.parse(descriptor.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v69';proof.a27Marginal=a27MarginalDescriptor();descriptor.rawArtifacts['advisory-derivation']=JSON.stringify(proof);assert.throws(()=>validateA27MarginalBundle(descriptor,true));
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('facts68 keeps the mandatory ordinary short-demand supplement registration',async()=>{
 const ordinary=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,now:()=>cutoff,fetcher:a29LiveFetcher(token.address,cutoff)});
 const facts=ordinary.details!.advisory!;assert.ok(facts.supplements?.shortDemand);
 // Schema-only version admission: these constructed facts carry no source authority.
 for(const method of ['advisory-measurements-v67','advisory-measurements-v68'] as const){
  const current={...facts,method};assert.equal(advisoryFactsSchema.safeParse(current).success,true,method);
  const {supplements,...missing}=current;assert.equal(advisoryFactsSchema.safeParse(missing).success,false,method);
 }
});
