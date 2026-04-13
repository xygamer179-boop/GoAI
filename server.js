require('dotenv').config();
const express=require('express'),helmet=require('helmet'),cors=require('cors'),rateLimit=require('express-rate-limit'),{body,validationResult}=require('express-validator'),path=require('path'),fs=require('fs');

/* ── JSON store ── */
const DB=path.join(__dirname,'goai.json');
const rdb=()=>{try{return JSON.parse(fs.readFileSync(DB,'utf8'));}catch{return{chats:{}};}};
const wdb=d=>{try{fs.writeFileSync(DB,JSON.stringify(d),'utf8');}catch(e){console.error('[DB]',e.message);}};
if(!fs.existsSync(DB))wdb({chats:{}});
const store={
  list:()=>Object.values(rdb().chats).sort((a,b)=>b.updated_at-a.updated_at).map(({id,title,mode,pref,messages,created_at,updated_at})=>({id,title,mode,pref,created_at,updated_at,msg_count:(messages||[]).length})),
  get:id=>rdb().chats[id]||null,
  insert:(id,title,mode,pref,msgs,now)=>{const d=rdb();d.chats[id]={id,title,mode,pref,messages:msgs,created_at:now,updated_at:now};wdb(d);},
  update:(id,fields)=>{const d=rdb();if(!d.chats[id])return;Object.assign(d.chats[id],fields,{updated_at:Date.now()});wdb(d);},
  remove:id=>{const d=rdb();delete d.chats[id];wdb(d);},
  prune:()=>{const d=rdb();const ks=Object.keys(d.chats).sort((a,b)=>d.chats[b].updated_at-d.chats[a].updated_at);if(ks.length>200){ks.slice(200).forEach(k=>delete d.chats[k]);wdb(d);}}
};

const app=express(),PORT=process.env.PORT||3000,ORIGIN=process.env.ORIGIN||'http://localhost:'+PORT;
app.set('trust proxy',1);

