import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,unpackMint} from '@solana/spl-token';
import type {TokenRef} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {decodeA13ParticipationCapture,a13NativeInput,type A13DecodedCapture} from './advisory-participation-import.js';
import {reconstructA13NativeParticipation} from './advisory-participation-native.js';

const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const fail:(code:string)=>never=(code)=>{throw Error('A13_PARTICIPATION_'+code);};
const str=z.string().min(1), strings=z.array(str),citation=z.object({sourceId:str,excerptId:str,quote:z.string()}).strict();
const decision=z.object({tokenKey:str,disposition:z.enum(['MEMBER','NON_MEMBER','UNRESOLVED']),identity:z.object({method:str,nativeIdentityIds:strings,metadataPreimageId:z.string().nullable(),citations:z.array(citation),caveats:strings}).strict(),association:z.object({kind:str,citations:z.array(citation),rationale:str}).strict(),rationale:str,remainingEvidence:strings}).strict();
const setSchema=z.object({scope:z.literal('FINITE_IDENTIFIED_LEAD_SAMPLE'),complete:z.boolean(),acceptedTokenKeys:strings,unresolvedTokenKeys:strings,allNarrativeMembersIdentified:z.literal(false),outsideSampleUnmeasured:z.literal(true),rationale:str}).strict();
const qualificationSchema=z.object({method:str,packetSha256:str,decisions:z.array(decision).min(1),leadDispositions:z.array(z.object({}).passthrough()),inspectedSourceIds:strings,unavailableSourceIds:strings,additionalMaterialIdentities:z.array(z.unknown()),candidateSet:setSchema,limitations:strings}).passthrough();
type Obj=Record<string,any>;
const obj=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sameSet=(a:string[],b:string[])=>a.length===new Set(a).size&&b.length===new Set(b).size&&isDeepStrictEqual([...a].sort(),[...b].sort());
function pointer(value:unknown,path:string):unknown{
 if(path==='')return value;
 if(!path.startsWith('/'))return fail('SOURCE_POINTER');
 for(const bit of path.slice(1).split('/')){const key=bit.replace(/~1/g,'/').replace(/~0/g,'~');if(!obj(value)&&!Array.isArray(value))return fail('SOURCE_POINTER');if(!Object.hasOwn(value,key))return fail('SOURCE_POINTER');value=(value as Obj)[key];}
 return value;
}
function metadata(data:Buffer,mint:string){
 let at=166;while(at+4<=data.length){const type=data.readUInt16LE(at),len=data.readUInt16LE(at+2);at+=4;if(at+len>data.length)fail('METADATA_TLV');if(type===19){const d=data.subarray(at,at+len);if(d.length<68||new PublicKey(d.subarray(32,64)).toBase58()!==mint)fail('METADATA_MINT');let p=64;const text=()=>{if(p+4>d.length)fail('METADATA_TEXT');const n=d.readUInt32LE(p);p+=4;if(p+n>d.length)fail('METADATA_TEXT');const b=d.subarray(p,p+n);p+=n;const t=b.toString('utf8');if(!Buffer.from(t).equals(b))fail('METADATA_UTF8');return t;};const name=text(),symbol=text(),uri=text();if(p+4>d.length)fail('METADATA_TEXT');const count=d.readUInt32LE(p);p+=4;const additionalMetadata:string[][]=[];if(count>1000)fail('METADATA_COUNT');for(let n=0;n<count;n++)additionalMetadata.push([text(),text()]);if(p!==d.length)fail('METADATA_TRAILING');return{name,symbol,uri,additionalMetadata,updateAuthority:d.subarray(0,32).equals(Buffer.alloc(32))?null:new PublicKey(d.subarray(0,32)).toBase58()};}at+=len;}
 return fail('METADATA_ABSENT');
}

/** Recheck the sealed source-only judgments against their exact original fields.
 * These are declared semantic inferences, never proof of reward execution. */
