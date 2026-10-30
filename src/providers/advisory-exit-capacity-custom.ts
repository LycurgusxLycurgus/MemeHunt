import {z} from 'zod';
import {decodeA12ZeroWitnessCapture} from './advisory-exit-capacity-witness.js';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import BN from 'bn.js';
import {Decimal} from 'decimal.js';
import {PublicKey,type AccountInfo} from '@solana/web3.js';
import {AccountLayout,MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,poolPda,pumpPoolAuthorityPda,computeFeesBps,sellBaseInput} from '@pump-fun/pump-swap-sdk';
import {solveExitCapacity,qualifiedA12Candidates as qualifiedLegacy,a12CandidateSetSchema as legacySchema,type CapacityBoundary} from './advisory-exit-capacity.js';
import {attentionProposalSchema,attentionReviewSchema,deriveAttention} from '../domain/attention.js';
import type {AttentionRead} from './attention.js';
import type {TokenRef} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodeRawMintControls,solanaRpc,safeRpcCode,PUBLIC_SOLANA_RPC} from './solana.js';

export const EXIT_CAPACITY_SCOPE='CANONICAL_PUMPSWAP_INDEX0_QUOTE_MINT' as const;
const iso=z.iso.datetime({offset:true}),token=z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1)}).strict();
const source=z.object({id:z.string().min(1),url:z.url(),text:z.string().min(8).max(120000),availableAt:iso}).strict();
const execution=z.object({executor:z.enum(['CODEX_NATIVE','CLAUDE_CODE']),invocationId:z.string().min(1),prompt:z.string(),response:z.string(),availableAt:iso}).strict();
const customSchema=z.object({method:z.literal('a12-reviewed-candidate-set-v2'),token,scope:z.object({description:z.string().min(8),queries:z.array(z.string().min(1)).min(1).max(8),routeUniverse:z.literal(EXIT_CAPACITY_SCOPE)}).strict(),sources:z.array(source).min(1).max(32),acquisition:z.object({complete:z.boolean(),sourceIds:z.array(z.string()),requests:z.array(z.object({url:z.url(),availableAt:iso,body:z.string()}).strict()).min(1).max(32)}).strict(),proposal:execution,review:execution,routeHints:z.array(z.object({token,pool:z.string().min(1),quoteMint:z.string().min(1),sourceId:z.string().min(1),quote:z.string().min(1)}).strict()).max(10).optional()}).strict();
export const a12CandidateSetSchema=z.union([legacySchema,customSchema]);
export type A12CandidateSet=z.infer<typeof a12CandidateSetSchema>;
export function a12ProposalPrompt(packet:Pick<A12CandidateSet,'token'|'scope'|'sources'>){return JSON.stringify({instruction:'Identify every factual token representation of the declared same narrative in the complete declared source catalog, including the target. Exact literal contract address and narrative association must be supported by a literal source quote. Do not infer identity from a ticker alone. This is a bounded source-catalog candidate set, not exhaustive web or an entry evidence-sufficiency verdict. Return attentionProposalSchema JSON: {claims:[],posts:[],competitors:[{id,token:{chain,address},sourceId,quote}]}. Include all supported candidates; do not drop unsupported execution venues.',token:packet.token,scope:packet.scope,sources:packet.sources});}
export function a12ReviewPrompt(packet:Pick<A12CandidateSet,'token'|'scope'|'sources'>,proposal:unknown){return JSON.stringify({instruction:'Independently inspect every original source and proposed candidate. Verify exact contract plus same-narrative association in each literal quote, target membership, unique tokens, and complete factual membership for the whole declared source catalog. Reject ambiguous or omitted candidates; never certify absence outside the declared catalog. Return attentionReviewSchema JSON: {decisions:[{id,accepted,rationale}],candidateSet:{complete,rationale},originRelationship:{status:"UNKNOWN",citations:[],rationale}}. candidateSet.complete is true only if all catalog representations are accounted for and independently accepted. This is factual membership, not entry sufficiency.',token:packet.token,scope:packet.scope,sources:packet.sources,proposal});}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function bad():never{throw Error('ADVISORY_EXIT_CAPACITY_RECEIPT');}
/** Native/manual orchestration remains USER_IMPORT; no hosted-provider response is fabricated. */
export function qualifiedA12Candidates(input:unknown,target:TokenRef,cutoff:string){
 const p=a12CandidateSetSchema.parse(input);
 if(p.method==='a12-reviewed-candidate-set-v1')return qualifiedLegacy(input,target,cutoff);
 const cut=Date.parse(cutoff);
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
 const hinted=new Set<string>();
 for(const h of p.routeHints??[]){const c=proposal.competitors.find(c=>isDeepStrictEqual(c.token,h.token)),s=p.sources.find(s=>s.id===h.sourceId);if(!c||h.token.chain!=='solana'||hinted.has(h.token.address)||!s||!s.text.includes(h.quote)||![h.token.address,h.pool,h.quoteMint].every(x=>h.quote.includes(x)))bad();hinted.add(h.token.address);const mint=new PublicKey(h.token.address),quoteMint=new PublicKey(h.quoteMint);if(!poolPda(0,pumpPoolAuthorityPda(mint),mint,quoteMint).equals(new PublicKey(h.pool)))bad();}
 return {packet:p,candidates:proposal.competitors,complete:factual.quality==='KNOWN'&&review.candidateSet?.complete===true,sourceHash:hash(JSON.stringify(p))};
}

