// ============================================================
//  RF08 – Lectura de extractos bancarios (PDF, imagen o CSV)
//  La IA y las reglas SOLO proponen: el servidor verifica los saldos
//  y el contador revisa y confirma. Nada se imputa por sí solo.
//
//  Orden de clasificación (recomendación del informe MSC, nov 2026):
//   1. Reglas del estudio (tabla reglas_extracto): confianza alta.
//   2. IA (Gemini) solo para lo que ninguna regla reconoce, con
//      nivel de confianza y motivo de cada propuesta.
//  Las categorías son genéricas; cada cliente puede tener su
//  equivalencia con su propio plan de cuentas (equivalencias_cuentas).
// ============================================================
const MODELO = process.env.GEMINI_MODEL_EXTRACTOS || 'gemini-2.5-flash';
// Precios en USD por millón de tokens (gemini-2.5-flash, nivel pago)
const PRECIO_ENTRADA = 0.30;
const PRECIO_SALIDA = 2.50;
const MAX_BYTES = 15 * 1024 * 1024;

// Catálogo genérico de categorías (no es un plan de cuentas: cada cliente tiene sus equivalencias).
const CATEGORIAS = [
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
  ['INVERSIONES', 'Inversiones (plazos fijos, fondos comunes, rescates)'],
  ['REINTEGROS', 'Reintegros, devoluciones y contracargos'],
  ['SOCIOS', 'Retiros o aportes de socios'],
  ['REVISAR', 'No se pudo clasificar con seguridad: revisar a mano']
];
const CODIGOS = CATEGORIAS.map(c => c[0]);

// Reglas iniciales: se cargan una sola vez en la base y el estudio las puede editar o borrar.
const REGLAS_INICIALES = [
  ['LEY 25413', 'IMP_CHEQUE'], ['IMP DEB', 'IMP_CHEQUE'], ['IMP CRED', 'IMP_CHEQUE'], ['IMPUESTO DEBITOS', 'IMP_CHEQUE'], ['IMPUESTO CREDITOS', 'IMP_CHEQUE'],
  ['SELLOS', 'SELLOS'],
  ['PERCEPCION', 'IMP_OTROS'], ['RETENCION', 'IMP_OTROS'], ['IIBB', 'IMP_OTROS'], ['INGRESOS BRUTOS', 'IMP_OTROS'], ['SIRCREB', 'IMP_OTROS'],
  ['COMISION', 'COMISIONES'], ['MANTENIMIENTO', 'COMISIONES'], ['GASTOS BANC', 'COMISIONES'],
  ['INTERES', 'INTERESES'],
  ['AFIP', 'IMPUESTOS_ARCA'], ['ARCA', 'IMPUESTOS_ARCA'], ['VEP', 'IMPUESTOS_ARCA'], ['ARBA', 'IMPUESTOS_ARCA'], ['MONOTRIBUTO', 'IMPUESTOS_ARCA'],
  ['HABERES', 'SUELDOS'], ['SUELDO', 'SUELDOS'], ['F931', 'SUELDOS'],
  ['PLAZO FIJO', 'INVERSIONES'], ['FCI', 'INVERSIONES'], ['FONDO COMUN', 'INVERSIONES'], ['RESCATE', 'INVERSIONES'], ['SUSCRIPCION', 'INVERSIONES'],
  ['REINTEGRO', 'REINTEGROS'], ['DEVOLUCION', 'REINTEGROS'], ['CONTRACARGO', 'REINTEGROS'],
  ['EDENOR', 'SERVICIOS'], ['EDESUR', 'SERVICIOS'], ['METROGAS', 'SERVICIOS'], ['NATURGY', 'SERVICIOS'], ['AYSA', 'SERVICIOS'], ['TELECOM', 'SERVICIOS'], ['MOVISTAR', 'SERVICIOS'],
  ['CUOTA PRESTAMO', 'PRESTAMOS'], ['PAGO TARJETA', 'PRESTAMOS']
];

