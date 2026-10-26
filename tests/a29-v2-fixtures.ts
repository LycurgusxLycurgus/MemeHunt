/** Synthetic portable A29 v2 fixtures: constructed accounts and receipts with no live or historical claim.
 * USDC/WBTC FX accounts reuse genuine retained Whirlpool templates with only the sqrt price patched. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import BN from 'bn.js';
import {OFFLINE_PUMP_AMM_PROGRAM,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,pumpPoolAuthorityPda,poolPda,FEE_CONFIG_SIZE_PRE_STABLE} from '@pump-fun/pump-swap-sdk';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
import {archiveDemandReceipt,demandTransactionRequest} from '../src/providers/advisory-demand-windows.js';
import {A29_V2_BOUNDS,A29_V2_QUOTES,A29_FREEZE_KIND_V2} from '../src/providers/advisory-absorption-v2.js';
import {a29FxThreshold,A29_WHIRLPOOL_PROGRAM} from '../src/providers/a29-fx-whirlpool.js';

export const QUOTE={WSOL:NATIVE_MINT.toBase58(),USDC:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',WBTC:'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'} as const;
export type QuoteName=keyof typeof QUOTE;
export const V2={slot0:1000,slot1:2600,t0:1800000000,seconds:900};
export const WBTC_SQRT=207543089007531954n;
export type V2Row={signature:string;slot:number;blockTime:number|null;err:unknown};
export type V2Options={quote?:QuoteName;sqrt?:bigint;bankSqrt?:bigint;quoteDecimals?:number;floor?:boolean;e1Genesis?:boolean;pages?:V2Row[][];transactions?:Array<{signature:string;body:string}>;
 source?:(requests:Record<string,any>,raw:Record<string,string>)=>void;mutate?:(packet:any)=>void};

const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes:Uint8Array):string{
 const digits:number[]=[];
 for(const byte of bytes){let carry=byte;for(let i=0;i<digits.length;i++){carry+=digits[i]!*256;digits[i]=carry%58;carry=Math.floor(carry/58);}while(carry>0){digits.push(carry%58);carry=Math.floor(carry/58);}}
 let zeros='';for(const byte of bytes){if(byte!==0)break;zeros+='1';}
 return zeros+digits.reverse().map(d=>ALPHABET[d]).join('');
}
export function fixtureSignature(n:number){const b=Buffer.alloc(64,7);b[0]=9;b.writeUInt32BE(n,1);return base58(b);}
export const rpc=(result:unknown)=>JSON.stringify({jsonrpc:'2.0',id:1,result});
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)),ata=(m:PublicKey,owner:PublicKey)=>getAssociatedTokenAddressSync(m,owner,true,TOKEN_PROGRAM_ID);
const bn=(n:number)=>new BN(n),rates={lpFeeBps:bn(20),protocolFeeBps:bn(15),creatorFeeBps:bn(10)};
async function encode(name:string,v:any){const d=Buffer.from(await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode(name,v));return name==='feeConfig'?Buffer.concat([d,Buffer.alloc(Math.max(0,FEE_CONFIG_SIZE_PRE_STABLE-d.length))]):d;}
const account=(owner:PublicKey|string,data:Buffer)=>({owner:typeof owner==='string'?owner:owner.toBase58(),data:[data.toString('base64'),'base64'],executable:false,lamports:2039280});
function mintData(supply:bigint,decimals:number){const b=Buffer.alloc(MintLayout.span);b.writeBigUInt64LE(supply,36);b[44]=decimals;b[45]=1;return b;}
function tokenData(mint:PublicKey,owner:PublicKey,amount:bigint){const b=Buffer.alloc(165);mint.toBuffer().copy(b);owner.toBuffer().copy(b,32);b.writeBigUInt64LE(amount,64);b[108]=1;return b;}

/** First genuine retained WSOL/quote Whirlpool account in the survey fixture: banks[].rawBody is a getMultipleAccounts JSON-RPC body whose result.value holds the accounts. */
export function fxTemplate(quote:string):Buffer{
 const json=JSON.parse(readFileSync(new URL('../../tests/fixtures/a29-fx-survey-banks.json',import.meta.url),'utf8'));
 const want=new PublicKey(quote).toBuffer(),wsol=NATIVE_MINT.toBuffer();
 for(const bank of json.banks??[]){
  if(bank?.quoteMint!==quote||typeof bank.rawBody!=='string')continue;
  for(const a of JSON.parse(bank.rawBody)?.result?.value??[]){
   if(a?.owner!==A29_WHIRLPOOL_PROGRAM||!Array.isArray(a.data)||a.data[1]!=='base64')continue;
   const b=Buffer.from(a.data[0],'base64');
   if(b.length===653&&b.subarray(101,133).equals(wsol)&&b.subarray(181,213).equals(want))return b;
  }
 }
 throw new Error('A29_V2_FIXTURE_FX_TEMPLATE');
}
function fxAccount(quote:string,sqrt:bigint){const b=fxTemplate(quote);b.writeBigUInt64LE(sqrt&((1n<<64n)-1n),65);b.writeBigUInt64LE(sqrt>>64n,73);return account(A29_WHIRLPOOL_PROGRAM,b);}

