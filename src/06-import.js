/* Ledger — part 6 of 7: privacy lock, reading a statement, live backup.
   The parts load in order as plain scripts and share one scope; tools/build.js joins them back into
   one closure for the shareable single file. Keep load-time code in the part that defines what it uses. */
"use strict";

/* ============================ privacy lock ============================
   A local passphrase that keeps prying eyes off your finances. The hash lives in its own
   localStorage key (never in backups, never in the ledger state). The app locks on open and
   after a period of inactivity. This is a casual privacy barrier, not encryption — anyone with
   devtools access can bypass it. For real protection, keep your device locked. */
const LOCK_KEY='ledger-lock';
let lockTimer=null, lastActivity=Date.now(), isLocked=false;
function loadLock(){ try{ return JSON.parse(window.localStorage.getItem(LOCK_KEY)||'null'); }catch(e){ return null; } }
function saveLock(obj){ try{ window.localStorage.setItem(LOCK_KEY,JSON.stringify(obj)); return true; }catch(e){ console.error('saveLock failed',e); return false; } }
function clearLock(){ try{ window.localStorage.removeItem(LOCK_KEY); }catch(e){} }
function hasLock(){ return !!loadLock(); }
/* SHA-256 hash via the Web Crypto API — never store the passphrase itself.
   Falls back to a simple JS hash on file:// where crypto.subtle is unavailable
   (it requires a secure context). The fallback is weaker but still stops casual
   inspection of the stored value. */
async function hashPass(pw){
  const salted='ledger-lock-salt:'+pw;
  if(window.crypto&&window.crypto.subtle){
    try{
      const buf=new TextEncoder().encode(salted);
      const digest=await crypto.subtle.digest('SHA-256',buf);
      return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
    }catch(e){ /* fall through to fallback */ }
  }
  /* FNV-1a hash — not cryptographic, but adequate for a local privacy screen */
  let h=2166136261;
  for(let i=0;i<salted.length;i++){ h^=salted.charCodeAt(i); h=Math.imul(h,16777619); }
  return 'fnv:'+((h>>>0).toString(16).padStart(8,'0'))+((Math.imul(h,2654435761)>>>0).toString(16).padStart(8,'0'));
}
async function setLockPassphrase(pw){
  if(!pw){ clearLock(); clearVault(); vaultPass=''; try{ await flushKeys(); }catch(e){}   /* no key left to seal them with: back to plain, still out of the book */
    await saveNow(); scheduleBackupWrite(); return ''; }
  if(!cryptoOK()) throw new Error('this browser has no Web Crypto, so the book cannot be encrypted here');
  if(String(pw).length<PASS_MIN) throw new Error('use at least '+PASS_MIN+' characters');
  const raw=crypto.getRandomValues(new Uint8Array(32)); const code=newRecoveryCode();
  const wraps=await makeWraps(raw,pw,code);
  const prevLock=loadLock(), prevRaw=vaultRaw, prevWraps=vaultWraps, prevPass=vaultPass;
  await setVault(raw,wraps); vaultPass=pw;
  const saved=await saveNow();   /* the book is re-written encrypted FIRST; only then does the lock record change */
  if(!saved){ if(prevRaw) await setVault(prevRaw,prevWraps); else clearVault(); vaultPass=prevPass; throw new Error('the encrypted book could not be saved — nothing was changed (another tab may have saved newer changes: reload first)'); }
  if(!saveLock(Object.assign({timeout:S.settings.lockTimeout||LOCK_DEFAULT},wraps))){ if(prevRaw) await setVault(prevRaw,prevWraps); else clearVault(); vaultPass=prevPass; await saveNow(); throw new Error('Could not save the lock record'); }
  clearDlog();   /* nothing readable may survive the switch to encrypted-at-rest */
  await resealBackups();
  return code;   /* shown once to the person, never stored */
}
/* opens the session's vault from the lock record: 'pass' | 'recovery' | '' (legacy screen-lock records answer 'pass' on a hash match) */
async function unlockWith(secret){
  const lock=loadLock(); if(!lock) return vaultKey?'':'pass';   /* an encrypted book with no lock record is never opened by an empty box */
  if(lock.wrapP&&lock.salt){
    const u=await unwrapWith(wrapsOf(lock),secret); if(!u.raw) return '';
    if(!vaultKey) await setVault(u.raw,wrapsOf(lock)); if(u.how==='pass') vaultPass=secret; return u.how;
  }
  if(lock.check&&lock.salt){   /* first-day record: passphrase-derived key; move it to a wrapped data key with a recovery code */
    try{ const key=await kekFrom(secret,lock.salt,false,310000); await decryptText(key,lock.check);
      if(!vaultKey){ const raw=crypto.getRandomValues(new Uint8Array(32)); const code=newRecoveryCode(); const wraps=await makeWraps(raw,secret,code); await setVault(raw,wraps); saveLock(Object.assign({timeout:lock.timeout||LOCK_DEFAULT},wraps)); await saveNow(); pendingRecovery=code; }
      vaultPass=secret; return 'pass'; }catch(e){ return ''; }
  }
  const h=await hashPass(secret);   /* legacy record: a screen lock only, the book is still plain */
  return h===lock.hash?'pass':'';
}
async function verifyLockPassphrase(pw){ return !!(await unlockWith(pw)); }
function lockEncrypts(){ const l=loadLock(); return !!(l&&l.salt&&(l.wrapP||l.check)); }
/* show the full-screen lock overlay */
let lockWiped=false;
/* locking WIPES the key and the book from memory: the overlay hides nothing, the data is simply not there.
   Unlocking derives the key again and re-reads the encrypted book from storage. */
async function lockDown(){
  if(!vaultKey&&!hasLock()) return;
  try{ if(!lockWiped) await saveNow(); }catch(e){}
  clearTimeout(backupTimer); clearTimeout(dlogTimer);   /* a queued write would now see an empty book */
  clearVault(); forgetKeys(); vaultPass=''; pendingRecovery=''; undoSnap=null; reviewSnap=''; revRows=[]; shots=[]; importTrace=null; S=freshState(); S.settings.onboarded=true; lockWiped=true;
  try{ const b=document.getElementById('board'); if(b) b.innerHTML=''; const t=document.getElementById('toast'); if(t){ t.innerHTML=''; t.classList.remove('show'); } closeModal(); }catch(e){}
}
function showLock(sub){
  if(isLocked) return;
  isLocked=true;
  closeModal();
  if(!pendingUnlock) lockDown();
  let el=document.getElementById('lockScreen');
  if(!el){
    el=document.createElement('div');
    el.id='lockScreen';
    el.className='lockscreen';
    document.body.appendChild(el);
  }
  el.innerHTML=`<div class="lockcard">
    <svg class="locklogo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>
    <div class="locktitle">Ledger is locked</div>
    <div class="locksub">${esc(sub||'Enter your passphrase to continue')}</div>
    <input type="password" id="lockInput" placeholder="Passphrase" autocomplete="off" spellcheck="false">
    <div id="lockErr" class="lockerr"></div>
    <button class="btn btn-primary" id="lockUnlock" data-act="lock-unlock">Unlock</button>
    <div class="muted" style="font-size:12px;margin-top:14px;line-height:1.5">${lockEncrypts()||pendingUnlock?'Forgot it? Type your <b>recovery code</b> (XXXXX-XXXXX-XXXXX-XXXXX) here instead, then choose a new passphrase. The book is encrypted: without one of the two, nobody can read it — not even Ledger.':''}</div>
  </div>`;
  el.style.display='flex';
  const inp=document.getElementById('lockInput');
  if(inp){ inp.focus(); inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('lockUnlock').click(); } }); }
}
function hideLock(){
  isLocked=false;
  const el=document.getElementById('lockScreen');
  if(el) el.style.display='none';
}
/* track activity and auto-lock after the configured timeout */
function pokeActivity(){ lastActivity=Date.now(); }
function startLockWatcher(){
  ['mousedown','keydown','touchstart','scroll','mousemove'].forEach(ev=>{
    document.addEventListener(ev,pokeActivity,{passive:true});
  });
  clearInterval(lockTimer);
  lockTimer=setInterval(()=>{
    const lock=loadLock();
    if(!lock||isLocked) return;
    const timeout=(lock.timeout||LOCK_DEFAULT)*1000;
    if(Date.now()-lastActivity>=timeout) showLock();
  },5000);
}