async function sembrarReglas(db) {
  const [n] = await db.query('SELECT COUNT(*) AS n FROM reglas_extracto');
  if (n[0].n > 0) return;
  for (const [patron, categoria] of REGLAS_INICIALES)
    await db.query('INSERT INTO reglas_extracto (patron, categoria) VALUES (?, ?)', [patron, categoria]);
  console.log(`Extractos: ${REGLAS_INICIALES.length} reglas iniciales cargadas`);
}

// Texto comparable: mayúsculas, sin acentos, sin signos, espacios simples.
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\./g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// La regla más específica (patrón más largo) gana.
function buscarRegla(desc, reglas) {
  const d = ' ' + norm(desc) + ' ';
  let mejor = null;
  for (const r of reglas) {
    const p = norm(r.patron);
    // El patrón tiene que coincidir desde el principio de una palabra: "INTERES" reconoce "INTERESES",
    // pero "CLARO" no reconoce "DECLARO".
    if (p && d.includes(' ' + p) && (!mejor || p.length > norm(mejor.patron).length)) mejor = r;
  }
  return mejor;
}

const r2 = n => Math.round(n * 100) / 100;

// ── CSV ──────────────────────────────────────────────────
// Números argentinos o internacionales: 1.234,56 · 1,234.56 · -1234.56 · (1.234,56)
function numero(v) {
  let t = String(v == null ? '' : v).trim().replace(/\s|\$|U\$S|USD|ARS/gi, '');
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  const coma = t.lastIndexOf(','), punto = t.lastIndexOf('.');
  if (coma > punto) t = t.replace(/\./g, '').replace(',', '.');
  else if (punto > coma && coma >= 0) t = t.replace(/,/g, '');
  else if (coma < 0 && (t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
  const n = Number(t);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}
function fecha(v) {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return null;
}
function separarLinea(linea, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '"') { if (q && linea[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim());
}
const COLS = {
  fecha: /^(fecha|fec|fecha mov|fecha operacion|fecha valor)/,
  desc: /(concepto|descripcion|detalle|movimiento|referencia|leyenda)/,
  debito: /(debito|debe|egreso|retiro)/,
  credito: /(credito|haber|ingreso|deposito)/,
  importe: /(importe|monto|valor)/,
  saldo: /^saldo/
};
function leerCSV(texto) {
  const lineas = String(texto).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lineas.length < 2) throw Object.assign(new Error('El CSV está vacío o tiene una sola línea'), { status: 400 });
  const sep = [';', '\t', ','].map(s => [s, lineas.slice(0, 15).reduce((a, l) => a + separarLinea(l, s).length, 0)]).sort((a, b) => b[1] - a[1])[0][0];
  // Encabezado: la primera línea que tenga columna de fecha y de importe/débito/crédito.
  let hi = -1, idx = null;
  for (let i = 0; i < Math.min(lineas.length, 30); i++) {
    const cab = separarLinea(lineas[i], sep).map(c => norm(c).toLowerCase());
    const f = k => cab.findIndex(c => COLS[k].test(c));
    const cand = { fecha: f('fecha'), desc: f('desc'), debito: f('debito'), credito: f('credito'), importe: f('importe'), saldo: f('saldo') };
    if (cand.fecha >= 0 && (cand.importe >= 0 || cand.debito >= 0 || cand.credito >= 0)) { hi = i; idx = cand; break; }
  }
  if (hi < 0) throw Object.assign(new Error('No se encontró el encabezado del CSV (tiene que tener columnas de Fecha y de Importe o Débito/Crédito)'), { status: 400 });
  const pre = lineas.slice(0, hi).map(l => separarLinea(l, sep).filter(Boolean).join(' ').trim());
  const preambulo = pre.join(' ');
  const mov = [];
  for (const l of lineas.slice(hi + 1)) {
    const c = separarLinea(l, sep);
    const f = fecha(c[idx.fecha]);
    if (!f) continue;   // totales, subtítulos o líneas en blanco
    let imp = null;
    if (idx.importe >= 0) imp = numero(c[idx.importe]);
    if (imp === null && (idx.debito >= 0 || idx.credito >= 0)) {
      const d = idx.debito >= 0 ? numero(c[idx.debito]) : null, cr = idx.credito >= 0 ? numero(c[idx.credito]) : null;
      if (d === null && cr === null) continue;
      imp = (cr ? Math.abs(cr) : 0) - (d ? Math.abs(d) : 0);
    }
    if (imp === null) continue;
    const desc = idx.desc >= 0 ? c[idx.desc] : c.filter((_, j) => ![idx.fecha, idx.importe, idx.debito, idx.credito, idx.saldo].includes(j)).join(' ');
    mov.push({ f, d: String(desc || '').slice(0, 200), i: r2(imp), s: idx.saldo >= 0 ? numero(c[idx.saldo]) : null });
  }
  if (!mov.length) throw Object.assign(new Error('El CSV no tiene movimientos con fecha e importe'), { status: 400 });
  if (mov.length > 1 && mov[0].f > mov[mov.length - 1].f) mov.reverse();   // algunos bancos listan del más nuevo al más viejo
  const conSaldo = mov.filter(m => typeof m.s === 'number');
  const res = {
    banco: (pre.find(l => /\bbanco\b/i.test(l)) || '').slice(0, 60),
    cuenta: (pre.find(l => /\b(cuenta|cta|cbu)\b/i.test(l)) || '').slice(0, 80),
    moneda: /(u\$s|usd|dolar)/i.test(preambulo + ' ' + lineas[hi]) ? 'USD' : 'ARS',
    saldo_inicial: conSaldo.length ? r2(conSaldo[0].s - conSaldo[0].i) : null,
    saldo_final: conSaldo.length ? conSaldo[conSaldo.length - 1].s : null,
    mov
  };
  return res;
}

// ── IA ───────────────────────────────────────────────────
const LISTA_CAT = CATEGORIAS.map(([c, d]) => `- ${c}: ${d}`).join('\n');
const SYSTEM_PDF = `Sos un asistente contable que lee extractos bancarios argentinos para un estudio contable. `
  + `Extraé TODOS los movimientos del extracto, en el orden en que aparecen, sin omitir ni inventar ninguno. `
  + `Ignorá portadas, publicidad, textos legales y resúmenes que no sean movimientos. `
  + `Importes con signo: negativo = débito (sale plata), positivo = crédito (entra plata). `
  + `Convertí los números argentinos (1.234.567,89) a número decimal (1234567.89). `
  + `Fechas en formato AAAA-MM-DD, deduciendo el año del período del extracto. `
  + `Si una línea de movimiento continúa en la siguiente, unila en una sola descripción corta. `
  + `Indicá banco, número de cuenta, moneda (ARS o USD) y período (desde y hasta) del extracto. `
  + `Para cada movimiento elegí la categoría de la lista, tu confianza (alta, media o baja) y un motivo de hasta 8 palabras. `
  + `Si dudás, usá REVISAR con confianza baja. No inventes datos que no estén en el extracto. `
  + `Categorías:\n` + LISTA_CAT;
const SYSTEM_CLASIF = `Sos un asistente contable de un estudio argentino. Te paso movimientos bancarios (número|descripción|importe; `
  + `negativo = débito, positivo = crédito). Para cada uno elegí la categoría de la lista, tu confianza (alta, media o baja) `
  + `y un motivo de hasta 8 palabras. Si dudás, usá REVISAR con confianza baja. Devolvé un elemento por cada número recibido.\n`
  + `Categorías:\n` + LISTA_CAT;

const SCHEMA_MOV_CLASIF = { c: { type: 'STRING', enum: CODIGOS }, k: { type: 'STRING', enum: ['alta', 'media', 'baja'] }, m: { type: 'STRING' } };
const SCHEMA_PDF = {
  type: 'OBJECT',
  properties: {
    banco: { type: 'STRING' }, cuenta: { type: 'STRING' }, moneda: { type: 'STRING' },
    desde: { type: 'STRING', nullable: true }, hasta: { type: 'STRING', nullable: true },
    saldo_inicial: { type: 'NUMBER', nullable: true }, saldo_final: { type: 'NUMBER', nullable: true },
    mov: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        // claves cortas para gastar menos tokens de salida
        properties: { f: { type: 'STRING' }, d: { type: 'STRING' }, i: { type: 'NUMBER' }, s: { type: 'NUMBER', nullable: true }, ...SCHEMA_MOV_CLASIF },
        required: ['f', 'd', 'i', 'c', 'k']
      }
    }
  },
  required: ['mov']
};
const SCHEMA_CLASIF = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { n: { type: 'INTEGER' }, ...SCHEMA_MOV_CLASIF }, required: ['n', 'c', 'k'] }
};

