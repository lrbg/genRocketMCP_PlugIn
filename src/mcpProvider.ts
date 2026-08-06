import * as vscode from 'vscode'
import * as path from 'path'
import { buildCaBundle } from './ca'

// Clave de SecretStorage para la contraseña de GenRocket (compartida con extension.ts).
export const SECRET_KEY = 'genrocket.password'

// Scopes de Microsoft Graph para leer SharePoint (sitios/archivos). Se piden con el
// proveedor de autenticación nativo de VS Code (cuenta Microsoft del usuario).
export const GRAPH_SCOPES = ['https://graph.microsoft.com/Sites.Read.All', 'https://graph.microsoft.com/Files.Read.All']

export interface GenrocketRuntime {
  /** Ruta absoluta al entrypoint del servidor MCP (mcp/index.mjs). */
  serverPath: string
  /** Variables de entorno para lanzar el server (solo apunta al config, sin secretos sueltos). */
  env: Record<string, string>
  /** Ruta del archivo de config local escrito en globalStorage. */
  cfgFile: string
  /** true si hay baseUrl + usuario + contraseña (suficiente para intentar login). */
  hasCreds: boolean
  /** Versión de la extensión (para McpStdioServerDefinition.version). */
  version: string
}

/**
 * Escribe `globalStorage/genrocket-config.json` con la config del usuario
 * (baseUrl, usuario, contraseña de SecretStorage, org, runtime, conexiones de BD
 * con sus contraseñas, token de GitHub de la sesión y ruta del activity log) y
 * devuelve lo necesario para lanzar el servidor MCP por stdio. Nada de esto vive
 * en el repo: todo sale de settings/SecretStorage/globalStorage del usuario.
 *
 * Reutilizado por el comando `genrocket.registerMcpServer` (fallback vía mcp.json)
 * y por el provider nativo `GenrocketMcpProvider`.
 */
export async function buildGenrocketRuntime(context: vscode.ExtensionContext): Promise<GenrocketRuntime> {
  const c = vscode.workspace.getConfiguration('genrocket')
  const caFile = await buildCaBundle(context)  // CA corporativa para que el MCP confíe en el proxy TLS

  const grPassword = (await context.secrets.get(SECRET_KEY)) || ''

  const dbConns = (c.get<any[]>('dbConnections', []) || []).filter(d => d && d.name && d.jdbcUrl)
  const dbOut: any[] = []
  for (const d of dbConns) {
    const pw = (await context.secrets.get('db.password.' + d.name)) || ''
    dbOut.push({ name: d.name, type: d.type || 'oracle', jdbcUrl: d.jdbcUrl, user: d.user || '', driverJar: d.driverJar || '', password: pw })
  }

  // Token de GitHub de la sesión existente (sin forzar login) para el push de datos.
  let githubToken = '', githubUser = '', githubEmail = ''
  try {
    const s = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false })
    if (s) {
      githubToken = s.accessToken
      githubUser = s.account.label
      githubEmail = `${s.account.label}@users.noreply.github.com`
    }
  } catch { /* sin sesión de GitHub; el push pedirá conectarla */ }

  // Token de Microsoft Graph (sesión existente, sin forzar login) para leer SharePoint.
  // El comando "Conectar SharePoint" fuerza el login/consent la primera vez.
  let graphToken = ''
  try {
    const s = await vscode.authentication.getSession('microsoft', GRAPH_SCOPES, { createIfNone: false })
    if (s) { graphToken = s.accessToken }
  } catch { /* sin sesión de Microsoft; usar el comando Conectar SharePoint */ }

  await vscode.workspace.fs.createDirectory(context.globalStorageUri)
  const activityLog = vscode.Uri.joinPath(context.globalStorageUri, 'activity.jsonl').fsPath

  const baseUrl = c.get<string>('baseUrl', '')
  const username = c.get<string>('username', '')
  const fullCfg = {
    baseUrl,
    username,
    password: grPassword,
    organizationId: c.get('organizationId', ''),
    runtimeCommand: c.get('runtimeCommand', ''),
    runtimeOutputDir: c.get('runtimeOutputDir', ''),
    dbConnections: dbOut,
    githubToken, githubUser, githubEmail,
    graphToken,
    activityLog,
  }
  const cfgFileUri = vscode.Uri.joinPath(context.globalStorageUri, 'genrocket-config.json')
  await vscode.workspace.fs.writeFile(cfgFileUri, Buffer.from(JSON.stringify(fullCfg, null, 2), 'utf8'))

  const serverPath = context.asAbsolutePath(path.join('mcp', 'index.mjs'))
  const env: Record<string, string> = { GENROCKET_CONFIG_FILE: cfgFileUri.fsPath }
  if (caFile) { env.NODE_EXTRA_CA_CERTS = caFile }

  const version = (context.extension?.packageJSON?.version as string) || '0.0.0'
  return { serverPath, env, cfgFile: cfgFileUri.fsPath, hasCreds: !!(baseUrl && username && grPassword), version }
}

/**
 * Provider nativo de MCP para VS Code (API `vscode.lm.registerMcpServerDefinitionProvider`,
 * estable desde VS Code 1.101). Publica el servidor GenRocket para que Copilot Chat lo
 * descubra solo, sin que el usuario edite `mcp.json`. En cada descubrimiento reescribe el
 * archivo de config, así el server siempre arranca con las credenciales frescas.
 */
// Nota: los tipos McpStdioServerDefinition/McpServerDefinitionProvider existen en
// @types/vscode >= 1.101, pero mantenemos engines.vscode en ^1.96 para no romper la
// instalación en editores viejos (donde se usa el fallback por comando). Por eso se
// accede a la API vía `any` + feature-detect, en vez de tipar contra 1.101.
export class GenrocketMcpProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Dispara un re-descubrimiento (llamar tras guardar credenciales/config). */
  refresh(): void { this._onDidChange.fire() }

  async provideMcpServerDefinitions(): Promise<any[]> {
    const rt = await buildGenrocketRuntime(this.context)
    const Stdio: any = (vscode as any).McpStdioServerDefinition
    const def = new Stdio('GenRocket', 'node', [rt.serverPath], rt.env, rt.version)
    def.cwd = vscode.Uri.file(path.dirname(rt.serverPath))
    return [def]
  }

  async resolveMcpServerDefinition(server: any): Promise<any> {
    // La config ya se escribió en provideMcpServerDefinitions(). Si faltan credenciales,
    // el server responderá con un error claro; avisamos una sola vez para guiar al usuario.
    const rt = await buildGenrocketRuntime(this.context)
    if (!rt.hasCreds) {
      vscode.window.showWarningMessage(
        'GenRocket MCP: faltan credenciales. Configura baseUrl/usuario y la contraseña (GenRocket: Configuración).',
      )
    }
    return server
  }
}

/**
 * Registra el provider nativo si el editor soporta la API (VS Code 1.101+).
 * Devuelve el provider (para poder refrescarlo al guardar config) o undefined si
 * el editor es viejo — en ese caso se usa el fallback por comando + mcp.json.
 */
export function registerGenrocketMcpProvider(context: vscode.ExtensionContext): GenrocketMcpProvider | undefined {
  const lm: any = (vscode as any).lm
  if (!lm || typeof lm.registerMcpServerDefinitionProvider !== 'function') { return undefined }
  const provider = new GenrocketMcpProvider(context)
  context.subscriptions.push(lm.registerMcpServerDefinitionProvider('genrocket.mcpServers', provider))
  return provider
}
