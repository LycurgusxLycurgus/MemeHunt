import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import BN from 'bn.js';
import {Decimal} from 'decimal.js';
import {PublicKey,type AccountInfo} from '@solana/web3.js';
import {AccountLayout,MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,poolPda,pumpPoolAuthorityPda,computeFeesBps,sellBaseInput} from '@pump-fun/pump-swap-sdk';
import {attentionProposalSchema,attentionReviewSchema,deriveAttention} from '../domain/attention.js';
import type {AttentionRead} from './attention.js';
import type {TokenRef} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodeRawMintControls,solanaRpc,safeRpcCode,PUBLIC_SOLANA_RPC} from './solana.js';

export const EXIT_CAPACITY_SCOPE='CANONICAL_PUMPSWAP_INDEX0_WSOL' as const;
const iso=z.iso.datetime({offset:true}),token=z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1)}).strict();
const source=z.object({id:z.string().min(1),url:z.url(),text:z.string().min(8).max(120000),availableAt:iso}).strict();
const execution=z.object({executor:z.enum(['CODEX_NATIVE','CLAUDE_CODE']),invocationId:z.string().min(1),prompt:z.string(),response:z.string(),availableAt:iso}).strict();
export const a12CandidateSetSchema=z.object({method:z.literal('a12-reviewed-candidate-set-v1'),token,scope:z.object({description:z.string().min(8),queries:z.array(z.string().min(1)).min(1).max(8),routeUniverse:z.literal(EXIT_CAPACITY_SCOPE)}).strict(),sources:z.array(source).min(1).max(32),acquisition:z.object({complete:z.boolean(),sourceIds:z.array(z.string()),requests:z.array(z.object({url:z.url(),availableAt:iso,body:z.string()}).strict()).min(1).max(32)}).strict(),proposal:execution,review:execution}).strict();
export type A12CandidateSet=z.infer<typeof a12CandidateSetSchema>;
export function a12ProposalPrompt(packet:Pick<A12CandidateSet,'token'|'scope'|'sources'>){return JSON.stringify({instruction:'Identify every factual token representation of the declared same narrative in the complete declared source catalog, including the target. Exact literal contract address and narrative association must be supported by a literal source quote. Do not infer identity from a ticker alone. This is a bounded source-catalog candidate set, not exhaustive web or an entry evidence-sufficiency verdict. Return attentionProposalSchema JSON: {claims:[],posts:[],competitors:[{id,token:{chain,address},sourceId,quote}]}. Include all supported candidates; do not drop unsupported execution venues.',token:packet.token,scope:packet.scope,sources:packet.sources});}
export function a12ReviewPrompt(packet:Pick<A12CandidateSet,'token'|'scope'|'sources'>,proposal:unknown){return JSON.stringify({instruction:'Independently inspect every original source and proposed candidate. Verify exact contract plus same-narrative association in each literal quote, target membership, unique tokens, and complete factual membership for the whole declared source catalog. Reject ambiguous or omitted candidates; never certify absence outside the declared catalog. Return attentionReviewSchema JSON: {decisions:[{id,accepted,rationale}],candidateSet:{complete,rationale},originRelationship:{status:"UNKNOWN",citations:[],rationale}}. candidateSet.complete is true only if all catalog representations are accounted for and independently accepted. This is factual membership, not entry sufficiency.',token:packet.token,scope:packet.scope,sources:packet.sources,proposal});}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function bad():never{throw Error('ADVISORY_EXIT_CAPACITY_RECEIPT');}
/** Native/manual orchestration remains USER_IMPORT; no hosted-provider response is fabricated. */
export function qualifiedA12Candidates(input:unknown,target:TokenRef,cutoff:string){
 const p=a12CandidateSetSchema.parse(input),cut=Date.parse(cutoff);
 if(!isDeepStrictEqual(p.token,target)||new Set(p.sources.map(s=>s.id)).size!==p.sources.length||new Set(p.sources.map(s=>s.url)).size!==p.sources.length||!isDeepStrictEqual(p.acquisition.sourceIds,p.sources.map(s=>s.id))||p.acquisition.requests.length!==p.sources.length||p.proposal.invocationId===p.review.invocationId||p.proposal.executor===p.review.executor)bad();
 for(const [i,s]of p.sources.entries()){
  const u=new URL(s.url);if(u.protocol!=='https:'||u.username||u.password||!isDeepStrictEqual(p.acquisition.requests[i],{url:s.url,availableAt:s.availableAt,body:s.text})||Date.parse(s.availableAt)>Date.parse(p.proposal.availableAt)||Date.parse(s.availableAt)>cut||cut-Date.parse(s.availableAt)>900000)bad();
 }
 if(Date.parse(p.proposal.availableAt)>Date.parse(p.review.availableAt)||Date.parse(p.review.availableAt)>cut||p.proposal.prompt!==a12ProposalPrompt(p))bad();
 const proposal=attentionProposalSchema.parse(JSON.parse(p.proposal.response));
 if(proposal.claims.length||proposal.posts.length||p.review.prompt!==a12ReviewPrompt(p,proposal))bad();
 const review=attentionReviewSchema.parse(JSON.parse(p.review.response));
 if(review.entryDecisions||review.leadershipScreening)bad();
 const read:AttentionRead={sources:p.sources.map(s=>({...s,kind:'PAGE',publishedAt:null,authorId:null})),rawArtifacts:{},queries:p.scope.queries,complete:p.acquisition.complete,codes:[],start:p.sources[0]!.availableAt,end:p.review.availableAt};
 const factual=deriveAttention(read,proposal,review,target,cutoff,[]).find(a=>a.id==='A09')!;
 return {packet:p,candidates:proposal.competitors,complete:factual.quality==='KNOWN'&&review.candidateSet?.complete===true,sourceHash:hash(JSON.stringify(p))};
}

