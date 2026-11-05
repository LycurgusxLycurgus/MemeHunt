import {NATIVE_MINT_2022} from '@solana/spl-token';
import {recordedWindowInstructions} from './advisory-window-accounts.js';
import {LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './solana.js';
const tokenPrograms=new Set([LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
const amountForms=new Set(['transfer','transferChecked','mintTo','mintToChecked','burn','burnChecked','approve','approveChecked','revoke','closeAccount','syncNative','initializeAccount','initializeAccount2','initializeAccount3','initializeImmutableOwner','initializeMetadataPointer','initializeMint','initializeMint2','initializeTokenMetadata','updateTokenMetadataAuthority','setAuthority','getAccountDataSize']);
const fail=():never=>{throw new Error('CREATOR_QUOTE_COMMITTED_TRANSFER_UNPROVEN');};
/** Validate the recorded attempted trace against every runtime frame before one terminal truncation.
 * These are candidate positions, not claims that every CPI succeeded. Only conserved transfers may be used. */
export function truncatedQuoteCandidates(tx:any,allowCaughtFailure=false){
 const logs=tx?.meta?.logMessages;if(tx?.meta?.err!==null||!Array.isArray(logs)||logs.filter(x=>x==='Log truncated').length!==1||!allowCaughtFailure&&logs.at(-1)!=='Log truncated')return fail();
 const marker=logs.indexOf('Log truncated');
 const list=recordedWindowInstructions(tx),stack:number[]=[],completeTops=new Set<number>();let cursor=0;
 for(const line of logs.slice(0,marker)){
  if(typeof line!=='string')return fail();
  const invoke=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);
  if(invoke){const s=list[cursor];if(!s||s.depth!==stack.length+1||s.depth!==Number(invoke[2])||s.ix.programId!==invoke[1]||stack.length&&list[stack[0]!]!.top!==s.top)return fail();stack.push(cursor++);continue;}
  const end=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);
  if(end){const position=stack.pop();if(position===undefined||list[position]!.ix.programId!==end[1]||end[2]!=='success'&&(!allowCaughtFailure||!stack.length))return fail();if(!stack.length)completeTops.add(list[position]!.top);continue;}
  if(/^Program \S+ (invoke|success|failed)(?:\b|:)/.test(line)||/log truncated/i.test(line))return fail();
 }
 if(!allowCaughtFailure&&(!stack.length||cursor>=list.length))return fail();
 if(allowCaughtFailure){let suffix=cursor;for(const line of logs.slice(marker+1)){if(typeof line!=='string')return fail();const invoke=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);if(invoke){const next=list.findIndex((s,i)=>i>=suffix&&s.ix.programId===invoke[1]&&s.depth===Number(invoke[2]));if(next<0)return fail();suffix=next+1;}else{const outcome=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);if(outcome&&!list.some(s=>s.ix.programId===outcome[1])||!outcome&&/^Program \S+ (invoke|success|failed)(?:\b|:)/.test(line))return fail();}}}
 return list.map(s=>({...s,executed:true,runtimeCommitted:completeTops.has(s.top)}));
}
/** For every selected leaf transfer, a unique destination credit must equal its committed metadata delta.
 * A failed child or rolled-back parent cannot leave that positive delta. No synthetic runtime logs are built. */
export function proveCommittedQuoteTransfers(tx:any,list:ReturnType<typeof recordedWindowInstructions>,transfers:Iterable<{ix:any;depth:number;top:number}>) {
 const keys=tx.transaction.message.accountKeys;
 const amount=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,19})$/.test(v)||BigInt(v)>2n**64n-1n)return fail();return BigInt(v);};
 for(const step of transfers){
  const i=step.ix.parsed?.info,p=step.ix.parsed;if(!tokenPrograms.has(step.ix.programId)||p?.type!=='transferChecked'||!i||i.source===i.destination||i.mint===NATIVE_MINT_2022.toBase58()||i.mint==='So11111111111111111111111111111111111111112')return fail();
  const position=list.findIndex(s=>s.ix===step.ix);if(position<0||list[position+1]?.top===step.top&&list[position+1]!.depth>step.depth)return fail();
  const destination=i.destination,ai=keys.findIndex((k:any)=>k.pubkey===destination),pre=tx.meta.preTokenBalances?.filter((b:any)=>b.accountIndex===ai),post=tx.meta.postTokenBalances?.filter((b:any)=>b.accountIndex===ai);
  if(ai<0||!Array.isArray(pre)||pre.length>1||!Array.isArray(post)||post.length!==1||!pre.length&&tx.meta.preBalances?.[ai]!==0)return fail();
  if([...pre,...post].some(b=>b.mint!==i.mint||b.programId!==step.ix.programId||b.uiTokenAmount?.decimals!==i.tokenAmount?.decimals))return fail();
  if(amount(post[0].uiTokenAmount.amount)-(pre.length?amount(pre[0].uiTokenAmount.amount):0n)!==amount(i.tokenAmount.amount)||amount(i.tokenAmount.amount)===0n)return fail();
  let credits=0;
  for(const other of list){
   if(!tokenPrograms.has(other.ix.programId))continue;
   const op=other.ix.parsed,info=op?.info;if(!op||!info||!amountForms.has(op.type))return fail();
   if(![info.source,info.destination,info.account].includes(destination))continue;
   if(op.type==='transferChecked'&&info.destination===destination&&info.source!==destination){credits++;if(other.ix!==step.ix)return fail();}
   else if(!['initializeAccount','initializeAccount2','initializeAccount3','initializeImmutableOwner'].includes(op.type)||pre.length)return fail();
  }
  if(credits!==1)return fail();
 }
}
