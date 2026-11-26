-- ============================================================
--  Estudio Casil Rodríguez (ECR) · Estructura completa de la base MySQL
--  Sirve para crear una base nueva desde cero. En la base que ya está en uso no
--  hace falta correrlo: el servidor agrega solo lo que falte al iniciar
--  (src/index.js, "migraciones livianas"; nunca borran datos).
-- ============================================================

CREATE TABLE IF NOT EXISTS clientes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(255) NOT NULL,
  cuit          VARCHAR(20)  NULL,
  servicio      VARCHAR(255) NOT NULL DEFAULT 'Asesoramiento integral',
  honorarios    DECIMAL(12,2) NOT NULL DEFAULT 0,       -- solo los ve y cambia el administrador
  estado        VARCHAR(30)  NOT NULL DEFAULT 'Activo',
  email_alertas VARCHAR(200) NULL,                      -- mail(s) del cliente para avisarle sus vencimientos
  whatsapp      VARCHAR(25)  NULL,
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Usuarios del sistema. Roles: admin, contador, cliente_pyme, lectura.
-- password_hash vacío = cuenta creada que todavía no se activó con el enlace del mail.
CREATE TABLE IF NOT EXISTS usuarios (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(120) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL DEFAULT '',       -- scrypt: "sal:hash"
  rol           VARCHAR(30)  NOT NULL DEFAULT 'contador',
  cliente_id    INT NULL,                               -- empresa del usuario Cliente PyME
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vencimientos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  descripcion   VARCHAR(255) NOT NULL,
  cliente_id    INT NULL,
  tipo          VARCHAR(30) NOT NULL DEFAULT 'Impositivo',
  fecha         DATE NOT NULL,                          -- fecha fiscal oficial
  fecha_entrega DATE NULL,                              -- fecha interna para que el cliente entregue la documentación
  estado        VARCHAR(30) NOT NULL DEFAULT 'Pendiente',
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_venc_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL
);

-- Subcarpetas dentro de la carpeta de un cliente (por ejemplo, una por banco y, adentro, una por año).
-- padre_id NULL = está en la carpeta principal del cliente. El nombre no se repite dentro de una misma carpeta.
CREATE TABLE IF NOT EXISTS carpetas (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id  INT NOT NULL,
  padre_id    INT NULL,
  nombre      VARCHAR(60) NOT NULL,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_carpeta_cliente (cliente_id)
);

CREATE TABLE IF NOT EXISTS documentos (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  nombre                  VARCHAR(255) NOT NULL,
  tipo                    VARCHAR(30) NOT NULL DEFAULT 'Otro',
  cliente_id              INT NULL,
  carpeta_id              INT NULL,
  fecha                   DATE NOT NULL,                -- día en que se cargó
  periodo                 CHAR(7) NULL,                 -- 'AAAA-MM' al que corresponde (archivo por año y mes)
  archivo_data            LONGTEXT NULL,                -- archivo en base64
  archivo_mime            VARCHAR(120) NULL,
  archivo_nombre_original VARCHAR(255) NULL,
  subido_por              INT NULL,
  recibido_por            INT NULL,                     -- quién del estudio confirmó la recepción
  recibido_en             DATETIME NULL,                -- NULL = subido por el cliente y pendiente de revisar
  creado_en               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_doc_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL
);

-- Avisos por mail al estudio ya enviados (un vencimiento se avisa una sola vez a los 7 días)
CREATE TABLE IF NOT EXISTS alertas_enviadas (
  venc_id    INT NOT NULL,
  dias       INT NOT NULL,
  enviado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (venc_id, dias)
);

-- Enlaces únicos de activación de cuenta y de cambio de contraseña (solo se guarda el hash)
CREATE TABLE IF NOT EXISTS tokens_acceso (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id  INT NOT NULL,
  tipo        VARCHAR(20) NOT NULL,                     -- activacion | recuperacion
  token_hash  CHAR(64) NOT NULL,
  vence_en    DATETIME NOT NULL,
  usado_en    DATETIME NULL,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token (token_hash),
  KEY ix_usuario (usuario_id)
);

-- Historial de accesos y de cambios
CREATE TABLE IF NOT EXISTS auditoria (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id  INT NULL,
  accion      VARCHAR(40) NOT NULL,
  detalle     VARCHAR(500) NULL,
  ip          VARCHAR(64) NULL,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY ix_fecha (creado_en)
);

-- Extractos bancarios (RF08): reglas del estudio, equivalencias por cliente y registro de lecturas
CREATE TABLE IF NOT EXISTS reglas_extracto (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  patron      VARCHAR(80) NOT NULL,                     -- texto que contiene la descripción del movimiento
  categoria   VARCHAR(20) NOT NULL,                     -- categoría genérica (ver src/extractos.js)
  creado_por  INT NULL,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS equivalencias_cuentas (
  cliente_id     INT NOT NULL,
  categoria      VARCHAR(20) NOT NULL,
  cuenta_cliente VARCHAR(80) NOT NULL,                  -- cuenta del plan de cuentas de ese cliente
  PRIMARY KEY (cliente_id, categoria)
);
CREATE TABLE IF NOT EXISTS extractos_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id  INT NULL,
  cliente_id  INT NULL,
  formato     VARCHAR(10) NOT NULL,                     -- pdf | csv
  banco       VARCHAR(80) NULL,
  periodo     VARCHAR(40) NULL,
  movimientos INT NOT NULL DEFAULT 0,
  por_reglas  INT NOT NULL DEFAULT 0,
  por_ia      INT NOT NULL DEFAULT 0,
  saldo_ok    TINYINT NULL,
  tokens      INT NOT NULL DEFAULT 0,
  costo_usd   DECIMAL(10,5) NOT NULL DEFAULT 0,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
