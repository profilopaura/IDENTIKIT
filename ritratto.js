/* ============================================================
   ritratto.js
   Trasforma gli eventi (JSON) in array pronti per Cables.gl
   + calcola le inferenze "vista macchina" (label, confidence).

   Uso in browser:   const out = Ritratto.costruisci(dati);
   Uso in Node:      const R = require('./ritratto.js');

   Convenzioni:
   - Sistema di coordinate "mondo": Y verso l'alto, centro = (0,0).
   - Ore: 0:00 in alto, 12:00 in basso, senso orario.
   - Array "piatti": [x,y,z, x,y,z, ...] e [r,g,b,a, r,g,b,a, ...]
   ============================================================ */

(function (root) {
  'use strict';

  // ---------- CONFIGURAZIONE (modifica qui) ----------
  const FORME = ['sfera', 'cubo', 'cono', 'toro', 'tetraedro'];
    // Rotazione (gradi, X Y Z) applicata a ogni istanza di ciascuna forma, nello stesso ordine di FORME.
  // Il cono di Cables guarda verso la camera: ruotato di 90 gradi attorno a X si vede come un triangolo.
  // Se il triangolo punta in basso, metti 270 al posto di 90.
  const ROTAZIONE_FORME = [[0, 0, 0], [0, 0, 0], [90, 0, 0], [0, 0, 0], [0, 0, 0]];

  const LUOGO_A_FORMA = {
    casa: 0,
    scuola_lavoro: 1,
    viaggio: 2,
    locale: 3,
    altro: 4
  };

  const COLORI_ATTIVITA = {
    social:   '#ee8579',
    video:    '#e6ab3c',
    mappe:    '#5fc1a6',
    ricerca:  '#7a9fe8',
    messaggi: '#b68be0'
  };

  const COLORE_MACCHINA = '#39ff14';         // vista macchina: forme in verde fluo
  const COLORE_LINEA_UMANA = '#8d97b0';      // linee, vista umana
  const COLORE_LINEA_MACCHINA = '#1fa30f';   // linee, vista macchina (verde più scuro)
  const COLORE_CORNICE_UMANA = '#a2abc0';    // anello esterno, vista umana
  const COLORE_CORNICE_MACCHINA = '#39ff14'; // anello esterno, vista macchina

  const DEFAULT = {
    raggio: 1,               // raggio massimo degli eventi (unità mondo)
    raggioMin: 0.18,         // distanza minima dal centro (eventi di oggi)
    giorniFinestra: 7,       // giorniFa >= questo valore = periferia
    scalaMin: 0.07,          // dimensione forma con 1 sola occorrenza
    scalaMax: 0.26,          // dimensione forma più ripetuta
    spessoreMin: 0.004,      // linea irregolare
    spessoreMax: 0.03,       // linea regolare
    margineRiquadro: 0.12,   // margine dei riquadri di detection
    sogliaNotturno: 0.40,
    sogliaSedentario: 0.60,
    bonusConfidenza: 15,     // il sistema è sempre più sicuro del dovuto
    confidenzaErrata: 91,    // confidence della label sbagliata di proposito
    raggioCornice: 1.3,      // raggio dell'anello esterno (x raggio)
    applicaRotazione: true,  // ruota tutto in base al fuso orario
    formaUnica: false        // true = tutti gli eventi diventano sfere (piano B se manca tempo)
  };

  // ---------- FUNZIONI DI SUPPORTO ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255);
  }

  function contaPer(arr, fn) {
    const m = {};
    arr.forEach(x => { const k = fn(x); m[k] = (m[k] || 0) + 1; });
    return m;
  }

  function mediana(v) {
    const s = v.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // ---------- DATI AUTOMATICI DEL BROWSER ----------
  function leggiAmbiente() {
    const nav = (typeof navigator !== 'undefined') ? navigator : {};
    const scr = (typeof screen !== 'undefined') ? screen : {};
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    return {
      core: nav.hardwareConcurrency || 4,
      larghezzaSchermo: scr.width || 1920,
      altezzaSchermo: scr.height || 1080,
      offsetUTCOre: -new Date().getTimezoneOffset() / 60,
      lingua: nav.language || 'it-IT',
      connessione: (conn && conn.effectiveType) || '4g',
      connessioneRilevata: !!(conn && conn.effectiveType) // Safari/Firefox: false
    };
  }

  // ---------- PROIEZIONE POLARE (ellisse + rotazione) ----------
  // theta: 0 = in alto, cresce in senso orario. r: distanza dal centro.
  function creaProiettore(cfg, amb) {
    const asp = clamp(amb.larghezzaSchermo / amb.altezzaSchermo, 0.6, 2);
    const kx = Math.sqrt(asp);
    const ky = 1 / Math.sqrt(asp);
    const rot = cfg.applicaRotazione ? (amb.offsetUTCOre / 24) * 2 * Math.PI : 0;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    return {
      rot: rot,
      kx: kx,
      ky: ky,
      punto: function (theta, r) {
        const x = Math.sin(theta) * r * kx;
        const y = Math.cos(theta) * r * ky;
        return [x * cr - y * sr, x * sr + y * cr];
      }
    };
  }

  // ---------- CORNICE (dati automatici) ----------
  function costruisciCornice(amb, cfg, proj) {
    const n = clamp(Math.round(amb.core), 2, 32);
    const R = cfg.raggio * cfg.raggioCornice;
    const punti = [];
    for (let i = 0; i < n; i++) {
      const p = proj.punto((i / n) * 2 * Math.PI, R);
      punti.push(p[0], p[1], 0);
    }
    // connessione lenta = movimento a scatti (0 = fluido)
    const PASSI = { '4g': 0, '3g': 12, '2g': 5, 'slow-2g': 2 };
    const passi = (amb.connessione in PASSI) ? PASSI[amb.connessione] : 0;
    const cU = hexToRgb(COLORE_CORNICE_UMANA).concat([1]);
    const cM = hexToRgb(COLORE_CORNICE_MACCHINA).concat([1]);
    const colori = [], coloriMacchina = [];
    for (let i = 0; i < n; i++) { colori.push.apply(colori, cU); coloriMacchina.push.apply(coloriMacchina, cM); }
    return {
      n: n,
      punti: punti,
      colori: colori,
      coloriMacchina: coloriMacchina,
      rotazioneGradi: proj.rot * 180 / Math.PI,
      passiAlSecondo: passi,
      connessione: amb.connessione,
      connessioneRilevata: amb.connessioneRilevata !== false,
      firma: (amb.lingua || 'it-IT').toUpperCase()
    };
  }

  // ---------- RIQUADRO DI DETECTION ----------
  function riquadro(membri, cfg) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    membri.forEach(p => {
      const m = p.scala / 2 + cfg.margineRiquadro;
      x0 = Math.min(x0, p.x - m); x1 = Math.max(x1, p.x + m);
      y0 = Math.min(y0, p.y - m); y1 = Math.max(y1, p.y + m);
    });
    // "ancora" = angolo in alto a sinistra (dove mettere la label)
    return { x0: x0, y0: y0, x1: x1, y1: y1, ancora: { x: x0, y: y1 } };
  }

  // ---------- INFERENZE (vista macchina) ----------
  function costruisciInferenze(P, cfg) {
    const n = P.length;
    const out = [];

    function aggiungi(id, testo, quota, membri, sbagliata) {
      const conf = sbagliata
        ? cfg.confidenzaErrata
        : Math.min(99, Math.round(quota * 100 + cfg.bonusConfidenza));
      out.push({
        id: id,
        testo: testo,
        confidenza: conf,
        quotaReale: sbagliata ? null : Math.round(quota * 1000) / 10,
        sbagliata: !!sbagliata, // ATTENZIONE: non mostrarlo nell'interfaccia!
        membri: membri.map(p => p.id),
        riquadro: riquadro(membri, cfg)
      });
    }

    const notturni = P.filter(p => p.ora >= 23 || p.ora < 5);
    const casa = P.filter(p => p.luogo === 'casa');
    const social = P.filter(p => p.attivita === 'social');
    const perAtt = contaPer(P, p => p.attivita);
    const maxAtt = Math.max.apply(null, Object.keys(perAtt).map(k => perAtt[k]));

    if (notturni.length / n > cfg.sogliaNotturno) {
      aggiungi('notturno', 'profilo: notturno', notturni.length / n, notturni);
    }
    if (casa.length / n > cfg.sogliaSedentario) {
      aggiungi('sedentario', 'utente sedentario', casa.length / n, casa);
    }
    if (perAtt.social === maxAtt) {
      aggiungi('target', 'target pubblicitario: alto engagement', social.length / n, social);
    }

    // Label volutamente sbagliata: agganciata ai viaggi, o all'evento più recente
    const viaggi = P.filter(p => p.luogo === 'viaggio');
    aggiungi('pendolare', 'profilo: pendolare', null, viaggi.length ? viaggi : [P[n - 1]], true);

    return out;
  }

  // ---------- FUNZIONE PRINCIPALE ----------
  function costruisci(dati, ambiente, opzioni) {
    const cfg = Object.assign({}, DEFAULT, opzioni || {});
    const amb = Object.assign({}, leggiAmbiente(), ambiente || {});
    const proj = creaProiettore(cfg, amb);

    const grezzi = (dati && dati.eventi) ? dati.eventi : [];
    if (!grezzi.length) throw new Error('ritratto.js: nessun evento nei dati');

    // 1) Ordine cronologico (non ci fidiamo dell'ordine in ingresso)
    const tempo = e => -e.giorniFa * 24 + e.ora; // ore relative a "oggi 00:00"
    const ev = grezzi.slice().sort((a, b) => tempo(a) - tempo(b));
    const n = ev.length;

    // 2) Ripetizioni luogo + attività -> dimensione
    const coppie = contaPer(ev, e => e.luogo + '|' + e.attivita);
    const maxCoppia = Math.max.apply(null, Object.keys(coppie).map(k => coppie[k]));

    // 3) Ogni evento -> posizione, scala, colore, forma
    const P = ev.map(function (e, i) {
      const theta = (clamp(e.ora, 0, 24) / 24) * 2 * Math.PI;
      const r = lerp(cfg.raggioMin, cfg.raggio, clamp(e.giorniFa / cfg.giorniFinestra, 0, 1));
      const xy = proj.punto(theta, r);
      const rip = coppie[e.luogo + '|' + e.attivita];
      const t = maxCoppia > 1 ? (rip - 1) / (maxCoppia - 1) : 0.5;
            let forma = cfg.formaUnica ? 0 : ((e.luogo in LUOGO_A_FORMA) ? LUOGO_A_FORMA[e.luogo] : 4);
      // forma non ancora costruita in Cables: l'evento diventa una sfera invece di sparire
      if (cfg.formeDisponibili && cfg.formeDisponibili.indexOf(forma) < 0) forma = 0;
      const rgb = hexToRgb(COLORI_ATTIVITA[e.attivita] || '#cccccc');
      return {
        id: (e.id !== undefined) ? e.id : i + 1,
        ora: e.ora, giorniFa: e.giorniFa, luogo: e.luogo, attivita: e.attivita,
        t: tempo(e),
        x: xy[0], y: xy[1],
        scala: lerp(cfg.scalaMin, cfg.scalaMax, t),
        forma: forma,
        rgba: [rgb[0], rgb[1], rgb[2], 1]
      };
    });

    // 4) Array piatti (tutti gli eventi)
    const macchina = hexToRgb(COLORE_MACCHINA).concat([1]);
    const posizioni = [], scale = [], scale3 = [], colori = [], coloriMacchina = [], forme = [];
    P.forEach(p => {
      posizioni.push(p.x, p.y, 0);
      scale.push(p.scala);
      scale3.push(p.scala, p.scala, p.scala);
      colori.push.apply(colori, p.rgba);
      coloriMacchina.push.apply(coloriMacchina, macchina);
      forme.push(p.forma);
    });

    // 5) Divisi per forma (in Cables un instancer disegna una sola mesh)
    const perForma = FORME.map((nome, f) => {
      const g = { nome: nome, count: 0, ids: [], posizioni: [], scale: [], scale3: [], colori: [], coloriMacchina: [] };
      P.filter(p => p.forma === f).forEach(p => {
        g.count++;
        g.ids.push(p.id);
        g.posizioni.push(p.x, p.y, 0);
        g.scale.push(p.scala);
        g.scale3.push(p.scala, p.scala, p.scala);
        g.colori.push.apply(g.colori, p.rgba);
        g.coloriMacchina.push.apply(g.coloriMacchina, macchina);
      });
      return g;
    });

    // 6) Linee: evento -> successivo, come cubi stirati (spessore per segmento)
    const gap = [];
    for (let i = 0; i < n - 1; i++) gap.push(P[i + 1].t - P[i].t);
    const med = gap.length >= 2 ? mediana(gap) : 0;
    const linee = { n: gap.length, centri: [], angoliGradi: [], lunghezze: [], spessori: [], regolarita: [],
                    scale3: [], rotazioni3: [], colori: [], coloriMacchina: [] };
    const rgbaLineaU = hexToRgb(COLORE_LINEA_UMANA).concat([1]);
    const rgbaLineaM = hexToRgb(COLORE_LINEA_MACCHINA).concat([1]);
    for (let i = 0; i < gap.length; i++) {
      const a = P[i], b = P[i + 1];
      const reg = med > 0 ? 1 - clamp(Math.abs(gap[i] - med) / med, 0, 1) : 0.5;
      const dx = b.x - a.x, dy = b.y - a.y;
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const len = Math.hypot(dx, dy);
      const sp = lerp(cfg.spessoreMin, cfg.spessoreMax, reg);
      linee.centri.push((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
      linee.angoliGradi.push(ang);
      linee.lunghezze.push(len);
      linee.spessori.push(sp);
      linee.regolarita.push(reg);
      // formato MeshInstancer di Cables: scala XYZ, rotazione XYZ in gradi (0-360)
      linee.scale3.push(len, sp, sp);
      linee.rotazioni3.push(0, 0, (ang + 360) % 360);
      linee.colori.push.apply(linee.colori, rgbaLineaU);
      linee.coloriMacchina.push.apply(linee.coloriMacchina, rgbaLineaM);
    }

    // 7) Cornice, inferenze, riepilogo
    const cornice = costruisciCornice(amb, cfg, proj);
    const inferenze = costruisciInferenze(P, cfg);
    const media = Math.round(inferenze.reduce((s, x) => s + x.confidenza, 0) / inferenze.length);
    const riepilogo = {
      campione: n,
      affidabilitaDichiarata: media,
      testo: 'campione: ' + n + ' eventi affidabilità dichiarata: ' + media + '%'
    };

    // 8) Estensione massima (per regolare la camera ortografica)
    let ex = 0, ey = 0;
    posizioni.concat(cornice.punti).forEach((v, i) => {
      if (i % 3 === 0) ex = Math.max(ex, Math.abs(v));
      if (i % 3 === 1) ey = Math.max(ey, Math.abs(v));
    });

    return {
      n: n,
      ordineIds: P.map(p => p.id),
      forme: forme,
      posizioni: posizioni,
      scale: scale,
      scale3: scale3,
      colori: colori,
      coloriMacchina: coloriMacchina,
      perForma: perForma,
      linee: linee,
      cornice: cornice,
      inferenze: inferenze,
      riepilogo: riepilogo,
      estensione: { x: ex, y: ey },
      proiezione: {                       // per disegnare la griglia polare di sfondo
        kx: proj.kx, ky: proj.ky, rotGradi: proj.rot * 180 / Math.PI,
        raggio: cfg.raggio, raggioMin: cfg.raggioMin,
        giorniFinestra: cfg.giorniFinestra, raggioCornice: cfg.raggioCornice
      }
    };
  }

  // ---------- COORDINATE MONDO -> PIXEL (per le label HTML) ----------
  // Camera ortografica: metaAltezza = metà dell'altezza visibile in unità mondo.
  // Da richiamare anche al resize della finestra.
  function mondoASchermo(x, y, vp) {
    const asp = vp.larghezza / vp.altezza;
    const metaLarghezza = vp.metaAltezza * asp;
    return {
      x: (x / metaLarghezza * 0.5 + 0.5) * vp.larghezza,
      y: (0.5 - y / (2 * vp.metaAltezza)) * vp.altezza
    };
  }

  // ---------- VARIABILI PER CABLES ----------
  // Elenco completo nome (senza prefisso) -> valore. Unica fonte di verità:
  // la usano sia inviaACables (pagina) sia snippetEditor (editor di Cables).
  // Formati richiesti da MeshInstancer_v4: posizioni XYZ, scala XYZ,
  // rotazioni XYZ in gradi, colori RGBA.
  function variabili(out, vista) {
    const m = vista === 'macchina';
    const v = {};
    out.perForma.forEach(function (g, i) {
      if (g.count === 0) {                 // gruppo vuoto: 1 istanza invisibile (scala 0)
        v['f' + i + '_pos'] = [0, 0, 0];
        v['f' + i + '_scala'] = [0, 0, 0];
        v['f' + i + '_colori'] = [0, 0, 0, 0];
        v['f' + i + '_rot'] = [0, 0, 0];
      } else {
        v['f' + i + '_pos'] = g.posizioni;
        v['f' + i + '_scala'] = g.scale3;
        v['f' + i + '_colori'] = m ? g.coloriMacchina : g.colori;
        const r = ROTAZIONE_FORME[i] || [0, 0, 0];
        const rot = [];
        for (let k = 0; k < g.count; k++) rot.push(r[0], r[1], r[2]);
        v['f' + i + '_rot'] = rot;
      }
    });
    const L = out.linee;
    if (L.n === 0) {
      v.linee_pos = [0, 0, 0]; v.linee_scala = [0, 0, 0];
      v.linee_rot = [0, 0, 0]; v.linee_colori = [0, 0, 0, 0];
    } else {
      v.linee_pos = L.centri;
      v.linee_scala = L.scale3;
      v.linee_rot = L.rotazioni3;
      v.linee_colori = m ? L.coloriMacchina : L.colori;
    }
    v.cornice_pos = out.cornice.punti;
    v.cornice_colori = m ? out.cornice.coloriMacchina : out.cornice.colori;
    v.vista = m ? 1 : 0;                   // 0 = umana, 1 = macchina
    return v;
  }

  // Imposta una variabile del patch. Restituisce false se il patch non la contiene.
  function impostaVariabile(patch, nome, valore) {
    if (typeof patch.getVar === 'function') {
      const v = patch.getVar(nome);
      if (v) { v.setValue(valore); return true; }
      return false;
    }
    try { patch.setVariable(nome, valore); return true; } catch (e) { return false; }
  }

  // "patch" = CABLES.patch. Restituisce l'elenco delle variabili NON trovate nel patch.
  function inviaACables(patch, out, prefisso, vista) {
    const pre = prefisso || 'ritratto_';
    const v = variabili(out, vista || 'umana');
    const mancanti = [];
    Object.keys(v).forEach(function (k) {
      if (!impostaVariabile(patch, pre + k, v[k])) mancanti.push(pre + k);
    });
    return mancanti;
  }

  // Testo da incollare nella console dell'editor di Cables (contesto "editorframe"):
  // imposta tutte le variabili senza esportare il patch.
  function snippetEditor(out, vista, prefisso, extra) {
    const pre = prefisso || 'ritratto_';
    const v = Object.assign({}, variabili(out, vista || 'umana'), extra || {});
    const o = {};
    Object.keys(v).forEach(function (k) { o[pre + k] = v[k]; });
    const json = JSON.stringify(o, function (k, x) {
      return typeof x === 'number' ? Math.round(x * 10000) / 10000 : x;
    });
    return '(function(p){var v=' + json + ';var m=[];' +
      'Object.keys(v).forEach(function(k){var x=p.getVar(k);if(x){x.setValue(v[k]);}else{m.push(k);}});' +
      'console.log("variabili impostate:",Object.keys(v).length-m.length,"| mancanti nel patch:",m);' +
      '})(gui.corePatch());';
  }

  // ---------- ESPORTAZIONE ----------
  const API = {
    costruisci: costruisci,
    leggiAmbiente: leggiAmbiente,
    mondoASchermo: mondoASchermo,
    inviaACables: inviaACables,
    impostaVariabile: impostaVariabile,
    variabili: variabili,
    snippetEditor: snippetEditor,
    FORME: FORME,
    COLORI_ATTIVITA: COLORI_ATTIVITA
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.Ritratto = API;

})(typeof window !== 'undefined' ? window : globalThis);

/* ============================================================
   ESEMPIO D'USO (nel tuo index.html)

   <script src="ritratto.js"></script>
   <script>
     fetch('eventi.json').then(r => r.json()).then(dati => {
       const out = Ritratto.costruisci(dati);

       // 1) manda gli array a Cables (quando il patch è caricato)
       Ritratto.inviaACables(patch, out);

       // 2) posiziona le label HTML della vista macchina
       const vp = { larghezza: innerWidth, altezza: innerHeight,
                    metaAltezza: Math.max(out.estensione.y, out.estensione.x / (innerWidth / innerHeight)) * 1.15 };
       out.inferenze.forEach(inf => {
         const p = Ritratto.mondoASchermo(inf.riquadro.ancora.x, inf.riquadro.ancora.y, vp);
         // crea un <div> in posizione (p.x, p.y) con inf.testo + inf.confidenza + '%'
       });
     });
   </script>
   ============================================================ */
