/* Ledger — part 4 of 7: widget renderers, what-if, board.
   The parts load in order as plain scripts and share one scope; tools/build.js joins them back into
   one closure for the shareable single file. Keep load-time code in the part that defines what it uses. */
"use strict";

/* ============================ widget renderers ============================ */
const R={};

R.networth=function(){
  if(!S.accounts.length) return emptyState('No accounts yet','Add your chequing, savings, or credit card to start tracking net worth.','add-acct','Add an account','accounts');
  const assets=sum(S.accounts.filter(a=>a.kind!=='liability').map(a=>toBase(a.balance,a.cur||baseCur())));
  const debts=sum(S.accounts.filter(a=>a.kind==='liability').map(a=>toBase(a.balance,a.cur||baseCur())));
  const total=assets-debts;
  const series=netWorthSeries(12);
  const first=series[0].value, last=series[series.length-1].value;
  const change=last-first;
  const notes=[];
  if(series.clamped) notes.push('History available from '+monthName(series.from,true)+' — earlier months are not drawn because Ledger has nothing to base them on.');
  if(series.undated.length) notes.push(series.undated.length===S.accounts.length?'No account has an “owned since” date, so its opening balance is carried back through the whole chart. Set one on each account for a truthful early history.':series.undated.length+' account'+(series.undated.length===1?'':'s')+' ('+esc(series.undated.slice(0,3).join(', '))+(series.undated.length>3?', …':'')+') have no “owned since” date, so their opening balance is carried back through the whole chart.');
  if(series.fxConverted) notes.push('Ledger keeps one exchange rate per currency, not a dated history, so every point is converted at today\'s rate — the shape of a foreign-currency balance over time is not FX-accurate.');
  return `
    <div class="eyebrow">Assets minus what you owe</div>
    <div class="figure" style="margin-top:6px">${esc(money(total))}</div>${netWorthIncompleteNote()?`<div class="muted" style="font-size:12.5px;color:var(--accent)">${esc(netWorthIncompleteNote())}</div>`:''}
    <div class="delta ${change>=0?'in':'out'}">${esc(signed(change))} over ${series.length} month${series.length===1?'':'s'}</div>
    ${sparkline(series)}
    ${notes.length?`<div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:6px">${notes.map(esc).join('<br>')}</div>`:''}
    <div style="display:flex;gap:24px;margin-top:12px">
      <div><div class="eyebrow">Assets</div><div class="figure-sm in">${esc(money(assets))}</div></div>
      <div><div class="eyebrow">Owed</div><div class="figure-sm out">${esc(money(debts))}</div></div>
    </div>`;
};

function sparkline(series){
  const vals=series.map(s=>s.value);
  if(vals.length<2) return '';
  let min=Math.min.apply(null,vals), max=Math.max.apply(null,vals);
  if(max===min){max=min+1;min=min-1;}
  const pad=(max-min)*0.12; min-=pad; max+=pad;
  const W=300,H=80;
  const pts=vals.map((v,i)=>{
    const x=(i/(vals.length-1))*W;
    const y=H-((v-min)/(max-min))*H;
    return [x,y];
  });
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area=line+` L ${W} ${H} L 0 ${H} Z`;
  const lastPt=pts[pts.length-1];
  const zeroY=(0>=min&&0<=max)?(H-((0-min)/(max-min))*H):null;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Net worth trend">
    ${zeroY!==null?`<line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="var(--rule-strong)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`:''}
    <path d="${area}" fill="var(--in)" opacity=".10"/>
    <path d="${line}" fill="none" stroke="var(--in)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="3" fill="var(--in)" vector-effect="non-scaling-stroke"/>
  </svg>
  <div style="display:flex;justify-content:space-between" class="muted"><span class="num" style="font-size:11px">${esc(monthName(series[0].key))}</span><span class="num" style="font-size:11px">${esc(monthName(series[series.length-1].key))}</span></div>`;
}

R.cashflow=function(){
  const _pr=monthLoanPrincipal(ui.month), _un=monthUnresolved(ui.month);
  const loanNote=_pr||_un?`<div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:8px">${[_pr?money(_pr)+' of loan payments went to principal — cash out, but not spending: it moved straight into what you owe':'',_un?money(_un)+' of loan payments is not allocated yet, so it counts as neither':''].filter(Boolean).join('<br>')}</div>`:'';
  const keys=monthsBack(6);
  const data=keys.map(k=>({key:k,f:monthFlowsMine(k)}));
  const max=Math.max(1,...data.map(d=>Math.max(d.f.in,d.f.out)));
  if(!S.transactions.length) return emptyState('Nothing recorded yet','Add a few transactions and the last six months of income and spending will show up here.','add-tx','Add a transaction','transactions');
  const cur=monthFlowsMine(ui.month);
  const net=cur.in-cur.out;
  /* household breakdown: only when viewing the whole household and members exist.
     Partitions this month's income by user — reuses economicIn/amtBase, no parallel math. */
  let hhNote='';
  if((ui.user||'all')==='all'&&S.users.length){
    const txs=inMonth(ui.month).filter(economicIn);
    const byId={}; let un=0;
    txs.forEach(t=>{ if(t.userId){ byId[t.userId]=(byId[t.userId]||0)+amtBase(t); } else un+=amtBase(t); });
    const parts=S.users.map(u=>({n:u.name,c:u.color,v:byId[u.id]||0})).filter(p=>p.v>0.005);
    if(un>0.005) parts.push({n:'Unassigned',c:'var(--ink-3)',v:un});
    if(parts.length>1){
      const bar=parts.map(p=>`<i style="flex:${p.v};background:${esc(p.c)}" title="${esc(p.n)} · ${esc(money(p.v))}"></i>`).join('');
      hhNote=`<div style="margin-top:10px"><div class="eyebrow">Income by member</div>
        <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin:5px 0 7px;background:var(--rule)">${bar}</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px 16px;font-size:12.5px" class="muted">${parts.map(p=>`<span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${esc(p.c)};margin-right:5px;vertical-align:middle"></i>${esc(p.n)} <b class="num">${esc(money(p.v))}</b></span>`).join('')}</div></div>`;
    }
  }
  return `
    <div style="display:flex;gap:22px;flex-wrap:wrap">
      <div><div class="eyebrow">In</div><div class="figure-sm in">${esc(money(cur.in))}</div></div>
      <div><div class="eyebrow">Out</div><div class="figure-sm out">${esc(money(cur.out))}</div></div>
      <div><div class="eyebrow">Net</div><div class="figure-sm ${net>=0?'in':'out'}">${esc(signed(net))}</div></div>
    </div>${loanNote}${hhNote}
    <div class="flowchart">
      ${data.map(d=>`
        <div class="flowcol">
          <div class="flowbars" title="${esc(monthName(d.key))} · in ${esc(money(d.f.in))} · out ${esc(money(d.f.out))}">
            <i style="height:${(d.f.in/max*100).toFixed(1)}%;background:var(--in)"></i>
            <i style="height:${(d.f.out/max*100).toFixed(1)}%;background:var(--out)"></i>
          </div>
          <div class="flowlabel"${d.key===ui.month?' style="color:var(--ink);font-weight:600"':''}>${esc(monthName(d.key).split(' ')[0])}</div>
        </div>`).join('')}
    </div>`;
};

/* ---------- your first month: a checklist that reads the real state of the book ----------
   Each step is done when the book says so, not when a box was ticked. The card hides itself when all
   six are done, and the × on the card hides it for good. */
function guideSteps(){
  const imported=S.transactions.some(t=>t.source==='scan'||t.source==='paste'||t.source==='csv');
  const real=S.transactions.some(t=>t.source!=='sample');
  return [
    {id:'account',title:'Add an account with today\'s balance',why:'Balances are worked out from a balance you confirm plus what happens after it.',done:S.accounts.some(a=>a.name),act:'add-acct',label:'Add an account'},
    {id:'statement',title:'Bring in a bank statement',why:'Paste the statement text or drop the PDF; Ledger checks the rows against the bank\'s own totals before adding them.',done:imported||(real&&S.transactions.filter(t=>t.source!=='sample').length>=10),act:'import-shots',label:'Scan a statement'},
    {id:'person',title:'Add the people in your household',why:'Pick a person in the top bar and what you add is theirs. “All users (household)” shows everyone together.',done:S.users.length>0,act:'add-person',label:'Add a person'},
    {id:'tag',title:'Tag transactions to people',why:'Tag rows one at a time, or many at once in Settings › Household.',done:S.transactions.some(t=>t.userId&&t.source!=='sample'),act:'open-household',label:'Tag many at once'},
    {id:'lock',title:'Protect it with a passphrase',why:'The book is encrypted with it everywhere it is stored, and you get a recovery code for the day you forget it.',done:lockEncrypts(),act:'lock-setup',label:'Set a passphrase'},
    {id:'backup',title:'Keep a copy',why:isDist()?'A copy with your data inside opens anywhere, with everything in it.':'A backup file restores everything if this browser is ever cleared.',done:!!S.settings.lastBackup,act:isDist()?'export-self':'export-json',label:isDist()?'Save a copy with my data inside':'Back up now'}
  ];
}
R.guide=function(){
  const steps=guideSteps(); const n=steps.filter(s=>s.done).length;
  return `<div class="muted" style="font-size:13.5px;line-height:1.5;margin-bottom:10px">Six steps and the household picture is real. ${n} of ${steps.length} done${n===steps.length?' — this card will go away on its own':''}. Hide it any time with the × above.</div>
    <div class="guide">${steps.map((s,i)=>`<div class="guide-step${s.done?' done':''}">
      <div class="guide-mark" aria-hidden="true">${s.done?'✓':i+1}</div>
      <div class="grow"><div class="name">${esc(s.title)}</div><div class="sub" style="white-space:normal">${esc(s.why)}</div></div>
      ${s.done?'':`<button class="btn btn-sm" data-act="${s.act}">${esc(s.label)}</button>`}
    </div>`).join('')}</div>`;
};

/* ---------- household: people ----------
   Adding a person happens in the top bar, next to the filter that shows their transactions, because that
   is where the idea lives: each person enters their own rows, All users is the household together. */
const MAX_USERS=5;
function personForm(u){
  const isNew=!u;
  if(isNew&&S.users.length>=MAX_USERS){ toast('Up to '+MAX_USERS+' people in a household'); return; }
  u=u||{name:'',color:PALETTE[S.users.length%PALETTE.length]};
  openForm({
    title:isNew?'Add a person':'Edit person',
    fields:[
      {name:'name',label:'Name',type:'text',value:u.name,placeholder:'e.g. Alex'},
      {name:'color',label:'Colour',type:'color',value:u.color}
    ],
    note:isNew?'Pick this person in the top bar and everything you add is theirs. Choose “All users (household)” to see everyone together.':'',
    onDelete:isNew?null:()=>{ closeModal(); removePerson(u.id); },
    onSubmit:v=>{
      const name=(v.name||'').trim(); if(!name){ toast('Give them a name'); return false; }
      if(isNew){ const nu={id:uid(),name:name,color:v.color||u.color}; S.users.push(nu); ui.user=nu.id; save(); closeModal(); render(); refreshSettingsIfOpen(); toast(name+' added — what you add now is theirs; All users shows the household'); }
      else{ u.name=name; u.color=v.color||u.color; save(); closeModal(); render(); refreshSettingsIfOpen(); toast('Saved'); }
    }
  });
}
function removePerson(id){
  const u=S.users.find(x=>x.id===id); if(!u) return;
  markUndo();
  S.transactions.forEach(t=>{ if(t.userId===id) delete t.userId; });
  (S.recurring||[]).forEach(r=>{ if(r.userId===id) delete r.userId; });
  S.users=S.users.filter(x=>x.id!==id);
  if(ui.user===id) ui.user='all';
  save(); refreshSettingsIfOpen(); render(); toast((u.name||'Member')+' removed — their transactions are now unassigned',true);
}
function refreshSettingsIfOpen(){ if(document.querySelector('[data-act="settings-tab"]')) refreshSettings(); }

