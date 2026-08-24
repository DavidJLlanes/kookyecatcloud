/**
 * KookyeCatCloud - Servidor de archivos y backup de fotos personal, autoalojado
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
// archiver 8 ya no exporta una función: se instancia la clase del formato
const { ZipArchive } = require('archiver');
const { createDav } = require('./webdav');

// sharp es opcional: si no está instalado, las miniaturas caen a la imagen original
let sharp = null;
try { sharp = require('sharp'); } catch { /* sin miniaturas optimizadas */ }

// ffmpeg también es opcional: sin él, los vídeos salen con su distintivo en vez de fotograma
const { execFileSync, spawn } = require('child_process');
let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* sin miniaturas de vídeo */ }

// LibreOffice, para ver documentos de Office en el navegador. Si no está, esos
// archivos se pueden descargar igual, solo que sin vista previa.
let soffice = null;
for (const cmd of ['soffice', 'libreoffice']) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 15000 }); soffice = cmd; break; } catch { /* siguiente */ }
}

const APP_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || '/data/storage';
const USERS_FILE = path.join(APP_DIR, 'users.json');
const SECRET_FILE = path.join(APP_DIR, '.jwt-secret');
const PORT = process.env.PORT || 4000;
// Las cookies van con flag Secure salvo que se desactive a propósito (desarrollo en http://localhost)
const SECURE_COOKIES = process.env.INSECURE_COOKIES !== '1';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024 * 1024);
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;
const MIN_PASSWORD = 6;
// Caché de miniaturas: fuera de DATA_DIR para que no aparezca en los listados
const THUMBS_DIR = process.env.THUMBS_DIR || path.join(APP_DIR, '.thumbs');
const THUMB_SIZE = 480;
const TRASH_DIR = '.trash';                                    // dentro de la carpeta de cada usuario
const TRASH_TTL_DAYS = Number(process.env.TRASH_TTL_DAYS || 30);
const SEARCH_LIMIT = 300;
const BATCH_LIMIT = 500;
// Enlaces: de subida (otros te dejan archivos) y de descarga (mandas tú algo).
// Comparten archivo y se distinguen por el campo kind.
const LINKS_FILE = path.join(APP_DIR, 'uploadlinks.json');
const ZIP_LIMIT = Number(process.env.ZIP_LIMIT || 200);
const LINK_MAX_FILES = Number(process.env.LINK_MAX_FILES || 50);
const LINK_MAX_BYTES = Number(process.env.LINK_MAX_BYTES || 2 * 1024 * 1024 * 1024);
const LINK_IP_HOURLY = Number(process.env.LINK_IP_HOURLY || 200);
// Bloc de notas: vive dentro de la carpeta del usuario, oculto del explorador
const NOTES_DIR = '.notes';
const NOTES_LIMIT = Number(process.env.NOTES_LIMIT || 5000);
const NOTE_MAX_CHARS = Number(process.env.NOTE_MAX_CHARS || 500000);
// Álbumes: colecciones con nombre que apuntan a fotos sin moverlas de sitio
const ALBUMS_DIR = '.albums';
const ALBUM_LIMIT = 200;
const ALBUM_ITEMS_LIMIT = 2000;
// Sesiones (para poder cerrarlas en remoto) y registro de actividad
const SESSIONS_FILE = path.join(APP_DIR, 'sessions.json');
const ACTIVITY_FILE = path.join(APP_DIR, 'activity.log.jsonl');
const ACTIVITY_MAX = Number(process.env.ACTIVITY_MAX || 5000);
// Buscador de duplicados: tope de archivos a examinar por si el árbol es enorme
const DUP_LIMIT = Number(process.env.DUP_LIMIT || 20000);

// Categorías para el reparto de espacio del panel de administración
const TYPE_RE = [
  ['image', /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|svg|tiff?)$/i],
  ['video', /\.(mp4|mov|avi|mkv|webm|m4v|mpe?g|wmv|flv)$/i],
  ['audio', /\.(mp3|wav|flac|aac|ogg|m4a|wma|opus)$/i],
  ['doc',   /\.(pdf|docx?|txt|rtf|odt|md|pages|xlsx?|csv|ods|pptx?|odp|epub)$/i],
];
const typeOf = (name) => (TYPE_RE.find(([, re]) => re.test(name)) || ['other'])[0];

// --- Setup ---
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
} catch (err) {
  console.error(`No se pudo crear el directorio de datos ${DATA_DIR}:`, err.message);
  process.exit(1);
}
// Raíz canónica: todas las rutas se validan contra ella con los symlinks ya resueltos
const DATA_ROOT = fs.realpathSync(DATA_DIR);

/**
 * Secreto de firma JWT. Nunca hay un valor por defecto conocido: se usa JWT_SECRET
 * si existe, y si no se genera uno aleatorio y se guarda para sobrevivir reinicios.
 */
function loadSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) {
      console.error('JWT_SECRET es demasiado corto: usa al menos 32 caracteres aleatorios.');
      process.exit(1);
    }
    return fromEnv;
  }
  if (fs.existsSync(SECRET_FILE)) {
    const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (saved.length >= 32) return saved;
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  console.log(`JWT_SECRET no definido: generado uno aleatorio en ${SECRET_FILE}`);
  return generated;
}
const JWT_SECRET = loadSecret();

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function saveUsers(users) {
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

// Bootstrap: crea admin por defecto si no hay usuarios
if (!fs.existsSync(USERS_FILE)) {
  const defaultPass = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const hash = bcrypt.hashSync(defaultPass, 10);
  saveUsers([{ username: 'admin', passwordHash: hash, role: 'admin' }]);
  console.log('==================================================');
  console.log('Usuario admin creado. Usuario: admin  Password:', defaultPass);
  console.log('CAMBIA ESTA CONTRASEÑA DESPUÉS DE ENTRAR.');
  console.log('==================================================');
}

// Hash de descarte: iguala el tiempo de respuesta cuando el usuario no existe,
// para no filtrar por temporización qué nombres de usuario están dados de alta.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

/* ---------------- Sesiones ----------------
   El JWT sigue siendo la cookie, pero ya no basta por sí solo: cada uno lleva
   un jti que apunta a un registro aquí. Cerrar una sesión en remoto borra su
   registro, y el siguiente uso de ese token cae con 401 aunque no haya caducado. */
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(data) {
  const tmp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSIONS_FILE);
}
const sessions = loadSessions();
let sessionsSucio = false;
setInterval(() => { if (sessionsSucio) { sessionsSucio = false; saveSessions(sessions); } }, 5000).unref();

function creaSesion(username, req) {
  const jti = crypto.randomBytes(16).toString('hex');
  sessions[jti] = {
    jti, username,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ip: req.ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
  };
  sessionsSucio = true;
  return jti;
}
function revocaSesion(jti) {
  if (!sessions[jti]) return false;
  delete sessions[jti];
  sessionsSucio = true;
  return true;
}

/* ---------------- Registro de actividad ----------------
   Un evento por línea (JSONL), fácil de seguir con tail -f. Se recorta solo
   para que nadie tenga que acordarse de vaciarlo. */
function registrarActividad(req, accion, detalle) {
  try {
    const entry = {
      t: Date.now(),
      user: (req.user && req.user.username) || (detalle && detalle.username) || null,
      accion,
      ip: req.ip,
      detalle: detalle || {},
    };
    fs.appendFile(ACTIVITY_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch { /* un fallo aquí no debe tumbar la petición real */ }
}
setInterval(() => {
  fs.readFile(ACTIVITY_FILE, 'utf8', (err, data) => {
    if (err) return;
    const lineas = data.split('\n').filter(Boolean);
    if (lineas.length <= ACTIVITY_MAX) return;
    fs.writeFile(ACTIVITY_FILE, lineas.slice(-ACTIVITY_MAX).join('\n') + '\n', () => {});
  });
}, 10 * 60 * 1000).unref();

/* ---------------- TOTP (RFC 6238), para la verificación en dos pasos ----------------
   Implementado a mano para no añadir una dependencia solo por esto: son
   40 líneas de base32 y HMAC-SHA1, ambos ya presentes en Node. */
function base32Encode(buf) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', salida = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) salida += alfabeto[parseInt(bits.slice(i, i + 5), 2)];
  const resto = bits.length % 5;
  if (resto) salida += alfabeto[parseInt(bits.slice(-resto).padEnd(5, '0'), 2)];
  while (salida.length % 8) salida += '=';
  return salida;
}
function base32Decode(str) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const limpio = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of limpio) {
    const v = alfabeto.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpEn(secretBuf, contador) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const codigo = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 |
                  (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
  return String(codigo).padStart(6, '0');
}
// Ventana de ±1 paso (30 s): cubre el desfase de reloj típico entre servidor y móvil
function totpVerificar(secretB32, token) {
  if (!token) return false;
  const secretBuf = base32Decode(secretB32);
  const contador = Math.floor(Date.now() / 30000);
  for (let e = -1; e <= 1; e++) {
    if (totpEn(secretBuf, contador + e) === String(token).trim()) return true;
  }
  return false;
}

const app = express();
app.set('trust proxy', 1); // detrás de Nginx: necesario para que req.ip sea la IP real
app.disable('x-powered-by');
// WebDAV va ANTES del analizador de JSON: un cliente que suba un .json con
// Content-Type: application/json haría que express.json() se comiera el cuerpo
// y el PUT escribiera un archivo vacío.
app.use('/dav', createDav({
  resolveFor,
  userRoot,
  loadUsers,
  isHidden,
  log: (...a) => console.warn(...a),
}));

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// --- Cabeceras de seguridad ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN y no DENY: el visor de PDF va dentro de un marco de la propia web.
  // Otro sitio sigue sin poder enmarcarnos, que es de lo que protege esto.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // object-src 'self' y no 'none': para enseñar un PDF dentro de un marco, Chrome lo
  // trata como contenido de complemento y mira esta directiva del documento que lo
  // enmarca. Con 'none' sale el recuadro gris de "no se pudo cargar". Sigue limitado
  // al propio dominio, y todo se sirve con nosniff y con el tipo declarado.
  // img-src incluye el servidor de tiles del mapa: es lo ÚNICO externo de toda la app.
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' data: ${TILE_ORIGIN}; style-src 'self' 'unsafe-inline'; ` +
    "script-src 'self'; object-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'self'"
  );
  next();
});

app.use(express.static(path.join(APP_DIR, 'public')));

