/**
 * Exploración de esquema de Base de Datos para GenRocket MCP.
 *
 * Complementa las tools de BD que ya viven en genrocket.mjs (list/test/tables/
 * describe/indexes/sample/query) con la pieza que faltaba: `db_explore`, que
 * introspecciona el catálogo completo (tablas, columnas, claves primarias,
 * relaciones FK e índices) y GENERA UN archivo Markdown por base de datos como
 * contexto para que el agente construya consultas. Reutiliza getConn/dbRun del
 * módulo genrocket para no duplicar la resolución de conexión ni el runner JDBC.
 *
 * El .md se escribe en GENROCKET_DB_CONTEXT_DIR (globalStorage/db-context de la
 * extensión). Nada aquí toca el repo: hosts/credenciales salen solo de la config.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { getConn, dbRun } from './genrocket.mjs'

const DB_CTX_DIR = process.env.GENROCKET_DB_CONTEXT_DIR || join(tmpdir(), 'genrocket-db-context')
const ident = (s) => String(s || '').replace(/[^A-Za-z0-9_$#.]/g, '')

// Tolera fallos de un SELECT de catálogo (permisos/versión) sin abortar la exploración.
async function trySelect(conn, sql, maxRows = 50000) {
  try { return await dbRun(conn, sql, maxRows) } catch { return { columns: [], rows: [], rowCount: 0 } }
}

// ── SQL de catálogo global por motor (una consulta cada uno; se agrupa en JS) ──
const CATALOG = {
  oracle: {
    tables: 'SELECT table_name FROM user_tables ORDER BY table_name',
    columns: 'SELECT table_name, column_name, data_type, data_length, nullable FROM user_tab_columns ORDER BY table_name, column_id',
    pks: "SELECT c.table_name, col.column_name FROM user_constraints c JOIN user_cons_columns col ON c.constraint_name = col.constraint_name WHERE c.constraint_type = 'P' ORDER BY c.table_name, col.position",
    fks: "SELECT a.table_name, a.column_name, pk.table_name AS r_table, b.column_name AS r_column FROM user_cons_columns a JOIN user_constraints c ON a.constraint_name = c.constraint_name AND c.constraint_type = 'R' JOIN user_constraints pk ON c.r_constraint_name = pk.constraint_name JOIN user_cons_columns b ON pk.constraint_name = b.constraint_name AND a.position = b.position ORDER BY a.table_name",
    indexes: 'SELECT i.table_name, i.index_name, i.uniqueness, c.column_name FROM user_indexes i JOIN user_ind_columns c ON i.index_name = c.index_name ORDER BY i.table_name, i.index_name, c.column_position',
    comments: 'SELECT table_name, comments FROM user_tab_comments WHERE comments IS NOT NULL',
    count: (t) => `SELECT COUNT(*) AS N FROM ${ident(t)}`,
  },
  sqlserver: {
    tables: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    columns: 'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS DATA_LENGTH, IS_NULLABLE AS NULLABLE FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_NAME, ORDINAL_POSITION',
    pks: "SELECT tc.TABLE_NAME, kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION",
    fks: 'SELECT tp.name AS TABLE_NAME, cp.name AS COLUMN_NAME, tr.name AS R_TABLE, cr.name AS R_COLUMN FROM sys.foreign_key_columns fkc JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id ORDER BY tp.name',
    indexes: 'SELECT t.name AS TABLE_NAME, i.name AS INDEX_NAME, i.is_unique AS UNIQUENESS, c.name AS COLUMN_NAME FROM sys.indexes i JOIN sys.tables t ON i.object_id = t.object_id JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id WHERE i.type > 0 ORDER BY t.name, i.name, ic.key_ordinal',
    comments: "SELECT t.name AS TABLE_NAME, CAST(ep.value AS NVARCHAR(4000)) AS COMMENTS FROM sys.tables t JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'",
    count: (t) => `SELECT COUNT(*) AS N FROM ${ident(t)}`,
  },
}
const cat = (type) => CATALOG[type === 'sqlserver' ? 'sqlserver' : 'oracle']

function groupByTable(res, mapRow) {
  const m = new Map()
  for (const r of res.rows) {
    const t = String(r[0])
    if (!m.has(t)) m.set(t, [])
    m.get(t).push(mapRow(r))
  }
  return m
}

// ── Introspección → modelo del esquema ──────────────────────────
async function introspect(conn, { maxTables = 400, includeRowCounts = false } = {}) {
  const type = conn.type === 'sqlserver' ? 'sqlserver' : 'oracle'
  const C = cat(type)
  const tablesRes = await trySelect(conn, C.tables)
  let tables = tablesRes.rows.map(r => String(r[0]))
  const totalTables = tables.length
  const truncated = tables.length > maxTables
  if (truncated) tables = tables.slice(0, maxTables)

  const [colsRes, pksRes, fksRes, idxRes, comRes] = await Promise.all([
    trySelect(conn, C.columns),
    trySelect(conn, C.pks),
    trySelect(conn, C.fks),
    trySelect(conn, C.indexes),
    trySelect(conn, C.comments),
  ])

  const cols = groupByTable(colsRes, r => ({ name: String(r[1]), type: String(r[2] ?? ''), len: r[3], nullable: String(r[4] ?? '') }))
  const pks = groupByTable(pksRes, r => String(r[1]))
  const fks = groupByTable(fksRes, r => ({ column: String(r[1]), rTable: String(r[2]), rColumn: String(r[3]) }))
  const idxByTable = new Map()
  for (const r of idxRes.rows) {
    const t = String(r[0]); if (!idxByTable.has(t)) idxByTable.set(t, new Map())
    const byName = idxByTable.get(t); const name = String(r[1])
    if (!byName.has(name)) byName.set(name, { name, unique: /^(1|unique|true)$/i.test(String(r[2])), cols: [] })
    byName.get(name).cols.push(String(r[3]))
  }
  const comments = new Map(comRes.rows.map(r => [String(r[0]), String(r[1] ?? '')]))

  const model = []
  for (const t of tables) {
    const pkCols = new Set(pks.get(t) || [])
    const fkList = fks.get(t) || []
    const fkByCol = new Map(fkList.map(f => [f.column, f]))
    let rowCount = null
    if (includeRowCounts) {
      const cr = await trySelect(conn, C.count(t), 1)
      rowCount = cr.rows.length ? Number(cr.rows[0][0]) : null
    }
    model.push({
      table: t,
      comment: comments.get(t) || '',
      columns: (cols.get(t) || []).map(c => ({ ...c, pk: pkCols.has(c.name), fk: fkByCol.get(c.name) || null })),
      pk: [...pkCols],
      fks: fkList,
      indexes: [...(idxByTable.get(t)?.values() || [])],
      rowCount,
    })
  }
  const relations = model.reduce((a, m) => a + m.fks.length, 0)
  return { type, tables: model, totalTables, shown: tables.length, truncated, relations }
}

// ── Markdown ─────────────────────────────────────────────────────
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_')
function jdbcHost(url) { const m = String(url).match(/@\/\/([^/:;]+)|\/\/([^/:;]+)|@([^:/;]+)/); return (m && (m[1] || m[2] || m[3])) || '' }

function buildMarkdown(conn, model) {
  const L = []
  L.push(`# Base de datos: ${conn.name}`, '')
  L.push(`- Motor: **${model.type === 'sqlserver' ? 'SQL Server' : 'Oracle'}**`)
  const host = jdbcHost(conn.jdbcUrl); if (host) L.push(`- Host: \`${host}\``)
  if (conn.user) L.push(`- Usuario: \`${conn.user}\``)
  L.push(`- Tablas: **${model.totalTables}**${model.truncated ? ` (documentando las primeras ${model.shown})` : ''}`)
  L.push(`- Relaciones (FK): **${model.relations}**`, '')
  L.push('> Contexto generado por GenRocket MCP (`db_explore`) para ayudar a construir consultas SQL de solo lectura.', '')

  const rels = []
  for (const t of model.tables) for (const f of t.fks) rels.push(`${t.table}.${f.column} → ${f.rTable}.${f.rColumn}`)
  if (rels.length) {
    L.push('## Relaciones (claves foráneas)', '')
    for (const r of rels.slice(0, 500)) L.push(`- ${r}`)
    if (rels.length > 500) L.push(`- … (+${rels.length - 500} más)`)
    L.push('')
  }

  L.push('## Tablas', '')
  for (const t of model.tables) {
    L.push(`### ${t.table}${t.rowCount != null ? ` — ${t.rowCount} fila(s)` : ''}`)
    if (t.comment) L.push(`_${t.comment}_`)
    L.push('')
    if (t.columns.length) {
      L.push('| Columna | Tipo | Nulo | Clave |', '| --- | --- | --- | --- |')
      for (const c of t.columns) {
        const type = c.len && !/date|time|clob|blob|number|int|bit|float|real|money/i.test(c.type) ? `${c.type}(${c.len})` : c.type
        const nn = /^(n|no)$/i.test(c.nullable) ? 'NO' : 'sí'
        let key = ''
        if (c.pk) key = 'PK'
        if (c.fk) key = (key ? key + ', ' : '') + `FK→${c.fk.rTable}.${c.fk.rColumn}`
        L.push(`| ${c.name} | ${type} | ${nn} | ${key} |`)
      }
      L.push('')
    } else {
      L.push('_(sin columnas legibles / sin permiso)_', '')
    }
    if (t.indexes.length) {
      L.push('Índices: ' + t.indexes.map(i => `${i.name}${i.unique ? ' (único)' : ''}: ${i.cols.join(', ')}`).join(' · '), '')
    }
  }
  return L.join('\n')
}

function writeContext(conn, md) {
  mkdirSync(DB_CTX_DIR, { recursive: true })
  const file = join(DB_CTX_DIR, `${safeName(conn.name)}.md`)
  writeFileSync(file, md, 'utf8')
  return file
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

// Hook para pruebas (no se usa en runtime).
export const __test = { buildMarkdown, groupByTable, jdbcHost, CATALOG }

// ── Tools ────────────────────────────────────────────────────────
export function registerDbExploreTools(server) {
  server.tool(
    'db_explore',
    'Explora una base de datos COMPLETA (tablas, columnas, claves primarias, relaciones FK e índices) y GENERA un archivo Markdown de contexto por base de datos, útil para que el agente construya consultas SQL. Devuelve la ruta del .md y el contenido. Ejecútalo una vez por conexión antes de armar queries complejas.',
    {
      connection: z.string().optional().describe('Nombre de la conexión (default: la primera).'),
      maxTables: z.number().int().positive().optional().describe('Máximo de tablas a documentar (default 400).'),
      includeRowCounts: z.boolean().optional().describe('Incluir COUNT(*) por tabla (más lento). Default false.'),
    },
    async ({ connection, maxTables, includeRowCounts }) => {
      try {
        const conn = getConn(connection)
        const model = await introspect(conn, { maxTables: maxTables || 400, includeRowCounts: !!includeRowCounts })
        const md = buildMarkdown(conn, model)
        let file = ''
        try { file = writeContext(conn, md) } catch { /* devolvemos el md aunque no se pueda escribir */ }
        const summary = `Exploración de "${conn.name}" (${model.type}): ${model.totalTables} tabla(s)`
          + `${model.truncated ? ` (documentadas ${model.shown})` : ''}, ${model.relations} relación(es) FK.`
          + (file ? `\nContexto guardado en: ${file}` : '\n(No se pudo escribir el archivo; contexto solo en esta respuesta.)')
        return ok(`${summary}\n\n${md}`)
      } catch (e) { return bad(`db_explore: ${e.message}`) }
    },
  )

  server.tool(
    'db_read_context',
    'Lee el archivo Markdown de contexto generado por db_explore para una base de datos (sin re-escanear). Sin "connection": lista los contextos disponibles.',
    { connection: z.string().optional().describe('Nombre de la conexión. Vacío: lista los contextos disponibles.') },
    async ({ connection }) => {
      try {
        if (!connection) {
          let files = []
          try { files = readdirSync(DB_CTX_DIR).filter(f => f.endsWith('.md')) } catch { /* dir aún no existe */ }
          if (!files.length) return ok('Aún no hay contextos. Ejecuta db_explore primero.')
          return ok(`Contextos disponibles:\n${files.map(f => '- ' + f.replace(/\.md$/, '')).join('\n')}`)
        }
        const conn = getConn(connection)
        const file = join(DB_CTX_DIR, `${safeName(conn.name)}.md`)
        if (!existsSync(file)) return ok(`No hay contexto para "${conn.name}". Ejecuta db_explore primero.`)
        return ok(readFileSync(file, 'utf8'))
      } catch (e) { return bad(`db_read_context: ${e.message}`) }
    },
  )
}
