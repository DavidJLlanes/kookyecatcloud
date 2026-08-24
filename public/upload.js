'use strict';

// Página pública de un enlace de subida: /u/<id>
const $ = (id) => document.getElementById(id);
const linkId = location.pathname.split('/').filter(Boolean).pop() || '';
let cola = [];
let info = null;

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  const n = bytes / Math.pow(1024, i);
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
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

async function cargar() {
  try {
    const res = await fetch('/api/public/link/' + encodeURIComponent(linkId));
    const data = await res.json();
    $('cargando').hidden = true;
    if (!res.ok) {
      $('subtitulo').textContent = 'Enlace no disponible';
      aviso(data.error || 'Este enlace no es válido', 'err');
      return;
    }
    info = data;
    $('titulo').textContent = data.label;
    const quedan = Math.max(0, data.maxFiles - data.files);
    const caduca = data.expiresAt
      ? 'Caduca el ' + new Date(data.expiresAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })
      : 'Sin fecha de caducidad';
    $('subtitulo').textContent = `${caduca} · quedan ${quedan} archivo${quedan === 1 ? '' : 's'}`;
    $('zona').hidden = false;
  } catch {
    $('cargando').hidden = true;
    aviso('No se pudo conectar con el servidor', 'err');
  }
}

function pintarLista() {
  const lista = $('lista');
  lista.textContent = '';
  cola.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'f';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;                 // textContent: el nombre nunca se interpreta como HTML
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = fmtSize(f.size);
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Quitar');
    x.addEventListener('click', () => { cola.splice(i, 1); pintarLista(); });
    row.append(nm, sz, x);
    lista.appendChild(row);
  });
  $('enviar').disabled = !cola.length;
  $('enviar').textContent = cola.length
    ? `Enviar ${cola.length} archivo${cola.length > 1 ? 's' : ''} (${fmtSize(cola.reduce((n, f) => n + f.size, 0))})`
    : 'Enviar';
}

function anadir(files) {
  const libres = info ? info.maxFiles - info.files - cola.length : 0;
  const nuevos = Array.from(files);
  if (nuevos.length > libres) {
    aviso(`Este enlace solo admite ${libres} archivo(s) más`, 'err');
    nuevos.length = Math.max(0, libres);
  } else {
    aviso('');
  }
  cola = cola.concat(nuevos);
  pintarLista();
}

function enviar() {
  if (!cola.length) return;
  const form = new FormData();
  for (const f of cola) form.append('files', f);

  $('enviar').disabled = true;
  $('barra').hidden = false;
  aviso('');

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/public/link/' + encodeURIComponent(linkId) + '/upload');
  xhr.upload.addEventListener('progress', e => {
    if (e.lengthComputable) $('progreso').style.width = Math.round((e.loaded / e.total) * 100) + '%';
  });
  xhr.addEventListener('load', () => {
    $('barra').hidden = true;
    $('progreso').style.width = '0%';
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 200) {
      const n = cola.length;
      cola = [];
      pintarLista();
      $('zona').hidden = true;
      aviso(`¡Listo! Se ${n === 1 ? 'ha enviado 1 archivo' : 'han enviado ' + n + ' archivos'}. Gracias.`, 'ok');
    } else {
      $('enviar').disabled = false;
      aviso(data.error || 'No se pudo completar el envío', 'err');
    }
  });
  xhr.addEventListener('error', () => {
    $('barra').hidden = true;
    $('enviar').disabled = false;
    aviso('Error de red durante el envío', 'err');
  });
  xhr.send(form);
}

$('drop').addEventListener('click', () => $('input').click());
$('input').addEventListener('change', e => { anadir(e.target.files); e.target.value = ''; });
$('enviar').addEventListener('click', enviar);

['dragenter', 'dragover'].forEach(ev => $('drop').addEventListener(ev, e => {
  e.preventDefault();
  $('drop').classList.add('over');
}));
['dragleave', 'drop'].forEach(ev => $('drop').addEventListener(ev, e => {
  e.preventDefault();
  $('drop').classList.remove('over');
}));
$('drop').addEventListener('drop', e => { if (e.dataTransfer) anadir(e.dataTransfer.files); });

cargar();
