#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createLocalSemanticExecutor } from './providers/local-semantic-executor.js';
import type { SemanticExecutor } from './providers/executor-semantic.js';
import { collectLiveToken } from './app/live.js';
import { A29_V2_SOURCE_BYTES } from './app/advisory.js';
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
import { collectIndexedCreatorPosition,replayIndexedCreatorPosition } from './providers/indexed-creator-position.js';
import { probeDexScreener } from './providers/dexscreener.js';
import { decodeSolanaAddress, inspectSolanaRpc } from './providers/solana.js';

type CliRuntime = {
  semanticExecutor?:SemanticExecutor;
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
/** The A24 capture is retained byte-exact, so it has its own text reader and ceiling; every other file keeps the 2 MB JSON reader. */
const A24_CAPTURE_BYTES = 8_388_608;
const captureText = (path: string | undefined) => {
  if (!path) throw new Error('FILE_REQUIRED');
  const bytes = readFileSync(path);
  if (bytes.byteLength > A24_CAPTURE_BYTES) throw new Error('FILE_TOO_LARGE');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('A24_CAPTURE_INVALID'); }
};
/** Reads one A29 capture as exact UTF-8 bytes under the 128 MB v2 input cap, checked by stat before allocation; v1 keeps its 24 MB cap at method dispatch. It is never parsed and re-serialized here because its bytes are hashed. */
const readA29Capture = (path: string) => {
  if (statSync(path).size > A29_V2_SOURCE_BYTES) throw new CliError('A29_CAPTURE_TOO_LARGE', 'The A29 capture exceeds the 128 MB input cap.');
  const bytes = readFileSync(path);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new CliError('A29_CAPTURE_INVALID', 'The A29 capture is not exact UTF-8.'); }
};
/** Recorded caller history owns a separate strict UTF-8 ingress; other file readers retain their ceilings. */
const readRecordedCapture = (path:string,invalidCode:string) => {
  if(statSync(path).size>8_388_608)throw new Error('FILE_TOO_LARGE');
  const bytes=readFileSync(path);
  if(bytes.length>8_388_608)throw new Error('FILE_TOO_LARGE');
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error(invalidCode);}
};
const knownErrorCodes = new Set([
  'O28_RPC_ERRORS_REQUIRED', 'HISTORICAL_TOPIC_REUSE_REQUIRED', 'O30_ADVISORY_REQUIRED', 'O28_ADVISORY_REQUIRED', 'O28_PRIOR_POOL_MISMATCH', 'FILE_REQUIRED', 'FILE_TOO_LARGE', 'STORAGE_ERROR', 'COMMAND_FAILED', 'USAGE',
  'INVALID_TOKEN_REF', 'INVALID_SOLANA_ADDRESS', 'INVALID_EVM_ADDRESS', 'INVALID_PROFILE',
  'CURVE_PROOF_INVALID', 'LIVE_IMPORT_FORBIDDEN', 'PROFILE_ONLY_FOR_LIVE', 'ADDRESS_BUNDLE_MISMATCH', 'CHAIN_BUNDLE_MISMATCH',
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
  'ROUTE_COST_PROOF_INVALID','ROUTE_IMPACT_PROOF_INVALID','SIMULATION_ROUTE_PROOF_INVALID','EXIT_ROUTE_PROOF_INVALID','ENTRY_ROUTE_SOLANA_REQUIRED','ENTRY_ROUTE_MODE_REQUIRED','ENTRY_ROUTE_PROOF_INVALID','RESEARCH_EXISTS','RESEARCH_HASH_MISMATCH','ADVISORY_EXECUTOR_MODE_REQUIRED','RECORDED_INCENTIVE_ADVISORY_REQUIRED','RECORDED_INCENTIVE_CAPTURE_INVALID','CREATOR_ROLE_MODE_REQUIRED','RECORDED_CALLER_ADVISORY_REQUIRED','RECORDED_CALLER_CAPTURE_INVALID','A24_ADVISORY_REQUIRED','A24_CAPTURE_INVALID','A29_ADVISORY_REQUIRED','A29_CAPTURE_INVALID','A29_CAPTURE_TOO_LARGE','EXEC_LIQ_SOLANA_REQUIRED','EXEC_LIQ_PROOF_INVALID',
]);
const safeCode = (error: unknown) => {
  const raw = error instanceof Error ? error.message : '';
  if (knownErrorCodes.has(raw)) return raw;
  if (/^(?:RPC|DEX|WEB_SEARCH|WEB_FETCH|GEMINI)_HTTP_\d{3}$/.test(raw)) return raw;
  if (/^EXEC_LIQ_PROOF_INVALID:[A-Z][A-Z0-9_]{0,63}$/.test(raw)) return raw;
  if (/^C12_(?:BRIDGE|NATIVE)_[A-Z0-9_]{1,100}$/.test(raw)||raw==='C09_MARKET_CONTEXT_MODE_REQUIRED') return raw;
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
  const local:Record<string,string>={LIVE_PHASE_DEADLINE:'The final acquisition phase reached its deadline.',LIVE_HARD_DEADLINE:'The analysis reached its whole-run deadline.',LIVE_OPERATION_LIMIT:'The analysis exhausted its reserved request capacity.',LIVE_CALLER_CANCELLED:'The caller cancelled this analysis.',LIVE_DEPENDENCY_SKIPPED:'A required acquisition dependency did not complete.'};
  if(local[code])return `${code}: ${local[code]} This is an analysis execution limit; it does not establish an RPC endpoint outage or an adverse token fact. Inspect the saved stage receipt and rerun after resolving the named cause.\n`;
  const reason = code === 'RPC_NETWORK_ACCESS_DENIED' ? 'Network access was denied; check sandbox/firewall permissions.'
    : code === 'RPC_DNS_ERROR' ? 'The RPC hostname could not be resolved; check DNS and endpoint configuration.'
    : code === 'RPC_TIMEOUT' ? 'The bounded RPC request timed out; connectivity or the public endpoint may be temporarily unavailable.'
    : code === 'RPC_HTTP_401' || code === 'RPC_HTTP_403' ? 'The endpoint rejected access; check RPC credentials and provider permissions.'
    : code === 'RPC_HTTP_429' ? 'The endpoint rate limited the request; check provider quota or try again later.'
    : 'The RPC request failed; check connectivity and provider access.';
  return `${code}: ${reason} Run doctor --network to check mainnet connectivity. If needed, set SOLANA_RPC_URL securely in .env or the process environment to an operator-selected mainnet endpoint, then run a new analysis.\n`;
};

