import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { admittedFetchers,collectLiveToken } from '../src/app/live.js';
import { Service,decisionHash } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { SOLANA_MAINNET_GENESIS,TOKEN_2022_PROGRAM,decodeSolanaAddress,encodeSolanaAddress } from '../src/providers/solana.js';
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
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);
  assert.equal(proof.method,'advisory-provenance-v9');assert.ok(proof.wallets);assert.ok(proof.window);assert.deepEqual(proof.accounts,{requests:{},artifactIds:{}});assert.deepEqual(proof.automation,{requests:{},artifactIds:{}});assert.deepEqual(proof.topology,{requests:{},artifactIds:{}});assert.equal(proof.window.end,'2026-10-10T12:00:00.000Z');
  assert.ok(bundle.evidence.some(e=>e.sourceId==='advisory-wallets'&&e.id==='advisory-wallets-wallet-genesis'));
  const facts=bundle.details.advisory;
  assert.equal(facts.method,'advisory-measurements-v10');
  assert.equal(facts.metrics.length,50);assert.equal(facts.metrics.find(m=>m.id==='C08')?.quality,'KNOWN');
  assert.equal(facts.metrics.find(m=>m.id==='C11')?.quality,'KNOWN');assert.equal(facts.metrics.find(m=>m.id==='C15')?.quality,'KNOWN');
  assert.equal(facts.metrics.find(m=>m.id==='A22')?.quality,'MISSING');assert.equal(facts.metrics.find(m=>m.id==='O26')?.quality,'MISSING');
  const directory=mkdtempSync(join(tmpdir(),'advisory-integration-')),file=join(directory,'live.sqlite');
  try{
    const writer=new Service(file);let id='';
    try{const saved=writer.analyzeLive(bundle);id=saved.id;assert.ok(saved.result.checks.filter(c=>c.checkId.startsWith('ADV-')).every(c=>c.status==='UNKNOWN'&&c.reasonCode==='ADVISORY_METRICS_INCOMPLETE'));}finally{writer.close();}
    const reader=new Service(file);try{assert.deepEqual(reader.replay(id),reader.show(id));assert.equal(reader.analyzeLive(bundle).id,id);}finally{reader.close();}
    const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id)!.semantic as string).policyVersion,'research-screen-advisory-v10');}finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