// --- Auth middleware ---
function auth(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Los tokens emitidos antes de que existiera esto no llevan jti: se dejan pasar,
    // así el despliegue no cierra la sesión de todo el mundo de golpe.
    if (payload.jti) {
      const s = sessions[payload.jti];
      if (!s) return res.status(401).json({ error: 'Sesión cerrada' });
      s.lastSeenAt = Date.now();
      sessionsSucio = true;
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// --- Limitador de intentos de login (en memoria) ---
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const attempts = new Map(); // clave -> { count, expires }

function isBlocked(key) {
  const entry = attempts.get(key);
  if (!entry) return 0;
  if (Date.now() > entry.expires) { attempts.delete(key); return 0; }
  if (entry.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((entry.expires - Date.now()) / 1000);
}
function registerFailure(key) {
  const entry = attempts.get(key);
  if (entry && Date.now() <= entry.expires) {
    entry.count++;
    entry.expires = Date.now() + LOCK_MS;
  } else {
    attempts.set(key, { count: 1, expires: Date.now() + LOCK_MS });
  }
}
function clearFailures(key) { attempts.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) if (now > entry.expires) attempts.delete(key);
}, 5 * 60 * 1000).unref();

// --- Helpers de rutas seguras (evita path traversal) ---
function invalidPath() {
  const err = new Error('Ruta inválida');
  err.status = 400;
  return err;
}

/**
 * Resuelve relPath dentro de root y garantiza que no se sale de ahí.
 * Compara contra root + separador para que un directorio hermano con el mismo
 * prefijo (/data/storage-backup) no cuele, y resuelve symlinks antes de validar.
 */
function safeResolve(root, relPath) {
  const target = path.resolve(root, path.join('.', relPath || ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw invalidPath();
  // El destino puede no existir todavía (mkdir, mover): en ese caso valida el ancestro más cercano
  let probe = target;
  let real = null;
  while (probe.length >= root.length) {
    try { real = fs.realpathSync(probe); break; } catch { probe = path.dirname(probe); }
  }
  if (real && real !== root && !real.startsWith(root + path.sep)) throw invalidPath();
  return target;
}

/**
 * Raíz de cada usuario: el admin ve todo el almacén, cada usuario normal
 * trabaja aislado dentro de <DATA_ROOT>/users/<username>.
 */
function userRoot(user) {
  if (user.role === 'admin') return DATA_ROOT;
  if (!USERNAME_RE.test(user.username)) throw invalidPath();
  const dir = path.join(DATA_ROOT, 'users', user.username);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}
// Los nombres que empiezan por punto son internos (.trash) y no se exponen nunca:
// ni se listan ni se pueden alcanzar desde la API pública.
// Declaración, no constante: se usa al montar WebDAV, que va más arriba del archivo
function isHidden(name) { return name.startsWith('.'); }
function assertVisible(relPath) {
  const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean);
  if (parts.some(isHidden)) throw invalidPath();
}
function resolveFor(user, relPath) {
  assertVisible(relPath);
  return safeResolve(userRoot(user), relPath);
}
function userPath(req, relPath) {
  return resolveFor(req.user, relPath);
}
function sendError(res, err) {
  res.status(err.status || 400).json({ error: err.message });
}
async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
// Devuelve una ruta libre añadiendo _1, _2… si el destino ya está ocupado
async function freeName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let target = path.join(dir, name);
  let n = 1;
  while (await exists(target)) target = path.join(dir, `${base}_${n++}${ext}`);
  return target;
}

/* ---------------- Enlaces de subida ---------------- */
function loadLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch { return []; }
}
function saveLinks(links) {
  const tmp = `${LINKS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(links, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LINKS_FILE);
}
const linkExpired = (l) => !!l.expiresAt && Date.now() > l.expiresAt;
// Los enlaces creados antes de que existieran los de descarga no llevan kind
const linkKind = (l) => l.kind || 'upload';
function linkPublic(l) {
  // Lo único que ve quien recibe el enlace: nunca la ruta ni el dueño
  return { id: l.id, label: l.label, expiresAt: l.expiresAt, files: l.files, maxFiles: LINK_MAX_FILES };
}
// El rol puede haber cambiado desde que se creó el enlace, así que se relee
function ownerOf(link) {
  const u = loadUsers().find(u => u.username === link.owner);
  return u ? { username: u.username, role: u.role } : null;
}

// Tope por IP para el endpoint público de subida
const publicHits = new Map();
function publicAllowed(ip) {
  const now = Date.now();
  const e = publicHits.get(ip);
  if (!e || now > e.reset) { publicHits.set(ip, { n: 1, reset: now + 3600000 }); return true; }
  e.n++;
  return e.n <= LINK_IP_HOURLY;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of publicHits) if (now > v.reset) publicHits.delete(k);
}, 10 * 60 * 1000).unref();

/* ---------------- Papelera ---------------- */
function trashRoot(user) {
  const dir = path.join(userRoot(user), TRASH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function readTrash(user) {
  try { return JSON.parse(await fsp.readFile(path.join(trashRoot(user), 'index.json'), 'utf8')); }
  catch { return []; }
}
async function writeTrash(user, entries) {
  const file = path.join(trashRoot(user), 'index.json');
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(entries, null, 2));
  await fsp.rename(tmp, file);
}
// Mueve a la papelera en lugar de borrar: un rm -rf recursivo sin vuelta atrás
// es demasiado fácil de disparar por accidente desde el móvil.
async function trashItem(user, relPath) {
  const target = resolveFor(user, relPath);
  if (target === userRoot(user)) {
    const err = new Error('No puedes borrar la carpeta raíz');
    err.status = 400;
    throw err;
  }
  const stat = await fsp.stat(target);
  const id = crypto.randomBytes(8).toString('hex');
  await fsp.rename(target, path.join(trashRoot(user), id));
  const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const from = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
  const entries = await readTrash(user);
  entries.unshift({
    id,
    name: path.basename(target),
    from,
    isDir: stat.isDirectory(),
    size: stat.isDirectory() ? 0 : stat.size,
    deletedAt: Date.now(),
  });
  await writeTrash(user, entries);
}
async function purgeExpired(user) {
  const entries = await readTrash(user);
  const cutoff = Date.now() - TRASH_TTL_DAYS * 86400000;
  const expired = entries.filter(e => e.deletedAt < cutoff);
  if (!expired.length) return entries;
  for (const e of expired) {
    await fsp.rm(path.join(trashRoot(user), e.id), { recursive: true, force: true });
  }
  const kept = entries.filter(e => e.deletedAt >= cutoff);
  await writeTrash(user, kept);
  return kept;
}

// --- Login ---
app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const ipKey = `ip:${req.ip}`;
  const userKey = `user:${username.toLowerCase()}`;

  const wait = isBlocked(ipKey) || isBlocked(userKey);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `Demasiados intentos fallidos. Prueba en ${Math.ceil(wait / 60)} min.` });
  }

  const users = loadUsers();
  const user = users.find(u => u.username === username);
  const ok = bcrypt.compareSync(password, user ? user.passwordHash : DUMMY_HASH) && !!user;
  if (!ok) {
    registerFailure(ipKey);
    if (username) registerFailure(userKey);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  clearFailures(ipKey);
  clearFailures(userKey);

  // Con verificación en dos pasos activada, esto solo confirma la contraseña:
  // la sesión de verdad no se abre hasta validar el código en /api/login/2fa
  if (user.twofaSecret) {
    const pendiente = jwt.sign({ username: user.username, stage: '2fa' }, JWT_SECRET, { expiresIn: '5m' });
    res.cookie('pending2fa', pendiente, {
      httpOnly: true, sameSite: 'strict', secure: SECURE_COOKIES, maxAge: 5 * 60 * 1000,
    });
    return res.json({ ok: true, need2fa: true });
  }

  const jti = creaSesion(user.username, req);
  const token = jwt.sign({ username: user.username, role: user.role, jti }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: SECURE_COOKIES,
    maxAge: 30 * 24 * 3600 * 1000,
  });
  registrarActividad({ user: { username: user.username }, ip: req.ip }, 'login', {});
  res.json({ ok: true, username: user.username, role: user.role });
});

// Segundo paso del login: el código de la app de autenticación
app.post('/api/login/2fa', (req, res) => {
  const pendiente = req.cookies.pending2fa;
  if (!pendiente) return res.status(401).json({ error: 'Vuelve a iniciar sesión' });
  let payload;
  try { payload = jwt.verify(pendiente, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Vuelve a iniciar sesión' }); }
  if (payload.stage !== '2fa') return res.status(401).json({ error: 'Vuelve a iniciar sesión' });

  const ipKey = `ip:${req.ip}`;
  const wait = isBlocked(ipKey);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: `Demasiados intentos. Prueba en ${Math.ceil(wait / 60)} min.` });
  }

  const users = loadUsers();
  const user = users.find(u => u.username === payload.username);
  if (!user || !user.twofaSecret || !totpVerificar(user.twofaSecret, req.body?.code)) {
    registerFailure(ipKey);
    return res.status(401).json({ error: 'Código incorrecto' });
  }
  clearFailures(ipKey);
  res.clearCookie('pending2fa', { httpOnly: true, sameSite: 'strict', secure: SECURE_COOKIES });

  const jti = creaSesion(user.username, req);
  const token = jwt.sign({ username: user.username, role: user.role, jti }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'strict', secure: SECURE_COOKIES, maxAge: 30 * 24 * 3600 * 1000,
  });
  registrarActividad({ user: { username: user.username }, ip: req.ip }, 'login', {});
  res.json({ ok: true, username: user.username, role: user.role });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.token;
  if (token) {
    try { const p = jwt.verify(token, JWT_SECRET); if (p.jti) revocaSesion(p.jti); } catch { /* token ya inválido */ }
  }
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: SECURE_COOKIES });
  res.clearCookie('pending2fa', { httpOnly: true, sameSite: 'strict', secure: SECURE_COOKIES });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// --- Gestión de usuarios (solo admin) ---
app.get('/api/users', auth, adminOnly, (req, res) => {
  const users = loadUsers().map(u => ({ username: u.username, role: u.role }));
  res.json(users);
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Usuario inválido: 3-32 caracteres, solo letras, números y . _ -' });
  }
  if (String(password).length < MIN_PASSWORD) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres` });
  }
  const users = loadUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Usuario ya existe' });
  users.push({ username, passwordHash: bcrypt.hashSync(password, 10), role: role === 'admin' ? 'admin' : 'user' });
  saveUsers(users);
  registrarActividad(req, 'usuario_creado', { username });
  res.json({ ok: true });
});

app.delete('/api/users/:username', auth, adminOnly, (req, res) => {
  let users = loadUsers();
  if (req.params.username === 'admin') return res.status(400).json({ error: 'No puedes borrar admin' });
  users = users.filter(u => u.username !== req.params.username);
  saveUsers(users);
  registrarActividad(req, 'usuario_eliminado', { username: req.params.username });
  res.json({ ok: true });
});

