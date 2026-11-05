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
import {a12WitnessSourceFixture,rebindA12WitnessFixture} from './a12-witness-source-fixtures.js';
import {a12WitnessSourcesFromAcquisition,type A12ZeroWitnessCapture} from '../src/providers/advisory-exit-capacity-witness.js';
import {collectA12ZeroWitnessCapacity,deriveA12ZeroWitnessCapacity} from '../src/providers/advisory-exit-capacity-custom.js';
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
 assert.equal(proof.method,'advisory-provenance-v40');assert.equal(b.details!.advisory!.metrics.find(m=>m.id==='A12')!.quality,'KNOWN');assert.equal(b.evidence.find(e=>e.id==='a12-reviewed-candidate-set')!.scope!.method,'a12-reviewed-candidate-set-v2');
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

/** Constructed complete three-member catalog: zero target in Q, positive peer in target units,
 * plus a positive WSOL nuisance term. Membership is fixed before any capacity calculation. */
async function zeroComparisonFixture(peerQuote=new PublicKey(target.address)){
 const f=await fixture(),nuisance={chain:'solana' as const,address:new PublicKey(Buffer.alloc(32,73)).toBase58()},tokens=[target,peer,nuisance],p=packet(tokens),quote=new PublicKey(Buffer.alloc(32,88)),quotes=[quote,peerQuote,NATIVE_MINT],routes:Array<{token:typeof target;pool:string;baseVault:string;quoteVault:string}>=[];
 f.map.set(quote.toBase58(),account(TOKEN_PROGRAM_ID,mint(1000000000000000n,6)));
 if(!f.map.has(peerQuote.toBase58()))f.map.set(peerQuote.toBase58(),account(TOKEN_PROGRAM_ID,mint(1000000000000000n,6)));
 const hints:any[]=[];
 for(const[i,t]of tokens.entries()){
  const m=new PublicKey(t.address),q=quotes[i]!,creator=pumpPoolAuthorityPda(m),pk=poolPda(0,creator,m,q),bv=getAssociatedTokenAddressSync(m,pk,true),qv=getAssociatedTokenAddressSync(q,pk,true);
  f.map.set(t.address,account(TOKEN_PROGRAM_ID,mint(1000000000000000n,6)));
  f.map.set(pk.toBase58(),account(PUMP_AMM_PROGRAM_ID,await encode('pool',{poolBump:1,index:0,creator,baseMint:m,quoteMint:q,lpMint:lpMintPda(pk),poolBaseTokenAccount:bv,poolQuoteTokenAccount:qv,lpSupply:bn(1000),coinCreator:new PublicKey(Buffer.alloc(32,1)),isMayhemMode:false,isCashbackCoin:false,virtualQuoteReserves:bn(100000),creatorFeeBps:bn(i===0?300:0),canEditCreatorFee:false})));
  f.map.set(bv.toBase58(),account(TOKEN_PROGRAM_ID,vault(m,pk,100000000000000n)));f.map.set(qv.toBase58(),account(TOKEN_PROGRAM_ID,vault(q,pk,BigInt(i+1)*700000000000n)));
  const source=p.sources[i]!;source.text+=' Canonical pool '+pk.toBase58()+' quote mint '+q.toBase58();p.acquisition.requests[i]!.body=source.text;hints.push({token:t,pool:pk.toBase58(),quoteMint:q.toBase58(),sourceId:source.id,quote:source.text});routes.push({token:t,pool:pk.toBase58(),baseVault:bv.toBase58(),quoteVault:qv.toBase58()});
 }
 if(p.method!=='a12-reviewed-candidate-set-v2')throw Error('FIXTURE');p.routeHints=hints;const proposal={claims:[],posts:[],competitors:tokens.map((token,i)=>({id:'candidate'+i,token,sourceId:p.sources[i]!.id,quote:p.sources[i]!.text}))};p.proposal.prompt=a12ProposalPrompt(p);p.proposal.response=JSON.stringify(proposal);p.review.prompt=a12ReviewPrompt(p,proposal);
 const capture=()=>collectExitCapacity(p,target,'300',499,'https://example.com/rpc',f.fetcher,()=>at);
 const changePool=async(i:number,change:(p:any)=>void)=>{const a=f.map.get(routes[i]!.pool),pool=sdk.coder.accounts.decode('pool',Buffer.from(a.data[0],'base64'));change(pool);a.data[0]=(await encode('pool',pool)).toString('base64');};
 return{f,p,routes,quote,capture,changePool};
}

