// Lógica pura del dashboard (SIN dependencias de vscode) — testeable en node.
import * as fs from 'fs'

export interface Entry {
  ts: string
  user: string
  action: string        // seed | context | context_project | push
  domain?: string
  rows?: number
  format?: string
  repos?: string[]
  pushed?: boolean
  ok?: boolean
  error?: string
}

export interface Agg {
  totalDatasets: number
  totalRows: number
  domainsUsed: number
  reposCount: number
  users: number
  lastTs: string
  byDomain: { name: string; runs: number; rows: number; formats: string[]; last: string }[]
  byUser: { name: string; seeds: number; contexts: number; pushes: number; rows: number; last: string }[]
  commitsByUser: { name: string; count: number }[]
  recentErrors: Entry[]
  daily: { day: string; rows: number }[]
}

export function readJsonl(file: string): Entry[] {
  try {
    const txt = fs.readFileSync(file, 'utf8')
    return txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      try { return JSON.parse(l) as Entry } catch { return null }
    }).filter((e): e is Entry => !!e && !!e.ts)
  } catch { return [] }
}

export function aggregate(entries: Entry[]): Agg {
  const domains = new Map<string, { runs: number; rows: number; formats: Set<string>; last: string }>()
  const users = new Map<string, { seeds: number; contexts: number; pushes: number; rows: number; last: string }>()
  const commits = new Map<string, number>()
  const repos = new Set<string>()
  const daily = new Map<string, number>()
  let totalRows = 0, totalDatasets = 0, lastTs = ''
  const errors: Entry[] = []

  for (const e of entries) {
    if (e.ts > lastTs) { lastTs = e.ts }
    const u = e.user || 'desconocido'
    if (!users.has(u)) { users.set(u, { seeds: 0, contexts: 0, pushes: 0, rows: 0, last: '' }) }
    const us = users.get(u)!
    if (e.ts > us.last) { us.last = e.ts }

    if (e.ok === false) { errors.push(e); continue }

    if (e.action === 'seed') {
      totalDatasets++; us.seeds++
      const r = Number(e.rows || 0); totalRows += r; us.rows += r
      const day = e.ts.slice(0, 10); daily.set(day, (daily.get(day) || 0) + r)
      const dom = e.domain || '(sin dominio)'
      if (!domains.has(dom)) { domains.set(dom, { runs: 0, rows: 0, formats: new Set(), last: '' }) }
      const d = domains.get(dom)!; d.runs++; d.rows += r; if (e.format) { d.formats.add(e.format) }; if (e.ts > d.last) { d.last = e.ts }
    } else if (e.action === 'context' || e.action === 'context_project') {
      us.contexts++
    }
    ;(e.repos || []).forEach(rp => repos.add(rp))
    if (e.pushed || (e.repos && e.repos.length)) { us.pushes++; commits.set(u, (commits.get(u) || 0) + (e.repos?.length || 1)) }
  }

  return {
    totalDatasets, totalRows, domainsUsed: domains.size, reposCount: repos.size, users: users.size, lastTs,
    byDomain: [...domains.entries()].map(([name, d]) => ({ name, runs: d.runs, rows: d.rows, formats: [...d.formats], last: d.last })).sort((a, b) => b.rows - a.rows),
    byUser: [...users.entries()].map(([name, u]) => ({ name, ...u })).sort((a, b) => b.rows - a.rows),
    commitsByUser: [...commits.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    recentErrors: errors.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 8),
    daily: [...daily.entries()].map(([day, rows]) => ({ day, rows })).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-14),
  }
}

export function buildMarkdown(agg: Agg, scope: string): string {
  const fmt = (n: number) => n.toLocaleString('es-MX')
  let md = `# GenRocket · Manager Dashboard\n\n_OCP · Directiva N.4 — alcance: ${scope}_\n\n`
  md += `> Datasets: **${fmt(agg.totalDatasets)}** · Filas generadas: **${fmt(agg.totalRows)}** · Dominios: **${agg.domainsUsed}** · Repos: **${agg.reposCount}** · Usuarios: **${agg.users}** · Última actividad: ${agg.lastTs ? agg.lastTs.replace('T', ' ').slice(0, 16) : '—'}\n\n`

  if (agg.byDomain.length) {
    md += `## Datos generados por dominio\n\n\`\`\`mermaid\npie title Filas por dominio\n`
    agg.byDomain.slice(0, 10).forEach(d => { md += `  "${d.name}" : ${d.rows}\n` })
    md += `\`\`\`\n\n| Dominio | Ejecuciones | Filas | Formatos | Último uso |\n|---|--:|--:|---|---|\n`
    agg.byDomain.forEach(d => { md += `| ${d.name} | ${d.runs} | ${fmt(d.rows)} | ${d.formats.join(', ') || '—'} | ${d.last.slice(0, 10)} |\n` })
    md += `\n`
  }

  if (agg.commitsByUser.length) {
    md += `## Commits / publicaciones por usuario (vía plugin)\n\n\`\`\`mermaid\npie title Publicaciones por usuario\n`
    agg.commitsByUser.forEach(u => { md += `  "${u.name}" : ${u.count}\n` })
    md += `\`\`\`\n\n`
  }

  if (agg.byUser.length) {
    md += `## Actividad por usuario\n\n`
    agg.byUser.forEach(u => {
      md += `- **${u.name}** — ${u.seeds} siembras (${fmt(u.rows)} filas), ${u.contexts} contextos, ${u.pushes} publicaciones · último: ${u.last.slice(0, 10)}\n`
    })
    md += `\n`
  }

  md += `## Salud\n\n`
  md += agg.recentErrors.length
    ? agg.recentErrors.map(e => `- [FALLO] ${e.ts.slice(0, 16).replace('T', ' ')} · ${e.user} · ${e.action}: ${e.error || 'error'}`).join('\n') + '\n'
    : `- Sin errores recientes.\n`

  if (agg.daily.length > 1) {
    md += `\n## Tendencia (filas/día)\n\n\`\`\`mermaid\nxychart-beta\n  title "Filas generadas por día"\n  x-axis [${agg.daily.map(d => '"' + d.day.slice(5) + '"').join(', ')}]\n  bar [${agg.daily.map(d => d.rows).join(', ')}]\n\`\`\`\n`
  }

  md += `\n---\n_Dashboard del Manager (solo lectura). Generado por el plugin GenRocket MCP._\n`
  return md
}
