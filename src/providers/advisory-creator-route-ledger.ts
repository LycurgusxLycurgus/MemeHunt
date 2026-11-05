import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import type {CreatorRoleDecode} from './advisory-creator-role-collector.js';
import type {decodeCreatorQuoteTrade} from './advisory-creator-quote.js';
import {truncatedQuoteCandidates,proveCommittedQuoteTransfers} from './advisory-creator-quote-execution.js';
import {validateNativeCreatorTokenForms} from './advisory-creator-inventory.js';
import {executedWindowInstructions,recordedWindowInstructions} from './advisory-window-accounts.js';
import {LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './solana.js';
const SYSTEM='11111111111111111111111111111111',WSOL='So11111111111111111111111111111111111111112',RAY='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const programs=new Set([LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
const check=(condition:unknown,code='CONSERVATION'):void=>{if(!condition)throw new Error('CREATOR_ROUTE_'+code);};
const same=(a:unknown,b:unknown,code='SOURCE_BINDING')=>check(isDeepStrictEqual(a,b),code);
const atomic=(v:unknown)=>{check(typeof v==='string'&&/^(0|[1-9]\d{0,19})$/.test(v));const n=BigInt(v as string);check(n<=2n**64n-1n);return n;};
const integer=(v:unknown)=>{check(Number.isSafeInteger(v)&&Number(v)>=0);return BigInt(v as number);};
function bytes58(s:string){check(typeof s==='string'&&/^[1-9A-HJ-NP-Za-km-z]{1,6000}$/.test(s),'INSTRUCTION');let n=0n;for(const c of s)n=n*58n+BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));const h=n.toString(16);return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),n===0n?Buffer.alloc(0):Buffer.from(h.length%2?'0'+h:h,'hex')]);}
type Fact={mint:string;owner:string;decimals:number;program:string};
type NativeMove={source:string;destination:string;lamports:bigint;kind:string;position:number};
type TokenMove={source:string;destination:string;mint:string;amount:bigint;authority:string;position:number;top:number;depth:number};
/** Reconcile the observed route family, not arbitrary router intent. Every balance and executed amount writer must agree. */
export function reconcileCreatorRoute(tx:any,h:any,role:CreatorRoleDecode,canonical:string,trade:ReturnType<typeof decodeCreatorQuoteTrade>|null,acquisitionQuoteAccount?:string){
 const wallet=role.binding!.wallet,mint=role.binding!.token.address,quote=role.binding!.creation.quoteMint!;
 check(tx?.meta?.err===null&&h?.signature===tx.transaction.signatures[0]&&h.parserStatus==='OK'&&h.parsed?.transactionStatus==='OK','SOURCE_BINDING');
 const keys:string[]=tx.transaction.message.accountKeys.map((k:any)=>k.pubkey),meta=tx.meta,p=h.parsed,raw=h.rawTransaction;
 check(new Set(keys).size===keys.length&&keys.includes(wallet)&&tx.transaction.message.accountKeys.find((k:any)=>k.pubkey===wallet)?.signer,'SIGNER');
 same(raw?.slot,tx.slot);same(raw?.blockTime,tx.blockTime);same(raw?.version,tx.version);same(raw?.transaction?.signatures,tx.transaction.signatures);same(raw?.transaction?.message?.accountKeys,keys);same(raw?.transaction?.message?.recentBlockhash,tx.transaction.message.recentBlockhash);
 for(const field of ['err','fee','preBalances','postBalances','preTokenBalances','postTokenBalances','logMessages'])same(raw?.meta?.[field],meta[field]);
 same(p.slot,tx.slot);same(p.blockTime,tx.blockTime);same(p.fee,meta.fee);same(p.feePayer,keys[0]);
 check(keys.length===meta.preBalances.length&&keys.length===meta.postBalances.length,'BALANCES');
 let fullRuntime=true,steps:ReturnType<typeof truncatedQuoteCandidates>;
 try{steps=executedWindowInstructions(tx).map(s=>({...s,runtimeCommitted:s.executed}));}catch{check(trade?.side==='BUY'&&trade.execution==='POSITIVE_COMMITTED_TRANSFER_BALANCES_WITH_BOUND_TRUNCATED_TRACE','RUNTIME');steps=truncatedQuoteCandidates(tx);fullRuntime=false;}
 const original=recordedWindowInstructions(tx);check(Array.isArray(p.instructions)&&p.instructions.length===original.length,'INSTRUCTION_CATALOG');
 const rawGroups=new Map<number,any[]>((raw.meta.innerInstructions??[]).map((g:any)=>[g.index,g.instructions]));
 for(const [i,s]of original.entries()){
  const hp=p.instructions[i];same(hp.programId,s.ix.programId);same(hp.instructionIndex,s.top);same(hp.stackHeight,s.depth);
  const children=original.filter(x=>x.top===s.top&&x.depth>1),inner=s.depth===1?null:children.indexOf(s);same(hp.innerInstructionIndex,inner);
  if(s.ix.data)same(hp.rawData,s.ix.data);if(s.ix.accounts)same(hp.rawAccounts,s.ix.accounts);
  const compiled=s.depth===1?raw.transaction.message.instructions[s.top]:rawGroups.get(s.top)?.[inner!];
  check(compiled,'RAW_INSTRUCTION');same(keys[compiled.programIdIndex],s.ix.programId);same(compiled.accounts.map((a:number)=>keys[a]),hp.rawAccounts);same(compiled.data,hp.rawData);
 }
 validateNativeCreatorTokenForms(tx);
 if(!fullRuntime){
  // Amounts in an unobserved child frame need their own committed witness; never mark the frame successful.
  proveCommittedQuoteTransfers(tx,steps,steps.filter(s=>programs.has(s.ix.programId)&&s.ix.parsed?.type==='transferChecked'&&!s.runtimeCommitted));
 }
 const native=new Map<string,bigint>(keys.map((k,i)=>[k,integer(meta.preBalances[i])])),postNative=new Map<string,bigint>(keys.map((k,i)=>[k,integer(meta.postBalances[i])])),facts=new Map<string,Fact>(),before=new Map<string,bigint>(),after=new Map<string,bigint>();
 function fact(account:string,m:string,owner:string,decimals:number,program:string){check(keys.includes(account)&&typeof owner==='string'&&Number.isSafeInteger(decimals)&&decimals>=0&&decimals<=255&&programs.has(program),'TOKEN_IDENTITY');const f={mint:m,owner,decimals,program};if(facts.has(account))same(facts.get(account),f,'TOKEN_IDENTITY');else facts.set(account,f);}
 for(const [field,store]of [['preTokenBalances',before],['postTokenBalances',after]] as const){
  check(Array.isArray(meta[field]),'TOKEN_BALANCES');for(const b of meta[field]){const a=keys[b.accountIndex];check(a&&!store.has(a),'TOKEN_BALANCES');store.set(a!,atomic(b.uiTokenAmount?.amount));fact(a!,b.mint,b.owner,b.uiTokenAmount.decimals,b.programId);}
 }
 const units=new Map(before),nativeRent=new Map<string,bigint>(),moves:NativeMove[]=[],transfers:TokenMove[]=[],mints:Array<{destination:string;mint:string;amount:bigint}>=[],funding:Array<{account:string;lamports:bigint}>=[],closures:Array<{account:string;mint:string;owner:string;destination:string;lamports:bigint;tokenAtomic:bigint}>=[];
 for(const a of facts.keys())if(!units.has(a))units.set(a,0n);
 function move(source:string,destination:string,amount:bigint,kind:string,position:number){check(source!==destination&&native.has(source)&&native.has(destination)&&native.get(source)!>=amount);native.set(source,native.get(source)!-amount);native.set(destination,native.get(destination)!+amount);moves.push({source,destination,lamports:amount,kind,position});}
 const fee=integer(meta.fee),directFee=keys[0]===wallet?fee:0n;check(native.get(keys[0]!)!>=fee);native.set(keys[0]!,native.get(keys[0]!)!-fee);
 for(const [position,s]of steps.entries()){
  if(fullRuntime&&!s.executed)continue;const ix=s.ix,op=ix.parsed,info=op?.info;
  if(ix.programId===SYSTEM){
   check(op&&info,'SYSTEM_FORM');
   if(['transfer','createAccount','createAccountWithSeed'].includes(op.type)){
    const destination=op.type==='transfer'?info.destination:info.newAccount,amount=integer(info.lamports);
    if(!fullRuntime&&!s.runtimeCommitted&&s.depth>1){
     const credits=steps.filter(t=>t.ix.programId===SYSTEM&&['transfer','createAccount','createAccountWithSeed'].includes(t.ix.parsed?.type)&&[t.ix.parsed.info.destination,t.ix.parsed.info.newAccount].includes(destination));
     check(credits.length===1&&!steps.some(t=>t.ix.programId===SYSTEM&&t.ix.parsed?.info?.source===destination)&&postNative.get(destination)!-integer(meta.preBalances[keys.indexOf(destination)])===amount,'COMMITTED_NATIVE_CREDIT');
    }
    move(info.source,destination,amount,op.type,position);if(op.type.startsWith('createAccount')&&info.source===wallet)funding.push({account:destination,lamports:amount});
   }else check(['allocate','assign','allocateWithSeed','assignWithSeed'].includes(op.type),'SYSTEM_FORM');
  }
  if(!programs.has(ix.programId))continue;check(op&&info,'TOKEN_FORM');
  if(['initializeAccount','initializeAccount2','initializeAccount3'].includes(op.type)){
   const known=facts.get(info.account);check(known||info.mint===WSOL,'TOKEN_IDENTITY');fact(info.account,info.mint,info.owner,known?.decimals??9,ix.programId);check(!before.has(info.account),'REINITIALIZATION');units.set(info.account,0n);
   if(acquisitionQuoteAccount&&info.mint===WSOL){check(info.owner===wallet,'WRAP_OWNER');nativeRent.set(info.account,native.get(info.account)!);}
  }else if(acquisitionQuoteAccount&&op.type==='syncNative'){
   const rent=nativeRent.get(info.account);check(rent!==undefined&&facts.get(info.account)?.mint===WSOL&&native.get(info.account)!>=rent,'WRAP_IDENTITY');units.set(info.account,native.get(info.account)!-rent!);
  }else if(op.type==='transferChecked'){
   const amount=atomic(info.tokenAmount.amount);for(const a of [info.source,info.destination]){const f=facts.get(a);check(f&&f.mint===info.mint&&f.program===ix.programId&&f.decimals===info.tokenAmount.decimals,'TRANSFER_IDENTITY');}
   check(info.source!==info.destination&&units.get(info.source)!>=amount);units.set(info.source,units.get(info.source)!-amount);units.set(info.destination,(units.get(info.destination)??0n)+amount);
   transfers.push({source:info.source,destination:info.destination,mint:info.mint,amount,authority:info.authority,position,top:s.top,depth:s.depth});if(info.mint===WSOL)move(info.source,info.destination,amount,'WSOL_TRANSFER',position);
  }else if(['mintTo','mintToChecked'].includes(op.type)){
   check(facts.get(info.account)?.mint===info.mint,'MINT_IDENTITY');const amount=atomic(info.amount??info.tokenAmount?.amount);units.set(info.account,(units.get(info.account)??0n)+amount);mints.push({destination:info.account,mint:info.mint,amount});
  }else if(op.type==='closeAccount'){
   const f=facts.get(info.account);check(f,'CLOSE_IDENTITY');check(f!.owner===info.owner,'CLOSE_AUTHORITY');if(f!.mint!==WSOL)check(units.get(info.account)===0n,'NONZERO_CLOSE');
   const amount=native.get(info.account)!;move(info.account,info.destination,amount,'TOKEN_CLOSE',position);closures.push({account:info.account,mint:f!.mint,owner:info.owner,destination:info.destination,lamports:amount,tokenAtomic:units.get(info.account)??0n});units.set(info.account,0n);check(postNative.get(info.account)===0n,'CLOSE_BALANCE');
  }else if(op.type==='setAuthority')check(info.authorityType==='mintTokens'&&info.mint===mint&&info.newAuthority===null,'AUTHORITY');
  else check(['initializeMint','initializeMint2','initializeImmutableOwner','initializeMetadataPointer','initializeTokenMetadata','updateTokenMetadataAuthority','getAccountDataSize'].includes(op.type),'TOKEN_FORM');
 }
 for(const [a,n]of native)check(n===postNative.get(a),'NATIVE_CONSERVATION');for(const a of facts.keys())check((units.get(a)??0n)===(after.get(a)??0n),'TOKEN_CONSERVATION');
 check(Array.isArray(p.nativeTransfers)&&Array.isArray(p.tokenTransfers),'PROVIDER_TRANSFERS');
 const walletDelta=postNative.get(wallet)!-integer(meta.preBalances[keys.indexOf(wallet)]);
 check(p.nativeTransfers.reduce((n:bigint,t:any)=>n+(t.toUserAccount===wallet?integer(t.amount):0n)-(t.fromUserAccount===wallet?integer(t.amount):0n),0n)-directFee===walletDelta,'PROVIDER_NATIVE');
 const providerTokens=[...p.tokenTransfers];for(const t of transfers){const i=providerTokens.findIndex((v:any)=>v.fromTokenAccount===t.source&&v.toTokenAccount===t.destination&&v.mint===t.mint&&integer(v.rawTokenAmount)===t.amount&&v.decimals===facts.get(t.source)!.decimals);check(i>=0,'PROVIDER_TOKEN');providerTokens.splice(i,1);}for(const m of mints){const i=providerTokens.findIndex((v:any)=>v.fromTokenAccount===null&&v.toTokenAccount===m.destination&&v.mint===m.mint&&integer(v.rawTokenAmount)===m.amount&&v.decimals===facts.get(m.destination)!.decimals);check(i>=0,'PROVIDER_MINT');providerTokens.splice(i,1);}check(!providerTokens.length,'PROVIDER_TOKEN');
 const directOut=moves.filter(x=>x.source===wallet&&x.kind==='transfer'),refunds=closures.filter(x=>x.destination===wallet),sum=(rows:Array<{lamports:bigint}>)=>rows.reduce((n,x)=>n+x.lamports,0n),payments=sum(directOut);
 const capitalIn=acquisitionQuoteAccount?sum(moves.filter(x=>x.destination===wallet&&x.kind==='transfer')):0n;
 check(sum(refunds)+capitalIn-sum(funding)-payments-directFee===walletDelta,'WALLET_CONSERVATION');
 const delta=(asset:string)=>[...facts].filter(([,f])=>f.owner===wallet&&f.mint===asset).reduce((n,[a])=>n+(after.get(a)??0n)-(before.get(a)??0n),0n);
 let settlement:null|{path:string[];legs:Array<{program:string;pool:string;inputMint:string;inputAtomic:string;outputMint:string;outputAtomic:string}>;grossSolLamports:string;temporaryRentLamports:string}=null;
 let acquisition:null|{quoteAccount:string;quoteAtomic:string;inputSolLamports:string;capitalInLamports:string;temporaryRentReturnedLamports:string;legs:Array<{program:string;pool:string;inputMint:string;inputAtomic:string;outputMint:string;outputAtomic:string}>}=null;
 if(trade?.side==='SELL'||acquisitionQuoteAccount){
  const frames=steps.map((s,position)=>({...s,position})).filter(s=>s.executed&&s.ix.programId===RAY);check(frames.length>0,'ROUTE_UNSUPPORTED');
  const legs=frames.map(s=>{
   const a=s.ix.accounts,buf=bytes58(s.ix.data),discriminator=createHash('sha256').update('global:swap_v2').digest().subarray(0,8);
   check(buf.length===41&&buf.subarray(0,8).equals(discriminator)&&buf[40]===1&&a?.length>=13,'RAYDIUM_FORM');
   const hp=p.instructions[s.position];same(hp.rawAccounts,a);check(hp.instructionName==='swap_v2'&&hp.decoded?.args?.is_base_input===true,'RAYDIUM_FORM');same(hp.decoded.args.amount,buf.readBigUInt64LE(8).toString());
   check(a[0]===wallet&&a[8]===LEGACY_TOKEN_PROGRAM&&a[9]===TOKEN_2022_PROGRAM,'RAYDIUM_IDENTITY');
   const next=steps.findIndex((v,i)=>i>s.position&&(v.top!==s.top||v.depth<=s.depth)),children=transfers.filter(t=>t.top===s.top&&t.position>s.position&&(next<0||t.position<next));
   check(children.length===2,'RAYDIUM_TRANSFERS');const input=children.find(t=>t.source===a[3]&&t.destination===a[5]),output=children.find(t=>t.source===a[6]&&t.destination===a[4]);
   check(input&&output&&input.mint===a[11]&&output.mint===a[12]&&input.amount===buf.readBigUInt64LE(8)&&input.authority===wallet&&output.authority===a[2],'RAYDIUM_TRANSFERS');
   check(facts.get(a[3])?.owner===wallet&&facts.get(a[4])?.owner===wallet&&facts.get(a[5])?.owner===a[2]&&facts.get(a[6])?.owner===a[2],'RAYDIUM_IDENTITY');
   check(output!.amount>=buf.readBigUInt64LE(16),'RAYDIUM_SLIPPAGE');
   return{program:RAY,pool:a[2] as string,inputMint:input!.mint,inputAtomic:String(input!.amount),outputMint:output!.mint,outputAtomic:String(output!.amount),inputAccount:input!.source,outputAccount:output!.destination};
  });
  if(acquisitionQuoteAccount){
   check(!trade&&fullRuntime&&legs[0]!.inputMint===WSOL&&legs.at(-1)!.outputMint===quote&&legs.at(-1)!.outputAccount===acquisitionQuoteAccount,'ACQUISITION_ROUTE');
   check(before.get(acquisitionQuoteAccount)===0n&&delta(quote)===atomic(legs.at(-1)!.outputAtomic)&&after.get(acquisitionQuoteAccount)===delta(quote)&&delta(quote)>0n,'ACQUISITION_QUOTE');
  }else check(legs[0]!.inputMint===quote&&legs[0]!.inputAtomic===trade!.quote.userAtomic&&legs.at(-1)!.outputMint===WSOL,'ROUTE_CHAIN');
  for(const [i,l]of legs.entries()){check(delta(l.inputMint)===0n,'ROUTE_RESIDUAL');if(i)check(l.inputMint===legs[i-1]!.outputMint&&l.inputAtomic===legs[i-1]!.outputAtomic&&l.inputAccount===legs[i-1]!.outputAccount,'ROUTE_CHAIN');}
  if(acquisitionQuoteAccount){
   const first=legs[0]!,c=closures.find(x=>x.account===first.inputAccount),fund=funding.find(x=>x.account===first.inputAccount);
   check(c&&fund&&c.owner===wallet&&c.destination===wallet&&c.tokenAtomic===0n&&c.lamports===fund.lamports&&sum(funding)===fund.lamports&&closures.length===1&&mints.length===0,'ACQUISITION_WRAP');
   acquisition={quoteAccount:acquisitionQuoteAccount,quoteAtomic:legs.at(-1)!.outputAtomic,inputSolLamports:first.inputAtomic,capitalInLamports:String(capitalIn),temporaryRentReturnedLamports:String(fund!.lamports),legs:legs.map(({inputAccount,outputAccount,...l})=>l)};
  }else{
   const last=legs.at(-1)!,c=closures.find(x=>x.account===last.outputAccount),fund=funding.find(x=>x.account===last.outputAccount),gross=atomic(last.outputAtomic);
   check(c&&fund&&c.owner===wallet&&c.destination===wallet&&c.tokenAtomic===gross&&c.lamports===gross+fund.lamports&&sum(funding)===fund.lamports&&walletDelta===gross-payments-directFee,'WSOL_SETTLEMENT');
   settlement={path:[mint,quote,...legs.map(l=>l.outputMint),'SOL'],legs:legs.map(({inputAccount,outputAccount,...l})=>l),grossSolLamports:String(gross),temporaryRentLamports:String(fund!.lamports)};
  }
 }else if(!trade){check(fullRuntime&&closures.some(c=>c.account===canonical)&&closures.every(c=>c.tokenAtomic===0n),'CLOSE_SCOPE');}
 else check(trade.side==='BUY'&&delta(quote)===BigInt(trade.quote.transactionNetAtomic)&&-delta(quote)>=BigInt(trade.quote.userAtomic),'BUY_QUOTE');
 return{signature:tx.transaction.signatures[0] as string,slot:tx.slot as number,side:acquisitionQuoteAccount?'QUOTE_ACQUISITION' as const:trade?.side??'CLOSE' as const,executionBasis:fullRuntime?'COMPLETE_SUCCESSFUL_RUNTIME':trade!.execution,nativeAccountsReconciled:native.size,tokenAccountsReconciled:facts.size,
  targetAtomic:trade?.base.unitsAtomic??'0',pumpQuoteAtomic:trade?.quote.userAtomic??'0',quoteMint:quote,quoteDecimals:trade?.quote.decimals??null,extraQuoteOutAtomic:trade?.side==='BUY'?String(-delta(quote)-BigInt(trade.quote.userAtomic)):'0',walletNativeDeltaLamports:String(walletDelta),networkFeePayer:keys[0]!,networkFeeLamports:String(fee),creatorNetworkFeeLamports:String(directFee),directNativePaymentsLamports:String(payments),directNativePayments:directOut.map(x=>({destination:x.destination,lamports:String(x.lamports)})),
  funding:funding.map(x=>({account:x.account,lamports:String(x.lamports),allocation:settlement?'TEMPORARY_RENT_RETURNED':'UNALLOCATED_FUNDING'})),refunds:refunds.map(x=>({account:x.account,mint:x.mint,lamports:String(x.lamports),allocation:settlement?'WSOL_PLUS_TEMPORARY_RENT':x.account===canonical?'TARGET_ACCOUNT_RENT_REFUND':'SHARED_OR_OTHER_ACCOUNT_REFUND'})),settlement,...(acquisitionQuoteAccount?{acquisition}: {})};
}
