// ============================================================
//  CAPA: BACKEND · Conexión a la base de datos
//  Estudio Casil Rodríguez (ECR) · Railway
// ============================================================
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.MYSQLHOST,
  database: process.env.MYSQLDATABASE,
  user:     process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  port:     process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;
