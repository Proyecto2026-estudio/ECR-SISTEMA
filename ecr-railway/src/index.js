// ============================================================
//  CAPA: BACKEND · API REST principal
//  Estudio Casil Rodríguez (ECR) · Node.js + Express
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const db      = require('./db');
const { consultarIA } = require('./ia');
const extractos = require('./extractos');
const { sembrarReglas } = extractos;
const seg = require('./seguridad');
const { registrar } = seg;
const { registrarWhatsApp } = require('./whatsapp');
const alertas = require('./alertas');

const app  = express();
app.set('trust proxy', 1);   // Railway pone un proxy adelante: así se ve la IP real y el https
app.disable('x-powered-by');
app.use((req, res, next) => {   // encabezados básicos de seguridad
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(require('path').join(__dirname, '..', 'public'), { index: 'login.html' }));
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
// ============================================================
//  AUTENTICACIÓN · Login, sesiones y recuperación simple
// ============================================================
const crypto = require('crypto');
const APP_SECRET = process.env.APP_SECRET || 'cambiar-este-secreto-en-variables-de-railway';
if (!process.env.APP_SECRET) console.warn('ATENCIÓN: falta APP_SECRET en las variables de Railway; las sesiones usan una clave por defecto.');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || !String(stored).includes(':')) return false;   // cuenta sin activar
  const [salt, hash] = stored.split(':');
  const hashIntento = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashIntento, 'hex'));
}

function signToken(usuario) {
  const payload = JSON.stringify({ id: usuario.id, rol: usuario.rol, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const data = Buffer.from(payload).toString('base64url');
  const firma = crypto.createHmac('sha256', APP_SECRET).update(data).digest('base64url');
  return data + '.' + firma;
}

function verifyToken(token) {
  try {
    const [data, firma] = token.split('.');
    const firmaEsperada = crypto.createHmac('sha256', APP_SECRET).update(data).digest('base64url');
    if (!firma || firma.length !== firmaEsperada.length ||
        !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(firmaEsperada))) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'No autorizado, iniciá sesión de nuevo' });
  req.usuario = payload;
  next();
}

// El rol se lee de la base (no del token): si a alguien le sacan el rol, deja de tenerlo en el momento.
async function requireAdmin(req, res, next) {
  try {
    const [us] = await db.query('SELECT rol FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!us.length) return res.status(401).json({ error: 'No autorizado, iniciá sesión de nuevo' });
    if (us[0].rol !== 'admin') return res.status(403).json({ error: 'Necesitás permisos de administrador' });
    next();
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
}

// Roles del sistema: admin (acceso total), contador (gestión diaria, igual
// que el histórico "usuario"), cliente_pyme (solo ve sus propios datos),
// lectura (ve todo pero no puede crear/editar/borrar nada).
const ROLES_VALIDOS = ['admin', 'contador', 'cliente_pyme', 'lectura', 'usuario'];
function normalizarRol(r) { return ROLES_VALIDOS.includes(r) ? r : 'contador'; }

// ── Migraciones livianas: solo AGREGAN tablas y columnas; nunca borran datos ──
async function agregarColumna(tabla, definicion, alAgregar) {
  try {
    await db.query(`ALTER TABLE ${tabla} ADD COLUMN ${definicion}`);
    console.log(`Migración: ${tabla}.${definicion.split(' ')[0]} agregada`);
    if (alAgregar) await alAgregar();
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') console.error(`Migración ${tabla}.${definicion.split(' ')[0]}:`, e.message);
  }
}
async function crearTabla(nombre, sql) {
  try { await db.query(sql); } catch (e) { console.error('Migración ' + nombre + ':', e.message); }
}
const migraciones = (async () => {
  // Vincula a un usuario "Cliente PyME" con su registro en clientes.
  await agregarColumna('usuarios', 'cliente_id INT NULL');
  // Subcarpetas dentro de la carpeta de cada cliente (por ejemplo, una por banco).
  await crearTabla('carpetas', `CREATE TABLE IF NOT EXISTS carpetas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cliente_id INT NOT NULL,
      padre_id INT NULL,
      nombre VARCHAR(60) NOT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_carpeta_cliente (cliente_id)
    )`);
  await agregarColumna('documentos', 'carpeta_id INT NULL');
  // Carpetas dentro de carpetas (por ejemplo, Banco Galicia › 2025). padre_id NULL = está en la carpeta principal del cliente.
  await agregarColumna('carpetas', 'padre_id INT NULL');
  // El nombre ya no es único en todo el cliente sino dentro de cada carpeta (puede haber "2025" en dos bancos).
  try { await db.query('ALTER TABLE carpetas ADD KEY idx_carpeta_cliente (cliente_id)'); } catch (e) { /* ya existe */ }
  try { await db.query('ALTER TABLE carpetas DROP INDEX uq_carpeta'); console.log('Migración: carpetas.uq_carpeta quitada (nombres únicos por carpeta)'); }
  catch (e) { if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') console.error('Migración carpetas.uq_carpeta:', e.message); }
  // Registro de avisos por mail ya enviados (para no repetir el mismo vencimiento)
  await crearTabla('alertas_enviadas', `CREATE TABLE IF NOT EXISTS alertas_enviadas (
      venc_id INT NOT NULL,
      dias INT NOT NULL,
      enviado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (venc_id, dias)
    )`);
  // Mail del cliente para las alertas de vencimientos (opcional; puede haber varios separados por coma)
  await agregarColumna('clientes', 'email_alertas VARCHAR(200) NULL');
  await agregarColumna('clientes', 'whatsapp VARCHAR(25) NULL');
  // La columna 'rol' era un ENUM('admin','usuario'); se amplía a texto libre para los roles nuevos.
  try { await db.query("ALTER TABLE usuarios MODIFY COLUMN rol VARCHAR(30) NOT NULL DEFAULT 'contador'"); }
  catch (e) { console.error('Migración rol:', e.code, e.message); }

  // ── Informe MSC (nov 2026) ──
  // Enlaces únicos de activación de cuenta y de cambio de contraseña (se guarda solo el hash).
  await crearTabla('tokens_acceso', `CREATE TABLE IF NOT EXISTS tokens_acceso (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NOT NULL,
      tipo VARCHAR(20) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      vence_en DATETIME NOT NULL,
      usado_en DATETIME NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_token (token_hash),
      KEY ix_usuario (usuario_id)
    )`);
  // Historial de accesos y de cambios.
  await crearTabla('auditoria', `CREATE TABLE IF NOT EXISTS auditoria (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NULL,
      accion VARCHAR(40) NOT NULL,
      detalle VARCHAR(500) NULL,
      ip VARCHAR(64) NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY ix_fecha (creado_en)
    )`);
  // Documentos: período (año-mes al que corresponden), quién los subió y confirmación de recepción.
  await agregarColumna('documentos', 'periodo CHAR(7) NULL', () =>
    db.query("UPDATE documentos SET periodo = DATE_FORMAT(fecha, '%Y-%m') WHERE periodo IS NULL"));
  await agregarColumna('documentos', 'subido_por INT NULL');
  await agregarColumna('documentos', 'recibido_por INT NULL');
  // Los documentos que ya estaban cargados se dan por recibidos (los cargó el estudio).
  await agregarColumna('documentos', 'recibido_en DATETIME NULL', () =>
    db.query('UPDATE documentos SET recibido_en = NOW() WHERE recibido_en IS NULL'));
  // Vencimientos: fecha límite interna para que el cliente entregue la documentación.
  await agregarColumna('vencimientos', 'fecha_entrega DATE NULL');
  // Extractos: reglas del estudio, equivalencias con el plan de cuentas de cada cliente y registro de lecturas.
  await crearTabla('reglas_extracto', `CREATE TABLE IF NOT EXISTS reglas_extracto (
      id INT AUTO_INCREMENT PRIMARY KEY,
      patron VARCHAR(80) NOT NULL,
      categoria VARCHAR(20) NOT NULL,
      creado_por INT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  await crearTabla('equivalencias_cuentas', `CREATE TABLE IF NOT EXISTS equivalencias_cuentas (
      cliente_id INT NOT NULL,
      categoria VARCHAR(20) NOT NULL,
      cuenta_cliente VARCHAR(80) NOT NULL,
      PRIMARY KEY (cliente_id, categoria)
    )`);
  await crearTabla('extractos_log', `CREATE TABLE IF NOT EXISTS extractos_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NULL,
      cliente_id INT NULL,
      formato VARCHAR(10) NOT NULL,
      banco VARCHAR(80) NULL,
      periodo VARCHAR(40) NULL,
      movimientos INT NOT NULL DEFAULT 0,
      por_reglas INT NOT NULL DEFAULT 0,
      por_ia INT NOT NULL DEFAULT 0,
      saldo_ok TINYINT NULL,
      tokens INT NOT NULL DEFAULT 0,
      costo_usd DECIMAL(10,5) NOT NULL DEFAULT 0,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  try { await sembrarReglas(db); } catch (e) { console.error('Reglas iniciales:', e.message); }
})();

app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    const email = String(req.body.email || '').trim();
    if (!email && !password) return res.status(400).json({ error: 'Ingresá tu correo electrónico y tu contraseña.' });
    if (!email) return res.status(400).json({ error: 'Falta el correo electrónico. Ingresalo para continuar.' });
    if (!password) return res.status(400).json({ error: 'Falta la contraseña. Ingresala para continuar.' });
    // Máximo 8 intentos fallidos cada 15 minutos por IP y correo.
    const clave = 'login|' + seg.ipDe(req) + '|' + email.toLowerCase();
    const espera = seg.limitar(clave, 8, 15);
    if (espera) {
      registrar(db, req, 'login_bloqueado', email, null);
      return res.status(429).json({ error: `Demasiados intentos. Esperá ${espera} minuto${espera > 1 ? 's' : ''} y volvé a probar.` });
    }
    const [rows] = await db.query('SELECT * FROM usuarios WHERE LOWER(TRIM(email)) = LOWER(?)', [email]);
    if (rows.length === 0) {
      registrar(db, req, 'login_fallido', 'correo no registrado: ' + email, null);
      return res.status(401).json({ error: 'El correo electrónico no está registrado. Revisá que esté bien escrito.', campo: 'email' });
    }
    const usuario = rows[0];
    if (!usuario.password_hash || !String(usuario.password_hash).includes(':')) {
      return res.status(403).json({ error: 'Tu cuenta todavía no está activada. Usá el enlace del mail de bienvenida o pedile uno nuevo al estudio.', campo: 'email' });
    }
    let ok = false;
    try {
      ok = verifyPassword(password, usuario.password_hash);
      // tolera espacios sobrantes al copiar/pegar la contraseña
      if (!ok && password !== password.trim()) ok = verifyPassword(password.trim(), usuario.password_hash);
    } catch (e) { console.error('Login: hash de contraseña inválido para el usuario', usuario.id, e.message); }
    if (!ok) {
      registrar(db, req, 'login_fallido', 'contraseña incorrecta', usuario.id);
      return res.status(401).json({ error: 'La contraseña es incorrecta. Revisá que esté bien escrita, cuidando mayúsculas y minúsculas.', campo: 'password' });
    }
    seg.limpiarIntentos(clave);
    registrar(db, req, 'login', null, usuario.id);
    const token = signToken(usuario);
    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol, cliente_id: usuario.cliente_id || null } });
  } catch (e) { res.status(500).json({ error: 'Error de servidor' }); }
});