const U64=(1n<<64n)-1n,ceil=(a:bigint,b:bigint)=>(a+b-1n)/b,min=(...a:bigint[])=>a.reduce((x,y)=>x<y?x:y),max=(a:bigint,b:bigint)=>a>b?a:b;
export type CapacityCurve={base:bigint;physicalQuote:bigint;virtualQuote:bigint;sellDomain:bigint;fees:[bigint,bigint,bigint];impactBps:bigint};
export type CapacityBoundary={status:'KNOWN'|'TRUNCATED';inputAtomic:string|null;quoteAtomic:string|null;intervals:number;stop:string};
/** Exact quotient intervals avoid the nonmonotone dust/fee-rounded impact predicate.
 * For gross q=floor(E*x/(B+x)), all x lie in [ceil(qB/(E-q)),ceil((q+1)B/(E-q-1))-1].
 * Net(q) is fixed there. Fee-inclusive impact gives x<=floor(net(q)*B*10000/(E*(10000-L))).
 * The continuous fee bound gives x<=B*(L-F)/(10000-L), and net(q)<=floor(q*(10000-F)/10000).
 * Descending intervals stop only after that upper bound cannot improve the best net proceeds.
 */
export function solveExitCapacity(c:CapacityCurve,intervalCap=100000):CapacityBoundary{
 const {base:B,physicalQuote:P,virtualQuote:V,fees,impactBps:L}=c,E=P+V,F=fees.reduce((s,n)=>s+n,0n);
 if(B<=0n||P<=0n||V<0n||c.sellDomain<0n||c.sellDomain>U64||L<0n||L>=10000n||fees.some(f=>f<0n||f>10000n)||F>=10000n||!Number.isSafeInteger(intervalCap)||intervalCap<1)bad();
 const known=(x:bigint,q:bigint,n:number,stop:string):CapacityBoundary=>({status:'KNOWN',inputAtomic:String(x),quoteAtomic:String(q),intervals:n,stop});
 if(F>=L||!c.sellDomain)return known(0n,0n,0,'EMPTY_CONTINUOUS_DOMAIN');
 const fee=(q:bigint,f:bigint)=>ceil(q*f,10000n),net=(q:bigint)=>q-fees.reduce((s,f)=>s+fee(q,f),0n);
 const bound=min(c.sellDomain,B*(L-F)/(10000n-L)),gross=(x:bigint)=>E*x/(B+x);
 let lo=0n,hi=gross(bound);
 // Physical vault withdrawal q-LP(q) is monotone, unlike net impact.
 while(lo<hi){const mid=(lo+hi+1n)/2n;if(mid-fee(mid,fees[0])<=P)lo=mid;else hi=mid-1n;}
 let q=lo,best=0n,bestX=0n,intervals=0;
 while(q>0n&&q*(10000n-F)/10000n>best){
  if(intervals>=intervalCap)return {status:'TRUNCATED',inputAtomic:null,quoteAtomic:null,intervals,stop:'INTEGER_INTERVAL_CAP'};
  intervals++;
  const n=net(q),lower=max(1n,ceil(q*B,E-q)),upper=min(bound,q+1n>=E?bound:ceil((q+1n)*B,E-q-1n)-1n,n>0n?n*B*10000n/(E*(10000n-L)):0n);
  if(lower<=upper&&n>0n&&(n>best||n===best&&upper>bestX)){best=n;bestX=upper;}
  q--;
 }
 return known(bestX,best,intervals,q===0n?'EXHAUSTED_POSITIVE_QUOTE_DOMAIN':'REMAINING_NET_UPPER_BOUND');
}

