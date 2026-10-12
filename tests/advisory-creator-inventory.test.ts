import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorHeadRequest, creatorOwnerRequest, creatorPageRequest, creatorTransactionRequest, decodeCreatorInventory, deriveO24CreatorInventory, CREATOR_PAGE_LIMIT, type CreatorInventoryReceipts, type CreatorRole, type CreatorTape } from '../src/providers/advisory-creator-inventory.js';
import type { DemandTrade } from '../src/providers/advisory-demand-windows.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const W='8RXNzg9QEheV1SZyTLisckJRwziVoZFzGWA3tajj1yJg',MINT='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',A='Km6Zx9bT9MgWTTdaRZaXQhLEnUaPaBbTpB3B6aoJE2v';
const T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',PAMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',WSOL='So11111111111111111111111111111111111111112',CURVE='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',BUDGET='ComputeBudget111111111111111111111111111111';
const key=(n:number)=>encodeSolanaAddress(Buffer.alloc(32,n));
const sig=(n:number)=>{const b=Buffer.alloc(64,7);b.writeUInt32LE(n);return encodeSolanaAddress(b);};
const pool=key(30),vault=key(31),curveAta=key(32),curve=key(33),other=key(34),otherAccount=key(35);
const DEV='56869836267266',at=(iso:string)=>Date.parse(iso)/1000,cutoff='2026-10-12T05:00:00.000Z';
const anchorSlot=455909330,HEAD=455913999,CATALOG=455914007,token={chain:'solana' as const,address:MINT};
const role:CreatorRole={wallet:W,mint:MINT,creationSignature:sig(1),creationSlot:451486744};
type Ix={programId:string;parsed?:{type:string;info:Record<string,unknown>};accounts?:string[];inner?:Ix[]};
type Balance={account:string;owner:string;pre:string|null;post:string|null};
const xfer=(source:string,destination:string,amount:string,authority:string):Ix=>({programId:T22,parsed:{type:'transferChecked',info:{source,destination,mint:MINT,authority,tokenAmount:{amount,decimals:6,uiAmount:null,uiAmountString:amount}}}});
const shape=(i:Ix,stackHeight:number|null)=>({programId:i.programId,stackHeight,...(i.parsed?{program:'spl-token-2022',parsed:i.parsed}:{accounts:i.accounts??[],data:''})});
function tx(n:number,slot:number,blockTime:number,keys:string[],top:Ix[],balances:Balance[]){
 // Receipts list every instruction account; every fixture form names the target mint as transferChecked does, so it is always a key.
 const list=[...new Set([...keys,MINT])],entry=(b:Balance,amount:string|null)=>amount===null?[]:[{accountIndex:list.indexOf(b.account),mint:MINT,owner:b.owner,programId:T22,uiTokenAmount:{amount,decimals:6,uiAmount:null,uiAmountString:amount}}];
 return{slot,blockTime,version:0,transaction:{signatures:[sig(n)],message:{accountKeys:list.map((pubkey,i)=>({pubkey,signer:i===0,writable:true,source:'transaction'})),instructions:top.map(i=>shape(i,null))}},
  meta:{err:null,innerInstructions:top.flatMap((i,index)=>i.inner?.length?[{index,instructions:i.inner.map(c=>shape(c,2))}]:[]),
   logMessages:top.flatMap(i=>[`Program ${i.programId} invoke [1]`,...(i.inner??[]).flatMap(c=>[`Program ${c.programId} invoke [2]`,`Program ${c.programId} success`]),`Program ${i.programId} success`]),
   preTokenBalances:balances.flatMap(b=>entry(b,b.pre)),postTokenBalances:balances.flatMap(b=>entry(b,b.post))}};
}
const SYSTEM='11111111111111111111111111111111',createMint:Ix={programId:SYSTEM,parsed:{type:'createAccount',info:{source:W,newAccount:MINT,lamports:1,space:234,owner:T22}}},pointer:Ix={programId:T22,parsed:{type:'initializeMetadataPointer',info:{mint:MINT,metadataAddress:MINT}}};
const makeCreation=(beforeMint:Ix[]=[createMint,pointer],signers=2)=>{
 const t=tx(1,451486744,at('2026-09-29T00:57:47Z'),[W,MINT,A,curveAta,curve],[{programId:CURVE,accounts:[W,MINT],inner:[...beforeMint,{programId:T22,parsed:{type:'initializeMint2',info:{mint:MINT,decimals:6,mintAuthority:curve}}},{programId:T22,parsed:{type:'initializeAccount3',info:{account:A,mint:MINT,owner:W}}},xfer(curveAta,A,DEV,curve)]}],[{account:A,owner:W,pre:null,post:DEV},{account:curveAta,owner:curve,pre:null,post:'943130163732734'}]);
 t.transaction.message.accountKeys.forEach((k,i)=>{k.signer=i<signers;});return t;
};
const creation=makeCreation();
const sell=tx(2,451486786,at('2026-09-29T00:57:57Z'),[W,A,curveAta,curve],[{programId:BUDGET},{programId:CURVE,accounts:[W,A],inner:[xfer(A,curveAta,DEV,W)]}],[{account:A,owner:W,pre:DEV,post:'0'},{account:curveAta,owner:curve,pre:'668999916524389',post:'725869752791655'}]);
const transferIn=(frame=T22)=>tx(10,455800000,at('2026-10-11T23:00:00Z'),[other,otherAccount,A,...(frame===T22?[]:[frame])],frame===T22?[xfer(otherAccount,A,'500',other)]:[{programId:frame,accounts:[other],inner:[xfer(otherAccount,A,'500',other)]}],[{account:A,owner:W,pre:'0',post:'500'},{account:otherAccount,owner:other,pre:'500',post:'0'}]);
const poolSell=tx(11,455800100,at('2026-10-12T01:00:00Z'),[W,pool,MINT,WSOL,A,vault,key(36),key(37)],[{programId:PAMM,accounts:[pool,W,key(36),MINT,WSOL,A,key(37),vault],inner:[xfer(A,vault,'200',W)]}],[{account:A,owner:W,pre:'500',post:'300'},{account:vault,owner:pool,pre:'1000',post:'1200'}]);
const sellTrade:DemandTrade={signature:sig(11),slot:455800100,at:'2026-10-12T01:00:00.000Z',user:W,side:'SELL',baseAtomic:'200',quoteAtomic:'9000',poolBaseReservesAtomic:'1',poolQuoteReservesAtomic:'1',instructionIndex:0,transactionIndex:1};
const foreignTouch=tx(20,455700000,at('2026-10-10T00:00:00Z'),[W,key(38),key(39)],[xfer(key(38),key(39),'5',W)],[{account:key(38),owner:W,pre:'5',post:'0'},{account:key(39),owner:other,pre:'0',post:'5'}]);
const row=(t:any)=>({blockTime:t.blockTime,confirmationStatus:'finalized',err:null,memo:null,signature:t.transaction.signatures[0],slot:t.slot,transactionIndex:1});
const rpc=(result:unknown)=>JSON.stringify({jsonrpc:'2.0',result,id:1});
const parsedAccount=(amount:string)=>({lamports:1513840,owner:T22,executable:false,rentEpoch:0,space:170,data:{program:'spl-token-2022',space:170,parsed:{type:'account',info:{extensions:[{extension:'immutableOwner'}],isNative:false,mint:MINT,owner:W,state:'initialized',tokenAmount:{amount,decimals:6,uiAmount:null,uiAmountString:amount}}}}});
type World={interval:any[];trades:DemandTrade[];head:string;others:Array<{account:string;amount:string}>;wallet:boolean;walletExtra:any[];headAt:string;complete:boolean};
function world(o:Partial<World>={}){
 const w:World={interval:[],trades:[],head:'0',others:[],wallet:true,walletExtra:[],headAt:'2026-10-12T04:25:34.000Z',complete:true,...o};
 const receipts:CreatorInventoryReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 const put=(id:string,request:{method:string;params:unknown[]},result:unknown,time:string)=>{receipts.requests[id]=request;receipts.rawArtifacts[id]=rpc(result);receipts.retrievedAt[id]=time;};
 const putTx=(t:any)=>put(`creator-tx-${t.transaction.signatures[0]}`,creatorTransactionRequest(t.transaction.signatures[0]),t,'2026-10-12T04:31:00.000Z');
 const desc=(list:any[])=>[...list].sort((a,b)=>b.slot-a.slot);
 const failed=[0,1,2].map(i=>({blockTime:at('2026-09-29T00:57:58Z'),confirmationStatus:'finalized',err:{InstructionError:[2,{Custom:1}]},memo:null,signature:sig(500+i),slot:451486799-i,transactionIndex:i}));
 put('creator-ata-head',creatorHeadRequest(A,anchorSlot),{context:{slot:HEAD},value:parsedAccount(w.head)},w.headAt);
 put('creator-ata-page-0',creatorPageRequest(A,HEAD),[...desc(w.interval).map(row),...failed,row(sell),row(creation)],'2026-10-12T04:25:35.000Z');
 for(const t of [sell,...w.interval])putTx(t);
 put('creator-owner-accounts',creatorOwnerRequest(W,MINT,HEAD),{context:{slot:CATALOG},value:[{pubkey:A,account:parsedAccount(w.head)},...w.others.map(x=>({pubkey:x.account,account:parsedAccount(x.amount)}))]},'2026-10-12T04:25:36.000Z');
 if(w.wallet){
  const mine=desc([...w.interval.filter(t=>t.transaction.message.accountKeys.some((k:any)=>k.pubkey===W)),...w.walletExtra]);
  const earlier={blockTime:at('2026-09-28T23:04:03Z'),confirmationStatus:'finalized',err:null,memo:null,signature:sig(3),slot:451461280,transactionIndex:61};
  put('creator-wallet-page-0',creatorPageRequest(W,CATALOG),[...mine.map(row),row(sell),row(creation),earlier],'2026-10-12T04:30:00.000Z');
  for(const t of [creation,...mine])putTx(t);
 }
 const tape:CreatorTape={history:{complete:w.complete,pool,anchorSlot,range:{start:'2026-10-11T16:00:00.000Z',baselineEnd:'2026-10-11T22:00:00.000Z',end:'2026-10-12T04:00:00.000Z'},trades:w.trades},vault};
 return{receipts,tape};
}
const decode=(x:ReturnType<typeof world>)=>{const history=decodeCreatorInventory(token,role,x.tape,x.receipts,cutoff);return{history,metric:deriveO24CreatorInventory(history,x.tape,['evidence-1'])};};
const run=(o:Partial<World>={})=>decode(world(o));