type Request={method:string;params:unknown[]};
export type ExitCapacityReceipts={requests:Record<string,Request>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
export const EXIT_CAPACITY_REQUEST_CAP=2;
type Qualified=ReturnType<typeof qualifiedA12Candidates>;
/** Native route data only: qualification remains the responsibility of each public wrapper. */
type NativeCapacityPlan={members:Array<{token:TokenRef;route:{pool:string|null;quoteMint:string}}>;sourceHash:string;sourceReadyAt:string};
function capacityRoutes(members:Array<{token:TokenRef}>,hints:Array<{token:TokenRef;pool:string;quoteMint:string}>):NativeCapacityPlan['members']{
 return members.map(c=>{const hint=hints.find(h=>isDeepStrictEqual(h.token,c.token));return {token:c.token,route:{pool:hint?.pool??null,quoteMint:hint?.quoteMint??NATIVE_MINT.toBase58()}};});
}
function capacityPlan(members:Array<{token:TokenRef}>,hints:Array<{token:TokenRef;pool:string;quoteMint:string}>,sourceHash:string,sourceReadyAt:string):NativeCapacityPlan{return {members:capacityRoutes(members,hints),sourceHash,sourceReadyAt};}
function legacyPlan(q:Qualified){return capacityPlan(q.candidates,q.packet.method==='a12-reviewed-candidate-set-v2'?q.packet.routeHints??[]:[],q.sourceHash,q.packet.review.availableAt);}
const route=(plan:Pick<NativeCapacityPlan,'members'>,t:TokenRef)=>{const r=plan.members.find(c=>isDeepStrictEqual(c.token,t))?.route;if(!r)bad();const mint=new PublicKey(t.address),quoteMint=new PublicKey(r.quoteMint);return {quoteMint,pool:poolPda(0,pumpPoolAuthorityPda(mint),mint,quoteMint)};};
const request=(keys:string[],floor:number):Request=>({method:'getMultipleAccounts',params:[keys,{encoding:'base64',commitment:'finalized',minContextSlot:floor}]});
function info(v:any):AccountInfo<Buffer>{
 if(!v||typeof v.owner!=='string'||v.executable!==false||!Number.isSafeInteger(v.lamports)||v.lamports<0||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string')bad();
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])bad();return {data,owner:new PublicKey(v.owner),executable:false,lamports:v.lamports,rentEpoch:0};
}
function result(raw:string,count:number,floor:number){const r=JSON.parse(raw);if(r.error||r.jsonrpc!=='2.0'||r.id!==1||!Number.isSafeInteger(r.result?.context?.slot)||r.result.context.slot<floor||!Array.isArray(r.result?.value)||r.result.value.length!==count)bad();return r.result as {context:{slot:number};value:any[]};}
function discoveryKeys(q:NativeCapacityPlan){return [GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58(),...q.members.map(c=>route(q,c.token).pool.toBase58())];}
function bankKeys(q:NativeCapacityPlan,values:any[]){
 const keys=[GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58()];
 for(const [i,c]of q.members.entries()){
  if(values[i+2]===null)continue;
  const a=info(values[i+2]);if(!a.owner.equals(PUMP_AMM_PROGRAM_ID))bad();const p=PUMP_AMM_SDK.decodePool(a);
  const expected=route(q,c.token);if(p.index!==0||!p.baseMint.equals(new PublicKey(c.token.address))||!p.quoteMint.equals(expected.quoteMint)||!p.creator.equals(pumpPoolAuthorityPda(new PublicKey(c.token.address))))bad();
  keys.push(expected.pool.toBase58(),c.token.address,p.quoteMint.toBase58(),p.poolBaseTokenAccount.toBase58(),p.poolQuoteTokenAccount.toBase58());
 }
 return [...new Set(keys)];
}
/** Exact current ordinary-transfer surface. This does not certify future authority actions or simulation. */
function extensions(a:AccountInfo<Buffer>,kind:1|2){
 const d=a.data,span=kind===1?82:165;
 if(![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(a.owner.toBase58())||d.length<span)bad();
 const out=new Map<number,Buffer>();if(a.owner.equals(TOKEN_PROGRAM_ID)){if(d.length!==span)bad();return out;}
 if(d.length===span)return out;
 if(d.length<166||d[165]!==kind||kind===1&&d.subarray(82,165).some(x=>x!==0))bad();let at=166;
 while(at<d.length){if(d.subarray(at).every(x=>x===0))break;if(at+4>d.length)bad();const type=d.readUInt16LE(at),len=d.readUInt16LE(at+2);at+=4;if(!type||out.has(type)||at+len>d.length)bad();out.set(type,d.subarray(at,at+len));at+=len;}
 return out;
}
export function quoteAdmission(a:AccountInfo<Buffer>){
 const ext=extensions(a,1),m=MintLayout.decode(a.data),risks:Record<string,string|null>={};
 if(!m.isInitialized||![0,1].includes(m.mintAuthorityOption)||![0,1].includes(m.freezeAuthorityOption))bad();
 risks.mintAuthority=m.mintAuthorityOption?m.mintAuthority.toBase58():null;risks.freezeAuthority=m.freezeAuthorityOption?m.freezeAuthority.toBase58():null;
 const optional=(d:Buffer)=>d.some(x=>x!==0)?new PublicKey(d).toBase58():null;
 for(const [type,d]of ext){
  const len=(n:number)=>{if(d.length!==n)throw Error('EXIT_CAPACITY_QUOTE_EXTENSION_INVALID');};
  if(type===18)len(64);
  else if(type===19){if(d.length<80)bad();}
  else if(type===6){len(1);if(d[0]!==1)throw Error('EXIT_CAPACITY_QUOTE_DEFAULT_FROZEN');}
  else if(type===12){len(32);risks.permanentDelegate=optional(d);}
  else if(type===14){len(64);risks.transferHookAuthority=optional(d.subarray(0,32));if(d.subarray(32).some(x=>x!==0))throw Error('EXIT_CAPACITY_QUOTE_ACTIVE_TRANSFER_HOOK');}
  else if(type===26){len(33);risks.pauseAuthority=optional(d.subarray(0,32));if(d[32]!==0)throw Error('EXIT_CAPACITY_QUOTE_PAUSED');}
  else if(type===25){len(56);risks.scaledUiAuthority=optional(d.subarray(0,32));if(d.readDoubleLE(32)!==1||d.readBigUInt64LE(40)!==0n||d.readDoubleLE(48)!==1)throw Error('EXIT_CAPACITY_QUOTE_SCALED_UI_UNSUPPORTED');}
  else if(type===4){len(65);risks.confidentialTransferAuthority=optional(d.subarray(0,32));if(d[32]!==0)throw Error('EXIT_CAPACITY_QUOTE_CONFIDENTIAL_CONFIG_UNSUPPORTED');}
  else throw Error('EXIT_CAPACITY_QUOTE_EXTENSION_UNSUPPORTED');
 }
 return {mint:m,extensions:ext,method:'current-ordinary-quote-transfer-v1' as const,authorityRisks:risks,activeTransferHook:false,paused:false,uiMultiplier:'1',destinationAssumption:'ordinary initialized unfrozen token account without additional transfer restrictions'};
}
export function validateVaultData(a:AccountInfo<Buffer>,quote?:ReturnType<typeof quoteAdmission>){
 const ext=extensions(a,2);
 for(const [type,d]of ext){
  if(type===7&&d.length===0)continue;
  if(quote&&type===15&&d.length===1&&d[0]===0&&quote.extensions.has(14))continue;
  if(quote&&type===27&&d.length===0&&quote.extensions.has(26))continue;
  throw Error('EXIT_CAPACITY_VAULT_EXTENSION_UNSUPPORTED');
 }
 if(quote&&(quote.extensions.has(14)&&!ext.has(15)||quote.extensions.has(26)&&!ext.has(27)))throw Error('EXIT_CAPACITY_VAULT_REQUIRED_EXTENSION_MISSING');
}
export async function collectExitCapacity(packet:unknown,target:TokenRef,impactBps:string|number|undefined,minSlot:number,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now=()=>new Date().toISOString(),signal?:AbortSignal):Promise<ExitCapacityReceipts>{
 const qualified=qualifiedA12Candidates(packet,target,now());
 if(!qualified.complete||qualified.candidates.length>10||qualified.candidates.some(c=>c.token.chain!=='solana')||impactBps===undefined)return {requests:{},rawArtifacts:{},retrievedAt:{}};
 return collectCapacityPlan(legacyPlan(qualified),minSlot,url,fetcher,now,signal);
}
async function collectCapacityPlan(plan:NativeCapacityPlan,minSlot:number,url:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<ExitCapacityReceipts>{
 const r:ExitCapacityReceipts={requests:{},rawArtifacts:{},retrievedAt:{}};
 const read=async(id:string,req:Request)=>{r.requests[id]=req;try{const v=await solanaRpc(url,req.method,req.params,fetcher,undefined,signal);r.rawArtifacts[id]=v.raw;}catch(e){r.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(e)}});}r.retrievedAt[id]=now();};
 const keys=discoveryKeys(plan);await read('discovery',request(keys,minSlot));
 try{const d=result(r.rawArtifacts.discovery!,keys.length,minSlot),bank=bankKeys(plan,d.value);await read('bank',request(bank,d.context.slot));}catch{/* Incomplete discovery stays an explicit unavailable capacity. */}
 return r;
}