test('explicit zero-target comparison preserves every native capacity and identifies only the scalar with unvalued denominator',async()=>{
 const x=await zeroComparisonFixture(),r=await x.capture(),old=deriveExitCapacity(x.p,target,at,'300',r,[]),disabled=deriveExitCapacity(x.p,target,at,'300',r,[],false),got=deriveExitCapacity(x.p,target,at,'300',r,['native'],true),d=got.data as any;
 assert.deepEqual(old,disabled);assert.equal(old.reasonCode,'EXIT_CAPACITY_MIXED_QUOTE_UNRESOLVED');assert.equal(got.quality,'KNOWN');assert.equal(got.reasonCode,'ZERO_TARGET_CAPACITY_SHARE_POINT_IDENTIFIED');assert.equal(d.method,'impact-bounded-zero-target-capacity-share-v3');assert.equal(d.share,'0');assert.equal(d.denominatorAtomic,null);assert.equal(d.quoteMint,null);assert.equal(d.quoteDecimals,null);assert.equal(d.impactBps,'300');assert.equal(d.level,'QUOTED');
 assert.equal(d.comparison.method,'zero-target-positive-reference-invariant-v1');assert.equal(d.comparison.denominatorStatus,'POSITIVE_UNVALUED');assert.equal(d.comparison.normalization,'NOT_PERFORMED');assert.equal(d.comparison.valuationClass,'FINITE_NONNEGATIVE_WITH_POSITIVE_TARGET_REFERENCE');assert.equal(d.comparison.reference.pool,x.routes[0]!.pool);assert.equal(d.comparison.reference.baseMint,target.address);assert.equal(d.comparison.reference.quoteMint,x.quote.toBase58());assert.equal(d.comparison.reference.bankSlot,500);assert.ok(BigInt(d.comparison.reference.baseReserveAtomic)>0n&&BigInt(d.comparison.reference.physicalQuoteAtomic)>0n&&BigInt(d.comparison.reference.virtualQuoteAtomic)>=0n);
 const native=(old.data as any).candidates;assert.deepEqual(d.candidates.map(({share,...c}:any)=>c),native);assert.equal(d.candidates[0].share,'0');assert.ok(d.candidates.slice(1).every((c:any)=>c.status==='KNOWN'&&BigInt(c.capacityAtomic)>0n&&c.share===null));assert.equal(d.comparison.positiveCapacityWitnesses.length,1);assert.equal(d.comparison.positiveCapacityWitnesses[0].quoteMint,target.address);assert.equal(d.candidates[2].quoteMint,NATIVE_MINT.toBase58());assert.equal(d.candidates[2].quoteDecimals,9);assert.deepEqual(d.candidates[0].feesBps,['20','15','300']);
 // Independent integer checks of the declared class, including a zero-valued SOL nuisance.
 for(const anchorValue of [1n,100n,1000000000000000000n])for(const nuisanceValue of [0n,1n,999999999999999999n]){const denom=BigInt(d.candidates[1].capacityAtomic)*anchorValue+BigInt(d.candidates[2].capacityAtomic)*nuisanceValue;assert.ok(denom>0n);assert.equal(0n/denom,0n);}
});

test('same-quote output remains byte-identical with the zero-target option true or omitted',async()=>{
 const x=await custom(USDC_MINT),r=await collectExitCapacity(x.p,target,'300',499,'https://example.com/rpc',x.f.fetcher,()=>at);assert.deepEqual(deriveExitCapacity(x.p,target,at,'300',r,[],true),deriveExitCapacity(x.p,target,at,'300',r,[]));
});

