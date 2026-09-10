/* Boots the real page headlessly: finance-dashboard.html + ledger.js in jsdom, clock pinned, storage fresh.
   Usage: const {boot}=require('./lib'); const {L,S,ui,w,d,click}=await boot({today:'2026-09-09'}); */
const {JSDOM}=require('jsdom'); const fs=require('fs'); const path=require('path');
const DIR=path.join(__dirname,'..');
const HTML=process.env.LEDGER_HTML||path.join(DIR,'finance-dashboard.html');
const JS=process.env.LEDGER_JS||'';   /* a single file, or (default) the parts in src/ in order */
function appSources(){ if(JS) return [fs.readFileSync(JS,'utf8')]; const dir=path.join(DIR,'src'); return fs.readdirSync(dir).filter(f=>/^\d\d-.*\.js$/.test(f)).sort().map(f=>fs.readFileSync(path.join(dir,f),'utf8')); }

async function boot(opts){
  opts=opts||{}; const today=opts.today||'2026-09-09';
  let html=(opts.html||fs.readFileSync(HTML,'utf8'))
    .replace(/<link[^>]+rel="stylesheet"[^>]*>/g,'').replace(/<link[^>]+preconnect[^>]*>/g,'')
    .replace(/<script src="(?:ledger\.js|src\/[^"]+)[^"]*"><\/script>\s*/g,'');
  const single=/id="ledger-app"/.test(html);   /* the built single file carries its own script: do not inject a second copy */
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:opts.url||'http://localhost:8765/finance-dashboard.html',beforeParse(w){
    const RD=w.Date; const fixed=new RD(today+'T12:00:00');
    class FD extends RD{ constructor(...a){ if(!a.length) return new RD(fixed.getTime()); super(...a); } static now(){ return fixed.getTime(); } }
    w.Date=FD;
    w.matchMedia=w.matchMedia||(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
    w.HTMLCanvasElement.prototype.getContext=()=>null; w.scrollTo=()=>{}; w.HTMLElement.prototype.scrollIntoView=function(){};
    if(!w.TextEncoder) w.TextEncoder=TextEncoder; if(!w.TextDecoder) w.TextDecoder=TextDecoder;
    try{ if(!w.crypto||!w.crypto.subtle) Object.defineProperty(w,'crypto',{value:require('crypto').webcrypto,configurable:true}); }catch(e){}
    if(opts.storage) Object.keys(opts.storage).forEach(k=>w.localStorage.setItem(k,opts.storage[k]));
    w.__testErrors=[]; w.addEventListener('error',e=>w.__testErrors.push(e.message||String(e)));
  }});
  const w=dom.window, d=w.document;
  if(!single){ for(const code of appSources()){ const sc=d.createElement('script'); sc.textContent=code; d.body.appendChild(sc); } }
  await new Promise(r=>setTimeout(r,250));
  const L=w.__ledger; if(!L) throw new Error('ledger did not boot: '+w.__testErrors.join('; '));
  const click=sel=>{ const el=typeof sel==='string'?d.querySelector(sel):sel; if(!el) throw new Error('no element '+sel); el.click(); return el; };
  const act=(name,extra)=>{ const el=d.createElement('button'); el.dataset.act=name; Object.keys(extra||{}).forEach(k=>el.dataset[k]=extra[k]); d.body.appendChild(el); el.click(); el.remove(); };
  return {L,get S(){return L.S;},ui:L.ui,w,d,dom,click,act,errors:w.__testErrors,
    tick:(ms)=>new Promise(r=>setTimeout(r,ms||50))};
}

/* a fresh account of either kind */
function acct(id,kind,balance,extra){ return Object.assign({id:id,name:id,kind:kind||'asset',cur:'CAD',opening:{balance:balance||0},checkpoints:[],balance:balance||0},extra||{}); }
function tx(id,date,amount,type,cid,aid,extra){ return Object.assign({id:id,date:date,amount:amount,type:type,categoryId:cid,accountId:aid,note:id},extra||{}); }
function xfer(id,date,amount,from,to,extra){ return Object.assign({id:id,date:date,amount:amount,type:'transfer',fromId:from,toId:to,note:id},extra||{}); }

/* tiny deterministic PRNG for random books */
function rng(seed){ let s=seed>>>0||1; return ()=>{ s^=s<<13; s>>>=0; s^=s>>>17; s^=s<<5; s>>>=0; return s/4294967296; }; }

module.exports={boot,acct,tx,xfer,rng,HTML};