export function reconstructA13Qualification(c:A13DecodedCapture,cutoff:string){
 const records=new Map(c.decodedRecords.map(r=>[r.id,r]));
 const get=(id:string)=>records.get(id)??fail('QUALIFICATION_RECORD');
 const packetRecord=get(c.qualification.packetRecordId),proposalRecord=get(c.qualification.proposalRecordId),reviewRecord=get(c.qualification.reviewRecordId);
 const packet:Obj=JSON.parse(packetRecord.raw),proposal=qualificationSchema.parse(JSON.parse(proposalRecord.raw)),review=qualificationSchema.parse(JSON.parse(reviewRecord.raw));
 if(packet.method!=='a13-historical-observed-peer-source-packet-v1'||!obj(packet.scope)||packet.scope.kind!=='FINITE_IDENTIFIED_LEAD_SAMPLE'||!Array.isArray(packet.candidates)||!Array.isArray(packet.sources)||!Array.isArray(packet.unavailableSources)||!Array.isArray(packet.nativeIdentityProjections)||!obj(packet.sourcePins))fail('QUALIFICATION_PACKET');
 const keys=packet.candidates.map((v:Obj)=>{if(v.chain!=='solana'||typeof v.address!=='string')fail('QUALIFICATION_CANDIDATE');new PublicKey(v.address);return`solana:${v.address}`;});
 if(packet.visibility?.studyPopulationGrowthCapacityProvided!==false||packet.visibility?.publicMetricUiProvided!==false)fail('QUALIFICATION_OUTCOME_ISOLATION');
 if(!sameSet(keys,packet.scope.candidateKeys)||proposal.method!=='a13-historical-observed-peer-native-proposal-v1'||review.method!=='a13-historical-observed-peer-independent-qualification-v1'||proposal.packetSha256!==packetRecord.sha256||review.packetSha256!==packetRecord.sha256||(review as Obj).proposalSha256!==proposalRecord.sha256)fail('QUALIFICATION_CHAIN');
 // The complete original source corpus, including unavailable-source receipts, travels with the import.
 const pinnedPaths=Object.keys(packet.sourcePins);
 if(!sameSet(pinnedPaths,Object.keys(c.qualification.sourceRecords).filter(path=>pinnedPaths.includes(path))))fail('QUALIFICATION_SOURCE_CATALOG');
 for(const path of pinnedPaths){const pin=packet.sourcePins[path],r=get(c.qualification.sourceRecords[path]!);if(r.sourcePath!==path||r.sha256!==pin.sha256||Buffer.byteLength(r.raw)!==pin.bytes)fail('QUALIFICATION_SOURCE_HASH');}
 const excerpts=new Map<string,{sourceId:string;quote:string}>();
 for(const s of packet.sources){
  const r=get(c.qualification.sourceRecords[s.fullLocalSourceRef]!);const sourceAt=s.sourceClock?.availableAt??s.sourceClock?.retainedAt;if(r.sha256!==s.fullLocalSourceSha256||!Number.isFinite(Date.parse(sourceAt))||Date.parse(sourceAt)>Date.parse(cutoff)||r.availableAt!==sourceAt)fail('SOURCE_HASH_CLOCK');
  let value:unknown=JSON.parse(r.raw);if(s.providerObjectLocator.outerStringPointer!==null){const text=pointer(value,s.providerObjectLocator.outerStringPointer);if(typeof text!=='string')fail('SOURCE_INNER');value=JSON.parse(text as string);}value=pointer(value,s.providerObjectLocator.providerPointer);
  if(!Array.isArray(s.excerpts)||s.representation!=='EXACT_FIELD_EXCERPTS_NOT_FULL_ACQUISITION_BODY')fail('SOURCE_EXCERPTS');
  for(const e of s.excerpts){const field=pointer(value,e.field);if(typeof field!=='string'||e.units!=='UNICODE_CODE_POINTS'||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<e.start||sha(field)!==e.decodedFieldSha256||[...field].slice(e.start,e.end).join('')!==e.quote||excerpts.has(e.id))fail('SOURCE_EXCERPT');excerpts.set(e.id,{sourceId:s.id,quote:e.quote});}
 }
 const nativeIds=new Set<string>();
 for(const identity of packet.nativeIdentityProjections){
  if(nativeIds.has(identity.id)||!keys.includes(`solana:${identity.mintAddress}`))fail('IDENTITY_DUPLICATE');nativeIds.add(identity.id);
  const matching=c.decodedRecords.filter(r=>r.sha256===identity.rawResponseSha256&&r.request?.method==='getMultipleAccounts');if(matching.length!==1)fail('IDENTITY_RAW');
  const r=matching[0]!,req=r.request!,addresses=req.params[0],raw=JSON.parse(r.raw);if(!Array.isArray(addresses)||raw.result?.context?.slot!==identity.slot||r.availableAt!==identity.availableAt)fail('IDENTITY_BANK');
  const index=addresses.indexOf(identity.mintAddress),a=raw.result?.value?.[index];if(index<0||!a||a.owner!==(identity.programId??identity.program)||a.owner!==TOKEN_2022_PROGRAM_ID.toBase58()||a.executable!==false||a.data?.[1]!=='base64')fail('IDENTITY_ACCOUNT');
  const bytes=Buffer.from(a.data[0],'base64');if(bytes.toString('base64')!==a.data[0]||sha(bytes)!==identity.accountBytesSha256)fail('IDENTITY_BYTES');
  const m=unpackMint(new PublicKey(identity.mintAddress),{data:bytes,owner:TOKEN_2022_PROGRAM_ID,executable:false,lamports:0,rentEpoch:0},TOKEN_2022_PROGRAM_ID);if(!m.isInitialized)fail('IDENTITY_MINT');
  const fields=metadata(bytes,identity.mintAddress);for(const field of ['name','symbol','uri','updateAuthority','additionalMetadata'] as const)if(!isDeepStrictEqual(fields[field],field==='updateAuthority'?(identity.updateAuthority??identity.metadataUpdateAuthority??null):identity[field]))fail('IDENTITY_METADATA');
 }
 if(nativeIds.size!==keys.length)fail('IDENTITY_COVERAGE');
 const hkh=packet.verifiedHkhMetadata,preimage=get(c.qualification.sourceRecords[hkh.sourceRef]!);if(preimage.sha256!==hkh.sha256||!isDeepStrictEqual(JSON.parse(preimage.raw),hkh.fields))fail('CID_PREIMAGE');
 const sourceIds=packet.sources.map((s:Obj)=>s.id),unavailableIds=packet.unavailableSources.map((s:Obj)=>s.id);
 const check=(q:z.infer<typeof qualificationSchema>)=>{
  if(!sameSet(q.decisions.map(d=>d.tokenKey),keys)||!sameSet(q.inspectedSourceIds,sourceIds)||!sameSet(q.unavailableSourceIds,unavailableIds))fail('QUALIFICATION_COVERAGE');
  for(const d of q.decisions){for(const x of [...d.identity.citations,...d.association.citations]){const e=excerpts.get(x.excerptId);if(!e||e.sourceId!==x.sourceId||e.quote!==x.quote)fail('QUALIFICATION_CITATION');}if(d.identity.nativeIdentityIds.some(i=>!nativeIds.has(i)))fail('QUALIFICATION_NATIVE_ID');if(d.disposition==='MEMBER'&&(!d.identity.nativeIdentityIds.length||!d.identity.citations.length||!d.association.citations.length))fail('MEMBER_WITHOUT_SOURCE');}
  const accepted=q.decisions.filter(d=>d.disposition==='MEMBER').map(d=>d.tokenKey),unresolved=q.decisions.filter(d=>d.disposition==='UNRESOLVED').map(d=>d.tokenKey);
  if(!sameSet(accepted,q.candidateSet.acceptedTokenKeys)||!sameSet(unresolved,q.candidateSet.unresolvedTokenKeys)||q.candidateSet.complete&&unresolved.length)fail('QUALIFICATION_SET');
  if(!sameSet(q.leadDispositions.map((v:Obj)=>v.lead),packet.leadDispositionsToAssess.map((v:Obj)=>v.lead)))fail('LEAD_ACCOUNTING');
  for(const lead of q.leadDispositions as Obj[]){if(!Array.isArray(lead.citations)||!Array.isArray(lead.resolvedTokenKeys)||lead.resolvedTokenKeys.some((k:string)=>!keys.includes(k)))fail('LEAD_ACCOUNTING');for(const x of lead.citations){const e=excerpts.get(x.excerptId);if(!e||e.sourceId!==x.sourceId||e.quote!==x.quote)fail('LEAD_CITATION');}}
 };
 check(proposal);check(review);
 const executions=c.qualification.executionRecordIds.map(id=>JSON.parse(get(id).raw));if(executions.length!==2||executions.some(v=>!obj(v)||v.outcomesSupplied===true||'thinking'in v||'messages'in v))fail('QUALIFICATION_EXECUTION');
 const nativeExecution=executions.find(v=>v.nativeInvocation),independent=executions.find(v=>v.actualClaudeCli===true);
 if(!nativeExecution||nativeExecution.packetSha256!==packetRecord.sha256||nativeExecution.proposalSha256!==proposalRecord.sha256||nativeExecution.outcomesSupplied!==false||nativeExecution.implementationReview!==false||!independent||independent.exitCode!==0||independent.timedOut!==false||independent.resultRecords!==1||independent.toolUseObserved!==false||!Array.isArray(independent.actualSessionIds)||independent.actualSessionIds.length!==1||independent.actualSessionIds[0]!==independent.sessionIdRequested||!Array.isArray(independent.actualModels)||!independent.actualModels.length||!isDeepStrictEqual(independent.initializationToolsReported,[[]])||!isDeepStrictEqual(independent.initializationMcpReported,[[]]))fail('QUALIFICATION_EXECUTION');
 const finalRecords=c.decodedRecords.filter(r=>r.sha256===independent.responseSha256);if(finalRecords.length!==1)fail('QUALIFICATION_FINAL_TEXT');
 const finalText=finalRecords[0]!.raw.trim(),jsonText=finalText.startsWith('```json\n')&&finalText.endsWith('```')?finalText.slice(8,-3).trim():finalText;
 if(!isDeepStrictEqual(JSON.parse(jsonText),JSON.parse(reviewRecord.raw)))fail('QUALIFICATION_FINAL_TEXT');
 const extraSources=Object.keys(c.qualification.sourceRecords).filter(path=>!pinnedPaths.includes(path));
 const nativeHashes=new Set(packet.nativeIdentityProjections.map((v:Obj)=>v.rawResponseSha256));
 for(const path of extraSources){const r=get(c.qualification.sourceRecords[path]!);if(!nativeHashes.has(r.sha256)&&r.id!==finalRecords[0]!.id)fail('QUALIFICATION_ORPHAN_SOURCE');}
 
 return{packetSha256:packetRecord.sha256,proposalSha256:proposalRecord.sha256,reviewSha256:reviewRecord.sha256,candidateKeys:keys,proposal,review,unavailableSources:packet.unavailableSources,leadDispositions:review.leadDispositions,limitations:[...review.limitations,'Semantic judgments are source-bound declared inferences; copied/selfclaims do not verify rewards or legitimacy.']};
}

