const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const m = require('../out/mcpConfig.js')

const ENTRY = { command: 'node', args: ['/ext/mcp/index.mjs'], env: { GENROCKET_CONFIG_FILE: '/cfg.json' } }

test('ruta de usuario: sube dos niveles desde globalStorage', () => {
  assert.strictEqual(
    m.userMcpPathFromGlobalStorage('/Users/x/Library/Application Support/Code/User/globalStorage/lrbg.genrocket-mcp-plugin'),
    '/Users/x/Library/Application Support/Code/User/mcp.json',
  )
})

test('ruta de usuario: tolera barra final', () => {
  assert.strictEqual(
    m.userMcpPathFromGlobalStorage('/a/User/globalStorage/lrbg.ext/'),
    path.join('/a/User', 'mcp.json'),
  )
})

test('ruta de usuario: funciona en Insiders y Cursor', () => {
  assert.ok(m.userMcpPathFromGlobalStorage('/a/Code - Insiders/User/globalStorage/lrbg.ext').endsWith(path.join('Code - Insiders', 'User', 'mcp.json')))
  assert.ok(m.userMcpPathFromGlobalStorage('/a/Cursor/User/globalStorage/lrbg.ext').endsWith(path.join('Cursor', 'User', 'mcp.json')))
})

test('archivo inexistente: crea el registro desde cero', () => {
  const out = JSON.parse(m.mergeMcpServers('', 'genrocket', ENTRY))
  assert.deepStrictEqual(out, { servers: { genrocket: ENTRY } })
})

test('archivo con solo espacios cuenta como vacio', () => {
  const out = JSON.parse(m.mergeMcpServers('   \n  ', 'genrocket', ENTRY))
  assert.deepStrictEqual(out.servers.genrocket, ENTRY)
})

test('conserva otros servidores MCP del usuario', () => {
  const prev = JSON.stringify({ servers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } } })
  const out = JSON.parse(m.mergeMcpServers(prev, 'genrocket', ENTRY))
  assert.deepStrictEqual(out.servers.github, { command: 'npx', args: ['-y', 'gh-mcp'] })
  assert.deepStrictEqual(out.servers.genrocket, ENTRY)
})

test('conserva claves ajenas fuera de servers (inputs)', () => {
  const prev = JSON.stringify({ inputs: [{ id: 'tok', type: 'promptString' }], servers: {} })
  const out = JSON.parse(m.mergeMcpServers(prev, 'genrocket', ENTRY))
  assert.deepStrictEqual(out.inputs, [{ id: 'tok', type: 'promptString' }])
})

test('actualiza el registro previo de genrocket en vez de duplicarlo', () => {
  const prev = JSON.stringify({ servers: { genrocket: { command: 'node', args: ['/viejo.mjs'] } } })
  const out = JSON.parse(m.mergeMcpServers(prev, 'genrocket', ENTRY))
  assert.strictEqual(Object.keys(out.servers).length, 1)
  assert.deepStrictEqual(out.servers.genrocket.args, ['/ext/mcp/index.mjs'])
})

test('acepta comentarios de linea y de bloque', () => {
  const prev = `{
    // mi servidor
    "servers": {
      /* bloque */
      "github": { "command": "npx", "args": [] }
    }
  }`
  const out = JSON.parse(m.mergeMcpServers(prev, 'genrocket', ENTRY))
  assert.ok(out.servers.github)
  assert.ok(out.servers.genrocket)
})

test('acepta comas colgantes', () => {
  const prev = '{ "servers": { "github": { "command": "npx", "args": [], }, }, }'
  const out = JSON.parse(m.mergeMcpServers(prev, 'genrocket', ENTRY))
  assert.ok(out.servers.github)
})

test('no confunde // dentro de una cadena con un comentario', () => {
  const prev = JSON.stringify({ servers: { web: { command: 'node', args: ['https://ejemplo.com/x'] } } })
  const out = JSON.parse(m.mergeMcpServers(prev, 'genrocket', ENTRY))
  assert.deepStrictEqual(out.servers.web.args, ['https://ejemplo.com/x'])
})

test('no confunde comillas escapadas dentro de cadenas', () => {
  const prev = JSON.stringify({ servers: { raro: { command: 'node', args: ['dice \\"hola\\" // no'] } } })
  const out = JSON.parse(m.mergeMcpServers(prev, 'genrocket', ENTRY))
  assert.ok(out.servers.raro)
  assert.ok(out.servers.genrocket)
})

test('archivo corrupto: lanza y NO devuelve contenido', () => {
  assert.throws(() => m.mergeMcpServers('{ esto no es json', 'genrocket', ENTRY), /McpFileCorruptError|JSON/)
})

test('archivo que es un arreglo: se considera corrupto', () => {
  assert.throws(() => m.mergeMcpServers('[1,2,3]', 'genrocket', ENTRY))
})

test('servers con tipo invalido no rompe: se reemplaza', () => {
  const out = JSON.parse(m.mergeMcpServers('{ "servers": "roto" }', 'genrocket', ENTRY))
  assert.deepStrictEqual(out.servers, { genrocket: ENTRY })
})

test('hasMcpServer detecta registro previo', () => {
  assert.strictEqual(m.hasMcpServer(JSON.stringify({ servers: { genrocket: ENTRY } }), 'genrocket'), true)
  assert.strictEqual(m.hasMcpServer(JSON.stringify({ servers: { otro: ENTRY } }), 'genrocket'), false)
  assert.strictEqual(m.hasMcpServer('', 'genrocket'), false)
  assert.strictEqual(m.hasMcpServer('{ roto', 'genrocket'), false)
})

test('la salida termina en salto de linea', () => {
  assert.ok(m.mergeMcpServers('', 'genrocket', ENTRY).endsWith('\n'))
})
