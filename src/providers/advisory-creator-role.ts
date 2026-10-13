import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { TokenRef } from '../domain/contracts.js';
import { decodeSolanaAddress, LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './solana.js';
import { publicHttpsUrl } from './tinyfish.js';

// Official pump-public-docs idl/pump.json, retrieved 2026-10-12T04:24:13Z, 327956 bytes.
// Pinned: create_v2 discriminator, its 16 IDL accounts with address/PDA/signer/writable roles, the
// name/symbol/uri/creator argument prefix and the CreateEvent prefix through timestamp. Appended
// arguments and event fields are bounded by their current IDL sizes and never interpreted.
export const PUMP_CREATE_ABI_SOURCE='https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json';
export const PUMP_CREATE_ABI_HASH='6a19bad7758fb822cee79a91575e51a7bd60391c670200408676643e00a79a6d';
export const PUMP_PROGRAM='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PINNED_CREATE_V2={
 discriminator:[214,144,76,236,95,139,49,180],
 accounts:[['mint','ws'],['mint_authority',''],['bonding_curve','w'],['associated_bonding_curve','w'],['global',''],['user','ws'],['system_program',''],['token_program',''],['associated_token_program',''],['mayhem_program_id','w'],['global_params',''],['sol_vault','w'],['mayhem_state','w'],['mayhem_token_vault','w'],['event_authority',''],['program','']],
 argumentPrefix:['name','symbol','uri','creator'],
 argumentTailMaxBytes:11,
 eventDiscriminator:[27,114,169,77,222,235,99,118],
 eventPrefix:['name','symbol','uri','mint','bonding_curve','user','creator','timestamp'],
 eventTailMaxBytes:116,
 mayhemProgram:'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
 // IDL const program bytes for the global_params, sol_vault and mayhem_state PDAs.
 mayhemSeedProgram:[5,42,229,215,167,218,167,36,166,234,176,167,41,84,145,133,90,212,160,103,22,96,103,76,78,3,69,89,128,61,101,163],
} as const;
export const CREATOR_ROLE_RECEIPTS={page:'creator-role-page',walletIndex:'creator-role-wallet-index',transaction:'creator-role-transaction'} as const;
const R=CREATOR_ROLE_RECEIPTS;
const SYSTEM='11111111111111111111111111111111',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',INDEX_LIMIT=1000,DATA_CHARS=14_000;
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CREATE_TAG=Buffer.from(PINNED_CREATE_V2.discriminator),EVENT_TAG=Buffer.from(PINNED_CREATE_V2.eventDiscriminator),EVENT_IX_TAG=Buffer.from('e445a52e51cb9a1d','hex');
const INVOKE=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/,RESULT=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed: .*)$/;
const LABEL=/(?:^|\n)Creator[ \t]*\n(?:[ \t]*\n)*[ \t]*([1-9A-HJ-NP-Za-km-z]{4,8})\u2026([1-9A-HJ-NP-Za-km-z]{4,8})[ \t]*(?=\n|$)/g;

type Request={method:string;params:unknown[]};
export type CreatorRoleReceipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,unknown>};
export const creatorRoleCoinUrl=(mint:string)=>`https://pump.fun/coin/${mint}`;
/** Native TinyFish fetch body; links:true returns the page link list used for the profile binding. */
export const creatorRolePageRequest=(mint:string)=>({method:'POST',url:'https://api.fetch.tinyfish.ai/',body:{urls:[creatorRoleCoinUrl(mint)],format:'markdown',links:true,ttl:0,per_url_timeout_ms:8000}});
export const creatorRoleIndexRequest=(wallet:string):Request=>({method:'getSignaturesForAddress',params:[wallet,{limit:INDEX_LIMIT,commitment:'finalized'}]});
export const creatorRoleTransactionRequest=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});

