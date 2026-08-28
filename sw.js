const CACHE = 'atendimentos-supabase-v1';
const ASSETS = ['./index.html', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  e.respondWith(
    caches.match(e.request).then(cached=>{
      return cached || fetch(e.request).then(res=>{
        return caches.open(CACHE).then(c=>{
          c.put(e.request, res.clone());
          return res;
        });
      }).catch(()=>cached);
    })
  );
});

// mostra a notificação de verdade quando chega um push (o servidor manda
// { title, body, url } — veja enviarPushParaContas no backend)
self.addEventListener('push', e=>{
  let dados = {};
  try{ dados = e.data ? e.data.json() : {}; }catch(_e){ dados = {}; }
  const titulo = dados.title || 'Controle de Atendimentos';
  e.waitUntil(
    self.registration.showNotification(titulo, {
      body: dados.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { url: dados.url || './' }
    })
  );
});

self.addEventListener('notificationclick', e=>{
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista=>{
      for(const cliente of lista){
        if('focus' in cliente) return cliente.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
