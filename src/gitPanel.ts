import * as vscode from 'vscode'
import * as path from 'path'
import * as git from './git'

export class GitPanel {
  private static current: GitPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []

  private session?: vscode.AuthenticationSession
  private repos: git.Repo[] = []
  private selected?: git.Repo
  private workingDir?: string
  private branches: string[] = []
  private current = ''

  static show(context: vscode.ExtensionContext) {
    if (GitPanel.current) { GitPanel.current.panel.reveal(); return }
    const panel = vscode.window.createWebviewPanel(
      'genrocketGit', 'GenRocket · Subir a GitHub', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    GitPanel.current = new GitPanel(panel)
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables)
  }

  private post(msg: any) { this.panel.webview.postMessage(msg) }
  private busy(on: boolean, text = '') { this.post({ type: 'busy', on, text }) }

  private async sendState(extra: any = {}) {
    let changes: string[] = []
    if (this.workingDir) { changes = await git.changedFiles(this.workingDir).catch(() => []) }
    this.post({
      type: 'state',
      account: this.session?.account.label ?? null,
      repos: this.repos.map(r => ({ fullName: r.fullName, isPrivate: r.isPrivate })),
      selected: this.selected?.fullName ?? null,
      workingDir: this.workingDir ?? null,
      needsClone: !!this.selected && !this.workingDir,
      cloneTarget: this.selected ? path.join(git.cloneBaseDir(), this.selected.name) : null,
      branches: this.branches,
      current: this.current,
      changes,
      ...extra,
    })
  }