test('positive target, all-zero vector and an unanchored positive nuisance cannot manufacture a zero share',async()=>{
 for(const mode of ['positive-target','all-zero','no-anchor']){
  const x=await zeroComparisonFixture(mode==='no-anchor'?USDC_MINT:new PublicKey(target.address));if(mode==='positive-target')await x.changePool(0,p=>p.creatorFeeBps=bn(0));if(mode==='all-zero')for(let i=1;i<3;i++)await x.changePool(i,p=>p.creatorFeeBps=bn(300));const r=await x.capture(),m=deriveExitCapacity(x.p,target,at,'300',r,[],true),d=m.data as any;assert.equal(m.quality,'MISSING',mode);assert.equal(m.reasonCode,'EXIT_CAPACITY_MIXED_QUOTE_UNRESOLVED',mode);assert.equal(d.share,null);assert.equal(d.denominatorAtomic,null);assert.ok(d.candidates.every((c:any)=>c.status==='KNOWN'));
 }
});

test('target reference and every catalog member remain fully native-admitted before the invariant',async()=>{
 for(const mode of ['null-peer','mayhem','bad-target-reference','wrong-vault-mint','shared-route']){
  const x=await zeroComparisonFixture(mode==='shared-route'?new PublicKey(peer.address):new PublicKey(target.address));if(mode==='null-peer')x.f.map.delete(x.routes[1]!.pool);else if(mode==='mayhem')await x.changePool(1,p=>p.isMayhemMode=true);else if(mode==='bad-target-reference'){const a=x.f.map.get(x.routes[0]!.quoteVault),v=Buffer.from(a.data[0],'base64');v.writeBigUInt64LE(0n,64);a.data[0]=v.toString('base64');}else if(mode==='wrong-vault-mint'){const a=x.f.map.get(x.routes[1]!.baseVault),v=Buffer.from(a.data[0],'base64');NATIVE_MINT.toBuffer().copy(v,0);a.data[0]=v.toString('base64');}
  const r=await x.capture(),m=deriveExitCapacity(x.p,target,at,'300',r,[],true);assert.notEqual(m.quality,'KNOWN',mode);assert.equal((m.data as any).share,null,mode);
 }
});

test('an actual capped integer search stays TRUNCATED even with zero target and an otherwise positive nuisance',async()=>{
 const x=await zeroComparisonFixture();await x.changePool(1,p=>p.virtualQuoteReserves=bn(0));const base=x.f.map.get(x.routes[1]!.baseVault),b=Buffer.from(base.data[0],'base64');b.writeBigUInt64LE(9700n,64);base.data[0]=b.toString('base64');const quote=x.f.map.get(x.routes[1]!.quoteVault),q=Buffer.from(quote.data[0],'base64');q.writeBigUInt64LE(9955n*1000001n,64);quote.data[0]=q.toString('base64');const r=await x.capture(),m=deriveExitCapacity(x.p,target,at,'300',r,[],true),d=m.data as any;assert.equal(m.quality,'TRUNCATED');assert.equal(d.share,null);assert.equal(d.candidates[1].boundary.stop,'INTEGER_INTERVAL_CAP');assert.equal(d.candidates[1].capacityAtomic,null);
});

test('catalog, raw bank, request and freshness failures cannot borrow an exact-zero native result',async()=>{
 const x=await zeroComparisonFixture(),r=await x.capture(),rejected=structuredClone(x.p),review=JSON.parse(rejected.review.response);review.candidateSet.complete=false;rejected.review.response=JSON.stringify(review);assert.equal(deriveExitCapacity(rejected,target,at,'300',r,[],true).quality,'MISSING');
 const changed=structuredClone(x.p);changed.sources[0]!.text+=' altered';assert.throws(()=>deriveExitCapacity(changed,target,at,'300',r,[],true));
 for(const mode of ['request','bank']){const bad=structuredClone(r);if(mode==='request')(bad.requests.bank!.params[1] as any).minContextSlot++;else{const b=JSON.parse(bad.rawArtifacts.bank!);b.result.value.pop();bad.rawArtifacts.bank=JSON.stringify(b);}assert.notEqual(deriveExitCapacity(x.p,target,at,'300',bad,[],true).quality,'KNOWN',mode);}
 const stale=deriveExitCapacity(x.p,target,'2026-10-24T12:00:31.000Z','300',r,[],true);assert.equal(stale.reasonCode,'EXIT_CAPACITY_QUOTE_STALE');assert.equal((stale.data as any).share,null);
});


