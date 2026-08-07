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
import { readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter as pathDelimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const execAsync = promisify(exec)

// Config: preferimos un archivo local (GENROCKET_CONFIG_FILE) escrito por la
// extensión; si no existe, caemos a variables de entorno.
let FILECFG = {}
try {
  const f = process.env.GENROCKET_CONFIG_FILE
  if (f && existsSync(f)) { FILECFG = JSON.parse(readFileSync(f, 'utf8')) }
} catch { /* ignore */ }

const BASE_RAW = FILECFG.baseUrl || process.env.GENROCKET_BASE_URL || 'https://app.genrocket.com'
const USERNAME = FILECFG.username || process.env.GENROCKET_USERNAME || ''
const PASSWORD = FILECFG.password || process.env.GENROCKET_PASSWORD || ''
const ORG_ID   = FILECFG.organizationId || process.env.GENROCKET_ORG_ID || ''
const RUNTIME_CMD    = FILECFG.runtimeCommand || process.env.GENROCKET_RUNTIME_CMD || ''
const RUNTIME_OUTDIR = FILECFG.runtimeOutputDir || process.env.GENROCKET_RUNTIME_OUTDIR || join(tmpdir(), 'genrocket-runtime')
// Tope de espera por request. Algunos endpoints (p.ej. /generator/list) pueden
// colgarse; sin timeout el MCP quedaría bloqueado. Configurable por si un tenant es lento.
const HTTP_TIMEOUT_MS = Number(FILECFG.httpTimeoutMs || process.env.GENROCKET_HTTP_TIMEOUT_MS || 90000)

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
  let res
  try {
    res = await fetch(`${grBase()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'x-auth-token': token,
      },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`GenRocket no respondió en ${Math.round(HTTP_TIMEOUT_MS / 1000)}s en ${path} (timeout)`)
    }
    throw e
  }
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

// Lista TODOS los proyectos de la organización con sus versiones (POST /project/list).
// Útil para conocer el nombre EXACTO del proyecto (evita errores tipo doble guión bajo).
export async function listProjects() {
  const data = await grPost('/project/list', { organizationId: requireOrg() })
  return data?.projects ?? []
}

// Dominio COMPLETO en una llamada (POST /domain/show): incluye atributos con sus
// generadores, variables globales y receivers. Más eficiente que domain/list + generator/list.
export async function showDomain(domainId) {
  const data = await grPost('/domain/show', { organizationId: requireOrg(), domainId })
  return data?.domain ?? data
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

// Descarga el paquete .grs de una CHAIN (ZIP con todos sus escenarios).
export async function downloadChain(chainId) {
  const token = await getToken()
  const res = await fetch(`${grBase()}/chain/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ organizationId: requireOrg(), chainId }),
  })
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const j = await res.json().catch(() => ({}))
    const msg = j?.errors ? Object.values(j.errors).join('; ') : (j?.message || 'GenRocket devolvió un error')
    throw new Error(msg)
  }
  if (!res.ok) { throw new Error(`GenRocket error ${res.status} en /chain/download (esa chain puede tener un escenario con problema)`) }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const filename = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/)?.[1] || `${chainId}.grs`
  return { filename, bytes }
}

