#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Service } from './app/service.js';
import { bundleSchema, type PositionEvent, type PositionRecord } from './domain/contracts.js';
import { probeDexScreener } from './providers/dexscreener.js';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i+1]; };
const fileJson = (path: string | undefined) => { if (!path) throw new Error('FILE_REQUIRED'); if (readFileSync(path).byteLength > 2_000_000) throw new Error('FILE_TOO_LARGE'); return JSON.parse(readFileSync(path,'utf8')) as unknown; };
const output = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
const fail = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${message}\n`);
  const code = /NOT_FOUND/.test(message) ? 4 : /SQLITE|database|EACCES|ENOENT/.test(message) ? 3 : 2;
  process.exitCode = code;
};

async function main() {
  const cmd = args[0];
  if (cmd === 'capabilities') return output({ chains: ['solana','bsc','base','robinhood'], liveMarketDiagnostic: ['solana','bsc','base','robinhood'], certifiedVenues: [], semanticHosted: 'disabled-until-entitlement-and-quality-validation', execution: false });
  if (cmd === 'profile' && args[1] === 'options') return output({ default: 'unconfigured-live', liveRequired: ['size','horizon','risk','ageBands','exitPlan'], styleChoices: ['SPARK','WAVE','COMMUNITY'], capBands: ['MICRO [0,100000)','SMALL [100000,1000000)','ESTABLISHED [1000000,10000000)','LARGE [10000000,∞)'], chartCandidates: { MICRO: ['1m','5m','15m'], SMALL: ['30m','1h'], ESTABLISHED: ['4h','1d'], LARGE: [] }, illustrativeExit: ['4000 bps','3000 bps','ALL_REMAINING'], calibrated: false });
  if (cmd === 'doctor') return output({ node: process.version, sqlite: true, dataFile: flag('db') ?? '.data/dd.sqlite', geminiKeyPresent: !!process.env.GEMINI_API_KEY, warning: 'No live venue certification or strategy calibration has been performed' });
  if (cmd === 'market' && args[1] === 'probe') return output(await probeDexScreener(args[2],args[3]));
  const svc = new Service(flag('db'));
  try {
    if (cmd === 'analyze' || cmd === 'reassess') {
      const bundle = bundleSchema.parse(flag('bundle') ? fileJson(flag('bundle')) : (() => {
        if (cmd !== 'analyze' || !args[1] || !flag('chain')) throw new Error('BUNDLE_OR_ADDRESS_AND_CHAIN_REQUIRED');
        return { token: { chain: flag('chain'), address: args[1] }, cutoff: new Date().toISOString(), analysisKind: 'MANUAL_EMPTY', evidence: [], observations: [], features: [], profile: { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } } };
      })());
      if (cmd === 'analyze') {
        if (args[1] && args[1] !== bundle.token.address) throw new Error('ADDRESS_BUNDLE_MISMATCH');
        if (flag('chain') && flag('chain') !== bundle.token.chain) throw new Error('CHAIN_BUNDLE_MISMATCH');
        const prior = svc.caseFor(bundle.token);
        return output(prior?.status === 'THESIS_TRACKED' && !args.includes('--entry') ? svc.reassess(prior.id,bundle) : svc.analyze(bundle));
      }
      return output(svc.reassess(args[1], bundle));
    }
    if (cmd === 'show' || cmd === 'explain') return output(svc.show(args[1]));
    if (cmd === 'replay') return output(svc.replay(args[1]));
    if (cmd === 'diff') return output(svc.diff(args[1],args[2]));
    if (cmd === 'case' && args[1] === 'show') return output(svc.showCase(args[2]));
    if (cmd === 'case' && args[1] === 'close') { svc.closeCase(args[2]); return output({ closed: args[2] }); }
    if (cmd === 'thesis' && args[1] === 'successor') return output(svc.successor(args[2],fileJson(flag('file')) as any,new Date().toISOString()));
    if (cmd === 'position' && args[1] === 'record') return output(svc.recordPosition(fileJson(flag('file')) as PositionRecord));
    if (cmd === 'position' && args[1] === 'event') return output(svc.appendPositionEvent(args[2],fileJson(flag('file')) as PositionEvent));
    if (cmd === 'journal') { svc.journal(args[1],String(flag('text') ?? '')); return output({ saved: true }); }
    if (cmd === 'backup') return output(await svc.backup(args[1]));
    throw new Error('USAGE: analyze <address> --chain <chain> [--bundle file] | reassess <case-id> --bundle file | show/replay <snapshot-id> | diff <a> <b> | position record/event | capabilities | profile options | doctor | market probe <chain> <address>');
  } finally { svc.close(); }
}
main().catch(fail);
