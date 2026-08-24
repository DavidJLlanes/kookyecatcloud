'use strict';

/* ---------------------------------------------------------------
   Estado
--------------------------------------------------------------- */
const state = {
  path: '',
  user: null,
  items: [],           // contenido de la carpeta (o resultados de búsqueda)
  images: [],          // subconjunto visible que es imagen, para el visor
  view: localStorage.getItem('fc-view') === 'list' ? 'list' : 'grid',
  sort: localStorage.getItem('fc-sort') || 'name-asc',
  filter: 'all',
  tab: 'files',
  query: '',
  truncated: false,
  selected: null,      // elemento del menú contextual
  selectMode: false,
  selection: new Set(),// rutas relativas completas
  lbIndex: -1,
  lastIndex: -1,       // último elemento pulsado, para seleccionar rangos con Shift
  pickerPath: '',
  pickerMode: 'move',  // 'move' | 'link'
  moving: [],          // rutas pendientes de mover
  linkPath: '',        // carpeta destino del enlace de subida que se va a crear
  caps: null,          // qué sabe hacer el servidor: sharp, ffmpeg, LibreOffice
  compartiendo: null,  // elemento del que se está creando un enlace de descarga
  agrupar: localStorage.getItem('fc-agrupar') === '1',
  meta: {},            // fecha de captura y coordenadas por nombre de archivo
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------
   Utilidades
--------------------------------------------------------------- */
function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  const n = bytes / Math.pow(1024, i);
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}
function fmtDate(d) {
  const date = new Date(d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('es-ES', {
    day: '2-digit', month: 'short', year: sameYear ? undefined : 'numeric',
  });
}
// HEIC entra como imagen: el servidor lo convierte al vuelo para el navegador
function isImage(name) {
  return /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i.test(name);
}
function isVideo(name) {
  return /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(name);
}
function isAudio(name) {
  return /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i.test(name);
}
const isMedia = (name) => isImage(name) || isVideo(name) || isAudio(name);
// Lo que tiene miniatura: imágenes siempre, vídeos solo si el servidor tiene ffmpeg
const hasThumb = (name) => isImage(name) || isVideo(name);

// --- Documentos ---
const RE_CODIGO = /\.(txt|log|json|xml|svg|yml|yaml|ini|conf|cfg|toml|env|js|mjs|cjs|ts|jsx|tsx|css|scss|less|html?|php|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|sql|ps1|bat|srt|vtt)$/i;
const isMarkdown = (n) => /\.(md|markdown)$/i.test(n);
const isCsv = (n) => /\.(csv|tsv)$/i.test(n);
const isPdf = (n) => /\.pdf$/i.test(n);
// Las hojas de cálculo se pintan como rejilla, no se convierten a PDF
const isSheet = (n) => /\.(xlsx|xlsm|xls|ods|numbers)$/i.test(n);
const isOffice = (n) => /\.(docx?|pptx?|odt|odp|rtf|pages|key)$/i.test(n) || isSheet(n);
const isTexto = (n) => RE_CODIGO.test(n) || isMarkdown(n) || isCsv(n) ||
  /^(makefile|dockerfile|readme|licen[cs]e)$/i.test(n);
const isDoc = (n) => isPdf(n) || isOffice(n) || isTexto(n);
// Todo lo que el visor sabe abrir
const isViewable = (name) => isMedia(name) || isDoc(name);

/* ---------------------------------------------------------------
   Markdown
   Intérprete propio que devuelve nodos del DOM, nunca cadenas de HTML:
   así el contenido de un archivo no puede convertirse en código ejecutable.
--------------------------------------------------------------- */
function urlSegura(u) {
  return /^(https?:|mailto:)/i.test(String(u).trim()) ? u : '#';
}

function mdEnLinea(padre, texto) {
  const re = /(\*\*|__)([\s\S]+?)\1|(\*|_)([\s\S]+?)\3|`([^`]+)`|~~([\s\S]+?)~~|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;
  let ultimo = 0, m;
  while ((m = re.exec(texto))) {
    if (m.index > ultimo) padre.appendChild(document.createTextNode(texto.slice(ultimo, m.index)));
    if (m[1]) { const b = el('strong'); mdEnLinea(b, m[2]); padre.appendChild(b); }
    else if (m[3]) { const i = el('em'); mdEnLinea(i, m[4]); padre.appendChild(i); }
    else if (m[5] !== undefined) padre.appendChild(el('code', null, m[5]));
    else if (m[6]) { const s = el('s'); mdEnLinea(s, m[6]); padre.appendChild(s); }
    else if (m[8]) {
      const a = el('a', null, m[7] || m[8]);
      a.href = urlSegura(m[8]); a.target = '_blank'; a.rel = 'noopener noreferrer';
      padre.appendChild(a);
    } else if (m[9]) {
      const a = el('a', null, m[9]);
      a.href = urlSegura(m[9]); a.target = '_blank'; a.rel = 'noopener noreferrer';
      padre.appendChild(a);
    }
    ultimo = re.lastIndex;
  }
  if (ultimo < texto.length) padre.appendChild(document.createTextNode(texto.slice(ultimo)));
  return padre;
}

function renderMarkdown(texto) {
  const raiz = el('div', 'md');
  const lineas = texto.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const esLista = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);

  while (i < lineas.length) {
    const l = lineas[i];

    if (/^\s*```/.test(l)) {                       // bloque de código
      const buf = [];
      i++;
      while (i < lineas.length && !/^\s*```/.test(lineas[i])) buf.push(lineas[i++]);
      i++;
      const pre = el('pre', 'md-code');
      pre.appendChild(el('code', null, buf.join('\n')));
      raiz.appendChild(pre);
      continue;
    }
    if (/^\s*$/.test(l)) { i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { raiz.appendChild(el('hr')); i++; continue; }

    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      raiz.appendChild(mdEnLinea(el('h' + h[1].length), h[2]));
      i++;
      continue;
    }

    if (/^\s*>/.test(l)) {                          // cita
      const buf = [];
      while (i < lineas.length && /^\s*>/.test(lineas[i])) buf.push(lineas[i++].replace(/^\s*>\s?/, ''));
      const bq = el('blockquote');
      bq.appendChild(mdEnLinea(el('p'), buf.join(' ')));
      raiz.appendChild(bq);
      continue;
    }

    // Tabla: cabecera + fila de guiones
    if (/\|/.test(l) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lineas[i + 1] || '')) {
      const celdas = (fila) => fila.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const tabla = el('table', 'md-table');
      const thead = el('thead');
      const trh = el('tr');
      celdas(l).forEach(c => trh.appendChild(mdEnLinea(el('th'), c)));
      thead.appendChild(trh);
      tabla.appendChild(thead);
      i += 2;
      const tbody = el('tbody');
      while (i < lineas.length && /\|/.test(lineas[i]) && !/^\s*$/.test(lineas[i])) {
        const tr = el('tr');
        celdas(lineas[i++]).forEach(c => tr.appendChild(mdEnLinea(el('td'), c)));
        tbody.appendChild(tr);
      }
      tabla.appendChild(tbody);
      raiz.appendChild(tabla);
      continue;
    }

    if (esLista(l)) {                               // listas, con un nivel de anidado
      const ordenada = /^\s*\d+[.)]\s/.test(l);
      const lista = el(ordenada ? 'ol' : 'ul', 'md-list');
      let actual = null;
      while (i < lineas.length && esLista(lineas[i])) {
        const linea = lineas[i];
        const sangria = (linea.match(/^\s*/) || [''])[0].length;
        const contenido = linea.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        if (sangria >= 2 && actual) {
          let sub = actual.querySelector('ul, ol');
          if (!sub) { sub = el(/^\s*\d+[.)]\s/.test(linea) ? 'ol' : 'ul'); actual.appendChild(sub); }
          sub.appendChild(mdEnLinea(el('li'), contenido));
        } else {
          actual = mdEnLinea(el('li'), contenido);
          lista.appendChild(actual);
        }
        i++;
      }
      raiz.appendChild(lista);
      continue;
    }

    const parrafo = [];                             // párrafo hasta la línea en blanco
    while (i < lineas.length && !/^\s*$/.test(lineas[i]) && !esLista(lineas[i]) &&
           !/^\s*(#{1,6}\s|>|```)/.test(lineas[i])) {
      parrafo.push(lineas[i++]);
    }
    raiz.appendChild(mdEnLinea(el('p'), parrafo.join(' ')));
  }
  return raiz;
}

// CSV con comillas: "Garcia, Ana" es una sola celda
function parseCsv(texto, sep) {
  const filas = [];
  let fila = [], celda = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') { if (texto[i + 1] === '"') { celda += '"'; i++; } else comillas = false; }
      else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(celda); celda = ''; }
    else if (c === '\n') { fila.push(celda); filas.push(fila); fila = []; celda = ''; }
    else if (c !== '\r') celda += c;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return filas.filter(f => f.length > 1 || f[0] !== '');
}

function renderCsv(texto, nombre) {
  const filas = parseCsv(texto, /\.tsv$/i.test(nombre) ? '\t' : ',');
  const caja = el('div', 'csv-wrap');
  if (!filas.length) { caja.appendChild(el('p', null, 'Archivo vacío')); return caja; }
  const tabla = el('table', 'md-table');
  const thead = el('thead');
  const trh = el('tr');
  filas[0].forEach(c => trh.appendChild(el('th', null, c)));
  thead.appendChild(trh);
  tabla.appendChild(thead);
  const tbody = el('tbody');
  const MAX = 500;
  for (const f of filas.slice(1, MAX + 1)) {
    const tr = el('tr');
    f.forEach(c => tr.appendChild(el('td', null, c)));
    tbody.appendChild(tr);
  }
  tabla.appendChild(tbody);
  caja.appendChild(tabla);
  if (filas.length - 1 > MAX) {
    caja.appendChild(el('p', 'doc-aviso', `Mostrando ${MAX} de ${filas.length - 1} filas. Descarga el archivo para verlo entero.`));
  }
  return caja;
}

// Todo lo que viene del servidor se inserta como texto, nunca como HTML:
// un archivo llamado "<img onerror=...>" debe verse como texto, no ejecutarse.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.appendChild(use);
  return svg;
}
const show = (id) => { $(id).hidden = false; };
const hide = (id) => { $(id).hidden = true; };

let toastTimer = null;
function showToast(msg) {
  const host = $('toast-host');
  host.textContent = '';
  host.appendChild(el('div', 'toast', msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.textContent = ''; }, 3000);
}

async function errorOf(res, fallback) {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch { return fallback; }
}
async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: 'include', ...opts });
  if (res.status === 401) { showLogin(); throw new Error('No autenticado'); }
  return res;
}
async function post(url, body) {
  return api(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const qs = (p) => encodeURIComponent(p);
const joinPath = (dir, name) => (dir ? dir + '/' : '') + name;
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/* ---------------------------------------------------------------
   Tonalidad del fondo
--------------------------------------------------------------- */
// b1/b2/b3 son las tres manchas del degradado y también el degradado de marca,
// así que la interfaz entera queda en la misma gama. base = tinte del fondo.
const TINTS = [
  { id: 'oceano',    name: 'Océano',    b1: '#4f7cff', b2: '#a855f7', b3: '#22d3ee', base: '#0d1730' },
  { id: 'esmeralda', name: 'Esmeralda', b1: '#10b981', b2: '#22d3ee', b3: '#84cc16', base: '#08201c' },
  { id: 'atardecer', name: 'Atardecer', b1: '#f97316', b2: '#ec4899', b3: '#fbbf24', base: '#241019' },
  { id: 'violeta',   name: 'Violeta',   b1: '#8b5cf6', b2: '#d946ef', b3: '#6366f1', base: '#170f2b' },
  { id: 'carmesi',   name: 'Carmesí',   b1: '#f43f5e', b2: '#a855f7', b3: '#fb7185', base: '#230d1a' },
  { id: 'grafito',   name: 'Grafito',   b1: '#7c8aa5', b2: '#94a3b8', b3: '#64748b', base: '#12161f' },
];
const tintById = (id) => TINTS.find(t => t.id === id) || TINTS[0];

const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const alpha = (hex, a) => `rgba(${rgbOf(hex).join(',')},${a})`;
// Mezcla con blanco: p es la proporción del color, el resto blanco
const lighten = (hex, p) => `rgb(${rgbOf(hex).map(c => Math.round(c * p + 255 * (1 - p))).join(',')})`;

function setFavicon(c1, c2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>` +
    `</linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#g)"/>` +
    `<g transform="translate(12 12) scale(.8) translate(-12 -12)">` +
    `<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.66-1.5A4 4 0 0 0 6.5 19z" fill="none" ` +
    `stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  const link = $('favicon');
  if (link) link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function applyTint(id, persist) {
  const t = tintById(id);
  const root = document.documentElement.style;
  root.setProperty('--b1', t.b1);
  root.setProperty('--b2', t.b2);
  root.setProperty('--b3', t.b3);
  root.setProperty('--aurora-base', t.base);
  // Los acentos se calculan aquí y se escriben como valores literales: un color-mix()
  // guardado en una variable que referencia otra variable no se recalcula al cambiarla,
  // y quedaban pastillas y chips del color anterior.
  root.setProperty('--brand-soft', alpha(t.b1, .16));
  root.setProperty('--accent-text', lighten(t.b1, .45));
  root.setProperty('--accent-line', alpha(t.b1, .4));
  root.setProperty('--accent-strong', alpha(t.b1, .72));
  root.setProperty('--glow', `0 6px 24px -6px ${alpha(t.b1, .6)}`);
  setFavicon(t.b1, t.b2);
  if (persist) localStorage.setItem('fc-tint', t.id);
  document.querySelectorAll('.tint').forEach(b => b.classList.toggle('is-active', b.dataset.tint === t.id));
}

function renderTints() {
  const box = $('tint-grid');
  if (!box || box.childElementCount) return; // se pinta una sola vez
  const current = localStorage.getItem('fc-tint') || TINTS[0].id;
  for (const t of TINTS) {
    const btn = el('button', 'tint');
    btn.dataset.tint = t.id;
    btn.title = t.name;
    const sw = el('div', 'swatch');
    sw.style.background = `radial-gradient(120% 100% at 50% 0%, ${t.base}, #04070f)`;
    [t.b1, t.b2, t.b3].forEach(c => {
      const blob = el('i');
      blob.style.background = `radial-gradient(circle, ${c}, transparent 70%)`;
      sw.appendChild(blob);
    });
    btn.appendChild(sw);
    const mark = el('span', 'mark');
    mark.appendChild(icon('i-check'));
    btn.appendChild(mark);
    btn.appendChild(el('span', 'tname', t.name));
    if (t.id === current) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      applyTint(t.id, true);
      showToast(`Tonalidad ${t.name}`);
    });
    box.appendChild(btn);
  }
}

/* ---------------------------------------------------------------
   Tipos de archivo
--------------------------------------------------------------- */
const CATS = [
  { cat: 'image', re: /\.(jpe?g|png|gif|webp|bmp|avif|heic|svg)$/i, cls: 't-image' },
  { cat: 'video', re: /\.(mp4|mov|avi|mkv|webm|m4v|mpe?g)$/i,       cls: 't-video' },
  { cat: 'audio', re: /\.(mp3|wav|flac|aac|ogg|m4a|wma)$/i,         cls: 't-audio' },
  { cat: 'doc',   re: /\.(pdf|docx?|txt|rtf|odt|md|pages)$/i,       cls: 't-doc' },
  { cat: 'doc',   re: /\.(xlsx?|csv|ods|pptx?|odp)$/i,              cls: 't-sheet' },
  { cat: 'other', re: /\.(zip|rar|7z|tar|gz|bz2|iso)$/i,            cls: 't-zip' },
];
function catOf(name) {
  const f = CATS.find(c => c.re.test(name));
  return f ? f.cat : 'other';
}
function clsOf(name) {
  const f = CATS.find(c => c.re.test(name));
  return f ? f.cls : 't-other';
}
function fileBadge(name, isDir) {
  if (isDir) {
    const box = el('div', 'badge-file t-folder');
    box.appendChild(icon('i-folder'));
    return box;
  }
  const ext = (name.split('.').pop() || '').toLowerCase();
  const label = ext && ext.length <= 4 && ext !== name.toLowerCase() ? ext : '•';
  return el('div', 'badge-file ' + clsOf(name), label);
}

/* ---------------------------------------------------------------
   Sesión
--------------------------------------------------------------- */
let esperando2fa = false;

