import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {recordedWindowInstructions} from './advisory-window-accounts.js';
import {runtimeWindowSteps,type ProofStep} from './advisory-runtime-proof.js';
import {assertInventoryReturnCompanionParity,inventoryReturnNativePrefix} from './advisory-inventory-return-runtime.js';
import {visitA30Sources,type A30SourceReceipts,type A30SourceContext,type A30FxIdentity,type A30FxIndexed,type A30FxCompanion} from './advisory-demand-fx-source.js';

// Published semantics: orca-so/whirlpools cc683ec92acb5e7606caa3d8e514d9383e9c7c11.
// Swap account guards, the Pinocchio liquidity handlers and Anchor's typed
// discriminator guards close the selected account's writer/nonwriter classes.
// This is a declared release/platform premise, not deployed-binary attestation.
const PROGRAM='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',SYSTEM='11111111111111111111111111111111',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MIN_SQRT=4295048016n,MAX_SQRT=79226673515401279992447579055n;
const NAMES=['swap','swap_v2','two_hop_swap','collect_protocol_fees_v2','update_fees_and_rewards','collect_fees','increase_liquidity_by_token_amounts_v2','open_position_with_token_extensions','decrease_liquidity','decrease_liquidity_v2','collect_fees_v2'] as const;
type OwnerName=typeof NAMES[number];
const discriminators=new Map(NAMES.map(name=>[createHash('sha256').update('global:'+name).digest('hex').slice(0,16),name]));
const EPOCH=new Set(['initialize_pool','initialize_pool_v2','initialize_pool_with_adaptive_fee'].map(name=>createHash('sha256').update('global:'+name).digest('hex').slice(0,16)));
const TRADED='e1ca49af932ba096',NONPRICE_EVENTS=new Map([['1e0790b566fe9ba1',128],['a601244770cab5ab',128],['edaff3e693756579',80]]);
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string):never=>{throw Error('A30_FX_STATE_'+code);};
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const raw58=(value:unknown):Buffer=>{
 if(typeof value!=='string'||!value.length||value.length>2000||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value))return fail('INSTRUCTION_ENCODING');
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of value)n=n*58n+BigInt(alphabet.indexOf(c));const hex=n.toString(16);return Buffer.concat([Buffer.alloc(value.match(/^1*/)?.[0].length??0),n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex')]);
};
const u128=(b:Buffer,o:number)=>b.readBigUInt64LE(o)|(b.readBigUInt64LE(o+8)<<64n);
const position=(a:{slot:number;transactionIndex:number},b:{slot:number;transactionIndex:number})=>a.slot-b.slot||a.transactionIndex-b.transactionIndex;
const oracle=(pool:string)=>PublicKey.findProgramAddressSync([Buffer.from('oracle'),new PublicKey(pool).toBuffer()],new PublicKey(PROGRAM))[0].toBase58();

export type A30FxAnchor={side:'LEFT_POST'|'RIGHT_PRE';signature:string;slot:number;transactionIndex:number;sqrtPriceX64:string;sourceId:string;sourceHash:string;sourceAt:string;compiledSource?:{id:string;at:string};eventHash:string;logIndex:number;proofMode:'STRICT_NATIVE'|'POSITIVE_NATIVE_PREFIX'|'COMPILED_RUNTIME';frame:{top:number;position:number;depth:number;order:number};ownAndAncestors:Array<{programId:string;top:number;position:number;depth:number;proof:'LOGGED_SUCCESS'|'COMMITTED'}>};
type Endpoint=Omit<A30FxAnchor,'side'|'sqrtPriceX64'>&{pre:string;post:string};
export type A30FxWriter={signature:string;slot:number;transactionIndex:number;blockTime:number;possibleWriters:number;first:Endpoint|null;last:Endpoint|null;missingEvents:number;unboundEventInvocations:number;unprovedEndpoints:number};
export type A30FxCell={index:number;left:{signature:string;slot:number;transactionIndex:number}|null;right:{signature:string;slot:number;transactionIndex:number}|null;status:'KNOWN'|'UNANCHORED';sqrtPriceX64:string|null;anchors:A30FxAnchor[]};
type ReferenceBase={method:'a30-incoming-fx-state-cells-v1';range:{start:string;end:string};anchorSlot:number;writers:A30FxWriter[];cells:A30FxCell[];coverage:Record<string,number|boolean|string>;reasonCode:string};
export type A30FxReference=ReferenceBase&({complete:true;sourceContext:A30SourceContext}|{complete:false;sourceContext:A30SourceContext|null});
export type A30FxResolution={status:'KNOWN'|'MISSING';sqrtPriceX64:string|null;cellIndex:number|null;anchors:A30FxAnchor[];reasonCode:string};
type OwnerCall={order:number;name:OwnerName;writer:boolean;direction?:boolean;allowedPools:string[];rawHash:string};

/** Decode only source-backed actual selected-owner profiles; unknown roles are not no-ops. */
function ownerCall(ix:any,depth:number,order:number,identity:A30FxIdentity,keys:Map<string,any>):OwnerCall{
 if(ix.parsed!==undefined||!Array.isArray(ix.accounts)||ix.accounts.some((a:unknown)=>typeof a!=='string'||!keys.has(a)))return fail('OWNER_ACCOUNTS');
 const a=ix.accounts as string[],b=raw58(ix.data),tag=b.subarray(0,8).toString('hex');if(EPOCH.has(tag))return fail('EPOCH_TRANSITION');const name=discriminators.get(tag);if(!name)return fail('OWNER_OPCODE');
 if(a.filter(k=>k===identity.pool).length!==1)return fail('POOL_ALIAS');
 const need=(condition:unknown,code='OWNER_ROLE')=>{if(!condition)fail(code);};
 const mutable=(...indices:number[])=>need(indices.every(i=>keys.get(a[i]!)?.writable===true),'OWNER_WRITABILITY');
 // A successful source Signer guard in a CPI may be satisfied by invoke_signed;
 // the global transaction signer flag is only required at depth one. Unproved
 // calls stay possible-writer barriers and cannot supply endpoints.
 const signer=(i:number)=>need(keys.get(a[i]!)?.signer===true||depth>1,'OWNER_SIGNER');
 const at=(i:number,value:string)=>need(a[i]===value);
 const pool=(i:number,write=false)=>{at(i,identity.pool);if(write)mutable(i);};
 const vaults=(i:number,j:number)=>{at(i,identity.vaultA);at(j,identity.vaultB);mutable(i,j);};
 const mints=(i:number,j:number)=>{at(i,identity.mintA);at(j,identity.mintB);};
 const programs=(i:number,j:number,m:number)=>{at(i,TOKEN);at(j,TOKEN);at(m,MEMO);};
 const distinctTyped=(...indices:number[])=>need(indices.every(i=>a[i]!==identity.pool),'OWNER_ALIAS');
 let direction:boolean|undefined,writer=false,allowedPools=[identity.pool];
 if(name==='swap'||name==='swap_v2'){
  need(b.length>=42&&b[40]!<2&&b[41]!<2,'SWAP_ARGUMENTS');direction=b[41]===1;writer=true;
  if(name==='swap'){
   need((b.length===42||b.length===43&&b[42]===0)&&(a.length===11||a.length===12&&a[11]===PROGRAM),'SWAP_PROFILE');at(0,TOKEN);signer(1);pool(2,true);vaults(4,6);mutable(3,5,7,8,9);at(10,oracle(identity.pool));distinctTyped(3,4,5,6,7,8,9,10);
  }else{
   need(a.length>=15&&a.length<=18,'SWAP_V2_PROFILE');programs(0,1,2);signer(3);pool(4,true);mints(5,6);vaults(8,10);mutable(7,9,11,12,13,14);at(14,oracle(identity.pool));distinctTyped(5,6,7,8,9,10,11,12,13,14);
   // RemainingAccountsInfo is Borsh Option<Vec<(enum,u8)>>. Legacy mints
   // cannot have hooks: only zero HookA/B slices and <=3 supplemental arrays.
   if(b[42]===0){need((b.length===43||b.length===50&&b.subarray(43).equals(Buffer.alloc(7))),'SWAP_V2_PADDING');}
   else{
    need(b[42]===1&&b.length>=47,'SWAP_V2_REMAINING');const n=b.readUInt32LE(43);need(n<=3&&b.length===47+2*n,'SWAP_V2_REMAINING');let consumed=0,supplemental=false;
    for(let i=0;i<n;i++){const type=b[47+2*i]!,length=b[48+2*i]!;need(type===0||type===1||type===6,'SWAP_V2_REMAINING');if(type<2)need(length===0,'TRANSFER_HOOK');else if(length){need(!supplemental&&length<=3,'SWAP_V2_REMAINING');supplemental=true;consumed+=length;}}
    need(a.length>=15+consumed,'SWAP_V2_REMAINING');if(consumed)mutable(...Array.from({length:consumed},(_,i)=>15+i));
   }
  }
 }else if(name==='two_hop_swap'){
  need(b.length===59&&a.length===20&&b[24]!<2&&b[25]!<2&&b[26]!<2,'TWO_HOP_PROFILE');at(0,TOKEN);signer(1);need(a[2]!==a[3],'TWO_HOP_ALIAS');const first=a[2]===identity.pool;need(first||a[3]===identity.pool);pool(first?2:3,true);vaults(first?5:9,first?7:11);mutable(first?4:8,first?6:10,...(first?[12,13,14]:[15,16,17]));at(first?18:19,oracle(identity.pool));direction=b[first?25:26]===1;writer=true;allowedPools=[a[2]!,a[3]!];distinctTyped(...(first?[4,5,6,7,12,13,14,18]:[8,9,10,11,15,16,17,19]));
 }else if(name==='update_fees_and_rewards'){
  need(b.length===8&&a.length===4);pool(0,true);mutable(1);distinctTyped(1,2,3);
 }else if(name==='collect_fees'){
  need(b.length===8&&a.length===9);pool(0);signer(1);mutable(2,4,6);vaults(5,7);at(8,TOKEN);distinctTyped(2,3,4,5,6,7);
 }else if(name==='collect_fees_v2'){
  need(b.length===9&&b[8]===0&&a.length===13);pool(0);signer(1);mutable(2,6,8);mints(4,5);vaults(7,9);programs(10,11,12);distinctTyped(2,3,4,5,6,7,8,9);
 }else if(name==='collect_protocol_fees_v2'){
  need(b.length===9&&b[8]===0&&a.length===12);at(0,identity.config);pool(1,true);signer(2);mints(3,4);vaults(5,6);mutable(7,8);programs(9,10,11);distinctTyped(0,3,4,5,6,7,8);
 }else if(name==='open_position_with_token_extensions'){
  need(b.length===17&&b[16]!<2&&a.length===10);pool(5);signer(0);signer(3);mutable(0,2,3,4);at(6,TOKEN2022);at(7,SYSTEM);at(8,ATA);distinctTyped(0,2,3,4,6,7,8,9);const expected=PublicKey.findProgramAddressSync([Buffer.from('position'),new PublicKey(a[3]!).toBuffer()],new PublicKey(PROGRAM))[0].toBase58();at(2,expected);
 }else if(name==='decrease_liquidity'){
  need(b.length===40&&u128(b,8)>0n&&a.length===11);pool(0,true);at(1,TOKEN);signer(2);mutable(3,5,6,9,10);vaults(7,8);distinctTyped(3,4,5,6,7,8,9,10);
 }else if(name==='decrease_liquidity_v2'||name==='increase_liquidity_by_token_amounts_v2'){
  const decrease=name==='decrease_liquidity_v2';need(a.length===15&&(decrease?b.length===41&&u128(b,8)>0n&&b[40]===0:b.length===58&&b[8]===0&&b[57]===0&&u128(b,25)<=u128(b,41)));pool(0,true);programs(1,2,3);signer(4);mutable(5,9,10,13,14);mints(7,8);vaults(11,12);distinctTyped(5,6,7,8,9,10,11,12,13,14);
 }
 // Nonwriters above are closed under the source's distinct typed discriminators:
 // Position/TickArray/Oracle loaders cannot reinterpret a Whirlpool, and all
 // child owner calls are independently included in this transaction's trace.
 return{order,name,writer,direction,allowedPools,rawHash:sha(b)};
}

function shapeParent(list:ReturnType<typeof recordedWindowInstructions>):Array<{parent:number;position:number}>{
 const out:Array<{parent:number;position:number}>=[],stack:number[]=[];let inner=-1;for(const[i,s]of list.entries()){inner=s.depth===1?-1:inner+1;stack.length=s.depth-1;const parent=s.depth===1?-1:stack[s.depth-2];if(parent===undefined)fail('OWNER_TREE');out.push({parent,position:inner});stack[s.depth-1]=i;}return out;
}
function positiveLineage(list:ProofStep[],order:number):A30FxAnchor['ownAndAncestors']|null{
 const chain:A30FxAnchor['ownAndAncestors']=[],seen=new Set<number>();let at=order;while(at>=0){if(seen.has(at)||!list[at])return null;seen.add(at);const s=list[at]!;if(!s.executed||s.proof!=='LOGGED_SUCCESS'&&s.proof!=='COMMITTED')return null;chain.push({programId:s.ix.programId,top:s.top,position:s.position,depth:s.depth,proof:s.proof});at=s.parent;}return chain;
}
type ParsedEvent={order:number;logIndex:number;pre:string;post:string;eventHash:string};
function eventsFromNative(tx:any,list:ReturnType<typeof recordedWindowInstructions>,calls:OwnerCall[],identity:A30FxIdentity):{events:ParsedEvent[];bound:boolean}{
 const shapes=shapeParent(list),events:ParsedEvent[]=[],stack:number[]=[];let cursor=0;const selected=new Map(calls.map(c=>[c.order,c]));
 for(const[logIndex,line]of tx.meta.logMessages.entries()){
  if(line==='Log truncated')break;let m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);
  if(m){const step=list[cursor];if(!step||step.ix.programId!==m[1]||step.depth!==Number(m[2])||step.depth!==stack.length+1||shapes[cursor]!.parent!==(stack.at(-1)??-1))return{events:[],bound:false};stack.push(cursor++);continue;}
  m=line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/);if(m){const at=stack.pop();if(at===undefined||list[at]!.ix.programId!==m[1])return{events:[],bound:false};continue;}
  if(!line.startsWith('Program data: '))continue;const order=stack.at(-1);if(order===undefined||list[order]!.ix.programId!==PROGRAM)continue;const call=selected.get(order);if(!call)continue;
  const text=line.slice(14),b=Buffer.from(text,'base64');if(b.toString('base64')!==text)return fail('EVENT_ENCODING');const tag=b.subarray(0,8).toString('hex');
  if(tag!==TRADED){if(NONPRICE_EVENTS.get(tag)!==b.length||call.writer)return fail('EVENT_TYPE');if(b.subarray(8,40).toString('hex')!==new PublicKey(identity.pool).toBuffer().toString('hex'))return fail('EVENT_POOL');continue;}
  if(b.length!==121||!call.writer||!call.allowedPools.includes(new PublicKey(b.subarray(8,40)).toBase58()))return fail('EVENT_ROLE');const pool=new PublicKey(b.subarray(8,40)).toBase58();if(pool!==identity.pool)continue;
  const pre=u128(b,41),post=u128(b,57);if(b[40]!>1||Boolean(b[40])!==call.direction||pre<MIN_SQRT||pre>MAX_SQRT||post<MIN_SQRT||post>MAX_SQRT)return fail('EVENT_FIELDS');
  // All remaining fields are six source-defined u64 values. Read and reencode
  // the complete payload; neither price limit nor transfer balances supply s.
  const rebuilt=Buffer.alloc(121);b.subarray(0,41).copy(rebuilt);for(const[o,v]of[[41,pre],[57,post]] as const){rebuilt.writeBigUInt64LE(v&((1n<<64n)-1n),o);rebuilt.writeBigUInt64LE(v>>64n,o+8);}for(let o=73;o<121;o+=8)rebuilt.writeBigUInt64LE(b.readBigUInt64LE(o),o);if(!rebuilt.equals(b))return fail('EVENT_REENCODE');events.push({order,logIndex,pre:pre.toString(),post:post.toString(),eventHash:sha(b)});
 }
 return{events,bound:true};
}

