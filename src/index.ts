#!/usr/bin/env node
import { binary, command, positional, run } from 'cmd-ts'
import { File } from 'cmd-ts/batteries/fs'
import { existsSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Diagnostic, Statement } from 'typescript'

type TypeScript = typeof import('typescript')

export interface GeneratedMarkdown {
  declaration: string
  inputFile: string
  markdown: string
  outputFile: string
}

export interface GenerateMarkdownOptions {
  cwd?: string
}

interface TsDocTag {
  name: string
  text: string
}

interface TsDoc {
  body: string
  tags: TsDocTag[]
}

export async function generateMarkdownForModule(
  modulePath: string,
  options: GenerateMarkdownOptions = {},
): Promise<GeneratedMarkdown> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const inputFile = resolve(cwd, modulePath)
  assertTypeScriptModule(inputFile)

  const ts = loadWorkspaceTypescript(cwd)
  const declaration = compileDeclaration(ts, inputFile, cwd)
  const markdown = declarationToMarkdown(ts, declaration, inputFile)
  const outputFile = getMarkdownPath(inputFile)

  await writeFile(outputFile, markdown)

  return {
    declaration,
    inputFile,
    markdown,
    outputFile,
  }
}

export function findNearestTypescript(startDir = process.cwd()) {
  let dir = resolve(startDir)

  while (true) {
    const candidate = join(dir, 'node_modules', 'typescript')
    if (isDirectory(candidate) && existsSync(join(candidate, 'package.json'))) {
      return candidate
    }

    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not find node_modules/typescript from ${startDir}`)
    }
    dir = parent
  }
}

function loadWorkspaceTypescript(cwd = process.cwd()): TypeScript {
  const typescriptDir = findNearestTypescript(cwd)
  const require = createRequire(join(typescriptDir, 'package.json'))
  return require('typescript') as TypeScript
}

function compileDeclaration(ts: TypeScript, inputFile: string, cwd = process.cwd()) {
  const options = getCompilerOptions(ts, cwd)
  const host = ts.createCompilerHost(options, true)
  const outputs = new Map<string, string>()
  let declaration: string | undefined

  host.writeFile = (fileName, text, _writeByteOrderMark, _onError, sourceFiles) => {
    outputs.set(resolve(fileName), text)

    if (sourceFiles?.some((sourceFile) => samePath(ts, sourceFile.fileName, inputFile))) {
      declaration = text
    }
  }

  const program = ts.createProgram([inputFile], options, host)
  throwOnDiagnostics(ts, ts.getPreEmitDiagnostics(program), cwd)

  const emitResult = program.emit(undefined, host.writeFile, undefined, true)
  throwOnDiagnostics(ts, emitResult.diagnostics, cwd)

  if (emitResult.emitSkipped) {
    throw new Error('TypeScript skipped declaration emit.')
  }

  declaration ??= [...outputs.values()].find((output) => output.trim().length > 0)

  if (!declaration) {
    throw new Error(`TypeScript did not emit a declaration for ${inputFile}`)
  }

  return declaration
}

function declarationToMarkdown(ts: TypeScript, declaration: string, inputFile: string) {
  const sourceFile = ts.createSourceFile('module.d.ts', declaration, ts.ScriptTarget.Latest, true)
  const exportsByLocalName = collectExports(ts, sourceFile)
  const hasExplicitExports = exportsByLocalName.size > 0
  const sections: string[] = [`# ${basename(inputFile)}`]

  for (const statement of sourceFile.statements) {
    const localName = getStatementName(ts, statement)
    if (!localName) continue

    const exportedName = exportsByLocalName.get(localName) ?? localName
    const isExported = hasExportModifier(ts, statement) || exportsByLocalName.has(localName)
    if (hasExplicitExports && !isExported) continue

    const code = declaration.slice(statement.getStart(sourceFile), statement.end).trim()
    const comment = getLeadingTsDoc(ts, declaration, statement)
    const docs = comment ? renderTsDoc(parseTsDoc(comment)) : ''

    sections.push(renderDeclarationSection(exportedName, docs, code))
  }

  return `${sections.join('\n\n').trimEnd()}\n`
}

function assertTypeScriptModule(inputFile: string) {
  if (!isFile(inputFile)) {
    throw new Error(`Module not found: ${inputFile}`)
  }

  const extension = extname(inputFile)
  if (!['.ts', '.mts', '.cts', '.tsx'].includes(extension)) {
    throw new Error(`Expected a TypeScript module, got ${inputFile}`)
  }
}

function getCompilerOptions(ts: TypeScript, cwd: string) {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists)
  const baseOptions = configPath ? readConfigOptions(ts, configPath, cwd) : {}

  return {
    ...baseOptions,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmit: false,
    noEmitOnError: true,
    outDir: undefined,
    sourceMap: false,
    skipLibCheck: true,
  }
}

function readConfigOptions(ts: TypeScript, configPath: string, cwd: string) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  throwOnDiagnostics(ts, config.error ? [config.error] : [], cwd)

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    {},
    configPath,
  )
  throwOnDiagnostics(ts, parsed.errors, cwd)

  return parsed.options
}

function throwOnDiagnostics(ts: TypeScript, diagnostics: readonly Diagnostic[], cwd: string) {
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length === 0) return

  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => cwd,
      getNewLine: () => '\n',
    }),
  )
}

