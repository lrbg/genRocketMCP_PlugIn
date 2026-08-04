import * as vscode from 'vscode'
import * as gr from './client'

const SECRET_KEY = 'genrocket.password'

export class ConfigPanel {
  private static current: ConfigPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []

  static show(context: vscode.ExtensionContext, onSaved: () => void) {
    if (ConfigPanel.current) { ConfigPanel.current.panel.reveal(); return }
    const panel = vscode.window.createWebviewPanel(
      'genrocketConfig', 'GenRocket · Configuración', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    ConfigPanel.current = new ConfigPanel(panel, context, onSaved)
  }

  private constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext, private onSaved: () => void) {
    this.panel = panel
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables)
  }

  private async onMessage(msg: any) {
    const cfgc = vscode.workspace.getConfiguration('genrocket')
    if (msg.type === 'ready') {
      const hasPassword = !!(await this.context.secrets.get(SECRET_KEY))
      this.panel.webview.postMessage({
        type: 'init',
        hasPassword,
        values: {
          baseUrl: cfgc.get('baseUrl', ''),
          username: cfgc.get('username', ''),
          organizationId: cfgc.get('organizationId', ''),
          runtimeCommand: cfgc.get('runtimeCommand', ''),
          runtimeOutputDir: cfgc.get('runtimeOutputDir', ''),
        },
      })
    } else if (msg.type === 'save') {
      const v = msg.values
      const T = vscode.ConfigurationTarget.Global
      await cfgc.update('baseUrl', v.baseUrl ?? '', T)
      await cfgc.update('username', v.username ?? '', T)
      await cfgc.update('organizationId', v.organizationId ?? '', T)
      await cfgc.update('runtimeCommand', v.runtimeCommand ?? '', T)
      await cfgc.update('runtimeOutputDir', v.runtimeOutputDir ?? '', T)
      if (typeof v.password === 'string' && v.password.length > 0) {
        await this.context.secrets.store(SECRET_KEY, v.password)
      }
      this.onSaved()
      // Re-genera .vscode/mcp.json con la config nueva (si hay carpeta abierta)
      await vscode.commands.executeCommand('genrocket.registerMcpServer', { silent: true })
      this.panel.webview.postMessage({ type: 'saved' })
      vscode.window.showInformationMessage('GenRocket: configuración guardada. Si usas el MCP en Copilot, reinícialo en .vscode/mcp.json (Restart) para aplicar los cambios.')
    } else if (msg.type === 'test') {
      try {
        const password = (await this.context.secrets.get(SECRET_KEY)) || msg.values?.password || ''
        const cfg: gr.GenRocketConfig = {
          baseUrl: msg.values.baseUrl, username: msg.values.username, organizationId: msg.values.organizationId,
          password,
        }
        const r = await gr.testConnection(cfg)
        this.panel.webview.postMessage({ type: 'testResult', ok: true, message: `Conexión OK — ${r.username} [${r.roles.join(', ') || 'sin roles'}]` })
      } catch (e: any) {
        this.panel.webview.postMessage({ type: 'testResult', ok: false, message: e.message })
      }
    } else if (msg.type === 'registerMcp') {
      vscode.commands.executeCommand('genrocket.registerMcpServer')
    }
  }

  private dispose() {
    ConfigPanel.current = undefined
    this.panel.dispose()
    while (this.disposables.length) { this.disposables.pop()?.dispose() }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6)
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`
    return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; max-width: 680px; }
  h1 { font-size: 1.3em; margin-bottom: 2px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 20px; font-size: .9em; }
  label { display:block; font-weight:600; margin: 14px 0 4px; font-size: .9em; }
  .hint { color: var(--vscode-descriptionForeground); font-size: .8em; margin-top: 3px; }
  input { width: 100%; box-sizing: border-box; padding: 7px 9px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  .row { display:flex; gap:10px; margin-top: 22px; flex-wrap: wrap; }
  button { padding: 8px 14px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { opacity: .9; }
  .note { margin-top: 22px; padding: 12px; border-radius: 6px; background: var(--vscode-textBlockQuote-background);
    border-left: 3px solid var(--vscode-textLink-foreground); font-size: .85em; }
  #result { margin-top: 14px; padding: 10px; border-radius: 6px; display:none; font-size:.85em; white-space:pre-wrap; }
  #result.ok { background: rgba(60,180,90,.15); }
  #result.err { background: rgba(220,70,70,.15); }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
</style></head>
<body>
  <h1>GenRocket · Configuración</h1>
  <div class="sub">Cada usuario configura aquí su propio tenant y credenciales. La contraseña se guarda cifrada (SecretStorage), nunca en el repositorio ni en texto plano.</div>

  <label>Host / Tenant</label>
  <input id="baseUrl" placeholder="https://TU-ORG.genrocket.com" />
  <div class="hint">El tenant de tu organización, sin <code>/rest</code>.</div>

  <label>Usuario (email)</label>
  <input id="username" placeholder="usuario@tuempresa.com" />

  <label>Contraseña</label>
  <input id="password" type="password" placeholder="(escribe para cambiarla)" />
  <div class="hint" id="pwHint"></div>

  <label>Organization ID</label>
  <input id="organizationId" placeholder="external id de tu organización" />

  <label>Comando del Runtime (opcional)</label>
  <input id="runtimeCommand" placeholder="java -jar /ruta/GenRocketRuntime.jar {grs}" />
  <div class="hint">Placeholders <code>{grs}</code> y <code>{dir}</code>. El Runtime es software de GenRocket que instalas por tu cuenta.</div>

  <label>Carpeta de salida del Runtime (opcional)</label>
  <input id="runtimeOutputDir" placeholder="(vacío = carpeta temporal)" />

  <div class="row">
    <button id="save">Guardar</button>
    <button id="test" class="sec">Probar conexión</button>
    <button id="mcp" class="sec">Registrar MCP para Copilot Chat</button>
  </div>
  <div id="result"></div>

  <div class="note">
    <b>Chat de IA:</b> el chat usa <b>tu propia suscripción de GitHub Copilot</b> en VS Code. La extensión no guarda tokens de Copilot ni de OpenAI. Al registrar el MCP, tus tools de GenRocket quedan disponibles en Copilot Chat; la contraseña se pide con un input seguro de VS Code.
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const fields = ['baseUrl','username','organizationId','runtimeCommand','runtimeOutputDir'];
  function values(){ const o={}; fields.forEach(f=>o[f]=$(f).value); o.password=$('password').value; return o; }
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'init') {
      fields.forEach(f => $(f).value = m.values[f] || '');
      $('pwHint').textContent = m.hasPassword ? 'Ya hay una contraseña guardada. Deja vacío para conservarla.' : 'Aún no hay contraseña guardada.';
    } else if (m.type === 'testResult') {
      const r = $('result'); r.style.display='block'; r.className = m.ok?'ok':'err'; r.textContent = m.message;
    } else if (m.type === 'saved') {
      const r = $('result'); r.style.display='block'; r.className='ok'; r.textContent='Guardado.';
      $('password').value='';
    }
  });
  $('save').onclick = () => vscode.postMessage({ type:'save', values: values() });
  $('test').onclick = () => { const r=$('result'); r.style.display='block'; r.className=''; r.textContent='Probando…'; vscode.postMessage({ type:'test', values: values() }); };
  $('mcp').onclick = () => vscode.postMessage({ type:'registerMcp' });
  vscode.postMessage({ type:'ready' });
</script>
</body></html>`
  }
}