export type PublicCreatorRole={
 method:'pump-public-creator-role-v1';
 abi:{source:string;sha256:string;program:string;instruction:'create_v2';event:'CreateEvent';argumentTailBytes:number;eventTailBytes:number;appendedFields:'LENGTH_BOUNDED_NOT_INTERPRETED'};
 token:TokenRef;wallet:string;
 actor:{kind:'PUBLIC_PUMP_PROFILE';id:string;profileUrl:string};
 relationship:'PUBLIC_PROFILE_CREATOR_CLAIM_CONFIRMED_BY_SIGNED_CREATE_V2';
 role:'TOKEN_CREATION_SIGNER_AND_DECLARED_CREATOR';
 validity:{kind:'HISTORICAL_TRANSACTION';validAt:string;validUntil:null;ongoingControlAsserted:false};
 creation:{signature:string;slot:number;at:string;instructionIndex:number;feePayer:string;walletIsFeePayer:boolean;bondingCurve:string;mintAuthority:string;tokenProgram:string;mintFundedBy:string;mintCloseAuthority:'NOT_INITIALIZED';uniqueness:'MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION'};
 publicClaim:{pageUrl:string;observedAt:string;profileLinks:number;visibleCreatorLabel:string;pagePublishedDate:string|null;pagePublishedDateUsedAsBirthProof:false};
 walletIndex:{retrievedAt:string;returned:number;limit:number;providerIndexExhausted:boolean;oldestRetainedAt:string|null};
 cutoff:string;personIdentityAsserted:false;socialAccountBound:false;currentFeeBeneficiaryAsserted:false;
 limitations:string[];
};

function fail(code:string):never{throw new Error(`CREATOR_ROLE_${code}`);}
const obj=(x:unknown):x is Record<string,any>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
function json(raw:string,code:string):any{try{return JSON.parse(raw);}catch{return fail(code);}}
// Same arbitrary-length base58 reading as advisory-trades.ts, kept local to this module.
function bytes58(s:unknown,max=2000):Buffer{
 if(typeof s!=='string'||!s.length||s.length>max||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s))fail('ENCODING');
 let n=0n;for(const c of s)n=n*58n+BigInt(BASE58.indexOf(c));
 const hex=n.toString(16),body=n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex');
 return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),body]);
}
const isAddress=(x:unknown):x is string=>{try{return typeof x==='string'&&decodeSolanaAddress(x).length===32;}catch{return false;}};
const isSignature=(x:unknown):x is string=>{try{return typeof x==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(x)&&bytes58(x).length===64;}catch{return false;}};
const utf8=(b:Buffer)=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{return null;}};
function reader(b:Buffer,start:number,code:string){
 let o=start;const take=(n:number)=>{if(o+n>b.length)fail(code);const s=b.subarray(o,o+n);o+=n;return s;};
 return{
  string(){const n=take(4).readUInt32LE(0);if(n>1024)fail(code);const s=utf8(take(n));if(s===null)fail(code);return s;},
  key(){return new PublicKey(take(32)).toBase58();},
  i64(){return take(8).readBigInt64LE(0);},
  rest(){return b.length-o;},
 };
}
function rpcResult(raw:string):unknown{
 const v=json(raw,'RECEIPT');if(!obj(v)||v.jsonrpc!=='2.0'||v.id!==1)fail('RECEIPT');
 if(v.error!==undefined)fail('UNAVAILABLE');if(!('result' in v))fail('RECEIPT');return v.result;
}

/** Minimal discovery exports for the bounded collector; role verification remains verifyPublicCreatorRole. */
export { rpcResult as creatorRoleRpcResult, publicClaim as publicCreatorClaim, indexRows as creatorRoleIndexRows };