function transactionWriters(tx:any,indexed:A30FxIndexed,at:string,companion:A30FxCompanion|undefined,identity:A30FxIdentity):{writer:A30FxWriter|null;nonwriters:number;endpointMode?:string}{
 const keys=new Map<string,any>();for(const k of tx.transaction.message.accountKeys){if(!k||typeof k.pubkey!=='string'||typeof k.writable!=='boolean'||typeof k.signer!=='boolean'||keys.has(k.pubkey))fail('KEYS');keys.set(k.pubkey,k);}
 const list=recordedWindowInstructions(tx),calls:OwnerCall[]=[];for(const[order,s]of list.entries()){
  if(!keys.has(s.ix.programId))fail('PROGRAM_MEMBERSHIP');if(s.ix.programId!==PROGRAM)continue;
  if(!Array.isArray(s.ix.accounts))fail('OWNER_ACCOUNTS');if(!s.ix.accounts.includes(identity.pool))continue;calls.push(ownerCall(s.ix,s.depth,order,identity,keys));
 }
 const writers=calls.filter(c=>c.writer),nativeEvents=eventsFromNative(tx,list,calls,identity);if(!writers.length)return{writer:null,nonwriters:calls.length};
 let proof:{list:ProofStep[]}|null=null,mode:Endpoint['proofMode']='STRICT_NATIVE';
 if(companion){let projected:any;try{projected=assertInventoryReturnCompanionParity(tx,companion.value);}catch{return fail('COMPANION_PARITY');}try{proof=runtimeWindowSteps(projected,true);mode='COMPILED_RUNTIME';}catch{proof=null;}}
 else{try{proof=runtimeWindowSteps(tx,false);}catch{try{proof=inventoryReturnNativePrefix(tx);mode='POSITIVE_NATIVE_PREFIX';}catch{proof=null;}}}
 const events=nativeEvents.events,byOrder=new Map<number,ParsedEvent[]>();for(const e of events)byOrder.set(e.order,[...(byOrder.get(e.order)??[]),e]);
 const endpoints=new Map<number,Endpoint>();for(const call of writers){const matching=byOrder.get(call.order)??[];if(matching.length>1)fail('DUPLICATE_EVENT');const event=matching[0],lineage=proof?positiveLineage(proof.list,call.order):null;if(!event||!lineage)continue;const s=proof!.list[call.order]!;endpoints.set(call.order,{signature:indexed.signature,slot:indexed.slot,transactionIndex:indexed.transactionIndex,sourceId:indexed.sourceId,sourceHash:indexed.sourceHash,sourceAt:at,...(mode==='COMPILED_RUNTIME'&&companion?{compiledSource:{id:companion.id,at:companion.at}}:{}),eventHash:event.eventHash,logIndex:event.logIndex,proofMode:mode,frame:{top:s.top,position:s.position,depth:s.depth,order:call.order},ownAndAncestors:lineage,pre:event.pre,post:event.post});}
 const first=writers[0]!,last=writers.at(-1)!;return{writer:{signature:indexed.signature,slot:indexed.slot,transactionIndex:indexed.transactionIndex,blockTime:indexed.blockTime,possibleWriters:writers.length,first:endpoints.get(first.order)??null,last:endpoints.get(last.order)??null,missingEvents:nativeEvents.bound?writers.filter(c=>!byOrder.has(c.order)).length:0,unboundEventInvocations:nativeEvents.bound?0:writers.length,unprovedEndpoints:writers.length-endpoints.size},nonwriters:calls.length-writers.length,endpointMode:mode};
}

