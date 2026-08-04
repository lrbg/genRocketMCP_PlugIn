/**
 * GenRocket — cliente REST + tools MCP para PolibioDesk.
 *
 * Config por variables de entorno (nada hardcodeado):
 *   GENROCKET_BASE_URL       host/tenant  (default https://app.genrocket.com)
 *   GENROCKET_USERNAME       usuario del tenant
 *   GENROCKET_PASSWORD       contraseña del tenant
 *   GENROCKET_ORG_ID         organization external id (para list/download)
 *   GENROCKET_RUNTIME_CMD    comando para ejecutar el Runtime local sobre un .grs
 *                            (placeholders {grs} y {dir}), p. ej:
 *                            java -jar /ruta/GenRocketRuntime.jar {grs}
 *   GENROCKET_RUNTIME_OUTDIR carpeta base de salida (default: temp del SO)
 */
import { z } from 'zod'
import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter as pathDelimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const execAsync = promisify(exec)

const BASE_RAW = process.env.GENROCKET_BASE_URL || 'https://app.genrocket.com'
const USERNAME = process.env.GENROCKET_USERNAME || ''
const PASSWORD = process.env.GENROCKET_PASSWORD || ''
const ORG_ID   = process.env.GENROCKET_ORG_ID   || ''
const RUNTIME_CMD    = process.env.GENROCKET_RUNTIME_CMD || ''
const RUNTIME_OUTDIR = process.env.GENROCKET_RUNTIME_OUTDIR || join(tmpdir(), 'genrocket-runtime')

// Normaliza el host a "<origin>/rest" (acepta con/sin protocolo, con/sin /rest final).
function grBase() {
  let raw = (BASE_RAW || '').trim()
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  raw = raw.replace(/\/+$/, '').replace(/\/rest$/i, '')
  return `${raw}/rest`
}

// ── Auth ─────────────────────────────────────────────────────────
let cachedToken = null
let tokenExpiresAt = 0

export async function grLogin() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('Faltan credenciales: define GENROCKET_USERNAME y GENROCKET_PASSWORD')
  }
  const res = await fetch(`${grBase()}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || `Login GenRocket falló (HTTP ${res.status})`)
  }
  // El tenant devuelve el JWT en el body como "accessToken"; algunos lo mandan en header.
  const headerToken = res.headers.get('x-auth-token') || res.headers.get('auth-token')
  const body = await res.json().catch(() => ({}))
  const token = headerToken || body?.accessToken || body?.token || body?.authToken
  if (!token) throw new Error('GenRocket no devolvió token (ni header ni accessToken en el body)')
  return { token, roles: body?.roles ?? [], username: body?.username ?? USERNAME }
}

async function getToken(forceFresh = false) {
  const now = Date.now()
  if (!forceFresh && cachedToken && now < tokenExpiresAt) return cachedToken
  const { token } = await grLogin()
  cachedToken = token
  tokenExpiresAt = now + 50 * 60 * 1000 // ~50 min
  return token
}

// POST autenticado. El tenant autentica con el header x-auth-token
// (Authorization: Bearer devuelve 401). Reintenta una vez con token fresco ante 401/403.
async function grPost(path, bodyObj, _retried = false) {
  const token = await getToken(_retried)
  const res = await fetch(`${grBase()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'accept': 'application/json',
      'x-auth-token': token,
    },
    body: JSON.stringify(bodyObj),
  })
  if ((res.status === 401 || res.status === 403) && !_retried) {
    cachedToken = null
    return grPost(path, bodyObj, true)
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || `GenRocket error ${res.status} en ${path}`)
  }
  // GenRocket responde 200 aun con errores lógicos: { success:false, errors:{...} }
  const data = await res.json()
  if (data && data.success === false) {
    const msg = data.errors ? Object.values(data.errors).join('; ') : 'GenRocket devolvió success:false'
    throw new Error(msg)
  }
  return data
}

