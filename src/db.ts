import * as vscode from 'vscode'
import { spawn } from 'child_process'
import * as path from 'path'

export interface DbConn { name: string; type: string; jdbcUrl: string; user: string; driverJar: string }

export function getConnections(): DbConn[] {
  const arr = vscode.workspace.getConfiguration('genrocket').get<any[]>('dbConnections', []) || []
  return arr.filter(d => d && d.name && d.jdbcUrl).map(d => ({
    name: d.name, type: d.type || 'oracle', jdbcUrl: d.jdbcUrl, user: d.user || '', driverJar: d.driverJar || '',
  }))
}

export function pwKey(name: string): string { return 'db.password.' + name }

export async function addConnection(conn: DbConn): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('genrocket')
  const arr = (cfg.get<any[]>('dbConnections', []) || []).filter(d => d && d.name !== conn.name)
  arr.push(conn)
  await cfg.update('dbConnections', arr, vscode.ConfigurationTarget.Global)
}

function assertSelect(sql: string): void {
  if (!/^\s*(select|with)\b/i.test(sql || '')) { throw new Error('Solo se permiten consultas SELECT (modo solo lectura).') }
}

export interface QueryResult { columns: string[]; rows: any[][]; rowCount: number }

export async function runQuery(context: vscode.ExtensionContext, conn: DbConn, password: string, sql: string, maxRows = 200): Promise<QueryResult> {
  if (!conn.driverJar) { throw new Error(`La conexión "${conn.name}" no tiene ruta de driver JDBC (.jar).`) }
  assertSelect(sql)
  const jar = context.asAbsolutePath(path.join('mcp', 'db', 'dbquery.jar'))
  const cp = `${conn.driverJar}${path.delimiter}${jar}`
  return new Promise((resolve, reject) => {
    const child = spawn('java', ['-cp', cp, 'DbQuery'], {
      env: { ...process.env, DB_URL: conn.jdbcUrl, DB_USER: conn.user || '', DB_PASSWORD: password || '', DB_MAXROWS: String(maxRows) },
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => reject(new Error('No se pudo ejecutar java (¿está instalado y en el PATH?): ' + e.message)))
    child.on('close', () => {
      let j: any
      try { j = JSON.parse(out || '{}') } catch { return reject(new Error(err.trim() || out.trim() || 'Sin salida del helper JDBC')) }
      if (j.error) { reject(new Error(j.error)) } else { resolve(j) }
    })
    child.stdin.write(sql); child.stdin.end()
  })
}

// ── Asistente de lenguaje natural (usa el modelo de GitHub Copilot) ──────────
export async function pickModel(): Promise<vscode.LanguageModelChat> {
  let models: vscode.LanguageModelChat[] = []
  try { models = await vscode.lm.selectChatModels({ vendor: 'copilot' }) } catch { /* ignore */ }
  if (!models.length) { try { models = await vscode.lm.selectChatModels() } catch { /* ignore */ } }
  if (!models.length) { throw new Error('No hay un modelo de IA disponible. Necesitas GitHub Copilot activo en VS Code.') }
  return models[0]
}

async function askModel(model: vscode.LanguageModelChat, prompt: string): Promise<string> {
  const messages = [vscode.LanguageModelChatMessage.User(prompt)]
  const resp = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token)
  let t = ''
  for await (const chunk of resp.text) { t += chunk }
  return t
}

function extractSql(text: string): string {
  const m = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  let sql = (m ? m[1] : text).trim()
  const semi = sql.indexOf(';')
  if (semi >= 0) { sql = sql.slice(0, semi) }
  return sql.trim()
}

export interface NlResult { sql: string; tablesUsed: string[]; result: QueryResult }

/** Explora el esquema con el agente y responde una pregunta en lenguaje natural (solo SELECT). */
export async function nlExplore(context: vscode.ExtensionContext, conn: DbConn, password: string, question: string): Promise<NlResult> {
  const model = await pickModel()
  const dialect = conn.type === 'sqlserver' ? 'SQL Server (T-SQL)' : 'Oracle SQL'

  // 1) listar tablas
  const tablesRes = await runQuery(context, conn, password, catalogSql(conn.type, 'tables'), 5000)
  const tableNames: string[] = tablesRes.rows.map(r => String(r[0]))
  if (!tableNames.length) { throw new Error('No se encontraron tablas en esta conexión.') }

  // 2) el agente elige tablas relevantes
  let chosen: string[]
  if (tableNames.length <= 12) {
    chosen = tableNames
  } else {
    const pick = await askModel(model, `Base ${dialect}. Tablas disponibles:\n${tableNames.join(', ')}\n\nPregunta: "${question}"\nDevuelve SOLO los nombres de hasta 5 tablas relevantes, separados por coma. Sin explicación.`)
    const upper = tableNames.map(t => t.toUpperCase())
    chosen = pick.split(/[,\n]/).map(s => s.trim().replace(/[^A-Za-z0-9_$#.]/g, '')).filter(Boolean)
      .filter(n => upper.includes(n.toUpperCase())).slice(0, 5)
    if (!chosen.length) { chosen = tableNames.slice(0, 5) }
  }

  // 3) describir columnas de esas tablas
  let schema = ''
  for (const t of chosen) {
    try {
      const d = await runQuery(context, conn, password, catalogSql(conn.type, 'columns', t), 500)
      schema += `\nTabla ${t}: ` + d.rows.map(r => `${r[0]} ${r[1]}`).join(', ')
    } catch { /* tabla sin permiso, ignorar */ }
  }

  // 4) el agente escribe el SELECT
  const sqlText = await askModel(model,
    `Eres experto en ${dialect}. Este es el esquema disponible:${schema}\n\n` +
    `Escribe UNA sola consulta ${dialect} de SOLO LECTURA (SELECT) que responda: "${question}". ` +
    `Usa únicamente tablas y columnas del esquema. No expliques, devuelve solo el SQL.`)
  const sql = extractSql(sqlText)
  if (!/^\s*(select|with)\b/i.test(sql)) { throw new Error('El agente no generó una consulta SELECT válida. Intenta reformular la pregunta.') }

  // 5) ejecutar (solo lectura)
  const result = await runQuery(context, conn, password, sql, 300)
  return { sql, tablesUsed: chosen, result }
}

const ident = (s: string) => String(s || '').replace(/[^A-Za-z0-9_$#.]/g, '')

export function catalogSql(type: string, what: string, table?: string): string {
  const t = ident(table || '')
  if (type === 'sqlserver') {
    if (what === 'test') { return 'SELECT 1 AS OK' }
    if (what === 'tables') { return "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS TABLA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY 1" }
    if (what === 'columns') { return `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS LEN, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${t}' ORDER BY ORDINAL_POSITION` }
    if (what === 'sample') { return `SELECT TOP {N} * FROM ${t}` }
  } else {
    if (what === 'test') { return 'SELECT 1 AS OK FROM DUAL' }
    if (what === 'tables') { return 'SELECT table_name AS TABLA FROM user_tables ORDER BY table_name' }
    if (what === 'columns') { return `SELECT column_name, data_type, data_length AS LEN, nullable FROM user_tab_columns WHERE table_name = UPPER('${t}') ORDER BY column_id` }
    if (what === 'sample') { return `SELECT * FROM ${t} WHERE ROWNUM <= {N}` }
  }
  return ''
}