async function gemini(parts, system, schema) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error('Falta configurar GEMINI_API_KEY en Railway'), { status: 500 });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 60000, thinkingConfig: { thinkingBudget: 0 } }
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(170000)
  });
  if (!r.ok) {
    const t = await r.text();
    console.error('Gemini extractos:', r.status, t.slice(0, 300));
    throw Object.assign(new Error(r.status === 429 ? 'La IA está saturada o se agotó la cuota. Probá de nuevo en un minuto.' : 'La IA no pudo procesar el extracto (' + r.status + ').'), { status: 502 });
  }
  const data = await r.json();
  const cand = (data.candidates || [])[0] || {};
  const texto = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
  let res;
  try { res = JSON.parse(texto); }
  catch (e) {
    throw Object.assign(new Error(cand.finishReason === 'MAX_TOKENS'
      ? 'El extracto es demasiado largo para leerlo de una vez. Dividilo en partes.'
      : 'La IA devolvió una respuesta que no se pudo interpretar. Probá de nuevo.'), { status: 502 });
  }
  const um = data.usageMetadata || {};
  const tin = um.promptTokenCount || 0, tout = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
  return { res, tin, tout };
}

// ── Controles ────────────────────────────────────────────
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
  const baja = mov.filter(m => m.k === 'baja' && m.c !== 'REVISAR').length;
  if (baja) avisos.push(`${baja} movimiento(s) con confianza baja: revisalos antes de confirmar.`);
  // Posibles duplicados: misma fecha, mismo importe y misma descripción.
  const vistos = new Map(), duplicados = [];
  mov.forEach((m, idx) => {
    const k = m.f + '|' + m.i + '|' + norm(m.d);
    if (vistos.has(k)) { duplicados.push(idx); if (!duplicados.includes(vistos.get(k))) duplicados.push(vistos.get(k)); }
    else vistos.set(k, idx);
  });
  if (duplicados.length) avisos.push(`${duplicados.length} movimiento(s) repetidos (misma fecha, importe y descripción): pueden ser reales o un error de lectura; controlalos.`);
  return { saldoOk, diferencia, total, filasConProblema, duplicados: duplicados.sort((a, b) => a - b), avisos };
}