/* ---------- household: tag many rows at once ----------
   Matches plain income/spending rows (never transfers — they belong to accounts, not people) by merchant
   text, category or account. Untagged rows only, unless told to re-tag. Preview first, apply is undoable. */
let bulkUI={userId:'',by:'merchant',value:'',retag:false,preview:null};
function bulkAssignMatches(c){
  const v=(c.value||'').trim(); if(!c.userId||!v) return [];
  const nv=normText(v);
  return S.transactions.filter(t=>{
    if(isTransfer(t)) return false;
    if(t.userId&&(!c.retag||t.userId===c.userId)) return false;
    if(c.by==='merchant') return nv.length>=2&&normText(t.note||'').indexOf(nv)>=0;
    if(c.by==='category') return t.categoryId===v;
    if(c.by==='account') return t.accountId===v;
    return false;
  });
}
function readBulkForm(){
  const g=id=>$('#'+id);
  if(g('bulkUser')) bulkUI.userId=g('bulkUser').value;
  if(g('bulkBy')) bulkUI.by=g('bulkBy').value;
  if(g('bulkValue')) bulkUI.value=g('bulkValue').value;
  if(g('bulkRetag')) bulkUI.retag=!!g('bulkRetag').checked;
}
function bulkAssignHTML(){
  const b=bulkUI, u=S.users.find(x=>x.id===b.userId);
  const valueField=b.by==='category'?`<select id="bulkValue" style="width:auto">${S.categories.map(c=>`<option value="${c.id}"${c.id===b.value?' selected':''}>${esc(c.name)}</option>`).join('')}</select>`
    :b.by==='account'?`<select id="bulkValue" style="width:auto">${S.accounts.map(a=>`<option value="${a.id}"${a.id===b.value?' selected':''}>${esc(a.name)}</option>`).join('')}</select>`
    :`<input type="text" id="bulkValue" value="${esc(b.value)}" placeholder="e.g. PAYROLL or Netflix" style="flex:1;min-width:140px">`;
  const pv=b.preview;
  const result=pv?(pv.n?`<div style="margin-top:9px;font-size:13.5px"><b>${pv.n}</b> row${pv.n===1?'':'s'} (${esc(money(pv.total))}) would be tagged to <b>${esc(u?u.name:'?')}</b>${pv.sample.length?` — e.g. ${pv.sample.map(esc).join(', ')}`:''}. <button class="btn btn-sm btn-primary" data-act="bulk-assign-apply" style="margin-left:6px">Tag them</button></div>`
    :`<div class="muted" style="margin-top:9px;font-size:13px">No untagged rows match${b.retag?'':' — tick “also re-tag” to include rows already assigned to someone else'}.</div>`):'';
  return `<div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--rule)">
    <div class="eyebrow" style="margin-bottom:6px">Tag many rows at once</div>
    <div class="muted" style="font-size:13px;line-height:1.5;margin-bottom:10px">Everything whose description contains a word, or that sits in a category or account, goes to one member. Transfers are never tagged — they move money between accounts, not people. You see a count before anything changes, and it can be undone.</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <select id="bulkUser" style="width:auto"><option value="">— member —</option>${S.users.map(x=>`<option value="${x.id}"${x.id===b.userId?' selected':''}>${esc(x.name)}</option>`).join('')}</select>
      <select id="bulkBy" data-act="bulk-by" style="width:auto"><option value="merchant"${b.by==='merchant'?' selected':''}>Description contains</option><option value="category"${b.by==='category'?' selected':''}>Category is</option><option value="account"${b.by==='account'?' selected':''}>Account is</option></select>
      ${valueField}
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:0"><input type="checkbox" id="bulkRetag" ${b.retag?'checked':''} style="width:auto;margin:0">also re-tag rows already assigned</label>
      <button class="btn btn-sm" data-act="bulk-assign-preview">Preview</button>
    </div>${result}</div>`;
}
function bulkAssignPreview(){
  readBulkForm();
  if(!bulkUI.userId){ toast('Pick a member first'); return; }
  const m=bulkAssignMatches(bulkUI);
  bulkUI.preview={n:m.length,total:sum(m.map(amtBase)),sample:[...new Set(m.map(t=>t.note).filter(Boolean))].slice(0,3)};
  refreshSettings();
}
function bulkAssignApply(){
  readBulkForm();
  const m=bulkAssignMatches(bulkUI); const u=S.users.find(x=>x.id===bulkUI.userId);
  if(!u||!m.length){ toast('Nothing to tag'); return; }
  markUndo(); m.forEach(t=>{ t.userId=u.id; t.updatedAt=Date.now(); });
  dlog('bulk member tag',{member:u.name,by:bulkUI.by,value:bulkUI.value,rows:m.length});
  bulkUI.preview=null; save(); render(); refreshSettings();
  toast(m.length+' row'+(m.length===1?'':'s')+' tagged to '+u.name,true);
}

/* ---------- household: each member's month next to the household total ---------- */
function householdRows(key){
  const t=inMonth(key), byId={}, un=[];
  t.forEach(x=>{ if(x.userId&&S.users.some(u=>u.id===x.userId)) (byId[x.userId]=byId[x.userId]||[]).push(x); else un.push(x); });
  const rows=S.users.map(u=>Object.assign({id:u.id,name:u.name||'Unnamed',color:u.color,n:(byId[u.id]||[]).length},flowsOf(byId[u.id]||[])));
  const unF=flowsOf(un); rows.push(Object.assign({id:'',name:'Unassigned',color:'var(--ink-3)',n:un.length,unassigned:true},unF));
  const all=flowsOf(t);
  return {rows:rows,all:all};
}
R.household=function(){
  if(!S.users.length) return emptyState('Nobody in the household yet','Add a person, pick them in the top bar, and what they enter is theirs. This card shows each person\'s income and spending next to the household total.','add-person','Add a person','transactions');
  const h=householdRows(ui.month), all=h.all;
  const shown=h.rows.filter(r=>!r.unassigned||r.n>0);
  const pct=(v)=>all.in>0.005?(v/all.in*100).toFixed(0)+'%':'—';
  const num=(label,v,cls,extra)=>`<div class="r num ${extra||''}"${cls?' style="color:var(--'+cls+')"':''}><span class="k">${label}</span>${esc(v)}</div>`;
  const unNote=shown.some(r=>r.unassigned)?`<div class="muted" style="font-size:12.5px;margin-top:9px">Unassigned rows are counted in the household total but belong to nobody yet — pick “Unassigned” in the top-bar filter to find and tag them.</div>`:'';
  return `
    <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:6px">
      <div><div class="eyebrow">Household in</div><div class="figure-sm in">${esc(money(all.in))}</div></div>
      <div><div class="eyebrow">Household out</div><div class="figure-sm out">${esc(money(all.out))}</div></div>
      <div><div class="eyebrow">Net</div><div class="figure-sm ${all.in-all.out>=0?'in':'out'}">${esc(signed(all.in-all.out))}</div></div>
    </div>
    <div class="hh">
      <div class="h who">Member</div><div class="h num">In</div><div class="h num">Out</div><div class="h num">Net</div><div class="h num share">Share of income</div>
      ${shown.map(r=>`<div class="r who"${r.unassigned?' style="color:var(--ink-3)"':''}><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${esc(r.color)};margin-right:7px;vertical-align:middle"></i>${esc(r.name)} <span class="muted rows" style="font-size:12px">· ${r.n} row${r.n===1?'':'s'}</span></div>
        ${num('In',money(r.in),'in')}${num('Out',money(r.out),'out')}${num('Net',signed(r.in-r.out),r.in-r.out>=0?'in':'out')}${num('Share',pct(r.in),'','share')}`).join('')}
    </div>${unNote}${S.users.length<MAX_USERS?`<div style="margin-top:10px"><button class="btn btn-sm" data-act="add-person">Add a person</button></div>`:''}`;
};

R.transactions=function(){
  const q=(ui.search||'').trim().toLowerCase();
  const searching=q.length>0;
  const pool=searching?S.transactions.filter(txUserVisible):inMonthMine(ui.month);
  const match=t=>{
    if(!searching) return true;
    const c=isTransfer(t)?{name:'transfer'}:cat(t.categoryId);
    const a=isTransfer(t)?(acct(t.fromId)||{}).name+' '+(acct(t.toId)||{}).name:(acct(t.accountId)||{}).name||'';
    return ((t.note||'')+' '+c.name+' '+a+' '+t.amount).toLowerCase().indexOf(q)>=0;
  };
  const list=pool.filter(match).slice().sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
  const outCats=S.categories.filter(c=>c.type==='out');
  const notes=[...new Set(S.transactions.map(t=>t.note).filter(Boolean))].slice(-40).reverse();
  const quick=S.accounts.length&&outCats.length?`
    <div class="quickadd">
      <input type="number" step="0.01" inputmode="decimal" id="qaAmount" placeholder="Amount" aria-label="Amount" style="max-width:110px">
      <select id="qaCat" aria-label="Category">${S.categories.map(c=>`<option value="${c.id}"${c.id===outCats[0].id?' selected':''}>${esc(c.name)}</option>`).join('')}</select>
      <input type="text" id="qaNote" placeholder="Note (optional)" aria-label="Note" list="noteList" autocomplete="off">
      <datalist id="noteList">${notes.map(n=>`<option value="${esc(n)}"></option>`).join('')}</datalist>
      <button class="btn" data-act="quick-add">Add</button>
      <button class="btn btn-ghost" data-act="add-transfer" title="Move money between your own accounts">Move money</button>
      <button class="btn btn-ghost" data-act="import-shots" title="Read transactions out of a screenshot, receipt, bill or PDF">Scan a screenshot / bill</button>
      <button class="btn btn-ghost" data-act="import-csv" title="Paste several at once">Paste rows</button>
    </div>` : '';
  const search=S.transactions.length>12?`
    <div style="display:flex;gap:7px;margin-bottom:12px;align-items:center">
      <input type="search" id="txSearch" placeholder="Search all transactions…" aria-label="Search transactions" value="${esc(ui.search||'')}">
      ${searching?`<button class="btn btn-sm btn-ghost" data-act="clear-search">Clear</button>`:''}
    </div>` : '';
  if(!list.length){
    const msg=searching?emptyState('Nothing matches "'+(ui.search||'')+'"','Try fewer words, or part of an amount.','clear-search','Clear the search')
      :emptyState('No entries for '+monthName(ui.month,true),'Anything you add lands here, newest first.','add-tx','Add a transaction','transactions');
    return quick+search+msg;
  }
  const cap=searching?25:14;
  const rows=list.slice(0,cap).map(t=>{
    if(isTransfer(t)){
      const f=acct(t.fromId), to=acct(t.toId);
      return `<div class="row click" data-act="edit-transfer" data-id="${t.id}" tabindex="0" role="button">
        <span class="dot" style="background:transparent;border:1.5px solid var(--ink-3)"></span>
        <div class="grow">
          <div class="name">${esc(t.note||'Transfer')}${isFuture(t)?' <span class="tag">Future transaction</span>':''}${isLoanPayment(t)?' <span class="tag'+(allocState(t)==='known'?'':' warn')+'">'+esc(allocLabel(t))+'</span>':''}</div>
          <div class="sub">${esc(fmtDate(t.date))} · ${esc((f||{}).name||'?')} → ${esc((to||{}).name||'?')}${isFuture(t)?' · not in today\'s balances until '+esc(fmtDate(t.date)):''}${isLoanPayment(t)?'<div style="margin-top:2px">'+esc(allocSummary(t))+'</div>':''}</div>
        </div>
        <div class="num muted" style="font-size:14.5px">${esc(money(t.amount))}</div>
      </div>`;
    }
    const c=cat(t.categoryId), a=acct(t.accountId);
    return `<div class="row click${isFuture(t)?' future':''}" data-act="edit-tx" data-id="${t.id}" tabindex="0" role="button">
      <span class="dot" style="background:${esc(c.color)}"></span>
      <div class="grow">
        <div class="name">${esc(t.note||c.name)}${isFuture(t)?' <span class="tag">Future transaction</span>':''}${reversalPartner(t)?' <span class="tag">'+(isReversal(t)?'Reversal':'Reversed')+'</span>':''}${isCardPayIn(t)?' <span class="tag warn">Payment, source unknown</span>':''}</div>
        <div class="sub">${esc(fmtDate(t.date))} · ${esc(c.name)}${a?' · '+esc(a.name):''}${t.auto?' · auto':''}${isFuture(t)?' · not in today\'s balance until '+esc(fmtDate(t.date)):''}${reversalPartner(t)?' · '+esc(reversalLabel(t)):''}</div>
      </div>
      <div class="num ${t.type==='in'?'in':'out'}" style="font-size:14.5px">${esc((t.type==='in'?'+':'\u2212')+money(t.amount,{cur:curOfTx(t)}))}</div>
    </div>`;
  }).join('');
  const more=list.length>cap?`<div class="muted" style="font-size:13px;padding-top:10px">${list.length-cap} more${searching?' match'+(list.length-cap===1?'':'es'):' this month'}.</div>`:'';
  const found=searching?`<div class="muted" style="font-size:12.5px;margin-bottom:8px">${list.length} match${list.length===1?'':'es'} across every month</div>`:'';
  return quick+search+found+rows+more;
};

