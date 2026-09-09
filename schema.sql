-- ============================================================
--  Estudio Casil Rodríguez (ECR) · Estructura de la base MySQL
--  Ejecutar una sola vez en la base nueva de Railway
-- ============================================================

CREATE TABLE IF NOT EXISTS clientes (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(255) NOT NULL,
  cuit        VARCHAR(20)  NULL,
  servicio    VARCHAR(255) NOT NULL DEFAULT 'Asesoramiento integral',
  honorarios  DECIMAL(12,2) NOT NULL DEFAULT 0,
  estado      VARCHAR(30)  NOT NULL DEFAULT 'Activo',
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vencimientos (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  descripcion VARCHAR(255) NOT NULL,
  cliente_id  INT NULL,
  tipo        VARCHAR(30) NOT NULL DEFAULT 'Impositivo',
  fecha       DATE NOT NULL,
  estado      VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_venc_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS documentos (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(255) NOT NULL,
  tipo        VARCHAR(30) NOT NULL DEFAULT 'Otro',
  cliente_id  INT NULL,
  fecha       DATE NOT NULL,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_doc_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL
);