for(const version of [7,8,9])test(`a saved research-screen-advisory-v${version} snapshot still replays from its stored facts`,async()=>{
  const bundle=await collect(),directory=mkdtempSync(join(tmpdir(),'advisory-v7-replay-')),file=join(directory,'live.sqlite');
  try{
    const writer=new Service(file);let id='',relabeled='';try{id=writer.analyzeLive(bundle).id;}finally{writer.close();}
    const db=new DatabaseSync(file);
    try{
      db.exec('DROP TRIGGER snapshots_no_update');
      const stored=db.prepare('SELECT payload,semantic FROM snapshots WHERE id=?').get(id) as {payload:string;semantic:string};
      const payload=JSON.parse(stored.payload),semantic=JSON.parse(stored.semantic);
      semantic.policyVersion=`research-screen-advisory-v${version}`;semantic.details.advisory.method=`advisory-measurements-v${version}`;
      if(payload.details?.advisory)payload.details.advisory.method=`advisory-measurements-v${version}`;
      payload.hash=relabeled=decisionHash(semantic);
      db.prepare('UPDATE snapshots SET payload=?,hash=?,semantic=? WHERE id=?').run(JSON.stringify(payload),payload.hash,JSON.stringify(semantic),id);
    }finally{db.close();}
    const reader=new Service(file);try{const replayed=reader.replay(id);assert.deepEqual(replayed,reader.show(id));assert.equal(replayed.hash,relabeled);}finally{reader.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('trader-account history has its own bounded allowance and never consumes the shared 150-request budget',()=>{
  let calls=0;const base:typeof fetch=async()=>{calls++;return new Response('{}');};
  const controller=new AbortController(),admission=admittedFetchers(base,controller.signal,64);
  for(let i=0;i<64;i++)void admission.accountFetcher('https://rpc.example');
  assert.throws(()=>admission.accountFetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  assert.deepEqual(admission.counts,{shared:0,accounts:64});
  for(let i=0;i<150;i++)void admission.fetcher('https://rpc.example');
  assert.throws(()=>admission.fetcher('https://rpc.example'),/COLLECTION_BUDGET/);
  assert.deepEqual({counts:admission.counts,limit:admission.limit,calls},{counts:{shared:150,accounts:64},limit:{shared:150,accounts:64},calls:214});
  const disabled=admittedFetchers(base,controller.signal,0);
  assert.throws(()=>disabled.accountFetcher('https://rpc.example'),/COLLECTION_BUDGET/);assert.deepEqual(disabled.counts,{shared:0,accounts:0});
  controller.abort(new Error('COLLECTION_DEADLINE'));
  const late=admittedFetchers(base,controller.signal,64);assert.throws(()=>late.accountFetcher('https://rpc.example'),/COLLECTION_DEADLINE/);assert.equal(late.counts.accounts,0);
});

test('advisory rehashed metric, raw request, clock and marker tampering cannot certify a live result',async()=>{
  const original=await collect(),directory=mkdtempSync(join(tmpdir(),'advisory-tamper-'));
  const reject=(name:string,mutate:(bundle:typeof original)=>void)=>{
    const candidate=structuredClone(original);mutate(candidate);const service=new Service(join(directory,`${name}.sqlite`));
    try{assert.throws(()=>service.analyzeLive(candidate),/ADVISORY_PROOF|FUTURE_EVIDENCE|FUTURE_|RAW_ARTIFACT_REQUIRED/,name);}finally{service.close();}
  };
  try{
    reject('normalized-o28-forgery',b=>{b.details!.baseline.find(a=>a.id==='O28')!.data={netQuoteFlowUsd:'999999999999',meaning:'fabricated organic buys'};b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,JSON.parse(b.rawArtifacts['advisory-derivation']!),b.thesis??null,b.features);});
    reject('normalized-market-forgery',b=>{b.market!.pairs[0]!.buys24h=999999;b.details!.baseline.find(a=>a.id==='O28')!.data={fabricated:true};b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,JSON.parse(b.rawArtifacts['advisory-derivation']!),b.thesis??null,b.features);});
    reject('legacy-proof-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v1';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('wallet-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v2';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('wallet-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.wallets;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v3';delete proof.window;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-abi-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v4';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-fee-basis-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v5';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-unsafe-window-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v5';delete proof.accounts;delete proof.automation;delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('accounts-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v6';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('accounts-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.accounts;delete proof.automation;delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-accounts-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v6';delete proof.accounts;delete proof.automation;delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('automation-proof-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v7';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('automation-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.automation;delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('self-consistent-automation-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v7';delete proof.automation;delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('topology-version-downgrade',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v8';delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');b.details!.advisory=reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features);});
    reject('topology-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.topology;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('claimed-topology-measurement',b=>{b.details!.advisory!.metrics.find(m=>m.id==='O21')!.data={largestProvenControlFraction:'1',inventedOwners:true};});
    reject('claimed-automation-measurement',b=>{b.details!.advisory!.metrics.find(m=>m.id==='O30')!.quality='KNOWN';b.details!.advisory!.metrics.find(m=>m.id==='O30')!.data={knownAutomatedFraction:'0',claim:'bot-free'};for(const group of b.details!.advisory!.groups)if(group.unresolved.includes('O30')){group.known++;group.unresolved=group.unresolved.filter(id=>id!=='O30');}});
    reject('forged-automation-receipt',b=>{
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),key='automation-program',id=`advisory-automation-${key}`;
      const request={method:'getAccountInfo',params:[pool,{commitment:'finalized',encoding:'base64',minContextSlot:1,dataSlice:{offset:0,length:0}}]};
      proof.automation={requests:{[key]:request},artifactIds:{[key]:id}};b.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:1},value:{executable:true}}});
      const template=b.evidence.find(e=>e.sourceId==='advisory-window')!;b.evidence.push({...structuredClone(template),id,sourceId:'advisory-automation',scope:{...template.scope,request}});rehash(b,id);
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
    });
    reject('forged-accounts-receipt',b=>{
      // A receipt for a window that never bound any trader account must not enter the proof.
      const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!),key='account-0-page-0',id=`advisory-accounts-${key}`;
      const request={method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit:32,minContextSlot:1}]};
      proof.accounts={requests:{[key]:request},artifactIds:{[key]:id}};b.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,result:[]});
      const template=b.evidence.find(e=>e.sourceId==='advisory-window')!;b.evidence.push({...structuredClone(template),id,sourceId:'advisory-accounts',scope:{...template.scope,request}});rehash(b,id);
      b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');
      assert.throws(()=>reconstructAdvisory(token,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features),/ADVISORY_ACCOUNTS_RECEIPT_MEMBERSHIP/);
    });
    reject('window-proof-descriptor-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.window;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-future-end',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.window.end='2026-10-10T12:31:00.000Z';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-request-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete proof.window.requests['window-genesis'];b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
    reject('window-raw-removal',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);delete b.rawArtifacts[proof.window.artifactIds['window-genesis']];});
    reject('context-request-forgery',b=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.context.requests['bridge-page-0'].url='https://unrelated.example';b.evidence.find(e=>e.id===proof.context.artifactIds['bridge-page-0'])!.scope.request=proof.context.requests['bridge-page-0'];b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);rehash(b,'advisory-derivation');});
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
  bundle.details!.advisory=reconstructAdvisory(token,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,proof,bundle.thesis??null,bundle.features);
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


