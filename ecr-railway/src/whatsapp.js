// ============================================================
//  Asistente de WhatsApp para clientes PyME (Meta WhatsApp Cloud API)
//  - Consulta de vencimientos (directo desde la base, sin IA)
//  - Recepción de comprobantes y extractos bancarios -> carpeta del cliente
//  - Preguntas sobre la carpeta del cliente (IA)
//  Variables de entorno: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID,
//  WHATSAPP_VERIFY_TOKEN y (recomendado) WHATSAPP_APP_SECRET.
// ============================================================
const crypto = require('crypto');
const { consultarIA } = require('./ia');

const GRAPH = 'https://graph.facebook.com/v21.0';
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const procesados = new Set();   // ids de mensajes ya atendidos (Meta reintenta webhooks)

const digitos = s => String(s || '').replace(/\D/g, '');
// Compara teléfonos por los últimos 10 dígitos (evita líos con 54 / 549 / 0 / 15)
const ult10 = s => digitos(s).slice(-10);

async function enviar(to, text) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) { console.error('WhatsApp: faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID'); return; }
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 3800) } })
  });
  if (!r.ok) console.error('WhatsApp envío falló:', r.status, (await r.text()).slice(0, 300));
}

// WhatsApp usa *negrita*; Gemini devuelve **negrita**
const aFormatoWhatsApp = t => String(t).replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s*/gm, '');

async function descargarMedia(mediaId) {
  const h = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: h });
  if (!meta.ok) throw new Error('No se pudo obtener el archivo (' + meta.status + ')');
  const info = await meta.json();
  if (info.file_size && info.file_size > MAX_MEDIA_BYTES) throw new Error('archivo muy grande');
  const bin = await fetch(info.url, { headers: h });
  if (!bin.ok) throw new Error('No se pudo descargar el archivo (' + bin.status + ')');
  const buf = Buffer.from(await bin.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw new Error('archivo muy grande');
  return { buf, mime: info.mime_type };
}

const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'text/csv': 'csv', 'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };

function fmtFecha(f) {
  const d = new Date(f); if (isNaN(d)) return String(f).slice(0, 10);
  return d.toISOString().slice(0, 10).split('-').reverse().join('/');
}

async function responderVencimientos(db, cliente) {
  const [rows] = await db.query(
    `SELECT descripcion, tipo, fecha, estado FROM vencimientos
     WHERE cliente_id = ? AND estado <> 'Cumplido' ORDER BY fecha ASC LIMIT 10`, [cliente.id]);
  if (!rows.length) return `✅ ${cliente.nombre}: no tenés vencimientos pendientes cargados.`;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const lineas = rows.map(v => {
    const dias = Math.ceil((new Date(String(v.fecha).slice(0, 10) + 'T00:00') - hoy) / 864e5);
    const cuando = dias < 0 ? `venció hace ${-dias} d` : dias === 0 ? 'vence HOY' : `en ${dias} d`;
    return `• ${fmtFecha(v.fecha)} (${cuando}) – ${v.descripcion} [${v.tipo}]`;
  });
  return `📅 *Próximos vencimientos de ${cliente.nombre}*\n${lineas.join('\n')}`;
}

const MENU = `Hola, soy el asistente del *Estudio Casil Rodríguez* 👋
Puedo ayudarte con:
• Escribí *vencimientos* para ver qué te vence.
• Mandame una *foto o PDF* de un comprobante (o escribí "extracto" en el texto si es un extracto bancario) y lo guardo en tu carpeta.
• Preguntame lo que quieras sobre tus documentos (ej: "¿cuánto IVA pagué en septiembre?").
Las respuestas de IA son orientativas; tu contador las revisa.`;

