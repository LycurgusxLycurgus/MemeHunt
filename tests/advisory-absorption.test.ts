/** A29 provider tests. Constructed captures are portable fixtures with no live claim. The historical test uses actual retained O28 receipts
 * only to exercise the pinned decoder and owner binder; it makes no A29 interval-flow claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import BN from 'bn.js';
import {OFFLINE_PUMP_AMM_PROGRAM,PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,pumpPoolAuthorityPda,poolPda,userVolumeAccumulatorPda,FEE_CONFIG_SIZE_PRE_STABLE} from '@pump-fun/pump-swap-sdk';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
import {demandTransactionRequest} from '../src/providers/advisory-demand-windows.js';
import {decodeA29Capture,deriveA29Absorption,decodeA29BoundTrades,bindA29TradeAccount,canonicalJson} from '../src/providers/advisory-absorption.js';

const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes:Uint8Array):string{
 const digits:number[]=[];
 for(const byte of bytes){let carry=byte;for(let i=0;i<digits.length;i++){carry+=digits[i]!*256;digits[i]=carry%58;carry=Math.floor(carry/58);}while(carry>0){digits.push(carry%58);carry=Math.floor(carry/58);}}
 let zeros='';for(const byte of bytes){if(byte!==0)break;zeros+='1';}
 return zeros+digits.reverse().map(d=>ALPHABET[d]).join('');
}
export const A29_FIXTURE={slot0:1000,slot1:2600,t0:1800000000,defaultSeconds:900};
export type A29FixtureRow={signature:string;slot:number;blockTime:number|null;err:unknown};
export type A29FixtureOptions={label?:string;intervalSeconds?:number;pages?:A29FixtureRow[][];transactions?:Array<{signature:string;body:string}>;e1PopulationSlot?:number;mutate?:(packet:any)=>void};
export type A29Fixture={raw:string;packet:any;cutoff:string;t0:number;t1:number;mint:string;pool:string};
export function fixtureSignature(n:number){const b=Buffer.alloc(64,7);b[0]=9;b.writeUInt32BE(n,1);return base58(b);}
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)),rpc=(result:unknown)=>JSON.stringify({jsonrpc:'2.0',id:1,result});
const bn=(n:number)=>new BN(n),rates={lpFeeBps:bn(20),protocolFeeBps:bn(15),creatorFeeBps:bn(10)};
async function encode(name:string,v:any){const d=Buffer.from(await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode(name,v));return name==='feeConfig'?Buffer.concat([d,Buffer.alloc(Math.max(0,FEE_CONFIG_SIZE_PRE_STABLE-d.length))]):d;}
const account=(owner:PublicKey,data:Buffer)=>({owner:owner.toBase58(),data:[data.toString('base64'),'base64'],executable:false,lamports:2039280});
function mintData(supply:bigint,decimals:number){const b=Buffer.alloc(MintLayout.span);b.writeBigUInt64LE(supply,36);b[44]=decimals;b[45]=1;return b;}
function tokenData(mint:PublicKey,owner:PublicKey,amount:bigint){const b=Buffer.alloc(165);mint.toBuffer().copy(b);owner.toBuffer().copy(b,32);b.writeBigUInt64LE(amount,64);b[108]=1;return b;}

/** Portable KNOWN capture in the exact normalized packet shape. Options and mutate build tamper and gap variants. */
export async function buildA29Capture(o:A29FixtureOptions={}):Promise<A29Fixture>{
 const label=o.label??'Fixture',{slot0,slot1,t0}=A29_FIXTURE,t1=t0+(o.intervalSeconds??A29_FIXTURE.defaultSeconds),ms=(s:number)=>s*1000,T=1000000000000n,supply=1000n*T;
 const mint=key(7),pool=poolPda(0,pumpPoolAuthorityPda(mint),mint,NATIVE_MINT),baseVault=getAssociatedTokenAddressSync(mint,pool,true,TOKEN_PROGRAM_ID),quoteVault=getAssociatedTokenAddressSync(NATIVE_MINT,pool,true,TOKEN_PROGRAM_ID);
 const global=await encode('globalConfig',{admin:PublicKey.default,lpFeeBasisPoints:bn(20),protocolFeeBasisPoints:bn(15),disableFlags:0,protocolFeeRecipients:Array(8).fill(PublicKey.default),coinCreatorFeeBasisPoints:bn(10),adminSetCoinCreatorAuthority:PublicKey.default,whitelistPda:PublicKey.default,reservedFeeRecipient:PublicKey.default,mayhemModeEnabled:false,reservedFeeRecipients:Array(7).fill(PublicKey.default),isCashbackEnabled:false,buybackFeeRecipients:Array(8).fill(PublicKey.default),buybackBasisPoints:bn(0),boostAuthority:PublicKey.default,boostEnabled:false,creatorFeeConfigurable:true,maxConfigurableCreatorFeeBps:bn(100)});
 const fee=await encode('feeConfig',{bump:1,admin:PublicKey.default,flatFees:rates,feeTiers:[{marketCapLamportsThreshold:bn(0),fees:rates}],stableFeeTiers:[],exoticFlatFees:rates});
 const poolData=await encode('pool',{poolBump:1,index:0,creator:pumpPoolAuthorityPda(mint),baseMint:mint,quoteMint:NATIVE_MINT,lpMint:key(9),poolBaseTokenAccount:baseVault,poolQuoteTokenAccount:quoteVault,lpSupply:bn(1000),coinCreator:key(1),isMayhemMode:false,isCashbackCoin:false,virtualQuoteReserves:bn(0),creatorFeeBps:bn(0),canEditCreatorFee:false});
 // One owner holds two accounts and one account is empty; the base vault is in supply but never in the holder population.
 const owners=[20,21,22,22,23,24,25,26,27];
 const states=[{B:100n*T,P:700000000000n,amounts:[300n,200n,100n,50n,100n,80n,50n,20n,0n]},{B:99n*T,P:707000000000n,amounts:[299n,200n,100n,50n,100n,80n,51n,21n,0n]}];
 type State=typeof states[number];
 const bankKeys=[GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,NATIVE_MINT,pool,mint,baseVault,quoteVault].map(k=>k.toBase58());
 const bank=(s:State)=>[account(PUMP_AMM_PROGRAM_ID,global),account(PUMP_FEE_PROGRAM_ID,fee),account(TOKEN_PROGRAM_ID,mintData(0n,9)),account(PUMP_AMM_PROGRAM_ID,poolData),account(TOKEN_PROGRAM_ID,mintData(supply,6)),account(TOKEN_PROGRAM_ID,tokenData(mint,pool,s.B)),account(TOKEN_PROGRAM_ID,tokenData(NATIVE_MINT,pool,s.P))];
 const population=(s:State)=>[{pubkey:baseVault.toBase58(),account:account(TOKEN_PROGRAM_ID,tokenData(mint,pool,s.B))},...s.amounts.map((a,i)=>({pubkey:key(100+i).toBase58(),account:account(TOKEN_PROGRAM_ID,tokenData(mint,key(owners[i]!),a*T))}))];
 const packet:any={method:'a29-retained-sources-v1',token:{chain:'solana',address:mint.toBase58()},label,freeze:null,requests:{},retrievedAt:{},provenance:{accessMode:'USER_IMPORT',claim:'Constructed portable fixture; no live or historical capture claim.'},rawArtifacts:{}};
 const put=(id:string,request:unknown,body:string,at:number)=>{packet.requests[id]=request;packet.rawArtifacts[id]=body;packet.retrievedAt[id]=new Date(at).toISOString();};
 [{prefix:'a29-e0',slot:slot0,time:t0,floor:slot0-6},{prefix:'a29-e1',slot:slot1,time:t1,floor:slot0}].forEach(({prefix,slot,time,floor},i)=>{
  const s=states[i]!,at=ms(time),populationSlot=i===1&&o.e1PopulationSlot!==undefined?o.e1PopulationSlot:slot;
  put(`${prefix}-genesis`,{method:'getGenesisHash',params:[]},rpc(SOLANA_MAINNET_GENESIS),at-2000);
  put(`${prefix}-bank`,{method:'getMultipleAccounts',params:[bankKeys,{encoding:'base64',commitment:'finalized',minContextSlot:floor}]},rpc({context:{slot},value:bank(s)}),at+500);
  put(`${prefix}-population`,{method:'getProgramAccounts',params:[TOKEN_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:floor,withContext:true,filters:[{memcmp:{offset:0,bytes:mint.toBase58()}}]}]},rpc({context:{slot:populationSlot},value:population(s)}),at+600);
  put(`${prefix}-clock`,{method:'getBlockTime',params:[slot]},rpc(time),at+1000);
 });
 let before:string|undefined;
 (o.pages??[[]]).forEach((rows,i)=>{put(`a29-page-${i}`,{method:'getSignaturesForAddress',params:[pool.toBase58(),{commitment:'finalized',limit:1000,minContextSlot:slot1,...(before?{before}:{})}]},rpc(rows.map(r=>({...r,memo:null,confirmationStatus:'finalized'}))),ms(t1)+60000);before=rows.at(-1)?.signature;});
 (o.transactions??[]).forEach((x,n)=>put(`a29-transaction-${n}`,demandTransactionRequest(x.signature),x.body,ms(t1)+61000+n));
 const held=new Map<string,bigint>();
 states[0]!.amounts.forEach((a,i)=>{if(a>0n){const owner=key(owners[i]!).toBase58();held.set(owner,(held.get(owner)??0n)+a*T);}});
 const cohort=[...held].sort((a,b)=>a[1]!==b[1]?(a[1]>b[1]?-1:1):a[0]<b[0]?-1:1).slice(0,5).map(([owner,amount])=>({owner,balanceAtomic:String(amount)}));
 packet.freeze={kind:'A29_PROSPECTIVE_OBSERVATIONAL_SCOPE_V1',frozenAt:new Date(ms(t0)+60000).toISOString(),registration:'Constructed fixture.',primary:label,control:label,selectionReason:'Constructed fixture.',
  tokens:[{label,mint:mint.toBase58(),pool:pool.toBase58(),bankKeys,program:TOKEN_PROGRAM_ID.toBase58(),baseVault:baseVault.toBase58(),
   endpoint0:{attempt:1,bankSlot:slot0,populationSlot:slot0,exactSameSlot:true,bankReceipt:2,populationReceipt:3,populationComplete:true,supplyAtomic:String(supply),accounts:10,positiveOwners:7,positiveAccounts:8,totalAtomic:String(supply),supplyReconciled:true,chainTime:new Date(ms(t0)).toISOString(),clockReceipt:4},cohort}],
  measurement:{minimumIntervalSeconds:600},
  bounds:{endpointReadsPerToken:12,tapeMaxPages:2,pageLimit:1000,maxSuccessfulTransactionsPerToken:480,maxTransactionResponseBytes:500000,maxEndpointPopulationResponseBytes:20000000,maxStoredNamespaceBytes:24000000,transportConcurrentTransactions:2,hardCaptureDeadlineSeconds:600},
  status:'SOURCE_AND_MEASUREMENT_CONTRACT_FROZEN_PENDING_IMPLEMENTATION_ADAPTATION',allowedRevisions:'Constructed fixture.',evidenceBasedRevisions:[]};
 o.mutate?.(packet);
 return{raw:JSON.stringify(packet,null,2),packet,cutoff:new Date(ms(t1)+3600000).toISOString(),t0,t1,mint:mint.toBase58(),pool:pool.toBase58()};
}
export function deriveFixture(f:A29Fixture,cutoff=f.cutoff){const c=decodeA29Capture(f.raw);return deriveA29Absorption(c.freeze,c.label,c.receipts,cutoff,['a29-capture']);}
const row=(n:number,slot:number,blockTime:number|null,err:unknown=null):A29FixtureRow=>({signature:fixtureSignature(n),slot,blockTime,err});
const failed={InstructionError:[0,{Custom:1}]};
const gap=async(o:A29FixtureOptions,quality:string,reason:string)=>{const m=deriveFixture(await buildA29Capture(o)),d=m.data as any;assert.equal(m.quality,quality);assert.equal(m.reasonCode,reason);assert.equal(d.status,quality);assert.equal(d.vector,null);return d;};

