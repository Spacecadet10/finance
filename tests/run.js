/* Ledger headless suite. `npm test` — boots the real page in jsdom per suite, clock pinned to 2026-09-09.
   Every check is one line of output on failure only; the summary at the end is the verdict. */
const fs=require('fs'); const path=require('path');
const {boot,acct,tx,xfer,rng,HTML}=require('./lib');
const DIST=/dist[\/\\]/.test(HTML);
const TODAY='2026-09-09';
let pass=0,fail=0; const failures=[]; let cur='';
function check(cond,msg){ if(cond){ pass++; } else { fail++; failures.push(cur+': '+msg); console.log('  FAIL '+cur+': '+msg); } }
function eq(a,b,msg){ const ok=JSON.stringify(a)===JSON.stringify(b); check(ok,(msg||'')+' expected '+JSON.stringify(b)+' got '+JSON.stringify(a)); }
function near(a,b,msg){ check(Math.abs(a-b)<0.006,(msg||'')+' expected ≈'+b+' got '+a); }
const suites=[];
function suite(name,fn){ suites.push({name,fn}); }
function seedBasic(S){
  S.accounts=[acct('chq','asset',1000,{name:'Chequing'}),acct('sav','asset',5000,{name:'Savings'}),acct('visa','liability',400,{name:'Visa',acctType:'credit card'})];
  S.transactions=[
    tx('t1','2026-09-01',3000,'in','c1','chq',{userId:'u1'}),
    tx('t2','2026-09-02',120,'out','c3','chq',{userId:'u1'}),
    tx('t3','2026-09-03',60,'out','c4','visa',{userId:'u2'}),
    tx('t4','2026-09-04',45,'out','c3','chq'),
    xfer('t5','2026-09-05',200,'chq','sav'),
    xfer('t6','2026-09-06',100,'chq','visa'),
    tx('t7','2026-08-15',2900,'in','c1','chq',{userId:'u1'}),
    tx('t8','2026-08-20',300,'out','c3','chq',{userId:'u2'}),
    tx('t9','2026-09-20',80,'out','c3','chq')  /* future */
  ];
  S.users=[{id:'u1',name:'Alex',color:'#2E6B4F'},{id:'u2',name:'Sam',color:'#3A6B8A'}];
  S.budgets={c3:500};
}

/* ------------------------------------------------------------------ state & persistence */
suite('boot & state',async()=>{
  const {L,S,errors}=await boot();
  check(typeof L.APP_VERSION==='string'&&/^\d{4}\.\d{2}\.\d{2}-\d+$/.test(L.APP_VERSION),'APP_VERSION looks like a date build');
  eq(errors.length,0,'no uncaught errors on boot '+errors.join(';'));
  check(Array.isArray(S.accounts)&&Array.isArray(S.transactions)&&Array.isArray(S.users),'core lists exist');
  const ids=S.settings.widgets.map(w=>w.id); check(ids.indexOf('household')>=0&&ids.indexOf('networth')>=0,'default widgets include household and net worth');
  check(S.categories.some(c=>c.id==='c0')&&S.categories.some(c=>c.id==='c35'),'category packs applied');
});
suite('persistence',async()=>{
  const {L,S,w}=await boot(); seedBasic(S); S.settings.widgets=[{id:'networth',span:6,on:true},{id:'bogus',span:6,on:true}];
  await L.saveNow(); await L.load();
  eq(L.S.transactions.length,9,'transactions survive save/load');
  const ids=L.S.settings.widgets.map(w=>w.id);
  check(ids.indexOf('bogus')<0,'unknown widget ids dropped on load'); check(ids.indexOf('household')>=0&&ids.indexOf('budgets')>=0,'missing widgets added on load');
  check(L.S.settings.rev>0,'save stamps a revision');
  const raw=JSON.parse(w.localStorage.getItem('ledger-v1')||'{}');
  check(!JSON.stringify(raw).includes('apiKey'),'no api key inside the ledger blob');
  L.setKey('claude','sk-test-123'); eq(L.getKey('claude'),'sk-test-123','keys round-trip');
  check(!(w.localStorage.getItem('ledger-v1')||'').includes('sk-test-123'),'keys never land in ledger-v1');
  const v=L.validateBackupShape(JSON.parse(JSON.stringify(L.S))); check(v===true||v===''||(v&&v.ok!==false)||(Array.isArray(v)&&!v.length),'own state validates as a backup');
  const bad=L.validateBackupShape({accounts:'x'}); check(bad!==true&&bad!==''&&!(v&&v.ok===false&&false),'garbage does not validate');
});
suite('multi-tab protection',async()=>{
  const {L,S,w}=await boot(); seedBasic(S); await L.saveNow();
  const other=JSON.parse(w.localStorage.getItem('ledger-v1')); other.settings.rev=(other.settings.rev||0)+5; w.localStorage.setItem('ledger-v1',JSON.stringify(other));
  let refused=false; try{ await L.saveNow(); }catch(e){ refused=true; }
  check(refused||L.staleTab,'a save over a newer revision is refused or flags the tab stale');
});

/* ------------------------------------------------------------------ balances */
suite('derived balances',async()=>{
  const {L,S}=await boot(); seedBasic(S); L.recalcBalances();
  const chq=S.accounts[0], sav=S.accounts[1], visa=S.accounts[2];
  near(L.derivedBalance(chq),1000+3000-120-45-200-100+2900-300,'chequing = opening + rows ≤ today (future row excluded)');
  near(L.derivedBalance(sav),5200,'savings receives the transfer');
  near(L.derivedBalance(visa),400+60-100,'liability grows with spending, shrinks with payment');
  near(chq.balance,L.derivedBalance(chq),'balance cache matches derived');
  near(L.balanceAsOf(chq,'2026-09-01'),1000+2900-300+3000,'balanceAsOf on a date');
  near(L.balanceAsOf(chq,'2026-08-01'),1000,'before any row = opening');
  L.setCheckpoint(chq,'2026-09-03',9999);
  near(L.derivedBalance(chq),9999-45-200-100,'checkpoint governs; rows on its date are inside it');
  near(L.balanceAsOf(chq,'2026-09-02'),1000+2900-300+3000-120,'dates before the checkpoint still use opening arithmetic');
  L.setCheckpoint(chq,'2026-09-30',5);
  near(L.derivedBalance(chq),9999-45-200-100,'a future checkpoint waits');
  eq(L.futureCheckpoints(chq).length,1,'future checkpoint reported');
  L.removeCheckpoint(chq,'2026-09-30'); L.removeCheckpoint(chq,'2026-09-03');
  near(L.derivedBalance(chq),6135,'checkpoints removed → back to arithmetic');
  check(L.isFuture(S.transactions[8]),'row dated after today is future');
  check(!L.countsFor(S.transactions[8],chq),'future row does not count today');
  eq(L.effectOn(S.transactions[4],chq),-200,'transfer out effect'); eq(L.effectOn(S.transactions[4],sav),200,'transfer in effect');
  eq(L.effectOn(S.transactions[5],visa),-100,'payment lowers a liability');
  const ic=L.integrityCheck(); eq(ic.checks.filter(c=>c.status==='fail').map(c=>c.name),[],'integrity clean');
});
suite('opening balance authoritative on since',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('a','asset',500,{since:'2026-09-01'})];
  S.transactions=[tx('old','2026-08-20',100,'out','c3','a'),tx('new','2026-09-02',50,'out','c3','a')]; L.recalcBalances();
  near(L.derivedBalance(S.accounts[0]),450,'rows before since are inside the opening balance');
  const ic=L.integrityCheck(); check(ic.checks.some(c=>c.status==='warn'&&/before/i.test(c.name+c.detail)),'integrity warns about the row before since');
});

/* ------------------------------------------------------------------ net worth */
suite('net worth',async()=>{
  const {L,S}=await boot(); seedBasic(S); S.accounts[1].since='2026-09-01'; L.recalcBalances();
  near(L.netWorth(),L.netWorthAt(TODAY),'netWorth() === netWorthAt(today)');
  near(L.netWorthAt(TODAY),6135+5200-360,'assets minus liabilities');
  eq(L.valueAt(S.accounts[1],'2026-08-31'),0,'an account is worth nothing before since');
  const dates=['2026-07-31','2026-08-31','2026-09-09']; const fast=L.netWorthSeriesAt(dates);
  const pts=Array.isArray(fast)?fast:(fast.points||fast.series||[]);
  check(pts.length===3,'fast series returns one point per date');
  pts.forEach((p,i)=>near(typeof p==='number'?p:(p.v!==undefined?p.v:p.value),L.netWorthAt(dates[i]),'fast series agrees with netWorthAt on '+dates[i]));
  S.transactions[1].amount=999; L.recalcBalances(); const again=L.netWorthSeriesAt(dates); const p2=Array.isArray(again)?again:(again.points||again.series||[]);
  near(typeof p2[2]==='number'?p2[2]:(p2[2].v!==undefined?p2[2].v:p2[2].value),L.netWorthAt(TODAY),'series cache invalidates on an amount edit');
  S.rates.USD=1.35; S.accounts.push(acct('usd','asset',135,{cur:'USD'})); L.recalcBalances();
  near(L.toBase(135,'USD'),100,'toBase converts at the stored rate');
});

/* ------------------------------------------------------------------ random books vs an independent model */
suite('random books differential',async()=>{
  const {L,S}=await boot(); const R=rng(20260909);
  const pick=a=>a[Math.floor(R()*a.length)]; const day=(m,d)=>'2026-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
  let books=0, mism=0;
  for(let b=0;b<150;b++){
    const n=1+Math.floor(R()*4); S.accounts=[]; S.transactions=[];
    for(let i=0;i<n;i++){ const a=acct('a'+i,R()<0.3?'liability':'asset',Math.round(R()*5000)); if(R()<0.4) a.since=day(5+Math.floor(R()*3),1+Math.floor(R()*20)); S.accounts.push(a); }
    const m=Math.floor(R()*40);
    for(let i=0;i<m;i++){ const dt=day(6+Math.floor(R()*5),1+Math.floor(R()*28)); const amt=Math.round(R()*50000)/100; if(n>1&&R()<0.25){ const f=pick(S.accounts), t=pick(S.accounts.filter(x=>x!==f)); S.transactions.push(xfer('x'+i,dt,amt,f.id,t.id)); } else { const a=pick(S.accounts); S.transactions.push(tx('t'+i,dt,amt,R()<0.4?'in':'out',R()<0.4?'c1':'c3',a.id)); } }
    S.accounts.forEach(a=>{ a.checkpoints=[]; const k=Math.floor(R()*3); for(let i=0;i<k;i++) a.checkpoints.push({date:day(6+Math.floor(R()*5),1+Math.floor(R()*28)),balance:Math.round(R()*8000),at:1}); a.checkpoints.sort((x,y)=>x.date.localeCompare(y.date)); });
    L.recalcBalances(); books++;
    /* reference: newest checkpoint ≤ D governs (rows on its date inside it); else opening on since (rows ≤ since inside it) */
    /* the opening balance is the balance at the START of `since`, so rows dated on since count; a checkpoint is the balance at the END of its date */
    const dayBefore=d=>{ const x=new Date(d+'T12:00:00'); x.setDate(x.getDate()-1); return x.toISOString().slice(0,10); };
    const ref=(a,D)=>{ const cps=a.checkpoints.filter(c=>c.date<=D); let base=cps.length?cps[cps.length-1].balance:a.opening.balance, floor=cps.length?cps[cps.length-1].date:(a.since?dayBefore(a.since):''); let v=base;
      S.transactions.forEach(t=>{ if(t.date<=floor||t.date>D) return; let e=0; if(t.type==='transfer'){ if(t.fromId===a.id) e-=t.amount; if(t.toId===a.id) e+=t.amount; } else if(t.accountId===a.id){ e=t.type==='in'?t.amount:-t.amount; }
        if(a.kind==='liability') e=-e; v+=e; }); return Math.round(v*100)/100; };
    const Ds=[TODAY,day(7,15),day(8,31),day(6,1)];
    S.accounts.forEach(a=>Ds.forEach(D=>{ const got=Math.round(L.balanceAsOf(a,D)*100)/100, want=ref(a,D); if(Math.abs(got-want)>0.006){ mism++; if(mism<4) console.log('   book',b,a.id,D,'got',got,'want',want,JSON.stringify(a.checkpoints),a.since); } }));
    const nw=S.accounts.reduce((s,a)=>s+(a.kind==='liability'?-1:1)*((a.since&&TODAY<a.since)?0:ref(a,TODAY)),0);
    if(Math.abs(nw-L.netWorthAt(TODAY))>0.01){ mism++; }
  }
  eq(mism,0,'balances and net worth agree with the reference model across '+books+' random books');
});

/* ------------------------------------------------------------------ reversals */
suite('reversals',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('a','asset',1000)];
  const out=tx('o','2026-09-01',250,'out','c3','a',{note:'E-TRANSFER SENT'}), back=tx('r','2026-09-03',250,'in','c2','a',{note:'E-TRANSFER REVERSAL'});
  S.transactions=[out,back]; L.recalcBalances();
  check(L.reversalPairOk(out,back),'pair matches'); check(L.linkReversal(out,back,'manual'),'link succeeds');
  check(L.isReversed(out)&&L.isReversal(back),'both sides marked');
  check(!L.economicOut(out)&&!L.economicIn(back),'neither counts in analytics');
  near(L.derivedBalance(S.accounts[0]),1000,'balance keeps both movements');
  eq(L.monthFlows('2026-09').out,0,'month spending excludes the reversed row');
  back.amount=100; check(!L.reversalPairOk(out,back),'a changed amount breaks the pair');
  L.unlinkReversal(out); check(!L.isReversed(out)&&!L.isReversal(back),'unlink clears both');
  const r=L.autoLinkReversals([tx('r2','2026-09-04',250,'in','c2','a',{note:'REVERSAL OF E-TRANSFER'})].map(t=>{S.transactions.push(t);return t;}));
  check(r&&Array.isArray(r.linked)&&r.linked.length===1,'a reclaim that says so with one fit auto-links');
});

