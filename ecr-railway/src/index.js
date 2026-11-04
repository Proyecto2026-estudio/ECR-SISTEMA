// ============================================================
//  CAPA: BACKEND · API REST principal
//  Estudio Casil Rodríguez (ECR) · Node.js + Express
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const db      = require('./db');
const { consultarIA } = require('./ia');
const { leerExtracto } = require('./extractos');
const { registrarWhatsApp } = require('./whatsapp');
const alertas = require('./alertas');

const app  = express();
app.use(express.static(require('path').join(__dirname, '..', 'public'), { index: 'login.html' }));
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
// ============================================================
//  AUTENTICACIÓN · Login, sesiones y recuperación simple
// ============================================================
const crypto = require('crypto');
const APP_SECRET = process.env.APP_SECRET || 'cambiar-este-secreto-en-variables-de-railway';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
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
    if (firma !== firmaEsperada) return null;
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

function requireAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Necesitás permisos de administrador' });
  next();
}

// Roles del sistema: admin (acceso total), contador (gestión diaria, igual
// que el histórico "usuario"), cliente_pyme (solo ve sus propios datos),
// lectura (ve todo pero no puede crear/editar/borrar nada).
const ROLES_VALIDOS = ['admin', 'contador', 'cliente_pyme', 'lectura', 'usuario'];
function normalizarRol(r) { return ROLES_VALIDOS.includes(r) ? r : 'contador'; }

// Migración liviana: agrega la columna cliente_id a usuarios si todavía no
// existe (vincula a un usuario "Cliente PyME" con su registro en clientes).
(async () => {
  try {
    await db.query('ALTER TABLE usuarios ADD COLUMN cliente_id INT NULL');
    console.log('Migración: columna cliente_id agregada a usuarios');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') console.error('Migración cliente_id:', e.message);
  }
  // Subcarpetas dentro de la carpeta de cada cliente (por ejemplo, una por banco).
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS carpetas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cliente_id INT NOT NULL,
      nombre VARCHAR(60) NOT NULL,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_carpeta (cliente_id, nombre)
    )`);
  } catch (e) { console.error('Migración carpetas:', e.message); }
  try {
    await db.query('ALTER TABLE documentos ADD COLUMN carpeta_id INT NULL');
    console.log('Migración: columna carpeta_id agregada a documentos');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') console.error('Migración carpeta_id:', e.message);
  }
  // Registro de avisos por mail ya enviados (para no repetir el mismo vencimiento)
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS alertas_enviadas (
      venc_id INT NOT NULL,
      dias INT NOT NULL,
      enviado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (venc_id, dias)
    )`);
  } catch (e) { console.error('Migración alertas_enviadas:', e.message); }
  // Mail del cliente para las alertas de vencimientos (opcional; puede haber varios separados por coma)
  try {
    await db.query('ALTER TABLE clientes ADD COLUMN email_alertas VARCHAR(200) NULL');
    console.log('Migración: columna email_alertas agregada a clientes');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') console.error('Migración email_alertas:', e.message);
  }
  // Teléfono de WhatsApp del cliente (para el asistente de WhatsApp)
  try {
    await db.query('ALTER TABLE clientes ADD COLUMN whatsapp VARCHAR(25) NULL');
    console.log('Migración: columna whatsapp agregada a clientes');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') console.error('Migración whatsapp:', e.message);
  }
  // La columna 'rol' era un ENUM('admin','usuario'); se amplía a texto libre
  // para que entren los roles nuevos (contador, cliente_pyme, lectura).
  try {
    await db.query("ALTER TABLE usuarios MODIFY COLUMN rol VARCHAR(30) NOT NULL DEFAULT 'contador'");
    console.log('Migración: columna rol ampliada a VARCHAR(30)');
  } catch (e) {
    console.error('Migración rol:', e.code, e.message);
  }
})();

