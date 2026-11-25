import express from 'express';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSettingsControlPlane} from './server/settingsControlPlane.ts';
import {createSubstrateService} from './server/supabaseSubstrate.ts';

const rootDir=dirname(fileURLToPath(import.meta.url));

function hydrateEnvFromDotEnv(){
  if(process.env.ATAX_SUPABASE_CONNECTION_URL) return;
  const envPath=resolve(rootDir,'.env');
  if(!existsSync(envPath)) return;
  try{
    for(const line of readFileSync(envPath,'utf8').split(/\r?\n/)){
      const trimmed=line.trim();
      if(!trimmed||trimmed.startsWith('#')) continue;
      const idx=trimmed.indexOf('=');
      if(idx<=0) continue;
      const key=trimmed.slice(0,idx).trim();
      let val=trimmed.slice(idx+1).trim();
      if((val.startsWith('"')&&val.endsWith('"'))||(val.startsWith("'")&&val.endsWith("'"))) val=val.slice(1,-1);
      if(key==='ATAX_SUPABASE_CONNECTION_URL' && val && !process.env[key]) process.env[key]=val;
    }
  }catch{}
}

hydrateEnvFromDotEnv();

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'64kb'}));
app.use('/api',(_req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  next();
});

async function expressSettingsRequest(req: express.Request,res: express.Response){
  const host=req.get('host')||'localhost:3000';
  const protocol=req.protocol==='https'?'https':'http';
  const url=`${protocol}://${host}${req.originalUrl}`;
  const headers=new Headers();
  for(const [key,value] of Object.entries(req.headers)){
    if(Array.isArray(value)) headers.set(key,value.join(', '));
    else if(typeof value==='string') headers.set(key,value);
  }
  let body: BodyInit|undefined;
  if(req.method!=='GET'&&req.method!=='HEAD'&&req.body&&Object.keys(req.body).length) {
    body=JSON.stringify(req.body);
    headers.set('content-type','application/json');
  }
  const request=new Request(url,{method:req.method,headers,body});
  const controller=createSettingsControlPlane(process.env);
  let response: Response;
  const path=new URL(url).pathname;
  try{
    if(path==='/api/settings/status'&&req.method==='GET') {
      const result=await controller.status(request);
      response=Response.json(result.status,{status:result.httpStatus,headers:{'cache-control':'no-store'}});
    } else if(path==='/api/settings/auth/unlock'&&req.method==='POST'){
      const parsed=req.body&&typeof req.body==='object'?req.body:{};
      const result=await controller.unlock(request,typeof parsed.passkey==='string'?parsed.passkey:'');
      response=Response.json(result.body,{status:result.status,headers:result.headers});
    } else if(path==='/api/settings/auth/logout'&&req.method==='POST'){
      const result=await controller.logout(request);
      response=Response.json(result.body,{status:result.status,headers:result.headers});
    } else if(path==='/api/settings/providers'&&req.method==='GET'){
      const result=await controller.listProviders(request);
      response=Response.json(result.body,{status:result.status});
    } else if(path==='/api/settings/providers'&&req.method==='POST'){
      const result=await controller.upsertProvider(request,(req.body||{}) as Record<string,unknown>);
      response=Response.json(result.body,{status:result.status});
    } else {
      const testMatch=path.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)\/test$/);
      const enabledMatch=path.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)\/enabled$/);
      const deleteMatch=path.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)$/);
      if(testMatch&&req.method==='POST'){
        const result=await controller.testProvider(request,decodeURIComponent(testMatch[1]),decodeURIComponent(testMatch[2]));
        response=Response.json(result.body,{status:result.status});
      } else if(enabledMatch&&req.method==='PATCH'){
        const result=await controller.setEnabled(request,decodeURIComponent(enabledMatch[1]),decodeURIComponent(enabledMatch[2]),req.body?.enabled);
        response=Response.json(result.body,{status:result.status});
      } else if(deleteMatch&&req.method==='DELETE'){
        const result=await controller.deleteProvider(request,decodeURIComponent(deleteMatch[1]),decodeURIComponent(deleteMatch[2]));
        response=Response.json(result.body,{status:result.status});
      } else {
        response=Response.json({error:'Not found'},{status:404});
      }
    }
  } catch(err){
    response=Response.json({error:err instanceof Error?err.message:'Settings request failed.'},{status:502});
  }

  res.status(response.status);
  response.headers.forEach((value,key)=>res.setHeader(key,value));
  const buffer=Buffer.from(await response.arrayBuffer());
  res.send(buffer);
}

app.use('/api/settings',async(req,res)=>{
  await expressSettingsRequest(req,res);
});

app.get('/api/substrate/systems',async(_req,res)=>{
  try{res.json(await createSubstrateService(process.env).getSystemsGraph());}
  catch(err){res.status(502).json({error:err instanceof Error?err.message:'Unable to query systems.'});}
});
app.get('/api/substrate/visions-goals',async(_req,res)=>{
  try{res.json(await createSubstrateService(process.env).getVisionsGoalsGraph());}
  catch(err){res.status(502).json({error:err instanceof Error?err.message:'Unable to query visions and goals.'});}
});
app.get('/api/substrate/skills',async(_req,res)=>{
  try{res.json(await createSubstrateService(process.env).getSkillsCatalog());}
  catch(err){res.status(502).json({error:err instanceof Error?err.message:'Unable to query skills.'});}
});

const PORT=3000;
async function startServer(){
  if(process.env.NODE_ENV==='production'){
    const distDir=resolve(rootDir,'dist');
    app.use(express.static(distDir));
    app.use((_req,res)=>res.sendFile(resolve(distDir,'index.html')));
  }else{
    const {createServer:createViteServer}=await import('vite');
    const vite=await createViteServer({server:{middlewareMode:true,hmr:false},appType:'spa'});
    app.use(vite.middlewares);
  }
  app.listen(PORT,'0.0.0.0',()=>console.log(`ATAX Substrate server listening on http://0.0.0.0:${PORT}`));
}
startServer().catch(err=>{console.error('Failed to start server:',err);process.exit(1);});
