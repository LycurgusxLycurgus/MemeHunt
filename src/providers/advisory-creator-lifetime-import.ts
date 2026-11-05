import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,poolPda,pumpPoolAuthorityPda} from '@pump-fun/pump-swap-sdk';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import {loadO24BulkCapture} from './advisory-creator-inventory-bulk-import.js';
import {decodeWindowQuote} from './advisory-window.js';

export const O25_CAPTURE_METHOD='o25-creator-lifetime-capture-v1' as const;
export const O25_BANK_SOURCE_ID='advisory-creator-lifetime',O25_BANK_PREFIX=O25_BANK_SOURCE_ID+'-',O25_BANK_ADAPTER='o25-lifetime-bank-v1',O25_BANK_BYTES=500_000;
export const O25_QUOTE_MINT='3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
export type O25LifetimeBank={method:typeof O25_CAPTURE_METHOD;token:TokenRef;pool:string;quoteMint:typeof O25_QUOTE_MINT;requests:Record<string,unknown>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
export type O25PoolContext={poolKey:string;pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>;stateSlot:number;quote:{mint:string;program:string;decimals:number}};
const instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/);
const schema=z.object({method:z.literal(O25_CAPTURE_METHOD),token:tokenRefSchema,pool:z.string(),quoteMint:z.literal(O25_QUOTE_MINT),request:z.unknown(),retrievedAt:instant,file:z.literal('pool.json'),sourceBytes:z.number().int().positive().max(O25_BANK_BYTES),sourceHash:hash}).strict();
const fail=(code:string):never=>{throw Error('ADVISORY_CREATOR_LIFETIME_'+code);};
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
/** Identity-only bank. No current price, balance or virtual reserve state becomes historical cost evidence. */
export function decodeO25LifetimePool(bank:O25LifetimeBank,token:TokenRef,inventoryStateSlot:number,cutoff:string):O25PoolContext{
 if(bank.method!==O25_CAPTURE_METHOD||bank.token.chain!==token.chain||bank.token.address!==token.address||token.chain!=='solana'||bank.quoteMint!==O25_QUOTE_MINT||!same(Object.keys(bank.requests),['pool'])||!same(Object.keys(bank.rawArtifacts),['pool'])||!same(Object.keys(bank.retrievedAt),['pool']))fail('BANK_MEMBERSHIP');
 const at=bank.retrievedAt.pool!,raw=bank.rawArtifacts.pool!;
 if(!instant.safeParse(at).success||!instant.safeParse(cutoff).success||Date.parse(at)>Date.parse(cutoff)||!integer(inventoryStateSlot)||typeof raw!=='string'||Buffer.byteLength(raw)>O25_BANK_BYTES||Buffer.from(raw).toString('utf8')!==raw)fail('BANK_CLOCK_OR_SIZE');
 const expected={method:'getMultipleAccounts',params:[[bank.pool,bank.quoteMint],{encoding:'base64',commitment:'finalized',minContextSlot:inventoryStateSlot}]};if(!same(bank.requests.pool,expected))fail('BANK_REQUEST');
 let envelope:any;try{envelope=JSON.parse(raw);}catch{return fail('BANK_JSON');}
 const r=envelope?.result;if(!obj(envelope)||envelope.jsonrpc!=='2.0'||envelope.id!==1||envelope.error!==undefined||!obj(r)||!integer(r.context?.slot)||r.context.slot<inventoryStateSlot||!Array.isArray(r.value)||r.value.length!==2)fail('BANK_SHAPE');
 const account=r.value[0];if(!obj(account)||account.owner!==PUMP_AMM_PROGRAM_ID.toBase58()||account.executable!==false||!Array.isArray(account.data)||account.data[1]!=='base64'||typeof account.data[0]!=='string')fail('BANK_POOL');
 const bytes=Buffer.from(account.data[0],'base64');if(bytes.length>20000||bytes.toString('base64')!==account.data[0])fail('BANK_POOL');
 let pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>,quote:O25PoolContext['quote'];try{pool=PUMP_AMM_SDK.decodePool({data:bytes,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});quote=decodeWindowQuote(r.value[1],bank.quoteMint);}catch{return fail('BANK_POOL');}
 try{if(pool.index!==0||!pool.creator.equals(pumpPoolAuthorityPda(new PublicKey(token.address)))||pool.baseMint.toBase58()!==token.address||pool.quoteMint.toBase58()!==bank.quoteMint||poolPda(pool.index,pool.creator,pool.baseMint,pool.quoteMint).toBase58()!==bank.pool||quote.program!==TOKEN_PROGRAM_ID.toBase58()||quote.decimals!==8||!pool.poolBaseTokenAccount.equals(getAssociatedTokenAddressSync(pool.baseMint,new PublicKey(bank.pool),true,TOKEN_2022_PROGRAM_ID))||!pool.poolQuoteTokenAccount.equals(getAssociatedTokenAddressSync(pool.quoteMint,new PublicKey(bank.pool),true,TOKEN_PROGRAM_ID)))fail('BANK_IDENTITY');}catch{return fail('BANK_IDENTITY');}
 return {poolKey:bank.pool,pool,stateSlot:r.context.slot,quote};
}
/** Thin, strict retained import. The nested inventory directory keeps its original bounded codec and bytes. */
export function loadO25LifetimeCapture(directory:string,token:TokenRef,cutoff:string){
 const root=resolve(directory);const file=(name:'capture.json'|'pool.json',max:number)=>{let fd:number|undefined;try{fd=openSync(resolve(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>max)fail('FILE_BOUND');const b=readFileSync(fd);if(b.length!==st.size||!Buffer.from(b.toString('utf8')).equals(b))fail('UTF8');return b;}catch{return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}};
 let manifest:z.infer<typeof schema>;try{const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink())fail('DIRECTORY');const entries=readdirSync(root);if(entries.length!==3||entries.some(s=>!['capture.json','pool.json','inventory'].includes(s)))fail('FOREIGN_FILE');manifest=schema.parse(JSON.parse(file('capture.json',20_000).toString('utf8')));}catch{return fail('MANIFEST');}
 if(manifest.token.chain!==token.chain||manifest.token.address!==token.address)fail('TOKEN');
 const inventory=loadO24BulkCapture(resolve(root,'inventory'),token,cutoff),bytes=file('pool.json',O25_BANK_BYTES);if(bytes.length!==manifest.sourceBytes||sha(bytes)!==manifest.sourceHash)fail('SOURCE_HASH');
 const bank:O25LifetimeBank={method:manifest.method,token:manifest.token,pool:manifest.pool,quoteMint:manifest.quoteMint,requests:{pool:manifest.request},rawArtifacts:{pool:bytes.toString('utf8')},retrievedAt:{pool:manifest.retrievedAt}};
 decodeO25LifetimePool(bank,token,inventory.stateSlot,cutoff);return {inventory,bank};
}
