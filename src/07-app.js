/* Ledger — part 7 of 7: combining books, events, test hook, boot.
   The parts load in order as plain scripts and share one scope; tools/build.js joins them back into
   one closure for the shareable single file. Keep load-time code in the part that defines what it uses. */
"use strict";

/* ============================ combining two books ============================
   Two people, two computers, no server: each keeps their own Ledger and now and then one COMBINES the
   other's backup or saved copy into theirs. Nothing is replaced. Rows are matched by id, then by the
   bank line they came from (same statement imported on both sides is not two rows); people, accounts and
   categories are matched by id, then by name. Newer edits win on the same row. Planned as a pure step,
   rehearsed on a scratch state, shown as a report, applied only on a click, undoable. */
function extractBookText(text){
  const t=String(text||'').trim();
  if(/^</.test(t)&&/id="ledger-data"/.test(t)){
    /* the app's own source also contains this tag text: take the last block that actually parses as a book */
    const all=[...t.matchAll(/<script type="application\/json" id="ledger-data">([\s\S]*?)<\/script>/g)];
    for(let i=all.length-1;i>=0;i--){ const d=safeParse(all[i][1].replace(/<\\\//g,'</')); if(d&&(d.state||d.sealed)) return d.state?JSON.stringify(d.state):JSON.stringify(d.sealed); }
    return '';
  }
  return t;
}
function normName(s){ return normText(s).replace(/[^a-z0-9]+/g,' ').trim(); }
function mergePlan(local,other){
  const out=clone(local); const rep={txAdded:0,txUpdated:0,txDuplicate:0,txDropped:0,users:0,usersDropped:0,tagsLost:0,accounts:0,categories:0,rules:0,recurring:0,goals:0,planned:0,budgets:0,linksDropped:0,notCarried:[]};
  const userMap={}, acctMap={}, catMap={}, recurMap={}, txMap={};
  (other.users||[]).forEach(u=>{ if(!u||!u.id) return; const byId=out.users.find(x=>x.id===u.id); if(byId){ userMap[u.id]=u.id; return; }
    const byName=out.users.find(x=>normName(x.name)&&normName(x.name)===normName(u.name)); if(byName){ userMap[u.id]=byName.id; return; }
    if(out.users.length<MAX_USERS){ out.users.push(clone(u)); userMap[u.id]=u.id; rep.users++; } else rep.usersDropped++; });
  const mapUser=t=>{ if(!t.userId) return; const m=userMap[t.userId]; if(m) t.userId=m; else { delete t.userId; rep.tagsLost++; } };
  (other.accounts||[]).forEach(a=>{ if(!a||!a.id) return; const byId=out.accounts.find(x=>x.id===a.id);
    /* by name only when the bank's last four digits agree too: two people's "Chequing" are two accounts */
    const same=byId||(a.last4?out.accounts.find(x=>x.last4===a.last4&&normName(x.name)===normName(a.name)):null);
    if(same){ acctMap[a.id]=same.id; (a.checkpoints||[]).forEach(c=>{ if(c&&c.date&&!(same.checkpoints||[]).some(x=>x.date===c.date)){ same.checkpoints=same.checkpoints||[]; same.checkpoints.push(clone(c)); } }); if(same.checkpoints) same.checkpoints.sort((x,y)=>x.date.localeCompare(y.date)); return; }
    const na=clone(a); if(out.accounts.some(x=>normName(x.name)===normName(a.name))) na.name=(a.name||'Account')+' (from copy)'; delete na.anchor; out.accounts.push(na); acctMap[a.id]=na.id; rep.accounts++; });
  (other.categories||[]).forEach(c=>{ if(!c||!c.id) return;
    const byId=out.categories.find(x=>x.id===c.id); if(byId&&byId.type===c.type){ catMap[c.id]=c.id; return; }   /* same id but a different kind is a repurposed category, not the same one */
    const byName=out.categories.find(x=>x.type===c.type&&normName(x.name)===normName(c.name)); if(byName){ catMap[c.id]=byName.id; return; }
    const nc=clone(c); if(byId) nc.id=uid(); out.categories.push(nc); catMap[c.id]=nc.id; rep.categories++; });
  out.accounts.forEach(a=>{ if(Array.isArray(a.secures)) a.secures=a.secures.map(id=>acctMap[id]||id).filter(id=>out.accounts.some(x=>x.id===id)); });
  const byId={}; out.transactions.forEach(t=>byId[t.id]=t);
  const bySrc={}; out.transactions.forEach(t=>{ if(t.src&&srcKey(t.raw)) bySrc[t.src+'|'+srcKey(t.raw)]=t; if(t.src2&&srcKey(t.raw2)) bySrc[t.src2+'|'+srcKey(t.raw2)]=t; });
  const stamp=t=>Number(t.updatedAt||t.createdAt||0);
  (other.transactions||[]).forEach(o=>{ if(!o||!o.id) return; const t=clone(o);
    mapUser(t);
    if(t.type==='transfer'){ t.fromId=acctMap[t.fromId]||t.fromId; t.toId=acctMap[t.toId]||t.toId; if(!out.accounts.some(x=>x.id===t.fromId)||!out.accounts.some(x=>x.id===t.toId)){ rep.txDropped++; return; } }
    else{ t.accountId=acctMap[t.accountId]||t.accountId; if(!out.accounts.some(x=>x.id===t.accountId)){ rep.txDropped++; return; } if(t.categoryId) t.categoryId=catMap[t.categoryId]||t.categoryId; }
    if(t.alloc&&t.alloc.escrowId) t.alloc.escrowId=acctMap[t.alloc.escrowId]||t.alloc.escrowId;
    if(t.recurringId) t.recurringId=recurMap[t.recurringId]||t.recurringId;
    const mine=byId[t.id];
    if(mine){ txMap[o.id]=mine.id; if(stamp(t)>stamp(mine)){ ['src','raw','src2','raw2','ref'].forEach(k=>{ if(!(k in t)&&(k in mine)) t[k]=mine[k]; });   /* provenance is what stops the same bank line arriving twice: it survives an edit */
      Object.keys(mine).forEach(k=>{ if(!(k in t)) delete mine[k]; }); Object.assign(mine,t); rep.txUpdated++; } return; }   /* the newer row replaces the older one whole: fields it dropped go too */
    const k=t.src&&srcKey(t.raw)?t.src+'|'+srcKey(t.raw):''; if(k&&bySrc[k]){ txMap[o.id]=bySrc[k].id; rep.txDuplicate++; return; }
    out.transactions.push(t); byId[t.id]=t; txMap[o.id]=t.id; if(k) bySrc[k]=t; rep.txAdded++; });
  /* reversal links follow the rows they point at — through duplicates too — and a link with no partner here is dropped, counted */
  const fresh=new Set((other.transactions||[]).map(o=>o&&o.id).filter(Boolean));
  out.transactions.forEach(t=>{ ['reversalOf','reversedBy'].forEach(key=>{ if(!t[key]) return; const target=txMap[t[key]]||t[key]; const partner=byId[target]; if(!partner){ if(fresh.has(t[key])||fresh.has(t.id)) rep.linksDropped++; delete t[key]; delete t.revSource; return; } t[key]=target; const back=key==='reversalOf'?'reversedBy':'reversalOf'; if(partner[back]!==t.id) partner[back]=t.id; }); });
  const union=(key,rep_key,eq)=>{ (other[key]||[]).forEach(x=>{ if(!x||!x.id) return; const have=out[key].find(y=>y.id===x.id||(eq&&eq(x,y))); if(have){ if(key==='recurring') recurMap[x.id]=have.id; return; } const c=clone(x); mapUser(c); if(c.accountId){ c.accountId=acctMap[c.accountId]||c.accountId; } if(c.categoryId) c.categoryId=catMap[c.categoryId]||c.categoryId; out[key].push(c); if(key==='recurring') recurMap[x.id]=c.id; rep[rep_key]++; }); };
  union('recurring','recurring',(x,y)=>normName(x.name)===normName(y.name)&&sameAmt(x.amount,y.amount));
  union('rules','rules',(x,y)=>normName(x.match)===normName(y.match)&&(catMap[x.categoryId]||x.categoryId)===y.categoryId);
  union('goals','goals',(x,y)=>normName(x.name)===normName(y.name));
  union('planned','planned',(x,y)=>x.date===y.date&&sameAmt(x.amount,y.amount)&&normName(x.name)===normName(y.name));
  /* a recurring item matched by name keeps the local id: the other side's "already booked" stamps and generated rows must follow it */
  out.transactions.forEach(t=>{ if(t.recurringId&&recurMap[t.recurringId]) t.recurringId=recurMap[t.recurringId]; });
  Object.keys(other.generated||{}).forEach(k=>{ const i=k.indexOf(':'); const id=i>0?k.slice(0,i):k; out.generated[(recurMap[id]||id)+(i>0?k.slice(i):'')]=true; });
  Object.keys(other.budgets||{}).forEach(cid=>{ const id=catMap[cid]||cid; if(!(id in out.budgets)&&Number(other.budgets[cid])>0){ out.budgets[id]=other.budgets[cid]; rep.budgets++; } });
  Object.keys(other.rates||{}).forEach(c=>{ if(!(c in out.rates)) out.rates[c]=other.rates[c]; });
  Object.keys(other.recurringIgnored||{}).forEach(k=>{ if(!(k in out.recurringIgnored)) out.recurringIgnored[k]=other.recurringIgnored[k]; });
  if((other.habits||[]).length) rep.notCarried.push('habits'); if((other.closes||[]).some(c=>c.status==='closed')) rep.notCarried.push('monthly closes');
  return {state:out,report:rep};
}
function mergeReportHTML(r){
  const li=(n,what)=>n?`<li><b>${n}</b> ${what}</li>`:'';
  const items=[li(r.txAdded,'transaction'+(r.txAdded===1?'':'s')+' added'),li(r.txUpdated,'row'+(r.txUpdated===1?'':'s')+' updated with a newer edit'),li(r.txDuplicate,'row'+(r.txDuplicate===1?'':'s')+' skipped — the same bank line is already here'),li(r.txDropped,'row'+(r.txDropped===1?'':'s')+' dropped — their account could not be matched'),li(r.users,'household member'+(r.users===1?'':'s')+' added'),li(r.usersDropped,'household member'+(r.usersDropped===1?'':'s')+' NOT brought over — this household already has '+MAX_USERS+'; '+r.tagsLost+' of their tag'+(r.tagsLost===1?'':'s')+' would be lost'),li(r.linksDropped,'reversal link'+(r.linksDropped===1?'':'s')+' dropped — the other half is not here'),li(r.checkpointGaps,'checkpoint'+(r.checkpointGaps===1?'':'s')+' no longer match the rows between them — check those accounts afterwards'),li(r.notCarried.length?1:0,'not carried over: '+r.notCarried.join(', ')),li(r.accounts,'account'+(r.accounts===1?'':'s')+' added'),li(r.categories,'categor'+(r.categories===1?'y':'ies')+' added'),li(r.rules,'rule'+(r.rules===1?'':'s')+' added'),li(r.recurring,'recurring item'+(r.recurring===1?'':'s')+' added'),li(r.goals,'goal'+(r.goals===1?'':'s')+' added'),li(r.planned,'planned bill'+(r.planned===1?'':'s')+' added'),li(r.budgets,'budget'+(r.budgets===1?'':'s')+' added')].join('');
  return items?`<ul style="margin:8px 0 0 18px;line-height:1.7">${items}</ul>`:'<p class="muted" style="margin:8px 0 0">Nothing new — the other book has nothing this one lacks.</p>';
}
async function mergeBook(text,pw){
  text=extractBookText(text); if(!text){ toast('That is not a Ledger backup or saved copy'); return; }
  let d=safeParse(text); if(!d){ toast('That is not a readable backup'); return; }
  if(isEnvelope(d)){
    try{ text=await openSealed(text,pw,false); d=JSON.parse(text); }   /* another person's book never re-keys this browser */
    catch(e){ if(e.needPass||e.wrongPass){ if(e.wrongPass) toast('Wrong passphrase for that copy'); passphrasePrompt('That copy is encrypted','Enter the passphrase it was saved with.',p=>mergeBook(text,p)); return; } toast('Could not open it: '+errStr(e)); return; }
  }
  if(!d||typeof d!=='object'||(!('transactions' in d)&&!('accounts' in d))){ toast('That file does not look like a Ledger book'); return; }
  const probs=validateBackupShape(d); if(probs.length){ toast('Copy rejected — '+probs[0]+'. Nothing was changed.'); return; }
  const live=S; let other, plan;
  try{ S=freshState(); healState(JSON.parse(text)); other=clone(S); S=live;
    plan=mergePlan(live,other);
    const gapsBefore=(integrityCheck().checks.find(c=>/Checkpoints follow/.test(c.name))||{}).status==='warn'?1:0;
    S=freshState(); healState(clone(plan.state)); recalcBalances(); const ic=integrityCheck(); S=live;
    const gapsAfter=(ic.checks.find(c=>/Checkpoints follow/.test(c.name))||{}).status==='warn'?1:0; plan.report.checkpointGaps=gapsAfter&&!gapsBefore?1:0;
    if(ic.checks.some(c=>c.status==='fail')) throw new Error('the combined book fails its own integrity check: '+ic.checks.find(c=>c.status==='fail').name);
  }catch(e){ S=live; dlog('merge rehearsal failed',{error:errStr(e)}); toast('Could not combine ('+errStr(e)+'). Nothing was changed.'); return; }
  const r=plan.report, total=r.txAdded+r.txUpdated+r.users+r.accounts+r.categories+r.rules+r.recurring+r.goals+r.planned+r.budgets;
  confirmSheet('Combine the two books?',`<div style="font-size:14px;line-height:1.6">The other book holds <b>${(other.transactions||[]).length}</b> transactions and <b>${(other.accounts||[]).length}</b> accounts. Combining it into this one would make these changes:${mergeReportHTML(r)}<p style="margin:12px 0 0" class="muted">Nothing here is replaced. You can undo afterwards.</p></div>`,
    total?'Combine':'Nothing to combine',()=>{ if(!total){ closeModal(); return; } markUndo(); S=freshState(); healState(clone(plan.state)); recalcBalances(); save(); closeModal(); render(); refreshSettingsIfOpen(); dlog('books combined',r); toast('Combined — '+r.txAdded+' added, '+r.txUpdated+' updated, '+r.txDuplicate+' already here',true); },false);
}
function mergeModal(){
  openSheet('Combine another book into this one',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:14px">
      For two people keeping separate Ledgers: bring the other person's <b>backup</b> (.json) or <b>saved copy</b> (Ledger.html with data inside) in here and the two books are combined. Nothing is replaced — rows already here stay, the same bank line is never added twice, and newer edits win. You see the changes before anything happens.
    </div>
    <label class="field"><span>Paste the backup text</span>
      <textarea id="mergePaste" rows="4" placeholder='{ "settings": … , "transactions": … }' style="font-family:var(--mono);font-size:12px;resize:vertical"></textarea></label>
    <label class="field"><span>Or choose the file</span><input type="file" accept=".json,.html,application/json,text/html" id="mergeFile"></label>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button>
     <button class="btn btn-primary" data-act="run-merge">Show what would change</button>`);
}
function runMerge(){
  const pasted=(($('#mergePaste')||{}).value||'').trim();
  if(pasted){ mergeBook(pasted); return; }
  const f=$('#mergeFile'), file=f&&f.files[0];
  if(!file){ toast('Paste a backup or choose a file'); return; }
  const fr=new FileReader(); fr.onload=()=>mergeBook(String(fr.result)); fr.onerror=()=>toast('That file could not be read'); fr.readAsText(file);
}
function restoreModal(){
  openSheet('Restore from backup',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:14px">
      Load a backup made with <b>Back up everything</b>. This <b>replaces</b> everything in this copy — accounts, transactions, budgets, habits, the lot — with what's in the file. It's how you make one copy match the other.
      <br><br>Paste the backup text, or choose the <b>.json</b> file.
    </div>
    <label class="field"><span>Paste backup here</span>
      <textarea id="jsonPaste" rows="5" placeholder='{ "settings": … , "transactions": … }' style="font-family:var(--mono);font-size:12px;resize:vertical"></textarea></label>
    <label class="field"><span>Or choose a file</span><input type="file" accept=".json,application/json" id="jsonFile"></label>
    <label class="field" style="display:flex;align-items:center;gap:9px">
      <input type="checkbox" id="jsonKeep" checked style="width:auto;margin:0">
      <span style="margin:0;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--ink);font-weight:400">Keep what the backup doesn't know about — my rules, goal dates, monthly closes and text size</span>
    </label>
    <div class="muted" style="font-size:12px;line-height:1.5;margin-top:-6px">Useful when the backup comes from an older copy of Ledger. Untick to make this copy an exact clone of the file.</div>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button>
     <button class="btn btn-danger" data-act="run-restore">Replace with this backup</button>`);
}
async function applyRestore(text,confirmed,pw){
  let d;
  try{ d=JSON.parse(text); }catch(e){ toast('That is not a readable backup file'); return; }
  if(isEnvelope(d)){   /* an encrypted backup: the key in memory opens it if the salt matches, else ask */
    /* your own backup into a fresh browser: its passphrase becomes this browser's. A browser that already has a vault keeps it and re-encrypts the restored book under its own key. */
    /* only an EMPTY, unprotected browser takes on the backup's vault (a person moving their own book) — and it is re-keyed at once,
       so whoever made the backup holds no key to what is saved here from now on. Anything else is opened, not adopted. */
    const adopt=!vaultKey&&!hasLock()&&!S.transactions.length&&!S.accounts.length;
    try{ text=await openSealed(text,pw,adopt); d=JSON.parse(text); if(adopt&&adoptOpenedVault()){ vaultPass=pw||''; pendingRekey=pw||''; } }
    catch(e){
      if(e.needPass||e.wrongPass){ if(e.wrongPass) toast('Wrong passphrase for that backup'); passphrasePrompt('This backup is encrypted','Enter the passphrase it was saved with.',p=>applyRestore(text,confirmed,p)); return; }
      toast('Could not open that backup: '+errStr(e)); return;
    }
  }
  if(!d||typeof d!=='object'||(!('transactions' in d)&&!('accounts' in d)&&!('settings' in d))){
    toast('That file does not look like a Ledger backup'); return;
  }
  /* validate, then rehearse the whole restore on a scratch state: the live book is not touched until the
     backup has proven it can be applied end to end */
  const probs=validateBackupShape(d);
  if(probs.length){ dlog('restore rejected',{problems:probs}); toast('Backup rejected — '+probs[0]+(probs.length>1?' (+'+(probs.length-1)+' more)':'')+'. Nothing was changed.'); return; }
  const live=S;
  try{ S=freshState(); healState(JSON.parse(text)); if(!Array.isArray(S.transactions)||!Array.isArray(S.accounts)) throw new Error('lists missing'); recalcBalances(); integrityCheck(); }
  catch(e){ S=live; dlog('restore rehearsal failed',{error:errStr(e)}); toast('Backup could not be applied ('+errStr(e)+'). Nothing was changed.'); return; }
  const trial={tx:S.transactions.length,accts:S.accounts.length}; S=live;
  if(!confirmed&&(trial.tx<S.transactions.length||trial.accts<S.accounts.length)){
    const dt=S.transactions.length-trial.tx, da=S.accounts.length-trial.accts;
    confirmSheet('Restore an older, smaller backup?',
      `<div style="font-size:14px;line-height:1.6">This backup holds <b>${trial.tx} transaction${trial.tx===1?'':'s'}</b> and <b>${trial.accts} account${trial.accts===1?'':'s'}</b>; this copy holds <b>${S.transactions.length}</b> and <b>${S.accounts.length}</b>.<br><br>Replacing would drop ${dt>0?'<b>'+dt+' transaction'+(dt===1?'':'s')+'</b>':''}${dt>0&&da>0?' and ':''}${da>0?'<b>'+da+' account'+(da===1?'':'s')+'</b>':''} that this copy has and the backup does not.</div>`,
      'Replace anyway',()=>applyRestore(text,true),true);
    return;
  }
  /* wipe first, then apply — otherwise anything absent from the backup would
     survive and the two copies would silently disagree. The one exception, on by
     default: things an older copy cannot know about (rules, goal dates) and
     settings that belong to this device (API key, text size, theme). */
  bootCorrupt=''; undoSnap=null;   /* a restore replaces the held, damaged book on purpose, and there is nothing sensible to undo back to */
  const rekeyAfter=pendingRekey; pendingRekey='';
  const keep=!$('#jsonKeep')||$('#jsonKeep').checked;
  const prev=keep?clone(S):null;
  S=freshState();
  healState(d);
  S.settings.onboarded=true;
  if(rekeyAfter){ setTimeout(async()=>{ try{ const code=await changePassphrase(rekeyAfter); toast('This browser is now protected by that backup\'s passphrase, under a key of its own'); recoverySheet(code,'new'); }catch(e){ toast('Restored, but the book could not be re-keyed: '+errStr(e)); } },200); }
  else if(!vaultKey&&!hasLock()&&isEnvelope(safeParse(arguments[0]))&&isDist()) setTimeout(()=>lockOffer(true),400);   /* an encrypted backup opened into an unprotected browser: offer to protect it */
  let kept=[];
  if(prev){
    if(!Array.isArray(d.rules)&&prev.rules.length){ S.rules=prev.rules; kept.push(prev.rules.length+' rule'+(prev.rules.length===1?'':'s')); }
    if(!Array.isArray(d.closes)&&(prev.closes||[]).length){ S.closes=prev.closes; kept.push(prev.closes.length+' monthly close'+(prev.closes.length===1?'':'s')); }
    if(!d.recurringIgnored&&Object.keys(prev.recurringIgnored||{}).length){ S.recurringIgnored=prev.recurringIgnored; }
    let dates=0;
    S.goals.forEach(g=>{ if(!g.deadline){ const o=prev.goals.find(x=>x.name===g.name&&x.deadline); if(o){ g.deadline=o.deadline; dates++; } } });
    if(dates) kept.push(dates+' goal date'+(dates===1?'':'s'));
    ['aiModel','aiProvider','openrouterModel','textSize','theme'].forEach(k=>{ if(prev.settings[k]!=null&&d.settings&&d.settings[k]==null) S.settings[k]=prev.settings[k]; });
  }
  myRev=Math.max(myRev,storedRevSync()); save(); closeModal(); render();
  S.settings.lastRestore=Date.now(); dlog('restore completed',{transactions:S.transactions.length,accounts:S.accounts.length,kept:kept}); save();
  toast('Backup restored — this copy now matches it'+(kept.length?' (kept your '+kept.join(' and ')+')':''));
}
function runRestore(){
  const pasted=(($('#jsonPaste')||{}).value||'').trim();
  if(pasted){ applyRestore(pasted); return; }
  const f=$('#jsonFile'), file=f&&f.files[0];
  if(!file){ toast('Paste a backup or choose a file'); return; }
  const fr=new FileReader();
  fr.onload=()=>applyRestore(String(fr.result));
  fr.onerror=()=>toast('That file could not be read');
  fr.readAsText(file);
}

function copyOut(){
  if(!S.transactions.length){ toast('Nothing to copy yet'); return; }
  const rows=[['date','amount','type','category','account','to_account','note']];
  S.transactions.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(t=>{
    if(isTransfer(t)) rows.push([t.date,t.amount.toFixed(2),'transfer','',(acct(t.fromId)||{}).name||'',(acct(t.toId)||{}).name||'',t.note||'']);
    else rows.push([t.date,t.amount.toFixed(2),t.type,cat(t.categoryId).name,(acct(t.accountId)||{}).name||'','',t.note||'']);
  });
  const text=rows.map(r=>r.map(csvCell).join(',')).join('\n');
  openSheet('Copy transactions',`
    <div class="muted" style="font-size:13.5px;line-height:1.5;margin-bottom:12px">
      ${S.transactions.length} rows, ready to paste into a spreadsheet or anywhere else.
    </div>
    <textarea id="copyBox" rows="10" style="font-family:var(--mono);font-size:12.5px;resize:vertical">${esc(text)}</textarea>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Done</button>
     <button class="btn btn-primary" data-act="do-copy">Copy to clipboard</button>`);
  const box=$('#copyBox'); if(box){ box.focus(); box.select(); }
}

/* ---------- generated graphics: a shareable month card ---------- */
function themeColor(name,fallback){
  const v=getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v&&v.trim())||fallback;
}
function svgEsc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
}
const CARD_W=1000, CARD_H=1250;

function buildMonthCard(){
  const C={
    bg:themeColor('--bg','#ECF0E9'), surface:themeColor('--surface','#F6FDF0'),
    surf2:themeColor('--surface-2','#E1FDCC'), ink:themeColor('--ink','#1E1B34'),
    ink2:themeColor('--ink-2','#425A80'), ink3:themeColor('--ink-3','#8A93A6'),
    rule:themeColor('--rule','#D3E0CE'), ruleS:themeColor('--rule-strong','#B2A6E9'),
    in:themeColor('--in','#0A7362'), out:themeColor('--out','#9540FE'),
    accent:themeColor('--accent','#2F7FD6'), pop:themeColor('--pop','#CAF72E'),
    onPop:themeColor('--on-pop','#1E1B34')
  };
  /* system stacks so the exported file renders the same everywhere */
  const UI='Helvetica Neue, Helvetica, Arial, sans-serif';
  const MO='SFMono-Regular, Menlo, Consolas, monospace';
  const P=64, W=CARD_W-P*2;
  const cur=monthFlows(ui.month), net=cur.in-cur.out;
  const series=netWorthSeries(12);
  const nwNow=netWorth(), nwChange=series[series.length-1].value-series[0].value;
  const keys=monthsBack(6), flows=keys.map(k=>monthFlows(k));
  const fmax=Math.max(1,...flows.map(f=>Math.max(f.in,f.out)));
  const spendBy={};
  inMonth(ui.month).filter(economicOut).forEach(t=>{spendBy[t.categoryId]=(spendBy[t.categoryId]||0)+amtBase(t);});
  const spend=Object.keys(spendBy).map(id=>({c:cat(id),v:spendBy[id]})).sort((a,b)=>b.v-a.v);
  const spendTotal=sum(spend.map(s=>s.v));
  const bestHabit=S.habits.map(h=>({h:h,st:habitStreak(h)})).sort((a,b)=>b.st-a.st)[0];
  const ahead=stillToCome(ui.month);

  const o=[];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">`);
  o.push(`<rect width="${CARD_W}" height="${CARD_H}" fill="${C.bg}"/>`);
  /* spectrum — the same signature as the app header */
  [C.in,C.accent,C.out,C.pop,C.ink2,C.ruleS].forEach((c,i)=>{
    o.push(`<rect x="${i*(CARD_W/6)}" y="0" width="${CARD_W/6+1}" height="10" fill="${c}"/>`);
  });
  const rule=(y)=>`<line x1="${P}" y1="${y}" x2="${CARD_W-P}" y2="${y}" stroke="${C.rule}" stroke-width="2"/>`;
  const eyebrow=(x,y,t)=>`<text x="${x}" y="${y}" font-family="${UI}" font-size="15" font-weight="700" letter-spacing="3" fill="${C.ink3}">${svgEsc(t.toUpperCase())}</text>`;

  o.push(`<text x="${P}" y="${86}" font-family="${UI}" font-size="17" font-weight="700" letter-spacing="7" fill="${C.ink2}">LEDGER</text>`);
  o.push(`<text x="${P}" y="${150}" font-family="${UI}" font-size="54" font-weight="700" fill="${C.ink}">${svgEsc(monthName(ui.month,true))}</text>`);
  o.push(rule(186));

  o.push(eyebrow(P,232,'Net worth'));
  o.push(`<text x="${P}" y="${306}" font-family="${MO}" font-size="66" font-weight="500" fill="${C.ink}">${svgEsc(money(nwNow))}</text>`);
  o.push(`<text x="${P}" y="${344}" font-family="${MO}" font-size="20" fill="${nwChange>=0?C.in:C.out}">${svgEsc(signed(nwChange))} over 12 months</text>`);
  o.push(rule(390));

  const col=[P,P+W/3,P+2*W/3];
  [['In',cur.in,C.in],['Out',cur.out,C.out],['Net',net,net>=0?C.in:C.out]].forEach((r,i)=>{
    o.push(eyebrow(col[i],436,r[0]));
    o.push(`<text x="${col[i]}" y="${482}" font-family="${MO}" font-size="34" font-weight="500" fill="${r[2]}">${svgEsc(r[0]==='Net'?signed(r[1]):money(r[1]))}</text>`);
  });
  o.push(rule(528));

  /* six month bars */
  o.push(eyebrow(P,574,'Six months'));
  const bTop=600, bH=150, colW=W/6;
  flows.forEach((f,i)=>{
    const cx=P+i*colW+colW/2;
    const hIn=Math.round((f.in/fmax)*bH), hOut=Math.round((f.out/fmax)*bH);
    o.push(`<rect x="${cx-46}" y="${bTop+bH-hIn}" width="42" height="${Math.max(2,hIn)}" rx="5" fill="${C.in}"/>`);
    o.push(`<rect x="${cx+4}" y="${bTop+bH-hOut}" width="42" height="${Math.max(2,hOut)}" rx="5" fill="${C.out}"/>`);
    o.push(`<text x="${cx}" y="${bTop+bH+30}" text-anchor="middle" font-family="${MO}" font-size="17" fill="${keys[i]===ui.month?C.ink:C.ink3}">${svgEsc(monthName(keys[i]).split(' ')[0])}</text>`);
  });
  o.push(rule(bTop+bH+62));

  /* donut + legend */
  o.push(eyebrow(P,838,'Where it went'));
  const cxD=P+128, cyD=1000, rD=100, sw=38;
  const CIRC=2*Math.PI*rD;
  o.push(`<circle cx="${cxD}" cy="${cyD}" r="${rD}" fill="none" stroke="${C.surf2}" stroke-width="${sw}"/>`);
  if(spendTotal>0){
    let off=0;
    spend.forEach(s=>{
      const len=(s.v/spendTotal)*CIRC;
      o.push(`<circle cx="${cxD}" cy="${cyD}" r="${rD}" fill="none" stroke="${s.c.color}" stroke-width="${sw}"`+
        ` stroke-dasharray="${Math.max(0,len-3).toFixed(2)} ${(CIRC-len+3).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"`+
        ` transform="rotate(-90 ${cxD} ${cyD})"/>`);
      off+=len;
    });
    o.push(`<text x="${cxD}" y="${cyD+4}" text-anchor="middle" font-family="${MO}" font-size="30" font-weight="500" fill="${C.ink}">${svgEsc(money(spendTotal,{round:true}))}</text>`);
    o.push(`<text x="${cxD}" y="${cyD+32}" text-anchor="middle" font-family="${UI}" font-size="13" letter-spacing="2.5" fill="${C.ink3}">SPENT</text>`);
    const lx=P+286;
    spend.slice(0,5).forEach((s,i)=>{
      const ly=898+i*40;
      o.push(`<rect x="${lx}" y="${ly-12}" width="14" height="14" rx="4" fill="${s.c.color}"/>`);
      o.push(`<text x="${lx+26}" y="${ly}" font-family="${UI}" font-size="20" fill="${C.ink}">${svgEsc(s.c.name)}</text>`);
      o.push(`<text x="${CARD_W-P}" y="${ly}" text-anchor="end" font-family="${MO}" font-size="20" fill="${C.ink2}">${svgEsc(money(s.v))}</text>`);
    });
    if(spend.length>5){
      o.push(`<text x="${lx+26}" y="${898+5*40}" font-family="${UI}" font-size="17" fill="${C.ink3}">+ ${spend.length-5} smaller categories</text>`);
    }
  }else{
    o.push(`<text x="${cxD+180}" y="${cyD}" text-anchor="middle" font-family="${UI}" font-size="22" fill="${C.ink3}">Nothing spent this month</text>`);
  }

  /* footer */
  o.push(rule(1132));
  let fx=P;
  if(ahead.count){
    o.push(eyebrow(fx,1180,'Still to come'));
    o.push(`<text x="${fx}" y="${1216}" font-family="${MO}" font-size="24" fill="${ahead.in-ahead.out>=0?C.in:C.out}">${svgEsc(signed(ahead.in-ahead.out))}</text>`);
    fx+=W/2;
  }
  if(bestHabit&&bestHabit.st>=3){
    const label=bestHabit.st+' day streak';
    const tw=label.length*11+34;
    o.push(`<rect x="${fx}" y="${1188}" width="${tw}" height="36" rx="18" fill="${C.pop}"/>`);
    o.push(`<text x="${fx+tw/2}" y="${1212}" text-anchor="middle" font-family="${MO}" font-size="17" font-weight="600" fill="${C.onPop}">${svgEsc(label)}</text>`);
    o.push(`<text x="${fx+tw+14}" y="${1212}" font-family="${UI}" font-size="18" fill="${C.ink3}">${svgEsc(bestHabit.h.name)}</text>`);
  }
  o.push('</svg>');
  return o.join('');
}

function downloadSVG(svg,name){
  download(name,svg,'image/svg+xml;charset=utf-8');
  toast('SVG saved');
}
function downloadPNG(svg,name,scale){
  scale=scale||2;
  const blob=new Blob([svg],{type:'image/svg+xml;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const img=new Image();
  img.onload=function(){
    try{
      const c=document.createElement('canvas');
      c.width=CARD_W*scale; c.height=CARD_H*scale;
      const ctx=c.getContext('2d');
      ctx.drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function(b){
        if(!b){ toast('The image could not be built — try the SVG instead'); return; }
        const u=URL.createObjectURL(b);
        const a=document.createElement('a'); a.href=u; a.download=name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(()=>URL.revokeObjectURL(u),1000);
        toast('PNG saved');
      },'image/png');
    }catch(e){ toast('The image could not be built — try the SVG instead'); }
  };
  img.onerror=function(){ URL.revokeObjectURL(url); toast('The image could not be built — try the SVG instead'); };
  img.src=url;
}

function monthCardModal(){
  if(!S.transactions.length&&!S.accounts.length){ toast('Add something first — there is nothing to chart'); return; }
  const svg=buildMonthCard();
  openSheet('Month card',`
    <div class="muted" style="font-size:13.5px;line-height:1.5;margin-bottom:14px">
      A graphic drawn from ${esc(monthName(ui.month,true))}, in whichever colours you are using. Nothing leaves this page — the file is built in your browser.
    </div>
    <div style="border:1px solid var(--rule-strong);border-radius:12px;overflow:hidden;line-height:0">
      <div style="width:100%">${svg.replace('<svg ','<svg style="width:100%;height:auto;display:block" ')}</div>
    </div>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Close</button>
     <button class="btn" data-act="card-svg">Save SVG</button>
     <button class="btn btn-primary" data-act="card-png">Save PNG</button>`);
}

/* ---------- sample data ---------- */
function loadSample(){
  const now=new Date();
  S.accounts=[
    {id:'a1',name:'Chequing',kind:'asset',label:'Everyday bank',balance:4820.55,rate:0,minPayment:0},
    {id:'a2',name:'Savings',kind:'asset',label:'High interest',balance:11250,rate:0,minPayment:0},
    {id:'a3',name:'Credit card',kind:'liability',label:'Visa',balance:3340.18,rate:19.99,minPayment:100},
    {id:'a4',name:'Line of credit',kind:'liability',label:'Bank LOC',balance:7600,rate:8.45,minPayment:150}
  ];
  S.debtPlan={mode:'payment',payment:600,targetDate:'',strategy:'avalanche'};
  S.users=[{id:'u1',name:'Alex',color:'#2E6B4F'},{id:'u2',name:'Sam',color:'#3A6B8A'}];
  S.rules=[{id:uid(),match:'uber eats',categoryId:'c7',accountId:'',on:true},{id:uid(),match:'uber',categoryId:'c6',accountId:'',on:true},{id:uid(),match:'netflix',categoryId:'c8',accountId:'',on:true}];
  S.habits=[
    {id:'h1',name:'No-spend day',mode:'nospend',limit:0,color:'#2E6B4F'},
    {id:'h2',name:'Under $40 a day',mode:'under',limit:40,color:'#3A6B8A'},
    {id:'h3',name:'Logged my spending',mode:'manual',limit:0,color:'#B07E1E'},
    {id:'h4',name:'Packed lunch',mode:'manual',limit:0,color:'#66478A'}
  ];
  S.habitLog={};
  (function(){
    const d=new Date(), key=ym(d), last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
    const soon=Math.min(last,d.getDate()+6), later=Math.min(last,d.getDate()+11);
    S.planned=[
      {id:'p1',name:'Car insurance',amount:184,date:key+'-'+pad2(soon),categoryId:'c6'},
      {id:'p2',name:'Dentist',amount:220,date:key+'-'+pad2(later),categoryId:'c9'}
    ];
  })();
  for(let back=45;back>=0;back--){
    const d=new Date(); d.setDate(d.getDate()-back);
    const iso=isoOf(d);
    if(back%7!==3) S.habitLog['h3:'+iso]=true;
    if(d.getDay()>=1&&d.getDay()<=5&&back%4!==1) S.habitLog['h4:'+iso]=true;
  }
  S.budgets={c4:600,c5:220,c6:180,c7:250,c8:80,c10:300};
  S.goals=[
    {id:'g1',name:'Emergency fund',target:15000,saved:11250},
    {id:'g2',name:'Trip to Madagascar',target:6000,saved:1450}
  ];
  const since=ym(new Date(now.getFullYear(),now.getMonth()-5,1));
  const anchor=new Date(now.getFullYear(),now.getMonth()-2,1).getMonth()+1;
  S.recurring=[
    {id:'r1',name:'Rent',amount:1650,day:1,month:1,cadence:'monthly',since:since,categoryId:'c3',accountId:'a1',active:true},
    {id:'r2',name:'Hydro & internet',amount:184.4,day:5,month:1,cadence:'monthly',since:since,categoryId:'c5',accountId:'a1',active:true},
    {id:'r3',name:'Streaming bundle',amount:38.97,day:12,month:1,cadence:'monthly',since:since,categoryId:'c8',accountId:'a3',active:true},
    {id:'r5',name:'Gym membership',amount:59.95,day:3,month:1,cadence:'monthly',since:since,categoryId:'c9',accountId:'a3',active:true},
    {id:'r6',name:'Warehouse club membership',amount:120,day:18,month:anchor,cadence:'yearly',since:since,categoryId:'c10',accountId:'a3',active:true},
    {id:'r7',name:'Professional association dues',amount:435,day:9,month:anchor,cadence:'yearly',since:since,categoryId:'c10',accountId:'a1',active:true},
    {id:'r8',name:'Water delivery',amount:74.5,day:22,month:anchor,cadence:'quarterly',since:since,categoryId:'c5',accountId:'a1',active:true},
    {id:'r4',name:'Salary',amount:3480,day:15,month:1,cadence:'monthly',since:since,categoryId:'c1',accountId:'a1',active:true}
  ];
  S.generated={};
  S.transactions=[];
  const picks=[
    ['c4','Groceries — market',96.4],['c4','Groceries — weekly shop',142.85],['c7','Dinner out',68.2],
    ['c6','Bus pass',122],['c7','Coffee',5.75],['c10','Bookstore',34.99],['c9','Pharmacy',42.1],
    ['c4','Groceries — top up',58.3],['c6','Fuel',71.4],['c10','Haircut',45],['c7','Lunch with team',24.6],
    ['c2','Freelance invoice',400]
  ];
  for(let back=5;back>=0;back--){
    const d=new Date(now.getFullYear(),now.getMonth()-back,1);
    const key=ym(d);
    const lastDay=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
    const count=back===0?Math.min(8,now.getDate()):10;
    for(let i=0;i<count;i++){
      const p=picks[(i+back*3)%picks.length];
      const day=Math.min(lastDay,back===0?Math.max(1,Math.floor(now.getDate()*(i+1)/count)):Math.floor((i+1)*lastDay/(count+1)));
      const c=cat(p[0]);
      const jitter=1+((i*7+back*13)%17-8)/100;
      S.transactions.push({id:uid(),date:key+'-'+pad2(day),amount:Math.round(p[2]*jitter*100)/100,type:c.type,
        categoryId:p[0],accountId:i%3===0?'a3':'a1',note:p[1]});
    }
  }
  /* a paycheque and a freelance invoice early in the current month, so the demo household earns as well as spends */
  if(now.getDate()<15){ const k=ym(now); S.transactions.push({id:uid(),date:k+'-01',amount:3480,type:'in',categoryId:'c1',accountId:'a1',note:'Payroll'},{id:uid(),date:k+'-03',amount:900,type:'in',categoryId:'c2',accountId:'a1',note:'Freelance invoice'}); }
  S.settings.onboarded=true;
  S.accounts.forEach(a=>{ delete a.anchor; }); ensureAnchors();
  runRecurring();
  /* tag salary to Alex, freelance/other income to Sam, and share the spending between them (a few rows left
     untagged so the Unassigned view has something to show); every row is marked as sample so reminders
     about backing up wait for a real book */
  let k=0; S.transactions.forEach(t=>{ t.source='sample'; if(t.type==='in'){ t.userId=(t.categoryId==='c1')?'u1':'u2'; } else if(t.type==='out'){ k++; if(k%4!==0) t.userId=k%2?'u1':'u2'; } });
  ui.user='all';
  save(); closeModal(); render();
  toast('Sample data loaded — clear it any time in Settings › Data');
}

/* the shared file asks once: protect it or not. Nothing is forced. */
function lockOffer(force){
  if(hasLock()||!cryptoOK()) return;
  const n=Number(S.settings.lockOfferCount)||0, at=Number(S.settings.lockOfferedAt)||0;
  if(!force&&(n>=3||(at&&Date.now()-at<3*86400000))) return;
  S.settings.lockOffered=true; S.settings.lockOfferCount=n+1; S.settings.lockOfferedAt=Date.now(); save();
  openSheet('Protect this Ledger?',`
    <div style="line-height:1.6;font-size:15px">
      <p style="margin-top:0">Anyone who can open this file or this browser can read your finances. A passphrase changes that: the book is encrypted with it in this browser, in backups, and in every copy you save.</p>
      <p style="margin-bottom:0">You also get a <b>recovery code</b> to email to yourself or write down, for the day you forget the passphrase. <b>Lose both and the book is gone for good</b> — there is no reset link, because nobody holds a key but you. You can skip this and set it later in Settings.</p>
    </div>`,
    `<button class="btn btn-ghost" data-act="lock-offer-skip">${(Number(S.settings.lockOfferCount)||0)>=3?'Don\'t ask again':'Not now'}</button><span class="spacer"></span>
     <button class="btn btn-primary" data-act="lock-offer-set">Set a passphrase</button>`);
}
/* one dialog to set the passphrase, wherever it was asked for; the recovery code follows */
function passphraseSetupForm(){
  if(hasLock()){ toast('A passphrase is already set — change it in Settings'); return; }
  openForm({title:'Set a passphrase',fields:[
      {name:'p1',label:'Passphrase (at least '+PASS_MIN+' characters)',type:'password',value:''},
      {name:'p2',label:'Type it again',type:'password',value:''},
      {name:'timeout',label:'Lock after',type:'select',value:String(S.settings.lockTimeout||LOCK_DEFAULT),options:[{value:'120',label:'2 idle minutes'},{value:'300',label:'5 idle minutes'},{value:'900',label:'15 idle minutes'},{value:'0',label:'Only when the file is opened'}]}],
    note:'The book is encrypted with this passphrase everywhere it is stored. Next you get a recovery code — save it, it is the only way back in if you forget the passphrase.',
    onSubmit:v=>{ if(!v.p1||v.p1.length<PASS_MIN){ toast('Use at least '+PASS_MIN+' characters'); return false; } if(v.p1!==v.p2){ toast('Passphrases do not match'); return false; }
      S.settings.lockTimeout=parseInt(v.timeout,10)||0; closeModal();
      setLockPassphrase(v.p1).then(code=>{ toast('Passphrase set — your book is encrypted from now on'); render(); refreshSettingsIfOpen(); recoverySheet(code,'new'); }).catch(e=>toast('Could not set passphrase: '+errStr(e))); }});
}
function firstRun(){
  openSheet('Welcome',`
    <div style="line-height:1.6;font-size:15px">
      <p style="margin-top:0"><b>Each person in your home enters their own money, and Ledger adds it up into the household.</b> Add people with “+ Person” in the top bar, pick a name, and what you add is theirs; “All users (household)” shows everyone together.</p>
      <p>Everything stays in this browser by default. Nothing leaves it unless you choose to: adding an AI key to read statements, or pressing “Fetch rates” — both say so at the time. The card at the top walks you through the first month: an account, a bank statement, the people, a passphrase, a copy.</p>
      ${isDist()?'<p><b>One thing to know:</b> the book lives in this browser, not inside the file. “Save a copy with my data inside” makes a file that opens anywhere with everything in it — Ledger will remind you.</p>':''}
      <p style="margin-bottom:0">Start clean, or load a sample month to see how the widgets behave before you commit.</p>
    </div>`,
    `<button class="btn" data-act="load-sample">Load sample data</button><span class="spacer"></span>
     <button class="btn btn-primary" data-act="start-empty">Start with a blank ledger</button>`);
}

/* ============================ events ============================ */
document.addEventListener('click',function(e){
  const veil=e.target.closest?null:null;
  if(e.target.classList&&e.target.hasAttribute&&e.target.hasAttribute('data-veil')){ discardReview(); closeModal(); return; }
  const el=e.target.closest('[data-act]');
  if(!el) return;
  const act=el.dataset.act, id=el.dataset.id;
  switch(act){
    case 'month-prev': ui.month=shiftMonth(ui.month,-1); render(); break;
    case 'month-next': ui.month=shiftMonth(ui.month,1); render(); break;
    case 'month-today': ui.month=ym(new Date()); render(); break;
    case 'toggle-theme':
      S.settings.theme=themeOf(S.settings.theme).pair; save(); render();
      toast(themeOf(S.settings.theme).name); break;
    case 'set-theme-id':
      S.settings.theme=el.dataset.v; save(); render(); refreshSettings(); break;
    case 'set-lock-timeout': S.settings.lockTimeout=parseInt(el.value,10)||60; save(); const lk=loadLock(); if(lk){ lk.timeout=S.settings.lockTimeout; saveLock(lk); } refreshSettings(); break;
    case 'lock-set': {
      const pw1=document.getElementById('lockSetInput');
      const pw2=document.getElementById('lockSetConfirm');
      const to=document.getElementById('lockSetTimeout');
      if(!pw1||!pw1.value.trim()){ toast('Enter a passphrase'); return; }
      if(pw1.value.length<PASS_MIN){ toast('Use at least '+PASS_MIN+' characters'); return; }
      if(pw1.value!==pw2.value){ toast('Passphrases do not match'); return; }
      S.settings.lockTimeout=to?parseInt(to.value,10)||60:60; save();
      (async()=>{
        try{
          const code=await setLockPassphrase(pw1.value);
          toast('Passphrase set — your book is encrypted from now on');
          refreshSettings(); render();   /* the top-bar lock appears as soon as there is something to lock */
          recoverySheet(code,'new');
        }catch(e){ console.error('Lock set failed',e); toast('Could not set passphrase: '+e.message); }
      })();
      break;
    }
    case 'lock-remove': (async()=>{ try{ await setLockPassphrase(''); toast('Passphrase removed — the book is stored readable again'); }catch(e){ toast('Could not remove: '+errStr(e)); } refreshSettings(); render(); })(); break;
    case 'lock-now': showLock(); break;
    case 'lock-change': newPassphraseForm('Choose the new passphrase. Your recovery code stays valid.'); break;
    case 'lock-recovery': passphrasePrompt('Make a new recovery code','Enter your passphrase first. The book is re-encrypted; the old recovery code opens nothing saved from now on. The new code is shown once.',async pw=>{ const how=await unlockWith(pw); if(how!=='pass'){ toast('Wrong passphrase'); return; } try{ const c=await newRecoveryCodeForVault(pw); recoverySheet(c,'new'); }catch(e){ toast('Could not make one: '+errStr(e)); } }); break;
    case 'recovery-copy': (async()=>{ try{ await navigator.clipboard.writeText(el.dataset.code); toast('Copied'); }catch(e){ const n=document.getElementById('recoveryCode'); if(n&&window.getSelection){ const r=document.createRange(); r.selectNodeContents(n); const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r); } toast('Select the code and copy it'); } })(); break;
    case 'recovery-download': download('ledger-recovery-code.txt','Ledger recovery code: '+el.dataset.code+'\n\nIf you forget your Ledger passphrase, type this code on the lock screen instead, then choose a new passphrase. Anyone holding this code can open your Ledger.\n','text/plain'); toast('Downloaded'); break;
    case 'lock-unlock': {
      const inp=document.getElementById('lockInput');
      const err=document.getElementById('lockErr');
      if(!inp) return;
      (async()=>{
        if(pendingUnlock){   /* opening a sealed book at boot (browser storage or a protected copy) */
          const p=pendingUnlock;
          try{ const secret=inp.value; const pt=await openSealed(p.text,secret,true); pendingUnlock=null; if(lastUnlockHow==='pass') vaultPass=secret; const l=loadLock(); if(!wrapsOf(l)&&vaultWraps) saveLock(Object.assign({timeout:(l&&l.timeout)||S.settings.lockTimeout||LOCK_DEFAULT},vaultWraps)); hideLock(); pokeActivity(); p.resolve(pt); }
          catch(e){ if(err) err.textContent=e.wrongPass?'Wrong passphrase or recovery code':e.damaged?'Your passphrase is right, but the saved book is damaged. Restore from a backup or a saved copy (Settings › Data) — this copy will not be overwritten.':('Could not open: '+errStr(e)); if(e.damaged){ bootCorrupt=p.text; pendingUnlock=null; hideLock(); S=freshState(); S.settings.onboarded=true; p.resolve(JSON.stringify(S)); render(); return; } inp.value=''; inp.focus(); }
          return;
        }
        const how=await unlockWith(inp.value);
        if(how){ if(lockWiped){ lockWiped=false; await load(); lastLocalSave=S.settings.lastLocalSave||0; myRev=Number(S.settings.rev)||0; recalcBalances(); render(); } hideLock(); pokeActivity(); if(how==='recovery') setTimeout(()=>newPassphraseForm(),200); if(pendingRecovery){ const c=pendingRecovery; pendingRecovery=''; setTimeout(()=>recoverySheet(c,'upgraded'),300); } }
        else{ if(err) err.textContent='Wrong passphrase or recovery code'; inp.value=''; inp.focus(); }
      })();
      break;
    }
    case 'open-settings': settingsTab='general'; openSettings(); break;
    case 'open-household': settingsTab='household'; openSettings(); break;
    case 'add-person': personForm(); break;
    case 'lock-offer-skip': closeModal(); break;
    case 'lock-offer-set': closeModal(); passphraseSetupForm(); break;
    case 'lock-setup': passphraseSetupForm(); break;
    case 'form-chip': { const box=el.closest('.chips'); box.querySelectorAll('.chip').forEach(c=>c.setAttribute('aria-pressed',String(c===el))); if(box.dataset.chips==='dir'){ const sel=document.getElementById('f_categoryId'); if(sel){ const want=el.dataset.v; const cur=cat(sel.value); if(!cur||cur.type!==want){ const first=want==='in'?(S.categories.find(c=>c.id==='c1'&&c.type==='in')||S.categories.find(c=>c.type==='in')):S.categories.find(c=>c.type==='out'&&c.id!=='c0'); if(first){ sel.value=first.id; formCatTouched=true; formRuleId=null; } } } } break; }
    case 'edit-person': personForm(S.users.find(x=>x.id===id)); break;
    case 'bulk-assign-preview': bulkAssignPreview(); break;
    case 'bulk-assign-apply': bulkAssignApply(); break;
    case 'close-modal': discardReview(); closeModal(); break;

    case 'add-tx': txForm(); break;
    case 'add-transfer': transferForm(); break;
    case 'edit-transfer': transferForm(S.transactions.find(t=>t.id===id)); break;
    case 'clear-search': ui.search=''; render(); break;
    case 'undo':
      if(!undoSnap){ toast('Nothing to undo'); break; }
      { const snap=undoSnap; undoSnap=null;
        S=freshState(); healState(JSON.parse(snap));
        save(); render(); toast('Undone'); }
      break;
    case 'dismiss-backup': S.settings.backupNudged=Date.now(); save(); render(); break;
    case 'edit-tx': txForm(S.transactions.find(t=>t.id===id)); break;
    case 'add-acct': acctForm(); break;
    case 'reconcile': { const a=acct(id); if(a) (a.valued==='checkpoints'?valuationModal:reconcileModal)(a); break; }
    case 'close-month': monthlyCloseModal(el.dataset.v||ui.month); break;
    case 'open-diagnostics': diagnosticsModal('status'); break;
    case 'diag-tab': diagnosticsModal(el.dataset.v); break;
    case 'diag-rule-test': diagRuleTest=($('#diagRuleText')||{}).value||''; { const acc=($('#diagRuleAcct')||{}).value||''; diagnosticsModal('rules'); const sel=$('#diagRuleAcct'); if(sel) sel.value=acc; if(diagRuleTest){ const ex=explainRules(diagRuleTest,acc); const box=$('.sheet-body'); if(box&&acc){ box.innerHTML=box.innerHTML; } dlog('rule test',{text:diagRuleTest,winner:ex.winner?ex.winner.match:null}); } } break;
    case 'diag-backup-run': (async()=>{ diagBackupSteps=await fullBackupDiagnostic(); diagnosticsModal('backup'); })(); break;
    case 'diag-integrity-run': diagIntegrity=integrityCheck(); diagnosticsModal('integrity'); break;
    case 'diag-log-copy': { if(!dlogLoaded) loadDlog(); const txt=DLOG.map(e=>new Date(e.t).toISOString()+' '+e.ev+' '+(typeof e.d==='string'?e.d:JSON.stringify(e.d))).join('\n'); if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(()=>toast('Debug log copied'),()=>toast('Could not copy')); else toast('Clipboard not available'); break; }
    case 'diag-log-export': { if(!dlogLoaded) loadDlog(); download('ledger-debug-log.json',JSON.stringify({version:APP_VERSION,exported:new Date().toISOString(),entries:DLOG},null,1),'application/json'); break; }
    case 'diag-log-clear': clearDlog(); diagnosticsModal('log'); toast('Debug log cleared'); break;
    case 'diag-repair': { const p=(diagRepairs||repairPlans()).find(x=>x.id===el.dataset.v); if(!p) break;
      if(!el.dataset.confirm){ el.dataset.confirm='1'; el.textContent='Confirm: '+p.name+'?'; el.classList.add('btn-danger'); break; }
      markUndo(); p.apply(); dlog('repair applied',{repair:p.id,preview:p.preview}); save(); render(); diagnosticsModal('repairs'); toast(p.name+' applied',true); break; }
    case 'close-month-nav': monthlyCloseModal(el.dataset.v); break;
    case 'close-history': closeHistoryModal(); break;
    case 'close-compare': { const c=S.closes.find(x=>x.id===id); const x=c&&c.accounts.find(y=>y.accountId===el.dataset.v); if(!x) break;
      const inp=closeAcctInputs(el.dataset.v); if(inp.statement===null||isNaN(inp.statement)){ toast('Enter the statement balance'); break; }
      x.statement=r2(inp.statement); x.statementDate=inp.date||c.closeDate; x.ledger=balanceAsOf(acct(x.accountId),x.statementDate,{independent:true}); x.diff=r2(x.statement-x.ledger); x.status='compared';
      c.notes=($('#closeNotes')||{}).value||c.notes; save(); monthlyCloseModal(c.month); break; }
    case 'close-accept': { const c=S.closes.find(x=>x.id===id); const x=c&&c.accounts.find(y=>y.accountId===el.dataset.v); const a=x&&acct(x.accountId); if(!a) break;
      const inp=closeAcctInputs(el.dataset.v); if(inp.statement!==null&&!isNaN(inp.statement)){ x.statement=r2(inp.statement); x.statementDate=inp.date||x.statementDate||c.closeDate; }
      if(x.statement==null){ toast('Enter the statement balance first'); break; }
      markUndo();
      x.ledger=balanceAsOf(a,x.statementDate,{independent:true}); x.diff=r2(x.statement-x.ledger);
      setCheckpoint(a,x.statementDate,Math.abs(x.statement)); x.checkpointDate=x.statementDate; x.fp=historyFP(a,x.statementDate); x.status='reconciled'; x.at=Date.now();
      if(Math.abs(x.diff)>=0.005) x.note='accepted with a '+signed(x.diff)+' difference';
      c.notes=($('#closeNotes')||{}).value||c.notes; save(); render(); monthlyCloseModal(c.month); toast(a.name+' reconciled at '+money(Math.abs(x.statement))+' as of '+fmtDate(x.statementDate),true); break; }
    case 'close-inspect': { const c=S.closes.find(x=>x.id===id); const x=c&&c.accounts.find(y=>y.accountId===el.dataset.v); const a=x&&acct(x.accountId); if(!a) break; reconcileModal(a,{actual:x.statement,date:x.statementDate}); break; }
    case 'close-skip': { const c=S.closes.find(x=>x.id===id); const x=c&&c.accounts.find(y=>y.accountId===el.dataset.v); if(!x) break; x.status='skipped'; x.at=Date.now(); c.notes=($('#closeNotes')||{}).value||c.notes; save(); monthlyCloseModal(c.month); break; }
    case 'close-reopen': { const c=S.closes.find(x=>x.id===id); const x=c&&c.accounts.find(y=>y.accountId===el.dataset.v); if(!x) break; x.status='pending'; x.checkpointDate=''; x.fp=null; x.note=''; save(); monthlyCloseModal(c.month); toast('Reopened — the checkpoint itself stays; remove it under Reconcile if you meant that'); break; }
    case 'close-finish': { const c=S.closes.find(x=>x.id===id); if(!c) break; const p=closeProgress(c); if(p.done<p.total){ toast('Every account needs to be reconciled or skipped first'); break; }
      c.status='closed'; c.closedAt=Date.now(); c.notes=($('#closeNotes')||{}).value||c.notes; dlog('monthly close completed',{month:c.month,reconciled:p.rec,skipped:p.done-p.rec});
      c.accounts.forEach(x=>{ if(x.status==='reconciled'){ const a=acct(x.accountId); if(a) x.fp=historyFP(a,x.statementDate); } });
      save(); render(); monthlyCloseModal(c.month); toast(monthName(c.month,true)+' closed — '+p.rec+' reconciled, '+(p.done-p.rec)+' skipped'); break; }
    case 'checkpoint-remove': { const a=acct(id); if(!a) break; markUndo(); removeCheckpoint(a,el.dataset.v); save(); render(); reconcileModal(a); toast('Checkpoint removed — '+(a.checkpoints.length?'the '+fmtDate(a.checkpoints[a.checkpoints.length-1].date)+' one now governs':'back to the opening balance'),true); break; }
    case 'reconcile-check': { const a=acct(id); if(a) reconcileModal(a,{actual:($('#rcActual')||{}).value,date:($('#rcDate')||{}).value}); break; }
    case 'reconcile-accept': {
      const a=acct(id); const v=($('#rcActual')||{}).value, dt=($('#rcDate')||{}).value||todayISO();
      if(!a||v===''||v==null){ toast('Enter the bank balance first'); break; }
      markUndo(); setCheckpoint(a,dt,Math.abs(parseFloat(v)||0)); dlog('reconciliation completed',{account:a.name,date:dt}); save(); closeModal(); render();
      toast(a.name+' reconciled at '+money(a.anchor.balance)+' as of '+fmtDate(dt),true);
      maybeProposeAllocation(a,dt); break;
    }
    case 'rebuild-balances': {
      const before=S.accounts.map(a=>r2(a.balance)); recalcBalances();
      const changed=S.accounts.filter((a,i)=>Math.abs(a.balance-before[i])>0.005).length;
      save(); render(); refreshSettings();
      toast(changed?'Rebuilt — '+changed+' balance'+(changed===1?' was':'s were')+' stale and got corrected':'Verified — all '+S.accounts.length+' balance'+(S.accounts.length===1?'':'s')+' match the transaction history'); break;
    }
    case 'edit-acct': acctForm(S.accounts.find(a=>a.id===id)); break;
    case 'add-goal': goalForm(); break;
    case 'edit-goal': goalForm(S.goals.find(g=>g.id===id)); break;
    case 'contribute-goal': contributeForm(S.goals.find(g=>g.id===id)); break;
    case 'goal-plan': goalPlanModal(S.goals.find(g=>g.id===id)); break;
    case 'goal-horizon': { const g=S.goals.find(x=>x.id===id); if(!g) break; g.deadline=horizonDate(el.dataset.v); save(); render(); goalPlanModal(g); toast('Target set for '+fmtDate(g.deadline)); break; }
    case 'goal-date-set': { const g=S.goals.find(x=>x.id===id); const v=($('#gpDate')||{}).value; if(!g||!v){ toast('Pick a date first'); break; } g.deadline=v; save(); render(); goalPlanModal(g); break; }
    case 'import-shots': screenshotImport(); break;
    case 'add-rule': ruleForm(null,()=>{ settingsTab='categories'; openSettings(); }); break;
    case 'edit-rule': ruleForm(S.rules.find(r=>r.id===id),()=>{ settingsTab='categories'; openSettings(); }); break;
    case 'rule-move': {
      const i=S.rules.findIndex(r=>r.id===id), j=i+Number(el.dataset.v);
      if(i<0||j<0||j>=S.rules.length) break;
      const [r]=S.rules.splice(i,1); S.rules.splice(j,0,r); save(); refreshSettings(); break;
    }
    case 'rules-run': rulesRunModal(); break;
    case 'recat': recatModal(); break;
    case 'recat-apply': recatApply(); break;
    case 'rules-run-commit': rulesRunCommit(); break;
    case 'rule-from-form': {
      const v=readForm();
      const note=(v.note||'').trim();
      if(!note){ toast('Type a note first — the rule matches on it'); break; }
      const existing=S.transactions.find(x=>x.id===formTxId);
      ruleForm({match:merchantGuess(note),categoryId:v.categoryId,accountId:''},()=>{ if(existing) txForm(existing); });
      break;
    }
    case 'wi-mode': ui.whatIf.mode=el.dataset.v; ui.whatIf.extra=0; render(); break;
    case 'wi-preset': ui.whatIf.extra=Number(el.dataset.v)||0; refreshWhatIf(); break;
    case 'wi-reset': ui.whatIf.extra=0; refreshWhatIf(); break;
    case 'open-ai-settings': e.preventDefault(); settingsTab='ai'; openSettings(); break;
    case 'set-aiprovider': S.settings.aiProvider=el.dataset.v; save(); refreshSettings(); break;
    case 'shot-pick': { const f=$('#shotFile'); if(f) f.click(); break; }
    case 'shot-remove': shots.splice(+el.dataset.i,1); renderShots(); break;
    case 'shot-read': readShots(); break;
    case 'shot-commit': commitShots(); break;
    case 'fixes-no': pendingFixes=[]; closeModal(); break;
    case 'fixes-yes': {
      let n=0; document.querySelectorAll('[data-fix]').forEach(cb=>{ const f=pendingFixes[+cb.dataset.fix]; if(!cb.checked||!f) return;
        const exists=S.rules.find(x=>normText(x.match)===normText(f.match));
        if(exists){ if(exists.categoryId!==f.categoryId){ exists.categoryId=f.categoryId; n++; } } else { S.rules.push({id:uid(),match:f.match,categoryId:f.categoryId,accountId:'',on:true}); n++; } });
      pendingFixes=[]; save(); closeModal(); render(); toast(n?n+' merchant'+(n===1?'':'s')+' remembered — see Settings › Categories':'Nothing remembered'); break; }
    case 'shot-make-acct': makeAccountFromHint(); break;
    case 'shot-set-type': shotSetTypeFromHint(); break;
    case 'shot-use-acct': { const sel=$('#shotAcct'); if(!sel||!sel.value){ toast('Pick an account in the dropdown first'); break; } shotAcctChosen=true; if(shotHint&&acct(sel.value)){ const a=acct(sel.value); if(shotHint.last4&&!a.last4) a.last4=shotHint.last4; if(shotHint.institution&&!a.institution) a.institution=shotHint.institution; } applyAccountSemantics(); renderReview(); renderHint(); break; }
    case 'backup-link': linkBackupFile(); break;
    case 'backup-link-folder': linkBackupFolder(); break;
    case 'backup-test': backupSelfTest(); break;
    case 'backup-reconnect': reconnectBackup(); break;
    case 'backup-forget': S.settings.backupWasOn=false; save(); render(); toast('Stopped reminding you — Settings › Data still has the backup options'); break;
    case 'backup-unlink': unlinkBackup(); break;
    case 'add-recurring': recurringForm(); break;
    case 'rec-review': recurringSuggestModal(); break;
    case 'rec-create': { const sg=detectRecurring().find(x=>x.key===el.dataset.key); if(!sg) break; recurringForm(suggestionToRecurring(sg)); break; }
    case 'rec-ignore': { const sg=detectRecurring().find(x=>x.key===el.dataset.key); if(!sg) break; S.recurringIgnored[sg.key]={mode:'ignore',count:sg.count,at:Date.now()}; save(); recurringSuggestModal(); toast('Ignored — it comes back only if the pattern grows'); break; }
    case 'rec-never': { const sg=detectRecurring().find(x=>x.key===el.dataset.key); if(!sg) break; S.recurringIgnored[sg.key]={mode:'never',count:sg.count,at:Date.now()}; save(); recurringSuggestModal(); toast('Never suggesting '+sg.merchant+' again'); break; }
    case 'edit-recurring': recurringForm(S.recurring.find(r=>r.id===id)); break;
    case 'add-habit': habitForm(); break;
    case 'edit-habit': habitForm(S.habits.find(x=>x.id===id)); break;
    case 'habit-toggle': {
      const k=id+':'+el.dataset.d;
      if(S.habitLog[k]) delete S.habitLog[k]; else S.habitLog[k]=true;
      save();
      el.classList.toggle('on');
      const h=S.habits.find(x=>x.id===id);
      const head=el.closest('.habit').querySelector('.habit-stat');
      if(h&&head){
        const [yy,mm]=ui.month.split('-').map(Number);
        const days=new Date(yy,mm,0).getDate(); const today=todayISO();
        let done=0,possible=0;
        for(let d=1;d<=days;d++){
          const iso=ui.month+'-'+pad2(d);
          if(iso>today) continue;
          possible++; if(habitDone(h,iso)) done++;
        }
        const st=habitStreak(h);
        head.innerHTML=(st>=3
          ? '<span class="pop">'+st+' day streak</span>'
          : '<span class="num muted" style="font-size:13px">'+st+' day streak</span>')+
          '<span class="num muted" style="font-size:12.5px">'+done+'/'+possible+' this month</span>';
      }
      break;
    }
    case 'day-detail': dayDetail(el.dataset.d); break;
    case 'add-planned': plannedForm(null,el.dataset.d); break;
    case 'edit-planned': plannedForm(S.planned.find(x=>x.id===id)); break;
    case 'add-tx-on': txForm(null,el.dataset.d); break;
    case 'plan-done': {
      const p=S.planned.find(x=>x.id===id); if(!p) break;
      if(!S.accounts.length){ toast('Add an account first'); acctForm(); break; }
      const c=cat(p.categoryId);
      const t={id:uid(),date:p.date,amount:p.amount,type:c.type,
               categoryId:p.categoryId,accountId:S.accounts[0].id,note:p.name};
      S.transactions.push(t); applyToAccount(t,1);
      S.planned=S.planned.filter(x=>x.id!==id);
      save(); closeModal(); render();
      toast('Recorded '+p.name+' — check the account if it was not '+S.accounts[0].name);
      break;
    }
    case 'budget-editor': budgetEditor(); break;
    case 'need-editor': needEditor(); break;
    case 'debt-plan': debtPlanModal(); break;
    case 'debt-analysis': debtAnalysis(); break;
    case 'debt-strategy': S.debtPlan.strategy=el.dataset.v; save(); render(); break;
    case 'use-surplus': { const f=$('#dpPayment'); if(f){ f.value=el.dataset.v; $('#dpMode').value='payment'; } break; }
    case 'save-debt-plan':
      S.debtPlan={mode:$('#dpMode').value,payment:parseFloat($('#dpPayment').value)||0,
                  targetDate:$('#dpDate').value,strategy:$('#dpStrategy').value};
      save(); closeModal(); render(); toast('Plan saved'); break;
    case 'save-needs':
      document.querySelectorAll('[data-need]').forEach(sel=>{ cat(sel.dataset.need).need=(sel.value==='need'); });
      save(); closeModal(); render(); toast('Essentials updated'); break;

    case 'form-submit': { const v=readForm(); if(formSubmit) formSubmit(v); break; }
    case 'debt-include': { const a=acct(id); if(a){ markUndo(); setDebtPlanFlag(id,!inDebtPlan(a)); save(); render(); toast(a.name+(inDebtPlan(a)?' added to':' left out of')+' the payoff plan',true); } break; }
    case 'loan-link-save': { const id=pendingLoanLink; pendingLoanLink=null; const pick=document.querySelector('input[name="loanlink"]:checked');
      if(!pick||!acct(id)){ closeModal(); break; }
      markUndo(); const asset=acct(pick.value); asset.secures=(asset.secures||[]).concat([id]);
      save(); closeModal(); render(); toast(asset.name+' linked to '+acct(id).name,true); break; }
    case 'alloc-accept': { const p=pendingProposal; pendingProposal=null; if(p){ markUndo(); const n=applyAllocationProposal(p); save(); closeModal(); render(); toast(n+' payment'+(n===1?'':'s')+' split into principal and interest',true); } break; }
    case 'confirm-yes': { const f=pendingConfirm; pendingConfirm=null; if(f) f(); break; }
    case 'open-canonical': window.open(CANONICAL_URL,'_blank'); break;
    case 'shot-paste-focus': { const ta=$('#shotText'); if(ta){ ta.focus(); ta.scrollIntoView&&ta.scrollIntoView(); } setShotStatus('Paste the statement text into the box above, then Read them.'); break; }
    case 'shot-read-ai': readShots(); break;
    case 'type-review': typeReviewModal(); break;
    case 'type-use': { const sel=document.querySelector('[data-tsel="'+id+'"]'); if(sel) sel.value=el.dataset.v; break; }
    case 'type-use-all': { document.querySelectorAll('[data-tsel]').forEach(sel=>{ const a=acct(sel.dataset.tsel); const sug=a?suggestAcctType(a):''; if(sug) sel.value=sug; }); break; }
    case 'type-save': applyTypeReview(); break;
    case 'type-nudge-hide': ui.hideTypeNudge=true; render(); break;
    case 'val-add': { const a=acct(id); const amt=($('#valAmt')||{}).value, date=($('#valDate')||{}).value||todayISO();
      if(!a) break;
      if(amt===''||!isFinite(parseFloat(amt))){ toast('Enter the value first'); break; }
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ toast('Pick a date for this valuation'); break; }
      markUndo(); setCheckpoint(a,date,parseFloat(amt)); save(); render(); valuationModal(a); toast('Valued at '+money(parseFloat(amt),{cur:a.cur||baseCur()})+' on '+fmtDate(date),true); break; }
    case 'val-remove': { const a=acct(id); if(!a) break; markUndo(); removeCheckpoint(a,el.dataset.v); save(); render(); valuationModal(a); toast('Valuation removed',true); break; }
    case 'form-delete': if(formDelete) formDelete(); break;

    case 'fetch-rates': fetchRates(); break;
    case 'save-rates':
      S.rates=S.rates||{};
      document.querySelectorAll('[data-rate]').forEach(inp=>{
        const v=parseFloat(inp.value);
        if(v>0) S.rates[inp.dataset.rate]=v; else delete S.rates[inp.dataset.rate];
      });
      S.settings.ratesUpdated=Date.now();
      save(); refreshSettings(); render(); toast('Rates saved'); break;
    case 'save-budgets':
      document.querySelectorAll('[data-budget]').forEach(inp=>{
        const v=parseFloat(inp.value);
        if(v>0) S.budgets[inp.dataset.budget]=v; else delete S.budgets[inp.dataset.budget];
      });
      save(); closeModal(); render(); toast('Limits saved'); break;

    case 'quick-add': {
      const amt=Math.abs(parseFloat($('#qaAmount').value)||0);
      if(!amt){ toast('Enter an amount'); $('#qaAmount').focus(); return; }
      const cid=$('#qaCat').value, c=cat(cid), qc=$('#qaCat');
      const t={id:uid(),date:todayISO(),amount:amt,type:c.type,categoryId:cid,
               accountId:S.accounts[0].id,note:$('#qaNote').value.trim(),
               catSource:qc.dataset.touched?'manual':(qc.dataset.rule?'rule':'default'),source:'manual',createdAt:Date.now()};
      dlog('transaction added',{id:t.id,amount:t.amount,type:t.type,source:'quick-add'});
      if(t.catSource==='rule') t.ruleId=qc.dataset.rule;
      if(filteredUserId()) t.userId=filteredUserId();
      S.transactions.push(t); applyToAccount(t,1); save();
      if(txMonth(t)!==ui.month) ui.month=txMonth(t);
      render(); toast('Added '+money(amt)); break;
    }

    case 'widget-resize': {
      const w=S.settings.widgets.find(x=>x.id===id);
      const cycle=[4,6,8,12];
      w.span=cycle[(cycle.indexOf(w.span)+1)%cycle.length];
      save(); render(); break;
    }
    case 'widget-hide': {
      const w=S.settings.widgets.find(x=>x.id===id);
      w.on=false; save(); render(); toast(WIDGET_TITLES[id]+' hidden — turn it back on in Settings'); break;
    }
    case 'settings-tab': settingsTab=el.dataset.v; refreshSettings(); break;
    case 'parse-test': { const ta=$('#parseTestInput'); if(ta) parseTestInput=ta.value; refreshSettings(); break; }
    case 'parse-test-clear': parseTestInput=''; refreshSettings(); break;
    case 'spend-range': ui.spendRange=el.dataset.v; render(); break;

    case 'add-category':
      S.categories.push({id:uid(),name:'New category',type:'out',color:PALETTE[S.categories.length%PALETTE.length],need:false});
      save(); refreshSettings(); render(); break;
    case 'add-user': personForm(); break;
    case 'del-user': removePerson(id); break;
    case 'del-category': {
      const used=S.transactions.some(t=>t.categoryId===id);
      if(used){ toast('That category is in use — rename it instead'); return; }
      markUndo();
      S.categories=S.categories.filter(c=>c.id!==id); delete S.budgets[id];
      save(); refreshSettings(); render(); toast('Category removed',true); break;
    }

    case 'export-csv': exportCSV(); break;
    case 'export-self': exportSelf(); break;
    case 'embed-use': { const d=embeddedBook(); if(!d) break; const go=async(pw)=>{ let st; try{ const empty=!vaultKey&&!hasLock()&&!S.transactions.length&&!S.accounts.length; if(d.sealed&&empty){ const pt=await openSealed(JSON.stringify(d.sealed),pw,true); st=safeParse(pt); if(adoptOpenedVault()){ vaultPass=pw||''; pendingRekey=pw||''; } } else st=await embeddedState(d,pw); }catch(e){ if(e.needPass||e.wrongPass){ if(e.wrongPass) toast('Wrong passphrase'); passphrasePrompt('This copy is protected','Enter the passphrase the copy was saved with.',go); return; } toast('Could not open the copy: '+errStr(e)); return; } S.settings.embedSeen=String(d.saved||0); await applyRestore(JSON.stringify(st),true); const b=document.getElementById('embedbar'); if(b) b.remove(); S.settings.embedSeen=String(d.saved||0); save(); render(); }; go(); break; }
    case 'embed-keep': { const d=embeddedBook(); S.settings.embedSeen=d?String(d.saved||0):'x'; save(); render(); break; }
    case 'export-json':
      (async()=>{ download('ledger-backup.json',await sealState(2),'application/json');
      S.settings.lastBackup=Date.now(); S.settings.backupNudged=0; save();
      toast(vaultKey?'Backup downloaded — encrypted with your passphrase':'Backup downloaded'); })(); break;
    case 'restore-json': restoreModal(); break;
    case 'merge-book': mergeModal(); break;
    case 'run-merge': runMerge(); break;
    case 'run-restore': runRestore(); break;
    case 'stale-reload': { try{ download('ledger-unsaved-'+todayISO()+'.json',JSON.stringify(S,null,2),'application/json'); toast('Your unsaved changes were downloaded as a backup first'); }catch(e){} setTimeout(()=>location.reload(),400); break; }
    case 'corrupt-download': download('ledger-damaged-'+todayISO()+'.txt',bootCorrupt,'text/plain'); toast('Downloaded — keep it, a backup file may still be recoverable from it'); break;
    case 'corrupt-discard': confirmSheet('Erase the damaged data?','<div style="font-size:14px;line-height:1.6">The unreadable saved book will be replaced by an empty one. Download it first if you have not; there is no way back after this.</div>','Erase and start over',()=>{ bootCorrupt=''; closeModal(); save(); render(); toast('Started over'); },true); break;
    case 'save-retry': (async()=>{ const ok=await saveNow(); toast(ok?'Saved':'Still not saving — download a backup'); render(); })(); break;
    case 'stale-overwrite': saveForce=true; dlog('stale tab overwrote newer revision by choice',{overwrote:staleRev}); save(); toast('Overwritten with this tab’s copy'); break;
    case 'import-csv': importCSV(); break;
    case 'run-import': runImport(); break;
    case 'month-card': monthCardModal(); break;
    case 'card-svg': downloadSVG(buildMonthCard(),'ledger-'+ui.month+'.svg'); break;
    case 'card-png': downloadPNG(buildMonthCard(),'ledger-'+ui.month+'.png',2); break;
    case 'copy-out': copyOut(); break;
    case 'do-copy': {
      const box=$('#copyBox'); if(!box) break;
      box.focus(); box.select();
      const done=()=>toast('Copied — paste it wherever you need');
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(box.value).then(done).catch(()=>{
          try{ document.execCommand('copy'); done(); }
          catch(_){ toast('Select the text and press Ctrl+C'); }
        });
      }else{
        try{ document.execCommand('copy'); done(); }
        catch(_){ toast('Select the text and press Ctrl+C'); }
      }
      break;
    }
    case 'load-sample': loadSample(); if(isDist()) lockOffer(); break;
    case 'reset-data':
      if(el.dataset.confirm){
        markUndo();
        S=Object.assign(freshState(),{settings:Object.assign({},S.settings,{onboarded:true})});
        save(); closeModal(); render(); toast('Ledger cleared',true);
      }else{
        el.dataset.confirm='1'; el.textContent='Tap again to confirm';
        setTimeout(()=>{ if(el.isConnected){ el.removeAttribute('data-confirm'); el.textContent='Clear everything'; } },4000);
      }
      break;
    case 'start-empty':
      S.settings.onboarded=true; save(); closeModal(); render(); if(isDist()) lockOffer(); break;
  }
});