/** The coin page is a platform display claim; it is bound only to its own single profile link and visible label. */
function publicClaim(raw:string,mint:string){
 const v=json(raw,'PAGE_SHAPE');if(!obj(v)||!Array.isArray(v.results)||!Array.isArray(v.errors))fail('PAGE_SHAPE');
 if(v.errors.length)fail('PAGE_ERRORS');
 const p=v.results[0],coin=creatorRoleCoinUrl(mint);
 if(v.results.length!==1||!obj(p)||typeof p.url!=='string'||typeof p.text!=='string'||p.text.length>400_000||!Array.isArray(p.links)||p.links.length>5000||p.links.some((l:unknown)=>typeof l!=='string'))fail('PAGE_SHAPE');
 if(publicHttpsUrl(p.url)!==coin||typeof p.final_url!=='string'||publicHttpsUrl(p.final_url)!==coin)fail('PAGE_MINT_MISMATCH');
 const profiles=new Set<string>();let profileLinks=0;
 for(const link of p.links as string[]){
  let u:URL|null=null;try{u=new URL(link);}catch{/* unparseable profile-looking links are rejected below */}
  const host=u?u.hostname.toLowerCase():'';
  if(u?!((host==='pump.fun'||host.endsWith('.pump.fun'))&&/^\/profile(\/|$)/i.test(u.pathname)):!/pump\.fun\/profile/i.test(link))continue;
  const m=u&&u.protocol==='https:'&&host==='pump.fun'&&!u.search&&!u.hash&&!u.username&&!u.password&&!u.port?u.pathname.match(/^\/profile\/([1-9A-HJ-NP-Za-km-z]{32,44})$/):null;
  if(!m||!isAddress(m[1]))fail('PROFILE_MALFORMED');
  profiles.add(m[1]!);profileLinks++;
 }
 if(!profiles.size)fail('PROFILE_MISSING');if(profiles.size>1)fail('PROFILE_AMBIGUOUS');
 const wallet=[...profiles][0]!;
 const labels=new Set([...(p.text as string).matchAll(LABEL)].map(x=>`${x[1]}\u2026${x[2]}`));
 if(!labels.size)fail('PROFILE_LABEL_MISSING');if(labels.size>1)fail('PROFILE_AMBIGUOUS');
 const label=[...labels][0]!,[head,tail]=label.split('\u2026') as [string,string];
 if(!wallet.startsWith(head)||!wallet.endsWith(tail))fail('PROFILE_LABEL_MISMATCH');
 return{wallet,profileUrl:`https://pump.fun/profile/${wallet}`,profileLinks,label,publishedDate:typeof p.published_date==='string'?p.published_date as string:null};
}

function indexRows(value:unknown,retrieved:number){
 if(!Array.isArray(value)||value.length>INDEX_LIMIT)fail('INDEX_SHAPE');
 const seen=new Set<string>();let previous=Infinity;
 return value.map((v:unknown)=>{
  if(!obj(v)||!isSignature(v.signature)||seen.has(v.signature)||!integer(v.slot)||v.slot>previous||!(v.blockTime===null||integer(v.blockTime)&&v.blockTime*1000<=retrieved)||!('err' in v)||!(v.err===null||obj(v.err))||v.confirmationStatus!=='finalized')fail('INDEX_SHAPE');
  seen.add(v.signature);previous=v.slot;
  return{signature:v.signature as string,slot:v.slot as number,blockTime:v.blockTime as number|null,err:v.err as unknown};
 });
}