type QualificationJudgment={decisions:{tokenKey:string;disposition:'MEMBER'|'NON_MEMBER'|'UNRESOLVED'}[];candidateSet:{complete:boolean};additionalMaterialIdentities:unknown[]};
/** Closure belongs to both source judgments, not either producer completeness flag.
 * Disagreement remains uncertain even when neither side names it UNRESOLVED. */
export function a13QualificationClosure(proposal:QualificationJudgment,review:QualificationJudgment,candidateKeys:string[]){
 const nativeMembers=proposal.decisions.filter(d=>d.disposition==='MEMBER').map(d=>d.tokenKey),reviewMembers=review.decisions.filter(d=>d.disposition==='MEMBER').map(d=>d.tokenKey);
 const acceptedTokenKeys=candidateKeys.filter(key=>nativeMembers.includes(key)&&reviewMembers.includes(key));
 const unresolvedTokenKeys=candidateKeys.filter(key=>{
  const native=proposal.decisions.find(d=>d.tokenKey===key)?.disposition,independent=review.decisions.find(d=>d.tokenKey===key)?.disposition;
  return native===undefined||independent===undefined||native==='UNRESOLVED'||independent==='UNRESOLVED'||native!==independent;
 });
 const additionalMaterialIdentities=proposal.additionalMaterialIdentities.length+review.additionalMaterialIdentities.length;
 const qualificationComplete=proposal.candidateSet.complete&&review.candidateSet.complete&&sameSet(nativeMembers,reviewMembers)&&unresolvedTokenKeys.length===0&&additionalMaterialIdentities===0;
 return{acceptedTokenKeys,unresolvedTokenKeys,qualificationComplete,additionalMaterialIdentities};
}

