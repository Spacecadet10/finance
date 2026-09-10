/* Real-browser check of the shared single file: drives headless Chrome over the DevTools protocol with REAL
   time (virtual-time budgets race ahead of IndexedDB and give false blanks). Usage:
     node tests/chrome-check.js [path/to/Ledger.html] [--screenshot out.png] [--sample]
   Prints one JSON line with what the booted page reports. Exit 1 if it never boots. */
const {spawn}=require('child_process'); const fs=require('fs'); const path=require('path'); const os=require('os');
const CHROME=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const file=path.resolve(process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:'dist/Ledger.html');
const shotIdx=process.argv.indexOf('--screenshot'); const shot=shotIdx>0?process.argv[shotIdx+1]:'';
const sample=process.argv.includes('--sample');
const wIdx=process.argv.indexOf('--width'); const mobileW=wIdx>0?parseInt(process.argv[wIdx+1],10):0;
const passIdx=process.argv.indexOf('--passphrase'); const pass=passIdx>0?process.argv[passIdx+1]:'';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-chrome-')); const port=9222+Math.floor(Math.random()*500);
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--hide-scrollbars','--window-size=1280,900','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(p){ for(let i=0;i<50;i++){ try{ const r=await fetch('http://127.0.0.1:'+port+p); return await r.json(); }catch(e){ await sleep(200); } } throw new Error('chrome did not answer on port '+port); }
(async()=>{
  let ws; let id=0; const pending={}; const events=[];
  const tabs=await json('/json/list'); const page=tabs.find(t=>t.type==='page')||tabs[0];
  ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((ok,bad)=>{ ws.onopen=ok; ws.onerror=bad; });
  ws.onmessage=m=>{ const d=JSON.parse(m.data); if(d.id&&pending[d.id]){ pending[d.id](d); delete pending[d.id]; } else if(d.method) events.push(d); };
  const send=(method,params)=>new Promise(res=>{ const i=++id; pending[i]=res; ws.send(JSON.stringify({id:i,method,params:params||{}})); });
  const evalJs=async expr=>{ const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.result&&r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text+' '+JSON.stringify(r.result.exceptionDetails.exception||{}).slice(0,200)); return r.result&&r.result.result?r.result.result.value:undefined; };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  if(mobileW) await send('Emulation.setDeviceMetricsOverride',{width:mobileW,height:Math.round(mobileW*2.1),deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:'file://'+file});
  let booted=false, report=null;
  for(let i=0;i<60&&!booted;i++){ await sleep(250); try{ booted=await evalJs("!!(window.__ledger&&document.getElementById('monthLabel')&&document.getElementById('monthLabel').textContent!=='—')"); }catch(e){} }
  if(booted&&sample){ await evalJs("(function(){const b=document.createElement('button');b.dataset.act='load-sample';document.body.appendChild(b);b.click();b.remove();return true})()"); await sleep(300); await evalJs("(function(){const s=document.querySelector('[data-act=\"lock-offer-skip\"]'); if(s) s.click(); const L=window.__ledger;L.ui.user=L.S.users[0].id;L.render();return true})()"); await sleep(300); }
  const openIdx=process.argv.indexOf('--open'); if(booted&&openIdx>0){ const actName=process.argv[openIdx+1]; await evalJs("(function(){const b=document.createElement('button');b.dataset.act="+JSON.stringify(actName)+";document.body.appendChild(b);b.click();b.remove();return true})()"); await sleep(400); }
  let vault=null;
  if(booted&&pass){
    const code=await evalJs("window.__ledger.setLockPassphrase("+JSON.stringify(pass)+")");
    const enc=await evalJs("(function(){try{const d=JSON.parse(localStorage.getItem('ledger-v1'));return d.enc===1&&!localStorage.getItem('ledger-v1').includes('Chequing')}catch(e){return false}})()");
    await send('Page.reload'); await sleep(1500);
    const locked=await evalJs("!!(document.getElementById('lockScreen')&&document.getElementById('lockScreen').style.display!=='none')&&document.getElementById('monthLabel').textContent==='—'");
    await evalJs("(function(){document.getElementById('lockInput').value='wrong';document.getElementById('lockUnlock').click();return true})()"); await sleep(1500);
    const stillLocked=await evalJs("document.getElementById('monthLabel').textContent==='—'&&/Wrong/.test(document.getElementById('lockErr').textContent)");
    await evalJs("(function(){document.getElementById('lockInput').value="+JSON.stringify(pass)+";document.getElementById('lockUnlock').click();return true})()");
    let opened=false; for(let i=0;i<40&&!opened;i++){ await sleep(250); opened=await evalJs("document.getElementById('monthLabel').textContent!=='—'&&window.__ledger.S.transactions.length>0"); }
    /* forgot it: the recovery code opens the book and asks for a new passphrase */
    await send('Page.reload'); await sleep(1500);
    await evalJs("(function(){document.getElementById('lockInput').value="+JSON.stringify(code)+";document.getElementById('lockUnlock').click();return true})()");
    let recovered=false, askedNew=false; for(let i=0;i<40&&!recovered;i++){ await sleep(250); recovered=await evalJs("document.getElementById('monthLabel').textContent!=='—'&&window.__ledger.S.transactions.length>0"); }
    await sleep(800); askedNew=await evalJs("!!document.querySelector('#f_p1')");
    vault={encryptedInStorage:enc,lockedOnReload:locked,wrongRefused:stillLocked,openedWithPassphrase:opened,recoveryCode:/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/.test(code||''),openedWithRecovery:recovered,askedForNewPassphrase:askedNew};
  }
  if(booted) report=await evalJs("(function(){const L=window.__ledger,S=L.S;return {version:L.APP_VERSION,dist:L.isDist(),tx:S.transactions.length,users:S.users.map(u=>u.name),onboarded:!!S.settings.onboarded,welcome:!!document.querySelector('#modalRoot [data-act=\"start-empty\"]'),badge:document.getElementById('originStat').textContent,month:document.getElementById('monthLabel').textContent,cards:document.querySelectorAll('[data-wid]').length,addPerson:document.getElementById('addPersonBtn').textContent,addTx:document.getElementById('addTxBtn').textContent,filterHidden:document.getElementById('userFilter').hidden,storage:(function(){try{return JSON.parse(localStorage.getItem('ledger-v1')).transactions.length}catch(e){return null}})(),errors:[]}})()");
  const errs=events.filter(e=>e.method==='Runtime.exceptionThrown'||(e.method==='Log.entryAdded'&&e.params.entry.level==='error')).map(e=>e.method==='Runtime.exceptionThrown'?(e.params.exceptionDetails.text+' '+((e.params.exceptionDetails.exception||{}).description||'')).slice(0,200):e.params.entry.text.slice(0,200));
  if(shot&&booted){ const r=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(shot,Buffer.from(r.result.data,'base64')); }
  console.log(JSON.stringify(Object.assign({booted:booted,file:path.basename(file)},report||{},vault?{vault:vault}:{},{errors:errs})));
  ws.close(); chrome.kill(); setTimeout(()=>{ try{ fs.rmSync(profile,{recursive:true,force:true,maxRetries:3}); }catch(e){} process.exit(booted?0:1); },300);   /* Chrome is still closing its profile: retry, never fail the check over it */
})().catch(e=>{ console.log(JSON.stringify({booted:false,error:String(e.message||e)})); chrome.kill(); process.exit(1); });
