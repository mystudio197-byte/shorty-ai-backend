'use strict';
const crypto = require('node:crypto');
const ID = /^\d{1,30}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function createFacebook({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const states = new Map(), sessions = new Map();
  const origin = env.ALLOWED_ORIGIN || 'https://mystudio197-byte.github.io';
  const frontend = env.FRONTEND_URL || origin + '/Shorty-AI-Downloader/';
  const callback = env.FACEBOOK_REDIRECT_URI;
  const configured = !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET && callback);
  const version = env.FACEBOOK_API_VERSION || 'v26.0';
  const reply = (res, status, obj) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(obj)); };
  function prune() {
    for (const [k,v] of states) if (v.expires <= now()) states.delete(k);
    for (const [k,v] of sessions) if (v.expires <= now()) sessions.delete(k);
  }
  async function graph(path, token, fields = {}) {
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    for (const [k,v] of Object.entries(fields)) url.searchParams.set(k,String(v));
    url.searchParams.set('appsecret_proof', crypto.createHmac('sha256',env.FACEBOOK_APP_SECRET).update(token).digest('hex'));
    const r = await fetcher(url, {headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    const data = await r.json();
    if (!r.ok || data.error) { const e = new Error('Facebook could not complete this request. Reconnect your Page or check app permissions.'); e.status = data.error?.code === 190 ? 401 : 422; throw e; }
    return data;
  }
  async function pages(session) {
    const result = new Map();
    let after;
    for (let i=0;i<20;i++) {
      const data = await graph('me/accounts',session.token,{fields:'id,name,access_token',limit:100,...(after ? {after}: {})});
      for (const p of data.data || []) if (ID.test(p.id) && p.access_token) result.set(p.id,p);
      after = data.paging?.cursors?.after;
      if (!data.paging?.next || !after) { session.pages = result; return result; }
    }
    throw new Error('Too many Pages to list safely. Please narrow your authorized Page selection.');
  }
  return {
    async route(req,res,url,{upstream,maxBytes}) {
      if (!(url.pathname.startsWith('/api/facebook/') || url.pathname.startsWith('/auth/facebook'))) return false;
      prune();
      try {
        if (url.pathname === '/api/facebook/status') { reply(res,200,{configured}); return true; }
        if (!configured) { reply(res,503,{error:'Facebook connection is not configured on this backend yet.'}); return true; }
        if (url.pathname === '/auth/facebook/start') {
          if (states.size >= 1000) {reply(res,429,{error:'Please try again shortly.'});return true;}
          const state = crypto.randomBytes(32).toString('hex');
          states.set(digest(state),{expires:now()+600000});
          res.setHeader('Set-Cookie',`shorty_oauth=${state}; HttpOnly; SameSite=Lax; Path=/auth/facebook; Max-Age=600${callback.startsWith('https:')?'; Secure':''}`);
          const target = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
          target.search = new URLSearchParams({client_id:env.FACEBOOK_APP_ID,redirect_uri:callback,state,response_type:'code',scope:'pages_show_list,pages_read_engagement'}).toString();
          if(env.FACEBOOK_CONFIG_ID) target.searchParams.set('config_id',env.FACEBOOK_CONFIG_ID);
          res.writeHead(302,{Location:target.href,'Cache-Control':'no-store'});res.end();return true;
        }
        if (url.pathname === '/auth/facebook/callback') {
          const state = url.searchParams.get('state') || '';
          const cookie = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('shorty_oauth='))?.slice(13) || '';
          const saved = states.get(digest(state));
          states.delete(digest(state));
          res.setHeader('Set-Cookie','shorty_oauth=; HttpOnly; SameSite=Lax; Path=/auth/facebook; Max-Age=0');
          if (!state || cookie !== state || !saved || saved.expires <= now()) { reply(res,400,{error:'Login expired or state did not match. Please reconnect from Shorty.'}); return true; }
          if (url.searchParams.has('error') || !url.searchParams.get('code')) { reply(res,400,{error:'Facebook authorization was cancelled.'});return true; }
          // Meta's manual-login token exchange uses GET. This server-only URL
          // contains credentials: never log it or return provider payloads.
          const exchange = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
          exchange.search = new URLSearchParams({client_id:env.FACEBOOK_APP_ID,client_secret:env.FACEBOOK_APP_SECRET,redirect_uri:callback,code:url.searchParams.get('code')}).toString();
          const r = await fetcher(exchange,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});
          const result = await r.json();
          if (!r.ok || !result.access_token) {
            // Return only fixed guidance and numeric diagnostic codes; never echo
            // provider messages, request URLs, codes, secrets or token payloads.
            const code = Number.isInteger(result.error?.code) ? result.error.code : null;
            const subcode = Number.isInteger(result.error?.error_subcode) ? result.error.error_subcode : null;
            const detail = code === null ? '' : ` (Meta code ${code}${subcode === null ? '' : `, subcode ${subcode}`})`;
            const guidance = /client.?secret/i.test(String(result.error?.message || ''))
              ? ' Verify the Meta App Secret in the staging backend.'
              : ' Reconnect Facebook and verify the app credentials and callback configuration.';
            throw new Error(`Facebook authorization failed${detail}.${guidance}`);
          }
          const granted = await graph('me/permissions',result.access_token);
          const permissions = new Set((granted.data || []).filter(p=>p.status==='granted').map(p=>p.permission));
          if (!permissions.has('pages_show_list') || !permissions.has('pages_read_engagement')) throw new Error('Please authorize both Page listing and Page content access.');
          if(sessions.size>=1000) throw new Error('Please try again shortly.');
          const ticket = crypto.randomBytes(32).toString('base64url');
          sessions.set(digest(ticket),{token:result.access_token,expires:now()+Math.min(Number(result.expires_in)||3600,3600)*1000});
          const nonce = crypto.randomBytes(16).toString('base64');
          const data = JSON.stringify({type:'shorty-facebook-connected',session:ticket}).replace(/</g,'\\u003c');
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`});
          res.end(`<!doctype html><title>Facebook connected</title><p>Facebook connected. You can close this window and return to Shorty.</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${data},${JSON.stringify(origin)});window.close();}</script>`);return true;
        }
        if (req.headers.origin !== origin) {reply(res,403,{error:'Origin not allowed'});return true;}
        const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
        const session = bearer && sessions.get(digest(bearer));
        if (!session || session.expires <= now()) { reply(res,401,{error:'Connect Facebook to continue. Sessions expire after one hour.'});return true; }
        if (url.pathname === '/api/facebook/disconnect') { sessions.delete(digest(bearer));reply(res,200,{ok:true});return true; }
        if (url.pathname === '/api/facebook/pages') {
          const list = await pages(session);
          reply(res,200,{pages:[...list.values()].map(p=>({id:p.id,name:p.name}))});return true;
        }
        const match = /^\/api\/facebook\/pages\/(\d{1,30})\/(videos|import)$/.exec(url.pathname);
        if(!match) {reply(res,404,{error:'Not found'});return true;}
        const page = (await pages(session)).get(match[1]);
        if(!page) {reply(res,403,{error:'This Page is not authorized for your account.'});return true;}
        if(match[2]==='videos') {
          const after=url.searchParams.get('after');
          if(after && !/^[A-Za-z0-9_=-]{1,2048}$/.test(after)) {reply(res,400,{error:'Invalid cursor'});return true;}
          const data=await graph(`${page.id}/videos`,page.access_token,{fields:'id,title,description,created_time,permalink_url,length',limit:12,...(after?{after}:{})});
          reply(res,200,{videos:data.data || [],after:data.paging?.next?data.paging?.cursors?.after:null});return true;
        }
        const videoId = url.searchParams.get('video');
        if(!ID.test(videoId || '') || url.searchParams.get('authorized')!=='yes') {reply(res,400,{error:'Select a video and confirm your rights to use it.'});return true;}
        const video = await graph(videoId,page.access_token,{fields:'id,from,source'});
        if(String(video.from?.id)!==page.id || !video.source) {reply(res,403,{error:'The video must belong to the selected Page and have an available authorized source.'});return true;}
        const validate = raw => {
          const u = new URL(raw);
          if(u.protocol!=='https:' || u.username || u.password || u.port && u.port!=='443' || !u.hostname.endsWith('.fbcdn.net')) throw new Error('Unsupported Facebook video source.');
          return u;
        };
        const stream = await upstream(validate(video.source),0,validate);
        res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':`attachment; filename="facebook-${videoId}.mp4"`,'Cache-Control':'no-store'});
        let size=0;
        stream.on('data',c=>{size+=c.length;if(size>maxBytes){stream.destroy();res.destroy();}});
        stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
      } catch (e) {
        if(!res.headersSent) reply(res,e.status || 422,{error:e.message.startsWith('Facebook') || e.message.startsWith('Please') || e.message.startsWith('Too many Pages') ? e.message : 'The Facebook request could not complete. Please reconnect or try again.'});
        else res.destroy();
        return true;
      }
    }
  };
}
module.exports={createFacebook};