R.balancesheet=function(){
  if(!S.accounts.length) return emptyState('Nothing on the balance sheet yet','Add what you own — bank accounts, investments, a home, a car — and what you owe, and Ledger works out your net worth.','add-acct','Add an account','balancesheet');
  const bs=balanceSheet(); const untyped=untypedAccounts();
  const nudge=untyped.length&&!ui.hideTypeNudge?`<div class="verdict" style="margin:0 0 12px"><b>${untyped.length} account${untyped.length===1?'':'s'} need${untyped.length===1?'s':''} a type</b> before all balance-sheet metrics are fully accurate — net worth is already right, but grouping, liquid net worth and equity are not.
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm btn-primary" data-act="type-review">Review account types</button><button class="btn btn-sm btn-ghost" data-act="type-nudge-hide">Not now</button></div></div>`:'';
  const row=a=>`<div class="row click" data-act="edit-acct" data-id="${a.id}" tabindex="0" role="button">
      <div class="grow"><div class="name">${esc(a.name)}</div><div class="sub">${esc(acctTypeLabel(a))}${a.institution?' · '+esc(a.institution):''}${unreconciledNote(a)?' · <span style="color:var(--accent)">'+esc(unreconciledNote(a))+'</span>':''}${a.valued==='checkpoints'&&a.checkpoints&&a.checkpoints.length?' · valued '+esc(fmtDate(a.checkpoints[a.checkpoints.length-1].date)):''}${!a.acctType?' · <span style="color:var(--accent)">set a type</span>':''}</div></div>
      <div class="num" style="font-size:14.5px">${balanceLabel(a)}</div></div>`;
  const side=kind=>bs.groups.filter(g=>g.kind===kind&&g.accounts.length).map(g=>`<div class="eyebrow" style="margin:10px 0 2px">${esc(g.label)}</div>${g.accounts.map(row).join('')}${g.accounts.length>1?`<div class="row" style="border:0;padding:2px 0 0"><div class="grow sub">${esc(g.label)} total</div><div class="num sub">${esc(money(g.total))}</div></div>`:''}`).join('');
  const total=(label,v,cls)=>`<div class="totalrule" style="display:flex;align-items:baseline"><span class="eyebrow" style="margin-right:auto">${esc(label)}</span><span class="num ${cls||''}" style="font-size:16px;font-weight:600">${esc(money(v))}</span></div>`;
  const eqCard=x=>`<div class="row" style="border:0;padding:4px 0"><div class="grow"><div class="name">${esc(x.account.name)}</div><div class="sub">${x.loans.length?'minus '+esc(x.loans.map(l=>l.name).join(', ')):'no loan linked'}</div></div><div class="num" style="text-align:right"><div>${esc(money(x.value))}</div>${x.loans.length?`<div class="sub">− ${esc(money(x.owed))}</div>`:''}<div style="font-weight:600">${esc(money(x.equity))} equity</div></div></div>`;
  const stat=(label,v)=>`<div><div class="eyebrow">${esc(label)}</div><div class="figure-sm ${v<0?'out':''}">${esc(money(v))}</div></div>`;
  return nudge+`<div class="grid2" style="gap:18px 28px">
    <div><div class="eyebrow" style="font-weight:700;color:var(--in)">What you own</div>${side('asset')}${total('Total assets',bs.assets,'in')}</div>
    <div><div class="eyebrow" style="font-weight:700;color:var(--out)">What you owe</div>${side('liability')||'<div class="muted" style="margin:8px 0">No debt on the books.</div>'}${total('Total liabilities',bs.liabilities,'out')}</div>
  </div>
  <div class="totalrule" style="display:flex;align-items:baseline;margin-top:14px"><span class="eyebrow" style="margin-right:auto;font-weight:700">Net worth = assets − liabilities</span><span class="num" style="font-size:20px;font-weight:700">${esc(money(bs.netWorth))}</span></div>
  ${netWorthIncompleteNote()?`<div class="verdict" style="margin-top:8px"><b>${esc(netWorthIncompleteNote())}</b> — ${esc(unreconciledLiabilities().map(a=>a.name).join(', '))}. Their figures are payments and hand entries, not statements; import a statement or reconcile each one to make this number complete.</div>`:''}
  <div style="display:flex;flex-wrap:wrap;gap:18px 28px;margin-top:12px">${stat('Liquid net worth',bs.liquid)}${stat('Investment assets',bs.investments)}${stat('Real-estate equity',bs.realEstateEquity)}${stat('Vehicle equity',bs.vehicleEquity)}${stat('Total debt',bs.totalDebt)}</div>
  ${bs.realEstate.length||bs.vehicles.length?`<div class="eyebrow" style="margin-top:14px">Equity (for information — already counted above)</div>${bs.realEstate.concat(bs.vehicles).map(eqCard).join('')}`:''}
  <div class="muted" style="font-size:12.5px;margin-top:10px">Liquid = cash &amp; bank minus credit cards and lines of credit. Equity = value minus the loans linked to it; it is not added to net worth a second time.</div>`;
};
R.accounts=function(){
  if(!S.accounts.length) return emptyState('No accounts yet','Track balances for anything: bank, credit card, investments.','add-acct','Add an account','accounts');
  const grp=(kind)=>S.accounts.filter(a=>(kind==='liability')===(a.kind==='liability'));
  const block=(title,arr)=>arr.length?`<div class="eyebrow" style="margin:10px 0 2px">${title}</div>`+arr.map(a=>`
    <div class="row click" data-act="edit-acct" data-id="${a.id}" tabindex="0" role="button">
      <div class="grow"><div class="name">${esc(a.name)}</div><div class="sub">${esc(a.label||acctTypeLabel(a))}${(a.cur&&a.cur!==baseCur())?' · '+esc(a.cur):''}${unreconciledNote(a)?' · <span style="color:var(--accent)">'+esc(unreconciledNote(a))+'</span>':''}</div></div>
      <div class="num" style="font-size:14.5px">${balanceLabel(a)}</div>
    </div>`).join(''):'';
  return block('Assets',grp('asset'))+block('Owed',grp('liability'))+`
    <div class="totalrule" style="display:flex;align-items:baseline">
      <span class="eyebrow" style="margin-right:auto">Net</span>
      <span class="num" style="font-size:17px;font-weight:600">${esc(money(netWorth()))}</span>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px"><button class="btn btn-sm" data-act="add-acct">Add account</button><button class="btn btn-sm" data-act="close-month" data-v="${ui.month}">Monthly close</button>${(()=>{ const r=S.closes.filter(c=>closeStatus(c)==='review'); return r.length?`<button class="btn btn-sm" data-act="close-history" style="color:var(--out)">${r.length} close${r.length===1?' needs':'s need'} review</button>`:''; })()}</div>`;
};

R.budgets=function(){
  const set=S.categories.filter(c=>c.type==='out'&&Number(S.budgets[c.id])>0);
  if(!set.length) return emptyState('No limits set','Give a category a monthly ceiling and you can watch it fill up.','budget-editor','Set monthly limits');
  const spentBy={};
  spendParts(inMonth(ui.month)).forEach(p=>{spentBy[p.categoryId]=(spentBy[p.categoryId]||0)+spendBase(p);});
  const rows=set.map(c=>{
    const limit=Number(S.budgets[c.id]), spent=spentBy[c.id]||0;
    return {c,limit,spent,pct:spent/limit};
  }).sort((a,b)=>b.pct-a.pct);
  const totL=sum(rows.map(r=>r.limit)), totS=sum(rows.map(r=>r.spent));
  return rows.map(r=>`
    <div style="padding:9px 0;border-bottom:1px solid var(--rule)">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <span class="dot" style="background:${esc(r.c.color)}"></span>
        <span style="font-size:14.5px;margin-right:auto">${esc(r.c.name)}</span>
        <span class="num" style="font-size:13px">${esc(money(r.spent,{round:true}))} / ${esc(money(r.limit,{round:true}))}</span>
      </div>
      <div class="bar"><i style="width:${Math.min(100,r.pct*100).toFixed(1)}%;background:${r.pct>1?'var(--out)':esc(r.c.color)}"></i></div>
      ${r.pct>1?`<div class="num out" style="font-size:12px;margin-top:5px">${esc(money(r.spent-r.limit))} over</div>`:''}
    </div>`).join('')+`
    <div class="totalrule" style="display:flex;align-items:baseline">
      <span class="eyebrow" style="margin-right:auto">All limits</span>
      <span class="num" style="font-size:15px">${esc(money(totS))} / ${esc(money(totL))}</span>
    </div>
    <button class="btn btn-sm" data-act="budget-editor" style="margin-top:12px">Edit limits</button>`;
};