// Ejecuta un .grs (escenario o chain) con el Runtime local y recolecta los archivos generados.
async function runGrs(filename, bytes, label, fallbackId) {
  if (!RUNTIME_CMD) {
    throw new Error('GenRocket Runtime no configurado. Define GENROCKET_RUNTIME_CMD con el comando de tu Runtime (usa {grs} y {dir}), p. ej: java -jar /ruta/GenRocketRuntime.jar {grs}')
  }
  const safe = String(label || fallbackId).replace(/[^\w.-]/g, '_')
  const dir = join(RUNTIME_OUTDIR, `${safe}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const grsPath = join(dir, filename.endsWith('.grs') ? filename : `${fallbackId}.grs`)
  await writeFile(grsPath, bytes)
  const cmd = RUNTIME_CMD.replaceAll('{grs}', `"${grsPath}"`).replaceAll('{dir}', `"${dir}"`)
  let stdout = '', stderr = '', exitCode = 0
  try {
    const r = await execAsync(cmd, { cwd: dir, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 })
    stdout = r.stdout; stderr = r.stderr
  } catch (e) {
    exitCode = e.code ?? 1; stdout = e.stdout || ''; stderr = e.stderr || e.message
  }
  const outputs = []
  for (const f of await readdir(dir)) {
    const full = join(dir, f)
    if (full === grsPath) { continue }
    const st = await stat(full).catch(() => null)
    if (st?.isFile()) { outputs.push({ name: f, bytes: st.size }) }
  }
  return { dir, grs: grsPath, exitCode, stdout: stdout.slice(-3000), stderr: stderr.slice(-3000), outputs }
}

export async function runChain(chainId, { chainName } = {}) {
  const { filename, bytes } = await downloadChain(chainId)
  return runGrs(filename, bytes, chainName ? `chain-${chainName}` : `chain-${chainId}`, chainId)
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
export async function createAttribute(fields = {})  { return grPost('/attribute/create',  { organizationId: requireOrg(), ...fields }) }

// ── Autoría por REST (payloads confirmados del spec oficial de GenRocket) ────
export async function createAttr(domainId, name, autoGenerator = false) {
  return grPost('/attribute/create', { organizationId: requireOrg(), domainId, name, autoGenerator })
}
export async function addGenerator(domainId, attributeName, genType) {
  return grPost('/generator/add', { organizationId: requireOrg(), domainId, name: attributeName, genType })
}
export async function deleteGenerators(domainId, attributeName) {
  return grPost('/generator/deleteAll', { organizationId: requireOrg(), domainId, name: attributeName })
}
export async function setGeneratorParameter(domainId, attributeName, genName, parameterName, parameterValue) {
  return grPost('/generatorParameter/update', {
    organizationId: requireOrg(), domainId, name: attributeName, genName,
    parameterName, parameterValue: String(parameterValue),
  })
}
export async function listGeneratorsOf(domainId, attributeName) {
  const d = await grPost('/generator/list', { organizationId: requireOrg(), domainId, name: attributeName })
  return d?.generators ?? []
}

// ── Preview de datos por REST (genera muestra sin el Runtime) ────────────────
export async function previewDomain(domainId, loopCount = 10) {
  return grPost('/domain/preview', { organizationId: requireOrg(), domainId, loopCount: String(loopCount) })
}
export async function previewAttribute(domainId, attributeName, loopCount = 10, genName) {
  const body = { organizationId: requireOrg(), domainId, name: attributeName, loopCount: String(loopCount) }
  if (genName) { body.genName = genName }
  return grPost('/attribute/preview', body)
}

// ── Autoría en lote ──────────────────────────────────────────────────────────
export async function createDomainRest(projectName, version, name, description = '') {
  return grPost('/domain/create', { organizationId: requireOrg(), projectName, versionNumber: version, name, description })
}
export async function createAllAttributes(domainId, names, autoGenerator = true) {
  return grPost('/attribute/createAll', { organizationId: requireOrg(), domainId, attributes: names, autoGenerator })
}

// ── Receivers (salida: CSV/JSON/XML/SQL/BD) ─────────────────────────────────
export async function listDomainReceivers(domainId) {
  const d = await grPost('/domainReceiver/list', { organizationId: requireOrg(), domainId })
  return d?.domainReceivers ?? []
}
// GenRocket normaliza los nombres de atributo (quita separadores, camelCase): fecha_nacimiento -> fechaNacimiento
export function grNorm(name) {
  const parts = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (!parts.length) { return name }
  return parts.map((w, i) => i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

// Mapa de alias amigables a los tipos reales de receiver de GenRocket
const RECEIVER_MAP = {
  csv: 'DelimitedFileReceiver', delimited: 'DelimitedFileReceiver',
  json: 'JSONFileReceiver', xml: 'XMLFileReceiver',
  excel: 'ExcelFileReceiver', xlsx: 'ExcelFileReceiver',
}
export async function addDomainReceiver(domainId, receiverType, receiverName) {
  const rt = RECEIVER_MAP[String(receiverType || '').toLowerCase()] || receiverType
  return grPost('/domainReceiver/add', { organizationId: requireOrg(), domainId, receiverType: rt, receiverName: receiverName || rt })
}
export async function removeDomainReceiver(domainId, receiverName) {
  return grPost('/domainReceiver/remove', { organizationId: requireOrg(), domainId, receiverName })
}
export async function setReceiverParameter(domainId, receiverName, parameterName, parameterValue) {
  return grPost('/receiverParameter/update', { organizationId: requireOrg(), domainId, receiverName, parameterName, parameterValue: String(parameterValue) })
}

// Versiones del Runtime/Engine disponibles en el tenant (para instalar la correcta)
export async function runtimeVersions() {
  const org = requireOrg()
  const [rt, eng] = await Promise.all([
    grPost('/runtime/list', { organizationId: org }).catch(() => ({})),
    grPost('/runtime/engine/list', { organizationId: org }).catch(() => ({})),
  ])
  const active = (o, key) => (o?.[key] || []).find(x => x.active)?.versionNumber
  return { runtime: active(rt, 'grRuntimes'), engine: active(eng, 'engineJars') }
}

// Catálogo de generadores (cacheado en el proceso para que sea rápido)
let _genCache = null
async function fetchAllGenerators() {
  if (_genCache) { return _genCache }
  const data = await grPost('/generators/list', { organizationId: requireOrg() })
  _genCache = data?.generators ?? []
  return _genCache
}
export async function listAvailableGenerators(filter) {
  let gens = await fetchAllGenerators()
  if (filter) {
    const f = String(filter).toLowerCase()
    gens = gens.filter(g => (g.name || '').toLowerCase().includes(f) || (g.description || '').toLowerCase().includes(f))
  }
  return gens
}

// Deriva palabras clave del nombre del atributo para filtrar generadores.
function keywordsForAttribute(attr) {
  const n = String(attr || '').toLowerCase()
  const map = [
    [/(fecha|date|nacimiento|birth|dob|dia|\bday\b|time|hora)/, ['date', 'time']],
    [/(nombre|name|first|last|apellido|fullname)/, ['name']],
    [/(email|correo|mail)/, ['email']],
    [/(phone|tel|celular|movil|mobile)/, ['phone']],
    [/(direccion|address|calle|street)/, ['address', 'street']],
    [/(ciudad|city)/, ['city']],
    [/(estado|state|province|provincia)/, ['state']],
    [/(pais|country)/, ['country']],
    [/(zip|postal|\bcp\b)/, ['zip', 'postal']],
    [/(edad|age)/, ['age', 'integer']],
    [/(monto|amount|precio|price|salary|salario|money|importe|saldo|balance)/, ['money', 'currency', 'decimal']],
    [/(activo|active|flag|bool|habilitado|enabled|estatus|status)/, ['boolean']],
    [/(genero|gender|sexo)/, ['gender']],
    [/(porcentaje|percent|rate|tasa)/, ['percent', 'decimal']],
    [/(id|codigo|code|number|numero|\bnum\b|folio)/, ['id', 'number', 'integer', 'uuid']],
  ]
  for (const [re, kws] of map) { if (re.test(n)) { return kws } }
  return []
}

export async function suggestGenerators(attributeName, limit = 15) {
  const all = await fetchAllGenerators()
  const kws = keywordsForAttribute(attributeName)
  let matches = []
  if (kws.length) {
    matches = all.filter(g => {
      const hay = `${g.name || ''} ${g.description || ''}`.toLowerCase()
      return kws.some(k => hay.includes(k))
    })
  }
  if (!matches.length) {
    const tok = String(attributeName || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    if (tok) { matches = all.filter(g => (g.name || '').toLowerCase().includes(tok)) }
  }
  return { keywords: kws, generators: matches.slice(0, limit), total: all.length }
}

// Valida un nombre de generador contra el catálogo real de la organización.
// Devuelve { exact } con el nombre bien escrito si existe, o { suggestions } con
// parecidos (útil porque el catálogo tiene ~cientos de nombres no obvios).
export async function resolveGenerator(name) {
  const all = await fetchAllGenerators()
  const raw = String(name || '').trim()
  const lower = raw.toLowerCase()
  const exact = all.find(g => (g.name || '').toLowerCase() === lower)
  if (exact) { return { exact: exact.name, suggestions: [] } }
  // Tokens del nombre pedido (parte camelCase y separadores), sin el sufijo "gen".
  const tokens = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    .split(/[^a-z0-9]+/).filter(t => t && t !== 'gen' && t.length > 2)
  const scored = all.map(g => {
    const n = (g.name || '').toLowerCase()
    let score = 0
    if (lower && n.includes(lower)) { score += 5 }
    for (const t of tokens) { if (n.includes(t)) { score += 1 } }
    return { name: g.name, score }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score)
  return { exact: null, suggestions: scored.slice(0, 12).map(x => x.name) }
}

// ── Módulo de Base de Datos (JDBC de solo lectura: Oracle + SQL Server) ──────
const JAVA_BIN = process.env.GENROCKET_JAVA || 'java'
const DBQUERY_JAR = process.env.GENROCKET_DBQUERY_JAR || fileURLToPath(new URL('./db/dbquery.jar', import.meta.url))

function dbConnections() {
  if (Array.isArray(FILECFG.dbConnections)) { return FILECFG.dbConnections }
  try { return JSON.parse(process.env.GENROCKET_DB_JSON || '[]') } catch { return [] }
}
function dbEnvPwName(name) { return 'GENROCKET_DB_PW_' + String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_') }
export function getConn(name) {
  const conns = dbConnections()
  if (!conns.length) throw new Error('No hay conexiones de BD configuradas.')
  const c = name ? conns.find(x => x.name === name) : conns[0]
  if (!c) throw new Error(`Conexión "${name}" no encontrada. Disponibles: ${conns.map(x => x.name).join(', ')}`)
  return { type: 'oracle', ...c, password: c.password || process.env[dbEnvPwName(c.name)] || '' }
}

/** Expone la config cargada (baseUrl, githubToken, etc.) a otros módulos del MCP. */
export function getConfig() { return FILECFG }

function assertSelectOnly(sql) {
  if (!/^\s*(select|with)\b/i.test(sql || '')) throw new Error('Solo se permiten consultas SELECT (modo solo lectura).')
}

export async function dbRun(conn, sql, maxRows = 500) {
  if (!conn.driverJar) throw new Error(`La conexión "${conn.name}" no tiene driverJar (ruta al ojdbc / mssql-jdbc .jar).`)
  if (!conn.jdbcUrl) throw new Error(`La conexión "${conn.name}" no tiene jdbcUrl.`)
  assertSelectOnly(sql)
  // driverJar puede ser un .jar o una CARPETA. Si es carpeta, usamos el comodín de
  // classpath de Java (`dir/*`) para incluir todos los .jar de ahí — así apuntar a
  // la carpeta lib del Runtime también funciona.
  let driverCp = conn.driverJar
  try {
    if (existsSync(conn.driverJar) && statSync(conn.driverJar).isDirectory()) {
      driverCp = join(conn.driverJar, '*')
    } else if (!existsSync(conn.driverJar)) {
      throw new Error(`El driverJar de "${conn.name}" no existe: ${conn.driverJar}. Debe ser la ruta al .jar del driver (o a la carpeta que lo contiene).`)
    }
  } catch (e) { if (/no existe/.test(e.message)) throw e /* otros errores de stat: seguimos con el valor tal cual */ }
  const cp = `${driverCp}${pathDelimiter}${DBQUERY_JAR}`
  return new Promise((resolve, reject) => {
    const child = spawn(JAVA_BIN, ['-cp', cp, 'DbQuery'], {
      env: { ...process.env, DB_URL: conn.jdbcUrl, DB_USER: conn.user || '', DB_PASSWORD: conn.password || '', DB_MAXROWS: String(maxRows) },
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => reject(new Error(`No se pudo ejecutar java (${JAVA_BIN}): ${e.message}. ¿Está Java en el PATH o mal configurado GENROCKET_JAVA?`)))
    child.on('close', (code) => {
      const raw = out.trim()
      // El JVM puede fallar ANTES de imprimir nada (driver no encontrado en el
      // classpath, UnsupportedClassVersionError, etc.): stdout vacío + error en stderr.
      // Antes esto se tragaba (JSON.parse('{}')) y devolvía "(sin columnas)".
      if (!raw) {
        const detalle = err.trim() || `El helper JDBC terminó con código ${code} sin salida.`
        const hint = /UnsupportedClassVersion/i.test(err)
          ? ' El helper necesita un Java más nuevo: apunta GENROCKET_JAVA a un JDK 8+.'
          : (/ClassNotFound|NoClassDefFound|No suitable driver/i.test(err)
            ? ' No se encontró el driver JDBC: revisa que driverJar apunte al .jar correcto (ojdbc para Oracle, mssql-jdbc para SQL Server).'
            : '')
        return reject(new Error(detalle + hint))
      }
      let j
      try { j = JSON.parse(raw) } catch { return reject(new Error(err.trim() || raw)) }
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

// Formatea el resultado de una corrida del Runtime (chain/escenario) mostrando
// exit code, archivos y —clave para diagnosticar fallos de licencia/POI/etc.—
// el stdout/stderr. Antes varias tools ocultaban stdout/stderr y había que correr
// el Runtime a mano con -d true para ver el error real.
function fmtRuntimeRun(titulo, r, emptyMsg) {
  const outs = r.outputs.length
    ? r.outputs.map(f => `  - ${f.name} (${f.bytes} bytes)`).join('\n')
    : `  ${emptyMsg}`
  const warn = r.exitCode !== 0 ? ` AVISO: el Runtime terminó con código ${r.exitCode}; revisa stderr abajo.` : ''
  return [
    `${titulo} (exit ${r.exitCode}).${warn}`,
    `Carpeta: ${r.dir}`,
    `Archivos:\n${outs}`,
    r.stdout ? `\n--- stdout (fin) ---\n${r.stdout}` : '',
    r.stderr ? `\n--- stderr (fin) ---\n${r.stderr}` : '',
  ].filter(Boolean).join('\n')
}

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
    'genrocket_list_projects',
    'Lista TODOS los proyectos de la organización en GenRocket con sus versiones (POST /project/list). Úsalo para saber el nombre EXACTO de un proyecto antes de listar dominios/escenarios (evita errores de tipeo, p.ej. guiones bajos de más). Opcional: "filter" para buscar por texto en el nombre.',
    {
      filter: z.string().optional().describe('Filtra por texto en el nombre del proyecto (opcional).'),
    },
    async ({ filter }) => {
      try {
        let projects = await listProjects()
        if (filter) { const f = filter.toLowerCase(); projects = projects.filter(p => (p.name || '').toLowerCase().includes(f)) }
        if (!projects.length) { return ok(filter ? `Ningún proyecto coincide con "${filter}".` : 'Sin proyectos en la organización.') }
        const lines = projects.map(p => {
          const vers = (p.projectVersions || []).map(v => v.versionNumber).join(', ') || '1.0'
          return `- ${p.name}  (v: ${vers})${p.locked ? '  [bloqueado]' : ''}`
        }).join('\n')
        return ok(`Proyectos (${projects.length}):\n${lines}`)
      } catch (e) { return bad(`list_projects: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_show_domain',
    'Muestra un dominio COMPLETO por su domainId (POST /domain/show): sus atributos con el generador asignado a cada uno, variables globales y receivers. Una sola llamada en vez de listar dominios + generadores por atributo. Usa el externalId del dominio (de genrocket_list_domains).',
    {
      domainId: z.string().describe('externalId del dominio (de genrocket_list_domains)'),
    },
    async ({ domainId }) => {
      try {
        const d = await showDomain(domainId)
        if (!d || !d.name) { return bad(`Dominio ${domainId} no encontrado.`) }
        const attrs = d.attributes || []
        const lines = attrs.map(a => {
          const gen = (a.generators || []).map(g => g.generatorType || g.name).filter(Boolean).join(' -> ') || '(sin generador)'
          return `  ${a.attributeOrder ?? ''} ${a.name}${a.primaryAttribute ? ' [PK]' : ''}: ${gen}`
        }).join('\n')
        const recv = (d.domainReceivers || []).map(r => r.receiverType || r.name).filter(Boolean).join(', ')
        return ok(`Dominio "${d.name}" (${d.projectName || '?'} v${d.versionNumber || '?'}) — ${attrs.length} atributos:\n${lines}${recv ? `\nReceivers: ${recv}` : ''}`)
      } catch (e) { return bad(`show_domain: ${e.message}`) }
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
    'genrocket_preview_domain',
    'GENERA y MUESTRA datos sinteticos de un dominio via REST (sin necesidad del Runtime). POST /domain/preview. Devuelve filas de ejemplo (columnas = atributos). Ideal cuando el usuario pide "dame datos de ejemplo" o "como quedarian los datos".',
    {
      domainId: z.string().describe('externalId del dominio (de genrocket_list_domains)'),
      loopCount: z.number().int().positive().optional().describe('Cuantas filas generar (default 10)'),
    },
    async ({ domainId, loopCount = 10 }) => {
      try {
        const d = await previewDomain(domainId, loopCount)
        const cols = d.attributes || []
        const rows = d.attributeData || []
        if (!cols.length) { return ok(JSON.stringify(d).slice(0, 800)) }
        const head = cols.join(' | ')
        const body = rows.map(r => r.join(' | ')).join('\n')
        return ok(`Datos generados (${rows.length} filas):\n${head}\n${'-'.repeat(Math.min(head.length, 80))}\n${body}`)
      } catch (e) { return bad(`preview_domain: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_preview_attribute',
    'Genera y muestra los valores de UN atributo via REST. POST /attribute/preview. Util para ver que produce el generador de un atributo.',
    {
      domainId: z.string(),
      attributeName: z.string(),
      loopCount: z.number().int().positive().optional().describe('Cuantos valores (default 10)'),
      genName: z.string().optional().describe('Posicion del generador (opcional, ej. gen1)'),
    },
    async ({ domainId, attributeName, loopCount = 10, genName }) => {
      try {
        const d = await previewAttribute(domainId, attributeName, loopCount, genName)
        const vals = d.attributeData || d.data || d.values || d
        return ok(`Valores generados de "${attributeName}":\n${JSON.stringify(vals).slice(0, 1500)}`)
      } catch (e) { return bad(`preview_attribute: ${e.message}`) }
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
    'genrocket_download_chain',
    'Descarga el paquete .grs de una CHAIN (ZIP con todos sus escenarios) por su chainId (externalId de genrocket_list_chains). Para el Runtime.',
    { chainId: z.string() },
    async ({ chainId }) => {
      try { const { filename, bytes } = await downloadChain(chainId); return ok(`Chain descargada: ${filename} (${bytes.length} bytes, ZIP .grs).`) }
      catch (e) { return bad(`download_chain: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_run_chain',
    'Ejecuta una CHAIN completa con el Runtime local: descarga su .grs y corre todos sus escenarios, generando datos. Requiere el Runtime instalado (GENROCKET_RUNTIME_CMD).',
    { chainId: z.string().describe('externalId de la chain (de genrocket_list_chains)'), chainName: z.string().optional() },
    async ({ chainId, chainName }) => {
      try {
        const r = await runChain(chainId, { chainName })
        return ok(fmtRuntimeRun('Chain ejecutada', r, '(sin archivos; revisa los receivers de los escenarios de la chain)'))
      } catch (e) { return bad(`run_chain: ${e.message}`) }
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
    'genrocket_runtime_versions',
    'Muestra la version ACTIVA del GenRocket Runtime y del Engine en tu tenant (para instalar/usar la version correcta del Runtime local). No genera datos.',
    {},
    async () => {
      try { const v = await runtimeVersions(); return ok(`Runtime activo: ${v.runtime || '?'} | Engine activo: ${v.engine || '?'}`) }
      catch (e) { return bad(`runtime_versions: ${e.message}`) }
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
        return ok(fmtRuntimeRun('Runtime ejecutado', r, '(no se generaron archivos nuevos; revisa los receivers configurados en el escenario)'))
      } catch (e) {
        return bad(`No se pudo ejecutar el Runtime: ${e.message}`)
      }
    }
  )

  // ── Autoría por REST (endpoints confirmados del spec oficial) ────────────
  server.tool(
    'genrocket_create_attribute',
    'Crea un atributo en un dominio (POST /attribute/create). Payload real: domainId, name, autoGenerator. Si autoGenerator=true, GenRocket asigna un generador por defecto; si vas a poner uno especifico usa false y luego genrocket_add_generator (o mejor genrocket_create_attribute_with_generator).',
    {
      domainId: z.string().describe('externalId del dominio (de genrocket_list_domains)'),
      name: z.string().describe('Nombre del atributo'),
      autoGenerator: z.boolean().optional().describe('true = generador por defecto (default false)'),
    },
    async ({ domainId, name, autoGenerator = false }) => {
      try { await createAttr(domainId, name, autoGenerator); return ok(`Atributo "${name}" creado.${autoGenerator ? ' (con generador por defecto)' : ''}`) }
      catch (e) { return bad(`create_attribute: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_create_domain',
    'Crea un dominio en un proyecto (POST /domain/create). Payload: projectName, versionNumber, name, description. Devuelve el dominio (usa genrocket_list_domains para obtener su domainId despues).',
    {
      projectName: z.string(),
      version: z.string().optional().describe('Version (default 1.0)'),
      name: z.string().describe('Nombre del dominio'),
      description: z.string().optional(),
    },
    async ({ projectName, version = '1.0', name, description = '' }) => {
      try { const d = await createDomainRest(projectName, version, name, description); return ok(`Dominio "${name}" creado en ${projectName} v${version}. ${JSON.stringify(d).slice(0, 300)}`) }
      catch (e) { return bad(`create_domain: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_bulk_create_attributes',
    'AUTORIA EN LOTE: crea MUCHOS atributos de un dominio en un solo paso (POST /attribute/createAll) y opcionalmente asigna un generador especifico a cada uno. Pasa "attributes" como lista de nombres (["id","nombre","fecha"]) o como lista de objetos {name, generator?, parameters?} para controlar el generador. Con autoGenerator=true (default) GenRocket asigna un generador por defecto a cada atributo; los que traigan "generator" se sobreescriben con ese.',
    {
      domainId: z.string().describe('externalId del dominio'),
      attributes: z.array(z.union([
        z.string(),
        z.object({ name: z.string(), generator: z.string().optional(), parameters: z.record(z.any()).optional() }),
      ])).describe('Lista de nombres, o de objetos {name, generator?, parameters?}'),
      autoGenerator: z.boolean().optional().describe('Asignar generador por defecto a cada atributo (default true)'),
    },
    async ({ domainId, attributes, autoGenerator = true }) => {
      try {
        const norm = attributes.map(a => typeof a === 'string' ? { name: a } : a)
        const names = norm.map(a => a.name)
        await createAllAttributes(domainId, names, autoGenerator)
        const withGen = norm.filter(a => a.generator)
        const done = []
        for (const a of withGen) {
          const real = grNorm(a.name)  // GenRocket normaliza el nombre (fecha_nacimiento -> fechaNacimiento)
          try {
            await deleteGenerators(domainId, real).catch(() => {})
            await addGenerator(domainId, real, a.generator)
            for (const [pn, pv] of Object.entries(a.parameters || {})) {
              await setGeneratorParameter(domainId, real, 'gen1', pn, pv)
            }
            done.push(`${real}→${a.generator}`)
          } catch (e) { done.push(`${real}: ERROR ${e.message}`) }
        }
        return ok(
          `Creados ${names.length} atributos: ${names.join(', ')}.` +
          (withGen.length ? `\nGeneradores asignados: ${done.join(' | ')}` : ' (con generador por defecto)'),
        )
      } catch (e) { return bad(`bulk_create_attributes: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_list_domain_receivers',
    'Lista los receivers (salidas) configurados en un dominio y sus parametros (outputPath, fileName, etc.). POST /domainReceiver/list.',
    { domainId: z.string() },
    async ({ domainId }) => {
      try {
        const recs = await listDomainReceivers(domainId)
        if (!recs.length) { return ok('El dominio no tiene receivers configurados.') }
        const lines = recs.map(r => {
          const params = (r.receiverParameters || []).map(p => `${p.name}=${p.value}`).join(', ')
          return `- ${r.name} (${r.receiverType})${params ? `\n    ${params}` : ''}`
        }).join('\n')
        return ok(`Receivers del dominio:\n${lines}`)
      } catch (e) { return bad(`list_domain_receivers: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_add_domain_receiver',
    'Agrega un receiver (salida) a un dominio para exportar los datos generados. POST /domainReceiver/add. Puedes usar alias: "csv" (=DelimitedFileReceiver), "json" (=JSONFileReceiver), "xml" (=XMLFileReceiver), "excel" (=ExcelFileReceiver). Despues configura outputPath/fileName con genrocket_set_receiver_parameter.',
    {
      domainId: z.string(),
      receiverType: z.string().describe('Tipo de receiver, ej. CSVFileReceiver, JSONFileReceiver, XMLFileReceiver'),
      receiverName: z.string().optional().describe('Nombre (default = receiverType)'),
    },
    async ({ domainId, receiverType, receiverName }) => {
      try { await addDomainReceiver(domainId, receiverType, receiverName); return ok(`Receiver "${receiverName || receiverType}" (${receiverType}) agregado al dominio.`) }
      catch (e) { return bad(`add_domain_receiver: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_set_receiver_parameter',
    'Configura un parametro de un receiver (ej. outputPath, fileName, delimiter, recordsPerFile). POST /receiverParameter/update.',
    { domainId: z.string(), receiverName: z.string(), parameterName: z.string(), parameterValue: z.union([z.string(), z.number(), z.boolean()]) },
    async ({ domainId, receiverName, parameterName, parameterValue }) => {
      try { await setReceiverParameter(domainId, receiverName, parameterName, parameterValue); return ok(`Parametro "${parameterName}"="${parameterValue}" seteado en el receiver "${receiverName}".`) }
      catch (e) { return bad(`set_receiver_parameter: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_remove_domain_receiver',
    'Quita un receiver de un dominio. POST /domainReceiver/remove.',
    { domainId: z.string(), receiverName: z.string() },
    async ({ domainId, receiverName }) => {
      try { await removeDomainReceiver(domainId, receiverName); return ok(`Receiver "${receiverName}" eliminado del dominio.`) }
      catch (e) { return bad(`remove_domain_receiver: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_add_generator',
    'Asigna un generador a un atributo (POST /generator/add). IMPORTANTE: GenRocket se CUELGA (error 500) si se agrega un generador sobre uno ya existente, así que esta tool primero limpia (deleteAll) y luego asigna — es idempotente y REEMPLAZA el generador anterior. Payload: domainId, name (atributo), genType (ej. FlexibleDateRangeGen; usa genrocket_available_generators). Para validar el nombre contra el catálogo usa genrocket_assign_generator.',
    { domainId: z.string(), attributeName: z.string(), genType: z.string() },
    async ({ domainId, attributeName, genType }) => {
      try {
        // Nunca agregar sobre un generador existente: el servidor se cuelga/500.
        await deleteGenerators(domainId, attributeName).catch(() => {})
        await addGenerator(domainId, attributeName, genType)
        return ok(`Generador "${genType}" asignado a "${attributeName}" (se reemplazó el anterior si había).`)
      } catch (e) { return bad(`add_generator: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_assign_generator',
    'Asigna (carga) un generador a un atributo EXISTENTE de un dominio. VALIDA el genType contra el catálogo real de la organización (/generators/list) y, si no existe, sugiere nombres parecidos (el catálogo tiene cientos de nombres no obvios, p.ej. no hay "FirstNameGen" genérico). Por defecto REEMPLAZA el generador actual del atributo. Acepta parámetros del generador. Endpoint validado en GenRocket 3.12: POST /generator/add. Para ver nombres válidos usa genrocket_available_generators o genrocket_suggest_generators.',
    {
      domainId: z.string().describe('externalId del dominio (de genrocket_list_domains)'),
      attributeName: z.string().describe('Nombre del atributo EXISTENTE al que se le carga el generador'),
      genType: z.string().describe('Nombre del generador del catálogo (ej. EmailGen). Se valida y se corrige mayúsculas/minúsculas.'),
      parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Parámetros del generador (objeto nombre:valor), opcional'),
      replace: z.boolean().optional().describe('Quitar los generadores previos del atributo antes de asignar (default true)'),
    },
    async ({ domainId, attributeName, genType, parameters = {}, replace = true }) => {
      try {
        const { exact, suggestions } = await resolveGenerator(genType)
        if (!exact) {
          const hint = suggestions.length
            ? `\nParecidos en el catálogo: ${suggestions.join(', ')}`
            : '\nUsa genrocket_available_generators (con "filter") para ver el catálogo.'
          return bad(`El generador "${genType}" no existe en el catálogo de la organización.${hint}`)
        }
        if (replace) { await deleteGenerators(domainId, attributeName).catch(() => {}) }
        await addGenerator(domainId, attributeName, exact)
        const steps = [`generador "${exact}" asignado a "${attributeName}"`]
        for (const [pn, pv] of Object.entries(parameters || {})) {
          await setGeneratorParameter(domainId, attributeName, 'gen1', pn, pv)
          steps.push(`${pn}=${pv}`)
        }
        // Verificación best-effort: /generator/list a veces es lento; no bloquear el éxito por eso.
        let verif
        try {
          const gens = await listGeneratorsOf(domainId, attributeName)
          const names = gens.map(g => g.generatorType || g.generator || g.name).filter(Boolean)
          verif = names.length ? `\nVerificado: ${names.join(', ')}` : '\n(El alta respondió OK; el listado quedó vacío al verificar.)'
        } catch { verif = '\n(No se pudo verificar: el listado de generadores no respondió a tiempo; el alta respondió OK.)' }
        return ok(`Listo: ${steps.join(' | ')}.${verif}`)
      } catch (e) { return bad(`assign_generator: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_set_generator_parameter',
    'Configura un parametro de un generador ya agregado (POST /generatorParameter/update): domainId, name (atributo), genName (posicion, ej. gen1), parameterName, parameterValue.',
    {
      domainId: z.string(), attributeName: z.string(),
      genName: z.string().optional().describe('Posicion del generador (default gen1)'),
      parameterName: z.string(), parameterValue: z.union([z.string(), z.number(), z.boolean()]),
    },
    async ({ domainId, attributeName, genName = 'gen1', parameterName, parameterValue }) => {
      try { await setGeneratorParameter(domainId, attributeName, genName, parameterName, parameterValue); return ok(`Parametro ${parameterName}="${parameterValue}" seteado en ${genName}.`) }
      catch (e) { return bad(`set_generator_parameter: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_generator_parameters',
    'Muestra los generadores ASIGNADOS a un atributo con sus PARÁMETROS reales (nombre y valor actual) tal como los expone GenRocket (POST /generator/list por dominio). Úsalo para saber los nombres EXACTOS de parámetros válidos ANTES de cambiarlos con genrocket_set_generator_parameter — así evitas el "Invalid parameter name"/500 por adivinar. Requiere que el atributo ya tenga el generador asignado.',
    { domainId: z.string(), attributeName: z.string().describe('Nombre del atributo (se normaliza como en GenRocket)') },
    async ({ domainId, attributeName }) => {
      try {
        const real = grNorm(attributeName)
        const gens = await listGeneratorsOf(domainId, real)
        if (!gens.length) return ok(`El atributo "${real}" no tiene generadores asignados (o el dominio/atributo no existe). Asígnale uno con genrocket_assign_generator.`)
        const lines = gens.map((g, i) => {
          const gname = g.generatorType || g.generator || g.name || `gen${i + 1}`
          const pos = g.genName || g.name || `gen${i + 1}`
          // El objeto de parámetros varía según versión; probamos las formas conocidas.
          const params = Array.isArray(g.parameters) ? g.parameters
            : (Array.isArray(g.generatorParameters) ? g.generatorParameters
              : (Array.isArray(g.params) ? g.params : []))
          const pl = params.length
            ? params.map(p => {
              const pn = p.name ?? p.parameterName ?? p.key ?? '?'
              const pv = p.value ?? p.parameterValue ?? p.defaultValue ?? ''
              return `    - ${pn} = ${pv === '' ? '(vacío)' : pv}`
            }).join('\n')
            : '    (la API no expuso parámetros para este generador)'
          return `- ${gname}  [posición: ${pos}]\n${pl}`
        }).join('\n')
        return ok(`Generadores y parámetros de "${real}":\n${lines}\n\nPara cambiar uno: genrocket_set_generator_parameter(domainId, attributeName="${real}", genName=<posición>, parameterName=<nombre EXACTO de arriba>, parameterValue=...).`)
      } catch (e) { return bad(`generator_parameters: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_delete_generators',
    'Quita TODOS los generadores de un atributo (POST /generator/deleteAll). Util antes de asignar uno nuevo.',
    { domainId: z.string(), attributeName: z.string() },
    async ({ domainId, attributeName }) => {
      try { await deleteGenerators(domainId, attributeName); return ok(`Generadores de "${attributeName}" eliminados.`) }
      catch (e) { return bad(`delete_generators: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_create_attribute_with_generator',
    'TODO EN UNO: crea el atributo, le asigna el generador con sus parametros y verifica. Recomendado: (1) genrocket_suggest_generators para el genType, (2) PREGUNTA al usuario, (3) llama esto con domainId, name, genType y parameters (objeto nombre:valor, opcional).',
    {
      domainId: z.string(), name: z.string().describe('Nombre del atributo'),
      genType: z.string().optional().describe('Tipo de generador (de genrocket_suggest_generators)'),
      parameters: z.record(z.any()).optional().describe('Parametros del generador (objeto nombre:valor)'),
    },
    async ({ domainId, name, genType, parameters }) => {
      try {
        await createAttr(domainId, name, !genType)
        const real = grNorm(name)  // GenRocket normaliza el nombre al crear (fecha_nacimiento -> fechaNacimiento)
        const steps = [`atributo creado (${real})`]
        if (genType) {
          const { exact, suggestions } = await resolveGenerator(genType)
          if (!exact) { return bad(`El generador "${genType}" no existe en el catálogo.${suggestions.length ? ` Parecidos: ${suggestions.join(', ')}` : ''}`) }
          await deleteGenerators(domainId, real).catch(() => {})  // evita el 500 por add sobre existente
          await addGenerator(domainId, real, exact)
          steps.push(`generador ${exact} asignado`)
          for (const [pn, pv] of Object.entries(parameters || {})) {
            await setGeneratorParameter(domainId, real, 'gen1', pn, pv)
            steps.push(`${pn}=${pv}`)
          }
        }
        const gens = await listGeneratorsOf(domainId, real).catch(() => [])
        const asignados = gens.map(g => g.generatorType || g.generator || g.name).join(', ') || '(ninguno)'
        return ok(`Listo (${steps.join(' | ')}).\nGeneradores en "${real}": ${asignados}`)
      } catch (e) { return bad(`create_attribute_with_generator: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_available_generators',
    'Lista el CATALOGO de generadores disponibles en GenRocket (nombre y descripcion). Usa "filter" para buscar por tema (ej. "date", "name", "email", "phone", "boolean"). IMPORTANTE: usa esta tool ANTES de crear un atributo para saber que generadores existen, proponer 2-3 opciones adecuadas al tipo del atributo (ej. para una fecha: los que contengan "date") y PREGUNTAR al usuario cual prefiere.',
    {
      filter: z.string().optional().describe('Palabra para filtrar (ej. date, name, email, phone, boolean, address)'),
      limit: z.number().int().positive().optional().describe('Maximo a mostrar (default 40)'),
    },
    async ({ filter, limit = 40 }) => {
      try {
        const gens = await listAvailableGenerators(filter)
        if (!gens.length) return ok(filter ? `Sin generadores que coincidan con "${filter}".` : 'Sin generadores.')
        const lines = gens.slice(0, limit).map(g => `- ${g.name}: ${(g.description || '').slice(0, 120)}`).join('\n')
        const extra = gens.length > limit ? `\n… (${gens.length - limit} mas; usa un filtro mas especifico)` : ''
        return ok(`Generadores${filter ? ` que contienen "${filter}"` : ''} (${gens.length}):\n${lines}${extra}`)
      } catch (e) { return bad(`Error al listar generadores: ${e.message}`) }
    }
  )

  server.tool(
    'genrocket_suggest_generators',
    'Sugiere generadores adecuados para un atributo SEGUN SU NOMBRE (rapido, filtra el catalogo por el tema inferido; ej. "fecha_nacimiento" -> generadores de fecha, "correo" -> email). Presenta estas opciones al usuario y preguntale cual usar; el usuario tambien puede indicar uno por nombre directamente.',
    {
      attributeName: z.string().describe('Nombre del atributo (ej. fecha_nacimiento, correo, telefono, edad)'),
      limit: z.number().int().positive().optional().describe('Maximo de sugerencias (default 15)'),
    },
    async ({ attributeName, limit = 15 }) => {
      try {
        const { keywords, generators } = await suggestGenerators(attributeName, limit)
        if (!generators.length) {
          return ok(`No encontre generadores obvios para "${attributeName}". Prueba genrocket_available_generators con un filtro (ej. date, name, email).`)
        }
        const lines = generators.map(g => `- ${g.name}: ${(g.description || '').slice(0, 110)}`).join('\n')
        return ok(`Generadores sugeridos para "${attributeName}"${keywords.length ? ` (tema: ${keywords.join(' / ')})` : ''}:\n${lines}\n\n¿Cual usamos? (o dime otro por su nombre)`)
      } catch (e) { return bad(`Error al sugerir generadores: ${e.message}`) }
    }
  )


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
        return ok(fmtRuntimeRun('Runtime ejecutado', r, '(sin archivos; revisa los receivers configurados en el escenario)'))
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