test('constructed empty tape capture yields a full KNOWN zero-activity vector',async()=>{
 const f=await buildA29Capture(),m=deriveFixture(f),d=m.data as any,v=d.vector;
 assert.equal(m.id,'A29');assert.equal(m.unit,'distribution-absorption-vector');assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'A29_PROSPECTIVE_VECTOR_OBSERVED');assert.deepEqual(m.evidenceIds,['a29-capture']);
 assert.deepEqual(d.interval,{slot0:1000,slot1:2600,t0:new Date(f.t0*1000).toISOString(),t1:new Date(f.t1*1000).toISOString(),seconds:900});
 assert.equal(v.endpoints.e0.attempt,1);assert.equal(v.endpoints.e1.attempt,1);assert.equal(v.units.baseDecimals,6);
 assert.equal(v.endpoints.e0.cohortAtomic,'830000000000000');assert.equal(v.endpoints.e1.cohortAtomic,'829000000000000');
 assert.ok(v.cohort.every((c:any)=>c.owner!==f.pool));
 assert.deepEqual(v.selling,{trades:0,sellBaseAtomic:'0',sellQuoteAtomic:'0',buyBaseAtomic:'0',buyQuoteAtomic:'0',netSellBaseAtomic:'0'});
 assert.deepEqual(v.inventory,{deltaAtomic:'-1000000000000',residualAtomic:'-1000000000000'});
 assert.equal(v.newBuyerGrowth.difference,0);assert.equal(v.newBuyerGrowth.ratio,null);assert.equal(v.newBuyerGrowth.warmup.start,new Date((f.t0-1800)*1000).toISOString());
 assert.equal(v.endpoints.e0.spotQuotePerBase,'0.007');assert.ok(v.priceChange.fraction.startsWith('0.0202'));
 // Raw supply shares keep the nonzero base vault under its pool owner; vault-adjusted shares exclude only that account.
 assert.deepEqual(v.endpoints.e0.concentration.supply,{top1:'0.3',top5:'0.85',top10:'1'});assert.deepEqual(v.endpoints.e1.concentration.supply,{top1:'0.299',top5:'0.848',top10:'1'});
 assert.deepEqual(v.concentrationChange.supply,{top1:'-0.001',top5:'-0.002',top10:'0'});assert.equal(v.concentrationChange.vaultAdjusted.top10,'0');assert.ok(v.endpoints.e0.concentration.vaultAdjusted.top1.startsWith('0.333333'));
 assert.ok(BigInt(v.endpoints.e0.depth.quoteAtomic)>0n&&BigInt(v.endpoints.e1.depth.quoteAtomic)>0n);assert.notEqual(v.depthChange.ratio,null);
 const canonical=createHash('sha256').update(canonicalJson(f.packet.freeze)).digest('hex');
 assert.equal(d.freezeSha256,canonical);assert.notEqual(createHash('sha256').update(JSON.stringify(f.packet.freeze,null,2)).digest('hex'),canonical);
});
test('capture decoding records maxClock and bounds the stored packet',async()=>{
 const f=await buildA29Capture(),c=decodeA29Capture(f.raw);
 assert.equal(c.maxClock,new Date(f.t1*1000+60000).toISOString());assert.equal(c.label,'Fixture');
 assert.throws(()=>decodeA29Capture('x'.repeat(24000001)),{message:'A29_CAPTURE_SIZE'});
 assert.throws(()=>deriveFixture({...f,raw:JSON.stringify({...f.packet,provenance:{accessMode:'LIVE'}})}),{message:'A29_CAPTURE_SHAPE'});
});
test('request identity and freeze hash are structural, not key-order dependent',async()=>{
 const base=deriveFixture(await buildA29Capture());
 const reordered=deriveFixture(await buildA29Capture({mutate:p=>{const o=p.requests['a29-e1-bank'].params[1];p.requests['a29-e1-bank'].params[1]=Object.fromEntries(Object.entries(o).reverse());p.freeze=Object.fromEntries(Object.entries(p.freeze).reverse());}}));
 assert.equal(reordered.quality,'KNOWN');assert.equal((reordered.data as any).freezeSha256,(base.data as any).freezeSha256);
});
test('tampered freeze, requests and receipts fail closed',async()=>{
 const throws=async(mutate:(p:any)=>void,message:string)=>assert.throws(()=>deriveFixture(awaitless),{message});
 let awaitless:A29Fixture;
 const cases:Array<[(p:any)=>void,string]>=[
  [p=>{p.freeze.tokens[0].cohort[0].balanceAtomic='1';},'A29_FREEZE_COHORT_MISMATCH'],
  [p=>{p.freeze.tokens[0].endpoint0.supplyAtomic='1';},'A29_FREEZE_ENDPOINT0_MISMATCH'],
  [p=>{p.freeze.frozenAt=p.retrievedAt['a29-e1-clock'];},'A29_FREEZE_TIMING'],
  [p=>{p.freeze.bounds.pageLimit=999;},'A29_FREEZE_BOUNDS'],
  [p=>{p.rawArtifacts['a29-e0-genesis']=rpc('not-mainnet');},'A29_GENESIS'],
  [p=>{p.requests['a29-e1-population'].params[1].commitment='confirmed';},'A29_REQUEST_MISMATCH'],
  [p=>{p.requests['a29-e1-bank'].params[1].minContextSlot=999;},'A29_REQUEST_FLOOR'],
  [p=>{const r=JSON.parse(p.rawArtifacts['a29-e0-population']);r.result.context.slot+=1;p.rawArtifacts['a29-e0-population']=JSON.stringify(r);},'A29_ENDPOINT_SLOT_MISMATCH'],
  [p=>{p.rawArtifacts['a29-e0-clock']=JSON.stringify({jsonrpc:'2.0',id:2,result:1800000000});},'A29_RECEIPT_SHAPE'],
 ];
 for(const [mutate,message] of cases){awaitless=await buildA29Capture({mutate});await throws(mutate,message);}
});
test('missing, short, mismatched and late sources become MISSING, never zero',async()=>{
 const {slot0,t0}=A29_FIXTURE;
 const short=await gap({intervalSeconds:599},'MISSING','A29_INTERVAL_SHORT');assert.equal(short.interval,null);
 await gap({e1PopulationSlot:2601},'MISSING','A29_ENDPOINT_SLOT_MISMATCH');
 await gap({mutate:p=>{const r=JSON.parse(p.rawArtifacts['a29-e1-population']);r.result.value.splice(8,1);p.rawArtifacts['a29-e1-population']=JSON.stringify(r);}},'MISSING','A29_SUPPLY_UNRECONCILED');
 await gap({mutate:p=>{for(const k of ['requests','rawArtifacts','retrievedAt'])delete p[k]['a29-page-0'];}},'MISSING','A29_RECEIPT_ABSENT');
 await gap({pages:[[row(1,slot0+500,t0+400)]]},'MISSING','A29_RECEIPT_ABSENT');
 await gap({pages:[[row(1,slot0+500,t0+400)]],transactions:[{signature:fixtureSignature(1),body:JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32009,message:'unavailable'}})}]},'MISSING','A29_RPC_ERROR');
 await gap({pages:[[row(1,slot0+500,t0+400)]],transactions:[{signature:fixtureSignature(1),body:rpc(null)}]},'MISSING','A29_TRANSACTION_ABSENT');
 await gap({pages:[Array.from({length:1000},(_,i)=>row(i,2600-i,t0+500,failed))]},'MISSING','A29_RECEIPT_ABSENT');
 const f=await buildA29Capture(),late=deriveFixture(f,new Date(f.t1*1000+30000).toISOString());
 assert.equal(late.quality,'MISSING');assert.equal(late.reasonCode,'A29_RECEIPT_AFTER_CUTOFF');
});
test('tape bounds and clock gaps are TRUNCATED',async()=>{
 const {t0}=A29_FIXTURE;
 await gap({pages:[Array.from({length:1000},(_,i)=>row(i,2600-i,t0+1,failed)),Array.from({length:1000},(_,i)=>row(1000+i,1600-i,1600-i>1000?t0+1:t0,failed))]},'TRUNCATED','A29_TAPE_PAGE_CAP');
 await gap({pages:[Array.from({length:481},(_,i)=>row(i,2600-i,t0+500))]},'TRUNCATED','A29_TAPE_TRANSACTION_CAP');
 await gap({pages:[[row(1,900,null)]]},'TRUNCATED','A29_TAPE_NULL_CLOCK');
});
test('coverage is proved by an older row and failed rows carry no flow',async()=>{
 const {t0}=A29_FIXTURE,m=deriveFixture(await buildA29Capture({pages:[[row(1,2000,t0+400,failed),row(2,10,t0-3*900-1)]]}));
 assert.equal(m.quality,'KNOWN');assert.equal((m.data as any).vector.selling.trades,0);
});
test('the frozen tape stops at t0-2L: no lookback period before warmup is read',async()=>{
 const {t0}=A29_FIXTURE,L=A29_FIXTURE.defaultSeconds;
 const early=deriveFixture(await buildA29Capture({pages:[[row(1,10,t0-2*L-1)]]}));
 assert.equal(early.quality,'KNOWN');assert.equal((early.data as any).vector.newBuyerGrowth.warmup.meaningfulBuyers,0);
 await gap({pages:[[row(1,10,t0-2*L)]]},'MISSING','A29_RECEIPT_ABSENT');
});

