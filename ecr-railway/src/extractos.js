// ============================================================
//  RF08 – Lectura de extractos bancarios con IA (Gemini Flash)
//  La IA SOLO propone: lee los movimientos y sugiere una cuenta.
//  El servidor verifica los saldos y el contador revisa y confirma.
//  Nada se guarda en la base: la propuesta se devuelve al navegador.
// ============================================================
const MODELO = process.env.GEMINI_MODEL_EXTRACTOS || 'gemini-2.5-flash';
// Precios en USD por millón de tokens (gemini-2.5-flash, nivel pago)
const PRECIO_ENTRADA = 0.30;
const PRECIO_SALIDA = 2.50;
const MAX_BYTES = 15 * 1024 * 1024;

// Plan de cuentas básico para clasificar. Se puede ajustar sin tocar el resto.
const CUENTAS = [
  ['IMP_CHEQUE', 'Impuesto a los créditos y débitos bancarios (Ley 25.413)'],
  ['SELLOS', 'Impuesto de sellos'],
  ['IMP_OTROS', 'Otros impuestos, retenciones y percepciones'],
  ['COMISIONES', 'Comisiones y gastos bancarios'],
  ['INTERESES', 'Intereses (pagados o cobrados)'],
  ['PROVEEDORES', 'Pagos a proveedores (cheques, transferencias, débitos)'],
  ['CLIENTES', 'Cobranzas de clientes (depósitos, transferencias recibidas)'],
  ['SUELDOS', 'Sueldos y cargas sociales'],
  ['SERVICIOS', 'Servicios (luz, gas, teléfono, internet, alquiler, seguros)'],
  ['IMPUESTOS_ARCA', 'Pagos a ARCA / AFIP / ARBA (IVA, ganancias, monotributo, etc.)'],
  ['PRESTAMOS', 'Préstamos y tarjetas (cuotas, acreditaciones)'],
  ['TRANSF_PROPIAS', 'Transferencias entre cuentas propias'],
  ['SOCIOS', 'Retiros o aportes de socios'],
  ['REVISAR', 'No se pudo clasificar con seguridad: revisar a mano']
];

const SYSTEM = `Sos un asistente contable que lee extractos bancarios argentinos para un estudio contable. `
  + `Extraé TODOS los movimientos del extracto, en el orden en que aparecen, sin omitir ni inventar ninguno. `
  + `Ignorá portadas, publicidad, textos legales y resúmenes que no sean movimientos. `
  + `Importes con signo: negativo = débito (sale plata), positivo = crédito (entra plata). `
  + `Convertí los números argentinos (1.234.567,89) a número decimal (1234567.89). `
  + `Fechas en formato AAAA-MM-DD, deduciendo el año del período del extracto. `
  + `Si una línea de movimiento continúa en la siguiente, unila en una sola descripción corta. `
  + `Para cada movimiento elegí el código de cuenta de la lista; si dudás, usá REVISAR. `
  + `Cuentas disponibles:\n` + CUENTAS.map(([c, d]) => `- ${c}: ${d}`).join('\n');

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    banco: { type: 'STRING' },
    cuenta: { type: 'STRING' },
    saldo_inicial: { type: 'NUMBER', nullable: true },
    saldo_final: { type: 'NUMBER', nullable: true },
    mov: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        // claves cortas para gastar menos tokens de salida
        properties: {
          f: { type: 'STRING' },                 // fecha AAAA-MM-DD
          d: { type: 'STRING' },                 // descripción
          i: { type: 'NUMBER' },                 // importe con signo
          s: { type: 'NUMBER', nullable: true }, // saldo después del movimiento, si figura
          c: { type: 'STRING', enum: CUENTAS.map(c => c[0]) }
        },
        required: ['f', 'd', 'i', 'c']
      }
    }
  },
  required: ['mov']
};

const r2 = n => Math.round(n * 100) / 100;

