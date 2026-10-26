import { existsSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk,FEE_CONFIG_SIZE_PRE_STABLE,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,lpMintPda,poolPda,pumpPoolAuthorityPda } from '@pump-fun/pump-swap-sdk';
import { SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';

/** The offline public fixture of tests/advisory-integration.test.ts, parameterized by mint and run clock so an imported capture can precede the run. These mocked live reads are never labelled genuine. */
export function a29LiveFetcher(address:string,at:string):typeof fetch{
  const pool='4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E',quote='So11111111111111111111111111111111111111112';
  const hour=Math.floor(Date.parse(at)/3_600_000)*3600,day=Math.floor(Date.parse(at)/86_400_000)*86400;
  return async(input,init)=>{
    const url=String(input);let value:unknown;
    if(init?.method==='POST'){
      const request=JSON.parse(String(init.body));
      value={jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:request.method==='getSignaturesForAddress'?[]:{context:{slot:1},value:null}};
    }else if(url.includes('/token-pairs/'))value=[{chainId:'solana',dexId:'pumpswap',pairAddress:pool,baseToken:{address},quoteToken:{address:quote},priceUsd:'1',liquidity:{usd:10000},volume:{h24:100},txns:{h24:{buys:4,sells:3}}}];
    else if(url.includes('include=base_token'))value={data:{id:`solana_${pool}`,type:'pool',attributes:{address:pool},relationships:{base_token:{data:{id:`solana_${address}`,type:'token'}},quote_token:{data:{id:`solana_${quote}`,type:'token'}}}},included:[address,quote].map(item=>({id:`solana_${item}`,type:'token',attributes:{address:item}}))};
    else if(url.includes('ohlcv'))value={data:{attributes:{ohlcv_list:Array.from({length:75},(_,i)=>[hour-i*3600,10+i%6,11+i%6,9+i%6,10+i%6,20])}}};
    else if(url.includes('coinbase'))value=Array.from({length:75},(_,i)=>[hour-i*3600,9+i%6,11+i%6,10+i%6,10+i%6,2]);
    else if(url.includes('llama'))value={chain:new URL(url).pathname.split('/').at(-1),totalDataChart:[[day-172800,10],[day-86400,20],[day,999]]};
    else if(url.includes('/orders/'))value={orders:[{chainId:'solana',tokenAddress:address,type:'tokenProfile',status:'approved',paymentTimestamp:Date.parse(at)-1000}],boosts:[]};
    else throw new Error('Unexpected fixture request');
    return new Response(JSON.stringify(value));
  };
}

/** The genuine retained capture is supplied by path, never committed or hardcoded; without it only the supplementary genuine test is skipped. */
export function loadA29Capture(){
  const file=process.env.A29_CAPTURE_FILE;
  if(!file||!existsSync(file))return null;
  const raw=readFileSync(file,'utf8'),wrapper=JSON.parse(raw) as {token:{chain:'solana';address:string};retrievedAt:Record<string,string>};
  const latestClock=Object.values(wrapper.retrievedAt).reduce((a,b)=>Date.parse(b)>Date.parse(a)?b:a);
  return {raw,token:wrapper.token,latestClock,after:afterCapture(latestClock)};
}
/** Import half an hour after the first full hour following the capture, so every copied source clock precedes the import and the cutoff. */
const afterCapture=(latestClock:string)=>new Date(Math.ceil(Date.parse(latestClock)/3_600_000)*3_600_000+1_800_000).toISOString();

const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const key=(byte:number)=>new PublicKey(Buffer.alloc(32,byte));
const bn=(n:number)=>new BN(n),rates={lpFeeBps:bn(20),protocolFeeBps:bn(15),creatorFeeBps:bn(10)};
async function encode(name:string,value:unknown){const d=Buffer.from(await (sdk.coder.accounts as any).encode(name,value));return name==='feeConfig'?Buffer.concat([d,Buffer.alloc(Math.max(0,FEE_CONFIG_SIZE_PRE_STABLE-d.length))]):d;}
const account=(owner:PublicKey,data:Buffer)=>({owner:owner.toBase58(),data:[data.toString('base64'),'base64'],executable:false,lamports:2039280});
function mintData(supply:bigint,decimals:number){const b=Buffer.alloc(MintLayout.span);b.writeBigUInt64LE(supply,36);b[44]=decimals;b[45]=1;return b;}
function tokenAccount(mint:PublicKey,owner:PublicKey,amount:bigint){const b=Buffer.alloc(165);mint.toBuffer().copy(b);owner.toBuffer().copy(b,32);b.writeBigUInt64LE(amount,64);b[108]=1;return b;}

/** One constructed index0 WSOL PumpSwap route over a zero-extension Token-2022 mint whose own supply reconciles to its complete holder population. */
async function constructedToken(label:string,seed:number){
  const mint=key(seed),creator=pumpPoolAuthorityPda(mint),pool=poolPda(0,creator,mint,NATIVE_MINT);
  const baseVault=getAssociatedTokenAddressSync(mint,pool,true,TOKEN_2022_PROGRAM_ID),quoteVault=getAssociatedTokenAddressSync(NATIVE_MINT,pool,true,TOKEN_PROGRAM_ID),vaultAtomic=100_000_000_000_000n;
  const holders=Array.from({length:12},(_,i)=>({account:key(seed+100+i),owner:key(seed+60+i),amount:BigInt(12-i)*1_000_000_000_000n+BigInt(i)}));
  const supply=holders.reduce((n,h)=>n+h.amount,vaultAtomic);
  const population=[{account:baseVault,owner:pool,amount:vaultAtomic},...holders,{account:key(seed+130),owner:key(seed+20),amount:0n}].map(h=>({pubkey:h.account.toBase58(),account:account(TOKEN_2022_PROGRAM_ID,tokenAccount(mint,h.owner,h.amount))}));
  const global=await encode('globalConfig',{admin:PublicKey.default,lpFeeBasisPoints:bn(20),protocolFeeBasisPoints:bn(15),disableFlags:0,protocolFeeRecipients:Array(8).fill(PublicKey.default),coinCreatorFeeBasisPoints:bn(10),adminSetCoinCreatorAuthority:PublicKey.default,whitelistPda:PublicKey.default,reservedFeeRecipient:PublicKey.default,mayhemModeEnabled:false,reservedFeeRecipients:Array(7).fill(PublicKey.default),isCashbackEnabled:false,buybackFeeRecipients:Array(8).fill(PublicKey.default),buybackBasisPoints:bn(0),boostAuthority:PublicKey.default,boostEnabled:false,creatorFeeConfigurable:true,maxConfigurableCreatorFeeBps:bn(100)});
  const fee=await encode('feeConfig',{bump:1,admin:PublicKey.default,flatFees:rates,feeTiers:[{marketCapLamportsThreshold:bn(0),fees:rates}],stableFeeTiers:[],exoticFlatFees:rates});
  const poolData=await encode('pool',{poolBump:1,index:0,creator,baseMint:mint,quoteMint:NATIVE_MINT,lpMint:lpMintPda(pool),poolBaseTokenAccount:baseVault,poolQuoteTokenAccount:quoteVault,lpSupply:bn(1000),coinCreator:key(1),isMayhemMode:false,isCashbackCoin:false,virtualQuoteReserves:bn(0),creatorFeeBps:bn(0),canEditCreatorFee:false});
  const bankKeys=[GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,NATIVE_MINT,pool,mint,baseVault,quoteVault].map(k=>k.toBase58());
  const bankValues=[account(PUMP_AMM_PROGRAM_ID,global),account(PUMP_FEE_PROGRAM_ID,fee),account(TOKEN_PROGRAM_ID,mintData(0n,9)),account(PUMP_AMM_PROGRAM_ID,poolData),account(TOKEN_2022_PROGRAM_ID,mintData(supply,6)),account(TOKEN_2022_PROGRAM_ID,tokenAccount(mint,pool,vaultAtomic)),account(TOKEN_PROGRAM_ID,tokenAccount(NATIVE_MINT,pool,700_000_000_000n))];
  const cohort=holders.slice(0,5).map(h=>({owner:h.owner.toBase58(),balanceAtomic:String(h.amount)}));
  const entry=(slot:number,chainTime:string)=>({label,mint:mint.toBase58(),pool:pool.toBase58(),bankKeys,program:TOKEN_2022_PROGRAM_ID.toBase58(),baseVault:baseVault.toBase58(),endpoint0:{attempt:1,bankSlot:slot,populationSlot:slot,exactSameSlot:true,bankReceipt:2,populationReceipt:3,populationComplete:true,supplyAtomic:String(supply),accounts:population.length,positiveOwners:population.length-1,positiveAccounts:population.length-1,totalAtomic:String(supply),supplyReconciled:true,chainTime,clockReceipt:4},cohort});
  return {label,mint:mint.toBase58(),pool:pool.toBase58(),bankKeys,bankValues,population,cohort,entry};
}

const A29_MEASUREMENT={
  minimumIntervalSeconds:600,
  endpoint1Rule:'First exact matching finalized GPA/GMA pair captured after endpoint0 chain time +600seconds; actual endpoint1 getBlockTime determines actual interval. Up to3 bounded paired attempts, preserve every failed/mismatched attempt.',
  cohortRule:'Top5 positive aggregate owner addresses at endpoint0, sorted by balance descending then canonical address; exclude only selected pool base vault with raw pool/ATA binding. Freeze addresses before endpoint1 or tape inspection. Other programs remain addresses, never people.',
  sellingScope:'Exact verified selected-pool trades from cohort-owned token accounts; actual target-account owner/transfer binding required. Transfers are not sales, and wallet/person-wide selling is not asserted.',
  price:'Endpoint effective quote/base spot ratio from same-slot actual bank; both quote units/decimals explicit.',
  depth:'Fee-inclusive maximum quoted exit proceeds at300bps vs each endpoint marginal spot using exact existing integer solver and endpoint-bound fee/global/mint/pool/vault state; external network/setup costs and execution simulation excluded.',
  concentration:'Top1/5/10 aggregate owner shares at each endpoint over raw supply and selected-base-vault-adjusted supply, same exclusion and denominator definition at both.',
  buyers:'Complete three-equal-duration selected-pool windows: warmup [t0-2L,t0-L), baseline [t0-L,t0], measured (slot0,slot1], where L=actual endpoint duration. Each counting window excludes meaningful buyers seen in its own preceding L-duration lookback; count each non-program user once per window, threshold0.01WSOL core. Report counts/difference, optional growth ratio null if baseline0. This is first-observed within fixed comparable lookback, never first-ever, people or capital. Exact slot endpoint boundary governs ties with equal blockTime; warmup lower-bound index coverage must be proved.',
  claim:'Descriptive same-interval vector only; no absorption boolean, causal or predictive inference.',
};
const A29_BOUNDS={endpointReadsPerToken:12,tapeMaxPages:2,pageLimit:1000,maxSuccessfulTransactionsPerToken:480,maxTransactionResponseBytes:500000,maxEndpointPopulationResponseBytes:20000000,maxStoredNamespaceBytes:24000000,transportConcurrentTransactions:2,hardCaptureDeadlineSeconds:600};
type Request={method:string;params:unknown[]};

/**
 * Builds a portable a29-retained-sources-v1 wrapper in the exact normalized shape: constructed bank and population at two same-slot endpoints 700 s apart, mainnet genesis, block-time clocks and one complete empty pool page. It is labelled as a constructed test capture, never as genuine RPC. The optional delta forges a mismatched endpoint1 population slot with honest hashes.
 */
export async function buildA29Capture(options:{e1PopulationSlotDelta?:number}={}){
  const primary=await constructedToken('ConstructedPrimary',41),control=await constructedToken('ConstructedControl',42);
  const s0=400_000_000,s1=s0+1_750,t0=Date.parse('2026-10-20T10:00:00.000Z'),t1=t0+700_000,iso=(ms:number)=>new Date(ms).toISOString();
  const freeze={kind:'A29_PROSPECTIVE_OBSERVATIONAL_SCOPE_V1',frozenAt:'2026-10-20T10:02:00.000000+00:00',registration:'Constructed portable test scope; not a genuine registration or capture.',primary:primary.label,control:control.label,selectionReason:'Constructed portable test pair.',tokens:[control.entry(s0,iso(t0)),primary.entry(s0,iso(t0))],measurement:A29_MEASUREMENT,bounds:A29_BOUNDS,status:'SOURCE_AND_MEASUREMENT_CONTRACT_FROZEN_PENDING_IMPLEMENTATION_ADAPTATION',allowedRevisions:'Only concrete source/semantic evidence invalidating a premise, recorded with reason before affected acquisition. Never outcome-based reselection.',evidenceBasedRevisions:[]};
  const bank=(floor:number):Request=>({method:'getMultipleAccounts',params:[primary.bankKeys,{encoding:'base64',commitment:'finalized',minContextSlot:floor}]});
  const population=(floor:number):Request=>({method:'getProgramAccounts',params:[TOKEN_2022_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',minContextSlot:floor,withContext:true,filters:[{memcmp:{offset:0,bytes:primary.mint}}]}]});
  const requests:Record<string,Request>={'a29-e0-genesis':{method:'getGenesisHash',params:[]},'a29-e0-bank':bank(s0-6),'a29-e0-population':population(s0-6),'a29-e0-clock':{method:'getBlockTime',params:[s0]},'a29-e1-genesis':{method:'getGenesisHash',params:[]},'a29-e1-bank':bank(s0),'a29-e1-population':population(s0),'a29-e1-clock':{method:'getBlockTime',params:[s1]},'a29-page-0':{method:'getSignaturesForAddress',params:[primary.pool,{commitment:'finalized',limit:1000,minContextSlot:s1}]}};
  const rpc=(result:unknown)=>JSON.stringify({jsonrpc:'2.0',result,id:1});
  const rawArtifacts:Record<string,string>={'a29-e0-genesis':rpc(SOLANA_MAINNET_GENESIS),'a29-e0-bank':rpc({context:{slot:s0},value:primary.bankValues}),'a29-e0-population':rpc({context:{slot:s0},value:primary.population}),'a29-e0-clock':rpc(t0/1000),'a29-e1-genesis':rpc(SOLANA_MAINNET_GENESIS),'a29-e1-bank':rpc({context:{slot:s1},value:primary.bankValues}),'a29-e1-population':rpc({context:{slot:s1+(options.e1PopulationSlotDelta??0)},value:primary.population}),'a29-e1-clock':rpc(t1/1000),'a29-page-0':rpc([])};
  const completed:Record<string,number>={'a29-e0-genesis':t0-5_000,'a29-e0-bank':t0+3_000,'a29-e0-population':t0+3_001,'a29-e0-clock':t0+3_800,'a29-e1-genesis':t1+5_000,'a29-e1-bank':t1+7_000,'a29-e1-population':t1+7_036,'a29-e1-clock':t1+7_600,'a29-page-0':t1+60_000};
  const retrievedAt=Object.fromEntries(Object.entries(completed).map(([k,ms])=>[k,iso(ms)]));
  const records=Object.keys(requests).map(k=>({key:k,sourceFile:`constructed/${k}.response.txt`,requestFile:`constructed/${k}.request.json`,sourceSha256:sha(rawArtifacts[k]!),requestSha256:sha(JSON.stringify({jsonrpc:'2.0',id:1,...requests[k]!})),sourceBytes:Buffer.byteLength(rawArtifacts[k]!),startedAt:iso(completed[k]!-40),completedAt:iso(completed[k]!),httpDate:new Date(Math.floor(completed[k]!/1000)*1000).toUTCString(),httpStatus:200}));
  const provenance={accessMode:'USER_IMPORT',claim:'Constructed portable test capture; storage integrity only, not a genuine RPC capture, provider-signed attestation or fresh current quote. No metric cache.',executedCollectors:['tests/a29-fixtures.ts'],opusCollectorExecuted:false,sourceManifests:[{path:'constructed/manifest.json',sha256:sha(JSON.stringify(records))}],records};
  const raw=JSON.stringify({method:'a29-retained-sources-v1',token:{chain:'solana',address:primary.mint},label:primary.label,freeze,requests,rawArtifacts,retrievedAt,provenance});
  const latestClock=retrievedAt['a29-page-0']!;
  return {raw,token:{chain:'solana' as const,address:primary.mint},label:primary.label,cohort:primary.cohort.map(c=>c.owner),controlMint:control.mint,latestClock,after:afterCapture(latestClock)};
}