// Owner binder adversaries over synthetic compiled projections; runtime frames come from the existing executed-instruction binder.
const P=PUMP_AMM_PROGRAM_ID.toBase58(),TK=TOKEN_PROGRAM_ID.toBase58(),id=(n:number)=>key(n).toBase58();
const user=id(40),ata=id(41),vault=id(42),mintKey=id(43),owner=id(44),delegate=id(45),other=id(46),stranger=id(47),ata2=id(48),owner2=id(49);
const u64le=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return [...b];};
const checked=(source:string,mint:string,destination:string,authority:string,amount:bigint)=>({programId:TK,accounts:[source,mint,destination,authority],data:base58(Uint8Array.from([12,...u64le(amount),6])),stackHeight:2});
const pump=()=>({programId:P,accounts:[user,vault],data:base58(Uint8Array.from([1,2,3])),stackHeight:null});
const bal=(index:number,o:string)=>({accountIndex:index,mint:mintKey,owner:o,programId:TK,uiTokenAmount:{amount:'1000',decimals:6,uiAmount:null,uiAmountString:'0.001'}});
const invoke=(p:string,d:number)=>`Program ${p} invoke [${d}]`,success=(p:string)=>`Program ${p} success`;
const swapLogs=[invoke(P,1),invoke(TK,2),success(TK),success(P)];
function synthetic(top:any[],inner:Array<{index:number;instructions:any[]}>,logs:string[],pre:any[],post:any[]){
 const keys=[user,ata,vault,mintKey,P,TK,delegate,other,ata2];
 return{slot:5,blockTime:5,version:'legacy',transaction:{signatures:['sig'],message:{accountKeys:keys.map((pubkey,i)=>({pubkey,signer:i===0,writable:true,source:'transaction'})),instructions:top,recentBlockhash:id(1)}},meta:{err:null,innerInstructions:inner,logMessages:logs,preTokenBalances:pre,postTokenBalances:post}};
}
const sell=(amount='100',instructionIndex=0)=>({side:'SELL' as const,baseAtomic:amount,instructionIndex});
const one=(leg:any,logs=swapLogs,pre=[bal(1,owner)],post=[bal(1,owner)])=>synthetic([pump()],[{index:0,instructions:[leg]}],logs,pre,post);
test('owner binder uses the account owner on the exact executed base leg, never the trade user',()=>{
 assert.deepEqual(bindA29TradeAccount(one(checked(ata,mintKey,vault,user,100n)),sell(),mintKey,vault),{account:ata,owners:[owner],ambiguous:false});
 assert.deepEqual(bindA29TradeAccount(one(checked(ata,mintKey,vault,delegate,100n)),sell(),mintKey,vault),{account:ata,owners:[owner],ambiguous:false});
 assert.deepEqual(bindA29TradeAccount(one(checked(vault,mintKey,ata,other,100n)),{side:'BUY',baseAtomic:'100',instructionIndex:0},mintKey,vault),{account:ata,owners:[owner],ambiguous:false});
});
test('owner binder rejects caught failed CPI, foreign mint, foreign vault, wrong amount and non-swap steps',()=>{
 assert.throws(()=>bindA29TradeAccount(one(checked(ata,mintKey,vault,user,100n),[invoke(P,1),invoke(TK,2),`Program ${TK} failed: custom program error: 0x1`,success(P)]),sell(),mintKey,vault),{message:'A29_TRADE_LEG'});
 assert.throws(()=>bindA29TradeAccount(one(checked(ata,other,vault,user,100n)),sell(),mintKey,vault),{message:'A29_TRADE_LEG_MINT'});
 assert.throws(()=>bindA29TradeAccount(one(checked(ata,mintKey,stranger,user,100n)),sell(),mintKey,vault),{message:'A29_TRADE_LEG'});
 assert.throws(()=>bindA29TradeAccount(one(checked(ata,mintKey,vault,user,100n)),sell('101'),mintKey,vault),{message:'A29_TRADE_LEG_AMOUNT'});
 assert.throws(()=>bindA29TradeAccount(one(checked(ata,mintKey,vault,user,100n)),sell('100',1),mintKey,vault),{message:'A29_TRADE_STEP'});
});
test('owner changes and lifecycle authority edits stay ambiguous with every candidate owner',()=>{
 const differ=bindA29TradeAccount(one(checked(ata,mintKey,vault,user,100n),swapLogs,[bal(1,owner)],[bal(1,owner2)]),sell(),mintKey,vault);
 assert.equal(differ.ambiguous,true);assert.deepEqual(differ.owners,[owner,owner2].sort());
 const setAuthority={programId:TK,accounts:[ata,owner],data:base58(Uint8Array.from([6,2,1,...key(49).toBuffer()])),stackHeight:null};
 const lifecycle=bindA29TradeAccount(synthetic([pump(),setAuthority],[{index:0,instructions:[checked(ata,mintKey,vault,user,100n)]}],[...swapLogs,invoke(TK,1),success(TK)],[bal(1,owner)],[bal(1,owner)]),sell(),mintKey,vault);
 assert.equal(lifecycle.ambiguous,true);assert.ok(lifecycle.owners.includes(owner2));
});
test('multiple swaps bind each trade to its own runtime frame',()=>{
 const tx=synthetic([pump(),pump()],[{index:0,instructions:[checked(ata,mintKey,vault,user,100n)]},{index:1,instructions:[checked(ata2,mintKey,vault,user,200n)]}],[...swapLogs,...swapLogs],[bal(1,owner),bal(8,owner2)],[bal(1,owner),bal(8,owner2)]);
 assert.deepEqual(bindA29TradeAccount(tx,sell('100',0),mintKey,vault),{account:ata,owners:[owner],ambiguous:false});
 assert.deepEqual(bindA29TradeAccount(tx,sell('200',1),mintKey,vault),{account:ata2,owners:[owner2],ambiguous:false});
});
test('binder maps the PumpSwap instruction ordinal past foreign instructions and event CPIs',()=>{
 const S='11111111111111111111111111111111',system={programId:S,accounts:[user,ata],data:base58(Uint8Array.from([2,0,0,0])),stackHeight:null};
 const event=()=>({programId:P,accounts:[vault],data:base58(Uint8Array.from([228,69])),stackHeight:2});
 const swap=[invoke(P,1),invoke(TK,2),success(TK),invoke(P,2),success(P),success(P)];
 const tx=synthetic([system,pump(),pump()],[{index:1,instructions:[checked(ata,mintKey,vault,user,100n),event()]},{index:2,instructions:[checked(ata2,mintKey,vault,user,200n),event()]}],[invoke(S,1),success(S),...swap,...swap],[bal(1,owner),bal(8,owner2)],[bal(1,owner),bal(8,owner2)]);
 assert.deepEqual(bindA29TradeAccount(tx,sell('100',0),mintKey,vault),{account:ata,owners:[owner],ambiguous:false});
 assert.deepEqual(bindA29TradeAccount(tx,sell('200',2),mintKey,vault),{account:ata2,owners:[owner2],ambiguous:false});
 assert.throws(()=>bindA29TradeAccount(tx,sell('100',1),mintKey,vault),{message:'A29_TRADE_LEG'});
});