app.get('/api/me', requireAuth, async (req, res) => {
  const [rows] = await db.query('SELECT id, nombre, email, rol, cliente_id FROM usuarios WHERE id = ?', [req.usuario.id]);
  if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
  res.json(rows[0]);
});

const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 150;

app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    `SELECT u.id, u.nombre, u.email, u.rol, u.cliente_id, u.creado_en, c.nombre AS cliente_nombre,
            (u.password_hash IS NULL OR u.password_hash NOT LIKE '%:%') AS pendiente,
            (SELECT MAX(a.creado_en) FROM auditoria a WHERE a.usuario_id = u.id AND a.accion = 'login') AS ultimo_ingreso
     FROM usuarios u LEFT JOIN clientes c ON u.cliente_id = c.id
     ORDER BY u.id`
  );
  rows.forEach(r => { r.pendiente = !!r.pendiente; });
  res.json(rows);
});

// Alta de usuario SIN contraseña: el usuario la elige con el enlace único que le llega por mail.
app.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const { rol, cliente_id } = req.body;
    if (!nombre || !email) return res.status(400).json({ error: 'Completá nombre y email' });
    if (!emailValido(email)) return res.status(400).json({ error: 'El email no es válido' });
    const rolFinal = normalizarRol(rol);
    if (rolFinal === 'cliente_pyme' && !cliente_id) return res.status(400).json({ error: 'Elegí la empresa del Cliente PyME' });
    const [dup] = await db.query('SELECT id FROM usuarios WHERE LOWER(TRIM(email)) = ?', [email]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
    const [r] = await db.query('INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id) VALUES (?,?,?,?,?)',
      [nombre, email, '', rolFinal, rolFinal === 'cliente_pyme' ? cliente_id : null]);
    const usuario = { id: r.insertId, nombre, email };
    const envio = await seg.enviarEnlace(db, req, usuario, 'activacion');
    registrar(db, req, 'usuario_alta', `${email} (${rolFinal})${envio.mail_enviado ? ' · mail de activación enviado' : ' · mail NO enviado'}`);
    res.status(201).json({ ok: true, id: usuario.id, ...envio });
  } catch (e) { console.error('POST /api/usuarios:', e.code, e.message); res.status(500).json({ error: 'No se pudo crear el usuario' }); }
});