export function deriveExitCapacity(input:unknown,target:TokenRef,cutoff:string,impactBps:string|number|undefined,r:ExitCapacityReceipts|null,evidenceIds:string[],zeroTargetComparison=false):AdvisoryMetric{
 const base={method:'impact-bounded-quote-exit-capacity-v2',level:'QUOTED',routeUniverse:EXIT_CAPACITY_SCOPE,quoteMint:null as string|null,quoteDecimals:null as number|null,impactBps:impactBps??null,impactReference:'fee-inclusive net quote versus pretrade effective-quote/base marginal price',externalCosts:'NOT_MODELLED',scope:'One canonical index0 quote-mint-verified PumpSwap pool per member of the complete declared factual source-catalog candidate set; other venues and best execution are not asserted.'};
 const missing=(reasonCode:string,candidates:unknown[]=[],status:'MISSING'|'TRUNCATED'='MISSING'):AdvisoryMetric=>({id:'A12',quality:status,unit:'fraction',data:{...base,candidates,share:null,denominatorAtomic:null},evidenceIds,reasonCode});
 if(!input)return missing('EXIT_CAPACITY_CANDIDATE_SET_NOT_COLLECTED');
 const q=qualifiedA12Candidates(input,target,cutoff),members=capacityRoutes(q.candidates,q.packet.method==='a12-reviewed-candidate-set-v2'?q.packet.routeHints??[]:[]),candidates=capacityCandidates(members);
 if(!q.complete)return missing('EXIT_CAPACITY_FACTUAL_CANDIDATE_SET_INCOMPLETE',candidates);
 const plan:NativeCapacityPlan={members,sourceHash:q.sourceHash,sourceReadyAt:q.packet.review.availableAt};
 if(!r||impactBps===undefined||candidates.some(c=>c.token.chain!=='solana'))return missing('EXIT_CAPACITY_DENOMINATOR_INCOMPLETE',candidates);
 const bank=decodeCapacityBank(plan,target,cutoff,impactBps,r,candidates);
 if(!bank.ok)return missing(bank.reasonCode,bank.candidates,bank.status);
 const {targetReference,at}=bank;
 const b={context:{slot:bank.stateSlot}};
 try{
  const quoteKeys=new Set(candidates.map(c=>c.quoteMint+':'+c.quoteDecimals));
  if(quoteKeys.size!==1){
   if(zeroTargetComparison===true&&targetReference&&candidates.length>=2){
    const reference=targetReference,targetCapacity=candidates.find(c=>isDeepStrictEqual(c.token,target));
    const positiveCapacityWitnesses=candidates.filter(c=>!isDeepStrictEqual(c.token,target)&&BigInt(c.capacityAtomic!)>0n&&(c.quoteMint===reference.quoteMint||c.quoteMint===reference.baseMint)).map(c=>({token:c.token,pool:c.pool,quoteMint:c.quoteMint,quoteDecimals:c.quoteDecimals,capacityAtomic:c.capacityAtomic}));
    if(targetCapacity?.capacityAtomic==='0'&&targetCapacity.inputAtomic==='0'&&targetCapacity.boundary?.status==='KNOWN'&&positiveCapacityWitnesses.length&&candidates.every(c=>BigInt(c.capacityAtomic!)>=0n&&BigInt(c.capacityAtomic!)<=(1n<<64n)-1n))return{id:'A12',quality:'KNOWN',unit:'fraction',reasonCode:'ZERO_TARGET_CAPACITY_SHARE_POINT_IDENTIFIED',evidenceIds,data:{...base,method:'impact-bounded-zero-target-capacity-share-v3',candidateSourceHash:q.sourceHash,stateSlot:b.context.slot,availableAt:at,expiresAt:new Date(Date.parse(at)+30000).toISOString(),candidates:candidates.map(c=>({...c,share:c.capacityAtomic==='0'?'0':null})),denominatorAtomic:null,share:'0',comparison:{method:'zero-target-positive-reference-invariant-v1',denominatorStatus:'POSITIVE_UNVALUED',normalization:'NOT_PERFORMED',valuationClass:'FINITE_NONNEGATIVE_WITH_POSITIVE_TARGET_REFERENCE',reference,positiveCapacityWitnesses,limitations:[
     'Only the target scalar is identified: its exact native capacity is zero and a source-bound strictly positive-valued capacity term makes the denominator positive for every valuation in the declared class.',
     'The target quote is the reference unit; the target base has a finite strictly positive onchain marginal-reference value from the same admitted pool bank. All other admitted quote-unit valuations are finite and nonnegative nuisance values, not measured FX rates.',
     'No common atomic denominator, peer positive-capacity shares, fair market price, peg or numeric currency conversion is measured. Positive candidate shares remain null.',
     'The scope remains one quoted canonical pool per candidate. No executable onward-cash conversion or deployed program binary attestation is claimed; ordinary quote-transfer authority risks remain disclosed.',
    ]}}};
   }
   return missing('EXIT_CAPACITY_MIXED_QUOTE_UNRESOLVED',candidates);
  }
  base.quoteMint=candidates[0]!.quoteMint;base.quoteDecimals=candidates[0]!.quoteDecimals;
  const total=candidates.reduce((n,c)=>n+BigInt(c.capacityAtomic!),0n);
  if(candidates.length<2||!total)return missing(candidates.length<2?'EXIT_CAPACITY_MULTIPLE_CANDIDATES_REQUIRED':'EXIT_CAPACITY_POSITIVE_DENOMINATOR_REQUIRED',candidates);
  const targetCapacity=candidates.find(c=>isDeepStrictEqual(c.token,target))!;
  return {id:'A12',quality:'KNOWN',unit:'fraction',reasonCode:'COMPARABLE_QUOTED_EXIT_CAPACITY_SHARE_OBSERVED',evidenceIds,data:{...base,candidateSourceHash:q.sourceHash,stateSlot:b.context.slot,availableAt:at,expiresAt:new Date(Date.parse(at)+30000).toISOString(),candidates:candidates.map(c=>({...c,share:new Decimal(c.capacityAtomic!).div(total.toString()).toFixed()})),denominatorAtomic:String(total),share:new Decimal(targetCapacity.capacityAtomic!).div(total.toString()).toFixed()}};
 }catch{return missing('EXIT_CAPACITY_STATE_UNAVAILABLE_OR_INVALID',candidates);}
}

