/**
 * Publicación de datos y contexto a repositorios de GitHub (flujo por agente / MCP).
 *
 * - seed_from_db_and_publish: SELECT real (ej. pólizas) + campos SINTÉTICOS por
 *   fila (Faker) → archivo (csv/json/xlsx) → push a 1..N repos.
 * - domain_to_markdown: un dominio de GenRocket → .md de contexto (opcional push).
 * - project_domains_to_markdown: TODOS los dominios de un proyecto → un .md por
 *   dominio + un índice con patrones (atributos compartidos entre dominios).
 *
 * El push usa el token de GitHub que la extensión inyecta en el config
 * (githubToken); si no hay, se explica cómo obtenerlo. Nunca se guarda en el repo.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { fakeValue, hasFakeType, fieldTypeList } from './faker.mjs'
import {
  getConn, dbRun, getConfig,
  listDomains, previewDomain, listGeneratorsOf,
} from './genrocket.mjs'

const pexec = promisify(execFile)
const MAXBUF = 60 * 1024 * 1024
const REPO_BASE = process.env.GENROCKET_REPO_CACHE || join(homedir(), 'GenRocketRepos')
const OUTDIR = process.env.GENROCKET_PUBLISH_OUTDIR || join(tmpdir(), 'genrocket-publish')

const ok = (text) => ({ content: [{ type: 'text', text }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

// ── Git ──────────────────────────────────────────────────────────────────────
function authArgs(token) {
  if (!token) { return [] }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.extraheader=AUTHORIZATION: Basic ${basic}`]
}
async function g(dir, args, token) {
  return pexec('git', [...authArgs(token), '-C', dir, ...args], { maxBuffer: MAXBUF })
}
function parseRepo(spec) {
  const m = String(spec || '').trim().replace(/\.git$/, '').match(/([^/:]+)\/([^/]+)$/)
  if (!m) { throw new Error(`Repo inválido "${spec}". Usa el formato owner/nombre.`) }
  return { owner: m[1], name: m[2] }
}
async function ensureRepo(token, owner, name) {
  await mkdir(REPO_BASE, { recursive: true })
  const dir = join(REPO_BASE, name)
  if (existsSync(join(dir, '.git'))) {
    try { await g(dir, ['fetch', '--all', '--prune'], token) } catch { /* sin red, seguir */ }
    return dir
  }
  if (existsSync(dir)) { await rm(dir, { recursive: true, force: true }) }
  await pexec('git', [...authArgs(token), 'clone', `https://github.com/${owner}/${name}.git`, dir], { cwd: REPO_BASE, maxBuffer: MAXBUF })
  return dir
}
async function checkoutBranch(dir, branch, token) {
  if (!branch) { return }
  try { await g(dir, ['checkout', branch], token) }
  catch { try { await g(dir, ['checkout', '-b', branch], token) } catch { /* usar rama actual */ } }
  try { await g(dir, ['pull', '--ff-only', 'origin', branch], token) } catch { /* rama nueva o sin upstream */ }
}
/** Copia sourceFile → repo/targetPath, commit y push. Devuelve estado. */
async function publishFileToRepo(token, author, spec, sourceFile, targetPath, branch, message) {
  const { owner, name } = parseRepo(spec)
  const dir = await ensureRepo(token, owner, name)
  await checkoutBranch(dir, branch, token)
  const rel = targetPath.replace(/^[/\\]+/, '')
  const dest = join(dir, rel)
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(sourceFile, dest)
  await g(dir, ['add', rel], token)
  const status = (await g(dir, ['status', '--porcelain'], token)).stdout.trim()
  if (!status) { return { repo: `${owner}/${name}`, pushed: false, note: 'sin cambios (archivo idéntico al del repo)' } }
  await g(dir, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', message], token)
  const cur = (await g(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], token)).stdout.trim()
  const target = branch || cur
  await g(dir, ['push', '-u', 'origin', `HEAD:${target}`], token)
  return { repo: `${owner}/${name}`, pushed: true, branch: target, path: rel }
}
/** Copia VARIOS archivos y hace UN solo commit + push. */
async function publishManyToRepo(token, author, spec, files, branch, message) {
  const { owner, name } = parseRepo(spec)
  const dir = await ensureRepo(token, owner, name)
  await checkoutBranch(dir, branch, token)
  for (const f of files) {
    const rel = f.path.replace(/^[/\\]+/, '')
    const dest = join(dir, rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(f.localFile, dest)
    await g(dir, ['add', rel], token)
  }
  const status = (await g(dir, ['status', '--porcelain'], token)).stdout.trim()
  if (!status) { return { repo: `${owner}/${name}`, pushed: false, note: 'sin cambios' } }
  await g(dir, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', message], token)
  const cur = (await g(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], token)).stdout.trim()
  const target = branch || cur
  await g(dir, ['push', '-u', 'origin', `HEAD:${target}`], token)
  return { repo: `${owner}/${name}`, pushed: true, branch: target, count: files.length }
}
function githubAuth() {
  const cfg = getConfig()
  const token = cfg.githubToken || process.env.GENROCKET_GITHUB_TOKEN || ''
  const login = cfg.githubUser || 'genrocket-bot'
  const author = { name: login, email: cfg.githubEmail || `${login}@users.noreply.github.com` }
  return { token, author }
}

// ── Serialización de datos ────────────────────────────────────────────────────
function csvEscape(v) {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function toCSV(cols, rows) {
  const head = cols.map(csvEscape).join(',')
  const body = rows.map(r => cols.map(c => csvEscape(r[c])).join(',')).join('\r\n')
  return '﻿' + head + '\r\n' + body
}
async function toXlsx(path, cols, rows) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Datos')
  ws.columns = cols.map(c => ({ header: c, key: c, width: 18 }))
  ws.addRows(rows)
  ws.getRow(1).font = { bold: true }
  await wb.xlsx.writeFile(path)
}
/** Mezcla filas reales de BD con campos sintéticos. Devuelve {cols, rows}. */
export function mergeRealAndSynthetic(dbResult, rename = {}, syntheticFields = [], locale = 'es') {
  const dbCols = dbResult.columns || []
  const ren = (c) => rename[c] ?? rename[c.toUpperCase()] ?? rename[c.toLowerCase()] ?? c
  const cols = [...dbCols.map(ren), ...syntheticFields.map(f => f.name)]
  const rows = (dbResult.rows || []).map(r => {
    const o = {}
    dbCols.forEach((c, i) => { o[ren(c)] = r[i] })
    for (const sf of syntheticFields) { o[sf.name] = fakeValue(sf.type, sf, locale) }
    return o
  })
  return { cols, rows }
}
export async function writeDataset(format, cols, rows, absPath) {
  if (format === 'json') { await writeFile(absPath, JSON.stringify(rows, null, 2), 'utf8') }
  else if (format === 'xlsx') { await toXlsx(absPath, cols, rows) }
  else { await writeFile(absPath, toCSV(cols, rows), 'utf8') }
}
function safeBase(name, fallback) {
  return (name || fallback).replace(/[^\w.-]/g, '_').replace(/\.(json|csv|xlsx|md)$/i, '')
}

// ── Markdown de contexto de un dominio ────────────────────────────────────────
export async function buildDomainMarkdown(projectName, version, dom, sampleRows, includeGenerators) {
  const domainId = dom.externalId || dom.id
  const prev = await previewDomain(domainId, sampleRows)
  const attrs = prev.attributes || []
  const data = prev.attributeData || []

  let md = `# Dominio GenRocket: ${dom.name}\n\n`
  md += `- **Proyecto:** ${projectName} (v${version})\n`
  if (dom.description) { md += `- **Descripción:** ${dom.description}\n` }
  md += `- **Atributos:** ${attrs.length}\n- **externalId:** \`${domainId}\`\n\n`

  md += `## Atributos\n\n| # | Atributo | Ejemplo |\n|---|---|---|\n`
  attrs.forEach((a, i) => {
    const sample = (data[0] && data[0][i] != null) ? String(data[0][i]) : ''
    md += `| ${i + 1} | \`${a}\` | ${sample.replace(/\|/g, '\\|')} |\n`
  })

  if (data.length) {
    md += `\n## Muestra de datos (${data.length} filas)\n\n| ${attrs.join(' | ')} |\n| ${attrs.map(() => '---').join(' | ')} |\n`
    for (const row of data) {
      md += `| ${row.map(v => String(v == null ? '' : v).replace(/\|/g, '\\|')).join(' | ')} |\n`
    }
  }

  if (includeGenerators) {
    md += `\n## Generadores por atributo\n\n`
    for (const a of attrs) {
      try {
        const gens = await listGeneratorsOf(domainId, a)
        const parts = gens.map(gn => {
          const ps = (gn.attributeGeneratorParameters || [])
            .filter(p => p.value != null && p.value !== '')
            .map(p => `${p.name}=${p.value}`).join(', ')
          return `${gn.generatorType}${ps ? ` (${ps})` : ''}`
        })
        md += `- \`${a}\`: ${parts.join(' -> ') || '(sin generador)'}\n`
      } catch { md += `- \`${a}\`: (no se pudo leer)\n` }
    }
  }

  md += `\n---\n_Generado automáticamente desde GenRocket como contexto para el agente._\n`
  return { md, attrs, domainId }
}

// ── Registro de tools ─────────────────────────────────────────────────────────
export function registerPublishTools(server) {
  server.tool(
    'seed_from_db_and_publish',
    'Toma datos REALES de la base de datos con un SELECT (ej. números y nombres de póliza), complementa cada fila con campos SINTÉTICOS (teléfono, email, etc. vía Faker), genera un archivo (csv/json/xlsx) y opcionalmente lo SUBE a uno o varios repositorios de GitHub (commit + push). Explora antes con db_list_tables/db_describe_table. Si no pasas "repos", solo genera el archivo (dry-run) y muestra la ruta.',
    {
      connection: z.string().optional().describe('Nombre de la conexión de BD (default: la primera). Ver db_list_connections.'),
      query: z.string().describe('Consulta SELECT que trae los datos REALES (ej. SELECT numero_poliza, nombre FROM polizas WHERE ...).'),
      rename: z.record(z.string()).optional().describe('Renombra columnas de la BD en la salida, ej. {"NUMERO_POLIZA":"policyNumber","NOMBRE":"policyHolder"}.'),
      syntheticFields: z.array(z.object({
        name: z.string(), type: z.string().describe('Tipo Faker: phone, email, address, city, birthdate, integer, etc.'),
        min: z.number().optional(), max: z.number().optional(),
      })).optional().describe('Campos sintéticos a agregar por fila (ver faker_field_types).'),
      limit: z.number().int().positive().max(10000).optional().describe('Máximo de filas reales a traer (default 500).'),
      format: z.enum(['csv', 'json', 'xlsx']).optional().describe('Formato de salida (default csv).'),
      fileName: z.string().optional().describe('Nombre base del archivo (default seed_data).'),
      locale: z.enum(['es', 'en']).optional().describe('Idioma de los datos sintéticos (default es = México).'),
      repos: z.array(z.object({
        repo: z.string().describe('owner/nombre'),
        branch: z.string().optional().describe('Rama destino (default: rama por defecto del repo).'),
        path: z.string().describe('Ruta destino dentro del repo, ej. test-data/polizas.csv'),
      })).optional().describe('Destinos. 1..N repos. Si se omite, solo genera el archivo (no sube nada).'),
      commitMessage: z.string().optional().describe('Mensaje de commit (default automático).'),
    },
    async ({ connection, query, rename = {}, syntheticFields = [], limit = 500, format = 'csv', fileName, locale = 'es', repos = [], commitMessage }) => {
      try {
        if (!/^\s*(select|with)\b/i.test(query || '')) { return bad('Solo se permiten consultas SELECT (modo solo lectura).') }
        const badTypes = syntheticFields.filter(f => !hasFakeType(f.type)).map(f => f.type)
        if (badTypes.length) { return bad(`Tipos sintéticos no soportados: ${[...new Set(badTypes)].join(', ')}. Usa faker_field_types.`) }

        // 1) datos reales
        const conn = getConn(connection)
        const res = await dbRun(conn, query, limit)

        // 2) mezcla real + sintético
        const synCols = syntheticFields.map(f => f.name)
        const { cols, rows } = mergeRealAndSynthetic(res, rename, syntheticFields, locale)
        if (!rows.length) { return bad('La consulta no devolvió filas. Ajusta el WHERE o verifica la tabla.') }

        // 3) archivo local
        await mkdir(OUTDIR, { recursive: true })
        const base = safeBase(fileName, 'seed_data')
        const localFile = join(OUTDIR, `${base}.${format}`)
        await writeDataset(format, cols, rows, localFile)

        const prev = rows.slice(0, 5).map(r => cols.map(c => r[c]).join(' | ')).join('\n')
        let out = `Generadas ${rows.length} filas (${rows.length} reales de BD + ${synCols.length} campos sintéticos por fila).\n`
        out += `Columnas: ${cols.join(', ')}\nArchivo: ${localFile}\n\nVista previa (5):\n${cols.join(' | ')}\n${prev}\n`

        // 4) push a repos
        if (repos.length) {
          const { token, author } = githubAuth()
          if (!token) {
            out += `\nNO se subió a los repos: falta el token de GitHub. En VS Code, conecta tu cuenta de GitHub y vuelve a ejecutar "GenRocket: Registrar servidor MCP" (o guarda la configuración) para inyectar el token; luego reinicia el MCP.`
            return ok(out)
          }
          const msg = commitMessage || `datos generados: ${base}.${format} (${rows.length} filas)`
          out += `\nPublicando en ${repos.length} repo(s) como ${author.name}:`
          for (const d of repos) {
            try {
              const r = await publishFileToRepo(token, author, d.repo, localFile, d.path, d.branch, msg)
              out += r.pushed
                ? `\n  [OK] ${r.repo} -> ${r.path} (rama ${r.branch})`
                : `\n  [-] ${r.repo} -> ${d.path}: ${r.note}`
            } catch (e) {
              out += `\n  [FALLO] ${d.repo}: ${e.message}`
            }
          }
        } else {
          out += `\n(No se especificaron repos: solo se generó el archivo. Pasa "repos" para subirlo.)`
        }
        return ok(out)
      } catch (e) { return bad(`seed_from_db_and_publish: ${e.message}`) }
    },
  )

  server.tool(
    'domain_to_markdown',
    'Convierte UN dominio de GenRocket en un documento Markdown (.md) de CONTEXTO para el agente: lista sus atributos, una muestra de datos (vía domain/preview) y, opcionalmente, los generadores de cada atributo. Puede publicar el .md a uno o varios repos. Para TODOS los dominios de un proyecto a la vez, usa project_domains_to_markdown.',
    {
      projectName: z.string().describe('Nombre exacto del proyecto en GenRocket.'),
      domainName: z.string().describe('Nombre del dominio a documentar.'),
      version: z.string().optional().describe('Versión del proyecto (default 1.0).'),
      sampleRows: z.number().int().positive().max(50).optional().describe('Filas de muestra a incluir (default 8).'),
      includeGenerators: z.boolean().optional().describe('Incluir el generador y parámetros de cada atributo (más lento). Default false.'),
      repos: z.array(z.object({
        repo: z.string().describe('owner/nombre'),
        branch: z.string().optional(),
        path: z.string().optional().describe('Ruta destino (default docs/genrocket/<dominio>.md)'),
      })).optional().describe('Destinos para publicar el .md. Si se omite, solo devuelve el contenido.'),
      commitMessage: z.string().optional(),
    },
    async ({ projectName, domainName, version = '1.0', sampleRows = 8, includeGenerators = false, repos = [], commitMessage }) => {
      try {
        const domains = await listDomains(projectName, version)
        const dom = domains.find(d => (d.name || '').toLowerCase() === domainName.toLowerCase())
        if (!dom) { return bad(`Dominio "${domainName}" no encontrado en ${projectName} v${version}. Disponibles: ${domains.map(d => d.name).join(', ') || '(ninguno)'}`) }
        const { md } = await buildDomainMarkdown(projectName, version, dom, sampleRows, includeGenerators)

        if (repos.length) {
          const { token, author } = githubAuth()
          if (!token) { return ok(md + `\n\n[No se publicó: falta token de GitHub. Conecta GitHub en VS Code y re-registra el MCP.]`) }
          await mkdir(OUTDIR, { recursive: true })
          const base = safeBase(domainName, 'domain')
          const localFile = join(OUTDIR, `${base}.md`)
          await writeFile(localFile, md, 'utf8')
          const msg = commitMessage || `contexto GenRocket: dominio ${dom.name}`
          let out = md + `\n\n---\nPublicación:`
          for (const d of repos) {
            const path = d.path || `docs/genrocket/${base}.md`
            try {
              const r = await publishFileToRepo(token, author, d.repo, localFile, path, d.branch, msg)
              out += r.pushed ? `\n  [OK] ${r.repo} -> ${r.path} (rama ${r.branch})` : `\n  [-] ${r.repo}: ${r.note}`
            } catch (e) { out += `\n  [FALLO] ${d.repo}: ${e.message}` }
          }
          return ok(out)
        }
        return ok(md)
      } catch (e) { return bad(`domain_to_markdown: ${e.message}`) }
    },
  )

  server.tool(
    'project_domains_to_markdown',
    'Genera un .md de CONTEXTO por CADA dominio de un proyecto de GenRocket, más un ÍNDICE que detecta PATRONES entre dominios (atributos con el mismo nombre presentes en varios dominios = posibles relaciones). Ideal para que el agente entienda todos los dominios y sus relaciones. Opcionalmente publica todo a un repo (una carpeta) en un solo commit.',
    {
      projectName: z.string().describe('Nombre exacto del proyecto en GenRocket.'),
      version: z.string().optional().describe('Versión del proyecto (default 1.0).'),
      domainNames: z.array(z.string()).optional().describe('Filtra a estos dominios (default: todos los del proyecto).'),
      sampleRows: z.number().int().positive().max(30).optional().describe('Filas de muestra por dominio (default 6).'),
      includeGenerators: z.boolean().optional().describe('Incluir generadores por atributo (más lento). Default false.'),
      maxDomains: z.number().int().positive().max(200).optional().describe('Tope de dominios a procesar (default 60).'),
      repos: z.array(z.object({
        repo: z.string().describe('owner/nombre'),
        branch: z.string().optional(),
      })).optional().describe('Destinos para publicar la carpeta de contexto. Si se omite, solo devuelve el índice y las rutas locales.'),
      basePath: z.string().optional().describe('Carpeta destino en el repo (default docs/genrocket).'),
      commitMessage: z.string().optional(),
    },
    async ({ projectName, version = '1.0', domainNames = [], sampleRows = 6, includeGenerators = false, maxDomains = 60, repos = [], basePath = 'docs/genrocket', commitMessage }) => {
      try {
        const domains = await listDomains(projectName, version)
        let list = domains
        if (domainNames.length) {
          const set = new Set(domainNames.map(s => s.toLowerCase()))
          list = domains.filter(d => set.has((d.name || '').toLowerCase()))
        }
        if (!list.length) { return bad(`No hay dominios para procesar en ${projectName} v${version}. Disponibles: ${domains.map(d => d.name).join(', ') || '(ninguno)'}`) }
        let truncated = 0
        if (list.length > maxDomains) { truncated = list.length - maxDomains; list = list.slice(0, maxDomains) }

        // 1) construir md por dominio
        const built = []
        for (const dom of list) {
          try {
            const r = await buildDomainMarkdown(projectName, version, dom, sampleRows, includeGenerators)
            built.push({ name: dom.name, md: r.md, attrs: r.attrs })
          } catch (e) {
            built.push({ name: dom.name, md: `# ${dom.name}\n\n(No se pudo generar: ${e.message})\n`, attrs: [], error: e.message })
          }
        }

        // 2) detectar patrones: atributos compartidos entre dominios
        const attrIndex = new Map() // lower -> { display, domains:Set }
        for (const b of built) {
          for (const a of b.attrs) {
            const k = a.toLowerCase()
            if (!attrIndex.has(k)) { attrIndex.set(k, { display: a, domains: new Set() }) }
            attrIndex.get(k).domains.add(b.name)
          }
        }
        const shared = [...attrIndex.values()].filter(x => x.domains.size >= 2).sort((a, b) => b.domains.size - a.domains.size)

        // 3) índice
        let idx = `# Contexto GenRocket — Proyecto ${projectName} (v${version})\n\n`
        idx += `Dominios documentados: **${built.length}**.` + (truncated ? ` (Se omitieron ${truncated} por el tope maxDomains.)` : '') + `\n\n`
        idx += `## Dominios\n\n| Dominio | Atributos | Archivo |\n|---|---|---|\n`
        for (const b of built) {
          const file = `${safeBase(b.name, 'domain')}.md`
          idx += `| ${b.name} | ${b.error ? ('ERROR') : b.attrs.length} | [${file}](./${file}) |\n`
        }
        idx += `\n## Atributos compartidos entre dominios (posibles relaciones / patrones)\n\n`
        if (shared.length) {
          idx += `Estos atributos aparecen con el mismo nombre en más de un dominio; suelen indicar entidades relacionadas o campos reutilizables.\n\n`
          idx += `| Atributo | Aparece en | # dominios |\n|---|---|---|\n`
          for (const s of shared) { idx += `| \`${s.display}\` | ${[...s.domains].join(', ')} | ${s.domains.size} |\n` }
        } else {
          idx += `_No se detectaron atributos con el mismo nombre en más de un dominio._\n`
        }
        idx += `\n---\n_Índice generado automáticamente. Úsalo para entender los dominios y detectar patrones/relaciones entre ellos._\n`

        // 4) escribir archivos locales
        await mkdir(OUTDIR, { recursive: true })
        const files = []
        for (const b of built) {
          const file = `${safeBase(b.name, 'domain')}.md`
          const localFile = join(OUTDIR, file)
          await writeFile(localFile, b.md, 'utf8')
          files.push({ path: `${basePath}/${file}`, localFile })
        }
        const idxLocal = join(OUTDIR, 'README.md')
        await writeFile(idxLocal, idx, 'utf8')
        files.push({ path: `${basePath}/README.md`, localFile: idxLocal })

        let out = idx + `\n\n---\n**${files.length} archivo(s)** generado(s) en \`${OUTDIR}\`. Patrones detectados: ${shared.length} atributo(s) compartido(s).`

        // 5) publicar
        if (repos.length) {
          const { token, author } = githubAuth()
          if (!token) { return ok(out + `\n\n[No se publicó: falta token de GitHub. Conecta GitHub en VS Code y re-registra el MCP.]`) }
          const msg = commitMessage || `contexto GenRocket: ${built.length} dominios de ${projectName}`
          out += `\n\nPublicando en ${repos.length} repo(s) como ${author.name}:`
          for (const d of repos) {
            try {
              const r = await publishManyToRepo(token, author, d.repo, files, d.branch, msg)
              out += r.pushed
                ? `\n  [OK] ${r.repo} -> ${basePath}/ (${r.count} archivos, rama ${r.branch})`
                : `\n  [-] ${r.repo}: ${r.note}`
            } catch (e) { out += `\n  [FALLO] ${d.repo}: ${e.message}` }
          }
        }
        return ok(out)
      } catch (e) { return bad(`project_domains_to_markdown: ${e.message}`) }
    },
  )
}
