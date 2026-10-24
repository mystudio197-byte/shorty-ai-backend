'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const {Readable}=require('node:stream');
const {createFacebook}=require('../facebook');
const origin='https://mystudio197-byte.github.io';
async function fixture(t,{configured=true,owner='123',source='https://video.xx.fbcdn.net/video.mp4',expires=3600,contentPermission='granted'}={}){
 let clock=Date.now();const calls=[];let streamed=false;
 const env={ALLOWED_ORIGIN:origin,FACEBOOK_REDIRECT_URI:'https://backend.example/auth/facebook/callback',FACEBOOK_APP_ID:'fixture-app',FACEBOOK_APP_SECRET:configured?'fixture-secret':''};
 const api=createFacebook({env,now:()=>clock,fetcher:async(raw,options)=>{
  const u=new URL(raw);calls.push({u,options});let data;
  if(u.pathname.endsWith('/oauth/access_token'))data={access_token:'fixture-user-token',expires_in:expires};
  else if(u.pathname.endsWith('/me/permissions'))data={data:[{permission:'pages_show_list',status:'granted'},{permission:'pages_read_engagement',status:contentPermission}]};
  else if(u.pathname.endsWith('/me/accounts'))data={data:[{id:'123',name:'My Page',access_token:'fixture-page-token'}]};
  else if(u.pathname.endsWith('/123/videos'))data={data:[{id:'456',title:'My video'}],paging:{next:'should-never-be-returned-token-link',cursors:{after:'cursor123'}}};
  else if(u.pathname.endsWith('/456'))data={id:'456',from:{id:owner},source};
  else throw new Error('Unexpected graph request');
  return {ok:true,json:async()=>data};
 }});
 const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://local');await api.route(req,res,u,{maxBytes:1000,upstream:async(u,n,validator)=>{validator(u.href);streamed=true;return Readable.from(Buffer.from('fixture-video'));}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const request=(path,session)=>fetch(base+path,{redirect:'manual',headers:{Origin:origin,...(session?{Authorization:'Bearer '+session}:{})}});
 async function login(){const r=await request('/auth/facebook/start');const state=new URL(r.headers.get('location')).searchParams.get('state');const cookie=r.headers.get('set-cookie').split(';')[0];const callback=await fetch(base+'/auth/facebook/callback?code=fixture-code&state='+state,{headers:{cookie}});const html=await callback.text();assert.equal(callback.status,200);assert.ok(!html.includes('fixture-user-token'));return JSON.parse(/postMessage\((\{.*?\}),/.exec(html)[1]).session;}
 return {request,login,calls,base,expire:()=>clock+=3600001,streamed:()=>streamed};
}
test('unconfigured backend fails closed',async t=>{const f=await fixture(t,{configured:false});assert.deepEqual(await(await f.request('/api/facebook/status')).json(),{configured:false});assert.equal((await f.request('/auth/facebook/start')).status,503);});
test('OAuth enforces cookie-bound, single-use state',async t=>{const f=await fixture(t);const start=await f.request('/auth/facebook/start');const state=new URL(start.headers.get('location')).searchParams.get('state');const r=await f.request('/auth/facebook/callback?code=x&state='+state);assert.equal(r.status,400);assert.equal(f.calls.length,0);});
test('only authorized Pages and safe video data are returned',async t=>{const f=await fixture(t);const session=await f.login();assert.equal((await f.request('/api/facebook/pages')).status,401);const pages=await(await f.request('/api/facebook/pages',session)).json();assert.deepEqual(pages,{pages:[{id:'123',name:'My Page'}]});const videos=await(await f.request('/api/facebook/pages/123/videos',session)).json();assert.equal(videos.after,'cursor123');assert.ok(!JSON.stringify(videos).includes('token'));assert.equal((await f.request('/api/facebook/pages/999/videos',session)).status,403);for(const {u,options} of f.calls.filter(c=>!c.u.pathname.endsWith('/oauth/access_token'))){assert.ok(!u.searchParams.has('access_token'));assert.ok(u.searchParams.has('appsecret_proof'));assert.ok(options.headers.Authorization.startsWith('Bearer '));}});
test('import requires permission confirmation and matching owner',async t=>{const f=await fixture(t,{owner:'999'});const session=await f.login();assert.equal((await f.request('/api/facebook/pages/123/import?video=456',session)).status,400);assert.equal((await f.request('/api/facebook/pages/123/import?video=456&authorized=yes',session)).status,403);assert.equal(f.streamed(),false);});
test('authorized video import streams bytes without source URLs or tokens',async t=>{const f=await fixture(t);const session=await f.login();const r=await f.request('/api/facebook/pages/123/import?video=456&authorized=yes',session);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'video/mp4');assert.equal(await r.text(),'fixture-video');});
test('source allowlist blocks non-Facebook URLs',async t=>{const f=await fixture(t,{source:'https://internal.example/video.mp4'});const session=await f.login();assert.equal((await f.request('/api/facebook/pages/123/import?video=456&authorized=yes',session)).status,422);assert.equal(f.streamed(),false);});
test('sessions expire and disconnect revokes backend access',async t=>{const f=await fixture(t);const session=await f.login();assert.equal((await f.request('/api/facebook/disconnect',session)).status,200);assert.equal((await f.request('/api/facebook/pages',session)).status,401);const next=await f.login();f.expire();assert.equal((await f.request('/api/facebook/pages',next)).status,401);});
test('successful OAuth state cannot be replayed',async t=>{
 const f=await fixture(t);const start=await f.request('/auth/facebook/start');
 const state=new URL(start.headers.get('location')).searchParams.get('state');
 const cookie=start.headers.get('set-cookie').split(';')[0];
 const callback=()=>fetch(f.base+'/auth/facebook/callback?code=fixture-code&state='+state,{headers:{cookie}});
 assert.equal((await callback()).status,200);const count=f.calls.length;
 assert.equal((await callback()).status,400);assert.equal(f.calls.length,count);
});
test('expired OAuth state makes no Graph request',async t=>{
 const f=await fixture(t);const start=await f.request('/auth/facebook/start');
 const state=new URL(start.headers.get('location')).searchParams.get('state');
 const cookie=start.headers.get('set-cookie').split(';')[0];f.expire();
 const r=await fetch(f.base+'/auth/facebook/callback?code=fixture-code&state='+state,{headers:{cookie}});
 assert.equal(r.status,400);assert.equal(f.calls.length,0);
});
test('denied Page content permission creates no frontend session',async t=>{
 const f=await fixture(t,{contentPermission:'declined'});const start=await f.request('/auth/facebook/start');
 const state=new URL(start.headers.get('location')).searchParams.get('state');
 const cookie=start.headers.get('set-cookie').split(';')[0];
 const r=await fetch(f.base+'/auth/facebook/callback?code=fixture-code&state='+state,{headers:{cookie}});
 assert.equal(r.status,422);const body=await r.text();assert.ok(!body.includes('postMessage'));assert.ok(!body.includes('fixture-user-token'));
});
test('valid session cannot read Page data from an untrusted origin',async t=>{
 const f=await fixture(t);const session=await f.login();const count=f.calls.length;
 const r=await fetch(f.base+'/api/facebook/pages',{headers:{Origin:'https://untrusted.example',Authorization:'Bearer '+session}});
 assert.equal(r.status,403);assert.equal(f.calls.length,count);
});
