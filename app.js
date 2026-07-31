const DB_NAME = 'kikitori-reader-db';
const STORE = 'documents';
const SETTINGS_KEY = 'kikitori-settings-v1';

const $ = (id) => document.getElementById(id);
const state = {
  documents: [], currentId: null, index: 0, playing: false, paused: false,
  voices: [], rate: 1, voiceURI: '', languageMode: 'auto', fontSize: 1.13,
  sleepTimeout: null, installPrompt: null, libraryQuery: ''
};

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbAll() { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function dbPut(doc) { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,'readwrite').objectStore(STORE).put(doc); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
async function dbDelete(id) { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,'readwrite').objectStore(STORE).delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
async function dbClear() { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,'readwrite').objectStore(STORE).clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }

function normalizeText(text) {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}
function splitText(text) {
  const normalized = normalizeText(text);
  const blocks = normalized.split(/\n{2,}/).flatMap(block => {
    if (block.length <= 420) return [block];
    const sentences = block.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g) || [block];
    const chunks = []; let current = '';
    for (const s of sentences) {
      if ((current + s).length > 360 && current) { chunks.push(current.trim()); current = s; } else current += s;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  });
  return blocks.map(x => x.trim()).filter(Boolean);
}
function detectLang(text) {
  if (state.languageMode !== 'auto') return state.languageMode;
  const jp = (text.match(/[ぁ-んァ-ン一-龯]/g) || []).length;
  const en = (text.match(/[A-Za-z]/g) || []).length;
  return jp >= en * .18 ? 'ja-JP' : 'en-US';
}
function formatType(type) { return ({pdf:'PDF',docx:'WORD',epub:'EPUB',txt:'TEXT',md:'MARKDOWN',paste:'PASTE'})[type] || type.toUpperCase(); }
function makeId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }

async function parsePDF(file) {
  const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let p=1; p<=pdf.numPages; p++) {
    const page = await pdf.getPage(p); const content = await page.getTextContent();
    pages.push(content.items.map(i => i.str).join(' '));
  }
  return pages.join('\n\n');
}
async function parseDOCX(file) {
  if (!window.mammoth) throw new Error('Word読込ライブラリを読み込めませんでした');
  const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value;
}
async function parseEPUB(file) {
  if (!window.JSZip) throw new Error('EPUB読込ライブラリを読み込めませんでした');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = await zip.file('META-INF/container.xml').async('text');
  const rootPath = new DOMParser().parseFromString(container,'application/xml').querySelector('rootfile')?.getAttribute('full-path');
  if (!rootPath) throw new Error('EPUBの構造を認識できません');
  const opfText = await zip.file(rootPath).async('text');
  const opf = new DOMParser().parseFromString(opfText,'application/xml');
  const manifest = {};
  opf.querySelectorAll('manifest item').forEach(i => manifest[i.getAttribute('id')] = i.getAttribute('href'));
  const spineIds = [...opf.querySelectorAll('spine itemref')].map(i => i.getAttribute('idref'));
  const base = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/')+1) : '';
  const textParts = [];
  for (const id of spineIds) {
    const href = manifest[id]; if (!href) continue;
    const entry = zip.file(decodeURIComponent(base + href)); if (!entry) continue;
    const html = await entry.async('text');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,nav').forEach(n => n.remove());
    const paragraphs = [...doc.body.querySelectorAll('h1,h2,h3,h4,p,li,blockquote')].map(n => n.textContent.trim()).filter(Boolean);
    textParts.push(paragraphs.join('\n\n') || doc.body.textContent);
  }
  return textParts.join('\n\n');
}
async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  let text;
  if (ext === 'pdf') text = await parsePDF(file);
  else if (ext === 'docx') text = await parseDOCX(file);
  else if (ext === 'epub') text = await parseEPUB(file);
  else if (['txt','md'].includes(ext)) text = await file.text();
  else throw new Error(`${ext}形式には対応していません`);
  const paragraphs = splitText(text);
  if (!paragraphs.length) throw new Error('読み上げ可能な文字を取得できませんでした');
  return { id: makeId(), title: file.name.replace(/\.[^.]+$/, ''), type: ext, paragraphs, position: 0, createdAt: Date.now(), updatedAt: Date.now() };
}

