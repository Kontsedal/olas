#!/usr/bin/env tsx
/**
 * Wiki linter — checks .wiki/ for staleness, broken citations, orphans.
 *
 * Run: pnpm wiki:lint
 *
 * Exit code: 0 if only warnings, 1 if any errors.
 *
 * Checks performed:
 *   1. every page has the required frontmatter fields
 *   2. every `covers:` path exists; if it has a `:start-end` range, the
 *      file is long enough
 *   3. every `edges:` target exists (path resolved relative to the page)
 *   4. orphans — pages not linked from index.md or any other page
 *   5. staleness — pages with `last_verified` older than STALENESS_DAYS
 *   6. covered files modified more recently than the page's last_verified
 *
 * Not yet implemented (deferred until needed):
 *   - candidate-promotion suggestions
 *   - contradiction detection between pages
 *   - confidence-decay
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const REPO_ROOT = resolve(__dirname, '..')
const WIKI_DIR = join(REPO_ROOT, '.wiki')
const STALENESS_DAYS = 60

type Severity = 'error' | 'warn'
type Issue = { severity: Severity; page: string; message: string }

type Frontmatter = {
  name?: string
  description?: string
  type?: string
  covers?: string[]
  edges?: Array<{ type: string; target: string }>
  last_verified?: string
  confidence?: string
}

type Page = {
  /** path relative to repo root, e.g. ".wiki/modules/query.md" */
  path: string
  /** absolute path */
  abs: string
  frontmatter: Frontmatter | null
  body: string
  parseError?: string
}

const issues: Issue[] = []
const error = (page: string, message: string) => issues.push({ severity: 'error', page, message })
const warn = (page: string, message: string) => issues.push({ severity: 'warn', page, message })

function walkMarkdown(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function parsePage(abs: string): Page {
  const relPath = relative(REPO_ROOT, abs)
  const raw = readFileSync(abs, 'utf8')
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { path: relPath, abs, frontmatter: null, body: raw }
  }
  let fm: Frontmatter | null = null
  try {
    fm = parseYaml(match[1]!) as Frontmatter
  } catch (err) {
    return {
      path: relPath,
      abs,
      frontmatter: null,
      body: match[2] ?? '',
      parseError: (err as Error).message,
    }
  }
  return { path: relPath, abs, frontmatter: fm, body: match[2] ?? '' }
}

const FRONTMATTERLESS = new Set(['.wiki/index.md', '.wiki/log.md'])

function lintFrontmatter(page: Page): void {
  if (page.parseError) {
    error(page.path, `YAML frontmatter failed to parse: ${page.parseError}`)
    return
  }
  // Meta files (index, log, candidates/README) are exempt from frontmatter.
  if (page.frontmatter == null) {
    if (!page.path.endsWith('/README.md') && !FRONTMATTERLESS.has(page.path)) {
      warn(page.path, 'no frontmatter — every authoritative page should have one')
    }
    return
  }
  const fm = page.frontmatter
  for (const field of ['name', 'description', 'type', 'last_verified', 'confidence'] as const) {
    if (fm[field] == null) error(page.path, `frontmatter missing required field: ${field}`)
  }
  if (fm.confidence != null && !['high', 'medium', 'candidate'].includes(fm.confidence)) {
    error(page.path, `confidence must be one of high|medium|candidate (got "${fm.confidence}")`)
  }
  if (fm.last_verified != null && !/^\d{4}-\d{2}-\d{2}$/.test(fm.last_verified)) {
    error(page.path, `last_verified must be ISO date YYYY-MM-DD (got "${fm.last_verified}")`)
  }
}

function lintCovers(page: Page): void {
  const covers = page.frontmatter?.covers
  if (!covers) return
  for (const entry of covers) {
    const [filePart, rangePart] = entry.split(':')
    if (!filePart) continue
    const filePath = join(REPO_ROOT, filePart)
    if (!existsSync(filePath)) {
      error(page.path, `covers: "${entry}" — file does not exist`)
      continue
    }
    if (rangePart) {
      // Accept either "N-M" (range) or "N" (single line).
      const range = rangePart.match(/^(\d+)-(\d+)$/)
      const single = rangePart.match(/^(\d+)$/)
      let start: number
      let end: number
      if (range) {
        start = Number.parseInt(range[1]!, 10)
        end = Number.parseInt(range[2]!, 10)
      } else if (single) {
        start = end = Number.parseInt(single[1]!, 10)
      } else {
        warn(page.path, `covers: "${entry}" — range must be "start-end" or "N"`)
        continue
      }
      if (start > end) {
        error(page.path, `covers: "${entry}" — start > end`)
        continue
      }
      const content = readFileSync(filePath, 'utf8')
      const lineCount = content.split('\n').length
      if (end > lineCount) {
        warn(
          page.path,
          `covers: "${entry}" — file has only ${lineCount} lines, range cites up to ${end}`,
        )
      }
    }
  }
}

