import {isDeepStrictEqual as same} from 'node:util';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {projectCompiledTransaction} from './advisory-demand-windows.js';
import {runtimeWindowSteps,type ProofStep} from './advisory-runtime-proof.js';
import {executedWindowInstructions,recordedWindowInstructions} from './advisory-window-accounts.js';
import {encodeSolanaAddress} from './solana.js';

export const INVENTORY_RETURN_RUNTIME_METHOD='o26-endpoint-runtime-v1' as const;
/** Exact source ABI, not deployed binary attestation. Original O23 and old account views remain frozen. */
export const INVENTORY_RETURN_RUNTIME_SOURCES={token:'@solana/spl-token/0.4.14',metadata:'@solana/spl-token-metadata/0.1.6',system:'@solana/web3.js/1.98.4',ataInterfaceGitBlob:'622ba02ad99f5eafa535847abde8dcd03ff5128d',ataProcessorGitBlob:'3d23835a3c1d3416908a1fb438304ae694acdb6d'} as const;
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string):never{throw Error('O26_RUNTIME_'+code);}
const check=(v:unknown,code:string):void=>{if(!v)fail(code);};
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const address=(b:Buffer)=>new PublicKey(b).toBase58();
function raw58(text:unknown):Buffer {
    if (typeof text !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]*$/.test(text))
        return fail('COMPANION_INSTRUCTION');
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const c of text)
        n = n * 58n + BigInt(alphabet.indexOf(c));
    const hex = n.toString(16);
    return Buffer.concat([Buffer.alloc(text.match(/^1*/)?.[0].length ?? 0), n === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex')]);
}
/** Closed native-parser/compiled-ABI equivalence; unknown parsed instructions are never omitted. */
function nativeInstructionMatches(native:any, compiled:any, keyFlags:any[]):boolean {
    if (!obj(native) || !obj(compiled) || native.programId !== compiled.programId || (native.stackHeight ?? null) !== (compiled.stackHeight ?? null))
        return false;
    if (!Object.hasOwn(native, 'parsed'))
        return same(native.accounts, compiled.accounts) && native.data === compiled.data;
    const a = compiled.accounts, b = raw58(compiled.data), parsed = native.parsed;
    if (!Array.isArray(a))
        return false;
    if (compiled.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
        return typeof parsed === 'string' && Buffer.from(parsed, 'utf8').equals(b) && a.every((k:string) => keyFlags.some(f => f.pubkey === k && f.signer === true));
    if (!obj(parsed) || !obj(parsed.info) || typeof parsed.type !== 'string')
        return false;
    const t = parsed.type, i = parsed.info;
    const only = (x:object) => same(i, x), u64 = (offset:number) => b.readBigUInt64LE(offset).toString();
    if (compiled.programId === '11111111111111111111111111111111') {
        if (b.length === 12 && b.readUInt32LE(0) === 2 && a.length >= 2 && t === 'transfer')
            return only({ source: a[0], destination: a[1], lamports: Number(b.readBigUInt64LE(4)) }) && Number.isSafeInteger(i.lamports);
        if (b.length === 52 && b.readUInt32LE(0) === 0 && a.length === 2 && t === 'createAccount')
            return only({ source: a[0], newAccount: a[1], lamports: Number(b.readBigUInt64LE(4)), space: Number(b.readBigUInt64LE(12)), owner: encodeSolanaAddress(b.subarray(20)) }) && Number.isSafeInteger(i.lamports) && Number.isSafeInteger(i.space);
        return false;
    }
    if (compiled.programId === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
        return b.length === 1 && b[0] === 1 && a.length === 6 && t === 'createIdempotent' && only({ source: a[0], account: a[1], wallet: a[2], mint: a[3], systemProgram: a[4], tokenProgram: a[5] });
    if (!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(compiled.programId))
        return false;
    if (b.length === 10 && b[0] === 12 && a.length >= 4 && t === 'transferChecked') {
        if (!obj(i.tokenAmount) || !same(Object.keys(i.tokenAmount).sort(), ['amount', 'decimals', 'uiAmount', 'uiAmountString']))
            return false;
        const amount = u64(1), decimals = b[9]!, digits = amount.padStart(decimals + 1, '0'), ui = decimals ? (digits.slice(0, -decimals) + '.' + digits.slice(-decimals)).replace(/\.?0+$/, '') || '0' : amount;
        if (i.tokenAmount.amount !== amount || i.tokenAmount.decimals !== decimals || i.tokenAmount.uiAmountString !== ui || !(i.tokenAmount.uiAmount === null || typeof i.tokenAmount.uiAmount === 'number' && Number.isFinite(i.tokenAmount.uiAmount) && i.tokenAmount.uiAmount === Number(amount) / 10 ** decimals))
            return false;
        return only({ source: a[0], mint: a[1], destination: a[2], ...(a.length === 4 ? { authority: a[3] } : { multisigAuthority: a[3], signers: a.slice(4) }), tokenAmount: i.tokenAmount });
    }
    if (b.length === 9 && b[0] === 3 && a.length === 3 && t === 'transfer')
        return only({ source: a[0], destination: a[1], authority: a[2], amount: u64(1) });
    if (b.length === 1 && b[0] === 9 && a.length === 3 && t === 'closeAccount')
        return only({ account: a[0], destination: a[1], owner: a[2] });
    if (b.length === 1 && b[0] === 17 && a.length === 1 && t === 'syncNative' || b.length === 1 && b[0] === 22 && a.length === 1 && t === 'initializeImmutableOwner')
        return only({ account: a[0] });
    if (b.length === 33 && b[0] === 18 && a.length === 2 && t === 'initializeAccount3')
        return only({ account: a[0], mint: a[1], owner: encodeSolanaAddress(b.subarray(1)) });
    if (b.length === 3 && b[0] === 21 && b.readUInt16LE(1) === 7 && a.length === 1 && t === 'getAccountDataSize')
        return only({ mint: a[0], extensionTypes: ['immutableOwner'] });
    return false;
}

function nativeInstructionMatchesO26(native:any,compiled:any,flags:any[]):boolean{
 if(nativeInstructionMatches(native,compiled,flags))return true;
 if(native.programId!==compiled.programId||(native.stackHeight??null)!==(compiled.stackHeight??null)||!native.parsed||typeof native.parsed!=='object'||!native.parsed.info)return false;
 const a=compiled.accounts,b=raw58(compiled.data),t=native.parsed.type,i=native.parsed.info,only=(x:object)=>same(i,x),u64=(o:number)=>b.readBigUInt64LE(o).toString();
 const mutable: number[]|undefined=({create:[0,1],mintTo:[0,1],burn:[0,1],transfer:[0,1],initializeMetadataPointer:[0],initializeMint2:[0],initializeTokenMetadata:[0],updateTokenMetadataAuthority:[0],setAuthority:[0],allocate:[0],assign:[0],createAccountWithSeed:[0,1],initializeAccount:[0]} as Record<string,number[]>)[t];if(!mutable||mutable.some(index=>!flags.some((f:any)=>f.pubkey===a[index]&&f.writable===true)))return false;
 if(compiled.programId==='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')return b.length===1&&b[0]===0&&a.length===6&&t==='create'&&a[4]==='11111111111111111111111111111111'&&['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(a[5])&&PublicKey.findProgramAddressSync([new PublicKey(a[2]).toBuffer(),new PublicKey(a[5]).toBuffer(),new PublicKey(a[3]).toBuffer()],new PublicKey(compiled.programId))[0].toBase58()===a[1]&&only({source:a[0],account:a[1],wallet:a[2],mint:a[3],systemProgram:a[4],tokenProgram:a[5]});
 if(compiled.programId==='11111111111111111111111111111111'){
  if(b.length===12&&b.readUInt32LE(0)===8&&a.length===1&&t==='allocate')return Number.isSafeInteger(Number(b.readBigUInt64LE(4)))&&only({account:a[0],space:Number(b.readBigUInt64LE(4))});
  if(b.length===36&&b.readUInt32LE(0)===1&&a.length===1&&t==='assign')return only({account:a[0],owner:address(b.subarray(4))});
  if(b.length>=92&&b.readUInt32LE(0)===3&&a.length===2&&t==='createAccountWithSeed'){
   const base=address(b.subarray(4,36)),length=b.readBigUInt64LE(36);if(length>32n)return false;const n=Number(length),offset=44+n;if(offset+48!==b.length)return false;const seedBytes=b.subarray(44,offset);let seed;try{seed=new TextDecoder('utf8',{fatal:true}).decode(seedBytes);}catch{return false;}if(!Buffer.from(seed).equals(seedBytes))return false;const lamports=Number(b.readBigUInt64LE(offset)),space=Number(b.readBigUInt64LE(offset+8)),owner=address(b.subarray(offset+16));const derived=address(createHash('sha256').update(Buffer.concat([new PublicKey(base).toBuffer(),seedBytes,new PublicKey(owner).toBuffer()])).digest());return base===a[0]&&derived===a[1]&&Number.isSafeInteger(lamports)&&Number.isSafeInteger(space)&&only({source:a[0],newAccount:a[1],base,seed,lamports,space,owner});
  }return false;
 }
 if(!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(compiled.programId))return false;
 if(b.length===9&&b[0]===3&&a.length>=4&&t==='transfer')return only({source:a[0],destination:a[1],multisigAuthority:a[2],signers:a.slice(3),amount:u64(1)});
 if(b.length===9&&b[0]===7&&a.length===3&&t==='mintTo')return only({mint:a[0],account:a[1],mintAuthority:a[2],amount:u64(1)});
 if(b.length===9&&b[0]===8&&a.length===3&&t==='burn')return only({account:a[0],mint:a[1],authority:a[2],amount:u64(1)});
 if(b.length===1&&b[0]===1&&a.length===4&&t==='initializeAccount')return only({account:a[0],mint:a[1],owner:a[2],rentSysvar:a[3]});
 if(compiled.programId!=='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')return false;
 if(b.length===35&&b[0]===6&&b[1]===3&&b[2]===1&&a.length===2&&t==='setAuthority')return only({account:a[0],authority:a[1],authorityType:'closeAccount',newAuthority:address(b.subarray(3))});
 if(b.length===35&&b[0]===20&&b[34]===0&&a.length===1&&t==='initializeMint2')return only({mint:a[0],decimals:b[1],mintAuthority:address(b.subarray(2,34))});
 if(b.length===66&&b[0]===39&&b[1]===0&&a.length===1&&t==='initializeMetadataPointer'&&b.subarray(2,34).equals(Buffer.alloc(32)))return only({mint:a[0],metadataAddress:address(b.subarray(34))});
 if(b.length===3&&b[0]===6&&b[1]===0&&b[2]===0&&a.length===2&&t==='setAuthority')return only({mint:a[0],authority:a[1],authorityType:'mintTokens',newAuthority:null});
 if(b.length===40&&b.subarray(0,8).toString('hex')==='d7e4a6e45464567b'&&b.subarray(8).equals(Buffer.alloc(32))&&a.length===2&&t==='updateTokenMetadataAuthority')return only({metadata:a[0],updateAuthority:a[1],newAuthority:null});
 if(b.subarray(0,8).toString('hex')==='d2e11ea258b84d8d'&&a.length===4&&t==='initializeTokenMetadata'){
  let offset=8;const text=():string=>{if(offset+4>b.length)throw Error('BOUNDS');const n=b.readUInt32LE(offset);offset+=4;if(n>4096||offset+n>b.length)throw Error('BOUNDS');const buf=b.subarray(offset,offset+n);offset+=n;const s=new TextDecoder('utf8',{fatal:true}).decode(buf);if(!Buffer.from(s).equals(buf))throw Error('UTF8');return s;};try{const name=text(),symbol=text(),uri=text();return offset===b.length&&only({metadata:a[0],updateAuthority:a[1],mint:a[2],mintAuthority:a[3],name,symbol,uri});}catch{return false;}
 }
 return false;
}

export type InventoryReturnExecutionContext={expected:{signature:string;slot:number;blockTime:number;transactionIndex:number};nativeSourceAt:string;compiledSourceAt?:string;cutoff:string;endpoints:ReadonlySet<string>};
export type InventoryReturnStep=ProofStep&{order:number;compiledIx?:any;references:string[];criticalAccounts:string[];lifecycleAccounts:string[]};
export type InventoryReturnExecution={list:InventoryReturnStep[];mode:'STRICT_NATIVE'|'NATIVE_PREFIX'|'COMPILED_RECOVERY';logged:number;truncated:boolean};
const TOKEN=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']),SYSTEM='11111111111111111111111111111111';
const SUBJECTS=['account','source','destination','newAccount','mint','owner','authority','multisigAuthority','wallet','delegate','newAuthority','metadata','metadataAddress','updateAuthority','mintAuthority','freezeAuthority','base'];
function references(ix:any):string[]{const out=new Set<string>();if(Array.isArray(ix.accounts))for(const a of ix.accounts)if(typeof a==='string')out.add(a);const i=ix.parsed?.info;if(obj(i)){for(const field of SUBJECTS)if(typeof i[field]==='string')out.add(i[field]);for(const field of ['signers','sourceAccounts'])if(Array.isArray(i[field]))for(const a of i[field])if(typeof a==='string')out.add(a);}return[...out];}
/** Source-only exact whole-transaction equivalence; never a claim that compiled bytes imply execution. */
export function assertInventoryReturnCompanionParity(native:any,compiled:any):any{
 const projected=projectCompiledTransaction(compiled);check(obj(native)&&obj(native.meta)&&obj(native.transaction)&&obj(native.transaction.message),'NATIVE_SHAPE');
 for(const k of ['slot','blockTime','version'])check(same(native[k],compiled[k]),'COMPANION_PARITY');
 check(native.meta.err===null&&compiled.meta.err===null&&same(native.transaction.signatures,compiled.transaction.signatures),'COMPANION_PARITY');
 const message=native.transaction.message,cm=compiled.transaction.message,keys=message.accountKeys,loaded=compiled.meta.loadedAddresses;
 check(same(keys,projected.transaction.message.accountKeys)&&same(message.recentBlockhash,cm.recentBlockhash)&&same(message.transactionConfig,cm.transactionConfig),'COMPANION_KEYS');
 if(compiled.version===0){const statics=cm.accountKeys.length;check(same(message.addressTableLookups,cm.addressTableLookups)&&same(keys.slice(statics,statics+loaded.writable.length).map((k:any)=>k.pubkey),loaded.writable)&&same(keys.slice(statics+loaded.writable.length).map((k:any)=>k.pubkey),loaded.readonly)&&keys.slice(statics).every((k:any,i:number)=>k.source==='lookupTable'&&k.signer===false&&k.writable===(i<loaded.writable.length)),'COMPANION_LOOKUPS');}
 else check(message.addressTableLookups===undefined||Array.isArray(message.addressTableLookups)&&message.addressTableLookups.length===0,'COMPANION_LOOKUPS');
 const nativeLoaded=native.meta.loadedAddresses;if(nativeLoaded!==undefined&&nativeLoaded!==null&&!same(nativeLoaded,{writable:[],readonly:[]}))check(same(nativeLoaded,loaded),'COMPANION_LOADED_ADDRESSES');
 const metadata=(v:any)=>{const{innerInstructions,loadedAddresses,...rest}=v;return rest;};check(same(metadata(native.meta),metadata(compiled.meta)),'COMPANION_METADATA');
 const n=recordedWindowInstructions(native),p=recordedWindowInstructions(projected);check(n.length===p.length,'COMPANION_TREE');for(const[i,s]of n.entries()){const other=p[i]!;check(s.top===other.top&&s.depth===other.depth&&nativeInstructionMatchesO26(s.ix,other.ix,keys),'COMPANION_INSTRUCTION');}
 return projected;
}
function shaped(list:ReturnType<typeof recordedWindowInstructions>):ProofStep[]{const out:ProofStep[]=[],stack:number[]=[];let position=-1;for(const[order,s]of list.entries()){position=s.depth===1?-1:position+1;stack.length=s.depth-1;const parent=s.depth===1?-1:stack[s.depth-2];check(parent!==undefined,'PARENT');out.push({...s,parent:parent!,position,proof:s.executed?'LOGGED_SUCCESS':'ROLLED_BACK'});stack[s.depth-1]=order;}return out;}
/** Native prefix records only actual closed outcomes. No SBF/native success is inferred here. */
function nativePrefix(value:any):{list:ProofStep[];logged:number;truncated:boolean}{
 const list=shaped(recordedWindowInstructions(value)),logs=value.meta.logMessages;check(Array.isArray(logs)&&logs.every((x:unknown)=>typeof x==='string'),'LOG');const marker=logs.indexOf('Log truncated');check(marker>=0&&logs.indexOf('Log truncated',marker+1)<0,'LOG');const stack:number[]=[],outcome:Array<boolean|undefined>=[];let cursor=0;
 for(const line of logs.slice(0,marker) as string[]){let m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);if(m){const s=list[cursor];check(s&&s.ix.programId===m[1]&&s.depth===Number(m[2])&&s.depth===stack.length+1&&s.parent===(stack.at(-1)??-1),'PREFIX_BINDING');stack.push(cursor++);continue;}m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);if(m){const at=stack.pop();check(at!==undefined&&list[at]!.ix.programId===m[1],'PREFIX_BINDING');outcome[at!]=m[2]==='success';check(list[at!]!.parent>=0||outcome[at!]===true,'PREFIX_BINDING');continue;}check(!/^Program \S+ (invoke|success|failed)(?:\b|:)/.test(line)&&!/log truncated/i.test(line),'PREFIX_LOG');}
 const next=list[cursor];if(next&&next.depth>1)check(next.depth<=stack.length+1&&next.parent===stack[next.depth-2],'PREFIX_BINDING');
 for(const[i,s]of list.entries()){const parent=s.parent<0?null:list[s.parent]!;s.proof=parent?.proof==='ROLLED_BACK'||outcome[i]===false?'ROLLED_BACK':parent?.proof==='UNKNOWN'?'UNKNOWN':outcome[i]===true?'LOGGED_SUCCESS':'UNKNOWN';s.executed=s.proof==='LOGGED_SUCCESS';}
 return{list,logged:cursor,truncated:true};
}
function decorate(proof:{list:ProofStep[];logged:number;truncated:boolean},native:any,projected:any|undefined,endpoints:ReadonlySet<string>,mode:InventoryReturnExecution['mode']):InventoryReturnExecution{
 const original=recordedWindowInstructions(native),compiled=projected?recordedWindowInstructions(projected):undefined;check(original.length===proof.list.length,'TREE');const list=proof.list.map((s,order)=>{const ix=original[order]!.ix,raw=compiled?.[order]?.ix,refs=[...new Set([...references(ix),...(raw?references(raw):[])])],watched=refs.filter(k=>endpoints.has(k));return{...s,ix,order,...(raw?{compiledIx:raw}:{}),references:refs,criticalAccounts:TOKEN.has(ix.programId)?watched:[],lifecycleAccounts:ix.programId===SYSTEM?watched:[]};});return{...proof,list,mode};
}
function systemShape(step:InventoryReturnStep):boolean{
 const p=step.ix.parsed,i=p?.info;if(!obj(i))return false;const exact=(x:object)=>same(i,x),raw=step.compiledIx;
 if(p.type==='transfer')return same(Object.keys(i).sort(),['destination','lamports','source'])&&typeof i.source==='string'&&typeof i.destination==='string'&&integer(i.lamports)&&(!raw||raw.accounts.length>=2&&raw.accounts[0]===i.source&&raw.accounts[1]===i.destination&&raw58(raw.data).length===12&&raw58(raw.data).readUInt32LE(0)===2&&Number(raw58(raw.data).readBigUInt64LE(4))===i.lamports);
 if(p.type==='createAccount')return typeof i.source==='string'&&typeof i.newAccount==='string'&&typeof i.owner==='string'&&integer(i.lamports)&&integer(i.space)&&exact({source:i.source,newAccount:i.newAccount,owner:i.owner,lamports:i.lamports,space:i.space});
 if(p.type==='allocate')return typeof i.account==='string'&&integer(i.space)&&exact({account:i.account,space:i.space});
 if(p.type==='assign')return typeof i.account==='string'&&typeof i.owner==='string'&&exact({account:i.account,owner:i.owner});
 if(p.type==='createAccountWithSeed')return typeof i.base==='string'&&typeof i.seed==='string'&&typeof i.source==='string'&&typeof i.newAccount==='string'&&typeof i.owner==='string'&&integer(i.lamports)&&integer(i.space)&&exact({base:i.base,seed:i.seed,source:i.source,newAccount:i.newAccount,owner:i.owner,lamports:i.lamports,space:i.space});
 return false;
}
/** Endpoint criticality is the union of parsed native subjects and every compiled account, never just one requested account. */
export function requireInventoryReturnCriticalExecution(execution:InventoryReturnExecution,endpoints?:ReadonlySet<string>):void{
 const list=execution.list;for(const s of list){const refs=[...new Set([...references(s.ix),...(s.compiledIx?references(s.compiledIx):[])])],watched=endpoints?refs.filter(k=>endpoints.has(k)):[...s.criticalAccounts,...s.lifecycleAccounts],critical=(TOKEN.has(s.ix.programId)||s.ix.programId===SYSTEM)&&watched.length>0;
  if(s.ix.programId===SYSTEM&&watched.length){check(systemShape(s),'SYSTEM_ROLE');const type=s.ix.parsed.type,info=s.ix.parsed.info;check(type==='transfer'||type==='createAccount','SYSTEM_LIFECYCLE_SCOPE');if(type==='createAccount')check(watched.includes(info.newAccount)&&['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(info.owner)&&info.space>=165,'SYSTEM_CREATION_ROLE');}
  if(s.proof==='UNKNOWN'&&!critical){check(s.ix.programId===SYSTEM&&systemShape(s)&&s.ix.parsed.type==='transfer','UNRELATED_UNKNOWN');continue;}
  if(!critical||s.proof==='ROLLED_BACK')continue;
  let at=s.order;const seen=new Set<number>();while(at>=0){check(!seen.has(at)&&at<list.length,'PARENT');seen.add(at);const own=list[at]!;check(own.proof==='LOGGED_SUCCESS'||own.proof==='COMMITTED','CRITICAL_EXECUTION');check(own.executed===true,'CRITICAL_EXECUTION');at=own.parent;}
 }
}
export function getInventoryReturnExecution(native:any,compiled:any|undefined,context:InventoryReturnExecutionContext):InventoryReturnExecution{
 const e=context.expected,at=Date.parse(context.nativeSourceAt),cutoff=Date.parse(context.cutoff);check(integer(e.slot)&&integer(e.blockTime)&&integer(e.transactionIndex)&&Number.isFinite(at)&&Number.isFinite(cutoff)&&at<=cutoff&&e.blockTime*1000<=at,'SOURCE_CLOCK');check(native?.slot===e.slot&&native?.blockTime===e.blockTime&&native?.transaction?.signatures?.[0]===e.signature&&native?.meta?.err===null&&(native.transactionIndex===undefined||native.transactionIndex===e.transactionIndex),'SOURCE_BINDING');let execution:InventoryReturnExecution;
 if(compiled!==undefined){const compiledAt=Date.parse(context.compiledSourceAt??'');check(Number.isFinite(compiledAt)&&compiledAt>=at&&compiledAt<=cutoff&&(compiled.transactionIndex===undefined||compiled.transactionIndex===e.transactionIndex),'COMPANION_CLOCK');const projected=assertInventoryReturnCompanionParity(native,compiled),proof=runtimeWindowSteps(projected,true);execution=decorate(proof,native,projected,context.endpoints,'COMPILED_RECOVERY');}
 else{try{const list=shaped(executedWindowInstructions(native));execution=decorate({list,logged:list.length,truncated:false},native,undefined,context.endpoints,'STRICT_NATIVE');}catch(error){if(!native?.meta?.logMessages?.includes('Log truncated'))throw error;execution=decorate(nativePrefix(native),native,undefined,context.endpoints,'NATIVE_PREFIX');}}
 requireInventoryReturnCriticalExecution(execution,context.endpoints);return execution;
}

/** Pure explicit-log prefix proof; no O26 source or endpoint authority is exported. */
export {nativePrefix as inventoryReturnNativePrefix};
