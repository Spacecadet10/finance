/* Ledger — part 1 of 7: storage, defaults, helpers.
   The parts load in order as plain scripts and share one scope; tools/build.js joins them back into
   one closure for the shareable single file. Keep load-time code in the part that defines what it uses. */
"use strict";


/* ============================ storage ============================ */
const KEY='ledger-v1';
const LOCK_DEFAULT=300;   /* auto-lock after five idle minutes: long enough to enter a month of transactions in peace */
const PASS_MIN=10;   /* a shared file is an offline guessing target: ten characters minimum */
const REIMPORT_MIN=4;   /* below this a batch is too small for "most of it matches" to mean anything */
const APP_VERSION='2026.09.10-12';
/* ---------- diagnostics logger: a no-op unless debug mode is on ---------- */
const DLOG_KEY='ledger-debuglog', DLOG_MAX=1000;
let DLOG=[], dlogTimer=null, dlogLoaded=false;
function debugOn(){ return !!(S&&S.settings&&S.settings.debug); }
function redact(v){
  if(v==null) return v;
  if(typeof v==='string') return v.replace(/\bsk-[A-Za-z0-9_-]{6,}/g,'sk-…').replace(/\b\d{12,19}\b/g,m=>'····'+m.slice(-4));
  if(typeof v!=='object') return v;
  const o=Array.isArray(v)?[]:{};
  Object.keys(v).forEach(k=>{ if(/key|token|secret|password|apikey/i.test(k)) o[k]='[redacted]'; else o[k]=redact(v[k]); });
  return o;
}
function dlog(ev,detail){
  if(!debugOn()) return;
  if(!dlogLoaded) loadDlog();
  DLOG.push({t:Date.now(),ev:ev,d:detail===undefined?'':redact(detail)});
  if(DLOG.length>DLOG_MAX) DLOG.splice(0,DLOG.length-DLOG_MAX);
  const sealedNow=(typeof vaultKey!=='undefined'&&!!vaultKey)||(typeof lockWiped!=='undefined'&&lockWiped);   /* decided when the entry is made, not when the timer fires */
  clearTimeout(dlogTimer); dlogTimer=setTimeout(()=>{ try{ if(sealedNow||(typeof vaultKey!=='undefined'&&vaultKey)||(typeof lockWiped!=='undefined'&&lockWiped)) return; window.localStorage.setItem(DLOG_KEY,JSON.stringify(DLOG)); }catch(e){} },500);
}
function loadDlog(){ dlogLoaded=true; try{ const raw=window.localStorage.getItem(DLOG_KEY); DLOG=raw?JSON.parse(raw):[]; }catch(e){ DLOG=[]; } }
function clearDlog(){ DLOG=[]; try{ window.localStorage.removeItem(DLOG_KEY); }catch(e){} }
const mem={};
const memStore={
  get:async k=>{ if(!(k in mem)) throw new Error('not found'); return {key:k,value:mem[k]}; },
  set:async(k,v)=>{ mem[k]=v; return {key:k,value:v}; },
  delete:async k=>{ delete mem[k]; return {key:k,deleted:true}; },
  list:async()=>({keys:Object.keys(mem)})
};
/* when running as a downloaded file there's no window.storage, so fall back to
   the browser's own store; only if that's blocked too do we keep data in memory */
function browserStore(){
  try{
    const t='__ledger_probe__';
    window.localStorage.setItem(t,'1'); window.localStorage.removeItem(t);
    return {
      get:async k=>{ const v=window.localStorage.getItem(k); if(v==null) throw new Error('not found'); return {key:k,value:v}; },
      set:async(k,v)=>{ window.localStorage.setItem(k,v); return {key:k,value:v}; },
      delete:async k=>{ window.localStorage.removeItem(k); return {key:k,deleted:true}; },
      list:async()=>({keys:Object.keys(window.localStorage)})
    };
  }catch(e){ return null; }
}
let store, STORAGE_WHERE;
if(window.storage&&typeof window.storage.get==='function'){ store=window.storage; STORAGE_WHERE='chat'; }
else { const b=browserStore(); if(b){ store=b; STORAGE_WHERE='device'; } else { store=memStore; STORAGE_WHERE='memory'; } }

