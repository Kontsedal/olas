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
 *   7. drifted body citations (a warning). For each `path:N` or `path:N-M`
 *      in a page body (log.md excepted), the cited range, give or take
 *      CITATION_SLACK lines, must contain at least one identifier the same
 *      sentence names in backticks. A short path (`entry.ts:12`) resolves
 *      through the page's `covers:`, then through a unique path suffix among
 *      the source files. Fenced code is skipped, and so is a sentence that
 *      names no identifier. Spans that are paths, file names or shell
 *      commands name nothing, and neither do keywords, words under three
 *      characters or the name of a file the sentence cites. A sentence that
 *      cites two files passes each citation on any identifier it names, and
 *      a table row counts as one sentence. The check also warns on a citation
 *      into a missing file or past a file's end. It cannot see a range that
 *      drifted onto other code naming the same identifier.
 *
 * Not automated, by design: candidate promotion, contradiction detection
 * between pages and confidence decay need judgment, so CLAUDE.md lists them
 * as manual lint passes.
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
  /** 1-based line of the page file on which `body` starts */
  bodyLine: number
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
  // Normalize to posix separators so the `.wiki/…` path comparisons below
  // (FRONTMATTERLESS set, `/README.md` suffix checks) work on Windows, where
  // `relative()` yields backslash paths.
  const relPath = relative(REPO_ROOT, abs).replaceAll('\\', '/')
  const raw = readFileSync(abs, 'utf8')
  // CRLF-tolerant: on a CRLF checkout (Windows, `core.autocrlf=true`) the
  // frontmatter delimiters are `---\r\n`, so an LF-only regex reads every page
  // as frontmatter-less and silently disables all downstream checks.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { path: relPath, abs, frontmatter: null, body: raw.replace(/\r\n/g, '\n'), bodyLine: 1 }
  }
  // Normalize line endings before YAML parse and any line-count logic downstream.
  const fmBlock = match[1]!.replace(/\r\n/g, '\n')
  const body = (match[2] ?? '').replace(/\r\n/g, '\n')
  const bodyLine = raw.slice(0, raw.length - (match[2] ?? '').length).split('\n').length
  let fm: Frontmatter | null = null
  try {
    fm = parseYaml(fmBlock) as Frontmatter
  } catch (err) {
    return {
      path: relPath,
      abs,
      frontmatter: null,
      body,
      bodyLine,
      parseError: (err as Error).message,
    }
  }
  return { path: relPath, abs, frontmatter: fm, body, bodyLine }
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

// --- 7. drifted body citations ---------------------------------------------
//
// A `path:N-M` citation in a page body goes stale without breaking: when code
// above it grows, the range still exists but now points at something else.
// The heuristic: the backticked identifiers in the citation's sentence are
// what the sentence talks about, so the cited range (give or take
// CITATION_SLACK lines) should contain at least one of them.

