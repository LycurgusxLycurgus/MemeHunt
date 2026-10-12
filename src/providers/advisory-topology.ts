import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { EvidenceRecord, TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { LEGACY_TOKEN_PROGRAM, SOLANA_MAINNET_GENESIS, TOKEN_2022_PROGRAM, decodeHolderPopulation, decodeRawMintControls, decodeSolanaAddress, encodeSolanaAddress, safeRpcCode, solanaRpc } from './solana.js';
import { archiveDemandReceipt, unpackDemandReceipt } from './advisory-demand-windows.js';

const METHOD='spl-authority-topology-v1',RULE='spl-authority-association-v1',OUTPUT_LIMIT_BYTES=2_000_000,POPULATION_LIMIT_BYTES=20_000_000;
// Proof v22 stores the canonical rpc-holder-population body with the exact demand archive codec (container method advisory-demand-rpc-archive-v1);
// the adapter belongs to this one receipt. The source ceiling is the unchanged 20 MB holder read cap: compression, never truncation.
export const HOLDER_ARCHIVE_ADAPTER='holder-population-archive-v1' as const,HOLDER_ARCHIVE_SOURCE_BYTES=POPULATION_LIMIT_BYTES;
/** Exact reversible storage form of one holder-population body; a body above the source ceiling is refused, never cut. */
export function archiveHolderPopulation(raw:string):string{
  if(typeof raw!=='string'||!raw.length||Buffer.byteLength(raw,'utf8')>HOLDER_ARCHIVE_SOURCE_BYTES)throw new Error('HOLDER_ARCHIVE_SOURCE_LIMIT');
  return archiveDemandReceipt(raw);
}
/** Strict single-level unpack: canonical container, claimed size bounded before inflation, then exact length, SHA-256 and UTF-8 round trip. */
export function unpackHolderPopulation(stored:string):string{
  try{return unpackDemandReceipt(stored,HOLDER_ARCHIVE_SOURCE_BYTES);}catch{return fail('ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID');}
}
const RECEIPTS=['rpc-genesis','rpc-mint-raw','rpc-holder-population'] as const;
const POPULATION_KEY='topology-population',POPULATION_EVIDENCE=`advisory-topology-${POPULATION_KEY}`;
/** Only evidenced benign Token-2022 extensions; every other type leaves O21 unresolved. */
const MINT_EXTENSIONS:Record<number,{name:string;valid:(length:number)=>boolean}>={18:{name:'METADATA_POINTER',valid:n=>n===64},19:{name:'TOKEN_METADATA',valid:n=>n>=80}};
const ACCOUNT_EXTENSIONS:Record<number,{name:string;valid:(length:number)=>boolean}>={7:{name:'IMMUTABLE_OWNER',valid:n=>n===0}};
export type TopologyReceipts={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,unknown>};
type ReceiptId=typeof RECEIPTS[number];
type JsonObject=Record<string,unknown>;
type State='INITIALIZED'|'FROZEN';
type Kind='TRANSFER_DELEGATE'|'CLOSE_AUTHORITY';
type Proof={account:string;balanceAtomic:string;allowanceAtomic?:string;approvedAtomic?:string;effectiveAtomic?:string};
type Pair={owner:string;authority:string;kind:Kind;state:State;suspended?:true;effectiveAtomic?:string;accounts:Proof[]};
type Row={account:string;owner:string;balance:bigint;state:State;delegate:string|null;allowance:bigint;close:string|null};
type Item={pubkey:string;account:JsonObject&{data:[string,string]}};
type Mint={program:string;supply:bigint;decimals:number;slot:number;extensions:number[]};

class Unresolved extends Error {}
function fail(code:string):never{throw new Error(code);}
function unresolved(reason:string):never{throw new Unresolved(reason);}
const object=(v:unknown):v is JsonObject=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const sha256=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const share=(part:bigint,whole:bigint)=>new Decimal(part.toString()).div(whole.toString()).toFixed();
const min=(a:bigint,b:bigint)=>a<b?a:b;
const sameScope=(scope:JsonObject,expected:JsonObject)=>{const keys=Object.keys(scope).sort();return JSON.stringify(keys)===JSON.stringify(Object.keys(expected).sort())&&keys.every(k=>scope[k]===expected[k]);};
const count=(counts:Record<string,number>,key:string|number)=>{counts[key]=(counts[key]??0)+1;};

/** Exact receipt binding: forged metadata, clocks or hashes throw; receipts absent on both sides stay unresolved.
 * Genesis and mint are always live-v1. The holder population is live-v1 before proof v22 and only holder-population-archive-v1 from it;
 * the stored container hash is checked first, then the archive is unpacked to the exact original body every decoder reads. */
function verifyReceipts(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],raw:Record<string,string>,holderArchive:boolean):{present:ReceiptId[];bodies:Partial<Record<ReceiptId,string>>}{
  const cut=Date.parse(cutoff);if(!/^\d{4}-\d\d-\d\dT/.test(cutoff)||!Number.isFinite(cut))fail('ADVISORY_TOPOLOGY_CUTOFF');
  checkToken(token);
  const bodies:Partial<Record<ReceiptId,string>>={};
  const present=RECEIPTS.filter(id=>{
    const records=evidence.filter(e=>e.id===id),body=Object.hasOwn(raw,id)?raw[id]:undefined;
    if(records.length>1)fail('ADVISORY_TOPOLOGY_RECEIPT_DUPLICATE');
    if(!records.length&&body===undefined)return false;
    if(records.length!==1||typeof body!=='string')fail('ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP');
    const e=records[0]!,archived=holderArchive&&id==='rpc-holder-population';
    if(e.sourceId!=='solana-rpc'||e.sourceType!=='JSON_RPC'||e.accessMode!=='PUBLIC_API'||e.adapterVersion!==(archived?HOLDER_ARCHIVE_ADAPTER:'live-v1'))fail('ADVISORY_TOPOLOGY_RECEIPT_METADATA');
    const expected=id==='rpc-genesis'?{method:'getGenesisHash',genesisHash:typeof e.scope.genesisHash==='string'?e.scope.genesisHash:null}:{operation:id,commitment:'finalized',mint:token.address,...(id==='rpc-holder-population'&&e.scope.fullAccountData===true?{fullAccountData:true}:{})};
    if(!sameScope(e.scope,expected))fail('ADVISORY_TOPOLOGY_RECEIPT_SCOPE');
    if(e.availableAt!==e.retrievedAt||!(Date.parse(e.retrievedAt)<=cut))fail('ADVISORY_TOPOLOGY_RECEIPT_TIME');
    if(sha256(body)!==e.contentHash)fail('ADVISORY_TOPOLOGY_RECEIPT_HASH');
    bodies[id]=archived?unpackHolderPopulation(body):body;
    return true;
  });
  return {present,bodies};
}
function checkToken(token:TokenRef){if(token.chain!=='solana')fail('ADVISORY_TOPOLOGY_SCOPE');try{decodeSolanaAddress(token.address);}catch{fail('ADVISORY_TOPOLOGY_SCOPE');}}
function rpcResult(raw:string):unknown{
  let v:unknown;try{v=JSON.parse(raw);}catch{return unresolved('RPC_SHAPE');}
  if(!object(v)||v.jsonrpc!=='2.0'||v.id!==1)return unresolved('RPC_SHAPE');
  if(object(v.error)){const c=v.error.code;return unresolved(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(Number(c))<=999999?`RPC_REMOTE_${c}`:'RPC_REMOTE');}
  if(!Object.hasOwn(v,'result'))return unresolved('RPC_SHAPE');
  return v.result;
}
/** Existing SPL decoders keep their behavior; their data errors become honest unresolved reasons. */
function decoded<T>(read:()=>T):T{
  try{return read();}
  catch(error){if(error instanceof Error&&/^(RPC_SHAPE|HOLDER_SUPPLY_UNRECONCILED|INVALID_SOLANA_ADDRESS)$/.test(error.message))unresolved(error.message);throw error;}
}
/** Strict Token-2022 TLV after the AccountType byte: bounded headers, no duplicates, allow-listed types, all-zero tail. */
function walkTlv(b:Buffer,allowed:Record<number,{valid:(length:number)=>boolean}>,prefix:string):number[]{
  const types:number[]=[];let offset=166;
  while(offset<b.length){
    if(b.subarray(offset).every(x=>x===0))break;
    if(offset+4>b.length)unresolved(`${prefix}_TLV_TRUNCATED`);
    const type=b.readUInt16LE(offset),length=b.readUInt16LE(offset+2);offset+=4;
    if(type===0||types.includes(type)||offset+length>b.length)unresolved(`${prefix}_TLV_MALFORMED`);
    const rule=allowed[type];if(!rule)unresolved(`${prefix}_EXTENSION_${type}_UNSUPPORTED`);
    if(!rule.valid(length))unresolved(`${prefix}_TLV_MALFORMED`);
    types.push(type);offset+=length;
  }
  return types;
}
/** Legacy 82-byte mints unchanged; Token-2022 bare or extended mints only with allow-listed extensions. */
function mintFacts(result:unknown):Mint{
  const account=object(result)?result.value:undefined;
  if(account===null)unresolved('MINT_ACCOUNT_MISSING');
  if(!object(account))return unresolved('RPC_SHAPE');
  if(account.owner!==LEGACY_TOKEN_PROGRAM&&account.owner!==TOKEN_2022_PROGRAM)unresolved('MINT_PROGRAM_UNSUPPORTED');
  if(account.executable!==false)unresolved('MINT_ACCOUNT_EXECUTABLE');
  decoded(()=>decodeRawMintControls(result));
  const b=Buffer.from((account.data as [string])[0],'base64');
  if(account.owner===TOKEN_2022_PROGRAM&&b.length===355)unresolved('TOKEN_2022_MINT_SIZE_INVALID');
  if(Object.hasOwn(account,'space')&&account.space!==b.length)unresolved('MINT_ACCOUNT_DATA_SLICED');
  const slot=Number(((result as JsonObject).context as JsonObject).slot);
  const extensions=account.owner===TOKEN_2022_PROGRAM&&b.length>82?walkTlv(b,MINT_EXTENSIONS,'TOKEN_2022_MINT'):[];
  const supply=b.readBigUInt64LE(36);if(supply<=0n)unresolved('MINT_SUPPLY_ZERO');
  return {program:account.owner as string,supply,decimals:b[44]!,slot,extensions};
}
const populationRequest=(token:TokenRef,slot:number)=>({method:'getProgramAccounts',params:[TOKEN_2022_PROGRAM,{encoding:'base64',commitment:'finalized',minContextSlot:slot,withContext:true,filters:[{memcmp:{offset:0,bytes:token.address}}]}]});
/** One full read only for a supported Token-2022 mint; legacy, missing or invalid mints plan nothing. */
function plan(token:TokenRef,mintRaw:string|undefined):Record<string,unknown>{
  if(mintRaw===undefined)return {};
  try{const mint=mintFacts(rpcResult(mintRaw));return mint.program===TOKEN_2022_PROGRAM?{[POPULATION_KEY]:populationRequest(token,mint.slot)}:{};}
  catch(error){if(error instanceof Unresolved)return {};throw error;}
}

