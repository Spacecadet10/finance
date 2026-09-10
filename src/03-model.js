/* Ledger — part 3 of 7: persistence, rules, recurring, series, net worth over time.
   The parts load in order as plain scripts and share one scope; tools/build.js joins them back into
   one closure for the shareable single file. Keep load-time code in the part that defines what it uses. */
"use strict";

/* ============================ persistence ============================ */
let saveTimer=null;
/* ---- one book, several tabs ----
   Every save carries a revision number. A tab remembers the revision it loaded or last wrote; before writing it
   reads what is in storage now. If another tab has written a newer revision, this tab's copy is stale and its
   save is REFUSED rather than silently overwriting the newer data — a banner offers to reload (recommended)
   or to overwrite deliberately. */
let myRev=0, staleTab=false, staleRev=0, saveForce=false;
function storedRevSync(){ try{ const v=window.localStorage&&window.localStorage.getItem(KEY); if(!v) return 0; const m=/"rev":(\d+)/.exec(v); return m?Number(m[1]):0; }catch(e){ return 0; } }
async function storedRev(){ try{ const r=await store.get(KEY); const d=JSON.parse(r.value); return isEnvelope(d)?(Number(d.rev)||0):(Number(d.settings&&d.settings.rev)||0); }catch(e){ return 0; } }
function renderStale(){
  let bar=document.getElementById('stalebar');
  if(!staleTab){ if(bar) bar.remove(); return; }
  if(!bar){ bar=document.createElement('div'); bar.id='stalebar'; bar.className='alertbar'; bar.setAttribute('role','alert'); const host=document.getElementById('originbar')||document.querySelector('header')||document.body; host.parentNode.insertBefore(bar,host.nextSibling); }
  bar.innerHTML='<b>⚠ Another Ledger tab saved newer changes.</b> This tab is out of date, so its last change was <b>not saved</b> — saving it would overwrite the newer data. '+
    '<button class="btn btn-sm btn-primary" data-act="stale-reload">Reload this tab (recommended)</button> <button class="btn btn-sm btn-ghost" data-act="stale-overwrite">Overwrite with this tab’s copy</button>';
}
try{ window.addEventListener('storage',e=>{ if(e&&e.key===KEY&&e.newValue){ const m=/"rev":(\d+)/.exec(e.newValue); const rev=m?Number(m[1]):0; if(rev>myRev){ staleTab=true; staleRev=rev; dlog('another tab wrote a newer revision',{stored:rev,mine:myRev}); renderStale(); } } }); }catch(e){}
async function flushSave(){
  if(bootCorrupt){ dlog('save refused: the stored book is damaged and has not been replaced',{}); updateSaveStat(); return false; }
  { const lock=loadLock(); if(!vaultRotating&&lock&&lock.wrapP&&vaultWraps&&lock.salt!==vaultWraps.salt){ saveForce=false; staleTab=true; staleRev=Number(lock.rev)||staleRev; dlog('save refused: the passphrase was changed in another tab',{}); renderStale(); updateSaveStat(); toast('The passphrase was changed in another tab — reload before saving'); return false; } }
  const rev=await storedRev();
  if(rev>myRev&&!saveForce){ staleTab=true; staleRev=rev; dlog('save refused: another tab wrote a newer revision',{stored:rev,mine:myRev}); renderStale(); updateSaveStat(); return false; }
  saveForce=false; staleTab=false; renderStale();
  const prevRev=S.settings.rev, prevAt=S.settings.lastLocalSave;
  S.settings.rev=Math.max(rev,myRev)+1; S.settings.lastLocalSave=Date.now();
  try{ if(commitFailAt==='save') throw new Error('injected save failure'); await store.set(KEY,await sealState()); }
  catch(e){ S.settings.rev=prevRev; S.settings.lastLocalSave=prevAt; saveBroken=errStr(e)||'storage refused the write'; updateSaveStat(); throw e; }
  saveBroken='';
  myRev=S.settings.rev; lastLocalSave=S.settings.lastLocalSave; scheduleBackupWrite(); updateSaveStat(); return true;
}
function save(){
  recalcBalances();
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{
    try{ await flushSave(); flashSaveStat(); }
    catch(e){ console.error('Save failed',e); toast('Could not save changes'); updateSaveStat(); }
  },350);
}
/* brief "Saved ✓" flash on the save stat badge so you can see writes landing */
let saveFlashTimer=null;
function flashSaveStat(){
  const el=document.getElementById('saveStat');
  if(!el) return;
  el.classList.add('flash');
  clearTimeout(saveFlashTimer);
  saveFlashTimer=setTimeout(()=>el.classList.remove('flash'),1200);
}
/* write now, and say whether it landed: an atomic commit needs the answer before it can call itself done */
async function saveNow(){ recalcBalances(); clearTimeout(saveTimer); try{ return await flushSave(); }catch(e){ console.error('Save failed',e); updateSaveStat(); return false; } }
/* ---------- graphics: one icon family, drawn on a 24px grid ----------
   All stroke-based at a single weight so they sit together optically,
   and all in currentColor so they follow whatever theme is active. */
