/**
 * Conector de SharePoint por Microsoft Graph (lectura), expuesto por el MCP.
 *
 * La extensión obtiene el token de Graph con el login de Microsoft de VS Code
 * (comando "GenRocket: Conectar SharePoint") y lo pasa al MCP en la config como
 * `graphToken`. Aquí se usa ese token para llamar a Graph.
 *
 * Por ahora: sharepoint_test_connection — valida el token, resuelve el sitio y
 * lista sus bibliotecas y el contenido de la raíz. Es el paso que de-riesga la
 * auth antes de construir el indexado (¿el tenant permite leer el sitio?).
 */
import { z } from 'zod'
import { getConfig } from './genrocket.mjs'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const ok = (text) => ({ content: [{ type: 'text', text }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

function graphToken() {
  return getConfig().graphToken || process.env.GRAPH_TOKEN || ''
}

async function graphGet(path, tok) {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${tok}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* respuesta no JSON */ }
  return { status: res.status, json, text }
}

// De una URL de SharePoint saca { host, sitePath }. Acepta /sites/<n> y /teams/<n>.
function parseSiteUrl(url) {
  let u
  try { u = new URL(url) } catch { return { host: '', sitePath: '' } }
  const host = u.hostname
  const m = decodeURIComponent(u.pathname).match(/\/(sites|teams)\/[^/]+/i)
  return { host, sitePath: m ? m[0] : '' }
}

export function registerSharePointTools(server) {
  server.tool(
    'sharepoint_test_connection',
    'Prueba el acceso a SharePoint por Microsoft Graph con el token del usuario (cuenta Microsoft de VS Code). Resuelve el sitio a partir de su URL, y lista sus bibliotecas y el contenido de la raíz. Sirve para confirmar que el tenant permite leer el sitio ANTES de indexar. Si no hay token, primero ejecuta en VS Code el comando "GenRocket: Conectar SharePoint (Microsoft)".',
    {
      siteUrl: z.string().describe('URL del sitio o carpeta de SharePoint, ej. https://empresa.sharepoint.com/sites/QA/... o https://host/teams/equipo/...'),
    },
    async ({ siteUrl }) => {
      try {
        const tok = graphToken()
        if (!tok) {
          return bad('No hay token de Microsoft/Graph. En VS Code ejecuta "GenRocket: Conectar SharePoint (Microsoft)" y reinicia el MCP; luego reintenta.')
        }

        // 1) Identidad del token
        const me = await graphGet('/me', tok)
        if (me.status === 401) {
          return bad('Token de Graph inválido o expirado. Reconecta con "GenRocket: Conectar SharePoint (Microsoft)" y reinicia el MCP.')
        }
        const who = me.json?.userPrincipalName || me.json?.mail || me.json?.displayName || '(desconocido)'

        // 2) Resolver el sitio
        const { host, sitePath } = parseSiteUrl(siteUrl)
        if (!host || !sitePath) {
          return bad(`No pude interpretar la URL. Usa algo como https://<host>/sites/<sitio> o /teams/<sitio>. (host="${host}", path="${sitePath}")`)
        }
        const site = await graphGet(`/sites/${host}:${sitePath}`, tok)
        if (site.status !== 200) {
          const err = site.json?.error || {}
          let hint = ''
          if (site.status === 403 || /denied|Authorization_RequestDenied|accessDenied/i.test(err.code || '')) {
            hint = '\n→ Permisos: tu tenant exige consentimiento de admin para Sites.Read.All / Files.Read.All. Debe habilitarlo IT de la organización.'
          } else if (site.status === 400) {
            hint = `\n→ Host inválido para Graph: "${host}" quizá NO es SharePoint Online (¿on-premises o dominio vanity?). Prueba con el host real *.sharepoint.com.`
          } else if (site.status === 404) {
            hint = '\n→ Sitio no encontrado con esa ruta. Verifica /sites/<nombre> o /teams/<nombre>.'
          }
          return bad(`Autenticado como ${who}, pero GET /sites/${host}:${sitePath} → HTTP ${site.status} ${err.code || ''}. ${err.message || site.text.slice(0, 160)}${hint}`)
        }

        const siteId = site.json.id
        const siteName = site.json.displayName || site.json.name || sitePath

        // 3) Bibliotecas (document libraries) del sitio
        const drives = await graphGet(`/sites/${siteId}/drives`, tok)
        const driveList = drives.json?.value || []
        const driveNames = driveList.map((d) => d.name).join(', ') || '(ninguna)'

        // 4) Contenido de la raíz de la primera biblioteca
        let sample = ''
        const first = driveList[0]
        if (first) {
          const kids = await graphGet(`/drives/${first.id}/root/children`, tok)
          const items = kids.json?.value || []
          sample = items.slice(0, 15).map((c) =>
            `- ${c.name}${c.folder ? `/  (${c.folder.childCount ?? '?'} elem.)` : `  (${Math.round((c.size || 0) / 1024)} KB)`}`,
          ).join('\n') || '(vacío o sin acceso al contenido)'
        }

        return ok(
          `Conexión a SharePoint por Graph: OK\n` +
          `Usuario: ${who}\n` +
          `Sitio: ${siteName}  [${siteId}]\n` +
          `Bibliotecas: ${driveNames}\n\n` +
          `Contenido de la raíz de "${first?.name || '-'}":\n${sample}\n\n` +
          `Listo: el tenant permite leer este sitio. Siguiente paso: indexar (extraer texto de docx/pdf/xlsx/html) hacia el graph-RAG.`,
        )
      } catch (e) {
        if (e?.name === 'TimeoutError') { return bad('Graph no respondió a tiempo (timeout).') }
        return bad(`sharepoint_test_connection: ${e.message}`)
      }
    },
  )
}
