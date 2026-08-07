#!/usr/bin/env node
/**
 * Servidor MCP de GenRocket (standalone) para VS Code / cualquier cliente MCP.
 * Expone las herramientas de GenRocket definidas en ./genrocket.mjs.
 *
 * Config por variables de entorno:
 *   GENROCKET_BASE_URL, GENROCKET_USERNAME, GENROCKET_PASSWORD, GENROCKET_ORG_ID
 *   GENROCKET_RUNTIME_CMD (usa {grs} y {dir}), GENROCKET_RUNTIME_OUTDIR
 */
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerGenRocketTools } from './genrocket.mjs'
import { registerFakerTools } from './faker.mjs'
import { registerPublishTools } from './publish.mjs'
import { registerSkillsTools } from './skills.mjs'
import { registerGraphRagTools } from './graphrag.mjs'
import { registerSharePointTools } from './sharepoint.mjs'
import { registerDbExploreTools } from './db.mjs'

// Versión desde el package.json de la extensión (evita drift con un número hardcodeado).
let version = '0.0.0'
try { version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || version } catch { /* usa fallback */ }

const INSTRUCTIONS = [
  'Este servidor expone GenRocket (datos sintéticos), un módulo de bases de datos de solo lectura, generación con el Runtime local y un RAG de documentos.',
  'ANTES de diagnosticar un fallo o construir un flujo con GenRocket, llama a la tool `genrocket_context` para cargar el contexto (errores conocidos de la API, módulo de BD, Runtime y un playbook síntoma→herramienta).',
  'Ante cualquier fallo del Runtime (licencia, Excel/POI) o de BD ("sin columnas"), usa `genrocket_runtime_doctor` para diagnosticar en un solo paso.',
].join(' ')

const server = new McpServer({ name: 'genrocket-mcp', version }, { instructions: INSTRUCTIONS })
registerGenRocketTools(server)
registerFakerTools(server)
registerPublishTools(server)
registerSkillsTools(server)
registerGraphRagTools(server)
registerSharePointTools(server)
registerDbExploreTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