test('derives the canonical account and measures a proven empty interval with the whole-cohort exit proof as KNOWN zero', () => {
  const { history, metric } = run(), data = metric.data as any;
  assert.equal(history.account, A);
  assert.equal(metric.quality, 'KNOWN'); assert.equal(metric.reasonCode, 'CREATOR_SIGNER_INVENTORY_OBSERVED');
  assert.equal(history.walletProof.status, 'OBSERVED'); assert.equal(data.pendingPremises.length, 0); assert.equal(data.scope, 'CREATION_SIGNER_WALLET_ALL_TARGET_MINT_ACCOUNTS');
  assert.deepEqual([data.inventory.startAtomic, data.inventory.endAtomic, data.inventory.netChangeAtomic, data.inventory.legs], ['0', '0', '0', 0]);
  assert.equal(data.canonical.startWitness.signature, sig(2));
  assert.equal(data.canonical.legs.length, 0, 'the pre-interval bonding-curve leg is a balance witness, never a labelled sale');
  assert.equal(data.walletProof.successfulInspected, 2);
  assert.equal(data.cohort.identity, null); assert.equal(data.nonCanonicalAccountsZeroThroughout, true);
});

test('without the wallet exit proof only the canonical component is reported', () => {
  const data = run({ wallet: false }).metric as any;
  assert.equal(data.quality, 'TRUNCATED'); assert.equal(data.reasonCode, 'CREATOR_NON_CANONICAL_ACCOUNTS_UNPROVEN');
  assert.equal(data.data.scope, 'CREATION_SIGNER_CANONICAL_ACCOUNT_COMPONENT'); assert.equal(data.data.nonCanonicalAccountsZeroThroughout, null);
  assert.equal(data.data.walletProof.code, 'CREATOR_RECEIPT_ABSENT');
});