type Request={method:string;params:unknown[]};
export type ExitCapacityReceipts={requests:Record<string,Request>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
export const EXIT_CAPACITY_REQUEST_CAP=2;
const poolKey=(t:TokenRef)=>poolPda(0,pumpPoolAuthorityPda(new PublicKey(t.address)),new PublicKey(t.address),NATIVE_MINT);
const request=(keys:string[],floor:number):Request=>({method:'getMultipleAccounts',params:[keys,{encoding:'base64',commitment:'finalized',minContextSlot:floor}]});
function info(v:any):AccountInfo<Buffer>{
 if(!v||typeof v.owner!=='string'||v.executable!==false||!Number.isSafeInteger(v.lamports)||v.lamports<0||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string')bad();
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])bad();return {data,owner:new PublicKey(v.owner),executable:false,lamports:v.lamports,rentEpoch:0};
}
function result(raw:string,count:number,floor:number){const r=JSON.parse(raw);if(r.error||r.jsonrpc!=='2.0'||r.id!==1||!Number.isSafeInteger(r.result?.context?.slot)||r.result.context.slot<floor||!Array.isArray(r.result?.value)||r.result.value.length!==count)bad();return r.result as {context:{slot:number};value:any[]};}
function discoveryKeys(candidates:ReturnType<typeof qualifiedA12Candidates>['candidates']){return [GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58(),...candidates.map(c=>poolKey(c.token).toBase58())];}
function bankKeys(candidates:ReturnType<typeof qualifiedA12Candidates>['candidates'],values:any[]){
 const keys=[GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58(),NATIVE_MINT.toBase58()];
 for(const [i,c]of candidates.entries()){
  if(values[i+2]===null)continue;
  const a=info(values[i+2]);if(!a.owner.equals(PUMP_AMM_PROGRAM_ID))bad();const p=PUMP_AMM_SDK.decodePool(a);
  keys.push(poolKey(c.token).toBase58(),c.token.address,p.poolBaseTokenAccount.toBase58(),p.poolQuoteTokenAccount.toBase58());
 }
 return [...new Set(keys)];
}
export async function collectExitCapacity(packet:unknown,target:TokenRef,impactBps:string|number|undefined,minSlot:number,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now=()=>new Date().toISOString(),signal?:AbortSignal):Promise<ExitCapacityReceipts>{
 const r:ExitCapacityReceipts={requests:{},rawArtifacts:{},retrievedAt:{}};
 const qualified=qualifiedA12Candidates(packet,target,now());
 if(!qualified.complete||qualified.candidates.length>10||qualified.candidates.some(c=>c.token.chain!=='solana')||impactBps===undefined)return r;
 const read=async(id:string,req:Request)=>{r.requests[id]=req;try{const v=await solanaRpc(url,req.method,req.params,fetcher,undefined,signal);r.rawArtifacts[id]=v.raw;}catch(e){r.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(e)}});}r.retrievedAt[id]=now();};
 const keys=discoveryKeys(qualified.candidates);await read('discovery',request(keys,minSlot));
 try{const d=result(r.rawArtifacts.discovery!,keys.length,minSlot),bank=bankKeys(qualified.candidates,d.value);await read('bank',request(bank,d.context.slot));}catch{/* Incomplete discovery stays an explicit unavailable capacity. */}
 return r;
}

