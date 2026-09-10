/* Ledger — part 5 of 7: modal engine, forms, settings, diagnostics, screenshot import dialog.
   The parts load in order as plain scripts and share one scope; tools/build.js joins them back into
   one closure for the shareable single file. Keep load-time code in the part that defines what it uses. */
"use strict";

/* ============================ modal engine ============================ */
let lastFocus=null;
function closeModal(){ $('#modalRoot').innerHTML=''; const lf=lastFocus; lastFocus=null; if(lf&&typeof lf.focus==='function'){ const back=()=>{ if(document.contains(lf)&&document.activeElement!==lf){ try{ lf.focus(); }catch(e){} } }; back(); setTimeout(back,0); } }   /* now, and again next tick: the click that closed the sheet may still be settling its own focus */

function openSheet(title,bodyHTML,footHTML){
  if(!$('.veil')) lastFocus=document.activeElement;
  $('#modalRoot').innerHTML=`<div class="veil" data-veil>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="iconbtn" data-act="close-modal" aria-label="Close">×</button></div>
      <div class="sheet-body">${bodyHTML}</div>
      ${footHTML?`<div class="sheet-foot">${footHTML}</div>`:''}
    </div></div>`;
  const first=$('.sheet-body input,.sheet-body select,.sheet-body textarea')||$('.sheet-foot .btn-primary,.sheet-foot .btn-danger')||$('.sheet');
  if(first) setTimeout(()=>first.focus(),30);
}

/* generic form modal */
let formSubmit=null, formDelete=null, pendingConfirm=null;
function confirmSheet(title,html,okLabel,fn,danger){
  pendingConfirm=fn;
  openSheet(title,html,`<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn ${danger===false?'btn-primary':'btn-danger'}" data-act="confirm-yes">${esc(okLabel)}</button>`);
}
function openForm(cfg){
  formSubmit=cfg.onSubmit; formDelete=cfg.onDelete||null;
  const body=cfg.fields.map(f=>{
    const id='f_'+f.name;
    if(f.type==='select'){
      const opts=f.groups
        ? f.groups.map(g=>`<optgroup label="${esc(g.label)}">${g.options.map(o=>`<option value="${esc(o.value)}"${o.value===f.value?' selected':''}>${esc(o.label)}</option>`).join('')}</optgroup>`).join('')
        : f.options.map(o=>`<option value="${esc(o.value)}"${o.value===f.value?' selected':''}>${esc(o.label)}</option>`).join('');
      return `<label class="field"><span>${esc(f.label)}</span><select id="${id}" data-fname="${f.name}">${opts}</select></label>`;
    }
    if(f.type==='multicheck'){
      if(!f.options.length) return '';
      return `<div class="field"><span>${esc(f.label)}</span><div style="display:flex;flex-direction:column;gap:7px;padding:2px 0">
        ${f.options.map(o=>`<label style="display:flex;align-items:center;gap:9px;font-size:14px;cursor:pointer">
          <input type="checkbox" data-fname="${esc(f.name)}:${esc(o.value)}" ${(f.value||[]).indexOf(o.value)>=0?'checked':''} style="width:auto;margin:0">
          <span>${esc(o.label)}</span></label>`).join('')}</div></div>`;
    }
    if(f.type==='checkbox'){
      return `<label class="field" style="display:flex;align-items:center;gap:9px">
        <input type="checkbox" id="${id}" data-fname="${f.name}" ${f.value?'checked':''} style="width:auto;margin:0">
        <span style="margin:0;text-transform:none;letter-spacing:0;font-size:14.5px;color:var(--ink);font-weight:400">${esc(f.label)}</span></label>`;
    }
    if(f.type==='chips'){
      return `<div class="chips dir" data-chips="${esc(f.name)}">${f.options.map(o=>`<button type="button" class="chip" data-act="form-chip" data-v="${esc(o.value)}" aria-pressed="${o.value===f.value}">${esc(o.label)}</button>`).join('')}</div>`;
    }
    if(f.type==='color'){
      return `<label class="field"><span>${esc(f.label)}</span>
        <input type="color" id="${id}" data-fname="${f.name}" value="${esc(f.value||'#2E6B4F')}" style="height:42px;padding:4px"></label>`;
    }
    return `<label class="field"><span>${esc(f.label)}</span>
      <input type="${f.type||'text'}" id="${id}" data-fname="${f.name}" value="${esc(f.value==null?'':f.value)}"
      ${f.type==='number'?'step="0.01" inputmode="decimal"':''} ${f.placeholder?`placeholder="${esc(f.placeholder)}"`:''}></label>`;
  }).join('');
  const foot=`${cfg.onDelete?`<button class="btn btn-danger" data-act="form-delete">Delete</button>`:''}${cfg.extraFoot||''}
    <span class="spacer"></span>
    <button class="btn" data-act="close-modal">Cancel</button>
    <button class="btn btn-primary" data-act="form-submit">${esc(cfg.submitLabel||'Save')}</button>`;
  openSheet(cfg.title,body+(cfg.note?`<div class="muted" style="font-size:13px;line-height:1.5">${cfg.note}</div>`:''),foot);
}
function readForm(){
  const out={};
  document.querySelectorAll('.sheet-body [data-fname]').forEach(el=>{
    out[el.dataset.fname]=(el.type==='checkbox')?el.checked:el.value;
  });
  return out;
}

/* ---------- specific forms ---------- */
function catGroups(){
  return [
    {label:'Money in',options:S.categories.filter(c=>c.type==='in').map(c=>({value:c.id,label:c.name}))},
    {label:'Money out',options:S.categories.filter(c=>c.type==='out').map(c=>({value:c.id,label:c.name}))}
  ];
}
function acctOptions(){return S.accounts.map(a=>({value:a.id,label:a.name}));}

let formCatTouched=false, formRuleId=null, formTxId=null;
/* the reversal link, as a form field: an incoming row can be marked as the reclaim of one outgoing row that
   fits (same account, amount, opposite direction, within a week); an outgoing row only shows what reversed it */
function reversalField(t){
  if(!t||!t.id||t.type==='transfer') return [];
  const cur=reversalPartner(t);
  if(t.type==='in'||isReversal(t)){
    const opts=reversalCandidates(t).map(x=>({value:x.id,label:fmtDate(x.date)+' − '+money(x.amount)+' '+(x.note||cat(x.categoryId).name)}));
    if(cur) opts.unshift({value:cur.id,label:fmtDate(cur.date)+' − '+money(cur.amount)+' '+(cur.note||'')+' (linked)'});
    if(!opts.length) return [];
    opts.unshift({value:'',label:'Not a reversal — count it as money in'});
    return [{name:'reversalOf',label:'Reversal of',type:'select',options:opts,value:cur?cur.id:''}];
  }
  return [];
}
function reversalNote(t){
  if(!t||!t.id) return '';
  if(isReversed(t)){ const p=reversalPartner(t); return ' <b>This payment was reversed</b> by the '+fmtDate(p.date)+' reclaim, so it is not counted as spending; the balance still contains both movements. Edit the reclaim to unlink them.'; }
  if(t.type==='in'&&reversalCandidates(t).length||isReversal(t)) return ' A reclaim of a failed transfer is not income: link it to the outgoing row it reverses and neither row counts in the analytics, while the balance keeps both.';
  return '';
}
/* after a save: honour the field, and drop a link the edit has broken (amount, account or direction changed) */
function reversalApply(next,v){
  if(v&&v.reversalOf!==undefined&&next.type==='in'){
    const want=txById(v.reversalOf), have=reversalPartner(next);
    if(!want&&have){ unlinkReversal(next); toast('Unlinked — the reclaim counts as money in again'); }
    else if(want&&want!==have){ if(linkReversal(want,next,'manual')) toast('Linked as a reversal — neither row counts as spending or income'); else toast('Those two rows do not match (account, amount or direction differ), so they were not linked'); }
  }
  const p=reversalPartner(next);
  if(p&&!(isReversal(next)?reversalPairOk(p,next):reversalPairOk(next,p))){ unlinkReversal(next); toast('The reversal link was removed: the two rows no longer match'); }
}
function txForm(t,presetDate){
  if(!S.accounts.length){ toast('Add an account first'); return acctForm(); }
  const isNew=!t;
  t=t||{date:presetDate||todayISO(),amount:'',categoryId:(S.categories.find(c=>c.type==='out')||{}).id,accountId:S.accounts[0].id,note:''};
  if(isNew&&filteredUserId()) t.userId=filteredUserId();
  formCatTouched=!isNew&&t.catSource==='manual'; formRuleId=null; formTxId=t.id||null;
  openForm({
    title:isNew?'Add transaction':'Edit transaction',
    extraFoot:`<button class="btn btn-ghost" data-act="rule-from-form" title="Teach Ledger this merchant">Make a rule</button>`,
    fields:[
      {name:'dir',label:'',type:'chips',options:[{value:'out',label:'Money out'},{value:'in',label:'Money in'}],value:(cat(t.categoryId)||{}).type||'out'},
      {name:'amount',label:'Amount',type:'number',value:t.amount,placeholder:'0.00'},
      {name:'date',label:'Date',type:'date',value:t.date},
      {name:'categoryId',label:'Category',type:'select',groups:catGroups(),value:t.categoryId},
      {name:'accountId',label:'Account',type:'select',options:acctOptions(),value:t.accountId},
      {name:'note',label:'Note',type:'text',value:t.note,placeholder:'What was it for?'}
    ].concat(S.users.length?[{name:'userId',label:'Household member',type:'select',options:userOptions(),value:t.userId||''}]:[]).concat(reversalField(t)),
    note:'Money in or out follows the category; the two buttons at the top jump to the right list. The account balance moves to match.'+reversalNote(t)+(debugOn()&&!isNew?txDebugHTML(t):''),
    onDelete:isNew?null:()=>{
      markUndo();
      const idx=S.transactions.findIndex(x=>x.id===t.id);
      if(idx>=0){ dlog('transaction deleted',{id:S.transactions[idx].id}); unlinkReversal(S.transactions[idx]); applyToAccount(S.transactions[idx],-1); S.transactions.splice(idx,1); }
      save(); closeModal(); render(); toast('Transaction deleted',true);
    },
    onSubmit:v=>{
      const amount=Math.abs(parseFloat(v.amount)||0);
      if(!amount){ toast('Enter an amount above zero'); return false; }
      const c=cat(v.categoryId);
      const next={id:t.id||uid(),date:v.date||todayISO(),amount:amount,type:c.type,
        categoryId:v.categoryId,accountId:v.accountId,note:v.note.trim()};
      if(v.userId) next.userId=v.userId;
      if(isNew){
        next.catSource=formCatTouched?'manual':(formRuleId?'rule':'default'); if(formRuleId&&!formCatTouched) next.ruleId=formRuleId;
        next.source='manual'; next.createdAt=Date.now(); dlog('transaction added',{id:next.id,amount:next.amount,type:next.type,source:'manual'});
        S.transactions.push(next); applyToAccount(next,1);
      }
      else{
        const idx=S.transactions.findIndex(x=>x.id===t.id);
        applyToAccount(S.transactions[idx],-1);
        next.auto=S.transactions[idx].auto;
        const old=S.transactions[idx];
        next.catSource=(v.categoryId!==old.categoryId)?'manual':(old.catSource||(formRuleId?'rule':undefined));
        if(next.catSource==='rule') next.ruleId=old.ruleId||formRuleId;
        next.source=old.source||'manual'; next.createdAt=old.createdAt||0; next.raw=old.raw; next.updatedAt=Date.now();
        /* provenance survives an edit: the source fingerprint is what stops the same statement importing twice */
        if(old.src) next.src=old.src; if(old.ref) next.ref=old.ref; if(old.fx) next.fx=old.fx; if(old.bankHint) next.bankHint=old.bankHint;
        if(old.reversalOf) next.reversalOf=old.reversalOf; if(old.reversedBy) next.reversedBy=old.reversedBy; if(old.revSource) next.revSource=old.revSource;
        dlog('transaction updated',{id:next.id,amount:next.amount,type:next.type});
        S.transactions[idx]=next; applyToAccount(next,1);
      }
      reversalApply(next,v);
      save(); closeModal(); render();
      const acc=acct(next.accountId), an=acc&&anchorOf(acc);
      if(an&&an.date&&next.date<=an.date) toast((isNew?'Added':'Updated')+' — dated on or before '+acc.name+'\'s '+fmtDate(an.date)+' checkpoint, so that balance is unchanged');
      else toast(isNew?'Transaction added':'Transaction updated');
    }
  });
}

/* installment debts, where a payment is principal + interest + possibly taxes and fees */
const LOAN_TYPES=['mortgage','car loan','student loan','personal loan','other loan'];
function isInstallmentLoan(a){ return !!a&&a.kind==='liability'&&(LOAN_TYPES.indexOf(a.acctType)>=0||(a.loan&&a.loan.original>0)); }
function allocFields(t){
  const al=allocOf(t)||{};
  const escrowOpts=[{value:'',label:'— no escrow account —'}].concat(S.accounts.filter(a=>a.kind!=='liability').map(a=>({value:a.id,label:a.name})));
  const num=(n,l,v)=>({name:n,label:l,type:'number',value:v===0||v?v:'',placeholder:'0.00'});
  return [
    {name:'isLoan',label:'This is a loan payment — split it into principal, interest and other parts',type:'checkbox',value:!!allocOf(t)},
    num('alPrincipal','Principal (reduces what you owe)',allocOf(t)?allocNum(al,'principal')||'':''),
    num('alExtra','Extra principal (optional — also reduces what you owe)',allocOf(t)?allocNum(al,'extra')||'':''),
    num('alInterest','Interest (an expense)',allocOf(t)?allocNum(al,'interest')||'':''),
    num('alTax','Property tax (an expense)',allocOf(t)?allocNum(al,'tax')||'':''),
    num('alInsurance','Insurance (an expense)',allocOf(t)?allocNum(al,'insurance')||'':''),
    num('alFee','Fees (an expense)',allocOf(t)?allocNum(al,'fee')||'':''),
    num('alEscrow','Escrow / tax account contribution (still your money)',allocOf(t)?allocNum(al,'escrow')||'':''),
    {name:'alEscrowId',label:'Escrow held in',type:'select',value:al.escrowId||'',options:escrowOpts}
  ];
}
function readAllocFields(v,amount,t){
  if(!v.isLoan) return null;
  const n=k=>{ const x=parseFloat(v[k]); return isFinite(x)&&x>0?r2(x):0; };
  const al={principal:n('alPrincipal'),extra:n('alExtra'),interest:n('alInterest'),tax:n('alTax'),
            insurance:n('alInsurance'),fee:n('alFee'),escrow:n('alEscrow'),escrowId:v.alEscrowId||'',
            source:(t&&t.alloc&&t.alloc.source)||'manual'};
  const assigned=r2(al.principal+al.extra+al.interest+al.tax+al.insurance+al.fee+al.escrow);
  if(assigned>amount+0.005){ toast('The parts add up to '+money(assigned)+', more than the '+money(amount)+' payment'); return false; }
  if(al.escrow>0&&!al.escrowId) toast('Escrow with no account is held as unallocated — add an escrow account to count it as yours');
  al.status=Math.abs(amount-assigned)<=0.005?'known':(assigned<=0.005?'pending':'partial');
  return al;
}
/* ---- resolving an unknown split from the loan's own statement ----
   When a loan statement gives the real balance, the difference between what Ledger could account for and
   what the lender says is the principal that the unallocated payments must have paid. That is evidence,
   not a guess — but it is still only ever PROPOSED: the user confirms before a single payment changes. */
function proposeAllocation(a,D){
  if(!a||a.kind!=='liability') return null;
  anchorOf(a);
  const cp=a.checkpoints.filter(c=>c.date<=D).pop(); if(!cp||cp.date!==D) return null;
  const prev=a.checkpoints.filter(c=>c.date<D).pop()||{date:'',balance:a.opening.balance};
  const inWindow=S.transactions.filter(t=>(!prev.date||(t.date||'')>prev.date)&&(t.date||'')<=D);
  const known=sum(inWindow.map(t=>effectOn(t,a)));
  const computed=r2(prev.balance+known);
  const gap=r2(computed-cp.balance);                       /* the loan fell further than Ledger could explain */
  const open=inWindow.filter(t=>isLoanPayment(t)&&t.toId===a.id&&allocUnresolved(t)>0.005)
                     .sort((x,y)=>(x.date||'').localeCompare(y.date||''));
  const pool=r2(sum(open.map(allocUnresolved)));
  if(!open.length||gap<=0.005||pool<=0.005) return null;
  let left=Math.min(gap,pool);
  const rows=open.map(t=>{ const u=allocUnresolved(t); const pr=r2(Math.min(u,left)); left=r2(left-pr);
    return {id:t.id,date:t.date,note:t.note,amount:t.amount,unresolved:u,principal:pr,interest:r2(u-pr)}; });
  return {accountId:a.id,accountName:a.name,date:D,from:prev.date,fromBalance:prev.balance,toBalance:cp.balance,
          gap:gap,pool:pool,rows:rows.filter(r=>r.principal>0.005||r.interest>0.005),
          shortfall:r2(Math.max(0,gap-pool))};
}
function applyAllocationProposal(p){
  if(!p) return 0; let n=0;
  p.rows.forEach(r=>{
    const t=S.transactions.find(x=>x.id===r.id); if(!t) return;
    const al=allocOf(t)||{}; const cur=Object.assign({principal:0,extra:0,interest:0,tax:0,insurance:0,fee:0,escrow:0,escrowId:''},al);
    cur.principal=r2(allocNum(cur,'principal')+r.principal);
    cur.interest=r2(allocNum(cur,'interest')+r.interest);
    cur.source='checkpoint'; t.alloc=cur; cur.status=allocState(t)==='known'?'known':allocState(t); n++;
  });
  dlog('loan allocation resolved from a statement',{account:p.accountName,date:p.date,payments:n,principal:r2(sum(p.rows.map(r=>r.principal)))});
  return n;
}
let pendingProposal=null;
function maybeProposeAllocation(a,date){
  const p=proposeAllocation(a,date); if(!p) return false;
  pendingProposal=p;
  const money2=v=>esc(money(v,{cur:a.cur||baseCur()}));
  openSheet('Work out the principal for '+a.name,`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">The statement says ${a.name} is now <b>${money2(p.toBalance)}</b>. Ledger can only account for <b>${money2(p.fromBalance)}</b>${p.from?' since '+esc(fmtDate(p.from)):' from the opening balance'} plus what it already knows, which leaves <b>${money2(p.gap)}</b> of the drop unexplained. ${p.rows.length} payment${p.rows.length===1?'':'s'} in that window ${p.rows.length===1?'has':'have'} no split recorded, so that ${money2(p.gap)} is the principal they must have paid — the rest is interest.</div>
    <div class="tbl" style="margin-bottom:10px">${p.rows.map(r=>`<div class="trow"><span>${esc(fmtDate(r.date))} <b>${esc(r.note||'Payment')}</b><div class="muted" style="font-size:12.5px">${money2(r.unresolved)} unallocated</div></span><span class="num">principal ${money2(r.principal)}<div class="muted" style="font-size:12.5px">interest ${money2(r.interest)}</div></span></div>`).join('')}</div>
    ${p.shortfall>0.005?`<div class="verdict" style="margin-bottom:10px">${money2(p.shortfall)} of the drop cannot come from these payments — something else also reduced this loan. Nothing will be invented for it.</div>`:''}
    <div class="muted" style="font-size:12.5px">Nothing changes until you accept. The statement balance is the checkpoint either way; this only decides how the payments already recorded are described.</div>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Leave them unallocated</button><button class="btn btn-primary" data-act="alloc-accept">Accept this split</button>`);
  return true;
}
/* a new mortgage or car loan may belong to something you already own. Ledger offers the link and nothing
   more: it never creates a property, and never invents what it is worth. */
