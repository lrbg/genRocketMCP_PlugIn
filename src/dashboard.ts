import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as git from './git'
import { Entry, Agg, readJsonl, aggregate, buildMarkdown } from './dashboardCore'

// ── Registro de actividad ─────────────────────────────────────────────────────
export function activityPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'activity.jsonl')
}

/** Escribe una entrada de actividad desde el lado de la extensión (ej. push del asistente Git). */
export function appendActivity(context: vscode.ExtensionContext, entry: Partial<Entry>) {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true })
    const full: Entry = { ts: new Date().toISOString(), user: entry.user || 'local', action: entry.action || 'action', ok: true, ...entry }
    fs.appendFileSync(activityPath(context), JSON.stringify(full) + '\n', 'utf8')
  } catch { /* no romper la acción principal por el log */ }
}

// ── Sincronización de equipo (opcional, por repo compartido) ──────────────────
async function syncAndRead(context: vscode.ExtensionContext): Promise<{ entries: Entry[]; scope: string; note: string }> {
  const local = readJsonl(activityPath(context))
  const c = vscode.workspace.getConfiguration('genrocket')
  const teamRepo = (c.get<string>('dashboard.teamRepo', '') || '').trim()
  const teamPath = (c.get<string>('dashboard.teamPath', '.genrocket/activity') || '.genrocket/activity').trim()
  if (!teamRepo) { return { entries: local, scope: 'Local (esta máquina)', note: 'Configura genrocket.dashboard.teamRepo para agregar a todo el equipo.' } }

  try {
    const session = await git.getSession(false)
    if (!session) { return { entries: local, scope: 'Local', note: 'Sin sesión de GitHub: no se pudo sincronizar el equipo.' } }
    const m = teamRepo.replace(/\.git$/, '').match(/([^/:]+)\/([^/]+)$/)
    if (!m) { return { entries: local, scope: 'Local', note: `teamRepo inválido: "${teamRepo}" (usa owner/nombre).` } }
    const [, owner, name] = m
    const dir = await git.cloneRepo(session.accessToken, owner, name, git.cloneBaseDir())

    const teamDir = path.join(dir, teamPath)
    fs.mkdirSync(teamDir, { recursive: true })
    // sube el log de ESTE usuario como <user>.jsonl (sin conflictos entre usuarios)
    const user = (session.account.label || 'user').replace(/[^\w.-]/g, '_')
    if (fs.existsSync(activityPath(context))) { fs.copyFileSync(activityPath(context), path.join(teamDir, `${user}.jsonl`)) }
    const author = git.defaultAuthor(session)
    const branch = await git.currentBranch(dir).catch(() => 'main')
    try { await git.commitAndPush(dir, `actividad del dashboard: ${user}`, branch, session.accessToken, author.name, author.email) } catch { /* seguir con lectura */ }

    // lee TODOS los <user>.jsonl del equipo
    const all: Entry[] = []
    for (const f of fs.readdirSync(teamDir)) {
      if (f.endsWith('.jsonl')) { all.push(...readJsonl(path.join(teamDir, f))) }
    }
    return { entries: all.length ? all : local, scope: `Equipo (${teamRepo})`, note: '' }
  } catch (e: any) {
    return { entries: local, scope: 'Local', note: `No se pudo sincronizar el equipo: ${e.message}` }
  }
}

// ── Panel (webview) ───────────────────────────────────────────────────────────
export class DashboardPanel {
  private static current: DashboardPanel | undefined
  private lastMd = ''

