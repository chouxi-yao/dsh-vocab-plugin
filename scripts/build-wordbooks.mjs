#!/usr/bin/env node
// dsh-vocab-plugin / 词库派生
//
// 只读 `原始资料/` 里的 CET4 / CET6 顺序词库，派生出调度层要用的两份完整词表：
//
//   data/cet4.json   { deck:"cet4", builtFrom, words:[{ id, w, y, p, ipa?, ex? }] }
//   data/cet6.json   同上
//
// 规则：
//   * 按小写词形合并（原书同一 headword 按词性分多行），保留首见顺序；
//   * 释义去重后以 `；` 连接，词性同样去重；
//   * 若 `data/deck.json`（富化卡）里已有该词的音标/例句，就并进来。
//
// 用法：node scripts/build-wordbooks.mjs <cet4.json> <cet6.json> [deck.json]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const [, , cet4Path, cet6Path, deckPathArg] = process.argv
if (!cet4Path || !cet6Path) {
  console.error('usage: node scripts/build-wordbooks.mjs <3-CET4-顺序.json> <4-CET6-顺序.json> [data/deck.json]')
  process.exit(1)
}

const outDir = resolve(process.cwd(), 'data')
const deckPath = deckPathArg ? resolve(deckPathArg) : join(outDir, 'deck.json')

async function readEnrichment() {
  try {
    const raw = JSON.parse(await readFile(deckPath, 'utf8'))
    const map = new Map()
    for (const card of raw.cards ?? []) {
      if (typeof card?.k !== 'string') continue
      map.set(card.k, { ipa: card.ipa || undefined, ex: card.ex || undefined })
    }
    return map
  } catch {
    return new Map()
  }
}

function uniqueOrdered(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function derive(rows, deck, enrichment) {
  const byId = new Map()
  for (const row of rows) {
    const w = typeof row?.word === 'string' ? row.word.trim() : ''
    if (!w) continue
    const id = w.toLowerCase()
    const translations = Array.isArray(row.translations) ? row.translations : []
    let entry = byId.get(id)
    if (entry === undefined) {
      entry = { id, w, y: [], p: [] }
      byId.set(id, entry)
    }
    for (const translation of translations) {
      if (typeof translation?.translation === 'string') {
        for (const piece of translation.translation.split(/[，,；;、]/)) entry.y.push(piece)
      }
      if (typeof translation?.type === 'string') entry.p.push(translation.type)
    }
  }
  const words = []
  for (const entry of byId.values()) {
    const extra = enrichment.get(`${deck}|${entry.id}`) ?? {}
    const word = {
      id: entry.id,
      w: entry.w,
      y: uniqueOrdered(entry.y).join('，'),
    }
    const pos = uniqueOrdered(entry.p).join(' ')
    if (pos) word.p = pos
    if (extra.ipa) word.ipa = extra.ipa
    if (extra.ex) word.ex = extra.ex
    words.push(word)
  }
  return words
}

const enrichment = await readEnrichment()
const cet4Rows = JSON.parse(await readFile(resolve(cet4Path), 'utf8'))
const cet6Rows = JSON.parse(await readFile(resolve(cet6Path), 'utf8'))

await mkdir(outDir, { recursive: true })

for (const [deck, rows, source] of [
  ['cet4', cet4Rows, resolve(cet4Path)],
  ['cet6', cet6Rows, resolve(cet6Path)],
]) {
  const words = derive(rows, deck, enrichment)
  const payload = {
    deck,
    builtFrom: source.split('/').slice(-2).join('/'),
    sourceRows: Array.isArray(rows) ? rows.length : 0,
    count: words.length,
    enriched: words.filter((word) => word.ipa).length,
    words,
  }
  const file = join(outDir, `${deck}.json`)
  await writeFile(file, `${JSON.stringify(payload)}\n`, 'utf8')
  console.log(
    `${deck}: sourceRows=${payload.sourceRows} unique=${words.length} enriched=${payload.enriched} -> ${file} (${(
        Buffer.byteLength(JSON.stringify(payload)) / 1024
      ).toFixed(0)} KB)`,
  )
}

void dirname