const ICONS={
  networth:'<path d="M4 16.5 9.5 11l3.5 3.5L20 7"/><path d="M15.5 7H20v4.5"/>',
  balancesheet:'<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-2.5 6h5z"/><path d="M19 7l-2.5 6h5z"/>',
  guide:'<path d="M5 12.5l4 4L19 6.5"/><path d="M4 19.5h16"/>',
  household:'<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5v-1.5a4.5 4.5 0 0 1 4.5-4.5h2a4.5 4.5 0 0 1 4.5 4.5v1.5"/><circle cx="16.5" cy="9" r="2.5"/><path d="M16.5 13.5a4 4 0 0 1 4 4v2"/>',
  cashflow:'<path d="M7 4.5v13"/><path d="M4 14.5l3 3 3-3"/><path d="M17 19.5v-13"/><path d="M14 9.5l3-3 3 3"/>',
  calendar:'<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10.5h17M8 3v4.5M16 3v4.5"/>',
  transactions:'<path d="M4 7.5h16M4 12h16M4 16.5h10"/>',
  accounts:'<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 10.5h18M16 14.5h2"/>',
  budgets:'<rect x="3.5" y="9.5" width="17" height="5" rx="2.5"/><path d="M6.5 12h6"/>',
  spending:'<circle cx="12" cy="12" r="8"/><path d="M12 12V4"/><path d="M12 12l6.9 4"/>',
  needs:'<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/>',
  debt:'<path d="M4 7.5 9.5 13l3.5-2.5L20 17"/><path d="M15.5 17H20v-4.5"/>',
  habits:'<rect x="3.5" y="5.5" width="17" height="14" rx="2.5"/><path d="M7.5 12.5l2.8 2.8L16.5 9.5"/>',
  goals:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.6"/><circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none"/>',
  planner:'<path d="M4 18V6"/><path d="M4 18h16"/><path d="M7 14l4-4 3 3 5-6"/><path d="M16 7h3v3"/>',
  whatif:'<path d="M4 12h16"/><circle cx="14" cy="12" r="3"/><path d="M12 5.5l1-1.5 1 1.5M12 18.5l1 1.5 1-1.5"/>',
  subs:'<path d="M4.5 12A7.5 7.5 0 0 1 17 6.4"/><path d="M19.5 12A7.5 7.5 0 0 1 7 17.6"/><path d="M17.2 3.2v3.4h-3.4"/><path d="M6.8 20.8v-3.4h3.4"/>'
};
function icon(id,cls){
  const p=ICONS[id]; if(!p) return '';
  return `<svg class="${cls||'wicon'}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
/* the mark: a ruled page with its margin line */
const LOGO='<rect x="3.5" y="3" width="17" height="18" rx="3"/><path d="M8 3v18"/><path d="M11.5 8.5h5.5M11.5 12.5h5.5M11.5 16.5h3"/>';
function logoSVG(cls,sw){
  return `<svg class="${cls||''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="${sw||1.75}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LOGO}</svg>`;
}
/* small line drawings so an empty widget looks considered rather than broken */
const ART={
  accounts:'<rect x="8" y="26" width="52" height="30" rx="5"/><path d="M8 36h52"/><rect x="20" y="14" width="52" height="30" rx="5" opacity=".45"/><path d="M50 48h6"/>',
  transactions:'<rect x="12" y="10" width="56" height="52" rx="5"/><path d="M22 10v52" opacity=".5"/><path d="M30 24h28M30 34h28M30 44h16"/>',
  debt:'<path d="M8 56h12V40h12V26h12V14h16"/><path d="M8 62h64" opacity=".4"/>',
  calendar:'<rect x="10" y="16" width="60" height="48" rx="5"/><path d="M10 28h60M26 10v10M54 10v10"/><path d="M22 40h8M36 40h8M50 40h8M22 52h8M36 52h8" opacity=".6"/>'
};
function art(id){
  const p=ART[id]; if(!p) return '';
  return `<svg class="art" viewBox="0 0 80 72" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
function renderOrigin(){
  const el=document.getElementById('originStat'); if(el) el.innerHTML=originBadge();
  let bar=document.getElementById('originbar');
  if(!isCanonical()&&appOrigin()==='file'){
    if(!bar){
      bar=document.createElement('div'); bar.id='originbar'; bar.className='alertbar soft'; bar.setAttribute('role','alert');
      bar.innerHTML='<b>⚠ This is not your canonical Ledger.</b>Your primary Ledger runs on localhost. Anything entered here is stored separately, under this file\'s own browser storage, and will not appear there. '+
        '<button class="btn btn-sm btn-primary" data-act="open-canonical" style="margin-top:9px">Open canonical Ledger</button>';
      const board=document.getElementById('board'); if(board&&board.parentNode) board.parentNode.insertBefore(bar,board);
    }
  }else if(bar){ bar.remove(); }
}
function setFavicon(){
  try{
    const ink=themeColor('--ink','#1E1B34'), bg=themeColor('--bg','#ECF0E9');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${bg}"/>`+
      `<g fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${LOGO}</g></svg>`;
    let l=document.querySelector('link[rel="icon"]');
    if(!l){ l=document.createElement('link'); l.rel='icon'; document.head.appendChild(l); }
    l.type='image/svg+xml';
    l.href='data:image/svg+xml,'+encodeURIComponent(svg);
  }catch(e){}
}