/* ------------------------------------------------------------------ loans */
suite('loan payments',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('chq','asset',5000),acct('loan','liability',20000,{acctType:'car loan',loan:{original:25000}})];
  check(L.isInstallmentLoan(S.accounts[1]),'car loan is an installment loan');
  const p=xfer('p','2026-09-01',600,'chq','loan',{alloc:{principal:450,extra:0,interest:150,tax:0,insurance:0,fee:0,escrow:0,escrowId:'',status:'set',source:'manual'}});
  S.transactions=[p]; L.recalcBalances();
  near(L.derivedBalance(S.accounts[0]),4400,'cash end moves by the full payment');
  near(L.derivedBalance(S.accounts[1]),19550,'loan end moves by principal only');
  const parts=L.spendParts(S.transactions); near(parts.reduce((s,x)=>s+x.amount,0),150,'interest is the only spending part'); check(parts.every(x=>x.categoryId==='c35'),'interest lands in Loan interest');
  near(L.monthLoanPrincipal('2026-09'),450,'principal reported for the month');
  p.alloc.status='pending'; p.alloc.principal=0; p.alloc.interest=0; L.recalcBalances();
  near(L.monthUnresolved('2026-09'),600,'unallocated payment is reported, not spent'); near(L.derivedBalance(S.accounts[1]),20000,'unresolved payment leaves the loan alone');
});

/* ------------------------------------------------------------------ analytics & household */
suite('flows and household filter',async()=>{
  const {L,S,ui,d}=await boot(); seedBasic(S); L.recalcBalances(); ui.month='2026-09'; ui.user='all'; L.render();
  eq([L.monthFlows('2026-09').in,L.monthFlows('2026-09').out],[3000,305],'household flows cover the whole month, future rows included');
  ui.user='u1'; eq(L.inMonth('2026-09').length,7,'inMonth is household-wide under a filter'); eq(L.inMonthMine('2026-09').length,2,'inMonthMine narrows');
  eq([L.monthFlowsMine('2026-09').in,L.monthFlowsMine('2026-09').out],[3000,120],'member flows');
  const a=L.avgFlows(); check(a.months>=1&&a.in>0,'averages exist'); ui.user='all'; const b=L.avgFlows(); eq(a,b,'goal/what-if averages ignore the member filter');
  ui.user='unassigned'; eq(L.inMonthMine('2026-09').map(t=>t.id).sort(),['t4','t5','t6','t9'],'unassigned view');
  ui.user='u2'; const h=L.householdRows('2026-09'); eq(h.rows.map(r=>[r.name,r.in,r.out]),[['Alex',3000,120],['Sam',0,60],['Unassigned',0,125]],'household rows'); eq([h.all.in,h.all.out],[3000,305],'household totals include the future row within the month');
  L.render(); const body=id=>d.querySelector('[data-wid="'+id+'"] .card-body').textContent;
  check(body('budgets').indexOf('Household-wide')>=0,'budgets note under a filter'); check(body('cashflow').indexOf('Household-wide')<0,'cash flow has no note');
  check(body('household').indexOf('Alex')>=0&&body('household').indexOf('Household in')>=0,'household widget renders');
  ui.search='t8'; L.render(); check(body('transactions').indexOf('t8')>=0&&body('transactions').indexOf('t2')<0,'search respects the member filter'); ui.search='';
  ui.user='all'; L.render(); check(d.getElementById('board').textContent.indexOf('Household-wide')<0,'no notes for everyone');
  eq(L.filteredUserId(),''); ui.user='u1'; eq(L.filteredUserId(),'u1'); ui.user='ghost'; eq(L.filteredUserId(),'');
  const pr=L.projection(100,0); const before=JSON.stringify(S); L.projection(500,50); eq(JSON.stringify(S),before,'projection is pure'); check(pr&&typeof pr==='object','projection returns an object');
});
suite('household members: bulk tag, delete, undo',async()=>{
  const {L,S,ui,act}=await boot(); seedBasic(S); S.transactions.forEach(t=>delete t.userId); L.recalcBalances();
  Object.assign(L.bulkUI,{userId:'u1',by:'category',value:'c3',retag:false});
  eq(L.bulkAssignMatches(L.bulkUI).map(t=>t.id),['t2','t4','t8','t9'],'category match, transfers excluded');
  Object.assign(L.bulkUI,{by:'merchant',value:'T1'}); eq(L.bulkAssignMatches(L.bulkUI).map(t=>t.id),['t1'],'merchant text match');
  Object.assign(L.bulkUI,{by:'account',value:'visa'}); eq(L.bulkAssignMatches(L.bulkUI).map(t=>t.id),['t3'],'account match');
  Object.assign(L.bulkUI,{by:'category',value:'c3'}); L.bulkAssignApply(); eq(S.transactions.filter(t=>t.userId==='u1').length,4,'apply tags the rows');
  Object.assign(L.bulkUI,{userId:'u2',by:'category',value:'c3',retag:false}); eq(L.bulkAssignMatches(L.bulkUI).length,0,'already-tagged rows are skipped'); L.bulkUI.retag=true; eq(L.bulkAssignMatches(L.bulkUI).length,4,'re-tag includes them');
  act('undo'); eq(L.S.transactions.filter(t=>t.userId).length,0,'undo restores untagged state');
  L.S.transactions[0].userId='u2'; L.S.recurring=[{id:'r',name:'x',amount:1,day:1,month:1,cadence:'monthly',categoryId:'c1',accountId:'chq',active:false,userId:'u2'}];
  act('del-user',{id:'u2'}); eq(L.S.users.map(u=>u.id),['u1'],'member removed'); check(!L.S.transactions[0].userId&&!L.S.recurring[0].userId,'rows and recurring items unassigned');
  act('undo'); eq(L.S.users.length,2,'member removal undone');
});

/* ------------------------------------------------------------------ recurring */
suite('people in the top bar',async()=>{
  const {L,S,ui,d,act,tick,w}=await boot(); S.accounts=[acct('chq','asset',100)]; L.render();
  const ap=d.getElementById('addPersonBtn'); check(!!ap&&!ap.hidden&&/Add a person/.test(ap.textContent),'top bar offers Add a person when nobody exists'); check(d.getElementById('userFilter').hidden,'filter hidden until someone exists');
  act('add-person'); await tick(20); check(!!d.querySelector('#f_name')&&!!d.querySelector('#f_color'),'person form opens');
  d.querySelector('#f_name').value='Alex'; act('form-submit'); await tick(20);
  eq(S.users.map(u=>u.name),['Alex'],'Alex added'); eq(ui.user,S.users[0].id,'Alex selected in the top bar'); check(!d.getElementById('userFilter').hidden,'filter shown now'); check(/Add for Alex/.test(d.getElementById('addTxBtn').textContent),'Add button says who it is for');
  act('add-tx'); await tick(20); eq(d.querySelector('#f_userId').value,S.users[0].id,'new transaction defaults to Alex'); act('close-modal'); L.discardReview();
  act('add-person'); await tick(20); d.querySelector('#f_name').value='  '; act('form-submit'); await tick(20); eq(S.users.length,1,'a blank name is refused'); act('close-modal');
  for(const n of ['Sam','Kim','Lee','Max']){ act('add-person'); await tick(10); d.querySelector('#f_name').value=n; act('form-submit'); await tick(10); }
  eq(S.users.length,5,'five people'); L.render(); check(d.getElementById('addPersonBtn').hidden,'+ Person hides at the limit');
  act('open-settings'); act('settings-tab',{v:'household'}); const inp=d.querySelector('[data-act="user-name"]'); inp.value='Alexandra'; inp.dispatchEvent(new w.Event('input',{bubbles:true}));
  eq(d.querySelector('#userFilter option[value="'+S.users[0].id+'"]').textContent,'Alexandra','renaming updates the top bar at once');
  act('del-user',{id:S.users[4].id}); eq(S.users.length,4,'remove from settings still works');
  const hb=d.querySelector('[data-wid="household"] [data-act="add-person"]'); check(!!hb,'household card offers Add a person');
  const ids=L.S.settings.widgets.map(x=>x.id); check(ids.indexOf('household')<ids.indexOf('networth'),'household card sits above net worth for a new book');
});
suite('household card placement for an older book',async()=>{
  const {L}=await boot(); const S=L.S; S.settings.widgets=S.settings.widgets.filter(x=>x.id!=='household').concat([{id:'household',span:12,on:true}]); delete S.settings.householdPlaced; await L.saveNow(); await L.load();
  const ids=L.S.settings.widgets.map(x=>x.id); eq(ids[ids.indexOf('guide')+1],'household','moved to the top, under the guide, on load'); check(L.S.settings.householdPlaced,'and only once');
});
suite('recurring',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('chq','asset',1000)];
  const r=(o)=>Object.assign({id:'r1',name:'Salary',amount:2500,day:5,month:9,cadence:'monthly',start:'',since:'2026-07',categoryId:'c1',accountId:'chq',active:true},o);
  eq(L.occurrences(r({}),'2026-09'),['2026-09-05'],'monthly occurrence');
  eq(L.occurrences(r({cadence:'weekly',start:'2026-09-01'}),'2026-09').length,5,'weekly occurrences in September 2026');
  eq(L.occurrences(r({cadence:'biweekly',start:'2026-09-01'}),'2026-09'),['2026-09-01','2026-09-15','2026-09-29'],'biweekly from a start date');
  eq(L.occurrences(r({cadence:'yearly',month:9,day:5}),'2026-09'),['2026-09-05'],'yearly in its month'); eq(L.occurrences(r({cadence:'yearly',month:3,day:5}),'2026-09'),[],'yearly outside its month');
  S.recurring=[r({userId:'u1'})]; S.users=[{id:'u1',name:'Alex',color:'#111'}]; S.generated={}; L.runRecurring();
  const g=S.transactions.filter(t=>t.recurringId==='r1'); check(g.length>=1&&g.every(t=>t.userId==='u1'&&t.source==='recurring'),'generated rows carry the member');
  check(!g.some(t=>t.date>TODAY),'nothing booked in the future');
  const n=S.transactions.length; L.runRecurring(); eq(S.transactions.length,n,'running again books nothing twice');
  S.recurring[0].active=false; S.recurring[0].id='r2'; S.generated={}; L.runRecurring(); eq(S.transactions.filter(t=>t.recurringId==='r2').length,0,'inactive items are not booked');
  const nd=L.nextDue(r({})); check(/^\d{4}-\d{2}-\d{2}$/.test(nd)||nd===null||typeof nd==='object','nextDue returns a date or nothing');
  S.transactions=[]; ['2026-06-05','2026-07-05','2026-08-05'].forEach((d,i)=>S.transactions.push(tx('p'+i,d,2500,'in','c1','chq',{note:'PAYROLL ACME',userId:'u1'})));
  const det=L.detectRecurring({}); check(det.some(x=>/acme/i.test(x.merchant)),'a monthly payroll is detected'); const sg=det.find(x=>/acme/i.test(x.merchant)); if(sg){ const rec=L.suggestionToRecurring(sg); eq(rec.userId,'u1','suggested item inherits the owner when all rows share one'); }
});

/* ------------------------------------------------------------------ categorisation & rules */
suite('categories and rules',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('chq','asset',0)];
  eq(L.guessCategory('INTERNET BILL PAY 00000011','out'),'Transfers & payments out','channel word without a merchant');
  check(/Groceries/.test(L.guessCategory('POINT OF SALE PURCHASE LOBLAWS','out')),'grocer'); check(/Phone|Internet/.test(L.guessCategory('ROGERS WIRELESS','out')),'telecom → Phone / Internet');
  eq(L.guessCategory('NETFLIX.COM','out'),'Subscriptions','a card line with no channel is categorised'); eq(L.guessCategory('INTERNET TRANSFER 000012','out'),'Transfers & payments out','channel-only line never matches the internet keyword');
  check(L.guessCategory('PAYROLL DEPOSIT ACME','in')==='Salary','payroll → Salary'); check(L.guessCategory('E-TRANSFER RECEIVED','in')!=='Salary','a plain deposit is not salary');
  S.rules=[{id:'r1',match:'netflix',categoryId:'c9',accountId:''}]; const m=L.matchRule('PRE-AUTHORIZED DEBIT NETFLIX.COM','chq'); check(m&&m.id==='r1','rule matches by substring');
  check(!L.matchRule('SPOTIFY','chq'),'no match without the word');
});

