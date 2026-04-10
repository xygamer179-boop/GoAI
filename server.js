require('dotenv').config();
const express=require('express'),helmet=require('helmet'),cors=require('cors'),rateLimit=require('express-rate-limit'),{body,validationResult}=require('express-validator'),path=require('path'),fs=require('fs');

/* ── JSON Store ── */
const DB_PATH=path.join(__dirname,'goai.json');
function loadDB(){try{return JSON.parse(fs.readFileSync(DB_PATH,'utf8'));}catch{return{chats:{}};}}
function saveDB(d){fs.writeFileSync(DB_PATH,JSON.stringify(d),'utf8');}
if(!fs.existsSync(DB_PATH))saveDB({chats:{}});
const stmts={
  listChats:()=>Object.values(loadDB().chats).sort((a,b)=>b.updated_at-a.updated_at).map(({id,title,mode,pref,messages,created_at,updated_at})=>({id,title,mode,pref,created_at,updated_at,msg_count:(messages||[]).length})),
  getChat:(id)=>loadDB().chats[id]||null,
  insertChat:(id,title,mode,pref,messages,created_at,updated_at)=>{const db=loadDB();db.chats[id]={id,title,mode,pref,messages:JSON.parse(messages),created_at,updated_at};saveDB(db);},
  updateChat:(title,mode,pref,messages,updated_at,id)=>{const db=loadDB();if(!db.chats[id])return;db.chats[id]={...db.chats[id],title,mode,pref,messages:JSON.parse(messages),updated_at};saveDB(db);},
  deleteChat:(id)=>{const db=loadDB();delete db.chats[id];saveDB(db);},
  pruneChats:()=>{const db=loadDB();const sorted=Object.values(db.chats).sort((a,b)=>b.updated_at-a.updated_at);if(sorted.length>200){const keep=new Set(sorted.slice(0,200).map(c=>c.id));db.chats=Object.fromEntries(Object.entries(db.chats).filter(([id])=>keep.has(id)));saveDB(db);}}
};

const app=express(),PORT=process.env.PORT||3000,ORIGIN=process.env.ORIGIN||'http://localhost:'+PORT;
app.set('trust proxy',1);

