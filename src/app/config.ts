import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chainSchema, profileSchema, thesisSchema, type Profile, type Thesis } from '../domain/contracts.js';
import { evaluatePredicate } from '../domain/policy.js';
import { featureMetadata } from '../domain/catalog.js';

export const savedConfigSchema = z.object({
  schemaVersion: z.literal(1), defaultChain: chainSchema.optional(), profile: profileSchema,
  thesisTemplate: thesisSchema.optional(),
  thesisExpiryMode:z.enum(['HORIZON','FIXED','NONE']).optional(),
  preset: z.object({ id: z.string(), calibration: z.literal('UNCALIBRATED'), selectedBy: z.enum(['USER_REQUEST','USER_EDIT']) }).strict().optional(),
}).strict();
export type SavedConfig = z.infer<typeof savedConfigSchema>;
export type Ask = (prompt: string) => Promise<string | undefined>;
export const starterProfile = (): Profile => ({ id: 'memecoin-research-starter-v1', sizeUsd: '25', horizonSeconds: 21600,
  risk: { maxTransferFeeBps:'100', maxEntryImpactBps:'200', maxExitImpactBps:'300', maxRoundTripLossBps:'1000', maxDirectControlShare:'0.10', maxRemovableLiquidityShare:'0.10' },
  stage: { ageBands: [{ name:'ALL_AGES', minSeconds:0, maxSeconds:null }] } });
export const starterConfig = (): SavedConfig => ({ schemaVersion:1, profile:starterProfile(), preset:{ id:'memecoin-research-starter-v1', calibration:'UNCALIBRATED', selectedBy:'USER_REQUEST' } });
export const presetDescription = 'Uncalibrated research preset: $25, 6 hours; transfer fee 1%, entry impact 2%, exit impact 3%, round-trip friction 10%, direct control 10%, removable liquidity 10%. Friction is not a price stop or a maximum-loss guarantee.';

