const CACHE = 'atendimentos-supabase-v2';
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

// network-first: sempre busca a versão nova quando tem internet (esse app
// muda com frequência — cache-first já deixou gente vendo tela antiga por
// dias) e só usa o cache como fallback quando estiver offline de verdade.
// POST (chamadas da API) nem passa por aqui — Cache API só aceita GET.
self.addEventListener('fetch', e=>{
  if(e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res=>{
      const copia = res.clone();
      caches.open(CACHE).then(c=>c.put(e.request, copia));
      return res;
    }).catch(()=>caches.match(e.request))
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