app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    const email = String(req.body.email || '').trim();
    if (!email && !password) return res.status(400).json({ error: 'Ingresá tu correo electrónico y tu contraseña.' });
    if (!email) return res.status(400).json({ error: 'Falta el correo electrónico. Ingresalo para continuar.' });
    if (!password) return res.status(400).json({ error: 'Falta la contraseña. Ingresala para continuar.' });
    const [rows] = await db.query('SELECT * FROM usuarios WHERE LOWER(TRIM(email)) = LOWER(?)', [email]);
    if (rows.length === 0) {
      console.warn('Login fallido: el email no está registrado ->', email);
      return res.status(401).json({ error: 'El correo electrónico no está registrado. Revisá que esté bien escrito.', campo: 'email' });
    }
    const usuario = rows[0];
    let ok = false;
    try {
      ok = verifyPassword(password, usuario.password_hash);
      // tolera espacios sobrantes al copiar/pegar la contraseña
      if (!ok && password !== password.trim()) ok = verifyPassword(password.trim(), usuario.password_hash);
    } catch (e) { console.error('Login: hash de contraseña inválido para el usuario', usuario.id, e.message); }
    if (!ok) {
      console.warn('Login fallido: contraseña incorrecta -> usuario', usuario.id, usuario.email);
      return res.status(401).json({ error: 'La contraseña es incorrecta. Revisá que esté bien escrita, cuidando mayúsculas y minúsculas.', campo: 'password' });
    }
    const token = signToken(usuario);
    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol, cliente_id: usuario.cliente_id || null } });
  } catch (e) { res.status(500).json({ error: 'Error de servidor' }); }
});

app.get('/api/me', requireAuth, async (req, res) => {
  const [rows] = await db.query('SELECT id, nombre, email, rol, cliente_id FROM usuarios WHERE id = ?', [req.usuario.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(rows[0]);
});

app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    `SELECT u.id, u.nombre, u.email, u.rol, u.cliente_id, u.creado_en, c.nombre AS cliente_nombre
     FROM usuarios u LEFT JOIN clientes c ON u.cliente_id = c.id
     ORDER BY u.id`
  );
  res.json(rows);
});

app.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nombre, email, password, rol, cliente_id } = req.body;
    if (!nombre || !email || !password) return res.status(400).json({ error: 'Faltan datos' });
    const rolFinal = normalizarRol(rol);
    const hash = hashPassword(password);
    await db.query('INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id) VALUES (?,?,?,?,?)',
      [nombre, email, hash, rolFinal, rolFinal === 'cliente_pyme' ? (cliente_id || null) : null]);
    res.json({ ok: true });
  } catch (e) { console.error('POST /api/usuarios:', e.code, e.message); res.status(500).json({ error: 'No se pudo crear el usuario (¿email repetido?)' }); }
});

app.put('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nombre, email, rol, cliente_id, password } = req.body;
    if (!nombre || !email) return res.status(400).json({ error: 'Faltan datos' });
    const rolFinal = normalizarRol(rol);
    const cliFinal = rolFinal === 'cliente_pyme' ? (cliente_id || null) : null;
    if (password) {
      const hash = hashPassword(password);
      await db.query('UPDATE usuarios SET nombre=?, email=?, rol=?, cliente_id=?, password_hash=? WHERE id=?',
        [nombre, email, rolFinal, cliFinal, hash, req.params.id]);
    } else {
      await db.query('UPDATE usuarios SET nombre=?, email=?, rol=?, cliente_id=? WHERE id=?',
        [nombre, email, rolFinal, cliFinal, req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { console.error('PUT /api/usuarios/:id:', e.code, e.message); res.status(500).json({ error: 'No se pudo actualizar el usuario (¿email repetido?)' }); }
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.usuario.id)) {
      return res.status(400).json({ error: 'No podés eliminar tu propio usuario' });
    }
    await db.query('DELETE FROM usuarios WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

app.put('/api/usuarios/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Falta la contraseña nueva' });
    const hash = hashPassword(password);
    await db.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error de servidor' }); }
});

