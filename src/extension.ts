import * as vscode from 'vscode'
import * as path from 'path'
import * as crypto from 'crypto'
import * as gr from './client'
import { GenRocketTree, GRNode } from './tree'
import { ConfigPanel } from './configPanel'
import { GitPanel } from './gitPanel'
import { buildCaBundle, setLaunchEnv } from './ca'
import { DbPanel } from './dbPanel'
import { DashboardPanel } from './dashboard'

const SECRET_KEY = 'genrocket.password'
// Hash SHA-256 de la palabra clave por defecto del dashboard (la contraseña NUNCA
// va en texto plano en el repo). El usuario puede cambiarla con setDashboardPassword.
const DEFAULT_DASH_HASH = '57626bcd9a191c81bb9b9500002c79cec1de96ec63c29d539394dab0c7187ac2'
const DASH_HASH_KEY = 'genrocket.dashboard.pwhash'
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

async function getConfig(context: vscode.ExtensionContext): Promise<gr.GenRocketConfig> {
  const c = vscode.workspace.getConfiguration('genrocket')
  const password = (await context.secrets.get(SECRET_KEY)) || ''
  return {
    baseUrl: c.get<string>('baseUrl', ''),
    username: c.get<string>('username', ''),
    organizationId: c.get<string>('organizationId', ''),
    runtimeCommand: c.get<string>('runtimeCommand', ''),
    runtimeOutputDir: c.get<string>('runtimeOutputDir', ''),
    password,
  }
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('GenRocket')
  const tree = new GenRocketTree(() => getConfig(context))
  context.subscriptions.push(vscode.window.registerTreeDataProvider('genrocketExplorer', tree))

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  reg('genrocket.refresh', () => tree.refresh())

  reg('genrocket.openConfig', () => ConfigPanel.show(context, () => tree.refresh()))

  reg('genrocket.gitWizard', () => GitPanel.show(context))

  reg('genrocket.openDb', () => DbPanel.show(context))

  // ── Manager Dashboard (protegido por palabra clave — Directiva N.4 / OCP) ──
  reg('genrocket.openDashboard', async () => {
    const input = await vscode.window.showInputBox({
      password: true, ignoreFocusOut: true,
      title: 'Directiva N.4 — OCP',
      prompt: 'Ingresa la palabra clave para abrir el Manager Dashboard',
      placeHolder: 'palabra clave',
    })
    if (input === undefined) { return }
    const stored = (await context.secrets.get(DASH_HASH_KEY)) || DEFAULT_DASH_HASH
    if (sha256(input) !== stored) {
      vscode.window.showErrorMessage('OCP · Acceso denegado: palabra clave incorrecta.')
      return
    }
    await DashboardPanel.show(context)
  })

  reg('genrocket.setDashboardPassword', async () => {
    const p = await vscode.window.showInputBox({
      password: true, ignoreFocusOut: true,
      title: 'Directiva N.4 — OCP',
      prompt: 'Nueva palabra clave del Manager Dashboard (se guarda cifrada, nunca en el repo)',
    })
    if (!p) { return }
    await context.secrets.store(DASH_HASH_KEY, sha256(p))
    vscode.window.showInformationMessage('Palabra clave del dashboard actualizada.')
  })

  reg('genrocket.setupCorpCert', async () => {
    try {
      const file = await buildCaBundle(context)
      if (!file) { vscode.window.showWarningMessage('No se encontraron certificados de sistema (soportado en macOS y Windows).'); return }
      await setLaunchEnv(file)
      const restart = process.platform === 'darwin' ? 'ciérralo por completo (Cmd+Q) y ábrelo de nuevo'
        : process.platform === 'win32' ? 'ciérralo por completo (todas las ventanas) y ábrelo de nuevo'
        : 'reinícialo'
      const pick = await vscode.window.showInformationMessage(
        `Certificados corporativos preparados. Para que VS Code los use, ${restart}.\nArchivo: ${file}`,
        'Copiar ruta',
      )
      if (pick === 'Copiar ruta') { vscode.env.clipboard.writeText(file) }
    } catch (e: any) {
      vscode.window.showErrorMessage(`No se pudieron preparar los certificados: ${e.message}`)
    }
  })

  reg('genrocket.setPassword', async () => {
    const pass = await vscode.window.showInputBox({ prompt: 'Contraseña de GenRocket', password: true, ignoreFocusOut: true })
    if (pass === undefined) { return }
    await context.secrets.store(SECRET_KEY, pass)
    vscode.window.showInformationMessage('GenRocket: contraseña guardada de forma segura.')
    tree.refresh()
  })

  reg('genrocket.testConnection', async () => {
    try {
      const cfg = await getConfig(context)
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GenRocket: probando conexión…' },
        () => gr.testConnection(cfg),
      )
      vscode.window.showInformationMessage(`GenRocket OK — ${r.username} [${r.roles.join(', ') || 'sin roles'}]`)
    } catch (e: any) {
      vscode.window.showErrorMessage(`GenRocket: ${e.message}`)
    }
  })

  reg('genrocket.downloadScenario', async (node: GRNode) => {
    const s = node?.data as gr.Scenario
    if (!s?.externalId) { vscode.window.showErrorMessage('Escenario sin externalId'); return }
    try {
      const cfg = await getConfig(context)
      const { filename, bytes } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Descargando ${s.name}…` },
        () => gr.downloadScenario(cfg, s.externalId!),
      )
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(defaultDir(), filename)) })
      if (!uri) { return }
      await vscode.workspace.fs.writeFile(uri, bytes)
      vscode.window.showInformationMessage(`Escenario guardado: ${uri.fsPath}`)
    } catch (e: any) {
      vscode.window.showErrorMessage(`Descarga falló: ${e.message}`)
    }
  })

  reg('genrocket.runScenario', async (node: GRNode) => {
    const s = node?.data as gr.Scenario
    if (!s?.externalId) { vscode.window.showErrorMessage('Escenario sin externalId'); return }
    try {
      const cfg = await getConfig(context)
      if (!cfg.runtimeCommand) {
        const pick = await vscode.window.showWarningMessage(
          'El Runtime no está configurado (genrocket.runtimeCommand).', 'Abrir ajustes')
        if (pick) { vscode.commands.executeCommand('workbench.action.openSettings', 'genrocket.runtimeCommand') }
        return
      }
      output.show(true)
      output.appendLine(`\n▶ Generando datos con el Runtime para: ${s.name}`)
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Runtime: generando ${s.name}…` },
        () => gr.runScenario(cfg, s.externalId!, s.name),
      )
      output.appendLine(`Carpeta: ${r.dir}`)
      output.appendLine(`Exit code: ${r.exitCode}`)
      output.appendLine(`Archivos generados: ${r.outputs.length ? '' : '(ninguno; revisa los receivers del escenario)'}`)
      r.outputs.forEach(f => output.appendLine(`  - ${f.name} (${f.bytes} bytes)`))
      if (r.stdout) { output.appendLine(`--- stdout ---\n${r.stdout}`) }
      if (r.stderr) { output.appendLine(`--- stderr ---\n${r.stderr}`) }
      vscode.window.showInformationMessage(`Runtime terminó (exit ${r.exitCode}). ${r.outputs.length} archivo(s) en ${r.dir}`)
    } catch (e: any) {
      vscode.window.showErrorMessage(`Runtime: ${e.message}`)
    }
  })

  reg('genrocket.downloadDomainTemplate', async (node: GRNode) => {
    const d = node?.data as gr.Domain
    const cols = (d?.attributes ?? []).map(a => a.name)
    if (!cols.length) { vscode.window.showWarningMessage('El dominio no tiene atributos'); return }
    const csv = '﻿' + cols.map(csvEscape).join(',') + '\r\n'
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(defaultDir(), `${d.name.replace(/\s+/g, '_')}_template.csv`)),
    })
    if (!uri) { return }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'))
    vscode.window.showInformationMessage(`Plantilla CSV guardada: ${uri.fsPath}`)
  })

  reg('genrocket.registerMcpServer', async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent
    const c = vscode.workspace.getConfiguration('genrocket')
    const caFile = await buildCaBundle(context)  // CA corporativa para que el MCP confíe en el proxy TLS

    // Contraseñas desde SecretStorage (nunca en el repo)
    const grPassword = (await context.secrets.get(SECRET_KEY)) || ''
    const dbConns = (c.get<any[]>('dbConnections', []) || []).filter(d => d && d.name && d.jdbcUrl)
    const dbOut: any[] = []
    for (const d of dbConns) {
      const pw = (await context.secrets.get('db.password.' + d.name)) || ''
      dbOut.push({ name: d.name, type: d.type || 'oracle', jdbcUrl: d.jdbcUrl, user: d.user || '', driverJar: d.driverJar || '', password: pw })
    }

    // Token de GitHub del usuario (sesión existente, sin forzar login) para que el
    // MCP pueda hacer push de datos generados a los repos. Nunca se guarda en el repo.
    let githubToken = '', githubUser = '', githubEmail = ''
    try {
      const s = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false })
      if (s) {
        githubToken = s.accessToken
        githubUser = s.account.label
        githubEmail = `${s.account.label}@users.noreply.github.com`
      }
    } catch { /* sin sesión de GitHub; el push pedirá conectarla */ }

    // Ruta del registro de actividad (compartido entre extensión y MCP para el dashboard)
    await vscode.workspace.fs.createDirectory(context.globalStorageUri)
    const activityLog = vscode.Uri.joinPath(context.globalStorageUri, 'activity.jsonl').fsPath

    // Archivo de config local (fuera del repo, en el almacenamiento del usuario)
    const fullCfg = {
      baseUrl: c.get('baseUrl', ''),
      username: c.get('username', ''),
      password: grPassword,
      organizationId: c.get('organizationId', ''),
      runtimeCommand: c.get('runtimeCommand', ''),
      runtimeOutputDir: c.get('runtimeOutputDir', ''),
      dbConnections: dbOut,
      githubToken, githubUser, githubEmail,
      activityLog,
    }
    const cfgFile = vscode.Uri.joinPath(context.globalStorageUri, 'genrocket-config.json')
    await vscode.workspace.fs.writeFile(cfgFile, Buffer.from(JSON.stringify(fullCfg, null, 2), 'utf8'))

    // mcp.json solo apunta al archivo de config (sin variables vacías ni prompts)
    const ws = vscode.workspace.workspaceFolders?.[0]
    if (!ws) { if (!silent) { vscode.window.showWarningMessage('Configuración guardada. Abre una carpeta/workspace para registrar el MCP en Copilot Chat.') } return }
    const serverPath = context.asAbsolutePath(path.join('mcp', 'index.mjs'))
    const env: Record<string, string> = { GENROCKET_CONFIG_FILE: cfgFile.fsPath }
    if (caFile) { env.NODE_EXTRA_CA_CERTS = caFile }
    const content = { servers: { genrocket: { command: 'node', args: [serverPath], env } } }
    const dir = vscode.Uri.joinPath(ws.uri, '.vscode')
    const file = vscode.Uri.joinPath(dir, 'mcp.json')
    try {
      await vscode.workspace.fs.createDirectory(dir)
      await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(content, null, 2), 'utf8'))
      if (!silent) {
        vscode.window.showInformationMessage('MCP registrado en .vscode/mcp.json. Ábrelo y presiona "Start" (o "Restart" si ya estaba corriendo) para usarlo en Copilot Chat.')
        vscode.window.showTextDocument(file)
      }
    } catch (e: any) {
      if (!silent) { vscode.window.showErrorMessage(`No se pudo escribir mcp.json: ${e.message}`) }
    }
  })
}

function defaultDir(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir()
}

export function deactivate() {}