/** Constructed witness protocol over the same explicit native vectors as the catalog tests.
 * Model transport is constructed; these records never represent genuine model executions. */
function witnessFromNative(x:Awaited<ReturnType<typeof zeroComparisonFixture>>,rejected=false){
 const c=a12WitnessSourceFixture(rejected);c.target=target;c.witness=peer;c.createdAt=at;c.acquisition.startedAt=at;
 for(const e of c.executions){e.startedAt=at;e.finishedAt=at;}
 const batch=c.acquisition.batches[0]!;batch.availableAt=at;batch.requestedUrls=x.p.sources.map(s=>s.url);batch.raw=JSON.stringify({results:x.p.sources.map(s=>({url:s.url,text:s.text,links:[]})),errors:[]});
 const rebuilt=a12WitnessSourcesFromAcquisition(c.acquisition);c.sources=rebuilt.sources;c.acquisition.sourceIds=rebuilt.sourceIds;c.acquisition.complete=rebuilt.complete;
 if(x.p.method!=='a12-reviewed-candidate-set-v2')throw Error('FIXTURE');
 c.routeHints=x.p.routeHints!.slice(0,2).map((h,i)=>({...h,sourceId:c.sources[i]!.id})) as A12ZeroWitnessCapture['routeHints'];
 c.diagnostics.knownLeads=[{token:x.routes[2]!.token,sourceIds:[c.sources[2]!.id],status:'NOT_ADJUDICATED',rationale:'Additional narrative lead remains unmeasured by this pair-only native plan.'}];
 const proposal={claims:[],posts:[],competitors:c.routeHints.map((h,i)=>({id:i===0?'target':'witness',token:h.token,sourceId:h.sourceId,quote:h.quote}))};rebindA12WitnessFixture(c,proposal);return c;
}
async function witnessMetric(x:Awaited<ReturnType<typeof zeroComparisonFixture>>,c=witnessFromNative(x)){
 const raw=JSON.stringify(c),r=await collectA12ZeroWitnessCapacity(raw,target,'300',499,'https://example.com/rpc',x.f.fetcher,()=>at);
 return {raw,r,m:deriveA12ZeroWitnessCapacity(raw,target,at,'300',r,['witness-native'])};
}

test('witness native pair preserves catalog native diagnostics, exact two-RPC order, fees and unmeasured leads',async()=>{
 const x=await zeroComparisonFixture(),catalog=deriveExitCapacity(x.p,target,at,'300',await x.capture(),[],true),before=x.f.requests.length,{raw,r,m}=await witnessMetric(x),d=m.data as any;
 assert.equal(x.f.requests.length-before,2);assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'ZERO_TARGET_CAPACITY_SHARE_WITNESS_IDENTIFIED');assert.equal(d.method,'impact-bounded-zero-witness-capacity-share-v1');assert.equal(d.share,'0');assert.equal(d.denominatorAtomic,null);assert.equal(d.quoteMint,null);assert.equal(d.quoteDecimals,null);assert.equal(d.membershipComplete,false);assert.equal(d.comparison.membershipComplete,false);assert.equal(d.comparison.denominatorStatus,'POSITIVE_UNVALUED');assert.equal(d.comparison.normalization,'NOT_PERFORMED');assert.equal(d.candidateSourceHash,createHash('sha256').update(raw).digest('hex'));
 assert.deepEqual(d.candidates.map(({share,...c}:any)=>c),(catalog.data as any).candidates.slice(0,2).map(({share,...c}:any)=>c));assert.deepEqual(d.candidates.map((c:any)=>c.share),['0',null]);assert.deepEqual(d.candidates[0].feesBps,['20','15','300']);assert.equal(d.comparison.reference.bankSlot,500);assert.equal(d.comparison.positiveCapacityWitnesses[0].quoteMint,target.address);
 assert.equal(d.diagnostics.knownLeads.length,1);assert.equal(d.diagnostics.knownLeads[0].status,'NOT_ADJUDICATED');assert.equal(d.candidates.length,2);assert.ok(!d.candidates.some((c:any)=>c.token.address===x.routes[2]!.token.address));
 assert.deepEqual(r.requests.discovery,{method:'getMultipleAccounts',params:[[GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58(),...x.routes.slice(0,2).map(r=>r.pool)],{encoding:'base64',commitment:'finalized',minContextSlot:499}]});
 const bank=[GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58()];for(const [i,route] of x.routes.slice(0,2).entries())bank.push(route.pool,route.token.address,(x.p as any).routeHints[i].quoteMint,route.baseVault,route.quoteVault);
 assert.deepEqual(r.requests.bank,{method:'getMultipleAccounts',params:[[...new Set(bank)],{encoding:'base64',commitment:'finalized',minContextSlot:500}]});
 for(const targetValue of [1n,100n,10n**30n])for(const extraCapacity of [0n,1n,10n**40n]){const denominator=BigInt(d.candidates[1].capacityAtomic)*targetValue+extraCapacity;assert.ok(denominator>0n);assert.equal(0n/denominator,0n);}
});