test('binds interval pool sells to the A30 tape and counts incoming transfers that never reference the creator', () => {
  const { metric } = run({ interval: [transferIn(), poolSell], trades: [sellTrade], head: '300' }), inv = (metric.data as any).inventory;
  assert.equal(metric.quality, 'KNOWN'); assert.equal((metric.data as any).walletProof.status, 'OBSERVED');
  assert.deepEqual([inv.startAtomic, inv.endAtomic, inv.netChangeAtomic, inv.transferInBaseAtomic, inv.poolSellBaseAtomic, inv.poolSellCoreQuoteAtomic, inv.poolBuyBaseAtomic], ['0', '300', '300', '500', '200', '9000', '0']);
});

test('a transfer inside a non-inert frame is unattributed, never a plain transfer', () => {
  const { metric } = run({ interval: [transferIn(key(40))], head: '500' });
  assert.equal(metric.quality, 'MISSING'); assert.equal(metric.reasonCode, 'CREATOR_ATA_UNATTRIBUTED_LEG');
});

test('creator-owned non-canonical accounts block the whole-wallet claim unless proven zero', () => {
  assert.equal((run({ walletExtra: [foreignTouch] }).metric.data as any).walletProof.code, 'CREATOR_NON_CANONICAL_ACCOUNT_TOUCHED');
  const funded = run({ others: [{ account: key(38), amount: '7' }] }).metric;
  assert.equal(funded.quality, 'TRUNCATED'); assert.equal((funded.data as any).walletProof.code, 'CREATOR_NON_CANONICAL_BALANCE');
  const empty = run({ others: [{ account: key(38), amount: '0' }] });
  assert.equal(empty.metric.quality, 'KNOWN'); assert.equal(empty.history.walletProof.status, 'OBSERVED'); assert.deepEqual(empty.history.walletProof.otherCurrentAccounts, [{ account: key(38), amountAtomic: '0' }]);
});