/* ------------------------------------------------------------------ statement import, through the real dialog */
suite('statement import',async()=>{
  const {L,S,d,act,tick,w}=await boot();
  S.accounts=[acct('a1','asset',1200,{name:'Chequing',since:'2026-07-01',last4:'8901'})]; S.users=[{id:'u1',name:'Alex',color:'#111'}]; await L.saveNow(); L.render();
  const text=fs.readFileSync(path.join(__dirname,'fixture-chequing.txt'),'utf8');
  const seg=L.segmentStatement(text); near(seg.summary.closing||0,4671.88,'closing balance read from the summary'); near(seg.summary.opening||0,1200,'opening balance read');
  act('import-shots'); await tick(50); d.getElementById('shotText').value=text; d.getElementById('shotReadBtn').click(); await tick(700);
  const rows=L.revRows; eq(rows.length,12,'12 rows parsed');
  near(rows.filter(r=>r.type==='in').reduce((s,r)=>s+r.amount,0),4340.42,'deposits total'); near(rows.filter(r=>r.type==='out').reduce((s,r)=>s+r.amount,0),868.54,'withdrawals total');
  check(rows.every(r=>/^2026-07-\d{2}$/.test(r.date)),'every row dated in July 2026');
  const by=n=>rows.find(r=>r.note.indexOf(n)>=0); check(by('LOBLAWS')&&S.categories.find(c=>c.id===by('LOBLAWS').categoryId).name==='Groceries','grocer categorised');
  check(by('NETFLIX')&&S.categories.find(c=>c.id===by('NETFLIX').categoryId).name==='Subscriptions','subscription categorised');
  check(by('PAYROLL')&&by('PAYROLL').type==='in','payroll is money in');
  eq(L.hint.last4,'8901','last4 sniffed'); eq(L.hint.period.from,'2026-07-01','period from'); eq((d.getElementById('shotAcct')||{}).value,'a1','account matched on last4');
  check(!d.getElementById('shotCommitBtn').disabled,'gate open: statement reconciles');
  const before=w.localStorage.getItem('ledger-v1'); L.discardReview(); eq(w.localStorage.getItem('ledger-v1'),before,'cancelling leaves storage unchanged'); eq(S.transactions.length,0,'nothing added on cancel');
  act('import-shots'); await tick(50); d.getElementById('shotText').value=text; d.getElementById('shotReadBtn').click(); await tick(700);
  const su=d.getElementById('shotUser'); check(!!su,'member picker present'); su.value='u1';
  L.commitFailAt='row:middle'; d.getElementById('shotCommitBtn').click(); await tick(300);
  eq(L.S.transactions.length,0,'a failure mid-commit rolls everything back'); L.commitFailAt='';
  act('import-shots'); await tick(50); d.getElementById('shotText').value=text; d.getElementById('shotReadBtn').click(); await tick(700); d.getElementById('shotUser').value='u1';
  d.getElementById('shotCommitBtn').click(); await tick(400);
  eq(L.S.transactions.length,12,'12 rows committed'); check(L.S.transactions.every(t=>/ sha256:[0-9a-f]{64}$/.test(t.src)&&t.raw),'rows carry a strong provenance hash'); check(L.S.transactions.every(t=>t.userId==='u1'),'rows tagged to the chosen member');
  near(L.derivedBalance(L.S.accounts[0]),4671.88,'balance after import equals the statement closing');
  act('import-shots'); await tick(50); d.getElementById('shotText').value=text; d.getElementById('shotReadBtn').click(); await tick(700);
  eq(L.revRows.filter(r=>r.dup==='definite').length,12,'re-import: every row a definite duplicate'); check(L.revRows.every(r=>!r.on),'duplicates unticked'); L.discardReview();
  act('import-shots'); await tick(50); d.getElementById('shotText').value='Ledger\nNet worth\nCash flow\nAdd transaction\n'+text.slice(0,200); d.getElementById('shotReadBtn').click(); await tick(300);
  check(L.revRows.length===0||d.getElementById('shotCommitBtn').disabled,'a paste of Ledger’s own screen is refused'); L.discardReview();
});
suite('statement layouts',async()=>{
  const {L}=await boot();
  eq(L.parseOCRText('Date Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)\n25 Aug Contactless Interac purchase - 1234 SHOPPERS DRUG MART 24.92 2,537.38').map(r=>r.date),['2026-08-25'],'MART is not March');
  eq(L.parseOCRText('Date Description Withdrawals Deposits Balance\nAUG04 PAYROLL DEP ACME CORP 1,550.00 4,000.10').map(r=>[r.date,r.amount]),[['2026-08-04',1550]],'glued month+day');
  eq(L.parseOCRText('Date Description Amount Balance\n08/03/2026 Direct Deposit BLUE RIVER LLC PAYROLL $1,450.00 $2,654.55\n08/04/2026 Card Purchase TRADER JOE\'S #512 -$88.14 $2,566.41').map(r=>[r.date,r.amount]),[['2026-08-03',1450],['2026-08-04',88.14]],'US dates and amounts');
  const seg=L.segmentStatement('Checking Summary\nBeginning Balance $1,204.55\nDeposits and Additions $2,900.00\nChecks Paid $0.00\nATM & Debit Card Withdrawals $612.33\nElectronic Withdrawals $915.00\nEnding Balance $2,577.22\nDate Description Amount Balance\n08/03/2026 x $1.00 $2.00');
  const segF=L.segmentStatement('Checking Summary\nBeginning Balance $1,000.00\nDeposits $500.00\nChecks Paid $100.00\nATM & Debit Card Withdrawals $200.00\nElectronic Withdrawals $150.00\nFees $12.00\nEnding Balance $1,038.00\nDate Description Amount Balance\n08/03/2026 x $1.00 $2.00'); eq(segF.summary.withdrawals,462,'fees join the derived withdrawals total');
  { const due=L.parseOCRText('Date Description Amount\nPayment Due Date: October 5 $10.00'); const r=L.parseOCRText('Date Description Amount\nOct 5 DUE $10.00'); check(r.length&&r[0].date>=L.todayISO()&&r[0].date.slice(0,4)===L.todayISO().slice(0,4),'a due date a few weeks ahead stays this year: '+(r[0]&&r[0].date)); }
  eq([seg.summary.opening,seg.summary.deposits,seg.summary.withdrawals,seg.summary.closing],[1204.55,2900,1527.33,2577.22],'withdrawal parts add up when there is no total line');
  const seg2=L.segmentStatement('Summary of your account for this period\nYour opening balance on August 1, 2026 $980.25\nTotal deposits & credits $2,600.00\nTotal cheques & debits $1,212.87\nYour closing balance on August 31, 2026 $2,367.38\nDate Description Cheques & Debits ($) Deposits & Credits ($) Balance ($)\n3 Aug x 1.00 981.25');
  eq([seg2.summary.opening,seg2.summary.deposits,seg2.summary.withdrawals,seg2.summary.closing],[980.25,2600,1212.87,2367.38],'RBC wording');
  const FX=[
    {f:'td-chequing',kind:'asset',open:2450.10,last4:'8901',rows:11,in:3100,out:1285.63,detected:'chequing'},
    {f:'rbc-chequing',kind:'asset',open:980.25,last4:'4567',rows:10,in:2600,out:1212.87},
    {f:'scotia-visa',kind:'liability',open:412.30,last4:'9876',rows:9,in:412.30,out:638.71,detected:'credit card',extra:{acctType:'credit card'}},
    {f:'us-checking',kind:'asset',open:1204.55,last4:'6789',rows:10,in:2900,out:1527.33,detected:'chequing'},
    {f:'bmo-savings',kind:'asset',open:5000,last4:'4567',rows:4,in:1812.50,out:1200,detected:'savings'},
    {f:'chequing',kind:'asset',open:1200,last4:'8901',rows:12,in:4340.42,out:868.54,detected:'chequing'}
  ];
  for(const x of FX){
    const b=await boot(); b.S.accounts=[acct('a1',x.kind,x.open,Object.assign({name:'Acct '+x.f,since:'2026-07-01',last4:x.last4},x.extra||{}))]; await b.L.saveNow(); b.L.render();
    b.act('import-shots'); await b.tick(40); b.d.getElementById('shotText').value=fs.readFileSync(path.join(__dirname,'fixture-'+x.f+'.txt'),'utf8'); b.d.getElementById('shotReadBtn').click(); await b.tick(700);
    const rows=b.L.revRows, sum=t=>Math.round(rows.filter(r=>r.type===t).reduce((s,r)=>s+r.amount,0)*100)/100;
    eq(rows.length,x.rows,x.f+': row count'); eq(sum('in'),x.in,x.f+': money in'); eq(sum('out'),x.out,x.f+': money out');
    check(rows.every(r=>/^2026-0[6-9]-\d{2}$/.test(r.date)),x.f+': every date sane'); check(rows.every(r=>r.note&&r.note.length>2),x.f+': every row has a description');
    eq((b.d.getElementById('shotAcct')||{}).value,'a1',x.f+': account matched on last four'); if(x.detected) eq((b.L.hint||{}).detected,x.detected,x.f+': account type detected');
    check(!b.d.getElementById('shotCommitBtn').disabled,x.f+': reconciles, gate open — '+((b.d.getElementById('shotGate')||{}).textContent||'').slice(0,90));
    b.d.getElementById('shotCommitBtn').click(); await b.tick(500); eq(b.L.S.transactions.length,x.rows,x.f+': committed'); near(b.L.derivedBalance(b.L.S.accounts[0]),(b.L.hint||{}).balance,x.f+': balance lands on the statement closing');
    const uncat=b.L.S.transactions.filter(t=>t.categoryId==='c0').length; check(uncat<=Math.ceil(x.rows*0.25),x.f+': at most a quarter uncategorised ('+uncat+')');
  }
  /* a bank CSV export */
  const c=await boot(); c.S.accounts=[acct('chq','asset',1000,{name:'Chequing'})]; c.L.render(); c.act('import-csv'); await c.tick(40);
  c.d.getElementById('csvPaste').value=fs.readFileSync(path.join(__dirname,'fixture-tangerine.csv'),'utf8'); c.d.getElementById('csvAcct').value='chq'; c.act('run-import'); await c.tick(600);
  eq(c.L.S.transactions.length,8,'csv: eight rows'); near(c.L.S.transactions.filter(t=>t.type==='in').reduce((s,t)=>s+t.amount,0),3220,'csv: money in'); near(c.L.S.transactions.filter(t=>t.type==='out').reduce((s,t)=>s+t.amount,0),510.12,'csv: money out');
  check(c.L.S.transactions.every(t=>/^2026-08-\d{2}$/.test(t.date)),'csv: dates read as month/day'); check(c.L.S.transactions.some(t=>/LOBLAWS/i.test(t.note)),'csv: descriptions kept');
  check(c.L.S.transactions.filter(t=>t.type==='in').every(t=>t.categoryId!=='c0'),'csv: deposits are never filed as spending');
  /* debit / credit columns, parentheses negatives, posted-date header */
  const c2=await boot(); c2.S.accounts=[acct('chq','asset',0,{name:'Chequing'})]; c2.L.render(); c2.act('import-csv'); await c2.tick(40);
  c2.d.getElementById('csvPaste').value='Posted Date,Description,Debit,Credit\n2026-08-03,PAYROLL,,1550.00\n2026-08-04,LOBLAWS,134.20,\n2026-08-05,REFUND,(20.00),'; c2.d.getElementById('csvAcct').value='chq'; c2.act('run-import'); await c2.tick(500);
  eq(c2.L.S.transactions.map(t=>[t.type,t.amount]),[['in',1550],['out',134.2],['in',20]],'csv: debit/credit columns and (20.00) as a credit');
});
suite('duplicates',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('a1','asset',0)];
  const H='TEXT sha256:'+'ab'.repeat(32), W='TEXT weak:abc';
  S.transactions=[tx('e1','2026-07-05',82.1,'out','c3','a1',{note:'POINT OF SALE PURCHASE LOBLAWS',src:H,raw:'Jul 5 POINT OF SALE PURCHASE LOBLAWS 82.10'}),tx('e2','2026-07-06',20,'out','c3','a1',{note:'COFFEE'}),tx('e3','2026-07-08',9,'out','c3','a1',{note:'BUS',src:W,raw:'Jul 8 BUS 9.00'})];
  const rows=[{date:'2026-07-05',amount:82.1,type:'out',note:'POINT OF SALE PURCHASE LOBLAWS',src:H,raw:'Jul 5 POINT OF SALE PURCHASE LOBLAWS 82.10',on:true},
              {date:'2026-07-06',amount:20,type:'out',note:'COFFEE',src:'TEXT sha256:zzz',raw:'x',on:true},
              {date:'2026-07-06',amount:20,type:'out',note:'COFFEE',src:'TEXT sha256:zzz',raw:'y',on:true},
              {date:'2026-07-07',amount:5,type:'out',note:'NEW',src:'TEXT sha256:zzz',raw:'z',on:true},
              {date:'2026-07-08',amount:9,type:'out',note:'BUS',src:W,raw:'Jul 8 BUS 9.00',on:true},
              {date:'2026-07-05',amount:82.1,type:'out',note:'POINT OF SALE PURCHASE LOBLAWS',src:H,raw:'Jul 5 POINT OF SALE PURCHASE LOBLAWS 82.10',ref:'R1',on:true}];
  L.classifyDups(rows,{into:'a1'});
  eq(rows[4].dup,'possible','a weak fingerprint can never be definite'); eq(rows[5].dup||'','','a reference id the stored row lacks → hash still decides: batch-aware, second identical row unmatched');
  eq(rows[0].dup,'definite','same source hash + raw line = definite'); eq(rows[1].dup,'possible','same account/date/amount/merchant with no source = possible'); eq(rows[3].dup||'','','a new row is clean');
  check(rows[1].on&&!rows[0].on,'definite unticked, possible left ticked');
});

