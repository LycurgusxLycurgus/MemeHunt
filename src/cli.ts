#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { collectLiveToken } from './app/live.js';
import { guideConfig, guideThesis, loadConfig, materializeThesis, presetDescription, saveConfig, starterConfig, validateConfig, validateThesis, type Ask } from './app/config.js';
import { renderSnapshot } from './app/report.js';
import { validateResearch } from './domain/baseline.js';
import { Service, decisionHash as ServiceHash } from './app/service.js';
import {
  bundleSchema,
  profileSchema,
  tokenRefSchema,
  type Bundle,
  type PositionEvent,
  type PositionRecord,
  type Profile,
  type TokenRef,
} from './domain/contracts.js';
import { probeDexScreener } from './providers/dexscreener.js';
import { decodeSolanaAddress, inspectSolanaRpc } from './providers/solana.js';

type CliRuntime = {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  isInteractive?: boolean;
  confirmFull?: (prompt: string) => Promise<boolean>;
  ask?: Ask;
};

class CliError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(code); }
}

const flagValue = (args: string[], name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const hasFlag = (args: string[], name: string) => args.includes(`--${name}`);
const fileJson = (path: string | undefined) => {
  if (!path) throw new Error('FILE_REQUIRED');
  const bytes = readFileSync(path);
  if (bytes.byteLength > 2_000_000) throw new Error('FILE_TOO_LARGE');
  return JSON.parse(bytes.toString('utf8')) as unknown;
};
const knownErrorCodes = new Set([
  'FILE_REQUIRED', 'FILE_TOO_LARGE', 'STORAGE_ERROR', 'COMMAND_FAILED', 'USAGE',
  'INVALID_TOKEN_REF', 'INVALID_SOLANA_ADDRESS', 'INVALID_EVM_ADDRESS', 'INVALID_PROFILE',
  'LIVE_IMPORT_FORBIDDEN', 'PROFILE_ONLY_FOR_LIVE', 'ADDRESS_BUNDLE_MISMATCH', 'CHAIN_BUNDLE_MISMATCH',
  'BUNDLE_OR_ADDRESS_AND_CHAIN_REQUIRED', 'REASSESS_BUNDLE_REQUIRED', 'MANUAL_EMPTY_MUST_BE_EMPTY', 'BUNDLE_LIMIT', 'DUPLICATE_BUNDLE_ID',
  'FUTURE_EVIDENCE', 'UNREFERENCED_ARTIFACT', 'RAW_ARTIFACT_REQUIRED', 'ARTIFACT_HASH_OR_SIZE',
  'IMPORT_PROVENANCE_FORGED', 'LIVE_PROVENANCE_INVALID', 'UNKNOWN_EVIDENCE_REF', 'FUTURE_FEATURE',
  'INVALID_OBSERVATION_REF', 'FUTURE_OBSERVATION', 'UNKNOWN_SEMANTIC_REF', 'PASS_REQUIRES_FROZEN_THESIS',
  'CASE_NOT_FOUND', 'TOKEN_CASE_MISMATCH', 'NO_ACTIVE_THESIS', 'NO_THESIS_AT_CUTOFF',
  'INVALID_EPISODE_TIMELINE', 'EPISODE_NOT_FOUND', 'SNAPSHOT_NOT_FOUND', 'SNAPSHOT_HASH_MISMATCH',
  'REPLAY_RESULT_MISMATCH', 'POSITION_NOT_FOUND', 'POSITION_ALREADY_EXISTS', 'IDEMPOTENCY_CONFLICT',
  'JOURNAL_LIMIT', 'BACKUP_TARGET_EXISTS', 'SUCCESSOR_PLAN_BASIS_REQUIRED', 'EXIT_PROOFS_REQUIRE_REASSESSMENT', 'FUTURE_EXIT_PROOF', 'INVALID_SUCCESSOR_TIME', 'SUCCESSOR_TIME_NOT_AFTER_PREDECESSOR',
  'PROVIDER_EMPTY_RESPONSE', 'INVALID_SEMANTIC_PACKET', 'HOSTED_SEMANTIC_DISABLED', 'GEMINI_KEY_MISSING',
  'GEMINI_JSON', 'DEX_SHAPE', 'NONFINITE_NUMBER', 'UNSERIALIZABLE_VALUE', 'PREDICATE_TYPE',
  'PREDICATE_NUMBER', 'PREDICATE_LIMIT', 'PREDICATE_EMPTY', 'PREDICATE_SHAPE', 'PREDICATE_UNIT',
  'UNIT_MISMATCH', 'INVALID_ATOMIC_QUANTITY', 'INVALID_QUOTE_AMOUNT', 'INVALID_DECIMALS', 'INVALID_CUTOFF',
  'DUPLICATE_EVENT_ID', 'DUPLICATE_EVENT', 'INVALID_EVENT_TIME', 'INVALID_CORRECTION_REFERENCE',
  'CORRECTION_BEFORE_ORIGINAL', 'EVENT_BEFORE_ENTRY', 'ZERO_BUY', 'OVERSELL', 'OVERSELL_FEE',
  'TRANSFER_COST_REQUIRES_BUY', 'OVERSELL_TRANSFER', 'TRANSFER_DIRECTION_REQUIRED',
  'ANALYSIS_MODES_CONFLICT', 'MODE_FLAG_ONLY_FOR_LIVE',
  'INVALID_CONFIG','CONFIG_EXISTS','CONFIG_NOT_FOUND','CONFIG_CANCELLED','CHECK_NOT_FOUND','CHAIN_SELECTION_REQUIRED','INVALID_ASSESSMENT_DETAILS','UNQUALIFIED_STAGE_INPUT','UNSUPPORTED_SNAPSHOT_VERSION','RESEARCH_TOKEN_MISMATCH','RESEARCH_DUPLICATE','RESEARCH_CITATION','RESEARCH_TIME_OR_BINDING','RESEARCH_LINEAGE','RESEARCH_WINDOW',
  'RESEARCH_EXISTS','RESEARCH_HASH_MISMATCH',
]);
const safeCode = (error: unknown) => {
  const raw = error instanceof Error ? error.message : '';
  if (knownErrorCodes.has(raw)) return raw;
  if (/^(?:RPC|DEX|WEB_SEARCH|WEB_FETCH|GEMINI)_HTTP_\d{3}$/.test(raw)) return raw;
  if (/SQLITE|database|EACCES|ENOENT/i.test(raw)) return 'STORAGE_ERROR';
  return 'COMMAND_FAILED';
};
const safeExitCode = (error: unknown) => {
  const raw = error instanceof Error ? error.message : '';
  return /NOT_FOUND/.test(raw) ? 4 : /SQLITE|database|EACCES|ENOENT/i.test(raw) ? 3 : 2;
};
const secureKeySetup = {
  TINYFISH_API_KEY: "$env:TINYFISH_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'TinyFish API key' -AsSecureString)).Password",
  GEMINI_API_KEY: "$env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Gemini API key' -AsSecureString)).Password",
};
const missingFullPassKeys = (env: NodeJS.ProcessEnv) => [
  ...(!env.TINYFISH_API_KEY ? ['TINYFISH_API_KEY'] : []),
  ...(!env.GEMINI_API_KEY ? ['GEMINI_API_KEY'] : []),
];
const keySetupInstructions = (missing: string[]) => missing.map(name => secureKeySetup[name as keyof typeof secureKeySetup]).join('\n');
const localKeySetup = 'From the project root, copy .env.example to .env and enter both keys there, or set them in this PowerShell session:';
const fullPassApprovalPrompt = 'TinyFish and Gemini calls may consume quota or incur charges depending on your account tier. Confirm provider access and billing before continuing. Run the full available-source pass now? [y/N] ';
async function confirmFullPass(prompt: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(prompt);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally { readline.close(); }
}
async function askInput(prompt:string):Promise<string|undefined>{const readline=createInterface({input:process.stdin,output:process.stderr});try{return await readline.question(prompt);}finally{readline.close();}}
const parseToken = (value: unknown): TokenRef => {
  const parsed = tokenRefSchema.safeParse(value);
  if (!parsed.success) throw new Error('INVALID_TOKEN_REF');
  return parsed.data;
};
const readBundle = (path: string | undefined): Bundle => {
  const input = fileJson(path);
  if (typeof input === 'object' && input !== null && 'analysisKind' in input && input.analysisKind === 'LIVE') {
    throw new Error('LIVE_IMPORT_FORBIDDEN');
  }
  return bundleSchema.parse(input);
};
const unconfiguredLiveProfile: Profile = { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } };
const rpcRecovery = (code: string): string => {
  const reason = code === 'RPC_NETWORK_ACCESS_DENIED' ? 'Network access was denied; check sandbox/firewall permissions.'
    : code === 'RPC_DNS_ERROR' ? 'The RPC hostname could not be resolved; check DNS and endpoint configuration.'
    : code === 'RPC_TIMEOUT' ? 'The bounded RPC request timed out; connectivity or the public endpoint may be temporarily unavailable.'
    : code === 'RPC_HTTP_401' || code === 'RPC_HTTP_403' ? 'The endpoint rejected access; check RPC credentials and provider permissions.'
    : code === 'RPC_HTTP_429' ? 'The endpoint rate limited the request; check provider quota or try again later.'
    : 'The RPC request failed; check connectivity and provider access.';
  return `${code}: ${reason} Run doctor --network to check mainnet connectivity. If needed, set SOLANA_RPC_URL securely in .env or the process environment to an operator-selected mainnet endpoint, then run a new analysis.\n`;
};

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  if(argv[0]&&!['analyze','reassess','help','profile','config','research','doctor','market','show','explain','replay','diff','case','thesis','position','journal','backup','capabilities'].includes(argv[0])&&!argv[0].startsWith('-'))argv=['analyze',...argv];
  const env = runtime.env ?? process.env;
  const stdout = runtime.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = runtime.stderr ?? ((text: string) => { process.stderr.write(text); });
  const output = (value: unknown) => {
    if(!hasFlag(argv,'json')&&typeof value==='object'&&value!==null&&'checklistKind' in value&&'id' in value){
      let snapshot=value as ReturnType<Service['show']>;
      const selected=flagValue(argv,'checklist');
      if(selected==='management'&&snapshot.checklistKind==='ENTRY')throw new CliError('MANAGEMENT_NOT_STARTED','This snapshot is an entry assessment. Management begins only after an eligible entry saves a thesis.');
      if(selected==='entry'&&snapshot.checklistKind==='MANAGEMENT'&&service)snapshot=service.show(snapshot.baselineSnapshotId);
      stdout(renderSnapshot(snapshot,{details:snapshot.details??service?.frozenDetails(snapshot.id),checklist:hasFlag(argv,'checklist'),check:flagValue(argv,'check'),evidence:hasFlag(argv,'evidence')}));
    }
    else stdout(`${JSON.stringify(value)}\n`);
  };
  const cmd = argv[0];
  const configPath=flagValue(argv,'config')??join(dirname(flagValue(argv,'db')??'.data/dd.sqlite'),'config.json');
  const interactive=runtime.isInteractive??(!!process.stdin.isTTY&&!!process.stderr.isTTY);
  let service: Service | undefined;
  try {
    for(const name of ['config','db','profile','thesis','research','bundle','chain','file','check','text'])if(hasFlag(argv,name)&&(!flagValue(argv,name)||flagValue(argv,name)!.startsWith('--')))throw new CliError('FLAG_VALUE_REQUIRED',`--${name} requires a value.`);
    const requestedChecklist=flagValue(argv,'checklist');
    if(requestedChecklist&&!requestedChecklist.startsWith('--')&&!['entry','management'].includes(requestedChecklist))throw new CliError('INVALID_CHECKLIST','Choose entry or management.');
    if (cmd === 'capabilities') {
      output({
        chains: ['solana', 'bsc', 'base', 'robinhood'],
        liveSolana: { rpc: true, dex: true },
        liveMarketDiagnostic: ['solana', 'bsc', 'base', 'robinhood'],
        certifiedVenues: [],
        semanticHosted: 'two-pass automated attention source qualification; requires --full or interactive y/yes; retained sources, strict citations and scoped code-derived sample metrics; not verified real-world truth',
        execution: false,
      });
      return 0;
    }
    if (cmd === 'help' || argv.includes('--help')) {
      output({
        usage: 'analyze <CA> [--full | --partial] [--advisory] [--json]; bare <CA> is an alias. Solana is inferred only from a valid key; EVM needs --chain or saved defaultChain.',
        advisory: 'Opt-in bounded public Solana movement/history, completed market/macro candles, chain DEX activity and paid visibility. Group PASS means complete measurement coverage, not favorable investment quality.',
        full: 'Runs bounded TinyFish Search/Fetch and Gemini extraction; requires both TINYFISH_API_KEY and GEMINI_API_KEY from the environment or local .env. --full is explicit approval for this run.',
        partial: 'Runs Solana RPC and DEX collection only; use --partial to request it explicitly.',
        interactive: 'Without a mode flag, an interactive run asks for y/yes before hosted providers; any other answer cancels without saving.',
        other: 'Use --bundle for offline fixture/import analysis; reassess requires --bundle.',
        networkCheck: 'doctor --network makes one bounded mainnet RPC check; no database, account lookup, or hosted providers. Plain doctor stays offline.',
        localEnvSetup: 'From the project root, copy .env.example to .env and enter both keys. Existing process variables take precedence.',
        securePowerShellSetup: secureKeySetup,
        note: 'DD_ENABLE_HOSTED_SEMANTIC does not authorize a provider call; approval is per analysis run.',
      });
      return 0;
    }
    if (cmd === 'profile' && argv[1] === 'options') {
      output({ default:starterConfig(),guidance:presetDescription,profileFields:['sizeUsd','horizonSeconds','risk','stage.ageBands'],thesisFields:['support','invalidation','catalyst','expiryAt','onchainTraction','externalTraction','warning','legs'],edit:'config init --overwrite',calibrated:false });
      return 0;
    }
    if(cmd==='config'){
      const action=argv[1];
      if(action==='init'){
        let config=flagValue(argv,'file')?validateConfig(fileJson(flagValue(argv,'file'))):starterConfig();
        if(!flagValue(argv,'file')&&interactive){stderr(presetDescription+'\n');const guided=await guideConfig(runtime.ask??askInput,loadConfig(configPath)??config);if(!guided)throw new Error('CONFIG_CANCELLED');config=guided;}
        const saved=saveConfig(configPath,config,hasFlag(argv,'overwrite'));if(hasFlag(argv,'json'))output(saved);else stdout(`Settings saved to ${configPath}\nScenario: $${saved.profile.sizeUsd??'unset'}, ${(saved.profile.horizonSeconds??0)/3600} hours\nRisk limits: ${JSON.stringify(saved.profile.risk)}\nUncalibrated screening settings; friction is not a price stop.\nChange settings: config init --overwrite\n`);
      }else if(action==='thesis'){
        if(!interactive)throw new CliError('INTERACTIVE_CONFIGURATION_REQUIRED','Use config init --file for scripted configuration.');
        const config=loadConfig(configPath)??starterConfig();const thesis=await guideThesis(runtime.ask??askInput,config.profile,(runtime.now??(()=>new Date().toISOString()))(),config.thesisTemplate);if(!thesis)throw new Error('CONFIG_CANCELLED');
        config.thesisTemplate=thesis;config.thesisExpiryMode='HORIZON';saveConfig(configPath,config,true);stdout('Thesis template saved. Expiry is the selected horizon from each initial entry; an active episode remains frozen.\n');
      }else if(action==='show'||action==='validate'){
        const config=loadConfig(configPath);if(!config)throw new Error('CONFIG_NOT_FOUND');if(hasFlag(argv,'json'))output(config);else stdout(`${action==='validate'?'Configuration valid':'Saved configuration'}: ${configPath}\nScenario $${config.profile.sizeUsd??'unset'}, ${(config.profile.horizonSeconds??0)/3600} hours\n${JSON.stringify(config.profile.risk,null,2)}\nThesis template: ${config.thesisTemplate?'specified':'starter; traction/realization incomplete'}\n`);
      }else throw new Error('USAGE');
      return 0;
    }
    if(cmd==='research'&&argv[1]==='import'){
      const raw=fileJson(argv[2]);const supplied=typeof raw==='object'&&raw!==null&&'token' in raw?parseToken(raw.token):undefined;if(!supplied)throw new Error('INVALID_TOKEN_REF');
      if(supplied.chain==='solana')decodeSolanaAddress(supplied.address);else if(!/^0x[a-fA-F0-9]{40}$/.test(supplied.address))throw new Error('INVALID_EVM_ADDRESS');
      const packet=validateResearch(raw,supplied,(runtime.now??(()=>new Date().toISOString()))());
      const directory=join(dirname(configPath),'research'),path=join(directory,`${supplied.chain}-${supplied.chain==='solana'?supplied.address:supplied.address.toLowerCase()}.json`);mkdirSync(directory,{recursive:true});
      if(existsSync(path)&&!hasFlag(argv,'overwrite'))throw new Error('RESEARCH_EXISTS');
      const temp=join(directory,`.${randomUUID()}.tmp`);try{writeFileSync(temp,JSON.stringify({hash:ServiceHash(packet),packet}),{flag:'wx',mode:0o600});renameSync(temp,path);}finally{rmSync(temp,{force:true});}
      stdout(hasFlag(argv,'json')?JSON.stringify({saved:true,token:supplied,hash:ServiceHash(packet)})+'\n':`Reviewed evidence saved for ${supplied.chain} ${supplied.address}. Future CA analyses reuse it with USER_IMPORT provenance.\n`);return 0;
    }
    if (cmd === 'doctor') {
      const missing = missingFullPassKeys(env);
      const rpc = hasFlag(argv, 'network') ? await inspectSolanaRpc(env.SOLANA_RPC_URL, runtime.fetcher ?? fetch) : undefined;
      output({
        node: process.version,
        sqlite: true,
        dataFile: flagValue(argv, 'db') ?? '.data/dd.sqlite',
        solanaRpcUrlConfigured: !!env.SOLANA_RPC_URL,
        ...(rpc ? { rpcNetwork: { state: rpc.status, ...(rpc.code ? { code: rpc.code } : {}) } } : {}),
        networkCheck: 'Use doctor --network for one mainnet RPC connectivity check; no snapshot or hosted calls.',
        tinyfishKeyPresent: !!env.TINYFISH_API_KEY,
        geminiKeyPresent: !!env.GEMINI_API_KEY,
        fullPassKeysPresent: missing.length === 0,
        fullPassMissingKeys: missing,
        fullPassApproval: '--full or interactive y/yes per analysis run',
        fullPassAccountStatus: 'not checked; verify TinyFish Search/Fetch access and Gemini Free-tier quota',
        securePowerShellSetup: secureKeySetup,
        legacySemanticFlagPresentButNotAuthorizing: env.DD_ENABLE_HOSTED_SEMANTIC === '1',
        warning: 'No live venue certification or strategy calibration has been performed',
      });
      return rpc && rpc.status !== 'OBSERVED' ? 1 : 0;
    }
    if (cmd === 'market' && argv[1] === 'probe') {
      output(await probeDexScreener(argv[2] ?? '', argv[3] ?? ''));
      return 0;
    }

    if (cmd === 'analyze' || cmd === 'reassess') {
      const bundlePath = flagValue(argv, 'bundle');
      const hasBundle = hasFlag(argv, 'bundle');
      const profilePath = flagValue(argv, 'profile');
      const hasProfile = hasFlag(argv, 'profile');
      const fullRequested = hasFlag(argv, 'full');
      const partialRequested = hasFlag(argv, 'partial');
      if (fullRequested && partialRequested) throw new Error('ANALYSIS_MODES_CONFLICT');
      if ((fullRequested || partialRequested) && (cmd === 'reassess' || hasBundle)) throw new Error('MODE_FLAG_ONLY_FOR_LIVE');
      if (hasProfile && (cmd === 'reassess' || hasBundle)) throw new Error('PROFILE_ONLY_FOR_LIVE');

      let result: unknown;
      if (hasBundle) {
        const bundle = readBundle(bundlePath);
        if(flagValue(argv,'research')){
          if(bundle.analysisKind!=='USER_IMPORT')throw new Error('RESEARCH_ONLY_FOR_USER_IMPORT');
          const packet=validateResearch(fileJson(flagValue(argv,'research')),bundle.token,bundle.cutoff),raw=JSON.stringify(packet);
          if(bundle.evidence.some(e=>e.id==='curated-research'))throw new Error('DUPLICATE_BUNDLE_ID');
          bundle.rawArtifacts={...bundle.rawArtifacts,'curated-research':raw};bundle.evidence.push({id:'curated-research',sourceId:'curated-research',sourceType:'REVIEWED_CORPUS',retrievedAt:bundle.cutoff,availableAt:bundle.cutoff,contentHash:createHash('sha256').update(raw).digest('hex'),adapterVersion:'research-v1',accessMode:'USER_IMPORT',scope:{qualification:'human-adjudication-v1'}});
        }
        if (cmd === 'analyze') {
          if (argv[1] && argv[1] !== bundle.token.address) throw new Error('ADDRESS_BUNDLE_MISMATCH');
          if (flagValue(argv, 'chain') && flagValue(argv, 'chain') !== bundle.token.chain) throw new Error('CHAIN_BUNDLE_MISMATCH');
          service = new Service(flagValue(argv, 'db'));
          const prior = service.caseFor(bundle.token);
          result = prior?.status === 'THESIS_TRACKED' && !hasFlag(argv, 'entry')
            ? service.reassess(prior.id, bundle)
            : service.analyze(bundle);
        } else {
          service = new Service(flagValue(argv, 'db'));
          result = service.reassess(argv[1] ?? '', bundle);
        }
        output(result);
        return 0;
      }

      if (cmd === 'reassess') throw new Error('REASSESS_BUNDLE_REQUIRED');
      if (!argv[1]) throw new Error('BUNDLE_OR_ADDRESS_AND_CHAIN_REQUIRED');
      const saved=loadConfig(configPath);
      let chain=flagValue(argv,'chain');
      if(!chain){
        if(/^0x[a-fA-F0-9]{40}$/.test(argv[1])){
          chain=saved?.defaultChain;
          if(!chain&&interactive)chain=(await (runtime.ask??askInput)('Which chain is this address on? bsc / base / robinhood: '))?.trim();
          if(!chain||chain==='solana')throw new Error('CHAIN_SELECTION_REQUIRED');
        }else {decodeSolanaAddress(argv[1]);chain='solana';}
      }
      const token = parseToken({ chain, address:chain==='solana'?argv[1]:argv[1].toLowerCase() });
      {
        if(token.chain==='solana')decodeSolanaAddress(token.address);else if(!/^0x[a-f0-9]{40}$/.test(token.address))throw new Error('INVALID_EVM_ADDRESS');
        const parsedProfile = hasProfile ? profileSchema.safeParse(fileJson(profilePath)) : undefined;
        if (parsedProfile && !parsedProfile.success) throw new Error('INVALID_PROFILE');
        let profile = parsedProfile?.success ? parsedProfile.data : saved?.profile??starterConfig().profile;
        const explicitThesis=flagValue(argv,'thesis')?validateThesis(fileJson(flagValue(argv,'thesis'))):undefined;
        const researchPath=flagValue(argv,'research'),storedResearchPath=join(dirname(configPath),'research',`${token.chain}-${token.address}.json`);
        let researchInput=researchPath?fileJson(researchPath):undefined;
        if(!researchPath&&existsSync(storedResearchPath)){const stored=fileJson(storedResearchPath) as {hash:string;packet:unknown};if(ServiceHash(stored.packet)!==stored.hash)throw new Error('RESEARCH_HASH_MISMATCH');researchInput=stored.packet;}
        const research=researchInput?validateResearch(researchInput,token,(runtime.now??(()=>new Date().toISOString()))()):undefined;
        let fullApproved = fullRequested;
        if (fullRequested || (!partialRequested && interactive)) {
          const missing = missingFullPassKeys(env);
          if (missing.length) {
            throw new CliError('FULL_PASS_KEYS_MISSING', [
              `Full available-source pass requires both TINYFISH_API_KEY and GEMINI_API_KEY. Missing: ${missing.join(', ')}.`,
              localKeySetup, keySetupInstructions(missing),
              'After verifying provider access and Gemini quota, rerun with --full; use --partial for RPC+DEX only.',
            ].join('\n'));
          }
          if (!fullRequested) {
            stderr('FULL_AVAILABLE_SOURCE_PASS: TinyFish Search/Fetch and Gemini will receive bounded public evidence. Both provider keys are present; approval is required for this run.\n');
            const confirmed = await (runtime.confirmFull ?? confirmFullPass)(fullPassApprovalPrompt);
            if (!confirmed) {
              throw new CliError('FULL_PASS_DECLINED', 'No collection was started or saved. Rerun with --partial for an explicit RPC+DEX pass.');
            }
            fullApproved = true;
          }
        } else if (!partialRequested) {
          const missing = missingFullPassKeys(env);
          throw new CliError('EXPLICIT_ANALYSIS_MODE_REQUIRED', [
            'This non-interactive analysis needs an explicit mode. Use --full for the full available-source pass, or --partial for RPC+DEX only.',
            ...(missing.length ? [`Full mode is missing: ${missing.join(', ')}.`, localKeySetup, keySetupInstructions(missing)] : []),
          ].join('\n'));
        }
        if (partialRequested) stderr('PARTIAL_MODE: collecting RPC and DEX evidence only; TinyFish and Gemini are skipped.\n');
        if (fullRequested) stderr('FULL_MODE: --full explicitly approves TinyFish Search/Fetch and Gemini for this analysis.\n');
        if(!saved&&!hasProfile){
          let initial=starterConfig();
          if(interactive){stderr(presetDescription+'\n');const guided=await guideConfig(runtime.ask??askInput,initial);if(!guided)throw new Error('CONFIG_CANCELLED');initial=guided;}
          if(token.chain!=='solana')initial.defaultChain=token.chain;
          saveConfig(configPath,initial);profile=initial.profile;stderr(`SETTINGS_SAVED: ${configPath}. ${presetDescription}\n`);
        }
        service=new Service(flagValue(argv,'db'));
        const prior=service.caseFor(token);
        const active=prior?.status==='THESIS_TRACKED'&&prior.episodeId&&!hasFlag(argv,'entry')?service.episode(prior.episodeId):undefined;
        if(active&&explicitThesis)stderr('FROZEN_THESIS: management uses the saved episode. Use thesis successor to change it explicitly.\n');
        const live = await collectLiveToken(token, {
          profile,
          advisoryEnabled:hasFlag(argv,'advisory'),
          ...(active?{thesis:active.thesis}:explicitThesis?{thesis:explicitThesis}:saved?.thesisTemplate?{thesis:saved.thesisTemplate,thesisExpiryMode:saved.thesisExpiryMode}:{}),
          ...(research?{research}:{}),origins:{profile:hasProfile?'ARGUMENT':saved?'SAVED_DEFAULT':'USER_REQUESTED_PRESET'},
          ...(env.SOLANA_RPC_URL ? { rpcUrl: env.SOLANA_RPC_URL } : {}),
          ...(fullApproved ? { tinyfishKey: env.TINYFISH_API_KEY!, geminiKey: env.GEMINI_API_KEY! } : {}),
          semanticEnabled: fullApproved,
          fetcher: runtime.fetcher ?? fetch,
          ...(runtime.now ? { now: runtime.now } : {}),
        });
        if (live.collection.rpc.state === 'UNAVAILABLE') stderr(token.chain==='solana'?rpcRecovery(live.collection.rpc.code ?? 'RPC_TRANSPORT'):'EVM_READER_UNIMPLEMENTED: market and reviewed evidence are collected, but direct chain controls remain unknown.\n');
        const snapshot = prior?.status === 'THESIS_TRACKED' && !hasFlag(argv, 'entry')
          ? service.reassessLive(prior.id, live)
          : service.analyzeLive(live);
        result = snapshot;
        if (snapshot.checklistKind === 'ENTRY' && snapshot.result.classification === 'INSUFFICIENT_DATA') {
          stderr(`INSUFFICIENT_DATA: ${snapshot.result.coverage.known}/${snapshot.result.coverage.total} required checks are known. Observations, pairs, pages and semantic candidate claims do not verify the remaining checks. Inspect result.checks and run profile options for missing user choices. This is missing evidence, not a detected-rug verdict.\n`);
        }
      }
      output(result);
      return 0;
    }

    if (cmd === 'show' || cmd === 'explain') { service = new Service(flagValue(argv, 'db')); output(service.show(argv[1] ?? '')); return 0; }
    if (cmd === 'replay') { service = new Service(flagValue(argv, 'db')); output(service.replay(argv[1] ?? '')); return 0; }
    if (cmd === 'diff') { service = new Service(flagValue(argv, 'db')); output(service.diff(argv[1] ?? '', argv[2] ?? '')); return 0; }
    if (cmd === 'case' && argv[1] === 'show') { service = new Service(flagValue(argv, 'db')); output(service.showCase(argv[2] ?? '')); return 0; }
    if (cmd === 'case' && argv[1] === 'close') { service = new Service(flagValue(argv, 'db')); service.closeCase(argv[2] ?? ''); output({ closed: argv[2] }); return 0; }
    if (cmd === 'thesis' && argv[1] === 'successor') { service = new Service(flagValue(argv, 'db')); output(service.successor(argv[2] ?? '', fileJson(flagValue(argv, 'file')) as any, (runtime.now ?? (() => new Date().toISOString()))(), ({continue:'CONTINUE','fresh-start':'FRESH_START'} as const)[flagValue(argv,'basis') as 'continue'|'fresh-start'])); return 0; }
    if (cmd === 'position' && argv[1] === 'record') { service = new Service(flagValue(argv, 'db')); output(service.recordPosition(fileJson(flagValue(argv, 'file')) as PositionRecord)); return 0; }
    if (cmd === 'position' && argv[1] === 'event') { service = new Service(flagValue(argv, 'db')); output(service.appendPositionEvent(argv[2] ?? '', fileJson(flagValue(argv, 'file')) as PositionEvent)); return 0; }
    if (cmd === 'journal') { service = new Service(flagValue(argv, 'db')); service.journal(argv[1] ?? '', String(flagValue(argv, 'text') ?? '')); output({ saved: true }); return 0; }
    if (cmd === 'backup') { service = new Service(flagValue(argv, 'db')); output(await service.backup(argv[1] ?? '')); return 0; }
    throw new Error('USAGE: analyze <address> --chain <chain> [--bundle file | --profile file] | reassess <case-id> --bundle file | show/replay <snapshot-id> | diff <a> <b> | position record/event | capabilities | profile options | doctor | market probe solana <address>');
  } catch (error) {
    if (error instanceof CliError) stderr(`${error.code}: ${error.detail ?? ''}\n`);
    else stderr(`${safeCode(error)}\n`);
    return safeExitCode(error);
  } finally {
    service?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const envPath = resolve(process.cwd(), '.env');
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    const keepAlive=setInterval(()=>{},1000);
    try { process.exitCode=await runCli(process.argv.slice(2)); } finally { clearInterval(keepAlive); }
  } catch {
    process.stderr.write('ENV_FILE_ERROR: Could not load the local .env file.\n');
    process.exitCode = 2;
  }
}
