// ============================================================
//  SEGURIDAD · enlaces de activación, registro de actividad y
//  límite de intentos (recomendaciones del informe MSC, nov 2026)
// ============================================================
const crypto = require('crypto');
const { enviarMail, mailDisponible, esc } = require('./alertas');

// ── Enlaces únicos (activación de cuenta y cambio de contraseña) ──
// En la base se guarda solo el hash SHA-256 del enlace: quien lea la base no puede usarlo.
const VIGENCIA_HORAS = { activacion: 72, recuperacion: 2 };
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

async function crearEnlace(db, usuarioId, tipo) {
  // Un enlace nuevo invalida los anteriores del mismo tipo para ese usuario.
  await db.query('UPDATE tokens_acceso SET usado_en = NOW() WHERE usuario_id = ? AND tipo = ? AND usado_en IS NULL', [usuarioId, tipo]);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    'INSERT INTO tokens_acceso (usuario_id, tipo, token_hash, vence_en) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
    [usuarioId, tipo, hashToken(token), VIGENCIA_HORAS[tipo]]);
  return token;
}

// Devuelve { usuario, tipo, id } si el enlace es válido, o { error }.
async function leerEnlace(db, token) {
  if (!token || String(token).length < 20) return { error: 'El enlace no es válido.' };
  const [r] = await db.query(
    `SELECT t.id, t.tipo, t.usado_en, t.vence_en < NOW() AS vencido, u.id AS uid, u.nombre, u.email
       FROM tokens_acceso t JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.token_hash = ?`, [hashToken(token)]);
  if (!r.length) return { error: 'El enlace no es válido. Pedí uno nuevo al estudio.' };
  const t = r[0];
  if (t.usado_en) return { error: 'Este enlace ya se usó o fue reemplazado por uno más nuevo. Pedí uno nuevo.' };
  if (t.vencido) return { error: 'El enlace venció. Pedí uno nuevo.' };
  return { id: t.id, tipo: t.tipo, usuario: { id: t.uid, nombre: t.nombre, email: t.email } };
}

const usarEnlace = (db, id) => db.query('UPDATE tokens_acceso SET usado_en = NOW() WHERE id = ?', [id]);

// Contraseña: al menos 8 caracteres, con letras y números.
function problemaPassword(p) {
  p = String(p || '');
  if (p.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (p.length > 100) return 'La contraseña es demasiado larga.';
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(p) || !/\d/.test(p)) return 'La contraseña debe combinar letras y números.';
  return null;
}

// Dirección pública del sistema, para armar los enlaces de los mails.
const baseUrl = req => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

function mailEnlace({ tipo, nombre, enlace }) {
  const activar = tipo === 'activacion';
  const asunto = activar ? 'Bienvenido al Sistema ECR · activá tu cuenta' : 'Sistema ECR · cambiar tu contraseña';
  const vence = activar ? '72 horas' : '2 horas';
  const intro = activar
    ? 'El Estudio Casil Rodríguez te creó un usuario en el Sistema ECR. Para empezar a usarlo, elegí tu contraseña con este enlace:'
    : 'Pediste cambiar la contraseña del Sistema ECR. Elegí una nueva con este enlace:';
  const boton = activar ? 'Activar mi cuenta' : 'Elegir contraseña nueva';
  const pie = activar ? '' : 'Si no lo pediste vos, ignorá este mail: tu contraseña actual sigue funcionando.';
  const texto = `Hola ${nombre}:\n\n${intro}\n\n${enlace}\n\nEl enlace sirve una sola vez y vence en ${vence}.\n${pie}\n\nEstudio Casil Rodríguez`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1b2430">
    <h2 style="margin:0 0 10px;color:#8a6d1d">${activar ? 'Bienvenido/a al Sistema ECR' : 'Cambiar tu contraseña'}</h2>
    <p>Hola ${esc(nombre)}:</p><p>${intro}</p>
    <p style="margin:18px 0"><a href="${esc(enlace)}" style="background:#1b2430;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${boton}</a></p>
    <p style="color:#555;font-size:13px">El enlace sirve una sola vez y vence en ${vence}. ${pie}</p>
    <p style="color:#888;font-size:12px">Si el botón no funciona, copiá esta dirección en el navegador:<br>${esc(enlace)}</p>
  </div>`;
  return { asunto, html, texto };
}

// Crea el enlace y trata de mandarlo por mail. Si el mail no sale, devuelve el enlace
// para que el administrador lo envíe por otro medio (nunca se pierde el alta).
async function enviarEnlace(db, req, usuario, tipo) {
  const token = await crearEnlace(db, usuario.id, tipo);
  // El código va después de "#": el navegador no lo manda al pedir la página, así no queda en los registros del servidor.
  const enlace = `${baseUrl(req)}/activar.html#t=${token}`;
  if (!mailDisponible()) return { mail_enviado: false, enlace, motivo: 'No hay servicio de mail configurado' };
  try {
    await enviarMail({ ...mailEnlace({ tipo, nombre: usuario.nombre, enlace }), destino: usuario.email });
    return { mail_enviado: true, enlace };
  } catch (e) {
    console.error('Mail de enlace (' + tipo + '):', e.message);
    return { mail_enviado: false, enlace, motivo: e.message };
  }
}

// ── Registro de actividad (historial de accesos y de cambios) ──
const ipDe = req => String(req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0] || '').slice(0, 64);
async function registrar(db, req, accion, detalle, usuarioId) {
  try {
    const uid = usuarioId !== undefined ? usuarioId : (req.usuario ? req.usuario.id : null);
    await db.query('INSERT INTO auditoria (usuario_id, accion, detalle, ip) VALUES (?, ?, ?, ?)',
      [uid || null, String(accion).slice(0, 40), detalle == null ? null : String(detalle).slice(0, 500), ipDe(req)]);
  } catch (e) { console.error('Auditoría:', e.message); }   // registrar nunca debe frenar la operación
}

// ── Límite de intentos (contra pruebas de contraseñas por fuerza bruta) ──
// En memoria: alcanza para un solo servidor. Clave = IP + correo.
const intentos = new Map();
function limitar(clave, max, minutos) {
  const ahora = Date.now(), ventana = minutos * 60 * 1000;
  const lista = (intentos.get(clave) || []).filter(t => ahora - t < ventana);
  if (lista.length >= max) { intentos.set(clave, lista); return Math.ceil((ventana - (ahora - lista[0])) / 60000); }
  lista.push(ahora); intentos.set(clave, lista);
  return 0;
}
const limpiarIntentos = clave => intentos.delete(clave);
setInterval(() => { const ahora = Date.now(); for (const [k, l] of intentos) if (!l.some(t => ahora - t < 60 * 60 * 1000)) intentos.delete(k); }, 15 * 60 * 1000).unref();

module.exports = { crearEnlace, leerEnlace, usarEnlace, enviarEnlace, problemaPassword, registrar, limitar, limpiarIntentos, ipDe, hashToken };
