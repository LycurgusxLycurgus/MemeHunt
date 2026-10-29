import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {walletTouch,walletTouchAbsence,validateNativeCreatorTokenForms} from '../src/providers/advisory-creator-inventory.js';
import {deriveO24BulkInventory} from '../src/providers/advisory-creator-inventory-absence.js';
import {creatorAbsenceFixture,createO24InventoryCapture} from './creator-inventory-bulk-fixtures.js';

const fixture=()=>creatorAbsenceFixture(),role=(f:any)=>({wallet:f.wallet,mint:f.token.address,creationSignature:f.creation.transaction.transaction.signatures[0],creationSlot:f.creation.transaction.slot});
const clone=<T>(v:T):T=>structuredClone(v);
function critical(tx:any){return [...tx.transaction.message.instructions,...tx.meta.innerInstructions.flatMap((g:any)=>g.instructions)].find((ix:any)=>['unwrapLamports','harvestWithheldTokensToMint','transferCheckedWithFee'].includes(ix.parsed?.type));}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function bulk(source:any,change:(rows:any[])=>void){const id='bulk-page-0',wrapper=JSON.parse(source.rawArtifacts[id]),body=JSON.parse(inflateRawSync(Buffer.from(wrapper.data,'base64')).toString());change(body.result.data);const raw=Buffer.from(JSON.stringify(body));source.rawArtifacts[id]=JSON.stringify({method:'o23-deflate-raw-v1',encoding:'DEFLATE_RAW_BASE64',sourceBytes:raw.length,sourceHash:sha(raw),data:deflateRawSync(raw).toString('base64')});}
function plain(source:any,id:string,change:(result:any)=>void){const body=JSON.parse(source.rawArtifacts[id]);change(body.result);source.rawArtifacts[id]=JSON.stringify(body);}
function scenario(work:(c:ReturnType<typeof createO24InventoryCapture>)=>void){const directory=mkdtempSync(join(tmpdir(),'creator-absence-'));try{work(createO24InventoryCapture(directory));}finally{rmSync(directory,{recursive:true,force:true});}}

test('new absence purpose admits four genuine foreign critical-form receipts while old APIs retain their original failures',()=>{
 const f=fixture();assert.equal(f.gaps.length,4);
 for(const g of f.gaps){const tx=g.transaction,before=JSON.stringify(tx);assert.throws(()=>walletTouch(tx,role(f),f.account,true),/CREATOR_WALLET_TOKEN_FORM_UNRESOLVED/);assert.throws(()=>validateNativeCreatorTokenForms(tx),/CREATOR_WALLET_TOKEN_FORM_UNRESOLVED/);assert.equal(walletTouchAbsence(tx,role(f),f.account),null);assert.equal(JSON.stringify(tx),before);assert.throws(()=>walletTouch(tx,role(f),f.account,true),/CREATOR_WALLET_TOKEN_FORM_UNRESOLVED/);}
});

test('closed foreign forms reject extra fields, wrong programs, target mints, missing raw owners and source-array ambiguity',()=>{
 const f=fixture();
 for(const g of f.gaps){
  const extra=clone(g.transaction);critical(extra).parsed.info.unrecognized=true;assert.throws(()=>walletTouchAbsence(extra,role(f),f.account),/CREATOR_WALLET_ABSENCE_FORM_UNRESOLVED/);
  const wrong=clone(g.transaction);critical(wrong).programId=critical(wrong).programId==='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'?'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb':'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';assert.throws(()=>walletTouchAbsence(wrong,role(f),f.account),/UNRESOLVED/);
  const target=clone(g.transaction),ix=critical(target);if(ix.parsed.type==='unwrapLamports'){const n=target.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===ix.parsed.info.source);target.meta.preTokenBalances.find((b:any)=>b.accountIndex===n).mint=f.token.address;}else ix.parsed.info.mint=f.token.address;assert.throws(()=>walletTouchAbsence(target,role(f),f.account),/CREATOR_WALLET_ABSENCE_FORM_UNRESOLVED/);
  const owner=clone(g.transaction);const info=critical(owner).parsed.info,subject=info.source??info.sourceAccounts[0],n=owner.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===subject);for(const bs of [owner.meta.preTokenBalances,owner.meta.postTokenBalances])for(const b of bs)if(b.accountIndex===n)delete b.owner;assert.throws(()=>walletTouchAbsence(owner,role(f),f.account),/CREATOR_WALLET_ABSENCE_FORM_UNRESOLVED/);
 }
 const harvest=clone(f.gaps.find((g:any)=>critical(g.transaction).parsed.type==='harvestWithheldTokensToMint').transaction),h=critical(harvest);h.parsed.info.sourceAccounts.push(h.parsed.info.sourceAccounts[0]);assert.throws(()=>walletTouchAbsence(harvest,role(f),f.account),/CREATOR_WALLET_ABSENCE_FORM_UNRESOLVED/);
 const fee=clone(f.gaps.find((g:any)=>critical(g.transaction).parsed.type==='transferCheckedWithFee').transaction);critical(fee).parsed.info.feeAmount.decimals++;assert.throws(()=>walletTouchAbsence(fee,role(f),f.account),/CREATOR_WALLET_ABSENCE_FORM_UNRESOLVED/);
 const overflow=clone(f.gaps.find((g:any)=>critical(g.transaction).parsed.type==='transferCheckedWithFee').transaction);critical(overflow).parsed.info.tokenAmount.amount='18446744073709551616';assert.throws(()=>walletTouchAbsence(overflow,role(f),f.account),/CREATOR_WALLET_ABSENCE_FORM_UNRESOLVED/);
});

