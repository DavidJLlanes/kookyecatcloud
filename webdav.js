/**
 * WebDAV para KookyeCatCloud.
 *
 * Implementa el subconjunto que necesitan el Explorador de Windows, Finder y los
 * clientes de sincronización de móvil: OPTIONS, PROPFIND, GET/HEAD, PUT, DELETE,
 * MKCOL, MOVE, COPY y LOCK/UNLOCK. Los bloqueos son simbólicos —se conceden y se
 * recuerdan, pero no impiden nada—: sin anunciarlos, Windows monta la unidad en
 * solo lectura.
 *
 * Cada usuario ve su propia raíz, la misma que en la web: el admin todo el almacén
 * y el resto su carpeta. Los nombres que empiezan por punto (.trash, .notes) no se
 * listan ni se pueden alcanzar.
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MAX_DEPTH = 1;                       // Depth: infinity se responde como 1
const CACHE_CREDENCIALES_MS = 5 * 60 * 1000;

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Cada segmento se codifica por separado: las barras deben seguir siendo barras
const encodeHref = (rel) => '/dav/' + String(rel).split('/').filter(Boolean).map(encodeURIComponent).join('/');

function decodeHref(href) {
  let p = href;
  try { p = decodeURIComponent(href); } catch { /* se usa tal cual */ }
  try { p = new URL(p, 'http://x').pathname; } catch { /* ya era una ruta */ }
  // Se normaliza venga montado como venga (app.use recorta el prefijo, app.all no)
  return p.replace(/^\/dav\/?/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function createDav({ resolveFor, userRoot, loadUsers, isHidden, log }) {
  async function exists(p) {
    try { await fsp.access(p); return true; } catch { return false; }
  }

  const credenciales = new Map();   // clave Basic -> { user, expira }
  const bloqueos = new Map();       // ruta -> { token, expira }

  setInterval(() => {
    const ahora = Date.now();
    for (const [k, v] of credenciales) if (ahora > v.expira) credenciales.delete(k);
    for (const [k, v] of bloqueos) if (ahora > v.expira) bloqueos.delete(k);
  }, 60000).unref();

  function reto(res) {
    res.setHeader('WWW-Authenticate', 'Basic realm="KookyeCatCloud", charset="UTF-8"');
    res.status(401).end('No autenticado');
  }

  function autenticar(req, res) {
    const cab = req.headers.authorization || '';
    if (!cab.startsWith('Basic ')) { reto(res); return null; }

    const clave = cab.slice(6);
    const guardado = credenciales.get(clave);
    if (guardado && Date.now() < guardado.expira) return guardado.user;

    let usuario, clavePlano;
    try {
      const txt = Buffer.from(clave, 'base64').toString('utf8');
      const corte = txt.indexOf(':');
      usuario = txt.slice(0, corte);
      clavePlano = txt.slice(corte + 1);
    } catch { reto(res); return null; }

    const u = loadUsers().find(x => x.username === usuario);
    // bcrypt cuesta ~100 ms, de ahí la caché: un montaje hace decenas de peticiones seguidas.
    // Vale tanto la contraseña de la cuenta como cualquiera de sus tokens de aplicación,
    // para poder montar la unidad sin escribir la contraseña real en el cliente.
    const valido = !!u && (
      bcrypt.compareSync(clavePlano || '', u.passwordHash) ||
      (u.apptokens || []).some(t => bcrypt.compareSync(clavePlano || '', t.hash))
    );
    if (!valido) { reto(res); return null; }

    const user = { username: u.username, role: u.role };
    credenciales.set(clave, { user, expira: Date.now() + CACHE_CREDENCIALES_MS });
    return user;
  }

  function rutaDe(req, user) {
    const rel = decodeHref(req.path);
    if (rel.split('/').filter(Boolean).some(isHidden)) {
      const e = new Error('Ruta reservada');
      e.status = 403;
      throw e;
    }
    return { rel, abs: resolveFor(user, rel) };
  }

  async function propfindXml(user, rel, abs, depth) {
    const entradas = [];
    const stat = await fsp.stat(abs);
    entradas.push({ rel, stat });

    if (stat.isDirectory() && depth > 0) {
      const hijos = await fsp.readdir(abs, { withFileTypes: true });
      for (const h of hijos) {
        if (isHidden(h.name)) continue;
        try {
          const st = await fsp.stat(path.join(abs, h.name));
          entradas.push({ rel: rel ? `${rel}/${h.name}` : h.name, stat: st });
        } catch { /* desaparecido a mitad del listado */ }
      }
    }

    const cuerpo = entradas.map(({ rel: r, stat: st }) => {
      const nombre = r ? r.split('/').pop() : 'KookyeCatCloud';
      const esDir = st.isDirectory();
      const href = encodeHref(r) + (esDir && r ? '/' : '');
      return `<D:response>
  <D:href>${escapeXml(href)}</D:href>
  <D:propstat>
    <D:prop>
      <D:displayname>${escapeXml(nombre)}</D:displayname>
      <D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified>
      <D:creationdate>${new Date(st.birthtimeMs || st.mtimeMs).toISOString()}</D:creationdate>
      <D:resourcetype>${esDir ? '<D:collection/>' : ''}</D:resourcetype>
      ${esDir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength>`}
      <D:supportedlock>
        <D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>
      </D:supportedlock>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${cuerpo}\n</D:multistatus>`;
  }

  return async function dav(req, res) {
    const user = autenticar(req, res);
    if (!user) return;

    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');

    let rel, abs;
    try { ({ rel, abs } = rutaDe(req, user)); }
    catch (e) { return res.status(e.status || 400).end(e.message); }

    const metodo = req.method.toUpperCase();
    try {
      switch (metodo) {
        case 'OPTIONS':
          res.setHeader('Allow', 'OPTIONS, HEAD, GET, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
          return res.status(200).end();

        case 'PROPFIND': {
          if (!await exists(abs)) return res.status(404).end();
          const cab = req.headers.depth === undefined ? 'infinity' : String(req.headers.depth);
          const depth = cab === '0' ? 0 : MAX_DEPTH;
          const xml = await propfindXml(user, rel, abs, depth);
          res.status(207).set('Content-Type', 'application/xml; charset=utf-8').end(xml);
          return;
        }

        case 'PROPPATCH':
          // No se guardan propiedades personalizadas, pero hay que contestar bien
          // o Windows aborta la copia tras escribir el archivo.
          res.status(207).set('Content-Type', 'application/xml; charset=utf-8').end(
            `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"><D:response>` +
            `<D:href>${escapeXml(encodeHref(rel))}</D:href>` +
            `<D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
          return;

        case 'HEAD':
        case 'GET': {
          if (!await exists(abs)) return res.status(404).end();
          const st = await fsp.stat(abs);
          if (st.isDirectory()) return res.status(405).end('Es una carpeta');
          if (metodo === 'HEAD') {
            res.setHeader('Content-Length', st.size);
            res.setHeader('Last-Modified', st.mtime.toUTCString());
            return res.status(200).end();
          }
          return res.sendFile(abs);            // sendFile ya responde a rangos
        }

        case 'PUT': {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          const nuevo = !await exists(abs);
          await new Promise((resolve, reject) => {
            const salida = fs.createWriteStream(abs);
            req.pipe(salida);
            salida.on('finish', resolve);
            salida.on('error', reject);
            req.on('error', reject);
          });
          return res.status(nuevo ? 201 : 204).end();
        }

        case 'MKCOL': {
          if (await exists(abs)) return res.status(405).end('Ya existe');
          try { await fsp.mkdir(abs); }
          catch { return res.status(409).end('Falta la carpeta padre'); }
          return res.status(201).end();
        }

        case 'DELETE': {
          if (!await exists(abs)) return res.status(404).end();
          if (abs === userRoot(user)) return res.status(403).end('No puedes borrar la raíz');
          await fsp.rm(abs, { recursive: true, force: true });
          return res.status(204).end();
        }

        case 'MOVE':
        case 'COPY': {
          const destinoCab = req.headers.destination;
          if (!destinoCab) return res.status(400).end('Falta Destination');
          const relDestino = decodeHref(destinoCab);
          if (relDestino.split('/').filter(Boolean).some(isHidden)) return res.status(403).end('Destino reservado');
          const absDestino = resolveFor(user, relDestino);
          const sobrescribir = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
          const existia = await exists(absDestino);
          if (existia && !sobrescribir) return res.status(412).end('El destino ya existe');
          if (metodo === 'MOVE' && absDestino.startsWith(abs + path.sep)) {
            return res.status(409).end('No puedes mover una carpeta dentro de sí misma');
          }
          await fsp.mkdir(path.dirname(absDestino), { recursive: true });
          if (existia) await fsp.rm(absDestino, { recursive: true, force: true });
          if (metodo === 'MOVE') await fsp.rename(abs, absDestino);
          else await fsp.cp(abs, absDestino, { recursive: true });
          return res.status(existia ? 204 : 201).end();
        }

        case 'LOCK': {
          const token = `opaquelocktoken:${crypto.randomBytes(16).toString('hex')}`;
          bloqueos.set(rel, { token, expira: Date.now() + 3600000 });
          res.setHeader('Lock-Token', `<${token}>`);
          res.status(200).set('Content-Type', 'application/xml; charset=utf-8').end(
            `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
            `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
            `<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>` +
            `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
            `</D:activelock></D:lockdiscovery></D:prop>`);
          return;
        }

        case 'UNLOCK':
          bloqueos.delete(rel);
          return res.status(204).end();

        default:
          return res.status(405).end('Método no soportado');
      }
    } catch (err) {
      if (log) log('WebDAV', metodo, rel, err.message);
      const codigo = err.status || (err.code === 'ENOENT' ? 404 : 500);
      return res.status(codigo).end(err.message);
    }
  };

}

module.exports = { createDav };