export function a13ParticipationRatio(rows:{mint:string;delta:number}[],target:string,accepted:string[],unresolved:string[],qualificationComplete:boolean,additionalMaterialIdentities:number){
 if(!accepted.includes(target))fail('TARGET_NOT_JOINTLY_ACCEPTED');
 if(additionalMaterialIdentities!==0)fail('MATERIAL_IDENTITY_OUTSIDE_FRAME');
 if(qualificationComplete&&unresolved.length)fail('MEMBERSHIP_CAN_CHANGE_DENOMINATOR');
 const allZero=rows.every(r=>Math.max(r.delta,0)===0),invariant=!qualificationComplete&&allZero&&additionalMaterialIdentities===0;
 if(!qualificationComplete&&!invariant)fail('MEMBERSHIP_CAN_CHANGE_DENOMINATOR');
 const included=rows.filter(r=>accepted.includes(r.mint)),D=included.reduce((n,r)=>n+BigInt(Math.max(r.delta,0)),0n),row=rows.find(r=>r.mint===target)??fail('TARGET_NATIVE_MISSING'),g=BigInt(Math.max(row.delta,0));
 return{share:D===0n?null:{numerator:g.toString(),denominator:D.toString()},shareStatus:D===0n?'UNDEFINED_ZERO_POSITIVE_GROWTH':'DEFINED',numeratorPositiveGrowth:g.toString(),denominatorPositiveGrowth:D.toString(),denominatorIdentified:true,qualificationComplete,identification:invariant?'FINITE_FRAME_ZERO_POSITIVE_GROWTH_INVARIANT':'COMPLETE_SOURCE_QUALIFIED_PANEL',unresolvedTokenKeys:unresolved};
}

