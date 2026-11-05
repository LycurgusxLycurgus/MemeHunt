import { creatorRolePageRequest, creatorRoleIndexRequest, creatorRoleTransactionRequest } from '../src/providers/advisory-creator-role.js';
import { decodeCreatorRole } from '../src/providers/advisory-creator-role-collector.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { runCli } from '../src/cli.js';
import { SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';

const mint='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',token={chain:'solana' as const,address:mint},key='tinyfish-role-only-key';
const pool='4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',quote='So11111111111111111111111111111111111111112',TF='https://api.fetch.tinyfish.ai/';
const at='2026-10-10T12:30:00.000Z',hour=Date.parse('2026-10-10T12:00:00.000Z')/1000,day=Date.parse('2026-10-10T00:00:00.000Z')/1000;

/** Portable public fixture (copied from the creator-role collector test): RPC genesis, empty indexes, null accounts, one DEX pair; TinyFish answers HTTP 404. */
function fixture(){
 const calls:Array<{url:string;headers:Record<string,string>;body:string}>=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);calls.push({url,headers:{...(init?.headers as Record<string,string>)},body:String(init?.body??'')});
  if(url===TF)return new Response('',{status:404});
  if(init?.method==='POST'){const request=JSON.parse(String(init.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:request.method==='getSignaturesForAddress'?[]:{context:{slot:1},value:null}}));}
  let value:unknown;
  if(url.includes('/token-pairs/'))value=[{chainId:'solana',dexId:'pumpswap',pairAddress:pool,baseToken:{address:mint},quoteToken:{address:quote},priceUsd:'1',liquidity:{usd:10000},volume:{h24:100},txns:{h24:{buys:4,sells:3}}}];
  else if(url.includes('include=base_token'))value={data:{id:`solana_${pool}`,type:'pool',attributes:{address:pool},relationships:{base_token:{data:{id:`solana_${mint}`,type:'token'}},quote_token:{data:{id:`solana_${quote}`,type:'token'}}}},included:[mint,quote].map(address=>({id:`solana_${address}`,type:'token',attributes:{address}}))};
  else if(url.includes('ohlcv'))value={data:{attributes:{ohlcv_list:Array.from({length:75},(_,i)=>[hour-i*3600,10+i%6,11+i%6,9+i%6,10+i%6,20])}}};
  else if(url.includes('coinbase'))value=Array.from({length:75},(_,i)=>[hour-i*3600,9+i%6,11+i%6,10+i%6,10+i%6,2]);
  else if(url.includes('llama'))value={chain:new URL(url).pathname.split('/').at(-1),totalDataChart:[[day-172800,10],[day-86400,20],[day,999]]};
  else if(url.includes('/orders/'))value={orders:[],boosts:[]};
  else throw new Error(`Unexpected fixture request ${url}`);
  return new Response(JSON.stringify(value));
 };
 return{fetcher,calls};
}
const live=(fetcher:typeof fetch,extra:Record<string,unknown>={})=>collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher,now:()=>at,...extra});
const proofOf=(b:{rawArtifacts:Record<string,string>})=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const noGemini=(calls:Array<{url:string}>)=>assert.ok(!calls.some(c=>/generativelanguage|gemini/i.test(c.url)));

