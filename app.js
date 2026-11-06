// ============================================================
//  Kikitori Reader — app.js
//  ローカル保存(IndexedDB) + クラウド同期(Firebase) 両対応
// ============================================================

// ── Firebase SDK (CDN / ESM) ───────────────────────────────
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, getDocs,
  onSnapshot, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const DB_NAME = 'kikitori-reader-db';
const STORE = 'documents';
const SETTINGS_KEY = 'kikitori-settings-v1';

const $ = (id) => document.getElementById(id);
const state = {
  documents: [], currentId: null, index: 0, playing: false, paused: false,
  voices: [], rate: 1, voiceURI: '', languageMode: 'auto', fontSize: 1.13,
  sleepTimeout: null, installPrompt: null, libraryQuery: ''
};

// ── 同期まわりの状態 ────────────────────────────────────────
const cloud = {
  enabled: false,     // Firebase設定が入っているか
  app: null, auth: null, db: null,
  uid: null,          // ログイン中ユーザー
  unsubDocs: null,    // Firestoreリスナー解除関数
  authMode: 'login',  // 'login' | 'signup'
  posTimers: {}       // 読書位置保存のデバウンス用
};

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function setSyncStatus(kind, label) {
  const el = $('syncStatus');
  if (!cloud.enabled) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `sync-status ${kind}`;
  el.textContent = label;
}

// ── IndexedDB（ローカルキャッシュ兼オフライン保存） ─────────
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
async function idbAll() { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbPut(doc) { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,'readwrite').objectStore(STORE).put(doc); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
async function idbDelete(id) { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,'readwrite').objectStore(STORE).delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
async function idbClear() { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,'readwrite').objectStore(STORE).clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }

// ── 保存の抽象化：クラウド時はFirestore、そうでなければIndexedDB ──
async function persistDoc(document) {
  await idbPut(document);                    // いつでもローカルにもキャッシュ
  if (cloud.uid) {
    try {
      await setDoc(doc(cloud.db, 'users', cloud.uid, 'documents', document.id), document);
    } catch (e) { console.error('cloud put failed', e); setSyncStatus('offline', '同期待ち'); }
  }
}
async function persistDocPositionDebounced(document) {
  // 読書位置の更新は頻繁なので、ローカルは即時・クラウドは少し待ってから
  await idbPut(document);
  if (!cloud.uid) return;
  clearTimeout(cloud.posTimers[document.id]);
  cloud.posTimers[document.id] = setTimeout(async () => {
    try {
      await setDoc(doc(cloud.db, 'users', cloud.uid, 'documents', document.id),
        { position: document.position, updatedAt: document.updatedAt }, { merge: true });
    } catch (e) { console.error('cloud position failed', e); }
  }, 1200);
}
async function removeDoc(id) {
  await idbDelete(id);
  if (cloud.uid) { try { await deleteDoc(doc(cloud.db, 'users', cloud.uid, 'documents', id)); } catch (e) { console.error(e); } }
}
async function removeAllDocs() {
  await idbClear();
  if (cloud.uid) {
    try {
      const snap = await getDocs(collection(cloud.db, 'users', cloud.uid, 'documents'));
      const batch = writeBatch(cloud.db);
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
    } catch (e) { console.error(e); }
  }
}

// ── テキスト処理（変更なし） ────────────────────────────────
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
    const docp = new DOMParser().parseFromString(html, 'text/html');
    docp.querySelectorAll('script,style,nav').forEach(n => n.remove());
    const paragraphs = [...docp.body.querySelectorAll('h1,h2,h3,h4,p,li,blockquote')].map(n => n.textContent.trim()).filter(Boolean);
    textParts.push(paragraphs.join('\n\n') || docp.body.textContent);
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
      const document = await parseFile(file);
      await persistDoc(document);
      state.documents.unshift(document); renderLibrary(); selectDocument(document.id); toast(`${file.name} を追加しました`);
    } catch (e) { console.error(e); toast(`${file.name}: ${e.message}`); }
  }
}

