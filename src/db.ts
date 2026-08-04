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