export async function collectAuthorityTopology(token:TokenRef,mintRaw:string|undefined,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<TopologyReceipts>{
  checkToken(token);
  const receipts:TopologyReceipts={rawArtifacts:{},retrievedAt:{},requests:{}},request=plan(token,mintRaw)[POPULATION_KEY] as {method:string;params:unknown[]}|undefined;
  if(!request)return receipts;
  receipts.requests[POPULATION_KEY]=request;
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,POPULATION_LIMIT_BYTES,signal,raw=>{receipts.rawArtifacts[POPULATION_KEY]=raw;receipts.retrievedAt[POPULATION_KEY]=now();});}
  catch(error){if(!receipts.rawArtifacts[POPULATION_KEY]){receipts.rawArtifacts[POPULATION_KEY]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}});receipts.retrievedAt[POPULATION_KEY]=now();}}
  return receipts;
}

/** Exact topology membership against the canonical mint plan; legacy or unsupported mints admit no topology receipts. */
function verifyTopology(evidence:EvidenceRecord[],topology:TopologyReceipts,expected:Record<string,unknown>,cut:number,mintAt:number):{id:string;raw:string}|null{
  const maps=[topology.rawArtifacts,topology.retrievedAt,topology.requests],records=evidence.filter(e=>e.sourceId==='advisory-topology'||e.id===POPULATION_EVIDENCE);
  if(!maps.every(object))fail('ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP');
  if(maps.every(m=>!Object.keys(m).length)&&!records.length)return null;
  const keys=JSON.stringify(Object.keys(expected).sort());
  if(keys==='[]'||!maps.every(m=>JSON.stringify(Object.keys(m).sort())===keys)||records.length!==1||records[0]!.id!==POPULATION_EVIDENCE)fail('ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP');
  const raw=topology.rawArtifacts[POPULATION_KEY],at=topology.retrievedAt[POPULATION_KEY],request=expected[POPULATION_KEY],e=records[0]!;
  if(JSON.stringify(topology.requests[POPULATION_KEY])!==JSON.stringify(request)||typeof raw!=='string')fail('ADVISORY_TOPOLOGY_REQUEST');
  const t=Date.parse(at??'');if(!Number.isFinite(t)||!(t>=mintAt)||t>cut)fail('ADVISORY_TOPOLOGY_RECEIPT_TIME');
  if(e.sourceId!=='advisory-topology'||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='PUBLIC_API'||e.adapterVersion!=='live-v1'||!object(e.scope)||JSON.stringify(Object.keys(e.scope))!=='["request"]'||JSON.stringify(e.scope.request)!==JSON.stringify(request))fail('ADVISORY_TOPOLOGY_RECEIPT_METADATA');
  if(e.retrievedAt!==at||e.availableAt!==at)fail('ADVISORY_TOPOLOGY_RECEIPT_TIME');
  if(sha256(raw)!==e.contentHash)fail('ADVISORY_TOPOLOGY_RECEIPT_HASH');
  return {id:POPULATION_EVIDENCE,raw};
}
/** Full Token-2022 accounts are validated before an in-memory 165-byte base projection feeds the unchanged holder decoder. */
function fullPopulation(result:unknown,minSlot:number){
  const context=object(result)?result.context:undefined,list=object(result)?result.value:undefined;
  if(!object(context)||!Number.isSafeInteger(context.slot)||Number(context.slot)<minSlot||!Array.isArray(list))unresolved('RPC_SHAPE');
  const dataLengths:Record<string,number>={},accountExtensions:Record<string,number>={};let bareAccounts=0,extendedAccounts=0;
  const value:Item[]=(list as unknown[]).map(item=>{
    const account=object(item)?item.account:undefined,data=object(account)?account.data:undefined;
    if(!object(item)||typeof item.pubkey!=='string'||!object(account)||account.owner!==TOKEN_2022_PROGRAM||account.executable!==false||!Array.isArray(data)||data.length!==2||data[1]!=='base64'||typeof data[0]!=='string')return unresolved('RPC_SHAPE');
    const b=Buffer.from(data[0],'base64');if(b.toString('base64')!==data[0]||b.length<165)unresolved('RPC_SHAPE');
    if(b.length===355)unresolved('TOKEN_2022_ACCOUNT_SIZE_INVALID');
    if(Object.hasOwn(account,'space')&&account.space!==b.length)unresolved('TOKEN_2022_ACCOUNT_DATA_SLICED');
    if(b.length===165)bareAccounts++;
    else{if(b[165]!==2)unresolved('TOKEN_2022_ACCOUNT_TYPE_INVALID');extendedAccounts++;for(const type of walkTlv(b,ACCOUNT_EXTENSIONS,'TOKEN_2022_ACCOUNT'))count(accountExtensions,ACCOUNT_EXTENSIONS[type]!.name);}
    count(dataLengths,b.length);
    return {pubkey:item.pubkey,account:{...account,data:[b.subarray(0,165).toString('base64'),'base64']}};
  });
  return {projected:{context,value},coverage:{bareAccounts,extendedAccounts,dataLengths,accountExtensions}};
}
function rowsOf(items:Item[],holders:ReturnType<typeof decodeHolderPopulation>):Row[]{
  return items.map((item,index)=>{
    const b=Buffer.from(item.account.data[0],'base64'),{address,owner,amount}=holders.accounts[index]!;
    const option=(offset:number)=>{const tag=b.readUInt32LE(offset);if(tag!==0&&tag!==1)unresolved('TOKEN_ACCOUNT_OPTION_INVALID');return tag===1;};
    const delegate=option(72)?encodeSolanaAddress(b.subarray(76,108)):null,native=option(109),close=option(129)?encodeSolanaAddress(b.subarray(133,165)):null;
    if(native)unresolved('TOKEN_ACCOUNT_NATIVE_UNSUPPORTED');
    return {account:address,owner,balance:BigInt(amount),state:b[108]===1?'INITIALIZED':'FROZEN',delegate,allowance:b.readBigUInt64LE(121),close};
  });
}