function freshState(){
  return {
    settings:{currency:'CAD',dateFormat:'md',theme:'daylight',widgets:clone(DEFAULT_WIDGETS),onboarded:true},
    categories:clone(DEFAULT_CATEGORIES),
    accounts:[],transactions:[],budgets:{},recurring:[],goals:[],generated:{},
    habits:[],habitLog:{},planned:[],rates:Object.assign({},SEED_RATES),rules:[],closes:[],recurringIgnored:{},
    users:[],
    debtPlan:{mode:'payment',payment:0,targetDate:'',strategy:'avalanche'}
  };
}
function healState(d){
  S=Object.assign(S,d);
  ['accounts','transactions','users','recurring','goals','rules','closes','planned','habits'].forEach(k=>{ if(!Array.isArray(S[k])) S[k]=[]; });
  if(!Array.isArray(S.categories)||!S.categories.length) S.categories=clone(DEFAULT_CATEGORIES);
  ['budgets','generated','habitLog','rates','recurringIgnored'].forEach(k=>{ if(!S[k]||typeof S[k]!=='object'||Array.isArray(S[k])) S[k]={}; });
  S.settings=Object.assign({currency:'CAD',dateFormat:'md',theme:'daylight',widgets:clone(DEFAULT_WIDGETS),onboarded:false},d.settings||{});
  const have=S.settings.widgets.map(w=>w.id);
  DEFAULT_WIDGETS.forEach(w=>{ if(have.indexOf(w.id)<0) S.settings.widgets.push(clone(w)); });
  /* the household card belongs next to cash flow, not at the bottom where an older book appended it (once) */
  if(!S.settings.guidePlaced){ const i=S.settings.widgets.findIndex(w=>w.id==='guide'); if(i>0){ const [w]=S.settings.widgets.splice(i,1); S.settings.widgets.unshift(w); } S.settings.guidePlaced=true; }
  if(!S.settings.householdPlaced){ const i=S.settings.widgets.findIndex(w=>w.id==='household'); if(i>=0){ const [w]=S.settings.widgets.splice(i,1); const g=S.settings.widgets.findIndex(x=>x.id==='guide'); S.settings.widgets.splice(g>=0?g+1:0,0,w); } S.settings.householdPlaced=true; }   /* the household card goes to the top, under the guide, as the person asked */
  S.settings.widgets=S.settings.widgets.filter(w=>WIDGET_TITLES[w.id]);
  S.debtPlan=Object.assign({mode:'payment',payment:0,targetDate:'',strategy:'avalanche'},d.debtPlan||{});
  /* a reversal link whose other half is gone, or no longer matches, is dropped — the rows themselves stay */
  (S.transactions||[]).forEach(t=>{ if(!t.reversalOf&&!t.reversedBy) return;
    const p=t.reversalOf?txById(t.reversalOf):txById(t.reversedBy);
    const ok=p&&(t.reversalOf?(reversalPairOk(p,t)&&p.reversedBy===t.id):(reversalPairOk(t,p)&&p.reversalOf===t.id));
    if(!ok){ delete t.reversalOf; delete t.reversedBy; delete t.revSource; } });
  (S.accounts||[]).forEach(a=>{
    if(a.loan&&typeof a.loan!=='object') delete a.loan;
    if(a.invest&&typeof a.invest!=='object') delete a.invest;
    if(a.purchase&&typeof a.purchase!=='object') delete a.purchase;
    if(a.valued&&a.valued!=='checkpoints'&&a.valued!=='ledger') delete a.valued;
    if(a.since&&!/^\d{4}-\d{2}-\d{2}$/.test(a.since)) delete a.since;
    if(a.acctType==='loan') a.acctType='other loan'; if(a.acctType&&!acctTypeInfo(a.acctType)) delete a.acctType; if(Array.isArray(a.secures)) a.secures=a.secures.filter(id=>typeof id==='string'); });
  (S.transactions||[]).forEach(t=>{ if(t.alloc&&typeof t.alloc!=='object') delete t.alloc; });
  if(!Array.isArray(S.habits)) S.habits=[];
  if(!S.habitLog||typeof S.habitLog!=='object') S.habitLog={};
  if(!Array.isArray(S.planned)) S.planned=[];
  if(!S.rates||typeof S.rates!=='object') S.rates={};
  if(!Array.isArray(S.rules)) S.rules=[];
  if(!Array.isArray(S.closes)) S.closes=[];
  if(!S.recurringIgnored||typeof S.recurringIgnored!=='object') S.recurringIgnored={};
  if(!Array.isArray(S.users)) S.users=[];
  S.users.forEach(u=>{ if(!u.id) u.id=uid(); if(typeof u.name!=='string') u.name=''; if(!u.color) u.color=PALETTE[S.users.indexOf(u)%PALETTE.length]; });
  /* drop userId references to users that no longer exist */
  const validIds={}; S.users.forEach(u=>validIds[u.id]=1);
  (S.transactions||[]).forEach(t=>{ if(t.userId&&!validIds[t.userId]) delete t.userId; });
  (S.recurring||[]).forEach(r=>{ if(r.userId&&!validIds[r.userId]) delete r.userId; });
  if(!ui.user||!validIds[ui.user]) ui.user='all';
  migrateKeysOut();
  S.closes.forEach(c=>{ if(!Array.isArray(c.accounts)) c.accounts=[]; if(!c.status) c.status='open'; });
  S.rules.forEach(r=>{ if(typeof r.on!=='boolean') r.on=true; if(!r.accountId) r.accountId=''; r.match=String(r.match||''); });

  S.accounts.forEach(a=>{ if(!a.cur) a.cur=baseCur(); });
  if(!Array.isArray(S.categories)) S.categories=clone(DEFAULT_CATEGORIES);
  if(!Array.isArray(S.accounts)) S.accounts=[];
  if(!Array.isArray(S.transactions)) S.transactions=[];
  if(!Array.isArray(S.goals)) S.goals=[];
  S.goals.forEach(g=>{ if(typeof g.deadline!=='string') g.deadline=''; if(!g.created) g.created=todayISO(); });
  if(!Array.isArray(S.recurring)) S.recurring=[];
  if(!S.budgets||typeof S.budgets!=='object') S.budgets={};
  if(!S.generated||typeof S.generated!=='object') S.generated={};
  S.categories.forEach(c=>{ if(typeof c.need!=='boolean') c.need=(c.type==='in'); });
  /* one-time top-up so an existing ledger gains the newer categories;
     the flag means deleting them makes them stay deleted */
  if(true){
    const have={}; S.categories.forEach(c=>{have[c.id]=1;});
    CATEGORY_PACKS.forEach(pack=>{
      if(S.settings[pack.flag]) return;
      pack.ids.forEach(id=>{
        if(!have[id]){
          const def=DEFAULT_CATEGORIES.find(c=>c.id===id);
          if(def) S.categories.push(clone(def));
        }
      });
      S.settings[pack.flag]=true;
    });
  }
  S.recurring.forEach(r=>{
    if(!r.cadence) r.cadence='monthly';
    if(!r.month) r.month=new Date().getMonth()+1;
    if(!r.since) r.since=ym(new Date());
  });
  ensureAnchors();
}
/* a saved book that cannot be read is HELD, not replaced: nothing is written over it until the person decides */
let bootCorrupt='';
async function load(){
  let r=null; try{ r=await store.get(KEY); }catch(e){ return; }   /* nothing stored: a first run */
  if(!r||!r.value) return;
  try{
    let text=r.value;
    if(isEnvelope(safeParse(text))){   /* nothing shows until the passphrase opens the book; a key already in memory (re-load after a lock) opens it silently */
      let opened=null; if(vaultRaw){ try{ opened=await openSealed(text); }catch(e){ opened=null; } }
      text=opened!=null?opened:await unlockAtBoot(text);
    }
    const d=JSON.parse(text); if(!d||typeof d!=='object') throw new Error('not an object');
    healState(d);
  }catch(e){ bootCorrupt=r.value; S=freshState(); S.settings.onboarded=true; dlog('stored book unreadable',{error:errStr(e),bytes:r.value.length}); }
}

/* ============================ auto-categorisation rules ============================ */
/* A rule: {id, match, categoryId, accountId ('' = any), on}. Case-insensitive substring match on the
   note / merchant. The longest match wins; ties go to whichever sits higher in the list. */