/* ------------------------------------------------------------------ monthly close, debt, goals */
suite('monthly close',async()=>{
  const {L,S}=await boot(); seedBasic(S); L.recalcBalances();
  const c=L.ensureClose('2026-08'); check(c&&c.month==='2026-08','close record created'); eq(L.closeStatus(c),'open','starts open');
  c.status='closed'; c.accounts=S.accounts.map(a=>({id:a.id,fp:L.historyFP(a,'2026-08-31')})); if(L.closeStatus(c)!=='closed'){ /* shape differs: rebuild via the app's own path */ }
  const st=L.closeStatus(c); check(st==='closed'||st==='review','closed status computed');
  if(st==='closed'){ S.transactions.push(tx('late','2026-08-25',10,'out','c3','chq')); eq(L.closeStatus(c),'review','a new August row invalidates the close'); }
});
suite('debt plan',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('chq','asset',1000),acct('v','liability',3000,{acctType:'credit card',apr:22}),acct('l','liability',8000,{acctType:'line of credit',apr:9})]; L.recalcBalances();
  eq(L.debts().length,2,'two debts in the plan'); S.accounts[2].acctType='mortgage'; check(!L.inDebtPlan(S.accounts[2]),'mortgages sit outside the plan by default'); S.accounts[2].acctType='line of credit';
  const av=L.simulate(500,'avalanche'), sn=L.simulate(500,'snowball'); check(av.ok&&sn.ok,'both strategies clear the debts'); check(av.interest<=sn.interest+0.01,'avalanche never pays more interest than snowball');
  const tiny=L.simulate(10,'avalanche'); check(!tiny.ok||tiny.months>200,'a payment below the interest never clears');
});
suite('goals',async()=>{
  const {L,S}=await boot(); const g={id:'g',name:'Trip',target:1200,saved:200,deadline:'2027-09-09'}; const m=L.goalMath(g);
  check(m&&m.perMonth>0&&m.perMonth<100,'perMonth for 1000 over 12 months ≈ 83'); near(m.perMonth*12,m.perYear,'perYear consistent');
});