test('owner binder rejects non-canonical owners and keeps an unknown pre-owner ambiguous',()=>{
 assert.equal(bindA29TradeAccount(one(checked(ata,mintKey,vault,user,100n),swapLogs,[],[bal(1,owner)]),sell(),mintKey,vault).ambiguous,true);
 assert.throws(()=>bindA29TradeAccount(one(checked(ata,mintKey,vault,user,100n),swapLogs,[bal(1,'not-a-public-key')],[bal(1,'not-a-public-key')]),sell(),mintKey,vault),{message:'A29_TOKEN_BALANCE_OWNER'});
});
test('derivation consumes exactly the linked receipts: extra, aliased or stale receipts fail',async()=>{
 const add=(id:string,request:unknown)=>(p:any)=>{p.requests[id]=request;p.rawArtifacts[id]=rpc(null);p.retrievedAt[id]=p.retrievedAt['a29-page-0'];};
 const cases:Array<[(p:any)=>void,string]>=[
  [add('a29-transaction-999',demandTransactionRequest(fixtureSignature(1))),'A29_RECEIPT_KEYS'],
  [add('a29-e0-bank-copy',{method:'getMultipleAccounts',params:[]}),'A29_RECEIPT_KEYS'],
  [add('a29-page-1',{method:'getSignaturesForAddress',params:[]}),'A29_RECEIPT_UNUSED'],
  [add('a29-transaction-0',demandTransactionRequest(fixtureSignature(1))),'A29_RECEIPT_UNUSED'],
 ];
 for(const [mutate,message] of cases){const f=await buildA29Capture({mutate});assert.throws(()=>deriveFixture(f),{message});}
 const f=await buildA29Capture(),c=decodeA29Capture(f.raw);delete c.receipts.retrievedAt['a29-e0-clock'];
 assert.throws(()=>deriveA29Absorption(c.freeze,c.label,c.receipts,f.cutoff,[]),{message:'A29_RECEIPT_KEYS'});
});
test('index rows and page receipts are time-ordered; an older row cannot hide a later in-window row',async()=>{
 const {t0}=A29_FIXTURE,L=A29_FIXTURE.defaultSeconds;
 const older=await buildA29Capture({pages:[[row(1,10,t0-2*L-5),row(2,9,t0-100)]]});
 assert.throws(()=>deriveFixture(older),{message:'A29_PAGE_ORDER'});
 const clocks=await buildA29Capture({pages:[[row(1,2000,t0+100,failed),row(2,1900,t0+200,failed)]]});
 assert.throws(()=>deriveFixture(clocks),{message:'A29_PAGE_ORDER'});
 const pages=await buildA29Capture({pages:[Array.from({length:1000},(_,i)=>row(i,2600-i,t0+1,failed)),[row(5000,10,t0-2*L-1)]],mutate:p=>{p.retrievedAt['a29-page-1']=new Date(Date.parse(p.retrievedAt['a29-page-0'])-1).toISOString();}});
 assert.throws(()=>deriveFixture(pages),{message:'A29_PAGE_TIME'});
});
test('optional provenance records bind raw source bytes, and the outer packet admits no extra keys',async()=>{
 const sha=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
 const records=(p:any)=>{p.provenance.records=Object.keys(p.requests).map(k=>({key:k,sourceSha256:sha(p.rawArtifacts[k]),sourceBytes:Buffer.byteLength(p.rawArtifacts[k],'utf8'),startedAt:new Date(Date.parse(p.retrievedAt[k])-50).toISOString(),completedAt:p.retrievedAt[k],httpStatus:200}));};
 const bound=await buildA29Capture({mutate:records});
 assert.equal(deriveFixture(bound).quality,'KNOWN');
 // Same JSON value, different bytes: a recorded hash must still reject it.
 const rewritten=await buildA29Capture({mutate:p=>{records(p);p.rawArtifacts['a29-e1-bank']=JSON.stringify(JSON.parse(p.rawArtifacts['a29-e1-bank']),null,1);}});
 assert.throws(()=>decodeA29Capture(rewritten.raw),{message:'A29_CAPTURE_RECORD'});
 const status=await buildA29Capture({mutate:p=>{records(p);p.provenance.records[0].httpStatus=206;}});
 assert.throws(()=>decodeA29Capture(status.raw),{message:'A29_CAPTURE_RECORD'});
 const dropped=await buildA29Capture({mutate:p=>{records(p);p.provenance.records.pop();}});
 assert.throws(()=>decodeA29Capture(dropped.raw),{message:'A29_CAPTURE_RECORD'});
 const late=await buildA29Capture({mutate:p=>{records(p);p.provenance.records[0].startedAt=new Date(Date.parse(p.provenance.records[0].completedAt)+1).toISOString();}});
 assert.throws(()=>decodeA29Capture(late.raw),{message:'A29_CAPTURE_RECORD'});
 const cache=await buildA29Capture({mutate:p=>{p.metricCache={quality:'KNOWN'};}});
 assert.throws(()=>decodeA29Capture(cache.raw),{message:'A29_CAPTURE_SHAPE'});
});