test('CLI rejects every invalid creator-role-only mode and a missing key before any fetch, config or database write',async()=>{
 const evm='0x'+'ab'.repeat(20),original=globalThis.fetch;let fetched=0;
 globalThis.fetch=(async()=>{fetched++;throw new Error('NETWORK_FORBIDDEN');}) as typeof fetch;
 const cases:Array<[string,string[],Record<string,string>,RegExp]>=[
  ['full',['--full','--advisory'],{TINYFISH_API_KEY:key,GEMINI_API_KEY:'g'},/CREATOR_ROLE_MODE_REQUIRED/],
  ['no-mode',['--advisory'],{TINYFISH_API_KEY:key},/CREATOR_ROLE_MODE_REQUIRED/],
  ['no-advisory',['--partial'],{TINYFISH_API_KEY:key},/CREATOR_ROLE_MODE_REQUIRED/],
  ['with-history',['--partial','--advisory','--creator-history'],{TINYFISH_API_KEY:key},/CREATOR_ROLE_MODE_REQUIRED/],
  ['evm',['--partial','--advisory','--chain','base'],{TINYFISH_API_KEY:key},/CREATOR_ROLE_MODE_REQUIRED/],
  ['missing-key',['--partial','--advisory'],{},/TINYFISH_KEY_MISSING/],
 ];
 try{
  for(const [name,flags,env,expected] of cases){
   const dir=mkdtempSync(join(tmpdir(),'creator-role-only-cli-'));let err='';
   try{
    const address=name==='evm'?evm:mint;
    const code=await runCli(['analyze',address,'--creator-role-only','--db',join(dir,'dd.sqlite'),...flags],{env,isInteractive:false,stdout:()=>{},stderr:(s:string)=>{err+=s;}});
    assert.equal(code,2,name);assert.match(err,expected,name);assert.ok(!err.includes(key),name);
    assert.deepEqual(readdirSync(dir),[],name);
   }finally{rmSync(dir,{recursive:true,force:true});}
  }
  // A bundle replay never accepts the live-only mode.
  const dir=mkdtempSync(join(tmpdir(),'creator-role-only-bundle-'));let err='';
  try{
   const code=await runCli(['analyze','--bundle',join(dir,'missing.json'),'--creator-role-only','--db',join(dir,'dd.sqlite')],{env:{TINYFISH_API_KEY:key},isInteractive:false,stdout:()=>{},stderr:(s:string)=>{err+=s;}});
   assert.equal(code,2);assert.match(err,/CREATOR_ROLE_MODE_REQUIRED/);assert.deepEqual(readdirSync(dir),[]);
  }finally{rmSync(dir,{recursive:true,force:true});}
  assert.equal(fetched,0);
 }finally{globalThis.fetch=original;}
});

test('direct LiveOptions reject invalid role-only combinations before any fetch',async()=>{
 const f=fixture();
 await assert.rejects(live(f.fetcher,{creatorRoleOnly:true,tinyfishKey:key,advisoryEnabled:false}),/CREATOR_ROLE_MODE_REQUIRED/);
 await assert.rejects(live(f.fetcher,{creatorRoleOnly:true,tinyfishKey:key,semanticEnabled:true}),/CREATOR_ROLE_MODE_REQUIRED/);
 await assert.rejects(live(f.fetcher,{creatorRoleOnly:true}),/TINYFISH_KEY_MISSING/);
 await assert.rejects(collectLiveToken({chain:'base',address:'0x'+'ab'.repeat(20)} as any,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,creatorRoleOnly:true,tinyfishKey:key,fetcher:f.fetcher,now:()=>at}),/CREATOR_ROLE_MODE_REQUIRED|ADVISORY_CHAIN_UNSUPPORTED/);
 assert.equal(f.calls.length,0);
});