function offerLoanLink(loan){
  const targets=S.accounts.filter(a=>a.kind!=='liability'&&(a.acctType==='real estate'||a.acctType==='vehicle')&&(a.secures||[]).indexOf(loan.id)<0);
  if(!targets.length) return;
  pendingLoanLink=loan.id;
  openSheet('Link '+loan.name+' to something you own?',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">${esc(loan.name)} is money you owe. If it is secured against something you already track, linking them lets Ledger show the equity. Ledger will not create a property or guess its value — link it only if it is already here.</div>
    ${targets.map(a=>`<label class="field" style="display:flex;align-items:center;gap:9px"><input type="radio" name="loanlink" value="${a.id}" style="width:auto;margin:0"><span style="margin:0;text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink);font-weight:400">${esc(a.name)} — ${esc(money(a.balance,{cur:a.cur||baseCur()}))}</span></label>`).join('')}`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Not now</button><button class="btn btn-primary" data-act="loan-link-save">Link them</button>`);
}
let pendingLoanLink=null;
function transferForm(t){
  if(S.accounts.length<2){ toast('You need two accounts to move money between'); return acctForm(); }
  const isNew=!t;
  t=t||{date:todayISO(),amount:'',fromId:S.accounts[0].id,
        toId:(S.accounts[1]||S.accounts[0]).id,note:''};
  openForm({
    title:isNew?'Move money':'Edit transfer',
    fields:[
      {name:'amount',label:'Amount',type:'number',value:t.amount,placeholder:'0.00'},
      {name:'date',label:'Date',type:'date',value:t.date},
      {name:'fromId',label:'Out of',type:'select',options:acctOptions(),value:t.fromId},
      {name:'toId',label:'Into',type:'select',options:acctOptions(),value:t.toId},
      {name:'note',label:'Note',type:'text',value:t.note,placeholder:'Card payment, moving to savings…'}
    ].concat(allocFields(t)),
    note:'A loan payment is not simply a transfer: only its principal reduces what you owe, and the interest, taxes and fees inside it are real spending. Tick “this is a loan payment” to split it — or leave the split blank and Ledger will hold it as unallocated rather than guess. Moving your own money is neither income nor spending, so a transfer changes both balances and leaves your net worth, budgets and spending split untouched. This is the right way to record a credit card payment or a top-up to savings.',
    onDelete:isNew?null:()=>{
      markUndo();
      const i=S.transactions.findIndex(x=>x.id===t.id);
      if(i>=0){ applyToAccount(S.transactions[i],-1); S.transactions.splice(i,1); }
      save(); closeModal(); render(); toast('Transfer deleted',true);
    },
    onSubmit:v=>{
      const amount=Math.abs(parseFloat(v.amount)||0);
      if(!amount){ toast('Enter an amount above zero'); return false; }
      if(v.fromId===v.toId){ toast('Pick two different accounts'); return false; }
      const next={id:t.id||uid(),date:v.date||todayISO(),amount:amount,type:'transfer',
        fromId:v.fromId,toId:v.toId,note:v.note.trim()};
      const al=readAllocFields(v,amount,t);
      if(al===false) return false;
      if(al) next.alloc=al; else if(t.alloc&&v.isLoan) next.alloc=clone(t.alloc);
      if(isNew){ next.source='manual'; next.createdAt=Date.now(); S.transactions.push(next); applyToAccount(next,1); }
      else{
        const i=S.transactions.findIndex(x=>x.id===t.id); const old=S.transactions[i];
        applyToAccount(old,-1);
        ['source','createdAt','raw','src','ref','fx','bankHint','auto'].forEach(k=>{ if(old[k]!==undefined&&next[k]===undefined) next[k]=old[k]; });
        next.updatedAt=Date.now();
        S.transactions[i]=next; applyToAccount(next,1);
      }
      save(); closeModal(); render(); toast(isNew?'Money moved':'Transfer updated');
    }
  });
}

function acctForm(a){
  const isNew=!a;
  a=a||{name:'',kind:'asset',label:'',balance:'',rate:'',minPayment:''};
  const typeVal=acctTypeInfo(a.acctType)?a.acctType:(a.acctType==='loan'?'other loan':'');
  openForm({
    title:isNew?'Add account':'Edit account',
    extraFoot:isNew?'':`<button class="btn btn-ghost" data-act="reconcile" data-id="${a.id}">${a.valued==='checkpoints'?'Update value…':'Reconcile…'}</button>`,
    fields:[
      {name:'name',label:'Name',type:'text',value:a.name,placeholder:'Chequing, Primary home, 2025 RAV4, TFSA…'},
      {name:'acctType',label:'What is it?',type:'select',value:typeVal,groups:[
        {label:'Assets — what you own',options:[{value:'',label:'— choose —'}].concat(ACCT_TYPES.filter(t=>t[2]==='asset').map(t=>({value:t[0],label:t[1]})))},
        {label:'Liabilities — what you owe',options:ACCT_TYPES.filter(t=>t[2]==='liability').map(t=>({value:t[0],label:t[1]}))}]},
      {name:'institution',label:'Institution / lender (optional)',type:'text',value:a.institution||'',placeholder:'Bank, lender, brokerage'},
      {name:'regType',label:'Registered type (investments only)',type:'select',value:a.invest&&a.invest.regType||'',options:[{value:'',label:'— not applicable —'}].concat(INVEST_TYPES.map(x=>({value:x,label:x})))},
      {name:'label',label:'Description (optional)',type:'text',value:a.label,placeholder:'Everyday card, joint account…'},
      {name:'cur',label:'Currency',type:'select',value:a.cur||baseCur(),
        options:['CAD','USD','EUR','GBP','AUD','CHF','JPY','INR','MGA','ZAR','BRL','MXN','KES','NGN','PHP','THB'].map(c=>({value:c,label:c+(c===baseCur()?' — your base':'')}))},
      {name:'balance',label:isNew?'Current balance':'Current balance (Ledger works this out from your transactions — change it here to correct it)',type:'number',value:isNew?a.balance:derivedBalance(a)},
      {name:'valued',label:'Its value comes from valuations I enter (home, car, investments) rather than from transactions',type:'checkbox',value:a.valued==='checkpoints'},
      {name:'secures',label:'Loans secured by this (a home can carry a mortgage and a HELOC)',type:'multicheck',value:(a.secures||[]).slice(),
       options:(a.kind==='liability'?[]:S.accounts.filter(x=>x.kind==='liability').map(x=>({value:x.id,label:x.name+' — '+money(x.balance,{cur:x.cur||baseCur()})+(acctTypeInfo(x.acctType)?' · '+acctTypeLabel(x):'')})))},
      {name:'since',label:'Owned / opened since (optional — before this date it does not count in history)',type:'date',value:a.since||(a.purchase&&a.purchase.date)||''},
      {name:'purchasePrice',label:'Purchase price (optional)',type:'number',value:a.purchase&&a.purchase.price!=null?a.purchase.price:'',placeholder:'0.00'},
      {name:'rate',label:'Interest rate % a year (debts)',type:'number',value:a.rate,placeholder:'19.99'},
      {name:'minPayment',label:'Minimum / regular payment a month (debts)',type:'number',value:a.minPayment,placeholder:'0.00'},
      {name:'inPlan',label:'Include this debt in the payoff plan',type:'checkbox',value:a.kind==='liability'?inDebtPlan(a):false},
      {name:'notes',label:'Notes (optional)',type:'text',value:a.notes||''}
    ],
    note:'For anything you owe, enter the balance as a positive number — an overpaid card can go negative and shows as a credit. Rate and payment drive the debt-free plan; leave them blank on assets.',
    onDelete:isNew?null:()=>{
      const links=linksOf(a);
      if(links.length){
        confirmSheet('Delete '+a.name+'?',
          `<div style="font-size:14px;line-height:1.6"><b>${esc(a.name)}</b> is linked to <b>${esc(links.join(', '))}</b>.<br><br>Deleting it removes only the link — ${links.length===1?'that account stays':'those accounts stay'} with ${links.length===1?'its':'their'} balance and history intact. This account and its own transactions history are what go.</div>`,
          'Delete account',()=>deleteAccount(a));
        return;
      }
      deleteAccount(a);
    },
    onSubmit:v=>{
      if(!v.name.trim()){ toast('Give the account a name'); return false; }
      if(!v.acctType&&isNew){ toast('Choose what kind of account this is'); return false; }
      const target=parseFloat(v.balance)||0;
      const next={id:a.id||uid(),name:v.name.trim(),kind:v.acctType?typeKind(v.acctType):a.kind,acctType:v.acctType||'',institution:(v.institution||'').trim(),label:v.label.trim(),cur:v.cur||baseCur(),
        balance:target,rate:parseFloat(v.rate)||0,minPayment:parseFloat(v.minPayment)||0,last4:a.last4||'',
        valued:v.valued?'checkpoints':'ledger',since:/^\d{4}-\d{2}-\d{2}$/.test(v.since||'')?v.since:'',notes:(v.notes||'').trim()};
      if(v.purchasePrice!==''&&isFinite(parseFloat(v.purchasePrice))) next.purchase={price:r2(parseFloat(v.purchasePrice)),date:next.since||''};
      if(v.acctType==='investment'&&v.regType) next.invest={regType:v.regType};
      if(a.loan) next.loan=clone(a.loan);
      if(next.kind==='liability'){ const wantIn=!!v.inPlan, byDefault=DEBT_DEFAULT_OUT.indexOf(next.acctType)<0;
        if(wantIn!==byDefault) next.loan=Object.assign({},next.loan||{},{inPlan:wantIn}); else if(next.loan) delete next.loan.inPlan; }
      const picked=Object.keys(v).filter(k=>k.indexOf('secures:')===0&&v[k]).map(k=>k.slice(8));
      next.secures=next.kind==='liability'?[]:picked;
      const dropped=(a.secures||[]).filter(id=>next.secures.indexOf(id)<0).map(id=>(acct(id)||{}).name).filter(Boolean);
      const finish=()=>{ acctFormApply(a,next,target,isNew); };
      if(dropped.length){
        confirmSheet('Unlink '+dropped.join(' and ')+'?',
          `<div style="font-size:14px;line-height:1.6">${esc(a.name)} will no longer be linked to <b>${esc(dropped.join(', '))}</b>.<br><br>Only the link goes: both accounts stay exactly as they are, with their balances and history untouched. Equity for ${esc(a.name)} will stop subtracting ${dropped.length===1?'that loan':'those loans'}.</div>`,
          'Unlink',finish); return false;
      }
      finish(); return true;
      if(next.cur!==baseCur()&&!hasRate(next.cur)){ S.rates=S.rates||{}; if(!S.rates[next.cur]) S.rates[next.cur]=0; }
    }
  });
}
function acctFormApply(a,next,target,isNew){
  if(isNew){ next.opening={balance:r2(target),source:'manual',at:Date.now()}; next.checkpoints=[]; anchorOf(next); S.accounts.push(next); }
  else{
    anchorOf(a); next.opening=clone(a.opening); next.checkpoints=clone(a.checkpoints); anchorOf(next);
    S.accounts[S.accounts.findIndex(x=>x.id===a.id)]=next;
    if(next.kind!==a.kind){ next.opening={balance:r2(target)}; next.checkpoints=[]; anchorOf(next); setBalanceTo(next,target); }
    else if(Math.abs(derivedBalance(next)-target)>0.005) setBalanceTo(next,target);
  }
  save(); closeModal(); render(); toast(isNew?'Account added':'Account updated');
}
/* every link this account is part of, in both directions */
function linksOf(a){
  const out=[];
  (a.secures||[]).forEach(id=>{ const l=acct(id); if(l) out.push(l.name); });
  S.accounts.forEach(x=>{ if(x.id!==a.id&&(x.secures||[]).indexOf(a.id)>=0) out.push(x.name); });
  return out;
}
function deleteAccount(a){
  markUndo();
  S.accounts=S.accounts.filter(x=>x.id!==a.id);
  S.accounts.forEach(x=>{ if(Array.isArray(x.secures)) x.secures=x.secures.filter(id=>id!==a.id); });
  save(); closeModal(); render(); toast('Account removed',true);
}