function normText(x){ return String(x||'').toLowerCase().replace(/\s+/g,' ').trim(); }
function matchRule(note,accountId){
  const n=normText(note); if(!n) return null;
  let best=null,bestLen=-1,bestIdx=Infinity;
  (S.rules||[]).forEach((r,i)=>{
    if(r.on===false) return;
    const m=normText(r.match); if(!m) return;
    if(r.accountId&&accountId&&r.accountId!==accountId) return;
    if(r.accountId&&!accountId) return;
    if(n.indexOf(m)<0) return;
    if(m.length>bestLen||(m.length===bestLen&&i<bestIdx)){ best=r; bestLen=m.length; bestIdx=i; }
  });
  return best&&S.categories.some(c=>c.id===best.categoryId)?best:null;
}
/* apply to a transaction-like object; returns the rule used or null. Never touches manual picks. */
function applyRule(t,force){
  if(!t||t.type==='transfer') return null;
  if(t.catSource==='manual'&&!force) return null;
  const r=matchRule(t.note,t.accountId); if(!r) return null;
  t.categoryId=r.categoryId; t.type=cat(r.categoryId).type; t.catSource='rule'; t.ruleId=r.id;
  return r;
}
/* preview of a re-run over existing transactions: which would change */
/* proposal for every non-manual transaction: a personal rule if one matches, else the built-in matcher.
   Existing specific categories chosen by an AI read are left alone unless a rule says otherwise. */
function recatPreview(){
  const changes=[], manual=[]; let stillUncat=0;
  S.transactions.forEach(t=>{
    if(t.type==='transfer') return;
    if(t.catSource==='manual'){ manual.push(t); return; }
    const cur=cat(t.categoryId);
    let to=null, why='';
    const r=matchRule(t.note,t.accountId);
    if(r){ to=r.categoryId; why='rule “'+r.match+'”'; }
    else{
      const vague=cur.id==='c0'||cur.id==='c10'||!S.categories.some(c=>c.id===t.categoryId);
      const guess=guessCategory(t.note||'',t.type); const gc=guess?S.categories.find(c=>c.name===guess):null;
      if(gc&&(vague||t.catSource==='default')){ to=gc.id; why='built-in matcher'; }
      else if(gc&&gc.id!==t.categoryId){ to=gc.id; why='built-in matcher now says otherwise — unticked, your call'; }
      else if(!gc&&cur.id==='c10'&&t.catSource!=='import'&&t.catSource!=='rule'){ to=uncatId(); why='no match — mark for review'; }
    }
    if(to&&to!==t.categoryId) changes.push({t:t,from:cur.name,to:cat(to).name,toId:to,why:why,on:!/your call/.test(why)});
    if((to||t.categoryId)===uncatId()) stillUncat++;
  });
  return {changes:changes,manual:manual.length,stillUncat:stillUncat};
}
function recatModal(){
  const p=recatPreview();
  openSheet('Re-categorise transactions',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">Runs your personal rules first, then the built-in matcher, over existing transactions. Anything you categorised by hand is left alone. Nothing changes until you apply.</div>
    <div class="cmp" style="margin-bottom:12px">
      <div><b>${p.changes.filter(c=>c.on).length}</b> transaction${p.changes.filter(c=>c.on).length===1?'':'s'} will change${p.changes.some(c=>!c.on)?' · '+p.changes.filter(c=>!c.on).length+' more suggested but unticked (already had a specific category)':''}</div><div></div><div></div>
      <div><b>${p.manual}</b> manually categorised — left alone</div><div></div><div></div>
      <div><b>${p.stillUncat}</b> remain Uncategorised — fix those by hand (Ledger will offer to remember the merchant)</div><div></div><div></div>
    </div>
    ${p.changes.length?`<div class="tbl" style="max-height:45vh;overflow:auto">${p.changes.map((c,i)=>`<div class="trow"><span style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-recat="${c.t.id}" ${c.on?'checked':''} style="width:auto;margin:3px 0 0"><span style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.t.note||'(no note)')}</div><div class="muted" style="font-size:12px">${esc(fmtDate(c.t.date))} · ${esc(money(c.t.amount))} · ${esc(c.why)}</div></span></span><span class="muted" style="white-space:nowrap">${esc(c.from)} → <b style="color:var(--ink)">${esc(c.to)}</b></span></div>`).join('')}</div>`:'<div class="muted" style="font-size:13px">Nothing to change.</div>'}`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="recat-apply" ${p.changes.length?'':'disabled'}>Apply changes</button>`);
}
function recatApply(){
  const p=recatPreview(); const picked={}; document.querySelectorAll('[data-recat]').forEach(cb=>{ picked[cb.dataset.recat]=cb.checked; });
  const todo=p.changes.filter(c=>picked[c.t.id]===undefined?c.on:picked[c.t.id]);
  if(!todo.length){ toast('Nothing ticked'); return; }
  markUndo();
  todo.forEach(c=>{ const t=c.t; t.categoryId=c.toId; t.type=cat(c.toId).type; if(/^rule/.test(c.why)){ t.catSource='rule'; const r=matchRule(t.note,t.accountId); t.ruleId=r?r.id:''; } else t.catSource='default'; });
  dlog('re-categorised',{count:todo.length});
  save(); closeModal(); render(); toast('Re-categorised '+todo.length+' transaction'+(todo.length===1?'':'s'),true);
}
function rulesRunPreview(includeManual){
  const out=[];
  S.transactions.forEach(t=>{
    if(t.type==='transfer') return;
    if(t.catSource==='manual'&&!includeManual) return;
    const r=matchRule(t.note,t.accountId);
    if(r&&r.categoryId!==t.categoryId) out.push({t:t,r:r});
  });
  return out;
}
function merchantGuess(note){
  const base=merchantPart(note);
  let m=String(base||'').replace(/[#*]\s*\d[\w-]*.*$/,'').replace(/\b\d{3,}[\w-]*.*$/,'').replace(/\s{2,}/g,' ').trim();
  return m||String(base||'').trim();
}
function ruleForm(r,after){
  const isNew=!r||!r.id;
  r=Object.assign({match:'',categoryId:(S.categories.find(c=>c.type==='out')||{}).id,accountId:'',on:true},r||{});
  openForm({
    title:isNew?'New rule':'Edit rule',
    fields:[
      {name:'match',label:'When the description contains',type:'text',value:r.match,placeholder:'UBER EATS'},
      {name:'categoryId',label:'File it under',type:'select',groups:catGroups(),value:r.categoryId},
      {name:'accountId',label:'Only for account',type:'select',value:r.accountId,options:[{value:'',label:'Any account'}].concat(acctOptions())},
      {name:'on',label:'Enabled',type:'checkbox',value:r.on!==false}
    ],
    note:'Matching ignores upper/lower case. If several rules match, the longest text wins, then the one higher in the list. Rules never change a category you picked by hand.',
    submitLabel:isNew?'Add rule':'Save',
    onDelete:isNew?null:()=>{ markUndo(); S.rules=S.rules.filter(x=>x.id!==r.id); save(); closeModal(); render(); toast('Rule removed',true); if(after) after(); },
    onSubmit:v=>{
      const match=v.match.trim();
      if(!match){ toast('Type the text to look for'); return false; }
      const next={id:r.id||uid(),match:match,categoryId:v.categoryId,accountId:v.accountId||'',on:!!v.on};
      if(isNew) S.rules.push(next); else S.rules[S.rules.findIndex(x=>x.id===r.id)]=next;
      save(); closeModal(); render();
      toast(isNew?'Rule added — new transactions matching "'+match+'" go to '+cat(next.categoryId).name:'Rule updated');
      if(after) after();
    }
  });
}
function rulesRunModal(){
  const includeManual=!!($('#rrManual')||{}).checked;
  const hits=rulesRunPreview(includeManual);
  const manualHeld=includeManual?0:rulesRunPreview(true).length-hits.length;
  openSheet('Run rules on existing transactions',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">
      This goes through every transaction and applies your rules. Nothing changes until you confirm, and you can undo afterwards.
    </div>
    <label class="field" style="display:flex;align-items:center;gap:9px">
      <input type="checkbox" id="rrManual" data-act="rules-run-refresh" ${includeManual?'checked':''} style="width:auto;margin:0">
      <span style="margin:0;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--ink);font-weight:400">Also override categories I picked by hand${manualHeld?' ('+manualHeld+' held back)':''}</span>
    </label>
    <div style="font-size:14.5px;margin:6px 0 10px"><b>${hits.length}</b> transaction${hits.length===1?'':'s'} would change.</div>
    ${hits.length?`<div class="tbl">${hits.slice(0,12).map(h=>`<div class="trow"><span><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.t.note||'(no note)')}</div><div class="muted" style="font-size:12px">${esc(fmtDate(h.t.date))} · ${esc(money(h.t.amount))}</div></span><span class="muted" style="white-space:nowrap">${esc(cat(h.t.categoryId).name)} → <b style="color:var(--ink)">${esc(cat(h.r.categoryId).name)}</b></span></div>`).join('')}
      ${hits.length>12?`<div class="trow muted" style="font-size:12.5px">+ ${hits.length-12} more</div>`:''}</div>`:''}`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button>
     <button class="btn btn-primary" data-act="rules-run-commit" ${hits.length?'':'disabled'}>Apply to ${hits.length}</button>`);
}
function rulesRunCommit(){
  const includeManual=!!($('#rrManual')||{}).checked;
  const hits=rulesRunPreview(includeManual);
  if(!hits.length){ toast('Nothing to change'); return; }
  markUndo();
  hits.forEach(h=>{ applyToAccount(h.t,-1); applyRule(h.t,true); applyToAccount(h.t,1); dlog('rule matched',{tx:h.t.id,rule:h.r.match,category:cat(h.r.categoryId).name}); });
  save(); closeModal(); render();
  toast('Re-categorised '+hits.length+' transaction'+(hits.length===1?'':'s'),true);
}
function rulesPanel(){
  const rows=(S.rules||[]).map((r,i)=>`<div class="rule${r.on===false?' off':''}">
      <input type="checkbox" data-act="rule-toggle" data-id="${r.id}" ${r.on!==false?'checked':''} aria-label="Enabled">
      <div style="min-width:0;cursor:pointer" data-act="edit-rule" data-id="${r.id}" role="button" tabindex="0">
        <div class="m">${esc(r.match)}</div>
        <div class="to">→ ${esc(cat(r.categoryId).name)}${r.accountId?' · only '+esc((acct(r.accountId)||{}).name||'?'):''}</div>
      </div>
      <span class="muted num" style="font-size:11px">${i+1}</span>
      <button class="iconbtn" data-act="rule-move" data-id="${r.id}" data-v="-1" aria-label="Move up" ${i===0?'disabled':''}>↑</button>
      <button class="iconbtn" data-act="rule-move" data-id="${r.id}" data-v="1" aria-label="Move down" ${i===S.rules.length-1?'disabled':''}>↓</button>
    </div>`).join('');
  return `<div class="totalrule" style="margin-top:22px">
    <div class="eyebrow">Auto-categorisation rules</div>
    <div class="muted" style="font-size:13px;margin:6px 0 10px;line-height:1.6">Teach Ledger your merchants: <span class="num">UBER → Transport</span>, <span class="num">LOBLAWS → Groceries</span>. New transactions you add, paste, import or scan get filed automatically. Longer matches win over shorter ones; ties go to the rule higher up.</div>
    ${rows||'<div class="muted" style="font-size:13px">No rules yet. Editing any transaction also offers “Make a rule”.</div>'}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn btn-sm" data-act="add-rule">Add rule</button>
      <button class="btn btn-sm btn-ghost" data-act="rules-run" ${S.rules.length&&S.transactions.length?'':'disabled'}>Run rules on existing transactions…</button>
    </div>
  </div>`;
}