/** Pure equality kernel. Missing writers remain barriers, including in tests. */
export function buildA30FxCells(writers:A30FxWriter[]):A30FxCell[]{
 for(let i=1;i<writers.length;i++)if(position(writers[i-1]!,writers[i]!)>=0)fail('WRITER_ORDER');
 return Array.from({length:writers.length+1},(_,index)=>{
  const left=writers[index-1]??null,right=writers[index]??null,anchors:A30FxAnchor[]=[];
  if(left?.last){const{pre,post,...e}=left.last;anchors.push({...e,side:'LEFT_POST',sqrtPriceX64:post});}
  if(right?.first){const{pre,post,...e}=right.first;anchors.push({...e,side:'RIGHT_PRE',sqrtPriceX64:pre});}
  if(anchors.length===2&&anchors[0]!.sqrtPriceX64!==anchors[1]!.sqrtPriceX64)fail('CELL_CONFLICT');
  const point=(w:A30FxWriter|null)=>w?{signature:w.signature,slot:w.slot,transactionIndex:w.transactionIndex}:null;
  return{index,left:point(left),right:point(right),status:anchors.length?'KNOWN':'UNANCHORED',sqrtPriceX64:anchors[0]?.sqrtPriceX64??null,anchors};
 });
}

export function buildA30FxReference(receipts:A30SourceReceipts,cutoff:string):A30FxReference{
 const base:ReferenceBase={method:'a30-incoming-fx-state-cells-v1',range:receipts.range,anchorSlot:receipts.anchorSlot,writers:[],cells:[],coverage:{},reasonCode:'A30_FX_STATE_UNRESOLVED'};let sourceContext:A30SourceContext|null=null;
 try{
  let nonwriters=0;sourceContext=visitA30Sources(receipts,cutoff,(tx,indexed,at,companion,identity)=>{const decoded=transactionWriters(tx,indexed,at,companion,identity);nonwriters+=decoded.nonwriters;if(decoded.writer)base.writers.push(decoded.writer);});
  base.writers.sort(position);base.cells=buildA30FxCells(base.writers);const endpoints=base.writers.flatMap(w=>w.first?[w.first]:[]);
  base.coverage={...sourceContext.coverage,possibleWriterTransactions:base.writers.length,possibleWriterInvocations:base.writers.reduce((n,w)=>n+w.possibleWriters,0),typedNonwriterInvocations:nonwriters,admittedEndpointTransactions:endpoints.length,strictEndpointTransactions:endpoints.filter(e=>e.proofMode==='STRICT_NATIVE').length,prefixEndpointTransactions:endpoints.filter(e=>e.proofMode==='POSITIVE_NATIVE_PREFIX').length,compiledEndpointTransactions:endpoints.filter(e=>e.proofMode==='COMPILED_RUNTIME').length,missingEventInvocations:base.writers.reduce((n,w)=>n+w.missingEvents,0),unboundEventInvocations:base.writers.reduce((n,w)=>n+w.unboundEventInvocations,0),unprovedEndpointInvocations:base.writers.reduce((n,w)=>n+w.unprovedEndpoints,0),cells:base.cells.length,unanchoredCells:base.cells.filter(c=>c.status==='UNANCHORED').length,fullEventSeriesKnown:false,sourceOnlyIdentityBank:true};
  return{...base,complete:true,sourceContext,reasonCode:'A30_FX_REQUIRED_QUERY_REFERENCE_CONSTRUCTED'};
 }catch(error){const reasonCode=error instanceof Error&&/^(?:A30_|ADVISORY_)[A-Z0-9_]+$/.test(error.message)?error.message:'A30_FX_STATE_SOURCE_OR_CODEC_UNRESOLVED';return{...base,complete:false,sourceContext,reasonCode};}
}