async function doLogin(ev) {
  ev.preventDefault();
  const errBox = $('login-error');
  const btn = $('login-btn');
  errBox.textContent = '';
  btn.disabled = true;

  try {
    if (esperando2fa) {
      btn.textContent = 'Comprobando…';
      const res = await fetch('/api/login/2fa', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: $('login-2fa-code').value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { errBox.textContent = data.error || 'Error'; return; }
      state.user = data;
      salirModo2fa();
      showApp();
      return;
    }

    btn.textContent = 'Entrando…';
    const username = $('login-user').value.trim();
    const password = $('login-pass').value;
    const res = await fetch('/api/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errBox.textContent = data.error || 'Error'; return; }
    if (data.need2fa) { entrarModo2fa(); return; }
    state.user = data;
    $('login-pass').value = '';
    showApp();
  } catch {
    errBox.textContent = 'Error de conexión con el servidor';
  } finally {
    btn.disabled = false;
    btn.textContent = esperando2fa ? 'Verificar' : 'Entrar';
  }
}

// El formulario de login se reutiliza para el segundo paso: se ocultan usuario/
// contraseña y aparece el campo de código, sin duplicar toda la pantalla.
function entrarModo2fa() {
  esperando2fa = true;
  $('login-pass').value = '';
  $('login-campos').hidden = true;
  $('login-2fa-campo').hidden = false;
  $('login-btn').textContent = 'Verificar';
  $('login-sub').textContent = 'Introduce el código de tu app de verificación';
  $('login-2fa-code').focus();
}
function salirModo2fa() {
  esperando2fa = false;
  $('login-campos').hidden = false;
  $('login-2fa-campo').hidden = true;
  $('login-2fa-code').value = '';
  $('login-btn').textContent = 'Entrar';
  $('login-sub').textContent = 'Tu nube personal';
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch {}
  state.user = null;
  showLogin();
}

function showLogin() { salirModo2fa(); show('login-screen'); hide('app'); }

function showApp() {
  hide('login-screen');
  show('app');
  medirAlturaNav();
  const name = state.user.username;
  $('user-av').textContent = name.charAt(0).toUpperCase();
  $('user-name').textContent = name;
  $('user-role').textContent = state.user.role === 'admin' ? 'admin' : '';
  const isAdmin = state.user.role === 'admin';
  $('tab-admin').hidden = !isAdmin;
  $('mnav-admin').hidden = !isAdmin;
  $('dav-url').textContent = location.origin + '/dav/';
  $('dav-user').textContent = name;
  cargarCapacidades();       // aquí, no en checkSession: así vale entrando por el formulario
  cargarFavoritosSet();
  $('sort-select').value = state.sort;
  applyViewButtons();
  aplicarBotonAgrupar();
  refresh();
  bloquearApp();
  reiniciarPinIdle();
}

async function checkSession() {
  try {
    const res = await api('/api/me');
    if (res.ok) { state.user = await res.json(); showApp(); return; }
  } catch {}
  showLogin();
}

// Qué sabe hacer el servidor (sharp, ffmpeg, LibreOffice): sirve para no
// prometer una vista previa que luego no va a existir
async function cargarCapacidades() {
  try {
    const res = await api('/api/capabilities');
    if (res.ok) state.caps = await res.json();
  } catch {}
}

function switchTab(tab) {
  state.tab = tab;
  $('view-files').hidden = tab !== 'files';
  $('view-notes').hidden = tab !== 'notes';
  $('view-map').hidden = tab !== 'map';
  $('view-trash').hidden = tab !== 'trash';
  $('view-colecciones').hidden = tab !== 'colecciones';
  $('view-cuenta').hidden = tab !== 'cuenta';
  $('view-admin').hidden = tab !== 'admin';
  document.querySelectorAll('.tab, .mobilenav button').forEach(b => {
    b.classList.toggle('is-active', b.dataset.view === tab);
  });
  if (tab !== 'files') exitSelectMode();
  if (tab !== 'notes') guardarAhora();          // salir de Notas no debe perder lo escrito
  if (tab === 'notes') { loadNotes(true); refrescarContadorPapeleraNotas(); }
  if (tab === 'admin') { loadAdmin(); loadDiskUsage(''); }
  if (tab === 'map') loadMap();
  if (tab === 'trash') loadTrash();
  if (tab === 'colecciones') loadColecciones();
  if (tab === 'cuenta') { renderTints(); loadCuenta(); }
}

/* ---------------------------------------------------------------
   Navegación
--------------------------------------------------------------- */
function renderBreadcrumb() {
  const bar = $('breadcrumb');
  bar.textContent = '';
  const parts = state.path.split('/').filter(Boolean);

  const home = el('button');
  home.appendChild(icon('i-home'));
  home.appendChild(el('span', null, 'Inicio'));
  if (!parts.length && !state.query) home.classList.add('current');
  else home.addEventListener('click', () => goTo(''));
  haceSoltable(home, '');            // soltar sobre una miga mueve ahí: la forma natural de subir de nivel
  bar.appendChild(home);

  let acc = '';
  parts.forEach((part, i) => {
    acc += (acc ? '/' : '') + part;
    const target = acc;
    bar.appendChild(el('span', 'sep', '/'));
    const btn = el('button', null, part);
    if (i === parts.length - 1 && !state.query) btn.classList.add('current');
    else btn.addEventListener('click', () => goTo(target));
    haceSoltable(btn, target);
    bar.appendChild(btn);
  });
}

function goTo(p) {
  state.path = p;
  clearSearchInput();
  exitSelectMode();
  refresh();
}

function aplicarBotonAgrupar() {
  $('btn-agrupar').classList.toggle('is-active', state.agrupar);
  $('btn-agrupar').title = state.agrupar ? 'Ver todas seguidas' : 'Agrupar por meses';
}

function applyViewButtons() {
  $('btn-grid').classList.toggle('is-active', state.view === 'grid');
  $('btn-list').classList.toggle('is-active', state.view === 'list');
}
function setView(view) {
  state.view = view;
  localStorage.setItem('fc-view', view);
  applyViewButtons();
  render();
}

/* ---------------------------------------------------------------
   Carga y filtrado
--------------------------------------------------------------- */
function renderSkeleton() {
  const box = $('file-list');
  box.textContent = '';
  const grid = state.view === 'grid';
  box.className = grid ? 'grid' : 'list';
  for (let i = 0; i < (grid ? 12 : 6); i++) {
    const s = el('div', 'skel');
    if (grid) s.style.aspectRatio = '1 / 1.18';
    else s.style.height = '64px';
    box.appendChild(s);
  }
}

function emptyState(title, sub, iconName) {
  const wrap = el('div', 'empty');
  const em = el('div', 'em');
  em.appendChild(icon(iconName || 'i-inbox'));
  wrap.appendChild(em);
  wrap.appendChild(el('h3', null, title));
  if (sub) wrap.appendChild(el('p', null, sub));
  return wrap;
}

async function refresh() {
  renderBreadcrumb();
  renderSkeleton();
  state.selection.clear();
  updateSelbar();
  try {
    const url = state.query
      ? `/api/search?q=${qs(state.query)}&path=${qs(state.path)}`
      : `/api/files?path=${qs(state.path)}`;
    const res = await api(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    state.truncated = !!data.truncated;
    state.meta = {};
    // rel = ruta completa relativa a la raíz del usuario; en búsqueda viene el directorio aparte
    state.items = (data.items || []).map(it => ({
      ...it,
      rel: state.query ? joinPath(it.dir || '', it.name) : joinPath(state.path, it.name),
    }));
    render();
    cargarMetaFotos();          // en segundo plano: la rejilla ya está pintada
  } catch {
    const box = $('file-list');
    box.textContent = '';
    box.className = '';
    box.appendChild(emptyState('No se pudo cargar', 'Comprueba la conexión y reinténtalo'));
  }
}

function visibleItems() {
  let list = state.items;
  if (state.filter !== 'all') {
    list = list.filter(i => i.isDir || catOf(i.name) === state.filter);
  }
  const [key, dir] = state.sort.split('-');
  const mul = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (key === 'name') return mul * a.name.localeCompare(b.name, 'es', { numeric: true });
    if (key === 'date') return mul * (new Date(a.modified) - new Date(b.modified));
    return mul * ((a.size || 0) - (b.size || 0));
  });
}

/* ---------------------------------------------------------------
   Agrupación por meses y años
   La fecha buena es la de captura del EXIF, no la del archivo: subir una
   foto de 2019 hoy no debería colocarla en el mes actual.
--------------------------------------------------------------- */
async function cargarMetaFotos() {
  if (!state.agrupar || state.query) return;
  const hayFotos = state.items.some(i => !i.isDir && isImage(i.name));
  if (!hayFotos) return;
  const ruta = state.path;
  try {
    const res = await api('/api/photometa?path=' + qs(ruta));
    const data = await res.json();
    if (!res.ok || ruta !== state.path) return;      // ya cambió de carpeta
    state.meta = data.fotos || {};
    for (const item of state.items) {
      const m = state.meta[item.name];
      if (m) { item.tomada = m.t; item.deExif = m.exif; item.lat = m.lat; item.lon = m.lon; }
    }
    render();
  } catch { /* se sigue agrupando por la fecha del archivo */ }
}

const fechaDe = (item) => item.tomada || new Date(item.modified).getTime();
const claveMes = (t) => {
  const d = new Date(t);
  return d.getFullYear() * 100 + d.getMonth();
};
function etiquetaMes(t) {
  const s = new Date(t).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pintarAgrupado(box, items) {
  const carpetas = items.filter(i => i.isDir);
  const archivos = items.filter(i => !i.isDir)
    .sort((a, b) => fechaDe(b) - fechaDe(a));        // lo más reciente primero

  const grid = () => {
    const c = el('div', state.view === 'grid' ? 'grid' : 'list');
    c.style.padding = '0 0 8px';
    return c;
  };
  let indice = 0;
  const pinta = (lista, contenedor) => {
    lista.forEach(item => {
      item._i = indice++;
      const nodo = state.view === 'grid' ? buildTile(item) : buildRow(item);
      nodo.style.animationDelay = Math.min(indice * 18, 300) + 'ms';
      contenedor.appendChild(nodo);
    });
  };

  if (carpetas.length) {
    const cab = el('div', 'grupo-cab');
    cab.appendChild(el('h3', null, 'Carpetas'));
    cab.appendChild(el('span', 'cuenta', `${carpetas.length}`));
    box.appendChild(cab);
    const c = grid();
    pinta(carpetas, c);
    box.appendChild(c);
  }

  let mesActual = null, anyoAnterior = null, contenedor = null;
  for (const item of archivos) {
    const t = fechaDe(item);
    const mes = claveMes(t);
    if (mes !== mesActual) {
      mesActual = mes;
      const anyo = new Date(t).getFullYear();
      const cab = el('div', 'grupo-cab');
      cab.appendChild(el('h3', null, etiquetaMes(t)));
      const delMes = archivos.filter(x => claveMes(fechaDe(x)) === mes).length;
      cab.appendChild(el('span', 'cuenta', `${delMes} archivo${delMes === 1 ? '' : 's'}`));
      // El año solo se destaca cuando cambia, para no repetirlo en cada mes
      if (anyo !== anyoAnterior) { cab.appendChild(el('span', 'anyo', String(anyo))); anyoAnterior = anyo; }
      box.appendChild(cab);
      contenedor = grid();
      box.appendChild(contenedor);
    }
    pinta([item], contenedor);
  }
}

function render() {
  const box = $('file-list');
  const items = visibleItems();
  state.viewables = items.filter(i => !i.isDir && isViewable(i.name));

  const info = $('search-info');
  if (state.query) {
    info.textContent = '';
    info.appendChild(document.createTextNode(`${items.length} resultado${items.length === 1 ? '' : 's'} para `));
    info.appendChild(el('b', null, `«${state.query}»`));
    if (state.truncated) info.appendChild(document.createTextNode(' (mostrando solo los primeros 300)'));
    info.hidden = false;
  } else {
    info.hidden = true;
  }

  const dirs = items.filter(i => i.isDir).length;
  const files = items.length - dirs;
  $('folder-count').textContent = [
    dirs ? `${dirs} carpeta${dirs > 1 ? 's' : ''}` : '',
    files ? `${files} archivo${files > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');

  box.textContent = '';
  if (!items.length) {
    box.className = '';
    box.appendChild(state.query
      ? emptyState('Sin resultados', 'Prueba con otra palabra', 'i-search')
      : state.filter !== 'all'
        ? emptyState('Nada de este tipo aquí', 'Cambia el filtro para ver el resto', 'i-search')
        : emptyState('Esta carpeta está vacía', 'Arrastra archivos aquí o usa "Subir archivos"'));
    return;
  }
  // Agrupado: cada mes con su cabecera. Sin agrupar: todo seguido, como siempre
  if (state.agrupar && !state.query) {
    box.className = 'agrupado';
    pintarAgrupado(box, items);
    return;
  }

  box.className = state.view === 'grid' ? 'grid' : 'list';
  items.forEach((item, i) => {
    item._i = i;                                   // índice visible, para el rango con Shift
    const node = state.view === 'grid' ? buildTile(item) : buildRow(item);
    // Entrada escalonada, con tope para que una carpeta enorme no tarde en aparecer
    node.style.animationDelay = Math.min(i * 22, 360) + 'ms';
    box.appendChild(node);
  });
}

function onItemClick(item, ev) {
  // Ctrl/Cmd para marcar suelto, Shift para marcar un rango
  if (ev && (ev.ctrlKey || ev.metaKey)) {
    if (!state.selectMode) enterSelectMode();
    toggleSelect(item);
    state.lastIndex = item._i;
    return;
  }
  if (ev && ev.shiftKey && state.lastIndex >= 0) {
    if (!state.selectMode) enterSelectMode();
    seleccionarRango(state.lastIndex, item._i);
    return;
  }
  if (state.selectMode) { toggleSelect(item); state.lastIndex = item._i; return; }
  if (item.isDir) { goTo(item.rel); return; }
  if (isViewable(item.name)) { openLightbox(state.viewables.indexOf(item)); return; }
  openActions(item);
}

function seleccionarRango(desde, hasta) {
  const lista = visibleItems();
  const a = Math.min(desde, hasta), b = Math.max(desde, hasta);
  for (let i = a; i <= b; i++) if (lista[i]) state.selection.add(lista[i].rel);
  updateSelbar();
  render();
}

/* ---------------------------------------------------------------
   Arrastrar elementos sobre una carpeta para moverlos
--------------------------------------------------------------- */
let arrastre = [];   // rutas que se están arrastrando

function haceArrastrable(node, item) {
  node.draggable = true;
  node.addEventListener('dragstart', e => {
    // Si el elemento arrastrado está marcado, se arrastra la selección entera
    arrastre = state.selection.has(item.rel) ? [...state.selection] : [item.rel];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', arrastre.join('\n'));
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    arrastre = [];
    document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
  });
}

function haceSoltable(node, destino) {
  node.addEventListener('dragover', e => {
    if (!arrastre.length) return;                       // arrastre externo: lo maneja la ventana
    if (arrastre.includes(destino)) return;             // una carpeta no cae dentro de sí misma
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', e => {
    node.classList.remove('drop-target');
    if (!arrastre.length) return;
    e.preventDefault();
    e.stopPropagation();
    moverA(arrastre, destino);
    arrastre = [];
  });
}

async function moverA(rutas, destino) {
  try {
    const res = await post('/api/batch', { op: 'move', paths: rutas, dest: destino });
    const data = await res.json();
    reportBatch(data, 'elemento movido', 'elementos movidos');
    exitSelectMode();
    refresh();
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Menú contextual (clic derecho)
--------------------------------------------------------------- */
function cerrarCtx() { hide('ctxmenu'); }

function opcionCtx(menu, iconName, texto, accion, peligro) {
  const b = el('button', peligro ? 'danger' : null);
  b.appendChild(icon(iconName));
  b.appendChild(el('span', null, texto));
  b.addEventListener('click', () => { cerrarCtx(); accion(); });
  menu.appendChild(b);
}

function abrirCtx(x, y, item) {
  const menu = $('ctxmenu');
  menu.textContent = '';

  // Si hay varios marcados y el del clic es uno de ellos, el menú actúa sobre todos
  const sobreSeleccion = item && state.selection.size > 1 && state.selection.has(item.rel);
  const rutas = sobreSeleccion ? [...state.selection] : item ? [item.rel] : [];

  if (item) {
    menu.appendChild(el('div', 'cab', sobreSeleccion ? `${rutas.length} elementos` : item.name));
    if (!sobreSeleccion) {
      if (item.isDir) opcionCtx(menu, 'i-folder', 'Abrir', () => goTo(item.rel));
      else if (isViewable(item.name)) opcionCtx(menu,
        isVideo(item.name) ? 'i-play' : isAudio(item.name) ? 'i-music' : isDoc(item.name) ? 'i-doc' : 'i-image',
        isVideo(item.name) ? 'Reproducir' : isAudio(item.name) ? 'Escuchar' : isDoc(item.name) ? 'Abrir' : 'Ver imagen',
        () => openLightbox(state.viewables.indexOf(item)));
      if (!item.isDir) opcionCtx(menu, 'i-download', 'Descargar', () => downloadRel(item.rel));
    } else {
      opcionCtx(menu, 'i-download', 'Descargar', bulkDownload);
    }
    if (!sobreSeleccion) opcionCtx(menu, 'i-share', 'Compartir enlace…', () => openShare(item));
    opcionCtx(menu, 'i-zip', 'Descargar como ZIP', () => descargarZip(rutas));
    opcionCtx(menu, 'i-move', 'Mover a…', () => openMove(rutas));
    if (!sobreSeleccion) {
      opcionCtx(menu, 'i-pencil', 'Renombrar', () => { state.selected = item; renameSelected(); });
      opcionCtx(menu, 'i-star', favSet.has(item.rel) ? 'Quitar de favoritos' : 'Añadir a favoritos',
        () => toggleFavorite(item.rel));
      if (!item.isDir) opcionCtx(menu, 'i-stack', 'Añadir a álbum…', () => openAlbumPicker([item.rel]));
    } else {
      opcionCtx(menu, 'i-pencil', 'Renombrar en lote…', () => openRenameModal(rutas));
      opcionCtx(menu, 'i-stack', 'Añadir a álbum…', () => openAlbumPicker(rutas.filter(r => {
        const it = state.items.find(i => i.rel === r);
        return it && !it.isDir;
      })));
    }
    opcionCtx(menu, 'i-check-square', sobreSeleccion ? 'Quitar selección' : 'Seleccionar', () => {
      if (sobreSeleccion) exitSelectMode();
      else { if (!state.selectMode) enterSelectMode(); toggleSelect(item); }
    });
    menu.appendChild(el('div', 'sep'));
    opcionCtx(menu, 'i-trash', sobreSeleccion ? 'Enviar a la papelera' : 'Enviar a la papelera', () => {
      if (sobreSeleccion) bulkDelete();
      else { state.selected = item; deleteSelected(); }
    }, true);
  } else {
    opcionCtx(menu, 'i-upload', 'Subir archivos', () => $('file-input').click());
    opcionCtx(menu, 'i-folder-plus', 'Nueva carpeta', () => {
      $('folder-name-input').value = '';
      show('folder-modal');
      $('folder-name-input').focus();
    });
    opcionCtx(menu, 'i-check-square', state.selectMode ? 'Salir de selección' : 'Seleccionar varios',
      () => state.selectMode ? exitSelectMode() : enterSelectMode());
    menu.appendChild(el('div', 'sep'));
    opcionCtx(menu, 'i-refresh', 'Actualizar', refresh);
  }

  // Se muestra fuera de pantalla para medirlo y luego se encaja en el viewport
  menu.style.left = '-9999px';
  menu.style.top = '0';
  show('ctxmenu');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

function checkbox(selected) {
  const box = el('div', 'check');
  box.appendChild(icon('i-check'));
  if (selected) box.classList.add('on');
  return box;
}

function buildRow(item) {
  const row = el('div', 'row');
  if (state.selection.has(item.rel)) row.classList.add('is-sel');
  if (state.selectMode) row.appendChild(checkbox());

  if (!item.isDir && hasThumb(item.name)) {
    const img = el('img', 'thumb');
    img.src = '/api/thumb?path=' + qs(item.rel);
    img.loading = 'lazy';
    img.alt = '';
    // Si el servidor no puede generarla (sin ffmpeg, formato raro), cae al distintivo
    img.addEventListener('error', () => {
      const mini = row.querySelector('.play-mini');
      if (mini) mini.remove();
      img.replaceWith(fileBadge(item.name, false));
    });
    row.appendChild(img);
    if (isVideo(item.name)) {
      const play = el('span', 'play-mini');
      play.appendChild(icon('i-play'));
      row.appendChild(play);
    }
  } else {
    row.appendChild(fileBadge(item.name, item.isDir));
  }

  const info = el('div', 'info');
  info.appendChild(el('div', 'name', item.name));
  info.appendChild(el('div', 'meta',
    (item.isDir ? 'Carpeta' : fmtSize(item.size)) + ' · ' + fmtDate(item.modified)));
  if (state.query) {
    const where = el('div', 'where');
    where.appendChild(icon('i-folder'));
    where.appendChild(el('span', null, item.dir ? item.dir : 'Inicio'));
    info.appendChild(where);
  }
  row.appendChild(info);

  if (!state.selectMode) {
    const menu = el('button', 'icon-btn');
    menu.appendChild(icon('i-dots'));
    menu.setAttribute('aria-label', 'Opciones');
    menu.addEventListener('click', e => { e.stopPropagation(); openActions(item); });
    row.appendChild(menu);
  }

  row.addEventListener('click', e => onItemClick(item, e));
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    abrirCtx(e.clientX, e.clientY, item);
  });
  haceArrastrable(row, item);
  if (item.isDir) haceSoltable(row, item.rel);
  return row;
}

function buildTile(item) {
  const tile = el('div', 'tile');
  if (state.selection.has(item.rel)) tile.classList.add('is-sel');
  const box = el('div', 'thumb-box');

  if (!item.isDir && hasThumb(item.name)) {
    // .photo: la imagen ocupa toda la baldosa y el nombre va sobre un velo degradado
    tile.classList.add('photo');
    const img = el('img');
    img.src = '/api/thumb?path=' + qs(item.rel);
    img.loading = 'lazy';
    img.alt = item.name;
    img.addEventListener('error', () => {
      img.remove();
      tile.classList.remove('photo');
      const play = box.querySelector('.play-badge');
      if (play) play.remove();
      const c = el('div', 'center');
      c.appendChild(fileBadge(item.name, false));
      box.appendChild(c);
    });
    box.appendChild(img);
    if (isVideo(item.name)) {
      const play = el('div', 'play-badge');
      play.appendChild(icon('i-play'));
      box.appendChild(play);
    }
  } else {
    const c = el('div', 'center');
    c.appendChild(fileBadge(item.name, item.isDir));
    box.appendChild(c);
  }

  if (state.selectMode) box.appendChild(checkbox());
  else {
    const dots = el('button', 'dots');
    dots.appendChild(icon('i-dots'));
    dots.setAttribute('aria-label', 'Opciones');
    dots.addEventListener('click', e => { e.stopPropagation(); openActions(item); });
    box.appendChild(dots);
  }
  tile.appendChild(box);

  const cap = el('div', 'cap');
  cap.appendChild(el('span', 'name', item.name));
  cap.appendChild(el('span', 'sz', item.isDir ? '' : fmtSize(item.size)));
  tile.appendChild(cap);

  tile.addEventListener('click', e => onItemClick(item, e));
  tile.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    abrirCtx(e.clientX, e.clientY, item);
  });
  haceArrastrable(tile, item);
  if (item.isDir) haceSoltable(tile, item.rel);
  return tile;
}

/* ---------------------------------------------------------------
   Búsqueda
--------------------------------------------------------------- */
let searchTimer = null;
function onSearchInput() {
  const value = $('search-input').value.trim();
  $('search-clear').hidden = !value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = value.length >= 2 ? value : '';
    if (q === state.query) return;
    state.query = q;
    exitSelectMode();
    refresh();
  }, 300);
}
function clearSearchInput() {
  $('search-input').value = '';
  $('search-clear').hidden = true;
  state.query = '';
}

/* ---------------------------------------------------------------
   Selección múltiple
--------------------------------------------------------------- */
function enterSelectMode() {
  state.selectMode = true;
  $('btn-select').classList.add('is-active');
  updateSelbar();
  render();
}
function exitSelectMode() {
  if (!state.selectMode && !state.selection.size) return;
  state.selectMode = false;
  state.selection.clear();
  $('btn-select').classList.remove('is-active');
  updateSelbar();
  if (state.tab === 'files') render();
}
function toggleSelect(item) {
  if (state.selection.has(item.rel)) state.selection.delete(item.rel);
  else state.selection.add(item.rel);
  updateSelbar();
  render();
}
function updateSelbar() {
  const n = state.selection.size;
  $('selbar').hidden = !state.selectMode;
  $('sel-count').textContent = n === 0
    ? 'Selecciona elementos'
    : `${n} seleccionado${n > 1 ? 's' : ''}`;
  ['sel-move', 'sel-download', 'sel-delete'].forEach(id => { $(id).disabled = n === 0; });
}
function selectedItems() {
  return state.items.filter(i => state.selection.has(i.rel));
}

function downloadRel(rel) {
  const a = document.createElement('a');
  a.href = '/api/download?path=' + qs(rel);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function bulkDelete() {
  const items = selectedItems();
  if (!items.length) return;
  if (!confirm(`¿Enviar ${items.length} elemento${items.length > 1 ? 's' : ''} a la papelera?`)) return;
  try {
    const res = await post('/api/batch', { op: 'delete', paths: items.map(i => i.rel) });
    const data = await res.json();
    reportBatch(data, 'movido a la papelera', 'movidos a la papelera');
    exitSelectMode();
    refresh();
  } catch { showToast('Error de conexión'); }
}

function bulkDownload() {
  const files = selectedItems().filter(i => !i.isDir);
  if (!files.length) { showToast('Las carpetas no se pueden descargar todavía'); return; }
  files.forEach((f, i) => setTimeout(() => downloadRel(f.rel), i * 350));
  showToast(`Descargando ${files.length} archivo${files.length > 1 ? 's' : ''}`);
}

function reportBatch(data, singular, plural) {
  if (data.errors && data.errors.length) {
    showToast(`${data.done} ${data.done === 1 ? singular : plural}, ${data.errors.length} con error: ${data.errors[0].error}`);
  } else {
    showToast(`${data.done} ${data.done === 1 ? singular : plural}`);
  }
}

/* ---------------------------------------------------------------
   Mover a…
--------------------------------------------------------------- */
function openMove(rels) {
  if (!rels.length) return;
  state.pickerMode = 'move';
  state.moving = rels;
  state.pickerPath = state.path;
  $('move-modal').querySelector('h3').textContent = 'Mover a…';
  $('btn-move-here').textContent = 'Mover aquí';
  $('move-sub').textContent = rels.length === 1
    ? `Se moverá "${rels[0].split('/').pop()}"`
    : `Se moverán ${rels.length} elementos`;
  show('move-modal');
  loadPicker();
}

// El mismo selector sirve para elegir dónde caerán los archivos de un enlace
function openFolderForLink() {
  state.pickerMode = 'link';
  state.moving = [];
  state.pickerPath = state.linkPath || '';
  $('move-modal').querySelector('h3').textContent = 'Carpeta de destino';
  $('btn-move-here').textContent = 'Usar esta carpeta';
  $('move-sub').textContent = 'Aquí llegarán los archivos que te envíen';
  show('move-modal');
  loadPicker();
}

async function loadPicker() {
  const list = $('picker-list');
  $('picker-path').textContent = state.pickerPath || 'Inicio';
  list.textContent = '';
  list.appendChild(el('div', 'none', 'Cargando…'));
  try {
    const res = await api('/api/files?path=' + qs(state.pickerPath));
    const data = await res.json();
    list.textContent = '';

    if (state.pickerPath) {
      const up = el('button');
      up.appendChild(icon('i-up'));
      up.appendChild(el('span', null, '.. subir un nivel'));
      up.addEventListener('click', () => { state.pickerPath = parentOf(state.pickerPath); loadPicker(); });
      list.appendChild(up);
    }
    // No se puede mover una carpeta dentro de sí misma: se ocultan del destino
    const dirs = (data.items || []).filter(i => i.isDir)
      .filter(i => !state.moving.includes(joinPath(state.pickerPath, i.name)));
    for (const d of dirs) {
      const btn = el('button');
      btn.appendChild(icon('i-folder'));
      btn.appendChild(el('span', null, d.name));
      btn.addEventListener('click', () => {
        state.pickerPath = joinPath(state.pickerPath, d.name);
        loadPicker();
      });
      list.appendChild(btn);
    }
    if (!dirs.length && !state.pickerPath) {
      list.appendChild(el('div', 'none', 'No hay subcarpetas. Puedes mover aquí, a la raíz.'));
    }
  } catch {
    list.textContent = '';
    list.appendChild(el('div', 'none', 'No se pudo cargar'));
  }
}

async function confirmMove() {
  const dest = state.pickerPath;
  if (state.pickerMode === 'link') {
    state.linkPath = dest;
    $('link-folder-name').textContent = dest || 'Inicio';
    hide('move-modal');
    return;
  }
  try {
    const res = await post('/api/batch', { op: 'move', paths: state.moving, dest });
    const data = await res.json();
    hide('move-modal');
    reportBatch(data, 'elemento movido', 'elementos movidos');
    exitSelectMode();
    refresh();
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Visor de fotos
--------------------------------------------------------------- */
function openLightbox(index) {
  if (index < 0 || !state.viewables.length) return;
  state.lbIndex = index;
  paintLightbox();
  show('lightbox');
}
function closeLightbox() {
  hide('lightbox');
  $('lb-exif').hidden = true;
  pararSlideshow();
  DOC_EDITANDO = null;
  vaciarVisor();
  state.lbIndex = -1;
}

// Parar la reproducción de verdad: sin esto el vídeo sigue sonando al cerrar
function vaciarVisor() {
  const caja = $('lb-media');
  caja.querySelectorAll('video, audio').forEach(m => { m.pause(); m.removeAttribute('src'); m.load(); });
  caja.textContent = '';
}

function paintLightbox() {
  const item = state.viewables[state.lbIndex];
  if (!item) return;
  const caja = $('lb-media');
  vaciarVisor();
  DOC_EDITANDO = null;
  $('lb-edit').classList.remove('is-active');
  $('lb-edit').hidden = !isTexto(item.name);
  $('lb-fav').hidden = false;
  pintarLbFav(item);
  $('lb-play').hidden = state.viewables.length <= 1;
  const src = '/api/preview?path=' + qs(item.rel);
  // Las hojas no se abren en pestaña: no hay PDF que enseñar, se pintan aquí
  $('lb-open').hidden = !(isPdf(item.name) || (isOffice(item.name) && !isSheet(item.name)));
  $('lb-info').hidden = !isImage(item.name);
  $('lb-exif').hidden = true;   // al cambiar de foto se cierra el panel

  if (isDoc(item.name)) {
    pintarDocumento(caja, item);
  } else if (isVideo(item.name)) {
    const v = el('video');
    v.src = src;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    v.preload = 'metadata';
    caja.appendChild(v);
  } else if (isAudio(item.name)) {
    const card = el('div', 'lb-audio');
    const disco = el('div', 'disco');
    disco.appendChild(icon('i-music'));
    card.appendChild(disco);
    card.appendChild(el('div', 'nom', item.name));
    const a = el('audio');
    a.src = src;
    a.controls = true;
    a.autoplay = true;
    a.preload = 'metadata';
    card.appendChild(a);
    caja.appendChild(card);
  } else {
    const img = el('img');
    img.src = src;
    img.alt = item.name;
    caja.appendChild(img);
  }

  $('lb-name').textContent = item.name;
  $('lb-counter').textContent =
    `${state.lbIndex + 1} de ${state.viewables.length} · ${fmtSize(item.size)} · ${fmtDate(item.modified)}`;
  const multi = state.viewables.length > 1;
  $('lb-prev').hidden = !multi;
  $('lb-next').hidden = !multi;
}
/* ---------------------------------------------------------------
   Visor de documentos
--------------------------------------------------------------- */
function estadoDoc(iconName, titulo, sub, item) {
  const caja = el('div', 'doc-estado');
  const em = el('div', 'em');
  em.appendChild(icon(iconName));
  caja.appendChild(em);
  caja.appendChild(el('h3', null, titulo));
  if (sub) caja.appendChild(el('p', null, sub));
  if (item) {
    const btn = el('button', 'btn primary');
    btn.appendChild(icon('i-download'));
    btn.appendChild(el('span', null, 'Descargar'));
    btn.addEventListener('click', () => downloadRel(item.rel));
    caja.appendChild(btn);
  }
  return caja;
}

// Marco para PDF y para Office. Los dos van dentro del mismo envoltorio: sin él,
// un iframe suelto se queda con su altura por defecto de 150 px.
function marcoDocumento(url, nombre) {
  const envoltorio = el('div', 'lb-pdf');
  const marco = el('iframe', 'lb-frame');
  marco.src = url;
  marco.title = nombre;
  envoltorio.appendChild(marco);
  // Salida de emergencia: algunos navegadores, sobre todo en móvil, no pintan
  // documentos dentro de un marco y no avisan de ello
  const salida = el('button', 'lb-fallback');
  salida.appendChild(icon('i-external'));
  salida.appendChild(el('span', null, '¿No se ve bien? Ábrelo en una pestaña'));
  salida.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  envoltorio.appendChild(salida);
  return envoltorio;
}

/* ---------------------------------------------------------------
   Visor de hojas de cálculo (solo lectura)
--------------------------------------------------------------- */
// Letra de columna al estilo de Excel: A, B… Z, AA, AB…
function letraColumna(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function renderHoja(datos, item) {
  const caja = el('div', 'hoja');
  let indice = 0;

  const pestanas = el('div', 'hoja-pestanas');
  const zona = el('div', 'hoja-zona');

  function pintar() {
    const hoja = datos.hojas[indice];
    zona.textContent = '';
    [...pestanas.children].forEach((b, i) => b.classList.toggle('is-active', i === indice));

    if (!hoja || !hoja.filas.length) {
      zona.appendChild(el('div', 'hoja-vacia', 'Esta hoja está vacía'));
      return;
    }
    const columnas = hoja.filas.reduce((n, f) => Math.max(n, f.length), 0);
    const tabla = el('table', 'hoja-tabla');

    const thead = el('thead');
    const trh = el('tr');
    trh.appendChild(el('th', 'esquina', ''));
    for (let c = 1; c <= columnas; c++) {
      const th = el('th', 'col', letraColumna(c));
      const ancho = hoja.anchos[c - 1];
      // El ancho de Excel va en caracteres: se pasa a píxeles a ojo
      if (ancho) th.style.minWidth = Math.min(Math.round(ancho * 8), 420) + 'px';
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    tabla.appendChild(thead);

    const tbody = el('tbody');
    hoja.filas.forEach((fila, i) => {
      const tr = el('tr');
      tr.appendChild(el('th', 'fila', String(i + 1)));
      for (let c = 0; c < columnas; c++) {
        const celda = fila[c];
        const td = el('td', celda && celda.n ? 'num' : null, celda ? celda.t : '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    tabla.appendChild(tbody);
    zona.appendChild(tabla);

    if (datos.recortado) {
      zona.appendChild(el('div', 'doc-aviso',
        `Hoja muy grande: se muestran las primeras ${datos.maxFilas} filas y ${datos.maxCols} columnas. ` +
        'Descarga el archivo para verlo entero.'));
    }
  }

  datos.hojas.forEach((h, i) => {
    const b = el('button', 'hoja-pestana');
    b.appendChild(el('span', null, h.nombre));
    const n = h.filas.length;
    b.appendChild(el('small', null, n ? `${n} fila${n === 1 ? '' : 's'}` : 'vacía'));
    b.addEventListener('click', () => { indice = i; pintar(); });
    pestanas.appendChild(b);
  });

  caja.appendChild(zona);
  if (datos.hojas.length > 1) caja.appendChild(pestanas);
  else if (datos.hojas.length === 1) {
    const sola = el('div', 'hoja-pie', datos.hojas[0].nombre);
    caja.appendChild(sola);
  }
  pintar();
  return caja;
}

async function pintarDocumento(caja, item) {
  // Hoja de cálculo: rejilla de verdad, no un PDF paginado
  if (isSheet(item.name)) {
    const cargando = el('div', 'doc-estado');
    cargando.appendChild(el('h3', null, 'Abriendo la hoja…'));
    caja.appendChild(cargando);
    try {
      const res = await api('/api/sheet?path=' + qs(item.rel));
      const datos = await res.json();
      if (state.lbIndex < 0 || state.viewables[state.lbIndex] !== item) return;
      caja.textContent = '';
      if (!res.ok) {
        caja.appendChild(estadoDoc('i-doc-alert', 'No se pudo abrir', datos.error, item));
        return;
      }
      caja.appendChild(renderHoja(datos, item));
    } catch {
      caja.textContent = '';
      caja.appendChild(estadoDoc('i-doc-alert', 'Error de conexión', null, item));
    }
    return;
  }

  // PDF: lo pinta el visor propio del navegador
  if (isPdf(item.name)) {
    caja.appendChild(marcoDocumento('/api/preview?path=' + qs(item.rel), item.name));
    return;
  }

  // Office: convertido a PDF en el servidor
  if (isOffice(item.name)) {
    if (state.caps && state.caps.office === false) {
      caja.appendChild(estadoDoc('i-doc-alert', 'Sin vista previa',
        'Este servidor no tiene LibreOffice instalado para convertir documentos de Office.', item));
      return;
    }
    caja.appendChild(estadoDoc('i-refresh', 'Convirtiendo el documento…',
      'La primera vez tarda unos segundos; después queda en caché.'));
    const url = '/api/office?path=' + qs(item.rel);
    try {
      // HEAD primero: dispara la conversión y deja saber si salió bien, sin
      // arriesgarse a que el marco acabe enseñando un error en JSON
      const res = await fetch(url, { method: 'HEAD', credentials: 'include' });
      if (state.lbIndex < 0 || state.viewables[state.lbIndex] !== item) return;  // ya cambió de archivo
      caja.textContent = '';
      if (!res.ok) {
        caja.appendChild(estadoDoc('i-doc-alert', 'No se pudo convertir',
          res.status === 501 ? 'Falta LibreOffice en el servidor.' : 'El documento no se pudo abrir.', item));
        return;
      }
      caja.appendChild(marcoDocumento(url, item.name));
    } catch {
      caja.textContent = '';
      caja.appendChild(estadoDoc('i-doc-alert', 'Error de conexión', null, item));
    }
    return;
  }

  // Texto, Markdown, CSV
  const cargando = el('div', 'doc-estado');
  cargando.appendChild(el('h3', null, 'Cargando…'));
  caja.appendChild(cargando);
  try {
    const res = await api('/api/text?path=' + qs(item.rel));
    const data = await res.json();
    if (state.lbIndex < 0 || state.viewables[state.lbIndex] !== item) return;
    caja.textContent = '';
    if (!res.ok) {
      caja.appendChild(estadoDoc('i-doc-alert', 'No se puede mostrar', data.error, item));
      return;
    }
    const doc = el('div', 'lb-doc');
    if (isMarkdown(item.name)) doc.appendChild(renderMarkdown(data.text));
    else if (isCsv(item.name)) doc.appendChild(renderCsv(data.text, item.name));
    else doc.appendChild(el('pre', 'doc-texto', data.text));
    if (data.truncated) {
      doc.appendChild(el('p', 'doc-aviso',
        `Mostrando los primeros ${fmtSize(data.shown)} de ${fmtSize(data.size)}. Descarga el archivo para verlo entero.`));
    }
    caja.appendChild(doc);
  } catch {
    caja.textContent = '';
    caja.appendChild(estadoDoc('i-doc-alert', 'Error de conexión', null, item));
  }
}

/* ---------------------------------------------------------------
   Edición de archivos de texto, desde el propio visor
--------------------------------------------------------------- */
let DOC_EDITANDO = null;   // { item } mientras se está editando

async function alternarEdicion() {
  const item = state.viewables[state.lbIndex];
  if (!item || !isTexto(item.name)) return;
  const caja = $('lb-media');

  if (DOC_EDITANDO && DOC_EDITANDO.item === item) {
    DOC_EDITANDO = null;
    $('lb-edit').classList.remove('is-active');
    pintarDocumento(caja, item);
    return;
  }

  $('lb-edit').classList.add('is-active');
  caja.textContent = '';
  caja.appendChild(estadoDoc('i-refresh', 'Cargando…'));
  try {
    const res = await api('/api/text?path=' + qs(item.rel));
    const data = await res.json();
    if (state.lbIndex < 0 || state.viewables[state.lbIndex] !== item) return;
    if (!res.ok) {
      caja.textContent = '';
      caja.appendChild(estadoDoc('i-doc-alert', 'No se pudo abrir', data.error, item));
      $('lb-edit').classList.remove('is-active');
      return;
    }
    DOC_EDITANDO = { item };
    caja.textContent = '';
    const wrap = el('div', 'doc-edit');
    const ta = el('textarea');
    ta.value = data.text;
    ta.spellcheck = false;
    wrap.appendChild(ta);
    const acciones = el('div', 'doc-edit-acciones');
    const cancelar = el('button', 'btn', 'Cancelar');
    cancelar.addEventListener('click', () => alternarEdicion());
    const guardar = el('button', 'btn primary', 'Guardar');
    guardar.addEventListener('click', () => guardarEdicion(item, ta.value));
    acciones.appendChild(cancelar);
    acciones.appendChild(guardar);
    wrap.appendChild(acciones);
    caja.appendChild(wrap);
    ta.focus();
  } catch {
    caja.textContent = '';
    caja.appendChild(estadoDoc('i-doc-alert', 'Error de conexión', null, item));
    $('lb-edit').classList.remove('is-active');
  }
}

async function guardarEdicion(item, texto) {
  try {
    const res = await api('/api/text?path=' + qs(item.rel), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texto }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo guardar'); return; }
    showToast('Guardado');
    DOC_EDITANDO = null;
    $('lb-edit').classList.remove('is-active');
    if (state.lbIndex >= 0 && state.viewables[state.lbIndex] === item) pintarDocumento($('lb-media'), item);
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Favorito y presentación (slideshow), desde el visor
--------------------------------------------------------------- */
function pintarLbFav(item) {
  const btn = $('lb-fav');
  const activo = favSet.has(item.rel);
  btn.classList.toggle('is-active', activo);
  const texto = activo ? 'Quitar de favoritos' : 'Añadir a favoritos';
  btn.title = texto;
  btn.setAttribute('aria-label', texto);
}

let slideshowTimer = null;
function alternarSlideshow() {
  if (slideshowTimer) { pararSlideshow(); return; }
  slideshowTimer = setInterval(() => lbStep(1), 4000);
  $('lb-play').classList.add('is-active');
  $('lb-play').querySelector('use').setAttribute('href', '#i-pause');
  $('lb-play').title = 'Detener presentación';
}
function pararSlideshow() {
  if (!slideshowTimer) return;
  clearInterval(slideshowTimer);
  slideshowTimer = null;
  $('lb-play').classList.remove('is-active');
  $('lb-play').querySelector('use').setAttribute('href', '#i-play');
  $('lb-play').title = 'Presentación';
}

/* ---------------------------------------------------------------
   Mapa de fotos (Leaflet, alojado aquí; los tiles vienen de OpenStreetMap)
--------------------------------------------------------------- */
const MP = { mapa: null, capa: null, fotos: [], cargado: false };

async function loadMap() {
  const vacio = $('mapa-vacio');
  if (typeof L === 'undefined') {
    vacio.hidden = false;
    vacio.textContent = '';
    vacio.appendChild(el('h3', null, 'No se pudo cargar el mapa'));
    vacio.appendChild(el('p', null, 'Falta la librería en /vendor/leaflet/.'));
    return;
  }
  if (!MP.mapa) {
    MP.mapa = L.map('mapa', { zoomControl: true, attributionControl: true })
      .setView([40.4168, -3.7038], 5);
    const url = (state.caps && state.caps.tileUrl) || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const attr = (state.caps && state.caps.tileAttr) ||
      '&copy; colaboradores de OpenStreetMap';
    L.tileLayer(url, { maxZoom: 19, attribution: attr }).addTo(MP.mapa);
    MP.capa = L.layerGroup().addTo(MP.mapa);
    // Solo al cambiar el zoom: la agrupación depende de él, no del desplazamiento.
    // Con 'moveend' además se rompía el globo: abrirlo desplaza el mapa para que
    // quepa, eso disparaba el evento y los marcadores se reconstruían encima.
    MP.mapa.on('zoomend', () => { MP.mapa.closePopup(); pintarPuntos(); });
  }
  // El contenedor estaba oculto al crearse el mapa: hay que recalcular su tamaño
  setTimeout(() => MP.mapa.invalidateSize(), 60);
  if (!MP.cargado) await pedirFotosMapa();
}

async function pedirFotosMapa() {
  $('map-resumen').textContent = 'Buscando fotos con ubicación…';
  try {
    const res = await api('/api/photomap');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    MP.fotos = data.fotos || [];
    MP.cargado = true;

    const resumen = MP.fotos.length
      ? `${MP.fotos.length} foto${MP.fotos.length === 1 ? '' : 's'} con ubicación, de ${data.total} en total`
      : `Ninguna de tus ${data.total} fotos guarda coordenadas`;
    $('map-resumen').textContent = resumen + (data.cortado ? ` · tope de ${data.limite}` : '');

    const vacio = $('mapa-vacio');
    if (!MP.fotos.length) {
      vacio.textContent = '';
      const em = el('div', 'em');
      em.appendChild(icon('i-pin'));
      vacio.appendChild(em);
      vacio.appendChild(el('h3', null, 'Sin fotos ubicadas'));
      vacio.appendChild(el('p', null,
        'Ninguna foto trae coordenadas. Suelen llevarlas las hechas con el móvil, ' +
        'si tenías activada la ubicación al tomarlas.'));
      vacio.hidden = false;
      return;
    }
    vacio.hidden = true;

    // Encajar la vista en todos los puntos
    const limites = L.latLngBounds(MP.fotos.map(f => [f.lat, f.lon]));
    MP.mapa.fitBounds(limites, { padding: [40, 40], maxZoom: 14 });
    pintarPuntos();
  } catch {
    $('map-resumen').textContent = 'No se pudieron cargar las ubicaciones';
  }
}

// Agrupación propia por rejilla: sin plugin extra, y suficiente para el caso
function pintarPuntos() {
  if (!MP.mapa || !MP.capa || !MP.fotos.length) return;
  MP.capa.clearLayers();
  const zoom = MP.mapa.getZoom();
  const paso = 360 / Math.pow(2, Math.min(zoom, 18)) * 1.4;   // celdas más finas al acercar

  const celdas = new Map();
  for (const f of MP.fotos) {
    const clave = `${Math.round(f.lat / paso)}|${Math.round(f.lon / paso)}`;
    if (!celdas.has(clave)) celdas.set(clave, []);
    celdas.get(clave).push(f);
  }

  for (const grupo of celdas.values()) {
    const lat = grupo.reduce((n, f) => n + f.lat, 0) / grupo.length;
    const lon = grupo.reduce((n, f) => n + f.lon, 0) / grupo.length;

    if (grupo.length === 1) {
      const f = grupo[0];
      const punto = L.circleMarker([f.lat, f.lon], {
        radius: 8, weight: 2, color: '#fff', fillColor: '#4f7cff', fillOpacity: .95,
      }).addTo(MP.capa);
      punto.bindPopup(() => popupFoto(f), { minWidth: 200, closeButton: true });
    } else {
      const tam = grupo.length > 99 ? 46 : grupo.length > 9 ? 40 : 34;
      const icono = L.divIcon({
        className: '',
        html: `<div class="cluster" style="width:${tam}px;height:${tam}px"></div>`,
        iconSize: [tam, tam], iconAnchor: [tam / 2, tam / 2],
      });
      const marca = L.marker([lat, lon], { icon: icono }).addTo(MP.capa);
      // El número se pone por texto, nunca por HTML
      const nodo = marca.getElement && marca.getElement();
      marca.on('add', () => {
        const div = marca.getElement() && marca.getElement().querySelector('.cluster');
        if (div) div.textContent = grupo.length > 999 ? '999+' : String(grupo.length);
      });
      if (nodo) {
        const div = nodo.querySelector('.cluster');
        if (div) div.textContent = String(grupo.length);
      }
      marca.on('click', () => {
        MP.mapa.setView([lat, lon], Math.min(MP.mapa.getZoom() + 3, 18));
      });
    }
  }
}

function popupFoto(f) {
  const caja = el('div', 'mapa-pop');
  const img = el('img');
  img.src = '/api/thumb?path=' + qs(f.rel);
  img.alt = f.nombre;
  img.addEventListener('error', () => img.remove());
  caja.appendChild(img);
  const cuerpo = el('div', 'cuerpo');
  cuerpo.appendChild(el('div', 'nm', f.nombre));
  cuerpo.appendChild(el('div', 'fh', fmtDate(f.t) + ' · ' + (f.rel.includes('/') ? parentOf(f.rel) : 'Inicio')));
  const btn = el('button', null, 'Ver foto');
  btn.addEventListener('click', () => abrirDesdeMapa(f));
  cuerpo.appendChild(btn);
  caja.appendChild(cuerpo);
  return caja;
}

// El visor trabaja sobre una lista: se le pasa la del mapa, ordenada por fecha
function abrirDesdeMapa(f) {
  state.viewables = MP.fotos.map(x => ({
    name: x.nombre, rel: x.rel, isDir: false, size: x.size || 0, modified: x.t,
  }));
  const i = MP.fotos.findIndex(x => x.rel === f.rel);
  openLightbox(i < 0 ? 0 : i);
}

/* ---------------------------------------------------------------
   Detalles de la foto (EXIF)
--------------------------------------------------------------- */
// La exposición viene en segundos: 0.004 se lee mucho mejor como 1/250
function fmtExposicion(s) {
  if (!s) return null;
  if (s >= 1) return `${s} s`;
  return `1/${Math.round(1 / s)} s`;
}

function filaExif(padre, clave, valor) {
  if (valor === null || valor === undefined || valor === '') return;
  const f = el('div', 'exif-fila');
  f.appendChild(el('span', 'k', clave));
  f.appendChild(el('span', 'v', String(valor)));
  padre.appendChild(f);
}

async function alternarExif() {
  const panel = $('lb-exif');
  if (!panel.hidden) { panel.hidden = true; return; }
  const item = state.viewables[state.lbIndex];
  if (!item) return;

  panel.textContent = '';
  panel.appendChild(el('div', 'exif-vacio', 'Leyendo los datos…'));
  panel.hidden = false;

  try {
    const res = await api('/api/exif?path=' + qs(item.rel));
    const e = await res.json();
    if (state.viewables[state.lbIndex] !== item) return;
    panel.textContent = '';
    if (!res.ok) { panel.appendChild(el('div', 'exif-vacio', e.error || 'No se pudieron leer')); return; }

    panel.appendChild(el('h4', null, e.nombre));
    panel.appendChild(el('p', 'sub', e.hayExif ? 'Datos de la cámara' : 'Esta foto no guarda datos de cámara'));

    filaExif(panel, 'Tomada', e.tomada ? new Date(e.tomada).toLocaleString('es-ES') : null);
    filaExif(panel, 'Cámara', e.camara);
    filaExif(panel, 'Objetivo', e.objetivo);
    filaExif(panel, 'Exposición', fmtExposicion(e.exposicion));
    filaExif(panel, 'Diafragma', e.diafragma ? `f/${e.diafragma}` : null);
    filaExif(panel, 'ISO', e.iso);
    filaExif(panel, 'Focal', e.focal ? `${e.focal} mm${e.focal35 && e.focal35 !== e.focal ? ` (${e.focal35} mm equiv.)` : ''}` : null);
    filaExif(panel, 'Dimensiones', e.ancho && e.alto ? `${e.ancho} × ${e.alto}` : null);
    filaExif(panel, 'Tamaño', fmtSize(e.tamano));
    filaExif(panel, 'Software', e.software);
    filaExif(panel, 'Altitud', e.altitud !== null && e.altitud !== undefined ? `${e.altitud} m` : null);

    if (e.lat !== null && e.lat !== undefined && e.lon !== null) {
      // Enlace, no botón: así se puede abrir en otra pestaña o copiar la dirección
      const enlace = el('a', 'exif-mapa');
      enlace.href = `https://www.google.com/maps?q=${e.lat},${e.lon}`;
      enlace.target = '_blank';
      enlace.rel = 'noopener noreferrer';
      enlace.appendChild(icon('i-pin'));
      enlace.appendChild(el('span', null, 'Ver en Google Maps'));
      panel.appendChild(enlace);
      panel.appendChild(el('div', 'exif-coords', `${e.lat.toFixed(6)}, ${e.lon.toFixed(6)}`));
    } else if (e.hayExif) {
      panel.appendChild(el('div', 'exif-coords', 'Sin coordenadas guardadas'));
    }
  } catch {
    panel.textContent = '';
    panel.appendChild(el('div', 'exif-vacio', 'Error de conexión'));
  }
}

function lbStep(delta) {
  if (!state.viewables.length) return;
  state.lbIndex = (state.lbIndex + delta + state.viewables.length) % state.viewables.length;
  paintLightbox();
}

/* ---------------------------------------------------------------
   Acciones individuales
--------------------------------------------------------------- */
function openActions(item) {
  state.selected = item;
  $('action-title').textContent = item.name;
  $('action-sub').textContent =
    (item.isDir ? 'Carpeta' : fmtSize(item.size)) + ' · ' + fmtDate(item.modified);
  $('action-open').hidden = item.isDir || !isViewable(item.name);
  $('action-open-label').textContent =
    isVideo(item.name) ? 'Reproducir' : isAudio(item.name) ? 'Escuchar'
    : isDoc(item.name) ? 'Abrir documento' : 'Ver imagen';
  $('action-download').hidden = item.isDir;

  const esHeic = /\.(heic|heif)$/i.test(item.name);
  const esOfficeConvertible = /\.(docx?|pptx?|odt|odp|rtf|pages|key)$/i.test(item.name);
  $('action-download-jpg').hidden = item.isDir || !esHeic || (state.caps && state.caps.sharp === false);
  $('action-download-pdf').hidden = item.isDir || !esOfficeConvertible || (state.caps && state.caps.office === false);

  $('action-fav-label').textContent = favSet.has(item.rel) ? 'Quitar de favoritos' : 'Añadir a favoritos';
  $('action-fav').hidden = false;
  $('action-album').hidden = item.isDir;

  $('action-zip').hidden = false;
  show('action-modal');
}
function downloadConvertido(rel, as) {
  const a = document.createElement('a');
  a.href = '/api/download?path=' + qs(rel) + '&as=' + as;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function renameSelected() {
  const item = state.selected;
  hide('action-modal');
  if (!item) return;
  const newName = prompt('Nuevo nombre:', item.name);
  if (!newName || newName === item.name) return;
  if (/[\\/]/.test(newName)) { showToast('El nombre no puede contener / ni \\'); return; }
  const dir = parentOf(item.rel);
  try {
    const res = await post('/api/move', { from: item.rel, to: joinPath(dir, newName) });
    if (res.ok) { showToast('Renombrado'); refresh(); }
    else showToast(await errorOf(res, 'No se pudo renombrar'));
  } catch { showToast('Error de conexión'); }
}

async function deleteSelected() {
  const item = state.selected;
  hide('action-modal');
  if (!item) return;
  const what = item.isDir ? 'la carpeta y todo su contenido' : 'el archivo';
  if (!confirm(`¿Enviar ${what} "${item.name}" a la papelera?`)) return;
  try {
    const res = await api('/api/files?path=' + qs(item.rel), { method: 'DELETE' });
    if (res.ok) { showToast('En la papelera. Puedes restaurarlo desde ahí.'); refresh(); }
    else showToast(await errorOf(res, 'No se pudo eliminar'));
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Papelera
--------------------------------------------------------------- */
async function loadTrash() {
  const box = $('trash-list');
  box.className = 'list';
  box.textContent = '';
  box.appendChild(el('div', 'skel', ''));
  try {
    const res = await api('/api/trash');
    const data = await res.json();
    $('trash-note').textContent = `Los elementos se borran solos pasados ${data.ttlDays} días`;
    box.textContent = '';
    if (!data.items.length) {
      box.className = '';
      box.appendChild(emptyState('La papelera está vacía', 'Lo que elimines aparecerá aquí', 'i-trash'));
      $('btn-empty-trash').disabled = true;
      return;
    }
    $('btn-empty-trash').disabled = false;
    for (const entry of data.items) {
      const row = el('div', 'trash-row');
      row.appendChild(fileBadge(entry.name, entry.isDir));
      const info = el('div', 'info');
      info.appendChild(el('div', 'name', entry.name));
      info.appendChild(el('div', 'meta',
        `${entry.isDir ? 'Carpeta' : fmtSize(entry.size)} · desde ${entry.from || 'Inicio'} · ${fmtDate(entry.deletedAt)}`));
      row.appendChild(info);

      const restore = el('button', 'icon-btn');
      restore.appendChild(icon('i-restore'));
      restore.title = 'Restaurar';
      restore.setAttribute('aria-label', 'Restaurar');
      restore.addEventListener('click', () => restoreTrash(entry));
      row.appendChild(restore);

      const purge = el('button', 'icon-btn');
      purge.appendChild(icon('i-x'));
      purge.title = 'Eliminar definitivamente';
      purge.setAttribute('aria-label', 'Eliminar definitivamente');
      purge.addEventListener('click', () => purgeTrash(entry));
      row.appendChild(purge);

      box.appendChild(row);
    }
  } catch {
    box.textContent = '';
    box.className = '';
    box.appendChild(emptyState('No se pudo cargar la papelera'));
  }
}

async function restoreTrash(entry) {
  try {
    const res = await post('/api/trash/restore', { id: entry.id });
    const data = await res.json();
    if (res.ok) {
      showToast(data.restoredAs !== entry.name
        ? `Restaurado como "${data.restoredAs}" (ya existía otro con ese nombre)`
        : `"${entry.name}" restaurado en ${entry.from || 'Inicio'}`);
      loadTrash();
    } else showToast(data.error || 'No se pudo restaurar');
  } catch { showToast('Error de conexión'); }
}

async function purgeTrash(entry) {
  if (!confirm(`¿Eliminar "${entry.name}" definitivamente? Esto no se puede deshacer.`)) return;
  try {
    const res = await api('/api/trash/' + qs(entry.id), { method: 'DELETE' });
    if (res.ok) { showToast('Eliminado definitivamente'); loadTrash(); }
    else showToast(await errorOf(res, 'No se pudo eliminar'));
  } catch { showToast('Error de conexión'); }
}

async function emptyTrash() {
  if (!confirm('¿Vaciar la papelera por completo? Esto no se puede deshacer.')) return;
  try {
    const res = await api('/api/trash', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) { showToast(`${data.removed} elemento(s) eliminados`); loadTrash(); }
    else showToast(data.error || 'No se pudo vaciar');
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Subida
--------------------------------------------------------------- */
/* ---------------------------------------------------------------
   Cola de subida
   Un archivo por petición y tres a la vez: si falla uno, se reintenta
   solo ese. Antes iba todo en una única petición y un corte a mitad
   se llevaba el lote entero sin decir cuáles habían llegado.
--------------------------------------------------------------- */
const UP = { items: [], activos: 0, MAX: 3, seq: 0 };
let refreshTimer = null;

function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (state.tab === 'files') refresh(); }, 600);
}

function handleUpload(files, destino) {
  if (!files || !files.length) return;
  const dest = destino === undefined ? state.path : destino;
  for (const f of Array.from(files)) {
    UP.items.push({ id: ++UP.seq, file: f, name: f.name, size: f.size, dest,
                    estado: 'espera', subido: 0, xhr: null, el: null });
  }
  $('upbar').classList.remove('plegada');
  show('upbar');
  hide('upbar-close');
  renderQueue();
  bombear();
}

function bombear() {
  while (UP.activos < UP.MAX) {
    const siguiente = UP.items.find(i => i.estado === 'espera');
    if (!siguiente) break;
    subirUno(siguiente);
  }
  if (!UP.items.some(i => i.estado === 'espera' || i.estado === 'subiendo')) terminarCola();
  actualizarCabecera();
}

function subirUno(item) {
  item.estado = 'subiendo';
  UP.activos++;
  const form = new FormData();
  form.append('files', item.file);

  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  xhr.open('POST', '/api/upload?path=' + qs(item.dest));
  xhr.withCredentials = true;
  xhr.upload.addEventListener('progress', e => {
    if (!e.lengthComputable) return;
    item.subido = e.loaded;
    pintarFila(item);
    actualizarCabecera();
  });
  xhr.addEventListener('load', () => {
    UP.activos--;
    if (xhr.status === 200) {
      item.estado = 'ok';
      item.subido = item.size;
    } else if (xhr.status === 401) {
      item.estado = 'error';
      item.error = 'Sesión caducada';
      showLogin();
    } else {
      item.estado = 'error';
      try { item.error = JSON.parse(xhr.responseText).error || 'Error ' + xhr.status; }
      catch { item.error = 'Error ' + xhr.status; }
    }
    trasItem(item);
  });
  xhr.addEventListener('error', () => { UP.activos--; item.estado = 'error'; item.error = 'Sin conexión'; trasItem(item); });
  xhr.addEventListener('abort', () => { UP.activos--; item.estado = 'cancelado'; item.error = 'Cancelado'; trasItem(item); });
  xhr.send(form);
  pintarFila(item);
}

function trasItem(item) {
  item.xhr = null;
  pintarFila(item);
  if (item.estado === 'ok' && item.dest === state.path && !state.query) refreshSoon();
  bombear();
}

function renderQueue() {
  const lista = $('upbar-list');
  for (const item of UP.items) {
    if (item.el) continue;
    const row = el('div', 'uprow');
    row.appendChild(el('span', 'nm', item.name));
    const mini = el('span', 'mini');
    const barra = el('i');
    mini.appendChild(barra);
    row.appendChild(mini);
    row.appendChild(el('span', 'st', ''));
    item.el = row;
    item.barra = barra;
    lista.appendChild(row);
    pintarFila(item);
  }
}

function pintarFila(item) {
  if (!item.el) return;
  const pct = item.size ? Math.round((item.subido / item.size) * 100) : 0;
  item.barra.style.width = (item.estado === 'ok' ? 100 : pct) + '%';
  item.el.classList.toggle('ok', item.estado === 'ok');
  item.el.classList.toggle('err', item.estado === 'error' || item.estado === 'cancelado');
  const st = item.el.querySelector('.st');
  st.textContent =
    item.estado === 'ok' ? '✓ ' + fmtSize(item.size)
    : item.estado === 'error' || item.estado === 'cancelado' ? (item.error || 'Error')
    : item.estado === 'subiendo' ? pct + '%'
    : 'en cola';
}

function actualizarCabecera() {
  const total = UP.items.reduce((n, i) => n + i.size, 0);
  const hecho = UP.items.reduce((n, i) => n + (i.estado === 'ok' ? i.size : i.subido), 0);
  const pct = total ? Math.round((hecho / total) * 100) : 0;
  const listos = UP.items.filter(i => i.estado === 'ok').length;
  const fallidos = UP.items.filter(i => i.estado === 'error' || i.estado === 'cancelado').length;
  $('upbar-fill').style.width = pct + '%';
  $('upbar-pct').textContent = pct + '%';
  $('upbar-label').textContent = `${listos} de ${UP.items.length} subidos` +
    (fallidos ? ` · ${fallidos} con error` : '');
  $('upbar-retry').hidden = !fallidos;
}

function terminarCola() {
  const listos = UP.items.filter(i => i.estado === 'ok').length;
  const fallidos = UP.items.filter(i => i.estado === 'error' || i.estado === 'cancelado').length;
  hide('upbar-cancel');
  show('upbar-close');
  if (!fallidos) {
    showToast(listos === 1 ? 'Archivo subido' : `${listos} archivos subidos`);
    setTimeout(() => { if (!UP.items.some(i => i.estado === 'espera' || i.estado === 'subiendo')) cerrarCola(); }, 2500);
  }
  refreshSoon();
}

function cerrarCola() {
  UP.items = [];
  UP.activos = 0;
  $('upbar-list').textContent = '';
  $('upbar-fill').style.width = '0%';
  hide('upbar');
  show('upbar-cancel');
  hide('upbar-close');
  $('file-input').value = '';
}

function cancelarCola() {
  for (const i of UP.items) {
    if (i.estado === 'espera') { i.estado = 'cancelado'; i.error = 'Cancelado'; pintarFila(i); }
    else if (i.xhr) i.xhr.abort();
  }
  actualizarCabecera();
}

function reintentarFallidos() {
  for (const i of UP.items) {
    if (i.estado === 'error' || i.estado === 'cancelado') {
      i.estado = 'espera';
      i.subido = 0;
      i.error = null;
      pintarFila(i);
    }
  }
  show('upbar-cancel');
  hide('upbar-close');
  bombear();
}

async function createFolder() {
  const name = $('folder-name-input').value.trim();
  if (!name) return;
  try {
    const res = await post('/api/mkdir', { path: state.path, name });
    if (res.ok) { hide('folder-modal'); showToast('Carpeta creada'); refresh(); }
    else showToast(await errorOf(res, 'No se pudo crear'));
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Bloc de notas
--------------------------------------------------------------- */
const NT = {
  items: [],
  abierta: null,              // id de la nota en edición
  abiertas: new Set(JSON.parse(localStorage.getItem('fc-notas-abiertas') || '[]')),
  filtro: '',
  guardando: null,
  sucia: false,
  arrastrada: null,
};

function guardarAbiertas() {
  localStorage.setItem('fc-notas-abiertas', JSON.stringify([...NT.abiertas]));
}

async function loadNotes(mantener) {
  try {
    const res = await api('/api/notes');
    const data = await res.json();
    NT.items = data.items || [];
    renderNotes();
    if (!mantener && NT.abierta && !NT.items.some(i => i.id === NT.abierta)) cerrarNota();
  } catch { showToast('No se pudieron cargar las notas'); }
}

function hijosDe(parent) {
  return NT.items
    .filter(i => i.parent === parent)
    .sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title, 'es') : a.type === 'folder' ? -1 : 1));
}

// Con filtro activo se muestran las coincidencias y sus carpetas padre, para no perder el contexto
function coincide(item) {
  if (!NT.filtro) return true;
  if (item.title.toLowerCase().includes(NT.filtro)) return true;
  return hijosDe(item.id).some(coincide);
}

function renderNotes() {
  const caja = $('notes-tree');
  caja.textContent = '';
  const raiz = hijosDe('').filter(coincide);
  if (!raiz.length) {
    caja.appendChild(el('div', 'notes-vacio',
      NT.filtro ? 'Ningún título coincide' : 'Sin notas todavía. Crea la primera con el botón +'));
    return;
  }
  const pinta = (lista, nivel) => {
    for (const item of lista) {
      caja.appendChild(filaNota(item, nivel));
      const abierta = NT.abiertas.has(item.id) || (NT.filtro && item.type === 'folder');
      if (item.type === 'folder' && abierta) pinta(hijosDe(item.id).filter(coincide), nivel + 1);
    }
  };
  pinta(raiz, 0);
}

function filaNota(item, nivel) {
  const row = el('div', 'nrow' + (item.type === 'note' ? ' nota' : ''));
  row.style.paddingLeft = 8 + nivel * 14 + 'px';
  if (item.id === NT.abierta) row.classList.add('sel');
  if (NT.abiertas.has(item.id)) row.classList.add('abierta');

  const caret = icon('i-caret', 'caret');
  if (item.type !== 'folder') caret.classList.add('hueco');
  caret.addEventListener('click', e => {
    e.stopPropagation();
    if (item.type !== 'folder') return;
    NT.abiertas.has(item.id) ? NT.abiertas.delete(item.id) : NT.abiertas.add(item.id);
    guardarAbiertas();
    renderNotes();
  });
  row.appendChild(caret);
  row.appendChild(icon(item.type === 'folder' ? 'i-folder' : 'i-note', 'ic'));
  row.appendChild(el('span', 'tx', item.title));

  const mas = el('button', 'mas');
  mas.appendChild(icon('i-dots'));
  mas.setAttribute('aria-label', 'Opciones');
  mas.addEventListener('click', e => { e.stopPropagation(); menuNota(e.clientX, e.clientY, item); });
  row.appendChild(mas);

  row.addEventListener('click', () => {
    if (item.type === 'folder') {
      NT.abiertas.has(item.id) ? NT.abiertas.delete(item.id) : NT.abiertas.add(item.id);
      guardarAbiertas();
      renderNotes();
    } else abrirNota(item.id);
  });
  row.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); menuNota(e.clientX, e.clientY, item); });

  // Arrastrar dentro del árbol para reorganizar
  row.draggable = true;
  row.addEventListener('dragstart', e => { NT.arrastrada = item; e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend', () => {
    NT.arrastrada = null;
    document.querySelectorAll('.drop-note').forEach(n => n.classList.remove('drop-note'));
  });
  if (item.type === 'folder') {
    row.addEventListener('dragover', e => {
      if (!NT.arrastrada || NT.arrastrada.id === item.id) return;
      e.preventDefault();
      row.classList.add('drop-note');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-note'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drop-note');
      if (NT.arrastrada) moverNota(NT.arrastrada, item.id);
    });
  }
  return row;
}

