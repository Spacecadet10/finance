/* Builds dist/Ledger.html: the whole app in ONE file for sharing — styles, fonts, pdf.js and its worker inline.
   Nothing is fetched at runtime except the optional OCR fallback and any AI provider the person adds a key for.
   Run: npm run build   (then npm run test:dist runs the full suite against the built file) */
const fs=require('fs'); const path=require('path');
const ROOT=path.join(__dirname,'..'); const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const js=s=>s.replace(/<\/script/gi,'<\\/script').replace(/<!--/g,'<\\!--');   /* never let the HTML parser end the script early */
let html=read('finance-dashboard.html');
const PARTS=fs.readdirSync(path.join(ROOT,'src')).filter(f=>/^\d\d-.*\.js$/.test(f)).sort();
/* the parts become one closure again: strip each part's own "use strict" and wrap the lot */
const appJs='(function(){\n"use strict";\n'+PARTS.map(f=>read('src/'+f).replace(/^"use strict";\n/m,'')).join('\n')+'\n})();\n';
const version=(appJs.match(/const APP_VERSION='([^']+)'/)||[])[1]||'?';
/* fonts → data URIs */
let fonts=read('vendor/fonts.css').replace(/url\(fonts\/([^)]+)\)/g,(m,f)=>'url(data:font/woff2;base64,'+fs.readFileSync(path.join(ROOT,'vendor/fonts',f)).toString('base64')+')');
/* function replacements throughout: a plain replacement STRING would interpret $' and $& inside the code */
html=html.replace(/<link rel="stylesheet" href="vendor\/fonts\.css">/,()=>'<style>\n'+fonts+'</style>');
html=html.replace(/<link rel="stylesheet" href="ledger\.css[^"]*">/,()=>'<style>\n'+read('ledger.css')+'\n</style>');
/* the pristine body markup, kept in the head so a running copy can rebuild itself with its data inside (selfHTML) */
const bodyTpl=(()=>{ const m=html.match(/<body>([\s\S]*?)<script src="src\//); if(!m) throw new Error('body markup not found'); return m[1].trim(); })();
if(/<\/script/i.test(bodyTpl)) throw new Error('body template cannot contain a script');
html=html.replace(/<\/head>/,()=>'<script type="text/plain" id="ledger-body">\n'+bodyTpl+'\n</script>\n</head>');
const built=new Date().toISOString();
const head='<script>window.LEDGER_DIST={version:'+JSON.stringify(version)+',built:'+JSON.stringify(built)+'};</script>\n'
  +'<script>'+js(read('vendor/pdf.min.js'))+'</script>\n'
  +'<script type="text/plain" id="pdfWorkerSrc">'+js(read('vendor/pdf.worker.min.js'))+'</script>\n'
  +'<script id="ledger-app">\n'+js(appJs)+'\n</script>';
const tagRx=/<script src="src\/[^"]+"><\/script>\s*/g; if(!tagRx.test(html)) throw new Error('part script tags not found');
let first=html.search(/<script src="src\//); html=html.replace(tagRx,''); html=html.slice(0,first)+head+'\n'+html.slice(first);
html=html.replace(/<title>[^<]*<\/title>/,()=>'<title>Ledger</title>');
fs.mkdirSync(path.join(ROOT,'dist'),{recursive:true});
fs.writeFileSync(path.join(ROOT,'dist/Ledger.html'),html);
fs.writeFileSync(path.join(ROOT,'dist/README.txt'),`Ledger — personal finance dashboard (version ${version})

WHAT THIS IS
One file, Ledger.html, is the whole app. Nothing is installed and nothing is sent anywhere:
your accounts, transactions and household members stay in your own browser.

HOW TO USE IT
1. Save Ledger.html somewhere permanent (Documents, for example) and open it in Chrome, Edge or Safari.
   Bookmark it so you always open the same file.
2. On first open, start blank or load the sample month to see how it works.
3. Add an account with today's balance, then paste or scan a bank statement to fill in transactions.
4. Settings › Household: add the people in your home and tag transactions to them. The Household
   widget shows each person's income and spending next to the household total; the filter in the top
   bar shows one person at a time.

PRIVACY
When you first open it, Ledger offers to set a passphrase. With one, the book is encrypted with it
everywhere it is stored: in the browser, in backups, and in copies saved with the data inside. Nobody
can read your finances without it.
You are also given a RECOVERY CODE, shown once. Email it to yourself, copy it, or download it. If you
forget the passphrase, type the recovery code on the lock screen and choose a new passphrase.
There is no reset link and nobody else holds a key: lose both and the book is gone.
You can also skip the passphrase and set one later in Settings.

KEEP YOUR DATA SAFE
Your data is stored BY THE BROWSER, not inside the file. A copy of the file is an empty Ledger, and
clearing the browser's site data removes the book. So:
- Settings › Data › Live backup keeps a copy on disk automatically (Chrome and Edge), or
- Settings › Data › Back up now saves a file you can restore from anywhere.

READING STATEMENTS
PDF statements with real text are read on this computer. Scanned images need either an AI key
(Settings › AI, your own key) or the free on-device OCR, which downloads once from cdnjs when used.
`);
console.log('built dist/Ledger.html',Math.round(html.length/1024)+' KB, version',version);
