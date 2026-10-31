/* =====================================================================
   QuestTown — SERVICE WORKER (v217)

   A COSA SERVE. Due cose, e la seconda conta piu' della prima:
   1. rende il gioco INSTALLABILE (Chrome/Edge/Android mostrano «Installa»
      solo se c'e' un service worker con un gestore `fetch`);
   2. tiene in cache i ~21 MB del gioco (13 MB di pagina + Babylon), cosi'
      ogni dispositivo li scarica UNA volta e poi apre in un attimo, anche
      senza rete. Venticinque Chromebook che scaricano 21 MB insieme sulla
      rete della scuola e' esattamente il problema che si vuole evitare.

   ⚠️ CONVIVENZA CON STUDENTAPP. Il gioco sta nel repository english-town
   (giacomocreations.github.io/english-town/), StudentApp in /myclass/:
   perimetri diversi, quindi i due service worker non si scalzano. Ma
   l'ORIGINE e' la stessa (giacomocreations.github.io), e le cache del
   browser sono per origine: questo service worker VEDE anche quelle di
   StudentApp. Per questo:
     - il file si chiama et-sw.js e le cache cominciano tutte con "et-";
     - in pulizia si toccano SOLO le cache "et-": quelle di StudentApp mai;
     - la pagina lo registra sulla SUA cartella (o sul prefisso del nome
       file, se un giorno stesse in una cartella condivisa).

   ⚠️ AUDIO E VIDEO NON SI TOCCANO. audio/ (Beat Club) e video/ (ODEON)
   vanno in rete esattamente come prima: il film si carica a pezzi (Range)
   e la sequenza showPlay -> load -> loadeddata -> play dell'ODEON e'
   intoccabile. Un service worker in mezzo e' proprio il genere di cosa che
   la rompe, quindi qui non passano: nessun respondWith per loro.

   AGGIORNAMENTI SENZA TOCCARE QUESTO FILE. Il classico guaio dei service
   worker e' che servono la versione vecchia per sempre finche' non cambi
   il loro file. Qui no: per pubblicare una build nuova basta caricare
   index.html come sempre. A ogni apertura il gioco parte SUBITO dalla
   copia in cache e intanto si chiede al server, con una HEAD da pochi
   byte, se la pagina e' cambiata. Se si', la si scarica in background e
   si avvisa il giocatore; alla prossima apertura e' gia' la nuova.
   Questo file va ricaricato solo se si cambia il suo codice.
   ===================================================================== */
"use strict";

/* ⚠️ Cambiare questi nomi SOLO se cambia il formato di cosa ci sta dentro:
   un nome nuovo butta via la cache vecchia e si riscarica tutto. */
const C_APP = "et-app-v1";     // la pagina del gioco + le sue firme
const C_LIB = "et-lib-v2";     // Babylon, Firebase SDK, icone
/* ⚠️ v2, non v1 (v222). Il MANIFEST stava qui dentro, cache-first e SENZA
   scadenza: chi ha installato l'app quando il file diceva ancora "English
   Town" si e' portato dietro quel nome per sempre, perche' ogni apertura
   successiva leggeva la copia vecchia in cache invece di controllare il
   server — anche dopo che il file, sul server, diceva gia' QuestTown. Il
   nome cambiato la volta scorsa e quella prima non e' MAI arrivato al
   browser. Il manifest ora ha la sua funzione a parte (vedi isManifest),
   sempre di rete quando c'e' rete; qui restano solo le cose che davvero
   non cambiano da un giorno all'altro. Cambiare il nome della cache svuota
   quella vecchia (vedi activate) cosi' anche chi ha gia' installato riceve
   il manifest giusto alla prossima apertura, senza dover disinstallare.

/* la pagina da tenere in cache arriva dalla registrazione (?page=...):
   "" = cartella dedicata (english-town/), altrimenti il nome del file. */
const PAGE     = new URL(self.location.href).searchParams.get("page") || "";
const PAGE_URL = new URL(PAGE || "./", self.registration.scope).href;
const PAGE_PATH = new URL(PAGE_URL).pathname;
const META = (k) => new URL("__et_" + k + "__", self.registration.scope).href;

/* le librerie che la pagina carica con <script src>: tenute uguali agli
   URL dell'HTML. Se un giorno cambiano, la cache a runtime (isLib) prende
   comunque quelle nuove: questa lista serve solo a scaricarle in anticipo. */