export function deriveExitCapacity(input:unknown,target:TokenRef,cutoff:string,impactBps:string|number|undefined,r:ExitCapacityReceipts|null,evidenceIds:string[]):AdvisoryMetric{
 const base={method:'impact-bounded-native-exit-capacity-v1',level:'QUOTED',routeUniverse:EXIT_CAPACITY_SCOPE,quoteMint:NATIVE_MINT.toBase58(),quoteDecimals:9,impactBps:impactBps??null,impactReference:'fee-inclusive net quote versus pretrade effective-quote/base marginal price',externalCosts:'NOT_MODELLED',scope:'One canonical index0 WSOL PumpSwap pool per member of the complete declared factual source-catalog candidate set; other venues and best execution are not asserted.'};
 const missing=(reasonCode:string,candidates:unknown[]=[],status:'MISSING'|'TRUNCATED'='MISSING'):AdvisoryMetric=>({id:'A12',quality:status,unit:'fraction',data:{...base,candidates,share:null,denominatorAtomic:null},evidenceIds,reasonCode});
 if(!input)return missing('EXIT_CAPACITY_CANDIDATE_SET_NOT_COLLECTED');
 const q=qualifiedA12Candidates(input,target,cutoff),candidates=q.candidates.map(c=>({token:c.token,capacityAtomic:null as string|null,inputAtomic:null as string|null,status:'MISSING' as 'KNOWN'|'MISSING'|'TRUNCATED',reasonCode:'EXIT_CAPACITY_UNSUPPORTED_OR_UNAVAILABLE',pool:c.token.chain==='solana'?(()=>{try{return poolKey(c.token).toBase58();}catch{return null;}})():null,boundary:null as CapacityBoundary|null}));
 if(!q.complete)return missing('EXIT_CAPACITY_FACTUAL_CANDIDATE_SET_INCOMPLETE',candidates);
 if(!r||impactBps===undefined||candidates.some(c=>c.token.chain!=='solana'))return missing('EXIT_CAPACITY_DENOMINATOR_INCOMPLETE',candidates);
 const keys=Object.keys(r.requests).sort();if(keys.some(k=>!['discovery','bank'].includes(k))||!isDeepStrictEqual(keys,Object.keys(r.rawArtifacts).sort())||!isDeepStrictEqual(keys,Object.keys(r.retrievedAt).sort()))bad();
 if(!keys.length)return missing('EXIT_CAPACITY_NOT_COLLECTED',candidates);
 try{
  const dkeys=discoveryKeys(q.candidates),dreq=r.requests.discovery!,floor=(dreq.params[1] as any)?.minContextSlot;
  if(!Number.isSafeInteger(floor)||floor<0||!isDeepStrictEqual(dreq,request(dkeys,floor)))bad();
  const d=result(r.rawArtifacts.discovery!,dkeys.length,floor),bkeys=bankKeys(q.candidates,d.value);
  if(!r.requests.bank)return missing('EXIT_CAPACITY_BANK_UNAVAILABLE',candidates);
  if(!isDeepStrictEqual(r.requests.bank,request(bkeys,d.context.slot)))bad();
  const b=result(r.rawArtifacts.bank!,bkeys.length,d.context.slot),at=r.retrievedAt.bank!,cut=Date.parse(cutoff);
  if(Date.parse(q.packet.review.availableAt)>Date.parse(r.retrievedAt.discovery!)||Object.values(r.retrievedAt).some(t=>!Number.isFinite(Date.parse(t))||Date.parse(t)>cut)||Date.parse(r.retrievedAt.discovery!)>Date.parse(at)||cut-Date.parse(at)>30000)return missing('EXIT_CAPACITY_QUOTE_STALE',candidates);
  const lookup=(key:PublicKey)=>{const i=bkeys.indexOf(key.toBase58());if(i<0||b.value[i]===null)bad();return info(b.value[i]);};
  const g=lookup(GLOBAL_CONFIG_PDA),f=lookup(PUMP_AMM_FEE_CONFIG_PDA),qm=lookup(NATIVE_MINT);
  if(!g.owner.equals(PUMP_AMM_PROGRAM_ID)||!f.owner.equals(PUMP_FEE_PROGRAM_ID)||!qm.owner.equals(TOKEN_PROGRAM_ID)||qm.data.length!==82)bad();
  const globalConfig=PUMP_AMM_SDK.decodeGlobalConfig(g),feeConfig=PUMP_AMM_SDK.decodeFeeConfig(f),quoteMint=MintLayout.decode(qm.data);
  if(!quoteMint.isInitialized||quoteMint.decimals!==9)bad();
  const vaults=new Set<string>();
  for(const [i,c]of candidates.entries()){
   if(d.value[i+2]===null){c.reasonCode='EXIT_CAPACITY_CANONICAL_POOL_UNAVAILABLE';continue;}
   try{
    const mint=new PublicKey(c.token.address),pk=poolKey(c.token),pa=lookup(pk),ma=lookup(mint);
    if(!pa.owner.equals(PUMP_AMM_PROGRAM_ID)||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(ma.owner.toBase58()))bad();
    const p=PUMP_AMM_SDK.decodePool(pa),m=MintLayout.decode(ma.data),control=decodeRawMintControls({context:{slot:b.context.slot},value:{owner:ma.owner.toBase58(),data:[ma.data.toString('base64'),'base64']}});
    if(p.index!==0||!p.creator.equals(pumpPoolAuthorityPda(mint))||!p.baseMint.equals(mint)||!p.quoteMint.equals(NATIVE_MINT)||p.isMayhemMode||p.virtualQuoteReserves.isNeg()||globalConfig.disableFlags&16||!m.isInitialized||!control.complete||!control.transferAllowed||control.currentFeeBps!=='0'||!control.feeImmutable)bad();
    if(!p.poolBaseTokenAccount.equals(getAssociatedTokenAddressSync(mint,pk,true,ma.owner))||!p.poolQuoteTokenAccount.equals(getAssociatedTokenAddressSync(NATIVE_MINT,pk,true,TOKEN_PROGRAM_ID)))bad();
    for(const v of [p.poolBaseTokenAccount,p.poolQuoteTokenAccount]){if(vaults.has(v.toBase58()))throw Error('EXIT_CAPACITY_SHARED_ROUTE');vaults.add(v.toBase58());}
    const decodeVault=(key:PublicKey,owner:PublicKey,mint:PublicKey)=>{const a=lookup(key);if(!a.owner.equals(owner)||a.data.length<165)bad();const v=AccountLayout.decode(a.data);if(!v.mint.equals(mint)||!v.owner.equals(pk)||v.state!==1||v.delegateOption||v.closeAuthorityOption)bad();return v.amount;};
    const B=decodeVault(p.poolBaseTokenAccount,ma.owner,mint),P=decodeVault(p.poolQuoteTokenAccount,TOKEN_PROGRAM_ID,NATIVE_MINT);if(m.supply<B)bad();
    const args={baseReserve:new BN(String(B)),quoteReserve:new BN(String(P)),virtualQuoteReserves:p.virtualQuoteReserves,globalConfig,baseMintAccount:m,baseMint:mint,coinCreator:p.coinCreator,creator:p.creator,feeConfig,quoteMint:NATIVE_MINT,isMayhemMode:p.isMayhemMode,creatorFeeBps:p.creatorFeeBps,slippage:0};
    const rates=computeFeesBps({...args,baseMintSupply:new BN(String(m.supply)),quoteReserve:args.quoteReserve.add(p.virtualQuoteReserves)});
    const boundary=solveExitCapacity({base:B,physicalQuote:P,virtualQuote:BigInt(p.virtualQuoteReserves.toString()),sellDomain:m.supply-B,fees:[BigInt(rates.lpFeeBps.toString()),BigInt(rates.protocolFeeBps.toString()),p.coinCreator.equals(PublicKey.default)?0n:BigInt(rates.creatorFeeBps.toString())],impactBps:BigInt(impactBps)});
    c.boundary=boundary;c.status=boundary.status;c.reasonCode=boundary.status==='KNOWN'?'EXACT_QUOTED_CAPACITY_OBSERVED':'EXIT_CAPACITY_INTEGER_SEARCH_TRUNCATED';
    if(boundary.status==='KNOWN'){
     if(BigInt(boundary.inputAtomic!)>0n&&sellBaseInput({...args,base:new BN(boundary.inputAtomic!)}).uiQuote.toString()!==boundary.quoteAtomic)bad();
     c.capacityAtomic=boundary.quoteAtomic;c.inputAtomic=boundary.inputAtomic;
    }
   }catch(e){if(e instanceof Error&&e.message==='EXIT_CAPACITY_SHARED_ROUTE')return missing('EXIT_CAPACITY_SHARED_ROUTE_UNRESOLVED',candidates);c.reasonCode='EXIT_CAPACITY_POOL_UNSUPPORTED_OR_INVALID';c.capacityAtomic=null;c.inputAtomic=null;c.status='MISSING';}
  }
  if(candidates.some(c=>c.status!=='KNOWN'))return missing('EXIT_CAPACITY_DENOMINATOR_INCOMPLETE',candidates,candidates.some(c=>c.status==='TRUNCATED')?'TRUNCATED':'MISSING');
  const total=candidates.reduce((n,c)=>n+BigInt(c.capacityAtomic!),0n);
  if(candidates.length<2||!total)return missing(candidates.length<2?'EXIT_CAPACITY_MULTIPLE_CANDIDATES_REQUIRED':'EXIT_CAPACITY_POSITIVE_DENOMINATOR_REQUIRED',candidates);
  const targetCapacity=candidates.find(c=>isDeepStrictEqual(c.token,target))!;
  return {id:'A12',quality:'KNOWN',unit:'fraction',reasonCode:'COMPARABLE_QUOTED_EXIT_CAPACITY_SHARE_OBSERVED',evidenceIds,data:{...base,candidateSourceHash:q.sourceHash,stateSlot:b.context.slot,availableAt:at,expiresAt:new Date(Date.parse(at)+30000).toISOString(),candidates:candidates.map(c=>({...c,share:new Decimal(c.capacityAtomic!).div(total.toString()).toFixed()})),denominatorAtomic:String(total),share:new Decimal(targetCapacity.capacityAtomic!).div(total.toString()).toFixed()}};
 }catch{return missing('EXIT_CAPACITY_STATE_UNAVAILABLE_OR_INVALID',candidates);}
}
