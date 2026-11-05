import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeCreatorEpisode,collectCreatorEpisode,type CreatorEpisodeReceipts} from '../src/providers/advisory-creator-episode.js';
import {decodeCreatorQuoteAccounting,type CreatorQuoteReceipts} from '../src/providers/advisory-creator-quote.js';
import {decodeCreatorCoverage} from '../src/providers/advisory-creator-coverage.js';
import {decodeCreatorRoutes,creatorRouteRequest,type CreatorRouteReceipts} from '../src/providers/advisory-creator-routes.js';
import {creatorRoleTransactionRequest} from '../src/providers/advisory-creator-role.js';
import {archiveDemandReceipt} from '../src/providers/advisory-demand-windows.js';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
const f=JSON.parse(readFileSync('tests/fixtures/s15-native-quote-history.json','utf8')),h=JSON.parse(readFileSync('tests/fixtures/s15-helius-routes.json','utf8')),aq=JSON.parse(readFileSync('tests/fixtures/s15-quote-acquisition.json','utf8'));
const cutoff='2026-10-23T23:00:00.000Z',role:any={quality:'KNOWN',binding:f.binding},env=(result:any)=>JSON.stringify({jsonrpc:'2.0',id:1,result});
// Constructed complete census over genuine seven receipts; not a live whole-wallet claim.
function packet(){
 const slot=JSON.parse(f.raw.head).result.context.slot,rows=JSON.parse(f.raw.index).result;
 const c:CreatorQuoteReceipts={requests:{genesis:{method:'getGenesisHash',params:[]},head:f.requests.head,index:{method:'getSignaturesForAddress',params:[f.account,{limit:1000,commitment:'finalized',minContextSlot:slot}]}},rawArtifacts:{genesis:env(SOLANA_MAINNET_GENESIS),head:f.raw.head,index:f.raw.index},retrievedAt:{genesis:cutoff,head:cutoff,index:cutoff}};
 const route:CreatorRouteReceipts={requests:{},rawArtifacts:{},retrievedAt:{}},cover:CreatorQuoteReceipts={requests:{genesis:{method:'getGenesisHash',params:[]},head:{method:'getSlot',params:[{commitment:'finalized'}]},catalog:{method:'getTokenAccountsByOwner',params:[f.binding.wallet,{mint:f.token.address},{encoding:'jsonParsed',commitment:'finalized',minContextSlot:slot}]},'page-0':{method:'getSignaturesForAddress',params:[f.binding.wallet,{limit:1000,commitment:'finalized',minContextSlot:slot}]}},rawArtifacts:{genesis:env(SOLANA_MAINNET_GENESIS),head:env(slot),catalog:env({context:{slot},value:[]}),'page-0':env(rows)},retrievedAt:{}};
 for(const [i,row]of rows.entries()){const id='transaction-'+i;c.requests[id]=creatorRoleTransactionRequest(row.signature);c.rawArtifacts[id]=f.raw['tx-'+row.signature];c.retrievedAt[id]=cutoff;route.requests[id]=creatorRouteRequest(row.signature);route.rawArtifacts[id]=h[row.signature].raw;route.retrievedAt[id]=h[row.signature].retrievedAt;const cid='transaction-'+row.signature;cover.requests[cid]=creatorRoleTransactionRequest(row.signature);cover.rawArtifacts[cid]=archiveDemandReceipt(f.raw['tx-'+row.signature]);}
 for(const key of Object.keys(cover.requests))cover.retrievedAt[key]=cutoff;
 const acquisition:CreatorEpisodeReceipts={requests:{},rawArtifacts:{},retrievedAt:{}};for(const key of ['index','transaction','helius','block']){acquisition.requests[key]=aq[key].request;acquisition.rawArtifacts[key]=aq[key].raw;acquisition.retrievedAt[key]=aq[key].retrievedAt;}
 return{c,route,cover,acquisition};
}
function decoded(p=packet()){
 const a=decodeCreatorQuoteAccounting(f.token,role,p.c,cutoff,true),r=decodeCreatorRoutes(role,a,p.c,p.route,cutoff),v=decodeCreatorCoverage(f.token,role,f.account,p.cover,cutoff,r.records.map(x=>x.signature),{slot:a.coverage.headSlot,amountAtomic:a.coverage.canonicalHeadAtomic});
 return{a,r,v};
}
function decode(p=packet()){const {a,r,v}=decoded(p);return decodeCreatorEpisode(role,a,p.c,r,v,p.acquisition,cutoff);}
test('S15 v2 exact executed acquisition basis and closed target principal result conserve single lot and all disposed units',()=>{
 const d=decode();assert.equal(d.status,'KNOWN',JSON.stringify(d));if(d.status!=='KNOWN')return;
 assert.deepEqual(d.basis.targetLamports,{numerator:'9865585420000000',denominator:'2465503'});assert.deepEqual(d.realized.resultLamports,{numerator:'8801296488307315',denominator:'2465503'});
 assert.equal(d.basis.displayCeilingLamports,'4001449368');assert.equal(d.realized.displayFloorLamports,'3569777237');assert.equal(d.realized.grossProceedsLamports,'7571226605');assert.equal(d.acquisition.acquisition!.capitalInLamports,'5670000000');
 assert.equal(BigInt(d.basis.targetLamports.numerator)+BigInt(d.basis.otherQuoteLamports.numerator),9670000000n*2465503n);
 let n=0n,den=1n;for(const lot of d.realized.disposedLots){const b=lot.basisLamports;n=n*BigInt(b.denominator)+BigInt(b.numerator)*den;den*=BigInt(b.denominator);}assert.equal(n*2465503n,9865585420000000n*den);
 assert.equal(d.aggregateNetProfit,null);assert.equal(d.costs.subtractedFromPrincipalResult,false);assert.equal(d.method,'creator-only-closed-target-episode-v2');
});
test('same-block order, quote opening/depletion, principal, independent corroboration and clocks cannot be mutated into KNOWN',()=>{
 const mutations:Array<(p:ReturnType<typeof packet>)=>void>=[
 p=>{const b=JSON.parse(p.acquisition.rawArtifacts.block!);b.result.signatures.reverse();p.acquisition.rawArtifacts.block=JSON.stringify(b);},
 p=>{const b=JSON.parse(p.acquisition.rawArtifacts.transaction!);b.result.meta.preTokenBalances.find((x:any)=>x.mint===f.binding.creation.quoteMint).uiTokenAmount.amount='1';p.acquisition.rawArtifacts.transaction=JSON.stringify(b);},
 p=>{const b=JSON.parse(p.acquisition.rawArtifacts.transaction!);b.result.meta.postTokenBalances.find((x:any)=>x.mint===f.binding.creation.quoteMint).uiTokenAmount.amount='4931007';p.acquisition.rawArtifacts.transaction=JSON.stringify(b);},
 p=>{const b=JSON.parse(p.acquisition.rawArtifacts.helius!);b[0].parsed.instructions.find((x:any)=>x.instructionName==='swap_v2').decoded.args.amount='1';p.acquisition.rawArtifacts.helius=JSON.stringify(b);},
 p=>{p.acquisition.retrievedAt.block='2026-10-24T00:00:00.000Z';},
 p=>{p.acquisition.requests.block={method:'getBlock',params:[1]};},
 p=>{delete p.acquisition.requests.helius;delete p.acquisition.rawArtifacts.helius;delete p.acquisition.retrievedAt.helius;},
 p=>{p.acquisition.requests.orphan=p.acquisition.requests.index!;p.acquisition.rawArtifacts.orphan=p.acquisition.rawArtifacts.index!;p.acquisition.retrievedAt.orphan=cutoff;},
 ];
 for(const mutate of mutations){const p=packet();mutate(p);let known=false;try{known=decode(p).status==='KNOWN';}catch{}assert.equal(known,false);}
});
test('no complete census, reopening, in-window failed row or held units means no closed-episode result',()=>{
 for(const mode of ['coverage','reopen','failed','held']){const p=packet(),{a,r,v}=decoded(p);if(mode==='coverage')v.wholeWalletComplete=false;if(mode==='reopen')v.targetSignatures.push('EXTRA_TARGET_SUCCESS');if(mode==='failed')v.failedFees.classification!.rows.push({slot:f.binding.creation.slot+1} as any);if(mode==='held')v.canonicalCatalogAtomic='1';assert.equal(decodeCreatorEpisode(role,a,p.c,r,v,p.acquisition,cutoff).status,'MISSING');}
 const p=packet(),{a,r,v}=decoded(p);v.failedFees.classification!.rows.push({slot:r.records.at(-1)!.slot+1,actorChargedLamports:'5000',targetReference:null} as any);v.failedFees.creatorChargedLamports='5000';const d=decodeCreatorEpisode(role,a,p.c,r,v,p.acquisition,cutoff);assert.equal(d.status,'KNOWN');if(d.status==='KNOWN'){assert.equal(d.outsideEpisode.creatorChargedLamports,'5000');assert.equal(d.outsideEpisode.failedRows[0]!.targetReference,null);}
});
test('bounded collector requests only four exact sources; independent API credentials never enter retained metadata',async()=>{
 const p=packet(),{a}=decoded(p),calls:string[]=[],secret='TEST_EPISODE_SECRET';
 const r=await collectCreatorEpisode(role,a,p.c,'https://rpc.example',secret,async(url,init)=>{const body=JSON.parse(String(init?.body)),request=body.jsonrpc?{method:body.method,params:body.params}:creatorRouteRequest(body.transactions[0]),key=Object.keys(p.acquisition.requests).find(k=>JSON.stringify(p.acquisition.requests[k])===JSON.stringify(request));assert.ok(key);calls.push(key!);if(key==='helius')assert.ok(String(url).endsWith(secret));return new Response(p.acquisition.rawArtifacts[key!]);},()=>cutoff);
 assert.deepEqual(calls,['index','transaction','helius','block']);assert.equal(JSON.stringify(r).includes(secret),false);assert.equal(decodeCreatorEpisode(role,a,p.c,decoded(p).r,decoded(p).v,r,cutoff).status,'KNOWN');
 const abort=new AbortController();abort.abort();await assert.rejects(collectCreatorEpisode(role,a,p.c,'https://rpc.example',secret,fetch,()=>cutoff,abort.signal));
});
