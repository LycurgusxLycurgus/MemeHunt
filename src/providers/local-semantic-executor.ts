import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SemanticExecutor } from './executor-semantic.js';

/** Fixed, one-shot local CLI inference. Source acquisition stays with the calling Codex run. */
export function createLocalSemanticExecutor(auditDirectory?:string): SemanticExecutor {
  return async call => {
    call.signal.throwIfAborted();
    const cwd=await mkdtemp(join(tmpdir(),'memehunter-executor-'));
    try {
      const output=join(cwd,'response.txt'),session=randomUUID();
      const localClaude=join(homedir(),'.local','bin','claude');
      const command=call.executor==='CODEX'?'codex':existsSync(localClaude)?localClaude:'claude';
      const args=call.executor==='CODEX'
        ?['exec','--ephemeral','--ignore-user-config','--skip-git-repo-check','--sandbox','read-only','--cd',cwd,'--json','--output-last-message',output,'-']
        :['--print','--model','claude-opus-5-5','--session-id',session,'--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--disable-slash-commands','--setting-sources','','--effort','medium','--output-format','json'];
      const env={...process.env};
      for(const name of ['TINYFISH_API_KEY','GEMINI_API_KEY','HELIUS_API_KEY','SOLANA_TRACKER_API_KEY','SOLANA_RPC_URL'])delete env[name];
      const stdout=await new Promise<string>((resolve,reject)=>{
        const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],signal:call.signal});
        let chunks:Buffer[]=[],length=0,settled=false,failure:string|undefined;
        let killTimer:ReturnType<typeof setTimeout>|undefined;
        const fail=(code:string)=>{if(settled||failure)return;failure=code;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref();};
        child.stdout.on('data',(part:Buffer)=>{length+=part.length;if(length>8*1024*1024)fail('EXECUTOR_CLI_OUTPUT_LIMIT');else chunks.push(part);});
        // CLI diagnostics can include account identifiers; they never become public errors.
        child.stderr.resume();
        child.on('error',()=>fail(call.signal.aborted?'EXECUTOR_CLI_ABORTED':'EXECUTOR_CLI_UNAVAILABLE'));
        child.on('close',code=>{if(settled)return;settled=true;if(killTimer)clearTimeout(killTimer);failure||code!==0?reject(Error(failure??'EXECUTOR_CLI_FAILED')):resolve(Buffer.concat(chunks).toString('utf8'));});
        child.stdin.on('error',()=>fail('EXECUTOR_CLI_INPUT_FAILED'));
        child.stdin.end(call.packet);
      });
      if(auditDirectory){
        await mkdir(auditDirectory,{recursive:true});
        const prefix=join(auditDirectory,`${call.protocol}-${call.stage}-${session}`);
        await writeFile(prefix+'-transport.txt',stdout);
        await writeFile(prefix+'-prompt.txt',call.packet);
        await writeFile(prefix+'-launch.json',JSON.stringify({executor:call.executor,protocol:call.protocol,stage:call.stage,command,args,cwd,tools:'NONE',freshSession:true,transportComplete:true},null,2));
      }
      if(call.executor==='CODEX'){
        let events:any[];try{events=stdout.trim().split('\n').map(line=>JSON.parse(line));}catch{throw Error('EXECUTOR_CLI_RECEIPT_INVALID');}
        const id=events.find(e=>e.type==='thread.started')?.thread_id;
        if(typeof id!=='string'||!events.some(e=>e.type==='turn.completed')||events.some(e=>e.type==='item.completed'&&!['agent_message','reasoning'].includes(e.item?.type)))throw Error('EXECUTOR_CLI_TOOL_OR_RECEIPT_INVALID');
        return {response:await readFile(output,'utf8'),executionId:id,modelId:null,modelIdSource:'UNREPORTED',tools:'NONE',freshSession:true};
      }
      let result:any;try{result=JSON.parse(stdout);}catch{throw Error('EXECUTOR_CLI_RECEIPT_INVALID');}
      if(result.is_error||result.session_id!==session||result.num_turns!==1||typeof result.result!=='string'||!result.modelUsage?.['claude-opus-5-5']||Object.values(result.modelUsage).some((m:any)=>(m.webSearchRequests??0)>0))throw Error('EXECUTOR_CLI_TOOL_OR_RECEIPT_INVALID');
      return {response:result.result,executionId:session,modelId:'claude-opus-5-5',modelIdSource:'HARNESS_REPORTED',tools:'NONE',freshSession:true};
    } finally {await rm(cwd,{recursive:true,force:true});}
  };
}
