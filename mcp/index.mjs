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

const server = new McpServer({ name: 'genrocket-mcp', version })
registerGenRocketTools(server)
registerFakerTools(server)
registerPublishTools(server)
registerSkillsTools(server)
registerGraphRagTools(server)
registerSharePointTools(server)
registerDbExploreTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
