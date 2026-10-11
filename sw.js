const CACHE='bill-tool-v4';
const ASSETS=['./','./style.css?v=4','./app.js?v=4','./manifest.json'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('bill-tool-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==location.origin)return;
  if(url.pathname==='/api/classify')return;
  // Check the network first so deployed fixes become visible; use the cached shell offline.
  event.respondWith(fetch(request).then(response=>{
    if(response.ok&&url.pathname!=='/sw.js'){
      const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));
    }
    return response;
  }).catch(()=>caches.match(request).then(cached=>cached||caches.match(url.pathname.endsWith('/app.js')?'./app.js?v=4':url.pathname.endsWith('/style.css')?'./style.css?v=4':request))));
});