R.spending=function(){
  const range=ui.spendRange;
  let keys;
  if(range==='month') keys=[ui.month];
  else if(range==='3m') keys=monthsBack(3);
  else keys=monthsBack(12);
  const txs=spendParts(S.transactions.filter(t=>keys.indexOf(txMonth(t))>=0&&txUserVisible(t)));
  const chips=`<div class="chips" style="margin-bottom:14px">
    ${[['month','This month'],['3m','3 months'],['12m','Year']].map(([v,l])=>
      `<button class="chip" data-act="spend-range" data-v="${v}" aria-pressed="${range===v}">${l}</button>`).join('')}
  </div>`;
  if(!txs.length) return chips+emptyState('Nothing spent in this window','Once expenses are recorded, the split by category shows here.','add-tx','Add a transaction','transactions');
  const by={};
  txs.forEach(p=>{by[p.categoryId]=(by[p.categoryId]||0)+spendBase(p);});
  const items=Object.keys(by).map(id=>({c:cat(id),v:by[id]})).sort((a,b)=>b.v-a.v);
  const total=sum(items.map(i=>i.v));
  const r=54,C=2*Math.PI*r; let off=0;
  const ring=items.map(i=>{
    const len=(i.v/total)*C;
    const seg=`<circle cx="70" cy="70" r="${r}" fill="none" stroke="${esc(i.c.color)}" stroke-width="21"
      stroke-dasharray="${(len-1.5>0?len-1.5:len).toFixed(2)} ${(C-len+1.5).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 70 70)"><title>${esc(i.c.name)} ${esc(money(i.v))}</title></circle>`;
    off+=len; return seg;
  }).join('');
  return chips+`<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    <svg width="140" height="140" viewBox="0 0 140 140" style="flex:none" role="img" aria-label="Spending by category">
      <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="21"/>
      ${ring}
      <text x="70" y="66" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="15" font-weight="500" fill="var(--ink)">${esc(money(total,{round:true}))}</text>
      <text x="70" y="82" text-anchor="middle" font-family="Archivo,sans-serif" font-size="8.5" letter-spacing="1.2" fill="var(--ink-3)">SPENT</text>
    </svg>
    <div style="flex:1;min-width:170px">
      ${items.slice(0,7).map(i=>`
        <div class="row" style="padding:5px 0;border:0">
          <span class="dot" style="background:${esc(i.c.color)}"></span>
          <span class="grow name">${esc(i.c.name)}${i.c.id==='c0'?' <span style="color:var(--accent);font-size:11px;letter-spacing:.08em;text-transform:uppercase">needs review</span>':''}</span>
          <span class="num muted" style="font-size:12px">${(i.v/total*100).toFixed(0)}%</span>
          <span class="num" style="font-size:13.5px;min-width:74px;text-align:right">${esc(money(i.v))}</span>
        </div>`).join('')}
      ${items.length>7?`<div class="muted" style="font-size:12.5px;padding-top:4px">+ ${items.length-7} smaller categories</div>`:''}
    </div>
  </div>`;
};

R.goals=function(){
  if(!S.goals.length) return emptyState('No goals yet','Name something you are saving for, give it a date, and Ledger works out what you need to put away each week, month and year.','add-goal','Add a goal');
  return S.goals.map(g=>{
    const pct=g.target>0?Math.min(1,g.saved/g.target):0;
    const m=goalMath(g);
    const line=!g.deadline?'No date yet — add one to see what you need per week and month.'
      : m.done?'Reached'
      : m.overdue?'Past due — '+money(m.remaining,{round:true})+' still to go'
      : 'By '+fmtDate(g.deadline)+' · '+fmtSpan(m.days)+' left · <b style="color:var(--ink)">'+money(m.perMonth,{round:true})+'/mo</b> · '+money(m.perWeek,{round:true})+'/wk';
    return `<div style="padding:10px 0;border-bottom:1px solid var(--rule)">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:7px">
        <span style="font-size:14.5px;margin-right:auto">${esc(g.name)}</span>
        <span class="num" style="font-size:13px">${esc(money(g.saved,{round:true}))} / ${esc(money(g.target,{round:true}))}</span>
      </div>
      <div class="bar"><i style="width:${(pct*100).toFixed(1)}%;background:${pct>=1?'var(--pop)':m.overdue?'var(--out)':'var(--in)'}"></i></div>
      <div class="muted num" style="font-size:12.5px;margin-top:7px;line-height:1.5">${line}</div>
      <div style="display:flex;gap:6px;margin-top:9px;flex-wrap:wrap">
        <button class="btn btn-sm" data-act="contribute-goal" data-id="${g.id}">Add money</button>
        <button class="btn btn-sm" data-act="goal-plan" data-id="${g.id}">Plan</button>
        <button class="btn btn-sm btn-ghost" data-act="edit-goal" data-id="${g.id}">Edit</button>
        ${pct>=1
          ? `<span class="pop" style="margin-left:auto">Reached</span>`
          : `<span class="num muted" style="font-size:12px;margin-left:auto;align-self:center">${(pct*100).toFixed(0)}%</span>`}
      </div>
    </div>`;
  }).join('')+`<button class="btn btn-sm" data-act="add-goal" style="margin-top:12px">Add goal</button>`;
};

/* ---------- goal maths ---------- */
function daysBetween(aISO,bISO){ return Math.round((new Date(bISO+'T00:00:00')-new Date(aISO+'T00:00:00'))/86400000); }
function addPeriod(iso,n,unit){
  const d=new Date(iso+'T00:00:00');
  if(unit==='d') d.setDate(d.getDate()+n); else if(unit==='w') d.setDate(d.getDate()+7*n); else if(unit==='m') d.setMonth(d.getMonth()+n); else d.setFullYear(d.getFullYear()+n);
  return isoOf(d);
}
const HORIZONS=[['4w','4 weeks',4,'w'],['8w','8 weeks',8,'w'],['3m','3 months',3,'m'],['6m','6 months',6,'m'],['1y','1 year',1,'y'],['2y','2 years',2,'y'],['3y','3 years',3,'y'],['5y','5 years',5,'y']];
function horizonDate(code){ const h=HORIZONS.find(x=>x[0]===code); return h?addPeriod(todayISO(),h[2],h[3]):''; }
function fmtSpan(days){
  if(days<=0) return 'past due';
  if(days<14) return days+' day'+(days===1?'':'s');
  if(days<70) return Math.round(days/7)+' weeks';
  if(days<400) return Math.round(days/30.44)+' months';
  return (days/365.25).toFixed(1).replace(/\.0$/,'')+' years';
}
function goalMath(g){
  const remaining=Math.max(0,(Number(g.target)||0)-(Number(g.saved)||0));
  const base={remaining:remaining,days:0,perWeek:0,perMonth:0,perYear:0,overdue:false,done:remaining<=0};
  if(!g.deadline) return base;
  const days=daysBetween(todayISO(),g.deadline);
  const perDay=remaining/Math.max(1,days);
  return Object.assign(base,{days:days,perWeek:perDay*7,perMonth:perDay*365.25/12,perYear:perDay*365.25,overdue:days<=0&&remaining>0});
}
/* average money in / out per month over recent complete months (current month only if it is all we have) */
function avgFlows(){
  const now=ym(new Date());
  let keys=monthsBack(7,now).filter(k=>k!==now);
  let rows=keys.map(k=>monthFlows(k)).filter(f=>f.in>0||f.out>0);
  if(!rows.length){ const f=monthFlows(now); if(f.in>0||f.out>0) rows=[f]; }
  if(!rows.length) return {in:0,out:0,net:0,months:0};
  const n=rows.length;
  return {in:sum(rows.map(r=>r.in))/n,out:sum(rows.map(r=>r.out))/n,net:sum(rows.map(r=>r.in-r.out))/n,months:n};
}
function planCell(k,v,s,hot){ return `<div class="plan-cell${hot?' hot':''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${s?`<div class="s">${s}</div>`:''}</div>`; }
function mo(n){ return money(n,{round:true}); }

R.planner=function(){
  const goals=S.goals.filter(g=>g.deadline&&!goalMath(g).done);
  if(!goals.length) return emptyState('No dated goals yet','Give a goal a target date and this works out what you need to earn every week, month and year to get there.','add-goal','Add a goal with a date','goals');
  const f=avgFlows();
  const need={w:0,m:0,y:0};
  goals.forEach(g=>{const m=goalMath(g);need.w+=m.perWeek;need.m+=m.perMonth;need.y+=m.perYear;});
  const gap=need.m-f.net;
  const incomeNeeded=f.out+need.m;
  let verdict;
  if(!f.months) verdict=`<div class="verdict">Add some transactions (or import a bank screenshot) and this will compare the plan against what you actually earn and spend.</div>`;
  else if(gap<=0) verdict=`<div class="verdict ok"><b>On track.</b> You keep about <b class="num">${mo(f.net)}</b> a month after spending, which covers the <b class="num">${mo(need.m)}</b> these goals need — with <b class="num">${mo(-gap)}</b> to spare.</div>`;
  else if(f.net>0) verdict=`<div class="verdict bad"><b>Short by <span class="num">${mo(gap)}</span> a month.</b> You keep about <b class="num">${mo(f.net)}</b> after spending; the plan needs <b class="num">${mo(need.m)}</b>. To make it happen, bring revenue to <b class="num">${mo(incomeNeeded)}</b>/month (<span class="num">${mo(incomeNeeded*12/52)}</span>/week · <span class="num">${mo(incomeNeeded*12)}</span>/year), or spend ${f.in-need.m>0?`no more than <b class="num">${mo(f.in-need.m)}</b>`:'far less'} a month, or a mix of both.</div>`;
  else verdict=`<div class="verdict bad"><b>Nothing left over right now.</b> You spend about <b class="num">${mo(f.out)}</b> on <b class="num">${mo(f.in)}</b> coming in. These goals need <b class="num">${mo(need.m)}</b>/month on top of spending, so revenue has to reach <b class="num">${mo(incomeNeeded)}</b>/month (<span class="num">${mo(incomeNeeded*12/52)}</span>/week · <span class="num">${mo(incomeNeeded*12)}</span>/year) unless spending comes down.</div>`;
  return `
    <div class="eyebrow">Set aside for ${goals.length} goal${goals.length===1?'':'s'}</div>
    <div class="plan-grid">
      ${planCell('Per week',mo(need.w))}${planCell('Per month',mo(need.m),'',true)}${planCell('Per year',mo(need.y))}
    </div>
    ${f.months?`<div class="eyebrow" style="margin-top:14px">Revenue to make it happen</div>
    <div class="plan-grid">
      ${planCell('Per week',mo(incomeNeeded*12/52))}${planCell('Per month',mo(incomeNeeded),'',true)}${planCell('Per year',mo(incomeNeeded*12))}
    </div>
    <div class="muted" style="font-size:12.5px;line-height:1.5">= your average spending of <span class="num">${mo(f.out)}</span>/mo + <span class="num">${mo(need.m)}</span>/mo for the goals. Averages use your last ${f.months} month${f.months===1?'':'s'}; today you bring in about <span class="num">${mo(f.in)}</span>/mo.</div>`:''}
    ${verdict}
    <div class="tbl" style="margin-top:12px">
      ${goals.slice().sort((a,b)=>a.deadline.localeCompare(b.deadline)).map(g=>{ const m=goalMath(g);
        return `<div class="trow click" data-act="goal-plan" data-id="${g.id}" role="button" tabindex="0" style="cursor:pointer">
          <span><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)}</div><div class="muted" style="font-size:12px">${mo(m.remaining)} to go · ${m.overdue?'<span style="color:var(--out)">past due</span>':fmtSpan(m.days)+' · '+fmtDate(g.deadline)}</div></span>
          <span class="num"><b>${mo(m.perMonth)}</b>/mo<div class="muted" style="font-size:12px">${mo(m.perWeek)}/wk · ${mo(m.perYear)}/yr</div></span>
        </div>`; }).join('')}
    </div>`;
};