app.post('/api/users/:username/password', auth, (req, res) => {
  if (req.user.username !== req.params.username && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { password } = req.body || {};
  if (!password || password.length < MIN_PASSWORD) return res.status(400).json({ error: 'Contraseña muy corta' });
  const users = loadUsers();
  const u = users.find(u => u.username === req.params.username);
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  u.passwordHash = bcrypt.hashSync(password, 10);
  saveUsers(users);
  registrarActividad(req, 'password_cambiada', { username: req.params.username });
  res.json({ ok: true });
});

/* ---------------- Sesiones abiertas ---------------- */
app.get('/api/sessions', auth, (req, res) => {
  const mias = Object.values(sessions)
    .filter(s => s.username === req.user.username)
    .map(s => ({ ...s, current: s.jti === req.user.jti }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  res.json(mias);
});
app.delete('/api/sessions/:jti', auth, (req, res) => {
  const s = sessions[req.params.jti];
  if (!s || s.username !== req.user.username) return res.status(404).json({ error: 'No encontrada' });
  revocaSesion(req.params.jti);
  registrarActividad(req, 'sesion_cerrada_remoto', { jti: req.params.jti });
  res.json({ ok: true });
});
app.delete('/api/sessions', auth, (req, res) => {
  let n = 0;
  for (const [jti, s] of Object.entries(sessions)) {
    if (s.username === req.user.username && jti !== req.user.jti) { delete sessions[jti]; n++; }
  }
  if (n) sessionsSucio = true;
  registrarActividad(req, 'sesiones_cerradas_todas', { cantidad: n });
  res.json({ ok: true, removed: n });
});

/* ---------------- Verificación en dos pasos (TOTP) ---------------- */
app.get('/api/2fa/status', auth, (req, res) => {
  const u = loadUsers().find(x => x.username === req.user.username);
  res.json({ enabled: !!(u && u.twofaSecret) });
});

app.post('/api/2fa/setup', auth, (req, res) => {
  const secreto = base32Encode(crypto.randomBytes(20));
  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  u.twofaPending = secreto;                 // no se activa hasta confirmar con un código válido
  saveUsers(users);
  const uri = `otpauth://totp/${encodeURIComponent('KookyeCatCloud:' + u.username)}` +
    `?secret=${secreto}&issuer=${encodeURIComponent('KookyeCatCloud')}&digits=6&period=30`;
  res.json({ secret: secreto, uri });
});

app.post('/api/2fa/confirm', auth, (req, res) => {
  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  if (!u.twofaPending) return res.status(400).json({ error: 'Primero pide un código nuevo' });
  if (!totpVerificar(u.twofaPending, req.body?.code)) return res.status(400).json({ error: 'Código incorrecto' });
  u.twofaSecret = u.twofaPending;
  delete u.twofaPending;
  saveUsers(users);
  registrarActividad(req, '2fa_activado', {});
  res.json({ ok: true });
});

app.post('/api/2fa/disable', auth, (req, res) => {
  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  if (!bcrypt.compareSync(String(req.body?.password || ''), u.passwordHash)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  delete u.twofaSecret;
  delete u.twofaPending;
  saveUsers(users);
  registrarActividad(req, '2fa_desactivado', {});
  res.json({ ok: true });
});

/* ---------------- Tokens de aplicación ----------------
   Para WebDAV o scripts, sin usar la contraseña de la cuenta: se pueden
   revocar uno a uno sin tener que cambiarla. */
app.get('/api/apptokens', auth, (req, res) => {
  const u = loadUsers().find(x => x.username === req.user.username);
  const tokens = (u?.apptokens || []).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null }));
  res.json(tokens);
});
app.post('/api/apptokens', auth, (req, res) => {
  const nombre = String(req.body?.name || '').slice(0, 60) || 'Sin nombre';
  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  u.apptokens = u.apptokens || [];
  if (u.apptokens.length >= 20) return res.status(400).json({ error: 'Máximo 20 tokens. Revoca alguno antes de crear otro.' });
  const token = crypto.randomBytes(24).toString('base64url');
  const entrada = { id: crypto.randomBytes(8).toString('hex'), name: nombre, hash: bcrypt.hashSync(token, 10), createdAt: Date.now() };
  u.apptokens.push(entrada);
  saveUsers(users);
  registrarActividad(req, 'apptoken_creado', { name: nombre });
  // El valor real solo se ve esta vez: a partir de aquí solo se guarda su hash
  res.json({ ok: true, id: entrada.id, token });
});
app.delete('/api/apptokens/:id', auth, (req, res) => {
  const users = loadUsers();
  const u = users.find(x => x.username === req.user.username);
  const antes = (u.apptokens || []).length;
  u.apptokens = (u.apptokens || []).filter(t => t.id !== req.params.id);
  if (u.apptokens.length === antes) return res.status(404).json({ error: 'No encontrado' });
  saveUsers(users);
  registrarActividad(req, 'apptoken_revocado', { id: req.params.id });
  res.json({ ok: true });
});

/* ---------------- Registro de actividad ---------------- */
app.get('/api/activity', auth, async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limit) || 100, 500);
    let datos = '';
    try { datos = await fsp.readFile(ACTIVITY_FILE, 'utf8'); } catch { /* aún no hay actividad registrada */ }
    let entradas = datos.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (req.user.role !== 'admin') entradas = entradas.filter(e => e.user === req.user.username);
    entradas.reverse();
    res.json({ items: entradas.slice(0, limite) });
  } catch (err) { sendError(res, err); }
});

// --- Listar archivos/carpetas ---
app.get('/api/files', auth, async (req, res) => {
  try {
    const rel = req.query.path || '';
    const dir = userPath(req, rel);
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter(e => !isHidden(e.name));
    const items = await Promise.all(entries.map(async e => {
      const full = path.join(dir, e.name);
      let stat;
      try { stat = await fsp.stat(full); } catch { return null; } // symlink roto o borrado a medias
      return {
        name: e.name,
        isDir: stat.isDirectory(),
        size: stat.size,
        modified: stat.mtime,
      };
    }));
    const visible = items.filter(Boolean);
    visible.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    res.json({ path: rel, items: visible });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Crear carpeta ---
app.post('/api/mkdir', auth, async (req, res) => {
  try {
    const { path: rel, name } = req.body || {};
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
      return res.status(400).json({ error: 'Nombre de carpeta inválido' });
    }
    const dir = userPath(req, path.join(rel || '', name));
    await fsp.mkdir(dir, { recursive: false });
    registrarActividad(req, 'carpeta_creada', { path: path.join(rel || '', name) });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'EEXIST') return res.status(409).json({ error: 'Ya existe una carpeta con ese nombre' });
    sendError(res, err);
  }
});

// --- Subir archivos ---
// Un único constructor para la subida autenticada y la pública: solo cambia
// cómo se resuelve la carpeta de destino.
function makeUploader(resolveDir, limits) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const dir = resolveDir(req);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (e) { cb(e); }
    },
    filename: (req, file, cb) => {
      try {
        const dir = resolveDir(req);
        // basename() descarta cualquier ruta que venga en el nombre original del cliente
        const safeName = path.basename(file.originalname).replace(/^\.+/, '') || 'archivo';
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        let target = path.join(dir, safeName);
        let counter = 1;
        while (fs.existsSync(target)) {
          target = path.join(dir, `${base}_${counter}${ext}`);
          counter++;
        }
        cb(null, path.basename(target));
      } catch (e) { cb(e); }
    }
  });
  return multer({ storage, limits: limits || { fileSize: MAX_UPLOAD_BYTES } });
}

const upload = makeUploader(req => userPath(req, req.query.path || ''));

app.post('/api/upload', auth, (req, res) => {
  upload.array('files')(req, res, err => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    const subidos = (req.files || []).map(f => f.filename);
    if (subidos.length) registrarActividad(req, 'archivo_subido', { path: req.query.path || '', archivos: subidos });
    res.json({ ok: true, uploaded: subidos });
  });
});

/* --- Descargar carpetas o selecciones como ZIP --- */
// Content-Disposition con acentos: nombre en ASCII y la versión real en filename*
function cabeceraDescarga(res, nombre) {
  const ascii = nombre.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`);
}

async function enviarZip(res, entradas, nombreZip) {
  res.setHeader('Content-Type', 'application/zip');
  cabeceraDescarga(res, nombreZip);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('warning', err => { if (err.code !== 'ENOENT') console.warn('zip', err.message); });
  zip.on('error', err => {
    console.warn('zip', err.message);
    // Ya se están enviando bytes: no queda más que cortar
    res.destroy();
  });
  zip.pipe(res);
  for (const e of entradas) {
    if (e.isDir) zip.directory(e.abs, e.name);
    else zip.file(e.abs, { name: e.name });
  }
  await zip.finalize();
}

app.get('/api/zip', auth, async (req, res) => {
  try {
    const lista = [].concat(req.query.p || []).filter(Boolean);
    if (!lista.length) return res.status(400).json({ error: 'No has indicado qué descargar' });
    if (lista.length > ZIP_LIMIT) return res.status(400).json({ error: `Máximo ${ZIP_LIMIT} elementos por ZIP` });

    const entradas = [];
    for (const rel of lista) {
      const abs = userPath(req, rel);
      const stat = await fsp.stat(abs);
      entradas.push({ abs, name: path.basename(abs), isDir: stat.isDirectory() });
    }
    const nombre = entradas.length === 1
      ? `${entradas[0].name.replace(/\.[^.]+$/, '')}.zip`
      : `KookyeCatCloud-${new Date().toISOString().slice(0, 10)}.zip`;
    await enviarZip(res, entradas, nombre);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
});

/* --- Enlaces de subida: gestión (con sesión) --- */
app.get('/api/uploadlinks', auth, (req, res) => {
  const soloDe = req.query.kind;
  const mine = loadLinks()
    .filter(l => l.owner === req.user.username)
    .filter(l => !soloDe || linkKind(l) === soloDe)
    .map(l => ({ ...l, kind: linkKind(l), expired: linkExpired(l), password: undefined,
                 passwordHash: undefined, protegido: !!l.passwordHash }));
  res.json(mine);
});

/* --- Enlaces de descarga: compartir un archivo o una carpeta --- */
app.post('/api/sharelinks', auth, async (req, res) => {
  try {
    const { path: rel, label, days, password } = req.body || {};
    const abs = userPath(req, rel);
    const stat = await fsp.stat(abs);
    const d = Number(days);
    const links = loadLinks();
    const entrada = {
      id: crypto.randomBytes(16).toString('hex'),
      kind: 'share',
      owner: req.user.username,
      path: String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      label: String(label || '').slice(0, 80) || path.basename(abs),
      isDir: stat.isDirectory(),
      createdAt: Date.now(),
      expiresAt: d > 0 ? Date.now() + d * 86400000 : null,
      downloads: 0,
    };
    if (password) entrada.passwordHash = bcrypt.hashSync(String(password), 10);
    links.unshift(entrada);
    saveLinks(links);
    registrarActividad(req, 'enlace_compartido_creado', { path: entrada.path, isDir: entrada.isDir });
    res.json({ ok: true, link: { ...entrada, passwordHash: undefined, protegido: !!entrada.passwordHash } });
  } catch (err) {
    sendError(res, err);
  }
});

// Datos públicos del enlace: nunca la ruta ni el dueño
app.get('/api/public/share/:id', async (req, res) => {
  const link = loadLinks().find(l => l.id === req.params.id && linkKind(l) === 'share');
  if (!link) return res.status(404).json({ error: 'Este enlace no existe' });
  if (linkExpired(link)) return res.status(410).json({ error: 'Este enlace ha caducado' });
  const owner = ownerOf(link);
  if (!owner) return res.status(410).json({ error: 'Este enlace ya no está disponible' });

  let size = 0;
  try {
    const abs = resolveFor(owner, link.path);
    const stat = await fsp.stat(abs);
    size = stat.isDirectory() ? 0 : stat.size;
  } catch {
    return res.status(410).json({ error: 'El archivo ya no está disponible' });
  }
  res.json({
    id: link.id, label: link.label, isDir: link.isDir, size,
    expiresAt: link.expiresAt, downloads: link.downloads, protegido: !!link.passwordHash,
  });
});

app.get('/api/public/share/:id/download', async (req, res) => {
  try {
    if (!publicAllowed(req.ip)) return res.status(429).json({ error: 'Demasiadas descargas desde tu conexión' });
    const links = loadLinks();
    const link = links.find(l => l.id === req.params.id && linkKind(l) === 'share');
    if (!link) return res.status(404).json({ error: 'Este enlace no existe' });
    if (linkExpired(link)) return res.status(410).json({ error: 'Este enlace ha caducado' });
    if (link.passwordHash && !bcrypt.compareSync(String(req.query.pw || ''), link.passwordHash)) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    const owner = ownerOf(link);
    if (!owner) return res.status(410).json({ error: 'Este enlace ya no está disponible' });

    const abs = resolveFor(owner, link.path);
    const stat = await fsp.stat(abs);

    link.downloads = (link.downloads || 0) + 1;
    link.lastDownloadAt = Date.now();
    saveLinks(links);

    if (stat.isDirectory()) {
      return enviarZip(res, [{ abs, name: path.basename(abs), isDir: true }], `${path.basename(abs)}.zip`);
    }
    cabeceraDescarga(res, path.basename(abs));
    res.sendFile(abs, { headers: { 'Content-Type': 'application/octet-stream' } });
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
});

/* --- Galería pública de una carpeta compartida ---
   Antes, compartir una carpeta solo ofrecía el ZIP entero. Esto deja navegarla
   y ver las fotos igual que en la propia app, sin sesión y sin salir de la ruta
   que se compartió: dentroDeLink() nunca deja subir por encima de link.path. */
function dentroDeLink(owner, link, subrel) {
  const base = resolveFor(owner, link.path);           // ya es de fiar: es el dueño real del enlace
  const sub = String(subrel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  assertVisible(sub);
  return safeResolve(base, sub);
}
function claveCompartida(link, req) {
  return !link.passwordHash || bcrypt.compareSync(String(req.query.pw || ''), link.passwordHash);
}
function esMediaPublico(name) {
  const ext = path.extname(name).toLowerCase();
  return !!(IMAGE_TYPES[ext] || HEIC_TYPES[ext] || VIDEO_TYPES[ext]);
}

app.get('/api/public/share/:id/list', async (req, res) => {
  try {
    const link = loadLinks().find(l => l.id === req.params.id && linkKind(l) === 'share');
    if (!link) return res.status(404).json({ error: 'Este enlace no existe' });
    if (linkExpired(link)) return res.status(410).json({ error: 'Este enlace ha caducado' });
    if (!link.isDir) return res.status(400).json({ error: 'Este enlace no es una carpeta' });
    if (!claveCompartida(link, req)) return res.status(401).json({ error: 'Contraseña incorrecta' });
    const owner = ownerOf(link);
    if (!owner) return res.status(410).json({ error: 'Este enlace ya no está disponible' });

    const dir = dentroDeLink(owner, link, req.query.sub || '');
    const entradas = (await fsp.readdir(dir, { withFileTypes: true })).filter(e => !isHidden(e.name));
    const items = (await Promise.all(entradas.map(async e => {
      try {
        const stat = await fsp.stat(path.join(dir, e.name));
        return { name: e.name, isDir: stat.isDirectory(), size: stat.size, modified: stat.mtime,
                 viewable: !stat.isDirectory() && esMediaPublico(e.name) };
      } catch { return null; }
    }))).filter(Boolean).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'es'));
    res.json({ items });
  } catch (err) { sendError(res, err); }
});

app.get('/api/public/share/:id/thumb', async (req, res) => {
  try {
    const link = loadLinks().find(l => l.id === req.params.id && linkKind(l) === 'share');
    if (!link || linkExpired(link) || !link.isDir || !claveCompartida(link, req)) return res.status(404).end();
    const owner = ownerOf(link);
    if (!owner) return res.status(404).end();
    const file = dentroDeLink(owner, link, req.query.sub || '');
    const ext = path.extname(file).toLowerCase();
    const esVideo = !!VIDEO_TYPES[ext];
    const tipo = THUMBABLE[ext];
    if (!tipo && !esVideo) return res.status(415).end();
    if (esVideo && !ffmpeg) return res.status(415).end();

    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (!esVideo && !sharp) return res.sendFile(file, { headers: { 'Content-Type': tipo } });

    const stat = await fsp.stat(file);
    const key = crypto.createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}|${THUMB_SIZE}|thumb`).digest('hex');
    const cached = path.join(THUMBS_DIR, `${key}.webp`);
    if (!await exists(cached)) {
      const tmp = `${cached}.${process.pid}.tmp`;
      if (esVideo) {
        const tmpImg = `${tmp}.webp`;
        await fotogramaVideo(file, tmpImg);
        await fsp.rename(tmpImg, cached);
      } else {
        const buf = await sharp(file, { failOn: 'none' }).rotate()
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' }).webp({ quality: 78 }).toBuffer();
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, cached);
      }
    }
    res.sendFile(cached, { headers: { 'Content-Type': 'image/webp' } });
  } catch { res.status(404).end(); }
});

