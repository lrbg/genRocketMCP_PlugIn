/**
 * Skills incluidas en el plugin, expuestas al agente (Copilot) vía MCP.
 *
 * Las skills son guías de trabajo (instrucciones) empaquetadas dentro de la
 * extensión, en ./skills/<nombre>/SKILL.md. Este módulo las descubre y ofrece
 * dos tools:
 *   - list_skills: lista nombre + descripción de cada skill.
 *   - get_skill:   devuelve el contenido COMPLETO de una skill para que el
 *                  agente la siga, más las rutas de sus archivos/scripts.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'
import { z } from 'zod'

const SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url))
const ok = (text) => ({ content: [{ type: 'text', text }] })
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

const SKILL_FILES = ['SKILL.md', 'skill.md', 'README.md']

function skillDirs() {
  if (!existsSync(SKILLS_DIR)) { return [] }
  return readdirSync(SKILLS_DIR)
    .map((n) => join(SKILLS_DIR, n))
    .filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
}

function skillFilePath(dir) {
  return SKILL_FILES.map((n) => join(dir, n)).find((p) => existsSync(p)) || null
}

// Lee name + description del frontmatter YAML (best-effort; soporta description
// multilínea con bloques >, | o comillas).
function readMeta(dir) {
  const file = skillFilePath(dir)
  if (!file) { return null }
  const md = readFileSync(file, 'utf8')
  let name = basename(dir)
  let description = ''
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (fm) {
    const block = fm[1]
    const nm = block.match(/^name:\s*(.+)$/m)
    if (nm) { name = nm[1].trim().replace(/^['"]|['"]$/g, '') }
    const dm = block.match(/^description:\s*(.*(?:\n(?!\s*[A-Za-z0-9_-]+:).*)*)/m)
    if (dm) {
      description = dm[1]
        .replace(/^[>|][-+]?\s*/, '')        // quita indicador de bloque scalar
        .replace(/\s*\n\s+/g, ' ')            // une líneas de continuación
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^['"]|['"]$/g, '')
    }
  }
  return { name, description, file, dir, md }
}

function allSkills() {
  return skillDirs().map(readMeta).filter(Boolean)
}

function listFiles(dir, base = dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { listFiles(p, base, acc) }
    else { acc.push(p) }
  }
  return acc
}

export function registerSkillsTools(server) {
  server.tool(
    'list_skills',
    'Lista las SKILLS (guías de trabajo) incluidas en este plugin y disponibles para el agente vía MCP. Cada skill son instrucciones que conviene seguir para cierto tipo de tarea (planear, optimizar SQL, generar datos sintéticos, OCR, documentos Word, análisis de negocio, etc.). Cuando la tarea del usuario encaje con una skill, usa get_skill para traer sus instrucciones y síguelas.',
    {},
    async () => {
      try {
        const skills = allSkills()
        if (!skills.length) { return ok('No hay skills incluidas en el plugin.') }
        const lines = skills.map((s) => `- ${s.name}: ${s.description || '(sin descripción)'}`).join('\n')
        return ok(`Skills disponibles (usa get_skill con el nombre para obtener sus instrucciones):\n${lines}`)
      } catch (e) { return bad(`list_skills: ${e.message}`) }
    },
  )

  server.tool(
    'get_skill',
    'Devuelve el contenido COMPLETO de una skill (sus instrucciones en Markdown) para que el agente la siga al pie de la letra. Si la skill trae scripts o archivos de apoyo, se listan sus rutas absolutas (van empaquetados dentro de la extensión instalada). Primero usa list_skills para ver los nombres disponibles.',
    {
      name: z.string().describe('Nombre exacto de la skill (de list_skills).'),
    },
    async ({ name }) => {
      try {
        const skills = allSkills()
        const s = skills.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase())
        if (!s) { return bad(`Skill "${name}" no encontrada. Disponibles: ${skills.map((x) => x.name).join(', ') || '(ninguna)'}`) }
        let out = s.md
        const files = listFiles(s.dir).filter((f) => f !== s.file)
        if (files.length) {
          out += `\n\n---\n**Archivos incluidos en esta skill** (empaquetados en la extensión; rutas absolutas para leerlos/ejecutarlos):\n${files.map((f) => `- ${f}`).join('\n')}`
        }
        return ok(out)
      } catch (e) { return bad(`get_skill: ${e.message}`) }
    },
  )
}