test('same-quote witness remains unvalued and never falls through to sampled pair normalization',async()=>{
 const x=await zeroComparisonFixture(new PublicKey(Buffer.alloc(32,88))),{m}=await witnessMetric(x),d=m.data as any;
 assert.equal(m.quality,'KNOWN');assert.equal(d.candidates[0].quoteMint,d.candidates[1].quoteMint);assert.equal(d.denominatorAtomic,null);assert.equal(d.quoteMint,null);assert.equal(d.quoteDecimals,null);assert.equal(d.candidates[1].share,null);assert.equal(d.comparison.denominatorStatus,'POSITIVE_UNVALUED');
});

test('unmeasured additional leads change disclosure but cannot change witness native quantities or target zero',async()=>{
 const x=await zeroComparisonFixture(),c=witnessFromNative(x),first=await witnessMetric(x,c);c.diagnostics.knownLeads=[];rebindA12WitnessFixture(c);const second=await witnessMetric(x,c);
 assert.equal(first.m.quality,'KNOWN');assert.equal(second.m.quality,'KNOWN');assert.deepEqual((first.m.data as any).candidates,(second.m.data as any).candidates);assert.equal((second.m.data as any).share,'0');assert.notEqual((first.m.data as any).candidateSourceHash,(second.m.data as any).candidateSourceHash);
});

test('witness mode rejects positive target, zero witness, unanchored quote and absent native pools without fabricating zeros',async()=>{
 for(const mode of ['positive-target','all-zero','no-anchor','null-peer','null-target','mayhem','bad-reference','shared-route','vault-mint']){
  const x=await zeroComparisonFixture(mode==='no-anchor'?USDC_MINT:mode==='shared-route'?new PublicKey(peer.address):new PublicKey(target.address));
  if(mode==='positive-target')await x.changePool(0,p=>p.creatorFeeBps=bn(0));if(mode==='all-zero')await x.changePool(1,p=>p.creatorFeeBps=bn(300));if(mode==='null-peer')x.f.map.delete(x.routes[1]!.pool);if(mode==='null-target')x.f.map.delete(x.routes[0]!.pool);if(mode==='mayhem')await x.changePool(1,p=>p.isMayhemMode=true);
  if(mode==='bad-reference'||mode==='vault-mint'){const a=x.f.map.get(mode==='bad-reference'?x.routes[0]!.quoteVault:x.routes[1]!.baseVault),v=Buffer.from(a.data[0],'base64');if(mode==='bad-reference')v.writeBigUInt64LE(0n,64);else NATIVE_MINT.toBuffer().copy(v,0);a.data[0]=v.toString('base64');}
  const {m}=await witnessMetric(x),d=m.data as any;assert.equal(m.quality,'MISSING',mode);assert.equal(d.share,null,mode);assert.equal(d.denominatorAtomic,null,mode);if(mode==='null-peer'||mode==='null-target'){const c=d.candidates[mode==='null-peer'?1:0];assert.equal(c.capacityAtomic,null);assert.equal(c.inputAtomic,null);assert.equal(c.reasonCode,'EXIT_CAPACITY_CANONICAL_POOL_UNAVAILABLE');}
 }
});