/** Executed top-level create_v2 with typed prefixes, mint allocation/initialization, complete frames and bound event. */
function verifyCreation(value:unknown,expected:{signature:string;slot:number;blockTime:number},mint:string,retrieved:number){
 if(value===null)fail('TRANSACTION_UNAVAILABLE');
 const tx=value as any;
 if(!obj(tx)||!obj(tx.meta)||!obj(tx.transaction)||!obj(tx.transaction.message))fail('TRANSACTION_SHAPE');
 const meta=tx.meta,message=tx.transaction.message,signatures=tx.transaction.signatures,keys=message.accountKeys,top=message.instructions;
 if(tx.slot!==expected.slot||tx.blockTime!==expected.blockTime||!integer(tx.blockTime)||tx.blockTime*1000>retrieved||!Array.isArray(signatures)||signatures[0]!==expected.signature)fail('TRANSACTION_BINDING');
 if(meta.err!==null||'status' in meta&&JSON.stringify(meta.status)!=='{"Ok":null}')fail('TRANSACTION_FAILED');
 if(!['legacy',0,1].includes(tx.version)||!Array.isArray(keys)||!keys.length||keys.length>256||!Array.isArray(top)||!top.length||top.length>64||!Array.isArray(meta.innerInstructions)||!Array.isArray(meta.logMessages)||!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances)||meta.preBalances.length!==keys.length||meta.postBalances.length!==keys.length)fail('TRANSACTION_SHAPE');
 const flags=new Map<string,{signer:boolean;writable:boolean;index:number}>();
 for(const [i,k] of keys.entries()){if(!obj(k)||!isAddress(k.pubkey)||typeof k.signer!=='boolean'||typeof k.writable!=='boolean'||flags.has(k.pubkey))fail('TRANSACTION_SHAPE');flags.set(k.pubkey,{signer:k.signer,writable:k.writable,index:i});}
 if(signatures.length!==keys.filter((k:any)=>k.signer).length||!signatures.every(isSignature)||!keys[0].signer)fail('TRANSACTION_SHAPE');
 // Every executed instruction needs parsed content, or raw declared keys plus base58 data, before any creation or absence conclusion.
 const shaped=(e:any)=>obj(e)&&flags.has(e.programId)&&(obj(e.parsed)?typeof e.parsed.type==='string'&&obj(e.parsed.info):'parsed' in e?typeof e.parsed==='string':Array.isArray(e.accounts)&&e.accounts.length<=256&&e.accounts.every((a:unknown)=>flags.has(a as string))&&typeof e.data==='string'&&e.data.length<=DATA_CHARS&&/^[1-9A-HJ-NP-Za-km-z]*$/.test(e.data));
 for(const ix of top)if(!shaped(ix))fail('TRANSACTION_SHAPE');
 const groups=new Map<number,any[]>();
 for(const g of meta.innerInstructions){
  if(!obj(g)||!integer(g.index)||g.index>=top.length||groups.has(g.index)||!Array.isArray(g.instructions))fail('TRANSACTION_SHAPE');
  for(const e of g.instructions)if(!shaped(e)||!integer(e.stackHeight)||e.stackHeight<2)fail('TRANSACTION_SHAPE');
  groups.set(g.index,g.instructions);
 }
 // The complete executed trace binds every top-level and inner instruction to its logged program frame before either a creation or an absence conclusion.
 const logs=meta.logMessages;if(logs.some((l:unknown)=>typeof l!=='string'))fail('TRANSACTION_SHAPE');if(logs.includes('Log truncated'))fail('LOG_TRUNCATED');
 const frames:Array<Array<{program:string;depth:number}>>=top.map(()=>[]),dataLogs:Array<{top:number;payload:string;position:number}>=[],stack:string[]=[];let current=-1;
 for(const line of logs as string[]){
  let r=line.match(INVOKE);
  if(r){const depth=Number(r[2]);if(depth!==stack.length+1)fail('LOG_INCOMPLETE');if(depth===1){current++;if(current>=top.length||top[current].programId!==r[1])fail('LOG_INCOMPLETE');}else frames[current]!.push({program:r[1]!,depth});stack.push(r[1]!);continue;}
  r=line.match(RESULT);
  if(r){if(stack.pop()!==r[1])fail('LOG_INCOMPLETE');if(r[2]!=='success')fail('FRAME_FAILED');continue;}
  if(line.startsWith('Program data: ')&&stack.length===1)dataLogs.push({top:current,payload:line.slice(14),position:frames[current]!.length});
 }
 if(stack.length||current!==top.length-1)fail('LOG_INCOMPLETE');
 for(const [i,frame] of frames.entries()){const g=groups.get(i)??[];if(frame.length!==g.length||frame.some((f,j)=>f.program!==g[j].programId||f.depth!==g[j].stackHeight))fail('LOG_INCOMPLETE');}
 const inner=[...groups.values()].flat(),all=[...top,...inner];
 // Only a top-level create binds the creating user to a transaction signer; a CPI create stays unsupported.
 const tagged=(ix:any)=>ix.programId===PUMP_PROGRAM&&typeof ix.data==='string'&&ix.data.length>0&&bytes58(ix.data,DATA_CHARS).subarray(0,8).equals(CREATE_TAG);
 if(inner.some(tagged))fail('CREATE_DUPLICATE');
 const creates=top.flatMap((ix:any,i:number)=>tagged(ix)?[i]:[]);
 // A successful, signature-bound, well-formed and completely logged transaction is a definite non-creation only when every System and token-program
 // entry is one of the explicitly supported parsed forms below, with exact fields and every account role a resolved transaction key that is not the
 // target mint (transferChecked may name it as its mint). Raw, unknown, incomplete or otherwise unsupported critical entries cannot certify absence.
 if(!creates.length){
  const role=(x:unknown)=>typeof x==='string'&&flags.has(x)&&x!==mint,exact=(i:Record<string,unknown>,names:string[])=>JSON.stringify(Object.keys(i).sort())===JSON.stringify([...names].sort());
  const amount=(t:unknown)=>obj(t)&&Object.keys(t).every(k=>['amount','decimals','uiAmount','uiAmountString'].includes(k))&&typeof t.amount==='string'&&/^\d{1,20}$/.test(t.amount)&&integer(t.decimals)&&t.decimals<=255;
  const supported=(e:any)=>{
   if(!obj(e.parsed))return false;const t=e.parsed.type,i=e.parsed.info;
   if(e.programId===SYSTEM)return t==='transfer'&&exact(i,['source','destination','lamports'])&&role(i.source)&&role(i.destination)&&integer(i.lamports);
   return t==='transferChecked'&&exact(i,['source','destination','authority','mint','tokenAmount'])&&role(i.source)&&role(i.destination)&&role(i.authority)&&typeof i.mint==='string'&&flags.has(i.mint)&&amount(i.tokenAmount);
  };
  fail(all.every(e=>![SYSTEM,TOKEN_2022_PROGRAM,LEGACY_TOKEN_PROGRAM].includes(e.programId)||supported(e))?'NON_CREATE':'CREATE_UNSUPPORTED');
 }
 if(creates.length>1)fail('CREATE_DUPLICATE');
 const index:number=creates[0],ix=top[index],accounts=ix.accounts;
 if(!Array.isArray(accounts)||accounts.some((a:unknown)=>typeof a!=='string'||!flags.has(a)))fail('CREATE_ACCOUNTS');
 // Remaining accounts select a non-SOL quote mint per the IDL docs; that path is outside this contract.
 if(accounts.length>16)fail('QUOTE_PATH_UNSUPPORTED');if(accounts.length!==16)fail('CREATE_ACCOUNTS');
 if(accounts[0]!==mint)fail('CREATE_MINT_MISMATCH');
 const program=new PublicKey(PUMP_PROGRAM),seedProgram=new PublicKey(Uint8Array.from(PINNED_CREATE_V2.mayhemSeedProgram)),mintKey=new PublicKey(mint);
 const pda=(seeds:Buffer[],owner=program)=>PublicKey.findProgramAddressSync(seeds,owner)[0].toBase58();
 const bondingCurve=pda([Buffer.from('bonding-curve'),mintKey.toBuffer()]),mintAuthority=pda([Buffer.from('mint-authority')]),eventAuthority=pda([Buffer.from('__event_authority')]);
 const expectedAccounts:(string|null)[]=[mint,mintAuthority,bondingCurve,getAssociatedTokenAddressSync(mintKey,new PublicKey(bondingCurve),true,new PublicKey(TOKEN_2022_PROGRAM)).toBase58(),pda([Buffer.from('global')]),null,SYSTEM,TOKEN_2022_PROGRAM,ATA,PINNED_CREATE_V2.mayhemProgram,pda([Buffer.from('global-params')],seedProgram),pda([Buffer.from('sol-vault')],seedProgram),pda([Buffer.from('mayhem-state'),mintKey.toBuffer()],seedProgram),null,eventAuthority,PUMP_PROGRAM];
 for(const [i,[,role]] of PINNED_CREATE_V2.accounts.entries()){const a:string=accounts[i],f=flags.get(a)!;if(expectedAccounts[i]!==null&&a!==expectedAccounts[i]||role.includes('w')&&!f.writable||role.includes('s')&&!f.signer)fail('CREATE_ACCOUNTS');}
 const user:string=accounts[5];
 const args=reader(bytes58(ix.data),8,'CREATE_ARGUMENTS'),name=args.string(),symbol=args.string(),uri=args.string(),creatorArg=args.key(),argumentTailBytes=args.rest();
 if(argumentTailBytes>PINNED_CREATE_V2.argumentTailMaxBytes)fail('ABI_UNSUPPORTED');
 // The holder-reward path redirects creator to a PDA, so creator=user excludes it without decoding the tail.
 if(creatorArg!==user)fail('SIGNED_ROLE_CONTRADICTION');
 const info=(e:any)=>obj(e.parsed)&&obj(e.parsed.info)?e.parsed.info:null,type=(e:any)=>obj(e.parsed)&&typeof e.parsed.type==='string'?e.parsed.type as string:null;
 const group=groups.get(index)??[];
 const alloc=group.findIndex(e=>info(e)?.newAccount===mint),init=group.findIndex(e=>type(e)==='initializeMint2'&&info(e)?.mint===mint);
 if(all.filter(e=>info(e)?.newAccount===mint).length!==1||all.filter(e=>['initializeMint','initializeMint2'].includes(type(e)??'')&&info(e)?.mint===mint).length!==1||alloc<0||init<=alloc)fail('MINT_INITIALIZATION');
 const a=group[alloc],m=group[init];
 if(a.programId!==SYSTEM||type(a)!=='createAccount'||a.stackHeight!==2||info(a).owner!==TOKEN_2022_PROGRAM||info(a).source!==user||m.programId!==TOKEN_2022_PROGRAM||m.stackHeight!==2||info(m).mintAuthority!==mintAuthority)fail('MINT_INITIALIZATION');
 // Token-2022 mint extensions precede InitializeMint2. Only the metadata pointer is permitted, so no
 // MintCloseAuthority exists and this mint cannot be closed and recreated after this transaction.
 if(group.slice(alloc+1,init).some(e=>e.programId!==TOKEN_2022_PROGRAM||type(e)!=='initializeMetadataPointer'||info(e)?.mint!==mint)||all.some(e=>type(e)==='initializeMintCloseAuthority'))fail('MINT_INITIALIZATION');
 const k=flags.get(mint)!.index;if(meta.preBalances[k]!==0||!integer(meta.postBalances[k])||meta.postBalances[k]<=0)fail('MINT_INITIALIZATION');
 const curve=group.filter(e=>info(e)?.newAccount===bondingCurve);
 if(curve.length!==1||type(curve[0])!=='createAccount'||curve[0].programId!==SYSTEM||info(curve[0]).owner!==PUMP_PROGRAM||info(curve[0]).source!==user)fail('MINT_INITIALIZATION');
 const eventLogs=dataLogs.filter(d=>d.top===index);
 if(!eventLogs.length)fail('EVENT_MISSING');if(eventLogs.length>1)fail('EVENT_DUPLICATE');
 const {payload,position}=eventLogs[0]!,eventBytes=Buffer.from(payload,'base64');
 if(payload.length>4000||eventBytes.toString('base64')!==payload||!eventBytes.subarray(0,8).equals(EVENT_TAG))fail('EVENT_BINDING');
 const cpis=group.flatMap((e,j)=>e.programId===PUMP_PROGRAM?[{e,j}]:[]);
 if(cpis.length!==1)fail('EVENT_BINDING');
 const {e:cpi,j:cpiPosition}=cpis[0]!;
 if(cpi.stackHeight!==2||!Array.isArray(cpi.accounts)||cpi.accounts.length!==1||cpi.accounts[0]!==eventAuthority||cpiPosition<position)fail('EVENT_BINDING');
 const cpiBytes=bytes58(cpi.data,4000);if(!cpiBytes.subarray(0,8).equals(EVENT_IX_TAG)||!cpiBytes.subarray(8).equals(eventBytes))fail('EVENT_BINDING');
 const ev=reader(eventBytes,8,'EVENT_BINDING');
 const event={name:ev.string(),symbol:ev.string(),uri:ev.string(),mint:ev.key(),bondingCurve:ev.key(),user:ev.key(),creator:ev.key(),timestamp:ev.i64()},eventTailBytes=ev.rest();
 if(eventTailBytes>PINNED_CREATE_V2.eventTailMaxBytes)fail('ABI_UNSUPPORTED');
 if(event.name!==name||event.symbol!==symbol||event.uri!==uri||event.mint!==mint||event.bondingCurve!==bondingCurve||event.timestamp!==BigInt(tx.blockTime))fail('EVENT_BINDING');
 if(event.user!==user||event.creator!==user)fail('SIGNED_ROLE_CONTRADICTION');
 return{user,instructionIndex:index,feePayer:keys[0].pubkey as string,bondingCurve,mintAuthority,argumentTailBytes,eventTailBytes};
}