function menuNota(x, y, item) {
  const menu = $('ctxmenu');
  menu.textContent = '';
  menu.appendChild(el('div', 'cab', item.title));
  if (item.type === 'folder') {
    opcionCtx(menu, 'i-plus', 'Nueva nota aquí', () => crearNota('note', item.id));
    opcionCtx(menu, 'i-folder-plus', 'Nueva subcarpeta', () => crearNota('folder', item.id));
  }
  opcionCtx(menu, 'i-pencil', 'Renombrar', () => renombrarNota(item));
  if (item.parent) opcionCtx(menu, 'i-up', 'Sacar a la raíz', () => moverNota(item, ''));
  menu.appendChild(el('div', 'sep'));
  opcionCtx(menu, 'i-trash', item.type === 'folder' ? 'Eliminar carpeta y su contenido' : 'Eliminar nota',
    () => borrarNota(item), true);

  menu.style.left = '-9999px';
  menu.style.top = '0';
  show('ctxmenu');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

async function crearNota(type, parent) {
  try {
    const res = await post('/api/notes', { type, parent: parent || '', title: type === 'folder' ? 'Nueva carpeta' : 'Nota sin título' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo crear'); return; }
    if (parent) { NT.abiertas.add(parent); guardarAbiertas(); }
    await loadNotes(true);
    if (type === 'note') { abrirNota(data.item.id); $('note-title').focus(); $('note-title').select(); }
  } catch { showToast('Error de conexión'); }
}

async function renombrarNota(item) {
  const titulo = prompt('Nuevo nombre:', item.title);
  if (titulo === null || titulo.trim() === item.title) return;
  try {
    const res = await api('/api/notes/' + qs(item.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: titulo.trim() || item.title }),
    });
    if (res.ok) { await loadNotes(true); if (item.id === NT.abierta) $('note-title').value = titulo.trim(); }
    else showToast(await errorOf(res, 'No se pudo renombrar'));
  } catch { showToast('Error de conexión'); }
}

async function moverNota(item, parent) {
  try {
    const res = await api('/api/notes/' + qs(item.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent }),
    });
    if (res.ok) { if (parent) { NT.abiertas.add(parent); guardarAbiertas(); } loadNotes(true); }
    else showToast(await errorOf(res, 'No se pudo mover'));
  } catch { showToast('Error de conexión'); }
}