app.get('/api/public/share/:id/view', async (req, res) => {
  try {
    const link = loadLinks().find(l => l.id === req.params.id && linkKind(l) === 'share');
    if (!link || linkExpired(link) || !link.isDir || !claveCompartida(link, req)) return res.status(404).end();
    const owner = ownerOf(link);
    if (!owner) return res.status(404).end();
    const file = dentroDeLink(owner, link, req.query.sub || '');
    const ext = path.extname(file).toLowerCase();
    const type = PREVIEW_TYPES[ext];
    if (!type || ext === '.pdf') return res.status(415).end();   // la galería pública es solo fotos y vídeos

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (HEIC_TYPES[ext]) {
      if (!sharp) return res.status(415).end();
      const stat = await fsp.stat(file);
      const conv = await convertirCache(file, stat, DISPLAY_MAX, 'view');
      return res.sendFile(conv, { headers: { 'Content-Type': 'image/webp' } });
    }
    res.sendFile(file, { headers: { 'Content-Type': type } });
  } catch { res.status(404).end(); }
});

// Descarga de UN archivo dentro de la galería, sin tener que bajarte el ZIP entero
app.get('/api/public/share/:id/file', async (req, res) => {
  try {
    if (!publicAllowed(req.ip)) return res.status(429).json({ error: 'Demasiadas descargas desde tu conexión' });
    const links = loadLinks();
    const link = links.find(l => l.id === req.params.id && linkKind(l) === 'share');
    if (!link || linkExpired(link) || !link.isDir) return res.status(404).end();
    if (!claveCompartida(link, req)) return res.status(401).end();
    const owner = ownerOf(link);
    if (!owner) return res.status(404).end();
    const file = dentroDeLink(owner, link, req.query.sub || '');
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) return res.status(400).end();
    link.downloads = (link.downloads || 0) + 1;
    saveLinks(links);
    cabeceraDescarga(res, path.basename(file));
    res.sendFile(file, { headers: { 'Content-Type': 'application/octet-stream' } });
  } catch { res.status(404).end(); }
});

// Página pública del enlace de descarga
app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(APP_DIR, 'public', 'share.html'));
});

app.post('/api/uploadlinks', auth, (req, res) => {
  try {
    const { path: rel, label, days } = req.body || {};
    const dir = userPath(req, rel || '');           // valida que la ruta es suya y visible
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'La carpeta de destino no existe' });
    }
    const d = Number(days);
    const links = loadLinks();
    links.unshift({
      id: crypto.randomBytes(16).toString('hex'),
      owner: req.user.username,
      path: String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      label: String(label || '').slice(0, 80) || 'Envío de archivos',
      createdAt: Date.now(),
      expiresAt: d > 0 ? Date.now() + d * 86400000 : null,
      files: 0,
      bytes: 0,
    });
    saveLinks(links);
    res.json({ ok: true, link: links[0] });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/uploadlinks/:id', auth, (req, res) => {
  const links = loadLinks();
  const link = links.find(l => l.id === req.params.id);
  if (!link || link.owner !== req.user.username) return res.status(404).json({ error: 'No encontrado' });
  saveLinks(links.filter(l => l.id !== link.id));
  res.json({ ok: true });
});

/* --- Enlaces de subida: uso público, sin sesión --- */
app.get('/api/public/link/:id', (req, res) => {
  const link = loadLinks().find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Este enlace no existe' });
  if (linkExpired(link)) return res.status(410).json({ error: 'Este enlace ha caducado' });
  if (!ownerOf(link)) return res.status(410).json({ error: 'Este enlace ya no está disponible' });
  res.json(linkPublic(link));
});

app.post('/api/public/link/:id/upload', (req, res) => {
  if (!publicAllowed(req.ip)) return res.status(429).json({ error: 'Demasiadas subidas desde tu conexión. Inténtalo más tarde.' });

  const links = loadLinks();
  const link = links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Este enlace no existe' });
  if (linkExpired(link)) return res.status(410).json({ error: 'Este enlace ha caducado' });
  if (link.files >= LINK_MAX_FILES) return res.status(429).json({ error: 'Este enlace ha alcanzado su límite de archivos' });
  if (link.bytes >= LINK_MAX_BYTES) return res.status(429).json({ error: 'Este enlace ha alcanzado su límite de tamaño' });

  const owner = ownerOf(link);
  if (!owner) return res.status(410).json({ error: 'Este enlace ya no está disponible' });

  const uploader = makeUploader(
    () => resolveFor(owner, link.path),
    { fileSize: MAX_UPLOAD_BYTES, files: LINK_MAX_FILES }
  );
  uploader.array('files')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    const subidos = req.files || [];
    if (!subidos.length) return res.status(400).json({ error: 'No has adjuntado ningún archivo' });
    // Se releen los enlaces por si cambiaron durante la subida
    const actuales = loadLinks();
    const actual = actuales.find(l => l.id === link.id);
    if (actual) {
      actual.files += subidos.length;
      actual.bytes += subidos.reduce((n, f) => n + f.size, 0);
      actual.lastUploadAt = Date.now();
      saveLinks(actuales);
    }
    res.json({ ok: true, uploaded: subidos.length });
  });
});

// Página pública del enlace
app.get('/u/:id', (req, res) => {
  res.sendFile(path.join(APP_DIR, 'public', 'upload.html'));
});