export type A29Swap={row:A29FixtureRow;side:'BUY'|'SELL';core:bigint;base:bigint;user:PublicKey;account:PublicKey;owner:string;pre?:string};
const A29_DISCRIMINATORS={buy_v2:[184,23,238,97,103,197,211,61],sell_v2:[93,246,130,60,231,233,64,178]};
function eventDefaults(name:string,fill:PublicKey):any{
 const type=OFFLINE_PUMP_AMM_PROGRAM.idl.types!.find(t=>t.name===name)!,result:Record<string,unknown>={};
 for(const f of (type.type as any).fields)result[f.name]=f.type==='pubkey'?fill:f.type==='bool'?false:f.type==='string'?'buy':f.type==='u8'||f.type==='u16'?0:new BN(0);
 return result;
}
/** Explicitly synthetic compiled getTransaction result: one selected-pool v2 swap on the portable fixture pool with its executed base leg.
 * Adapted from the repo window-decoder fixture for the unchanged projector, decoder and runtime binder; no live or historical claim.
 * pre 'omit' drops the pre token balance; owner is the post owner and, unless pre is given, the pre owner. */
export function a29SwapTransaction(s:A29Swap):any{
 const mint=key(7),pool=poolPda(0,pumpPoolAuthorityPda(mint),mint,NATIVE_MINT),baseVault=getAssociatedTokenAddressSync(mint,pool,true,TOKEN_PROGRAM_ID),quoteVault=getAssociatedTokenAddressSync(NATIVE_MINT,pool,true,TOKEN_PROGRAM_ID);
 const sell=s.side==='SELL',method:'sell_v2'|'buy_v2'=sell?'sell_v2':'buy_v2',name=sell?'sellEvent':'buyEvent',lp=2n,protocolFee=3n,creatorFee=2n,fees=lp+protocolFee+creatorFee,gross=sell?s.core:s.core+fees,userQuote=sell?s.core-fees:gross;
 const big=(v:bigint|number)=>new BN(v.toString()),sdk=OFFLINE_PUMP_AMM_PROGRAM,userQuoteAccount=key(90),eventAuthority=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],PUMP_AMM_PROGRAM_ID)[0];
 const event={...eventDefaults(name,s.user),timestamp:big(s.row.blockTime!),pool,user:s.user,userBaseTokenAccount:s.account,userQuoteTokenAccount:userQuoteAccount,poolBaseTokenReserves:big(100000),poolQuoteTokenReserves:big(1000000),baseAmountOut:big(s.base),baseAmountIn:big(s.base),
  ixName:method,lpFee:big(lp),protocolFee:big(protocolFee),coinCreatorFee:big(creatorFee),buybackFee:big(protocolFee/2n),cashback:big(0),
  quoteAmountIn:big(s.core),userQuoteAmountIn:big(userQuote),quoteAmountInWithLpFee:big(s.core+lp),quoteAmountOut:big(s.core),userQuoteAmountOut:big(userQuote),quoteAmountOutWithoutLpFee:big(s.core-lp),
  maxQuoteAmountIn:big(gross),minBaseAmountOut:big(s.base),minQuoteAmountOut:big(userQuote)};
 const payload=Buffer.concat([Buffer.from(sdk.idl.events!.find(e=>e.name===name)!.discriminator),sdk.coder.types.encode(name,event),Buffer.alloc(24)]).toString('base64');
 const data=Buffer.alloc(24);Buffer.from(A29_DISCRIMINATORS[method]).copy(data);data.writeBigUInt64LE(s.base,8);data.writeBigUInt64LE(sell?userQuote:gross,16);
 const b58=(k:PublicKey)=>k.toBase58(),signer=b58(s.user),system='11111111111111111111111111111111';
 const top={programId:P,accounts:[pool,s.user,GLOBAL_CONFIG_PDA,mint,NATIVE_MINT,s.account,userQuoteAccount,baseVault,quoteVault,TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID].map(b58).concat([system,b58(userVolumeAccumulatorPda(s.user)),b58(PUMP_AMM_FEE_CONFIG_PDA),signer,b58(eventAuthority),P]),data:base58(data)};
 const leg={programId:TK,accounts:(sell?[s.account,mint,baseVault,s.user]:[baseVault,mint,s.account,pool]).map(b58),data:base58(Uint8Array.from([12,...u64le(s.base),6]))};
 const keys=[signer,...new Set([top,leg].flatMap(ix=>[...ix.accounts,ix.programId]).filter(k=>k!==signer))];
 const compiled=(ix:{programId:string;accounts:string[];data:string},stackHeight:number|null)=>({programIdIndex:keys.indexOf(ix.programId),accounts:ix.accounts.map(k=>keys.indexOf(k)),data:ix.data,stackHeight});
 const index=keys.indexOf(b58(s.account)),before=1000000000n,after=sell?before-s.base:before+s.base,preOwner=s.pre??s.owner;
 const balance=(owner:string,amount:bigint)=>({accountIndex:index,mint:b58(mint),owner,programId:TK,uiTokenAmount:{amount:String(amount),decimals:6,uiAmount:null,uiAmountString:String(amount)}});
 return{slot:s.row.slot,blockTime:s.row.blockTime,version:'legacy',transaction:{signatures:[s.row.signature],message:{header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:0},accountKeys:keys,recentBlockhash:key(12).toBase58(),instructions:[compiled(top,null)]}},
  meta:{err:null,fee:5000,preBalances:[],postBalances:[],preTokenBalances:preOwner==='omit'?[]:[balance(preOwner,before)],postTokenBalances:[balance(s.owner,after)],innerInstructions:[{index:0,instructions:[compiled(leg,2)]}],
   logMessages:[invoke(P,1),invoke(TK,2),success(TK),`Program data: ${payload}`,success(P)],loadedAddresses:{writable:[],readonly:[]}}};
}
const swapBuyer=(n:number,r:A29FixtureRow,core:bigint):A29Swap=>({row:r,side:'BUY',core,base:100n,user:key(n),account:key(100+n),owner:key(n).toBase58()});
const swapCapture=(swaps:A29Swap[])=>buildA29Capture({pages:[swaps.map(s=>s.row)],transactions:swaps.map(s=>({signature:s.row.signature,body:rpc(a29SwapTransaction(s))}))});
test('full production measure turns a constructed nonempty tape into KNOWN cohort selling and asymmetric fresh buyers',async()=>{
 const {t0}=A29_FIXTURE,L=A29_FIXTURE.defaultSeconds;
 const m=deriveFixture(await swapCapture([
  // Measured (slot0,slot1]: a cohort SELL and a cohort BUY, each signed by a delegate that is not the token owner.
  {row:row(1,2500,t0+800),side:'SELL',core:20000000n,base:800n,user:key(60),account:key(100),owner:key(20).toBase58()},
  {row:row(2,2400,t0+700),side:'BUY',core:30000000n,base:300n,user:key(61),account:key(101),owner:key(21).toBase58()},
  swapBuyer(70,row(3,2300,t0+600),15000000n),
  swapBuyer(71,row(4,2200,t0+500),9999999n),
  // Slot governs equal block times: slot0+1 is measured, slot0 is baseline. Exactly 0.01 WSOL is meaningful.
  swapBuyer(74,row(5,1001,t0),10000000n),
  swapBuyer(70,row(6,1000,t0),20000000n),
  swapBuyer(72,row(7,900,t0-L),12000000n),
  // Warmup [t0-2L,t0-L).
  swapBuyer(72,row(8,800,t0-L-1),12000000n),
  swapBuyer(73,row(9,700,t0-2*L),12000000n),
 ])),v=(m.data as any).vector;
 assert.equal(m.quality,'KNOWN',m.reasonCode);
 assert.deepEqual(v.selling,{trades:2,sellBaseAtomic:'800',sellQuoteAtomic:'20000000',buyBaseAtomic:'300',buyQuoteAtomic:'30000000',netSellBaseAtomic:'500'});
 // Warmup reports {72,73}; baseline {70,72} minus warmup leaves {70}; measured {61,70,74} minus baseline leaves {61,74}; dust 71 never counts.
 const g=v.newBuyerGrowth;
 assert.deepEqual([g.warmup.meaningfulBuyers,g.baseline.meaningfulBuyers,g.measured.meaningfulBuyers,g.difference,g.ratio],[2,1,2,1,'2']);
 assert.deepEqual(v.inventory,{deltaAtomic:'-1000000000000',residualAtomic:'-999999999500'});
});
test('full production measure withholds the vector on an unknown pre-owner or an invalid owner, and keeps dust as observed zero',async()=>{
 const {t0}=A29_FIXTURE,measured=()=>row(1,2500,t0+800);
 const unknown=deriveFixture(await swapCapture([{...swapBuyer(70,measured(),15000000n),pre:'omit'}]));
 assert.equal(unknown.quality,'MISSING');assert.equal(unknown.reasonCode,'A29_OWNER_AMBIGUOUS');
 const invalid=deriveFixture(await swapCapture([{...swapBuyer(70,measured(),15000000n),owner:'not-a-public-key'}]));
 assert.equal(invalid.quality,'MISSING');assert.equal((invalid.data as any).vector,null);
 const dust=deriveFixture(await swapCapture([swapBuyer(71,measured(),9999999n)]));
 assert.equal(dust.quality,'KNOWN',dust.reasonCode);assert.equal((dust.data as any).vector.newBuyerGrowth.measured.meaningfulBuyers,0);
});