async function borrarNota(item) {
  const aviso = item.type === 'folder'
    ? `¿Eliminar la carpeta "${item.title}" y todo lo que contiene? No va a la papelera.`
    : `¿Eliminar la nota "${item.title}"? No va a la papelera.`;
  if (!confirm(aviso)) return;
  try {
    const res = await api('/api/notes/' + qs(item.id), { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.borrados > 1 ? `${data.borrados} elementos eliminados` : 'Eliminado');
      if (item.id === NT.abierta) cerrarNota();
      loadNotes();
    } else showToast(data.error || 'No se pudo eliminar');
  } catch { showToast('Error de conexión'); }
}

async function abrirNota(id) {
  await guardarAhora();                       // no perder lo escrito al cambiar de nota
  try {
    const res = await api('/api/notes/' + qs(id));
    const nota = await res.json();
    if (!res.ok) { showToast(nota.error || 'No se pudo abrir'); return; }
    NT.abierta = id;
    NT.sucia = false;
    $('note-title').value = nota.title;
    $('note-body').value = nota.body || '';
    hide('editor-vacio');
    show('editor-cuerpo');
    $('notes-editor').closest('.notes').classList.add('editando');
    pintarMetaNota(nota);
    $('note-saved').textContent = '';
    renderNotes();
  } catch { showToast('Error de conexión'); }
}

