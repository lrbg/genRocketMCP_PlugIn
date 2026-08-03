import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir, readdir, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execAsync = promisify(exec)

export interface GenRocketConfig {
  baseUrl: string
  username: string
  password: string
  organizationId: string
  runtimeCommand?: string
  runtimeOutputDir?: string
}

export interface Attribute { name: string }
export interface Domain { name: string; externalId: string; parent?: string; attributes?: Attribute[] }
export interface Scenario { name: string; externalId?: string }
export interface Chain { name: string; externalId?: string; scenarios?: unknown[] }
export interface ProjectVersion { versionNumber: string }
export interface Project { name: string; description?: string; projectVersions?: ProjectVersion[] }

function grBase(baseUrl: string): string {
  let raw = (baseUrl || '').trim()
  if (!raw) { raw = 'https://app.genrocket.com' }
  if (!/^https?:\/\//i.test(raw)) { raw = `https://${raw}` }
  raw = raw.replace(/\/+$/, '').replace(/\/rest$/i, '')
  return `${raw}/rest`
}

// Token cacheado por proceso (~50 min)
let cachedToken: { key: string; token: string; exp: number } | null = null

async function login(cfg: GenRocketConfig): Promise<string> {
  const base = grBase(cfg.baseUrl)
  const key = `${base}|${cfg.username}`
  const now = Date.now()
  if (cachedToken && cachedToken.key === key && now < cachedToken.exp) { return cachedToken.token }
  if (!cfg.username || !cfg.password) { throw new Error('Falta usuario o contraseña de GenRocket (usa "GenRocket: Set Password").') }
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  })
  if (!res.ok) { throw new Error(`Login GenRocket falló (HTTP ${res.status})`) }
  const header = res.headers.get('x-auth-token') || res.headers.get('auth-token')
  const body: any = await res.json().catch(() => ({}))
  const token = header || body?.accessToken || body?.token
  if (!token) { throw new Error('GenRocket no devolvió token (accessToken/header)') }
  cachedToken = { key, token, exp: now + 50 * 60 * 1000 }
  return token
}

async function grPost<T = any>(cfg: GenRocketConfig, path: string, extra: Record<string, unknown>): Promise<T> {
  const base = grBase(cfg.baseUrl)
  const token = await login(cfg)
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'accept': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ organizationId: cfg.organizationId, ...extra }),
  })
  if (!res.ok) { throw new Error(`GenRocket error ${res.status} en ${path}`) }
  const data: any = await res.json()
  if (data && data.success === false) {
    const msg = data.errors ? Object.values(data.errors).join('; ') : 'GenRocket devolvió success:false'
    throw new Error(msg)
  }
  return data as T
}

export async function testConnection(cfg: GenRocketConfig): Promise<{ username: string; roles: string[] }> {
  const base = grBase(cfg.baseUrl)
  const res = await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  })
  if (!res.ok) { throw new Error(`Login falló (HTTP ${res.status})`) }
  const body: any = await res.json().catch(() => ({}))
  if (!(body?.accessToken || res.headers.get('x-auth-token'))) { throw new Error('No se recibió token') }
  return { username: body?.username ?? cfg.username, roles: body?.roles ?? [] }
}

export async function listProjects(cfg: GenRocketConfig): Promise<Project[]> {
  const d = await grPost<{ projects: Project[] }>(cfg, '/project/list', {})
  return d.projects ?? []
}
export async function listScenarios(cfg: GenRocketConfig, projectName: string, version: string): Promise<Scenario[]> {
  const d = await grPost<{ scenarios: Scenario[] }>(cfg, '/scenario/list', { projectName, versionNumber: version })
  return d.scenarios ?? []
}
export async function listChains(cfg: GenRocketConfig, projectName: string, version: string): Promise<Chain[]> {
  const d = await grPost<{ chains: Chain[] }>(cfg, '/chain/list', { projectName, versionNumber: version })
  return d.chains ?? []
}
export async function listDomains(cfg: GenRocketConfig, projectName: string, version: string): Promise<Domain[]> {
  const d = await grPost<{ domains: Domain[] }>(cfg, '/domain/list', { projectName, versionNumber: version })
  return d.domains ?? []
}
export async function listGenerators(cfg: GenRocketConfig, projectName: string, version: string, domainId: string, attributeName: string): Promise<any[]> {
  // GenRocket espera el nombre del atributo en el campo "name"
  const d = await grPost<{ generators: any[] }>(cfg, '/generator/list', { projectName, versionNumber: version, domainId, name: attributeName })
  return d.generators ?? []
}

// Descarga el ZIP (.grs) del escenario
export async function downloadScenario(cfg: GenRocketConfig, scenarioId: string): Promise<{ filename: string; bytes: Uint8Array }> {
  const base = grBase(cfg.baseUrl)
  const token = await login(cfg)
  const res = await fetch(`${base}/scenario/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ organizationId: cfg.organizationId, scenarioId }),
  })
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const j: any = await res.json().catch(() => ({}))
    const msg = j?.errors ? Object.values(j.errors).join('; ') : (j?.message || 'GenRocket devolvió un error')
    throw new Error(msg)
  }
  if (!res.ok) { throw new Error(`GenRocket error ${res.status} en /scenario/download`) }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const filename = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/)?.[1] || `${scenarioId}.grs`
  return { filename, bytes }
}

export interface RuntimeResult { dir: string; grs: string; exitCode: number; stdout: string; stderr: string; outputs: { name: string; bytes: number }[] }

// Descarga el .grs y ejecuta el GenRocket Runtime local
export async function runScenario(cfg: GenRocketConfig, scenarioId: string, scenarioName?: string): Promise<RuntimeResult> {
  if (!cfg.runtimeCommand) {
    throw new Error('Runtime no configurado. Define "genrocket.runtimeCommand" (usa {grs} y {dir}), ej: java -jar /ruta/GenRocketRuntime.jar {grs}')
  }
  const { filename, bytes } = await downloadScenario(cfg, scenarioId)
  const outBase = cfg.runtimeOutputDir && cfg.runtimeOutputDir.trim() ? cfg.runtimeOutputDir : join(tmpdir(), 'genrocket-runtime')
  const safe = (scenarioName || scenarioId).replace(/[^\w.-]/g, '_')
  const dir = join(outBase, `${safe}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const grsPath = join(dir, filename.endsWith('.grs') ? filename : `${scenarioId}.grs`)
  await writeFile(grsPath, bytes)

  const cmd = cfg.runtimeCommand.replaceAll('{grs}', `"${grsPath}"`).replaceAll('{dir}', `"${dir}"`)
  let stdout = '', stderr = '', exitCode = 0
  try {
    const r = await execAsync(cmd, { cwd: dir, timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 })
    stdout = r.stdout; stderr = r.stderr
  } catch (e: any) {
    exitCode = e.code ?? 1; stdout = e.stdout || ''; stderr = e.stderr || String(e?.message || e)
  }
  const outputs: { name: string; bytes: number }[] = []
  for (const f of await readdir(dir)) {
    const full = join(dir, f)
    if (full === grsPath) { continue }
    const st = await stat(full).catch(() => null)
    if (st?.isFile()) { outputs.push({ name: f, bytes: st.size }) }
  }
  return { dir, grs: grsPath, exitCode, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), outputs }
}