  private async onMessage(m: any) {
    try {
      if (m.type === 'ready') {
        this.session = await git.getSession(false)
        if (this.session) { this.repos = await git.listRepos(this.session.accessToken).catch(() => []) }
        await this.sendState()
      } else if (m.type === 'connect') {
        this.busy(true, 'Conectando con GitHub…')
        this.session = await git.getSession(true)
        if (this.session) { this.repos = await git.listRepos(this.session.accessToken) }
        this.busy(false)
        await this.sendState()
      } else if (m.type === 'pickRepo') {
        this.selected = this.repos.find(r => r.fullName === m.fullName)
        this.workingDir = undefined; this.branches = []; this.current = ''
        if (this.selected && this.session) {
          // Todas las ramas del remoto (aunque no esté clonado)
          try { this.branches = await git.listApiBranches(this.session.accessToken, this.selected.owner, this.selected.name) } catch { this.branches = [] }
          if (this.selected.defaultBranch && !this.current) { this.current = this.selected.defaultBranch }
          const local = await git.findLocalRepo(this.selected.owner, this.selected.name)
          if (local) { await this.useDir(local) }
        }
        await this.sendState()
      } else if (m.type === 'clone') {
        if (!this.selected || !this.session) { return }
        this.busy(true, 'Clonando el repositorio…')
        const base = git.cloneBaseDir()
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(base))
        const dir = await git.cloneRepo(this.session.accessToken, this.selected.owner, this.selected.name, base)
        await this.useDir(dir)
        this.busy(false)
        await this.sendState({ toast: `Clonado en ${dir}` })
      } else if (m.type === 'commit') {
        if (!this.workingDir || !this.session) { return }
        const branch = (m.branch || '').trim()
        if (!branch) { this.post({ type: 'result', ok: false, message: 'Elige o escribe una rama.' }); return }
        if (!m.message || !m.message.trim()) { this.post({ type: 'result', ok: false, message: 'Escribe un mensaje para el commit.' }); return }
        this.busy(true, 'Guardando y subiendo…')
        if (m.createBranch) { await git.checkout(this.workingDir, branch, true) }
        else if (branch !== this.current) { await git.checkout(this.workingDir, branch, false) }
        const { name, email } = git.defaultAuthor(this.session)
        await git.commitAndPush(this.workingDir, m.message.trim(), branch, this.session.accessToken, name, email)
        this.current = await git.currentBranch(this.workingDir).catch(() => branch)
        this.branches = await git.listBranches(this.workingDir).catch(() => this.branches)
        this.busy(false)
        this.post({ type: 'result', ok: true, message: `Listo. Subido a la rama "${branch}".` })
        await this.sendState()
      }
    } catch (e: any) {
      this.busy(false)
      this.post({ type: 'result', ok: false, message: e?.message || String(e) })
    }
  }

  private async useDir(dir: string) {
    this.workingDir = dir
    this.current = await git.currentBranch(dir).catch(() => '')
    // Agrega ramas locales que no vinieron del API (sin sobreescribir la lista)
    const local = await git.listBranches(dir).catch(() => [])
    for (const b of local) { if (!this.branches.includes(b)) { this.branches.push(b) } }
  }

  private dispose() {
    GitPanel.current = undefined
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
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; max-width: 640px; }
  h1 { font-size: 1.3em; }
  .step { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px 16px; margin: 12px 0; opacity: .5; }
  .step.on { opacity: 1; }
  .step.done { border-color: var(--vscode-testing-iconPassed, #3fb950); }
  .num { display:inline-flex; width:22px; height:22px; border-radius:50%; background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground); align-items:center; justify-content:center; font-size:.8em; margin-right:8px; font-weight:700; }
  .title { font-weight: 700; }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  button { padding: 9px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 700; font-size: 1em;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-top: 10px; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.big { width: 100%; padding: 13px; font-size: 1.05em; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px; margin-top: 8px; border-radius: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  textarea { min-height: 60px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: 6px; }
  .radio { margin-top: 8px; font-size: .95em; }
  #busy { display:none; margin: 10px 0; font-weight:600; }
  #result { display:none; margin-top: 12px; padding: 10px; border-radius: 6px; white-space:pre-wrap; }
  #result.good { background: rgba(60,180,90,.15); } #result.bad { background: rgba(220,70,70,.15); }
</style></head>
<body>
  <h1>Subir mis cambios a GitHub</h1>
  <p class="muted">Sigue los pasos. Cada uno se activa cuando terminas el anterior.</p>
  <div id="busy">⏳ <span id="busyText"></span></div>

  <div class="step on" id="s1">
    <div><span class="num">1</span><span class="title">Conecta tu cuenta de GitHub</span> <span id="acct" class="ok"></span></div>
    <button id="connect">Conectar con GitHub</button>
    <div class="muted">Usa tu inicio de sesión de VS Code. Puedes cambiar de cuenta desde aquí.</div>
  </div>

  <div class="step" id="s2">
    <div><span class="num">2</span><span class="title">Elige tu repositorio</span></div>
    <input id="filter" placeholder="Buscar repositorio…" />
    <select id="repos" size="6"></select>
  </div>

  <div class="step" id="s3">
    <div><span class="num">3</span><span class="title">Carpeta del repositorio</span></div>
    <div id="dirInfo" class="muted"></div>
    <button id="clone">Clonar en mi computadora</button>
  </div>

  <div class="step" id="s4">
    <div><span class="num">4</span><span class="title">Elige o crea una rama</span></div>
    <div class="radio"><label><input type="radio" name="br" id="brExist" checked> Usar una rama que ya existe</label></div>
    <select id="branches"></select>
    <div class="radio"><label><input type="radio" name="br" id="brNew"> Crear una rama nueva</label></div>
    <input id="newBranch" placeholder="nombre-de-mi-rama" disabled />
  </div>

  <div class="step" id="s5">
    <div><span class="num">5</span><span class="title">Escribe qué hiciste y súbelo</span></div>
    <div id="changes" class="muted"></div>
    <textarea id="message" placeholder="Ej: Agregué los escenarios de pruebas"></textarea>
    <button id="commit" class="big">Guardar y subir a GitHub</button>
  </div>

  <div id="result"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let ST = {};

  function render() {
    $('acct').textContent = ST.account ? ('✓ ' + ST.account) : '';
    $('s1').classList.toggle('done', !!ST.account);
    // Paso 2
    const s2 = $('s2'); s2.classList.toggle('on', !!ST.account);
    const sel = $('repos'); const f = ($('filter').value || '').toLowerCase();
    sel.innerHTML = '';
    (ST.repos || []).filter(r => r.fullName.toLowerCase().includes(f)).forEach(r => {
      const o = document.createElement('option'); o.value = r.fullName;
      o.textContent = (r.isPrivate ? '🔒 ' : '') + r.fullName;
      if (r.fullName === ST.selected) o.selected = true;
      sel.appendChild(o);
    });
    s2.classList.toggle('done', !!ST.selected);
    // Paso 3
    const s3 = $('s3'); s3.classList.toggle('on', !!ST.selected);
    if (ST.workingDir) { $('dirInfo').textContent = '✓ Usando: ' + ST.workingDir; $('clone').style.display='none'; s3.classList.add('done'); }
    else if (ST.needsClone) { $('dirInfo').textContent = 'Se clonará en: ' + ST.cloneTarget; $('clone').style.display='inline-block'; s3.classList.remove('done'); }
    else { $('dirInfo').textContent = ''; $('clone').style.display='none'; }
    // Paso 4
    const s4 = $('s4'); s4.classList.toggle('on', !!ST.workingDir);
    const bsel = $('branches'); bsel.innerHTML='';
    (ST.branches||[]).forEach(b => { const o=document.createElement('option'); o.value=b; o.textContent=b + (b===ST.current?' (actual)':''); if(b===ST.current)o.selected=true; bsel.appendChild(o); });
    // Paso 5
    const s5 = $('s5'); s5.classList.toggle('on', !!ST.workingDir);
    const n = (ST.changes||[]).length;
    $('changes').textContent = ST.workingDir ? (n ? (n + ' archivo(s) con cambios por subir') : 'No hay cambios nuevos en esta carpeta.') : '';
    $('commit').disabled = !ST.workingDir;
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'state') { ST = m; render(); if (m.toast) toast(m.toast, true); }
    else if (m.type === 'busy') { $('busy').style.display = m.on?'block':'none'; $('busyText').textContent = m.text||''; }
    else if (m.type === 'result') { toast(m.message, m.ok); }
  });
  function toast(msg, ok){ const r=$('result'); r.style.display='block'; r.className = ok?'good':'bad'; r.textContent=msg; }

  $('connect').onclick = () => vscode.postMessage({ type:'connect' });
  $('filter').oninput = render;
  $('repos').onchange = () => vscode.postMessage({ type:'pickRepo', fullName: $('repos').value });
  $('clone').onclick = () => vscode.postMessage({ type:'clone' });
  $('brNew').onchange = $('brExist').onchange = () => { $('newBranch').disabled = !$('brNew').checked; $('branches').disabled = $('brNew').checked; };
  $('commit').onclick = () => vscode.postMessage({
    type:'commit',
    createBranch: $('brNew').checked,
    branch: $('brNew').checked ? $('newBranch').value : $('branches').value,
    message: $('message').value,
  });
  vscode.postMessage({ type:'ready' });
</script>
</body></html>`
  }
}
