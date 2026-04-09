require('dotenv').config();
const express=require('express'),helmet=require('helmet'),cors=require('cors'),rateLimit=require('express-rate-limit'),{body,validationResult}=require('express-validator'),path=require('path');
const app=express(),PORT=process.env.PORT||3000,ORIGIN='http://localhost:3000';
app.set('trust proxy',1);

const K={groq1:process.env.GROQ1_KEY||'',groq2:process.env.GROQ2_KEY||'',gemini1:process.env.GEMINI1_KEY||'',gemini2:process.env.GEMINI2_KEY||'',gemini3:process.env.GEMINI3_KEY||'',or:process.env.OR_KEY||'',github:process.env.GITHUB_KEY||'',samba:process.env.SAMBA_KEY||'',bytez:process.env.BYTEZ_KEY||''};
const hasK=k=>!!(k&&k.length>8&&!k.startsWith('PASTE_'));
const GH_H={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
const OR_H={'HTTP-Referer':ORIGIN,'X-Title':'GoAi'};
const PROV={
  groq1:     {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq1',m:'llama-3.3-70b-versatile',t:'oai',label:'Llama-3.3-70B (Groq #1)'},
  groq2:     {url:'https://api.groq.com/openai/v1/chat/completions',k:'groq2',m:'llama-3.3-70b-versatile',t:'oai',isManager:true,label:'Llama-3.3-70B (Groq #2) Manager'},
  gemini1:   {k:'gemini1',m:'gemini-2.5-flash',t:'gem',label:'Gemini 2.5 Flash (Key1)'},
  gemini2:   {k:'gemini2',m:'gemini-2.0-flash-lite',t:'gem',label:'Gemini 2.0 Flash Lite (Key2)'},
  gemini3:   {k:'gemini3',m:'gemini-2.5-flash',t:'gem',label:'Gemini 2.5 Flash (Key3)'},
  openrouter:{url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'minimax/minimax-m1',t:'oai',ex:OR_H,label:'MiniMax-M1 (OpenRouter)'},
  openrouter2:{url:'https://openrouter.ai/api/v1/chat/completions',k:'or',m:'meta-llama/llama-3.3-70b-instruct:free',t:'oai',ex:OR_H,label:'Llama-3.3-70B Free (OpenRouter)'},
  github1:   {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4.1-mini',t:'oai',ex:GH_H,label:'GPT-4.1-mini (GitHub)'},
  github2:   {url:'https://models.github.ai/inference/chat/completions',k:'github',m:'openai/gpt-4o',t:'oai',ex:GH_H,label:'GPT-4o (GitHub)'},
  sambanova: {url:'https://api.sambanova.ai/v1/chat/completions',k:'samba',m:'Meta-Llama-3.3-70B-Instruct',t:'oai',label:'Llama-3.3-70B (SambaNova)'},
  bytez:     {url:'https://api.bytez.com/models/v2/openai/v1/chat/completions',k:'bytez',m:'Qwen/Qwen2.5-72B-Instruct',t:'oai',label:'Qwen2.5-72B (Bytez)'},
  duckduckgo:{t:'ddg',m:'claude-3-haiku-20240307',label:'Claude 3.5 Haiku (DuckDuckGo Free)'}
};
const MAXT={groq1:2000,groq2:6000,gemini1:8192,gemini2:8192,gemini3:8192,openrouter:4000,openrouter2:4096,github1:3000,github2:4000,sambanova:4096,bytez:3000,duckduckgo:2000};
const TEMP={groq1:.3,groq2:.35,gemini1:.45,gemini2:.3,gemini3:.4,openrouter:.5,openrouter2:.4,github1:.4,github2:.4,sambanova:.45,bytez:.4,duckduckgo:.4};
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'","unpkg.com"],styleSrc:["'self'","'unsafe-inline'","fonts.googleapis.com"],fontSrc:["fonts.gstatic.com","data:"],connectSrc:["'self'"],imgSrc:["'self'","data:"],frameSrc:["pythontutor.com"]}}}));
app.use(cors({origin:(o,cb)=>cb(null,!o||o===ORIGIN),methods:['GET','POST'],allowedHeaders:['Content-Type'],credentials:false}));
app.use(express.json({limit:'64kb'}));
app.use(express.static(path.join(__dirname,'public'),{maxAge:'1h',setHeaders:(res,fp)=>{if(fp.endsWith('.html'))res.setHeader('Cache-Control','no-cache');}}));
const rl=(max,ms=60000)=>rateLimit({windowMs:ms,max,standardHeaders:true,legacyHeaders:false,handler:(_,res)=>res.status(429).json({error:'Too many requests'})});
app.use('/api',rl(120));app.use('/api/chat',rl(30));app.use('/api/memory',rl(60));
async function callOAI(cfg,sys,msgs,tok,temp){
  const r=await fetch(cfg.url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+K[cfg.k],...(cfg.ex||{})},body:JSON.stringify({model:cfg.m,messages:[{role:'system',content:sys},...msgs],max_tokens:tok,temperature:temp}),signal:AbortSignal.timeout(55000)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d?.error?.message||d?.message||'HTTP '+r.status+' ('+cfg.label+')');
  const t=d?.choices?.[0]?.message?.content||'';if(!t)throw new Error('Empty from '+cfg.label);return t;
}
async function callGEM(cfg,sys,msgs,tok,temp){
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+cfg.m+':generateContent';
  const contents=[{role:'user',parts:[{text:sys}]},...msgs.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))];
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':K[cfg.k]},body:JSON.stringify({contents,generationConfig:{temperature:temp,maxOutputTokens:tok}}),signal:AbortSignal.timeout(55000)});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.error?.message||'Gemini HTTP '+r.status);
  const t=(d?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');if(!t)throw new Error('Empty Gemini (quota?)');return t;
}
const DDG_H={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36','accept-language':'en-US,en;q=0.9','origin':'https://duckduckgo.com','referer':'https://duckduckgo.com/'};
async function callDDG(sys,msgs){
  const st=await fetch('https://duckduckgo.com/duckchat/v1/status',{headers:{...DDG_H,'x-vqd-accept':'1','accept':'text/event-stream','cache-control':'no-cache','pragma':'no-cache'},signal:AbortSignal.timeout(15000)});
  const vqd=st.headers.get('x-vqd-4'),hash=st.headers.get('x-vqd-hash-1')||'';
  if(!vqd)throw new Error('DDG: rate limited — wait 2 min');
  const all=sys?[{role:'user',content:sys},...msgs]:msgs;
  const hdrs={...DDG_H,'Content-Type':'application/json','accept':'text/event-stream','x-vqd-4':vqd};if(hash)hdrs['x-vqd-hash-1']=hash;
  const cr=await fetch('https://duckduckgo.com/duckchat/v1/chat',{method:'POST',headers:hdrs,body:JSON.stringify({model:'claude-3-haiku-20240307',messages:all}),signal:AbortSignal.timeout(55000)});
  if(!cr.ok)throw new Error('DDG HTTP '+cr.status);
  const raw=await cr.text();let out='';
  for(const line of raw.split('\n')){if(!line.startsWith('data: '))continue;const pl=line.slice(6).trim();if(pl==='[DONE]')break;try{const p=JSON.parse(pl);if(p.message)out+=p.message;}catch{}}
  if(!out)throw new Error('DDG: empty content');return out;
}
async function callProvider(pid,sys,msgs,maxTok){
  const cfg=PROV[pid];if(!cfg)throw new Error('Unknown: '+pid);
  const tok=Math.min(maxTok||MAXT[pid]||2000,MAXT[pid]||2000),temp=TEMP[pid]||.4;
  if(cfg.t==='ddg')return callDDG(sys,msgs);
  if(!hasK(K[cfg.k]))throw new Error(pid+' key missing in K{}');
  if(cfg.t==='gem')return callGEM(cfg,sys,msgs,tok,temp);
  return callOAI(cfg,sys,msgs,tok,temp);
}
const vOk=(req,res,next)=>{const e=validationResult(req);return e.isEmpty()?next():res.status(400).json({error:e.array().map(x=>x.path+': '+x.msg).join(' | ')});};
const chatRules=[body('provider').isString().isIn(Object.keys(PROV)),body('messages').isArray({min:1,max:80}),body('messages.*.role').isIn(['user','assistant']),body('messages.*.content').isString().isLength({min:1,max:25000}),body('systemPrompt').optional().isString().isLength({max:15000}),body('maxTokens').optional().isInt({min:50,max:8192})];
app.get('/api/providers',(req,res)=>{const out={};for(const[id,cfg]of Object.entries(PROV))out[id]={available:cfg.t==='ddg'||hasK(K[cfg.k]||''),isManager:!!cfg.isManager,model:cfg.m||'ddg',label:cfg.label||id};res.json(out);});
app.post('/api/chat',chatRules,vOk,async(req,res)=>{
  const{provider,messages,systemPrompt,maxTokens}=req.body;
  try{const text=await callProvider(provider,(systemPrompt||'You are GoAi.').slice(0,12000),messages.map(m=>({...m,content:String(m.content||'').slice(0,18000)})),maxTokens);res.json({text,provider,label:PROV[provider]?.label});}
  catch(e){const msg=String(e.message||'Error');console.error('[GoAi]',provider,'→',msg.slice(0,200));res.status(/quota|balance|rate|429|limit/i.test(msg)?429:/key|auth|401/i.test(msg)?401:502).json({error:msg.slice(0,300)});}
});
app.post('/api/memory',[body('prompt').isString().isLength({min:1,max:600})],vOk,async(req,res)=>{
  const pid=['groq2','groq1','gemini2','github1','duckduckgo'].find(p=>PROV[p]&&(PROV[p].t==='ddg'||hasK(K[PROV[p].k]||'')));
  if(!pid)return res.json({summary:''});
  try{const t=await callProvider(pid,'Summarize in 8 words max. Reply ONLY with the summary.',[{role:'user',content:req.body.prompt}],60);res.json({summary:t.replace(/[\n"]/g,' ').trim().slice(0,100)});}
  catch{res.json({summary:''});}
});
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,_,res,__)=>{console.error('[Error]',err.message);res.status(500).json({error:'Internal error'});});
app.listen(PORT,()=>{
  const av=Object.entries(PROV).filter(([,c])=>c.t==='ddg'||hasK(K[c.k]||'')).map(([,c])=>c.label);
  console.log('\n🚀 GoAi v5 → http://localhost:'+PORT);
  console.log('🔐 Helmet · CORS · RateLimit · Validator');
  console.log('🦆 DDG Claude Haiku free · 🆓 Llama-3.3-70B free (OpenRouter)\n');
  console.log('✅ '+av.length+'/12:');av.forEach(l=>console.log('   ·',l));console.log('');
});