function goalPlanModal(g){
  const m=goalMath(g), f=avgFlows();
  const eta=f.net>0&&m.remaining>0?Math.ceil(m.remaining/f.net):0;
  const body=`
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <span style="font-size:16px;margin-right:auto">${esc(g.name)}</span>
      <span class="num muted" style="font-size:13px">${mo(g.saved)} of ${mo(g.target)} saved</span>
    </div>
    <div class="eyebrow" style="margin-top:12px">Target date</div>
    <div class="horizons">
      ${HORIZONS.map(h=>`<button class="chip" data-act="goal-horizon" data-id="${g.id}" data-v="${h[0]}" aria-pressed="${g.deadline===horizonDate(h[0])}">${h[1]}</button>`).join('')}
      <input type="date" id="gpDate" value="${esc(g.deadline||'')}" style="width:auto;padding:5px 8px" aria-label="Custom target date">
      <button class="btn btn-sm" data-act="goal-date-set" data-id="${g.id}">Use date</button>
    </div>
    ${!g.deadline?`<div class="muted" style="font-size:13px;margin:8px 0">Pick a timeframe above to see what it takes.</div>`:
      m.done?`<div class="verdict ok"><b>Reached.</b> Nothing more to set aside.</div>`:`
    <div class="eyebrow" style="margin-top:14px">Set aside · ${mo(m.remaining)} to go in ${fmtSpan(m.days)}</div>
    <div class="plan-grid">
      ${planCell('Per week',mo(m.perWeek))}${planCell('Per month',mo(m.perMonth),'',true)}${planCell('Per year',mo(m.perYear))}
    </div>
    <div class="eyebrow" style="margin-top:14px">Revenue needed at your current spending</div>
    <div class="plan-grid">
      ${planCell('Per week',mo((f.out+m.perMonth)*12/52))}${planCell('Per month',mo(f.out+m.perMonth),'',true)}${planCell('Per year',mo((f.out+m.perMonth)*12))}
    </div>
    ${f.months?`<div class="muted" style="font-size:12.5px;line-height:1.5">Your last ${f.months} month${f.months===1?'':'s'}: about <span class="num">${mo(f.in)}</span> in, <span class="num">${mo(f.out)}</span> out, <span class="num">${mo(f.net)}</span> left over each month.</div>
    ${m.overdue?`<div class="verdict bad">This date has passed. Pick a new one above.</div>`
      :f.net>=m.perMonth?`<div class="verdict ok"><b>On track</b> — your usual <span class="num">${mo(f.net)}</span>/mo surplus covers the <span class="num">${mo(m.perMonth)}</span>/mo this needs.${eta?` At that pace you would get there in about ${fmtSpan(eta*30.44)}.`:''}</div>`
      :f.net>0?`<div class="verdict bad"><b>Short by <span class="num">${mo(m.perMonth-f.net)}</span>/mo.</b> At your current <span class="num">${mo(f.net)}</span>/mo surplus you would reach this in about ${fmtSpan(eta*30.44)} instead of ${fmtSpan(m.days)}. Earn <span class="num">${mo(f.out+m.perMonth)}</span>/mo, or cut spending to <span class="num">${mo(Math.max(0,f.in-m.perMonth))}</span>/mo, to hit the date.</div>`
      :`<div class="verdict bad"><b>No surplus right now.</b> Spending (<span class="num">${mo(f.out)}</span>) is at or above income (<span class="num">${mo(f.in)}</span>), so this goal needs revenue of <span class="num">${mo(f.out+m.perMonth)}</span>/mo or lower spending.</div>`}`
      :`<div class="muted" style="font-size:12.5px">No income or spending recorded yet, so the revenue figures above assume zero spending. Import a few months of transactions for a real comparison.</div>`}`}`;
  openSheet('Goal plan',body,`<button class="btn" data-act="edit-goal" data-id="${g.id}">Edit goal</button><span class="spacer"></span><button class="btn btn-primary" data-act="close-modal">Done</button>`);
}

