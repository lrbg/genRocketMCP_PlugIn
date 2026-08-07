import * as vscode from 'vscode'
import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as gr from './client'
import { GenRocketTree, GRNode } from './tree'
import { ConfigPanel } from './configPanel'
import { GitPanel } from './gitPanel'
import { buildCaBundle, setLaunchEnv } from './ca'
import { DbPanel } from './dbPanel'
import { RagPanel } from './ragPanel'
import { DashboardPanel } from './dashboard'
import {
  McpServerEntry, McpFileCorruptError,
  userMcpPathFromGlobalStorage, mergeMcpServers, hasMcpServer, parseMcpJson,
} from './mcpConfig'
import {
  SECRET_KEY, GRAPH_SCOPES, GRAPH_CLIENT_ID, GRAPH_RT_KEY, GRAPH_AT_KEY,
  buildGenrocketRuntime, registerGenrocketMcpProvider,
} from './mcpProvider'
import { authCodeFlow } from './graphAuth'
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

  // Registro NATIVO del servidor MCP (VS Code 1.101+): Copilot lo descubre solo.
  // En editores viejos devuelve undefined y se usa el fallback por comando + mcp.json.
  const mcpProvider = registerGenrocketMcpProvider(context)

  // Auto-sanar mcp.json tras un auto-update de la extensión: la ruta del server en
  // mcp.json incluye la versión (…genrocket-mcp-plugin-<ver>/mcp/index.mjs) y queda
  // muerta al actualizar → "Process exited with code 1". Si detectamos esa ruta
  // stale, la reescribimos con la actual. Solo cuando la ruta guardada ya no existe,
  // para no pisar comentarios/otros servidores en configs sanas.
  void healStaleMcpPaths(context, output).catch(() => { /* best-effort */ })

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  reg('genrocket.refresh', () => tree.refresh())

  reg('genrocket.openConfig', () => ConfigPanel.show(context, () => { tree.refresh(); mcpProvider?.refresh() }))

  reg('genrocket.gitWizard', () => GitPanel.show(context))

  reg('genrocket.openDb', () => DbPanel.show(context))

  reg('genrocket.openRag', () => RagPanel.show(context))

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
    mcpProvider?.refresh()
  })

  // Conecta a Microsoft Graph con auth-code + el NAVEGADOR DEL SISTEMA. El navegador
  // (Edge en un equipo unido a Entra) presenta el claim de dispositivo administrado,
  // así que satisface las políticas de Conditional Access que el device code no cumple.
  reg('genrocket.connectSharePoint', async () => {
    try {
      const gc = vscode.workspace.getConfiguration('genrocket')
      const clientId = gc.get<string>('graph.clientId') || GRAPH_CLIENT_ID
      const tenant = gc.get<string>('graph.tenantId') || 'organizations'

      const tok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SharePoint: completa el inicio de sesión en el navegador…' },
        () => authCodeFlow(clientId, tenant, GRAPH_SCOPES, (url) => { vscode.env.openExternal(vscode.Uri.parse(url)) }),
      )
      await context.secrets.store(GRAPH_RT_KEY, tok.refresh_token || '')
      await context.secrets.store(GRAPH_AT_KEY, tok.access_token)
      await vscode.commands.executeCommand('genrocket.registerMcpServer', { silent: true })
      mcpProvider?.refresh()
      vscode.window.showInformationMessage(
        'SharePoint/Graph conectado. En Copilot Chat reinicia el MCP de GenRocket y usa la tool "sharepoint_test_connection".',
      )
    } catch (e: any) {
      vscode.window.showErrorMessage(`No se pudo conectar SharePoint: ${e.message}`)
    }
  })

  reg('genrocket.enableWebAutomation', async () => {
    try {
      const gc = vscode.workspace.getConfiguration('genrocket')
      const mode = gc.get<string>('web.mode') || 'extension'
      await gc.update('web.enabled', true, vscode.ConfigurationTarget.Global)
      await vscode.commands.executeCommand('genrocket.registerMcpServer', { silent: true })
      mcpProvider?.refresh()

      if (mode === 'cdp') {
        // Alternativa por puerto de depuración: se lanza Edge con el PERFIL POR DEFECTO
        // (el que ya está logueado y cumple la política de dispositivo). OJO: hay que
        // cerrar Edge antes; algunas versiones/policies bloquean depuración en el perfil
        // por defecto. Por eso el modo recomendado es 'extension'.
        const cdp = gc.get<string>('web.cdpEndpoint') || 'http://localhost:9222'
        const port = (cdp.match(/:(\d+)/) || [])[1] || '9222'
        const manual = process.platform === 'win32'
          ? `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=${port}`
          : `msedge --remote-debugging-port=${port}`
        const copiar = 'Copiar comando'
        const r = await vscode.window.showInformationMessage(
          `Modo CDP activado. CIERRA TODO Edge y ábrelo con tu perfil normal (ya logueado) + depuración remota. Copia y corre este comando; NO uses un perfil nuevo (si no, la política de tu organización lo bloquea por dispositivo). Luego reinicia el MCP en Copilot.\n\n${manual}`,
          copiar,
        )
        if (r === copiar) { await vscode.env.clipboard.writeText(manual) }
        return
      }

      // Modo recomendado: extensión puente → el agente se adjunta a TU Edge YA ABIERTO
      // y logueado (no abre ventana nueva, no re-loguea) → pasa el Conditional Access.
      const abrirDocs = 'Abrir instrucciones de la extensión'
      const r = await vscode.window.showInformationMessage(
        'Automatización web activada (modo extensión). El agente se conectará a tu Edge YA ABIERTO y logueado en el Designer — sin abrir ventana nueva ni volver a iniciar sesión. Solo necesitas instalar UNA vez la extensión puente de Playwright en ese Edge. Después reinicia el MCP en Copilot.',
        abrirDocs,
      )
      if (r === abrirDocs) {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/microsoft/playwright-mcp#connect-to-an-existing-browser-via-extension'))
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`No se pudo activar la automatización web: ${e.message}`)
    }
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

    // Escribe la config local (globalStorage/genrocket-config.json) y arma la entrada.
    // mcp.json solo apunta a ese archivo (sin variables vacías ni prompts). Reusa el
    // mismo helper que el provider nativo para no duplicar la lógica de credenciales.
    const rt = await buildGenrocketRuntime(context)
    const entry: McpServerEntry = { command: 'node', args: [rt.serverPath], env: rt.env }

    const ws = vscode.workspace.workspaceFolders?.[0]
    const wsFile = ws ? vscode.Uri.joinPath(ws.uri, '.vscode', 'mcp.json') : undefined
    const userFile = vscode.Uri.file(userMcpPathFromGlobalStorage(context.globalStorageUri.fsPath))

    if (silent) {
      // Viene de guardar la configuración: refresca donde ya esté registrado,
      // sin preguntar nada ni crear archivos nuevos.
      for (const f of [userFile, wsFile]) {
        if (f && await mcpFileHasGenrocket(f)) {
          try { await writeMcpEntry(f, entry) } catch { /* se avisará al registrar a mano */ }
        }
      }
      return
    }

    let scope = c.get<string>('mcpScope', 'ask')
    if (scope !== 'user' && scope !== 'workspace') {
      if (!wsFile) {
        scope = 'user'
      } else {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Todo VS Code', description: 'Disponible en cualquier ventana, aunque no haya carpeta abierta', scope: 'user' },
            { label: 'Solo este proyecto', description: 'Escribe .vscode/mcp.json en la carpeta abierta', scope: 'workspace' },
          ],
          { title: 'GenRocket: ¿dónde registro el servidor MCP?', ignoreFocusOut: true },
        )
        if (!pick) { return }
        scope = pick.scope
        await c.update('mcpScope', scope, vscode.ConfigurationTarget.Global)
      }
    }

    const target = (scope === 'workspace' && wsFile) ? wsFile : userFile
    try {
      await writeMcpEntry(target, entry)
      const donde = target === userFile
        ? 'MCP registrado para todo VS Code.'
        : 'MCP registrado en .vscode/mcp.json de este proyecto.'
      vscode.window.showInformationMessage(`${donde} Presiona "Start" (o "Restart" si ya estaba corriendo) para usarlo en Copilot Chat.`)
      vscode.window.showTextDocument(target)
    } catch (e: any) {
      if (e instanceof McpFileCorruptError) {
        const abrir = 'Abrir archivo'
        const r = await vscode.window.showErrorMessage(
          `No toqué ${target.fsPath} porque no se pudo leer su contenido (${e.message}). Corrígelo y vuelve a registrar.`,
          abrir,
        )
        if (r === abrir) { vscode.window.showTextDocument(target) }
      } else {
        vscode.window.showErrorMessage(`No se pudo escribir mcp.json: ${e.message}`)
      }
    }
  })
}

