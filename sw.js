/* Our Love Journal — service worker
   Makes the app installable, fast to open, readable offline,
   and receives photos shared from the Android share sheet. */

var VERSION = "v1";
var SHELL   = "lj-shell-" + VERSION;   // the app itself: page, config, fonts, library
var DATA    = "lj-data-"  + VERSION;   // last known entries / notes / profiles
var MEDIA   = "lj-media-" + VERSION;   // photos you've already looked at
var SHARED  = "lj-shared";             // photos handed over by the share sheet
var MEDIA_MAX = 150;                   // keep the photo cache from growing forever

var SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", function(ev){
  ev.waitUntil(
    caches.open(SHELL).then(function(c){
      // one missing file shouldn't fail the whole install
      return Promise.all(SHELL_FILES.map(function(u){
        return c.add(new Request(u, {cache:"reload"})).catch(function(){});
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(ev){
  ev.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k !== SHELL && k !== DATA && k !== MEDIA && k !== SHARED) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* ---------- strategies ---------- */

function networkFirst(req, cacheName){
  return fetch(req).then(function(res){
    if(res && res.ok){
      var copy=res.clone();
      caches.open(cacheName).then(function(c){ c.put(req, copy); });
    }
    return res;
  }).catch(function(){
    return caches.match(req).then(function(hit){
      return hit || caches.match("./index.html");
    });
  });
}

function cacheFirst(req, cacheName, key){
  var k = key || req;
  return caches.match(k).then(function(hit){
    if(hit) return hit;
    return fetch(req).then(function(res){
      if(res && (res.ok || res.type==="opaque")){
        var copy=res.clone();
        caches.open(cacheName).then(function(c){
          c.put(k, copy);
          if(cacheName===MEDIA) trim(c, MEDIA_MAX);
        });
      }
      return res;
    });
  });
}

function trim(cache, max){
  cache.keys().then(function(keys){
    if(keys.length<=max) return;
    for(var i=0;i<keys.length-max;i++) cache.delete(keys[i]);
  });
}

/* ---------- share target: photos arriving from another app ---------- */

function receiveShare(ev){
  ev.respondWith((async function(){
    try{
      var form = await ev.request.formData();
      var files = form.getAll("photos") || [];
      var cache = await caches.open(SHARED);
      var old = await cache.keys();
      await Promise.all(old.map(function(k){ return cache.delete(k); }));
      var n=0;
      for(var i=0;i<files.length;i++){
        var f=files[i];
        if(!f || !f.type || f.type.indexOf("image/")!==0) continue;
        await cache.put("./__shared/"+n, new Response(f, {headers:{
          "Content-Type": f.type,
          "X-Name": encodeURIComponent(f.name||("photo-"+n+".jpg"))
        }}));
        n++;
      }
      return Response.redirect("./?shared="+n, 303);
    }catch(e){
      return Response.redirect("./?shared=0", 303);
    }
  })());
}

/* ---------- routing ---------- */

self.addEventListener("fetch", function(ev){
  var req = ev.request;
  var url = new URL(req.url);

  // photos shared into the app
  if(req.method==="POST" && url.searchParams.has("shared")){ receiveShare(ev); return; }

  if(req.method!=="GET") return;                         // writes always go to the network

  // the page itself: fresh when online, cached copy when not
  if(req.mode==="navigate"){ ev.respondWith(networkFirst(req, SHELL)); return; }

  var sameOrigin = url.origin===self.location.origin;

  if(sameOrigin){
    if(/\/(index\.html|config\.js|manifest\.webmanifest)$/.test(url.pathname)){
      ev.respondWith(networkFirst(req, SHELL)); return;
    }
    if(url.pathname.indexOf("/")>-1){ ev.respondWith(cacheFirst(req, SHELL)); return; }
    return;
  }

  // fonts and the Supabase library never change at a given URL
  if(/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || /cdn\.jsdelivr\.net$/.test(url.hostname)){
    ev.respondWith(cacheFirst(req, SHELL)); return;
  }

  // photos: signed links change every hour, so cache them by path and ignore the token
  if(url.pathname.indexOf("/storage/v1/object")>-1){
    ev.respondWith(cacheFirst(req, MEDIA, url.origin+url.pathname)); return;
  }

  // entries, notes, profiles: show the last known copy if the network is gone
  if(url.pathname.indexOf("/rest/v1/")>-1){
    ev.respondWith(
      fetch(req).then(function(res){
        if(res && res.ok){
          var copy=res.clone();
          caches.open(DATA).then(function(c){ c.put(url.href, copy); });
        }
        return res;
      }).catch(function(){
        return caches.match(url.href).then(function(hit){
          return hit || new Response("[]", {status:200, headers:{"Content-Type":"application/json"}});
        });
      })
    );
    return;
  }
});
