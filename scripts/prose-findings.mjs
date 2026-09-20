#!/usr/bin/env node
/**
 * Scratch helper: print prose-lint findings of one kind, with the real source
 * line, so a fix can be reviewed in bulk. Not part of the repo's checks.
 *
 *   node scripts/prose-findings.mjs hedge
 *   node scripts/prose-findings.mjs slash-or SPEC.md
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const [kind, ...only] = process.argv.slice(2)
const ROOT = process.cwd()
const SKIP = new Set(['node_modules', 'dist', '.git'])

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (name.endsWith('.md') && !/CHANGELOG\.md$/.test(p)) acc.push(p)
  }
  return acc
}

const files = only.length ? only.map((p) => join(ROOT, p)) : walk(ROOT)
let n = 0
for (const abs of files) {
  const rel = relative(ROOT, abs).split(sep).join('/')
  let out = ''
  try {
    out = execFileSync('node', [join(ROOT, 'scripts/prose-lint.mjs'), rel, '--verbose'], {
      encoding: 'utf8',
    })
  } catch {
    continue
  }
  const src = readFileSync(abs, 'utf8').split(/\r?\n/)
  for (const line of out.split('\n')) {
    const m = line.match(/^\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m || m[2] !== kind) continue
    n++
    console.log(`\n${rel}:${m[1]}  [${m[3]}]`)
    console.log(`  ${(src[Number(m[1]) - 1] || '').trim()}`)
  }
}
console.log(`\n${n} ${kind} finding(s)`)