/* veil click-out */
document.addEventListener('mousedown',e=>{
  if(e.target&&e.target.hasAttribute&&e.target.hasAttribute('data-veil')){ discardReview(); closeModal(); }
});

/* keyboard: enter on rows, escape closes, enter submits forms */
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&$('.veil')){ discardReview(); closeModal(); return; }
  /* a dialog keeps Tab inside itself */
  if(e.key==='Tab'&&$('.veil')){ const sheet=$('.sheet'); if(sheet){ const f=Array.from(sheet.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(el=>!el.hidden&&!el.closest('[hidden]')); if(f.length){ const i=f.indexOf(document.activeElement); if(e.shiftKey&&(i<=0)){ e.preventDefault(); f[f.length-1].focus(); } else if(!e.shiftKey&&(i===f.length-1||i<0&&document.activeElement===sheet)){ e.preventDefault(); f[0].focus(); } } } }
  /* keyboard shortcuts: N = new transaction, / = focus search — only when not typing in an input */
  if(!e.ctrl&&!e.meta&&!e.alt&&e.target&&(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT'||e.target.isContentEditable)) return;
  if(e.key==='n'||e.key==='N'){ if(!$('.veil')){ e.preventDefault(); const b=document.querySelector('[data-act="add-tx"]'); if(b) b.click(); } return; }
  if(e.key==='/'){ if(!$('.veil')){ e.preventDefault(); const s=document.querySelector('[data-act="search-tx"],#txSearch'); if(s){ s.focus(); } } return; }
  if(e.key==='Enter'){
    const row=e.target.closest&&e.target.closest('.row.click');
    if(row&&row.dataset.act){ e.preventDefault(); row.click(); return; }
    if(e.target.id&&e.target.id.indexOf('qa')===0){ e.preventDefault(); const b=document.querySelector('[data-act="quick-add"]'); if(b) b.click(); return; }
    if($('.sheet')&&e.target.tagName==='INPUT'&&e.target.type!=='file'){
      const b=document.querySelector('[data-act="form-submit"]'); if(b){ e.preventDefault(); b.click(); }
    }
  }
});

/* live settings inputs */
document.addEventListener('change',e=>{
  if(e.target&&e.target.id==='shotFile'){ addShotFiles(e.target.files); e.target.value=''; return; }
  if(e.target&&e.target.id==='qaCat'){ e.target.dataset.touched='1'; delete e.target.dataset.rule; }
  if(e.target&&e.target.id==='shotAcct'){ shotAcctChosen=!!e.target.value; applyAccountSemantics(); renderReview(); renderHint(); refreshCommitGate(); return; }
  if(e.target&&e.target.id==='f_categoryId'){ formCatTouched=true; formRuleId=null; const c=cat(e.target.value); document.querySelectorAll('[data-chips="dir"] .chip').forEach(ch=>ch.setAttribute('aria-pressed',String(!!c&&ch.dataset.v===c.type))); }
  if(e.target&&e.target.id==='f_accountId'){ const n=$('#f_note'); if(n) n.dispatchEvent(new Event('input',{bubbles:true})); }
  const el=e.target.closest('[data-act]'); if(!el) return;
  const act=el.dataset.act,id=el.dataset.id;
  if(act==='set-currency'){ S.settings.currency=el.value; save(); render(); }
  else if(act==='set-textsize'){ S.settings.textSize=el.value; save(); render(); }
  else if(act==='set-debug'){ S.settings.debug=el.checked; if(el.checked) dlog('debug mode enabled',{version:APP_VERSION}); save(); refreshSettings(); }
  else if(act==='rule-toggle'){ const r=S.rules.find(x=>x.id===id); if(r){ r.on=el.checked; save(); refreshSettings(); } }
  else if(act==='rules-run-refresh'){ rulesRunModal(); }
  else if(act==='set-apikey'){ setKey('apiKey',el.value.trim()); refreshSettings(); }
  else if(act==='set-aimodel'){ S.settings.aiModel=el.value; save(); }
  else if(act==='set-orkey'){ setKey('openrouterKey',el.value.trim()); refreshSettings(); }
  else if(act==='set-ormodel'){ if(el.value==='custom'){ S.settings.orCustom=true; } else { S.settings.openrouterModel=el.value; S.settings.orCustom=false; } save(); refreshSettings(); }
  else if(act==='set-ormodel-custom'){ const v=el.value.trim(); if(v){ S.settings.openrouterModel=v; S.settings.orCustom=true; save(); } }
  else if(act==='rev-on'){ refreshCommitGate(); }
  else if(act==='rev-type'){
    const row=el.closest('.rev'); const sel=row&&row.querySelector('[data-f="categoryId"]'); const rr=row&&revRows[+row.dataset.r]; if(rr){ rr.edited=true; rr.type=el.value; }
    if(sel&&!/^xfer:/.test(el.value)) sel.innerHTML=S.categories.filter(c=>c.type===(el.value==='in'?'in':'out')).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  else if(act==='set-datefmt'){ S.settings.dateFormat=el.value; save(); render(); }
  else if(act==='toggle-widget'){ S.settings.widgets.find(w=>w.id===id).on=el.checked; save(); render(); }
  else if(act==='cat-color'){ cat(id).color=el.value; save(); render(); }
  else if(act==='user-color'){ const u=S.users.find(x=>x.id===id); if(u){ u.color=el.value; save(); render(); refreshSettings(); } }
  else if(act==='set-user-filter'){ ui.user=el.value||'all'; render(); }
  else if(act==='bulk-by'){ readBulkForm(); bulkUI.by=el.value; bulkUI.value=''; bulkUI.preview=null; refreshSettings(); }
  else if(act==='cat-need'){ cat(id).need=(el.value==='need'); save(); render(); }
  else if(act==='cat-type'){ 
    const c=cat(id); c.type=el.value;
    S.transactions.forEach(t=>{ if(t.categoryId===id) t.type=el.value; });
    save(); render();
  }
});
document.addEventListener('input',e=>{
  if(e.target&&e.target.id==='csvPaste'){ previewPaste(); return; }
  if(e.target&&e.target.id==='qaNote'){
    const sel=$('#qaCat'); if(sel&&!sel.dataset.touched){ const r=matchRule(e.target.value,S.accounts[0]&&S.accounts[0].id); if(r){ sel.value=r.categoryId; sel.dataset.rule=r.id; } else delete sel.dataset.rule; }
    return;
  }
  if(e.target&&e.target.id==='f_note'&&$('#f_categoryId')&&!formCatTouched){
    const r=matchRule(e.target.value,($('#f_accountId')||{}).value);
    if(r){ $('#f_categoryId').value=r.categoryId; formRuleId=r.id; } else formRuleId=null;
    return;
  }
  if(e.target&&(e.target.id==='wiSlider'||e.target.id==='wiNum')){
    ui.whatIf.extra=Math.max(0,Math.min(wiMax(),Number(e.target.value)||0));
    clearTimeout(window._wiT); window._wiT=setTimeout(refreshWhatIf,e.target.id==='wiSlider'?40:200);
    return;
  }
  if(e.target&&e.target.id==='txSearch'){
    ui.search=e.target.value;
    clearTimeout(window._sT);
    window._sT=setTimeout(()=>{ render(); const f=$('#txSearch'); if(f){ f.focus(); f.setSelectionRange(f.value.length,f.value.length); } },260);
    return;
  }
  const el=e.target.closest('[data-act="cat-name"]'); if(el){ const c=cat(el.dataset.id); c.name=el.value; save(); return; }
  const uel=e.target.closest('[data-act="user-name"]'); if(uel){ const u=S.users.find(x=>x.id===uel.dataset.id); if(u){ u.name=uel.value; save(); const o=document.querySelector('#userFilter option[value="'+u.id+'"]'); if(o) o.textContent=u.name||'Unnamed'; const atb=$('#addTxBtn'); if(atb&&ui.user===u.id) atb.textContent='Add for '+(u.name||'Unnamed'); } return; }
});

/* paste or drop a screenshot anywhere on the page */
document.addEventListener('paste',e=>{
  const items=Array.from((e.clipboardData||{}).items||[]).filter(i=>i.kind==='file'&&/^image\//.test(i.type));
  if(!items.length) return;
  e.preventDefault();
  addShotFiles(items.map(i=>i.getAsFile()).filter(Boolean));
});
document.addEventListener('dragover',e=>{
  if(Array.from((e.dataTransfer||{}).types||[]).indexOf('Files')<0) return;
  e.preventDefault(); const z=$('#dropzone'); if(z) z.classList.add('over');
});
document.addEventListener('dragleave',e=>{ const z=$('#dropzone'); if(z&&e.target===z) z.classList.remove('over'); });
document.addEventListener('drop',e=>{
  if(e.target.closest&&e.target.closest('.card[data-wid]')&&dragId) return;
  const files=(e.dataTransfer||{}).files; if(!files||!files.length) return;
  e.preventDefault(); const z=$('#dropzone'); if(z) z.classList.remove('over');
  addShotFiles(files);
});

/* test hook — read-only access to the engine for the automated tests in tests/ */
window.__ledger={get S(){return S;},get stagedAccount(){return stagedAccount;},set commitFailAt(v){commitFailAt=v;},saveNow,discardReview,absorbIntoAnchors,unreadLines,twinTransfer,dayBefore,openingFloor,rebookByNumber,lineNamesAccount,numberedAccount,RX_OWN_SCREEN,shotKindClash,isCardPayIn,unsourcedPayments,summaryKey,get myRev(){return myRev;},get staleTab(){return staleTab;},storedRev,unreconciledLiabilities,netWorthIncompleteNote,incomeRecognised,allocSign,applyRestore,txById,isReversal,isReversed,reversalPartner,reversalPairOk,linkReversal,unlinkReversal,reversalCandidates,autoLinkReversals,economicIn,economicOut,reversalLabel,saysReversal,todayISO,unreconciledNote,PDFJS_VERSION,PDFJS_DIR,ensurePdfjs,pdfItemsToText,extractPdfText,get pdfPagesRead(){return pdfPagesRead;},segmentStatement,statementPeriod,parseOCRText,appOrigin,isCanonical,originLabel,originBadge,CANONICAL_URL,statementReconcile,refreshCommitGate,bankHint,merchantPart,channelOf,guessCategory,detectAcctType,statementHeader,matchAccounts,inDebtPlan,debts,debtCandidates,setDebtPlanFlag,simulate,offerLoanLink,monthFlows,allocLabel,allocAssigned,setCheckpoint,allocOf,isLoanPayment,allocPrincipal,allocExpenses,allocEscrow,allocUnresolved,allocState,allocSummary,spendParts,monthLoanPrincipal,monthUnresolved,isInstallmentLoan,proposeAllocation,applyAllocationProposal,isFuture,futureCheckpoints,countsFor,netWorthAt,netWorthSeries,netWorthSeriesAt,valueAt,existsAt,historyStart,undatedAccounts,monthEnd,monthsBack,shiftMonth,balanceSheet,untypedAccounts,suggestAcctType,linksOf,acctGroup,typeKind,acctTypeLabel,ACCT_TYPES,addShotFiles,contentHash,classifyDups,isDup,dupLevel,descKey,srcKey,refFromText,txFingerprint,netWorth,hintType,suggestAccount,applyAccountSemantics,get revRows(){return revRows;},recatPreview,recatApply,transferTargets,getKey,setKey,openKeys,flushKeys,forgetKeys,keysSealed,guessCategory,uncatId,dlog,get DLOG(){ if(!dlogLoaded) loadDlog(); return DLOG; },clearDlog,integrityCheck,explainRules,balanceExplain,repairPlans,fullBackupDiagnostic,validateBackupShape,get importTrace(){return importTrace;},APP_VERSION,detectRecurring,merchantKey,suggestionToRecurring,balanceAsOf,historyFP,closeStatus,closeReview,ensureClose,occurrences,nextDue,removeCheckpoint,governingCheckpoint,effectOn,derivedBalance,recalcBalances,ensureAnchors,setCheckpoint,setBalanceTo,balanceReport,anchorOf,sniffHint,matchAccount,get hint(){return shotHint;},extractWithOpenRouter,extractWithClaude,aiProvider,aiKey,aiModel,get backup(){return {state:backupState,kind:backupKind,lastDiskWrite:lastDiskWrite,lastLocalSave:lastLocalSave,verified:lastDiskVerified,error:lastDiskError,diag:backupDiag};},writeBackupFile,backupSelfTest,canFolderBackup,canLiveBackup,get ui(){return ui;},get lastFocus(){return lastFocus;},get lockWiped(){return lockWiped;},lockDown,resealBackups,passphraseSetupForm,LOCK_DEFAULT,PASS_MIN,cat,lockOffer,mergePlan,mergeBook,extractBookText,guideSteps,THEMES,themeOf,sealState,openSealed,isEnvelope,vaultOn,setLockPassphrase,verifyLockPassphrase,unlockWith,changePassphrase,newRecoveryCodeForVault,looksLikeRecovery,normRecovery,lockEncrypts,loadLock,applyRestore,get lastUnlockHow(){return lastUnlockHow;},get pendingUnlock(){return !!pendingUnlock;},personForm,removePerson,MAX_USERS,selfHTML,embeddedBook,adoptEmbeddedData,exportSelf,isDist,isCanonical,appOrigin,toBase,rateOf,bulkAssignMatches,get bulkUI(){return bulkUI;},bulkAssignApply,bulkAssignPreview,inMonth,inMonthMine,monthFlowsMine,flowsOf,householdRows,filteredUserId,memberFilterOn,txUserVisible,runRecurring,matchRule,applyRule,rulesRunPreview,merchantGuess,projection,goalMath,avgFlows,avgNeed,simulate,save,render,refreshWhatIf,load,healState,html,uid,esc};

/* ============================ boot ============================ */
/* scheduled backup: on boot, if 30+ days since last backup and 25+ transactions,
   silently download a backup to Downloads so data survives a browser storage clear */
async function autoBackupIfNeeded(){
  if(STORAGE_WHERE==='memory') return;
  if(S.transactions.length<25) return;
  const last=S.settings.lastBackup||0;
  const days=(Date.now()-last)/86400000;
  if(days<30) return;
  try{
    download('ledger-backup-'+todayISO()+'.json',await sealState(2),'application/json');
    S.settings.lastBackup=Date.now(); save();
    dlog('auto-backup downloaded',{transactions:S.transactions.length,daysSince:last?Math.floor(days):'never'});
  }catch(e){ /* silent — never interrupt boot over a backup */ }
}
(async function boot(){
  await load();
  try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persist().then(ok=>dlog('persistent storage',{granted:!!ok})).catch(()=>{}); }catch(e){}
  if(isDist()) await adoptEmbeddedData();
  lastLocalSave=S.settings.lastLocalSave||0; myRev=Number(S.settings.rev)||0;
  await restoreBackupHandle();
  if(applySeedRates()) save();
  runRecurring();
  const lockedAtBoot=hasLock()&&!vaultKey;   /* a screen-lock record over a readable book: nothing is drawn until it is satisfied */
  if(lockedAtBoot){ S=freshState(); S.settings.onboarded=true; lockWiped=true; showLock(); }
  else{ render(); if(!S.settings.onboarded) firstRun(); }
  if(pendingRecovery){ const c=pendingRecovery; pendingRecovery=''; saveNow(); setTimeout(()=>recoverySheet(c,'upgraded'),500); }   /* an upgraded book is re-written in the new format at once */
  if(isDist()&&S.settings.onboarded&&!hasLock()&&S.transactions.some(t=>t.source!=='sample')&&!document.getElementById('lockScreen')) setTimeout(()=>lockOffer(),1200);
  if(lastUnlockHow==='recovery'){ lastUnlockHow=''; setTimeout(()=>newPassphraseForm(),600); }
  if(pendingRekey){ const pw=pendingRekey; pendingRekey=''; setTimeout(async()=>{ try{ const code=await changePassphrase(pw); toast('This copy is now protected under a key of its own'); recoverySheet(code,'new'); }catch(e){ dlog('re-key after adoption failed',{error:errStr(e)}); } },900); }
  startLockWatcher();
  setTimeout(autoBackupIfNeeded,3000);
})();