/* ── API Keys ── */
const K={
  groq1:  process.env.GROQ1_KEY||'',
  groq2:  process.env.GROQ2_KEY||'',
  gem1:   process.env.GEMINI1_KEY||'',
  gem2:   process.env.GEMINI2_KEY||'',
  gem3:   process.env.GEMINI3_KEY||'',
  or:     process.env.OR_KEY||'',
  github: process.env.GITHUB_KEY||'',
  samba:  process.env.SAMBA_KEY||'',
  bytez:  process.env.BYTEZ_KEY||''
};
const hasK=k=>!!(k&&k.length>8&&!k.startsWith('PASTE_'));
const GH_H={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
const OR_H={'HTTP-Referer':ORIGIN,'X-Title':'GoAi'};

/* ── Providers ──
   Each entry: url, k (key name), m (model id), t (type: oai|gem|ddg), ex (extra headers), label, group, free
*/
const PROV={
  /* ── GROQ (all free) ── */
  groq_llama33_70b:    {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'llama-3.3-70b-versatile',       t:'oai',label:'Llama 3.3 70B',           group:'Groq',      free:true},
  groq_llama33_70b_b:  {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'llama-3.3-70b-versatile',       t:'oai',label:'Llama 3.3 70B (B)',        group:'Groq',      free:true,isManager:true},
  groq_llama4_scout:   {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'meta-llama/llama-4-scout-17b-16e-instruct',t:'oai',label:'Llama 4 Scout 17B',group:'Groq',free:true},
  groq_llama4_maverick:{url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'meta-llama/llama-4-maverick-17b-128e-instruct',t:'oai',label:'Llama 4 Maverick 17B',group:'Groq',free:true},
  groq_llama31_8b:     {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'llama-3.1-8b-instant',          t:'oai',label:'Llama 3.1 8B Instant',     group:'Groq',      free:true},
  groq_deepseek_r1:    {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'deepseek-r1-distill-llama-70b', t:'oai',label:'DeepSeek R1 Distill 70B',  group:'Groq',      free:true},
  groq_qwen_qwq:       {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'qwen-qwq-32b',                  t:'oai',label:'Qwen QwQ 32B',              group:'Groq',      free:true},
  groq_gemma2_9b:      {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'gemma2-9b-it',                  t:'oai',label:'Gemma 2 9B',                group:'Groq',      free:true},
  groq_mixtral:        {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'mixtral-8x7b-32768',            t:'oai',label:'Mixtral 8x7B',              group:'Groq',      free:true},
  groq_compound:       {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'compound-beta',                 t:'oai',label:'Compound Beta',             group:'Groq',      free:true},

  /* ── GEMINI (free tier) ── */
  gem_25_flash_k1:     {k:'gem1',m:'gemini-2.5-flash',      t:'gem',label:'Gemini 2.5 Flash',        group:'Gemini',free:true},
  gem_25_flash_k2:     {k:'gem2',m:'gemini-2.5-flash',      t:'gem',label:'Gemini 2.5 Flash (K2)',   group:'Gemini',free:true},
  gem_25_flash_k3:     {k:'gem3',m:'gemini-2.5-flash',      t:'gem',label:'Gemini 2.5 Flash (K3)',   group:'Gemini',free:true},
  gem_20_flash:        {k:'gem1',m:'gemini-2.0-flash',       t:'gem',label:'Gemini 2.0 Flash',        group:'Gemini',free:true},
  gem_20_flash_lite:   {k:'gem2',m:'gemini-2.0-flash-lite',  t:'gem',label:'Gemini 2.0 Flash Lite',   group:'Gemini',free:true},
  gem_15_flash:        {k:'gem3',m:'gemini-1.5-flash',       t:'gem',label:'Gemini 1.5 Flash',        group:'Gemini',free:true},
  gem_15_flash_8b:     {k:'gem1',m:'gemini-1.5-flash-8b',    t:'gem',label:'Gemini 1.5 Flash 8B',     group:'Gemini',free:true},
  gem_25_pro:          {k:'gem2',m:'gemini-2.5-pro-preview-06-05',t:'gem',label:'Gemini 2.5 Pro',     group:'Gemini',free:true},

  /* ── OPENROUTER free models ── */
  or_deepseek_r1:      {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'deepseek/deepseek-r1:free',                    t:'oai',ex:OR_H,label:'DeepSeek R1',              group:'OpenRouter',free:true,isDCManager:true},
  or_deepseek_v3:      {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'deepseek/deepseek-chat-v3-0324:free',           t:'oai',ex:OR_H,label:'DeepSeek V3',              group:'OpenRouter',free:true,isDCWorker:true},
  or_kimi_k2:          {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'moonshotai/kimi-k2:free',                      t:'oai',ex:OR_H,label:'Kimi K2',                  group:'OpenRouter',free:true,isDCWorker:true},
  or_minimax:          {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'minimax/minimax-m1:free',                      t:'oai',ex:OR_H,label:'MiniMax M1',               group:'OpenRouter',free:true,isDCWorker:true},
  or_llama33:          {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'meta-llama/llama-3.3-70b-instruct:free',       t:'oai',ex:OR_H,label:'Llama 3.3 70B Free',       group:'OpenRouter',free:true},
  or_qwen3:            {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'qwen/qwen3-235b-a22b:free',                    t:'oai',ex:OR_H,label:'Qwen3 235B',               group:'OpenRouter',free:true},
  or_gemma3:           {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'google/gemma-3-27b-it:free',                   t:'oai',ex:OR_H,label:'Gemma 3 27B',              group:'OpenRouter',free:true},
  or_phi4:             {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'microsoft/phi-4-reasoning-plus:free',          t:'oai',ex:OR_H,label:'Phi-4 Reasoning',          group:'OpenRouter',free:true},
  or_mistral:          {url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'mistralai/mistral-7b-instruct:free',           t:'oai',ex:OR_H,label:'Mistral 7B',               group:'OpenRouter',free:true},

  /* ── GITHUB MODELS (free with PAT) ── */
  gh_gpt41_mini:       {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4.1-mini',                t:'oai',ex:GH_H,label:'GPT-4.1 Mini',             group:'GitHub',free:true},
  gh_gpt4o:            {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4o',                      t:'oai',ex:GH_H,label:'GPT-4o',                   group:'GitHub',free:true},
  gh_gpt41:            {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4.1',                     t:'oai',ex:GH_H,label:'GPT-4.1',                  group:'GitHub',free:true},
  gh_o4_mini:          {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/o4-mini',                     t:'oai',ex:GH_H,label:'o4-mini',                  group:'GitHub',free:true},
  gh_deepseek_r1:      {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'deepseek/DeepSeek-R1',               t:'oai',ex:GH_H,label:'DeepSeek R1 (GH)',         group:'GitHub',free:true,isDCWorker:true},
  gh_deepseek_v3:      {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'deepseek/DeepSeek-V3-0324',          t:'oai',ex:GH_H,label:'DeepSeek V3 (GH)',         group:'GitHub',free:true,isDCWorker:true},
  gh_llama33:          {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'meta/Meta-Llama-3.3-70B-Instruct',   t:'oai',ex:GH_H,label:'Llama 3.3 70B (GH)',       group:'GitHub',free:true},
  gh_phi4:             {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'microsoft/Phi-4',                    t:'oai',ex:GH_H,label:'Phi-4 (GH)',               group:'GitHub',free:true},
  gh_mistral_large:    {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'mistral-ai/Mistral-Large-2411',      t:'oai',ex:GH_H,label:'Mistral Large (GH)',       group:'GitHub',free:true},
  gh_cohere:           {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'cohere/Cohere-command-r-plus-08-2024',t:'oai',ex:GH_H,label:'Cohere R+ (GH)',          group:'GitHub',free:true},
  gh_jamba:            {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'ai21labs/AI21-Jamba-1.6-Large',      t:'oai',ex:GH_H,label:'Jamba 1.6 Large (GH)',     group:'GitHub',free:true},

  /* ── SAMBANOVA (free) ── */
  samba_llama33:       {url:'https://api.sambanova.ai/v1/chat/completions',k:'samba',m:'Meta-Llama-3.3-70B-Instruct',               t:'oai',label:'Llama 3.3 70B',            group:'SambaNova', free:true},
  samba_llama32_90b:   {url:'https://api.sambanova.ai/v1/chat/completions',k:'samba',m:'Meta-Llama-3.2-90B-Vision-Instruct',        t:'oai',label:'Llama 3.2 90B Vision',     group:'SambaNova', free:true},
  samba_deepseek_r1:   {url:'https://api.sambanova.ai/v1/chat/completions',k:'samba',m:'DeepSeek-R1',                               t:'oai',label:'DeepSeek R1 (SN)',          group:'SambaNova', free:true,isDCWorker:true},

  /* ── BYTEZ (free) ── */
  bytez_qwen25:        {url:'https://api.bytez.com/models/v2/openai/v1/chat/completions',k:'bytez',m:'Qwen/Qwen2.5-72B-Instruct',  t:'oai',label:'Qwen 2.5 72B',             group:'Bytez',     free:true},
  bytez_llama31:       {url:'https://api.bytez.com/models/v2/openai/v1/chat/completions',k:'bytez',m:'meta-llama/Llama-3.1-70B-Instruct',t:'oai',label:'Llama 3.1 70B',      group:'Bytez',     free:true},
  bytez_mistral:       {url:'https://api.bytez.com/models/v2/openai/v1/chat/completions',k:'bytez',m:'mistralai/Mistral-7B-Instruct-v0.3',t:'oai',label:'Mistral 7B',        group:'Bytez',     free:true},

  /* ── DUCKDUCKGO (completely free, no key) ── */
  duckduckgo:          {t:'ddg',m:'claude-3-haiku-20240307',label:'Claude Haiku (DDG)',group:'DuckDuckGo',free:true,isDCWorker:true}
};

/* ── Token limits & temps ── */
const MAXT={
  groq_llama33_70b:2000,groq_llama33_70b_b:6000,groq_llama4_scout:4096,groq_llama4_maverick:4096,
  groq_llama31_8b:2000,groq_deepseek_r1:4096,groq_qwen_qwq:4096,groq_gemma2_9b:2000,groq_mixtral:4096,groq_compound:2000,
  gem_25_flash_k1:8192,gem_25_flash_k2:8192,gem_25_flash_k3:8192,gem_20_flash:8192,gem_20_flash_lite:8192,
  gem_15_flash:8192,gem_15_flash_8b:4096,gem_25_pro:8192,
  or_deepseek_r1:8192,or_deepseek_v3:4096,or_kimi_k2:8192,or_minimax:4096,or_llama33:4096,
  or_qwen3:4096,or_gemma3:4096,or_phi4:4096,or_mistral:2000,
  gh_gpt41_mini:3000,gh_gpt4o:4000,gh_gpt41:4000,gh_o4_mini:4000,
  gh_deepseek_r1:8192,gh_deepseek_v3:4096,gh_llama33:4096,gh_phi4:4096,gh_mistral_large:4096,gh_cohere:4096,gh_jamba:4096,
  samba_llama33:4096,samba_llama32_90b:4096,samba_deepseek_r1:8192,
  bytez_qwen25:3000,bytez_llama31:3000,bytez_mistral:2000,
  duckduckgo:2000
};
const TEMP={
  groq_llama33_70b:.3,groq_llama33_70b_b:.35,groq_llama4_scout:.4,groq_llama4_maverick:.4,
  groq_llama31_8b:.3,groq_deepseek_r1:.3,groq_qwen_qwq:.35,groq_gemma2_9b:.4,groq_mixtral:.4,groq_compound:.4,
  gem_25_flash_k1:.45,gem_25_flash_k2:.45,gem_25_flash_k3:.45,gem_20_flash:.4,gem_20_flash_lite:.3,
  gem_15_flash:.4,gem_15_flash_8b:.4,gem_25_pro:.5,
  or_deepseek_r1:.3,or_deepseek_v3:.3,or_kimi_k2:.4,or_minimax:.5,or_llama33:.4,
  or_qwen3:.4,or_gemma3:.4,or_phi4:.35,or_mistral:.4,
  gh_gpt41_mini:.4,gh_gpt4o:.4,gh_gpt41:.4,gh_o4_mini:.3,
  gh_deepseek_r1:.3,gh_deepseek_v3:.3,gh_llama33:.4,gh_phi4:.35,gh_mistral_large:.4,gh_cohere:.4,gh_jamba:.4,
  samba_llama33:.45,samba_llama32_90b:.45,samba_deepseek_r1:.3,
  bytez_qwen25:.4,bytez_llama31:.4,bytez_mistral:.4,
  duckduckgo:.4
};

/* ── Middleware ── */
app.use(helmet({contentSecurityPolicy:{directives:{
  defaultSrc:["'self'"],
  scriptSrc:["'self'","'unsafe-inline'","unpkg.com"],
  styleSrc:["'self'","'unsafe-inline'","fonts.googleapis.com"],
  fontSrc:["fonts.gstatic.com","data:"],
  connectSrc:["'self'"],
  imgSrc:["'self'","data:"],
  frameSrc:["pythontutor.com"]
}}}));
app.use(cors({origin:(o,cb)=>cb(null,!o||!ORIGIN||o===ORIGIN),methods:['GET','POST','PUT','DELETE'],allowedHeaders:['Content-Type'],credentials:false}));
app.use(express.json({limit:'128kb'}));
app.use(express.static(path.join(__dirname,'public'),{maxAge:'1h',setHeaders:(res,fp)=>{if(fp.endsWith('.html'))res.setHeader('Cache-Control','no-cache');}}));
const rl=(max,ms=60000)=>rateLimit({windowMs:ms,max,standardHeaders:true,legacyHeaders:false,handler:(_,res)=>res.status(429).json({error:'Too many requests'})});
app.use('/api',rl(200));
app.use('/api/chat',rl(40));
app.use('/api/memory',rl(60));

/* ── Callers ── */
async function callOAI(cfg,sys,msgs,tok,temp){
  const r=await fetch(cfg.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+K[cfg.k],...(cfg.ex||{})},body:JSON.stringify({model:cfg.m,messages:[{role:'system',content:sys},...msgs],max_tokens:tok,temperature:temp}),signal:AbortSignal.timeout(60000)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d?.error?.message||d?.message||'HTTP '+r.status+' ('+cfg.label+')');
  const t=d?.choices?.[0]?.message?.content||'';
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
    const pl=line.slice(6).trim();
    if(pl==='[DONE]')break;
    try{const p=JSON.parse(pl);if(p.message)out+=p.message;}catch{}
  }
  if(!out)throw new Error('DDG: empty content');
  return out;
}
async function callProvider(pid,sys,msgs,maxTok){
  const cfg=PROV[pid];if(!cfg)throw new Error('Unknown provider: '+pid);
  const tok=Math.min(maxTok||MAXT[pid]||2000,MAXT[pid]||2000),temp=TEMP[pid]||.4;
  if(cfg.t==='ddg')return callDDG(sys,msgs);
  if(!hasK(K[cfg.k]))throw new Error(pid+' key missing');
  if(cfg.t==='gem')return callGEM(cfg,sys,msgs,tok,temp);
  return callOAI(cfg,sys,msgs,tok,temp);
}

/* ── Validation helpers ── */
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
app.get('/api/providers',(req,res)=>{
  const out={};
  for(const[id,cfg]of Object.entries(PROV)){
    out[id]={
      available: cfg.t==='ddg'||hasK(K[cfg.k]||''),
      isManager: !!cfg.isManager,
      isDCManager:!!cfg.isDCManager,
      isDCWorker: !!cfg.isDCWorker,
      model:  cfg.m||'ddg',
      label:  cfg.label||id,
      group:  cfg.group||'Other',
      free:   !!cfg.free
    };
  }
  res.json(out);
});

/* Chat completion */
app.post('/api/chat',chatRules,vOk,async(req,res)=>{
  const{provider,messages,systemPrompt,maxTokens}=req.body;
  try{
    const text=await callProvider(
      provider,
      (systemPrompt||'You are GoAi, a helpful AI assistant.').slice(0,12000),
      messages.map(m=>({...m,content:String(m.content||'').slice(0,18000)})),
      maxTokens
    );
    res.json({text,provider,label:PROV[provider]?.label});
  }catch(e){
    const msg=String(e.message||'Error');
    console.error('[GoAi]',provider,'→',msg.slice(0,200));
    res.status(/quota|balance|rate|429|limit/i.test(msg)?429:/key|auth|401/i.test(msg)?401:502).json({error:msg.slice(0,300)});
  }
});

/* Memory summary */
app.post('/api/memory',[body('prompt').isString().isLength({min:1,max:600})],vOk,async(req,res)=>{
  const pid=['groq_llama33_70b_b','groq_llama33_70b','gem_20_flash_lite','gh_gpt41_mini','duckduckgo']
    .find(p=>PROV[p]&&(PROV[p].t==='ddg'||hasK(K[PROV[p].k]||'')));
  if(!pid)return res.json({summary:''});
  try{
    const t=await callProvider(pid,'Summarize in 8 words max. Reply ONLY with the summary.',[{role:'user',content:req.body.prompt}],60);
    res.json({summary:t.replace(/[\n"]/g,' ').trim().slice(0,100)});
  }catch{res.json({summary:''});}
});

/* ═══ JSON Chat CRUD ═══ */
app.get('/api/chats',(req,res)=>{
  try{res.json(stmts.listChats());}
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/chats/:id',(req,res)=>{
  try{
    const row=stmts.getChat(req.params.id);
    if(!row)return res.status(404).json({error:'Not found'});
    res.json(row);
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/chats',[
  body('id').isString().isLength({min:1,max:40}),
  body('title').optional().isString().isLength({max:120}),
  body('mode').optional().isString().isLength({max:20}),
  body('pref').optional().isString().isIn(provIds),
  body('messages').optional().isArray()
],vOk,(req,res)=>{
  try{
    const{id,title='New Chat',mode='fast',pref='groq_llama33_70b',messages=[]}=req.body;
    const now=Date.now();
    stmts.insertChat(id,title,mode,pref,JSON.stringify(messages),now,now);
    stmts.pruneChats();
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
    const row=stmts.getChat(req.params.id);
    if(!row)return res.status(404).json({error:'Not found'});
    const existing=row.messages||[];
    const{title=row.title,mode=row.mode,pref=row.pref,messages=existing}=req.body;
    // Keep max 200 messages per chat, strip isLog/isComm from persistence
    const clean=messages.filter(m=>!m.isLog&&!m.isComm&&m.role&&m.text!=null).slice(-200);
    stmts.updateChat(title,mode,pref,JSON.stringify(clean),Date.now(),req.params.id);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/chats/:id',(req,res)=>{
  try{stmts.deleteChat(req.params.id);res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});

/* SPA fallback */
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,_,res,__)=>{console.error('[Error]',err.message);res.status(500).json({error:'Internal error'});});

/* ── Start ── */
app.listen(PORT,()=>{
  const av=Object.entries(PROV).filter(([,c])=>c.t==='ddg'||hasK(K[c.k]||'')).map(([,c])=>c.label);
  const dcM=Object.entries(PROV).filter(([,c])=>c.isDCManager&&(c.t==='ddg'||hasK(K[c.k]||''))).map(([,c])=>c.label);
  const dcW=Object.entries(PROV).filter(([,c])=>c.isDCWorker&&(c.t==='ddg'||hasK(K[c.k]||''))).map(([,c])=>c.label);
  console.log('\n🚀 GoAi v6 → http://localhost:'+PORT);
  console.log('🗄️  JSON store: goai.json');
  console.log('✅ '+av.length+'/'+Object.keys(PROV).length+' providers active\n');
  console.log('💻 DeepCoder Manager: '+(dcM.join(', ')||'none'));
  console.log('💻 DeepCoder Workers: '+(dcW.join(', ')||'none')+'\n');
  av.forEach(l=>console.log('   ·',l));
  console.log('');
});