export async function runCli(argv: string[], runtime: CliRuntime = {}): Promise<number> {
  if(argv[0]&&!['creator-position','creator-position-replay','analyze','reassess','help','profile','config','research','doctor','market','show','explain','replay','diff','case','thesis','position','journal','backup','capabilities'].includes(argv[0])&&!argv[0].startsWith('-'))argv=['analyze',...argv];
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
    for(const name of ['s14-entry-capture','a27-marginal-capture','a26-buyer-post-capture','a25-lead-lag-capture','s15-reference-capture','a13-participation-capture','c12-bridge-capture','a30-fx-capture','config','db','profile','thesis','research','bundle','chain','file','check','text','a12-zero-witness-capture','native-attention-capture','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'])if(hasFlag(argv,name)&&(!flagValue(argv,name)||flagValue(argv,name)!.startsWith('--')))throw new CliError('FLAG_VALUE_REQUIRED',`--${name} requires a value.`);
    if(hasFlag(argv,'recorded-incentives-capture')&&(cmd!=='analyze'||hasFlag(argv,'bundle')))throw new CliError('RECORDED_INCENTIVE_ADVISORY_REQUIRED','Use --recorded-incentives-capture FILE with live --advisory analysis of a Solana address.');
    if(hasFlag(argv,'recorded-callers-capture')&&(cmd!=='analyze'||hasFlag(argv,'bundle')))throw new CliError('RECORDED_CALLER_ADVISORY_REQUIRED','Use --recorded-callers-capture FILE with live --advisory analysis of a Solana address.');
    if(hasFlag(argv,'executable-liquidity')&&(cmd!=='analyze'||hasFlag(argv,'bundle')))throw new CliError('EXEC_LIQ_SOLANA_REQUIRED','Use --executable-liquidity only with live analyze of a Solana address; bundles, reassess and other commands are not supported.');
    const requestedChecklist=flagValue(argv,'checklist');
    if(requestedChecklist&&!requestedChecklist.startsWith('--')&&!['entry','management'].includes(requestedChecklist))throw new CliError('INVALID_CHECKLIST','Choose entry or management.');
    if(cmd==='creator-position'||cmd==='creator-position-replay'){
      if(cmd==='creator-position-replay'){output(replayIndexedCreatorPosition(fileJson(flagValue(argv,'file'))));return 0;}
      const mint=argv[1];if(!mint||mint.startsWith('--'))throw new CliError('INVALID_SOLANA_ADDRESS','Provide a Solana mint.');
      if(!env.SOLANA_TRACKER_API_KEY)throw new CliError('SOLANA_TRACKER_KEY_MISSING','Configure SOLANA_TRACKER_API_KEY privately. This lookup reads provider-reported USD positions and opens no database.');
      output(await collectIndexedCreatorPosition(mint,env.SOLANA_TRACKER_API_KEY,runtime.fetcher??fetch,runtime.now));return 0;
    }
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
        usage: 'analyze <CA> [--full | --partial] [--advisory] [--creator-history | --creator-role-only] [--json]; bare <CA> is an alias. Solana is inferred only from a valid key; EVM needs --chain or saved defaultChain.',
        advisory: 'Opt-in bounded public Solana movement/history, completed market/macro candles, chain DEX activity and paid visibility. Group PASS means complete measurement coverage, not favorable investment quality.',
        wbtcCosts: '--wbtc-costs includes WBTC quotes, impacts and unsigned simulation, then reconciles O15/O16 using exact message fees, retained setup deposits and a separate SOL/USD reference. Selected no-tip plan only; no signing/broadcast or future-fill guarantee.',
        wbtcImpacts: '--wbtc-impacts includes WBTC entry and exit quotes, then measures fee-inclusive O13/O14 reference losses against the same pre-entry bank. Requested USD size and separate unspent WBTC follow existing definitions; no full-cost/simulation approval.',
        wbtcSimulate: '--wbtc-simulate includes WBTC entry and exit quotes and a read-only unsigned O12 roundtrip simulation using a verified public funded account. No signing/broadcast or full-cost/impact approval.',
        wbtcExit: '--wbtc-exit includes --wbtc-entry and independently quotes O11 for exactly its acquired quantity against the same pre-entry bank. No sequential execution, simulation, impact approval or full-cost proof.',
        wbtcEntry: '--wbtc-entry independently quotes O10 for an already verified canonical WBTC PumpSwap pool at the configured USD size. Ordinary funded WBTC account assumed; no wallet, exit, simulation or external-cost proof.',
        historicalTopicReuse: '--partial --advisory --advisory-executor --recorded-callers-capture FILE --historical-topic-reuse permits topic-only evidence reuse for an identical historical post under the same rubric. The fixed historical sample and current-corpus rejections stay explicit. Requires ordinary window mode and complete matching evidence.',
        o30RegistryAbsence: '--advisory --o28-expanded --o30-registry-absence enables fixed Jupiter legacy DCA registry absence over a complete verified WBTC pool-hour. WBTC registered calls stay unresolved; unregistered automation is unmeasured. Existing native v3/v4 windows retain the original flash-fill attribution, which may be positive; unsupported window versions remain unresolved.',
        a12ZeroWitnessCapture:'--partial --advisory --o28-expanded --a12-zero-witness-capture FILE identifies only target share zero from a qualified positive peer and a fresh common native bank; no complete catalog or measured total is claimed.',
        s14EntryCapture:'--partial --advisory --s14-entry-capture FILE imports a proven creator birth entry versus independently observed eligible calls for S14.',
        a27MarginalCapture:'--partial --advisory --a27-marginal-capture DIR imports complete historical marginal attention-efficiency components for A27.',
        a26BuyerPostCapture:'--partial --advisory --a26-buyer-post-capture DIR imports complete historical first-observed buyer/post components for A26.',
        a25LeadLagCapture:'--partial --advisory --a25-lead-lag-capture FILE imports a historical observed attention/price study with fixed lags, a null reference and uncertainty for A25.',
        s15ReferenceCapture:'--partial --advisory --s15-reference-capture FILE imports a source-bound historical creator target reference book for S15 with separately observed native cash and costs.',
        a13ParticipationCapture:'--partial --advisory --a13-participation-capture FILE imports a source-bound finite observed-peer participation vector for A13, preserving undefined zero-denominator results.',
        c09MarketContext:'--partial --advisory --c12-bridge-capture FILE --c09-market-context composes descriptive C11/C12/C15/C16 with separate coverage; no regime label.',
        c12BridgeCapture:'--partial --advisory --c12-bridge-capture FILE imports a complete all-asset Solana/Ethereum covered bridge census for C12 only.',
        a30FxCapture:'--partial --advisory --o28-expanded --a30-fx-capture DIRECTORY imports complete historical native demand and incoming FX sources for A30 only.',
        nativeAttentionCapture:'--partial --advisory --o28-expanded --native-attention-capture FILE imports a fresh native Codex/Claude qualification for A01/A02 only; source receipts and both executions are independently replayed.',
        o22HolderAgeCapture:'--partial --advisory --o28-expanded --o22-holder-age-capture DIRECTORY measures full historical holder-weighted observed-reference age over a fixed 24 hours; passive references are not wallet creation or signing.',
        o26AccountCapture:'--advisory --o28-expanded --o26-account-capture DIRECTORY measures complete historical inventory-return motifs for all observed user and protocol base-token endpoints; native quote units and legitimate arbitrage alternatives stay explicit.',
        o25LifetimeCapture:'--advisory --o28-expanded --o25-lifetime-capture DIRECTORY measures the complete source-bound creator lifetime vector under the empty-held profile; retained base/quote assets, unknown income basis and custody transfers stay explicit.',
        o24InventoryCapture: '--advisory --o28-expanded --o24-inventory-capture DIRECTORY measures O24 target-token base inventory only when complete source evidence proves no activity in the declared historical six hours. Retained source dates and wallet-account scope stay explicit; no quote, identity or trading authority.',
        o29ReservePath: '--advisory --o28-expanded --o23-bulk-capture DIRECTORY --o29-reserve-path derives the full historical quote-pool effective-reserve path. Exact curves and continuity are required; fixed-size depth, cohort anomaly and current vault balances remain unmeasured.',
        o23BulkCapture: '--advisory --o28-expanded --o23-bulk-capture DIRECTORY imports a complete fixed twelve-hour pool tape for the advisory fee-payer synchrony measurement. Original source dates and import trust stay explicit; this supplies no common-person or entry authority.',
        o28RpcErrors: '--advisory --o28-expanded --o28-rpc-errors accepts documented named RPC transaction failures in the selected-hour index. Failed rows remain excluded from committed flow; all coverage and resource limits stay unchanged. Use separately from O30 registry absence or historical-topic reuse.',
        o28Expanded: '--advisory --o28-expanded permits up to 2048 selected-hour transaction reads and 16 MB of stored O28 archives, with a ten-minute minimum run budget. Gaps remain unresolved; other pools and metrics retain their own scope.',
        full: 'Runs bounded TinyFish Search/Fetch and Gemini extraction; requires both TINYFISH_API_KEY and GEMINI_API_KEY from the environment or local .env. --full is explicit approval for this run.',
        partial: 'Runs Solana RPC and DEX collection only; use --partial to request it explicitly.',
        creatorPosition: 'creator-position <SOLANA_MINT> --json: provider-reported cross-venue USD position; requires SOLANA_TRACKER_API_KEY, opens no DB/config. Save JSON and use creator-position-replay --file PACKET --json offline. Not audited S15; SOL/stablecoins and unavailable histories can be missing.',
        recordedIncentivesCapture: '--advisory --recorded-incentives-capture FILE imports an exact historical public-incentive capture (strict UTF-8, at most 8 MiB) for S08 only; hidden compensation remains unmeasured.',
        recordedCallersCapture: '--advisory --recorded-callers-capture FILE imports one exact historical caller capture (strict UTF-8, at most 8 MiB) for Solana; recorded independent agent outputs qualify only S07/S09/A21/A23. Imported execution metadata is not external authentication.',
        a24Capture: '--advisory --a24-capture FILE imports one byte-exact raw A24 capture packet (at most 8 MiB, strict UTF-8) for Solana as a USER_IMPORT receipt; the six-component saturation vector is re-derived from those bytes. No score, entry gate or price claim, and no network read for the capture.',
        a12ZeroShare: '--partial --advisory --o28-expanded --a12-candidates FILE --a12-zero-share enables exact zero-target quoted capacity share under an explicit positive reference valuation class; common atomic denominator is unvalued.',
        a12Candidates: '--advisory --a12-candidates FILE imports a raw-source-bound independently reviewed factual candidate catalog and quotes the canonical PumpSwap index0 quote-verified route scope for every member. No other-venue or simulated execution claim.',
        a29Capture: '--advisory --a29-capture FILE imports one prior USER_IMPORT A29 capture (a29-retained-sources-v1) for the analyzed Solana mint. Its retained raw RPC receipts and copied source clocks are stored and replayed offline, never re-read or presented as fresh live collection. A29 is a descriptive advisory vector only.',
        s08PublicIncentives: '--partial --advisory --advisory-executor --s08-public-incentives enumerates reviewed public-source compensation, fee rights, holdings and affiliations with observation time; hidden compensation remains unknown.',
        a22EmptyCurrentPosts: '--partial --advisory --advisory-executor --a22-empty-current-posts permits A22 only when complete acquired current posts are provably empty; rejected advisory classifications remain explicit.',
        advisoryExecutor: '--partial --advisory --advisory-executor enables fresh TinyFish sources and one-shot independent Codex/Claude Code CLI classification for advisory metrics only. Requires both CLIs authenticated and TINYFISH_API_KEY. No Gemini; source freshness stays 15 minutes.',
        creatorRoleOnly: '--partial --advisory --creator-role-only permits the bounded official Pump creator page and signed role proof for Solana; needs TINYFISH_API_KEY, skips creator accounting/history and Gemini.',
        creatorHistory: '--partial --advisory --creator-history explicitly permits the bounded TinyFish Pump creator page, DEX JSON recovery and public creator history for Solana; needs TINYFISH_API_KEY, uses no Gemini.',
        executableLiquidity: '--executable-liquidity opts a live Solana analysis into fresh public RPC and keyless DEX USD reads of direct enumerated PumpSwap, Meteora DLMM and DAMM v2 cash routes: quote-net sell output at 300 bps fee-inclusive average impact per route. Quoted trading fees only; network, rent and setup costs excluded. Independent of --advisory, --full and --partial; not wallet availability and not an entry check. Rejected for EVM, bundles and reassess.',
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
        solanaTrackerKeyPresent: !!env.SOLANA_TRACKER_API_KEY,
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
      if(hasFlag(argv,'o28-rpc-errors')&&(cmd!=='analyze'||hasBundle))throw new CliError('O28_RPC_ERRORS_REQUIRED','Use --o28-rpc-errors with live Solana --advisory --o28-expanded.');
      if(hasFlag(argv,'a12-zero-witness-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A12_ZERO_WITNESS_REQUIRED','Use --a12-zero-witness-capture FILE with live Solana --partial --advisory --o28-expanded.');
      if(hasFlag(argv,'c09-market-context')&&(cmd!=='analyze'||hasBundle||!hasFlag(argv,'c12-bridge-capture')))throw new CliError('C09_MARKET_CONTEXT_MODE_REQUIRED','Use --c09-market-context with live Solana --partial --advisory --c12-bridge-capture FILE.');
      if(hasFlag(argv,'c12-bridge-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('C12_BRIDGE_MODE_REQUIRED','Use --c12-bridge-capture FILE with live Solana --partial --advisory.');
      if(hasFlag(argv,'s14-entry-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('S14_ENTRY_MODE_REQUIRED','Use --s14-entry-capture FILE with live Solana --partial --advisory.');
      if(hasFlag(argv,'a27-marginal-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A27_MARGINAL_MODE_REQUIRED','Use --a27-marginal-capture DIR with live Solana --partial --advisory.');
      if(hasFlag(argv,'a26-buyer-post-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A26_BUYER_POST_MODE_REQUIRED','Use --a26-buyer-post-capture DIR with live Solana --partial --advisory.');
      if(hasFlag(argv,'a25-lead-lag-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A25_LEAD_LAG_MODE_REQUIRED','Use --a25-lead-lag-capture FILE with live Solana --partial --advisory.');
      if(hasFlag(argv,'s15-reference-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('S15_REFERENCE_MODE_REQUIRED','Use --s15-reference-capture FILE with live Solana --partial --advisory.');
      if(hasFlag(argv,'a13-participation-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A13_PARTICIPATION_MODE_REQUIRED','Use --a13-participation-capture FILE with live Solana --partial --advisory.');
      if(hasFlag(argv,'a30-fx-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A30_FX_MODE_REQUIRED','Use --a30-fx-capture DIRECTORY with live Solana --partial --advisory --o28-expanded.');
      if(hasFlag(argv,'native-attention-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('NATIVE_ATTENTION_MODE_REQUIRED','Use --native-attention-capture FILE with live Solana --partial --advisory --o28-expanded.');
      if(hasFlag(argv,'o22-holder-age-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('O22_HOLDER_AGE_REQUIRED','Use --o22-holder-age-capture DIRECTORY with live Solana --partial --advisory --o28-expanded analysis.');
      if(hasFlag(argv,'o26-account-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('O26_ACCOUNT_REQUIRED','Use --o26-account-capture DIRECTORY with live Solana --advisory --o28-expanded analysis.');
      if(hasFlag(argv,'o25-lifetime-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('O25_LIFETIME_REQUIRED','Use --o25-lifetime-capture DIRECTORY with live Solana --advisory --o28-expanded analysis.');
      if(hasFlag(argv,'o24-inventory-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('O24_INVENTORY_REQUIRED','Use --o24-inventory-capture DIRECTORY with live Solana --advisory --o28-expanded analysis.');
      if(hasFlag(argv,'o29-reserve-path')&&(cmd!=='analyze'||hasBundle))throw new CliError('O29_RESERVE_PATH_REQUIRED','Use --o29-reserve-path with live Solana --advisory --o28-expanded --o23-bulk-capture DIRECTORY.');
      if(hasFlag(argv,'a12-zero-share')&&(cmd!=='analyze'||hasBundle))throw new CliError('A12_ZERO_SHARE_REQUIRED','Use --a12-zero-share with live Solana --partial --advisory --o28-expanded --a12-candidates FILE.');
      if(hasFlag(argv,'o23-bulk-capture')&&(cmd!=='analyze'||hasBundle||!flagValue(argv,'o23-bulk-capture')))throw new CliError('O23_BULK_ADVISORY_REQUIRED','Use --o23-bulk-capture DIRECTORY with live Solana --advisory --o28-expanded analysis.');
      if(hasFlag(argv,'historical-topic-reuse')&&(cmd!=='analyze'||hasBundle))throw new CliError('HISTORICAL_TOPIC_REUSE_REQUIRED','Use --historical-topic-reuse with live Solana --partial --advisory --advisory-executor and --recorded-callers-capture FILE.');
      if(hasFlag(argv,'o30-registry-absence')&&(cmd!=='analyze'||hasBundle))throw new CliError('O30_ADVISORY_REQUIRED','Use --o30-registry-absence with live Solana --advisory --o28-expanded analysis.');
      if((hasFlag(argv,'wbtc-entry')||hasFlag(argv,'wbtc-exit')||hasFlag(argv,'wbtc-simulate')||hasFlag(argv,'wbtc-impacts')||hasFlag(argv,'wbtc-costs'))&&(cmd!=='analyze'||hasBundle))throw new CliError('ENTRY_ROUTE_MODE_REQUIRED','Use --wbtc-entry, --wbtc-exit, --wbtc-simulate, --wbtc-impacts or --wbtc-costs with live Solana analysis.');
      if(hasFlag(argv,'a24-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A24_ADVISORY_REQUIRED','Use --a24-capture FILE with a live --advisory analysis of a Solana address.');
      if(hasFlag(argv,'s08-public-incentives')&&(cmd!=='analyze'||hasBundle))throw new CliError('S08_PUBLIC_INCENTIVES_REQUIRED','Use --s08-public-incentives with ordinary live Solana --partial --advisory --advisory-executor.');
      if(hasFlag(argv,'a22-empty-current-posts')&&(cmd!=='analyze'||hasBundle))throw new CliError('A22_EMPTY_CURRENT_POSTS_REQUIRED','Use --a22-empty-current-posts with ordinary live Solana --partial --advisory --advisory-executor.');
      if(hasFlag(argv,'advisory-executor')&&(cmd!=='analyze'||hasBundle))throw new CliError('ADVISORY_EXECUTOR_MODE_REQUIRED','Use --advisory-executor with live --partial --advisory analysis of Solana.');
      if(hasFlag(argv,'creator-role-only')&&(cmd!=='analyze'||hasBundle))throw new CliError('CREATOR_ROLE_MODE_REQUIRED','Creator role collection is a live analyze mode; use --partial --advisory.');
      if(hasFlag(argv,'creator-history')&&(cmd!=='analyze'||hasBundle))throw new CliError('CREATOR_HISTORY_MODE_REQUIRED','Creator history is a live analyze mode; use --partial --advisory.');
      if(hasFlag(argv,'a29-capture')&&(cmd!=='analyze'||hasBundle))throw new CliError('A29_ADVISORY_REQUIRED','--a29-capture imports one prior capture into a live analyze --advisory run.');
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
        if(hasFlag(argv,'executable-liquidity')&&token.chain!=='solana')throw new CliError('EXEC_LIQ_SOLANA_REQUIRED','--executable-liquidity supports Solana addresses only.');
        if(hasFlag(argv,'c12-bridge-capture')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||['advisory-executor','executable-liquidity','wbtc-entry','wbtc-exit','wbtc-simulate','wbtc-impacts','wbtc-costs','s08-public-incentives','a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('C12_BRIDGE_MODE_REQUIRED','Use --c12-bridge-capture FILE with Solana --partial --advisory, separately from semantic, execution or other imported-source modes.');
        if(hasFlag(argv,'s14-entry-capture')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||['a27-marginal-capture','a26-buyer-post-capture','a25-lead-lag-capture','s15-reference-capture','a13-participation-capture','c12-bridge-capture','c09-market-context','advisory-executor','executable-liquidity','wbtc-entry','wbtc-exit','wbtc-simulate','wbtc-impacts','wbtc-costs','s08-public-incentives','a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('S14_ENTRY_MODE_REQUIRED','Use --s14-entry-capture FILE with Solana --partial --advisory, separately from semantic, execution or other imported-source modes.');
        if(hasFlag(argv,'a27-marginal-capture')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||['a26-buyer-post-capture','a25-lead-lag-capture','s15-reference-capture','a13-participation-capture','c12-bridge-capture','c09-market-context','advisory-executor','executable-liquidity','wbtc-entry','wbtc-exit','wbtc-simulate','wbtc-impacts','wbtc-costs','s08-public-incentives','a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('A27_MARGINAL_MODE_REQUIRED','Use --a27-marginal-capture DIR with Solana --partial --advisory, separately from semantic, execution or other imported-source modes.');
        if(hasFlag(argv,'a26-buyer-post-capture')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||['a25-lead-lag-capture','s15-reference-capture','a13-participation-capture','c12-bridge-capture','c09-market-context','advisory-executor','executable-liquidity','wbtc-entry','wbtc-exit','wbtc-simulate','wbtc-impacts','wbtc-costs','s08-public-incentives','a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('A26_BUYER_POST_MODE_REQUIRED','Use --a26-buyer-post-capture DIR with Solana --partial --advisory, separately from semantic, execution or other imported-source modes.');
        if(hasFlag(argv,'a25-lead-lag-capture')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||['s15-reference-capture','a13-participation-capture','c12-bridge-capture','c09-market-context','advisory-executor','executable-liquidity','wbtc-entry','wbtc-exit','wbtc-simulate','wbtc-impacts','wbtc-costs','s08-public-incentives','a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('A25_LEAD_LAG_MODE_REQUIRED','Use --a25-lead-lag-capture FILE with Solana --partial --advisory, separately from semantic, execution or other imported-source modes.');
        if(hasFlag(argv,'s15-reference-capture')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||['a13-participation-capture','c12-bridge-capture','c09-market-context','advisory-executor','executable-liquidity','wbtc-entry','wbtc-exit','wbtc-simulate','wbtc-impacts','wbtc-costs','s08-public-incentives','a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('S15_REFERENCE_MODE_REQUIRED','Use --s15-reference-capture FILE with Solana --partial --advisory, separately from semantic, execution or other imported-source modes.');
        if(hasFlag(argv,'a13-participation-capture')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||['c12-bridge-capture','c09-market-context','advisory-executor','executable-liquidity','wbtc-entry','wbtc-exit','wbtc-simulate','wbtc-impacts','wbtc-costs','s08-public-incentives','a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('A13_PARTICIPATION_MODE_REQUIRED','Use --a13-participation-capture FILE with Solana --partial --advisory, separately from semantic, execution or other imported-source modes.');
        if(hasFlag(argv,'s08-public-incentives')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||!hasFlag(argv,'advisory-executor')||['a22-empty-current-posts','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('S08_PUBLIC_INCENTIVES_REQUIRED','Use --s08-public-incentives with ordinary live Solana --partial --advisory --advisory-executor, separately from expanded, research or imported-source modes.');
        if(hasFlag(argv,'a22-empty-current-posts')&&(!partialRequested||fullRequested||!hasFlag(argv,'advisory')||!hasFlag(argv,'advisory-executor')||['s08-public-incentives','o28-expanded','o28-rpc-errors','a30-fx-capture','a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('A22_EMPTY_CURRENT_POSTS_REQUIRED','Use --a22-empty-current-posts with ordinary live Solana --partial --advisory --advisory-executor, separately from expanded, research or imported-source modes.');
        if(hasFlag(argv,'a30-fx-capture')&&(!flagValue(argv,'a30-fx-capture')||!partialRequested||fullRequested||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||['a12-zero-witness-capture','a12-candidates','a12-zero-share','native-attention-capture','advisory-executor','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('A30_FX_MODE_REQUIRED','Use --a30-fx-capture DIRECTORY with Solana --partial --advisory --o28-expanded, separately from other semantic or historical imports.');
        if(hasFlag(argv,'a12-zero-witness-capture')&&(!flagValue(argv,'a12-zero-witness-capture')||!partialRequested||fullRequested||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||['a12-candidates','a12-zero-share','native-attention-capture','advisory-executor','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('A12_ZERO_WITNESS_REQUIRED','Use --a12-zero-witness-capture FILE with Solana --partial --advisory --o28-expanded, separately from other semantic or historical imports.');
        if(hasFlag(argv,'native-attention-capture')&&(!flagValue(argv,'native-attention-capture')||!partialRequested||fullRequested||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||['advisory-executor','creator-history','creator-role-only','research','o22-holder-age-capture','o26-account-capture','o25-lifetime-capture','o24-inventory-capture','o23-bulk-capture','o29-reserve-path','o30-registry-absence','historical-topic-reuse','a12-candidates','a12-zero-share','a24-capture','a29-capture','recorded-callers-capture','recorded-incentives-capture'].some(f=>hasFlag(argv,f))||token.chain!=='solana'))throw new CliError('NATIVE_ATTENTION_MODE_REQUIRED','Use --native-attention-capture FILE with Solana --partial --advisory --o28-expanded, separately from other semantic or historical imports.');
        if(hasFlag(argv,'a12-zero-share')&&(!partialRequested||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||!flagValue(argv,'a12-candidates')||hasFlag(argv,'native-attention-capture')||hasFlag(argv,'o22-holder-age-capture')||hasFlag(argv,'o26-account-capture')||hasFlag(argv,'o25-lifetime-capture')||hasFlag(argv,'o24-inventory-capture')||hasFlag(argv,'o23-bulk-capture')||hasFlag(argv,'o29-reserve-path')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('A12_ZERO_SHARE_REQUIRED','Use --a12-zero-share with live Solana --partial --advisory --o28-expanded --a12-candidates FILE, separately from other explicit historical modes.');
        if(hasFlag(argv,'o22-holder-age-capture')&&(!flagValue(argv,'o22-holder-age-capture')||!hasFlag(argv,'partial')||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||hasFlag(argv,'o26-account-capture')||hasFlag(argv,'o25-lifetime-capture')||hasFlag(argv,'o24-inventory-capture')||hasFlag(argv,'o23-bulk-capture')||hasFlag(argv,'o29-reserve-path')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('O22_HOLDER_AGE_REQUIRED','Use --o22-holder-age-capture DIRECTORY with Solana --partial --advisory --o28-expanded, separately from other exclusive historical imports.');
        if(hasFlag(argv,'o26-account-capture')&&(!flagValue(argv,'o26-account-capture')||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||hasFlag(argv,'o25-lifetime-capture')||hasFlag(argv,'o24-inventory-capture')||hasFlag(argv,'o23-bulk-capture')||hasFlag(argv,'o29-reserve-path')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('O26_ACCOUNT_REQUIRED','Use --o26-account-capture DIRECTORY with Solana --advisory --o28-expanded, separately from other historical imports.');
        if(hasFlag(argv,'o25-lifetime-capture')&&(!flagValue(argv,'o25-lifetime-capture')||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||hasFlag(argv,'o24-inventory-capture')||hasFlag(argv,'o23-bulk-capture')||hasFlag(argv,'o29-reserve-path')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('O25_LIFETIME_REQUIRED','Use --o25-lifetime-capture DIRECTORY with Solana --advisory --o28-expanded, separately from O23/O24/O29/O30 and historical topic reuse.');
        if(hasFlag(argv,'o24-inventory-capture')&&(!flagValue(argv,'o24-inventory-capture')||!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||hasFlag(argv,'o23-bulk-capture')||hasFlag(argv,'o29-reserve-path')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('O24_INVENTORY_REQUIRED','Use --o24-inventory-capture DIRECTORY with Solana --advisory --o28-expanded, separately from O23/O29/O30 or historical topic reuse.');
        if(hasFlag(argv,'o29-reserve-path')&&(!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||!flagValue(argv,'o23-bulk-capture')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('O29_RESERVE_PATH_REQUIRED','Use --o29-reserve-path with Solana --advisory --o28-expanded --o23-bulk-capture DIRECTORY, separately from O30 or historical topic reuse.');
        if(hasFlag(argv,'o23-bulk-capture')&&(!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('O23_BULK_ADVISORY_REQUIRED','Use --o23-bulk-capture DIRECTORY with Solana --advisory --o28-expanded, separately from O30 or historical topic reuse.');
        if(hasFlag(argv,'o28-rpc-errors')&&(!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||hasFlag(argv,'o30-registry-absence')||hasFlag(argv,'historical-topic-reuse')||token.chain!=='solana'))throw new CliError('O28_RPC_ERRORS_REQUIRED','Use --o28-rpc-errors with live Solana --advisory --o28-expanded, separately from O30 or historical topic reuse.');
        if(hasFlag(argv,'historical-topic-reuse')&&(!hasFlag(argv,'advisory')||!hasFlag(argv,'advisory-executor')||!hasFlag(argv,'recorded-callers-capture')||hasFlag(argv,'o28-expanded')||token.chain!=='solana'))throw new CliError('HISTORICAL_TOPIC_REUSE_REQUIRED','Use --historical-topic-reuse with ordinary-window live Solana --partial --advisory --advisory-executor and --recorded-callers-capture FILE.');
        if(hasFlag(argv,'o30-registry-absence')&&(!hasFlag(argv,'advisory')||!hasFlag(argv,'o28-expanded')||token.chain!=='solana'))throw new CliError('O30_ADVISORY_REQUIRED','Use --o30-registry-absence with --advisory --o28-expanded for a Solana address.');
        if(hasFlag(argv,'o28-expanded')&&(!hasFlag(argv,'advisory')||token.chain!=='solana'))throw new CliError('O28_ADVISORY_REQUIRED','Use --o28-expanded with --advisory for a Solana address.');
        if((hasFlag(argv,'wbtc-entry')||hasFlag(argv,'wbtc-exit')||hasFlag(argv,'wbtc-simulate')||hasFlag(argv,'wbtc-impacts')||hasFlag(argv,'wbtc-costs'))&&token.chain!=='solana')throw Error('ENTRY_ROUTE_SOLANA_REQUIRED');
        if(hasFlag(argv,'a24-capture')&&(!hasFlag(argv,'advisory')||token.chain!=='solana'))throw new CliError('A24_ADVISORY_REQUIRED','Use --a24-capture FILE with --advisory for a Solana address.');
        if(hasFlag(argv,'recorded-incentives-capture')&&(!hasFlag(argv,'advisory')||token.chain!=='solana'))throw new CliError('RECORDED_INCENTIVE_ADVISORY_REQUIRED','Use --recorded-incentives-capture FILE with --advisory for Solana.');
        const recordedIncentivesCapture=hasFlag(argv,'recorded-incentives-capture')?readRecordedCapture(flagValue(argv,'recorded-incentives-capture')!,'RECORDED_INCENTIVE_CAPTURE_INVALID'):undefined;
        if(hasFlag(argv,'recorded-callers-capture')&&(!hasFlag(argv,'advisory')||token.chain!=='solana'))throw new CliError('RECORDED_CALLER_ADVISORY_REQUIRED','Use --recorded-callers-capture FILE with --advisory for Solana.');
        const recordedCallersCapture=hasFlag(argv,'recorded-callers-capture')?readRecordedCapture(flagValue(argv,'recorded-callers-capture')!,'RECORDED_CALLER_CAPTURE_INVALID'):undefined;
        const a24Capture=hasFlag(argv,'a24-capture')?captureText(flagValue(argv,'a24-capture')):undefined;
        if(flagValue(argv,'a12-candidates')&&(!hasFlag(argv,'advisory')||token.chain!=='solana'))throw new CliError('A12_ADVISORY_REQUIRED','Use --a12-candidates FILE with --advisory for a Solana address.');
        if(hasFlag(argv,'a29-capture')&&(!hasFlag(argv,'advisory')||token.chain!=='solana'))throw new CliError('A29_ADVISORY_REQUIRED','Use --a29-capture FILE with --advisory for a Solana address.');
        const a29Capture=hasFlag(argv,'a29-capture')?readA29Capture(flagValue(argv,'a29-capture')!):undefined;
        const creatorHistory=hasFlag(argv,'creator-history'),creatorRoleOnly=hasFlag(argv,'creator-role-only'),advisoryExecutor=hasFlag(argv,'advisory-executor');
        if(advisoryExecutor&&(!partialRequested||!hasFlag(argv,'advisory')||token.chain!=='solana'||creatorHistory))throw new CliError('ADVISORY_EXECUTOR_MODE_REQUIRED','Use --advisory-executor with --partial --advisory for Solana, separately from --creator-history.');
        if(advisoryExecutor&&!env.TINYFISH_API_KEY)throw new CliError('TINYFISH_KEY_MISSING','Advisory executor mode requires TINYFISH_API_KEY for fresh source acquisition.');
        if(creatorRoleOnly&&(!partialRequested||!hasFlag(argv,'advisory')||token.chain!=='solana'||creatorHistory))throw new CliError('CREATOR_ROLE_MODE_REQUIRED','Use --creator-role-only with --partial --advisory for Solana, separately from --creator-history.');
        if(creatorRoleOnly&&!env.TINYFISH_API_KEY)throw new CliError('TINYFISH_KEY_MISSING','Creator role collection requires TINYFISH_API_KEY for the bounded official Pump page fetch.');
        if(creatorHistory&&(!partialRequested||!hasFlag(argv,'advisory')||token.chain!=='solana'))throw new CliError('CREATOR_HISTORY_MODE_REQUIRED','Use --creator-history with --partial --advisory for a Solana address.');
        if(creatorHistory&&!env.TINYFISH_API_KEY)throw new CliError('TINYFISH_KEY_MISSING','Creator history requires TINYFISH_API_KEY for the bounded official Pump page fetch.');
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
        if (partialRequested) stderr(hasFlag(argv,'a12-zero-witness-capture')?'A12_ZERO_WITNESS_MODE: importing target/peer source qualification and collecting native capacity; catalog membership and denominator remain unmeasured.\n':hasFlag(argv,'native-attention-capture')?'NATIVE_ATTENTION_MODE: importing fresh Codex/Claude A01/A02 evidence; collecting RPC and DEX evidence.\n':advisoryExecutor?'ADVISORY_EXECUTOR_MODE: acquiring fresh bounded TinyFish sources and signed creator role; independent Codex/Claude CLI inference is advisory-only. Creator accounting/history and Gemini are skipped.\n':creatorRoleOnly?'CREATOR_ROLE_MODE: collecting the bounded official Pump creator page and signed role proof; creator accounting/history and Gemini are skipped.\n':creatorHistory?'CREATOR_HISTORY_MODE: --creator-history approves the bounded TinyFish Pump creator page and DEX JSON recovery plus public RPC/DEX history; Gemini is skipped.\n':'PARTIAL_MODE: collecting RPC and DEX evidence only; TinyFish and Gemini are skipped.\n');
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
          ...(hasFlag(argv,'wbtc-costs')?{wbtcCosts:true}:{}),
          ...(hasFlag(argv,'wbtc-impacts')?{wbtcImpacts:true}:{}),
          ...(hasFlag(argv,'wbtc-simulate')?{wbtcSimulate:true}:{}),
          ...(hasFlag(argv,'wbtc-exit')?{wbtcExit:true}:{}),
          ...(hasFlag(argv,'wbtc-entry')?{wbtcEntry:true}:{}),
          ...(hasFlag(argv,'a12-zero-witness-capture')?{a12ZeroWitnessCapture:flagValue(argv,'a12-zero-witness-capture')!}:{}),
          ...(hasFlag(argv,'c09-market-context')?{c09MarketContext:true}:{}),
          ...(hasFlag(argv,'c12-bridge-capture')?{c12BridgeCapture:flagValue(argv,'c12-bridge-capture')!}:{}),
          ...(hasFlag(argv,'s14-entry-capture')?{s14EntryCapture:flagValue(argv,'s14-entry-capture')!}:{}),
          ...(hasFlag(argv,'a27-marginal-capture')?{a27MarginalCapture:flagValue(argv,'a27-marginal-capture')!}:{}),
          ...(hasFlag(argv,'a26-buyer-post-capture')?{a26BuyerPostCapture:flagValue(argv,'a26-buyer-post-capture')!}:{}),
          ...(hasFlag(argv,'a25-lead-lag-capture')?{a25LeadLagCapture:flagValue(argv,'a25-lead-lag-capture')!}:{}),
          ...(hasFlag(argv,'s15-reference-capture')?{s15ReferenceCapture:flagValue(argv,'s15-reference-capture')!}:{}),
          ...(hasFlag(argv,'a13-participation-capture')?{a13ParticipationCapture:flagValue(argv,'a13-participation-capture')!}:{}),
          ...(hasFlag(argv,'s08-public-incentives')?{s08PublicIncentives:true}:{}),
          ...(hasFlag(argv,'a22-empty-current-posts')?{a22EmptyCurrentPosts:true}:{}),
          ...(hasFlag(argv,'a30-fx-capture')?{a30FxCapture:flagValue(argv,'a30-fx-capture')!}:{}),
          ...(hasFlag(argv,'native-attention-capture')?{nativeAttentionCapture:flagValue(argv,'native-attention-capture')!}:{}),
          ...(hasFlag(argv,'a12-zero-share')?{a12ZeroShare:true}:{}),
          ...(hasFlag(argv,'o22-holder-age-capture')?{o22HolderAgeCapture:flagValue(argv,'o22-holder-age-capture')!}:{}),
          ...(hasFlag(argv,'o26-account-capture')?{o26AccountCapture:flagValue(argv,'o26-account-capture')!}:{}),
          ...(hasFlag(argv,'o25-lifetime-capture')?{o25LifetimeCapture:flagValue(argv,'o25-lifetime-capture')!}:{}),
          ...(hasFlag(argv,'o24-inventory-capture')?{o24InventoryCapture:flagValue(argv,'o24-inventory-capture')!}:{}),
          ...(hasFlag(argv,'o29-reserve-path')?{o29ReservePath:true}:{}),
          ...(hasFlag(argv,'o23-bulk-capture')?{o23BulkCapture:flagValue(argv,'o23-bulk-capture')!}:{}),
          ...(hasFlag(argv,'o28-expanded')?{o28Expanded:true}:{}),
          ...(hasFlag(argv,'o28-rpc-errors')?{o28RpcErrors:true}:{}),
          ...(hasFlag(argv,'o30-registry-absence')?{o30RegistryAbsence:true}:{}),
          ...(hasFlag(argv,'historical-topic-reuse')?{historicalTopicReuse:true}:{}),
          ...(hasFlag(argv,'executable-liquidity')?{executableLiquidity:true}:{}),
          ...(creatorRoleOnly?{creatorRoleOnly:true}:{}),
          ...(advisoryExecutor?{semanticExecutor:runtime.semanticExecutor??createLocalSemanticExecutor()}:{}),
          ...(recordedCallersCapture!==undefined?{recordedCallersCapture}:{}),
          ...(recordedIncentivesCapture!==undefined?{recordedIncentivesCapture}:{}),
          ...(a24Capture!==undefined?{a24Capture}:{}),
          ...(flagValue(argv,'a12-candidates')?{a12CandidateSet:fileJson(flagValue(argv,'a12-candidates')) as import('./providers/advisory-exit-capacity-custom.js').A12CandidateSet}:{}),
          ...(a29Capture!==undefined?{a29Capture}:{}),
          ...(active?{thesis:active.thesis}:explicitThesis?{thesis:explicitThesis}:saved?.thesisTemplate?{thesis:saved.thesisTemplate,thesisExpiryMode:saved.thesisExpiryMode}:{}),
          ...(research?{research}:{}),origins:{profile:hasProfile?'ARGUMENT':saved?'SAVED_DEFAULT':'USER_REQUESTED_PRESET'},
          ...(env.SOLANA_RPC_URL ? { rpcUrl: env.SOLANA_RPC_URL } : {}),
          ...(fullApproved ? { tinyfishKey: env.TINYFISH_API_KEY!, geminiKey: env.GEMINI_API_KEY! } : creatorHistory||creatorRoleOnly||advisoryExecutor?{tinyfishKey:env.TINYFISH_API_KEY!}:{}),
          ...(hasFlag(argv,'advisory') && env.HELIUS_API_KEY ? { heliusKey: env.HELIUS_API_KEY } : {}),
          ...(hasFlag(argv,'advisory') && env.SOLANA_TRACKER_API_KEY ? { solanaTrackerKey: env.SOLANA_TRACKER_API_KEY } : {}),
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