/** Caller binds the queried native transaction to reference.range before resolving. */
export function resolveA30FxState(reference:A30FxReference,query:{slot:number;transactionIndex:number;signature:string}):A30FxResolution{
 const missing=(reasonCode:string,cellIndex:number|null=null):A30FxResolution=>({status:'MISSING',sqrtPriceX64:null,cellIndex,anchors:[],reasonCode});
 if(!reference.complete)return missing(reference.reasonCode);if(!integer(query.slot)||!integer(query.transactionIndex)||typeof query.signature!=='string'||!query.signature||query.slot>reference.anchorSlot)return missing('A30_FX_QUERY_POSITION');
 let lo=0,hi=reference.writers.length;while(lo<hi){const mid=(lo+hi)>>>1;if(position(reference.writers[mid]!,query)<0)lo=mid+1;else hi=mid;}
 const writer=reference.writers[lo];if(writer&&position(writer,query)===0&&writer.signature!==query.signature)return missing('A30_FX_QUERY_POSITION_CONFLICT');const cell=reference.cells[lo];if(!cell||cell.status!=='KNOWN'||cell.sqrtPriceX64===null)return missing('A30_FX_REQUIRED_QUERY_UNANCHORED',lo);
 return{status:'KNOWN',sqrtPriceX64:cell.sqrtPriceX64,cellIndex:lo,anchors:cell.anchors,reasonCode:'A30_FX_INCOMING_CONSTANT_CELL_IDENTIFIED'};
}