// ── Lectura principal ────────────────────────────────────
// reglas: [{ id, patron, categoria }] · equivalencias: { CATEGORIA: 'cuenta del cliente' }
async function leerExtracto({ base64, mime, nombre, reglas = [], equivalencias = {} }) {
  if (!base64) throw Object.assign(new Error('Falta el archivo'), { status: 400 });
  if (Math.floor(base64.length * 0.75) > MAX_BYTES) throw Object.assign(new Error('El archivo supera los 15 MB'), { status: 400 });
  const esCSV = /csv|text\/plain|excel/.test(String(mime || '')) || /\.(csv|txt)$/i.test(String(nombre || ''));
  const esPDF = mime === 'application/pdf' || String(mime || '').startsWith('image/');
  if (!esCSV && !esPDF) throw Object.assign(new Error('Solo se pueden leer extractos en PDF, imagen o CSV'), { status: 400 });

  let res, tin = 0, tout = 0, porIA = 0;
  if (esCSV) {
    const buf = Buffer.from(base64, 'base64');
    let texto = buf.toString('utf8');
    if (texto.includes('�')) texto = buf.toString('latin1');   // CSV de Excel en Windows
    res = leerCSV(texto);
  } else {
    const g = await gemini([{ inlineData: { mimeType: mime, data: base64 } }, { text: 'Leé este extracto bancario y devolvé el JSON pedido.' }], SYSTEM_PDF, SCHEMA_PDF);
    res = g.res; tin += g.tin; tout += g.tout;
    res.mov = (res.mov || []).map(m => ({ ...m, origen: 'ia' }));
  }

  // 1. Reglas del estudio (pisan a la IA).
  let porReglas = 0;
  res.mov.forEach(m => {
    const r = buscarRegla(m.d, reglas);
    if (r) { m.c = r.categoria; m.k = 'alta'; m.m = `Regla del estudio: "${r.patron}"`; m.origen = 'regla'; porReglas++; }
  });

  // 2. CSV: la IA clasifica solo lo que ninguna regla reconoció (descripciones únicas, para gastar menos).
  if (esCSV) {
    const pend = res.mov.filter(m => !m.origen);
    if (pend.length) {
      const unicos = [...new Map(pend.map(m => [norm(m.d) + '|' + Math.sign(m.i), m])).values()];
      try {
        const lista = unicos.map((m, n) => `${n}|${m.d}|${m.i}`).join('\n');
        const g = await gemini([{ text: lista }], SYSTEM_CLASIF, SCHEMA_CLASIF);
        tin += g.tin; tout += g.tout;
        const porN = new Map((Array.isArray(g.res) ? g.res : []).map(x => [x.n, x]));
        const clave = new Map(unicos.map((m, n) => [norm(m.d) + '|' + Math.sign(m.i), porN.get(n)]));
        pend.forEach(m => {
          const x = clave.get(norm(m.d) + '|' + Math.sign(m.i));
          if (x && CODIGOS.includes(x.c)) { m.c = x.c; m.k = x.k || 'media'; m.m = x.m || ''; m.origen = 'ia'; }
        });
      } catch (e) {
        console.error('Extractos CSV, clasificación IA:', e.message);
        res.avisoIA = 'La IA no estuvo disponible: los movimientos que ninguna regla reconoce quedan para revisar a mano. (' + e.message + ')';
      }
      pend.forEach(m => { if (!m.origen) { m.c = 'REVISAR'; m.k = 'baja'; m.m = 'Ninguna regla lo reconoce'; m.origen = 'sin_clasificar'; } });
    }
  }
  res.mov.forEach(m => {
    if (!CODIGOS.includes(m.c)) m.c = 'REVISAR';
    if (!['alta', 'media', 'baja'].includes(m.k)) m.k = m.c === 'REVISAR' ? 'baja' : 'media';
    if (m.origen === 'ia') porIA++;
  });

  const fechas = res.mov.map(m => m.f).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort();
  const desde = fecha(res.desde) || fechas[0] || null, hasta = fecha(res.hasta) || fechas[fechas.length - 1] || null;
  const verificacion = verificar(res);
  if (res.avisoIA) verificacion.avisos.unshift(res.avisoIA);
  const costoUsd = (tin * PRECIO_ENTRADA + tout * PRECIO_SALIDA) / 1e6;
  return {
    formato: esCSV ? 'csv' : 'pdf',
    banco: res.banco || '', cuenta: res.cuenta || '', moneda: (String(res.moneda || '').toUpperCase().includes('USD') ? 'USD' : 'ARS'),
    desde, hasta,
    saldo_inicial: res.saldo_inicial ?? null, saldo_final: res.saldo_final ?? null,
    movimientos: res.mov.map(m => ({
      fecha: m.f, descripcion: m.d, importe: m.i, saldo: m.s ?? null,
      cuenta: m.c, confianza: m.k, motivo: m.m || '', origen: m.origen,
      cuenta_cliente: equivalencias[m.c] || ''
    })),
    cuentas: CATEGORIAS.map(([codigo, nombre]) => ({ codigo, nombre, cuenta_cliente: equivalencias[codigo] || '' })),
    verificacion,
    resumen: { por_reglas: porReglas, por_ia: porIA, sin_clasificar: res.mov.filter(m => m.c === 'REVISAR').length },
    uso: { modelo: tin ? MODELO : 'sin IA', tokens_entrada: tin, tokens_salida: tout, costo_usd: Math.round(costoUsd * 10000) / 10000 }
  };
}

module.exports = { leerExtracto, verificar, leerCSV, buscarRegla, sembrarReglas, CATEGORIAS, CUENTAS: CATEGORIAS, CODIGOS, numero, fecha };