/** Undirected candidate connectivity; each positive owner's full balance is counted once per component. */
function graph(edges:Array<{pair:Pair;ref:string}>,positive:Map<string,bigint>,supply:bigint){
  const parent=new Map<string,string>([...positive.keys()].map(o=>[o,o] as [string,string]));
  const find=(x:string):string=>{let root=x;while(parent.get(root)!==root)root=parent.get(root)!;while(x!==root){const next=parent.get(x)!;parent.set(x,root);x=next;}return root;};
  for(const {pair} of edges){for(const v of [pair.owner,pair.authority])if(!parent.has(v))parent.set(v,v);const a=find(pair.owner),b=find(pair.authority);if(a!==b)parent.set(a<b?b:a,a<b?a:b);}
  const groups=new Map<string,{owners:string[];authorities:Set<string>;refs:string[]}>();
  for(const v of parent.keys()){const root=find(v);if(!groups.has(root))groups.set(root,{owners:[],authorities:new Set(),refs:[]});if(positive.has(v))groups.get(root)!.owners.push(v);}
  for(const {pair,ref} of edges){const g=groups.get(find(pair.owner))!;g.authorities.add(pair.authority);g.refs.push(ref);}
  const byBalance=(a:string,b:string)=>{const d=positive.get(b)!-positive.get(a)!;return d>0n?1:d<0n?-1:a.localeCompare(b);};
  const components=[...groups.values()].filter(g=>g.refs.length).map(g=>{
    const owners=g.owners.sort(byBalance),holder=owners.reduce((s,o)=>s+positive.get(o)!,0n);
    return {holder,row:{holderBalanceAtomic:holder.toString(),holderShare:share(holder,supply),owners:owners.map(owner=>({owner,balanceAtomic:positive.get(owner)!.toString()})),authorities:[...g.authorities].sort(),associations:g.refs}};
  }).sort((a,b)=>a.holder<b.holder?1:a.holder>b.holder?-1:a.row.owners[0]!.owner.localeCompare(b.row.owners[0]!.owner));
  const single=[...groups.values()].filter(g=>!g.refs.length).flatMap(g=>g.owners).sort(byBalance);
  const singleTotal=single.reduce((s,o)=>s+positive.get(o)!,0n),associated=components.reduce((s,c)=>s+c.holder,0n);
  return {nontrivialComponents:components.length,associatedOwners:components.reduce((n,c)=>n+c.row.owners.length,0),associatedHolderAtomic:associated.toString(),associatedHolderShare:share(associated,supply),largestComponentShare:components[0]?.row.holderShare??'0',
    components:components.map(c=>c.row),singletons:{count:single.length,totalAtomic:singleTotal.toString(),share:share(singleTotal,supply),largest:single[0]?{owner:single[0],balanceAtomic:positive.get(single[0])!.toString(),share:share(positive.get(single[0])!,supply)}:null}};
}