function screenshotImport(){
  shots=[]; revRows=[]; shotBusy=false; shotHint=null; shotAcctChosen=false; stagedAccount=null; reviewDirty=false; reviewSnap=JSON.stringify(S);
  openSheet('Import from screenshots & documents',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">
      Bank-app screenshots, photos of receipts, bills, invoices, PDF statements — drop them here (or paste with ⌘V / Ctrl+V). Ledger pulls out the dates, amounts and descriptions, spots which ones are bills still to pay, and lets you check the list before anything is added.
    </div>
    <button type="button" class="dropzone" data-act="shot-pick" id="dropzone"><b>Drop screenshots, photos or PDFs here</b>or click to choose files · pasting an image works too</button>
    <input type="file" id="shotFile" accept="image/*,application/pdf,.pdf" multiple hidden>
    <div class="shots" id="shotList"></div>
    <label class="field"><span>Or paste text — a ChatGPT / Claude answer, a table, a list, anything</span>
      <textarea id="shotText" rows="4" placeholder="e.g. paste what a chat wrote after you gave it your statement:&#10;Aug 12 — Loblaws — $82.10&#10;Aug 13 — Payroll deposit — +$2,150.00" style="font-family:var(--mono);font-size:12.5px;resize:vertical"></textarea></label>
    <div class="muted" style="font-size:12.5px;line-height:1.5;margin-bottom:10px" id="shotEngine">${aiKey()
      ?'Reads with <b>'+esc(aiModelLabel())+'</b> via '+aiVendor()+' — only the images and your category names are sent. Change this under Settings › AI.'
      :'No AI key set. PDF statements are read on this computer from their own text; screenshots use on-device text recognition — it works on clean lists but misses things. Add a key under <a href="#" data-act="open-ai-settings" style="color:var(--accent)">Settings › AI</a> for far better results.'}</div>
    <div id="shotHint"></div>
    <div id="shotStatus" style="font-size:13.5px;min-height:20px;margin-bottom:6px"></div>
    <div id="shotReview"></div>
     <div id="shotGate"></div>`,
    `<label class="field" style="display:flex;align-items:center;gap:8px;margin:0">
       <span style="margin:0;font-size:11px">Into</span>
       <select id="shotAcct" style="width:auto;padding:6px 8px"><option value="">— choose an account —</option>${S.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
     </label>
     ${S.users.length?`<label class="field" style="display:flex;align-items:center;gap:8px;margin:0" title="Whose income and spending these are — the account is still shared">
       <span style="margin:0;font-size:11px">Whose</span>
       <select id="shotUser" style="width:auto;padding:6px 8px">${userOptions().map(o=>`<option value="${esc(o.value)}"${o.value===filteredUserId()?' selected':''}>${esc(o.label)}</option>`).join('')}</select>
     </label>`:''}
     <label class="field" style="display:flex;align-items:center;gap:7px;margin:0">
       <input type="checkbox" id="shotBalances" checked style="width:auto;margin:0"><span style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink);font-weight:400">Update balance</span>
     </label>
     <span class="spacer"></span>
     <button class="btn" data-act="close-modal">Cancel</button>
     <button class="btn btn-primary" data-act="shot-read" id="shotReadBtn">Read them</button>
     <button class="btn btn-primary" data-act="shot-commit" id="shotCommitBtn" hidden>Add to ledger</button>`);
  const sh=$('.sheet'); if(sh) sh.classList.add('wide');
}
function addShotFiles(files){
  const list=Array.from(files||[]).filter(f=>/^image\//.test(f.type)||f.type==='application/pdf'||/\.pdf$/i.test(f.name||''));
  if(!list.length){ toast('Only images and PDFs can be read'); return; }
  if(!$('#shotList')) screenshotImport();
  let left=list.length;
  list.forEach(f=>{
    const fr=new FileReader();
    fr.onload=()=>{
      const url=String(fr.result);
      const pdf=f.type==='application/pdf'||/\.pdf$/i.test(f.name||'');
      shots.push({mime:pdf?'application/pdf':(f.type||'image/png'),b64:url.split(',')[1],url:url,name:f.name||'',pdf:pdf});
      if(--left===0) renderShots();
    };
    fr.readAsDataURL(f);
  });
}
function renderShots(){
  const box=$('#shotList'); if(!box) return;
  box.innerHTML=shots.map((s,i)=>`<div class="shot">${s.pdf?`<div class="doc"><b>PDF</b>${esc(s.name)}</div>`:`<img src="${s.url}" alt="">`}<button data-act="shot-remove" data-i="${i}" aria-label="Remove">×</button></div>`).join('');
  const st=$('#shotStatus'); if(st&&!shotBusy) st.textContent=shots.length?shots.length+' file'+(shots.length===1?'':'s')+' ready to read.':'';
}
function setShotStatus(html){ const st=$('#shotStatus'); if(st) st.innerHTML=html; }

/* ---- engine 1: Claude vision ---- */
const SHOT_SCHEMA={type:'object',additionalProperties:false,required:['account','transactions'],properties:{
  account:{type:'object',additionalProperties:false,required:['institution','kind','last4','balance','date','currency'],description:'which account this statement/screenshot belongs to; empty strings / null when not visible',properties:{
    institution:{type:'string',description:'bank or card issuer, e.g. TD, RBC, Amex'},
    kind:{type:'string',enum:['chequing','savings','credit card','line of credit','investment','other','']},
    last4:{type:'string',description:'last 4 digits of the account or card number, or empty'},
    balance:{type:['number','null'],description:'closing / current balance shown on the statement, or null'},
    date:{type:'string',description:'the date that balance is as of (statement / closing date), YYYY-MM-DD, or empty'},
    currency:{type:'string',description:'3-letter currency code if shown, else empty'}
  }},
  transactions:{type:'array',items:{
  type:'object',additionalProperties:false,required:['date','description','amount','direction','category','kind'],properties:{
    kind:{type:'string',enum:['paid','bill'],description:'paid = money already moved; bill = an invoice or bill that is still to be paid'},
    date:{type:'string',description:'ISO date YYYY-MM-DD'},
    description:{type:'string'},
    amount:{type:'number',description:'positive number'},
    direction:{type:'string',enum:['in','out']},
    category:{type:'string',description:'one of the category names given, or empty'}
  }}}}};
function shotPrompt(){
  const cats=S.categories.map(c=>c.name);
  return `These are screenshots, documents and/or pasted text about a personal bank, card or payment account (pasted text may be another assistant's summary, a table, or a plain list). Extract every individual transaction you can find.
Today is ${todayISO()}. If a year is not shown, choose the most recent one that makes the dates fall on or before today. Use YYYY-MM-DD.
amount is always positive; direction is "out" for money leaving the account (purchases, payments, withdrawals, fees) and "in" for money arriving (deposits, refunds, salary, transfers in).
Skip running balances, headers, and declined markers. Keep the merchant or description text as shown, lightly cleaned.
If a document is a bill, invoice or statement asking for payment (utility bill, rent notice, phone bill, credit-card statement with an amount due), return ONE item with kind "bill", the total amount due, the due date as date, direction "out", and the company name as description — do not list its line items. A receipt or a bank/card history is money already moved: kind "paid". Pending card transactions count as "paid".
Pick category from this list, or leave it empty if nothing fits: ${cats.join(', ')}.
Also report which account it is under "account": the institution (TD, RBC, Amex…), the kind (chequing, savings, credit card…), the last 4 digits of the account or card number, the closing/current balance if shown, and the date that balance is as of (statement or closing date) — empty or null when not visible.`;
}
async function extractWithClaude(){
  const text=shotPrompt();
  const content=shots.map(s=>s.pdf?{type:'document',source:{type:'base64',media_type:'application/pdf',data:s.b64}}:{type:'image',source:{type:'base64',media_type:s.mime,data:s.b64}});
  if(shotText()) content.push({type:'text',text:'Pasted text:\n'+shotText()});
  content.push({type:'text',text:text});
  const base={model:aiModel(),max_tokens:16000,messages:[{role:'user',content:content}]};
  const attempts=[
    {body:Object.assign({},base,{fallbacks:'default',output_config:{format:{type:'json_schema',schema:SHOT_SCHEMA}}}),beta:'server-side-fallback-2026-07-01'},
    {body:Object.assign({},base,{output_config:{format:{type:'json_schema',schema:SHOT_SCHEMA}}})},
    {body:base}
  ];
  let lastErr='';
  for(const a of attempts){
    const headers={'content-type':'application/json','x-api-key':aiKey(),'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'};
    if(a.beta) headers['anthropic-beta']=a.beta;
    let res,json;
    try{ res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:headers,body:JSON.stringify(a.body)}); }
    catch(e){ throw new Error('Could not reach Anthropic — check your connection.'); }
    try{ json=await res.json(); }catch(e){ json={}; }
    if(res.status===400){ lastErr=(json.error&&json.error.message)||'Bad request'; continue; }
    if(res.status===401) throw new Error('That API key was rejected. Check it under Settings › AI.');
    if(res.status===429) throw new Error('Rate limited by Anthropic — wait a moment and try again.');
    if(!res.ok) throw new Error((json.error&&json.error.message)||('Anthropic returned '+res.status));
    if(json.stop_reason==='refusal') throw new Error('Claude declined to read these images.');
    if(json.stop_reason==='max_tokens'){ lastErr='The response was truncated (max tokens reached) — some transactions may be missing. Try again, or split the statement into smaller images.'; continue; }
    const txt=(json.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    return parseShotJSON(txt);
  }
  throw new Error(lastErr||'Anthropic rejected the request');
}
/* ---- engine 1b: OpenRouter (OpenAI-style chat completions; any vision model) ---- */
async function extractWithOpenRouter(){
  const content=shots.map(s=>s.pdf
    ?{type:'file',file:{filename:s.name||'statement.pdf',file_data:s.url}}
    :{type:'image_url',image_url:{url:s.url}});
  if(shotText()) content.push({type:'text',text:'Pasted text:\n'+shotText()});
  content.push({type:'text',text:shotPrompt()+'\nReply with JSON only, shaped {"transactions":[{date,description,amount,direction,category,kind}]}.'});
  const base={model:aiModel(),messages:[{role:'user',content:content}],max_tokens:16000};
  const hasPdf=shots.some(s=>s.pdf);
  /* PDFs: let the model read the file itself first; if it can't (free/text-only models), fall back to
     OpenRouter's free pdf-text converter, which works for any text-based statement or bill */
  const engines=hasPdf?['native','pdf-text']:[null];
  const formats=[
    {response_format:{type:'json_schema',json_schema:{name:'transactions',strict:true,schema:SHOT_SCHEMA}}},
    {response_format:{type:'json_object'}},
    {}
  ];
  const attempts=[];
  engines.forEach(eng=>formats.forEach(f=>attempts.push(Object.assign({},base,f,eng?{plugins:[{id:'file-parser',pdf:{engine:eng}}]}:{}))));
  let lastErr='';
  for(const body of attempts){
    let res,json;
    try{ res=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+aiKey(),'HTTP-Referer':'https://ledger.local','X-Title':'Ledger'},body:JSON.stringify(body)}); }
    catch(e){ throw new Error('Could not reach OpenRouter — check your connection.'); }
    try{ json=await res.json(); }catch(e){ json={}; }
    const msg=json.error&&(json.error.message||json.error.msg)||'';
    if(res.status===400||res.status===404||res.status===422){ lastErr=msg||('OpenRouter returned '+res.status); continue; }
    if(res.status===401) throw new Error('That OpenRouter key was rejected. Check it under Settings › AI.');
    if(res.status===402) throw new Error('OpenRouter says your account has no credit for this model. Top up, or pick a free model under Settings › AI.');
    if(res.status===429) throw new Error('Rate limited by OpenRouter — wait a moment and try again'+(/free/.test(aiModel())?' (free models have tight limits)':'')+'.');
    if(!res.ok) throw new Error(msg||('OpenRouter returned '+res.status));
    if(json.error) throw new Error(msg||'OpenRouter returned an error');
    const choice=(json.choices||[])[0]; const m=choice&&choice.message;
    let txt=m?(typeof m.content==='string'?m.content:(m.content||[]).map(p=>p.text||'').join('')):'';
    if(!txt.trim()){ lastErr='The model returned nothing readable'; continue; }
    if(choice&&choice.finish_reason==='length'){ lastErr='The response was truncated (max tokens reached) — some transactions may be missing. Try again, or split the statement into smaller images.'; }
    try{ return parseShotJSON(txt); }catch(e){ lastErr='The model did not return valid JSON'; continue; }
  }
  throw new Error(lastErr||'OpenRouter rejected the request');
}
function parseShotJSON(txt){
  let t=txt.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
  const i=t.indexOf('{'), j=t.lastIndexOf('}');
  if(i>=0&&j>i) t=t.slice(i,j+1);
  const obj=JSON.parse(t);
  if(!Array.isArray(obj)&&obj.account&&typeof obj.account==='object') shotHint=normHint(obj.account);
  return Array.isArray(obj)?obj:(obj.transactions||[]);
}
/* ---- which account is this? ---- */
let shotHint=null;
function normHint(h){
  const kind=String(h.kind||'').toLowerCase().trim();
  const last4=String(h.last4||'').replace(/\D/g,'').slice(-4);
  const inst=String(h.institution||'').trim();
  const bal=(h.balance===null||h.balance===undefined||h.balance==='')?null:Number(h.balance);
  const date=/^\d{4}-\d{2}-\d{2}$/.test(String(h.date||''))?String(h.date):'';
  const currency=/^[A-Z]{3}$/.test(String(h.currency||'').toUpperCase())?String(h.currency).toUpperCase():'';
  if(!kind&&!last4&&!inst&&!h.detected) return null;
  const keep={};
  ['detected','confidence','why','principal','opening','marketValue','rate','payment','nextPayment','maturity','splitPrincipal','splitInterest','regType','period','currencyWhy','summary','deposits','withdrawals'].forEach(k=>{ if(h[k]!==undefined&&h[k]!==null&&h[k]!=='') keep[k]=h[k]; });
  return Object.assign({institution:inst,kind:kind,last4:last4,balance:isFinite(bal)?bal:null,date:date,currency:currency},keep);
}
/* ---- what kind of statement is this? ----
   Evidence, weighted, and never a single stray word: "MORTGAGE STATEMENT" plus a principal balance is
   proof; the word "loan" on its own is not. Anything below the high bar is offered for review, and
   anything genuinely ambiguous leaves the type blank so you choose. A transaction description alone is
   never evidence — only the statement's own headings and fields count. */
const TYPE_EVIDENCE=[
  ['mortgage',[[/\bmortgage\b/i,3,'“mortgage”'],[/principal\s+balance/i,2,'a principal balance'],[/amortization|amortisation/i,2,'an amortization'],[/\bmaturity\b|renewal\s+date/i,1,'a maturity date'],[/\bescrow\b|property\s+tax/i,1,'escrow or property tax']]],
  ['car loan',[[/\b(car|auto|vehicle)\s+loan\b/i,3,'“car loan”'],[/\b(toyota|honda|ford|gm|nissan|hyundai|kia|bmw|mercedes|vw|volkswagen|subaru|mazda)\s+(financial|finance|credit)\b/i,3,'a motor-finance lender'],[/\bvin\b/i,2,'a VIN'],[/lease\s+account/i,1,'a lease account']]],
  ['student loan',[[/\bstudent\s+loan\b/i,3,'“student loan”'],[/\b(nslsc|osap|sallie\s*mae|navient|nelnet|aide financi)\b/i,3,'a student-loan servicer'],[/national\s+student\s+loans/i,3,'the national student loans centre'],[/repayment\s+assistance/i,1,'repayment assistance']]],
  ['line of credit',[[/\bline\s+of\s+credit\b/i,3,'“line of credit”'],[/\bheloc\b/i,3,'“HELOC”'],[/\bloc\s+(account|statement)\b/i,2,'“LOC”'],[/credit\s+limit/i,1,'a credit limit']]],
  ['personal loan',[[/\bpersonal\s+loan\b/i,3,'“personal loan”'],[/\binstall?ment\s+loan\b/i,2,'“installment loan”'],[/consolidation\s+loan/i,2,'“consolidation loan”']]],
  ['credit card',[[/\bcredit\s+card\b/i,3,'“credit card”'],[/\b(visa|mastercard|amex|american\s+express)\b/i,2,'a card brand'],[/minimum\s+payment/i,1,'a minimum payment'],[/statement\s+balance/i,1,'a statement balance'],[/payment\s+due\s+date/i,1,'a payment due date']]],
  ['investment',[[/\b(tfsa|rrsp|fhsa|resp|rrif|lira)\b/i,3,'a registered account name'],[/\b(investment|brokerage|portfolio|non-?registered)\s+(account|statement)\b/i,3,'“investment account”'],[/\bpension\b/i,3,'“pension”'],[/market\s+value|book\s+value/i,2,'a market value'],[/\bunits?\s+held\b|\bholdings\b/i,2,'holdings']]],
  ['chequing',[[/\b(chequing|checking)\b/i,3,'“chequing”'],[/\b(direct\s+deposit|pre-?authorized)\b/i,1,'direct deposits']]],
  ['savings',[[/\bsavings?\s+(account|statement)\b/i,3,'“savings account”'],[/\bhigh[- ]interest\s+savings\b/i,3,'“high-interest savings”'],[/\bsavings\b/i,2,'“savings”']]]
];
const REG_TYPES=[[/\btfsa\b/i,'TFSA'],[/\brrsp\b/i,'RRSP'],[/\bfhsa\b/i,'FHSA'],[/\bresp\b/i,'RESP'],[/\bpension\b/i,'Pension'],[/\bnon-?registered\b/i,'Non-registered'],[/\bcrypto\b/i,'Crypto']];
/* Only the statement's own headings count as evidence. A line that carries both a date and an amount is a
   transaction, and one merchant called "Student Loan Servicing" must never turn a chequing statement into
   a student loan. */
function detectAcctType(text){
  const t=String(text||'');
  const scores=TYPE_EVIDENCE.map(([type,rules])=>{
    let score=0; const hits=[];
    rules.forEach(([rx,w,label])=>{ if(rx.test(t)){ score+=w; hits.push(label); } });
    return {type:type,score:score,hits:hits};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  /* a bare "loan account" with nothing else: the type matters far too much to guess */
  const bareLoan=/\bloan\b/i.test(t);
  if(!scores.length) return bareLoan
    ? {type:'',confidence:'low',why:'this looks like a loan statement, but nothing says which kind of loan',scores:[]}
    : {type:'',confidence:'none',why:'nothing in the text says what kind of account this is',scores:[]};
  const top=scores[0], next=scores[1];
  const clear=!next||top.score-next.score>=2;
  if(bareLoan&&top.score<3&&!clear) return {type:'',confidence:'low',why:'this looks like a loan statement, but nothing says which kind of loan',scores:scores};
  if(top.score>=3&&clear) return {type:top.type,confidence:'high',why:'the statement says '+top.hits.slice(0,2).join(' and '),scores:scores};
  if(top.score>=2&&clear) return {type:top.type,confidence:'medium',why:'this looks like '+top.type+' ('+top.hits.slice(0,2).join(', ')+') — worth a check',scores:scores};
  return {type:'',confidence:'low',why:next?'it could be '+top.type+' or '+next.type:'the evidence is too thin to be sure',scores:scores};
}
/* pasted text / OCR: sniff the account from the words on the page */
const MONTHS_RX='jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
/* a month WORD: the abbreviation or the full name, nothing else glued on — "MART 24" is not March 24 */
const MONTH_WORD='(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/* banks whose statements print plain "$": the account is in their home currency unless the header says otherwise */
const INST_CURRENCY={'CIBC':'CAD','TD':'CAD','RBC':'CAD','Royal Bank':'CAD','Scotiabank':'CAD','Scotia':'CAD','BMO':'CAD','Tangerine':'CAD','Desjardins':'CAD','National Bank':'CAD','Simplii':'CAD','EQ Bank':'CAD','Wealthsimple':'CAD','Laurentian':'CAD','Meridian':'CAD','Vancity':'CAD','Coast Capital':'CAD','Servus':'CAD','ATB':'CAD','Neo Financial':'CAD','KOHO':'CAD','PC Financial':'CAD','Rogers Bank':'CAD',
  'Chase':'USD','Wells Fargo':'USD','Bank of America':'USD','Citi':'USD','Capital One':'USD'};
/* the statement period: strong evidence ("For Jul 1 to Jul 31, 2026", "Closing balance on Jul 31, 2026")
   outranks a generic "as of" date, which on a CIBC statement is only the date the names were checked */
const DATE_ANY='((?:\\d{4}-\\d{1,2}-\\d{1,2})|(?:\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4})|(?:(?:'+MONTHS_RX+')[a-z]*\\.?\\s*\\d{1,2}(?:\\/\\d{2,4})?(?:,?\\s+\\d{4})?)|(?:\\d{1,2}\\s+(?:'+MONTHS_RX+')[a-z]*\\.?(?:,?\\s+\\d{4})?))';
function statementPeriod(h){
  let m=h.match(new RegExp('(?:for|statement\\s+period|period|from)\\s*:?\\s*'+DATE_ANY+'\\s*(?:to|-|–|through)\\s*'+DATE_ANY,'i'))||h.match(new RegExp('^\\s*'+DATE_ANY+'\\s*(?:to|-|–|through)\\s*'+DATE_ANY+'\\s*$','im'));
  if(m){ let from=parseLooseDate(m[1]), to=parseLooseDate(m[2]); if(from&&to&&!/\d{4}/.test(m[1])) from=to.slice(0,4)+from.slice(4); return {from:from,to:to,how:'statement period'}; }
  m=h.match(new RegExp('(?:closing|ending|final)\\s+balance\\s+(?:on|as\\s+at|at)\\s*:?\\s*'+DATE_ANY,'i')); if(m) return {from:'',to:parseLooseDate(m[1]),how:'closing balance date'};
  m=h.match(new RegExp('period\\s+ending\\s*:?\\s*'+DATE_ANY,'i')); if(m) return {from:'',to:parseLooseDate(m[1]),how:'period ending'};
  m=h.match(new RegExp('(?:statement|closing)\\s+date\\s*:?\\s*'+DATE_ANY,'i')); if(m) return {from:'',to:parseLooseDate(m[1]),how:'statement date'};
  m=h.match(new RegExp('as\\s+(?:of|at)\\s*:?\\s*'+DATE_ANY,'i')); if(m) return {from:'',to:parseLooseDate(m[1]),how:'as-of date (weak)'};
  return {from:'',to:'',how:''};
}
function sniffHint(text){
  const seg=segmentStatement(text||'');
  const H=seg.header, t=H;      /* header + account summary only: body lines never speak for the account */
  const kind=(t.match(/\b(chequing|checking|savings?|credit card|visa|mastercard|amex|american express|line of credit|tfsa|rrsp)\b/i)||[])[1]||'';
  /* last 4: "ending in 4521", a masked number "4520 12** **** 4521", or "account number 123456789" — always the trailing four digits */
  let last4='';
  let m=t.match(/(?:ending(?:\s+in)?|ends\s+in|last\s+(?:four|4)(?:\s+digits)?)\s*:?\s*(\d{4})\b/i); if(m) last4=m[1];
  if(!last4){ m=t.match(/(?:account|card|acct)\s*(?:no\.?|number|num|#)?\s*:?\s*((?:[\d*x•·-]+\s?){2,})/i); if(m){ const digits=m[1].replace(/\D/g,''); if(digits.length>=4) last4=digits.slice(-4); } }
  if(!last4){ m=t.match(/(?:[*x•·]{2,}\s*[*x•·-]*\s*)(\d{4})\b/i); if(m) last4=m[1]; }
  let inst=(t.match(/\b(TD|RBC|Royal Bank|Scotiabank|Scotia|BMO|CIBC|Tangerine|Desjardins|National Bank|Simplii|EQ Bank|Wealthsimple|Amex|American Express|Capital One|Rogers Bank|PC Financial|Chase|Wells Fargo|Bank of America|Citi|HSBC|Laurentian|Meridian|Vancity|Coast Capital|Servus|ATB|Neo Financial|KOHO)\b/i)||[])[1]||'';
  if(!inst){ const m2=t.match(/\b((?:[A-Z][A-Za-z&'.-]+\s){0,3}(?:Bank|Credit Union|Caisse|Financial|Trust)(?:\s+of\s+[A-Z][A-Za-z]+)?)\b/); if(m2) inst=m2[1].replace(/\s+/g,' ').trim(); }
  let cur=(t.match(/\b(?:currency|devise)\s*:?\s*([A-Z]{3})\b/i)||t.match(/\b(CAD|USD|EUR|GBP|AUD|CHF|JPY|INR|MGA|ZAR|BRL|MXN)\b/)||[])[1]||'';
  let curWhy=cur?'stated in the header':'';
  if(!cur&&inst&&INST_CURRENCY[inst]&&/\$/.test(t)){ cur=INST_CURRENCY[inst]; curWhy='assumed — '+inst+' statement in dollars, no other currency stated'; }
  const bal=(t.match(/(?:closing|new|current|statement)\s+balance[^\d\n-]*(-?\$?\s*[\d,]+\.\d{2})/i)||[])[1];
  const k=/visa|mastercard|amex|american express|credit card/i.test(kind)?'credit card':/saving/i.test(kind)?'savings':/chequing|checking/i.test(kind)?'chequing':/line of credit/i.test(kind)?'line of credit':/tfsa|rrsp/i.test(kind)?'investment':'';
  let per=statementPeriod(t); if(!per.from){ const body=statementPeriod(text||''); if(body.from) per=body; }
  const date=per.to||'';
  let det=detectAcctType(H);
  /* a deposit-account statement that names no product: the account's own behaviour says which it is, but only
     as a suggestion to confirm — debit purchases and bill payments are how a chequing account is used */
  if(!det.type&&/\baccount\s+statement\b/i.test(H)&&/transit|branch/i.test(H)&&!/credit\s+card|visa|mastercard|loan|mortgage|line\s+of\s+credit/i.test(H)){
    const body=seg.table.join('\n');
    const spendy=(body.match(/retail\s+purchase|point\s+of\s+sale|\bpos\b|visa\s+debit|bill\s+pay|e-?transfer|service\s+charge|monthly\s+fee/ig)||[]).length;
    const savey=(body.match(/interest\s+(earned|paid|credit)/ig)||[]).length;
    if(spendy>=3&&spendy>savey) det={type:'chequing',confidence:'medium',why:'a bank account statement that names no product, used for debit purchases and bill payments — a chequing account, most likely; please confirm',scores:[]};
    else if(savey>=1&&spendy===0) det={type:'savings',confidence:'medium',why:'a bank account statement that names no product, earning interest with no purchases — a savings account, most likely; please confirm',scores:[]};
  }
  const num=rx=>{ const m=t.match(rx); return m?parseFloat(String(m[1]).replace(/[^0-9.-]/g,'')):null; };
  const dt=rx=>{ const m=t.match(rx); return m?parseLooseDate(m[1]):''; };
  const extra={
    detected:det.type,confidence:det.confidence,why:det.why,
    principal:num(/(?:principal\s+balance|outstanding\s+principal|loan\s+balance|balance\s+owing)[^\d\n-]*(-?\$?\s*[\d,]+\.?\d{0,2})/i),
    opening:num(/(?:opening|previous|prior)\s+balance[^\d\n-]*(-?\$?\s*[\d,]+\.\d{2})/i),
    marketValue:num(/(?:market\s+value|total\s+value|portfolio\s+value|account\s+value|closing\s+market\s+value)[^\d\n-]*(-?\$?\s*[\d,]+\.?\d{0,2})/i),
    rate:num(/(?:interest\s+rate|annual\s+rate|apr)[^\d\n]*([\d.]+)\s*%/i),
    payment:num(/(?:(?:regular|monthly|scheduled|minimum)\s+payment(?:\s+amount)?)[^\d\n-]*(-?\$?\s*[\d,]+\.?\d{0,2})/i),
    nextPayment:dt(/(?:next\s+payment|payment\s+due(?:\s+date)?)\s*:?\s*([^\n]{6,30})/i),
    maturity:dt(/(?:maturity(?:\s+date)?|renewal(?:\s+date)?)\s*:?\s*([^\n]{6,30})/i),
    splitPrincipal:num(/principal(?:\s+portion| paid| applied)?[^\d\n-]*\$\s*([\d,]+\.\d{2})/i),
    splitInterest:num(/interest(?:\s+portion| paid| charged)?[^\d\n-]*\$\s*([\d,]+\.\d{2})/i),
    regType:(REG_TYPES.find(([rx])=>rx.test(H))||[])[1]||'',
    period:per.from||per.to?{from:per.from,to:per.to,how:per.how}:null,
    currencyWhy:curWhy,
    summary:Object.keys(seg.summary).length?seg.summary:null
  };
  /* the account summary block is the statement's own word on its totals */
  if(seg.summary.opening!==undefined) extra.opening=seg.summary.opening;
  if(seg.summary.deposits!==undefined) extra.deposits=seg.summary.deposits;
  if(seg.summary.withdrawals!==undefined) extra.withdrawals=seg.summary.withdrawals;
  /* a card statement's totals: what came IN is payments + other credits; what went OUT (charges) is
     purchases + cash advances + interest + fees */
  { const sm=seg.summary, has=k=>sm[k]!==undefined, n=k=>has(k)?Number(sm[k]):0;
    if(has('payments')||has('purchases')){
      if(extra.deposits===undefined&&(has('payments')||has('othercredits'))) extra.deposits=r2(n('payments')+n('othercredits'));
      if(extra.withdrawals===undefined&&(has('purchases')||has('interest')||has('fees')||has('cashadvances'))) extra.withdrawals=r2(n('purchases')+n('cashadvances')+n('interest')+n('fees'));
      extra.cardTotals=true; } }
  let balance=bal?parseFloat(bal.replace(/[^0-9.-]/g,'')):null;
  if(balance===null&&seg.summary.closing!==undefined) balance=seg.summary.closing;
  /* "Principal balance", "Balance owing", "Market value" and a plain "Balance:" are all the statement's own
     figure for this account — worth reading even when the type is still uncertain, so nothing is lost when
     the user picks the type by hand. Opening/previous balances and credit limits are not it. */
  if(balance===null&&extra.principal!==null) balance=extra.principal;
  if(balance===null&&extra.marketValue!==null) balance=extra.marketValue;
  if(balance===null){
    const plain=(t.split(/\r?\n/).find(l=>/^\s*(?:current\s+)?balance\s*:?\s*-?\$?\s*[\d,]+\.?\d{0,2}\s*$/i.test(l)&&!/opening|previous|prior|available|limit/i.test(l))||'');
    if(plain){ const v=parseFloat(plain.replace(/[^0-9.-]/g,'')); if(isFinite(v)) balance=v; }
  }
  return normHint(Object.assign({institution:inst,kind:k||det.type,last4:last4,balance:balance,date:date,currency:cur.toUpperCase()},extra));
}
/* the date a statement balance is good for: what the statement says, else the newest paid row, else today */
function statementDate(rows){
  if(shotHint&&shotHint.date) return shotHint.date;
  const dates=(rows||revRows||[]).filter(r=>r.type!=='bill'&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map(r=>r.date).sort();
  return dates.length?dates[dates.length-1]:todayISO();
}
function hintLabel(h){ return [h.institution,h.kind,h.last4?'····'+h.last4:''].filter(Boolean).join(' ')||'this account'; }
function hintKind(h){ const t=hintType(h); if(t) return typeKind(t); return /credit|line of credit|loan|mortgage/.test(h.kind||'')?'liability':'asset'; }
/* match the hint to an existing account: last-4 first, then institution + kind words in the name */
function hintType(h){
  if(h&&h.detected&&acctTypeInfo(h.detected)&&h.confidence!=='low') return h.detected;
  const k=String(h&&h.kind||'').toLowerCase();
  if(acctTypeInfo(k)) return k;
  return /credit card|visa|mastercard|amex/.test(k)?'credit card':/line of credit/.test(k)?'line of credit':/mortgage/.test(k)?'mortgage':/car loan/.test(k)?'car loan':/student loan/.test(k)?'student loan':/personal loan/.test(k)?'personal loan':/\bloan\b/.test(k)?'':/saving/.test(k)?'savings':/chequing|checking/.test(k)?'chequing':/invest|tfsa|rrsp|fhsa|resp|pension/.test(k)?'investment':/cash/.test(k)?'cash':'';
}
/* reliable identity only: last-4 digits, disambiguated by institution and type when several accounts share them.
   Without an account number Ledger never auto-matches — you choose. */
function matchAccount(h){ const m=matchAccounts(h); return m.matched; }
/* identity, never vocabulary: the account number decides, disambiguated by institution, type and currency.
   Two mortgages are not the same mortgage because both say "mortgage" — without a number, you choose. */
function matchAccounts(h){
  if(!h||!h.last4) return {matched:null,candidates:[],reason:'no account number in the statement'};
  const A=S.accounts, inst=normText(h.institution), type=hintType(h), cur=(h.currency||'').toUpperCase();
  let cands=A.filter(a=>a.last4===h.last4||(a.name+' '+(a.label||'')).indexOf(h.last4)>=0);
  if(!cands.length) return {matched:null,candidates:[],reason:'no account here ends in '+h.last4};
  if(cands.length===1){
    const a=cands[0];
    const typeClash=type&&a.acctType&&a.acctType!==type&&typeKind(type)!==a.kind;
    const curClash=cur&&(a.cur||baseCur())!==cur;
    if(typeClash||curClash) return {matched:null,candidates:cands,reason:'the account ending '+h.last4+' here is '+(typeClash?acctTypeLabel(a)+', but this statement looks like '+type:(a.cur||baseCur())+', but this statement is in '+cur)};
    return {matched:a,candidates:cands,reason:'account number matches'};
  }
  const narrow=(list,fn)=>{ const n=list.filter(fn); return n.length?n:list; };
  let c=cands;
  if(inst) c=narrow(c,a=>normText(a.institution||'')===inst||normText(a.name).indexOf(inst)>=0);
  if(type) c=narrow(c,a=>(a.acctType||'')===type);
  if(cur) c=narrow(c,a=>(a.cur||baseCur())===cur);
  if(c.length===1) return {matched:c[0],candidates:cands,reason:'account number plus institution, type and currency'};
  return {matched:null,candidates:c,reason:'several accounts here could be this one'};
}
/* a best guess for the "use existing" dropdown when there is no account number — never applied on its own */
function suggestAccount(h){
  if(!h) return null;
  const A=S.accounts;
  const words=[h.institution,h.kind].filter(Boolean).map(w=>w.toLowerCase());
  if(!words.length) return null;
  const inst=(h.institution||'').toLowerCase();
  const scored=A.map(a=>{ const n=(a.name+' '+(a.label||'')).toLowerCase(); let sc=0; words.forEach(w=>{ if(n.indexOf(w)>=0) sc++; }); if(h.kind&&hintKind(h)!==a.kind) sc-=1;
    /* a statement that names its bank must not land in a different bank's account just because both say "chequing" */
    if(inst&&n.indexOf(inst)<0&&A.some(x=>(x.name+' '+(x.label||'')).toLowerCase().indexOf(inst)>=0)) sc=0;
    if(inst&&n.indexOf(inst)<0&&h.kind&&A.filter(x=>x.kind===a.kind).length>1) sc=0;
    if(inst&&n.indexOf(inst)<0&&!h.last4) sc=Math.min(sc,0);
    return {a:a,sc:sc}; }).filter(x=>x.sc>0).sort((a,b)=>b.sc-a.sc);
  if(scored.length===1||(scored.length>1&&scored[0].sc>scored[1].sc)) return scored[0].a;
  return null;
}
let shotAcctChosen=false;
function renderHint(){
  const box=$('#shotHint'); if(!box) return;
  const sel=$('#shotAcct');
  const h=shotHint;
  const m=matchAccount(h);
  if(m){
    if(sel){ sel.value=m.id; } shotAcctChosen=true;
    const clash=shotKindClash();
    box.innerHTML=(clash?`<div class="verdict" style="margin:6px 0 10px"><b>${esc(clash.text)}</b><div style="margin-top:8px"><button class="btn btn-sm btn-primary" data-act="shot-set-type">Make it ${esc(clash.label)} (${clash.kind==='liability'?'a debt':'an asset'})</button></div></div>`:'')+`<div class="verdict ok" style="margin:6px 0 10px">Looks like <b>${esc(hintLabel(h))}</b> → filing into <b>${esc(m.name)}</b>.${h.balance!==null?` Statement balance <span class="num">${esc(money(h.balance))}</span>${Math.abs((m.balance||0)-h.balance)>0.005?` (Ledger has <span class="num">${esc(money(m.balance||0))}</span>) <label style="display:inline-flex;align-items:center;gap:5px;margin-left:6px"><input type="checkbox" id="shotSetBal" checked style="width:auto;margin:0">set it as the checkpoint for ${esc(fmtDate(statementDate()))}</label>`:' — matches.'}`:''} Change the account below if that's wrong.</div>`;
    return;
  }
  const chosen=sel&&sel.value&&acct(sel.value);
  if(chosen&&chosen.staged&&shotAcctChosen){ box.innerHTML=`<div class="verdict ok" style="margin:6px 0 10px"><b>New account confirmed:</b> ${esc(chosen.name)} — ${esc(acctTypeLabel(chosen))}, ${chosen.kind==='liability'?'a debt':'an asset'}, ${esc(chosen.cur)}${chosen.checkpoints.length?`, ${esc(money(chosen.checkpoints[0].balance))} on ${esc(fmtDate(chosen.checkpoints[0].date))}`:''}. Nothing is created until you click <b>Add to ledger</b>; cancelling leaves the book as it is.</div>`; return; }
  if(chosen&&shotAcctChosen){ box.innerHTML=`<div class="verdict ok" style="margin:6px 0 10px">Filing into <b>${esc(chosen.name)}</b>.${h&&h.balance!==null?` Statement balance <span class="num">${esc(money(h.balance))}</span>${Math.abs((chosen.balance||0)-h.balance)>0.005?` (Ledger has <span class="num">${esc(money(chosen.balance||0))}</span>) <label style="display:inline-flex;align-items:center;gap:5px;margin-left:6px"><input type="checkbox" id="shotSetBal" checked style="width:auto;margin:0">set it as the checkpoint for ${esc(fmtDate(statementDate()))}</label>`:' — matches.'}`:''}</div>`; return; }
  if(!h&&S.accounts.length){ if(sel&&!sel.value){ sel.value=S.accounts[0].id; } shotAcctChosen=true; box.innerHTML=revRows.length?`<div class="muted" style="font-size:12.5px;margin:6px 0 10px">No account details in this text — filing into <b>${esc(acct(sel.value).name)}</b>; change it below if needed.</div>`:''; return; }
  /* nothing matched reliably: an explicit choice — create, pick existing, or cancel */
  const conf=(h&&h.confidence)||'none';
  /* only a confident reading pre-selects the type; anything less is left for the user to pick */
  const type=(conf==='high'||conf==='medium')?hintType(h):'';
  const mm=matchAccounts(h);
  const TYPES=ACCT_TYPES.map(t=>[t[0],t[1]]);
  /* a look-alike by bank and type is only offered when the statement has NO account number of its own: a
     statement ending 9999 is never pre-filed into the card ending 7436, nor into an account with no number at all */
  const sug=suggestAccount(h); if(sel&&sug&&!sel.value&&!(h.last4&&sug.last4!==h.last4)) sel.value=sug.id;
  const title=!h?'Which account is this?':(mm.candidates.length>1?'We found multiple possible accounts':(h.last4?'New account detected':'New account — no account number found'));
  const why=!h?'Ledger could not tell which account this statement belongs to.':!type?'We found a new account but could not determine its type — please choose it.':h.last4?'':'Without an account number Ledger will not guess an identity; pick an existing account or create one here.';
  box.innerHTML=`<div class="verdict" style="margin:6px 0 10px">
    <div style="font-weight:700;margin-bottom:4px">${esc(title)}</div>
    ${why?`<div class="muted" style="font-size:12.5px;margin-bottom:8px">${esc(why)}</div>`:''}
    ${h&&(h.detected||conf==='low')&&conf!=='none'?`<div class="muted" style="font-size:12.5px;margin-bottom:8px">${conf==='high'?'Reads as <b>'+esc(acctTypeInfo(h.detected)?acctTypeInfo(h.detected)[1]:h.detected)+'</b> — '+esc(h.why||'')+'. Check it before creating anything.':conf==='medium'?'<b style="color:var(--accent)">Looks like '+esc(acctTypeInfo(h.detected)?acctTypeInfo(h.detected)[1]:h.detected)+', but please confirm</b> — '+esc(h.why||''):'<b style="color:var(--accent)">Type unclear</b> — '+esc(h.why||'')+'. Choose it yourself — Ledger will not guess this one.'}</div>`:''}
    ${mm.candidates.length>1?`<div class="verdict" style="margin-bottom:8px"><b>${mm.candidates.length} accounts here could be this one</b> — ${esc(mm.candidates.map(a=>a.name).join(', '))}. Pick the right one below, or create a new account.</div>`:''}
    ${mm.reason&&mm.candidates.length===1&&!mm.matched?`<div class="verdict" style="margin-bottom:8px">${esc(mm.reason)} — nothing has been matched automatically.</div>`:''}
    <div class="grid2" style="margin-bottom:6px">
      <label class="field" style="margin:0"><span>Institution / name</span><input type="text" id="naInst" value="${esc(h&&h.institution||'')}" placeholder="Example Bank"></label>
      <label class="field" style="margin:0"><span>Type</span><select id="naType"><option value="">— choose —</option>${TYPES.map(t=>`<option value="${t[0]}"${type===t[0]?' selected':''}>${t[1]}</option>`).join('')}</select></label>
      <label class="field" style="margin:0"><span>Account ending</span><input type="text" id="naLast4" value="${esc(h&&h.last4||'')}" placeholder="last 4 digits (optional)" maxlength="4" inputmode="numeric"></label>
      <label class="field" style="margin:0"><span>Currency</span><select id="naCur">${['CAD','USD','EUR','GBP','AUD','CHF','JPY','INR','MGA','ZAR','BRL','MXN'].map(c=>`<option value="${c}"${(h&&h.currency||baseCur())===c?' selected':''}>${c}</option>`).join('')}</select></label>
      <label class="field" style="margin:0"><span>Statement balance${typeKind(type)==='liability'&&type?' (owed)':''}</span><input type="number" step="0.01" inputmode="decimal" id="naBal" value="${h&&h.balance!==null?Math.abs(h.balance):''}" placeholder="0.00"></label>
      <label class="field" style="margin:0"><span>As of</span><input type="date" id="naDate" value="${esc(h&&h.date||statementDate())}"></label>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-sm btn-primary" data-act="shot-make-acct">Create this account</button>
      ${S.accounts.length?`<button class="btn btn-sm" data-act="shot-use-acct">Use the account selected below</button>`:''}
      <button class="btn btn-sm btn-ghost" data-act="close-modal">Cancel import</button>
    </div></div>`;
}
/* transaction-looking lines the parser had to drop (an amount, but no usable row): a balance-only loan or investment
   statement has none of these; a mangled paste has many */
function unreadLines(){ return (parseSkipped||[]).filter(x=>/\d+\.\d{2}/.test(x.raw||'')&&!summaryKey(x.raw||'')&&!RX_NOT_SUMMARY.test(x.raw||'')&&!/statement header/.test(x.why||'')).length; }
function makeAccountFromHint(){
  if(!(revRows||[]).length&&unreadLines()>=3){ toast('No transactions were read from this statement although it has '+unreadLines()+' lines that look like some — fix the paste first; Ledger will not create an account from a statement it could not read'); return; }
  const type=($('#naType')||{}).value||''; if(!type){ toast('Choose the account type first'); const t=$('#naType'); if(t) t.focus(); return; }
  { const probe=Object.assign({},shotHint||{},{last4:(($('#naLast4')||{}).value||'').replace(/\D/g,'').slice(-4)||(shotHint||{}).last4,institution:(($('#naInst')||{}).value||'').trim()||(shotHint||{}).institution,kind:type,currency:($('#naCur')||{}).value||baseCur()});
    const dup=S.accounts.find(a=>a.last4&&probe.last4&&a.last4===probe.last4&&(a.cur||baseCur())===(probe.currency||baseCur()).toUpperCase()&&typeKind(a.acctType||'')===typeKind(type)&&(!a.institution||!probe.institution||normText(a.institution)===normText(probe.institution)));
    if(dup){ const sel=$('#shotAcct'); if(sel){ sel.value=dup.id; } shotAcctChosen=true; applyAccountSemantics(); renderReview(); renderHint(); refreshCommitGate(); toast('That account already exists — using '+dup.name); return; } }
  const inst=(($('#naInst')||{}).value||'').trim(), last4=(($('#naLast4')||{}).value||'').replace(/\D/g,'').slice(-4), cur=($('#naCur')||{}).value||baseCur();
  const balRaw=($('#naBal')||{}).value, bal=balRaw===''||balRaw==null?null:Math.abs(parseFloat(balRaw)||0), date=($('#naDate')||{}).value||statementDate();
  const TL={}; ACCT_TYPES.forEach(t=>{ TL[t[0]]=t[1].replace(/ \(.*\)$/,''); });
  const name=[inst,TL[type],last4?'····'+last4:''].filter(Boolean).join(' ');
  const h=shotHint||{};
  const a={id:uid(),name:name,kind:typeKind(type),acctType:type,institution:inst,label:'From statement',balance:0,
    rate:isFinite(h.rate)&&h.rate>0?h.rate:0,minPayment:isFinite(h.payment)&&h.payment>0?r2(h.payment):0,cur:cur,last4:last4,
    opening:{balance:0},checkpoints:bal!==null?[{date:date,balance:r2(bal),at:Date.now()}]:[]};
  if(typeKind(type)==='liability'){
    const loan={};
    if(isFinite(h.payment)&&h.payment>0) loan.payment=r2(h.payment);
    if(h.nextPayment) loan.nextDate=h.nextPayment;
    if(h.maturity) loan.maturity=h.maturity;
    if(Object.keys(loan).length) a.loan=loan;
  }
  if(type==='investment'){ a.valued='checkpoints'; if(h.regType) a.invest={regType:h.regType}; }
  if(type==='real estate'||type==='vehicle') a.valued='checkpoints';
  /* the account existed for the whole statement period, not just on its closing date — and the statement's
     opening balance is what it held at the start of that period, so history inside the month is right too */
  if(!a.since){ const from=h.period&&h.period.from; a.since=from||date||''; }
  if(isFinite(h.opening)&&h.opening!==null&&typeKind(type)!=='liability') a.opening={balance:r2(Number(h.opening)),source:'statement',at:Date.now()};
  else if(isFinite(h.opening)&&h.opening!==null) a.opening={balance:r2(Math.abs(Number(h.opening)))};
  anchorOf(a);
  if(cur!==baseCur()&&!hasRate(cur)){ S.rates=S.rates||{}; if(!S.rates[cur]) S.rates[cur]=0; }
  a.staged=true; stagedAccount=a; dlog('account staged from statement',{name:name,type:type,checkpoint:bal!==null,confidence:(shotHint||{}).confidence||'none'});
  if(a.kind==='liability'&&LOAN_TYPES.indexOf(type)>=0&&S.accounts.some(x=>x.acctType==='real estate'||x.acctType==='vehicle')) setTimeout(()=>offerLoanLink(a),80);
  if(shotHint){ shotHint.last4=last4||shotHint.last4; shotHint.institution=inst||shotHint.institution; shotHint.kind=type; }
  const sel=$('#shotAcct'); if(sel){ sel.innerHTML='<option value="">— choose an account —</option>'+S.accounts.concat([a]).map(x=>`<option value="${x.id}">${esc(x.name)}${x.staged?' (new)':''}</option>`).join(''); sel.value=a.id; }
  shotAcctChosen=true; applyAccountSemantics(); renderReview(); renderHint(); refreshCommitGate(); toast('New account confirmed: '+name+(bal!==null?', '+money(bal)+' on '+fmtDate(date):'')+' — it is created when you click Add to ledger');
}
/* a statement's signs mean different things on a card: a minus / CR is a payment or credit that reduces what is owed */
function applyAccountSemantics(){
  const a=acct(($('#shotAcct')||{}).value||''); if(!a||!revRows.length) return;
  const assets=S.accounts.filter(x=>x.id!==a.id&&x.kind!=='liability');
  const payer=assets.length===1?assets[0]:assets.find(x=>/chequing|checking/i.test(x.name+' '+(x.acctType||'')))||null;
  revRows.forEach(r=>{
    if(r.edited||r.type==='bill'||r.fromModel) return;
    const isPay=/payment\s*(received|-\s*thank you|thank you)|thank you|pymt received|paiement re[cç]u/i.test(r.note);
    const isCredit=/refund|credit|rembours|cashback|reward/i.test(r.note);
    if(a.kind==='liability'){
      r.flags=(r.flags||[]).filter(f=>!/direction|income source not recognised|payment to this card|already recorded/.test(f));
      const near3=t=>Math.abs((new Date(t.date+'T12:00:00')-new Date(r.date+'T12:00:00'))/864e5)<=3&&Math.abs(Number(t.amount)-r.amount)<0.005;
      const sameRef=t=>r.ref&&t.ref&&refKey(r.ref)===refKey(t.ref);
      if(r.byNumber&&/^xfer/.test(r.type)){
        /* the bank named the other account; the DIRECTION follows the debt-side reading of the sign:
           a credit (minus, CR, a payment, a refund) arrives at this debt, anything else leaves it */
        const other=r.type.replace(/^xferin:|^xfer:/,'');
        r.type=((r.sign==='neg'||r.cr||isPay||isCredit)?'xferin:':'xfer:')+other;
        return;
      }
      /* on a debt, a minus sign or a CR suffix is a credit: a payment or a refund */
      if(r.sign==='neg'||r.cr||isPay||isCredit){
        r.type='in'; const c=S.categories.find(x=>x.id==='c2'); if(c) r.categoryId=c.id;
        if(!isPay&&r.bankHint==='internal'){
          /* "FROM ACCOUNT …" on a debt: money arriving, already recorded as a transfer from the other side? */
          const twin=S.transactions.find(t=>t.type==='transfer'&&t.toId===a.id&&(sameRef(t)||near3(t)));
          if(twin){ r.twinId=twin.id; r.type='xferin:'+twin.fromId; r.flags.push('already recorded as a transfer from '+((acct(twin.fromId)||{}).name||'another account')+' on '+fmtDate(twin.date)+(sameRef(twin)?' (same reference number)':'')+' — unticked so it is not counted twice'); }
          else { r.payIn=true; r.flags.push('money in from another account — choose “Payment from …” if you track it here; otherwise it stays money in on this debt (not income)'); }
        }
        if(isPay){
          /* the payment may already be in the book from the paying account's side: same amount into this card within 3 days */
          const twin=S.transactions.find(t=>t.type==='transfer'&&t.toId===a.id&&Math.abs(Number(t.amount)-r.amount)<0.005&&Math.abs((new Date(t.date+'T12:00:00')-new Date(r.date+'T12:00:00'))/864e5)<=3);
          if(twin){ r.twinId=twin.id; r.type='xferin:'+twin.fromId; r.dup=r.dup||'possible'; r.on=false; r.flags.push('already recorded as a payment from '+((acct(twin.fromId)||{}).name||'another account')+' on '+fmtDate(twin.date)+' — unticked so it is not counted twice'); }
          else r.flags.push('payment to this card — choose “Payment from …” if you track the account it came from; otherwise it stays money in on this card (not income)');
          r.payIn=true;
        }
      }
      else { r.type='out'; if(cat(r.categoryId).type!=='out'||r.categoryId===uncatId()){ const g=guessCategory(r.note,'out'); const gc=g?S.categories.find(x=>x.name===g):null; r.categoryId=gc?gc.id:uncatId(); }
        if(r.bankHint==='internal'){
          /* "TO ACCOUNT …" on a debt is an advance: money leaving the debt for another account of yours */
          const twin=S.transactions.find(t=>t.type==='transfer'&&t.fromId===a.id&&(sameRef(t)||near3(t)));
          if(twin){ r.twinId=twin.id; r.type='xfer:'+twin.toId; r.flags.push('already recorded as a transfer to '+((acct(twin.toId)||{}).name||'another account')+' on '+fmtDate(twin.date)+(sameRef(twin)?' (same reference number)':'')+' — unticked so it is not counted twice'); }
          else { const tg=transferTargets(r); if(tg.length===1) r.type='xfer:'+tg[0].id; else r.flags.push('money out to another account of yours — choose “Move to …” if you track it here; until then it counts as spending'); }
        } }
    }else{
      if(/^xfer:/.test(r.type)||(r.byNumber&&/^xferin:/.test(r.type))) return;   /* an account-number match stands */
      if(r.sign==='neg') r.type='out'; else if(r.sign==='pos') r.type='in';
      if(/^xferin:/.test(r.type)) r.type='in';
      if(cat(r.categoryId).type!==(r.type==='in'?'in':'out')){ const g=guessCategory(r.note,r.type==='in'?'in':'out'); const gc=g?S.categories.find(x=>x.name===g):null; r.categoryId=gc?gc.id:(r.type==='in'?(S.categories.find(x=>x.id==='c2')||S.categories.find(x=>x.type==='in')||{}).id:uncatId()); }
    }
  });
  /* an investment statement: market movement changes the ACCOUNT VALUE, never your income. Growth lines
     are dropped from the review — the valuation checkpoint already carries them — while contributions and
     withdrawals stay as the transfers they are. */
  if(a.acctType==='investment'){
    revRows.forEach(r=>{
      if(r.edited) return;
      if(/\b(market (gain|loss|change|value)|change in value|unrealized|unrealised|growth|performance|investment (income|return)|rate of return)/i.test(r.note)){
        r.skip=true; r.flags=(r.flags||[]).concat(['market movement — carried by the account value, not counted as income or spending']);
      }else if(/\b(contribution|deposit|transfer in)\b/i.test(r.note)&&r.type==='in'){
        r.flags=(r.flags||[]).concat(['a contribution is money moved from another account of yours — choose “Payment from …” if you track that account here']);
      }
    });
  }
  /* a transfer this statement names that the book already holds from the other side: unticked, never twice */
  revRows.forEach(r=>{ if(r.edited||r.twinId||!/^xfer/.test(r.type)) return; const tw=twinTransfer(r,a.id); if(tw){ r.twinId=tw.id; r.flags=(r.flags||[]).filter(f=>!/already recorded/.test(f)); r.flags.push('already recorded as a transfer between these accounts on '+fmtDate(tw.date)+' — unticked so it is not counted twice'); } });
  /* the duplicate check depends on the final direction and the account, so redo it now */
  classifyDups(revRows);
  revRows.forEach(r=>{ if(r.skip&&!r.edited) r.on=false; if(r.twinId&&!r.edited){ if(r.dup!=='definite') r.dup='possible'; r.on=false; } });
}

/* ---- engine 2: on-device OCR (Tesseract.js), for when there is no key ---- */
function loadScript(src){
  return new Promise((ok,bad)=>{ const s=document.createElement('script'); s.src=src; s.onload=ok; s.onerror=()=>bad(new Error('Could not load '+src)); document.head.appendChild(s); });
}
const KEYWORD_CATS=[
  [/\b(mortgage|rent\b|landlord|property mgmt|property management|condo fee|strata)/i,'Rent / mortgage'],
  [/\b(insurance|assurance|insurer|ins\.?\s*co\b|general\s+ins\b|life\s+ins\b|auto\s+ins\b|co-?operators|cooperators|intact|desjardins assur|allstate|aviva|sun life|manulife|canada life|belair|td insurance|geico|state farm|progressive|wawanesa|economical|gore mutual|johnson ins)\b/i,'Insurance'],
  [/\b(student loan|loan (payment|pmt|servicing)|car loan|auto loan|line of credit|loc payment|osap|nslsc|sallie|navient|nelnet|financing|lease payment)\b/i,'Loan payments'],
  [/\b(fee|fees|service charge|monthly (checking|chequing|plan)|account fee|overdraft|nsf|interest charge|purchases? interest|interest|finance charge|late (fee|charge)|atm fee|foreign exchange|fx fee)\b/i,'Bank fees & interest'],
  [/\b(atm|abm|cash withdrawal|cash advance|branch withdrawal)\b/i,'Cash withdrawals'],
  [/\b(payment - thank you|payment received|credit card payment|card payment|bill payment to|pay bill|transfer to|e-?transfer sent|interac e-transfer sent|paypal transfer)\b/i,'Transfers & payments out'],
  [/\b(grocer|market|supermarket|loblaw|metro|sobeys|walmart|costco|iga|no frills|superstore|whole foods|trader joe|food basics|freshco|safeway|save-on|farm boy|kroger|aldi|lidl|tesco|sainsbury|provigo|maxi|super c|t&t|h mart|longo)/i,'Groceries'],
  [/\b(steakhouse|steak house|bistro|pizzeria|brewpub|brewery|taproom|restaurant|resto|cafe|café|coffee|starbucks|tim hortons|second cup|pizza|sushi|burger|mcdonald|wendy|a&w|kfc|popeyes|subway|chipotle|doordash|skip|skipthedishes|ubereats|uber eats|bakery|bistro|grill|deli|diner|brasserie|bar\b|pub\b|tavern|brewery|wine bar|taco|ramen|pho\b|thai|shawarma|poutine|kitchen|eatery|bagel|donut|dunkin)/i,'Dining out'],
  [/\b(internet|bell\b|bell canada|bell mobility|rogers|telus|fido|koodo|virgin (mobile|plus)|freedom mobile|videotron|cogeco|shaw|eastlink|verizon|at&t|t-mobile|sprint|comcast|xfinity|spectrum|starlink|wireless|mobile|cellular|cell phone|phone|telecom|cable)\b/i,'Phone / Internet'],
  [/\b(hydro|electric|electricity|power corp|power co|power & light|puget power|puget sound energy|energy|utility|utilities|water bill|water\b|sewer|gas bill|natural gas|enbridge|union gas|fortis|epcor|enmax|bc hydro|toronto hydro|hydro ottawa|hydro-qu|alectra|heating oil|propane)\b/i,'Utilities'],
  [/\b(uber|lyft|taxi|cab\b|transit|presto|opus|ttc|stm|go transit|via rail|amtrak|greyhound|parking|park\b|impark|indigo park|gas station|gas bar|petro|shell|esso|chevron|mobil\b|sunoco|ultramar|irving|circle k|canadian tire gas|husky|toll|407|407 etr|car wash|oil change|jiffy|mechanic|auto service|tire)/i,'Transport'],
  [/\b(netflix|spotify|apple\.com|apple bill|itunes|icloud|google (one|storage|play)|youtube|amazon prime|prime video|disney|crave|hbo|max\b|paramount|hulu|audible|kindle|patreon|openai|chatgpt|anthropic|claude|dropbox|microsoft 365|office 365|adobe|canva|notion|github|zoom|linkedin premium|subscription|membership|xbox|playstation|nintendo|steam)/i,'Subscriptions'],
  [/\b(pharma|pharmacy|shoppers drug|rexall|jean coutu|london drugs|cvs|walgreens|clinic|dental|dentist|orthodont|doctor|physio|chiro|massage|optom|optical|glasses|lenscrafters|health|medical|hospital|lab test|blood|prescription|vet\b)/i,'Health'],
  [/\b(gym|fitness|goodlife|planet fitness|anytime fitness|yoga|pilates|crossfit|peloton)\b/i,'Health'],
  [/\b(tuition|university|college|school|course|udemy|coursera|textbook|tutor|daycare|child ?care|preschool)\b/i,'Education'],
  [/\b(cinema|cineplex|movie|theatre|theater|concert|ticketmaster|stubhub|museum|zoo|aquarium|bowling|arcade|golf|ski|escape room|event|festival|show)\b/i,'Entertainment'],
  [/\b(salon|barber|haircut|hair|spa\b|nails|manicure|beauty|sephora|cosmetic|skincare|laundry|dry clean)\b/i,'Personal care'],
  [/\b(petsmart|pet valu|petco|vet clinic|animal hospital|pet food|pet\b|dog\b|cat\b)/i,'Pets'],
  [/\b(cra\b|revenue agency|irs\b|tax|service ontario|service canada|dmv|licence|license|passport|city of|municipal|fine\b|ticket\b)/i,'Taxes & government'],
  [/\b(amazon|amzn|ebay|etsy|best buy|apple store|ikea|home depot|lowe|rona|canadian tire|dollarama|dollar tree|winners|marshalls|homesense|indigo|chapters|staples|shein|temu|aliexpress|zara|h&m|uniqlo|old navy|gap\b|lululemon|nike|adidas|sport chek|decathlon|the bay|hudson|simons|clothing|apparel|shoe|footlocker|target|wayfair|structube|leon|the brick|bed bath)/i,'Shopping'],
  [/\b(supplies|supply|seed|fertilizer|feed store|labor|labour|contractor|equipment|hardware|tools|packaging|materials|wholesale|inventory|office depot|quickbooks|shopify|square|stripe fee)\b/i,'Business & supplies'],
  [/\b(donation|donate|charity|church|temple|mosque|gofundme|red cross|unicef)\b/i,'Donations & dakshina'],
  [/\b(air canada|westjet|porter|flair|airline|flight|expedia|booking\.com|airbnb|vrbo|hotel|marriott|hilton|hostel|travel|vacation|cruise|rental car|hertz|avis|enterprise rent)\b/i,'Travel & vacation'],
  [/\b(gift|flowers|1-800|birthday|wedding|celebration)\b/i,'Gifts & celebrations'],
  /* income */
  [/\b(payroll|salary|wages|direct deposit|dir dep|pay\b|employer|paycheque|paycheck|adp\b|ceridian|workday)\b/i,'Salary'],
  [/\b(cra\b|gst|hst credit|child benefit|ccb|ei\b|employment insurance|cpp|oas|pension|government|benefit|tax refund|trillium|climate action)\b/i,'Government & benefits'],
  [/\b(sale of|sales|invoice|client|customer|stripe|shopify payout|square deposit|paypal payout|etsy payout|consulting|freelance|revenue)\b/i,'Business income'],
  [/\b(refund|reimburse|rebate|cashback|cash back|reward|interest|dividend|e-?transfer|etransfer|interac|received|credit memo)\b/i,'Other income']
];
let lastDateAmbiguous=false, dateOrderHint='';
/* look at every numeric date in a document: 1/15/18 proves month-first, 25/12/18 proves day-first */
function inferDateOrder(text){
  let md=0,dm=0; const rx=/\b(\d{1,2})([\/.-])(\d{1,2})[\/.-](\d{2,4})\b/g; let m;
  while((m=rx.exec(text||''))){ const a=+m[1],b=+m[3]; if(a>12&&b<=12) dm++; else if(b>12&&a<=12) md++; else if(m[2]==='.') dm++; }   /* 01.09.2026 is day.month.year almost everywhere it is written */
  return md&&!dm?'md':dm&&!md?'dmy':'';
}
function parseLooseDate(str){
  const now=new Date(), Y=now.getFullYear();
  let m; lastDateAmbiguous=false;
  if((m=str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1]+'-'+pad2(+m[2])+'-'+pad2(+m[3]);
  /* 08/02 with no year at all (slash or dash only — 24.92 is an amount): the statement's year when known, else this year;
     an impossible pair is not a date, so the month-word forms below still get their turn */
  if(!/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.test(str)&&(m=str.match(/(?:^|[^\d.\/-])(\d{1,2})[\/-](\d{1,2})(?![\d.\/-]|\s*%)/))){
    let a=+m[1],b=+m[2]; let mm,dd;
    if(a>12){ dd=a; mm=b; } else if(b>12){ mm=a; dd=b; }
    else { const dmy=dateOrderHint?dateOrderHint==='dmy':(S.settings.dateFormat==='dmy'); mm=dmy?b:a; dd=dmy?a:b; lastDateAmbiguous=(a!==b)&&!dateOrderHint; }
    if(mm>=1&&mm<=12&&dd>=1&&dd<=31){
      let y=dateYearHint?+dateYearHint:Y; let iso=y+'-'+pad2(mm)+'-'+pad2(dd);
      if(!dateYearHint&&iso>addPeriod(todayISO(),45,'d')) iso=(y-1)+'-'+pad2(mm)+'-'+pad2(dd);
      return iso;
    }
    lastDateAmbiguous=false;
  }
  if((m=str.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/))){
    let a=+m[1],b=+m[2],y=+m[3]; if(y<100) y+=2000;
    /* 08/12/2026: only one reading fits if a number is over 12; otherwise follow the date-format setting and flag it */
    let mm,dd;
    if(a>12){ dd=a; mm=b; } else if(b>12){ mm=a; dd=b; }
    else { const dmy=dateOrderHint?dateOrderHint==='dmy':(S.settings.dateFormat==='dmy'); mm=dmy?b:a; dd=dmy?a:b; lastDateAmbiguous=(a!==b)&&!dateOrderHint; }
    if(mm<1||mm>12||dd<1||dd>31) return '';
    return y+'-'+pad2(mm)+'-'+pad2(dd);
  }
  /* JUL10 and JUL10/26: month letters glued to the day, an optional two-digit year after a slash (CIBC line of credit) */
  if((m=str.match(new RegExp('\\b('+MONTHS_RX+')[a-z]*\\.?(\\d{1,2})(?:\\/(\\d{2,4}))?\\b','i')))){ const mm=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase())+1; let y=m[3]?+m[3]:Y; if(y<100) y+=2000; if(mm>=1&&+m[2]>=1&&+m[2]<=31) return y+'-'+pad2(mm)+'-'+pad2(+m[2]); }
  const mi=new RegExp('\\b('+MONTH_WORD+')\\.?\\s+(\\d{1,2})\\b(?:,?\\s+(\\d{4}))?','i');
  const di=new RegExp('\\b(\\d{1,2})\\s+('+MONTH_WORD+')\\b\\.?(?:,?\\s+(\\d{4}))?','i');
  /* whichever form appears FIRST on the line is the date; a later "Aug 5" inside a description is not */
  { const a=str.match(mi), b=str.match(di); m=(a&&b)?(a.index<=b.index?a:b):(a||b); }
  if(m){
    const monName=(m[1].match(/^\d/)?m[2]:m[1]).slice(0,3).toLowerCase(), day=+(m[1].match(/^\d/)?m[1]:m[2]);
    const mon=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(monName)+1;
    let y=m[3]?+m[3]:Y;
    let iso=y+'-'+pad2(mon)+'-'+pad2(day);
    /* no year printed: a date more than ~six weeks ahead must be last year's; a due date a few weeks out stays this year */
    if(!m[3]&&iso>addPeriod(todayISO(),45,'d')) iso=(y-1)+'-'+pad2(mon)+'-'+pad2(day);
    return iso;
  }
  return '';
}
/* ---- reading a bank line properly ----
   RAW  →  CHANNEL (how the money moved)  →  MERCHANT / DESTINATION (who got it)  →  category or transfer.
   The channel words are how the bank describes its own plumbing. Matching categories against them is how
   "INTERNET BILL PAY … MASTERCARD" ends up filed under Phone / Internet. */
