import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { advisoryFactsSchema } from '../src/domain/advisory-contracts.js';
import { reconstructAdvisory } from '../src/app/advisory.js';
import { deriveSocial } from '../src/domain/social.js';
import { makeSocialFixture,SOCIAL_TOKEN,SOCIAL_CUTOFF } from './social-fixtures.js';
import { evaluateEntry } from '../src/domain/policy.js';

const token={chain:'solana' as const,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
const pool='4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',quote='So11111111111111111111111111111111111111112';
const at='2026-10-10T12:30:00.000Z',hour=Date.parse('2026-10-10T12:00:00.000Z')/1000,day=Date.parse('2026-10-10T00:00:00.000Z')/1000;
const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);let value:unknown;
  if(init?.method==='POST'){
    const request=JSON.parse(String(init.body));
    value={jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:request.method==='getSignaturesForAddress'?[]:{context:{slot:1},value:null}};
  }else if(url.includes('/token-pairs/'))value=[{chainId:'solana',dexId:'pumpswap',pairAddress:pool,baseToken:{address:token.address},quoteToken:{address:quote},priceUsd:'1',liquidity:{usd:10000},volume:{h24:100},txns:{h24:{buys:4,sells:3}}}];
  else if(url.includes('include=base_token'))value={data:{id:`solana_${pool}`,type:'pool',attributes:{address:pool},relationships:{base_token:{data:{id:`solana_${token.address}`,type:'token'}},quote_token:{data:{id:`solana_${quote}`,type:'token'}}}},included:[token.address,quote].map(address=>({id:`solana_${address}`,type:'token',attributes:{address}}))};
  else if(url.includes('ohlcv'))value={data:{attributes:{ohlcv_list:Array.from({length:75},(_,i)=>[hour-i*3600,10+i%6,11+i%6,9+i%6,10+i%6,20])}}};
  else if(url.includes('coinbase'))value=Array.from({length:75},(_,i)=>[hour-i*3600,9+i%6,11+i%6,10+i%6,10+i%6,2]);
  else if(url.includes('llama'))value={chain:new URL(url).pathname.split('/').at(-1),totalDataChart:[[day-172800,10],[day-86400,20],[day,999]]};
  else if(url.includes('/orders/'))value={orders:[{chainId:'solana',tokenAddress:token.address,type:'tokenProfile',status:'approved',paymentTimestamp:Date.parse(at)-1000}],boosts:[]};
  else throw new Error('Unexpected fixture request');
  return new Response(JSON.stringify(value));
};
const collect=(semanticEnabled=false)=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled,advisoryEnabled:true,fetcher,now:()=>at});
const rehash=(bundle:Awaited<ReturnType<typeof collect>>,id:string)=>{bundle.evidence.find(e=>e.id===id)!.contentHash=createHash('sha256').update(bundle.rawArtifacts[id]!).digest('hex');};

