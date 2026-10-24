import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync,existsSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectIndexedCreatorPosition,replayIndexedCreatorPosition } from '../src/providers/indexed-creator-position.js';
import { runCli } from '../src/cli.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';
const mint=encodeSolanaAddress(Buffer.alloc(32,21)),wallet=encodeSolanaAddress(Buffer.alloc(32,23)),signature=encodeSolanaAddress(Buffer.alloc(64,4)),at='2026-10-19T12:00:00.000Z';
const token=()=>({token:{mint,decimals:6,createdOn:'another-solana-venue',creation:{creator:wallet,created_tx:signature,created_time:1790000000}}});
const position=()=>({wallet,token:mint,pnlMode:'strict',pnl:{realized:10,unrealized:0,total:10},invested:20,proceeds:30,current:{balance:0,costBasis:0,value:0},volume:{tokensBought:10,tokensSold:10},counts:{buys:1,sells:1}});
function fixture(t:unknown=token(),p:unknown=position(),status=200){const calls:string[]=[];const fetcher:typeof fetch=async(url,init)=>{calls.push(String(url));assert.equal((init?.headers as Record<string,string>)['x-api-key'],'test-private-provider-key');assert.ok(!JSON.stringify(url).includes('test-private-provider-key'));return new Response(JSON.stringify(calls.length===1?t:p),{status:calls.length===1?200:status});};return{fetcher,calls};}
const collect=(f:ReturnType<typeof fixture>)=>collectIndexedCreatorPosition(mint,'test-private-provider-key',f.fetcher,()=>at);
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

test('any valid Solana mint can query indexed creator and position across venues, explicitly provider USD and never audited S15',async()=>{
 const f=fixture(),p=await collect(f),r=p.report as any;
 assert.equal(f.calls.length,2);assert.equal(r.status,'OBSERVED_PROVIDER_REPORT');assert.equal(r.denomination,'USD');assert.equal(r.reported.realizedPnl,'10');assert.equal(r.creator.wallet,wallet);assert.equal(r.creator.verifiedOnChain,false);assert.equal(r.validatedS15,null);assert.equal(r.completePerformance,false);
 assert.equal(r.networkFees,'UNESTABLISHED');assert.equal(r.inventory.tradeAmountsReconcile,true);
 assert.ok(!JSON.stringify(p).includes('test-private-provider-key'));assert.deepEqual(replayIndexedCreatorPosition(p),p);
});

test('transferred or unindexed units never turn a provider zero PnL into complete creator performance',async()=>{
 const v=position();v.volume.tokensBought=100;v.volume.tokensSold=0;v.pnl={realized:0,unrealized:0,total:0};v.proceeds=0;
 const r=(await collect(fixture(token(),v))).report as any;
 assert.deepEqual([r.status,r.reasonCode,r.inventory.tradeAmountsReconcile,r.reported.realizedPnl,r.validatedS15],['INCOMPLETE_REPORTED_INVENTORY','TRANSFER_OR_INDEX_GAP_UNRESOLVED',false,'0',null]);
});

test('missing creator, position, unavailable provider and wrong source identity never manufacture numeric results',async()=>{
 const missing=fixture({token:{mint}});assert.equal(((await collect(missing)).report as any).reported,null);assert.equal(missing.calls.length,1);
 const absent=(await collect(fixture(token(),{error:'Position not found'},404))).report as any;assert.deepEqual([absent.status,absent.reasonCode,absent.reported],['MISSING','POSITION_HTTP_404',null]);
 for(const mutate of [(p:any)=>p.token=wallet,(p:any)=>p.wallet=mint,(p:any)=>p.pnlMode='adjusted',(p:any)=>p.currency='sol',(p:any)=>p.invested=-1,(p:any)=>p.pnl.realized='10',(p:any)=>p.counts.buys=0.5,(p:any)=>p.identity={developer:{token:mint,creationTx:'wrong'}}]){const v=position();mutate(v);const r=(await collect(fixture(token(),v))).report as any;assert.equal(r.status,'INVALID');assert.equal(r.reported,null);}
 const fail=await collectIndexedCreatorPosition(mint,'key-that-is-private',async()=>{throw new Error('key-that-is-private');},()=>at);assert.ok(!JSON.stringify(fail).includes('key-that-is-private'));assert.equal((fail.report as any).reported,null);
});

test('immutable replay binds source bytes, URL, wallet, clocks and recomputed report; oversized sources and keys are rejected',async()=>{
 const original=await collect(fixture());
 const changes:Array<(p:any)=>void>=[p=>p.receipts.position.body+=' ',p=>p.receipts.position.request.url+='&currency=sol',p=>p.receipts.position.retrievedAt='2026-10-20T00:00:00.000Z',p=>p.receipts.position.retrievedAt='2026-10-18T00:00:00.000Z',p=>p.report.reported.realizedPnl='999',p=>p.receipts.position.body='x'.repeat(500001)];
 for(const change of changes){const p=structuredClone(original);change(p);const {sha256,...rest}=p;p.sha256=digest(rest);assert.throws(()=>replayIndexedCreatorPosition(p));}
 const wrong=structuredClone(original);(wrong as any).extra='orphan';assert.throws(()=>replayIndexedCreatorPosition(wrong));
 let calls=0;await assert.rejects(()=>collectIndexedCreatorPosition('invalid','key',async()=>{calls++;throw new Error('no');}),/INVALID_SOLANA_ADDRESS/);assert.equal(calls,0);
 await assert.rejects(()=>collectIndexedCreatorPosition(mint,'',fixture().fetcher),/KEY_MISSING/);
 const large=await collectIndexedCreatorPosition(mint,'test-private-provider-key',async()=>new Response('x'.repeat(500001)),()=>at);assert.equal((large.report as any).reported,null);assert.ok(large.receipts.token.body.length<100);
});

test('creator-position CLI and offline replay never open database/config files and require explicit provider credentials',async()=>{
 const d=mkdtempSync(join(tmpdir(),'creator-position-no-db-')),db=join(d,'must-not-exist.sqlite'),config=join(d,'must-not-exist.json'),file=join(d,'packet.json');
 const invoke=async(args:string[],f=fixture(),key=true)=>{const stdout:string[]=[],stderr:string[]=[];const code=await runCli([...args,'--json','--db',db,'--config',config],{env:key?{SOLANA_TRACKER_API_KEY:'test-private-provider-key'}:{},fetcher:f.fetcher,now:()=>at,stdout:s=>stdout.push(s),stderr:s=>stderr.push(s)});return{code,stdout:stdout.join(''),stderr:stderr.join(''),calls:f.calls};};
 try{
  const absent=await invoke(['creator-position',mint],fixture(),false);assert.equal(absent.code,2);assert.match(absent.stderr,/SOLANA_TRACKER_KEY_MISSING/);assert.equal(absent.calls.length,0);
  const p=await invoke(['creator-position',mint]);assert.equal(p.code,0,p.stderr);writeFileSync(file,p.stdout);
  const replay=await invoke(['creator-position-replay','--file',file],fixture(),false);assert.equal(replay.code,0,replay.stderr);assert.deepEqual(JSON.parse(replay.stdout),JSON.parse(p.stdout));assert.equal(replay.calls.length,0);
  assert.equal(existsSync(db),false);assert.equal(existsSync(config),false);
 }finally{rmSync(d,{recursive:true,force:true});}
});