test('head, clock, request and membership guards fail closed', () => {
  assert.equal(run({ head: '5' }).metric.reasonCode, 'CREATOR_ATA_HEAD_CONTINUITY');
  assert.equal(run({ headAt: '2026-10-12T03:59:00.000Z' }).metric.reasonCode, 'CREATOR_ATA_HEAD_TIME');
  const forged = world(); forged.receipts.requests['creator-ata-head'] = creatorHeadRequest(A, anchorSlot + 1);
  assert.equal(decode(forged).metric.reasonCode, 'CREATOR_INVENTORY_REQUEST');
  const extra = world(); extra.receipts.requests['creator-extra'] = { method: 'getSlot', params: [] }; extra.receipts.rawArtifacts['creator-extra'] = '{}'; extra.receipts.retrievedAt['creator-extra'] = cutoff;
  assert.throws(() => decode(extra), /CREATOR_INVENTORY_RECEIPT_MEMBERSHIP/);
});

test('tape scope and creator trades outside the tracked account', () => {
  const incomplete = run({ complete: false });
  assert.equal(incomplete.metric.quality, 'MISSING'); assert.equal(incomplete.history.eligible, false);
  assert.equal(run({ trades: [{ ...sellTrade, signature: sig(99) }] }).metric.reasonCode, 'CREATOR_TRADE_OUTSIDE_CANONICAL_ACCOUNT');
});

test('an index that cannot reach a pre-interval witness within two pages is truncated', () => {
  const x = world(), rows = (from: number) => Array.from({ length: CREATOR_PAGE_LIMIT }, (_, i) => ({ blockTime: at('2026-10-12T03:00:00Z') - from - i, confirmationStatus: 'finalized', err: { InstructionError: [0, { Custom: 1 }] }, memo: null, signature: sig(10_000 + from + i), slot: HEAD - 1 - from - i, transactionIndex: 0 }));
  const first = rows(0), second = rows(CREATOR_PAGE_LIMIT);
  x.receipts.rawArtifacts['creator-ata-page-0'] = rpc(first);
  x.receipts.requests['creator-ata-page-1'] = creatorPageRequest(A, HEAD, first.at(-1)!.signature); x.receipts.rawArtifacts['creator-ata-page-1'] = rpc(second); x.receipts.retrievedAt['creator-ata-page-1'] = '2026-10-12T04:25:35.500Z';
  const { history } = decode(x);
  assert.equal(history.canonical.status, 'TRUNCATED'); assert.equal(history.reasonCode, 'CREATOR_ATA_INDEX_CAP');
});