// Edición de datos y rol. La contraseña ya no la escribe el administrador: se cambia con un enlace.
app.put('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const { rol, cliente_id } = req.body;
    if (!nombre || !email) return res.status(400).json({ error: 'Completá nombre y email' });
    if (!emailValido(email)) return res.status(400).json({ error: 'El email no es válido' });
    const rolFinal = normalizarRol(rol);
    if (String(req.params.id) === String(req.usuario.id) && rolFinal !== 'admin')
      return res.status(400).json({ error: 'No podés quitarte a vos mismo el rol de administrador' });
    if (rolFinal === 'cliente_pyme' && !cliente_id) return res.status(400).json({ error: 'Elegí la empresa del Cliente PyME' });
    const [dup] = await db.query('SELECT id FROM usuarios WHERE LOWER(TRIM(email)) = ? AND id <> ?', [email, req.params.id]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe otro usuario con ese email' });
    const [antes] = await db.query('SELECT email, rol, cliente_id FROM usuarios WHERE id = ?', [req.params.id]);
    if (!antes.length) return res.status(404).json({ error: 'No existe el usuario' });
    const cliFinal = rolFinal === 'cliente_pyme' ? cliente_id : null;
    await db.query('UPDATE usuarios SET nombre=?, email=?, rol=?, cliente_id=? WHERE id=?',
      [nombre, email, rolFinal, cliFinal, req.params.id]);
    const cambios = [];
    if (antes[0].email !== email) cambios.push(`email ${antes[0].email} → ${email}`);
    if (antes[0].rol !== rolFinal) cambios.push(`rol ${antes[0].rol} → ${rolFinal}`);
    if (String(antes[0].cliente_id || '') !== String(cliFinal || '')) cambios.push('empresa asociada cambiada');
    registrar(db, req, 'usuario_editado', `#${req.params.id} ${email}${cambios.length ? ' · ' + cambios.join(' · ') : ''}`);
    res.json({ ok: true });
  } catch (e) { console.error('PUT /api/usuarios/:id:', e.code, e.message); res.status(500).json({ error: 'No se pudo actualizar el usuario' }); }
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.usuario.id)) {
      return res.status(400).json({ error: 'No podés eliminar tu propio usuario' });
    }
    const [u] = await db.query('SELECT email FROM usuarios WHERE id = ?', [req.params.id]);
    await db.query('DELETE FROM tokens_acceso WHERE usuario_id = ?', [req.params.id]);
    await db.query('DELETE FROM usuarios WHERE id=?', [req.params.id]);
    registrar(db, req, 'usuario_baja', `#${req.params.id} ${u.length ? u[0].email : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// El administrador reenvía el enlace: de activación si la cuenta está pendiente, o para cambiar la contraseña.
app.post('/api/usuarios/:id/enlace', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [u] = await db.query('SELECT id, nombre, email, password_hash FROM usuarios WHERE id = ?', [req.params.id]);
    if (!u.length) return res.status(404).json({ error: 'No existe el usuario' });
    const tipo = (u[0].password_hash && String(u[0].password_hash).includes(':')) ? 'recuperacion' : 'activacion';
    const envio = await seg.enviarEnlace(db, req, u[0], tipo);
    registrar(db, req, 'enlace_enviado', `${tipo} para ${u[0].email}${envio.mail_enviado ? '' : ' (mail NO enviado)'}`);
    res.json({ ok: true, tipo, ...envio });
  } catch (e) { console.error('POST /api/usuarios/:id/enlace:', e.message); res.status(500).json({ error: 'No se pudo generar el enlace' }); }
});

// "Olvidé mi contraseña": la respuesta es siempre la misma, exista o no el correo,
// para que nadie pueda averiguar qué correos tienen cuenta. Nunca se muestra una contraseña.
app.post('/api/recuperar', async (req, res) => {
  const generico = { ok: true, mensaje: 'Si el correo está registrado, te enviamos un enlace para elegir una contraseña nueva. Revisá tu casilla (y la carpeta de spam). El enlace vence en 2 horas.' };
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Ingresá tu correo electrónico' });
    if (seg.limitar('recuperar|' + seg.ipDe(req), 5, 30)) return res.status(429).json({ error: 'Demasiados pedidos seguidos. Probá de nuevo en media hora.' });
    const [rows] = await db.query('SELECT id, nombre, email, password_hash FROM usuarios WHERE LOWER(TRIM(email)) = ?', [email]);
    if (rows.length) {
      const tipo = (rows[0].password_hash && String(rows[0].password_hash).includes(':')) ? 'recuperacion' : 'activacion';
      const envio = await seg.enviarEnlace(db, req, rows[0], tipo);
      registrar(db, req, 'recuperar_pedido', envio.mail_enviado ? 'mail enviado' : 'mail NO enviado: ' + (envio.motivo || ''), rows[0].id);
    }
    res.json(generico);
  } catch (e) { console.error('POST /api/recuperar:', e.message); res.json(generico); }
});

// Página activar.html: consulta a quién corresponde el enlace (sin usarlo todavía).
app.post('/api/activar/info', async (req, res) => {
  try {
    if (seg.limitar('activar|' + seg.ipDe(req), 30, 15)) return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos.' });
    const e = await seg.leerEnlace(db, req.body.token);
    if (e.error) return res.status(410).json({ error: e.error });
    res.json({ nombre: e.usuario.nombre, email: e.usuario.email, tipo: e.tipo });
  } catch (err) { res.status(500).json({ error: 'Error de servidor' }); }
});

// Página activar.html: guarda la contraseña elegida y deja el enlace inutilizable.
app.post('/api/activar', async (req, res) => {
  try {
    if (seg.limitar('activar|' + seg.ipDe(req), 30, 15)) return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos.' });
    const e = await seg.leerEnlace(db, req.body.token);
    if (e.error) return res.status(410).json({ error: e.error });
    const problema = seg.problemaPassword(req.body.password);
    if (problema) return res.status(400).json({ error: problema });
    await db.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), e.usuario.id]);
    await seg.usarEnlace(db, e.id);
    registrar(db, req, e.tipo === 'activacion' ? 'cuenta_activada' : 'password_cambiada', null, e.usuario.id);
    res.json({ ok: true, email: e.usuario.email });
  } catch (err) { console.error('POST /api/activar:', err.message); res.status(500).json({ error: 'Error de servidor' }); }
});

// Historial de accesos y cambios (solo administrador).
app.get('/api/auditoria', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.id, a.accion, a.detalle, a.ip, a.creado_en, u.nombre AS usuario_nombre, u.email AS usuario_email
         FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
        ORDER BY a.id DESC LIMIT 300`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});