function pintarMetaNota(nota) {
  const chars = ($('note-body').value || '').length;
  const palabras = ($('note-body').value.trim().match(/\S+/g) || []).length;
  $('note-meta').textContent =
    `${palabras} palabra${palabras === 1 ? '' : 's'} · ${chars} caracteres` +
    (nota && nota.updatedAt ? ` · editada el ${fmtDate(nota.updatedAt)}` : '');
}

function cerrarNota() {
  NT.abierta = null;
  NT.sucia = false;
  show('editor-vacio');
  hide('editor-cuerpo');
  $('notes-editor').closest('.notes').classList.remove('editando');
  renderNotes();
}

function marcarSucia() {
  NT.sucia = true;
  $('note-saved').textContent = 'Escribiendo…';
  $('note-saved').classList.remove('ok');
  clearTimeout(NT.guardando);
  NT.guardando = setTimeout(guardarAhora, 900);
  pintarMetaNota(NT.items.find(i => i.id === NT.abierta));
}

async function guardarAhora() {
  clearTimeout(NT.guardando);
  if (!NT.abierta || !NT.sucia) return;
  const id = NT.abierta;
  const cuerpo = { title: $('note-title').value.trim() || 'Nota sin título', body: $('note-body').value };
  NT.sucia = false;
  try {
    const res = await api('/api/notes/' + qs(id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    if (res.ok) {
      $('note-saved').textContent = 'Guardado';
      $('note-saved').classList.add('ok');
      setTimeout(() => { if (!NT.sucia) $('note-saved').textContent = ''; }, 2000);
      await loadNotes(true);
    } else {
      NT.sucia = true;
      $('note-saved').textContent = await errorOf(res, 'Error al guardar');
    }
  } catch {
    NT.sucia = true;
    $('note-saved').textContent = 'Sin conexión';
  }
}

/* ---------------------------------------------------------------
   Descargar como ZIP
--------------------------------------------------------------- */
function descargarZip(rutas) {
  if (!rutas.length) return;
  if (rutas.length > 200) { showToast('Máximo 200 elementos por ZIP'); return; }
  const url = '/api/zip?' + rutas.map(r => 'p=' + qs(r)).join('&');
  const a = el('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast(rutas.length === 1 ? 'Preparando el ZIP…' : `Preparando un ZIP con ${rutas.length} elementos…`);
}

/* ---------------------------------------------------------------
   Enlaces de descarga
--------------------------------------------------------------- */
function openShare(item) {
  state.compartiendo = item;
  $('share-sub').textContent = item.isDir
    ? `La carpeta "${item.name}" se descargará como ZIP`
    : `${item.name} · ${fmtSize(item.size)}`;
  $('share-label').value = item.name;
  $('share-pass').value = '';
  $('share-days').value = '30';
  show('share-form');
  hide('share-result');
  show('btn-create-share');
  show('share-modal');
}

async function crearCompartir() {
  const item = state.compartiendo;
  if (!item) return;
  try {
    const res = await post('/api/sharelinks', {
      path: item.rel,
      label: $('share-label').value.trim() || item.name,
      days: Number($('share-days').value),
      password: $('share-pass').value || undefined,
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo crear'); return; }
    const url = `${location.origin}/s/${data.link.id}`;
    $('share-url').textContent = url;
    hide('share-form');
    hide('btn-create-share');
    show('share-result');
    copiarTexto(url, 'Enlace copiado al portapapeles');
    loadLinks();
  } catch { showToast('Error de conexión'); }
}

async function copiarTexto(texto, exito) {
  try { await navigator.clipboard.writeText(texto); showToast(exito); return; }
  catch { /* sin permiso: se intenta a la vieja usanza */ }
  try {
    const ta = el('textarea');
    ta.value = texto;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    showToast(ok ? exito : 'Copia el enlace a mano');
  } catch { showToast('Copia el enlace a mano'); }
}

/* ---------------------------------------------------------------
   Papelera de notas
--------------------------------------------------------------- */
async function refrescarContadorPapeleraNotas() {
  try {
    const res = await api('/api/notes-trash');
    const data = await res.json();
    NT.papelera = data.items || [];
    $('notes-trash-n').textContent = NT.papelera.length
      ? `Papelera (${NT.papelera.length})` : 'Papelera';
  } catch {}
}

async function abrirPapeleraNotas() {
  show('notes-trash-modal');
  const caja = $('notes-trash-list');
  caja.textContent = '';
  caja.appendChild(el('div', 'none', 'Cargando…'));
  try {
    const res = await api('/api/notes-trash');
    const data = await res.json();
    NT.papelera = data.items || [];
    $('notes-trash-sub').textContent = `Se borran solas pasados ${data.ttlDays} días`;
    caja.textContent = '';
    // Solo se muestra el elemento raíz de cada borrado: sus hijos vuelven con él
    const grupos = NT.papelera.filter(t => t.id === t.grupo);
    if (!grupos.length) {
      caja.appendChild(el('div', 'none', 'No hay nada en la papelera'));
      $('btn-empty-notes-trash').disabled = true;
      return;
    }
    $('btn-empty-notes-trash').disabled = false;
    for (const t of grupos) {
      const hijos = NT.papelera.filter(x => x.grupo === t.grupo).length - 1;
      const row = el('div', 'trash-nota');
      row.appendChild(icon(t.type === 'folder' ? 'i-folder' : 'i-note'));
      const info = el('div', 'info');
      info.appendChild(el('div', 'nm', t.title));
      info.appendChild(el('div', 'mt',
        (t.type === 'folder' ? `Carpeta${hijos ? ` · ${hijos} dentro` : ''}` : 'Nota') +
        ` · ${fmtDate(t.deletedAt)}`));
      row.appendChild(info);

      const rest = el('button', 'icon-btn');
      rest.appendChild(icon('i-restore'));
      rest.title = 'Restaurar';
      rest.addEventListener('click', () => restaurarNota(t));
      row.appendChild(rest);

      const del = el('button', 'icon-btn');
      del.appendChild(icon('i-x'));
      del.title = 'Eliminar definitivamente';
      del.addEventListener('click', () => purgarNota(t));
      row.appendChild(del);

      caja.appendChild(row);
    }
  } catch {
    caja.textContent = '';
    caja.appendChild(el('div', 'none', 'No se pudo cargar'));
  }
}

async function restaurarNota(t) {
  try {
    const res = await post('/api/notes-trash/restore', { id: t.id });
    const data = await res.json();
    if (res.ok) {
      showToast(data.restaurados > 1 ? `${data.restaurados} elementos restaurados` : 'Restaurado');
      await loadNotes(true);
      abrirPapeleraNotas();
      refrescarContadorPapeleraNotas();
    } else showToast(data.error || 'No se pudo restaurar');
  } catch { showToast('Error de conexión'); }
}

async function purgarNota(t) {
  if (!confirm(`¿Eliminar "${t.title}" definitivamente? Esto no se puede deshacer.`)) return;
  try {
    const res = await api('/api/notes-trash/' + qs(t.id), { method: 'DELETE' });
    if (res.ok) { showToast('Eliminado definitivamente'); abrirPapeleraNotas(); refrescarContadorPapeleraNotas(); }
    else showToast(await errorOf(res, 'No se pudo eliminar'));
  } catch { showToast('Error de conexión'); }
}

async function vaciarPapeleraNotas() {
  if (!confirm('¿Vaciar la papelera de notas? Esto no se puede deshacer.')) return;
  try {
    const res = await api('/api/notes-trash', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) { showToast(`${data.removed} elemento(s) eliminados`); abrirPapeleraNotas(); refrescarContadorPapeleraNotas(); }
    else showToast(data.error || 'No se pudo vaciar');
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Reparto del espacio por tipo
   Barra de composición apilada. La paleta es la de referencia del sistema
   de gráficos, validada para fondo oscuro (separación CVD 8.4, visión
   normal 19.3). El color va atado a la categoría, nunca a su tamaño.
--------------------------------------------------------------- */
const TIPOS = [
  { id: 'image', nombre: 'Imágenes',   color: '#3987e5' },
  { id: 'video', nombre: 'Vídeos',     color: '#d95926' },
  { id: 'audio', nombre: 'Audio',      color: '#199e70' },
  { id: 'doc',   nombre: 'Documentos', color: '#c98500' },
  { id: 'other', nombre: 'Otros',      color: '#d55181' },
];

function renderByType(byType, total) {
  const caja = $('bytype');
  if (!byType || !total) { caja.hidden = true; return; }
  const datos = TIPOS.map(t => ({ ...t, ...(byType[t.id] || { bytes: 0, count: 0 }) }))
                     .filter(t => t.bytes > 0);
  if (!datos.length) { caja.hidden = true; return; }

  const barra = $('bt-bar');
  const leyenda = $('bt-legend');
  barra.textContent = '';
  leyenda.textContent = '';

  for (const t of datos) {
    const pct = (t.bytes / total) * 100;
    const seg = el('div', 'bt-seg');
    seg.style.background = t.color;
    seg.style.flex = `${t.bytes} 0 0`;
    seg.tabIndex = 0;
    const texto = `${t.nombre}: ${fmtSize(t.bytes)} · ${pct.toFixed(1)}% · ${t.count} archivo${t.count === 1 ? '' : 's'}`;
    seg.setAttribute('aria-label', texto);
    seg.addEventListener('mouseenter', e => mostrarTip(e, t, pct));
    seg.addEventListener('mousemove', moverTip);
    seg.addEventListener('mouseleave', ocultarTip);
    barra.appendChild(seg);

    // La leyenda hace de tabla: cada categoría con su valor exacto, sin depender del color
    const item = el('div', 'bt-item');
    const dot = el('span', 'bt-dot');
    dot.style.background = t.color;
    item.appendChild(dot);
    item.appendChild(el('span', 'lbl', t.nombre));
    item.appendChild(el('span', 'val', fmtSize(t.bytes)));
    item.appendChild(el('span', 'pc', pct.toFixed(0) + '%'));
    leyenda.appendChild(item);
  }
  caja.hidden = false;
}

let tipEl = null;
function mostrarTip(ev, t, pct) {
  ocultarTip();
  tipEl = el('div', 'bt-tip');
  tipEl.appendChild(el('b', null, t.nombre));
  tipEl.appendChild(document.createTextNode(' '));
  tipEl.appendChild(el('span', null,
    `${fmtSize(t.bytes)} · ${pct.toFixed(1)}% · ${t.count} archivo${t.count === 1 ? '' : 's'}`));
  document.body.appendChild(tipEl);
  moverTip(ev);
}
function moverTip(ev) {
  if (!tipEl) return;
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = Math.min(ev.clientX + 14, window.innerWidth - r.width - 10) + 'px';
  tipEl.style.top = Math.max(10, ev.clientY - r.height - 12) + 'px';
}
function ocultarTip() {
  if (tipEl) { tipEl.remove(); tipEl = null; }
}

/* ---------------------------------------------------------------
   Enlaces de subida
--------------------------------------------------------------- */
async function loadLinks() {
  try {
    const res = await api('/api/uploadlinks');
    const links = await res.json();
    const box = $('links-list');
    box.textContent = '';
    if (!links.length) {
      box.appendChild(el('p', 'card-sub', 'Todavía no has creado ninguno.'));
      return;
    }
    for (const l of links) {
      const row = el('div', 'lrow' + (l.expired ? ' caducado' : ''));
      const info = el('div', 'info');
      info.appendChild(el('div', 'nm', l.label));
      const caduca = l.expiresAt
        ? (l.expired ? 'caducado' : 'caduca el ' + fmtDate(l.expiresAt))
        : 'sin caducidad';
      info.appendChild(el('div', 'meta',
        `→ ${l.path || 'Inicio'} · ${l.files} archivo${l.files === 1 ? '' : 's'} recibidos · ${caduca}`));
      info.appendChild(el('div', 'url', urlDelEnlace(l.id)));
      row.appendChild(info);

      const copiar = el('button', 'icon-btn');
      copiar.appendChild(icon('i-copy'));
      copiar.title = 'Copiar enlace';
      copiar.setAttribute('aria-label', 'Copiar enlace');
      copiar.addEventListener('click', () => copiarEnlace(l.id));
      row.appendChild(copiar);

      const borrar = el('button', 'icon-btn');
      borrar.appendChild(icon('i-trash'));
      borrar.title = 'Revocar';
      borrar.setAttribute('aria-label', 'Revocar enlace');
      borrar.addEventListener('click', () => revocarEnlace(l));
      row.appendChild(borrar);

      box.appendChild(row);
    }
  } catch {}
}

const urlDelEnlace = (id) => `${location.origin}/u/${id}`;

async function copiarEnlace(id) {
  copiarTexto(urlDelEnlace(id), 'Enlace copiado al portapapeles');
}

async function crearEnlace() {
  const label = $('link-label').value.trim();
  const days = Number($('link-days').value);
  try {
    const res = await post('/api/uploadlinks', { path: state.linkPath || '', label, days });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo crear'); return; }
    $('link-label').value = '';
    await loadLinks();
    copiarEnlace(data.link.id);
  } catch { showToast('Error de conexión'); }
}

async function revocarEnlace(l) {
  if (!confirm(`¿Revocar el enlace "${l.label}"? Quien lo tenga dejará de poder subir.`)) return;
  try {
    const res = await api('/api/uploadlinks/' + qs(l.id), { method: 'DELETE' });
    if (res.ok) { showToast('Enlace revocado'); loadLinks(); }
    else showToast(await errorOf(res, 'No se pudo revocar'));
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Administración
--------------------------------------------------------------- */
async function loadAdmin() {
  try {
    const res = await api('/api/stats');
    const s = await res.json();
    $('stat-size').textContent = fmtSize(s.totalBytes);
    $('stat-count').textContent = s.fileCount;
    if (s.diskTotal) {
      $('stat-free').textContent = fmtSize(s.diskFree);
      const used = s.diskTotal - s.diskFree;
      $('usage-fill').style.width = Math.min(100, (used / s.diskTotal) * 100).toFixed(1) + '%';
      $('usage-left').textContent = `${fmtSize(used)} usados de ${fmtSize(s.diskTotal)}`;
      $('usage-right').textContent = `${Math.round((used / s.diskTotal) * 100)}%`;
      show('usage-wrap');
    } else {
      $('stat-free').textContent = 'n/d';
      hide('usage-wrap');
    }
    renderByType(s.byType, s.totalBytes);
  } catch {}

  loadLinks();

  try {
    const res = await api('/api/users');
    const users = await res.json();
    const box = $('user-list');
    box.textContent = '';
    for (const u of users) {
      const row = el('div', 'urow');
      row.appendChild(el('div', 'av', u.username.charAt(0).toUpperCase()));
      row.appendChild(el('div', 'un', u.username));
      row.appendChild(el('span', 'pill' + (u.role === 'admin' ? ' admin' : ''), u.role));
      if (u.username !== 'admin') {
        const del = el('button', 'icon-btn');
        del.appendChild(icon('i-trash'));
        del.setAttribute('aria-label', 'Eliminar usuario');
        del.addEventListener('click', () => deleteUser(u.username));
        row.appendChild(del);
      }
      box.appendChild(row);
    }
  } catch {}
}

async function addUser() {
  const username = $('new-username').value.trim();
  const password = $('new-userpass').value;
  const role = $('new-userrole').value;
  if (!username || !password) { showToast('Faltan datos'); return; }
  try {
    const res = await post('/api/users', { username, password, role });
    if (res.ok) {
      showToast('Usuario creado');
      $('new-username').value = '';
      $('new-userpass').value = '';
      loadAdmin();
    } else showToast(await errorOf(res, 'No se pudo crear'));
  } catch { showToast('Error de conexión'); }
}

async function deleteUser(username) {
  if (!confirm(`¿Eliminar el usuario "${username}"? Sus archivos no se borran.`)) return;
  try {
    const res = await api('/api/users/' + qs(username), { method: 'DELETE' });
    if (res.ok) { showToast('Usuario eliminado'); loadAdmin(); }
    else showToast(await errorOf(res, 'No se pudo eliminar'));
  } catch { showToast('Error de conexión'); }
}

async function changeMyPassword() {
  const password = $('my-newpass').value;
  if (!password || password.length < 6) { showToast('Mínimo 6 caracteres'); return; }
  try {
    const res = await post('/api/users/' + qs(state.user.username) + '/password', { password });
    if (res.ok) { showToast('Contraseña actualizada'); $('my-newpass').value = ''; }
    else showToast(await errorOf(res, 'No se pudo cambiar'));
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Favoritos
--------------------------------------------------------------- */
let favSet = new Set();
async function cargarFavoritosSet() {
  try {
    const res = await api('/api/favorites');
    const data = await res.json();
    favSet = new Set(data.items || []);
  } catch { /* se deja el set como estaba */ }
}
async function toggleFavorite(rel) {
  const esFav = favSet.has(rel);
  try {
    const res = esFav
      ? await api('/api/favorites?path=' + qs(rel), { method: 'DELETE' })
      : await post('/api/favorites', { path: rel });
    if (!res.ok) { showToast(await errorOf(res, 'No se pudo actualizar')); return; }
    esFav ? favSet.delete(rel) : favSet.add(rel);
    showToast(esFav ? 'Quitado de favoritos' : 'Añadido a favoritos');
    if (state.tab === 'colecciones' && COL.modo === 'favoritos') cargarFavoritos();
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Colecciones: favoritos y álbumes
--------------------------------------------------------------- */
const COL = { modo: 'favoritos', albumAbierto: null };

function loadColecciones() {
  pintarColSubnav();
  if (COL.modo === 'favoritos') cargarFavoritos();
  else cargarAlbumes();
}
function pintarColSubnav() {
  document.querySelectorAll('#col-subnav .chip').forEach(c => c.classList.toggle('is-active', c.dataset.col === COL.modo));
  $('col-favoritos').hidden = COL.modo !== 'favoritos';
  $('col-albumes').hidden = COL.modo !== 'albumes';
}

function tileGenerico(item, onQuitar, tituloQuitar, iconoQuitar) {
  const tile = el('div', 'tile');
  const box = el('div', 'thumb-box');
  if (!item.isDir && hasThumb(item.name)) {
    tile.classList.add('photo');
    const img = el('img');
    img.src = '/api/thumb?path=' + qs(item.rel);
    img.loading = 'lazy';
    img.alt = item.name;
    img.addEventListener('error', () => {
      img.remove();
      tile.classList.remove('photo');
      const c = el('div', 'center');
      c.appendChild(fileBadge(item.name, false));
      box.appendChild(c);
    });
    box.appendChild(img);
  } else {
    const c = el('div', 'center');
    c.appendChild(fileBadge(item.name, item.isDir));
    box.appendChild(c);
  }
  if (onQuitar) {
    const quitar = el('button', 'dots');
    quitar.appendChild(icon(iconoQuitar || 'i-x'));
    quitar.title = tituloQuitar || 'Quitar';
    quitar.setAttribute('aria-label', tituloQuitar || 'Quitar');
    quitar.addEventListener('click', e => { e.stopPropagation(); onQuitar(); });
    box.appendChild(quitar);
  }
  tile.appendChild(box);
  const cap = el('div', 'cap');
  cap.appendChild(el('span', 'name', item.name));
  cap.appendChild(el('span', 'sz', item.isDir ? '' : fmtSize(item.size)));
  tile.appendChild(cap);
  tile.addEventListener('click', () => {
    if (item.isDir) { switchTab('files'); goTo(item.rel); return; }
    if (isViewable(item.name)) openLightbox(state.viewables.indexOf(item));
  });
  return tile;
}

async function cargarFavoritos() {
  const box = $('fav-list');
  box.className = 'grid';
  box.textContent = '';
  box.appendChild(el('div', 'skel', ''));
  try {
    const res = await api('/api/favorites');
    const data = await res.json();
    favSet = new Set(data.items || []);
    if (!data.items.length) {
      box.className = '';
      box.textContent = '';
      box.appendChild(emptyState('Sin favoritos todavía', 'Márcalos desde el menú de opciones de cada archivo', 'i-star'));
      return;
    }
    const items = (await Promise.all(data.items.map(async rel => {
      try {
        const partes = rel.split('/');
        const name = partes.pop();
        const dir = partes.join('/');
        const r = await api('/api/files?path=' + qs(dir));
        const d = await r.json();
        const it = (d.items || []).find(i => i.name === name);
        return it ? { ...it, rel } : null;
      } catch { return null; }
    }))).filter(Boolean);
    state.viewables = items.filter(i => !i.isDir && isViewable(i.name));
    box.textContent = '';
    items.forEach((item, i) => {
      const tile = tileGenerico(item, () => toggleFavorite(item.rel), 'Quitar de favoritos', 'i-star-fill');
      tile.style.animationDelay = Math.min(i * 20, 300) + 'ms';
      box.appendChild(tile);
    });
  } catch {
    box.textContent = '';
    box.className = '';
    box.appendChild(emptyState('No se pudieron cargar los favoritos'));
  }
}

async function cargarAlbumes() {
  $('albums-toolbar').hidden = false;
  $('albums-grid').hidden = false;
  $('album-detalle').hidden = true;
  const grid = $('albums-grid');
  grid.className = 'grid';
  grid.textContent = '';
  grid.appendChild(el('div', 'skel', ''));
  try {
    const res = await api('/api/albums');
    const data = await res.json();
    grid.textContent = '';
    if (!data.items.length) {
      grid.className = '';
      grid.appendChild(emptyState('Sin álbumes todavía', 'Crea uno y añade fotos desde su menú de opciones', 'i-stack'));
      return;
    }
    for (const a of data.items) grid.appendChild(buildAlbumTile(a));
  } catch {
    grid.textContent = '';
    grid.className = '';
    grid.appendChild(emptyState('No se pudieron cargar los álbumes'));
  }
}

function buildAlbumTile(album) {
  const tile = el('div', 'album-tile');
  const cover = el('div', 'cover');
  cover.appendChild(icon('i-stack'));
  tile.appendChild(cover);
  const cap = el('div', 'cap');
  cap.appendChild(el('div', 'name', album.title));
  cap.appendChild(el('div', 'n', `${album.count} elemento${album.count === 1 ? '' : 's'}`));
  tile.appendChild(cap);
  tile.addEventListener('click', () => abrirAlbum(album.id));
  return tile;
}

async function abrirAlbum(id) {
  COL.albumAbierto = id;
  $('albums-toolbar').hidden = true;
  $('albums-grid').hidden = true;
  $('album-detalle').hidden = false;
  const box = $('album-items');
  box.className = 'grid';
  box.textContent = '';
  box.appendChild(el('div', 'skel', ''));
  try {
    const res = await api('/api/albums/' + id);
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo abrir'); volverAAlbumes(); return; }
    $('album-titulo').textContent = data.title;
    state.viewables = data.items.filter(i => !i.isDir && isViewable(i.name));
    box.textContent = '';
    if (!data.items.length) {
      box.className = '';
      box.appendChild(emptyState('Álbum vacío', 'Añade fotos desde su menú de opciones'));
      return;
    }
    data.items.forEach(item => {
      box.appendChild(tileGenerico(item, async () => {
        try {
          const r = await api(`/api/albums/${id}/items?path=` + qs(item.rel), { method: 'DELETE' });
          if (r.ok) abrirAlbum(id);
        } catch { showToast('Error de conexión'); }
      }, 'Quitar del álbum', 'i-x'));
    });
  } catch {
    box.textContent = '';
    box.className = '';
    box.appendChild(emptyState('No se pudo abrir el álbum'));
  }
}
function volverAAlbumes() {
  COL.albumAbierto = null;
  cargarAlbumes();
}
async function eliminarAlbumActual() {
  if (!COL.albumAbierto) return;
  if (!confirm('¿Eliminar este álbum? Las fotos no se borran, solo la colección.')) return;
  try {
    const res = await api('/api/albums/' + COL.albumAbierto, { method: 'DELETE' });
    if (res.ok) { showToast('Álbum eliminado'); volverAAlbumes(); }
    else showToast(await errorOf(res, 'No se pudo eliminar'));
  } catch { showToast('Error de conexión'); }
}
async function crearAlbumSolo() {
  const nombre = prompt('Nombre del nuevo álbum:', 'Álbum sin título');
  if (nombre === null) return;
  try {
    const res = await post('/api/albums', { title: nombre.trim() || 'Álbum sin título' });
    if (res.ok) { showToast('Álbum creado'); cargarAlbumes(); }
    else showToast(await errorOf(res, 'No se pudo crear'));
  } catch { showToast('Error de conexión'); }
}

/* --- Añadir elementos a un álbum, desde cualquier menú de opciones --- */
let albumPickRutas = [];
async function openAlbumPicker(rels) {
  if (!rels.length) return;
  albumPickRutas = rels;
  $('album-pick-sub').textContent = rels.length === 1
    ? `"${rels[0].split('/').pop()}"` : `${rels.length} elementos`;
  $('album-pick-new').value = '';
  const list = $('album-pick-list');
  list.textContent = '';
  list.appendChild(el('div', 'none', 'Cargando…'));
  show('album-pick-modal');
  try {
    const res = await api('/api/albums');
    const data = await res.json();
    list.textContent = '';
    if (!data.items.length) { list.appendChild(el('div', 'none', 'No tienes álbumes todavía. Crea uno abajo.')); return; }
    for (const a of data.items) {
      const btn = el('button');
      btn.appendChild(icon('i-stack'));
      btn.appendChild(el('span', null, `${a.title} (${a.count})`));
      btn.addEventListener('click', () => añadirAAlbum(a.id));
      list.appendChild(btn);
    }
  } catch {
    list.textContent = '';
    list.appendChild(el('div', 'none', 'No se pudieron cargar'));
  }
}
async function añadirAAlbum(id) {
  try {
    const res = await post(`/api/albums/${id}/items`, { paths: albumPickRutas });
    if (res.ok) { showToast('Añadido al álbum'); hide('album-pick-modal'); }
    else showToast(await errorOf(res, 'No se pudo añadir'));
  } catch { showToast('Error de conexión'); }
}
async function crearAlbumYAñadir() {
  const nombre = $('album-pick-new').value.trim();
  if (!nombre) { showToast('Escribe un nombre'); return; }
  try {
    const res = await post('/api/albums', { title: nombre, paths: albumPickRutas });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo crear'); return; }
    showToast('Álbum creado y elementos añadidos');
    hide('album-pick-modal');
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Renombrado en lote
--------------------------------------------------------------- */
let renameRutas = [];
function openRenameModal(rels) {
  if (!rels.length) return;
  renameRutas = rels;
  $('rename-sub').textContent = `Se renombrarán ${rels.length} elemento${rels.length === 1 ? '' : 's'}`;
  $('rename-pattern').value = '{name}';
  $('rename-start').value = '1';
  show('rename-modal');
}
async function confirmRename() {
  const pattern = $('rename-pattern').value.trim();
  if (!pattern) { showToast('Escribe un patrón'); return; }
  try {
    const res = await post('/api/batch', {
      op: 'rename', paths: renameRutas, pattern, start: Number($('rename-start').value) || 1,
    });
    const data = await res.json();
    hide('rename-modal');
    reportBatch(data, 'elemento renombrado', 'elementos renombrados');
    exitSelectMode();
    refresh();
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Analizador de espacio por carpeta (Administración)
--------------------------------------------------------------- */
let duPath = '';
async function loadDiskUsage(rel) {
  duPath = rel || '';
  $('du-path').textContent = duPath || 'Inicio';
  $('du-up').hidden = !duPath;
  const box = $('du-list');
  box.textContent = '';
  box.appendChild(el('div', 'skel', ''));
  try {
    const res = await api('/api/diskusage?path=' + qs(duPath));
    let data;
    try { data = await res.json(); }
    // Un 502/504 del propio nginx (por ejemplo, si la carpeta tarda demasiado) no
    // llega como JSON: sin esto se perdía el estado real detrás de un mensaje genérico.
    catch { throw new Error(`El servidor respondió con un error (${res.status})`); }
    box.textContent = '';
    if (!res.ok) { box.appendChild(el('p', 'card-sub', data.error || `No se pudo analizar (${res.status})`)); return; }
    if (!data.items.length) { box.appendChild(el('p', 'card-sub', 'Carpeta vacía')); return; }
    const max = Math.max(...data.items.map(i => i.size), 1);
    for (const it of data.items) {
      const row = el('div', 'du-row');
      if (it.isDir) {
        const btn = el('button');
        btn.appendChild(icon('i-folder'));
        btn.appendChild(el('span', 'nm', it.name));
        btn.addEventListener('click', () => loadDiskUsage(joinPath(duPath, it.name)));
        row.appendChild(btn);
      } else {
        row.appendChild(el('span', 'nm', it.name));
      }
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      fill.style.width = Math.max(2, (it.size / max) * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'sz', fmtSize(it.size)));
      box.appendChild(row);
    }
    if (data.cortado) {
      box.appendChild(el('p', 'card-sub',
        'Hay tantos archivos que el análisis se ha cortado: algunos tamaños pueden salir por debajo del real.'));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('p', 'card-sub', err.message || 'No se pudo analizar'));
  }
}

/* ---------------------------------------------------------------
   Buscador de duplicados (Administración)
--------------------------------------------------------------- */
async function scanDuplicates() {
  const resumen = $('dup-resumen');
  const list = $('dup-list');
  resumen.textContent = 'Buscando… puede tardar si hay muchos archivos.';
  list.textContent = '';
  $('btn-scan-dup').disabled = true;
  try {
    const res = await api('/api/duplicates');
    const data = await res.json();
    if (!res.ok) { resumen.textContent = data.error || 'No se pudo escanear'; return; }
    if (!data.grupos.length) {
      resumen.textContent = `Sin duplicados en ${data.escaneados} archivos analizados.`;
      return;
    }
    resumen.textContent = `${data.grupos.length} grupo${data.grupos.length === 1 ? '' : 's'} de duplicados · ` +
      `${fmtSize(data.espacioRecuperable)} recuperables` + (data.cortado ? ' · análisis parcial (tope de archivos alcanzado)' : '');
    data.grupos.forEach(grupo => list.appendChild(buildDupGroup(grupo)));
  } catch {
    resumen.textContent = 'Error de conexión';
  } finally {
    $('btn-scan-dup').disabled = false;
  }
}

function buildDupGroup(grupo) {
  const ordenado = [...grupo].sort((a, b) => new Date(a.modified) - new Date(b.modified));
  const wrap = el('div', 'dup-grupo');
  const cab = el('div', 'dup-grupo-cab');
  cab.appendChild(el('span', null, `${grupo.length} copias · ${fmtSize(ordenado[0].size)} cada una`));
  const btnBorrar = el('button', 'btn', 'Enviar marcados a la papelera');
  cab.appendChild(btnBorrar);
  wrap.appendChild(cab);

  const checks = [];
  ordenado.forEach((f, i) => {
    const row = el('div', 'dup-item');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = i > 0;                 // se preselecciona todo menos el más antiguo, que se conserva
    checks.push({ chk, rel: f.rel });
    row.appendChild(chk);
    row.appendChild(el('span', 'nm', f.rel));
    row.appendChild(el('span', 'sz', fmtDate(f.modified)));
    if (i === 0) row.appendChild(el('span', 'orig', 'se conserva'));
    wrap.appendChild(row);
  });

  btnBorrar.addEventListener('click', async () => {
    const marcados = checks.filter(c => c.chk.checked).map(c => c.rel);
    if (!marcados.length) { showToast('No has marcado ninguna copia'); return; }
    if (!confirm(`¿Enviar ${marcados.length} archivo(s) a la papelera?`)) return;
    try {
      const res = await post('/api/batch', { op: 'delete', paths: marcados });
      const data = await res.json();
      reportBatch(data, 'copia eliminada', 'copias eliminadas');
      wrap.remove();
    } catch { showToast('Error de conexión'); }
  });
  return wrap;
}

/* ---------------------------------------------------------------
   Actividad reciente (propia en Cuenta, de todos en Administración)
--------------------------------------------------------------- */
function fmtCuando(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return fmtDate(t);
}
const ICONO_ACCION = {
  login: 'i-power', archivo_subido: 'i-upload', enviado_papelera: 'i-trash',
  enviado_papelera_lote: 'i-trash', movido_lote: 'i-move', renombrado: 'i-pencil',
  renombrado_lote: 'i-pencil', carpeta_creada: 'i-folder-plus', restaurado_papelera: 'i-restore',
  usuario_creado: 'i-users', usuario_eliminado: 'i-users', password_cambiada: 'i-key',
  enlace_compartido_creado: 'i-share', archivo_editado: 'i-pencil', descarga_convertida: 'i-download',
  '2fa_activado': 'i-shield', '2fa_desactivado': 'i-shield', apptoken_creado: 'i-key',
  apptoken_revocado: 'i-key', sesion_cerrada_remoto: 'i-monitor', sesiones_cerradas_todas: 'i-monitor',
};
const TEXTO_ACCION = {
  login: 'Inició sesión', archivo_subido: 'Subió archivos', enviado_papelera: 'Envió a la papelera',
  enviado_papelera_lote: 'Envió varios elementos a la papelera', movido_lote: 'Movió varios elementos',
  renombrado: 'Renombró un elemento', renombrado_lote: 'Renombró varios elementos',
  carpeta_creada: 'Creó una carpeta', restaurado_papelera: 'Restauró de la papelera',
  usuario_creado: 'Creó un usuario', usuario_eliminado: 'Eliminó un usuario',
  password_cambiada: 'Cambió una contraseña', enlace_compartido_creado: 'Creó un enlace compartido',
  archivo_editado: 'Editó un archivo de texto', descarga_convertida: 'Descargó un archivo convertido',
  '2fa_activado': 'Activó la verificación en dos pasos', '2fa_desactivado': 'Desactivó la verificación en dos pasos',
  apptoken_creado: 'Creó un token de aplicación', apptoken_revocado: 'Revocó un token de aplicación',
  sesion_cerrada_remoto: 'Cerró una sesión en remoto', sesiones_cerradas_todas: 'Cerró todas sus otras sesiones',
};
async function cargarActividad(containerId, global) {
  const box = $(containerId);
  box.textContent = '';
  box.appendChild(el('div', 'none', 'Cargando…'));
  try {
    const res = await api('/api/activity?limit=' + (global ? 200 : 40));
    const data = await res.json();
    box.textContent = '';
    if (!data.items.length) { box.appendChild(el('p', 'card-sub', 'Sin actividad todavía')); return; }
    for (const e of data.items) {
      const row = el('div', 'act-row');
      const em = el('div', 'em');
      em.appendChild(icon(ICONO_ACCION[e.accion] || 'i-info'));
      row.appendChild(em);
      const tx = el('div', 'tx');
      const linea = el('div');
      if (global) {
        linea.appendChild(el('b', null, e.user || '?'));
        linea.appendChild(document.createTextNode(' — '));
      }
      linea.appendChild(document.createTextNode(TEXTO_ACCION[e.accion] || e.accion));
      tx.appendChild(linea);
      row.appendChild(tx);
      row.appendChild(el('span', 'when', fmtCuando(e.t)));
      box.appendChild(row);
    }
  } catch {
    box.textContent = '';
    box.appendChild(el('p', 'card-sub', 'No se pudo cargar'));
  }
}

/* ---------------------------------------------------------------
   Sesiones abiertas y tokens de aplicación (Cuenta)
--------------------------------------------------------------- */
function navegadorDe(ua) {
  if (!ua) return 'Dispositivo desconocido';
  if (/edg\//i.test(ua)) return 'Edge';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/chrome/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) return 'Safari';
  return ua.slice(0, 40);
}
async function cargarSesiones() {
  const box = $('sessions-list');
  box.textContent = '';
  box.appendChild(el('div', 'none', 'Cargando…'));
  try {
    const res = await api('/api/sessions');
    const data = await res.json();
    box.textContent = '';
    if (!data.length) { box.appendChild(el('p', 'card-sub', 'Sin sesiones registradas')); return; }
    for (const s of data) {
      const row = el('div', 'sess-row' + (s.current ? ' actual' : ''));
      const info = el('div', 'info');
      info.appendChild(el('div', 'nm', navegadorDe(s.ua)));
      info.appendChild(el('div', 'mt', `${s.ip} · última actividad ${fmtCuando(s.lastSeenAt)}`));
      row.appendChild(info);
      if (!s.current) {
        const del = el('button', 'icon-btn');
        del.appendChild(icon('i-x'));
        del.title = 'Cerrar esta sesión';
        del.setAttribute('aria-label', 'Cerrar esta sesión');
        del.addEventListener('click', async () => {
          const r = await api('/api/sessions/' + s.jti, { method: 'DELETE' });
          if (r.ok) { showToast('Sesión cerrada'); cargarSesiones(); }
        });
        row.appendChild(del);
      }
      box.appendChild(row);
    }
  } catch {
    box.textContent = '';
    box.appendChild(el('p', 'card-sub', 'No se pudieron cargar'));
  }
}
async function cerrarOtrasSesiones() {
  if (!confirm('¿Cerrar todas las demás sesiones? Esta se mantiene.')) return;
  try {
    const res = await api('/api/sessions', { method: 'DELETE' });
    const data = await res.json();
    showToast(`${data.removed} sesión(es) cerradas`);
    cargarSesiones();
  } catch { showToast('Error de conexión'); }
}

async function cargarAppTokens() {
  const box = $('apptokens-list');
  box.textContent = '';
  box.appendChild(el('div', 'none', 'Cargando…'));
  try {
    const res = await api('/api/apptokens');
    const tokens = await res.json();
    box.textContent = '';
    if (!tokens.length) { box.appendChild(el('p', 'card-sub', 'Sin tokens creados')); return; }
    for (const t of tokens) {
      const row = el('div', 'token-row');
      const info = el('div', 'info');
      info.appendChild(el('div', 'nm', t.name));
      info.appendChild(el('div', 'mt',
        `Creado ${fmtDate(t.createdAt)}` + (t.lastUsedAt ? ` · usado ${fmtCuando(t.lastUsedAt)}` : ' · sin usar todavía')));
      row.appendChild(info);
      const del = el('button', 'icon-btn');
      del.appendChild(icon('i-trash'));
      del.title = 'Revocar';
      del.setAttribute('aria-label', 'Revocar token');
      del.addEventListener('click', async () => {
        if (!confirm(`¿Revocar el token "${t.name}"?`)) return;
        const r = await api('/api/apptokens/' + t.id, { method: 'DELETE' });
        if (r.ok) { showToast('Token revocado'); cargarAppTokens(); }
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  } catch {
    box.textContent = '';
    box.appendChild(el('p', 'card-sub', 'No se pudieron cargar'));
  }
}
async function crearAppToken() {
  const name = $('apptoken-name').value.trim();
  if (!name) { showToast('Escribe para qué es'); return; }
  try {
    const res = await post('/api/apptokens', { name });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo crear'); return; }
    $('apptoken-name').value = '';
    await cargarAppTokens();
    try { await navigator.clipboard.writeText(data.token); } catch { /* sin permiso de portapapeles */ }
    alert(`Token creado (copiado al portapapeles si tu navegador lo permite):\n\n${data.token}\n\nGuárdalo ahora: no se volverá a mostrar.`);
  } catch { showToast('Error de conexión'); }
}

/* ---------------------------------------------------------------
   Verificación en dos pasos (Cuenta)
--------------------------------------------------------------- */
async function cargarEstado2fa() {
  hide('twofa-off'); hide('twofa-setup'); hide('twofa-on');
  $('twofa-sub').textContent = 'Comprobando…';
  try {
    const res = await api('/api/2fa/status');
    const data = await res.json();
    if (data.enabled) {
      $('twofa-sub').textContent = 'Tu cuenta está protegida con verificación en dos pasos.';
      show('twofa-on');
    } else {
      $('twofa-sub').textContent = 'Añade un código de un solo uso al iniciar sesión, además de la contraseña.';
      show('twofa-off');
    }
  } catch { $('twofa-sub').textContent = 'No se pudo comprobar el estado'; }
}
async function iniciar2faSetup() {
  try {
    const res = await post('/api/2fa/setup', {});
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo iniciar'); return; }
    $('twofa-secret').textContent = data.secret;
    $('twofa-code').value = '';
    hide('twofa-off');
    show('twofa-setup');
  } catch { showToast('Error de conexión'); }
}
async function confirmar2fa() {
  const code = $('twofa-code').value.trim();
  if (!code) { showToast('Escribe el código'); return; }
  try {
    const res = await post('/api/2fa/confirm', { code });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Código incorrecto'); return; }
    showToast('Verificación en dos pasos activada');
    cargarEstado2fa();
  } catch { showToast('Error de conexión'); }
}
async function desactivar2fa() {
  const password = $('twofa-disable-pass').value;
  if (!password) { showToast('Escribe tu contraseña'); return; }
  try {
    const res = await post('/api/2fa/disable', { password });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo desactivar'); return; }
    $('twofa-disable-pass').value = '';
    showToast('Verificación en dos pasos desactivada');
    cargarEstado2fa();
  } catch { showToast('Error de conexión'); }
}

function loadCuenta() {
  cargarSesiones();
  cargarAppTokens();
  cargarEstado2fa();
  pintarEstadoPin();
  cargarActividad('activity-list', false);
}

/* ---------------------------------------------------------------
   Bloqueo con PIN
   Protege solo este dispositivo de un vistazo ajeno; la contraseña real
   sigue siendo la de la cuenta. El hash del PIN vive en localStorage,
   nunca llega al servidor.
--------------------------------------------------------------- */
const PIN_IDLE_MS = 10 * 60 * 1000;
let pinIdleTimer = null;
let pinIntento = '';

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kcc-pin:' + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const pinActivo = () => localStorage.getItem('fc-pin-on') === '1';

function pintarEstadoPin() {
  $('pin-off').hidden = pinActivo();
  $('pin-on').hidden = !pinActivo();
}
async function activarPin() {
  const pin = $('pin-nuevo').value.trim();
  if (!/^\d{4,8}$/.test(pin)) { showToast('El PIN debe tener entre 4 y 8 dígitos'); return; }
  localStorage.setItem('fc-pin-hash', await hashPin(pin));
  localStorage.setItem('fc-pin-on', '1');
  $('pin-nuevo').value = '';
  pintarEstadoPin();
  showToast('Bloqueo con PIN activado en este dispositivo');
  reiniciarPinIdle();
}
function desactivarPin() {
  localStorage.removeItem('fc-pin-hash');
  localStorage.removeItem('fc-pin-on');
  pintarEstadoPin();
  showToast('Bloqueo con PIN desactivado');
  clearTimeout(pinIdleTimer);
}
function pintarPinDots() {
  const puntos = $('pindots').children;
  for (let i = 0; i < puntos.length; i++) puntos[i].classList.toggle('filled', i < pinIntento.length);
}
function bloquearApp() {
  if (!pinActivo() || $('app').hidden) return;
  pinIntento = '';
  pintarPinDots();
  $('pin-error').textContent = 'Introduce tu PIN';
  $('pin-error').classList.remove('err');
  show('pinlock');
}
async function tocarPinTecla(k) {
  if (k === 'borrar') { pinIntento = pinIntento.slice(0, -1); pintarPinDots(); return; }
  if (k === 'salir') { hide('pinlock'); logout(); return; }
  if (pinIntento.length >= 8) return;
  pinIntento += k;
  pintarPinDots();
  if (pinIntento.length < 4) return;
  const hash = await hashPin(pinIntento);
  if (hash === localStorage.getItem('fc-pin-hash')) {
    hide('pinlock');
    pinIntento = '';
    reiniciarPinIdle();
  } else if (pinIntento.length >= 8) {
    $('pin-error').textContent = 'PIN incorrecto, prueba de nuevo';
    $('pin-error').classList.add('err');
    pinIntento = '';
    setTimeout(pintarPinDots, 250);
  }
}
function reiniciarPinIdle() {
  clearTimeout(pinIdleTimer);
  if (!pinActivo()) return;
  pinIdleTimer = setTimeout(bloquearApp, PIN_IDLE_MS);
}
['click', 'keydown', 'touchstart', 'mousemove'].forEach(ev =>
  document.addEventListener(ev, () => { if ($('pinlock').hidden) reiniciarPinIdle(); }, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(pinIdleTimer); bloquearApp(); }
  else reiniciarPinIdle();
});

/* ---------------------------------------------------------------
   Eventos
--------------------------------------------------------------- */
$('login-form').addEventListener('submit', doLogin);
$('btn-logout').addEventListener('click', logout);

// El logotipo vuelve a Inicio: sale de la búsqueda y de cualquier subcarpeta
$('btn-home').addEventListener('click', () => {
  switchTab('files');
  goTo('');
});

document.querySelectorAll('.tab, .mobilenav button').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.view));
});

$('btn-grid').addEventListener('click', () => setView('grid'));
$('btn-list').addEventListener('click', () => setView('list'));
$('btn-refresh').addEventListener('click', refresh);
$('btn-upload').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => handleUpload(e.target.files));

$('btn-newfolder').addEventListener('click', () => {
  $('folder-name-input').value = '';
  show('folder-modal');
  $('folder-name-input').focus();
});
$('btn-createfolder').addEventListener('click', createFolder);
$('folder-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') createFolder(); });

$('search-input').addEventListener('input', onSearchInput);
$('search-clear').addEventListener('click', () => { clearSearchInput(); refresh(); });
$('sort-select').addEventListener('change', e => {
  state.sort = e.target.value;
  localStorage.setItem('fc-sort', state.sort);
  render();
});
$('type-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.type;
  document.querySelectorAll('#type-chips .chip').forEach(c => c.classList.toggle('is-active', c === chip));
  render();
});

$('btn-select').addEventListener('click', () => {
  state.selectMode ? exitSelectMode() : enterSelectMode();
});
$('sel-cancel').addEventListener('click', exitSelectMode);
$('sel-all').addEventListener('click', () => {
  const items = visibleItems();
  const allPicked = items.every(i => state.selection.has(i.rel));
  state.selection.clear();
  if (!allPicked) items.forEach(i => state.selection.add(i.rel));
  updateSelbar();
  render();
});
$('sel-delete').addEventListener('click', bulkDelete);
$('sel-download').addEventListener('click', bulkDownload);
$('sel-move').addEventListener('click', () => openMove(selectedItems().map(i => i.rel)));
$('btn-move-here').addEventListener('click', confirmMove);

$('action-open').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) openLightbox(state.viewables.indexOf(item));
});
$('action-download').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) downloadRel(item.rel);
});
$('action-share').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) openShare(item);
});
$('action-zip').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) descargarZip([item.rel]);
});
$('btn-create-share').addEventListener('click', crearCompartir);
$('btn-copy-share').addEventListener('click', () => copiarTexto($('share-url').textContent, 'Enlace copiado'));
$('sel-zip').addEventListener('click', () => descargarZip(selectedItems().map(i => i.rel)));
$('btn-notes-trash').addEventListener('click', abrirPapeleraNotas);
$('btn-empty-notes-trash').addEventListener('click', vaciarPapeleraNotas);