/** Portable KNOWN v2 capture. source edits original requests/raw bodies before archiving; mutate edits the final packet. */
export async function buildA29V2Capture(o:V2Options={}){
 const name=o.quote??'WSOL',quoteMint=new PublicKey(QUOTE[name]),q=A29_V2_QUOTES[QUOTE[name]]!,fxPool=q.fxPool,label=`Synthetic${name}`;
 const {slot0,slot1,t0}=V2,t1=t0+V2.seconds,ms=(s:number)=>s*1000,T=1000000000000n,supply=1000n*T;
 const mint=key(7),pool=poolPda(0,pumpPoolAuthorityPda(mint),mint,quoteMint),baseVault=ata(mint,pool),quoteVault=ata(quoteMint,pool);
 const global=await encode('globalConfig',{admin:PublicKey.default,lpFeeBasisPoints:bn(20),protocolFeeBasisPoints:bn(15),disableFlags:0,protocolFeeRecipients:Array(8).fill(PublicKey.default),coinCreatorFeeBasisPoints:bn(10),adminSetCoinCreatorAuthority:PublicKey.default,whitelistPda:PublicKey.default,reservedFeeRecipient:PublicKey.default,mayhemModeEnabled:false,reservedFeeRecipients:Array(7).fill(PublicKey.default),isCashbackEnabled:false,buybackFeeRecipients:Array(8).fill(PublicKey.default),buybackBasisPoints:bn(0),boostAuthority:PublicKey.default,boostEnabled:false,creatorFeeConfigurable:true,maxConfigurableCreatorFeeBps:bn(100)});
 const tiers=[{marketCapLamportsThreshold:bn(0),fees:rates}];
 const fee=await encode('feeConfig',{bump:1,admin:PublicKey.default,flatFees:rates,feeTiers:tiers,stableFeeTiers:tiers,exoticFlatFees:rates});
 const poolData=await encode('pool',{poolBump:1,index:0,creator:pumpPoolAuthorityPda(mint),baseMint:mint,quoteMint,lpMint:key(9),poolBaseTokenAccount:baseVault,poolQuoteTokenAccount:quoteVault,lpSupply:bn(1000),coinCreator:key(1),isMayhemMode:false,isCashbackCoin:false,virtualQuoteReserves:bn(0),creatorFeeBps:bn(0),canEditCreatorFee:false});
 const sqrt=o.sqrt??(name==='WBTC'?WBTC_SQRT:1n<<64n);
 const owners=[20,21,22,22,23,24,25,26,27];
 const states=[{B:100n*T,P:700000000000n,amounts:[300n,200n,100n,50n,100n,80n,50n,20n,0n]},{B:99n*T,P:707000000000n,amounts:[299n,200n,100n,50n,100n,80n,51n,21n,0n]}];
 const bankKeys=[GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,quoteMint,pool,mint,baseVault,quoteVault].map(k=>k.toBase58()).concat(fxPool?[NATIVE_MINT.toBase58(),fxPool]:[]);
 const bank=(s:typeof states[number])=>[account(PUMP_AMM_PROGRAM_ID,global),account(PUMP_FEE_PROGRAM_ID,fee),account(TOKEN_PROGRAM_ID,mintData(0n,o.quoteDecimals??q.decimals)),account(PUMP_AMM_PROGRAM_ID,poolData),account(TOKEN_PROGRAM_ID,mintData(supply,6)),account(TOKEN_PROGRAM_ID,tokenData(mint,pool,s.B)),account(TOKEN_PROGRAM_ID,tokenData(quoteMint,pool,s.P)),
  ...(fxPool?[account(TOKEN_PROGRAM_ID,mintData(0n,9)),fxAccount(QUOTE[name],o.bankSqrt??sqrt)]:[])];
 const population=(s:typeof states[number])=>[{pubkey:baseVault.toBase58(),account:account(TOKEN_PROGRAM_ID,tokenData(mint,pool,s.B))},...s.amounts.map((a,i)=>({pubkey:key(100+i).toBase58(),account:account(TOKEN_PROGRAM_ID,tokenData(mint,key(owners[i]!),a*T))}))];
 const requests:Record<string,any>={},raw:Record<string,string>={},at:Record<string,string>={};
 const put=(id:string,request:unknown,body:string,when:number)=>{requests[id]=request;raw[id]=body;at[id]=new Date(when).toISOString();};
 const floor=(n:number)=>o.floor===false?{}:{minContextSlot:n};
 [{prefix:'a29-e0',slot:slot0,time:t0},{prefix:'a29-e1',slot:slot1,time:t1}].forEach(({prefix,slot,time},i)=>{
  const s=states[i]!,when=ms(time);
  if(i===0||o.e1Genesis!==false)put(`${prefix}-genesis`,{method:'getGenesisHash',params:[]},rpc(SOLANA_MAINNET_GENESIS),when-2000);
  put(`${prefix}-bank`,{method:'getMultipleAccounts',params:[bankKeys,{encoding:'base64',commitment:'finalized',...floor(slot0-6)}]},rpc({context:{slot},value:bank(s)}),when+500);
  put(`${prefix}-population`,{method:'getProgramAccounts',params:[TOKEN_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',withContext:true,filters:[{memcmp:{offset:0,bytes:mint.toBase58()}}],...floor(slot0-6)}]},rpc({context:{slot},value:population(s)}),when+600);
  put(`${prefix}-clock`,{method:'getBlockTime',params:[slot]},rpc(time),when+1000);
 });
 let before:string|undefined;
 (o.pages??[[]]).forEach((rows,i)=>{put(`a29-page-${i}`,{method:'getSignaturesForAddress',params:[pool.toBase58(),{commitment:'finalized',limit:1000,...(before?{before}:{}),...floor(slot1)}]},rpc(rows.map(r=>({...r,memo:null,confirmationStatus:'finalized'}))),ms(t1)+60000);before=rows.at(-1)?.signature;});
 (o.transactions??[]).forEach((x,n)=>put(`a29-transaction-${n}`,demandTransactionRequest(x.signature),x.body,ms(t1)+61000+n));
 o.source?.(requests,raw);
 const held=new Map<string,bigint>();
 states[0]!.amounts.forEach((a,i)=>{if(a>0n){const owner=key(owners[i]!).toBase58();held.set(owner,(held.get(owner)??0n)+a*T);}});
 const cohort=[...held].sort((a,b)=>a[1]!==b[1]?(a[1]>b[1]?-1:1):a[0]<b[0]?-1:1).slice(0,5).map(([owner,amount])=>({owner,balanceAtomic:String(amount)}));
 const ids=Object.keys(requests),rawArtifacts:Record<string,string>={};
 const records=ids.map(id=>{const bytes=Buffer.from(raw[id]!,'utf8');rawArtifacts[id]=archiveDemandReceipt(raw[id]!);
  return{key:id,sourceBytes:bytes.length,sourceSha256:createHash('sha256').update(bytes).digest('hex'),startedAt:at[id],completedAt:at[id],httpStatus:200};});
 const packet:any={method:'a29-retained-sources-v2',token:{chain:'solana',address:mint.toBase58()},label,requests,retrievedAt:at,rawArtifacts,
  provenance:{accessMode:'USER_IMPORT',claim:'Synthetic constructed fixture; no live or historical capture claim.',records},
  freeze:{kind:A29_FREEZE_KIND_V2,frozenAt:new Date(ms(t0)+60000).toISOString(),registration:'Synthetic fixture.',measurement:{minimumIntervalSeconds:600},bounds:{...A29_V2_BOUNDS},evidenceBasedRevisions:[],
   tokens:[{label,endpoint1Attempt:1,mint:mint.toBase58(),pool:pool.toBase58(),program:TOKEN_PROGRAM_ID.toBase58(),baseVault:baseVault.toBase58(),quoteMint:QUOTE[name],quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:q.decimals,quoteVault:quoteVault.toBase58(),fxPool,bankKeys,cohort,
    endpoint0:{attempt:1,bankSlot:slot0,populationSlot:slot0,exactSameSlot:true,populationComplete:true,supplyReconciled:true,accounts:10,chainTime:new Date(ms(t0)).toISOString(),supplyAtomic:String(supply),totalAtomic:String(supply),
     baseVaultAtomic:String(states[0]!.B),quoteVaultAtomic:String(states[0]!.P),meaningfulQuoteAtomic:fxPool?String(a29FxThreshold(sqrt)):'10000000',fx:fxPool?{pool:fxPool,sqrtPriceX64:String(sqrt),bankSlot:slot0}:null}}]}};
 o.mutate?.(packet);
 return{raw:JSON.stringify(packet),packet,cutoff:new Date(ms(t1)+3600000).toISOString()};
}
