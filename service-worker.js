const CACHE='kikitori-reader-v4-sync';
const ASSETS=['./','./index.html','./styles.css','./app.js','./config.js','./manifest.webmanifest','./icons/icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  // Firebase 認証・Firestore・Googleの通信はキャッシュせず必ずネットワークへ
  const bypass=/(^|\.)googleapis\.com$|(^|\.)gstatic\.com$|(^|\.)firebaseio\.com$|(^|\.)firebaseapp\.com$|(^|\.)identitytoolkit|(^|\.)firestore/.test(url.hostname)
    || url.hostname.includes('firebase');
  if(bypass){ e.respondWith(fetch(e.request)); return; }
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return res;}).catch(()=>caches.match('./index.html'))));
});