/* ============================ defaults ============================ */
const PALETTE=['#2E6B4F','#9A3324','#B07E1E','#3A6B8A','#66478A','#8A6B3A','#4A8A76','#8A3A6B','#56698A','#7A8A3A'];

/* index 0 = Sunday, matching Date.getDay() */
const DAY_NAMES=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* pair = the light/dark counterpart the ◐ button flips to */
const THEMES=[
  {id:'daylight',name:'Daylight', kind:'light', pair:'midnight',sw:['#ECF0E9','#E1FDCC','#9540FE','#0A7362']},
  {id:'midnight',name:'Midnight', kind:'dark',  pair:'daylight',sw:['#141126','#2A2547','#B57BFF','#5FD9C3']},
  {id:'slate', name:'Slate',      kind:'light', pair:'ink',    sw:['#E6EAEF','#F8FAFC','#2D6E9E','#141C25']},
  {id:'linen', name:'Linen',      kind:'light', pair:'umber',  sw:['#EAE3D8','#FAF7F2','#7A4E86','#241D22']},
  {id:'mono',  name:'Mono',       kind:'light', pair:'carbon', sw:['#E7E7E7','#FAFAFA','#9B2C2C','#141414']},
  {id:'pad',   name:'Ledger pad', kind:'light', pair:'night',  sw:['#E8ECE3','#F8F9F4','#2E6B4F','#17211B']},
  {id:'ink',   name:'Ink',        kind:'dark',  pair:'slate',  sw:['#0C1320','#1B2637','#7FA9D8','#E2E9F2']},
  {id:'umber', name:'Umber',      kind:'dark',  pair:'linen',  sw:['#16110F','#282120','#C08BD0','#EDE5DE']},
  {id:'carbon',name:'Carbon',     kind:'dark',  pair:'mono',   sw:['#121212','#232323','#D6A85F','#E8E8E8']},
  {id:'night', name:'Night pad',  kind:'dark',  pair:'pad',    sw:['#0F1512','#1E2823','#DDAF5E','#E5EBE3']},
  {id:'sand',    name:'Sand',       kind:'light', pair:'dusk',     sw:['#EDE6DA','#FAF6EF','#8A5A9E','#2A2218']},
  {id:'dusk',    name:'Dusk',       kind:'dark',  pair:'sand',     sw:['#1B1620','#262030','#C9A0E8','#F1EAE0']},
  {id:'sea',     name:'Sea',        kind:'light', pair:'deep',     sw:['#E3ECEE','#F5F9FA','#2C6FA8','#14262B']},
  {id:'deep',    name:'Deep',       kind:'dark',  pair:'sea',      sw:['#0E1B22','#16262F','#7EB8F0','#E6EEF1']},
  {id:'rose',    name:'Rose',       kind:'light', pair:'plum',     sw:['#F1E4E6','#FBF5F6','#8A4F9E','#2B1B21']},
  {id:'plum',    name:'Plum',       kind:'dark',  pair:'rose',     sw:['#1F1420','#2B1C2D','#D6A4EE','#F3E9EE']},
  {id:'paper',   name:'Paper',      kind:'light', pair:'graphite', sw:['#F2F1EC','#FFFFFF','#C3691A','#1C1C1A']},
  {id:'graphite',name:'Graphite',   kind:'dark',  pair:'paper',    sw:['#171818','#212323','#F2A65A','#ECEDEA']},
  {id:'meadow',  name:'Meadow',     kind:'light', pair:'forest',   sw:['#E4EDDC','#F6FAF1','#3D6FA3','#1B261A']},
  {id:'forest',  name:'Forest',     kind:'dark',  pair:'meadow',   sw:['#101A13','#18261C','#8CC5F0','#E8F0E6']}
];
function themeOf(id){ return THEMES.find(t=>t.id===id)||THEMES[0]; }