test('whole small constructed source cohort proves only base absence and preserves exact canonical chain plus old source objects',()=>scenario(c=>{
 const before=JSON.stringify(c.source),m=deriveO24BulkInventory(c.source,c.cutoff,['source']),d=m.data as any;assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,'CREATOR_SIGNER_BASE_INVENTORY_ABSENCE_OBSERVED');assert.equal(d.mode,'ABSENCE_ONLY');assert.equal(d.walletProof.successfulInspected,17);assert.equal(d.walletProof.unresolvedTransactions,0);assert.equal(d.canonical.transactions.length,12);assert.equal(d.canonical.continuityPairs,11);assert.equal(d.canonical.continuityBreaks,0);assert.equal(d.canonical.intervalReferences,0);assert.equal(d.inventory.startAtomic,'0');assert.equal(d.inventory.endAtomic,'0');assert.equal(d.inventory.legs,0);assert.equal(d.inventory.poolBuyCoreQuoteAtomic,null);assert.equal(d.inventory.poolSellCoreQuoteAtomic,null);assert.equal(d.quoteMint,null);assert.equal(d.quoteDecimals,null);assert.equal(d.quoteBasis,'NOT_MEASURED_BASE_ONLY');assert.equal(d.nonCanonicalAccountsZeroThroughout,true);assert.equal(JSON.stringify(c.source),before);
}));

test('one canonical interval reference even failed keeps the entire inventory unknown',()=>scenario(c=>{
 plain(c.source,'ata-page-0',rows=>{const original=rows[0],sig=c.fixture.preCreationTail.signature;rows.splice(11,0,{...original,signature:sig,slot:461500000,transactionIndex:0,blockTime:1792983600,err:{InstructionError:[0,'Custom']}});});
 const m=deriveO24BulkInventory(c.source,c.cutoff,[]);assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,'CREATOR_ABSENCE_INTERVAL_REFERENCE');assert.equal((m.data as any).inventory,null);assert.equal((m.data as any).nonCanonicalAccountsZeroThroughout,null);
}));

test('critical gap, positive other target account and inconsistent chain remain whole missing',()=>{
 scenario(c=>{bulk(c.source,rows=>{critical(rows.find(tx=>critical(tx))).parsed.info.unrecognized=true;});const m=deriveO24BulkInventory(c.source,c.cutoff,[]);assert.equal(m.quality,'MISSING');assert.equal((m.data as any).inventory,null);assert.ok((m.data as any).walletProof.unresolvedTransactions>0);});
 const f=fixture(),tx=clone(f.canonicalBodies[0].transaction),n=tx.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey!==f.account&&k.pubkey!==f.wallet);tx.meta.preTokenBalances.push({accountIndex:n,mint:f.token.address,owner:f.wallet,programId:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',uiTokenAmount:{amount:'1',decimals:6,uiAmount:null,uiAmountString:'0.000001'}});assert.equal(walletTouchAbsence(tx,role(f),f.account),'CREATOR_NON_CANONICAL_ACCOUNT_TOUCHED');
 scenario(c=>{bulk(c.source,rows=>{const tx=rows.find(x=>x.transaction.signatures[0]===c.fixture.canonicalBodies[0].transaction.transaction.signatures[0]);const n=tx.transaction.message.accountKeys.findIndex((k:any)=>k.pubkey===c.fixture.account);const b=tx.meta.preTokenBalances.find((b:any)=>b.accountIndex===n);b.uiTokenAmount.amount=String(BigInt(b.uiTokenAmount.amount)+1n);});const m=deriveO24BulkInventory(c.source,c.cutoff,[]);assert.equal(m.quality,'MISSING');assert.equal((m.data as any).inventory,null);});
});

test('source-invalid fixed state, role and clocks throw instead of granting a partial positive',()=>{
 scenario(c=>{plain(c.source,'ata-head',r=>{r.context.slot++;});assert.throws(()=>deriveO24BulkInventory(c.source,c.cutoff,[]),/STATE_CONTEXT/);});
 scenario(c=>{c.source.wallet=c.fixture.token.address;assert.throws(()=>deriveO24BulkInventory(c.source,c.cutoff,[]));});
 scenario(c=>{c.source.retrievedAt['bulk-page-0']='2099-01-01T00:00:00.000Z';assert.throws(()=>deriveO24BulkInventory(c.source,c.cutoff,[]));});
});
