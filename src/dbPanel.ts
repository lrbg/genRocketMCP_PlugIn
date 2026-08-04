import * as vscode from 'vscode'
import * as db from './db'

export class DbPanel {
  private static current: DbPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []

  static show(context: vscode.ExtensionContext) {
    if (DbPanel.current) { DbPanel.current.panel.reveal(); return }
    const panel = vscode.window.createWebviewPanel('genrocketDb', 'Bases de datos', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true })
    DbPanel.current = new DbPanel(panel, context)
  }

  private constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext) {
    this.panel = panel
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables)
  }

  private post(m: any) { this.panel.webview.postMessage(m) }

  private async pwFor(name: string): Promise<string> {
    let pw = await this.context.secrets.get(db.pwKey(name))
    if (!pw) {
      pw = await vscode.window.showInputBox({ prompt: `Contraseña de la BD "${name}"`, password: true, ignoreFocusOut: true })
      if (pw) { await this.context.secrets.store(db.pwKey(name), pw) }
    }
    return pw || ''
  }

  private async sendState() {
    const conns = db.getConnections()
    const withPw: any[] = []
    for (const c of conns) { withPw.push({ ...c, hasPw: !!(await this.context.secrets.get(db.pwKey(c.name))) }) }
    this.post({ type: 'state', connections: withPw })
  }

  private async onMessage(m: any) {
    try {
      if (m.type === 'ready') { await this.sendState(); return }

      if (m.type === 'addConn') {
        const v = m.conn
        if (!v.name || !v.jdbcUrl || !v.driverJar) { this.post({ type: 'toast', ok: false, text: 'Faltan campos: nombre, jdbcUrl y driverJar son obligatorios.' }); return }
        await db.addConnection({ name: v.name, type: v.type || 'oracle', jdbcUrl: v.jdbcUrl, user: v.user || '', driverJar: v.driverJar })
        if (v.password) { await this.context.secrets.store(db.pwKey(v.name), v.password) }
        await vscode.commands.executeCommand('genrocket.registerMcpServer', { silent: true })
        await this.sendState()
        this.post({ type: 'toast', ok: true, text: `Conexión "${v.name}" guardada.` })
        return
      }

      if (m.type === 'setPw') {
        const pw = await vscode.window.showInputBox({ prompt: `Contraseña de la BD "${m.name}"`, password: true, ignoreFocusOut: true })
        if (pw !== undefined) { await this.context.secrets.store(db.pwKey(m.name), pw); await this.sendState(); this.post({ type: 'toast', ok: true, text: 'Contraseña guardada.' }) }
        return
      }

      // Operaciones que corren consulta
      const conn = db.getConnections().find(c => c.name === m.name)
      if (!conn) { this.post({ type: 'toast', ok: false, text: 'Conexión no encontrada.' }); return }
      const pw = await this.pwFor(conn.name)

      if (m.type === 'test') {
        await db.runQuery(this.context, conn, pw, db.catalogSql(conn.type, 'test'))
        this.post({ type: 'toast', ok: true, text: `Conexión "${conn.name}" OK.` })
      } else if (m.type === 'tables') {
        const r = await db.runQuery(this.context, conn, pw, db.catalogSql(conn.type, 'tables'), 3000)
        this.post({ type: 'result', title: `Tablas de ${conn.name}`, result: r })
      } else if (m.type === 'query') {
        const r = await db.runQuery(this.context, conn, pw, m.sql, 300)
        this.post({ type: 'result', title: 'Resultado', result: r })
      } else if (m.type === 'ask') {
        if (!m.question || !m.question.trim()) { this.post({ type: 'toast', ok: false, text: 'Escribe una pregunta.' }); return }
        this.post({ type: 'thinking', on: true })
        try {
          const r = await db.nlExplore(this.context, conn, pw, m.question.trim())
          this.post({ type: 'nlResult', sql: r.sql, tablesUsed: r.tablesUsed, result: r.result })
        } finally {
          this.post({ type: 'thinking', on: false })
        }
      }
    } catch (e: any) {
      this.post({ type: 'toast', ok: false, text: e.message })
    }
  }

  private dispose() {
    DbPanel.current = undefined
    this.panel.dispose()
    while (this.disposables.length) { this.disposables.pop()?.dispose() }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6)
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`
    return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;}
  h1{font-size:1.2em;} h2{font-size:1em;margin:16px 0 6px;}
  label{display:block;font-size:.85em;font-weight:600;margin:8px 0 3px;}
  input,select,textarea{width:100%;box-sizing:border-box;padding:7px;border-radius:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);}
  textarea{min-height:70px;font-family:var(--vscode-editor-font-family),monospace;}
  button{padding:7px 12px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin:6px 6px 0 0;}
  button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
  .card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:12px;margin:10px 0;}
  .row{display:flex;gap:8px;flex-wrap:wrap;} .row>div{flex:1;min-width:180px;}
  details summary{cursor:pointer;font-weight:600;}
  table{border-collapse:collapse;width:100%;margin-top:10px;font-size:.85em;} th,td{border:1px solid var(--vscode-panel-border);padding:4px 8px;text-align:left;} th{background:var(--vscode-editorWidget-background);}
  #toast{display:none;margin-top:10px;padding:9px;border-radius:6px;} #toast.good{background:rgba(60,180,90,.15);} #toast.bad{background:rgba(220,70,70,.18);}
  .muted{color:var(--vscode-descriptionForeground);font-size:.82em;}
  #resultWrap{overflow:auto;max-height:45vh;}
  #chips{margin:6px 0;} .chip{font-size:.82em;padding:5px 10px;border-radius:14px;}
  pre{background:var(--vscode-textCodeBlock-background);padding:8px;border-radius:6px;font-size:.85em;}
</style></head><body>
  <h1>Bases de datos (solo lectura)</h1>
  <p class="muted">Conecta a Oracle y SQL Server con tu driver JDBC. Solo consultas SELECT.</p>

  <h2>1) Elige una conexión</h2>
  <div class="row">
    <div><select id="conn"></select></div>
  </div>
  <button id="test" class="sec">Probar conexión</button>
  <button id="tables" class="sec">Ver tablas</button>
  <button id="setpw" class="sec">Guardar/actualizar contraseña</button>
  <div id="pwinfo" class="muted"></div>

  <h2>2) Pregúntale al agente (en español)</h2>
  <p class="muted">El agente (tu GitHub Copilot) explora el esquema y arma el SQL de solo lectura por ti.</p>
  <div id="chips">
    <button class="chip sec" data-q="Explora la base de datos y muéstrame las tablas principales">Explorar base de datos</button>
    <button class="chip sec" data-q="Dame los usuarios con edad de 16 años">Usuarios de 16 años</button>
    <button class="chip sec" data-q="Une las tablas relacionadas y muéstrame un resumen (join)">Uniones (join)</button>
    <button class="chip sec" data-q="Hazme un reporte con conteos agrupados por estado o categoría">Reporte</button>
  </div>
  <textarea id="ask" placeholder="Ej: dame los usuarios con edad de 16 años"></textarea>
  <button id="askBtn">Preguntar al agente</button>
  <span id="thinking" class="muted" style="display:none">⏳ el agente está explorando…</span>
  <div id="genwrap" style="display:none" class="card">
    <div class="muted">SQL generado por el agente:</div>
    <pre id="gensql" style="white-space:pre-wrap"></pre>
  </div>

  <h2>3) O escribe tu propio SQL (SELECT)</h2>
  <textarea id="sql" placeholder="SELECT * FROM usuarios WHERE estado = 'ACTIVO'"></textarea>
  <button id="run">Ejecutar consulta</button>
  <div id="toast"></div>
  <h2 id="rtitle" style="display:none"></h2>
  <div id="resultWrap"></div>

  <details class="card">
    <summary>+ Agregar una conexión nueva</summary>
    <label>Nombre</label><input id="n_name" placeholder="prod-oracle">
    <label>Motor</label>
    <select id="n_type"><option value="oracle">Oracle</option><option value="sqlserver">SQL Server</option></select>
    <label>URL JDBC</label><input id="n_url" placeholder="jdbc:oracle:thin:@//host:1521/servicio">
    <label>Usuario</label><input id="n_user" placeholder="usuario">
    <label>Contraseña</label><input id="n_pw" type="password" placeholder="(se guarda cifrada)">
    <label>Ruta del driver .jar</label><input id="n_jar" placeholder="C:\\drivers\\ojdbc11.jar">
    <button id="add">Guardar conexión</button>
    <p class="muted">SQL Server: jdbc:sqlserver://host:1433;databaseName=DB;encrypt=true;trustServerCertificate=true</p>
  </details>

<script nonce="${nonce}">
  const vscode=acquireVsCodeApi(); const $=id=>document.getElementById(id); let ST={connections:[]};
  function render(){
    const sel=$('conn'); const cur=sel.value; sel.innerHTML='';
    ST.connections.forEach(c=>{const o=document.createElement('option');o.value=c.name;o.textContent=c.name+' ('+c.type+')'+(c.hasPw?'':' — sin contraseña');sel.appendChild(o);});
    if(cur) sel.value=cur;
    const c=ST.connections.find(x=>x.name===sel.value);
    $('pwinfo').textContent = c? (c.hasPw?'Contraseña guardada.':'Aún no has guardado la contraseña de esta conexión.'):'No hay conexiones. Agrega una abajo.';
  }
  function showResult(title,res){
    $('rtitle').style.display='block'; $('rtitle').textContent=title+' — '+res.rowCount+' fila(s)';
    const w=$('resultWrap');
    if(!res.columns.length){w.innerHTML='<p class="muted">Sin columnas.</p>';return;}
    let h='<table><tr>'+res.columns.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr>';
    res.rows.forEach(r=>{h+='<tr>'+r.map(v=>'<td>'+esc(v==null?'':String(v))+'</td>').join('')+'</tr>';});
    h+='</table>'; w.innerHTML=h;
  }
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function toast(t,ok){const e=$('toast');e.style.display='block';e.className=ok?'good':'bad';e.textContent=t;}
  window.addEventListener('message',e=>{const m=e.data;
    if(m.type==='state'){ST=m;render();}
    else if(m.type==='result'){showResult(m.title,m.result);}
    else if(m.type==='toast'){toast(m.text,m.ok);}
    else if(m.type==='thinking'){$('thinking').style.display=m.on?'inline':'none';}
    else if(m.type==='nlResult'){$('genwrap').style.display='block';$('gensql').textContent=m.sql;showResult('Resultado (tablas: '+(m.tablesUsed||[]).join(', ')+')',m.result);}
  });
  $('conn').onchange=render;
  $('test').onclick=()=>vscode.postMessage({type:'test',name:$('conn').value});
  $('tables').onclick=()=>vscode.postMessage({type:'tables',name:$('conn').value});
  $('setpw').onclick=()=>vscode.postMessage({type:'setPw',name:$('conn').value});
  $('run').onclick=()=>vscode.postMessage({type:'query',name:$('conn').value,sql:$('sql').value});
  $('askBtn').onclick=()=>vscode.postMessage({type:'ask',name:$('conn').value,question:$('ask').value});
  document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{$('ask').value=b.getAttribute('data-q');vscode.postMessage({type:'ask',name:$('conn').value,question:b.getAttribute('data-q')});});
  $('add').onclick=()=>vscode.postMessage({type:'addConn',conn:{name:$('n_name').value,type:$('n_type').value,jdbcUrl:$('n_url').value,user:$('n_user').value,password:$('n_pw').value,driverJar:$('n_jar').value}});
  vscode.postMessage({type:'ready'});
</script></body></html>`
  }
}