const DEFAULT_CATEGORIES=[
  {id:'c1',name:'Salary',type:'in',color:'#2E6B4F',need:true},
  {id:'c2',name:'Other income',type:'in',color:'#4A8A76',need:true},
  {id:'c3',name:'Rent / mortgage',type:'out',color:'#3A6B8A',need:true},
  {id:'c4',name:'Groceries',type:'out',color:'#9A3324',need:true},
  {id:'c5',name:'Utilities',type:'out',color:'#8A6B3A',need:true},
  {id:'c6',name:'Transport',type:'out',color:'#56698A',need:true},
  {id:'c7',name:'Dining out',type:'out',color:'#B07E1E',need:false},
  {id:'c8',name:'Subscriptions',type:'out',color:'#66478A',need:false},
  {id:'c9',name:'Health',type:'out',color:'#4A8A76',need:true},
  {id:'c10',name:'Everything else',type:'out',color:'#8A3A6B',need:false},
  {id:'c11',name:'Yagyas & rituals',type:'out',color:'#A5581F',need:false},
  {id:'c12',name:'Puja items & offerings',type:'out',color:'#9E7B2F',need:false},
  {id:'c13',name:'Gemstones & talismans',type:'out',color:'#5A4A9E',need:false},
  {id:'c14',name:'Astrology & consultations',type:'out',color:'#2F6E7A',need:false},
  {id:'c15',name:'Donations & dakshina',type:'out',color:'#6B8A3A',need:false},
  {id:'c16',name:'Travel & vacation',type:'out',color:'#1F7A9E',need:false},
  {id:'c17',name:'Family & kids',type:'out',color:'#B0537A',need:true},
  {id:'c18',name:'Gifts & celebrations',type:'out',color:'#8A6BB0',need:false},
  {id:'c19',name:'Family support',type:'out',color:'#45806B',need:true},
  {id:'c0',name:'Uncategorised',type:'out',color:'#9A9A9A',need:false},
  {id:'c20',name:'Insurance',type:'out',color:'#4F6D8A',need:true},
  {id:'c21',name:'Loan payments',type:'out',color:'#7A5C3A',need:true},
  {id:'c22',name:'Bank fees & interest',type:'out',color:'#8A4F4F',need:true},
  {id:'c23',name:'Cash withdrawals',type:'out',color:'#6B6B6B',need:false},
  {id:'c24',name:'Shopping',type:'out',color:'#B05A8A',need:false},
  {id:'c25',name:'Entertainment',type:'out',color:'#8A5AB0',need:false},
  {id:'c26',name:'Personal care',type:'out',color:'#B08A5A',need:false},
  {id:'c27',name:'Education',type:'out',color:'#3A7A8A',need:true},
  {id:'c28',name:'Business & supplies',type:'out',color:'#5A8A4F',need:false},
  {id:'c29',name:'Taxes & government',type:'out',color:'#4F4F8A',need:true},
  {id:'c30',name:'Pets',type:'out',color:'#8A6F4F',need:false},
  {id:'c31',name:'Transfers & payments out',type:'out',color:'#7F8A8A',need:false},
  {id:'c32',name:'Business income',type:'in',color:'#2E6B4F',need:true},
  {id:'c33',name:'Government & benefits',type:'in',color:'#3A6B5A',need:true},
  {id:'c34',name:'Phone / Internet',type:'out',color:'#2F6E9E',need:true},
  {id:'c35',name:'Loan interest',type:'out',color:'#8A4F6B',need:true},
  {id:'c36',name:'Property tax',type:'out',color:'#4F6B4F',need:true}
];
/* categories added after release. Each pack carries its own flag so it lands
   exactly once — and anything deliberately deleted stays deleted. */
const CATEGORY_PACKS=[
  {flag:'catPack2',ids:['c11','c12','c13','c14','c15']},
  {flag:'catPack3',ids:['c16','c17','c18','c19']},
  {flag:'catPack5',ids:['c34']},
  {flag:'catPack4',ids:['c0','c20','c21','c22','c23','c24','c25','c26','c27','c28','c29','c30','c31','c32','c33']},
  {flag:'catPack6',ids:['c35','c36']}
];

