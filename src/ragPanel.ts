import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { graphragDir } from './mcpProvider'

/**
 * Panel de configuración del RAG local: elegir carpeta, indexarla (extrae texto
 * de PDF/Word/Excel/HTML/texto) y ver el estado del índice. El índice se guarda
 * en el mismo lugar que lee el MCP (query_docs), así lo indexado aquí queda
 * disponible para Copilot. Todo local y determinista (sin API keys).
 */
export class RagPanel {
  private static current: RagPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []

  static show(context: vscode.ExtensionContext) {
    if (RagPanel.current) { RagPanel.current.panel.reveal(); return }
    const panel = vscode.window.createWebviewPanel('genrocketRag', 'RAG de documentos', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true })
    RagPanel.current = new RagPanel(panel, context)
  }

  private constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext) {
    this.panel = panel
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables)
  }

  private post(m: any) { this.panel.webview.postMessage(m) }

  private readMeta(): any {
    try { return JSON.parse(fs.readFileSync(path.join(graphragDir(this.context), 'active-meta.json'), 'utf8')) } catch { return null }
  }

  private sendState() {
    const folder = vscode.workspace.getConfiguration('genrocket').get<string>('rag.folder', '')
    this.post({ type: 'state', folder, meta: this.readMeta(), indexDir: graphragDir(this.context) })
  }

  private runIndex(folder: string): Promise<any> {
    const cli = this.context.asAbsolutePath(path.join('mcp', 'graphrag-cli.mjs'))
    const cwd = this.context.asAbsolutePath('mcp')
    const env = { ...process.env, GENROCKET_GRAPHRAG_DIR: graphragDir(this.context) }
    return new Promise((resolve) => {
      execFile('node', [cli, folder], { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        const line = (stdout || '').trim().split('\n').filter(Boolean).pop() || ''
        let res: any = null
        try { res = JSON.parse(line) } catch { /* salida no-JSON */ }
        if (res) { resolve(res) }
        else { resolve({ ok: false, error: (stderr || err?.message || 'No se pudo indexar (¿node en el PATH?)').slice(0, 300) }) }
      })
    })
  }

  private async onMessage(m: any) {
    try {
      if (m.type === 'ready') { this.sendState(); return }

      if (m.type === 'browse') {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Usar esta carpeta' })
        if (picked && picked[0]) {
          const folder = picked[0].fsPath
          await vscode.workspace.getConfiguration('genrocket').update('rag.folder', folder, vscode.ConfigurationTarget.Global)
          this.sendState()
        }
        return
      }

      if (m.type === 'saveFolder') {
        await vscode.workspace.getConfiguration('genrocket').update('rag.folder', m.folder || '', vscode.ConfigurationTarget.Global)
        this.post({ type: 'toast', ok: true, text: 'Carpeta guardada.' })
        return
      }

      if (m.type === 'index') {
        const folder = (m.folder || '').trim()
        if (!folder) { this.post({ type: 'toast', ok: false, text: 'Elige una carpeta primero.' }); return }
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) { this.post({ type: 'toast', ok: false, text: 'La carpeta no existe o no es un directorio.' }); return }
        await vscode.workspace.getConfiguration('genrocket').update('rag.folder', folder, vscode.ConfigurationTarget.Global)
        this.post({ type: 'indexing', on: true })
        const res = await this.runIndex(folder)
        this.post({ type: 'indexing', on: false })
        this.post({ type: 'indexResult', res })
        this.sendState()
        return
      }
    } catch (e: any) {
      this.post({ type: 'indexing', on: false })
      this.post({ type: 'toast', ok: false, text: e.message })
    }
  }

  private dispose() {
    RagPanel.current = undefined
    this.panel.dispose()
    while (this.disposables.length) { this.disposables.pop()?.dispose() }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6)
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`
    return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;max-width:820px;}
  h1{font-size:1.25em;} h2{font-size:1em;margin:18px 0 6px;}
  label{display:block;font-size:.85em;font-weight:600;margin:8px 0 3px;}
  input{width:100%;box-sizing:border-box;padding:8px;border-radius:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font-family:var(--vscode-editor-font-family),monospace;}
  button{padding:8px 14px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin:8px 6px 0 0;}
  button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
  button:disabled{opacity:.5;cursor:default;}
  .card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px;margin:12px 0;}
  .muted{color:var(--vscode-descriptionForeground);font-size:.85em;}
  .row{display:flex;gap:8px;align-items:end;} .row>.grow{flex:1;}
  .kpi{display:flex;gap:18px;flex-wrap:wrap;margin-top:6px;} .kpi div{font-size:.9em;} .kpi b{font-size:1.3em;display:block;}
  .pill{display:inline-block;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:12px;padding:2px 9px;font-size:.78em;margin:2px 3px 0 0;}
  #toast{display:none;margin-top:10px;padding:9px;border-radius:6px;} #toast.good{background:rgba(60,180,90,.15);} #toast.bad{background:rgba(220,70,70,.18);}
  code{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px;}
  ol{padding-left:18px;} ol li{margin:4px 0;font-size:.9em;}
</style></head><body>
  <h1>📚 RAG de documentos (local, sin API)</h1>
  <p class="muted">Indexa una carpeta de documentos (Word, PDF, Excel, HTML, texto) y pregúntale a Copilot sobre ellos. Todo se procesa <b>local</b>: sin API keys, sin Python, sin la nube. Ideal para una carpeta de SharePoint descargada a tu equipo.</p>

  <div class="card">
    <h2 style="margin-top:0">Estado del índice</h2>
    <div id="status" class="muted">Sin índice todavía.</div>
    <div id="kpi" class="kpi" style="display:none">
      <div><b id="k_files">0</b>archivos</div>
      <div><b id="k_chunks">0</b>pasajes</div>
      <div><b id="k_concepts">0</b>conceptos</div>
      <div><b id="k_skipped">0</b>saltados</div>
    </div>
    <div id="skipwrap" class="muted" style="margin-top:8px;display:none"></div>
  </div>

  <h2>Carpeta a indexar</h2>
  <div class="row">
    <div class="grow"><input id="folder" placeholder="C:\\Users\\tu-usuario\\OneDrive - ...\\carpeta   (o cualquier ruta local)"></div>
    <button id="browse" class="sec">Examinar…</button>
  </div>
  <button id="index">Indexar ahora</button>
  <button id="save" class="sec">Solo guardar carpeta</button>
  <span id="working" class="muted" style="display:none">⏳ indexando (extrayendo texto de los documentos)…</span>
  <div id="toast"></div>

  <div class="card">
    <h2 style="margin-top:0">Cómo se usa</h2>
    <ol>
      <li>Descarga a tu equipo la carpeta (con sus PDF/Word/Excel).</li>
      <li>Elígela aquí y dale <b>Indexar ahora</b>.</li>
      <li>En <b>Copilot Chat</b> pregunta normal; el agente usa <code>query_docs</code> por el MCP y responde citando cada archivo.</li>
    </ol>
    <div>Tipos soportados:
      <span class="pill">Word .docx</span><span class="pill">PDF</span><span class="pill">Excel .xlsx</span>
      <span class="pill">HTML</span><span class="pill">txt / md / csv / json</span><span class="pill">código</span>
    </div>
    <p class="muted" style="margin-bottom:0">Nota: un PDF que sea solo imagen (escaneado) no tiene texto extraíble; ahí se necesitaría OCR.</p>
  </div>
  <p class="muted">Índice guardado en: <code id="indexDir"></code></p>

<script nonce="${nonce}">
  const vscode=acquireVsCodeApi(); const $=id=>document.getElementById(id);
  function toast(t,ok){const e=$('toast');e.style.display='block';e.className=ok?'good':'bad';e.textContent=t;}
  function render(m){
    if(m.folder!==undefined && !$('folder').value) $('folder').value=m.folder||'';
    $('indexDir').textContent=m.indexDir||'';
    const meta=m.meta;
    if(meta){
      $('status').textContent='Índice activo sobre: '+meta.folder;
      $('kpi').style.display='flex';
      $('k_files').textContent=(meta.indexedFiles||0)+'/'+(meta.createdFiles||0);
      $('k_chunks').textContent=meta.chunks||0;
      $('k_concepts').textContent=meta.concepts||0;
      const sk=(meta.skipped||[]);
      $('k_skipped').textContent=sk.length;
      if(sk.length){$('skipwrap').style.display='block';$('skipwrap').textContent='Saltados: '+sk.slice(0,6).join('; ')+(sk.length>6?'…':'');}
      else{$('skipwrap').style.display='none';}
    } else {
      $('status').textContent='Sin índice todavía. Elige una carpeta y dale “Indexar ahora”.';
      $('kpi').style.display='none';
    }
  }
  window.addEventListener('message',e=>{const m=e.data;
    if(m.type==='state'){render(m);}
    else if(m.type==='toast'){toast(m.text,m.ok);}
    else if(m.type==='indexing'){$('working').style.display=m.on?'inline':'none';$('index').disabled=m.on;$('browse').disabled=m.on;}
    else if(m.type==='indexResult'){
      if(m.res&&m.res.ok){toast('Indexado: '+m.res.indexedFiles+'/'+m.res.createdFiles+' archivos, '+m.res.chunks+' pasajes, '+m.res.concepts+' conceptos.',true);}
      else{toast('No se pudo indexar: '+((m.res&&m.res.error)||'error')+((m.res&&m.res.skipped&&m.res.skipped.length)?(' — '+m.res.skipped.slice(0,3).join('; ')):''),false);}
    }
  });
  $('browse').onclick=()=>vscode.postMessage({type:'browse'});
  $('index').onclick=()=>vscode.postMessage({type:'index',folder:$('folder').value});
  $('save').onclick=()=>vscode.postMessage({type:'saveFolder',folder:$('folder').value});
  vscode.postMessage({type:'ready'});
</script></body></html>`
  }
}
