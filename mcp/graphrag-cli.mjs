#!/usr/bin/env node
/**
 * CLI para indexar una carpeta hacia el graph-RAG, usado por el panel de la
 * extensión ("Indexar ahora"). Reusa exactamente la misma lógica que la tool
 * MCP index_docs, y escribe el índice en GENROCKET_GRAPHRAG_DIR — el mismo lugar
 * que lee query_docs, así lo indexado desde la UI queda disponible para Copilot.
 *
 * Uso:  node graphrag-cli.mjs "<carpeta>"
 *       (GENROCKET_GRAPHRAG_DIR define dónde se guarda el índice)
 */
import { buildIndex, saveIndex } from './graphrag.mjs'

const folder = process.argv[2]
if (!folder) {
  console.log(JSON.stringify({ ok: false, error: 'Falta la ruta de la carpeta.' }))
  process.exit(2)
}

try {
  const idx = await buildIndex(folder)
  if (!idx.N) {
    console.log(JSON.stringify({ ok: false, error: 'No se pudo extraer texto indexable.', createdFiles: idx.createdFiles, skipped: idx.skipped }))
    process.exit(0)
  }
  saveIndex(idx)
  console.log(JSON.stringify({
    ok: true,
    folder,
    indexedFiles: idx.indexedFiles,
    createdFiles: idx.createdFiles,
    chunks: idx.N,
    concepts: Object.keys(idx.nodes).length,
    skipped: idx.skipped,
  }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }))
  process.exit(1)
}
