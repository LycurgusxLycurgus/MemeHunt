import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {SOLANA_MAINNET_GENESIS} from '../src/providers/solana.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import {PublicKey} from '@solana/web3.js';
import {MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {OFFLINE_PUMP_AMM_PROGRAM as sdk,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,FEE_CONFIG_SIZE_POST_EXOTIC,poolPda,pumpPoolAuthorityPda,lpMintPda,USDC_MINT} from '@pump-fun/pump-swap-sdk';
import {a12ProposalPrompt,a12ReviewPrompt,qualifiedA12Candidates,collectExitCapacity,deriveExitCapacity,EXIT_CAPACITY_SCOPE,type A12CandidateSet} from '../src/providers/advisory-exit-capacity-custom.js';
import {deriveExitCapacity as deriveLegacy} from '../src/providers/advisory-exit-capacity.js';
const at='2026-10-24T12:00:00.000Z',target={chain:'solana' as const,address:new PublicKey(Buffer.alloc(32,71)).toBase58()},peer={chain:'solana' as const,address:new PublicKey(Buffer.alloc(32,72)).toBase58()};
function packet(tokens=[target,peer]):A12CandidateSet{
 const p:any={method:'a12-reviewed-candidate-set-v2',token:target,scope:{description:'Constructed fixture catalog of the same test narrative',queries:['test narrative representations'],routeUniverse:EXIT_CAPACITY_SCOPE},sources:tokens.map((token,i)=>({id:'source'+i,url:'https://example.com/token/'+i,text:'Test narrative token representation exact mint '+token.address,availableAt:at})),acquisition:{complete:true,sourceIds:[],requests:[]}};
 p.acquisition.sourceIds=p.sources.map((s:any)=>s.id);p.acquisition.requests=p.sources.map((s:any)=>({url:s.url,body:s.text,availableAt:s.availableAt}));
 const proposal={claims:[],posts:[],competitors:tokens.map((token,i)=>({id:'candidate'+i,token,sourceId:p.sources[i].id,quote:p.sources[i].text}))};
 p.proposal={executor:'CODEX_NATIVE',invocationId:'constructed-proposal',prompt:a12ProposalPrompt(p),response:JSON.stringify(proposal),availableAt:at};
 p.review={executor:'CLAUDE_CODE',invocationId:'constructed-independent-review',prompt:a12ReviewPrompt(p,proposal),response:JSON.stringify({decisions:proposal.competitors.map(c=>({id:c.id,accepted:true,rationale:'Constructed literal source supports narrative and contract'})),candidateSet:{complete:true,rationale:'Whole declared constructed source catalog inspected'},originRelationship:{status:'UNKNOWN',citations:[],rationale:'Origin relationship is outside this comparison'}}),availableAt:at};
 return p;
}
const bn=(n:number)=>new BN(n),rates={lpFeeBps:bn(20),protocolFeeBps:bn(15),creatorFeeBps:bn(10)};
async function encode(name:string,v:any){const d=Buffer.from(await sdk.coder.accounts.encode(name,v));return name==='feeConfig'?Buffer.concat([d,Buffer.alloc(Math.max(0,FEE_CONFIG_SIZE_POST_EXOTIC-d.length))]):d;}
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

/** Rebind a canonical constructed route; all catalog membership remains independent of routing. */
async function custom(quote:PublicKey,metadata=false){
 const f=await fixture(),p=packet();
 const hints:any[]=[];
 const metadataMint=(raw:Buffer)=>{const m=Buffer.alloc(166+4+64+4+80);raw.copy(m);m[165]=1;m.writeUInt16LE(18,166);m.writeUInt16LE(64,168);m.writeUInt16LE(19,234);m.writeUInt16LE(80,236);return m;};
 const t22vault=(raw:Buffer)=>Buffer.concat([raw,Buffer.from([2,7,0,0,0])]);
 f.map.set(quote.toBase58(),account(metadata?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,metadata?metadataMint(mint(1000000000000000n,8)):mint(1000000000000000n,6)));
 for(const [i,t]of [target,peer].entries()){
  const m=new PublicKey(t.address),creator=pumpPoolAuthorityPda(m),pk=poolPda(0,creator,m,quote),owner=metadata?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,bv=getAssociatedTokenAddressSync(m,pk,true,owner),qv=getAssociatedTokenAddressSync(quote,pk,true,owner);
  f.map.set(pk.toBase58(),account(PUMP_AMM_PROGRAM_ID,await encode('pool',{poolBump:1,index:0,creator,baseMint:m,quoteMint:quote,lpMint:lpMintPda(pk),poolBaseTokenAccount:bv,poolQuoteTokenAccount:qv,lpSupply:bn(1000),coinCreator:new PublicKey(Buffer.alloc(32,1)),isMayhemMode:false,isCashbackCoin:false,virtualQuoteReserves:bn(100000),creatorFeeBps:bn(25),canEditCreatorFee:false})));
  f.map.set(t.address,account(owner,metadata?metadataMint(mint(1000000000000000n,6)):mint(1000000000000000n,6)));
  f.map.set(bv.toBase58(),account(owner,metadata?t22vault(vault(m,pk,100000000000000n)):vault(m,pk,100000000000000n)));
  f.map.set(qv.toBase58(),account(owner,metadata?t22vault(vault(quote,pk,BigInt(i+1)*700000000000n)):vault(quote,pk,BigInt(i+1)*700000000000n)));
  const source=p.sources[i]!;source.text+=' Canonical pool '+pk.toBase58()+' quote mint '+quote.toBase58();p.acquisition.requests[i]!.body=source.text;
  hints.push({token:t,pool:pk.toBase58(),quoteMint:quote.toBase58(),sourceId:source.id,quote:source.text});
 }
 if(p.method!=='a12-reviewed-candidate-set-v2')throw Error('FIXTURE');p.routeHints=hints;
 const proposal={claims:[],posts:[],competitors:[target,peer].map((token,i)=>({id:'candidate'+i,token,sourceId:p.sources[i]!.id,quote:p.sources[i]!.text}))};
 p.proposal.prompt=a12ProposalPrompt(p);p.proposal.response=JSON.stringify(proposal);p.review.prompt=a12ReviewPrompt(p,proposal);
 return {f,p,quote};
}
async function metric(x:Awaited<ReturnType<typeof custom>>){const r=await collectExitCapacity(x.p,target,'300',499,'https://example.com/rpc',x.f.fetcher,()=>at);return {r,m:deriveExitCapacity(x.p,target,at,'300',r,[])};}
test('custom quote canonical routes use one bank, actual quote decimals, exact exotic fees, virtual reserves and creator override',async()=>{
 const x=await custom(new PublicKey(Buffer.alloc(32,88)),true),{m,r}=await metric(x),d=m.data as any;
 assert.equal(x.f.requests.length,2);assert.equal(m.quality,'KNOWN');assert.equal(d.quoteMint,x.quote.toBase58());assert.equal(d.quoteDecimals,8);assert.equal(d.candidates[0].feesBps[2],'25');assert.equal(d.stateSlot,500);assert.ok(BigInt(d.denominatorAtomic)>0n);
 assert.throws(()=>deriveLegacy(x.p,target,at,'300',r,[]));
});
test('source route hints cannot substitute arbitrary owner, wrong canonical pool or absent literal triple',async()=>{
 for(const change of [(p:any)=>p.routeHints[0].pool=PublicKey.default.toBase58(),(p:any)=>p.routeHints[0].quote='invented',(p:any)=>p.routeHints.push(p.routeHints[0])]){const x=await custom(USDC_MINT);change(x.p);assert.throws(()=>qualifiedA12Candidates(x.p,target,at));}
 const x=await custom(USDC_MINT),h=(x.p as any).routeHints[0];x.f.map.get(h.pool).owner=TOKEN_PROGRAM_ID.toBase58();assert.notEqual((await metric(x)).m.quality,'KNOWN');
});
test('USDC quote selects stable tiers rather than native or exotic schedules',async()=>{
 const x=await custom(USDC_MINT);x.f.map.set(PUMP_AMM_FEE_CONFIG_PDA.toBase58(),account(PUMP_FEE_PROGRAM_ID,await encode('feeConfig',{bump:1,admin:PublicKey.default,flatFees:rates,feeTiers:[{marketCapLamportsThreshold:bn(0),fees:rates}],stableFeeTiers:[{marketCapLamportsThreshold:bn(0),fees:{lpFeeBps:bn(70),protocolFeeBps:bn(30),creatorFeeBps:bn(10)}}],exoticFlatFees:{lpFeeBps:bn(80),protocolFeeBps:bn(40),creatorFeeBps:bn(15)}})));
 const {m}=await metric(x);assert.equal(m.quality,'KNOWN');assert.deepEqual((m.data as any).candidates[0].feesBps,['70','30','25']);
});
test('unsafe quote hook and vault extension, transfer fees, mayhem, cashback and missing canonical route remain unresolved',async()=>{
 for(const mode of ['hook','vault','fee','mayhem','cashback','curve']){
  const x=await custom(new PublicKey(Buffer.alloc(32,88)),true),h=(x.p as any).routeHints[0];
  if(mode==='hook'||mode==='fee'){const raw=mint(1000000000000000n,8),b=Buffer.alloc(166+4+(mode==='hook'?64:108));raw.copy(b);b[165]=1;b.writeUInt16LE(mode==='hook'?14:1,166);b.writeUInt16LE(mode==='hook'?64:108,168);if(mode==='hook')b[170]=1;else b.writeUInt16LE(10,258);x.f.map.set(x.quote.toBase58(),account(TOKEN_2022_PROGRAM_ID,b));}
  else if(mode==='vault'){const p=sdk.coder.accounts.decode('pool',Buffer.from(x.f.map.get(h.pool).data[0],'base64'));const a=x.f.map.get(p.poolQuoteTokenAccount.toBase58()),b=Buffer.from(a.data[0],'base64');b.writeUInt16LE(15,166);a.data[0]=b.toString('base64');}
  else if(mode==='curve')x.f.map.delete(h.pool);
  else {const a=x.f.map.get(h.pool),p=sdk.coder.accounts.decode('pool',Buffer.from(a.data[0],'base64'));p[mode==='mayhem'?'isMayhemMode':'isCashbackCoin']=true;a.data[0]=(await encode('pool',p)).toString('base64');}
  const {m}=await metric(x);assert.notEqual(m.quality,'KNOWN',mode);assert.equal((m.data as any).share,null,mode);
 }
});
test('mixed quote members retain individually measured capacities without summing incomparable atomic units',async()=>{
 const x=await custom(USDC_MINT);if(x.p.method!=='a12-reviewed-candidate-set-v2')throw Error('FIXTURE');x.p.routeHints=x.p.routeHints!.slice(0,1);
 const {m}=await metric(x),d=m.data as any;assert.equal(m.reasonCode,'EXIT_CAPACITY_MIXED_QUOTE_UNRESOLVED');assert.equal(d.candidates.length,2);assert.ok(d.candidates.every((c:any)=>c.status==='KNOWN'&&c.capacityAtomic!==null));assert.equal(d.share,null);assert.equal(d.denominatorAtomic,null);
});
function tlv(type:number,data:Buffer){const h=Buffer.alloc(4);h.writeUInt16LE(type);h.writeUInt16LE(data.length,2);return Buffer.concat([h,data]);}
async function passiveQuote(){
 const x=await custom(new PublicKey(Buffer.alloc(32,88)),true),raw=mint(1000000000000000n,8);raw.writeUInt32LE(1,0);new PublicKey(Buffer.alloc(32,1)).toBuffer().copy(raw,4);raw.writeUInt32LE(1,46);new PublicKey(Buffer.alloc(32,2)).toBuffer().copy(raw,50);
 const hook=Buffer.alloc(64);hook[0]=1;const pause=Buffer.alloc(33);pause[0]=2;const scaled=Buffer.alloc(56);scaled[0]=3;scaled.writeDoubleLE(1,32);scaled.writeDoubleLE(1,48);const confidential=Buffer.alloc(65);confidential[0]=4;
 const prefix=Buffer.alloc(166);raw.copy(prefix);prefix[165]=1;
 const ext=new Map([[12,Buffer.alloc(32,5)],[14,hook],[26,pause],[25,scaled],[4,confidential]]);
 const sync=()=>x.f.map.set(x.quote.toBase58(),account(TOKEN_2022_PROGRAM_ID,Buffer.concat([prefix,...[...ext].map(([t,d])=>tlv(t,d))])));
 for(const h of (x.p as any).routeHints){const p=sdk.coder.accounts.decode('pool',Buffer.from(x.f.map.get(h.pool).data[0],'base64')),a=x.f.map.get(p.poolQuoteTokenAccount.toBase58()),raw=Buffer.from(a.data[0],'base64').subarray(0,165);a.data[0]=Buffer.concat([raw,Buffer.from([2]),tlv(7,Buffer.alloc(0)),tlv(27,Buffer.alloc(0)),tlv(15,Buffer.from([0]))]).toString('base64');}
 sync();return {...x,ext,sync};
}
test('passive stock quote admits current ordinary transfers while preserving mutable authority risks and rejecting activation',async()=>{
 const x=await passiveQuote(),{m}=await metric(x),d=m.data as any;assert.equal(m.quality,'KNOWN');assert.equal(d.candidates[0].quoteTransfer.method,'current-ordinary-quote-transfer-v1');assert.ok(d.candidates[0].quoteTransfer.authorityRisks.permanentDelegate);assert.ok(d.candidates[0].quoteTransfer.authorityRisks.freezeAuthority);assert.equal(d.candidates[0].quoteTransfer.activeTransferHook,false);
 for(const [kind,offset]of [[14,32],[26,32],[25,32],[4,32]] as const){const x=await passiveQuote(),ext=x.ext.get(kind)!;ext[offset]=1;x.sync();assert.notEqual((await metric(x)).m.quality,'KNOWN',String(kind));}
 const y=await passiveQuote();y.ext.set(1,Buffer.alloc(108));y.sync();assert.notEqual((await metric(y)).m.quality,'KNOWN');
});
test('quote vault confidential/reentrant/unknown flags or frozen state invalidate passive mint admission',async()=>{
 for(const flag of ['confidential','transferring','frozen','missing']){const x=await passiveQuote(),h=(x.p as any).routeHints[0],p=sdk.coder.accounts.decode('pool',Buffer.from(x.f.map.get(h.pool).data[0],'base64')),a=x.f.map.get(p.poolQuoteTokenAccount.toBase58());let d=Buffer.from(a.data[0],'base64');if(flag==='confidential')d=Buffer.concat([d,tlv(5,Buffer.alloc(1))]);else if(flag==='transferring')d[d.length-1]=1;else if(flag==='frozen')d[108]=2;else d=d.subarray(0,170);a.data[0]=d.toString('base64');assert.notEqual((await metric(x)).m.quality,'KNOWN',flag);}
});
test('current unfrozen USDC quote with mint/freeze authorities stays quoted with explicit authority risk',async()=>{
 const x=await custom(USDC_MINT),a=x.f.map.get(USDC_MINT.toBase58()),d=Buffer.from(a.data[0],'base64');d.writeUInt32LE(1,0);Buffer.alloc(32,1).copy(d,4);d.writeUInt32LE(1,46);Buffer.alloc(32,2).copy(d,50);a.data[0]=d.toString('base64');const {m}=await metric(x);assert.equal(m.quality,'KNOWN');assert.ok((m.data as any).candidates[0].quoteTransfer.authorityRisks.freezeAuthority);
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

test('fresh proof34 persists custom passive quote bytes and rejects namespace, route and legacy-dispatch substitutions',async()=>{
 const x=await passiveQuote(),fetcher:typeof fetch=(url,init)=>{if(init?.method==='POST'){const r=JSON.parse(String(init.body));if(r.method==='getMultipleAccounts'&&r.params[0][0]===GLOBAL_CONFIG_PDA.toBase58())return x.f.fetcher(url,init);}return baselineFetch(url,init);};
 const b=await collectLiveToken(target,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,a12CandidateSet:x.p,fetcher,now:()=>at}),proof=JSON.parse(b.rawArtifacts['advisory-derivation']!);
 assert.equal(proof.method,'advisory-provenance-v39');assert.equal(b.details!.advisory!.metrics.find(m=>m.id==='A12')!.quality,'KNOWN');assert.equal(b.evidence.find(e=>e.id==='a12-reviewed-candidate-set')!.scope!.method,'a12-reviewed-candidate-set-v2');
 assert.deepEqual(reconstructAdvisory(target,at,b.details!.baseline,b.evidence,b.rawArtifacts,proof,b.thesis??null,b.features),b.details!.advisory);
 const dir=mkdtempSync(join(tmpdir(),'meme-a12custom-')),file=join(dir,'case.sqlite');let service=new Service(file);
 try{const saved=service.analyzeLive(b);service.close();service=new Service(file);assert.deepEqual(service.replay(saved.id),saved);
 type Bundle=typeof b;
 for(const mutate of [(b:Bundle)=>{const p=JSON.parse(b.rawArtifacts['advisory-derivation']!);p.method='advisory-provenance-v33';b.rawArtifacts['advisory-derivation']=JSON.stringify(p);},(b:Bundle)=>{b.evidence.find(e=>e.id==='a12-reviewed-candidate-set')!.scope={method:'a12-reviewed-candidate-set-v1'};},(b:Bundle)=>{const p=JSON.parse(b.rawArtifacts['a12-reviewed-candidate-set']!);p.routeHints[0].quoteMint=NATIVE_MINT.toBase58();b.rawArtifacts['a12-reviewed-candidate-set']=JSON.stringify(p);}]){const tampered=structuredClone(b);mutate(tampered);for(const e of tampered.evidence)e.contentHash=createHash('sha256').update(tampered.rawArtifacts[e.id]!).digest('hex');assert.throws(()=>service.analyzeLive(tampered),/ADVISORY_PROOF_INVALID/);}
 }finally{service.close();rmSync(dir,{recursive:true,force:true});}
});
test('custom stock/exotic fee schedule and creator holder-reward rate are charged exactly once',async()=>{
 const x=await custom(new PublicKey(Buffer.alloc(32,88)));x.f.map.set(PUMP_AMM_FEE_CONFIG_PDA.toBase58(),account(PUMP_FEE_PROGRAM_ID,await encode('feeConfig',{bump:1,admin:PublicKey.default,flatFees:rates,feeTiers:[{marketCapLamportsThreshold:bn(0),fees:rates}],stableFeeTiers:[],exoticFlatFees:{lpFeeBps:bn(80),protocolFeeBps:bn(40),creatorFeeBps:bn(5)}})));
 const {m}=await metric(x);assert.equal(m.quality,'KNOWN');assert.deepEqual((m.data as any).candidates[0].feesBps,['80','40','25']);
});
