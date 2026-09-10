/* Ledger — part 2 of 7: vault, self-carrying copies, origin, loans, reversals, balance sheet, balances.
   The parts load in order as plain scripts and share one scope; tools/build.js joins them back into
   one closure for the shareable single file. Keep load-time code in the part that defines what it uses. */
"use strict";

/* ============================ vault: encryption at rest ============================
   With a passphrase set, the book is AES-256-GCM encrypted with a random DATA KEY everywhere it is
   written: browser storage, backup files, "Back up everything", and copies saved with the data inside.
   The data key itself is stored only WRAPPED — once under a key derived from the passphrase, once under
   a key derived from a RECOVERY CODE handed to the person when the passphrase is set (PBKDF2-SHA256,
   310k rounds, its own salt each). Either secret opens the book; the recovery code is how a forgotten
   passphrase gets replaced. The wrappings travel inside every envelope, so a backup or a saved copy opens
   anywhere with either secret. Neither secret is ever stored; nothing readable leaves memory. */
let vaultKey=null, vaultRaw=null, vaultWraps=null, pendingRecovery='';
const VAULT_ITER=600000;   /* PBKDF2-SHA256 rounds for new wraps; each wrap records its own count so old files keep opening */
function b64(u8){ let s=''; u8.forEach(b=>s+=String.fromCharCode(b)); return btoa(s); }
function unb64(s){ const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; }
function cryptoOK(){ return !!(window.crypto&&window.crypto.subtle&&window.TextEncoder); }
function vaultOn(){ return !!vaultKey; }
async function kekFrom(secret,saltB64,extractable,iter){
  /* NFKC: the same passphrase typed on two keyboards must be the same bytes */
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(String(secret).normalize('NFKC')),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:unb64(saltB64),iterations:iter||VAULT_ITER,hash:'SHA-256'},base,{name:'AES-GCM',length:256},!!extractable,['encrypt','decrypt']);
}
async function importDataKey(raw){ return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']); }
async function encryptText(key,text){ const iv=crypto.getRandomValues(new Uint8Array(12)); const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(text)); return {iv:b64(iv),ct:b64(new Uint8Array(ct))}; }
async function decryptText(key,env){ const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(env.iv)},key,unb64(env.ct)); return new TextDecoder().decode(pt); }
function isEnvelope(x){ return !!x&&typeof x==='object'&&x.enc===1&&typeof x.ct==='string'; }
function safeParse(t){ try{ return JSON.parse(t); }catch(e){ return null; } }
/* recovery codes: 20 characters from an alphabet without look-alikes, shown in groups of five */
const RECOVERY_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRecoveryCode(){ let out=''; while(out.length<20){ const r=crypto.getRandomValues(new Uint8Array(32)); for(let i=0;i<r.length&&out.length<20;i++){ if(r[i]<248) out+=RECOVERY_ALPHABET[r[i]%RECOVERY_ALPHABET.length]; } } return out.match(/.{5}/g).join('-'); }   /* rejection sampling: no modulo bias */
function normRecovery(s){ return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function looksLikeRecovery(s){ const n=normRecovery(s); return n.length===20&&/^[A-Z0-9]+$/.test(n)&&/[-\s]/.test(String(s||'').trim()); }
async function wrapRaw(raw,secret){ const salt=b64(crypto.getRandomValues(new Uint8Array(16))); const w=await encryptText(await kekFrom(secret,salt),b64(raw)); return {salt:salt,wrap:w}; }
async function makeWraps(raw,pw,code){ const p=await wrapRaw(raw,pw), r=await wrapRaw(raw,normRecovery(code)); return {v:2,iter:VAULT_ITER,salt:p.salt,wrapP:p.wrap,rsalt:r.salt,wrapR:r.wrap}; }
function wrapsOf(o){ return o&&o.wrapP?{v:2,iter:o.iter||310000,salt:o.salt,wrapP:o.wrapP,rsalt:o.rsalt,wrapR:o.wrapR}:null; }
/* which secret opened it: 'pass' | 'recovery' | '' */
async function unwrapWith(wraps,secret){
  const iter=wraps.iter||310000;   /* first-day wraps were made at 310k */
  const tryOne=async(saltB64,wrap,sec)=>{ try{ return unb64(await decryptText(await kekFrom(sec,saltB64,false,iter),wrap)); }catch(e){ return null; } };
  const rec=looksLikeRecovery(secret);
  let raw=rec?null:await tryOne(wraps.salt,wraps.wrapP,secret); if(raw) return {raw:raw,how:'pass'};
  raw=await tryOne(wraps.rsalt,wraps.wrapR,normRecovery(secret)); if(raw) return {raw:raw,how:'recovery'};
  if(rec){ raw=await tryOne(wraps.salt,wraps.wrapP,secret); if(raw) return {raw:raw,how:'pass'}; }
  return {raw:null,how:''};
}
async function setVault(raw,wraps){ vaultRaw=raw; vaultKey=await importDataKey(raw); vaultWraps=wraps;
  try{ await openKeys(); }catch(e){}   /* the API keys are sealed under this same key: open (or re-seal) them here */ }
function clearVault(){ vaultKey=null; vaultRaw=null; vaultWraps=null; }
/* the book as it should be WRITTEN anywhere: plain JSON without a passphrase, an envelope with one */
async function sealState(indent){
  const text=indent?JSON.stringify(S,null,indent):JSON.stringify(S);
  if(!vaultKey) return text;
  const e=await encryptText(vaultKey,text);
  return JSON.stringify({enc:1,v:2,app:'ledger',rev:Number(S.settings.rev)||0,wraps:vaultWraps,iv:e.iv,ct:e.ct,saved:Date.now()});
}
/* the reverse: plain text comes back as is; an envelope is opened with the key in memory or the secret
   given (passphrase or recovery code). Throws {needPass} when a secret is required and none was given,
   {wrongPass} when it fails. The first successful open in a session becomes the session's vault. */
async function openSealed(text,secret,adopt){
  const d=safeParse(text); if(!isEnvelope(d)) return text;
  if(!cryptoOK()) throw new Error('This browser cannot decrypt (no Web Crypto)');
  if(vaultRaw){ try{ return await decryptText(await importDataKey(vaultRaw),d); }catch(e){} }   /* same book family: no secret needed */
  if(secret==null) throw Object.assign(new Error('passphrase needed'),{needPass:true});
  if(d.v!==2||!d.wraps){
    /* first-day envelopes (v1) derived the key straight from the passphrase: open, then move to a FRESH random data key */
    try{ const key=await kekFrom(secret,d.salt,false,310000); const pt=await decryptText(key,d);
      if(adopt&&!vaultKey){ const raw=crypto.getRandomValues(new Uint8Array(32)); const code=newRecoveryCode(); await setVault(raw,await makeWraps(raw,secret,code)); pendingRecovery=code; }
      lastUnlockHow='pass'; return pt; }
    catch(e){ throw Object.assign(new Error('wrong passphrase'),{wrongPass:true}); }
  }
  const u=await unwrapWith(d.wraps,secret); if(!u.raw) throw Object.assign(new Error('wrong passphrase'),{wrongPass:true});
  try{ const pt=await decryptText(await importDataKey(u.raw),d); if(adopt&&!vaultKey) await setVault(u.raw,d.wraps); lastUnlockHow=u.how; return pt; }
  catch(e){ throw Object.assign(new Error('the passphrase is right but the saved book is damaged'),{damaged:true}); }   /* the secret unwrapped the key: the ciphertext itself is broken */
}
/* a browser with no vault of its own takes on the vault of a book it just opened — only ever by this explicit step,
   never as a side effect of reading a file, and never over an existing vault */
function adoptOpenedVault(){ if(vaultKey&&vaultWraps&&!lockEncrypts()){ saveLock(Object.assign({timeout:S.settings.lockTimeout||LOCK_DEFAULT},vaultWraps)); return true; } return false; }
let lastUnlockHow='';
let pendingRekey='';   /* a backup adopted into an empty browser is re-keyed right after the restore */
/* ask for a passphrase in a small form; cb(pw) runs on submit */
function passphrasePrompt(title,note,cb){
  openForm({title:title,fields:[{name:'pass',label:'Passphrase or recovery code',type:'password',value:'',placeholder:'Passphrase'}],note:note||'',
    onSubmit:v=>{ if(!v.pass){ toast('Enter the passphrase'); return false; } closeModal(); cb(v.pass); }});
}
/* boot-time unlock: the stored book is an envelope, so nothing can render until a secret opens it */
let pendingUnlock=null;
function unlockAtBoot(text,sub){
  return new Promise(resolve=>{ pendingUnlock={text:text,resolve:resolve,adopt:true}; showLock(sub||'Enter your passphrase to open your Ledger'); });
}
/* the recovery code, shown once when it is made: copy it, email it to yourself, or download it */
function recoverySheet(code,why){
  const subject='Ledger recovery code', body='Your Ledger recovery code:\n\n'+code+'\n\nIf you ever forget your Ledger passphrase, type this code on the lock screen instead, then choose a new passphrase. Keep this email. Anyone who has this code can open your Ledger.';
  const mail='mailto:?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body);
  openSheet(why==='upgraded'?'Your Ledger now has a recovery code':'Your recovery code',`
    <div style="line-height:1.6;font-size:15px">
      <p style="margin-top:0">${why==='upgraded'?'Your passphrase-protected book has been moved to the newer format, and this code was made for it. ':''}If you ever forget your passphrase, this code opens the book instead, and you choose a new passphrase. <b>It is shown once.</b> Save it somewhere that is not this computer.</p>
      <div id="recoveryCode" class="num" style="font-size:22px;letter-spacing:.08em;padding:14px 16px;border:1px dashed var(--rule-strong);border-radius:10px;text-align:center;user-select:all">${esc(code)}</div>
      <p style="margin-bottom:0;font-size:13.5px" class="muted">Anyone holding this code can open your Ledger, so treat it like the passphrase. Ledger cannot email it for you — the button opens your own mail app with the code filled in; an email is only as private as your mailbox.</p>
    </div>`,
    `<button class="btn" data-act="recovery-copy" data-code="${esc(code)}">Copy</button>
     <a class="btn" href="${mail}" id="recoveryMail">Email it to myself</a>
     <button class="btn" data-act="recovery-download" data-code="${esc(code)}">Download</button><span class="spacer"></span>
     <button class="btn btn-primary" data-act="close-modal">I have saved it</button>`);
}
/* after a recovery-code unlock: the old passphrase is gone for good, so ask for a new one now */
function newPassphraseForm(why){
  openForm({title:'Choose a new passphrase',fields:[{name:'p1',label:'New passphrase',type:'password',value:''},{name:'p2',label:'Type it again',type:'password',value:''}],
    note:why||'You opened the book with your recovery code. Set a new passphrase now; you will be given a new recovery code, and the old one stops opening anything saved from now on.',
    onSubmit:v=>{ if(!v.p1||v.p1.length<PASS_MIN){ toast('Use at least '+PASS_MIN+' characters'); return false; } if(v.p1!==v.p2){ toast('Passphrases do not match'); return false; }
      closeModal(); changePassphrase(v.p1).then(code=>{ toast('New passphrase set — the book was re-encrypted'); refreshSettingsIfOpen(); recoverySheet(code,'new'); }).catch(e=>toast('Could not change it: '+errStr(e))); }});
}
/* any change of secret ROTATES the data key: the book is re-encrypted under a fresh key, so an old passphrase or
   recovery code opens nothing written from now on. Files saved earlier keep opening with the secrets they were
   saved under — nothing can reach into a file already handed out. Both changes hand out a new recovery code. */
let vaultRotating=false;   /* during a rotation the lock record trails the vault for one save: the identity gate stands aside */
async function rekeyVault(pw,code){
  if(String(pw).length<PASS_MIN) throw new Error('use at least '+PASS_MIN+' characters');
  const raw=crypto.getRandomValues(new Uint8Array(32)); const wraps=await makeWraps(raw,pw,code);
  const oldRaw=vaultRaw, oldWraps=vaultWraps, oldLock=loadLock();
  await setVault(raw,wraps); vaultRotating=true;
  let saved=false; try{ saved=await saveNow(); } finally{ vaultRotating=false; }   /* the book is re-encrypted BEFORE the lock record moves */
  if(!saved){ await setVault(oldRaw,oldWraps); if(oldLock) saveLock(oldLock); throw new Error('another tab saved newer changes — reload before changing the passphrase'); }
  saveLock(Object.assign({timeout:S.settings.lockTimeout||LOCK_DEFAULT},wraps));
  clearDlog(); await resealBackups(); return code;
}
let vaultPass='';   /* the passphrase in memory while unlocked, only so a new recovery code can be issued without asking twice */
async function changePassphrase(newPw){
  if(!vaultRaw||!vaultWraps) throw new Error('the book is not unlocked');
  const code=await rekeyVault(newPw,newRecoveryCode()); vaultPass=newPw; return code;
}
async function newRecoveryCodeForVault(pw){
  if(!vaultRaw||!vaultWraps) throw new Error('the book is not unlocked');
  const p=pw||vaultPass; if(!p) throw new Error('the passphrase is needed to issue a new code');
  return rekeyVault(p,newRecoveryCode());
}

/* ============================ a copy that carries its own data ============================
   In the shared single-file build the book lives in the browser, which is lost when site data is cleared
   or the person changes browser. So the file itself can carry the book: selfHTML() rebuilds this very page
   from the DOM — styles, code, the pristine body markup kept in #ledger-body — with the state embedded as
   #ledger-data. Opening that copy anywhere adopts the book (empty browser) or offers it (browser already
   holds one). API keys and the privacy lock are device things and never go into the copy. */
async function selfHTML(){
  if(!isDist()) return '';
  const tpl=document.getElementById('ledger-body'); if(!tpl) return '';
  const head=document.head.cloneNode(true);
  head.querySelectorAll('script[src],link[rel="icon"]').forEach(n=>n.remove());   /* runtime additions (OCR loader, favicon) are not part of the app */
  const attrs=el=>Array.from(el.attributes).map(a=>' '+a.name+(a.value?'="'+a.value.replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'"':'')).join('');
  const lock=loadLock();
  const payload=vaultKey?{saved:Date.now(),version:APP_VERSION,sealed:safeParse(await sealState()),lock:wrapsOf(lock)?Object.assign({timeout:lock.timeout||LOCK_DEFAULT},wrapsOf(lock)):null}
                        :{saved:Date.now(),version:APP_VERSION,state:S};
  const data='<script type="application/json" id="ledger-data">'+JSON.stringify(payload).replace(/<\//g,'<\\/')+'</'+'script>';
  /* a copy made from a copy must not carry the earlier payload forward: only the app scripts, plus the fresh data block */
  const scripts=Array.from(document.querySelectorAll('body > script')).filter(s=>s.id!=='ledger-data').map(s=>(s.id==='ledger-app'?data+'\n':'')+'<script'+attrs(s)+'>'+s.textContent+'</'+'script>').join('\n');
  const root=document.documentElement;
  return '<!DOCTYPE html>\n<html'+attrs(root)+'>\n'+head.outerHTML+'\n<body>\n'+tpl.textContent.trim()+'\n'+scripts+'\n</body>\n</html>\n';
}
async function exportSelf(){
  const html=await selfHTML(); if(!html){ toast('Only the shareable single-file Ledger can save a copy of itself'); return; }
  download('Ledger-'+todayISO()+'.html',html,'text/html;charset=utf-8');
  S.settings.lastBackup=Date.now(); S.settings.backupNudged=0; save(); render();
  dlog('self-contained copy saved',{transactions:S.transactions.length,bytes:html.length});
  toast(vaultKey?'Saved — the copy is encrypted with your passphrase and opens anywhere with it':'Saved — that file opens with everything in it, in any browser');
}
function embeddedBook(){
  const all=document.querySelectorAll('script#ledger-data'); const el=all[all.length-1]; if(!el) return null;   /* the last payload is the current one */
  try{ const d=JSON.parse(el.textContent); if(!d) return null;
    if(isEnvelope(d.sealed)) return d;   /* protected copy: contents unknown until the passphrase opens it */
    if(!d.state||typeof d.state!=='object') return null; if(validateBackupShape(d.state).length) return null; return d; }catch(e){ return null; }
}
/* the plain state of an embedded book, opening a protected one with the passphrase (or the key in memory) */
async function embeddedState(d,pw){
  if(d.state) return d.state;
  const pt=await openSealed(JSON.stringify(d.sealed),pw,false); const st=safeParse(pt);
  if(!st||validateBackupShape(st).length) throw new Error('the copy is damaged'); return st;
}
function adoptLockFrom(d){ if(lockEncrypts()) return; const w=vaultWraps||wrapsOf(d&&d.lock); if(w) saveLock(Object.assign({timeout:(d&&d.lock&&d.lock.timeout)||LOCK_DEFAULT},w)); }   /* never over this device's own vault */
/* right after load(): an empty browser takes the file's book silently; a browser that already holds one is asked once per copy */
async function adoptEmbeddedData(){
  const d=embeddedBook(); if(!d) return false;
  const stamp=String(d.saved||0);
  if(S.settings.embedSeen===stamp) return false;
  const empty=!S.transactions.length&&!S.accounts.length;
  if(empty){
    let state=d.state;
    if(!state){   /* a protected copy: the passphrase opens it, and becomes this browser's passphrase too */
      const pt=await unlockAtBoot(JSON.stringify(d.sealed),'This file is protected. Enter its passphrase to open the book inside it');
      state=safeParse(pt); if(!state||validateBackupShape(state).length){ toast('The copy inside this file is damaged'); return false; }
      adoptLockFrom(d); pendingRekey=vaultPass||'';
    }
    const keepSettings=clone(S.settings);
    S=freshState(); healState(state); recalcBalances();
    S.settings.onboarded=true; S.settings.embedSeen=stamp; S.settings.lastBackup=Number(d.saved)||0;
    ['theme','textSize','lockTimeout'].forEach(k=>{ if(keepSettings[k]!==undefined) S.settings[k]=keepSettings[k]; });
    save(); dlog('book adopted from the file',{saved:d.saved,transactions:S.transactions.length});
    setTimeout(()=>toast('Loaded the book saved inside this file on '+fmtDate(new Date(Number(d.saved)||Date.now()).toISOString().slice(0,10))),300);
    return true;
  }
  return false;   /* the banner in render() offers it */
}
function renderEmbedOffer(){
  let bar=document.getElementById('embedbar');
  const d=embeddedBook(); const stamp=d?String(d.saved||0):'';
  const want=d&&S.settings.embedSeen!==stamp&&(S.transactions.length||S.accounts.length);
  if(want){
    if(!bar){
      const n=d.state?(d.state.transactions||[]).length:-1, a=d.state?(d.state.accounts||[]).length:-1;
      bar=document.createElement('div'); bar.id='embedbar'; bar.className='alertbar soft'; bar.setAttribute('role','alert');
      bar.innerHTML='<b>This file carries a saved book.</b>Saved '+esc(new Date(Number(d.saved)||0).toLocaleString())+(n>=0?' with '+n+' transaction'+(n===1?'':'s')+' and '+a+' account'+(a===1?'':'s'):', protected by a passphrase')+'. This browser already holds a book with '+S.transactions.length+' transaction'+(S.transactions.length===1?'':'s')+'. Which one do you want here? '+
        '<button class="btn btn-sm btn-primary" data-act="embed-use" style="margin-top:9px">Use the file\'s copy</button> '+
        '<button class="btn btn-sm btn-ghost" data-act="embed-keep" style="margin-top:9px">Keep this browser\'s</button>';
      const board=document.getElementById('board'); if(board&&board.parentNode) board.parentNode.insertBefore(bar,board);
    }
  }else if(bar){ bar.remove(); }
}
/* ============================ which Ledger is this? ============================
   Browser storage belongs to an ORIGIN. http://localhost:8765/… and file:///…/finance-dashboard.html run
   the very same file but keep entirely separate data, which is how one machine ends up with two Ledgers
   that cannot see each other. Ledger cannot read the other store — no page can — so it does the next best
   thing: it always says which one you are looking at. Nothing here affects a single figure. */
const CANONICAL_URL='http://localhost:8765/finance-dashboard.html';
function appOrigin(){
  if(location.protocol==='file:') return 'file';
  if(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return 'localhost';
  return 'other';
}
/* a shared single-file build (window.LEDGER_DIST, set by tools/build.js) has no other copy to defer to: wherever it is opened IS the Ledger */
function isDist(){ return !!(window.LEDGER_DIST&&typeof window.LEDGER_DIST==='object'); }
function isCanonical(){ return isDist()||appOrigin()==='localhost'; }
function originLabel(){ const o=appOrigin(); return o==='file'?'Local file':o==='localhost'?'Localhost':'Web server'; }
function originBadge(){
  const o=appOrigin();
  if(isDist()) return '<span class="orig ok" title="Everything is stored by this browser, on this computer. Nothing is sent anywhere.">● THIS COMPUTER</span>';
  return o==='localhost'?'<span class="orig ok" title="This is your canonical Ledger">● LOCALHOST</span>'
       : o==='file'?'<span class="orig warn" title="Separate data store from your canonical Ledger">⚠ LOCAL FILE</span>'
       : '<span class="orig" title="'+esc(location.origin)+'">● '+esc(location.hostname)+'</span>';
}
function baseCur(){ return (S.settings&&S.settings.currency)||'CAD'; }
function rateOf(cur){
  if(!cur||cur===baseCur()) return 1;
  const r=Number((S.rates||{})[cur]);
  return (r>0)?r:1;                       /* unknown rate: treat 1:1 and flag in settings */
}
function hasRate(cur){ return cur===baseCur()||Number((S.rates||{})[cur])>0; }
function toBase(amount,cur){ return (Number(amount)||0)/rateOf(cur); }
function curOfAcct(id){ const a=acct(id); return (a&&a.cur)||baseCur(); }
function curOfTx(t){ return t.type==='transfer'?curOfAcct(t.fromId):curOfAcct(t.accountId); }
function usedCurrencies(){
  const set={}; set[baseCur()]=1;
  S.accounts.forEach(a=>{ if(a.cur) set[a.cur]=1; });
  Object.keys(S.rates||{}).forEach(c=>{set[c]=1;});
  return Object.keys(set);
}
function money(n,opts){
  opts=opts||{};
  const v=Number(n)||0;
  const cur=opts.cur||baseCur();
  try{
    return new Intl.NumberFormat(undefined,{
      style:'currency',currency:cur,
      minimumFractionDigits:opts.round?0:2,maximumFractionDigits:opts.round?0:2
    }).format(v);
  }catch(e){ return (v<0?'-':'')+Math.abs(v).toFixed(opts.round?0:2)+' '+cur; }
}
/* an amount shown in its own currency, with the base equivalent when they differ */
function moneyDual(amount,cur,opts){
  const txt=money(amount,Object.assign({},opts,{cur:cur}));
  if(cur===baseCur()) return txt;
  return txt+' <span class="muted">≈ '+money(toBase(amount,cur),opts)+'</span>';
}
function signed(n){return (n>0?'+':n<0?'−':'')+money(Math.abs(n));}
function fmtDate(iso){
  if(!iso) return '';
  const [y,m,d]=iso.split('-').map(Number);
  const dt=new Date(y,m-1,d);
  const f=S.settings.dateFormat;
  if(f==='iso') return iso;
  if(f==='dmy') return pad2(d)+'/'+pad2(m)+'/'+y;
  return dt.toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
function cat(id){return S.categories.find(c=>c.id===id)||S.categories.find(c=>c.id==='c0')||{id:'c0',name:'Uncategorised',color:'#9A9A9A',type:'out',need:false};}
function uncatId(){ const c=S.categories.find(x=>x.id==='c0'); return c?c.id:(S.categories.find(x=>x.id==='c10')||S.categories.find(x=>x.type==='out')||{}).id; }
/* an account confirmed during a statement review but not yet committed: the review sees it, the book does not */
let stagedAccount=null, reviewSnap='', reviewDirty=false, commitFailAt='';
function acct(id){return S.accounts.find(a=>a.id===id)||(stagedAccount&&stagedAccount.id===id?stagedAccount:null);}
function txMonth(t){return (t.date||'').slice(0,7);}
/* The month's rows for the WHOLE household. Budgets, goals, the what-if planner, debt plans, exports and
   net worth all build on this and must never see the member filter — a budget is set for the house, so
   one person's spending against it would be meaningless. The per-person view is opt-in: only the widgets
   that ask for inMonthMine() (cash flow, transactions, spending breakdown, essentials vs. fun) filter. */
function inMonth(key){return S.transactions.filter(t=>txMonth(t)===key);}
function inMonthMine(key){return inMonth(key).filter(txUserVisible);}
/* 'all' = whole household; a user id = just their rows; 'unassigned' = rows not yet attributed to anyone. */
function memberFilterOn(){ return !!S.users.length&&(ui.user||'all')!=='all'; }
/* the member a new row should default to while one person is filtered — '' when viewing everyone/unassigned */
function filteredUserId(){ const f=ui.user||'all'; return f!=='all'&&f!=='unassigned'&&S.users.some(u=>u.id===f)?f:''; }
function txUserVisible(t){
  const f=ui.user||'all';
  if(f==='all') return true;
  if(f==='unassigned') return !t.userId;
  return t.userId===f;
}
function userOf(t){ return t&&t.userId?S.users.find(u=>u.id===t.userId):null; }
function userLabel(t){ const u=userOf(t); return u?u.name:'Unassigned'; }
function userOptions(){ return [{value:'',label:'— unassigned —'}].concat(S.users.map(u=>({value:u.id,label:u.name}))); }
function sum(a){return a.reduce((x,y)=>x+y,0);}
/* a transfer moves money between your own accounts: neither income nor
   spending, so it must not touch net worth, budgets, or the spending split */
function flow(t){return t.type==='in'?t.amount:t.type==='out'?-t.amount:0;}
/* ============================ loan payments ============================
   ONE payment stays ONE row in the ledger. What differs from an ordinary transfer is that only part of it
   pays the loan down: the rest is interest, property tax, insurance or fees — real expenses — and possibly
   an escrow contribution that is still your money. So the row carries an allocation and every figure reads
   its parts from there rather than from a second, invented transaction:
       cash out    = the whole amount, always, the moment its date arrives
       liability   ↓ principal + extra principal only
       spending    = interest + tax + insurance + fee (each in its own category)
       escrow      → an escrow account you own, if you have one; net worth unaffected by that part
       unresolved  = whatever is not accounted for — cash gone, nothing credited, and clearly flagged.
                     Ledger never invents a principal figure to make the sum come out. */
const ALLOC_EXPENSE=[['interest','c35','Interest'],['tax','c36','Property tax'],['insurance','c20','Insurance'],['fee','c22','Fees']];
function allocOf(t){ return t&&t.alloc&&typeof t.alloc==='object'?t.alloc:null; }
function isLoanPayment(t){ return !!allocOf(t); }
function allocNum(a,f){ const n=Number(a&&a[f]); return isFinite(n)&&n>0?n:0; }
function allocPrincipal(t){ const a=allocOf(t); return a?r2(allocNum(a,'principal')+allocNum(a,'extra')):0; }
/* escrow only counts as yours when it has somewhere of yours to go */
function allocEscrow(t){ const a=allocOf(t); return a&&a.escrowId&&acct(a.escrowId)?allocNum(a,'escrow'):0; }
function allocExpenses(t){ const a=allocOf(t); if(!a) return [];
  return ALLOC_EXPENSE.map(([f,c,label])=>({field:f,label:label,amount:allocNum(a,f),categoryId:(a[f+'Cat']&&cat(a[f+'Cat']).id===a[f+'Cat'])?a[f+'Cat']:c})).filter(p=>p.amount>0.005); }
/* +1 for a payment INTO the loan; −1 when the money comes back OUT of the loan (a reversed payment): the
   interest is refunded, not spent twice, and the principal is re-borrowed, not paid twice */
function allocSign(t){ const a=allocOf(t); if(!a) return 1; const f=acct(t.fromId), to=acct(t.toId); return (f&&f.kind==='liability'&&!(to&&to.kind==='liability'))?-1:1; }
function allocAssigned(t){ return allocOf(t)?r2(allocPrincipal(t)+sum(allocExpenses(t).map(p=>p.amount))+allocEscrow(t)):0; }
function allocUnresolved(t){ const a=allocOf(t); if(!a) return 0; return r2(Math.max(0,(Number(t.amount)||0)-allocAssigned(t))); }
function allocState(t){ const a=allocOf(t); if(!a) return ''; const amt=Number(t.amount)||0, u=allocUnresolved(t);
  return u<=0.005?'known':(u>=amt-0.005?'pending':'partial'); }
function allocLabel(t){ const st=allocState(t); return st==='pending'?'Allocation pending':st==='partial'?'Partly allocated':st==='known'?'Allocated':''; }
function allocSummary(t){
  const a=allocOf(t); if(!a) return '';
  const bits=[]; const pr=allocNum(a,'principal'), ex=allocNum(a,'extra');
  if(pr) bits.push('principal '+money(pr)); if(ex) bits.push('extra principal '+money(ex));
  allocExpenses(t).forEach(p=>bits.push(p.label.toLowerCase()+' '+money(p.amount)));
  const es=allocNum(a,'escrow'); if(es) bits.push('escrow '+money(es)+(allocEscrow(t)?' → '+(acct(a.escrowId)||{}).name:' (no escrow account — unresolved)'));
  const u=allocUnresolved(t); if(u>0.005) bits.push(money(u)+' not yet allocated');
  return bits.join(' · ');
}
/* the expenses hiding inside a month: ordinary out rows, plus the expense components of loan payments */
function spendParts(list){
  const out=[];
  (list||[]).forEach(t=>{
    if(t.type==='out'){ if(!isReversed(t)) out.push({t:t,amount:Number(t.amount)||0,categoryId:t.categoryId,cur:curOfTx(t)}); }
    else if(isTransfer(t)){ const sg=allocSign(t); allocExpenses(t).forEach(p=>out.push({t:t,amount:sg*p.amount,categoryId:p.categoryId,cur:curOfAcct(t.fromId),part:p.field})); }
  });
  return out;
}
function spendBase(p){ return toBase(p.amount,p.cur); }
function monthLoanPrincipal(key){ return sum(inMonthMine(key).filter(isLoanPayment).map(t=>toBase(allocSign(t)*allocPrincipal(t),curOfAcct(t.fromId)))); }
function monthUnresolved(key){ return sum(inMonthMine(key).filter(isLoanPayment).map(t=>toBase(allocUnresolved(t),curOfAcct(t.fromId)))); }
/* ============================ reversals ============================
   A failed transfer and its reclaim are two real bank movements — the balance needs both — but together
   they are economically nothing: the money left and came straight back. So the pair stays in the ledger
   exactly as the bank recorded it, and the two rows point at each other:
       original (out) . reversedBy  = id of the reclaim
       reclaim  (in)  . reversalOf  = id of the original
   Every balance, statement total and reconciliation still contains both. Only the analytics change:
   the original is not spending and the reclaim is not income. A merchant refund is NOT this — a refund
   is a merchant giving money back and stays an ordinary "in" unless you link it yourself.
   Links are made only on strong evidence — same account, same amount, opposite direction, within a few
   days, and reclaim/reversal wording on the incoming row — and only when exactly one row fits; anything
   else stays for you to decide. */
const REVERSAL_DAYS=7;
function txById(id){ return id?S.transactions.find(x=>x.id===id)||null:null; }
function isReversal(t){ return !!(t&&t.type==='in'&&t.reversalOf&&txById(t.reversalOf)); }   /* the reclaim */
function isReversed(t){ return !!(t&&t.type==='out'&&t.reversedBy&&txById(t.reversedBy)); }  /* the original */
function reversalPartner(t){ return isReversal(t)?txById(t.reversalOf):isReversed(t)?txById(t.reversedBy):null; }
/* what counts economically: money in that was not a reclaim, money out that was not reversed */
function economicIn(t){ return t.type==='in'&&!isReversal(t)&&t.bankHint!=='cardpay'; }
/* a payment into a debt whose paying account is not tracked here: it lowers the debt, it is not income */
function isCardPayIn(t){ return t.type==='in'&&t.bankHint==='cardpay'; }
function economicOut(t){ return t.type==='out'&&!isReversed(t); }
function daysApart(a,b){ return Math.abs((new Date(a+'T12:00:00')-new Date(b+'T12:00:00'))/864e5); }
/* orig must be an out row, rev an in row, same account, same amount — the shape of a reversal */
function reversalPairOk(orig,rev){
  return !!(orig&&rev&&orig!==rev&&orig.type==='out'&&rev.type==='in'&&orig.accountId&&orig.accountId===rev.accountId
    &&Math.abs(r2(orig.amount)-r2(rev.amount))<0.005&&/^\d{4}-\d{2}-\d{2}$/.test(orig.date||'')&&/^\d{4}-\d{2}-\d{2}$/.test(rev.date||''));
}
function unlinkReversal(t){
  if(!t) return; const p=reversalPartner(t);
  if(p){ delete p.reversedBy; delete p.reversalOf; delete p.revSource; }
  delete t.reversedBy; delete t.reversalOf; delete t.revSource;
}
function linkReversal(orig,rev,source){
  if(!reversalPairOk(orig,rev)) return false;
  unlinkReversal(orig); unlinkReversal(rev);
  orig.reversedBy=rev.id; rev.reversalOf=orig.id; rev.revSource=source||'manual';
  dlog('reversal linked',{original:orig.id,reversal:rev.id,amount:r2(rev.amount),source:rev.revSource});
  return true;
}
/* rows that could be the other half of t: unlinked, same account, same amount, opposite direction, close in date.
   For an incoming row the candidates are earlier-or-same-day outgoing rows; the date window is the only
   softness — amount, account, direction and order are exact. */
function reversalCandidates(t,pool){
  if(!t||t.type==='transfer') return [];
  const list=(pool||S.transactions).filter(x=>x!==t&&x.id!==t.id&&x.type!=='transfer'&&!reversalPartner(x));
  /* a reclaim reverses something that already happened: the original is dated on or before it, never after —
     so a retried payment the day after the reclaim is not a candidate */
  const out=t.type==='in'?list.filter(x=>reversalPairOk(x,t)&&x.date<=t.date):list.filter(x=>reversalPairOk(t,x)&&x.date>=t.date);
  return out.filter(x=>daysApart(x.date,t.date)<=REVERSAL_DAYS).sort((a,b)=>daysApart(a.date,t.date)-daysApart(b.date,t.date)||(a.date<b.date?-1:1));
}
/* does this incoming row say it is a reclaim/reversal? — the wording is required for an automatic link */
function saysReversal(t){ const h=bankHint(t&&t.note||''); return !!(h&&h.kind==='reversal')||t&&t.bankHint==='reversal'; }
/* automatic linking after an import: only an incoming row that SAYS reclaim, with exactly ONE outgoing row
   that fits in the same account. Two fits, or none, is ambiguous and is left for the user. */
function autoLinkReversals(rows){
  const linked=[], review=[];
  (rows||[]).filter(t=>t.type==='in'&&!reversalPartner(t)&&saysReversal(t)).forEach(t=>{
    const c=reversalCandidates(t);
    if(c.length===1&&linkReversal(c[0],t,'import')) linked.push(t); else review.push({t:t,fits:c.length});
  });
  return {linked:linked,review:review};
}
function reversalLabel(t){
  const p=reversalPartner(t); if(!p) return '';
  return isReversal(t)?'Reversal of '+fmtDate(p.date)+' — not income':'Reversed on '+fmtDate(p.date)+' — not spending';
}
/* the same movement expressed in the base currency, for every total and chart */
function flowBase(t){ return t.type==='transfer'?0:toBase(flow(t),curOfTx(t)); }
function amtBase(t){ return toBase(t.amount,curOfTx(t)); }
function isTransfer(t){return t.type==='transfer';}
function netWorth(){return sum(S.accounts.map(a=>{const v=toBase(a.balance,a.cur||baseCur());return a.kind==='liability'?-v:v;}));}
/* ============================ balance sheet ============================
   Every asset and every debt is an account in S.accounts — one list, one source of truth. acctType says what
   kind of thing it is; the balance-sheet group and the asset/liability side follow from it. Accounts made
   before types existed have none: assets file under Cash & bank, debts under Other debt, until typed. */
const ACCT_TYPES=[
  ['cash','Cash on hand','asset','cash'],['chequing','Chequing','asset','cash'],['savings','Savings','asset','cash'],
  ['investment','Investment (TFSA, RRSP, brokerage…)','asset','investments'],['real estate','Real estate','asset','realestate'],
  ['vehicle','Vehicle','asset','vehicles'],['other asset','Other asset','asset','otherassets'],
  ['credit card','Credit card','liability','cards'],['mortgage','Mortgage','liability','mortgages'],['car loan','Car loan','liability','carloans'],
  ['student loan','Student loan','liability','studentloans'],['line of credit','Line of credit','liability','loc'],
  ['personal loan','Personal loan','liability','personalloans'],['other loan','Other debt','liability','otherdebt']];
const BS_GROUPS=[['cash','Cash & bank','asset'],['investments','Investments','asset'],['realestate','Real estate','asset'],['vehicles','Vehicles','asset'],['otherassets','Other assets','asset'],
  ['cards','Credit cards','liability'],['mortgages','Mortgages','liability'],['carloans','Car loans','liability'],['studentloans','Student loans','liability'],['loc','Lines of credit','liability'],['personalloans','Personal loans','liability'],['otherdebt','Other debt','liability']];
const INVEST_TYPES=['TFSA','RRSP','FHSA','RESP','Non-registered','Pension','Crypto','Other'];
function acctTypeInfo(t){ return ACCT_TYPES.find(x=>x[0]===t)||null; }
function typeKind(type){ const i=acctTypeInfo(type); return i?i[2]:(type==='loan'?'liability':'asset'); }
function acctTypeLabel(a){ const i=acctTypeInfo(a.acctType); return i?i[1].replace(/ \(.*\)$/,''):(a.kind==='liability'?'Liability':'Asset'); }
function acctGroup(a){ const i=acctTypeInfo(a.acctType); if(i&&i[2]===a.kind) return i[3]; return a.kind==='liability'?'otherdebt':'cash'; }
/* what a liability with money owed TO you looks like: an overpaid card is "$125.00 credit", never an error */
function balanceLabel(a){ const v=Number(a.balance)||0, cur=a.cur||baseCur(); if(a.kind==='liability'&&v<-0.005) return '<span class="in">'+moneyDual(Math.abs(v),cur)+' credit</span>'; return moneyDual(v,cur); }
/* a debt that has only ever received payments: Ledger has not seen what is owed */
/* a debt with no statement checkpoint is never a proven balance: say so, and say where the figure came from */
function unreconciledNote(a){
  if(a.kind!=='liability'||(a.checkpoints||[]).length) return '';
  const paid=S.transactions.some(t=>t.toId===a.id||t.fromId===a.id);
  const op=a.opening||{}; const hand=op.source==='manual'||(Math.abs(Number(op.balance)||0)>0.005&&op.source!=='statement');
  if(hand) return 'balance entered by hand — no statement yet, so what is owed is not verified';
  if(paid) return 'payments recorded, no statement yet — what is owed is unknown';
  return 'no statement yet — what is owed is unknown';
}
function unreconciledLiabilities(){ return S.accounts.filter(a=>unreconciledNote(a)); }
function netWorthIncompleteNote(){ const n=unreconciledLiabilities().length; return n?'Net worth incomplete — '+n+' liabilit'+(n===1?'y has':'ies have')+' no reconciled statement balance':''; }
/* all the figures on the balance sheet, in base currency. Equity is display only: the house and the
   mortgage are already in assets and liabilities, so equity is never added to anything. */
/* Accounts made before types existed. Ledger suggests, but never types them by itself: a wrong guess
   would silently move money between balance-sheet groups. Only same-kind types are offered here, so
   confirming one can never flip an asset into a debt — and never touches balances or history. */
function untypedAccounts(){ return S.accounts.filter(a=>!acctTypeInfo(a.acctType)); }
const TYPE_HINTS=[[/line of credit|\bloc\b|heloc/,'line of credit'],[/mortgage/,'mortgage'],[/(car|auto|vehicle|truck)\s*(loan|financ)/,'car loan'],
  [/student loan|osap|nslsc|sallie|navient|nelnet/,'student loan'],[/personal loan/,'personal loan'],
  [/credit card|\bvisa\b|mastercard|\bamex\b|american express|\bcard\b/,'credit card'],
  [/chequing|checking/,'chequing'],[/\bsavings?\b/,'savings'],[/tfsa|rrsp|fhsa|resp|invest|brokerage|portfolio|pension|crypto/,'investment'],
  [/house|home|condo|property|real estate|cottage|\bland\b/,'real estate'],[/vehicle|\bcar\b|truck|\bsuv\b|motorcycle/,'vehicle'],
  [/\bcash\b|wallet|petty/,'cash']];
function suggestAcctType(a){
  const t=normText([a.name,a.label,a.institution].filter(Boolean).join(' '));
  for(let i=0;i<TYPE_HINTS.length;i++){ const [rx,type]=TYPE_HINTS[i]; if(rx.test(t)&&typeKind(type)===(a.kind==='liability'?'liability':'asset')) return type; }
  return '';
}
function typeReviewModal(){
  const list=untypedAccounts();
  if(!list.length){ toast('Every account already has a type'); return; }
  const row=a=>{ const sug=suggestAcctType(a), same=ACCT_TYPES.filter(t=>t[2]===(a.kind==='liability'?'liability':'asset'));
    return `<div class="trow" style="flex-wrap:wrap;gap:6px 14px;align-items:flex-start">
      <span class="grow" style="min-width:180px"><b>${esc(a.name)}</b>
        <div class="muted" style="font-size:12.5px">${a.kind==='liability'?'Money you owe':'Money you have'}${a.institution?' · '+esc(a.institution):''}${a.last4?' · ····'+esc(a.last4):''}${a.label?' · '+esc(a.label):''} · <span class="num">${balanceLabel(a)}</span></div>
        ${sug?`<div class="muted" style="font-size:12.5px;margin-top:3px">Suggested: <b>${esc(acctTypeInfo(sug)[1])}</b> <button class="btn btn-sm btn-ghost" data-act="type-use" data-id="${a.id}" data-v="${esc(sug)}">Confirm suggestion</button></div>`:'<div class="muted" style="font-size:12.5px;margin-top:3px">No confident suggestion — choose one.</div>'}</span>
      <select data-tsel="${a.id}" style="width:auto;min-width:190px"><option value="">— skip for now —</option>${same.map(t=>`<option value="${t[0]}">${esc(t[1])}${t[0]===sug?' (suggested)':''}</option>`).join('')}</select>
    </div>`; };
  openSheet('Review account types',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">${list.length} account${list.length===1?'':'s'} need${list.length===1?'s':''} a type before all balance-sheet metrics are fully accurate — net worth is already right, but grouping, liquid net worth and equity need to know what each account is. Nothing is typed until you confirm it here, and typing an account never changes its balance or history.
    ${list.some(a=>suggestAcctType(a))?'<div style="margin-top:8px"><button class="btn btn-sm" data-act="type-use-all">Fill in every suggestion</button></div>':''}</div>
    <div class="tbl">${list.map(row).join('')}</div>
    <div class="muted" style="font-size:12.5px;margin-top:10px">Only types that keep this account on the side it is on are offered. To turn an asset into a debt (or back), edit the account itself.</div>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Skip for now</button><button class="btn btn-primary" data-act="type-save">Save types</button>`);
}
function applyTypeReview(){
  const picks=[]; document.querySelectorAll('[data-tsel]').forEach(sel=>{ if(sel.value) picks.push([sel.dataset.tsel,sel.value]); });
  if(!picks.length){ toast('Nothing chosen yet — pick a type, or Skip for now'); return; }
  markUndo();
  picks.forEach(([id,type])=>{ const a=acct(id); if(!a||typeKind(type)!==a.kind) return; a.acctType=type; if(!a.institution) a.institution=a.institution||''; });
  dlog('account types confirmed',{count:picks.length});
  save(); closeModal(); render(); toast(picks.length+' account'+(picks.length===1?'':'s')+' typed — balance sheet updated',true);
}
function balanceSheet(){
  const val=a=>toBase(a.balance,a.cur||baseCur());
  const groups=BS_GROUPS.map(g=>{ const list=S.accounts.filter(a=>acctGroup(a)===g[0]); return {id:g[0],label:g[1],kind:g[2],accounts:list,total:sum(list.map(val))}; });
  const assets=sum(groups.filter(g=>g.kind==='asset').map(g=>g.total)), liabilities=sum(groups.filter(g=>g.kind==='liability').map(g=>g.total));
  const gt=id=>(groups.find(g=>g.id===id)||{total:0}).total;
  const secured=a=>sum((a.secures||[]).map(id=>{ const l=acct(id); return l&&l.kind==='liability'?val(l):0; }));
  const eq=a=>({account:a,value:val(a),owed:secured(a),equity:val(a)-secured(a),loans:(a.secures||[]).map(acct).filter(Boolean)});
  const re=S.accounts.filter(a=>acctGroup(a)==='realestate').map(eq), ve=S.accounts.filter(a=>acctGroup(a)==='vehicles').map(eq);
  return {groups:groups,assets:assets,liabilities:liabilities,netWorth:assets-liabilities,
    liquid:gt('cash')-gt('cards')-gt('loc'),investments:gt('investments'),
    realEstate:re,realEstateEquity:sum(re.map(x=>x.equity)),vehicles:ve,vehicleEquity:sum(ve.map(x=>x.equity)),totalDebt:liabilities};
}
function toast(msg,undoable){
  const el=$('#toast');
  el.innerHTML=esc(msg)+(undoable?' <button class="toast-undo" data-act="undo">Undo</button>':'');
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t=setTimeout(()=>el.classList.remove('show'),undoable?6500:2200);
}
/* one snapshot, deep enough to reverse any single destructive action */
let undoSnap=null;
function markUndo(){ try{ undoSnap=JSON.stringify(S); }catch(e){ undoSnap=null; } }

/* balances follow transactions: sign +1 applies, -1 reverses */
/* ============================ balances ============================
   Transactions are the source of truth. Each account carries one anchor:
     anchor.date === ''  → an opening balance; every transaction counts
     anchor.date === 'YYYY-MM-DD' → a reconciled checkpoint (e.g. a statement's closing balance);
                            only transactions dated AFTER that day move the balance
   a.balance is a cache, rebuilt by recalcBalances() before every save and render — it is never
   incremented in place, so edits, deletes, undo, moves and imports cannot make it drift. */
function r2(n){ return Math.round((Number(n)||0)*100)/100; }
function effectOn(t,a){
  if(!t||!a) return 0;
  if(isTransfer(t)){
    const amt=Number(t.amount)||0, al=allocOf(t); let e=0;
    /* With an allocation, the two ends move by different amounts: the CASH end by the whole payment, the
       LOAN end by its principal only. Whichever end is the debt is the loan end, so a reversal — money
       coming back out of the loan — is the exact mirror image and restores both sides. */
    const loanId=al?((acct(t.toId)||{}).kind==='liability'?t.toId:((acct(t.fromId)||{}).kind==='liability'?t.fromId:null)):null;
    /* leaving an asset lowers it; leaving a liability means borrowing more */
    if(t.fromId===a.id){ const v=(loanId===a.id)?allocPrincipal(t):amt; e+=(a.kind==='liability'? v : -v); }
    /* arriving at an asset raises it; arriving at a liability pays it down */
    if(t.toId===a.id){ const v=(loanId===a.id)?allocPrincipal(t):amt; e+=(a.kind==='liability'? -v : v); }
    /* an escrow contribution is still yours: it lands in the escrow account when one is named */
    if(al&&al.escrowId===a.id&&a.id!==t.fromId&&a.id!==t.toId) e+=(a.kind==='liability'?-1:1)*allocEscrow(t)*(loanId===t.toId?1:-1);
    return e;
  }
  if(t.accountId!==a.id) return 0;
  const d=flow(t);
  return a.kind==='liability'? -d : d;
}
/* a.opening = the opening balance; a.checkpoints = every reconciled bank figure (date-sorted).
   The governing anchor is the checkpoint with the LATEST date, else the opening balance.
   a.anchor is kept as a cache of that governing anchor (older backups carry only a.anchor). */
function anchorOf(a){
  if(!a.opening||typeof a.opening!=='object'){
    const legacy=(a.anchor&&typeof a.anchor==='object')?a.anchor:{date:'',balance:r2(a.balance)};
    if(legacy.date){
      /* an old single checkpoint: keep it, and back out an opening that reproduces it if it were removed */
      let upto=0; (S.transactions||[]).forEach(t=>{ if((t.date||'')<=legacy.date) upto+=effectOn(t,a); });
      a.opening={balance:r2((Number(legacy.balance)||0)-upto)};
      a.checkpoints=[{date:legacy.date,balance:r2(legacy.balance),at:legacy.at||Date.now()}];
    }else{ a.opening={balance:r2(legacy.balance)}; a.checkpoints=a.checkpoints||[]; }
  }
  if(!Array.isArray(a.checkpoints)) a.checkpoints=[];
  /* normalise IN PLACE — callers may hold a reference to a checkpoint while balances are recomputed */
  a.checkpoints=a.checkpoints.filter(c=>c&&/^\d{4}-\d{2}-\d{2}$/.test(String(c.date||'')));
  a.checkpoints.forEach(c=>{ c.date=String(c.date); c.balance=r2(c.balance); c.at=c.at||0; });
  a.checkpoints.sort((x,y)=>x.date.localeCompare(y.date)||(x.at-y.at));
  a.opening.balance=r2(a.opening.balance);
  const past=a.checkpoints.filter(c=>c.date<=todayISO());
  const gov=past.length?past[past.length-1]:null;
  a.anchor=gov?{date:gov.date,balance:gov.balance,at:gov.at}:{date:'',balance:a.opening.balance};
  return a.anchor;
}
/* ---- "now" is a date, not "every row in the table" ----
   A balance is only ever a balance AS OF a date. The current balance is simply the balance as of today:
   a payment you have dated next week, or a valuation dated at month end, is real and stays in the ledger,
   but it does not move today's figure until its date arrives. Planning ahead is what the month-ahead
   calendar, planned bills and recurring items are for. Historical, current and future therefore all come
   out of ONE implementation — balanceAsOf — rather than three that can drift apart. */
/* string-safe day arithmetic: never lets a time zone move a date */
function dayBefore(isoDate){ const [y,m,d]=String(isoDate).split('-').map(Number); const t=new Date(Date.UTC(y,m-1,d)-864e5); return t.getUTCFullYear()+'-'+pad2(t.getUTCMonth()+1)+'-'+pad2(t.getUTCDate()); }
/* with no checkpoint in play, the opening balance is authoritative for the day before `since`: a statement's
   opening balance already contains everything dated before its period, so those rows are never added again */
function openingFloor(a){ return a.since&&/^\d{4}-\d{2}-\d{2}$/.test(a.since)?dayBefore(a.since):''; }
function governingCheckpoint(a,asOf){ anchorOf(a); const D=asOf||todayISO(); const past=a.checkpoints.filter(c=>c.date<=D); return past.length?past[past.length-1]:null; }
function futureCheckpoints(a,asOf){ anchorOf(a); const D=asOf||todayISO(); return a.checkpoints.filter(c=>c.date>D); }
function countsFor(t,a,asOf){ const D=asOf||todayISO(); const gov=governingCheckpoint(a,D); const d=t.date||''; const floor=gov?gov.date:openingFloor(a); return (!floor||d>floor)&&d<=D; }
function sinceAnchor(a){ return S.transactions.filter(t=>countsFor(t,a)&&effectOn(t,a)!==0); }
function isFuture(t){ return (t&&t.date||'')>todayISO(); }
/* the current balance IS the balance as of today — same code path as every historical figure */
function derivedBalance(a){ return balanceAsOf(a,todayISO()); }
function recalcBalances(){ (S.accounts||[]).forEach(a=>{ a.balance=derivedBalance(a); }); }
/* accounts from an older copy carry only a stored balance: turn it into an opening balance that reproduces it */
function ensureAnchors(){
  (S.accounts||[]).forEach(a=>{
    if(!a.opening&&(!a.anchor||typeof a.anchor!=='object')){
      let all=0; (S.transactions||[]).forEach(t=>{ all+=effectOn(t,a); });
      a.opening={balance:r2((Number(a.balance)||0)-all)}; a.checkpoints=[];
    }
    anchorOf(a);
  });
  recalcBalances();
}
/* a statement or bank balance is authoritative for its date */
function setCheckpoint(a,date,balance){
  anchorOf(a); dlog('checkpoint created',{account:a.name,date:date,balance:r2(balance)});
  if(!date){ a.opening.balance=r2(balance); }
  else{ a.checkpoints=a.checkpoints.filter(c=>c.date!==date); a.checkpoints.push({date:date,balance:r2(balance),at:Date.now()}); }
  anchorOf(a); recalcBalances();
}
/* drop one checkpoint (normally the newest); the next one back — or the opening balance — takes over */
function removeCheckpoint(a,date){ anchorOf(a); a.checkpoints=a.checkpoints.filter(c=>c.date!==date); anchorOf(a); recalcBalances(); }
/* "the balance is X right now" — keep the anchor date, shift the anchor so history lands on X */
function setBalanceTo(a,target){ const gov=governingCheckpoint(a); const diff=r2(target)-derivedBalance(a); if(Math.abs(diff)<0.005) return; if(gov){ gov.balance=r2(gov.balance+diff); gov.source='manual'; gov.at=Date.now(); } else { a.opening.balance=r2(a.opening.balance+diff); a.opening.source='manual'; a.opening.at=Date.now(); } dlog('balance set by hand',{account:a.name,target:r2(target),shift:diff,on:gov?gov.date:'opening'}); anchorOf(a); recalcBalances(); }
/* legacy call sites: nothing to apply any more, just rebuild the cache */
function applyToAccount(){ recalcBalances(); }
/* rows the user says are already in the balance: fold their effect into each account's anchor so the balance stays put */
function absorbIntoAnchors(txs){
  S.accounts.forEach(a=>{ anchorOf(a); let e=0; txs.forEach(t=>{ if(countsFor(t,a)) e+=effectOn(t,a); }); if(e){ const gov=governingCheckpoint(a); if(gov) gov.balance=r2(gov.balance-e); else a.opening.balance=r2(a.opening.balance-e); anchorOf(a); } });
  recalcBalances();
}
/* balance of an account as the ledger stood at the end of day D: latest checkpoint dated <= D, plus rows after it up to D */
function balanceAsOf(a,D,opts){
  anchorOf(a);
  /* independent: when checking a statement dated D, ignore any checkpoint already sitting on D (else the comparison is circular) */
  const cps=a.checkpoints.filter(c=>opts&&opts.independent?c.date<D:c.date<=D);
  const base=cps.length?cps[cps.length-1]:{date:openingFloor(a),balance:a.opening.balance};
  let b=base.balance;
  S.transactions.forEach(t=>{ const d=t.date||''; if((!base.date||d>base.date)&&d<=D) b+=effectOn(t,a); });
  return r2(b);
}
/* fingerprint of everything that could move an account's balance up to a date — lets a close notice later edits */
function historyFP(a,D){ let n=0,net=0; S.transactions.forEach(t=>{ const e=effectOn(t,a); if(e!==0&&(t.date||'')<=D){ n++; net+=e; } }); return {count:n,net:r2(net)}; }
function monthEnd(key){ const [y,m]=key.split('-').map(Number); return key+'-'+pad2(new Date(y,m,0).getDate()); }
function closeFor(key){ return S.closes.find(c=>c.month===key)||null; }
function ensureClose(key){
  let c=closeFor(key);
  if(!c){ c={id:uid(),month:key,status:'open',closeDate:monthEnd(key),closedAt:0,accounts:[],notes:''}; S.closes.push(c); }
  S.accounts.forEach(a=>{ if(!c.accounts.some(x=>x.accountId===a.id)) c.accounts.push({accountId:a.id,status:'pending',statement:null,statementDate:c.closeDate,ledger:null,diff:null,checkpointDate:'',fp:null,note:''}); });
  c.accounts=c.accounts.filter(x=>acct(x.accountId));
  return c;
}
/* a closed month needs review if history up to a reconciled statement date changed, or its checkpoint vanished */
function closeReview(c){
  const issues=[];
  c.accounts.forEach(x=>{
    const a=acct(x.accountId); if(!a){ issues.push({accountId:x.accountId,why:'account no longer exists'}); return; }
    if(x.status!=='reconciled') return;
    anchorOf(a);
    if(x.checkpointDate&&!a.checkpoints.some(cp=>cp.date===x.checkpointDate&&Math.abs(cp.balance-x.statement)<0.005)) issues.push({accountId:a.id,why:'the '+fmtDate(x.checkpointDate)+' checkpoint was removed or changed'});
    if(x.fp){ const now=historyFP(a,x.statementDate); if(now.count!==x.fp.count||Math.abs(now.net-x.fp.net)>0.005) issues.push({accountId:a.id,why:'transactions up to '+fmtDate(x.statementDate)+' changed since the close ('+x.fp.count+' → '+now.count+', net '+money(x.fp.net)+' → '+money(now.net)+')'}); }
  });
  return issues;
}
const closeFlagged={};
function closeStatus(c){ if(c.status!=='closed') return 'open'; const bad=closeReview(c).length>0; if(bad&&!closeFlagged[c.id]){ closeFlagged[c.id]=true; dlog('monthly close invalidated',{month:c.month}); } if(!bad) closeFlagged[c.id]=false; return bad?'review':'closed'; }
function closeProgress(c){ const done=c.accounts.filter(x=>x.status==='reconciled'||x.status==='skipped').length; return {done:done,total:c.accounts.length,rec:c.accounts.filter(x=>x.status==='reconciled').length}; }
function monthlyCloseModal(key){
  key=key||ui.month; const c=ensureClose(key); const prog=closeProgress(c); const st=closeStatus(c); const issues=st==='review'?closeReview(c):[];
  const rows=c.accounts.map(x=>{
    const a=acct(x.accountId); anchorOf(a); const gov=governingCheckpoint(a);
    const sd=x.statementDate||c.closeDate; const ledger=x.status==='reconciled'?balanceAsOf(a,sd):balanceAsOf(a,sd,{independent:true});
    const diff=x.statement===null||x.statement===undefined?null:r2(x.statement-ledger);
    const lastRec=a.checkpoints.length?a.checkpoints[a.checkpoints.length-1].date:'';
    const status=x.status==='reconciled'?'<span style="color:var(--in)">Reconciled</span>':x.status==='skipped'?'<span class="muted">Skipped — no statement</span>':diff===null?'<span class="muted">Not started</span>':Math.abs(diff)<0.005?'<span style="color:var(--in)">Matches — accept to reconcile</span>':'<span style="color:var(--out)">Difference '+esc(signed(diff))+'</span>';
    return `<div class="tbl" style="margin-bottom:10px" data-close-acct="${a.id}">
      <div class="trow" style="flex-wrap:wrap;gap:6px 14px">
        <span style="flex:1 1 180px"><div><b>${esc(a.name)}</b> <span class="muted" style="font-size:12px">${a.kind==='liability'?'owed':'asset'}</span></div>
          <div class="muted num" style="font-size:12px">Ledger as of ${esc(fmtDate(sd))}: <b>${esc(money(ledger))}</b>${gov?' · governing checkpoint '+esc(fmtDate(gov.date))+' '+esc(money(gov.balance)):' · no checkpoint yet'}${lastRec?' · last reconciled '+esc(fmtDate(lastRec)):''}</div></span>
        <span style="font-size:13px;white-space:nowrap">${status}</span>
      </div>
      ${x.status==='reconciled'?`<div class="trow muted" style="font-size:12.5px"><span>Statement ${esc(money(x.statement))} on ${esc(fmtDate(x.statementDate))} → checkpoint set${x.note?' · '+esc(x.note):''}</span><span><button class="btn btn-sm btn-ghost" data-act="close-reopen" data-id="${c.id}" data-v="${a.id}">Undo</button></span></div>`
      :x.status==='skipped'?`<div class="trow muted" style="font-size:12.5px"><span>Skipped${x.note?' · '+esc(x.note):''}</span><span><button class="btn btn-sm btn-ghost" data-act="close-reopen" data-id="${c.id}" data-v="${a.id}">Undo</button></span></div>`
      :`<div class="trow" style="flex-wrap:wrap;gap:6px">
          <input type="number" step="0.01" inputmode="decimal" class="num" data-close-f="statement" value="${x.statement==null?'':x.statement}" placeholder="Statement balance" style="width:150px;padding:6px 8px" aria-label="Statement balance for ${esc(a.name)}">
          <input type="date" data-close-f="date" value="${esc(sd)}" style="width:auto;padding:6px 8px" aria-label="Statement date">
          <button class="btn btn-sm" data-act="close-compare" data-id="${c.id}" data-v="${a.id}">Compare</button>
          ${diff!==null?`<button class="btn btn-sm btn-primary" data-act="close-accept" data-id="${c.id}" data-v="${a.id}">Accept ${esc(money(x.statement))} as checkpoint</button>`:''}
          ${diff!==null&&Math.abs(diff)>=0.005?`<button class="btn btn-sm" data-act="close-inspect" data-id="${c.id}" data-v="${a.id}">Inspect transactions</button>`:''}
          <button class="btn btn-sm btn-ghost" data-act="close-skip" data-id="${c.id}" data-v="${a.id}">Skip</button>
        </div>`}
    </div>`; }).join('');
  openSheet('Monthly close · '+monthName(key,true),`
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <button class="iconbtn" data-act="close-month-nav" data-v="${shiftMonth(key,-1)}" aria-label="Previous month">‹</button>
      <b style="font-size:15px">${esc(monthName(key,true))}</b>
      <button class="iconbtn" data-act="close-month-nav" data-v="${shiftMonth(key,1)}" aria-label="Next month">›</button>
      <span class="spacer" style="margin-left:auto"></span>
      <span class="num" style="font-size:13.5px"><b>${prog.done} of ${prog.total}</b> accounts done · ${prog.rec} reconciled</span>
    </div>
    <div class="bar" style="margin-bottom:12px"><i style="width:${prog.total?(prog.done/prog.total*100).toFixed(0):0}%;background:var(--in)"></i></div>
    ${st==='closed'?`<div class="verdict ok"><b>Closed</b> on ${esc(new Date(c.closedAt).toLocaleDateString())}. Nothing is locked — editing history will flag this month for review rather than block you.</div>`:''}
    ${st==='review'?`<div class="verdict bad"><b>Needs review.</b> Closed on ${esc(new Date(c.closedAt).toLocaleDateString())}, but since then: <ul style="margin:6px 0 0 18px;padding:0">${issues.map(i=>`<li>${esc((acct(i.accountId)||{}).name||'?')} — ${i.why}</li>`).join('')}</ul>The saved close record is untouched; re-check the affected account(s) and close again to clear this.</div>`:''}
    <div class="muted" style="font-size:13px;line-height:1.6;margin-bottom:12px">Type each statement's closing balance and date (defaults to month-end), <b>Compare</b>, then <b>Accept</b> — that records a normal checkpoint. Nothing here edits or invents transactions.</div>
    ${rows||'<div class="muted">No accounts.</div>'}
    <label class="field" style="margin-top:6px"><span>Notes for this close</span><input type="text" id="closeNotes" value="${esc(c.notes||'')}" placeholder="Anything unresolved…"></label>`,
    `<button class="btn btn-ghost" data-act="close-history">History</button><span class="spacer"></span><button class="btn" data-act="close-modal">Done for now</button>
     <button class="btn btn-primary" data-act="close-finish" data-id="${c.id}" ${prog.done===prog.total&&prog.total?'':'disabled'}>${st==='open'?'Close '+esc(monthName(key,true)):'Close again'}</button>`);
  const sh=$('.sheet'); if(sh) sh.classList.add('wide');
}
function closeAcctInputs(acctId){ const box=document.querySelector('[data-close-acct="'+acctId+'"]'); if(!box) return {}; const v=box.querySelector('[data-close-f="statement"]'), d=box.querySelector('[data-close-f="date"]'); return {statement:v&&v.value!==''?parseFloat(v.value):null,date:(d&&d.value)||''}; }
function closeHistoryModal(){
  const list=S.closes.slice().sort((a,b)=>b.month.localeCompare(a.month));
  openSheet('Monthly close history',`
    ${list.length?`<div class="tbl">${list.map(c=>{ const st=closeStatus(c), p=closeProgress(c);
      return `<div class="trow click" data-act="close-month" data-v="${c.month}" role="button" tabindex="0" style="cursor:pointer"><span><div>${esc(monthName(c.month,true))}</div><div class="muted" style="font-size:12px">${p.rec} reconciled · ${p.done-p.rec} skipped · ${p.total-p.done} pending${c.closedAt?' · closed '+esc(new Date(c.closedAt).toLocaleDateString()):''}</div></span><span style="white-space:nowrap">${st==='closed'?'<b style="color:var(--in)">Closed</b>':st==='review'?'<b style="color:var(--out)">Needs review</b>':'<span class="muted">Open</span>'}</span></div>`; }).join('')}</div>`
      :'<div class="muted" style="font-size:13.5px">No monthly closes yet. Start one for the month you are viewing.</div>'}`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Close</button><button class="btn btn-primary" data-act="close-month" data-v="${ui.month}">Start ${esc(monthName(ui.month,true))}</button>`);
}
function balanceReport(){
  return S.accounts.map(a=>{ const an=anchorOf(a), since=sinceAnchor(a); const net=r2(sum(since.map(t=>effectOn(t,a))));
    return {a:a,anchor:an,count:since.length,net:net,balance:derivedBalance(a),cached:r2(a.balance)}; });
}