function collectExports(ts: TypeScript, sourceFile: ReturnType<TypeScript['createSourceFile']>) {
  const exportsByLocalName = new Map<string, string>()

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    const clause = statement.exportClause
    if (!clause || !ts.isNamedExports(clause)) continue

    for (const element of clause.elements) {
      const localName = element.propertyName?.text ?? element.name.text
      exportsByLocalName.set(localName, element.name.text)
    }
  }

  return exportsByLocalName
}

function getStatementName(ts: TypeScript, statement: Statement) {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text ?? (hasDefaultModifier(ts, statement) ? 'default' : undefined)
  }

  if (ts.isClassDeclaration(statement)) {
    return statement.name?.text ?? (hasDefaultModifier(ts, statement) ? 'default' : undefined)
  }

  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name.text
  }

  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations[0]
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
  }
}

function hasExportModifier(ts: TypeScript, statement: Statement) {
  return hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)
}

function hasDefaultModifier(ts: TypeScript, statement: Statement) {
  return hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)
}

function hasModifier(ts: TypeScript, statement: Statement, kind: number) {
  if (!ts.canHaveModifiers(statement)) return false
  return ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind) ?? false
}

function getLeadingTsDoc(ts: TypeScript, text: string, statement: Statement) {
  const comments = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []

  for (const comment of comments.toReversed()) {
    const raw = text.slice(comment.pos, comment.end)
    if (raw.startsWith('/**')) return raw
  }
}

function parseTsDoc(comment: string): TsDoc {
  const lines = comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(normalizeTsDocLine)

  const body: string[] = []
  const tags: TsDocTag[] = []
  let currentTag: TsDocTag | undefined

  for (const line of trimBlankEdges(lines)) {
    const tag = line.match(/^@([a-zA-Z][\w-]*)(?:\s+(.*))?$/)

    if (tag) {
      currentTag = {
        name: tag[1],
        text: tag[2] ?? '',
      }
      tags.push(currentTag)
      continue
    }

    if (currentTag) {
      currentTag.text = [currentTag.text, line].filter(Boolean).join('\n')
    } else {
      body.push(line)
    }
  }

  return {
    body: trimBlankEdges(body).join('\n'),
    tags,
  }
}

function normalizeTsDocLine(line: string) {
  const withoutStar = line.replace(/^\s*\*\s?/, '')
  return (withoutStar.startsWith(' ') ? withoutStar.slice(1) : withoutStar).trimEnd()
}

function renderTsDoc(doc: TsDoc) {
  const blocks: string[] = []
  const params = doc.tags.filter((tag) => tag.name === 'param')
  const typeParams = doc.tags.filter((tag) => tag.name === 'typeParam' || tag.name === 'template')
  const returns = doc.tags.filter((tag) => tag.name === 'returns' || tag.name === 'return')
  const deprecated = doc.tags.find((tag) => tag.name === 'deprecated')
  const remarks = doc.tags.find((tag) => tag.name === 'remarks')
  const examples = doc.tags.filter((tag) => tag.name === 'example')

  if (deprecated) {
    blocks.push(`**Deprecated.** ${deprecated.text}`.trimEnd())
  }

  if (doc.body) {
    blocks.push(doc.body)
  }

  if (remarks?.text) {
    blocks.push(`**Remarks**\n\n${remarks.text}`)
  }

  if (typeParams.length > 0) {
    blocks.push(renderNamedTags('Type Parameters', typeParams))
  }

  if (params.length > 0) {
    blocks.push(renderNamedTags('Parameters', params))
  }

  if (returns.length > 0) {
    blocks.push(`**Returns**\n\n${returns.map((tag) => tag.text).join('\n\n')}`)
  }

  if (examples.length > 0) {
    blocks.push(`**Examples**\n\n${examples.map((tag) => tag.text).join('\n\n')}`)
  }

  return blocks.join('\n\n')
}

function renderNamedTags(title: string, tags: TsDocTag[]) {
  const lines = tags.map((tag) => {
    const match = tag.text.match(/^(\S+)(?:\s+-?\s*(.*))?$/s)
    if (!match) return `- ${tag.text}`

    const [, name, description = ''] = match
    return `- \`${name}\`${description ? `: ${description}` : ''}`
  })

  return `**${title}**\n\n${lines.join('\n')}`
}

function renderDeclarationSection(name: string, docs: string, code: string) {
  return [`## \`${name}\``, docs, `\`\`\`ts\n${code}\n\`\`\``].filter(Boolean).join('\n\n')
}

function getMarkdownPath(inputFile: string) {
  const extension = extname(inputFile)
  return `${inputFile.slice(0, -extension.length)}.md`
}

function trimBlankEdges(lines: string[]) {
  const trimmed = [...lines]

  while (trimmed[0] === '') {
    trimmed.shift()
  }

  while (trimmed.at(-1) === '') {
    trimmed.pop()
  }

  return trimmed
}

function samePath(ts: TypeScript, left: string, right: string) {
  const normalize = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string) => resolve(fileName)
    : (fileName: string) => resolve(fileName).toLowerCase()

  return normalize(left) === normalize(right)
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const app = command({
  name: 'exports-md',
  description: 'Generate Markdown docs next to a TypeScript module.',
  args: {
    module: positional({
      type: File,
      displayName: 'module.ts',
      description: 'TypeScript module to document.',
    }),
  },
  async handler({ module }) {
    const result = await generateMarkdownForModule(module)
    console.log(`Wrote ${relative(process.cwd(), result.outputFile)}`)
  },
})

const currentFile = fileURLToPath(import.meta.url)
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : undefined

if (invokedFile === currentFile) {
  await run(binary(app), process.argv)
}
