// ============================================================
//  Aviso por mail AL ESTUDIO cuando un vencimiento vence en 7 días.
//  - Corre una vez al día (a partir de las 8:00, hora de Argentina).
//  - Un mismo vencimiento se avisa una sola vez (tabla alertas_enviadas).
//  - Envía con Resend (https://resend.com) usando variables de entorno:
//      RESEND_API_KEY      clave de la API
//      ALERTAS_MAIL_PARA   mail del estudio que recibe el aviso (admite varios, separados por coma)
//      ALERTAS_MAIL_DE     remitente (opcional; por defecto onboarding@resend.dev)
// ============================================================
const DIAS_AVISO = 7;
const TZ = 'America/Argentina/Buenos_Aires';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Fecha de hoy en Argentina como 'AAAA-MM-DD' y hora actual (0-23)
function ahoraAR() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: +p.hour };
}
function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fechaAR = iso => iso.split('-').reverse().join('/');

function configurado() {
  return !!(process.env.RESEND_API_KEY && process.env.ALERTAS_MAIL_PARA);
}

async function enviarMail({ asunto, html, texto }) {
  const para = process.env.ALERTAS_MAIL_PARA.split(/[,;\s]+/).filter(Boolean);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({ from: process.env.ALERTAS_MAIL_DE || 'Sistema ECR <onboarding@resend.dev>', to: para, subject: asunto, html, text: texto })
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

// Arma el mail: un renglón por vencimiento; si el mismo vencimiento es de muchos clientes, los junta.
function armarMail(filas, fechaVence) {
  const grupos = new Map();
  filas.forEach(v => {
    const k = v.descripcion + '|' + v.tipo;
    if (!grupos.has(k)) grupos.set(k, { descripcion: v.descripcion, tipo: v.tipo, clientes: [], general: false });
    const g = grupos.get(k);
    if (v.cliente_nombre) g.clientes.push(v.cliente_nombre); else g.general = true;
  });
  const lista = [...grupos.values()];
  const detalle = g => g.general && !g.clientes.length ? 'General del estudio'
    : (g.clientes.length > 6 ? `${g.clientes.length} clientes` : g.clientes.join(', ')) + (g.general ? ' + general del estudio' : '');
  const asunto = lista.length === 1
    ? `Vence en ${DIAS_AVISO} días: ${lista[0].descripcion} (${fechaAR(fechaVence)})`
    : `Vencen en ${DIAS_AVISO} días: ${lista.length} vencimientos (${fechaAR(fechaVence)})`;
  const texto = `Estos vencimientos vencen en ${DIAS_AVISO} días (${fechaAR(fechaVence)}):\n\n` +
    lista.map(g => `- ${g.descripcion} [${g.tipo}] — ${detalle(g)}`).join('\n') + '\n\nSistema ECR · https://ecr-sistema.up.railway.app';
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1b2430">
    <h2 style="margin:0 0 6px;color:#8a6d1d">⏰ Vencen en ${DIAS_AVISO} días</h2>
    <p style="margin:0 0 14px;color:#555">Fecha de vencimiento: <b>${fechaAR(fechaVence)}</b></p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      ${lista.map(g => `<tr><td style="padding:8px 10px;border-bottom:1px solid #e5e0d3"><b>${esc(g.descripcion)}</b> <span style="color:#777">(${esc(g.tipo)})</span><br><span style="color:#555">${esc(detalle(g))}</span></td></tr>`).join('')}
    </table>
    <p style="margin:16px 0 0"><a href="https://ecr-sistema.up.railway.app" style="background:#1b2430;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Abrir el sistema</a></p>
  </div>`;
  return { asunto, html, texto };
}

// Busca los vencimientos que vencen dentro de 7 días y todavía no se avisaron; manda UN mail con todos.
async function enviarAlertas(db) {
  if (!configurado()) return { enviado: false, motivo: 'Faltan RESEND_API_KEY y/o ALERTAS_MAIL_PARA en las variables del servidor' };
  const objetivo = sumarDias(ahoraAR().fecha, DIAS_AVISO);
  const [filas] = await db.query(
    `SELECT v.id, v.descripcion, v.tipo, c.nombre AS cliente_nombre
       FROM vencimientos v
       LEFT JOIN clientes c ON v.cliente_id = c.id
       LEFT JOIN alertas_enviadas a ON a.venc_id = v.id AND a.dias = ?
      WHERE DATE(v.fecha) = ? AND v.estado <> 'Cumplido' AND a.venc_id IS NULL
      ORDER BY v.descripcion, c.nombre`, [DIAS_AVISO, objetivo]);
  if (!filas.length) return { enviado: false, motivo: 'No hay vencimientos nuevos para avisar', fecha: objetivo };
  await enviarMail(armarMail(filas, objetivo));
  for (const v of filas) await db.query('INSERT IGNORE INTO alertas_enviadas (venc_id, dias) VALUES (?, ?)', [v.id, DIAS_AVISO]);
  return { enviado: true, vencimientos: filas.length, fecha: objetivo };
}

async function enviarPrueba() {
  if (!configurado()) return { enviado: false, motivo: 'Faltan RESEND_API_KEY y/o ALERTAS_MAIL_PARA en las variables del servidor' };
  await enviarMail({
    asunto: 'Prueba de alertas · Sistema ECR',
    texto: 'Este es un mail de prueba. Si lo recibiste, las alertas de vencimientos están bien configuradas.',
    html: '<p style="font-family:Arial,sans-serif">Este es un mail de prueba del <b>Sistema ECR</b>. Si lo recibiste, las alertas de vencimientos están bien configuradas.</p>'
  });
  return { enviado: true, prueba: true };
}

async function tarea(db) {
  try {
    if (ahoraAR().hora < 8) return;           // el aviso sale a partir de las 8:00
    const r = await enviarAlertas(db);
    if (r.enviado) console.log(`Alertas: mail enviado con ${r.vencimientos} vencimiento(s) del ${r.fecha}`);
  } catch (e) { console.error('Alertas por mail:', e.message); }
}

function iniciar(db) {
  if (!configurado()) console.log('Alertas por mail: desactivadas (faltan RESEND_API_KEY y ALERTAS_MAIL_PARA)');
  setTimeout(() => tarea(db), 60 * 1000);
  setInterval(() => tarea(db), 30 * 60 * 1000);
}

module.exports = { iniciar, enviarAlertas, enviarPrueba, armarMail, sumarDias, DIAS_AVISO };