// ── 設定の保存：クラウド時はFirestoreにも ──────────────────
function saveSettings() {
  const payload = { rate: state.rate, voiceURI: state.voiceURI, languageMode: state.languageMode, fontSize: state.fontSize };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
  if (cloud.uid) {
    clearTimeout(cloud.settingsTimer);
    cloud.settingsTimer = setTimeout(() => {
      setDoc(doc(cloud.db, 'users', cloud.uid, 'meta', 'settings'), payload).catch(console.error);
    }, 600);
  }
}
function applySettingsToUI() {
  $('rateSlider').value = state.rate; $('rateOutput').value = `${Number(state.rate).toFixed(1)}×`; $('languageMode').value = state.languageMode;
  $('voiceSelect').value = state.voiceURI;
  $('documentText').style.fontSize = `${state.fontSize}rem`;
}
function loadSettingsLocal() {
  try { Object.assign(state, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch {}
  applySettingsToUI();
}

function currentDoc() { return state.documents.find(d => d.id === state.currentId); }
function renderLibrary() {
  $('libraryCount').textContent = `${state.documents.length}冊`;
  $('libraryList').innerHTML = '';
  const query = state.libraryQuery.trim().toLowerCase();
  for (const document of state.documents.filter(d => !query || d.title.toLowerCase().includes(query))) {
    const pct = document.paragraphs.length ? Math.round((document.position || 0) / Math.max(1, document.paragraphs.length-1) * 100) : 0;
    const btn = window.document.createElement('button'); btn.className = `book-card${document.id === state.currentId ? ' active' : ''}`;
    btn.innerHTML = `<span class="book-title"></span><span class="book-meta"><span>${formatType(document.type)}</span><span>${pct}%</span></span>`;
    btn.querySelector('.book-title').textContent = document.title; btn.onclick = () => selectDocument(document.id); $('libraryList').appendChild(btn);
  }
}
function selectDocument(id) {
  stopSpeech(); state.currentId = id; const d = currentDoc(); if (!d) return;
  state.index = Math.min(d.position || 0, d.paragraphs.length-1);
  $('emptyState').hidden = true; $('reader').hidden = false; $('fixedPlayer').hidden = false; $('documentTitle').textContent = d.title; $('fixedPlayerTitle').textContent = d.title;
  if (window.innerWidth <= 820) setMobileView('reader');
  $('documentMeta').textContent = `${formatType(d.type)} · ${d.paragraphs.length}段落`;
  $('progressSlider').max = Math.max(0, d.paragraphs.length-1); renderDocumentText(); updatePositionUI(); renderLibrary();
}
function renderDocumentText() {
  const d = currentDoc(); const host = $('documentText'); host.innerHTML = '';
  d.paragraphs.forEach((text, i) => { const p = window.document.createElement('p'); p.className = 'paragraph'; p.dataset.index=i; p.textContent=text; p.onclick=()=>{ state.index=i; updatePositionUI(); }; host.appendChild(p); });
}
function updatePositionUI(scroll=false) {
  const d = currentDoc(); if (!d) return;
  $('progressSlider').value = state.index; $('positionLabel').textContent = `${state.index+1} / ${d.paragraphs.length}`;
  $('percentLabel').textContent = `${Math.round((state.index+1)/d.paragraphs.length*100)}%`; $('nowReading').textContent = d.paragraphs[state.index] || '';
  document.querySelectorAll('.paragraph').forEach((p,i)=>p.classList.toggle('active', i===state.index));
  if (scroll) document.querySelector(`.paragraph[data-index="${state.index}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' });
  d.position=state.index; d.updatedAt=Date.now(); persistDocPositionDebounced(d); renderLibrary();
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
  if (state.playing && state.paused) { speechSynthesis.resume(); state.paused = false; updatePlaybackControls(); }
  else if (!state.playing) { speakCurrent(); }
}
function pauseSpeech() {
  if (state.playing && !state.paused) { speechSynthesis.pause(); state.paused = true; updatePlaybackControls(); }
}
function speakCurrent() {
  const d = currentDoc(); if (!d || !('speechSynthesis' in window)) return toast('このブラウザーは音声読み上げに対応していません');
  speechSynthesis.cancel();
  const text = d.paragraphs[state.index]; const lang = detectLang(text); const utter = new SpeechSynthesisUtterance(text);
  utter.lang=lang; utter.rate=state.rate; const voice=findVoice(lang); if (voice) utter.voice=voice;
  utter.onend=()=>{ if (!state.playing) return; if (state.index < d.paragraphs.length-1) { state.index++; updatePositionUI(true); setTimeout(speakCurrent, 120); } else { stopSpeech(); toast('最後まで読み終わりました'); } };
  utter.onerror=(event)=>{ if (event.error !== 'canceled' && event.error !== 'interrupted') toast(`音声エラー: ${event.error}`); };
  state.playing=true; state.paused=false; speechSynthesis.speak(utter); updatePlaybackControls(); updatePositionUI(true);
}
function togglePlay() { if (state.playing && !state.paused) pauseSpeech(); else playSpeech(); }
function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  state.playing=false; state.paused=false; updatePlaybackControls();
}
function shiftPosition(delta) { const d=currentDoc(); if(!d)return; stopSpeech(); state.index=Math.max(0,Math.min(d.paragraphs.length-1,state.index+delta)); updatePositionUI(true); }
function loadVoices() {
  state.voices = speechSynthesis.getVoices().filter(v => /^ja|^en/i.test(v.lang));
  const select=$('voiceSelect'); select.innerHTML='<option value="">端末の標準音声</option>';
  state.voices.sort((a,b)=>a.lang.localeCompare(b.lang)||a.name.localeCompare(b.name)).forEach(v=>{ const o=window.document.createElement('option'); o.value=v.voiceURI; o.textContent=`${v.name} (${v.lang})`; select.appendChild(o); });
  select.value=state.voiceURI;
}
function setSleepTimer(minutes) {
  clearTimeout(state.sleepTimeout); state.sleepTimeout=null;
  if (minutes>0) { state.sleepTimeout=setTimeout(()=>{ stopSpeech(); $('sleepTimer').value='0'; toast('スリープタイマーで停止しました'); },minutes*60000); toast(`${minutes}分後に停止します`); }
}

// ── イベント結線 ────────────────────────────────────────────
$('fileInput').addEventListener('change', e => addFiles([...e.target.files]));
['dragenter','dragover'].forEach(type=>$('dropzone').addEventListener(type,e=>{e.preventDefault();$('dropzone').classList.add('dragging');}));
['dragleave','drop'].forEach(type=>$('dropzone').addEventListener(type,e=>{$('dropzone').classList.remove('dragging');}));
$('dropzone').addEventListener('drop',e=>{e.preventDefault();addFiles([...e.dataTransfer.files]);});
$('addPasteButton').onclick=async()=>{ const text=$('pasteText').value.trim(); if(!text)return toast('文章を入力してください'); const d={id:makeId(),title:$('pasteTitle').value.trim()||'貼り付け文章',type:'paste',paragraphs:splitText(text),position:0,createdAt:Date.now(),updatedAt:Date.now()}; await persistDoc(d);state.documents.unshift(d);$('pasteText').value='';$('pasteTitle').value='';renderLibrary();selectDocument(d.id);toast('文章を追加しました'); };
$('playButton').onclick=togglePlay; $('fixedPlayButton').onclick=playSpeech; $('fixedPauseButton').onclick=pauseSpeech; $('prevButton').onclick=()=>shiftPosition(-1); $('nextButton').onclick=()=>shiftPosition(1); $('fixedPrevButton').onclick=()=>shiftPosition(-1); $('fixedNextButton').onclick=()=>shiftPosition(1);
$('progressSlider').oninput=e=>{stopSpeech();state.index=Number(e.target.value);updatePositionUI(true);};
$('rateSlider').oninput=e=>{state.rate=Number(e.target.value);$('rateOutput').value=`${state.rate.toFixed(1)}×`;saveSettings();if(state.playing)speakCurrent();};
$('voiceSelect').onchange=e=>{state.voiceURI=e.target.value;saveSettings();if(state.playing)speakCurrent();};
$('languageMode').onchange=e=>{state.languageMode=e.target.value;saveSettings();if(state.playing)speakCurrent();};
$('sleepTimer').onchange=e=>setSleepTimer(Number(e.target.value));
$('fontDown').onclick=()=>{state.fontSize=Math.max(.85,state.fontSize-.1);$('documentText').style.fontSize=`${state.fontSize}rem`;saveSettings();};
$('fontUp').onclick=()=>{state.fontSize=Math.min(1.8,state.fontSize+.1);$('documentText').style.fontSize=`${state.fontSize}rem`;saveSettings();};
$('copyText').onclick=async()=>{await navigator.clipboard.writeText(currentDoc().paragraphs.join('\n\n'));toast('全文をコピーしました');};
$('deleteDocumentButton').onclick=async()=>{const d=currentDoc();if(!d)return;if(!confirm(`「${d.title}」を削除しますか？`))return;stopSpeech();await removeDoc(d.id);state.documents=state.documents.filter(x=>x.id!==d.id);state.currentId=null;$('reader').hidden=true;$('emptyState').hidden=false;$('fixedPlayer').hidden=true;renderLibrary();};
$('clearLibraryButton').onclick=async()=>{if(!state.documents.length||!confirm('すべての書類を削除しますか？'))return;stopSpeech();await removeAllDocs();state.documents=[];state.currentId=null;$('reader').hidden=true;$('emptyState').hidden=false;$('fixedPlayer').hidden=true;renderLibrary();};

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
window.addEventListener('pagehide',()=>{const d=currentDoc();if(d)idbPut(d);});

// ============================================================
//  認証 & クラウド同期
// ============================================================
function firebaseConfigured() {
  const c = window.FIREBASE_CONFIG || {};
  return Boolean(c.apiKey && c.projectId && c.appId);
}

function showAuthError(msg) { const el=$('authError'); el.textContent=msg; el.hidden=false; }
function clearAuthError() { $('authError').hidden=true; }

function renderAuthMode() {
  const isLogin = cloud.authMode === 'login';
  $('authTitle').textContent = isLogin ? 'ログイン' : '新規登録';
  $('authSubmit').textContent = isLogin ? 'ログイン' : '登録してはじめる';
  $('authToggle').textContent = isLogin
    ? 'アカウントをお持ちでない方はこちら（新規登録）'
    : 'すでにアカウントをお持ちの方はこちら（ログイン）';
  $('authPassword').autocomplete = isLogin ? 'current-password' : 'new-password';
  $('authReset').hidden = !isLogin;
}

function translateAuthError(code) {
  const map = {
    'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
    'auth/user-not-found': 'このメールアドレスのアカウントが見つかりません。新規登録してください。',
    'auth/wrong-password': 'パスワードが間違っています。',
    'auth/invalid-credential': 'メールアドレスまたはパスワードが間違っています。',
    'auth/email-already-in-use': 'このメールアドレスは既に登録されています。ログインしてください。',
    'auth/weak-password': 'パスワードは6文字以上にしてください。',
    'auth/too-many-requests': '試行回数が多すぎます。しばらく待ってから再度お試しください。',
    'auth/network-request-failed': 'ネットワークに接続できません。通信環境を確認してください。'
  };
  return map[code] || `エラーが発生しました（${code}）`;
}

async function handleAuthSubmit() {
  clearAuthError();
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || !password) return showAuthError('メールアドレスとパスワードを入力してください。');
  $('authSubmit').disabled = true;
  try {
    if (cloud.authMode === 'login') {
      await signInWithEmailAndPassword(cloud.auth, email, password);
    } else {
      await createUserWithEmailAndPassword(cloud.auth, email, password);
    }
  } catch (e) {
    showAuthError(translateAuthError(e.code || ''));
  } finally {
    $('authSubmit').disabled = false;
  }
}

async function handlePasswordReset() {
  clearAuthError();
  const email = $('authEmail').value.trim();
  if (!email) return showAuthError('パスワード再設定メールを送るメールアドレスを入力してください。');
  try {
    await sendPasswordResetEmail(cloud.auth, email);
    toast('パスワード再設定メールを送信しました。');
  } catch (e) { showAuthError(translateAuthError(e.code || '')); }
}

// ログイン成功後：既存ローカルデータをクラウドへ移行してから、リスナー開始
async function onSignedIn(user) {
  cloud.uid = user.uid;
  document.body.classList.remove('auth-locked');
  $('authGate').hidden = true;
  $('logoutButton').hidden = false;
  setSyncStatus('syncing', '同期中…');

  // 既存ローカルデータの移行（このアカウントのクラウドが空のときだけ）
  try {
    const cloudSnap = await getDocs(collection(cloud.db, 'users', cloud.uid, 'documents'));
    if (cloudSnap.empty) {
      const localDocs = await idbAll();
      if (localDocs.length) {
        toast(`${localDocs.length}冊をクラウドへ移行しています…`);
        const batch = writeBatch(cloud.db);
        localDocs.forEach(d => batch.set(doc(cloud.db, 'users', cloud.uid, 'documents', d.id), d));
        await batch.commit();
      }
    }
  } catch (e) { console.error('migration failed', e); }

  // クラウド設定の取り込み（あれば優先）
  try {
    const { getDoc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const s = await getDoc(doc(cloud.db, 'users', cloud.uid, 'meta', 'settings'));
    if (s.exists()) { Object.assign(state, s.data()); applySettingsToUI(); saveSettings(); }
  } catch (e) { console.error(e); }

  // リアルタイム同期開始：他端末の変更が自動で反映される
  startDocsListener();
}

function startDocsListener() {
  if (cloud.unsubDocs) cloud.unsubDocs();
  let firstSnapshot = true;
  cloud.unsubDocs = onSnapshot(
    collection(cloud.db, 'users', cloud.uid, 'documents'),
    (snap) => {
      const docs = [];
      snap.forEach(d => docs.push(d.data()));
      docs.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
      const openId = state.currentId;         // 再生中の本は維持
      state.documents = docs;
      docs.forEach(d => idbPut(d).catch(()=>{})); // ローカルにもキャッシュ

      if (openId && currentDoc()) {
        // 開いている本が他端末で読書位置だけ更新された場合、再生中でなければ位置を合わせる
        if (!state.playing) {
          const d = currentDoc();
          state.index = Math.min(d.position || 0, d.paragraphs.length - 1);
          updatePositionUI();
        }
        renderLibrary();
      } else if (openId && !currentDoc()) {
        // 開いていた本が他端末で削除された
        state.currentId = null; stopSpeech();
        $('reader').hidden = true; $('emptyState').hidden = false; $('fixedPlayer').hidden = true;
        renderLibrary();
      } else {
        renderLibrary();
      }

      // 初回スナップショットで、本があれば先頭（＝最後に触った本）を自動で開く
      if (firstSnapshot && !state.currentId && state.documents.length) {
        selectDocument(state.documents[0].id);
      }
      firstSnapshot = false;

      if (window.innerWidth <= 820) setMobileView(state.documents.length ? (state.currentId ? 'reader' : 'library') : 'library');
      setSyncStatus('synced', '同期済み');
    },
    (err) => { console.error('snapshot error', err); setSyncStatus('offline', 'オフライン'); }
  );
}

async function doLogout() {
  if (cloud.unsubDocs) { cloud.unsubDocs(); cloud.unsubDocs = null; }
  stopSpeech();
  try { await signOut(cloud.auth); } catch (e) { console.error(e); }
}

function onSignedOut() {
  cloud.uid = null;
  state.documents = []; state.currentId = null;
  renderLibrary();
  $('reader').hidden = true; $('emptyState').hidden = false; $('fixedPlayer').hidden = true;
  $('logoutButton').hidden = true;
  $('authGate').hidden = false;
  document.body.classList.add('auth-locked');
  setSyncStatus('local', '');
  renderAuthMode();
}

// ── 起動 ────────────────────────────────────────────────────
async function initLocalMode() {
  // Firebase未設定：従来どおり端末ローカルだけで動かす
  setSyncStatus('local', '');
  state.documents = (await idbAll()).sort((a,b)=>b.updatedAt-a.updatedAt);
  renderLibrary();
  if (window.innerWidth <= 820) setMobileView(state.documents.length ? 'reader' : 'library');
  if (state.documents.length) selectDocument(state.documents[0].id);
  $('emptyStateNote').textContent = 'この端末のブラウザー内に保存されます。（同期は未設定）';
}

function initCloudMode() {
  cloud.enabled = true;
  cloud.app = initializeApp(window.FIREBASE_CONFIG);
  cloud.auth = getAuth(cloud.app);
  cloud.db = getFirestore(cloud.app);
  $('emptyStateNote').textContent = 'ログイン中のアカウントに保存され、全端末で同期されます。';

  // 認証UIの結線
  $('authSubmit').onclick = handleAuthSubmit;
  $('authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit(); });
  $('authToggle').onclick = () => { cloud.authMode = cloud.authMode === 'login' ? 'signup' : 'login'; clearAuthError(); renderAuthMode(); };
  $('authReset').onclick = handlePasswordReset;
  $('logoutButton').onclick = doLogout;
  renderAuthMode();

  // ログイン状態の監視（端末をまたいでセッションは自動保持される）
  onAuthStateChanged(cloud.auth, (user) => {
    if (user) onSignedIn(user);
    else onSignedOut();
  });
}

async function init() {
  loadSettingsLocal();
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged=loadVoices; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(console.error);

  if (firebaseConfigured()) {
    initCloudMode();          // ログイン画面→同期モード
  } else {
    await initLocalMode();    // 従来のローカルモード
  }
}
init().catch(e=>{console.error(e);toast('アプリの初期化に失敗しました');});