/** S13 narrow public creator-role binding: wallet-to-token creation role only, never a person, social account or ongoing control. */
export function verifyPublicCreatorRole(token:TokenRef,receipts:CreatorRoleReceipts,cutoff:string):PublicCreatorRole{
 if(token.chain!=='solana'||!isAddress(token.address))fail('SCOPE');
 const mint=token.address,cut=Date.parse(cutoff);if(!Number.isFinite(cut))fail('SCOPE');
 const clock=(id:string)=>{const t=Date.parse(receipts.retrievedAt[id]??'');if(!Number.isFinite(t))fail('RECEIPT');if(t>cut)fail('CLOCK');return t;};
 const declared=(id:string,expected:unknown)=>{const raw=receipts.rawArtifacts[id];if(JSON.stringify(receipts.requests[id])!==JSON.stringify(expected)||typeof raw!=='string')fail('RECEIPT');return raw;};
 const pageRaw=declared(R.page,creatorRolePageRequest(mint)),pageAt=clock(R.page),claim=publicClaim(pageRaw,mint),wallet=claim.wallet;
 const indexRaw=declared(R.walletIndex,creatorRoleIndexRequest(wallet)),indexAt=clock(R.walletIndex),rows=indexRows(rpcResult(indexRaw),indexAt);
 const params=(receipts.requests[R.transaction] as any)?.params,signature:unknown=Array.isArray(params)?params[0]:undefined;
 if(!isSignature(signature))fail('RECEIPT');
 const txRaw=declared(R.transaction,creatorRoleTransactionRequest(signature)),txAt=clock(R.transaction);
 const row=rows.find(r=>r.signature===signature);if(!row||row.err!==null||row.blockTime===null)fail('INDEX_SIGNATURE');
 const blockTime=row.blockTime,creation=verifyCreation(rpcResult(txRaw),{signature,slot:row.slot,blockTime},mint,txAt);
 if(creation.user!==wallet)fail('PROFILE_ROLE_CONTRADICTION');
 if(blockTime*1000>pageAt||blockTime*1000>indexAt)fail('CLOCK');
 const validAt=new Date(blockTime*1000).toISOString(),dated=rows.flatMap(r=>r.blockTime===null?[]:[r.blockTime]);
 return{
  method:'pump-public-creator-role-v1',
  abi:{source:PUMP_CREATE_ABI_SOURCE,sha256:PUMP_CREATE_ABI_HASH,program:PUMP_PROGRAM,instruction:'create_v2',event:'CreateEvent',argumentTailBytes:creation.argumentTailBytes,eventTailBytes:creation.eventTailBytes,appendedFields:'LENGTH_BOUNDED_NOT_INTERPRETED'},
  token:{chain:'solana',address:mint},wallet,
  actor:{kind:'PUBLIC_PUMP_PROFILE',id:`PUBLIC_PUMP_PROFILE:${wallet}`,profileUrl:claim.profileUrl},
  relationship:'PUBLIC_PROFILE_CREATOR_CLAIM_CONFIRMED_BY_SIGNED_CREATE_V2',
  role:'TOKEN_CREATION_SIGNER_AND_DECLARED_CREATOR',
  validity:{kind:'HISTORICAL_TRANSACTION',validAt,validUntil:null,ongoingControlAsserted:false},
  creation:{signature,slot:row.slot,at:validAt,instructionIndex:creation.instructionIndex,feePayer:creation.feePayer,walletIsFeePayer:creation.feePayer===wallet,bondingCurve:creation.bondingCurve,mintAuthority:creation.mintAuthority,tokenProgram:TOKEN_2022_PROGRAM,mintFundedBy:wallet,mintCloseAuthority:'NOT_INITIALIZED',uniqueness:'MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION'},
  publicClaim:{pageUrl:creatorRoleCoinUrl(mint),observedAt:new Date(pageAt).toISOString(),profileLinks:claim.profileLinks,visibleCreatorLabel:claim.label,pagePublishedDate:claim.publishedDate,pagePublishedDateUsedAsBirthProof:false},
  walletIndex:{retrievedAt:new Date(indexAt).toISOString(),returned:rows.length,limit:INDEX_LIMIT,providerIndexExhausted:rows.length<INDEX_LIMIT,oldestRetainedAt:dated.length?new Date(Math.min(...dated)*1000).toISOString():null},
  cutoff:new Date(cut).toISOString(),personIdentityAsserted:false,socialAccountBound:false,currentFeeBeneficiaryAsserted:false,
  limitations:[
   'Wallet-to-token creation role only: no person, name, team, social handle or off-chain controller is identified.',
   'Valid at the creation transaction clock; the page claim is an observation at its retrieval time. No ongoing control, present ownership or current mutable fee beneficiary is asserted.',
   'Social and website links on the coin page are not bound to the wallet.',
   'Page published_date is retained as a page claim and never used as the creation clock or birth proof; the bounded collector uses it only as a candidate-discovery hint.',
   'Wallet index exhaustion below its limit is a provider observation, not archival completeness; the creation proof rests on the transaction.',
   'Only the pinned create_v2 accounts and argument/event prefixes are decoded; appended fields are length-bounded and uninterpreted. The published IDL is mutable and does not attest the deployed program; runtime account, argument, event and frame consistency carry the proof.',
  ],
 };
}