function capacityCandidates(members:NativeCapacityPlan['members']){return members.map(c=>({token:c.token,capacityAtomic:null as string|null,inputAtomic:null as string|null,status:'MISSING' as 'KNOWN'|'MISSING'|'TRUNCATED',reasonCode:'EXIT_CAPACITY_UNSUPPORTED_OR_UNAVAILABLE',pool:c.token.chain==='solana'?(()=>{try{return route({members},c.token).pool.toBase58();}catch{return null;}})():null,boundary:null as CapacityBoundary|null,quoteMint:null as string|null,quoteDecimals:null as number|null,feesBps:null as string[]|null,quoteTransfer:null as Omit<ReturnType<typeof quoteAdmission>,'mint'|'extensions'>|null}));}
type CapacityCandidates=ReturnType<typeof capacityCandidates>;
function decodeCapacityBank(plan:NativeCapacityPlan,target:TokenRef,cutoff:string,impactBps:string|number,r:ExitCapacityReceipts,candidates:CapacityCandidates){
 const failure=(reasonCode:string,candidates:CapacityCandidates,status:'MISSING'|'TRUNCATED'='MISSING')=>({ok:false as const,reasonCode,candidates,status});
 const keys=Object.keys(r.requests).sort();if(keys.some(k=>!['discovery','bank'].includes(k))||!isDeepStrictEqual(keys,Object.keys(r.rawArtifacts).sort())||!isDeepStrictEqual(keys,Object.keys(r.retrievedAt).sort()))bad();
 if(!keys.length)return failure('EXIT_CAPACITY_NOT_COLLECTED',candidates);
 try{
  const dkeys=discoveryKeys(plan),dreq=r.requests.discovery!,floor=(dreq.params[1] as any)?.minContextSlot;
  if(!Number.isSafeInteger(floor)||floor<0||!isDeepStrictEqual(dreq,request(dkeys,floor)))bad();
  const d=result(r.rawArtifacts.discovery!,dkeys.length,floor),bkeys=bankKeys(plan,d.value);
  if(!r.requests.bank)return failure('EXIT_CAPACITY_BANK_UNAVAILABLE',candidates);
  if(!isDeepStrictEqual(r.requests.bank,request(bkeys,d.context.slot)))bad();
  const b=result(r.rawArtifacts.bank!,bkeys.length,d.context.slot),at=r.retrievedAt.bank!,cut=Date.parse(cutoff);
  if(Date.parse(plan.sourceReadyAt)>Date.parse(r.retrievedAt.discovery!)||Object.values(r.retrievedAt).some(t=>!Number.isFinite(Date.parse(t))||Date.parse(t)>cut)||Date.parse(r.retrievedAt.discovery!)>Date.parse(at)||cut-Date.parse(at)>30000)return failure('EXIT_CAPACITY_QUOTE_STALE',candidates);
  const lookup=(key:PublicKey)=>{const i=bkeys.indexOf(key.toBase58());if(i<0||b.value[i]===null)bad();return info(b.value[i]);};
  const g=lookup(GLOBAL_CONFIG_PDA),f=lookup(PUMP_AMM_FEE_CONFIG_PDA);
  if(!g.owner.equals(PUMP_AMM_PROGRAM_ID)||!f.owner.equals(PUMP_FEE_PROGRAM_ID))bad();
  const globalConfig=PUMP_AMM_SDK.decodeGlobalConfig(g),feeConfig=PUMP_AMM_SDK.decodeFeeConfig(f);
  const vaults=new Set<string>();
  let targetReference:{pool:string;baseMint:string;quoteMint:string;bankSlot:number;baseReserveAtomic:string;physicalQuoteAtomic:string;virtualQuoteAtomic:string;quoteTransfer:typeof candidates[number]['quoteTransfer']}|null=null;
  for(const [i,c]of candidates.entries()){
   if(d.value[i+2]===null){c.reasonCode='EXIT_CAPACITY_CANONICAL_POOL_UNAVAILABLE';continue;}
   try{
    const mint=new PublicKey(c.token.address),pk=route(plan,c.token).pool,pa=lookup(pk),ma=lookup(mint);
    if(!pa.owner.equals(PUMP_AMM_PROGRAM_ID)||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(ma.owner.toBase58()))bad();
    const p=PUMP_AMM_SDK.decodePool(pa),m=MintLayout.decode(ma.data),quoteMint=route(plan,c.token).quoteMint,qm=lookup(quoteMint);
    const safeMint=(a:AccountInfo<Buffer>)=>{const control=decodeRawMintControls({context:{slot:b.context.slot},value:{owner:a.owner.toBase58(),data:[a.data.toString('base64'),'base64']}});if(!control.complete||!control.transferAllowed||control.currentFeeBps!=='0'||!control.feeImmutable)throw Error('EXIT_CAPACITY_MINT_CONTROLS_UNSUPPORTED');return MintLayout.decode(a.data);};
    safeMint(ma);const admittedQuote=quoteAdmission(qm),quote=admittedQuote.mint;const {mint:_mint,extensions:_extensions,...quoteTransfer}=admittedQuote;c.quoteTransfer=quoteTransfer;if(quoteMint.equals(NATIVE_MINT)&&(!qm.owner.equals(TOKEN_PROGRAM_ID)||quote.decimals!==9))bad();
    c.quoteMint=quoteMint.toBase58();c.quoteDecimals=quote.decimals;
    if(p.index!==0||!p.creator.equals(pumpPoolAuthorityPda(mint))||!p.baseMint.equals(mint)||!p.quoteMint.equals(quoteMint)||p.virtualQuoteReserves.isNeg()||globalConfig.disableFlags&16||!m.isInitialized)bad();
    if(p.isMayhemMode)throw Error('EXIT_CAPACITY_MAYHEM_UNSUPPORTED');if(p.isCashbackCoin)throw Error('EXIT_CAPACITY_CASHBACK_UNSUPPORTED');
    if(!p.poolBaseTokenAccount.equals(getAssociatedTokenAddressSync(mint,pk,true,ma.owner))||!p.poolQuoteTokenAccount.equals(getAssociatedTokenAddressSync(quoteMint,pk,true,qm.owner)))bad();
    for(const v of [p.poolBaseTokenAccount,p.poolQuoteTokenAccount]){if(vaults.has(v.toBase58()))throw Error('EXIT_CAPACITY_SHARED_ROUTE');vaults.add(v.toBase58());}
    const decodeVault=(key:PublicKey,owner:PublicKey,mint:PublicKey)=>{const a=lookup(key);if(!a.owner.equals(owner))bad();validateVaultData(a,mint.equals(quoteMint)?admittedQuote:undefined);const v=AccountLayout.decode(a.data);if(!v.mint.equals(mint)||!v.owner.equals(pk)||v.state!==1||v.delegateOption||v.closeAuthorityOption)bad();return v.amount;};
    const B=decodeVault(p.poolBaseTokenAccount,ma.owner,mint),P=decodeVault(p.poolQuoteTokenAccount,qm.owner,quoteMint);if(m.supply<B)bad();
    const args={baseReserve:new BN(String(B)),quoteReserve:new BN(String(P)),virtualQuoteReserves:p.virtualQuoteReserves,globalConfig,baseMintAccount:m,baseMint:mint,coinCreator:p.coinCreator,creator:p.creator,feeConfig,quoteMint,isMayhemMode:p.isMayhemMode,creatorFeeBps:p.creatorFeeBps,slippage:0};
    const rates=computeFeesBps({...args,baseMintSupply:new BN(String(m.supply)),quoteReserve:args.quoteReserve.add(p.virtualQuoteReserves)});
    c.feesBps=[rates.lpFeeBps.toString(),rates.protocolFeeBps.toString(),p.coinCreator.equals(PublicKey.default)?'0':rates.creatorFeeBps.toString()];
    const boundary=solveExitCapacity({base:B,physicalQuote:P,virtualQuote:BigInt(p.virtualQuoteReserves.toString()),sellDomain:m.supply-B,fees:[BigInt(rates.lpFeeBps.toString()),BigInt(rates.protocolFeeBps.toString()),p.coinCreator.equals(PublicKey.default)?0n:BigInt(rates.creatorFeeBps.toString())],impactBps:BigInt(impactBps)});
    c.boundary=boundary;c.status=boundary.status;c.reasonCode=boundary.status==='KNOWN'?'EXACT_QUOTED_CAPACITY_OBSERVED':'EXIT_CAPACITY_INTEGER_SEARCH_TRUNCATED';
    if(boundary.status==='KNOWN'){
     if(BigInt(boundary.inputAtomic!)>0n&&sellBaseInput({...args,base:new BN(boundary.inputAtomic!)}).uiQuote.toString()!==boundary.quoteAtomic)bad();
     c.capacityAtomic=boundary.quoteAtomic;c.inputAtomic=boundary.inputAtomic;
     if(isDeepStrictEqual(c.token,target)&&B>0n&&P>0n&&!p.virtualQuoteReserves.isNeg()&&P+BigInt(p.virtualQuoteReserves.toString())>0n)targetReference={pool:pk.toBase58(),baseMint:mint.toBase58(),quoteMint:quoteMint.toBase58(),bankSlot:b.context.slot,baseReserveAtomic:String(B),physicalQuoteAtomic:String(P),virtualQuoteAtomic:p.virtualQuoteReserves.toString(),quoteTransfer:c.quoteTransfer};
    }
   }catch(e){if(e instanceof Error&&e.message==='EXIT_CAPACITY_SHARED_ROUTE')return failure('EXIT_CAPACITY_SHARED_ROUTE_UNRESOLVED',candidates);c.reasonCode=e instanceof Error&&e.message.startsWith('EXIT_CAPACITY_')?e.message:'EXIT_CAPACITY_POOL_UNSUPPORTED_OR_INVALID';c.capacityAtomic=null;c.inputAtomic=null;c.status='MISSING';}
  }
  if(candidates.some(c=>c.status!=='KNOWN'))return failure('EXIT_CAPACITY_DENOMINATOR_INCOMPLETE',candidates,candidates.some(c=>c.status==='TRUNCATED')?'TRUNCATED':'MISSING');
  return {ok:true as const,candidates,targetReference,stateSlot:b.context.slot,at};
 }catch{return failure('EXIT_CAPACITY_STATE_UNAVAILABLE_OR_INVALID',candidates);}
}