/* ============================ recurring ============================ */
function cadenceOf(r){ return r.cadence||'monthly'; }
function isDated(r){ const c=cadenceOf(r); return c==='weekly'||c==='biweekly'; }
/* every date a recurring item lands in month `key` */
function occurrences(r,key){
  const [y,m]=key.split('-').map(Number);
  const last=new Date(y,m,0).getDate();
  if(!isDated(r)){ return dueInMonth(r,key)?[key+'-'+pad2(Math.min(Number(r.day)||1,last))]:[]; }
  const step=cadenceOf(r)==='weekly'?7:14;
  const start=/^\d{4}-\d{2}-\d{2}$/.test(r.start||'')?r.start:todayISO();
  const s0=new Date(start+'T00:00:00'), first=new Date(y,m-1,1), end=new Date(y,m,0);
  let d=new Date(s0);
  if(d<first){ const k=Math.ceil((first-d)/86400000/step); d.setDate(d.getDate()+k*step); }
  const out=[]; while(d<=end){ out.push(isoOf(d)); d.setDate(d.getDate()+step); }
  return out;
}
function stampsFor(r,key){ return isDated(r)?occurrences(r,key).map(iso=>r.id+':'+iso):[r.id+':'+key]; }
function dueInMonth(r,key){
  const m=Number(key.split('-')[1])-1;
  const anchor=(Number(r.month)||1)-1;
  const c=cadenceOf(r);
  if(c==='yearly') return m===anchor;
  if(c==='quarterly') return ((m-anchor)%3+3)%3===0;
  return true;
}
function perMonth(r){
  const a=Math.abs(Number(r.amount)||0), c=cadenceOf(r);
  return c==='yearly'?a/12:c==='quarterly'?a/3:c==='weekly'?a*52/12:c==='biweekly'?a*26/12:a;
}
function perYear(r){
  const a=Math.abs(Number(r.amount)||0), c=cadenceOf(r);
  return c==='yearly'?a:c==='quarterly'?a*4:c==='weekly'?a*52:c==='biweekly'?a*26:a*12;
}
function cadenceLabel(r){
  const c=cadenceOf(r);
  return c==='yearly'?'yearly':c==='quarterly'?'every 3 months':c==='weekly'?'weekly':c==='biweekly'?'every 2 weeks':'monthly';
}
function nextDue(r){
  const now=new Date();
  const floorToday=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  for(let i=0;i<15;i++){
    const d=new Date(now.getFullYear(),now.getMonth()+i,1);
    for(const iso of occurrences(r,ym(d))){ const dt=new Date(iso+'T00:00:00'); if(dt>=floorToday) return dt; }
  }
  return null;
}
function daysAway(dt){
  const now=new Date();
  return Math.round((dt-new Date(now.getFullYear(),now.getMonth(),now.getDate()))/86400000);
}

