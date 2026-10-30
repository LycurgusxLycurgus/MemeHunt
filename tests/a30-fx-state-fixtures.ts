import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createA30SourceCapture,a30Archive} from './a30-fx-source-fixtures.js';
import type {A30SourceReceipts} from '../src/providers/advisory-demand-fx-source.js';
export const ORCA='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export function base58(bytes:Buffer){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+(bytes.toString('hex')||'0')),out='';while(n){out=alphabet[Number(n%58n)]+out;n/=58n;}return'1'.repeat(bytes.findIndex(b=>b!==0)<0?bytes.length:bytes.findIndex(b=>b!==0))+out;}
export function stateSource(run:(source:A30SourceReceipts,cutoff:string,tx:any)=>void){const dir=mkdtempSync(join(tmpdir(),'a30-state-'));try{const f=createA30SourceCapture(dir);run(f.source,f.cutoff,JSON.parse(f.native.nativeTransactionRaw));}finally{rmSync(dir,{recursive:true,force:true});}}
/** Constructed mutation of the small census; update its two exact head preimages. */
export function replaceNative(source:A30SourceReceipts,tx:any,keepCompanion=false){
 if(!keepCompanion)for(const id of Object.keys(source.requests).filter(k=>k.startsWith('fx-compiled-'))){delete source.requests[id];delete source.rawArtifacts[id];delete source.retrievedAt[id];}
 const body=JSON.stringify({jsonrpc:'2.0',id:1,result:{data:[tx],paginationToken:null}});source.rawArtifacts['fx-body-0']=a30Archive(body);source.rawArtifacts['fx-head']=a30Archive(body);
}
export function genuineSelected(tx:any){return tx.meta.innerInstructions.flatMap((g:any)=>g.instructions).find((ix:any)=>ix.programId===ORCA);}
export function genuineEvent(tx:any):string{return tx.meta.logMessages.find((l:string)=>l.startsWith('Program data: 4cpJr5MroJ'));}
export function topOnly(tx:any,ix:any,event?:string){tx.transaction.message.instructions=[{...ix,stackHeight:1}];tx.meta.innerInstructions=[];tx.meta.logMessages=[`Program ${ORCA} invoke [1]`,...(event?[event]:[]),`Program ${ORCA} success`];return tx;}
export function ownerForms():Record<string,{dataHex:string;accounts:string[]}>{return JSON.parse(readFileSync(new URL('../../tests/fixtures/advisory-a30-fx-owner-forms.json',import.meta.url),'utf8')).forms;}
/** Constructed role envelope over genuine instruction bytes; no executed event is invented. */
export function formTransaction(tx:any,form:{dataHex:string;accounts:string[]}){
 const keys=[...new Set([ORCA,...form.accounts])];tx.transaction.message.accountKeys=keys.map(pubkey=>({pubkey,writable:pubkey!==ORCA,signer:pubkey!==ORCA,source:'transaction'}));return topOnly(tx,{programId:ORCA,accounts:form.accounts,data:base58(Buffer.from(form.dataHex,'hex'))});
}