// Controla que lo leído sea coherente con los saldos del propio extracto.
function verificar(res) {
  const mov = res.mov || [];
  const avisos = [];
  const filasConProblema = [];
  const total = r2(mov.reduce((a, m) => a + (m.i || 0), 0));
  let saldoOk = null, diferencia = null;
  if (typeof res.saldo_inicial === 'number' && typeof res.saldo_final === 'number') {
    diferencia = r2(res.saldo_inicial + total - res.saldo_final);
    saldoOk = Math.abs(diferencia) < 0.05;
    if (!saldoOk) avisos.push(`La suma de los movimientos no coincide con los saldos del extracto (diferencia de ${diferencia}). Puede faltar o sobrar algún movimiento.`);
  } else {
    avisos.push('No se pudo leer el saldo inicial o final: no se pudo verificar el total.');
  }
  // Saldo corrido: donde el extracto informa saldo, debe ser el anterior + importe.
  let prev = typeof res.saldo_inicial === 'number' ? res.saldo_inicial : null;
  mov.forEach((m, idx) => {
    if (typeof m.s === 'number') {
      if (prev !== null && Math.abs(prev + m.i - m.s) > 0.05) filasConProblema.push(idx);
      prev = m.s;
    } else if (prev !== null) {
      prev = r2(prev + m.i);
    }
  });
  if (filasConProblema.length) avisos.push(`${filasConProblema.length} movimiento(s) no cierran con el saldo corrido del extracto (marcados en la tabla).`);
  const aRevisar = mov.filter(m => m.c === 'REVISAR').length;
  if (aRevisar) avisos.push(`${aRevisar} movimiento(s) sin clasificar con seguridad.`);
  return { saldoOk, diferencia, total, filasConProblema, avisos };
}

async function leerExtracto({ base64, mime }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { const e = new Error('Falta configurar GEMINI_API_KEY en Railway'); e.status = 500; throw e; }
  if (!base64) { const e = new Error('Falta el archivo'); e.status = 400; throw e; }
  if (mime !== 'application/pdf' && !String(mime || '').startsWith('image/')) {
    const e = new Error('Solo se pueden leer extractos en PDF o imagen'); e.status = 400; throw e;
  }
  if (Math.floor(base64.length * 0.75) > MAX_BYTES) { const e = new Error('El archivo supera los 15 MB'); e.status = 400; throw e; }

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: mime, data: base64 } },
      { text: 'Leé este extracto bancario y devolvé el JSON pedido.' }
    ] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      maxOutputTokens: 60000,
      thinkingConfig: { thinkingBudget: 0 }   // clasificar no necesita "pensar": ahorra costo
    }
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    console.error('Gemini extractos:', r.status, t.slice(0, 300));
    const e = new Error(r.status === 429 ? 'La IA está saturada o se agotó la cuota. Probá de nuevo en un minuto.' : 'La IA no pudo procesar el extracto (' + r.status + ').');
    e.status = 502; throw e;
  }
  const data = await r.json();
  const cand = (data.candidates || [])[0] || {};
  const texto = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
  let res;
  try { res = JSON.parse(texto); }
  catch (e) {
    const err = new Error(cand.finishReason === 'MAX_TOKENS'
      ? 'El extracto es demasiado largo para leerlo de una vez. Dividilo en partes.'
      : 'La IA devolvió una respuesta que no se pudo interpretar. Probá de nuevo.');
    err.status = 502; throw err;
  }
  const um = data.usageMetadata || {};
  const tin = um.promptTokenCount || 0;
  const tout = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
  const costoUsd = (tin * PRECIO_ENTRADA + tout * PRECIO_SALIDA) / 1e6;
  return {
    banco: res.banco || '', cuenta: res.cuenta || '',
    saldo_inicial: res.saldo_inicial ?? null, saldo_final: res.saldo_final ?? null,
    movimientos: (res.mov || []).map(m => ({ fecha: m.f, descripcion: m.d, importe: m.i, saldo: m.s ?? null, cuenta: m.c })),
    cuentas: CUENTAS.map(([codigo, nombre]) => ({ codigo, nombre })),
    verificacion: verificar(res),
    uso: { modelo: MODELO, tokens_entrada: tin, tokens_salida: tout, costo_usd: Math.round(costoUsd * 10000) / 10000 }
  };
}

module.exports = { leerExtracto, verificar, CUENTAS };