/** holderArchive (proof v22): the canonical holder population is read only through its holder-population-archive-v1 container. */
export function deriveAuthorityTopology(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>,topology:TopologyReceipts={rawArtifacts:{},retrievedAt:{},requests:{}},holderArchive=false):AdvisoryMetric{
  const {present,bodies}=verifyReceipts(token,cutoff,evidence,rawArtifacts,holderArchive),mintRecord=evidence.find(e=>e.id==='rpc-mint-raw');
  const expected=present.includes('rpc-mint-raw')?plan(token,bodies['rpc-mint-raw']):{};
  const full=verifyTopology(evidence,topology,expected,Date.parse(cutoff),mintRecord?Date.parse(mintRecord.retrievedAt):Number.NaN);
  let ids:string[]=[...present,...(full?[full.id]:[])];
  const metric=(known:boolean,data:JsonObject,reasonCode:string):AdvisoryMetric=>({id:'O21',quality:known?'KNOWN':'MISSING',unit:'scoped-record',data:{method:METHOD,rule:RULE,token,...data},evidenceIds:[...ids],reasonCode});
  try{
    for(const id of ['rpc-genesis','rpc-mint-raw'] as const)if(!present.includes(id))unresolved(`${id.toUpperCase().replace(/-/g,'_')}_UNAVAILABLE`);
    const genesis=rpcResult(bodies['rpc-genesis']!);
    if(evidence.find(e=>e.id==='rpc-genesis')!.scope.genesisHash!==(typeof genesis==='string'?genesis:null))fail('ADVISORY_TOPOLOGY_RECEIPT_SCOPE');
    if(genesis!==SOLANA_MAINNET_GENESIS)unresolved('GENESIS_NOT_MAINNET');
    const mint=mintFacts(rpcResult(bodies['rpc-mint-raw']!)),supply=mint.supply;
    let items:Item[],holders:ReturnType<typeof decodeHolderPopulation>,coverage:JsonObject;
    if(mint.program===LEGACY_TOKEN_PROGRAM){
      if(!present.includes('rpc-holder-population'))unresolved('RPC_HOLDER_POPULATION_UNAVAILABLE');
      const population=rpcResult(bodies['rpc-holder-population']!);
      holders=decoded(()=>decodeHolderPopulation(population,token.address,LEGACY_TOKEN_PROGRAM,supply.toString(),mint.slot));
      items=(population as {value:Item[]}).value;
      coverage={program:LEGACY_TOKEN_PROGRAM,populationSource:'rpc-holder-population',mintExtensions:[],accountExtensions:{},bareAccounts:items.length,extendedAccounts:0};
    }else{
      const canonical=evidence.find(e=>e.id==='rpc-holder-population'&&e.scope.fullAccountData===true);
      if(full||!canonical)ids=ids.filter(id=>id!=='rpc-holder-population');
      if(!full&&!canonical)unresolved('TOKEN_2022_FULL_POPULATION_UNAVAILABLE');
      if(!full&&Date.parse(canonical!.retrievedAt)<Date.parse(evidence.find(e=>e.id==='rpc-mint-raw')!.retrievedAt))fail('ADVISORY_TOPOLOGY_RECEIPT_TIME');
      const populationRaw=full?full.raw:bodies['rpc-holder-population']!;
      const parsed=fullPopulation(rpcResult(populationRaw),mint.slot);
      holders=decoded(()=>decodeHolderPopulation(parsed.projected,token.address,TOKEN_2022_PROGRAM,supply.toString(),mint.slot));
      items=parsed.projected.value;
      coverage={program:TOKEN_2022_PROGRAM,populationSource:full?POPULATION_EVIDENCE:'rpc-holder-population',mintExtensions:mint.extensions.map(t=>MINT_EXTENSIONS[t]!.name),...parsed.coverage,supportedMintExtensions:Object.values(MINT_EXTENSIONS).map(r=>r.name),supportedAccountExtensions:Object.values(ACCOUNT_EXTENSIONS).map(r=>r.name)};
    }
    const rows=rowsOf(items,holders);
    const balances=new Map<string,bigint>();for(const r of rows)balances.set(r.owner,(balances.get(r.owner)??0n)+r.balance);
    const positive=new Map([...balances].filter(([,v])=>v>0n));
    const pairs=new Map<string,Pair>();
    const link=(r:Row,authority:string,kind:Kind,proof:Proof)=>{const key=[kind,r.state,r.owner,authority].join('|');let pair=pairs.get(key);if(!pair){pair={owner:r.owner,authority,kind,state:r.state,...(kind==='TRANSFER_DELEGATE'&&r.state==='FROZEN'?{suspended:true as const}:{}),accounts:[]};pairs.set(key,pair);}pair.accounts.push(proof);};
    let exposed=0n,exposedAccounts=0;const exposedOwners=new Set<string>();
    for(const r of rows){
      if(r.balance<=0n)continue;
      if(r.delegate&&r.delegate!==r.owner&&r.allowance>0n){
        const approved=min(r.balance,r.allowance),active=r.state==='INITIALIZED';
        link(r,r.delegate,'TRANSFER_DELEGATE',{account:r.account,balanceAtomic:r.balance.toString(),allowanceAtomic:r.allowance.toString(),approvedAtomic:approved.toString(),effectiveAtomic:active?approved.toString():'0'});
        if(active){exposed+=approved;exposedAccounts++;exposedOwners.add(r.owner);}
      }
      if(r.close&&r.close!==r.owner)link(r,r.close,'CLOSE_AUTHORITY',{account:r.account,balanceAtomic:r.balance.toString()});
    }
    const order=(a:Pair,b:Pair)=>a.owner.localeCompare(b.owner)||a.authority.localeCompare(b.authority)||a.kind.localeCompare(b.kind)||a.state.localeCompare(b.state);
    for(const p of pairs.values()){p.accounts.sort((a,b)=>a.account.localeCompare(b.account));if(p.kind==='TRANSFER_DELEGATE'&&!p.suspended)p.effectiveAtomic=p.accounts.reduce((s,a)=>s+BigInt(a.effectiveAtomic!),0n).toString();}
    const strong=[...pairs.values()].filter(p=>p.kind==='TRANSFER_DELEGATE'&&!p.suspended).sort(order),weak=[...pairs.values()].filter(p=>p.kind==='CLOSE_AUTHORITY'||p.suspended).sort(order);
    const strongEdges=strong.map((pair,i)=>({pair,ref:`strong:${i}`})),weakEdges=weak.map((pair,i)=>({pair,ref:`weak:${i}`}));
    const strongOnly=graph(strongEdges,positive,supply),withObservedWeak=graph([...strongEdges,...weakEdges],positive,supply);
    const keys=(list:Pair[])=>new Set(list.map(p=>p.authority)).size,accountsOf=(list:Pair[])=>list.reduce((n,p)=>n+p.accounts.length,0),close=weak.filter(p=>p.kind==='CLOSE_AUTHORITY');
    const summary={
      state:{genesis:'MAINNET_VERIFIED',program:mint.program,commitment:'finalized',mintSlot:mint.slot,populationSlot:holders.slot,decimals:mint.decimals},
      coverage,
      population:{accounts:rows.length,positiveAccounts:rows.filter(r=>r.balance>0n).length,owners:balances.size,positiveOwners:positive.size,complete:true,reconciledToSupply:true},
      supplyAtomic:supply.toString(),
      units:{balances:'raw mint atomic units',shares:'decimal fraction of full reconciled raw mint supply',associations:'owner-authority pairs aggregated over account-level proofs; refs strong:i and weak:i index the association arrays'},
      counts:{strongPairs:strong.length,strongAccounts:accountsOf(strong),strongAuthorities:keys(strong),suspendedPairs:weak.filter(p=>p.suspended).length,closeAuthorityPairs:close.length,closeAuthorityAccounts:accountsOf(close),closeAuthorities:keys(close)},
      approvedExposure:{accounts:exposedAccounts,owners:exposedOwners.size,effectiveAtomic:exposed.toString(),fractionOfSupply:share(exposed,supply),meaning:'Sum over distinct active accounts of min(balance, allowance); an SPL account holds at most one delegate, so no account is counted twice.'},
      sensitivity:{largestComponentShare:{strongOnly:strongOnly.largestComponentShare,withObservedWeak:withObservedWeak.largestComponentShare},associatedHolderShare:{strongOnly:strongOnly.associatedHolderShare,withObservedWeak:withObservedWeak.associatedHolderShare},ownersAddedByWeak:withObservedWeak.associatedOwners-strongOnly.associatedOwners},
      notCollected:['FUNDING','TRADING_BEHAVIOR','FEE_PAYER','ROUTER','TIMING','SOCIAL_IDENTITY','BENEFICIAL_OWNERSHIP'],
      meaning:'Explicit SPL authority grants observed in one complete finalized holder population. A strong TRANSFER_DELEGATE pair is an observed association that lets the delegate transfer or burn up to the effective amount; it does not prove the owners are one person or that the full balance is commonly controlled. Group shares are candidate associated holder supply, never proven controlled supply.',
      limitations:['Frozen-account delegate grants are suspended and weak: frozen accounts cannot transfer or burn.','Close authority on a positive balance is account maintenance only and cannot move that balance.','Self, zero-balance and zero-allowance links create no edge.','Token-2022 support covers only MetadataPointer/TokenMetadata mint extensions and ImmutableOwner account extensions; any other extension leaves O21 unresolved.','Single snapshot; earlier or later grants, revocations and associations outside SPL authority fields are not observed.','Mint binding relies on receipt scope plus per-account mint bytes; the mint account response carries no address.']
    };
    const data={...summary,strongAssociations:strong,weakAssociations:weak,graphs:{strongOnly,withObservedWeak}};
    if(Buffer.byteLength(JSON.stringify(data))>OUTPUT_LIMIT_BYTES)return metric(false,{status:'UNRESOLVED',...summary},'TOPOLOGY_OUTPUT_LIMIT_EXCEEDED');
    return metric(true,data,'EXPLICIT_AUTHORITY_ASSOCIATIONS_OBSERVED');
  }catch(error){
    if(error instanceof Unresolved)return metric(false,{status:'UNRESOLVED',reason:error.message},error.message);
    throw error;
  }
}
