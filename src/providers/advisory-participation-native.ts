import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda, lpMintPda } from '@pump-fun/pump-swap-sdk';
import { PUMP_SDK, bondingCurvePda } from '@pump-fun/pump-sdk';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import {createRequire} from 'node:module';
const dlmm=createRequire(import.meta.url)('@meteora-ag/dlmm') as typeof import('@meteora-ag/dlmm');
import BN from 'bn.js';
import { decodeHolderPopulation, decodeRawMintControls } from './solana.js';

export interface A13NativeRecord {
  id: string; raw: string; sha256: string; sourcePath: string;
  request?: { method: string; params: unknown[]; id?: unknown; jsonrpc?: string };
  availableAt: string; requestedAt?: string; httpStatus?: number;
}
export interface A13NativeInput {
  scopeRecordId: string; varianceRecordId: string;
  rounds: { T0: string[]; T1: string[] };
  roleCatalogRecordId: string; roleRecordIds: string[]; records: A13NativeRecord[];
}
export interface A13NativeCandidate {
  mint: string; label: string; rawP0: number; rawP1: number; excludedP0: number; excludedP1: number;
  adjustedP0: number; adjustedP1: number; excludedBalances0: string; excludedBalances1: string;
  entrants: number; leavers: number; common: number; delta: number; positiveGrowth: number;
  slot0: number; slot1: number; time0: number; time1: number; intervalSeconds: number;
  supplyAtomic0: string; supplyAtomic1: string; excludedOwners0: Record<string,string>; excludedOwners1: Record<string,string>;
}
export interface A13NativeResult {
  candidates: A13NativeCandidate[];
  controls: Array<{ mint: string; round: 'T0'|'T1'; status: 'INCOMPLETE'; httpStatus: number; rawCount: null; adjustedCount: null; recordId: string }>;
  coverage: { candidateCount: number; completeCandidates: number; fullSourceCountPerRound: number; fullStudyStatus: 'INCOMPLETE'; candidateSubfamilyStatus: 'COMPLETE'; nativeRecordIds: string[] };
  operator: { addressCount: number; addresses: string[]; kinds: Record<string,number>; premise: string };
  sourceTimes: { T0: {firstRequestAt: string; lastResponseAt: string; finishedAt: string; nativeSkewSeconds: number}; T1: {firstRequestAt: string; lastResponseAt: string; finishedAt: string; nativeSkewSeconds: number}; nominalTimerSeconds: number; actualGapSeconds: number; schedulingVarianceSeconds: number; exactFifteenMinuteObservation: false; variance: unknown };
}
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PUMP='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', DLMM='LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const A13_CANDIDATE_MINTS=['C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump','CXWNzqBE98SSmkGgHogJZd9vjsLdgaMAFpVfV22ypump','DffdPtAKvnP91k9Ct6QvZ8TwVvWbJ6CxRtGNGNh9pump','8999yFbaFmsyZSv9q7scLgAD1b1ELoDbrejjexo7pump','HKh5uh37FyRhRbDPcmPCoTcfByRLdY65RFZj9AvZpump','5m5whGqrK9hSAhmKUarwR7KkJRK6gLQiTyRrgtkGpump','7x4EfRQCFG1id7YZDNMbfcaZPMiaoNCZy6vTtXXmpump','83WuTBUf1vMDShCZyMD2PrDbd5ZY9DZVQd6vpfy1pump','8DYdcWGeJKLkSFVfyoPSgH3hjW3f3ZTGtLrNx2aqpump','HfSspmBgvTb5m4uMqcftkxwhXqzLGZYEaQ21HwYgpump'];
const CANDIDATES=A13_CANDIDATE_MINTS;
const CONTROLS=['3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump','DnMszBSMJhfh8St9Zhp4vABw9KFdFsNtyGWnt9rNpump'];
function check(value: unknown,code: string): asserts value { if(!value)throw new Error('A13_NATIVE_'+code); }
function object(x:unknown): x is Record<string,any> { return typeof x==='object'&&x!==null&&!Array.isArray(x); }
function same(a:unknown,b:unknown){return isDeepStrictEqual(a,b);}
function stamp(s:unknown){check(typeof s==='string'&&Number.isFinite(Date.parse(s)),'CLOCK');return Date.parse(s);}
function pub(s:unknown){check(typeof s==='string','ADDRESS');try{const p=new PublicKey(s);check(p.toBase58()===s,'ADDRESS');return p;}catch{throw new Error('A13_NATIVE_ADDRESS');}}
function slot(v:unknown){check(Number.isSafeInteger(v)&&Number(v)>=0,'SLOT');return Number(v);}
function bytes(a:any){check(object(a)&&a.executable===false&&typeof a.owner==='string'&&Array.isArray(a.data)&&a.data.length===2&&a.data[1]==='base64'&&typeof a.data[0]==='string','ACCOUNT');const b=Buffer.from(a.data[0],'base64');check(b.toString('base64')===a.data[0],'BASE64');return b;}
interface Role {address:string;kind:string;baseMint:string;quoteMint:string;vaultBase?:string;vaultQuote?:string;}
function role(address:string,a:any,mintHint:string):Role {
  const data=bytes(a),owner=pub(a.owner),key=pub(address),account={...a,owner,data};
  try{
    if(owner.equals(PUMP_AMM_PROGRAM_ID)){
      const p=PUMP_AMM_SDK.decodePool(account);check(poolPda(p.index,p.creator,p.baseMint,p.quoteMint).equals(key)&&p.lpMint.equals(lpMintPda(key)),'POOL_PDA');
      return {address,kind:'PUMPSWAP_POOL',baseMint:p.baseMint.toBase58(),quoteMint:p.quoteMint.toBase58(),vaultBase:p.poolBaseTokenAccount.toBase58(),vaultQuote:p.poolQuoteTokenAccount.toBase58()};
    }
    if(a.owner===PUMP){const p=PUMP_SDK.decodeBondingCurve(account),mint=pub(mintHint);check(bondingCurvePda(mint).equals(key),'CURVE_PDA');return {address,kind:'PUMP_BONDING_CURVE',baseMint:mint.toBase58(),quoteMint:p.quoteMint.toBase58()};}
    if(a.owner===DLMM){
      const p=new BorshAccountsCoder(dlmm.IDL as any).decode('LbPair',data) as any;
      const x=p.token_x_mint,y=p.token_y_mint,step=new BN(p.bin_step);
      const variants=[dlmm.deriveLbPairWithPresetParamWithIndexKey(p.base_key,x,y,owner)[0],dlmm.deriveLbPair2(x,y,step,new BN(Buffer.from(p.base_factor_seed),'le'),owner)[0],dlmm.deriveLbPair(x,y,step,owner)[0],dlmm.derivePermissionLbPair(p.base_key,x,y,step,owner)[0],dlmm.deriveCustomizablePermissionlessLbPair(x,y,owner)[0]];
      check(variants.some(v=>v.equals(key))&&dlmm.deriveReserve(x,key,owner)[0].equals(p.reserve_x)&&dlmm.deriveReserve(y,key,owner)[0].equals(p.reserve_y),'DLMM_PDA');
      return {address,kind:'METEORA_DLMM',baseMint:x.toBase58(),quoteMint:y.toBase58(),vaultBase:p.reserve_x.toBase58(),vaultQuote:p.reserve_y.toBase58()};
    }
  }catch(e){if(e instanceof Error&&e.message.startsWith('A13_NATIVE_'))throw e;throw new Error('A13_NATIVE_PROTOCOL_STATE');}
  throw new Error('A13_NATIVE_PROTOCOL_OWNER');
}
interface Endpoint {raw:number;adjusted:Map<string,bigint>;excluded:Map<string,bigint>;slot:number;time:number;program:string;decimals:number;supply:string;}
/** Reconstructs native observations only. Semantic membership and ratio quality belong to the source composer. */
export function reconstructA13NativeParticipation(input:A13NativeInput,cutoff:string):A13NativeResult {
  const end=stamp(cutoff),records=new Map<string,A13NativeRecord>();
  for(const r of input.records){check(!records.has(r.id),'DUPLICATE_RECORD');check(createHash('sha256').update(r.raw).digest('hex')===r.sha256,'HASH');check(stamp(r.availableAt)<=end,'AVAILABILITY');if(r.requestedAt)check(stamp(r.requestedAt)<=stamp(r.availableAt),'REQUEST_CLOCK');records.set(r.id,r);}
  const get=(id:string)=>{const r=records.get(id);check(r,'MISSING_RECORD');return r;};
  const parse=(r:A13NativeRecord)=>{try{return JSON.parse(r.raw);}catch{throw new Error('A13_NATIVE_JSON');}};
  const scope=parse(get(input.scopeRecordId));check(object(scope)&&Array.isArray(scope.tokens)&&scope.tokens.length===12,'SCOPE');
  const mints=scope.tokens.map((t:any)=>t?.token?.address);check(same(mints,[...CANDIDATES,...CONTROLS]),'FINITE_FRAME');
  check(scope.cadenceSeconds===900&&scope.automaticRetries===0&&scope.maximumStudyElapsedSeconds===1500,'STUDY_RULE');
  const frozen=stamp(scope.frozenAt),excluded=scope.fixedExcludedAddresses;check(Array.isArray(excluded)&&excluded.length===42&&new Set(excluded).size===42,'OPERATOR');excluded.forEach(pub);
  // The adopted operator is a frozen source-study input, not a producer-selected set.
  check(createHash('sha256').update(JSON.stringify(excluded)).digest('hex')==='bbe50a34951dbd201da17c6932e7d82c43949a1943413fd6dc262ddbf2389d1a','FROZEN_OPERATOR');
  const variance=parse(get(input.varianceRecordId));check(object(variance),'EXECUTION_VARIANCE');
  const rpc=(r:A13NativeRecord,method?:string)=>{check(r.request&&(!method||r.request.method===method),'REQUEST');check(r.httpStatus===undefined||r.httpStatus===200,'HTTP');const v=parse(r);check(object(v)&&v.jsonrpc==='2.0'&&(!('id'in r.request)||same(v.id,r.request.id))&&!('error'in v)&&'result'in v,'RPC_ENVELOPE');return v.result;};
  const bank=(r:A13NativeRecord)=>{const v=rpc(r,'getMultipleAccounts'),q=r.request!.params;check(Array.isArray(q[0])&&object(q[1])&&q[1].encoding==='base64'&&q[1].commitment==='finalized'&&object(v)&&object(v.context)&&Array.isArray(v.value)&&v.value.length===q[0].length,'BANK');check(new Set(q[0]).size===q[0].length,'DUPLICATE_BANK_ADDRESS');const s=slot(v.context.slot);if('minContextSlot'in q[1])check(s>=slot(q[1].minContextSlot),'BANK_FLOOR');return {v,keys:q[0] as string[],slot:s};};
  const roleRecords=input.roleRecordIds.map(get);check(new Set(input.roleRecordIds).size===input.roleRecordIds.length,'DUPLICATE_ROLE_RECORD');
  const catalog=parse(get(input.roleCatalogRecordId));check(object(catalog)&&Array.isArray(catalog.rows)&&catalog.rows.length===42,'ROLE_CATALOG');
  const roles=new Map<string,Role>(),usedRole=new Set<string>();
  for(const row of catalog.rows){check(object(row)&&typeof row.address==='string'&&object(row.identity)&&object(row.identity.source),'ROLE_LOCATOR');const src=row.identity.source;const matches=roleRecords.filter(r=>r.sha256===src.sourceHash&&same(r.request?.method,src.request?.method)&&same(r.request?.params,src.request?.params));check(matches.length===1,'ROLE_SOURCE');const r=matches[0]!;usedRole.add(r.id);check(stamp(r.availableAt)<frozen,'ROLE_PRECEDES_SCOPE');const b=bank(r),i=b.keys.indexOf(row.address);check(i>=0&&b.keys.lastIndexOf(row.address)===i&&b.v.value[i]!==null,'ROLE_ADDRESS');check(!roles.has(row.address),'DUPLICATE_ROLE');roles.set(row.address,role(row.address,b.v.value[i],row.identity.baseMint));}
  check(same([...roles.keys()],excluded),'EXACT_FIXED_OPERATOR');
  // Auxiliary genesis/time records are independently bound; all supplied role records must have a declared use.
  for(const r of roleRecords){if(usedRole.has(r.id))continue;if(r.request?.method==='getGenesisHash'){check(same(r.request.params,[])&&rpc(r)===GENESIS,'ROLE_GENESIS');usedRole.add(r.id);}else if(r.request?.method==='getBlockTime'){const n=rpc(r),s=r.request.params[0];check(Number.isSafeInteger(n)&&Number(n)*1000<=stamp(r.availableAt)&&roleRecords.some(q=>q.request?.method==='getMultipleAccounts'&&bank(q).slot===s),'ROLE_NATIVE_TIME');usedRole.add(r.id);}else throw new Error('A13_NATIVE_ORPHAN_ROLE_RECORD');}
  check(usedRole.size===roleRecords.length,'ORPHAN_ROLE_RECORD');
  const endpoints:{T0:Map<string,Endpoint>;T1:Map<string,Endpoint>}={T0:new Map(),T1:new Map()};
  const controls:A13NativeResult['controls']=[],roundTimes={} as Record<'T0'|'T1',{firstRequestAt:string;lastResponseAt:string;finishedAt:string;nativeSkewSeconds:number}>;
  const nativeIds=[input.scopeRecordId,input.varianceRecordId,input.roleCatalogRecordId,...input.roleRecordIds,...input.rounds.T0,...input.rounds.T1];check(new Set(nativeIds).size===nativeIds.length,'RECORD_REUSE');
  for(const round of ['T0','T1'] as const){
    const rs=input.rounds[round].map(get);check(rs.length<=32&&rs.length>0,'ROUND_SIZE');
    const byMethod=(m:string)=>rs.filter(r=>r.request?.method===m);
    const genesis=byMethod('getGenesisHash');check(genesis.length===1&&same(genesis[0]!.request!.params,[])&&rpc(genesis[0]!)===GENESIS,'GENESIS');
    for(let i=0;i<rs.length;i++){const r=rs[i]!;check(r.requestedAt&&stamp(r.requestedAt)>=frozen,'ROUND_CLOCK');if(i)check(stamp(rs[i-1]!.availableAt)<=stamp(r.requestedAt),'SEQUENTIAL_CLOCK');}
    const banks=byMethod('getMultipleAccounts');check(banks.length===2,'TWO_MINT_BANKS');const pre=bank(banks[0]!),post=bank(banks[1]!);check(roleRecords.filter(r=>r.request?.method==='getMultipleAccounts').every(r=>bank(r).slot<pre.slot),'ROLE_NATIVE_PRECEDES_ENDPOINT');check(same(pre.keys,mints)&&same(post.keys,mints),'MINT_BANK_IDENTITIES');
    const populations=byMethod('getProgramAccounts');check(populations.length===12,'POPULATION_VECTOR');const times=byMethod('getBlockTime');const used=new Set<string>([genesis[0]!.id,...banks.map(r=>r.id)]);const nativeTimes:number[]=[],populationSlots:number[]=[];
    for(let i=0;i<mints.length;i++){
      const mint=mints[i]!,before=pre.v.value[i],after=post.v.value[i],b0=bytes(before),b1=bytes(after);check([TOKEN,TOKEN22].includes(before.owner)&&before.owner===after.owner&&b0.length>=82&&b1.length>=82&&b0[45]===1&&b1[45]===1,'MINT');
      check(b0.subarray(0,82).equals(b1.subarray(0,82)),'ROUND_MINT_CORE_SUPPLY');
      const ctl0=decodeRawMintControls({context:pre.v.context,value:before},[]),ctl1=decodeRawMintControls({context:post.v.context,value:after},[]);check(same(ctl0,ctl1),'ROUND_MINT_CONTROLS');
      const ps=populations.filter(r=>{const cfg=r.request?.params[1];return object(cfg)&&Array.isArray(cfg.filters)&&cfg.filters[0]?.memcmp?.bytes===mint;});check(ps.length===1,'EXACT_POPULATION');const p=ps[0]!,cfg=p.request!.params[1];const filters=[{memcmp:{offset:0,bytes:mint}},...(before.owner===TOKEN?[{dataSize:165}]:[])];check(p.request!.params[0]===before.owner&&same(cfg,{encoding:'base64',commitment:'finalized',withContext:true,minContextSlot:pre.slot,filters}),'POPULATION_REQUEST');used.add(p.id);
      if(i>=10){const failure=parse(p);check(p.httpStatus===429&&object(failure)&&failure.jsonrpc==='2.0'&&same(failure.id,p.request!.id)&&object(failure.error)&&failure.error.code===429,'CONTROL_FAILURE');controls.push({mint,round,status:'INCOMPLETE',httpStatus:429,rawCount:null,adjustedCount:null,recordId:p.id});continue;}
      const v=rpc(p,'getProgramAccounts'),s=slot(v?.context?.slot);check(s>=pre.slot&&s<=post.slot,'POPULATION_SLOT');populationSlots.push(s);
      check(Array.isArray(v?.value),'POPULATION_BODY');for(const item of v.value){check(object(item),'POPULATION_ACCOUNT');bytes(item.account);}const supply=b0.readBigUInt64LE(36).toString(),holders=decodeHolderPopulation(v,mint,before.owner,supply,pre.slot);const owners=new Map<string,bigint>();
      for(const h of holders.accounts){const units=BigInt(h.amount);owners.set(h.owner,(owners.get(h.owner)??0n)+units);const op=roles.get(h.owner);if(op&&units>0n){check(op.baseMint===mint||op.quoteMint===mint,'OPERATIONAL_MINT');let expected=op.baseMint===mint?op.vaultBase:op.vaultQuote;if(op.kind==='PUMP_BONDING_CURVE')expected=getAssociatedTokenAddressSync(pub(mint),pub(h.owner),true,pub(before.owner)).toBase58();check(expected===h.address,'OPERATIONAL_LITERAL_VAULT');}}
      const positive=new Map([...owners].filter(([,n])=>n>0n)),adjusted=new Map([...positive].filter(([k])=>!roles.has(k))),removed=new Map([...positive].filter(([k])=>roles.has(k)));
      const ts=times.filter(r=>same(r.request!.params,[s]));check(ts.length===1,'NATIVE_TIME');used.add(ts[0]!.id);const t=rpc(ts[0]!,'getBlockTime');check(Number.isSafeInteger(t)&&t*1000<=stamp(p.availableAt),'NATIVE_TIME_CLOCK');nativeTimes.push(t);
      endpoints[round].set(mint,{raw:positive.size,adjusted,excluded:removed,slot:s,time:t,program:before.owner,decimals:b0[44]!,supply});
    }
    check(post.slot>=Math.max(...populationSlots)&&(banks[1]!.request!.params[1] as any).minContextSlot===Math.max(...populationSlots),'POST_BANK_FLOOR');
    check(used.size===rs.length&&rs.every(r=>used.has(r.id)),'ORPHAN_ROUND_RECORD');
    const firstRequestAt=rs[0]!.requestedAt!,lastResponseAt=rs.at(-1)!.availableAt,finishedAt=variance[`${round}FinishedAt`];
    // RPC availability and acquisition completion are distinct observed clocks:
    // writing/processing the round follows the last response and precedes the timer.
    check(typeof finishedAt==='string'&&stamp(finishedAt)>=stamp(lastResponseAt)&&stamp(finishedAt)<=end,'ACQUISITION_COMPLETION_CLOCK');
    check(stamp(finishedAt)-stamp(firstRequestAt)<=300000,'ROUND_BOUND');roundTimes[round]={firstRequestAt,lastResponseAt,finishedAt,nativeSkewSeconds:Math.max(...nativeTimes)-Math.min(...nativeTimes)};
  }
  const resultCandidates:A13NativeCandidate[]=CANDIDATES.map((mint,i)=>{const a=endpoints.T0.get(mint)!,b=endpoints.T1.get(mint)!;check(a.program===b.program&&a.decimals===b.decimals&&b.slot>a.slot&&b.time>a.time,'ENDPOINT_ORDER');const common=[...a.adjusted.keys()].filter(k=>b.adjusted.has(k)).length,entrants=b.adjusted.size-common,leavers=a.adjusted.size-common,delta=b.adjusted.size-a.adjusted.size;return {mint,label:scope.tokens[i].label,rawP0:a.raw,rawP1:b.raw,excludedP0:a.excluded.size,excludedP1:b.excluded.size,adjustedP0:a.adjusted.size,adjustedP1:b.adjusted.size,excludedBalances0:[...a.excluded.values()].reduce((s,n)=>s+n,0n).toString(),excludedBalances1:[...b.excluded.values()].reduce((s,n)=>s+n,0n).toString(),entrants,leavers,common,delta,positiveGrowth:Math.max(delta,0),slot0:a.slot,slot1:b.slot,time0:a.time,time1:b.time,intervalSeconds:b.time-a.time,supplyAtomic0:a.supply,supplyAtomic1:b.supply,excludedOwners0:Object.fromEntries([...a.excluded].map(([k,n])=>[k,n.toString()])),excludedOwners1:Object.fromEntries([...b.excluded].map(([k,n])=>[k,n.toString()]))};});
  const gap=(stamp(roundTimes.T1.firstRequestAt)-stamp(roundTimes.T0.finishedAt))/1000;check(gap>=900&&stamp(roundTimes.T1.finishedAt)-stamp(roundTimes.T0.firstRequestAt)<=1500000,'STUDY_INTERVAL');
  check(object(variance)&&variance.scheduledWaitSeconds===900&&variance.T0FinishedAt===roundTimes.T0.finishedAt&&variance.T1FirstRequestAt===roundTimes.T1.firstRequestAt&&variance.T1FinishedAt===roundTimes.T1.finishedAt&&variance.observedWallGapSeconds===gap&&variance.frozenWholeStudyBoundSeconds===1500&&typeof variance.observedWholeMonotonicElapsedSeconds==='number'&&variance.observedWholeMonotonicElapsedSeconds>=0&&variance.observedWholeMonotonicElapsedSeconds<=1500,'EXECUTION_VARIANCE_BINDING');
  const kinds:Record<string,number>={};for(const r of roles.values())kinds[r.kind]=(kinds[r.kind]??0)+1;check(kinds.PUMPSWAP_POOL===16&&kinds.METEORA_DLMM===4&&kinds.PUMP_BONDING_CURVE===22,'OPERATOR_KINDS');
  return {candidates:resultCandidates,controls,coverage:{candidateCount:10,completeCandidates:10,fullSourceCountPerRound:12,fullStudyStatus:'INCOMPLETE',candidateSubfamilyStatus:'COMPLETE',nativeRecordIds:nativeIds},operator:{addressCount:42,addresses:excluded,kinds,premise:'FIXED_NATIVE_PROTOCOL_ADDRESS_PROXY_NONEXHAUSTIVE_NOT_PEOPLE_OR_LATENT_ROLE'},sourceTimes:{...roundTimes,nominalTimerSeconds:900,actualGapSeconds:gap,schedulingVarianceSeconds:(stamp(roundTimes.T1.firstRequestAt)-stamp(roundTimes.T0.finishedAt)-900000)/1000,exactFifteenMinuteObservation:false,variance}};
}