function runRecurring(){
  const now=new Date(); let made=0;
  for(let back=12;back>=0;back--){
    const d=new Date(now.getFullYear(),now.getMonth()-back,1);
    const key=ym(d);
    S.recurring.forEach(r=>{
      if(r.active===false) return;
      if(r.since&&key<r.since) return;
      occurrences(r,key).forEach(date=>{
        const stamp=isDated(r)?r.id+':'+date:r.id+':'+key;
        if(S.generated[stamp]) return;
        if(isDated(r)&&r.start&&date<r.start) return;
        if(new Date(date+'T12:00:00')>now) return;
        const c=cat(r.categoryId);
        const t={id:uid(),date:date,amount:Math.abs(Number(r.amount)||0),type:c.type,
                 categoryId:r.categoryId,accountId:r.accountId,note:r.name,auto:true,source:'recurring',recurringId:r.id,createdAt:Date.now()};
        if(r.userId&&S.users.some(u=>u.id===r.userId)) t.userId=r.userId;
        S.transactions.push(t); applyToAccount(t,1);
        S.generated[stamp]=true; made++;
      });
    });
  }
  if(made){ save(); toast(made+' recurring '+(made===1?'entry':'entries')+' added'); }
}

/* ============================ recurring detection ============================
   Suggestion-only: finds merchants that come back on a rhythm and offers to make them recurring
   items. Never creates anything by itself. */