$('action-move').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) openMove([item.rel]);
});
$('action-rename').addEventListener('click', renameSelected);
$('action-delete').addEventListener('click', deleteSelected);

$('btn-map-refresh').addEventListener('click', () => { MP.cargado = false; pedirFotosMapa(); });
$('btn-empty-trash').addEventListener('click', emptyTrash);
$('btn-adduser').addEventListener('click', addUser);
$('btn-changepass').addEventListener('click', changeMyPassword);

// Colecciones: favoritos y álbumes
$('col-subnav').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  COL.modo = chip.dataset.col;
  pintarColSubnav();
  loadColecciones();
});
$('btn-nuevo-album').addEventListener('click', crearAlbumSolo);
$('btn-album-volver').addEventListener('click', volverAAlbumes);
$('btn-album-eliminar').addEventListener('click', eliminarAlbumActual);
$('btn-album-pick-new').addEventListener('click', crearAlbumYAñadir);
$('sel-rename').addEventListener('click', () => openRenameModal(selectedItems().map(i => i.rel)));
$('sel-album').addEventListener('click', () => openAlbumPicker(selectedItems().filter(i => !i.isDir).map(i => i.rel)));
$('btn-rename-here').addEventListener('click', confirmRename);

// Acciones nuevas del modal de un solo archivo
$('action-fav').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) toggleFavorite(item.rel);
});
$('action-album').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) openAlbumPicker([item.rel]);
});
$('action-download-jpg').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) downloadConvertido(item.rel, 'jpg');
});
$('action-download-pdf').addEventListener('click', () => {
  const item = state.selected;
  hide('action-modal');
  if (item) downloadConvertido(item.rel, 'pdf');
});