test('C10 evaluates frozen typed entry conditions and binds their retained configuration',async()=>{
 const thesis={support:[{op:'eq' as const,feature:'O28',value:true,unit:'bool'}],invalidation:[{op:'eq' as const,feature:'O28',value:false,unit:'bool'}],catalyst:null,expiryAt:null,onchainTraction:null,externalTraction:null,warning:null,legs:[]};
 const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher,now:()=>at,thesis});
 const metric=bundle.details!.advisory!.metrics.find(m=>m.id==='C10')!;assert.equal(metric.quality,'KNOWN');
 const data=metric.data as {support:{truth:string}[];invalidation:{truth:string}[]};assert.equal(data.support[0]!.truth,'TRUE');assert.equal(data.invalidation[0]!.truth,'FALSE');
 const directory=mkdtempSync(join(tmpdir(),'advisory-thesis-'));const service=new Service(join(directory,'live.sqlite'));
 try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);
 const mutated=structuredClone(bundle),raw=JSON.parse(mutated.rawArtifacts['advisory-thesis-context']!);raw.thesis.support[0].value=false;mutated.rawArtifacts['advisory-thesis-context']=JSON.stringify(raw);rehash(mutated,'advisory-thesis-context');assert.throws(()=>service.analyzeLive(mutated),/ADVISORY_PROOF/);
 }finally{service.close();rmSync(directory,{recursive:true,force:true});}
 const unavailable=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher,now:()=>at,thesis:{...thesis,support:[{op:'eq',feature:'S01',value:true,unit:'bool'}]}});
 assert.equal(unavailable.details!.advisory!.metrics.find(m=>m.id==='C10')!.quality,'MISSING');
});

test('full Token-2022 topology waits for late canonical mint capture and persists reconstructed grants',async()=>{
  const owner=encodeSolanaAddress(Buffer.alloc(32,31)),delegate=encodeSolanaAddress(Buffer.alloc(32,32)),account=encodeSolanaAddress(Buffer.alloc(32,33));
  const mint=Buffer.alloc(82);mint.writeBigUInt64LE(100n,36);mint[44]=6;mint[45]=1;
  const full=Buffer.alloc(170);decodeSolanaAddress(token.address).copy(full);decodeSolanaAddress(owner).copy(full,32);full.writeBigUInt64LE(100n,64);full.writeUInt32LE(1,72);decodeSolanaAddress(delegate).copy(full,76);full[108]=1;full.writeBigUInt64LE(30n,121);full[165]=2;full.writeUInt16LE(7,166);
  const calls:string[]=[];
  const liveFetcher:typeof fetch=async(input,init)=>{
    if(init?.method==='POST'){
      const req=JSON.parse(String(init.body));
      if(req.method==='getAccountInfo'&&req.params[0]===token.address){
        calls.push(req.params[1].encoding==='jsonParsed'?'mint-parsed':'mint-raw');
        const value=req.params[1].encoding==='jsonParsed'?{owner:TOKEN_2022_PROGRAM,executable:false,data:{program:'spl-token-2022',parsed:{type:'mint',info:{decimals:6,supply:'100',isInitialized:true,mintAuthority:null,freezeAuthority:null}}}}:{owner:TOKEN_2022_PROGRAM,executable:false,space:82,data:[mint.toString('base64'),'base64']};
        return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:1},value}}));
      }
      if(req.method==='getProgramAccounts'&&req.params[0]===TOKEN_2022_PROGRAM){
        const sliced=!!req.params[1].dataSlice;calls.push(sliced?'population-sliced':'population-full');
        return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:2},value:[{pubkey:account,account:{owner:TOKEN_2022_PROGRAM,executable:false,space:170,data:[(sliced?full.subarray(0,165):full).toString('base64'),'base64']}}]}}));
      }
    }
    return fetcher(input,init);
  };
  const bundle=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:true,advisoryEnabled:true,fetcher:liveFetcher,now:()=>at});
  assert.ok(calls.indexOf('population-full')>calls.indexOf('mint-raw'));assert.equal(calls.filter(x=>x==='population-full').length,1);
  const m=bundle.details!.advisory!.metrics.find(m=>m.id==='O21')!;assert.equal(m.quality,'KNOWN');assert.equal((m.data as any).approvedExposure.effectiveAtomic,'30');
  const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);assert.equal(Object.keys(proof.topology.artifactIds).length,0);assert.ok(m.evidenceIds.includes('rpc-holder-population'));
  const directory=mkdtempSync(join(tmpdir(),'advisory-topology-live-')),service=new Service(join(directory,'live.sqlite'));
  try{const saved=service.analyzeLive(bundle);assert.deepEqual(service.replay(saved.id),saved);const forged=structuredClone(bundle);(forged.details!.advisory!.metrics.find(m=>m.id==='O21')!.data as any).approvedExposure.effectiveAtomic='100';assert.throws(()=>service.analyzeLive(forged),/ADVISORY_PROOF/);}finally{service.close();rmSync(directory,{recursive:true,force:true});}
});