async function manejarMensaje(db, msg) {
  const from = msg.from;
  const [clientes] = await db.query("SELECT id, nombre, whatsapp FROM clientes WHERE whatsapp IS NOT NULL AND whatsapp <> '' AND estado <> 'Inactivo'");
  const cliente = clientes.find(c => ult10(c.whatsapp) === ult10(from));
  if (!cliente) {
    await enviar(from, 'Hola 👋 Este número no figura como cliente del Estudio Casil Rodríguez. Pedile al estudio que lo registre para poder atenderte.');
    return;
  }

  const tipo = msg.type;
  if (tipo === 'text') {
    const texto = (msg.text && msg.text.body || '').trim();
    if (/^(hola|buen[oa]s|menu|menú|ayuda|help|\?)\b/i.test(texto) && texto.length < 20) { await enviar(from, MENU); return; }
    if (/vencimient|\bvence\b|\bvencen\b|que me vence|qué me vence/i.test(texto) && texto.length < 60) {
      await enviar(from, await responderVencimientos(db, cliente)); return;
    }
    const sys = 'Sos el asistente de WhatsApp del Estudio Casil Rodríguez (contadores públicos, Argentina). Respondé en español rioplatense, muy breve (máx. 6 líneas), sin tablas ni encabezados. Hablás con un cliente PyME del estudio.';
    const r = await consultarIA(db, { prompt: texto, system: sys, useSearch: false, clienteId: cliente.id });
    const nota = (r.docs && r.docs.usados.length === 0) ? '\n\n(Todavía no tenés documentos legibles en tu carpeta; mandame comprobantes y los guardo.)' : '';
    await enviar(from, aFormatoWhatsApp(r.text) + nota);
    return;
  }

  if (tipo === 'image' || tipo === 'document') {
    const m = msg[tipo];
    let media;
    try { media = await descargarMedia(m.id); }
    catch (e) { await enviar(from, '⚠️ No pude recibir el archivo (' + e.message + '). Probá de nuevo o mandalo por mail al estudio.'); return; }
    const caption = (m.caption || '').trim();
    const esExtracto = /extracto|resumen de cuenta|movimientos/i.test(caption + ' ' + (m.filename || ''));
    const docTipo = esExtracto ? 'Extracto bancario' : 'Comprobante';
    const mime = media.mime || m.mime_type || 'application/octet-stream';
    const ext = EXT[mime] || 'bin';
    const original = m.filename || `${docTipo.toLowerCase().replace(/ /g, '_')}_${Date.now()}.${ext}`;
    const nombre = caption ? caption.slice(0, 120) : `${docTipo} por WhatsApp ${fmtFecha(new Date())}`;
    await db.query(
      'INSERT INTO documentos (nombre,tipo,cliente_id,fecha,archivo_data,archivo_mime,archivo_nombre_original) VALUES (?,?,?,?,?,?,?)',
      [nombre, docTipo, cliente.id, new Date().toISOString().slice(0, 10), media.buf.toString('base64'), mime, original]);
    await enviar(from, `✅ Recibí tu ${docTipo.toLowerCase()} y lo guardé en tu carpeta. El estudio lo va a revisar.`);
    return;
  }

  await enviar(from, 'Por ahora puedo leer texto, fotos y PDF. Escribí *ayuda* para ver qué puedo hacer.');
}

function firmaValida(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;   // sin secreto configurado no se valida (solo para pruebas)
  const sig = req.headers['x-hub-signature-256'] || '';
  const esperado = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function registrarWhatsApp(app, db) {
  // Verificación inicial del webhook (Meta llama con hub.challenge)
  app.get('/webhook/whatsapp', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  app.post('/webhook/whatsapp', (req, res) => {
    if (!firmaValida(req)) return res.sendStatus(401);
    res.sendStatus(200);   // Meta exige respuesta rápida; se procesa después
    const mensajes = [];
    for (const entry of (req.body && req.body.entry) || [])
      for (const ch of entry.changes || [])
        for (const m of (ch.value && ch.value.messages) || []) mensajes.push(m);
    for (const msg of mensajes) {
      if (procesados.has(msg.id)) continue;
      procesados.add(msg.id);
      if (procesados.size > 500) procesados.delete(procesados.values().next().value);
      manejarMensaje(db, msg).catch(async e => {
        console.error('WhatsApp error:', e.message);
        try { await enviar(msg.from, 'Tuve un problema para responderte. Probá de nuevo en un rato.'); } catch (_) {}
      });
    }
  });
}

module.exports = { registrarWhatsApp, ult10, manejarMensaje, firmaValida };
