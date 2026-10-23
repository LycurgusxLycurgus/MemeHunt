import { Decimal } from 'decimal.js';
import type { BaselineAssessment, HolderFacts } from './baseline.js';
import { entryGroupFactsSchema, type EntryGroupFacts, type EvidenceRecord, type LiveCollection, type LiveMarketSummary, type Profile, type SocialPolicyFacts, type TokenRef } from './contracts.js';

export type EntryGroupInputs={token:TokenRef;cutoff:string;profile:Profile;baseline:BaselineAssessment[];evidence:EvidenceRecord[];collection:LiveCollection;social?:SocialPolicyFacts;holders?:HolderFacts;holderCode?:string;excludedVaults?:string[];exclusionEvidenceIds?:string[];market?:LiveMarketSummary|null;marketCode?:string;venuePoolAddress?:string};
type Group=EntryGroupFacts['groups'][number];
const d=(v:Decimal.Value)=>new Decimal(v);

/** Minimum current entry screens, not a claim that all research measurements exist. */
export function deriveEntryGroups(input:EntryGroupInputs):EntryGroupFacts{
 const rows:Group[]=[],at=Date.parse(input.cutoff),assessment=(id:string)=>input.baseline.find(a=>a.id===id);
 const known=(id:string)=>{const a=assessment(id);return a?.quality==='KNOWN'&&a.projection?.quality==='KNOWN'&&Date.parse(a.projection.availableAt)<=at?a:undefined;};
 const refs=(ids:string[])=>[...new Set(ids.flatMap(id=>assessment(id)?.evidenceIds??[]))];
 const cause=(ids:string[],fallback:string)=>ids.flatMap(id=>assessment(id)?.causes??[]).find(c=>/TIMEOUT|HTTP_429|HTTP_5\d\d|MODEL_|LIVE_/.test(c.code))?.code??ids.flatMap(id=>assessment(id)?.causes??[])[0]?.code??fallback;
 const add=(checkId:Group['checkId'],status:Group['status'],rationale:string,code:string,featureIds:string[],evidenceIds:string[],metrics:Record<string,unknown>,limitations:string[])=>{
  const unique=[...new Set(evidenceIds)],records=unique.map(id=>input.evidence.find(e=>e.id===id)),ttl=checkId==='ADV-03'||checkId==='ADV-04'?900000:300000;
  const fresh=records.length>0&&records.every(e=>e&&[e.availableAt,e.retrievedAt].every(t=>Number.isFinite(Date.parse(t))&&at>=Date.parse(t)&&at-Date.parse(t)<=ttl));
  if(status!=='UNKNOWN'&&!fresh){status='UNKNOWN';code='GROUP_SOURCE_STALE_OR_MISSING';rationale='The current group evidence is missing or outside its freshness bound.';}
  rows.push({checkId,status,rationale,code,featureIds,evidenceIds:unique,availableAt:records.some(e=>e)?new Date(Math.max(...records.flatMap(e=>e?[Date.parse(e.availableAt)]:[]))).toISOString():input.cutoff,metrics,limitations});
 };
 const h=input.holders,ownerIds=['O17','O18','O19','O20'];
 const ownerLimits=['Only exact account-owner clusters are proven; common human control is not inferred.','Wallet age, historical synchronization and cohort performance are not prerequisites for a new token.'];
 if(h?.complete&&/^[1-9]\d*$/.test(h.supplyAtomic)){
  const excluded=new Set(input.excludedVaults??[]),owners=new Map<string,bigint>();let excludedAtomic=0n,covered=0n;
  for(const a of h.accounts){const amount=BigInt(a.amount);covered+=amount;if(excluded.has(a.address))excludedAtomic+=amount;else owners.set(a.owner,(owners.get(a.owner)??0n)+amount);}
  const amounts=[...owners.values()].filter(a=>a>0n).sort((a,b)=>a>b?-1:a<b?1:0),total=BigInt(h.supplyAtomic),share=(amount:bigint)=>d(amount.toString()).div(total.toString()).toFixed();
  if(covered!==total)throw Error('GROUP_HOLDER_SUPPLY_INVALID');
  const largest=share(amounts[0]??0n),limit=input.profile.risk.maxDirectControlShare;
  const metrics={ownerClusters:amounts.length,largestOwnerSupplyFraction:largest,topFiveSupplyFraction:share(amounts.slice(0,5).reduce((a,b)=>a+b,0n)),herfindahlSupplyFraction:amounts.reduce((sum,n)=>sum.add(d(n.toString()).div(total.toString()).pow(2)),d(0)).toFixed(),protocolVaultSupplyFraction:share(excludedAtomic),excludedVaults:[...excluded],supplyReconciled:true};
  add('ADV-01',limit===undefined?'UNKNOWN':d(largest).lte(limit)?'PASS':'FAIL',limit===undefined?'A control-share limit is required.':d(largest).lte(limit)?'The current exact-owner clusters stay within your control-share limit after certified liquidity-vault exclusions.':'A current non-vault owner cluster exceeds your selected control-share limit.',limit===undefined?'PROFILE_INCOMPLETE':'CURRENT_OWNER_CLUSTER_SCREEN',ownerIds,[...h.evidenceIds,...input.exclusionEvidenceIds??[]],metrics,ownerLimits);
 }else add('ADV-01','UNKNOWN','The current full owner population could not be reconstructed.',input.holderCode??cause(ownerIds,'HOLDER_POPULATION_REQUIRED'),ownerIds,refs(ownerIds),{},ownerLimits);

 const pair=input.market?.pairs.find(p=>p.mintSide==='base'&&p.priceUsd!==null&&p.volume24hUsd!==null&&p.buys24h!==null&&p.sells24h!==null),marketIds=input.evidence.filter(e=>e.id==='dex-pairs').map(e=>e.id);
 const flowLimits=['Reported rolling-window counts and volume are not net capital flow, unique traders, organic volume or a wash-trading diagnosis.','No prior-day or minimum-age comparison is required; the reported window may include the entire lifetime of a young pool.'];
 if(pair){
  const trades=pair.buys24h!+pair.sells24h!,active=trades>0&&d(pair.volume24hUsd!).gt(0);
  add('ADV-02',active?'PASS':'FAIL',active?'The retained exact-token market reports inspectable current trading activity.':'The complete retained market record does not show positive trading activity in its reported window.','REPORTED_ACTIVITY_CONTEXT',['O28'],marketIds,{pair:pair.pairAddress,window:'reported rolling 24h',buys:pair.buys24h,sells:pair.sells24h,buyCountFraction:trades?d(pair.buys24h!).div(trades).toFixed():null,volumeUsd:pair.volume24hUsd,volumeToDisplayedLiquidity:pair.liquidityUsd&&d(pair.liquidityUsd).gt(0)?d(pair.volume24hUsd!).div(pair.liquidityUsd).toFixed():null},flowLimits);
 }else add('ADV-02',input.market&&['OBSERVED','TRUNCATED','NO_RESULTS'].includes(input.collection.dex.state)?'FAIL':'UNKNOWN','The retained market scope does not adequately evidence exact-token activity.',input.marketCode??input.collection.dex.code??'ACTIVITY_FIELDS_MISSING',['O28'],marketIds,{},flowLimits);

 const narrative=['A01','A02','A05'],sample=['A15','A16','A17'],attentionIds=[...narrative,...sample];
 const posts=known('A16')?.projection?.value,authors=known('A17')?.projection?.value;
 const gate=assessment('A15')?.data as {method?:string;verdict?:string;postSampleScope?:{complete:boolean}}|null;
 const closedGap=gate?.method==='entry-evidence-gate-v1'&&gate.verdict==='FAIL'&&gate.postSampleScope?.complete===true;
 const described=narrative.every(id=>known(id)),measured=typeof posts==='string'&&typeof authors==='string'&&known('A15')?.projection?.value===true;
 const attentionLimits=['Bounded token-source context; this does not measure platform-wide or underlying meme/news virality.','Persistence, prior-window acceleration and mature attention/price histories are not mandatory.'];
 const narrativeNegative=narrative.some(id=>known(id)?.projection?.value===false);
 if(described&&measured||closedGap||narrativeNegative){
  const enough=!narrativeNegative&&measured&&d(posts as string).gte(3)&&d(authors as string).gte(3);
  add('ADV-03',enough?'PASS':'FAIL',enough?'A cited, source-qualified narrative has current original material across at least three source accounts.':'The completed source qualification does not establish sufficient current narrative and independent-account breadth.','CURRENT_ATTENTION_CONTEXT',attentionIds,refs(attentionIds),{qualifiedOriginals:measured?posts:null,sourceAccounts:measured?authors:null,minimumSourceAccounts:3,narrativeSupported:described?!narrativeNegative:narrativeNegative?false:null,historyRequired:false},attentionLimits);
 }else add('ADV-03','UNKNOWN','Current narrative or post qualification has not completed.',cause(attentionIds,'ATT_CONTEXT_REVIEW_INCOMPLETE'),attentionIds,refs(attentionIds),{},attentionLimits);

 const social=input.social,grouping=assessment('S02')?.data as {accounts?:number;qualifiedOriginals?:number;copyGroups?:string[]}|null;
 const actorIds=['S02','S03','S10'],actorRefs=[...new Set([...refs(actorIds),...social?.evidenceIds??[]])];
 const actorLimits=['Accounts are public source identities, not verified people; copy groups are not proof of common wallet control.','Account age, prior PnL, returning-participant history and copy-trade performance are not entry prerequisites.'];
 if(social?.sampleComplete&&known('S02')&&typeof grouping?.accounts==='number'&&Array.isArray(grouping.copyGroups)){
  const enough=grouping.accounts>=2&&grouping.copyGroups.length>=2;
  add('ADV-04',enough?'PASS':'FAIL',enough?'The inspected current actor sample contains multiple accounts and distinct reviewed copy groups.':'The inspected current sample does not establish multiple accounts and distinct original actor groups.','CURRENT_ACTOR_CONTEXT',actorIds,actorRefs,{accounts:grouping.accounts,qualifiedOriginals:grouping.qualifiedOriginals,distinctCopyGroups:grouping.copyGroups.length,minimumAccounts:2,historyRequired:false},actorLimits);
 }else if(social?.participationReview?.verdict==='CONTRADICTED')add('ADV-04','FAIL','Independent review found inadequate current public participation evidence; exact actor counts remain unqualified.','REVIEWED_ACTOR_SUPPORT_INADEQUATE',actorIds,actorRefs,{accounts:null,distinctCopyGroups:null,historyRequired:false},actorLimits);
 else add('ADV-04','UNKNOWN','Current actor-source inspection or independent review has not completed.',cause(actorIds,'SOC_ACTOR_REVIEW_INCOMPLETE'),actorIds,actorRefs,{},actorLimits);

 const venue=known('O08'),venueData=venue?.data as {poolAddress?:string;version?:string;bindingVerified?:boolean}|null,poolAddress=input.venuePoolAddress??venueData?.poolAddress;
 const contextPair=input.market?.pairs.find(p=>p.mintSide==='base'&&p.pairAddress===poolAddress)??input.market?.pairs.find(p=>p.mintSide==='base'&&p.priceUsd!==null);
 const contextIds=['O08','O02','C01'],contextRefs=[...new Set([...refs(contextIds),...marketIds])],contextLimits=['Pool age is not token creation age; missing pool dates do not fail this screen.','No mature chart, macro series, launch cohort or minimum token age is required. This screen does not certify predictive market timing.'];
 if(venue?.projection?.value===true&&contextPair?.priceUsd!==null&&contextPair?.priceUsd!==undefined&&input.profile.horizonSeconds&&input.profile.sizeUsd){
  const date=contextPair.pairCreatedAt?Date.parse(contextPair.pairCreatedAt):null,age=date!==null&&Number.isFinite(date)&&date<=at?Math.floor((at-date)/1000):null;
  const valid=d(contextPair.priceUsd).gt(0);
  add('ADV-05',valid?'PASS':'FAIL',valid?'The current verified route, market price and selected trade horizon provide a usable lifecycle/market context.':'The retained exact-token price is not positive.','CURRENT_LIFECYCLE_CONTEXT',contextIds,contextRefs,{route:venueData?.version,pool:poolAddress??null,marketPair:contextPair.pairAddress,priceUsd:contextPair.priceUsd,displayedLiquidityUsd:contextPair.liquidityUsd,poolAgeSeconds:age,poolAgeSubject:contextPair.pairAddress,poolStage:age===null?'DATE_NOT_ESTABLISHED':age<3600?'EARLY_POOL':'ACTIVE_POOL',sizeUsd:input.profile.sizeUsd,horizonSeconds:input.profile.horizonSeconds,minimumAgeSeconds:null},contextLimits);
 }else if(venue?.projection?.value===true&&input.market&&['OBSERVED','TRUNCATED','NO_RESULTS'].includes(input.collection.dex.state)&&input.profile.horizonSeconds&&input.profile.sizeUsd)add('ADV-05','FAIL','The acquired market scope does not establish a usable current exact-token price context.','CURRENT_MARKET_SUPPORT_INADEQUATE',contextIds,contextRefs,{poolAgeSeconds:null,minimumAgeSeconds:null},contextLimits);
 else add('ADV-05','UNKNOWN','Current route, market or trade-context acquisition is incomplete.',cause(contextIds,input.marketCode??'CURRENT_CONTEXT_INCOMPLETE'),contextIds,contextRefs,{},contextLimits);
 return entryGroupFactsSchema.parse({method:'mandatory-entry-groups-v1',token:input.token,cutoff:input.cutoff,groups:rows});
}
