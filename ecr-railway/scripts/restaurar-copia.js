#!/usr/bin/env node
// ============================================================
//  Restaura una copia de seguridad (.json.gz) del Sistema ECR en una base MySQL.
//
//  Uso (desde la carpeta ecr-railway, con las variables MYSQL* de la base DESTINO):
//     node scripts/restaurar-copia.js ecr-copia-2026-11-25.json.gz
//
//  - Por seguridad, solo restaura en una base VACÍA (sin las tablas del sistema).
//  - Con --reemplazar borra las tablas existentes antes de restaurar. Usalo solo si
//    estás seguro: lo que haya en la base destino se pierde.
//  - Al terminar compara cuántas filas hay en cada tabla con las de la copia.
//  Sirve también para la "prueba de recuperación" mensual que recomienda el informe MSC:
//  restaurar en una base de prueba y comprobar que todo está.
// ============================================================
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const mysql = require('mysql2/promise');

(async () => {
  const archivo = process.argv.find(a => /\.json(\.gz)?$/.test(a));
  const reemplazar = process.argv.includes('--reemplazar');
  if (!archivo) { console.error('Indicá el archivo de copia: node scripts/restaurar-copia.js ecr-copia-AAAA-MM-DD.json.gz'); process.exit(1); }
  let crudo = fs.readFileSync(archivo);
  if (archivo.endsWith('.gz')) crudo = zlib.gunzipSync(crudo);
  const copia = JSON.parse(crudo.toString('utf8'));
  if (copia.sistema !== 'ECR' || !copia.esquema || !copia.datos) { console.error('El archivo no es una copia del Sistema ECR'); process.exit(1); }
  console.log(`Copia del ${copia.creada_en} · tablas: ${Object.keys(copia.datos).join(', ')}`);

  const db = await mysql.createConnection({
    host: process.env.MYSQLHOST, database: process.env.MYSQLDATABASE, user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD, port: process.env.MYSQLPORT || 3306, dateStrings: true, multipleStatements: false
  });
  const [existentes] = await db.query('SHOW TABLES');
  const hay = new Set(existentes.map(t => Object.values(t)[0]));
  const choque = Object.keys(copia.esquema).filter(t => hay.has(t));
  if (choque.length && !reemplazar) {
    console.error(`La base destino ya tiene tablas del sistema (${choque.join(', ')}). Usá una base vacía, o agregá --reemplazar para borrarlas.`);
    process.exit(2);
  }
  await db.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of Object.keys(copia.esquema)) {
    if (hay.has(t)) await db.query('DROP TABLE `' + t + '`');
    await db.query(copia.esquema[t]);
  }
  for (const [t, filas] of Object.entries(copia.datos)) {
    if (!filas.length) continue;
    const cols = Object.keys(filas[0]);
    const lote = t === 'documentos' ? 5 : 200;
    for (let i = 0; i < filas.length; i += lote) {
      const parte = filas.slice(i, i + lote);
      await db.query(`INSERT INTO \`${t}\` (${cols.map(c => '`' + c + '`').join(',')}) VALUES ?`, [parte.map(f => cols.map(c => f[c]))]);
    }
  }
  await db.query('SET FOREIGN_KEY_CHECKS = 1');
  let ok = true;
  for (const t of Object.keys(copia.datos)) {
    const [[r]] = await db.query('SELECT COUNT(*) AS n FROM `' + t + '`');
    const esperado = copia.datos[t].length;
    console.log(`${r.n === esperado ? '✔' : '✖'} ${t}: ${r.n} de ${esperado} filas`);
    if (r.n !== esperado) ok = false;
  }
  await db.end();
  console.log(ok ? 'Restauración completa y verificada.' : 'ATENCIÓN: hay tablas con diferencias.');
  process.exit(ok ? 0 : 3);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