// --- Descargar archivo ---
// ?as=jpg convierte un HEIC al vuelo; ?as=pdf convierte un documento de Office
// con LibreOffice (reutilizando la misma caché que la vista previa). Sin ?as,
// se descarga el original tal cual.
app.get('/api/download', auth, async (req, res) => {
  try {
    const file = userPath(req, req.query.path);
    const ext = path.extname(file).toLowerCase();
    const as = String(req.query.as || '').toLowerCase();

    if (as === 'jpg' && HEIC_TYPES[ext]) {
      if (!sharp) return res.status(501).json({ error: 'Este servidor no puede convertir HEIC' });
      const buf = await sharp(file, { failOn: 'none' }).rotate().jpeg({ quality: 92 }).toBuffer();
      cabeceraDescarga(res, path.basename(file, ext) + '.jpg');
      registrarActividad(req, 'descarga_convertida', { path: req.query.path, as });
      return res.status(200).type('image/jpeg').send(buf);
    }
    if (as === 'pdf' && OFFICE_RE.test(file)) {
      if (!soffice) return res.status(501).json({ error: 'Este servidor no tiene LibreOffice instalado' });
      const stat = await fsp.stat(file);
      const key = crypto.createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}|office`).digest('hex');
      const cached = path.join(THUMBS_DIR, `${key}.pdf`);
      if (!await exists(cached)) {
        const trabajo = path.join(THUMBS_DIR, `conv-${key}-${process.pid}`);
        await fsp.mkdir(trabajo, { recursive: true });
        try {
          await convertirOffice(file, trabajo);
          const generado = (await fsp.readdir(trabajo)).find(f => f.toLowerCase().endsWith('.pdf'));
          if (!generado) throw new Error('LibreOffice no generó ningún PDF');
          await fsp.rename(path.join(trabajo, generado), cached);
        } finally { fsp.rm(trabajo, { recursive: true, force: true }).catch(() => {}); }
      }
      cabeceraDescarga(res, path.basename(file, ext) + '.pdf');
      registrarActividad(req, 'descarga_convertida', { path: req.query.path, as });
      return res.sendFile(cached, { headers: { 'Content-Type': 'application/pdf' } });
    }

    // Siempre como adjunto y sin tipo interpretable: un .html subido no se ejecuta en el dominio
    res.download(file, path.basename(file), { headers: { 'Content-Type': 'application/octet-stream' } }, err => {
      if (err && !res.headersSent) res.status(404).json({ error: 'No encontrado' });
    });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Previsualización y reproducción ---
// Los navegadores no pintan HEIC, así que se convierte al vuelo. El resto se sirve tal cual:
// el servidor de ficheros de Express ya responde a rangos, y con eso el vídeo se puede saltar.
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
};
const HEIC_TYPES = { '.heic': 'image/heic', '.heif': 'image/heif' };
const VIDEO_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
};
const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac',
};
const PREVIEW_TYPES = { ...IMAGE_TYPES, ...HEIC_TYPES, ...VIDEO_TYPES, ...AUDIO_TYPES, '.pdf': 'application/pdf' };
// Texto plano y código: se devuelven como JSON y el cliente los pinta con textContent
const TEXT_RE = /\.(txt|md|markdown|csv|tsv|log|json|xml|svg|yml|yaml|ini|conf|cfg|toml|env|js|mjs|cjs|ts|jsx|tsx|css|scss|less|html?|php|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|sql|ps1|bat|srt|vtt|gitignore|dockerfile|makefile)$/i;
const TEXT_MAX = Number(process.env.TEXT_MAX || 512 * 1024);
// Lo que LibreOffice sabe convertir a PDF (documentos y presentaciones)
const OFFICE_RE = /\.(docx?|pptx?|odt|odp|rtf|pages|key)$/i;
// Las hojas de cálculo van por otro camino: se leen y se pintan como rejilla,
// porque convertirlas a PDF las pagina y deja de parecer una hoja de cálculo
const SHEET_RE = /\.(xlsx|xlsm|xls|ods|numbers)$/i;
const SHEET_NATIVE_RE = /\.(xlsx|xlsm)$/i;      // lo que exceljs abre directamente
const OFFICE_TIMEOUT = Number(process.env.OFFICE_TIMEOUT || 90000);
const SHEET_MAX_ROWS = Number(process.env.SHEET_MAX_ROWS || 2000);
const SHEET_MAX_COLS = Number(process.env.SHEET_MAX_COLS || 60);

// Mapa de fotos. El servidor de tiles es lo único externo que carga la app, así que
// se declara aquí y de aquí sale el permiso de la CSP: cambiar TILE_URL basta.
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = process.env.TILE_ATTR ||
  '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const TILE_ORIGIN = (() => {
  try { return new URL(TILE_URL.replace(/\{[sxyz]\}/g, '1')).origin; }
  catch { return 'https://tile.openstreetmap.org'; }
})();
const MAP_LIMIT = Number(process.env.MAP_LIMIT || 5000);
const THUMBABLE = { ...IMAGE_TYPES, ...HEIC_TYPES };
const DISPLAY_MAX = Number(process.env.DISPLAY_MAX || 2200);

// Convierte a WebP y cachea; devuelve la ruta del archivo cacheado
async function convertirCache(file, stat, ancho, sufijo) {
  const key = crypto.createHash('sha1')
    .update(`${file}|${stat.size}|${stat.mtimeMs}|${ancho}|${sufijo}`).digest('hex');
  const cached = path.join(THUMBS_DIR, `${key}.webp`);
  if (await exists(cached)) return cached;
  const buf = await sharp(file, { failOn: 'none' })
    .rotate()
    .resize(ancho, ancho, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const tmp = `${cached}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, cached);
  return cached;
}

app.get('/api/preview', auth, async (req, res) => {
  try {
    const file = userPath(req, req.query.path);
    const ext = path.extname(file).toLowerCase();
    const type = PREVIEW_TYPES[ext];
    // Sin esta lista blanca, subir un .html y abrirlo por aquí daría XSS en el propio dominio
    if (!type) return res.status(415).json({ error: 'Este tipo de archivo no se puede previsualizar' });

    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (ext === '.pdf') {
      // Solo la restricción de marco. Nada de default-src 'none': el visor de PDF
      // de Chrome monta un <embed> dentro del propio documento, y esa directiva
      // arrastra object-src 'none', con lo que el visor se bloquea a sí mismo y
      // enseña un recuadro gris. Corre en su propio proceso, sin acceso a la sesión.
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Disposition', 'inline');
      return res.sendFile(file, { headers: { 'Content-Type': 'application/pdf' } }, err => {
        if (err && !res.headersSent) res.status(404).json({ error: 'No encontrado' });
      });
    }

    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    if (HEIC_TYPES[ext]) {
      if (!sharp) return res.status(415).json({ error: 'Este servidor no puede convertir HEIC' });
      const stat = await fsp.stat(file);
      const conv = await convertirCache(file, stat, DISPLAY_MAX, 'view');
      return res.sendFile(conv, { headers: { 'Content-Type': 'image/webp' } });
    }
    res.sendFile(file, { headers: { 'Content-Type': type } }, err => {
      if (err && !res.headersSent) res.status(404).json({ error: 'No encontrado' });
    });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Miniaturas para la cuadrícula ---
// Saca un fotograma del vídeo con ffmpeg y lo deja cacheado
function fotogramaVideo(file, destino) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-loglevel', 'error',
      '-ss', '1',                 // un segundo dentro: el primer fotograma suele ser negro
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=increase,crop=${THUMB_SIZE}:${THUMB_SIZE}`,
      destino,
    ];
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    const temporizador = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('error', err => { clearTimeout(temporizador); reject(err); });
    p.on('close', code => {
      clearTimeout(temporizador);
      if (code === 0) return resolve();
      // Vídeo más corto que un segundo: se reintenta desde el principio
      const p2 = spawn('ffmpeg', args.map(a => (a === '1' ? '0' : a)), { stdio: 'ignore' });
      p2.on('error', reject);
      p2.on('close', c2 => (c2 === 0 ? resolve() : reject(new Error('ffmpeg falló'))));
    });
  });
}

app.get('/api/thumb', auth, async (req, res) => {
  try {
    const file = userPath(req, req.query.path);
    const ext = path.extname(file).toLowerCase();
    const esVideo = !!VIDEO_TYPES[ext];
    const tipo = THUMBABLE[ext];
    if (!tipo && !esVideo) return res.status(415).json({ error: 'Sin miniatura para este tipo' });
    if (esVideo && !ffmpeg) return res.status(415).json({ error: 'Este servidor no tiene ffmpeg' });

    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');

    // Sin sharp la app sigue funcionando: se envía el original, solo que pesa más
    if (!esVideo && !sharp) return res.sendFile(file, { headers: { 'Content-Type': tipo } });

    const stat = await fsp.stat(file);
    // La clave incluye tamaño y mtime: si el archivo cambia, la miniatura se regenera sola
    const key = crypto.createHash('sha1')
      .update(`${file}|${stat.size}|${stat.mtimeMs}|${THUMB_SIZE}|thumb`).digest('hex');
    const cached = path.join(THUMBS_DIR, `${key}.webp`);

    if (!await exists(cached)) {
      const tmp = `${cached}.${process.pid}.tmp`;
      if (esVideo) {
        const tmpImg = `${tmp}.webp`;
        await fotogramaVideo(file, tmpImg);
        await fsp.rename(tmpImg, cached);
      } else {
        const buf = await sharp(file, { failOn: 'none' })
          .rotate() // respeta la orientación EXIF de las fotos de móvil
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
          .webp({ quality: 78 })
          .toBuffer();
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, cached);
      }
    }
    res.sendFile(cached, { headers: { 'Content-Type': 'image/webp' } }, err => {
      if (err && !res.headersSent) res.status(404).json({ error: 'No encontrado' });
    });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Texto plano, Markdown, CSV y código ---
app.get('/api/text', auth, async (req, res) => {
  try {
    const file = userPath(req, req.query.path);
    const base = path.basename(file);
    // Se admite por extensión o por nombre completo (Makefile, Dockerfile…)
    if (!TEXT_RE.test(base) && !/^(makefile|dockerfile|licen[cs]e|readme)$/i.test(base)) {
      return res.status(415).json({ error: 'Este archivo no es de texto' });
    }
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Es una carpeta' });

    // Se lee solo el principio: un log de 2 GB no puede tumbar el servidor
    const leer = Math.min(stat.size, TEXT_MAX);
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(leer);
    try { await fh.read(buf, 0, leer, 0); } finally { await fh.close(); }

    res.json({
      text: buf.toString('utf8'),
      truncated: stat.size > TEXT_MAX,
      size: stat.size,
      shown: leer,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Guardar un archivo de texto editado desde el propio visor
app.put('/api/text', auth, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const file = userPath(req, req.query.path);
    const base = path.basename(file);
    if (!TEXT_RE.test(base) && !/^(makefile|dockerfile|licen[cs]e|readme)$/i.test(base)) {
      return res.status(415).json({ error: 'Este archivo no es de texto' });
    }
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Es una carpeta' });
    const contenido = String(req.body?.text ?? '');
    if (contenido.length > TEXT_MAX) return res.status(400).json({ error: 'Demasiado grande para editar aquí' });
    await fsp.writeFile(file, contenido, 'utf8');
    registrarActividad(req, 'archivo_editado', { path: req.query.path });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Documentos de Office, convertidos a PDF con LibreOffice ---
function convertirOffice(file, salidaDir, formato = 'pdf') {
  return new Promise((resolve, reject) => {
    // Perfil de usuario propio por conversión: sin esto, dos a la vez chocan
    const perfil = path.join(salidaDir, 'perfil');
    const args = [
      '--headless', '--norestore', '--invisible', '--nolockcheck', '--nodefault',
      `-env:UserInstallation=file:///${perfil.replace(/\\/g, '/')}`,
      '--convert-to', formato, '--outdir', salidaDir, file,
    ];
    const p = spawn(soffice, args, { stdio: 'ignore' });
    const temporizador = setTimeout(() => p.kill('SIGKILL'), OFFICE_TIMEOUT);
    p.on('error', err => { clearTimeout(temporizador); reject(err); });
    p.on('close', code => {
      clearTimeout(temporizador);
      code === 0 ? resolve() : reject(new Error('La conversión falló'));
    });
  });
}

app.get('/api/office', auth, async (req, res) => {
  let trabajo = null;
  try {
    const file = userPath(req, req.query.path);
    if (!OFFICE_RE.test(file)) return res.status(415).json({ error: 'Formato no convertible' });
    if (!soffice) return res.status(501).json({ error: 'Este servidor no tiene LibreOffice instalado' });

    const stat = await fsp.stat(file);
    const key = crypto.createHash('sha1')
      .update(`${file}|${stat.size}|${stat.mtimeMs}|office`).digest('hex');
    const cached = path.join(THUMBS_DIR, `${key}.pdf`);

    if (!await exists(cached)) {
      trabajo = path.join(THUMBS_DIR, `conv-${key}-${process.pid}`);
      await fsp.mkdir(trabajo, { recursive: true });
      await convertirOffice(file, trabajo);
      const generado = (await fsp.readdir(trabajo)).find(f => f.toLowerCase().endsWith('.pdf'));
      if (!generado) throw new Error('LibreOffice no generó ningún PDF');
      await fsp.rename(path.join(trabajo, generado), cached);
    }

    // Mismo motivo que en /api/preview: el visor necesita poder montar su <embed>
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(cached, { headers: { 'Content-Type': 'application/pdf' } });
  } catch (err) {
    sendError(res, err);
  } finally {
    if (trabajo) fsp.rm(trabajo, { recursive: true, force: true }).catch(() => {});
  }
});

/* ---------------- Hojas de cálculo ----------------
   Se leen y se devuelven como datos, no como PDF: así el cliente puede pintar
   una rejilla de verdad, con sus columnas, sus filas y sus pestañas de hoja. */

// Convierte el valor de una celda a algo que se pueda enseñar tal cual
function celdaATexto(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return v.getHours() || v.getMinutes()
      ? v.toLocaleString('es-ES')
      : v.toLocaleDateString('es-ES');
  }
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(t => t.text).join('');   // texto con formatos
    if (v.text !== undefined) return String(v.text);               // hipervínculo
    if (v.result !== undefined) return String(v.result);           // fórmula ya calculada
    if (v.formula) return '';                                      // fórmula sin resultado guardado
    if (v.error) return String(v.error);
    return '';
  }
  return String(v);
}
const esNumero = (v) => typeof v === 'number' ||
  (v && typeof v === 'object' && typeof v.result === 'number');

