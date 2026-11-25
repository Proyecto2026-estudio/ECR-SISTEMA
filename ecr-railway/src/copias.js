// ============================================================
//  COPIA DE SEGURIDAD · toda la base (incluidos los archivos de los documentos)
//  en un solo archivo .json.gz que se guarda FUERA de Railway.
//
//  Cómo se descarga:
//   - A mano: el administrador, desde Configuración → "Descargar copia de seguridad".
//   - Automática (por ejemplo, desde el NAS del estudio, todos los días):
//       curl -fsS -H "X-Copia-Token: <BACKUP_TOKEN>" \
//            -o ecr-copia-$(date +%F).json.gz https://ecr-sistema.up.railway.app/api/copia
//     BACKUP_TOKEN es una variable de Railway (una clave larga). Sin esa variable,
//     la descarga automática queda desactivada y solo funciona la manual.
//  Cómo se restaura: scripts/restaurar-copia.js (ver el comentario de ese archivo).
// ============================================================
const zlib = require('zlib');
const crypto = require('crypto');

const LOTE_DOCUMENTOS = 20;   // los documentos se leen de a pocos para no llenar la memoria

function tokenValido(recibido) {
  const esperado = process.env.BACKUP_TOKEN || '';
  if (esperado.length < 24 || !recibido) return false;
  const a = crypto.createHash('sha256').update(String(recibido)).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

// Escribe en el gzip respetando el ritmo de la conexión.
const escribir = (gz, txt) => new Promise(ok => { if (gz.write(txt)) ok(); else gz.once('drain', ok); });

async function generarCopia(db, res) {
  const fecha = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="ecr-copia-${fecha}.json.gz"`);
  res.setHeader('Cache-Control', 'no-store');
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(res);
  const q = (sql, p = []) => db.query({ sql, dateStrings: true }, p);   // fechas como texto: se restauran idénticas
  const [tablas] = await db.query('SHOW TABLES');
  const nombres = tablas.map(t => Object.values(t)[0]);
  const conteo = {};
  await escribir(gz, `{"sistema":"ECR","version":1,"creada_en":${JSON.stringify(new Date().toISOString())},"esquema":{`);
  for (let i = 0; i < nombres.length; i++) {
    const [[c]] = await db.query('SHOW CREATE TABLE `' + nombres[i] + '`');
    await escribir(gz, (i ? ',' : '') + JSON.stringify(nombres[i]) + ':' + JSON.stringify(c['Create Table']));
  }
  await escribir(gz, '},"datos":{');
  for (let i = 0; i < nombres.length; i++) {
    const t = nombres[i];
    await escribir(gz, (i ? ',' : '') + JSON.stringify(t) + ':[');
    let n = 0;
    if (t === 'documentos') {
      let ultimo = 0;
      for (;;) {
        const [filas] = await q('SELECT * FROM documentos WHERE id > ? ORDER BY id LIMIT ' + LOTE_DOCUMENTOS, [ultimo]);
        if (!filas.length) break;
        for (const f of filas) { await escribir(gz, (n ? ',' : '') + JSON.stringify(f)); n++; }
        ultimo = filas[filas.length - 1].id;
      }
    } else {
      const [filas] = await q('SELECT * FROM `' + t + '`');
      for (const f of filas) { await escribir(gz, (n ? ',' : '') + JSON.stringify(f)); n++; }
    }
    conteo[t] = n;
    await escribir(gz, ']');
  }
  await escribir(gz, '},"conteo":' + JSON.stringify(conteo) + '}');
  await new Promise(ok => gz.end(ok));
  return conteo;
}

module.exports = { generarCopia, tokenValido };
