import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import BN from 'bn.js';
import {PublicKey} from '@solana/web3.js';
import {MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {OFFLINE_PUMP_AMM_PROGRAM as sdk,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,FEE_CONFIG_SIZE_PRE_STABLE,poolPda,pumpPoolAuthorityPda,lpMintPda} from '@pump-fun/pump-swap-sdk';
import {solveExitCapacity,a12ProposalPrompt,a12ReviewPrompt,qualifiedA12Candidates,collectExitCapacity,deriveExitCapacity,EXIT_CAPACITY_SCOPE,type A12CandidateSet,type CapacityCurve} from '../src/providers/advisory-exit-capacity.js';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
import {PUMP_WINDOW_ABI_SOURCE,PUMP_WINDOW_ABI_HASH,PUMP_WINDOW_V35_ABI_SOURCE,PUMP_WINDOW_V35_ABI_HASH} from '../src/providers/pumpswap-window-abi.js';

const at='2026-10-24T12:00:00.000Z',target={chain:'solana' as const,address:new PublicKey(Buffer.alloc(32,71)).toBase58()},peer={chain:'solana' as const,address:new PublicKey(Buffer.alloc(32,72)).toBase58()};
function packet(tokens=[target,peer]):A12CandidateSet{
 const p:any={method:'a12-reviewed-candidate-set-v1',token:target,scope:{description:'Constructed fixture catalog of the same test narrative',queries:['test narrative representations'],routeUniverse:EXIT_CAPACITY_SCOPE},sources:tokens.map((token,i)=>({id:'source'+i,url:'https://example.com/token/'+i,text:'Test narrative token representation exact mint '+token.address,availableAt:at})),acquisition:{complete:true,sourceIds:[],requests:[]}};
 p.acquisition.sourceIds=p.sources.map((s:any)=>s.id);p.acquisition.requests=p.sources.map((s:any)=>({url:s.url,body:s.text,availableAt:s.availableAt}));
 const proposal={claims:[],posts:[],competitors:tokens.map((token,i)=>({id:'candidate'+i,token,sourceId:p.sources[i].id,quote:p.sources[i].text}))};
 p.proposal={executor:'CODEX_NATIVE',invocationId:'constructed-proposal',prompt:a12ProposalPrompt(p),response:JSON.stringify(proposal),availableAt:at};
 p.review={executor:'CLAUDE_CODE',invocationId:'constructed-independent-review',prompt:a12ReviewPrompt(p,proposal),response:JSON.stringify({decisions:proposal.competitors.map(c=>({id:c.id,accepted:true,rationale:'Constructed literal source supports narrative and contract'})),candidateSet:{complete:true,rationale:'Whole declared constructed source catalog inspected'},originRelationship:{status:'UNKNOWN',citations:[],rationale:'Origin relationship is outside this comparison'}}),availableAt:at};
 return p;
}
function brute(c:CapacityCurve){let qbest=0n;for(let x=1n;x<=c.sellDomain;x++){const q=(c.physicalQuote+c.virtualQuote)*x/(c.base+x),fees=c.fees.map(f=>(q*f+9999n)/10000n),net=q-fees.reduce((s,f)=>s+f,0n);if(q-fees[0]!>c.physicalQuote||net<=0n||net*c.base*10000n<x*(c.physicalQuote+c.virtualQuote)*(10000n-c.impactBps))continue;if(net>qbest)qbest=net;}return qbest;}
test('exact integer interval solver matches exhaustive positive domains including dust, fee ceilings, virtual and physical limits',()=>{
 for(const B of [1n,7n,79n,503n])for(const P of [1n,9n,101n,10009n])for(const V of [0n,17n,10000n])for(const fees of [[0n,0n,0n],[20n,15n,10n],[100n,100n,99n],[150n,150n,0n]] as [bigint,bigint,bigint][])for(const L of [300n,450n]){
  const c={base:B,physicalQuote:P,virtualQuote:V,sellDomain:800n,fees,impactBps:L},got=solveExitCapacity(c);assert.equal(got.status,'KNOWN');assert.equal(got.quoteAtomic,String(brute(c)),JSON.stringify({B:String(B),P:String(P),V:String(V),fees:fees.map(String),L:String(L)}));
 }
});
test('solver refuses capped search and never reports a guessed boundary; large lamport domains remain bounded',()=>{
 const c={base:100000000000000n,physicalQuote:700000000000n,virtualQuote:0n,sellDomain:900000000000000n,fees:[20n,15n,10n] as [bigint,bigint,bigint],impactBps:300n};
 assert.equal(solveExitCapacity(c,1).status,'TRUNCATED');const got=solveExitCapacity(c);assert.equal(got.status,'KNOWN');assert.ok(got.intervals<10000);assert.ok(BigInt(got.quoteAtomic!)>0n);
});
test('candidate proof binds source bytes, literal contracts, independent invocation and full factual membership',()=>{
 const p=packet();assert.equal(qualifiedA12Candidates(p,target,at).complete,true);
 for(const mutate of [(p:A12CandidateSet)=>p.sources[0]!.text+=' changed',(p:A12CandidateSet)=>p.review.invocationId=p.proposal.invocationId,(p:A12CandidateSet)=>p.proposal.prompt+=' invented',(p:A12CandidateSet)=>p.review.prompt+=' invented']){const x=structuredClone(p);mutate(x);assert.throws(()=>qualifiedA12Candidates(x,target,at));}
 const duplicate=packet([target,target]);assert.equal(qualifiedA12Candidates(duplicate,target,at).complete,false);
 const rejected=structuredClone(p),review=JSON.parse(rejected.review.response);review.candidateSet.complete=false;rejected.review.response=JSON.stringify(review);assert.equal(qualifiedA12Candidates(rejected,target,at).complete,false);
 const entry=structuredClone(p),r=JSON.parse(entry.review.response);r.entryDecisions={};entry.review.response=JSON.stringify(r);assert.throws(()=>qualifiedA12Candidates(entry,target,at));
});
const bn=(n:number)=>new BN(n),rates={lpFeeBps:bn(20),protocolFeeBps:bn(15),creatorFeeBps:bn(10)};
async function encode(name:string,v:any){const d=Buffer.from(await sdk.coder.accounts.encode(name,v));return name==='feeConfig'?Buffer.concat([d,Buffer.alloc(Math.max(0,FEE_CONFIG_SIZE_PRE_STABLE-d.length))]):d;}
const account=(owner:PublicKey,data:Buffer)=>({owner:owner.toBase58(),data:[data.toString('base64'),'base64'],executable:false,lamports:2039280});
function mint(supply:bigint,decimals:number){const b=Buffer.alloc(MintLayout.span);b.writeBigUInt64LE(supply,36);b[44]=decimals;b[45]=1;return b;}
function vault(mint:PublicKey,owner:PublicKey,amount:bigint){const b=Buffer.alloc(165);mint.toBuffer().copy(b);owner.toBuffer().copy(b,32);b.writeBigUInt64LE(amount,64);b[108]=1;return b;}
async function fixture(){
 const map=new Map<string,any>();
 const global=await encode('globalConfig',{admin:PublicKey.default,lpFeeBasisPoints:bn(20),protocolFeeBasisPoints:bn(15),disableFlags:0,protocolFeeRecipients:Array(8).fill(PublicKey.default),coinCreatorFeeBasisPoints:bn(10),adminSetCoinCreatorAuthority:PublicKey.default,whitelistPda:PublicKey.default,reservedFeeRecipient:PublicKey.default,mayhemModeEnabled:false,reservedFeeRecipients:Array(7).fill(PublicKey.default),isCashbackEnabled:false,buybackFeeRecipients:Array(8).fill(PublicKey.default),buybackBasisPoints:bn(0),boostAuthority:PublicKey.default,boostEnabled:false,creatorFeeConfigurable:true,maxConfigurableCreatorFeeBps:bn(100)});
 map.set(GLOBAL_CONFIG_PDA.toBase58(),account(PUMP_AMM_PROGRAM_ID,global));
 map.set(PUMP_AMM_FEE_CONFIG_PDA.toBase58(),account(PUMP_FEE_PROGRAM_ID,await encode('feeConfig',{bump:1,admin:PublicKey.default,flatFees:rates,feeTiers:[{marketCapLamportsThreshold:bn(0),fees:rates}],stableFeeTiers:[],exoticFlatFees:rates})));
 map.set(NATIVE_MINT.toBase58(),account(TOKEN_PROGRAM_ID,mint(0n,9)));
 for(const [i,t]of [target,peer].entries()){
  const m=new PublicKey(t.address),creator=pumpPoolAuthorityPda(m),pk=poolPda(0,creator,m,NATIVE_MINT),bv=getAssociatedTokenAddressSync(m,pk,true),qv=getAssociatedTokenAddressSync(NATIVE_MINT,pk,true);
  map.set(pk.toBase58(),account(PUMP_AMM_PROGRAM_ID,await encode('pool',{poolBump:1,index:0,creator,baseMint:m,quoteMint:NATIVE_MINT,lpMint:lpMintPda(pk),poolBaseTokenAccount:bv,poolQuoteTokenAccount:qv,lpSupply:bn(1000),coinCreator:new PublicKey(Buffer.alloc(32,1)),isMayhemMode:false,isCashbackCoin:false,virtualQuoteReserves:bn(0),creatorFeeBps:bn(0),canEditCreatorFee:false})));
  map.set(t.address,account(TOKEN_PROGRAM_ID,mint(1000000000000000n,6)));map.set(bv.toBase58(),account(TOKEN_PROGRAM_ID,vault(m,pk,100000000000000n)));map.set(qv.toBase58(),account(TOKEN_PROGRAM_ID,vault(NATIVE_MINT,pk,BigInt(i+1)*700000000000n)));
 }
 const requests:any[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{const r=JSON.parse(String(init?.body));requests.push(r);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{context:{slot:500},value:r.params[0].map((k:string)=>map.get(k)??null)}}));};
 return {map,fetcher,requests};
}
test('production acquisition binds all candidates to one finalized mutable bank and derives nondegenerate quoted capacity shares',async()=>{
 const f=await fixture(),p=packet(),r=await collectExitCapacity(p,target,'300',499,'https://example.com/rpc',f.fetcher,()=>at);
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].params[1].minContextSlot,500);
 const metric=deriveExitCapacity(p,target,at,'300',r,['candidate','discovery','bank']),d=metric.data as any;
 assert.equal(metric.quality,'KNOWN');assert.equal(d.level,'QUOTED');assert.equal(d.stateSlot,500);assert.equal(d.candidates.length,2);assert.ok(Number(d.share)>0.32&&Number(d.share)<0.34);assert.notEqual(d.candidates[0].capacityAtomic,d.candidates[1].capacityAtomic);assert.equal(BigInt(d.denominatorAtomic),d.candidates.reduce((n:bigint,c:any)=>n+BigInt(c.capacityAtomic),0n));
 const stale=deriveExitCapacity(p,target,'2026-10-24T12:00:30.001Z','300',r,[]);assert.equal(stale.reasonCode,'EXIT_CAPACITY_QUOTE_STALE');
 const bad=structuredClone(r);bad.requests.bank!.params[1]={encoding:'base64',commitment:'confirmed',minContextSlot:500};assert.notEqual(deriveExitCapacity(p,target,at,'300',bad,[]).quality,'KNOWN');
});
test('missing or unsupported peers, target-only scopes and unavailable source never become zero denominators',async()=>{
 const f=await fixture(),p=packet();f.map.delete(poolPda(0,pumpPoolAuthorityPda(new PublicKey(peer.address)),new PublicKey(peer.address),NATIVE_MINT).toBase58());
 const r=await collectExitCapacity(p,target,'300',499,'https://example.com/rpc',f.fetcher,()=>at),m=deriveExitCapacity(p,target,at,'300',r,[]),d=m.data as any;
 assert.equal(m.quality,'MISSING');assert.equal(d.candidates[1].capacityAtomic,null);assert.equal(d.share,null);assert.equal(d.denominatorAtomic,null);
 const one=packet([target]),fr=await fixture(),single=await collectExitCapacity(one,target,'300',499,'https://example.com/rpc',fr.fetcher,()=>at);assert.equal(deriveExitCapacity(one,target,at,'300',single,[]).reasonCode,'EXIT_CAPACITY_MULTIPLE_CANDIDATES_REQUIRED');
 const unsupported=packet([target,{chain:'solana',address:peer.address}]);unsupported.sources[1]!.availableAt='2026-10-24T11:00:00.000Z';assert.throws(()=>qualifiedA12Candidates(unsupported,target,at));
});