const LEGACY='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',hidden=key(41),delegate=key(42),sink=key(43),wsolAta=getAssociatedTokenAddressSync(new PublicKey(WSOL),new PublicKey(W),true,new PublicKey(LEGACY)).toBase58(),orphan=key(45);
const atomicHidden=tx(21,455600000,at('2026-10-09T00:00:00Z'),[W,hidden,delegate,sink,curveAta,curve],[{programId:CURVE,accounts:[W],inner:[
  {programId:T22,parsed:{type:'initializeAccount3',info:{account:hidden,mint:MINT,owner:W}}},xfer(curveAta,hidden,'9',curve),
  {programId:T22,parsed:{type:'approve',info:{source:hidden,delegate,owner:W,amount:'9'}}},xfer(hidden,sink,'9',delegate),
  {programId:T22,parsed:{type:'closeAccount',info:{account:hidden,destination:W,owner:W}}}]}],[]);
const zeroApproval=tx(24,455300000,at('2026-10-06T00:00:00Z'),[W,hidden,delegate],[{programId:T22,parsed:{type:'approveChecked',info:{source:hidden,mint:MINT,delegate,owner:W,tokenAmount:{amount:'0',decimals:6,uiAmount:0,uiAmountString:'0'}}}}],[]);
const wsolRoundTrip=tx(22,455500000,at('2026-10-08T00:00:00Z'),[W,wsolAta,WSOL],[{programId:ATA,parsed:{type:'createIdempotent',info:{source:W,account:wsolAta,wallet:W,mint:WSOL,systemProgram:'11111111111111111111111111111111',tokenProgram:LEGACY}}},{programId:LEGACY,parsed:{type:'closeAccount',info:{account:wsolAta,destination:W,owner:W}}}],[]);
const orphanClose=tx(23,455400000,at('2026-10-07T00:00:00Z'),[W,orphan],[{programId:T22,parsed:{type:'closeAccount',info:{account:orphan,destination:W,owner:W}}}],[]);
const unparsedOpen=tx(25,455200000,at('2026-10-05T00:00:00Z'),[W,hidden,MINT],[{programId:T22,accounts:[hidden,MINT]},{programId:T22,parsed:{type:'closeAccount',info:{account:hidden,destination:W,owner:W}}}],[]);
const mintAuthority=tx(26,455100000,at('2026-10-04T00:00:00Z'),[W,MINT],[{programId:T22,parsed:{type:'setAuthority',info:{mint:MINT,authority:W,authorityType:'freezeAccount',newAuthority:null}}}],[]);

test('an atomic open-fund-approve-spend-close or zero approval of a creator-owned target account without balance rows blocks the exit proof', () => {
  for (const extra of [atomicHidden, zeroApproval]) {
    const { metric } = run({ walletExtra: [extra] });
    assert.equal(metric.quality, 'TRUNCATED'); assert.equal((metric.data as any).walletProof.code, 'CREATOR_NON_CANONICAL_ACCOUNT_TOUCHED');
  }
});

test('other-mint creator receipts stay inspectable while unresolved accounts and target-mint authority fail closed', () => {
  assert.equal(run({ walletExtra: [wsolRoundTrip] }).history.walletProof.status, 'OBSERVED');
  for (const [extra, code] of [[orphanClose, 'CREATOR_WALLET_ACCOUNT_UNRESOLVED'], [unparsedOpen, 'CREATOR_WALLET_TOKEN_FORM_UNRESOLVED']] as const) {
    const proof = run({ walletExtra: [extra] }).history.walletProof;
    assert.equal(proof.status, 'TRUNCATED'); assert.equal(proof.code, code);
  }
  const authority = run({ walletExtra: [mintAuthority] });
  assert.equal(authority.history.walletProof.code, 'CREATOR_WALLET_TARGET_MINT_AUTHORITY'); assert.equal(authority.metric.quality, 'TRUNCATED');
});

