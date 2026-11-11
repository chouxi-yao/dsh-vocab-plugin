#!/usr/bin/env node
// Build the review deck for 词场 Vocab.
//
// Source of truth is 原始资料/ — READ ONLY. This script only reads it and
// derives data/deck.json:
//   - real CET4 / CET6 headwords (one entry per word, per-book duplicates merged)
//   - IPA + an English example sentence, from dictionaryapi.dev, baked in at
//     build time so the card never needs the network at runtime
//   - falls back to the book's own 词组 (phrases) when the dictionary has no example
//
// Usage: node scripts/build-deck.mjs <cet4.json> <cet6.json> [--count N]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = process.argv.slice(2)
const countArg = args.indexOf('--count')
const PER_BOOK = countArg >= 0 ? Number(args[countArg + 1]) : 40
const REQUIRE_IPA = args.includes('--require-ipa')
const SOURCES = [
  { level: 'cet4', path: args[0] },
  { level: 'cet6', path: args[1] },
]

/** Deterministic RNG so the deck is reproducible build to build. */
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clean = (s) =>
  typeof s === 'string'
    ? s
        .replace(/\s+/g, ' ')
        .replace(/[\u0000-\u001f]/g, '')
        .trim()
    : ''

/** Merge one book into word → entry (same headword with several POS rows). */
function collect(rows, level, out) {
  for (const row of rows) {
    const word = clean(row?.word)
    if (!word || !/^[A-Za-z][A-Za-z' .-]*$/.test(word)) continue
    const key = `${level}|${word.toLowerCase()}`
    let entry = out.get(key)
    if (!entry) {
      entry = { k: key, w: word, level, pos: [], zh: [], phrases: [] }
      out.set(key, entry)
    }
    for (const t of Array.isArray(row.translations) ? row.translations : []) {
      const zh = clean(t?.translation)
      const pos = clean(t?.type)
      if (zh && !entry.zh.includes(zh)) entry.zh.push(zh)
      if (pos && !entry.pos.includes(pos)) entry.pos.push(pos)
    }
    for (const p of Array.isArray(row.phrases) ? row.phrases : []) {
      const phrase = clean(p?.phrase)
      const zh = clean(p?.translation)
      if (phrase && entry.phrases.length < 4) entry.phrases.push({ phrase, zh })
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** word → already-known lookup result, so rebuilds only fetch what they lack. */
const cache = new Map()

async function loadCache() {
  try {
    const deck = JSON.parse(await readFile(join(root, 'data', 'deck.json'), 'utf8'))
    for (const card of deck.cards ?? []) {
      if (card?.w) cache.set(card.w.toLowerCase(), { ipa: card.ipa ?? '', example: card.ex ?? '', pos: card.pos ?? '' })
    }
    console.log(`cache: ${cache.size} previous lookups`)
  } catch {
    // first build — no cache yet
  }
}

/** Ask dictionaryapi.dev for IPA + example; null when unavailable. */
async function lookup(word, signal) {
  const key = word.toLowerCase()
  if (cache.has(key)) return cache.get(key)
  if (process.argv.includes("--refresh")) cache.delete(key)
  try {
    let res
    // The free endpoint fronts Cloudflare and answers 429/530 when hammered,
    // so retry with backoff instead of dropping the word.
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
        { signal },
      )
      if (res.ok) break
      if (res.status !== 429 && res.status < 500) return null
      await sleep(1200 * (attempt + 1))
    }
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data) || !data.length) return null
    const first = data[0]
    let ipa = clean(first.phonetic)
    if (!ipa) {
      const withText = (first.phonetics ?? []).find((p) => clean(p?.text))
      ipa = clean(withText?.text)
    }
    let example = ''
    let pos = ''
    for (const meaning of first.meanings ?? []) {
      for (const def of meaning.definitions ?? []) {
        const ex = clean(def?.example)
        if (ex && ex.split(' ').length >= 4) {
          example = ex
          pos = clean(meaning.partOfSpeech)
          break
        }
      }
      if (example) break
    }
    const found = ipa || example ? { ipa, example, pos } : null
    cache.set(key, found)
    return found
  } catch {
    return null
  }
}

async function poolWork(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

async function main() {
  const words = new Map()
  for (const source of SOURCES) {
    const raw = JSON.parse(await readFile(source.path, 'utf8'))
    collect(Array.isArray(raw) ? raw : [], source.level, words)
    console.log(`${source.level}: ${raw.length} rows → merged`)
  }

  const all = [...words.values()].filter((w) => w.zh.length > 0)
  console.log(`unique headwords: ${all.length}`)

  const picked = []
  for (const level of ['cet4', 'cet6']) {
    const rand = mulberry32(level === 'cet4' ? 0x5104 : 0x5106)
    const pool = all.filter((w) => w.level === level && w.w.length >= 4 && w.w.length <= 12)
    // Fisher-Yates on the book order, then take the head of the shuffle.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    picked.push(...pool.slice(0, PER_BOOK))
  }

  await loadCache()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 180_000)
  let ok = 0
  const cards = await poolWork(picked, 1, async (entry, i) => {
    const extra = await lookup(entry.w, ac.signal)
    await sleep(350)
    if (extra?.ipa) ok++
    if (i % 10 === 0) console.log(`  looked up ${i + 1}/${picked.length} (${ok} with IPA)`)
    const phraseExample = entry.phrases[0]
    return {
      k: entry.k,
      w: entry.w,
      level: entry.level,
      ipa: extra?.ipa || '',
      pos: entry.pos.join(' ') || clean(extra?.pos),
      zh: entry.zh.slice(0, 3).join('；'),
      ex: extra?.example || phraseExample?.phrase || '',
      exZh: extra?.example ? '' : phraseExample?.zh || '',
    }
  })
  clearTimeout(timer)

  const usable = REQUIRE_IPA ? cards.filter((c) => c.ipa) : cards.slice()
  if (REQUIRE_IPA) console.log(`require-ipa: ${cards.length} → ${usable.length} cards`)
  cards.length = 0
  cards.push(...usable)
  cards.sort((a, b) => (a.level === b.level ? 0 : a.level === 'cet4' ? -1 : 1))
  const deck = { version: 1, builtFrom: SOURCES.map((s) => s.path), cards }
  const outDir = join(root, 'data')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, 'deck.json')
  await writeFile(outPath, JSON.stringify(deck), 'utf8')

  const bytes = JSON.stringify(deck).length
  const digest = createHash('sha256').update(JSON.stringify(deck)).digest('hex').slice(0, 12)
  console.log(
    `\n✔ wrote ${cards.length} cards (${ok} with IPA) → data/deck.json ` +
      `(${(bytes / 1024).toFixed(1)} KB, sha ${digest})`,
  )
  console.log(`  sample: ${cards.slice(0, 3).map((c) => `${c.w} ${c.ipa}`).join(' | ')}`)
  if (ok < cards.length) {
    console.log(`  note: ${cards.length - ok} cards have no IPA from the dictionary`)
  }
}

main().catch((error) => {
  console.error('build-deck failed:', error)
  process.exit(1)
})