test('opt-in advisory history persists 50 truthful metric states and freezes distinct policy/reopen replay',async()=>{
  const bundle=await collect();assert.ok(bundle.details?.advisory);
  const facts=bundle.details.advisory;
  assert.equal(facts.metrics.length,50);assert.equal(facts.metrics.find(m=>m.id==='C08')?.quality,'KNOWN');
  assert.equal(facts.metrics.find(m=>m.id==='C11')?.quality,'KNOWN');assert.equal(facts.metrics.find(m=>m.id==='C15')?.quality,'KNOWN');
  assert.equal(facts.metrics.find(m=>m.id==='A22')?.quality,'MISSING');assert.equal(facts.metrics.find(m=>m.id==='O26')?.quality,'MISSING');
  const directory=mkdtempSync(join(tmpdir(),'advisory-integration-')),file=join(directory,'live.sqlite');
  try{
    const writer=new Service(file);let id='';
    try{const saved=writer.analyzeLive(bundle);id=saved.id;assert.ok(saved.result.checks.filter(c=>c.checkId.startsWith('ADV-')).every(c=>c.status==='UNKNOWN'&&c.reasonCode==='ADVISORY_METRICS_INCOMPLETE'));}finally{writer.close();}
    const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
    const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id)!.semantic as string).policyVersion,'research-screen-advisory-v1');}finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('advisory rehashed metric, raw request, clock and marker tampering cannot certify a live result',async()=>{
  const original=await collect(),directory=mkdtempSync(join(tmpdir(),'advisory-tamper-'));
  const reject=(name:string,mutate:(bundle:typeof original)=>void)=>{
    const candidate=structuredClone(original);mutate(candidate);const service=new Service(join(directory,`${name}.sqlite`));
    try{assert.throws(()=>service.analyzeLive(candidate),/ADVISORY_PROOF|FUTURE_EVIDENCE|FUTURE_/,name);}finally{service.close();}
  };
  try{
    reject('entire-details-removal',b=>{delete b.details;});
    reject('claimed-measurement',b=>{b.details!.advisory!.metrics.find(m=>m.id==='C08')!.data={returnFraction:'999'};});
    reject('wrong-request-token',b=>{
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);const key=Object.keys(proof.market.requests).find(k=>k==='market-candles')!;
      proof.market.requests[key].url=proof.market.requests[key].url.replace(token.address,quote);
      const record=b.evidence.find(e=>e.id===proof.market.artifactIds[key])!;record.scope.request=proof.market.requests[key];
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
    });
    reject('future-availability',b=>{const record=b.evidence.find(e=>e.sourceId==='advisory-market')!;record.availableAt='2026-10-11T00:00:00.000Z';record.retrievedAt=record.availableAt;});
    reject('receipt-token',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.token.address=quote;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('details-marker-removal',b=>{delete b.details!.advisory;});
    reject('both-marker-removal',b=>{delete b.details!.advisory;delete b.rawArtifacts['advisory-derivation'];b.evidence=b.evidence.filter(e=>e.id!=='advisory-derivation');});
    reject('request-catalog-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.market.requests['market-candles'];b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('measurement coverage cannot override required failures and old boolean policy is unchanged',async()=>{
  const bundle=await collect(),facts=structuredClone(bundle.details!.advisory!);
  for(const metric of facts.metrics){metric.quality='KNOWN';metric.data={observed:'0'};}
  for(const group of facts.groups){group.known=group.total;group.unresolved=[];}
  const measured=evaluateEntry(bundle.features,bundle.profile,at,'QUALIFIED_V2',undefined,false,advisoryFactsSchema.parse(facts));
  assert.ok(measured.checks.filter(c=>c.checkId.startsWith('ADV-')).every(c=>c.status==='PASS'&&c.reasonCode==='ADVISORY_CONTEXT_MEASURED'));
  assert.equal(measured.classification,'REJECTED');
  const historical=evaluateEntry(bundle.features,bundle.profile,at,'QUALIFIED_V2');
  assert.deepEqual(measured.checks.filter(c=>c.required),historical.checks.filter(c=>c.required));
  assert.ok(historical.checks.filter(c=>c.checkId.startsWith('ADV-')).every(c=>c.reasonCode!=='ADVISORY_CONTEXT_MEASURED'));
});

test('advisory inventory refuses duplicate metrics and forged coverage counts',async()=>{
  const bundle=await collect(),facts=structuredClone(bundle.details!.advisory!);
  facts.metrics[1]=facts.metrics[0]!;assert.equal(advisoryFactsSchema.safeParse(facts).success,false);
  const forged=structuredClone(bundle.details!.advisory!);forged.groups[0]!.known=forged.groups[0]!.total;forged.groups[0]!.unresolved=[];
  assert.equal(advisoryFactsSchema.safeParse(forged).success,false);
});


test('shared live provenance includes advisory parents before its frozen derivation and replays',async()=>{
  const bundle=await collect(true),directory=mkdtempSync(join(tmpdir(),'advisory-shared-'));
  try{
    assert.ok(bundle.details?.shared);assert.ok(bundle.details?.advisory);
    const packet=JSON.parse(bundle.rawArtifacts['shared-derivation']!);
    assert.ok(packet.evidence.some((e:{id:string})=>e.id==='advisory-derivation'));
    const service=new Service(join(directory,'live.sqlite'));
    try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);}finally{service.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});


test('a local-only reviewed social packet cannot certify advisory metrics without validated source/model provenance',async()=>{
  const bundle=await collect(),directory=mkdtempSync(join(tmpdir(),'advisory-social-proof-'));
  const shifted=JSON.stringify(makeSocialFixture()).replaceAll(SOCIAL_TOKEN.address,token.address).replace(/2026-10-0[234]T[^"]+/g,value=>new Date(Date.parse(value)+Date.parse(at)-Date.parse(SOCIAL_CUTOFF)).toISOString());
  const fixture=JSON.parse(shifted),packet={...fixture,token,cutoff:at,evidenceIds:[]};
  bundle.rawArtifacts['social-derivation']=JSON.stringify(packet);
  bundle.evidence.push({id:'social-derivation',sourceId:'social-collector',sourceType:'CALCULATION',accessMode:'LOCAL_DERIVED',retrievedAt:at,availableAt:at,contentHash:'pending',adapterVersion:'live-v1',scope:{method:'social-source-review-v1'}});
  rehash(bundle,'social-derivation');
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);proof.socialDerivationId='social-derivation';
  bundle.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(bundle,'advisory-derivation');
  bundle.details!.advisory=reconstructAdvisory(token,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,proof);
  assert.equal(bundle.details!.advisory.metrics.find(m=>m.id==='A19')?.quality,'KNOWN');
  try{
    const service=new Service(join(directory,'missing-social.sqlite'));
    try{assert.throws(()=>service.analyzeLive(bundle),/ADVISORY_PROOF_INVALID/);}finally{service.close();}
    // Adding normalized social facts still cannot replace the existing source/model validation.
    bundle.details!.social=deriveSocial(fixture.read,fixture.proposal,fixture.review,token,at,[]).facts;
    const candidate=new Service(join(directory,'unverified-social.sqlite'));
    try{assert.throws(()=>candidate.analyzeLive(bundle),/SOCIAL_PROOF_INVALID|SOCIAL_PROOF_REQUIRED|SOCIAL_SOURCE_INVALID/);}finally{candidate.close();}
    delete bundle.details!.social;
    const removed=new Service(join(directory,'removed-social.sqlite'));
    try{assert.throws(()=>removed.analyzeLive(bundle),/ADVISORY_PROOF_INVALID/);}finally{removed.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});