function requireOrg() {
  if (!ORG_ID) throw new Error('Falta GENROCKET_ORG_ID (organization external id)')
  return ORG_ID
}

// ── Operaciones ──────────────────────────────────────────────────
export async function listScenarios(projectName, version = '1.0') {
  const data = await grPost('/scenario/list', {
    organizationId: requireOrg(), projectName, versionNumber: version,
  })
  return data?.scenarios ?? []
}

export async function listChains(projectName, version = '1.0') {
  const data = await grPost('/chain/list', {
    organizationId: requireOrg(), projectName, versionNumber: version,
  })
  return data?.chains ?? []
}

export async function listDomains(projectName, version = '1.0') {
  const data = await grPost('/domain/list', {
    organizationId: requireOrg(), projectName, versionNumber: version,
  })
  return data?.domains ?? []
}

export async function listGenerators(projectName, version, domainId, attributeName) {
  // GenRocket espera el nombre del atributo en el campo "name" (no "attributeName")
  const data = await grPost('/generator/list', {
    organizationId: requireOrg(), projectName, versionNumber: version || '1.0', domainId, name: attributeName,
  })
  return data?.generators ?? []
}

export async function downloadScenario(scenarioId) {
  // /scenario/download NO devuelve JSON: entrega un ZIP (.grs) con la definición
  // del escenario para el GenRocket Runtime. Devolvemos los bytes + el filename.
  const token = await getToken()
  const res = await fetch(`${grBase()}/scenario/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ organizationId: requireOrg(), scenarioId }),
  })
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const j = await res.json().catch(() => ({}))
    const msg = j?.errors ? Object.values(j.errors).join('; ') : (j?.message || 'GenRocket devolvió un error')
    throw new Error(msg)
  }
  if (!res.ok) throw new Error(`GenRocket error ${res.status} en /scenario/download`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const filename = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/)?.[1] || `${scenarioId}.grs`
  return { filename, bytes }
}

// ── GenRocket Runtime (engine local) ─────────────────────────────
export async function runtimeStatus() {
  let java = null
  try { const { stdout, stderr } = await execAsync('java -version'); java = (stderr || stdout).split('\n')[0].trim() } catch { java = null }
  return { java, runtimeConfigured: !!RUNTIME_CMD, runtimeCmd: RUNTIME_CMD || null, outDir: RUNTIME_OUTDIR }
}

// Descarga el .grs y ejecuta el Runtime local (GENROCKET_RUNTIME_CMD) para generar datos.
export async function runScenario(scenarioId, { scenarioName } = {}) {
  if (!RUNTIME_CMD) {
    throw new Error('GenRocket Runtime no configurado. Define GENROCKET_RUNTIME_CMD con el comando de tu Runtime (usa {grs} y {dir}), p. ej: java -jar /ruta/GenRocketRuntime.jar {grs}')
  }
  const { filename, bytes } = await downloadScenario(scenarioId)
  const safe = (scenarioName || scenarioId).replace(/[^\w.-]/g, '_')
  const dir = join(RUNTIME_OUTDIR, `${safe}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const grsPath = join(dir, filename.endsWith('.grs') ? filename : `${scenarioId}.grs`)
  await writeFile(grsPath, bytes)

  const cmd = RUNTIME_CMD.replaceAll('{grs}', `"${grsPath}"`).replaceAll('{dir}', `"${dir}"`)
  let stdout = '', stderr = '', exitCode = 0
  try {
    const r = await execAsync(cmd, { cwd: dir, timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 })
    stdout = r.stdout; stderr = r.stderr
  } catch (e) {
    exitCode = e.code ?? 1; stdout = e.stdout || ''; stderr = e.stderr || e.message
  }

  const outputs = []
  for (const f of await readdir(dir)) {
    const full = join(dir, f)
    if (full === grsPath) continue
    const st = await stat(full).catch(() => null)
    if (st?.isFile()) outputs.push({ name: f, bytes: st.size })
  }
  return { dir, grs: grsPath, exitCode, stdout: stdout.slice(-3000), stderr: stderr.slice(-3000), outputs }
}

// ── Escritura (endpoints confirmados; el payload exacto lo define la API de GenRocket) ──
export async function createDomain(fields = {})    { return grPost('/domain/create',   { organizationId: requireOrg(), ...fields }) }
export async function cloneDomain(fields = {})     { return grPost('/domain/copy',      { organizationId: requireOrg(), ...fields }) }
export async function assignGenerator(fields = {}) { return grPost('/generator/assign', { organizationId: requireOrg(), ...fields }) }
export async function createScenario(fields = {})  { return grPost('/scenario/create',  { organizationId: requireOrg(), ...fields }) }
export async function publishReceiver(fields = {}) { return grPost('/receiver/publish', { organizationId: requireOrg(), ...fields }) }

// ── Módulo de Base de Datos (JDBC de solo lectura: Oracle + SQL Server) ──────
const JAVA_BIN = process.env.GENROCKET_JAVA || 'java'
const DBQUERY_JAR = process.env.GENROCKET_DBQUERY_JAR || fileURLToPath(new URL('./db/dbquery.jar', import.meta.url))

function dbConnections() {
  try { return JSON.parse(process.env.GENROCKET_DB_JSON || '[]') } catch { return [] }
}
function dbEnvPwName(name) { return 'GENROCKET_DB_PW_' + String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_') }
function getConn(name) {
  const conns = dbConnections()
  if (!conns.length) throw new Error('No hay conexiones de BD configuradas.')
  const c = name ? conns.find(x => x.name === name) : conns[0]
  if (!c) throw new Error(`Conexión "${name}" no encontrada. Disponibles: ${conns.map(x => x.name).join(', ')}`)
  return { type: 'oracle', ...c, password: process.env[dbEnvPwName(c.name)] || '' }
}

function assertSelectOnly(sql) {
  if (!/^\s*(select|with)\b/i.test(sql || '')) throw new Error('Solo se permiten consultas SELECT (modo solo lectura).')
}

async function dbRun(conn, sql, maxRows = 500) {
  if (!conn.driverJar) throw new Error(`La conexión "${conn.name}" no tiene driverJar (ruta al ojdbc / mssql-jdbc .jar).`)
  if (!conn.jdbcUrl) throw new Error(`La conexión "${conn.name}" no tiene jdbcUrl.`)
  assertSelectOnly(sql)
  const cp = `${conn.driverJar}${pathDelimiter}${DBQUERY_JAR}`
  return new Promise((resolve, reject) => {
    const child = spawn(JAVA_BIN, ['-cp', cp, 'DbQuery'], {
      env: { ...process.env, DB_URL: conn.jdbcUrl, DB_USER: conn.user || '', DB_PASSWORD: conn.password || '', DB_MAXROWS: String(maxRows) },
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => reject(new Error(`No se pudo ejecutar java: ${e.message}`)))
    child.on('close', () => {
      let j
      try { j = JSON.parse(out || '{}') } catch { return reject(new Error(err.trim() || out.trim() || 'Sin salida del helper JDBC')) }
      if (j.error) reject(new Error(j.error)); else resolve(j)
    })
    child.stdin.write(sql); child.stdin.end()
  })
}

function fmtRows(j, limit = 50) {
  const cols = j.columns || [], rows = j.rows || []
  if (!cols.length) return '(sin columnas)'
  const head = cols.join(' | ')
  const body = rows.slice(0, limit).map(r => r.map(v => v === null ? '' : String(v)).join(' | ')).join('\n')
  const extra = rows.length > limit ? `\n… (${rows.length - limit} filas más; total ${j.rowCount})` : ''
  return `${head}\n${'-'.repeat(Math.min(head.length, 80))}\n${body}${extra}`
}

const ident = (s) => String(s || '').replace(/[^A-Za-z0-9_$#.]/g, '')
function catalogSql(type, what, table) {
  const t = ident(table)
  if (type === 'sqlserver') {
    if (what === 'test')    return 'SELECT 1 AS OK'
    if (what === 'tables')  return "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS TABLA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY 1"
    if (what === 'columns') return `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS LEN, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${t}' ORDER BY ORDINAL_POSITION`
    if (what === 'indexes') return `SELECT i.name AS INDICE, c.name AS COLUMNA FROM sys.indexes i JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id JOIN sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id WHERE i.object_id=OBJECT_ID('${t}') ORDER BY i.name, ic.key_ordinal`
    if (what === 'sample')  return `SELECT TOP {N} * FROM ${t}`
  } else {
    if (what === 'test')    return 'SELECT 1 AS OK FROM DUAL'
    if (what === 'tables')  return 'SELECT table_name AS TABLA FROM user_tables ORDER BY table_name'
    if (what === 'columns') return `SELECT column_name, data_type, data_length AS LEN, nullable FROM user_tab_columns WHERE table_name = UPPER('${t}') ORDER BY column_id`
    if (what === 'indexes') return `SELECT i.index_name AS INDICE, c.column_name AS COLUMNA FROM user_indexes i JOIN user_ind_columns c ON i.index_name=c.index_name WHERE c.table_name = UPPER('${t}') ORDER BY i.index_name, c.column_position`
    if (what === 'sample')  return `SELECT * FROM ${t} WHERE ROWNUM <= {N}`
  }
  return ''
}

// ── Helpers de formato ───────────────────────────────────────────
const ok  = (text) => ({ content: [{ type: 'text', text }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

// ── Registro de tools en el server MCP existente ─────────────────
export function registerGenRocketTools(server) {
  server.tool(
    'genrocket_test_connection',
    'Verifica la conexión con GenRocket: autentica contra el tenant configurado y devuelve los roles del usuario. Útil como health-check.',
    {},
    async () => {
      try {
        const { username, roles } = await grLogin()
        return ok(`Conexion OK con ${grBase()}\nUsuario: ${username}\nRoles: ${roles.join(', ') || '(sin roles)'}`)
      } catch (e) {
        return bad(`Error de conexion con GenRocket: ${e.message}`)
      }
    }
  )

  server.tool(
    'genrocket_list_scenarios',
    'Lista los escenarios de un proyecto de GenRocket. Requiere el nombre exacto del proyecto; la version por defecto es 1.0.',
    {
      projectName: z.string().describe('Nombre exacto del proyecto en GenRocket'),
      version: z.string().optional().describe('Version del proyecto (default 1.0)'),
    },
    async ({ projectName, version = '1.0' }) => {
      try {
        const scenarios = await listScenarios(projectName, version)
        if (!scenarios.length) return ok(`Sin escenarios en "${projectName}" v${version}.`)
        const lines = scenarios.map((s) =>
          `- ${s.name ?? s}${s.externalId ? `  [${s.externalId}]` : ''}`
        ).join('\n')
        return ok(`Escenarios de "${projectName}" v${version} (${scenarios.length}):\n${lines}`)
      } catch (e) {
        return bad(`Error al listar escenarios: ${e.message}`)
      }
    }
  )

  server.tool(
    'genrocket_list_chains',
    'Lista las chains (secuencias de escenarios) de un proyecto de GenRocket. Requiere el nombre exacto del proyecto; version default 1.0.',
    {
      projectName: z.string().describe('Nombre exacto del proyecto en GenRocket'),
      version: z.string().optional().describe('Version del proyecto (default 1.0)'),
    },
    async ({ projectName, version = '1.0' }) => {
      try {
        const chains = await listChains(projectName, version)
        if (!chains.length) return ok(`Sin chains en "${projectName}" v${version}.`)
        const lines = chains.map((c) => {
          const n = c.scenarios?.length ?? 0
          return `- ${c.name ?? c}${c.externalId ? `  [${c.externalId}]` : ''}${n ? `  (${n} escenarios)` : ''}`
        }).join('\n')
        return ok(`Chains de "${projectName}" v${version} (${chains.length}):\n${lines}`)
      } catch (e) {
        return bad(`Error al listar chains: ${e.message}`)
      }
    }
  )

  server.tool(
    'genrocket_list_domains',
    'Lista los dominios (entidades) de un proyecto de GenRocket, con sus atributos. Requiere el nombre exacto del proyecto; version default 1.0.',
    {
      projectName: z.string().describe('Nombre exacto del proyecto en GenRocket'),
      version: z.string().optional().describe('Version del proyecto (default 1.0)'),
    },
    async ({ projectName, version = '1.0' }) => {
      try {
        const domains = await listDomains(projectName, version)
        if (!domains.length) return ok(`Sin dominios en "${projectName}" v${version}.`)
        const lines = domains.map((d) =>
          `- ${d.name}${d.attributes?.length ? `  (${d.attributes.length} atributos)` : ''}${d.externalId ? `  [${d.externalId}]` : ''}`
        ).join('\n')
        return ok(`Dominios de "${projectName}" v${version} (${domains.length}):\n${lines}`)
      } catch (e) {
        return bad(`Error al listar dominios: ${e.message}`)
      }
    }
  )

  server.tool(
    'genrocket_list_generators',
    'Lista los generadores de un atributo de un dominio en GenRocket. Requiere el domainId (externalId del dominio, de genrocket_list_domains) y el nombre del atributo.',
    {
      projectName: z.string().describe('Nombre exacto del proyecto'),
      version: z.string().optional().describe('Version del proyecto (default 1.0)'),
      domainId: z.string().describe('externalId del dominio (de genrocket_list_domains)'),
      attributeName: z.string().describe('Nombre del atributo'),
    },
    async ({ projectName, version = '1.0', domainId, attributeName }) => {
      try {
        const gens = await listGenerators(projectName, version, domainId, attributeName)
        if (!gens.length) return ok(`Sin generadores para "${attributeName}".`)
        const lines = gens.map((g) => `- ${g.name ?? g.type ?? JSON.stringify(g)}`).join('\n')
        return ok(`Generadores de "${attributeName}" (${gens.length}):\n${lines}`)
      } catch (e) {
        return bad(`Error al listar generadores: ${e.message}`)
      }
    }
  )

  server.tool(
    'genrocket_download_scenario',
    'Descarga la definicion de un escenario de GenRocket por su ID (el externalId que devuelve genrocket_list_scenarios). NOTA: GenRocket Cloud no genera datos por REST; la generacion la ejecuta el GenRocket Runtime alimentado con esta definicion.',
    {
      scenarioId: z.string().describe('externalId del escenario (de genrocket_list_scenarios)'),
    },
    async ({ scenarioId }) => {
      try {
        const { filename, bytes } = await downloadScenario(scenarioId)
        return ok(`Escenario descargado: ${filename} (${bytes.length} bytes, ZIP .grs). Es el paquete para el GenRocket Runtime, no es texto legible inline.`)
      } catch (e) {
        return bad(`No se pudo descargar el escenario: ${e.message}`)
      }
    }
  )

  server.tool(
    'genrocket_runtime_status',
    'Indica si el GenRocket Runtime local esta disponible: version de Java y si GENROCKET_RUNTIME_CMD esta configurado. Usalo antes de genrocket_run_scenario.',
    {},
    async () => {
      const s = await runtimeStatus()
      return ok([
        `Java: ${s.java || 'NO instalado'}`,
        `Runtime configurado: ${s.runtimeConfigured ? 'si -> ' + s.runtimeCmd : 'NO (define GENROCKET_RUNTIME_CMD)'}`,
        `Carpeta de salida: ${s.outDir}`,
      ].join('\n'))
    }
  )

  server.tool(
    'genrocket_run_scenario',
    'Ejecuta el GenRocket Runtime LOCAL sobre un escenario para GENERAR los datos sinteticos (CSV/archivos segun los receivers del escenario). Descarga el .grs y corre el comando GENROCKET_RUNTIME_CMD. Devuelve los archivos generados y su ruta. Requiere el Runtime instalado y configurado.',
    {
      scenarioId: z.string().describe('externalId del escenario (de genrocket_list_scenarios)'),
      scenarioName: z.string().optional().describe('Nombre del escenario (opcional, para nombrar la carpeta)'),
    },
    async ({ scenarioId, scenarioName }) => {
      try {
        const r = await runScenario(scenarioId, { scenarioName })
        const outs = r.outputs.length
          ? r.outputs.map(f => `  - ${f.name} (${f.bytes} bytes)`).join('\n')
          : '  (no se generaron archivos nuevos; revisa los receivers configurados en el escenario)'
        return ok([
          `Runtime ejecutado (exit code ${r.exitCode}).`,
          `Carpeta: ${r.dir}`,
          `Archivos generados:`,
          outs,
          r.stdout ? `\n--- stdout (fin) ---\n${r.stdout}` : '',
          r.stderr ? `\n--- stderr (fin) ---\n${r.stderr}` : '',
        ].filter(Boolean).join('\n'))
      } catch (e) {
        return bad(`No se pudo ejecutar el Runtime: ${e.message}`)
      }
    }
  )

  // ── Escritura (crear/clonar/asignar/publicar) ────────────────────
  const writeTool = (name, desc, fn) => server.tool(
    name, desc,
    { fields: z.record(z.any()).describe('Campos del objeto segun la API de GenRocket (organizationId se agrega solo). Ej: projectName, versionNumber, name, domainId, ...') },
    async ({ fields }) => {
      try {
        const d = await fn(fields || {})
        return ok(`OK ${name}:\n${JSON.stringify(d, null, 2).slice(0, 2500)}`)
      } catch (e) { return bad(`${name}: ${e.message}`) }
    }
  )
  writeTool('genrocket_create_domain',    'Crea un dominio en GenRocket (escritura). Campos tipicos: projectName, versionNumber, name, parent.', createDomain)
  writeTool('genrocket_clone_domain',     'Clona/copia un dominio (escritura, /domain/copy). Campos: domainId y destino segun la API.', cloneDomain)
  writeTool('genrocket_assign_generator', 'Asigna un generador a un atributo (escritura). Campos: domainId, name (atributo) y datos del generador.', assignGenerator)
  writeTool('genrocket_create_scenario',  'Crea un escenario (escritura). Campos: projectName, versionNumber, name, domainId, receiver, etc.', createScenario)
  writeTool('genrocket_publish_receiver', 'Publica un receiver a un escenario (escritura).', publishReceiver)

  // ── Runtime (generacion / exportacion / mask / subset) ───────────
  // Todas ejecutan el Runtime local sobre el escenario; el formato de salida y las
  // transformaciones dependen de los receivers/config del escenario en el Designer.
  const runtimeAlias = (name, desc) => server.tool(
    name, desc,
    {
      scenarioId: z.string().describe('externalId del escenario (de genrocket_list_scenarios)'),
      scenarioName: z.string().optional().describe('Nombre del escenario (opcional)'),
    },
    async ({ scenarioId, scenarioName }) => {
      try {
        const r = await runScenario(scenarioId, { scenarioName })
        const outs = r.outputs.length
          ? r.outputs.map(f => `  - ${f.name} (${f.bytes} bytes)`).join('\n')
          : '  (sin archivos; revisa los receivers configurados en el escenario)'
        return ok(`Runtime ejecutado (exit ${r.exitCode}).\nCarpeta: ${r.dir}\nArchivos:\n${outs}`)
      } catch (e) { return bad(`${name}: ${e.message}`) }
    }
  )
  runtimeAlias('genrocket_generate_data',   'Genera datos sinteticos ejecutando el escenario con el Runtime local.')
  runtimeAlias('genrocket_export_csv',      'Genera y exporta a CSV: ejecuta el Runtime. Requiere que el escenario tenga un receiver CSV.')
  runtimeAlias('genrocket_export_sql',      'Genera y exporta a SQL: ejecuta el Runtime. Requiere que el escenario tenga un receiver SQL/BD.')
  runtimeAlias('genrocket_mask_database',   'Enmascara datos (masking): ejecuta el Runtime. El enmascaramiento se configura en el dominio/escenario.')
  runtimeAlias('genrocket_subset_database', 'Subset de base de datos: ejecuta el Runtime. El subsetting se configura en el escenario.')

  // ── Base de datos (JDBC solo lectura: Oracle + SQL Server) ───────
  server.tool('db_list_connections', 'Lista las conexiones de base de datos configuradas (nombre y tipo).', {},
    async () => {
      const conns = dbConnections()
      if (!conns.length) return bad('No hay conexiones de BD configuradas. Agrégalas en los ajustes del plugin (genrocket.dbConnections).')
      return ok('Conexiones:\n' + conns.map(c => `- ${c.name} (${c.type || 'oracle'})`).join('\n'))
    })

  server.tool('db_test_connection', 'Prueba una conexión de BD (SELECT 1). Solo lectura.',
    { connection: z.string().optional().describe('Nombre de la conexión (default: la primera)') },
    async ({ connection }) => {
      try { const c = getConn(connection); await dbRun(c, catalogSql(c.type, 'test')); return ok(`Conexión "${c.name}" (${c.type}) OK.`) }
      catch (e) { return bad(e.message) }
    })

  server.tool('db_list_tables', 'Lista las tablas de una conexión. Solo lectura. Úsalo para explorar antes de consultar.',
    { connection: z.string().optional() },
    async ({ connection }) => {
      try { const c = getConn(connection); const j = await dbRun(c, catalogSql(c.type, 'tables'), 3000); return ok(fmtRows(j, 800)) }
      catch (e) { return bad(e.message) }
    })

  server.tool('db_describe_table', 'Describe las columnas (nombre, tipo, nullable) de una tabla. Solo lectura.',
    { table: z.string().describe('Nombre de la tabla'), connection: z.string().optional() },
    async ({ table, connection }) => {
      try { const c = getConn(connection); const j = await dbRun(c, catalogSql(c.type, 'columns', table), 1000); return ok(fmtRows(j, 300)) }
      catch (e) { return bad(e.message) }
    })

  server.tool('db_list_indexes', 'Lista los índices y sus columnas de una tabla. Solo lectura.',
    { table: z.string(), connection: z.string().optional() },
    async ({ table, connection }) => {
      try { const c = getConn(connection); const j = await dbRun(c, catalogSql(c.type, 'indexes', table), 1000); return ok(fmtRows(j, 300)) }
      catch (e) { return bad(e.message) }
    })

  server.tool('db_sample', 'Muestra las primeras N filas de una tabla. Solo lectura.',
    { table: z.string(), n: z.number().int().positive().optional(), connection: z.string().optional() },
    async ({ table, n = 20, connection }) => {
      try { const c = getConn(connection); const sql = catalogSql(c.type, 'sample', table).replace('{N}', String(n)); const j = await dbRun(c, sql, n); return ok(fmtRows(j, n)) }
      catch (e) { return bad(e.message) }
    })

  server.tool('db_query', 'Ejecuta una consulta SELECT de solo lectura en la conexión indicada y devuelve las filas. Explora antes con db_list_tables / db_describe_table para saber tablas y columnas.',
    { sql: z.string().describe('Consulta SELECT (solo lectura)'), connection: z.string().optional(), maxRows: z.number().int().positive().optional() },
    async ({ sql, connection, maxRows = 500 }) => {
      try { const c = getConn(connection); const j = await dbRun(c, sql, maxRows); return ok(fmtRows(j, Math.min(maxRows, 200))) }
      catch (e) { return bad(e.message) }
    })
}
