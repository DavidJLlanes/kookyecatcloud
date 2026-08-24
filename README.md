# KookyeCatCloud

Servidor de archivos y backup de fotos autoalojado. Node + Express por detrás,
PWA sin dependencias por delante.

Licencia [MIT](LICENSE): úsalo, modifícalo o redistribúyelo libremente, con o sin fines
comerciales, siempre que mantengas el aviso de copyright.

## Arrancar en local

```bash
npm install
INSECURE_COOKIES=1 DATA_DIR=./storage npm start
```

Abre `http://localhost:4000`. En el primer arranque se crea el usuario `admin` y su
contraseña se imprime **una sola vez** en la consola; cámbiala desde la pestaña **Cuenta**.

`INSECURE_COOKIES=1` es necesario en local porque la cookie de sesión lleva el flag
`Secure` y el navegador la descartaría sobre `http://`.

## Despliegue en el VPS

```bash
cd /opt/filecloud
npm ci --omit=dev
cp .env.example .env      # y rellena JWT_SECRET con: openssl rand -hex 32
```

### systemd — `/etc/systemd/system/filecloud.service`

El servicio corre con un usuario del sistema sin privilegios, no con `root`:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin filecloud
mkdir -p /data/storage
chown -R filecloud:filecloud /data/storage /opt/filecloud
```

```ini
[Unit]
Description=KookyeCatCloud
After=network.target