const baselineFetch:typeof fetch=async(input,init)=>{
 const url=String(input);let result:any;
 if(init?.method==='POST'){const r=JSON.parse(String(init.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:r.method==='getGenesisHash'?SOLANA_MAINNET_GENESIS:r.method==='getSignaturesForAddress'?[]:{context:{slot:1},value:null}}));}
 if(url.includes('/token-pairs/'))result=[];
 else if(url.includes('coinbase'))result=Array.from({length:75},(_,i)=>[Date.parse(at)/1000-i*3600,9,11,10,10,2]);
 else if(url.includes('llama'))result={chain:new URL(url).pathname.split('/').at(-1),totalDataChart:[]};
 else if(url.includes('/orders/'))result={orders:[],boosts:[]};
 else result={};
 return new Response(JSON.stringify(result));
};
test('live34 input, raw reconstruction, Service save/reopen and historical32 retain coherent version dispatch',async()=>{
 const f=await fixture(),p=packet();
 const combined:typeof fetch=(url,init)=>{if(init?.method==='POST'){const req=JSON.parse(String(init.body));if(req.method==='getMultipleAccounts'&&[3,4,11].includes(req.params[0].length))return f.fetcher(url,init);}return baselineFetch(url,init);};
 const bundle=await collectLiveToken(target,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,a12CandidateSet:p,fetcher:combined,now:()=>at});
 const proof=JSON.parse(bundle.rawArtifacts['advisory-derivation']!);assert.equal(proof.method,'advisory-provenance-v40');assert.equal(proof.saturation,null);assert.equal(proof.a29,null);assert.ok(proof.exitCapacity);assert.equal(bundle.details!.advisory!.method,'advisory-measurements-v39');assert.equal(bundle.details!.advisory!.metrics.find(m=>m.id==='A12')!.quality,'KNOWN');
 assert.deepEqual(reconstructAdvisory(target,at,bundle.details!.baseline,bundle.evidence,bundle.rawArtifacts,proof,bundle.thesis??null,bundle.features),bundle.details!.advisory);
 // A proof33 replays the original WSOL acquisition layout and exact legacy result, not v2 semantics.
 const legacy=structuredClone(bundle),legacyProof=structuredClone(proof),legacyReceipts=await collectExitCapacity(p,target,'300',0,'https://example.com/rpc',f.fetcher,()=>at);
 legacyProof.method='advisory-provenance-v33';assert.equal(legacyProof.a29,null);delete legacyProof.a29;delete legacyProof.saturation;legacyProof.exitCapacity.requests=legacyReceipts.requests;
 for(const [key,body]of Object.entries(legacyReceipts.rawArtifacts)){const id=legacyProof.exitCapacity.artifactIds[key];legacy.rawArtifacts[id]=body;const e=legacy.evidence.find(e=>e.id===id)!;e.scope={request:legacyReceipts.requests[key]};e.contentHash=createHash('sha256').update(body).digest('hex');}
 const oldFacts=reconstructAdvisory(target,at,legacy.details!.baseline,legacy.evidence,legacy.rawArtifacts,legacyProof,legacy.thesis??null,legacy.features),oldA12=oldFacts.metrics.find(m=>m.id==='A12')!;
 assert.equal(oldFacts.method,'advisory-measurements-v32');assert.equal((oldA12.data as any).method,'impact-bounded-native-exit-capacity-v1');assert.equal(oldA12.quality,'KNOWN');
 assert.deepEqual(oldA12,deriveExitCapacity(p,target,at,'300',legacyReceipts,oldA12.evidenceIds));

 const dir=mkdtempSync(join(tmpdir(),'meme-a12-')),file=join(dir,'case.sqlite');let service=new Service(file);
 try{
  const saved=service.analyzeLive(bundle);service.close();service=new Service(file);assert.deepEqual(service.replay(saved.id),saved);
  for(const change of [(b:typeof bundle)=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.exitCapacity=null;b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);},(b:typeof bundle)=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.method='advisory-provenance-v32';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);},(b:typeof bundle)=>{b.rawArtifacts['a12-reviewed-candidate-set']=JSON.stringify({...p,token:peer});},(b:typeof bundle)=>{const raw=JSON.parse(b.rawArtifacts['advisory-exitCapacity-bank']!);raw.result.value[2].owner=TOKEN_PROGRAM_ID.toBase58();b.rawArtifacts['advisory-exitCapacity-bank']=JSON.stringify(raw);},(b:typeof bundle)=>{const proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);proof.exitCapacity.impactBps='301';b.rawArtifacts['advisory-derivation']=JSON.stringify(proof);}]){
   const bad=structuredClone(bundle);change(bad);for(const e of bad.evidence)e.contentHash=createHash('sha256').update(bad.rawArtifacts[e.id]!).digest('hex');assert.throws(()=>service.analyzeLive(bad),/ADVISORY_PROOF_INVALID/);
  }
 }finally{service.close();rmSync(dir,{recursive:true,force:true});}
 const fresh=await collectLiveToken(target,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,fetcher:baselineFetch,now:()=>at}),old=JSON.parse(fresh.rawArtifacts['advisory-derivation']!);assert.equal(old.saturation,null);old.method='advisory-provenance-v32';assert.equal(old.a29,null);delete old.a29;delete old.exitCapacity;delete old.saturation;
 const prior=reconstructAdvisory(target,at,fresh.details!.baseline,fresh.evidence,fresh.rawArtifacts,old,fresh.thesis??null,fresh.features);assert.equal(prior.method,'advisory-measurements-v31');
 // The same fresh raw relabelled as an explicit saved proof35 (new mode off) keeps the frozen proof35 window contract, so this v35 versus <=34 comparison never drifts with fresh output.
 const freshProof=JSON.parse(fresh.rawArtifacts['advisory-derivation']!);assert.equal(freshProof.method,'advisory-provenance-v40');assert.equal(freshProof.saturation,null);assert.equal(freshProof.a29,null);assert.equal(fresh.details!.advisory!.method,'advisory-measurements-v39');
 const saved35=reconstructAdvisory(target,at,fresh.details!.baseline,fresh.evidence,fresh.rawArtifacts,{...freshProof,method:'advisory-provenance-v35',saturation:undefined,a29:undefined},fresh.thesis??null,fresh.features);assert.equal(saved35.method,'advisory-measurements-v34');
 // Required frozen version dispatch: v35 pins PUMP_WINDOW_V35_ABI, every proof<=34 pins the exact legacy PUMP_WINDOW_ABI. Assert both O28 abis exactly, then compare all metrics with only that one proven-different field normalized.
 const o28Of=(metrics:typeof prior.metrics)=>metrics.find(m=>m.id==='O28')!,priorO28=o28Of(prior.metrics),v35O28=o28Of(saved35.metrics);
 assert.deepEqual((priorO28.data as any).abi,{source:PUMP_WINDOW_ABI_SOURCE,sha256:PUMP_WINDOW_ABI_HASH});
 assert.deepEqual((v35O28.data as any).abi,{source:PUMP_WINDOW_V35_ABI_SOURCE,sha256:PUMP_WINDOW_V35_ABI_HASH});
 // Required frozen version dispatch: a proof35 modern window appends exactly one execution-proof CPI recovery limitation immediately after the terminal-truncation recovery limitation; every proof<=34 keeps the exact legacy limitations array. Literal is the verbatim advisory-window.ts MODERN_RECOVERY_LIMITATION contract string.
 const MODERN_RECOVERY_LIMITATION='Proof35 execution-proof recovery: a terminally truncated receipt is also retained when a Pump invocation recorded in the complete instruction trace - whether its frame opened before "Log truncated" or lies wholly after the marker - is proven executed, because a finalized meta.err-null transaction whose trace ancestry (resolved from stackHeights, not the open log stack) is entirely ordinary non-builtin SBF programs cannot have a failed callee (Agave v4.3.2 program-runtime/src/cpi.rs propagates a failed CPI via the ? operator and returns Ok(SUCCESS) only on success). Only a direct selected-pool swap bound once to its own buy/sell event-CPI child, or a canonical selected-disjoint close_user_volume_accumulator with its own close event-CPI child, is admitted; the unclosed-invocation count stays reported, and multi-hop buys and unknown roles remain unsupported.';
 const priorLimitations=(priorO28.data as any).limitations as string[],v35Limitations=(v35O28.data as any).limitations as string[];
 const modernIndex=v35Limitations.indexOf(MODERN_RECOVERY_LIMITATION);
 assert.ok(modernIndex>0&&v35Limitations[modernIndex-1]!.startsWith('Terminal log truncation:'),'the proof35 execution-proof recovery limitation sits immediately after the terminal-truncation recovery limitation');
 assert.deepEqual([...v35Limitations.slice(0,modernIndex),...v35Limitations.slice(modernIndex+1)],priorLimitations);
 const normalizedMetrics=saved35.metrics.map(m=>m.id==='O28'?{...m,data:{...(m.data as any),abi:(priorO28.data as any).abi,limitations:(m.data as any).limitations.filter((l:string)=>l!==MODERN_RECOVERY_LIMITATION)}}:m);
 assert.deepEqual(prior.metrics,normalizedMetrics);
 // Fresh proof36 output of this tradeless window keeps the saved proof35 O28 verdict; its exact abi, limitations and window method await the frozen proof36 source contract.
 const fresh36O28=o28Of(fresh.details!.advisory!.metrics);
 assert.deepEqual([fresh36O28.quality,fresh36O28.reasonCode,fresh36O28.evidenceIds],[v35O28.quality,v35O28.reasonCode,v35O28.evidenceIds]);
});