const MERCHANT_NOISE=/^(COM|CA|US|INC|LTD|LLC|CORP|CO|ONLINE|PAYMENT|PMT|PAYMENTS|BILL|BILLPAY|AUTOPAY|PREAUTH|PAP|PAD|EFT|DEBIT|CREDIT|CARD|VISA|MC|MASTERCARD|ON|QC|BC|AB|WWW|HTTPS?|THE|OF|AND)$/;
function merchantKey(note){
  const toks=String(note||'').toUpperCase().replace(/[#*]\S*/g,' ').replace(/[^A-Z0-9 ]+/g,' ').split(/\s+/)
    .filter(t=>t&&!/\d{2,}/.test(t)&&!MERCHANT_NOISE.test(t)&&t.length>1);
  return toks.slice(0,2).join(' ');
}
const FREQS=[['weekly',7,5,9,4],['biweekly',14,12,16,3],['monthly',30.44,26,35,3],['quarterly',91.3,80,100,3],['yearly',365.25,340,395,2]];
function median(arr){ const a=arr.slice().sort((x,y)=>x-y); const n=a.length; return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):0; }
function existingRecurringFor(key,accountId,type,typical){
  const gk=key+'|'+accountId+'|'+type;
  return S.recurring.find(r=>{
    if(r.fromKey===gk) return true;
    if(cat(r.categoryId).type!==type) return false;
    if(merchantKey(r.name)===key) return true;
    return r.accountId===accountId&&Math.abs((Number(r.amount)||0)-typical)<=Math.max(1,typical*0.1)&&merchantKey(r.name).split(' ')[0]===key.split(' ')[0];
  })||null;
}
function detectRecurring(opts){
  opts=opts||{};
  const groups={};
  S.transactions.forEach(t=>{
    if(t.type==='transfer'||t.auto||t.source==='recurring') return;
    const key=merchantKey(t.note); if(!key) return;
    const gk=key+'|'+(t.accountId||'')+'|'+t.type;
    (groups[gk]=groups[gk]||[]).push(t);
  });
  const today=todayISO(), out=[];
  Object.keys(groups).forEach(gk=>{
    const [key,accountId,type]=gk.split('|');
    const txs=groups[gk].slice().sort((a,b)=>a.date.localeCompare(b.date));
    /* one occurrence per day (a split bill is not a rhythm) */
    const byDay=[]; txs.forEach(t=>{ if(!byDay.length||byDay[byDay.length-1].date!==t.date) byDay.push(t); });
    if(byDay.length<2) return;
    const intervals=[]; for(let i=1;i<byDay.length;i++) intervals.push(daysBetween(byDay[i-1].date,byDay[i].date));
    const med=median(intervals);
    const f=FREQS.find(x=>med>=x[2]&&med<=x[3]); if(!f) return;
    let [freq,nominal,lo,hi,minN]=f;
    /* twice a month: intervals look biweekly but the dates sit on two fixed days of the month */
    const doms=byDay.map(t=>Number(t.date.slice(8)));
    if(freq==='biweekly'){ const uniq=[...new Set(doms.map(d=>d>=28?31:d))]; if(uniq.length<=2&&byDay.length>=4) freq='semimonthly'; }
    if(byDay.length<minN) return;
    const inWindow=intervals.filter(i=>i>=lo&&i<=hi).length;
    if(inWindow<intervals.length-1) return; /* at most one odd gap allowed */
    const dev=sum(intervals.map(i=>Math.abs(i-nominal)))/intervals.length/nominal;
    const regularity=Math.max(0,Math.min(1,1-dev*3));
    if(regularity<0.4) return;
    const amounts=byDay.map(t=>Number(t.amount)||0), typical=median(amounts), amin=Math.min(...amounts), amax=Math.max(...amounts);
    const amountScore=typical>0?Math.max(0,Math.min(1,1-(amax-amin)/typical)):0;
    if(amountScore<0.15) return; /* wildly different amounts are not the same bill */
    const countScore=Math.min(1,(byDay.length-minN+1)/4);
    const gap=daysBetween(byDay[byDay.length-1].date,today);
    const recency=gap<=nominal*1.5?1:gap<=nominal*3?0.5:0;
    const confidence=Math.round((0.45*regularity+0.15*amountScore+0.25*countScore+0.15*recency)*100);
    if(confidence<50) return;
    const cats={}; byDay.forEach(t=>{ cats[t.categoryId]=(cats[t.categoryId]||0)+1; });
    const categoryId=Object.keys(cats).sort((a,b)=>cats[b]-cats[a])[0];
    const names={}; byDay.forEach(t=>{ names[t.note]=(names[t.note]||0)+1; });
    const name=Object.keys(names).sort((a,b)=>names[b]-names[a])[0];
    const lastDate=byDay[byDay.length-1].date;
    let nextDate=addPeriod(lastDate,Math.round(nominal),'d');
    if(freq==='monthly'||freq==='quarterly'||freq==='yearly'){ const d=new Date(lastDate+'T00:00:00'); d.setMonth(d.getMonth()+(freq==='monthly'?1:freq==='quarterly'?3:12)); nextDate=isoOf(d); }
    while(nextDate<today&&recency>0) nextDate=addPeriod(nextDate,Math.round(nominal),'d');
    const existing=existingRecurringFor(key,accountId,type,typical);
    const ign=S.recurringIgnored[gk];
    const hidden=existing?'exists':ign?(ign.mode==='never'?'never':(byDay.length<=(ign.count||0)+2?'ignored':'')):'';
    out.push({key:gk,merchant:key,name:name,accountId:accountId,type:type,categoryId:categoryId,count:byDay.length,amounts:amounts,typical:r2(typical),min:r2(amin),max:r2(amax),
      intervals:intervals,median:med,freq:freq,nominal:nominal,nextDate:nextDate,lastDate:lastDate,confidence:confidence,
      parts:{regularity:Math.round(regularity*100),amount:Math.round(amountScore*100),count:Math.round(countScore*100),recency:Math.round(recency*100),deviation:Math.round(dev*100)},
      txIds:byDay.map(t=>t.id),hidden:hidden,existingId:existing?existing.id:''});
  });
  out.sort((a,b)=>b.confidence-a.confidence||b.count-a.count);
  return opts.all?out:out.filter(x=>!x.hidden);
}
function addPeriodDays(iso,n){ return addPeriod(iso,n,'d'); }
function freqLabel(f){ return {weekly:'every week',biweekly:'every 2 weeks',semimonthly:'twice a month',monthly:'every month',quarterly:'every 3 months',yearly:'once a year'}[f]||f; }
function suggestionToRecurring(sg){
  const cadence=sg.freq==='semimonthly'?'biweekly':sg.freq;
  const d=sg.nextDate;
  const owners=[...new Set((sg.txIds||[]).map(id=>(txById(id)||{}).userId).filter(Boolean))];
  return {name:sg.name,amount:sg.typical,cadence:cadence,start:d,day:Number(d.slice(8)),month:Number(d.slice(5,7)),categoryId:sg.categoryId,accountId:sg.accountId,active:true,fromKey:sg.key,userId:owners.length===1?owners[0]:undefined,
    _note:sg.freq==='semimonthly'?'This looked like twice a month; Ledger books every 2 weeks — adjust the amount or add a second item if the dates matter.':''};
}
function recurringSuggestModal(){
  const list=detectRecurring(); dlog('recurring suggestions generated',{count:list.length,merchants:list.map(x=>x.merchant)});
  const income=list.filter(x=>x.type==='in'), spend=list.filter(x=>x.type==='out');
  const card=sg=>`<div class="tbl" style="margin-bottom:10px">
    <div class="trow" style="flex-wrap:wrap;gap:6px 14px">
      <span style="flex:1 1 200px"><div><b>${esc(sg.name)}</b> <span class="muted" style="font-size:12px">${esc((acct(sg.accountId)||{}).name||'')} · ${esc(cat(sg.categoryId).name)}</span></div>
        <div class="muted num" style="font-size:12.5px">${esc(freqLabel(sg.freq))} · typically <b>${esc(money(sg.typical))}</b>${Math.abs(sg.max-sg.min)>0.005?' (ranges '+esc(money(sg.min))+' – '+esc(money(sg.max))+')':''} · ${sg.count} matches · next ~${esc(fmtDate(sg.nextDate))}</div></span>
      <span class="num" style="font-size:13px;white-space:nowrap;color:${sg.confidence>=80?'var(--in)':'var(--accent)'}">${sg.confidence}% sure</span>
    </div>
    <div class="trow" style="gap:6px;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" data-act="rec-create" data-key="${esc(sg.key)}">Create recurring item</button>
      <button class="btn btn-sm" data-act="rec-ignore" data-key="${esc(sg.key)}">Ignore</button>
      <button class="btn btn-sm btn-ghost" data-act="rec-never" data-key="${esc(sg.key)}">Never suggest ${esc(sg.merchant)}</button>
    </div></div>`;
  openSheet('Recurring detected',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">Ledger looked through your transactions for merchants that come back on a rhythm. Nothing is created until you say so; every field is editable before saving.</div>
    ${list.length?'':'<div class="muted" style="font-size:13.5px">Nothing new spotted. Suggestions need at least three matching transactions (two for yearly) on a steady rhythm.</div>'}
    ${income.length?`<div class="eyebrow" style="margin:4px 0 8px">Income</div>${income.map(card).join('')}`:''}
    ${spend.length?`<div class="eyebrow" style="margin:4px 0 8px">Bills & subscriptions</div>${spend.map(card).join('')}`:''}`,
    `<span class="spacer"></span><button class="btn btn-primary" data-act="close-modal">Done</button>`);
}

/* ============================ series maths ============================ */
function monthsBack(n,end){
  const out=[]; let k=end||ui.month;
  for(let i=0;i<n;i++){ out.unshift(k); k=shiftMonth(k,-1); }
  return out;
}
function flowsOf(t){
  return {
    in:sum(t.filter(economicIn).map(x=>amtBase(x))),
    out:sum(spendParts(t).map(spendBase))
  };
}
function monthFlows(key){ return flowsOf(inMonth(key)); }          /* household */
function monthFlowsMine(key){ return flowsOf(inMonthMine(key)); }  /* the filtered member */
/* net worth at end of each month */
/* ============================ net worth over time ============================
   What each account was actually worth on a date — checkpoints, valuations and the transactions between
   them — rather than the old trick of walking today's total backwards through monthly cash flow. That
   trick treated every dollar spent as a dollar of net worth lost, so a mortgage payment or a transfer
   into a TFSA looked like a loss, and a house that gained value looked like nothing at all.

   netWorthAt(D) = Σ over accounts of (kind==='liability' ? −1 : +1) × toBase(valueAt(a,D))
   where valueAt(a,D) = 0                     if a.since and D < a.since   (it was not yours yet)
                      = balanceAsOf(a,D)      otherwise
   and balanceAsOf takes the newest checkpoint dated ≤ D and adds every transaction dated after that
   checkpoint and ≤ D. A checkpoint (or valuation) is the authority for its own date: transactions dated
   ON it are already inside it and are not added again — the same rule the live balance uses.
   Equity never appears here: a house and its mortgage are already an asset and a liability. */
function existsAt(a,D){ return !a.since||D>=a.since; }
function valueAt(a,D){ return existsAt(a,D)?balanceAsOf(a,D):0; }
function netWorthAt(D){ return r2(sum(S.accounts.map(a=>{ const v=toBase(valueAt(a,D),a.cur||baseCur()); return a.kind==='liability'?-v:v; }))); }
/* the earliest date Ledger has any evidence for: an ownership date, a checkpoint, or a transaction */
function historyStart(){
  let first='';
  const see=d=>{ if(d&&(!first||d<first)) first=d; };
  S.accounts.forEach(a=>{ see(a.since); (a.checkpoints||[]).forEach(c=>see(c.date)); });
  S.transactions.forEach(t=>see(t.date));
  return first;
}
/* accounts whose opening balance would be projected backwards for ever, because nothing says when they began */
function undatedAccounts(){ return S.accounts.filter(a=>!a.since); }
/* one pass over the transactions, then a pointer walk per account: the series costs O(transactions +
   months × accounts), not O(months × accounts × transactions). Cached until something that could move a
   balance changes — balances are rebuilt before every render, so they are part of the signature. */
let nwCache={sig:'',out:null};
/* a cheap content hash of every row: an edit that changes no count still changes the signature */
function txSignature(){ let h=0; const mix=v=>{ const str=String(v); for(let i=0;i<str.length;i++){ h=(h*31+str.charCodeAt(i))|0; } h=(h*17+1)|0; };
  S.transactions.forEach(t=>{ mix(t.id); mix(t.date); mix(t.amount); mix(t.type); mix(t.accountId||t.fromId+'>'+t.toId); mix(t.reversalOf||''); mix(t.reversedBy||''); mix(t.bankHint||''); const a=t.alloc; if(a){ mix(a.principal); mix(a.extra); mix(a.interest); mix(a.tax); mix(a.insurance); mix(a.fee); mix(a.escrow); mix(a.escrowId||''); } });
  return S.transactions.length+':'+(h>>>0).toString(36); }
function nwSignature(keys){
  return keys.join(',')+'|'+baseCur()+'|'+JSON.stringify(S.rates||{})+'|'+txSignature()+'|'+
    S.accounts.map(a=>[a.id,a.kind,a.cur||'',a.since||'',r2(a.balance),(a.opening||{}).balance,(a.checkpoints||[]).map(c=>c.date+':'+c.balance).join('~')].join(':')).join(',');
}
function netWorthSeriesAt(dates){
  const sig=nwSignature(dates);
  if(nwCache.sig===sig&&nwCache.out) return nwCache.out;
  /* per-account effects, sorted by date — one sweep of the ledger */
  const fx={}, eff={};
  S.accounts.forEach(a=>{ eff[a.id]=[]; fx[a.id]=1/rateOf(a.cur||baseCur()); anchorOf(a); });
  S.transactions.forEach(t=>{
    /* each account once: when the escrow account IS the cash or loan end, effectOn already counts it — twice would double the move */
    const ids=[...new Set(isTransfer(t)?[t.fromId,t.toId].concat(allocOf(t)&&allocOf(t).escrowId?[allocOf(t).escrowId]:[]):[t.accountId])];
    ids.forEach(id=>{ const a=acct(id); if(!a) return; const e=effectOn(t,a); if(e) eff[a.id].push({d:t.date||'',e:e}); });
  });
  S.accounts.forEach(a=>eff[a.id].sort((x,y)=>x.d<y.d?-1:x.d>y.d?1:0));
  const out=dates.map(()=>0);
  S.accounts.forEach(a=>{
    const cps=a.checkpoints||[], list=eff[a.id];
    let ci=0, base={date:openingFloor(a),balance:(a.opening||{}).balance||0}, ei=0, run=0, sign=(a.kind==='liability'?-1:1)*fx[a.id];
    while(ei<list.length&&list[ei].d<=base.date) ei++;
    dates.forEach((D,i)=>{
      while(ci<cps.length&&cps[ci].date<=D){ base=cps[ci]; ci++; ei=0; run=0; while(ei<list.length&&list[ei].d<=base.date) ei++; }
      while(ei<list.length&&list[ei].d<=D){ run+=list[ei].e; ei++; }
      if(!existsAt(a,D)) return;
      out[i]+=sign*(base.balance+run);
    });
  });
  const res=dates.map((D,i)=>r2(out[i]));
  nwCache={sig:sig,out:res};
  return res;
}
/* n months ending with the current one; the last point is today, so it lines up with the headline.
   Months before Ledger has any evidence are not drawn — an invented zero is worse than a shorter chart. */
function netWorthSeries(n){
  const nowKey=ym(new Date()), start=historyStart();
  let keys=monthsBack(n,nowKey);
  const clampedFrom=start?start.slice(0,7):'';
  if(clampedFrom&&clampedFrom>keys[0]) keys=keys.filter(k=>k>=clampedFrom);
  if(!keys.length) keys=[nowKey];
  const dates=keys.map(k=>k===nowKey?todayISO():monthEnd(k));
  const vals=netWorthSeriesAt(dates);
  const out=keys.map((k,i)=>({key:k,value:vals[i]}));
  out.from=clampedFrom; out.clamped=!!clampedFrom&&clampedFrom>monthsBack(n,nowKey)[0];
  out.undated=undatedAccounts().map(a=>a.name);
  out.fxConverted=S.accounts.some(a=>(a.cur||baseCur())!==baseCur());
  return out;
}

