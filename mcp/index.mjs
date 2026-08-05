#!/usr/bin/env node
/**
 * Servidor MCP de GenRocket (standalone) para VS Code / cualquier cliente MCP.
 * Expone las herramientas de GenRocket definidas en ./genrocket.mjs.
 *
 * Config por variables de entorno:
 *   GENROCKET_BASE_URL, GENROCKET_USERNAME, GENROCKET_PASSWORD, GENROCKET_ORG_ID
 *   GENROCKET_RUNTIME_CMD (usa {grs} y {dir}), GENROCKET_RUNTIME_OUTDIR
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerGenRocketTools } from './genrocket.mjs'
import { registerFakerTools } from './faker.mjs'
import { registerPublishTools } from './publish.mjs'

const server = new McpServer({ name: 'genrocket-mcp', version: "0.1.25" })
registerGenRocketTools(server)
registerFakerTools(server)
registerPublishTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