async function addFiles(files) {
  for (const file of files) {
    toast(`${file.name} を読み込んでいます`);
    try {
      const doc = await parseFile(file); await dbPut(doc); state.documents.unshift(doc); renderLibrary(); selectDocument(doc.id); toast(`${file.name} を追加しました`);
    } catch (e) { console.error(e); toast(`${file.name}: ${e.message}`); }
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ rate: state.rate, voiceURI: state.voiceURI, languageMode: state.languageMode, fontSize: state.fontSize }));
}
function loadSettings() {
  try { Object.assign(state, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch {}
  $('rateSlider').value = state.rate; $('rateOutput').value = `${Number(state.rate).toFixed(1)}×`; $('languageMode').value = state.languageMode;
  $('documentText').style.fontSize = `${state.fontSize}rem`;
}
function currentDoc() { return state.documents.find(d => d.id === state.currentId); }
function renderLibrary() {
  $('libraryCount').textContent = `${state.documents.length}冊`;
  $('libraryList').innerHTML = '';
  const query = state.libraryQuery.trim().toLowerCase();
  for (const doc of state.documents.filter(d => !query || d.title.toLowerCase().includes(query))) {
    const pct = doc.paragraphs.length ? Math.round((doc.position || 0) / Math.max(1, doc.paragraphs.length-1) * 100) : 0;
    const btn = document.createElement('button'); btn.className = `book-card${doc.id === state.currentId ? ' active' : ''}`;
    btn.innerHTML = `<span class="book-title"></span><span class="book-meta"><span>${formatType(doc.type)}</span><span>${pct}%</span></span>`;
    btn.querySelector('.book-title').textContent = doc.title; btn.onclick = () => selectDocument(doc.id); $('libraryList').appendChild(btn);
  }
}
function selectDocument(id) {
  stopSpeech(); state.currentId = id; const doc = currentDoc(); if (!doc) return;
  state.index = Math.min(doc.position || 0, doc.paragraphs.length-1);
  $('emptyState').hidden = true; $('reader').hidden = false; $('fixedPlayer').hidden = false; $('documentTitle').textContent = doc.title; $('fixedPlayerTitle').textContent = doc.title;
  if (window.innerWidth <= 820) setMobileView('reader');
  $('documentMeta').textContent = `${formatType(doc.type)} · ${doc.paragraphs.length}段落`;
  $('progressSlider').max = Math.max(0, doc.paragraphs.length-1); renderDocumentText(); updatePositionUI(); renderLibrary();
}
function renderDocumentText() {
  const doc = currentDoc(); const host = $('documentText'); host.innerHTML = '';
  doc.paragraphs.forEach((text, i) => { const p = document.createElement('p'); p.className = 'paragraph'; p.dataset.index=i; p.textContent=text; p.onclick=()=>{ state.index=i; updatePositionUI(); }; host.appendChild(p); });
}
function updatePositionUI(scroll=false) {
  const doc = currentDoc(); if (!doc) return;
  $('progressSlider').value = state.index; $('positionLabel').textContent = `${state.index+1} / ${doc.paragraphs.length}`;
  $('percentLabel').textContent = `${Math.round((state.index+1)/doc.paragraphs.length*100)}%`; $('nowReading').textContent = doc.paragraphs[state.index] || '';
  document.querySelectorAll('.paragraph').forEach((p,i)=>p.classList.toggle('active', i===state.index));
  if (scroll) document.querySelector(`.paragraph[data-index="${state.index}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' });
  doc.position=state.index; doc.updatedAt=Date.now(); dbPut(doc); renderLibrary();
}
function findVoice(lang) {
  const selected = state.voices.find(v => v.voiceURI === state.voiceURI && v.lang.toLowerCase().startsWith(lang.slice(0,2).toLowerCase()));
  return selected || state.voices.find(v => v.lang.toLowerCase().startsWith(lang.slice(0,2).toLowerCase())) || null;
}
function updatePlaybackControls() {
  const hasDocument = Boolean(state.currentId && currentDoc());
  $('fixedPlayer').hidden = !hasDocument;
  if (!hasDocument) return;
  const activelyPlaying = state.playing && !state.paused;
  $('playButton').textContent = activelyPlaying ? 'Ⅱ' : '▶';
  $('fixedPlayButton').disabled = activelyPlaying;
  $('fixedPauseButton').disabled = !activelyPlaying;
  $('fixedPlayerStatus').textContent = activelyPlaying ? `${state.index + 1} / ${currentDoc().paragraphs.length} · 再生中` : (state.paused ? '一時停止中' : `${state.index + 1} / ${currentDoc().paragraphs.length} · 停止中`);
}
function playSpeech() {
  if (!state.currentId) return;
  if (state.playing && state.paused) {
    speechSynthesis.resume();
    state.paused = false;
    updatePlaybackControls();
  } else if (!state.playing) {
    speakCurrent();
  }
}
function pauseSpeech() {
  if (state.playing && !state.paused) {
    speechSynthesis.pause();
    state.paused = true;
    updatePlaybackControls();
  }
}
function speakCurrent() {
  const doc = currentDoc(); if (!doc || !('speechSynthesis' in window)) return toast('このブラウザーは音声読み上げに対応していません');
  speechSynthesis.cancel();
  const text = doc.paragraphs[state.index]; const lang = detectLang(text); const utter = new SpeechSynthesisUtterance(text);
  utter.lang=lang; utter.rate=state.rate; const voice=findVoice(lang); if (voice) utter.voice=voice;
  utter.onend=()=>{ if (!state.playing) return; if (state.index < doc.paragraphs.length-1) { state.index++; updatePositionUI(true); setTimeout(speakCurrent, 120); } else { stopSpeech(); toast('最後まで読み終わりました'); } };
  utter.onerror=(event)=>{ if (event.error !== 'canceled' && event.error !== 'interrupted') toast(`音声エラー: ${event.error}`); };
  state.playing=true; state.paused=false; speechSynthesis.speak(utter); updatePlaybackControls(); updatePositionUI(true);
}
function togglePlay() {
  if (state.playing && !state.paused) pauseSpeech();
  else playSpeech();
}
function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  state.playing=false; state.paused=false;
  updatePlaybackControls();
}
function shiftPosition(delta) { const doc=currentDoc(); if(!doc)return; stopSpeech(); state.index=Math.max(0,Math.min(doc.paragraphs.length-1,state.index+delta)); updatePositionUI(true); }
function loadVoices() {
  state.voices = speechSynthesis.getVoices().filter(v => /^ja|^en/i.test(v.lang));
  const select=$('voiceSelect'); select.innerHTML='<option value="">端末の標準音声</option>';
  state.voices.sort((a,b)=>a.lang.localeCompare(b.lang)||a.name.localeCompare(b.name)).forEach(v=>{ const o=document.createElement('option'); o.value=v.voiceURI; o.textContent=`${v.name} (${v.lang})`; select.appendChild(o); });
  select.value=state.voiceURI;
}
function setSleepTimer(minutes) {
  clearTimeout(state.sleepTimeout); state.sleepTimeout=null;
  if (minutes>0) { state.sleepTimeout=setTimeout(()=>{ stopSpeech(); $('sleepTimer').value='0'; toast('スリープタイマーで停止しました'); },minutes*60000); toast(`${minutes}分後に停止します`); }
}

$('fileInput').addEventListener('change', e => addFiles([...e.target.files]));
['dragenter','dragover'].forEach(type=>$('dropzone').addEventListener(type,e=>{e.preventDefault();$('dropzone').classList.add('dragging');}));
['dragleave','drop'].forEach(type=>$('dropzone').addEventListener(type,e=>{$('dropzone').classList.remove('dragging');}));
$('dropzone').addEventListener('drop',e=>{e.preventDefault();addFiles([...e.dataTransfer.files]);});
$('addPasteButton').onclick=async()=>{ const text=$('pasteText').value.trim(); if(!text)return toast('文章を入力してください'); const doc={id:makeId(),title:$('pasteTitle').value.trim()||'貼り付け文章',type:'paste',paragraphs:splitText(text),position:0,createdAt:Date.now(),updatedAt:Date.now()}; await dbPut(doc);state.documents.unshift(doc);$('pasteText').value='';$('pasteTitle').value='';renderLibrary();selectDocument(doc.id);toast('文章を追加しました'); };
$('playButton').onclick=togglePlay; $('fixedPlayButton').onclick=playSpeech; $('fixedPauseButton').onclick=pauseSpeech; $('prevButton').onclick=()=>shiftPosition(-1); $('nextButton').onclick=()=>shiftPosition(1); $('fixedPrevButton').onclick=()=>shiftPosition(-1); $('fixedNextButton').onclick=()=>shiftPosition(1);
$('progressSlider').oninput=e=>{stopSpeech();state.index=Number(e.target.value);updatePositionUI(true);};
$('rateSlider').oninput=e=>{state.rate=Number(e.target.value);$('rateOutput').value=`${state.rate.toFixed(1)}×`;saveSettings();if(state.playing)speakCurrent();};
$('voiceSelect').onchange=e=>{state.voiceURI=e.target.value;saveSettings();if(state.playing)speakCurrent();};
$('languageMode').onchange=e=>{state.languageMode=e.target.value;saveSettings();if(state.playing)speakCurrent();};
$('sleepTimer').onchange=e=>setSleepTimer(Number(e.target.value));
$('fontDown').onclick=()=>{state.fontSize=Math.max(.85,state.fontSize-.1);$('documentText').style.fontSize=`${state.fontSize}rem`;saveSettings();};
$('fontUp').onclick=()=>{state.fontSize=Math.min(1.8,state.fontSize+.1);$('documentText').style.fontSize=`${state.fontSize}rem`;saveSettings();};
$('copyText').onclick=async()=>{await navigator.clipboard.writeText(currentDoc().paragraphs.join('\n\n'));toast('全文をコピーしました');};
$('deleteDocumentButton').onclick=async()=>{const doc=currentDoc();if(!doc)return;if(!confirm(`「${doc.title}」を削除しますか？`))return;stopSpeech();await dbDelete(doc.id);state.documents=state.documents.filter(d=>d.id!==doc.id);state.currentId=null;$('reader').hidden=true;$('emptyState').hidden=false;$('fixedPlayer').hidden=true;renderLibrary();};
$('clearLibraryButton').onclick=async()=>{if(!state.documents.length||!confirm('すべての書類を削除しますか？'))return;stopSpeech();await dbClear();state.documents=[];state.currentId=null;$('reader').hidden=true;$('emptyState').hidden=false;$('fixedPlayer').hidden=true;renderLibrary();};

function setMobileView(view) {
  document.body.classList.toggle('mobile-reader', view === 'reader');
  document.body.classList.toggle('mobile-library', view === 'library');
  $('showLibraryButton')?.classList.toggle('active', view === 'library');
  $('showReaderButton')?.classList.toggle('active', view === 'reader');
  if (view === 'reader' && !state.currentId) toast('本棚から書類を選んでください');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('showLibraryButton').onclick = () => setMobileView('library');
$('showReaderButton').onclick = () => setMobileView('reader');
$('librarySearch').oninput = (event) => { state.libraryQuery = event.target.value; renderLibrary(); };
window.addEventListener('resize', () => {
  if (window.innerWidth > 820) document.body.classList.remove('mobile-reader', 'mobile-library');
  else if (!document.body.classList.contains('mobile-reader') && !document.body.classList.contains('mobile-library')) setMobileView(state.currentId ? 'reader' : 'library');
});

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;$('installButton').hidden=false;});
$('installButton').onclick=async()=>{if(!state.installPrompt)return;state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;$('installButton').hidden=true;};
window.addEventListener('pagehide',()=>{const doc=currentDoc();if(doc)dbPut(doc);});

async function init() {
  loadSettings(); state.documents=(await dbAll()).sort((a,b)=>b.updatedAt-a.updatedAt); renderLibrary();
  if (window.innerWidth <= 820) setMobileView(state.documents.length ? 'reader' : 'library');
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged=loadVoices; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(console.error);
  if (state.documents.length) selectDocument(state.documents[0].id);
}
init().catch(e=>{console.error(e);toast('アプリの初期化に失敗しました');});
