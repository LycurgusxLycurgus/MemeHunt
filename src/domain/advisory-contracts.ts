import { z } from 'zod';
import { entryDefinitions } from './catalog.js';

export const advisoryGroups=entryDefinitions.filter(row=>row.checkId.startsWith('ADV-'));
export const advisoryIds=advisoryGroups.flatMap(row=>row.featureIds);
export const advisoryMetricSchema=z.object({
  id:z.string(),quality:z.enum(['KNOWN','MISSING','TRUNCATED','INVALID']),unit:z.string().min(1),
  data:z.unknown(),evidenceIds:z.array(z.string()),reasonCode:z.string().min(1),
}).strict();
export type AdvisoryMetric=z.infer<typeof advisoryMetricSchema>;
export const advisoryFactsSchema=z.object({
  method:z.literal('advisory-measurements-v1'),
  token:z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1)}).strict(),
  cutoff:z.iso.datetime({offset:true}),metrics:z.array(advisoryMetricSchema).length(advisoryIds.length),
  groups:z.array(z.object({checkId:z.string(),known:z.number().int().nonnegative(),total:z.number().int().positive(),unresolved:z.array(z.string())}).strict()).length(advisoryGroups.length),
}).strict().superRefine((facts,ctx)=>{
  if(new Set(facts.metrics.map(m=>m.id)).size!==advisoryIds.length||facts.metrics.some(m=>!advisoryIds.includes(m.id)))ctx.addIssue({code:'custom',message:'ADVISORY_METRIC_MEMBERSHIP'});
  for(const group of advisoryGroups){
    const reported=facts.groups.filter(g=>g.checkId===group.checkId);
    const unresolved=group.featureIds.filter(id=>facts.metrics.find(m=>m.id===id)?.quality!=='KNOWN');
    if(reported.length!==1||reported[0].total!==group.featureIds.length||reported[0].known!==group.featureIds.length-unresolved.length||JSON.stringify(reported[0].unresolved)!==JSON.stringify(unresolved))ctx.addIssue({code:'custom',message:'ADVISORY_GROUP_COVERAGE'});
  }
});
export type AdvisoryFacts=z.infer<typeof advisoryFactsSchema>;