export function validateConfig(input: unknown): SavedConfig {
  const parsed = savedConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_CONFIG');
  if (parsed.data.thesisTemplate) validateThesis(parsed.data.thesisTemplate);
  return parsed.data;
}
export function validateThesis(input: unknown): Thesis {
  const thesis = thesisSchema.parse(input);
  const units:Record<string,string>={O07:'bps',O09:'fraction',O13:'bps',O14:'bps',O15:'bps',O19:'fraction',O20:'fraction',A16:'count',A17:'count'};
  for(const id of ['O01','O02','O03','O04','O05','O06','O08','O10','O11','O12','O16','O17','O18','O28','A01','A02','A03','A04','A05','A06','A09','A10','A11','A14','A15','A18','S01','S02','S03','S04','S05','S06','S10','C01','C02','C03','C04','C05','C06'])units[id]='bool';
  const check=(p:Thesis['support'][number]):void=>{
    if('children' in p){for(const child of p.children)check(child);return;}
    const expected=units[p.feature];if(expected&&p.unit!==expected)throw new Error('PREDICATE_UNIT');
    if(p.unit==='bool'&&(p.op!=='eq'||typeof p.value!=='boolean'))throw new Error('PREDICATE_TYPE');
    if(expected&&expected!=='bool'&&!(typeof p.value==='string'&&/^(0|[1-9]\d*)(\.\d+)?$/.test(p.value)))throw new Error('PREDICATE_TYPE');
  };
  for (const predicate of [...thesis.support,...thesis.invalidation,...[thesis.catalyst,thesis.onchainTraction,thesis.externalTraction,thesis.warning].filter(p=>p!==null),...thesis.legs.map(l=>l.trigger)]) {check(predicate);evaluatePredicate(predicate,[],new Date().toISOString());}
  return thesis;
}
export function loadConfig(path: string): SavedConfig | undefined {
  if (!existsSync(path)) return undefined;
  try { const text = readFileSync(path); if (text.length>200_000) throw new Error(); return validateConfig(JSON.parse(text.toString('utf8'))); }
  catch { throw new Error('INVALID_CONFIG'); }
}
export function saveConfig(path: string, input: unknown, overwrite = false): SavedConfig {
  const config = validateConfig(input);
  if (existsSync(path) && !overwrite) throw new Error('CONFIG_EXISTS');
  mkdirSync(dirname(path),{recursive:true});
  const temporary = join(dirname(path),`.config-${randomUUID()}.tmp`);
  try { writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600}); renameSync(temporary,path); }
  finally { rmSync(temporary,{force:true}); }
  return config;
}
export async function guideConfig(ask: Ask, initial = starterConfig()): Promise<SavedConfig | undefined> {
  const config = structuredClone(initial);
  const choose = async (label:string,current:string,apply:(answer:string)=>void,valid:(answer:string)=>boolean) => {
    for (;;) { const response=await ask(`${label} [${current}] (Enter keeps it; cancel stops): `);
      if (response===undefined || response.trim().toLowerCase()==='cancel') return false;
      const answer=response.trim()||current; if (!valid(answer)) continue; apply(answer); return true; }
  };
  if (!await choose('Scenario size in USD',config.profile.sizeUsd??'25',v=>{config.profile.sizeUsd=v;},v=>/^(0|[1-9]\d*)(\.\d+)?$/.test(v)&&Number(v)>0&&Number.isFinite(Number(v)))) return undefined;
  if (!await choose('Holding horizon in hours',String((config.profile.horizonSeconds??21600)/3600),v=>{config.profile.horizonSeconds=Number(v)*3600;},v=>Number.isSafeInteger(Number(v)*3600)&&Number(v)>0)) return undefined;
  const labels:Record<string,string>={maxTransferFeeBps:'Maximum transfer fee (bps; 100 bps = 1%)',maxEntryImpactBps:'Maximum entry impact (bps)',maxExitImpactBps:'Maximum exit impact (bps)',maxRoundTripLossBps:'Maximum round-trip friction (bps)',maxDirectControlShare:'Maximum direct control share (fraction; 0.10 = 10%)',maxRemovableLiquidityShare:'Maximum removable liquidity share (fraction)'};
  for (const [key,label] of Object.entries(labels)) if (!await choose(label,config.profile.risk[key]??starterProfile().risk[key],v=>{config.profile.risk[key]=v;},v=>/^(0|[1-9]\d*)(\.\d+)?$/.test(v)&&Number(v)<=(key.endsWith('Share')?1:10000))) return undefined;
  // Age bands have their own schema: the starter deliberately adds no age-based policy.
  if (config.preset) config.preset.selectedBy='USER_EDIT';
  return validateConfig(config);
}
export async function guideThesis(ask:Ask,profile:Profile,cutoff:string,initial?:Thesis):Promise<Thesis|undefined> {
  const thesis=initial?structuredClone(initial):materializeThesis(profile,cutoff);
  const predicate=async(label:string):Promise<Thesis['support'][number]|undefined>=>{
    for(;;){const feature=(await ask(`${label}: feature ID (e.g. O15 for friction; A16 for qualified posts; cancel stops): `))?.trim();if(feature===undefined||feature==='cancel')return undefined;if(!featureMetadata.some(f=>f.id===feature))continue;
      const operator=(await ask('Comparison eq / lt / lte / gt / gte: '))?.trim();if(operator===undefined||operator==='cancel')return undefined;if(!['eq','lt','lte','gt','gte'].includes(operator))continue;
      const unit=(await ask('Unit (bool, bps, fraction, count): '))?.trim();if(unit===undefined||unit==='cancel')return undefined;
      const raw=(await ask('Threshold (true/false for bool; otherwise a nonnegative decimal): '))?.trim();if(raw===undefined||raw==='cancel')return undefined;
      try {const p={op:operator,feature,unit,value:unit==='bool'?raw==='true'?true:raw==='false'?false:raw:raw};const checked=validateThesis({...thesis,support:[p]}).support[0];return checked;}catch{/* Re-prompt the invalid predicate without saving. */}
    }
  };
  const configure=async(field:'support'|'invalidation'|'onchainTraction'|'externalTraction'|'warning'|'catalyst')=>{
    const answer=(await ask(`Change ${field}? [y/N] `))?.trim();if(answer===undefined||answer==='cancel')return false;
    if(!/^(y|yes)$/i.test(answer))return true;
    const p=await predicate(field);if(!p)return false;if(field==='support'||field==='invalidation')thesis[field]=[p];else thesis[field]=p;return true;
  };
  for(const field of ['support','invalidation','catalyst','onchainTraction','externalTraction','warning'] as const)if(!await configure(field))return undefined;
  const legs=(await ask('Configure ordered realization legs? [y/N] '))?.trim();if(legs===undefined||legs==='cancel')return undefined;
  if(/^(y|yes)$/i.test(legs)){thesis.legs=[];for(let index=0;index<10;index++){const amount=(await ask('Original quantity to realize in bps, ALL_REMAINING, or done: '))?.trim();if(amount===undefined||amount==='cancel')return undefined;if(amount==='done')break;if(amount!=='ALL_REMAINING'&&!/^[1-9]\d{0,4}$/.test(amount))continue;const trigger=await predicate('Realization trigger');if(!trigger)return undefined;try{const proposed=[...thesis.legs,{id:`leg-${index+1}`,quantityBps:amount==='ALL_REMAINING'?null:Number(amount),allRemaining:amount==='ALL_REMAINING',trigger}];validateThesis({...thesis,legs:proposed});thesis.legs=proposed;if(amount==='ALL_REMAINING')break;}catch{continue;}}}
  return validateThesis(thesis);
}
export function materializeThesis(profile: Profile, cutoff: string, template?: Thesis,expiryMode:'HORIZON'|'FIXED'|'NONE'='FIXED'): Thesis {
  if (template) return validateThesis({...structuredClone(template),expiryAt:expiryMode==='HORIZON'&&profile.horizonSeconds?new Date(Date.parse(cutoff)+profile.horizonSeconds*1000).toISOString():expiryMode==='NONE'?null:template.expiryAt});
  const safe = ['O01','O03','O04','O06'];
  return validateThesis({ support:[...safe,'A01','A02'].map(feature=>({op:'eq',feature,value:true,unit:'bool'})),
    invalidation:[...safe.map(feature=>({op:'eq',feature,value:false,unit:'bool'})),{op:'gt',feature:'O15',value:profile.risk.maxRoundTripLossBps??'1000',unit:'bps'}],
    expiryAt:profile.horizonSeconds?new Date(Date.parse(cutoff)+profile.horizonSeconds*1000).toISOString():null,
    catalyst:null,onchainTraction:null,externalTraction:null,warning:null,legs:[] });
}