/** Lines of slack on each side of a cited range. */
const CITATION_SLACK = 2
/** Directories whose source files a short citation (`entry.ts:12`) can name. */
const SOURCE_DIRS = ['packages', 'scripts', 'examples']
const SOURCE_EXT = 'ts|tsx|mts|cts|js|mjs|cjs|vue|svelte'
/** `path:N`, `path:N-M`, and `path:N-M, P-Q` lists. */
const CITATION_RE = new RegExp(
  `([\\w@./-]*[\\w-]\\.(?:${SOURCE_EXT})):(\\d+(?:-\\d+)?(?:,\\s*\\d+(?:-\\d+)?)*)`,
  'g',
)
/** A backticked span that is a path or file name, not an identifier. */
const PATH_SPAN_RE = /^[\w@.~/-]+$/
const FILE_EXT_RE = /\.(?:md|json|ya?ml|css|html|ts|tsx|mts|cts|js|mjs|cjs|vue|svelte)$/
/** A backticked span that is a shell command. */
const COMMAND_SPAN_RE = /^(?:pnpm|npm|npx|yarn|git|node|tsx|vitest)\s/
/** A backticked span that is one kebab-case word (`'latest-wins'`, `vue-tasks`). */
const KEBAB_SPAN_RE = /^['"]?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"]?$/
/** Keywords, primitive types and English words: they match any range, so they prove nothing. */
const COMMON_WORDS = new Set([
  'and',
  'any',
  'async',
  'await',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'implements',
  'import',
  'interface',
  'keyof',
  'let',
  'never',
  'new',
  'not',
  'null',
  'number',
  'object',
  'readonly',
  'return',
  'string',
  'switch',
  'the',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unknown',
  'var',
  'void',
  'while',
  'yield',
])
/** Abbreviations whose trailing period does not end a sentence. */
const ABBREVIATION_RE = /(?:\b(?:e\.g|i\.e|vs|cf|approx)\.)$/

let sourceFiles: string[] | null = null
/** Every source file under SOURCE_DIRS, as a posix path relative to the repo root. */
function listSourceFiles(): string[] {
  if (sourceFiles) return sourceFiles
  const out: string[] = []
  const ext = new RegExp(`\\.(?:${SOURCE_EXT})$`)
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage')
        continue
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (ext.test(entry.name)) out.push(relative(REPO_ROOT, full).replaceAll('\\', '/'))
    }
  }
  for (const dir of SOURCE_DIRS) {
    if (existsSync(join(REPO_ROOT, dir))) walk(join(REPO_ROOT, dir))
  }
  sourceFiles = out
  return out
}

/**
 * Resolve a cited path to a repo-relative posix path. Tries, in order: the
 * repo root, the page's own directory, the page's `covers:` entries, and every
 * source file. The last two match by path suffix, so `entry.ts` and
 * `query/entry.ts` both work while they are unique. Returns `null` when no file
 * matches, and `'ambiguous'` when several do.
 */
function resolveCitation(page: Page, file: string): string | 'ambiguous' | null {
  const fromRoot = join(REPO_ROOT, file)
  if (existsSync(fromRoot)) return relative(REPO_ROOT, fromRoot).replaceAll('\\', '/')
  const fromPage = resolve(dirname(page.abs), file)
  if (existsSync(fromPage)) return relative(REPO_ROOT, fromPage).replaceAll('\\', '/')
  const bySuffix = (paths: string[]): string[] => [
    ...new Set(paths.filter((p) => p === file || p.endsWith(`/${file}`))),
  ]
  const covered = bySuffix((page.frontmatter?.covers ?? []).map((c) => c.split(':')[0]!))
  if (covered.length === 1) return covered[0]!
  const anywhere = bySuffix(listSourceFiles())
  if (anywhere.length === 1) return anywhere[0]!
  return anywhere.length > 1 ? 'ambiguous' : null
}

type TextUnit = { text: string; line: number }

/**
 * Split a page body into the units a citation's sentence is looked up in:
 * paragraphs, list items, table rows and headings, each joined onto one line.
 * Fenced code is dropped.
 */
