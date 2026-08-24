'use strict';

// Página pública de un enlace de descarga: /s/<id>
const $ = (id) => document.getElementById(id);
const linkId = location.pathname.split('/').filter(Boolean).pop() || '';
const qs = (s) => encodeURIComponent(s);
let info = null;
let clavePw = '';

function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  const n = bytes / Math.pow(1024, i);
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}
function aviso(texto, tipo) {
  const box = $('aviso');
  box.textContent = '';
  if (!texto) return;
  const d = document.createElement('div');
  d.className = 'msg ' + tipo;
  d.textContent = texto;
  box.appendChild(d);
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function svg(pathD, extra) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(pathD)) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  if (extra) extra(s);
  return s;
}
const iconoCarpeta = () => svg('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
const iconoArchivo = () => svg(['M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v4h4']);

const isImg = (n) => /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(n);
const isVid = (n) => /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(n);

/* ---------------------------------------------------------------
   Tarjeta inicial: metadatos del enlace
--------------------------------------------------------------- */
async function cargar() {
  try {
    const res = await fetch('/api/public/share/' + qs(linkId));
    const data = await res.json();
    $('cargando').hidden = true;
    if (!res.ok) { aviso(data.error || 'Este enlace no es válido', 'err'); return; }
    info = data;

    const tipo = $('tipo');
    tipo.textContent = '';
    if (data.isDir) tipo.appendChild(iconoCarpeta());
    else {
      const ext = (data.label.split('.').pop() || '').toLowerCase();
      tipo.textContent = ext && ext.length <= 4 && ext !== data.label.toLowerCase() ? ext : '·';
    }

    $('titulo').textContent = data.label;
    const partes = [];
    if (data.isDir) partes.push('Carpeta compartida');
    else if (data.size) partes.push(fmtSize(data.size));
    if (data.expiresAt) {
      partes.push('caduca el ' + new Date(data.expiresAt).toLocaleDateString('es-ES',
        { day: '2-digit', month: 'long', year: 'numeric' }));
    }
    if (data.downloads) partes.push(`${data.downloads} descarga${data.downloads === 1 ? '' : 's'}`);
    $('meta').textContent = partes.join(' · ');

    if (data.protegido) $('clave').hidden = false;
    $('btn-texto').textContent = data.isDir ? 'Descargar todo (ZIP)' : 'Descargar';
    $('ver-galeria').hidden = !data.isDir;
    $('zona').hidden = false;
  } catch {
    $('cargando').hidden = true;
    aviso('No se pudo conectar con el servidor', 'err');
  }
}

async function descargar() {
  clavePw = $('clave').value;
  const url = '/api/public/share/' + qs(linkId) + '/download' +
    (info.protegido ? '?pw=' + qs(clavePw) : '');

  if (info.protegido) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) {
        aviso(res.status === 401 ? 'Contraseña incorrecta' : 'No se pudo descargar', 'err');
        return;
      }
    } catch {
      aviso('Error de conexión', 'err');
      return;
    }
  }
  aviso('Descarga iniciada. Si no empieza sola, vuelve a pulsar.', 'ok');
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------------------------------------------------------
   Galería: navegar la carpeta compartida y ver sus fotos/vídeos
--------------------------------------------------------------- */
let galSub = '';
let galItems = [];
let galViewables = [];
let galLbIndex = -1;

function galUrl(accion, extra) {
  const p = new URLSearchParams();
  if (galSub) p.set('sub', galSub);
  if (info.protegido) p.set('pw', clavePw);
  if (extra) for (const k in extra) p.set(k, extra[k]);
  return `/api/public/share/${qs(linkId)}/${accion}?${p.toString()}`;
}

async function verGaleria() {
  clavePw = $('clave').value;
  aviso('');
  try {
    const res = await fetch(galUrl('list'));
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      aviso(res.status === 401 ? 'Contraseña incorrecta' : (d.error || 'No se pudo abrir la galería'), 'err');
      return;
    }
    $('card').hidden = true;
    $('gal-titulo').textContent = info.label;
    show('galeria');
    galSub = '';
    await cargarCarpetaGaleria();
  } catch {
    aviso('Error de conexión', 'err');
  }
}
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }

async function cargarCarpetaGaleria() {
  const grid = $('gal-grid');
  grid.textContent = '';
  grid.appendChild(el('div', null, 'Cargando…'));
  pintarCrumbs();
  try {
    const res = await fetch(galUrl('list'));
    const data = await res.json();
    grid.textContent = '';
    if (!res.ok) { grid.appendChild(el('div', 'gal-vacio', data.error || 'No se pudo cargar')); return; }
    galItems = data.items || [];
    galViewables = galItems.filter(i => !i.isDir && (isImg(i.name) || isVid(i.name)));
    if (!galItems.length) { grid.appendChild(el('div', 'gal-vacio', 'Esta carpeta está vacía')); return; }
    for (const item of galItems) grid.appendChild(buildGalTile(item));
  } catch {
    grid.textContent = '';
    grid.appendChild(el('div', 'gal-vacio', 'Error de conexión'));
  }
}

function pintarCrumbs() {
  const bar = $('gal-crumbs');
  bar.textContent = '';
  const home = el('button', null, 'Inicio');
  const parts = galSub.split('/').filter(Boolean);
  if (!parts.length) home.classList.add('current');
  else home.addEventListener('click', () => { galSub = ''; cargarCarpetaGaleria(); });
  bar.appendChild(home);
  let acc = '';
  parts.forEach((p, i) => {
    acc += (acc ? '/' : '') + p;
    const target = acc;
    bar.appendChild(el('span', 'sep', '/'));
    const btn = el('button', null, p);
    if (i === parts.length - 1) btn.classList.add('current');
    else btn.addEventListener('click', () => { galSub = target; cargarCarpetaGaleria(); });
    bar.appendChild(btn);
  });
}

function buildGalTile(item) {
  const rutaHija = galSub ? galSub + '/' + item.name : item.name;
  const tile = el('div', 'gal-tile');
  const th = el('div', 'th');
  if (item.isDir) {
    th.appendChild(iconoCarpeta());
  } else if (item.viewable) {
    const img = document.createElement('img');
    img.src = galUrl('thumb', { sub: rutaHija });
    img.loading = 'lazy';
    img.alt = item.name;
    img.addEventListener('error', () => { img.remove(); th.appendChild(iconoArchivo()); });
    th.appendChild(img);
  } else {
    th.appendChild(iconoArchivo());
  }
  tile.appendChild(th);
  tile.appendChild(el('div', 'nm', item.name));
  tile.addEventListener('click', () => {
    if (item.isDir) { galSub = rutaHija; cargarCarpetaGaleria(); return; }
    if (item.viewable) {
      const idx = galViewables.findIndex(v => v.name === item.name);
      abrirGalLightbox(idx);
    } else {
      // Otros archivos (documentos, audio…): descarga directa del archivo suelto
      const a = document.createElement('a');
      a.href = galUrl('file', { sub: rutaHija });
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  });
  return tile;
}

function abrirGalLightbox(idx) {
  if (idx < 0 || !galViewables.length) return;
  galLbIndex = idx;
  pintarGalLightbox();
  show('gal-lb');
}
function pintarGalLightbox() {
  const item = galViewables[galLbIndex];
  if (!item) return;
  const media = $('gal-lb-media');
  media.textContent = '';
  const rutaHija = galSub ? galSub + '/' + item.name : item.name;
  if (isVid(item.name)) {
    const v = document.createElement('video');
    v.src = galUrl('view', { sub: rutaHija });
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    media.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = galUrl('view', { sub: rutaHija });
    img.alt = item.name;
    media.appendChild(img);
  }
}
function galLbStep(delta) {
  if (!galViewables.length) return;
  galLbIndex = (galLbIndex + delta + galViewables.length) % galViewables.length;
  pintarGalLightbox();
}
function cerrarGalLightbox() {
  hide('gal-lb');
  $('gal-lb-media').textContent = '';
  galLbIndex = -1;
}

$('descargar').addEventListener('click', descargar);
$('clave').addEventListener('keydown', e => { if (e.key === 'Enter') descargar(); });
$('ver-galeria').addEventListener('click', verGaleria);
$('gal-volver').addEventListener('click', () => { hide('galeria'); $('card').hidden = false; });
$('gal-descargar-zip').addEventListener('click', descargar);
$('gal-lb-close').addEventListener('click', cerrarGalLightbox);
$('gal-lb-prev').addEventListener('click', () => galLbStep(-1));
$('gal-lb-next').addEventListener('click', () => galLbStep(1));
document.addEventListener('keydown', e => {
  if ($('gal-lb').hidden) return;
  if (e.key === 'Escape') cerrarGalLightbox();
  else if (e.key === 'ArrowLeft') galLbStep(-1);
  else if (e.key === 'ArrowRight') galLbStep(1);
});

cargar();