const LIBS = [
  "https://cdn.jsdelivr.net/npm/babylonjs@8/babylon.js",
  "https://cdn.jsdelivr.net/npm/babylonjs-loaders@8/babylonjs.loaders.min.js",
  "https://cdn.jsdelivr.net/npm/babylonjs-gui@8/babylon.gui.min.js",
];
function isLib(u){
  return u.href.startsWith("https://cdn.jsdelivr.net/npm/babylonjs")
      || u.href.startsWith("https://www.gstatic.com/firebasejs/");   // SDK versionato: immutabile
}
function isPage(u){
  if(u.origin !== self.location.origin) return false;
  if(u.pathname === PAGE_PATH) return true;
  return PAGE_PATH.endsWith("/") && u.pathname === PAGE_PATH + "index.html";
}
function isIcon(u){
  return u.origin === self.location.origin && /\/et-icons\//.test(u.pathname);
}
function isManifest(u){
  return u.origin === self.location.origin && /\/et-manifest\.webmanifest$/.test(u.pathname);
}

/* ---------------------------------------------------------------- utilita' */
async function hashDi(resp){
  const buf = await resp.clone().arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function leggiMeta(cache, k){
  const r = await cache.match(META(k));
  return r ? r.text() : "";
}
/* ⚠️ la copia si RIFA pulita: una risposta arrivata dopo un redirect non
   si puo' usare per una navigazione (il browser la rifiuta), e GitHub
   Pages redirige /english-town -> /english-town/. */
async function conservaPagina(resp){
  const pulita = new Response(await resp.clone().blob(),
    { status: 200, statusText: "OK", headers: resp.headers });
  const hash = await hashDi(pulita);
  const app = await caches.open(C_APP);
  await app.put(PAGE_URL, pulita);
  await app.put(META("hash"), new Response(hash));
  return hash;
}
/* la firma leggera del server: ETag, o in mancanza Last-Modified */
function firmaDi(resp){
  return resp.headers.get("etag") || resp.headers.get("last-modified") || "";
}
async function precaricaLibrerie(forza){
  const lib = await caches.open(C_LIB);
  await Promise.all(LIBS.map(async (u) => {
    try{
      if(!forza && await lib.match(u)) return;
      const r = await fetch(u, { mode: "no-cors", cache: forza ? "reload" : "default" });
      if(r && (r.ok || r.type === "opaque")) await lib.put(u, r);
    }catch(e){}
  }));
}
async function avvisaTutti(msg){
  const cl = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  cl.forEach(c => { try{ c.postMessage(msg); }catch(e){} });
}

/* ------------------------------------------------------------ installazione */
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    try{
      /* no-cache = si rivalida col server: se la pagina e' gia' nella cache
         HTTP del browser (appena scaricata per aprirla) torna un 304 e i
         13 MB NON si riscaricano. */
      const r = await fetch(PAGE_URL, { cache: "no-cache" });
      if(r.ok){
        await conservaPagina(r);
        const f = firmaDi(r);
        if(f) await (await caches.open(C_APP)).put(META("firma"), new Response(f));
      }
    }catch(err){}
    await precaricaLibrerie(false);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const tieni = [C_APP, C_LIB];
    const nomi = await caches.keys();
    /* ⚠️ SOLO le nostre ("et-"): le cache di StudentApp non si toccano */
    await Promise.all(nomi.filter(n => n.startsWith("et-") && tieni.indexOf(n) < 0)
                          .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ------------------------------------------------- controllo novita' */
let ultimoControllo = 0;
async function controllaNovita(){
  const ora = Date.now();
  if(ora - ultimoControllo < 5 * 60 * 1000) return;      // una classe che apre insieme: una volta basta
  ultimoControllo = ora;
  const app = await caches.open(C_APP);
  let testa;
  try{ testa = await fetch(PAGE_URL, { method: "HEAD", cache: "no-store" }); }
  catch(e){ return; }                                     // offline: si gioca con la copia
  if(!testa.ok) return;
  const firma = firmaDi(testa);
  if(!firma) return;                                      // senza firma non si giudica niente
  if(firma === await leggiMeta(app, "firma")) return;     // uguale: niente da fare
  /* la firma e' cambiata. ⚠️ NON basta per dire "versione nuova": GitHub
     Pages ripubblica TUTTO il sito a ogni caricamento (anche quando cambi
     solo StudentApp), e la firma puo' cambiare a contenuto identico. Si
     scarica e si confronta l'IMPRONTA del contenuto: si avvisa solo se e'
     davvero diverso, cosi' non compare mai un «aggiornamento» fantasma. */
  let nuova;
  try{ nuova = await fetch(PAGE_URL, { cache: "no-store" }); }catch(e){ return; }
  if(!nuova.ok) return;
  const prima = await leggiMeta(app, "hash");
  const dopo = await conservaPagina(nuova);
  await app.put(META("firma"), new Response(firma));
  if(prima && dopo !== prima){
    precaricaLibrerie(true);                              // build nuova: si rinfrescano anche le librerie
    await avvisaTutti({ type: "et-update" });
  }
}

/* ------------------------------------------------------------------ fetch */
async function pagina(e){
  const app = await caches.open(C_APP);
  const hit = await app.match(PAGE_URL);
  if(hit){
    e.waitUntil(controllaNovita().catch(() => {}));
    return hit;
  }
  /* prima apertura sotto questo service worker (o cache svuotata) */
  try{
    /* si chiede sempre PAGE_URL, senza la query: il ?c=CODICE resta nella
       barra (la pagina lo legge da li') ma non entra mai in cache. */
    const r = await fetch(PAGE_URL, { cache: "no-cache" });
    if(r.ok) e.waitUntil(conservaPagina(r.clone()).catch(() => {}));
    return r.redirected ? new Response(await r.blob(), { status: 200, headers: r.headers }) : r;
  }catch(err){
    return new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
      "<body style='font:16px system-ui;background:#1d2a32;color:#fbf7ec;padding:24px'>" +
      "<h2>QuestTown</h2><p>Per la <b>prima</b> apertura serve la connessione a Internet. " +
      "Dopo, il gioco si apre anche senza.</p></body>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}
async function cacheFirst(req){
  const lib = await caches.open(C_LIB);
  const hit = await lib.match(req.url);
  if(hit) return hit;
  const r = await fetch(req);
  if(r && (r.ok || r.type === "opaque")) lib.put(req.url, r.clone()).catch(() => {});
  return r;
}
/* il manifest e' l'identita' dell'app (nome, icona, colori): a differenza
   delle librerie deve poter cambiare, quindi si chiede sempre al server
   prima. La copia in cache serve solo se il dispositivo e' offline in quel
   momento — non e' mai quella che decide cosa vede il browser. */
async function manifestDiRete(req){
  const lib = await caches.open(C_LIB);
  try{
    const r = await fetch(req, { cache: "no-cache" });
    if(r && r.ok) lib.put(req.url, r.clone()).catch(() => {});
    return r;
  }catch(e){
    const hit = await lib.match(req.url);
    if(hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if(req.method !== "GET") return;
  let u; try{ u = new URL(req.url); }catch(err){ return; }
  if(req.mode === "navigate" && isPage(u)){ e.respondWith(pagina(e)); return; }
  if(isManifest(u)){ e.respondWith(manifestDiRete(req)); return; }
  if(isLib(u) || isIcon(u)){ e.respondWith(cacheFirst(req)); return; }
  /* tutto il resto (Firebase, autenticazione, presenza...) va in rete come
     se il service worker non ci fosse: i dati vivi non si mettono in cache. */
});

/* la pagina puo' chiedere un controllo (tablet lasciati aperti ore) */
self.addEventListener("message", (e) => {
  if(e.data && e.data.type === "et-controlla"){
    ultimoControllo = 0;
    e.waitUntil(controllaNovita().catch(() => {}));
  }
});

/* ------------------------------------------------------------- notifiche
   v539 (Giacomo, 31 ott: «se apro una nuova unit, manda notifica a chi ha
   installato; se creo un evento nuovo, posso mandare notifica»).
   Il docente invia dal gioco (pannello docente) con FCM; qui arriva un push
   con i soli dati {title, body, tag, url} e la notifica la disegniamo noi,
   cosi' e' uguale su ogni browser. Niente SDK Firebase in questo file: il
   push di FCM e' un normale push web, e leggerlo a mano costa dieci righe.
   ⚠️ Si mostra SEMPRE una notifica, anche a gioco aperto: Safari (iPhone/
   iPad) toglie l'abbonamento a chi riceve push senza mostrare niente. A
   gioco aperto si avvisa anche la pagina, che lo ripete dentro il gioco. */
function datiPush(e){
  let o = {};
  try{ o = e.data ? e.data.json() : {}; }
  catch(err){ try{ o = { data: { body: e.data.text() } }; }catch(e2){} }
  const d = Object.assign({}, o.notification || {}, o.data || {});
  return {
    title: d.title || "QuestTown",
    body:  d.body || "",
    tag:   d.tag || "et-avviso",
    url:   d.url || (o.fcmOptions && o.fcmOptions.link) || PAGE_URL,
  };
}
self.addEventListener("push", (e) => {
  const d = datiPush(e);
  e.waitUntil((async () => {
    const icona = new URL("et-icons/icon-192.png", self.registration.scope).href;
    await self.registration.showNotification(d.title, {
      body: d.body, tag: d.tag, renotify: true, icon: icona, badge: icona,
      vibrate: [150, 60, 150], data: { url: d.url },
    });
    const finestre = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    finestre.forEach(c => { try{ c.postMessage({ type: "et-avviso", title: d.title, body: d.body }); }catch(err){} });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || PAGE_URL;
  e.waitUntil((async () => {
    const finestre = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    /* il gioco e' gia' aperto: lo si porta davanti invece di aprirne un altro */
    for(const c of finestre){
      if(c.url.startsWith(self.registration.scope) && "focus" in c){ try{ return await c.focus(); }catch(err){} }
    }
    if(self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