const DEFAULT_WIDGETS=[
  {id:'guide',span:12,on:true},
  {id:'household',span:12,on:true},
  {id:'networth',span:6,on:true},
  {id:'cashflow',span:6,on:true},
  {id:'balancesheet',span:12,on:true},
  {id:'calendar',span:12,on:true},
  {id:'transactions',span:8,on:true},
  {id:'accounts',span:4,on:true},
  {id:'budgets',span:6,on:true},
  {id:'spending',span:6,on:true},
  {id:'needs',span:6,on:true},
  {id:'debt',span:6,on:true},
  {id:'habits',span:12,on:false},
  {id:'goals',span:6,on:true},
  {id:'planner',span:6,on:true},
  {id:'whatif',span:12,on:false},
  {id:'subs',span:6,on:true}
];

/* widgets that stay household-wide no matter which member is filtered (they get a note saying so) */
const HOUSEHOLD_WIDE={networth:1,balancesheet:1,accounts:1,budgets:1,goals:1,planner:1,whatif:1,debt:1,calendar:1};
function scopeNote(){ return `<div class="muted" style="font-size:12px;margin-bottom:9px">Household-wide — the member filter in the top bar does not apply here.</div>`; }
const WIDGET_TITLES={
  guide:'Your first month',networth:'Net worth',household:'Household',balancesheet:'Assets & liabilities',cashflow:'Cash flow',calendar:'Month ahead',transactions:'Transactions',accounts:'Accounts',
  budgets:'Budgets',spending:'Spending breakdown',needs:'Essentials vs. fun',debt:'Debt-free plan',
  habits:'Habits',goals:'Savings goals',planner:'Goal planner',whatif:'What if?',subs:'Recurring & memberships'
};

let S={
  settings:{currency:'CAD',dateFormat:'md',theme:'daylight',widgets:clone(DEFAULT_WIDGETS),onboarded:false},
  categories:clone(DEFAULT_CATEGORIES),
  accounts:[],transactions:[],budgets:{},recurring:[],goals:[],generated:{},
  habits:[],habitLog:{},planned:[],rates:{},rules:[],closes:[],recurringIgnored:{},
  users:[],
  debtPlan:{mode:'payment',payment:0,targetDate:'',strategy:'avalanche'}
};
let ui={month:ym(new Date()),spendRange:'month',search:'',whatIf:{mode:'earn',extra:0},user:'all'};
let dragId=null;

/* ============================ helpers ============================ */
function clone(x){return JSON.parse(JSON.stringify(x));}
function uid(){return (window.crypto&&window.crypto.randomUUID)?window.crypto.randomUUID().replace(/-/g,'').slice(0,16):Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4);}
function $(s,r){return (r||document).querySelector(s);}
function pad2(n){return String(n).padStart(2,'0');}
function ym(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1);}
function todayISO(){const d=new Date();return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
/* tagged template that auto-escapes ${} interpolations — the safe default for building HTML.
   Use: html\`<div class="x">${userNote}</div>\` — userNote is escaped automatically.
   Raw HTML in the template literals (not interpolated) is passed through untouched. */
function html(strings,...vals){
  let out='';
  strings.forEach((s,i)=>{
    out+=s;
    if(i<vals.length){
      const v=vals[i];
      if(v==null||v===false) return;
      if(Array.isArray(v)){ out+=v.map(x=>esc(x)).join(''); return; }
      out+=esc(v);
    }
  });
  return out;
}
function shiftMonth(key,n){
  const [y,m]=key.split('-').map(Number);
  const d=new Date(y,m-1+n,1);
  return ym(d);
}
function monthName(key,long){
  const [y,m]=key.split('-').map(Number);
  const d=new Date(y,m-1,1);
  return d.toLocaleDateString(undefined,{month:long?'long':'short',year:'numeric'});
}
/* ---------- currency ----------
   Every account holds money in its own currency. S.rates[cur] says how many
   units of that currency equal 1 unit of the base, so a Malagasy ariary rate
   reads as "1 CAD = 4300 MGA" rather than as an unreadable fraction.
   Rates are entered by hand on purpose: fetching them would mean sending
   your data to somebody's server. */
/* Starting rates. Only ones I have been given a figure for — I will not invent
   an exchange rate I cannot stand behind. Everything else is left blank for you. */
const SEED_RATES={MGA:3051};