/* ============================ diagnostics ============================ */
function explainRules(note,accountId){
  const n=normText(note); const cands=[];
  (S.rules||[]).forEach((r,i)=>{
    const m=normText(r.match); let why='';
    if(r.on===false) why='disabled';
    else if(!m) why='empty match text';
    else if(r.accountId&&accountId&&r.accountId!==accountId) why='restricted to '+((acct(r.accountId)||{}).name||'another account');
    else if(r.accountId&&!accountId) why='restricted to an account, none given';
    else if(n.indexOf(m)<0) why='text not found';
    cands.push({rule:r,index:i+1,len:m.length,matched:!why,why:why});
  });
  const winner=matchRule(note,accountId);
  const matched=cands.filter(c=>c.matched).sort((a,b)=>b.len-a.len||a.index-b.index);
  let reason='';
  if(winner){ const tie=matched.filter(c=>c.len===matched[0].len); reason=tie.length>1?'several rules match with the same length ('+tie.map(c=>'“'+c.rule.match+'”').join(', ')+'); the one highest in the list wins':'longest matching text ('+matched[0].len+' characters)'; }
  return {note:note,cands:cands,matched:matched,winner:winner,reason:reason,category:winner?cat(winner.categoryId).name:'(no rule — default / manual)'};
}
function txFingerprint(t){ return [t.date,r2(t.amount),t.type,t.accountId||(t.fromId+'>'+t.toId),descKey(t.note)].join('|'); }
function balanceExplain(a){
  anchorOf(a); const gov=governingCheckpoint(a);
  const inc=[],exc=[]; S.transactions.forEach(t=>{ const e=effectOn(t,a); if(e===0) return; (countsFor(t,a)?inc:exc).push({t:t,e:e}); });
  inc.sort((x,y)=>x.t.date.localeCompare(y.t.date));
  const base=gov?gov.balance:a.opening.balance;
  const derived=derivedBalance(a), cached=r2(a.balance);
  return {a:a,gov:gov,base:base,included:inc,excluded:exc,derived:derived,cached:cached,diff:r2(derived-cached),formula:money(base)+inc.map(x=>(x.e>=0?' + ':' − ')+money(Math.abs(x.e))).join('')+' = '+money(derived)};
}
function integrityCheck(){
  const checks=[]; const add=(name,status,detail)=>checks.push({name:name,status:status,detail:detail||''});
  const ids={}; let dupIds=0; S.transactions.forEach(t=>{ if(ids[t.id]) dupIds++; ids[t.id]=1; });
  add('No duplicate transaction ids',dupIds?'fail':'pass',dupIds?dupIds+' duplicated':S.transactions.length+' unique');
  const aids={}; S.accounts.forEach(a=>{ aids[a.id]=(aids[a.id]||0)+1; }); const dupA=Object.keys(aids).filter(k=>aids[k]>1).length;
  add('No duplicate account ids',dupA?'fail':'pass',dupA?dupA+' duplicated':'');
  const orphanAcc=S.transactions.filter(t=>t.type!=='transfer'&&!acct(t.accountId));
  add('Every transaction points to a real account',orphanAcc.length?'fail':'pass',orphanAcc.length?orphanAcc.length+' orphaned':'');
  const badTr=S.transactions.filter(t=>t.type==='transfer'&&(!acct(t.fromId)||!acct(t.toId)||t.fromId===t.toId));
  add('Transfers link two real, different accounts',badTr.length?'fail':'pass',badTr.length?badTr.length+' broken':'');
  const orphanCat=S.transactions.filter(t=>t.type!=='transfer'&&!S.categories.some(c=>c.id===t.categoryId));
  add('Every transaction has a real category',orphanCat.length?'warn':'pass',orphanCat.length?orphanCat.length+' fall back to “Uncategorised”':'');
  const typeMismatch=S.transactions.filter(t=>t.type!=='transfer'&&S.categories.some(c=>c.id===t.categoryId)&&cat(t.categoryId).type!==t.type);
  add('Transaction direction matches its category',typeMismatch.length?'warn':'pass',typeMismatch.length?typeMismatch.length+' differ (edit → re-save fixes)':'');
  const badAmt=S.transactions.filter(t=>!(Number(t.amount)>0)||!/^\d{4}-\d{2}-\d{2}$/.test(t.date||''));
  add('Amounts positive and dates valid',badAmt.length?'fail':'pass',badAmt.length?badAmt.length+' bad':'');
  const stale=S.accounts.filter(a=>Math.abs(derivedBalance(a)-r2(a.balance))>0.005);
  add('Cached balances equal derived balances',stale.length?'warn':'pass',stale.length?stale.map(a=>a.name).join(', ')+' — rebuild fixes':'');
  const badCp=[]; S.accounts.forEach(a=>{ anchorOf(a); a.checkpoints.forEach(c=>{ if(!/^\d{4}-\d{2}-\d{2}$/.test(c.date)||!isFinite(c.balance)) badCp.push(a.name); }); if(!isFinite(a.opening.balance)) badCp.push(a.name+' (opening)'); });
  add('Checkpoints and opening balances are valid numbers/dates',badCp.length?'fail':'pass',badCp.join(', '));
  const badRec=S.recurring.filter(r=>!acct(r.accountId)||!S.categories.some(c=>c.id===r.categoryId)||!(Number(r.amount)>=0)||(isDated(r)&&!/^\d{4}-\d{2}-\d{2}$/.test(r.start||'')));
  add('Recurring items reference valid accounts/categories',badRec.length?'fail':'pass',badRec.length?badRec.map(r=>r.name).join(', '):'');
  const badRules=S.rules.filter(r=>!String(r.match||'').trim()||!S.categories.some(c=>c.id===r.categoryId)||(r.accountId&&!acct(r.accountId)));
  add('Auto-categorisation rules are valid',badRules.length?'warn':'pass',badRules.length?badRules.map(r=>r.match||'(blank)').join(', '):'');
  const badClose=[]; S.closes.forEach(c=>c.accounts.forEach(x=>{ if(!acct(x.accountId)) badClose.push(monthName(c.month)+': missing account'); else if(x.status==='reconciled'&&x.checkpointDate){ anchorOf(acct(x.accountId)); if(!acct(x.accountId).checkpoints.some(cp=>cp.date===x.checkpointDate)) badClose.push(monthName(c.month)+': '+acct(x.accountId).name+' checkpoint missing'); } }));
  add('Monthly closes point to valid accounts and checkpoints',badClose.length?'warn':'pass',badClose.join('; '));
  const review=S.closes.filter(c=>closeStatus(c)==='review').length;
  add('Closed months still reconcile',review?'warn':'pass',review?review+' need review':'');
  const badGoal=S.goals.filter(g=>!isFinite(Number(g.target))||!isFinite(Number(g.saved))||(g.deadline&&!/^\d{4}-\d{2}-\d{2}$/.test(g.deadline)));
  add('Savings goals contain valid numbers',badGoal.length?'fail':'pass',badGoal.map(g=>g.name).join(', '));
  const dp=S.debtPlan||{}; add('Debt plan contains valid numbers',isFinite(Number(dp.payment))?'pass':'fail','');
  { const bs=balanceSheet(); const indep=sum(S.accounts.map(a=>(a.kind==='liability'?-1:1)*toBase(a.balance,a.cur||baseCur())));
    add('Net worth equals total assets minus total liabilities',Math.abs(bs.assets-bs.liabilities-indep)<0.01&&Math.abs(netWorth()-indep)<0.01?'pass':'fail',money(bs.assets)+' − '+money(bs.liabilities)+' = '+money(bs.netWorth));
    const badBal=S.accounts.filter(a=>!isFinite(Number(a.balance))); add('Account balances are valid numbers (a negative debt balance is a credit, and fine)',badBal.length?'fail':'pass',badBal.map(a=>a.name).join(', '));
    const badLink=[]; S.accounts.forEach(a=>(a.secures||[]).forEach(id=>{ const l=acct(id); if(!l||l.kind!=='liability') badLink.push(a.name+' → '+id); })); add('Asset ↔ loan links point at existing liabilities',badLink.length?'fail':'pass',badLink.join(', '));
    const credit=S.accounts.filter(a=>a.kind==='liability'&&a.balance<-0.005); if(credit.length) add('Debts carrying a credit balance','warn',credit.map(a=>a.name+' '+money(-a.balance)+' credit').join(', '));
    const over=S.transactions.filter(t=>isLoanPayment(t)&&allocAssigned(t)>(Number(t.amount)||0)+0.005);
    add('Loan payment splits never exceed the payment',over.length?'fail':'pass',over.map(t=>fmtDate(t.date)+' '+(t.note||'')).join(', '));
    const openAlloc=S.transactions.filter(t=>isLoanPayment(t)&&allocUnresolved(t)>0.005);
    if(openAlloc.length) add('Loan payments awaiting a split','warn',openAlloc.length+' payment'+(openAlloc.length===1?'':'s')+' · '+money(sum(openAlloc.map(t=>toBase(allocUnresolved(t),curOfAcct(t.fromId)))))+' unallocated — cash has left, but nothing is counted as spending or as paying the loan down');
    const homeless=S.transactions.filter(t=>{ const a=allocOf(t); return a&&allocNum(a,'escrow')>0.005&&!allocEscrow(t); });
    if(homeless.length) add('Escrow contributions have an account to live in','warn',homeless.length+' payment'+(homeless.length===1?'':'s')+' set aside escrow with no account — held as unallocated rather than called spending');
    const badRev=S.transactions.filter(t=>(t.reversalOf&&!(txById(t.reversalOf)&&reversalPairOk(txById(t.reversalOf),t)&&txById(t.reversalOf).reversedBy===t.id))||(t.reversedBy&&!(txById(t.reversedBy)&&reversalPairOk(t,txById(t.reversedBy))&&txById(t.reversedBy).reversalOf===t.id)));
    add('Reversal links join two matching rows (same account, amount, opposite direction)',badRev.length?'fail':'pass',badRev.length?badRev.length+' broken — a reload drops the broken link':(S.transactions.filter(isReversal).length?S.transactions.filter(isReversal).length+' reversal'+(S.transactions.filter(isReversal).length===1?'':'s')+' linked':''));
    const preSince=S.transactions.filter(t=>(t.type==='transfer'?[t.fromId,t.toId]:[t.accountId]).some(id=>{ const a=acct(id); return a&&a.since&&(t.date||'')<a.since; }));
    add('Transactions are dated on or after their account’s “owned since” date',preSince.length?'warn':'pass',preSince.length?preSince.length+' dated before the account existed — they are inside its opening balance and do not move it; fix the date or the since date if that is wrong':'');
    const cp=S.transactions.filter(isCardPayIn); if(cp.length) add('Debt payments with no source account','warn',cp.length+' payment'+(cp.length===1?'':'s')+' · '+money(sum(cp.map(t=>toBase(t.amount,curOfTx(t)))))+' — lowered the debt, not counted as income, but the account they were paid from is not reduced; edit each one or import that account’s statement');
    const unrec=unreconciledLiabilities(); if(unrec.length) add('Liabilities without a reconciled statement balance','warn',netWorthIncompleteNote()+': '+unrec.map(a=>a.name).join(', '));
    const kindClash=S.accounts.filter(a=>a.acctType&&acctTypeInfo(a.acctType)&&typeKind(a.acctType)!==a.kind);
    add('Every account sits on the side its type says',kindClash.length?'fail':'pass',kindClash.map(a=>a.name+' is '+acctTypeLabel(a)+' but filed as '+(a.kind==='liability'?'a debt':'an asset')).join(', '));
    const planRefs=debts().filter(a=>!S.accounts.some(x=>x.id===a.id));
    add('The payoff plan only references real liability accounts',planRefs.length?'fail':'pass',debts().length+' debt'+(debts().length===1?'':'s')+' in the plan'+(debtCandidates().length-debts().length?', '+(debtCandidates().length-debts().length)+' left out or settled':''));
    const invIncome=S.transactions.filter(t=>t.type==='in'&&acct(t.accountId)&&acct(t.accountId).acctType==='investment'&&/market (gain|loss|change)|unrealized|unrealised|change in value/i.test(t.note||''));
    add('Investment growth is not recorded as income',invIncome.length?'warn':'pass',invIncome.length?invIncome.length+' row'+(invIncome.length===1?'':'s')+' look like market movement booked as income — a valuation carries growth better':'');
    const early=[]; S.accounts.forEach(a=>{ if(!a.since) return; const n=S.transactions.filter(t=>effectOn(t,a)!==0&&(t.date||'')<a.since).length; if(n) early.push(a.name+' ('+n+')'); });
    add('Transactions all fall on or after the date their account began',early.length?'warn':'pass',early.join(', '));
    const bad=[]; S.accounts.forEach(a=>{ if(a.since&&!/^\d{4}-\d{2}-\d{2}$/.test(a.since)) bad.push(a.name+' since'); (a.checkpoints||[]).forEach(c=>{ if(!/^\d{4}-\d{2}-\d{2}$/.test(c.date||'')||!isFinite(Number(c.balance))) bad.push(a.name+' '+(c.date||'(no date)')); }); });
    add('Valuation / checkpoint history is well formed',bad.length?'fail':'pass',bad.join(', '));
    { const T=todayISO(), ok=Math.abs(netWorthAt(T)-netWorth())<0.02;
      const futTx=S.transactions.filter(t=>(t.date||'')>T).length, futCp=sum(S.accounts.map(a=>(a.checkpoints||[]).filter(c=>c.date>T).length));
      const why=[futTx?futTx+' transaction'+(futTx===1?'':'s'):'',futCp?futCp+' checkpoint'+(futCp===1?'':'s'):''].filter(Boolean).join(' and ');
      add('Net worth today equals net worth as of today',ok?'pass':'fail',why?why+' dated after today — held out of every current figure until their date':''); } }
  /* a rate or a minimum is optional — a house has neither. Only a value that IS there but is not a number is wrong. */
  const numOk=v=>v===undefined||v===null||v===''||isFinite(Number(v));
  const badAcctNum=S.accounts.filter(a=>!numOk(a.rate)||!numOk(a.minPayment));
  add('Account rates / minimums are numeric',badAcctNum.length?'fail':'pass',badAcctNum.map(a=>a.name).join(', '));
  const badRates=usedCurrencies().filter(c=>!hasRate(c)); add('Every used currency has a rate',badRates.length?'warn':'pass',badRates.join(', '));
  const dupBudget=Object.keys(S.budgets).filter(k=>!S.categories.some(c=>c.id===k)); add('Budgets reference real categories',dupBudget.length?'warn':'pass',dupBudget.length+' stale');
  let serial='ok'; try{ const j=JSON.stringify(S); JSON.parse(j); serial=Math.round(j.length/1024)+' KB'; }catch(e){ serial=''; } add('Backup data serialises to JSON',serial?'pass':'fail',serial);
  const gen=Object.keys(S.generated).filter(k=>!S.recurring.some(r=>k.indexOf(r.id+':')===0)).length; add('Recurring bookkeeping has no stale stamps',gen?'warn':'pass',gen?gen+' stamps for deleted items (harmless)':'');
  /* a checkpoint should be reproduced by the checkpoint before it plus the rows between them; a gap means rows are
     missing or wrong between two statements — a warning, because a checkpoint is still the bank's word for its own day */
  const chain=[]; S.accounts.forEach(a=>{ anchorOf(a); const cps=(a.checkpoints||[]).slice().sort((x,y)=>x.date.localeCompare(y.date)); for(let i=1;i<cps.length;i++){ const got=balanceAsOf(a,cps[i].date,{independent:true}); if(Math.abs(got-cps[i].balance)>0.005) chain.push(a.name+' '+cps[i].date+': rows give '+money(got)+', checkpoint says '+money(cps[i].balance)); } });
  add('Checkpoints follow from the rows between them',chain.length?'warn':'pass',chain.length?chain.slice(0,4).join(' · ')+(chain.length>4?' · +'+(chain.length-4)+' more':''):'every checkpoint is reproduced by the previous one plus its rows');
  const pass=checks.filter(c=>c.status==='pass').length, warn=checks.filter(c=>c.status==='warn').length, fail=checks.filter(c=>c.status==='fail').length;
  dlog('integrity check',{pass:pass,warn:warn,fail:fail});
  return {checks:checks,pass:pass,warn:warn,fail:fail};
}
function repairPlans(){
  const plans=[];
  const stale=S.accounts.filter(a=>Math.abs(derivedBalance(a)-r2(a.balance))>0.005);
  plans.push({id:'rebuild',name:'Rebuild balances',preview:stale.length?stale.map(a=>a.name+': cached '+money(a.balance)+' → '+money(derivedBalance(a))).join('; '):'all balances already match — nothing to change',count:stale.length,
    apply:()=>{ recalcBalances(); }});
  const orphanTx=S.transactions.filter(t=>(t.type!=='transfer'&&!acct(t.accountId))||(t.type==='transfer'&&(!acct(t.fromId)||!acct(t.toId)||t.fromId===t.toId)));
  const orphanCat=S.transactions.filter(t=>t.type!=='transfer'&&!S.categories.some(c=>c.id===t.categoryId));
  const fallback=S.categories.find(c=>c.id==='c10')||S.categories.find(c=>c.type==='out');
  const badRec=S.recurring.filter(r=>!acct(r.accountId)||!S.categories.some(c=>c.id===r.categoryId));
  const badRules=S.rules.filter(r=>!String(r.match||'').trim()||!S.categories.some(c=>c.id===r.categoryId)||(r.accountId&&!acct(r.accountId)));
  const n=orphanTx.length+orphanCat.length+badRec.length+badRules.length;
  plans.push({id:'orphans',name:'Remove orphaned references',count:n,preview:n?[orphanTx.length?orphanTx.length+' transaction'+(orphanTx.length===1?'':'s')+' whose account no longer exists → DELETED':'',orphanCat.length?orphanCat.length+' with a missing category → moved to “'+(fallback?fallback.name:'?')+'”':'',badRec.length?badRec.length+' recurring item'+(badRec.length===1?'':'s')+' with a missing account/category → paused':'',badRules.length?badRules.length+' invalid rule'+(badRules.length===1?'':'s')+' → deleted':''].filter(Boolean).join('; '):'nothing orphaned',
    apply:()=>{ S.transactions=S.transactions.filter(t=>orphanTx.indexOf(t)<0); orphanCat.forEach(t=>{ if(fallback){ t.categoryId=fallback.id; t.type=fallback.type; } }); badRec.forEach(r=>{ r.active=false; }); S.rules=S.rules.filter(r=>badRules.indexOf(r)<0); }});
  const fps={}; let dupFp=0; S.transactions.forEach(t=>{ if(t.type==='transfer') return; const k=txFingerprint(t); if(fps[k]) dupFp++; fps[k]=1; });
  plans.push({id:'fingerprints',name:'Rebuild duplicate fingerprints',count:0,preview:'fingerprints are computed live (date | amount | direction | account | merchant; a bank reference id or the imported statement line settles it when present); '+(dupFp?dupFp+' transaction'+(dupFp===1?'':'s')+' share one with another — review them by hand, nothing is deleted automatically':'no two transactions share one'),apply:()=>{}});
  const rr=rulesRunPreview(false); plans.push({id:'rules',name:'Re-run categorisation',count:rr.length,preview:rr.length?rr.length+' transaction'+(rr.length===1?'':'s')+' would change category (hand-picked ones untouched)':'nothing would change',apply:()=>{ rr.forEach(h=>applyRule(h.t,true)); }});
  const sg=detectRecurring(); plans.push({id:'recurring',name:'Recalculate recurring detection',count:0,preview:sg.length+' suggestion'+(sg.length===1?'':'s')+' currently: '+(sg.map(x=>x.merchant).join(', ')||'none')+' (suggestions only — nothing is created)',apply:()=>{}});
  const rv=S.closes.filter(c=>closeStatus(c)==='review'); plans.push({id:'closes',name:'Revalidate monthly closes',count:0,preview:S.closes.length+' close'+(S.closes.length===1?'':'s')+', '+rv.length+' need'+(rv.length===1?'s':'')+' review — statuses are recomputed live; records are never rewritten',apply:()=>{}});
  return plans;
}
let diagTab='status', diagRuleTest='', diagBackupSteps=null, diagIntegrity=null, diagRepairs=null;
function diagnosticsModal(tab){
  if(tab) diagTab=tab;
  const tabs=[['status','Status'],['balances','Balances'],['rules','Rules'],['recurring','Recurring'],['imports','Imports'],['checkpoints','Checkpoints'],['closes','Closes'],['backup','Backup'],['integrity','Integrity'],['log','Log'],['repairs','Repairs']];
  const body=`<div class="tabs" style="margin:-18px -18px 16px">${tabs.map(([v,l])=>`<button class="tab" data-act="diag-tab" data-v="${v}" aria-selected="${diagTab===v}">${l}</button>`).join('')}</div>${diagPanel()}`;
  openSheet('Diagnostics',body,`<span class="spacer"></span><button class="btn btn-primary" data-act="close-modal">Done</button>`);
  const sh=$('.sheet'); if(sh) sh.classList.add('wide');
}
function kv(k,v){ return `<div class="trow" style="padding:6px 12px"><span>${k}</span><span class="num" style="max-width:60%;white-space:normal;word-break:break-word">${v}</span></div>`; }
function importPipelineHTML(tr){
  if(!tr) return '<div class="muted" style="font-size:13px">No import yet this session.</div>';
  return `<div class="eyebrow" style="margin:12px 0 6px">Import pipeline · ${esc(tr.source)}${tr.engine?' · '+esc(tr.engine):''} · ${new Date(tr.at).toLocaleTimeString()}</div>
    ${tr.rows.map((r,i)=>`<details style="margin-bottom:6px"><summary style="cursor:pointer;font-size:13px">${i+1}. ${esc(r.parsed.note||r.raw)} — ${esc(money(r.normalized.amount))} <span class="muted">${esc(String(r.final&&r.final.id?'added':r.final))}</span></summary>
      <div class="tbl" style="margin:6px 0 0 14px;font-size:12.5px">${kv('RAW INPUT',esc(r.raw||''))}${kv('PARSED',esc(JSON.stringify(r.parsed)))}${kv('NORMALIZED',esc(JSON.stringify(r.normalized)))}${kv('CATEGORY RULE',esc(r.rule||'none — model/keyword guess or default'))}${kv('DUPLICATE CHECK',esc(r.dup))}${r.flags&&r.flags.length?kv('FLAGS',esc(r.flags.join(' · '))):''}${kv('FINAL LEDGER ROW',esc(typeof r.final==='string'?r.final:JSON.stringify(r.final)))}</div></details>`).join('')}
    ${tr.skipped.length?`<div class="eyebrow" style="margin:12px 0 6px">Skipped (${tr.skipped.length})</div><div class="tbl">${tr.skipped.map(x=>kv(esc(x.raw),'<span style="color:var(--out)">'+esc(x.why)+'</span>')).join('')}</div>`:'<div class="muted" style="font-size:12.5px">Nothing skipped.</div>'}`;
}
function diagPanel(){
  if(diagTab==='status'){
    const ua=(navigator.userAgentData&&navigator.userAgentData.brands||[]).map(b=>b.brand+' '+b.version).join(', ')||navigator.userAgent;
    const cps=sum(S.accounts.map(a=>{ anchorOf(a); return a.checkpoints.length; }));
    return `<div class="tbl">${kv('App version',APP_VERSION)}${kv('Now',new Date().toLocaleString())}${kv('Browser',esc(ua))}${kv('Page origin',location.protocol+'//'+(location.host||'(local file)'))}${kv('Storage',STORAGE_WHERE==='device'?'browser storage (localStorage)':STORAGE_WHERE)}
      ${kv('Transactions',S.transactions.length)}${kv('Accounts',S.accounts.length)}${kv('Checkpoints',cps)}${kv('Recurring items',S.recurring.length)}${kv('Categorisation rules',S.rules.length)}${kv('Savings goals',S.goals.length)}${kv('Monthly closes',S.closes.length+(S.closes.filter(c=>closeStatus(c)==='review').length?' ('+S.closes.filter(c=>closeStatus(c)==='review').length+' need review)':''))}
      ${kv('Backup',backupState==='on'?(lastDiskVerified?'on · verified':'on · not yet verified')+' · '+esc(backupKind==='dir'?'folder ':'file ')+esc(backupName()):backupState==='ask'?'paused — permission needed':'off')}${kv('Last browser save',lastLocalSave?new Date(lastLocalSave).toLocaleString():'—')}${kv('Last verified disk backup',lastDiskWrite?new Date(lastDiskWrite).toLocaleString():'—')}${kv('Last restore',S.settings.lastRestore?new Date(S.settings.lastRestore).toLocaleString():'never')}${kv('AI provider',aiKey()?esc(aiVendor()+' · '+aiModel()+' (key set)'):'none — on-device parsing')}${kv('Debug log entries',(dlogLoaded?DLOG:(loadDlog(),DLOG)).length)}</div>`;
  }
  if(diagTab==='balances'){
    return S.accounts.map(a=>{ const x=balanceExplain(a);
      return `<details style="margin-bottom:8px" ${Math.abs(x.diff)>0.005?'open':''}><summary style="cursor:pointer;font-size:14px"><b>${esc(a.name)}</b> <span class="num">${esc(money(x.derived))}</span>${Math.abs(x.diff)>0.005?' <b style="color:var(--out)">cache differs by '+esc(money(x.diff))+'</b>':' <span style="color:var(--in)">✓</span>'}</summary>
        <div class="tbl" style="margin-top:6px;font-size:12.5px">${kv('Governing checkpoint',x.gov?esc(fmtDate(x.gov.date))+' = '+esc(money(x.gov.balance)):'none — opening balance '+esc(money(a.opening.balance)))}${kv('Transactions after checkpoint',x.included.length+' included')}${kv('Excluded (on/before checkpoint)',x.excluded.length)}${kv('Cached / display balance',esc(money(x.cached)))}${kv('Derived balance',esc(money(x.derived)))}${kv('Difference',Math.abs(x.diff)>0.005?'<span style="color:var(--out)">'+esc(money(x.diff))+'</span>':'0')}</div>
        <div class="num" style="font-size:12.5px;margin:8px 0;word-break:break-word">${esc(x.formula)}</div>
        ${x.included.length?`<div class="tbl" style="font-size:12.5px;max-height:220px;overflow:auto">${x.included.map(i=>kv(esc(fmtDate(i.t.date))+' '+esc(i.t.note||(isTransfer(i.t)?'transfer':cat(i.t.categoryId).name)),'<span style="color:'+(i.e>=0?'var(--in)':'var(--out)')+'">'+esc(signed(i.e))+'</span>')).join('')}</div>`:''}</details>`; }).join('')||'<div class="muted">No accounts.</div>';
  }
  if(diagTab==='rules'){
    const ex=diagRuleTest?explainRules(diagRuleTest,($('#diagRuleAcct')||{}).value||''):null;
    return `<div class="muted" style="font-size:13px;margin-bottom:10px">Type a description and see exactly how the rules would file it. Nothing is created.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><input type="text" id="diagRuleText" value="${esc(diagRuleTest)}" placeholder="UBER EATS TORONTO" style="flex:1;min-width:180px"><select id="diagRuleAcct" style="width:auto"><option value="">Any account</option>${S.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><button class="btn btn-primary" data-act="diag-rule-test">Test rules</button></div>
      ${ex?`<div class="tbl" style="margin-bottom:10px">${kv('Result','<b>'+esc(ex.category)+'</b>')}${kv('Winner',ex.winner?'“'+esc(ex.winner.match)+'”':'—')}${ex.reason?kv('Why',esc(ex.reason)):''}</div>
        <div class="eyebrow" style="margin-bottom:6px">All rules (${ex.cands.length})</div><div class="tbl">${ex.cands.map(c=>kv('#'+c.index+' “'+esc(c.rule.match)+'” → '+esc(cat(c.rule.categoryId).name),c.matched?'<span style="color:var(--in)">matches · '+c.len+' chars'+(ex.winner&&ex.winner.id===c.rule.id?' · WINNER':'')+'</span>':'<span class="muted">'+esc(c.why)+'</span>')).join('')||'<div class="trow muted">no rules yet</div>'}</div>`:''}`;
  }
  if(diagTab==='recurring'){
    const all=detectRecurring({all:true});
    return `<div class="muted" style="font-size:13px;margin-bottom:10px">Confidence = 45% rhythm regularity + 15% amount consistency + 25% number of matches + 15% recency. Shown only at 50%+, with regularity ≥ 40% and at most one odd gap.</div>
      ${all.map(x=>`<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:14px"><b>${esc(x.merchant)}</b> · ${esc(freqLabel(x.freq))} · ${x.confidence}%${x.hidden?' <span class="muted">(hidden: '+esc(x.hidden)+')</span>':''}</summary>
        <div class="tbl" style="margin-top:6px;font-size:12.5px">${kv('Matches',x.count)}${kv('Intervals (days)',x.intervals.join(', ')+' · median '+x.median)}${kv('Typical amount',esc(money(x.typical)))}${kv('Range',esc(money(x.min))+' – '+esc(money(x.max)))}${kv('Detected frequency',esc(freqLabel(x.freq))+' (nominal '+x.nominal+' days)')}${kv('Regularity',x.parts.regularity+'% (mean deviation '+x.parts.deviation+'% of nominal)')}${kv('Amount consistency',x.parts.amount+'%')}${kv('Count score',x.parts.count+'%')}${kv('Recency',x.parts.recency+'% (last '+esc(fmtDate(x.lastDate))+')')}${kv('Confidence',x.confidence+'%')}${kv('Next predicted',esc(fmtDate(x.nextDate)))}${kv('Account / category',esc((acct(x.accountId)||{}).name||'?')+' · '+esc(cat(x.categoryId).name))}${x.existingId?kv('Existing recurring item',esc((S.recurring.find(r=>r.id===x.existingId)||{}).name||'')):''}</div></details>`).join('')||'<div class="muted">No candidate patterns (needs 3+ matches, 2 for yearly).</div>'}`;
  }
  if(diagTab==='imports') return importPipelineHTML(importTrace);
  if(diagTab==='checkpoints'){
    return S.accounts.map(a=>{ anchorOf(a); const gov=governingCheckpoint(a);
      return `<div style="margin-bottom:12px"><div style="font-size:14px;margin-bottom:4px"><b>${esc(a.name)}</b> <span class="muted">— ${gov?'the '+esc(fmtDate(gov.date))+' checkpoint governs because it is the latest-dated one; rows dated after it add up to today\'s balance':'no checkpoint: the opening balance plus every transaction'}</span></div>
        <div class="tbl" style="font-size:12.5px">${kv('Opening balance',esc(money(a.opening.balance)))}${a.checkpoints.map(c=>{ const cl=S.closes.find(x=>x.accounts.some(y=>y.accountId===a.id&&y.checkpointDate===c.date&&y.status==='reconciled')); return kv(esc(fmtDate(c.date))+(gov&&gov.date===c.date?' <b style="color:var(--in)">governing</b>':' <span class="muted">superseded</span>'),esc(money(c.balance))+'<div class="muted" style="font-size:11.5px">created '+(c.at?new Date(c.at).toLocaleString():'—')+' · source: '+(cl?'monthly close '+esc(monthName(cl.month,true)):'reconcile / statement')+'</div>'); }).join('')}</div></div>`; }).join('')||'<div class="muted">No accounts.</div>';
  }
  if(diagTab==='closes'){
    return S.closes.slice().sort((a,b)=>b.month.localeCompare(a.month)).map(c=>{ const st=closeStatus(c), issues=closeReview(c);
      return `<details style="margin-bottom:8px" ${st==='review'?'open':''}><summary style="cursor:pointer;font-size:14px"><b>${esc(monthName(c.month,true))}</b> · ${st==='closed'?'<span style="color:var(--in)">closed</span>':st==='review'?'<span style="color:var(--out)">needs review</span>':'open'}</summary>
        ${issues.length?`<div class="verdict bad" style="font-size:12.5px">${issues.map(i=>esc((acct(i.accountId)||{}).name||'?')+': '+i.why).join('<br>')}</div>`:''}
        <div class="tbl" style="font-size:12.5px">${c.accounts.map(x=>{ const a=acct(x.accountId); const cur=a&&x.statementDate?balanceAsOf(a,x.statementDate):null; const fpNow=a&&x.statementDate?historyFP(a,x.statementDate):null;
          return kv(esc(a?a.name:'(missing account)')+' · '+esc(x.status),x.status==='reconciled'?'saved ledger '+esc(money(x.ledger))+' · statement '+esc(money(x.statement))+' on '+esc(fmtDate(x.statementDate))+' · checkpoint '+(x.checkpointDate?esc(fmtDate(x.checkpointDate)):'—')+'<br>now recalculated '+esc(cur===null?'—':money(cur))+' · history '+(x.fp&&fpNow?(x.fp.count===fpNow.count&&Math.abs(x.fp.net-fpNow.net)<0.005?'<span style="color:var(--in)">unchanged</span>':'<span style="color:var(--out)">changed ('+x.fp.count+'→'+fpNow.count+' rows, net '+esc(money(x.fp.net))+'→'+esc(money(fpNow.net))+')</span>'):'—'):esc(x.note||'')); }).join('')}</div></details>`; }).join('')||'<div class="muted">No monthly closes yet.</div>';
  }
  if(diagTab==='backup'){
    return `<div class="muted" style="font-size:13px;margin-bottom:10px">Runs the real file-system test plus storage, schema and restore-compatibility checks. Error messages never include your balances.</div>
      <button class="btn btn-primary" data-act="diag-backup-run">Run full backup diagnostic</button>
      ${diagBackupSteps?`<div class="tbl" style="margin-top:12px">${diagBackupSteps.map(x=>kv((x.ok?'<span style="color:var(--in)">PASS</span> ':'<span style="color:var(--out)">FAIL</span> ')+esc(x.name),esc(x.detail))).join('')}</div>`:''}`;
  }
  if(diagTab==='integrity'){
    const r=diagIntegrity;
    return `<button class="btn btn-primary" data-act="diag-integrity-run">Run full Ledger integrity check</button>
      ${r?`<div style="font-size:15px;margin:12px 0 8px"><span style="color:var(--in)">✓ ${r.pass} checks passed</span> · <span style="color:var(--accent)">⚠ ${r.warn} warning${r.warn===1?'':'s'}</span> · <span style="color:var(--out)">✗ ${r.fail} failure${r.fail===1?'':'s'}</span></div>
        <details ${r.warn+r.fail?'open':''}><summary style="cursor:pointer">Details</summary><div class="tbl" style="margin-top:6px;font-size:12.5px">${r.checks.map(c=>kv((c.status==='pass'?'<span style="color:var(--in)">✓</span> ':c.status==='warn'?'<span style="color:var(--accent)">⚠</span> ':'<span style="color:var(--out)">✗</span> ')+esc(c.name),esc(c.detail))).join('')}</div></details>`:''}`;
  }
  if(diagTab==='log'){
    if(!dlogLoaded) loadDlog();
    const items=DLOG.slice().reverse();
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><button class="btn btn-sm" data-act="diag-log-copy">Copy debug log</button><button class="btn btn-sm" data-act="diag-log-export">Export debug log</button><button class="btn btn-sm btn-ghost" data-act="diag-log-clear">Clear debug log</button><span class="muted num" style="align-self:center;font-size:12px">${items.length} of max ${DLOG_MAX} · kept outside backups</span></div>
      <div class="tbl" style="font-size:12px;max-height:50vh;overflow:auto">${items.slice(0,300).map(e=>kv(new Date(e.t).toLocaleTimeString()+' · <b>'+esc(e.ev)+'</b>',esc(typeof e.d==='string'?e.d:JSON.stringify(e.d)))).join('')||'<div class="trow muted">empty — events are recorded while debug mode is on</div>'}</div>`;
  }
  if(diagTab==='repairs'){
    diagRepairs=repairPlans();
    return `<div class="muted" style="font-size:13px;margin-bottom:10px">Every repair shows what would change first. Nothing is applied until you approve it, and Undo is available afterwards.</div>
      ${diagRepairs.map(p=>`<div class="tbl" style="margin-bottom:8px"><div class="trow" style="flex-wrap:wrap;gap:6px 12px"><span style="flex:1 1 200px"><div><b>${esc(p.name)}</b></div><div class="muted" style="font-size:12.5px">${esc(p.preview)}</div></span><span>${p.count?`<button class="btn btn-sm btn-primary" data-act="diag-repair" data-v="${p.id}">Apply (${p.count})</button>`:'<span class="muted" style="font-size:12px">nothing to apply</span>'}</span></div></div>`).join('')}`;
  }
  return '';
}
function txDebugHTML(t){
  if(!t||!t.id) return '';
  const a=acct(t.accountId), rule=t.ruleId?S.rules.find(r=>r.id===t.ruleId):null;
  const sg=detectRecurring({all:true}).find(x=>x.txIds.indexOf(t.id)>=0);
  return `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12.5px;color:var(--ink-3)">Debug: internals</summary><div class="tbl" style="margin-top:6px;font-size:12px">
    ${kv('Transaction id',esc(t.id))}${kv('Account id',esc(t.accountId||t.fromId+'→'+t.toId)+(a?' ('+esc(a.name)+')':''))}${kv('Raw imported description',esc(t.raw||'—'))}${kv('Cleaned description',esc(t.note||''))}${kv('Amount (normalized, always positive)',esc(String(t.amount)))}${kv('Direction',esc(t.type))}${kv('Category',esc(t.type==='transfer'?'—':cat(t.categoryId).name))}${kv('Category source',esc(t.catSource||'unknown (older entry)'))}${kv('Rule matched',rule?'“'+esc(rule.match)+'”':'none')}${kv('Import source',esc(t.source||(t.auto?'recurring':'manual (older entry)')))}${kv('Created',t.createdAt?new Date(t.createdAt).toLocaleString():'—')}${kv('Last modified',t.updatedAt?new Date(t.updatedAt).toLocaleString():'—')}${kv('Duplicate fingerprint',esc(txFingerprint(t)))}${kv('Recurring match',sg?esc(sg.merchant+' · '+freqLabel(sg.freq)+' · '+sg.confidence+'%'):t.recurringId?'booked by recurring item':'none')}</div></details>`;
}

/* ---------- reconciliation: Ledger vs the bank ---------- */
/* For assets valued by hand (home, car, investments): the valuations ARE the history. Same checkpoint
   machinery as a bank reconciliation, different language — nothing here compares against a statement. */
function valuationModal(a){
  anchorOf(a); const cur=a.cur||baseCur(), gov=governingCheckpoint(a);
  const rows=a.checkpoints.slice().reverse(); const T=todayISO();
  openSheet('Value of '+a.name,`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">This account's value comes from the valuations you enter. The newest one governs; anything you record against the account after that date still moves it. Nothing here changes your transactions.</div>
    <div class="cmp" style="margin-bottom:12px"><div>Value now</div><div></div><div class="num"><b>${esc(money(derivedBalance(a),{cur:cur}))}</b></div>
      <div class="muted" style="font-size:12.5px">${gov?'last valued '+esc(fmtDate(gov.date)):'from the opening value — no valuation recorded yet'}${futureCheckpoints(a).length?' · '+futureCheckpoints(a).length+' later valuation'+(futureCheckpoints(a).length===1?'':'s')+' dated ahead, not counted yet':''}</div><div></div><div></div></div>
    <div class="eyebrow" style="margin:4px 0 6px">Valuation history</div>
    <div class="tbl" style="margin-bottom:12px">
      ${rows.map(c=>`<div class="trow"><span>${esc(fmtDate(c.date))}${c.date>T?' <span class="tag">takes effect '+esc(fmtDate(c.date))+'</span>':(gov&&c.date===gov.date)?' <b style="color:var(--in)">← current</b>':''}</span><span class="num">${esc(money(c.balance,{cur:cur}))} <button class="btn btn-sm btn-ghost" data-act="val-remove" data-id="${a.id}" data-v="${esc(c.date)}">Remove</button></span></div>`).join('')}
      <div class="trow muted" style="font-size:12.5px"><span>Opening value${a.since?' (owned since '+esc(fmtDate(a.since))+')':''}</span><span class="num">${esc(money(a.opening.balance,{cur:cur}))}</span></div>
    </div>
    <div class="grid2">
      <label class="field"><span>New value</span><input type="number" step="0.01" inputmode="decimal" id="valAmt" placeholder="0.00"></label>
      <label class="field"><span>As of</span><input type="date" id="valDate" value="${esc(todayISO())}"></label>
    </div>
    ${a.purchase&&a.purchase.price!=null?`<div class="muted" style="font-size:12.5px">Bought for ${esc(money(a.purchase.price,{cur:cur}))}${a.purchase.date?' on '+esc(fmtDate(a.purchase.date)):''}.</div>`:''}`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Done</button><button class="btn btn-primary" data-act="val-add" data-id="${a.id}">Record valuation</button>`);
}
function reconcileModal(a,vals){
  vals=vals||{};
  const an=anchorOf(a), calc=derivedBalance(a), gov=governingCheckpoint(a);
  const futureRows=S.transactions.filter(t=>effectOn(t,a)!==0&&isFuture(t)), futureCps=futureCheckpoints(a);
  const actualRaw=vals.actual, date=vals.date||todayISO();
  const actual=actualRaw===''||actualRaw==null?null:r2(actualRaw);
  const diff=actual===null?null:r2(actual-calc);
  const since=sinceAnchor(a);
  const baseCp=a.checkpoints.filter(c=>c.date<date).pop()||{date:'',balance:a.opening.balance};
  const upto=S.transactions.filter(t=>effectOn(t,a)!==0&&(!baseCp.date||t.date>baseCp.date)&&t.date<=date);
  const calcAt=balanceAsOf(a,date,{independent:true});
  const diffAt=actual===null?null:r2(actual-calcAt);
  openSheet('Reconcile '+a.name,`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:12px">Type what the bank shows and Ledger compares. A difference means a transaction is missing, doubled, or in the wrong account — find it in the list, or accept the bank's figure as a checkpoint for that date. Nothing in your history is changed either way.</div>
    ${futureRows.length||futureCps.length?`<div class="muted" style="font-size:12.5px;line-height:1.5;margin-bottom:10px">${[futureRows.length?futureRows.length+' transaction'+(futureRows.length===1?'':'s')+' dated after today':'',futureCps.length?futureCps.length+' checkpoint'+(futureCps.length===1?'':'s')+' dated after today':''].filter(Boolean).join(' and ')} — held out of today's figure until ${esc(fmtDate([].concat(futureRows.map(t=>t.date),futureCps.map(c=>c.date)).sort()[0]))}.</div>`:''}
    <div class="cmp" style="margin-bottom:12px">
      <div>Ledger's calculated balance today</div><div></div><div class="num"><b>${esc(money(calc))}</b></div>
      <div class="muted" style="font-size:12.5px">${an.date?'checkpoint '+esc(money(an.balance))+' on '+esc(fmtDate(an.date))+' + '+since.length+' transaction'+(since.length===1?'':'s')+' since':'opening balance '+esc(money(an.balance))+' + '+since.length+' transaction'+(since.length===1?'':'s')}</div><div></div><div></div>
    </div>
    ${a.checkpoints.length?`<div class="eyebrow" style="margin:4px 0 6px">Checkpoints (the newest one dated on or before today governs)</div>
    <div class="tbl" style="margin-bottom:12px">${a.checkpoints.slice().reverse().map((c,i)=>`<div class="trow"><span>${esc(fmtDate(c.date))}${c.date>todayISO()?' <span class="tag">takes effect '+esc(fmtDate(c.date))+'</span>':(gov&&c.date===gov.date)?' <b style="color:var(--in)">← governing</b>':''}</span><span class="num">${esc(money(c.balance))}${i===0?` <button class="btn btn-sm btn-ghost" data-act="checkpoint-remove" data-id="${a.id}" data-v="${c.date}" style="margin-left:8px">Remove</button>`:''}</span></div>`).join('')}
      <div class="trow muted" style="font-size:12.5px"><span>Opening balance (used when no checkpoint applies)</span><span class="num">${esc(money(a.opening.balance))}</span></div></div>`:''}
    <div class="grid2">
      <label class="field"><span>Balance per bank / statement</span><input type="number" step="0.01" inputmode="decimal" id="rcActual" value="${actual===null?'':actual}" placeholder="0.00"></label>
      <label class="field"><span>As of</span><input type="date" id="rcDate" value="${esc(date)}"></label>
    </div>
    ${actual===null?'':`
    <div class="cmp" style="margin-bottom:12px">
      <div>Ledger as of ${esc(fmtDate(date))}</div><div></div><div class="num">${esc(money(calcAt))}</div>
      <div>Bank as of ${esc(fmtDate(date))}</div><div></div><div class="num">${esc(money(actual))}</div>
      <div><b>Difference</b></div><div></div><div class="num" style="color:${Math.abs(diffAt)<0.005?'var(--in)':'var(--out)'}"><b>${Math.abs(diffAt)<0.005?'reconciled ✓':signed(diffAt)}</b></div>
    </div>
    ${Math.abs(diffAt)<0.005?`<div class="verdict ok">Matches. Accept it as a checkpoint so future reconciliations only have to look at newer transactions.</div>`
      :`<div class="verdict bad">Off by <span class="num">${esc(money(Math.abs(diffAt)))}</span>. ${diffAt>0?'The bank has more than Ledger — a deposit or refund is probably missing, or an expense was entered twice.':'Ledger has more than the bank — an expense or fee is probably missing, or a deposit was entered twice.'} Transactions since the last checkpoint up to that date:</div>
      <div class="tbl" style="max-height:220px;overflow:auto;margin-bottom:12px">${upto.slice().sort((x,y)=>y.date.localeCompare(x.date)).map(t=>`<div class="trow click" data-act="${isTransfer(t)?'edit-transfer':'edit-tx'}" data-id="${t.id}" role="button" tabindex="0" style="cursor:pointer"><span><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.note||(isTransfer(t)?'Transfer':cat(t.categoryId).name))}</div><div class="muted" style="font-size:12px">${esc(fmtDate(t.date))}${isTransfer(t)?'':' · '+esc(cat(t.categoryId).name)}</div></span><span class="num">${esc(signed(effectOn(t,a)))}</span></div>`).join('')||'<div class="trow muted">none</div>'}</div>`}`}`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Close</button>
     <button class="btn" data-act="reconcile-check" data-id="${a.id}">Compare</button>
     <button class="btn btn-primary" data-act="reconcile-accept" data-id="${a.id}" ${actual===null?'disabled':''}>Accept bank balance as checkpoint</button>`);
}
function verifyBalancesPanel(){
  const rows=balanceReport();
  return `<div class="totalrule" style="margin-top:22px">
    <div class="eyebrow">Balances</div>
    <div class="muted" style="font-size:13.5px;margin:6px 0 10px;line-height:1.6">Every balance is <b>rebuilt from your transactions</b> each time, starting from the account's opening balance or its last reconciled checkpoint — nothing is added up incrementally, so editing, deleting, undoing or re-importing can't make it drift. This table shows the working.</div>
    ${rows.length?`<div class="tbl">${rows.map(r=>`<div class="trow"><span><div>${esc(r.a.name)}</div><div class="muted num" style="font-size:12px">${r.anchor.date?'<b>governing checkpoint</b> '+esc(money(r.anchor.balance))+' on '+esc(fmtDate(r.anchor.date))+(r.a.checkpoints.length>1?' ('+(r.a.checkpoints.length-1)+' older superseded)':''):'<b>opening balance</b> '+esc(money(r.anchor.balance))+' (no checkpoint)'} ${r.net>=0?'+':'−'} ${esc(money(Math.abs(r.net)))} over ${r.count} transaction${r.count===1?'':'s'} dated after it</div></span><span class="num"><b>${esc(money(r.balance))}</b>${Math.abs(r.balance-r.cached)>0.005?' <span style="color:var(--out)">cache was '+esc(money(r.cached))+'</span>':''}</span></div>`).join('')}</div>`:'<div class="muted" style="font-size:13px">No accounts yet.</div>'}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn btn-sm" data-act="rebuild-balances">Verify & rebuild balances now</button>
    </div>
  </div>`;
}