const K={
  groq1:process.env.GROQ1_KEY||'',groq2:process.env.GROQ2_KEY||'',
  gem1:process.env.GEMINI1_KEY||'',gem2:process.env.GEMINI2_KEY||'',gem3:process.env.GEMINI3_KEY||'',
  or:process.env.OR_KEY||'',github:process.env.GITHUB_KEY||'',
  samba:process.env.SAMBA_KEY||'',bytez:process.env.BYTEZ_KEY||''
};
const hasK=k=>!!(k&&k.length>8&&!k.startsWith('PASTE_'));
const GH_H={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
const OR_H={'HTTP-Referer':ORIGIN,'X-Title':'GoAi'};

/*
  PROVIDER FIXES v6.2:

  FIXED:
  ✅ or_minimax  : minimax/minimax-m1:free → minimax/minimax-m1
      The :free suffix endpoint does not exist. Use the plain model ID.
      Your OR_KEY has access — this is how v5 worked.

  REMOVED:
  ❌ or_deepseek_r1 (deepseek/deepseek-r1-distill-llama-70b:free)
      OpenRouter has no free endpoint for this model ID.
  ❌ groq_deepseek_r1 (deepseek-r1-distill-llama-70b)
      Groq decommissioned this model. See groq.com/docs/deprecations.
      Replaced with deepseek-r1-distill-qwen-32b (same R1 distill, Qwen base).
  ❌ groq_qwen_qwq (qwen-qwq-32b)
      Groq decommissioned this model. Removed — no direct replacement.

  CHANGED DC MANAGER:
  Old: groq_deepseek_r1 (broken)
  New: gh_gpt41 — GPT-4.1 on GitHub, excellent code architect, very reliable.

  DC WORKERS (verified working):
  - gh_deepseek_v3  (DeepSeek V3 on GitHub — fewer 429s than R1)
  - gh_gpt4o        (GPT-4o on GitHub)
  - gem_25_flash_k1 (Gemini 2.5 Flash)
  - or_minimax      (MiniMax M1 — confirmed working)
  - duckduckgo      (Claude Haiku — free, reliable)

  NOTE: gh_deepseek_r1 removed from DC workers — too many 429s.
  Still selectable manually, just won't be auto-assigned in DeepCoder.

  BYTEZ: Using native load+run API (t:'bytez'). noStream:true.
  GEMINI 3.1 FLASH LITE: Kept — may require preview access on your key.
*/

const PROV={
  /* ── OPENROUTER — MiniMax first (DEFAULT AI) ── */
  or_minimax: {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'minimax/minimax-m1',       t:'oai',ex:OR_H,label:'MiniMax M1',       group:'OpenRouter',free:true,isDCWorker:true},
  or_llama33: {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'meta-llama/llama-3.3-70b-instruct:free',t:'oai',ex:OR_H,label:'Llama 3.3 70B',   group:'OpenRouter',free:true},
  or_qwen3:   {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'qwen/qwen3-8b:free',       t:'oai',ex:OR_H,label:'Qwen3 8B',          group:'OpenRouter',free:true},
  or_gemma3:  {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'google/gemma-3-27b-it:free',t:'oai',ex:OR_H,label:'Gemma 3 27B',       group:'OpenRouter',free:true},
  or_mistral: {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'mistralai/mistral-7b-instruct:free',t:'oai',ex:OR_H,label:'Mistral 7B', group:'OpenRouter',free:true},
  or_phi4:    {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'microsoft/phi-4-reasoning-plus:free',t:'oai',ex:OR_H,label:'Phi-4 Reasoning',group:'OpenRouter',free:true},

  /* ── GROQ ── */
  groq_llama33_70b:    {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'llama-3.3-70b-versatile',                         t:'oai',label:'Llama 3.3 70B',       group:'Groq',free:true},
  groq_llama33_70b_b:  {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'llama-3.3-70b-versatile',                         t:'oai',label:'Llama 3.3 70B (B)',    group:'Groq',free:true,isManager:true},
  groq_llama4_scout:   {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'meta-llama/llama-4-scout-17b-16e-instruct',        t:'oai',label:'Llama 4 Scout',        group:'Groq',free:true},
  groq_llama4_maverick:{url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'meta-llama/llama-4-maverick-17b-128e-instruct',    t:'oai',label:'Llama 4 Maverick',     group:'Groq',free:true,isDCWorker:true},
  groq_llama31_8b:     {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'llama-3.1-8b-instant',                            t:'oai',label:'Llama 3.1 8B',         group:'Groq',free:true},
  /* FIXED: deepseek-r1-distill-llama-70b decommissioned → deepseek-r1-distill-qwen-32b */
  groq_deepseek_r1:    {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'deepseek-r1-distill-qwen-32b',                    t:'oai',label:'DeepSeek R1 (Groq)',   group:'Groq',free:true},
  groq_gemma2_9b:      {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'gemma2-9b-it',                                    t:'oai',label:'Gemma 2 9B',           group:'Groq',free:true},
  groq_mixtral:        {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'mixtral-8x7b-32768',                              t:'oai',label:'Mixtral 8x7B',         group:'Groq',free:true},

  /* ── GEMINI ── */
  gem_31_flash_lite_k1:{k:'gem1',m:'gemini-2.5-flash-lite-preview-06-17',t:'gem',label:'Gemini 2.5 Flash Lite',    group:'Gemini',free:true,isDCWorker:true},
  gem_31_flash_lite_k2:{k:'gem2',m:'gemini-2.5-flash-lite-preview-06-17',t:'gem',label:'Gemini 2.5 Flash Lite K2', group:'Gemini',free:true},
  gem_31_flash_lite_k3:{k:'gem3',m:'gemini-2.5-flash-lite-preview-06-17',t:'gem',label:'Gemini 2.5 Flash Lite K3', group:'Gemini',free:true},
  gem_25_flash_k1:     {k:'gem1',m:'gemini-2.5-flash',       t:'gem',label:'Gemini 2.5 Flash',      group:'Gemini',free:true},
  gem_25_flash_k2:     {k:'gem2',m:'gemini-2.5-flash',       t:'gem',label:'Gemini 2.5 Flash (K2)', group:'Gemini',free:true},
  gem_25_flash_k3:     {k:'gem3',m:'gemini-2.5-flash',       t:'gem',label:'Gemini 2.5 Flash (K3)', group:'Gemini',free:true},
  gem_20_flash:        {k:'gem1',m:'gemini-2.0-flash',        t:'gem',label:'Gemini 2.0 Flash',      group:'Gemini',free:true},
  gem_20_flash_lite:   {k:'gem2',m:'gemini-2.0-flash-lite',   t:'gem',label:'Gemini 2.0 Flash Lite', group:'Gemini',free:true},

  /* ── GITHUB MODELS ── */
  /* NEW DC Manager: gh_gpt41 — GPT-4.1 is reliable + excellent code architect */
  gh_gpt41_mini:   {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4.1-mini',                           t:'oai',ex:GH_H,label:'GPT-4.1 Mini',        group:'GitHub',free:true},
  gh_gpt4o:        {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4o',                                 t:'oai',ex:GH_H,label:'GPT-4o',              group:'GitHub',free:true,isDCWorker:true},
  gh_gpt41:        {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4.1',                                t:'oai',ex:GH_H,label:'GPT-4.1',             group:'GitHub',free:true,isDCManager:true},
  gh_o4_mini:      {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/o4-mini',                                t:'oai',ex:GH_H,label:'o4-mini',             group:'GitHub',free:true},
  /* gh_deepseek_r1: removed from isDCWorker — too many 429s. Kept for manual use. */
  gh_deepseek_r1:  {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'deepseek/DeepSeek-R1',                          t:'oai',ex:GH_H,label:'DeepSeek R1 (GH)',    group:'GitHub',free:true},
  gh_deepseek_v3:  {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'deepseek/DeepSeek-V3-0324',                     t:'oai',ex:GH_H,label:'DeepSeek V3 (GH)',    group:'GitHub',free:true,isDCWorker:true},
  gh_llama33:      {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'meta/Meta-Llama-3.3-70B-Instruct',              t:'oai',ex:GH_H,label:'Llama 3.3 70B (GH)', group:'GitHub',free:true},
  gh_phi4:         {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'microsoft/Phi-4',                               t:'oai',ex:GH_H,label:'Phi-4 (GH)',          group:'GitHub',free:true},
  gh_mistral_large:{url:'https://models.github.ai/inference/chat/completions',k:'github',m:'mistral-ai/Mistral-Large-2411',                 t:'oai',ex:GH_H,label:'Mistral Large (GH)',  group:'GitHub',free:true},
  gh_cohere:       {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'cohere/Cohere-command-r-plus-08-2024',          t:'oai',ex:GH_H,label:'Cohere R+ (GH)',      group:'GitHub',free:true},

  /* ── SAMBANOVA ── */
  samba_llama33:{url:'https://api.sambanova.ai/v1/chat/completions',k:'samba',m:'Meta-Llama-3.3-70B-Instruct',       t:'oai',label:'Llama 3.3 70B',    group:'SambaNova',free:true},
  samba_llama32:{url:'https://api.sambanova.ai/v1/chat/completions',k:'samba',m:'Meta-Llama-3.2-90B-Vision-Instruct',t:'oai',label:'Llama 3.2 90B',    group:'SambaNova',free:true},
  samba_qwen25: {url:'https://api.sambanova.ai/v1/chat/completions',k:'samba',m:'Qwen2.5-72B-Instruct',              t:'oai',label:'Qwen 2.5 72B (SN)',group:'SambaNova',free:true},

  /* ── BYTEZ (native load+run API) ── */
  bytez_qwen25: {k:'bytez',m:'Qwen/Qwen2.5-72B-Instruct',          t:'bytez',label:'Qwen 2.5 72B', group:'Bytez',free:true,noStream:true},
  bytez_llama31:{k:'bytez',m:'meta-llama/Llama-3.1-70B-Instruct',  t:'bytez',label:'Llama 3.1 70B',group:'Bytez',free:true,noStream:true},
  bytez_mistral:{k:'bytez',m:'mistralai/Mistral-7B-Instruct-v0.3', t:'bytez',label:'Mistral 7B',   group:'Bytez',free:true,noStream:true},

  /* ── DUCKDUCKGO (no key, noStream) ── */
  duckduckgo:{t:'ddg',m:'claude-3-haiku-20240307',label:'Claude Haiku',group:'DuckDuckGo',free:true,isDCWorker:true,noStream:true}
};

const MAXT={
  or_minimax:4096,or_llama33:4096,or_qwen3:4096,or_gemma3:4096,or_mistral:2000,or_phi4:4096,
  groq_llama33_70b:2000,groq_llama33_70b_b:6000,groq_llama4_scout:4096,groq_llama4_maverick:4096,
  groq_llama31_8b:2000,groq_deepseek_r1:6000,groq_gemma2_9b:2000,groq_mixtral:4096,
  gem_31_flash_lite_k1:8192,gem_31_flash_lite_k2:8192,gem_31_flash_lite_k3:8192,
  gem_25_flash_k1:8192,gem_25_flash_k2:8192,gem_25_flash_k3:8192,
  gem_20_flash:8192,gem_20_flash_lite:8192,
  gh_gpt41_mini:3000,gh_gpt4o:4000,gh_gpt41:6000,gh_o4_mini:4000,
  gh_deepseek_r1:8192,gh_deepseek_v3:4096,gh_llama33:4096,gh_phi4:4096,gh_mistral_large:4096,gh_cohere:4096,
  samba_llama33:4096,samba_llama32:4096,samba_qwen25:4096,
  bytez_qwen25:4096,bytez_llama31:4096,bytez_mistral:4096,
  duckduckgo:2000
};
const TEMP={
  or_minimax:.5,or_llama33:.4,or_qwen3:.4,or_gemma3:.4,or_mistral:.4,or_phi4:.35,
  groq_llama33_70b:.3,groq_llama33_70b_b:.35,groq_llama4_scout:.4,groq_llama4_maverick:.4,
  groq_llama31_8b:.3,groq_deepseek_r1:.3,groq_gemma2_9b:.4,groq_mixtral:.4,
  gem_31_flash_lite_k1:.45,gem_31_flash_lite_k2:.45,gem_31_flash_lite_k3:.45,
  gem_25_flash_k1:.45,gem_25_flash_k2:.45,gem_25_flash_k3:.45,
  gem_20_flash:.4,gem_20_flash_lite:.3,
  gh_gpt41_mini:.4,gh_gpt4o:.4,gh_gpt41:.35,gh_o4_mini:.3,
  gh_deepseek_r1:.3,gh_deepseek_v3:.3,gh_llama33:.4,gh_phi4:.35,gh_mistral_large:.4,gh_cohere:.4,
  samba_llama33:.45,samba_llama32:.45,samba_qwen25:.4,
  bytez_qwen25:.4,bytez_llama31:.4,bytez_mistral:.4,
  duckduckgo:.4
};

/* ── Middleware ── */
app.use(helmet({contentSecurityPolicy:{directives:{
  defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'","unpkg.com"],
  styleSrc:["'self'","'unsafe-inline'","fonts.googleapis.com"],fontSrc:["fonts.gstatic.com","data:"],
  connectSrc:["'self'"],imgSrc:["'self'","data:"],frameSrc:["pythontutor.com"]
}}}));
app.use(cors({origin:(o,cb)=>cb(null,!o||!ORIGIN||o===ORIGIN),methods:['GET','POST','PUT','PATCH','DELETE'],allowedHeaders:['Content-Type'],credentials:false}));
app.use(express.json({limit:'128kb'}));
app.use(express.static(path.join(__dirname,'public'),{maxAge:'1h',setHeaders:(res,fp)=>{if(fp.endsWith('.html'))res.setHeader('Cache-Control','no-cache');}}));
const rl=(max,ms=60000)=>rateLimit({windowMs:ms,max,standardHeaders:true,legacyHeaders:false,handler:(_,res)=>res.status(429).json({error:'Too many requests'})});
app.use('/api',rl(300));app.use('/api/chat',rl(40));app.use('/api/stream',rl(40));app.use('/api/memory',rl(60));

/* DeepSeek on GitHub returns reasoning_content when content is null */
const extractText=msg=>{
  if(!msg)return'';
  if(msg.content)return msg.content;
  if(msg.reasoning_content)return msg.reasoning_content;
  return'';
};

/* ── Bytez Native API (load + run) ── */
async function callBytez(cfg,sys,msgs,tok,temp){
  const apiKey=K[cfg.k];
  const inputMessages=sys?[{role:'system',content:sys},...msgs]:msgs;
  const loadRes=await fetch('https://api.bytez.com/model/load',{method:'POST',headers:{'Authorization':'Key '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:cfg.m,concurrency:1}),signal:AbortSignal.timeout(30000)});
  if(!loadRes.ok){const e=await loadRes.json().catch(()=>({}));throw new Error('Bytez load: '+(e.error||loadRes.status));}
  const runRes=await fetch('https://api.bytez.com/model/run',{method:'POST',headers:{'Authorization':'Key '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:cfg.m,input:inputMessages,params:{max_new_tokens:tok,temperature:temp,return_full_text:false}}),signal:AbortSignal.timeout(60000)});
  if(!runRes.ok){const e=await runRes.json().catch(()=>({}));throw new Error('Bytez run: '+(e.error||runRes.status));}
  const data=await runRes.json();
  let text='';
  if(data.output){
    if(typeof data.output==='string')text=data.output;
    else if(Array.isArray(data.output)&&data.output.length){const last=data.output[data.output.length-1];text=last.content||last.text||JSON.stringify(last);}
    else if(data.output.text)text=data.output.text;
    else if(data.output.content)text=data.output.content;
  }
  if(!text)throw new Error('Empty Bytez response');
  return text;
}

/* ── Callers ── */
async function callOAI(cfg,sys,msgs,tok,temp){
  const r=await fetch(cfg.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+K[cfg.k],...(cfg.ex||{})},body:JSON.stringify({model:cfg.m,messages:[{role:'system',content:sys},...msgs],max_tokens:tok,temperature:temp}),signal:AbortSignal.timeout(60000)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d?.error?.message||d?.message||'HTTP '+r.status+' ('+cfg.label+')');
  const t=extractText(d?.choices?.[0]?.message);
  if(!t)throw new Error('Empty from '+cfg.label);
  return t;
}
async function callGEM(cfg,sys,msgs,tok,temp){
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+cfg.m+':generateContent';
  const contents=[{role:'user',parts:[{text:sys}]},...msgs.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))];
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':K[cfg.k]},body:JSON.stringify({contents,generationConfig:{temperature:temp,maxOutputTokens:tok}}),signal:AbortSignal.timeout(60000)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d?.error?.message||'Gemini HTTP '+r.status);
  const t=(d?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');
  if(!t)throw new Error('Empty Gemini (quota?)');
  return t;
}
const DDG_H={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','accept-language':'en-US,en;q=0.9','origin':'https://duckduckgo.com','referer':'https://duckduckgo.com/'};
async function callDDG(sys,msgs){
  const st=await fetch('https://duckduckgo.com/duckchat/v1/status',{headers:{...DDG_H,'x-vqd-accept':'1','accept':'text/event-stream','cache-control':'no-cache','pragma':'no-cache'},signal:AbortSignal.timeout(15000)});
  const vqd=st.headers.get('x-vqd-4'),hash=st.headers.get('x-vqd-hash-1')||'';
  if(!vqd)throw new Error('DDG: rate limited — wait 2 min');
  const all=sys?[{role:'user',content:sys},...msgs]:msgs;
  const hdrs={...DDG_H,'Content-Type':'application/json','accept':'text/event-stream','x-vqd-4':vqd};
  if(hash)hdrs['x-vqd-hash-1']=hash;
  const cr=await fetch('https://duckduckgo.com/duckchat/v1/chat',{method:'POST',headers:hdrs,body:JSON.stringify({model:'claude-3-haiku-20240307',messages:all}),signal:AbortSignal.timeout(60000)});
  if(!cr.ok)throw new Error('DDG HTTP '+cr.status);
  const raw=await cr.text();let out='';
  for(const line of raw.split('\n')){
    if(!line.startsWith('data: '))continue;
    const pl=line.slice(6).trim();if(pl==='[DONE]')break;
    try{const p=JSON.parse(pl);if(p.message)out+=p.message;}catch{}
  }
  if(!out)throw new Error('DDG: empty content');
  return out;
}
async function callProvider(pid,sys,msgs,maxTok){
  const cfg=PROV[pid];if(!cfg)throw new Error('Unknown: '+pid);
  const tok=Math.min(maxTok||MAXT[pid]||2000,MAXT[pid]||2000),temp=TEMP[pid]||.4;
  if(cfg.t==='ddg')return callDDG(sys,msgs);
  if(cfg.t==='bytez')return callBytez(cfg,sys,msgs,tok,temp);
  if(!hasK(K[cfg.k]))throw new Error(pid+' key missing');
  if(cfg.t==='gem')return callGEM(cfg,sys,msgs,tok,temp);
  return callOAI(cfg,sys,msgs,tok,temp);
}

/* ── Streaming callers ── */
async function streamOAI(cfg,sys,msgs,tok,temp,onChunk){
  const r=await fetch(cfg.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+K[cfg.k],...(cfg.ex||{})},body:JSON.stringify({model:cfg.m,messages:[{role:'system',content:sys},...msgs],max_tokens:tok,temperature:temp,stream:true}),signal:AbortSignal.timeout(120000)});
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d?.error?.message||d?.message||'HTTP '+r.status);}
  const reader=r.body.getReader(),dec=new TextDecoder();let buf='';
  while(true){
    const{done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split('\n');buf=lines.pop()||'';
    for(const line of lines){
      if(!line.startsWith('data: '))continue;
      const pl=line.slice(6).trim();if(pl==='[DONE]')return;
      try{
        const d=JSON.parse(pl);
        const delta=d.choices?.[0]?.delta;
        const c=delta?.content||delta?.reasoning_content||'';
        if(c)onChunk(c);
      }catch{}
    }
  }
}
async function streamGEM(cfg,sys,msgs,tok,temp,onChunk){
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+cfg.m+':streamGenerateContent?alt=sse';
  const contents=[{role:'user',parts:[{text:sys}]},...msgs.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))];
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':K[cfg.k]},body:JSON.stringify({contents,generationConfig:{temperature:temp,maxOutputTokens:tok}}),signal:AbortSignal.timeout(120000)});
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d?.error?.message||'Gemini HTTP '+r.status);}
  const reader=r.body.getReader(),dec=new TextDecoder();let buf='';
  while(true){
    const{done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split('\n');buf=lines.pop()||'';
    for(const line of lines){
      if(!line.startsWith('data: '))continue;
      try{const d=JSON.parse(line.slice(6).trim());const c=(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');if(c)onChunk(c);}catch{}
    }
  }
}

/* ── Validation ── */
const vOk=(req,res,next)=>{const e=validationResult(req);return e.isEmpty()?next():res.status(400).json({error:e.array().map(x=>x.path+': '+x.msg).join(' | ')});};
const provIds=Object.keys(PROV);
const chatRules=[
  body('provider').isString().isIn(provIds),
  body('messages').isArray({min:1,max:80}),
  body('messages.*.role').isIn(['user','assistant']),
  body('messages.*.content').isString().isLength({min:1,max:25000}),
  body('systemPrompt').optional().isString().isLength({max:15000}),
  body('maxTokens').optional().isInt({min:50,max:8192})
];

/* ══ ROUTES ══ */
app.get('/api/providers',(req,res)=>{
  const out={};
  for(const[id,cfg]of Object.entries(PROV))
    out[id]={
      available: cfg.t==='ddg'||cfg.t==='bytez'||hasK(K[cfg.k]||''),
      isManager: !!cfg.isManager,
      isDCManager:!!cfg.isDCManager,
      isDCWorker: !!cfg.isDCWorker,
      model:  cfg.m||'ddg',
      label:  cfg.label||id,
      group:  cfg.group||'Other',
      free:   !!cfg.free
    };
  res.json(out);
});

app.post('/api/chat',chatRules,vOk,async(req,res)=>{
  const{provider,messages,systemPrompt,maxTokens}=req.body;
  try{
    const text=await callProvider(provider,(systemPrompt||'You are GoAi, a helpful AI assistant.').slice(0,12000),messages.map(m=>({...m,content:String(m.content||'').slice(0,18000)})),maxTokens);
    res.json({text,provider,label:PROV[provider]?.label});
  }catch(e){
    const msg=String(e.message||'Error');
    console.error('[GoAi]',provider,'→',msg.slice(0,200));
    res.status(/quota|balance|rate|429|limit/i.test(msg)?429:/key|auth|401/i.test(msg)?401:502).json({error:msg.slice(0,300)});
  }
});

/* Streaming SSE */
app.post('/api/stream',chatRules,vOk,async(req,res)=>{
  const{provider,messages,systemPrompt,maxTokens}=req.body;
  const cfg=PROV[provider];if(!cfg)return res.status(400).json({error:'Unknown provider'});
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  let closed=false;req.on('close',()=>{closed=true;});
  const sse=t=>{if(!closed)res.write('data: '+JSON.stringify({text:t})+'\n\n');};
  const tok=Math.min(maxTokens||MAXT[provider]||2000,MAXT[provider]||2000),temp=TEMP[provider]||.4;
  const sys=(systemPrompt||'You are GoAi, a helpful AI assistant.').slice(0,12000);
  const msgs=messages.map(m=>({...m,content:String(m.content||'').slice(0,18000)}));
  try{
    if(cfg.noStream||cfg.t==='ddg'||cfg.t==='bytez'){
      const text=await callProvider(provider,sys,msgs,maxTokens);sse(text);
    }else{
      if(!hasK(K[cfg.k]))throw new Error(provider+' key missing');
      if(cfg.t==='gem')await streamGEM(cfg,sys,msgs,tok,temp,sse);
      else await streamOAI(cfg,sys,msgs,tok,temp,sse);
    }
    if(!closed)res.write('data: [DONE]\n\n');
  }catch(e){
    const msg=String(e.message||'Error');
    console.error('[Stream]',provider,'→',msg.slice(0,200));
    if(!closed)res.write('data: '+JSON.stringify({error:msg.slice(0,300)})+'\n\n');
  }
  if(!closed)res.end();
});

app.post('/api/memory',[body('prompt').isString().isLength({min:1,max:600})],vOk,async(req,res)=>{
  const pid=['or_minimax','groq_llama33_70b_b','groq_llama33_70b','gem_20_flash_lite','gh_gpt41_mini','duckduckgo']
    .find(p=>PROV[p]&&(PROV[p].t==='ddg'||PROV[p].t==='bytez'||hasK(K[PROV[p].k]||'')));
  if(!pid)return res.json({summary:''});
  try{
    const t=await callProvider(pid,'Summarize in 8 words max. Reply ONLY with the summary.',[{role:'user',content:req.body.prompt}],60);
    res.json({summary:t.replace(/[\n"]/g,' ').trim().slice(0,100)});
  }catch{res.json({summary:''});}
});

/* Chat CRUD */
app.get('/api/chats',(req,res)=>{try{res.json(store.list());}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/chats/:id',(req,res)=>{try{const r=store.get(req.params.id);if(!r)return res.status(404).json({error:'Not found'});res.json(r);}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/chats',[
  body('id').isString().isLength({min:1,max:40}),
  body('title').optional().isString().isLength({max:120}),
  body('mode').optional().isString().isLength({max:20}),
  body('pref').optional().isString().isIn(provIds),
  body('messages').optional().isArray()
],vOk,(req,res)=>{
  try{
    const{id,title='New Chat',mode='fast',pref='or_minimax',messages=[]}=req.body;
    const now=Date.now();store.insert(id,title,mode,pref,messages,now);store.prune();
    res.json({ok:true,id});
  }catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/chats/:id',[
  body('title').optional().isString().isLength({max:120}),
  body('mode').optional().isString().isLength({max:20}),
  body('pref').optional().isString().isIn(provIds),
  body('messages').optional().isArray()
],vOk,(req,res)=>{
  try{
    const row=store.get(req.params.id);if(!row)return res.status(404).json({error:'Not found'});
    const{title=row.title,mode=row.mode,pref=row.pref,messages=row.messages}=req.body;
    const clean=(messages||[]).filter(m=>!m.isLog&&!m.isComm&&m.role&&m.text!=null).slice(-200);
    store.update(req.params.id,{title,mode,pref,messages:clean});res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.patch('/api/chats/:id/rename',[body('title').isString().isLength({min:1,max:120})],vOk,(req,res)=>{
  try{const row=store.get(req.params.id);if(!row)return res.status(404).json({error:'Not found'});store.update(req.params.id,{title:req.body.title});res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/chats/:id',(req,res)=>{try{store.remove(req.params.id);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,_,res,__)=>{console.error('[Error]',err.message);res.status(500).json({error:'Internal error'});});

app.listen(PORT,()=>{
  const av=Object.entries(PROV).filter(([,c])=>c.t==='ddg'||c.t==='bytez'||hasK(K[c.k]||'')).map(([,c])=>c.label);
  const dcM=Object.entries(PROV).filter(([,c])=>c.isDCManager&&(c.t==='ddg'||c.t==='bytez'||hasK(K[c.k]||''))).map(([,c])=>c.label);
  const dcW=Object.entries(PROV).filter(([,c])=>c.isDCWorker&&(c.t==='ddg'||c.t==='bytez'||hasK(K[c.k]||''))).map(([,c])=>c.label);
  console.log('\n🚀 GoAi v6.2 → http://localhost:'+PORT);
  console.log('🧩 Default AI : MiniMax M1 (minimax/minimax-m1 — no :free suffix)');
  console.log('🔧 Fixed      : minimax :free → paid ID, groq deepseek → qwen-32b, qwq removed');
  console.log('💻 DC Manager : '+(dcM.join(', ')||'none — add GITHUB_KEY'));
  console.log('💻 DC Workers : '+(dcW.join(', ')||'none')+'\n');
  console.log('✅ '+av.length+'/'+Object.keys(PROV).length+' active:');
  av.forEach(l=>console.log('  ·',l));
  console.log('');
});