test('system-program or incinerator owners and native mints are outside the cohort proof', () => {
  for (const wallet of ['11111111111111111111111111111111', '1nc1nerator11111111111111111111111111111111']) {
    const x = world();
    assert.throws(() => decodeCreatorInventory(token, { ...role, wallet }, x.tape, x.receipts, cutoff), /CREATOR_INVENTORY_SCOPE/);
  }
  const x = world();
  assert.throws(() => decodeCreatorInventory({ chain: 'solana', address: WSOL }, { ...role, mint: WSOL }, x.tape, x.receipts, cutoff), /CREATOR_INVENTORY_SCOPE/);
});

test('the retained creation must show a fresh mint with no financial extension before InitializeMint2', () => {
  const swap = (t: any) => { const x = world(); x.receipts.rawArtifacts[`creator-tx-${sig(1)}`] = rpc(t); return decode(x).history.walletProof; };
  assert.equal(swap(makeCreation()).status, 'OBSERVED');
  for (const type of ['initializePermanentDelegate', 'initializeConfidentialTransferMint', 'initializeConfidentialMintBurnMint']) {
    const proof = swap(makeCreation([createMint, pointer, { programId: T22, parsed: { type, info: { mint: MINT, delegate: key(46) } } }]));
    assert.equal(proof.status, 'MISSING'); assert.equal(proof.code, 'CREATOR_CREATION_WITNESS_EXTENSION');
  }
  assert.equal(swap(makeCreation([{ programId: T22, accounts: [MINT] }, createMint])).code, 'CREATOR_CREATION_WITNESS_MINT');
  assert.equal(swap(makeCreation([pointer])).code, 'CREATOR_CREATION_WITNESS_MINT');
  assert.equal(swap(makeCreation([createMint, { programId: T22, accounts: [MINT] }])).code, 'CREATOR_CREATION_WITNESS_MINT');
  assert.equal(swap(makeCreation(undefined, 3)).code, 'CREATOR_CREATION_WITNESS_ROLE');
});

const feeVault=key(47),feeAuthority=key(48);
/** Shaped like the retained wallet receipts: the creator opens its own wrapped-SOL account, receives a fee into it and closes it, with no token-balance rows for that account. */
const feeClaim=()=>tx(27,455000000,at('2026-10-03T00:00:00Z'),[W,feeVault,wsolAta,feeAuthority,WSOL,LEGACY,PAMM,ATA,SYSTEM],[
  {programId:ATA,parsed:{type:'createIdempotent',info:{account:wsolAta,mint:WSOL,source:W,systemProgram:SYSTEM,tokenProgram:LEGACY,wallet:W}},inner:[
    {programId:LEGACY,parsed:{type:'getAccountDataSize',info:{extensionTypes:['immutableOwner'],mint:WSOL}}},
    {programId:LEGACY,parsed:{type:'initializeImmutableOwner',info:{account:wsolAta}}},
    {programId:LEGACY,parsed:{type:'initializeAccount3',info:{account:wsolAta,mint:WSOL,owner:W}}}]},
  {programId:PAMM,accounts:[WSOL,LEGACY,W,feeAuthority,feeVault,wsolAta],inner:[{programId:LEGACY,parsed:{type:'transferChecked',info:{authority:feeAuthority,destination:wsolAta,mint:WSOL,source:feeVault,tokenAmount:{amount:'613591060',decimals:9,uiAmount:0.61359106,uiAmountString:'0.61359106'}}}}]},
  {programId:LEGACY,parsed:{type:'closeAccount',info:{account:wsolAta,destination:W,owner:W}}}],[]);
const edit=(t:any,change:(find:(type:string)=>any)=>void)=>{const c=structuredClone(t),all=[...c.transaction.message.instructions,...c.meta.innerInstructions.flatMap((g:any)=>g.instructions)];change(type=>all.find((i:any)=>i.parsed?.type===type));return c;};

