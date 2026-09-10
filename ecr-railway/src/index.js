// ============================================================
//  CAPA: BACKEND · API REST principal
//  Estudio Casil Rodríguez (ECR) · Node.js + Express
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const db      = require('./db');

const app  = express();
app.use(express.static(require('path').join(__dirname, '..', 'public')));
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Falta email o contraseña' });
    const [rows] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const usuario = rows[0];
    const ok = verifyPassword(password, usuario.password_hash);
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = signToken(usuario);
    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol } });
  } catch (e) { res.status(500).json({ error: 'Error de servidor' }); }
});

app.get('/api/me', requireAuth, async (req, res) => {
  const [rows] = await db.query('SELECT id, nombre, email, rol FROM usuarios WHERE id = ?', [req.usuario.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(rows[0]);
});

app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT id, nombre, email, rol, creado_en FROM usuarios ORDER BY id');
  res.json(rows);
});

app.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password) return res.status(400).json({ error: 'Faltan datos' });
    const hash = hashPassword(password);
    await db.query('INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?,?,?,?)',
      [nombre, email, hash, rol === 'admin' ? 'admin' : 'usuario']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo crear el usuario (¿email repetido?)' }); }
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


// ══════════════════════════════════════════════════════════
//  CLIENTES
// ══════════════════════════════════════════════════════════
app.get('/api/clientes', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM clientes ORDER BY id DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

app.post('/api/clientes', async (req, res) => {
  const { nombre, cuit, servicio, honorarios, estado } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const [r] = await db.query(
      'INSERT INTO clientes (nombre,cuit,servicio,honorarios,estado) VALUES (?,?,?,?,?)',
      [nombre, cuit||null, servicio||'Asesoramiento integral', honorarios||0, estado||'Activo']
    );
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Error al guardar' }); }
});

app.put('/api/clientes/:id', async (req, res) => {
  const { nombre, cuit, servicio, honorarios, estado } = req.body;
  try {
    await db.query(
      'UPDATE clientes SET nombre=?,cuit=?,servicio=?,honorarios=?,estado=? WHERE id=?',
      [nombre, cuit||null, servicio||'Asesoramiento integral', honorarios||0, estado||'Activo', req.params.id]
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

app.post('/api/vencimientos', async (req, res) => {
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

app.put('/api/vencimientos/:id', async (req, res) => {
  const { descripcion, cliente_id, tipo, fecha, estado } = req.body;
  try {
    await db.query(
      'UPDATE vencimientos SET descripcion=?,cliente_id=?,tipo=?,fecha=?,estado=? WHERE id=?',
      [descripcion, cliente_id||null, tipo||'Impositivo', fecha, estado||'Pendiente', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.delete('/api/vencimientos/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM vencimientos WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// ══════════════════════════════════════════════════════════
//  DOCUMENTOS
// ══════════════════════════════════════════════════════════
app.get('/api/documentos', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT d.*, c.nombre AS cliente_nombre
       FROM documentos d
       LEFT JOIN clientes c ON d.cliente_id = c.id
       ORDER BY d.id DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error de base de datos' }); }
});

app.post('/api/documentos', async (req, res) => {
  const { nombre, tipo, cliente_id, fecha } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const [r] = await db.query(
      'INSERT INTO documentos (nombre,tipo,cliente_id,fecha) VALUES (?,?,?,?)',
      [nombre, tipo||'Otro', cliente_id||null, fecha||new Date().toISOString().slice(0,10)]
    );
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: 'Error al guardar' }); }
});

app.delete('/api/documentos/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM documentos WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// ── Arrancar servidor ────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ECR Backend corriendo en puerto ${PORT}`);
});