// Administración: espacio por carpeta y duplicados
$('btn-du-up').addEventListener('click', () => loadDiskUsage(parentOf(duPath)));
$('btn-scan-dup').addEventListener('click', scanDuplicates);

// Cuenta: verificación en dos pasos
$('btn-2fa-activar').addEventListener('click', iniciar2faSetup);
$('btn-2fa-confirmar').addEventListener('click', confirmar2fa);
$('btn-2fa-desactivar').addEventListener('click', desactivar2fa);
$('btn-2fa-copiar').addEventListener('click', () => copiarTexto($('twofa-secret').textContent, 'Clave copiada'));

// Cuenta: tokens de aplicación y sesiones
$('btn-apptoken-crear').addEventListener('click', crearAppToken);
$('btn-sessions-others').addEventListener('click', cerrarOtrasSesiones);

// Cuenta: bloqueo con PIN
$('btn-pin-activar').addEventListener('click', activarPin);
$('btn-pin-desactivar').addEventListener('click', desactivarPin);
$('pinpad').addEventListener('click', e => {
  const btn = e.target.closest('button[data-k]');
  if (btn) tocarPinTecla(btn.dataset.k);
});
document.addEventListener('keydown', e => {
  if ($('pinlock').hidden) return;
  if (/^[0-9]$/.test(e.key)) tocarPinTecla(e.key);
  else if (e.key === 'Backspace') tocarPinTecla('borrar');
});