test('witness integer interval cap preserves TRUNCATED native boundary rather than a zero witness',async()=>{
 const x=await zeroComparisonFixture();await x.changePool(1,p=>p.virtualQuoteReserves=bn(0));for(const [key,amount]of [[x.routes[1]!.baseVault,9700n],[x.routes[1]!.quoteVault,9955n*1000001n]] as const){const a=x.f.map.get(key),v=Buffer.from(a.data[0],'base64');v.writeBigUInt64LE(amount,64);a.data[0]=v.toString('base64');}
 const {m}=await witnessMetric(x),d=m.data as any;assert.equal(m.quality,'TRUNCATED');assert.equal(d.share,null);assert.equal(d.candidates[1].boundary.stop,'INTEGER_INTERVAL_CAP');assert.equal(d.candidates[1].capacityAtomic,null);
});

test('witness source rejection, profile mismatch, RPC error, tampered requests and causal clocks preserve failures',async()=>{
 const x=await zeroComparisonFixture(),rejected=JSON.stringify(witnessFromNative(x,true)),before=x.f.requests.length,empty=await collectA12ZeroWitnessCapacity(rejected,target,'300',499,'https://example.com/rpc',x.f.fetcher,()=>at);assert.equal(x.f.requests.length,before);assert.deepEqual(empty,{requests:{},rawArtifacts:{},retrievedAt:{}});assert.equal(deriveA12ZeroWitnessCapacity(rejected,target,at,'300',empty,[]).quality,'MISSING');
 const {raw,r}=await witnessMetric(x);assert.throws(()=>deriveA12ZeroWitnessCapacity(raw,target,at,'301',r,[]),/ADVISORY_EXIT_CAPACITY_RECEIPT/);await assert.rejects(collectA12ZeroWitnessCapacity(raw,target,undefined,499,'https://example.com/rpc',x.f.fetcher,()=>at),/ADVISORY_EXIT_CAPACITY_RECEIPT/);
 for(const mode of ['request','bank-error','missing-bank','future-bank','source-after-discovery','stale']){const bad=structuredClone(r);let cutoff=at;if(mode==='request')(bad.requests.bank!.params[1] as any).minContextSlot++;if(mode==='bank-error')bad.rawArtifacts.bank=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32000}});if(mode==='missing-bank')for(const v of [bad.requests,bad.rawArtifacts,bad.retrievedAt])delete v.bank;if(mode==='future-bank')bad.retrievedAt.bank='2026-10-24T12:00:01.000Z';if(mode==='source-after-discovery')bad.retrievedAt.discovery='2026-10-24T11:59:59.999Z';if(mode==='stale')cutoff='2026-10-24T12:00:31.000Z';const m=deriveA12ZeroWitnessCapacity(raw,target,cutoff,'300',bad,[]);assert.equal(m.quality,'MISSING',mode);assert.equal((m.data as any).share,null,mode);}
 const orphan=structuredClone(r);orphan.rawArtifacts.extra='{}';assert.throws(()=>deriveA12ZeroWitnessCapacity(raw,target,at,'300',orphan,[]),/ADVISORY_EXIT_CAPACITY_RECEIPT/);
 const errorFetcher:typeof fetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32000}})),failed=await collectA12ZeroWitnessCapacity(raw,target,'300',499,'https://example.com/rpc',errorFetcher,()=>at);assert.deepEqual(Object.keys(failed.requests),['discovery']);assert.equal(deriveA12ZeroWitnessCapacity(raw,target,at,'300',failed,[]).quality,'MISSING');
});