test('a retained-shape fee claim stays inspectable while omitted, unresolved, invalid, spoofed, unknown or raw token fields fail closed', () => {
  assert.equal(run({ walletExtra: [feeClaim()] }).history.walletProof.status, 'OBSERVED');
  const FIELD = 'CREATOR_WALLET_TOKEN_FIELD_UNRESOLVED', FORM = 'CREATOR_WALLET_TOKEN_FORM_UNRESOLVED';
  const cases: Array<[string, (find: (type: string) => any) => void, string]> = [
    ['initialize owner omitted', find => { delete find('initializeAccount3').parsed.info.owner; }, FIELD],
    ['transfer mint omitted', find => { delete find('transferChecked').parsed.info.mint; }, FIELD],
    ['close owner omitted', find => { delete find('closeAccount').parsed.info.owner; }, FIELD],
    ['closed account outside the receipt keys', find => { find('closeAccount').parsed.info.account = key(49); }, FIELD],
    ['invalid destination key', find => { find('transferChecked').parsed.info.destination = '0OIl'; }, FIELD],
    ['extra unsupported field', find => { find('closeAccount').parsed.info.delegate = W; }, FIELD],
    ['associated account not derived from its wallet and mint', find => { find('createIdempotent').parsed.info.account = feeVault; }, FIELD],
    ['substituted token program', find => { find('createIdempotent').parsed.info.tokenProgram = SYSTEM; }, FIELD],
    ['unknown critical type', find => { find('closeAccount').parsed.type = 'withdrawExcessLamports'; }, FORM],
    ['raw token instruction', find => { const ix = find('closeAccount'); delete ix.parsed; Object.assign(ix, { accounts: [wsolAta, W, W], data: 'A' }); }, FORM],
  ];
  for (const [name, change, code] of cases) {
    const { history, metric } = run({ walletExtra: [edit(feeClaim(), change)] });
    assert.deepEqual([history.walletProof.status, history.walletProof.code, metric.quality], ['TRUNCATED', code, 'TRUNCATED'], name);
  }
});

/** A target-mint account opened, funded, spent and closed inside one creator-referencing transaction, without token-balance rows unless given. */
const hiddenCycle=(init:Record<string,unknown>,rows:Balance[]=[])=>tx(28,454900000,at('2026-10-02T00:00:00Z'),[W,hidden,delegate,sink,curveAta,curve],[{programId:CURVE,accounts:[W],inner:[
  {programId:T22,parsed:{type:'initializeAccount3',info:{account:hidden,mint:MINT,...init}}},xfer(curveAta,hidden,'9',curve),xfer(hidden,sink,'9',delegate),
  {programId:T22,parsed:{type:'closeAccount',info:{account:hidden,destination:delegate,owner:delegate}}}]}],rows);

test('an intra-transaction target account is excluded only when every parsed owner and mint resolves away from the creator', () => {
  // Root-confirmed gap: with the owner omitted, no field named the creator, so the earlier exit proof certified this receipt.
  const omitted = run({ walletExtra: [hiddenCycle({})] });
  assert.deepEqual([omitted.history.walletProof.code, omitted.metric.quality], ['CREATOR_WALLET_TOKEN_FIELD_UNRESOLVED', 'TRUNCATED']);
  assert.equal(run({ walletExtra: [hiddenCycle({ owner: W })] }).history.walletProof.code, 'CREATOR_NON_CANONICAL_ACCOUNT_TOUCHED');
  assert.equal(run({ walletExtra: [hiddenCycle({ owner: 'not-a-key' })] }).history.walletProof.code, 'CREATOR_WALLET_TOKEN_FIELD_UNRESOLVED');
  // A stranger-owned account still needs its counterparties resolved; with their raw rows present the receipt is excluded.
  assert.equal(run({ walletExtra: [hiddenCycle({ owner: other })] }).history.walletProof.code, 'CREATOR_WALLET_ACCOUNT_UNRESOLVED');
  const resolved = run({ walletExtra: [hiddenCycle({ owner: other }, [{ account: curveAta, owner: curve, pre: '9', post: '0' }, { account: sink, owner: other, pre: '0', post: '9' }])] });
  assert.deepEqual([resolved.history.walletProof.status, resolved.metric.quality], ['OBSERVED', 'KNOWN']);
});