function textUnits(page: Page): TextUnit[] {
  const units: TextUnit[] = []
  let current: TextUnit | null = null
  let fence: string | null = null
  const flush = (): void => {
    if (current) units.push(current)
    current = null
  }
  page.body.split('\n').forEach((raw, i) => {
    const line = page.bodyLine + i
    const fenceMatch = raw.match(/^\s*(`{3,}|~{3,})/)
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) fence = null
      return
    }
    if (fenceMatch) {
      flush()
      fence = fenceMatch[1]!
      return
    }
    if (raw.trim() === '') {
      flush()
      return
    }
    const startsUnit = /^\s*(?:[-*+]\s|\d+[.)]\s|\||#)/.test(raw)
    if (startsUnit || current === null) {
      flush()
      current = { text: raw.trim(), line }
    } else {
      current.text += ` ${raw.trim()}`
    }
    // A table row or heading never continues onto the next line.
    if (/^\s*(?:\||#)/.test(raw)) flush()
  })
  flush()
  return units
}

/**
 * Split a unit into sentences, keeping `e.g.` and friends inside their
 * sentence. A table row stays whole: its first cell names what the last cell
 * cites.
 */
function sentences(text: string): string[] {
  if (text.startsWith('|')) return [text]
  const out: string[] = []
  for (const piece of text.split(/(?<=[.!?])\s+(?=[A-Z0-9`(*[_])/)) {
    const last = out.length - 1
    if (last >= 0 && ABBREVIATION_RE.test(out[last]!)) out[last] += ` ${piece}`
    else out.push(piece)
  }
  return out
}

/**
 * The identifiers a sentence names in backticks. Spans that are paths, file
 * names or shell commands are skipped, as are common words, words under three
 * characters and the stems of files the sentence cites. A kebab-case span is
 * kept whole, as a literal.
 */
function sentenceIdentifiers(sentence: string, citedFiles: string[]): string[] {
  const fileStems = new Set(citedFiles.map((f) => f.replace(/^.*\//, '').replace(/\..*$/, '')))
  const out = new Set<string>()
  for (const [, span] of sentence.matchAll(/`([^`\n]+)`/g)) {
    const text = span!.replace(CITATION_RE, ' ').trim()
    if (text === '' || COMMAND_SPAN_RE.test(text)) continue
    if (PATH_SPAN_RE.test(text) && (text.includes('/') || FILE_EXT_RE.test(text))) continue
    const kebab = text.match(KEBAB_SPAN_RE)
    const words = kebab ? [kebab[1]!] : (text.match(/[A-Za-z_$][\w$]*/g) ?? [])
    for (const word of words) {
      if (word.length < 3 || COMMON_WORDS.has(word) || fileStems.has(word)) continue
      out.add(word)
    }
  }
  return [...out]
}

const fileLines = new Map<string, string[]>()
function linesOf(path: string): string[] {
  let lines = fileLines.get(path)
  if (!lines) {
    lines = readFileSync(join(REPO_ROOT, path), 'utf8').replace(/\r\n/g, '\n').split('\n')
    fileLines.set(path, lines)
  }
  return lines
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

let citationsChecked = 0

function lintBodyCitations(page: Page): void {
  if (page.path === '.wiki/log.md') return // history: its citations describe the code as it was
  for (const unit of textUnits(page)) {
    for (const sentence of sentences(unit.text)) {
      const cites = [...sentence.matchAll(CITATION_RE)]
      if (cites.length === 0) continue
      const idents = sentenceIdentifiers(
        sentence,
        cites.map((m) => m[1]!),
      )
      for (const [cited, file, ranges] of cites) {
        const path = resolveCitation(page, file!)
        if (path === 'ambiguous') continue
        if (path === null) {
          warn(page.path, `line ${unit.line}: citation "${cited}" — no such file`)
          continue
        }
        const lines = linesOf(path)
        for (const range of ranges!.split(/,\s*/)) {
          const [a, b] = range.split('-')
          const start = Number(a)
          const end = b === undefined ? start : Number(b)
          const label = `${file}:${range}`
          if (end > lines.length || start > end) {
            warn(
              page.path,
              `line ${unit.line}: citation "${label}" — ${path} has ${lines.length} lines`,
            )
            continue
          }
          if (idents.length === 0) continue
          citationsChecked += 1
          const text = lines
            .slice(Math.max(0, start - 1 - CITATION_SLACK), end + CITATION_SLACK)
            .join('\n')
          // `\$?`: a page names `topLevelErrors`, the code holds it in `topLevelErrors$`.
          const hit = idents.some((w) =>
            new RegExp(`(?<![\\w$])${escapeRegExp(w)}\\$?(?![\\w$])`).test(text),
          )
          if (!hit) {
            warn(
              page.path,
              `line ${unit.line}: citation "${label}" — range names none of: ${idents.slice(0, 5).join(', ')}`,
            )
          }
        }
      }
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
    lintBodyCitations(page)
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
    `\n[wiki-lint] ${pages.length} pages scanned · ${citationsChecked} citation(s) checked · ${errors.length} error(s) · ${warnings.length} warning(s)`,
  )
  process.exit(errors.length > 0 ? 1 : 0)
}

main()