function goalForm(g){
  const isNew=!g;
  g=g||{name:'',target:'',saved:0,deadline:''};
  openForm({
    title:isNew?'Add goal':'Edit goal',
    fields:[
      {name:'name',label:'What are you saving for',type:'text',value:g.name,placeholder:'Emergency fund'},
      {name:'target',label:'Target amount',type:'number',value:g.target},
      {name:'saved',label:'Saved so far',type:'number',value:g.saved},
      {name:'horizon',label:'Timeframe',type:'select',value:g.deadline?'custom':'none',
        options:[{value:'none',label:'No deadline'}].concat(HORIZONS.map(h=>({value:h[0],label:'In '+h[1]}))).concat([{value:'custom',label:'A date I pick below'}])},
      {name:'deadline',label:'Target date (if picking one)',type:'date',value:g.deadline||''}
    ],
    note:'With a date, the goal shows what to set aside per week, month and year, and the Goal planner tells you the revenue that makes it happen.',
    onDelete:isNew?null:()=>{
      markUndo();
      S.goals=S.goals.filter(x=>x.id!==g.id); save(); closeModal(); render(); toast('Goal removed',true);
    },
    onSubmit:v=>{
      if(!v.name.trim()){ toast('Give the goal a name'); return false; }
      const deadline=v.horizon==='none'?'':v.horizon==='custom'?(v.deadline||''):horizonDate(v.horizon);
      const next={id:g.id||uid(),name:v.name.trim(),target:parseFloat(v.target)||0,saved:parseFloat(v.saved)||0,deadline:deadline,created:g.created||todayISO()};
      if(isNew) S.goals.push(next);
      else S.goals[S.goals.findIndex(x=>x.id===g.id)]=next;
      save(); closeModal(); render(); toast(isNew?'Goal added':'Goal updated');
    }
  });
}