function lintEdges(page: Page): void {
  const edges = page.frontmatter?.edges
  if (!edges) return
  const ALLOWED = ['uses', 'tested-by', 'supersedes', 'contradicts', 'documented-in', 'related']
  const pageDir = dirname(page.abs)
  for (const edge of edges) {
    if (!ALLOWED.includes(edge.type)) {
      warn(page.path, `edges: unknown type "${edge.type}" (allowed: ${ALLOWED.join(', ')})`)
    }
    if (!edge.target) {
      error(page.path, 'edges: entry missing target')
      continue
    }
    const target = resolve(pageDir, edge.target)
    if (!existsSync(target)) {
      error(
        page.path,
        `edges: target "${edge.target}" not found (resolved to ${relative(REPO_ROOT, target)})`,
      )
    }
  }
}

function lintStaleness(page: Page): void {
  const lv = page.frontmatter?.last_verified
  if (!lv) return
  const verified = new Date(lv)
  if (Number.isNaN(verified.getTime())) return
  const ageDays = (Date.now() - verified.getTime()) / 86_400_000
  if (ageDays > STALENESS_DAYS) {
    warn(
      page.path,
      `last_verified is ${Math.floor(ageDays)} days old (threshold: ${STALENESS_DAYS})`,
    )
  }
}

function lintCoveredFilesChanged(page: Page): void {
  const fm = page.frontmatter
  if (!fm?.last_verified || !fm.covers) return
  const verified = new Date(fm.last_verified)
  if (Number.isNaN(verified.getTime())) return
  for (const entry of fm.covers) {
    const filePart = entry.split(':')[0]
    if (!filePart) continue
    const filePath = join(REPO_ROOT, filePart)
    if (!existsSync(filePath)) continue
    try {
      const out = execSync(`git log -1 --format=%cI -- ${JSON.stringify(filePart)}`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (!out) continue
      const fileMtime = new Date(out)
      if (fileMtime.getTime() > verified.getTime() + 86_400_000) {
        warn(
          page.path,
          `covers ${filePart} was last modified ${out.slice(0, 10)} > last_verified ${fm.last_verified}`,
        )
      }
    } catch {
      /* file maybe never committed yet */
    }
  }
}

function findOrphans(pages: Page[]): void {
  // Build a set of pages that are linked-to (by edges or by index.md body links).
  const linkedTo = new Set<string>()
  const indexAbs = join(WIKI_DIR, 'index.md')

  for (const page of pages) {
    const edges = page.frontmatter?.edges
    if (edges) {
      for (const edge of edges) {
        if (!edge.target) continue
        const target = resolve(dirname(page.abs), edge.target)
        linkedTo.add(target)
      }
    }
    // Also scan body for markdown links to other .wiki/ pages.
    const linkRe = /\]\(([^)]+\.md)\)/g
    for (const m of page.body.matchAll(linkRe)) {
      const target = resolve(dirname(page.abs), m[1]!)
      linkedTo.add(target)
    }
  }

  for (const page of pages) {
    if (page.abs === indexAbs) continue
    if (page.path.endsWith('/README.md')) continue
    if (page.path === '.wiki/log.md') continue
    if (!linkedTo.has(page.abs)) {
      warn(page.path, 'orphan — not linked from index.md or any other page')
    }
  }
}

function main(): void {
  if (!existsSync(WIKI_DIR)) {
    console.error(`[wiki-lint] .wiki/ directory not found at ${WIKI_DIR}`)
    process.exit(2)
  }

  const files = walkMarkdown(WIKI_DIR)
  const pages = files.map(parsePage)

  for (const page of pages) {
    lintFrontmatter(page)
    lintCovers(page)
    lintEdges(page)
    lintStaleness(page)
    lintCoveredFilesChanged(page)
  }
  findOrphans(pages)

  // Report.
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warn')

  const byPage = new Map<string, Issue[]>()
  for (const issue of issues) {
    const arr = byPage.get(issue.page) ?? []
    arr.push(issue)
    byPage.set(issue.page, arr)
  }

  const sortedPages = [...byPage.keys()].sort()
  for (const p of sortedPages) {
    const list = byPage.get(p)!
    console.error(`\n${posix.normalize(p)}`)
    for (const issue of list) {
      const tag = issue.severity === 'error' ? 'ERROR' : 'warn '
      console.error(`  [${tag}] ${issue.message}`)
    }
  }

  console.error(
    `\n[wiki-lint] ${pages.length} pages scanned · ${errors.length} error(s) · ${warnings.length} warning(s)`,
  )
  process.exit(errors.length > 0 ? 1 : 0)
}

main()