  static async show(context: vscode.ExtensionContext) {
    if (DashboardPanel.current) { DashboardPanel.current.panel.reveal(); await DashboardPanel.current.refresh(); return }
    const panel = vscode.window.createWebviewPanel('genrocketDashboard', 'GenRocket · Manager', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true })
    DashboardPanel.current = new DashboardPanel(panel, context)
  }

  private constructor(private panel: vscode.WebviewPanel, private context: vscode.ExtensionContext) {
    panel.onDidDispose(() => { DashboardPanel.current = undefined })
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'refresh') { await this.refresh() }
      else if (m.type === 'saveMd') { await this.saveMd() }
    })
    this.refresh()
  }

  private async refresh() {
    this.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px;">Cargando dashboard…</body></html>`
    const { entries, scope, note } = await syncAndRead(this.context)
    const agg = aggregate(entries)
    this.lastMd = buildMarkdown(agg, scope)
    this.panel.webview.html = this.render(agg, scope, note)
  }

  private async saveMd() {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir(), 'genrocket-dashboard.md')) })
    if (!uri) { return }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(this.lastMd, 'utf8'))
    vscode.window.showInformationMessage(`Dashboard guardado: ${uri.fsPath}`)
  }

  private render(agg: Agg, scope: string, note: string): string {
    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6)
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`
    const fmt = (n: number) => n.toLocaleString('es-MX')
    const esc = (s: any) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
    const PALETTE = ['#e06c3b', '#3b82e0', '#3bb273', '#e0b23b', '#9b59b6', '#e05555', '#1abc9c', '#95a5a6', '#e67e22', '#2c3e50']

    const kpi = (label: string, val: string) => `<div class="kpi"><div class="v">${val}</div><div class="l">${label}</div></div>`

    const bars = (rows: { label: string; value: number }[], unit = '') => {
      const max = Math.max(1, ...rows.map(r => r.value))
      return rows.map((r, i) => `<div class="bar"><span class="bl">${esc(r.label)}</span><span class="bt"><span class="bf" style="width:${Math.round(r.value / max * 100)}%;background:${PALETTE[i % PALETTE.length]}"></span></span><span class="bv">${fmt(r.value)}${unit}</span></div>`).join('')
    }

    const donut = (rows: { label: string; value: number }[]) => {
      const total = rows.reduce((s, r) => s + r.value, 0) || 1
      let acc = 0
      const stops = rows.slice(0, 10).map((r, i) => { const a = acc / total * 360; acc += r.value; const b = acc / total * 360; return `${PALETTE[i % PALETTE.length]} ${a}deg ${b}deg` }).join(', ')
      const legend = rows.slice(0, 10).map((r, i) => `<div class="lg"><span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(r.label)} — ${fmt(r.value)} (${Math.round(r.value / total * 100)}%)</div>`).join('')
      return `<div class="donutwrap"><div class="donut" style="background:conic-gradient(${stops})"></div><div class="legend">${legend}</div></div>`
    }

    const domainTable = agg.byDomain.map(d => `<tr><td>${esc(d.name)}</td><td class="n">${d.runs}</td><td class="n">${fmt(d.rows)}</td><td>${esc(d.formats.join(', ') || '—')}</td><td>${esc(d.last.slice(0, 10))}</td></tr>`).join('')
    const userLines = agg.byUser.map(u => `<li><b>${esc(u.name)}</b> — ${u.seeds} siembras (${fmt(u.rows)} filas), ${u.contexts} contextos, ${u.pushes} publicaciones · <span class="muted">último ${esc(u.last.slice(0, 10))}</span></li>`).join('')
    const errList = agg.recentErrors.length
      ? agg.recentErrors.map(e => `<li class="err">[FALLO] ${esc(e.ts.slice(0, 16).replace('T', ' '))} · ${esc(e.user)} · ${esc(e.action)}: ${esc(e.error || 'error')}</li>`).join('')
      : `<li class="muted">Sin errores recientes.</li>`

    const dbConns = (vscode.workspace.getConfiguration('genrocket').get<any[]>('dbConnections', []) || []).filter(d => d && d.name)
    const dbList = dbConns.length ? dbConns.map(d => `<li>${esc(d.name)} <span class="muted">(${esc(d.type || 'oracle')})</span></li>`).join('') : `<li class="muted">Sin conexiones configuradas.</li>`

    const empty = agg.totalDatasets === 0 && agg.byUser.length === 0

    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:22px;max-width:980px;margin:auto;}
  .hd{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:2px solid #e06c3b;padding-bottom:10px;margin-bottom:6px;}
  .hd h1{font-size:1.25em;margin:0;letter-spacing:.5px;}
  .brand{font-size:.72em;color:#e06c3b;font-weight:700;letter-spacing:2px;text-transform:uppercase;}
  .scope{font-size:.8em;color:var(--vscode-descriptionForeground);margin:2px 0 14px;}
  .kpis{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 24px;}
  .kpi{flex:1;min-width:120px;background:var(--vscode-textBlockQuote-background);border-radius:8px;padding:12px 14px;border-left:3px solid #e06c3b;}
  .kpi .v{font-size:1.3em;font-weight:700;}
  .kpi .l{font-size:.75em;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.5px;}
  h2{font-size:1.02em;margin:26px 0 10px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));padding-bottom:5px;}
  .bar{display:flex;align-items:center;gap:10px;margin:5px 0;font-size:.86em;}
  .bar .bl{width:170px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bar .bt{flex:1;background:rgba(128,128,128,.15);border-radius:5px;height:16px;overflow:hidden;}
  .bar .bf{display:block;height:100%;border-radius:5px;}
  .bar .bv{width:90px;font-variant-numeric:tabular-nums;}
  .donutwrap{display:flex;align-items:center;gap:24px;flex-wrap:wrap;}
  .donut{width:150px;height:150px;border-radius:50%;flex:0 0 auto;}
  .donut::after{content:"";display:block;width:70px;height:70px;background:var(--vscode-editor-background);border-radius:50%;position:relative;top:40px;left:40px;}
  .legend{font-size:.85em;line-height:1.9;}
  .lg .dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px;}
  table{border-collapse:collapse;width:100%;font-size:.85em;margin-top:8px;}
  th,td{border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));padding:6px 8px;text-align:left;}
  th{color:var(--vscode-descriptionForeground);font-weight:600;}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;}
  ul{margin:6px 0;padding-left:18px;} li{margin:4px 0;font-size:.88em;}
  .muted{color:var(--vscode-descriptionForeground);} .err{color:#e05555;}
  .row{display:flex;gap:16px;flex-wrap:wrap;} .col{flex:1;min-width:260px;}
  .note{background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-textLink-foreground);padding:8px 12px;border-radius:6px;font-size:.82em;margin:10px 0;}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:5px;padding:7px 13px;cursor:pointer;font-weight:600;}
  button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
  .actions{display:flex;gap:10px;margin:4px 0 0;}
  .empty{padding:30px;text-align:center;color:var(--vscode-descriptionForeground);}
</style></head><body>
  <div class="hd">
    <div><div class="brand">OCP · Directiva N.4</div><h1>GenRocket · Manager Dashboard</h1></div>
    <div class="actions"><button id="refresh">Actualizar</button><button id="save" class="sec">Guardar .md</button></div>
  </div>
  <div class="scope">Alcance: <b>${esc(scope)}</b></div>
  ${note ? `<div class="note">${esc(note)}</div>` : ''}

  ${empty ? `<div class="empty">Aún no hay actividad registrada.<br>Genera datos o contexto con el plugin (seed_from_db_and_publish, domain_to_markdown) y vuelve a abrir el dashboard.</div>` : `
  <div class="kpis">
    ${kpi('Datasets', fmt(agg.totalDatasets))}
    ${kpi('Filas generadas', fmt(agg.totalRows))}
    ${kpi('Dominios', String(agg.domainsUsed))}
    ${kpi('Repos', String(agg.reposCount))}
    ${kpi('Usuarios', String(agg.users))}
    ${kpi('Última', agg.lastTs ? esc(agg.lastTs.slice(5, 16).replace('T', ' ')) : '—')}
  </div>

  <h2>Datos generados por dominio</h2>
  ${agg.byDomain.length ? donut(agg.byDomain.map(d => ({ label: d.name, value: d.rows }))) : '<div class="muted">Sin datos de dominios todavía.</div>'}
  ${agg.byDomain.length ? `<table><tr><th>Dominio</th><th class="n">Ejec.</th><th class="n">Filas</th><th>Formatos</th><th>Último</th></tr>${domainTable}</table>` : ''}

  <div class="row">
    <div class="col">
      <h2>Commits / publicaciones por usuario</h2>
      ${agg.commitsByUser.length ? bars(agg.commitsByUser.map(u => ({ label: u.name, value: u.count }))) : '<div class="muted">Sin publicaciones todavía.</div>'}
    </div>
  </div>

  <h2>Actividad por usuario</h2>
  <ul>${userLines || '<li class="muted">Sin actividad.</li>'}</ul>

  <div class="row">
    <div class="col"><h2>Salud — errores recientes</h2><ul>${errList}</ul></div>
    <div class="col"><h2>Conexiones de BD</h2><ul>${dbList}</ul></div>
  </div>
  `}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh').onclick = () => vscode.postMessage({type:'refresh'});
    document.getElementById('save').onclick = () => vscode.postMessage({type:'saveMd'});
  </script>
</body></html>`
  }
}