test('role-only run retains the failed page as the only creator receipt, skips every creator branch, and persists and replays idempotently',async()=>{
 const f=fixture(),bundle=await live(f.fetcher,{creatorRoleOnly:true,tinyfishKey:key});
 const page=f.calls.filter(c=>c.url===TF);
 assert.equal(page.length,1);assert.equal(page[0]!.headers['X-API-Key'],key);
 assert.deepEqual(JSON.parse(page[0]!.body).urls,[`https://pump.fun/coin/${mint}`]);
 assert.ok(!page[0]!.body.includes(key));noGemini(f.calls);
 assert.ok(!JSON.stringify(bundle).includes(key));
 const proof=proofOf(bundle);
 assert.deepEqual(Object.keys(proof.creatorRole.artifactIds),['page']);
 assert.equal(bundle.rawArtifacts['advisory-creatorRole-page'],JSON.stringify({error:{code:'WEB_FETCH_HTTP_404'}}));
 assert.deepEqual(bundle.evidence.filter(e=>e.sourceId==='advisory-creator-role').map(e=>e.id),['advisory-creatorRole-page']);
 for(const k of ['creatorAccounting','creatorRoutes','creatorCoverage','creatorEpisode','creatorInventory','creatorFailedFees'])assert.equal(proof[k],null,k);
 assert.ok(!Object.keys(bundle.rawArtifacts).some(id=>/^advisory-creator(Accounting|Routes|Coverage|Episode|Inventory|FailedFees)-/.test(id)));
 const s13=bundle.details!.advisory!.metrics.find(m=>m.id==='S13')!;
 assert.notEqual(s13.quality,'KNOWN');
 assert.deepEqual([(s13.data as any).creatorRole.quality,(s13.data as any).creatorRole.reasonCode],['MISSING','WEB_FETCH_HTTP_404']);
 const dir=mkdtempSync(join(tmpdir(),'creator-role-only-'));
 try{
  const service=new Service(join(dir,'live.sqlite'));
  try{const id=service.analyzeLive(bundle).id;assert.deepEqual(service.replay(id),service.show(id));assert.equal(service.analyzeLive(bundle).id,id);}
  finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('ordinary partial advisory without a TinyFish key performs no TinyFish read and has no creator-role descriptor',async()=>{
 const f=fixture(),bundle=await live(f.fetcher);
 assert.ok(!f.calls.some(c=>c.url===TF));noGemini(f.calls);
 const proof=proofOf(bundle);
 assert.equal(proof.creatorRole,null);
 assert.ok(!bundle.evidence.some(e=>e.sourceId==='advisory-creator-role'));
});

// Role-only positive regression. The transaction is the exact retained public RPC envelope in tests/fixtures/s13-nxpq-creation.json. The page and index receipts are constructed here to match the decoder's bindings. None of it is live proof of this run.
const nxMint='nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump',nxWallet='FFdBLYqL9rs5fUT38ArE8GV2L3BziEgG5LJUu6sshfkF',nxAt='2026-10-19T16:00:00.000Z';
const nxToken={chain:'solana' as const,address:nxMint};
function nxPrior(){
 const txRaw=readFileSync('tests/fixtures/s13-nxpq-creation.json','utf8'),actual=JSON.parse(txRaw),signature=actual.result.transaction.signatures[0] as string;
 const coin=`https://pump.fun/coin/${nxMint}`;
 const page=JSON.stringify({results:[{url:coin,final_url:coin,text:'Creator\n\nFFdB…hfkF\n',published_date:'2026-10-11T11:16:34.000Z',links:[`https://pump.fun/profile/${nxWallet}`]}],errors:[]});
 const index=JSON.stringify({jsonrpc:'2.0',id:1,result:[{signature,slot:actual.result.slot,blockTime:actual.result.blockTime,err:null,confirmationStatus:'finalized'}]});
 return{
  rawArtifacts:{page,index,'transaction-0':txRaw},
  retrievedAt:{page:nxAt,index:nxAt,'transaction-0':nxAt},
  requests:{page:creatorRolePageRequest(nxMint),index:creatorRoleIndexRequest(nxWallet),'transaction-0':creatorRoleTransactionRequest(signature)},
 };
}

test('role-only with a verified KNOWN prior binds S13 and still skips accounting, routes, episode, coverage, inventory and failed fees',async()=>{
 const prior=nxPrior();
 assert.equal(decodeCreatorRole(nxToken,prior,nxAt,true,true,true).quality,'KNOWN');
 const f=fixture();
 const bundle=await collectLiveToken(nxToken,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,creatorRoleOnly:true,creatorRolePrior:prior,fetcher:f.fetcher,now:()=>nxAt});
 assert.ok(!f.calls.some(c=>c.url===TF));noGemini(f.calls);
 const proof=proofOf(bundle),metrics=bundle.details!.advisory!.metrics;
 assert.deepEqual(Object.keys(proof.creatorRole.artifactIds),['page','index','transaction-0']);
 for(const k of ['creatorAccounting','creatorRoutes','creatorCoverage','creatorEpisode','creatorInventory','creatorFailedFees'])assert.equal(proof[k],null,k);
 assert.ok(!Object.keys(bundle.rawArtifacts).some(id=>/^advisory-creator(Accounting|Routes|Coverage|Episode|Inventory|FailedFees)-/.test(id)));
 const s13=metrics.find(m=>m.id==='S13')!;
 assert.deepEqual([s13.quality,s13.reasonCode,(s13.data as any).publicActorBindings.at(-1).wallet],['KNOWN','PUBLIC_CREATOR_ROLE_BINDING_VERIFIED',nxWallet]);
 for(const id of ['S14','S15','S17']){const m=metrics.find(x=>x.id===id);if(m)assert.notEqual(m.quality,'KNOWN',id);}
 const dir=mkdtempSync(join(tmpdir(),'creator-role-only-known-'));
 try{
  const service=new Service(join(dir,'live.sqlite'));
  try{const id=service.analyzeLive(bundle).id;assert.deepEqual(service.replay(id),service.show(id));assert.equal(service.analyzeLive(bundle).id,id);}
  finally{service.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