// ══════════════════════════════════════════════════════════
//  PERMISOS COMUNES
// ══════════════════════════════════════════════════════════
// Datos del usuario con sesión (rol y, si es Cliente PyME, su cliente). Se leen de la base en cada pedido.
async function usuarioActual(req) {
  const [us] = await db.query('SELECT id, nombre, rol, cliente_id FROM usuarios WHERE id = ?', [req.usuario.id]);
  return us[0] || null;
}
const sinSesion = res => res.status(401).json({ error: 'No autorizado, iniciá sesión de nuevo' });
const ES_STAFF = r => ['admin', 'contador', 'usuario'].includes(r);
// Crear, editar o borrar clientes y vencimientos: no puede el Cliente PyME ni el rol de solo lectura.
function soloEscrituraDe(que) {
  return async (req, res, next) => {
    try {
      const u = await usuarioActual(req);
      if (!u) return sinSesion(res);
      if (!ES_STAFF(u.rol)) return res.status(403).json({ error: `Tu rol no puede modificar ${que}` });
      req.u = u;
      next();
    } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
  };
}
const soloEscritura = soloEscrituraDe('vencimientos');
// Solo administrador y contador (panel, indicadores, extractos).
async function soloStaff(req, res, next) {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    if (!ES_STAFF(u.rol)) return res.status(403).json({ error: 'Tu rol no tiene acceso a esta sección' });
    req.u = u;
    next();
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
}

// ══════════════════════════════════════════════════════════
//  CLIENTES
// ══════════════════════════════════════════════════════════
// Los honorarios son datos del administrador: cualquier otro rol no los recibe ni los modifica.
async function esAdminReq(req) {
  try {
    const u = req.u || await usuarioActual(req);
    return !!u && u.rol === 'admin';
  } catch (e) { return false; }
}