[Service]
Type=simple
User=filecloud
WorkingDirectory=/opt/filecloud
EnvironmentFile=/opt/filecloud/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/data/storage /opt/filecloud

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` deja todo el sistema de archivos en solo lectura salvo lo indicado en
`ReadWritePaths`: si cambias `DATA_DIR` en el `.env` a una ruta distinta de `/data/storage`,
actualiza también esta línea o el servicio no podrá escribir ahí.

```bash
systemctl daemon-reload && systemctl enable --now filecloud
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name tu-dominio.com;

    ssl_certificate     /etc/letsencrypt/live/tu-dominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tu-dominio.com/privkey.pem;

    # Las subidas llegan hasta 5 GB: sin esto Nginx corta en 1 MB
    client_max_body_size 5G;
    proxy_read_timeout 600s;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name tu-dominio.com;
    return 301 https://$host$request_uri;
}
```

`X-Forwarded-For` importa: el servidor tiene `trust proxy` activado y el limitador de
intentos de login usa la IP real del cliente.

## Miniaturas

La cuadrícula de fotos pide `/api/thumb`, que genera un WebP de 480 px con **sharp** y lo
cachea en `.thumbs/` (fuera de `DATA_DIR`, para que no aparezca en los listados). La clave de
caché incluye tamaño y `mtime`, así que al reemplazar una foto su miniatura se regenera sola.

`sharp` está declarado como dependencia **opcional** y necesita **Node ≥ 20.9**. Si no se
instala, la app sigue funcionando: la cuadrícula muestra las imágenes originales, solo que
descargando muchos más bytes. Para comprobarlo:

```bash
node -e "console.log(require('sharp').versions)"
```

La caché se puede borrar en cualquier momento, se reconstruye sola:

```bash
rm -rf /opt/filecloud/.thumbs/*
```

## Multimedia

| Formato | Miniatura | Reproducción |
|---|---|---|
| Imágenes (jpg, png, webp, gif, bmp, avif) | sharp | directa |
| **HEIC/HEIF** (fotos de iPhone) | sharp | convertida a WebP al vuelo y cacheada |
| **Vídeo** (mp4, mov, mkv, webm, m4v, ogv) | fotograma con ffmpeg | `<video>` con salto por rangos |
| **Audio** (mp3, m4a, flac, wav, ogg, opus, aac) | — (distintivo) | `<audio>` |

El salto en el vídeo funciona porque el servidor de ficheros de Express ya responde `206 Partial
Content`. Para las miniaturas de vídeo hace falta ffmpeg en el servidor:

```bash
apt install ffmpeg
```

Sin él, los vídeos salen con su distintivo de color y todo lo demás sigue igual. `DISPLAY_MAX`
(2200 px por defecto) limita el tamaño de la conversión HEIC para pantalla.

## Fotos: agrupación y EXIF

El botón del calendario, junto al selector de vista, agrupa por **mes y año** con una cabecera por
grupo; el año se destaca solo cuando cambia. Se vuelve a "todas seguidas" con el mismo botón, y la
preferencia se recuerda en el dispositivo. Las carpetas van en su propio grupo, arriba.

La fecha que manda es la de **captura del EXIF**, no la del archivo: subir hoy una foto de 2019 no
debe colocarla en el mes actual. Si una foto no trae EXIF, se usa su fecha de archivo.

Leer el EXIF de cientos de fotos en cada listado sería insufrible, así que `GET /api/photometa`
cachea fecha y coordenadas en `.thumbs/exif-cache.json`, con la misma clave que las miniaturas
(ruta + tamaño + mtime). La primera vez tarda; después responde en milisegundos. La rejilla se
pinta antes de pedirlas y se reordena cuando llegan.

En el visor, el botón de información abre el panel de detalles de la foto: fecha, cámara, objetivo,
exposición (0,004 s se muestra como 1/250), diafragma, ISO, focal, dimensiones y software. Si la
foto guarda coordenadas, aparece un enlace a **Google Maps** y las coordenadas en decimal.

Se lee con **exifr** (sin dependencias propias). Esa misma caché de coordenadas es la que
aprovecha el mapa de fotos (siguiente sección) para no releer el EXIF de todo el árbol.

## Zonas seguras en móvil

La app declara `viewport-fit=cover` y barra de estado translúcida, así que el contenido llega
hasta los bordes físicos de la pantalla. Para que no quede **debajo** de la barra de estado o de
la barra de gestos, los márgenes salen de cuatro variables:

```css
--safe-top: env(safe-area-inset-top, 0px);
--safe-bottom: env(safe-area-inset-bottom, 0px);
--safe-left / --safe-right
```

Se usan en la cabecera (que crece lo que ocupe la barra de estado), la pantalla de entrada, el
visor, las ventanas, el panel de detalles, las barras flotantes y la navegación inferior. En un
equipo sin muesca valen 0 y no cambia nada.

Van por variable y no por `env()` suelto a propósito: así se pueden **simular** en una prueba
—redefiniéndolas a 47 px— y medir si algo se solapa, que es como se verificó.

El botón de cerrar del visor mide 48×48 en móvil, va destacado sobre el resto y nunca lo tapa el
nombre del archivo, por largo que sea.

## Mapa de fotos

Pestaña **Mapa** con las fotos que guardan coordenadas, sobre Leaflet + OpenStreetMap.

Leaflet va **alojado aquí** (`public/vendor/leaflet/`, 185 KB): ningún CDN. Lo único que sale
fuera son los tiles del mapa, y por eso `img-src` de la CSP incluye el servidor de tiles —es la
única excepción de toda la aplicación. Se cambia de proveedor con `TILE_URL` y `TILE_ATTR`, y el
permiso de la CSP se deriva solo de esa URL.

Los puntos cercanos se agrupan en círculos con el número de fotos; al acercar se separan. La
agrupación es propia, por rejilla, para no añadir otra librería. El globo muestra miniatura,
nombre, fecha y carpeta, con un botón que abre la foto en el visor, navegando por todas las
fotos ubicadas ordenadas por fecha.

`GET /api/photomap` recorre el árbol entero reutilizando la caché de EXIF, así que la segunda
vez es inmediato. Tope de `MAP_LIMIT` (5000) fotos.

Sobre privacidad: tus fotos y tus coordenadas **no** salen de tu servidor. El servidor de tiles
solo sabe qué cuadrantes del mapa pides, como cualquier mapa web.

## Visor de documentos

| Tipo | Cómo se muestra |
|---|---|
| **PDF** | visor propio del navegador, en un marco |
| **Markdown** | intérprete propio (ver abajo) |
| **Texto y código** (txt, json, log, js, css, py, yml…) | monoespaciado, con tope de `TEXT_MAX` |
| **CSV / TSV** | tabla, hasta 500 filas |
| **Hojas de cálculo** (xlsx, xlsm, xls, ods) | rejilla de verdad: columnas, filas y pestañas de hoja |
| **Documentos y presentaciones** (docx, doc, pptx, ppt, odt, odp, rtf) | convertidos a PDF con LibreOffice y cacheados |

Las hojas de cálculo **no** se convierten a PDF: eso las pagina y dejan de parecer una hoja.
Se leen con **exceljs** y se devuelven como datos, y el cliente pinta la rejilla con letras de columna,
números de fila, cabeceras fijas al desplazar y una pestaña por hoja. Solo lectura. Se muestran los
valores ya calculados de las fórmulas, las fechas en formato español y los anchos de columna del
original. Topes: `SHEET_MAX_ROWS` (2000) y `SHEET_MAX_COLS` (60), con aviso si se recorta.

Los `.xls` y `.ods` antiguos no los abre exceljs: LibreOffice los pasa a xlsx primero y el
resultado queda cacheado.

Para los documentos de Office hace falta LibreOffice en el servidor:

```bash
apt install -y libreoffice --no-install-recommends
```

Sin él, esos archivos muestran un aviso claro y el botón de descarga; todo lo demás funciona igual.
Cada conversión usa un perfil de usuario propio (`-env:UserInstallation`) porque dos LibreOffice
a la vez con el mismo perfil chocan. `GET /api/capabilities` dice qué hay disponible, y el cliente
lo usa para no prometer una vista previa que no existe.

El intérprete de Markdown es propio y **devuelve nodos del DOM, nunca cadenas de HTML**: un archivo
que contenga `<script>` se ve como texto, no se ejecuta. Cubre encabezados, negrita, cursiva,
tachado, código en línea y en bloque, listas con un nivel de anidado, citas, reglas, tablas y
enlaces (solo `http`, `https` y `mailto`, con `rel="noopener noreferrer"`).

De los archivos grandes solo se lee el principio (`TEXT_MAX`, 512 kB por defecto): un log de 2 GB
no puede tumbar el servidor. El visor avisa de que está recortado.

Nota sobre el PDF: se sirve **sin** la directiva `sandbox` que llevan las demás vistas previas,
porque el visor del navegador no arranca dentro de un documento aislado. Corre en su propio
proceso y no tiene acceso a la sesión.

## WebDAV

`https://tu-dominio.com/dav/` con tu usuario y contraseña de siempre. Cada uno ve su propia
raíz, igual que en la web, y las carpetas internas (`.trash`, `.notes`) quedan fuera.

- **Windows** — Explorador → Este equipo → Conectar a unidad de red
- **macOS** — Finder → Ir → Conectarse al servidor (⌘K)
- **Android** — FolderSync o similar, para que el móvil suba las fotos solo

Métodos: OPTIONS, PROPFIND, GET/HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPPATCH y LOCK/UNLOCK.
Los bloqueos son simbólicos: se conceden y se recuerdan pero no impiden nada. Se anuncian porque
sin ellos Windows monta la unidad en solo lectura.

Va montado **antes** del analizador de JSON a propósito: si no, un cliente que suba un `.json`
con `Content-Type: application/json` haría que Express se comiera el cuerpo y el PUT escribiera
un archivo vacío. La comprobación de contraseña con bcrypt se cachea 5 minutos porque montar una
unidad dispara decenas de peticiones seguidas.

Dos cosas de Windows que conviene saber: exige HTTPS con certificado válido para autenticación
básica (aquí lo hay), y trae un límite de 50 MB por descarga que se sube en el registro
(`HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\FileSizeLimitInBytes`).

## Bloc de notas

Carpetas anidadas sin límite de profundidad y notas de texto, con autoguardado. Vive en
`<carpeta del usuario>/.notes/`: la estructura en `index.json` y el cuerpo de cada nota en su
propio `.md`, así una nota larga no engorda el índice y el contenido sigue siendo texto plano
recuperable a mano. No aparece en el explorador ni en WebDAV.

Las notas eliminadas van a `.notes/trash/` y se restauran con su rama entera: borrar una carpeta
y recuperarla devuelve sus subcarpetas y sus notas con el contenido intacto. Caducan a los mismos
`TRASH_TTL_DAYS` que los archivos.

`NOTES_LIMIT` (5000) topa el número de elementos y `NOTE_MAX_CHARS` (500 000) el tamaño de una
nota. Las rutas de notas aceptan hasta 2 MB de cuerpo, frente a los 100 kB del resto de la API.

## Papelera

`DELETE /api/files` ya no borra: renombra el elemento a `<carpeta del usuario>/.trash/<id>` y
apunta su origen en `.trash/index.json`, para poder restaurarlo en su sitio. Los elementos
caducan a los `TRASH_TTL_DAYS` días (30 por defecto) y se purgan al abrir la papelera.

Todo lo que empieza por punto es interno: no se lista, no se cuenta en las estadísticas y la
API rechaza cualquier ruta que lo contenga, así que a `.trash` solo se llega por sus endpoints.

Al restaurar (o al subir) nunca se sobrescribe: si el nombre ya está ocupado se añade `_1`, `_2`…

## Descargar como ZIP

`GET /api/zip?p=ruta&p=otra` empaqueta al vuelo carpetas enteras o una selección, hasta
`ZIP_LIMIT` (200) elementos. Se transmite mientras se comprime, sin archivo temporal.

Los nombres con acentos viajan en `filename*=UTF-8''…` además del `filename` en ASCII, que es
lo que exige la norma para que todos los navegadores acierten.

## Enlaces de descarga

El inverso de los de subida: `https://tu-dominio.com/s/<token>` para mandarle un archivo o
una carpeta a alguien sin cuenta. Se crean desde el menú de cualquier elemento (clic derecho →
*Compartir enlace…*) eligiendo descripción, caducidad y **contraseña opcional**.

Un archivo suelto se descarga directamente. Una **carpeta** abre además una galería pública
navegable (`/s/<token>` → *Ver galería*): miniaturas, subcarpetas y un visor de fotos y vídeos,
todo sin sesión y sin salir nunca de la carpeta compartida. El botón *Descargar todo (ZIP)*
sigue disponible para quien prefiera bajárselo entero. La página pública muestra nombre, tamaño
y caducidad, y nada más: ni la ruta, ni el dueño, ni el resto de la nube. La contraseña se guarda
con bcrypt, nunca sale en las respuestas, y protege igual la galería que la descarga.

Comparten almacén con los de subida (`uploadlinks.json`) y se distinguen por el campo `kind`;
los creados antes de que existieran se tratan como `upload`.

## Enlaces de subida

Desde Administración se crea un enlace `https://tu-dominio.com/u/<token>` que permite a
cualquiera **dejar** archivos en una carpeta concreta, sin cuenta. Los enlaces viven en
`uploadlinks.json` y guardan dueño, carpeta destino, caducidad y contadores.

Lo que el endpoint público **no** permite: listar, descargar, ver la ruta de destino ni saber
quién es el dueño. Los topes se ajustan por entorno:

| Variable | Por defecto | Qué limita |
|---|---|---|
| `LINK_MAX_FILES` | 50 | archivos totales que admite un enlace |
| `LINK_MAX_BYTES` | 2 GB | tamaño total acumulado por enlace |
| `LINK_IP_HOURLY` | 200 | subidas por IP y hora en el endpoint público |

El rol del dueño se relee en cada subida, así que degradar o borrar a un usuario invalida
sus enlaces al instante.

## Renombrado en lote

Desde la selección múltiple (o el menú contextual sobre varios elementos), *Renombrar en
lote…* aplica un patrón a todos: `{n}` es el número de orden (con ceros a la izquierda) y
`{name}` el nombre original sin extensión. La extensión se conserva siempre, y si el nombre
resultante ya existe se le añade un sufijo automático, igual que al restaurar de la papelera.

## Descargar convertido

Un HEIC se puede descargar como `.jpg` (conversión con sharp) y un documento de Office
(`.docx`, `.pptx`, `.odt`…) como `.pdf` (con LibreOffice, reutilizando la misma caché que la
vista previa). Los botones solo aparecen cuando el servidor tiene la herramienta instalada:
`GET /api/download?path=...&as=jpg` y `&as=pdf`.

## Editar archivos de texto

El visor de archivos de texto y código incluye un lápiz para editarlos ahí mismo y guardar con
`PUT /api/text`. Vale para cualquier extensión de las que ya se previsualizan como texto (`.txt`,
`.md`, `.csv`, código…); Markdown y CSV se editan como texto plano, no en su vista renderizada.

## Favoritos y presentación

Cualquier archivo o carpeta se puede marcar como favorito desde su menú de opciones. La pestaña
**Colecciones → Favoritos** los reúne todos en un único sitio, sin importar en qué carpeta
estén. Dentro del visor, el botón de presentación (▶) pasa las fotos solas cada pocos segundos;
se detiene al navegar a mano o al cerrar. Se guardan en `.favorites.json`, dentro de la carpeta
de cada usuario.

## Álbumes

Colecciones con nombre que apuntan a fotos por ruta, sin moverlas ni duplicarlas: la misma foto
puede estar en varios álbumes a la vez. Se crean y se rellenan desde **Colecciones → Álbumes** o
añadiendo elementos con *Añadir a álbum…* desde cualquier menú de opciones. Viven en
`.albums/index.json` dentro de la carpeta de cada usuario.

## Analizador de espacio y duplicados

Dos herramientas nuevas en Administración:

- **Espacio por carpeta** — un vistazo carpeta a carpeta, con el tamaño de cada subcarpeta ya
  sumado recursivamente, para encontrar qué está llenando el disco sin adivinarlo por tipo.
  Tope de `DU_LIMIT` (200 000) archivos examinados por subcarpeta, para que un almacén enorme
  no agote los descriptores de archivo del sistema.
- **Duplicados** — compara primero por tamaño y solo calcula el hash de lo que coincide, así que
  un almacén con miles de archivos se puede analizar sin tardar minutos. Cada grupo permite
  marcar todas las copias menos la más antigua y mandarlas a la papelera de una vez. Tope de
  `DUP_LIMIT` (20 000) archivos por escaneo.

## Sesiones, verificación en dos pasos y tokens de aplicación

Todo esto vive en la pestaña **Cuenta**, disponible para cualquier usuario, no solo para el
administrador:

- **Sesiones abiertas** — cada inicio de sesión queda registrado (`sessions.json`) con IP,
  navegador y última actividad, y se puede cerrar en remoto una a una o todas menos la actual.
  Los tokens JWT emitidos antes de esta función siguen funcionando: solo se revisan contra la
  lista de sesiones los que ya llevan el identificador nuevo.
- **Verificación en dos pasos (TOTP)** — un segundo factor de 6 dígitos compatible con Google
  Authenticator, Aegis o similar, implementado sin dependencias nuevas (HMAC-SHA1 + base32, RFC
  6238). Como aquí no hay lector de QR, la clave se añade a mano en la app de códigos.
- **Tokens de aplicación** — para montar WebDAV o usar scripts sin escribir la contraseña real
  de la cuenta. Se muestran una sola vez al crearlos y se revocan individualmente; WebDAV acepta
  tanto la contraseña de la cuenta como cualquiera de sus tokens.

## Bloqueo con PIN

Un bloqueo puramente del lado del cliente (Cuenta → Bloqueo con PIN): pide un PIN de 4 a 8
dígitos al reabrir la pestaña, al volver de segundo plano o tras 10 minutos de inactividad. El
hash del PIN (SHA-256) se guarda solo en `localStorage` de ese dispositivo y nunca llega al
servidor — no sustituye a la contraseña de la cuenta, es solo para que nadie cotillee si se deja
el móvil desbloqueado un momento.

## Registro de actividad

Cada acción relevante (subidas, borrados, movimientos, inicios de sesión, cambios de
contraseña, enlaces creados, verificación en dos pasos, tokens…) queda anotada en
`activity.log.jsonl`, una línea JSON por evento. Se ve en la pestaña **Cuenta**: cada usuario
ve solo las suyas, y el administrador ve las de todos desde esa misma tarjeta. El archivo se
recorta solo a `ACTIVITY_MAX` líneas.

## Cómo se guardan los archivos

- **admin** → ve y gestiona todo `DATA_DIR`.
- **usuarios normales** → aislados en `DATA_DIR/users/<username>/`, creado al vuelo.

## Variables de entorno

Ver [.env.example](.env.example).

## Copias de seguridad

Lo imprescindible: `DATA_DIR` (los archivos), `users.json` (las cuentas, incluye tokens de
aplicación y el secreto de verificación en dos pasos de quien la tenga activada) y
`.jwt-secret` (si se pierde, todas las sesiones abiertas se invalidan). `sessions.json` y
`activity.log.jsonl` son prescindibles: perderlos solo borra el historial de sesiones/actividad,
no cierra a nadie ni rompe nada.
