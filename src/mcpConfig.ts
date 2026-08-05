/**
 * Lógica del registro del servidor MCP, sin dependencias de vscode
 * para poder probarla con `node --test` (mismo patrón que dashboardCore.ts).
 */
import * as path from 'path'

export type McpServerEntry = {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** El archivo mcp.json existía pero no se pudo leer como JSON: nunca lo pisamos. */
export class McpFileCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpFileCorruptError'
  }
}

/**
 * Ruta del mcp.json de usuario a partir del globalStorage de la extensión.
 *
 * globalStorage vive en `<datos de usuario>/User/globalStorage/<publisher.extension>`,
 * así que el mcp.json de usuario queda dos niveles arriba. Derivarlo así evita rutas
 * fijas y funciona igual en macOS, Windows y Linux, y en Insiders o Cursor.
 */
export function userMcpPathFromGlobalStorage(globalStoragePath: string): string {
  const clean = globalStoragePath.replace(/[\\/]+$/, '')
  const userDir = path.dirname(path.dirname(clean))
  return path.join(userDir, 'mcp.json')
}

/**
 * Quita comentarios y comas colgantes: VS Code acepta ambos en mcp.json y
 * JSON.parse no. Respeta lo que va dentro de cadenas.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i++ }
      else if (ch === '"') { inString = false }
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') { inLine = true; i++; continue }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue }
    out += ch
  }

  // Comas colgantes antes de } o ]
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** Parsea un mcp.json. Texto vacío = objeto vacío. Texto inválido = error. */
export function parseMcpJson(text: string): Record<string, any> {
  if (!text || !text.trim()) { return {} }
  let doc: any
  try {
    doc = JSON.parse(stripJsonComments(text))
  } catch (e: any) {
    throw new McpFileCorruptError(e?.message || 'JSON inválido')
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new McpFileCorruptError('El contenido no es un objeto JSON')
  }
  return doc
}

/** ¿Ya está registrado este servidor en el archivo? */
export function hasMcpServer(text: string, name: string): boolean {
  let doc: Record<string, any>
  try { doc = parseMcpJson(text) } catch { return false }
  const servers = doc.servers
  return !!servers && typeof servers === 'object' && !Array.isArray(servers) && name in servers
}

/**
 * Agrega o actualiza un servidor conservando los demás y el resto del archivo.
 * Lanza McpFileCorruptError si el archivo existente no se puede interpretar,
 * para no borrarle la configuración a nadie.
 */
export function mergeMcpServers(existingText: string, name: string, entry: McpServerEntry): string {
  const doc = parseMcpJson(existingText)
  const servers = (doc.servers && typeof doc.servers === 'object' && !Array.isArray(doc.servers))
    ? doc.servers
    : {}
  doc.servers = { ...servers, [name]: entry }
  return JSON.stringify(doc, null, 2) + '\n'
}
