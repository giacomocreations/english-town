/* =====================================================================
   English Town — SERVICE WORKER (v217)

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
const C_LIB = "et-lib-v1";     // Babylon, Firebase SDK, manifest, icone

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
function isAsset(u){
  return u.origin === self.location.origin
      && (/\/et-icons\//.test(u.pathname) || /\/et-manifest\.webmanifest$/.test(u.pathname));
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
      "<h2>English Town</h2><p>Per la <b>prima</b> apertura serve la connessione a Internet. " +
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

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if(req.method !== "GET") return;
  let u; try{ u = new URL(req.url); }catch(err){ return; }
  if(req.mode === "navigate" && isPage(u)){ e.respondWith(pagina(e)); return; }
  if(isLib(u) || isAsset(u)){ e.respondWith(cacheFirst(req)); return; }
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