function contributeForm(g){
  openForm({
    title:'Add to '+g.name,
    fields:[{name:'amount',label:'Amount to add',type:'number',value:''}],
    submitLabel:'Add money',
    onSubmit:v=>{
      const amt=parseFloat(v.amount)||0;
      if(!amt){ toast('Enter an amount'); return false; }
      g.saved=Math.max(0,g.saved+amt);
      save(); closeModal(); render(); toast('Added to '+g.name);
    }
  });
}

function recurringForm(r){
  if(!S.accounts.length){ toast('Add an account first'); return acctForm(); }
  const isNew=!r||!r.id;
  r=r||{name:'',amount:'',day:1,month:new Date().getMonth()+1,cadence:'monthly',
        categoryId:(S.categories.find(c=>c.type==='out')||{}).id,accountId:S.accounts[0].id,active:true};
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  openForm({
    title:isNew?'Add recurring item':'Edit recurring item',
    fields:[
      {name:'name',label:'Name',type:'text',value:r.name,placeholder:'Gym membership'},
      {name:'amount',label:'Amount charged',type:'number',value:r.amount},
      {name:'cadence',label:'How often',type:'select',value:cadenceOf(r),options:[
        {value:'weekly',label:'Every week'},{value:'biweekly',label:'Every 2 weeks'},{value:'monthly',label:'Every month'},{value:'quarterly',label:'Every three months'},{value:'yearly',label:'Once a year'}]},
      {name:'start',label:'A date it lands on — weekly and 2-weekly only',type:'date',value:r.start||''},
      {name:'month',label:'Renewal month — quarterly and yearly only',type:'select',value:String(r.month||new Date().getMonth()+1),
        options:MONTHS.map((m,i)=>({value:String(i+1),label:m}))},
      {name:'day',label:'Day of the month it lands',type:'number',value:r.day},
      {name:'categoryId',label:'Category',type:'select',groups:catGroups(),value:r.categoryId},
      {name:'accountId',label:'Account',type:'select',options:acctOptions(),value:r.accountId}
    ].concat(S.users.length?[{name:'userId',label:'Household member',type:'select',options:userOptions(),value:r.userId||''}]:[]).concat([
      {name:'active',label:'Book this automatically when the date comes',type:'checkbox',value:r.active!==false}
    ]),
    note:(r._note?esc(r._note)+' ':'')+'An annual membership is entered at its full yearly price — Ledger books it once a year and shows the monthly equivalent alongside.',
    onDelete:isNew?null:()=>{
      markUndo();
      S.recurring=S.recurring.filter(x=>x.id!==r.id); save(); closeModal(); render(); toast('Recurring item removed',true);
    },
    onSubmit:v=>{
      if(!v.name.trim()){ toast('Give it a name'); return false; }
      const day=Math.min(31,Math.max(1,parseInt(v.day)||1));
      if((v.cadence==='weekly'||v.cadence==='biweekly')&&!/^\d{4}-\d{2}-\d{2}$/.test(v.start||'')){ toast('Pick a date it lands on'); return false; }
      const next={id:r.id||uid(),name:v.name.trim(),amount:Math.abs(parseFloat(v.amount)||0),day:day,
        month:parseInt(v.month)||1,cadence:v.cadence,start:v.start||'',since:r.since||ym(new Date()),
        categoryId:v.categoryId,accountId:v.accountId,active:!!v.active,fromKey:r.fromKey||''};
      if(v.userId&&S.users.some(u=>u.id===v.userId)) next.userId=v.userId;
      if(isNew) S.recurring.push(next);
      else S.recurring[S.recurring.findIndex(x=>x.id===r.id)]=next;
      save(); runRecurring(); closeModal(); render(); toast(isNew?'Recurring item added':'Recurring item updated');
    }
  });
}

function budgetEditor(){
  const outs=S.categories.filter(c=>c.type==='out');
  const body=outs.map(c=>`
    <label class="field" style="display:flex;align-items:center;gap:10px">
      <span class="dot" style="background:${esc(c.color)}"></span>
      <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:14.5px;color:var(--ink);font-weight:400">${esc(c.name)}</span>
      <input type="number" step="1" inputmode="decimal" data-budget="${c.id}" value="${S.budgets[c.id]||''}" placeholder="No limit" style="width:120px">
    </label>`).join('')||'<div class="muted">Add some expense categories first.</div>';
  openSheet('Monthly limits',body+'<div class="muted" style="font-size:13px">Leave a field empty to track the category without a ceiling.</div>',
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="save-budgets">Save limits</button>`);
}

function habitForm(h){
  const isNew=!h;
  h=h||{name:'',mode:'manual',limit:20,color:PALETTE[S.habits.length%PALETTE.length],
};
  openForm({
    title:isNew?'Add habit':'Edit habit',
    fields:[
      {name:'name',label:'Habit',type:'text',value:h.name,placeholder:'No-spend day'},
      {name:'mode',label:'How it gets marked',type:'select',value:h.mode,options:[
        {value:'manual',label:'I tap the day myself'},
        {value:'nospend',label:'Automatic — days I spent nothing'},
        {value:'under',label:'Automatic — days I stayed under an amount'}
      ]},
      {name:'limit',label:'Daily limit (for the under-an-amount habit)',type:'number',value:h.limit},
      {name:'color',label:'Colour',type:'color',value:h.color}
    ],
    note:'The automatic habits read your own transactions, so they are only as honest as your logging — a day with nothing recorded reads as a day with nothing spent.',
    onDelete:isNew?null:()=>{
      markUndo();
      S.habits=S.habits.filter(x=>x.id!==h.id);
      Object.keys(S.habitLog).forEach(k=>{ if(k.indexOf(h.id+':')===0) delete S.habitLog[k]; });
      save(); closeModal(); render(); toast('Habit removed',true);
    },
    onSubmit:v=>{
      if(!v.name.trim()){ toast('Give the habit a name'); return false; }
      const next={id:h.id||uid(),name:v.name.trim(),mode:v.mode,
        limit:Math.abs(parseFloat(v.limit)||0),color:v.color};
      if(isNew) S.habits.push(next);
      else S.habits[S.habits.findIndex(x=>x.id===h.id)]=next;
      save(); closeModal(); render(); toast(isNew?'Habit added':'Habit updated');
    }
  });
}




function dayDetail(iso){
  const [y,m]=iso.split('-').map(Number);
  const lastDay=new Date(y,m,0).getDate();
  const txs=S.transactions.filter(t=>t.date===iso).sort((a,b)=>b.amount-a.amount);
  const plans=S.planned.filter(p=>p.date===iso);
  const recs=recurringDueOn(iso,iso.slice(0,7),lastDay);
  const net=sum(txs.map(flowBase));
  const dt=new Date(y,m-1,iso.slice(8)*1);
  const title=dt.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});

  const block=(label,rows)=>rows.length?`<div class="eyebrow" style="margin:16px 0 4px">${label}</div>${rows.join('')}`:'';

  const txRows=txs.map(t=>{
    const c=cat(t.categoryId), a=acct(t.accountId);
    return `<div class="row click" data-act="edit-tx" data-id="${t.id}" tabindex="0" role="button">
      <span class="dot" style="background:${esc(c.color)}"></span>
      <div class="grow"><div class="name">${esc(t.note||c.name)}</div>
        <div class="sub">${esc(c.name)}${a?' · '+esc(a.name):''}</div></div>
      <span class="num ${t.type==='in'?'in':'out'}" style="font-size:14px">${esc((t.type==='in'?'+':'−')+money(t.amount))}</span>
    </div>`;
  });
  const planRows=plans.map(p=>{
    const c=cat(p.categoryId);
    return `<div class="row">
      <span class="mk plan" style="width:9px;height:9px"></span>
      <div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(c.name)} · planned</div></div>
      <span class="num" style="font-size:14px">${esc((c.type==='in'?'+':'−')+money(p.amount))}</span>
      <button class="btn btn-sm" data-act="plan-done" data-id="${p.id}" title="Record this as actually happened">It happened</button>
      <button class="iconbtn" data-act="edit-planned" data-id="${p.id}" aria-label="Edit ${esc(p.name)}">⋯</button>
    </div>`;
  });
  const recRows=recs.map(r=>{
    const c=cat(r.categoryId);
    return `<div class="row">
      <span class="mk rec" style="width:9px;height:9px"></span>
      <div class="grow"><div class="name">${esc(r.name)}</div><div class="sub">${esc(c.name)} · recurring</div></div>
      <span class="num muted" style="font-size:14px">${esc((c.type==='in'?'+':'−')+money(r.amount))}</span>
    </div>`;
  });

  const body=(txs.length||plans.length||recs.length)
    ? block('Recorded',txRows)+block('Planned',planRows)+block('Recurring, not yet recorded',recRows)+
      (net?`<div class="totalrule" style="display:flex;align-items:baseline">
        <span class="eyebrow" style="margin-right:auto">Net for the day</span>
        <span class="num ${net>0?'in':'out'}" style="font-size:16px">${esc(signed(net))}</span></div>`:'')
    : `<div class="empty"><b>Nothing on this day</b>Add what you spent, or plan something you know is coming.</div>`;

  openSheet(title,body,
    `<button class="btn" data-act="add-planned" data-d="${iso}">Plan something</button>
     <span class="spacer"></span>
     <button class="btn" data-act="close-modal">Close</button>
     <button class="btn btn-primary" data-act="add-tx-on" data-d="${iso}">Add transaction</button>`);
}

function plannedForm(p,presetDate){
  if(!S.categories.length){ toast('Add a category first'); return; }
  const isNew=!p;
  p=p||{name:'',amount:'',date:presetDate||todayISO(),
        categoryId:(S.categories.find(c=>c.type==='out')||S.categories[0]).id};
  openForm({
    title:isNew?'Plan something':'Edit planned item',
    fields:[
      {name:'name',label:'What is it',type:'text',value:p.name,placeholder:'Car insurance'},
      {name:'amount',label:'Amount',type:'number',value:p.amount},
      {name:'date',label:'Expected on',type:'date',value:p.date},
      {name:'categoryId',label:'Category',type:'select',groups:catGroups(),value:p.categoryId}
    ],
    note:'A plan is a forecast, not a record — it shows on the calendar and in the month-ahead figures, but leaves your balances alone until you mark it as happened.',
    onDelete:isNew?null:()=>{
      markUndo();
      S.planned=S.planned.filter(x=>x.id!==p.id);
      save(); closeModal(); render(); toast('Plan removed',true);
    },
    onSubmit:v=>{
      if(!v.name.trim()){ toast('Give it a name'); return false; }
      const amount=Math.abs(parseFloat(v.amount)||0);
      if(!amount){ toast('Enter an amount above zero'); return false; }
      const next={id:p.id||uid(),name:v.name.trim(),amount:amount,
        date:v.date||todayISO(),categoryId:v.categoryId};
      if(isNew) S.planned.push(next);
      else S.planned[S.planned.findIndex(x=>x.id===p.id)]=next;
      save(); closeModal(); render(); toast(isNew?'Planned':'Plan updated');
    }
  });
}

/* same engine, but records when each debt clears and what each one costs to carry */
function simulateDetail(payment,strategy){
  let list=debts().map(a=>({id:a.id,name:a.name,bal:toBase(a.balance,a.cur||baseCur()),rate:(Number(a.rate)||0)/100/12,min:toBase(Number(a.minPayment)||0,a.cur||baseCur())}));
  const perInt={}; list.forEach(d=>{perInt[d.id]=0;});
  if(!list.length) return {months:0,interest:0,ok:true,cleared:[],perInt:perInt};
  let months=0,interest=0; const cleared=[];
  const MAX=600;
  while(months<MAX){
    const start=sum(list.map(d=>d.bal));
    if(start<=0.01) break;
    list.forEach(d=>{ const i=d.bal*d.rate; d.bal+=i; interest+=i; perInt[d.id]+=i; });
    const live=list.filter(d=>d.bal>0.005).sort((x,y)=>
      strategy==='snowball' ? x.bal-y.bal : (y.rate-x.rate)||(x.bal-y.bal));
    let pool=payment;
    live.forEach(d=>{ const p=Math.max(0,Math.min(pool,Math.min(d.min,d.bal))); d.bal-=p; pool-=p; });
    for(let i=0;i<live.length&&pool>0.005;i++){
      const p=Math.min(pool,live[i].bal); if(p>0){ live[i].bal-=p; pool-=p; }
    }
    months++;
    list.forEach(d=>{ if(d.bal<=0.01&&!cleared.some(c=>c.id===d.id)) cleared.push({id:d.id,name:d.name,month:months}); });
    const end=sum(list.map(d=>Math.max(0,d.bal)));
    if(end>start-0.01&&end>0.01) return {months:Infinity,interest:Infinity,ok:false,cleared:[],perInt:perInt};
  }
  if(months>=MAX) return {months:Infinity,interest:Infinity,ok:false,cleared:[],perInt:perInt};
  return {months:months,interest:interest,ok:true,cleared:cleared,perInt:perInt};
}

function debtAnalysis(){
  const list=debts();
  if(!list.length){ toast('No debt recorded — nothing to work out'); return; }
  const mins=totalMin();
  const base=Math.max(Number(S.debtPlan.payment)||0,mins);
  const strat=S.debtPlan.strategy||'avalanche';
  const now=simulateDetail(base,strat);

  if(!now.ok){
    openSheet('Debt analysis',`<div class="empty"><b>The payment is too small to model</b>
      At ${esc(money(base))} a month the interest grows faster than the balance falls, so there is no payoff date to work from.
      Your minimums alone come to ${esc(money(mins))}. Raise the monthly payment in the plan and the numbers below will appear.</div>`,
      `<span class="spacer"></span><button class="btn" data-act="close-modal">Close</button>
       <button class="btn btn-primary" data-act="debt-plan">Edit the plan</button>`);
    return;
  }

  /* 1 — does the order actually matter for you */
  const av=simulateDetail(base,'avalanche'), sn=simulateDetail(base,'snowball');
  const intDiff=Math.abs(av.interest-sn.interest), monDiff=Math.abs(av.months-sn.months);
  const cheaper=av.interest<=sn.interest?'avalanche':'snowball';
  let orderText;
  if(intDiff<1&&monDiff===0){
    orderText=`With your debts, both orders finish in the same ${av.months} months for the same interest — the choice makes no practical difference here.`;
  }else{
    orderText=`Paying the <b>${cheaper==='avalanche'?'highest rate':'smallest balance'}</b> first comes out ahead: `+
      `${esc(money(intDiff))} less interest${monDiff?` and ${monDiff} month${monDiff===1?'':'s'} sooner`:''}.`;
  }

  /* 2 — what an extra payment buys */
  const steps=[50,100,200,400].map(x=>{
    const r=simulateDetail(base+x,strat);
    return {x:x,ok:r.ok,months:r.months,saveM:now.months-r.months,saveI:now.interest-r.interest};
  }).filter(r=>r.ok);

  /* 3 — what each debt costs to carry */
  const carry=list.map(a=>({
    a:a,
    monthly:toBase(a.balance,a.cur||baseCur())*((Number(a.rate)||0)/100/12),
    clears:(now.cleared.find(c=>c.id===a.id)||{}).month,
    interest:now.perInt[a.id]||0
  })).sort((x,y)=>y.monthly-x.monthly);

  /* 4 — money that is already discretionary */
  const outs=inMonth(ui.month).filter(economicOut);
  const fun=sum(outs.filter(t=>!cat(t.categoryId).need).map(t=>amtBase(t)));
  let funBlock='';
  if(fun>0){
    const half=Math.round(fun/2), quarter=Math.round(fun/4);
    const rHalf=simulateDetail(base+half,strat), rQ=simulateDetail(base+quarter,strat);
    funBlock=`
      <div class="eyebrow" style="margin:22px 0 6px">Money already in reach</div>
      <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:10px">
        In ${esc(monthName(ui.month,true))} you spent <b>${esc(money(fun))}</b> on things marked optional rather than essential. That is the money nearest to hand — no extra income required.
      </div>
      <div class="tbl">
        ${rQ.ok?`<div class="trow"><span>Redirect a quarter of it</span><span class="num">+${esc(money(quarter,{round:true}))}/mo</span><span class="num in">${rQ.months} months · saves ${esc(money(now.interest-rQ.interest))}</span></div>`:''}
        ${rHalf.ok?`<div class="trow"><span>Redirect half of it</span><span class="num">+${esc(money(half,{round:true}))}/mo</span><span class="num in">${rHalf.months} months · saves ${esc(money(now.interest-rHalf.interest))}</span></div>`:''}
      </div>`;
  }

  const body=`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:16px">
      Everything below is arithmetic on the balances, rates and minimums you entered, starting from your current plan of <b>${esc(money(base))} a month</b>.
    </div>

    <div class="eyebrow">Where you stand now</div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin:8px 0 4px">
      <div><div class="muted" style="font-size:12px">Clear in</div><div class="figure-sm">${now.months} months</div></div>
      <div><div class="muted" style="font-size:12px">Debt-free</div><div class="figure-sm">${esc(payoffDate(now.months))}</div></div>
      <div><div class="muted" style="font-size:12px">Interest paid</div><div class="figure-sm out">${esc(money(now.interest))}</div></div>
    </div>

    <div class="eyebrow" style="margin:22px 0 6px">Which order to pay in</div>
    <div class="muted" style="font-size:13.5px;line-height:1.6">${orderText}</div>

    <div class="eyebrow" style="margin:22px 0 6px">What each extra dollar buys</div>
    <div class="tbl">
      ${steps.map(s=>`<div class="trow">
        <span>+${esc(money(s.x,{round:true}))} a month</span>
        <span class="num">${s.months} months</span>
        <span class="num in">${s.saveM} month${s.saveM===1?'':'s'} sooner · saves ${esc(money(s.saveI))}</span>
      </div>`).join('')}
    </div>
    <div class="muted" style="font-size:12.5px;margin-top:8px">Savings shown are interest you would not pay.</div>

    <div class="eyebrow" style="margin:22px 0 6px">What each debt costs to carry</div>
    <div class="tbl">
      ${carry.map((c,i)=>`<div class="trow">
        <span>${esc(c.a.name)}${c.a.rate?` <span class="muted">${esc(Number(c.a.rate).toFixed(2))}%</span>`:''}</span>
        <span class="num out">${esc(money(c.monthly))}/mo interest</span>
        <span class="num">${c.clears?'cleared '+esc(payoffDate(c.clears)):'—'}</span>
      </div>`).join('')}
    </div>
    ${carry[0]&&carry[0].monthly>0?`<div class="muted" style="font-size:12.5px;margin-top:8px">
      <b>${esc(carry[0].a.name)}</b> is the expensive one to hold — ${esc(money(carry[0].monthly))} a month goes to interest before any of it touches the balance.</div>`:''}

    ${funBlock}

    <div class="totalrule" style="margin-top:24px">
      <div class="muted" style="font-size:13px;line-height:1.6">
        These are projections, not advice, and I am not a financial adviser. They assume your rates hold, no fees are added, and nothing new goes on the cards. Real lender terms, promotional rates, penalties and minimum-payment rules vary — check your statements before acting on any of it. Consolidation or refinancing may beat all of these options and is not modelled here.
      </div>
    </div>`;

  openSheet('Debt analysis',body,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Close</button>
     <button class="btn btn-primary" data-act="debt-plan">Edit the plan</button>`);
}