// Built tests run from dist/tests while the retained fixture stays in the repository tests/fixtures directory.
const retainedFixture=(name:string)=>[new URL(`../../tests/fixtures/${name}`,import.meta.url),new URL(`./fixtures/${name}`,import.meta.url)].find(u=>existsSync(u))??assert.fail(`${name} not found`);
test('pinned decoder and owner binder bind the actual retained compiled native-WSOL sell receipt',()=>{
 const fixture=JSON.parse(readFileSync(retainedFixture('a29-native-sell-receipts.json'),'utf8')),tx=fixture.transaction,poolReceipt=fixture.poolReceipt;
 const sha=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
 // Actual historical bytes only: the hashes bind the stored strings, and this makes no current A29 interval-flow claim.
 assert.equal(sha(tx.raw),tx.sourceSha256);assert.equal(sha(poolReceipt.raw),poolReceipt.sourceSha256);
 assert.equal(tx.request.method,'getTransaction');
 const poolResult=JSON.parse(poolReceipt.raw).result,v=poolResult.value,result=JSON.parse(tx.raw).result,poolKey=poolReceipt.request.params[0] as string;
 assert.equal(poolKey,fixture.pool);
 const state=PUMP_AMM_SDK.decodePool({owner:new PublicKey(v.owner),data:Buffer.from(v.data[0],'base64'),executable:v.executable,lamports:v.lamports});
 const out=decodeA29BoundTrades(result,{signature:tx.request.params[0],slot:result.slot,at:new Date(result.blockTime*1000).toISOString()},poolKey,state,poolResult.context.slot,tx.retrievedAt);
 assert.equal(out.length,1);
 const b=out[0]!;
 assert.equal(b.trade.side,'SELL');assert.equal(b.trade.baseAtomic,'84815772342');assert.equal(b.trade.quoteAtomic,'31078652');assert.equal(b.trade.quoteAccounting?.coreQuoteAtomic,'31078652');
 assert.equal(b.ambiguous,false);assert.equal(b.owners.length,1);assert.ok(b.owners[0]!.startsWith('fgUu'));assert.notEqual(b.account,state.poolBaseTokenAccount.toBase58());
});