export function deriveA13Participation(raw:string,token:TokenRef,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 try{
  const capture=decodeA13ParticipationCapture(raw,cutoff),q=reconstructA13Qualification(capture,cutoff),n=reconstructA13NativeParticipation(a13NativeInput(capture),cutoff);
  const closure=a13QualificationClosure(q.proposal,q.review,q.candidateKeys),accepted=closure.acceptedTokenKeys.map(key=>key.slice(7)),unresolved=closure.unresolvedTokenKeys;
  if(token.chain!=='solana'||!sameSet(n.candidates.map(r=>`solana:${r.mint}`),q.candidateKeys))fail('NATIVE_QUALIFICATION_FRAME');
  const ratio=a13ParticipationRatio(n.candidates,token.address,accepted,unresolved,closure.qualificationComplete,closure.additionalMaterialIdentities);
  return{id:'A13',quality:'KNOWN',unit:'POSITIVE_OWNER_PROXY_GROWTH_SHARE',reasonCode:ratio.shareStatus==='UNDEFINED_ZERO_POSITIVE_GROWTH'?'OBSERVED_POSITIVE_GROWTH_DENOMINATOR_ZERO':'OBSERVED_PEER_PARTICIPATION_MEASURED',evidenceIds,data:{...ratio,scope:'FINITE_IDENTIFIED_OBSERVED_REPRESENTATION_SAMPLE',qualification:{...q,unresolvedTokenKeys:unresolved},candidates:n.candidates.map(row=>({...row,membership:unresolved.includes(`solana:${row.mint}`)?'UNRESOLVED':q.review.decisions.find(d=>d.tokenKey===`solana:${row.mint}`)!.disposition})),decreases:n.candidates.filter(r=>r.delta<0).map(r=>({mint:r.mint,delta:r.delta})),acquisition:{...n.coverage,complete:false,requiredCandidateSourcesComplete:n.coverage.candidateSubfamilyStatus==='COMPLETE',failedControlReads:n.controls.length},controls:n.controls,operator:n.operator,sourceTimes:n.sourceTimes,limitations:['Positive SPL-owner balances are an address proxy, not people, new buyers or capital.','Fixed evidenced operational addresses are excluded; latent roles are not exhaustively identified.','Distinct native endpoint banks and actual intervals are retained; this is one shared historical study.']}};
 }catch(error){return{id:'A13',quality:'MISSING',unit:'POSITIVE_OWNER_PROXY_GROWTH_SHARE',reasonCode:error instanceof Error?error.message.slice(0,180):'A13_PARTICIPATION_UNAVAILABLE',evidenceIds,data:{share:null,shareStatus:'UNAVAILABLE_REQUIRED_SOURCE_OR_MEMBERSHIP',denominatorIdentified:false,numeratorPositiveGrowth:null,denominatorPositiveGrowth:null}};}
}