function debtPlanModal(){
  const p=S.debtPlan, mins=totalMin(), surplus=avgSurplus();
  const d=new Date(); d.setMonth(d.getMonth()+12);
  const defaultDate=p.targetDate||(d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-01');
  openSheet('Debt-free plan',`
    <label class="field"><span>How do you want to plan</span>
      <select id="dpMode">
        <option value="payment"${p.mode!=='date'?' selected':''}>I can pay a set amount each month</option>
        <option value="date"${p.mode==='date'?' selected':''}>I want to be clear by a certain date</option>
      </select></label>
    <label class="field"><span>Monthly payment</span>
      <input type="number" step="1" inputmode="decimal" id="dpPayment" value="${p.payment||mins||''}" placeholder="0.00"></label>
    <label class="field"><span>Debt-free by</span>
      <input type="date" id="dpDate" value="${esc(defaultDate)}"></label>
    <label class="field"><span>Which debt gets the extra money</span>
      <select id="dpStrategy">
        <option value="avalanche"${(p.strategy||'avalanche')==='avalanche'?' selected':''}>Highest interest rate first — cheapest overall</option>
        <option value="snowball"${p.strategy==='snowball'?' selected':''}>Smallest balance first — quickest wins</option>
      </select></label>
    <div class="muted" style="font-size:13.5px;line-height:1.6">
      Minimum payments across your debts come to <b>${esc(money(mins))}</b> a month.
      ${surplus?`Over the last six months you have averaged <b>${esc(money(surplus))}</b> left over after spending.
      <button class="btn btn-sm" data-act="use-surplus" data-v="${surplus}" style="margin-top:8px">Use ${esc(money(surplus,{round:true}))} as my payment</button>`:''}
      <p style="margin-bottom:0">Ledger projects forward using each account's rate and minimum. It is a straight-line estimate, not advice — your lender's terms, fees, and any new spending on the card will move the real number.</p>
    </div>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button>
     <button class="btn btn-primary" data-act="save-debt-plan">Save plan</button>`);
}

function needEditor(){
  const outs=S.categories.filter(c=>c.type==='out');
  const body=`<div class="muted" style="font-size:13.5px;line-height:1.5;margin-bottom:16px">
      Essentials are the bills you cannot skip without something breaking. Everything else is discretionary — the part you can actually move.
    </div>`+(outs.map(c=>`
    <div class="row" style="gap:10px">
      <span class="dot" style="background:${esc(c.color)}"></span>
      <span class="grow name">${esc(c.name)}</span>
      <select data-need="${c.id}" style="width:130px" aria-label="Is ${esc(c.name)} essential">
        <option value="need"${c.need?' selected':''}>Essential</option>
        <option value="want"${!c.need?' selected':''}>Fun / optional</option>
      </select>
    </div>`).join('')||'<div class="muted">Add some expense categories first.</div>');
  openSheet('What counts as essential',body,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="save-needs">Save</button>`);
}

/* ---------- settings ---------- */
let settingsTab='general';
let parseTestInput='';
function openSettings(){
  const tabs=[['general','General'],['household','Household'],['ai','AI'],['parsing','Parsing'],['currencies','Currencies'],['widgets','Widgets'],['categories','Categories'],['recurring','Recurring'],['data','Data']];
  const body=`<div class="tabs" style="margin:-18px -18px 16px">
      ${tabs.map(([v,l])=>`<button class="tab" data-act="settings-tab" data-v="${v}" aria-selected="${settingsTab===v}">${l}</button>`).join('')}
    </div>${settingsPanel()}`;
  openSheet('Settings',body,`<span class="spacer"></span><button class="btn btn-primary" data-act="close-modal">Done</button>`);
}
function refreshSettings(){ openSettings(); }

function settingsPanel(){
  if(settingsTab==='general'){
    const currencies=['CAD','USD','EUR','GBP','AUD','JPY','CHF','INR','MGA','ZAR','BRL','MXN'];
    return `
      <label class="field"><span>Currency</span>
        <select data-act="set-currency">${currencies.map(c=>`<option value="${c}"${S.settings.currency===c?' selected':''}>${c}</option>`).join('')}</select></label>
      <label class="field"><span>Text size</span>
        <select data-act="set-textsize">
          <option value="normal"${(S.settings.textSize||'normal')==='normal'?' selected':''}>Normal</option>
          <option value="large"${S.settings.textSize==='large'?' selected':''}>Large</option>
          <option value="xl"${S.settings.textSize==='xl'?' selected':''}>Extra large</option>
        </select></label>
      <label class="field"><span>Date format</span>
        <select data-act="set-datefmt">
          <option value="md"${S.settings.dateFormat==='md'?' selected':''}>Jul 26</option>
          <option value="iso"${S.settings.dateFormat==='iso'?' selected':''}>2026-07-26</option>
          <option value="dmy"${S.settings.dateFormat==='dmy'?' selected':''}>26/07/2026</option>
        </select></label>
      <div class="field"><span style="display:block;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:600;margin-bottom:8px">Colours</span>
        <div class="themes">
          ${THEMES.map(t=>`<button class="theme" data-act="set-theme-id" data-v="${t.id}" aria-pressed="${S.settings.theme===t.id}">
            <span class="bars">${t.sw.map(c=>`<i style="background:${c}"></i>`).join('')}</span>
            <span class="nm">${esc(t.name)}</span><span class="kind">${t.kind}</span>
          </button>`).join('')}
        </div>
        <div class="muted" style="font-size:13px;margin-top:9px;line-height:1.5">The ◐ button in the header flips between a scheme and its light or dark counterpart.</div>
      </div>
      <div class="totalrule" style="margin-top:20px">
        <div class="eyebrow">Privacy lock</div>
        <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.6">
          ${hasLock()
            ?(lockEncrypts()?'A passphrase is set and <b>the book is encrypted with it</b> — in this browser, in backup files, and in copies saved with the data inside. Ledger asks for it when it opens and after inactivity. Forgot it? The <b>recovery code</b> you were given opens the book instead. Lose both and nothing can recover it.'
                            :'A passphrase from an older version is set. It only locks the screen; the book itself is still stored readable. Remove it and set it again to encrypt everything.')
            :'Set a passphrase and the book is <b>encrypted</b> with it everywhere it is stored — this browser, backup files, and copies saved with the data inside — so nobody can read your finances without it. You also get a <b>recovery code</b>, shown once, for the day you forget the passphrase: email it to yourself or write it down. Lose both and nothing can recover the book.'}
        </div>
        ${hasLock()?`
        <label class="field"><span>Auto-lock after inactivity</span>
          <select data-act="set-lock-timeout">
            <option value="30"${(S.settings.lockTimeout||LOCK_DEFAULT)===30?' selected':''}>30 seconds</option>
            <option value="60"${(S.settings.lockTimeout||LOCK_DEFAULT)===60?' selected':''}>1 minute</option>
            <option value="120"${(S.settings.lockTimeout||LOCK_DEFAULT)===120?' selected':''}>2 minutes</option>
            <option value="300"${(S.settings.lockTimeout||LOCK_DEFAULT)===300?' selected':''}>5 minutes</option>
            <option value="0"${(S.settings.lockTimeout||LOCK_DEFAULT)===0?' selected':''}>Never (only on open)</option>
          </select></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" data-act="lock-now">Lock now</button>
          ${lockEncrypts()?'<button class="btn btn-sm" data-act="lock-change">Change passphrase</button><button class="btn btn-sm" data-act="lock-recovery">New recovery code</button>':''}
          <button class="btn btn-sm btn-ghost" data-act="lock-remove">Remove passphrase</button>
        </div>`
        :`<label class="field"><span>Set a passphrase</span>
          <input type="password" id="lockSetInput" placeholder="Choose a passphrase" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>Confirm passphrase</span>
          <input type="password" id="lockSetConfirm" placeholder="Type it again" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>Auto-lock after inactivity</span>
          <select id="lockSetTimeout">
            <option value="30">30 seconds</option>
            <option value="60">1 minute</option>
            <option value="120">2 minutes</option>
            <option value="300" selected>5 minutes</option>
            <option value="0">Never (only on open)</option>
          </select></label>
        <button class="btn btn-sm btn-primary" data-act="lock-set">Set passphrase</button>`}
      </div>`;
  }
  if(settingsTab==='household'){
    const MAX=5;
    const bulk=S.users.length?bulkAssignHTML():'';
    const rows=S.users.map(u=>{
      const n=S.transactions.filter(t=>t.userId===u.id).length;
      return `<div class="row" style="gap:9px;align-items:center">
        <input type="color" class="swatch" value="${esc(u.color)}" data-act="user-color" data-id="${u.id}" aria-label="Colour for ${esc(u.name)}">
        <input type="text" value="${esc(u.name)}" data-act="user-name" data-id="${u.id}" placeholder="Name" style="flex:1" aria-label="Name">
        <span class="muted" style="font-size:12.5px;white-space:nowrap">${n} transaction${n===1?'':'s'}</span>
        <button class="iconbtn" data-act="del-user" data-id="${u.id}" aria-label="Delete ${esc(u.name)}" title="Remove">×</button>
      </div>`;
    }).join('');
    return `<div class="muted" style="font-size:13.5px;margin-bottom:12px;line-height:1.5">People are added from the top bar (+ Person). Here you can rename or recolour them, remove them, and tag many rows at once. Pick a person in the top bar and what you add is theirs; “All users (household)” shows everyone together, and the Household card shows each person side by side. Budgets, goals, net worth and account balances always stay household-wide.</div>`+
      (rows||`<div class="muted" style="font-size:13.5px;margin-bottom:12px">No members yet.</div>`)+
      (S.users.length<MAX?`<button class="btn btn-sm" data-act="add-user" style="margin-top:6px">Add member</button>`:`<div class="muted" style="font-size:12.5px;margin-top:8px">Maximum of ${MAX} members reached.</div>`)+bulk;
  }
  if(settingsTab==='ai'){
    const or=aiProvider()==='openrouter';
    const orModel=S.settings.openrouterModel||'anthropic/claude-sonnet-5';
    const orKnown=OR_MODELS.some(m=>m[0]===orModel);
    return `
      <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:14px">
        The <b>Scan</b> button reads screenshots, receipts, bills and PDF statements with an AI model, then shows you the list to check. Pick where the model comes from and paste that service's key. Keys live only in this browser and are used for nothing else.
        <br><br><b>No key at all?</b> Scanning still works — Ledger falls back to on-device text recognition. It copes with clean bank lists, but misreads receipts and cannot open PDFs.
      </div>
      <div class="chips" style="margin-bottom:14px">
        <button class="chip" data-act="set-aiprovider" data-v="openrouter" aria-pressed="${or}">OpenRouter</button>
        <button class="chip" data-act="set-aiprovider" data-v="anthropic" aria-pressed="${!or}">Anthropic direct</button>
      </div>
      ${or?`
      <label class="field"><span>OpenRouter API key</span>
        <input type="password" data-act="set-orkey" value="${esc(getKey('openrouterKey'))}" placeholder="sk-or-…" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Model</span>
        <select data-act="set-ormodel">${OR_MODELS.map(m=>`<option value="${m[0]}"${(orKnown?orModel:'custom')===m[0]?' selected':''}>${esc(m[1])}</option>`).join('')}</select></label>
      ${!orKnown||S.settings.orCustom?`<label class="field"><span>Model id (as listed on openrouter.ai/models)</span>
        <input type="text" data-act="set-ormodel-custom" value="${esc(orKnown?'':orModel)}" placeholder="vendor/model-name" autocomplete="off" spellcheck="false" style="font-family:var(--mono)"></label>`:''}
      <div class="muted" style="font-size:12.5px;line-height:1.6">
        One key, any model — get it at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" style="color:var(--accent)">openrouter.ai/keys</a>. The model must accept images; all of the above do. PDFs go to the model directly when it supports them, otherwise through OpenRouter's free text extraction — fine for real statements and bills, not for scanned-picture PDFs.
        ${getKey('openrouterKey')?'<div style="margin-top:8px;color:var(--in)">Key saved (on this device only — never in backups) · scans go through OpenRouter using '+esc(aiModelLabel())+'.</div>':''}
      </div>`:`
      <label class="field"><span>Anthropic API key</span>
        <input type="password" data-act="set-apikey" value="${esc(getKey('apiKey'))}" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Model</span>
        <select data-act="set-aimodel">${AI_MODELS.map(m=>`<option value="${m[0]}"${(S.settings.aiModel||'claude-opus-5')===m[0]?' selected':''}>${esc(m[1])}</option>`).join('')}</select></label>
      <div class="muted" style="font-size:12.5px;line-height:1.6">
        Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" style="color:var(--accent)">console.anthropic.com</a>. Each read costs a few cents.
        ${getKey('apiKey')?'<div style="margin-top:8px;color:var(--in)">Key saved (on this device only — never in backups) · scans will be read by Claude.</div>':''}
      </div>`}`;
  }
  if(settingsTab==='parsing'){
    const testLine=(typeof parseTestInput!=='undefined'?parseTestInput:'');
    let result='';
    if(testLine){
      try{
        parseSkipped=[];
        const seg=segmentStatement(testLine);
        const rows=parseOCRText(plainText(testLine));
        const skipped=parseSkipped.slice();
        result=`<div class="tbl" style="margin-top:12px">
          ${kv('Lines found',seg.table.length+' table / '+(seg.lines.length-seg.table.length)+' other')}
          ${kv('Transactions parsed',rows.length)}
          ${rows.map((r,i)=>kv('Row '+(i+1),esc(r.date||'?')+' · '+esc(r.description||'?')+' · '+esc(money(r.amount))+' · '+esc(r.direction)+(r.category?' · '+esc(r.category):'')+(r.flags&&r.flags.length?' · ⚠ '+esc(r.flags.join('; ')):''))).join('')}
          ${skipped.length?kv('Skipped ('+skipped.length+')',skipped.map(s=>esc(s.raw||'?')+' → <span style="color:var(--out)">'+esc(s.why)+'</span>').join('<br>')):''}
        </div>`;
      }catch(e){ result='<div style="color:var(--out);margin-top:10px;font-size:13px">Error: '+esc(e.message)+'</div>'; }
    }
    return `
      <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:14px">
        Paste a bank statement line here to see exactly how Ledger reads it — the date, amount, direction, channel, merchant and category it extracts, plus anything it skipped and why. Useful for checking why a transaction was missed or misread without scanning a real bill.
      </div>
      <label class="field"><span>Paste a line (or several) from a bank statement</span>
        <textarea id="parseTestInput" rows="4" placeholder="2026-07-14 INTERNET TRANSFER 0000012345 $200.00" style="font-family:var(--mono);font-size:13px;resize:vertical">${esc(testLine)}</textarea></label>
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <button class="btn btn-sm btn-primary" data-act="parse-test">Read the line</button>
        <button class="btn btn-sm" data-act="parse-test-clear">Clear</button>
      </div>
      ${result}`;
  }
  if(settingsTab==='currencies'){
    const list=usedCurrencies().filter(c=>c!==baseCur());
    return `
      <label class="field"><span>Base currency — everything totals in this</span>
        <select data-act="set-currency">${['CAD','USD','EUR','GBP','AUD','CHF','JPY','INR','MGA','ZAR','BRL','MXN','KES','NGN','PHP','THB'].map(c=>`<option value="${c}"${baseCur()===c?' selected':''}>${c}</option>`).join('')}</select></label>
      <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:14px">
        Each account holds its own currency, set when you add or edit it. Net worth, budgets and every chart convert into the base above.
        Rates are yours to enter — nothing is fetched, so nothing about your money leaves this page.
      </div>
      ${list.length?`<div class="eyebrow" style="margin-bottom:8px">Exchange rates</div>
      ${list.map(c=>`<label class="field" style="display:flex;align-items:center;gap:10px">
        <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:14.5px;color:var(--ink);font-weight:400">1 ${esc(baseCur())} =</span>
        <input type="number" step="any" inputmode="decimal" data-rate="${esc(c)}" value="${(S.rates||{})[c]||''}" placeholder="rate" style="width:130px">
        <span class="num" style="width:44px">${esc(c)}</span>
      </label>`).join('')}
      ${list.some(c=>!hasRate(c))?`<div class="num" style="font-size:13px;color:var(--out);margin-bottom:10px">A currency without a rate is counted one-to-one, which will make your totals wrong. Fill every rate in.</div>`:''}
      <div class="muted" style="font-size:13px;margin-bottom:10px">${ratesAge()}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm btn-primary" data-act="save-rates">Save rates</button>
        <button class="btn btn-sm" data-act="fetch-rates">Fetch today's rates</button>
      </div>
      ${rateNote?`<div class="muted" style="font-size:13px;margin-top:10px;line-height:1.5">${esc(rateNote)}</div>`:''}
      <div class="muted" style="font-size:12.5px;margin-top:12px;line-height:1.6">
        Fetching is optional and never automatic. It asks <a href="https://www.exchangerate-api.com" target="_blank" rel="noopener" style="color:var(--accent)">ExchangeRate-API</a> for today's rates and sends only a currency code — no amounts, balances or notes ever leave this page. It is the single outbound request the app can make.
      </div>`
      :`<div class="muted" style="font-size:13.5px">Only ${esc(baseCur())} is in use. Give an account a different currency and its rate will appear here.</div>`}`;
  }
  if(settingsTab==='widgets'){
    return `<div class="muted" style="font-size:13.5px;margin-bottom:12px;line-height:1.5">Switch widgets on or off here. On the board, drag a widget by its title to reorder, or use ⤢ to change its width.</div>`+
      S.settings.widgets.map(w=>`
      <label class="field" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <input type="checkbox" data-act="toggle-widget" data-id="${w.id}" ${w.on?'checked':''} style="width:auto;margin:0">
        <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:14.5px;color:var(--ink);font-weight:400">${esc(WIDGET_TITLES[w.id])}</span>
        <span class="num muted" style="font-size:12px">${w.span}/12</span>
      </label>`).join('');
  }
  if(settingsTab==='categories'){
    return S.categories.map(c=>`
      <div class="row" style="gap:9px">
        <input type="color" class="swatch" value="${esc(c.color)}" data-act="cat-color" data-id="${c.id}" aria-label="Colour for ${esc(c.name)}">
        <input type="text" value="${esc(c.name)}" data-act="cat-name" data-id="${c.id}" style="flex:1" aria-label="Name">
        <select data-act="cat-type" data-id="${c.id}" style="width:80px" aria-label="Direction">
          <option value="out"${c.type==='out'?' selected':''}>Out</option>
          <option value="in"${c.type==='in'?' selected':''}>In</option>
        </select>
        <select data-act="cat-need" data-id="${c.id}" style="width:112px" aria-label="Essential or optional"${c.type==='in'?' disabled':''}>
          <option value="need"${c.need?' selected':''}>Essential</option>
          <option value="want"${!c.need?' selected':''}>Fun</option>
        </select>
        <button class="iconbtn" data-act="del-category" data-id="${c.id}" aria-label="Delete ${esc(c.name)}">×</button>
      </div>`).join('')+
      `<button class="btn btn-sm" data-act="add-category" style="margin-top:14px">Add category</button>`+rulesPanel();
  }
  if(settingsTab==='recurring'){
    return (S.recurring.length?S.recurring.map(r=>`
      <div class="row click" data-act="edit-recurring" data-id="${r.id}" tabindex="0" role="button">
        <span class="dot" style="background:${esc(cat(r.categoryId).color)}"></span>
        <div class="grow"><div class="name">${esc(r.name)}</div><div class="sub">${esc(cadenceLabel(r))} · ${isDated(r)?'from '+esc(fmtDate(r.start||todayISO())):'day '+esc(r.day)} · ${esc(cat(r.categoryId).name)}${r.active===false?' · paused':''}</div></div>
        <span class="num" style="font-size:14px">${esc(money(r.amount))}</span>
      </div>`).join(''):'<div class="muted" style="font-size:14px">Nothing recurring yet. Rent, salary, and subscriptions are good candidates.</div>')+
      `<button class="btn btn-sm" data-act="add-recurring" style="margin-top:14px">Add recurring item</button>`;
  }
  return `
    <div class="eyebrow" style="margin-top:4px">Graphics</div>
    <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.5">Draws the month you are viewing as a shareable card, using your current colours. SVG stays sharp at any size; PNG is easier to paste into things.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px">
      <button class="btn btn-sm" data-act="month-card">Make a month card</button>
    </div>
    <div class="eyebrow">This copy</div>
    <div class="muted" style="font-size:13.5px;margin:6px 0 10px;line-height:1.6">${storageBlurb()}</div>
    <div class="totalrule" style="margin-top:20px">
      <div class="eyebrow">Live backup</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.6">
        ${canLiveBackup()
          ?'Pick a <b>folder</b> and Ledger rewrites <span class="num">'+LIVE_NAME+'</span> there after every change, plus a dated copy (<span class="num">ledger-2026-08-29.json</span>) the first time each day — the last '+KEEP_DATED+' are kept, so a bad day can be rolled back. A folder inside iCloud Drive or OneDrive makes it survive a lost laptop; keep a copy of this HTML file there too. If storage is ever cleared, <b>Restore from backup</b> with any of those files brings everything back.'
          :'This browser cannot write files on its own (Chrome and Edge can). Use <b>Back up everything</b> below now and then instead.'}
      </div>
      ${backupState==='on'?`<div style="font-size:13.5px;color:${lastDiskError?'var(--out)':'var(--in)'};margin-bottom:10px">${lastDiskError?'Could not write':'On'} — ${backupKind==='dir'?'folder':'file'} <b>${esc(backupName()||'?')}</b>${lastDiskWrite?' · last written '+new Date(lastDiskWrite).toLocaleString():''}${lastDiskError?' · '+esc(lastDiskError):''}</div>`
        :backupState==='ask'?`<div style="font-size:13.5px;color:var(--out);margin-bottom:10px">Paused — the browser needs you to allow writing to <b>${esc(backupName()||'the backup')}</b> again. Chrome asks after a restart until you pick “Allow on every visit”.</div>`:''}
      <div class="num" style="font-size:13px;margin-bottom:10px;line-height:1.7">
        <div>Write permission: <b style="color:${backupState==='on'?'var(--in)':backupState==='ask'?'var(--out)':'var(--ink-3)'}">${backupState==='on'?'granted':backupState==='ask'?'needs re-approval':'no folder chosen'}</b></div>
        <div>Last browser save: <b>${clock(lastLocalSave)}</b></div>
        <div>Last successful disk backup: <b style="color:${lastDiskVerified?'var(--in)':'var(--ink-3)'}">${lastDiskVerified?clock(lastDiskWrite)+' (written and read back)':'none yet'}</b></div>
        ${lastDiskError?`<div style="color:var(--out)">Last error: ${esc(lastDiskError)}</div>`:''}
      </div>
      ${diagHTML()}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${backupState==='ask'?`<button class="btn btn-sm btn-primary" data-act="backup-reconnect">Allow again</button>`:''}
        ${canFolderBackup()?`<button class="btn btn-sm${backupState==='off'?' btn-primary':''}" data-act="backup-link-folder">${backupState==='off'?'Choose a backup folder':'Choose a different folder'}</button>`:''}
        ${canLiveBackup()?`<button class="btn btn-sm" data-act="backup-link">${backupState==='off'?'…or a single file':'Use a single file instead'}</button>`:''}
        ${backupState!=='off'?`<button class="btn btn-sm btn-ghost" data-act="backup-unlink">Turn off</button>`:''}
        <button class="btn btn-sm" data-act="backup-test">Test backup now</button>
      </div>
    </div>
    <div class="totalrule" style="margin-top:20px">
      <div class="eyebrow">Keeping two copies in step</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.6">
        There's no automatic sync — a private file with no server has nothing to sync through. Instead: pick one copy as your real one, and when you want the other to match it, <b>Back up everything</b> here, then <b>Restore</b> there. Two steps, and both copies are identical.
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${isDist()?'<button class="btn btn-sm btn-primary" data-act="export-self" title="A complete Ledger.html with your book inside — opens in any browser, on any computer">Save a copy with my data inside</button>':''}
        <button class="btn btn-sm" data-act="export-json">Back up everything</button>
        <button class="btn btn-sm" data-act="restore-json">Restore from backup</button>
        <button class="btn btn-sm" data-act="merge-book" title="Two people, two Ledgers: bring the other one in without replacing anything">Combine another book</button>
      </div>${isDist()?'<div class="muted" style="font-size:12.5px;line-height:1.6;margin-top:8px">The copy is the whole app plus your book in one file. Keep it somewhere safe, or open it in a new browser or on another computer and it carries on from there. Your API keys and passphrase stay on this device.</div>':''}
    </div>
    <div class="totalrule" style="margin-top:22px">
      <div class="eyebrow">Take your data with you</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.5">CSV moves just the transactions in and out — handy for spreadsheets or a bank export. The columns are date, amount, type, category, account, note.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" data-act="copy-out">Copy transactions</button>
        <button class="btn btn-sm" data-act="import-shots">Import from screenshots, bills & PDFs</button>
        <button class="btn btn-sm" data-act="import-csv">Paste or import</button>
        <button class="btn btn-sm" data-act="export-csv">Export as file</button>
      </div>
    </div>
    <div class="totalrule" style="margin-top:22px">
      <div class="eyebrow">Diagnostics</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 10px;line-height:1.6">For when something looks wrong: see exactly how every balance was calculated, test rules, trace imports, check integrity, and keep a debug log. Observes the app; never changes accounting on its own.</div>
      <label class="field" style="display:flex;align-items:center;gap:9px"><input type="checkbox" data-act="set-debug" ${debugOn()?'checked':''} style="width:auto;margin:0"><span style="margin:0;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--ink);font-weight:400">Enable debug mode</span></label>
      ${debugOn()?`<button class="btn btn-sm btn-primary" data-act="open-diagnostics">Open diagnostics</button>`:''}
    </div>
    <div class="totalrule">
      <div class="eyebrow">Ledger location</div>
      <div class="tbl" style="font-size:13px;margin:6px 0 10px">
        ${kv('App location',esc(originLabel()))}
        ${kv('Address',esc(location.origin==='null'?location.href:location.origin+location.pathname))}
        ${kv('Data store','Browser storage for this address'+(STORAGE_WHERE==='memory'?' — <b style="color:var(--out)">blocked, nothing can be saved</b>':''))}
        ${isDist()?kv('Build','Shareable single file · '+esc(String(window.LEDGER_DIST.version||APP_VERSION))+(window.LEDGER_DIST.built?' · built '+esc(String(window.LEDGER_DIST.built).slice(0,10)):'')):kv('Canonical Ledger',esc(CANONICAL_URL))}
        ${kv('This copy',isDist()?'<b style="color:var(--in)">✓ Your Ledger — data lives in this browser, not inside the file</b>':isCanonical()?'<b style="color:var(--in)">✓ Canonical Ledger</b>':'<b style="color:var(--accent)">⚠ Not your canonical Ledger — its data is stored separately</b>')}
        ${kv('Backup',backupState==='on'?(lastDiskError?'<span style="color:var(--out)">error — '+esc(lastDiskError)+'</span>':'<span style="color:var(--in)">on</span> · '+esc(backupKind==='dir'?'folder ':'file ')+esc(backupName()||'?')):backupState==='ask'?'<span style="color:var(--out)">paused — permission needed</span>':'off')}
        ${kv('Last browser save',lastLocalSave?esc(new Date(lastLocalSave).toLocaleString()):'—')}
        ${kv('Last disk backup',lastDiskWrite?esc(new Date(lastDiskWrite).toLocaleString()):'—')}
      </div>
      <div class="muted" style="font-size:12.5px;line-height:1.6">${isDist()?'Keep this file in one place and always open it in the same browser: your data is kept by that browser for this file, not written into the file itself, so a copy of the file is an empty Ledger and a cleared browser is a lost one. Turn on Live backup (or use Back up now) here so there is always a copy on disk. ':'Each address keeps its own browser storage, so a Ledger opened as a local file and one opened on localhost are two separate books that cannot read each other — not even to compare. Keep to one. '}${isCanonical()?'':'<button class="btn btn-sm btn-primary" data-act="open-canonical" style="margin-top:9px">Open canonical Ledger</button>'}</div>
    </div>
    <div class="totalrule" style="margin-top:22px">
      <div class="eyebrow">Account types</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.6">${untypedAccounts().length?untypedAccounts().length+' account'+(untypedAccounts().length===1?'':'s')+' still need'+(untypedAccounts().length===1?'s':'')+' a type before all balance-sheet metrics are fully accurate. Ledger suggests, you confirm — typing an account never changes its balance or history.':'Every account has a type, so the balance sheet groups everything correctly.'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm${untypedAccounts().length?' btn-primary':''}" data-act="type-review">Review account types…</button></div>
    </div>
    <div class="totalrule" style="margin-top:22px">
      <div class="eyebrow">Re-categorise</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.6">Ledger's built-in categoriser improves over time. Run it over what you already have — with a preview, and your hand-picked categories untouched.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-act="recat">Re-categorise transactions…</button></div>
    </div>
    <div class="totalrule" style="margin-top:22px">
      <div class="eyebrow">Monthly close</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.6">Reconcile every account against its statement once a month. Each accepted statement becomes a normal checkpoint. Closing never locks anything — later edits flag the month for review instead.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-act="close-month" data-v="${ui.month}">Close ${esc(monthName(ui.month,true))}</button><button class="btn btn-sm btn-ghost" data-act="close-history">History${(()=>{ const r=S.closes.filter(c=>closeStatus(c)==='review').length; return r?' · '+r+' need review':''; })()}</button></div>
    </div>
    ${verifyBalancesPanel()}
    <div class="totalrule" style="margin-top:22px">
      <div class="eyebrow">Start over</div>
      <div class="muted" style="font-size:13.5px;margin:6px 0 12px;line-height:1.5">Sample data lets you see every widget working. Clearing wipes accounts, transactions, budgets, and goals for good.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" data-act="load-sample">Load sample data</button>
        <button class="btn btn-sm btn-danger" data-act="reset-data">Clear everything</button>
      </div>
    </div>`;
}

/* runs once per ledger, fresh or existing, and never overwrites a rate you set */
function applySeedRates(){
  S.rates=S.rates||{};
  if(S.settings.ratePack1) return false;
  let changed=false;
  Object.keys(SEED_RATES).forEach(c=>{
    if(!(Number(S.rates[c])>0)){ S.rates[c]=SEED_RATES[c]; changed=true; }
  });
  S.settings.ratePack1=true;
  return changed||true;
}
/* One of the few outbound requests this app can make (the others: an AI key you added, the optional OCR download), and only when you press
   the button. It sends a single currency code — never an amount, balance or note.
   Everything still works with rates typed in by hand. */
let rateNote='';
function fetchRates(){
  const base=baseCur();
  const want=usedCurrencies().filter(c=>c!==base);
  if(!want.length){ toast('Only '+base+' is in use — nothing to fetch'); return; }
  rateNote='Fetching…'; refreshSettings();
  fetch('https://open.er-api.com/v6/latest/'+encodeURIComponent(base),{cache:'no-store'})
    .then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(d=>{
      if(!d||d.result!=='success'||!d.rates) throw new Error('unexpected reply');
      S.rates=S.rates||{};
      let got=0; const missing=[];
      want.forEach(c=>{ const v=Number(d.rates[c]); if(v>0){ S.rates[c]=v; got++; } else missing.push(c); });
      if(!got) throw new Error('none of your currencies came back');
      S.settings.ratesUpdated=Date.now();
      S.settings.ratesSource=d.time_last_update_utc||'';
      rateNote='Updated '+got+' rate'+(got===1?'':'s')+
        (missing.length?'. Not covered: '+missing.join(', ')+' — enter those by hand.':'.');
      save(); render(); refreshSettings(); toast('Rates updated');
    })
    .catch(err=>{
      rateNote='Could not reach the rates service ('+(err&&err.message||'blocked')+
        '). This often means the page is sandboxed or opened straight from a folder, which blocks outside requests. Typing the rates in by hand works exactly the same.';
      refreshSettings();
    });
}
function ratesAge(){
  const t=S.settings.ratesUpdated;
  if(!t) return 'These are starting values, never checked by you. Rates drift — confirm them against a source you trust before leaning on any total.';
  const days=Math.floor((Date.now()-t)/86400000);
  const when=days<1?'today':days===1?'yesterday':days+' days ago';
  return (days>90?'⚠ ':'')+'Rates last set '+when+'.'+(days>90?' That is old enough to skew your totals — worth rechecking.':'');
}
function storageBlurb(){
  if(STORAGE_WHERE==='chat')
    return "You're running inside Claude, so this copy saves to <b>this chat</b> — come back to the same conversation and your data will be here. A copy you download is separate, and saves on that device instead.";
  if(STORAGE_WHERE==='device')
    return "You're running a downloaded copy, so this saves to <b>this browser on this device</b>. It won't follow you to another browser or machine, and it's separate from the copy in your Claude chat. Use the backup buttons below to move data between them.";
  return "Heads up — this copy <b>can't save</b>. Your browser is blocking storage (often private-browsing mode), so anything you enter clears on refresh. Back up regularly, or open the file normally rather than in private mode.";
}

/* ---------- CSV ---------- */
function download(name,text,mime){
  const blob=new Blob([text],{type:mime||'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function csvCell(v){ v=String(v==null?'':v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }
function exportCSV(){
  if(!S.transactions.length){ toast('Nothing to export yet'); return; }
  const rows=[['date','amount','type','category','account','to_account','note']];
  S.transactions.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(t=>{
    if(isTransfer(t)) rows.push([t.date,t.amount.toFixed(2),'transfer','',(acct(t.fromId)||{}).name||'',(acct(t.toId)||{}).name||'',t.note||'']);
    else rows.push([t.date,t.amount.toFixed(2),t.type,cat(t.categoryId).name,(acct(t.accountId)||{}).name||'','',t.note||'']);
  });
  download('ledger-transactions.csv',rows.map(r=>r.map(csvCell).join(',')).join('\n'),'text/csv;charset=utf-8');
  toast('Exported '+S.transactions.length+' transactions');
}
function parseCSV(text,delim){
  delim=delim||',';
  const rows=[]; let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){
      if(ch==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; }
      else cell+=ch;
    }else{
      if(ch==='"') q=true;
      else if(ch===delim){ row.push(cell); cell=''; }
      else if(ch==='\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
      else if(ch!=='\r') cell+=ch;
    }
  }
  if(cell.length||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(c=>c.trim()!==''));
}
/* spreadsheets paste as tabs, downloads arrive as commas — work out which */
function detectDelim(text){
  const line=(text.split('\n')[0]||'');
  const tabs=line.split('\t').length, commas=line.split(',').length, semis=line.split(';').length;
  if(tabs>=commas&&tabs>=semis&&tabs>1) return '\t';
  if(semis>commas&&semis>1) return ';';
  return ',';
}
const KNOWN_COLS=['date','amount','type','category','account','to_account','note','ref','debit','credit'];
/* what banks call their columns: the first matching header wins, so "Name" beats "Memo" for the description */
const COL_ALIAS={'reference':'ref','reference id':'ref','reference number':'ref','reference no':'ref','ref no':'ref','ref id':'ref','transaction id':'ref','txn id':'ref','id':'ref',
  'transaction date':'date','posted date':'date','posting date':'date','date posted':'date','trans date':'date','value date':'date',
  'description':'note','details':'note','payee':'note','name':'note','merchant':'note','narrative':'note','particulars':'note','memo':'note','transaction description':'note','description 1':'note',
  'transaction type':'type','txn type':'type','dr/cr':'type','cr/dr':'type','debit/credit':'type','direction':'type',
  'withdrawal':'debit','withdrawals':'debit','debits':'debit','money out':'debit','paid out':'debit','deposit':'credit','deposits':'credit','credits':'credit','money in':'credit','paid in':'credit',
  'from':'account','from account':'account','to':'to_account'};
/* the words a direction column may hold; one list, shared by the header heuristic and the row reader */
const CSV_IN=/^(in|income|credit|cr|deposit|dep|deposits)$/i, CSV_OUT=/^(out|expense|debit|dr|withdrawal|wd|withdrawals|payment)$/i;
/* one row's signed amount: an amount column (parentheses or a trailing minus mean negative), or credit minus debit */
function csvAmount(r,ci){
  const num=v=>{ let s=String(v==null?'':v).trim(); if(!s) return NaN; const paren=/^\(.*\)$/.test(s); const neg=paren||/-\s*$/.test(s)||/^-/.test(s)||/\bDR\b/i.test(s);
    s=s.replace(/[^0-9.,]/g,'');   /* spaces, currency signs, DR/CR and the like go; separators are decided below */
    /* comma as decimal (62,40 · 1.234,56) when it is the LAST separator with 1–2 digits after it; otherwise commas group thousands */
    const lc=s.lastIndexOf(','), ld=s.lastIndexOf('.');
    if(lc>=0&&lc>ld&&/^\d{1,2}$/.test(s.slice(lc+1))) s=s.replace(/\./g,'').replace(',','.'); else s=s.replace(/,/g,'');
    if(!s) return NaN; const n=parseFloat(s); return neg?-n:n; };
  const paren=v=>/^\(.*\)$/.test(String(v==null?'':v).trim());
  if(ci.amount>=0){ const a=num(r[ci.amount]); if(!isNaN(a)) return a; }
  /* debit / credit columns: a debit is money out however the bank signs it; parentheses in either column mean
     the opposite (a refund in the debit column, a reversal in the credit column) */
  if(ci.debit>=0||ci.credit>=0){ const d=ci.debit>=0?num(r[ci.debit]):NaN, c=ci.credit>=0?num(r[ci.credit]):NaN; if(isNaN(d)&&isNaN(c)) return NaN;
    const dv=isNaN(d)?0:(paren(r[ci.debit])?Math.abs(d):-Math.abs(d)), cv=isNaN(c)?0:(paren(r[ci.credit])?-Math.abs(c):Math.abs(c)); return dv+cv; }
  return NaN;
}
/* a date in whatever form the export used: ISO, 8/2/2026 (read with the date-format setting), Aug 2 2026 … */
function csvDate(v){ const s=String(v==null?'':v).trim(); if(!s) return ''; if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10); return parseLooseDate(s)||''; }
function mapColumns(rows){
  const head=rows[0].map(h=>{ const k=h.trim().toLowerCase(); return COL_ALIAS[k]||k; });
  const hasHeader=KNOWN_COLS.some(k=>head.indexOf(k)>=0);
  if(hasHeader){
    const ci={}; KNOWN_COLS.forEach(k=>{ci[k]=head.indexOf(k);});
    /* a bare "Transaction" column is the direction when its values are DEBIT/CREDIT, otherwise the description */
    const ti=head.indexOf('transaction');
    if(ti>=0){ const vals=rows.slice(1).map(r=>String(r[ti]||'').trim()).filter(Boolean); const dirish=vals.length&&vals.every(v=>CSV_IN.test(v)||CSV_OUT.test(v)); if(dirish&&ci.type<0) ci.type=ti; else if(!dirish&&ci.note<0) ci.note=ti; }
    return {ci:ci,body:rows.slice(1),header:true};
  }
  const ci={}; KNOWN_COLS.forEach(k=>{ci[k]=-1;}); Object.assign(ci,{date:0,amount:1,category:2,account:3,note:4});
  return {ci:ci,body:rows,header:false};
}

function importCSV(){
  openSheet('Import transactions',`
    <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:14px">
      Paste rows straight from a spreadsheet or your bank's export, or pick a saved file. Tabs, commas, and semicolons all work.
      A header row naming <b>date, amount, type, category, account, note</b> is read properly; without one, columns are taken in that order.
      Categories and accounts you don't have yet get created. A negative amount reads as money out.
    </div>
    <label class="field"><span>Paste rows here</span>
      <textarea id="csvPaste" rows="7" placeholder="date&#9;amount&#9;category&#9;account&#9;note&#10;2026-07-14&#9;-62.40&#9;Groceries&#9;Chequing&#9;Market" style="font-family:var(--mono);font-size:13px;resize:vertical"></textarea></label>
    <div id="csvPreview" class="muted" style="font-size:13px;line-height:1.5;margin:-6px 0 14px;min-height:18px"></div>
    <label class="field"><span>Or choose a file</span><input type="file" accept=".csv,.tsv,.txt,text/csv" id="csvFile"></label>
    <label class="field"><span>File rows without an account column into</span>
      <select id="csvAcct"><option value="">— choose an account —</option>${S.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
    <label class="field" style="display:flex;align-items:center;gap:9px">
      <input type="checkbox" id="csvBalances" checked style="width:auto;margin:0">
      <span style="margin:0;text-transform:none;letter-spacing:0;font-size:14.5px;color:var(--ink);font-weight:400">Update account balances (untick only if the balance is already correct)</span>
    </label>`,
    `<span class="spacer"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="run-import">Import</button>`);
}

function previewPaste(){
  const box=$('#csvPreview'), text=($('#csvPaste')||{}).value||'';
  if(!box) return;
  if(!text.trim()){ box.textContent=''; return; }
  const rows=parseCSV(text,detectDelim(text));
  if(!rows.length){ box.textContent='Nothing readable in that yet.'; return; }
  const m=mapColumns(rows);
  if(m.ci.date<0||(m.ci.amount<0&&m.ci.debit<0&&m.ci.credit<0)){
    box.innerHTML='Found a header row, but no <b>date</b> and <b>amount</b> column in it.'; return;
  }
  let good=0;
  m.body.forEach(r=>{ if(!isNaN(csvAmount(r,m.ci))) good++; });
  box.innerHTML=`${good} row${good===1?'':'s'} ready`+
    (m.header?' — using your header row.':' — no header found, reading columns as date, amount, category, account, note.')+
    (m.body.length-good?` ${m.body.length-good} row${m.body.length-good===1?'':'s'} skipped for having no readable amount.`:'');
}

function runImport(){
  const pasted=(($('#csvPaste')||{}).value||'').trim();
  if(pasted){ ingestRows(pasted); return; }
  const fileEl=$('#csvFile'), file=fileEl&&fileEl.files[0];
  if(!file){ toast('Paste some rows or choose a file'); return; }
  const fr=new FileReader();
  fr.onload=()=>ingestRows(String(fr.result));
  fr.onerror=()=>toast('That file could not be read');
  fr.readAsText(file);
}

async function ingestRows(text){
  const adjust=$('#csvBalances').checked;
  const rows=parseCSV(text,detectDelim(text));
  if(!rows.length){ toast('Nothing to import'); return; }
  const m=mapColumns(rows), ci=m.ci;
  if(ci.date<0||(ci.amount<0&&ci.debit<0&&ci.credit<0)){ toast('Needs at least a date and an amount column (or debit and credit columns)'); return; }
  const fallbackAcct=(($('#csvAcct')||{}).value)||'';
  let n=0,skipped=0,nDup=0,nMaybe=0,signClash=0; const addedTx=[], added={}, dupUsed={}, srcId='CSV '+await contentHash(text);
  importTrace={source:'csv',at:Date.now(),header:m.header,rows:[],skipped:[]};
  m.body.forEach(r=>{
    const raw=csvAmount(r,ci);
    if(isNaN(raw)){ skipped++; importTrace.skipped.push({raw:r.join(' | '),why:'invalid or missing amount'}); return; }
    const typeRaw=(ci.type>=0?String(r[ci.type]||''):'').trim().toLowerCase();
    if(typeRaw==='transfer'){
      const fn=(ci.account>=0?String(r[ci.account]||''):'').trim();
      const tn=(ci.to_account>=0?String(r[ci.to_account]||''):'').trim();
      if(!fn||!tn){ skipped++; importTrace.skipped.push({raw:r.join(' | '),why:'transfer without both accounts'}); return; }
      const findOnly=nm=>S.accounts.find(y=>y.name.toLowerCase()===nm.toLowerCase())||null;
      const fa=findOnly(fn), ta=findOnly(tn);
      if(!fa||!ta){ skipped++; importTrace.skipped.push({raw:r.join(' | '),why:'a transfer needs two accounts that already exist here — “'+esc(!fa?fn:tn)+'” is not one of them'}); return; }
      const dd=csvDate(r[ci.date]); if(!dd){ skipped++; importTrace.skipped.push({raw:r.join(' | '),why:'unreadable date “'+String(r[ci.date]||'')+'”'}); return; }
      const tt={id:uid(),date:dd,amount:Math.abs(raw),
        type:'transfer',fromId:fa.id,toId:ta.id,note:(ci.note>=0?String(r[ci.note]||''):'').trim(),source:'csv',raw:r.join(' | '),src:srcId,createdAt:Date.now()};
      const same=S.transactions.find(x=>x.type==='transfer'&&x.src===srcId&&srcKey(x.raw)===srcKey(tt.raw)&&!added[x.id]);
      if(same){ nDup++; importTrace.skipped.push({raw:r.join(' | '),why:'definite duplicate — the same line already imported'}); return; }
      S.transactions.push(tt); addedTx.push(tt); added[tt.id]=1; n++; return;
    }
    const type=CSV_IN.test(typeRaw)?'in':(CSV_OUT.test(typeRaw)?'out':(raw<0?'out':'in'));
    const noteTxt=(ci.note>=0?String(r[ci.note]||''):'').trim();
    const given=(ci.category>=0?String(r[ci.category]||''):'').trim();
    /* no category column: money in is filed as Other income, money out as Uncategorised — never a deposit as spending */
    const cname=given||(type==='in'?'Other income':'Uncategorised');
    let c=S.categories.find(x=>x.name.toLowerCase()===cname.toLowerCase());
    if(!c){ c={id:uid(),name:cname,type:type,color:PALETTE[S.categories.length%PALETTE.length],need:false}; S.categories.push(c); }
    const aname=(ci.account>=0?String(r[ci.account]||''):'').trim();
    let a=aname?S.accounts.find(x=>x.name.toLowerCase()===aname.toLowerCase()):acct(fallbackAcct);
    if(!a){ skipped++; importTrace.skipped.push({raw:r.join(' | '),why:aname?'no account here is called “'+aname+'” — create it first, Ledger will not invent one':'no account for this row — pick one in “File rows without an account column into”'}); return; }
    const d=csvDate(r[ci.date]); if(!d){ skipped++; importTrace.skipped.push({raw:r.join(' | '),why:'unreadable date “'+String(r[ci.date]||'')+'”'}); return; }
    const t={id:uid(),date:d,amount:Math.abs(raw),type:c.type||type,
             categoryId:c.id,accountId:a.id,note:(ci.note>=0?String(r[ci.note]||''):'').trim()};
    if(!given){ const rr=matchRule(noteTxt,a.id); if(rr){ t.categoryId=rr.categoryId; t.type=cat(rr.categoryId).type; t.catSource='rule'; t.ruleId=rr.id; } else t.catSource='default'; }
    else { t.catSource='import'; if(c.type!==type) signClash++; }
    t.source='csv'; t.raw=r.join(' | '); t.src=srcId; t.createdAt=Date.now();
    const ref=(ci.ref>=0?String(r[ci.ref]||''):'').trim(); if(ref) t.ref=ref;
    const lvl=isDup(t,{into:a.id,used:dupUsed,exclude:added});
    if(lvl==='definite'){ nDup++; importTrace.skipped.push({raw:r.join(' | '),why:'definite duplicate — same reference id or the same line already imported into this account'}); return; }
    if(lvl==='possible') nMaybe++;
    importTrace.rows.push({raw:r.join(' | '),parsed:{date:d,amount:raw,note:noteTxt,category:given},normalized:{date:t.date,amount:t.amount,type:t.type},rule:t.ruleId?(S.rules.find(x=>x.id===t.ruleId)||{}).match:'',dup:lvl==='possible'?'possible duplicate (same account · date · amount · direction · merchant; kept — no reference id or identical line to prove it)':'no',final:{id:t.id,categoryId:t.categoryId,accountId:t.accountId}});
    S.transactions.push(t); addedTx.push(t); added[t.id]=1;
    n++;
  });
  if(!adjust) absorbIntoAnchors(addedTx);
  save(); closeModal(); render();
  dlog('csv imported',{rows:n,skipped:skipped,duplicates:nDup,possible:nMaybe});
  toast('Imported '+n+' transaction'+(n===1?'':'s')+(signClash?' · '+signClash+' row'+(signClash===1?'':'s')+' where the amount\'s sign disagreed with the named category (the category was kept)':'')+(skipped?', skipped '+skipped+' unreadable':'')+(nDup?', skipped '+nDup+' definite duplicate'+(nDup===1?'':'s'):'')+(nMaybe?' · '+nMaybe+' possible duplicate'+(nMaybe===1?'':'s')+' kept — check Settings › Diagnostics › last import':''),true);
}

/* ============================ screenshot import ============================ */
let shots=[], revRows=[], shotBusy=false;
const AI_MODELS=[['claude-opus-5','Claude Opus 5 (best)'],['claude-sonnet-5','Claude Sonnet 5 (cheaper)']];
const OR_MODELS=[
  ['anthropic/claude-sonnet-5','Claude Sonnet 5 — recommended (~1¢ a scan)'],
  ['anthropic/claude-opus-5','Claude Opus 5 — most accurate'],
  ['google/gemini-3.5-flash','Gemini 3.5 Flash — cheap'],
  ['openai/gpt-5.5','GPT-5.5'],
  ['google/gemma-4-31b-it:free','Gemma 4 31B — free (images + text PDFs)'],
  ['openrouter/free','OpenRouter auto — free (picks a free model for you)'],
  ['custom','Another model — type its id below']
];
function aiProvider(){ return S.settings.aiProvider==='openrouter'?'openrouter':'anthropic'; }
/* keys are device secrets: kept in their own browser-storage slot, never inside the ledger, backups, or the debug log */
const KEYS_KEY='ledger-keys';
function loadKeys(){ try{ return JSON.parse(window.localStorage.getItem(KEYS_KEY)||'{}')||{}; }catch(e){ return {}; } }
function setKey(name,value){ const k=loadKeys(); if(value) k[name]=value; else delete k[name]; try{ window.localStorage.setItem(KEYS_KEY,JSON.stringify(k)); }catch(e){} }
function getKey(name){ return String(loadKeys()[name]||'').trim(); }
function migrateKeysOut(){ let moved=false; ['apiKey','openrouterKey'].forEach(k=>{ if(S.settings&&S.settings[k]){ if(!getKey(k)) setKey(k,String(S.settings[k]).trim()); delete S.settings[k]; moved=true; } }); return moved; }
function aiKey(){ return aiProvider()==='openrouter'?getKey('openrouterKey'):getKey('apiKey'); }
function aiModel(){ return aiProvider()==='openrouter'?(S.settings.openrouterModel||'anthropic/claude-sonnet-5'):(S.settings.aiModel||'claude-opus-5'); }
function aiModelLabel(){ const list=aiProvider()==='openrouter'?OR_MODELS:AI_MODELS; const m=list.find(x=>x[0]===aiModel()); return m?m[1].split(' — ')[0]:aiModel(); }
function aiVendor(){ return aiProvider()==='openrouter'?'OpenRouter':'Anthropic'; }

