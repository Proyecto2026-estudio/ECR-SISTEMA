// ============================================================
//  Extracción de contenido de documentos para el asistente de IA
//  Sin dependencias externas: PDF e imágenes se mandan tal cual a
//  Gemini; CSV/TXT/JSON como texto; XLSX se convierte a CSV leyendo
//  el zip con zlib de Node.
// ============================================================
const zlib = require('zlib');

const MAX_BYTES_TOTAL = 14 * 1024 * 1024;   // tope de archivos inline por consulta
const MAX_CHARS_TEXTO = 150000;             // tope de texto por documento
const MAX_FILAS_HOJA  = 1000;

// ── Lector mínimo de ZIP (suficiente para .xlsx) ─────────────
function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('No es un zip válido');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize  = buf.readUInt32LE(p + 20);
    const nlen   = buf.readUInt16LE(p + 28);
    const elen   = buf.readUInt16LE(p + 30);
    const clen   = buf.readUInt16LE(p + 32);
    const lho    = buf.readUInt32LE(p + 42);
    const name   = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
    const dstart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dstart, dstart + csize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
  }
  return files;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
          .replace(/&amp;/g, '&');
}

function colIndex(ref) {
  const letters = ref.replace(/[0-9]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(v) {
  v = String(v == null ? '' : v);
  return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function xlsxToCsv(buf) {
  const files = unzip(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml'].toString('utf8');
    for (const si of xml.match(/<si[\s>][\s\S]*?<\/si>|<si\/>/g) || []) {
      const ts = (si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, ''));
      shared.push(decodeXml(ts.join('')));
    }
  }
  const nombres = [];
  if (files['xl/workbook.xml']) {
    const wb = files['xl/workbook.xml'].toString('utf8');
    for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) nombres.push(decodeXml(m[1]));
  }
  const hojas = Object.keys(files).filter(n => n.startsWith('xl/worksheets/'))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]));
  const out = [];
  hojas.forEach((nombre, idx) => {
    const xml = files[nombre].toString('utf8');
    const filas = [];
    for (const row of (xml.match(/<row\b[\s\S]*?<\/row>/g) || []).slice(0, MAX_FILAS_HOJA)) {
      const celdas = [];
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || '';
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        if (!ref) continue;
        const tipo = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        let val = '';
        if (tipo === 'inlineStr') val = decodeXml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [, ''])[1]);
        else {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1];
          val = tipo === 's' ? (shared[+v] || '') : decodeXml(v);
        }
        celdas[colIndex(ref)] = val;
      }
      const fila = Array.from(celdas, v => csvCell(v)).join(',');
      if (fila.replace(/,/g, '').trim()) filas.push(fila);
    }
    out.push(`--- Hoja: ${nombres[idx] || 'Hoja' + (idx + 1)} ---\n` + filas.join('\n'));
  });
  return out.join('\n\n');
}

// ── Arma las "partes" que se le mandan a Gemini ──────────────
// docs: filas de la tabla documentos (con archivo_data en base64)
function construirPartes(docs) {
  const partes = [];
  const usados = [], omitidos = [];
  let bytes = 0;

  for (const d of docs) {
    const etiqueta = `${d.nombre} (${d.tipo}, ${String(d.fecha).slice(0, 10)})`;
    if (!d.archivo_data) { omitidos.push({ nombre: d.nombre, motivo: 'sin archivo adjunto' }); continue; }
    const mime = (d.archivo_mime || '').toLowerCase();
    const nombreOrig = (d.archivo_nombre_original || '').toLowerCase();
    try {
      if (mime === 'application/pdf' || mime.startsWith('image/')) {
        const tam = Math.floor(d.archivo_data.length * 0.75);
        if (bytes + tam > MAX_BYTES_TOTAL) { omitidos.push({ nombre: d.nombre, motivo: 'excede el tamaño máximo por consulta' }); continue; }
        bytes += tam;
        partes.push({ text: `Documento del cliente: ${etiqueta}` });
        partes.push({ inlineData: { mimeType: mime, data: d.archivo_data } });
        usados.push(d.nombre);
      } else if (mime.startsWith('text/') || mime === 'application/json' || /\.(csv|txt|json)$/.test(nombreOrig)) {
        const texto = Buffer.from(d.archivo_data, 'base64').toString('utf8').slice(0, MAX_CHARS_TEXTO);
        partes.push({ text: `Documento del cliente: ${etiqueta}\n${texto}` });
        usados.push(d.nombre);
      } else if (mime.includes('spreadsheetml') || /\.xlsx$/.test(nombreOrig)) {
        const csv = xlsxToCsv(Buffer.from(d.archivo_data, 'base64')).slice(0, MAX_CHARS_TEXTO);
        partes.push({ text: `Documento del cliente (planilla Excel convertida a CSV): ${etiqueta}\n${csv}` });
        usados.push(d.nombre);
      } else {
        omitidos.push({ nombre: d.nombre, motivo: 'formato no soportado (' + (mime || 'desconocido') + ')' });
      }
    } catch (e) {
      omitidos.push({ nombre: d.nombre, motivo: 'no se pudo leer' });
    }
  }
  return { partes, usados, omitidos };
}

module.exports = { construirPartes, xlsxToCsv };
