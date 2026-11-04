// @vitest-environment node
// Block mode in the real host.mjs on Pi durable and SQLite, with pi-ai's own
// OpenAI-compatible client sending to a stand-in gateway in fetch: what each
// model request carries, from discovery through restart. Run with PI_DEPS
// set, as host.live.test.ts says.
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import host from "./host.mjs?raw";

const deps = process.env.PI_DEPS;
const driver = String.raw`import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {serve,composeWorkforce,routeModels,WORKFORCE} from './host.mjs';
const data=process.argv[2], agent='b'.repeat(64), outside='c'.repeat(64);
const faux=fauxProvider(), models=createModels(); models.setProvider(faux.provider);
const ORIGIN='https://gateway.test', result={};
const until=async test=>{const end=Date.now()+5000;while(!test()){if(Date.now()>end)throw new Error('timed out');await new Promise(r=>setTimeout(r,5));}};
// The stand-in gateway: its listing, and scripted chat completion streams.
const ep=(name,model_class,api_types,extra={})=>({name,state:{ready:'READY'},capabilities:{function_calling:true,image_input:false},config:{served_entities:[{foundation_model:{model_class,display_name:name,api_types}}]},...extra});
const endpoints=[ep('databricks-gpt-oss-20b','gpt-oss',['mlflow/v1/chat/completions']),ep('databricks-claude-x','claude',['anthropic/v1/messages','mlflow/v1/chat/completions']),ep('databricks-gemini-x','gemini',['gemini/v1/generateContent']),ep('databricks-down','llama',['mlflow/v1/chat/completions'],{state:{ready:'NOT_READY'}})];
const chunk=(delta,finish,used=1)=>({id:'c',object:'chat.completion.chunk',created:0,model:'m',choices:[{index:0,delta,finish_reason:finish??null}],...(finish?{usage:{prompt_tokens:used,completion_tokens:1,total_tokens:used+1}}:{})});
const sse=chunks=>new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const say=text=>()=>sse([chunk({role:'assistant',content:text}),chunk({},'stop')]);
const send=(used)=>()=>sse([chunk({role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'send',arguments:'{"text":"hi"}'}}]}),chunk({},'tool_calls',used)]);
const listings=[], requests=[], replies=[];
globalThis.fetch=async(url,init={})=>{
 const headers=Object.fromEntries(new Headers(init.headers));
 if(String(url).endsWith('/serving-endpoints')){listings.push({url:String(url),headers});return Response.json({endpoints});}
 requests.push({url:String(url),headers,body:JSON.parse(init.body)});
 return (replies.shift()??say('ok'))(init);
};
// The plugin: Buzz tools, protection, and the DXA-1152 seam's answers.
let admit=()=>({ok:true}), gate=Promise.resolve(), sessions=0;
const binds=[], actions=[];
function start(protectedAgent) {
 const input=new PassThrough(),output=new PassThrough(),pending=new Map();let id=0;
 const answer=(m,value)=>input.write(JSON.stringify({id:m.id,result:value})+'\n');
 createInterface({input:output}).on('line',async line=>{
  const m=JSON.parse(line);
  if(m.method==='workforce'){
   const {op,event,saved,turn}=m.params;
   if(op==='admit')return answer(m,admit(m.params.binding));
   binds.push(m.params);await gate;
   const keep=saved&&event==='resume';
   const binding=keep?saved:{v:1,client_session_id:'00000000-0000-4000-8000-00000000000'+(++sessions),identity:{community_id:'c1'}};
   answer(m,{ok:true,binding,persist:!keep,bundle:{'x-workforce-launcher-client':'buzz','x-workforce-launcher-session':binding.client_session_id,'x-workforce-buzz-trigger-id':turn.trigger_id}});
  } else if(m.method==='security'){actions.push(m.params.action.kind);answer(m,true);}
  else if(m.method==='tool')answer(m,{content:[{type:'text',text:'sent'}]});
  else if(m.method==='hook')answer(m,null);
  else if(m.id!==undefined){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(m.error)):p?.resolve(m.result);}
 });
 const rpc=(method,params)=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});input.write(JSON.stringify({id,method,params})+'\n');});
 const server=serve({data,models,dir:data,protectedAgent,input,output,exit:()=>{}});
 return {rpc,stop:()=>server.stop()};
}
const route={kind:'eligible',gatewayOrigin:ORIGIN,identity:{community_id:'c1'},discovery:{'x-workforce-launcher-client':'buzz','x-workforce-buzz-purpose':'discovery'}};
const tools=[{name:'send',description:'Post',inputSchema:{type:'object',properties:{text:{type:'string'}}},load:'always'}];
const turn=(request,extra={})=>({agent,key:'chan/root',at:100,context:{channel:'chan'},text:'Do it',steer:'Do it',request,provider:WORKFORCE,model:'databricks-gpt-oss-20b',instructions:'Test.',cwd:data,workforce:{trigger_id:request},...extra});
const sent=from=>requests.slice(from).map(r=>r.headers);
const run=async(pi,request,extra)=>{const {submission}=await pi.rpc('deliver',turn(request,extra));return pi.rpc('wait',{agent,submission,request});};

// Composition: native headers kept, Buzz's own replaced, conflicting sessions refused.
assert.deepEqual(composeWorkforce({'User-Agent':'pi/1','X-Workforce-Buzz-Channel-Id':'stale','X-WORKFORCE-LAUNCHER-SESSION':'stale','x-workforce-custom':'kept',session_id:'s',  'x-client-request-id':'s','x-session-affinity':'s','x-gone':null},{'x-workforce-launcher-session':'u'},'s'),
 {'User-Agent':'pi/1','x-workforce-custom':'kept',session_id:'s','x-client-request-id':'s','x-gone':null,'x-workforce-launcher-session':'u','x-session-affinity':'s'});
for(const name of ['x-session-affinity','X-LiteLLM-Session-Id','x-litellm-trace-id','x-claude-code-session-id','agent-session-id','session-id'])
 assert.throws(()=>composeWorkforce({[name]:'other'},{},'s'),/conflicting/);
assert.throws(()=>composeWorkforce({},{},undefined),/no session/);
const routed=routeModels(models,async()=>({}));
for(const name of ['streamDeferred','fetchDeferred','cancelDeferred','generateImages','classify'])assert.throws(()=>routed[name](),/does not support/);
result.composition=true;

let pi=start();
// An external agent never reaches the gateway, and keeps Pi's providers.
await pi.rpc('open',{agent:outside,tools:[]});
faux.setResponses([fauxAssistantMessage('local')]);
{const {submission}=await pi.rpc('deliver',{...turn('x1'),agent:outside,provider:'faux',model:'faux-1',workforce:undefined});
 assert.equal((await pi.rpc('wait',{agent:outside,submission,request:'x1'})).text,'local');}
assert.equal(listings.length+requests.length+binds.length,0);
result.external=true;

// Discovery: the route's headers, the verified protocol per family, others unavailable.
await pi.rpc('open',{agent,tools,route});
assert.equal(listings[0].url,ORIGIN+'/pass-through/databricks/api/2.0/serving-endpoints');
assert.equal(listings[0].headers.authorization,'Bearer trogdor');
assert.equal(listings[0].headers['x-workforce-buzz-purpose'],'discovery');
assert.deepEqual((await pi.rpc('models',{agent,provider:WORKFORCE})).map(m=>m.id),['databricks-gpt-oss-20b','databricks-claude-x']);
assert.deepEqual(await pi.rpc('models',{agent,provider:'faux'}),[]);
const {providers}=await pi.rpc('providers',{agent});
assert.equal(providers[0].id,WORKFORCE);assert.ok(providers.find(p=>p.id==='faux').unavailable);
assert.ok(!(await pi.rpc('providers',{})).providers.some(p=>p.id===WORKFORCE));
await assert.rejects(pi.rpc('deliver',turn('bad',{key:'chan/bad',provider:'faux',model:'faux-1'})),/unavailable in Block mode/);assert.equal(binds.length,0);
result.discovery=true;

// A turn: bound before submission, nothing sent until then; tool call and continuation carry its context.
binds.length=0;let release;gate=new Promise(r=>{release=r;});replies.push(send(),say('done'));
const first=pi.rpc('deliver',turn('e1'));
await until(()=>binds.length===1);await new Promise(r=>setTimeout(r,50));
assert.equal(requests.length,0);release();
const {submission}=await first;
assert.equal((await pi.rpc('wait',{agent,submission,request:'e1'})).status,'done');
assert.equal(binds[0].event,'new_generation');assert.equal(binds[0].saved,undefined);
const [call1,call2]=sent(0);
assert.equal(requests[0].url,ORIGIN+'/pass-through/databricks/ai-gateway/mlflow/v1/chat/completions');
assert.equal(requests[0].body.store,undefined);assert.ok('max_tokens' in requests[0].body);
assert.ok(call1['user-agent'].startsWith('pi/'));
const affinity=call1['x-session-affinity'];
assert.match(affinity,/^[0-9a-f-]{36}$/);assert.notEqual(affinity,call1['x-workforce-launcher-session']);
for(const h of [call1,call2]){assert.equal(h['x-workforce-buzz-trigger-id'],'e1');assert.equal(h['x-workforce-launcher-session'],'00000000-0000-4000-8000-000000000001');assert.equal(h['x-session-affinity'],affinity);}
result.firstTurn=true;

// A second turn resumes the binding; its own trigger; the same native session.
let from=requests.length;
assert.equal((await run(pi,'e2')).status,'done');
assert.equal(binds[1].event,'resume');assert.equal(binds[1].saved.client_session_id,'00000000-0000-4000-8000-000000000001');
assert.equal(sent(from)[0]['x-workforce-buzz-trigger-id'],'e2');
assert.equal(sent(from)[0]['x-workforce-launcher-session'],'00000000-0000-4000-8000-000000000001');
assert.equal(sent(from)[0]['x-session-affinity'],affinity);
result.secondTurn=true;

// A route that no longer admits the binding stops the run before it sends.
from=requests.length;admit=()=>({ok:false,message:'Sign in to Block again to use its models.'});
const refused=await run(pi,'e3');
assert.equal(refused.status,'unanswered');assert.match(refused.detail,/Sign in to Block again/);
assert.equal(requests.length,from);admit=()=>({ok:true});
result.invalidated=true;

// A new session rotates the binding.
await pi.rpc('session',{agent,key:'chan/root',action:'new'});
from=requests.length;
assert.equal((await run(pi,'e4')).status,'done');
assert.equal(binds.at(-1).event,'reset');
assert.equal(sent(from)[0]['x-workforce-launcher-session'],'00000000-0000-4000-8000-000000000002');
result.reset=true;

// A one-off turn is standalone, with no saved binding.
from=requests.length;
{const {submission}=await pi.rpc('once',{...turn('o1'),key:undefined});
 assert.equal((await pi.rpc('wait',{agent,submission})).status,'done');}
assert.equal(binds.at(-1).event,'standalone');assert.equal(binds.at(-1).saved,undefined);
assert.equal(sent(from)[0]['x-workforce-buzz-trigger-id'],'o1');
result.standalone=true;

// Compaction in a run, without the native session pi-ai drops for it: the run's context, the native affinity.
assert.equal((await run(pi,'e6a',{text:'word '.repeat(30000)})).status,'done');
from=requests.length;replies.push(send(125000),say('Summary.'),say('done'));
assert.equal((await run(pi,'e6')).status,'done');
const compaction=requests.slice(from).find(r=>JSON.stringify(r.body.messages).includes('ummar'));
assert.ok(compaction,'no compaction request');
assert.equal(compaction.headers.session_id,undefined);
for(const h of sent(from)){assert.equal(h['x-workforce-buzz-trigger-id'],'e6');assert.equal(h['x-session-affinity'],sent(from)[0]['x-session-affinity']);}
result.compaction=true;
// One the owner asks for between runs has the last run's.
for(const request of ['e7a','e7b'])assert.equal((await run(pi,request,{text:'word '.repeat(30000)})).status,'done');
from=requests.length;replies.push(say('Summary again.'));
await pi.rpc('session',{agent,key:'chan/root',action:'compact'});
assert.ok(requests.length>from,'no manual compaction request');
assert.equal(sent(from)[0]['x-workforce-buzz-trigger-id'],'e7b');
result.manualCompaction=true;

// Restart mid-run: the next host continues it with the recorded context, binding nothing again.
// Held until the stopping host aborts it.
replies.push(init=>new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal.reason))));
from=requests.length;const bound=binds.length;
await pi.rpc('deliver',turn('e5'));
await until(()=>requests.length>from);
await pi.stop();
pi=start();await pi.rpc('open',{agent,tools,route});
const {submissions}=await pi.rpc('unfinished',{agent});
const left=submissions.find(s=>s.request==='e5');assert.ok(left);
const after=requests.length;
assert.equal((await pi.rpc('wait',{agent,submission:left.submission,request:'e5'})).status,'done');
assert.ok(requests.length>after);
for(const h of sent(after)){assert.equal(h['x-workforce-buzz-trigger-id'],'e5');assert.equal(h['x-session-affinity'],sent(from)[0]['x-session-affinity']);}
assert.equal(binds.length,bound+1);
result.restart=true;
await pi.stop();

// Protected: the review sees every request, and the route's headers are still the request's.
const protectedPi=start(agent);
await protectedPi.rpc('open',{agent,tools,route});
from=requests.length;actions.length=0;
assert.equal((await run(protectedPi,'p1')).status,'done');
assert.ok(actions.includes('context'));
assert.equal(sent(from)[0]['x-workforce-buzz-trigger-id'],'p1');
result.protected=true;
await protectedPi.stop();
console.log(JSON.stringify(result));
`;

it.skipIf(!deps)(
  "routes Block mode requests with their run's Buzz context",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-workforce-"));
    try {
      await symlink(
        join(deps ?? "", "node_modules"),
        join(folder, "node_modules"),
      );
      await writeFile(join(folder, "host.mjs"), host);
      await writeFile(join(folder, "driver.mjs"), driver);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          join(folder, "driver.mjs"),
          folder,
        ],
        { cwd: folder, timeout: 60000 },
      );
      expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual(
        Object.fromEntries(
          [
            "composition",
            "external",
            "discovery",
            "firstTurn",
            "secondTurn",
            "invalidated",
            "reset",
            "standalone",
            "compaction",
            "manualCompaction",
            "restart",
            "protected",
          ].map((key) => [key, true]),
        ),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  90000,
);
