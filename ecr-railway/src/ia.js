// ============================================================
//  Consulta a Gemini, opcionalmente con la carpeta de un cliente.
//  Lo usan el asistente web (/api/asistente) y el bot de WhatsApp.
// ============================================================
const { construirPartes } = require('./docs-extract');

class IAError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// db: pool de MySQL. Devuelve { text, docs } o lanza IAError.
async function consultarIA(db, { prompt, system, useSearch, clienteId }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new IAError(500, 'Falta configurar GEMINI_API_KEY en Railway');
  if (!prompt) throw new IAError(400, 'Falta la consulta');

  let systemText = system || '';
  const userParts = [];
  let docsInfo = null;

  if (clienteId) {
    const [cli] = await db.query('SELECT nombre FROM clientes WHERE id = ?', [clienteId]);
    if (!cli.length) throw new IAError(404, 'Cliente no encontrado');
    const [docs] = await db.query(
      'SELECT nombre, tipo, fecha, archivo_data, archivo_mime, archivo_nombre_original FROM documentos WHERE cliente_id = ? ORDER BY id DESC',
      [clienteId]);
    const { partes, usados, omitidos } = construirPartes(docs);
    docsInfo = { cliente: cli[0].nombre, usados, omitidos };
    systemText += `\n\nMODO CARPETA DE CLIENTE: estás trabajando con la carpeta de documentos de "${cli[0].nombre}". `
      + `Basá tus respuestas en los documentos que se adjuntan en la consulta; citá de qué documento sacás cada dato. `
      + `Si lo que preguntan no figura en los documentos, decilo en vez de inventarlo. `
      + `Si te piden un asiento contable, proponelo con cuentas, debe y haber, aclarando que es una PROPUESTA que debe revisar el contador. `
      + `Los extractos bancarios pueden usarse para conciliar movimientos. `
      + `Documentos disponibles: ${usados.length ? usados.join('; ') : '(ninguno legible)'}.`;
    userParts.push(...partes);
  }
  userParts.push({ text: prompt });

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: userParts }]
  };
  if (useSearch && !clienteId) body.tools = [{ google_search: {} }];

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    console.error('Gemini:', r.status, t.slice(0, 300));
    throw new IAError(r.status, t.slice(0, 200));
  }
  const data = await r.json();
  const parts = ((((data.candidates || [])[0] || {}).content || {}).parts) || [];
  const text = parts.map(p => p.text || '').join('').trim() || 'No obtuve respuesta.';
  return { text, docs: docsInfo };
}

module.exports = { consultarIA, IAError };