/* ============================ what-if projection ============================ */
function monthNeed(key){ return sum(spendParts(inMonth(key)).filter(p=>cat(p.categoryId).need).map(spendBase)); }
function avgNeed(){
  const now=ym(new Date());
  let keys=monthsBack(7,now).filter(k=>k!==now).filter(k=>{const f=monthFlows(k);return f.in>0||f.out>0;});
  if(!keys.length){ const f=monthFlows(now); if(f.in>0||f.out>0) keys=[now]; }
  if(!keys.length) return 0;
  return sum(keys.map(monthNeed))/keys.length;
}
/* One place for the maths. extra = added monthly income, cut = monthly spending removed. Pure: touches nothing. */
function projection(extra,cut){
  extra=Math.max(0,Number(extra)||0); cut=Math.max(0,Number(cut)||0);
  const f=avgFlows(), need=avgNeed();
  const income=f.in+extra, spending=Math.max(0,f.out-cut);
  const surplus=income-spending, surplus0=f.in-f.out;
  const delta=extra+Math.min(cut,f.out);
  const strat=S.debtPlan.strategy||'avalanche', mins=totalMin();
  const basePay=S.debtPlan.mode==='date'&&S.debtPlan.targetDate?requiredPayment(monthsUntil(S.debtPlan.targetDate),strat):Math.max(Number(S.debtPlan.payment)||0,mins);
  const hasDebt=debts().length>0;
  const debt0=hasDebt?simulate(basePay,strat):null, debt1=hasDebt?simulate(basePay+delta,strat):null;
  const goals=S.goals.filter(g=>g.deadline&&!goalMath(g).done).map(g=>Object.assign({g:g},goalMath(g)));
  const needM=sum(goals.map(x=>x.perMonth));
  const eta=(pool)=>goals.map(x=>{
    const share=needM>0?pool*(x.perMonth/needM):0;
    const months=share>0?x.remaining/share:Infinity;
    return {g:x.g,perMonth:x.perMonth,share:share,months:months,onTrack:share>=x.perMonth-0.005,date:isFinite(months)?addPeriod(todayISO(),Math.ceil(months),'m'):''};
  });
  return {f:f,extra:extra,cut:cut,income:income,spending:spending,need:need,
    surplus0:surplus0,surplus:surplus,afterNeed0:f.in-need,afterNeed:income-need+Math.min(cut,Math.max(0,f.out-need)),
    annualExtra:delta*12,goalsPool0:Math.max(0,surplus0),goalsPool:Math.max(0,surplus),goalsNeed:needM,
    goals0:eta(Math.max(0,surplus0)),goals1:eta(Math.max(0,surplus)),
    debt:{has:hasDebt,strategy:strat,basePay:basePay,pay:basePay+delta,before:debt0,after:debt1}};
}
function wiExtra(){ return Math.max(0,Number(ui.whatIf.extra)||0); }
function wiMax(){ return ui.whatIf.mode==='cut'?Math.max(100,Math.min(10000,Math.floor(avgFlows().out/25)*25)):10000; }
function cmpRow(label,a,b,fmt,goodUp){
  fmt=fmt||money; const d=b-a; const cls=d===0?'':((d>0)===goodUp?'up':'dn');
  return `<div>${label}</div><div class="num muted">${esc(fmt(a))}</div><div class="num ${cls}">${esc(fmt(b))}</div>`;
}
function wiBody(){
  const cut=ui.whatIf.mode==='cut', x=wiExtra();
  const p=projection(cut?0:x,cut?x:0);
  const dateOr=(r)=>r.months===Infinity||!r.date?'—':fmtDate(r.date);
  const dm=p.debt;
  const dstr=r=>!r?'—':r.ok?payoffDate(r.months):'never at that rate';
  const istr=r=>!r?'—':r.ok?money(r.interest):'—';
  return `
    <div class="cmp" style="margin-top:6px">
      <div class="h">Each month</div><div class="h num">Now</div><div class="h num">What if</div>
      ${cmpRow('Take-home income',p.f.in,p.income,null,true)}
      ${cmpRow('Spending',p.f.out,p.spending,null,false)}
      ${cmpRow('Surplus / deficit',p.surplus0,p.surplus,signed,true)}
      ${cmpRow('Left after essentials ('+money(p.need,{round:true})+')',p.afterNeed0,p.afterNeed,null,true)}
      ${cmpRow('Available for goals',p.goalsPool0,p.goalsPool,null,true)}
      ${cmpRow('Extra over a year',0,p.annualExtra,null,true)}
    </div>
    ${p.goals1.length?`<div class="eyebrow" style="margin-top:16px">Savings goals — if the surplus went to them</div>
    <div class="muted" style="font-size:12.5px;margin:4px 0 6px">Spread across goals in proportion to what each needs (${money(p.goalsNeed,{round:true})}/mo in total).</div>
    <div class="cmp">
      <div class="h">Goal · deadline</div><div class="h num">Now</div><div class="h num">What if</div>
      ${p.goals1.map((r,i)=>{ const b=p.goals0[i];
        return `<div><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.g.name)}</div><div class="muted" style="font-size:12px">by ${esc(fmtDate(r.g.deadline))} · needs ${esc(money(r.perMonth,{round:true}))}/mo</div></div>
        <div class="num muted">${esc(dateOr(b))}</div>
        <div class="num ${r.onTrack?'up':(b.months>r.months?'':'')}">${esc(dateOr(r))}${r.onTrack?' ✓':''}</div>`; }).join('')}
    </div>`:''}
    ${dm.has?`<div class="eyebrow" style="margin-top:16px">Debt — if the extra went to the ${dm.strategy==='snowball'?'smallest-balance-first':'highest-rate-first'} plan</div>
    <div class="muted" style="font-size:12.5px;margin:4px 0 6px">Minimums first, then the rest onto the target debt; current plan pays ${money(dm.basePay,{round:true})}/mo${x?', what-if pays '+money(dm.pay,{round:true})+'/mo':''}.</div>
    <div class="cmp">
      <div class="h">&nbsp;</div><div class="h num">Now</div><div class="h num">What if</div>
      <div>Debt-free</div><div class="num muted">${esc(dstr(dm.before))}</div><div class="num ${dm.after&&dm.before&&dm.after.months<dm.before.months?'up':''}">${esc(dstr(dm.after))}</div>
      <div>Months to go</div><div class="num muted">${dm.before&&dm.before.ok?dm.before.months:'—'}</div><div class="num">${dm.after&&dm.after.ok?dm.after.months:'—'}</div>
      ${cmpRow('Total interest paid',dm.before&&dm.before.ok?dm.before.interest:0,dm.after&&dm.after.ok?dm.after.interest:0,istr2,false)}
    </div>`:''}
    <div class="muted" style="font-size:12px;margin-top:12px;line-height:1.5">Goals and debt are shown separately — each assumes the whole surplus goes to it. “Now” uses your average of the last ${p.f.months||0} month${p.f.months===1?'':'s'}. Nothing here is saved.</div>`;
}
function istr2(n){ return money(n); }
R.whatif=function(){
  const f=avgFlows();
  if(!f.months) return emptyState('Nothing to simulate yet','Once a month or two of income and spending is in the ledger, slide the dial to see what earning more (or spending less) would change.','import-shots','Scan a statement','transactions');
  const cut=ui.whatIf.mode==='cut', x=Math.min(wiExtra(),wiMax());
  return `
    <div class="chips">
      <button class="chip" data-act="wi-mode" data-v="earn" aria-pressed="${!cut}">What if I earned more?</button>
      <button class="chip" data-act="wi-mode" data-v="cut" aria-pressed="${cut}">What if I spent less?</button>
    </div>
    <div class="hypo">
      <span class="hypo-tag">Hypothetical — not saved, nothing changes</span>
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline">
        <div><div class="eyebrow">${cut?'Current spending':'Current take-home'}</div><div class="figure-sm num" style="margin-top:4px">${esc(money(cut?f.out:f.in,{round:true}))}<span class="muted" style="font-size:13px">/mo</span></div></div>
        <div><div class="eyebrow">${cut?'Spend less by':'Extra per month'}</div><div class="figure-sm num" id="wiFigure" style="margin-top:4px;color:var(--accent)">${x?'+':''}${esc(money(x,{round:true}))}</div></div>
      </div>
      <div class="wi-ctl">
        <input type="range" id="wiSlider" min="0" max="${wiMax()}" step="${cut?25:50}" value="${x}" aria-label="${cut?'Spending cut':'Extra income'} per month">
        <input type="number" id="wiNum" min="0" max="${wiMax()}" step="1" inputmode="decimal" value="${x}" aria-label="Exact amount">
        <button class="btn btn-sm btn-ghost" data-act="wi-reset" ${x?'':'disabled'}>Reset</button>
      </div>
      <div class="chips" style="flex-wrap:wrap">
        ${[250,500,1000,2000].map(v=>`<button class="chip" data-act="wi-preset" data-v="${v}" aria-pressed="${x===v}">+${v.toLocaleString()}</button>`).join('')}
      </div>
      <div id="wiBody">${wiBody()}</div>
    </div>`;
};
function refreshWhatIf(){
  const card=$('.card[data-wid="whatif"]'); if(!card) return;
  const x=Math.min(wiExtra(),wiMax());
  const fig=$('#wiFigure'); if(fig) fig.textContent=(x?'+':'')+money(x,{round:true});
  const sl=$('#wiSlider'), nm=$('#wiNum');
  if(sl&&document.activeElement!==sl) sl.value=x;
  if(nm&&document.activeElement!==nm) nm.value=x;
  card.querySelectorAll('[data-act="wi-preset"]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.v===x)));
  const rb=card.querySelector('[data-act="wi-reset"]'); if(rb) rb.disabled=!x;
  const body=$('#wiBody'); if(body) body.innerHTML=wiBody();
}

R.subs=function(){
  const sugg=detectRecurring().length;
  const banner=sugg?`<div class="verdict" style="margin:0 0 12px"><b>${sugg} recurring pattern${sugg===1?'':'s'} spotted</b> in your transactions. <button class="btn btn-sm" data-act="rec-review" style="margin-left:6px">Review</button></div>`:'';
  const items=S.recurring.filter(r=>cat(r.categoryId).type==='out');
  if(!items.length) return banner+emptyState('Nothing recurring yet',
    'Memberships, subscriptions, rent, insurance — anything that comes back. Ledger books each one on its date and tells you when it renews.','add-recurring','Add a recurring item');
  const live=items.filter(r=>r.active!==false);
  const monthly=sum(live.map(perMonth)), yearly=sum(live.map(perYear));
  const rows=items.map(r=>({r:r,due:nextDue(r)}))
    .sort((a,b)=>(a.due?a.due.getTime():Infinity)-(b.due?b.due.getTime():Infinity));
  const soon=rows.filter(x=>x.r.active!==false&&x.due&&daysAway(x.due)<=14);
  return `${banner}
    ${soon.length?`<div class="muted" style="font-size:13.5px;line-height:1.5;margin-bottom:12px">
      <b style="color:var(--accent)">${soon.length} renew${soon.length===1?'s':''} within two weeks</b> — ${esc(money(sum(soon.map(x=>Number(x.r.amount)||0))))} in total. Cancel before the date if you are done with any of them.
    </div>`:''}
    ${rows.map(x=>{
      const r=x.r, days=x.due?daysAway(x.due):null, urgent=r.active!==false&&days!==null&&days<=14;
      const eq=cadenceOf(r)!=='monthly'?`<span class="num muted" style="font-size:12px;display:block;margin-top:2px">${esc(money(perMonth(r)))}/mo</span>`:'';
      return `<div class="row click" data-act="edit-recurring" data-id="${r.id}" tabindex="0" role="button">
        <span class="dot" style="background:${esc(cat(r.categoryId).color)}"></span>
        <div class="grow"><div class="name">${esc(r.name)}</div>
          <div class="sub"${urgent?' style="color:var(--accent);font-weight:500"':''}>${esc(cadenceLabel(r))}${
            r.active===false?' · paused':x.due?' · renews '+esc(fmtDate(x.due.getFullYear()+'-'+pad2(x.due.getMonth()+1)+'-'+pad2(x.due.getDate())))+(days<=14?' ('+(days===0?'today':days===1?'tomorrow':'in '+days+' days')+')':''):''
          }</div></div>
        <div style="text-align:right${r.active===false?';opacity:.45':''}">
          <span class="num" style="font-size:14.5px">${esc(money(r.amount))}</span>${eq}</div>
      </div>`;}).join('')}
    <div class="totalrule" style="display:flex;gap:24px">
      <div><div class="eyebrow">Per month</div><div class="figure-sm">${esc(money(monthly))}</div></div>
      <div><div class="eyebrow">Per year</div><div class="figure-sm">${esc(money(yearly))}</div></div>
    </div>
    <button class="btn btn-sm" data-act="add-recurring" style="margin-top:12px">Add recurring item</button>`;
};

/* ---------- essentials vs. fun ---------- */
R.needs=function(){
  const txs=spendParts(inMonthMine(ui.month));
  if(!txs.length) return emptyState('Nothing spent in '+monthName(ui.month,true),
    'Ledger splits your spending into essentials and the fun stuff, using the need/want mark on each category.','add-tx','Add a transaction','transactions');
  let need=0,want=0,unsorted=0; const wantBy={};
  txs.forEach(t=>{
    const c=cat(t.categoryId);
    const v=spendBase(t);
    if(c.id==='c0'){ unsorted+=v; }
    else if(c.need){ need+=v; }
    else{ want+=v; wantBy[t.categoryId]=(wantBy[t.categoryId]||0)+v; }
  });
  const tot=need+want+unsorted||1;
  const income=monthFlowsMine(ui.month).in;
  const tops=Object.keys(wantBy).map(id=>({c:cat(id),v:wantBy[id]})).sort((a,b)=>b.v-a.v).slice(0,3);
  return `
    <div style="display:flex;gap:26px;flex-wrap:wrap">
      <div><div class="eyebrow">Essentials</div><div class="figure-sm">${esc(money(need))}</div>
        <div class="num muted" style="font-size:12px;margin-top:3px">${(need/tot*100).toFixed(0)}% of spending</div></div>
      <div><div class="eyebrow">Fun</div><div class="figure-sm" style="color:var(--accent)">${esc(money(want))}</div>
        <div class="num muted" style="font-size:12px;margin-top:3px">${(want/tot*100).toFixed(0)}% of spending</div></div>
      ${unsorted>0?`<div><div class="eyebrow">Uncategorised</div><div class="figure-sm" style="color:var(--ink-3)">${esc(money(unsorted))}</div>
        <div class="num muted" style="font-size:12px;margin-top:3px">${(unsorted/tot*100).toFixed(0)}% · not counted as either</div></div>`:''}
    </div>
    <div class="bar" style="height:12px;margin-top:14px;display:flex">
      <i style="width:${(need/tot*100).toFixed(1)}%;background:var(--in);border-radius:0"></i>
      <i style="width:${(want/tot*100).toFixed(1)}%;background:var(--accent);border-radius:0"></i>
      <i style="width:${(unsorted/tot*100).toFixed(1)}%;background:var(--rule-strong);border-radius:0"></i>
    </div>
    ${income>0?`<div class="muted" style="font-size:13.5px;margin-top:12px;line-height:1.5">
      Essentials take ${Math.round(need/income*100)}% of the ${esc(money(income))} that came in this month; fun takes ${Math.round(want/income*100)}%.</div>`:''}
    ${tops.length?`<div class="totalrule">
      <div class="eyebrow" style="margin-bottom:6px">Where the fun money went</div>
      ${tops.map(t=>`<div class="row" style="padding:5px 0;border:0">
        <span class="dot" style="background:${esc(t.c.color)}"></span>
        <span class="grow name">${esc(t.c.name)}</span>
        <span class="num" style="font-size:13.5px">${esc(money(t.v))}</span></div>`).join('')}
    </div>`:''}
    <button class="btn btn-sm" data-act="need-editor" style="margin-top:12px">Mark what counts as essential</button>`;
};

/* ---------- debt payoff maths ---------- */
/* which debts the payoff plan works on. Everything you owe is in by default except a mortgage, which most
   people deliberately treat apart from consumer debt — but it is a toggle, never a rule. A debt that is
   settled, or in credit because it was overpaid, drops out until it is owed again. */
const DEBT_DEFAULT_OUT=['mortgage'];
function inDebtPlan(a){
  if(!a||a.kind!=='liability') return false;
  const l=a.loan||{};
  if(l.inPlan===true) return true;
  if(l.inPlan===false) return false;
  return DEBT_DEFAULT_OUT.indexOf(a.acctType)<0;
}
function debtCandidates(){ return S.accounts.filter(a=>a.kind==='liability'); }
function debts(){ return S.accounts.filter(a=>a.kind==='liability'&&a.balance>0.005&&inDebtPlan(a)); }
function setDebtPlanFlag(id,on){ const a=acct(id); if(!a) return; a.loan=Object.assign({},a.loan||{},{inPlan:!!on}); }
function totalOwed(){ return sum(debts().map(a=>toBase(a.balance,a.cur||baseCur()))); }
function totalMin(){ return sum(debts().map(a=>toBase(Number(a.minPayment)||0,a.cur||baseCur()))); }
function avgSurplus(){
  const keys=monthsBack(6,ym(new Date()));
  const nets=keys.map(k=>{const f=monthFlows(k);return f.in-f.out;}).filter(n=>n!==0);
  if(!nets.length) return 0;
  return Math.max(0,Math.round(sum(nets)/nets.length));
}
function monthsUntil(iso){
  if(!iso) return 0;
  const [y,m]=iso.split('-').map(Number);
  const now=new Date();
  return Math.max(1,(y-now.getFullYear())*12+(m-1-now.getMonth()));
}
function payoffDate(months){
  const d=new Date();
  d.setDate(1); d.setMonth(d.getMonth()+months);
  return d.toLocaleDateString(undefined,{month:'long',year:'numeric'});
}
/* month-by-month simulation: minimums everywhere, everything extra onto one target debt */
function simulate(payment,strategy){
  let list=debts().map(a=>({bal:toBase(a.balance,a.cur||baseCur()),rate:(Number(a.rate)||0)/100/12,min:toBase(Number(a.minPayment)||0,a.cur||baseCur())}));
  if(!list.length) return {months:0,interest:0,ok:true};
  let months=0,interest=0;
  const MAX=600;
  while(months<MAX){
    const start=sum(list.map(d=>d.bal));
    if(start<=0.01) break;
    list.forEach(d=>{ const i=d.bal*d.rate; d.bal+=i; interest+=i; });
    const live=list.filter(d=>d.bal>0.005).sort((x,y)=>
      strategy==='snowball' ? x.bal-y.bal : (y.rate-x.rate)||(x.bal-y.bal));
    let pool=payment;
    live.forEach(d=>{ const p=Math.max(0,Math.min(pool,Math.min(d.min,d.bal))); d.bal-=p; pool-=p; });
    for(let i=0;i<live.length&&pool>0.005;i++){
      const p=Math.min(pool,live[i].bal);
      if(p>0){ live[i].bal-=p; pool-=p; }
    }
    months++;
    const end=sum(list.map(d=>Math.max(0,d.bal)));
    if(end>start-0.01&&end>0.01) return {months:Infinity,interest:Infinity,ok:false};
  }
  if(months>=MAX) return {months:Infinity,interest:Infinity,ok:false};
  return {months:months,interest:interest,ok:true};
}
function requiredPayment(targetMonths,strategy){
  let lo=0, hi=totalOwed()*1.1+totalMin()+50;
  for(let i=0;i<48;i++){
    const mid=(lo+hi)/2;
    const r=simulate(mid,strategy);
    if(r.ok&&r.months<=targetMonths) hi=mid; else lo=mid;
  }
  return Math.ceil(hi);
}

R.debt=function(){
  const list=debts();
  if(!list.length&&debtCandidates().some(a=>a.balance>0.005)) return `<div class="empty"><b>Nothing in the payoff plan</b>Every debt you owe is currently left out of it.
    <div style="margin-top:11px;display:flex;gap:6px;flex-wrap:wrap;justify-content:center">${debtCandidates().filter(a=>a.balance>0.005).map(a=>`<button class="btn btn-sm" data-act="debt-include" data-id="${a.id}">Include ${esc(a.name)}</button>`).join('')}</div></div>`;
  if(!list.length) return `<div class="empty"><b>No debt on the books</b>Nothing to pay off. If you carry a card or loan, add it as a liability account and this widget will map the route out.
    <div style="margin-top:11px"><button class="btn btn-sm" data-act="add-acct">Add an account</button></div></div>`;
  const p=S.debtPlan, owed=totalOwed(), mins=totalMin();
  const strat=p.strategy||'avalanche';
  let payment, headline, sub, warn='';

  if(p.mode==='date'&&p.targetDate){
    const m=monthsUntil(p.targetDate);
    payment=requiredPayment(m,strat);
    const r=simulate(payment,strat);
    headline=money(payment)+' / month';
    sub=`clears everything by ${esc(payoffDate(m))} — ${esc(money(r.interest))} of that is interest`;
    if(payment>mins) warn=`That is ${money(payment-mins)} a month on top of your minimums.`;
  }else{
    payment=Number(p.payment)||mins;
    const r=simulate(payment,strat);
    if(!r.ok){
      headline='Not yet a plan';
      sub=payment<=0?'Set a monthly payment to see a payoff date.':'At that amount the interest outruns the payment, so the balance never falls.';
      warn=mins>0?`Your minimums alone come to ${money(mins)} a month.`:'';
    }else{
      headline=r.months+' month'+(r.months===1?'':'s');
      sub=`debt-free by ${esc(payoffDate(r.months))} at ${esc(money(payment))} a month — ${esc(money(r.interest))} paid in interest`;
    }
  }

  return `
    <div style="display:flex;gap:26px;flex-wrap:wrap;align-items:flex-start">
      <div><div class="eyebrow">Total owed</div><div class="figure" style="margin-top:4px">${esc(money(owed))}</div></div>
      <div><div class="eyebrow">${p.mode==='date'?'You need to pay':'Time to clear'}</div>
        <div class="figure-sm" style="margin-top:8px">${esc(headline)}</div></div>
    </div>
    <div class="muted" style="font-size:13.5px;margin-top:8px;line-height:1.5">${sub}</div>
    ${warn?`<div class="num" style="font-size:13px;margin-top:8px;color:var(--out)">${esc(warn)}</div>`:''}
    <div class="chips" style="margin-top:14px">
      <button class="chip" data-act="debt-strategy" data-v="avalanche" aria-pressed="${strat==='avalanche'}">Highest rate first</button>
      <button class="chip" data-act="debt-strategy" data-v="snowball" aria-pressed="${strat==='snowball'}">Smallest balance first</button>
    </div>
    <div class="totalrule">
      ${list.slice().sort((x,y)=>strat==='snowball'?x.balance-y.balance:(Number(y.rate)||0)-(Number(x.rate)||0))
        .map((a,i)=>`<div class="row click" data-act="edit-acct" data-id="${a.id}" tabindex="0" role="button">
          <span class="num muted" style="font-size:12px;width:16px">${i+1}</span>
          <div class="grow"><div class="name">${esc(a.name)}${a.acctType==='mortgage'?' <span class="tag">in the plan</span>':''}</div>
          <div class="sub">${a.rate?esc(Number(a.rate).toFixed(2))+'% a year':'no rate set'}${a.minPayment?' · minimum '+esc(money(a.minPayment)):''}</div></div>
          <span class="num" style="font-size:14.5px">${esc(money(a.balance))}</span>
        </div>`).join('')}
    </div>
    ${(()=>{ const outs=debtCandidates().filter(a=>!inDebtPlan(a)&&a.balance>0.005), settled=debtCandidates().filter(a=>inDebtPlan(a)&&a.balance<=0.005);
      if(!outs.length&&!settled.length) return '';
      return `<div class="muted" style="font-size:12.5px;line-height:1.6;margin-top:10px">
        ${outs.length?'Left out of the payoff plan: '+outs.map(a=>'<b>'+esc(a.name)+'</b> '+esc(money(a.balance))+' <button class="btn btn-sm btn-ghost" data-act="debt-include" data-id="'+a.id+'">include</button>').join(' · ')+(outs.some(a=>a.acctType==='mortgage')?'<div>A mortgage sits outside by default — most people attack consumer debt first — but it is your call.</div>':''):''}
        ${settled.length?'<div>Nothing owed right now on: '+esc(settled.map(a=>a.name).join(', '))+' — they rejoin the plan if a balance comes back.</div>':''}</div>`; })()}
    <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-sm" data-act="debt-analysis">Run the numbers</button>
      <button class="btn btn-sm btn-ghost" data-act="debt-plan">Edit the plan</button>
    </div>`;
};

/* ---------- habits ---------- */
function isoOf(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function firstTxDate(){
  if(!S.transactions.length) return null;
  return S.transactions.reduce((a,t)=>(t.date<a?t.date:a),S.transactions[0].date);
}
function daySpend(iso){
  return sum(spendParts(S.transactions.filter(t=>t.date===iso)).map(spendBase));
}
function habitDone(h,iso){
  if(h.mode==='manual') return !!S.habitLog[h.id+':'+iso];
  const first=firstTxDate();
  if(!first||iso<first) return false;   /* before you were logging, nothing can be verified */
  const spent=daySpend(iso);
  return h.mode==='nospend' ? spent<=0 : spent<=(Number(h.limit)||0);
}
function habitStreak(h){
  const d=new Date();
  if(!habitDone(h,isoOf(d))) d.setDate(d.getDate()-1);   /* today still has hours left in it */
  let n=0;
  for(let i=0;i<730;i++){
    if(!habitDone(h,isoOf(d))) break;
    n++; d.setDate(d.getDate()-1);
  }
  return n;
}

R.habits=function(){
  if(!S.habits.length) return emptyState('No habits yet',
    'Track the small repeatable things — a no-spend day, packing lunch, sitting down to log what you spent. Some habits Ledger can check for you, straight from your own transactions.',
    'add-habit','Add a habit');
  const [y,m]=ui.month.split('-').map(Number);
  const days=new Date(y,m,0).getDate();
  const today=todayISO();
  return S.habits.map(h=>{
    let done=0,possible=0;
    const cells=[];
    for(let d=1;d<=days;d++){
      const iso=ui.month+'-'+pad2(d);
      const future=iso>today;
      const on=!future&&habitDone(h,iso);
      if(!future){ possible++; if(on) done++; }
      const tappable=h.mode==='manual'&&!future;
      cells.push(`<button class="cell${on?' on':''}${future?' future':''}${iso===today?' today':''}"
        style="--c:${esc(h.color)}"
        ${tappable?`data-act="habit-toggle" data-id="${h.id}" data-d="${iso}"`:'disabled'}
        aria-label="${esc(h.name)}, ${esc(fmtDate(iso))}${on?', done':''}"
        title="${esc(fmtDate(iso))}${on?' · done':''}"></button>`);
    }
    const st=habitStreak(h);
    const how=h.mode==='manual'?'tap a day to mark it'
      :h.mode==='nospend'?'checked for you · days you spent nothing'
      :'checked for you · days under '+money(h.limit,{round:true});
    const streakBit=st>=3
      ? `<span class="pop">${st} day streak</span>`
      : `<span class="num muted" style="font-size:13px">${st} day streak</span>`;
    const sched='';
    return `<div class="habit">
      <div class="habit-head">
        <span class="dot" style="background:${esc(h.color)}"></span>
        <button class="linkbtn" data-act="edit-habit" data-id="${h.id}">${esc(h.name)}</button>
        <span class="sub">${esc(how)}${esc(sched)}</span>
        <span class="habit-stat" style="margin-left:auto;display:flex;align-items:center;gap:9px">${streakBit}
          <span class="num muted" style="font-size:12.5px">${done}/${possible} this month</span></span>
      </div>
      <div class="strip">${cells.join('')}</div>
    </div>`;
  }).join('')+`<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
    <button class="btn btn-sm" data-act="add-habit">Add habit</button></div>`;
};

/* ---------- month calendar ---------- */
function recurringDueOn(iso,key,lastDay){
  return S.recurring.filter(r=>{
    if(r.active===false) return false;
    const stamp=isDated(r)?r.id+':'+iso:r.id+':'+key;
    if(S.generated[stamp]) return false;      /* already turned into a real entry */
    return occurrences(r,key).indexOf(iso)>=0;
  });
}
/* what is still to come between today and the end of the month being viewed */
function stillToCome(key){
  const today=todayISO();
  const [y,m]=key.split('-').map(Number);
  const lastDay=new Date(y,m,0).getDate();
  let inSum=0,outSum=0,n=0;
  S.planned.filter(p=>p.date.slice(0,7)===key&&p.date>=today).forEach(p=>{
    (cat(p.categoryId).type==='in'?inSum+=p.amount:outSum+=p.amount); n++;
  });
  S.recurring.filter(r=>r.active!==false).forEach(r=>{
    occurrences(r,key).forEach(iso=>{
      if(S.generated[isDated(r)?r.id+':'+iso:r.id+':'+key]) return;
      if(iso<today) return;
      (cat(r.categoryId).type==='in'?inSum+=Number(r.amount)||0:outSum+=Number(r.amount)||0); n++;
    });
  });
  return {in:inSum,out:outSum,count:n};
}

R.calendar=function(){
  const [y,m]=ui.month.split('-').map(Number);
  const firstDow=new Date(y,m-1,1).getDay();
  const lastDay=new Date(y,m,0).getDate();
  const today=todayISO();
  const cells=[];
  for(let i=0;i<firstDow;i++) cells.push('<div class="day blank"></div>');
  for(let d=1;d<=lastDay;d++){
    const iso=ui.month+'-'+pad2(d);
    const txs=S.transactions.filter(t=>t.date===iso);
    const plans=S.planned.filter(p=>p.date===iso);
    const recs=recurringDueOn(iso,ui.month,lastDay).filter(()=>iso>=today);
    const net=sum(txs.map(flowBase));
    const marks=txs.slice(0,4).map(t=>`<span class="mk" style="background:${esc(cat(t.categoryId).color)}"></span>`)
      .concat(plans.slice(0,3).map(()=>'<span class="mk plan"></span>'))
      .concat(recs.slice(0,3).map(()=>'<span class="mk rec"></span>')).join('');
    const planTotal=sum(plans.map(p=>cat(p.categoryId).type==='in'?p.amount:-p.amount))
      + sum(recs.map(r=>cat(r.categoryId).type==='in'?(Number(r.amount)||0):-(Number(r.amount)||0)));
    let amt='';
    if(net) amt=`<span class="amt ${net>0?'in':'out'}">${esc((net>0?'+':'−')+money(Math.abs(net),{round:true}))}</span>`;
    else if(planTotal) amt=`<span class="amt muted">${esc((planTotal>0?'+':'−')+money(Math.abs(planTotal),{round:true}))}</span>`;
    cells.push(`<button class="day${iso===today?' today':''}${iso<today?' past':''}" data-act="day-detail" data-d="${iso}"
      aria-label="${esc(fmtDate(iso))}${txs.length?', '+txs.length+' entries':''}">
      <span class="dnum">${d}</span>${amt}<span class="marks">${marks}</span></button>`);
  }
  const ahead=stillToCome(ui.month);
  const showAhead=ui.month>=ym(new Date());
  const onNow=ui.month===ym(new Date());
  return `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">
      <button class="iconbtn" data-act="month-prev" aria-label="Previous month">‹</button>
      <span class="num" style="font-size:14px;font-weight:500;min-width:104px;text-align:center">${esc(monthName(ui.month,true))}</span>
      <button class="iconbtn" data-act="month-next" aria-label="Next month">›</button>
      ${onNow?'':`<button class="btn btn-sm btn-ghost" data-act="month-today">Back to today</button>`}
      <span class="muted" style="font-size:12.5px;margin-left:auto">every widget follows this month</span>
    </div>
    <div class="cal">${DAY_NAMES.map(n=>`<div class="dow">${n}</div>`).join('')}${cells.join('')}</div>
    <div class="legend">
      <span><i class="mk" style="background:var(--ink-2)"></i> spent or received</span>
      <span><i class="mk plan"></i> planned by you</span>
      <span><i class="mk rec"></i> recurring, still to land</span>
    </div>
    ${showAhead&&ahead.count?`<div class="totalrule" style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
      <div><div class="eyebrow">Still to come</div>
        <div class="muted" style="font-size:13px;margin-top:3px">${ahead.count} item${ahead.count===1?'':'s'} before month end</div></div>
      <div><div class="eyebrow">In</div><div class="figure-sm in">${esc(money(ahead.in))}</div></div>
      <div><div class="eyebrow">Out</div><div class="figure-sm out">${esc(money(ahead.out))}</div></div>
      <div><div class="eyebrow">Net</div><div class="figure-sm ${ahead.in-ahead.out>=0?'in':'out'}">${esc(signed(ahead.in-ahead.out))}</div></div>
    </div>`:''}
    <button class="btn btn-sm" data-act="add-planned" style="margin-top:12px">Plan something</button>`;
};

function emptyState(title,body,act,label,artId){
  const inner=`<div><b>${esc(title)}</b>${esc(body)}
    ${act?`<div style="margin-top:11px"><button class="btn btn-sm" data-act="${act}">${esc(label)}</button></div>`:''}</div>`;
  return `<div class="empty">${artId?`<div class="empty-art">${art(artId)}${inner}</div>`:inner}</div>`;
}

/* ============================ board ============================ */
function render(){
  recalcBalances();
  document.documentElement.setAttribute('data-theme',S.settings.theme);
  document.documentElement.setAttribute('data-text',S.settings.textSize||'normal');
  setFavicon();
  renderOrigin();
  /* if nothing can be saved, say so loudly — before real data gets typed in */
  let bar=document.getElementById('alertbar');
  if(STORAGE_WHERE==='memory'){
    if(!bar){
      bar=document.createElement('div');
      bar.id='alertbar'; bar.className='alertbar'; bar.setAttribute('role','alert');
      bar.innerHTML='<b>This copy cannot save anything.</b>Your browser is blocking storage for this file, so everything you enter will vanish when the page reloads. Don\'t start real record-keeping here — use the copy in your Claude chat, or back up after every session via Settings › Data.';
      document.body.insertBefore(bar,document.getElementById('board'));
    }
  }else if(bar){ bar.remove(); }
  let pb=document.getElementById('backuppause');
  if(backupState==='ask'){
    if(!pb){
      pb=document.createElement('div'); pb.id='backuppause'; pb.className='alertbar soft';
      pb.innerHTML='<b>Live backup paused.</b>Chrome needs permission again to keep writing your backup (choose “Allow on every visit” to stop it asking). '+
        '<button class="btn btn-sm btn-primary" data-act="backup-reconnect" style="margin-top:9px">Allow</button> '+
        '<button class="btn btn-sm btn-ghost" data-act="backup-unlink" style="margin-top:9px">Turn off</button>';
      document.body.insertBefore(pb,document.getElementById('board'));
    }
  }else if(pb){ pb.remove(); }
  /* the two failures a person must not miss: the stored book could not be read, or writes are failing */
  let cb=document.getElementById('corruptbar');
  if(bootCorrupt){ if(!cb){ cb=document.createElement('div'); cb.id='corruptbar'; cb.className='alertbar'; cb.setAttribute('role','alert');
      cb.innerHTML='<b>Your saved book could not be read.</b>It has NOT been overwritten: Ledger is holding the damaged data as it is and will not save anything over it. Download it to keep the evidence, then restore from a backup or a saved copy. '+
        '<button class="btn btn-sm" data-act="corrupt-download" style="margin-top:9px">Download what was saved</button> <button class="btn btn-sm btn-primary" data-act="restore-json" style="margin-top:9px">Restore from backup</button> <button class="btn btn-sm btn-ghost" data-act="corrupt-discard" style="margin-top:9px">Start over (erase it)</button>';
      const board=document.getElementById('board'); if(board&&board.parentNode) board.parentNode.insertBefore(cb,board); } }
  else if(cb) cb.remove();
  let sb=document.getElementById('savebar');
  if(saveBroken&&!bootCorrupt){ if(!sb){ sb=document.createElement('div'); sb.id='savebar'; sb.className='alertbar'; sb.setAttribute('role','alert');
      sb.innerHTML='<b>Changes are not being saved.</b>The browser refused the last write ('+esc(saveBroken)+'). Anything you enter now lives only in this tab until this is fixed — download a backup before you close it. '+
        '<button class="btn btn-sm btn-primary" data-act="export-json" style="margin-top:9px">Download a backup now</button> <button class="btn btn-sm" data-act="save-retry" style="margin-top:9px">Try saving again</button>';
      const board=document.getElementById('board'); if(board&&board.parentNode) board.parentNode.insertBefore(sb,board); } }
  else if(sb) sb.remove();
  if(isDist()) renderEmbedOffer();
  /* gentle, dismissible nudge: browser storage is not a backup. The shared file is stricter — its people have no
     localhost copy and may clear the browser or change it — so it asks after a week, or as soon as there is a real book */
  let nb=document.getElementById('backupbar');
  const days=S.settings.lastBackup?(Date.now()-S.settings.lastBackup)/86400000:Infinity;
  const snoozed=S.settings.backupNudged&&(Date.now()-S.settings.backupNudged)<(isDist()?7:14)*86400000;
  const realRows=S.transactions.filter(t=>t.source!=='sample').length;   /* a sample book is nothing to lose */
  const wantNudge=STORAGE_WHERE!=='memory'&&!snoozed&&(isDist()?(realRows>=5&&days>7):(realRows>=25&&days>30));
  if(wantNudge){
    if(!nb){
      nb=document.createElement('div'); nb.id='backupbar'; nb.className='alertbar soft';
      nb.innerHTML=isDist()?('<b>Keep a copy of your Ledger.</b>'+
        (S.settings.lastBackup?'It has been over a week since your last copy. ':'This book only exists in this browser so far. ')+
        'Clearing the browser, or moving to another one, would lose it. A copy of the file with your data inside opens anywhere, with everything in it. '+
        '<button class="btn btn-sm btn-primary" data-act="export-self" style="margin-top:9px">Save a copy with my data inside</button> '+
        (canFolderBackup()&&backupState!=='on'?'<button class="btn btn-sm" data-act="backup-link-folder" style="margin-top:9px">Or back up to a folder automatically</button> ':'')+
        '<button class="btn btn-sm btn-ghost" data-act="dismiss-backup" style="margin-top:9px">Later</button>')
      :('<b>Worth backing up.</b>'+
        (S.settings.lastBackup?'It has been over a month since your last backup. ':'You have never backed this up. ')+
        'Browser storage can be cleared without warning, and a backup restores everything. '+
        '<button class="btn btn-sm" data-act="export-json" style="margin-top:9px">Back up now</button> '+
        '<button class="btn btn-sm btn-ghost" data-act="dismiss-backup" style="margin-top:9px">Later</button>');
      document.body.insertBefore(nb,document.getElementById('board'));
    }
  }else if(nb){ nb.remove(); }
  updateSaveStat();
  $('#monthLabel').textContent=monthName(ui.month,true);
  $('#todayBtn').hidden=(ui.month===ym(new Date()));
  /* the lock lives in the top bar, not buried in Settings — but only once there is a passphrase to lock with */
  { const lb=$('#lockBtn'); if(lb) lb.hidden=!hasLock(); }
  const uf=$('#userFilter');
  if(uf){
    const cur=ui.user||'all';
    const opts=[['all','All users (household)']].concat(S.users.map(u=>[u.id,u.name||'Unnamed'])).concat([['unassigned','Unassigned']]);
    if(!opts.some(o=>o[0]===cur)) ui.user='all';
    uf.innerHTML=opts.map(o=>`<option value="${esc(o[0])}"${o[0]===(ui.user||'all')?' selected':''}>${esc(o[1])}</option>`).join('');
    uf.hidden=S.users.length===0;
    const ap=$('#addPersonBtn'); if(ap){ ap.textContent=S.users.length?'+ Person':'+ Add a person'; ap.hidden=S.users.length>=MAX_USERS; }
    const atb=$('#addTxBtn'); if(atb){ const m=S.users.find(u=>u.id===filteredUserId()); atb.textContent=m?'Add for '+(m.name||'Unnamed'):'Add transaction'; }
  }
  const board=$('#board');
  board.innerHTML=S.settings.widgets.filter(w=>w.on&&!(w.id==='guide'&&guideSteps().every(s=>s.done))).map(w=>`
    <section class="card" data-span="${w.span}" data-wid="${w.id}" draggable="true">
      <div class="card-head">
        ${icon(w.id)}
        <h2>${esc(WIDGET_TITLES[w.id])}</h2>
        <div class="card-tools">
          <button class="iconbtn" data-act="widget-resize" data-id="${w.id}" title="Change width" aria-label="Change width of ${esc(WIDGET_TITLES[w.id])}">⤢</button>
          <button class="iconbtn" data-act="widget-hide" data-id="${w.id}" title="Hide" aria-label="Hide ${esc(WIDGET_TITLES[w.id])}">×</button>
        </div>
      </div>
      <div class="card-body">${HOUSEHOLD_WIDE[w.id]&&memberFilterOn()?scopeNote():''}${R[w.id]()}</div>
    </section>`).join('')||
    `<section class="card" data-span="12"><div class="card-body">${emptyState('Every widget is hidden','Open settings to switch some back on.','open-settings','Open settings')}</div></section>`;
  wireDrag();
}

function wireDrag(){
  document.querySelectorAll('.card[data-wid]').forEach(card=>{
    card.addEventListener('dragstart',e=>{
      dragId=card.dataset.wid; card.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      try{e.dataTransfer.setData('text/plain',dragId);}catch(_){}
    });
    card.addEventListener('dragend',()=>{
      card.classList.remove('dragging');
      document.querySelectorAll('.dropzone').forEach(n=>n.classList.remove('dropzone'));
      dragId=null;
    });
    card.addEventListener('dragover',e=>{
      if(!dragId||card.dataset.wid===dragId) return;
      e.preventDefault(); card.classList.add('dropzone');
    });
    card.addEventListener('dragleave',()=>card.classList.remove('dropzone'));
    card.addEventListener('drop',e=>{
      e.preventDefault(); card.classList.remove('dropzone');
      const target=card.dataset.wid;
      if(!dragId||target===dragId) return;
      const ws=S.settings.widgets;
      const from=ws.findIndex(w=>w.id===dragId), to=ws.findIndex(w=>w.id===target);
      if(from<0||to<0) return;
      ws.splice(to,0,ws.splice(from,1)[0]);
      save(); render();
    });
  });
}