test('before InitializeMint2 a token form omitting the mint, another System form or an unresolved creator key never certifies a fresh mint', () => {
  const swap = (t: any) => { const x = world(); x.receipts.rawArtifacts[`creator-tx-${sig(1)}`] = rpc(t); return decode(x).history.walletProof; };
  assert.equal(swap(makeCreation([createMint, pointer, { programId: T22, parsed: { type: 'initializePermanentDelegate', info: { delegate: key(46) } } }])).code, 'CREATOR_CREATION_WITNESS_EXTENSION');
  assert.equal(swap(makeCreation([createMint, { programId: T22, parsed: { type: 'initializeMetadataPointer', info: { metadataAddress: key(46) } } }])).code, 'CREATOR_CREATION_WITNESS_MINT');
  assert.equal(swap(makeCreation([{ programId: SYSTEM, parsed: { type: 'transfer', info: { source: W, destination: MINT, lamports: 1 } } }, createMint, pointer])).code, 'CREATOR_CREATION_WITNESS_MINT');
  assert.equal(swap(makeCreation([{ programId: SYSTEM, parsed: { type: 'createAccount', info: { source: key(49), newAccount: MINT, lamports: 1, space: 234, owner: T22 } } }, pointer])).code, 'CREATOR_CREATION_WITNESS_MINT');
  assert.equal(swap(makeCreation([{ programId: SYSTEM, parsed: { type: 'createAccount', info: { newAccount: MINT, lamports: 1, space: 234, owner: T22 } } }, pointer])).code, 'CREATOR_CREATION_WITNESS_MINT');
});

/** Removes one inner instruction; with matched frames its invoke/success log pair goes too, as a consistent trace without that instruction would read. */
const dropInner=(t:any,top:number,at:number,matchFrames:boolean)=>{
  const c=structuredClone(t),groups=c.meta.innerInstructions,inner=(k:number)=>groups.find((g:any)=>g.index===k)?.instructions.length??0;
  groups.find((g:any)=>g.index===top).instructions.splice(at,1);
  if(matchFrames){let line=1+2*at;for(let k=0;k<top;k++)line+=2+2*inner(k);c.meta.logMessages.splice(line,2);}
  return c;
};

test('wallet exclusion holds only over a complete runtime trace, never over parsed forms that disagree with the logged frames', () => {
  const TRACE = 'CREATOR_WALLET_RUNTIME_TRACE_UNRESOLVED';
  // A supported instruction dropped from the body while its logged frame remains: an inconsistent trace is never certified.
  const dropped = run({ walletExtra: [dropInner(feeClaim(), 0, 2, false)] });
  assert.deepEqual([dropped.history.walletProof.status, dropped.history.walletProof.code, dropped.metric.quality], ['TRUNCATED', TRACE, 'TRUNCATED']);
  // A logged token frame with no instruction body at all is unknown critical activity.
  const phantom = structuredClone(feeClaim()); phantom.meta.logMessages.splice(1, 0, `Program ${LEGACY} invoke [2]`, `Program ${LEGACY} success`);
  assert.equal(run({ walletExtra: [phantom] }).history.walletProof.code, TRACE);
  const truncated = structuredClone(feeClaim()); truncated.meta.logMessages.push('Log truncated');
  assert.equal(run({ walletExtra: [truncated] }).history.walletProof.code, TRACE);
  // Positive control: the same removal with matched frames is a consistent trace, and the associated-account creation still proves that account's mint and owner.
  const consistent = run({ walletExtra: [dropInner(feeClaim(), 0, 2, true)] });
  assert.deepEqual([consistent.history.walletProof.status, consistent.metric.quality], ['OBSERVED', 'KNOWN']);
  // Without redundant evidence, a consistent trace missing the only owner proof of a target-mint account stays unresolved.
  assert.equal(run({ walletExtra: [dropInner(hiddenCycle({ owner: W }), 0, 0, true)] }).history.walletProof.code, 'CREATOR_WALLET_ACCOUNT_UNRESOLVED');
  // An unknown critical body inside a complete trace still fails closed.
  assert.equal(run({ walletExtra: [edit(feeClaim(), find => { find('closeAccount').parsed.type = 'withdrawExcessLamports'; })] }).history.walletProof.code, 'CREATOR_WALLET_TOKEN_FORM_UNRESOLVED');
});
