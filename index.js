// ============================================================
//  CAPA: BACKEND · API REST principal
//  Estudio Casil Rodríguez (ECR) · Node.js + Express
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Ruta de prueba ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'API ECR funcionando ✓' });
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