/** Witness-purpose admission never supplies complete-catalog authority to the legacy wrappers. */
export async function collectA12ZeroWitnessCapacity(raw:string,target:TokenRef,impactBps:string|number|undefined,minSlot:number,url=PUBLIC_SOLANA_RPC,fetcher:typeof fetch=fetch,now=()=>new Date().toISOString(),signal?:AbortSignal):Promise<ExitCapacityReceipts>{
 const q=decodeA12ZeroWitnessCapture(raw,target,now());
 if(impactBps===undefined||String(impactBps)!==q.capture.scope.impactBps)bad();
 if(!q.qualified)return {requests:{},rawArtifacts:{},retrievedAt:{}};
 return collectCapacityPlan(capacityPlan(q.members,q.routeHints,q.sourceHash,q.sourceReadyAt),minSlot,url,fetcher,now,signal);
}

export function deriveA12ZeroWitnessCapacity(raw:string,target:TokenRef,cutoff:string,impactBps:string|number|undefined,r:ExitCapacityReceipts|null,evidenceIds:string[]):AdvisoryMetric{
 const q=decodeA12ZeroWitnessCapture(raw,target,cutoff);
 if(impactBps===undefined||String(impactBps)!==q.capture.scope.impactBps)bad();
 const members=capacityRoutes(q.members,q.routeHints),candidates=capacityCandidates(members);
 const base={method:'impact-bounded-zero-witness-capacity-share-v1',level:'QUOTED',routeUniverse:EXIT_CAPACITY_SCOPE,quoteMint:null,quoteDecimals:null,impactBps,impactReference:'fee-inclusive net quote versus pretrade effective-quote/base marginal price',externalCosts:'NOT_MODELLED',scope:'One fixed canonical index0 quote-mint-verified PumpSwap target route and one qualified positive witness. Unknown additional finite nonnegative members and capacities cannot alter the target zero scalar; complete membership, a peer denominator, exhaustive venues, FX and onward-cash execution are not asserted.',membershipComplete:false,diagnostics:q.capture.diagnostics};
 const missing=(reasonCode:string,status:'MISSING'|'TRUNCATED'='MISSING'):AdvisoryMetric=>({id:'A12',quality:status,unit:'fraction',data:{...base,candidates,share:null,denominatorAtomic:null},evidenceIds,reasonCode});
 if(!q.qualified)return missing('EXIT_CAPACITY_WITNESS_FACTUAL_QUALIFICATION_FAILED');
 const plan:NativeCapacityPlan={members,sourceHash:q.sourceHash,sourceReadyAt:q.sourceReadyAt};
 if(!r)return missing('EXIT_CAPACITY_NOT_COLLECTED');
 const bank=decodeCapacityBank(plan,target,cutoff,impactBps,r,candidates);
 if(!bank.ok)return missing(bank.reasonCode,bank.status);
 const reference=bank.targetReference,targetCapacity=candidates[0]!,witness=candidates[1]!;
 if(!reference||targetCapacity.capacityAtomic!=='0'||targetCapacity.inputAtomic!=='0'||targetCapacity.boundary?.status!=='KNOWN')return missing('EXIT_CAPACITY_ZERO_TARGET_REFERENCE_REQUIRED');
 if(witness.status!=='KNOWN'||BigInt(witness.capacityAtomic!)<=0n||(witness.quoteMint!==reference.quoteMint&&witness.quoteMint!==reference.baseMint))return missing('EXIT_CAPACITY_POSITIVE_REFERENCE_WITNESS_REQUIRED');
 return {id:'A12',quality:'KNOWN',unit:'fraction',reasonCode:'ZERO_TARGET_CAPACITY_SHARE_WITNESS_IDENTIFIED',evidenceIds,data:{...base,candidateSourceHash:plan.sourceHash,stateSlot:bank.stateSlot,availableAt:bank.at,expiresAt:new Date(Date.parse(bank.at)+30000).toISOString(),candidates:candidates.map((c,i)=>({...c,share:i===0?'0':null})),denominatorAtomic:null,share:'0',comparison:{method:'zero-target-positive-witness-invariant-v1',membershipComplete:false,completionClass:'FINITE_NONNEGATIVE_COMPLETIONS_CONTAINING_QUALIFIED_PAIR',denominatorStatus:'POSITIVE_UNVALUED',normalization:'NOT_PERFORMED',valuationClass:'FINITE_NONNEGATIVE_WITH_POSITIVE_TARGET_REFERENCE',reference,positiveCapacityWitnesses:[{token:witness.token,pool:witness.pool,quoteMint:witness.quoteMint,quoteDecimals:witness.quoteDecimals,capacityAtomic:witness.capacityAtomic}],limitations:[
  'Only the target scalar is identified: its exact native capacity is zero and the qualified witness contributes a strictly positive reference-valued capacity at the same admitted bank.',
  'The target quote is the reference unit and the target base has a finite strictly positive onchain marginal-reference value. Every finite nonnegative completion containing this pair has a finite positive denominator.',
  'Complete membership, additional member capacities, a common atomic denominator and positive peer shares remain unmeasured, including when the selected pair shares a quote mint.',
  'No fair market price, peg, numeric FX conversion, executable onward-cash conversion or deployed program binary attestation is claimed; ordinary quote-transfer authority risks remain disclosed.',
 ]}}};
}