const CHANNELS=[
  [/^\s*intl\s+visa\s+deb(?:it)?\s+retail\s+purchase\b/i,'International Visa Debit purchase'],
  [/^\s*visa\s+deb(?:it)?\s+retail\s+purchase\b/i,'Visa Debit purchase'],
  [/^\s*retail\s+purchase\b/i,'Retail purchase'],
  [/^\s*internet\s+bill\s+pay(?:ment)?\b/i,'Internet bill payment'],
  [/^\s*internet\s+transfer\b/i,'Internet transfer'],
  [/^\s*(?:pre-?authorized|preauth)\s+(?:debit|payment)\b/i,'Pre-authorized debit'],
  [/^\s*e-?transfer(?:\s+reclaim)?\b/i,'e-Transfer'],
  [/^\s*service\s+charge\b/i,'Service charge'],
  [/^\s*(?:point\s+of\s+sale|pos)\s+(?:purchase|debit)\b/i,'Point of sale'],
  [/^\s*(?:atm|abm)\s+(?:withdrawal|deposit)\b/i,'ATM'],
  [/^\s*bill\s+pay(?:ment)?\b/i,'Bill payment'],
  [/^\s*pay\b(?=\s)/i,'Payroll deposit'],
  /* other banks' wording for the same plumbing */
  [/^\s*payroll\s+dep(?:osit)?\b/i,'Payroll deposit'],
  [/^\s*direct\s+deposit\b/i,'Payroll deposit'],
  [/^\s*(?:contactless\s+)?interac\s+(?:retail\s+)?purchase\b/i,'Point of sale'],
  [/^\s*card\s+purchase\b/i,'Point of sale'],
  [/^\s*online\s+banking\s+(?:bill\s+)?payment\b/i,'Bill payment'],
  [/^\s*online\s+(?:banking\s+)?transfer\b/i,'Internet transfer'],
  [/^\s*(?:send\s+)?e-?tfr\b/i,'e-Transfer'],
  [/^\s*interac\s+e-?transfer\b/i,'e-Transfer'],
  [/^\s*zelle\s+(?:payment|transfer)\b/i,'e-Transfer'],
  [/^\s*(?:td\s+)?atm\s+w\/d\b/i,'ATM'],
  [/^\s*(?:acct|account)\s+fee\b|^\s*monthly\s+fee\b/i,'Service charge']
];
/* what a line looks like it IS, beyond its category: paying a card, paying a loan, moving money between
   your own accounts, or reversing an earlier transfer. Each of these would double-count your spending if
   it were filed as an ordinary expense, so each is flagged for a decision instead of guessed. */