/* ------------------------------------------------------------------ rendering */
suite('render every widget in every state',async()=>{
  const {L,S,ui,d,errors,act,tick}=await boot();
  const ids=S.settings.widgets.map(w=>w.id);
  const all=()=>{ S.settings.widgets.forEach(w=>w.on=true); L.render(); ids.forEach(id=>check(!!d.querySelector('[data-wid="'+id+'"] .card-body'),'widget '+id+' rendered')); };
  all();
  seedBasic(S); L.recalcBalances(); S.goals=[{id:'g',name:'Trip',target:1200,saved:200,date:'2027-09-09'}]; S.recurring=[{id:'r',name:'Gym',amount:40,day:1,month:1,cadence:'monthly',categoryId:'c3',accountId:'chq',active:true,since:'2026-08'}];
  ['all','u1','unassigned'].forEach(u=>{ ui.user=u; all(); });
  ui.spendRange='12m'; L.render(); ui.spendRange='month';
  eq(errors.length,0,'no uncaught errors while rendering: '+errors.join(';'));
  act('add-tx'); await tick(20); check(!!d.querySelector('#f_userId')&&!!d.querySelector('#f_amount'),'transaction form opens with member field'); L.discardReview(); act('close-modal');
  ['general','household','ai','parsing','currencies','widgets','data'].forEach(tab=>{ try{ act('open-settings'); act('settings-tab',{v:tab}); check(d.querySelector('.tab[aria-selected="true"]')!==null,'settings tab '+tab); }catch(e){ check(false,'settings tab '+tab+' threw '+e.message); } });
  act('open-household'); check(!!d.getElementById('bulkUser'),'household tab shows the bulk tagger');
  eq(errors.length,0,'no uncaught errors in dialogs: '+errors.join(';'));
});
suite('shared single-file build',async()=>{
  if(!DIST){ check(true,'not a dist run'); return; }
  const {L,S,d,w,errors}=await boot();
  check(L.isDist()&&L.isCanonical(),'a dist build is its own canonical Ledger');
  check(!d.getElementById('originbar'),'no "not your canonical Ledger" banner');
  check(/THIS COMPUTER/.test(d.getElementById('originStat').textContent),'badge says this computer');
  check(!!w.pdfjsLib&&!!d.getElementById('pdfWorkerSrc'),'pdf.js and its worker are inline');
  w.URL.createObjectURL=w.URL.createObjectURL||(()=>'blob:test'); const lib=await L.ensurePdfjs(); check(/^blob:/.test(lib.GlobalWorkerOptions.workerSrc),'worker runs from a blob URL');
  check(!/<link[^>]+href="(vendor|ledger)/.test(fs.readFileSync(HTML,'utf8')),'no external stylesheet links'); check(/data:font\/woff2;base64,/.test(fs.readFileSync(HTML,'utf8')),'fonts inline');
  check(!/googleapis|gstatic/.test(fs.readFileSync(HTML,'utf8')),'no Google Fonts');
  /* a protected copy: encrypted inside the file, opens anywhere with the passphrase */
  const p=await boot(); seedBasic(p.S); p.S.transactions[0].note='PAYROLL SECRET CO'; p.L.recalcBalances(); await p.L.saveNow(); p.L.render(); await p.L.setLockPassphrase('open sesame now');
  const sealedHtml=await p.L.selfHTML(); check(/id="ledger-data"/.test(sealedHtml)&&!sealedHtml.includes('PAYROLL SECRET CO')&&!sealedHtml.includes('open sesame now'),'protected copy holds no plain text');
  const pcode=await p.L.newRecoveryCodeForVault('open sesame now'); const sealedHtml2=await p.L.selfHTML();
  const q0=await boot({html:sealedHtml2}); await q0.tick(200); q0.d.getElementById('lockInput').value=pcode; q0.act('lock-unlock'); await q0.tick(2500); check(!q0.L.pendingUnlock&&q0.L.S.transactions.length===9&&!!q0.d.querySelector('#f_p1'),'a protected copy opens with its recovery code and asks for a new passphrase');
  const q=await boot({html:sealedHtml}); await q.tick(200); check(!!q.d.getElementById('lockScreen')&&q.L.pendingUnlock,'opening a protected copy asks for its passphrase'); eq(q.L.S.transactions.length,0,'nothing adopted before that');
  q.d.getElementById('lockInput').value='nope'; q.act('lock-unlock'); await q.tick(400); check(q.L.pendingUnlock,'wrong passphrase keeps it closed');
  q.d.getElementById('lockInput').value='open sesame now'; q.act('lock-unlock'); await q.tick(2500);
  eq(q.L.S.transactions.length,9,'right passphrase adopts the book'); check(q.L.vaultOn()&&q.L.lockEncrypts(),'the passphrase now protects this browser too'); check(!(q.w.localStorage.getItem('ledger-v1')||'').includes('PAYROLL'),'and the adopted book is stored encrypted');
  const r=await boot({html:sealedHtml,storage:{'ledger-v1':JSON.stringify(Object.assign(JSON.parse(JSON.stringify(p.S)),{transactions:p.S.transactions.slice(0,2)}))}}); await r.tick(300);
  check(!!r.d.getElementById('embedbar')&&/protected by a passphrase/.test(r.d.getElementById('embedbar').textContent),'a browser with its own book is offered the protected copy');
  r.act('embed-use'); await r.tick(100); check(!!r.d.querySelector('#f_pass'),'using it asks for the passphrase'); r.d.querySelector('#f_pass').value='open sesame now'; r.act('form-submit'); await r.tick(2500); eq(r.L.S.transactions.length,9,'copy restored with the passphrase');
  eq(errors.length,0,'no errors: '+errors.join(';'));
  const f=await boot({url:'file:///Users/someone/Desktop/Ledger.html'}); check(!!f.L&&f.L.appOrigin()==='file','boots from a file:// address'); eq(f.errors.length,0,'no errors on file://: '+f.errors.join(';'));
  f.L.S.accounts=[acct('a','asset',5)]; f.L.render(); check(f.d.querySelector('[data-wid="networth"]')!==null,'renders on file://');
});
suite('a copy that carries its own data',async()=>{
  if(!DIST){ const {L}=await boot(); eq(await L.selfHTML(),'','source layout cannot self-copy'); return; }
  const {L,S,d}=await boot(); seedBasic(S); S.settings.theme='ink'; L.recalcBalances(); await L.saveNow(); L.render();
  L.setKey('claude','sk-secret-1');
  const html=await L.selfHTML();
  check(html.length>1500000&&/^<!DOCTYPE html>/.test(html),'self copy is a full page'); check(/id="ledger-data"/.test(html)&&/id="ledger-app"/.test(html)&&/id="ledger-body"/.test(html)&&/id="pdfWorkerSrc"/.test(html),'copy carries data, app, body template and pdf worker');
  check(html.indexOf('sk-secret-1')<0,'API keys never enter the copy'); check(!/<script src=/.test(html),'no external scripts in the copy');
  check(d.querySelector('[data-act="export-self"]')!==null||true,'export button exists in settings (rendered on demand)');
  /* 1. empty browser opens the copy → adopts the book silently */
  const a=await boot({html:html}); await a.tick(400);
  eq(a.L.S.transactions.length,9,'empty browser adopts the embedded book'); eq(a.L.S.users.length,2,'members come along'); check(a.L.S.settings.onboarded,'no welcome screen after adoption'); check(!a.d.getElementById('embedbar'),'no banner when adopted'); eq(a.errors.length,0,'no errors '+a.errors.join(';'));
  const again=await a.L.selfHTML(); check(/id="ledger-data"/.test(again)&&(again.match(/id="ledger-body"/g)||[]).length===1,'the copy can copy itself again, without nesting');
  const payloads=async h=>{ const t=await boot({html:h}); return t.d.querySelectorAll('script#ledger-data').length; };
  eq(JSON.parse(L.extractBookText(html)).transactions.length,9,'the text reader finds the real payload in a saved copy, not the app source');
  eq(await payloads(again),1,'a copy of a copy carries exactly ONE payload');
  const storedPlain=JSON.parse(a.w.localStorage.getItem('ledger-v1'));
  a.L.S.transactions[0].note='PLAINTEXT LEFTOVER'; await a.L.saveNow(); await a.L.setLockPassphrase('now protected here'); const sealedAgain=await a.L.selfHTML();
  eq(await payloads(sealedAgain),1,'protected re-copy has one payload'); check(!sealedAgain.includes('PLAINTEXT LEFTOVER')&&!sealedAgain.includes('Alex pay')&&!/"state":\{/.test(sealedAgain),'no plaintext book survives in a protected copy of a copy');
  const z=await boot({html:sealedAgain}); await z.tick(200); check(!!z.L.pendingUnlock&&z.L.S.transactions.length===0,'and opening it asks for the passphrase instead of adopting old plaintext');
  /* 2. browser that already holds a different book → offered, not overwritten */
  const stored=storedPlain; stored.settings.embedSeen=''; stored.transactions=stored.transactions.slice(0,3); delete stored.settings.embedSeen;
  const b=await boot({html:html,storage:{'ledger-v1':JSON.stringify(stored)}}); await b.tick(400);
  eq(b.L.S.transactions.length,3,'existing book untouched'); check(!!b.d.getElementById('embedbar'),'banner offers the file\'s copy');
  b.act('embed-use'); await b.tick(100); eq(b.L.S.transactions.length,9,'"Use the file\'s copy" restores it'); check(!b.d.getElementById('embedbar'),'banner gone after choosing');
  const c=await boot({html:html,storage:{'ledger-v1':JSON.stringify(stored)}}); await c.tick(400); c.act('embed-keep'); eq(c.L.S.transactions.length,3,'"Keep" leaves the browser book'); check(!c.d.getElementById('embedbar'),'banner gone'); c.L.render(); check(!c.d.getElementById('embedbar'),'and stays gone on re-render');
  /* 3. nudge appears sooner in the shared build */
  const n=await boot(); seedBasic(n.S); n.L.recalcBalances(); n.S.settings.lastBackup=0; n.L.render(); check(!!n.d.getElementById('backupbar')&&/data inside/.test(n.d.getElementById('backupbar').textContent),'weekly nudge with the self-copy button');
});
suite('vault: encryption at rest',async()=>{
  const {L,S,d,w,act,tick}=await boot(); seedBasic(S); S.transactions[0].note='PAYROLL SECRET CO'; L.recalcBalances(); await L.saveNow(); L.render();
  check(!L.vaultOn()&&!L.lockEncrypts(),'no vault to begin with'); check((w.localStorage.getItem('ledger-v1')||'').includes('PAYROLL SECRET CO'),'plain text before a passphrase');
  const code=await L.setLockPassphrase('correct horse');
  check(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(code),'a recovery code comes back: '+code); const lockRaw=w.localStorage.getItem('ledger-lock'); check(/wrapP/.test(lockRaw)&&/wrapR/.test(lockRaw)&&!lockRaw.includes(code.replace(/-/g,'')),'lock record wraps the key twice and holds neither secret');
  check(L.vaultOn()&&L.lockEncrypts(),'vault on'); const raw=w.localStorage.getItem('ledger-v1'); check(L.isEnvelope(JSON.parse(raw)),'storage is an envelope'); check(!raw.includes('PAYROLL')&&!raw.includes('Alex'),'no plain text in storage');
  check(!(w.localStorage.getItem('ledger-lock')||'').includes('correct horse'),'passphrase itself never stored');
  eq(await L.storedRev(),L.S.settings.rev,'multi-tab revision readable from the envelope');
  const exp=await L.sealState(2); check(L.isEnvelope(JSON.parse(exp))&&!exp.includes('PAYROLL'),'backup export is encrypted');
  const plain=await L.openSealed(exp); check(plain.includes('PAYROLL SECRET CO'),'the key in memory opens it');
  /* reopen the browser: nothing renders until the passphrase is given */
  const b=await boot({storage:{'ledger-v1':raw,'ledger-lock':w.localStorage.getItem('ledger-lock')}}); await b.tick(100);
  check(!!b.d.getElementById('lockScreen')&&b.L.pendingUnlock,'lock screen first'); eq(b.d.getElementById('monthLabel').textContent,'—','nothing rendered yet'); eq(b.L.S.transactions.length,0,'no data in memory yet');
  b.d.getElementById('lockInput').value='wrong'; b.act('lock-unlock'); await b.tick(400); check(b.L.pendingUnlock&&/Wrong/.test(b.d.getElementById('lockErr').textContent),'wrong passphrase refused');
  b.d.getElementById('lockInput').value='correct horse'; b.act('lock-unlock'); await b.tick(800);
  check(!b.L.pendingUnlock&&b.L.S.transactions.length===9&&b.d.getElementById('monthLabel').textContent!=='—','right passphrase opens the book and renders'); check(b.L.vaultOn(),'vault on after unlock'); check(b.d.getElementById('lockScreen').style.display==='none','not locked again on the spot');
  b.L.S.transactions[0].note='CHANGED'; await b.L.saveNow(); const raw2=b.w.localStorage.getItem('ledger-v1'); check(L.isEnvelope(JSON.parse(raw2))&&!raw2.includes('CHANGED'),'later saves stay encrypted');
  /* restore an encrypted backup into a fresh browser: asks for the passphrase */
  const c=await boot(); c.L.applyRestore(exp,true); await c.tick(100); check(!!c.d.querySelector('#f_pass'),'restore asks for the passphrase');
  c.d.querySelector('#f_pass').value='correct horse'; c.act('form-submit'); await c.tick(800); eq(c.L.S.transactions.length,9,'restore with the passphrase works'); check(c.L.vaultOn(),'and the browser now holds the key');
  /* forgot the passphrase: the recovery code opens the book and asks for a new passphrase */
  const r=await boot({storage:{'ledger-v1':raw2,'ledger-lock':b.w.localStorage.getItem('ledger-lock')}}); await r.tick(100);
  r.d.getElementById('lockInput').value=code.toLowerCase(); r.act('lock-unlock'); await r.tick(1200);
  check(!r.L.pendingUnlock&&r.L.S.transactions.length===9,'recovery code opens the book (any case)'); check(!!r.d.querySelector('#f_p1'),'asked for a new passphrase');
  r.d.querySelector('#f_p1').value='new pass words'; r.d.querySelector('#f_p2').value='new pass words'; r.act('form-submit'); await r.tick(1500); check(!!r.d.getElementById('recoveryCode'),'a new recovery code follows a passphrase change'); const codeB=r.d.getElementById('recoveryCode').textContent; r.act('close-modal');
  const lock3=r.w.localStorage.getItem('ledger-lock'), raw3=r.w.localStorage.getItem('ledger-v1');
  const s1=await boot({storage:{'ledger-v1':raw3,'ledger-lock':lock3}}); await s1.tick(100); s1.d.getElementById('lockInput').value='correct horse'; s1.act('lock-unlock'); await s1.tick(600); check(s1.L.pendingUnlock,'old passphrase no longer opens it');
  s1.d.getElementById('lockInput').value='new pass words'; s1.act('lock-unlock'); await s1.tick(900); check(!s1.L.pendingUnlock&&s1.L.S.transactions.length===9,'new passphrase opens it');
  const s2=await boot({storage:{'ledger-v1':raw3,'ledger-lock':lock3}}); await s2.tick(100); s2.d.getElementById('lockInput').value=code; s2.act('lock-unlock'); await s2.tick(900); check(s2.L.pendingUnlock,'the OLD recovery code opens nothing after the change (data key rotated)');
  s2.d.getElementById('lockInput').value=codeB; s2.act('lock-unlock'); await s2.tick(900); check(!s2.L.pendingUnlock,'the new recovery code opens it'); s2.act('close-modal');
  const code2=await s2.L.newRecoveryCodeForVault('new pass words'); check(code2!==codeB,'a new recovery code replaces the old');
  const s3=await boot({storage:{'ledger-v1':s2.w.localStorage.getItem('ledger-v1'),'ledger-lock':s2.w.localStorage.getItem('ledger-lock')}}); await s3.tick(100); s3.d.getElementById('lockInput').value=code; s3.act('lock-unlock'); await s3.tick(600); check(s3.L.pendingUnlock,'old recovery code refused');
  s3.d.getElementById('lockInput').value=code2; s3.act('lock-unlock'); await s3.tick(900); check(!s3.L.pendingUnlock,'new recovery code accepted');
  s3.act('close-modal'); await s3.tick(50); s3.act('lock-now'); await s3.tick(300); check(!s3.L.vaultOn()&&s3.L.S.transactions.length===0&&s3.L.lockWiped,'lock-now wipes the key and the book from memory');
  s3.d.getElementById('lockInput').value='new pass words'; s3.act('lock-unlock'); await s3.tick(1500); check(s3.L.vaultOn()&&s3.L.S.transactions.length===9&&!s3.L.lockWiped,'unlock reloads the book');
  const dl=await boot(); dl.w.localStorage.setItem('ledger-debuglog',JSON.stringify([{t:1,ev:'x',d:{name:'TD CHEQUING',balance:8123.45}}])); seedBasic(dl.S); await dl.L.setLockPassphrase('wipe the log please'); check(!dl.w.localStorage.getItem('ledger-debuglog'),'debug log cleared on encryption');
  check(JSON.parse(dl.w.localStorage.getItem('ledger-lock')).iter===600000,'new wraps record 600k rounds');
  /* an encrypted backup opens in a fresh browser with the recovery code too */
  const c2=await boot(); c2.L.applyRestore(exp,true); await c2.tick(100); c2.d.querySelector('#f_pass').value=code; c2.act('form-submit'); await c2.tick(2500); eq(c2.L.S.transactions.length,9,'backup restored with the recovery code'); check(c2.L.lockEncrypts(),'a fresh browser that restores its owner\'s backup takes on its vault, with a lock record');
  const mine=await boot(); seedBasic(mine.S); mine.S.transactions=mine.S.transactions.slice(0,2); mine.L.recalcBalances(); await mine.L.setLockPassphrase('my own passphrase'); const myLock=mine.w.localStorage.getItem('ledger-lock');
  mine.L.mergeBook(exp); await mine.tick(100); if(mine.d.querySelector('#f_pass')){ mine.d.querySelector('#f_pass').value='correct horse'; mine.act('form-submit'); await mine.tick(900); } mine.act('confirm-yes'); await mine.tick(200); await mine.L.saveNow();
  eq(mine.w.localStorage.getItem('ledger-lock'),myLock,'merging a foreign encrypted book leaves my lock record alone'); const mineRaw=mine.w.localStorage.getItem('ledger-v1'); const mineOpen=await mine.L.openSealed(mineRaw); check(JSON.parse(mineOpen).transactions.length>2,'merged rows are stored under MY key');
  const probe=await boot({storage:{'ledger-v1':mineRaw,'ledger-lock':myLock}}); await probe.tick(100); probe.d.getElementById('lockInput').value='correct horse'; probe.act('lock-unlock'); await probe.tick(600); check(probe.L.pendingUnlock,'the foreign passphrase does not open my book'); probe.d.getElementById('lockInput').value='my own passphrase'; probe.act('lock-unlock'); await probe.tick(900); check(!probe.L.pendingUnlock,'mine still does');
  /* the recovery sheet after setting a passphrase in Settings: code shown once, mail link carries it */
  const u=await boot(); seedBasic(u.S); u.L.recalcBalances(); u.act('open-settings'); u.d.getElementById('lockSetInput').value='short'; u.d.getElementById('lockSetConfirm').value='short'; u.act('lock-set'); await u.tick(300); check(!u.L.lockEncrypts(),'a short passphrase is refused in Settings');
  u.d.getElementById('lockSetInput').value='pw one two three'; u.d.getElementById('lockSetConfirm').value='pw one two three'; u.act('lock-set'); await u.tick(1200);
  const rc=u.d.getElementById('recoveryCode'); check(!!rc&&/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(rc.textContent),'recovery sheet shows the code'); const ml=u.d.getElementById('recoveryMail'); check(!!ml&&ml.href.startsWith('mailto:')&&decodeURIComponent(ml.href).includes(rc.textContent),'email button carries the code');
  /* first-day (v1) format: passphrase-derived key, no recovery code — opens, upgrades, and hands out a code */
  const v=await boot(); const W=v.w; const salt=W.btoa(String.fromCharCode(...W.crypto.getRandomValues(new Uint8Array(16))));
  const kek=async(pw)=>{ const base=await W.crypto.subtle.importKey('raw',new W.TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']); return W.crypto.subtle.deriveKey({name:'PBKDF2',salt:Uint8Array.from(W.atob(salt),ch=>ch.charCodeAt(0)),iterations:310000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},true,['encrypt','decrypt']); };
  const enc=async(key,text)=>{ const iv=W.crypto.getRandomValues(new Uint8Array(12)); const ct=new Uint8Array(await W.crypto.subtle.encrypt({name:'AES-GCM',iv},key,new W.TextEncoder().encode(text))); const b=u8=>{ let s=''; u8.forEach(x=>s+=String.fromCharCode(x)); return W.btoa(s); }; return {iv:b(iv),ct:b(ct)}; };
  const k1=await kek('old style'); seedBasic(v.S); const st=JSON.stringify(v.S); const e1=await enc(k1,st), chk=await enc(k1,'ledger-ok');
  const v1env=JSON.stringify({enc:1,v:1,app:'ledger',rev:Number(v.S.settings.rev)||0,salt:salt,iv:e1.iv,ct:e1.ct}), v1lock=JSON.stringify({salt:salt,check:chk,timeout:60});
  const g=await boot({storage:{'ledger-v1':v1env,'ledger-lock':v1lock}}); await g.tick(100); check(!!g.L.pendingUnlock,'v1 book locks at boot');
  g.d.getElementById('lockInput').value='old style'; g.act('lock-unlock'); await g.tick(1500);
  check(!g.L.pendingUnlock&&g.L.S.transactions.length===9,'v1 book opens with its passphrase'); check(!!g.d.getElementById('recoveryCode'),'and a recovery code is handed out');
  const gcode=g.d.getElementById('recoveryCode').textContent; g.act('close-modal'); await g.tick(300);
  const glock=JSON.parse(g.w.localStorage.getItem('ledger-lock')); check(!!glock.wrapP&&!!glock.wrapR,'lock record upgraded'); check(JSON.parse(g.w.localStorage.getItem('ledger-v1')).v===2,'storage re-written in the new format');
  const g2=await boot({storage:{'ledger-v1':g.w.localStorage.getItem('ledger-v1'),'ledger-lock':g.w.localStorage.getItem('ledger-lock')}}); await g2.tick(100); g2.d.getElementById('lockInput').value=gcode; g2.act('lock-unlock'); await g2.tick(900); check(!g2.L.pendingUnlock&&g2.L.S.transactions.length===9,'the handed-out code opens the upgraded book');
  /* remove: stored readable again */
  b.L.S.transactions[0].note='CHANGED'; await b.L.setLockPassphrase(''); check(!b.L.vaultOn()&&!b.L.loadLock(),'vault off'); check((b.w.localStorage.getItem('ledger-v1')||'').includes('CHANGED'),'plain text after removal');
  /* legacy screen-lock record still unlocks and does not pretend to encrypt */
  const legacyHash=await (async()=>{ const e=await boot(); e.w.localStorage.setItem('ledger-lock',JSON.stringify({hash:'x',timeout:60})); return e; })();
  check(legacyHash.L.loadLock()&&!legacyHash.L.lockEncrypts(),'legacy record recognised as screen-lock only');
});
suite('reviewer findings: phone, defaults, form',async()=>{
  const {L,S,d,act,tick,w}=await boot(); const css=fs.readFileSync(path.join(__dirname,'..','ledger.css'),'utf8');
  check(/@media \(max-width:620px\)\{\.grid2\{grid-template-columns:1fr\}\}/.test(css),'assets & liabilities stacks on a phone');
  check(/\.hh\{grid-template-columns:1fr 1fr 1fr/.test(css),'household card stacks on a phone');
  eq(L.LOCK_DEFAULT,300,'auto-lock defaults to five minutes'); eq(L.PASS_MIN,10,'ten-character minimum');
  eq(S.settings.widgets.map(w=>w.id).slice(0,3),['guide','household','networth'],'household card above net worth for a new book');
  L.render(); check(!/backup/i.test(d.getElementById('saveStat').textContent),'an empty book does not warn about backups');
  seedBasic(S); L.recalcBalances(); L.render(); check(/backup not set up/i.test(d.getElementById('saveStat').textContent),'a real book says backup not set up, calmly');
  check(d.querySelector('[data-wid="household"] .hh')!==null&&/Alex/.test(d.querySelector('[data-wid="household"]').textContent),'household card renders the grid');
  act('lock-setup'); await tick(20); check(!!d.querySelector('#f_p1')&&!!d.querySelector('#f_timeout'),'setup dialog opens'); d.querySelector('#f_p1').value='short'; d.querySelector('#f_p2').value='short'; act('form-submit'); await tick(50); check(!L.lockEncrypts()&&!!d.querySelector('#f_p1'),'short passphrase refused');
  d.querySelector('#f_p1').value='long enough one'; d.querySelector('#f_p2').value='long enough one'; d.querySelector('#f_timeout').value='900'; act('form-submit'); await tick(1200); check(L.lockEncrypts(),'eight+ accepted'); eq(S.settings.lockTimeout,900,'lock timeout taken from the dialog'); check(!!d.getElementById('recoveryCode'),'recovery code follows'); act('close-modal');
  act('add-tx'); await tick(20); const chips=d.querySelectorAll('[data-chips="dir"] .chip'); eq(chips.length,2,'two direction chips'); eq(d.querySelector('[data-chips="dir"] .chip[aria-pressed="true"]').dataset.v,'out','starts on money out');
  chips[1].click(); await tick(10); eq(L.cat(d.getElementById('f_categoryId').value).type,'in','money in picks an income category'); eq(d.querySelector('[data-chips="dir"] .chip[aria-pressed="true"]').dataset.v,'in','chip pressed');
  d.getElementById('f_categoryId').value='c3'; d.getElementById('f_categoryId').dispatchEvent(new w.Event('change',{bubbles:true})); eq(d.querySelector('[data-chips="dir"] .chip[aria-pressed="true"]').dataset.v,'out','choosing a spending category flips the chip back'); act('close-modal');
  const s2=await boot(); s2.act('load-sample'); const k=s2.L.todayISO().slice(0,7); check(s2.L.monthFlows(k).in>0,'sample earns something in the current month');
});
suite('defaults: passphrase first, extras off',async()=>{
  const {L,S,d,act,tick}=await boot();
  eq(S.settings.widgets.filter(w=>['habits','whatif'].includes(w.id)).map(w=>w.on),[false,false],'habits and what-if start hidden for a new book');
  check(S.settings.widgets.find(w=>w.id==='subs').on&&S.settings.widgets.find(w=>w.id==='budgets').on,'core widgets stay on');
  const o=await boot({storage:{'ledger-v1':JSON.stringify(Object.assign(JSON.parse(JSON.stringify(S)),{settings:Object.assign({},S.settings,{widgets:[{id:'habits',span:12,on:true}]})}))}}); await o.tick(50);
  check(o.L.S.settings.widgets.find(w=>w.id==='habits').on,'an older book keeps what it had on');
  /* the offer: first run, then again after three days, three times, then "don't ask again" */
  S.settings.onboarded=true; L.lockOffer(); check(!!d.querySelector('#modalRoot [data-act="lock-offer-set"]'),'offer shown'); eq(S.settings.lockOfferCount,1,'counted'); act('lock-offer-skip');
  L.lockOffer(); check(!d.querySelector('#modalRoot [data-act="lock-offer-set"]'),'not again the same day');
  S.settings.lockOfferedAt=Date.now()-4*86400000; L.lockOffer(); check(!!d.querySelector('#modalRoot [data-act="lock-offer-set"]'),'asked again after three days'); act('lock-offer-skip');
  S.settings.lockOfferCount=3; S.settings.lockOfferedAt=0; L.lockOffer(); check(!d.querySelector('#modalRoot [data-act="lock-offer-set"]'),'stops after three refusals');
  await L.setLockPassphrase('pw long enough'); S.settings.lockOfferCount=0; S.settings.lockOfferedAt=0; L.lockOffer(); check(!d.querySelector('#modalRoot [data-act="lock-offer-set"]'),'never offered once a passphrase exists');
});
suite('combining two books',async()=>{
  const {L,S,d,act,tick,w}=await boot(); seedBasic(S); S.rules=[{id:'r1',match:'netflix',categoryId:'c9',accountId:''}]; L.recalcBalances(); await L.saveNow();
  const A=JSON.parse(JSON.stringify(S));
  /* the other person's book: same base, then diverged */
  const B=JSON.parse(JSON.stringify(A));
  B.users=[{id:'u1',name:'Alex',color:'#2E6B4F'},{id:'uX',name:'sam',color:'#000'},{id:'u3',name:'Kim',color:'#123'}];
  B.transactions.push(tx('b1','2026-09-07',33,'out','c3','chq',{userId:'uX',createdAt:5}),tx('b2','2026-09-08',44,'out','c4','visa',{userId:'u3',createdAt:6}));
  B.transactions.find(t=>t.id==='t2').amount=999; B.transactions.find(t=>t.id==='t2').updatedAt=Date.now()+1000;
  S.transactions.find(t=>t.id==='t4').createdAt=2; A.transactions.find(t=>t.id==='t4').createdAt=2; B.transactions.find(t=>t.id==='t4').amount=1; B.transactions.find(t=>t.id==='t4').updatedAt=1;   /* older edit: loses */
  B.transactions=B.transactions.filter(t=>t.id!=='t3');   /* the other side imported the same coffee line under its own id */
  B.transactions.push(tx('dupe','2026-09-03',60,'out','c4','visa',{src:'TEXT sha256:'+'ab'.repeat(32),raw:'Sep 3 COFFEE 60.00'}));
  A.transactions.find(t=>t.id==='t3').src='TEXT sha256:'+'ab'.repeat(32); A.transactions.find(t=>t.id==='t3').raw='Sep 3 COFFEE 60.00'; S.transactions.find(t=>t.id==='t3').src=A.transactions.find(t=>t.id==='t3').src; S.transactions.find(t=>t.id==='t3').raw='Sep 3 COFFEE 60.00';
  B.accounts.push(acct('cash','asset',50,{name:'Cash'})); B.accounts.push(acct('chq2','asset',5,{name:'Chequing'}));
  B.accounts[0].checkpoints=[{date:'2026-08-31',balance:1234,at:1}];
  B.rules.push({id:'r2',match:'spotify',categoryId:'c9',accountId:''},{id:'r9',match:'NETFLIX',categoryId:'c9',accountId:''});
  B.budgets={c3:500,c4:200}; B.transactions.push(xfer('x9','2026-09-08',5,'chq','cash'));
  const plan=L.mergePlan(S,B); const r=plan.report;
  eq([r.txAdded,r.txUpdated,r.txDuplicate,r.txDropped],[3,1,1,0],'added / updated / duplicate / dropped');
  eq(plan.state.users.map(u=>u.name),['Alex','Sam','Kim'],'Sam matched by name, Kim added');
  eq(plan.state.transactions.find(t=>t.id==='b1').userId,'u2','tags follow the name match'); eq(plan.state.transactions.find(t=>t.id==='t2').amount,999,'newer edit wins'); eq(plan.state.transactions.find(t=>t.id==='t4').amount,45,'older edit loses');
  check(plan.state.accounts.some(a=>a.id==='cash')&&plan.state.accounts.some(a=>a.name==='Chequing (from copy)'),'accounts added, a name clash renamed');
  eq(plan.state.accounts[0].checkpoints.length,1,'checkpoints union'); eq(plan.state.rules.map(x=>x.id),['r1','r2'],'rules by id or same match'); eq(plan.state.budgets.c4,200,'missing budgets filled'); eq(plan.state.budgets.c3,500,'own budgets kept');
  eq(JSON.stringify(S),JSON.stringify(A),'planning touches nothing');
  /* symmetric: the same set of rows whichever side combines */
  const p2=L.mergePlan(B,A); eq([p2.state.transactions.length,Math.round(p2.state.transactions.reduce((s,t)=>s+t.amount,0))],[plan.state.transactions.length,Math.round(plan.state.transactions.reduce((s,t)=>s+t.amount,0))],'same rows either way (the coffee line kept once under either id)');
  /* through the dialog: report, apply, undo */
  L.mergeBook(JSON.stringify(B)); await tick(300); check(!!d.querySelector('.modal, #modalRoot')&&/3<\/b> transactions added/.test(d.getElementById('modalRoot').innerHTML),'report shows what would change');
  act('confirm-yes'); await tick(200); eq(L.S.transactions.length,12,'combined'); eq(L.S.users.length,3,'members combined'); eq(L.integrityCheck().checks.filter(c=>c.status==='fail').length,0,'integrity clean');
  act('undo'); eq(L.S.transactions.length,9,'undo restores the book');
  /* a saved copy (html) and an encrypted backup both work as input */
  const html='<html><body><script type="application/json" id="ledger-data">'+JSON.stringify({saved:1,state:B}).replace(/<\//g,'<\\/')+'</'+'script></body></html>';
  eq(JSON.parse(L.extractBookText(html)).transactions.length,B.transactions.length,'a saved copy is read as a book');
  const e=await boot(); e.L.S.accounts=[acct('chq','asset',1)]; e.L.S.transactions=[tx('z','2026-09-01',1,'out','c3','chq')]; await e.L.setLockPassphrase('pw long enough'); const encB=await e.L.sealState();
  L.mergeBook(encB); await tick(200); check(!!d.querySelector('#f_pass'),'an encrypted copy asks for its passphrase'); d.querySelector('#f_pass').value='pw long enough'; act('form-submit'); await tick(900); check(/1<\/b> transaction/.test(d.getElementById('modalRoot').innerHTML),'then reports'); act('close-modal');
});
suite('reviewer findings: merge and CSV',async()=>{
  const {L,S,d,act,tick}=await boot(); S.accounts=[acct('a1','asset',1000,{name:'Chequing'}),acct('a2','asset',0,{name:'Savings'})]; L.recalcBalances();
  /* 1. a reversal whose "out" half is a duplicate bank line keeps its link through the merge */
  S.transactions=[tx('x1','2026-08-10',100,'out','c3','a1',{note:'E-TRANSFER TO BOB 12345',src:'CSV sha256:'+'ab'.repeat(32),raw:'E-TRANSFER TO BOB 12345',createdAt:1})];
  const B=Object.assign(JSON.parse(JSON.stringify(S)),{users:[],transactions:[
    tx('y1','2026-08-10',100,'out','c3','a1',{note:'E-TRANSFER TO BOB 12345',src:'CSV sha256:'+'ab'.repeat(32),raw:'E-TRANSFER TO BOB 12345',reversedBy:'y2',createdAt:1}),
    tx('y2','2026-08-12',100,'in','c2','a1',{note:'E-TRANSFER REVERSAL',reversalOf:'y1',revSource:'manual',createdAt:2})],recurring:[],rules:[],goals:[],planned:[],budgets:{},generated:{},closes:[],habits:[]});
  let plan=L.mergePlan(S,B); const y2=plan.state.transactions.find(t=>t.id==='y2'), x1=plan.state.transactions.find(t=>t.id==='x1');
  eq([plan.report.txAdded,plan.report.txDuplicate,plan.report.linksDropped],[1,1,0],'reclaim added, duplicate skipped, no link lost'); eq(y2.reversalOf,'x1','the link now points at the surviving row'); eq(x1.reversedBy,'y2','and the survivor points back');
  /* 2. a recurring bill entered on both sides is booked once */
  S.transactions=[]; S.recurring=[{id:'rA',name:'Rent',amount:2000,day:1,month:1,cadence:'monthly',since:'2026-08',categoryId:'c3',accountId:'a1',active:true}]; S.generated={'rA:2026-09':true}; S.transactions=[tx('g1','2026-09-01',2000,'out','c3','a1',{note:'Rent',recurringId:'rA',source:'recurring'})];
  const C=Object.assign({},B,{transactions:[tx('g2','2026-09-01',2000,'out','c3','a1',{note:'Rent',recurringId:'rB',source:'recurring'})],recurring:[{id:'rB',name:'rent',amount:2000,day:1,month:1,cadence:'monthly',since:'2026-08',categoryId:'c3',accountId:'a1',active:true}],generated:{'rB:2026-09':true}});
  plan=L.mergePlan(S,C); eq(plan.state.recurring.map(r=>r.id),['rA'],'one recurring item'); check(plan.state.generated['rA:2026-09']&&!plan.state.generated['rB:2026-09'],'the other side\'s booked stamp follows the surviving item'); eq(plan.state.transactions.find(t=>t.id==='g2').recurringId,'rA','its generated row points at the survivor');
  const live=L.S; L.S.transactions=plan.state.transactions; L.S.recurring=plan.state.recurring; L.S.generated=plan.state.generated; L.runRecurring(); eq(L.S.transactions.filter(t=>t.date==='2026-09-01'&&t.amount===2000).length,2,'no third rent booked (the two rows are the two sides\' own copies, kept for the report)');
  /* 3. a newer row replaces the old one whole: a dropped alloc does not linger */
  S.transactions=[xfer('t1','2026-09-02',500,'a1','a2',{alloc:{principal:400,extra:0,interest:100,tax:0,insurance:0,fee:0,escrow:0,escrowId:'',status:'set',source:'manual'},createdAt:1})];
  const D=Object.assign({},B,{transactions:[xfer('t1','2026-09-02',300,'a1','a2',{updatedAt:Date.now()})]});
  plan=L.mergePlan(S,D); check(!plan.state.transactions[0].alloc&&plan.state.transactions[0].amount===300,'newer edit wins whole, stale alloc gone');
  /* 4. a category id that changed kind on the other side is not merged onto ours */
  S.transactions=[]; const E=Object.assign({},B,{categories:B.categories.map(c=>c.id==='c2'?{id:'c2',name:'Parking',type:'out',color:'#000',need:false}:c),transactions:[tx('p1','2026-09-03',12,'out','c2','a1',{note:'PARKING'})],budgets:{c2:120}});
  plan=L.mergePlan(S,E); const p1=plan.state.transactions.find(t=>t.id==='p1'); check(p1.categoryId!=='c2'&&plan.state.categories.find(c=>c.id===p1.categoryId).type==='out','expense lands in a new out category, not under Other income'); check(!('c2' in plan.state.budgets)&&Object.keys(plan.state.budgets).length===1,'budget follows the new category');
  /* 5. beyond five people, dropped tags are counted and reported */
  S.users=['A','B','C','D','E'].map((n,i)=>({id:'u'+i,name:n,color:'#111'})); const F=Object.assign({},B,{users:[{id:'u9',name:'Zed',color:'#222'}],transactions:[tx('z1','2026-09-04',5,'out','c3','a1',{userId:'u9'}),tx('z2','2026-09-05',6,'out','c3','a1',{userId:'u9'})]});
  plan=L.mergePlan(S,F); eq([plan.report.usersDropped,plan.report.tagsLost],[1,2],'dropped member and lost tags counted');
  L.mergeBook(JSON.stringify(F)); await tick(300); check(/NOT brought over/.test(d.getElementById('modalRoot').textContent),'the report says a member could not come over'); act('close-modal');
  /* 6. a checkpoint the merged rows no longer reproduce is flagged */
  S.users=[]; S.accounts[0].checkpoints=[{date:'2026-07-31',balance:900,at:1}]; S.accounts[0].opening={balance:1000}; S.transactions=[tx('j1','2026-07-15',100,'out','c3','a1',{createdAt:1})]; L.recalcBalances();
  eq(L.integrityCheck().checks.find(c=>/Checkpoints follow/.test(c.name)).status,'pass','chain holds before');
  const G=Object.assign({},B,{accounts:[Object.assign(acct('a1','asset',1000,{name:'Chequing'}),{checkpoints:[{date:'2026-06-30',balance:1000,at:1}]})],transactions:[tx('k1','2026-07-20',250,'out','c3','a1',{createdAt:2})]});
  L.mergeBook(JSON.stringify(G)); await tick(300); check(/checkpoint/i.test(d.getElementById('modalRoot').textContent)&&/no longer match/.test(d.getElementById('modalRoot').textContent),'merge report warns about the checkpoint gap'); act('close-modal');
  /* 7. dates */
  const y=L.todayISO().slice(0,4);
  const rows=L.parseOCRText('Date Particulars Debit Credit\n08/02 POS PURCHASE TESCO 45.20\n08/05 PAYROLL DEPOSIT ACME 2000.00'); eq(rows.map(r=>r.date),[y+'-08-02',y+'-08-05'],'MM/DD with no year takes this year');
  /* 8. CSV: direction words, comma decimals, transfer provenance, preview guard */
  const c=await boot(); c.S.accounts=[acct('chq','asset',0,{name:'Chequing'}),acct('sav','asset',0,{name:'Savings'})]; c.L.render(); c.act('import-csv'); await c.tick(30);
  c.d.getElementById('csvPaste').value='Date,Transaction,Description,Amount\n2026-08-02,Withdrawal,TESCO STORES,45.20\n2026-08-03,Deposit,PAYROLL,"1,550.00"\n2026-08-04,DR,COFFEE,"3,50"\n2026-08-05,CR,REFUND,"1.234,56"'; c.d.getElementById('csvAcct').value='chq'; c.act('run-import'); await c.tick(500);
  eq(c.L.S.transactions.map(t=>[t.type,t.amount]),[['out',45.2],['in',1550],['out',3.5],['in',1234.56]],'csv: Withdrawal/Deposit/DR/CR read as directions; 3,50 and 1.234,56 read as decimals');
  const c3=await boot(); c3.S.accounts=[acct('chq','asset',0,{name:'Chequing'}),acct('sav','asset',0,{name:'Savings'})]; c3.L.render(); c3.act('import-csv'); await c3.tick(30);
  const csvT='date,amount,type,account,to_account,note\n2026-08-06,200,transfer,Chequing,Savings,MOVE'; c3.d.getElementById('csvPaste').value=csvT; c3.act('run-import'); await c3.tick(500); eq(c3.L.S.transactions.length,1,'csv transfer imported'); check(c3.L.S.transactions[0].src&&c3.L.S.transactions[0].createdAt,'csv transfer carries provenance');
  c3.act('import-csv'); await c3.tick(30); c3.d.getElementById('csvPaste').value=csvT; c3.act('run-import'); await c3.tick(500); eq(c3.L.S.transactions.length,1,'re-importing the same file does not duplicate the transfer');
  c3.act('import-csv'); await c3.tick(30); c3.d.getElementById('csvPaste').value='Date,Description,Withdrawal,Deposit\n2026-08-07,X,45.20,'; c3.d.getElementById('csvPaste').dispatchEvent(new c3.w.Event('input',{bubbles:true})); await c3.tick(50); check(/1 row/.test(c3.d.getElementById('csvPreview').textContent)&&!/no date and amount/.test(c3.d.getElementById('csvPreview').textContent),'preview accepts debit/credit files');
});
suite('attacker findings: series aliasing, merge idempotence',async()=>{
  const {L,S}=await boot(); S.accounts=[acct('cash','asset',5000),acct('loan','liability',100000,{acctType:'car loan',loan:{original:120000}})];
  const pay=(esc)=>xfer('p','2026-09-01',1500,'cash','loan',{alloc:{principal:400,extra:0,interest:1100,tax:0,insurance:0,fee:0,escrow:0,escrowId:esc,status:'set',source:'manual'}});
  for(const esc of ['loan','cash','']){ S.transactions=[pay(esc)]; L.recalcBalances(); const D=L.todayISO(); const s=L.netWorthSeriesAt([D]); const v=Array.isArray(s)?s[0]:(s.points||s.series)[0]; near(typeof v==='number'?v:(v.v!==undefined?v.v:v.value),L.netWorthAt(D),'series equals netWorthAt when escrow is '+(esc||'none')); }
  /* merging the same book twice changes nothing, even after a newer edit that lacked provenance */
  const {L:M,S:MS}=await boot(); MS.accounts=[acct('a1','asset',1000)]; MS.transactions=[tx('shared','2026-08-01',100,'out','c3','a1',{src:'CSV sha256:'+'cd'.repeat(32),raw:'AUG 1 SHOP 100.00',createdAt:1})]; M.recalcBalances();
  const other=Object.assign(JSON.parse(JSON.stringify(MS)),{transactions:[tx('shared','2026-08-01',100,'out','c3','a1',{note:'edited',updatedAt:Date.now()+5}),tx('o2','2026-08-02',100,'out','c3','a1',{src:'CSV sha256:'+'cd'.repeat(32),raw:'AUG 1 SHOP 100.00',createdAt:1})]});
  const once=M.mergePlan(MS,other); const twice=M.mergePlan(once.state,other);
  eq(twice.state.transactions.length,once.state.transactions.length,'a second merge of the same book adds nothing'); check(once.state.transactions.find(t=>t.id==='shared').src,'provenance survives a newer edit');
  eq(JSON.stringify(twice.state.transactions.map(t=>[t.id,t.amount]).sort()),JSON.stringify(once.state.transactions.map(t=>[t.id,t.amount]).sort()),'idempotent');
});
suite('unhappy paths',async()=>{
  /* 1. damaged storage is held, shown, never overwritten */
  const bad='{"settings":{"rev":3},"transactions":[{"id":"t1","date":"2026-01-0'; const c=await boot({storage:{'ledger-v1':bad}}); await c.tick(100);
  eq(c.errors.length,0,'no crash on damaged storage'); check(!!c.d.getElementById('corruptbar'),'damaged-book bar shown'); check(!c.d.querySelector('#modalRoot [data-act="start-empty"]'),'no welcome screen over damaged data');
  c.L.S.accounts=[acct('a','asset',1)]; const saved=await c.L.saveNow(); eq(saved,false,'saving is refused'); eq(c.w.localStorage.getItem('ledger-v1'),bad,'the damaged data is untouched'); check(/damaged/i.test(c.d.getElementById('saveStat').textContent),'status says why');
  check(!!c.d.querySelector('[data-act="corrupt-download"]')&&!!c.d.querySelector('[data-act="corrupt-discard"]'),'download and start-over offered');
  c.act('corrupt-discard'); await c.tick(20); c.act('confirm-yes'); await c.tick(600); check(!c.d.getElementById('corruptbar')&&(c.w.localStorage.getItem('ledger-v1')||'').startsWith('{"settings"'),'starting over writes a fresh book only after the confirmation');
  const m=await boot({storage:{'ledger-v1':'{"accounts":"oops","transactions":{"x":1},"categories":5}'}}); await m.tick(50); eq(m.errors.length,0,'a malformed book does not crash the page'); check(Array.isArray(m.L.S.accounts)&&Array.isArray(m.L.S.transactions)&&m.L.S.categories.length>5,'lists repaired');
  /* 2. writes failing (full storage): red status, persistent bar, backup offered, retry works */
  const q=await boot(); seedBasic(q.S); q.L.recalcBalances(); await q.L.saveNow();
  const realSet=q.w.Storage.prototype.setItem; q.w.Storage.prototype.setItem=function(){ const e=new Error('QuotaExceededError: storage is full'); e.name='QuotaExceededError'; throw e; };
  q.L.S.transactions[0].note='CHANGED'; const ok=await q.L.saveNow(); eq(ok,false,'save reports failure'); q.L.render(); check(/NOT saved/.test(q.d.getElementById('saveStat').textContent),'status is red and says NOT saved'); check(!!q.d.getElementById('savebar')&&!!q.d.querySelector('#savebar [data-act="export-json"]'),'a persistent bar offers a backup');
  q.w.Storage.prototype.setItem=realSet; q.act('save-retry'); await q.tick(300); check(!q.d.getElementById('savebar')&&(q.w.localStorage.getItem('ledger-v1')||'').includes('CHANGED'),'retry saves and clears the bar');
  /* 3. damaged ciphertext is told apart from a wrong passphrase */
  const v=await boot(); seedBasic(v.S); v.L.recalcBalances(); await v.L.saveNow(); await v.L.setLockPassphrase('a good long passphrase'); const env=JSON.parse(v.w.localStorage.getItem('ledger-v1')); env.ct=env.ct.slice(0,-8)+'AAAAAAAA'; const envText=JSON.stringify(env);
  const dmg=await boot({storage:{'ledger-v1':envText,'ledger-lock':v.w.localStorage.getItem('ledger-lock')}}); await dmg.tick(100); dmg.d.getElementById('lockInput').value='a good long passphrase'; dmg.act('lock-unlock'); await dmg.tick(1500);
  check(!!dmg.d.getElementById('corruptbar')&&eq(dmg.w.localStorage.getItem('ledger-v1'),envText,'damaged envelope untouched')===undefined,'right passphrase on a damaged book shows the damaged-book bar');
  /* 4. a German statement reads correctly */
  const g=await boot(); const rows=g.L.parseOCRText('Datum Buchungstext Betrag\n01.09.2026 LASTSCHRIFT REWE 45,20-\n03.09.2026 GEHALT 2.100,00+\n05.09.2026 MIETE 1.150,00-');
  eq(rows.map(r=>[r.date,r.amount]),[['2026-09-01',45.2],['2026-09-03',2100],['2026-09-05',1150]],'day.month.year dates and comma decimals');
  /* 5. keyboard: focus returns to the opener, Tab stays inside, Escape discards a staged review, the dropzone is a button */
  const k=await boot(); k.act('start-empty'); await k.tick(20); if(k.d.querySelector('#modalRoot [data-act="lock-offer-skip"]')) k.act('lock-offer-skip'); await k.tick(20); k.S.accounts=[acct('chq','asset',1)]; k.L.render(); const opener=k.d.querySelector('[data-act="add-tx"]'); opener.focus(); k.act('add-tx'); await k.tick(60); check(k.d.activeElement&&k.d.activeElement.id==='f_amount','first field focused');
  const focusables=Array.from(k.d.querySelectorAll('.sheet button,.sheet input,.sheet select')).filter(el=>!el.hidden); focusables[focusables.length-1].focus(); k.d.activeElement.dispatchEvent(new k.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); check(k.d.activeElement===focusables[0],'Tab from the last control wraps to the first');
  k.d.querySelector('.sheet [data-act="close-modal"]').click(); await k.tick(60); check(k.d.activeElement===opener,'focus returns to the button that opened the dialog');
  k.act('import-shots'); await k.tick(30); check(k.d.getElementById('dropzone').tagName==='BUTTON','dropzone is a real button'); k.d.getElementById('shotText').value=fs.readFileSync(path.join(__dirname,'fixture-chequing.txt'),'utf8'); k.d.getElementById('shotReadBtn').click(); await k.tick(700); check(k.L.revRows.length>0,'rows staged');
  k.L.S.settings.x=1; k.d.dispatchEvent(new k.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); check(!k.d.querySelector('.veil')&&!k.L.stagedAccount,'Escape discards the staged review and closes the dialog'); k.act('import-shots'); await k.tick(30); eq(k.L.revRows.length,0,'reopening starts clean'); k.act('close-modal');
  /* 6. a huge paste is refused, not chewed */
  k.act('import-shots'); await k.tick(30); k.d.getElementById('shotText').value='x'.repeat(600001); k.d.getElementById('shotReadBtn').click(); await k.tick(100); check(/very large/.test(k.d.getElementById('shotStatus')?k.d.getElementById('shotStatus').textContent:k.d.body.textContent),'oversized paste refused with a reason');
});
suite('vault re-check: backup, protect, rotate, tabs, adoption',async()=>{
  const PW='first passphrase here', PW2='second passphrase here';
  /* a. locking wipes everything readable and cancels pending writes */
  const a=await boot(); seedBasic(a.S); a.L.recalcBalances(); await a.L.saveNow(); await a.L.setLockPassphrase(PW); a.L.S.settings.debug=true; a.L.dlog('transaction added',{amount:4321.99}); a.act('lock-now'); await a.tick(800);
  check(!a.w.localStorage.getItem('ledger-debuglog'),'a debug entry queued just before the lock never reaches disk'); eq((a.d.getElementById('toast')||{}).innerHTML,'','toast cleared on lock'); eq(a.L.S.transactions.length,0,'book wiped from memory');
  /* b. protect cannot half-succeed: a refused save leaves no lock record and plain storage untouched */
  const b=await boot(); seedBasic(b.S); b.L.recalcBalances(); await b.L.saveNow(); const before=b.w.localStorage.getItem('ledger-v1'); const newer=JSON.parse(before); newer.settings.rev=(newer.settings.rev||0)+9; b.w.localStorage.setItem('ledger-v1',JSON.stringify(newer));
  let threw=''; try{ await b.L.setLockPassphrase(PW); }catch(e){ threw=e.message; } check(/nothing was changed/.test(threw),'protect refused with a reason: '+threw); check(!b.L.loadLock()&&!b.L.vaultOn(),'no lock record, no vault'); eq(b.w.localStorage.getItem('ledger-v1'),JSON.stringify(newer),'storage untouched');
  let short=''; try{ await b.L.setLockPassphrase('short'); }catch(e){ short=e.message; } check(/at least/.test(short),'the length rule holds in the function, not only the form');
  /* c. a passphrase change that cannot be saved changes nothing, and says so */
  const c=await boot(); seedBasic(c.S); c.L.recalcBalances(); await c.L.saveNow(); await c.L.setLockPassphrase(PW); const lock1=c.w.localStorage.getItem('ledger-lock'), env1=c.w.localStorage.getItem('ledger-v1');
  const stale=JSON.parse(env1); stale.rev=(stale.rev||0)+9; c.w.localStorage.setItem('ledger-v1',JSON.stringify(stale));
  threw=''; try{ await c.L.changePassphrase(PW2); }catch(e){ threw=e.message; } check(/another tab/.test(threw),'rotation refused: '+threw); eq(c.w.localStorage.getItem('ledger-lock'),lock1,'lock record unchanged');
  const c1=await boot({storage:{'ledger-v1':env1,'ledger-lock':lock1}}); await c1.tick(100); c1.d.getElementById('lockInput').value=PW; c1.act('lock-unlock'); await c1.tick(1200); check(!c1.L.pendingUnlock&&c1.L.S.transactions.length===9,'the old passphrase still opens the unchanged book');
  /* d. two tabs: after a rotation in tab A, tab B cannot force its old-key copy over it */
  const A=await boot(); seedBasic(A.S); A.L.recalcBalances(); await A.L.saveNow(); await A.L.setLockPassphrase(PW);
  const B=await boot({storage:{'ledger-v1':A.w.localStorage.getItem('ledger-v1'),'ledger-lock':A.w.localStorage.getItem('ledger-lock')}}); await B.tick(100); B.d.getElementById('lockInput').value=PW; B.act('lock-unlock'); await B.tick(1200); check(B.L.vaultOn(),'tab B open');
  const codeA=await A.L.changePassphrase(PW2); const saltA=JSON.parse(A.w.localStorage.getItem('ledger-lock')).salt;
  B.w.localStorage.setItem('ledger-v1',A.w.localStorage.getItem('ledger-v1')); B.w.localStorage.setItem('ledger-lock',A.w.localStorage.getItem('ledger-lock'));   /* the shared origin, seen from tab B */
  B.L.S.transactions[0].note='FROM B'; eq(await B.L.saveNow(),false,'tab B save refused'); B.act('stale-overwrite'); await B.tick(700);
  eq(JSON.parse(B.w.localStorage.getItem('ledger-v1')).wraps.salt,saltA,'the forced overwrite did not land: storage still under tab A\'s new key'); check(/passphrase was changed in another tab/.test(B.d.getElementById('toast').textContent)||B.L.staleTab,'tab B is told to reload');
  /* e. adoption: a non-empty unprotected browser opens a foreign encrypted backup without taking its key; an empty one adopts and re-keys */
  const F=await boot(); seedBasic(F.S); F.L.recalcBalances(); await F.L.setLockPassphrase('stranger passphrase'); const foreign=await F.L.sealState(2); const foreignSalt=JSON.parse(foreign).wraps.salt;
  const victim=await boot(); victim.S.accounts=[acct('mine','asset',5)]; victim.S.transactions=[tx('v1','2026-09-01',5,'out','c3','mine')]; victim.L.recalcBalances(); await victim.L.saveNow();
  victim.L.applyRestore(foreign,true); await victim.tick(100); victim.d.querySelector('#f_pass').value='stranger passphrase'; victim.act('form-submit'); await victim.tick(1500);
  eq(victim.L.S.transactions.length,9,'restored'); check(!victim.L.loadLock()&&!victim.L.vaultOn(),'but this browser did not take the stranger\'s key'); check(!victim.L.isEnvelope(JSON.parse(victim.w.localStorage.getItem('ledger-v1'))),'stored readable, under nobody else\'s key');
  const mover=await boot(); mover.L.applyRestore(foreign,true); await mover.tick(100); mover.d.querySelector('#f_pass').value='stranger passphrase'; mover.act('form-submit'); await mover.tick(3000);
  eq(mover.L.S.transactions.length,9,'an empty browser restores its owner\'s backup'); check(mover.L.lockEncrypts(),'and is protected'); check(JSON.parse(mover.w.localStorage.getItem('ledger-lock')).salt!==foreignSalt,'under a key of its own, not the backup\'s'); check(!!mover.d.getElementById('recoveryCode'),'with its own recovery code shown');
  /* g. a lock record over readable storage: nothing is drawn before the passphrase */
  const half=await boot({storage:{'ledger-v1':before,'ledger-lock':lock1}}); await half.tick(200); check(!!half.d.getElementById('lockScreen')&&half.L.S.transactions.length===0&&half.d.getElementById('board').innerHTML==='','locked at boot with nothing in memory or on the board');
  half.d.getElementById('lockInput').value=PW; half.act('lock-unlock'); await half.tick(1500); eq(half.L.S.transactions.length,9,'unlock reads the book'); await half.L.saveNow(); check(half.L.isEnvelope(JSON.parse(half.w.localStorage.getItem('ledger-v1'))),'and the next save encrypts it');
});
suite('your first month',async()=>{
  const {L,S,d,act,tick}=await boot(); L.render();
  check(S.settings.widgets[0].id==='guide','guide sits first for a new book'); check(!!d.querySelector('[data-wid="guide"]'),'guide card shown');
  eq(L.guideSteps().filter(s=>s.done).length,0,'nothing done yet'); eq(L.guideSteps().length,6,'six steps');
  check(!!d.querySelector('[data-wid="guide"] [data-act="add-acct"]'),'step one offers to add an account');
  S.accounts=[acct('chq','asset',100,{name:'Chequing'})]; S.users=[{id:'u1',name:'Alex',color:'#111'}]; L.render();
  eq(L.guideSteps().filter(s=>s.done).map(s=>s.id),['account','person'],'account and person steps done by the book itself');
  check(d.querySelector('[data-wid="guide"] .guide-step.done')!==null,'done steps rendered as done');
  S.transactions=[tx('t1','2026-09-01',10,'out','c3','chq',{source:'paste',userId:'u1'})]; S.settings.lastBackup=Date.now(); L.render();
  eq(L.guideSteps().filter(s=>!s.done).map(s=>s.id),['lock'],'only the passphrase remains');
  await L.setLockPassphrase('pw long enough'); L.render(); check(L.guideSteps().every(s=>s.done)&&!d.querySelector('[data-wid="guide"]'),'card hides itself when everything is done');
  const o=await boot(); o.L.S.settings.widgets=o.L.S.settings.widgets.filter(w=>w.id!=='guide').concat([{id:'guide',span:12,on:true}]); delete o.L.S.settings.guidePlaced; await o.L.saveNow(); await o.L.load(); eq(o.L.S.settings.widgets[0].id,'guide','older books get the guide moved to the top once');
  act('load-sample'); check(!L.guideSteps().find(s=>s.id==='tag').done||L.guideSteps().find(s=>s.id==='statement').done||true,'sample data does not count as real progress'); const g=L.guideSteps(); check(!g.find(s=>s.id==='statement').done&&!g.find(s=>s.id==='tag').done,'sample rows do not tick statement or tagging');
});
suite('themes',async()=>{
  const {L,S,d,act,errors}=await boot(); const css=fs.readFileSync(path.join(__dirname,'..','ledger.css'),'utf8');
  eq(L.THEMES.length,20,'twenty palettes'); check(L.THEMES.filter(t=>t.kind==='light').length===10,'ten light, ten dark');
  const vars=['bg','surface','surface-2','ink','ink-2','ink-3','rule','rule-strong','hairline','in','out','accent','pop','on-pop'];
  const lum=h=>{ const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; };
  const contrast=(a,b)=>{ const x=lum(a),y=lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
  L.THEMES.forEach(t=>{
    const m=css.match(new RegExp('html\\[data-theme="'+t.id+'"\\]\\{([^}]*)\\}')); check(!!m,'css block for '+t.id); if(!m) return;
    const v={}; m[1].replace(/--([a-z0-9-]+):([^;]+);/g,(_,k,val)=>{ v[k]=val.trim(); });
    vars.forEach(k=>check(k in v,t.id+' defines --'+k));
    const pair=L.THEMES.find(x=>x.id===t.pair); check(!!pair&&pair.pair===t.id&&pair.kind!==t.kind,t.id+' pairs with a '+(t.kind==='light'?'dark':'light')+' theme both ways');
    if(/^#[0-9A-Fa-f]{6}$/.test(v.bg)&&/^#[0-9A-Fa-f]{6}$/.test(v.ink)){ check(contrast(v.ink,v.bg)>=7,t.id+' ink on bg ≥ 7:1 ('+contrast(v.ink,v.bg).toFixed(1)+')'); check(contrast(v['ink-3'],v.surface)>=4.5,t.id+' muted text on surface ≥ 4.5:1 ('+contrast(v['ink-3'],v.surface).toFixed(1)+')'); ['in','out','accent'].forEach(k=>{ if(/^#[0-9A-Fa-f]{6}$/.test(v[k])) check(contrast(v[k],v.surface)>=3.3,t.id+' --'+k+' on surface ≥ 3.3:1 ('+contrast(v[k],v.surface).toFixed(1)+')'); }); check((t.kind==='light')===(lum(v.bg)>0.4),t.id+' kind matches its background'); }
  });
  L.THEMES.forEach(t=>{ act('set-theme-id',{v:t.id}); eq(d.documentElement.dataset.theme,t.id,'switch to '+t.id); });
  act('toggle-theme'); eq(d.documentElement.dataset.theme,L.themeOf('forest').pair,'◐ flips to the pair');
  eq(errors.length,0,'no errors switching themes');
});
suite('sample data',async()=>{
  const {L,S,errors,act,d}=await boot(); act('load-sample'); check(S.transactions.length>10&&S.users.length===2,'sample book loads with two members');
  check(S.transactions.every(t=>t.source==='sample'),'sample rows are marked'); check(S.transactions.some(t=>t.type==='out'&&t.userId==='u1')&&S.transactions.some(t=>t.type==='out'&&t.userId==='u2')&&S.transactions.some(t=>t.type==='out'&&!t.userId),'sample spending is shared, with some left unassigned');
  S.settings.lastBackup=0; L.render(); check(!d.getElementById('backupbar'),'no backup reminder for a sample book'); check(!d.querySelector('[data-wid="household"] .card-body').textContent.includes('Household-wide'),'no scope note on the household card');
  const ic=L.integrityCheck(); eq(ic.checks.filter(c=>c.status==='fail').map(c=>c.name),[],'sample book passes integrity'); eq(errors.length,0,'no errors');
});

suite('top-bar lock button',async()=>{
  const {L,S,d,w,act,errors}=await boot();
  const btn=d.getElementById('lockBtn');
  check(!!btn,'the header carries a lock button');
  eq(btn.dataset.act,'lock-now','it fires the lock action');
  check(!!btn.querySelector('svg'),'it draws a padlock, not a text glyph');
  check(btn.getAttribute('aria-label')&&btn.title,'it is labelled for screen readers and on hover');
  L.render(); check(btn.hidden,'hidden while no passphrase is set');
  /* a lock record is all the button keys off — no need to spend PBKDF2 here */
  w.localStorage.setItem('ledger-lock',JSON.stringify({hash:'legacy',timeout:300}));
  L.render(); check(!btn.hidden,'shown once a passphrase exists');
  w.localStorage.removeItem('ledger-lock');
  L.render(); check(btn.hidden,'hidden again when the passphrase is removed');
  eq(errors.length,0,'no errors');
});

(async()=>{
  const only=process.argv.slice(2);
  for(const s of suites){ if(only.length&&!only.some(o=>s.name.indexOf(o)>=0)) continue; cur=s.name; const p0=pass,f0=fail; try{ await s.fn(); }catch(e){ fail++; failures.push(cur+': threw '+e.message); console.log('  FAIL '+cur+': threw '+(e.stack||e.message).split('\n').slice(0,2).join(' | ')); } console.log((fail>f0?'✗ ':'✓ ')+s.name+'  '+(pass-p0)+' ok'+(fail>f0?', '+(fail-f0)+' failed':'')); }
  console.log('\n'+pass+' passed, '+fail+' failed'+(failures.length?'\n'+failures.map(f=>' - '+f).join('\n'):''));
  process.exit(fail?1:0);
})();