function defaultDir(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir()
}

/** Lee un mcp.json; devuelve cadena vacía si no existe. */
async function readTextIfExists(file: vscode.Uri): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8')
  } catch {
    return ''
  }
}

/** ¿Este mcp.json ya tiene registrado el servidor de GenRocket? */
async function mcpFileHasGenrocket(file: vscode.Uri): Promise<boolean> {
  return hasMcpServer(await readTextIfExists(file), 'genrocket')
}

/**
 * Reescribe la entrada `genrocket` de mcp.json cuando su ruta de server quedó
 * stale (la carpeta versionada de la extensión ya no existe tras un auto-update).
 * Solo actúa si la ruta guardada NO existe en disco: en configs sanas no toca nada
 * (así no borra comentarios ni reordena el archivo del usuario).
 */
async function healStaleMcpPaths(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const rt = await buildGenrocketRuntime(context)
  const entry: McpServerEntry = { command: 'node', args: [rt.serverPath], env: rt.env }
  const ws = vscode.workspace.workspaceFolders?.[0]
  const files = [
    vscode.Uri.file(userMcpPathFromGlobalStorage(context.globalStorageUri.fsPath)),
    ws ? vscode.Uri.joinPath(ws.uri, '.vscode', 'mcp.json') : undefined,
  ].filter((f): f is vscode.Uri => !!f)

  for (const f of files) {
    try {
      const text = await readTextIfExists(f)
      if (!hasMcpServer(text, 'genrocket')) { continue }
      const stored = parseMcpJson(text)?.servers?.genrocket
      const storedPath = Array.isArray(stored?.args) ? stored.args.find((a: string) => /index\.mjs$/i.test(a)) : undefined
      // Ruta sana (existe en disco) o ya es la actual → no tocar el archivo.
      if (!storedPath || storedPath === rt.serverPath || fs.existsSync(storedPath)) { continue }
      await writeMcpEntry(f, entry)
      output.appendLine(`[GenRocket] mcp.json tenía una ruta de servidor obsoleta; se actualizó a la versión instalada en ${f.fsPath}`)
    } catch { /* archivo corrupto o sin permiso: se resolverá al registrar a mano */ }
  }
}

/** Escribe la entrada conservando los demás servidores del archivo. */
async function writeMcpEntry(file: vscode.Uri, entry: McpServerEntry): Promise<void> {
  const merged = mergeMcpServers(await readTextIfExists(file), 'genrocket', entry)
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'))
  await vscode.workspace.fs.writeFile(file, Buffer.from(merged, 'utf8'))
}

export function deactivate() {}