const BANK_HINTS=[
  ['loan',/\bloan\s*(?:payment|pmt|repayment)\b|\bspl\s+loan\b|\bmortgage\s*(?:payment|pmt)\b|\bloc\s+payment\b/i,'looks like a loan payment'],
  ['card',/\bto\s+card\b|\bmastercard\b|\bvisa\s+(?:payment|pymt)\b|\bcredit\s+card\s*(?:payment|pymt)\b|\bamex\b|\bcard\s+payment\b/i,'looks like a payment to a credit card'],
  ['installment',/\baffirm\b|\bafterpay\b|\bklarna\b|\bpaybright\b|\bsezzle\b|\bflexiti\b|\bfairstone\b/i,'looks like an instalment / buy-now-pay-later payment'],
  ['internal',/\b(?:to|from)\s+account\b|\btransfer\s+(?:to|from)\s+(?:my\s+)?(?:own\s+)?account\b/i,'looks like a transfer between your own accounts'],
  ['reversal',/\breclaim(?:ed)?(?=\W|\d|$)|\breversal\b|\breversed\b|\breturned\s+item\b|\bnsf\s+return\b|\brefund\s+of\s+transfer\b/i,'looks like a reversal of an earlier transfer']
];
function bankHint(note){ const n=String(note||''); for(let i=0;i<BANK_HINTS.length;i++){ const [k,rx,why]=BANK_HINTS[i]; if(rx.test(n)) return {kind:k,why:why}; } return null; }
function channelOf(note){ const n=String(note||'').trim(); const hit=CHANNELS.find(([rx])=>rx.test(n)); return hit?hit[1]:''; }
/* what is left once the channel and its reference numbers are taken off the front */
function merchantPart(note){
  let n=String(note||'').trim();
  CHANNELS.forEach(([rx])=>{ n=n.replace(rx,' '); });
  n=n.replace(/\b(?:ref[-#: ]?)?[A-Z0-9]*\d{6,}[A-Z0-9-]*\b/gi,' ')   /* reference numbers */
     .replace(/\s{2,}/g,' ').replace(/^[\s,;:.\-]+/,'').trim();
  return n||String(note||'').trim();
}
/* when a bank line has no merchant name — just the channel and a reference number — the channel
   itself is the best clue to what kind of transaction it was. "INTERNET TRANSFER 0000012345" with
   nothing else is still a transfer, even if we don't know who got it. */
const CHANNEL_CATS={
  'Internet transfer':'Transfers & payments out',
  'Internet bill payment':'Transfers & payments out',
  'Bill payment':'Transfers & payments out',
  'e-Transfer':'Transfers & payments out',
  'Pre-authorized debit':'Transfers & payments out',
  'Service charge':'Bank fees & interest',
  'ATM':'Cash withdrawals',
  'Payroll deposit':'Salary'
};
function guessCategory(desc,dir){
  const want=dir==='in'?'in':'out';
  /* match on the merchant, not on the bank's plumbing */
  const m=merchantPart(desc);
  const orig=String(desc||'').trim();
  /* if merchantPart fell back to the original, there IS no merchant — only channel + reference numbers.
     Do NOT run keyword matching on the channel words themselves, or "INTERNET TRANSFER" matches the
     "internet" keyword and gets filed as Phone / Internet. Go straight to the channel fallback. */
  /* a line with no channel at all (every card-statement line: "NETFLIX.COM", "ROGERS WIRELESS") IS the merchant */
  const hasMerchant=!!m&&(m!==orig||!channelOf(orig));
  /* the bank's own payroll channel ("PAY <employer>") is evidence of salary; a bare deposit is not */
  if(want==='in'&&channelOf(desc)==='Payroll deposit'&&S.categories.some(x=>x.name==='Salary'&&x.type==='in')) return 'Salary';
  if(hasMerchant){
    for(const [rx,name] of KEYWORD_CATS){ const c=S.categories.find(x=>x.name===name); if(c&&c.type===want&&rx.test(m)) return name; }
  }
  /* no merchant keyword matched (or no merchant at all): if the line had a channel, the channel name
     itself picks a reasonable category */
  const ch=channelOf(desc);
  if(ch&&CHANNEL_CATS[ch]){ const c=S.categories.find(x=>x.name===CHANNEL_CATS[ch]&&x.type===want); if(c) return c.name; }
  /* no keyword matched: money in is NOT called Salary just because it arrived — it falls to Other income and
     the review list says the source was not recognised */
  if(want==='in'){ const c=S.categories.find(x=>x.id==='c2')||S.categories.find(x=>x.type==='in'); return c?c.name:''; }
  return '';
}
function incomeRecognised(desc){ if(channelOf(desc)==='Payroll deposit') return true; const m=merchantPart(desc); return KEYWORD_CATS.some(([rx,name])=>rx.test(m)&&(S.categories.find(x=>x.name===name)||{}).type==='in'); }
function shotText(){ return (($('#shotText')||{}).value||'').trim(); }
/* pasted chat text: strip markdown so the line parser sees plain rows */
function plainText(t){ return t.replace(/^\s*\|?\s*[-:| ]+\|?\s*$/gm,'').replace(/[|]/g,'  ').replace(/[*_`#>]+/g,'').replace(/[—–]/g,'-').replace(/\t/g,'  '); }
let parseSkipped=[], importTrace=null;
/* ============================ reading a statement ============================
   RAW LINES → DOCUMENT REGIONS → TRANSACTION ROWS → AMOUNT & DIRECTION → DESCRIPTION → HINTS → CATEGORY
   A bank statement is not a list of transactions; it is a document with a header, an account summary,
   a transaction table that restarts on every page, and pages of legal text. Reading it line by line and
   treating every number as money is how summary totals turn into income and a fee's own description
   turns into a second fee. So the regions are found first, and only the table is read for rows. */
const RX_NOISE=[
  /^\(?\s*continued(\s+on\s+next\s+page)?\s*\)?$/i, /continued\s+on\s+next\s+page/i,
  /^page\s+\d+(\s+of\s+\d+)?$/i, /^\d{3,}[A-Z]?\s+PER-\d{4}\/\d{2}$/i,
  /^(account|acct\.?)\s*(number|no\.?|#)\s*:?\s*[\d*x•·\-\s]*$/i, /^[\d*x•·\-]{4,}\s*(account|acct\.?)\s*(number|no\.?)\s*:?$/i,
  /branch\s+transit\s+number/i, /^\(?\s*continued\s*\)?\s*transaction\s+details$/i, /^transaction\s+details(\s*\(continued\))?$/i,
  /^[a-z0-9 ]*account\s+statement$/i, /^statement\s+of\s+account$/i,
  new RegExp('^('+MONTHS_RX+')[a-z]*\\.?\\s+\\d{1,2},?\\s+(to|-|–|through)\\s+('+MONTHS_RX+')[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}$','i')
];
const RX_COLHDR=/\bdate\b.*\b(description|details|particulars|transaction)\b.*\b(balance|amount|debits?|credits?|withdrawals?|deposits?)\b/i;
const RX_LEGAL=/^important\s*:|this statement will be considered correct|^\*?\s*foreign currency conversion fee|trademark of|registered trademark|is a registered trademark|^terms and conditions/i;
const RX_SUMMARY_START=/^account\s+summary$|^summary\s+of\s+(your\s+)?account|^statement\s+summary$|^account\s+activity\s+summary$/i;
const RX_SUMMARY_LABEL=/^(?:your\s+)?(opening|previous|beginning|prior)\s+balance\b|^(?:your\s+)?(closing|ending|new|final|total)\s+balance\b|^total\s+charges?\b|^(total\s+)?(withdrawals?|debits?|deposits?(?:\s*(?:&|and)\s*(?:credits?|additions?))?|credits?|cheques?\s*(?:&|and)\s*debits?|che(?:que|ck)s?\s+paid|atm\s*(?:&|and)\s*debit\s+card\s+withdrawals?|electronic\s+withdrawals?|amounts?\s+(?:deducted|added)|payments?\s+(?:and|&)\s+credits?|purchases?\s+(?:and|&)\s+debits?|payments?|other\s+credits?|purchases?|interest|fees?|cash\s+advances?)\b/i;
const RX_NOT_SUMMARY=/credit\s+limit|available\s+credit|minimum\s+payment|payment\s+due|due\s+date|interest\s+rate|annual\s+fee|interest\s+(charged|summary)\s+on/i;
const RX_BARE_AMOUNT=/^[-+=−]?\s*(?:\$|CA\$|US\$)?\s*[\d,]+\.\d{2}\s*(?:CR|DR)?$/i;
const RX_BALANCE_ROW=/\b(opening|closing|previous|new|beginning|ending|final)\s+balance\b|\bbalance\s+(forward|brought\s+forward|carried\s+forward)\b/i;
function summaryKey(l){ if(RX_NOT_SUMMARY.test(l)) return ''; const m=l.match(RX_SUMMARY_LABEL); if(!m) return ''; const t=m[0].toLowerCase();
  if(/opening|previous|beginning|prior/.test(t)) return 'opening'; if(/closing|ending|new|final|total\s+balance/.test(t)) return 'closing'; if(/total\s+charge/.test(t)) return 'withdrawals';
  if(/other\s+credit/.test(t)) return 'othercredits'; if(/^(total\s+)?payments?$/.test(t.trim())) return 'payments';
  if(/purchase/.test(t)&&!/debit/.test(t)) return 'purchases'; if(/^(total\s+)?interest/.test(t)) return 'interest'; if(/^(total\s+)?fees?/.test(t)) return 'fees'; if(/cash\s+advance/.test(t)) return 'cashadvances';
  return /deposit|credit|added|addition/.test(t)?'deposits':'withdrawals'; }
function amountOf(l){ const m=String(l).match(/(?:\$|CA\$|US\$)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})\b/); return m?parseFloat(m[1].replace(/,/g,'')+m[2]):null; }
function segmentStatement(text){
  const lines=String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  let pendLabelLine='';
  const out=[]; let phase='header'; const summary={}; let pendLabel='', pendAmt=null, pendAge=0, pendAmtIdx=-1; let slip=false;
  /* a statement may split its withdrawals into parts (checks paid, ATM & debit card, electronic …): those add up,
     and only stand in for the total when no total line exists. A plain or "total" label always wins. */
  const parts={};
  const addSummary=(key,amt,l)=>{
    const sub=(key==='withdrawals'||key==='deposits')&&!/^\s*total\b/i.test(l)&&/^\s*(?:che(?:que|ck)s?\s+paid|atm\b|electronic\s+withdrawals?|cheques?\s*(?:&|and)\s*debits?|other\s+withdrawals?)/i.test(l);
    if(sub){ (parts[key]=parts[key]||[]).push(amt); return; }
    if(summary[key]===undefined) summary[key]=amt;
  };
  /* a table row STARTS with its date; "Opening balance on Jul 1, 2026" merely mentions one */
  const dated=l=>new RegExp('^(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\/.-]\\d{1,2}(?:[\\/.-]\\d{2,4})?|(?:'+MONTHS_RX+')[a-z]*\\.?\\s*\\d{1,2}\\b|\\d{1,2}\\s+(?:'+MONTHS_RX+')[a-z]*\\.?)','i').test(l)&&!!parseLooseDate(l.slice(0,24));
  const hasAmt=l=>amountOf(l)!==null;
  lines.forEach(l=>{
    let region;
    /* the tear-off payment slip of a card statement: due dates and amounts due, never the start of the table */
    if(/^\s*tear\s+off\b|^\s*payment\s+options\b/i.test(l)) slip=true; if(/^\s*transactions\s+from\b|^\s*your\s+(payments?|new\s+charges)\b|^\s*trans\s+post\b/i.test(l)) slip=false;
    if(slip&&phase!=='table'){ out.push({t:l,region:'header'}); return; }
    if(RX_LEGAL.test(l)) phase='legal';
    if(RX_COLHDR.test(l)&&!hasAmt(l)){ region='colhdr'; phase='table'; }
    else if(phase==='legal') region='legal';
    else if(RX_NOISE.some(rx=>rx.test(l))){ region=phase==='header'||phase==='summary'?'header':'noise'; if(/transaction\s+details/i.test(l)) phase='table'; }
    else if(phase==='table') region='table';
    else{
      /* still in the front matter: does the table start here? */
      const tableStart=!summaryKey(l)&&dated(l)&&(hasAmt(l)||RX_BALANCE_ROW.test(l));
      if(tableStart){ phase='table'; region='table'; }
      else if(phase==='header'&&(RX_SUMMARY_START.test(l)||summaryKey(l))){ phase='summary'; region='summary'; }
      else region=phase;
    }
    if(region==='summary'||(region==='header'&&(summaryKey(l)||RX_BARE_AMOUNT.test(l)))){
      /* labels and their amounts may sit on one line, or on neighbouring lines in either order */
      const key=summaryKey(l), amt=amountOf(l);
      if(key&&amt!==null){ addSummary(key,amt,l); pendLabel=''; pendAmt=null; }
      else if(key){ if(pendAmt!==null){ addSummary(key,pendAmt,l); if(out[pendAmtIdx]) out[pendAmtIdx].paired=true; pendAmt=null; } else { pendLabel=key; pendLabelLine=l; pendAge=0; } }
      else if(RX_BARE_AMOUNT.test(l)&&amt!==null){ if(pendLabel){ addSummary(pendLabel,amt,pendLabelLine||''); pendLabel=''; out.push({t:l,region:region,paired:true}); return; } else { pendAmt=amt; pendAmtIdx=out.length; pendAge=0; } }
      else { if(++pendAge>2){ pendLabel=''; pendAmt=null; } }
    }
    out.push({t:l,region:region});
  });
  Object.keys(parts).forEach(k=>{ if(summary[k]===undefined){ let v=parts[k].reduce((a,b)=>a+b,0); if(k==='withdrawals') v+=(summary.fees||0)+(summary.interest||0)+(summary.cashadvances||0);   /* separately labelled out-buckets are still money out */ summary[k]=r2(v); } });
  const header=out.filter(x=>x.region==='header'||x.region==='summary').map(x=>x.t).join('\n');
  /* no table at all — a bill, a receipt, a chat answer: then the whole thing is the list */
  const flat=!out.some(x=>x.region==='table');
  if(flat) out.forEach(x=>{ if(x.region==='header'&&!summaryKey(x.t)&&!x.paired) x.region='table'; });
  return {lines:out,header:header,summary:summary,flat:flat,table:out.filter(x=>x.region==='table').map(x=>x.t)};
}
function statementHeader(text){ return segmentStatement(text).header; }

let dateYearHint='';
function parseOCRText(text){
  const out=[]; let lastDate='', lastAmbig=false;
  dateOrderHint=inferDateOrder(text);
  const seg=segmentStatement(text);
  try{ const per=statementPeriod(seg.header); dateYearHint=((per.to||per.from||'').match(/^(\d{4})/)||[])[1]||''; }catch(e){ dateYearHint=''; }
  seg.lines.forEach(x=>{ if(x.region!=='table') parseSkipped.push({raw:x.t,why:x.region==='summary'?'statement control total or summary — metadata, not a transaction':x.region==='header'?'statement header':x.region==='legal'?'legal / disclosure text':x.region==='colhdr'?'column header (balance column detected)':'page header / footer'}); });
  /* an amount is either something with cents (82.10) or something with a currency sign ($82) */
  const amtRx=/([-+−]?)\s*(\$|CA\$|US\$|€|£)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?(?!\d)\s*(CR|DR|\+|-)?(?!\s*%)/gi;
  const DATE_RX=/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/;
  /* a statement's own control totals and its arithmetic are metadata, even inside the table */
  const CONTROL=[
    /^\s*(?:total\s+)?(?:deposits?|withdrawals?|credits?|debits?|payments?\s+and\s+credits?|purchases?\s+and\s+debits?)\s*[:\-]?\s*[-+]?\s*(?:\$|CA\$|US\$)?\s*[\d,]+\.\d{2}\s*$/i,
    /\breconciliation\b/i, /^[\s\d.,+\-=$()]*=[\s\d.,+\-$()]*$/,
    /^\s*(?:statement|account)\s+(?:summary|totals?)\b/i,
    /^\s*(?:sub-?total|grand\s+total|totals?)\s*[:\-]?\s*[-+]?\s*(?:\$|CA\$)?\s*[\d,]+\.\d{2}\s*$/i,
    /^\s*expected\s+control\s+totals?\b/i
  ];
  const SKIP=/\b(opening|closing|previous|new|statement|available|current|running|ending|final|beginning)\s+(balance|credit)\b|\b((opening|closing|previous|new|running|ending|final|beginning)\s+)?balance\s+(forward|brought\s+forward|carried\s+forward|due)\b|\b(sub-?total|grand\s+total|total\s+(deposits?|withdrawals?|credits?|debits?|payments?|purchases?|charges|interest|fees?|balance))\b|\bavailable\s+credit\b|\bcredit\s+limit\b|\bminimum\s+payment\b|\binterest\s+(charged|summary|rate)\b|\bannual\s+fee\b|\brewards?\s+(balance|summary)\b|\bpayment\s+due\s+date\b|\baccount\s+(number|summary)\b|\bnet\s+worth\b/i;
  const startsDated=l=>/^\s*(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)\b/.test(l)||new RegExp('^\\s*(?:(?:'+MONTHS_RX+')[a-z]*\\.?\\s*\\d{1,2}|\\d{1,2}\\s+(?:'+MONTHS_RX+')[a-z]*)\\b','i').test(l);
  const isControl=l=>CONTROL.some(rx=>rx.test(l))||(!startsDated(l)&&SKIP.test(l)&&!/amount due|total due/i.test(l)&&!RX_BALANCE_ROW.test(l));
  const RX_FX=/\b(USD|EUR|GBP|AUD|CHF|JPY|INR|MXN|CNY|HKD|NZD)\b\s*@\s*[\d.]+|\bexchange\s+rate\b|@\s*\d+\.\d{3,}/i;
  const balColHeader=seg.lines.some(x=>x.region==='colhdr'&&/balance/i.test(x.t));
  let prevBal=null, balCol=balColHeader;
  /* a line's numbers as the amount regex should see them: the leading date blanked (01.09 is not €1.09), and European
     figures (2.100,00 · 45,20) turned into the dot-decimal form at the same length, so positions still line up */
  const amountView=line=>{
    let v=String(line||'').replace(/^(\s*)(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)/,(m,sp,d)=>sp+' '.repeat(d.length));
    if(!/\d\.\d{2}(?!\d)/.test(v)&&/\d,\d{2}(?!\d)/.test(v)) v=v.replace(/(\d)\.(?=\d{3}(?:\D|$))/g,'$1,').replace(/(\d),(\d{2})(?!\d)/g,'$1.$2');
    return v;
  };
  const amountsIn=rawLine=>{ const line=amountView(rawLine); const res=[]; let m; amtRx.lastIndex=0;
    while((m=amtRx.exec(line))){
      if(!(m[4]||m[2])){
        /* a reference number, not money — and it must not swallow the +/- that belongs to the amount after it */
        const endOfDigits=m.index+m[0].indexOf(m[3])+m[3].length;
        if(endOfDigits>m.index&&endOfDigits<amtRx.lastIndex) amtRx.lastIndex=endOfDigits;
        continue;
      }
      if(/^\s*%/.test(line.slice(m.index+m[0].length))||/%$/.test(m[0])) continue;   /* 21.99% is a rate */
      const val=parseFloat(m[3].replace(/,/g,'')+(m[4]||''));
      res.push({text:m[0],val:val,neg:m[1]==='-'||m[1]==='−'||/^-$/.test(m[5]||'')||/dr/i.test(m[5]||''),pos:m[1]==='+'||m[5]==='+'||/cr/i.test(m[5]||''),cr:/cr/i.test(m[5]||''),index:m.index});
    }
    return res; };
  const stripAmounts=(line,list)=>{ let d=line; list.forEach(a=>{ d=d.replace(a.text,' '); }); return d; };
  const cleanDesc=(line,amts)=>stripAmounts(line,amts).replace(DATE_RX,'')
      .replace(new RegExp('^\\s*(?:(?:'+MONTHS_RX+')[a-z]*\\.?\\s*\\d{1,2}(?:\\/\\d{2,4})?(?:,?\\s+\\d{4})?\\s*){1,2}','i'),'').replace(/^\s*Ý\s*/,'')
      .replace(new RegExp('(\\b('+MONTHS_RX+')[a-z]*\\.?\\s+\\d{1,2}(,?\\s+\\d{4})?|\\b\\d{1,2}\\s+('+MONTHS_RX+')[a-z]*\\.?(,?\\s+\\d{4})?)','i'),'')
      .replace(/[|•·]+/g,' ').replace(/\s+[-–—]\s*$/,'').replace(/^\s*[-–—]\s+/,'').replace(/\s{2,}/g,' ').trim();

  /* ---- transaction row assembler ----
     A row is: a line carrying the posting amount (and, in a balance-column statement, the running balance),
     plus the description lines that belong with it — which may come BEFORE the amount (some banks) or
     AFTER it (CIBC). Which way this document does it is learned from its first dated transaction. */
  let mode=''; /* 'postFirst' | 'descFirst' */
  let sectionDir='', inBox=false;   /* a card statement groups rows under "Your payments" / "Your interest" / "Your new charges and credits" */
  const RX_SECTION=/^\s*your\s+(payments?|interest|new\s+charges(?:\s+and\s+credits)?|cash\s+advances?|fees|credits)\b/i;
  const RX_REPORT=/^\s*(?:personal and household expenses|professional and financial services|retail and grocery|transportation|hotel, entertainment and recreation|restaurants|home and office improvement|health and education|foreign currency transactions|other transactions)\s+\d+\s+[\d,]+\.\d{2}|^\s*total\s+\d+\s+[\d,]+\.\d{2}|^\s*total\s+monthly\s+budget\b|spend\s+report|^\s*(?:\d\.\s*)?(?:minimum\s+payment|remainder\s+of|total\s+minimum|amount\s+due\s+immediately|past\s+due|overlimit\s+due|current\s+due|total\s+dividend|\d+%\s+cash\s+back|total\s+payment\s+enclosed|total\s+(?:payments|interest\s+this\s+period|charges|credits)|accrued\s+interest|total\s+interest)\b/i;
  const rows=[]; let cur=null;
  /* strip only the FOREIGN figure and its rate; whatever money is left is the posting in the account's currency */
  const fxOnly=(amts,line)=>RX_FX.test(line)&&amountsIn(line.replace(/[\d,]+\.\d{2}\s*[A-Z]{3}\s*@\s*[\d.]+|@\s*[\d.]+|exchange\s+rate\s*:?\s*[\d.]+|original\s+amount\s*:?\s*[A-Z]{3}\s*[\d,]+\.\d{2}|[A-Z]{3}\s*[\d,]+\.\d{2}\s*@\s*[\d.]+/ig,' ')).length===0;
  /* a description that merely repeats the row's own amount ("CAPPED MONTHLY FEE $16.95"): no sign, no channel,
     no reference number — as opposed to the next transaction, which announces itself with those.
     A line that starts with its own date is a new transaction, not a repeat — two $5 coffees on
     different days must both survive. */
  const looksLikeRepeat=(amts,line)=>!startsDated(line)&&amts.length===1&&!amts[0].pos&&!amts[0].neg&&!channelOf(line)&&!/\d{6,}/.test(line)&&/[a-z]{3,}/i.test(stripAmounts(line,amts));
  const isPosting=(amts,line)=>{
    if(!amts.length) return false;
    if(fxOnly(amts,line)) return false;                                 /* "21.10 USD @ 1.446919" is metadata */
    if(balCol){
      if(amts.length>=2) return true;                                    /* amount + running balance */
      /* a lone amount in a balance-column table: only a posting if nothing else explains it */
      if(cur&&cur.amount!==null&&Math.abs(amts[0].val-cur.amount)<0.005&&looksLikeRepeat(amts,line)) return false; /* the fee named again in its own description */
      return !cur||cur.amount===null?true:false;
    }
    if(cur&&cur.amount!==null&&mode==='postFirst'&&Math.abs(amts[0].val-cur.amount)<0.005&&looksLikeRepeat(amts,line)) return false;
    return true;
  };
  const open=(line,d)=>{ cur={lines:[line],date:d||lastDate,amount:null,dir:'out',dirExplicit:false,bal:null,postLine:'',postAmts:[],fx:null,flags:[],ambig:lastAmbig,needsReview:/\bREVIEW\b/.test(line),balProblem:false}; rows.push(cur); };
  const fill=(line,amts)=>{
    cur.postLine=line; cur.postAmts=amts;
    let am=null, dir='out', dirExplicit=false, bal=null;
    if(amts.length>=2){
      const last=amts[amts.length-1], cands=amts.slice(0,-1);
      if(prevBal!==null){
        const hitOut=cands.find(c=>Math.abs(prevBal-c.val-last.val)<0.006), hitIn=cands.find(c=>Math.abs(prevBal+c.val-last.val)<0.006);
        if(hitOut||hitIn){ am=hitOut||hitIn; dir=hitOut?'out':'in'; dirExplicit=true; bal=last.val; balCol=true; }
        else if(balCol){ cur.balProblem=true; }
      }
      if(!am&&balCol){ am=cands.length===1?cands[0]:cands.find(c=>c.neg||c.pos)||cands[0]; bal=last.val; }
    }
    if(!am){ am=amts.find(a=>a.pos||a.neg)||amts.find(a=>/[$€£]/.test(a.text))||amts[amts.length-1]; }
    if(bal!==null) prevBal=bal;
    if(!dirExplicit){ if(am.pos){ dir='in'; dirExplicit=true; } else if(am.neg){ dir='out'; dirExplicit=true; } else if(sectionDir){ dir=sectionDir; dirExplicit=true; cur.section=sectionDir; } }
    cur.amount=am.val; cur.dir=dir; cur.dirExplicit=dirExplicit; cur.bal=bal; cur.sign=am.neg?'neg':am.pos?'pos':''; cur.cr=!!am.cr;
  };
  seg.table.forEach(line=>{
    { const sec=line.match(RX_SECTION); if(sec){ sectionDir=/^payment|^credits?$/i.test(sec[1].trim())?'in':'out'; inBox=false; cur=null; parseSkipped.push({raw:line,why:'section heading'}); return; } }
    /* the tear-off payment slip on page 1 of a card statement: amounts due, never transactions */
    if(/^\s*tear\s+off\b|^\s*payment\s+options\b/i.test(line)) inBox=true; if(/^\s*transactions\s+from\b/i.test(line)) inBox=false;
    if(inBox){ parseSkipped.push({raw:line,why:'payment slip — not a transaction'}); cur=null; return; }
    if(RX_REPORT.test(line)){ parseSkipped.push({raw:line,why:'statement control total or summary — metadata, not a transaction'}); cur=null; return; }
    line=line.replace(/^\s*\d{8,}(?=[A-Za-z])/,'');   /* a barcode glued to the first word of the line */
    if(isControl(line)){ parseSkipped.push({raw:line,why:'statement control total or summary — metadata, not a transaction'}); cur=null; return; }
    let d=parseLooseDate(line); const two=line.match(new RegExp('^\\s*(?:'+MONTHS_RX+')[a-z]*\\.?\\s*\\d{1,2}\\s+((?:'+MONTHS_RX+')[a-z]*\\.?\\s*\\d{1,2})\\b','i')); if(two){ const pd=parseLooseDate(two[1]); if(pd) d=pd; }
    if(d){ lastDate=d; lastAmbig=lastDateAmbiguous; }
    const amts=amountsIn(line);
    if(RX_BALANCE_ROW.test(line)){
      /* opening balance / balance forward / closing balance: a checkpoint for the running balance, never a row */
      const v=amts.length?amts[amts.length-1].val:null;
      if(v!==null){ if(prevBal!==null&&Math.abs(prevBal-v)>0.005&&/forward/i.test(line)) parseSkipped.push({raw:line,why:'balance forward '+v.toFixed(2)+' does not match the running balance '+prevBal.toFixed(2)+' — check the page break'}); prevBal=v; balCol=true; }
      parseSkipped.push({raw:line,why:/forward/i.test(line)?'summary / balance line — balance forward at a page break, not a transaction':'summary / balance line — opening or closing balance, not a transaction'});
      if(/\b(closing|ending|final)\s+balance\b/i.test(line)){ cur=null; }
      else cur=null;
      return;
    }
    const fxOf=l=>{ const m=l.match(/(?:original\s+amount\s*:?\s*)?(?:([A-Z]{3})\s*)?([\d,]+\.\d{2})\s*([A-Z]{3})?\b[^\d]*?(?:@|exchange\s+rate\s*:?)\s*([\d.]{4,})/i); if(!m) return null; const cur3=(m[3]||m[1]||'').toUpperCase(); return {amount:parseFloat(m[2].replace(/,/g,'')),currency:cur3,rate:parseFloat(m[4])||null}; };
    if(fxOnly(amts,line)&&cur){ cur.fx=fxOf(line)||cur.fx; cur.lines.push(line); return; }
    const posting=d?(amts.length>0&&!fxOnly(amts,line)):isPosting(amts,line);
    const fxHere=RX_FX.test(line)?fxOf(line):null;
    if(d){
      if(!mode) mode=posting?'postFirst':'descFirst';
      if(cur&&cur.amount===null){ parseSkipped.push({raw:cur.lines.join(' / '),why:'no amount found for this line'}); rows.pop(); }
      open(line,d); if(posting){ fill(line,fxHere?amts.filter(a=>!(fxHere&&Math.abs(a.val-fxHere.amount)<0.005&&amts.length>1)):amts); if(fxHere) cur.fx=fxHere; } return;
    }
    if(posting){
      const pa=fxHere?amts.filter(a=>!(Math.abs(a.val-fxHere.amount)<0.005&&amts.length>1)):amts;
      if(cur&&cur.amount===null){ fill(line,pa); cur.lines.push(line); if(fxHere) cur.fx=fxHere; return; }   /* description came first */
      open(line,lastDate); fill(line,pa); if(fxHere) cur.fx=fxHere; return;                                   /* an undated row on the same date */
    }
    /* a line without a posting amount */
    if(!cur){ parseSkipped.push({raw:line,why:/\d/.test(line)?'no amount found (needs cents or a currency sign)':'header / text without a number'}); return; }
    if(mode==='descFirst'&&cur.amount!==null){ open(line,lastDate); return; }        /* the next row's description */
    /* text after a finished row: in a balance-column statement it is the row's own continuation (CIBC prints
       the merchant under the amount); in a flat one-line-per-row list it is stray text, and says so */
    if(cur.amount!==null&&!balCol&&!/^\s*(?:TO|FROM)\s+(?:ACCOUNT|CARD)\b/i.test(line)){ parseSkipped.push({raw:line,why:/\d/.test(line)?'no amount found (needs cents or a currency sign)':'header / text without a number'}); return; }
    cur.lines.push(line);                                                            /* continuation of this row */
  });
  rows.forEach(r=>{
    if(r.amount===null){ parseSkipped.push({raw:r.lines.join(' / '),why:'no amount found for this line'}); return; }
    if(!r.amount){ parseSkipped.push({raw:r.lines.join(' / '),why:'amount is zero'}); return; }
    let desc=r.lines.map(l=>l===r.postLine?cleanDesc(l,r.postAmts):(RX_FX.test(l)?'':cleanDesc(l,amountsIn(l)))).filter(Boolean).join(' ')
      .replace(/\s+[-+]?\d+(\.\d+)?$/,'').replace(/\s{2,}/g,' ').trim();
    if(!desc||/^[-–—\s]*$/.test(desc)) desc='Transaction';
    let dir=r.dir, dirExplicit=r.dirExplicit;
    if(!dirExplicit&&/refund|deposit|payroll|salary|e-transfer received|interest|sale of|income|credit\b/i.test(desc)){ dir='in'; dirExplicit=true; }
    const flags=[];
    if(!dirExplicit) flags.push('direction guessed — no + or − sign');
    if(r.balProblem) flags.push('running balance does not add up on this row — check the amount and direction');
    if(r.needsReview||!r.date) flags.push(r.needsReview?'marked REVIEW — check the date':'no date on this line');
    else if(r.ambig) flags.push('date could be day/month or month/day — reads as '+fmtDate(r.date));
    const row={date:r.date||todayISO(),description:desc.replace(/\bREVIEW\b/,'').trim(),amount:r.amount,direction:dir,category:guessCategory(desc,dir),flags:flags,cr:!!r.cr,raw:r.lines.join(' / '),balance:r.bal,sign:r.sign||''};
    if(r.fx&&r.fx.amount) row.fx=r.fx;
    out.push(row);
  });
  dateOrderHint='';
  return out;
}
/* ---- reading a PDF on this machine ----
   A statement PDF nearly always carries its own text layer. PDF.js — kept in vendor/ beside this file, never
   fetched from the internet — reads that layer here in the browser: the file never leaves the computer, no
   key is needed, and it works with no network at all. The text comes out with its positions, so columns are rebuilt as spacing — which is exactly the
   layout the region parser reads. A PDF that is only pictures has nothing to read; that is said plainly
   and the choice is the user's. */
const PDFJS_VERSION='3.11.174', PDFJS_DIR='vendor/';   /* pdf.min.js + pdf.worker.min.js, exact version proven by the tests */
let pdfjsLoading=null, pdfPagesRead=0, pdfScanned=[];
async function ensurePdfjs(){
  if(window.pdfjsLib){
    /* the single-file build carries pdf.js inline and its worker as a text block: the worker runs from a blob URL */
    if(!window.pdfjsLib.GlobalWorkerOptions.workerSrc){ const w=document.getElementById('pdfWorkerSrc'); let src=PDFJS_DIR+'pdf.worker.min.js'; if(w){ try{ src=URL.createObjectURL(new Blob([w.textContent],{type:'text/javascript'})); }catch(e){ dlog('blob worker unavailable',{error:String(e&&e.message||e)}); } } window.pdfjsLib.GlobalWorkerOptions.workerSrc=src; }
    return window.pdfjsLib;
  }
  if(!pdfjsLoading) pdfjsLoading=loadScript(PDFJS_DIR+'pdf.min.js').then(()=>{
    if(!window.pdfjsLib) throw new Error('PDF reader did not load');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDFJS_DIR+'pdf.worker.min.js'; return window.pdfjsLib;
  }).catch(e=>{ pdfjsLoading=null; throw new Error('The PDF reader is missing: keep the vendor/ folder (pdf.min.js and pdf.worker.min.js) next to finance-dashboard.html. Nothing is downloaded at runtime.'); });
  return pdfjsLoading;
}
/* positioned text items → lines, top to bottom, with a wide gap wherever the page had a column break */
function pdfItemsToText(items){
  const rows=[];
  (items||[]).forEach(it=>{
    if(!it||!it.str||!it.str.trim()||!it.transform) return;
    const x=it.transform[4], y=it.transform[5];
    let row=rows.find(r=>Math.abs(r.y-y)<=2.5);
    if(!row){ row={y:y,cells:[]}; rows.push(row); }
    row.cells.push({x:x,w:Number(it.width)||0,s:it.str});
  });
  return rows.sort((a,b)=>b.y-a.y).map(r=>{
    const cells=r.cells.sort((a,b)=>a.x-b.x); let out='', last=null;
    cells.forEach(c=>{ if(last!==null){ const gap=c.x-last; out+=gap>6?'   ':(gap>0.5&&!/\s$/.test(out)&&!/^\s/.test(c.s)?' ':''); } out+=c.s; last=c.x+c.w; });
    return out.replace(/\s+$/,'');
  }).filter(l=>l.trim()).join('\n');
}
async function extractPdfText(shot,onPage){
  const lib=await ensurePdfjs();
  const bytes=Uint8Array.from(atob(shot.b64),c=>c.charCodeAt(0));
  const doc=await lib.getDocument({data:bytes,isEvalSupported:false,disableFontFace:true}).promise;
  const pages=[];
  for(let i=1;i<=doc.numPages;i++){ if(onPage) onPage(i,doc.numPages); const page=await doc.getPage(i); const tc=await page.getTextContent(); pages.push(pdfItemsToText(tc.items)); }
  const text=pages.join('\n');
  return {text:text,pages:doc.numPages,chars:text.replace(/\s/g,'').length};
}
/* Tesseract commonly confuses letters and digits in numeric contexts: O→0, l/I→1, S→5, B→8.
   This fixes only characters that sit next to digits or after a currency sign — never free-standing
   words, so merchant names are untouched. Applied to OCR output only, never to PDF text layers or
   pasted text, which are already clean. */
function cleanOCRText(text){
  return String(text||'').split(/\r?\n/).map(line=>{
    return line.replace(/(\$|CA\$|US\$|€|£)\s*([0-9OolISB]+(?:[.,][0-9OolISB]{1,2})?)/g,(m,cur,num)=>{
      return cur+' '+num.replace(/O/g,'0').replace(/o/g,'0').replace(/l/g,'1').replace(/I/g,'1').replace(/S/g,'5').replace(/B/g,'8');
    }).replace(/(\d[0-9OolISB]*)([.,])([0-9OolISB]{2})\b/g,(m,a,sep,b)=>{
      return a.replace(/O/g,'0').replace(/l/g,'1').replace(/I/g,'1').replace(/S/g,'5').replace(/B/g,'8')+sep+b.replace(/O/g,'0').replace(/o/g,'0').replace(/l/g,'1').replace(/I/g,'1');
    });
  }).join('\n');
}
async function extractWithOCR(){
  parseSkipped=[]; pdfPagesRead=0; pdfScanned=[];
  let text=shotText();
  const pdfs=shots.filter(s=>s.pdf);
  for(let i=0;i<pdfs.length;i++){
    const r=await extractPdfText(pdfs[i],(pg,n)=>setShotStatus('<span class="spin"></span>Reading '+esc(pdfs[i].name||'the PDF')+' on this computer — page '+pg+' of '+n+'…'));
    pdfPagesRead+=r.pages;
    if(r.chars<80) pdfScanned.push(pdfs[i].name||'PDF'); else text=(text?text+'\n':'')+r.text;
  }
  if(pdfScanned.length&&!text){ const e=new Error('This PDF appears to contain scanned images rather than selectable text.'); e.scanned=true; throw e; }
  shotHint=text?sniffHint(text):null;
  let rows=text?parseOCRText(plainText(text)):[];
  if(!shots.some(s=>!s.pdf)) return rows;
  if(!window.Tesseract){
    setShotStatus('<span class="spin"></span>Loading text recognition (one-time, about 3 MB)…');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js');
  }
  const worker=await window.Tesseract.createWorker('eng');
  try{
    const imgs=shots.filter(s=>!s.pdf);
    for(let i=0;i<imgs.length;i++){
      setShotStatus('<span class="spin"></span>Reading screenshot '+(i+1)+' of '+imgs.length+'…');
      const r=await worker.recognize(imgs[i].url);
      const txt=cleanOCRText(r.data.text||'');
      let got=parseOCRText(txt);
      if(/amount due|total due|due date|please pay|invoice|balance due|pay by/i.test(txt)&&got.length){
        const top=got.slice().sort((a,b)=>b.amount-a.amount)[0];
        const due=(txt.match(/(?:due|pay by)[^\n]*?((?:\d{4}-\d{1,2}-\d{1,2})|(?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:[A-Za-z]{3,9}\.? \d{1,2},? ?\d{0,4})|(?:\d{1,2} [A-Za-z]{3,9}\.?,? ?\d{0,4}))/i)||[])[1];
        const vendor=txt.split(/\r?\n/).map(l=>l.trim()).find(l=>l.length>2&&!/\d{2}/.test(l))||'Bill';
        got=[{date:(due&&parseLooseDate(due))||top.date,description:vendor,amount:top.amount,direction:'out',category:guessCategory(vendor,'out')||top.category,kind:'bill'}];
      }
      if(!shotHint) shotHint=sniffHint(txt);
      rows=rows.concat(got);
    }
  } finally { try{ await worker.terminate(); }catch(e){} }
  return rows;
}

/* ---- review + commit ---- */
/* ---- duplicate detection ----
   DEFINITE (auto-unticked in the review list, skipped by the CSV importer): same account AND either the
   bank's own reference id matches, or the same SOURCE — a hash of the very file(s) / pasted text / CSV text
   — AND the same line in it was imported before. A different export that prints an identical line (even one
   with the same statement date) is a different source, so it can only be "possible".
   Two rows that both carry reference ids that DIFFER are never duplicates.
   POSSIBLE (kept ticked, marked ⚠): same account · date · amount · direction · normalised description, but
   no reference id or source line to prove it — two coffees at the same place on one day look exactly like
   this, so the decision is the user's.
   Anything else is new. Accounts never collide. Within one import the k-th identical row only pairs with
   the k-th identical row already in the ledger, so a batch with two coffees against a ledger holding one
   leaves the second coffee ticked. */
function descKey(note){ return String(note||'').toUpperCase().replace(/#\S*/g,' ').replace(/[^A-Z0-9]+/g,' ').split(' ').filter(t=>t&&!/\d{3,}/.test(t)).join(' '); }
function srcKey(raw){ const s=String(raw||'').toUpperCase().replace(/\s+/g,' ').trim(); return s.length>=8?s:''; }
function refKey(ref){ return String(ref||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
const REF_RX=/\b(?:ref(?:erence)?|conf(?:irmation)?|trace|auth(?:orization)?|txn|transaction)\s*(?:id|no|num|number)?\s*[#:.]?\s*([A-Z0-9][A-Z0-9-]{5,})/i;
function refFromText(s){ const m=REF_RX.exec(String(s||'')); return m?m[1]:''; }
function sameAmt(a,b){ return Math.abs((Number(a)||0)-(Number(b)||0))<0.005; }
/* content fingerprint for DEFINITE-duplicate decisions: SHA-256 of the exact bytes/text via Web Crypto.
   Same content → same hex, always; nothing else (file name, ids, time, UI state) goes in. If Web Crypto is
   unavailable the fingerprint is prefixed differently so it can never be mistaken for a SHA-256 one. */
function strHash(s){ let h=5381; for(let i=0;i<s.length;i++) h=((h*33)^s.charCodeAt(i))>>>0; return h.toString(16); }
async function contentHash(str){
  try{
    if(window.crypto&&window.crypto.subtle&&window.TextEncoder){
      const buf=await window.crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(str)));
      return 'sha256:'+Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
    }
  }catch(e){ dlog('sha256 unavailable',{error:String(e&&e.message||e)}); }
  return 'weak:'+strHash(String(str));
}
/* how one ledger row relates to one review row, for a given target account: 'definite' | 'possible' | '' */
function dupLevel(r,t,into){
  if(!into) return '';
  if(/^xfer/.test(r.type)){
    const other=r.type.replace(/^xferin:|^xfer:/,'');
    if(t.type==='transfer'){
      if(t.fromId!==into&&t.toId!==into) return '';
      if(other&&t.fromId!==other&&t.toId!==other) return '';
    }else{
      /* the same bank line, filed as plain money out/in before the other account existed */
      if(t.accountId!==into) return '';
      if(/^xfer:/.test(r.type)&&t.type!=='out') return ''; if(/^xferin:/.test(r.type)&&t.type!=='in') return '';
    }
  }else if(t.type==='transfer'){
    /* a statement line later re-booked as a transfer (a card payment, a move to savings) is still the same
       movement on this account: money out = it left here, money in = it arrived here */
    if(r.type==='out'&&t.fromId!==into) return '';
    if(r.type==='in'&&t.toId!==into) return '';
    if(r.type!=='in'&&r.type!=='out') return '';
  }else{
    if(t.type!==r.type||t.accountId!==into) return '';
  }
  const rk=refKey(r.ref), tk=refKey(t.ref);
  if(rk&&tk) return rk===tk?'definite':'';
  if(!sameAmt(t.amount,r.amount)) return '';
  const rs=srcKey(r.raw), ts=srcKey(t.raw), ts2=srcKey(t.raw2);
  /* a weak (non-SHA-256) fingerprint is never proof: it may only support a "possible" verdict below */
  if(rs&&ts&&rs===ts&&r.src&&t.src===r.src&&/ sha256:[0-9a-f]{64}$/.test(r.src)) return 'definite';
  if(rs&&ts2&&rs===ts2&&r.src&&t.src2===r.src&&/ sha256:[0-9a-f]{64}$/.test(r.src)) return 'definite';   /* the other side's statement line */
  if(t.date!==r.date) return '';
  const dk=descKey(r.note);
  return dk&&descKey(t.note)===dk?'possible':'';
}
/* classify a whole batch. opts: into (account id; defaults to the scan dialog's), used (shared claim map so
   several calls behave as one batch), exclude (ids added by this very import, never matched against) */
function classifyDups(rows,opts){
  opts=opts||{}; const into='into' in opts?opts.into:(($('#shotAcct')||{}).value||'');
  const used=opts.used||{}, exclude=opts.exclude||{};
  rows.forEach(r=>{ if(!r.edited){ r.dup=''; r.dupOf=null; } });
  rows.forEach(r=>{
    if(r.edited||r.type!=='bill') return;
    const p=S.planned.find(p=>!used['p:'+p.id]&&p.date===r.date&&sameAmt(p.amount,r.amount));
    if(p){ used['p:'+p.id]=1; r.dup=descKey(p.name)===descKey(r.note)?'definite':'possible'; r.dupOf=p; }
  });
  ['definite','possible'].forEach(level=>{
    rows.forEach(r=>{
      if(r.edited||r.dup||r.type==='bill') return;
      const t=S.transactions.find(t=>!used[t.id]&&!exclude[t.id]&&dupLevel(r,t,into)===level);
      if(t){ used[t.id]=1; r.dup=level; r.dupOf=t; }
    });
  });
  /* One row matching something already recorded is ordinary life — two identical coffees on one day.
     Most of a batch matching is not: it is the same document read a second time, with different bytes
     (a re-scan, another photo, a fresh export) so no row can be proven definite. Untick the lot. */
  const cand=rows.filter(r=>!r.edited&&r.type!=='bill');
  const maybes=cand.filter(r=>r.dup==='possible').length;
  rows.reimport=cand.length>=REIMPORT_MIN&&maybes*2>cand.length;
  rows.forEach(r=>{
    if(r.edited) return;
    r.flags=(r.flags||[]).filter(f=>!/^possible duplicate/.test(f));
    if(r.dup==='possible') r.flags.push('possible duplicate — '+fmtDate(r.dupOf.date)+' '+money(r.dupOf.amount)+' “'+(r.dupOf.note||r.dupOf.name||'')+'” is already in the ledger, but no reference id or statement line proves it is the same one. '
      +(rows.reimport?'Unticked: most of this import matches rows you already have, so this looks like the same document again. Tick it if it really is new.':'Left ticked: untick it if it is.'));
    r.on=r.dup!=='definite'&&!(rows.reimport&&r.dup==='possible')&&r.amount>0;
  });
  return rows;
}
function isDup(r,opts){ return classifyDups([Object.assign({},r,{edited:false})],opts)[0].dup; }
const RX_OWN_SCREEN=/Import from screenshots & documents|Import pipeline · |Drop screenshots, photos or PDFs here|will be added\b|Statement does not reconcile — review parsing|Check them over — fix anything/;
async function readShots(){
  if(shotBusy) return;
  if(!shots.length&&RX_OWN_SCREEN.test(shotText())){ revRows=[]; shotHint=null; renderReview(); setShotStatus('<b>This looks like a copy of Ledger’s own screen, not a statement.</b> Select only the statement text (from the bank’s name down to the last transaction line) and paste that.'); { const b=$('#shotCommitBtn'); if(b) b.disabled=true; } toast('That paste includes Ledger’s own page — paste only the statement'); return; }
  if(!shots.length&&!shotText()){ toast('Add a screenshot, a file, or paste some text first'); return; }
  if(!shots.length&&shotText().length>500000){ setShotStatus('<b>That paste is very large</b> — paste one statement at a time (up to about 500,000 characters).'); toast('Paste one statement at a time'); return; }
  /* every read starts from a clean account choice — nothing carries over from the previous statement */
  shotAcctChosen=false; { const sel=$('#shotAcct'); if(sel) sel.value=''; }
  shotBusy=true; $('#shotReadBtn').disabled=true;
  setShotStatus('<span class="spin"></span>'+(aiKey()?'Asking '+esc(aiModelLabel())+' to read '+shots.length+' file'+(shots.length===1?'':'s')+'…':'Starting…'));
  try{
    if(aiKey()) shotHint=null;
    const rows=!aiKey()?await extractWithOCR():aiProvider()==='openrouter'?await extractWithOpenRouter():await extractWithClaude();
    const shotsHash=shots.length?await contentHash(shots.map(x=>x.b64||'').join('|')):'';
    /* identity of THIS source = a hash of the files' bytes or of the pasted text itself — never UI state,
       generated ids or the statement date (two exports can share a date), so the same source always re-hashes the same */
    const srcId=shots.length?'FILE '+shotsHash:'TEXT '+await contentHash(shotText());
    { const sel=$('#shotAcct'); const m=matchAccount(shotHint); if(sel&&!sel.value){ if(m) sel.value=m.id; else if(!shotHint&&S.accounts.length) sel.value=S.accounts[0].id; } }
    revRows=rows.map(r=>{
      const dir=r.direction==='in'?'in':'out';
      const cname=String(r.category||'').trim();
      const c=S.categories.find(x=>x.name.toLowerCase()===cname.toLowerCase()&&x.type===dir)
            ||(dir==='out'?S.categories.find(x=>x.id==='c0'):S.categories.find(x=>x.id==='c2'))||S.categories.find(x=>x.type===dir);
      const row={date:/^\d{4}-\d{2}-\d{2}$/.test(r.date||'')?r.date:todayISO(),note:String(r.description||'').trim(),
        amount:Math.abs(Number(r.amount)||0),type:r.kind==='bill'?'bill':dir,categoryId:c?c.id:''};
      row.flags=Array.isArray(r.flags)?r.flags.slice():[];
      /* model-read rows have no source line; the file's own hash plus the row makes the same file re-scanned a definite duplicate */
      row.raw=r.raw||(shots.length?'FILE '+shotsHash+' '+row.date+' '+row.amount.toFixed(2)+' '+row.note:''); row.sign=r.sign||''; row.cr=!!r.cr; row.fromModel=!!aiKey();
      row.ref=String(r.ref||r.reference||r.transactionId||'').trim()||refFromText(r.raw||''); row.src=srcId;
      if(r.fx&&r.fx.amount) row.fx=r.fx;   /* foreign amount + rate: metadata only, never a second row */
      const rr=matchRule(row.note,($('#shotAcct')||{}).value||'');
      if(rr&&row.type!=='bill'){ row.categoryId=rr.categoryId; row.type=cat(rr.categoryId).type; row.ruleId=rr.id; row.flags=row.flags.filter(f=>!/direction/.test(f)); }
      else if(rr&&cat(rr.categoryId).type==='out'){ row.categoryId=rr.categoryId; row.ruleId=rr.id; }
      if(row.type==='in'&&!rr&&!incomeRecognised(row.note)) row.flags.push('income source not recognised — filed as Other income; check it is really income and not a transfer');
      const bh=bankHint(row.note);
      if(bh){ row.bankHint=bh.kind;
        const targets=transferTargets(row);
        row.flags.push(bh.why+(targets.length?' — choose “Move to …” so it is not counted as spending':bh.kind==='reversal'?' — check it before adding it as income':' — add the account it belongs to, then record it as a transfer rather than spending'));
      }
      const tg=transferTargets(row);
      /* the bank printed the destination account number: "TO CARD 99991234" is the card ending 1234 */
      if(bh&&(bh.kind==='card'||bh.kind==='internal'||bh.kind==='loan')){
        const na=numberedAccount(row,($('#shotAcct')||{}).value||'');
        if(na&&(row.type==='out'||row.type==='in')){ row.byNumber=na.id; row.type=(row.type==='out'?'xfer:':'xferin:')+na.id; row.flags=row.flags.filter(f=>!/choose “Move to|choose “Payment from|record it as a transfer|add the account it belongs to|income source not recognised/.test(f)); row.flags.push('account number matches '+na.name+' — recorded as a transfer '+(row.type.indexOf('xferin:')===0?'from':'to')+' it'); }
      }
      if(row.categoryId==='c23'){ if(tg.length===1) row.type='xfer:'+tg[0].id; else row.flags.push('cash withdrawal — the cash may be spent later; add a Cash account to track it as a transfer instead of spending'); }
      else if(row.categoryId==='c21'||row.categoryId==='c31'){ const hit=tg.find(a=>merchantKey(a.name)&&normText(row.note).indexOf(normText(merchantKey(a.name).split(' ')[0]))>=0); if(hit) row.type='xfer:'+hit.id; else if(tg.length) row.flags.push('payment to a loan or card — choose “Move to …” if that account is tracked here, so it is not counted as spending'); }
      row.on=row.amount>0;
      return row;
    }).filter(r=>r.amount>0);
    classifyDups(revRows);
    importTrace={source:shots.length?'scan':'paste',at:Date.now(),engine:aiKey()?aiVendor()+' · '+aiModel():(pdfPagesRead?'on-device · PDF text layer ('+pdfPagesRead+' page'+(pdfPagesRead===1?'':'s')+')':'on-device'),rows:revRows.map(r=>({raw:r.raw||r.note,parsed:{date:r.date,amount:r.amount,note:r.note,direction:r.type},normalized:{date:r.date,amount:r.amount,type:r.type,categoryId:r.categoryId},rule:r.ruleId?(S.rules.find(x=>x.id===r.ruleId)||{}).match:'',dup:r.dup==='definite'?'definite duplicate (reference id or identical source line) — unticked':r.dup==='possible'?'possible duplicate (same account · date · amount · direction · merchant, unproven) — ticked, ⚠ for you to decide':'no',flags:r.flags||[],final:r.on?'will be added':'excluded'})),skipped:parseSkipped.slice()};
    dlog('import parsed',{source:importTrace.source,rows:revRows.length,skipped:parseSkipped.length,dups:revRows.filter(r=>r.dup==='definite').length,possible:revRows.filter(r=>r.dup==='possible').length});
    renderHint(); applyAccountSemantics();
    renderReview();
  }catch(e){
    console.error(e);
    if(e&&e.scanned){
      setShotStatus('<span style="color:var(--out)"><b>'+esc(e.message)+'</b></span> Nothing was sent anywhere. '+
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'+(aiKey()?'<button class="btn btn-sm btn-primary" data-act="shot-read-ai">Read it with '+esc(aiVendor())+'</button>':'<span class="muted" style="font-size:12.5px;align-self:center">Add an AI key under Settings › AI to read scanned pages, or</span>')+
        '<button class="btn btn-sm" data-act="shot-paste-focus">Paste the text instead</button><button class="btn btn-sm btn-ghost" data-act="close-modal">Cancel</button></div>');
    }else setShotStatus('<span style="color:var(--out)">'+esc(e.message||'Something went wrong')+'</span>');
  }
  shotBusy=false; const b=$('#shotReadBtn'); if(b) b.disabled=false;
}
function renderReview(){
  const box=$('#shotReview'); if(!box) return;
  if(!revRows.length){ setShotStatus('Nothing that looked like a transaction was found. Try a tighter crop or a clearer screenshot.'); box.innerHTML=''; refreshCommitGate(); return; }
  const dups=revRows.filter(r=>r.dup==='definite').length, maybe=revRows.filter(r=>r.dup==='possible').length;
  const bills=revRows.filter(r=>r.type==='bill').length, flagged=revRows.filter(r=>r.flags&&r.flags.length).length;
  const vague=revRows.filter(r=>r.type!=='bill'&&cat(r.categoryId).id==='c0').length;
  setShotStatus((pdfPagesRead&&!aiKey()?'<span class="muted">PDF read on this computer — '+pdfPagesRead+' page'+(pdfPagesRead===1?'':'s')+', nothing left your machine.</span> ':'')+'Found '+revRows.length+' item'+(revRows.length===1?'':'s')+(bills?' ('+bills+' upcoming bill'+(bills===1?'':'s')+')':'')+'. Check them over — fix anything, untick what you don\'t want.'+(vague?' <span class="muted">'+vague+' could not be categorised (“Uncategorised”) — pick the right category here and Ledger will offer to remember the merchant.</span>':'')+(dups?' '+dups+(dups===1?' is':' are')+' already in the ledger (same reference id or the same statement line), so '+(dups===1?'it is':'they are')+' unticked.':'')+(maybe&&revRows.reimport?' <b style="color:var(--accent)">This looks like a document you have already added.</b> '+maybe+' of these '+(maybe===1?'matches':'match')+' rows already in this account — same date, amount and merchant — but the file itself is different (a re-scan, another photo, a fresh export), so nothing proves it row by row. <b>All '+maybe+' are unticked.</b> Tick any that really are new.':'')
      +(maybe&&!revRows.reimport?' <b style="color:var(--accent)">'+maybe+' might be '+(maybe===1?'a duplicate':'duplicates')+' — same account, date, amount and merchant as something already recorded, but nothing proves it. Left ticked (⚠): untick if it is the same purchase.</b>':'')+(flagged?' <b style="color:var(--accent)">'+flagged+' marked ⚠ had to be guessed — check the date or in/out before adding.</b>':''));
  const catOpts=t=>S.categories.filter(c=>c.type===(t==='in'?'in':'out')).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  box.innerHTML=`<div class="rev head"><span></span><span>Date</span><span>Description</span><span>Amount</span><span>Add as</span><span>Category</span></div>`+
    revRows.map((r,i)=>`<div class="rev${r.dup==='definite'?' dup':r.dup==='possible'?' maybe':''}${r.flags&&r.flags.length?' flagged':''}" data-r="${i}" ${r.flags&&r.flags.length?'title="'+esc(r.flags.join(' · '))+'"':''}>
      <span style="display:flex;align-items:center;gap:3px"><input type="checkbox" data-f="on" data-act="rev-on" ${r.on?'checked':''} aria-label="Include">${r.flags&&r.flags.length?'<span class="flag" title="'+esc(r.flags.join(' · '))+'">⚠</span>':''}</span>
      <input type="date" data-f="date" value="${esc(r.date)}">
      <input type="text" data-f="note" value="${esc(r.note)}" placeholder="Description">
      <input type="number" step="0.01" inputmode="decimal" data-f="amount" value="${r.amount.toFixed(2)}" class="num">
      <select data-f="type" data-act="rev-type"><option value="out"${r.type==='out'?' selected':''}>Money out</option><option value="in"${r.type==='in'?' selected':''}>Money in</option><option value="bill"${r.type==='bill'?' selected':''}>Upcoming bill</option>${transferTargets(r).map(a=>`<option value="xfer:${a.id}"${r.type==='xfer:'+a.id?' selected':''}>Move to ${esc(a.name)}</option>`).join('')}${paymentSources(r).map(a=>`<option value="xferin:${a.id}"${r.type==='xferin:'+a.id?' selected':''}>Payment from ${esc(a.name)}</option>`).join('')}</select>
      <select data-f="categoryId">${catOpts(r.type)}</select>
    </div>`).join('');
  box.querySelectorAll('.rev[data-r]').forEach(el=>{ const r=revRows[+el.dataset.r]; const sel=el.querySelector('[data-f="categoryId"]'); if(sel&&r.categoryId) sel.value=r.categoryId; });
  if(debugOn()&&importTrace) box.insertAdjacentHTML('beforeend',importPipelineHTML(importTrace));
  $('#shotCommitBtn').hidden=false; $('#shotReadBtn').textContent='Read again';
  refreshCommitGate();
}
/* Nothing may be committed until an account is chosen, and not at all while the statement's own totals
   disagree with what was parsed — a statement that does not reconcile is a parsing problem, not an import. */
function statementReconcile(rows){
  const h=shotHint; if(!h||h.opening===undefined||h.opening===null||h.balance===null||h.balance===undefined) return null;
  /* a payment already recorded from the paying account's side is unticked here, but it IS in the period's movements */
  const list=(rows||revRows||[]).filter(r=>(r.on||r.twinId)&&r.type!=='bill');
  const ins=r2(sum(list.filter(r=>r.type==='in'||/^xferin:/.test(r.type)).map(r=>r.amount)));
  const outs=r2(sum(list.filter(r=>r.type==='out'||/^xfer:/.test(r.type)).map(r=>r.amount)));
  /* on a debt, charges (money out) raise what is owed and payments (money in) lower it */
  const into=acct(($('#shotAcct')||{}).value||''); const liab=into?into.kind==='liability':typeKind(hintType(h)||'')==='liability';
  const calc=r2(liab?Number(h.opening)+outs-ins:Number(h.opening)+ins-outs), stated=r2(Number(h.balance));
  const depOk=h.deposits===undefined||Math.abs(ins-Number(h.deposits))<0.005, wdrOk=h.withdrawals===undefined||Math.abs(outs-Number(h.withdrawals))<0.005;
  return {liability:liab,opening:r2(Number(h.opening)),deposits:ins,withdrawals:outs,statedDeposits:h.deposits,statedWithdrawals:h.withdrawals,calculated:calc,stated:stated,diff:r2(calc-stated),ok:Math.abs(calc-stated)<0.005&&depOk&&wdrOk,depOk:depOk,wdrOk:wdrOk,count:list.length};
}
function refreshCommitGate(){
  const btn=$('#shotCommitBtn'); if(!btn) return;
  const acctChosen=!!(($('#shotAcct')||{}).value);
  const rec=statementReconcile();
  const clash=shotKindClash();
  const ticked=(revRows||[]).filter(r=>r.on&&r.type!=='bill'); const undated=ticked.filter(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.date||'')).length;
  const toAdd=ticked.length-undated, twins=(revRows||[]).filter(r=>r.twinId).length;
  const nothing=!toAdd&&!twins&&unreadLines()>=3;   /* the layout was not understood: lines that look like transactions, none readable */
  const h=shotHint; const noClose=!!(h&&h.period&&h.period.from&&(h.balance===null||h.balance===undefined));   /* a statement always closes with a balance */
  const blocked=!acctChosen||!!clash||nothing||noClose||undated>0||(rec&&!rec.ok);
  btn.disabled=blocked;
  btn.title=!acctChosen?'Choose which account these belong to first':(rec&&!rec.ok?'The statement does not reconcile — review the parsing first':'');
  const box=$('#shotGate');
  const newAcct=!acctChosen&&shotHint&&shotHint.last4&&!matchAccount(shotHint)&&$('[data-act="shot-make-acct"]');
  const html=!acctChosen
    ? (newAcct
        ? '<b>New account detected — '+esc(hintLabel(shotHint))+'.</b> This statement belongs to an account Ledger does not have yet. Check the details in the panel at the top, then <button class="btn btn-sm btn-primary" data-act="shot-make-acct" style="margin:0 4px">Create this account</button>'+(S.accounts.length?' — or pick an existing account below.':'.')
        : '<b>Choose an account first.</b> Ledger will not file a statement into an account you have not picked.'+(S.accounts.length?'':' There are no accounts yet: create one from this statement above.'))
    : clash ? '<b>'+esc(clash.text)+'</b>'
    : nothing ? '<b>No transactions were read from this statement.</b> The layout was not understood, so nothing will be added — paste the statement text again, or a PDF.'
    : undated ? '<b>'+undated+' ticked row'+(undated===1?' has':'s have')+' no readable date.</b> Fix the date on each, or untick them — Ledger will not add a row it cannot place in time.'
    : noClose ? '<b>This reads as a statement, but its closing balance could not be found.</b> Without it nothing can be reconciled, so nothing will be added — paste the statement including its balance lines.'
    : (rec&&!rec.ok
        ? '<b>Statement does not reconcile — review parsing before importing.</b><br>'+esc(money(rec.opening))+' opening '+(rec.liability?'+ '+esc(money(rec.withdrawals))+' charges − '+esc(money(rec.deposits))+' payments':'+ '+esc(money(rec.deposits))+' in − '+esc(money(rec.withdrawals))+' out')+' = <b>'+esc(money(rec.calculated))+'</b>, but the statement closes at <b>'+esc(money(rec.stated))+'</b> ('+esc(signed(rec.diff))+' out).'+(!rec.depOk?' Deposits parsed '+esc(money(rec.deposits))+' vs stated '+esc(money(rec.statedDeposits))+'.':'')+(!rec.wdrOk?' Withdrawals parsed '+esc(money(rec.withdrawals))+' vs stated '+esc(money(rec.statedWithdrawals))+'.':'')+' '+rec.count+' rows ticked.'
        : (rec?'<b>Statement reconciles.</b> '+esc(money(rec.opening))+(rec.liability?' + '+esc(money(rec.withdrawals))+' charges − '+esc(money(rec.deposits))+' payments':' + '+esc(money(rec.deposits))+' − '+esc(money(rec.withdrawals)))+' = '+esc(money(rec.stated))+' across '+rec.count+' rows.':'<b>Not reconciled</b> — no opening and closing balance were found, so these '+toAdd+' row'+(toAdd===1?'':'s')+' cannot be checked against the bank’s totals. Fine for a list or a screenshot; for a statement, paste the whole thing including its balances.'))
    +(acctChosen&&unsourcedPayments().length?'<br><b>'+unsourcedPayments().length+' payment'+(unsourcedPayments().length===1?'':'s')+' to this '+((acct(($('#shotAcct')||{}).value||'')||{}).acctType==='credit card'?'card':'debt')+' '+(unsourcedPayments().length===1?'has':'have')+' no source account</b> — choose “Payment from …” on each if you track the account it came from; until then it is money in on this card, not income, but it will not reduce that other account.':'')
    +(acctChosen&&statementDate()>todayISO()?'<br><b>This statement is dated in the future ('+esc(fmtDate(statementDate()))+').</b> Its rows and checkpoint will be recorded, but they will not move today’s balances or net worth until their dates arrive.':'');
  if(box) box.innerHTML=html?'<div class="verdict'+(!blocked&&rec?' ok':'')+'" style="margin:8px 0 0">'+html+'</div>':'';
}
function rememberMerchantsModal(list){
  pendingFixes=list;
  openSheet('Remember these merchants?',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">You changed the category on ${list.length} merchant${list.length===1?'':'s'}. Remember them as rules so they file themselves next time? Untick any you don't want; “No” keeps the change on these transactions only.</div>
    ${list.map((f,i)=>`<label class="field" style="display:flex;align-items:center;gap:9px"><input type="checkbox" data-fix="${i}" checked style="width:auto;margin:0"><span style="margin:0;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--ink);font-weight:400"><b class="num">${esc(f.match)}</b> → ${esc(cat(f.categoryId).name)}</span></label>`).join('')}`,
    `<span class="spacer"></span><button class="btn" data-act="fixes-no">No, just these transactions</button><button class="btn btn-primary" data-act="fixes-yes">Remember selected</button>`);
}
let pendingFixes=[];
/* accounts a row could be a transfer into: a Cash account for withdrawals, a liability for loan / card payments */
/* the account whose number the bank printed on the line ("TO CARD 99991234", "TO ACCOUNT 12345/678") — strong,
   direction-free evidence; exactly one match or nothing */
function lineNamesAccount(rawAndNote,a){ if(!a||!a.last4) return false; const digits=String(rawAndNote).replace(/[^0-9]/g,' '); const tails=String(rawAndNote).match(/\/\s*\*{0,4}(\d{3})\b/g)||[]; return new RegExp('\\d*'+a.last4+'\\b').test(digits)||tails.some(t=>t.replace(/\D/g,'')===a.last4.slice(-3)); }
/* an account has just been created with its number: every row already in the book whose bank line names that
   number was a movement to or from it, recorded as spending or income only because it did not exist yet */
function rebookByNumber(a){
  let n=0; if(!a||!a.last4) return 0;
  S.transactions.forEach(t=>{
    if(t.type!=='out'&&t.type!=='in') return; if(t.accountId===a.id) return;
    const bh=t.bankHint||bankHint(t.note||'')&&bankHint(t.note||'').kind; if(!(bh==='card'||bh==='internal'||bh==='loan'||bh==='cardpay')) return;
    if(!lineNamesAccount((t.raw||'')+' '+(t.note||''),a)) return;
    const other=t.accountId; if(!acct(other)) return;
    if(t.reversalOf||t.reversedBy) unlinkReversal(t);
    const wasOut=t.type==='out'; delete t.accountId; delete t.categoryId; delete t.catSource; delete t.ruleId; delete t.bankHint;
    t.type='transfer'; t.fromId=wasOut?other:a.id; t.toId=wasOut?a.id:other; t.updatedAt=Date.now(); t.rebooked='number';
    if(isInstallmentLoan(a)&&t.toId===a.id) t.alloc={principal:0,extra:0,interest:0,tax:0,insurance:0,fee:0,escrow:0,escrowId:'',status:'pending',source:''};
    n++;
  });
  if(n){ recalcBalances(); dlog('rows re-booked as transfers by account number',{account:a.name,count:n}); }
  return n;
}
function numberedAccount(r,into){
  if(!r) return null; const digits=String((r.raw||'')+' '+(r.note||'')).replace(/[^0-9]/g,' ');
  const tails=String((r.raw||'')+' '+(r.note||'')).match(/\/\s*\*{0,4}(\d{3})\b/g)||[];
  const hit=S.accounts.filter(a=>a.id!==into&&a.last4&&(new RegExp('\\d*'+a.last4+'\\b').test(digits)||tails.some(t=>t.replace(/\D/g,'')===a.last4.slice(-3))));
  return hit.length===1?hit[0]:null;
}
function transferTargets(r){
  const into=($('#shotAcct')||{}).value||'';
  const na=numberedAccount(r,into); const withNum=list=>na&&!list.some(a=>a.id===na.id)?list.concat([na]):list;
  return withNum(transferPool(r,into));
}
function transferPool(r,into){
  const cash=S.accounts.filter(a=>a.id!==into&&a.kind!=='liability'&&/\bcash\b|wallet|petty/i.test(a.name));
  const debts=S.accounts.filter(a=>a.id!==into&&a.kind==='liability');
  if(r&&r.bankHint==='card') return debts.filter(a=>!a.acctType||a.acctType==='credit card'||a.acctType==='line of credit');
  if(r&&(r.bankHint==='loan'||r.bankHint==='installment')) return debts.filter(a=>!a.acctType||isInstallmentLoan(a)||a.acctType==='line of credit');
  if(r&&r.bankHint==='internal') return S.accounts.filter(a=>a.id!==into&&a.kind!=='liability');
  if(r.categoryId==='c23') return cash;
  if(r.categoryId==='c21'||r.categoryId==='c31') return debts;
  return [];
}
/* card payments left as plain money-in on the card: the balance is right, but the paying account is not reduced */
/* a review row that reads as a transfer between `into` and another account: is that movement already in the book
   (recorded from the other side, or re-booked when that account was created)? same ends, same amount, within 3 days */
function twinTransfer(r,into){
  if(!r||!/^xfer/.test(r.type)||!into) return null; const other=r.type.replace(/^xferin:|^xfer:/,''); if(!other) return null;
  const from=/^xfer:/.test(r.type)?into:other, to=/^xfer:/.test(r.type)?other:into;
  const near3=t=>Math.abs((new Date(t.date+'T12:00:00')-new Date(r.date+'T12:00:00'))/864e5)<=3&&Math.abs(Number(t.amount)-r.amount)<0.005;
  /* a twin is the SAME movement seen from the other side — never a different movement from the same statement
     (two genuine $200 payments days apart share a source; they are both real) */
  return S.transactions.find(t=>t.type==='transfer'&&t.fromId===from&&t.toId===to&&near3(t)&&(!t.src2||t.src2!==r.src)&&!(t.src&&r.src&&t.src===r.src))||null;
}
function unsourcedPayments(){ return (revRows||[]).filter(r=>r.on&&r.payIn&&r.type==='in'); }
/* the statement says one kind of thing, the chosen account is filed as the other: a line-of-credit statement into an
   untyped account that has been sitting with the assets. Filing it would flip every row's meaning, so this blocks. */
/* leaving a statement review without committing: nothing it staged or changed survives */
function discardReview(){
  if(!$('#shotAcct')) return;   /* not the import dialog */
  const had=!!stagedAccount||reviewDirty; stagedAccount=null;
  if(reviewDirty&&reviewSnap){ try{ S=freshState(); healState(JSON.parse(reviewSnap)); recalcBalances(); }catch(e){} }
  reviewDirty=false; if(had){ dlog('statement review discarded',{}); render(); }
}
function shotKindClash(){
  const a=acct(($('#shotAcct')||{}).value||''), h=shotHint; if(!a||!h) return null;
  const type=hintType(h); if(!type||!acctTypeInfo(type)) return null;
  if(typeKind(type)===a.kind) return null;
  if(a.acctType&&acctTypeInfo(a.acctType)) return {text:'This statement is for '+acctTypeInfo(type)[1].replace(/ \(.*\)$/,'').toLowerCase()+' — but '+a.name+' is filed as '+acctTypeLabel(a).toLowerCase()+'. Choose a different account or create one.',type:type,label:acctTypeInfo(type)[1].replace(/ \(.*\)$/,''),kind:typeKind(type),fixable:false};
  return {text:'This statement is for a '+acctTypeInfo(type)[1].replace(/ \(.*\)$/,'').toLowerCase()+' (money you owe), but '+a.name+' has no type and sits with what you own. Set its type first — charges and payments mean the opposite on a debt.',type:type,label:acctTypeInfo(type)[1].replace(/ \(.*\)$/,''),kind:typeKind(type),fixable:true};
}
function shotSetTypeFromHint(){
  const c=shotKindClash(); const a=acct(($('#shotAcct')||{}).value||''); if(!c||!a||!c.fixable) return;
  a.acctType=c.type; a.kind=c.kind; anchorOf(a); recalcBalances(); reviewDirty=true;
  dlog('account typed from a statement (applied at commit)',{account:a.name,type:c.type});
  applyAccountSemantics(); renderReview(); renderHint(); refreshCommitGate(); toast(a.name+' reads as '+c.label.toLowerCase()+' — a debt; the change is kept when you add to ledger');
}
function paymentSources(r){ const into=acct(($('#shotAcct')||{}).value||''); const na=numberedAccount(r,into?into.id:''); const base=(!into||into.kind!=='liability')?[]:S.accounts.filter(a=>a.id!==into.id&&a.kind!=='liability'); return na&&!base.some(a=>a.id===na.id)?base.concat([na]):base; }
function readReviewRows(){
  const rows=[];
  document.querySelectorAll('.rev[data-r]').forEach(el=>{
    const g=f=>el.querySelector('[data-f="'+f+'"]');
    const orig=revRows[+el.dataset.r]||{};
    rows.push({on:g('on').checked,date:g('date').value,note:g('note').value.trim(),amount:Math.abs(parseFloat(g('amount').value)||0),type:g('type').value,categoryId:g('categoryId').value,changedCat:orig.categoryId&&g('categoryId').value!==orig.categoryId,ruleId:orig.ruleId||'',payIn:!!orig.payIn,twinId:orig.twinId||'',byNumber:orig.byNumber||'',dup:orig.dup||'',dupOfId:orig.dupOf&&orig.dupOf.id||'',raw:orig.raw||'',ref:orig.ref||'',src:orig.src||'',fx:orig.fx||null});
  });
  return rows;
}
/* ONE atomic operation: the staged account, its opening and since, every ticked row, the closing checkpoint, the
   twin/re-booking links, then the save. If any step fails — including the save itself — the book is put back
   exactly as it was and the review stays open. */
async function commitShots(){
  if(shotBusy) return;
  const rows=readReviewRows().filter(r=>r.on&&r.amount>0&&/^\d{4}-\d{2}-\d{2}$/.test(r.date));
  if(!rows.length&&!(stagedAccount&&($('#shotAcct')||{}).value===stagedAccount.id)){ toast('Nothing ticked to add'); return; }
  const acctId=($('#shotAcct')||{}).value||''; let target=acct(acctId);
  if(!target){ toast('Choose which account these belong to, or create it, first'); const hb=$('#shotHint'); if(hb&&hb.scrollIntoView) hb.scrollIntoView(); return; }
  const setBal=!!(shotHint&&shotHint.balance!==null&&($('#shotSetBal')||{}).checked);
  const adjust=!!($('#shotBalances')||{}).checked;
  const snap=JSON.stringify(S), stagedWas=stagedAccount; shotBusy=true;
  const fail=where=>{ if(where&&commitFailAt===where) throw new Error('injected failure at '+where); };
  let nTx=0,nBill=0,proposeFor=null,rev={linked:[],review:[]}; const addedTx=[]; const fixes={};
  const memberId=(()=>{ const v=($('#shotUser')||{}).value||''; return S.users.some(u=>u.id===v)?v:''; })();
  try{
  markUndo();
  if(target.staged){ fail('account'); S.accounts.push(target); stagedAccount=null; rebookByNumber(target); target=acct(target.id); }
  if(target&&shotHint&&shotHint.last4&&!target.last4) target.last4=shotHint.last4;
  if(target&&shotHint&&shotHint.institution&&!target.institution) target.institution=shotHint.institution;
  /* an older statement than the account knew about: the account existed from that statement's start, and its
     opening balance is that statement's opening — provided no checkpoint already sits before that date */
  if(target&&shotHint&&shotHint.period&&/^\d{4}-\d{2}-\d{2}$/.test(shotHint.period.from||'')){
    const from=shotHint.period.from; anchorOf(target);
    const firstCp=target.checkpoints.length?target.checkpoints[0].date:'';
    if((!target.since||from<target.since)&&(!firstCp||from<=firstCp)){
      const was=target.since; target.since=from;
      if(isFinite(shotHint.opening)&&shotHint.opening!==null){ target.opening={balance:r2(target.kind==='liability'?Math.abs(Number(shotHint.opening)):Number(shotHint.opening)),source:'statement',at:Date.now()}; }
      dlog('account start moved back to an older statement',{account:target.name,from:was||'(none)',to:from,opening:target.opening.balance});
    }
    /* the account already existed before this period: the statement's opening balance is the bank's own figure
       for the day before the period began — a checkpoint there, so the period's history starts from truth */
    else if(setBal&&isFinite(shotHint.opening)&&shotHint.opening!==null&&target.since&&target.since<from){
      const dayBefore=(()=>{ const d=new Date(from+'T12:00:00'); d.setDate(d.getDate()-1); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); })();
      if(!target.checkpoints.some(c=>c.date>=dayBefore&&c.date<from)){ setCheckpoint(target,dayBefore,Math.abs(Number(shotHint.opening))); }
    }
  }
  /* categories the user corrected in the review list: offer to remember them afterwards, never silently */
  rows.filter(r=>r.changedCat&&r.type!=='bill'&&r.note).forEach(r=>{ const m=merchantGuess(r.note); if(m&&m.length>=3&&!fixes[normText(m)]) fixes[normText(m)]={match:m,categoryId:r.categoryId}; });
  /* a payment already recorded from the paying side: remember this statement's line on it, so the next import of
     this statement recognises it as definite */
  readReviewRows().filter(r=>!r.on&&r.twinId).forEach(r=>{ const t=txById(r.twinId); if(t&&!t.src2){ t.src2=r.src||''; t.raw2=r.raw||r.note; } });
  /* a definite duplicate that now reads as a transfer (the other account exists now): the stored plain row becomes that transfer */
  readReviewRows().filter(r=>!r.on&&r.dup==='definite'&&/^xfer/.test(r.type)&&r.dupOfId).forEach(r=>{ const t=txById(r.dupOfId); const other=r.type.replace(/^xferin:|^xfer:/,''); if(!t||t.type==='transfer'||!acct(other)||t.accountId!==acctId) return;
    if(t.reversalOf||t.reversedBy) unlinkReversal(t); const wasOut=t.type==='out'; delete t.accountId; delete t.categoryId; delete t.catSource; delete t.ruleId; delete t.bankHint; t.type='transfer'; t.fromId=wasOut?acctId:other; t.toId=wasOut?other:acctId; t.updatedAt=Date.now(); t.rebooked='reimport';
    if(isInstallmentLoan(acct(t.toId))) t.alloc=t.alloc||{principal:0,extra:0,interest:0,tax:0,insurance:0,fee:0,escrow:0,escrowId:'',status:'pending',source:''}; dlog('stored row re-booked as a transfer on re-import',{id:t.id}); });
  rows.forEach(r=>{
    if(r.type==='bill'){
      const c=S.categories.find(x=>x.id===r.categoryId)||S.categories.find(x=>x.type==='out');
      S.planned.push({id:uid(),name:r.note||'Bill',amount:r.amount,date:r.date,categoryId:c?c.id:''}); nBill++; return;
    }
    /* re-booking at commit may just have created the other side of this very movement: never twice */
    if(/^xfer/.test(r.type)){ const tw=twinTransfer(r,acctId); if(tw){ if(!tw.src2){ tw.src2=r.src||''; tw.raw2=r.raw||r.note; } return; } }
    if(/^xfer:/.test(r.type)){
      const toId=r.type.slice(5); if(!acct(toId)) return;
      /* the card side may already hold this payment as money in with no source: that row BECOMES the transfer */
      const twin=S.transactions.find(t=>t.type==='in'&&t.bankHint==='cardpay'&&t.accountId===toId&&Math.abs(Number(t.amount)-r.amount)<0.005&&Math.abs((new Date(t.date+'T12:00:00')-new Date(r.date+'T12:00:00'))/864e5)<=3);
      if(twin){ delete twin.accountId; delete twin.categoryId; delete twin.catSource; twin.type='transfer'; twin.fromId=acctId; twin.toId=toId; twin.src2=r.src||''; twin.raw2=r.raw||r.note; twin.updatedAt=Date.now(); delete twin.bankHint; addedTx.push(twin); nTx++; dlog('card payment matched to its source',{id:twin.id,from:acctId}); return; }
      const tt={id:uid(),date:r.date,amount:r.amount,type:'transfer',fromId:acctId,toId:toId,note:r.note,source:shots.length?'scan':'paste',raw:r.raw||r.note,src:r.src||'',...(r.ref?{ref:r.ref}:{}),createdAt:Date.now()};
      /* a bank statement never says how much of a loan payment was principal — so Ledger does not pretend */
      if(isInstallmentLoan(acct(toId))) tt.alloc={principal:0,extra:0,interest:0,tax:0,insurance:0,fee:0,escrow:0,escrowId:'',status:'pending',source:''};
      S.transactions.push(tt); addedTx.push(tt); nTx++; return;
    }
    if(/^xferin:/.test(r.type)){
      const fromId=r.type.slice(7); if(!acct(fromId)) return;
      const tt={id:uid(),date:r.date,amount:r.amount,type:'transfer',fromId:fromId,toId:acctId,note:r.note,source:shots.length?'scan':'paste',raw:r.raw||r.note,src:r.src||'',...(r.ref?{ref:r.ref}:{}),createdAt:Date.now()};
      S.transactions.push(tt); addedTx.push(tt); nTx++; return;
    }
    fail(nTx===0?'row:first':(nTx===Math.floor(rows.length/2)?'row:middle':(nTx===rows.length-1?'row:last':'')));
    const c=S.categories.find(x=>x.id===r.categoryId)||S.categories.find(x=>x.type===r.type);
    const t={id:uid(),date:r.date,amount:r.amount,type:r.type,categoryId:c?c.id:'',accountId:acctId,note:r.note,catSource:r.changedCat?'manual':'import'};
    const rr=matchRule(t.note,acctId); if(rr&&rr.categoryId===t.categoryId&&!r.changedCat){ t.catSource='rule'; t.ruleId=rr.id; }
    t.source=shots.length?'scan':'paste'; t.raw=r.raw||r.note; t.src=r.src||''; if(r.ref) t.ref=r.ref; if(r.fx) t.fx=r.fx; t.createdAt=Date.now(); if(r.ruleId) t.ruleId=r.ruleId;
    if(memberId) t.userId=memberId;
    if(r.payIn&&t.type==='in'){
      /* re-booking at this very commit may have created the transfer this payment line describes */
      const tw=S.transactions.find(x=>x.type==='transfer'&&x.toId===acctId&&!x.src2&&Math.abs(Number(x.amount)-t.amount)<0.005&&Math.abs((new Date(x.date+'T12:00:00')-new Date(t.date+'T12:00:00'))/864e5)<=3&&!(x.src&&t.src&&x.src===t.src));
      if(tw){ tw.src2=t.src||''; tw.raw2=t.raw||t.note; return; }
      t.bankHint='cardpay';   /* money into a debt from an untracked source: not income */
    }
    S.transactions.push(t); addedTx.push(t); nTx++;
  });
  /* a reclaim that says so, with exactly one outgoing row that fits, is linked to it; anything less stays for you to decide */
  rev=autoLinkReversals(addedTx);
  rev.review.forEach(x=>dlog('reversal left for review',{id:x.t.id,fits:x.fits}));
  /* a statement's closing balance is authoritative for its date: checkpoint there, and rows on/before it are already inside it */
  if(setBal&&target){ fail('checkpoint'); const sd=statementDate(rows); setCheckpoint(target,sd,Math.abs(shotHint.balance)); if(isInstallmentLoan(target)) proposeFor=sd;
    if(target.acctType==='investment'&&target.valued!=='checkpoints') target.valued='checkpoints'; }
  else if(!adjust) absorbIntoAnchors(addedTx);
  /* show the month the statement really covers: the latest month with more than a stray row */
  const perMonth={}; rows.filter(r=>r.type!=='bill').forEach(r=>{ const k=r.date.slice(0,7); perMonth[k]=(perMonth[k]||0)+1; });
  const months=Object.keys(perMonth).sort(); const solid=months.filter(k=>perMonth[k]>=2);
  if(months.length&&months.indexOf(ui.month)<0) ui.month=(solid.length?solid:months).pop();
  const saved=await saveNow(); if(!saved) throw new Error(staleTab?'another tab saved newer changes':'the book could not be saved');
  }catch(e){
    /* roll back: the book exactly as it was, the review still open with its staged account */
    S=freshState(); healState(JSON.parse(snap)); recalcBalances(); stagedAccount=stagedWas; shotBusy=false;
    dlog('import commit rolled back',{error:errStr(e)}); render(); refreshCommitGate();
    toast('Nothing was added — '+errStr(e).replace(/^Error: /,'')+'. The book is exactly as it was.'); return;
  }
  if(target&&target.staged) delete target.staged;
  shotBusy=false; reviewDirty=false; stagedAccount=null; closeModal(); render();
  const parts=[]; if(nTx) parts.push(nTx+' transaction'+(nTx===1?'':'s')); if(nBill) parts.push(nBill+' upcoming bill'+(nBill===1?'':'s')+' on the calendar');
  if(rev.linked.length) parts.push(rev.linked.length+' reversal'+(rev.linked.length===1?'':'s')+' linked (not income, original not spending)'); if(rev.review.length) parts.push(rev.review.length+' possible reversal'+(rev.review.length===1?'':'s')+' to check');
  const sg=detectRecurring().length;
  dlog('import committed',{source:importTrace&&importTrace.source,transactions:nTx,bills:nBill,account:acctId});
  const dts=rows.filter(r=>r.type!=='bill').map(r=>r.date).sort();
  if(dts.length&&dts[0].slice(0,7)!==dts[dts.length-1].slice(0,7)) parts.push('spanning '+monthName(dts[0].slice(0,7),true)+' – '+monthName(dts[dts.length-1].slice(0,7),true)+' (now showing '+monthName(ui.month,true)+')');
  else if(dts.length) parts.push('in '+monthName(dts[0].slice(0,7),true));
  toast('Added '+parts.join(' and ')+(sg?' · '+sg+' look'+(sg===1?'s':'')+' recurring — see Recurring & memberships':''),true);
  const fixList=Object.keys(fixes).map(k=>fixes[k]);
  if(proposeFor&&maybeProposeAllocation(target,proposeFor)) return;
  if(fixList.length) rememberMerchantsModal(fixList);
}

/* ============================ live backup ============================ */
/* Two shapes: a FOLDER (preferred) gets ledger-live.json rewritten after every change plus a dated
   ledger-YYYY-MM-DD.json snapshot the first time each day (30 kept); a single FILE just gets rewritten. */
let backupHandle=null, backupKind='', backupTimer=null, backupState='off', lastLocalSave=0, lastDiskWrite=0, lastDiskError='', lastDiskVerified=false;
const LIVE_NAME='ledger-live.json', DATED_RX=/^ledger-(\d{4}-\d{2}-\d{2})\.json$/, KEEP_DATED=30;
function idb(){ return new Promise((ok,bad)=>{ const r=indexedDB.open('ledger-handles',1); r.onupgradeneeded=()=>r.result.createObjectStore('h'); r.onsuccess=()=>ok(r.result); r.onerror=()=>bad(r.error); }); }
async function idbGet(k){ try{ const db=await idb(); return await new Promise((ok,bad)=>{ const t=db.transaction('h').objectStore('h').get(k); t.onsuccess=()=>ok(t.result); t.onerror=()=>bad(t.error); }); }catch(e){ return null; } }
async function idbSet(k,v){ try{ const db=await idb(); await new Promise((ok,bad)=>{ const t=db.transaction('h','readwrite').objectStore('h').put(v,k); t.onsuccess=ok; t.onerror=()=>bad(t.error); }); }catch(e){} }
async function idbDel(k){ try{ const db=await idb(); await new Promise((ok,bad)=>{ const t=db.transaction('h','readwrite').objectStore('h').delete(k); t.onsuccess=ok; t.onerror=()=>bad(t.error); }); }catch(e){} }
function canLiveBackup(){ return typeof window.showSaveFilePicker==='function'; }
function canFolderBackup(){ return typeof window.showDirectoryPicker==='function'; }
function clock(ts){ return ts?new Date(ts).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'—'; }
function backupName(){ return backupHandle?backupHandle.name:''; }
async function restoreBackupHandle(){
  if(!canLiveBackup()) return;
  const h=await idbGet('backup'); if(!h) return;
  backupHandle=h; backupKind=h.kind==='directory'?'dir':'file';
  try{ backupState=(await h.queryPermission({mode:'readwrite'}))==='granted'?'on':'ask'; }catch(e){ backupState='ask'; }
  if(backupState==='on') await writeBackupFile();
  updateSaveStat();
}
async function linkBackupFolder(){
  if(!canFolderBackup()){ toast('This browser cannot write to a folder — choose a single file instead'); return; }
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite',id:'ledger-backup',startIn:'documents'});
    backupHandle=h; backupKind='dir'; backupState='on'; lastDiskError=''; await idbSet('backup',h);
    await writeBackupFile(); save(); render(); refreshSettings();
    toast(lastDiskError?'Could not write to that folder':'Live backup on — writing '+LIVE_NAME+' and dated copies into '+h.name);
  }catch(e){ if(e&&e.name!=='AbortError'){ lastDiskError=errStr(e); toast('Could not set up the backup folder — '+errStr(e)); refreshSettings(); } }
}
async function linkBackupFile(){
  if(!canLiveBackup()){ toast('This browser cannot keep a live file — use Back up everything instead'); return; }
  try{
    const h=await window.showSaveFilePicker({suggestedName:'ledger-backup.json',types:[{description:'Ledger backup',accept:{'application/json':['.json']}}]});
    backupHandle=h; backupKind='file'; backupState='on'; lastDiskError=''; await idbSet('backup',h);
    await writeBackupFile(); save(); render(); refreshSettings();
    toast('Live backup on — every change is written to '+h.name);
  }catch(e){ if(e&&e.name!=='AbortError'){ lastDiskError=errStr(e); toast('Could not set up the backup file — '+errStr(e)); refreshSettings(); } }
}
async function reconnectBackup(){
  if(!backupHandle) return;
  try{ const p=await backupHandle.requestPermission({mode:'readwrite'}); if(p==='granted'){ backupState='on'; lastDiskError=''; await writeBackupFile(); render(); refreshSettings(); toast('Live backup reconnected'); } }
  catch(e){ toast('Could not reconnect the backup'); }
}
async function unlinkBackup(){ backupHandle=null; backupKind=''; backupState='off'; lastDiskWrite=0; lastDiskVerified=false; lastDiskError=''; backupDiag=null; await idbDel('backup'); render(); refreshSettings(); toast('Live backup off'); }
async function writeText(fileHandle,text){ const w=await fileHandle.createWritable(); await w.write(text); await w.close(); }
/* on the switch to (or a rotation of) encryption, every dated snapshot in the backup folder is rewritten sealed: a
   plain copy of the book must not sit next to the encrypted one. Files copied elsewhere earlier stay as they were. */
async function resealBackups(){
  scheduleBackupWrite();
  if(!backupHandle||backupKind!=='dir'||backupState!=='on'||!vaultKey) return;
  try{ const text=await sealState(1); for await (const [name,h] of backupHandle.entries()){ if(h.kind==='file'&&DATED_RX.test(name)) await writeText(await backupHandle.getFileHandle(name),text); } dlog('dated backups resealed',{}); }
  catch(e){ dlog('reseal failed',{error:errStr(e)}); }
}
async function writeBackupFile(){
  if(!backupHandle||backupState!=='on') return;
  if(lockWiped||isLocked||bootCorrupt) return;   /* the book is not in memory: there is nothing true to write */
  const text=await sealState(1);
  try{
    if(backupKind==='dir'){
      await writeText(await backupHandle.getFileHandle(LIVE_NAME,{create:true}),text);
      const dated='ledger-'+todayISO()+'.json';
      let exists=true; try{ await backupHandle.getFileHandle(dated); }catch(e){ exists=false; }
      if(!exists){ await writeText(await backupHandle.getFileHandle(dated,{create:true}),text); pruneDated(); }
    }else{
      await writeText(backupHandle,text);
    }
    /* read it back — a write that cannot be read is not a backup */
    const fh=backupKind==='dir'?await backupHandle.getFileHandle(LIVE_NAME):backupHandle;
    const back=await (await fh.getFile()).text();
    if(back!==text) throw Object.assign(new Error('read-back did not match what was written ('+back.length+' vs '+text.length+' chars)'),{name:'VerifyError'});
    lastDiskWrite=Date.now(); lastDiskError=''; lastDiskVerified=true; S.settings.lastBackup=lastDiskWrite; dlog('backup succeeded',{kind:backupKind,bytes:text.length});
  }catch(e){ console.error('Backup write failed',e); lastDiskVerified=false; lastDiskError=errStr(e); dlog('backup failed',{error:errStr(e)}); if(e&&(e.name==='NotAllowedError'||e.name==='SecurityError')) backupState='ask'; render(); }
  updateSaveStat();
}
function errStr(e){ if(!e) return 'unknown error'; return (e.name?e.name+': ':'')+(e.message||String(e)); }
/* ---- self-test: every step reported, nothing assumed ---- */
let backupDiag=null;
async function backupSelfTest(){
  const steps=[]; const step=(name,ok,detail)=>{ steps.push({name:name,ok:ok,detail:detail||''}); };
  const ua=(navigator.userAgentData&&navigator.userAgentData.brands||[]).map(b=>b.brand+' '+b.version).join(', ')||navigator.userAgent;
  step('Page origin',true,location.protocol+'//'+(location.host||'(local file)'));
  step('Secure context',!!window.isSecureContext,window.isSecureContext?'yes — file:// and localhost both count':'NO — the File System Access API is only exposed in secure contexts');
  step('Browser',true,ua);
  step('showDirectoryPicker available',canFolderBackup(),canFolderBackup()?'yes':'missing — this browser (or this origin) does not expose the folder API');
  step('showSaveFilePicker available',canLiveBackup(),canLiveBackup()?'yes':'missing');
  step('IndexedDB (remembers the folder between visits)',true,window.indexedDB?'yes':'missing — backups still work, but you would have to re-pick the folder every visit');
  if(!backupHandle){ step('Folder or file selected',false,'nothing chosen yet — use “Choose a backup folder” first'); backupDiag={when:Date.now(),steps:steps,ok:false}; refreshSettings(); return; }
  step('Folder or file selected',true,(backupKind==='dir'?'folder ':'file ')+backupName());
  let perm='unknown';
  try{ perm=await backupHandle.queryPermission({mode:'readwrite'}); }catch(e){ step('Query write permission',false,errStr(e)); }
  if(perm!=='granted'){
    step('Query write permission',false,'state is “'+perm+'” — asking now');
    try{ perm=await backupHandle.requestPermission({mode:'readwrite'}); }catch(e){ step('Request write permission',false,errStr(e)); }
    step('Request write permission',perm==='granted',perm==='granted'?'granted':'state is “'+perm+'” — Chrome did not grant write access');
  }else step('Write permission',true,'granted');
  if(perm!=='granted'){ backupState='ask'; backupDiag={when:Date.now(),steps:steps,ok:false}; render(); refreshSettings(); return; }
  backupState='on';
  const marker={ledgerSelfTest:true,at:new Date().toISOString(),random:Math.random()};
  const text=JSON.stringify(marker);
  let fh=null;
  try{
    fh=backupKind==='dir'?await backupHandle.getFileHandle('ledger-selftest.json',{create:true}):backupHandle;
    step(backupKind==='dir'?'Create test file (ledger-selftest.json)':'Open backup file',true,fh.name);
  }catch(e){ step('Create test file',false,errStr(e)); }
  if(fh){
    try{ const w=await fh.createWritable(); await w.write(text); await w.close(); step('Write test JSON',true,text.length+' bytes'); }
    catch(e){ step('Write test JSON',false,errStr(e)); }
    try{
      const f=await fh.getFile(); const back=await f.text();
      const ok=back===text; step('Read it back and compare',ok,ok?'identical, '+f.size+' bytes on disk, modified '+new Date(f.lastModified).toLocaleTimeString():'mismatch — got '+back.length+' bytes');
    }catch(e){ step('Read it back and compare',false,errStr(e)); }
    if(backupKind==='dir'){
      try{ await backupHandle.getFileHandle('ledger-selftest.json'); step('File exists in folder listing',true,'yes'); }catch(e){ step('File exists in folder listing',false,errStr(e)); }
      try{ await backupHandle.removeEntry('ledger-selftest.json'); step('Delete test file',true,'cleaned up'); }catch(e){ step('Delete test file',false,errStr(e)); }
    }
  }
  /* now the real thing */
  await writeBackupFile();
  step('Write real backup ('+(backupKind==='dir'?LIVE_NAME:backupName())+') and read it back',lastDiskVerified&&!lastDiskError,lastDiskError||('verified · '+new Date(lastDiskWrite).toLocaleTimeString()));
  if(backupKind==='dir'){ try{ await backupHandle.getFileHandle('ledger-'+todayISO()+'.json'); step('Dated copy for today exists',true,'ledger-'+todayISO()+'.json'); }catch(e){ step('Dated copy for today exists',false,errStr(e)); } }
  const allOk=steps.every(x=>x.ok);
  backupDiag={when:Date.now(),steps:steps,ok:allOk}; dlog('backup self-test',{ok:allOk,failed:steps.filter(x=>!x.ok).map(x=>x.name)});
  render(); refreshSettings();
  toast(allOk?'Backup test passed — everything written and read back':'Backup test found a problem — see Settings › Data');
}
function validateBackupShape(d){
  const problems=[];
  if(!d||typeof d!=='object') return ['not an object'];
  ['accounts','transactions','categories','recurring','goals','rules','closes'].forEach(k=>{ if(k in d&&!Array.isArray(d[k])) problems.push(k+' is not a list'); });
  if(!d.settings||typeof d.settings!=='object') problems.push('settings missing');
  if(Array.isArray(d.transactions)) d.transactions.forEach((t,i)=>{ if(!t||!t.id||!/^\d{4}-\d{2}-\d{2}$/.test(t.date||'')||!(Number(t.amount)>=0)) problems.push('transaction #'+(i+1)+' malformed'); });
  if(Array.isArray(d.accounts)) d.accounts.forEach((a,i)=>{
    if(!a||!a.id||!a.name){ problems.push('account #'+(i+1)+' malformed'); return; }
    if(a.acctType&&!ACCT_TYPES.some(t=>t[0]===a.acctType)&&a.acctType!=='loan') problems.push(a.name+': unknown account type “'+a.acctType+'”');
    if(a.secures&&!Array.isArray(a.secures)) problems.push(a.name+': links are not a list');
    if(a.checkpoints&&!Array.isArray(a.checkpoints)) problems.push(a.name+': valuation history is not a list');
  });
  if(Array.isArray(d.transactions)) d.transactions.forEach((t,i)=>{ if(t&&t.alloc&&typeof t.alloc!=='object') problems.push('transaction #'+(i+1)+': loan split is malformed'); });
  return problems.slice(0,5);
}
async function fullBackupDiagnostic(){
  const steps=[]; const step=(name,ok,detail)=>steps.push({name:name,ok:ok,detail:detail||''});
  try{ const probe='__ledger_diag__'; window.localStorage.setItem(probe,'1'); const v=window.localStorage.getItem(probe); window.localStorage.removeItem(probe); step('Browser storage write',v==='1','localStorage'); }catch(e){ step('Browser storage write',false,errStr(e)); }
  try{ const raw=await store.get(KEY); step('Browser storage read',!!(raw&&raw.value),raw&&raw.value?Math.round(raw.value.length/1024)+' KB stored':'nothing stored yet'); }catch(e){ step('Browser storage read',false,'no saved ledger yet'); }
  let text=''; try{ text=JSON.stringify(S); JSON.parse(text); step('Ledger serialises and parses',true,Math.round(text.length/1024)+' KB'); }catch(e){ step('Ledger serialises and parses',false,errStr(e)); }
  const probs=validateBackupShape(JSON.parse(text||'{}')); step('Schema validation',!probs.length,probs.join('; ')||'accounts, transactions, categories, recurring, goals, rules, closes all well-formed');
  try{ const saved=S; const clone=JSON.parse(text); S=freshState(); healState(clone); const ok=S.transactions.length===saved.transactions.length&&S.accounts.length===saved.accounts.length&&S.accounts.every((a,i)=>Math.abs(derivedBalance(a)-derivedBalance(saved.accounts[i]))<0.005); S=saved; recalcBalances(); step('Restore compatibility (dry run)',ok,ok?'a restore of this backup reproduces every balance':'a restore would differ — export the debug log'); }catch(e){ step('Restore compatibility (dry run)',false,errStr(e)); }
  if(!backupHandle){ step('Backup folder / file',false,'none chosen'); return steps; }
  await backupSelfTest();
  (backupDiag?backupDiag.steps:[]).forEach(x=>steps.push(x));
  return steps;
}
function diagHTML(){
  if(!backupDiag) return '';
  return `<div class="tbl" style="margin:10px 0">
    ${backupDiag.steps.map(x=>`<div class="trow" style="padding:7px 12px"><span><span style="color:${x.ok?'var(--in)':'var(--out)'};font-weight:700;margin-right:8px">${x.ok?'✓':'✗'}</span>${esc(x.name)}</span><span class="num muted" style="max-width:60%;white-space:normal;word-break:break-word">${esc(x.detail)}</span></div>`).join('')}
    <div class="trow muted" style="font-size:12px;padding:7px 12px">Tested ${new Date(backupDiag.when).toLocaleString()} · ${backupDiag.ok?'<b style="color:var(--in)">all steps passed</b>':'<b style="color:var(--out)">something failed above</b>'}</div>
  </div>`;
}
async function pruneDated(){
  try{
    const names=[]; for await (const [name,h] of backupHandle.entries()){ if(h.kind==='file'&&DATED_RX.test(name)) names.push(name); }
    names.sort(); while(names.length>KEEP_DATED){ const n=names.shift(); await backupHandle.removeEntry(n); }
  }catch(e){ /* pruning is best-effort */ }
}
function scheduleBackupWrite(){ if(backupState!=='on') return; clearTimeout(backupTimer); backupTimer=setTimeout(writeBackupFile,1200); }
/* the little dot in the header: where the data is right now */
let saveBroken='';
function updateSaveStat(){
  const el=document.getElementById('saveStat'); if(!el) return;
  let cls='ok', txt='';
  if(STORAGE_WHERE==='memory'){ cls='bad'; txt='not saving'; }
  else if(bootCorrupt){ cls='bad'; txt='NOT saving — the saved book is damaged'; }
  else if(saveBroken){ cls='bad'; txt='NOT saved — '+esc(saveBroken); }
  else if(staleTab){ cls='bad'; txt='NOT saved — another tab is newer'; }
  else{
    txt='saved '+clock(lastLocalSave||S.settings.lastLocalSave||0);
    if(backupState==='on'){
      if(lastDiskError){ cls='bad'; txt+=' <span class="long">· disk write failed</span>'; }
      else if(lastDiskVerified){ txt+=' <span class="long">· disk '+clock(lastDiskWrite)+' ✓</span>'; }
      else { cls='warn'; txt+=' <span class="long">· disk not yet verified</span>'; }
    }
    else if(backupState==='ask'){ cls='warn'; txt+=' <span class="long">· backup paused</span>'; }
    else if(S.transactions.some(t=>t.source!=='sample')){ cls='warn'; txt+=' <span class="long">· backup not set up</span>'; }
  }
  el.className='savestat '+cls; el.innerHTML='<i></i>'+txt;
}

/* copy transactions out as text you can paste anywhere */