app.get('/api/sheet', auth, async (req, res) => {
  let trabajo = null;
  try {
    const file = userPath(req, req.query.path);
    if (!SHEET_RE.test(file)) return res.status(415).json({ error: 'No es una hoja de cálculo' });

    let aLeer = file;
    // .xls y .ods no los abre exceljs: LibreOffice los pasa antes a xlsx
    if (!SHEET_NATIVE_RE.test(file)) {
      if (!soffice) return res.status(501).json({ error: 'Este formato necesita LibreOffice en el servidor' });
      const stat = await fsp.stat(file);
      const key = crypto.createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}|sheet`).digest('hex');
      const cached = path.join(THUMBS_DIR, `${key}.xlsx`);
      if (!await exists(cached)) {
        trabajo = path.join(THUMBS_DIR, `sheet-${key}-${process.pid}`);
        await fsp.mkdir(trabajo, { recursive: true });
        await convertirOffice(file, trabajo, 'xlsx');
        const generado = (await fsp.readdir(trabajo)).find(f => f.toLowerCase().endsWith('.xlsx'));
        if (!generado) throw new Error('No se pudo leer la hoja');
        await fsp.rename(path.join(trabajo, generado), cached);
      }
      aLeer = cached;
    }

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(aLeer);
    } catch {
      // El mensaje de la librería habla de directorios centrales y de zips: no ayuda a nadie
      return res.status(422).json({ error: 'No se pudo leer la hoja. Puede que el archivo esté dañado.' });
    }

    let recortado = false;
    const hojas = wb.worksheets.map(ws => {
      const totalFilas = Math.min(ws.rowCount || 0, SHEET_MAX_ROWS);
      const totalCols = Math.min(ws.columnCount || 0, SHEET_MAX_COLS);
      if ((ws.rowCount || 0) > totalFilas || (ws.columnCount || 0) > totalCols) recortado = true;

      const filas = [];
      for (let r = 1; r <= totalFilas; r++) {
        const fila = ws.getRow(r);
        const celdas = [];
        for (let c = 1; c <= totalCols; c++) {
          const celda = fila.getCell(c);
          celdas.push({ t: celdaATexto(celda.value), n: esNumero(celda.value) || undefined });
        }
        // Se recorta la cola vacía de cada fila, que en Excel suele ser larga
        while (celdas.length && !celdas[celdas.length - 1].t) celdas.pop();
        filas.push(celdas);
      }
      while (filas.length && !filas[filas.length - 1].length) filas.pop();

      const anchos = [];
      for (let c = 1; c <= totalCols; c++) anchos.push(ws.getColumn(c).width || null);

      return { nombre: ws.name, filas, anchos, filasTotales: ws.rowCount || 0, colsTotales: ws.columnCount || 0 };
    });

    res.json({ hojas, recortado, maxFilas: SHEET_MAX_ROWS, maxCols: SHEET_MAX_COLS });
  } catch (err) {
    sendError(res, err);
  } finally {
    if (trabajo) fsp.rm(trabajo, { recursive: true, force: true }).catch(() => {});
  }
});

/* ---------------- EXIF de las fotos ----------------
   Dos usos: el panel de detalles de una foto, y las fechas de captura con las
   que se agrupan por meses. Lo segundo se cachea, porque leer el EXIF de una
   carpeta con miles de fotos en cada listado sería insufrible. */
const EXIF_CACHE = path.join(THUMBS_DIR, 'exif-cache.json');
let exifCache = null;
let exifCacheSucio = false;

function cargarExifCache() {
  if (exifCache) return exifCache;
  try { exifCache = JSON.parse(fs.readFileSync(EXIF_CACHE, 'utf8')); }
  catch { exifCache = {}; }
  return exifCache;
}
// Se guarda en diferido: un listado de 500 fotos no debe escribir 500 veces
setInterval(() => {
  if (!exifCacheSucio || !exifCache) return;
  exifCacheSucio = false;
  const tmp = `${EXIF_CACHE}.tmp`;
  fs.writeFile(tmp, JSON.stringify(exifCache), err => {
    if (!err) fs.rename(tmp, EXIF_CACHE, () => {});
  });
}, 5000).unref();

const claveExif = (file, stat) => crypto.createHash('sha1')
  .update(`${file}|${stat.size}|${stat.mtimeMs}`).digest('hex');

// Los grados vienen a veces como [g, m, s] y a veces ya en decimal
function aDecimal(valor, ref) {
  let d = valor;
  if (Array.isArray(valor)) d = valor[0] + (valor[1] || 0) / 60 + (valor[2] || 0) / 3600;
  if (typeof d !== 'number' || !isFinite(d)) return null;
  if (ref === 'S' || ref === 'W') d = -d;
  return Math.round(d * 1e6) / 1e6;
}

async function leerExif(file) {
  const exifr = require('exifr');
  const datos = await exifr.parse(file, {
    tiff: true, exif: true, gps: true, ifd0: true,
    pick: ['Make', 'Model', 'LensModel', 'DateTimeOriginal', 'CreateDate', 'ModifyDate',
           'ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'FocalLengthIn35mmFormat',
           'Orientation', 'ExifImageWidth', 'ExifImageHeight', 'Flash', 'WhiteBalance',
           'Software', 'latitude', 'longitude', 'GPSLatitude', 'GPSLatitudeRef',
           'GPSLongitude', 'GPSLongitudeRef', 'GPSAltitude'],
  }).catch(() => null);
  if (!datos) return null;

  const lat = datos.latitude !== undefined
    ? datos.latitude : aDecimal(datos.GPSLatitude, datos.GPSLatitudeRef);
  const lon = datos.longitude !== undefined
    ? datos.longitude : aDecimal(datos.GPSLongitude, datos.GPSLongitudeRef);
  const fecha = datos.DateTimeOriginal || datos.CreateDate || datos.ModifyDate || null;

  return {
    tomada: fecha ? new Date(fecha).getTime() : null,
    camara: [datos.Make, datos.Model].filter(Boolean).join(' ').trim() || null,
    objetivo: datos.LensModel || null,
    exposicion: datos.ExposureTime || null,
    diafragma: datos.FNumber || null,
    iso: datos.ISO || null,
    focal: datos.FocalLength || null,
    focal35: datos.FocalLengthIn35mmFormat || null,
    ancho: datos.ExifImageWidth || null,
    alto: datos.ExifImageHeight || null,
    software: datos.Software || null,
    lat: typeof lat === 'number' && isFinite(lat) ? lat : null,
    lon: typeof lon === 'number' && isFinite(lon) ? lon : null,
    altitud: typeof datos.GPSAltitude === 'number' ? Math.round(datos.GPSAltitude) : null,
  };
}

// Versión cacheada y reducida: solo lo que hace falta para agrupar y para el mapa
async function exifResumido(file, stat) {
  const cache = cargarExifCache();
  const clave = claveExif(file, stat);
  if (cache[clave]) return cache[clave];
  let r = { t: null, lat: null, lon: null };
  try {
    const e = await leerExif(file);
    if (e) r = { t: e.tomada, lat: e.lat, lon: e.lon };
  } catch { /* sin EXIF utilizable */ }
  cache[clave] = r;
  exifCacheSucio = true;
  return r;
}

// EXIF completo de una foto, para el panel de detalles
app.get('/api/exif', auth, async (req, res) => {
  try {
    const file = userPath(req, req.query.path);
    if (!IMAGE_TYPES[path.extname(file).toLowerCase()] && !HEIC_TYPES[path.extname(file).toLowerCase()]) {
      return res.status(415).json({ error: 'Solo las imágenes tienen EXIF' });
    }
    const stat = await fsp.stat(file);
    const datos = await leerExif(file);
    res.json({
      ...(datos || {}),
      nombre: path.basename(file),
      tamano: stat.size,
      modificada: stat.mtimeMs,
      hayExif: !!datos,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Fechas de captura y coordenadas de las fotos de una carpeta, para agrupar
app.get('/api/photometa', auth, async (req, res) => {
  try {
    const rel = req.query.path || '';
    const dir = userPath(req, rel);
    const entradas = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter(e => !isHidden(e.name) && e.isFile() &&
        (IMAGE_TYPES[path.extname(e.name).toLowerCase()] || HEIC_TYPES[path.extname(e.name).toLowerCase()]));

    const salida = {};
    // De cuatro en cuatro: leer 500 EXIF a la vez satura el disco
    for (let i = 0; i < entradas.length; i += 4) {
      const grupo = entradas.slice(i, i + 4);
      await Promise.all(grupo.map(async e => {
        const full = path.join(dir, e.name);
        try {
          const stat = await fsp.stat(full);
          const r = await exifResumido(full, stat);
          salida[e.name] = { t: r.t || stat.mtimeMs, exif: !!r.t, lat: r.lat, lon: r.lon };
        } catch { /* archivo desaparecido */ }
      }));
    }
    res.json({ path: rel, fotos: salida });
  } catch (err) {
    sendError(res, err);
  }
});

// Todas las fotos con coordenadas, recorriendo el árbol entero
app.get('/api/photomap', auth, async (req, res) => {
  try {
    const raiz = userRoot(req.user);
    const fotos = [];
    let conFecha = 0, total = 0, cortado = false;

    async function recorrer(dir, rel) {
      if (fotos.length >= MAP_LIMIT) { cortado = true; return; }
      let entradas;
      try { entradas = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entradas) {
        if (fotos.length >= MAP_LIMIT) { cortado = true; return; }
        if (isHidden(e.name)) continue;
        const full = path.join(dir, e.name);
        const hijoRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { await recorrer(full, hijoRel); continue; }

        const ext = path.extname(e.name).toLowerCase();
        if (!IMAGE_TYPES[ext] && !HEIC_TYPES[ext]) continue;
        total++;
        try {
          const stat = await fsp.stat(full);
          const meta = await exifResumido(full, stat);
          if (meta.lat === null || meta.lon === null) continue;
          if (meta.t) conFecha++;
          fotos.push({ rel: hijoRel, nombre: e.name, lat: meta.lat, lon: meta.lon,
                       t: meta.t || stat.mtimeMs, size: stat.size });
        } catch { /* archivo desaparecido */ }
      }
    }

    await recorrer(raiz, '');
    fotos.sort((a, b) => b.t - a.t);
    res.json({ fotos, total, conCoordenadas: fotos.length, conFecha, cortado, limite: MAP_LIMIT });
  } catch (err) {
    sendError(res, err);
  }
});

// Qué sabe hacer este servidor: el cliente lo usa para no ofrecer lo que no hay
app.get('/api/capabilities', auth, (req, res) => {
  res.json({
    sharp: !!sharp, ffmpeg, office: !!soffice, textMax: TEXT_MAX,
    tileUrl: TILE_URL, tileAttr: TILE_ATTR,
  });
});

// --- Buscar (recursivo desde la carpeta indicada) ---
app.get('/api/search', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ items: [], truncated: false });
    const startRel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const base = userPath(req, startRel);
    const results = [];

    async function walk(dir, rel) {
      if (results.length >= SEARCH_LIMIT) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= SEARCH_LIMIT) return;
        if (isHidden(e.name)) continue;
        const full = path.join(dir, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.name.toLowerCase().includes(q)) {
          try {
            const stat = await fsp.stat(full);
            results.push({
              name: e.name, isDir: stat.isDirectory(), size: stat.size,
              modified: stat.mtime, dir: rel,
            });
          } catch { /* desaparecido a mitad del recorrido */ }
        }
        if (e.isDirectory()) await walk(full, childRel);
      }
    }

    await walk(base, startRel);
    res.json({ items: results, truncated: results.length >= SEARCH_LIMIT });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Eliminar (va a la papelera) ---
app.delete('/api/files', auth, async (req, res) => {
  try {
    await trashItem(req.user, req.query.path);
    registrarActividad(req, 'enviado_papelera', { path: req.query.path });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Operaciones por lotes (mover / eliminar / renombrar varios) ---
app.post('/api/batch', auth, async (req, res) => {
  try {
    const { op, paths, dest, pattern, start } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'No hay nada seleccionado' });
    if (paths.length > BATCH_LIMIT) return res.status(400).json({ error: `Máximo ${BATCH_LIMIT} elementos por operación` });
    if (!['move', 'delete', 'rename'].includes(op)) return res.status(400).json({ error: 'Operación no válida' });

    // Renombrado en lote: patrón con {n} (número de secuencia) y {name} (nombre original sin extensión)
    if (op === 'rename') {
      const pat = String(pattern || '').trim();
      if (!pat) return res.status(400).json({ error: 'Falta el patrón de nombres' });
      const errores = [];
      let hechos = 0;
      const pad = String(paths.length).length;
      let n = Number(start) > 0 ? Math.floor(Number(start)) : 1;
      for (const rel of paths) {
        try {
          const from = userPath(req, rel);
          const stat = await fsp.stat(from);
          const dir = path.dirname(from);
          const ext = stat.isDirectory() ? '' : path.extname(from);
          const nombreOriginal = path.basename(from, ext);
          const numero = String(n).padStart(pad, '0');
          let nuevo = pat.replace(/\{n\}/g, numero).replace(/\{name\}/g, nombreOriginal);
          nuevo = nuevo.replace(/[\\/]/g, '-').trim() || nombreOriginal;
          let to = path.join(dir, nuevo + ext);
          if (to !== from && await exists(to)) to = await freeName(dir, nuevo + ext);
          if (to !== from) await fsp.rename(from, to);
          n++;
          hechos++;
        } catch (e) { errores.push({ path: rel, error: e.message }); }
      }
      registrarActividad(req, 'renombrado_lote', { cantidad: hechos, patron: pat });
      return res.json({ ok: errores.length === 0, done: hechos, errors: errores });
    }

    const errors = [];
    let done = 0;
    // En serie a propósito: el índice de la papelera es un único archivo JSON
    for (const rel of paths) {
      try {
        if (op === 'delete') {
          await trashItem(req.user, rel);
        } else {
          const name = path.basename(String(rel).replace(/\\/g, '/'));
          const from = userPath(req, rel);
          const destDir = userPath(req, dest || '');
          const to = path.join(destDir, name);
          if (from === to) { done++; continue; }
          // Mover una carpeta dentro de sí misma dejaría el árbol inaccesible
          if (to === from || to.startsWith(from + path.sep)) throw new Error('No puedes mover una carpeta dentro de sí misma');
          if (await exists(to)) throw new Error(`Ya existe "${name}" en el destino`);
          await fsp.mkdir(destDir, { recursive: true });
          await fsp.rename(from, to);
        }
        done++;
      } catch (e) {
        errors.push({ path: rel, error: e.message });
      }
    }
    if (done) registrarActividad(req, op === 'delete' ? 'enviado_papelera_lote' : 'movido_lote', { cantidad: done });
    res.json({ ok: errors.length === 0, done, errors });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Papelera ---
app.get('/api/trash', auth, async (req, res) => {
  try {
    const entries = await purgeExpired(req.user);
    res.json({ items: entries, ttlDays: TRASH_TTL_DAYS });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/trash/restore', auth, async (req, res) => {
  try {
    const { id } = req.body || {};
    const entries = await readTrash(req.user);
    const entry = entries.find(e => e.id === id);
    if (!entry) return res.status(404).json({ error: 'No está en la papelera' });

    const destDir = resolveFor(req.user, entry.from);
    await fsp.mkdir(destDir, { recursive: true });
    const target = await freeName(destDir, entry.name);
    await fsp.rename(path.join(trashRoot(req.user), entry.id), target);
    await writeTrash(req.user, entries.filter(e => e.id !== id));
    registrarActividad(req, 'restaurado_papelera', { name: entry.name });
    res.json({ ok: true, restoredAs: path.basename(target) });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/trash/:id', auth, async (req, res) => {
  try {
    const entries = await readTrash(req.user);
    const entry = entries.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'No está en la papelera' });
    await fsp.rm(path.join(trashRoot(req.user), entry.id), { recursive: true, force: true });
    await writeTrash(req.user, entries.filter(e => e.id !== entry.id));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/trash', auth, async (req, res) => {
  try {
    const entries = await readTrash(req.user);
    for (const e of entries) {
      await fsp.rm(path.join(trashRoot(req.user), e.id), { recursive: true, force: true });
    }
    await writeTrash(req.user, []);
    res.json({ ok: true, removed: entries.length });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Renombrar / mover ---
app.post('/api/move', auth, async (req, res) => {
  try {
    const from = userPath(req, req.body?.from);
    const to = userPath(req, req.body?.to);
    if (from === to) return res.json({ ok: true });
    // rename() machaca el destino en silencio: comprobarlo antes evita perder archivos
    try {
      await fsp.access(to);
      return res.status(409).json({ error: 'Ya existe un archivo con ese nombre' });
    } catch { /* destino libre, seguimos */ }
    await fsp.rename(from, to);
    registrarActividad(req, 'renombrado', { from: req.body?.from, to: req.body?.to });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/* ---------------- Favoritos ----------------
   Solo una lista de rutas por usuario: marcar y quitar tiene que ser instantáneo,
   así que no hace falta nada más elaborado que un JSON pequeño. */
const favFile = (user) => path.join(userRoot(user), '.favorites.json');
async function readFavs(user) {
  try { return JSON.parse(await fsp.readFile(favFile(user), 'utf8')); } catch { return []; }
}
async function writeFavs(user, list) {
  const file = favFile(user);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list));
  await fsp.rename(tmp, file);
}
app.get('/api/favorites', auth, async (req, res) => {
  try {
    const favs = await readFavs(req.user);
    const vivos = [];
    for (const rel of favs) {
      try { await fsp.access(resolveFor(req.user, rel)); vivos.push(rel); } catch { /* ya no existe: se depura */ }
    }
    if (vivos.length !== favs.length) await writeFavs(req.user, vivos);
    res.json({ items: vivos });
  } catch (err) { sendError(res, err); }
});
app.post('/api/favorites', auth, async (req, res) => {
  try {
    const rel = String(req.body?.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    resolveFor(req.user, rel);       // valida que es suya y que existe
    const favs = await readFavs(req.user);
    if (!favs.includes(rel)) favs.unshift(rel);
    await writeFavs(req.user, favs);
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});
app.delete('/api/favorites', auth, async (req, res) => {
  try {
    const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const favs = await readFavs(req.user);
    await writeFavs(req.user, favs.filter(f => f !== rel));
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

/* ---------------- Álbumes ----------------
   Colecciones con nombre que apuntan a fotos por ruta, sin moverlas: la misma
   foto puede estar en varios álbumes y seguir viviendo en una sola carpeta. */
function albumsFile(user) {
  const dir = path.join(userRoot(user), ALBUMS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'index.json');
}
async function readAlbums(user) {
  try { return JSON.parse(await fsp.readFile(albumsFile(user), 'utf8')); } catch { return []; }
}
async function writeAlbums(user, list) {
  const file = albumsFile(user);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
  await fsp.rename(tmp, file);
}
app.get('/api/albums', auth, async (req, res) => {
  try {
    const albums = await readAlbums(req.user);
    res.json({ items: albums.map(a => ({ id: a.id, title: a.title, createdAt: a.createdAt, count: a.items.length })) });
  } catch (err) { sendError(res, err); }
});
app.post('/api/albums', auth, async (req, res) => {
  try {
    const albums = await readAlbums(req.user);
    if (albums.length >= ALBUM_LIMIT) return res.status(400).json({ error: `Máximo ${ALBUM_LIMIT} álbumes` });
    const album = {
      id: crypto.randomBytes(8).toString('hex'),
      title: String(req.body?.title || '').slice(0, 80) || 'Álbum sin título',
      createdAt: Date.now(),
      items: [].concat(req.body?.paths || []).map(r => String(r).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')),
    };
    for (const r of album.items) resolveFor(req.user, r);   // valida cada ruta antes de guardar
    albums.unshift(album);
    await writeAlbums(req.user, albums);
    res.json({ ok: true, album: { id: album.id, title: album.title, createdAt: album.createdAt, count: album.items.length } });
  } catch (err) { sendError(res, err); }
});
app.get('/api/albums/:id', auth, async (req, res) => {
  try {
    const albums = await readAlbums(req.user);
    const album = albums.find(a => a.id === req.params.id);
    if (!album) return res.status(404).json({ error: 'No encontrado' });
    const items = [];
    for (const rel of album.items) {
      try {
        const abs = resolveFor(req.user, rel);
        const stat = await fsp.stat(abs);
        items.push({ name: path.basename(abs), rel, isDir: stat.isDirectory(), size: stat.size, modified: stat.mtime });
      } catch { /* se dejó de poder alcanzar: se ignora, no se borra del álbum por si vuelve */ }
    }
    res.json({ id: album.id, title: album.title, items });
  } catch (err) { sendError(res, err); }
});
app.put('/api/albums/:id', auth, async (req, res) => {
  try {
    const albums = await readAlbums(req.user);
    const album = albums.find(a => a.id === req.params.id);
    if (!album) return res.status(404).json({ error: 'No encontrado' });
    if (req.body?.title !== undefined) album.title = String(req.body.title).slice(0, 80) || album.title;
    await writeAlbums(req.user, albums);
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});
app.delete('/api/albums/:id', auth, async (req, res) => {
  try {
    const albums = await readAlbums(req.user);
    await writeAlbums(req.user, albums.filter(a => a.id !== req.params.id));
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});
app.post('/api/albums/:id/items', auth, async (req, res) => {
  try {
    const albums = await readAlbums(req.user);
    const album = albums.find(a => a.id === req.params.id);
    if (!album) return res.status(404).json({ error: 'No encontrado' });
    const rutas = [].concat(req.body?.paths || []).map(r => String(r).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
    for (const r of rutas) {
      resolveFor(req.user, r);
      if (!album.items.includes(r)) album.items.push(r);
    }
    album.items = album.items.slice(0, ALBUM_ITEMS_LIMIT);
    await writeAlbums(req.user, albums);
    res.json({ ok: true, count: album.items.length });
  } catch (err) { sendError(res, err); }
});
app.delete('/api/albums/:id/items', auth, async (req, res) => {
  try {
    const albums = await readAlbums(req.user);
    const album = albums.find(a => a.id === req.params.id);
    if (!album) return res.status(404).json({ error: 'No encontrado' });
    const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    album.items = album.items.filter(i => i !== rel);
    await writeAlbums(req.user, albums);
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

/* ---------------- Buscador de duplicados ----------------
   Primero se agrupa por tamaño (gratis, ya se recorre el árbol) y solo se
   calcula el hash de los que comparten tamaño con otro: es lo que hace viable
   pasarlo por una nube con miles de archivos sin tardar minutos. */
app.get('/api/duplicates', auth, async (req, res) => {
  try {
    const raiz = userRoot(req.user);
    const porTamano = new Map();
    let escaneados = 0, cortado = false;

    async function recorrer(dir, rel) {
      if (cortado) return;
      let entradas;
      try { entradas = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entradas) {
        if (cortado) return;
        if (isHidden(e.name)) continue;
        const full = path.join(dir, e.name);
        const hijoRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { await recorrer(full, hijoRel); continue; }
        if (++escaneados > DUP_LIMIT) { cortado = true; return; }
        try {
          const stat = await fsp.stat(full);
          if (!stat.size) continue;
          if (!porTamano.has(stat.size)) porTamano.set(stat.size, []);
          porTamano.get(stat.size).push({ abs: full, rel: hijoRel, size: stat.size, modified: stat.mtime });
        } catch { /* desaparecido a mitad del recorrido */ }
      }
    }
    await recorrer(raiz, '');

    const candidatos = [...porTamano.values()].filter(g => g.length > 1).flat();
    const porHash = new Map();
    for (const f of candidatos) {
      try {
        const hash = await new Promise((resolve, reject) => {
          const h = crypto.createHash('sha1');
          fs.createReadStream(f.abs).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
        });
        if (!porHash.has(hash)) porHash.set(hash, []);
        porHash.get(hash).push({ rel: f.rel, name: path.basename(f.abs), size: f.size, modified: f.modified });
      } catch { /* archivo ilegible: se ignora en vez de tumbar todo el escaneo */ }
    }
    const grupos = [...porHash.values()].filter(g => g.length > 1)
      .sort((a, b) => (b[0].size * b.length) - (a[0].size * a.length));
    const espacioRecuperable = grupos.reduce((n, g) => n + g[0].size * (g.length - 1), 0);
    res.json({ grupos, espacioRecuperable, escaneados, cortado });
  } catch (err) { sendError(res, err); }
});

/* ---------------- Analizador de espacio por carpeta ----------------
   Reparto de tamaños de lo que hay DENTRO de una carpeta (un nivel), con el
   tamaño de cada subcarpeta ya sumado recursivamente: sirve para encontrar
   qué está llenando el disco sin tener que adivinarlo por tipo de archivo.
   Dos cuidados que la primera versión no tenía y que en un almacén grande
   sí se notan: un tope de archivos examinados (si no, una carpeta enorme
   podía agotar los descriptores de archivo o tardar minutos) y concurrencia
   limitada al sumar las subcarpetas del nivel, en vez de lanzarlas todas
   a la vez con Promise.all. */
const DU_LIMIT = Number(process.env.DU_LIMIT || 200000);

async function tamanoDir(p, contador) {
  let total = 0, entradas;
  if (contador.cortado) return 0;
  try { entradas = await fsp.readdir(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of entradas) {
    if (isHidden(e.name)) continue;
    if (++contador.n > DU_LIMIT) { contador.cortado = true; return total; }
    const full = path.join(p, e.name);
    try { total += e.isDirectory() ? await tamanoDir(full, contador) : (await fsp.stat(full)).size; }
    catch { /* desaparecido a mitad del recorrido */ }
  }
  return total;
}
app.get('/api/diskusage', auth, async (req, res) => {
  try {
    const rel = req.query.path || '';
    const dir = userPath(req, rel);
    const entradas = (await fsp.readdir(dir, { withFileTypes: true })).filter(e => !isHidden(e.name));
    const contador = { n: 0, cortado: false };
    const items = [];
    // De cuatro en cuatro: sumar todas las subcarpetas del nivel a la vez agota
    // los descriptores de archivo en un almacén con muchas carpetas grandes.
    for (let i = 0; i < entradas.length; i += 4) {
      const grupo = entradas.slice(i, i + 4);
      const parciales = await Promise.all(grupo.map(async e => {
        const full = path.join(dir, e.name);
        try {
          const stat = await fsp.stat(full);
          const size = stat.isDirectory() ? await tamanoDir(full, contador) : stat.size;
          return { name: e.name, isDir: stat.isDirectory(), size };
        } catch { return null; }
      }));
      items.push(...parciales.filter(Boolean));
    }
    items.sort((a, b) => b.size - a.size);
    res.json({
      path: rel, items, total: items.reduce((n, i) => n + i.size, 0),
      cortado: contador.cortado,
    });
  } catch (err) { sendError(res, err); }
});

/* ---------------- Bloc de notas ----------------
   Índice con la estructura (lista plana con punteros al padre, que admite
   cualquier anidamiento) y el cuerpo de cada nota en su propio .md, para que
   una nota larga no engorde el índice y siga siendo texto recuperable a mano. */
function notesRoot(user) {
  const dir = path.join(userRoot(user), NOTES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function readNotes(user) {
  try { return JSON.parse(await fsp.readFile(path.join(notesRoot(user), 'index.json'), 'utf8')); }
  catch { return { items: [] }; }
}
async function writeNotes(user, data) {
  const file = path.join(notesRoot(user), 'index.json');
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}
const notaFile = (user, id) => path.join(notesRoot(user), `${id}.md`);
function descendientes(items, id) {
  const hijos = items.filter(i => i.parent === id);
  return hijos.reduce((acc, h) => acc.concat(h, descendientes(items, h.id)), []);
}
function padreValido(items, parent) {
  if (!parent) return true;                       // raíz
  const p = items.find(i => i.id === parent);
  return !!p && p.type === 'folder';
}

app.get('/api/notes', auth, async (req, res) => {
  try { res.json(await readNotes(req.user)); }
  catch (err) { sendError(res, err); }
});

app.get('/api/notes/:id', auth, async (req, res) => {
  try {
    const data = await readNotes(req.user);
    const item = data.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'No encontrada' });
    let body = '';
    if (item.type === 'note') {
      try { body = await fsp.readFile(notaFile(req.user, item.id), 'utf8'); } catch {}
    }
    res.json({ ...item, body });
  } catch (err) { sendError(res, err); }
});

app.post('/api/notes', auth, async (req, res) => {
  try {
    const { type, title, parent } = req.body || {};
    if (type !== 'note' && type !== 'folder') return res.status(400).json({ error: 'Tipo no válido' });
    const data = await readNotes(req.user);
    if (!padreValido(data.items, parent || '')) return res.status(400).json({ error: 'Carpeta padre no válida' });
    if (data.items.length >= NOTES_LIMIT) return res.status(400).json({ error: `Máximo ${NOTES_LIMIT} elementos` });

    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      type,
      title: String(title || '').slice(0, 120) || (type === 'folder' ? 'Nueva carpeta' : 'Nota sin título'),
      parent: parent || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    data.items.push(item);
    if (type === 'note') await fsp.writeFile(notaFile(req.user, item.id), '');
    await writeNotes(req.user, data);
    res.json({ ok: true, item });
  } catch (err) { sendError(res, err); }
});

// Cuerpo grande solo aquí: el resto de la API sigue con el tope de 100 kB
const notesBody = express.json({ limit: '2mb' });

async function actualizarNota(req, res) {
  try {
    const { title, body, parent } = req.body || {};
    const data = await readNotes(req.user);
    const item = data.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'No encontrada' });

    if (parent !== undefined) {
      if (!padreValido(data.items, parent)) return res.status(400).json({ error: 'Carpeta padre no válida' });
      // Mover una carpeta dentro de sí misma o de un hijo suyo dejaría el árbol suelto
      if (parent === item.id || descendientes(data.items, item.id).some(d => d.id === parent)) {
        return res.status(400).json({ error: 'No puedes mover una carpeta dentro de sí misma' });
      }
      item.parent = parent;
    }
    if (title !== undefined) item.title = String(title).slice(0, 120);
    if (body !== undefined && item.type === 'note') {
      if (String(body).length > NOTE_MAX_CHARS) return res.status(400).json({ error: 'Nota demasiado larga' });
      await fsp.writeFile(notaFile(req.user, item.id), String(body));
      item.chars = String(body).length;
    }
    item.updatedAt = Date.now();
    await writeNotes(req.user, data);
    res.json({ ok: true, item });
  } catch (err) { sendError(res, err); }
}

app.put('/api/notes/:id', auth, notesBody, actualizarNota);
// Alias en POST: sendBeacon (el guardado al cerrar la pestaña) solo sabe hacer POST
app.post('/api/notes/:id', auth, notesBody, actualizarNota);

// Los .md de las notas eliminadas se guardan aparte hasta que caduquen
const notaTrashFile = (user, id) => path.join(notesRoot(user), 'trash', `${id}.md`);

app.delete('/api/notes/:id', auth, async (req, res) => {
  try {
    const data = await readNotes(req.user);
    const item = data.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'No encontrada' });

    const fuera = [item, ...descendientes(data.items, item.id)];
    await fsp.mkdir(path.join(notesRoot(req.user), 'trash'), { recursive: true });
    const cuando = Date.now();
    data.trash = data.trash || [];
    for (const f of fuera) {
      if (f.type === 'note') {
        try { await fsp.rename(notaFile(req.user, f.id), notaTrashFile(req.user, f.id)); } catch {}
      }
      // Se guarda el grupo entero para poder restaurar la rama completa de una vez
      data.trash.unshift({ ...f, deletedAt: cuando, grupo: item.id });
    }
    const ids = new Set(fuera.map(f => f.id));
    data.items = data.items.filter(i => !ids.has(i.id));
    await writeNotes(req.user, data);
    res.json({ ok: true, borrados: fuera.length });
  } catch (err) { sendError(res, err); }
});

async function purgarNotasCaducadas(user) {
  const data = await readNotes(user);
  const corte = Date.now() - TRASH_TTL_DAYS * 86400000;
  const caducadas = (data.trash || []).filter(t => t.deletedAt < corte);
  if (!caducadas.length) return data;
  for (const t of caducadas) {
    if (t.type === 'note') await fsp.rm(notaTrashFile(user, t.id), { force: true });
  }
  data.trash = (data.trash || []).filter(t => t.deletedAt >= corte);
  await writeNotes(user, data);
  return data;
}

app.get('/api/notes-trash', auth, async (req, res) => {
  try {
    const data = await purgarNotasCaducadas(req.user);
    res.json({ items: data.trash || [], ttlDays: TRASH_TTL_DAYS });
  } catch (err) { sendError(res, err); }
});

app.post('/api/notes-trash/restore', auth, async (req, res) => {
  try {
    const { id } = req.body || {};
    const data = await readNotes(req.user);
    const entrada = (data.trash || []).find(t => t.id === id);
    if (!entrada) return res.status(404).json({ error: 'No está en la papelera' });

    // Se restaura el grupo entero: una carpeta sin sus hijos no sirve de nada
    const grupo = (data.trash || []).filter(t => t.grupo === entrada.grupo);
    const idsVivos = new Set(data.items.map(i => i.id));
    for (const t of grupo) {
      if (t.type === 'note') {
        try { await fsp.rename(notaTrashFile(req.user, t.id), notaFile(req.user, t.id)); } catch {}
      }
      const { deletedAt, grupo: g, ...limpio } = t;
      // Si su carpeta padre ya no existe, vuelve a la raíz en vez de quedar huérfana
      if (limpio.parent && !idsVivos.has(limpio.parent) && !grupo.some(x => x.id === limpio.parent)) {
        limpio.parent = '';
      }
      data.items.push(limpio);
      idsVivos.add(limpio.id);
    }
    const ids = new Set(grupo.map(t => t.id));
    data.trash = (data.trash || []).filter(t => !ids.has(t.id));
    await writeNotes(req.user, data);
    res.json({ ok: true, restaurados: grupo.length });
  } catch (err) { sendError(res, err); }
});

app.delete('/api/notes-trash/:id', auth, async (req, res) => {
  try {
    const data = await readNotes(req.user);
    const entrada = (data.trash || []).find(t => t.id === req.params.id);
    if (!entrada) return res.status(404).json({ error: 'No está en la papelera' });
    const grupo = (data.trash || []).filter(t => t.grupo === entrada.grupo);
    for (const t of grupo) {
      if (t.type === 'note') await fsp.rm(notaTrashFile(req.user, t.id), { force: true });
    }
    const ids = new Set(grupo.map(t => t.id));
    data.trash = (data.trash || []).filter(t => !ids.has(t.id));
    await writeNotes(req.user, data);
    res.json({ ok: true, borrados: grupo.length });
  } catch (err) { sendError(res, err); }
});

app.delete('/api/notes-trash', auth, async (req, res) => {
  try {
    const data = await readNotes(req.user);
    for (const t of data.trash || []) {
      if (t.type === 'note') await fsp.rm(notaTrashFile(req.user, t.id), { force: true });
    }
    const n = (data.trash || []).length;
    data.trash = [];
    await writeNotes(req.user, data);
    res.json({ ok: true, removed: n });
  } catch (err) { sendError(res, err); }
});

// --- Estadísticas de almacenamiento ---
app.get('/api/stats', auth, async (req, res) => {
  try {
    // Recorrido asíncrono: con readdirSync el panel de admin bloqueaba el proceso entero
    const byType = { image: { bytes: 0, count: 0 }, video: { bytes: 0, count: 0 },
                     audio: { bytes: 0, count: 0 }, doc: { bytes: 0, count: 0 },
                     other: { bytes: 0, count: 0 } };
    async function walk(dir) {
      let total = 0, count = 0;
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (isHidden(e.name)) continue; // la papelera se contabiliza aparte
        const full = path.join(dir, e.name);
        try {
          if (e.isDirectory()) {
            const r = await walk(full);
            total += r.total; count += r.count;
          } else {
            const size = (await fsp.stat(full)).size;
            total += size; count++;
            const t = byType[typeOf(e.name)];
            t.bytes += size; t.count++;
          }
        } catch { /* archivo desaparecido a mitad del recorrido */ }
      }
      return { total, count };
    }
    const { total, count } = await walk(userRoot(req.user));
    const payload = { totalBytes: total, fileCount: count, byType };
    try {
      if (fsp.statfs) {
        const disk = await fsp.statfs(DATA_ROOT);
        payload.diskTotal = disk.blocks * disk.bsize;
        payload.diskFree = disk.bavail * disk.bsize;
      }
    } catch { /* statfs no disponible en este Node */ }
    res.json(payload);
  } catch (err) {
    sendError(res, err);
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(APP_DIR, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`KookyeCatCloud escuchando en puerto ${PORT}, datos en ${DATA_ROOT}`));