// Cola de subida
$('upbar-cancel').addEventListener('click', cancelarCola);
$('upbar-retry').addEventListener('click', reintentarFallidos);
$('upbar-close').addEventListener('click', cerrarCola);
$('upbar-toggle').addEventListener('click', () => $('upbar').classList.toggle('plegada'));

// Enlaces de subida
$('link-folder').addEventListener('click', openFolderForLink);
$('btn-createlink').addEventListener('click', crearEnlace);

// WebDAV
$('btn-copy-dav').addEventListener('click', async () => {
  const url = $('dav-url').textContent;
  try { await navigator.clipboard.writeText(url); showToast('Dirección copiada'); }
  catch { showToast('Copia la dirección de la tarjeta'); }
});

// Notas
$('btn-new-note').addEventListener('click', () => crearNota('note', ''));
$('btn-new-folder-note').addEventListener('click', () => crearNota('folder', ''));
$('btn-note-delete').addEventListener('click', () => {
  const item = NT.items.find(i => i.id === NT.abierta);
  if (item) borrarNota(item);
});
$('btn-notes-back').addEventListener('click', () => { guardarAhora(); cerrarNota(); });
$('note-title').addEventListener('input', marcarSucia);
$('note-body').addEventListener('input', marcarSucia);
$('note-body').addEventListener('blur', guardarAhora);
$('note-title').addEventListener('blur', guardarAhora);
$('notes-filter').addEventListener('input', e => {
  NT.filtro = e.target.value.trim().toLowerCase();
  renderNotes();
});
// Cerrar la pestaña con algo sin guardar: se intenta un último envío
window.addEventListener('beforeunload', () => {
  if (!NT.sucia || !NT.abierta) return;
  const datos = JSON.stringify({ title: $('note-title').value, body: $('note-body').value });
  navigator.sendBeacon?.('/api/notes/' + qs(NT.abierta) + '?beacon=1', new Blob([datos], { type: 'application/json' }));
});

// Menú contextual: clic derecho en el hueco vacío del listado
$('file-list').addEventListener('contextmenu', e => {
  if (state.tab !== 'files') return;
  e.preventDefault();
  abrirCtx(e.clientX, e.clientY, null);
});
document.addEventListener('click', e => {
  if (!$('ctxmenu').hidden && !$('ctxmenu').contains(e.target)) cerrarCtx();
});
window.addEventListener('scroll', cerrarCtx, true);
window.addEventListener('resize', cerrarCtx);
window.addEventListener('blur', ocultarTip);

// El alto real del nav inferior (tipografía del sistema, zoom, notch...) varía entre
// dispositivos y entre navegador móvil y PWA instalada: medirlo con offsetHeight en vez
// de fijarlo a ojo evita que el mapa y las notas queden por detrás en algunos casos.
function medirAlturaNav() {
  const nav = $('mobilenav');
  if (nav && nav.offsetHeight) {
    document.documentElement.style.setProperty('--mobilenav-h', nav.offsetHeight + 'px');
  }
  if (MP.mapa) setTimeout(() => MP.mapa.invalidateSize(), 60);
}
window.addEventListener('resize', medirAlturaNav);
window.addEventListener('orientationchange', medirAlturaNav);

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => hide(btn.dataset.close));
});
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) ov.hidden = true; });
});

$('lb-info').addEventListener('click', alternarExif);
$('btn-agrupar').addEventListener('click', () => {
  state.agrupar = !state.agrupar;
  localStorage.setItem('fc-agrupar', state.agrupar ? '1' : '0');
  aplicarBotonAgrupar();
  render();
  if (state.agrupar) cargarMetaFotos();
});
$('lb-close').addEventListener('click', closeLightbox);
$('lb-prev').addEventListener('click', e => { e.stopPropagation(); pararSlideshow(); lbStep(-1); });
$('lb-next').addEventListener('click', e => { e.stopPropagation(); pararSlideshow(); lbStep(1); });
$('lb-download').addEventListener('click', () => {
  const item = state.viewables[state.lbIndex];
  if (item) downloadRel(item.rel);
});
$('lb-fav').addEventListener('click', () => {
  const item = state.viewables[state.lbIndex];
  if (item) toggleFavorite(item.rel).then(() => pintarLbFav(item));
});
$('lb-play').addEventListener('click', alternarSlideshow);
$('lb-edit').addEventListener('click', alternarEdicion);
$('lb-open').addEventListener('click', () => {
  const item = state.viewables[state.lbIndex];
  if (!item) return;
  const url = isOffice(item.name)
    ? '/api/office?path=' + qs(item.rel)
    : '/api/preview?path=' + qs(item.rel);
  window.open(url, '_blank', 'noopener');
});
$('lb-stage').addEventListener('click', e => { if (e.target === $('lb-stage')) closeLightbox(); });

document.addEventListener('keydown', e => {
  if (!$('lightbox').hidden) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') { pararSlideshow(); lbStep(-1); }
    else if (e.key === 'ArrowRight') { pararSlideshow(); lbStep(1); }
    return;
  }
  if (e.key === 'Escape') {
    if (!$('ctxmenu').hidden) { cerrarCtx(); return; }
    if (state.selectMode) { exitSelectMode(); return; }
    document.querySelectorAll('.overlay').forEach(ov => { ov.hidden = true; });
  }
});

let touchX = 0;
$('lb-stage').addEventListener('touchstart', e => { touchX = e.changedTouches[0].clientX; }, { passive: true });
$('lb-stage').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) lbStep(dx < 0 ? 1 : -1);
}, { passive: true });

let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (!state.user || state.tab !== 'files') return;
  if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
  dragDepth++;
  show('dropzone');
});
window.addEventListener('dragover', e => { if (!$('dropzone').hidden) e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hide('dropzone');
});
window.addEventListener('drop', e => {
  if ($('dropzone').hidden) return;
  e.preventDefault();
  dragDepth = 0;
  hide('dropzone');
  handleUpload(e.dataTransfer.files);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Antes de pintar nada, para que no se vea un cambio de color al entrar
applyTint(localStorage.getItem('fc-tint') || TINTS[0].id, false);
checkSession();