app.get('/api/clientes', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    // Un Cliente PyME solo recibe los datos de su propia empresa.
    if (u.rol === 'cliente_pyme') {
      if (!u.cliente_id) return res.json([]);
      const [rows] = await db.query('SELECT id, nombre, cuit, servicio, estado FROM clientes WHERE id = ?', [u.cliente_id]);
      return res.json(rows);
    }
    const [rows] = await db.query('SELECT * FROM clientes ORDER BY id DESC');
    if (u.rol !== 'admin') rows.forEach(r => { delete r.honorarios; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

// Limpia y valida los mails de alertas: devuelve { valor } o { error }.
function limpiarMails(txt) {
  const lista = String(txt || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const malo = lista.find(m => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m) || m.length > 120);
  if (malo) return { error: `El mail "${malo}" no es válido` };
  const unicos = [...new Set(lista)];
  const valor = unicos.join(', ');
  if (valor.length > 200) return { error: 'Hay demasiados mails: el máximo son 200 caracteres' };
  return { valor: valor || null };
}

const soloEscrituraClientes = soloEscrituraDe('clientes');

app.post('/api/clientes', requireAuth, soloEscrituraClientes, async (req, res) => {
  const { nombre, cuit, servicio, honorarios, estado, email_alertas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const m = limpiarMails(email_alertas);
  if (m.error) return res.status(400).json({ error: m.error });
  try {
    const hon = (await esAdminReq(req)) ? (honorarios||0) : 0;
    const [r] = await db.query(
      'INSERT INTO clientes (nombre,cuit,servicio,honorarios,estado,email_alertas) VALUES (?,?,?,?,?,?)',
      [nombre, cuit||null, servicio||'Asesoramiento integral', hon, estado||'Activo', m.valor]
    );
    registrar(db, req, 'cliente_alta', `#${r.insertId} ${nombre}`);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Error al guardar' }); }
});

app.put('/api/clientes/:id', requireAuth, soloEscrituraClientes, async (req, res) => {
  const { nombre, cuit, servicio, honorarios, estado, email_alertas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const m = limpiarMails(email_alertas);
  if (m.error) return res.status(400).json({ error: m.error });
  try {
    if (await esAdminReq(req)) {
      await db.query(
        'UPDATE clientes SET nombre=?,cuit=?,servicio=?,honorarios=?,estado=?,email_alertas=? WHERE id=?',
        [nombre, cuit||null, servicio||'Asesoramiento integral', honorarios||0, estado||'Activo', m.valor, req.params.id]
      );
    } else {   // sin ser admin se conserva el honorario que ya tenía
      await db.query(
        'UPDATE clientes SET nombre=?,cuit=?,servicio=?,estado=?,email_alertas=? WHERE id=?',
        [nombre, cuit||null, servicio||'Asesoramiento integral', estado||'Activo', m.valor, req.params.id]
      );
    }
    registrar(db, req, 'cliente_editado', `#${req.params.id} ${nombre}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/clientes/:id', requireAuth, soloEscrituraClientes, async (req, res) => {
  try {
    const [c] = await db.query('SELECT nombre FROM clientes WHERE id = ?', [req.params.id]);
    await db.query('DELETE FROM clientes WHERE id=?', [req.params.id]);
    registrar(db, req, 'cliente_baja', `#${req.params.id} ${c.length ? c[0].nombre : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// ══════════════════════════════════════════════════════════
//  VENCIMIENTOS
//  fecha          = fecha fiscal oficial del vencimiento
//  fecha_entrega  = fecha límite interna para que el cliente entregue la documentación (opcional)
// ══════════════════════════════════════════════════════════
const fechaISO = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v).slice(0, 10))) ? String(v).slice(0, 10) : null;

app.get('/api/vencimientos', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    // Un Cliente PyME solo recibe los vencimientos de su propia empresa.
    if (u.rol === 'cliente_pyme' && !u.cliente_id) return res.json([]);
    const soloMio = u.rol === 'cliente_pyme';
    const [rows] = await db.query(
      `SELECT v.*, c.nombre AS cliente_nombre
       FROM vencimientos v
       LEFT JOIN clientes c ON v.cliente_id = c.id
       ${soloMio ? 'WHERE v.cliente_id = ?' : ''}
       ORDER BY v.fecha ASC`, soloMio ? [u.cliente_id] : []
    );
    res.json(rows.map(v => ({ ...v, cliente_id: v.cliente_id ? String(v.cliente_id) : null })));
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

// Valida fecha y fecha de entrega (la entrega tiene que ser antes o el mismo día que el vencimiento).
function datosVencimiento(body) {
  const fecha = fechaISO(body.fecha);
  if (!body.descripcion || !fecha) return { error: 'Descripción y fecha son obligatorias' };
  const entrega = body.fecha_entrega ? fechaISO(body.fecha_entrega) : null;
  if (body.fecha_entrega && !entrega) return { error: 'La fecha de entrega no es válida' };
  if (entrega && entrega > fecha) return { error: 'La entrega de documentación tiene que ser antes del vencimiento' };
  return { valores: [body.descripcion, body.cliente_id || null, body.tipo || 'Impositivo', fecha, body.estado || 'Pendiente', entrega] };
}

app.post('/api/vencimientos', requireAuth, soloEscritura, async (req, res) => {
  const d = datosVencimiento(req.body);
  if (d.error) return res.status(400).json({ error: d.error });
  try {
    const [r] = await db.query(
      'INSERT INTO vencimientos (descripcion,cliente_id,tipo,fecha,estado,fecha_entrega) VALUES (?,?,?,?,?,?)', d.valores);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Error al guardar' }); }
});

app.put('/api/vencimientos/:id', requireAuth, soloEscritura, async (req, res) => {
  const d = datosVencimiento(req.body);
  if (d.error) return res.status(400).json({ error: d.error });
  try {
    await db.query(
      'UPDATE vencimientos SET descripcion=?,cliente_id=?,tipo=?,fecha=?,estado=?,fecha_entrega=? WHERE id=?',
      [...d.valores, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/vencimientos/:id', requireAuth, soloEscritura, async (req, res) => {
  try {
    const [v] = await db.query('SELECT descripcion, fecha FROM vencimientos WHERE id = ?', [req.params.id]);
    await db.query('DELETE FROM vencimientos WHERE id=?', [req.params.id]);
    if (v.length) registrar(db, req, 'vencimiento_baja', `#${req.params.id} ${v[0].descripcion} (${String(fechaISO(v[0].fecha) || '')})`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// ══════════════════════════════════════════════════════════
//  DOCUMENTOS
// ══════════════════════════════════════════════════════════

// Período al que corresponde un documento: 'AAAA-MM' (por ejemplo, el mes de un extracto).
const periodoValido = p => /^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(String(p || '')) ? String(p) : null;

app.get('/api/documentos', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    // Un Cliente PyME solo recibe los documentos de su propia empresa.
    if (u.rol === 'cliente_pyme' && !u.cliente_id) return res.json([]);
    const soloMio = u.rol === 'cliente_pyme';
    const [rows] = await db.query(
      `SELECT d.id, d.nombre, d.tipo, d.cliente_id, d.carpeta_id, d.fecha, d.periodo, d.archivo_mime, d.archivo_nombre_original,
              d.recibido_en, d.subido_por, c.nombre AS cliente_nombre, us.nombre AS subido_por_nombre, ur.nombre AS recibido_por_nombre,
              (us.rol = 'cliente_pyme') AS subido_por_cliente
       FROM documentos d
       LEFT JOIN clientes c ON d.cliente_id = c.id
       LEFT JOIN usuarios us ON us.id = d.subido_por
       LEFT JOIN usuarios ur ON ur.id = d.recibido_por
       ${soloMio ? 'WHERE d.cliente_id = ?' : ''}
       ORDER BY d.id DESC`,
      soloMio ? [u.cliente_id] : []
    );
    rows.forEach(r => { r.subido_por_cliente = !!r.subido_por_cliente; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

app.post('/api/documentos', requireAuth, async (req, res) => {
  const { nombre, tipo, fecha, archivo_data, archivo_mime, archivo_nombre_original } = req.body;
  let { cliente_id } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    // Un Cliente PyME puede cargar documentos, pero SOLO en su propia carpeta;
    // el rol "lectura" no puede cargar nada.
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    if (u.rol === 'lectura') return res.status(403).json({ error: 'Tu rol no puede cargar documentos' });
    if (u.rol === 'cliente_pyme') {
      if (!u.cliente_id) return res.status(403).json({ error: 'Tu usuario no tiene un cliente asociado' });
      cliente_id = u.cliente_id;
    }
    // La carpeta elegida tiene que ser del mismo cliente; si no, el documento queda en la carpeta principal.
    let carpetaId = req.body.carpeta_id || null;
    if (carpetaId) {
      const [cp] = await db.query('SELECT id FROM carpetas WHERE id = ? AND cliente_id = ?', [carpetaId, cliente_id]);
      if (!cp.length) carpetaId = null;
    }
    const fechaFinal = fechaISO(fecha) || new Date().toISOString().slice(0, 10);
    const periodo = periodoValido(req.body.periodo) || fechaFinal.slice(0, 7);
    // Lo que sube el estudio queda recibido; lo que sube el cliente queda pendiente hasta que el estudio lo confirme.
    const staff = ES_STAFF(u.rol);
    const [r] = await db.query(
      `INSERT INTO documentos (nombre,tipo,cliente_id,carpeta_id,fecha,periodo,archivo_data,archivo_mime,archivo_nombre_original,subido_por,recibido_por,recibido_en)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,${staff ? 'NOW()' : 'NULL'})`,
      [nombre, tipo||'Otro', cliente_id||null, carpetaId, fechaFinal, periodo, archivo_data||null, archivo_mime||null, archivo_nombre_original||null,
       u.id, staff ? u.id : null]
    );
    registrar(db, req, 'documento_subido', `#${r.insertId} ${nombre} · cliente ${cliente_id || 'general'} · ${periodo}`);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { console.error('POST /api/documentos:', e.message); res.status(500).json({ error: 'Error al guardar' }); }
});

// ¿Puede este usuario tocar este documento? El estudio, siempre. El Cliente PyME, solo uno de su
// empresa que todavía no fue confirmado por el estudio (para corregir un envío equivocado).
function puedeCorregir(u, doc) {
  if (ES_STAFF(u.rol)) return true;
  return u.rol === 'cliente_pyme' && !!u.cliente_id && String(doc.cliente_id) === String(u.cliente_id) && !doc.recibido_en;
}

app.get('/api/documentos/:id/archivo', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    const [rows] = await db.query('SELECT nombre, cliente_id, archivo_data, archivo_mime, archivo_nombre_original FROM documentos WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'No existe el documento' });
    const doc = rows[0];
    // Un Cliente PyME solo puede abrir documentos de su propia empresa (aunque conozca el enlace directo).
    if (u.rol === 'cliente_pyme' && (!u.cliente_id || String(doc.cliente_id) !== String(u.cliente_id))) {
      registrar(db, req, 'acceso_denegado', `documento #${req.params.id} de otra empresa`);
      return res.status(403).json({ error: 'No tenés acceso a este documento' });
    }
    if (!doc.archivo_data) return res.status(404).json({ error: 'No hay archivo cargado para este documento' });
    registrar(db, req, 'documento_abierto', `#${req.params.id} ${doc.nombre}`);
    const buffer = Buffer.from(doc.archivo_data, 'base64');
    res.setHeader('Content-Type', doc.archivo_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.archivo_nombre_original || 'archivo')}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  } catch (e) { res.status(500).json({ error: 'Error al leer el archivo' }); }
});

// Corregir nombre, tipo o período de un documento.
app.put('/api/documentos/:id', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    const [d] = await db.query('SELECT id, nombre, cliente_id, recibido_en FROM documentos WHERE id = ?', [req.params.id]);
    if (!d.length) return res.status(404).json({ error: 'No existe el documento' });
    if (!puedeCorregir(u, d[0])) return res.status(403).json({ error: u.rol === 'cliente_pyme' ? 'El estudio ya confirmó este documento: pedile a ellos que lo corrijan' : 'Tu rol no puede modificar documentos' });
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const periodo = periodoValido(req.body.periodo);
    if (req.body.periodo && !periodo) return res.status(400).json({ error: 'El período no es válido' });
    await db.query('UPDATE documentos SET nombre = ?, tipo = ?, periodo = COALESCE(?, periodo) WHERE id = ?',
      [nombre, req.body.tipo || 'Otro', periodo, d[0].id]);
    registrar(db, req, 'documento_editado', `#${d[0].id} ${d[0].nombre}${d[0].nombre !== nombre ? ' → ' + nombre : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar el documento' }); }
});

// Confirmación de recepción (solo el estudio). { recibido: true | false }
app.put('/api/documentos/:id/recibido', requireAuth, soloStaff, async (req, res) => {
  try {
    const [d] = await db.query('SELECT id, nombre FROM documentos WHERE id = ?', [req.params.id]);
    if (!d.length) return res.status(404).json({ error: 'No existe el documento' });
    const si = req.body.recibido !== false;
    await db.query(`UPDATE documentos SET recibido_en = ${si ? 'NOW()' : 'NULL'}, recibido_por = ? WHERE id = ?`, [si ? req.u.id : null, d[0].id]);
    registrar(db, req, si ? 'documento_recibido' : 'documento_pendiente', `#${d[0].id} ${d[0].nombre}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al confirmar el documento' }); }
});

app.delete('/api/documentos/:id', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    const [d] = await db.query('SELECT id, nombre, cliente_id, recibido_en FROM documentos WHERE id = ?', [req.params.id]);
    if (!d.length) return res.status(404).json({ error: 'No existe el documento' });
    if (!puedeCorregir(u, d[0])) return res.status(403).json({ error: u.rol === 'cliente_pyme' ? 'El estudio ya confirmó este documento: pedile a ellos que lo quiten' : 'Tu rol no puede eliminar documentos' });
    await db.query('DELETE FROM documentos WHERE id=?', [d[0].id]);
    registrar(db, req, 'documento_borrado', `#${d[0].id} ${d[0].nombre}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});
// ══════════════════════════════════════════════════════════
//  CARPETAS dentro de la carpeta de un cliente (p. ej. una por banco)
// ══════════════════════════════════════════════════════════
// Devuelve el usuario o responde el error. El Cliente PyME solo toca lo de su empresa;
// el rol de solo lectura no puede crear ni cambiar nada.
async function permisoCarpetas(req, res) {
  const u = await usuarioActual(req);
  if (!u) { sinSesion(res); return null; }
  if (u.rol === 'lectura') { res.status(403).json({ error: 'Tu rol no puede modificar carpetas' }); return null; }
  if (u.rol === 'cliente_pyme' && !u.cliente_id) { res.status(403).json({ error: 'Tu usuario no tiene un cliente asociado' }); return null; }
  return u;
}
const MAX_NIVELES = 5;
// Ruta de nombres desde la carpeta principal hasta esta (["Banco Galicia", "2025"]).
async function rutaCarpeta(id) {
  const ruta = []; let actual = id;
  for (let i = 0; actual && i < 20; i++) {
    const [r] = await db.query('SELECT padre_id, nombre FROM carpetas WHERE id = ?', [actual]);
    if (!r.length) break;
    ruta.unshift(r[0].nombre); actual = r[0].padre_id;
  }
  return ruta;
}
const nombreCarpeta = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);

app.get('/api/carpetas', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    if (u.rol === 'cliente_pyme' && !u.cliente_id) return res.json([]);
    const soloMio = u.rol === 'cliente_pyme';
    const [rows] = await db.query(
      `SELECT id, cliente_id, padre_id, nombre FROM carpetas ${soloMio ? 'WHERE cliente_id = ?' : ''} ORDER BY nombre ASC`,
      soloMio ? [u.cliente_id] : []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

app.post('/api/carpetas', requireAuth, async (req, res) => {
  try {
    const u = await permisoCarpetas(req, res); if (!u) return;
    const nombre = nombreCarpeta(req.body.nombre);
    if (!nombre) return res.status(400).json({ error: 'Escribí un nombre para la carpeta' });
    const clienteId = u.rol === 'cliente_pyme' ? u.cliente_id : req.body.cliente_id;
    if (!clienteId) return res.status(400).json({ error: 'Falta el cliente' });
    // Carpeta "padre": tiene que ser del mismo cliente. Se permiten hasta MAX_NIVELES niveles.
    const padreId = req.body.padre_id ? Number(req.body.padre_id) : null;
    if (padreId) {
      const [pd] = await db.query('SELECT id FROM carpetas WHERE id = ? AND cliente_id = ?', [padreId, clienteId]);
      if (!pd.length) return res.status(400).json({ error: 'La carpeta donde querés crearla no es de este cliente' });
      if ((await rutaCarpeta(padreId)).length >= MAX_NIVELES) return res.status(400).json({ error: `Se pueden anidar hasta ${MAX_NIVELES} niveles de carpetas` });
    }
    const [dup] = await db.query('SELECT id FROM carpetas WHERE cliente_id = ? AND padre_id <=> ? AND nombre = ?', [clienteId, padreId, nombre]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe una carpeta con ese nombre en este lugar' });
    const [r] = await db.query('INSERT INTO carpetas (cliente_id, padre_id, nombre) VALUES (?, ?, ?)', [clienteId, padreId, nombre]);
    registrar(db, req, 'carpeta_alta', (await rutaCarpeta(r.insertId)).join(' › '), u.id);
    res.status(201).json({ ok: true, id: r.insertId, nombre, padre_id: padreId });
  } catch (e) { res.status(500).json({ error: 'Error al crear la carpeta' }); }
});

app.put('/api/carpetas/:id', requireAuth, async (req, res) => {
  try {
    const u = await permisoCarpetas(req, res); if (!u) return;
    const [c] = await db.query('SELECT id, cliente_id, padre_id FROM carpetas WHERE id = ?', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: 'No existe la carpeta' });
    if (u.rol === 'cliente_pyme' && String(c[0].cliente_id) !== String(u.cliente_id)) return res.status(403).json({ error: 'No tenés acceso a esta carpeta' });
    const nombre = nombreCarpeta(req.body.nombre);
    if (!nombre) return res.status(400).json({ error: 'Escribí un nombre para la carpeta' });
    const [dup] = await db.query('SELECT id FROM carpetas WHERE cliente_id = ? AND padre_id <=> ? AND nombre = ? AND id <> ?', [c[0].cliente_id, c[0].padre_id, nombre, c[0].id]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe una carpeta con ese nombre en este lugar' });
    await db.query('UPDATE carpetas SET nombre = ? WHERE id = ?', [nombre, c[0].id]);
    res.json({ ok: true, nombre });
  } catch (e) { res.status(500).json({ error: 'Error al renombrar la carpeta' }); }
});

// Borrar una carpeta NO borra nada de lo que tiene adentro: sus documentos y sus carpetas
// pasan a la carpeta de arriba (o a la principal del cliente).
app.delete('/api/carpetas/:id', requireAuth, async (req, res) => {
  try {
    const u = await permisoCarpetas(req, res); if (!u) return;
    const [c] = await db.query('SELECT id, cliente_id, padre_id FROM carpetas WHERE id = ?', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: 'No existe la carpeta' });
    if (u.rol === 'cliente_pyme' && String(c[0].cliente_id) !== String(u.cliente_id)) return res.status(403).json({ error: 'No tenés acceso a esta carpeta' });
    const ruta = (await rutaCarpeta(c[0].id)).join(' › ');
    const arriba = c[0].padre_id || null;
    await db.query('UPDATE documentos SET carpeta_id = ? WHERE carpeta_id = ?', [arriba, c[0].id]);
    // Las carpetas de adentro suben un nivel; si ya hay una con el mismo nombre allá, se les agrega " (2)", " (3)"…
    const [hijas] = await db.query('SELECT id, nombre FROM carpetas WHERE padre_id = ?', [c[0].id]);
    for (const h of hijas) {
      let nombre = h.nombre;
      for (let n = 2; ; n++) {
        const [dup] = await db.query('SELECT id FROM carpetas WHERE cliente_id = ? AND padre_id <=> ? AND nombre = ? AND id <> ?', [c[0].cliente_id, arriba, nombre, h.id]);
        if (!dup.length) break;
        const suf = ` (${n})`; nombre = h.nombre.slice(0, 60 - suf.length) + suf;
      }
      await db.query('UPDATE carpetas SET padre_id = ?, nombre = ? WHERE id = ?', [arriba, nombre, h.id]);
    }
    await db.query('DELETE FROM carpetas WHERE id = ?', [c[0].id]);
    registrar(db, req, 'carpeta_baja', ruta + ' (su contenido pasó a la carpeta de arriba)', u.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar la carpeta' }); }
});

// Mover un documento a una carpeta (o a la principal con carpeta_id = null). No cambia el archivo.
app.put('/api/documentos/:id/carpeta', requireAuth, async (req, res) => {
  try {
    const u = await permisoCarpetas(req, res); if (!u) return;
    const [d] = await db.query('SELECT id, cliente_id FROM documentos WHERE id = ?', [req.params.id]);
    if (!d.length) return res.status(404).json({ error: 'No existe el documento' });
    if (u.rol === 'cliente_pyme' && String(d[0].cliente_id) !== String(u.cliente_id)) return res.status(403).json({ error: 'No tenés acceso a este documento' });
    let destino = req.body.carpeta_id || null;
    if (destino) {
      const [cp] = await db.query('SELECT id FROM carpetas WHERE id = ? AND cliente_id = ?', [destino, d[0].cliente_id]);
      if (!cp.length) return res.status(400).json({ error: 'Esa carpeta no es del mismo cliente' });
    }
    await db.query('UPDATE documentos SET carpeta_id = ? WHERE id = ?', [destino, d[0].id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al mover el documento' }); }
});

// ══════════════════════════════════════════════════════════
//  ASISTENTE (proxy a Gemini, clave guardada en el servidor)
// ══════════════════════════════════════════════════════════
app.post('/api/asistente', requireAuth, async (req, res) => {
  try {
    const { prompt, system, useSearch } = req.body;
    let { clienteId } = req.body;
    // Un Cliente PyME solo puede consultar la carpeta de su propio cliente.
    const [us] = await db.query('SELECT rol, cliente_id FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!us.length) return res.status(401).json({ error: 'No autorizado, iniciá sesión de nuevo' });
    if (us[0].rol === 'cliente_pyme') {
      if (!us[0].cliente_id) return res.status(403).json({ error: 'Tu usuario no tiene un cliente asociado' });
      clienteId = us[0].cliente_id;
    }
    res.json(await consultarIA(db, { prompt, system, useSearch, clienteId }));
  } catch (e) {
    console.error('POST /api/asistente:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  RF08 · LECTURA DE EXTRACTOS BANCARIOS (solo propone, no imputa)
// ══════════════════════════════════════════════════════════
async function equivalenciasDe(clienteId) {
  if (!clienteId) return {};
  const [rows] = await db.query('SELECT categoria, cuenta_cliente FROM equivalencias_cuentas WHERE cliente_id = ?', [clienteId]);
  return Object.fromEntries(rows.map(r => [r.categoria, r.cuenta_cliente]));
}

app.post('/api/extractos/leer', requireAuth, soloStaff, async (req, res) => {
  try {
    const { archivo_base64, mime, nombre } = req.body || {};
    const clienteId = req.body.cliente_id ? Number(req.body.cliente_id) || null : null;
    const [reglas] = await db.query('SELECT id, patron, categoria FROM reglas_extracto');
    const r = await extractos.leerExtracto({ base64: archivo_base64, mime, nombre, reglas, equivalencias: await equivalenciasDe(clienteId) });
    // Registro de cada lectura: costo real por extracto y resultado del control de saldos.
    try {
      const [ins] = await db.query(
        `INSERT INTO extractos_log (usuario_id, cliente_id, formato, banco, periodo, movimientos, por_reglas, por_ia, saldo_ok, tokens, costo_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [req.u.id, clienteId, r.formato, String(r.banco || '').slice(0, 80), [r.desde, r.hasta].filter(Boolean).join(' a ').slice(0, 40),
         r.movimientos.length, r.resumen.por_reglas, r.resumen.por_ia,
         r.verificacion.saldoOk === null ? null : (r.verificacion.saldoOk ? 1 : 0),
         r.uso.tokens_entrada + r.uso.tokens_salida, r.uso.costo_usd]);
      r.registro_id = ins.insertId;
    } catch (e) { console.error('extractos_log:', e.message); }
    registrar(db, req, 'extracto_leido', `${r.formato.toUpperCase()} · ${r.movimientos.length} movimientos · USD ${r.uso.costo_usd}`);
    res.json(r);
  } catch (e) {
    console.error('POST /api/extractos/leer:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Reglas del estudio: "si la descripción contiene X, la categoría es Y".
app.get('/api/extractos/reglas', requireAuth, soloStaff, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, patron, categoria FROM reglas_extracto ORDER BY categoria, patron');
    res.json({ reglas: rows, categorias: extractos.CATEGORIAS.map(([codigo, nombre]) => ({ codigo, nombre })) });
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});
app.post('/api/extractos/reglas', requireAuth, soloStaff, async (req, res) => {
  try {
    const patron = String(req.body.patron || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const categoria = String(req.body.categoria || '');
    if (patron.length < 3) return res.status(400).json({ error: 'El texto de la regla tiene que tener al menos 3 caracteres' });
    if (!extractos.CODIGOS.includes(categoria) || categoria === 'REVISAR') return res.status(400).json({ error: 'Elegí una categoría válida' });
    const [dup] = await db.query('SELECT id FROM reglas_extracto WHERE UPPER(patron) = UPPER(?)', [patron]);
    if (dup.length) return res.status(409).json({ error: 'Ya hay una regla con ese texto' });
    const [r] = await db.query('INSERT INTO reglas_extracto (patron, categoria, creado_por) VALUES (?,?,?)', [patron, categoria, req.u.id]);
    registrar(db, req, 'regla_alta', `"${patron}" → ${categoria}`);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'No se pudo guardar la regla' }); }
});
app.delete('/api/extractos/reglas/:id', requireAuth, soloStaff, async (req, res) => {
  try {
    const [r] = await db.query('SELECT patron, categoria FROM reglas_extracto WHERE id = ?', [req.params.id]);
    await db.query('DELETE FROM reglas_extracto WHERE id = ?', [req.params.id]);
    if (r.length) registrar(db, req, 'regla_baja', `"${r[0].patron}" → ${r[0].categoria}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo borrar la regla' }); }
});

// Equivalencias: categoría genérica → cuenta del plan de cuentas de cada cliente.
app.get('/api/extractos/equivalencias/:clienteId', requireAuth, soloStaff, async (req, res) => {
  try { res.json(await equivalenciasDe(req.params.clienteId)); }
  catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});
app.put('/api/extractos/equivalencias/:clienteId', requireAuth, soloStaff, async (req, res) => {
  try {
    const [c] = await db.query('SELECT id, nombre FROM clientes WHERE id = ?', [req.params.clienteId]);
    if (!c.length) return res.status(404).json({ error: 'No existe el cliente' });
    const mapa = req.body && typeof req.body.equivalencias === 'object' ? req.body.equivalencias : {};
    await db.query('DELETE FROM equivalencias_cuentas WHERE cliente_id = ?', [c[0].id]);
    let n = 0;
    for (const [cat, cuenta] of Object.entries(mapa)) {
      const v = String(cuenta || '').trim().slice(0, 80);
      if (v && extractos.CODIGOS.includes(cat)) { await db.query('INSERT INTO equivalencias_cuentas (cliente_id, categoria, cuenta_cliente) VALUES (?,?,?)', [c[0].id, cat, v]); n++; }
    }
    registrar(db, req, 'equivalencias', `${c[0].nombre}: ${n} cuenta(s)`);
    res.json({ ok: true, guardadas: n });
  } catch (e) { res.status(500).json({ error: 'No se pudieron guardar las equivalencias' }); }
});

// ══════════════════════════════════════════════════════════
//  INDICADORES del panel (administrador y contador)
// ══════════════════════════════════════════════════════════
const MIN_POR_MOVIMIENTO = 1;   // supuesto: imputar a mano un movimiento lleva ~1 minuto
app.get('/api/indicadores', requireAuth, soloStaff, async (req, res) => {
  try {
    const uno = async (sql, p = []) => (await db.query(sql, p))[0][0];
    const docsPend = await uno(`SELECT COUNT(*) AS n, COUNT(DISTINCT cliente_id) AS clientes FROM documentos WHERE recibido_en IS NULL`);
    const entregas = await uno(`SELECT COUNT(*) AS n, COUNT(DISTINCT cliente_id) AS clientes FROM vencimientos
                                 WHERE fecha_entrega IS NOT NULL AND fecha_entrega < CURDATE() AND estado <> 'Cumplido'`);
    const entregasProx = await uno(`SELECT COUNT(*) AS n FROM vencimientos WHERE fecha_entrega BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND estado <> 'Cumplido'`);
    const ven7 = await uno(`SELECT COUNT(*) AS n FROM vencimientos WHERE fecha BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND estado <> 'Cumplido'`);
    const vencidos = await uno(`SELECT COUNT(*) AS n FROM vencimientos WHERE fecha < CURDATE() AND estado <> 'Cumplido'`);
    const extr = await uno(`SELECT COUNT(*) AS n, COALESCE(SUM(movimientos),0) AS movs, COALESCE(SUM(costo_usd),0) AS costo,
                                   COALESCE(SUM(saldo_ok = 0),0) AS no_cierran
                              FROM extractos_log WHERE creado_en >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`);
    const denegados = await uno(`SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'acceso_denegado' AND creado_en >= DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    res.json({
      docs_pendientes: Number(docsPend.n), docs_pendientes_clientes: Number(docsPend.clientes),
      entregas_atrasadas: Number(entregas.n), entregas_atrasadas_clientes: Number(entregas.clientes),
      entregas_proximas: Number(entregasProx.n),
      vencen_7_dias: Number(ven7.n), vencidos_sin_cumplir: Number(vencidos.n),
      extractos_mes: Number(extr.n), movimientos_mes: Number(extr.movs), costo_ia_mes_usd: Math.round(Number(extr.costo) * 10000) / 10000,
      extractos_no_cierran: Number(extr.no_cierran),
      horas_ahorradas_mes: Math.round(Number(extr.movs) * MIN_POR_MOVIMIENTO / 60 * 10) / 10,
      accesos_denegados_30d: Number(denegados.n)
    });
  } catch (e) { console.error('GET /api/indicadores:', e.message); res.status(500).json({ error: 'Error de base de datos' }); }
});

// El estudio deja registrado que vio la alerta de vencimientos al ingresar ("quién recibió el aviso").
app.post('/api/alertas/vista', requireAuth, soloStaff, async (req, res) => {
  const n = Number(req.body && req.body.cantidad) || 0;
  registrar(db, req, 'alerta_vista', `${n} vencimiento(s) por vencer`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
//  COPIA DE SEGURIDAD (ver src/copias.js)
// ══════════════════════════════════════════════════════════
const copias = require('./copias');
app.get('/api/copia', async (req, res) => {
  try {
    // Entra con la sesión de un administrador o con la clave de copia automática (header X-Copia-Token).
    let quien = null;
    if (copias.tokenValido(req.headers['x-copia-token'])) quien = 'automatica';
    else {
      const auth = req.headers.authorization || '';
      const p = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7)) : null;
      if (p) {
        const [u] = await db.query('SELECT id, rol FROM usuarios WHERE id = ?', [p.id]);
        if (u.length && u[0].rol === 'admin') { quien = 'admin'; req.usuario = p; }
      }
    }
    if (!quien) {
      registrar(db, req, 'copia_denegada', null, null);
      return res.status(401).json({ error: 'Solo un administrador puede descargar la copia de seguridad' });
    }
    const conteo = await copias.generarCopia(db, res);
    registrar(db, req, 'copia_descargada', `${quien} · ` + Object.entries(conteo).map(([t, n]) => `${t}:${n}`).join(' '), quien === 'admin' ? req.usuario.id : null);
  } catch (e) {
    console.error('GET /api/copia:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar la copia' }); else res.destroy(e);
  }
});
app.get('/api/copia/estado', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [r] = await db.query(`SELECT a.creado_en, a.detalle, u.nombre FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
                                 WHERE a.accion = 'copia_descargada' ORDER BY a.id DESC LIMIT 5`);
    res.json({ automatica_configurada: (process.env.BACKUP_TOKEN || '').length >= 24, ultimas: r });
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

registrarWhatsApp(app, db);

// Solo el administrador: manda un mail de prueba, o ejecuta ahora el aviso de vencimientos (?prueba=1 para la prueba)
app.post('/api/alertas/ejecutar', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    if (u.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede ejecutar las alertas' });
    res.json(req.query.prueba ? await alertas.enviarPrueba() : await alertas.enviarAlertas(db));
  } catch (e) { console.error('POST /api/alertas/ejecutar:', e.message); res.status(500).json({ error: 'No se pudo enviar el mail: ' + e.message }); }
});

// ── Arrancar servidor ────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ECR Backend corriendo en puerto ${PORT}`);
  alertas.iniciar(db);
});
