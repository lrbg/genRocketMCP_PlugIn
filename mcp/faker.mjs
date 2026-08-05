/**
 * Módulo standalone de datos falsos con Faker (SIN GenRocket).
 * Genera datos rápidos y los exporta a JSON, CSV o Excel (.xlsx).
 */
import { faker as fakerEN, fakerES_MX } from '@faker-js/faker'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUTDIR = process.env.GENROCKET_FAKER_OUTDIR || join(tmpdir(), 'genrocket-faker')

// Tipos de campo soportados → función que genera el valor
const TYPES = {
  firstName: (f) => f.person.firstName(),
  lastName: (f) => f.person.lastName(),
  fullName: (f) => f.person.fullName(),
  name: (f) => f.person.fullName(),
  email: (f) => f.internet.email(),
  username: (f) => f.internet.username(),
  phone: (f) => f.phone.number(),
  date: (f) => f.date.past().toISOString().slice(0, 10),
  datetime: (f) => f.date.past().toISOString(),
  birthdate: (f) => f.date.birthdate().toISOString().slice(0, 10),
  age: (f) => f.number.int({ min: 18, max: 90 }),
  address: (f) => f.location.streetAddress(),
  street: (f) => f.location.streetAddress(),
  city: (f) => f.location.city(),
  state: (f) => f.location.state(),
  zip: (f) => f.location.zipCode(),
  postalCode: (f) => f.location.zipCode(),
  country: (f) => f.location.country(),
  company: (f) => f.company.name(),
  jobTitle: (f) => f.person.jobTitle(),
  uuid: (f) => f.string.uuid(),
  id: (f) => f.string.uuid(),
  integer: (f, o) => f.number.int({ min: o.min ?? 1, max: o.max ?? 100000 }),
  number: (f, o) => f.number.int({ min: o.min ?? 1, max: o.max ?? 100000 }),
  decimal: (f, o) => f.number.float({ min: o.min ?? 0, max: o.max ?? 10000, fractionDigits: 2 }),
  float: (f, o) => f.number.float({ min: o.min ?? 0, max: o.max ?? 10000, fractionDigits: 2 }),
  boolean: (f) => f.datatype.boolean(),
  price: (f) => f.commerce.price(),
  product: (f) => f.commerce.productName(),
  word: (f) => f.lorem.word(),
  sentence: (f) => f.lorem.sentence(),
  url: (f) => f.internet.url(),
  ip: (f) => f.internet.ip(),
  gender: (f) => f.person.sex(),
  color: (f) => f.color.human(),
}

export function fieldTypeList() { return Object.keys(TYPES) }

function genRows(fields, count, locale) {
  const f = locale === 'en' ? fakerEN : fakerES_MX
  const rows = []
  for (let i = 0; i < count; i++) {
    const row = {}
    for (const fld of fields) {
      const fn = TYPES[fld.type]
      row[fld.name] = fn ? fn(f, fld) : ''
    }
    rows.push(row)
  }
  return rows
}

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function toCSV(cols, rows) {
  const head = cols.map(csvEscape).join(',')
  const body = rows.map(r => cols.map(c => csvEscape(r[c])).join(',')).join('\r\n')
  return '﻿' + head + '\r\n' + body
}
async function toXlsx(path, cols, rows) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Datos')
  ws.columns = cols.map(c => ({ header: c, key: c, width: 18 }))
  ws.addRows(rows)
  ws.getRow(1).font = { bold: true }
  await wb.xlsx.writeFile(path)
}

export function registerFakerTools(server) {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

  server.tool(
    'faker_field_types',
    'Lista los tipos de campo disponibles para faker_generate (datos falsos sin GenRocket).',
    {},
    async () => ok('Tipos disponibles:\n' + fieldTypeList().join(', ')),
  )

  server.tool(
    'faker_generate',
    'Genera datos FALSOS rápidos con Faker (SIN GenRocket, sin login ni config) y los exporta a JSON, CSV o Excel. Ideal para datos desechables de prueba. Define "fields" (lista de {name, type}) con tipos de faker_field_types; "count" filas; "format" json|csv|xlsx.',
    {
      fields: z.array(z.object({
        name: z.string(),
        type: z.string().describe('Tipo (ver faker_field_types), ej. firstName, email, date, integer'),
        min: z.number().optional(),
        max: z.number().optional(),
      })).describe('Columnas a generar'),
      count: z.number().int().positive().max(100000).optional().describe('Filas (default 10)'),
      format: z.enum(['json', 'csv', 'xlsx']).optional().describe('Formato de salida (default json)'),
      locale: z.enum(['es', 'en']).optional().describe('Idioma de los datos (default es = México)'),
      fileName: z.string().optional().describe('Nombre del archivo (opcional)'),
    },
    async ({ fields, count = 10, format = 'json', locale = 'es', fileName }) => {
      try {
        if (!fields?.length) { return bad('Define al menos un campo en "fields".') }
        const unknown = fields.filter(f => !TYPES[f.type]).map(f => f.type)
        if (unknown.length) { return bad(`Tipos no soportados: ${[...new Set(unknown)].join(', ')}. Usa faker_field_types.`) }
        const cols = fields.map(f => f.name)
        const rows = genRows(fields, count, locale)
        await mkdir(OUTDIR, { recursive: true })
        const base = (fileName || `fake_${count}`).replace(/[^\w.-]/g, '_').replace(/\.(json|csv|xlsx)$/i, '')
        const path = join(OUTDIR, `${base}.${format}`)

        if (format === 'json') { await writeFile(path, JSON.stringify(rows, null, 2), 'utf8') }
        else if (format === 'csv') { await writeFile(path, toCSV(cols, rows), 'utf8') }
        else { await toXlsx(path, cols, rows) }

        const preview = rows.slice(0, 5)
        const previewText = format === 'xlsx'
          ? cols.join(' | ') + '\n' + preview.map(r => cols.map(c => r[c]).join(' | ')).join('\n')
          : JSON.stringify(preview, null, format === 'json' ? 2 : 0)
        return ok(`Generadas ${rows.length} filas (${format.toUpperCase()}).\nArchivo: ${path}\n\nVista previa (5):\n${previewText}`)
      } catch (e) { return bad(`faker_generate: ${e.message}`) }
    },
  )
}