app.post('/api/recuperar', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta el email' });
    const [rows] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(404).json({ error: 'No existe un usuario con ese email' });
    const nuevaPass = crypto.randomBytes(4).toString('hex');
    const hash = hashPassword(nuevaPass);
    await db.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hash, rows[0].id]);
    res.json({ ok: true, nuevaPass });
  } catch (e) { res.status(500).json({ error: 'Error de servidor' }); }
});


// ══════════════════════════════════════════════════════════
//  CLIENTES
// ══════════════════════════════════════════════════════════
app.get('/api/clientes', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM clientes ORDER BY id DESC');
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

app.post('/api/clientes', async (req, res) => {
  const { nombre, cuit, servicio, honorarios, estado, email_alertas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const m = limpiarMails(email_alertas);
  if (m.error) return res.status(400).json({ error: m.error });
  try {
    const [r] = await db.query(
      'INSERT INTO clientes (nombre,cuit,servicio,honorarios,estado,email_alertas) VALUES (?,?,?,?,?,?)',
      [nombre, cuit||null, servicio||'Asesoramiento integral', honorarios||0, estado||'Activo', m.valor]
    );
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Error al guardar' }); }
});

app.put('/api/clientes/:id', async (req, res) => {
  const { nombre, cuit, servicio, honorarios, estado, email_alertas } = req.body;
  const m = limpiarMails(email_alertas);
  if (m.error) return res.status(400).json({ error: m.error });
  try {
    await db.query(
      'UPDATE clientes SET nombre=?,cuit=?,servicio=?,honorarios=?,estado=?,email_alertas=? WHERE id=?',
      [nombre, cuit||null, servicio||'Asesoramiento integral', honorarios||0, estado||'Activo', m.valor, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/clientes/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM clientes WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// ══════════════════════════════════════════════════════════
//  VENCIMIENTOS
// ══════════════════════════════════════════════════════════
app.get('/api/vencimientos', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT v.*, c.nombre AS cliente_nombre
       FROM vencimientos v
       LEFT JOIN clientes c ON v.cliente_id = c.id
       ORDER BY v.fecha ASC`
    );
    // Normalizar para que el frontend lo entienda igual que con PHP
    const mapped = rows.map(v => ({
      ...v,
      descripcion: v.descripcion,
      cliente_id: v.cliente_id ? String(v.cliente_id) : null,
    }));
    res.json(mapped);
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

app.post('/api/vencimientos', requireAuth, soloEscritura, async (req, res) => {
  const { descripcion, cliente_id, tipo, fecha, estado } = req.body;
  if (!descripcion || !fecha) return res.status(400).json({ error: 'Descripción y fecha son obligatorias' });
  try {
    const [r] = await db.query(
      'INSERT INTO vencimientos (descripcion,cliente_id,tipo,fecha,estado) VALUES (?,?,?,?,?)',
      [descripcion, cliente_id||null, tipo||'Impositivo', fecha, estado||'Pendiente']
    );
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Error al guardar' }); }
});

app.put('/api/vencimientos/:id', requireAuth, soloEscritura, async (req, res) => {
  const { descripcion, cliente_id, tipo, fecha, estado } = req.body;
  try {
    await db.query(
      'UPDATE vencimientos SET descripcion=?,cliente_id=?,tipo=?,fecha=?,estado=? WHERE id=?',
      [descripcion, cliente_id||null, tipo||'Impositivo', fecha, estado||'Pendiente', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/vencimientos/:id', requireAuth, soloEscritura, async (req, res) => {
  try {
    await db.query('DELETE FROM vencimientos WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// ══════════════════════════════════════════════════════════
//  DOCUMENTOS
// ══════════════════════════════════════════════════════════
// Datos del usuario con sesión (rol y, si es Cliente PyME, su cliente).
async function usuarioActual(req) {
  const [us] = await db.query('SELECT rol, cliente_id FROM usuarios WHERE id = ?', [req.usuario.id]);
  return us[0] || null;
}
// Cargar, editar o borrar vencimientos: no puede el Cliente PyME ni el rol de solo lectura.
async function soloEscritura(req, res, next) {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    if (['cliente_pyme', 'lectura'].includes(u.rol)) return res.status(403).json({ error: 'Tu rol no puede modificar vencimientos' });
    next();
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
}
const sinSesion = res => res.status(401).json({ error: 'No autorizado, iniciá sesión de nuevo' });

app.get('/api/documentos', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    // Un Cliente PyME solo recibe los documentos de su propia empresa.
    if (u.rol === 'cliente_pyme' && !u.cliente_id) return res.json([]);
    const soloMio = u.rol === 'cliente_pyme';
    const [rows] = await db.query(
      `SELECT d.id, d.nombre, d.tipo, d.cliente_id, d.carpeta_id, d.fecha, d.archivo_mime, d.archivo_nombre_original, c.nombre AS cliente_nombre
       FROM documentos d
       LEFT JOIN clientes c ON d.cliente_id = c.id
       ${soloMio ? 'WHERE d.cliente_id = ?' : ''}
       ORDER BY d.id DESC`,
      soloMio ? [u.cliente_id] : []
    );
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
    const [us] = await db.query('SELECT rol, cliente_id FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!us.length) return res.status(401).json({ error: 'No autorizado, iniciá sesión de nuevo' });
    if (us[0].rol === 'lectura') return res.status(403).json({ error: 'Tu rol no puede cargar documentos' });
    if (us[0].rol === 'cliente_pyme') {
      if (!us[0].cliente_id) return res.status(403).json({ error: 'Tu usuario no tiene un cliente asociado' });
      cliente_id = us[0].cliente_id;
    }
    // La carpeta elegida tiene que ser del mismo cliente; si no, el documento queda en la carpeta principal.
    let carpetaId = req.body.carpeta_id || null;
    if (carpetaId) {
      const [cp] = await db.query('SELECT id FROM carpetas WHERE id = ? AND cliente_id = ?', [carpetaId, cliente_id]);
      if (!cp.length) carpetaId = null;
    }
    const [r] = await db.query(
      'INSERT INTO documentos (nombre,tipo,cliente_id,carpeta_id,fecha,archivo_data,archivo_mime,archivo_nombre_original) VALUES (?,?,?,?,?,?,?,?)',
      [nombre, tipo||'Otro', cliente_id||null, carpetaId, fecha||new Date().toISOString().slice(0,10), archivo_data||null, archivo_mime||null, archivo_nombre_original||null]
    );
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Error al guardar' }); }
});

app.get('/api/documentos/:id/archivo', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    const [rows] = await db.query('SELECT cliente_id, archivo_data, archivo_mime, archivo_nombre_original FROM documentos WHERE id = ?', [req.params.id]);
    if (rows.length === 0 || !rows[0].archivo_data) return res.status(404).json({ error: 'No hay archivo cargado para este documento' });
    const doc = rows[0];
    // Un Cliente PyME solo puede abrir documentos de su propia empresa.
    if (u.rol === 'cliente_pyme' && (!u.cliente_id || String(doc.cliente_id) !== String(u.cliente_id)))
      return res.status(403).json({ error: 'No tenés acceso a este documento' });
    const buffer = Buffer.from(doc.archivo_data, 'base64');
    res.setHeader('Content-Type', doc.archivo_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.archivo_nombre_original || 'archivo')}`);
    res.send(buffer);
  } catch (e) { res.status(500).json({ error: 'Error al leer el archivo' }); }
});

app.delete('/api/documentos/:id', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    if (['cliente_pyme', 'lectura'].includes(u.rol)) return res.status(403).json({ error: 'Tu rol no puede eliminar documentos' });
    await db.query('DELETE FROM documentos WHERE id=?', [req.params.id]);
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
const nombreCarpeta = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);

app.get('/api/carpetas', requireAuth, async (req, res) => {
  try {
    const u = await usuarioActual(req);
    if (!u) return sinSesion(res);
    if (u.rol === 'cliente_pyme' && !u.cliente_id) return res.json([]);
    const soloMio = u.rol === 'cliente_pyme';
    const [rows] = await db.query(
      `SELECT id, cliente_id, nombre FROM carpetas ${soloMio ? 'WHERE cliente_id = ?' : ''} ORDER BY nombre ASC`,
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
    const [dup] = await db.query('SELECT id FROM carpetas WHERE cliente_id = ? AND nombre = ?', [clienteId, nombre]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe una carpeta con ese nombre' });
    const [r] = await db.query('INSERT INTO carpetas (cliente_id, nombre) VALUES (?, ?)', [clienteId, nombre]);
    res.status(201).json({ ok: true, id: r.insertId, nombre });
  } catch (e) { res.status(500).json({ error: 'Error al crear la carpeta' }); }
});

app.put('/api/carpetas/:id', requireAuth, async (req, res) => {
  try {
    const u = await permisoCarpetas(req, res); if (!u) return;
    const [c] = await db.query('SELECT id, cliente_id FROM carpetas WHERE id = ?', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: 'No existe la carpeta' });
    if (u.rol === 'cliente_pyme' && String(c[0].cliente_id) !== String(u.cliente_id)) return res.status(403).json({ error: 'No tenés acceso a esta carpeta' });
    const nombre = nombreCarpeta(req.body.nombre);
    if (!nombre) return res.status(400).json({ error: 'Escribí un nombre para la carpeta' });
    const [dup] = await db.query('SELECT id FROM carpetas WHERE cliente_id = ? AND nombre = ? AND id <> ?', [c[0].cliente_id, nombre, c[0].id]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe una carpeta con ese nombre' });
    await db.query('UPDATE carpetas SET nombre = ? WHERE id = ?', [nombre, c[0].id]);
    res.json({ ok: true, nombre });
  } catch (e) { res.status(500).json({ error: 'Error al renombrar la carpeta' }); }
});

// Borrar una carpeta NO borra sus documentos: vuelven a la carpeta principal del cliente.
app.delete('/api/carpetas/:id', requireAuth, async (req, res) => {
  try {
    const u = await permisoCarpetas(req, res); if (!u) return;
    const [c] = await db.query('SELECT id, cliente_id FROM carpetas WHERE id = ?', [req.params.id]);
    if (!c.length) return res.status(404).json({ error: 'No existe la carpeta' });
    if (u.rol === 'cliente_pyme' && String(c[0].cliente_id) !== String(u.cliente_id)) return res.status(403).json({ error: 'No tenés acceso a esta carpeta' });
    await db.query('UPDATE documentos SET carpeta_id = NULL WHERE carpeta_id = ?', [c[0].id]);
    await db.query('DELETE FROM carpetas WHERE id = ?', [c[0].id]);
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
//  RF08 · LECTURA DE EXTRACTOS BANCARIOS CON IA (solo propone, no guarda)
// ══════════════════════════════════════════════════════════
app.post('/api/extractos/leer', requireAuth, async (req, res) => {
  try {
    const [us] = await db.query('SELECT rol FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!us.length) return res.status(401).json({ error: 'No autorizado, iniciá sesión de nuevo' });
    if (['cliente_pyme', 'lectura'].includes(us[0].rol)) return res.status(403).json({ error: 'Tu rol no puede usar la lectura de extractos' });
    const { archivo_base64, mime } = req.body || {};
    res.json(await leerExtracto({ base64: archivo_base64, mime }));
  } catch (e) {
    console.error('POST /api/extractos/leer:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
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
